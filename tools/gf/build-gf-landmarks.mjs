// tools/gf/build-gf-landmarks.mjs — writes js/gf-landmarks.js from tools/gf/data/gf_landmarks.json
// usage: node tools/gf/build-gf-landmarks.mjs [out.js]       (GF_DATA=<dir> reads the JSON from another folder)
//
// Input: Dave's sourced landmark overrides (gf_landmarks.json, schema gf-landmarks/1; its "rules" block documents
// it). Every value is { value, source: [https URLs], confidence: high|medium|low, note? }; value null means unsourced.
// Output: GF_LANDMARKS = { source, sha256, attribution, srcCode: 3, buildings, features, pending, flagged } in the
// GF_GEO frame. Only sourced values are applied; anything unsourced or marked needs-data is skipped and listed in
// pending, never filled in. js/gf-buildings.js (CC-003) is not touched: js/gf-landmark-records.js applies this layer
// on top of its records at run time. The output depends only on the JSON and GF_BUILDINGS.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAT0, LON0, THETA, toLocal, q } from './geo-frame.mjs';
import { ATTRIBUTION } from './build-gf-geodata.mjs';
import { STOREY, round1 } from './build-gf-buildings.mjs';
import { GF_GEO } from '../../js/gf-geodata.js';
import { GF_BUILDINGS } from '../../js/gf-buildings.js';
import { STYLES } from '../../js/gf-building-records.js';

const DATA = process.env.GF_DATA || fileURLToPath(new URL('data/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../../js/gf-landmarks.js', import.meta.url));
const log = (...a) => console.log('[gf-landmarks]', ...a);

export const SRC_LANDMARK = 3; // GF_BUILDINGS src codes 0-2 (height tag, levels, default rule); 3 = sourced landmark
const STATUSES = ['use', 'needs-data', 'no-change', 'flag-only'];
const CONFIDENCES = ['high', 'medium', 'low'];
// Shapes js/gf-landmark-meshes.js draws (steeple = spire). woodpile is a type the JSON uses for a Finch Pruyn
// placeholder; there is no shape for it, so it can only ever be pending.
const SHAPES = ['gable', 'hip', 'spire', 'steeple', 'tower', 'dome', 'clock-tower', 'smokestack', 'obelisk'];
const FEATURE_TYPES = [...SHAPES, 'woodpile'];
const ANCHORS = { 'footprint centroid': 'centroid' };
const GROUND_TYPES = ['smokestack', 'obelisk']; // stand on the ground; everything else on the building's roof
const RANK = { high: 2, medium: 1, low: 0 };
const lowest = (list) => list.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));

// A sourced value field: null, { value: null, ... } (unsourced), or { value, source: [https...], confidence }
function checkField(where, f) {
  if (f == null || f.value == null) return false;
  if (!Array.isArray(f.source) || !f.source.length || !f.source.every((s) => typeof s === 'string' && s.startsWith('https://'))) {
    throw new Error(`${where}: a value with no https:// source`);
  }
  if (!CONFIDENCES.includes(f.confidence)) throw new Error(`${where}: confidence ${JSON.stringify(f.confidence)} is not high, medium or low`);
  return true;
}
const sourcesOf = (fields) => [...new Set(fields.flatMap((f) => f.source))];

