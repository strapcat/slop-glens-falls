// CC-BUCKLEY: Buckley Tire Service (254 Warren St at Rogers St) as a plan: no three.js, so Node tests read it. The walls
// stand on the OSM outline (way 1190839200, js/gf-buildings.js) and the tall rear workshop's roof reaches the USGS LiDAR
// height (7.8 m, gf_landmarks.json). Everything else is modelled BY EYE from the Street View views Dave shared (Oct
// 2007, Jan 2022, Aug 2025): no Google imagery is committed, traced or used as a texture; every colour here is a plain
// painted colour and the sign's lettering is drawn at run time (gf-buckley-meshes.js). Every size below is a named
// APPROX value: approximate, not surveyed, for Dave to tweak.
//
// The look (the 2007-2025 views; Dave to confirm 1993): a low one-storey front block of white painted masonry with
// reddish-brown trim and a brown shingled mansard fascia along its front and sides; two service bays with sectional
// garage doors at the west end of the Warren St front; dark storefront windows in the middle over a raised planter with
// shrubs, a red "BUCKLEY TIRE SERVICE" sign above them; an aluminium-framed glass entrance on the east corner; a closed
// cream door on the Rogers St side; behind, a taller workshop with a shallow arched roof and tall multi-pane industrial
// windows down its sides; a weathered asphalt apron in front. The modern Cooper Tires signage is left out.

const APPROX_BUCKLEY = {
  frontDepth: 19, // m: the low front block, measured in from the Warren St front (the rest of the outline is the workshop)
  frontWall: 3.3, // m: the front block's walls
  fascia: { h: 1.1, inset: 0.9 }, // m: the mansard band above them (its height, and how far in it leans at the top)
  rearWall: 6.0, // m: the workshop's side walls; its arched roof rises from here to the LiDAR height
  bay: { first: 0.5, w: 3.0, gap: 0.5, h: 3.0 }, // m: the two service bays along the front, from its west end
  windows: { start: 7.6, end: 0.6, sill: 0.9, head: 2.7, pane: 1.85 }, // m: storefront windows (end: margin at the east end)
  planter: { out: 0.9, h: 0.55 }, // m: the raised planter under the windows
  sign: { start: 7.3, end: 0.4, y0: 2.8, y1: 3.75, out: 0.25 }, // m: the red sign above the windows
  entrance: { margin: 0.35, h: 2.5 }, // m: the glass entrance on the east corner edge
  sideDoor: { w: 3.0, h: 3.0, at: 0.55 }, // m: the cream door on the Rogers St side (at: along that edge, 0..1)
  rearWindows: { w: 2.2, y0: 1.6, y1: 5.2, every: 4.5, margin: 2.0, minEdge: 8 }, // m: the workshop's side windows
  apron: { west: 5, east: 1.5, out: 11 }, // m: asphalt beyond the front's west end, east end, and out towards Warren St
  zone: { s: 3.75, t: -5.0, r: 3.4 } // m: the repair spot in front of the bays (along the front, out (negative), radius)
};

// ---- small geometry helpers ([x, z] pairs) ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const len = (v) => Math.hypot(v[0], v[1]);
function inRing(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xa, za] = ring[j], [xb, zb] = ring[i];
    if ((za > z) !== (zb > z) && x < xa + ((z - za) * (xb - xa)) / (zb - za)) c = !c;
  }
  return c;
}
const signedArea = (r) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

