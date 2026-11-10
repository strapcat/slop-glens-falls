// tools/gf/build-gf-downtown.mjs — writes js/gf-downtown.js from tools/gf/data/osm_gf_roads.json
// usage: node tools/gf/build-gf-downtown.mjs [out.js]        (GF_DATA=<dir> reads the raw JSON from another folder)
//
// CC-005e: where Glens Falls's sidewalks are "downtown" (concrete to a granite curb, no grass strip; Dave, from memory
// of 1993) rather than residential (a grass tree lawn between curb and walk). The downtown is the National Register
// Three Squares Historic District (Glens Falls MRA; listed 1984-09-29, NRIS 84003420; boundary increase 2022-11-15,
// NRIS 100008374). Its nomination map and the NPS boundary GIS could not be fetched from this build, so the envelope
// is drawn from the district's PUBLISHED bounding streets only, along their OSM centrelines:
//   1984: "roughly bounded by South, Glen, Maple and Ridge Sts."  -> loop A: Ridge St north from Centennial Circle
//         to Maple St, Maple St west to Bay St, Bay St south to Glen St (Monument Square, where South St begins),
//         Glen St back south-east to the circle.
//   2022: "roughly bounded by Broad, Maple, Pine and Glen (US 9) Sts." -> loop B: Glen St north-west from Monument
//         Square to Pine St, Pine St south to Broad St, Broad St east to South St, South St north to Monument Square.
// Each loop is the chain of OSM ways (and the nodes between) listed in LOOPS below; FRONTAGE metres either side of a
// loop's streets also count, so the far side of a bounding street (its frontage) is downtown too. This is an
// APPROXIMATE NRHP ENVELOPE for Dave to confirm, not the surveyed district boundary. No point is added: every vertex
// is an OSM node. The output depends only on the raw JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAT0, LON0, THETA, toLocal, q } from './geo-frame.mjs';
import { ATTRIBUTION } from './build-gf-geodata.mjs';

const DATA = process.env.GF_DATA || fileURLToPath(new URL('data/', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../../js/gf-downtown.js', import.meta.url));
const log = (...a) => console.log('[gf-downtown]', ...a);

export const FRONTAGE = 20; // m either side of a loop's streets
// [way, from node, to node]: the way's nodes from one to the other (either direction)
export const LOOPS = [
  {
    name: 'Three Squares 1984 (South, Glen, Maple, Ridge)',
    chain: [
      [187574477, 1982239387, 1982239405], // Ridge St, from Centennial Circle
      [771102123, 1982239405, 3040247909], // Ridge St
      [771102124, 3040247909, 6548617970], // Ridge St
      [1445954773, 6548617970, 1982239375], // Ridge St to Maple St
      [694837021, 1982239375, 2983969482], // Maple St west
      [20627751, 2983969482, 221411167], // Maple St to Bay St
      [92759391, 221411167, 691143958], // Bay St south
      [20626315, 691143958, 221400851], // Bay St to Glen St (Monument Square, South St's north end)
      [187574479, 221400851, 1982239404] // Glen St south-east to Centennial Circle
    ]
  },
  {
    name: 'Three Squares 2022 increase (Broad, Maple, Pine, Glen)',
    chain: [
      [187574479, 221400851, 221457352], // Glen St north-west from Monument Square to Pine St
      [20631832, 221457352, 221479130], // Pine St south
      [833236582, 221479130, 691144059], // Pine St
      [54928025, 691144059, 221404333], // Pine St to Broad St
      [20625731, 221404333, 10776995559], // Broad St east
      [1158881118, 10776995559, 1075878923], // Broad St to South St
      [1445933208, 1075878923, 221400855], // South St north
      [20625306, 221400855, 221400851] // South St to Monument Square
    ]
  }
];

export function buildGfDowntown(roadsJson) {
  if (!Array.isArray(roadsJson.elements) || roadsJson.remark) throw new Error('incomplete Overpass response for roads');
  const nodes = new Map(), ways = new Map();
  for (const e of roadsJson.elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.set(e.id, e);
  }
  const loops = LOOPS.map(({ name, chain }) => {
    const ids = [];
    for (const [wid, from, to] of chain) {
      const w = ways.get(wid);
      if (!w) throw new Error(`way ${wid} is not in the extract`);
      const i = w.nodes.indexOf(from), j = w.nodes.indexOf(to);
      if (i < 0 || j < 0) throw new Error(`way ${wid} (${w.tags && w.tags.name}) has no node ${i < 0 ? from : to}`);
      const part = i <= j ? w.nodes.slice(i, j + 1) : w.nodes.slice(j, i + 1).reverse();
      if (ids.length && ids[ids.length - 1] !== part[0]) throw new Error(`way ${wid} does not continue the chain`);
      ids.push(...(ids.length ? part.slice(1) : part));
    }
    if (ids[ids.length - 1] === ids[0]) ids.pop(); // closed on itself; else closed by a straight edge (loop A: the circle)
    const pts = ids.map((id) => {
      const n = nodes.get(id);
      if (!n) throw new Error(`node ${id} is missing`);
      return toLocal(n.lon, n.lat).map(q);
    });
    return { name, ring: pts.flat(), streets: [...new Set(chain.map(([wid]) => ways.get(wid).tags.name))] };
  });
  return {
    frame: { lat0: LAT0, lon0: LON0, theta: THETA },
    osmBase: (roadsJson.osm3s && roadsJson.osm3s.timestamp_osm_base) || null,
    frontage: FRONTAGE,
    loops,
    attribution: ATTRIBUTION
  };
}

// The module text for buildGfDowntown's result
export function moduleText(d) {
  return [
    '// js/gf-downtown.js — GENERATED by tools/gf/build-gf-downtown.mjs, do not edit by hand.',
    '// CC-005e: Glens Falls\'s downtown for the sidewalks (gf-sidewalks.js): an APPROXIMATE envelope of the National',
    '// Register Three Squares Historic District (NRIS 84003420, listed 1984; boundary increase NRIS 100008374, 2022),',
    '// drawn from its published bounding streets (1984: South, Glen, Maple, Ridge; 2022: Broad, Maple, Pine, Glen) along',
    '// their OSM centrelines, plus `frontage` metres either side of them. Not the surveyed boundary: Dave to confirm.',
    '// loops: { name, ring: flat [x, z, ...] of OSM nodes in the GF_GEO frame, streets }.',
    `// Data ${ATTRIBUTION}`,
    `export const GF_DOWNTOWN = ${JSON.stringify(d, null, 1).replace(/\n\s*/g, ' ')};`,
    ''
  ].join('\n');
}

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'osm_gf_roads.json'), 'utf8'));
  const d = buildGfDowntown(raw);
  fs.writeFileSync(OUT, moduleText(d));
  const area = (r) => { let s = 0; for (let i = 0; i < r.length; i += 2) { const j = (i + 2) % r.length; s += r[i] * r[j + 1] - r[j] * r[i + 1]; } return Math.abs(s) / 2; };
  for (const l of d.loops) log(`${l.name}: ${l.ring.length / 2} OSM nodes, ${Math.round(area(l.ring))} m² inside the centrelines (${(area(l.ring) / 4046.86).toFixed(1)} acres)`);
  log(`OSM base ${d.osmBase}; frontage ${d.frontage} m; wrote ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) main();
