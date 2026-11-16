import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optimizeCuttingPlan, groupIdenticalLayouts, repriceCuttingPlan } from '../engine.mjs';
import { shapeArea, shapesOverlap, shapeBounds } from '../polygon-geometry.mjs';
import { createProjectStore } from '../storage.mjs';
import { formatQuotationText } from '../quotation.mjs';

const settings = { sawWidth: 0, panelMarginX: 0, panelMarginY: 0, profitRate: 100, cuttingFee: 10, allowRotation: true, optimizationLevel: 'quick' };
const panel = { id: 'panel', length: 100, width: 100, material: 'MDF', thickness: 18, cost: 100, weight: 20 };
const makePart = (id, extra = {}) => ({ id, quantity: 1, material: 'MDF', thickness: 18, ...extra });
const lShape = { outer: [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]], holes: [] };
const frame = { outer: [[0, 0], [100, 0], [100, 100], [0, 100]], holes: [[[20, 20], [20, 80], [80, 80], [80, 20]]] };

function checkGeometry(result, activeSettings) {
  const ids = [];
  for (const layout of result.layouts) {
    for (const [index, part] of layout.placements.entries()) {
      ids.push(part.instanceId);
      if (layout.isFullSheet) continue;
      const bounds = shapeBounds(part.placedShape);
      assert.ok(bounds.minX >= activeSettings.panelMarginX - 1e-6);
      assert.ok(bounds.minY >= activeSettings.panelMarginY - 1e-6);
      assert.ok(bounds.maxX <= layout.width - activeSettings.panelMarginX + 1e-6);
      assert.ok(bounds.maxY <= layout.height - activeSettings.panelMarginY + 1e-6);
      for (const other of layout.placements.slice(index + 1)) assert.equal(shapesOverlap(part.placedShape, other.placedShape, activeSettings.sawWidth), false);
    }
  }
  assert.equal(new Set(ids).size, ids.length);
}

{
  const project = { settings, panels: [panel], parts: [makePart('l', { shape: lShape, rotationAngles: [0] }), makePart('square', { length: 60, width: 60, allowRotate: false })] };
  const original = structuredClone(project);
  const result = optimizeCuttingPlan(project);
  assert.equal(result.stats.usedPanels, 1, 'L形凹口内应放入方块，包围框重叠不能当成实体碰撞');
  assert.equal(result.stats.placedCount, 2);
  assert.equal(result.stats.partsArea, 10000, '互锁后长宽计量面积超过整板时按整板封顶');
  assert.equal(result.layouts[0].measurementArea, 13600);
  assert.equal(result.stats.totalWeight, 20);
  assert.equal(result.algorithm.selectedStrategy, 'polygon-nfp');
  assert.equal(result.algorithm.provenance, 'independent-polygon-adaptation');
  assert.deepEqual(project, original);
  checkGeometry(result, settings);
  assert.equal(result.trace.length, 2);
  result.trace.forEach((step) => assert.equal(step.angle, result.layouts[step.layoutIndex].placements[step.placementIndex].angle));
}

{
  const activeSettings = { ...settings, sawWidth: 2 };
  const result = optimizeCuttingPlan({ settings: activeSettings, panels: [panel], parts: [makePart('frame', { shape: frame, rotationAngles: [0] }), makePart('inside', { length: 56, width: 56, allowRotate: false })] });
  assert.equal(result.stats.usedPanels, 1, '孔洞应作为可用放置区域');
  assert.equal(result.stats.placedCount, 2);
  assert.equal(result.stats.partsArea, 10000, '沿用长宽计量，不扣内孔和异形缺角；最多整板');
  assert.equal(result.layouts[0].measurementArea, 13136);
  assert.equal(result.stats.totalWeight, 20);
  checkGeometry(result, activeSettings);
  repriceCuttingPlan(result, { settings: activeSettings, lossRate: 2 });
  assert.equal(result.stats.partsArea, 10000);
  assert.equal(result.stats.totalWeight, 20);
}

