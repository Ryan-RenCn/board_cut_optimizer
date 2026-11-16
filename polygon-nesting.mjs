// Independent polygon nesting: triangulated configuration-space obstacles (NFP),
// finite rotation candidates and exact boundary/clearance verification.
// Clipper uses 0.0001 mm integer coordinates. Round offsets approximate arcs;
// every accepted placement is rechecked against the original floating geometry.
import earcut from './vendor/earcut.mjs';
import Clipper from './vendor/clipper.mjs';
import { normalizeShape, shapeBounds, shapeArea, transformShape, shapesOverlap, rotationCandidates, normalizeAngle, prepareShapeCollision } from './polygon-geometry.mjs';

const SCALE = 10000;
const EPSILON = 1e-7;
const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const bounded = (value, fallback, max) => Math.min(max, Math.max(1, Math.floor(numeric(value, fallback))));
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const integerPoint = ([x, y]) => {
  if (Math.abs(x) > 1e8 || Math.abs(y) > 1e8) throw new Error('异形排版坐标超出安全计算范围');
  return { X: Math.round(x * SCALE), Y: Math.round(y * SCALE) };
};

function partShape(part, settings, cache, rectangles) {
  if (part.shape && cache?.has(part.shape)) return cache.get(part.shape);
  const rectangleKey=`${part.length}:${part.width}`;
  if(!part.shape && rectangles?.has(rectangleKey))return rectangles.get(rectangleKey);
  const result = normalizeShape(part.shape ?? { outer: [[0, 0], [part.length, 0], [part.length, part.width], [0, part.width]], holes: [] }, { maxVertices: part.shape ? Number(settings.maxShapeVertices ?? 256) : 4 });
  if (part.shape) cache?.set(part.shape,result);
  else rectangles?.set(rectangleKey,result);
  return result;
}

function rotatedShape(shape, angle, context) {
  let rotations=context.rotations.get(shape);
  if(!rotations){rotations=new Map();context.rotations.set(shape,rotations);}
  if(!rotations.has(angle)) rotations.set(angle,transformShape(shape,angle));
  return rotations.get(angle);
}

function collisionIndex(shape, context) {
  if(!context.collisions.has(shape))context.collisions.set(shape,prepareShapeCollision(shape));
  return context.collisions.get(shape);
}

function polygonAngles(part, settings) {
  if(settings.polygonAngleStrategy==='orthogonal' && part.rotationAngles===undefined) {
    return settings.allowRotation===false || part.allowRotate===false ? [0] : [0,90,180,270];
  }
  return rotationCandidates(part,settings);
}

function triangulate(shape) {
  const points = [...shape.outer];
  const holes = [];
  for (const ring of shape.holes ?? []) { holes.push(points.length); points.push(...ring); }
  const flat = points.flat();
  const indices = earcut(flat, holes, 2);
  const triangles = [];
  let area = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const triangle = indices.slice(index, index + 3).map((vertex) => points[vertex]);
    area += Math.abs(cross(...triangle)) / 2;
    triangles.push(triangle);
  }
  if (Math.abs(area - shapeArea(shape)) > Math.max(1e-6, shapeArea(shape) * 1e-8)) throw new Error('轮廓三角化面积校验失败');
  return triangles;
}

