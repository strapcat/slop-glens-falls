import * as THREE from 'three/webgpu';
import { FACADES } from './gf-facades.js';
import { APPROX_OBELISK } from './gf-landmark-records.js';

// Simple procedural landmark shapes (CC-004) for the features gf-landmark-records.js resolves: no textures, no new
// shader, only the stone and trim colours of the feature's facade style (FACADES). The pure geometry helpers below
// return triangle soups ({ body, trim } position arrays) that tests check without three.js; buildGfLandmarkFeatures()
// merges every feature into one mesh per material.
//
// Only a feature's base and top heights (and the monument's position) are sourced. Every other size is a named
// APPROX_* constant: approximate, not sourced.
const APPROX_SPIRE_BASE = 4.0; // approximate, not sourced: a spire's square base width (m)
const APPROX_TOWER_W = 5.0; // approximate, not sourced: a tower's square width (m)
const APPROX_CLOCK_D = 2.4; // approximate, not sourced: a clock face's diameter (m)
const APPROX_DOME_D = 8.0; // approximate, not sourced: a dome's diameter when the data gives none (m)
const APPROX_STACK_R = [2.0, 1.2]; // approximate, not sourced: a smokestack's radius at its foot and its top (m)
const APPROX_CROSS = { w: 1.2, t: 0.22 }; // approximate, not sourced: the spire cross's arm span and bar thickness (m)
// The cross on top of a spire is 2.1 m tall: First Presbyterian's flèche is 140 ft plus a 7 ft Celtic cross
// (gf_landmarks.json), its only spire
const SPIRE_CROSS_H = 2.1;
const ROOF_MIN_FILL = 0.9; // a gable or hip roof only over a footprint filling 90% of its bounding rectangle

// ---- triangle soup builders (each pushes x, y, z triples, three per triangle) ----
const tri = (out, a, b, c) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
const quad = (out, a, b, c, d) => { tri(out, a, b, c); tri(out, a, c, d); };

// A square frustum around (x, z) from y0 (width w0) to y1 (width w1, 0 = a pyramid), turned by `rot` radians
function frustum(out, x, z, y0, y1, w0, w1, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const ring = (y, w) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [x + (u * c - v * s) * w / 2, y, z + (u * s + v * c) * w / 2]);
  const b = ring(y0, w0), t = ring(y1, w1);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    if (w1 > 0) quad(out, b[i], b[j], t[j], t[i]);
    else tri(out, b[i], b[j], t[i]);
  }
  quad(out, b[3], b[2], b[1], b[0]);
  if (w1 > 0) quad(out, t[0], t[1], t[2], t[3]);
}
// A box: a frustum with equal ends
const box = (out, x, z, y0, y1, w, rot = 0) => frustum(out, x, z, y0, y1, w, w, rot);
// An axis-aligned box of width wx, depth wz
function slab(out, x, z, y0, y1, wx, wz) {
  const p = (u, y, v) => [x + u * wx / 2, y, z + v * wz / 2];
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(out, p(c[i][0], y0, c[i][1]), p(c[j][0], y0, c[j][1]), p(c[j][0], y1, c[j][1]), p(c[i][0], y1, c[i][1]));
  }
  quad(out, p(-1, y0, -1), p(-1, y0, 1), p(1, y0, 1), p(1, y0, -1));
  quad(out, p(-1, y1, -1), p(1, y1, -1), p(1, y1, 1), p(-1, y1, 1));
}
// A tapered cylinder (n sides) from y0 (radius r0) to y1 (radius r1), capped
function cylinder(out, x, z, y0, y1, r0, r1, n = 16) {
  const at = (k, y, r) => [x + Math.cos((k / n) * Math.PI * 2) * r, y, z + Math.sin((k / n) * Math.PI * 2) * r];
  for (let k = 0; k < n; k++) {
    quad(out, at(k, y0, r0), at(k + 1, y0, r0), at(k + 1, y1, r1), at(k, y1, r1));
    tri(out, [x, y0, z], at(k + 1, y0, r0), at(k, y0, r0));
    tri(out, [x, y1, z], at(k, y1, r1), at(k + 1, y1, r1));
  }
}
// A half ellipsoid (a dome) of radius r over (x, z), from y0 up to y1
function dome(out, x, z, y0, y1, r, n = 16, rings = 8) {
  const at = (k, j) => {
    const phi = (j / rings) * Math.PI / 2, th = (k / n) * Math.PI * 2;
    return [x + Math.cos(th) * Math.cos(phi) * r, y0 + Math.sin(phi) * (y1 - y0), z + Math.sin(th) * Math.cos(phi) * r];
  };
  for (let j = 0; j < rings; j++) for (let k = 0; k < n; k++) quad(out, at(k, j), at(k + 1, j), at(k + 1, j + 1), at(k, j + 1));
}
// A flat disc of radius r centred at c, in the vertical plane facing (nx, nz)
function disc(out, c, nx, nz, r, n = 16) {
  const tx = -nz, tz = nx;
  const at = (k) => {
    const a = (k / n) * Math.PI * 2;
    return [c[0] + tx * Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2] + tz * Math.cos(a) * r];
  };
  for (let k = 0; k < n; k++) tri(out, c, at(k), at(k + 1));
}

