// tools/gf/build-gf-geodata.mjs — writes js/gf-geodata.js from the OpenStreetMap extract in tools/gf/data/
// usage: node tools/gf/build-gf-geodata.mjs [out.js]        (GF_DATA=<dir> reads the raw JSON from another folder)
//
// Inputs (bash tools/gf/fetch.sh, Overpass `out body; >; out skel;`):
//   osm_gf_roads.json   highway ways (motorway ... living_street, *_link) and their nodes
//   osm_gf_water.json   natural=water, waterway=riverbank|river|canal ways & relations and their members
// Output: GF_GEO = { version, frame, bbox, osmBase, roadGraph, roads, blocks, water, attribution } in the frame of
// geo-frame.mjs (1 unit = 1 m, x = east, z = south, flat [x0, z0, x1, z1, ...] arrays rounded to 0.1 m).
// The output depends only on the raw JSON: no timestamps, inputs sorted by OSM id.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Raster, rdp, rdpRing, ringArea, destair } from '../geo-util.mjs';
import { LAT0, LON0, THETA, BBOX, BBOX_M, toLocal, q, flat } from './geo-frame.mjs';

const log = (...a) => console.log('[gf-geodata]', ...a);
export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0), https://www.openstreetmap.org/copyright';
export const VERSION = 1;

// =====================================================================================================================
// 1. ROADS
// =====================================================================================================================
export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street'];
const HIGHWAY = new RegExp(`^(${ROAD_CLASSES.join('|')})(_link)?$`);
// Curb-to-curb width (m) of a carriageway with no `width` or `lanes` tag. motorway/trunk/living_street/*_link are not
// in CC-001's list: motorway & trunk are one carriageway of a dual road (2 lanes + shoulders), links one lane + shoulders.
export const WIDTH_DEFAULTS = {
  motorway: 11, trunk: 11, primary: 12, secondary: 12, tertiary: 10,
  unclassified: 8, residential: 8, living_street: 6, service: 5, link: 6
};
export const LANE_WIDTH = 3.3;
// Blocks are cut by every road except service ways that run into lots (driveways, parking aisles...); alleys count
const cutsBlocks = (t) => (t.highway !== 'service' || t.service === 'alley') && t.tunnel !== 'yes' && t.tunnel !== 'building_passage';

// "12", "12 m", "12.5m", "40'", "40 ft", "12'6\"" -> metres; null when unparseable or implausible (< 2 m, > 40 m)
export function parseWidth(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  let m;
  let w = null;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)?$/))) w = parseFloat(m[1]);
  else if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in))?$/))) w = parseFloat(m[1]) * 0.3048 + (m[2] ? parseFloat(m[2]) * 0.0254 : 0);
  return w !== null && w >= 2 && w <= 40 ? w : null;
}
// { width, source: 'width' | 'lanes' | 'default' }
export function roadWidth(t) {
  const w = parseWidth(t.width);
  if (w !== null) return { width: q(w), source: 'width' };
  const lanes = parseInt(t.lanes, 10);
  if (lanes > 0 && lanes < 12) return { width: q(lanes * LANE_WIDTH), source: 'lanes' };
  const cls = t.highway.endsWith('_link') ? 'link' : t.highway;
  return { width: WIDTH_DEFAULTS[cls], source: 'default' };
}
// 1 = along the way's node order, -1 = against it, 0 = both directions
export function onewayOf(t) {
  const o = t.oneway;
  if (o === 'yes' || o === 'true' || o === '1') return 1;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'no' || o === 'false' || o === '0') return 0;
  return t.highway === 'motorway' || t.junction === 'roundabout' || t.junction === 'circular' ? 1 : 0;
}

// Liang-Barsky: the [t0, t1] part of segment a->b inside box, or null
function clipT(ax, az, bx, bz, box) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [p, qq] of [[-dx, ax - box.x0], [dx, box.x1 - ax], [-dz, az - box.z0], [dz, box.z1 - az]]) {
    if (p === 0) { if (qq < 0) return null; continue; }
    const r = qq / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}
