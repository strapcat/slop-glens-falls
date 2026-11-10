import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createVehicleExit, findExitSpot, landingGate, exitCandidates, vehicleBody, bodyDistance, trafficBodies,
  EXIT_KEY, PERSON_RADIUS, STAND, LAND, EXIT_SPEED, ENTER_REACH
} from '../js/vehicle-exit.js';

// CC-005d: get out of the taxi or a landed helicopter, walk, get back in. The state machine and the safe-spot and
// landing rules (vehicle-exit.js) on exact fixtures, driving the real controllers.js methods (loaded as the other
// controller tests load them); New York's defaults unchanged.

const require = createRequire(import.meta.url);
const { loadModule } = require('./helpers/module.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const polygonCollision = loadModule(read('js/building-collision.js'));
const { ThirdPersonControllerManager } = loadModule(read('js/controllers.js'), {
  globals: { window: { addEventListener() {} }, document: { addEventListener() {}, hidden: false } },
  imports: {
    'three/webgpu': {}, './city-runtime.js': { streetZ: () => 0, isTypingInField: () => false }, './tsl-materials.js': {}, './cars.js': {},
    './helicopter.js': {}, './pedestrians.js': {}, './vehicle-lights.js': {}, './landmarks.js': {}, './building-collision.js': polygonCollision
  }
});

const vec = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } });
const mesh = () => ({ position: vec(), rotation: { x: 0, y: 0, z: 0, set() {} }, visible: true });
// A controller with the four entities as plain state (no 3D models), on flat ground at y 0 (walkers 0.03 above it)
function harness({ colliders = [] } = {}) {
  const m = Object.create(ThirdPersonControllerManager.prototype);
  m.keys = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  m.colliders = colliders;
  m._colliderCells = null;
  m._world = { groundNormalAt: () => {}, bounds: { minX: -1e4, maxX: 1e4, minZ: -1e4, maxZ: 1e4 } };
  m.getGroundHeight = (x, z, mode) => (mode === 'helicopter' ? 0 : 0.03);
  m.entities = {
    person: { type: 'person', position: vec(50, 0.03, 50), heading: 0, speed: 0, verticalVel: 0, mesh: mesh(),
      rig: { reset(...a) { this.resetArgs = a; }, update() {} }, crowd: { begin() {}, add() {}, end() {}, updates: 3 } },
    car: { type: 'car', position: vec(0, 0.03, 0), heading: 0, speed: 0, vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, mesh: mesh(),
      chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: [], carState: { value: { x: 1, w: 1 } } },
    cyclist: { type: 'cyclist', position: vec(-40, 0.03, 0), heading: 0, speed: 0, mesh: mesh() },
    helicopter: { type: 'helicopter', position: vec(30, 0.25, 0), heading: 0, speed: 0, verticalSpeed: 0, pitchAngle: 0, rollAngle: 0, mesh: mesh(),
      tiltPivot: { rotation: { x: 0, z: 0 }, position: { y: 0.1 } }, mainRotorPivot: { rotation: { y: 0 } }, tailRotorPivot: { rotation: { x: 0 } } }
  };
  m.activeMode = 'car';
  return m;
}
// The flat open world as the vehicle-exit probe sees it; overrides change pieces of it
const probeFor = (m, over = {}) => ({
  walkerGround: () => 0.03, support: () => 0, water: () => false,
  blocked: (x, z, y, r) => m.bodyBlockedAt(x, z, y, r), roadway: () => false, ...over
});
// select a mode as gf-main.js does (controllers.js setMode) and refresh the parked bodies
function press(ve, m) {
  const r = ve.press();
  if (r.ok) m.setMode(r.mode);
  ve.refresh();
  return r;
}