// { buildings, features, pending, flagged, stats } of a gf-landmarks/1 document against GF_BUILDINGS
export function buildGfLandmarks(doc, buildingsData) {
  if (!doc || !Array.isArray(doc.landmarks)) throw new Error('gf_landmarks.json: no landmarks list');
  const at = Object.fromEntries(buildingsData.fields.map((f, i) => [f, i]));
  const rows = new Map(buildingsData.buildings.map((r) => [r[at.osm], r]));
  const ids = new Set();
  const osms = new Set();
  const buildings = [];
  const features = [];
  const pending = [];
  const flagged = [];
  const stats = { entries: doc.landmarks.length, status: {}, src3: 0, styleOnly: 0 };

  for (const e of doc.landmarks) {
    const name = `landmark "${e.id}"`;
    if (typeof e.id !== 'string' || !e.id) throw new Error(`a landmark without an id (${JSON.stringify(e.name)})`);
    if (ids.has(e.id)) throw new Error(`duplicate landmark id ${e.id}`);
    ids.add(e.id);
    if (osms.has(e.osm)) throw new Error(`duplicate OSM id ${e.osm} (${name})`);
    osms.add(e.osm);
    if (!STATUSES.includes(e.status)) throw new Error(`unknown status ${JSON.stringify(e.status)} (${name})`);
    stats.status[e.status] = (stats.status[e.status] || 0) + 1;
    const isNode = /^n\d+$/.test(e.osm);
    if (isNode) {
      if (!e.node || !Number.isFinite(e.node.lat) || !Number.isFinite(e.node.lon)) throw new Error(`node ${e.osm} without a numeric lat/lon (${name})`);
    } else if (!/^[wr]\d+$/.test(e.osm) || !rows.has(e.osm)) {
      throw new Error(`unknown OSM id ${e.osm} (${name})`);
    }
    for (const k of ['osmMatch', 'height', 'levels', 'facade', 'form', 'built', 'status1993']) checkField(`${e.id}.${k}`, e[k]);
    if (e.levels?.value != null && !(e.levels.value > 0)) throw new Error(`non-positive levels ${e.levels.value} (${name})`);
    if (e.facade?.value != null && !STYLES.includes(e.facade.value.style)) throw new Error(`unknown facade style ${JSON.stringify(e.facade.value.style)} (${name})`);
    const base = { id: e.id, osm: e.osm, daveRequested: !!e.daveRequested };
    const style = e.facade?.value?.style ?? null;

    // Features: each one applied only when it is sourced (and placed); otherwise pending
    const list = Array.isArray(e.features) ? e.features : [];
    list.forEach((f, i) => {
      const where = `${e.id}.features[${i}]`;
      if (!FEATURE_TYPES.includes(f.type)) throw new Error(`unknown feature type ${JSON.stringify(f.type)} (${name})`);
      if (!STATUSES.includes(f.status)) throw new Error(`unknown feature status ${JSON.stringify(f.status)} (${where})`);
      const hasHeight = checkField(`${where}.height`, f.height);
      if (hasHeight && !(f.height.value >= 1 && f.height.value <= 80)) throw new Error(`feature height ${f.height.value} m outside 1-80 m (${where})`);
      const anchor = f.anchor?.value != null ? ANCHORS[f.anchor.value] : null;
      if (f.anchor?.value != null) {
        if (!anchor) throw new Error(`unknown anchor ${JSON.stringify(f.anchor.value)} (${where})`);
        if (!CONFIDENCES.includes(f.anchor.confidence)) throw new Error(`${where}.anchor: confidence ${JSON.stringify(f.anchor.confidence)} is not high, medium or low`);
      }
      const what = `${f.type}${f.name ? ` (${f.name})` : ''}`;
      const skip = (reason) => pending.push({ ...base, what, reason });
      if (e.status !== 'use') return skip(`${e.status}: ${f.note || 'the landmark applies nothing'}`);
      if (f.status !== 'use') return skip(f.note || `${f.status}`);
      if (!hasHeight) return skip(f.note || 'height unsourced');
      if (!anchor && f.position == null) return skip(f.note || 'position unsourced');
      if (!SHAPES.includes(f.type)) return skip(`no shape for ${f.type}`);
      let x = null, z = null;
      if (!anchor) {
        if (!Number.isFinite(f.position.lat) || !Number.isFinite(f.position.lon)) throw new Error(`${where}.position: expected { lat, lon }`);
        [x, z] = toLocal(f.position.lon, f.position.lat).map(q);
      }
      const type = f.type === 'steeple' ? 'spire' : f.type;
      const conf = [f.height.confidence, ...(anchor ? [f.anchor.confidence] : [])];
      features.push({ id: `${e.id}/${type}${list.filter((g, j) => j < i && g.type === f.type).length || ''}`, osm: e.osm, type, x, z,
        anchor: anchor || 'position', top: f.height.value, base: GROUND_TYPES.includes(type) ? 'ground' : 'roof', style,
        confidence: lowest(conf), sources: sourcesOf([f.height]) });
    });

    if (e.status === 'flag-only') {
      flagged.push({ ...base, name: e.name, reason: e.status1993?.value ?? e.notes ?? 'flag-only' });
      continue;
    }
    if (e.status !== 'use') {
      pending.push({ ...base, what: e.missing?.length ? e.missing.join('; ') : 'everything', reason: `${e.status}${e.notes ? `: ${e.notes}` : ''}` });
      continue;
    }
    if (e.missing?.length) pending.push({ ...base, what: e.missing.join('; '), reason: 'not sourced yet; the sourced values are applied' });

    if (isNode) {
      // A monument: a free-standing shape at its node
      if (e.kind !== 'monument') throw new Error(`node ${e.osm} is not kind "monument" (${name})`);
      if (e.form?.value?.type !== 'obelisk') throw new Error(`monument form ${JSON.stringify(e.form?.value?.type)} is not obelisk (${name})`);
      if (!checkField(`${e.id}.height`, e.height)) throw new Error(`monument without a sourced height (${name})`);
      if (!(e.height.value >= 1 && e.height.value <= 80)) throw new Error(`monument height ${e.height.value} m outside 1-80 m (${name})`);
      const [x, z] = toLocal(e.node.lon, e.node.lat).map(q);
      const applied = [e.height, e.form, ...(e.facade?.value ? [e.facade] : [])];
      features.push({ id: e.id, osm: e.osm, type: 'obelisk', x, z, anchor: 'node', top: e.height.value, base: 'ground',
        style: style || 'stone', confidence: lowest(applied.map((f) => f.confidence)), sources: sourcesOf(applied) });
      continue;
    }

    // A building: height precedence 1. height.value 2. levels x STOREY + 0.6 3. CC-003's height stays
    const applied = [];
    let height = null;
    if (e.height?.value != null) {
      height = e.height.value;
      applied.push(e.height);
    } else if (e.levels?.value != null) {
      height = round1(e.levels.value * STOREY + 0.6);
      applied.push(e.levels);
    }
    if (height !== null && !(height >= 2.5 && height <= 60)) throw new Error(`height ${height} m outside 2.5-60 m (${name})`);
    if (style) applied.push(e.facade);
    if (!applied.length) {
      pending.push({ ...base, what: 'height, storeys and facade', reason: 'status use, but nothing sourced to apply' });
      continue;
    }
    if (height !== null) stats.src3++;
    else stats.styleOnly++;
    buildings.push({ id: e.id, osm: e.osm, name: e.name, daveRequested: !!e.daveRequested, height, src: height !== null ? SRC_LANDMARK : null,
      style, confidence: lowest(applied.map((f) => f.confidence)), sources: sourcesOf(applied) });
  }

  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  buildings.sort(byId);
  features.sort(byId);
  flagged.sort(byId);
  pending.sort((a, b) => (b.daveRequested - a.daveRequested) || byId(a, b));
  return { buildings, features, pending, flagged, stats };
}

