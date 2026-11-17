import assert from 'node:assert/strict';
import { groupIdenticalLayouts, optimizeCuttingPlan, repriceCuttingPlan, summarizeBySource, validateProject } from '../engine.mjs';
import { LOGISTICS_PROVIDER } from '../logistics.mjs';

const settings = { sawWidth: 3, panelMarginX: 0, panelMarginY: 0, profitRate: 100, cuttingFee: 35, allowRotation: true, optimizationLevel: 'full' };

{
  const result = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 1000, width: 500, thickness: 18, material: 'MDF' }], parts: [{ id: 'part', quantity: 2, length: 400, width: 250, thickness: 18, material: 'MDF', allowRotate: true }] });
  assert.equal(result.unplaced.length, 0, '两个零件都应排入');
  assert.equal(result.stats.placedCount, 2);
  assert.equal(result.layouts.length, 1);
  assert.equal(summarizeBySource(result)[0].placed, 2);
  assert.equal('offcuts' in result.layouts[0], false, '排版结果不应包含余料数据');
  assert.equal('offcutCount' in result.stats, false, '统计结果不应包含余料数据');
}

{
  const result = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 300, width: 500, thickness: 18, material: '' }], parts: [{ id: 'part', quantity: 1, length: 450, width: 250, thickness: 18, material: '', allowRotate: true }] });
  assert.equal(result.unplaced.length, 0, '允许旋转时应排入');
  assert.equal(result.layouts[0].placements[0].rotated, true);
}

{
  const result = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 1000, width: 500, thickness: 18, material: 'MDF' }], parts: [{ id: 'part', quantity: 1, length: 100, width: 100, thickness: 18, material: '木板', allowRotate: true }] });
  assert.equal(result.unplaced.length, 1, '材质不同不能混排');
  assert.equal(result.layouts.length, 0);
}

{
  const result = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 1000, width: 500, thickness: 18, material: 'MDF' }], parts: [{ id: 'part', quantity: 1, length: 1100, width: 600, thickness: 18, material: 'MDF', allowRotate: true }] });
  assert.equal(result.unplaced.length, 1);
  assert.equal(result.unplaced[0].reason, '零件尺寸超出板材尺寸');
}

{
  const result = optimizeCuttingPlan({
    settings: { ...settings, panelMarginX: 10, panelMarginY: 10 },
    panels: [{ id: 'panel', length: 2440, width: 1220, thickness: 18, cost: 300, weight: 40, material: 'MDF' }],
    parts: [{ id: 'full-sheet', quantity: 1, length: 1220, width: 2440, thickness: 18, material: 'MDF', allowRotate: true }],
  });
  assert.equal(result.unplaced.length, 0, '1220 × 2440 零件应识别为整板件');
  assert.equal(result.layouts.length, 1);
  assert.equal(result.layouts[0].isFullSheet, true);
  assert.equal(result.layouts[0].billingRate, 1);
  assert.equal(result.layouts[0].billingUsage, 1);
  assert.equal(result.layouts[0].lossArea, 0, '整板件不应重复计入损耗面积');
  assert.equal(result.layouts[0].actualWeight, 40, '整板件应保留整张板材重量');
  assert.equal(result.layouts[0].panelCharge, 300);
  assert.equal(result.layouts[0].cuttingFee, 0);
  assert.equal(result.stats.totalCuttingFee, 0, '整板件不应计算切割费');
  assert.equal(result.stats.finalQuote, 300);
}

{
  const project = {
    lossRate: 7,
    settings,
    panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, cost: 100, material: '' }],
    parts: [{ id: 'part', quantity: 1, length: 640, width: 1000, thickness: 18, material: '', allowRotate: false }],
  };
  const result = optimizeCuttingPlan(project);
  assert.equal(result.layouts[0].usage, 0.64);
  assert.ok(Math.abs(result.layouts[0].billingUsage - 0.71) < 0.0001, '计价利用率应为实际利用率加本单损耗率');
  assert.equal(result.layouts[0].billingRate, 0.8, '71% 计价利用率应向上取整到 80% 计费');
  assert.equal(result.layouts[0].panelCharge, 80);
  assert.equal(result.layouts[0].cuttingFee, 28);

  project.lossRate = 1;
  repriceCuttingPlan(result, project);
  assert.ok(Math.abs(result.layouts[0].billingUsage - 0.65) < 0.0001);
  assert.equal(result.layouts[0].billingRate, 0.7, '实时改为 1% 损耗后应按 70% 重新计费');
  assert.equal(result.layouts[0].panelCharge, 70);
  assert.equal(result.layouts[0].cuttingFee, 24.5);
  assert.equal(result.stats.finalQuote, 94.5);
}

