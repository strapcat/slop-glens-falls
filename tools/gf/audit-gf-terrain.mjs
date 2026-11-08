// tools/gf/audit-gf-terrain.mjs — the CC-005b terrain as built (js/gf-terrain.bin.gz) against the original USGS 1 m
// source, every pixel (offline: needs the two original tiles, see prepare-gf-terrain.mjs)
// usage: GF_USGS_DIR=<dir> node tools/gf/audit-gf-terrain.mjs   -> tools/gf/data/terrain/gf_terrain_audit.json
//
// At every 1 m source pixel centre inside the exact WGS84 bbox (the established play area), the error of
//   query   the surface every consumer asks (js/gf-terrain.js): at a pixel centre, the lattice node, which the nearest
//           mesh level draws exactly
//   mesh Ln the coarser mesh levels (gf-terrain-mesh.js: every 2^n-th node, the query's triangles), before their bias
// overall and on the places that matter: roads (every road-graph link's carriageway), river banks and shores (within
// 10 m of a water polygon's outline), the bridge decks' footprints (bare earth under them) and the hill reference crop
// (thrill-hill-reference-dem-1m.tif, which must equal the source there). Plus the query asked through local x, z (the
// projection round trip) on a sparse sample, and the worst locations.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadUsgsLattice } from './usgs-lattice.mjs';
import { openTiff } from './tiff.mjs';
import { decodeTerrain, createGfTerrain } from '../../js/gf-terrain.js';
import { utmToLonLat } from '../../js/gf-utm.js';
import { GF_GEO } from '../../js/gf-geodata.js';
import { GF_BRIDGES } from '../../js/gf-bridges.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data/terrain');
const USGS = process.env.GF_USGS_DIR || path.join(HERE, '../../lidar/tiles');
const log = (...a) => console.log('[gf-terrain-audit]', ...a);

