import * as THREE from 'three/webgpu';
import { attribute, color, float, smoothstep, vec3 } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { lampGlow, GLOW_ON } from './gf-street-lights.js';

// CC-006: Glens Falls's crosswalk paint, stop signs and street lights as meshes (the placements: gf-crossings.js,
// gf-stop-signs.js, gf-street-lights.js). Few draw calls whatever the counts:
//   crosswalk bars  one merged mesh: white ladder bars across each crosswalk, draped on the road surface
//   stop signs      two instanced meshes: posts with the octagon's grey back and rim, and the red STOP faces
//   street lights   one instanced mesh (pole, arm and head merged; the head's underside glows), and a pool of POOL
//                   point lights handed every REASSIGN seconds to the lamps nearest the camera, all lit by
//                   lampGlow(interiorGlow): off at midday and golden hour, on through twilight and midnight
// (a New York-style clustered pool; one real light per lamp would be thousands)

const BAR = { width: 0.45, gap: 0.55, length: 2.2, lift: 0.03 }; // m; lift above the road surface it is draped on
const SIGN = { post: 2.15, radius: 0.38, plate: 0.03 };
const LAMP = { pole: 7.2, poleR: 0.09, arm: 1.7, head: [0.62, 0.16, 0.3] };
const POOL = 32; // point lights
const POOL_RANGE = 160; // m: lamps further than this from the camera get none
const REASSIGN = 0.3; // s
const LIGHT = { color: 0xffc98a, intensity: 120, distance: 32, decay: 2 }; // candela: ~2.5 lux on the street under a 7 m head (300 lit the brick like dusk)

// A merged, draped mesh of ladder bars for crosswalks c (gf-crossings.js crossingAt), on surface(x, z)
function crosswalkGeometry(crosswalks, surface) {
  const pos = [], idx = [];
  for (const c of crosswalks) {
    const span = c.hi - c.lo;
    const n = Math.max(1, Math.floor((span - 0.3) / (BAR.width + BAR.gap)));
    const start = c.lo + (span - (n * BAR.width + (n - 1) * BAR.gap)) / 2;
    for (let k = 0; k < n; k++) {
      const o0 = start + k * (BAR.width + BAR.gap), o1 = o0 + BAR.width;
      const corners = [[o0, -BAR.length / 2], [o1, -BAR.length / 2], [o1, BAR.length / 2], [o0, BAR.length / 2]].map(([o, t]) => {
        const x = c.cx + c.lx * o + c.ux * t, z = c.cz + c.lz * o + c.uz * t;
        return [x, surface(x, z) + BAR.lift, z];
      });
      const b = pos.length / 3;
      for (const p of corners) pos.push(...p);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nrm = g.attributes.normal;
  for (let v = 0; v < nrm.count; v++) if (nrm.getY(v) < 0) nrm.setXYZ(v, -nrm.getX(v), -nrm.getY(v), -nrm.getZ(v));
  g.computeBoundingSphere();
  return g;
}

// The STOP face: a red octagon with a white rim and the word, on a canvas (the browser) or plain red (no document)
function stopTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const oct = (r) => {
    g.beginPath();
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4;
      g[k ? 'lineTo' : 'moveTo'](128 + r * Math.cos(a), 128 + r * Math.sin(a));
    }
    g.closePath();
  };
  g.fillStyle = '#ffffff'; oct(127); g.fill();
  g.fillStyle = '#b5121b'; oct(116); g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 74px Arial, Helvetica, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('STOP', 128, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// One instance matrix per placement: at (x, y, z), turned so local +x points along (fx, fz)
const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
function place(mesh, i, x, y, z, fx, fz) {
  q.setFromAxisAngle(up, Math.atan2(-fz, fx));
  mesh.setMatrixAt(i, m4.compose(v3.set(x, y, z), q, one));
}

// A lamp standard: pole, arm reaching +x over the road and a cobra-ish head; attribute glow 1 on the head's underside
function lampGeometry() {
  const parts = [];
  const pole = new THREE.CylinderGeometry(LAMP.poleR * 0.75, LAMP.poleR, LAMP.pole, 6, 1, true);
  pole.translate(0, LAMP.pole / 2, 0);
  const arm = new THREE.BoxGeometry(LAMP.arm, 0.08, 0.08);
  arm.translate(LAMP.arm / 2, LAMP.pole - 0.15, 0);
  const head = new THREE.BoxGeometry(...LAMP.head);
  head.translate(LAMP.arm + LAMP.head[0] / 2 - 0.1, LAMP.pole - 0.2, 0);
  for (const [g, glow] of [[pole, 0], [arm, 0], [head, 1]]) {
    const ng = g.index ? g.toNonIndexed() : g;
    const n = ng.attributes.position.count;
    const gl = new Float32Array(n);
    // the head's underside (its downward faces) glows
    for (let v = 0; v < n; v++) gl[v] = glow && ng.attributes.normal.getY(v) < -0.5 ? 1 : 0;
    ng.setAttribute('glow', new THREE.BufferAttribute(gl, 1));
    parts.push(ng);
  }
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'glow']) {
    const size = parts[0].attributes[name].itemSize;
    const total = parts.reduce((t, p) => t + p.attributes[name].count, 0);
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const p of parts) { arr.set(p.attributes[name].array, o); o += p.attributes[name].array.length; }
    merged.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return merged;
}

