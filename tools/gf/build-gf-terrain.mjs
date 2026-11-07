// tools/gf/build-gf-terrain.mjs — writes js/gf-terrain.bin.gz, the game's terrain, from the frozen CC-005b inputs
// usage: node tools/gf/build-gf-terrain.mjs [out.bin.gz]
//
// Inputs (tools/gf/data/terrain/, all checked against their SHA-256 before use; nothing is fetched):
//   gf-dem-candidate-2m.tif            the 2 m base: 2 x 2 means of the aligned 1 m USGS lattice (bundle)
//   gf-dem-refinement-patches-1m.tif   native 1 m source values in the bundle's selected blocks (+ 8 m halo)
//   gf_dem_ring_8m.f32                 8 x 8 means of the same lattice, 424 m beyond (prepare-gf-terrain.mjs)
//   terrain-provenance-and-validation.json, gf_terrain_prepare.json   hashes, transforms, the anchor
// Output: GFT1 (see js/gf-terrain.js): a JSON header, then the base and ring as uint16 heights (QUANT_STEP: rounding
// moves a value by at most half a step) and the 8 m patch tiles kept as int16 residuals over the base's bilinear
// reconstruction (RESIDUAL_STEP), each grid coded by js/gf-terrain.js encodeGrid, gzipped. A patch tile is kept where
// any of its native samples differs from the base reconstruction by more than PATCH_KEEP; there the surface takes the
// native values (to the residual step), elsewhere the base. Nothing is smoothed, filled or invented: an input with a
// missing sample stops the build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openTiff } from './tiff.mjs';
import { encodeGrid } from '../../js/gf-terrain.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data/terrain');
const OUT = process.argv[2] || path.join(HERE, '../../js/gf-terrain.bin.gz');
const log = (...a) => console.log('[gf-terrain]', ...a);

