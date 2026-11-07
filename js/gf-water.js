// Glens Falls water surfaces on the CC-005b terrain (no three.js, so Node tests use it as the game does). The USGS DEM
// is bare earth, hydro-flattened: over water it holds the water surface the producer flattened (flat bank to bank on a
// pond, falling downstream on a river, stepping at a dam), not the bed, and no bathymetry is invented here. For each
// GF_GEO water polygon (x/z unchanged), the DEM is sampled on a 4 m grid inside it and the flattened cells found
// (slope under FLAT_SLOPE):
//   flat    most of the body is flattened at one level (spread under FLAT_SPREAD): the surface is that level, one plane
//   graded  a river reach, canal or basin whose flattened surface falls or steps: each cell takes the level of its
//           nearest flattened cell (none: the DEM itself), and the surface is the lower of that level and the DEM,
//           so it never climbs a bank above the flattened water and follows the DEM down over a fall or a weir
// Banks and rocks inside an OSM polygon stand above the surface and show through it; islands (polygon holes) stay dry.

const STEP = 4; // metres between samples
const FLAT_SLOPE = 0.02; // rise over run under which a cell counts as hydro-flattened
const FLAT_SHARE = 0.5;
const FLAT_SPREAD = 0.3; // metres, 5th to 95th percentile of a flat body's flattened cells

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[i], az = ring[i + 1], bx = ring[j], bz = ring[j + 1];
    if ((az > z) !== (bz > z) && x < ax + ((bx - ax) * (z - az)) / (bz - az)) inside = !inside;
  }
  return inside;
}
const inPolygon = (w, x, z) => inRing(w.outer, x, z) && !(w.holes || []).some((h) => inRing(h, x, z));
function boundsOf(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
    minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]);
  }
  return { minX, maxX, minZ, maxZ };
}
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

// One body: { index, osm, kind, name, polygon, bounds, type: 'flat' | 'graded', level, grid, stats }
function analyseBody(w, index, groundAt) {
  const b = boundsOf(w.outer);
  const x0 = Math.floor(b.minX / STEP) * STEP, z0 = Math.floor(b.minZ / STEP) * STEP;
  const cols = Math.floor((b.maxX - x0) / STEP) + 2, rows = Math.floor((b.maxZ - z0) / STEP) + 2;
  const h = new Float32Array(cols * rows).fill(NaN);
  const inside = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * STEP, z = z0 + r * STEP;
      h[r * cols + c] = groundAt(x, z);
      if (inPolygon(w, x, z)) inside[r * cols + c] = 1;
    }
  }
  const flat = new Uint8Array(cols * rows);
  const flatVals = [], allVals = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (!inside[k] || !Number.isFinite(h[k])) continue;
      allVals.push(h[k]);
      const e = h[r * cols + Math.min(cols - 1, c + 1)], wv = h[r * cols + Math.max(0, c - 1)];
      const s = h[Math.min(rows - 1, r + 1) * cols + c], n = h[Math.max(0, r - 1) * cols + c];
      const gx = (e - wv) / (2 * STEP), gz = (s - n) / (2 * STEP);
      if (Number.isFinite(gx) && Number.isFinite(gz) && Math.hypot(gx, gz) < FLAT_SLOPE) {
        flat[k] = 1;
        flatVals.push(h[k]);
      }
    }
  }
  flatVals.sort((a, c) => a - c);
  allVals.sort((a, c) => a - c);
  const stats = {
    samples: allVals.length, flatShare: allVals.length ? flatVals.length / allVals.length : 0,
    groundP5: pct(allVals, 0.05), groundP50: pct(allVals, 0.5), groundP95: pct(allVals, 0.95),
    flatP5: flatVals.length ? pct(flatVals, 0.05) : NaN, flatP95: flatVals.length ? pct(flatVals, 0.95) : NaN
  };
  const base = { index, osm: w.osm, kind: w.kind, name: w.name || '', polygon: w, bounds: b, stats };
  if (allVals.length && stats.flatShare >= FLAT_SHARE && stats.flatP95 - stats.flatP5 <= FLAT_SPREAD) {
    return { ...base, type: 'flat', level: pct(flatVals, 0.5) };
  }
  // graded: each cell takes its nearest flattened cell's level (breadth first from every flattened cell, in index
  // order, so the fill is deterministic); with none, the DEM itself
  const level = new Float32Array(cols * rows).fill(Infinity);
  const queue = new Int32Array(cols * rows);
  let head = 0, tail = 0;
  for (let k = 0; k < flat.length; k++) if (flat[k]) { level[k] = h[k]; queue[tail++] = k; }
  const seen = new Uint8Array(cols * rows);
  for (let k = 0; k < tail; k++) seen[queue[k]] = 1;
  while (head < tail) {
    const k = queue[head++], r = Math.floor(k / cols), c = k % cols;
    for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
      const kk = rr * cols + cc;
      if (seen[kk]) continue;
      seen[kk] = 1;
      level[kk] = level[k];
      queue[tail++] = kk;
    }
  }
  return { ...base, type: 'graded', grid: { x0, z0, step: STEP, cols, rows, level } };
}

// The water of GF_GEO over the terrain: { bodies, surfaceAt(x, z) (game y or null), bodyAt(x, z) }
function createGfWater(geo, groundAt) {
  const bodies = geo.water.map((w, i) => analyseBody(w, i, groundAt));
  const CELL = 128;
  const cells = new Map();
  for (const body of bodies) {
    const { minX, maxX, minZ, maxZ } = body.bounds;
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++) {
      for (let gz = Math.floor(minZ / CELL); gz <= Math.floor(maxZ / CELL); gz++) {
        const k = gx * 65536 + gz;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(body);
      }
    }
  }
  function bodyAt(x, z) {
    for (const body of cells.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL)) || []) {
      const b = body.bounds;
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && inPolygon(body.polygon, x, z)) return body;
    }
    return null;
  }
  // The level a body's surface takes at (x, z) before the DEM caps it (graded: bilinear on its grid)
  function levelOf(body, x, z) {
    if (body.type === 'flat') return body.level;
    const { x0, z0, step, cols, rows, level } = body.grid;
    const u = Math.min(cols - 1.001, Math.max(0, (x - x0) / step)), v = Math.min(rows - 1.001, Math.max(0, (z - z0) / step));
    const c = Math.floor(u), r = Math.floor(v), fu = u - c, fv = v - r;
    const a = level[r * cols + c], b = level[r * cols + c + 1], d = level[(r + 1) * cols + c], e = level[(r + 1) * cols + c + 1];
    return a + (b - a) * fu + (d - a) * fv + (a - b - d + e) * fu * fv;
  }
  // The water surface at (x, z): game y, or null off the water
  function surfaceAt(x, z) {
    const body = bodyAt(x, z);
    if (!body) return null;
    const g = groundAt(x, z);
    if (body.type === 'flat') return body.level;
    const l = levelOf(body, x, z);
    return Number.isFinite(l) ? Math.min(l, g) : g;
  }
  return { bodies, bodyAt, levelOf, surfaceAt, groundAt };
}

export { createGfWater, inPolygon, STEP as WATER_STEP };
