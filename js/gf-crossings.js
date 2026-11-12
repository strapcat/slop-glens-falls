// CC-006: Glens Falls crosswalks (no three.js; the paint is gf-crosswalk-paint.js). pedestrian-routes.js's own across()
// knows only New York's grid corners; Glens Falls hands it crossingsFor(n) instead (its `crossings` option), which lays
// the crosswalks of a junction of the road network's centreline graph:
//   on every arm of a SIGNALLED junction (the OSM traffic signals, gf-signals.js, as the road network matched them);
//   on the arm of any junction that a SOURCED marked crossing lies on (OSM crossing=marked|zebra|traffic_signals or
//   crossing:markings=yes|zebra|ladder|..., gf-furniture.js; the 24 crossing=traffic_signals of gf-signals.js too).
// A crosswalk crosses its arm's whole road (both ways, both carriageways of a divided road) in the CROSSWALK zone between
// the junction box and the stop lines (road-network.js: 2.5 m), from 2 m back on one sidewalk to 2 m back on the other,
// as New York's tracks do (their first and last 2 m are the curbs people wait at), on two walking lines LINE apart. Its
// track runs along the road's lateral axis (traffic.js laneCoord: e.clx, e.clz), so traffic.js can tell which lane a
// walker is over. Marked crossings away from any junction (mid-block) are painted but not walked: pedestrian-routes.js
// joins tracks only at the network's nodes.

const CROSSWALK = 2.5; // m, road-network.js: the zone between a junction box and its stop lines
const KERB_BACK = 2; // m of sidewalk at each end of a track
const KERB_MIN = 1.8; // m: at least (pedestrian-system.js waits 1.6 m along a crosswalk track, its KERB)
const LINE = 0.75; // m either side of the crosswalk's middle: the two walking lines
const MARKED_REACH = 30; // m: a marked crossing this near a junction may be on one of its arms
const ARM_WIDTH_SLACK = 2.5; // m beyond the road's edge a crossing node may sit (OSM draws it on a centreline)

// The crosswalk across arm `a` of node n (its road's lateral extent, where along the arm, which way is +): null if there
// is no room (a stop line closer than the crosswalk needs)
function armCrossing(n, a) {
  const ux = a.ux, uz = a.uz, lx = -uz, lz = ux;
  let lo = Infinity, hi = -Infinity, along = Infinity, road = null;
  for (const e of [a.in, a.out]) {
    if (!e) continue;
    road = road || e;
    const off = (e.sx - n.x) * lx + (e.sz - n.z) * lz;
    lo = Math.min(lo, off - e.half);
    hi = Math.max(hi, off + e.half);
    // its stop line's distance from the node, along the arm
    const sx = e === a.in ? e.sx + e.dx * e.len : e.sx, sz = e === a.in ? e.sz + e.dz * e.len : e.sz;
    along = Math.min(along, (sx - n.x) * ux + (sz - n.z) * uz);
  }
  if (!road || !(along > CROSSWALK)) return null;
  const d = along - CROSSWALK / 2;
  // + along the road's lateral axis (the coordinate traffic.js measures lanes in)
  const flip = road.rx < -1e-6 || (Math.abs(road.rx) <= 1e-6 && road.rz < 0);
  const clx = flip ? -road.rx : road.rx, clz = flip ? -road.rz : road.rz;
  const s = lx * clx + lz * clz >= 0 ? 1 : -1;
  return { n, arm: a, side: a.side, ux, uz, lx: lx * s, lz: lz * s, lo: s > 0 ? lo : -hi, hi: s > 0 ? hi : -lo, d, cx: n.x + ux * d, cz: n.z + uz * d, half: CROSSWALK / 2 };
}

// The curbs each side of a crosswalk line: from its middle (mx, mz) along -l and +l, the first point on a block
// (blockAt) within REACH; null where there is none
const CURB_REACH = 14;
function curbsAcross(mx, mz, lx, lz, lo, hi, blockAt) {
  const find = (t0, sign) => {
    for (let t = t0; t <= CURB_REACH; t += 0.1) if (blockAt(mx + lx * sign * t, mz + lz * sign * t)) return t;
    return null;
  };
  // start a little inside the road's own edge (OSM's carriageway may be narrower than the drawn curb-to-curb width)
  const a = find(Math.max(0, -lo - 1.5), -1), b = find(Math.max(0, hi - 1.5), 1);
  return a === null || b === null ? null : { lo: -a, hi: b };
}