test('state machine: exit the taxi beside it, walk, re-enter the same taxi; a second press never doubles anything', () => {
  const m = harness();
  const ve = createVehicleExit(m, probeFor(m));
  const car = m.entities.car;
  assert.equal(EXIT_KEY, 'KeyF');
  // moving: refused, nothing changes
  car.speed = 6;
  let r = press(ve, m);
  assert.deepEqual([r.ok, r.reason, m.activeMode], [false, 'stop to get out', 'car']);
  car.speed = 0.4; // (below EXIT_SPEED: rolling to a stop)
  assert.ok(0.4 < EXIT_SPEED);
  r = press(ve, m);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(m.activeMode, 'person');
  const p = m.entities.person;
  assert.equal(r.spot.where, 'left 1.65 m', 'the driver\'s side first');
  assert.deepEqual([p.position.x, p.position.y, p.speed, p.boarded], [r.spot.x, 0.03, 0, false]);
  assert.ok(bodyDistance(car, 'car', p.position.x, p.position.z) >= PERSON_RADIUS, 'clear of the taxi by a body');
  assert.deepEqual(p.rig.resetArgs.slice(0, 3), [p.position.x, p.position.z, p.heading], 'feet planted afresh at the spot');
  assert.deepEqual([car.speed, car.vx, car.vz, car.angularVel, car.carState.value.x], [0, 0, 0, 0, 0], 'the taxi parked: stopped, lamps off');
  assert.equal(m.parkedColliders.length, 1, 'the parked taxi is a body to walk round');
  const parkedAt = [car.position.x, car.position.z, car.heading];
  // walking: the taxi stays put
  m.keys.forward = 1;
  for (let i = 0; i < 30; i++) m.updatePerson(1 / 30);
  m.keys.forward = false;
  assert.deepEqual([car.position.x, car.position.z, car.heading], parkedAt);
  // back in: the same taxi, the walker aboard (hidden, not walking off, no body)
  p.position.x = r.spot.x; p.position.z = r.spot.z;
  r = press(ve, m);
  assert.deepEqual([r.ok, r.mode, m.activeMode, p.boarded], [true, 'car', 'car', true]);
  assert.equal(m.parkedColliders.length, 0, 'nothing parked while the taxi is driven');
  // the boarded walker does not wander while the taxi is driven (controllers.js update)
  m.updateCar = () => {};
  m.poseCharacters = () => {};
  const at = [p.position.x, p.position.z];
  m.update(0.5, 0);
  assert.deepEqual([p.position.x, p.position.z], at);
  // repeated presses alternate cleanly: exit, enter, exit...; never more than one walker or taxi
  for (let i = 0; i < 6; i++) {
    const before = m.activeMode;
    r = press(ve, m);
    assert.ok(r.ok, `press ${i}: ${JSON.stringify(r)}`);
    assert.equal(m.activeMode, before === 'car' ? 'person' : 'car');
    assert.deepEqual(Object.keys(m.entities), ['person', 'car', 'cyclist', 'helicopter']);
    assert.ok(m.parkedColliders.length <= 1);
  }
  // far from any vehicle on foot: refused, no change
  m.setMode('person');
  p.position.x = 80; p.position.z = 80;
  r = press(ve, m);
  assert.deepEqual([r.ok, m.activeMode], [false, 'person']);
  assert.match(r.reason, /no taxi or landed helicopter within reach/);
  // the bicycle: not offered
  m.setMode('cyclist');
  assert.deepEqual([press(ve, m).ok, m.activeMode], [false, 'cyclist']);
});

test('the parked taxi is solid to the walker; the mode buttons keep their old meaning', () => {
  const m = harness();
  const ve = createVehicleExit(m, probeFor(m));
  press(ve, m);
  const p = m.entities.person, car = m.entities.car;
  // walk straight at the taxi's side for 4 s: pushed round it, never inside it
  p.heading = Math.atan2(car.position.x - p.position.x, car.position.z - p.position.z);
  m.keys.forward = 1;
  let closest = Infinity;
  for (let i = 0; i < 120; i++) {
    p.heading = Math.atan2(car.position.x - p.position.x, car.position.z - p.position.z);
    m.updatePerson(1 / 30);
    closest = Math.min(closest, bodyDistance(car, 'car', p.position.x, p.position.z));
  }
  m.keys.forward = false;
  assert.ok(closest >= PERSON_RADIUS - 1e-6, `${closest} m from the taxi's body`);
  // mode 1 ('person') unboards a walker who boarded; mode 2 drives the parked taxi from where it stands
  press(ve, m);
  assert.equal(p.boarded, true);
  m.setMode('person');
  assert.equal(p.boarded, false);
  m.setMode('car');
  assert.equal(m.activeMode, 'car');
});

