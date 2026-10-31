import { polygonContains } from './building-collision.js';

// Glens Falls blocks for pedestrians (no three.js): GF_GEO.blocks (tools/gf/README.md) as curb islands under a 64 m grid
// index, like city-config.js's BLOCKS. A block's sidewalk is the band between its curb and its lot (the property line
// a sidewalk's width inside it): pedestrians walk there, and the lots are obstacles to them alone, so the car network
// is the same with them as without.

const CELL = 64;
const toPts = (f) => {
  const r = [];
  for (let i = 0; i < f.length; i += 2) r.push({ x: f[i], z: f[i + 1] });
  return r;
};
function bounds(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const { x, z } of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

// blockAt(x, z): the block whose curb (minus its holes) holds (x, z), or null on a roadway, in the water or off the
// blocks; the same object every time. Its `poly` is the curb outline ({ x, z } points, as pedestrian-routes.js reads).
// lotObstacles: each lot (minus its holes) as a pedestrian-only obstacle for buildRoadNetwork (blocks without a lot,
// too narrow for one, have none). onSidewalk(x, z): on a block, outside its lot.
function createGfBlocks(geo) {
  const blocks = geo.blocks.map((b, id) => {
    const poly = toPts(b.curb);
    return {
      id,
      area: b.area,
      ...bounds(poly),
      poly,
      polygon: { outer: poly, holes: b.curbHoles.map(toPts) },
      lot: b.lot ? { outer: toPts(b.lot), holes: b.lotHoles.map(toPts) } : null
    };
  });
  const grid = new Map();
  for (const b of blocks) {
    for (let ix = Math.floor(b.minX / CELL); ix <= Math.floor(b.maxX / CELL); ix++) {
      for (let iz = Math.floor(b.minZ / CELL); iz <= Math.floor(b.maxZ / CELL); iz++) {
        const k = ix * 100000 + iz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(b);
      }
    }
  }
  function blockAt(x, z) {
    for (const b of grid.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (polygonContains(b.polygon, x, z)) return b;
    }
    return null;
  }
  const lotObstacles = blocks.filter((b) => b.lot).map((b) => ({ ...bounds(b.lot.outer), polygon: b.lot, pedestrianOnly: true }));
  function onSidewalk(x, z) {
    const b = blockAt(x, z);
    return !!b && !(b.lot && polygonContains(b.lot, x, z));
  }
  return { blocks, blockAt, lotObstacles, onSidewalk };
}

export { createGfBlocks };