const prov = JSON.parse(fs.readFileSync(path.join(DATA, 'terrain-provenance-and-validation.json'), 'utf8'));
const { lattice: src, W, H, X0, Y1 } = loadUsgsLattice({ usgsDir: USGS, prov, pad: 0, log });
const T = createGfTerrain(decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../js/gf-terrain.bin.gz'))))), GF_GEO.frame);
const L = T.lattice;
if (L.cols !== W || L.rows !== H || L.e0 !== X0 + 0.5 || L.n0 !== Y1 - 0.5) throw new Error('the terrain lattice is not the source rectangle');
const tb = prov.targetWgs84Bounds;

// masks: 1 target, 2 road, 4 bank, 8 deck, 16 hill crop
const mask = new Uint8Array(W * H);
let inTarget = 0;
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    const [lon, lat] = utmToLonLat(L.e0 + i, L.n0 - j);
    if (lon >= tb.west && lon <= tb.east && lat >= tb.south && lat <= tb.north) { mask[j * W + i] = 1; inTarget++; }
  }
}
log(`${inTarget} source pixel centres in the exact WGS84 target (the bundle counts ${prov.coverage.referencePixelsInExactTarget})`);
// a segment's carriageway (half width h) in the lattice
function markSegment(ax, az, bx, bz, h, bit) {
  const [ea, na] = T.toUtm(ax, az), [eb, nb] = T.toUtm(bx, bz);
  const i0 = Math.max(0, Math.floor(Math.min(ea, eb) - h - L.e0)), i1 = Math.min(W - 1, Math.ceil(Math.max(ea, eb) + h - L.e0));
  const j0 = Math.max(0, Math.floor(L.n0 - Math.max(na, nb) - h)), j1 = Math.min(H - 1, Math.ceil(L.n0 - Math.min(na, nb) + h));
  const ex = eb - ea, ny = nb - na, len2 = ex * ex + ny * ny;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const e = L.e0 + i, n = L.n0 - j;
      const t = len2 ? Math.max(0, Math.min(1, ((e - ea) * ex + (n - na) * ny) / len2)) : 0;
      if (Math.hypot(ea + ex * t - e, na + ny * t - n) <= h) mask[j * W + i] |= bit;
    }
  }
}
const g = GF_GEO.roadGraph;
const at = Object.fromEntries(g.linkFields.map((f, k) => [f, k]));
const linkPts = (l) => {
  const pts = [[g.nodes[l[at.a] * 2], g.nodes[l[at.a] * 2 + 1]]];
  for (let k = 0; k < l[at.pts].length; k += 2) pts.push([l[at.pts][k], l[at.pts][k + 1]]);
  pts.push([g.nodes[l[at.b] * 2], g.nodes[l[at.b] * 2 + 1]]);
  return pts;
};
for (const l of g.links) {
  const pts = linkPts(l);
  for (let k = 0; k + 1 < pts.length; k++) markSegment(...pts[k], ...pts[k + 1], l[at.width] / 2, 2);
}
for (const w of GF_GEO.water) {
  for (const ring of [w.outer, ...(w.holes || [])]) {
    for (let k = 0; k < ring.length; k += 2) {
      const n = (k + 2) % ring.length;
      markSegment(ring[k], ring[k + 1], ring[n], ring[n + 1], 10, 4);
    }
  }
}
for (const b of GF_BRIDGES.bridges) {
  for (const [li, s] of b.segments) {
    const pts = linkPts(g.links[li]);
    markSegment(...pts[s], ...pts[s + 1], g.links[li][at.width] / 2 + 2, 8);
  }
}
const hill = openTiff(path.join(DATA, 'thrill-hill-reference-dem-1m.tif'));
const hillVals = hill.readWindow(0, 0, hill.width, hill.height);
const hc0 = Math.round(hill.tie[3] - X0), hr0 = Math.round(Y1 - hill.tie[4]);
let hillEqual = 0;
for (let r = 0; r < hill.height; r++) {
  for (let c = 0; c < hill.width; c++) {
    const k = (hr0 + r) * W + hc0 + c;
    mask[k] |= 16;
    if (hillVals[r * hill.width + c] === src[k]) hillEqual++;
  }
}
log(`hill crop: ${hillEqual} of ${hill.width * hill.height} pixels equal the source lattice (window at column ${hc0}, row ${hr0})`);

// The WORST largest errors, whatever their size: a list kept sorted largest first (ties: the first met, row-major)
const WORST = 10;
function keepWorst(worst, e, i, j) {
  if (worst.length === WORST && e <= worst[WORST - 1][0]) return;
  let k = worst.length < WORST ? worst.length : WORST - 1;
  while (k > 0 && worst[k - 1][0] < e) k--;
  worst.splice(k, 0, [e, i, j]);
  if (worst.length > WORST) worst.pop();
}

