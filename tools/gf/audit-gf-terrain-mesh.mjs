// tools/gf/audit-gf-terrain-mesh.mjs — the CC-005b terrain AS DRAWN (js/gf-terrain-lod.js, the game's own chunks,
// levels and stitching) against the ground query every consumer uses (js/gf-terrain.js), repo inputs only.
// usage: node tools/gf/audit-gf-terrain-mesh.mjs   -> tools/gf/data/terrain/gf_terrain_mesh_audit.json
//                                                  -> js/gf-terrain-lod-errors.js (each chunk's error, for the LOD)
//
// The drawn surface and the query are both linear on triangles whose corners are lattice nodes (a level-n triangle is a
// union of the query's 1 m triangles: same diagonal), so their difference is largest at a lattice node: comparing
// every node is exact, not a sample. Reported:
//   levels   every level 0..8 over the whole lattice: the error at every node, per chunk (the table the LOD uses),
//            overall and on roads, banks, decks and the hill crop, with the worst locations;
//   stitches every level l against every coarser neighbour K on each edge: the nodes along a stitched edge;
//   views    the game's own selection (with the table) from cameras over the play area: chunks, triangles, the
//            largest error within 50 / 100 / 200 m and over all as a fraction of the distance (and in pixels at 900
//            pixels and a 60 degree field of view, where a pixel is 0.00128 of the distance), and
//            cracks (each chunk's drawn border against the chunk across it).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeTerrain, createGfTerrain } from '../../js/gf-terrain.js';
import { createTerrainLod, CELLS, ROOT_LEVEL, N, SCREEN_TOL } from '../../js/gf-terrain-lod.js';
import { encodeLodErrors, decodeLodErrors } from '../../js/gf-terrain-lod-codec.js';
import { utmToLonLat } from '../../js/gf-utm.js';
import { GF_GEO } from '../../js/gf-geodata.js';
import { terrainMasks, MASK, MASK_NAMES } from './terrain-masks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const DATA = path.join(HERE, 'data/terrain');
const log = (...a) => console.log('[gf-terrain-mesh-audit]', ...a);

function loadTerrain() {
  return createGfTerrain(decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'js/gf-terrain.bin.gz'))))), GF_GEO.frame);
}

// Every level's per-chunk error (metres, the largest |drawn - query| at a lattice node of the chunk), and, if `stats`
// is given, its statistics: stats(l, i, j, err) per node
function levelErrors(T, lod, l, onNode = null) {
  const L = T.lattice, W = L.cols, H = L.rows, hull = T.hull;
  const s = 2 ** l, size = CELLS * s, across = 2 ** (ROOT_LEVEL - l);
  const table = new Float64Array(across * across);
  for (let ky = 0; ky < across; ky++) {
    for (let kx = 0; kx < across; kx++) {
      const [e0, n0] = lod.origin(l, kx, ky);
      if (e0 + size < hull.e0 || e0 > hull.e1 || n0 < hull.n0 || n0 - size > hull.n1) continue;
      const h = lod.heights(l, kx, ky);
      table[ky * across + kx] = chunkError(T, l, e0, n0, h, onNode);
    }
  }
  return table;
}
// the largest |drawn - query| over the lattice nodes in a chunk at (e0, n0) drawn with heights h (row band b0..b1 of
// cells, all by default), calling onNode(i, j, err) for each
function chunkError(T, l, e0, n0, h, onNode, b0 = 0, b1 = CELLS - 1, a0 = 0, a1 = CELLS - 1) {
  const L = T.lattice, W = L.cols, H = L.rows;
  const s = 2 ** l;
  let worst = 0;
  const i0 = Math.max(0, Math.round(e0 - L.e0) + a0 * s), i1 = Math.min(W - 1, Math.round(e0 - L.e0) + (a1 + 1) * s);
  const j0 = Math.max(0, Math.round(L.n0 - n0) + b0 * s), j1 = Math.min(H - 1, Math.round(L.n0 - n0) + (b1 + 1) * s);
  const ib = Math.round(e0 - L.e0), jb = Math.round(L.n0 - n0);
  for (let j = j0; j <= j1; j++) {
    const fb = (j - jb) / s;
    const b = Math.min(CELLS - 1, Math.floor(fb)), fy = fb - b;
    for (let i = i0; i <= i1; i++) {
      const fa = (i - ib) / s;
      const a = Math.min(CELLS - 1, Math.floor(fa)), fx = fa - a;
      const h00 = h[b * N + a], h11 = h[(b + 1) * N + a + 1];
      let d;
      if (fx >= fy) d = h00 + fx * (h[b * N + a + 1] - h00) + fy * (h11 - h[b * N + a + 1]);
      else { const h01 = h[(b + 1) * N + a]; d = h00 + fy * (h01 - h00) + fx * (h11 - h01); }
      const err = Math.abs(d - T.nodeNavd(i, j));
      if (err > worst) worst = err;
      if (onNode) onNode(i, j, err);
    }
  }
  return worst;
}

