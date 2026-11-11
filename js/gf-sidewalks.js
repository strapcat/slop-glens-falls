import { GF_DOWNTOWN } from './gf-downtown.js';
import { polygonContains } from './building-collision.js';

// CC-005e: Glens Falls's sidewalks as they look (no three.js; the meshes are gf-sidewalk-meshes.js). Design basis,
// Dave's local knowledge (1993, from memory, not a survey): residential streets mostly had a grass strip (tree lawn)
// between a GRANITE curb and the concrete sidewalk; downtown, concrete ran straight to the granite curb. Downtown is
// the Three Squares envelope (gf-downtown.js, approximate, Dave to confirm); everywhere else is residential.
//
// The width model (tools/gf/build-gf-geodata.mjs buildBlocks): each block's lot (property line) is drawn BAND metres in
// from its curb, the downtown band where the envelope holds the cell and the residential band elsewhere. Measured on
// the regenerated data the property line sits about 0.4 m further in than the parameter (the raster's half cell and
// cell centres), so the bands as built are about 2.2 m downtown and 3.0 m residential. In each band, from the road:
//   the curb      CURB_W of granite, its face REVEAL above the road (the road is ROAD_LIFT above the ground);
//   a tree lawn   whatever is left, when that is at least LAWN_MIN (residential: about 1.2 m, cf. the city's 4 ft snow
//                 strip on Goodwin Ave and NYSDOT's 4-6 ft with trees); less than that (downtown) and the walk runs on to
//                 the curb instead;
//   the walk      WALK_W of concrete (5.4 ft; NYSDOT's preferred 5 ft route) along the property line, in 5 ft flags.
// The walk, lawn and curb top stand TOP above the ground; a RAMP of grass (or the downtown lots' paving) inside the lot
// line takes the step back down to the ground. Only where a road runs beside the curb: along water, the bbox's edge
// or an alley (service roads do not get curbs) the band is left as it was, at ground level.

const SIDEWALK = {
  downtownBand: 1.8, // m, the generator's property-line distance downtown (as CC-001: 1.8)
  residentialBand: 2.8, // m, elsewhere: about 3.0 m as built (curb 0.15 + lawn ~1.2 + walk 1.65)
  curbW: 0.15, // m: the curb's top
  reveal: 0.13, // m: its face above the road surface
  roadLift: 0.03, // m: the draped road over the ground (gf-drape.js ROAD_LIFT)
  walkW: 1.65, // m
  lawnMin: 0.6, // m: a narrower lawn is paved over (the walk runs to the curb)
  ramp: 0.5, // m inside the lot line
  // a corner: within PAD metres (along the lot line) of a lot corner turning at least CORNER_TURN, the walk is paved on
  // to the curb (no lawn), where the walking lines meet and turn the corner; onWalk() takes PAD_R round the corner
  pad: 3.5,
  padR: 4.5,
  cornerTurn: Math.PI / 5,
  // and within JUNCTION_R of a junction of three or more roads (the curb ramps and corner aprons where the walking lines
  // meet the crossings)
  junctionR: 12,
  gutter: 0.45, // m of asphalt drawn beyond the curb face (covers the curb ring's raster offset from the ribbon)
  flag: 1.524, // m: 5 ft flags (tooled joints across the walk)
  // the walking lines (pedestrian-routes.js insets beyond the roadway, insetsFor()): two, LINE_MARGIN inside the walk's
  // road edge and LOT_MARGIN inside its lot line, measured at the edge's middle (downtown about 0.6 and 1.2 m, residential about 1.9 and 2.5 m); one in
  // the middle of a walk too narrow for two; CC-002's 0.6 and 1.2 m where nothing is measured
  lineMargin: 0.45, // m inside the walk's road edge
  lotMargin: 0.7, // m inside the lot line (pedestrian-routes.js keeps a line 0.4 m clear of the lot's raster)
  insets: [0.6, 1.2],
  step: 2 // m between samples along a ring (the terrain is a 1 m grid; strips are draped at every sample)
};
SIDEWALK.top = SIDEWALK.roadLift + SIDEWALK.reveal; // 0.16 m above the ground
SIDEWALK.depressed = SIDEWALK.roadLift + 0.03; // a driveway's curb (OSM service road crossing the band) above the ground

