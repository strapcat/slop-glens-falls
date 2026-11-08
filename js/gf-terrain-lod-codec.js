// The terrain LOD's per-chunk errors (gf-terrain-lod-errors.js, from tools/gf/audit-gf-terrain-mesh.mjs): per level
// 1..8 a row-major grid of (2^(8 - l))^2 chunks, each its largest |drawn - query| at a lattice node in centimetres,
// rounded up (so never under the truth), as little-endian Uint16 in base64. No dependencies (browser and Node).

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < bytes.length ? B64[c & 63] : '=');
  }
  return out;
}
function fromBase64(s) {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0, acc = 0, k = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[k++] = (acc >> bits) & 255; }
  }
  return out;
}

// errors: [null, Float64Array (level 1), ..., (level 8)] in metres -> { unit, levels: [base64 per level 1..8] }
function encodeLodErrors(errors) {
  const levels = errors.slice(1).map((t) => {
    const cm = new Uint16Array(t.length);
    for (let i = 0; i < t.length; i++) cm[i] = Math.min(65535, Math.ceil(t[i] * 100 - 1e-9));
    const bytes = new Uint8Array(cm.length * 2);
    for (let i = 0; i < cm.length; i++) { bytes[2 * i] = cm[i] & 255; bytes[2 * i + 1] = cm[i] >> 8; }
    return toBase64(bytes);
  });
  return { unit: 'cm', levels };
}
// -> [null, Float32Array (level 1, metres), ...]
function decodeLodErrors(encoded) {
  return [null, ...encoded.levels.map((s) => {
    const bytes = fromBase64(s), out = new Float32Array(bytes.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (bytes[2 * i] | (bytes[2 * i + 1] << 8)) / 100;
    return out;
  })];
}

export { encodeLodErrors, decodeLodErrors };
