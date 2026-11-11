import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeTerrain, createGfTerrain } from '../js/gf-terrain.js';
import { createGfSurface } from '../js/gf-surface.js';
import { buildRoadNetwork } from '../js/road-network.js';
import { createPedestrianRoutes } from '../js/pedestrian-routes.js';
import { gfRoadSource } from '../js/gf-roadgraph.js';
import { createGfBlocks } from '../js/gf-blocks.js';
import { gfBuildingsOnTerrain } from '../js/gf-building-bases.js';
import { applyLidarHeights } from '../js/gf-building-heights.js';
import { placeGfTrees, TRUNK } from '../js/gf-tree-placements.js';
import { GF_GEO } from '../js/gf-geodata.js';
import { GF_BRIDGES } from '../js/gf-bridges.js';
import { GF_BUILDINGS } from '../js/gf-buildings.js';
import { GF_LANDMARKS } from '../js/gf-landmarks.js';
import { GF_LIDAR_HEIGHTS } from '../js/gf-lidar-heights.js';
import { GF_SIGNALS } from '../js/gf-signals.js';
import { GF_TREES } from '../js/gf-trees.js';
import { GF_TRAILS } from '../js/gf-trails.js';
import { createTrailNetwork, createTrailRoutes, ATTACH_REACH, CONNECTOR_BODY } from '../js/gf-trail-network.js';
import { createClearance, waterRegions, buildingRegions, trunkRegions } from '../js/gf-trail-clearance.js';
import { createGfSidewalks } from '../js/gf-sidewalks.js';
import { keepTreesOffWalk } from '../js/gf-tree-walk.js';

// CC-005f: no LiDAR tree trunk stands in the concrete walk (gf-tree-walk.js): moved to the tree lawn or into the lot,
// or dropped; each moved tree keeps its measured position

const root = fileURLToPath(new URL('..', import.meta.url));
const quiet = (fn) => { const info = console.info; console.info = () => {}; try { return fn(); } finally { console.info = info; } };
const terrain = createGfTerrain(decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(root, 'js/gf-terrain.bin.gz'))))), GF_GEO.frame);
const surface = createGfSurface({ terrain, geo: GF_GEO, bridges: GF_BRIDGES, footDecks: GF_TRAILS.footDecks });
const blocks = createGfBlocks(GF_GEO);
const sidewalks = createGfSidewalks({ geo: GF_GEO, blocks, ground: surface.ground });
const exclude = new Set(GF_TRAILS.treeExclusions.trees.map((t) => t[0]));
// as gf-main.js does
const base = placeGfTrees(GF_TREES, { buildings: GF_BUILDINGS, geo: GF_GEO, ground: surface.ground, exclude });
const plan = keepTreesOffWalk(base, { trees: GF_TREES, sidewalks, buildings: GF_BUILDINGS, water: GF_GEO.water, trails: GF_TRAILS, ground: surface.ground });
const ow = plan.offWalk;
const half = (index) => Math.max(TRUNK.minHalf, TRUNK.halfPerM * GF_TREES.trees[index * 4 + 2]);

test('no trunk centre in the concrete; every tree that stood there moved to the lawn or the lot, or was dropped', () => {
  const before = base.sites.filter((s) => sidewalks.walkAt(s.x, s.z));
  assert.ok(before.length > 1000, `${before.length} trunks on the walk before`);
  assert.equal(plan.sites.filter((s) => sidewalks.walkAt(s.x, s.z)).length, 0, 'trunks on the walk after');
  // the counts add up: every site stayed, moved or was dropped; nothing added
  assert.equal(ow.stayed + ow.lawn + ow.lot + ow.dropped, base.sites.length);
  assert.equal(ow.lawn + ow.lot + ow.dropped, before.length);
  assert.equal(plan.sites.length, base.sites.length - ow.dropped);
  assert.equal(plan.trunks.length, plan.sites.length);
  assert.equal(plan.skipped.walk, ow.dropped);
  assert.ok(ow.lawn > 300 && ow.lot > 300, `${ow.lawn} to the lawn, ${ow.lot} into the lot`);
  assert.ok(ow.dropped < 0.05 * before.length, `${ow.dropped} dropped`);
  assert.equal(new Set(plan.sites.map((s) => s.index)).size, plan.sites.length, 'one site per tree');
  assert.equal(plan.speciesCounts.reduce((a, b) => a + b, 0), plan.sites.length);
  // the trees that were not on the walk are exactly as placeGfTrees put them
  const byIndex = new Map(plan.sites.map((s) => [s.index, s]));
  for (const s of base.sites) if (!sidewalks.walkAt(s.x, s.z)) assert.equal(byIndex.get(s.index), s);
});