const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
};
const ringArea = (r) => {
  let s = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    s += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return s / 2;
};
const boxOf = (r, pad = 0) => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    minX = Math.min(minX, r[i]); maxX = Math.max(maxX, r[i]);
    minZ = Math.min(minZ, r[i + 1]); maxZ = Math.max(maxZ, r[i + 1]);
  }
  return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
};
const flatPts = (f) => {
  const r = [];
  for (let i = 0; i < f.length; i += 2) r.push({ x: f[i], z: f[i + 1] });
  return r;
};
// Distance from (x, z) to the nearest edge of any flat ring in rings
const ringsDist = (rings, x, z) => {
  let d = Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      const j = (i + 2) % r.length;
      d = Math.min(d, segDist(x, z, r[i], r[i + 1], r[j], r[j + 1]));
    }
  }
  return d;
};

// The downtown envelope: inside one of its loops, or within its frontage of their streets
function createDowntown(dt = GF_DOWNTOWN) {
  const loops = dt.loops.map((l) => ({ ...l, box: boxOf(l.ring, dt.frontage), poly: { outer: flatPts(l.ring), holes: [] } }));
  function contains(x, z) {
    for (const l of loops) {
      const b = l.box;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (polygonContains(l.poly, x, z) || ringsDist([l.ring], x, z) <= dt.frontage) return true;
    }
    return false;
  }
  return { contains, loops, frontage: dt.frontage };
}
const DOWNTOWN = createDowntown();
// The property line's distance from the curb at (x, z), for the geodata generator (buildBlocks)
const sidewalkBandAt = (x, z) => (DOWNTOWN.contains(x, z) ? SIDEWALK.downtownBand : SIDEWALK.residentialBand);
sidewalkBandAt.min = Math.min(SIDEWALK.downtownBand, SIDEWALK.residentialBand);
sidewalkBandAt.max = Math.max(SIDEWALK.downtownBand, SIDEWALK.residentialBand);

// A grid of segments [ax, az, bx, bz, half] for nearest-edge queries
function segmentGrid(segs, cell = 32) {
  const grid = new Map();
  for (const s of segs) {
    const r = s[4] + 6;
    for (let i = Math.floor((Math.min(s[0], s[2]) - r) / cell); i <= Math.floor((Math.max(s[0], s[2]) + r) / cell); i++) {
      for (let j = Math.floor((Math.min(s[1], s[3]) - r) / cell); j <= Math.floor((Math.max(s[1], s[3]) + r) / cell); j++) {
        const k = i * 100000 + j;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(s);
      }
    }
  }
  // the nearest edge (centreline distance less half width) within about 6 m; Infinity beyond
  return (x, z) => {
    let best = Infinity;
    for (const s of grid.get(Math.floor(x / cell) * 100000 + Math.floor(z / cell)) || []) best = Math.min(best, segDist(x, z, s[0], s[1], s[2], s[3]) - s[4]);
    return best;
  };
}

