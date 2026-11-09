import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeTerrain, createGfTerrain } from '../js/gf-terrain.js';
import { createGfSurface } from '../js/gf-surface.js';
import { ROAD_LIFT } from '../js/gf-drape.js';
import { buildRoadNetwork } from '../js/road-network.js';
import { createPedestrianRoutes } from '../js/pedestrian-routes.js';
import { gfRoadSource } from '../js/gf-roadgraph.js';
import { createGfBlocks } from '../js/gf-blocks.js';
import { gfBuildingsOnTerrain } from '../js/gf-building-bases.js';
import { applyLidarHeights } from '../js/gf-building-heights.js';
import { polygonContains } from '../js/building-collision.js';
import { placeGfTrees, TRUNK } from '../js/gf-tree-placements.js';
import { GF_GEO } from '../js/gf-geodata.js';
import { GF_BRIDGES } from '../js/gf-bridges.js';
import { GF_BUILDINGS } from '../js/gf-buildings.js';
import { GF_LANDMARKS } from '../js/gf-landmarks.js';
import { GF_LIDAR_HEIGHTS } from '../js/gf-lidar-heights.js';
import { GF_SIGNALS } from '../js/gf-signals.js';
import { GF_TREES } from '../js/gf-trees.js';
import { GF_TRAILS } from '../js/gf-trails.js';
import { createTrailNetwork, createTrailRoutes, trailGroundAt, trailDrapeGraph, TRAIL_LIFT, TRAIL_MOD, TRAIL_REM, ATTACH_REACH, CONNECTOR_BODY, BODY_HALF } from '../js/gf-trail-network.js';
import { planThrillHillParty, createPartySchedule, routeAround, isNight, THRILL_HILL_SCENE, NIGHT_GLOW, ATTENDEES, ATTENDEE_BODY, FIRE_CLEAR, FIRE_RING } from '../js/gf-thrill-hill-plan.js';
import { createClearance, waterRegions, buildingRegions, trunkRegions, discRegion, region, inRegion, capsuleHits, triangleHits } from '../js/gf-trail-clearance.js';
import { drapeRoads } from '../js/gf-drape.js';
import { buildTrails, moduleText, checkCorridor, segSquareDist, BODY } from '../tools/gf/build-gf-crandall-trails.mjs';
import { select } from '../tools/gf/select-gf-crandall-trails.mjs';

// CC-005c: the sourced trails through Crandall Park and Cole's Woods to Thrill Hill, the walkers who use them, the
// footbridge decks, the trees cleared from the paths and the fictional Thrill Hill party

const root = fileURLToPath(new URL('..', import.meta.url));
const KIT = path.join(root, 'tools/gf/data/trails');
const INPUT = path.join(root, 'tools/gf/data/gf_crandall_trails.geojson');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const quiet = (fn) => { const info = console.info; console.info = () => {}; try { return fn(); } finally { console.info = info; } };

// the game's world, as gf-runtime.js / gf-main.js build it
const terrain = createGfTerrain(decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(root, 'js/gf-terrain.bin.gz'))))), GF_GEO.frame);
const surface = createGfSurface({ terrain, geo: GF_GEO, bridges: GF_BRIDGES, footDecks: GF_TRAILS.footDecks });
const surfaceWithout = createGfSurface({ terrain, geo: GF_GEO, bridges: GF_BRIDGES });
const blocks = createGfBlocks(GF_GEO);
const { colliders: buildingColliders, obstacles } = gfBuildingsOnTerrain(applyLidarHeights(GF_BUILDINGS, GF_LIDAR_HEIGHTS).data, GF_LANDMARKS, surface.ground);
const inBuilding = (x, z) => buildingColliders.some((c) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && polygonContains(c.polygon, x, z));
const network = quiet(() => buildRoadNetwork([], [...blocks.lotObstacles, ...obstacles], GF_SIGNALS.junctions.map(([x, z]) => ({ x, z })), gfRoadSource(GF_GEO)));
const base = () => createPedestrianRoutes({ walkable: network.walkable, onSidewalk: blocks.onSidewalk }, blocks.blockAt, { insets: [0.6, 1.2] });
const net = createTrailNetwork(GF_TRAILS);
const excluded = new Set(GF_TRAILS.treeExclusions.trees.map((t) => t[0]));
const treesKept = placeGfTrees(GF_TREES, { buildings: GF_BUILDINGS, geo: GF_GEO, ground: surface.ground, exclude: excluded });
const treesAll = placeGfTrees(GF_TREES, { buildings: GF_BUILDINGS, geo: GF_GEO, ground: surface.ground });
// the game's obstacles for walkers (gf-main.js trailClearance): mapped water, building colliders, kept trunks
const water = waterRegions(GF_GEO.water), buildingsR = buildingRegions(buildingColliders), trunksR = trunkRegions(treesKept.trunks);
const obstaclesAll = createClearance([...water, ...buildingsR, ...trunksR]);
const segDist = (px, pz, ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0; return Math.hypot(px - ax - dx * t, pz - az - dz * t); };
// a seeded random (mulberry32)
const seeded = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

