import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeTerrain, createGfTerrain, encodeGrid, decodeGrid } from '../js/gf-terrain.js';
import { lonLatToUtm, utmToLonLat, localFrame } from '../js/gf-utm.js';
import { createGfSurface, DECK_MARGIN } from '../js/gf-surface.js';
import { drapeRoads, DRAPE_TOL, ROAD_LIFT } from '../js/gf-drape.js';
import { gfBuildingsOnTerrain } from '../js/gf-building-bases.js';
import { placeGfTrees } from '../js/gf-tree-placements.js';
import { createGfBuildingRecords } from '../js/gf-building-records.js';
import { applyGfLandmarks } from '../js/gf-landmark-records.js';
import { applyLidarHeights } from '../js/gf-building-heights.js';
import { GF_GEO } from '../js/gf-geodata.js';
import { GF_BRIDGES } from '../js/gf-bridges.js';
import { GF_BUILDINGS } from '../js/gf-buildings.js';
import { GF_LANDMARKS } from '../js/gf-landmarks.js';
import { GF_LIDAR_HEIGHTS } from '../js/gf-lidar-heights.js';
import { GF_TREES } from '../js/gf-trees.js';
import { toLocal } from '../tools/gf/geo-frame.mjs';
import { buildTerrain, readInputs, PATCH_KEEP } from '../tools/gf/build-gf-terrain.mjs';
import { buildGfBridges } from '../tools/gf/build-gf-bridges.mjs';
import { openTiff, lzwDecode } from '../tools/gf/tiff.mjs';
import { copySource, completeness } from '../tools/gf/usgs-lattice.mjs';

// CC-005b: the sourced Glens Falls terrain, its one surface contract and what stands on it

const root = fileURLToPath(new URL('..', import.meta.url));
const DATA = path.join(root, 'tools/gf/data/terrain');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const payload = zlib.gunzipSync(fs.readFileSync(path.join(root, 'js/gf-terrain.bin.gz')));
const data = decodeTerrain(new Uint8Array(payload));
const T = createGfTerrain(data, GF_GEO.frame);
const S = createGfSurface({ terrain: T, geo: GF_GEO, bridges: GF_BRIDGES });
const prov = JSON.parse(fs.readFileSync(path.join(DATA, 'terrain-provenance-and-validation.json'), 'utf8'));

test('frozen inputs: both bundle manifests verify, and the provenance is the one the bundle shipped', () => {
  for (const [list, rename] of [['SHA256SUMS', {}], ['DETAIL-SHA256SUMS', { 'README.md': 'DETAIL-README.md' }]]) {
    for (const line of fs.readFileSync(path.join(DATA, list), 'utf8').trim().split('\n')) {
      const [hash, name] = line.trim().split(/\s+\*?/);
      assert.equal(sha(fs.readFileSync(path.join(DATA, rename[name] || name))), hash, `${list}: ${name}`);
    }
  }
  assert.deepEqual(prov.paddedProjectedBounds, [606980, 4793840, 612800, 4798420]);
  assert.equal(prov.coverage.missingPixelsInPaddedProjectedRectangle, 0);
  assert.equal(prov.anchor.osmNode, 221400851);
  assert.equal(prov.anchor.demNAVD88M, 104.78827667236328);
  // the originals' hashes (checked against the tiles by tools/gf/prepare-gf-terrain.mjs, which proved the bundle
  // candidate and patches equal the originals' lattice, every pixel)
  const prep = JSON.parse(fs.readFileSync(path.join(DATA, 'gf_terrain_prepare.json'), 'utf8'));
  assert.deepEqual(prep.sources.map((s) => s.sha256), prov.sourceInputs.map((s) => s.sha256));
  assert.equal(prep.frozenInputsCheck.candidate.equal, prep.frozenInputsCheck.candidate.pixels);
  assert.equal(prep.frozenInputsCheck.patches.equal, prep.frozenInputsCheck.patches.validPixels);
  assert.equal(prep.lattice.missing, 0);
  assert.equal(sha(fs.readFileSync(path.join(DATA, prep.ring.file))), prep.ring.sha256);
});

test('deterministic: regenerating the terrain and the bridges gives the committed bytes', () => {
  const a = buildTerrain(readInputs()).payload;
  assert.equal(sha(a), sha(payload), 'js/gf-terrain.bin.gz inflates to exactly what build-gf-terrain.mjs makes');
  const osm = JSON.parse(fs.readFileSync(path.join(root, 'tools/gf/data/osm_gf_roads.json'), 'utf8'));
  assert.deepEqual(buildGfBridges(osm, GF_GEO), { bridges: GF_BRIDGES.bridges, ground: GF_BRIDGES.ground });
  // two surfaces from the same data answer the same
  const T2 = createGfTerrain(decodeTerrain(new Uint8Array(payload)), GF_GEO.frame);
  for (let k = 0; k < 500; k++) {
    const x = -2900 + ((k * 7919) % 5600), z = -2250 + ((k * 104729) % 4400);
    assert.equal(T2.heightAt(x, z), T.heightAt(x, z));
  }
});