export function serialize(result, sha256) {
  const list = (items) => `[\n${items.map((v) => `    ${JSON.stringify(v)}`).join(',\n')}\n  ]`;
  return [
    '// js/gf-landmarks.js — GENERATED by tools/gf/build-gf-landmarks.mjs, do not edit by hand.',
    '// Sourced overrides for notable Glens Falls landmarks (CC-004), from tools/gf/data/gf_landmarks.json: building',
    '// heights (src 3), facade styles and roof features, each with its sources and the lowest confidence of what was',
    '// applied, and the Civil War Monument (an obelisk at its OSM node, in the GF_GEO frame). pending lists what is',
    '// waiting on data and was skipped; flagged lists post-1993 buildings, reported only. js/gf-landmark-records.js',
    '// applies this layer on top of the CC-003 records (js/gf-buildings.js stays as it is).',
    `// OSM ids and the monument node position: ${ATTRIBUTION}`,
    'export const GF_LANDMARKS = {',
    `  source: 'tools/gf/data/gf_landmarks.json',`,
    `  sha256: ${JSON.stringify(sha256)},`,
    `  attribution: ${JSON.stringify(ATTRIBUTION)},`,
    `  srcCode: ${SRC_LANDMARK},`,
    `  buildings: ${list(result.buildings)},`,
    `  features: ${list(result.features)},`,
    `  pending: ${list(result.pending)},`,
    `  flagged: ${list(result.flagged)}`,
    '};',
    ''
  ].join('\n');
}

function main() {
  const { lat0, lon0, theta } = GF_GEO.frame;
  if (lat0 !== LAT0 || lon0 !== LON0 || theta !== THETA) throw new Error('geo-frame.mjs and js/gf-geodata.js disagree on the frame');
  const bytes = fs.readFileSync(path.join(DATA, 'gf_landmarks.json'));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const result = buildGfLandmarks(JSON.parse(bytes.toString('utf8')), GF_BUILDINGS);
  const text = serialize(result, sha256);
  fs.writeFileSync(OUT, text);

  const { buildings, features, pending, flagged, stats } = result;
  log(`${stats.entries} entries (${Object.entries(stats.status).map(([k, v]) => `${v} ${k}`).join(', ')}), sha256 ${sha256}`);
  log(`buildings applied: ${buildings.length} (${stats.src3} with a sourced height, src 3; ${stats.styleOnly} style only)`);
  for (const b of buildings) log(`  ${b.daveRequested ? '★ ' : ''}${b.id} ${b.osm}: ${b.height !== null ? `${b.height} m` : 'height unchanged'}${b.style ? `, ${b.style}` : ''} (${b.confidence})`);
  log(`features applied: ${features.length}`);
  for (const f of features) log(`  ${f.id}: ${f.type} to ${f.top} m from the ${f.base}, at ${f.anchor}${f.x !== null ? ` (${f.x}, ${f.z})` : ''} (${f.confidence})`);
  log(`pending: ${pending.length} (Dave-requested first)`);
  for (const p of pending) log(`  ${p.daveRequested ? '★ ' : ''}${p.id} ${p.osm}: ${p.what} — ${p.reason}`);
  log(`flag-only: ${flagged.map((f) => `${f.id} ${f.osm} (${f.reason})`).join('; ')}`);
  log(`wrote ${path.relative(process.cwd(), OUT)} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
