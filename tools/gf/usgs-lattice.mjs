// tools/gf/usgs-lattice.mjs — the aligned 1 m reference lattice of the original USGS 3DEP tiles, for
// prepare-gf-terrain.mjs and audit-gf-terrain.mjs (offline; the tiles are 728 MB and not in the repo)
//
// Each 1 m reference pixel centre (E0 - pad + c + 0.5, N1 + pad - r - 0.5) takes the source pixel it falls in (floor),
// x60 then x61 (x61 wins in their 12 m overlap), valid samples only: what the CC-005b bundle's
// prepare-topography-inputs.py did with rasterio's nearest resampling (the tiles' encoded lattices are < 0.00004 m off
// the integer metre). Both tiles are checked against the bundle's bytes and SHA-256 first; a missing sample throws.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openTiff } from './tiff.mjs';

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 24);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

// Copies tile `t` ({ width, height, nodata, readWindow }) into the W x H lattice, its pixel (c0 + c, r0 + r) on lattice
// pixel (c, r): valid samples only (never its nodata, never a non-finite value), over whatever an earlier tile put there
// (so the later of two overlapping tiles wins where it has data). Returns how many it copied.
function copySource(lattice, W, H, t, c0, r0) {
  const ca = Math.max(0, c0), cb = Math.min(t.width, c0 + W), ra = Math.max(0, r0), rb = Math.min(t.height, r0 + H);
  let copied = 0;
  for (let r = ra; r < rb; r += 512) {
    const rows = Math.min(512, rb - r);
    const win = t.readWindow(ca, r, cb - ca, rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cb - ca; x++) {
        const v = win[y * (cb - ca) + x];
        if (v === t.nodata || !Number.isFinite(v)) continue;
        lattice[(r + y - r0) * W + (ca + x - c0)] = v;
        copied++;
      }
    }
  }
  return copied;
}
// { missing (pixels no tile filled), lo, hi } of a lattice
function completeness(lattice) {
  let missing = 0, lo = Infinity, hi = -Infinity;
  for (const v of lattice) {
    if (Number.isNaN(v)) missing++;
    else { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  return { missing, lo, hi };
}

// { lattice: Float32Array, W, H, X0, Y1, sources, lo, hi } over the bundle rectangle padded by `pad` metres
function loadUsgsLattice({ usgsDir, prov, pad = 0, log = () => {} }) {
  const [E0, N0, E1, N1] = prov.paddedProjectedBounds;
  const X0 = E0 - pad, X1 = E1 + pad, Y0 = N0 - pad, Y1 = N1 + pad;
  const W = X1 - X0, H = Y1 - Y0;
  const sources = prov.sourceInputs.map((s) => {
    const file = path.join(usgsDir, s.name);
    if (!fs.existsSync(file)) throw new Error(`${file} missing: download ${s.url} (${s.bytes} bytes, sha256 ${s.sha256})`);
    const bytes = fs.statSync(file).size;
    if (bytes !== s.bytes) throw new Error(`${s.name}: ${bytes} bytes, the provenance says ${s.bytes}: stop, do not substitute data`);
    const sha = sha256File(file);
    if (sha !== s.sha256) throw new Error(`${s.name}: sha256 ${sha}, the provenance says ${s.sha256}: stop, do not substitute data`);
    log(`${s.name}: ${bytes} bytes, sha256 ${sha} (matches)`);
    return { ...s, file };
  });
  const lattice = new Float32Array(W * H).fill(NaN);
  for (const s of sources) {
    const t = openTiff(s.file);
    const [sx, sy] = t.scale, [, , , ex, ny] = t.tie;
    if (sx !== 1 || sy !== 1) throw new Error(`${s.name}: pixel ${sx} x ${sy} m`);
    if (ex !== s.transform[2] || ny !== s.transform[5]) throw new Error(`${s.name}: tie point ${ex}, ${ny} is not the provenance transform`);
    const c0 = Math.floor(X0 + 0.5 - ex), r0 = Math.floor(ny - (Y1 - 0.5));
    const copied = copySource(lattice, W, H, t, c0, r0);
    log(`${s.name}: ${copied} valid samples into the lattice, encoded lattice shift ${(X0 + 0.5 - ex - c0 - 0.5).toExponential(3)} m E, ${(ny - (Y1 - 0.5) - r0 - 0.5).toExponential(3)} m N`);
    t.close();
  }
  const { missing, lo, hi } = completeness(lattice);
  if (missing) throw new Error(`${missing} reference pixels have no valid source sample: stop (no nodata fill)`);
  log(`lattice ${W} x ${H}, every pixel valid, ${lo.toFixed(3)}-${hi.toFixed(3)} m NAVD88`);
  return { lattice, W, H, X0, Y1, sources, lo, hi };
}

export { loadUsgsLattice, copySource, completeness, sha256File };
