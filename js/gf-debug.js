import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Glens Falls geodata debug view (gf.html, or index.html?city=glensfalls): js/gf-geodata.js drawn flat, roads as
// ribbons at their curb widths, blocks as 0.15 m slabs (property line in a lighter tone), water as blue planes.

const CLASS_COLORS = {
  motorway: 0xe8913a, trunk: 0xeba24a, primary: 0xf2c94c, secondary: 0xf5dc8a, tertiary: 0xf4f1e8,
  unclassified: 0xb4b8bd, residential: 0xa3a8ae, living_street: 0x93b3a0, service: 0x737a82
};
const BLOCK_H = 0.15;
const LOT_Y = 0.2; // property line drawn just above the slab top
const ROAD_Y = 0.25; // above the blocks, so service ways inside blocks stay visible

// Layers centimetres apart seen from kilometres away: polygon offset keeps them ordered at any depth precision
const layerMaterial = (color, layer) => new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -4 * layer });

const unflat = (f) => { const r = []; for (let i = 0; i < f.length; i += 2) r.push(new THREE.Vector2(f[i], -f[i + 1])); return r; };

// Flat ribbon (quad per segment + round joins) of every link of one highway class
function roadGeometry(graph, classIndex, rank) {
  const { nodes, links } = graph;
  const pos = [];
  const y = ROAD_Y + rank * 0.03;
  const disc = (x, z, r) => {
    const n = 8;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      pos.push(x, y, z, x + Math.cos(a1) * r, y, z + Math.sin(a1) * r, x + Math.cos(a0) * r, y, z + Math.sin(a0) * r);
    }
  };
  for (const [a, b, , cls, , , width, inner] of links) {
    if (cls !== classIndex) continue;
    const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
    const r = width / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 1e-6) continue;
      const nx = (-(z1 - z0) / L) * r, nz = ((x1 - x0) / L) * r;
      pos.push(x0 + nx, y, z0 + nz, x1 - nx, y, z1 - nz, x1 + nx, y, z1 + nz);
      pos.push(x0 + nx, y, z0 + nz, x0 - nx, y, z0 - nz, x1 - nx, y, z1 - nz);
    }
    for (const [x, z] of pts) disc(x, z, r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// Shapes are built in (x, -z) and turned flat with rotateX(-90°), which maps shape (x, y) to world (x, z = -y)
function flatShapes(shapes, y, extrude) {
  const g = extrude ? new THREE.ExtrudeGeometry(shapes, { depth: extrude, bevelEnabled: false }) : new THREE.ShapeGeometry(shapes);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

function showError(message) {
  const el = document.getElementById('gf-error');
  el.textContent = message;
  el.style.display = 'block';
  document.getElementById('gf-stats').textContent = '';
}

async function init() {
  let GF_GEO;
  try {
    ({ GF_GEO } = await import('./gf-geodata.js'));
  } catch {
    showError('js/gf-geodata.js could not be loaded. Build it with: bash tools/gf/fetch.sh && node tools/gf/build-gf-geodata.mjs');
    return;
  }
  const { bbox, roadGraph, blocks, water } = GF_GEO;

  const container = document.getElementById('gf-canvas');
  const renderer = new THREE.WebGPURenderer({ antialias: true, reversedDepthBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2126);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-1, 2, 1.5);
  scene.add(sun);

  const cx = (bbox.x0 + bbox.x1) / 2, cz = (bbox.z0 + bbox.z1) / 2;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(bbox.x1 - bbox.x0, bbox.z1 - bbox.z0), new THREE.MeshLambertMaterial({ color: 0x3c4a3d }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, 0, cz);
  scene.add(ground);

  // Water
  const waterShapes = water.map((w) => {
    const s = new THREE.Shape(unflat(w.outer));
    for (const h of w.holes) s.holes.push(new THREE.Path(unflat(h)));
    return s;
  });
  if (waterShapes.length) scene.add(new THREE.Mesh(flatShapes(waterShapes, 0.03), new THREE.MeshLambertMaterial({ color: 0x2f6fb5 })));

  // Blocks: curb island slabs, property line on top
  const curbShapes = blocks.map((b) => new THREE.Shape(unflat(b.curb)));
  const lotShapes = blocks.filter((b) => b.lot).map((b) => new THREE.Shape(unflat(b.lot)));
  if (curbShapes.length) scene.add(new THREE.Mesh(flatShapes(curbShapes, 0, BLOCK_H), new THREE.MeshLambertMaterial({ color: 0xa9a397 })));
  if (lotShapes.length) scene.add(new THREE.Mesh(flatShapes(lotShapes, LOT_Y), layerMaterial(0xd6cfbf, 1)));

  // Roads, minor classes underneath
  const order = ['service', 'living_street', 'residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
  const legend = [];
  const classIndex = (c) => roadGraph.classes.indexOf(c);
  order.forEach((base, rank) => {
    for (const c of [base, base + '_link']) {
      const i = classIndex(c);
      if (i < 0) continue;
      scene.add(new THREE.Mesh(roadGeometry(roadGraph, i, rank), layerMaterial(CLASS_COLORS[base], 2 + rank)));
    }
    if (classIndex(base) >= 0) legend.push(base);
  });
  document.getElementById('gf-legend').innerHTML = legend
    .reverse()
    .map((c) => `<span style="background:#${CLASS_COLORS[c].toString(16).padStart(6, '0')}"></span>${c.replace('_', ' ')}`)
    .join('') + '<span style="background:#a9a397"></span>block<span style="background:#2f6fb5"></span>water';
  document.getElementById('gf-stats').textContent =
    `${roadGraph.nodes.length / 2} nodes · ${roadGraph.links.length} links · ${blocks.length} blocks · ${water.length} water polygons` +
    (GF_GEO.osmBase ? ` · OSM ${GF_GEO.osmBase.slice(0, 10)}` : '');

  // Camera: orbit with the mouse, fly with the keyboard
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 30000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.screenSpacePanning = false;
  // ?look=x,z,distance starts looking down at (x, z) from that distance (reproducible screenshots); else the whole bbox
  const look = (new URLSearchParams(location.search).get('look') || '').split(',').map(Number);
  const reset = () => {
    if (look.length === 3 && look.every(Number.isFinite)) {
      const [x, z, d] = look;
      controls.target.set(x, 0, z);
      camera.position.set(x, d * 0.85, z + d * 0.5);
    } else {
      controls.target.set(cx, 0, cz);
      camera.position.set(cx, (bbox.z1 - bbox.z0) * 1.15, cz + (bbox.z1 - bbox.z0) * 0.5);
    }
    controls.update();
  };
  reset();

  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyR') reset();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const forward = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    move.set(0, 0, 0);
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, camera.up).normalize();
    if (keys.has('KeyW') || keys.has('ArrowUp')) move.add(forward);
    if (keys.has('KeyS') || keys.has('ArrowDown')) move.sub(forward);
    if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) move.sub(right);
    if (keys.has('KeyE')) move.y += 1;
    if (keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq()) {
      const speed = Math.max(15, camera.position.distanceTo(controls.target) * 0.6) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1);
      move.normalize().multiplyScalar(speed * dt);
      if (camera.position.y + move.y < 2) move.y = 2 - camera.position.y;
      camera.position.add(move);
      controls.target.x += move.x;
      controls.target.z += move.z;
    }
    controls.update();
    // near plane follows the distance: the layers are centimetres apart and the view spans kilometres
    const dist = camera.position.distanceTo(controls.target);
    camera.near = Math.max(0.5, dist * 0.02);
    camera.far = dist * 10 + 10000;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  });
}

init();
