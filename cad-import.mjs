// Offline ASCII DXF geometry import. Unsupported manufacturing geometry fails
// the entire import rather than silently disappearing from the cutting outline.
import DxfParser from './vendor/dxf-parser.mjs';
import { normalizeShape, shapeBounds } from './polygon-geometry.mjs';

const EPS = 1e-7;
const TAU = 2 * Math.PI;
const GEOMETRY = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE', 'ELLIPSE', 'SPLINE', 'INSERT']);
const ANNOTATIONS = new Set(['TEXT', 'MTEXT', 'DIMENSION', 'HATCH', 'POINT', 'ATTRIB', 'ATTDEF', 'LEADER', 'VIEWPORT', 'SOLID']);
const finite = (value, label) => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须为有限数字`); return value; };
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const close = (a, b, tolerance = EPS) => distance(a, b) <= tolerance;
const identity = [1, 0, 0, 1, 0, 0];
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const compose = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const area = (ring) => Math.abs(ring.reduce((sum, p, index) => { const q = ring[(index + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

function preflight(text, solidMode, previewOnly = false) {
  const records=[];
  let currentRecord,polylineRecord;
  const refuse=message=>{if(!previewOnly)throw new Error(message);if(currentRecord)currentRecord.issue=message;};
  if (typeof text !== 'string' || text.length > 10 * 1024 * 1024) throw new Error('DXF文本必须小于10 MB');
  if (/^AutoCAD Binary DXF|^AC10/.test(text) || text.includes('\u0000')) throw new Error('仅支持ASCII DXF文本，不支持DWG或二进制DXF；请先另存为ASCII DXF');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length % 2) throw new Error('DXF组码和值不成对，文件可能不完整');
  const pairs = [];
  for (let index = 0; index < lines.length; index += 2) {
    if (!/^\s*\d+\s*$/.test(lines[index])) throw new Error(`DXF第${index + 1}行组码无效`);
    pairs.push([Number(lines[index]), lines[index + 1].trim()]);
  }
  if (!pairs.some(([code, value]) => code === 0 && value === 'EOF')) throw new Error('DXF缺少EOF结束标记');
  let section = '';
  let inPolyline = false;
  let inBlock = false;
  let entities = 0;
  const annotations = new Set();
  for (let index = 0; index < pairs.length; index += 1) {
    const [code, value] = pairs[index];
    if (code !== 0) continue;
    if (inPolyline && value !== 'VERTEX' && value !== 'SEQEND') throw new Error('POLYLINE必须由VERTEX序列和SEQEND结束，文件结构不完整');
    if (value === 'SECTION') {
      if (section || pairs[index + 1]?.[0] !== 2) throw new Error('DXF的SECTION结构无效');
      section = pairs[index + 1][1]; continue;
    }
    if (value === 'ENDSEC') { if (!section || inBlock) throw new Error('DXF区段或块未正确结束'); section = ''; continue; }
    if (value === 'EOF') { if (section || inBlock || index !== pairs.length - 1) throw new Error('DXF结束位置无效'); continue; }
    if (value === 'BLOCK' && section === 'BLOCKS') { if (inBlock) throw new Error('DXF块定义嵌套无效'); inBlock = true; }
    if (value === 'ENDBLK' && section === 'BLOCKS') { if (!inBlock) throw new Error('DXF块结束标记无效'); inBlock = false; }
    if (value === 'POLYLINE' && ['ENTITIES', 'BLOCKS'].includes(section)) inPolyline = true;
    else if (value === 'VERTEX' && !inPolyline) throw new Error('VERTEX缺少所属POLYLINE');
    else if (value === 'SEQEND') inPolyline = false;
    if(['ENTITIES','BLOCKS'].includes(section)&&!['BLOCK','ENDBLK','VERTEX','SEQEND'].includes(value)){
      const groups=[];for(let next=index+1;next<pairs.length&&pairs[next][0]!==0;next++)groups.push(pairs[next]);
      currentRecord={type:value,groups};records.push(currentRecord);if(value==='POLYLINE')polylineRecord=currentRecord;
    }else if(value==='VERTEX')currentRecord=polylineRecord;
    if (['POLYLINE', 'LWPOLYLINE', 'VERTEX'].includes(value)) {
      for (let next = index + 1; next < pairs.length && pairs[next][0] !== 0; next += 1) {
        const [c, v] = pairs[next];
        if ([40, 41, 43].includes(c) && Number(v) !== 0) refuse('不支持带线宽的多段线，请先转换为明确闭合边界');
        if (value === 'POLYLINE' && c === 30 && Number(v) !== 0) refuse('旧POLYLINE的非零高程不支持，请先投影到XY平面');
      }
    }
    if (!['ENTITIES', 'BLOCKS'].includes(section) || ['BLOCK', 'ENDBLK', 'VERTEX', 'SEQEND'].includes(value)) continue;
    if (++entities > 10000) throw new Error('DXF实体超过10000项，请拆分图纸');
    if (!GEOMETRY.has(value) && !ANNOTATIONS.has(value)) refuse(`不支持的CAD图元 ${value}`);
    if (ANNOTATIONS.has(value)) annotations.add(value);
    const record = [];
    for (let next = index + 1; next < pairs.length && pairs[next][0] !== 0; next += 1) record.push(pairs[next]);
    if (value === 'SPLINE' && (record.some(([c, v]) => c === 41) || record.some(([c, v]) => c === 70 && (Number(v) & 4)))) refuse('暂不支持带权重的有理SPLINE；请先转为非有理曲线或多段线');
    if (GEOMETRY.has(value) || value === 'SOLID' && solidMode === 'outline') {
      for (const [c, v] of record) {
        if ([210, 220, 230].includes(c) && (!Number.isFinite(Number(v)) || Math.abs(Number(v) - (c === 230 ? 1 : 0)) > EPS)) refuse('仅支持XY平面默认法向的CAD轮廓，请先投影到XY平面');
        if ([39].includes(c) && Math.abs(Number(v)) > EPS) refuse('不支持带拉伸厚度的3D图元，请先转为二维轮廓');
      }
    }
  }
  if (section || inPolyline || inBlock) throw new Error('DXF区段、块或多段线未正确结束');
  return { entities, annotations, records };
}

const UNIT_CODES = { 1: ['inch', 25.4], 2: ['foot', 304.8], 4: ['mm', 1], 5: ['cm', 10], 6: ['m', 1000], 7: ['km', 1000000], 9: ['mil', 0.0254], 10: ['yard', 914.4], 13: ['micron', 0.001], 14: ['dm', 100] };
function units(header, override, warn) {
  const aliases = { mm: 1, cm: 10, m: 1000, inch: 25.4, in: 25.4, foot: 304.8, ft: 304.8 };
  if (override !== undefined && override !== '') {
    if (typeof override !== 'string' || aliases[override.toLowerCase()] === undefined) throw new Error('CAD单位覆盖仅支持mm/cm/m/inch/foot');
    return { unit: override.toLowerCase(), scale: aliases[override.toLowerCase()], overridden: true };
  }
  const code = header?.$INSUNITS ?? 0;
  if (code === 0) { warn('图纸未声明单位，按毫米导入；请核对预览尺寸，必要时选择单位重新导入。'); return { unit: 'mm', scale: 1, assumed: true }; }
  if (!UNIT_CODES[code]) throw new Error(`暂不支持DXF单位代码${code}，请明确选择导入单位`);
  return { unit: UNIT_CODES[code][0], scale: UNIT_CODES[code][1], overridden: false };
}

function point(value, context, elevation) {
  if (!value) throw new Error('CAD图元缺少坐标点');
  const z = finite(value.z ?? elevation ?? 0, 'Z坐标');
  if (context.plane === undefined) context.plane = z;
  if (Math.abs(z - context.plane) > EPS) throw new Error('CAD轮廓不在同一XY平面，请先投影为二维图纸');
  return [finite(value.x, 'X坐标'), finite(value.y, 'Y坐标')];
}

function segmentCount(radius, sweep, matrix, tolerance, maxVertices) {
  // Frobenius norm bounds the maximum stretch, including sheared nested INSERTs.
  const stretch = Math.hypot(matrix[0], matrix[1], matrix[2], matrix[3]);
  const r = Math.abs(radius) * stretch;
  const maximum = r > tolerance ? 2 * Math.acos(Math.max(-1, 1 - tolerance / r)) : Math.PI / 2;
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / Math.min(Math.PI / 2, maximum)));
  if (!Number.isFinite(count) || count > maxVertices) throw new Error(`曲线按当前弦误差离散后超过${maxVertices}点，请增大曲线容差、提高全局顶点上限或拆分轮廓`);
  return count;
}

function sampleAngles(start, sweep, n, critical = [], maxVertices) {
  const fractions = Array.from({ length: n + 1 }, (_, i) => i / n);
  for (const angle of critical) {
    const distance = sweep > 0 ? ((angle - start) % TAU + TAU) % TAU : ((start - angle) % TAU + TAU) % TAU;
    if (distance <= Math.abs(sweep) + 1e-12) fractions.push(distance / Math.abs(sweep));
  }
  const result = [...new Set(fractions.map((v) => Math.round(v * 1e12) / 1e12))].sort((a, b) => a - b).map((v) => start + sweep * v);
  if (result.length > maxVertices + 1) throw new Error(`曲线含极值点后超过${maxVertices}点，请增大曲线容差或提高全局顶点上限`);
  return result;
}

function arcPoints(center, radius, start, sweep, matrix, tolerance, maxVertices) {
  if (!(finite(radius, '圆弧半径') > 0) || !Number.isFinite(start) || !Number.isFinite(sweep) || Math.abs(sweep) < 1e-12 || Math.abs(sweep) > TAU + EPS) throw new Error('圆弧参数无效');
  const n = segmentCount(radius, sweep, matrix, tolerance, maxVertices);
  const critical = [Math.atan2(matrix[2], matrix[0]), Math.atan2(matrix[3], matrix[1])];
  return sampleAngles(start, sweep, n, critical.flatMap((a) => [a, a + Math.PI]), maxVertices).map((angle) => apply(matrix, [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]));
}

function bulgePoints(a, b, bulge, matrix, tolerance, maxVertices) {
  if (!bulge) return [apply(matrix, a), apply(matrix, b)];
  finite(bulge, '多段线bulge');
  const chord = distance(a, b);
  if (chord <= EPS) throw new Error('圆弧多段线存在重复端点');
  const sweep = 4 * Math.atan(bulge);
  const offset = chord * (1 - bulge * bulge) / (4 * bulge);
  const center = [(a[0] + b[0]) / 2 - (b[1] - a[1]) * offset / chord, (a[1] + b[1]) / 2 + (b[0] - a[0]) * offset / chord];
  const result = arcPoints(center, chord * (1 + bulge * bulge) / (4 * Math.abs(bulge)), Math.atan2(a[1] - center[1], a[0] - center[0]), sweep, matrix, tolerance, maxVertices);
  result[0] = apply(matrix, a); result[result.length - 1] = apply(matrix, b);
  return result;
}

function distanceToLine(p, a, b) {
  const length = distance(a, b);
  if (!length) return distance(p, a);
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (length * length)));
  return distance(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

function sampleBezier(controls, tolerance, output, maxVertices, depth = 0) {
  if (controls.slice(1, -1).every((p) => distanceToLine(p, controls[0], controls.at(-1)) <= tolerance)) {
    output.push(controls.at(-1));
    if (output.length > maxVertices + 1) throw new Error(`SPLINE离散超过${maxVertices}点，请增大曲线容差或提高全局顶点上限`);
    return;
  }
  if (depth >= 20) throw new Error('SPLINE在当前容差下无法安全离散');
  const left = [controls[0]], right = [controls.at(-1)];
  let row = controls;
  while (row.length > 1) { row = row.slice(1).map((p, i) => [(row[i][0] + p[0]) / 2, (row[i][1] + p[1]) / 2]); left.push(row[0]); right.push(row.at(-1)); }
  sampleBezier(left, tolerance, output, maxVertices, depth + 1); sampleBezier(right.reverse(), tolerance, output, maxVertices, depth + 1);
}

function deBoor(t, controls, degree, knots, span) {
  const d = Array.from({ length: degree + 1 }, (_, j) => [...controls[span - degree + j]]);
  for (let r = 1; r <= degree; r += 1) for (let j = degree; j >= r; j -= 1) {
    const lower = knots[span - degree + j], upper = knots[span + 1 + j - r];
    const alpha = upper === lower ? 0 : (t - lower) / (upper - lower);
    d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1]];
  }
  return d[degree];
}

function splinePoints(entity, matrix, context) {
  if (entity.rational) throw new Error('暂不支持有理SPLINE，请先转为多段线');
  const degree = entity.degreeOfSplineCurve;
  const controls = entity.controlPoints?.map((p) => apply(matrix, point(p, context)));
  const knots = entity.knotValues;
  if (![1, 2, 3].includes(degree) || !controls || controls.length < degree + 1 || controls.length > context.maxVertices || !Array.isArray(knots) || knots.length !== controls.length + degree + 1
    || knots.some((v, i) => !Number.isFinite(v) || i && v < knots[i - 1]) || !(knots[controls.length] > knots[degree])) throw new Error('仅支持具有完整控制点及节点向量的1–3次非有理SPLINE');
  const derivative = controls.slice(1).map((p, i) => {
    const denominator = knots[i + degree + 1] - knots[i + 1];
    return denominator ? [(p[0] - controls[i][0]) * degree / denominator, (p[1] - controls[i][1]) * degree / denominator] : [0, 0];
  });
  const result = [];
  for (let span = degree; span < controls.length; span += 1) {
    const start = knots[span], end = knots[span + 1];
    if (end <= start) continue;
    const a = deBoor(start, controls, degree, knots, span), b = deBoor(end, controls, degree, knots, span);
    if (result.length && !close(result.at(-1), a)) throw new Error('SPLINE存在不连续节点，无法形成可靠轮廓');
    if (!result.length) result.push(a);
    const dt = end - start;
    const da = deBoor(start, derivative, degree - 1, knots.slice(1, -1), span - 1);
    const db = deBoor(end, derivative, degree - 1, knots.slice(1, -1), span - 1);
    const bezier = degree === 1 ? [a, b] : degree === 2 ? [a, [a[0] + da[0] * dt / 2, a[1] + da[1] * dt / 2], b]
      : [a, [a[0] + da[0] * dt / 3, a[1] + da[1] * dt / 3], [b[0] - db[0] * dt / 3, b[1] - db[1] * dt / 3], b];
    sampleBezier(bezier, context.curveTolerance, result, context.maxVertices);
  }
  return result;
}

function entityPath(entity, matrix, context) {
  const type = entity.type;
  const p = (value) => point(value, context, entity.elevation);
  if(type === 'SOLID') {
    if(!Array.isArray(entity.points) || entity.points.length<3 || entity.points.length>4 || Array.from(entity.points).some(v=>!v))throw new Error('SOLID缺少有效的三角形或四边形顶点');
    const vertices=entity.points.map(p);
    const ring=vertices.length===3 || close(vertices[2],vertices[3]) ? vertices.slice(0,3) : [vertices[0],vertices[1],vertices[3],vertices[2]];
    return {points:ring.map(v=>apply(matrix,v)),closed:true};
  }
  if (type === 'LINE') {
    if (entity.vertices?.length !== 2) throw new Error('LINE必须有两个端点');
    return { points: entity.vertices.map((v) => apply(matrix, p(v))), closed: false };
  }
  if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
    if (entity.is3dPolyline || entity.is3dPolygonMesh || entity.isPolyfaceMesh || entity.includesCurveFitVertices || entity.includesSplineFitVertices) throw new Error('暂不支持3D/拟合POLYLINE，请先转换为二维普通多段线');
    const vertices = entity.vertices;
    if (!Array.isArray(vertices) || vertices.length < 2 || vertices.length > context.maxVertices) throw new Error(`多段线顶点数必须在2–${context.maxVertices}之间`);
    if (entity.width || vertices.some((v) => v.startWidth || v.endWidth)) context.warn('多段线线宽已忽略，按中心线轮廓导入。');
    const result = [];
    const count = entity.shape ? vertices.length : vertices.length - 1;
    for (let i = 0; i < count; i += 1) {
      const segment = bulgePoints(p(vertices[i]), p(vertices[(i + 1) % vertices.length]), vertices[i].bulge ?? 0, matrix, context.curveTolerance, context.maxVertices);
      result.push(...(result.length ? segment.slice(1) : segment));
      if (result.length > context.maxVertices + 1) throw new Error(`多段线离散超过${context.maxVertices}点，请增大曲线容差或提高全局顶点上限`);
    }
    return { points: result, closed: Boolean(entity.shape) };
  }
  if (type === 'CIRCLE' || type === 'ARC') {
    const start = type === 'CIRCLE' ? 0 : finite(entity.startAngle, '圆弧起角');
    let sweep = type === 'CIRCLE' ? TAU : finite(entity.endAngle, '圆弧终角') - start;
    if (sweep < 0) sweep += TAU;
    return { points: arcPoints(p(entity.center), entity.radius, start, sweep, matrix, context.curveTolerance, context.maxVertices), closed: type === 'CIRCLE' };
  }
  if (type === 'ELLIPSE') {
    const center = p(entity.center), axis = point(entity.majorAxisEndPoint, { ...context, plane: 0 });
    const ratio = finite(entity.axisRatio, '椭圆轴比');
    if (!(ratio > 0 && ratio <= 1) || Math.hypot(...axis) <= EPS) throw new Error('椭圆主轴或轴比无效');
    const start = finite(entity.startAngle ?? 0, '椭圆起角');
    let sweep = finite(entity.endAngle ?? TAU, '椭圆终角') - start;
    if (sweep < 0) sweep += TAU;
    if (!(sweep > EPS && sweep <= TAU + EPS)) throw new Error('椭圆弧角度无效');
    const n = segmentCount(Math.hypot(...axis), sweep, matrix, context.curveTolerance, context.maxVertices);
    const ac = [matrix[0] * axis[0] + matrix[2] * axis[1], matrix[1] * axis[0] + matrix[3] * axis[1]];
    const bs = [ratio * (-matrix[0] * axis[1] + matrix[2] * axis[0]), ratio * (-matrix[1] * axis[1] + matrix[3] * axis[0])];
    const critical = [Math.atan2(bs[0], ac[0]), Math.atan2(bs[1], ac[1])];
    const points = sampleAngles(start, sweep, n, critical.flatMap((a) => [a, a + Math.PI]), context.maxVertices).map((t) => {
      return apply(matrix, [center[0] + axis[0] * Math.cos(t) - axis[1] * ratio * Math.sin(t), center[1] + axis[1] * Math.cos(t) + axis[0] * ratio * Math.sin(t)]);
    });
    return { points, closed: Math.abs(sweep - TAU) < EPS };
  }
  if (type === 'SPLINE') {
    const points = splinePoints(entity, matrix, context);
    if ((entity.closed || entity.periodic) && !close(points[0], points.at(-1), context.joinTolerance)) throw new Error('闭合SPLINE的首尾不相接，请先转换为闭合多段线');
    return { points, closed: Boolean(entity.closed || entity.periodic) };
  }
  throw new Error(`不支持CAD图元 ${type}`);
}

function grayEntity(entity,matrix,context,layer,reason,blocking=true) {
  let points=[];
  try{points=entityPath(entity,matrix,{...context,plane:undefined,maxVertices:4096,curveTolerance:Math.max(.5,context.curveTolerance)}).points;}catch{
    let raw=entity.vertices??entity.points??entity.controlPoints??entity.fitPoints;
    if(!raw?.length){raw=[];const groups=entity._previewRecord?.groups??[];for(let i=0;i<groups.length;i++){const [c,x]=groups[i];if(c>=10&&c<=18){const y=groups.slice(i+1).find(([code])=>code===c+10)?.[1];if(y!==undefined)raw.push({x:Number(x),y:Number(y)});}}}
    points=(raw??[]).filter(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)).map(p=>apply(matrix,[p.x,p.y]));
  }
  points=points.filter(p=>p.every(Number.isFinite)&&p.every(v=>Math.abs(v)<=1e6)).slice(0,Math.min(4096,Math.max(0,100000-(context.previewPoints??0))));
  context.previewPoints=(context.previewPoints??0)+points.length;
  context.unresolved.push({type:entity.type,points,closed:false,layer,reason,blocking});
}

function expandEntities(entities, blocks, matrix, context, stack = [], layer = '') {
  for (const entity of entities ?? []) {
    if (++context.expanded > 10000) throw new Error('展开后的CAD实体超过10000项，请拆分图纸');
    const currentLayer = !entity.layer || entity.layer === '0' ? layer || '0' : entity.layer;
    if (ANNOTATIONS.has(entity.type) && !(entity.type==='SOLID' && context.solidMode==='outline')) {if(context.previewOnly)grayEntity(entity,matrix,context,currentLayer,'填充或标注，不作为加工零件',false);continue;}
    if(context.previewOnly && entity._previewRecord?.issue){grayEntity(entity,matrix,context,currentLayer,entity._previewRecord.issue);continue;}
    const oldPlane=context.plane;
    try {
    if (entity.type === 'INSERT') {
      if (stack.length >= 16 || stack.includes(entity.name)) throw new Error('CAD块存在循环引用或嵌套超过16层');
      const block = Object.hasOwn(blocks, entity.name) ? blocks[entity.name] : null;
      if (!block) throw new Error(`找不到INSERT引用的块 ${entity.name}`);
      const sx = finite(entity.xScale ?? 1, '块X缩放'), sy = finite(entity.yScale ?? 1, '块Y缩放');
      if (!sx || !sy || Math.abs(sx) > 1e6 || Math.abs(sy) > 1e6) throw new Error('块缩放参数无效');
      const angle = finite(entity.rotation ?? 0, '块旋转角') * Math.PI / 180;
      const insertion = point(entity.position ?? { x: 0, y: 0 }, context);
      const base = [finite(block.position?.x ?? 0, '块基点X'), finite(block.position?.y ?? 0, '块基点Y')];
      const columns = entity.columnCount ?? 1, rows = entity.rowCount ?? 1;
      if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > 1000) throw new Error('块阵列数量无效或超过1000');
      const rotation = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), insertion[0], insertion[1]];
      for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
        const local = compose(rotation, [sx, 0, 0, sy, -base[0] * sx + column * finite(entity.columnSpacing ?? 0, '阵列列间距'), -base[1] * sy + row * finite(entity.rowSpacing ?? 0, '阵列行间距')]);
        expandEntities(block.entities, blocks, compose(matrix, local), context, [...stack, entity.name], currentLayer);
      }
      continue;
    }
    const path = entityPath(entity, matrix, context);
    path.layer = currentLayer;
    if (path.points.length < 2 || path.points.some((v) => !v.every(Number.isFinite) || v.some((coordinate) => Math.abs(coordinate) > 1e6))) throw new Error('CAD轮廓坐标无效或超过1000000 mm');
    context.points += path.points.length;
    if (context.points > 100000) throw new Error('CAD离散点总数超过100000，请拆分图纸');
    context.paths.push(path);
    } catch(error) {
      if(!context.previewOnly || /超过10000|超过100000|超过16层|循环引用/.test(error.message))throw error;
      context.plane=oldPlane;grayEntity(entity,matrix,context,currentLayer,error.message);
    }
  }
}

function previewParser(checked) {
  const parser=new DxfParser(),queues=new Map();
  for(const record of checked.records){if(!queues.has(record.type))queues.set(record.type,[]);queues.get(record.type).push(record);}
  for(const [type,queue]of queues){
    const original=parser._entityHandlers[type];
    parser.registerEntityHandler(class {
      ForEntityName=type;
      parseEntity(scanner,group){
        let entity;
        if(original)entity=original.parseEntity(scanner,group);
        else {entity={type};for(let item=scanner.next();!scanner.isEOF()&&item.code!==0;item=scanner.next())if(item.code===8)entity.layer=item.value;}
        entity._previewRecord=queue.shift();return entity;
      }
    });
  }
  return parser;
}

function previewShapes(context,joinTolerance,warn,maxVertices) {
  const paths=context.paths;
  const bounds=p=>shapeBounds({outer:p.points.length<3?[p.points[0],p.points.at(-1),p.points.at(-1)]:p.points});
  const overlaps=(a,b)=>a.minX<=b.maxX+joinTolerance&&a.maxX+joinTolerance>=b.minX&&a.minY<=b.maxY+joinTolerance&&a.maxY+joinTolerance>=b.minY;
  const parent=paths.map((_,i)=>i),find=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const boxes=paths.map(bounds);let checks=0;
  for(let i=0;i<paths.length;i++)for(let j=0;j<i;j++){if(++checks>2000000)throw new Error('预览连接检查过于复杂，请拆分图纸');if(overlaps(boxes[i],boxes[j]))parent[find(i)]=find(j);}
  const byRoot=new Map();paths.forEach((p,i)=>{const r=find(i);if(!byRoot.has(r))byRoot.set(r,[]);byRoot.get(r).push(p);});
  const blockers=context.unresolved.filter(g=>g.blocking),unknown=blockers.some(g=>!g.points.length);
  const results=[];
  for(const group of byRoot.values()){
    try{
      if(unknown || group.some(p=>blockers.some(g=>g.points.length&&overlaps(bounds(p),bounds(g)))))throw new Error('相关图形无法解析，为避免漏掉孔或边界，此轮廓暂不可导入');
      results.push(...nestRings(joinPaths(group,joinTolerance,warn,maxVertices),maxVertices));
    }catch(error){for(const path of group)context.unresolved.push({type:'轮廓',points:path.points,closed:path.closed,layer:path.layer,reason:error.message,blocking:true});}
  }
  return results;
}

function joinPaths(paths, tolerance, warn, maxVertices) {
  const rings = [];
  const open = [];
  for (const path of paths) {
    const points = path.points.filter((p, i) => !i || !close(p, path.points[i - 1]));
    if (points.length < 2) throw new Error('图纸包含零长度轮廓边');
    if (path.closed || close(points[0], points.at(-1), tolerance)) {
      if (close(points[0], points.at(-1), tolerance)) points.pop();
      rings.push({ points, layers: new Set([path.layer]) });
    } else open.push({ ...path, points });
  }
  const nodes = [], cells = new Map();
  const nodeFor = (p) => {
    const cx = Math.floor(p[0] / tolerance), cy = Math.floor(p[1] / tolerance);
    const found = [];
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const index of cells.get(`${cx + dx}:${cy + dy}`) ?? []) if (close(nodes[index].point, p, tolerance)) found.push(index);
    }
    if (found.length > 1) throw new Error('CAD端点在拼接容差内有多个匹配，轮廓连接不明确');
    if (found.length) { if (!close(nodes[found[0]].point, p)) warn(`轮廓端点已在${tolerance} mm拼接容差内连接，请核对尺寸。`); return found[0]; }
    const index = nodes.length; nodes.push({ point: p, edges: [] });
    const key = `${cx}:${cy}`; if (!cells.has(key)) cells.set(key, []); cells.get(key).push(index);
    return index;
  };
  open.forEach((path, index) => { path.nodes = [nodeFor(path.points[0]), nodeFor(path.points.at(-1))]; path.nodes.forEach((node) => nodes[node].edges.push(index)); });
  if (nodes.some((node) => node.edges.length !== 2)) throw new Error('图纸含开放或分叉轮廓，不能形成明确闭合零件；请先闭合/清理CAD线段');
  const used = new Set();
  for (let index = 0; index < open.length; index += 1) {
    if (used.has(index)) continue;
    const points = [], layers = new Set();
    const start = open[index].nodes[0]; let node = start, edge = index;
    do {
      if (used.has(edge)) throw new Error('CAD轮廓链重复或连接错误');
      used.add(edge);
      const path = open[edge], forward = path.nodes[0] === node;
      const segment = forward ? path.points.map((p) => [...p]) : path.points.slice().reverse().map((p) => [...p]);
      segment[0] = nodes[node].point;
      node = forward ? path.nodes[1] : path.nodes[0]; segment[segment.length - 1] = nodes[node].point;
      points.push(...(points.length ? segment.slice(1) : segment)); layers.add(path.layer);
      if (points.length > maxVertices + 1) throw new Error(`闭合轮廓超过${maxVertices}点，请增大曲线容差、提高全局顶点上限或简化图纸`);
      if (node !== start) edge = nodes[node].edges.find((candidate) => !used.has(candidate));
    } while (node !== start);
    points.pop(); rings.push({ points, layers });
  }
  return rings;
}

function inside(point, ring) {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function segmentsTouch(a, b, c, d) {
  const orient = (p, q, r) => { const value = cross(p, q, r); return Math.abs(value) <= EPS * Math.max(1, distance(p, q)) ? 0 : Math.sign(value); };
  const on = (p, q, r) => r[0] >= Math.min(p[0], q[0]) - EPS && r[0] <= Math.max(p[0], q[0]) + EPS && r[1] >= Math.min(p[1], q[1]) - EPS && r[1] <= Math.max(p[1], q[1]) + EPS;
  const ac = orient(a, b, c), ad = orient(a, b, d), ca = orient(c, d, a), cb = orient(c, d, b);
  return ac * ad < 0 && ca * cb < 0 || !ac && on(a, b, c) || !ad && on(a, b, d) || !ca && on(c, d, a) || !cb && on(c, d, b);
}

function nestRings(rings, maxVertices) {
  if (rings.length > 1000) throw new Error('闭合轮廓超过1000个，请拆分图纸');
  for (const ring of rings) {
    normalizeShape({ outer: ring.points, holes: [] }, { maxVertices });
    ring.area = area(ring.points); ring.parent = null;
    ring.bounds = shapeBounds({ outer: ring.points });
  }
  let comparisons = 0;
  for (let i = 0; i < rings.length; i += 1) for (let j = i + 1; j < rings.length; j += 1) {
    const a = rings[i], b = rings[j], ab = a.bounds, bb = b.bounds;
    if (ab.maxX < bb.minX - EPS || bb.maxX < ab.minX - EPS || ab.maxY < bb.minY - EPS || bb.maxY < ab.minY - EPS) continue;
    for (let u = 0; u < a.points.length; u += 1) for (let v = 0; v < b.points.length; v += 1) {
      if (++comparisons > 5000000) throw new Error('图纸轮廓交叉检查过于复杂，请拆分文件后导入');
      if (segmentsTouch(a.points[u], a.points[(u + 1) % a.points.length], b.points[v], b.points[(v + 1) % b.points.length])) throw new Error('CAD闭合轮廓相交、相接或重复，无法可靠区分零件与孔洞');
    }
  }
  for (const ring of rings) {
    const containers = rings.filter((other) => other !== ring && other.area > ring.area && inside(ring.points[0], other.points));
    ring.parent = containers.sort((a, b) => a.area - b.area)[0] ?? null;
    ring.depth = containers.length;
  }
  return rings.filter((ring) => ring.depth % 2 === 0).map((ring) => {
    const holes = rings.filter((other) => other.parent === ring && other.depth % 2 === 1);
    return { shape: normalizeShape({ outer: ring.points, holes: holes.map((hole) => hole.points) }, { maxVertices }), origin:[ring.bounds.minX,ring.bounds.minY], layers: [...new Set([...ring.layers, ...holes.flatMap((hole) => [...hole.layers])])].sort() };
  });
}

export function importCadText(text, { fileName = 'drawing.dxf', panels = [], material = panels[0]?.material ?? '', thickness = 18, quantity = 1, makeId = () => globalThis.crypto?.randomUUID?.() ?? `cad-${Date.now()}-${Math.random()}`, curveTolerance = 0.1, joinTolerance = 0.01, unitOverride, maxVertices = 256, solidMode = 'ignore', previewOnly = false } = {}) {
  if(!['ignore','outline'].includes(solidMode))throw new Error('SOLID处理方式无效');
  if (!Number.isSafeInteger(maxVertices) || maxVertices < 3) throw new Error('轮廓顶点上限必须是至少为 3 的整数');
  if (/\.dwg$/i.test(fileName)) throw new Error('暂不支持DWG；请在CAD中另存为ASCII DXF后导入');
  if (!/\.dxf$/i.test(fileName)) throw new Error('请选择ASCII DXF文件（.dxf）');
  if (!(finite(curveTolerance, '曲线容差') >= 0.001 && curveTolerance <= 10)) throw new Error('曲线容差须在0.001–10 mm之间');
  if (!(finite(joinTolerance, '拼接容差') >= 0.000001 && joinTolerance <= 1)) throw new Error('拼接容差须在0.000001–1 mm之间');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000 || !Number.isFinite(thickness) || thickness <= 0) throw new Error('导入数量或厚度无效');
  const checked = preflight(text, solidMode, previewOnly);
  const warnings = [];
  const warn = (message) => { if (!warnings.includes(message)) warnings.push(message); };
  checked.annotations.forEach((type) => warn(type === 'SOLID' ? solidMode==='outline'
    ? 'SOLID填充已按边界导入；内部填充可能识别为孔洞，请核对预览后添加。'
    : '已忽略SOLID实体填充（含标注箭头），继续读取显式加工轮廓；若零件由SOLID绘制，可选择按填充边界导入。'
    : type === 'VIEWPORT' ? '已忽略布局视口 VIEWPORT，继续读取零件加工轮廓。' : `已忽略注释/填充图元 ${type}，仅以显式线、弧和闭合轮廓作为加工边界。`));
  let drawing;
  try { drawing = (previewOnly?previewParser(checked):new DxfParser()).parseSync(text.replace(/^\uFEFF/, '')); } catch (error) { throw new Error(`DXF解析失败：${error.message}`); }
  if (!drawing?.entities?.length) throw new Error('DXF中没有可导入的模型实体');
  const unit = units(drawing.header, unitOverride, warn);
  const context = { paths: [], expanded: 0, points: 0, plane: undefined, curveTolerance, warn, maxVertices, solidMode, previewOnly, unresolved:[] };
  // CAD uses Y-up; the app's SVG/layout plane uses Y-down. Convert once before
  // ring classification so previews preserve the drawing's visible orientation.
  expandEntities(drawing.entities, drawing.blocks ?? {}, [unit.scale, 0, 0, -unit.scale, 0, 0], context);
  if(!previewOnly && !context.paths.length && checked.annotations.has('SOLID') && solidMode==='ignore')throw new Error('图纸只有填充或标注，没有显式闭合加工轮廓；若零件由SOLID绘制，请选择“按填充边界导入”后重新解析');
  if (context.plane && Math.abs(context.plane) > EPS) warn(`二维图纸位于Z=${context.plane}，已平移投影到XY平面。`);
  const shapes = previewOnly ? previewShapes(context,joinTolerance,warn,maxVertices) : nestRings(joinPaths(context.paths, joinTolerance, warn, maxVertices), maxVertices);
  if (!shapes.length && !previewOnly) throw new Error('CAD中没有有效闭合零件轮廓');
  const stock = panels.find((panel) => String(panel.material ?? '').trim().toLocaleLowerCase() === String(material).trim().toLocaleLowerCase() && Math.abs(Number(panel.thickness) - thickness) < EPS);
  const base = String(fileName).replace(/^.*[\\/]/, '').replace(/\.dxf$/i, '') || 'CAD';
  const parts = shapes.map(({ shape, layers, origin }, index) => {
    const bounds = shapeBounds(shape);
    return { id: makeId(), quantity, length: bounds.width, width: bounds.height, material: stock ? String(stock.material ?? '') : '', thickness: stock ? thickness : '', allowRotate: true, code: `${base}-${String(index + 1).padStart(2, '0')}`, description: `CAD：${base}；图层：${layers.join('/')}`, shape, cadSource: { fileName: String(fileName).replace(/^.*[\\/]/, ''), format: 'DXF', unit: unit.unit, scale: unit.scale, layers, origin, curveTolerance, joinTolerance, solidMode, sourceYAxis: 'up', targetYAxis: 'down' } };
  });
  return { parts, unresolved:context.unresolved, warnings, summary: { fileName, partCount: parts.length, entityCount: checked.entities, expandedEntityCount: context.expanded, unit: unit.unit, scale: unit.scale, curveTolerance, joinTolerance, solidMode } };
}

export function previewCadText(text, options={}) {
  try { return importCadText(text,{...options,previewOnly:true}); }
  catch(error) { return {parts:[],warnings:[error.message],unresolved:[{type:'文件',points:[],layer:'',reason:error.message,blocking:true}],summary:{fileName:options.fileName??'drawing.dxf'}}; }
}