// Cut a polyline of { x, z, key } points to the box: runs inside it, with new boundary points (key null) where it
// crosses the edge
export function clipPolyline(pts, box) {
  const runs = [];
  let cur = null;
  const at = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, key: null });
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const c = clipT(a.x, a.z, b.x, b.z, box);
    if (!c) { if (cur) runs.push(cur); cur = null; continue; }
    if (!cur) cur = [c[0] === 0 ? a : at(a, b, c[0])];
    if (c[1] === 1) cur.push(b);
    else { cur.push(at(a, b, c[1])); runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}

const polyLength = (pts) => pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

// Road graph from Overpass elements: nodes at way ends, junctions (OSM nodes shared by two road pieces, or met twice by
// one) and bbox crossings; one link per stretch of way between two of them.
export function buildRoads(elements, box = BBOX_M) {
  const nodes = new Map();
  for (const e of elements) if (e.type === 'node') nodes.set(e.id, e);
  const ways = elements.filter((e) => e.type === 'way' && e.tags && HIGHWAY.test(e.tags.highway) && e.tags.area !== 'yes');
  ways.sort((a, b) => a.id - b.id);

  // Ways as clipped runs of points
  const pieces = [];
  let missing = 0;
  for (const w of ways) {
    const pts = [];
    for (const id of w.nodes) {
      const n = nodes.get(id);
      if (!n) { missing++; continue; }
      const [x, z] = toLocal(n.lon, n.lat);
      pts.push({ x, z, key: id });
    }
    for (const run of clipPolyline(pts, box)) pieces.push({ way: w, run });
  }
  if (missing) log(`warning: ${missing} way node references missing from the extract`);

  // Graph nodes
  const uses = new Map();
  for (const { run } of pieces) for (const p of run) if (p.key !== null) uses.set(p.key, (uses.get(p.key) || 0) + 1);
  const isNode = (p, i, run) => i === 0 || i === run.length - 1 || p.key === null || uses.get(p.key) > 1;
  const nodeIds = new Map();
  const outNodes = [];
  const nodeOf = (p) => {
    const k = p.key === null ? p : p.key; // bbox crossings are unique objects
    if (!nodeIds.has(k)) { nodeIds.set(k, outNodes.length / 2); outNodes.push(q(p.x), q(p.z)); }
    return nodeIds.get(k);
  };

  const names = [];
  const nameIds = new Map();
  const nameId = (n) => {
    if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); }
    return nameIds.get(n);
  };
  const classes = [];
  const classId = (c) => { if (!classes.includes(c)) classes.push(c); return classes.indexOf(c); };

  const links = [];
  const roads = [];
  const roadOf = new Map();
  const cut = []; // block-bounding stretches: { pts, r }
  const stats = { km: {}, widthSource: { width: 0, lanes: 0, default: 0 }, unnamed: 0, ways: ways.length, crossings: 0 };
  for (const { way, run } of pieces) {
    const t = way.tags;
    const { width, source } = roadWidth(t);
    const lanes = parseInt(t.lanes, 10) > 0 ? parseInt(t.lanes, 10) : 0;
    const dir = onewayOf(t);
    const name = t.name || '';
    const cls = classId(t.highway);
    if (!roadOf.has(way.id)) { roadOf.set(way.id, roads.length); roads.push([way.id, []]); }
    const road = roads[roadOf.get(way.id)];
    // split the run at graph nodes
    let start = 0;
    for (let i = 1; i < run.length; i++) {
      if (!isNode(run[i], i, run)) continue;
      let seg = run.slice(start, i + 1);
      start = i;
      // a closed loop between one node (roundabouts, cul-de-sac loops): split at its middle point
      const parts = [];
      if (seg[0] === seg[seg.length - 1] || (seg[0].key !== null && seg[0].key === seg[seg.length - 1].key)) {
        if (seg.length < 3) continue;
        const mid = seg.length >> 1;
        parts.push(seg.slice(0, mid + 1), seg.slice(mid));
      } else parts.push(seg);
      for (const part of parts) {
        const a = nodeOf(part[0]), b = nodeOf(part[part.length - 1]);
        const line = rdp(part.map((p) => [p.x, p.z]), 0.25);
        const inner = [];
        for (const [x, z] of line.slice(1, -1)) {
          const n = inner.length;
          if (n && inner[n - 2] === q(x) && inner[n - 1] === q(z)) continue;
          inner.push(q(x), q(z));
        }
        road[1].push(links.length);
        links.push([a, b, nameId(name), cls, dir, lanes, width, inner]);
        const len = polyLength(line);
        stats.km[t.highway] = (stats.km[t.highway] || 0) + len / 1000;
        stats.widthSource[source]++;
        if (!name) stats.unnamed++;
        if (cutsBlocks(t)) cut.push({ pts: line, r: width / 2 });
      }
    }
  }
  stats.crossings = [...nodeIds.keys()].filter((k) => typeof k === 'object').length;
  return {
    roadGraph: { nodes: outNodes, names, classes, linkFields: ['a', 'b', 'name', 'highway', 'oneway', 'lanes', 'width', 'pts'], links },
    roads,
    cut,
    stats
  };
}

