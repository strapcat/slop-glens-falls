import * as THREE from 'three/webgpu';
import { planBuckley } from './gf-buckley-plan.js';

// CC-BUCKLEY: the meshes of a building with a procedural model (gf_landmarks.json model: buckley-tire), from its plan
// (gf-buckley-plan.js): one mesh per material, plain painted colours, no image textures. The only texture is the sign's
// lettering, drawn on a canvas here at run time ("BUCKLEY TIRE SERVICE", light on red).

// Painted colours (picked to match Dave's written description; no imagery sampled)
const PAINT = {
  wall: 0xebe7dd, // white painted masonry
  trim: 0x7b3324, // reddish-brown trim
  fascia: 0x6a3b2c, // brown / red shingles
  roof: 0x3b3b3d, // flat roofs
  metalRoof: 0x8b9095, // the workshop's arched roof
  door: 0xe6dcc0, // cream sectional doors
  groove: 0xb7ab8d,
  glass: 0x1b222c,
  metal: 0xb9bdc2, // aluminium frames, window mullions
  planter: 0x9b968c,
  shrub: 0x2f5627,
  sign: 0x9e1f19,
  apron: 0x4a4a4b, // weathered asphalt
  paint: 0xd8b642 // the repair bays' painted lines
};
const ROUGH = { glass: 0.15, metal: 0.35, metalRoof: 0.45, apron: 0.95, paint: 0.8 };

function signTexture(doc) {
  const canvas = doc.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#9e1f19';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#f1e6cf';
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.fillStyle = '#f4ead2';
  ctx.font = '800 76px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BUCKLEY TIRE SERVICE', canvas.width / 2, canvas.height / 2 + 4, canvas.width - 70);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Add each modelled record's meshes to `group`; returns [{ id, osm, plan }] (the plan carries the repair zone)
function buildGfModels(group, records, { ground = null, doc = globalThis.document } = {}) {
  const out = [];
  for (const r of records) {
    if (r.model !== 'buckley-tire') continue;
    const plan = planBuckley(r, { ground });
    const model = new THREE.Group();
    model.name = `GlensFallsModel-${r.landmark || r.osm}`;
    for (const [key, soup] of Object.entries(plan.parts)) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(soup, 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: PAINT[key] ?? 0xff00ff, roughness: ROUGH[key] ?? 0.85, metalness: key === 'metal' ? 0.6 : 0, side: THREE.DoubleSide });
      if (key === 'apron' || key === 'paint') { mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1; }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${model.name}-${key}`;
      mesh.castShadow = key !== 'apron' && key !== 'paint';
      mesh.receiveShadow = true;
      model.add(mesh);
    }
    if (doc && typeof doc.createElement === 'function') {
      const [a, b, c, d] = plan.sign;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ map: signTexture(doc), roughness: 0.6, side: THREE.DoubleSide, emissive: 0x2a0806 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${model.name}-sign-lettering`;
      model.add(mesh);
    }
    group.add(model);
    out.push({ id: r.landmark || r.osm, osm: r.osm, plan });
  }
  return out;
}

export { buildGfModels, PAINT };
