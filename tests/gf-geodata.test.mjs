import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toLocal, toLonLat, BBOX, BBOX_M } from '../tools/gf/geo-frame.mjs';
import {
  parseWidth, roadWidth, onewayOf, clipPolyline, joinRings, buildRoads, buildWater, buildBlocks, WIDTH_DEFAULTS, LANE_WIDTH,
  capsuleGrid, snapPoint, snapRing, cutLoops, tidyRing, SNAP
} from '../tools/gf/build-gf-geodata.mjs';
import { sidewalkBandAt } from '../js/gf-sidewalks.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(root, 'js/gf-geodata.js');
const RAW = path.join(root, 'tools/gf/data');
const built = fs.existsSync(OUT);
const fetched = fs.existsSync(path.join(RAW, 'osm_gf_roads.json')) && fs.existsSync(path.join(RAW, 'osm_gf_water.json'));
const NOT_BUILT = 'js/gf-geodata.js is not built yet (bash tools/gf/fetch.sh && node tools/gf/build-gf-geodata.mjs)';
const NOT_FETCHED = 'the raw OSM extract is not in tools/gf/data/ yet (bash tools/gf/fetch.sh)';

// --- Pipeline units on a synthetic fixture (abstract test input, not Glens Falls geography) ----------------------
let nextId = 1;
const node = (x, z) => { const [lon, lat] = toLonLat(x, z); return { type: 'node', id: nextId++, lon, lat }; };
const way = (nodes, tags) => ({ type: 'way', id: nextId++, nodes: nodes.map((n) => n.id), tags });
// A 4 x 4 street grid at 100 m spacing (its outer streets cross the test box), a pond and a canal line
function fixture() {
  nextId = 1;
  const els = [];
  const grid = [];
  for (let j = 0; j < 4; j++) {
    grid.push([]);
    for (let i = 0; i < 4; i++) { const n = node(-150 + i * 100, -150 + j * 100); grid[j].push(n); els.push(n); }
  }
  for (let j = 0; j < 4; j++) els.push(way(grid[j], { highway: j === 1 ? 'primary' : 'residential', name: `Row ${j}` }));
  for (let i = 0; i < 4; i++) els.push(way(grid.map((r) => r[i]), { highway: 'residential', name: `Column ${i}`, lanes: '2' }));
  const driveway = [node(-40, -90), node(-40, -70)];
  els.push(...driveway, way([grid[1][1], ...driveway], { highway: 'service', service: 'driveway' }));
  const pond = [node(10, 10), node(40, 10), node(40, 40), node(10, 40)];
  els.push(...pond, way([...pond, pond[0]], { natural: 'water', name: 'Test Pond' }));
  const canal = [node(-200, 60), node(200, 60)];
  els.push(...canal, way(canal, { waterway: 'canal', name: 'Test Canal' }));
  return els;
}
const BOX = { x0: -120, x1: 120, z0: -120, z1: 120 };

test('frame: the local frame round-trips and the bbox is an axis-aligned rectangle', () => {
  const [x, z] = toLocal(...toLonLat(1234.5, -678.9));
  assert.ok(Math.abs(x - 1234.5) < 1e-6 && Math.abs(z + 678.9) < 1e-6);
  const [xn, zn] = toLocal(BBOX.west, BBOX.north);
  assert.ok(Math.abs(xn - BBOX_M.x0) < 0.06 && Math.abs(zn - BBOX_M.z0) < 0.06, 'north-west corner');
  assert.ok(BBOX_M.x0 < 0 && BBOX_M.x1 > 0 && BBOX_M.z0 < 0 && BBOX_M.z1 > 0, 'origin inside the bbox');
  const [xa] = toLocal(BBOX.west, BBOX.south);
  assert.ok(Math.abs(xa - xn) < 1e-9, 'meridians stay vertical (THETA = 0)');
});