{
  const result = optimizeCuttingPlan({ settings, panels: [{ ...panel, length: 200, width: 200 }], parts: [makePart('original-accounting', { shape: lShape, rotationAngles: [0] })] });
  assert.equal(result.layouts[0].measurementArea, 10000);
  assert.equal(result.layouts[0].usage, 0.25, 'L形仍按100×100计量，不能按扣除缺角后的6400计量');
  assert.equal(result.stats.totalWeight, 5, '重量沿用整张重量×长宽利用率');
}

{
  const part = makePart('slanted', { length: 120, width: 10, rotationAngles: [45] });
  const result = optimizeCuttingPlan({ settings, panels: [panel], parts: [part] });
  assert.equal(result.stats.placedCount, 1, '只有斜放能进入板材的零件不能按0/90尺寸提前排除');
  assert.equal(result.layouts[0].placements[0].angle, 45);
  checkGeometry(result, settings);
  const forbidden = optimizeCuttingPlan({ settings: { ...settings, allowRotation: false }, panels: [panel], parts: [part] });
  assert.equal(forbidden.stats.placedCount, 0);
  assert.match(forbidden.unplaced[0].reason, /当前旋转角度/);
}

{
  const result = optimizeCuttingPlan({ settings, panels: [{ ...panel, length: 108, width: 40 }], parts: [makePart('fractional', { length: 110, width: 5, rotationAngles: [17.3] })] });
  assert.equal(result.stats.placedCount, 1);
  assert.ok(Math.abs(result.layouts[0].placements[0].angle - 17.3) < 1e-7);
  checkGeometry(result, settings);
}

{
  const outer = [[0, 0], [2440, 0], [2440, 1220], [0, 1220]];
  const hole = [[100, 100], [100, 200], [200, 200], [200, 100]];
  const result = optimizeCuttingPlan({ settings, panels: [{ ...panel, length: 2440, width: 1220 }], parts: [makePart('perforated', { shape: { outer, holes: [hole] }, rotationAngles: [0] })] });
  assert.equal(result.layouts[0].isFullSheet, undefined, '有孔的同包围尺寸异形件不能冒充免切割整板件');
  assert.equal(result.stats.totalCuttingFee, 10);
  assert.equal(result.stats.partsArea, 2440 * 1220, '不扣内孔面积');
}

{
  assert.throws(() => optimizeCuttingPlan({ settings, panels: [panel], parts: [makePart('bad', { shape: { outer: [[0, 0], [10, 10], [0, 10], [10, 0]], holes: [] } })] }), /轮廓无效/);
  assert.throws(() => optimizeCuttingPlan({ settings, panels: [panel], parts: [makePart('bad-angle', { length: 10, width: 10, rotationAngles: [] })] }), /角度无效/);
  const first = optimizeCuttingPlan({ settings, panels: [panel], parts: [makePart('shape', { shape: lShape, rotationAngles: [0] })] }).layouts[0];
  const second = structuredClone(first);
  second.placements[0].placedShape = { outer: [[0, 0], [100, 0], [0, 100]], holes: [] };
  assert.equal(groupIdenticalLayouts([first, second]).length, 2, '相同包围尺寸但不同真实轮廓不能合并');
  const quote = formatQuotationText({ parts: [makePart('shape', { shape: lShape })] });
  assert.match(quote, /100\*100\*18mm 1张/);
  assert.doesNotMatch(quote, /异形|包围/);
  assert.doesNotMatch(quote, /净面积/);
}

{
  const directory = mkdtempSync(join(tmpdir(), 'board-polygons-'));
  try {
    const path = join(directory, 'polygons.sqlite');
    const project = { id: 'shape-project', name: '孔洞与角度持久化', parts: [makePart('saved', { shape: frame, rotationAngles: [0, 17.3] })] };
    let store = createProjectStore(path);
    store.saveProject(project); store.saveDraft(project); store.close();
    store = createProjectStore(path);
    assert.deepEqual(store.getDraft().parts, project.parts);
    assert.deepEqual(store.listProjects()[0].parts, project.parts);
    assert.equal(shapeArea(store.getDraft().parts[0].shape), 6400);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

console.log('polygon engine integration tests passed');
