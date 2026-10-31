import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildRoadNetwork } from '../js/road-network.js';
import { NYC_SOURCE } from '../js/nyc-runtime.js';
import { DRIVE_CLASSES, driveLinks, edgeAlong, gfRoadSource, gfSpawn, polylineDistance } from '../js/gf-roadgraph.js';
import { GF_GEO } from '../js/gf-geodata.js';

// The Glens Falls road network: road-network.js built from GF_GEO.roadGraph through gfRoadSource (js/gf-roadgraph.js)

function build() {
  const info = console.info;
  console.info = () => {}; // its [roads] stats
  try {
    return buildRoadNetwork([], [], [], gfRoadSource(GF_GEO));
  } finally {
    console.info = info;
  }
}
const network = build();
const { edges } = network;
const links = driveLinks(GF_GEO);

// The drive links near each 50 m cell, to find the nearest road quickly
const CELL = 50;
const cells = new Map();
links.forEach((l, i) => {
  for (let k = 0; k + 1 < l.pts.length; k++) {
    const [ax, az] = l.pts[k];
    const [bx, bz] = l.pts[k + 1];
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 10) || 1;
    for (let t = 0; t <= n; t++) {
      const key = `${Math.floor((ax + ((bx - ax) * t) / n) / CELL)},${Math.floor((az + ((bz - az) * t) / n) / CELL)}`;
      if (!cells.has(key)) cells.set(key, new Set());
      cells.get(key).add(i);
    }
  }
});
// Metres beyond the edge of the nearest drive link (its centreline minus half its width; negative: on the road)
function outsideRoad(x, z) {
  let best = Infinity;
  const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const i of cells.get(`${ix + dx},${iz + dz}`) || []) best = Math.min(best, polylineDistance(x, z, links[i].pts) - links[i].width / 2);
    }
  }
  return best;
}
// An edge's drivable stretch: its two stop-line ends and the middle between them
const edgePoints = (e) => [0, 0.5, 1].map((t) => [e.sx + e.dx * e.len * t, e.sz + e.dz * e.len * t]);
const key = (e) => `${Math.round(e.from.x)},${Math.round(e.from.z)} > ${Math.round(e.to.x)},${Math.round(e.to.z)}`;

test('GF network: deterministic, over 500 edges, every edge with a way on', () => {
  const hash = (net) => createHash('sha256')
    .update(JSON.stringify(net.edges.map((e) => [e.from.id, e.to.id, e.sx, e.sz, e.len, e.lanes, e.moves.map((m) => [m.to.id, m.out])])))
    .digest('hex');
  assert.equal(hash(build()), hash(network), 'two builds give the same edges');
  assert.ok(edges.length > 500, `${edges.length} edges`);
  const ids = new Set(edges);
  for (const e of edges) {
    assert.ok(e.moves.length >= 1, `edge ${e.id} leads nowhere`);
    for (const m of e.moves) {
      assert.ok(ids.has(m.to), `edge ${e.id} moves onto an edge not in the network`);
      assert.ok(m.out.some((j) => j >= 0 && j < m.to.lanes.length), `edge ${e.id}: a move with no lane into ${m.to.id}`);
    }
    for (let i = 0; i < e.lanes.length; i++) assert.ok(e.moves.some((m) => m.out[i] >= 0), `edge ${e.id} lane ${i} leads nowhere`);
  }
});

test('GF network: no NaN, everything inside the bbox', () => {
  const { x0, x1, z0, z1 } = GF_GEO.bbox;
  const inside = (x, z) => Number.isFinite(x) && Number.isFinite(z) && x >= x0 && x <= x1 && z >= z0 && z <= z1;
  for (const n of network.nodes) assert.ok(inside(n.x, n.z), `node ${n.id} at (${n.x}, ${n.z})`);
  for (const e of edges) {
    for (const v of [e.sx, e.sz, e.len, e.dx, e.dz, e.half, ...e.lanes]) assert.ok(Number.isFinite(v), `edge ${e.id}: NaN`);
    for (const [x, z] of edgePoints(e)) assert.ok(inside(x, z), `edge ${e.id} at (${x}, ${z})`);
  }
});

