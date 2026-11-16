// Geometry for simple polygonal parts with strictly interior, disjoint holes.
// Coordinates and clearances use millimetres; boundary-only contact is allowed
// when clearance is zero. No bounding-box approximation decides collision.
const EPSILON = 1e-7;
const MAX_COORDINATE = 1e6;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const samePoint = (a, b) => distance(a, b) <= EPSILON;
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function signedArea(ring) {
  const origin = ring[0];
  let sum = 0;
  for (let index = 1; index + 1 < ring.length; index += 1) sum += cross(origin, ring[index], ring[index + 1]);
  return sum / 2;
}

function edges(ring) {
  return ring.map((point, index) => [point, ring[(index + 1) % ring.length]]);
}

function pointOnSegment(point, a, b) {
  if (Math.abs(cross(a, b, point)) > EPSILON * Math.max(1, distance(a, b))) return false;
  return point[0] >= Math.min(a[0], b[0]) - EPSILON && point[0] <= Math.max(a[0], b[0]) + EPSILON
    && point[1] >= Math.min(a[1], b[1]) - EPSILON && point[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function orientation(a, b, c) {
  const value = cross(a, b, c);
  const tolerance = EPSILON * Math.max(1, distance(a, b));
  return Math.abs(value) <= tolerance ? 0 : Math.sign(value);
}

function segmentIntersection(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return 'proper';
  if ((!abC && pointOnSegment(c, a, b)) || (!abD && pointOnSegment(d, a, b))
    || (!cdA && pointOnSegment(a, c, d)) || (!cdB && pointOnSegment(b, c, d))) return 'touch';
  return null;
}

// 1 = strict interior, 0 = boundary, -1 = exterior.
function pointInRing(point, ring) {
  let inside = false;
  for (const [a, b] of edges(ring)) {
    if (pointOnSegment(point, a, b)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < a[0] + (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1])) inside = !inside;
  }
  return inside ? 1 : -1;
}

function pointInMaterial(point, shape) {
  if (pointInRing(point, shape.outer) !== 1) return false;
  return !(shape.holes ?? []).some((hole) => pointInRing(point, hole) !== -1);
}

function normalizeRing(input, label, maxVertices) {
  if (!Array.isArray(input)) throw new Error(`${label}必须为坐标点数组`);
  const ring = [];
  for (const point of input) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(finite)) throw new Error(`${label}坐标必须为有限数字 [x,y]`);
    if (point.some((coordinate) => Math.abs(coordinate) > MAX_COORDINATE)) throw new Error(`${label}坐标绝对值不能超过 ${MAX_COORDINATE} mm`);
    if (!ring.length || !samePoint(point, ring.at(-1))) ring.push([...point]);
  }
  if (ring.length > 1 && samePoint(ring[0], ring.at(-1))) ring.pop();
  if (ring.length < 3) throw new Error(`${label}至少需要三个不同顶点`);
  if (ring.length > maxVertices) throw new Error(`轮廓顶点总数不能超过 ${maxVertices}`);
  const segments = edges(ring);
  for (let first = 0; first < segments.length; first += 1) {
    const previous = ring[(first + ring.length - 1) % ring.length];
    const current = ring[first];
    const next = ring[(first + 1) % ring.length];
    if (orientation(previous, current, next) === 0
      && (previous[0] - current[0]) * (next[0] - current[0]) + (previous[1] - current[1]) * (next[1] - current[1]) > EPSILON ** 2) {
      throw new Error(`${label}存在折返重叠边`);
    }
    for (let second = first + 1; second < segments.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === segments.length - 1)) continue;
      if (segmentIntersection(...segments[first], ...segments[second])) throw new Error(`${label}存在自相交或自接触`);
    }
  }
  if (!Number.isFinite(signedArea(ring)) || Math.abs(signedArea(ring)) <= EPSILON ** 2) throw new Error(`${label}面积必须大于零`);
  return ring;
}

function ringsIntersect(first, second) {
  return edges(first).some(([a, b]) => edges(second).some(([c, d]) => segmentIntersection(a, b, c, d)));
}

