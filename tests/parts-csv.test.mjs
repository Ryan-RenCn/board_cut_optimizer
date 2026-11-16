import assert from 'node:assert/strict';
import { parsePartsCsv, partsFromCsv, serializePartsCsv } from '../parts-csv.mjs';

const csv = '\uFEFF数量,长度,宽度,厚度\r\n2,720,560,18\r\n1,400,300,25';
assert.deepEqual(parsePartsCsv(csv), [
  { 数量: '2', 长度: '720', 宽度: '560', 厚度: '18' },
  { 数量: '1', 长度: '400', 宽度: '300', 厚度: '25' },
]);

let id = 0;
const parts = partsFromCsv(csv, {
  material: '胡桃木',
  thicknesses: [9, 18],
  makeId: () => `part-${id += 1}`,
});
assert.deepEqual(parts, [
  { id: 'part-1', quantity: 2, length: 720, width: 560, thickness: 18, material: '胡桃木', allowRotate: true, code: '', description: '' },
  { id: 'part-2', quantity: 1, length: 400, width: 300, thickness: '', material: '', allowRotate: true, code: '', description: '' },
]);

assert.equal(
  serializePartsCsv(parts),
  '\uFEFF数量,长度,宽度,厚度\r\n2,720,560,18\r\n1,400,300,',
);

assert.throws(
  () => parsePartsCsv('数量,长度,宽度,厚度,材质\n1,100,100,18,胡桃木'),
  /CSV 表头必须为：数量、长度、宽度、厚度/,
);

for (const quantity of ['1.5', '-1', '', 'NaN', 'Infinity', 'text', '9007199254740992']) {
  assert.throws(() => partsFromCsv(`数量,长度,宽度,厚度\n2,100,100,18\n${quantity},100,100,18`), /第 2 种零件.*数量.*整数/);
}
assert.deepEqual(partsFromCsv('数量,长度,宽度,厚度\n0,100,100,18').map(part => part.quantity), [0]);

console.log('parts CSV tests passed');
