import assert from 'node:assert/strict';
import { fillPolygonSheet, polygonFitsPanel } from '../polygon-nesting.mjs';
import { shapesOverlap, shapeArea, shapeBounds, normalizeShape, transformShape } from '../polygon-geometry.mjs';

const sheet = { length: 100, width: 100 };
const lShape = { outer: [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]], holes: [] };
const frame = { outer: [[0, 0], [100, 0], [100, 100], [0, 100]], holes: [[[20, 20], [80, 20], [80, 80], [20, 80]]] };
const partsWith = (shape, size = 50) => [
  { id: 'outer', instanceId: 'outer-1', shape, allowRotate: false },
  { id: 'inner', instanceId: 'inner-1', length: size, width: size, allowRotate: false },
];

function verify(result, panel, settings = {}) {
  const mx = settings.panelMarginX ?? 0, my = settings.panelMarginY ?? 0, gap = settings.sawWidth ?? 0;
  let total = 0;
  for (const placement of result.placements) {
    const bounds = shapeBounds(placement.placedShape);
    assert.ok(bounds.minX >= mx - 1e-7 && bounds.minY >= my - 1e-7);
    assert.ok(bounds.maxX <= panel.length - mx + 1e-7 && bounds.maxY <= panel.width - my + 1e-7);
    assert.ok(Math.abs(bounds.width - placement.placedLength) < 1e-7);
    assert.ok(Math.abs(bounds.height - placement.placedWidth) < 1e-7);
    total += shapeArea(placement.shape);
    if (settings.allowRotation === false || placement.allowRotate === false) assert.equal(placement.angle, 0);
  }
  assert.ok(Math.abs(total - result.usedArea) < 1e-7);
  for (let i = 0; i < result.placements.length; i += 1) for (let j = i + 1; j < result.placements.length; j += 1) {
    assert.equal(shapesOverlap(result.placements[i].placedShape, result.placements[j].placedShape, gap), false, '真实实体不可相交且应满足欧氏间距');
  }
}

{
  const parts = partsWith(lShape);
  const frozen = structuredClone(parts);
  const result = fillPolygonSheet(sheet, parts);
  assert.equal(result.placements.length, 2, '凹 L 形与方块应在包围盒重叠下互锁');
  assert.equal(result.placements[1].x, 40);
  assert.equal(result.placements[1].y, 40);
  assert.equal(result.usedArea, 8900);
  assert.ok(result.diagnostics.nfpTrianglePairs > 0, '应实际构造三角对 Minkowski 禁入域');
  assert.deepEqual(parts, frozen, '排版不得修改输入');
  assert.deepEqual(result, fillPolygonSheet(sheet, parts), '候选及结果应确定可复现');
  verify(result, sheet);
}

{
  const result = fillPolygonSheet(sheet, partsWith(frame, 60));
  assert.equal(result.placements.length, 2, '孔洞可用于套排，60 mm 方块应恰好进入60 mm内孔');
  assert.equal(result.placements[1].x, 20);
  assert.equal(result.placements[1].y, 20);
  assert.equal(result.usedArea, 10000, '有孔框只按净实体面积计入利用率');
  verify(result, sheet);
  const spaced = fillPolygonSheet(sheet, partsWith(frame, 56), { sawWidth: 2 });
  assert.equal(spaced.placements.length, 2);
  verify(spaced, sheet, { sawWidth: 2 });
  const tooLarge = fillPolygonSheet(sheet, partsWith(frame, 58), { sawWidth: 2 });
  assert.equal(tooLarge.placements.length, 1, '两侧各2mm间距时58mm零件不能进入60mm内孔');
}

{
  const part = { instanceId: 'diagonal', length: 120, width: 10, rotationAngles: [0, 45, 90] };
  assert.equal(polygonFitsPanel(part, sheet), true);
  const result = fillPolygonSheet(sheet, [part]);
  assert.equal(result.placements.length, 1);
  assert.equal(result.placements[0].angle, 45, '超长件应通过斜放而不是包围矩形0/90通过');
  verify(result, sheet);
  assert.equal(polygonFitsPanel(part, sheet, { allowRotation: false }), false);
  assert.equal(fillPolygonSheet(sheet, [{ ...part, allowRotate: false }]).placements.length, 0);
}