test('decoded data: the 2 m base is the bundle candidate (to 2.5 mm), the native nodes its 1 m patches (to 1 cm)', () => {
  const { candidate, patches } = readInputs();
  const h = data.header;
  assert.equal(h.quant.step, 0.005);
  assert.equal(h.patches.keep, PATCH_KEEP);
  let worstBase = 0;
  for (let k = 0; k < candidate.values.length; k++) worstBase = Math.max(worstBase, Math.abs(h.quant.offset + h.quant.step * data.base[k] - candidate.values[k]));
  assert.ok(worstBase <= h.quant.step / 2 + 1e-9, `base off by ${worstBase}`);
  let native = 0, worstNative = 0, worstElse = 0;
  for (let j = 0; j < patches.height; j++) {
    for (let i = 0; i < patches.width; i++) {
      const v = patches.values[j * patches.width + i];
      if (v === patches.nodata) continue;
      const e = Math.abs(T.nodeNavd(i, j) - v);
      if (T.isNative(i, j)) { native++; worstNative = Math.max(worstNative, e); } else worstElse = Math.max(worstElse, e);
    }
  }
  assert.equal(native, h.patches.nativeNodes);
  assert.ok(worstNative <= 0.0076, `a native node off by ${worstNative}`);
  assert.ok(worstElse <= PATCH_KEEP + 0.003, `a patch sample outside the kept tiles off by ${worstElse}`);
});