test('safe spot: water, buildings, trunks, steep ground and drops are skipped; the first clear berm is taken', () => {
  const car = { position: { x: 0, y: 0.03, z: 0 }, heading: 0 }; // facing +z: its left (the driver's side) is +x
  const open = { ground: () => 0.03, water: () => false, blocked: () => false, roadway: () => false };
  assert.equal(findExitSpot(car, 'car', open, 0.03).where, 'left 1.65 m');
  // the candidates: both sides at 1.65, 2.4 and 3.2 m, four spots along each; then behind and in front
  const cands = exitCandidates(car, 'car');
  assert.equal(cands.length, 3 * 2 * 4 + 2 * 2);
  assert.ok(cands.every((c) => bodyDistance(car, 'car', c.x, c.z) >= PERSON_RADIUS + 0.05), 'every candidate clear of the taxi by a body');
  // and every exit spot is within reach to get back in (taxi and helicopter)
  for (const type of ['car', 'helicopter']) {
    for (const c of exitCandidates(car, type)) assert.ok(bodyDistance(car, type, c.x, c.z) <= ENTER_REACH[type], `${type} ${c.where}: back in from where you got out`);
  }
  // water on the left: the right side
  const wet = { ...open, water: (x) => x > 0.9 };
  assert.match(findExitSpot(car, 'car', wet, 0.03).where, /^right 1\.65/);
  // a building on both sides (|x| < 4): behind
  const walls = { ...open, blocked: (x, z, y, r) => Math.abs(x) - r < 4 && Math.abs(z) < 3 };
  assert.match(findExitSpot(car, 'car', walls, 0.03).where, /^behind/);
  // a trunk right where the first spot is: the next spot along
  const trunk = { ...open, blocked: (x, z, y, r) => Math.hypot(x - 1.65, z - 0.6) < r + 0.3 };
  assert.equal(findExitSpot(car, 'car', trunk, 0.03).where, 'left 1.65 m');
  assert.equal(findExitSpot(car, 'car', trunk, 0.03).z, -0.6);
  // steep ground on the left (a 1:1 bank beyond x 1): the right side
  const bank = { ...open, ground: (x) => 0.03 + Math.max(0, x - 1) * 1.0 };
  assert.match(findExitSpot(car, 'car', bank, 0.03).where, /^right/);
  // the taxi on a narrow bridge deck 6 m up: never off the side (a drop), but onto the deck behind it
  const onDeck = { position: { x: 0, y: 6.03, z: 0 }, heading: 0 };
  const deck = { ...open, ground: (x, z) => (Math.abs(x) < 1.2 && Math.abs(z) < 30 ? 6.03 : 0.03) };
  const ahead = findExitSpot(onDeck, 'car', deck, 6.03);
  assert.deepEqual([ahead.where, ahead.y], ['behind 1.2 m', 6.03]);
  // a drop on every side (only the taxi's own footprint up there): refused with the reason
  const plinth = { ...open, ground: (x, z) => (Math.abs(x) < 1.2 && Math.abs(z) < 2.5 ? 6.03 : 0.03) };
  assert.equal(findExitSpot(onDeck, 'car', plinth, 6.03).reason, 'a drop alongside');
  // nothing finite (off the map) everywhere: refused
  assert.equal(findExitSpot(car, 'car', { ...open, ground: () => NaN }, 0.03).reason, 'no ground there');
  // off the carriageway preferred: the road is |x| < 3; the first clear spot beyond it (3.2 m out) beats the shoulder
  const road = { ...open, roadway: (x) => Math.abs(x) < 3 };
  const off = findExitSpot(car, 'car', road, 0.03);
  assert.deepEqual([off.where, off.roadway], ['left 3.2 m', false]);
  // road everywhere: the shoulder (the first clear spot), marked as on the roadway, rather than no exit
  const shoulder = findExitSpot(car, 'car', { ...open, roadway: () => true }, 0.03);
  assert.deepEqual([shoulder.where, shoulder.roadway], ['left 1.65 m', true]);
  // the standing rules as documented
  assert.deepEqual([STAND.step, STAND.ring, STAND.relief], [1.0, 0.6, 0.35]);
});

