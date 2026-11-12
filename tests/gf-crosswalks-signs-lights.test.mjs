import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeTerrain, createGfTerrain } from '../js/gf-terrain.js';
import { createGfSurface } from '../js/gf-surface.js';
import { buildRoadNetwork } from '../js/road-network.js';
import { createPedestrianRoutes } from '../js/pedestrian-routes.js';
import { gfRoadSource, driveLinks } from '../js/gf-roadgraph.js';
import { createGfBlocks } from '../js/gf-blocks.js';
import { gfBuildingsOnTerrain } from '../js/gf-building-bases.js';
import { applyLidarHeights } from '../js/gf-building-heights.js';
import { GF_GEO } from '../js/gf-geodata.js';
import { GF_BRIDGES } from '../js/gf-bridges.js';
import { GF_BUILDINGS } from '../js/gf-buildings.js';
import { GF_LANDMARKS } from '../js/gf-landmarks.js';
import { GF_LIDAR_HEIGHTS } from '../js/gf-lidar-heights.js';
import { GF_SIGNALS } from '../js/gf-signals.js';
import { GF_FURNITURE } from '../js/gf-furniture.js';
import { createGfSidewalks } from '../js/gf-sidewalks.js';
import { createGfCrossings, KERB_BACK } from '../js/gf-crossings.js';
import { placeStopSigns, edgeClasses } from '../js/gf-stop-signs.js';
import { placeStreetLights, lampGlow, SPACING_DOWNTOWN, SPACING_RESIDENTIAL, OFFSET } from '../js/gf-street-lights.js';
import { buildGfFurniture, moduleText } from '../tools/gf/build-gf-furniture.mjs';

// CC-006: Glens Falls crosswalks, stop signs and street lights; the signals they sit beside (CC-002b) unchanged

const root = fileURLToPath(new URL('..', import.meta.url));
const quiet = (fn) => { const info = console.info; console.info = () => {}; try { return fn(); } finally { console.info = info; } };
const terrain = createGfTerrain(decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(root, 'js/gf-terrain.bin.gz'))))), GF_GEO.frame);
const surface = createGfSurface({ terrain, geo: GF_GEO, bridges: GF_BRIDGES });
const blocks = createGfBlocks(GF_GEO);
const sidewalks = createGfSidewalks({ geo: GF_GEO, blocks, ground: surface.ground });
const { obstacles } = gfBuildingsOnTerrain(applyLidarHeights(GF_BUILDINGS, GF_LIDAR_HEIGHTS).data, GF_LANDMARKS, surface.ground);
// as gf-main.js builds them
const network = quiet(() => buildRoadNetwork([], [...blocks.lotObstacles, ...obstacles], GF_SIGNALS.junctions.map(([x, z]) => ({ x, z })), gfRoadSource(GF_GEO)));
const marked = [
  ...GF_FURNITURE.crossings.map(([x, z, osm, kind]) => ({ x, z, osm: String(osm), kind })),
  ...GF_SIGNALS.crossings.map(([x, z, osm]) => ({ x, z, osm: String(osm), kind: 'traffic_signals' }))
];
const crossings = createGfCrossings({ marked, blockAt: blocks.blockAt, onWalk: sidewalks.onWalk });
const routes = createPedestrianRoutes({ walkable: network.walkable, onSidewalk: sidewalks.onWalk }, blocks.blockAt, { insets: sidewalks.insetsFor, crossings: crossings.crossingsFor });
const stops = GF_FURNITURE.stops.map(([x, z, osm, all, direction]) => ({ x, z, osm: String(osm), all: !!all, direction }));
const giveWays = GF_FURNITURE.giveWays.map(([x, z, osm]) => ({ x, z, osm: String(osm) }));
const classOf = edgeClasses(driveLinks(GF_GEO));
const stopPlan = placeStopSigns({ network, stops, giveWays, blockAt: blocks.blockAt, classOf });

