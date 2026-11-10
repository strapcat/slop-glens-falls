import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeTerrain, createGfTerrain } from '../js/gf-terrain.js';
import { createGfSurface } from '../js/gf-surface.js';
import { buildRoadNetwork } from '../js/road-network.js';
import { createPedestrianRoutes } from '../js/pedestrian-routes.js';
import { gfRoadSource } from '../js/gf-roadgraph.js';
import { createGfBlocks } from '../js/gf-blocks.js';
import { gfBuildingsOnTerrain } from '../js/gf-building-bases.js';
import { applyLidarHeights } from '../js/gf-building-heights.js';
import { placeGfTrees } from '../js/gf-tree-placements.js';
import { GF_GEO } from '../js/gf-geodata.js';
import { GF_BRIDGES } from '../js/gf-bridges.js';
import { GF_BUILDINGS } from '../js/gf-buildings.js';
import { GF_LANDMARKS } from '../js/gf-landmarks.js';
import { GF_LIDAR_HEIGHTS } from '../js/gf-lidar-heights.js';
import { GF_SIGNALS } from '../js/gf-signals.js';
import { GF_TREES } from '../js/gf-trees.js';
import { GF_TRAILS } from '../js/gf-trails.js';
import { GF_DOWNTOWN } from '../js/gf-downtown.js';
import { createTrailNetwork, createTrailRoutes, ATTACH_REACH, CONNECTOR_BODY } from '../js/gf-trail-network.js';
import { createClearance, waterRegions, buildingRegions, trunkRegions } from '../js/gf-trail-clearance.js';
import { SIDEWALK, createDowntown, sidewalkBandAt, createGfSidewalks } from '../js/gf-sidewalks.js';
import { createSidewalkStrips } from '../js/gf-sidewalk-strips.js';
import { buildBlocks } from '../tools/gf/build-gf-geodata.mjs';
import { buildGfDowntown, moduleText, LOOPS, FRONTAGE } from '../tools/gf/build-gf-downtown.mjs';

// CC-005e: Glens Falls sidewalks as they look: a granite curb with a face, a tree lawn on residential streets (none
// downtown, Dave's 1993 recollection), concrete walks in 5 ft flags, lots that no longer read as the same slab

const root = fileURLToPath(new URL('..', import.meta.url));
const quiet = (fn) => { const info = console.info; console.info = () => {}; try { return fn(); } finally { console.info = info; } };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const segDist = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return Math.hypot(px - ax - dx * t, pz - az - dz * t); };
const ringDist = (rings, x, z) => { let d = Infinity; for (const r of rings) for (let i = 0; i < r.length; i += 2) { const j = (i + 2) % r.length; d = Math.min(d, segDist(x, z, r[i], r[i + 1], r[j], r[j + 1])); } return d; };

// the game's world, as gf-runtime.js / gf-main.js build it
const terrain = createGfTerrain(decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(root, 'js/gf-terrain.bin.gz'))))), GF_GEO.frame);
const surface = createGfSurface({ terrain, geo: GF_GEO, bridges: GF_BRIDGES, footDecks: GF_TRAILS.footDecks });
const blocks = createGfBlocks(GF_GEO);
const sidewalks = createGfSidewalks({ geo: GF_GEO, blocks, ground: surface.ground });
const S = SIDEWALK;

// fixture points (GF_GEO frame, m): downtown in the envelope's loops or within its frontage of their streets;
// residential elsewhere
const DOWNTOWN_POINTS = {
  'Monument Square (Glen, Bay & South Sts)': [-201, -152],
  'Glen St between the squares': [-120, -97],
  'Ridge St north of Centennial Circle': [9, -120],
  'Maple St at Ridge St': [10, -226],
  'South St': [-240, -55],
  'Pine St at Elm St (2022 increase)': [-432, -60],
  'Broad St (2022 increase)': [-360, 125],
  'Glen St, the far side of the street (frontage)': [-112, -112]
};
const RESIDENTIAL_POINTS = {
  'Glen St at Crandall Park': [-1154, -1141],
  'Maple St east (a residential street)': [640, -269],
  'Warren St east of Church St': [500, -80],
  'Glen St south of Centennial Circle (outside the published bounds)': [120, 180],
  'Ridge St north of Maple St, beyond the frontage': [40, -330],
  'Pine St, beyond the frontage west of it': [-470, 0]
};

