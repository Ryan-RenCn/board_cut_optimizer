import { calculateLogisticsFee } from './logistics.mjs';
import { fillRectangleSheet } from './beam-nesting.mjs';
import { fillPolygonSheet, polygonFitsPanel } from './polygon-nesting.mjs';
import { normalizeShape, shapeArea, shapeBounds, rotationCandidates } from './polygon-geometry.mjs';

const EPSILON = 0.0001;
const FULL_SHEET_LENGTH = 2440;
const FULL_SHEET_WIDTH = 1220;

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeMaterial = (value) => String(value ?? '').trim().toLocaleLowerCase();
const normalizeThickness = (value) => Math.max(0, safeNumber(value));
const normalizeLossRate = (value) => Math.min(100, Math.max(0, safeNumber(value)));

const matchesInventory = (part, panel) =>
  normalizeMaterial(part.material) === normalizeMaterial(panel.material) &&
  Math.abs(normalizeThickness(part.thickness) - normalizeThickness(panel.thickness)) < EPSILON;

const matchesDimensions = (first, second) =>
  (Math.abs(first.length - second.length) < EPSILON && Math.abs(first.width - second.width) < EPSILON) ||
  (Math.abs(first.length - second.width) < EPSILON && Math.abs(first.width - second.length) < EPSILON);

const isStandardFullSheetPart = (part) => !part.shape && part.rotationAngles === undefined
  && matchesDimensions(part, { length: FULL_SHEET_LENGTH, width: FULL_SHEET_WIDTH });

const contains = (outer, inner) =>
  inner.x >= outer.x - EPSILON &&
  inner.y >= outer.y - EPSILON &&
  inner.x + inner.w <= outer.x + outer.w + EPSILON &&
  inner.y + inner.h <= outer.y + outer.h + EPSILON;

const intersects = (a, b) =>
  a.x < b.x + b.w - EPSILON &&
  a.x + a.w > b.x + EPSILON &&
  a.y < b.y + b.h - EPSILON &&
  a.y + a.h > b.y + EPSILON;

function pruneFreeRects(rects) {
  const valid = rects.filter((rect) => rect.w > EPSILON && rect.h > EPSILON);
  return valid.filter((rect, index) =>
    !valid.some((other, otherIndex) => otherIndex !== index && contains(other, rect)
      && (!contains(rect, other) || otherIndex < index))
  );
}

function splitFreeRects(freeRects, used) {
  const next = [];

  for (const free of freeRects) {
    if (!intersects(free, used)) {
      next.push(free);
      continue;
    }

    if (used.x > free.x + EPSILON) {
      next.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h });
    }
    if (used.x + used.w < free.x + free.w - EPSILON) {
      next.push({
        x: used.x + used.w,
        y: free.y,
        w: free.x + free.w - (used.x + used.w),
        h: free.h,
      });
    }
    if (used.y > free.y + EPSILON) {
      next.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y });
    }
    if (used.y + used.h < free.y + free.h - EPSILON) {
      next.push({
        x: free.x,
        y: used.y + used.h,
        w: free.w,
        h: free.y + free.h - (used.y + used.h),
      });
    }
  }

  return pruneFreeRects(next);
}

function orientationCandidates(part, allowRotation) {
  const candidates = [{ w: part.length, h: part.width, rotated: false }];
  if (allowRotation && part.allowRotate !== false && Math.abs(part.length - part.width) > EPSILON) {
    candidates.push({ w: part.width, h: part.length, rotated: true });
  }
  return candidates;
}

