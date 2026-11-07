import { lonLatToUtm, utmToLonLat, localFrame } from './gf-utm.js';

// Glens Falls bare-earth terrain (CC-005b): the USGS 3DEP 1 m DEM (NY_Hudson_D22, flown 2022-23, NAVD88/GEOID18 metres,
// encoded EPSG:26918) as one deterministic surface, from the data js/gf-terrain.bin.gz holds (written by
// tools/gf/build-gf-terrain.mjs from the frozen CC-005b inputs). No three.js, so the game, the mesher and the Node tests
// all ask the same function.
//
// THE SURFACE. The play area is a lattice of 1 m nodes at the source's own UTM pixel centres (E = 606980.5 + i,
// N = 4798419.5 - j). A node's height is the native 1 m source value (to the residual step, 1 cm) where the CC-005b
// refinement patches hold one and its 8 m tile has a sample the 2 m reconstruction misses by more than patches.keep
// (0.25 m, the bundle's own selection threshold); everywhere else it is the bilinear reconstruction of the 2 m
// candidate (the source's 2 x 2 means). So no node is more than about 0.25 m off its source pixel. Between nodes the
// surface is linear on two triangles per 1 m cell (diagonal from the north-west node to the south-east one), exactly
// what the nearest mesh level draws (gf-terrain-mesh.js), so what is drawn there is what is stood on. Outside the
// lattice a coarse 8 m ring (8 x 8 means of the same source) reaches 426 m further, blended in over 24 m so the surface
// stays continuous; beyond the ring there is no terrain (valid: false), never a flat fill.
//
// GAME HEIGHT. y = NAVD88 - ANCHOR: the sourced anchor is OSM node 221400851, the shared Glen Street / Bay Street /
// South Street node, whose bilinear 1 m bare-earth sample is 104.788276672 m NAVD88 (not a surveyed road-deck
// benchmark). Relative relief is the source's; x and z stay the gf-geodata.js frame unchanged.

const MAGIC = 0x31544647; // 'GFT1'

// LOCO-I's median edge detector: the prediction of a grid value from its west (a), north (b) and north-west (c)
const med = (a, b, c) => (c >= Math.max(a, b) ? Math.min(a, b) : c <= Math.min(a, b) ? Math.max(a, b) : a + b - c);
// Grid coding shared with tools/gf/build-gf-terrain.mjs: uint16 values (row-major) minus their MED predictions, mod
// 2^16, written as a plane of low bytes then a plane of high bytes (gzip packs terrain best that way)
function encodeGrid(q, cols, rows) {
  const n = q.length, out = new Uint8Array(n * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const a = c ? q[k - 1] : r ? q[k - cols] : 0, b = r ? q[k - cols] : a, d = r && c ? q[k - cols - 1] : r ? b : a;
      const e = (q[k] - med(a, b, d)) & 0xffff;
      out[k] = e & 255;
      out[n + k] = e >> 8;
    }
  }
  return out;
}
function decodeGrid(bytes, cols, rows) {
  const n = cols * rows, q = new Uint16Array(n);
  if (bytes.length !== n * 2) throw new Error('gf-terrain: grid size');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const a = c ? q[k - 1] : r ? q[k - cols] : 0, b = r ? q[k - cols] : a, d = r && c ? q[k - cols - 1] : r ? b : a;
      q[k] = (med(a, b, d) + (bytes[k] | (bytes[n + k] << 8))) & 0xffff;
    }
  }
  return q;
}

// { header, base: Uint16Array, residual: Int16Array, tiles: Int32Array, ring: Uint16Array } of the (inflated) bytes
function decodeTerrain(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error('gf-terrain: not GFT1 data');
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  const sec = Object.fromEntries(header.sections.map((s) => [s.name, s]));
  const at = (name) => {
    const s = sec[name];
    if (!s) throw new Error(`gf-terrain: no ${name} section`);
    const start = 8 + headerLen + s.offset;
    if (start + s.bytes > bytes.byteLength) throw new Error(`gf-terrain: section ${name} out of range`);
    return bytes.subarray(start, start + s.bytes);
  };
  const T = header.patches.tile;
  const base = decodeGrid(at('base'), header.base.cols, header.base.rows);
  const ring = decodeGrid(at('ring'), header.ring.cols, header.ring.rows);
  const tilesBytes = at('tiles');
  const tiles = new Int32Array(tilesBytes.buffer.slice(tilesBytes.byteOffset, tilesBytes.byteOffset + tilesBytes.byteLength));
  // each patch tile is coded as its own T x T grid
  const resBytes = at('residual');
  if (resBytes.length !== tiles.length * T * T * 2) throw new Error('gf-terrain: patch size');
  const residual = new Int16Array(tiles.length * T * T);
  for (let k = 0; k < tiles.length; k++) {
    residual.set(new Int16Array(decodeGrid(resBytes.subarray(k * T * T * 2, (k + 1) * T * T * 2), T, T).buffer), k * T * T);
  }
  return { header, base, residual, tiles, ring };
}

