// CC-005c: exact (unsampled) clearance tests for the trails, their sidewalk connectors and the Thrill Hill party's
// walkers, against water, buildings, tree trunks and props. No three.js: the generator, the game and the tests ask the
// same functions.
//
// A path's surface is the union of capsules (each straight segment swept by a disc of the half width): that union
// contains the drawn ribbon, its round joins and the wedges on the outside of its bends (gf-drape.js), so a capsule
// clear of an obstacle proves every point of the surface there clear, not just sampled lines. An obstacle is a region:
// rings (an outer boundary and its holes, flat [x, z, ...] arrays), so a pond with an island is the water between them.
// A capsule meets a region exactly when the segment comes within r of the region's boundary, or lies inside it.

// The distance from point (px, pz) to segment a-b
function pointSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}
const orient = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
// The distance between segments a-b and c-d (0 where they cross or touch)
function segSegDist(ax, az, bx, bz, cx, cz, dx, dz) {
  const o1 = orient(ax, az, bx, bz, cx, cz), o2 = orient(ax, az, bx, bz, dx, dz);
  const o3 = orient(cx, cz, dx, dz, ax, az), o4 = orient(cx, cz, dx, dz, bx, bz);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
  return Math.min(pointSegDist(ax, az, cx, cz, dx, dz), pointSegDist(bx, bz, cx, cz, dx, dz),
    pointSegDist(cx, cz, ax, az, bx, bz), pointSegDist(dx, dz, ax, az, bx, bz));
}
// Even-odd point in a flat ring
function inRing(ring, x, z) {
  let ins = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1];
    if ((zi > z) !== (zj > z) && x < xi + ((xj - xi) * (z - zi)) / (zj - zi)) ins = !ins;
  }
  return ins;
}

// A region from rings (the first the outer boundary, the rest holes), with its bounding box
function region(rings, meta = {}) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < rings[0].length; i += 2) {
    minX = Math.min(minX, rings[0][i]); maxX = Math.max(maxX, rings[0][i]);
    minZ = Math.min(minZ, rings[0][i + 1]); maxZ = Math.max(maxZ, rings[0][i + 1]);
  }
  return { rings, minX, maxX, minZ, maxZ, ...meta };
}
const inRegion = (g, x, z) => inRing(g.rings[0], x, z) && !g.rings.slice(1).some((h) => inRing(h, x, z));
// The distance from segment a-b to the region's boundary
function boundaryDist(g, ax, az, bx, bz) {
  let best = Infinity;
  for (const ring of g.rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      best = Math.min(best, segSegDist(ax, az, bx, bz, ring[j], ring[j + 1], ring[i], ring[i + 1]));
      if (best === 0) return 0;
    }
  }
  return best;
}
// Does the capsule (segment a-b swept by radius r) meet the region? Exact.
function capsuleHits(g, ax, az, bx, bz, r) {
  if (Math.max(ax, bx) + r < g.minX || Math.min(ax, bx) - r > g.maxX || Math.max(az, bz) + r < g.minZ || Math.min(az, bz) - r > g.maxZ) return false;
  return boundaryDist(g, ax, az, bx, bz) < r || inRegion(g, ax, az);
}
// Does the triangle (inflated by r >= 0) meet the region? Exact: an edge's capsule meets it, or the region lies
// inside the triangle (a pond smaller than the triangle)
function triangleHits(g, t, r = 0) {
  const [ax, az, bx, bz, cx, cz] = t;
  if (Math.max(ax, bx, cx) + r < g.minX || Math.min(ax, bx, cx) - r > g.maxX || Math.max(az, bz, cz) + r < g.minZ || Math.min(az, bz, cz) - r > g.maxZ) return false;
  if (capsuleHits(g, ax, az, bx, bz, r) || capsuleHits(g, bx, bz, cx, cz, r) || capsuleHits(g, cx, cz, ax, az, r)) return true;
  const s = orient(ax, az, bx, bz, cx, cz);
  const inTri = (x, z) => { const a = orient(ax, az, bx, bz, x, z) * s, b = orient(bx, bz, cx, cz, x, z) * s, c = orient(cx, cz, ax, az, x, z) * s; return a >= 0 && b >= 0 && c >= 0; };
  return inTri(g.rings[0][0], g.rings[0][1]);
}
// A trunk collider ({ minX, maxX, minZ, maxZ }, gf-tree-placements.js) as a region
const squareRegion = (t, meta = {}) => region([[t.minX, t.minZ, t.maxX, t.minZ, t.maxX, t.maxZ, t.minX, t.maxZ]], meta);
// A disc (a fire ring, a keg) as an exact obstacle: { disc: [x, z, radius] }
const discRegion = (x, z, radius, meta = {}) => ({ disc: [x, z, radius], minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius, ...meta });

