// Independent rectangular adaptation of a layered beam search. This is not
// recovered vendor source, and does not implement general polygon nesting.
const EPSILON = 0.0001;
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const limit = (value, fallback, maximum) => Math.min(maximum, Math.max(1, Math.floor(finite(value, fallback))));

function compare(first, second) {
  for (let index = 0; index < first.length; index += 1) {
    if (Math.abs(first[index] - second[index]) > EPSILON) return first[index] - second[index];
  }
  return 0;
}

function stateScore(state, bounds) {
  let right = bounds.left;
  let bottom = bounds.top;
  for (const part of state.placements) {
    right = Math.max(right, part.x + part.placedLength);
    bottom = Math.max(bottom, part.y + part.placedWidth);
  }
  return [-state.usedArea, (right - bounds.left) * (bottom - bounds.top), -state.placements.length, bottom, right];
}

function stateKey(state) {
  return JSON.stringify(state.placements.map((part) => [part.instanceId, part.x, part.y, part.rotated])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function orientations(part, allowRotation) {
  const result = [{ width: part.length, height: part.width, rotated: false }];
  if (allowRotation && part.allowRotate !== false && Math.abs(part.length - part.width) > EPSILON) {
    result.push({ width: part.width, height: part.length, rotated: true });
  }
  return result;
}

function anchors(state, bounds, kerf) {
  const xs = new Set([bounds.left]);
  const ys = new Set([bounds.top]);
  for (const part of state.placements) {
    xs.add(part.x + part.placedLength + kerf);
    ys.add(part.y + part.placedWidth + kerf);
  }
  return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
}

function fits(state, x, y, width, height, bounds, kerf) {
  if (x < bounds.left - EPSILON || y < bounds.top - EPSILON
    || x + width > bounds.right + EPSILON || y + height > bounds.bottom + EPSILON) return false;
  return state.placements.every((part) =>
    x + width + kerf <= part.x + EPSILON
    || part.x + part.placedLength + kerf <= x + EPSILON
    || y + height + kerf <= part.y + EPSILON
    || part.y + part.placedWidth + kerf <= y + EPSILON);
}

function children(state, parts, bounds, settings, candidateLimit, consume) {
  const occupied = new Set(state.placements.map((part) => part.instanceId));
  const seenSpecs = new Set();
  const result = [];
  const { xs, ys } = anchors(state, bounds, settings.sawWidth);
  let feasibleSpecs = 0;
  for (const part of parts) {
    if (occupied.has(part.instanceId)) continue;
    const signature = `${part.length}:${part.width}:${part.allowRotate !== false}`;
    if (seenSpecs.has(signature)) continue;
    seenSpecs.add(signature);
    let feasible = false;
    for (const orientation of orientations(part, settings.allowRotation)) {
      // Oversized orientations cannot yield a candidate and need no search work.
      if (orientation.width > bounds.right - bounds.left + EPSILON
        || orientation.height > bounds.bottom - bounds.top + EPSILON) continue;
      for (const y of ys) {
        for (const x of xs) {
          if (!consume()) return result;
          if (!fits(state, x, y, orientation.width, orientation.height, bounds, settings.sawWidth)) continue;
          feasible = true;
          result.push({
            placements: [...state.placements, { ...part, x, y, placedLength: orientation.width, placedWidth: orientation.height, rotated: orientation.rotated }],
            usedArea: state.usedArea + part.length * part.width,
          });
        }
      }
    }
    if (feasible && ++feasibleSpecs >= candidateLimit) break;
  }
  return result;
}

function contains(outer, inner) {
  return inner.x >= outer.x - EPSILON && inner.y >= outer.y - EPSILON
    && inner.x + inner.w <= outer.x + outer.w + EPSILON
    && inner.y + inner.h <= outer.y + outer.h + EPSILON;
}

function remainingRectangles(placements, bounds, kerf) {
  let rects = bounds.right > bounds.left && bounds.bottom > bounds.top
    ? [{ x: bounds.left, y: bounds.top, w: bounds.right - bounds.left, h: bounds.bottom - bounds.top }]
    : [];
  for (const part of placements) {
    const used = { x: part.x, y: part.y,
      w: Math.min(bounds.right - part.x, part.placedLength + kerf),
      h: Math.min(bounds.bottom - part.y, part.placedWidth + kerf) };
    const next = [];
    for (const rect of rects) {
      if (used.x >= rect.x + rect.w - EPSILON || used.x + used.w <= rect.x + EPSILON
        || used.y >= rect.y + rect.h - EPSILON || used.y + used.h <= rect.y + EPSILON) {
        next.push(rect);
        continue;
      }
      if (used.x > rect.x + EPSILON) next.push({ ...rect, w: used.x - rect.x });
      if (used.y > rect.y + EPSILON) next.push({ ...rect, h: used.y - rect.y });
      if (used.x + used.w < rect.x + rect.w - EPSILON) next.push({ x: used.x + used.w, y: rect.y, w: rect.x + rect.w - used.x - used.w, h: rect.h });
      if (used.y + used.h < rect.y + rect.h - EPSILON) next.push({ x: rect.x, y: used.y + used.h, w: rect.w, h: rect.y + rect.h - used.y - used.h });
    }
    rects = next.filter((rect, index) => rect.w > EPSILON && rect.h > EPSILON
      && !next.some((other, otherIndex) => index !== otherIndex && contains(other, rect)
        && (!contains(rect, other) || otherIndex < index)));
  }
  return rects;
}

export function fillRectangleSheet(panel, parts, inputSettings = {}) {
  const settings = {
    sawWidth: Math.max(0, finite(inputSettings.sawWidth)),
    allowRotation: inputSettings.allowRotation !== false,
  };
  const beamWidth = limit(inputSettings.beamWidth, 4, 64);
  const candidateLimit = limit(inputSettings.candidateLimit, 6, 64);
  const maxSearchParts = limit(inputSettings.maxSearchParts, 60, 500);
  const maxExpandedStates = limit(inputSettings.maxExpandedStates, 10000, 1000000);
  const marginX = Math.max(0, finite(inputSettings.panelMarginX));
  const marginY = Math.max(0, finite(inputSettings.panelMarginY));
  const bounds = { left: marginX, top: marginY, right: finite(panel.length) - marginX, bottom: finite(panel.width) - marginY };
  const validParts = parts.filter((part) => finite(part.length) > 0 && finite(part.width) > 0);
  let expandedStates = 0;
  let limited = validParts.length > maxSearchParts;
  const consume = () => {
    if (expandedStates >= maxExpandedStates) {
      limited = true;
      return false;
    }
    expandedStates += 1;
    return true;
  };
  const scoreCompare = (first, second) => compare(stateScore(first, bounds), stateScore(second, bounds));
  let best = { placements: [], usedArea: 0 };
  let beam = [best];
  let depth = 0;
  if (!limited) {
    for (; depth < validParts.length; depth += 1) {
      const next = [];
      for (const state of beam) {
        next.push(...children(state, validParts, bounds, settings, candidateLimit, consume));
        if (limited) break;
      }
      if (!next.length) break;
      next.sort(scoreCompare);
      if (scoreCompare(next[0], best) < 0) best = next[0];
      const seen = new Set();
      beam = next.filter((state) => {
        const key = stateKey(state);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, beamWidth);
      if (limited) {
        depth += 1;
        break;
      }
    }
  }
  // Always continue over the complete part list. A limited candidate window or
  // exhausted search budget must not leave an easy-to-place small part behind.
  while (true) {
    const next = children(best, validParts, bounds, settings, 1, () => true);
    if (!next.length) break;
    next.sort(scoreCompare);
    best = next[0];
  }
  return {
    placements: best.placements,
    freeRects: remainingRectangles(best.placements, bounds, settings.sawWidth),
    usedArea: best.usedArea,
    diagnostics: { expandedStates, beamWidth, depth, limited },
  };
}
