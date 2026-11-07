import * as THREE from 'three/webgpu';
import { createPreWarBuildingMaterial } from './tsl-materials.js';
import { createBuildingFootprints } from './building-footprints.js';
import { neighboursFor, STYLES } from './gf-building-records.js';
import { FACADES } from './gf-facades.js';
import { neighbourRecords } from './gf-landmark-records.js';
import { buildGfLandmarkFeatures } from './gf-landmark-meshes.js';
import { gfBuildingsOnTerrain } from './gf-building-bases.js';

// Glens Falls's buildings drawn on the CC-005b terrain: the records on their bases (gf-building-bases.js), by the same
// footprint mesher and facades as gf-building-meshes.js, each footprint standing on its own base (footprintBase: its
// storeys count up from it) and its party walls compared by absolute roof height.

// { group, colliders, obstacles, stats, landmarks } as gf-building-meshes.js buildGfBuildings, on the terrain
function buildGfBuildingsOnTerrain(scene, data, landmarks, ground) {
  const result = gfBuildingsOnTerrain(data, landmarks, ground);
  const { records, colliders, obstacles } = result;
  const flatNeighbours = neighboursFor(landmarks ? neighbourRecords(result) : records);
  const topOf = new Map(records.map((r) => [r.polygons, r.base + r.height]));
  const neighbours = (b) => flatNeighbours(b).map((nb) => ({ ...nb, top: topOf.get(nb.polygons) }));
  const group = new THREE.Group();
  group.name = 'GlensFallsBuildings';
  const stats = { records: {}, meshes: 0, triangles: 0 };
  for (const style of STYLES) {
    const list = records.filter((r) => r.style === style);
    stats.records[style] = list.length;
    if (!list.length) continue;
    const material = createPreWarBuildingMaterial({ ...FACADES[style], footprintLocal: true, floorHeight: data.storey, footprintBase: true });
    const chunks = createBuildingFootprints(material, list, style === 'clapboard' ? undefined : neighbours, { base: 0, footprintBase: true });
    chunks.name = `GlensFallsBuildings-${style}`;
    for (const mesh of chunks.children) {
      stats.meshes++;
      stats.triangles += mesh.geometry.index.count / 3;
    }
    group.add(chunks);
  }
  const exposed = records.map((r) => r.exposed), burial = records.map((r) => r.burial);
  stats.terrain = {
    foundationsOver1m: exposed.filter((v) => v > 1).length, foundationsOver3m: exposed.filter((v) => v > 3).length,
    maxFoundation: Math.max(...exposed), buriedOver1m: burial.filter((v) => v > 1).length, buriedOver3m: burial.filter((v) => v > 3).length,
    maxBurial: Math.max(...burial)
  };
  scene.add(group);
  if (!landmarks) return { group, colliders, obstacles, stats };
  const shapes = buildGfLandmarkFeatures(group, result.features);
  return { group, colliders, obstacles, stats, landmarks: { applied: result.applied, features: result.features, pending: landmarks.pending, flagged: landmarks.flagged, shapes: shapes.stats } };
}

export { buildGfBuildingsOnTerrain };
