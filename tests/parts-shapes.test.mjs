import assert from 'node:assert/strict';
import { partsFromShapeJson, serializeShapeJson, parseCoordinateRing, parseRotationAngles, shapeFromEditor } from '../parts-shapes.mjs';
import { shapeArea } from '../polygon-geometry.mjs';

const shape = { outer: [[10, 20], [210, 20], [210, 220], [10, 220]], holes: [[[50, 60], [90, 60], [90, 100], [50, 100]]] };
const panels = [{ material: 'MDF', thickness: 18 }, { material: '白板', thickness: 12 }];
let count = 0;
const makeId = () => `import-${++count}`;
const record = { quantity: 2, thickness: 18, material: 'MDF', shape, allowRotate: true, code: '孔板', description: '保留内孔', rotationAngles: [0, 17.3, 360, -90] };

{
  const [part] = partsFromShapeJson(JSON.stringify({ version: 1, parts: [record] }), { panels, makeId });
  assert.equal(part.id, 'import-1');
  assert.equal(part.length, 200);
  assert.equal(part.width, 200);
  assert.equal(part.material, 'MDF');
  assert.equal(part.thickness, 18);
  assert.deepEqual(part.rotationAngles, [0, 17.3, 270]);
  assert.equal(shapeArea(part.shape), 38400, '进口轮廓应保留内孔净面积');
  assert.deepEqual(part.shape.outer[0], [0, 0], '轮廓应统一以包围框原点表示');
  const text = serializeShapeJson([part]);
  assert.equal(JSON.parse(text).parts[0].id, undefined, '导出不携带内部实例ID');
  const [roundtrip] = partsFromShapeJson(text, { panels, makeId });
  assert.notEqual(roundtrip.id, part.id);
  assert.deepEqual(roundtrip.shape, part.shape);
  assert.deepEqual(roundtrip.rotationAngles, part.rotationAngles);
  assert.equal(roundtrip.description, '保留内孔');
}

{
  const [part] = partsFromShapeJson({ version: 1, parts: [{ ...record, material: '不存在' }] }, { panels, makeId });
  assert.equal(part.material, '');
  assert.equal(part.thickness, '', '库存不匹配必须留空供用户处理');
  const [first] = partsFromShapeJson({ version: 1, parts: [{ ...record, material: undefined }] }, { panels, makeId });
  assert.equal(first.material, 'MDF');
  const [customFirst] = partsFromShapeJson({ version: 1, parts: [{ ...record, thickness: 12, material: '' }] }, { panels, material: '白板', makeId });
  assert.equal(customFirst.material, '白板', '默认材质应支持UI按标签顺序提供');
}

{
  const rect = { length: 120, width: 70, quantity: 1, thickness: 18, allowRotate: false };
  const [part] = partsFromShapeJson({ version: 1, parts: [rect] }, { panels, makeId });
  assert.equal(part.shape, undefined);
  assert.equal(part.rotationAngles, undefined);
  assert.equal(part.allowRotate, false);
  assert.equal(part.length, 120);
}

{
  for (const bad of [null, {}, { version: 2, parts: [record] }, { version: 1, parts: [] }, { version: 1, parts: [null] }]) {
    assert.throws(() => partsFromShapeJson(bad, { panels, makeId }));
  }
  for (const changes of [{ quantity: 0 }, { quantity: 1.5 }, { quantity: Number.MAX_SAFE_INTEGER + 1 }, { quantity: '2' }, { thickness: -1 }, { rotationAngles: [] }, { rotationAngles: null }, { rotationAngles: [NaN] }, { allowRotate: 'yes' }, { shape: { outer: [[0, 0], [20, 20], [0, 20], [20, 0]], holes: [] } }]) {
    assert.throws(() => partsFromShapeJson({ version: 1, parts: [record, { ...record, ...changes }] }, { panels, makeId }), /第 2 种零件/);
  }
  const before = structuredClone(record);
  partsFromShapeJson({ version: 1, parts: [record] }, { panels, makeId });
  assert.deepEqual(record, before, '导入不能修改输入对象');
}

{
  assert.deepEqual(parseCoordinateRing('0,0\n10，0\n0 10'), [[0, 0], [10, 0], [0, 10]]);
  assert.throws(() => parseCoordinateRing('0,0\n1,2,3\n2,1'), /第 2 行/);
  assert.throws(() => parseCoordinateRing('0,0\nInfinity,2\n2,1'), /坐标无效/);
  assert.equal(shapeFromEditor('', ''), undefined);
  assert.throws(() => shapeFromEditor('', '0,0\n1,0\n0,1'), /外轮廓/);
  const parsed = shapeFromEditor('0,0\n100,0\n100,100\n0,100', '10,10\n20,10\n20,20\n10,20\n\n30,30\n40,30\n40,40\n30,40');
  assert.equal(parsed.holes.length, 2);
  assert.equal(shapeArea(parsed), 9800);
  assert.deepEqual(parseRotationAngles('0, 17.3，90 -90;360'), [0, 17.3, 90, 270]);
  assert.equal(parseRotationAngles(' '), undefined);
  assert.throws(() => parseRotationAngles(null), /旋转角度/);
  assert.throws(() => parseRotationAngles('0,nope'));
}

console.log('parts shape JSON tests passed');
