import { TRUNK } from './gf-tree-placements.js';

// CC-005f: keep the LiDAR trees' trunks off the concrete walks (no three.js; gf-main.js runs it on placeGfTrees's
// plan). gf-tree-placements.js puts each trunk under its measured canopy top (USGS 3DEP 2022-23, gf-trees.js), so a
// crown over a walk had its trunk standing in the concrete (about 1,470 trees in CC-005e). Dave's preview of CC-005e
// (2026-11-11): trees must not stand in the middle of the sidewalk. A placement rule, not a new survey: no tree is
// added, none of gf-trees.js changes, and every tree keeps its own height, spread and shape. A site whose trunk centre is
// on the drawn concrete (gf-sidewalks.js walkAt: the walk, a paved corner or a junction's apron) is moved straight
// across the band, along the lot line's normal:
//   to the tree lawn's middle, where there is a lawn there and it is at least the trunk's width plus LAWN_CLEAR, and
//   the spot is clear (below);
//   else into the lot, LOT_DEPTH beyond the ramp (gf-sidewalks.js RAMP) plus the trunk's half width, where that is
//   still the same lot and clear;
//   else the tree is dropped and counted.
// Clear: not on the walk, on the same block, not in water, no carriageway within the trunk's half width, not in a
// building footprint or a trail corridor (gf-trails.js edges, their widths; the trees CC-005c cleared stay cleared).
// Each moved site keeps where it was measured (lidar: { x, z }) and how it moved (moved: 'lawn' | 'lot'); the plan's
// offWalk lists every move and drop with the tree's index.

const LAWN_CLEAR = 0.1; // m: the lawn at least the trunk's width plus this
const LOT_DEPTH = 0.3; // m beyond the ramp and the trunk's half width

const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
};
function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[i], az = ring[i + 1], bx = ring[j], bz = ring[j + 1];
    if ((az > z) !== (bz > z) && x < ax + ((bx - ax) * (z - az)) / (bz - az)) inside = !inside;
  }
  return inside;
}
// items with flat rings (outer, holes) under a grid; the ones whose bounds hold a point
function ringIndex(items, cell) {
  const cells = new Map();
  for (const it of items) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < it.outer.length; i += 2) {
      minX = Math.min(minX, it.outer[i]); maxX = Math.max(maxX, it.outer[i]);
      minZ = Math.min(minZ, it.outer[i + 1]); maxZ = Math.max(maxZ, it.outer[i + 1]);
    }
    Object.assign(it, { minX, maxX, minZ, maxZ });
    for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx++) {
      for (let gz = Math.floor(minZ / cell); gz <= Math.floor(maxZ / cell); gz++) {
        const k = gx * 100003 + gz;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(it);
      }
    }
  }
  return (x, z) => (cells.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) || [])
    .filter((it) => x >= it.minX && x <= it.maxX && z >= it.minZ && z <= it.maxZ && inRing(it.outer, x, z) && !it.holes.some((h) => inRing(h, x, z)));
}