function findPosition(freeRects, part, settings, placements = []) {
  let best = null;
  const kerf = Math.max(0, settings.sawWidth);

  for (const free of freeRects) {
    for (const orientation of orientationCandidates(part, settings.allowRotation)) {
      if (orientation.w > free.w + EPSILON || orientation.h > free.h + EPSILON) continue;

      // A free rectangle can end at another part, not just at the sheet edge.
      // Check actual part spacing before clipping the outer kerf reservation.
      const separated = placements.every((placed) =>
        free.x + orientation.w + kerf <= placed.x + EPSILON
        || placed.x + placed.placedLength + kerf <= free.x + EPSILON
        || free.y + orientation.h + kerf <= placed.y + EPSILON
        || placed.y + placed.placedWidth + kerf <= free.y + EPSILON
      );
      if (!separated) continue;

      const reserveW = Math.min(free.w, orientation.w + kerf);
      const reserveH = Math.min(free.h, orientation.h + kerf);
      const shortFit = Math.min(free.w - orientation.w, free.h - orientation.h);
      const longFit = Math.max(free.w - orientation.w, free.h - orientation.h);
      const areaFit = free.w * free.h - orientation.w * orientation.h;
      const orientationBias = settings.orientationStrategy === 'preserve'
        ? (orientation.rotated ? 1 : 0)
        : settings.orientationStrategy === 'rotate'
          ? (orientation.rotated ? 0 : 1)
          : 0;
      const score = [orientationBias, shortFit, longFit, areaFit, free.y, free.x];

      if (!best || score.some((value, index) => value < best.score[index] - EPSILON && score.slice(0, index).every((v, i) => Math.abs(v - best.score[i]) < EPSILON))) {
        best = {
          x: free.x,
          y: free.y,
          w: orientation.w,
          h: orientation.h,
          reserveW,
          reserveH,
          rotated: orientation.rotated,
          score,
        };
      }
    }
  }

  return best;
}

function buildLayout(panel, index, settings) {
  const marginX = Math.max(0, settings.panelMarginX);
  const marginY = Math.max(0, settings.panelMarginY);
  const usableWidth = Math.max(0, panel.length - marginX * 2);
  const usableHeight = Math.max(0, panel.width - marginY * 2);

  return {
    id: `layout-${index + 1}`,
    panel,
    width: panel.length,
    height: panel.width,
    usableWidth,
    usableHeight,
    placements: [],
    freeRects: usableWidth > 0 && usableHeight > 0
      ? [{ x: marginX, y: marginY, w: usableWidth, h: usableHeight }]
      : [],
    usedArea: 0,
  };
}

function buildFullSheetLayout(panel, part, index) {
  const rotated = Math.abs(part.length - panel.length) >= EPSILON || Math.abs(part.width - panel.width) >= EPSILON;
  return {
    id: `layout-${index + 1}`,
    panel,
    width: panel.length,
    height: panel.width,
    usableWidth: panel.length,
    usableHeight: panel.width,
    placements: [{ ...part, x: 0, y: 0, placedLength: panel.length, placedWidth: panel.width, rotated }],
    freeRects: [],
    usedArea: panel.length * panel.width,
    isFullSheet: true,
  };
}

function placePart(layout, part, settings) {
  const position = findPosition(layout.freeRects, part, settings, layout.placements);
  if (!position) return false;

  const placement = {
    ...part,
    x: position.x,
    y: position.y,
    placedLength: position.w,
    placedWidth: position.h,
    rotated: position.rotated,
  };

  layout.placements.push(placement);
  layout.usedArea += part.length * part.width;
  layout.freeRects = splitFreeRects(layout.freeRects, {
    x: position.x,
    y: position.y,
    w: position.reserveW,
    h: position.reserveH,
  });
  return true;
}

const partSorters = {
  // A thin frame has little solid area but must be placed before a large part
  // that fits its hole. Use its outer envelope only for ordering, never billing.
  area: (a, b) => (b.shape?.holes?.length ? b.length*b.width : b.area ?? b.length*b.width)
    - (a.shape?.holes?.length ? a.length*a.width : a.area ?? a.length*a.width) || Math.max(b.length, b.width) - Math.max(a.length, a.width),
  longSide: (a, b) => Math.max(b.length, b.width) - Math.max(a.length, a.width) || b.length * b.width - a.length * a.width,
  perimeter: (a, b) => b.length + b.width - (a.length + a.width) || b.length * b.width - a.length * a.width,
  width: (a, b) => b.width - a.width || b.length - a.length,
};