test('against the original 1 m source: the bundle audit lattice (10,096 samples) is within 0.25 m, typical ~2 cm', () => {
  const rows = fs.readFileSync(path.join(DATA, 'reference-audit-lattice.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
  const errs = rows.map(([r, c, ref]) => Math.abs(T.nodeNavd(c, r) - ref)).sort((a, b) => a - b);
  assert.equal(errs.length, 10096);
  assert.ok(errs[errs.length - 1] <= 0.25, `max ${errs[errs.length - 1]}`);
  assert.ok(errs.reduce((a, b) => a + b, 0) / errs.length < 0.02);
  assert.ok(errs[Math.floor(errs.length * 0.95)] < 0.07);
  // and the full audit's figures (tools/gf/audit-gf-terrain.mjs, every pixel of the target)
  const audit = JSON.parse(fs.readFileSync(path.join(DATA, 'gf_terrain_audit.json'), 'utf8'));
  assert.equal(audit.targetPixels, 25224904);
  assert.ok(audit.query.all.maxM <= 0.25 && audit.query.all.over0_25M === 0);
  // the bundle's hill reference crop is the source, pixel for pixel; the game surface there is not (base-2 m nodes
  // within the 0.25 m keep threshold): about 2 cm typical, ~0.249 m at worst
  assert.equal(audit.hillCrop.equalToSource, audit.hillCrop.pixels);
  assert.ok(audit.query.hill.maxM > 0.2 && audit.query.hill.maxM < 0.25 && audit.query.hill.maeM < 0.025);
  // each subset's worst list holds its true largest errors (largest first; the first is the maximum), whatever their size
  for (const k of ['all', 'roads', 'banks', 'decks', 'hill']) {
    const q = audit.query[k];
    assert.equal(q.worst.length, 10, k);
    assert.ok(Math.abs(q.worst[0].errorM - q.maxM) < 1e-4, `${k}: worst ${q.worst[0].errorM} vs max ${q.maxM}`);
    for (let i = 1; i < q.worst.length; i++) assert.ok(q.worst[i].errorM <= q.worst[i - 1].errorM, k);
  }
  // the hill's worst, checked against the crop itself (the source there): the surface's node minus the crop's pixel
  const hill = openTiff(path.join(DATA, 'thrill-hill-reference-dem-1m.tif'));
  const c0 = Math.round(hill.tie[3] - (T.lattice.e0 - 0.5)), r0 = Math.round(T.lattice.n0 + 0.5 - hill.tie[4]);
  for (const w of audit.query.hill.worst) {
    const ref = hill.readWindow(w.col - c0, w.row - r0, 1, 1)[0];
    assert.ok(Math.abs(Math.abs(T.nodeNavd(w.col, w.row) - ref) - w.errorM) < 1e-4, JSON.stringify(w));
    assert.ok(w.on.includes('hill'));
  }
});

test('the surface: anchor, axes, pixel centres, triangles, edges and outside', () => {
  const [ax, az] = toLocal(-73.6464714, 43.3108659);
  assert.ok(Math.abs(T.heightAt(ax, az)) < 0.005, 'the anchor node is at y ~ 0');
  assert.equal(T.ANCHOR, 104.78827667236328);
  // x is east (easting grows), z is south (northing falls)
  const [e0, n0] = T.toUtm(0, 0), [e1] = T.toUtm(100, 0), [, n1] = T.toUtm(0, 100);
  assert.ok(e1 - e0 > 99 && n0 - n1 > 99);
  // the lattice node (i, j) is the source pixel centre (606980.5 + i, 4798419.5 - j); the surface there is its value
  for (const [i, j] of [[0, 0], [1234, 2345], [5819, 4579], [3000, 1]]) {
    const [e, n] = T.nodeUtm(i, j);
    assert.deepEqual([e, n], [606980.5 + i, 4798419.5 - j]);
    const [x, z] = T.fromUtm(e, n);
    assert.ok(Math.abs(T.heightAt(x, z) + T.ANCHOR - T.nodeNavd(i, j)) < 1e-6);
  }
  // linear on the cell's two triangles (diagonal north-west to south-east)
  const i = 2000, j = 1500, [e, n] = T.nodeUtm(i, j);
  const h00 = T.nodeNavd(i, j), h10 = T.nodeNavd(i + 1, j), h11 = T.nodeNavd(i + 1, j + 1), h01 = T.nodeNavd(i, j + 1);
  assert.ok(Math.abs(T.sampleUtm(e + 0.75, n - 0.25).navd - (h00 + 0.75 * (h10 - h00) + 0.25 * (h11 - h10))) < 1e-9);
  assert.ok(Math.abs(T.sampleUtm(e + 0.25, n - 0.75).navd - (h00 + 0.75 * (h01 - h00) + 0.25 * (h11 - h01))) < 1e-9);
  // every height is a real terrain height: no nodata sentinel anywhere, within the source's range
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 20000; k++) {
    const y = T.heightAt(-3300 + ((k * 7919) % 6400), -2700 + ((k * 104729) % 5300));
    if (Number.isFinite(y)) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
  }
  assert.ok(lo > 21.8 - T.ANCHOR - 0.01 && hi < 146 - T.ANCHOR, `${lo}..${hi}`);
  // the ring reaches ~426 m beyond the bundle rectangle; beyond that there is no terrain (never a flat fill)
  assert.equal(T.infoAt(-2920 - 300, 0).source, 'ring-8m');
  assert.ok(Number.isFinite(T.heightAt(-2920 - 300, 0)));
  const far = T.infoAt(-2920 - 900, 0);
  assert.equal(far.valid, false);
  assert.ok(Number.isNaN(far.y));
  assert.equal(S.valid(-2920 - 900, 0), false);
});

test('continuity: no step across a native tile\'s edge, across the lattice edge into the ring, or anywhere on a line', () => {
  // walk a dense line across many native tiles and out of the lattice into the ring: each 0.1 m step changes the
  // height by no more than the steepest slope there allows
  const lines = [[[600, 300], [700, 600]], [[-2900, -1000], [-3250, -1000]], [[2700, 2100], [3100, 2500]], [[180, 280], [300, 540]]];
  for (const [[xa, za], [xb, zb]] of lines) {
    const n = Math.round(Math.hypot(xb - xa, zb - za) / 0.1);
    let prev = T.heightAt(xa, za), worst = 0;
    for (let k = 1; k <= n; k++) {
      const y = T.heightAt(xa + ((xb - xa) * k) / n, za + ((zb - za) * k) / n);
      worst = Math.max(worst, Math.abs(y - prev));
      prev = y;
    }
    assert.ok(worst < 0.5, `a ${worst.toFixed(3)} m jump in 0.1 m on ${xa},${za} -> ${xb},${zb}`);
  }
  // and the line crossing the lattice's west edge goes from the lattice (native 1 m or base 2 m) through the blend to
  // the ring, in that order
  const order = [];
  for (let x = -2900; x > -3250; x -= 2) {
    const s = T.infoAt(x, -1000).source;
    const rank = { 'native-1m': 0, 'base-2m': 0, blend: 1, 'ring-8m': 2 }[s];
    if (order[order.length - 1] !== rank) order.push(rank);
  }
  assert.deepEqual(order, [0, 1, 2]);
});

test('fixtures: TIFF decoding (deflate + float predictor, LZW), axes and pixel centres; source precedence and nodata', () => {
  // a 3 x 2 float32 tiled TIFF, Deflate with the floating point predictor, written here
  const W = 16, H = 16, vals = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) vals[r * W + c] = 100 + c * 0.5 - r * 0.25; // rises east, falls south
  const bytes = new Uint8Array(vals.buffer.slice(0));
  const planes = new Uint8Array(W * H * 4);
  for (let r = 0; r < H; r++) {
    const row = new Uint8Array(W * 4);
    for (let c = 0; c < W; c++) for (let b = 0; b < 4; b++) row[b * W + c] = bytes[(r * W + c) * 4 + 3 - b];
    for (let k = row.length - 1; k > 0; k--) row[k] = (row[k] - row[k - 1]) & 255;
    planes.set(row, r * W * 4);
  }
  const tile = zlib.deflateSync(planes);
  const tags = [[256, 3, 1, W], [257, 3, 1, H], [258, 3, 1, 32], [259, 3, 1, 8], [277, 3, 1, 1], [284, 3, 1, 1], [317, 3, 1, 3],
    [322, 3, 1, W], [323, 3, 1, H], [324, 4, 1, 0], [325, 4, 1, tile.length], [339, 3, 1, 3]];
  const ifd = 8, dataAt = ifd + 2 + tags.length * 12 + 4;
  const buf = Buffer.alloc(dataAt + tile.length);
  buf.write('II', 0, 'latin1'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifd, 4); buf.writeUInt16LE(tags.length, ifd);
  tags.forEach(([tag, type, count, value], k) => {
    const o = ifd + 2 + k * 12;
    buf.writeUInt16LE(tag, o); buf.writeUInt16LE(type, o + 2); buf.writeUInt32LE(count, o + 4);
    if (type === 3) buf.writeUInt16LE(value, o + 8); else buf.writeUInt32LE(tag === 324 ? dataAt : value, o + 8);
  });
  Buffer.from(tile).copy(buf, dataAt);
  const file = path.join(os.tmpdir(), `gf-terrain-fixture-${process.pid}.tif`);
  fs.writeFileSync(file, buf);
  const t = openTiff(file);
  assert.deepEqual(Array.from(t.readWindow(2, 3, 3, 2)), [101 - 0.75, 101.5 - 0.75, 102 - 0.75, 101 - 1, 101.5 - 1, 102 - 1], 'row 0 is the north row, column 0 the west');
  t.close();
  fs.unlinkSync(file);
  // TIFF LZW: "TOBEORNOTTOBEORTOBEORNOT"-style repeats decode exactly
  const text = Buffer.from('ABABABABABAB');
  const codes = [256, 65, 66, 258, 260, 259, 262, 257]; // clear, A, B, AB, ABA, BA, BAB, eoi (9-bit, MSB first)
  let bits = '';
  for (const c of codes) bits += c.toString(2).padStart(9, '0');
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  for (let k = 0; k < bits.length; k++) if (bits[k] === '1') packed[k >> 3] |= 128 >> (k & 7);
  assert.equal(Buffer.from(lzwDecode(packed, text.length)).toString(), text.toString());
  // two overlapping source tiles into one lattice: the later wins where it has data, never with its nodata
  const fake = (w, h, f, nodata = -999999) => ({ width: w, height: h, nodata, readWindow: (c0, r0, ww, hh) => {
    const out = new Float32Array(ww * hh);
    for (let r = 0; r < hh; r++) for (let c = 0; c < ww; c++) out[r * ww + c] = f(c0 + c, r0 + r);
    return out;
  } });
  const lat = new Float32Array(6 * 2).fill(NaN);
  copySource(lat, 6, 2, fake(4, 2, () => 10), 0, 0); // covers columns 0-3
  copySource(lat, 6, 2, fake(4, 2, (c) => (c === 1 ? -999999 : 20)), -2, 0); // its columns 0-3 land on 2-5; its 1 is nodata
  assert.deepEqual(Array.from(lat.slice(0, 6)), [10, 10, 20, 10, 20, 20]);
  assert.equal(completeness(lat).missing, 0);
  const gap = new Float32Array(4).fill(NaN);
  copySource(gap, 4, 1, fake(4, 1, (c) => (c === 2 ? -999999 : 5)), 0, 0);
  assert.equal(completeness(gap).missing, 1, 'a nodata hole stays a hole (the generators then stop), never zero ground');
  // the grid codec round trips
  const q = new Uint16Array(64 * 3).map((_, k) => (k * 7919) & 0xffff);
  assert.deepEqual(Array.from(decodeGrid(encodeGrid(q, 64, 3), 64, 3)), Array.from(q));
});