{
  const result = optimizeCuttingPlan({
    settings,
    panels: [{ id: 'panel', length: 2440, width: 1220, thickness: 18, cost: 300, material: 'MDF' }],
    parts: [
      { id: 'full-sheet', quantity: 1, length: 2440, width: 1220, thickness: 18, material: 'MDF', allowRotate: false },
      { id: 'cut-part', quantity: 1, length: 500, width: 500, thickness: 18, material: 'MDF', allowRotate: true },
    ],
  });
  assert.equal(result.layouts.length, 2, '整板件应与需要切割的零件分开占用板材');
  assert.equal(result.layouts.filter((layout) => layout.isFullSheet).length, 1);
  assert.equal(result.layouts.find((layout) => !layout.isFullSheet).billingRate, 0.1);
  assert.equal(result.stats.totalCuttingFee, 3.5, '混合排版只对非整板件按计费使用率收取切割费');
}

{
  const result = optimizeCuttingPlan({
    settings,
    panels: [{ id: 'panel', length: 2440, width: 1220, thickness: 18, cost: 300, material: 'MDF' }],
    parts: [{ id: 'full-sheet', code: 'FULL', quantity: 3, length: 2440, width: 1220, thickness: 18, material: 'MDF', allowRotate: false }],
  });
  const displayGroups = groupIdenticalLayouts(result.layouts);
  assert.equal(result.layouts.length, 3, '计费数据应保留三张实际板材');
  assert.equal(displayGroups.length, 1, '相同整板排版图应合并显示');
  assert.equal(displayGroups[0].count, 3, '合并后的排版图应记录实际数量');
}

{
  const result = optimizeCuttingPlan({
    settings,
    panels: [{ id: 'panel', length: 2440, width: 1220, thickness: 18, cost: 300, material: 'MDF' }],
    parts: [
      { id: 'full-a', code: 'A', quantity: 1, length: 2440, width: 1220, thickness: 18, material: 'MDF', allowRotate: false },
      { id: 'full-b', code: 'B', quantity: 1, length: 2440, width: 1220, thickness: 18, material: 'MDF', allowRotate: false },
    ],
  });
  const displayGroups = groupIdenticalLayouts(result.layouts);
  assert.equal(result.layouts.length, 2);
  assert.equal(displayGroups.length, 1, '不同零件编号的同规格整板件也应合并为一种排版');
  assert.equal(displayGroups[0].count, 2);
}

{
  const result = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 500, width: 500, thickness: 18, cost: 125.5, weight: 12.5, cuttingFee: 999, material: '' }], parts: [{ id: 'part', quantity: 2, length: 500, width: 500, thickness: 18, material: '', allowRotate: false }] });
  assert.equal(result.stats.placedCount, 2, '无限库存应允许重复使用同一种板材规格');
  assert.equal(result.layouts.length, 2);
  assert.equal(result.unplaced.length, 0);
  assert.equal(result.stats.totalPanelCost, 251, '板材总成本应按实际使用张数累计');
  assert.equal(result.stats.totalPanelCharge, 251, '100% 利润比例下板材报价应等于板材成本');
  assert.equal(result.stats.totalWeight, 25, '总重量应按实际使用板材的单张重量累计');
  assert.equal(result.stats.totalCuttingFee, 70, '切割费应使用全局费率并按实际使用张数累计');
  assert.equal(result.stats.finalQuote, 321, '最终报价应为板材报价与切割费之和');
  assert.equal(result.layouts[0].panel.cost, 125.5, '排版结果应保留单张成本价');
  assert.equal(result.layouts[0].panel.weight, 12.5, '排版结果应保留单张重量');
  assert.equal(result.stats.cuttingFeePerPanel, 35, '排版结果应保留全局单张切割费');
  assert.equal('cuttingFee' in result.layouts[0].panel, false, '板材规格不应单独保存切割费');
}