{
  const part = { instanceId: 'fraction', length: 60, width: 12, rotationAngles: [17.3] };
  const result = fillPolygonSheet(sheet, [part], { panelMarginX: 3, panelMarginY: 7 });
  assert.equal(result.placements[0].angle, 17.3);
  assert.deepEqual(result.placements[0].placedShape, transformShape(result.placements[0].shape, 17.3, result.placements[0].x, result.placements[0].y));
  verify(result, sheet, { panelMarginX: 3, panelMarginY: 7 });
}

{
  const triangle = { outer: [[0, 0], [100, 0], [0, 100]], holes: [] };
  const result = fillPolygonSheet(sheet, [
    { instanceId: 'triangle-a', shape: triangle, rotationAngles: [0] },
    { instanceId: 'triangle-b', shape: triangle, rotationAngles: [180] },
  ]);
  assert.equal(result.placements.length, 2, '两个互补三角形的包围盒完全重叠仍应放入同板');
  assert.equal(result.usedArea, 10000);
  verify(result, sheet);
}

{
  const part = { instanceId: 'refinement', shape: { outer: [[0, 0], [120, 0], [15, 30]], holes: [] } };
  const coarse = { rotationStep: 90, angleRefinementDepth: 0 };
  const refined = { rotationStep: 90, angleRefinementDepth: 2 };
  assert.equal(polygonFitsPanel(part, sheet, coarse), false);
  assert.equal(fillPolygonSheet(sheet, [part], coarse).placements.length, 0);
  assert.equal(polygonFitsPanel(part, sheet, refined), true, '局部角度细化后才可放入时单件预检不能先排除');
  const result = fillPolygonSheet(sheet, [part], refined);
  assert.equal(result.placements.length, 1);
  assert.ok(result.diagnostics.refinementAngles > 0);
  assert.ok(Math.abs(result.placements[0].angle % 90) > 1, '局部细化应实际探索非90°角');
  verify(result, sheet);
  assert.equal(fillPolygonSheet(sheet, [{ ...part, rotationAngles: [0] }], refined).diagnostics.refinementAngles, 0, '显式角列表不可被细化扩展');
  assert.equal(fillPolygonSheet(sheet, [{ ...part, allowRotate: false }], refined).diagnostics.refinementAngles, 0, '禁转不可局部细化');
}

{
  const bad = { outer: [[0, 0], [10, 10], [0, 10], [10, 0]], holes: [] };
  assert.throws(() => fillPolygonSheet(sheet, [{ shape: bad }]), /轮廓|相交|面积/);
  assert.throws(() => fillPolygonSheet(sheet, [{ length: 10, width: 10, rotationAngles: [] }]), /角度/);
  assert.throws(() => fillPolygonSheet(sheet, [{ instanceId: 'same', length: 10, width: 10 }, { instanceId: 'same', length: 10, width: 10 }]), /编号重复/);
  assert.equal(fillPolygonSheet(sheet, []).placements.length, 0);
  assert.equal(polygonFitsPanel({ length: 10, width: 10 }, sheet, { panelMarginX: 51 }), false);
}

{
  const result = fillPolygonSheet(sheet, partsWith(lShape), { maxNfpTrianglePairs: 1 });
  assert.equal(result.diagnostics.limited, true, '降级需要显式说明');
  assert.ok(result.diagnostics.fallbacks > 0);
  assert.equal(result.placements.length, 2, '受限时仍应尝试安全接触候选');
  verify(result, sheet);
  const bounded = fillPolygonSheet(sheet, partsWith(lShape), { maxPolygonEvaluations: 1 });
  assert.equal(bounded.diagnostics.evaluations, 1, '候选检查应服从硬预算');
  assert.equal(bounded.diagnostics.budgetExhausted, true);
  verify(bounded, sheet);
}

{
  let seed = 681;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let sample = 0; sample < 12; sample += 1) {
    const parts = Array.from({ length: 5 }, (_, index) => {
      const w = 15 + Math.floor(random() * 25), h = 15 + Math.floor(random() * 25);
      return { instanceId: `${sample}-${index}`, shape: normalizeShape({ outer: [[0, 0], [w, 0], [w, h / 2], [w / 2, h / 2], [w / 2, h], [0, h]], holes: [] }), rotationAngles: [0, 37.4, 90], allowRotate: index !== 1 };
    });
    const settings = { sawWidth: sample % 3, panelMarginX: 2, panelMarginY: 3 };
    const result = fillPolygonSheet(sheet, parts, settings);
    assert.ok(result.placements.length > 0);
    verify(result, sheet, settings);
  }
}

console.log('polygon nesting tests passed');