test('sources: the street furniture regenerates from the frozen OSM extract; the signals are still CC-002b\'s', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'tools/gf/data/osm_gf_street_furniture.json'), 'utf8'));
  assert.equal(moduleText(buildGfFurniture(raw)), fs.readFileSync(path.join(root, 'js/gf-furniture.js'), 'utf8'), 'js/gf-furniture.js is stale');
  // the extract and the module agree on what each list holds
  const tagged = raw.elements.filter((e) => e.type === 'node' && e.tags);
  assert.equal(GF_FURNITURE.stops.length, tagged.filter((e) => e.tags.highway === 'stop' || e.tags.traffic_sign === 'stop').length);
  assert.equal(GF_FURNITURE.giveWays.length, tagged.filter((e) => e.tags.highway === 'give_way').length);
  assert.equal(GF_FURNITURE.lamps.length, tagged.filter((e) => e.tags.highway === 'street_lamp').length);
  for (const [, , osm, kind] of GF_FURNITURE.crossings) {
    const e = tagged.find((n) => n.id === osm);
    assert.ok(e && e.tags.crossing !== 'traffic_signals' && kind.length, `crossing ${osm}`);
    assert.ok(!['unmarked', 'no'].includes(e.tags.crossing) || (e.tags['crossing:markings'] && e.tags['crossing:markings'] !== 'no'), `crossing ${osm} is marked`);
  }
  // the frozen extract (OSM base 2026-11-12T11:26:55Z) has the counts the CC-006 spec gives for the bbox
  const c = GF_FURNITURE.counts;
  assert.deepEqual([c.highwayStop, c.trafficSignStopOnly, c.stopAll, c.giveWay, c.crossingNodes, c.signalCrossings, c.lamps], [55, 4, 37, 7, 325, 24, 24]);
  // CC-002b: 51 OSM signal junctions, 41 signalled in the network, 24 signalled pedestrian crossings
  assert.equal(GF_SIGNALS.junctions.length, 51);
  assert.equal(GF_SIGNALS.crossings.length, 24);
  assert.equal(network.nodes.filter((n) => n.signal).length, 41);
});

test('crosswalks: on every arm of the signalled junctions, walkable at most of them, across the whole road', () => {
  const signalled = network.nodes.filter((n) => n.signal);
  let painted = 0, walkedNodes = 0, tracks = 0;
  for (const n of signalled) {
    const list = crossings.crossingAt(n);
    assert.ok(list.length >= Math.min(2, n.arms.length), `junction (${n.x.toFixed(0)}, ${n.z.toFixed(0)}) has crosswalks`);
    painted += list.length;
    const t = routes.across(n);
    if (t.length) walkedNodes++;
    tracks += t.length;
    for (const tr of t) {
      // a track: from the walk one side, over the road, to the walk the other side; its ends on the concrete
      assert.equal(tr.node, n);
      assert.ok(sidewalks.onWalk(tr.ax, tr.az) && sidewalks.onWalk(tr.ax + tr.ux * tr.len, tr.az + tr.uz * tr.len));
      const mid = { x: tr.ax + tr.ux * tr.len / 2, z: tr.az + tr.uz * tr.len / 2 };
      assert.equal(blocks.blockAt(mid.x, mid.z), null, 'its middle on the road');
      // the road's lateral axis (traffic.js laneCoord): + from a to b
      const road = n.in.concat(n.out).find((e) => (e.inArm || e.outArm) && (e.to === n ? e.inArm : e.outArm).side === tr.side);
      const flip = road.rx < -1e-6 || (Math.abs(road.rx) <= 1e-6 && road.rz < 0);
      assert.ok(tr.ux * (flip ? -road.rx : road.rx) + tr.uz * (flip ? -road.rz : road.rz) > 0.9, 'runs along the road\'s lateral axis');
      assert.ok(tr.len >= 2 * 1.8 + 3, 'kerb ends and the road between');
    }
  }
  assert.ok(painted >= 130, `${painted} crosswalks painted`);
  assert.ok(walkedNodes >= 32, `${walkedNodes} of ${signalled.length} signalled junctions walkable`);
  assert.ok(tracks >= 150, `${tracks} crosswalk tracks`);
  assert.equal(KERB_BACK, 2);
  // marked crossings: each either on a junction's arm (matched) or painted mid-block or reported
  for (const n of network.nodes) crossings.crossingAt(n);
  const mid = crossings.midBlock(network);
  assert.equal(crossings.matched.size + mid.painted.length + mid.lost.length, new Set(marked.map((m) => m.osm)).size);
  for (const l of mid.lost) assert.ok(l.reason, `unpainted crossing ${l.osm} says why`);
  for (const [osm, at] of crossings.matched) assert.ok(crossings.crossingAt(at.n).some((c) => c.side === at.side && c.sources.includes(osm)), `crossing ${osm}`);
  // an unsignalled junction gets a crosswalk only on an arm a marked crossing lies on
  for (const n of network.nodes) {
    if (n.signal) continue;
    for (const c of crossings.crossingAt(n)) assert.ok(c.sources.length > 0);
  }
});