{
  const result = optimizeCuttingPlan({
    settings: { ...settings, profitRate: 130 },
    panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, cost: 100, material: '' }],
    parts: [{ id: 'part', quantity: 1, length: 1000, width: 1000, thickness: 18, material: '', allowRotate: false }],
  });
  assert.equal(result.layouts[0].panelCost, 100);
  assert.equal(result.layouts[0].panelCharge, 130, '130% 利润比例应将 100 元板材成本计算为 130 元板材报价');
  assert.equal(result.stats.totalPanelCost, 100);
  assert.equal(result.stats.totalPanelCharge, 130);
  assert.equal(result.stats.profitRate, 130);
  assert.equal(result.stats.finalQuote, 165, '利润只应用于板材成本，切割费应另行相加');
}

{
  assert.throws(
    () => optimizeCuttingPlan({ settings: { ...settings, cuttingFee: -1 }, panels: [{ id: 'panel', length: 500, width: 500, thickness: 18, material: '' }], parts: [{ id: 'part', quantity: 1, length: 100, width: 100, thickness: 18, material: '' }] }),
    /全局切割费不能为负数/,
  );
  assert.throws(
    () => optimizeCuttingPlan({ settings: { ...settings, packagingFee: -1 }, panels: [{ id: 'panel', length: 500, width: 500, thickness: 18, material: '' }], parts: [{ id: 'part', quantity: 1, length: 100, width: 100, thickness: 18, material: '' }] }),
    /全局打包费不能为负数/,
  );
  assert.throws(
    () => optimizeCuttingPlan({ settings: { ...settings, profitRate: -1 }, panels: [{ id: 'panel', length: 500, width: 500, thickness: 18, material: '' }], parts: [{ id: 'part', quantity: 1, length: 100, width: 100, thickness: 18, material: '' }] }),
    /全局利润比例不能为负数/,
  );
  assert.throws(
    () => optimizeCuttingPlan({ lossRate: 101, settings, panels: [{ id: 'panel', length: 500, width: 500, thickness: 18, material: '' }], parts: [{ id: 'part', quantity: 1, length: 100, width: 100, thickness: 18, material: '' }] }),
    /本单损耗率必须在 0% 到 100% 之间/,
  );
}

{
  const result = optimizeCuttingPlan({
    settings: { ...settings, profitRate: 120 },
    panels: [{ id: 'legacy-panel', length: 1000, width: 1000, thickness: 18, price: 100, material: '' }],
    parts: [{ id: 'part', quantity: 1, length: 1000, width: 1000, thickness: 18, material: '', allowRotate: false }],
  });
  assert.equal(result.layouts[0].panel.cost, 100, '旧 price 字段应自动作为成本价兼容读取');
  assert.equal(result.layouts[0].panelCharge, 120);
}

{
  const result = optimizeCuttingPlan({
    shippingDestination: '山东',
    settings: { ...settings, packagingFee: 20, logisticsProvider: LOGISTICS_PROVIDER },
    panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, cost: 100, weight: 40, material: '' }],
    parts: [{ id: 'part', quantity: 1, length: 1000, width: 1000, thickness: 18, material: '', allowRotate: false }],
  });
  assert.equal(result.stats.totalLogisticsFee, 80, '物流费应按目的地及实际使用板材总重量计算，乘以 120% 后向上取整到整十元');
  assert.equal(result.stats.packagingFee, 20, '全局打包费应按每个工程计费一次');
  assert.equal(result.stats.finalQuote, 235, '最终报价应包含板材费、切割费、打包费和取整后的物流费');
}

{
  const weightedByActualUsage = optimizeCuttingPlan({
    shippingDestination: '山东',
    settings: { ...settings, logisticsProvider: LOGISTICS_PROVIDER },
    panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, weight: 40, material: '' }],
    parts: [{ id: 'part', quantity: 1, length: 500, width: 1000, thickness: 18, material: '', allowRotate: false }],
  });
  assert.equal(weightedByActualUsage.layouts[0].usage, 0.5);
  assert.equal(weightedByActualUsage.layouts[0].actualWeight, 20, '单张实际重量应按板材净使用率计算');
  assert.equal(weightedByActualUsage.stats.totalWeight, 20, '总重量应累计实际用量重量，而不是整板重量');
  assert.equal(weightedByActualUsage.stats.totalLogisticsFee, 40, '物流费应使用按实际用量计算后的总重量，乘以 120% 后向上取整到整十元');
}