test('where they went: a lawn tree on its lawn, a lot tree in its lot beyond the ramp, both clear; trunks follow', () => {
  const byIndex = new Map(plan.sites.map((s, k) => [s.index, [s, plan.trunks[k]]]));
  const S = sidewalks.constants;
  for (const m of ow.moves) {
    const [s, trunk] = byIndex.get(m.index);
    assert.deepEqual([s.x, s.z], m.to);
    const b = sidewalks.bandAt(s.x, s.z);
    assert.ok(b && b.block === blocks.blockAt(m.from[0], m.from[1]), `tree ${m.index} on its own block`);
    if (m.where === 'lawn') {
      assert.ok(!b.inLot && b.lawn && !sidewalks.walkAt(s.x, s.z), `tree ${m.index} on a lawn`);
      assert.ok(b.curbD >= S.curbW + half(m.index) - 1e-6, `tree ${m.index} clear of the curb`);
    } else {
      assert.equal(m.where, 'lot');
      assert.ok(b.inLot && b.lotD >= S.ramp + half(m.index), `tree ${m.index} in its lot beyond the ramp (${b.lotD})`);
    }
    assert.ok(sidewalks.roadEdge(s.x, s.z) >= half(m.index), `tree ${m.index} out of the carriageway`);
    assert.equal(surface.water.surfaceAt(s.x, s.z), null, `tree ${m.index} out of the water`);
    // the trunk collider moved with it, the same size, on the ground there
    assert.ok(Math.abs((trunk.minX + trunk.maxX) / 2 - s.x) < 1e-9 && Math.abs((trunk.minZ + trunk.maxZ) / 2 - s.z) < 1e-9);
    assert.ok(Math.abs((trunk.maxX - trunk.minX) / 2 - half(m.index)) < 1e-9);
    assert.ok(Math.abs(s.y - surface.ground(s.x, s.z)) < 1e-9 && trunk.minY === s.y);
    // moved straight across the band: a few metres at most
    assert.ok(Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1]) < 6);
  }
  // no moved trunk in a trail corridor (CC-005c's cleared trees stay cleared, none moved onto a path)
  for (const m of ow.moves) assert.ok(!exclude.has(m.index));
  for (const e of GF_TRAILS.edges) {
    for (const m of ow.moves) {
      for (let k = 0; k + 3 < e.pts.length; k += 2) {
        const [x, z] = m.to, ax = e.pts[k], az = e.pts[k + 1], dx = e.pts[k + 2] - ax, dz = e.pts[k + 3] - az, l2 = dx * dx + dz * dz;
        const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
        assert.ok(Math.hypot(x - ax - dx * t, z - az - dz * t) >= e.widthM / 2 + half(m.index) - 1e-6, `tree ${m.index} in trail ${e.id}`);
      }
    }
  }
});

test('LiDAR provenance: a moved tree points at its measured canopy top; the inventory is untouched', () => {
  const byIndex = new Map(plan.sites.map((s) => [s.index, s]));
  assert.ok(ow.moves.length > 600);
  for (const m of ow.moves) {
    const s = byIndex.get(m.index);
    // the measured top in gf-trees.js, the move's from, the site's lidar: one point
    assert.deepEqual([GF_TREES.trees[m.index * 4], GF_TREES.trees[m.index * 4 + 1]], m.from);
    assert.deepEqual([s.lidar.x, s.lidar.z], m.from);
    assert.equal(s.moved, m.where);
    // the tree itself unchanged: height (scale), spread, shape, tier
    const b = base.sites.find((q) => q.index === m.index);
    for (const k of ['scale', 'species', 'sx', 'sz', 'tier']) assert.equal(s[k], b[k], `${k} of tree ${m.index}`);
  }
  for (const d of ow.drops) {
    assert.deepEqual([GF_TREES.trees[d.index * 4], GF_TREES.trees[d.index * 4 + 1]], d.at);
    assert.ok(!byIndex.has(d.index) && d.reason.length > 0);
  }
  // fixtures: trees that stood on a walk, each moved or dropped as recorded
  const fixtures = [ow.moves.find((m) => m.where === 'lawn'), ow.moves.find((m) => m.where === 'lot'), ow.drops[0]];
  for (const f of fixtures) {
    const at = f.from || f.at;
    assert.equal(sidewalks.walkAt(...at), true, `tree ${f.index} stood on the walk`);
  }
  // keepTreesOffWalk leaves its input alone and gives the same answer every time
  const again = keepTreesOffWalk(base, { trees: GF_TREES, sidewalks, buildings: GF_BUILDINGS, water: GF_GEO.water, trails: GF_TRAILS, ground: surface.ground });
  assert.deepEqual(again.offWalk, ow);
  assert.ok(base.sites.every((s) => !s.lidar && !s.moved));
});

test('the six trail entrances still reach a sidewalk with the moved trunks; pedestrians unaffected', () => {
  const { colliders, obstacles } = gfBuildingsOnTerrain(applyLidarHeights(GF_BUILDINGS, GF_LIDAR_HEIGHTS).data, GF_LANDMARKS, surface.ground);
  const network = quiet(() => buildRoadNetwork([], [...blocks.lotObstacles, ...obstacles], GF_SIGNALS.junctions.map(([x, z]) => ({ x, z })), gfRoadSource(GF_GEO)));
  const routes = () => createPedestrianRoutes({ walkable: network.walkable, onSidewalk: sidewalks.onWalk }, blocks.blockAt, { insets: sidewalks.insetsFor });
  const net = createTrailNetwork(GF_TRAILS);
  const clearance = createClearance([...waterRegions(GF_GEO.water), ...buildingRegions(colliders), ...trunkRegions(plan.trunks)]);
  const trail = createTrailRoutes(routes(), network, net, { clearance });
  assert.equal(trail.walkable.length, 6);
  for (const en of trail.walkable) {
    const at = trail.attach.get(en), nd = net.node(en.node);
    assert.ok(at.d <= ATTACH_REACH && trail.splitCount(en) >= 1, en.street);
    assert.equal(clearance.capsule(at.x, at.z, nd.x, nd.z, CONNECTOR_BODY), null, `${en.street} connector`);
  }
});