// road-network.js merges a link's two ends where it is under 14 m (a junction drawn as nodes a few metres apart) and
// runs a street straight from bend to bend. Where OSM has a side street meeting a road at two nodes 9-13 m apart (a
// dog-leg), the merged junction lies between them and the streets' stop lines a little more than 2 m past their curbs;
// Centennial Circle, a roundabout too small to bend around, is crossed on its chord. These edges, and how far beyond the
// 2 m each strays, are known; any other edge straying fails, and so does one of these straying further or no more.
const KNOWN_STRAYS = new Map([
  ['472,1013 > 358,853', ['Fairview Street', 0.12]],
  ['358,853 > 472,1013', ['Fairview Street', 0.12]],
  ['1160,1644 > 1269,1643', ['Lewis Street', 0.35]],
  ['1269,1643 > 1160,1644', ['Lewis Street', 0.35]],
  ['-2008,698 > -2068,333', ['Veterans Road', 0.09]],
  ['-2068,333 > -2008,698', ['Veterans Road', 0.09]],
  ['-2008,698 > -1959,997', ['Richardson Street', 0.1]],
  ['-1959,997 > -2008,698', ['Richardson Street', 0.1]],
  ['-359,1501 > -379,1655', ['Feeder Bend Road', 1.06]],
  ['-379,1655 > -359,1501', ['Feeder Bend Road', 1.06]],
  ['1,-9 > -3,13', ['Centennial Circle', 7.54]],
  ['-3,13 > 1,-9', ['Centennial Circle', 7.54]]
]);

test('GF network: every edge follows a drive link (within its half width + 2 m), bar the known strays', () => {
  const strays = new Map();
  for (const e of edges) {
    const beyond = Math.max(...edgePoints(e).map(([x, z]) => outsideRoad(x, z))) - 2;
    if (beyond > 0) strays.set(key(e), beyond);
  }
  for (const [k, beyond] of strays) {
    assert.ok(KNOWN_STRAYS.has(k), `edge ${k} runs ${beyond.toFixed(2)} m beyond its road's half width + 2 m`);
  }
  for (const [k, [street, beyond]] of KNOWN_STRAYS) {
    assert.ok(strays.has(k), `${street} (${k}) follows its road now: take it off KNOWN_STRAYS`);
    assert.ok(Math.abs(strays.get(k) - beyond) < 0.01, `${street} (${k}) strays ${strays.get(k).toFixed(2)} m, not ${beyond} m`);
  }
});

test('GF network: drives every class but service, on GF geometry only', () => {
  const { classes } = GF_GEO.roadGraph;
  assert.ok(!DRIVE_CLASSES.has('service'));
  for (const c of classes) if (c !== 'service') assert.ok(DRIVE_CLASSES.has(c), `${c} is driven`);
  // The source's links are the drive links rejoined and cut at their own shape points: the same roads, metre for metre
  const source = gfRoadSource(GF_GEO);
  const { nodes } = source.roadGraph;
  const length = (pts) => pts.reduce((t, p, i) => (i ? t + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  let sourceLength = 0;
  for (const [a, b, , , , , inner] of source.roadGraph.links) {
    const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
    sourceLength += length(pts);
    for (const [x, z] of pts) assert.ok(links.some((l) => polylineDistance(x, z, l.pts) < 1e-6), `source point (${x}, ${z}) is not on a drive link`);
  }
  const driveLength = links.reduce((t, l) => t + length(l.pts), 0);
  assert.ok(Math.abs(sourceLength - driveLength) < 1e-6 * driveLength, `${sourceLength} m vs ${driveLength} m of drive links`);
  // ...and no edge runs where only a service road does
  for (const e of edges) {
    const [x, z] = edgePoints(e)[1];
    assert.ok(outsideRoad(x, z) < 8, `edge ${e.id} is nowhere near a drive link`);
  }
});

test('GF spawn: deterministic, in the rightmost lane of the longest Glen Street edge', () => {
  const spawn = gfSpawn(network, GF_GEO);
  assert.deepEqual(gfSpawn(build(), GF_GEO), spawn);
  assert.equal(spawn.street, 'Glen Street');
  const e = edges[spawn.edge];
  assert.ok(outsideRoad(spawn.x, spawn.z) < 0, 'the spawn is on the road');
  assert.ok(Math.abs(spawn.heading - Math.atan2(e.dx, e.dz)) < 1e-9);
  const onGlen = edges.filter((g) => edgeAlong(g, links.filter((l) => l.name === 'Glen Street')));
  assert.ok(onGlen.includes(e));
  assert.equal(Math.max(...onGlen.map((g) => g.len)), e.len, 'the longest Glen Street edge');
  assert.equal(spawn.x, e.sx + e.dx * e.len / 2 + e.rx * e.lanes[e.lanes.length - 1]);
});

test('Manhattan stays the default city source', () => {
  assert.ok(NYC_SOURCE.avenues.length > 0 && NYC_SOURCE.streets.length > 0 && NYC_SOURCE.roadGraph.links.length > 0);
  assert.ok(NYC_SOURCE.majorName.test('BROADWAY') && !NYC_SOURCE.majorName.test('W  42 ST'));
});
