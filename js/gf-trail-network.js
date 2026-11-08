// CC-005c: the walking graph of Crandall Park's paths and the Cole's Woods corridor to Thrill Hill (js/gf-trails.js), and
// the Glens Falls adapter that lets the city's own pedestrians (pedestrian-system.js, opt-in `routes`) walk it. No
// three.js, so the Node tests drive exactly what the game runs.
//
// Graph: every accepted edge has two lanes, one per direction, each its polyline offset to the walker's right by
// LANE_OFFSET (so people meeting on a path pass rather than walk through each other; never beyond the path's half width
// less a body's half width) and split into straight tracks pedestrian-system.js walks like any sidewalk track. At a
// graph node the lanes meet by a short connector (under a metre). Routing is a next-hop table over the graph (shortest
// path, metres), so a walker always heads for a reachable node and never loops on an unreachable goal.
//
// Entrances: each entrance (gf-trails.js) is a point on the game's outer sidewalk walking line. The adapter splits the
// sidewalk tracks that pass within ENTRANCE_REACH of it at that point; a walker reaching the split may turn into the
// park there (a straight connector from the sidewalk line to the entrance node's lane, the length the generator
// checked: no street crossing, no new path), and one leaving by that entrance turns back onto the same sidewalk.
//
// Who walks the trails: a fixed, documented share of the existing pedestrians (TRAIL_SHARE: every pedestrian whose
// index is 3 modulo 10, 12 of Glens Falls's 120), with the city's usual randomness for each choice (as pedestrian-routes
// .js). Entering, they pick a target in the component they entered (the hill in the woods; a park node in the park),
// walk there, then leave by an entrance of that component.

const LANE_OFFSET = 0.4; // m right of a path's centre line (a park drive's: 1.0 m)
const BODY_HALF = 0.35; // m: a walker's half width, kept inside the path
const ENTRANCE_REACH = 0.9; // m: sidewalk tracks this near an entrance point are split there (both walking lines)
const ENTER_CHANCE = 0.7; // a trail walker passing an entrance turns in this often
const TRAIL_MOD = 10, TRAIL_REM = 3; // trail walkers: pedestrian index % 10 === 3

const segment = (a, b, extra = {}) => {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  return { ax: a.x, az: a.z, ux: (b.x - a.x) / len, uz: (b.z - a.z) / len, len, node: null, side: 0, line: 0, ...extra };
};

// The polyline [x, z, ...] offset by o to the right of its direction (mitred at its bends, the mitre at most 2o)
function offsetLine(pts, o) {
  const n = pts.length / 2, out = [];
  const dirAt = (i) => { const dx = pts[2 * i + 2] - pts[2 * i], dz = pts[2 * i + 3] - pts[2 * i + 1], l = Math.hypot(dx, dz); return [dx / l, dz / l]; };
  for (let i = 0; i < n; i++) {
    const a = dirAt(Math.max(0, i - 1)), b = dirAt(Math.min(n - 2, i));
    let rx = -(a[1] + b[1]), rz = a[0] + b[0];
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const cos = Math.max(0.5, rx * -b[1] + rz * b[0]);
    out.push({ x: pts[2 * i] + rx * o / cos, z: pts[2 * i + 1] + rz * o / cos });
  }
  return out;
}