test('New York: across() still lays its grid corners when no crossings function is given', () => {
  const n = { signal: true, x: 0, z: 0, hx: 10, hz: 10, road: [{ z0: 0, half: 5 }, { z0: 0, half: 5 }, { x0: 0, half: 5 }, { x0: 0, half: 5 }], in: [], out: [] };
  const grid = createPedestrianRoutes({ walkable: () => true, onSidewalk: () => true }, () => null);
  const tracks = grid.across(n);
  assert.equal(tracks.length, 6, 'two lines across each street side, one across each avenue side');
  assert.deepEqual(tracks.map((t) => t.side), [0, 0, 1, 1, 2, 3]);
  // the same node with a crossings function: only what it gives
  const opt = createPedestrianRoutes({ walkable: () => true, onSidewalk: () => true }, () => null, { crossings: () => [{ a: { x: 0, z: 0 }, b: { x: 10, z: 0 }, side: 4, line: 0 }] });
  assert.deepEqual(opt.across(n).map((t) => [t.side, t.len]), [[4, 10]]);
});

test('walk signals and crosswalk coordinates: centreline junctions by right-of-way group, the grid as before', () => {
  const src = fs.readFileSync(path.join(root, 'js/traffic.js'), 'utf8');
  const m = src.match(/  function walkOn\(side, n = null\) \{[^]*?\n  \}/);
  assert.ok(m);
  const ctx = { stWalk: 'st', aveWalk: 'ave' };
  const walkOn = vm.runInNewContext(`(${m[0].trim()})`, ctx);
  // the grid: sides 2 and 3 (across the avenue) with the street's walk, 0 and 1 with the avenue's, node or not
  for (const n of [null, { general: false }]) assert.deepEqual([0, 1, 2, 3].map((s) => walkOn(s, n)), ['ave', 'ave', 'st', 'st']);
  // a signalled centreline junction: across group 0's road with the street phase, across the rest with the avenue's
  const n = { general: true, signal: true, arms: [{ side: 4, group: 0 }, { side: 5, group: 1 }, { side: 6, group: 0 }] };
  assert.deepEqual([4, 5, 6].map((s) => walkOn(s, n)), ['st', 'ave', 'st']);
  // unsignalled: always (they cross when the traffic can stop)
  assert.equal(walkOn(4, { general: true, signal: false, arms: [] }), true);
  // pedestrian-system.js: p.coord along the road's lateral axis at a centreline junction, x / z on the grid
  const ps = fs.readFileSync(path.join(root, 'js/pedestrian-system.js'), 'utf8');
  assert.match(ps, /const road = p\.node\.general && p\.node\.road \? p\.node\.road\[p\.side\] : null;\n\s+p\.coord = road \? p\.x \* road\.clx \+ p\.z \* road\.clz : p\.side >= 2 \? p\.x : p\.z;/);
});