test('roads: width tags, lanes and class defaults', () => {
  assert.equal(parseWidth('12'), 12);
  assert.equal(parseWidth('7.5 m'), 7.5);
  assert.ok(Math.abs(parseWidth("40'") - 12.192) < 1e-9);
  assert.ok(Math.abs(parseWidth('30 ft') - 9.144) < 1e-9);
  assert.equal(parseWidth('wide'), null);
  assert.equal(parseWidth('0.5'), null);
  assert.deepEqual(roadWidth({ highway: 'residential', width: '9' }), { width: 9, source: 'width' });
  assert.deepEqual(roadWidth({ highway: 'residential', lanes: '3' }), { width: 9.9, source: 'lanes' });
  for (const [cls, w] of [['primary', 12], ['secondary', 12], ['tertiary', 10], ['residential', 8], ['unclassified', 8], ['service', 5]]) {
    assert.deepEqual(roadWidth({ highway: cls }), { width: w, source: 'default' });
    assert.equal(WIDTH_DEFAULTS[cls], w);
  }
  assert.equal(roadWidth({ highway: 'primary_link' }).width, WIDTH_DEFAULTS.link);
  assert.equal(onewayOf({ highway: 'residential', oneway: 'yes' }), 1);
  assert.equal(onewayOf({ highway: 'residential', oneway: '-1' }), -1);
  assert.equal(onewayOf({ highway: 'residential' }), 0);
  assert.equal(onewayOf({ highway: 'motorway' }), 1);
  assert.equal(onewayOf({ highway: 'tertiary', junction: 'roundabout' }), 1);
});

test('roads: polylines are cut at the bbox edge with new end points', () => {
  const pts = [{ x: -10, z: 0, key: 1 }, { x: 5, z: 0, key: 2 }, { x: 20, z: 0, key: 3 }, { x: 5, z: 5, key: 4 }];
  const runs = clipPolyline(pts, { x0: 0, x1: 10, z0: -10, z1: 10 });
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].map((p) => [p.x, p.z, p.key]), [[0, 0, null], [5, 0, 2], [10, 0, null]]);
  assert.deepEqual(runs[1].map((p) => p.key), [null, 4]);
});

test('roads: the graph has nodes at junctions, ends and bbox crossings only', () => {
  const { roadGraph, roads, cut, stats } = buildRoads(fixture(), BOX);
  const { nodes, links, names, classes, linkFields } = roadGraph;
  assert.deepEqual(linkFields, ['a', 'b', 'name', 'highway', 'oneway', 'lanes', 'width', 'pts']);
  // inner 2 x 2 junctions + 8 bbox crossings of the inner rows/columns + the driveway's dead end
  assert.equal(nodes.length / 2, 4 + 8 + 1);
  // each inner row/column: 3 links between crossing, junction, junction, crossing; plus the driveway
  assert.equal(links.length, 4 * 3 + 1);
  for (const [a, b] of links) assert.ok(a !== b && a < nodes.length / 2 && b < nodes.length / 2);
  const col = links.find((l) => names[l[2]] === 'Column 1');
  assert.equal(col[5], 2);
  assert.equal(col[6], 6.6, 'two lanes at 3.3 m');
  assert.ok(links.some((l) => classes[l[3]] === 'primary' && l[6] === 12));
  assert.equal(stats.crossings, 8);
  assert.equal(cut.length, 12, 'the driveway does not bound blocks');
  assert.equal(roads.flatMap((r) => r[1]).length, links.length, 'every link belongs to one way');
  for (let i = 0; i < nodes.length; i += 2) assert.ok(nodes[i] >= BOX.x0 && nodes[i] <= BOX.x1 && nodes[i + 1] >= BOX.z0 && nodes[i + 1] <= BOX.z1);
});

test('water: closed rings are kept, lines are skipped and logged', () => {
  const { water, skipped } = buildWater(fixture(), BOX);
  assert.equal(water.length, 1);
  assert.equal(water[0].name, 'Test Pond');
  assert.equal(water[0].outer.length, 8);
  assert.ok(skipped.some((s) => s.includes('Test Canal')));
  assert.deepEqual(joinRings([[1, 2, 3], [3, 4, 1], [7, 8]]), { rings: [[1, 2, 3, 4, 1]], open: 1 });
  assert.deepEqual(joinRings([[1, 2, 3], [1, 4, 3]]), { rings: [[1, 2, 3, 4, 1]], open: 0 });
});