{
  const billedAtSeventyFromSixtyFour = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, cost: 100, material: '' }], parts: [{ id: 'part', quantity: 1, length: 640, width: 1000, thickness: 18, material: '', allowRotate: false }] });
  assert.equal(billedAtSeventyFromSixtyFour.layouts[0].usage, 0.64);
  assert.equal(billedAtSeventyFromSixtyFour.layouts[0].billingRate, 0.7, '64% 利用率应向上取整为 70% 计费');
  assert.equal(billedAtSeventyFromSixtyFour.stats.totalPanelCharge, 70);
  assert.equal(billedAtSeventyFromSixtyFour.stats.totalCuttingFee, 24.5, '切割费也应按 70% 计费');

  const billedAtSeventy = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, cost: 100, material: '' }], parts: [{ id: 'part', quantity: 1, length: 670, width: 1000, thickness: 18, material: '', allowRotate: false }] });
  assert.equal(billedAtSeventy.layouts[0].billingRate, 0.7, '67% 利用率应向上取整为 70% 计费');
  assert.equal(billedAtSeventy.stats.totalPanelCharge, 70);
  assert.equal(billedAtSeventy.stats.totalCuttingFee, 24.5);

  const billedAtEighty = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, cost: 100, material: '' }], parts: [{ id: 'part', quantity: 1, length: 760, width: 1000, thickness: 18, material: '', allowRotate: false }] });
  assert.equal(billedAtEighty.layouts[0].billingRate, 0.8, '76% 利用率应向上取整为 80% 计费');
  assert.equal(billedAtEighty.stats.totalPanelCharge, 80);
  assert.equal(billedAtEighty.stats.totalCuttingFee, 28);

  const billedAsFullSheet = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 1000, width: 1000, thickness: 18, cost: 100, material: '' }], parts: [{ id: 'part', quantity: 1, length: 800, width: 1000, thickness: 18, material: '', allowRotate: false }] });
  assert.equal(billedAsFullSheet.layouts[0].billingRate, 1, '80% 利用率应按整张计费');
  assert.equal(billedAsFullSheet.stats.totalPanelCharge, 100);
  assert.equal(billedAsFullSheet.stats.totalCuttingFee, 35);
}

{
  assert.throws(
    () => optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 500, width: 500, thickness: 18, cost: -1, material: '' }], parts: [{ id: 'part', quantity: 1, length: 100, width: 100, thickness: 18, material: '' }] }),
    /成本价不能为负数/,
  );
  assert.throws(
    () => optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 500, width: 500, thickness: 18, weight: -1, material: '' }], parts: [{ id: 'part', quantity: 1, length: 100, width: 100, thickness: 18, material: '' }] }),
    /重量不能为负数/,
  );
}

{
  const result = optimizeCuttingPlan({ settings, panels: [{ id: 'panel', length: 1000, width: 500, thickness: 18, material: 'MDF' }], parts: [{ id: 'part', quantity: 1, length: 100, width: 100, thickness: 25, material: 'MDF', allowRotate: true }] });
  assert.equal(result.unplaced.length, 1, '材质相同但厚度不同不能混排');
  assert.match(result.unplaced[0].reason, /厚度/);
}

{
  for (const optimizationLevel of ['quick', 'full']) {
    const result = optimizeCuttingPlan({ settings: { ...settings, panelMarginX: 10, panelMarginY: 10, optimizationLevel }, panels: [{ id: 'panel', length: 2440, width: 1220, thickness: 18, material: 'MDF' }], parts: [{ id: 'part', quantity: 6, length: 780, width: 480, thickness: 18, material: 'MDF', allowRotate: true }] });
    assert.equal(result.layouts.length, 1, `${optimizationLevel} 模式下 1220 × 2440 板材应只用一张`);
    assert.equal(result.layouts[0].placements.length, 6, `${optimizationLevel} 模式下单板应排入 6 张 480 × 780 零件`);
  }
}