// ---- footprint helpers for gable and hip roofs ----
const ringArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return Math.abs(a / 2);
};
function convexHull(points) {
  const p = points.map((q) => [q.x, q.z]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half(p.slice().reverse())];
}
// The smallest-area rectangle around a footprint: { cx, cz, angle, long, short } (long along the angle)
function minAreaRect(polygon) {
  const hull = convexHull(polygon.outer);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, az] = hull[i], [bx, bz] = hull[(i + 1) % hull.length];
    const angle = Math.atan2(bz - az, bx - ax), c = Math.cos(angle), s = Math.sin(angle);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [px, pz] of hull) {
      const u = px * c + pz * s, v = -px * s + pz * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      const r = u1 - u0 >= v1 - v0
        ? { angle, long: u1 - u0, short: v1 - v0 }
        : { angle: angle + Math.PI / 2, long: v1 - v0, short: u1 - u0 };
      best = { area, cx: um * c - vm * s, cz: um * s + vm * c, ...r };
    }
  }
  return best;
}

// A gable (hip = false) or hip roof over the footprint's minimum-area rectangle, eaves at y0 and the ridge at y1; null
// with the reason when the footprint fills less than ROOF_MIN_FILL of the rectangle
function pitchedRoof(body, trim, polygon, y0, y1, hip) {
  const r = minAreaRect(polygon);
  const fill = (ringArea(polygon.outer) - polygon.holes.reduce((s, h) => s + ringArea(h), 0)) / r.area;
  if (!(fill >= ROOF_MIN_FILL)) return `footprint fills ${(fill * 100).toFixed(0)}% of its rectangle (under ${ROOF_MIN_FILL * 100}%)`;
  const c = Math.cos(r.angle), s = Math.sin(r.angle);
  const p = (u, y, v) => [r.cx + u * c - v * s, y, r.cz + u * s + v * c];
  const L = r.long / 2, W = r.short / 2, R = hip ? Math.max(0, L - W) : L;
  // the two long slopes
  quad(trim, p(-L, y0, -W), p(L, y0, -W), p(R, y1, 0), p(-R, y1, 0));
  quad(trim, p(L, y0, W), p(-L, y0, W), p(-R, y1, 0), p(R, y1, 0));
  // the ends: gable walls (body) or hipped slopes (trim)
  tri(hip ? trim : body, p(-L, y0, W), p(-L, y0, -W), p(-R, y1, 0));
  tri(hip ? trim : body, p(L, y0, -W), p(L, y0, W), p(R, y1, 0));
  return null;
}