test('blocks: curb islands between the roads, edge islands and specks dropped', () => {
  const els = fixture();
  const { cut } = buildRoads(els, BOX);
  const { water } = buildWater(els, BOX);
  const { blocks, dropped } = buildBlocks(cut, water, BOX, { res: 1, sidewalk: 1.8, minArea: 150 });
  // the grid's middle cell is the only island not touching the box edge
  assert.equal(blocks.length, 1);
  const [b] = blocks;
  const xs = b.curb.filter((_, i) => i % 2 === 0), zs = b.curb.filter((_, i) => i % 2 === 1);
  // streets at x, z = -50 & 50, residential 6.6 m wide (lanes) and the primary row at z = -50 12 m wide
  assert.ok(Math.abs(Math.min(...xs) + 46.7) <= 1 && Math.abs(Math.max(...xs) - 46.7) <= 1, `x ${Math.min(...xs)}..${Math.max(...xs)}`);
  assert.ok(Math.abs(Math.min(...zs) + 44) <= 1 && Math.abs(Math.max(...zs) - 46.7) <= 1, `z ${Math.min(...zs)}..${Math.max(...zs)}`);
  // 93.4 x 90.7 m minus the 30 x 30 m pond, which is a hole in the block (and in its property line)
  assert.ok(b.area > 7400 && b.area < 7750, `area ${b.area}: the pond is cut out`);
  assert.equal(b.curbHoles.length, 1);
  assert.ok(Math.abs(Math.abs(shoelace(b.curbHoles[0])) - 900) < 60, 'the hole is the pond');
  assert.ok(Math.abs(Math.abs(shoelace(b.curb)) - Math.abs(shoelace(b.curbHoles[0])) - b.area) <= 1, 'area = outline - holes');
  assert.equal(b.lotHoles.length, 1);
  const lx = b.lot.filter((_, i) => i % 2 === 0);
  assert.ok(Math.abs(Math.min(...lx) - Math.min(...xs) - 1.8) <= 1, 'the property line sits a sidewalk in');
  assert.ok(dropped.edge > 0);
});

function shoelace(f) {
  let a = 0;
  for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) a += f[j] * f[i + 1] - f[i] * f[j + 1];
  return a / 2;
}

// --- CC-ROADS: curb and lot rings on the roadway offsets ------------------------------------------------------------

// A street grid turned 27 degrees off the raster's axes (where a 1 m raster's outline stair-steps worst), 100 m spacing
function diagonalFixture() {
  nextId = 1;
  const els = [], grid = [], a = (27 * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  for (let j = 0; j < 4; j++) {
    grid.push([]);
    for (let i = 0; i < 4; i++) {
      const u = -150 + i * 100, v = -150 + j * 100;
      const n = node(u * c - v * sn, u * sn + v * c);
      grid[j].push(n);
      els.push(n);
    }
  }
  for (let j = 0; j < 4; j++) els.push(way(grid[j], { highway: 'residential', name: `Row ${j}` }));
  for (let i = 0; i < 4; i++) els.push(way(grid.map((r) => r[i]), { highway: i === 1 ? 'tertiary' : 'residential', name: `Column ${i}` }));
  return els;
}
// Signed distance of (x, z) from the union of the cut lines' offsets at radius r + extra (0 on the edge)
function offsetDistance(cut, x, z, extra = 0) {
  let best = Infinity;
  for (const { pts, r } of cut) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t) - (r + extra));
    }
  }
  return best;
}
// The road-side deviations of a ring (every 0.5 m along it, where an offset is within 1.5 m)
function ringDeviations(ring, dist) {
  const out = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
    const L = Math.hypot(bx - ax, bz - az);
    for (let s = 0; s < L; s += 0.5) {
      const d = dist(ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L);
      if (Math.abs(d) < 1.5) out.push(Math.abs(d));
    }
  }
  return out.sort((p, q) => p - q);
}
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];