test('downtown: the Three Squares envelope regenerates from the frozen OSM extract; inside and outside fixtures', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'tools/gf/data/osm_gf_roads.json'), 'utf8'));
  const d = buildGfDowntown(raw);
  assert.equal(moduleText(d), fs.readFileSync(path.join(root, 'js/gf-downtown.js'), 'utf8'), 'js/gf-downtown.js is stale');
  assert.equal(GF_DOWNTOWN.frontage, FRONTAGE);
  assert.equal(GF_DOWNTOWN.loops.length, LOOPS.length);
  // the published bounding streets, and nothing else, make up the loops
  assert.deepEqual(GF_DOWNTOWN.loops[0].streets.sort(), ['Bay Street', 'Glen Street', 'Maple Street', 'Ridge Street']);
  assert.deepEqual(GF_DOWNTOWN.loops[1].streets.sort(), ['Broad Street', 'Glen Street', 'Pine Street', 'South Street']);
  const dt = createDowntown();
  for (const [name, [x, z]] of Object.entries(DOWNTOWN_POINTS)) assert.equal(dt.contains(x, z), true, name);
  for (const [name, [x, z]] of Object.entries(RESIDENTIAL_POINTS)) assert.equal(dt.contains(x, z), false, name);
  // the generator's band: the downtown band in the envelope, the residential one elsewhere
  for (const [x, z] of Object.values(DOWNTOWN_POINTS)) assert.equal(sidewalkBandAt(x, z), S.downtownBand);
  for (const [x, z] of Object.values(RESIDENTIAL_POINTS)) assert.equal(sidewalkBandAt(x, z), S.residentialBand);
  assert.equal(sidewalkBandAt.min, S.downtownBand);
  assert.equal(sidewalkBandAt.max, S.residentialBand);
});

test('property line: buildBlocks with a band function puts each half of a block\'s lot its own band in', () => {
  // four streets round a 100 m square (8 m curb to curb), a narrow band west of x = 0 and a wide one east of it
  const BOX = { x0: -130, x1: 130, z0: -130, z1: 130 };
  const line = (ax, az, bx, bz) => ({ pts: [[ax, az], [bx, bz]], r: 4 });
  const cut = [line(-50, -130, -50, 130), line(50, -130, 50, 130), line(-130, -50, 130, -50), line(-130, 50, 130, 50)];
  const band = (x) => (x < 0 ? 1.8 : 2.8);
  band.min = 1.8; band.max = 2.8;
  const { blocks: [b] } = buildBlocks(cut, [], BOX, { res: 1, sidewalk: band, minArea: 150, minHole: 10 });
  const xs = (f) => f.filter((_, i) => i % 2 === 0);
  const west = Math.min(...xs(b.lot)) - Math.min(...xs(b.curb)), east = Math.max(...xs(b.curb)) - Math.max(...xs(b.lot));
  assert.ok(Math.abs(west - 1.8) <= 1, `west band ${west}`);
  assert.ok(Math.abs(east - 2.8) <= 1, `east band ${east}`);
  assert.ok(east - west >= 0.6, `the east band is wider (${west} / ${east})`);
  // a number is still one band all round (CC-001)
  const { blocks: [c] } = buildBlocks(cut, [], BOX, { res: 1, sidewalk: 1.8, minArea: 150, minHole: 10 });
  const w = Math.min(...xs(c.lot)) - Math.min(...xs(c.curb)), e = Math.max(...xs(c.curb)) - Math.max(...xs(c.lot));
  assert.ok(Math.abs(w - e) <= 0.2, `${w} / ${e}`);
});