function createTrailNetwork(trails) {
  const N = trails.nodes.length / 2;
  const node = (i) => ({ x: trails.nodes[2 * i], z: trails.nodes[2 * i + 1] });
  const edges = trails.edges.map((e, k) => ({ ...e, index: k }));
  const adj = Array.from({ length: N }, () => []);
  for (const e of edges) { adj[e.a].push(e); adj[e.b].push(e); }

  // Lanes: lane[k][0] runs a -> b, lane[k][1] b -> a; each a chain of tracks
  const laneOffset = (e) => (e.kind === 'drive' ? 1.0 : Math.max(0, Math.min(LANE_OFFSET, e.widthM / 2 - BODY_HALF)));
  const lanes = edges.map((e) => [0, 1].map((rev) => {
    let pts = e.pts.slice();
    if (rev) { const r = []; for (let i = pts.length - 2; i >= 0; i -= 2) r.push(pts[i], pts[i + 1]); pts = r; }
    const line = offsetLine(pts, laneOffset(e));
    const tracks = [];
    for (let i = 1; i < line.length; i++) {
      if (Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z) < 1e-3) continue;
      const t = segment(line[i - 1], line[i], { trail: { edge: e.index, rev, kind: e.kind, deck: e.kind === 'footbridge' } });
      if (tracks.length) { tracks[tracks.length - 1].after = t; t.before = tracks[tracks.length - 1]; }
      tracks.push(t);
    }
    return { edge: e, rev, from: rev ? e.b : e.a, to: rev ? e.a : e.b, tracks, start: line[0], end: line[line.length - 1] };
  }));
  const laneFrom = (e, u) => lanes[e.index][e.a === u ? 0 : 1];

  // Components and next hops (Dijkstra from every node: the graph is small)
  const comp = new Array(N).fill(-1);
  let nComp = 0;
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s]; comp[s] = nComp;
    while (stack.length) { const u = stack.pop(); for (const e of adj[u]) { const v = e.a === u ? e.b : e.a; if (comp[v] < 0) { comp[v] = nComp; stack.push(v); } } }
    nComp++;
  }
  const hop = []; // hop[t][u]: the edge to take from u towards t (-1 at t or unreachable)
  const dist = [];
  for (let t = 0; t < N; t++) {
    const d = new Float64Array(N).fill(Infinity), h = new Int32Array(N).fill(-1);
    d[t] = 0;
    const open = [t];
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (d[open[i]] < d[open[bi]]) bi = i;
      const u = open.splice(bi, 1)[0];
      for (const e of adj[u]) {
        const v = e.a === u ? e.b : e.a, nd = d[u] + e.lengthM;
        if (nd < d[v] - 1e-9) { d[v] = nd; h[v] = e.index; open.push(v); }
      }
    }
    hop.push(h); dist.push(d);
  }

  const entrances = trails.entrances.map((en) => ({ ...en, component: comp[en.node] }));
  const entranceAt = new Map(entrances.map((en) => [en.node, en]));
  // A target for a walker entering component c: the hill in its component, else a node chosen by `random` (not an
  // entrance); its exit: an entrance of the same component
  const hillComponent = comp[trails.hill.node];
  function targetIn(c, random) {
    if (c === hillComponent) return trails.hill.node;
    const choices = [];
    for (let u = 0; u < N; u++) if (comp[u] === c && !entranceAt.has(u)) choices.push(u);
    return choices.length ? choices[Math.floor(random() * choices.length)] : entrances.find((en) => en.component === c).node;
  }
  function exitFrom(c, random) {
    const choices = entrances.filter((en) => en.component === c);
    return choices[Math.floor(random() * choices.length)].node;
  }
  // The lane polyline points from node u to node t (for staged walkers: the party)
  function pathPoints(u, t) {
    const pts = [];
    while (u !== t) {
      const k = hop[t][u];
      if (k < 0) return null;
      const lane = laneFrom(edges[k], u);
      for (const tr of lane.tracks) pts.push({ x: tr.ax, z: tr.az, track: tr });
      const last = lane.tracks[lane.tracks.length - 1];
      pts.push({ x: last.ax + last.ux * last.len, z: last.az + last.uz * last.len, track: last });
      u = lane.to;
    }
    return pts;
  }
  return { node, nodes: N, edges, lanes, laneFrom, adj, comp, components: nComp, hop, dist, entrances, entranceAt, targetIn, exitFrom, pathPoints, hillComponent };
}

