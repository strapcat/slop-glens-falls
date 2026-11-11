import * as THREE from 'three/webgpu';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { createPartySchedule, isNight } from './gf-thrill-hill-plan.js';

// CC-005c: the FICTIONAL Thrill Hill keg party (gf-thrill-hill-plan.js: the layout, the schedule and the scene's
// provenance) drawn. At night a fire burns in its stone ring (flames, embers and a flickering warm point light, one of
// the clustered lights; parked and dark by day), a keg stands beside it and the group (the game's generic people,
// pedestrians.js, their own small crowd) walks up the trail to stand round it. By day the fire is out (ash and charred
// logs in the ring), the keg is left and empty red cups lie about. setTime(interiorGlow) follows the game clock
// (lighting.js presets); update(dt, elapsed, camera) runs the people and the flicker.
//
// plan: planThrillHillParty(); ground(x, z): gf-surface.js ground.

const FIRE_LIGHT = { color: 0xff8a3a, intensity: 40, distance: 18, decay: 1.4, height: 1.0 }; // (traffic.js's police lamps: 42 at 12 m)
const DRAW_DISTANCE = 260; // m: beyond this the people are neither stepped nor drawn (the fire still shows)
const FEET = 0.02; // m above the ground, as the sidewalk walkers

function buildThrillHillParty(scene, plan, ground, { textureFallback = false } = {}) {
  const group = new THREE.Group();
  group.name = 'ThrillHillParty';
  const night = new THREE.Group(), day = new THREE.Group();
  night.name = 'PartyNight'; day.name = 'PartyDay';
  group.add(night, day);
  const { fire, keg } = plan;
  const add = (parent, geo, mat, x, y, z, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.name = name;
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // the stone ring (both times)
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 0.95 });
  const stoneGeo = new THREE.DodecahedronGeometry(0.17, 0);
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * Math.PI * 2, r = plan.constants.FIRE_RING - 0.17;
    const x = fire.x + Math.cos(a) * r, z = fire.z + Math.sin(a) * r;
    const s = add(group, stoneGeo, stoneMat, x, ground(x, z) + 0.06, z, 'FireStone');
    s.scale.set(1 + 0.3 * Math.sin(k * 2.1), 0.7 + 0.2 * Math.cos(k * 1.7), 1 + 0.25 * Math.cos(k * 3.3));
    s.rotation.set(k * 0.7, k * 1.3, 0);
  }

  // night: a burning teepee of logs, embers, flames and the light
  const logMat = new THREE.MeshStandardMaterial({ color: 0x5a3d26, roughness: 0.9 });
  const logGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.95, 7);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const l = add(night, logGeo, logMat, fire.x + Math.cos(a) * 0.2, fire.y + 0.36, fire.z + Math.sin(a) * 0.2, 'FireLog');
    l.rotation.set(0, -a, 0);
    l.rotateZ(0.42);
  }
  const emberMat = new THREE.MeshBasicMaterial({ color: 0xff5a1a });
  const embers = add(night, new THREE.CircleGeometry(0.42, 16), emberMat, fire.x, fire.y + 0.04, fire.z, 'FireEmbers');
  embers.rotation.x = -Math.PI / 2;
  embers.castShadow = false;
  const flameMats = [0xffd27a, 0xff9a3a, 0xff6a1a].map((color) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  const flames = [];
  for (let k = 0; k < 5; k++) {
    const h = 0.9 - k * 0.1;
    const f = add(night, new THREE.ConeGeometry(0.2 - k * 0.015, h, 8, 1, true), flameMats[k % 3],
      fire.x + Math.cos(k * 1.9) * 0.1 * (k > 0), fire.y + 0.1 + h / 2, fire.z + Math.sin(k * 1.9) * 0.1 * (k > 0), 'Flame');
    f.castShadow = f.receiveShadow = false;
    f.userData.h = h;
    flames.push(f);
  }
  const light = new THREE.PointLight(FIRE_LIGHT.color, 0, FIRE_LIGHT.distance, FIRE_LIGHT.decay);
  light.name = 'FireLight';
  light.position.set(fire.x, -1000, fire.z);
  group.add(light);

  // day: ash and charred logs in the ring
  const ash = add(day, new THREE.CircleGeometry(0.55, 18), new THREE.MeshStandardMaterial({ color: 0x8b8781, roughness: 1 }), fire.x, fire.y + 0.03, fire.z, 'FireAsh');
  ash.rotation.x = -Math.PI / 2;
  const charMat = new THREE.MeshStandardMaterial({ color: 0x1e1a17, roughness: 1 });
  const charGeo = new THREE.CylinderGeometry(0.055, 0.06, 0.7, 7);
  for (let k = 0; k < 4; k++) {
    const a = k * 1.4 + 0.3;
    const l = add(day, charGeo, charMat, fire.x + Math.cos(a) * 0.12, fire.y + 0.08, fire.z + Math.sin(a) * 0.12, 'CharredLog');
    l.rotation.set(Math.PI / 2, 0, a);
  }

  // the keg (both times: full by night, left empty by day)
  const kegMat = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.35, metalness: 0.85 });
  add(group, new THREE.CylinderGeometry(keg.r, keg.r, keg.h, 18), kegMat, keg.x, keg.y + keg.h / 2, keg.z, 'Keg');
  const ribGeo = new THREE.TorusGeometry(keg.r + 0.005, 0.012, 6, 24);
  for (const y of [0.12, keg.h - 0.12]) add(group, ribGeo, kegMat, keg.x, keg.y + y, keg.z, 'KegRib').rotation.x = Math.PI / 2;
  add(group, new THREE.BoxGeometry(0.08, 0.1, 0.08), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }), keg.x, keg.y + keg.h + 0.05, keg.z, 'KegTap');

  // the repeated props as one instanced draw each (fewer draw calls, also in the shadow pass)
  for (const [parent, name] of [[group, 'FireStone'], [night, 'FireLog'], [day, 'CharredLog'], [group, 'KegRib']]) {
    const parts = parent.children.filter((c) => c.name === name);
    const inst = new THREE.InstancedMesh(parts[0].geometry, parts[0].material, parts.length);
    inst.name = name + 's';
    inst.castShadow = inst.receiveShadow = true;
    parts.forEach((p, k) => { p.updateMatrix(); inst.setMatrixAt(k, p.matrix); parent.remove(p); });
    parent.add(inst);
  }

  // day: empty red cups (one instanced draw)
  const cupGeo = new THREE.CylinderGeometry(0.045, 0.032, 0.11, 10, 1, true);
  const cups = new THREE.InstancedMesh(cupGeo, new THREE.MeshStandardMaterial({ color: 0xc8161d, roughness: 0.5, side: THREE.DoubleSide }), plan.cups.length);
  cups.name = 'RedCups';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  plan.cups.forEach((c, k) => {
    e.set(c.lying ? Math.PI / 2 : 0, c.yaw, 0, 'YXZ');
    q.setFromEuler(e);
    m4.compose(v.set(c.x, c.y + (c.lying ? 0.045 : 0.055), c.z), q, one);
    cups.setMatrixAt(k, m4);
  });
  cups.castShadow = true;
  day.add(cups);

  // the people: their own small crowd (the city's pedestrians are untouched)
  const crowd = new PersonCrowd(plan.slots.length, { textureFallback });
  for (const mesh of crowd.meshes) group.add(mesh);
  const schedule = createPartySchedule(plan);
  const rigs = schedule.people.map((p) => {
    const i = p.slot.i, female = (i * 7 + 3) % 5 < 2;
    return new PersonRig({ seed: 500 + i * 1.6180339, female, scale: (female ? 0.92 : 0.98) + ((i * 37) % 10) / 100, girth: 0.92 + ((i * 53) % 20) / 100,
      hair: female ? 1 : ((i * 13) % 10) / 30, armSwing: 0.9, stride: 1 });
  });
  const feet = (owner, x, z) => ground(x, z) + FEET;

  scene.add(group);
  let state = null;
  function setTime(interiorGlow, { instant = false } = {}) {
    const on = isNight(interiorGlow);
    const changed = state !== on;
    state = on;
    night.visible = on;
    day.visible = !on;
    light.intensity = on ? FIRE_LIGHT.intensity : 0;
    light.position.y = on ? fire.y + FIRE_LIGHT.height : -1000;
    schedule.setNight(on, { instant });
    return changed;
  }

  // step the people (and the fire's flicker) by dt; camera: { x, z } for the draw distance
  function update(dt, elapsed, camera) {
    schedule.update(dt);
    const dx = camera ? camera.x - fire.x : 0, dz = camera ? camera.z - fire.z : 0;
    const near = dx * dx + dz * dz < DRAW_DISTANCE * DRAW_DISTANCE;
    crowd.begin();
    schedule.people.forEach((p, k) => {
      const rig = rigs[k];
      if (!near || !schedule.visible(p)) { rig.placed = false; return; }
      // in place: face the fire with a little sway of the head and shoulders
      const sway = p.phase === 'at' ? Math.sin(elapsed * (0.4 + k * 0.07) + k) * 0.25 : 0;
      // CC-NPC1: someone the player is talking to turns to them (gf-npc-talk.js sets talkFacing; NaN or unset: the fire)
      rig.update(dt, p.x, p.z, Number.isFinite(p.talkFacing) ? p.talkFacing : p.heading + sway, feet, p, 0, true);
      crowd.add(rig, Math.hypot(p.x - (camera ? camera.x : p.x), p.z - (camera ? camera.z : p.z)));
    });
    crowd.end();
    if (state) {
      const t = elapsed * 9;
      light.intensity = FIRE_LIGHT.intensity * (0.82 + 0.1 * Math.sin(t) + 0.08 * Math.sin(t * 2.7 + 1.3));
      flames.forEach((f, k) => {
        const s = 0.85 + 0.2 * Math.sin(t * (1 + k * 0.23) + k * 1.7);
        f.scale.set(1, s, 1);
        f.position.y = fire.y + 0.1 + (f.userData.h * s) / 2;
      });
    }
  }

  const stats = () => ({ night: state, people: schedule.counts(), slots: plan.slots.length, cups: plan.cups.length,
    fire: { x: +fire.x.toFixed(2), z: +fire.z.toFixed(2), y: +fire.y.toFixed(2) }, keg: { x: +keg.x.toFixed(2), z: +keg.z.toFixed(2) },
    light: { intensity: +light.intensity.toFixed(2), y: +light.position.y.toFixed(2) }, meshes: group.children.length });
  return { group, setTime, update, schedule, stats, colliders: plan.colliders, light };
}

export { buildThrillHillParty, FIRE_LIGHT };