function expandParts(parts, maxVertices = 256) {
  return parts.flatMap((part, sourceIndex) => {
    const quantity = Number(part.quantity);
    const shape = part.shape ? normalizeShape(part.shape, { maxVertices }) : null;
    const bounds = shape ? shapeBounds(shape) : null;
    const length = bounds ? bounds.width : Math.max(0, safeNumber(part.length));
    const width = bounds ? bounds.height : Math.max(0, safeNumber(part.width));
    if (!quantity || !length || !width) return [];
    return Array.from({ length: quantity }, (_, instanceIndex) => ({
      ...part,
      ...(shape ? { shape } : {}),
      sourceIndex,
      instanceIndex,
      instanceId: `${part.id ?? sourceIndex}-${instanceIndex + 1}`,
      length,
      width,
      area: shape ? shapeArea(shape) : length * width,
      thickness: normalizeThickness(part.thickness),
      material: String(part.material ?? '').trim(),
      allowRotate: part.allowRotate !== false,
    }));
  });
}

function expandPanels(panels) {
  return panels.flatMap((panel, sourceIndex) => {
    const { cuttingFee: _legacyCuttingFee, price: legacyPrice, ...panelWithoutLegacyFields } = panel;
    const length = Math.max(0, safeNumber(panel.length));
    const width = Math.max(0, safeNumber(panel.width));
    if (!length || !width) return [];
    return [{
      ...panelWithoutLegacyFields,
      sourceIndex,
      instanceId: `${panel.id ?? sourceIndex}-template`,
      length,
      width,
      thickness: normalizeThickness(panel.thickness),
      cost: Math.max(0, safeNumber(panel.cost ?? legacyPrice)),
      weight: Math.max(0, safeNumber(panel.weight)),
      material: String(panel.material ?? '').trim(),
    }];
  });
}

