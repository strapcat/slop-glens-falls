// Glens Falls landmarks as data (no three.js, so Node tests use it as the game does): GF_LANDMARKS (js/gf-landmarks.js)
// applied on top of the CC-003 building records (js/gf-building-records.js), which stay as they are.
//
// - A building with a sourced override gets a copy of its record with the new height (src 3 only when the height came
//   from landmark data), facade style and `landmark` id; its player collider is copied with the new roof height.
// - Pedestrian and car obstacles are returned unchanged (the very same array), so the road network is identical.
// - Features (roof shapes, the monument) are resolved to world positions: a roof feature stands on its building's
//   (new) roof at the footprint's area centroid; the monument stands on the ground at its OSM node.
// - The monument gets one player collider (its plinth) and no pedestrian obstacle.

// The Civil War Monument's proportions. Only its total height (12.8 m, 42 ft) is sourced; every size here is
// approximate, not sourced (gf_landmarks.json: "base/plinth width and shaft proportions (approximate in code)").
const APPROX_OBELISK = {
  plinthW: 3.0, // approximate, not sourced: plinth width (square)
  plinthH: 1.8, // approximate, not sourced: plinth height
  shaftBottomW: 1.4, // approximate, not sourced: shaft width at its foot
  shaftTopW: 1.0, // approximate, not sourced: shaft width at its top
  pyramidionH: 1.0, // approximate, not sourced: pyramidion height
  pyramidionTopW: 0.45, // approximate, not sourced: the pyramidion's flat top, where the eagle stands
  eagleH: 0.8, // approximate, not sourced: the eagle stand-in block's height
  eagleW: 0.5 // approximate, not sourced: the eagle stand-in block's width
};

// Area centroid of a ring of { x, z } (falls back to the vertex mean for a degenerate ring)
function areaCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const c = ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    a += c;
    cx += (ring[j].x + ring[i].x) * c;
    cz += (ring[j].z + ring[i].z) * c;
  }
  if (Math.abs(a) < 1e-9) return { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, z: ring.reduce((s, p) => s + p.z, 0) / ring.length };
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

// { records, colliders, obstacles, features, applied } of the CC-003 records with GF_LANDMARKS on top
function applyGfLandmarks({ records, colliders, obstacles }, landmarks) {
  const index = new Map(records.map((r, i) => [r.osm, i]));
  const outRecords = records.slice();
  const outColliders = colliders.slice();
  const applied = [];
  for (const b of landmarks.buildings) {
    const i = index.get(b.osm);
    if (i === undefined) throw new Error(`landmark ${b.id}: no building record ${b.osm}`);
    const r = records[i];
    const height = b.height ?? r.height;
    const record = { ...r, height, src: b.height !== null ? landmarks.srcCode : r.src, style: b.style ?? r.style, landmark: b.id };
    outRecords[i] = record;
    outColliders[i] = { ...colliders[i], maxY: height };
    applied.push({ id: b.id, osm: b.osm, name: b.name, daveRequested: b.daveRequested, before: { height: r.height, src: r.src, style: r.style },
      after: { height: record.height, src: record.src, style: record.style }, confidence: b.confidence, sources: b.sources });
  }

  const features = [];
  for (const f of landmarks.features) {
    let x = f.x, z = f.z, base = 0, style = f.style;
    if (f.anchor !== 'node') {
      const i = index.get(f.osm);
      if (i === undefined) throw new Error(`landmark feature ${f.id}: no building record ${f.osm}`);
      const r = outRecords[i];
      if (f.anchor === 'centroid') ({ x, z } = areaCentroid(r.polygons[0].outer));
      if (f.base === 'roof') base = r.height;
      style = style ?? r.style;
      if (!(f.top > base)) throw new Error(`landmark feature ${f.id}: top ${f.top} m is not above its base ${base} m`);
      features.push({ id: f.id, type: f.type, x, z, base, top: f.top, style, polygon: r.polygons[0], confidence: f.confidence, sources: f.sources });
    } else {
      features.push({ id: f.id, type: f.type, x, z, base, top: f.top, style, confidence: f.confidence, sources: f.sources });
      if (f.type === 'obelisk') {
        // the plinth, as the player's collider; no pedestrian obstacle, so the sidewalk tracks stay CC-003's
        const h = APPROX_OBELISK.plinthW / 2;
        const outer = [{ x: x - h, z: z - h }, { x: x + h, z: z - h }, { x: x + h, z: z + h }, { x: x - h, z: z + h }];
        outColliders.push({ minX: x - h, maxX: x + h, minZ: z - h, maxZ: z + h, minY: 0, maxY: f.top, polygon: { outer, holes: [] }, landmark: f.id });
      }
    }
  }
  return { records: outRecords, colliders: outColliders, obstacles, features, applied };
}

// The records createBuildingFootprints's party walls (neighboursFor) must see: the overridden ones, at their new heights
const neighbourRecords = (result) => result.records;

export { applyGfLandmarks, neighbourRecords, areaCentroid, APPROX_OBELISK };