test('helicopter: sets down only slow, low and over dry, gentle ground; then exit, re-enter, take off', () => {
  const h = { position: { x: 0, y: 0.25, z: 0 }, heading: 0, speed: 0, verticalSpeed: 0 };
  const dry = { support: () => 0, water: () => false };
  assert.deepEqual(landingGate(h, dry), { ok: true, y: 0 });
  assert.equal(landingGate({ ...h, speed: 3 }, dry).reason, 'too fast to land');
  assert.equal(landingGate({ ...h, position: { x: 0, y: 0.8, z: 0 }, verticalSpeed: -2 }, dry).reason, 'descending too fast');
  assert.equal(landingGate({ ...h, verticalSpeed: -16 }, dry).ok, true, 'at its hover floor it cannot sink further: the held descent key does not block landing');
  assert.equal(landingGate({ ...h, position: { x: 0, y: 20, z: 0 } }, dry).reason, 'too high to land');
  assert.equal(landingGate(h, { ...dry, water: (x) => x > 0.5 }).reason, 'over water', 'one skid over water is enough to refuse');
  assert.equal(landingGate(h, { ...dry, support: (x, z) => z * 0.3 }).reason, 'ground too steep');
  assert.equal(landingGate(h, { ...dry, support: () => NaN }).reason, 'no ground below');
  // where before how: over water while still descending says 'over water' (what the pilot must move for)
  assert.equal(landingGate({ ...h, verticalSpeed: -3, speed: 4 }, { ...dry, water: () => true }).reason, 'over water');
  // on a gentle slope it sets down on the highest skid support (never into the ground)
  const gentle = landingGate({ ...h, position: { x: 0, y: 0.9, z: 0 } }, { ...dry, support: (x, z) => z * 0.05 });
  assert.ok(gentle.ok && Math.abs(gentle.y - 2.15 * 0.05) < 1e-9);
  assert.deepEqual([LAND.maxSpeed, LAND.maxVertical, LAND.maxHeight, LAND.maxRelief], [2.0, 1.5, 1.2, 0.5]);

  // through the controller: mid-air refused, hovering low and slow: set down and out
  const m = harness();
  const ve = createVehicleExit(m, probeFor(m));
  m.setMode('helicopter');
  const heli = m.entities.helicopter;
  heli.position.y = 30;
  let r = press(ve, m);
  assert.deepEqual([r.ok, r.reason, m.activeMode, heli.landed], [false, 'too high to land', 'helicopter', undefined]);
  heli.position.y = 0.25;
  r = press(ve, m);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([m.activeMode, heli.landed, heli.position.y, heli.tiltPivot.position.y], ['person', true, 0, 0]);
  assert.ok(bodyDistance(heli, 'helicopter', r.spot.x, r.spot.z) >= PERSON_RADIUS);
  assert.equal(m.parkedColliders.length, 2, 'the landed helicopter and the taxi are bodies to walk round');
  // parked, its rotor stops (controllers.js update)
  m.updatePerson = () => {};
  m.poseCharacters = () => {};
  const rotor = heli.mainRotorPivot.rotation.y;
  m.update(0.5, 0);
  assert.equal(heli.mainRotorPivot.rotation.y, rotor);
  // back in: it stays on its skids until the pilot climbs
  r = press(ve, m);
  assert.deepEqual([r.ok, m.activeMode], [true, 'helicopter']);
  m.resolveHorizontalCollision = () => {};
  m.keys.forward = 1;
  m.updateHelicopter(0.5, 0);
  assert.deepEqual([heli.position.y, heli.speed, heli.landed], [0, 0, true], 'no creeping off on the skids');
  m.keys.forward = false;
  m.keys.up = 1;
  m.updateHelicopter(0.5, 0);
  assert.equal(heli.landed, false);
  assert.ok(heli.position.y > 0.25, 'took off');
  // over water: the HUD reason, no landing
  heli.position.y = 0.25; heli.verticalSpeed = 0; m.keys.up = false;
  const ve2 = createVehicleExit(m, probeFor(m, { water: () => true }));
  assert.deepEqual([ve2.status().ok, ve2.status().reason], [false, 'over water']);
});