function runAttempt(panels, parts, settings, sortKey) {
  const pending = [...parts].sort((a, b) => Number(isStandardFullSheetPart(b)) - Number(isStandardFullSheetPart(a)) || partSorters[sortKey](a, b));
  const availablePanels = [...panels].sort((a, b) => a.length * a.width - b.length * b.width);
  const layouts = [];
  const unplaced = [];
  let layoutIndex = 0;
  const reportProgress=(current=[])=>settings.onProgress?.({stage:'placing',layouts:[...layouts,...current].map(layout=>({...layout,placements:layout.placements.slice(),freeRects:[]})),totalCount:parts.length,sortKey,strategy:settings.searchStrategy??'maxrects'});

  while (pending.length) {
    if(settings.searchDeadline && Date.now()>=settings.searchDeadline){unplaced.push(...pending.splice(0).map(part=>({...part,reason:'本轮细化搜索时间已达到上限'})));break;}
    const firstPart = pending[0];
    const inventoryMatches = availablePanels
      .map((panel, index) => ({ panel, index }))
      .filter(({ panel }) => matchesInventory(firstPart, panel));

    const fullSheetChoice = isStandardFullSheetPart(firstPart)
      ? inventoryMatches.find(({ panel }) => orientationCandidates(firstPart, settings.allowRotation).some((size) =>
        Math.abs(size.w - panel.length) < EPSILON && Math.abs(size.h - panel.width) < EPSILON))
      : null;
    if (fullSheetChoice) {
      layouts.push(buildFullSheetLayout(fullSheetChoice.panel, pending.shift(), layoutIndex));
      reportProgress();
      layoutIndex += 1;
      continue;
    }

    const matchingPanelIndexes = inventoryMatches.filter(({ panel }) => settings.searchStrategy === 'polygon'
      ? polygonFitsPanel(firstPart, panel, settings)
      : orientationCandidates(firstPart, settings.allowRotation).some((size) =>
        size.w <= panel.length - settings.panelMarginX * 2 + EPSILON &&
        size.h <= panel.width - settings.panelMarginY * 2 + EPSILON
      ));

    if (!matchingPanelIndexes.length) {
      const reason = inventoryMatches.length
        ? (settings.searchStrategy === 'polygon' ? '在当前旋转角度下无法放入板材' : '零件尺寸超出板材尺寸')
        : '没有匹配材质或厚度的板材';
      unplaced.push({ ...pending.shift(), reason });
      continue;
    }

    let bestPanelChoice = null;
    for (const choice of matchingPanelIndexes) {
      const trial = buildLayout(choice.panel, layoutIndex, settings);
      const onPlacement=placements=>reportProgress([{...trial,placements}]);
      let placedArea = 0;
      let placedCount = 0;
      if (settings.searchStrategy === 'beam' || settings.searchStrategy === 'polygon') {
        const filler = settings.searchStrategy === 'polygon' ? fillPolygonSheet : fillRectangleSheet;
        const filled = filler(choice.panel, pending.filter((part) => matchesInventory(part, choice.panel)), {...settings,onPlacement});
        Object.assign(trial, filled);
        onPlacement(trial.placements);
        placedArea = trial.usedArea;
        placedCount = trial.placements.length;
      } else {
        for (const part of pending) {
          if (!matchesInventory(part, choice.panel)) continue;
          if (placePart(trial, part, settings)) {
            onPlacement(trial.placements);
            placedArea += part.length * part.width;
            placedCount += 1;
          }
        }
      }
      const panelArea = choice.panel.length * choice.panel.width;
      const score = [placedCount === 0 ? 1 : 0, -placedArea / panelArea, panelArea];
      if (!bestPanelChoice || score.some((value, index) => value < bestPanelChoice.score[index] - EPSILON && score.slice(0, index).every((v, i) => Math.abs(v - bestPanelChoice.score[i]) < EPSILON))) {
        bestPanelChoice = { ...choice, trial, score };
      }
    }

    if (!bestPanelChoice || !bestPanelChoice.trial.placements.length) {
      unplaced.push({ ...pending.shift(), reason: '排版空间不足' });
      continue;
    }

    const placedIds = new Set(bestPanelChoice.trial.placements.map((part) => part.instanceId));
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (placedIds.has(pending[index].instanceId)) pending.splice(index, 1);
    }
    bestPanelChoice.trial.id = `layout-${layoutIndex + 1}`;
    layouts.push(bestPanelChoice.trial);
    reportProgress();
    layoutIndex += 1;
  }

  for (const layout of layouts) {
    const panelArea = layout.width * layout.height;
    // Keep original length × width accounting, even for concave or holed parts.
    // Actual polygon area belongs only to the placement search above.
    layout.packingArea = layout.usedArea;
    layout.measurementArea = layout.placements.reduce((sum, part) => sum + part.length * part.width, 0);
    // Interlocking polygon bounding boxes may overlap; never account more
    // material or weight than one physical sheet.
    layout.usedArea = Math.min(panelArea, layout.measurementArea);
    layout.usage = panelArea ? layout.usedArea / panelArea : 0;
    layout.billingUsage = layout.isFullSheet ? 1 : Math.min(1, layout.usage + settings.lossRate / 100);
    layout.lossArea = panelArea * Math.max(0, layout.billingUsage - layout.usage);
    layout.billingRate = layout.billingUsage >= 0.8 - EPSILON
      ? 1
      : Math.ceil(layout.billingUsage * 10 - EPSILON) / 10;
    layout.actualWeight = layout.panel.weight * layout.usage;
    layout.panelCost = layout.panel.cost * layout.billingRate;
    layout.panelCharge = layout.panelCost * settings.profitRate / 100;
    layout.cuttingFee = layout.isFullSheet ? 0 : settings.cuttingFee * layout.billingRate;
  }

  const placedCount = layouts.reduce((sum, layout) => sum + layout.placements.length, 0);
  const usedPanelArea = layouts.reduce((sum, layout) => sum + layout.width * layout.height, 0);
  const partsArea = layouts.reduce((sum, layout) => sum + layout.usedArea, 0);
  const packingArea = layouts.reduce((sum, layout) => sum + layout.packingArea, 0);
  const totalLossArea = layouts.reduce((sum, layout) => sum + layout.lossArea, 0);
  const totalPanelCost = layouts.reduce((sum, layout) => sum + layout.panelCost, 0);
  const totalPanelCharge = layouts.reduce((sum, layout) => sum + layout.panelCharge, 0);
  const totalWeight = layouts.reduce((sum, layout) => sum + layout.actualWeight, 0);
  const totalCuttingFee = layouts.reduce((sum, layout) => sum + layout.cuttingFee, 0);
  const packagingFee = settings.packagingFee;
  const logistics = calculateLogisticsFee({ provider: settings.logisticsProvider, destination: settings.shippingDestination, weight: totalWeight });
  const totalLogisticsFee = logistics.fee;
  const finalQuote = totalPanelCharge + totalCuttingFee + packagingFee + totalLogisticsFee;
  return {
    layouts,
    unplaced,
    strategy: settings.searchStrategy === 'polygon' ? 'polygon-nfp' : settings.searchStrategy === 'beam' ? 'rectangle-beam' : 'maxrects',
    sortKey,
    orientationStrategy: settings.orientationStrategy ?? 'bestFit',
    score: [unplaced.length, usedPanelArea - packingArea, layouts.length],
    stats: {
      placedCount,
      requestedCount: parts.length,
      usedPanels: layouts.length,
      partsArea,
      usedPanelArea,
      totalLossArea,
      totalWeight,
      totalPanelCost,
      totalPanelCharge,
      profitRate: settings.profitRate,
      lossRate: settings.lossRate,
      cuttingFeePerPanel: settings.cuttingFee,
      totalCuttingFee,
      packagingFee,
      totalLogisticsFee,
      logistics,
      finalQuote,
      averageUsage: usedPanelArea ? partsArea / usedPanelArea : 0,
      averageBillingUsage: usedPanelArea ? (partsArea + totalLossArea) / usedPanelArea : 0,
    },
  };
}

