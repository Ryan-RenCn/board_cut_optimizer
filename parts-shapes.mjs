import { normalizeShape, shapeBounds, normalizeAngle } from './polygon-geometry.mjs';

export function parseRotationAngles(value) {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return undefined;
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.trim().split(/[,，;；\s]+/) : null;
  if (!values?.length || values.length > 360) throw new Error('旋转角度须填写 1–360 个有效数字');
  const angles = values.map((entry) => {
    if ((typeof entry !== 'number' && typeof entry !== 'string') || String(entry).trim() === ''
      || !Number.isFinite(Number(entry))) throw new Error('旋转角度须为有限数字，例如 0, 17.3, 90');
    return normalizeAngle(Number(entry));
  });
  return [...new Set(angles)];
}

export function parseCoordinateRing(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error('每个轮廓至少需要三个顶点，每行填写 x,y');
  return lines.map((line, index) => {
    const pair = line.split(/[,，\s]+/);
    if (pair.length !== 2 || pair.some((number) => !number.trim() || !Number.isFinite(Number(number)))) {
      throw new Error(`第 ${index + 1} 行坐标无效，请填写 x,y`);
    }
    return pair.map(Number);
  });
}

export function shapeFromEditor(outerText, holesText = '', { maxVertices = 256 } = {}) {
  if (!String(outerText ?? '').trim()) {
    if (String(holesText ?? '').trim()) throw new Error('请先填写外轮廓，再填写内孔');
    return undefined;
  }
  const outer = parseCoordinateRing(outerText);
  const holes = String(holesText ?? '').trim()
    ? String(holesText).trim().split(/\r?\n\s*\r?\n/).map(parseCoordinateRing)
    : [];
  return normalizeShape({ outer, holes }, { maxVertices });
}

const materialKey = (value) => String(value ?? '').trim().toLocaleLowerCase();
function copyCadSource(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CAD 来源信息必须为对象');
  const text = JSON.stringify(value);
  if (text.length > 20000) throw new Error('CAD 来源信息过大');
  return JSON.parse(text);
}
const numericField = (value, name, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name}必须是有效的${integer ? '正整数' : '正数'}`);
  }
  return value;
};

export function partsFromShapeJson(text, { panels = [], material = panels[0]?.material ?? '', makeId = () => undefined, maxVertices = 256 } = {}) {
  const value = typeof text === 'string' ? JSON.parse(text.replace(/^\uFEFF/, '')) : text;
  if (!value || value.version !== 1 || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > 10000) {
    throw new Error('轮廓 JSON 格式应为 {"version":1,"parts":[...]}，且包含 1–10000 种零件');
  }
  const firstMaterial = material;
  return value.parts.map((record, index) => {
    try {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('零件记录必须为对象');
      const quantity = numericField(record.quantity, '数量', true);
      const importedThickness = numericField(record.thickness, '厚度');
      const shape = record.shape === undefined ? undefined : normalizeShape(record.shape, { maxVertices });
      const bounds = shape ? shapeBounds(shape) : null;
      const length = bounds ? bounds.width : numericField(record.length, '长度');
      const width = bounds ? bounds.height : numericField(record.width, '宽度');
      const rotationAngles = parseRotationAngles(record.rotationAngles);
      if (record.allowRotate !== undefined && typeof record.allowRotate !== 'boolean') throw new Error('允许旋转必须为 true 或 false');
      const requestedMaterial = typeof record.material === 'string' && record.material.trim() ? record.material.trim() : firstMaterial;
      const match = panels.find((panel) => materialKey(panel.material) === materialKey(requestedMaterial)
        && Math.abs(Number(panel.thickness) - importedThickness) < 0.0001);
      const part = {
        id: makeId(), quantity, length, width,
        material: match ? String(match.material ?? '') : '', thickness: match ? importedThickness : '',
        allowRotate: record.allowRotate !== false,
        code: typeof record.code === 'string' ? record.code : '',
        description: typeof record.description === 'string' ? record.description : '',
      };
      if (shape) part.shape = shape;
      if (rotationAngles) part.rotationAngles = rotationAngles;
      if (record.cadSource !== undefined) part.cadSource = copyCadSource(record.cadSource);
      return part;
    } catch (error) {
      throw new Error(`第 ${index + 1} 种零件：${error.message}`);
    }
  });
}

export function serializeShapeJson(parts, { maxVertices = 256 } = {}) {
  return JSON.stringify({ version: 1, parts: parts.map((part) => {
    const record = { quantity: part.quantity, length: part.length, width: part.width, thickness: part.thickness,
      material: part.material, allowRotate: part.allowRotate !== false, code: part.code ?? '', description: part.description ?? '' };
    if (part.shape !== undefined) record.shape = normalizeShape(part.shape, { maxVertices });
    const rotationAngles = parseRotationAngles(part.rotationAngles);
    if (rotationAngles) record.rotationAngles = rotationAngles;
    if (part.cadSource !== undefined) record.cadSource = copyCadSource(part.cadSource);
    return record;
  }) }, null, 2);
}
