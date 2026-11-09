// CC-005c: a FICTIONAL night-time keg party on Thrill Hill (the Camel Humps vicinity Dave marked, in Cole's Woods;
// gf-trails.js hill). It depicts no real event, gathering or person: a scene of the game, placed beside the trail's crest
// because the brief asks for one there. The anchor is the trail's own crest point (gf-trails.js hill: the highest
// terrain point of the accepted hill path). Dave marked the Camel Humps vicinity; the crest (and county ski loop vertex
// #137 beside it) is a provisional interpretation of that mark, not a location he confirmed. Everything
// else (the fire's offset, the circle, the keg, the cups) is a gameplay layout chosen below by a fixed rule, not surveyed.
//
// No three.js: the layout (where the fire, keg, attendees' places and day-time cups go, and the attendees' walking
// paths) and the schedule (who is where, at night and by day) are plain data the Node tests check; gf-thrill-hill.js
// draws them.
//
// Night and day follow the game clock (lighting.js presets): the party is on when the preset's interiorGlow is above
// NIGHT_GLOW, the threshold traffic.js lights vehicle lamps by (twilight and midnight; golden hour and midday are day).

import { createClearance, discRegion, trunkRegions } from './gf-trail-clearance.js';

const SCENE = {
  fictional: true,
  description: 'A fictional night-time keg party at the trail crest of Thrill Hill: a fire, a keg and a small group. By day: a burnt-out fire, ash, charred logs and empty red cups.',
  anchor: 'gf-trails.js hill (crestX, crestZ): the highest terrain point on the accepted hill path (OSM way 1089938465). A provisional interpretation of Dave\'s Camel Humps mark, not a location he confirmed',
  layout: 'gameplay choice by the rule in planThrillHillParty (not surveyed): fire 4.5-7.5 m off the trail centre line where no kept tree trunk is within FIRE_CLEAR and the ground is level enough',
  attendees: 'a bounded group (ATTENDEES at most) of the game\'s own generic people (pedestrians.js), no real person'
};

const NIGHT_GLOW = 0.65; // lighting.js interiorGlow above this: night (traffic.js's vehicle lamp threshold)
const ATTENDEES = 8; // the most people at the party
const FIRE_RING = 0.8; // m: the stone ring's outer radius (its collider)
const FIRE_CLEAR = 3.5; // m: no kept tree trunk this near the fire (no tree is removed for the party)
const TRAIL_CLEAR = 1.0; // m beyond a path's half width: fire ring, keg and attendees stay off the trail
const CIRCLE = 2.3; // m: the attendees' circle round the fire
const KEG_AT = 3.4; // m from the fire
const KEG_R = 0.3, KEG_H = 0.6; // m
const CUPS = 14;
const LEVEL = 0.6; // m: the most the ground may rise or fall across the fire's circle
const BODY = 0.35; // m: an attendee's half width
const WALK_SPEED = 1.25; // m/s
const STAGGER = 1.6; // s between attendees setting off
const APPROACH = 45; // m: attendees arrive along at least this much of the trail (and leave the same way)

const WAY_MARGIN = 0.1; // m: planned beyond BODY from the fire ring, the keg and trunks (the tests hold BODY exactly)
const WAY_CELL = 0.25; // m: the route search's grid