const PATCH_TILE = 8; // metres (lattice nodes) per patch tile side
// Keep a tile's native values where one differs from the 2 m reconstruction by more than this: 0.25 m, the bundle's own
// selection threshold (outside its patches the reconstruction is within 0.25 m by construction, so a smaller threshold
// here would not lower the worst case anywhere else), so that no node is more than 0.25 m off its source pixel
const PATCH_KEEP = 0.25;
const QUANT_STEPS = [0.005, 0.01]; // base and ring: 5 mm (at most 2.5 mm off), 1 cm only if the range needs it
const RESIDUAL_STEP = 0.01; // native residuals to 1 cm (at most 5 mm off)
const BLEND = 24; // metres over which the 8 m ring blends into the lattice outside it

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The GFT1 payload (uncompressed) of the inputs: { payload, stats }
function buildTerrain({ prov, prep, candidate, patches, ring, sums }) {
  const [E0, , , N1] = prov.paddedProjectedBounds;
  const cw = candidate.width, ch = candidate.height, lw = patches.width, lh = patches.height;
  if (lw !== 2 * cw || lh !== 2 * ch) throw new Error('patches are not the candidate lattice at 1 m');
  const R = prep.ring;
  let lo = Infinity, hi = -Infinity;
  const see = (v, what) => {
    if (!Number.isFinite(v)) throw new Error(`${what}: a sample is not finite`);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  };
  for (const v of candidate.values) {
    if (v === candidate.nodata) throw new Error('candidate: nodata sample (no fill)');
    see(v, 'candidate');
  }
  for (const v of patches.values) if (v !== patches.nodata) see(v, 'patches');
  for (const v of ring) see(v, 'ring');
  const offset = Math.floor(lo) - 1;
  const step = QUANT_STEPS.find((s) => (hi - offset) / s <= 65535);
  if (!step) throw new Error(`heights ${lo}-${hi} m do not fit uint16 at any step`);
  const quant = (v) => Math.round((v - offset) / step);

  // the base, quantized; the bilinear reconstruction at lattice node (i, j) exactly as js/gf-terrain.js computes it
  const base = new Uint16Array(cw * ch);
  for (let k = 0; k < base.length; k++) base[k] = quant(candidate.values[k]);
  const bAt = (c, r) => offset + step * base[Math.min(ch - 1, Math.max(0, r)) * cw + Math.min(cw - 1, Math.max(0, c))];
  const lattice = { e0: E0 + 0.5, n0: N1 - 0.5, cols: lw, rows: lh };
  const B = { e0: E0 + 1, n0: N1 - 1, step: 2 };
  function baseBilinear(i, j) {
    const u = (lattice.e0 + i - B.e0) / B.step, v = (B.n0 - (lattice.n0 - j)) / B.step;
    const c0 = Math.floor(u), r0 = Math.floor(v), fu = u - c0, fv = v - r0;
    const h00 = bAt(c0, r0), h10 = bAt(c0 + 1, r0), h01 = bAt(c0, r0 + 1), h11 = bAt(c0 + 1, r0 + 1);
    return h00 + (h10 - h00) * fu + (h01 - h00) * fv + (h00 - h10 - h01 + h11) * fu * fv;
  }

  // patch tiles
  const T = PATCH_TILE, across = Math.ceil(lw / T), down = Math.ceil(lh / T);
  const tiles = [], residual = [];
  let nativeNodes = 0, tilesWithPatch = 0, maxDropped = 0;
  const resHist = { over0_25: 0, over0_5: 0, over1: 0, over2: 0, over5: 0 };
  for (let ty = 0; ty < down; ty++) {
    for (let tx = 0; tx < across; tx++) {
      let any = false, keep = false;
      const res = new Int16Array(T * T);
      let tileMax = 0;
      for (let y = 0; y < T; y++) {
        const j = ty * T + y;
        if (j >= lh) break;
        for (let x = 0; x < T; x++) {
          const i = tx * T + x;
          if (i >= lw) break;
          const v = patches.values[j * lw + i];
          if (v === patches.nodata) continue;
          any = true;
          const d = v - baseBilinear(i, j);
          const q = Math.round(d / RESIDUAL_STEP);
          if (Math.abs(q) > 32767) throw new Error(`residual ${d} m at node ${i},${j} does not fit int16`);
          res[y * T + x] = q;
          tileMax = Math.max(tileMax, Math.abs(d));
        }
      }
      if (!any) continue;
      tilesWithPatch++;
      keep = tileMax > PATCH_KEEP;
      if (!keep) { maxDropped = Math.max(maxDropped, tileMax); continue; }
      tiles.push(ty * across + tx);
      residual.push(res);
      for (let k = 0; k < T * T; k++) {
        const a = Math.abs(res[k] * RESIDUAL_STEP);
        if (a > 0.25) resHist.over0_25++;
        if (a > 0.5) resHist.over0_5++;
        if (a > 1) resHist.over1++;
        if (a > 2) resHist.over2++;
        if (a > 5) resHist.over5++;
      }
      const y1 = Math.min(T, lh - ty * T), x1 = Math.min(T, lw - tx * T);
      for (let y = 0; y < y1; y++) for (let x = 0; x < x1; x++) if (patches.values[(ty * T + y) * lw + tx * T + x] !== patches.nodata) nativeNodes++;
    }
  }

  const ringQ = new Uint16Array(ring.length);
  for (let k = 0; k < ring.length; k++) ringQ[k] = quant(ring[k]);

  const sections = [];
  const chunks = [];
  let at = 0;
  const add = (name, typed) => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
    bytes.copy(padded);
    sections.push({ name, offset: at, bytes: bytes.length });
    chunks.push(padded);
    at += padded.length;
  };
  add('base', encodeGrid(base, cw, ch));
  add('ring', encodeGrid(ringQ, R.cols, R.rows));
  add('tiles', Int32Array.from(tiles));
  const resAll = new Uint8Array(tiles.length * T * T * 2);
  residual.forEach((r, k) => resAll.set(encodeGrid(new Uint16Array(r.buffer), T, T), k * T * T * 2));
  add('residual', resAll);

  const a = prov.anchor;
  const header = {
    format: 'GFT1',
    generator: 'tools/gf/build-gf-terrain.mjs',
    dataset: 'USGS 3DEP NY_Hudson_D22 1 m bare-earth DEM (hydro-flattened), flown leaf-off November 2022 - April 2023',
    metadata: prov.datasetUrl,
    era: 'Bare earth as flown in 2022-23, not a surveyed 1993 landform',
    credit: 'USGS 3D Elevation Program (3DEP), NY_Hudson_D22 1 m DEM, 2022-23',
    licence: prov.license,
    crs: 'EPSG:26918 as the TIFFs encode it (the project metadata describes NAD83(2011) UTM 18N; not relabelled)',
    vertical: 'NAVD88 (GEOID18) metres per the dataset metadata',
    horizontalNote: 'OSM WGS84 lon/lat are projected to EPSG:26918 with no datum shift (as pyproj\'s default made the anchor): consistent, not survey-grade',
    inputs: {
      sources: prov.sourceInputs.map(({ name, url, bytes, sha256: s }) => ({ name, url, bytes, sha256: s })),
      candidate: { file: prov.candidate.file, sha256: sums[prov.candidate.file] },
      patches: { file: prov.nativeDetailPatches.file, sha256: sums[prov.nativeDetailPatches.file] },
      ring: { file: R.file, sha256: R.sha256 },
      frozenInputsCheck: prep.frozenInputsCheck
    },
    anchor: { osmNode: a.osmNode, lon: a.lon, lat: a.lat, utmE: a.utmE, utmN: a.utmN, navd88: a.demNAVD88M,
      rule: 'game y = NAVD88 - navd88 (one constant offset; x and z are the gf-geodata.js frame unchanged)',
      note: 'bilinear 1 m bare-earth sample at the shared Glen / Bay / South Street node, not a surveyed road-deck benchmark' },
    quant: { offset, step, rule: 'NAVD88 = offset + step * q' },
    base: { e0: B.e0, n0: B.n0, step: 2, cols: cw, rows: ch, method: 'the candidate as given (2 x 2 means of the aligned 1 m lattice)' },
    lattice: { ...lattice, pixelM: 1, triangulation: 'two triangles per 1 m cell, diagonal north-west node to south-east node' },
    patches: { tile: T, keep: PATCH_KEEP, step: RESIDUAL_STEP, tilesKept: tiles.length, tilesWithPatchData: tilesWithPatch, nativeNodes,
      maxDroppedTileError: maxDropped, rule: `${T} m tiles of the bundle patches kept where a native sample differs from the base reconstruction by more than ${PATCH_KEEP} m; a kept tile takes every native sample it has` },
    ring: { e0: R.firstCentreE, n0: R.firstCentreN, step: R.stepM, cols: R.cols, rows: R.rows, blend: BLEND,
      method: R.method, rule: `outside the lattice; blended linearly into the lattice's edge over ${BLEND} m` },
    sections
  };
  const json = Buffer.from(JSON.stringify(header));
  const pad = Buffer.alloc((4 - ((8 + json.length) % 4)) % 4, 0x20);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(0x31544647, 0);
  head.writeUInt32LE(json.length + pad.length, 4);
  const payload = Buffer.concat([head, json, pad, ...chunks]);
  return { payload, header, stats: { lo, hi, residualHistogram: resHist } };
}