// Keep the part of a ring where f(p) <= 0 (Sutherland-Hodgman against one half-plane, f linear)
function clipHalf(ring, f) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], fa = f(a), fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa <= 0) !== (fb <= 0)) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// Ear-clipping triangulation of a simple ring: index triples
function triangulate(ring) {
  const pts = signedArea(ring) > 0 ? ring.slice() : ring.slice().reverse();
  const idx = pts.map((_, i) => i);
  const map = signedArea(ring) > 0 ? (i) => i : (i) => ring.length - 1 - i;
  const out = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 5000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      if (cross(a, b, c) <= 1e-9) continue;
      if (idx.some((j) => j !== i0 && j !== i1 && j !== i2 && inTri(pts[j], a, b, c))) continue;
      out.push([map(i0), map(i1), map(i2)]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push(idx.map(map));
  return out;
}

// A ring moved `d` metres inwards (mitred, limited to 2x), for the mansard's top
function insetRing(ring, d) {
  const ccw = signedArea(ring) > 0;
  const n = ring.length;
  return ring.map((p, i) => {
    const a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    const e1 = sub(p, a), e2 = sub(b, p), l1 = len(e1) || 1, l2 = len(e2) || 1;
    // inward normals of both edges (left of the direction for a counter-clockwise ring in x, z)
    const n1 = ccw ? [-e1[1] / l1, e1[0] / l1] : [e1[1] / l1, -e1[0] / l1];
    const n2 = ccw ? [-e2[1] / l2, e2[0] / l2] : [e2[1] / l2, -e2[0] / l2];
    let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const c = Math.max(0.5, mx * n1[0] + mz * n1[1]);
    return [p[0] + (mx * d) / c, p[1] + (mz * d) / c];
  });
}

// ---- triangle soups: { material: [x, y, z, ...] } (three per triangle) ----
function soups() {
  const parts = {};
  const tri = (m, a, b, c) => (parts[m] || (parts[m] = [])).push(...a, ...b, ...c);
  const quad = (m, a, b, c, d) => { tri(m, a, b, c); tri(m, a, c, d); };
  return { parts, tri, quad };
}

// The plan of one building record (gf-building-bases.js: polygons[0].outer as { x, z }, base, height). Returns
// { frame, front, rear, parts (soups by material), sign (its face's corners, for the lettering), zone, apron, stats }.
// ground(x, z): the terrain under the apron (gf-surface.js), for draping it; optional (flat at base without one).
function planBuckley(record, { ground = null, A = APPROX_BUCKLEY } = {}) {
  const ring = record.polygons[0].outer.map((p) => [p.x, p.z]);
  const base = record.base || 0;
  const top = base + record.height;
  const n = ring.length;
  // each edge's outward normal (tested against the outline itself, whatever its winding)
  const edges = ring.map((a, i) => {
    const b = ring[(i + 1) % n], d = sub(b, a), l = len(d) || 1;
    let nx = d[1] / l, nz = -d[0] / l;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (inRing(ring, mx + nx * 0.1, mz + nz * 0.1)) { nx = -nx; nz = -nz; }
    return { i, a, b, l, nx, nz };
  });
  // The Warren St front: the longest edge facing south (towards the street, +z), its ends ordered west to east
  const front = edges.filter((e) => e.nz > 0.6).sort((p, q) => q.l - p.l)[0];
  if (!front) throw new Error('buckley: no south-facing edge for the Warren St front');
  let [A0, B0] = [front.a, front.b];
  if (B0[0] < A0[0]) [A0, B0] = [B0, A0];
  const L = front.l;
  const u = [(B0[0] - A0[0]) / L, (B0[1] - A0[1]) / L]; // along the front, west to east
  const nIn = [-front.nx, -front.nz]; // into the building
  const P = (s, t) => [A0[0] + u[0] * s + nIn[0] * t, A0[1] + u[1] * s + nIn[1] * t]; // front frame -> world (x, z)
  const T = (p) => (p[0] - A0[0]) * nIn[0] + (p[1] - A0[1]) * nIn[1];

  // the low front block and the tall rear workshop: the outline cut at frontDepth
  const frontRing = clipHalf(ring, (p) => T(p) - A.frontDepth);
  const rearRing = clipHalf(ring, (p) => A.frontDepth - T(p));
  const { parts, tri, quad } = soups();
  const V = (p, y) => [p[0], y, p[1]];

  // walls: the outline extruded (white masonry)
  const walls = (r, y1) => {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      quad('wall', V(a, base), V(b, base), V(b, y1), V(a, y1));
    }
  };
  const yW = base + A.frontWall, yF = yW + A.fascia.h, yR = base + A.rearWall;
  walls(frontRing, yW);
  walls(rearRing, yR);
  // a reddish-brown trim band at the foot of the front block
  for (let i = 0; i < frontRing.length; i++) {
    const a = frontRing[i], b = frontRing[(i + 1) % frontRing.length];
    const e = edges.find((x) => Math.abs((x.b[0] - x.a[0]) * (a[1] - x.a[1]) - (x.b[1] - x.a[1]) * (a[0] - x.a[0])) < 1e-3 * x.l);
    const o = e ? [e.nx * 0.03, e.nz * 0.03] : [0, 0];
    quad('trim', V([a[0] + o[0], a[1] + o[1]], base), V([b[0] + o[0], b[1] + o[1]], base), V([b[0] + o[0], b[1] + o[1]], base + 0.35), V([a[0] + o[0], a[1] + o[1]], base + 0.35));
  }

  // the mansard: a shingled band leaning in from the wall top, and a flat roof inside it
  const inner = insetRing(frontRing, A.fascia.inset);
  for (let i = 0; i < frontRing.length; i++) {
    const j = (i + 1) % frontRing.length;
    quad('fascia', V(frontRing[i], yW), V(frontRing[j], yW), V(inner[j], yF), V(inner[i], yF));
  }
  for (const [a, b, c] of triangulate(inner)) tri('roof', V(inner[a], yF), V(inner[b], yF), V(inner[c], yF));

  // the workshop: a flat cap at its wall top, and a shallow arched roof over the rectangle inscribed in it (world axes:
  // its walls run north-south), with white gable ends
  for (const [a, b, c] of triangulate(rearRing)) tri('roof', V(rearRing[a], yR), V(rearRing[b], yR), V(rearRing[c], yR));
  const cx = rearRing.reduce((s, p) => s + p[0], 0) / rearRing.length, cz = rearRing.reduce((s, p) => s + p[1], 0) / rearRing.length;
  const x0 = Math.max(...rearRing.filter((p) => p[0] < cx).map((p) => p[0]));
  const x1 = Math.min(...rearRing.filter((p) => p[0] > cx).map((p) => p[0]));
  const z0 = Math.max(...rearRing.filter((p) => p[1] < cz).map((p) => p[1]));
  const z1 = Math.min(...rearRing.filter((p) => p[1] > cz).map((p) => p[1]));
  const arch = [];
  const N = 10, rise = top - yR;
  for (let k = 0; k <= N; k++) {
    const f = k / N, x = x0 + (x1 - x0) * f, w = 2 * f - 1;
    arch.push([x, yR + rise * (1 - w * w)]);
  }
  for (let k = 0; k < N; k++) {
    const [xa, ya] = arch[k], [xb, yb] = arch[k + 1];
    quad('metalRoof', [xa, ya, z0], [xb, yb, z0], [xb, yb, z1], [xa, ya, z1]);
    tri('wall', [xa, yR, z0], [xa, ya, z0], [xb, yb, z0]);
    tri('wall', [xa, yR, z0], [xb, yb, z0], [xb, yR, z0]);
    tri('wall', [xa, yR, z1], [xb, yb, z1], [xa, ya, z1]);
    tri('wall', [xa, yR, z1], [xb, yR, z1], [xb, yb, z1]);
  }

  // ---- the Warren St front: bays, storefront windows, planter, sign ----
  const F = (s, t, y) => V(P(s, t), y);
  const panel = (m, s0, s1, y0, y1, t) => quad(m, F(s0, t, y0), F(s1, t, y0), F(s1, t, y1), F(s0, t, y1));
  const box = (m, s0, s1, t0, t1, y0, y1) => {
    const c = [[s0, t0], [s1, t0], [s1, t1], [s0, t1]];
    for (let i = 0; i < 4; i++) { const a = c[i], b = c[(i + 1) % 4]; quad(m, F(a[0], a[1], y0), F(b[0], b[1], y0), F(b[0], b[1], y1), F(a[0], a[1], y1)); }
    quad(m, F(s0, t0, y1), F(s1, t0, y1), F(s1, t1, y1), F(s0, t1, y1));
  };
  const B = A.bay;
  const bays = [];
  for (let k = 0; k < 2; k++) {
    const s0 = B.first + k * (B.w + B.gap), s1 = s0 + B.w;
    bays.push({ s0, s1 });
    box('trim', s0 - 0.15, s1 + 0.15, -0.06, 0, base, base + B.h + 0.15); // the frame
    panel('door', s0, s1, base, base + B.h, -0.08);
    // sectional door: four panel rows, the second from the top glazed
    for (let r = 1; r < 4; r++) panel('groove', s0, s1, base + (B.h * r) / 4 - 0.025, base + (B.h * r) / 4 + 0.025, -0.09);
    for (let c = 0; c < 4; c++) {
      const a = s0 + 0.12 + c * ((B.w - 0.24) / 4), b = a + (B.w - 0.24) / 4 - 0.12;
      panel('glass', a, b, base + B.h * 0.55, base + B.h * 0.72, -0.09);
    }
  }
  const W = A.windows, w0 = W.start, w1 = L - W.end;
  panel('glass', w0, w1, base + W.sill, base + W.head, -0.04);
  box('trim', w0 - 0.12, w1 + 0.12, -0.1, 0, base + W.head, base + W.head + 0.12); // head
  const nPanes = Math.max(1, Math.round((w1 - w0) / W.pane));
  for (let k = 0; k <= nPanes; k++) {
    const s = w0 + ((w1 - w0) * k) / nPanes;
    box('trim', s - 0.05, s + 0.05, -0.1, 0, base + W.sill, base + W.head);
  }
  const Pl = A.planter;
  box('planter', w0, w1, -Pl.out, 0, base, base + Pl.h);
  const shrubs = [];
  for (let s = w0 + 0.5; s < w1 - 0.3; s += 0.9) shrubs.push([s, -Pl.out / 2]);
  for (const [s, t] of shrubs) {
    // a low octahedron of shrub on the planter
    const c = F(s, t, base + Pl.h + 0.28), r = 0.42, h = 0.3;
    const ring4 = [0, 1, 2, 3].map((q) => { const a = (q * Math.PI) / 2 + s; return [c[0] + Math.cos(a) * r, c[1], c[2] + Math.sin(a) * r]; });
    const up = [c[0], c[1] + h, c[2]], down = [c[0], c[1] - h * 0.9, c[2]];
    for (let q = 0; q < 4; q++) { tri('shrub', ring4[q], ring4[(q + 1) % 4], up); tri('shrub', ring4[(q + 1) % 4], ring4[q], down); }
  }
  const S = A.sign, s0 = S.start, s1 = L - S.end;
  box('sign', s0, s1, -S.out, -0.02, base + S.y0, base + S.y1);
  // the sign's face (lettered at run time): bottom-left, bottom-right, top-right, top-left, just in front of the box
  const sign = [F(s0, -S.out - 0.01, base + S.y0), F(s1, -S.out - 0.01, base + S.y0), F(s1, -S.out - 0.01, base + S.y1), F(s0, -S.out - 0.01, base + S.y1)];

  // ---- the east corner: the glass entrance on the edge after the front, and the cream door on Rogers St ----
  const next = edges[(front.i + (front.b === B0 ? 1 : n - 1)) % n];
  const onEdge = (e, from, f, y, out) => {
    // a point `f` of the way along edge e from its end `from`, `out` metres outside it, at height y
    const [p, q] = from === e.a ? [e.a, e.b] : [e.b, e.a];
    return [p[0] + (q[0] - p[0]) * f + e.nx * out, y, p[1] + (q[1] - p[1]) * f + e.nz * out];
  };
  const doorOn = (e, from, f0, f1, y0, y1, out, m) => quad(m, onEdge(e, from, f0, y0, out), onEdge(e, from, f1, y0, out), onEdge(e, from, f1, y1, out), onEdge(e, from, f0, y1, out));
  const Ent = A.entrance, mE = Ent.margin / next.l;
  doorOn(next, B0, mE, 1 - mE, base, base + Ent.h, 0.05, 'glass');
  for (const f of [mE, 0.5, 1 - mE]) doorOn(next, B0, f - 0.04 / next.l, f + 0.04 / next.l, base, base + Ent.h, 0.07, 'metal');
  doorOn(next, B0, mE, 1 - mE, base + Ent.h, base + Ent.h + 0.1, 0.07, 'metal');
  const far = next.a === B0 ? next.b : next.a;
  const side = edges[(next.i + (next.a === far ? n - 1 : 1)) % n];
  const Sd = A.sideDoor, half = Sd.w / 2 / side.l;
  doorOn(side, far, Sd.at - half - 0.15 / side.l, Sd.at + half + 0.15 / side.l, base, base + Sd.h + 0.15, 0.04, 'trim');
  doorOn(side, far, Sd.at - half, Sd.at + half, base, base + Sd.h, 0.07, 'door');
  for (let r = 1; r < 4; r++) doorOn(side, far, Sd.at - half, Sd.at + half, base + (Sd.h * r) / 4 - 0.025, base + (Sd.h * r) / 4 + 0.025, 0.08, 'groove');

  // ---- the workshop's tall multi-pane windows down its long sides ----
  const R = A.rearWindows;
  let rearWindows = 0;
  for (let i = 0; i < rearRing.length; i++) {
    const a = rearRing[i], b = rearRing[(i + 1) % rearRing.length], d = sub(b, a), l = len(d);
    if (l < R.minEdge) continue;
    let nx = d[1] / l, nz = -d[0] / l;
    if (inRing(ring, (a[0] + b[0]) / 2 + nx * 0.1, (a[1] + b[1]) / 2 + nz * 0.1)) { nx = -nx; nz = -nz; }
    if (Math.abs(nx) < 0.8) continue; // the east and west sides only
    const at = (s, y, o) => [a[0] + (d[0] / l) * s + nx * o, y, a[1] + (d[1] / l) * s + nz * o];
    for (let s = R.margin; s + R.w <= l - R.margin + 1e-6; s += R.every) {
      quad('glass', at(s, base + R.y0, 0.05), at(s + R.w, base + R.y0, 0.05), at(s + R.w, base + R.y1, 0.05), at(s, base + R.y1, 0.05));
      for (let c = 0; c <= 3; c++) {
        const m = s + (R.w * c) / 3;
        quad('metal', at(m - 0.04, base + R.y0, 0.08), at(m + 0.04, base + R.y0, 0.08), at(m + 0.04, base + R.y1, 0.08), at(m - 0.04, base + R.y1, 0.08));
      }
      for (let r = 0; r <= 5; r++) {
        const y = base + R.y0 + ((R.y1 - R.y0) * r) / 5;
        quad('metal', at(s, y - 0.04, 0.08), at(s + R.w, y - 0.04, 0.08), at(s + R.w, y + 0.04, 0.08), at(s, y + 0.04, 0.08));
      }
      rearWindows++;
    }
  }

  // ---- the apron (weathered asphalt draped on the ground) and the repair spot's painted bay lines ----
  const Ap = A.apron;
  const g = (x, z) => (ground ? ground(x, z) : base);
  const apron = { s0: -Ap.west, s1: L + Ap.east, t0: -Ap.out, t1: -0.05 };
  const step = 1;
  const ns = Math.ceil((apron.s1 - apron.s0) / step), nt = Math.ceil((apron.t1 - apron.t0) / step);
  const lift = 0.025;
  const at = (i, j) => {
    const s = apron.s0 + ((apron.s1 - apron.s0) * i) / ns, t = apron.t0 + ((apron.t1 - apron.t0) * j) / nt;
    const [x, z] = P(s, t);
    return [x, g(x, z) + lift, z];
  };
  for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) quad('apron', at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
  const Z = A.zone;
  const line = (sa, ta, sb, tb) => {
    const d = [sb - sa, tb - ta], l = Math.hypot(d[0], d[1]), k = Math.max(1, Math.ceil(l / 0.5));
    const w = 0.06, ox = (-d[1] / l) * w, oz = (d[0] / l) * w;
    for (let m = 0; m < k; m++) {
      const pts = [m / k, (m + 1) / k].map((f) => P(sa + d[0] * f, ta + d[1] * f));
      const y = (p) => g(p[0], p[1]) + lift + 0.01;
      const [p0, p1] = pts;
      const e0 = P(sa + d[0] * (m / k) + ox, ta + d[1] * (m / k) + oz), e1 = P(sa + d[0] * ((m + 1) / k) + ox, ta + d[1] * ((m + 1) / k) + oz);
      const f0 = P(sa + d[0] * (m / k) - ox, ta + d[1] * (m / k) - oz), f1 = P(sa + d[0] * ((m + 1) / k) - ox, ta + d[1] * ((m + 1) / k) - oz);
      quad('paint', [f0[0], y(p0), f0[1]], [f1[0], y(p1), f1[1]], [e1[0], y(p1), e1[1]], [e0[0], y(p0), e0[1]]);
    }
  };
  const b0 = bays[0].s0 - 0.3, b1 = bays[1].s1 + 0.3, bt0 = -0.4, bt1 = -9.5;
  line(b0, bt0, b0, bt1); line(b1, bt0, b1, bt1); line(b0, bt1, b1, bt1);
  line((bays[0].s1 + bays[1].s0) / 2, bt0, (bays[0].s1 + bays[1].s0) / 2, bt1 + 2.5);
  const [zx, zz] = P(Z.s, Z.t);
  const zone = { x: zx, z: zz, r: Z.r, heading: Math.atan2(nIn[0], nIn[1]) }; // facing into the bays

  const tris = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length / 9]));
  return {
    frame: { A: A0, B: B0, u, nIn, length: L }, front: frontRing, rear: rearRing, archRect: { x0, x1, z0, z1 }, top, base,
    parts, sign, zone, apron, bays, stats: { triangles: tris, rearWindows, shrubs: shrubs.length }
  };
}

// Is (x, z) in the repair spot of a plan (or the zone itself)?
const inZone = (zone, x, z) => (x - zone.x) ** 2 + (z - zone.z) ** 2 <= zone.r * zone.r;

export { planBuckley, inZone, APPROX_BUCKLEY, clipHalf, triangulate, insetRing, inRing };