// =====================================================================================================================
// 2. WATER
// =====================================================================================================================
const isWaterArea = (t) => t.natural === 'water' || t.waterway === 'riverbank' || (t.area === 'yes' && /^(river|canal)$/.test(t.waterway));

// Join member ways (node id arrays) into closed rings; { rings, open } with open = ways left over
export function joinRings(ways) {
  const left = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings = [];
  let open = 0;
  while (left.length) {
    const ring = left.shift();
    while (ring[0] !== ring[ring.length - 1]) {
      const end = ring[ring.length - 1];
      const i = left.findIndex((w) => w[0] === end || w[w.length - 1] === end);
      if (i < 0) break;
      const w = left.splice(i, 1)[0];
      ring.push(...(w[0] === end ? w : w.reverse()).slice(1));
    }
    if (ring[0] === ring[ring.length - 1] && ring.length >= 4) rings.push(ring);
    else open++;
  }
  return { rings, open };
}

// Sutherland-Hodgman clip of a ring ([[x, z], ...], open) to the box
export function clipRing(ring, box) {
  let out = ring;
  for (const [inside, cross] of [
    [(p) => p[0] >= box.x0, (a, b) => [box.x0, a[1] + ((b[1] - a[1]) * (box.x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= box.x1, (a, b) => [box.x1, a[1] + ((b[1] - a[1]) * (box.x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= box.z0, (a, b) => [a[0] + ((b[0] - a[0]) * (box.z0 - a[1])) / (b[1] - a[1]), box.z0]],
    [(p) => p[1] <= box.z1, (a, b) => [a[0] + ((b[0] - a[0]) * (box.z1 - a[1])) / (b[1] - a[1]), box.z1]]
  ]) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[(i + src.length - 1) % src.length], b = src[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cross(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cross(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const [xa, za] = ring[k], [xb, zb] = ring[i];
    if ((za > z) !== (zb > z) && x < xa + ((z - za) * (xb - xa)) / (zb - za)) inside = !inside;
  }
  return inside;
}

// Water polygons (outer ring + holes) clipped to the box, from closed ways and multipolygon relations
export function buildWater(elements, box = BBOX_M) {
  const nodes = new Map();
  const ways = new Map();
  const relations = [];
  for (const e of elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    // `>` re-outputs member ways untagged (`out skel`): keep the tagged copy
    else if (e.type === 'way' && (!ways.has(e.id) || e.tags)) ways.set(e.id, e);
    else if (e.type === 'relation' && e.tags) relations.push(e);
  }
  relations.sort((a, b) => a.id - b.id);
  const skipped = [];
  const sources = []; // { id, tags, outers: [nodeIds], inners: [nodeIds] }
  for (const r of relations) {
    const t = r.tags;
    if (t.type !== 'multipolygon' || !isWaterArea(t)) { skipped.push(`relation ${r.id} (${t.type || '?'} ${t.waterway || t.natural || ''} ${t.name || ''}): not an area`); continue; }
    const byRole = { outer: [], inner: [] };
    let absent = 0;
    for (const m of r.members || []) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w) { absent++; continue; }
      byRole[m.role === 'inner' ? 'inner' : 'outer'].push(w.nodes);
    }
    const outer = joinRings(byRole.outer), inner = joinRings(byRole.inner);
    if (absent || outer.open || inner.open) skipped.push(`relation ${r.id} (${t.name || 'unnamed'}): ${absent} member ways absent, ${outer.open + inner.open} rings could not be closed` + (outer.rings.length ? ` (kept ${outer.rings.length} closed outer rings)` : ''));
    // each hole goes to the outer ring around its first node
    const lonlat = (ids) => ids.map((id) => nodes.get(id)).filter(Boolean).map((n) => [n.lon, n.lat]);
    const outers = outer.rings.map((o) => ({ ids: o, ll: lonlat(o), inners: [] }));
    for (const h of inner.rings) {
      const n = nodes.get(h[0]);
      const o = n && outers.find((oo) => pointInRing(n.lon, n.lat, oo.ll));
      if (o) o.inners.push(h);
    }
    for (const o of outers) sources.push({ id: `r${r.id}`, tags: t, outer: o.ids, inners: o.inners });
  }
  for (const w of [...ways.values()].sort((a, b) => a.id - b.id)) {
    const t = w.tags;
    if (!t) continue;
    if (!isWaterArea(t)) { skipped.push(`way ${w.id} (waterway=${t.waterway} ${t.name || ''}): a line, not an area`); continue; }
    if (w.nodes[0] !== w.nodes[w.nodes.length - 1] || w.nodes.length < 4) { skipped.push(`way ${w.id} (${t.name || 'unnamed'}): water way not closed`); continue; }
    sources.push({ id: `w${w.id}`, tags: t, outer: w.nodes, inners: [] });
  }

  const ringXZ = (ids) => {
    const pts = [];
    for (const id of ids.slice(0, -1)) {
      const n = nodes.get(id);
      if (!n) return null;
      pts.push(toLocal(n.lon, n.lat));
    }
    return pts;
  };
  const clean = (ring, outer) => {
    if (!ring) return null;
    let r = clipRing(ring, box);
    if (r.length < 3) return null;
    r = rdpRing(r, 0.5);
    if (r.length < 3 || Math.abs(ringArea(r)) < 1) return null;
    // outers wind like the NYC rings (negative shoelace area in x, z), holes the other way
    if ((ringArea(r) > 0) === outer) r.reverse();
    return r;
  };
  const water = [];
  for (const s of sources) {
    const outer = clean(ringXZ(s.outer), true);
    if (!outer) continue;
    const holes = s.inners.map((h) => clean(ringXZ(h), false)).filter(Boolean);
    const t = s.tags;
    water.push({ osm: s.id, name: t.name || '', kind: t.water || t.waterway || t.natural, outer: flat(outer), holes: holes.map(flat) });
  }
  return { water, skipped };
}

// =====================================================================================================================
// 3. BLOCKS (curb islands, after tools/geo-blocks.mjs: rasterise the roadways at curb width, label what's left)
// =====================================================================================================================
export const BLOCK_PARAMS = { res: 1, sidewalk: 1.8, minArea: 150, minHole: 10 };

// Even-odd scanline fill of several rings at once (a polygon with holes)
function fillRings(R, rings, val) {
  const { res, x0, z0, w, h, d } = R;
  let zmin = Infinity, zmax = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < zmin) zmin = p[1]; if (p[1] > zmax) zmax = p[1]; }
  const j0 = Math.max(0, Math.floor((zmin - z0) / res)), j1 = Math.min(h - 1, Math.ceil((zmax - z0) / res));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = z0 + (j + 0.5) * res;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k], [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
    }
    xs.sort((p, qq) => p - qq);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
      for (let i = i0; i <= i1; i++) d[j * w + i] = val;
    }
  }
}
const unflat = (f) => { const r = []; for (let i = 0; i < f.length; i += 2) r.push([f[i], f[i + 1]]); return r; };

// 4-connected labelling of the non-zero cells of D; returns { lab, comps }
function label(D, W, H, stack) {
  const lab = new Int32Array(W * H);
  const comps = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!D[s0] || lab[s0]) continue;
    const id = comps.length + 1;
    let sp = 0, n = 0, i0 = W, i1 = -1, j0 = H, j1 = -1;
    stack[sp++] = s0;
    lab[s0] = id;
    while (sp) {
      const p = stack[--sp];
      n++;
      const i = p % W, j = (p - i) / W;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      if (i > 0 && D[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (i < W - 1 && D[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (j > 0 && D[p - W] && !lab[p - W]) { lab[p - W] = id; stack[sp++] = p - W; }
      if (j < H - 1 && D[p + W] && !lab[p + W]) { lab[p + W] = id; stack[sp++] = p + W; }
    }
    comps.push({ id, n, i0, i1, j0, j1, start: s0 });
  }
  return { lab, comps };
}

// Contour of one labelled component (corner walk keeping it on the right, as geo-blocks.mjs traceComponent).
// R is any { w, h, res, x0, z0 } grid; c is { id, n, start }. A closed contour has at most 4n edges, so a longer walk
// is a tracer bug: throw rather than emit a broken outline.
function traceLabel(R, lab, c) {
  const { w: W, h: H, res, x0, z0 } = R;
  const at = (i, j) => (i >= 0 && j >= 0 && i < W && j < H && lab[j * W + i] === c.id ? 1 : 0);
  const si = c.start % W, sj = (c.start - si) / W;
  const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
  let cx = si, cz = sj, dir = 0;
  const pts = [];
  const start = cx + ',' + cz + ',' + dir;
  let guard = 0;
  do {
    pts.push([x0 + cx * res, z0 + cz * res]);
    cx += DX[dir];
    cz += DZ[dir];
    let left, right;
    if (dir === 0) { left = at(cx, cz - 1); right = at(cx, cz); }
    else if (dir === 1) { left = at(cx, cz); right = at(cx - 1, cz); }
    else if (dir === 2) { left = at(cx - 1, cz); right = at(cx - 1, cz - 1); }
    else { left = at(cx - 1, cz - 1); right = at(cx, cz - 1); }
    if (left && right) dir = (dir + 3) % 4;
    else if (!right) dir = (dir + 1) % 4;
    if (++guard > 4 * c.n + 4) throw new Error(`block contour trace runaway (component ${c.id}, ${c.n} cells)`);
  } while (cx + ',' + cz + ',' + dir !== start);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[(i + pts.length - 1) % pts.length], qq = pts[i], n = pts[(i + 1) % pts.length];
    if ((qq[0] - p[0]) * (n[1] - qq[1]) - (qq[1] - p[1]) * (n[0] - qq[0]) !== 0) out.push(qq);
  }
  return out;
}

// True when two non-adjacent edges of the ring touch or cross, or a vertex repeats
export function ringSelfIntersects(r) {
  const n = r.length;
  const orient = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const onSeg = (a, b, c) => Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
  const hit = (a, b, c, d) => {
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (o1 !== o2 && o3 !== o4) return true;
    return (o1 === 0 && onSeg(a, b, c)) || (o2 === 0 && onSeg(a, b, d)) || (o3 === 0 && onSeg(c, d, a)) || (o4 === 0 && onSeg(c, d, b));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (hit(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) return true;
    }
  }
  return false;
}

// True when any edge of ring a touches or crosses any edge of ring b
function ringsIntersect(a, b) {
  const orient = (p, q1, r) => Math.sign((q1[0] - p[0]) * (r[1] - p[1]) - (q1[1] - p[1]) * (r[0] - p[0]));
  const onSeg = (p, q1, r) => Math.min(p[0], q1[0]) <= r[0] && r[0] <= Math.max(p[0], q1[0]) && Math.min(p[1], q1[1]) <= r[1] && r[1] <= Math.max(p[1], q1[1]);
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const p3 = b[j], p4 = b[(j + 1) % b.length];
      if (Math.max(p1[0], p2[0]) < Math.min(p3[0], p4[0]) || Math.max(p3[0], p4[0]) < Math.min(p1[0], p2[0])) continue;
      if (Math.max(p1[1], p2[1]) < Math.min(p3[1], p4[1]) || Math.max(p3[1], p4[1]) < Math.min(p1[1], p2[1])) continue;
      const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4), o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
      if (o1 !== o2 && o3 !== o4) return true;
      if ((o1 === 0 && onSeg(p1, p2, p3)) || (o2 === 0 && onSeg(p1, p2, p4)) || (o3 === 0 && onSeg(p3, p4, p1)) || (o4 === 0 && onSeg(p3, p4, p2))) return true;
    }
  }
  return false;
}

