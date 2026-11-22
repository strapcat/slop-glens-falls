import * as THREE from 'three/webgpu';
import { planBuckley } from './gf-buckley-plan.js';

// CC-BUCKLEY: the meshes of a building with a procedural model (gf_landmarks.json model: buckley-tire), from its plan
// (gf-buckley-plan.js): one mesh per material, plain painted colours, no image textures. The only textures are the
// lettering on the sign ("BUCKLEY TIRE SERVICE", light on red) and on the entrance's glass transom ("Buckley Tire
// Service Inc.", light on clear), drawn on canvases here at run time. No modern brand signage.

// Painted colours (picked to match Dave's written descriptions; no imagery sampled)
const PAINT = {
  wall: 0xebe7dd, // white painted masonry
  trim: 0x7b3324, // reddish-brown trim
  brick: 0x8e3a2e, // the red brick band and piers round the storefront and the entrance
  mortar: 0xbfb3a3, // their mortar lines
  fascia: 0x6a3b2c, // brown / red shingles
  fasciaAlt: 0x5a3124, // every other shingle row, a shade darker
  shingleEdge: 0x2e1a13, // the shingle rows' butts, in shade
  roof: 0x3b3b3d, // flat roofs
  metalRoof: 0x8b9095, // the workshop's arched roof
  door: 0xe6dcc0, // cream sectional doors
  groove: 0xb7ab8d,
  glass: 0x1b222c, // the dark storefront glass
  entryGlass: 0x4c6474, // the entrance's clearer, glossier glass
  metal: 0xb9bdc2, // aluminium frames, window mullions, the push bar
  planter: 0x9b968c,
  shrub: 0x2f5627,
  sign: 0x9e1f19,
  apron: 0x4a4a4b, // weathered asphalt
  paint: 0xd8b642 // the repair bays' painted lines
};
const ROUGH = { glass: 0.15, entryGlass: 0.04, metal: 0.35, metalRoof: 0.45, apron: 0.95, paint: 0.8, brick: 0.92, mortar: 0.95 };
const METAL = { metal: 0.6, entryGlass: 0.35 };

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

// The entrance transom's lettering: light, on a clear (transparent) canvas laid over the glass
function transomTexture(doc) {
  const canvas = doc.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#f3efe6';
  ctx.font = '600 64px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Buckley Tire Service Inc.', canvas.width / 2, canvas.height / 2 + 2, canvas.width - 140);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A lettered quad over the corners [bl, br, tr, tl]
function letteredQuad(corners, material, name) {
  const [a, b, c, d] = corners;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  return mesh;
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
      const mat = new THREE.MeshStandardMaterial({ color: PAINT[key] ?? 0xff00ff, roughness: ROUGH[key] ?? 0.85, metalness: METAL[key] ?? 0, side: THREE.DoubleSide });
      if (key === 'apron' || key === 'paint') { mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1; }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${model.name}-${key}`;
      mesh.castShadow = key !== 'apron' && key !== 'paint';
      mesh.receiveShadow = true;
      model.add(mesh);
    }
    if (doc && typeof doc.createElement === 'function') {
      const signMat = new THREE.MeshStandardMaterial({ map: signTexture(doc), roughness: 0.6, side: THREE.DoubleSide, emissive: 0x2a0806 });
      model.add(letteredQuad(plan.sign, signMat, `${model.name}-sign-lettering`));
      const transomMat = new THREE.MeshStandardMaterial({ map: transomTexture(doc), transparent: true, depthWrite: false, roughness: 0.5, side: THREE.DoubleSide });
      model.add(letteredQuad(plan.transom, transomMat, `${model.name}-transom-lettering`));
    }
    group.add(model);
    out.push({ id: r.landmark || r.osm, osm: r.osm, plan });
  }
  return out;
}

export { buildGfModels, PAINT };
