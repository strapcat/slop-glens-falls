// Glens Falls road ribbons draped on the CC-005b surface (no three.js, so Node tests measure what the game draws).
// Each road-graph link segment becomes a strip of lines along it (both curbs, the centre line and as many lines between
// as its cross-section needs) whose stations are split until the drawn ribbon follows the surface:
//   across: at a cross-section every CROSS_STEP metres, the surface wherever the section crosses a 1 m lattice line
//           (the terrain's breakpoints) is within CROSS_TOL of the polyline through the lines (2, 4, 8 or 16 quads
//           across, the fewest that do); over a deck, every quarter metre across too;
//   along:  on every line, the surface at every lattice line it crosses is within DRAPE_TOL of the chord between
//           stations; over a deck, every quarter metre too (where it turns into the ground's cross-slope at an end).
// So flat straight runs stay a few long quads, and hills, crowns, cambers, ditches and humps get what they need. A bridge
// segment (gf-bridges.js) drapes over its deck (gf-surface.js deckAt) instead of the ground under it. Round joins at the
// link ends (the fewest rings and sectors within CROSS_TOL at every lattice node under them) and wedges filling the
// outer side of the bends inside a link (on the radii of the strips' own lines) sit on the surface too. Everything is
// lifted ROAD_LIFT above the surface, so the drawn asphalt is not under the terrain; vehicles drive at that height
// (gf-main.js). tests/gf-terrain.test.mjs samples the triangles' interiors against the surface each should follow.

const DRAPE_TOL = 0.02;
const ROAD_LIFT = 0.03;
const UTM_STEP = 16; // metres between exact projections along a segment
const MAX_STATION = 24; // metres, the longest quad even on a perfectly straight grade (keeps shading and fog even)
const CROSS_STEP = 4; // metres between the cross-sections that choose a segment's lines across
const CROSS_TOL = 0.08; // metres: across (and in a join), the fewest quads within this
const LINE_COUNTS = [2, 4, 8, 16]; // quads across a segment
// round joins: rings x sectors, the first whose drawn disc is within CROSS_TOL at every lattice node inside it
const JOIN_CONFIGS = [[1, 8], [2, 16], [4, 16], [6, 24], [8, 32], [12, 48]];

