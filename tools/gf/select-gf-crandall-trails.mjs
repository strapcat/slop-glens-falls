// tools/gf/select-gf-crandall-trails.mjs — CC-005c: the accepted walking network (Crandall Park and the minimum
// Cole's Woods corridor to Thrill Hill) from the frozen sources in tools/gf/data/trails/, with every decision recorded.
// usage: node tools/gf/select-gf-crandall-trails.mjs   -> tools/gf/data/gf_crandall_trails.geojson (deterministic)
//
// Sources (frozen, sha256 in tools/gf/data/trails/SHA256SUMS): the two OSM API 0.6 extracts the CC-005c kit retrieved
// on 2026-11-07 (Crandall Park bbox -73.667,43.3163,-73.6577,43.323 and Cole's Woods bbox -73.6805,43.3195,-73.6615,
// 43.3265), the park boundary (way 98662107) and the Warren County Cole's Woods loop (recreation_mapper layer 4,
// OBJECTID 19). Nothing is drawn by hand: every accepted line is an OSM way, or a contiguous run of an OSM way's own
// nodes, with its id, version, timestamp, node ids and tags. No connector is invented and nothing is snapped.
//
// Accepted (the coverage gate and Dave's route decisions of 2026-11-08):
//   park paths    the park-route candidates of osm-park-path-candidates.geojson that join the park's walking network:
//                 the pond paths (w234501321-330, four of them wooden footbridges), Newell Way (w98662142),
//                 w470028972 (access=no, foot=yes: open to walkers) and the Fire Road spur w1568246028;
//   park drives   the park's own service drives tagged foot=designated (eight ways): the park paths end on them, and
//                 through them reach Glen Street and Fire Road. Pedestrian-only edges here (cars never route on
//                 service ways in the game);
//   Cole's Woods  the shortest walk over foot-permitted OSM paths from each of the woods' two street entrances (the
//                 Fire Road / Park View Avenue curve, w1328140737; Angel Lane, w1328141829) to the Thrill Hill site:
//                 the path node nearest county loop vertex #137 and the hill path's segment from there over the crest.
//                 Dave's marked map shows the Camel Humps vicinity, north of The Wall; #137 (the first hump's high
//                 point on the county loop) and the crest are this project's PROVISIONAL interpretation of that mark,
//                 not locations he surveyed or pinned (the PR's labelled comparison shows the candidates). Only the nodes those walks use
//                 are kept (the rest of each way, and every other woods path, is excluded).
// Excluded: sidewalks and crossings (context; the game's own sidewalks are used), private or foot=no ways, and every
// candidate not on the accepted network, each with its reason.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toLocal } from './geo-frame.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'data/trails');
const OUT = path.join(HERE, 'data/gf_crandall_trails.geojson');
const RETRIEVED = '2026-11-07';
const HISTORY = 'Dave local knowledge, 2026-11-07: the park trails existed in 1993 (not a survey; modern 2022-23 OSM coordinates)';

const PARK_PATHS = ['98662142', '234501321', '234501322', '234501323', '234501324', '234501325', '234501326', '234501327',
  '234501328', '234501329', '234501330', '470028972', '1568246028'];
const PARK_DRIVES = ['20619871', '20632862', '470028691', '557479773', '671888405', '696794869', '696794870', '696794874'];
const COLES_ENTRANCES = ['12288007832', '221466297']; // on Park View Avenue (Fire Road curve) and Angel Lane
const HILL_VERTEX = 137; // county loop vertex: the first Camel Hump, top of The Wall (Dave, 2026-11-08)
const HILL_WAY = '1089938465'; // the path over that hump
const PATH_HIGHWAYS = new Set(['footway', 'path', 'track', 'steps']);
const DRIVEN = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);
const DEFAULT_WIDTH = 2.0; // m, gameplay assumption for an untagged path (not surveyed)

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Walkers may use a way: an explicit foot permission wins; otherwise no general access=no/private
function footAccess(t) {
  if (['no', 'private'].includes(t.foot)) return { ok: false, basis: `foot=${t.foot}` };
  if (['yes', 'designated', 'permissive'].includes(t.foot)) return { ok: true, basis: `foot=${t.foot}${t.access ? `; access=${t.access} (foot overrides)` : ''}` };
  if (['no', 'private'].includes(t.access)) return { ok: false, basis: `access=${t.access}` };
  return { ok: true, basis: t.access ? `access=${t.access}` : 'no restriction tagged' };
}

