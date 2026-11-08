// tools/gf/build-gf-crandall-trails.mjs — CC-005c: the accepted walking network (tools/gf/data/gf_crandall_trails.geojson)
// as game data, js/gf-trails.js (deterministic: the same input gives the same bytes).
// usage: node tools/gf/build-gf-crandall-trails.mjs [out.js]
//
// - Local x, z with the game's frame (geo-frame.mjs toLocal), rounded to 1 cm.
// - A graph: the accepted lines split at every node another accepted line shares (OSM node topology; a crossing in plan
//   with no shared node is not a junction), each edge its polyline, width (tagged, or the documented 2.0 m gameplay
//   assumption), surface, kind (path, footbridge, or park drive: the drive's own centre line) and source way.
// - Entrances: where an accepted line reaches a street, it is cut where it meets the game's outer sidewalk walking line
//   (the road's half width + 1.2 m, gf-main.js PEDESTRIANS.trackInsets), so walkers join the sidewalk on the same side
//   and never walk into the roadway; where it ends on a mapped sidewalk, its end is the entrance. The road link is the
//   nearest GF_GEO road-graph link to the street node.
// - Footbridges (bridge=yes, layer 1): decks for gf-surface.js (opt-in footDecks): their heights come from the terrain at
//   run time by CC-005b's deck rule, never from here.
// - Tree exclusions: CC-005 tree placements (gf-tree-placements.js, the ones actually placed) whose trunk collider
//   square comes within the corridor of an accepted path or footbridge: half its width + the player's body radius
//   (0.48 m, controllers.js person). Park drives are roads: trees on them are already skipped by CC-005's road check.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toLocal } from './geo-frame.mjs';
import { GF_GEO } from '../../js/gf-geodata.js';
import { GF_TREES } from '../../js/gf-trees.js';
import { GF_BUILDINGS } from '../../js/gf-buildings.js';
import { placeGfTrees, TRUNK } from '../../js/gf-tree-placements.js';
import zlib from 'node:zlib';
import { decodeTerrain, createGfTerrain } from '../../js/gf-terrain.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const INPUT = path.join(HERE, 'data/gf_crandall_trails.geojson');
const TERRAIN = path.join(ROOT, 'js/gf-terrain.bin.gz');
const SIDEWALK_LINE = 1.2; // m beyond the roadway's half width: the game's outer walking line (gf-main.js trackInsets)
const SIDEWALK_SNAP = 5.0; // m: the most an entrance on a mapped sidewalk may sit from the game's walking line (the game
// draws every sidewalk as a 1.8 m band at the curb; OSM maps it where it is, a grass strip away on Glen Street: the same
// sidewalk, so its junction with the path is joined to the game's line, not a new trail)
const BODY = 0.48; // m: the player's person radius (controllers.js), the tree-clearance margin beyond a path's half width
const r2 = (v) => Math.round(v * 100) / 100;

