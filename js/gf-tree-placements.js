// Glens Falls trees as renderer sites (no three.js, so Node tests use it as the game does): the usable LiDAR canopy
// tops of GF_TREES (js/gf-trees.js) turned into createTreeField sites (js/trees.js) and small trunk colliders for the
// player. Every site is a measured top, where it was measured: this module only skips (never moves or adds) a tree
// whose trunk would stand in water, in a carriageway or inside a building footprint, as a safety net.

// The renderer's tree models (js/trees.js buildTreeGeometries, LOD 0, variant 0, scale 1), measured once from their
// bounding boxes in the browser: H the height of the top above the ground, R the crown half-width (the mean of the X
// and Z half-extents). Sites are scaled so a drawn tree is about as tall (h) and wide (r) as the LiDAR measured.
const TREE_MODELS = [
  { name: 'plane', H: 12.61, R: 5.0 }, // species 0
  { name: 'locust', H: 9.88, R: 4.79 }, // species 1
  { name: 'elm', H: 13.5, R: 5.57 } // species 2
];
// The species slot is a visual shape mix, not a surveyed species: LiDAR gives no species. Seeded from the position,
// so the same tree gets the same shape on every load. Shares of the shapes, in order: elm, plane, locust.
const SPECIES_MIX = [[2, 0.4], [0, 0.35], [1, 0.25]];
const SPREAD = [0.6, 1.6]; // clamp of the crown stretch (sx = sz) against the model's own spread
// createTreeField draw-distance tier (MAX_DIST 3000 / 1600 / 950 m): 2, 950 m, for every tree. Tier 1 (1,600 m) nearly
// doubled the frame time over the town from 300 m up (headless: 1.47 -> 2.85 s, 108 -> 929 draw calls); tier 2 for the
// trees under 12 m alone gained little (2.62 s); tier 2 for all brings it to 1.87 s (487 draw calls). No tree is dropped.
const TIER = 2;
const TRUNK = { minHalf: 0.25, halfPerM: 0.03, maxTop: 4, topPerM: 0.35 }; // player trunk collider: half-side, top

// A position hash in [0, 1), the same on every load (the sin-fract hash js/trees.js uses, with its own constants)
function hash01(x, z) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function speciesAt(x, z) {
  const u = hash01(x, z);
  let acc = 0;
  for (const [s, share] of SPECIES_MIX) {
    acc += share;
    if (u < acc) return s;
  }
  return SPECIES_MIX[SPECIES_MIX.length - 1][0];
}

// Ray-cast point-in-polygon on a flat [x0, z0, x1, z1, ...] ring
function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[i], az = ring[i + 1], bx = ring[j], bz = ring[j + 1];
    if ((az > z) !== (bz > z) && x < ax + ((bx - ax) * (z - az)) / (bz - az)) inside = !inside;
  }
  return inside;
}
const inPolygon = (outer, holes, x, z) => inRing(outer, x, z) && !holes.some((h) => inRing(h, x, z));
const boundsOf = (ring) => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
    minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]);
  }
  return { minX, maxX, minZ, maxZ };
};

// A grid of items by their bounds (cell metres), and the items whose bounds hold a point
function gridIndex(items, cell) {
  const cells = new Map();
  items.forEach((it, idx) => {
    for (let gx = Math.floor(it.minX / cell); gx <= Math.floor(it.maxX / cell); gx++) {
      for (let gz = Math.floor(it.minZ / cell); gz <= Math.floor(it.maxZ / cell); gz++) {
        const k = gx * 100003 + gz;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(idx);
      }
    }
  });
  return (x, z) => (cells.get(Math.floor(x / cell) * 100003 + Math.floor(z / cell)) || []).map((i) => items[i]);
}