// marked: [{ x, z, kind, osm }] sourced crossing nodes. blockAt(x, z): gf-blocks.js (the curb islands). onWalk(x, z):
// gf-sidewalks.js (the walk's concrete). Returns { crossingsFor(n), crossingAt(n) (the painted crosswalks at n: [{ cx,
// cz, ux, uz, lx, lz, lo, hi (curb to curb), half, side, sources }]), matched (marked crossings put on an arm, by osm id) }
function createGfCrossings({ marked = [], blockAt = () => null, onWalk = () => true } = {}) {
  const CELL = 64;
  const grid = new Map();
  for (const m of marked) {
    const k = Math.floor(m.x / CELL) * 100000 + Math.floor(m.z / CELL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(m);
  }
  const near = (x, z, r) => {
    const out = [];
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
      for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
        for (const m of grid.get(i * 100000 + j) || []) if (Math.hypot(m.x - x, m.z - z) <= r) out.push(m);
      }
    }
    return out;
  };
  const matched = new Map(); // osm id -> { n, side }
  const cache = new Map();
  // The crosswalks painted at n: every arm of a signalled junction, else the arms a marked crossing lies on
  function crossingAt(n) {
    if (cache.has(n)) return cache.get(n);
    const out = [];
    cache.set(n, out);
    if (!n.general || n.shape || !n.arms || n.arms.length < 2) return out; // a bend: nothing to cross at
    const candidates = near(n.x, n.z, MARKED_REACH);
    for (const a of n.arms) {
      const c = armCrossing(n, a);
      if (!c) continue;
      // a marked crossing on this arm: on the arm's line (within its road and some slack), between the box and a few
      // metres past the stop line
      const sources = [];
      for (const m of candidates) {
        const t = (m.x - n.x) * a.ux + (m.z - n.z) * a.uz;
        const o = (m.x - n.x) * c.lx + (m.z - n.z) * c.lz;
        if (t > 0 && t < c.d + 8 && o >= c.lo - ARM_WIDTH_SLACK && o <= c.hi + ARM_WIDTH_SLACK) sources.push(m);
      }
      if (!n.signal && !sources.length) continue;
      // curb to curb, measured across the drawn blocks (a corner's curb may stand off the edges' own widths)
      const curbs = curbsAcross(c.cx, c.cz, c.lx, c.lz, c.lo, c.hi, blockAt);
      if (curbs) { c.lo = curbs.lo; c.hi = curbs.hi; }
      c.measured = !!curbs;
      for (const m of sources) {
        const prev = matched.get(m.osm);
        const dist = Math.hypot(m.x - c.cx, m.z - c.cz);
        if (!prev || dist < prev.dist) matched.set(m.osm, { n, side: a.side, dist });
      }
      out.push({ ...c, signal: !!n.signal, sources: sources.map((m) => m.osm) });
    }
    return out;
  }
  // pedestrian-routes.js `crossings`: the tracks over n's crosswalks, two walking lines each, from KERB_BACK on the
  // walk one side to KERB_BACK on the other (a little less, down to KERB_MIN, where the walk is narrower there)
  function crossingsFor(n) {
    const out = [];
    for (const c of crossingAt(n)) {
      if (!c.measured) continue;
      for (const line of [-LINE, LINE]) {
        const mx = c.cx + c.ux * line, mz = c.cz + c.uz * line;
        const curbs = curbsAcross(mx, mz, c.lx, c.lz, c.lo, c.hi, blockAt);
        if (!curbs) continue;
        const end = (t, sign) => {
          for (let k = KERB_BACK; k >= KERB_MIN - 1e-9; k -= 0.1) {
            const x = mx + c.lx * (t + sign * k), z = mz + c.lz * (t + sign * k);
            if (onWalk(x, z)) return { x, z };
          }
          return null;
        };
        const a = end(curbs.lo, -1), b = end(curbs.hi, 1);
        if (a && b) out.push({ a, b, side: c.side, line });
      }
    }
    return out;
  }
  // The marked crossings no junction arm took (mid-block, or by a bend): painted across the network edge they lie on,
  // not walked (call after crossingAt has seen every node). Returns [{ crossing, osm }] and the ones on no edge.
  function midBlock(network) {
    const out = [], lost = [];
    for (const m of marked) {
      if (matched.has(m.osm)) continue;
      let best = null, bo = Infinity, inJunction = false;
      for (const e of network.edges) {
        const t = (m.x - e.sx) * e.dx + (m.z - e.sz) * e.dz;
        const o = Math.abs((m.x - e.sx) * e.rx + (m.z - e.sz) * e.rz);
        if (o > e.half + ARM_WIDTH_SLACK) continue;
        if (t < 0 || t > e.len) { if (t > -e.half - ARM_WIDTH_SLACK && t < e.len + e.half + ARM_WIDTH_SLACK) inJunction = true; continue; }
        if (o < bo) { bo = o; best = { e, t }; }
      }
      // not painted: the node is on a road the drive network leaves out (a service way, a path, a road cut at the bbox
      // edge), or inside a junction's core and on none of its arms
      if (!best) { lost.push({ ...m, reason: inJunction ? 'inside a junction, on none of its arms' : 'on no road of the drive network' }); continue; }
      const { e, t } = best;
      const cx = e.sx + e.dx * t, cz = e.sz + e.dz * t;
      const flip = e.rx < -1e-6 || (Math.abs(e.rx) <= 1e-6 && e.rz < 0);
      const lx = flip ? -e.rx : e.rx, lz = flip ? -e.rz : e.rz;
      const curbs = curbsAcross(cx, cz, lx, lz, -e.half, e.half, blockAt);
      out.push({ crossing: { cx, cz, ux: e.dx, uz: e.dz, lx, lz, lo: curbs ? curbs.lo : -e.half, hi: curbs ? curbs.hi : e.half, half: CROSSWALK / 2, signal: false, sources: [m.osm], midBlock: true }, osm: m.osm });
    }
    return { painted: out, lost };
  }
  return { crossingsFor, crossingAt, midBlock, matched, constants: { CROSSWALK, KERB_BACK, KERB_MIN, LINE, MARKED_REACH, ARM_WIDTH_SLACK } };
}

export { createGfCrossings, armCrossing, CROSSWALK, KERB_BACK, LINE };