// Clean polygon of a traced contour: the smoothest of (destair + RDP 0.5 m, destair + RDP 0.25 m, destair, raw
// corners) that keeps a simple ring. Wound like the NYC blocks (negative shoelace area).
function polygonOf(raw, res, rawOnly = false) {
  const tries = [() => rdpRing(destair(raw, res * 1.5), 0.5), () => rdpRing(destair(raw, res * 1.5), 0.25), () => destair(raw, res * 1.5), () => raw];
  for (const make of rawOnly ? tries.slice(-1) : tries) {
    const r = make().map(([x, z]) => [q(x), q(z)]);
    if (r.length < 3 || ringSelfIntersects(r)) continue;
    if (ringArea(r) > 0) r.reverse();
    return r;
  }
  return null;
}

// Outline and holes of one labelled component. Holes are the cells of its bbox outside it that cannot reach the bbox
// border through other such cells (8-connected, so no hole touches the outline): water, or a roadway enclosed by the
// island. Holes under minHole m² are ignored. When independently simplified rings touch or cross, all rings fall back
// to the raw raster contour; a hole that still touches another ring, or has no simple ring, is dropped (counted in
// stats.holeConflicts).
// Returns { outer, holes, area } (area = outline minus holes, m²) or null when no simple outline exists.
function regionPolygons(R, lab, c, minHole, stats) {
  const { res } = R;
  const raw = traceLabel(R, lab, c);
  // window around the component with a one-cell margin, in its own little grid
  const ox = c.i0 - 1, oz = c.j0 - 1, ww = c.i1 - c.i0 + 3, wh = c.j1 - c.j0 + 3;
  const inC = new Uint8Array(ww * wh);
  for (let j = 1; j < wh - 1; j++) for (let i = 1; i < ww - 1; i++) inC[j * ww + i] = lab[(oz + j) * R.w + ox + i] === c.id ? 1 : 0;
  const reach = new Uint8Array(ww * wh);
  const stack = [];
  for (let i = 0; i < ww; i++) stack.push(i, (wh - 1) * ww + i);
  for (let j = 1; j < wh - 1; j++) stack.push(j * ww, j * ww + ww - 1);
  for (const k of stack) reach[k] = 1;
  while (stack.length) {
    const k = stack.pop(), i = k % ww, j = (k - i) / ww;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= ww || jj >= wh) continue;
      const kk = jj * ww + ii;
      if (!reach[kk] && !inC[kk]) { reach[kk] = 1; stack.push(kk); }
    }
  }
  const H = new Uint8Array(ww * wh);
  for (let k = 0; k < ww * wh; k++) H[k] = !inC[k] && !reach[k] ? 1 : 0;
  const local = { w: ww, h: wh, res, x0: R.x0 + ox * res, z0: R.z0 + oz * res };
  const { lab: hl, comps: hcs } = label(H, ww, wh, new Int32Array(ww * wh));
  const holeRaws = [];
  for (const hc of hcs) {
    if (hc.n * res * res < minHole) { stats.smallHoles++; continue; }
    holeRaws.push(traceLabel(local, hl, hc));
  }

  const build = (rawOnly) => {
    const outer = polygonOf(raw, res, rawOnly);
    if (!outer) return null;
    const holes = [];
    for (const h of holeRaws) {
      const r = polygonOf(h, res, rawOnly);
      if (r) holes.push(r.reverse()); // holes wind the other way
    }
    return { outer, holes };
  };
  const clashes = (p) => p.holes.some((h, i) => ringsIntersect(p.outer, h) || p.holes.some((g, j) => j > i && ringsIntersect(h, g)));
  let p = build(false);
  if (!p) return null;
  if (clashes(p)) {
    p = build(true);
    if (!p) return null;
    p.holes = p.holes.filter((h) => !ringsIntersect(p.outer, h));
    for (let i = p.holes.length - 1; i >= 0; i--) {
      if (p.holes.some((g, j) => j !== i && ringsIntersect(p.holes[i], g))) p.holes.splice(i, 1);
    }
  }
  stats.holeConflicts += holeRaws.length - p.holes.length; // holes with no simple ring, or touching another ring
  p.area = Math.abs(ringArea(p.outer)) - p.holes.reduce((t, h) => t + Math.abs(ringArea(h)), 0);
  return p;
}