// The shortest 8-connected grid route from a to b (points) whose cells all keep `clear` (m) from every obstacle of
// `blockers` (gf-trail-clearance.js), then pulled straight wherever the straight line (swept by that radius) is clear.
// Every piece of the result is checked whole, as a capsule, so the route is clear along its full length. null if none.
function routeAround(blockers, a, b, clear) {
  const swept = (p, q) => !blockers.capsule(p.x, p.z, q.x, q.z, clear);
  if (swept(a, b)) return [a, b];
  const pad = 8;
  const x0 = Math.min(a.x, b.x) - pad, z0 = Math.min(a.z, b.z) - pad;
  const nx = Math.ceil((Math.max(a.x, b.x) + pad - x0) / WAY_CELL) + 1, nz = Math.ceil((Math.max(a.z, b.z) + pad - z0) / WAY_CELL) + 1;
  const at = (i, j) => ({ x: x0 + i * WAY_CELL, z: z0 + j * WAY_CELL });
  const cellOf = (p) => [Math.round((p.x - x0) / WAY_CELL), Math.round((p.z - z0) / WAY_CELL)];
  const free = new Int8Array(nx * nz).fill(-1);
  const isFree = (i, j) => {
    const k = j * nx + i;
    if (free[k] < 0) { const p = at(i, j); free[k] = blockers.capsule(p.x, p.z, p.x, p.z, clear) ? 0 : 1; }
    return free[k] === 1;
  };
  const [si, sj] = cellOf(a), [gi, gj] = cellOf(b);
  const g = new Float64Array(nx * nz).fill(Infinity), prev = new Int32Array(nx * nz).fill(-1);
  // a binary heap of [f, cell]
  const heap = [];
  const push = (f, k) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const h = (i, j) => Math.hypot(i - gi, j - gj) * WAY_CELL;
  const s0 = sj * nx + si, goal = gj * nx + gi;
  g[s0] = 0; push(h(si, sj), s0);
  while (heap.length) {
    const [, k] = pop();
    if (k === goal) break;
    const i = k % nx, j = (k - i) / nx;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz || !isFree(ii, jj)) continue;
      if (di && dj && (!isFree(i + di, j) || !isFree(i, j + dj))) continue; // no corner cutting
      const kk = jj * nx + ii, ng = g[k] + Math.hypot(di, dj) * WAY_CELL;
      if (ng < g[kk] - 1e-9) { g[kk] = ng; prev[kk] = k; push(ng + h(ii, jj), kk); }
    }
  }
  if (!Number.isFinite(g[goal])) return null;
  const cells = [];
  for (let k = goal; k >= 0; k = prev[k]) cells.push(at(k % nx, (k - (k % nx)) / nx));
  cells.reverse();
  // the exact ends in place of their cells' centres (each joined only if the join is clear)
  const raw = [a, ...cells.slice(1, -1), b];
  for (let k = 0; k + 1 < raw.length; k++) if (!swept(raw[k], raw[k + 1])) {
    // an end's join to its cell runs into an obstacle: keep the cell centre between (it is clear) and try again
    raw.splice(k + 1, 0, k === 0 ? cells[0] : cells[cells.length - 1]);
    if (!swept(raw[k], raw[k + 1]) || !swept(raw[k + 1], raw[k + 2])) return null;
    k++;
  }
  // pull straight: from each kept point, on to the farthest point it sees clear
  const out = [raw[0]];
  for (let k = 0; k < raw.length - 1;) {
    let far = k + 1;
    for (let m = raw.length - 1; m > k + 1; m--) if (swept(raw[k], raw[m])) { far = m; break; }
    out.push(raw[far]);
    k = far;
  }
  return out;
}

const hash = (i, salt) => {
  const v = Math.sin(i * 91.3458 + salt * 47.853) * 23421.631;
  return v - Math.floor(v);
};

// The distance from (px, pz) to segment a-b
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