test('bands as built (GF_GEO): downtown ~2.2 m, concrete to the curb; residential ~3.1 m, curb + tree lawn + walk', () => {
  const by = { downtown: { band: [], lawn: 0, n: 0, walk: [] }, residential: { band: [], lawn: 0, n: 0, walk: [], lawnW: [] } };
  for (const entry of sidewalks.rings) {
    if (entry.kind !== 'lot') continue;
    for (const sm of sidewalks.ringSamples(entry)) {
      const at = sidewalks.lotAt(entry, sm);
      if (!at.roadside) continue;
      const r = by[sidewalks.downtown(sm.x, sm.z) ? 'downtown' : 'residential'];
      r.n++;
      r.band.push(at.curbD);
      r.walk.push(at.walkOut);
      if (at.lawn) { r.lawn++; if (r.lawnW) r.lawnW.push(at.lawnOut - at.walkOut); }
    }
  }
  const dt = by.downtown, res = by.residential;
  assert.ok(dt.n > 300 && res.n > 50000, `${dt.n} downtown, ${res.n} residential samples`);
  assert.ok(Math.abs(median(dt.band) - 2.2) < 0.25, `downtown band ${median(dt.band)}`);
  assert.ok(Math.abs(median(res.band) - 3.1) < 0.25, `residential band ${median(res.band)}`);
  // downtown: no grass strip, the walk runs to the curb (allowing the envelope's edge, where the bands meet)
  assert.ok(dt.lawn / dt.n < 0.1, `downtown lawn share ${dt.lawn / dt.n}`);
  assert.ok(Math.abs(median(dt.walk) - (median(dt.band) - S.curbW)) < 0.1, `downtown walk ${median(dt.walk)}`);
  // residential: a tree lawn nearly everywhere, the walk WALK_W wide, the lawn about the city's 4 ft snow strip
  assert.ok(res.lawn / res.n > 0.9, `residential lawn share ${res.lawn / res.n}`);
  assert.equal(median(res.walk), S.walkW);
  assert.ok(median(res.lawnW) > 1.0 && median(res.lawnW) < 1.6, `lawn ${median(res.lawnW)} m`);
  // the layout rule itself
  const narrow = sidewalks.layout(1.9, 0.3), wide = sidewalks.layout(2.0, 1.1);
  assert.ok(!narrow.lawn && Math.abs(narrow.walkOut - (2.2 - S.curbW)) < 1e-9, 'a 2.2 m band: walk to the curb');
  assert.ok(wide.lawn && wide.walkOut === S.walkW, 'a 3.1 m band: curb, lawn, walk');
});

test('strips: the curb has a face (REVEAL over the road) downtown and residential; lawns only where residential', () => {
  const strips = createSidewalkStrips(sidewalks);
  const cellAt = (x, z) => strips.cells.get(Math.floor(x / strips.CELL) * 100000 + Math.floor(z / strips.CELL));
  const area = (B) => { if (!B) return 0; let a = 0; const p = B.pos; for (let i = 0; i < B.idx.length; i += 3) { const [u, v, w] = [B.idx[i], B.idx[i + 1], B.idx[i + 2]].map((k) => [p[k * 3], p[k * 3 + 2]]); a += Math.abs((v[0] - u[0]) * (w[1] - u[1]) - (w[0] - u[0]) * (v[1] - u[1])) / 2; } return a; };
  // the segments of a cell inside / outside the envelope
  const pick = (cell, inside) => cell.segs.filter(([r, i]) => {
    const ring = sidewalks.rings[r].ring, j = ((i + 1) % (ring.length / 2)) * 2;
    return sidewalks.downtown((ring[i * 2] + ring[j]) / 2, (ring[i * 2 + 1] + ring[j + 1]) / 2) === inside;
  });
  const down = strips.build(pick(cellAt(-120, -97), true));
  const res = strips.build(pick(cellAt(640, -269), false));
  for (const [name, bufs] of [['downtown', down], ['residential', res]]) {
    for (const k of ['granite', 'gutter', 'concrete', 'ramp']) assert.ok(bufs[k] && bufs[k].idx.length > 0, `${name}: ${k}`);
    // the curb's face: each face quad rises from under the road to TOP (or a driveway's depressed curb)
    const g = bufs.granite, rises = [];
    for (let q = 0; q < g.pos.length / 12; q += 2) rises.push(g.pos[q * 12 + 4] - g.pos[q * 12 + 1]);
    assert.ok(Math.abs(median(rises) - (S.top + 0.06)) < 1e-6, `${name} face ${median(rises)}`);
    assert.ok(S.reveal >= 0.12 && S.reveal <= 0.18 && Math.abs(S.top - S.roadLift - S.reveal) < 1e-9);
    // joints on the walk only, 5 ft flags
    assert.ok(bufs.concrete.joint.some((j) => j === 1));
  }
  assert.ok(area(down.lawn) < 0.05 * area(down.concrete), `downtown lawn ${area(down.lawn)} m² vs walk ${area(down.concrete)} m²`);
  assert.ok(area(res.lawn) > 0.4 * area(res.concrete), `residential lawn ${area(res.lawn)} m² vs walk ${area(res.concrete)} m²`);
  assert.equal(S.flag, 1.524);
});