function compareScores(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (Math.abs(a[index] - b[index]) > EPSILON) return a[index] - b[index];
  }
  return 0;
}

export function optimizeCuttingPlan(project, { includeBeam = true, onProgress } = {}) {
  const [validationError] = validateProject(project);
  if (validationError) throw new Error(validationError);

  const settings = {
    onProgress,
    sawWidth: Math.max(0, safeNumber(project.settings?.sawWidth, 3)),
    panelMarginX: Math.max(0, safeNumber(project.settings?.panelMarginX, 10)),
    panelMarginY: Math.max(0, safeNumber(project.settings?.panelMarginY, 10)),
    profitRate: Math.max(0, safeNumber(project.settings?.profitRate, 100)),
    lossRate: normalizeLossRate(project.lossRate),
    cuttingFee: Math.max(0, safeNumber(project.settings?.cuttingFee)),
    packagingFee: Math.max(0, safeNumber(project.settings?.packagingFee)),
    logisticsProvider: String(project.settings?.logisticsProvider ?? 'none'),
    shippingDestination: String(project.shippingDestination ?? '').trim(),
    allowRotation: project.settings?.allowRotation !== false,
    rotationStep: safeNumber(project.settings?.rotationStep, 15),
    maxShapeVertices: Number(project.settings?.maxShapeVertices ?? 256),
  };
  const parts = expandParts(project.parts ?? [], settings.maxShapeVertices);
  const panels = expandPanels(project.panels ?? []);

  if (!parts.length) throw new Error('请至少录入一个尺寸完整的零件。');
  if (!panels.length) throw new Error('请至少录入一张尺寸完整的板材。');

  const sortKeys = project.settings?.optimizationLevel === 'quick'
    ? ['area']
    : ['area', 'longSide', 'perimeter', 'width'];
  const orientationStrategies = settings.allowRotation
    ? ['bestFit', 'preserve', 'rotate']
    : ['bestFit'];

  const polygonMode = parts.some((part) => part.shape || part.rotationAngles !== undefined);
  const attempts = polygonMode ? [] : sortKeys.flatMap((sortKey) => orientationStrategies.map((orientationStrategy) =>
    runAttempt(panels, parts, { ...settings, orientationStrategy }, sortKey)
  ));
  const quick = project.settings?.optimizationLevel === 'quick';
  if (polygonMode) {
    const denseAutomatic = settings.allowRotation && parts.some(part=>part.shape && part.allowRotate && part.rotationAngles===undefined
      && part.shape.outer.length+(part.shape.holes??[]).reduce((sum,ring)=>sum+ring.length,0)>128);
    let sufficientBaseline=false;
    if(denseAutomatic) {
      const baseline=runAttempt(panels,parts,{...settings,searchStrategy:'polygon',polygonPlacementStrategy:'bottomLeft',polygonAngleStrategy:'orthogonal'},'area');
      attempts.push(baseline);
      // With one stock specification and one filled sheet per material/thickness
      // group, angle refinement cannot reduce the sheet count or billing area.
      sufficientBaseline=baseline.unplaced.length===0 && parts.every(part=>panels.filter(panel=>matchesInventory(part,panel)).length===1
        && baseline.layouts.filter(layout=>matchesInventory(part,layout.panel)).length===1);
    }
    const searchDeadline=denseAutomatic?Date.now()+(quick?2500:8000):undefined;
    for (const sortKey of quick ? ['area'] : ['area', 'longSide']) {
      if(sufficientBaseline)break;
      for (const polygonPlacementStrategy of quick ? ['bottomLeft'] : ['bottomLeft', 'compact']) {
        if(searchDeadline && Date.now()>=searchDeadline) break;
        attempts.push(runAttempt(panels, parts, { ...settings, searchDeadline, searchStrategy: 'polygon', polygonPlacementStrategy }, sortKey));
      }
    }
  }
  for (const sortKey of !polygonMode && includeBeam ? (quick ? ['area'] : ['area', 'longSide']) : []) {
    attempts.push(runAttempt(panels, parts, {
      ...settings,
      searchStrategy: 'beam',
      beamWidth: quick ? 2 : 4,
      candidateLimit: quick ? 4 : 6,
      maxSearchParts: quick ? 24 : 40,
      maxExpandedStates: quick ? 1200 : 5000,
    }, sortKey));
  }
  const best = attempts.reduce((winner, attempt) => compareScores(attempt.score, winner.score) < 0 ? attempt : winner);
  best.algorithm = {
    label: polygonMode ? '异形排版：真实轮廓 + 多角度搜索' : includeBeam ? '组合优化：矩形束搜索 + 多策略贴合' : '多策略贴合',
    provenance: polygonMode ? 'independent-polygon-adaptation' : 'independent-rectangle-adaptation',
    attempts: attempts.length,
    selectedStrategy: best.strategy,
    selectedSort: best.sortKey,
    selectedOrientation: best.orientationStrategy,
  };
  best.attemptsSummary = attempts.map((attempt) => ({
    strategy: attempt.strategy,
    sortKey: attempt.sortKey,
    orientationStrategy: attempt.orientationStrategy,
    score: [...attempt.score],
    usedPanels: attempt.layouts.length,
    placedCount: attempt.stats.placedCount,
    selected: attempt === best,
  }));
  best.trace = best.layouts.flatMap((layout, layoutIndex) => layout.placements.map((part, placementIndex) => ({
    layoutIndex,
    placementIndex,
    partId: part.instanceId,
    x: part.x,
    y: part.y,
    width: part.placedLength,
    height: part.placedWidth,
    rotated: part.rotated,
    angle: part.angle ?? (part.rotated ? 90 : 0),
    strategy: layout.isFullSheet ? 'full-sheet' : best.strategy,
  })));
  return best;
}