// trails: gf-trails.js; net: gf-trail-network.js createTrailNetwork(trails); ground(x, z): gf-surface.js ground;
// trunks: the kept trees' trunk squares ({ minX, maxX, minZ, maxZ }, gf-tree-placements.js); water(x, z): the water
// surface or null. Returns the layout, or throws if no site fits (the tests would say so).
function planThrillHillParty({ trails, net, ground, trunks, water = () => null }) {
  const { hill } = trails;
  const C = { x: hill.crestX, z: hill.crestZ };
  const near = trunks.filter((t) => Math.abs((t.minX + t.maxX) / 2 - C.x) < 40 && Math.abs((t.minZ + t.maxZ) / 2 - C.z) < 40);
  const trunkGap = (x, z) => {
    let best = Infinity;
    for (const t of near) best = Math.min(best, Math.hypot(Math.max(t.minX - x, 0, x - t.maxX), Math.max(t.minZ - z, 0, z - t.maxZ)));
    return best;
  };
  const nearEdges = trails.edges.filter((e) => { for (let k = 0; k < e.pts.length; k += 2) if (Math.hypot(e.pts[k] - C.x, e.pts[k + 1] - C.z) < 120) return true; return false; });
  const trailGap = (x, z) => {
    let best = Infinity;
    for (const e of nearEdges) for (let k = 0; k + 3 < e.pts.length; k += 2) best = Math.min(best, segDist(x, z, e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3]) - e.widthM / 2);
    return best;
  };
  const relief = (x, z, r) => {
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < 16; a++) for (const f of [0.5, 1]) {
      const y = ground(x + Math.cos(a / 8 * Math.PI) * r * f, z + Math.sin(a / 8 * Math.PI) * r * f);
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    return hi - lo;
  };

  // the crest edge's direction at the crest, and its right-hand normal
  const into = trails.edges.find((e) => e.b === hill.node);
  const n = into.pts.length;
  let ux = into.pts[n - 2] - into.pts[n - 4], uz = into.pts[n - 1] - into.pts[n - 3];
  const ul = Math.hypot(ux, uz); ux /= ul; uz /= ul;
  const nx = -uz, nz = ux;

  // 1. The fire: the first site, in a fixed order (nearest the crest first), that keeps clear of trunks, the trail and
  // water and sits on ground level enough for a circle round it
  let fire = null;
  const tried = [];
  for (const off of [4.5, 5.5, 6.5, 7.5]) {
    for (const along of [0, 1.5, -1.5, 3, -3, 4.5, -4.5, 6, -6]) {
      for (const side of [1, -1]) {
        const x = C.x + ux * along + nx * side * off, z = C.z + uz * along + nz * side * off;
        const why = trunkGap(x, z) < FIRE_CLEAR ? 'tree' : trailGap(x, z) < FIRE_RING + TRAIL_CLEAR ? 'trail'
          : water(x, z) !== null ? 'water' : relief(x, z, CIRCLE + 0.6) > LEVEL ? 'slope' : null;
        tried.push(why);
        if (!why) { fire = { x, z, y: ground(x, z), off, along, side }; break; }
      }
      if (fire) break;
    }
    if (fire) break;
  }
  if (!fire) throw new Error(`no site for the Thrill Hill fire: ${JSON.stringify(tried)}`);

  // 2. The circle: up to ATTENDEES places round the fire, each clear of trunks and the trail, facing the fire
  const placeOk = (x, z, r) => trunkGap(x, z) >= r && trailGap(x, z) >= r + TRAIL_CLEAR - 0.4 && water(x, z) === null;
  const slots = [];
  for (let i = 0; i < ATTENDEES; i++) {
    const a = (i / ATTENDEES) * Math.PI * 2 + 0.2;
    const r = CIRCLE + (hash(i, 1) - 0.5) * 0.4;
    const x = fire.x + Math.cos(a) * r, z = fire.z + Math.sin(a) * r;
    if (!placeOk(x, z, BODY + 0.1)) continue;
    slots.push({ i, x, z, y: ground(x, z), heading: Math.atan2(fire.x - x, fire.z - z) });
  }

  // 3. The keg: the first of 16 places KEG_AT from the fire clear of trunks, the trail and the circle
  let keg = null;
  for (let k = 0; k < 16 && !keg; k++) {
    const a = (k / 16) * Math.PI * 2 + 0.1;
    const x = fire.x + Math.cos(a) * KEG_AT, z = fire.z + Math.sin(a) * KEG_AT;
    if (!placeOk(x, z, KEG_R + 0.3) || slots.some((s) => Math.hypot(s.x - x, s.z - z) < KEG_R + BODY + 0.3)) continue;
    keg = { x, z, y: ground(x, z), r: KEG_R, h: KEG_H };
  }
  if (!keg) throw new Error('no place for the keg');

  // 4. Day: empty red cups scattered round the fire (visual only; never on the trail, in the ring or on the keg)
  const cups = [];
  for (let i = 0; cups.length < CUPS && i < CUPS * 8; i++) {
    const a = hash(i, 2) * Math.PI * 2, r = FIRE_RING + 0.5 + hash(i, 3) * 4.2;
    const x = fire.x + Math.cos(a) * r, z = fire.z + Math.sin(a) * r;
    if (!placeOk(x, z, 0.15) || Math.hypot(x - keg.x, z - keg.z) < KEG_R + 0.2) continue;
    cups.push({ x, z, y: ground(x, z), yaw: hash(i, 4) * Math.PI * 2, lying: hash(i, 5) < 0.7 });
  }

  // 5. The way in and out: along the trail lanes from the first node at least APPROACH m from the crest towards the
  // woods' walkers' entrance (Park View Avenue), to the crest, then by a route round the fire ring, the keg and every
  // kept trunk to each place (routeAround: a grid search, straightened only where the straight line stays clear). The
  // whole way keeps BODY + WAY_MARGIN from each of them; the way out is the same, walked back.
  const crest = hill.node;
  let from = crest, guard = 0;
  const towards = net.entrances.find((en) => en.component === net.comp[crest] && en.street === 'Park View Avenue') || net.entrances.find((en) => en.component === net.comp[crest]);
  while (net.dist[crest][from] < APPROACH && from !== towards.node && guard++ < 100) {
    const k = net.hop[towards.node][from];
    const e = net.edges[k];
    from = e.a === from ? e.b : e.a;
  }
  const lane = (net.pathPoints(from, crest) || []).map((p) => ({ x: p.x, z: p.z }));
  const blockers = createClearance([discRegion(fire.x, fire.z, FIRE_RING, { kind: 'fire' }), discRegion(keg.x, keg.z, KEG_R, { kind: 'keg' }), ...trunkRegions(near)]);
  const start = lane[lane.length - 1];
  const paths = [], placed = [];
  for (const s of slots) {
    const way = routeAround(blockers, start, s, BODY + WAY_MARGIN);
    if (!way) continue; // no clear way to this place: it stays empty (the group is bounded, never forced through)
    const pts = [...lane, ...way.slice(1)];
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    paths.push({ pts, cum, length: cum[cum.length - 1] });
    placed.push(s);
  }
  slots.length = 0;
  slots.push(...placed);

  // colliders (the player's: building-collision.js polygons): the fire's stone ring and the keg
  const disc = (x, z, r, y0, y1, sides = 10) => {
    const outer = [];
    for (let k = 0; k < sides; k++) outer.push({ x: x + Math.cos((k / sides) * Math.PI * 2) * r, z: z + Math.sin((k / sides) * Math.PI * 2) * r });
    return { minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, minY: y0, maxY: y1, polygon: { outer, holes: [] } };
  };
  const colliders = [
    { ...disc(fire.x, fire.z, FIRE_RING, fire.y - 0.5, fire.y + 0.6, 12), party: 'fire' },
    { ...disc(keg.x, keg.z, KEG_R, keg.y - 0.3, keg.y + KEG_H, 10), party: 'keg' }
  ];
  return { scene: SCENE, crest: C, fire, keg, slots, cups, paths, from, colliders,
    constants: { NIGHT_GLOW, ATTENDEES, FIRE_RING, FIRE_CLEAR, TRAIL_CLEAR, CIRCLE, KEG_AT, CUPS, WALK_SPEED, STAGGER, APPROACH },
    clearance: { fireTrunkM: trunkGap(fire.x, fire.z), fireTrailM: trailGap(fire.x, fire.z), fireReliefM: relief(fire.x, fire.z, CIRCLE + 0.6) } };
}

