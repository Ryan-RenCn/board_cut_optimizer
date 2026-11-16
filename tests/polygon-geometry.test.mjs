import assert from 'node:assert/strict';
import { normalizeShape, shapeBounds, shapeArea, transformShape, shapesOverlap, normalizeAngle, rotationCandidates } from '../polygon-geometry.mjs';
import ClipperLib from '../vendor/clipper.mjs';

const square = (x, y, size) => ({ outer: [[x, y], [x + size, y], [x + size, y + size], [x, y + size]], holes: [] });
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} should equal ${expected}`);

{
  const input = { outer: [[10, 20], [20, 20], [20, 20], [20, 30], [10, 30], [10, 20]], holes: [[[12, 22], [15, 22], [15, 25], [12, 25], [12, 22]]] };
  const original = structuredClone(input);
  const shape = normalizeShape(input);
  assert.deepEqual(shapeBounds(shape), { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 10, height: 10 });
  assert.equal(shape.outer.length, 4);
  assert.equal(shape.holes[0].length, 4);
  approx(shapeArea(shape), 91);
  assert.deepEqual(input, original, 'normalization must not mutate source contours');
}

{
  for (const outer of [
    [[0, 0], [10, 10], [0, 10], [10, 0]],
    [[0, 0], [10, 0], [5, 0], [10, 10], [0, 10]],
    [[0, 0], [10, 0], [20, 0]],
    [[0, 0], [NaN, 0], [1, 1]],
    [[0, 0], [Infinity, 0], [1, 1]],
    [[0, 0], ['10', 0], [1, 1]],
    [[0, 0], [1000001, 0], [1, 1]],
  ]) assert.throws(() => normalizeShape({ outer }));
  assert.throws(() => normalizeShape({ outer: square(0, 0, 10).outer, holes: [square(9, 9, 2).outer] }), /严格位于/);
  assert.throws(() => normalizeShape({ outer: square(0, 0, 10).outer, holes: [square(0, 1, 2).outer] }), /严格位于/);
  assert.throws(() => normalizeShape({ outer: square(0, 0, 10).outer, holes: [square(1, 1, 4).outer, square(4, 4, 2).outer] }), /孔洞之间/);
  assert.throws(() => normalizeShape({ outer: square(0, 0, 10).outer, holes: [square(1, 1, 4).outer, square(5, 1, 2).outer] }), /孔洞之间/);
  assert.throws(() => normalizeShape({ outer: square(0, 0, 10).outer, holes: [square(1, 1, 6).outer, square(2, 2, 1).outer] }), /孔洞之间/);
  assert.throws(() => normalizeShape(square(0, 0, 10), { maxVertices: 3 }), /顶点总数/);
}

{
  const rectangle = normalizeShape({ outer: [[0, 0], [10, 0], [10, 2], [0, 2]] });
  const rotated = transformShape(rectangle, 45, 100, 200);
  approx(shapeBounds(rotated).minX, 100);
  approx(shapeBounds(rotated).minY, 200);
  approx(shapeBounds(rotated).width, 12 / Math.sqrt(2));
  approx(shapeArea(rotated), 20);
  const negative = transformShape(rectangle, -90);
  approx(shapeBounds(negative).width, 2);
  approx(shapeBounds(negative).height, 10);
  const fractional = transformShape(rectangle, 12.345);
  approx(shapeArea(fractional), 20);
  assert.equal(normalizeAngle(-90), 270);
  assert.equal(normalizeAngle(720), 0);
  assert.equal(normalizeAngle(-360), 0);
  assert.throws(() => normalizeAngle(NaN));
}

{
  const base = square(0, 0, 10);
  assert.equal(shapesOverlap(base, square(10, 0, 10)), false, 'boundary touch alone is not positive area overlap');
  assert.equal(shapesOverlap(base, square(10, 10, 10)), false, 'single-vertex touch is allowed at zero clearance');
  assert.equal(shapesOverlap(base, square(9, 0, 10)), true);
  assert.equal(shapesOverlap(base, base), true, 'identical polygons must collide');
  assert.equal(shapesOverlap(base, { outer: [...base.outer].reverse() }), true, 'winding cannot disguise identical geometry');
  assert.equal(shapesOverlap(base, square(2, 2, 2)), true, 'strict containment in solid is collision');
  assert.equal(shapesOverlap(base, square(12, 0, 10), 2), false, 'exact requested clearance is allowed');
  assert.equal(shapesOverlap(base, square(11.9, 0, 10), 2), true);
  assert.equal(shapesOverlap(base, square(10, 0, 10), 0.1), true);
  assert.equal(shapesOverlap(base, square(11, 11, 10), 1.4), false, 'diagonal clearance uses Euclidean geometry');
  assert.equal(shapesOverlap(base, square(11, 11, 10), 1.42), true);
  assert.throws(() => shapesOverlap(base, base, -1));
}

{
  const lShape = normalizeShape({ outer: [[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]] });
  assert.equal(shapeArea(lShape), 51);
  assert.equal(shapesOverlap(lShape, square(4, 4, 5)), false, 'overlapping bounding boxes do not imply polygon overlap');
  assert.equal(shapesOverlap(lShape, square(2, 4, 5)), true);
  const frame = normalizeShape({ outer: square(0, 0, 20).outer, holes: [square(3, 3, 14).outer] });
  assert.equal(shapeArea(frame), 204);
  assert.equal(shapesOverlap(frame, square(5, 5, 10)), false, 'part inside a hole must be allowed');
  assert.equal(shapesOverlap(frame, square(5, 5, 10), 2), false);
  assert.equal(shapesOverlap(frame, square(5, 5, 10), 2.01), true);
  assert.equal(shapesOverlap(frame, square(3, 3, 14)), false, 'opposite material sides along a hole are only touching');
  assert.equal(shapesOverlap(frame, square(3, 3, 14), 0.1), true);
  assert.equal(shapesOverlap(frame, square(2, 4, 5)), true);
  assert.equal(shapesOverlap(frame, frame), true);
  const vertical = { outer: [[4, -2], [6, -2], [6, 12], [4, 12]] };
  assert.equal(shapesOverlap(lShape, vertical), true, 'edge crossings must be detected even without vertex containment');
}

{
  const triangle = normalizeShape({ outer: [[0, 0], [10, 0], [0, 10]] });
  const complementary = { outer: [[10, 0], [10, 10], [0, 10]] };
  assert.equal(shapesOverlap(triangle, complementary), false, 'two complementary triangles can share only their diagonal');
  const crossingTriangle = { outer: [[0, 5], [5, 0], [10, 10]] };
  assert.equal(shapesOverlap(triangle, crossingTriangle), true);
  assert.equal(shapesOverlap(crossingTriangle, triangle), true);
}

{
  assert.deepEqual(rotationCandidates({}), [0, 90], 'legacy rectangle default remains right-angle-only');
  assert.deepEqual(rotationCandidates({}, { rotationStep: 15 }), [0, 90], 'global polygon angle step must not alter ordinary rectangles');
  assert.deepEqual(rotationCandidates({ rotationAngles: [-15, 345, 720, 12.345] }), [345, 0, 12.345]);
  assert.deepEqual(rotationCandidates({ rotationAngles: [45] }, { allowRotation: false }), [0]);
  assert.deepEqual(rotationCandidates({ shape: square(0, 0, 10), allowRotate: false }, { rotationStep: 1 }), [0]);
  for (const rotationAngles of [null, [], [NaN], [Infinity], ['45'], '0,90']) assert.throws(() => rotationCandidates({ rotationAngles }));
  for (const rotationStep of [0, -1, 181, NaN, '15']) assert.throws(() => rotationCandidates({ shape: square(0, 0, 10) }, { rotationStep }));
  const oblique = { shape: normalizeShape({ outer: [[0, 0], [10, 3], [0, 10]] }) };
  const candidates = rotationCandidates(oblique, { rotationStep: 90 });
  assert.ok(candidates.some((angle) => Math.abs(angle - normalizeAngle(-Math.atan2(3, 10) * 180 / Math.PI)) < 1e-8), 'edge-aligned fractional angles should be explored');
  assert.ok(rotationCandidates({ shape: square(0, 0, 10) }).includes(15));
}

{
  // Independent integer-boolean cross-check, including rotated concave shapes
  // and holes. Ignore sub-grid slivers where coordinate rounding changes area.
  const shapes = [
    normalizeShape({ outer: square(0, 0, 20).outer, holes: [square(5, 5, 10).outer] }),
    normalizeShape({ outer: [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]] }),
    normalizeShape({ outer: [[0, 0], [25, 3], [9, 18], [3, 9]] }),
  ];
  let seed = 73491;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const paths = (shape) => [shape.outer, ...shape.holes].map((ring) => ring.map(([x, y]) => ({ X: Math.round(x * 10000), Y: Math.round(y * 10000) })));
  for (let sample = 0; sample < 180; sample += 1) {
    const first = transformShape(shapes[sample % shapes.length], random() * 360, random() * 30, random() * 30);
    const second = transformShape(shapes[(sample + 1) % shapes.length], random() * 360, random() * 30, random() * 30);
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(paths(first), ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(paths(second), ClipperLib.PolyType.ptClip, true);
    const result = new ClipperLib.Paths();
    clipper.Execute(ClipperLib.ClipType.ctIntersection, result, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    const area = Math.abs(result.reduce((sum, ring) => sum + ClipperLib.Clipper.Area(ring), 0)) / 1e8;
    const overlap = shapesOverlap(first, second);
    assert.equal(overlap, shapesOverlap(second, first), 'collision must be symmetric');
    if (area > 0.0001 || area === 0) assert.equal(overlap, area > 0, `boolean geometry disagrees on sample ${sample}`);
  }
}

console.log('polygon geometry tests passed');