// An index of obstacles (regions and discs) in square cells, asked by capsule
function createClearance(obstacles, cell = 32) {
  const cells = new Map();
  const key = (i, j) => `${i},${j}`;
  for (const o of obstacles) {
    for (let i = Math.floor(o.minX / cell); i <= Math.floor(o.maxX / cell); i++) {
      for (let j = Math.floor(o.minZ / cell); j <= Math.floor(o.maxZ / cell); j++) {
        if (!cells.has(key(i, j))) cells.set(key(i, j), []);
        cells.get(key(i, j)).push(o);
      }
    }
  }
  const near = (minX, maxX, minZ, maxZ) => {
    const out = new Set();
    for (let i = Math.floor(minX / cell); i <= Math.floor(maxX / cell); i++) {
      for (let j = Math.floor(minZ / cell); j <= Math.floor(maxZ / cell); j++) for (const o of cells.get(key(i, j)) || []) out.add(o);
    }
    return out;
  };
  const hitsOne = (o, ax, az, bx, bz, r) => (o.disc ? pointSegDist(o.disc[0], o.disc[1], ax, az, bx, bz) < o.disc[2] + r : capsuleHits(o, ax, az, bx, bz, r));
  return {
    // the first obstacle the capsule meets (filter(o) chooses which count), or null
    capsule(ax, az, bx, bz, r, filter = null) {
      for (const o of near(Math.min(ax, bx) - r, Math.max(ax, bx) + r, Math.min(az, bz) - r, Math.max(az, bz) + r)) {
        if ((!filter || filter(o)) && hitsOne(o, ax, az, bx, bz, r)) return o;
      }
      return null;
    },
    // the first obstacle a triangle (flat [ax, az, bx, bz, cx, cz]) inflated by r meets, or null
    triangle(t, r = 0, filter = null) {
      const xs = [t[0], t[2], t[4]], zs = [t[1], t[3], t[5]];
      for (const o of near(Math.min(...xs) - r, Math.max(...xs) + r, Math.min(...zs) - r, Math.max(...zs) + r)) {
        if (filter && !filter(o)) continue;
        if (o.disc ? [0, 2, 4].some((k) => pointSegDist(o.disc[0], o.disc[1], t[k], t[k + 1], t[(k + 2) % 6], t[(k + 3) % 6]) < o.disc[2] + r) : triangleHits(o, t, r)) return o;
      }
      return null;
    },
    // the clearance (m) from the capsule's centre segment to the nearest obstacle within `reach`, Infinity if none
    distance(ax, az, bx, bz, reach, filter = null) {
      let best = Infinity;
      for (const o of near(Math.min(ax, bx) - reach, Math.max(ax, bx) + reach, Math.min(az, bz) - reach, Math.max(az, bz) + reach)) {
        if (filter && !filter(o)) continue;
        const d = o.disc ? pointSegDist(o.disc[0], o.disc[1], ax, az, bx, bz) - o.disc[2] : (inRegion(o, ax, az) ? 0 : boundaryDist(o, ax, az, bx, bz));
        best = Math.min(best, Math.max(0, d));
      }
      return best;
    },
    count: obstacles.length
  };
}

// The game's obstacles for the trails: mapped water (GF_GEO.water: { outer, holes } flat rings), buildings
// ({ outer, holes } flat rings, or building-collision.js colliders with { x, z } point polygons) and trunk colliders
const flatOf = (ring) => (typeof ring[0] === 'number' ? ring : ring.flatMap((p) => [p.x, p.z]));
const waterRegions = (water) => water.map((w) => region([w.outer, ...(w.holes || [])], { kind: 'water', name: w.name || w.osm }));
const buildingRegions = (buildings) => buildings.map((b) => {
  const p = b.polygon || b;
  return region([flatOf(p.outer), ...(p.holes || []).map(flatOf)], { kind: 'building', name: b.osm || b.id || null });
});
const trunkRegions = (trunks) => trunks.map((t, k) => squareRegion(t, { kind: 'trunk', name: k }));

export { pointSegDist, segSegDist, inRing, region, inRegion, capsuleHits, triangleHits, squareRegion, discRegion, createClearance, waterRegions, buildingRegions, trunkRegions };