function assertLayoutGeometry(result, { sawWidth, panelMarginX, panelMarginY }) {
  for (const layout of result.layouts) {
    if (layout.isFullSheet) continue;
    for (const part of layout.placements) {
      assert.ok(part.x >= panelMarginX - 0.0001 && part.y >= panelMarginY - 0.0001, '零件不应越过起始边距');
      assert.ok(part.x + part.placedLength <= layout.width - panelMarginX + 0.0001, '零件不应越过末端边距');
      assert.ok(part.y + part.placedWidth <= layout.height - panelMarginY + 0.0001, '零件不应越过末端边距');
    }
    for (let first = 0; first < layout.placements.length; first += 1) {
      for (let second = first + 1; second < layout.placements.length; second += 1) {
        const a = layout.placements[first];
        const b = layout.placements[second];
        const separation = Math.max(
          b.x - a.x - a.placedLength,
          a.x - b.x - b.placedLength,
          b.y - a.y - a.placedWidth,
          a.y - b.y - b.placedWidth,
        );
        assert.ok(separation >= sawWidth - 0.0001, `零件 ${a.instanceId} 和 ${b.instanceId} 应留足 ${sawWidth} mm 锯缝，实际 ${separation}`);
      }
    }
  }
}

{
  const geometrySettings = { ...settings, sawWidth: 8, optimizationLevel: 'quick' };
  const parts = [[34, 108], [51, 113], [108, 166], [132, 155], [153, 35], [102, 94], [35, 41], [60, 162]]
    .map(([length, width], index) => ({ id: `gap-${index}`, quantity: 1, length, width, material: 'MDF', thickness: 18, allowRotate: true }));
  const result = optimizeCuttingPlan({ settings: geometrySettings, panels: [{ id: 'panel', length: 300, width: 300, material: 'MDF', thickness: 18 }], parts });
  assert.equal(result.stats.placedCount, parts.length, '锯缝修复后仍应排入所有零件');
  assertLayoutGeometry(result, geometrySettings);
}

{
  const geometrySettings = { ...settings, sawWidth: 8, allowRotation: false, optimizationLevel: 'quick' };
  const result = optimizeCuttingPlan({
    settings: geometrySettings,
    panels: [{ id: 'panel', length: 208, width: 100, material: 'MDF', thickness: 18 }],
    parts: [{ id: 'exact', quantity: 2, length: 100, width: 100, material: 'MDF', thickness: 18, allowRotate: false }],
  });
  assert.equal(result.layouts.length, 1, '板边不需再预留锯缝，100 + 8 + 100 应恰好放入 208 mm 板材');
  assertLayoutGeometry(result, geometrySettings);
}

{
  let seed = 91;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let sample = 0; sample < 60; sample += 1) {
    const geometrySettings = {
      ...settings,
      sawWidth: sample % 3 === 0 ? 0 : 8,
      panelMarginX: sample % 2 === 0 ? 0 : 5,
      panelMarginY: sample % 2 === 0 ? 0 : 7,
      optimizationLevel: sample % 2 === 0 ? 'quick' : 'full',
    };
    const parts = Array.from({ length: 12 }, (_, index) => ({
      id: `random-${index}`, quantity: 1, length: 30 + Math.floor(random() * 140), width: 30 + Math.floor(random() * 140),
      material: 'MDF', thickness: 18, allowRotate: index % 3 !== 0,
    }));
    const result = optimizeCuttingPlan({ settings: geometrySettings, panels: [{ id: 'panel', length: 300, width: 300, material: 'MDF', thickness: 18 }], parts });
    assert.equal(result.stats.placedCount, parts.length, '随机样例应将所有尺寸可容纳的零件排入无限库存板材');
    const placedIds = result.layouts.flatMap((layout) => layout.placements.map((part) => part.instanceId));
    assert.equal(new Set(placedIds).size, parts.length, '每个零件实例应恰好排入一次');
    assertLayoutGeometry(result, geometrySettings);
  }
}