test('blocks (CC-ROADS): on a diagonal grid the curb ring follows the drawn ribbon\'s edge, not a 1 m raster stair', () => {
  const els = diagonalFixture();
  const box = { x0: -200, x1: 200, z0: -200, z1: 200 };
  const { cut, roadGraph } = buildRoads(els, box);
  const { blocks } = buildBlocks(cut, [], box, { res: 1, sidewalk: 1.8, minArea: 150, minHole: 10 });
  const { blocks: raster } = buildBlocks(cut, [], box, { res: 1, sidewalk: 1.8, minArea: 150, minHole: 10, snap: false });
  assert.ok(blocks.length >= 1 && blocks.length === raster.length, `${blocks.length} blocks`);
  // the cut lines are the road graph's links at width / 2: the ribbon gf-drape.js drapes
  assert.equal(cut.length, roadGraph.links.length);
  for (const [i, l] of roadGraph.links.entries()) assert.equal(cut[i].r, l[6] / 2);
  const curb = blocks.flatMap((b) => ringDeviations(b.curb, (x, z) => offsetDistance(cut, x, z)));
  const before = raster.flatMap((b) => ringDeviations(b.curb, (x, z) => offsetDistance(cut, x, z)));
  // snapped: on the edge within the 0.1 m rounding; the raster's outline wandered several times that
  assert.ok(pct(curb, 0.5) <= 0.04 && pct(curb, 0.99) <= 0.08, `curb deviation p50 ${pct(curb, 0.5)} p99 ${pct(curb, 0.99)}`);
  assert.ok(pct(before, 0.9) > 3 * pct(curb, 0.9), `the raster outline: p90 ${pct(before, 0.9)}`);
  // no stair: along a straight street the ring's edges are long, not 1 m jogs
  const edges = blocks.flatMap((b) => {
    const r = b.curb, n = r.length / 2, out = [];
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; out.push(Math.hypot(r[j * 2] - r[i * 2], r[j * 2 + 1] - r[i * 2 + 1])); }
    return out;
  });
  assert.ok(Math.max(...edges) > 60, 'a block side is one straight edge');
  // the property line: the band in from the curb, on the offset at r + band
  const lot = blocks.filter((b) => b.lot).flatMap((b) => ringDeviations(b.lot, (x, z) => offsetDistance(cut, x, z, 1.8)));
  assert.ok(lot.length > 0 && pct(lot, 0.99) <= 0.08, `lot deviation p99 ${pct(lot, 0.99)}`);
});