test('sources: the frozen kit files match the kit\'s own SHA256SUMS and the selection and the module regenerate byte for byte', () => {
  const sums = fs.readFileSync(path.join(KIT, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
  let checked = 0;
  for (const [h, file] of sums) {
    const p = path.join(KIT, file);
    if (!fs.existsSync(p)) continue; // the maps and PDFs (no reuse grant) are referenced by hash, not committed
    assert.equal(sha(fs.readFileSync(p)), h, file);
    checked++;
  }
  assert.ok(checked >= 11, `${checked} kit files checked`);
  // the selection (OSM XML -> accepted features) and the module (features -> gf-trails.js)
  assert.equal(JSON.stringify(select(), null, 1) + '\n', fs.readFileSync(INPUT, 'utf8'), 'tools/gf/select-gf-crandall-trails.mjs regenerates the geojson');
  assert.equal(GF_TRAILS.sha256, sha(fs.readFileSync(INPUT)));
  assert.equal(moduleText(buildTrails()), fs.readFileSync(path.join(root, 'js/gf-trails.js'), 'utf8'), 'tools/gf/build-gf-crandall-trails.mjs regenerates js/gf-trails.js');
});

test('malformed inputs are refused', () => {
  const fc = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const line = (f) => f.properties.accepted && f.geometry.type === 'LineString';
  const variant = (change) => { const c = structuredClone(fc); change(c, c.features.find(line)); return () => buildTrails(c, 'test'); };
  assert.throws(variant((c, f) => { f.geometry.coordinates[0] = [0, 0]; }), /outside Glens Falls/);
  assert.throws(variant((c, f) => { f.properties.sourceUrl = null; }), /missing source/);
  assert.throws(variant((c, f) => { f.properties.pedestrianAccess = null; }), /missing source or access/);
  assert.throws(variant((c, f) => { f.properties.widthM = 40; }), /impossible width/);
  assert.throws(variant((c, f) => { c.features.push(structuredClone(f)); }), /duplicate line/);
  assert.throws(variant((c, f) => { f.properties.nodeIds = f.properties.nodeIds.slice(1); }), /disagree/);
  assert.throws(variant((c, f) => { f.geometry.coordinates[1] = f.geometry.coordinates[0].slice(); f.properties.nodeIds[1] = f.properties.nodeIds[0]; f.geometry.coordinates.length = 2; f.properties.nodeIds.length = 2; }), /zero-length|two positions/);
});

test('fixtures: a pond mid-segment, a building, the clearance boundary, a junction turn, a nearby but unconnected end', () => {
  // dry ends, a pond in the middle: refused; the same line as a footbridge (a deck) passes; a building: refused
  const pond = { name: 'fixture pond', outer: [4, -3, 6, -3, 6, 3, 4, 3], holes: [] };
  const line = (kind, z = 0) => ({ id: `fixture-${kind}`, kind, widthM: 2, pts: [0, z, 10, z] });
  assert.throws(() => checkCorridor([line('path')], { water: [pond], buildings: [] }), /water \(fixture pond\)/);
  assert.doesNotThrow(() => checkCorridor([line('footbridge')], { water: [pond], buildings: [] }));
  assert.throws(() => checkCorridor([line('footbridge')], { water: [], buildings: [{ osm: 'w1', ...pond }] }), /a building \(w1\)/);
  // beside the pond, its edge 0.9 m from the water: the 2 m corridor (1 m half width) reaches in
  assert.throws(() => checkCorridor([line('path', -3.9)], { water: [pond], buildings: [] }), /meets water/);
  assert.doesNotThrow(() => checkCorridor([line('path', -4.1)], { water: [pond], buildings: [] }));
  // obstacles BETWEEN the old sample lines (centre and both edges) and stations (every 0.5 m): a 0.2 m puddle at
  // 0.5 m off the centre between two stations, a building corner poking 0.2 m into the edge between stations, and
  // a pond in the outside wedge of a bend (outside both segments' rectangles, inside the round join). Each is found.
  const sq = (x, z, h, extra = {}) => ({ outer: [x - h, z - h, x + h, z - h, x + h, z + h, x - h, z + h], holes: [], ...extra });
  const puddle = sq(5.25, 0.5, 0.1, { name: 'puddle' });
  assert.throws(() => checkCorridor([line('path')], { water: [puddle], buildings: [] }), /water \(puddle\)/);
  assert.doesNotThrow(() => checkCorridor([line('footbridge')], { water: [puddle], buildings: [] }), 'a mapped footbridge crosses it on its deck');
  // a diamond whose tip pokes 0.15 m into the corridor between stations 8.0 and 8.5 (no old sample point inside it)
  const corner = { osm: 'w-corner', outer: [7.8, -1.3, 8.25, -1.75, 8.7, -1.3, 8.25, -0.85], holes: [] };
  const oldSamples = [];
  for (let x = 0; x <= 10; x += 0.5) for (const z of [-1, 0, 1]) oldSamples.push([x, z]);
  for (const g of [puddle, corner]) assert.ok(!oldSamples.some(([x, z]) => inRegion(region([g.outer]), x, z)), 'the fixture lies between the old samples');
  assert.throws(() => checkCorridor([line('path')], { water: [], buildings: [corner] }), /a building \(w-corner\)/);
  assert.throws(() => checkCorridor([line('footbridge')], { water: [], buildings: [corner] }), /a building/, 'no exception for buildings');
  const bend = { id: 'fixture-bend', kind: 'path', widthM: 2, pts: [0, 0, 10, 0, 10, 10] };
  const wedge = sq(10.6, -0.6, 0.05, { name: 'wedge' }); // 0.78 m from the bend's corner, beyond both rectangles
  assert.throws(() => checkCorridor([bend], { water: [wedge], buildings: [] }), /water \(wedge\)/);
  assert.doesNotThrow(() => checkCorridor([bend], { water: [sq(10.8, -0.8, 0.05)], buildings: [] }), '1.06 m from the corner: clear');
  // a pond with an island: a path on the island is dry; one across the island's shore is not
  const ringPond = { name: 'ring pond', outer: [-20, -20, 20, -20, 20, 20, -20, 20], holes: [[-8, -8, 8, -8, 8, 8, -8, 8]] };
  assert.doesNotThrow(() => checkCorridor([{ id: 'island', kind: 'path', widthM: 2, pts: [-5, 0, 5, 0] }], { water: [ringPond], buildings: [] }));
  assert.throws(() => checkCorridor([{ id: 'shore', kind: 'path', widthM: 2, pts: [-5, 0, 7.5, 0] }], { water: [ringPond], buildings: [] }), /water/);
  // the exact tests themselves: a triangle meets a pond smaller than it, and a capsule one wholly inside it
  const tiny = region([[2, 1, 2.1, 1, 2.1, 1.1]]);
  assert.ok(triangleHits(tiny, [0, 0, 6, 0, 0, 6]) && !triangleHits(tiny, [3, 3, 6, 3, 3, 6]));
  assert.ok(capsuleHits(region([[-50, -50, 50, -50, 50, 50, -50, 50]]), 0, 0, 1, 0, 0.1), 'inside a region: a hit');
  // the tree rule: a trunk square (half 0.25) is cleared when within half the width + BODY of the line
  const reach = 1 + BODY, h = 0.25;
  assert.ok(segSquareDist(0, 0, 10, 0, 5, reach + h - 0.01, h) < reach, 'just inside: cleared');
  assert.ok(!(segSquareDist(0, 0, 10, 0, 5, reach + h + 0.01, h) < reach), 'just outside: kept');
  // a junction turn: outside the corner, near neither segment's middle but within reach of their shared end
  assert.ok(segSquareDist(0, 0, 10, 0, 11.2, -1.2, h) < reach && segSquareDist(10, 0, 10, 10, 11.2, -1.2, h) < reach);
  // a line ending 0.3 m from a graph node but not on it (no shared OSM node) is not joined: its component has no
  // entrance and the generator refuses it (no snap ever makes a connection)
  const fc = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const src = fc.features.find((f) => f.properties.accepted && f.properties.group === 'coles-corridor' && f.geometry.type === 'LineString');
  const copy = structuredClone(src);
  copy.properties.id = 'fixture-nearby';
  copy.properties.nodeIds = copy.properties.nodeIds.map((n) => `fixture-${n}`);
  copy.geometry.coordinates = copy.geometry.coordinates.map(([lon, lat]) => [lon + 0.0000037, lat]);
  fc.features.push(copy);
  assert.throws(() => buildTrails(fc, 'test'), /has no entrance/);
});

test('only the accepted, pedestrian-permitted sources are in the graph', () => {
  const fc = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const accepted = new Map(fc.features.filter((f) => f.properties.accepted && f.geometry.type === 'LineString').map((f) => [f.properties.id, f]));
  const rejectedWays = new Set(fc.features.filter((f) => !f.properties.accepted).map((f) => f.properties.osmWayId).filter(Boolean));
  for (const e of GF_TRAILS.edges) {
    const f = accepted.get(e.line);
    assert.ok(f, `${e.id}: from an accepted line`);
    assert.ok(f.properties.sourceUrl && f.properties.pedestrianAccess, e.id);
    assert.equal(f.properties.osmWayId, e.way);
    assert.ok(e.widthM > 0 && e.widthBasis, `${e.id}: a width and its basis`);
    if (e.kind === 'drive') assert.match(f.properties.pedestrianAccess, /foot=designated/, `${e.id}: a drive only where foot=designated`);
  }
  // an excluded way is never accepted in part (a way partly used, the selection's node range, is accepted)
  for (const w of rejectedWays) assert.ok(GF_TRAILS.edges.every((e) => e.way !== w) || [...accepted.values()].some((f) => f.properties.osmWayId === w), w);
  assert.equal(GF_TRAILS.counts.components, 3);
  assert.equal(GF_TRAILS.footDecks.length, 5);
  // the hill: the crest node on the hill way, with county vertex #137 beside it
  assert.equal(GF_TRAILS.hill.countyVertex, 137);
  assert.ok(GF_TRAILS.hill.crestToVertexM < 15, `${GF_TRAILS.hill.crestToVertexM} m from #137`);
  assert.equal(net.node(GF_TRAILS.hill.node).x, GF_TRAILS.hill.crestX);
  // the crest is the highest point along the hill way's edges
  for (const e of GF_TRAILS.edges.filter((ed) => ed.way === GF_TRAILS.hill.pathWay)) {
    for (let k = 0; k + 3 < e.pts.length; k += 2) for (let i = 0; i <= 10; i++) {
      const x = e.pts[k] + (e.pts[k + 2] - e.pts[k]) * i / 10, z = e.pts[k + 1] + (e.pts[k + 3] - e.pts[k + 1]) * i / 10;
      assert.ok(terrain.heightAt(x, z) <= GF_TRAILS.hill.crestY + 0.02, `(${x}, ${z}) above the crest`);
    }
  }
});

test('paths and footbridges, exactly: the drawn surfaces, joins and decks clear of water (but on a deck), buildings and every kept trunk', () => {
  // 1. every drawn path triangle (gf-drape.js on the game's own trail graph: ribbons, round joins, bend wedges) in
  // full: no water, no building; and BODY (0.48 m, the player) clear of every kept trunk
  const { positions, indices } = drapeRoads(trailDrapeGraph(GF_TRAILS), () => true, surface);
  let triangles = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [];
    for (let k = 0; k < 3; k++) tri.push(positions[indices[t + k] * 3], positions[indices[t + k] * 3 + 2]);
    triangles++;
    const hit = obstaclesAll.triangle(tri, 0, (o) => o.kind !== 'trunk') || obstaclesAll.triangle(tri, BODY, (o) => o.kind === 'trunk');
    assert.equal(hit, null, `path triangle ${t / 3} (${tri.map((v) => v.toFixed(2))}) meets ${hit && hit.kind} ${hit && hit.name}`);
  }
  assert.ok(triangles > 3000, `${triangles} triangles`);
  // 2. every path, footbridge and drive surface as capsules (each segment swept by half its width: what the drape can
  // cover, joins included): water only under a footbridge; never a building
  for (const e of GF_TRAILS.edges) {
    for (let k = 0; k + 3 < e.pts.length; k += 2) {
      const hit = obstaclesAll.capsule(e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3], e.widthM / 2, (o) => o.kind === 'building' || (o.kind === 'water' && e.kind !== 'footbridge'));
      assert.equal(hit, null, `${e.id} segment ${k / 2} meets ${hit && hit.kind}`);
      if (e.kind !== 'drive') assert.equal(obstaclesAll.capsule(e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3], e.widthM / 2 + BODY, (o) => o.kind === 'trunk'), null, `${e.id}: a kept trunk within the body clearance`);
    }
  }
  // 3. every walker lane, whole (each track swept by a walker's half width): no building, no kept trunk; water only
  // on a footbridge's own lane, whose deck stands above it
  for (const [k, pair] of net.lanes.entries()) {
    const e = net.edges[k];
    for (const lane of pair) for (const tr of lane.tracks) {
      const bx = tr.ax + tr.ux * tr.len, bz = tr.az + tr.uz * tr.len;
      const hit = obstaclesAll.capsule(tr.ax, tr.az, bx, bz, BODY_HALF, (o) => o.kind !== 'water' || e.kind !== 'footbridge');
      assert.equal(hit, null, `${e.id} lane meets ${hit && hit.kind}`);
    }
  }
  // the decks over water stand above it
  for (const d of surface.footDecks) for (const c of d.segments) for (let i = 0; i <= 40; i++) {
    const x = c.from[0] + (c.to[0] - c.from[0]) * i / 40, z = c.from[1] + (c.to[1] - c.from[1]) * i / 40, w = surface.water.surfaceAt(x, z);
    if (w !== null) assert.ok(surface.footDeckAt(x, z).y >= w, `${d.name}: deck above the water`);
  }
});

