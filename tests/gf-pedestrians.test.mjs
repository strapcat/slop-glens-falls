import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildRoadNetwork } from '../js/road-network.js';
import { createPedestrianRoutes } from '../js/pedestrian-routes.js';
import { gfRoadSource, driveLinks } from '../js/gf-roadgraph.js';
import { createGfBlocks } from '../js/gf-blocks.js';
import { GF_GEO } from '../js/gf-geodata.js';

// Glens Falls pedestrians: the blocks (js/gf-blocks.js) they walk around, and the sidewalk tracks pedestrian-routes.js
// lays along the road network's edges

const quiet = (fn) => {
  const info = console.info;
  console.info = () => {};
  try {
    return fn();
  } finally {
    console.info = info;
  }
};
const edgeHash = (net) => createHash('sha256')
  .update(JSON.stringify(net.edges.map((e) => [e.from.id, e.to.id, e.sx, e.sz, e.len, e.lanes, e.moves.map((m) => [m.to.id, m.out])])))
  .digest('hex');

const blocks = createGfBlocks(GF_GEO);
const network = quiet(() => buildRoadNetwork([], blocks.lotObstacles, [], gfRoadSource(GF_GEO)));

// Every edge's sidewalk tracks, with Glens Falls's walking lines (gf-main.js: 0.6 and 1.2 m beyond the roadway, in its
// 1.8 m sidewalk band)
const INSETS = [0.6, 1.2];
function tracks(gfBlocks, net) {
  const routes = createPedestrianRoutes({ walkable: net.walkable, onSidewalk: gfBlocks.onSidewalk }, gfBlocks.blockAt, { insets: INSETS });
  return net.edges.map((e) => routes.along(e));
}

test('blockAt: the block around a point on its curb island, null on a roadway or in its holes', () => {
  // a block's centroid-ish inner point: the first lot vertex nudged towards the lot's middle stays inside the curb
  let checked = 0;
  for (const b of blocks.blocks.filter((bb) => bb.lot).slice(0, 50)) {
    const [p] = b.lot.outer;
    const cx = b.lot.outer.reduce((t, q) => t + q.x, 0) / b.lot.outer.length;
    const cz = b.lot.outer.reduce((t, q) => t + q.z, 0) / b.lot.outer.length;
    const x = p.x + (cx - p.x) * 0.02, z = p.z + (cz - p.z) * 0.02;
    if (blocks.blockAt(x, z) !== b) continue;
    assert.equal(blocks.blockAt(x, z), b, 'the same block object every time');
    checked++;
  }
  assert.ok(checked > 40, `${checked} blocks found from inside`);
  // the streets the blocks were cut around are roadway: every drive link's segment midpoints
  for (const l of driveLinks(GF_GEO)) {
    for (let k = 0; k + 1 < l.pts.length; k++) {
      const x = (l.pts[k][0] + l.pts[k + 1][0]) / 2, z = (l.pts[k][1] + l.pts[k + 1][1]) / 2;
      assert.equal(blocks.blockAt(x, z), null, `${l.name} at (${x}, ${z})`);
    }
  }
  // a pond inside a block (a curb hole) is no block
  const withHole = blocks.blocks.find((b) => b.polygon.holes.length);
  const hole = withHole.polygon.holes[0];
  const hx = hole.reduce((t, q) => t + q.x, 0) / hole.length, hz = hole.reduce((t, q) => t + q.z, 0) / hole.length;
  assert.equal(blocks.blockAt(hx, hz), null);
  // the sidewalk is the band between curb and lot
  assert.equal(blocks.onSidewalk(hx, hz), false);
});

test('the lots, obstacles to pedestrians only, leave the car network unchanged', () => {
  const without = quiet(() => buildRoadNetwork([], [], [], gfRoadSource(GF_GEO)));
  assert.equal(edgeHash(network), edgeHash(without));
  assert.ok(blocks.lotObstacles.length >= 360 && blocks.lotObstacles.every((o) => o.pedestrianOnly && o.polygon.outer.length >= 3));
});

// A walking line's point on its own block: inside its curb, or (CC-ROADS: the curb rings are snapped onto the roadway's
// offset, so a detour's straight leg can graze a curved curb) within 1 cm of it
function onOwnBlock(blocksOf, x, z, block) {
  if (blocksOf.blockAt(x, z) === block) return true;
  for (const ring of [block.polygon.outer, ...block.polygon.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
      if (Math.hypot(x - a.x - dx * t, z - a.z - dz * t) <= 0.01) return true;
    }
  }
  return false;
}

test('sidewalk tracks: over 2000 edges have one, each track stays on its own block', () => {
  const all = tracks(blocks, network);
  const withTracks = all.filter((t) => t.length).length;
  assert.ok(withTracks > 2000, `${withTracks} edges with tracks`);
  let n = 0;
  for (const list of all) {
    for (const t of list) {
      for (const f of [0, 0.5, 1]) {
        const x = t.ax + t.ux * t.len * f, z = t.az + t.uz * t.len * f;
        assert.ok(onOwnBlock(blocks, x, z, t.block), `track off its block at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
      n++;
    }
  }
  assert.ok(n > 4000, `${n} tracks`);
});

test('blocks, network and tracks build the same every time', () => {
  const again = createGfBlocks(GF_GEO);
  const net2 = quiet(() => buildRoadNetwork([], again.lotObstacles, [], gfRoadSource(GF_GEO)));
  assert.equal(edgeHash(net2), edgeHash(network));
  const flatTracks = (all) => JSON.stringify(all.map((list) => list.map((t) => [t.block.id, t.ax, t.az, t.ux, t.uz, t.len])));
  assert.equal(flatTracks(tracks(again, net2)), flatTracks(tracks(blocks, network)));
});