// Distance from point p to segment ab, and the parameter along it
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return [Math.hypot(ax + dx * t - px, az + dz * t - pz), t];
}
// Distance between segment ab and the axis-aligned square of half size h around (cx, cz) (0 if they touch)
function segSquareDist(ax, az, bx, bz, cx, cz, h) {
  const inside = (x, z) => Math.abs(x - cx) <= h && Math.abs(z - cz) <= h;
  if (inside(ax, az) || inside(bx, bz)) return 0;
  const corners = [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]];
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (let i = 0; i < 4; i++) {
    const c = corners[i], d = corners[(i + 1) % 4], a = [ax, az], b = [bx, bz];
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  }
  let best = Infinity;
  for (const [x, z] of corners) best = Math.min(best, segDist(x, z, ax, az, bx, bz)[0]);
  for (const [x, z] of [[ax, az], [bx, bz]]) {
    const dx = Math.max(Math.abs(x - cx) - h, 0), dz = Math.max(Math.abs(z - cz) - h, 0);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

// The corridor is dry and open: every edge sampled every CORRIDOR_STEP m along its centre line and both edges of its
// width stays out of mapped water (GF_GEO.water; a footbridge, which has a deck, excepted) and out of every building
// footprint (GF_BUILDINGS). Dry endpoints do not excuse a pond in the middle. water: [{ outer, holes }] and buildings:
// [{ outer, holes }], flat [x, z, ...] rings.
const CORRIDOR_STEP = 0.5;
const inRing = (flat, x, z) => {
  let ins = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const xi = flat[i], zi = flat[i + 1], xj = flat[j], zj = flat[j + 1];
    if ((zi > z) !== (zj > z) && x < xi + ((xj - xi) * (z - zi)) / (zj - zi)) ins = !ins;
  }
  return ins;
};
const inShape = (p, x, z) => inRing(p.outer, x, z) && !(p.holes || []).some((h) => inRing(h, x, z));
function checkCorridor(edges, { water, buildings }) {
  const box = (p) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let i = 0; i < p.outer.length; i += 2) { a = Math.min(a, p.outer[i]); b = Math.max(b, p.outer[i]); c = Math.min(c, p.outer[i + 1]); d = Math.max(d, p.outer[i + 1]); } return { p, a, b, c, d }; };
  const W = water.map(box), B = buildings.map(box);
  for (const e of edges) {
    const half = e.widthM / 2;
    for (let k = 0; k + 3 < e.pts.length; k += 2) {
      const [ax, az, bx, bz] = e.pts.slice(k, k + 4), l = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(l / CORRIDOR_STEP));
      const nx = -(bz - az) / l, nz = (bx - ax) / l;
      for (let i = 0; i <= n; i++) for (const o of [0, -half, half]) {
        const x = ax + ((bx - ax) * i) / n + nx * o, z = az + ((bz - az) * i) / n + nz * o;
        const hit = (list) => list.find((q) => x >= q.a && x <= q.b && z >= q.c && z <= q.d && inShape(q.p, x, z));
        if (e.kind !== 'footbridge') { const w = hit(W); if (w) throw new Error(`${e.id}: in water (${w.p.name || w.p.osm}) at (${x.toFixed(2)}, ${z.toFixed(2)})`); }
        const b = hit(B);
        if (b) throw new Error(`${e.id}: in a building (${b.p.osm}) at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
  }
}

function roadSegments() {
  const g = GF_GEO.roadGraph, at = Object.fromEntries(g.linkFields.map((f, k) => [f, k]));
  const segs = [];
  g.links.forEach((l, li) => {
    const pts = [[g.nodes[l[at.a] * 2], g.nodes[l[at.a] * 2 + 1]]];
    for (let k = 0; k < l[at.pts].length; k += 2) pts.push([l[at.pts][k], l[at.pts][k + 1]]);
    pts.push([g.nodes[l[at.b] * 2], g.nodes[l[at.b] * 2 + 1]]);
    for (let k = 0; k + 1 < pts.length; k++) segs.push({ link: li, cls: g.classes[l[at.highway]], name: g.names[l[at.name]], half: l[at.width] / 2, a: pts[k], b: pts[k + 1] });
  });
  return segs;
}

function buildTrails(fc = JSON.parse(fs.readFileSync(INPUT, 'utf8')), inputSha = crypto.createHash('sha256').update(fs.readFileSync(INPUT)).digest('hex')) {
  const lines = fc.features.filter((f) => f.properties.accepted && f.geometry.type === 'LineString');
  const entrances = fc.features.filter((f) => f.properties.kind === 'entrance');
  for (const f of lines) {
    const { nodeIds } = f.properties, c = f.geometry.coordinates;
    if (!Array.isArray(nodeIds) || nodeIds.length !== c.length || c.length < 2) throw new Error(`${f.properties.id}: node ids and coordinates disagree`);
    for (const [lon, lat] of c) if (!(lon > -74 && lon < -73 && lat > 43 && lat < 44)) throw new Error(`${f.properties.id}: coordinate outside Glens Falls (${lon}, ${lat})`);
    if (!f.properties.sourceUrl || !f.properties.pedestrianAccess) throw new Error(`${f.properties.id}: missing source or access`);
    const w = f.properties.widthM;
    if (w !== null && !(w >= 0.8 && w <= 6)) throw new Error(`${f.properties.id}: impossible width ${w}`);
  }
  const ids = new Set();
  for (const f of lines) { if (ids.has(f.properties.id)) throw new Error(`duplicate line ${f.properties.id}`); ids.add(f.properties.id); }

  // OSM nodes: their local position; the graph's nodes are line ends and nodes shared by two lines
  const pos = new Map(), uses = new Map();
  for (const f of lines) f.properties.nodeIds.forEach((n, i) => {
    const p = toLocal(...f.geometry.coordinates[i]);
    const prev = pos.get(n);
    if (prev && Math.hypot(prev[0] - p[0], prev[1] - p[1]) > 1e-6) throw new Error(`node ${n} has two positions`);
    pos.set(n, p);
    uses.set(n, (uses.get(n) || 0) + 1);
  });
  const isVertex = (f, i) => i === 0 || i === f.properties.nodeIds.length - 1 || uses.get(f.properties.nodeIds[i]) > 1;

  // Entrance cuts: street entrances end on the street's node; cut the line where it reaches the outer walking line
  const roads = roadSegments();
  const cutAt = new Map(); // osm node -> { x, z, street, link, half, kind }
  for (const e of entrances) {
    const n = e.properties.nodeId, p = pos.get(n);
    if (!p) throw new Error(`entrance ${n} is not on an accepted line`);
    let best = null;
    for (const s of roads) {
      if (s.cls === 'service') continue;
      const [d, t] = segDist(p[0], p[1], s.a[0], s.a[1], s.b[0], s.b[1]);
      if (!best || d < best.d) best = { d, t, s };
    }
    cutAt.set(n, { street: e.properties.street, sidewalkWay: e.properties.sidewalkWay, link: best.s.link, half: best.s.half, roadName: best.s.name, seg: best.s, dist: best.d });
  }

  // A park drive is already a drawn service road of the game (gf-geodata.js; drawn, not driven: gf-roadgraph.js): its
  // walking width is that road's, read from the link under its middle
  const driveWidth = (pts, id) => {
    const [mx, mz] = pts[Math.floor(pts.length / 2)];
    let best = null;
    for (const s of roads) {
      if (s.cls !== 'service') continue;
      const [d] = segDist(mx, mz, s.a[0], s.a[1], s.b[0], s.b[1]);
      if (!best || d < best.d) best = { d, s };
    }
    if (!best || best.d > 0.5) throw new Error(`${id}: no service road of the game under the drive`);
    return { widthM: r2(best.s.half * 2), widthBasis: `the game's service road (road graph link ${best.s.link}, gf-geodata.js)` };
  };
  const nodes = [], nodeIndex = new Map(), nodeInfo = [];
  const addNode = (key, x, z, info) => {
    if (nodeIndex.has(key)) return nodeIndex.get(key);
    nodeIndex.set(key, nodes.length / 2);
    nodes.push(r2(x), r2(z));
    nodeInfo.push(info);
    return nodeIndex.get(key);
  };
  const edges = [];
  const sortedLines = [...lines].sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1));
  for (const f of sortedLines) {
    const ids = f.properties.nodeIds;
    let start = 0;
    for (let i = 1; i < ids.length; i++) {
      if (!isVertex(f, i)) continue;
      let pts = ids.slice(start, i + 1).map((n) => pos.get(n).slice());
      let aKey = ids[start], bKey = ids[i];
      // an entrance end: cut the line where it leaves the street's sidewalk band
      for (const end of [0, 1]) {
        const key = end ? bKey : aKey, cut = cutAt.get(key);
        if (!cut) continue;
        const seq = end ? pts.slice().reverse() : pts;
        const s = cut.seg, limit = cut.half + SIDEWALK_LINE;
        const far = (q) => segDist(q[0], q[1], s.a[0], s.a[1], s.b[0], s.b[1])[0];
        let out;
        if (far(seq[0]) >= limit - 1e-6) {
          // on a mapped sidewalk beyond the walking line: its own end is the entrance (snapped onto the line, below)
          out = seq;
        } else {
          let k = 0;
          while (k + 1 < seq.length && far(seq[k + 1]) < limit) k++;
          if (k + 1 >= seq.length) throw new Error(`${f.properties.id}: never leaves the street at ${key}`);
          // bisect along seq[k] -> seq[k + 1] for the point at the walking line
          let lo = 0, hi = 1;
          for (let it = 0; it < 50; it++) { const m = (lo + hi) / 2, q = [seq[k][0] + (seq[k + 1][0] - seq[k][0]) * m, seq[k][1] + (seq[k + 1][1] - seq[k][1]) * m]; if (far(q) < limit) lo = m; else hi = m; }
          const q = [seq[k][0] + (seq[k + 1][0] - seq[k][0]) * hi, seq[k][1] + (seq[k + 1][1] - seq[k][1]) * hi];
          out = [q, ...seq.slice(k + 1)];
          cut.trimmedM = Math.hypot(q[0] - seq[0][0], q[1] - seq[0][1]);
        }
        pts = end ? out.reverse() : out;
        if (end) bKey = `entrance:${key}`; else aKey = `entrance:${key}`;
        cut.point = end ? pts[pts.length - 1] : pts[0];
      }
      const kind = f.properties.group === 'park-drive' ? 'drive' : f.properties.bridge ? 'footbridge' : 'path';
      const a = addNode(aKey, ...pts[0], { osm: aKey.replace('entrance:', ''), entrance: aKey.startsWith('entrance:') });
      const b = addNode(bKey, ...pts[pts.length - 1], { osm: bKey.replace('entrance:', ''), entrance: bKey.startsWith('entrance:') });
      let len = 0;
      for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (!(len > 0.05)) throw new Error(`${f.properties.id}: zero-length edge`);
      edges.push({
        id: start === 0 && i === ids.length - 1 ? f.properties.id : `${f.properties.id}#${start}-${i}`, line: f.properties.id, way: f.properties.osmWayId,
        group: f.properties.group, kind, a, b, lengthM: r2(len), ...(kind === 'drive' ? driveWidth(pts, f.properties.id) : { widthM: f.properties.widthM, widthBasis: f.properties.widthBasis }),
        surface: f.properties.surface, pts: pts.flatMap(([x, z]) => [r2(x), r2(z)])
      });
      start = i;
    }
  }

  // Thrill Hill's crest on the trail: the highest point of the game's terrain (0.5 m steps) along the accepted edges of
  // the hill way becomes a graph node of its own (splitting its edge), so walkers make for the top itself rather than
  // the junction below it. County loop vertex #137 (Dave's identification) is reported beside it: the mapped path runs
  // a few metres from the county line, and neither is surveyed (the anchor uncertainty of the PR report).
  const hillWay = fc.provenance.hill.pathWay;
  const data = decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(TERRAIN))));
  const terrain = createGfTerrain(data, GF_GEO.frame);
  let crest = null;
  for (const e of edges) {
    if (e.way !== hillWay) continue;
    for (let k = 0; k + 3 < e.pts.length; k += 2) {
      const [ax, az, bx, bz] = e.pts.slice(k, k + 4), l = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(l / 0.5));
      for (let i = 0; i <= n; i++) {
        const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n, y = terrain.heightAt(x, z);
        if (!crest || y > crest.y + 1e-9) crest = { e, k, x, z, y };
      }
    }
  }
  if (!crest) throw new Error(`the hill way ${hillWay} has no accepted edge`);
  const [vx, vz] = toLocal(...fc.provenance.hill.countyLoopCoordinates);
  const crestNode = addNode('crest', crest.x, crest.z, { osm: null, entrance: false, crest: true });
  {
    const e = crest.e, at = edges.indexOf(e);
    const head = [...e.pts.slice(0, crest.k + 2), r2(crest.x), r2(crest.z)], tail = [r2(crest.x), r2(crest.z), ...e.pts.slice(crest.k + 2)];
    const clean = (p) => { const out = [p[0], p[1]]; for (let i = 2; i < p.length; i += 2) if (Math.hypot(p[i] - out[out.length - 2], p[i + 1] - out[out.length - 1]) > 0.05) out.push(p[i], p[i + 1]); return out; };
    const part = (pts, a, b, tag) => {
      let len = 0;
      for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      return { ...e, id: `${e.id}~${tag}`, a, b, lengthM: r2(len), pts };
    };
    const parts = [];
    const h = clean(head), t = clean(tail);
    if (h.length >= 4) parts.push(part(h, e.a, crestNode, 'to-crest'));
    if (t.length >= 4) parts.push(part(t, crestNode, e.b, 'from-crest'));
    edges.splice(at, 1, ...parts);
  }
  const hillInfo = {
    node: crestNode, crestX: r2(crest.x), crestZ: r2(crest.z), crestY: r2(crest.y), crestNavd88: r2(crest.y + data.header.anchor.navd88),
    countyVertex: fc.provenance.hill.countyLoopVertex, vertexX: r2(vx), vertexZ: r2(vz), vertexGroundNavd88: r2(terrain.heightAt(vx, vz) + data.header.anchor.navd88),
    crestToVertexM: r2(Math.hypot(crest.x - vx, crest.z - vz)), pathWay: hillWay, pathJunctionOsm: fc.provenance.hill.pathNode,
    identity: fc.provenance.hill.identity
  };

  // Entrances: the graph node and where it meets the game's outer walking line (the foot of the perpendicular on it)
  const entranceOut = [];
  for (const [n, cut] of [...cutAt].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const node = nodeIndex.get(`entrance:${n}`);
    if (node === undefined) throw new Error(`entrance ${n} has no graph node`);
    const [px, pz] = cut.point, s = cut.seg;
    const [, t] = segDist(px, pz, s.a[0], s.a[1], s.b[0], s.b[1]);
    const fx = s.a[0] + (s.b[0] - s.a[0]) * t, fz = s.a[1] + (s.b[1] - s.a[1]) * t;
    const d = Math.hypot(px - fx, pz - fz), lineD = cut.half + SIDEWALK_LINE;
    const sx = fx + (px - fx) * (lineD / d), sz = fz + (pz - fz) * (lineD / d);
    const snap = Math.hypot(sx - px, sz - pz);
    if (snap > SIDEWALK_SNAP) throw new Error(`entrance ${n}: ${snap.toFixed(2)} m from the walking line`);
    // which side of the road (as the link runs): +1 left, -1 right
    const side = Math.sign((s.b[0] - s.a[0]) * (pz - s.a[1]) - (s.b[1] - s.a[1]) * (px - s.a[0]));
    entranceOut.push({ node, osmNode: n, street: cut.street || cut.roadName, sidewalkWay: cut.sidewalkWay ? `w${cut.sidewalkWay}` : null,
      roadLink: cut.link, roadName: cut.roadName, roadHalfM: cut.half, side, sidewalkX: r2(sx), sidewalkZ: r2(sz), snapM: r2(snap), trimmedM: r2(cut.trimmedM || 0) });
  }

  {
    const F = Object.fromEntries(GF_BUILDINGS.fields.map((name, i) => [name, i]));
    checkCorridor(edges, { water: GF_GEO.water, buildings: GF_BUILDINGS.buildings.map((b) => ({ osm: b[F.osm], outer: b[F.outer], holes: b[F.holes] })) });
  }

  // Components (each must reach an entrance) and the hill node
  const adj = Array.from({ length: nodes.length / 2 }, () => []);
  edges.forEach((e, k) => { adj[e.a].push(k); adj[e.b].push(k); });
  const comp = new Array(nodes.length / 2).fill(-1);
  let nComp = 0;
  for (let s = 0; s < comp.length; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s]; comp[s] = nComp;
    while (stack.length) { const u = stack.pop(); for (const k of adj[u]) { const v = edges[k].a === u ? edges[k].b : edges[k].a; if (comp[v] < 0) { comp[v] = nComp; stack.push(v); } } }
    nComp++;
  }
  const components = Array.from({ length: nComp }, (_, c) => ({
    nodes: comp.filter((x) => x === c).length, edges: edges.filter((e) => comp[e.a] === c).length,
    lengthM: r2(edges.filter((e) => comp[e.a] === c).reduce((t, e) => t + e.lengthM, 0)),
    entrances: entranceOut.filter((e) => comp[e.node] === c).map((e) => e.osmNode)
  }));
  for (const [c, k] of components.entries()) if (!k.entrances.length) throw new Error(`component ${c} has no entrance`);

  // Footbridge decks (heights from the terrain at run time)
  const footDecks = edges.filter((e) => e.kind === 'footbridge').map((e) => ({ id: e.id, way: e.way, widthM: e.widthM, pts: e.pts }));

  // Tree exclusions: placed trees whose trunk square reaches a path's or footbridge's corridor
  const placed = placeGfTrees(GF_TREES, { buildings: GF_BUILDINGS, geo: GF_GEO });
  const corridor = edges.filter((e) => e.kind !== 'drive');
  const excluded = [];
  for (const site of placed.sites) {
    const t = GF_TREES.trees, i = site.index;
    const h = t[i * 4 + 2], half = Math.max(TRUNK.minHalf, TRUNK.halfPerM * h);
    for (const e of corridor) {
      const reach = e.widthM / 2 + BODY;
      let hit = false;
      for (let k = 0; k + 3 < e.pts.length && !hit; k += 2) {
        const [ax, az, bx, bz] = [e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3]];
        if (Math.min(ax, bx) - reach - half > site.x || Math.max(ax, bx) + reach + half < site.x || Math.min(az, bz) - reach - half > site.z || Math.max(az, bz) + reach + half < site.z) continue;
        if (segSquareDist(ax, az, bx, bz, site.x, site.z, half) < reach) hit = true;
      }
      if (hit) { excluded.push([i, r2(site.x), r2(site.z), r2(h), r2(half), e.id]); break; }
    }
  }
  excluded.sort((a, b) => a[0] - b[0]);

  const lengths = {};
  for (const e of edges) lengths[e.kind] = r2((lengths[e.kind] || 0) + e.lengthM);
  return {
    source: 'tools/gf/data/gf_crandall_trails.geojson', sha256: inputSha, generator: 'tools/gf/build-gf-crandall-trails.mjs',
    attribution: fc.provenance.attribution, historicalBasis: fc.provenance.historicalBasis,
    constants: { sidewalkLineM: SIDEWALK_LINE, sidewalkSnapM: SIDEWALK_SNAP, bodyRadiusM: BODY, trunk: TRUNK },
    counts: { lines: lines.length, nodes: nodes.length / 2, edges: edges.length, entrances: entranceOut.length, components: nComp, footDecks: footDecks.length, treeExclusions: excluded.length,
      excludedSources: fc.features.filter((f) => !f.properties.accepted).length },
    lengthsM: lengths, components,
    hill: hillInfo,
    nodes, nodeInfo, edges, entrances: entranceOut, footDecks,
    treeExclusions: { fields: ['treeIndex', 'x', 'z', 'heightM', 'trunkHalfM', 'edge'], rule: `trunk square within the corridor: half the path width + ${BODY} m (player body); paths and footbridges only`, trees: excluded }
  };
}

const moduleText = (data) => `// generated by tools/gf/build-gf-crandall-trails.mjs from tools/gf/data/gf_crandall_trails.geojson (do not edit)\n` +
  `// CC-005c: Crandall Park's paths and the Cole's Woods corridor to Thrill Hill. ${data.attribution}\n` +
  `export const GF_TRAILS = ${JSON.stringify(data)};\n`;

function main() {
  const out = process.argv[2] || path.join(ROOT, 'js/gf-trails.js');
  const data = buildTrails();
  fs.writeFileSync(out, moduleText(data));
  console.log(`[gf-trails] ${data.counts.edges} edges, ${data.counts.nodes} nodes, ${data.counts.entrances} entrances, ${data.counts.components} components, ${data.counts.footDecks} footbridges, ${data.counts.treeExclusions} trees excluded; lengths ${JSON.stringify(data.lengthsM)}; wrote ${path.relative(ROOT, out)}`);
  for (const e of data.entrances) console.log(`  entrance ${e.osmNode} ${e.street || e.sidewalkWay}: snap ${e.snapM} m, trimmed ${e.trimmedM} m, side ${e.side}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

export { buildTrails, moduleText, checkCorridor, segSquareDist, BODY, SIDEWALK_LINE };