test('footbridge decks: walkers only, continuous with the ground at their ends, never under it', () => {
  for (const d of surface.footDecks) {
    assert.ok(d.foot);
    for (const [k, [x, z]] of d.ends.entries()) assert.ok(Math.abs(d.endY[k] - surface.ground(x, z)) < 1e-9, `${d.name} end ${k}`);
    for (const c of d.segments) for (let i = 0; i <= 10; i++) {
      const x = c.from[0] + (c.to[0] - c.from[0]) * i / 10, z = c.from[1] + (c.to[1] - c.from[1]) * i / 10;
      const f = surface.footDeckAt(x, z);
      assert.ok(f && f.y >= surface.ground(x, z) - 1e-9, `${d.name} at ${i}/10`);
      // support() stands on it; road() and deckAt() (vehicles) never see it: the same as without foot decks
      assert.ok(surface.support(x, z) >= f.y - 1e-9);
      assert.equal(surface.road(x, z, 1, 0), surfaceWithout.road(x, z, 1, 0));
      assert.equal(surface.deckAt(x, z), surfaceWithout.deckAt(x, z));
    }
  }
  // the road decks themselves are unchanged by the opt-in
  assert.deepEqual(surface.decks.map((d) => [d.id, d.length, d.endY]), surfaceWithout.decks.map((d) => [d.id, d.length, d.endY]));
  assert.equal(TRAIL_LIFT, ROAD_LIFT, 'walkers stand on the drawn path');
  const deckEdge = net.edges.find((e) => e.kind === 'footbridge'), lane = net.lanes[deckEdge.index][0], tr = lane.tracks[0];
  const p = { route: tr }, x = tr.ax + tr.ux * tr.len / 2, z = tr.az + tr.uz * tr.len / 2;
  assert.equal(trailGroundAt(surface)(x, z, tr.ux, tr.uz, p), surface.footDeckAt(x, z).y + TRAIL_LIFT);
  const pathEdge = net.edges.find((e) => e.kind === 'path'), pt = net.lanes[pathEdge.index][0].tracks[0];
  assert.equal(trailGroundAt(surface)(pt.ax, pt.az, pt.ux, pt.uz, { route: pt }), surface.ground(pt.ax, pt.az) + TRAIL_LIFT);
  assert.equal(trailGroundAt(surface)(pt.ax, pt.az, 1, 0, { route: {} }), surface.road(pt.ax, pt.az, 1, 0), 'off the trails: the street surface as before');
});

