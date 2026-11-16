export const PARTS_CSV_HEADERS = ['数量', '长度', '宽度', '厚度'];

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseRows(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value.trim());
      value = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else {
      value += char;
    }
  }

  if (quoted) throw new Error('CSV 中存在未闭合的双引号');
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parsePartsCsv(text) {
  const rows = parseRows(text);
  if (rows.length < 2) throw new Error('CSV 中没有可导入的零件数据');

  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, ''));
  const validHeaders = headers.length === PARTS_CSV_HEADERS.length
    && headers.every((header, index) => header === PARTS_CSV_HEADERS[index]);
  if (!validHeaders) throw new Error(`CSV 表头必须为：${PARTS_CSV_HEADERS.join('、')}`);

  return rows.slice(1).map((values) => Object.fromEntries(
    PARTS_CSV_HEADERS.map((header, index) => [header, values[index] ?? '']),
  ));
}

export function partsFromCsv(text, { material = '', thicknesses = [], makeId = () => undefined } = {}) {
  return parsePartsCsv(text).map((record, index) => {
    const quantity = Number(record['数量']);
    if (!record['数量'].trim() || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error(`第 ${index + 1} 种零件的数量必须为有效的非负整数`);
    }
    const importedThickness = Number(record['厚度']);
    const hasMatchingThickness = Number.isFinite(importedThickness)
      && importedThickness > 0
      && thicknesses.some((thickness) => Math.abs(Number(thickness) - importedThickness) < 0.0001);
    const numericValue = (field, fallback = 0) => Number.isFinite(Number(record[field]))
      ? Number(record[field])
      : fallback;

    return {
      id: makeId(),
      quantity,
      length: numericValue('长度'),
      width: numericValue('宽度'),
      thickness: hasMatchingThickness ? importedThickness : '',
      material: hasMatchingThickness ? material : '',
      allowRotate: true,
      code: '',
      description: '',
    };
  });
}

export function serializePartsCsv(parts) {
  const rows = [PARTS_CSV_HEADERS];
  parts.forEach((part) => rows.push([
    part.quantity,
    part.length,
    part.width,
    part.thickness,
  ]));
  return `\uFEFF${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}`;
}