test('projection: UTM 18N matches the bundle (pyproj) anchor, and the local frame is gf-geodata.js\'s', () => {
  const [e, n] = lonLatToUtm(prov.anchor.lon, prov.anchor.lat);
  assert.ok(Math.abs(e - prov.anchor.utmE) < 1e-6 && Math.abs(n - prov.anchor.utmN) < 1e-6);
  const [lon, lat] = utmToLonLat(e, n);
  assert.ok(Math.abs(lon - prov.anchor.lon) < 1e-11 && Math.abs(lat - prov.anchor.lat) < 1e-11);
  for (const w of prov.candidateErrorVs1m.worstLocations.slice(0, 5)) {
    const [lo, la] = utmToLonLat(606980 + w.col + 0.5, 4798420 - w.row - 0.5);
    assert.ok(Math.abs(lo - w.lon) < 1e-10 && Math.abs(la - w.lat) < 1e-10);
  }
  const f = localFrame(GF_GEO.frame);
  assert.deepEqual(f.toLocal(-73.6464714, 43.3108659), toLocal(-73.6464714, 43.3108659));
});

test('surface contract: ground, decks over the river, support by height, roads by heading, water, info', () => {
  // decks: 16 chains of the 17 OSM bridge ways, meeting the ground at both abutments, never below it
  assert.equal(S.decks.length, 16);
  const coopers = S.decks.find((d) => d.name === "Cooper's Cave Bridge");
  assert.deepEqual(coopers.osm.sort(), [20629957, 38389552]);
  for (const d of S.decks) {
    for (const [x, z] of d.ends) assert.ok(Math.abs(S.deckAt(x, z).y - S.ground(x, z)) < 0.02, `${d.name} meets the ground at its ends`);
    for (const c of d.segments) {
      for (let t = 0.05; t < 1; t += 0.1) {
        const x = c.from[0] + (c.to[0] - c.from[0]) * t, z = c.from[1] + (c.to[1] - c.from[1]) * t;
        assert.ok(S.deckAt(x, z).y >= S.ground(x, z) - 1e-9);
      }
    }
  }
  // Cooper's Cave Bridge spans the gorge ~20 m above the water below the falls
  const mid = [237, 411];
  const deck = S.deckAt(...mid);
  assert.ok(deck && deck.deck === coopers);
  assert.ok(deck.y - S.ground(...mid) > 10, 'the deck is not draped into the river');
  // support: on the deck from the deck, on the ground from below it; unknown height: the highest
  const g = S.ground(...mid);
  assert.equal(S.support(...mid, deck.y), deck.y);
  assert.equal(S.support(...mid, g), g);
  assert.equal(S.support(...mid, NaN), deck.y);
  // road: along the deck its deck, across it (a road passing under) the ground
  const [ux, uz] = [deck.dirX, deck.dirZ];
  assert.equal(S.road(...mid, ux, uz), deck.y);
  assert.equal(S.road(...mid, -uz, ux), g);
  // the Northway's bridges: the road beneath keeps its ground, the deck stays over it
  const nw = S.decks.find((d) => d.osm.includes(34366580));
  const nwMid = [(nw.ends[0][0] + nw.ends[1][0]) / 2, (nw.ends[0][1] + nw.ends[1][1]) / 2];
  assert.ok(S.deckAt(...nwMid).y - S.ground(...nwMid) > 4);
  // the deck corridor is the road's width plus its sidewalks
  assert.equal(DECK_MARGIN, 2);
  // water: the reservoir pool is flat at its hydro-flattened level; graded reaches never stand above the ground
  const reservoir = S.water.bodies.find((b) => b.kind === 'reservoir' && b.type === 'flat' && b.stats.samples > 10000);
  assert.ok(Math.abs(reservoir.level - -23.01) < 0.05);
  // a graded body's level is the DEM itself on its flattened cells, and its drawn surface (the lower of its level and
  // the ground) never stands above the ground: it cannot climb a bank
  let flatCells = 0;
  for (const b of S.water.bodies.filter((w) => w.type === 'graded')) {
    const { x0, z0, step, cols, rows, level } = b.grid;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const x = x0 + c * step, z = z0 + r * step, g = S.ground(x, z);
        const near = [S.ground(x + step, z), S.ground(x - step, z), S.ground(x, z + step), S.ground(x, z - step)];
        if (Math.hypot(near[0] - near[1], near[2] - near[3]) / (2 * step) < 0.02 && Number.isFinite(level[r * cols + c])) {
          if (Math.abs(level[r * cols + c] - g) < 1e-6) flatCells++;
        }
        const l = S.water.levelOf(b, x, z);
        assert.ok((Number.isFinite(l) ? Math.min(l, g) : g) <= g);
      }
    }
  }
  assert.ok(flatCells > 1000, `${flatCells} flattened cells at their own DEM level`);
  assert.equal(S.water.surfaceAt(-200.5, -151.7), null, 'no water downtown');
  const info = S.info(...mid);
  for (const k of ['ground', 'valid', 'normal', 'slope', 'source', 'resolution', 'navd88', 'deck', 'water']) assert.ok(k in info, k);
  assert.equal(info.deck.name, "Cooper's Cave Bridge");
});

