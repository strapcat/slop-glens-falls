// tools/gf/prepare-gf-terrain.mjs — the part of the CC-005b terrain that needs the original USGS tiles (offline, once)
// usage: GF_USGS_DIR=<dir with the two USGS_1M_18_x6?y480_NY_Hudson_D22.tif> node tools/gf/prepare-gf-terrain.mjs
//
// 1. Checks both original tiles' bytes and SHA-256 against the CC-005b provenance (terrain-provenance-and-validation.json).
// 2. Rebuilds the bundle's aligned 1 m reference lattice from them (each 1 m reference pixel centre takes the source
//    pixel it falls in, x60 then x61, valid samples only, as the bundle's prepare-topography-inputs.py did with
//    rasterio nearest), over the padded rectangle plus RING_PAD m, and proves the frozen inputs are that lattice: the
//    2 m candidate equals its 2 x 2 means and the 1 m refinement patches equal its pixels, every one, bit for bit.
// 3. Writes the 8 m ring beyond the bundle's rectangle (data/terrain/gf_dem_ring_8m.f32, the 8 x 8 means of the same
//    lattice, raw little-endian float32, north row first) for build-gf-terrain.mjs. No nodata is filled and nothing is
//    smoothed: a missing sample stops the script.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTiff } from './tiff.mjs';
import { loadUsgsLattice } from './usgs-lattice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USGS = process.env.GF_USGS_DIR || path.join(HERE, '../../lidar/tiles');
const BUNDLE = path.join(HERE, 'data/terrain');
const OUT = path.join(BUNDLE, 'gf_dem_ring_8m.f32');
const OUT_JSON = path.join(BUNDLE, 'gf_terrain_prepare.json');
const RING_PAD = 426; // metres beyond the bundle rectangle (the flat ground used to reach 400 m); 5820 + 2 x 426 = 834 ring cells of 8 m
const RING_STEP = 8;
const log = (...a) => console.log('[gf-terrain-prepare]', ...a);

const prov = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'terrain-provenance-and-validation.json'), 'utf8'));
const [E0, N0, E1, N1] = prov.paddedProjectedBounds; // 606980, 4793840, 612800, 4798420
const X0 = E0 - RING_PAD, X1 = E1 + RING_PAD, Y0 = N0 - RING_PAD, Y1 = N1 + RING_PAD;
const W = X1 - X0, H = Y1 - Y0;
if (W % RING_STEP || H % RING_STEP) throw new Error(`the ${W} x ${H} m extent is not whole ${RING_STEP} m ring cells`);

// 1-2. The originals, checked, as the aligned 1 m lattice
const { lattice, sources, lo, hi } = loadUsgsLattice({ usgsDir: USGS, prov, pad: RING_PAD, log });

// The frozen inputs against it
const off = RING_PAD; // bundle rectangle origin inside the lattice (columns and rows)
const cand = openTiff(path.join(BUNDLE, prov.candidate.file));
const cw = cand.width, ch = cand.height;
const cv = cand.readWindow(0, 0, cw, ch);
let candEqual = 0, candMax = 0;
for (let r = 0; r < ch; r++) {
  for (let c = 0; c < cw; c++) {
    const i = (off + 2 * r) * W + off + 2 * c;
    const m = Math.fround((lattice[i] + lattice[i + 1] + lattice[i + W] + lattice[i + W + 1]) / 4);
    const d = Math.abs(m - cv[r * cw + c]);
    if (d === 0) candEqual++;
    candMax = Math.max(candMax, d);
  }
}
const patch = openTiff(path.join(BUNDLE, prov.nativeDetailPatches.file));
let patchValid = 0, patchEqual = 0, patchMax = 0;
for (let r = 0; r < patch.height; r += 512) {
  const rows = Math.min(512, patch.height - r);
  const win = patch.readWindow(0, r, patch.width, rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < patch.width; x++) {
      const v = win[y * patch.width + x];
      if (v === patch.nodata) continue;
      patchValid++;
      const d = Math.abs(v - lattice[(off + r + y) * W + off + x]);
      if (d === 0) patchEqual++;
      patchMax = Math.max(patchMax, d);
    }
  }
}
log(`candidate: ${candEqual} of ${cw * ch} pixels equal the lattice's 2 x 2 means (max difference ${candMax} m)`);
log(`patches: ${patchEqual} of ${patchValid} valid pixels equal the lattice (max difference ${patchMax} m)`);
if (candEqual !== cw * ch || patchEqual !== patchValid || patchValid !== prov.nativeDetailPatches.sourceValidPixels) {
  throw new Error('the frozen CC-005b inputs are not the originals\' lattice: stop');
}

// 3. The 8 m ring (8 x 8 means), over the whole extent (build-gf-terrain.mjs uses it outside the bundle rectangle)
const RW = W / RING_STEP, RH = H / RING_STEP;
const ring = new Float32Array(RW * RH);
for (let r = 0; r < RH; r++) {
  for (let c = 0; c < RW; c++) {
    let s = 0;
    for (let y = 0; y < RING_STEP; y++) for (let x = 0; x < RING_STEP; x++) s += lattice[(r * RING_STEP + y) * W + c * RING_STEP + x];
    ring[r * RW + c] = Math.fround(s / (RING_STEP * RING_STEP));
  }
}
fs.writeFileSync(OUT, Buffer.from(ring.buffer));
const ringSha = crypto.createHash('sha256').update(Buffer.from(ring.buffer)).digest('hex');
const report = {
  script: 'tools/gf/prepare-gf-terrain.mjs',
  sources: sources.map(({ name, url, bytes, sha256 }) => ({ name, url, bytes, sha256, verified: true })),
  lattice: { originE: X0, originN: Y1, pixelM: 1, cols: W, rows: H, minNavd88: lo, maxNavd88: hi, missing: 0,
    rule: 'each 1 m reference pixel centre takes the source pixel it falls in (floor), x60 then x61 (x61 wins in the overlap), valid samples only' },
  frozenInputsCheck: {
    candidate: { file: prov.candidate.file, sha256: prov.candidate.sha256, pixels: cw * ch, equal: candEqual, maxDiffM: candMax },
    patches: { file: prov.nativeDetailPatches.file, sha256: prov.nativeDetailPatches.sha256, validPixels: patchValid, equal: patchEqual, maxDiffM: patchMax }
  },
  ring: { file: path.basename(OUT), sha256: ringSha, bytes: ring.byteLength, format: 'raw float32 little-endian, row-major, north row first',
    stepM: RING_STEP, cols: RW, rows: RH, firstCentreE: X0 + RING_STEP / 2, firstCentreN: Y1 - RING_STEP / 2, method: '8 x 8 mean of the aligned 1 m lattice' }
};
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
log(`wrote ${path.relative(process.cwd(), OUT)} (${RW} x ${RH}, sha256 ${ringSha}) and ${path.relative(process.cwd(), OUT_JSON)}`);

export { X0, Y1, W, H };