// crosswalks: painted crosswalks; signs: gf-stop-signs.js drawn; lamps: gf-street-lights.js. surface(x, z): the road
// surface (bars); ground(x, z): the ground (posts and poles). Returns { group, update(cameraPosition, dt), stats }
function buildGfStreetFurniture(scene, { crosswalks = [], signs = [], lamps = [], surface, ground }) {
  const group = new THREE.Group();
  group.name = 'GlensFallsStreetFurniture';
  scene.add(group);
  const stats = { crosswalks: crosswalks.length, bars: 0, signs: signs.length, lamps: lamps.length, drawCalls: 0, poolLights: POOL };

  if (crosswalks.length) {
    const g = crosswalkGeometry(crosswalks, surface);
    stats.bars = g.index.count / 6;
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    m.name = 'CrosswalkBars';
    m.receiveShadow = true;
    group.add(m);
    stats.drawCalls++;
  }

  if (signs.length) {
    const post = new THREE.CylinderGeometry(0.035, 0.035, SIGN.post, 6, 1, true);
    post.translate(0, SIGN.post / 2, 0);
    // the octagon: an 8-sided disc, its axis along local +x (facing the arriving traffic)
    const back = new THREE.CylinderGeometry(SIGN.radius, SIGN.radius, SIGN.plate, 8, 1, false);
    back.rotateZ(Math.PI / 2);
    back.rotateX(Math.PI / 8);
    back.translate(-0.02, SIGN.post + SIGN.radius * 0.8, 0);
    const postsMesh = new THREE.InstancedMesh(mergePlain([post, back]), new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.55, metalness: 0.4 }), signs.length);
    const face = new THREE.CircleGeometry(SIGN.radius * 0.995, 8, Math.PI / 8);
    face.rotateY(Math.PI / 2);
    face.translate(SIGN.plate / 2 + 0.002 - 0.02, SIGN.post + SIGN.radius * 0.8, 0);
    const map = stopTexture();
    const faceMesh = new THREE.InstancedMesh(face, new THREE.MeshStandardMaterial(map ? { map, roughness: 0.45 } : { color: 0xb5121b, roughness: 0.45 }), signs.length);
    signs.forEach((s, i) => {
      const y = ground(s.x, s.z);
      place(postsMesh, i, s.x, y, s.z, s.dx, s.dz);
      place(faceMesh, i, s.x, y, s.z, s.dx, s.dz);
    });
    for (const m of [postsMesh, faceMesh]) {
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      m.computeBoundingSphere();
      group.add(m);
    }
    postsMesh.name = 'StopSignPosts';
    faceMesh.name = 'StopSignFaces';
    stats.drawCalls += 2;
  }

  const pool = [];
  if (lamps.length) {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.35 });
    const glow = attribute('glow', 'float');
    mat.colorNode = color(0x55595c).mul(float(1).sub(glow)).add(vec3(0.9, 0.86, 0.78).mul(glow));
    mat.emissiveNode = color(0xffd29a).mul(glow).mul(smoothstep(GLOW_ON[0], GLOW_ON[1], cityUniforms.uInteriorGlow)).mul(6);
    const mesh = new THREE.InstancedMesh(lampGeometry(), mat, lamps.length);
    lamps.forEach((l, i) => place(mesh, i, l.x, ground(l.x, l.z), l.z, l.nx, l.nz));
    mesh.instanceMatrix.needsUpdate = true;
    // no sun shadows: the shadow passes would draw every lamp in town again (about 400k triangles) for 9 cm poles
    mesh.castShadow = false;
    mesh.computeBoundingSphere();
    mesh.name = 'StreetLights';
    group.add(mesh);
    stats.drawCalls++;
    for (let k = 0; k < POOL; k++) {
      const light = new THREE.PointLight(LIGHT.color, 0, LIGHT.distance, LIGHT.decay);
      light.castShadow = false;
      group.add(light);
      pool.push(light);
    }
  }

  // the lamps' light points: under each head
  const heads = lamps.map((l) => ({ x: l.x + l.nx * (LAMP.arm + 0.2), y: ground(l.x, l.z) + LAMP.pole - 0.45, z: l.z + l.nz * (LAMP.arm + 0.2) }));
  let since = Infinity, lit = 0;
  function update(cam, dt = 0) {
    since += dt;
    const g = lampGlow(cityUniforms.uInteriorGlow.value);
    if (!pool.length) return 0;
    // the pool's lights stay in the scene (a light appearing or going would rebuild the lit materials): off, they are
    // only dark
    if (g <= 0) {
      if (lit) for (const light of pool) light.intensity = 0;
      lit = 0;
      return 0;
    }
    if (since >= REASSIGN || !lit) {
      since = 0;
      const near = [];
      for (const h of heads) {
        const d = (h.x - cam.x) ** 2 + (h.z - cam.z) ** 2;
        if (d < POOL_RANGE * POOL_RANGE) near.push([d, h]);
      }
      near.sort((a, b) => a[0] - b[0]);
      lit = 0;
      pool.forEach((light, k) => {
        const h = near[k] && near[k][1];
        light.userData.on = !!h;
        // gf-main.js freezes the scene's world matrices once loaded: a light that moves updates its own
        if (h) { light.position.set(h.x, h.y, h.z); light.updateMatrixWorld(); lit++; }
      });
    }
    for (const light of pool) light.intensity = light.userData.on ? LIGHT.intensity * g : 0;
    return lit;
  }
  stats.pool = () => ({ lit, glow: lampGlow(cityUniforms.uInteriorGlow.value) });
  return { group, update, stats };
}

// Plain (position, normal) geometries merged into one
function mergePlain(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const total = parts.reduce((t, p) => t + p.attributes[name].array.length, 0);
    const arr = new Float32Array(total);
    let o = 0;
    for (const p of parts) { arr.set(p.attributes[name].array, o); o += p.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  return out;
}

export { buildGfStreetFurniture, crosswalkGeometry, BAR, SIGN, LAMP, POOL, POOL_RANGE, LIGHT };