test('CC-005c consumption: a prop placed with support() and normal() stands on the surface every consumer uses', () => {
  // the minimal example the README gives: a picnic table at a point of the hill crop, on the ground, upright or tilted
  const [x, z] = [-2200, -1500];
  const y = S.support(x, z);
  const n = S.normal(x, z);
  assert.ok(Number.isFinite(y) && n.y > 0.5);
  assert.equal(y, S.ground(x, z), 'off any deck, support is the bare earth');
  assert.equal(S.info(x, z).source.startsWith('native') || S.info(x, z).source === 'base-2m', true);
  // its four feet 0.8 m out land on the same surface (no second terrain to disagree with)
  for (const [dx, dz] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) assert.ok(Math.abs(S.support(x + dx, z + dz) - T.heightAt(x + dx, z + dz)) < 1e-12);
});

test('buildings on the terrain: heights unchanged and above a documented base; roofs level; features keep their meaning', () => {
  const lidar = applyLidarHeights(GF_BUILDINGS, GF_LIDAR_HEIGHTS).data;
  const flat = applyGfLandmarks(createGfBuildingRecords(lidar), GF_LANDMARKS);
  const on = gfBuildingsOnTerrain(lidar, GF_LANDMARKS, S.ground);
  assert.equal(on.records.length, flat.records.length);
  on.records.forEach((r, i) => {
    const f = flat.records[i];
    assert.equal(r.height, f.height);
    assert.equal(r.src, f.src);
    assert.equal(r.style, f.style);
    assert.ok(Number.isFinite(r.base) && r.foundation <= r.base && r.burial >= 0 && r.exposed >= 0);
    assert.deepEqual([on.colliders[i].minY, on.colliders[i].maxY], [r.foundation, r.base + r.height]);
  });
  // the base: the median ground in the ring round the footprint (the LiDAR heights' reference)
  const glens = on.records.find((r) => r.landmark === 'first-presbyterian');
  assert.ok(glens && Math.abs(glens.base - S.ground(glens.cx, glens.cz)) < 3);
  // features: the spire from its church's roof, the same heights as before above that base; the monument on the ground
  const flatSpire = flat.features.find((f) => f.type === 'spire'), spire = on.features.find((f) => f.type === 'spire');
  assert.ok(Math.abs(spire.base - (glens.base + glens.height)) < 1e-9);
  assert.ok(Math.abs((spire.top - spire.base) - (flatSpire.top - flatSpire.base)) < 1e-9);
  const ob = on.features.find((f) => f.type === 'obelisk'), flatOb = flat.features.find((f) => f.type === 'obelisk');
  assert.ok(Math.abs(ob.base - S.ground(ob.x, ob.z)) < 1e-9 && Math.abs(ob.top - ob.base - flatOb.top) < 1e-9);
  // a steep site: the walls reach the lowest ground under them (no floating corner), the roof stays level at base + height
  const steep = on.records.reduce((a, b) => (b.exposed > a.exposed ? b : a));
  assert.ok(steep.exposed > 5 && steep.foundation < steep.base);
});