export function buildBlocks(cut, water, box = BBOX_M, params = BLOCK_PARAMS) {
  const { res, sidewalk, minArea, minHole } = params;
  const R = new Raster(box.x0, box.z0, box.x1, box.z1, res);
  const W = R.w, H = R.h, D = R.d;
  // Cells whose centre lies inside the bbox start as land; the first/last such row & column are the bbox edge
  const ci0 = Math.max(0, Math.ceil((box.x0 - R.x0) / res - 0.5)), ci1 = Math.min(W - 1, Math.floor((box.x1 - R.x0) / res - 0.5));
  const cj0 = Math.max(0, Math.ceil((box.z0 - R.z0) / res - 0.5)), cj1 = Math.min(H - 1, Math.floor((box.z1 - R.z0) / res - 0.5));
  for (let j = cj0; j <= cj1; j++) D.fill(1, j * W + ci0, j * W + ci1 + 1);
  for (const wtr of water) fillRings(R, [unflat(wtr.outer), ...wtr.holes.map(unflat)], 0);
  // Stamp each roadway as capsules at its curb width
  for (const { pts, r } of cut) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - R.x0) / res));
      const ix1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + r - R.x0) / res));
      const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - r - R.z0) / res));
      const iz1 = Math.min(H - 1, Math.ceil((Math.max(az, bz) + r - R.z0) / res));
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz || 1e-9;
      const r2 = r * r;
      for (let j = iz0; j <= iz1; j++) {
        const pz = R.z0 + (j + 0.5) * res;
        for (let i = ix0; i <= ix1; i++) {
          const kk = j * W + i;
          if (!D[kk]) continue;
          const px = R.x0 + (i + 0.5) * res;
          let t = ((px - ax) * dx + (pz - az) * dz) / L2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + t * dx - px, ez = az + t * dz - pz;
          if (ex * ex + ez * ez <= r2) D[kk] = 0;
        }
      }
    }
  }

  const stack = new Int32Array(W * H);
  const { lab, comps } = label(D, W, H, stack);
  // Property line: island cells more than `sidewalk` from any road, water or outside cell
  const toEdge = R.edt((v) => v === 0);
  const th = (sidewalk / res + 0.5) ** 2;
  const P = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) P[k] = toEdge[k] > th ? 1 : 0;
  const props = label(P, W, H, stack);
  const lotOf = new Map(); // island id -> its largest property-line component
  for (const pc of props.comps) {
    const owner = lab[pc.start];
    const best = lotOf.get(owner);
    if (!best || pc.n > best.n) lotOf.set(owner, pc);
  }

  const blocks = [];
  const dropped = { small: 0, edge: 0, invalid: 0, lotInvalid: 0, smallHoles: 0, holeConflicts: 0 };
  for (const c of comps) {
    if (c.i0 <= ci0 || c.i1 >= ci1 || c.j0 <= cj0 || c.j1 >= cj1) { dropped.edge++; continue; }
    if (c.n * res * res < minArea) { dropped.small++; continue; }
    const curb = regionPolygons(R, lab, c, minHole, dropped);
    if (!curb) { dropped.invalid++; continue; }
    const pc = lotOf.get(c.id);
    const lot = pc ? regionPolygons(R, props.lab, pc, minHole, dropped) : null;
    if (pc && !lot) dropped.lotInvalid++;
    blocks.push({
      area: Math.round(curb.area),
      curb: flat(curb.outer),
      curbHoles: curb.holes.map(flat),
      lot: lot ? flat(lot.outer) : null,
      lotHoles: lot ? lot.holes.map(flat) : []
    });
  }
  return { blocks, dropped };
}

