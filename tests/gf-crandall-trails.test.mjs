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
import { createTrailNetwork, createTrailRoutes, trailGroundAt, TRAIL_LIFT, TRAIL_MOD, TRAIL_REM, ATTACH_REACH } from '../js/gf-trail-network.js';
import { planThrillHillParty, createPartySchedule, isNight, THRILL_HILL_SCENE, NIGHT_GLOW, ATTENDEES, FIRE_CLEAR, FIRE_RING } from '../js/gf-thrill-hill-plan.js';
import { buildTrails, moduleText, segSquareDist, BODY } from '../tools/gf/build-gf-crandall-trails.mjs';
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

test('paths and footbridges: walking lanes clear of buildings, water (off a deck) and every kept tree trunk', () => {
  const trunks = treesKept.trunks;
  const cells = new Map();
  for (const t of trunks) { const k = `${Math.floor(t.minX / 20)},${Math.floor(t.minZ / 20)}`; (cells.get(k) || cells.set(k, []).get(k)).push(t); }
  const nearTrunk = (x, z, r) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const t of cells.get(`${Math.floor(x / 20) + i},${Math.floor(z / 20) + j}`) || []) {
      if (x > t.minX - r && x < t.maxX + r && z > t.minZ - r && z < t.maxZ + r) return true;
    }
    return false;
  };
  let samples = 0, onDeck = 0;
  for (const [k, pair] of net.lanes.entries()) {
    const e = net.edges[k];
    if (e.kind === 'drive') continue; // the game's own service roads (gf-geodata.js), drawn as they were
    for (const lane of pair) for (const tr of lane.tracks) {
      for (let s = 0; s <= tr.len; s += 0.5) {
        const x = tr.ax + tr.ux * s, z = tr.az + tr.uz * s;
        samples++;
        assert.ok(!inBuilding(x, z), `${e.id} lane in a building at (${x}, ${z})`);
        assert.ok(!nearTrunk(x, z, 0.35), `${e.id} lane through a tree trunk at (${x}, ${z})`);
        const deck = surface.footDeckAt(x, z), w = surface.water.surfaceAt(x, z);
        if (deck) onDeck++;
        if (w !== null && !deck) assert.ok(surface.ground(x, z) >= w - 0.05, `${e.id} lane in water at (${x}, ${z})`);
        if (deck && w !== null) assert.ok(deck.y >= w, `${e.id}: the footbridge deck above the water`);
      }
    }
  }
  assert.ok(samples > 7000 && onDeck > 100, `${samples} samples, ${onDeck} on footbridge decks`);
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
  assert.equal(treesAll.sites.length - treesKept.sites.length, excluded.size);
  assert.ok(excluded.size === 70, `${excluded.size} trees cleared`);
  for (const row of GF_TRAILS.treeExclusions.trees) assert.ok(GF_TRAILS.edges.some((e) => e.id === row[5]), `tree ${row[0]} names its path`);
});

test('entrances: each component reaches a sidewalk; connectors stay on their side of the street and out of buildings', () => {
  const routes = createTrailRoutes(base(), network, net, { random: seeded(1) });
  const walkable = routes.walkable;
  assert.equal(walkable.length, 6, 'all but Angel Lane (no sidewalks in the game\'s network there)');
  assert.ok(!walkable.some((en) => en.street === 'Angel Lane'));
  for (let c = 0; c < net.components; c++) assert.ok(walkable.some((en) => en.component === c), `component ${c} has a walkers' entrance`);
  for (const en of walkable) {
    const at = routes.attach.get(en), n = net.node(en.node);
    assert.ok(at.d <= ATTACH_REACH, `${en.street}: ${at.d} m`);
    assert.ok(routes.splitCount(en) >= 1, `${en.street}: a sidewalk split`);
    for (let i = 0; i <= 20; i++) assert.ok(!inBuilding(at.x + (n.x - at.x) * i / 20, at.z + (n.z - at.z) * i / 20), `${en.street} connector`);
    // never across a street: every point of the connector at least 1 m from every street's centre line
    for (let i = 0; i <= 20; i++) {
      const x = at.x + (n.x - at.x) * i / 20, z = at.z + (n.z - at.z) * i / 20;
      for (const e of network.edges) assert.ok(segDist(x, z, e.sx, e.sz, e.sx + e.dx * e.len, e.sz + e.dz * e.len) >= 1, `${en.street} connector crosses a street`);
    }
  }
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
  // every way in runs on the trail lanes, then off to its place
  for (const [k, p] of plan.paths.entries()) {
    assert.ok(p.length >= 45);
    const last = p.pts[p.pts.length - 1];
    assert.equal(last.x, slots[k].x);
    for (const q of p.pts.slice(0, -1)) assert.ok(trailGap(q.x, q.z) < 0.1, 'the way in follows the path');
  }
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
  for (const s of ['buildTrailMeshes(scene, GF_TRAILS, GF_SURFACE)', 'exclude: new Set(GF_TRAILS.treeExclusions.trees.map((t) => t[0]))', 'createTrailRoutes(base, network, TRAIL_NET)',
    'trailGroundAt(GF_SURFACE)', 'party.setTime(cityUniforms.uInteriorGlow.value', '...trailMeshes.colliders', "get('party') === 'off'"]) assert.ok(main.includes(s), s);
  const preloads = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');
  for (const f of ['gf-trails.js', 'gf-trail-network.js', 'gf-trail-meshes.js', 'gf-thrill-hill-plan.js', 'gf-thrill-hill.js']) assert.ok(preloads.includes(`'${f}'`), f);
  assert.ok(net.edges.length === GF_TRAILS.edges.length && TRAIL_MOD === 10 && TRAIL_REM === 3);
});
