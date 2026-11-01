// tools/gf/build-gf-buildings.mjs — writes js/gf-buildings.js from tools/gf/data/osm_gf_buildings.json
// usage: node tools/gf/build-gf-buildings.mjs [out.js]        (GF_DATA=<dir> reads the raw JSON from another folder)
//
// Input (bash tools/gf/fetch.sh, q_gf_buildings.overpassql): every OSM way and relation tagged building=* in the Glens
// Falls bbox, with their nodes. Output: GF_BUILDINGS (see the header the generator writes) in the GF_GEO frame
// (geo-frame.mjs, rounded to 0.1 m): one row per building footprint as OSM draws it. No footprint is moved, added,
// merged or clipped; the only buildings left out are the skip rules below, and every skip is counted in the log.
//
// Heights: an OSM height tag, else building:levels, else HEIGHT_RULE's default, which is an APPROXIMATION (99% of the
// buildings in this extract have no height or levels tag). The output depends only on the raw JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAT0, LON0, THETA, BBOX_M, toLocal, q } from './geo-frame.mjs';
import { ATTRIBUTION, joinRings, ringSelfIntersects } from './build-gf-geodata.mjs';
import { GF_GEO } from '../../js/gf-geodata.js';

const DATA = process.env.GF_DATA || fileURLToPath(new URL('data/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../../js/gf-buildings.js', import.meta.url));
const log = (...a) => console.log('[gf-buildings]', ...a);

export const STOREY = 3.3;
const SKIP_KINDS = ['roof', 'construction']; // open canopies (fuel stations, carports) and building sites
const ONE_LEVEL = ['garage', 'garages', 'shed', 'outbuilding', 'carport', 'greenhouse', 'kiosk', 'hut', 'service', 'supermarket', 'industrial', 'warehouse', 'chapel'];
const TWO_LEVELS = ['house', 'detached', 'semidetached_house', 'residential', 'terrace', 'commercial', 'retail', 'school', 'church', 'healthcare', 'civic', 'public'];
const THREE_LEVELS = ['apartments', 'office', 'hospital', 'parking'];
const BIG_BOX_EXEMPT = ['school', 'hospital', 'apartments', 'office', 'parking', 'church'];
const NO_VARIATION = ['church', 'school', 'hospital'];

// The height rule, word for word as GF_BUILDINGS.heightRule carries it
export const HEIGHT_RULE = 'height tag (m, ft or \') if present (src 0); else building:levels x 3.3 + 0.6 m (src 1); else a default that '
  + 'is an approximation, not a survey (src 2): levels by building type (1: garage, garages, shed, outbuilding, carport, greenhouse, kiosk, '
  + 'hut, service, supermarket, industrial, warehouse, chapel; 2: house, detached, semidetached_house, residential, '
  + 'terrace, commercial, retail, school, church, healthcare, civic, public; 3: apartments, office, hospital, parking; '
  + 'yes and anything else: 1 under 40 m2, else 2); footprints of 2000 m2 or more that are not a school, hospital, '
  + 'apartments, office, parking or church get 7.5 m flat; otherwise r = mulberry32(osm id)() and, when levels >= 2 '
  + 'and the type is not church, school or hospital, r < 0.15 takes a level off and r >= 0.85 adds one; height = '
  + 'levels x 3.3 + 0.6 m; every height rounded to 0.1 m';

// Same generator as js/buildings.js (copied: that module is New York's)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round1 = (v) => Math.round(v * 10) / 10;

// Metres from an OSM height tag ("12", "12 m", "40 ft", "40'", "12'6\""), else null
export function parseHeight(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)?$/))) return parseFloat(m[1]);
  if ((m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in))?$/))) return parseFloat(m[1]) * 0.3048 + (m[2] ? parseFloat(m[2]) * 0.0254 : 0);
  return null;
}

// The first number of a building:levels tag when it is above 0, else null
export function parseLevels(v) {
  if (v == null) return null;
  const m = String(v).match(/\d+(?:\.\d+)?/);
  const n = m ? parseFloat(m[0]) : NaN;
  return n > 0 ? n : null;
}

// The default storeys for a building type and footprint area (m²), before the variation
export function defaultLevels(kind, area) {
  if (ONE_LEVEL.includes(kind)) return 1;
  if (TWO_LEVELS.includes(kind)) return 2;
  if (THREE_LEVELS.includes(kind)) return 3;
  return area < 40 ? 1 : 2;
}

