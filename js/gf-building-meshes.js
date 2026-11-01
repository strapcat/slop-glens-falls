import * as THREE from 'three/webgpu';
import { createPreWarBuildingMaterial } from './tsl-materials.js';
import { createBuildingFootprints } from './building-footprints.js';
import { createGfBuildingRecords, neighboursFor, STYLES } from './gf-building-records.js';

// Glens Falls's OSM building footprints (js/gf-buildings.js) as flat-roofed extrusions on the flat ground, drawn by
// the footprint mesher New York's surveyed buildings use (building-footprints.js: one merged mesh per 1 km cell and
// facade style). Three facade styles from the pre-war masonry shader, recoloured, on Glens Falls's 3.3 m storeys:
// brick and stone take New York's two masonry presets' colours; clapboard is a light painted tone for houses. Brick
// and stone buildings get blank party walls where they adjoin a neighbour; houses stand apart.
const FACADES = {
  brick: { stoneColor: 0xa45a45, trimColor: 0xcab9a0, windowGlassColor: 0x16222e, windowWidth: 2.4, litProbability: 0.56, warmth: 0.86, seed: 27.8 },
  stone: { stoneColor: 0xd8cdb8, trimColor: 0x9e937f, windowGlassColor: 0x1a2836, windowWidth: 2.6, litProbability: 0.54, warmth: 0.80, seed: 12.4 },
  clapboard: { stoneColor: 0xd6d0c2, trimColor: 0x5e5a52, windowGlassColor: 0x1a2430, windowWidth: 2.2, litProbability: 0.4, warmth: 0.85, seed: 51.3 }
};

// { group, colliders, obstacles, stats } of GF_BUILDINGS; the group is added to the scene
function buildGfBuildings(scene, data) {
  const { records, colliders, obstacles } = createGfBuildingRecords(data);
  const neighbours = neighboursFor(records);
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
  return { group, colliders, obstacles, stats };
}

export { buildGfBuildings, FACADES };