test('blocks (CC-ROADS): the snapping steps', () => {
  // one road along x, curb radius 4: a point 0.4 m off its edge moves onto it; one 3 m off is left alone
  const G = capsuleGrid([{ pts: [[-50, 0], [50, 0]], r: 4 }], 4);
  assert.deepEqual(snapPoint(G, 10, 4.4, 0).map((v) => +v.toFixed(6)), [10, 4]);
  assert.deepEqual(snapPoint(G, 10, -3.7, 0).map((v) => +v.toFixed(6)), [10, -4]);
  assert.equal(snapPoint(G, 10, 7, 0), null);
  assert.deepEqual(snapPoint(G, 10, 6.5, 2.7).map((v) => +v.toFixed(6)), [10, 6.7], 'a lot line at r + band');
  // a junction: two roads crossing; a point near the corner settles where the two offsets cross
  const X = capsuleGrid([{ pts: [[-50, 0], [50, 0]], r: 4 }, { pts: [[0, -50], [0, 50]], r: 3 }], 4);
  const c = snapPoint(X, 2.9, 3.7, 0); // inside both offsets: out of the deeper, then the other
  assert.ok(Math.abs(c[0] - 3) < 0.01 && Math.abs(c[1] - 4) < 0.01, `corner ${c}`);
  // a stair-stepped ring beside the road: snapped, its road side is straight
  const stair = [];
  for (let x = -20; x <= 20; x += 1) stair.push([x, 4 + ((x + 20) % 2 ? 0.5 : -0.4)]);
  stair.push([20, 30], [-20, 30]);
  const { ring, snapped } = snapRing(stair, G, 0);
  assert.ok(snapped > 40, `${snapped} samples snapped`);
  for (const [x, z] of ring) if (z < 4 + SNAP.reach) assert.ok(Math.abs(z - 4) < 1e-6, `(${x}, ${z}) on the edge`);
  // a bow-tie is cut back to one loop; a spike left by rounding is dropped
  const bow = cutLoops([[0, 0], [10, 0], [10, 10], [5, -1], [0, 10]]);
  assert.ok(bow && bow.length >= 3);
  assert.deepEqual(tidyRing([[0, 0], [10, 0], [10, 0], [10, 10], [10, 5], [10, 10], [0, 10]]), [[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(SNAP.step, 0.5);
});

// --- The generated js/gf-geodata.js ------------------------------------------------------------------------------
const GF = built ? (await import(pathToFileURL(OUT).href)).GF_GEO : null;

function eachPoint(geo, fn) {
  const { nodes, links } = geo.roadGraph;
  const flatPts = (f, where) => { for (let i = 0; i < f.length; i += 2) fn(f[i], f[i + 1], where); };
  flatPts(nodes, 'roadGraph.nodes');
  links.forEach((l, i) => flatPts(l[7], `link ${i}`));
  geo.blocks.forEach((b, i) => {
    for (const r of [b.curb, ...b.curbHoles]) flatPts(r, `block ${i} curb`);
    if (b.lot) for (const r of [b.lot, ...b.lotHoles]) flatPts(r, `block ${i} lot`);
  });
  geo.water.forEach((w, i) => { flatPts(w.outer, `water ${i}`); w.holes.forEach((h) => flatPts(h, `water ${i} hole`)); });
}
const toPts = (f) => { const p = []; for (let i = 0; i < f.length; i += 2) p.push([f[i], f[i + 1]]); return p; };
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const segsCross = (a, b, c, d) => {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};
function selfIntersects(f) {
  const p = toPts(f), n = p.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return true;
    }
  }
  return false;
}
function ringsCross(f, g) {
  const p = toPts(f), r = toPts(g);
  for (let i = 0; i < p.length; i++) for (let j = 0; j < r.length; j++) if (segsCross(p[i], p[(i + 1) % p.length], r[j], r[(j + 1) % r.length])) return true;
  return false;
}
function inRing(x, z, f) {
  const r = toPts(f);
  let c = false;
  for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
    const [xa, za] = r[k], [xb, zb] = r[i];
    if ((za > z) !== (zb > z) && x < xa + ((z - za) * (xb - xa)) / (zb - za)) c = !c;
  }
  return c;
}

test('gf-geodata: structure, attribution and counts', { skip: !built && NOT_BUILT }, () => {
  for (const k of ['version', 'frame', 'bbox', 'roadGraph', 'roads', 'blocks', 'water', 'attribution']) assert.ok(k in GF, k);
  assert.match(GF.attribution, /© OpenStreetMap contributors/);
  assert.deepEqual(GF.frame, { lat0: 43.3095, lon0: -73.644, theta: 0 });
  const { nodes, links, names, classes } = GF.roadGraph;
  assert.ok(nodes.length / 2 > 0 && links.length > 0, 'node/link counts');
  assert.ok(GF.blocks.length > 0, 'blocks');
  for (const l of links) {
    assert.equal(l.length, GF.roadGraph.linkFields.length);
    assert.ok(Number.isInteger(l[0]) && l[0] >= 0 && l[0] < nodes.length / 2, 'link start node exists');
    assert.ok(Number.isInteger(l[1]) && l[1] >= 0 && l[1] < nodes.length / 2, 'link end node exists');
    assert.ok(typeof names[l[2]] === 'string' && typeof classes[l[3]] === 'string');
    assert.ok([-1, 0, 1].includes(l[4]) && l[6] >= 2 && l[6] <= 40);
  }
  const used = new Set(GF.roads.flatMap((r) => r[1]));
  assert.equal(used.size, links.length, 'every link belongs to a road');
});