// The surface of decoded data: see the module comment. Every height is game y (NAVD88 - anchor) unless named NAVD88.
function createGfTerrain(data, frame) {
  const { header, base, residual, tiles, ring } = data;
  const { offset: QO, step: QS } = header.quant;
  const RS = header.patches.step;
  const ANCHOR = header.anchor.navd88;
  const B = header.base, L = header.lattice, P = header.patches, R = header.ring;
  const T = P.tile, tilesAcross = Math.ceil(L.cols / T), tilesDown = Math.ceil(L.rows / T);
  const slot = new Int32Array(tilesAcross * tilesDown).fill(-1);
  for (let k = 0; k < tiles.length; k++) slot[tiles[k]] = k;
  const local = localFrame(frame);

  // NAVD88 of the 2 m base, bilinear at a lattice node (i, j), clamped at the base's edges
  const baseAt = (c, r) => QO + QS * base[Math.min(B.rows - 1, Math.max(0, r)) * B.cols + Math.min(B.cols - 1, Math.max(0, c))];
  function baseBilinear(i, j) {
    // node (i, j) is at base fractional index ((E - B.e0) / 2, (B.n0 - N) / 2)
    const u = (L.e0 + i - B.e0) / B.step, v = (B.n0 - (L.n0 - j)) / B.step;
    const c0 = Math.floor(u), r0 = Math.floor(v), fu = u - c0, fv = v - r0;
    const h00 = baseAt(c0, r0), h10 = baseAt(c0 + 1, r0), h01 = baseAt(c0, r0 + 1), h11 = baseAt(c0 + 1, r0 + 1);
    return h00 + (h10 - h00) * fu + (h01 - h00) * fv + (h00 - h10 - h01 + h11) * fu * fv;
  }
  // NAVD88 of lattice node (i, j) (clamped into the lattice), and whether a native 1 m patch holds it
  function nodeNavd(i, j) {
    i = Math.min(L.cols - 1, Math.max(0, i));
    j = Math.min(L.rows - 1, Math.max(0, j));
    const s = slot[Math.floor(j / T) * tilesAcross + Math.floor(i / T)];
    const h = baseBilinear(i, j);
    return s < 0 ? h : h + RS * residual[s * T * T + (j % T) * T + (i % T)];
  }
  const isNative = (i, j) => slot[Math.floor(j / T) * tilesAcross + Math.floor(i / T)] >= 0;
  // NAVD88 on the lattice triangles at UTM (e, n), with (e, n) inside the node hull
  function latticeNavd(e, n) {
    const fi = e - L.e0, fj = L.n0 - n;
    const i = Math.min(L.cols - 2, Math.max(0, Math.floor(fi))), j = Math.min(L.rows - 2, Math.max(0, Math.floor(fj)));
    const fx = fi - i, fy = fj - j;
    const h00 = nodeNavd(i, j), h11 = nodeNavd(i + 1, j + 1);
    if (fx >= fy) return h00 + fx * (nodeNavd(i + 1, j) - h00) + fy * (h11 - nodeNavd(i + 1, j));
    const h01 = nodeNavd(i, j + 1);
    return h00 + fy * (h01 - h00) + fx * (h11 - h01);
  }
  // NAVD88 of the 8 m ring, bilinear, clamped at its edges
  const ringAt = (c, r) => QO + QS * ring[Math.min(R.rows - 1, Math.max(0, r)) * R.cols + Math.min(R.cols - 1, Math.max(0, c))];
  function ringNavd(e, n) {
    const u = (e - R.e0) / R.step, v = (R.n0 - n) / R.step;
    const c0 = Math.floor(u), r0 = Math.floor(v), fu = u - c0, fv = v - r0;
    const h00 = ringAt(c0, r0), h10 = ringAt(c0 + 1, r0), h01 = ringAt(c0, r0 + 1), h11 = ringAt(c0 + 1, r0 + 1);
    return h00 + (h10 - h00) * fu + (h01 - h00) * fv + (h00 - h10 - h01 + h11) * fu * fv;
  }
  const hull = { e0: L.e0, e1: L.e0 + L.cols - 1, n0: L.n0 - (L.rows - 1), n1: L.n0 };
  const ringBox = { e0: R.e0 - R.step / 2, e1: R.e0 + (R.cols - 0.5) * R.step, n0: R.n0 - (R.rows - 0.5) * R.step, n1: R.n0 + R.step / 2 };

  // { navd, source, valid } at UTM (e, n)
  function sampleUtm(e, n) {
    if (e >= hull.e0 && e <= hull.e1 && n >= hull.n0 && n <= hull.n1) {
      const i = Math.floor(e - L.e0), j = Math.floor(L.n0 - n);
      return { navd: latticeNavd(e, n), source: isNative(Math.min(L.cols - 1, i), Math.min(L.rows - 1, j)) ? 'native-1m' : 'base-2m', valid: true };
    }
    if (!(e >= ringBox.e0 && e <= ringBox.e1 && n >= ringBox.n0 && n <= ringBox.n1)) return { navd: NaN, source: 'outside', valid: false };
    const ce = Math.min(hull.e1, Math.max(hull.e0, e)), cn = Math.min(hull.n1, Math.max(hull.n0, n));
    const d = Math.hypot(e - ce, n - cn);
    const ringH = ringNavd(e, n);
    if (d >= R.blend) return { navd: ringH, source: 'ring-8m', valid: true };
    const w = d / R.blend;
    return { navd: latticeNavd(ce, cn) * (1 - w) + ringH * w, source: 'blend', valid: true };
  }

  const toUtm = (x, z) => {
    const [lon, lat] = local.toLonLat(x, z);
    return lonLatToUtm(lon, lat);
  };
  const fromUtm = (e, n) => {
    const [lon, lat] = utmToLonLat(e, n);
    return local.toLocal(lon, lat);
  };

  // Game y of the bare earth at local (x, z); NaN outside the terrain
  function heightAt(x, z) {
    const [e, n] = toUtm(x, z);
    const s = sampleUtm(e, n);
    return s.valid ? s.navd - ANCHOR : NaN;
  }
  // The smoothed unit normal at (x, z) (central differences r metres either side), into out = { x, y, z }
  function normalAt(x, z, out = { x: 0, y: 1, z: 0 }, r = 1) {
    const hx = (heightAt(x + r, z) - heightAt(x - r, z)) / (2 * r);
    const hz = (heightAt(x, z + r) - heightAt(x, z - r)) / (2 * r);
    const l = Math.hypot(hx, 1, hz);
    if (!Number.isFinite(l)) { out.x = 0; out.y = 1; out.z = 0; return out; }
    out.x = -hx / l; out.y = 1 / l; out.z = -hz / l;
    return out;
  }
  // Everything known about the ground at (x, z): game y, NAVD88, normal, slope (rise over run), validity, which input
  // holds it (native-1m, base-2m, blend, ring-8m or outside) and its resolution in metres
  function infoAt(x, z) {
    const [e, n] = toUtm(x, z);
    const s = sampleUtm(e, n);
    const normal = s.valid ? normalAt(x, z) : { x: 0, y: 1, z: 0 };
    return {
      y: s.valid ? s.navd - ANCHOR : NaN, navd88: s.navd, valid: s.valid, source: s.source,
      resolution: { 'native-1m': 1, 'base-2m': 2, blend: 8, 'ring-8m': 8, outside: null }[s.source],
      normal, slope: s.valid ? Math.sqrt(1 - normal.y * normal.y) / normal.y : NaN, utm: [e, n]
    };
  }

  return {
    header, anchor: header.anchor, ANCHOR, hull, ringBox, lattice: L,
    heightAt, normalAt, infoAt, sampleUtm, toUtm, fromUtm,
    // lattice access for the mesher and tests: NAVD88 of node (i, j), and UTM of a node
    nodeNavd, isNative, nodeUtm: (i, j) => [L.e0 + i, L.n0 - j], ringNavd
  };
}

export { decodeTerrain, createGfTerrain, encodeGrid, decodeGrid, MAGIC };