// { positions: Float32Array, indices: Uint32Array, stations, lines } of the links whose highway class passes include().
// surface: gf-surface.js (ground, deckAt and its terrain, whose lattice gives the breakpoints).
// With { parts: true }, also parts: [{ kind: 'strip', link, seg, onDeck, start, end } | { kind: 'join', link, point,
// onDeck, start, end }], each piece's range in indices (for tests and audits).
function drapeRoads(graph, include, surface, bridgeSegs = new Set(), { parts = false } = {}) {
  const { nodes, links } = graph;
  const T = surface.terrain;
  const L = T.lattice;
  const pos = [];
  const idx = [];
  let stations = 0, lineCount = 0, joins = 0, joinTriangles = 0;
  const pieces = parts ? [] : null;
  const vert = (x, y, z) => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  // ground at UTM (e, n) in game y (the query: gf-terrain.js heightAt is this at toUtm(x, z))
  const groundUtm = T.heightUtm;
  // the parameters t in (ta, tb) where the UTM line p(t) = pa + (pb - pa) (t - ta) / (tb - ta) crosses a lattice line
  // (u = e - e0, v = n0 - n or u - v an integer: the 1 m triangles' edges, where the terrain may bend), into out
  const crossings = (ta, tb, ea, na, eb, nb, out) => {
    const ua = ea - L.e0, va = L.n0 - na, ub = eb - L.e0, vb = L.n0 - nb;
    for (const [a, b] of [[ua, ub], [va, vb], [ua - va, ub - vb]]) {
      if (a === b) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let m = Math.floor(lo) + 1; m < hi; m++) out.push(ta + ((m - a) / (b - a)) * (tb - ta));
    }
  };

  for (let li = 0; li < links.length; li++) {
    const [a, b, , cls, , , width, inner] = links[li];
    if (!include(cls)) continue;
    const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
    const r = width / 2;
    const segInfo = []; // per segment: its lines (offsets k), unit direction and whether it is on a deck
    for (let s = 0; s + 1 < pts.length; s++) {
      const [x0, z0] = pts[s], [x1, z1] = pts[s + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-6) continue;
      const nx = (-(z1 - z0) / len) * r, nz = ((x1 - x0) / len) * r;
      const dir = [(x1 - x0) / len, (z1 - z0) / len];
      const onDeck = bridgeSegs.has(`${li}/${s}`);
      // UTM along the centre line, exact every UTM_STEP metres (linear between: under 0.2 mm off), and the lateral
      // offset of a curb in UTM (the frame's rotation and scale, constant over a segment)
      const N = Math.max(1, Math.ceil(len / UTM_STEP));
      const ce = new Float64Array(N + 1), cn = new Float64Array(N + 1);
      for (let m = 0; m <= N; m++) {
        const t = Math.min(1, (m * UTM_STEP) / len);
        [ce[m], cn[m]] = T.toUtm(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      }
      const [eL, nL] = T.toUtm(x0 + (x1 - x0) / 2 - nx, z0 + (z1 - z0) / 2 - nz);
      const [eR, nR] = T.toUtm(x0 + (x1 - x0) / 2 + nx, z0 + (z1 - z0) / 2 + nz);
      const le = (eR - eL) / 2, ln = (nR - nL) / 2;
      const stationT = (m) => Math.min(1, (m * UTM_STEP) / len);
      const utmAt = (t, k) => {
        const m = Math.min(N - 1, Math.floor((t * len) / UTM_STEP));
        const f = (t - stationT(m)) / (stationT(m + 1) - stationT(m));
        return [ce[m] + (ce[m + 1] - ce[m]) * f + le * k, cn[m] + (cn[m + 1] - cn[m]) * f + ln * k];
      };
      // surface height at station t (0..1) and lateral offset k (-1 left curb, 0 centre, 1 right curb)
      const yAt = (t, k) => {
        if (onDeck) {
          const d = surface.deckAt(x0 + (x1 - x0) * t + nx * k, z0 + (z1 - z0) * t + nz * k, { dir });
          if (d) return d.y;
        }
        let m = Math.floor((t * len) / UTM_STEP);
        if (m > N - 1) m = N - 1;
        const tm = stationT(m), f = (t - tm) / (stationT(m + 1) - tm);
        return groundUtm(ce[m] + (ce[m + 1] - ce[m]) * f + le * k, cn[m] + (cn[m + 1] - cn[m]) * f + ln * k);
      };

      // across: the fewest quads whose polyline every cross-section's breakpoints stay within CROSS_TOL of. Each
      // section samples the surface where it crosses the lattice (and finely over a deck); the candidate lines are
      // 1/8 of the half width apart (16 quads), evaluated as needed
      let quads = LINE_COUNTS[LINE_COUNTS.length - 1];
      {
        const sections = Math.max(1, Math.ceil(len / CROSS_STEP));
        const secT = new Float64Array(sections + 1), secK = [], secY = [], secLine = [];
        const kb = [];
        for (let c = 0; c <= sections; c++) {
          const t = c / sections;
          secT[c] = t;
          kb.length = 0;
          if (onDeck) for (let q = 1; q < 4 * width; q++) kb.push(-1 + q / (2 * width));
          const [ea, na] = utmAt(t, -1), [eb, nb] = utmAt(t, 1);
          crossings(-1, 1, ea, na, eb, nb, kb);
          const K = Float64Array.from(kb), Y = new Float64Array(K.length);
          for (let j = 0; j < K.length; j++) Y[j] = yAt(t, K[j]);
          secK.push(K); secY.push(Y);
          secLine.push(new Float64Array(17).fill(NaN));
        }
        const lineVal = (c, i) => {
          const a = secLine[c];
          if (Number.isNaN(a[i])) a[i] = yAt(secT[c], -1 + i / 8);
          return a[i];
        };
        for (const q of LINE_COUNTS) {
          const step = 16 / q;
          let ok = true;
          for (let c = 0; c <= sections && ok; c++) {
            const K = secK[c], Y = secY[c];
            for (let j = 0; j < K.length; j++) {
              const p = ((K[j] + 1) / 2) * q;
              let i = Math.floor(p);
              if (i > q - 1) i = q - 1;
              const f = p - i;
              if (Math.abs(Y[j] - (lineVal(c, i * step) * (1 - f) + lineVal(c, (i + 1) * step) * f)) > CROSS_TOL) { ok = false; break; }
            }
          }
          if (ok) { quads = q; break; }
        }
      }
      const ks = Array.from({ length: quads + 1 }, (_, i) => -1 + (2 * i) / quads);
      lineCount += ks.length;
      segInfo[s] = { ks, dx: dir[0], dz: dir[1], onDeck };
      // along: every line's breakpoints (lattice crossings), every metre, and on a deck every quarter metre
      const breaks = ks.map((k) => {
        const out = [];
        for (let m = 0; m < N; m++) {
          const [ea, na] = utmAt(stationT(m), k), [eb, nb] = utmAt(stationT(m + 1), k);
          crossings(stationT(m), stationT(m + 1), ea, na, eb, nb, out);
        }
        // (the lattice crossings come ~3 a metre; a deck adds every quarter metre, where it meets an embankment)
        if (onDeck) for (let q = 1; q * 0.25 < len; q++) out.push((q * 0.25) / len);
        return Float64Array.from(out).sort();
      });
      const lower = (arr, t) => {
        let lo = 0, hi = arr.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= t) lo = mid + 1; else hi = mid; }
        return lo;
      };
      const fine = (t0, t1, y0, y1) => {
        for (let k = 0; k < ks.length; k++) {
          const br = breaks[k];
          for (let i = lower(br, t0); i < br.length && br[i] < t1; i++) {
            const t = br[i], f = (t - t0) / (t1 - t0);
            if (Math.abs(yAt(t, ks[k]) - (y0[k] + (y1[k] - y0[k]) * f)) > DRAPE_TOL) return false;
          }
        }
        return true;
      };
      const ys = (t) => ks.map((k) => yAt(t, k));
      const ts = [0];
      (function split(t0, t1, y0, y1) {
        if ((t1 - t0) * len <= MAX_STATION && ((t1 - t0) * len <= 0.26 || fine(t0, t1, y0, y1))) {
          ts.push(t1);
          return;
        }
        const tm = (t0 + t1) / 2, ym = ys(tm);
        split(t0, tm, y0, ym);
        split(tm, t1, ym, y1);
      })(0, 1, ys(0), ys(1));
      stations += ts.length;
      const start = idx.length;
      let prev = null;
      for (const t of ts) {
        const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        const row = ks.map((k) => vert(x + nx * k, yAt(t, k) + ROAD_LIFT, z + nz * k));
        if (prev) {
          // a quad between each pair of neighbouring lines, up-facing
          for (let c = 0; c < quads; c++) idx.push(prev[c], row[c + 1], row[c], prev[c], prev[c + 1], row[c + 1]);
        }
        prev = row;
      }
      if (pieces) pieces.push({ kind: 'strip', link: li, seg: s, onDeck, start, end: idx.length });
    }
    // round joins at every point of the link, on the surface: on the deck where a bridge segment of the link starts or
    // ends there (the deck, or the ground where that stands higher, as deckAt). A disc of rings x sectors, the fewest
    // (JOIN_CONFIGS) whose drawn surface is within CROSS_TOL of the ground at every lattice node inside it (where the
    // 1 m terrain bends), and on a deck at a fine polar grid too
    pts.forEach(([x, z], k) => {
      const onDeck = bridgeSegs.has(`${li}/${k - 1}`) || bridgeSegs.has(`${li}/${k}`);
      const A = segInfo[k - 1], B = segInfo[k];
      if (A && B) {
        // a bend inside the link: the strips overlap on its inner side and open a wedge on its outer side, filled by a
        // fan from the point over that angle, with rings at the radii of both strips' lines there (its edges are theirs)
        const side = Math.sign(-B.dz * A.dx + B.dx * A.dz);
        const ang = Math.acos(Math.max(-1, Math.min(1, A.dx * B.dx + A.dz * B.dz)));
        if (side === 0 || ang * r < 0.005) return;
        const ua = [-A.dz * side, A.dx * side], ub = [-B.dz * side, B.dx * side];
        const radii = [...new Set([...A.ks, ...B.ks].filter((q) => q * side > 1e-9).map((q) => +(q * side).toFixed(9)))].sort((p, q) => p - q);
        const n = Math.max(1, Math.ceil(ang / (Math.PI / 16)));
        const yAt = (px, pz) => {
          const d = onDeck ? surface.deckAt(px, pz) : null;
          return d ? d.y : surface.ground(px, pz);
        };
        const start = idx.length;
        const centre = vert(x, yAt(x, z) + ROAD_LIFT, z);
        const a0 = Math.atan2(ua[1], ua[0]);
        let da = Math.atan2(ub[1], ub[0]) - a0;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        const rows = radii.map((q) => Array.from({ length: n + 1 }, (_, j) => {
          const t = a0 + (da * j) / n, px = x + Math.cos(t) * r * q, pz = z + Math.sin(t) * r * q;
          return vert(px, yAt(px, pz) + ROAD_LIFT, pz);
        }));
        const up = da > 0 ? 1 : 0; // keep the fan's triangles up-facing, as the strips'
        for (let j = 0; j < n; j++) {
          const [p0, p1] = up ? [rows[0][j + 1], rows[0][j]] : [rows[0][j], rows[0][j + 1]];
          idx.push(centre, p0, p1);
          for (let i = 0; i + 1 < rows.length; i++) {
            const [a, b, c, d] = [rows[i][j], rows[i][j + 1], rows[i + 1][j], rows[i + 1][j + 1]];
            if (up) idx.push(a, d, b, a, c, d); else idx.push(a, b, d, a, d, c);
          }
        }
        joins++;
        joinTriangles += n * (2 * radii.length - 1);
        if (pieces) pieces.push({ kind: 'join', link: li, point: k, onDeck, start, end: idx.length });
        return;
      }
      // local -> UTM, affine about the point (a disc is a few metres: micrometres off)
      const [ue, un] = T.toUtm(x, z), [uxe, uxn] = T.toUtm(x + 1, z), [uze, uzn] = T.toUtm(x, z + 1);
      const ax = uxe - ue, bx = uze - ue, az = uxn - un, bz = uzn - un, det = ax * bz - bx * az;
      const yAt = (px, pz) => {
        const d = onDeck ? surface.deckAt(px, pz) : null;
        if (d) return d.y;
        const dx = px - x, dz = pz - z;
        return groundUtm(ue + ax * dx + bx * dz, un + az * dx + bz * dz);
      };
      // the test points: lattice nodes in the disc (in local x, z), and a polar grid over a deck
      const tests = [];
      const ru = r * Math.hypot(ax, az) + 1;
      for (let u = Math.ceil(ue - L.e0 - ru); u <= Math.floor(ue - L.e0 + ru); u++) {
        for (let v = Math.ceil(L.n0 - un - ru); v <= Math.floor(L.n0 - un + ru); v++) {
          const de = L.e0 + u - ue, dn = L.n0 - v - un;
          const dx = (bz * de - bx * dn) / det, dz = (ax * dn - az * de) / det;
          if (dx * dx + dz * dz < r * r * 0.98) tests.push([dx, dz]);
        }
      }
      if (onDeck) for (let i = 1; i <= 8; i++) for (let m = 0; m < 64; m++) tests.push([Math.cos(m / 32 * Math.PI) * r * i / 8.5, Math.sin(m / 32 * Math.PI) * r * i / 8.5]);
      const ty = tests.map(([dx, dz]) => yAt(x + dx, z + dz));
      const yc = yAt(x, z);
      let ringY = null, R = 0, SN = 0;
      for (const [rings, sectors] of JOIN_CONFIGS) {
        R = rings; SN = sectors;
        ringY = [];
        for (let i = 1; i <= rings; i++) {
          const row = [];
          for (let m = 0; m < sectors; m++) {
            const ang = (m / sectors) * Math.PI * 2;
            row.push(yAt(x + Math.cos(ang) * r * i / rings, z + Math.sin(ang) * r * i / rings));
          }
          ringY.push(row);
        }
        const drawn = (dx, dz) => {
          // the cell of the polar mesh holding (dx, dz): its sector, then the ring band (straight chords), barycentric
          const ang = (Math.atan2(dz, dx) + 2 * Math.PI) % (2 * Math.PI);
          const m = Math.min(sectors - 1, Math.floor(ang / (2 * Math.PI) * sectors)), n = (m + 1) % sectors;
          const cm = Math.cos(m / sectors * 2 * Math.PI), sm = Math.sin(m / sectors * 2 * Math.PI);
          const cn = Math.cos(n / sectors * 2 * Math.PI), sn = Math.sin(n / sectors * 2 * Math.PI);
          const P = (i, c, s2) => [c * r * i / rings, s2 * r * i / rings];
          const Y = (i, which) => (i === 0 ? yc : ringY[i - 1][which]);
          for (let i = 0; i < rings; i++) {
            const tri = i === 0
              ? [[[0, 0, yc], [...P(1, cn, sn), Y(1, n)], [...P(1, cm, sm), Y(1, m)]]]
              : [[[...P(i, cm, sm), Y(i, m)], [...P(i + 1, cn, sn), Y(i + 1, n)], [...P(i + 1, cm, sm), Y(i + 1, m)]],
                [[...P(i, cm, sm), Y(i, m)], [...P(i, cn, sn), Y(i, n)], [...P(i + 1, cn, sn), Y(i + 1, n)]]];
            for (const [[x1, z1, y1], [x2, z2, y2], [x3, z3, y3]] of tri) {
              const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
              const w1 = ((z2 - z3) * (dx - x3) + (x3 - x2) * (dz - z3)) / d, w2 = ((z3 - z1) * (dx - x3) + (x1 - x3) * (dz - z3)) / d;
              if (w1 >= -1e-9 && w2 >= -1e-9 && w1 + w2 <= 1 + 1e-9) return w1 * y1 + w2 * y2 + (1 - w1 - w2) * y3;
            }
          }
          return NaN; // between the outer chords and the circle: not drawn
        };
        let ok = true;
        for (let q = 0; q < tests.length && ok; q++) {
          const d = drawn(tests[q][0], tests[q][1]);
          if (Number.isFinite(d) && Math.abs(d - ty[q]) > CROSS_TOL) ok = false;
        }
        if (ok) break;
      }
      const start = idx.length;
      const centre = vert(x, yc + ROAD_LIFT, z);
      const rings = ringY.map((row, i) => row.map((y, m) => {
        const ang = (m / SN) * Math.PI * 2;
        return vert(x + Math.cos(ang) * r * (i + 1) / R, y + ROAD_LIFT, z + Math.sin(ang) * r * (i + 1) / R);
      }));
      for (let m = 0; m < SN; m++) {
        const n = (m + 1) % SN;
        idx.push(centre, rings[0][n], rings[0][m]);
        for (let i = 0; i + 1 < R; i++) idx.push(rings[i][m], rings[i + 1][n], rings[i + 1][m], rings[i][m], rings[i][n], rings[i + 1][n]);
      }
      joins++;
      joinTriangles += SN * (2 * R - 1);
      if (pieces) pieces.push({ kind: 'join', link: li, point: k, onDeck, start, end: idx.length });
    });
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), stations, lines: lineCount, joins, joinTriangles, parts: pieces };
}

export { drapeRoads, DRAPE_TOL, CROSS_TOL, ROAD_LIFT };
