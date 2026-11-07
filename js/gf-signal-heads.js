import * as THREE from 'three/webgpu';
import { signalPhase } from './city-runtime.js';

// Plain Glens Falls traffic signals: at every signalled junction of the road network, one post with a three-lamp head
// for each road arriving there, on its right-hand curb a little before the stop line, facing the arriving traffic. The
// lamps show the phase traffic.js drives by: the arm's right-of-way group 0 the avenue phase, every other group the
// street phase. Three instanced meshes (posts, heads, lamps); the lamps' colours change only when a phase does.

const POST_H = 3.4;
const HEAD_H = 0.95;
const SET_BACK = 1.5; // m before the stop line
const LAMPS = ['red', 'amber', 'green'];
const LIT = { red: new THREE.Color(0xff2a1a), amber: new THREE.Color(0xffa41c), green: new THREE.Color(0x2bff6e) };
const DIM = { red: new THREE.Color(0x2a0c0a), amber: new THREE.Color(0x2a1d08), green: new THREE.Color(0x0a2a14) };

// ground(x, z): the terrain the posts stand on (CC-005b; none: the flat ground, y = 0)
function buildGfSignalHeads(scene, network, ground = null) {
  const group = new THREE.Group();
  group.name = 'GlensFallsSignalHeads';
  const heads = []; // { x, z, dx, dz, avenue }
  for (const n of network.nodes) {
    if (!n.signal) continue;
    for (const e of n.in) {
      const s = e.len - SET_BACK;
      const side = e.half + 0.8; // just past the curb
      heads.push({
        x: e.sx + e.dx * s + e.rx * side,
        z: e.sz + e.dz * s + e.rz * side,
        dx: e.dx,
        dz: e.dz,
        avenue: e.axisIndex === 0
      });
    }
  }

  const post = new THREE.CylinderGeometry(0.07, 0.09, POST_H, 8);
  post.translate(0, POST_H / 2, 0);
  const head = new THREE.BoxGeometry(0.36, HEAD_H, 0.28);
  const lamp = new THREE.SphereGeometry(0.11, 12, 8);
  const metal = new THREE.MeshStandardMaterial({ color: 0x2f3234, roughness: 0.6, metalness: 0.3 });
  const housing = new THREE.MeshStandardMaterial({ color: 0x1d1f12, roughness: 0.7 });
  const posts = new THREE.InstancedMesh(post, metal, Math.max(1, heads.length));
  const boxes = new THREE.InstancedMesh(head, housing, Math.max(1, heads.length));
  const lamps = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, heads.length * 3));
  posts.count = boxes.count = heads.length;
  lamps.count = heads.length * 3;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  heads.forEach((h, i) => {
    // the head's face (+z) turned towards the arriving traffic, which travels along (dx, dz); the post on the ground
    q.setFromAxisAngle(up, Math.atan2(-h.dx, -h.dz));
    const g = ground ? ground(h.x, h.z) : 0;
    posts.setMatrixAt(i, m.compose(p.set(h.x, g, h.z), q, one));
    const top = g + POST_H - HEAD_H / 2;
    boxes.setMatrixAt(i, m.compose(p.set(h.x, top, h.z), q, one));
    LAMPS.forEach((_, k) => {
      const y = top + (1 - k) * 0.29;
      lamps.setMatrixAt(i * 3 + k, m.compose(p.set(h.x - h.dx * 0.13, y, h.z - h.dz * 0.13), q, one));
    });
  });
  for (const mesh of [posts, boxes]) mesh.castShadow = true;
  group.add(posts, boxes, lamps);
  scene.add(group);

  let lastAve = null;
  let lastSt = null;
  // Lamp colours for the phases at `elapsed` seconds (signalPhase); a no-op while neither phase changes
  function update(elapsed) {
    const ave = signalPhase(elapsed, true);
    const st = signalPhase(elapsed, false);
    if (ave === lastAve && st === lastSt) return;
    lastAve = ave;
    lastSt = st;
    heads.forEach((h, i) => {
      const phase = h.avenue ? ave : st;
      LAMPS.forEach((name, k) => lamps.setColorAt(i * 3 + k, name === phase ? LIT[name] : DIM[name]));
    });
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  }
  update(0);

  return { group, update, count: heads.length };
}

export { buildGfSignalHeads };
