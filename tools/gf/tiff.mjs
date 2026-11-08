// tools/gf/tiff.mjs — a minimal GeoTIFF reader for the terrain generators (no dependencies): little-endian, tiled,
// one float32 band, Deflate (8 / 32946) or LZW (5) compression, horizontal (2) or floating-point (3) predictor. That
// is what the USGS 3DEP 1 m tiles and the CC-005b terrain bundle use; anything else throws rather than guesses.
import fs from 'node:fs';
import zlib from 'node:zlib';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

// TIFF LZW (MSB-first codes, 9-12 bits, early change), as libtiff writes it
function lzwDecode(input, expected) {
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096), last = new Uint8Array(4096), first = new Uint8Array(4096), len = new Int32Array(4096);
  for (let c = 0; c < 256; c++) { prefix[c] = -1; last[c] = first[c] = c; len[c] = 1; }
  let pos = 0, dictLen = 258, width = 9, bitPos = 0, prev = -1;
  const bits = input.length * 8;
  // Writes code's string at pos (backwards from its end), returns its length
  const write = (code) => {
    const n = len[code];
    if (pos + n > expected) throw new Error('LZW: output overflow');
    for (let c = code, k = pos + n - 1; c >= 0; c = prefix[c], k--) out[k] = last[c];
    pos += n;
    return n;
  };
  for (;;) {
    if (bitPos + width > bits) break;
    let code = 0;
    for (let i = 0; i < width; i++, bitPos++) code = (code << 1) | ((input[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
    if (code === 257) break;
    if (code === 256) { dictLen = 258; width = 9; prev = -1; continue; }
    if (prev < 0) {
      if (code > 255) throw new Error(`LZW: bad first code ${code}`);
      write(code);
      prev = code;
      continue;
    }
    if (code < dictLen) {
      write(code);
      prefix[dictLen] = prev; last[dictLen] = first[code]; first[dictLen] = first[prev]; len[dictLen] = len[prev] + 1;
    } else if (code === dictLen) {
      prefix[dictLen] = prev; last[dictLen] = first[prev]; first[dictLen] = first[prev]; len[dictLen] = len[prev] + 1;
      write(code);
    } else throw new Error(`LZW: bad code ${code}`);
    dictLen++;
    prev = code;
    if (dictLen + 1 >= (1 << width) && width < 12) width++;
  }
  if (pos !== expected) throw new Error(`LZW: ${pos} bytes decoded, ${expected} expected`);
  return out;
}

// Undo the predictor on one decoded tile (rows of `w` float32 samples), in place, into float32s
function unpredict(bytes, w, h, predictor) {
  const out = new Float32Array(w * h);
  const view = new DataView(out.buffer);
  if (predictor === 3) {
    // Floating point: per row, the bytes are split into planes (most significant first), byte-differenced
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      const o = y * row;
      for (let i = 1; i < row; i++) bytes[o + i] = (bytes[o + i] + bytes[o + i - 1]) & 255;
      for (let x = 0; x < w; x++) {
        view.setUint8((y * w + x) * 4 + 3, bytes[o + x]);
        view.setUint8((y * w + x) * 4 + 2, bytes[o + w + x]);
        view.setUint8((y * w + x) * 4 + 1, bytes[o + 2 * w + x]);
        view.setUint8((y * w + x) * 4 + 0, bytes[o + 3 * w + x]);
      }
    }
    return out;
  }
  const src = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < w * h; i++) out[i] = src.getFloat32(i * 4, true);
  if (predictor === 2) throw new Error('TIFF: horizontal predictor on float data is not supported');
  return out;
}

