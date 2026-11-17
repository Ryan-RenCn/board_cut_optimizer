import { parentPort, workerData } from 'node:worker_threads';
import assert from 'node:assert/strict';
const { optimizeCuttingPlan } = await import(workerData.enginePath || '../engine.mjs');
const { quantity, optimizationLevel } = workerData;
const settings = { sawWidth: 3, panelMarginX: 10, panelMarginY: 10, allowRotation: true, optimizationLevel };
const start = performance.now();
const result = optimizeCuttingPlan({
  settings,
  parts: [{ id: 'a', quantity, length: 200, width: 140, material: 'MDF', thickness: 18 }],
  panels: [{ length: 1220, width: 2440, material: 'MDF', thickness: 18, cost: 100, weight: 40 }],
});
const ms = Math.round(performance.now() - start);
for (const layout of result.layouts) {
  for (const part of layout.placements) {
    assert.ok(part.x >= 10 && part.y >= 10);
    assert.ok(part.x + part.placedLength <= layout.width - 10 + .0001);
    assert.ok(part.y + part.placedWidth <= layout.height - 10 + .0001);
  }
  for (let i = 0; i < layout.placements.length; i++) for (let j = i + 1; j < layout.placements.length; j++) {
    const a = layout.placements[i], b = layout.placements[j];
    assert.ok(a.x + a.placedLength + 3 <= b.x + .0001 || b.x + b.placedLength + 3 <= a.x + .0001
      || a.y + a.placedWidth + 3 <= b.y + .0001 || b.y + b.placedWidth + 3 <= a.y + .0001);
  }
}
assert.equal(result.stats.placedCount, quantity);
parentPort.postMessage({ ms, placed: result.stats.placedCount, panels: result.stats.usedPanels, geometryVerified: true });
