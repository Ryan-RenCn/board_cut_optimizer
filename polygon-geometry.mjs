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

function edgeTree(segments) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [a,b] of segments) {
    bounds.minX = Math.min(bounds.minX,a[0],b[0]); bounds.minY = Math.min(bounds.minY,a[1],b[1]);
    bounds.maxX = Math.max(bounds.maxX,a[0],b[0]); bounds.maxY = Math.max(bounds.maxY,a[1],b[1]);
  }
  if (segments.length <= 8) return { ...bounds, segments };
  const axis = bounds.maxX-bounds.minX >= bounds.maxY-bounds.minY ? 0 : 1;
  const sorted = segments.slice().sort((a,b)=>(a[0][axis]+a[1][axis])-(b[0][axis]+b[1][axis]));
  const middle = Math.floor(sorted.length/2);
  return { ...bounds, left:edgeTree(sorted.slice(0,middle)),right:edgeTree(sorted.slice(middle)) };
}

// Index immutable placement geometry once; callers own the lifetime, so edited
// source outlines never reuse a stale global geometry cache.
export function prepareShapeCollision(shape) {
  const rings = materialRings(shape).map(edges);
  return { shape, rings, trees:rings.map(edgeTree), tree:edgeTree(rings.flat()) };
}

function nearbyEdges(tree, a, b, gap, visit) {
  const dx = Math.max(0,tree.minX-Math.max(a[0],b[0]),Math.min(a[0],b[0])-tree.maxX);
  const dy = Math.max(0,tree.minY-Math.max(a[1],b[1]),Math.min(a[1],b[1])-tree.maxY);
  if (dx*dx+dy*dy > (gap+EPSILON)**2) return false;
  if (tree.segments) return tree.segments.some(([c,d])=>visit(c,d));
  return nearbyEdges(tree.left,a,b,gap,visit)||nearbyEdges(tree.right,a,b,gap,visit);
}

function indexedPointInRing(point, tree) {
  let inside=false,boundary=false;
  const walk=node=>{
    if (boundary || point[1]<node.minY-EPSILON || point[1]>node.maxY+EPSILON || node.maxX<point[0]-EPSILON) return;
    if (!node.segments) {walk(node.left);walk(node.right);return;}
    for (const [a,b] of node.segments) {
      if(pointOnSegment(point,a,b)){boundary=true;return;}
      if((a[1]>point[1])!==(b[1]>point[1]) && point[0]<a[0]+(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])) inside=!inside;
    }
  };
  walk(tree);return boundary?0:inside?1:-1;
}

function indexedPointInMaterial(point, index) {
  return indexedPointInRing(point,index.trees[0])===1 && !index.trees.slice(1).some(tree=>indexedPointInRing(point,tree)!==-1);
}

export function shapesOverlap(first, second, clearance = 0, firstIndex, secondIndex, offsetX = 0, offsetY = 0) {
  if (!finite(clearance) || clearance < 0) throw new Error('轮廓间距必须为非负有限数字');
  const firstBounds = shapeBounds(first);
  const secondBounds = shapeBounds(second);
  secondBounds.minX+=offsetX;secondBounds.maxX+=offsetX;
  secondBounds.minY+=offsetY;secondBounds.maxY+=offsetY;
  if (firstBounds.maxX + clearance <= secondBounds.minX + EPSILON || secondBounds.maxX + clearance <= firstBounds.minX + EPSILON
    || firstBounds.maxY + clearance <= secondBounds.minY + EPSILON || secondBounds.maxY + clearance <= firstBounds.minY + EPSILON) return false;
  firstIndex = firstIndex?.shape===first ? firstIndex : prepareShapeCollision(first);
  secondIndex = secondIndex?.shape===second ? secondIndex : prepareShapeCollision(second);
  let closest = Infinity;
  for (const firstRing of firstIndex.rings) {
      for (const [a, b] of firstRing) {
        const localA=[a[0]-offsetX,a[1]-offsetY],localB=[b[0]-offsetX,b[1]-offsetY];
        if (nearbyEdges(secondIndex.tree,localA,localB,clearance,(c,d)=>{
          const intersection = segmentIntersection(localA, localB, c, d);
          if (intersection === 'proper' || sameSideCollinearOverlap(localA, localB, c, d)) return true;
          if (intersection) closest = 0;
          else if (clearance > 0) closest = Math.min(closest, pointSegmentDistance(localA, c, d), pointSegmentDistance(localB, c, d), pointSegmentDistance(c, localA, localB), pointSegmentDistance(d, localA, localB));
          return closest < clearance - EPSILON;
        })) return true;
      }
  }
  // Edge midpoints also catch an edge entering through a polygon vertex where
  // no proper crossing exists. Hole interiors are excluded by pointInMaterial.
  for (const ring of firstIndex.rings) {
    for (const [a, b] of ring) {
      const localA=[a[0]-offsetX,a[1]-offsetY],localB=[b[0]-offsetX,b[1]-offsetY];
      if (indexedPointInMaterial(localA, secondIndex) || indexedPointInMaterial(midpoint(localA, localB), secondIndex)) return true;
    }
  }
  for (const ring of secondIndex.rings) {
    for (const [a, b] of ring) {
      const worldA=[a[0]+offsetX,a[1]+offsetY],worldB=[b[0]+offsetX,b[1]+offsetY];
      if (indexedPointInMaterial(worldA, firstIndex) || indexedPointInMaterial(midpoint(worldA, worldB), firstIndex)) return true;
    }
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