test('stop signs: every OSM stop on an approach or reported; inferred ones only where OSM has none and no signal', () => {
  const c = stopPlan.counts;
  assert.equal(c.osmMatched + c.osmUnmatched, stops.length);
  for (const u of stopPlan.unmatched) assert.ok(u.reason, `unmatched stop ${u.osm} says why`);
  assert.ok(c.osmMatched >= 45 && c.osmSigns > 100, `${c.osmMatched} of ${stops.length} OSM stops placed, ${c.osmSigns} signs`);
  // each matched OSM stop put a sign (or its approach's stop) on a junction near it
  const osmEdges = [...stopPlan.stopEdges].filter(([, v]) => v.kind === 'osm');
  for (const s of stops) {
    if (stopPlan.unmatched.some((u) => u.osm === s.osm)) continue;
    assert.ok(osmEdges.some(([e, v]) => v.osm === s.osm || Math.hypot(e.to.x - s.x, e.to.z - s.z) < 25), `stop ${s.osm}`);
  }
  // inferred: never at a signalled junction, never at one an OSM stop or give-way is at, never on group 0's road
  const osmNodes = new Set(osmEdges.map(([e]) => e.to));
  for (const [e, v] of stopPlan.stopEdges) {
    assert.ok(!e.to.signal, 'no stop sign at a signal');
    if (v.kind !== 'inferred') continue;
    assert.ok(!osmNodes.has(e.to), 'no inferred stop where OSM has one');
    assert.notEqual(e.axisIndex, 0, 'the main road keeps going');
    // a minor road meeting a higher-class one; never the top-class road itself
    const top = Math.min(...e.to.in.concat(e.to.out).map(classOf));
    assert.ok(classOf(e) > top, 'only a lower-class road stops');
    const major = new Set(e.to.arms.filter((a) => [a.in, a.out].some((x) => x && classOf(x) === top)).map((a) => a.group));
    assert.ok(!major.has(e.axisIndex), 'not on the top-class road');
    for (const g of giveWays) assert.ok(Math.hypot(e.to.x - g.x, e.to.z - g.z) >= 25, 'no inferred stop at an OSM give-way');
  }
  assert.ok(c.inferredSigns > 40 && c.inferredJunctions > 30, `${c.inferredSigns} inferred at ${c.inferredJunctions} junctions`);
  assert.ok(c.skipped.sameClass > 100, 'two roads of one class: no inferred stop');
  // drawn signs stand on a block (the curb), facing their approach's traffic, near its stop line
  for (const g of stopPlan.drawn) {
    assert.ok(blocks.blockAt(g.x, g.z), 'on the curb island');
    assert.ok(g.dx * g.edge.dx + g.dz * g.edge.dz < -0.99, 'facing the arriving traffic');
    const end = { x: g.edge.sx + g.edge.dx * g.edge.len, z: g.edge.sz + g.edge.dz * g.edge.len };
    assert.ok(Math.hypot(g.x - end.x, g.z - end.z) < 14);
  }
  assert.ok(stopPlan.drawn.length > 0.8 * stopPlan.signs.length);
});

test('AI cars come to a full stop at a stop sign, then go by the usual right of way; without stop signs nothing changes', () => {
  const src = fs.readFileSync(path.join(root, 'js/traffic.js'), 'utf8');
  const m = src.match(/  function mayEnter\([^]*?\n  \}/);
  const n = { signal: false, in: [] };
  const exit = { lanes: [0], outSide: 1 };
  const edge = { to: n, axisIndex: 1, occ: [[]], opposite: null, inSide: 0, len: 100 };
  const car = { edge, move: { to: exit, out: [0], turn: 'S' }, lane: 0, s: 80, speed: 8, driver: { b: 3 }, half: 2.25, wait: 0, commit: null, isPolice: false };
  const ctx = { phaseOf: () => 'green', canStopBefore: () => true, stopAt: () => -3, boxBusy: () => false, ahead: () => null, connector: () => ({ len: 20 }),
    yieldToCrossTraffic: () => false, pedestrianOn: () => false, laneCoord: () => 0, timeTo: () => 1, room: () => true, alongside: () => false, mergingAhead: () => null };
  const mayEnter = vm.runInNewContext(`(${m[0].trim()})`, ctx);
  // no stop sign (New York, or a Glens Falls main road): rolling up to a clear junction, it may go
  assert.equal(mayEnter(car, 12), true);
  // a stop sign: not while still moving or short of the line; once stopped at the line, yes, and it remembers that
  edge.stopSign = true;
  assert.equal(mayEnter(car, 12), false, 'moving');
  car.speed = 0.1;
  assert.equal(mayEnter(car, 6), false, 'stopped short of the line');
  assert.equal(mayEnter(car, 1), true, 'stopped at the line');
  assert.equal(car.stoppedAt, edge);
  car.speed = 3;
  assert.equal(mayEnter(car, 0.5), true, 'pulling away after its stop');
  // ...but still gives way when the junction says so
  car.stoppedAt = null; car.speed = 0; ctx.yieldToCrossTraffic = () => true;
  const mayEnter2 = vm.runInNewContext(`(${m[0].trim()})`, ctx);
  assert.equal(mayEnter2(car, 1), false, 'cross traffic first');
  // police do not stop
  const police = { ...car, isPolice: true, speed: 8, stoppedAt: null };
  ctx.yieldToCrossTraffic = () => false;
  assert.equal(vm.runInNewContext(`(${m[0].trim()})`, ctx)(police, 12), true);
  // leave() forgets the stop only when one was made (New York vehicles never get the field)
  assert.match(src, /if \(v\.stoppedAt\) v\.stoppedAt = null;/);
  assert.doesNotMatch(src, /\.stopSign = /, 'traffic.js never sets a stop sign itself');
});