// { height, src } of a building from its tags, numeric OSM id and footprint area (outer minus holes, m²)
export function buildingHeight(tags, id, area) {
  const tagged = parseHeight(tags.height);
  if (tagged !== null) return { height: round1(tagged), src: 0 };
  const levels = parseLevels(tags['building:levels']);
  if (levels !== null) return { height: round1(levels * STOREY + 0.6), src: 1 };
  const kind = tags.building;
  if (area >= 2000 && !BIG_BOX_EXEMPT.includes(kind)) return { height: 7.5, src: 2 };
  let n = defaultLevels(kind, area);
  const r = mulberry32(id)();
  if (n >= 2 && !NO_VARIATION.includes(kind)) {
    if (r < 0.15) n -= 1;
    else if (r >= 0.85) n += 1;
  }
  return { height: round1(n * STOREY + 0.6), src: 2 };
}

export const ringArea = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
};

// A projected ring at 0.1 m, without repeated or closing points; null (with the reason) when it is unusable
function cleanRing(nodeIds, nodes) {
  const pts = [];
  for (const id of nodeIds) {
    const n = nodes.get(id);
    if (!n) return { reason: 'missing node' };
    const [x, z] = toLocal(n.lon, n.lat).map(q);
    const last = pts[pts.length - 1];
    if (!last || last[0] !== x || last[1] !== z) pts.push([x, z]);
  }
  while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return { reason: 'under 3 points' };
  if (Math.abs(ringArea(pts)) < 1) return { reason: 'under 1 m²' };
  if (ringSelfIntersects(pts)) return { reason: 'self-intersecting' };
  return { ring: pts };
}

