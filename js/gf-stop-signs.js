// CC-006: Glens Falls stop signs (no three.js; drawn by gf-street-furniture-meshes.js). Two kinds, kept apart:
//   SOURCED   OSM highway=stop and traffic_sign=stop nodes (gf-furniture.js; modern OSM, not 1993), each put on the
//             approach of the road network it stands on: the arm of the nearest junction whose road passes the node,
//             within NODE_REACH of the junction. A node at the junction itself, or tagged stop=all, stops every arm
//             arriving there (all-way); on an arm, the traffic arriving over that arm. Nodes that find no junction
//             approach are reported (unmatched), not placed.
//   INFERRED  at every other junction of three or more arms with no signal, no OSM stop and no OSM give-way near it,
//             where a minor road meets a higher-class one: the approaches of a road of a lower OSM highway class than
//             the junction's highest (classOf, by gf-roadgraph.js driveLinks) get a stop, if traffic.js does not
//             already let it go first (right-of-way group 0) and it is not the top-class road itself going on (its
//             class tag changing at the junction). Two roads of one class: no inferred stop (there is nothing to say
//             which would have one). A rule, not a survey: Dave may tighten it.
// Each sign stands on the right-hand curb of its approach, SET_BACK before the stop line, facing the arriving traffic;
// its approach edge is returned so traffic.js can stop there (edge.stopSign, opt-in).

const NODE_REACH = 25; // m: an OSM stop this near a junction is one of its approaches
const AT_NODE = 6; // m: ... this near, it is on the junction itself
const ARM_SLACK = 3; // m beyond an arm's road edge the node may be drawn
const GIVE_WAY_REACH = 25; // m: a give-way this near a junction keeps an inferred stop off it
const SET_BACK = 0.6; // m before the stop line
const CURB_REACH = 10; // m: the curb beside the stop line is looked for this far out

// OSM highway classes, highest first (gf-roadgraph.js DRIVE_CLASSES)
const CLASS_RANK = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street'];
const rankOf = (highway) => {
  const base = String(highway || '').replace(/_link$/, '');
  const i = CLASS_RANK.indexOf(base);
  return i < 0 ? CLASS_RANK.length : i;
};
// classOf(edge) from the drive links (gf-roadgraph.js driveLinks: { highway, pts }): the class rank (0 highest) of the
// link nearest the edge's middle
function edgeClasses(links) {
  const CELL = 40, grid = new Map();
  for (const l of links) {
    const r = rankOf(l.highway);
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1];
      const seg = [ax, az, bx, bz, r];
      for (let x = Math.floor(Math.min(ax, bx) / CELL) - 1; x <= Math.floor(Math.max(ax, bx) / CELL) + 1; x++) {
        for (let z = Math.floor(Math.min(az, bz) / CELL) - 1; z <= Math.floor(Math.max(az, bz) / CELL) + 1; z++) {
          const k = x * 100000 + z;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(seg);
        }
      }
    }
  }
  const dist = (px, pz, [ax, az, bx, bz]) => {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    return Math.hypot(px - ax - dx * t, pz - az - dz * t);
  };
  return (e) => {
    const x = e.sx + e.dx * e.len / 2, z = e.sz + e.dz * e.len / 2;
    let best = CLASS_RANK.length, bd = Infinity;
    for (const seg of grid.get(Math.floor(x / CELL) * 100000 + Math.floor(z / CELL)) || []) {
      const d = dist(x, z, seg);
      if (d < bd) { bd = d; best = seg[4]; }
    }
    return best;
  };
}