// Wrap pedestrian-routes.js routes (base) for Glens Falls: sidewalk tracks split at the entrances, and the trails'
// tracks with their own next(). network: road-network.js; net: createTrailNetwork(); random: Math.random by default.
function createTrailRoutes(base, network, net, { random = Math.random } = {}) {
  const pieces = new Map(); // original sidewalk track -> its pieces, split at entrances
  const splitAlong = new Map(); // edge -> along(e) with pieces
  const isTrailWalker = (p) => p && Number.isInteger(p.index) && p.index % TRAIL_MOD === TRAIL_REM;

  function along(e) {
    if (splitAlong.has(e)) return splitAlong.get(e);
    const out = [];
    for (const track of base.along(e)) {
      const cuts = [];
      for (const en of net.entrances) {
        const t = (en.sidewalkX - track.ax) * track.ux + (en.sidewalkZ - track.az) * track.uz;
        if (t < 0.5 || t > track.len - 0.5) continue;
        const d = Math.abs((en.sidewalkX - track.ax) * track.uz - (en.sidewalkZ - track.az) * track.ux);
        if (d <= ENTRANCE_REACH) cuts.push({ t, en });
      }
      if (!cuts.length) { out.push(track); continue; }
      cuts.sort((a, b) => a.t - b.t);
      const list = [];
      let t0 = 0;
      for (const c of [...cuts, { t: track.len, en: null }]) {
        const a = { x: track.ax + track.ux * t0, z: track.az + track.uz * t0 }, b = { x: track.ax + track.ux * c.t, z: track.az + track.uz * c.t };
        const piece = segment(a, b, { edge: track.edge, from: track.from, to: track.to, block: track.block, original: track });
        if (list.length) { list[list.length - 1].after = piece; piece.before = list[list.length - 1]; list[list.length - 1].entranceEnd = cuts[list.length - 1].en; }
        list.push(piece);
        t0 = c.t;
      }
      list[0].before = track.before; list[list.length - 1].after = track.after;
      pieces.set(track, list);
      out.push(...list);
    }
    splitAlong.set(e, out);
    return out;
  }
  // A base leg on an original sidewalk track starts on its first piece (walking forwards) or its last (backwards)
  const mapLeg = (leg) => {
    const ps = pieces.get(leg.track) || (leg.track.edge && (along(leg.track.edge), pieces.get(leg.track)));
    return ps ? { track: leg.dir > 0 ? ps[0] : ps[ps.length - 1], dir: leg.dir } : leg;
  };
  const endPoint = (track, dir) => ({ x: track.ax + track.ux * (dir > 0 ? track.len : 0), z: track.az + track.uz * (dir > 0 ? track.len : 0) });

  // Onto the lane leaving graph node u along edge e, from point a (a connector when they are apart)
  function onto(a, e, u) {
    const lane = net.laneFrom(e, u), legs = [];
    if (Math.hypot(lane.start.x - a.x, lane.start.z - a.z) > 0.01) legs.push({ track: segment(a, lane.start, { trail: { connector: true } }), dir: 1 });
    legs.push({ track: lane.tracks[0], dir: 1 });
    return legs;
  }
  // Leave the trail at entrance node u from point a, back onto the split sidewalk there, continuing either way
  function leave(a, u) {
    const en = net.entranceAt.get(u);
    const sp = { x: en.sidewalkX, z: en.sidewalkZ };
    const choices = [];
    for (const list of pieces.values()) {
      for (const piece of list) {
        if (piece.entranceEnd !== en) continue;
        choices.push(piece.after ? [{ track: piece.after, dir: 1 }] : null, [{ track: piece, dir: -1 }]);
      }
    }
    const go = choices.filter(Boolean);
    if (!go.length) return null;
    const pick = go[Math.floor(random() * go.length)];
    const legs = [];
    const start = endPoint(pick[0].track, pick[0].dir > 0 ? -1 : 1);
    if (Math.hypot(sp.x - a.x, sp.z - a.z) > 0.01) legs.push({ track: segment(a, sp, { trail: { connector: true } }), dir: 1 });
    if (Math.hypot(start.x - sp.x, start.z - sp.z) > 0.01) legs.push({ track: segment(sp, start, { trail: { connector: true } }), dir: 1 });
    return [...legs, ...pick];
  }

  function next(track, dir, goalX, goalZ, p) {
    // on a trail: along the lane, then at its end node the next hop towards the walker's target
    if (track.trail) {
      if (track.trail.connector) {
        // a connector's end is a lane start or a sidewalk point: the legs that follow it were planned with it
        return null;
      }
      if (track.after) return [{ track: track.after, dir: 1 }];
      const lane = net.lanes[track.trail.edge][track.trail.rev];
      const u = lane.to, a = endPoint(track, 1);
      const st = p && p.trail ? p.trail : (p ? (p.trail = { phase: 'out', target: -1, exit: net.exitFrom(net.comp[u], random) }) : { phase: 'out', target: -1, exit: net.exitFrom(net.comp[u], random) });
      if (st.phase === 'in' && u === st.target) { st.phase = 'out'; st.exit = net.exitFrom(net.comp[u], random); }
      if (st.phase === 'out' && u === st.exit) {
        const out = leave(a, u);
        if (out) { if (p) p.trail = null; return out; }
      }
      const goal = st.phase === 'in' ? st.target : st.exit;
      let k = net.hop[goal][u];
      if (k < 0) {
        // at a dead end with nowhere further (or already there): turn round
        k = track.trail.edge;
      }
      return onto(a, net.edges[k], u);
    }
    // on a sidewalk piece ending at an entrance: a trail walker may turn in
    const end = dir > 0 ? track.entranceEnd : track.before && track.before.entranceEnd;
    if (end && isTrailWalker(p) && random() < ENTER_CHANCE) {
      const c = net.comp[end.node];
      const target = net.targetIn(c, random);
      p.trail = { phase: 'in', target, exit: net.exitFrom(c, random) };
      const a = endPoint(track, dir), sp = { x: end.sidewalkX, z: end.sidewalkZ };
      const k = net.hop[target][end.node] >= 0 ? net.hop[target][end.node] : net.adj[end.node][0].index;
      const legs = [];
      if (Math.hypot(sp.x - a.x, sp.z - a.z) > 0.01) legs.push({ track: segment(a, sp, { trail: { connector: true } }), dir: 1 });
      return [...legs, ...onto(sp, net.edges[k], end.node)];
    }
    // through a split point: the next piece of the same sidewalk track
    if (dir > 0 && track.entranceEnd && track.after) return [{ track: track.after, dir: 1 }];
    if (dir < 0 && track.before && track.before.entranceEnd) return [{ track: track.before, dir: -1 }];
    // otherwise the city's own choice from the original track, its legs on the pieces
    const original = track.original || track;
    const path = base.next(original, dir, goalX, goalZ);
    return path ? path.map(mapLeg) : path;
  }

  // Split the sidewalks at every entrance now (leaving needs them whether or not anyone walked there yet)
  for (const en of net.entrances) {
    for (const e of network.edges) {
      const t = Math.max(0, Math.min(e.len, (en.sidewalkX - e.sx) * e.dx + (en.sidewalkZ - e.sz) * e.dz));
      if (Math.hypot(e.sx + e.dx * t - en.sidewalkX, e.sz + e.dz * t - en.sidewalkZ) < e.half + 4) along(e);
    }
  }
  const splitCount = (en) => [...pieces.values()].reduce((n, list) => n + list.filter((q) => q.entranceEnd === en).length, 0);

  return { along, across: base.across, next, canDodge: base.canDodge, pieces, isTrailWalker, splitCount };
}

export { createTrailNetwork, createTrailRoutes, offsetLine, LANE_OFFSET, BODY_HALF, ENTRANCE_REACH, ENTER_CHANCE, TRAIL_MOD, TRAIL_REM };