export function repriceCuttingPlan(plan, project) {
  if (!plan?.layouts || !plan?.stats) return plan;
  const lossRate = normalizeLossRate(project?.lossRate);
  const profitRate = Math.max(0, safeNumber(project?.settings?.profitRate, 100));
  const cuttingFeePerPanel = Math.max(0, safeNumber(project?.settings?.cuttingFee));
  const packagingFee = Math.max(0, safeNumber(project?.settings?.packagingFee));

  for (const layout of plan.layouts) {
    const panelArea = layout.width * layout.height;
    layout.billingUsage = layout.isFullSheet ? 1 : Math.min(1, layout.usage + lossRate / 100);
    layout.lossArea = panelArea * Math.max(0, layout.billingUsage - layout.usage);
    layout.billingRate = layout.billingUsage >= 0.8 - EPSILON
      ? 1
      : Math.ceil(layout.billingUsage * 10 - EPSILON) / 10;
    layout.panelCost = layout.panel.cost * layout.billingRate;
    layout.panelCharge = layout.panelCost * profitRate / 100;
    layout.cuttingFee = layout.isFullSheet ? 0 : cuttingFeePerPanel * layout.billingRate;
  }

  const totalLossArea = plan.layouts.reduce((sum, layout) => sum + layout.lossArea, 0);
  const totalPanelCost = plan.layouts.reduce((sum, layout) => sum + layout.panelCost, 0);
  const totalPanelCharge = plan.layouts.reduce((sum, layout) => sum + layout.panelCharge, 0);
  const totalCuttingFee = plan.layouts.reduce((sum, layout) => sum + layout.cuttingFee, 0);
  const logistics = calculateLogisticsFee({
    provider: project?.settings?.logisticsProvider,
    destination: project?.shippingDestination,
    weight: plan.stats.totalWeight,
  });
  Object.assign(plan.stats, {
    totalLossArea,
    totalPanelCost,
    totalPanelCharge,
    profitRate,
    lossRate,
    cuttingFeePerPanel,
    totalCuttingFee,
    packagingFee,
    totalLogisticsFee: logistics.fee,
    logistics,
    finalQuote: totalPanelCharge + totalCuttingFee + packagingFee + logistics.fee,
    averageBillingUsage: plan.stats.usedPanelArea
      ? (plan.stats.partsArea + totalLossArea) / plan.stats.usedPanelArea
      : 0,
  });
  return plan;
}