// { width, height, tileW, tileH, scale: [sx, sy], tie: [i, j, k, x, y, z], nodata, readWindow(col0, row0, w, h) }
function openTiff(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const read = (off, len) => {
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, off);
    return b;
  };
  const head = read(0, 8);
  if (head.toString('latin1', 0, 2) !== 'II' || head.readUInt16LE(2) !== 42) throw new Error(`${file}: not a little-endian classic TIFF`);
  const ifd = head.readUInt32LE(4);
  const n = read(ifd, 2).readUInt16LE(0);
  const entries = read(ifd + 2, n * 12);
  const tags = {};
  for (let k = 0; k < n; k++) {
    const e = entries.subarray(k * 12, k * 12 + 12);
    const tag = e.readUInt16LE(0), type = e.readUInt16LE(2), count = e.readUInt32LE(4);
    const bytes = TYPE_SIZE[type] * count;
    const data = bytes <= 4 ? e.subarray(8, 8 + bytes) : read(e.readUInt32LE(8), bytes);
    const vals = [];
    for (let i = 0; i < count; i++) {
      const o = i * TYPE_SIZE[type];
      if (type === 3) vals.push(data.readUInt16LE(o));
      else if (type === 4) vals.push(data.readUInt32LE(o));
      else if (type === 12) vals.push(data.readDoubleLE(o));
      else if (type === 16) vals.push(Number(data.readBigUInt64LE(o)));
      else if (type === 1 || type === 7) vals.push(data[o]);
    }
    tags[tag] = type === 2 ? data.toString('latin1').replace(/\0+$/, '') : vals;
  }
  const one = (t, d) => (tags[t] ? tags[t][0] : d);
  const width = one(256), height = one(257), bits = one(258), compression = one(259, 1), predictor = one(317, 1);
  const spp = one(277, 1), format = one(339, 1), planar = one(284, 1);
  if (bits !== 32 || format !== 3 || spp !== 1) throw new Error(`${file}: not one float32 band (bits ${bits}, format ${format}, samples ${spp})`);
  if (planar !== 1 && spp !== 1) throw new Error(`${file}: planar configuration ${planar}`); // one band: 1 and 2 are the same layout
  if (!tags[322]) throw new Error(`${file}: not tiled`);
  if (![1, 5, 8, 32946].includes(compression)) throw new Error(`${file}: compression ${compression}`);
  const tileW = one(322), tileH = one(323), offsets = tags[324], counts = tags[325];
  const across = Math.ceil(width / tileW);
  const scale = tags[33550], tie = tags[33922];
  const nodata = tags[42113] !== undefined ? Number(tags[42113]) : null;
  const cache = new Map();
  function tile(t) {
    if (cache.has(t)) return cache.get(t);
    const raw = read(offsets[t], counts[t]);
    const expected = tileW * tileH * 4;
    let bytes;
    if (compression === 1) bytes = new Uint8Array(raw);
    else if (compression === 5) bytes = lzwDecode(raw, expected);
    else bytes = new Uint8Array(zlib.inflateSync(raw));
    if (bytes.length !== expected) throw new Error(`${file}: tile ${t} decoded to ${bytes.length} bytes, not ${expected}`);
    const data = unpredict(bytes, tileW, tileH, predictor);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    cache.set(t, data);
    return data;
  }
  // Float32Array of the pixel window (col0, row0, w, h); pixels outside the image throw
  function readWindow(col0, row0, w, h) {
    if (col0 < 0 || row0 < 0 || col0 + w > width || row0 + h > height) throw new Error(`${file}: window ${col0},${row0} ${w}x${h} outside ${width}x${height}`);
    const out = new Float32Array(w * h);
    for (let ty = Math.floor(row0 / tileH); ty <= Math.floor((row0 + h - 1) / tileH); ty++) {
      for (let tx = Math.floor(col0 / tileW); tx <= Math.floor((col0 + w - 1) / tileW); tx++) {
        const data = tile(ty * across + tx);
        const y0 = Math.max(row0, ty * tileH), y1 = Math.min(row0 + h, (ty + 1) * tileH);
        const x0 = Math.max(col0, tx * tileW), x1 = Math.min(col0 + w, (tx + 1) * tileW);
        for (let y = y0; y < y1; y++) {
          const src = (y - ty * tileH) * tileW + (x0 - tx * tileW);
          out.set(data.subarray(src, src + (x1 - x0)), (y - row0) * w + (x0 - col0));
        }
      }
    }
    return out;
  }
  return { file, size, width, height, tileW, tileH, compression, predictor, scale, tie, nodata, tags, readWindow, close: () => fs.closeSync(fd) };
}

export { openTiff, lzwDecode };