// =====================================================================================================================
// 4. BUILD
// =====================================================================================================================
export function buildGfGeo(roadsJson, waterJson) {
  for (const [name, j] of [['roads', roadsJson], ['water', waterJson]]) {
    if (!Array.isArray(j.elements) || j.remark) throw new Error(`incomplete Overpass response for ${name}`);
  }
  const { roadGraph, roads, cut, stats } = buildRoads(roadsJson.elements);
  const { water, skipped } = buildWater(waterJson.elements);
  const { blocks, dropped } = buildBlocks(cut, water);
  const geo = {
    version: VERSION,
    frame: { lat0: LAT0, lon0: LON0, theta: THETA },
    bbox: { ...BBOX, ...BBOX_M },
    osmBase: (roadsJson.osm3s && roadsJson.osm3s.timestamp_osm_base) || null,
    roadGraph,
    roadFields: ['way', 'links'],
    roads,
    blocks,
    water,
    attribution: ATTRIBUTION
  };
  return { geo, report: { stats, skipped, dropped } };
}

// One top-level key per line, one link / road / block / water polygon per line: diffs stay readable
export function serialize(geo) {
  const lines = [
    '// js/gf-geodata.js — GENERATED by tools/gf/build-gf-geodata.mjs, do not edit by hand.',
    '// Glens Falls & South Glens Falls, NY in a local frame: 1 unit = 1 m, x = east, z = south (north = -z), origin at',
    `// ${LAT0}°N ${-LON0}°W (provisional downtown centroid), axes on true north. Polygons & polylines are flat`,
    '// [x0, z0, x1, z1, ...] arrays. roadGraph.links rows follow roadGraph.linkFields; `pts` are the inner shape points.',
    `// Data ${ATTRIBUTION}`,
    'export const GF_GEO = {'
  ];
  const keys = Object.keys(geo);
  keys.forEach((k, i) => {
    const v = geo[k];
    const end = i < keys.length - 1 ? ',' : '';
    const list = (arr) => (arr.length ? `[\n${arr.map((x) => '    ' + JSON.stringify(x)).join(',\n')}\n  ]` : '[]');
    if (k === 'roadGraph') {
      const { links, ...rest } = v;
      lines.push(`  roadGraph: {`);
      for (const [rk, rv] of Object.entries(rest)) lines.push(`    ${rk}: ${JSON.stringify(rv)},`);
      lines.push(`    links: ${list(links).replace(/\n/g, '\n  ')}`, `  }${end}`);
    } else if (Array.isArray(v) && v.length && typeof v[0] === 'object') lines.push(`  ${k}: ${list(v)}${end}`);
    else lines.push(`  ${k}: ${JSON.stringify(v)}${end}`);
  });
  lines.push('};', '');
  return lines.join('\n');
}