test('onWalk: the walk\'s concrete, not its lawn, the lot or the road; onSidewalk (gf-blocks.js) keeps its CC-002 meaning', () => {
  let walks = 0, lawns = 0;
  for (const entry of sidewalks.rings) {
    if (entry.kind !== 'lot' || !entry.block.lot) continue;
    const list = sidewalks.ringSamples(entry);
    for (let k = 0; k < list.length; k += 7) {
      const sm = list[k], at = sidewalks.lotAt(entry, sm);
      if (!at.roadside || at.curbD < 1.5 || sm.corner) continue; // a ring's corner: its mitred offset reaches further
      const on = (d) => [sm.x + sm.nx * d, sm.z + sm.nz * d];
      if (blocks.blockAt(...on(at.walkOut / 2)) !== entry.block) continue; // a ring corner's miter reaching past the block
      assert.equal(sidewalks.onWalk(...on(at.walkOut / 2)), true, `walk at (${on(0)})`);
      if (!blocks.onSidewalk(...on(-1.0))) assert.equal(sidewalks.onWalk(...on(-1.0)), false, 'in the lot');
      walks++;
      if (at.lawn && sm.toCorner > S.padR + 2) {
        const p = on((at.walkOut + at.lawnOut) / 2);
        if (blocks.blockAt(...p) !== entry.block || sidewalks.nearJunction(...p)) continue; // a junction's corners are paved
        assert.equal(sidewalks.onWalk(...p), false, `lawn at (${p})`);
        assert.equal(blocks.onSidewalk(...p), true, 'still the CC-002 sidewalk band (block minus lot)');
        lawns++;
      }
    }
  }
  assert.ok(walks > 10000 && lawns > 10000, `${walks} walk and ${lawns} lawn points`);
  // the roadway is no walk
  assert.equal(sidewalks.onWalk(-120, -97), false);
});

test('raiseAt: TOP on the band, down the ramp into the lot, 0 on roads, lots and beside water; driveways come down', () => {
  let band = 0, ramp = 0;
  for (const entry of sidewalks.rings) {
    if (entry.kind !== 'lot') continue;
    const list = sidewalks.ringSamples(entry);
    for (let k = 0; k < list.length; k += 11) {
      const sm = list[k], at = sidewalks.lotAt(entry, sm);
      if (!at.roadside || at.cut || at.curbD < 1.5 || sm.corner) continue;
      const p = (d) => [sm.x + sm.nx * d, sm.z + sm.nz * d];
      if (blocks.blockAt(...p(0.5)) !== entry.block || blocks.blockAt(...p(-0.25)) !== entry.block || sidewalks.serviceEdge(...p(0.5)) < 1) continue;
      // two metres into the lot, and no other lot edge within the ramp's reach of it (a narrow lot, a corner)
      const lotRings = [entry.block.lot.outer, ...entry.block.lot.holes].map((r) => r.flatMap((q) => [q.x, q.z]));
      if (ringDist(lotRings, ...p(-2)) < 1.5 || ringDist(lotRings, ...p(-0.25)) < 0.2) continue;
      assert.equal(sidewalks.raiseExact(...p(0.5)), S.top, 'on the walk');
      const r = sidewalks.raiseExact(...p(-0.25));
      assert.ok(r > 0.2 * S.top && r < 0.8 * S.top, `half way down the ramp: ${r}`);
      assert.equal(sidewalks.raiseExact(...p(-2)), 0, 'in the lot');
      band++; ramp++;
    }
  }
  assert.ok(band > 3000, `${band} checks`);
  // roads: no raise
  for (const l of GF_GEO.roadGraph.links.slice(0, 400)) {
    const [a, b] = l;
    const x = (GF_GEO.roadGraph.nodes[a * 2] + GF_GEO.roadGraph.nodes[b * 2]) / 2, z = (GF_GEO.roadGraph.nodes[a * 2 + 1] + GF_GEO.roadGraph.nodes[b * 2 + 1]) / 2;
    if (!blocks.blockAt(x, z)) assert.equal(sidewalks.raiseExact(x, z), 0);
  }
  // a driveway: lower at the curb than at the walk
  let driveways = 0;
  for (const entry of sidewalks.rings) {
    if (entry.kind !== 'curb' || driveways > 50) continue;
    for (const sm of sidewalks.ringSamples(entry)) {
      const at = sidewalks.curbAt(sm);
      if (!at.roadside || !at.cut) continue;
      const near = [sm.x - sm.nx * 0.1, sm.z - sm.nz * 0.1];
      if (blocks.blockAt(...near) !== entry.block || sidewalks.serviceEdge(...near) >= 0.3) continue;
      assert.ok(sidewalks.raiseExact(...near) < S.top - 0.05, `driveway at (${near})`);
      driveways++;
    }
  }
  assert.ok(driveways > 20, `${driveways} driveway checks`);
  // cached = exact
  assert.equal(sidewalks.raiseAt(-139.3, -109.9), sidewalks.raiseExact(-139.3, -109.9));
});