// The carriageways: every road-graph link's centreline segments, with half its curb width
function roadSegments(geo) {
  const { nodes, links, linkFields } = geo.roadGraph;
  const at = Object.fromEntries(linkFields.map((f, i) => [f, i]));
  const segs = [];
  for (const l of links) {
    const pts = [[nodes[l[at.a] * 2], nodes[l[at.a] * 2 + 1]]];
    const inner = l[at.pts] || [];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push([nodes[l[at.b] * 2], nodes[l[at.b] * 2 + 1]]);
    const half = l[at.width] / 2;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      segs.push({ ax, az, bx, bz, half, minX: Math.min(ax, bx) - half, maxX: Math.max(ax, bx) + half, minZ: Math.min(az, bz) - half, maxZ: Math.max(az, bz) + half });
    }
  }
  return segs;
}
function segmentDistance(s, x, z) {
  const ex = s.bx - s.ax, ez = s.bz - s.az;
  const len2 = ex * ex + ez * ez;
  const u = len2 ? Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / len2)) : 0;
  return Math.hypot(s.ax + ex * u - x, s.az + ez * u - z);
}

// { sites, trunks, skipped: { water, road, building }, speciesCounts } of GF_TREES, against GF_BUILDINGS footprints
// and GF_GEO's water and roads. CC-005b: with ground(x, z) (gf-surface.js, the bare earth), each tree stands on the
// ground at its top's x, z (site y) and its trunk collider rises from there; nothing else about it changes (x, z,
// height, spread, shape, the skips), and its height stays its height above that ground. CC-005c: exclude (a Set of
// tree indices, js/gf-trails.js treeExclusions) skips the trees whose trunks stand in an accepted trail's corridor,
// counted apart (skipped.trail); without it nothing changes. Each site carries its tree's index.
function placeGfTrees(trees, { buildings, geo, ground = null, exclude = null }) {
  const bAt = Object.fromEntries(buildings.fields.map((f, i) => [f, i]));
  const footprints = buildings.buildings.map((row) => ({ outer: row[bAt.outer], holes: row[bAt.holes], ...boundsOf(row[bAt.outer]) }));
  const buildingsNear = gridIndex(footprints, 64);
  const water = geo.water.map((w) => ({ outer: w.outer, holes: w.holes || [], ...boundsOf(w.outer) }));
  const waterNear = gridIndex(water, 256);
  const roadsNear = gridIndex(roadSegments(geo), 32);

  const sites = [];
  const trunks = [];
  const skipped = { water: 0, road: 0, building: 0 };
  if (exclude) skipped.trail = 0;
  const speciesCounts = TREE_MODELS.map(() => 0);
  const t = trees.trees;
  for (let i = 0; i < t.length; i += 4) {
    const x = t[i], z = t[i + 1], h = t[i + 2], r = t[i + 3];
    if (waterNear(x, z).some((w) => inPolygon(w.outer, w.holes, x, z))) { skipped.water++; continue; }
    if (roadsNear(x, z).some((s) => segmentDistance(s, x, z) < s.half)) { skipped.road++; continue; }
    if (buildingsNear(x, z).some((f) => x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ && inPolygon(f.outer, f.holes, x, z))) { skipped.building++; continue; }
    if (exclude && exclude.has(i / 4)) { skipped.trail++; continue; }
    const species = speciesAt(x, z);
    const model = TREE_MODELS[species];
    const scale = h / model.H;
    const spread = Math.min(SPREAD[1], Math.max(SPREAD[0], r / (model.R * scale)));
    const y = ground ? ground(x, z) : 0;
    sites.push({ x, y, z, scale, species, sx: spread, sz: spread, tier: TIER, index: i / 4 });
    speciesCounts[species]++;
    const half = Math.max(TRUNK.minHalf, TRUNK.halfPerM * h);
    const outer = [{ x: x - half, z: z - half }, { x: x + half, z: z - half }, { x: x + half, z: z + half }, { x: x - half, z: z + half }];
    trunks.push({ minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half, minY: y, maxY: y + Math.min(TRUNK.maxTop, TRUNK.topPerM * h), polygon: { outer, holes: [] } });
  }
  return { sites, trunks, skipped, speciesCounts };
}

export { placeGfTrees, speciesAt, TREE_MODELS, SPECIES_MIX, SPREAD, TIER, TRUNK };