// plan: placeGfTrees's result. trees: GF_TREES. sidewalks: gf-sidewalks.js createGfSidewalks. buildings: GF_BUILDINGS.
// water: GF_GEO.water. trails: GF_TRAILS (or null). ground(x, z): the sites' ground (as placeGfTrees was given).
// Returns the plan with its sites and trunks moved or dropped, skipped.walk (the dropped) and offWalk.
function keepTreesOffWalk(plan, { trees, sidewalks, buildings, water, trails = null, ground = null }) {
  const S = sidewalks.constants;
  const bAt = Object.fromEntries(buildings.fields.map((f, i) => [f, i]));
  const buildingAt = ringIndex(buildings.buildings.map((row) => ({ outer: row[bAt.outer], holes: row[bAt.holes] || [] })), 64);
  const waterAt = ringIndex(water.map((w) => ({ outer: w.outer, holes: w.holes || [] })), 256);
  const corridors = trails ? trails.edges.map((e) => ({ pts: e.pts, half: e.widthM / 2 })) : [];
  const inCorridor = (x, z, r) => corridors.some((c) => {
    for (let k = 0; k + 3 < c.pts.length; k += 2) if (segDist(x, z, c.pts[k], c.pts[k + 1], c.pts[k + 2], c.pts[k + 3]) < c.half + r) return true;
    return false;
  });
  // why a trunk of half width `half` cannot stand at (x, z) on `block`, or null
  const why = (x, z, half, block) => {
    if (sidewalks.walkAt(x, z)) return 'walk';
    const b = sidewalks.bandAt(x, z);
    if (!b || b.block !== block) return 'block';
    if (waterAt(x, z).length) return 'water';
    if (sidewalks.roadEdge(x, z) < half) return 'road';
    for (const [dx, dz] of [[0, 0], [-half, -half], [half, -half], [half, half], [-half, half]]) if (buildingAt(x + dx, z + dz).length) return 'building';
    if (inCorridor(x, z, half)) return 'trail';
    return null;
  };

  const sites = [], trunks = [], moves = [], drops = [];
  const counts = { stayed: 0, lawn: 0, lot: 0, dropped: 0 };
  const speciesCounts = plan.speciesCounts.map(() => 0);
  plan.sites.forEach((site, k) => {
    if (!sidewalks.walkAt(site.x, site.z)) {
      sites.push(site);
      trunks.push(plan.trunks[k]);
      speciesCounts[site.species]++;
      counts.stayed++;
      return;
    }
    const h = trees.trees[site.index * 4 + 2];
    const half = Math.max(TRUNK.minHalf, TRUNK.halfPerM * h);
    const b = sidewalks.bandAt(site.x, site.z);
    let to = null, where = null, reason = 'no band';
    if (b) {
      const at = (d) => ({ x: b.q.x + b.n.x * d, z: b.q.z + b.n.z * d });
      // the lawn's middle, across from the lot line
      if (b.lawn && b.lawnOut - b.walkOut >= 2 * half + LAWN_CLEAR) {
        const p = at((b.walkOut + b.lawnOut) / 2);
        const c = sidewalks.bandAt(p.x, p.z);
        reason = why(p.x, p.z, half, b.block) || (c && c.curbD < S.curbW + half ? 'curb' : null);
        if (!reason) { to = p; where = 'lawn'; }
      } else reason = b.lawn ? 'lawn too narrow' : 'no lawn';
      // else into the lot, beyond the ramp
      if (!to) {
        const depth = S.ramp + half + LOT_DEPTH;
        const p = at(-depth);
        const c = sidewalks.bandAt(p.x, p.z);
        const r = !c || !c.inLot || c.lotD < depth - 0.05 ? 'lot too shallow' : why(p.x, p.z, half, b.block);
        if (!r) { to = p; where = 'lot'; } else reason = `${reason}; lot: ${r}`;
      }
    }
    if (!to) {
      drops.push({ index: site.index, at: [site.x, site.z], reason });
      counts.dropped++;
      return;
    }
    const x = +to.x.toFixed(2), z = +to.z.toFixed(2);
    const y = ground ? ground(x, z) : site.y;
    sites.push({ ...site, x, y, z, lidar: { x: site.x, z: site.z }, moved: where });
    const outer = [{ x: x - half, z: z - half }, { x: x + half, z: z - half }, { x: x + half, z: z + half }, { x: x - half, z: z + half }];
    trunks.push({ minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half, minY: y, maxY: y + Math.min(TRUNK.maxTop, TRUNK.topPerM * h), polygon: { outer, holes: [] } });
    speciesCounts[site.species]++;
    moves.push({ index: site.index, from: [site.x, site.z], to: [x, z], where });
    counts[where]++;
  });
  return { ...plan, sites, trunks, speciesCounts, skipped: { ...plan.skipped, walk: counts.dropped }, offWalk: { ...counts, moves, drops } };
}

export { keepTreesOffWalk, LAWN_CLEAR, LOT_DEPTH };