// error statistics of f(i, j) over the pixels where (mask & bit) === bit; stride for the mesh levels
function stats(f, bit, stride = 1) {
  const hist = new Uint32Array(200001); // 0.0001 m bins to 20 m
  let n = 0, sum = 0, sum2 = 0, max = 0;
  const worst = [];
  for (let j = 0; j < H; j += stride) {
    for (let i = 0; i < W; i += stride) {
      const k = j * W + i;
      if ((mask[k] & bit) !== bit || !(mask[k] & 1)) continue;
      const e = Math.abs(f(i, j) - src[k]);
      n++; sum += e; sum2 += e * e;
      hist[Math.min(200000, Math.round(e * 10000))]++;
      if (e > max) max = e;
      keepWorst(worst, e, i, j);
    }
  }
  const pct = (p) => {
    let acc = 0;
    for (let b = 0; b < hist.length; b++) { acc += hist[b]; if (acc >= p * n) return b / 10000; }
    return max;
  };
  const over = (t) => { let c = 0; for (let b = Math.round(t * 10000) + 1; b < hist.length; b++) c += hist[b]; return c; };
  return {
    n, maeM: sum / n, rmseM: Math.sqrt(sum2 / n), p50M: pct(0.5), p95M: pct(0.95), p99M: pct(0.99), maxM: max,
    over0_1M: over(0.1), over0_25M: over(0.25), over0_5M: over(0.5), over1M: over(1),
    worst: worst.map(([e, i, j]) => {
      const [x, z] = T.fromUtm(L.e0 + i, L.n0 - j);
      const [lon, lat] = utmToLonLat(L.e0 + i, L.n0 - j);
      const m = mask[j * W + i], on = ['road', 'bank', 'deck', 'hill'].filter((_, b) => m & (2 << b));
      return { errorM: +e.toFixed(4), sourceM: +src[j * W + i].toFixed(3), surfaceM: +f(i, j).toFixed(3), col: i, row: j, lon: +lon.toFixed(7), lat: +lat.toFixed(7), x: +x.toFixed(1), z: +z.toFixed(1), native: T.isNative(i, j), on };
    })
  };
}
const query = (i, j) => T.nodeNavd(i, j);
// mesh level n: every s-th node (s = 2^n) and the query's triangles between them
const meshLevel = (s) => (i, j) => {
  const i0 = Math.floor(i / s) * s, j0 = Math.floor(j / s) * s;
  const fx = (i - i0) / s, fy = (j - j0) / s;
  const h00 = T.nodeNavd(i0, j0), h11 = T.nodeNavd(i0 + s, j0 + s);
  if (fx >= fy) return h00 + fx * (T.nodeNavd(i0 + s, j0) - h00) + fy * (h11 - T.nodeNavd(i0 + s, j0));
  const h01 = T.nodeNavd(i0, j0 + s);
  return h00 + fy * (h01 - h00) + fx * (h11 - h01);
};
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(5) : v)));
const report = { script: 'tools/gf/audit-gf-terrain.mjs', terrain: 'js/gf-terrain.bin.gz', targetPixels: inTarget, hillCrop: { pixels: hill.width * hill.height, equalToSource: hillEqual } };
report.query = { all: stats(query, 1), roads: stats(query, 3), banks: stats(query, 5), decks: stats(query, 9), hill: stats(query, 17) };
log(`query: ${JSON.stringify(round({ ...report.query.all, worst: undefined }))}`);
for (const k of ['roads', 'banks', 'decks', 'hill']) log(`query ${k}: n ${report.query[k].n}, mae ${report.query[k].maeM.toFixed(4)}, p95 ${report.query[k].p95M}, p99 ${report.query[k].p99M}, max ${report.query[k].maxM.toFixed(4)}`);
report.mesh = {};
for (const n of [1, 2, 3, 4, 5]) {
  report.mesh[`L${n}`] = { spacingM: 2 ** n, stride: 3, all: stats(meshLevel(2 ** n), 1, 3), roads: stats(meshLevel(2 ** n), 3, 3) };
  log(`mesh L${n} (${2 ** n} m): mae ${report.mesh[`L${n}`].all.maeM.toFixed(4)}, p95 ${report.mesh[`L${n}`].all.p95M}, max ${report.mesh[`L${n}`].all.maxM.toFixed(3)}; roads p95 ${report.mesh[`L${n}`].roads.p95M}`);
}
// the query through local x, z (projection both ways) on every 97th pixel
let worstTrip = 0, trips = 0;
for (let k = 0; k < W * H; k += 97) {
  const i = k % W, j = Math.floor(k / W);
  const [x, z] = T.fromUtm(L.e0 + i, L.n0 - j);
  worstTrip = Math.max(worstTrip, Math.abs(T.heightAt(x, z) + T.ANCHOR - T.nodeNavd(i, j)));
  trips++;
}
report.localRoundTrip = { samples: trips, maxDiffM: worstTrip };
log(`local x, z round trip: ${trips} samples, max ${worstTrip.toExponential(2)} m`);
fs.writeFileSync(path.join(DATA, 'gf_terrain_audit.json'), JSON.stringify(round(report), null, 1) + '\n');
log('wrote tools/gf/data/terrain/gf_terrain_audit.json');