test('street lights: never in the carriageway or the middle of a walk, spaced as documented, glowing only after dusk', () => {
  const plan = placeStreetLights(sidewalks, { osmLamps: GF_FURNITURE.lamps.map(([x, z, osm]) => ({ x, z, osm: String(osm) })) });
  assert.ok(plan.lamps.length > 3000, `${plan.lamps.length} lamps`);
  for (const l of plan.lamps) {
    assert.ok(blocks.blockAt(l.x, l.z), 'on a curb island');
    assert.ok(sidewalks.roadEdge(l.x, l.z) >= 0.2, 'out of the carriageway');
    if (sidewalks.walkAt(l.x, l.z) && l.kind === 'assumed') {
      // on concrete only by the curb (downtown, a paved corner): not at the walk's middle
      const b = sidewalks.bandAt(l.x, l.z);
      if (b) assert.ok(b.curbD < 0.9, `lamp (${l.x}, ${l.z}) ${b.curbD} m from the curb`);
    }
    assert.ok(Math.abs(Math.hypot(l.nx, l.nz) - 1) < 1e-6);
  }
  // spacing along a curb: consecutive assumed lamps of one curb ring are the spacing apart along it, a little more where
  // a driveway, trunk or post pushed one on (SLIDE), less only where a stretch without a road beside it restarted it
  const gaps = [];
  const assumed = plan.lamps.filter((l) => l.kind === 'assumed');
  for (let i = 1; i < assumed.length; i++) {
    const a = assumed[i - 1], b = assumed[i];
    if (a.ring !== b.ring) continue;
    gaps.push((b.s - a.s) / (a.downtown ? SPACING_DOWNTOWN : SPACING_RESIDENTIAL));
  }
  gaps.sort((p, q) => p - q);
  const med = gaps[gaps.length >> 1], short = gaps.filter((g) => g < 0.95).length / gaps.length;
  assert.ok(gaps.length > 2000 && med >= 1 && med < 1.2, `median gap ${med} of the spacing`);
  assert.ok(short < 0.1, `${(short * 100).toFixed(1)}% of gaps shorter than the spacing`);
  assert.equal(OFFSET, 0.55);
  // the glow: the same ramp the lamp material uses (smoothstep of lighting.js interiorGlow), by preset
  const lighting = fs.readFileSync(path.join(root, 'js/lighting.js'), 'utf8');
  const glow = {};
  for (const id of ['golden', 'midday', 'twilight', 'midnight']) {
    const block = lighting.slice(lighting.indexOf(`  ${id}: {`));
    glow[id] = lampGlow(Number(block.match(/interiorGlow: ([0-9.]+)/)[1]));
  }
  assert.equal(glow.golden, 0);
  assert.equal(glow.midday, 0);
  assert.ok(glow.twilight > 0.9 && glow.midnight > 0.9, JSON.stringify(glow));
  const meshes = fs.readFileSync(path.join(root, 'js/gf-street-furniture-meshes.js'), 'utf8');
  assert.match(meshes, /smoothstep\(GLOW_ON\[0\], GLOW_ON\[1\], cityUniforms\.uInteriorGlow\)/, 'the material uses the same ramp');
});

test('New York loads none of it; no city names in the shared modules\' new branches', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  for (const f of ['js/nyc-main.js', 'js/nyc-runtime.js', 'js/city-runtime.js', 'js/street-details.js', 'js/city-grid.js', 'js/traffic.js', 'js/pedestrian-system.js', 'js/pedestrian-routes.js']) {
    assert.doesNotMatch(read(f), /gf-crossings\.js|gf-stop-signs\.js|gf-street-lights\.js|gf-furniture|glensfalls|city\s*===/i, f);
  }
  const main = read('js/main.js');
  const nyc = main.slice(main.indexOf('NYC_PRELOADS'), main.indexOf('];', main.indexOf('NYC_PRELOADS')));
  assert.doesNotMatch(nyc, /gf-/);
  for (const f of ['gf-furniture.js', 'gf-crossings.js', 'gf-stop-signs.js', 'gf-street-lights.js', 'gf-street-furniture-meshes.js']) assert.match(main, new RegExp(`'${f.replace('.', '\\.')}'`));
});