function hull(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique = sorted.filter((point, index) => !index || point[0] !== sorted[index - 1][0] || point[1] !== sorted[index - 1][1]);
  const half = (input) => {
    const result = [];
    for (const point of input) {
      while (result.length > 1 && cross(result.at(-2), result.at(-1), point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  return [...half(unique).slice(0, -1), ...half(unique.slice().reverse()).slice(0, -1)];
}

function union(paths) {
  if (!paths.length) return [];
  const clipper = new Clipper.Clipper();
  clipper.AddPaths(paths, Clipper.PolyType.ptSubject, true);
  const result = new Clipper.Paths();
  if (!clipper.Execute(Clipper.ClipType.ctUnion, result, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero)) throw new Error('禁入域合并失败');
  return result;
}

function noFitPaths(fixed, moving, clearance, context) {
  const identify=shape=>{if(!context.ids.has(shape))context.ids.set(shape,++context.nextId);return context.ids.get(shape);};
  const key = `${identify(fixed)}:${identify(moving)}:${clearance}`;
  const cached = context.nfpCache.get(key);
  if (context.nfpCache.has(key)) { context.diagnostics.nfpCacheHits += 1; return cached; }
  const trianglesFor = (shape) => {
    const id = JSON.stringify(shape);
    if (context.triangleCache.has(id)) return context.triangleCache.get(id);
    const result = triangulate(shape);
    if (context.triangleCache.size < 256) context.triangleCache.set(id, result);
    return result;
  };
  const first = trianglesFor(fixed);
  const second = trianglesFor(moving);
  const pairCount = first.length * second.length;
  if (pairCount > context.maxTrianglePairs || context.diagnostics.nfpTrianglePairs + pairCount > context.maxTotalTrianglePairs) {
    context.diagnostics.limited = true;
    context.diagnostics.fallbacks += 1;
    if(context.nfpCache.size<256)context.nfpCache.set(key,null);
    return null;
  }
  context.diagnostics.nfpTrianglePairs += pairCount;
  const sums = [];
  for (const a of first) for (const b of second) {
    // A + (-B): the moving shape's bbox origin is the translation reference.
    const vertices = a.flatMap(([ax, ay]) => b.map(([bx, by]) => [ax - bx, ay - by]));
    const path = hull(vertices).map(integerPoint);
    if (path.length >= 3) sums.push(path);
  }
  let result = union(sums);
  if (clearance > 0 && result.length) {
    const offset = new Clipper.ClipperOffset(2, 0.001 * SCALE);
    offset.AddPaths(result, Clipper.JoinType.jtRound, Clipper.EndType.etClosedPolygon);
    const expanded = new Clipper.Paths();
    offset.Execute(expanded, clearance * SCALE);
    result = expanded;
  }
  // Cache bounded by the number of shape/rotation pairs, independent of copies.
  if (context.nfpCache.size < 256) context.nfpCache.set(key, result);
  return result;
}

function translatePaths(paths, x, y) {
  const dx = Math.round(x * SCALE), dy = Math.round(y * SCALE);
  return paths.map((ring) => ring.map((point) => ({ X: point.X + dx, Y: point.Y + dy })));
}

function contactVertices(ring, limit) {
  // Remove only straight intermediate vertices for contact search. Keep the
  // original geometry for every collision check and for the exported layout.
  const corners=ring.filter((point,i)=>{
    const previous=ring[(i+ring.length-1)%ring.length],next=ring[(i+1)%ring.length];
    return Math.abs(cross(previous,point,next))>EPSILON*Math.max(1,Math.hypot(next[0]-previous[0],next[1]-previous[1]));
  });
  const source=corners.length>=3?corners:ring;
  if(source.length<=limit)return source;
  const selected=new Set();
  // Sample the complete ring, not just its first segment. Concave turns and
  // extrema protect notches even when dense curved contours hit the budget.
  for(const [axis,sign] of [[0,1],[0,-1],[1,1],[1,-1]]) {
    let best=0;for(let i=1;i<source.length;i++)if(source[i][axis]*sign>source[best][axis]*sign)best=i;
    selected.add(best);
  }
  const concave=source.map((point,i)=>({i,turn:cross(source[(i+source.length-1)%source.length],point,source[(i+1)%source.length])})).filter(p=>p.turn<-EPSILON).sort((a,b)=>a.turn-b.turn);
  for(const item of concave){if(selected.size>=Math.ceil(limit/2))break;selected.add(item.i);}
  for(let i=0;i<limit && selected.size<limit;i++)selected.add(Math.floor(i*source.length/limit));
  return [...selected].sort((a,b)=>a-b).slice(0,limit).map(i=>source[i]);
}

function candidates(placements, moving, bounds, clearance, context, simple = false) {
  const size = shapeBounds(moving);
  const maxX = bounds.right - size.width, maxY = bounds.bottom - size.height;
  if (maxX < bounds.left - EPSILON || maxY < bounds.top - EPSILON) return [];
  const occupiedRight=Math.max(bounds.left,...placements.map(p=>p.x+p.placedLength));
  const occupiedBottom=Math.max(bounds.top,...placements.map(p=>p.y+p.placedWidth));
  const points = [];
  const seen = new Set();
  const add = (x, y) => {
    if (x < bounds.left - EPSILON || y < bounds.top - EPSILON || x > maxX + EPSILON || y > maxY + EPSILON) return;
    x = Math.max(bounds.left, Math.min(maxX, x)); y = Math.max(bounds.top, Math.min(maxY, y));
    const key = `${x.toFixed(7)},${y.toFixed(7)}`;
    const nestingPriority=placements.length && x+size.width<=occupiedRight+EPSILON && y+size.height<=occupiedBottom+EPSILON ? 0 : 1;
    if (!seen.has(key)) { seen.add(key); points.push([x, y, nestingPriority]); }
  };
  for (const x of [bounds.left, maxX]) for (const y of [bounds.top, maxY]) add(x, y);
  if (!placements.length) return points;
  // Safe shelf contacts give dense curves a usable candidate immediately;
  // retain true-outline NFP/contact candidates for concave interlocking.
  const xs=new Set([bounds.left]),ys=new Set([bounds.top]);
  for(const placed of placements){xs.add(placed.x+placed.placedLength+clearance);ys.add(placed.y+placed.placedWidth+clearance);}
  for(const x of xs)for(const y of ys)add(x,y);
  const forbidden = [];
  for (const placed of placements) {
    // Holes need their own candidates even when the expensive NFP construction
    // falls back. None of these anchors can bypass the exact material check.
    for(const hole of placed.placedShape.holes??[]) {
      const hb=shapeBounds({outer:hole});
      const hx=[hb.minX+clearance,(hb.minX+hb.maxX-size.width)/2,hb.maxX-size.width-clearance];
      const hy=[hb.minY+clearance,(hb.minY+hb.maxY-size.height)/2,hb.maxY-size.height-clearance];
      for(const x of hx)for(const y of hy)add(x,y);
    }
    if(simple)continue;
    const fixed = rotatedShape(placed.shape, placed.angle, context);
    const paths = noFitPaths(fixed, moving, clearance, context);
    if (paths) forbidden.push(...translatePaths(paths, placed.x, placed.y));
    // Exact contact candidates also preserve degenerate feasible domains, e.g.
    // a part fitting a hole or sheet with zero residual width/height.
    const pairVertices = placed.placedShape.outer.length * moving.outer.length;
    const contactLimit = pairVertices > 4096 ? 32 : 4096;
    for (const ring of [placed.placedShape.outer, ...(placed.placedShape.holes ?? [])]) {
      const selectedA=contactVertices(ring,contactLimit===32?8:64);
      const selectedB=contactVertices(moving.outer,contactLimit===32?4:64);
      if(selectedA.length<ring.length || selectedB.length<moving.outer.length)context.diagnostics.limited=true;
      for (const a of selectedA) for (const b of selectedB) {
        add(a[0] - b[0], a[1] - b[1]);
        if (clearance > 0) {
          for (const dx of [-clearance, 0, clearance]) for (const dy of [-clearance, 0, clearance]) add(a[0] - b[0] + dx, a[1] - b[1] + dy);
        }
      }
    }
  }
  if (forbidden.length && maxX > bounds.left + EPSILON && maxY > bounds.top + EPSILON) {
    const domain = [[bounds.left, bounds.top], [maxX, bounds.top], [maxX, maxY], [bounds.left, maxY]].map(integerPoint);
    const clipper = new Clipper.Clipper();
    clipper.AddPath(domain, Clipper.PolyType.ptSubject, true);
    clipper.AddPaths(forbidden, Clipper.PolyType.ptClip, true);
    const free = new Clipper.Paths();
    clipper.Execute(Clipper.ClipType.ctDifference, free, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);
    for (const ring of free) for (const point of ring) {
      const x = point.X / SCALE, y = point.Y / SCALE;
      add(x, y);
      // Correct integer rounding without ever accepting unchecked penetration.
      for (const dx of [-0.0002, 0, 0.0002]) for (const dy of [-0.0002, 0, 0.0002]) add(x + dx, y + dy);
    }
  }
  return points.sort((a, b) => a[2]-b[2] || a[1] - b[1] || a[0] - b[0]);
}

function compare(first, second) {
  for (let index = 0; index < first.length; index += 1) {
    if (Math.abs(first[index] - second[index]) > EPSILON) return first[index] - second[index];
  }
  return 0;
}

function refinementAllowed(part, settings) {
  return Boolean(part.shape) && part.rotationAngles === undefined && part.allowRotate !== false && settings.allowRotation !== false;
}

function refinementDepth(settings) {
  return Math.min(4, Math.max(0, Math.floor(numeric(settings.angleRefinementDepth, 2))));
}

function refinementAngles(center, delta) {
  // Structure observed in NewLocalAngleOptimize (0x26b566a40): halve the
  // neighborhood and try -2delta, -delta, +delta, +2delta before the next level.
  return [-2, -1, 1, 2].map((factor) => normalizeAngle(center + factor * delta));
}

export function polygonFitsPanel(part, panel, settings = {}) {
  const shape = partShape(part, settings);
  const width = numeric(panel.length) - 2 * Math.max(0, numeric(settings.panelMarginX));
  const height = numeric(panel.width) - 2 * Math.max(0, numeric(settings.panelMarginY));
  let seed = 0, score = Infinity;
  const inspect = (angle) => {
    const bounds = shapeBounds(transformShape(shape, angle));
    const overflow = Math.max(bounds.width - width, bounds.height - height);
    if (overflow < score) { seed = angle; score = overflow; }
    return bounds.width <= width + EPSILON && bounds.height <= height + EPSILON;
  };
  if (polygonAngles(part, settings).some(inspect)) return true;
  if (!refinementAllowed(part, settings)) return false;
  let delta = numeric(settings.rotationStep, 15) / 2;
  for (let depth = 0; depth < refinementDepth(settings); depth += 1, delta /= 2) {
    if (refinementAngles(seed, delta).some(inspect)) return true;
  }
  return false;
}

export function fillPolygonSheet(panel, parts, settings = {}) {
  const marginX = Math.max(0, numeric(settings.panelMarginX)), marginY = Math.max(0, numeric(settings.panelMarginY));
  const bounds = { left: marginX, top: marginY, right: numeric(panel.length) - marginX, bottom: numeric(panel.width) - marginY };
  const clearance = Math.max(0, numeric(settings.sawWidth));
  const diagnostics = { strategy: 'triangulated-nfp', evaluations: 0, completionEvaluations:0, completionPlacements:0, nfpTrianglePairs: 0, nfpCacheHits: 0, angleCandidates: 0, refinementAngles: 0, fallbacks: 0, limited: false, budgetExhausted: false, coordinatePrecision: 1 / SCALE, offsetArcTolerance: 0.001 };
  const context = { diagnostics, shapes:new WeakMap(),rectangles:new Map(),rotations:new WeakMap(),collisions:new WeakMap(),ids:new WeakMap(),nextId:0, triangleCache: new Map(), nfpCache: new Map(), maxTrianglePairs: bounded(settings.maxNfpTrianglePairs, 4096, 65536), maxTotalTrianglePairs: bounded(settings.maxTotalNfpTrianglePairs, 250000, 1000000) };
  const maximum = bounded(settings.maxPolygonEvaluations, 100000, 2000000);
  const placements = [];
  let usedArea = 0;
  const occupied = new Set();
  const sourceIds = new Set();
  for (const [index, input] of parts.entries()) {
    const part = { ...input, instanceId: input.instanceId ?? `polygon-${index}` };
    if (sourceIds.has(part.instanceId)) throw new Error('异形零件实例编号重复');
    sourceIds.add(part.instanceId);
    const shape = partShape(part, settings, context.shapes, context.rectangles);
    const angles = polygonAngles(part, settings);
    diagnostics.angleCandidates += angles.length;
    let best = null;
    let seed = angles[0], seedOverflow = Infinity;
    let partChecks=0,partLimited=false;
    const dense=shape.outer.length+(shape.holes??[]).reduce((sum,ring)=>sum+ring.length,0)>128
      || placements.some(p=>p.shape.outer.length+(p.shape.holes??[]).reduce((sum,ring)=>sum+ring.length,0)>128);
    const partMaximum=dense?256:2000;
    const explored = new Set();
    const evaluate = (angle, simple = false) => {
      const key = `${simple?'completion:':''}${angle.toFixed(10)}`;
      if (explored.has(key)) return;
      explored.add(key);
      if(!simple && settings.searchDeadline && Date.now()>=settings.searchDeadline){diagnostics.limited=true;diagnostics.budgetExhausted=true;return;}
      if (!simple && diagnostics.evaluations >= maximum) { diagnostics.limited = true; diagnostics.budgetExhausted = true; return; }
      if(!simple && partChecks>=partMaximum){partLimited=true;diagnostics.limited=true;return;}
      const moving = rotatedShape(shape, angle, context);
      const size = shapeBounds(moving);
      const overflow = Math.max(size.width - bounds.right + bounds.left, size.height - bounds.bottom + bounds.top);
      if (overflow < seedOverflow) { seed = angle; seedOverflow = overflow; }
      if (size.width > bounds.right - bounds.left + EPSILON || size.height > bounds.bottom - bounds.top + EPSILON) return;
      const options = candidates(placements, moving, bounds, clearance, context, simple);
      for (const [x, y, nestingPriority] of options) {
        if(!simple && settings.searchDeadline && Date.now()>=settings.searchDeadline){diagnostics.limited=true;diagnostics.budgetExhausted=true;break;}
        if (!simple && diagnostics.evaluations >= maximum) { diagnostics.limited = true; diagnostics.budgetExhausted = true; break; }
        if(!simple && partChecks>=partMaximum){partLimited=true;diagnostics.limited=true;break;}
        if(simple)diagnostics.completionEvaluations++;else{diagnostics.evaluations++;partChecks++;}
        const movingIndex=placements.length?collisionIndex(moving,context):null;
        if (placements.some((placed) => shapesOverlap(placed.placedShape, moving, clearance,collisionIndex(placed.placedShape,context),movingIndex,x,y))) continue;
        const right = Math.max(x + size.width, ...placements.map((placed) => placed.x + placed.placedLength));
        const bottom = Math.max(y + size.height, ...placements.map((placed) => placed.y + placed.placedWidth));
        const score = settings.polygonPlacementStrategy === 'bottomLeft'
          ? [nestingPriority, y, x, bottom, right, angle]
          : [nestingPriority, (right - bounds.left) * (bottom - bounds.top), bottom, right, y, x, angle];
        if (!best || compare(score, best.score) < 0) best = { score, placement: { ...part, shape, x, y, angle: normalizeAngle(angle), rotated: normalizeAngle(angle) !== 0, placedShape:transformShape(shape,angle,x,y), placedLength: size.width, placedWidth: size.height } };
        if(simple || settings.polygonPlacementStrategy==='bottomLeft') break;
      }
    };
    for (const angle of angles) {
      evaluate(angle,settings.polygonAngleStrategy==='orthogonal');
      if (diagnostics.budgetExhausted || partLimited) break;
    }
    if (settings.polygonAngleStrategy!=='orthogonal' && refinementAllowed(part, settings) && !diagnostics.budgetExhausted && !partLimited) {
      let delta = numeric(settings.rotationStep, 15) / 2;
      for (let depth = 0; depth < refinementDepth(settings); depth += 1, delta /= 2) {
        const center = best?.placement.angle ?? seed;
        for (const angle of refinementAngles(center, delta)) {
          if (!explored.has(angle.toFixed(10))) { diagnostics.refinementAngles += 1; diagnostics.angleCandidates += 1; }
          evaluate(angle);
          if (diagnostics.budgetExhausted || partLimited) break;
        }
        if (diagnostics.budgetExhausted || partLimited) break;
      }
    }
    // Search exhaustion is not proof that a sheet is full. Always try cheap
    // hole/shelf anchors before leaving any instance for a new physical sheet.
    if(!best || partLimited || diagnostics.budgetExhausted) {
      const before=best;
      const completionAngles=part.rotationAngles!==undefined || part.allowRotate===false || settings.allowRotation===false ? angles : [0,90,180,270];
      for(const angle of completionAngles)evaluate(angle,true);
      if(!best)for(const angle of angles)evaluate(angle,true);
      if(best && best!==before)diagnostics.completionPlacements++;
    }
    if (best) { placements.push(best.placement); occupied.add(part.instanceId); usedArea += shapeArea(shape);settings.onPlacement?.(placements); }
  }
  return { placements, freeRects: [], usedArea, diagnostics };
}