// stops: [{ x, z, osm, all, direction }] (OSM highway=stop + traffic_sign=stop); giveWays: [{ x, z, osm }]. network:
// road-network.js's (its nodes' arms, sides and groups). blockAt(x, z): the curb islands (gf-blocks.js), to find the curb.
// classOf(edge): its OSM class rank (edgeClasses); none: the right-of-way groups alone decide (group 0 the major road)
function placeStopSigns({ network, stops = [], giveWays = [], blockAt = null, classOf = null }) {
  const junctions = network.nodes.filter((n) => n.general && !n.shape && n.arms && n.arms.length >= 3);
  const nearest = (x, z, r) => {
    let best = null, bd = r;
    for (const n of junctions) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) { bd = d; best = n; }
    }
    return best ? { n: best, d: bd } : null;
  };
  // the arm of n whose road passes (x, z): along it, within its road's width (and some slack)
  const armAt = (n, x, z) => {
    let best = null, bo = Infinity;
    for (const a of n.arms) {
      const t = (x - n.x) * a.ux + (z - n.z) * a.uz;
      const o = Math.abs((x - n.x) * -a.uz + (z - n.z) * a.ux);
      if (t <= 0 || o > a.half + ARM_SLACK) continue;
      if (o < bo) { bo = o; best = a; }
    }
    return best;
  };

  const stopEdges = new Map(); // approach edge -> { kind, osm }
  const unmatched = [];
  const osmNodes = new Set();
  for (const s of stops) {
    const near = nearest(s.x, s.z, NODE_REACH);
    if (!near) { unmatched.push({ ...s, reason: 'no junction within reach' }); continue; }
    const { n, d } = near;
    let edges = [];
    if (s.all || d < AT_NODE) {
      edges = n.in.slice();
      // at the node but not all-way: the minor roads' approaches, if any (OSM draws a two-way stop on the junction node)
      if (!s.all) {
        const minor = edges.filter((e) => e.axisIndex !== 0);
        if (minor.length) edges = minor;
      }
    } else {
      const a = armAt(n, s.x, s.z);
      if (!a) { unmatched.push({ ...s, reason: 'not on an approach' }); continue; }
      if (!a.in) { unmatched.push({ ...s, reason: 'its road only leaves the junction (one-way)' }); continue; }
      edges = [a.in];
    }
    if (!edges.length) { unmatched.push({ ...s, reason: 'no arriving road' }); continue; }
    osmNodes.add(n);
    for (const e of edges) if (!stopEdges.has(e)) stopEdges.set(e, { kind: 'osm', osm: s.osm, all: !!s.all });
  }
  // inferred: the remaining unsignalled junctions without an OSM stop or give-way
  const giveWayNodes = new Set();
  for (const g of giveWays) {
    const near = nearest(g.x, g.z, GIVE_WAY_REACH);
    if (near) giveWayNodes.add(near.n);
  }
  const skipped = { signal: 0, osmStop: 0, giveWay: 0, oneRoad: 0, sameClass: 0 };
  let inferredJunctions = 0;
  for (const n of junctions) {
    if (n.signal) { skipped.signal++; continue; }
    if (osmNodes.has(n)) { skipped.osmStop++; continue; }
    if (giveWayNodes.has(n)) { skipped.giveWay++; continue; }
    let minor = n.in.filter((e) => e.axisIndex !== 0);
    if (!minor.length || minor.length === n.in.length) { skipped.oneRoad++; continue; }
    if (classOf) {
      const top = Math.min(...n.in.concat(n.out).map(classOf));
      // the road(s) of the top class: their arms' right-of-way groups (a road continuing through the junction whose
      // OSM class changes there stays one road, and does not stop)
      const major = new Set(n.arms.filter((a) => [a.in, a.out].some((e) => e && classOf(e) === top)).map((a) => a.group));
      minor = minor.filter((e) => classOf(e) > top && !major.has(e.axisIndex));
      if (!minor.length) { skipped.sameClass++; continue; }
    }
    inferredJunctions++;
    for (const e of minor) if (!stopEdges.has(e)) stopEdges.set(e, { kind: 'inferred' });
  }

  // where each sign stands: the curb on the approach's right, SET_BACK before its stop line
  const signs = [];
  for (const [e, info] of stopEdges) {
    const s = Math.max(0, e.len - SET_BACK);
    const px = e.sx + e.dx * s, pz = e.sz + e.dz * s;
    let off = e.half + 0.8, curb = !blockAt;
    if (blockAt) {
      for (let t = Math.max(0, e.half - 1.5); t <= CURB_REACH; t += 0.1) {
        if (blockAt(px + e.rx * t, pz + e.rz * t)) { off = t + 0.45; curb = true; break; }
      }
    }
    // no curb beside the stop line (a bridge, an open lot edge): the approach still stops, but no post is drawn in the road
    signs.push({ x: px + e.rx * off, z: pz + e.rz * off, dx: -e.dx, dz: -e.dz, edge: e, curb, ...info });
  }
  const count = (k) => signs.filter((g) => g.kind === k).length;
  const drawn = signs.filter((g) => g.curb);
  return {
    signs,
    drawn,
    stopEdges,
    unmatched,
    counts: { osmSigns: count('osm'), inferredSigns: count('inferred'), drawn: drawn.length, osmMatched: stops.length - unmatched.length, osmUnmatched: unmatched.length, inferredJunctions, junctions: junctions.length, skipped }
  };
}

export { placeStopSigns, edgeClasses, rankOf, CLASS_RANK, NODE_REACH, AT_NODE, GIVE_WAY_REACH, SET_BACK };