const isNight = (interiorGlow) => interiorGlow > NIGHT_GLOW;

// The attendees' schedule: each 'away' (not drawn), 'arriving' (s metres along its path), 'at' its place or 'leaving'
// (s metres back from its place). setNight(true) sends them in, setNight(false) out (in a fixed stagger); asked again
// it changes nothing, so no attendee is ever doubled. instant (the scene's first setting): everyone already in place
// at night, gone by day.
function createPartySchedule(plan) {
  const people = plan.slots.map((slot, k) => ({ k, slot, path: plan.paths[k], phase: 'away', s: 0, wait: 0, x: NaN, z: NaN, heading: 0 }));
  let night = null;
  function place(p) {
    if (p.phase === 'at' || p.phase === 'away') { p.x = p.slot.x; p.z = p.slot.z; p.heading = p.slot.heading; return; }
    const { pts, cum, length } = p.path;
    const d = Math.max(0, Math.min(length, p.phase === 'arriving' ? p.s : length - p.s));
    let k = 1;
    while (k < pts.length - 1 && cum[k] < d) k++;
    const a = pts[k - 1], b = pts[k], f = (d - cum[k - 1]) / Math.max(1e-9, cum[k] - cum[k - 1]);
    p.x = a.x + (b.x - a.x) * f; p.z = a.z + (b.z - a.z) * f;
    const dir = p.phase === 'arriving' ? 1 : -1;
    p.heading = Math.atan2((b.x - a.x) * dir, (b.z - a.z) * dir);
  }
  function setNight(on, { instant = false } = {}) {
    on = !!on;
    if (night === on && !instant) return false;
    night = on;
    for (const p of people) {
      if (instant) { p.phase = on ? 'at' : 'away'; p.s = 0; p.wait = 0; }
      else if (on && (p.phase === 'away' || p.phase === 'leaving')) {
        // turn round where they are (a leaver s back from its place is length - s along the way in)
        p.s = p.phase === 'leaving' ? p.path.length - p.s : 0;
        p.wait = p.phase === 'leaving' ? 0 : p.k * STAGGER;
        p.phase = 'arriving';
      } else if (!on && (p.phase === 'at' || p.phase === 'arriving')) {
        p.s = p.phase === 'arriving' ? p.path.length - p.s : 0;
        p.wait = p.phase === 'arriving' ? 0 : p.k * STAGGER * 0.5;
        p.phase = 'leaving';
      }
      place(p);
    }
    return true;
  }
  function update(dt) {
    for (const p of people) {
      if (p.phase === 'arriving' || p.phase === 'leaving') {
        if (p.wait > 0) { p.wait = Math.max(0, p.wait - dt); if (p.wait > 0) { place(p); continue; } }
        p.s += WALK_SPEED * dt;
        if (p.s >= p.path.length) { p.phase = p.phase === 'arriving' ? 'at' : 'away'; p.s = 0; }
      }
      place(p);
    }
  }
  // who is drawn: in place, or on the way and not still waiting to set off from the far end
  const visible = (p) => p.phase === 'at' || ((p.phase === 'arriving' || p.phase === 'leaving') && !(p.phase === 'arriving' && p.wait > 0));
  const counts = () => people.reduce((c, p) => ((c[p.phase] = (c[p.phase] || 0) + 1), c), {});
  return { people, setNight, update, visible, counts, get night() { return night; } };
}

export { planThrillHillParty, createPartySchedule, routeAround, isNight, BODY as ATTENDEE_BODY, SCENE as THRILL_HILL_SCENE, NIGHT_GLOW, ATTENDEES, FIRE_CLEAR, FIRE_RING };