export function buildGfBuildings(raw) {
  if (!Array.isArray(raw.elements) || raw.remark) throw new Error('incomplete Overpass response for buildings');
  const nodes = new Map();
  const ways = new Map();
  for (const e of raw.elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.set(e.id, e);
  }
  const candidates = [
    ...raw.elements.filter((e) => e.type === 'way' && e.tags && e.tags.building).sort((a, b) => a.id - b.id),
    ...raw.elements.filter((e) => e.type === 'relation' && e.tags && e.tags.building).sort((a, b) => a.id - b.id)
  ];
  const stats = { candidates: candidates.length, skipped: {}, droppedRings: [], src: [0, 0, 0] };
  const skip = (reason, osm) => (stats.skipped[reason] ||= []).push(osm);
  const rows = [];

  for (const e of candidates) {
    const osm = (e.type === 'way' ? 'w' : 'r') + e.id;
    const t = e.tags;
    if (SKIP_KINDS.includes(t.building)) { skip(`building=${t.building}`, osm); continue; }
    let outerIds, innerIds = [];
    if (e.type === 'way') {
      if (e.nodes[0] !== e.nodes[e.nodes.length - 1]) { skip('open way', osm); continue; }
      outerIds = e.nodes;
    } else {
      if (t.type !== 'multipolygon') { skip(`relation type=${t.type}`, osm); continue; }
      const member = (role) => e.members.filter((m) => m.type === 'way' && (m.role || 'outer') === role)
        .map((m) => ways.get(m.ref)).filter(Boolean).map((w) => w.nodes);
      const outers = joinRings(member('outer'));
      const inners = joinRings(member('inner'));
      if (outers.rings.length !== 1) throw new Error(`${osm}: ${outers.rings.length} outer rings (one per building is supported)`);
      if (outers.open || inners.open) stats.droppedRings.push(`${osm}: ${outers.open + inners.open} member ways that close no ring`);
      outerIds = outers.rings[0];
      innerIds = inners.rings;
    }
    const outer = cleanRing(outerIds, nodes);
    if (!outer.ring) { stats.droppedRings.push(`${osm} outer: ${outer.reason}`); skip('no usable outer ring', osm); continue; }
    const holes = [];
    innerIds.forEach((ids, i) => {
      const h = cleanRing(ids, nodes);
      if (h.ring) holes.push(h.ring);
      else stats.droppedRings.push(`${osm} hole ${i}: ${h.reason}`);
    });
    const xs = outer.ring.map((p) => p[0]), zs = outer.ring.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    if (cx < BBOX_M.x0 || cx > BBOX_M.x1 || cz < BBOX_M.z0 || cz > BBOX_M.z1) { skip('bbox centre outside the bbox', osm); continue; }
    const area = Math.abs(ringArea(outer.ring)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
    const { height, src } = buildingHeight(t, e.id, area);
    stats.src[src]++;
    const use = t.shop ? `shop=${t.shop}` : t.amenity ? `amenity=${t.amenity}` : null;
    rows.push([osm, t.building, use, t.name ?? null, t.start_date ?? null, t['building:levels'] ?? null, height, src,
      outer.ring.flat(), holes.map((h) => h.flat())]);
  }
  return { osmBase: (raw.osm3s && raw.osm3s.timestamp_osm_base) || null, rows, stats };
}

export function serialize({ osmBase, rows }) {
  return [
    '// js/gf-buildings.js — GENERATED by tools/gf/build-gf-buildings.mjs, do not edit by hand.',
    '// Building footprints in Glens Falls & South Glens Falls from OSM (building=*), in the GF_GEO frame (js/gf-geodata.js),',
    '// rounded to 0.1 m: outer is a flat [x, z, ...] ring without a closing point, holes a list of such rings. Sorted ways',
    '// then relations, by OSM id. height is metres; src says where it came from: 0 the height tag, 1 building:levels, 2 the',
    '// default rule in heightRule, which is an APPROXIMATION, not a surveyed height.',
    `// Data ${ATTRIBUTION}`,
    'export const GF_BUILDINGS = {',
    `  osmBase: ${JSON.stringify(osmBase)},`,
    `  attribution: ${JSON.stringify(ATTRIBUTION)},`,
    `  storey: ${STOREY},`,
    `  heightRule: ${JSON.stringify(HEIGHT_RULE)},`,
    `  fields: ${JSON.stringify(['osm', 'kind', 'use', 'name', 'start', 'levels', 'height', 'src', 'outer', 'holes'])},`,
    `  buildings: [\n${rows.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]`,
    '};',
    ''
  ].join('\n');
}

function main() {
  // The footprints must land in the frame js/gf-geodata.js was built in
  const { lat0, lon0, theta } = GF_GEO.frame;
  if (lat0 !== LAT0 || lon0 !== LON0 || theta !== THETA) throw new Error('geo-frame.mjs and js/gf-geodata.js disagree on the frame');
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'osm_gf_buildings.json'), 'utf8'));
  const result = buildGfBuildings(raw);
  const text = serialize(result);
  fs.writeFileSync(OUT, text);

  const { rows, stats } = result;
  log(`OSM base ${result.osmBase}: ${stats.candidates} buildings in the extract, ${rows.length} kept`);
  for (const [reason, ids] of Object.entries(stats.skipped)) log(`  skipped ${ids.length}: ${reason}${ids.length <= 20 ? ` (${ids.join(', ')})` : ''}`);
  log(`dropped rings: ${stats.droppedRings.length}${stats.droppedRings.length ? ` (${stats.droppedRings.join('; ')})` : ''}`);
  log(`height sources: ${stats.src[0]} height tag, ${stats.src[1]} building:levels, ${stats.src[2]} default rule (approximation, ${(100 * stats.src[2] / rows.length).toFixed(1)}%)`);
  const heights = rows.map((r) => r[6]);
  const bins = new Map();
  for (const h of heights) { const b = Math.floor(h / 3) * 3; bins.set(b, (bins.get(b) || 0) + 1); }
  log(`heights (3 m bins): ${[...bins].sort((a, b) => a[0] - b[0]).map(([b, n]) => `${b}-${b + 3} m ${n}`).join(', ')}`);
  const tallest = rows.reduce((a, r) => (r[6] > a[6] ? r : a));
  log(`max ${tallest[6]} m (${tallest[0]}${tallest[3] ? `, ${tallest[3]}` : ''}), mean ${(heights.reduce((s, h) => s + h, 0) / heights.length).toFixed(2)} m`);
  const dated = rows.filter((r) => r[4]);
  const late = dated.filter((r) => parseInt(r[4], 10) > 1993);
  log(`start_date on ${dated.length} kept buildings (${dated.map((r) => `${r[0]} ${r[4]}`).join(', ')}); after 1993: ${late.length}${late.length ? ` (${late.map((r) => `${r[0]}${r[3] ? ` ${r[3]}` : ''} ${r[4]}`).join(', ')})` : ''}`);
  const kb = Buffer.byteLength(text) / 1024;
  log(`wrote ${path.relative(process.cwd(), OUT)} (${kb.toFixed(1)} KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