test('gf-geodata: every coordinate is a number inside the bbox', { skip: !built && NOT_BUILT }, () => {
  const { x0, x1, z0, z1 } = GF.bbox;
  let n = 0;
  eachPoint(GF, (x, z, where) => {
    n++;
    assert.ok(Number.isFinite(x) && Number.isFinite(z), `${where}: NaN`);
    assert.ok(x >= x0 && x <= x1 && z >= z0 && z <= z1, `${where}: (${x}, ${z}) outside the bbox`);
  });
  assert.ok(n > 0);
});

test('gf-geodata: block outlines and holes are simple polygons (sample)', { skip: !built && NOT_BUILT }, () => {
  const step = Math.max(1, Math.floor(GF.blocks.length / 300));
  for (let i = 0; i < GF.blocks.length; i += step) {
    const b = GF.blocks[i];
    for (const [outer, holes, what] of [[b.curb, b.curbHoles, 'curb'], [b.lot, b.lotHoles, 'lot']]) {
      if (!outer) continue;
      for (const r of [outer, ...holes]) assert.ok(r.length >= 6 && !selfIntersects(r), `block ${i} ${what} ring`);
      holes.forEach((h, k) => {
        assert.ok(inRing(h[0], h[1], outer) && !ringsCross(outer, h), `block ${i} ${what} hole ${k} inside its outline`);
        holes.forEach((g, m) => assert.ok(m <= k || !ringsCross(h, g), `block ${i} ${what} holes ${k}/${m} cross`));
      });
    }
    const area = Math.abs(shoelace(b.curb)) - b.curbHoles.reduce((t, h) => t + Math.abs(shoelace(h)), 0);
    assert.ok(Math.abs(area - b.area) <= 1, `block ${i}: area ${b.area} vs outline - holes ${area.toFixed(1)}`);
    assert.ok(b.area >= 150);
  }
});

// The most interior point of each water polygon (5 m grid) must not lie on a block slab (curb outline minus holes)
test('gf-geodata: no water polygon is hidden under a block', { skip: !built && NOT_BUILT }, () => {
  const segDist = (x, z, a, b) => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(a[0] + t * dx - x, a[1] + t * dz - z);
  };
  const hidden = [];
  for (const w of GF.water) {
    const rings = [w.outer, ...w.holes].map(toPts);
    const xs = rings[0].map((p) => p[0]), zs = rings[0].map((p) => p[1]);
    let best = null, depth = -1;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 5) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 5) {
        if (!inRing(x, z, w.outer) || w.holes.some((h) => inRing(x, z, h))) continue;
        let d = Infinity;
        for (const r of rings) for (let i = 0; i < r.length; i++) d = Math.min(d, segDist(x, z, r[i], r[(i + 1) % r.length]));
        if (d > depth) { depth = d; best = [x, z]; }
      }
    }
    if (!best) continue;
    const [x, z] = best;
    const i = GF.blocks.findIndex((b) => inRing(x, z, b.curb) && !b.curbHoles.some((h) => inRing(x, z, h)));
    if (i >= 0) hidden.push(`${w.osm} ${w.name || w.kind} under block ${i}`);
  }
  assert.deepEqual(hidden, []);
});

// Named roads: required when the raw extract has them (reported, not faked, when it does not)
for (const street of ['Glen Street', 'Warren Street']) {
  test(`gf-geodata: ${street} is in the road graph if OSM has it`, { skip: (!built && NOT_BUILT) || (!fetched && NOT_FETCHED) }, (t) => {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW, 'osm_gf_roads.json'), 'utf8'));
    const inOsm = raw.elements.some((e) => e.type === 'way' && e.tags && e.tags.name === street);
    const inGeo = GF.roadGraph.links.some((l) => GF.roadGraph.names[l[2]] === street);
    if (!inOsm) { t.diagnostic(`${street} is not in the OSM extract`); assert.equal(inGeo, false); return; }
    assert.ok(inGeo, `${street} is in OSM but missing from the road graph`);
  });
}