test('trees: exactly those whose trunk reaches a path or footbridge corridor are cleared, no others', () => {
  const t = GF_TREES.trees;
  const corridor = GF_TRAILS.edges.filter((e) => e.kind !== 'drive');
  const reaches = (site) => {
    const half = Math.max(TRUNK.minHalf, TRUNK.halfPerM * t[site.index * 4 + 2]);
    return corridor.some((e) => { for (let k = 0; k + 3 < e.pts.length; k += 2) if (segSquareDist(e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3], site.x, site.z, half) < e.widthM / 2 + BODY) return true; return false; });
  };
  const expected = treesAll.sites.filter(reaches).map((s) => s.index);
  assert.deepEqual([...excluded].sort((a, b) => a - b), expected);
  assert.equal(treesKept.skipped.trail, excluded.size);
  // every drawn tree has its trunk collider, and only those (the player's colliders agree with the rendered trees)
  assert.equal(treesKept.trunks.length, treesKept.sites.length);
  // outside the clearing, every tree is placed exactly as before (x, z, height, species)
  const kept = new Map(treesKept.sites.map((s) => [s.index, s]));
  for (const s of treesAll.sites) if (!excluded.has(s.index)) assert.deepEqual(kept.get(s.index), s);
  assert.equal(treesAll.sites.length - treesKept.sites.length, excluded.size);
  assert.ok(excluded.size === 70, `${excluded.size} trees cleared`);
  for (const row of GF_TRAILS.treeExclusions.trees) assert.ok(GF_TRAILS.edges.some((e) => e.id === row[5]), `tree ${row[0]} names its path`);
});