// { body, trim } triangle soups of one resolved feature ({ type, x, z, base, top, polygon?, diameter? }), or
// { skipped } with the reason. Every shape spans exactly base..top.
function featureGeometry(f) {
  const body = [], trim = [];
  const { x, z, base, top } = f;
  switch (f.type) {
    case 'spire': {
      const crossH = Math.min(SPIRE_CROSS_H, (top - base) / 3);
      const tip = top - crossH;
      frustum(body, x, z, base, tip, APPROX_SPIRE_BASE, 0);
      box(trim, x, z, tip - 0.3, top, APPROX_CROSS.t);
      slab(trim, x, z, top - crossH * 0.45, top - crossH * 0.45 + APPROX_CROSS.t, APPROX_CROSS.w, APPROX_CROSS.t);
      break;
    }
    case 'tower':
      box(body, x, z, base, top, APPROX_TOWER_W);
      break;
    case 'clock-tower': {
      box(body, x, z, base, top, APPROX_TOWER_W);
      const r = Math.min(APPROX_CLOCK_D / 2, (top - base) / 4);
      const y = top - r - 0.6;
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) disc(trim, [x + nx * (APPROX_TOWER_W / 2 + 0.03), y, z + nz * (APPROX_TOWER_W / 2 + 0.03)], nx, nz, r);
      break;
    }
    case 'dome':
      dome(body, x, z, base, top, (f.diameter || APPROX_DOME_D) / 2);
      break;
    case 'smokestack':
      cylinder(body, x, z, base, top, APPROX_STACK_R[0], APPROX_STACK_R[1]);
      break;
    case 'gable':
    case 'hip': {
      if (!f.polygon) return { skipped: 'no footprint' };
      const why = pitchedRoof(body, trim, f.polygon, base, top, f.type === 'hip');
      if (why) return { skipped: why };
      break;
    }
    case 'obelisk': {
      const o = APPROX_OBELISK;
      const shaftTop = top - o.eagleH - o.pyramidionH;
      if (!(shaftTop > base + o.plinthH)) throw new Error(`obelisk ${f.id}: ${top} m is too short for its plinth, pyramidion and eagle`);
      box(body, x, z, base, base + o.plinthH, o.plinthW);
      frustum(body, x, z, base + o.plinthH, shaftTop, o.shaftBottomW, o.shaftTopW);
      frustum(body, x, z, shaftTop, shaftTop + o.pyramidionH, o.shaftTopW, o.pyramidionTopW);
      box(trim, x, z, shaftTop + o.pyramidionH, top, o.eagleW);
      break;
    }
    default:
      throw new Error(`no shape for feature type ${f.type}`);
  }
  return { body, trim };
}

// The resolved features (applyGfLandmarks) as procedural meshes, one per material; { group, stats }
function buildGfLandmarkFeatures(scene, features) {
  const group = new THREE.Group();
  group.name = 'GlensFallsLandmarkFeatures';
  const parts = new Map(); // `${style}:${role}` -> positions
  const stats = { types: {}, skipped: [], meshes: 0, triangles: 0, approx: { APPROX_SPIRE_BASE, APPROX_TOWER_W, APPROX_CLOCK_D, APPROX_DOME_D, APPROX_STACK_R, APPROX_CROSS, APPROX_OBELISK } };
  for (const f of features) {
    const g = featureGeometry(f);
    if (g.skipped) {
      stats.skipped.push({ id: f.id, type: f.type, reason: g.skipped });
      console.info(`[gf] landmark ${f.id}: ${f.type} skipped, ${g.skipped}`);
      continue;
    }
    stats.types[f.type] = (stats.types[f.type] || 0) + 1;
    for (const role of ['body', 'trim']) {
      if (!g[role].length) continue;
      const key = `${f.style}:${role}`;
      if (!parts.has(key)) parts.set(key, []);
      const list = parts.get(key);
      for (let i = 0; i < g[role].length; i++) list.push(g[role][i]);
    }
  }
  for (const [key, positions] of parts) {
    const [style, role] = key.split(':');
    const tones = FACADES[style] || FACADES.stone;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardNodeMaterial({ color: role === 'body' ? tones.stoneColor : tones.trimColor, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `LandmarkFeatures-${key}`;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    stats.meshes++;
    stats.triangles += positions.length / 9;
  }
  scene.add(group);
  return { group, stats };
}

export { buildGfLandmarkFeatures, featureGeometry, minAreaRect, APPROX_SPIRE_BASE, APPROX_TOWER_W, APPROX_CLOCK_D, APPROX_DOME_D, APPROX_STACK_R, APPROX_CROSS, SPIRE_CROSS_H };