// The game's sidewalks over GF_GEO's blocks (gf-blocks.js createGfBlocks) on the ground (gf-surface.js ground):
//   onWalk(x, z)       on a walk's concrete (pedestrian-routes.js onSidewalk for the walking lines and dodges): on a
//                      block, outside its lot, and not on a tree lawn (a block with no lot: anywhere on it)
//   raiseAt(x, z)      the height of what is drawn there above the ground: TOP on a roadside band (curb, lawn, walk),
//                      the ramp just inside a lot, else 0 (roads, lots, open ground, bands beside water)
//   downtown(x, z)     the envelope
//   rings              each roadside ring as { block, ring (flat), toRoad (+1/-1: which side the road is), kind:
//                      'curb' | 'lot', box } for gf-sidewalk-meshes.js and sample(ring, from, to) its samples
function createGfSidewalks({ geo, blocks, ground }) {
  const S = SIDEWALK;
  const { nodes, links, classes } = geo.roadGraph;
  const service = classes.indexOf('service');
  const roadSegs = [], serviceSegs = [];
  for (const [a, b, , cls, , , width, inner] of links) {
    const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
    for (let i = 0; i + 1 < pts.length; i++) (cls === service ? serviceSegs : roadSegs).push([...pts[i], ...pts[i + 1], width / 2]);
  }
  const roadEdge = segmentGrid(roadSegs);
  const serviceEdge = segmentGrid(serviceSegs);
  // junctions: road-graph nodes where three or more non-service links meet
  const degree = new Map();
  for (const [a, b, , cls] of links) if (cls !== service) for (const v of [a, b]) degree.set(v, (degree.get(v) || 0) + 1);
  const junctionGrid = new Map(), JC = 32;
  for (const [v, d] of degree) {
    if (d < 3) continue;
    const x = nodes[v * 2], z = nodes[v * 2 + 1], k = Math.floor(x / JC) * 100000 + Math.floor(z / JC);
    if (!junctionGrid.has(k)) junctionGrid.set(k, []);
    junctionGrid.get(k).push([x, z]);
  }
  const nearJunction = (x, z) => {
    for (let i = Math.floor((x - S.junctionR) / JC); i <= Math.floor((x + S.junctionR) / JC); i++) {
      for (let j = Math.floor((z - S.junctionR) / JC); j <= Math.floor((z + S.junctionR) / JC); j++) {
        for (const [jx, jz] of junctionGrid.get(i * 100000 + j) || []) if (Math.hypot(x - jx, z - jz) <= S.junctionR) return true;
      }
    }
    return false;
  };

  const curbRings = (b) => b.curbRings || (b.curbRings = [b.polygon.outer, ...b.polygon.holes].map((r) => r.flatMap((p) => [p.x, p.z])));
  const lotRings = (b) => b.lotRings || (b.lotRings = b.lot ? [b.lot.outer, ...b.lot.holes].map((r) => r.flatMap((p) => [p.x, p.z])) : []);
  const inLot = (b, x, z) => !!b.lot && polygonContains(b.lot, x, z);
  // A roadside spot of a band: a road's edge no further than the band (and the curb's raster offset) away
  const roadside = (x, z, curbD) => roadEdge(x, z) < curbD + 1.0;

  // The band's layout at a spot curbD from the curb and lotD from the lot line: the walk's far edge from the lot
  // line, and whether a lawn lies between it and the curb
  function layout(curbD, lotD) {
    const band = curbD + lotD;
    const lawn = band - S.curbW - S.walkW;
    return lawn >= S.lawnMin ? { walkOut: S.walkW, lawn: true } : { walkOut: Math.max(0, band - S.curbW), lawn: false };
  }

  // A block's lot corners: the convex vertices of its lot rings (as seen from the road) turning by CORNER_TURN or more
  const cornersOf = (b) => b.lotCorners || (b.lotCorners = lotRings(b).flatMap((r, i) => convexCorners(r, i === 0 ? 1 : -1)));
  function convexCorners(r, toRoad) {
    const n = r.length / 2, side = toRoad * (ringArea(r) > 0 ? 1 : -1), out = [];
    for (let i = 0; i < n; i++) {
      const h = (i - 1 + n) % n, j = (i + 1) % n;
      const ax = r[i * 2] - r[h * 2], az = r[i * 2 + 1] - r[h * 2 + 1], bx = r[j * 2] - r[i * 2], bz = r[j * 2 + 1] - r[i * 2 + 1];
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      // the turn, positive towards the road's side for a convex corner
      const cross = (ax * bz - az * bx) / (la * lb), dot = (ax * bx + az * bz) / (la * lb);
      const turn = Math.atan2(cross, dot) * side;
      if (turn >= S.cornerTurn) out.push({ x: r[i * 2], z: r[i * 2 + 1], index: i });
    }
    return out;
  }
  const nearCorner = (b, x, z) => cornersOf(b).some((c) => Math.hypot(x - c.x, z - c.z) <= S.padR);

  function onWalk(x, z) {
    const b = blocks.blockAt(x, z);
    if (!b) return false;
    if (!b.lot) return true;
    if (inLot(b, x, z)) return false;
    const lotD = ringsDist(lotRings(b), x, z), curbD = ringsDist(curbRings(b), x, z);
    return lotD <= layout(curbD, lotD).walkOut + 0.05 || nearCorner(b, x, z) || nearJunction(x, z);
  }

  // raiseAt, remembered on a 0.1 m lattice (walkers ask it for every foot they set down)
  const raiseCache = new Map();
  function raiseAt(x, z) {
    const k = Math.round(x * 10) * 1e6 + Math.round(z * 10);
    let v = raiseCache.get(k);
    if (v === undefined) {
      if (raiseCache.size > 200000) raiseCache.clear();
      v = raiseExact(Math.round(x * 10) / 10, Math.round(z * 10) / 10);
      raiseCache.set(k, v);
    }
    return v;
  }
  function raiseExact(x, z) {
    const b = blocks.blockAt(x, z);
    if (!b) return 0;
    const curbD = ringsDist(curbRings(b), x, z);
    if (!b.lot || !inLot(b, x, z)) {
      const lotD = b.lot ? ringsDist(lotRings(b), x, z) : 0;
      if (!roadside(x, z, curbD + lotD)) return 0;
      // a driveway: up from the depressed curb across the apron (a lawn's width) or the walk (downtown)
      if (serviceEdge(x, z) < 0.3) {
        const band = curbD + lotD, { lawn } = layout(curbD, lotD);
        const t = Math.max(0, Math.min(1, curbD / Math.max(0.3, lawn ? band - S.walkW : band)));
        return S.depressed + (S.top - S.depressed) * t;
      }
      return S.top;
    }
    const lotD = ringsDist(lotRings(b), x, z);
    if (lotD >= S.ramp || !roadside(x, z, curbD)) return 0;
    return S.top * (1 - lotD / S.ramp);
  }

  // The roadside rings: every block's curb rings and lot rings, with the side the road is on (the curb's outer ring:
  // outside it; a hole in it: inside; the same for a lot)
  const rings = [];
  for (const b of blocks.blocks) {
    curbRings(b).forEach((r, i) => rings.push({ block: b, ring: r, kind: 'curb', toRoad: i === 0 ? 1 : -1, box: boxOf(r, 4) }));
    lotRings(b).forEach((r, i) => rings.push({ block: b, ring: r, kind: 'lot', toRoad: i === 0 ? 1 : -1, box: boxOf(r, 4) }));
  }

  // A ring's samples: every vertex and every `step` metres between, each { x, z, nx, nz (unit, towards the road; the
  // mitred normal at a vertex, limited, longer than 1), s (arc length), seg, corner (a vertex) }
  function ringSamples(entry) {
    const r = entry.ring, n = r.length / 2;
    const side = entry.toRoad * (ringArea(r) > 0 ? 1 : -1);
    const segN = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = r[j * 2] - r[i * 2], dz = r[j * 2 + 1] - r[i * 2 + 1], L = Math.hypot(dx, dz) || 1;
      // a counter-clockwise ring (in x, z) has its outside on the right of (dx, dz): (dz, -dx)
      segN.push([(dz / L) * side, (-dx / L) * side, L]);
    }
    const vertN = segN.map((sn, i) => {
      const pn = segN[(i - 1 + n) % n];
      let mx = sn[0] + pn[0], mz = sn[1] + pn[1];
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-6) return [sn[0], sn[1]];
      mx /= ml; mz /= ml;
      const c = Math.max(0.5, mx * sn[0] + mz * sn[1]); // miter, limited to 2x
      return [mx / c, mz / c];
    });
    const out = [];
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [, , L] = segN[i];
      const k = Math.max(1, Math.ceil(L / S.step));
      for (let q = 0; q < k; q++) {
        const t = q / k;
        const nx = q === 0 ? vertN[i][0] : segN[i][0], nz = q === 0 ? vertN[i][1] : segN[i][1];
        out.push({ x: r[i * 2] + (r[j * 2] - r[i * 2]) * t, z: r[i * 2 + 1] + (r[j * 2 + 1] - r[i * 2 + 1]) * t, nx, nz, s: s + L * t, seg: i, corner: q === 0 });
      }
      s += L;
    }
    out.push({ ...out[0], s, seg: n }); // closed: the first again at the full length
    // a lot ring: each sample's distance along the ring to the nearest of its corners (onWalk's)
    if (entry.kind === 'lot') {
      const total = s, at = [];
      let acc = 0;
      for (let i = 0; i < n; i++) { at.push(acc); acc += segN[i][2]; }
      const cs = convexCorners(r, entry.toRoad).map((c) => at[c.index]);
      for (const sm of out) {
        let d = Infinity;
        for (const c of cs) { const a = Math.abs(sm.s - c); d = Math.min(d, a, total - a); }
        sm.toCorner = d;
      }
    }
    return out;
  }

  // What gf-sidewalk-meshes.js draws at a sample: a curb ring's { roadside } (its curb face, top and gutter); a lot
  // ring's { roadside, walkOut, lawnOut (from the lot line), lawn, cut } (walk, lawn, ramp). cut: a service road (a
  // driveway, OSM highway=service) crosses the band there: no curb face, and the lawn is a concrete apron.
  function curbAt(sm) {
    const px = sm.x + sm.nx * 0.6, pz = sm.z + sm.nz * 0.6;
    const cut = serviceEdge(px, pz) < 0.3;
    return { roadside: roadEdge(px, pz) < 1.0 || (cut && roadEdge(px, pz) < 3), cut };
  }
  function lotAt(entry, sm) {
    const b = entry.block;
    const curbD = ringsDist(curbRings(b), sm.x, sm.z);
    if (!(curbD < S.residentialBand + 1.6) || !roadside(sm.x, sm.z, curbD)) return { roadside: false };
    let { walkOut, lawn } = layout(curbD, 0);
    // a corner: paved on to the curb, as far along (sm's normal, mitred at a vertex) as stays behind the curb's top
    if (sm.toCorner <= S.pad || nearJunction(sm.x, sm.z)) {
      const behind = (d) => {
        const x = sm.x + sm.nx * d, z = sm.z + sm.nz * d;
        return blocks.blockAt(x, z) === b && ringsDist(curbRings(b), x, z) >= S.curbW;
      };
      let lo = walkOut, hi = curbD * 2 + 1;
      if (behind(lo)) {
        for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (behind(m)) lo = m; else hi = m; }
        walkOut = lo;
        lawn = false;
      }
    }
    const lawnOut = Math.max(walkOut, curbD - S.curbW + 0.03);
    const mx = sm.x + sm.nx * (walkOut + lawnOut) / 2, mz = sm.z + sm.nz * (walkOut + lawnOut) / 2;
    return { roadside: true, walkOut, lawnOut, lawn, curbD, cut: serviceEdge(mx, mz) < 0.3 };
  }

  // The walking lines beyond a road edge's half width on one side (pedestrian-routes.js insets as a function): where
  // the walk is across from the edge's middle (from the lot line, WALK_W or to the curb), two lines LINE_MARGIN and
  // LOT_MARGIN in from its edges, one in its middle if it is too narrow for two
  function insetsFor(e, side) {
    const t = e.len / 2;
    const ox = e.sx + e.dx * t, oz = e.sz + e.dz * t;
    const probe = e.half + 0.6;
    const px = ox + e.rx * side * probe, pz = oz + e.rz * side * probe;
    const b = blocks.blockAt(px, pz);
    if (!b || !b.lot || inLot(b, px, pz)) return S.insets;
    const lotD = ringsDist(lotRings(b), px, pz), curbD = ringsDist(curbRings(b), px, pz);
    const { walkOut } = layout(curbD, lotD);
    const lotOff = probe + lotD; // the lot line from the centre line
    const near = lotOff - walkOut + S.lineMargin - e.half, far = lotOff - S.lotMargin - e.half;
    if (far - near >= 0.5) return [+near.toFixed(2), +far.toFixed(2)];
    return [+Math.max(0.3, (near + far) / 2).toFixed(2)];
  }

  return {
    onWalk, raiseAt, raiseExact, insetsFor, nearJunction, rings, ringSamples, curbAt, lotAt, layout,
    downtown: DOWNTOWN.contains, roadEdge, serviceEdge, constants: S, ground
  };
}

export { SIDEWALK, createDowntown, sidewalkBandAt, createGfSidewalks, DOWNTOWN };