test('traffic keeps behind a parked vehicle, keeps out of its lane when changing, and never spawns on it; none by default', () => {
  // traffic.js's own parked-body functions, run on their source (as tests/traffic.test.cjs runs its functions)
  const src = read('js/traffic.js');
  const grab = (re) => { const m = src.match(re); assert.ok(m, String(re)); return m[0]; };
  const code = [
    grab(/const LOOKAHEAD = \d+;/),
    grab(/  let parkedBodies = \[\];[\s\S]*?\n  function parkedBeside\(v, off\) \{[\s\S]*?\n  \}/)
  ].join('\n');
  const api = vm.runInNewContext(`${code}\n({ setParked, parkedGap, parkedBeside, get bodies() { return parkedBodies; } })`);
  const v = { x: 0, z: 0, yaw: 0, half: 2.25, halfWidth: 0.9, levelY: 0 };
  assert.equal(api.parkedGap(v, 0), Infinity, 'none by default: no gap');
  assert.equal(api.parkedBeside(v, 0), false);
  api.setParked([{ x: 0, z: 20, halfW: 0.86, halfL: 2.18, levelY: 0.03 }]);
  assert.ok(Math.abs(api.parkedGap(v, 0) - (20 - 2.25 - 2.18)) < 1e-9, 'a stopped leader ahead in the lane');
  assert.equal(api.parkedGap(v, 3.5), Infinity, 'not in the next lane');
  assert.equal(api.parkedBeside(v, 0), false, '20 m ahead: not beside');
  api.setParked([{ x: 0, z: 8, halfW: 0.86, halfL: 2.18, levelY: 0.03 }]);
  assert.equal(api.parkedBeside(v, 0), true, 'within a car length or so: a lane change into it is refused');
  assert.equal(api.parkedGap({ ...v, levelY: 8 }, 0), Infinity, 'a car on a deck above it is not held up');
  api.setParked(null);
  assert.equal(api.bodies.length, 0);
  // wired: lane changes, following and spawning consult it only when something is parked
  for (const s of ['if (parkedBodies.length && parkedBeside(v, off)) return false;', 'const kg = parkedGap(v, 0);',
    'if (parkedBodies.length && v.edge && parkedBodies.some((b) => Math.hypot(v.x - b.x, v.z - b.z) < 25)) v.edge = null;', 'setParked,']) {
    assert.ok(src.includes(s), s);
  }
  // the bodies the game hands it: the taxi whenever not driven; the helicopter only when landed and empty
  const m = harness();
  m.activeMode = 'car';
  assert.deepEqual(trafficBodies(m), []);
  m.activeMode = 'person';
  assert.deepEqual(trafficBodies(m).map((b) => b.type), ['car']);
  m.entities.helicopter.landed = true;
  assert.deepEqual(trafficBodies(m).map((b) => b.type), ['car', 'helicopter']);
  const body = vehicleBody(m.entities.helicopter, 'helicopter');
  assert.ok(body.obb.hz > 4 && body.minY < m.entities.helicopter.position.y);
});

test('New York: no exit key, no new modules, and the controllers behave as before without the opt-ins', () => {
  // NYC never loads vehicle-exit.js (nor any GF module); only Glens Falls preloads it
  assert.doesNotMatch(read('js/nyc-main.js'), /vehicle-exit|KeyF|setParked|setParkedColliders/);
  const mainJs = read('js/main.js');
  const nycList = mainJs.slice(0, mainJs.indexOf('const GF_PRELOADS'));
  assert.doesNotMatch(nycList, /vehicle-exit/);
  assert.match(mainJs.slice(mainJs.indexOf('const GF_PRELOADS')), /'vehicle-exit\.js'/);
  // controllers.js: no city names, and every new path keyed on state only vehicle-exit.js sets
  const ctl = read('js/controllers.js');
  assert.doesNotMatch(ctl, /glensfalls|glens falls|GF_/i);
  // the walker's WebGL 2 fallback is opt-in (Glens Falls's world sets it; New York's never does)
  assert.match(ctl, /new PersonCrowd\(1, \{ farDistance: Infinity, textureFallback: !!this\.world\.textureFallback \}\)/);
  assert.match(read('js/gf-runtime.js'), /textureFallback: true,/);
  for (const f of ['js/city-runtime.js', 'js/nyc-main.js', 'js/nyc-runtime.js', 'js/city-config.js']) if (fs.existsSync(path.join(root, f))) assert.doesNotMatch(read(f), /textureFallback/, f);
  // without the opt-ins: the inactive walker strolls on, the helicopter hovers at its 0.25 m floor and its rotor turns
  const m = harness();
  m.activeMode = 'car';
  m.updateCar = () => {};
  m.poseCharacters = () => {};
  const p = m.entities.person, heli = m.entities.helicopter;
  const z0 = p.position.z, rotor = heli.mainRotorPivot.rotation.y;
  m.update(1, 0);
  assert.ok(Math.abs(p.position.z - z0 - 1.48) < 1e-9, 'the walker walks on at 1.48 m/s, as before');
  assert.equal(heli.mainRotorPivot.rotation.y, rotor + 24);
  m.setMode('helicopter');
  m.resolveHorizontalCollision = () => {};
  heli.position.y = 0.3;
  m.keys.down = 1;
  m.updateHelicopter(1, 0);
  assert.equal(heli.position.y, 0.25, 'the old floor, not a landing');
  assert.equal(heli.landed, undefined);
  // no parked colliders: resolveHorizontalCollision leaves an open spot where it was
  const q = vec(5, 0, 5);
  m.setMode('person');
  m.resolveHorizontalCollision = ThirdPersonControllerManager.prototype.resolveHorizontalCollision;
  m.resolveHorizontalCollision(q, 0.48);
  assert.deepEqual([q.x, q.z], [5, 5]);
  assert.equal(m.parkedColliders, undefined);
  assert.deepEqual(ENTER_REACH, { car: 2.5, helicopter: 3.0 });
});