test('pedestrians (the game\'s walking lines and onWalk): on the concrete, on their own blocks, trail entrances still reached', () => {
  const { colliders, obstacles } = gfBuildingsOnTerrain(applyLidarHeights(GF_BUILDINGS, GF_LIDAR_HEIGHTS).data, GF_LANDMARKS, surface.ground);
  const network = quiet(() => buildRoadNetwork([], [...blocks.lotObstacles, ...obstacles], GF_SIGNALS.junctions.map(([x, z]) => ({ x, z })), gfRoadSource(GF_GEO)));
  const base = () => createPedestrianRoutes({ walkable: network.walkable, onSidewalk: sidewalks.onWalk }, blocks.blockAt, { insets: sidewalks.insetsFor });
  const routes = base();
  const all = network.edges.map((e) => routes.along(e));
  const withTracks = all.filter((l) => l.length).length;
  assert.ok(withTracks > 2000, `${withTracks} edges with tracks`);
  let n = 0, onConcrete = 0, lawnSide = 0, residential = 0;
  for (const list of all) {
    for (const t of list) {
      for (const f of [0, 0.5, 1]) {
        const x = t.ax + t.ux * t.len * f, z = t.az + t.uz * t.len * f;
        assert.equal(blocks.blockAt(x, z), t.block, 'track off its block');
        n++;
        if (sidewalks.onWalk(x, z)) onConcrete++;
      }
      // a residential track runs behind the lawn: further from the curb than the curb and the lawn
      const mx = t.ax + t.ux * t.len / 2, mz = t.az + t.uz * t.len / 2;
      if (!sidewalks.downtown(mx, mz) && t.block.lot) {
        residential++;
        const rings = [t.block.polygon.outer, ...t.block.polygon.holes].map((r) => r.flatMap((p) => [p.x, p.z]));
        if (ringDist(rings, mx, mz) < S.curbW + S.lawnMin) lawnSide++;
      }
    }
  }
  assert.ok(onConcrete / n > 0.97, `${onConcrete} of ${n} track points on the walk`);
  assert.ok(residential > 3000 && lawnSide / residential < 0.03, `${lawnSide} of ${residential} residential tracks by the curb`);
  // CC-005c's entrances: the same six reach a sidewalk, their connectors clear of water, buildings and kept trunks
  const net = createTrailNetwork(GF_TRAILS);
  const trees = placeGfTrees(GF_TREES, { buildings: GF_BUILDINGS, geo: GF_GEO, ground: surface.ground, exclude: new Set(GF_TRAILS.treeExclusions.trees.map((t) => t[0])) });
  const clearance = createClearance([...waterRegions(GF_GEO.water), ...buildingRegions(colliders), ...trunkRegions(trees.trunks)]);
  const trailRoutes = createTrailRoutes(base(), network, net, { clearance });
  assert.equal(trailRoutes.walkable.length, 6);
  for (const en of trailRoutes.walkable) {
    const at = trailRoutes.attach.get(en), nd = net.node(en.node);
    assert.ok(at.d <= ATTACH_REACH, `${en.street}: ${at.d} m`);
    assert.ok(trailRoutes.splitCount(en) >= 1, `${en.street}: a sidewalk split`);
    assert.equal(clearance.capsule(at.x, at.z, nd.x, nd.z, CONNECTOR_BODY), null, `${en.street} connector`);
  }
});