test('entrances: each component reaches a sidewalk; connectors stay on their side of the street and out of buildings', () => {
  const routes = createTrailRoutes(base(), network, net, { random: seeded(1), clearance: obstaclesAll });
  const walkable = routes.walkable;
  assert.equal(walkable.length, 6, 'all but Angel Lane (no sidewalks in the game\'s network there)');
  assert.ok(!walkable.some((en) => en.street === 'Angel Lane'));
  for (let c = 0; c < net.components; c++) assert.ok(walkable.some((en) => en.component === c), `component ${c} has a walkers' entrance`);
  for (const en of walkable) {
    const at = routes.attach.get(en), n = net.node(en.node);
    assert.ok(at.d <= ATTACH_REACH, `${en.street}: ${at.d} m`);
    assert.ok(routes.splitCount(en) >= 1, `${en.street}: a sidewalk split`);
    // the connector, whole, swept by a body (0.48 m): no water, building or kept trunk
    assert.equal(obstaclesAll.capsule(at.x, at.z, n.x, n.z, CONNECTOR_BODY), null, `${en.street} connector`);
    // never across a street: every point of the connector at least 1 m from every street's centre line
    for (let i = 0; i <= 20; i++) {
      const x = at.x + (n.x - at.x) * i / 20, z = at.z + (n.z - at.z) * i / 20;
      for (const e of network.edges) assert.ok(segDist(x, z, e.sx, e.sz, e.sx + e.dx * e.len, e.sz + e.dz * e.len) >= 1, `${en.street} connector crosses a street`);
    }
  }
  // with an obstacle on a connector, that attachment is refused (another, clear one, or none)
  const en0 = walkable.find((en) => en.street === 'Park View Avenue'), at0 = routes.attach.get(en0), n0 = net.node(en0.node);
  const blocker = createClearance([...water, ...buildingsR, ...trunksR, discRegion((at0.x + n0.x) / 2, (at0.z + n0.z) / 2, 0.3, { kind: 'trunk' })]);
  const blocked = createTrailRoutes(base(), network, net, { random: seeded(1), clearance: blocker }).attach.get(net.entrances.find((en) => en.street === 'Park View Avenue'));
  assert.ok(!blocked || blocker.capsule(blocked.x, blocked.z, n0.x, n0.z, CONNECTOR_BODY) === null);
  // every node is reachable from a walkers' entrance of its component
  for (let u = 0; u < net.nodes; u++) assert.ok(walkable.some((en) => Number.isFinite(net.dist[en.node][u])), `node ${u}`);
});