export function normalizeShape(shape, { maxVertices = 256 } = {}) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) throw new Error('缺少有效异形轮廓');
  if (!Number.isSafeInteger(maxVertices) || maxVertices < 3) throw new Error('顶点上限必须是至少为 3 的整数');
  if (shape.holes !== undefined && !Array.isArray(shape.holes)) throw new Error('孔洞必须为轮廓数组');
  if ((shape.holes?.length ?? 0) > Math.floor((maxVertices - 3) / 3)) throw new Error(`轮廓顶点总数不能超过 ${maxVertices}`);
  const outer = normalizeRing(shape.outer, '外轮廓', maxVertices);
  const holes = (shape.holes ?? []).map((hole, index) => normalizeRing(hole, `孔洞 ${index + 1}`, maxVertices));
  if (outer.length + holes.reduce((sum, hole) => sum + hole.length, 0) > maxVertices) throw new Error(`轮廓顶点总数不能超过 ${maxVertices}`);
  for (let index = 0; index < holes.length; index += 1) {
    const hole = holes[index];
    if (pointInRing(hole[0], outer) !== 1 || ringsIntersect(outer, hole)) throw new Error(`孔洞 ${index + 1} 必须严格位于外轮廓内`);
    for (let other = 0; other < index; other += 1) {
      if (ringsIntersect(hole, holes[other]) || pointInRing(hole[0], holes[other]) !== -1 || pointInRing(holes[other][0], hole) !== -1) {
        throw new Error('孔洞之间不能相交、相接或相互包含');
      }
    }
  }
  // With these orientations the material is always left of each directed edge.
  if (signedArea(outer) < 0) outer.reverse();
  holes.forEach((hole) => { if (signedArea(hole) > 0) hole.reverse(); });
  const bounds = shapeBounds({ outer });
  if (bounds.width > MAX_COORDINATE || bounds.height > MAX_COORDINATE) throw new Error(`轮廓尺寸不能超过 ${MAX_COORDINATE} mm`);
  const translate = (ring) => ring.map(([x, y]) => [x - bounds.minX, y - bounds.minY]);
  return { outer: translate(outer), holes: holes.map(translate) };
}

export function shapeBounds(shape) {
  if (!Array.isArray(shape?.outer) || shape.outer.length < 3) throw new Error('缺少有效外轮廓');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of shape.outer) {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(finite)) throw new Error('轮廓坐标必须为有限数字');
    minX = Math.min(minX, point[0]); minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]); maxY = Math.max(maxY, point[1]);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function shapeArea(shape) {
  return Math.abs(signedArea(shape.outer)) - (shape.holes ?? []).reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
}

export function normalizeAngle(value) {
  if (!finite(value)) throw new Error('旋转角度必须为有限数字');
  const remainder = value % 360;
  const angle = remainder < 0 ? remainder + 360 : remainder;
  return Math.abs(angle) < 1e-10 || Math.abs(angle - 360) < 1e-10 ? 0 : angle;
}

export function transformShape(shape, angle = 0, x = 0, y = 0) {
  const normalizedAngle = normalizeAngle(angle);
  if (!finite(x) || !finite(y)) throw new Error('放置坐标必须为有限数字');
  const radians = normalizedAngle * Math.PI / 180;
  const sine = Math.sin(radians);
  const cosine = Math.cos(radians);
  const rotate = (ring) => ring.map(([px, py]) => [px * cosine - py * sine, px * sine + py * cosine]);
  const outer = rotate(shape.outer);
  const holes = (shape.holes ?? []).map(rotate);
  const bounds = shapeBounds({ outer });
  const translate = (ring) => ring.map(([px, py]) => [px - bounds.minX + x, py - bounds.minY + y]);
  return { outer: translate(outer), holes: holes.map(translate) };
}

function materialRings(shape) {
  const outer = signedArea(shape.outer) < 0 ? [...shape.outer].reverse() : shape.outer;
  return [outer, ...(shape.holes ?? []).map((hole) => signedArea(hole) > 0 ? [...hole].reverse() : hole)];
}

function pointSegmentDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const squareLength = dx * dx + dy * dy;
  const t = squareLength ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / squareLength)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}

function sameSideCollinearOverlap(a, b, c, d) {
  if (orientation(a, b, c) || orientation(a, b, d)) return false;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx * (d[0] - c[0]) + dy * (d[1] - c[1]) <= 0) return false;
  const axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
  return Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis]))
    - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > EPSILON;
}

export function shapesOverlap(first, second, clearance = 0) {
  if (!finite(clearance) || clearance < 0) throw new Error('轮廓间距必须为非负有限数字');
  const firstBounds = shapeBounds(first);
  const secondBounds = shapeBounds(second);
  if (firstBounds.maxX + clearance <= secondBounds.minX + EPSILON || secondBounds.maxX + clearance <= firstBounds.minX + EPSILON
    || firstBounds.maxY + clearance <= secondBounds.minY + EPSILON || secondBounds.maxY + clearance <= firstBounds.minY + EPSILON) return false;
  const firstRings = materialRings(first);
  const secondRings = materialRings(second);
  let closest = Infinity;
  for (const firstRing of firstRings) {
    for (const secondRing of secondRings) {
      for (const [a, b] of edges(firstRing)) {
        for (const [c, d] of edges(secondRing)) {
          const intersection = segmentIntersection(a, b, c, d);
          if (intersection === 'proper' || sameSideCollinearOverlap(a, b, c, d)) return true;
          if (intersection) closest = 0;
          else if (clearance > 0) closest = Math.min(closest, pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
          if (closest < clearance - EPSILON) return true;
        }
      }
    }
  }
  // Edge midpoints also catch an edge entering through a polygon vertex where
  // no proper crossing exists. Hole interiors are excluded by pointInMaterial.
  for (const ring of firstRings) {
    for (const [a, b] of edges(ring)) if (pointInMaterial(a, second) || pointInMaterial(midpoint(a, b), second)) return true;
  }
  for (const ring of secondRings) {
    for (const [a, b] of edges(ring)) if (pointInMaterial(a, first) || pointInMaterial(midpoint(a, b), first)) return true;
  }
  return false;
}

export function rotationCandidates(part, settings = {}) {
  let custom;
  if (part.rotationAngles !== undefined) {
    if (!Array.isArray(part.rotationAngles) || !part.rotationAngles.length || !part.rotationAngles.every(finite)) throw new Error('自定义角度必须为非空有限数字数组');
    if (part.rotationAngles.length > 720) throw new Error('自定义角度不能超过 720 项');
    custom = part.rotationAngles.map(normalizeAngle);
  }
  if (settings.allowRotation === false || part.allowRotate === false) return [0];
  if (custom) return [...new Set(custom)];
  // Preserve the legacy rectangle orientation contract unless shape geometry or
  // a rotation step is explicitly supplied.
  if (!part.shape) return [0, 90];
  const step = settings.rotationStep ?? 15;
  if (!finite(step) || step < 1 || step > 180) throw new Error('角度步长必须在 1° 至 180° 之间');
  const angles = [];
  for (let angle = 0; angle < 360 - 1e-10; angle += step) angles.push(normalizeAngle(angle));
  if (part.shape?.outer) {
    const outlineEdges = edges(part.shape.outer);
    // Dense sampled curves otherwise contribute thousands of nearly identical
    // directions. Keep a uniform bounded sample; explicit part angles and the
    // configured global step remain intact.
    const stride = Math.max(1, Math.ceil(outlineEdges.length / 64));
    for (const [index, [a, b]] of outlineEdges.entries()) {
      if (index % stride) continue;
      const direction = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      angles.push(normalizeAngle(-direction), normalizeAngle(90 - direction));
    }
  }
  const unique = [];
  for (const angle of angles) if (!unique.some((other) => Math.min(Math.abs(other - angle), 360 - Math.abs(other - angle)) < 1e-8)) unique.push(angle);
  return unique;
}