test('trees on the terrain: only the base height and the trunk\'s vertical range change', () => {
  const geo = GF_GEO;
  const flat = placeGfTrees(GF_TREES, { buildings: GF_BUILDINGS, geo });
  const on = placeGfTrees(GF_TREES, { buildings: GF_BUILDINGS, geo, ground: S.ground });
  assert.equal(on.sites.length, 77970);
  assert.deepEqual(on.skipped, flat.skipped);
  assert.deepEqual(on.speciesCounts, flat.speciesCounts);
  on.sites.forEach((s, i) => {
    const f = flat.sites[i];
    assert.deepEqual([s.x, s.z, s.scale, s.species, s.sx, s.sz, s.tier], [f.x, f.z, f.scale, f.species, f.sx, f.sz, f.tier]);
    assert.equal(s.y, S.ground(s.x, s.z));
    const t = on.trunks[i], u = flat.trunks[i];
    assert.deepEqual([t.minX, t.maxX, t.minZ, t.maxZ, t.minY], [u.minX, u.maxX, u.minZ, u.maxZ, s.y]);
    assert.ok(Math.abs(t.maxY - t.minY - u.maxY) < 1e-9);
  });
});

test('roads draped: each piece on the right surface (deck or ground), its vertices on it and its interior close', () => {
  const g = GF_GEO.roadGraph, service = g.classes.indexOf('service');
  const bridgeSegs = new Set(GF_BRIDGES.bridges.flatMap((b) => b.segments.map(([l, s]) => `${l}/${s}`)));
  const linkPts = (l) => {
    const pts = [[g.nodes[l[0] * 2], g.nodes[l[0] * 2 + 1]]];
    for (let i = 0; i < l[7].length; i += 2) pts.push([l[7][i], l[7][i + 1]]);
    pts.push([g.nodes[l[1] * 2], g.nodes[l[1] * 2 + 1]]);
    return pts;
  };
  // the sample: every 20th link, every link with a bridge segment and every link passing under a deck; the bridge
  // segments keyed by the sample's own link indices (drapeRoads reads `${link}/${segment}` of the graph it is given)
  const under = (l) => linkPts(l).some(([x, z], k, pts) => k > 0 && [0.25, 0.5, 0.75].some((t) => {
    const [px, pz] = pts[k - 1], d = S.deckAt(px + (x - px) * t, pz + (z - pz) * t);
    return d && d.y - S.ground(px + (x - px) * t, pz + (z - pz) * t) > 2;
  }));
  const keep = g.links.map((l, k) => k).filter((k) => (g.links[k][3] !== service && k % 20 === 0)
    || linkPts(g.links[k]).some((_, s) => bridgeSegs.has(`${k}/${s}`)) || under(g.links[k]));
  const remap = new Map(keep.map((k, i) => [k, i]));
  const segs = new Set([...bridgeSegs].map((key) => key.split('/').map(Number)).filter(([l]) => remap.has(l)).map(([l, s]) => `${remap.get(l)}/${s}`));
  assert.equal(segs.size, bridgeSegs.size, 'every bridge segment is in the sample, under its new index');
  const sample = { ...g, links: keep.map((k) => g.links[k]) };
  const { positions: P, indices: I, parts } = drapeRoads(sample, () => true, S, segs, { parts: true });

  let vertexWorst = 0, interiorWorst = 0, over10 = 0, samples = 0, deckChecks = 0, underChecks = 0;
  for (const part of parts) {
    const li = keep[part.link], pts = linkPts(g.links[li]);
    // the right surface: a strip over a bridge segment drapes on its deck; a join on the deck where a bridge segment
    // of the link starts or ends at its point; everything else on the ground, even under a deck
    const wantDeck = part.kind === 'strip' ? bridgeSegs.has(`${li}/${part.seg}`)
      : bridgeSegs.has(`${li}/${part.point - 1}`) || bridgeSegs.has(`${li}/${part.point}`);
    assert.equal(part.onDeck, wantDeck, `${part.kind} of link ${li}`);
    let expect;
    if (part.kind === 'strip') {
      const [x0, z0] = pts[part.seg], [x1, z1] = pts[part.seg + 1], len = Math.hypot(x1 - x0, z1 - z0);
      const dir = [(x1 - x0) / len, (z1 - z0) / len];
      expect = (x, z) => { const d = wantDeck ? S.deckAt(x, z, { dir }) : null; return d ? d.y : S.ground(x, z); };
    } else expect = (x, z) => { const d = wantDeck ? S.deckAt(x, z) : null; return d ? d.y : S.ground(x, z); };
    for (let k = part.start; k < part.end; k += 3) {
      const A = I[k] * 3, B = I[k + 1] * 3, C = I[k + 2] * 3;
      for (const V of [A, B, C]) vertexWorst = Math.max(vertexWorst, Math.abs(P[V + 1] - ROAD_LIFT - expect(P[V], P[V + 2])));
      // the interior, on a 0.5 m barycentric grid
      const e = Math.max(Math.hypot(P[A] - P[B], P[A + 2] - P[B + 2]), Math.hypot(P[B] - P[C], P[B + 2] - P[C + 2]), Math.hypot(P[A] - P[C], P[A + 2] - P[C + 2]));
      const n = Math.max(1, Math.ceil(e / 0.5));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          const w1 = i / n, w2 = j / n, w3 = 1 - w1 - w2;
          const x = w1 * P[A] + w2 * P[B] + w3 * P[C], z = w1 * P[A + 2] + w2 * P[B + 2] + w3 * P[C + 2];
          const y = w1 * P[A + 1] + w2 * P[B + 1] + w3 * P[C + 1] - ROAD_LIFT;
          const err = Math.abs(y - expect(x, z));
          interiorWorst = Math.max(interiorWorst, err);
          if (err > 0.1) over10++;
          samples++;
          // on the right level where the two are metres apart: a deck strip over the deck, a road beneath on the ground
          const d = S.deckAt(x, z), gy = S.ground(x, z);
          if (part.kind === 'strip' && d && d.y - gy > 2 && d.lateral < 0.5) {
            // (nearer its own surface than the other, and close to it)
            if (wantDeck) { assert.ok(y - gy > d.y - y && Math.abs(y - d.y) < 0.35, `deck strip of link ${li} at ${x}, ${z}: ${y} deck ${d.y} ground ${gy}`); deckChecks++; }
            else { assert.ok(d.y - y > y - gy && Math.abs(y - gy) < 0.35, `road under a deck, link ${li} at ${x}, ${z}: ${y} deck ${d.y} ground ${gy}`); underChecks++; }
          }
        }
      }
    }
  }
  // vertices on their surface (to float32 positions); the interior within 0.45 m everywhere and within 0.1 m at all but
  // about one in a thousand samples. The worst are abutment walls in the DEM (a 3.6 m drop within 2 m beside Murray
  // Street's deck, a bank across Bush Street's approach), which a ribbon of lines 0.5 m apart cannot follow
  assert.ok(vertexWorst < 2e-3, `vertices ${vertexWorst}`);
  assert.ok(interiorWorst < 0.45, `interior ${interiorWorst}`);
  // (this sample holds every bridge and under-bridge link, so the abutments weigh more than over the whole network)
  assert.ok(over10 / samples < 1e-3, `${over10} of ${samples} samples over 0.1 m`);
  assert.ok(deckChecks > 500 && underChecks > 50, `${deckChecks} deck, ${underChecks} under-deck samples`);
  assert.equal(DRAPE_TOL, 0.02);
});