// Walk a pedestrian through next() legs (as pedestrian-system.js does at each track's end), checking each leg starts
// where the last ended
function walkLegs(routes, start, p, maxLegs = 400) {
  let cur = start, onTrail = false, entered = false, left = false;
  const visited = [];
  let pending = [];
  for (let i = 0; i < maxLegs; i++) {
    if (!pending.length) {
      const next = routes.next(cur.track, cur.dir, 0, 0, p);
      if (!next) break;
      pending = next.slice();
    }
    const leg = pending.shift();
    const end = { x: cur.track.ax + cur.track.ux * (cur.dir > 0 ? cur.track.len : 0), z: cur.track.az + cur.track.uz * (cur.dir > 0 ? cur.track.len : 0) };
    const begin = { x: leg.track.ax + (leg.dir > 0 ? 0 : leg.track.ux * leg.track.len), z: leg.track.az + (leg.dir > 0 ? 0 : leg.track.uz * leg.track.len) };
    assert.ok(Math.hypot(end.x - begin.x, end.z - begin.z) < 0.05, `leg ${i} starts ${Math.hypot(end.x - begin.x, end.z - begin.z).toFixed(3)} m from the last one's end`);
    p.route = leg.track;
    const t = !!leg.track.trail;
    if (t && !onTrail) entered = true;
    if (!t && onTrail) { left = true; visited.push({ x: begin.x, z: begin.z, left: true }); break; }
    onTrail = t;
    if (t && !leg.track.trail.connector) visited.push({ x: begin.x, z: begin.z, edge: leg.track.trail.edge });
    cur = leg;
  }
  return { entered, left, visited };
}
const pieceTo = (routes, en) => {
  for (const list of routes.pieces.values()) for (const piece of list) if (piece.entranceEnd === en) return piece;
  return null;
};