function readInputs() {
  const prov = JSON.parse(fs.readFileSync(path.join(DATA, 'terrain-provenance-and-validation.json'), 'utf8'));
  const prep = JSON.parse(fs.readFileSync(path.join(DATA, 'gf_terrain_prepare.json'), 'utf8'));
  const sums = {};
  for (const f of ['SHA256SUMS', 'DETAIL-SHA256SUMS']) {
    for (const line of fs.readFileSync(path.join(DATA, f), 'utf8').trim().split('\n')) {
      const [h, name] = line.trim().split(/\s+\*?/);
      sums[name] = h;
    }
  }
  const tiff = (file, expect) => {
    const buf = fs.readFileSync(path.join(DATA, file));
    const s = sha256(buf);
    if (s !== expect || s !== sums[file]) throw new Error(`${file}: sha256 ${s} is not the manifest's ${expect}`);
    const t = openTiff(path.join(DATA, file));
    const values = t.readWindow(0, 0, t.width, t.height);
    t.close();
    return { width: t.width, height: t.height, nodata: t.nodata, scale: t.scale, tie: t.tie, values };
  };
  const candidate = tiff(prov.candidate.file, prov.candidate.sha256);
  const patches = tiff(prov.nativeDetailPatches.file, prov.nativeDetailPatches.sha256);
  const [E0, , , N1] = prov.paddedProjectedBounds;
  if (candidate.tie[3] !== E0 || candidate.tie[4] !== N1 || candidate.scale[0] !== 2) throw new Error('candidate transform');
  if (patches.tie[3] !== E0 || patches.tie[4] !== N1 || patches.scale[0] !== 1) throw new Error('patch transform');
  const ringBuf = fs.readFileSync(path.join(DATA, prep.ring.file));
  if (sha256(ringBuf) !== prep.ring.sha256) throw new Error(`${prep.ring.file}: sha256 is not gf_terrain_prepare.json's`);
  const ring = new Float32Array(ringBuf.buffer.slice(ringBuf.byteOffset, ringBuf.byteOffset + ringBuf.byteLength));
  if (ring.length !== prep.ring.cols * prep.ring.rows) throw new Error('ring size');
  return { prov, prep, candidate, patches, ring, sums };
}

function main() {
  const inputs = readInputs();
  const { payload, header, stats } = buildTerrain(inputs);
  const gz = zlib.gzipSync(payload, { level: 9 });
  fs.writeFileSync(OUT, gz);
  log(`heights ${stats.lo.toFixed(3)}-${stats.hi.toFixed(3)} m NAVD88; quantized at ${header.quant.step} m from ${header.quant.offset} m`);
  log(`base ${header.base.cols} x ${header.base.rows} at 2 m; ring ${header.ring.cols} x ${header.ring.rows} at 8 m`);
  log(`patch tiles kept ${header.patches.tilesKept} of ${header.patches.tilesWithPatchData} with patch data (${header.patches.nativeNodes} native nodes); largest dropped tile error ${header.patches.maxDroppedTileError.toFixed(4)} m`);
  log(`kept residuals: ${JSON.stringify(stats.residualHistogram)}`);
  log(`payload ${payload.length} bytes, sha256 ${sha256(payload)}; wrote ${path.relative(process.cwd(), OUT)} (${gz.length} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();

export { buildTerrain, readInputs, PATCH_KEEP, PATCH_TILE };