export function validateProject(project) {
  const errors = [];
  const maxVertices = Number(project.settings?.maxShapeVertices ?? 256);
  if (!Number.isSafeInteger(maxVertices) || maxVertices < 3) errors.push('轮廓顶点上限必须是至少为 3 的整数');
  (project.panels ?? []).forEach((panel, index) => {
    if (safeNumber(panel.length) <= 0 || safeNumber(panel.width) <= 0) errors.push(`第 ${index + 1} 种板材缺少有效尺寸`);
    if (safeNumber(panel.thickness) <= 0) errors.push(`第 ${index + 1} 种板材缺少有效厚度`);
    if (safeNumber(panel.cost ?? panel.price) < 0) errors.push(`第 ${index + 1} 种板材的成本价不能为负数`);
    if (safeNumber(panel.weight) < 0) errors.push(`第 ${index + 1} 种板材的重量不能为负数`);
  });
  if (safeNumber(project.settings?.cuttingFee) < 0) errors.push('全局切割费不能为负数');
  if (safeNumber(project.settings?.packagingFee) < 0) errors.push('全局打包费不能为负数');
  if (project.settings?.profitRate !== undefined && safeNumber(project.settings.profitRate) < 0) errors.push('全局利润比例不能为负数');
  if (project.settings?.rotationStep !== undefined && (!Number.isFinite(Number(project.settings.rotationStep))
    || Number(project.settings.rotationStep) < 1 || Number(project.settings.rotationStep) > 180)) errors.push('异形旋转步长必须在 1° 到 180° 之间');
  if (safeNumber(project.lossRate) < 0 || safeNumber(project.lossRate) > 100) errors.push('本单损耗率必须在 0% 到 100% 之间');
  (project.parts ?? []).forEach((part, index) => {
    if (!['number', 'string'].includes(typeof part.quantity) || !String(part.quantity).trim()
      || !Number.isSafeInteger(Number(part.quantity)) || Number(part.quantity) < 0) {
      errors.push(`第 ${index + 1} 种零件的数量必须为有效的非负整数`);
    }
    if (part.shape) {
      try { normalizeShape(part.shape, { maxVertices }); } catch (error) { errors.push(`第 ${index + 1} 种零件轮廓无效：${error.message}`); }
    } else if (safeNumber(part.length) <= 0 || safeNumber(part.width) <= 0) errors.push(`第 ${index + 1} 种零件缺少有效尺寸`);
    if (part.rotationAngles !== undefined) {
      try { rotationCandidates(part, project.settings ?? {}); } catch (error) { errors.push(`第 ${index + 1} 种零件旋转角度无效：${error.message}`); }
    }
    if (safeNumber(part.thickness) <= 0) errors.push(`第 ${index + 1} 种零件缺少有效厚度`);
  });
  return errors;
}