test('seeded trail walkers enter at an entrance, reach the crest of Thrill Hill (woods) or a park place, and come back out', () => {
  for (const [street, comp] of [['Park View Avenue', 'woods'], ['Glen Street', 'park'], ['Horicon Avenue', 'park']]) {
    for (const seed of [1, 2, 3]) {
      const routes = createTrailRoutes(base(), network, net, { random: seeded(seed) });
      const en = routes.walkable.find((e) => e.street === street);
      const piece = pieceTo(routes, en);
      const p = { index: TRAIL_REM, trailWalk: null };
      // offered the entrance until the walker turns in (ENTER_CHANCE)
      let res = null;
      for (let k = 0; k < 20 && !(res && res.entered); k++) res = walkLegs(routes, { track: piece, dir: 1 }, p);
      assert.ok(res.entered && res.left, `${street} seed ${seed}: entered and left`);
      if (comp === 'woods') {
        const crest = net.node(GF_TRAILS.hill.node);
        assert.ok(res.visited.some((v) => Math.hypot(v.x - crest.x, v.z - crest.z) < 1.5), `${street} seed ${seed}: reached the crest`);
      }
      const out = res.visited[res.visited.length - 1];
      assert.ok(routes.walkable.some((w) => Math.hypot(routes.attach.get(w).x - out.x, routes.attach.get(w).z - out.z) < 40), 'left by a walkers\' entrance');
      assert.equal(p.trailWalk, null, 'trail state cleared on leaving');
    }
  }
  // a pedestrian who is not a trail walker passes the entrance by
  const routes = createTrailRoutes(base(), network, net, { random: () => 0 });
  const en = routes.walkable.find((e) => e.street === 'Park View Avenue');
  const piece = pieceTo(routes, en);
  for (let i = 0; i < 120; i++) {
    if (i % TRAIL_MOD === TRAIL_REM) continue;
    const next = routes.next(piece, 1, 0, 0, { index: i });
    assert.ok(next && !next[0].track.trail, `pedestrian ${i} keeps to the sidewalk`);
  }
  // NYC and anything without the opt-in: the base routes are used as they are (pedestrian-system.js routes = null)
  const src = fs.readFileSync(path.join(root, 'js/pedestrian-system.js'), 'utf8');
  assert.match(src, /routes: wrapRoutes = null/);
  assert.match(src, /wrapRoutes \? wrapRoutes\(baseRoutes, network\) : baseRoutes/);
  for (const f of ['nyc-main.js', 'traffic.js', 'pedestrian-routes.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'js', f), 'utf8'), /gf-trail|thrill-hill/, `${f} knows nothing of the trails`);
  }
});

// The party's world: the kept trees' trunks
const plan = planThrillHillParty({ trails: GF_TRAILS, net, ground: surface.ground, trunks: treesKept.trunks, water: surface.water.surfaceAt });

test('Thrill Hill party: a fictional scene beside the crest, clear of the trail and every kept tree, the same every time', () => {
  assert.equal(THRILL_HILL_SCENE.fictional, true);
  assert.match(THRILL_HILL_SCENE.description, /fictional/i);
  const again = planThrillHillParty({ trails: GF_TRAILS, net, ground: surface.ground, trunks: treesKept.trunks, water: surface.water.surfaceAt });
  assert.deepEqual(again, plan, 'deterministic');
  const { fire, keg, slots, cups } = plan;
  assert.ok(Math.hypot(fire.x - GF_TRAILS.hill.crestX, fire.z - GF_TRAILS.hill.crestZ) < 12, 'beside the crest');
  assert.ok(plan.clearance.fireTrunkM >= FIRE_CLEAR, `fire ${plan.clearance.fireTrunkM} m from a trunk`);
  assert.ok(plan.clearance.fireTrailM >= FIRE_RING + 1, `fire ${plan.clearance.fireTrailM} m beyond the path's edge`);
  assert.ok(slots.length >= 5 && slots.length <= ATTENDEES, `${slots.length} places`);
  const trailGap = (x, z) => Math.min(...GF_TRAILS.edges.map((e) => { let b = Infinity; for (let k = 0; k + 3 < e.pts.length; k += 2) b = Math.min(b, segDist(x, z, e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3])); return b - e.widthM / 2; }));
  const trunkGap = (x, z) => Math.min(...treesKept.trunks.map((t) => Math.hypot(Math.max(t.minX - x, 0, x - t.maxX), Math.max(t.minZ - z, 0, z - t.maxZ))));
  for (const s of [...slots, keg]) {
    assert.ok(trailGap(s.x, s.z) > 0.5, 'off the path');
    assert.ok(trunkGap(s.x, s.z) > 0.4, 'not in a trunk');
    assert.equal(surface.water.surfaceAt(s.x, s.z), null);
  }
  for (const c of cups) assert.ok(trailGap(c.x, c.z) > 0 && Math.hypot(c.x - fire.x, c.z - fire.z) > FIRE_RING, 'cups off the path and out of the ring');
  // no tree is removed for the party: the trees it stands among are the trail-cleared set, unchanged
  assert.equal(treesKept.sites.length, treesAll.sites.length - excluded.size);
  // non-walkable: the fire ring and the keg are colliders; the places are outside them
  assert.deepEqual(plan.colliders.map((c) => c.party), ['fire', 'keg']);
  for (const s of slots) for (const c of plan.colliders) assert.ok(!polygonContains(c.polygon, s.x, s.z), 'a place inside a collider');
  for (const c of plan.colliders) assert.ok(polygonContains(c.polygon, (c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2) && c.maxY > c.minY);
  // every way in runs on the trail lanes to the crest, then round the fire, keg and trunks to its place: each piece,
  // whole, swept by an attendee's body, clears the fire ring, the keg and every kept trunk (not just its end)
  const props = createClearance([discRegion(fire.x, fire.z, FIRE_RING, { kind: 'fire' }), discRegion(keg.x, keg.z, keg.r, { kind: 'keg' }), ...trunksR]);
  const crest = { x: GF_TRAILS.hill.crestX, z: GF_TRAILS.hill.crestZ };
  let routed = 0;
  for (const [k, p] of plan.paths.entries()) {
    assert.ok(p.length >= 45);
    const last = p.pts[p.pts.length - 1];
    assert.equal(last.x, slots[k].x);
    const atCrest = p.pts.findIndex((q) => Math.hypot(q.x - crest.x, q.z - crest.z) < 1);
    assert.ok(atCrest > 0, 'the way in reaches the crest on the path');
    for (const q of p.pts.slice(0, atCrest + 1)) assert.ok(trailGap(q.x, q.z) < 0.1, 'the way in follows the path to the crest');
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const a = p.pts[i], b = p.pts[i + 1], hit = props.capsule(a.x, a.z, b.x, b.z, ATTENDEE_BODY);
      assert.equal(hit, null, `way ${k} piece ${i} meets the ${hit && hit.kind}`);
      assert.equal(obstaclesAll.capsule(a.x, a.z, b.x, b.z, ATTENDEE_BODY, (o) => o.kind !== 'trunk'), null, `way ${k}: water or a building`);
    }
    if (p.pts.length - atCrest > 2) routed++;
  }
  // the straight line from the crest to some places runs through the fire: those ways go round
  const straightThrough = slots.filter((s) => props.capsule(crest.x, crest.z, s.x, s.z, ATTENDEE_BODY) !== null).length;
  assert.ok(straightThrough > 0 && routed >= straightThrough, `${straightThrough} straight lines blocked, ${routed} ways routed round`);
  // routeAround itself: round a disc set across the straight line, clear along every piece, or null when walled in
  const wall = createClearance([discRegion(5, 0, 1)]);
  const way = routeAround(wall, { x: 0, z: 0 }, { x: 10, z: 0 }, 0.45);
  assert.ok(way.length > 2);
  for (let i = 0; i + 1 < way.length; i++) assert.equal(wall.capsule(way[i].x, way[i].z, way[i + 1].x, way[i + 1].z, 0.45), null);
  const ringed = createClearance(Array.from({ length: 24 }, (_, i) => discRegion(10 + Math.cos(i / 12 * Math.PI) * 3, Math.sin(i / 12 * Math.PI) * 3, 0.6)));
  assert.equal(routeAround(ringed, { x: 0, z: 0 }, { x: 10, z: 0 }, 0.45), null, 'a place walled in by obstacles is never reached through them');
});

