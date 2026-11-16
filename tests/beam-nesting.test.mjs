import assert from 'node:assert/strict';
import { fillRectangleSheet } from '../beam-nesting.mjs';

const panel = { length: 100, width: 100 };
const makeParts = (sizes) => sizes.map(([length, width], index) => ({ instanceId: `part-${index}`, length, width, allowRotate: true }));

function assertGeometry(result, sheet, settings = {}) {
  const kerf = settings.sawWidth ?? 0;
  const marginX = settings.panelMarginX ?? 0;
  const marginY = settings.panelMarginY ?? 0;
  const ids = result.placements.map((part) => part.instanceId);
  assert.equal(new Set(ids).size, ids.length, '零件实例不可重复放置');
  assert.equal(result.usedArea, result.placements.reduce((sum, part) => sum + part.length * part.width, 0));
  for (const part of result.placements) {
    assert.ok(part.x >= marginX - 0.0001 && part.y >= marginY - 0.0001);
    assert.ok(part.x + part.placedLength <= sheet.length - marginX + 0.0001);
    assert.ok(part.y + part.placedWidth <= sheet.width - marginY + 0.0001);
    assert.equal(part.placedLength, part.rotated ? part.width : part.length);
    assert.equal(part.placedWidth, part.rotated ? part.length : part.width);
    if (settings.allowRotation === false || part.allowRotate === false) assert.equal(part.rotated, false);
  }
  for (let first = 0; first < result.placements.length; first += 1) {
    for (let second = first + 1; second < result.placements.length; second += 1) {
      const a = result.placements[first];
      const b = result.placements[second];
      assert.ok(Math.max(
        b.x - a.x - a.placedLength, a.x - b.x - b.placedLength,
        b.y - a.y - a.placedWidth, a.y - b.y - b.placedWidth,
      ) >= kerf - 0.0001, '任何两个零件应留足锯缝');
    }
  }
  for (const rect of result.freeRects) {
    assert.ok(rect.w > 0 && rect.h > 0);
    assert.ok(rect.x >= marginX - 0.0001 && rect.y >= marginY - 0.0001);
    assert.ok(rect.x + rect.w <= sheet.length - marginX + 0.0001);
    assert.ok(rect.y + rect.h <= sheet.width - marginY + 0.0001);
    for (const part of result.placements) {
      assert.ok(rect.x + rect.w <= part.x + 0.0001 || part.x + part.placedLength <= rect.x + 0.0001
        || rect.y + rect.h <= part.y + 0.0001 || part.y + part.placedWidth <= rect.y + 0.0001,
      '展示余料不可覆盖已放零件');
    }
  }
}

{
  const parts = makeParts([[50, 100], [47, 100]]);
  const settings = { sawWidth: 3 };
  const result = fillRectangleSheet(panel, parts, settings);
  assert.equal(result.placements.length, 2, '边缘允许精确贴合，零件间仍有3mm锯缝');
  assertGeometry(result, panel, settings);
  assert.deepEqual(result, fillRectangleSheet(panel, parts, settings), '相同输入应得到确定性结果');
}

{
  const parts = makeParts([[80, 40]]);
  const sheet = { length: 40, width: 80 };
  assert.equal(fillRectangleSheet(sheet, parts).placements[0].rotated, true);
  assert.equal(fillRectangleSheet(sheet, parts, { allowRotation: false }).placements.length, 0, '全局禁转必须生效');
  parts[0].allowRotate = false;
  assert.equal(fillRectangleSheet(sheet, parts).placements.length, 0, '单件禁转必须生效');
}

{
  const parts = makeParts([[200, 200], [210, 210], [220, 220], [230, 230], [240, 240], [250, 250], [40, 40]]);
  const result = fillRectangleSheet(panel, parts, { candidateLimit: 2 });
  assert.deepEqual(result.placements.map((part) => part.instanceId), ['part-6'], '候选窗口中的大件放不下时应继续寻找后面的小件');
}

{
  const parts = makeParts(Array.from({ length: 8 }, () => [20, 20]));
  const result = fillRectangleSheet(panel, parts, { maxExpandedStates: 1, sawWidth: 2 });
  assert.equal(result.diagnostics.limited, true, '耗尽搜索预算应明确标记');
  assert.ok(result.diagnostics.expandedStates <= 1);
  assert.equal(result.placements.length, 8, '耗尽预算后应继续贪心填充全部零件');
  assertGeometry(result, panel, { sawWidth: 2 });
}

{
  const parts = makeParts(Array.from({ length: 65 }, () => [10, 10]));
  const frozenParts = structuredClone(parts);
  const result = fillRectangleSheet(panel, parts, { maxSearchParts: 60 });
  assert.equal(result.diagnostics.limited, true);
  assert.equal(result.diagnostics.expandedStates, 0, '超出数量上限应直接使用贪心续填');
  assert.equal(result.placements.length, 65, '数量上限不可导致尾部零件被截断');
  assert.deepEqual(parts, frozenParts, '排版不可修改输入');
  assertGeometry(result, panel);
}

{
  const parts = makeParts([[20, 40], [10, 10], [10, 50], [40, 10], [60, 60], [10, 10], [40, 40], [60, 70]]);
  const greedy = fillRectangleSheet(panel, parts, { beamWidth: 1, maxExpandedStates: 100000 });
  const beam = fillRectangleSheet(panel, parts, { beamWidth: 4, maxExpandedStates: 100000 });
  assert.ok(beam.usedArea > greedy.usedArea, '保留多个中间方案应在此样例排入更多面积');
  assert.equal(greedy.usedArea, 7100);
  assert.equal(beam.usedArea, 7700);
  assert.ok(beam.diagnostics.expandedStates > greedy.diagnostics.expandedStates, '束宽增加应实际探索更多候选');
  assertGeometry(beam, panel);
}

{
  assert.equal(fillRectangleSheet(panel, []).placements.length, 0);
  assert.equal(fillRectangleSheet(panel, makeParts([[10, 10]]), { panelMarginX: 60 }).placements.length, 0);
  let seed = 173;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let sample = 0; sample < 24; sample += 1) {
    const parts = makeParts(Array.from({ length: 12 }, () => [10 + Math.floor(random() * 65), 10 + Math.floor(random() * 65)]));
    parts.forEach((part, index) => { part.allowRotate = index % 3 !== 0; });
    const settings = { sawWidth: sample % 3, panelMarginX: sample % 2, panelMarginY: sample % 4, maxExpandedStates: 1500 };
    const result = fillRectangleSheet(panel, parts, settings);
    assertGeometry(result, panel, settings);
    assert.ok(result.diagnostics.expandedStates <= 1500);
  }
}

console.log('beam nesting tests passed');