// statistics with the true worst locations
function collector(T, mask) {
  const L = T.lattice, W = L.cols;
  const make = () => ({ hist: new Uint32Array(30001), n: 0, sum: 0, max: 0, worst: [] });
  const sets = { all: make(), ...Object.fromEntries(MASK_NAMES.map((m) => [m, make()])) };
  const add = (c, e, i, j) => {
    c.n++; c.sum += e; c.hist[Math.min(30000, Math.round(e * 1000))]++;
    if (e > c.max) c.max = e;
    if (c.worst.length < 10 || e > c.worst[c.worst.length - 1][0]) {
      let k = Math.min(c.worst.length, 9);
      while (k > 0 && c.worst[k - 1][0] < e) k--;
      c.worst.splice(k, 0, [e, i, j]);
      if (c.worst.length > 10) c.worst.pop();
    }
  };
  return {
    onNode(i, j, e) {
      const m = mask[j * W + i];
      if (!(m & MASK.target)) return;
      add(sets.all, e, i, j);
      MASK_NAMES.forEach((name, b) => { if (m & (2 << b)) add(sets[name], e, i, j); });
    },
    report() {
      const out = {};
      for (const [name, c] of Object.entries(sets)) {
        const pct = (p) => { let acc = 0; for (let b = 0; b < c.hist.length; b++) { acc += c.hist[b]; if (acc >= p * c.n) return b / 1000; } return c.max; };
        out[name] = { n: c.n, maeM: c.n ? c.sum / c.n : 0, p95M: pct(0.95), p99M: pct(0.99), maxM: c.max, worst: c.worst.map(([e, i, j]) => where(T, mask, e, i, j)) };
      }
      return out;
    }
  };
}
function where(T, mask, e, i, j) {
  const L = T.lattice;
  const [x, z] = T.fromUtm(L.e0 + i, L.n0 - j), [lon, lat] = utmToLonLat(L.e0 + i, L.n0 - j);
  const m = mask[j * L.cols + i];
  return { errorM: +e.toFixed(3), col: i, row: j, x: +x.toFixed(1), z: +z.toFixed(1), lon: +lon.toFixed(6), lat: +lat.toFixed(6), on: MASK_NAMES.filter((_, b) => m & (2 << b)) };
}

