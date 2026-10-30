// Glens Falls road network input (no three.js): GF_GEO.roadGraph (js/gf-geodata.js, tools/gf/README.md) as the city
// source of buildRoadNetwork (road-network.js). The town has no grid, so there are no avenues, cross streets or blocks:
// the centreline graph carries the whole network, each street's lanes and right of way coming from its width, lane
// count and direction (OSM), as for Manhattan's non-grid streets.

// Highway classes vehicles drive. `service` (driveways, parking aisles, alleys) is drawn but not driven.
export const DRIVE_CLASSES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street'
]);

const BOUNDS_PAD = 20;

// The links of GF_GEO.roadGraph in DRIVE_CLASSES, as { a, b, name, highway, oneway, lanes, width, pts: [[x, z], ...] }
export function driveLinks(geo, classes = DRIVE_CLASSES) {
  const { nodes, links, names, classes: highways } = geo.roadGraph;
  const out = [];
  for (const [a, b, name, highway, oneway, lanes, width, inner] of links) {
    if (!classes.has(highways[highway])) continue;
    const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
    for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k + 1]]);
    pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
    out.push({ a, b, name: names[name], highway: highways[highway], oneway, lanes, width, pts });
  }
  return out;
}

// buildRoadNetwork's city source (see NYC_SOURCE in road-network.js): GF links [a, b, name, highway, oneway, lanes,
// width, pts] in the centreline schema [a, b, nameIdx, width, lanes, dir, inner] (dir: 1 along a -> b, -1 against, 0
// both ways), the bbox padded by 20 m as the land, its x-extent as the shore at every z, and no major road names (a
// road's axis comes from its width and lanes)
// buildRoadNetwork follows a link with straight runs, adding a bend only where its direction turns more than 12°, so a
// long gentle curve would be driven along its chord, metres off the road. Each link is therefore cut at its own shape
// points (OSM nodes) into pieces whose chord keeps within CHORD_GAP of them: the farthest point first, as long as both
// pieces stay MIN_PIECE long (under 14 m, road-network.js would merge a piece's two ends into one junction).
const CHORD_GAP = 1.5;
const MIN_PIECE = 15;
function chordPieces(pts) {
  const along = [0];
  for (let k = 1; k < pts.length; k++) along.push(along[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const cuts = [];
  (function split(i, j) {
    const [ax, az] = pts[i];
    const ex = pts[j][0] - ax;
    const ez = pts[j][1] - az;
    const L = Math.hypot(ex, ez) || 1;
    let far = -1;
    let farGap = CHORD_GAP;
    for (let k = i + 1; k < j; k++) {
      const gap = Math.abs((pts[k][0] - ax) * ez - (pts[k][1] - az) * ex) / L;
      if (gap > farGap && along[k] - along[i] >= MIN_PIECE && along[j] - along[k] >= MIN_PIECE) {
        farGap = gap;
        far = k;
      }
    }
    if (far < 0) return;
    split(i, far);
    cuts.push(far);
    split(far, j);
  })(0, pts.length - 1);
  return cuts; // shape point indices, in order along the link
}

// GF_GEO's graph has a node wherever two roads of any class meet. Without the classes not driven (a driveway's end on a
// street), such a node only joins two pieces of one street, and a piece under 14 m would pull the street's real junction
// next to it towards its own end (road-network.js merges the two ends of any link under 14 m). The pieces of one street
// (same name, width and lanes, one direction of travel) meeting at a node no other drive link reaches are one link
// again. Links: { a, b, name, width, lanes, oneway, pts }.
function joinPieces(links) {
  const at = new Map(); // node -> the links ending there
  links.forEach((l, i) => {
    for (const n of [l.a, l.b]) {
      if (!at.has(n)) at.set(n, []);
      at.get(n).push(i);
    }
  });
  const alike = (p, q) => p.name === q.name && p.width === q.width && p.lanes === q.lanes;
  // The link through node n that goes on from link i, if n only joins two pieces of one street travelled the same way
  const onward = (i, n) => {
    const ends = at.get(n);
    if (ends.length !== 2 || ends[0] === ends[1]) return -1;
    const j = ends[0] === i ? ends[1] : ends[0];
    const p = links[i], q = links[j];
    const inDir = p.b === n ? p.oneway : -p.oneway; // travelling into n along p
    const outDir = q.a === n ? q.oneway : -q.oneway; // and on out of n along q
    return alike(p, q) && inDir === outDir ? j : -1;
  };
  const used = new Uint8Array(links.length);
  const out = [];
  links.forEach((l, i) => {
    if (used[i]) return;
    used[i] = 1;
    // walk back from l's start, then forward from its end, through the nodes that just join two of its pieces
    let pts = l.pts.slice();
    let oneway = l.oneway;
    let a = l.a;
    let b = l.b;
    for (let j = i, n = a; (j = onward(j, n)) >= 0 && !used[j];) {
      used[j] = 1;
      const q = links[j];
      const fwd = q.b === n; // q runs into n
      pts = [...(fwd ? q.pts : q.pts.slice().reverse()).slice(0, -1), ...pts];
      n = a = fwd ? q.a : q.b;
    }
    for (let j = i, n = b; (j = onward(j, n)) >= 0 && !used[j];) {
      used[j] = 1;
      const q = links[j];
      const fwd = q.a === n; // q runs out of n
      pts = [...pts, ...(fwd ? q.pts : q.pts.slice().reverse()).slice(1)];
      n = b = fwd ? q.b : q.a;
    }
    out.push({ ...l, a, b, oneway, pts });
  });
  return out;
}

export function gfRoadSource(geo, classes = DRIVE_CLASSES) {
  const { nodes, names } = geo.roadGraph;
  const { x0, x1, z0, z1 } = geo.bbox;
  const shore = { westX: x0, eastX: x1 };
  const nameIds = new Map(names.map((n, i) => [n, i]));
  const outNodes = nodes.slice(); // shape points a link is cut at become nodes after GF_GEO's own
  const outLinks = [];
  for (const { a, b, name, oneway, lanes, width, pts } of joinPieces(driveLinks(geo, classes))) {
    let from = a;
    let start = 0;
    for (const k of [...chordPieces(pts), pts.length - 1]) {
      let to = b;
      if (k < pts.length - 1) {
        to = outNodes.length / 2;
        outNodes.push(pts[k][0], pts[k][1]);
      }
      outLinks.push([from, to, nameIds.get(name), width, lanes, oneway, pts.slice(start + 1, k).flat()]);
      from = to;
      start = k;
    }
  }
  return {
    avenues: [],
    streets: [],
    blocks: [],
    roadGraph: { nodes: outNodes, names, links: outLinks },
    bounds: { minX: x0 - BOUNDS_PAD, maxX: x1 + BOUNDS_PAD, minZ: z0 - BOUNDS_PAD, maxZ: z1 + BOUNDS_PAD },
    shoreAt: () => shore,
    majorName: null
  };
}

// Distance from (x, z) to a polyline [[x, z], ...]
export function polylineDistance(x, z, pts) {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k];
    const [bx, bz] = pts[k + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return best;
}

// Does edge e (between its stop lines) run along the links: its ends and middle each within a link's half width + 2 m?
export function edgeAlong(e, links) {
  for (const t of [0, 0.5, 1]) {
    const x = e.sx + e.dx * e.len * t;
    const z = e.sz + e.dz * e.len * t;
    if (!links.some((l) => polylineDistance(x, z, l.pts) <= l.width / 2 + 2)) return false;
  }
  return true;
}

// The player's start: on the longest edge along a link named `street` (else the longest edge of all), in its rightmost
// lane half way along, heading down the edge. Deterministic for a given network. heading: yaw with forward (sin, cos).
export function gfSpawn(network, geo, street = 'Glen Street') {
  const named = driveLinks(geo).filter((l) => l.name === street);
  const longest = (list) => list.reduce((best, e) => (!best || e.len > best.len || (e.len === best.len && e.id < best.id) ? e : best), null);
  const onStreet = network.edges.filter((e) => edgeAlong(e, named));
  const e = longest(onStreet) || longest(network.edges);
  const lane = e.lanes[e.lanes.length - 1];
  const s = e.len / 2;
  return {
    x: e.sx + e.dx * s + e.rx * lane,
    z: e.sz + e.dz * s + e.rz * lane,
    heading: Math.atan2(e.dx, e.dz),
    edge: e.id,
    street: onStreet.length ? street : null
  };
}
