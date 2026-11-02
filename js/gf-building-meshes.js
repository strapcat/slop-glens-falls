import * as THREE from 'three/webgpu';
import { createPreWarBuildingMaterial } from './tsl-materials.js';
import { createBuildingFootprints } from './building-footprints.js';
import { createGfBuildingRecords, neighboursFor, STYLES } from './gf-building-records.js';
import { FACADES } from './gf-facades.js';
import { applyGfLandmarks, neighbourRecords } from './gf-landmark-records.js';
import { buildGfLandmarkFeatures } from './gf-landmark-meshes.js';

// Glens Falls's OSM building footprints (js/gf-buildings.js) as flat-roofed extrusions on the flat ground, drawn by
// the footprint mesher New York's surveyed buildings use (building-footprints.js: one merged mesh per 1 km cell and
// facade style). Three facade styles from the pre-war masonry shader, recoloured, on Glens Falls's 3.3 m storeys:
// brick and stone take New York's two masonry presets' colours; clapboard is a light painted tone for houses. Brick
// and stone buildings get blank party walls where they adjoin a neighbour; houses stand apart. (The tones are in
// gf-facades.js.) With GF_LANDMARKS (CC-004), the sourced landmark overrides go on top of the CC-003 records first,
// and the landmark features (roof shapes, the Civil War Monument) are drawn too.

// { group, colliders, obstacles, stats } of GF_BUILDINGS (and, given GF_LANDMARKS, `landmarks: { applied, features,
// pending }`); the group is added to the scene
function buildGfBuildings(scene, data, landmarks = null) {
  const base = createGfBuildingRecords(data);
  const result = landmarks ? applyGfLandmarks(base, landmarks) : base;
  const { records, colliders, obstacles } = result;
  const neighbours = neighboursFor(landmarks ? neighbourRecords(result) : records);
  const group = new THREE.Group();
  group.name = 'GlensFallsBuildings';
  const stats = { records: {}, meshes: 0, triangles: 0 };
  for (const style of STYLES) {
    const list = records.filter((r) => r.style === style);
    stats.records[style] = list.length;
    if (!list.length) continue;
    const material = createPreWarBuildingMaterial({ ...FACADES[style], footprintLocal: true, floorHeight: data.storey });
    const chunks = createBuildingFootprints(material, list, style === 'clapboard' ? undefined : neighbours, { base: 0 });
    chunks.name = `GlensFallsBuildings-${style}`;
    for (const mesh of chunks.children) {
      stats.meshes++;
      stats.triangles += mesh.geometry.index.count / 3;
    }
    group.add(chunks);
  }
  scene.add(group);
  if (!landmarks) return { group, colliders, obstacles, stats };
  const shapes = buildGfLandmarkFeatures(group, result.features);
  return { group, colliders, obstacles, stats, landmarks: { applied: result.applied, features: result.features, pending: landmarks.pending, flagged: landmarks.flagged, shapes: shapes.stats } };
}

export { buildGfBuildings, FACADES };