test('bridge decks meet the ground across the whole road at both ends (the deck turns into its cross-slope)', () => {
  for (const d of S.decks) {
    for (const [end, c] of [[0, d.segments[0]], [1, d.segments[d.segments.length - 1]]]) {
      const [px, pz] = end ? c.to : c.from, ex = (c.to[0] - c.from[0]) / c.len, ez = (c.to[1] - c.from[1]) / c.len;
      const inside = end ? -0.01 : 0.01, half = c.width / 2;
      for (let k = -1; k <= 1; k += 0.125) {
        const x = px - ez * half * k + ex * inside, z = pz + ex * half * k + ez * inside;
        assert.ok(Math.abs(S.deckAt(x, z).y - S.ground(x, z)) < 0.05, `${d.name || d.id} end ${end}, ${k}`);
      }
    }
  }
});

test('shared modules: tsl-materials.js gains only the opt-in footprintBase (undoing it gives back CC-005\'s file)', () => {
  let s = fs.readFileSync(path.join(root, 'js/tsl-materials.js'), 'utf8');
  const undo = [
    ["// footprintBase: footprint walls carry a per-vertex 'facadeBase' attribute, the height their building stands on (a city\n// on a terrain, e.g. Glens Falls), and the facade's storeys count up from it rather than from y = 0\nfunction facadeCell(windowWidth, floorHeight, boxLocal, cornerPier = 0, footprintLocal = false, footprintBase = false) {",
      'function facadeCell(windowWidth, floorHeight, boxLocal, cornerPier = 0, footprintLocal = false) {'],
    ["const vCoord = footprintBase ? positionWorld.y.sub(attribute('facadeBase', 'float')) : positionWorld.y;", 'const vCoord = positionWorld.y;'],
    ['    footprintBase = false, // footprints standing on their own \'facadeBase\' heights (see facadeCell)\n', ''],
    ["_${cornerPier}${footprintBase ? '_base' : ''}`;", '_${cornerPier}`;'],
    ['cornerPier, footprintLocal, footprintBase);', 'cornerPier, footprintLocal);']
  ];
  for (const [now, before] of undo) {
    assert.equal(s.split(now).length, 2, now.slice(0, 50));
    s = s.replace(now, before);
  }
  assert.equal(sha(s), '319df9cd77768172933de0d1e384d36d4a8d35529fc3c7c1e475fb39f4a7f587');
});