function readOsm(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const nodes = new Map(), ways = new Map();
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"/g)) nodes.set(m[1], [Number(m[3]), Number(m[2])]);
  for (const m of xml.matchAll(/<way id="(\d+)"([^>]*)>([\s\S]*?)<\/way>/g)) {
    const attr = (k) => (m[2].match(new RegExp(`${k}="([^"]*)"`)) || [])[1];
    ways.set(m[1], {
      id: m[1], version: attr('version'), timestamp: attr('timestamp'),
      nodes: [...m[3].matchAll(/<nd ref="(\d+)"/g)].map((x) => x[1]),
      tags: Object.fromEntries([...m[3].matchAll(/<tag k="([^"]+)" v="([^"]*)"/g)].map((x) => [x[1], x[2]]))
    });
  }
  return { nodes, ways };
}

function select() {
  const files = ['osm-crandall-context.xml', 'osm-coles-corridor-context.xml'];
  const nodes = new Map(), ways = new Map();
  for (const f of files) {
    const o = readOsm(path.join(SRC, f));
    for (const [id, c] of o.nodes) nodes.set(id, c);
    for (const [id, w] of o.ways) {
      const prev = ways.get(id);
      if (prev && (prev.version !== w.version || prev.nodes.join() !== w.nodes.join())) throw new Error(`way ${id} differs between the extracts`);
      if (!prev) ways.set(id, { ...w, file: f });
    }
  }
  const way = (id) => {
    const w = ways.get(id);
    if (!w) throw new Error(`way ${id} is not in the frozen extracts`);
    for (const n of w.nodes) if (!nodes.has(n)) throw new Error(`way ${id} references node ${n} missing from the extracts`);
    return w;
  };
  const local = (n) => toLocal(...nodes.get(n));
  const drivenAt = new Map();
  for (const w of ways.values()) if (DRIVEN.has(w.tags.highway)) for (const n of w.nodes) drivenAt.set(n, w.tags.name || w.tags.highway);
  const sidewalkAt = new Map();
  for (const w of ways.values()) if (w.tags.footway === 'sidewalk') for (const n of w.nodes) sidewalkAt.set(n, w.id);

  // Cole's Woods: foot-permitted paths only, the shortest walk from each entrance to the hill site
  const adj = new Map();
  for (const w of ways.values()) {
    if (!PATH_HIGHWAYS.has(w.tags.highway) || w.tags.footway === 'sidewalk' || w.tags.footway === 'crossing' || !footAccess(w.tags).ok) continue;
    for (let i = 0; i + 1 < w.nodes.length; i++) {
      const [a, b] = [w.nodes[i], w.nodes[i + 1]];
      const [ax, az] = local(a), [bx, bz] = local(b), d = Math.hypot(bx - ax, bz - az);
      for (const [u, v] of [[a, b], [b, a]]) {
        if (!adj.has(u)) adj.set(u, []);
        adj.get(u).push({ to: v, d, way: w.id, i });
      }
    }
  }
  const loop = JSON.parse(fs.readFileSync(path.join(SRC, 'county-coles-loop.geojson'), 'utf8')).features[0].geometry.coordinates;
  const [hx, hz] = toLocal(...loop[HILL_VERTEX]);
  const hillWay = way(HILL_WAY);
  let hillNode = null, hillDist = Infinity;
  for (const n of hillWay.nodes) { const [x, z] = local(n); const d = Math.hypot(x - hx, z - hz); if (d < hillDist) { hillDist = d; hillNode = n; } }
  const used = new Map(); // way -> Set of segment indices
  const routes = [];
  for (const start of COLES_ENTRANCES) {
    const dist = new Map([[start, 0]]), prev = new Map();
    const open = [[0, start]];
    while (open.length) {
      open.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
      const [d, u] = open.shift();
      if (d > dist.get(u)) continue;
      if (u === hillNode) break;
      for (const e of adj.get(u) || []) {
        const nd = d + e.d;
        if (nd < (dist.get(e.to) ?? Infinity) - 1e-9) { dist.set(e.to, nd); prev.set(e.to, { u, e }); open.push([nd, e.to]); }
      }
    }
    if (!dist.has(hillNode)) throw new Error(`no foot-permitted path from entrance node ${start} to the hill node ${hillNode}`);
    const ways = [];
    for (let n = hillNode; n !== start;) {
      const { u, e } = prev.get(n);
      if (!used.has(e.way)) used.set(e.way, new Set());
      used.get(e.way).add(e.i);
      if (ways[ways.length - 1] !== e.way) ways.push(e.way);
      n = u;
    }
    routes.push({ entranceNode: start, hillNode, lengthM: Math.round(dist.get(hillNode) * 10) / 10, ways: ways.reverse() });
  }
  // and the hill path's own segment from that node over the crest (its high point, beside which the gathering stands)
  const crest = hillWay.nodes.indexOf(hillNode);
  if (crest !== 0 && crest !== hillWay.nodes.length - 1) throw new Error('the hill node is not an end of the hill path');
  if (!used.has(HILL_WAY)) used.set(HILL_WAY, new Set());
  used.get(HILL_WAY).add(crest === 0 ? 0 : crest - 1);

  const features = [];
  const baseProps = (w, group, extra = {}) => {
    const acc = footAccess(w.tags);
    const tagged = w.tags.width ? Number(w.tags.width) : null;
    return {
      id: `w${w.id}`, group, accepted: true, osmWayId: w.id, version: w.version, timestamp: w.timestamp,
      sourceUrl: `https://www.openstreetmap.org/way/${w.id}`, sourceFile: `tools/gf/data/trails/${w.file}`, retrieved: RETRIEVED,
      historicalBasis: HISTORY, tags: w.tags, pedestrianAccess: acc.basis, surface: w.tags.surface || null,
      widthM: group === 'park-drive' ? null : tagged ?? DEFAULT_WIDTH,
      widthBasis: group === 'park-drive' ? 'the drive itself (drawn as a service road)' : tagged ? `tagged width=${w.tags.width}` : `assumption: ${DEFAULT_WIDTH} m gameplay default (not surveyed)`,
      bridge: w.tags.bridge === 'yes', layer: w.tags.layer ? Number(w.tags.layer) : 0, ...extra
    };
  };
  const lineOf = (ids) => ({ type: 'LineString', coordinates: ids.map((n) => nodes.get(n)) });
  for (const id of PARK_PATHS) {
    const w = way(id);
    if (!footAccess(w.tags).ok) throw new Error(`park path ${id} is not open to walkers`);
    features.push({ type: 'Feature', properties: { ...baseProps(w, 'park-path'), nodeIds: w.nodes, reason: 'park-route candidate on the park walking network' }, geometry: lineOf(w.nodes) });
  }
  for (const id of PARK_DRIVES) {
    const w = way(id);
    if (w.tags.highway !== 'service' || w.tags.foot !== 'designated') throw new Error(`park drive ${id} is not a foot=designated service way`);
    features.push({ type: 'Feature', properties: { ...baseProps(w, 'park-drive'), nodeIds: w.nodes, reason: 'park drive, foot=designated: joins the park paths to Glen Street and Fire Road (pedestrian edge only)' }, geometry: lineOf(w.nodes) });
  }
  for (const [id, segs] of [...used].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const w = way(id);
    const idx = [...segs].sort((a, b) => a - b);
    // contiguous runs of the way's own segments
    let run = [idx[0]];
    const flush = () => {
      const from = run[0], to = run[run.length - 1] + 1, ids = w.nodes.slice(from, to + 1);
      const whole = from === 0 && to === w.nodes.length - 1;
      features.push({ type: 'Feature', properties: { ...baseProps(w, 'coles-corridor', { id: whole ? `w${id}` : `w${id}:${from}-${to}`, nodeRange: [from, to] }), nodeIds: ids,
        reason: `${id === HILL_WAY ? 'the path over the crest of the first Camel Hump (the gathering site)' : 'on the shortest foot-permitted walk from a woods entrance to the Thrill Hill site'}${whole ? '' : ` (nodes ${from}..${to} of ${w.nodes.length})`}` }, geometry: lineOf(ids) });
    };
    for (let k = 1; k < idx.length; k++) { if (idx[k] === run[run.length - 1] + 1) run.push(idx[k]); else { flush(); run = [idx[k]]; } }
    flush();
  }

  // Entrances: accepted endpoints on a street (the road's own node) or on a mapped sidewalk
  const accepted = features.slice();
  const endpointUse = new Map();
  for (const f of accepted) for (const n of f.properties.nodeIds) endpointUse.set(n, (endpointUse.get(n) || 0) + 1);
  for (const f of accepted) {
    for (const n of new Set([f.properties.nodeIds[0], f.properties.nodeIds[f.properties.nodeIds.length - 1]])) {
      const street = drivenAt.get(n), sidewalk = sidewalkAt.get(n);
      if (!street && !sidewalk) continue;
      if (f.properties.group === 'coles-corridor' && !COLES_ENTRANCES.includes(n)) continue;
      features.push({ type: 'Feature', properties: { id: `entrance-${n}`, kind: 'entrance', accepted: true, nodeId: n, way: f.properties.id,
        street: street || null, sidewalkWay: sidewalk || null,
        evidence: street ? `the accepted way's node is on ${street} (OSM shares the node)` : `the accepted way's node is on the mapped sidewalk w${sidewalk}` }, geometry: { type: 'Point', coordinates: nodes.get(n) } });
    }
  }

  // Excluded candidates (both kit candidate files), each with its reason
  const acceptedWays = new Set(accepted.map((f) => f.properties.osmWayId));
  const seen = new Set();
  for (const file of ['osm-park-path-candidates.geojson', 'osm-coles-corridor-candidates.geojson']) {
    const fc = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'));
    for (const f of fc.features) {
      const id = f.properties.osmWayId;
      if (seen.has(id)) continue;
      seen.add(id);
      const w = way(id), t = w.tags, acc = footAccess(t);
      let reason = null;
      if (t.footway === 'sidewalk' || t.footway === 'crossing') reason = `context only: ${t.footway} (the game's own sidewalks are used; crossings are CC-006)`;
      else if (!acc.ok) reason = `not open to walkers (${acc.basis})`;
      else if (acceptedWays.has(id)) {
        const kept = accepted.filter((a) => a.properties.osmWayId === id).flatMap((a) => a.properties.nodeIds);
        if (kept.length >= w.nodes.length) continue;
        reason = 'partly accepted: only the nodes on the minimal corridor are kept';
      } else reason = 'not on the accepted network (outside the minimum Cole\'s Woods corridor, or not joined to it)';
      features.push({ type: 'Feature', properties: { id: `excluded-w${id}`, accepted: false, osmWayId: id, version: w.version, reason, tags: t, candidateFile: file }, geometry: lineOf(w.nodes) });
    }
  }

  const sources = ['osm-crandall-context.xml', 'osm-coles-corridor-context.xml', 'osm-park.xml', 'county-coles-loop.geojson',
    'osm-park-path-candidates.geojson', 'osm-coles-corridor-candidates.geojson'].map((f) => ({ file: `tools/gf/data/trails/${f}`, sha256: sha(path.join(SRC, f)) }));
  return {
    type: 'FeatureCollection',
    name: 'gf_crandall_trails',
    provenance: {
      generator: 'tools/gf/select-gf-crandall-trails.mjs', crs: 'WGS84 (GeoJSON RFC 7946), [longitude, latitude]', retrieved: RETRIEVED,
      attribution: '© OpenStreetMap contributors (ODbL 1.0, https://www.openstreetmap.org/copyright); Cole\'s Woods loop: Warren County GIS recreation_mapper layer 4 (reference only)',
      historicalBasis: HISTORY, sources,
      hill: { countyLoopVertex: HILL_VERTEX, countyLoopCoordinates: loop[HILL_VERTEX], pathWay: HILL_WAY, pathNode: hillNode, pathNodeToVertexM: Math.round(hillDist * 10) / 10,
        identity: 'Thrill Hill: Dave\'s marked map shows the Camel Humps vicinity (local knowledge, not an official name). County loop vertex #137 and the trail crest are a provisional interpretation of that mark, not a location he confirmed.' },
      colesRoutes: routes
    },
    features
  };
}

function main() {
  const fc = select();
  const text = JSON.stringify(fc, null, 1) + '\n';
  fs.writeFileSync(OUT, text);
  const acc = fc.features.filter((f) => f.properties.accepted && f.geometry.type === 'LineString');
  console.log(`[gf-trails] ${acc.length} accepted lines (${['park-path', 'park-drive', 'coles-corridor'].map((g) => `${g} ${acc.filter((f) => f.properties.group === g).length}`).join(', ')}), ${fc.features.filter((f) => f.properties.kind === 'entrance').length} entrances, ${fc.features.filter((f) => !f.properties.accepted).length} excluded; routes ${fc.provenance.colesRoutes.map((r) => `${r.entranceNode} ${r.lengthM} m`).join(', ')}; wrote ${path.relative(path.join(HERE, '../..'), OUT)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

export { select, footAccess };