function main() {
  const DATA = process.env.GF_DATA || fileURLToPath(new URL('data/', import.meta.url));
  const OUT = process.argv[2] || fileURLToPath(new URL('../../js/gf-geodata.js', import.meta.url));
  const load = (f) => {
    const p = path.join(DATA, f);
    if (!fs.existsSync(p)) throw new Error(`${p} is missing: run bash tools/gf/fetch.sh first`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };
  const { geo, report } = buildGfGeo(load('osm_gf_roads.json'), load('osm_gf_water.json'));
  const { stats, skipped, dropped } = report;
  const text = serialize(geo);
  fs.writeFileSync(OUT, text);

  const g = geo.roadGraph;
  log(`OSM base ${geo.osmBase}; bbox ${(geo.bbox.x1 - geo.bbox.x0).toFixed(1)} x ${(geo.bbox.z1 - geo.bbox.z0).toFixed(1)} m`);
  log(`road graph: ${g.nodes.length / 2} nodes (${stats.crossings} at the bbox edge), ${g.links.length} links from ${stats.ways} OSM ways (${geo.roads.length} way pieces)`);
  const totalKm = Object.values(stats.km).reduce((t, v) => t + v, 0);
  for (const c of Object.keys(stats.km).sort()) log(`  ${c.padEnd(15)} ${stats.km[c].toFixed(2).padStart(8)} km`);
  log(`  ${'total'.padEnd(15)} ${totalKm.toFixed(2).padStart(8)} km`);
  log(`link widths: ${stats.widthSource.width} from width tags, ${stats.widthSource.lanes} from lanes, ${stats.widthSource.default} class defaults; ${stats.unnamed} unnamed links`);
  log(`blocks: ${geo.blocks.length} kept (${geo.blocks.filter((b) => !b.lot).length} without a property line); dropped ${dropped.edge} touching the bbox edge, ${dropped.small} under ${BLOCK_PARAMS.minArea} m², ${dropped.invalid} with no simple outline`);
  const nHoles = geo.blocks.reduce((t, b) => t + b.curbHoles.length, 0);
  log(`block holes (water or enclosed roadway): ${nHoles} in ${geo.blocks.filter((b) => b.curbHoles.length).length} blocks; ${dropped.smallHoles} under ${BLOCK_PARAMS.minHole} m² ignored, ${dropped.holeConflicts} dropped (touching another ring or not simple)`);
  log(`water: ${geo.water.length} polygons (${geo.water.map((w) => w.name || w.osm).join(', ')})`);
  for (const s of skipped) log(`  water skipped: ${s}`);
  const kb = Buffer.byteLength(text) / 1024;
  log(`wrote ${path.relative(process.cwd(), OUT)} (${kb.toFixed(1)} KB)${kb > 1024 ? ' — WARNING: over the 1 MB target' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