test('gf-geodata (CC-ROADS): curbs on the ribbon edges, lot lines a band in; widths from tags, lanes and defaults', { skip: (!built && NOT_BUILT) || (!fetched && NOT_FETCHED), timeout: 300000 }, () => {
  const roads = JSON.parse(fs.readFileSync(path.join(RAW, 'osm_gf_roads.json'), 'utf8'));
  const { cut, stats, roadGraph } = buildRoads(roads.elements);
  // widths: OSM tag first, then lanes x LANE_WIDTH, then the class default (the extract has no usable width tags)
  assert.deepEqual(stats.widthSource, { width: 0, lanes: 781, default: 3532 });
  assert.equal(LANE_WIDTH, 3.3);
  const { names, classes, links } = roadGraph;
  const widthsOf = (name) => [...new Set(links.filter((l) => names[l[2]] === name).map((l) => l[6]))].sort((p, q) => p - q);
  // Glen Street: every way has a lanes tag (2, 3 or 4 x 3.3 m); OSM counts travel lanes, not parking, so downtown it is
  // 6.6 m curb to curb (flagged for Dave in CC-ROADS; only 5 ways in the extract carry a parking tag)
  assert.deepEqual(widthsOf('Glen Street'), [6.6, 9.9, 13.2]);
  assert.deepEqual(widthsOf('Logan Avenue'), [8], 'a residential street: the class default');
  assert.ok(links.filter((l) => classes[l[3]] === 'service').every((l) => l[6] === WIDTH_DEFAULTS.service || l[5] > 0));
  // the curb rings and lot lines: a grid of the cut segments for the distance (the whole city: sample every 4th block)
  const segs = [];
  for (const { pts, r } of cut) for (let k = 0; k + 1 < pts.length; k++) segs.push([...pts[k], ...pts[k + 1], r]);
  const C = 40, grid = new Map();
  for (const sg of segs) {
    const m = sg[4] + 6;
    for (let i = Math.floor((Math.min(sg[0], sg[2]) - m) / C); i <= Math.floor((Math.max(sg[0], sg[2]) + m) / C); i++) {
      for (let j = Math.floor((Math.min(sg[1], sg[3]) - m) / C); j <= Math.floor((Math.max(sg[1], sg[3]) + m) / C); j++) {
        const k = i * 100000 + j;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(sg);
      }
    }
  }
  const dist = (x, z, extra) => {
    let best = Infinity;
    for (const sg of grid.get(Math.floor(x / C) * 100000 + Math.floor(z / C)) || []) {
      const dx = sg[2] - sg[0], dz = sg[3] - sg[1], l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - sg[0]) * dx + (z - sg[1]) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - sg[0] - dx * t, z - sg[1] - dz * t) - (sg[4] + extra));
    }
    return best;
  };
  const sample = GF.blocks.filter((_, i) => i % 4 === 0);
  const curb = sample.flatMap((b) => ringDeviations(b.curb, (x, z) => dist(x, z, 0)));
  const lot = sample.filter((b) => b.lot).flatMap((b) => ringDeviations(b.lot, (x, z) => dist(x, z, sidewalkBandAt(x, z))));
  // until CC-ROADS the 1 m raster's outline sat p50 0.12, p90 0.32, p99 0.54 m off the ribbon
  assert.ok(curb.length > 50000 && pct(curb, 0.5) <= 0.04 && pct(curb, 0.9) <= 0.08 && pct(curb, 0.99) <= 0.12,
    `curb deviation p50 ${pct(curb, 0.5)} p90 ${pct(curb, 0.9)} p99 ${pct(curb, 0.99)}`);
  assert.ok(lot.length > 50000 && pct(lot, 0.5) <= 0.04 && pct(lot, 0.99) <= 0.15, `lot deviation p50 ${pct(lot, 0.5)} p99 ${pct(lot, 0.99)}`);
});

test('gf-geodata: rebuilding from the raw extract reproduces js/gf-geodata.js byte for byte', { skip: (!built && NOT_BUILT) || (!fetched && NOT_FETCHED), timeout: 300000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-geodata '));
  try {
    const out = path.join(dir, 'gf-geodata.js');
    const result = spawnSync(process.execPath, [path.join(root, 'tools/gf/build-gf-geodata.mjs'), out], { encoding: 'utf8', timeout: 300000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(OUT)), 'js/gf-geodata.js is stale or the build is not deterministic');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