test('Thrill Hill party: night and day follow the clock, without doubling anyone on transitions or advance()', () => {
  // lighting.js presets: golden 0.48, midday 0.24 (day); twilight 1.25, midnight 1.55 (night)
  const src = fs.readFileSync(path.join(root, 'js/lighting.js'), 'utf8');
  const glow = Object.fromEntries([...src.matchAll(/id: '(\w+)'[\s\S]*?interiorGlow: ([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(Object.fromEntries(Object.entries(glow).map(([k, v]) => [k, isNight(v)])), { golden: false, midday: false, twilight: true, midnight: true });
  assert.equal(NIGHT_GLOW, 0.65);
  const run = (steps) => {
    const s = createPartySchedule(plan);
    const log = [];
    for (const [what, arg] of steps) {
      if (what === 'set') s.setNight(arg.on, arg);
      else for (let i = 0; i < arg * 30; i++) s.update(1 / 30);
      const counts = s.counts();
      assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), plan.slots.length, 'everyone exactly once');
      log.push([counts, s.people.map((p) => [p.phase, +p.x.toFixed(4), +p.z.toFixed(4)])]);
    }
    return { s, log };
  };
  const steps = [['set', { on: true, instant: true }], ['run', 1], ['set', { on: true }], ['set', { on: false }], ['run', 3], ['set', { on: true }],
    ['run', 2], ['set', { on: false }], ['run', 200], ['set', { on: false }], ['run', 1], ['set', { on: true }], ['run', 200]];
  const a = run(steps), b = run(steps);
  assert.deepEqual(a.log, b.log, 'deterministic');
  // the whole movement, through clock changes and reversals mid-way: every step each person takes (the segment from
  // one frame's position to the next), swept by their body, clears the fire ring, the keg and every kept trunk
  const props = createClearance([discRegion(plan.fire.x, plan.fire.z, FIRE_RING), discRegion(plan.keg.x, plan.keg.z, plan.keg.r), ...trunksR]);
  const random = seeded(7);
  const sched = createPartySchedule(plan);
  sched.setNight(false, { instant: true });
  let steps2 = 0, reversals = 0, prev = sched.people.map((p) => [p.x, p.z, 'away']);
  for (let f = 0; f < 30 * 900; f++) {
    if (random() < 1 / 240) { // about every 8 s, a clock change, often while people are on the way
      const was = sched.night;
      sched.setNight(random() < 0.5);
      if (sched.night !== was && sched.people.some((p) => p.phase === 'arriving' || p.phase === 'leaving')) reversals++;
    }
    sched.update(1 / 30);
    sched.people.forEach((p, k) => {
      const [x0, z0, was] = prev[k];
      // a walked step: drawn before and after (appearing at the trail end, or going away there, is not a step)
      if (was !== 'away' && was !== 'waiting' && sched.visible(p)) {
        steps2++;
        assert.ok(Math.hypot(p.x - x0, p.z - z0) <= 1.25 / 30 + 1e-9, `person ${k} at frame ${f} jumps`);
        assert.equal(props.capsule(x0, z0, p.x, p.z, ATTENDEE_BODY), null, `person ${k} at frame ${f} (${p.phase}) steps through the fire, keg or a trunk`);
      }
      // every drawn position, too
      if (sched.visible(p)) assert.equal(props.capsule(p.x, p.z, p.x, p.z, ATTENDEE_BODY), null);
      prev[k] = [p.x, p.z, sched.visible(p) ? p.phase : (p.phase === 'away' ? 'away' : 'waiting')];
    });
  }
  assert.ok(steps2 > 10000 && reversals > 20, `${steps2} steps checked, ${reversals} clock changes with people on the way`);
  assert.deepEqual(a.log[0][0], { at: plan.slots.length }, 'night on load: everyone in place');
  assert.deepEqual(a.log[8][0], { away: plan.slots.length }, 'day: everyone gone');
  assert.deepEqual(a.log[a.log.length - 1][0], { at: plan.slots.length }, 'back at night: everyone in place again');
  // a repeated setting changes nothing
  const s = createPartySchedule(plan);
  s.setNight(false, { instant: true });
  assert.equal(s.setNight(false), false);
  assert.deepEqual(s.counts(), { away: plan.slots.length });
  // advance(): many small steps or few big ones end the same (both arrive everyone)
  const c = createPartySchedule(plan), d = createPartySchedule(plan);
  c.setNight(false, { instant: true }); d.setNight(false, { instant: true });
  c.setNight(true); d.setNight(true);
  for (let i = 0; i < 300 * 30; i++) c.update(1 / 30);
  for (let i = 0; i < 300; i++) d.update(1);
  assert.deepEqual(c.counts(), d.counts());
  assert.deepEqual(c.people.map((p) => [p.x, p.z]), d.people.map((p) => [p.x, p.z]));
});

test('the game wires it all: trails, tree clearing, trail walkers, the party on the clock, preloads', () => {
  const main = fs.readFileSync(path.join(root, 'js/gf-main.js'), 'utf8');
  for (const s of ['buildTrailMeshes(scene, GF_TRAILS, GF_SURFACE)', 'exclude: new Set(GF_TRAILS.treeExclusions.trees.map((t) => t[0]))', 'createTrailRoutes(base, network, TRAIL_NET, { clearance: trailClearance })',
    'trailGroundAt(GF_SURFACE)', 'party.setTime(cityUniforms.uInteriorGlow.value', '...trailMeshes.colliders', "get('party') === 'off'"]) assert.ok(main.includes(s), s);
  const preloads = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');
  for (const f of ['gf-trails.js', 'gf-trail-network.js', 'gf-trail-clearance.js', 'gf-trail-meshes.js', 'gf-thrill-hill-plan.js', 'gf-thrill-hill.js']) assert.ok(preloads.includes(`'${f}'`), f);
  assert.ok(net.edges.length === GF_TRAILS.edges.length && TRAIL_MOD === 10 && TRAIL_REM === 3);
});
