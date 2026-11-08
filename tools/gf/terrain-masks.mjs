// tools/gf/terrain-masks.mjs — which 1 m lattice nodes (js/gf-terrain.js) lie on the places the CC-005b audits report
// separately: one byte per node, bits MASK.target (inside the exact WGS84 target bbox), road (every road-graph link's
// carriageway), bank (within 10 m of a water polygon's outline), deck (a bridge deck's footprint, the bare earth under
// it) and hill (the bundle's Thrill Hill reference crop, thrill-hill-reference-dem-1m.tif). Shared by
// audit-gf-terrain.mjs (against the source) and audit-gf-terrain-mesh.mjs (the drawn mesh against the query).
import fs from 'node:fs';
import path from 'node:path';
import { openTiff } from './tiff.mjs';
import { utmToLonLat } from '../../js/gf-utm.js';
import { GF_GEO } from '../../js/gf-geodata.js';
import { GF_BRIDGES } from '../../js/gf-bridges.js';

const MASK = { target: 1, road: 2, bank: 4, deck: 8, hill: 16 };
const MASK_NAMES = ['road', 'bank', 'deck', 'hill'];

// T: the terrain (its lattice and projection); bounds: the provenance's targetWgs84Bounds; dataDir: tools/gf/data/terrain
function terrainMasks(T, bounds, dataDir) {
  const L = T.lattice, W = L.cols, H = L.rows;
  const mask = new Uint8Array(W * H);
  let inTarget = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const [lon, lat] = utmToLonLat(L.e0 + i, L.n0 - j);
      if (lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north) { mask[j * W + i] = MASK.target; inTarget++; }
    }
  }
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
    for (let k = 0; k + 1 < pts.length; k++) markSegment(...pts[k], ...pts[k + 1], l[at.width] / 2, MASK.road);
  }
  for (const w of GF_GEO.water) {
    for (const ring of [w.outer, ...(w.holes || [])]) {
      for (let k = 0; k < ring.length; k += 2) {
        const n = (k + 2) % ring.length;
        markSegment(ring[k], ring[k + 1], ring[n], ring[n + 1], 10, MASK.bank);
      }
    }
  }
  for (const b of GF_BRIDGES.bridges) {
    for (const [li, s] of b.segments) {
      const pts = linkPts(g.links[li]);
      markSegment(...pts[s], ...pts[s + 1], g.links[li][at.width] / 2 + 2, MASK.deck);
    }
  }
  const hill = openTiff(path.join(dataDir, 'thrill-hill-reference-dem-1m.tif'));
  const hc0 = Math.round(hill.tie[3] - (L.e0 - 0.5)), hr0 = Math.round(L.n0 + 0.5 - hill.tie[4]);
  for (let r = 0; r < hill.height; r++) for (let c = 0; c < hill.width; c++) mask[(hr0 + r) * W + hc0 + c] |= MASK.hill;
  return { mask, inTarget, hill, hc0, hr0 };
}

export { terrainMasks, MASK, MASK_NAMES };