export function summarizeBySource(result) {
  const summary = new Map();
  for (const layout of result.layouts) {
    for (const part of layout.placements) {
      const key = part.id ?? part.sourceIndex;
      const row = summary.get(key) ?? { part, placed: 0, unplaced: 0 };
      row.placed += 1;
      summary.set(key, row);
    }
  }
  for (const part of result.unplaced) {
    const key = part.id ?? part.sourceIndex;
    const row = summary.get(key) ?? { part, placed: 0, unplaced: 0 };
    row.unplaced += 1;
    summary.set(key, row);
  }
  return [...summary.values()];
}

function layoutDisplayKey(layout) {
  const placements = layout.isFullSheet ? [] : layout.placements.map((part) => ({
    code: part.code || `P${part.sourceIndex + 1}`,
    description: part.description || '',
    material: part.material || '',
    thickness: part.thickness,
    length: part.length,
    width: part.width,
    x: part.x,
    y: part.y,
    placedLength: part.placedLength,
    placedWidth: part.placedWidth,
    rotated: part.rotated,
    angle: part.angle ?? (part.rotated ? 90 : 0),
    placedShape: part.placedShape ?? null,
  })).sort((a, b) => a.y - b.y || a.x - b.x || a.code.localeCompare(b.code));
  return JSON.stringify({
    panel: {
      material: layout.panel.material || '',
      description: layout.panel.description || '',
      thickness: layout.panel.thickness,
      length: layout.width,
      width: layout.height,
      cost: layout.panel.cost,
      weight: layout.panel.weight,
    },
    isFullSheet: Boolean(layout.isFullSheet),
    usableWidth: layout.usableWidth,
    usableHeight: layout.usableHeight,
    placements,
  });
}

export function groupIdenticalLayouts(layouts = []) {
  const groups = new Map();
  for (const layout of layouts) {
    const key = layoutDisplayKey(layout);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { layout, count: 1 });
  }
  return [...groups.values()];
}