{
  const dimensions = [[80, 85], [160, 116], [74, 31], [168, 113], [144, 37], [77, 117], [51, 157], [121, 93], [60, 102], [136, 134], [162, 106], [63, 173], [73, 151], [79, 151]];
  const project = {
    settings: { ...settings, sawWidth: 3 },
    panels: [{ id: 'beam-panel', length: 300, width: 300, material: 'MDF', thickness: 18, cost: 100, weight: 20 }],
    parts: dimensions.map(([length, width], index) => ({ id: `beam-${index}`, quantity: 1, length, width, material: 'MDF', thickness: 18 })),
  };
  const original = structuredClone(project);
  const baseline = optimizeCuttingPlan(project, { includeBeam: false });
  const plan = optimizeCuttingPlan(project);
  assert.equal(baseline.stats.usedPanels, 3);
  assert.equal(plan.stats.usedPanels, 2, '束搜索应在此真实比较样例从三张减少至两张');
  assert.equal(plan.algorithm.selectedStrategy, 'rectangle-beam');
  assert.equal(plan.stats.placedCount, 14);
  assert.equal(plan.algorithm.provenance, 'independent-rectangle-adaptation');
  assert.equal(plan.algorithm.attempts, 14);
  assert.equal(plan.attemptsSummary.filter((attempt) => attempt.selected).length, 1);
  assert.equal(plan.trace.length, 14);
  assert.deepEqual(project, original, '组合优化不可修改用户工程');
  for (const step of plan.trace) {
    const part = plan.layouts[step.layoutIndex].placements[step.placementIndex];
    assert.equal(step.partId, part.instanceId);
    assert.deepEqual([step.x, step.y, step.width, step.height, step.rotated], [part.x, part.y, part.placedLength, part.placedWidth, part.rotated]);
  }
  assertLayoutGeometry(plan, project.settings);
  assert.deepEqual(optimizeCuttingPlan(project).trace, plan.trace, '演示步骤应可重现');
}

{
  const panel = { id: 'panel', length: 2440, width: 1220, thickness: 18, cost: 100 };
  const part = { id: 'full', quantity: 1, length: 1220, width: 2440, thickness: 18 };
  for (const optimizationLevel of ['quick', 'full']) {
    for (const restriction of [{ allowRotation: false, allowRotate: true }, { allowRotation: true, allowRotate: false }]) {
      const project = {
        panels: [panel], parts: [{ ...part, allowRotate: restriction.allowRotate }],
        settings: { ...settings, optimizationLevel, allowRotation: restriction.allowRotation },
      };
      const blocked = optimizeCuttingPlan(project);
      assert.equal(blocked.stats.placedCount, 0, '整板件不得绕过全局或单件禁止旋转');
      assert.equal(blocked.unplaced.length, 1);
      project.parts[0] = { ...project.parts[0], length: 2440, width: 1220 };
      project.settings.panelMarginX = 10;
      project.settings.panelMarginY = 10;
      const aligned = optimizeCuttingPlan(project);
      assert.equal(aligned.stats.placedCount, 1, '方向一致的整板件仍可免裁边使用');
      assert.equal(aligned.layouts[0].isFullSheet, true);
      assert.equal(aligned.layouts[0].placements[0].rotated, false);
      assert.equal(aligned.layouts[0].cuttingFee, 0);
    }
  }
}

{
  const project = {
    panels: [{ length: 1000, width: 1000, thickness: 18 }],
    parts: [{ id: 'quantity', length: 100, width: 100, thickness: 18, quantity: 1 }],
    settings,
  };
  for (const quantity of [1.5, -1, NaN, Infinity, '', ' ', undefined, null, true, 'invalid', Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = { ...project, parts: [{ ...project.parts[0], quantity }] };
    assert.ok(validateProject(invalid).some(error => /数量.*整数/.test(error)));
    assert.throws(() => optimizeCuttingPlan(invalid), /数量.*整数/, '无效数量须在排版前报错');
  }
  const plan = optimizeCuttingPlan({ ...project, parts: [{ ...project.parts[0], quantity: 2 }, { ...project.parts[0], id: 'zero', quantity: 0 }] });
  assert.equal(plan.stats.requestedCount, 2);
  assert.equal(plan.stats.placedCount, 2);
}

{
  const project = {
    settings: { ...settings, rotationStep: 'obsolete', maxShapeVertices: 1 },
    panels: [{ length: 500, width: 500, thickness: 18 }],
    parts: [{ id: 'legacy', length: 100, width: 100, thickness: 18, quantity: 1 }],
  };
  assert.equal(optimizeCuttingPlan(project).stats.placedCount, 1, '已移除的旧设置不能影响矩形排版');
  for (const geometry of [
    { shape: { outer: [[0, 0], [100, 0], [0, 100]], holes: [] } },
    { rotationAngles: [17.3] },
    { rotationAngles: [0, 90] },
    { rotationAngles: null },
  ]) {
    const legacy = { ...project, parts: [{ ...project.parts[0], ...geometry }] };
    const before = structuredClone(legacy);
    assert.throws(() => optimizeCuttingPlan(legacy), /不再支持.*重新录入矩形零件/, '旧轮廓不得静默变成矩形排版');
    assert.deepEqual(legacy, before, '拒绝旧数据时必须保留原始工程');
  }
}

console.log('engine tests passed');