function main() {
  const t0 = Date.now();
  const T = loadTerrain();
  const prov = JSON.parse(fs.readFileSync(path.join(DATA, 'terrain-provenance-and-validation.json'), 'utf8'));
  const { mask } = terrainMasks(T, prov.targetWgs84Bounds, DATA);
  const plain = createTerrainLod(T);
  const report = { script: 'tools/gf/audit-gf-terrain-mesh.mjs', terrain: 'js/gf-terrain.bin.gz', levels: {}, stitches: {}, views: [] };

  // 1. every level over the whole lattice
  const errors = [null];
  for (let l = 0; l <= ROOT_LEVEL; l++) {
    const c = collector(T, mask);
    const table = levelErrors(T, plain, l, c.onNode);
    if (l > 0) errors.push(table);
    report.levels[`L${l}`] = { spacingM: 2 ** l, ...c.report() };
    const a = report.levels[`L${l}`].all;
    log(`L${l} (${2 ** l} m): max ${a.maxM.toFixed(3)} m at x ${a.worst[0]?.x}, z ${a.worst[0]?.z}; p95 ${a.p95M}; roads max ${report.levels[`L${l}`].road.maxM.toFixed(3)}, banks ${report.levels[`L${l}`].bank.maxM.toFixed(3)}, hill ${report.levels[`L${l}`].hill.maxM.toFixed(3)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }

  // 2. stitched edges: level l stitched onto a coarser K along one edge, the cells along it
  for (let l = 0; l < ROOT_LEVEL; l++) {
    const s = 2 ** l, size = CELLS * s, across = 2 ** (ROOT_LEVEL - l), hull = T.hull;
    for (let K = l + 1; K <= ROOT_LEVEL; K++) {
      let worst = { errorM: 0 };
      for (let ky = 0; ky < across; ky++) {
        for (let kx = 0; kx < across; kx++) {
          const [e0, n0] = plain.origin(l, kx, ky);
          if (e0 + size < hull.e0 || e0 > hull.e1 || n0 < hull.n0 || n0 - size > hull.n1) continue;
          const h = plain.heights(l, kx, ky);
          for (let edge = 0; edge < 4; edge++) {
            const stitch = [-1, -1, -1, -1];
            stitch[edge] = K;
            const hs = plain.stitchInto(Float64Array.from(h), l, kx, ky, stitch);
            const band = [[0, 0, 0, CELLS - 1], [0, CELLS - 1, CELLS - 1, CELLS - 1], [CELLS - 1, CELLS - 1, 0, CELLS - 1], [0, CELLS - 1, 0, 0]][edge];
            let wi = -1, wj = -1;
            const e = chunkError(T, l, e0, n0, hs, (i, j, err) => { if (err > worst.errorM) { wi = i; wj = j; worst = { errorM: err }; } }, ...band);
            if (wi >= 0) worst = { ...where(T, mask, e, wi, wj), errorM: +worst.errorM.toFixed(3), chunk: [l, kx, ky], edge };
          }
        }
      }
      report.stitches[`L${l}-L${K}`] = worst;
    }
    log(`stitched L${l}: worst ${Object.entries(report.stitches).filter(([k]) => k.startsWith(`L${l}-`)).map(([k, v]) => `${k} ${v.errorM}`).join(', ')}`);
  }

  // 3. the per-chunk errors for the LOD (centimetres, rounded up)
  const encoded = encodeLodErrors(errors);
  fs.writeFileSync(path.join(ROOT, 'js/gf-terrain-lod-errors.js'),
    '// generated by tools/gf/audit-gf-terrain-mesh.mjs: each terrain chunk\'s largest drawn error (cm, rounded up) per\n' +
    '// level 1..8, row-major over the quadtree; gf-terrain-lod-codec.js decodes it\n' +
    `export const GF_TERRAIN_LOD_ERRORS = ${JSON.stringify(encoded)};\n`);

  // 4. the game's selection, with that table, from cameras over the play area
  const lod = createTerrainLod(T, { errors: decodeLodErrors(encoded) });
  const cams = [
    ['downtown', -150, -60, 25], ['downtown street', -150, -60, 2], ['river', 420, 300, 30], ['river bank', 237, 411, 2],
    ['hill', -1650, -1350, 60], ['Thrill Hill top', -2597, -1738, 2], ['overview', 0, -150, 300], ['high', 0, 0, 1500]
  ];
  for (let x = -2800; x <= 2800; x += 800) for (let z = -2200; z <= 2200; z += 800) cams.push([`grid ${x},${z}`, x, z, 2]);
  for (const [name, x, z, alt] of cams) {
    const [ce, cn] = T.toUtm(x, z), g = T.heightAt(x, z);
    const { chunks, chosen } = lod.select(ce, cn, alt);
    const drawn = new Map();
    let screen = 0, screenAt = null, near = { 50: 0, 100: 0, 200: 0 }, crack = 0, crackAt = null;
    for (const c of chunks) {
      const h = lod.heights(c.l, c.kx, c.ky);
      if (c.stitch) lod.stitchInto(h, c.l, c.kx, c.ky, c.stitch);
      drawn.set(c.key, h);
      const [e0, n0, size] = lod.origin(c.l, c.kx, c.ky);
      const dx = Math.max(0, e0 - ce, ce - e0 - size), dn = Math.max(0, n0 - size - cn, cn - n0);
      const d = Math.hypot(dx, dn, alt);
      // this chunk as drawn (stitched): exact over all its nodes for fine levels; for coarse ones the table's (its
      // unstitched error, rounded up to the centimetre) and, exactly, the cells along each stitched edge
      let err;
      if (c.l <= 3) err = chunkError(T, c.l, e0, n0, h, null);
      else {
        err = lod.errorOf(c.l, c.kx, c.ky);
        if (c.stitch) c.stitch.forEach((K, edge) => {
          if (K < 0) return;
          const band = [[0, 0, 0, CELLS - 1], [0, CELLS - 1, CELLS - 1, CELLS - 1], [CELLS - 1, CELLS - 1, 0, CELLS - 1], [0, CELLS - 1, 0, 0]][edge];
          err = Math.max(err, chunkError(T, c.l, e0, n0, h, null, ...band));
        });
      }
      if (err / Math.max(d, 1) > screen) { screen = err / Math.max(d, 1); screenAt = { chunk: c.key, errorM: +err.toFixed(3), distanceM: +d.toFixed(0) }; }
      for (const r of [50, 100, 200]) if (d < r) near[r] = Math.max(near[r], err);
    }
    // cracks: every chunk's border, each metre, against the chunk across it
    for (const c of chunks) {
      const [e0, n0, size] = lod.origin(c.l, c.kx, c.ky);
      const h = drawn.get(c.key);
      for (let t = 0; t <= size; t += 1) {
        for (const [e, n, oe, on] of [[e0 + t, n0, 0, 0.25], [e0 + size, n0 - t, 0.25, 0], [e0 + t, n0 - size, 0, -0.25], [e0, n0 - t, -0.25, 0]]) {
          const other = chunkAt(e + oe, n + on);
          if (!other || other.key === c.key) continue;
          const y1 = lod.drawnAt(c.l, c.kx, c.ky, h, e, n), y2 = lod.drawnAt(other.l, other.kx, other.ky, drawn.get(other.key), e, n);
          const dd = Math.abs(y1 - y2);
          if (dd > crack) { crack = dd; crackAt = [+e.toFixed(1), +n.toFixed(1), c.key, other.key]; }
        }
      }
    }
    function chunkAt(e, n) {
      for (let K = 0; K <= ROOT_LEVEL; K++) {
        const sz = CELLS * 2 ** K, key = `${K}/${Math.floor((e - lod.OE) / sz)}/${Math.floor((lod.ON - n) / sz)}`;
        if (chosen.has(key)) { const [l, kx, ky] = key.split('/').map(Number); return { key, l, kx, ky }; }
      }
      return null;
    }
    const levelsUsed = {};
    for (const c of chunks) levelsUsed[c.l] = (levelsUsed[c.l] || 0) + 1;
    const v = { name, x, z, alt, chunks: chunks.length, triangles: chunks.length * CELLS * CELLS * 2, levels: levelsUsed,
      screenError: +screen.toFixed(5), screenPixels: +(screen / 0.00128).toFixed(1), screenAt, within50M: +near[50].toFixed(3), within100M: +near[100].toFixed(3), within200M: +near[200].toFixed(3),
      crackM: +crack.toFixed(6), crackAt };
    report.views.push(v);
    log(`view ${name}: ${v.chunks} chunks, screen error ${v.screenError} (tol ${SCREEN_TOL}), <50 m ${v.within50M}, <100 m ${v.within100M}, <200 m ${v.within200M}, crack ${v.crackM}`);
  }
  const round = (o) => JSON.parse(JSON.stringify(o, (k, val) => (typeof val === 'number' && !Number.isInteger(val) ? +val.toFixed(5) : val)));
  fs.writeFileSync(path.join(DATA, 'gf_terrain_mesh_audit.json'), JSON.stringify(round(report), null, 1) + '\n');
  log(`wrote tools/gf/data/terrain/gf_terrain_mesh_audit.json and js/gf-terrain-lod-errors.js (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

export { levelErrors, chunkError, loadTerrain };