test('the player stands on the raised walk (gf-runtime.js); New York loads none of it', async () => {
  // gf-terrain-data.js fetches its file: shim fetch for file: URLs
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).startsWith('file:') ? new Response(fs.readFileSync(fileURLToPath(url))) : realFetch(url));
  try {
    const rt = await import(pathToFileURL(path.join(root, 'js/gf-runtime.js')).href);
    const { PLAYER_WORLD } = await import(pathToFileURL(path.join(root, 'js/city-runtime.js')).href);
    const sw = rt.GF_SIDEWALKS;
    // a downtown walk point beside Glen Street, a residential lawn and walk on Maple Street, the road
    const pts = [];
    for (const entry of sw.rings) {
      if (entry.kind !== 'lot' || pts.length > 40) continue;
      const list = sw.ringSamples(entry);
      for (let k = 0; k < list.length && pts.length <= 40; k += 13) {
        const sm = list[k], at = sw.lotAt(entry, sm);
        const p = [sm.x + sm.nx * 0.6, sm.z + sm.nz * 0.6];
        if (at.roadside && !at.cut && rt.GF_BLOCKS.blockAt(...p) === entry.block && sw.serviceEdge(...p) > 1 && !rt.GF_SURFACE.deckAt(...p)) pts.push(p);
      }
    }
    for (const [x, z] of pts) {
      const g = rt.GF_SURFACE.ground(x, z);
      PLAYER_WORLD.setNear('person', NaN);
      assert.ok(Math.abs(PLAYER_WORLD.groundHeightAt(x, z, 'person') - (g + S.top)) < 1e-9, `person at (${x}, ${z})`);
      PLAYER_WORLD.setNear('car', NaN);
      assert.ok(Math.abs(PLAYER_WORLD.groundHeightAt(x, z, 'car') - (g + S.top)) < 1e-9, 'car');
      assert.equal(PLAYER_WORLD.groundHeightAt(x, z, 'helicopter'), rt.GF_SURFACE.support(x, z, NaN), 'the helicopter\'s floor is the support, as before');
    }
    assert.ok(pts.length > 30);
    // on a road: ROAD_LIFT over the ground, as before
    PLAYER_WORLD.setNear('person', NaN);
    assert.ok(Math.abs(PLAYER_WORLD.groundHeightAt(-120, -97, 'person') - (rt.GF_SURFACE.ground(-120, -97) + S.roadLift)) < 1e-9);
  } finally {
    globalThis.fetch = realFetch;
  }
  // New York: no import of the CC-005e modules from New York's or the shared modules, no preload, no city name in them
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  for (const f of ['js/nyc-main.js', 'js/nyc-runtime.js', 'js/city-runtime.js', 'js/controllers.js', 'js/pedestrian-routes.js', 'js/pedestrian-system.js', 'js/traffic.js', 'js/tsl-materials.js', 'js/city-grid.js']) {
    assert.doesNotMatch(read(f), /gf-sidewalk|gf-downtown|vehicle-exit-walk|tree lawn/i, f);
  }
  for (const f of ['js/gf-sidewalks.js', 'js/gf-sidewalk-strips.js', 'js/gf-sidewalk-meshes.js']) assert.doesNotMatch(read(f), /city\s*===|glensfalls/, `${f}: no city-name branching`);
  const main = read('js/main.js');
  const nycList = main.slice(main.indexOf('NYC_PRELOADS'), main.indexOf('];', main.indexOf('NYC_PRELOADS')));
  if (main.includes('NYC_PRELOADS')) assert.doesNotMatch(nycList, /gf-sidewalk|gf-downtown/);
  assert.match(main, /'gf-sidewalks\.js'/);
});
