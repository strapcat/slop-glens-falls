import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GF_BUILDINGS } from '../js/gf-buildings.js';
import { GF_LANDMARKS } from '../js/gf-landmarks.js';
import { GF_LIDAR_HEIGHTS } from '../js/gf-lidar-heights.js';
import { applyLidarHeights } from '../js/gf-building-heights.js';
import { gfBuildingsOnTerrain } from '../js/gf-building-bases.js';
import { GF_GEO } from '../js/gf-geodata.js';
import { createGfBlocks } from '../js/gf-blocks.js';
import { toLocal } from '../tools/gf/geo-frame.mjs';
import { planBuckley, inZone, APPROX_BUCKLEY, inRing } from '../js/gf-buckley-plan.js';
import {
  DAMAGE, REPAIR, MISSION_TEXT, damageFromImpact, speedFactor, smokeLevel, createVehicleDamage, createRepairMission, parseMissionText
} from '../js/gf-vehicle-damage.js';

// CC-BUCKLEY: Buckley Tire Service on Warren St (a modelled landmark on its OSM outline), vehicle damage, and the first
// repair mission

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ---------------------------------------------------------------- damage

const entities = () => ({ person: { type: 'person', speed: 0, position: { x: 0, y: 0, z: 0 } }, car: { type: 'car', speed: 0, position: { x: 0, y: 0, z: 0 } },
  cyclist: { type: 'cyclist', speed: 0, position: { x: 0, y: 0, z: 0 } }, helicopter: { type: 'helicopter', speed: 0, position: { x: 0, y: 0, z: 0 } } });

test('damage: gentle bumps do nothing; hard crashes add up, scaled by impact speed; a few hard ones wreck the car', () => {
  assert.equal(damageFromImpact(1), 0);
  assert.equal(damageFromImpact(DAMAGE.threshold), 0, 'a bump at the threshold');
  assert.ok(damageFromImpact(10) > 0 && damageFromImpact(20) > damageFromImpact(10), 'scaled by speed');
  assert.equal(damageFromImpact(200), DAMAGE.maxHit, 'one impact can do at most maxHit');
  const e = entities();
  const d = createVehicleDamage({ entities: e });
  // parking-lot bumps all day: nothing
  for (let t = 0; t < 100; t++) d.hit(e.car, 3, t);
  assert.equal(d.damage('car'), 0);
  // three hard crashes (45 mph) wreck it
  const hard = 20;
  d.hit(e.car, hard, 1000);
  assert.ok(d.damage('car') > 30 && d.damage('car') < 50, `one hard crash: ${d.damage('car')}`);
  d.hit(e.car, hard, 1010);
  d.hit(e.car, hard, 1020);
  assert.equal(d.damage('car'), 100, 'three hard crashes: wrecked');
  // the walker and the helicopter take none; another vehicle keeps its own damage
  assert.equal(d.hit(e.person, 30, 2000), 0);
  assert.equal(d.hit(e.helicopter, 30, 2000), 0);
  assert.equal(d.damage('cyclist'), 0);
  d.hit(e.cyclist, 15, 2000);
  assert.ok(d.damage('cyclist') > 0, 'the bike takes damage too');
  // an object that is not one of the player's vehicles (an AI car in traffic.js's event) is ignored
  assert.equal(d.hit({ speed: 0 }, 30, 3000), 0);
});

test('damage: one crash reporting over several frames counts once (its hardest report)', () => {
  const e = entities();
  const d = createVehicleDamage({ entities: e });
  d.hit(e.car, 18, 10);
  d.hit(e.car, 18, 10.02);
  d.hit(e.car, 16, 10.05);
  assert.equal(d.damage('car'), damageFromImpact(18));
  d.hit(e.car, 22, 10.1); // a harder report of the same crash: only what it adds
  assert.equal(d.damage('car'), damageFromImpact(22));
  d.hit(e.car, 18, 10 + DAMAGE.cooldown + 0.5); // a new crash
  assert.equal(d.damage('car'), damageFromImpact(22) + damageFromImpact(18));
});

test('damage: smoke above 50, heavier smoke and half speed above 80, a quarter at 100 (no explosions)', () => {
  assert.equal(smokeLevel(30), 'none');
  assert.equal(smokeLevel(50), 'none');
  assert.equal(smokeLevel(51), 'light');
  assert.equal(smokeLevel(81), 'heavy');
  assert.equal(speedFactor(80), 1);
  assert.equal(speedFactor(81), 0.5);
  assert.equal(speedFactor(100), 0.25);
  const e = entities();
  const d = createVehicleDamage({ entities: e });
  e.car.speed = 36;
  d.update();
  assert.equal(e.car.speed, 36, 'undamaged: no cap');
  d.set('car', 85);
  e.car.speed = 36;
  d.update();
  assert.equal(e.car.speed, 18, 'above 80: half the top speed');
  e.car.speed = -12;
  d.update();
  assert.equal(e.car.speed, -12, 'reverse under the cap is left alone');
  d.set('car', 100);
  e.car.speed = 30;
  d.update();
  assert.equal(e.car.speed, 9, 'at 100: still limps at a quarter');
  e.car.speed = -30;
  d.update();
  assert.equal(e.car.speed, -9, 'in reverse too');
  d.set('cyclist', 90);
  e.cyclist.speed = 19;
  d.update();
  assert.equal(e.cyclist.speed, 9.5, 'the bike: half its 19 m/s');
  // saved and restored with the player
  const saved = d.save();
  assert.deepEqual(saved, { car: 100, cyclist: 90 });
  const d2 = createVehicleDamage({ entities: e });
  d2.load(JSON.parse(JSON.stringify(saved)));
  assert.equal(d2.damage('car'), 100);
  d2.load({ car: 'junk', cyclist: 500 });
  assert.equal(d2.damage('car'), 100, 'junk ignored');
  assert.equal(d2.damage('cyclist'), 100, 'clamped');
});

// ---------------------------------------------------------------- the repair loop

const ZONE = { x: 100, z: -50, r: 3.4 };
function world() {
  const e = entities();
  const d = createVehicleDamage({ entities: e });
  const m = createRepairMission({ damage: d, zone: ZONE });
  const run = (seconds, mode = 'car', dt = 0.05) => { let v; for (let t = 0; t < seconds - 1e-9; t += dt) v = m.update(dt, mode, e[mode]); return v; };
  return { e, d, m, run };
}

test('repair: only stopped inside the zone, after settling 2 s and 3 s of "Fixing..."; damage back to 0', () => {
  const w = world();
  w.d.set('car', 60);
  // driving through the zone does nothing
  w.e.car.position = { x: 100, y: 0, z: -50 };
  w.e.car.speed = 5;
  w.run(10);
  assert.equal(w.d.damage('car'), 60);
  // stopped outside it (4 m off): nothing
  w.e.car.speed = 0;
  w.e.car.position = { x: 100, y: 0, z: -54 };
  w.run(10);
  assert.equal(w.d.damage('car'), 60);
  // stopped inside: settling, then fixing with progress, then done
  w.e.car.position = { x: 101, y: 0, z: -49 };
  let v = w.run(1);
  assert.equal(v.phase, 'settling');
  assert.equal(v.message, MISSION_TEXT.settle);
  v = w.run(1.2);
  assert.equal(v.phase, 'fixing');
  assert.equal(v.fixingText, MISSION_TEXT.fixing);
  assert.ok(v.progress > 0 && v.progress < 0.2, `progress ${v.progress}`);
  v = w.run(1.5);
  assert.ok(v.progress > 0.4 && v.progress < 0.6);
  assert.equal(w.d.damage('car'), 60, 'not yet');
  v = w.run(1.6);
  assert.equal(w.d.damage('car'), 0, 'fixed');
  assert.equal(v.message, MISSION_TEXT.done);
  assert.equal(w.m.firstRepairDone, true);
  assert.equal(w.m.repairs, 1);
  assert.equal(smokeLevel(w.d.damage('car')), 'none', 'the smoke clears');
  assert.deepEqual(w.m.save(), { firstRepairDone: true, repairs: 1 });
  // the speed limit (REPAIR.stopped) and the timings are the documented ones
  assert.deepEqual([REPAIR.settle, REPAIR.work, REPAIR.stopped], [2, 3, 0.5]);
});

test('repair: driving off or creeping mid-fix cancels it; an undamaged car or the walker is not "repaired"', () => {
  const w = world();
  w.d.set('car', 40);
  w.e.car.position = { x: 100, y: 0, z: -50 };
  w.e.car.speed = 0;
  w.run(3); // fixing by now
  assert.equal(w.m.phase, 'fixing');
  w.e.car.speed = 0.8; // creeps forward
  w.run(0.1);
  assert.equal(w.m.phase, 'idle');
  w.e.car.speed = 0;
  w.run(2.5); // starts over: settling, then fixing again
  assert.equal(w.m.phase, 'fixing');
  w.e.car.position = { x: 110, y: 0, z: -50 }; // leaves
  w.run(5);
  assert.equal(w.d.damage('car'), 40, 'not fixed');
  // nothing to fix: never starts
  const u = world();
  u.e.car.position = { x: 100, y: 0, z: -50 };
  assert.equal(u.run(10).phase, 'idle');
  // on foot in the zone: nothing
  u.d.set('car', 50);
  u.e.person.position = { x: 100, y: 0, z: -50 };
  assert.equal(u.run(10, 'person').phase, 'idle');
  assert.equal(u.d.damage('car'), 50);
});

test('repair: the hint shows once at 30 damage, fades, and the radar marks Buckley until the repair; cost hook', () => {
  const w = world();
  w.e.car.position = { x: 0, y: 0, z: 0 };
  let v = w.run(1);
  assert.equal(v.hint, null);
  assert.equal(v.marker, false);
  w.d.set('car', DAMAGE.hintAt - 1);
  assert.equal(w.run(1).hint, null, 'under 30: no hint');
  w.d.set('car', DAMAGE.hintAt);
  v = w.run(0.1);
  assert.equal(v.hint, MISSION_TEXT.hint);
  assert.equal(v.marker, true, 'Buckley on the radar');
  v = w.run(REPAIR.hintSeconds);
  assert.equal(v.hint, null, 'it fades after a few seconds');
  w.d.set('car', 70);
  assert.equal(w.run(1).hint, null, 'once: more damage does not repeat it');
  assert.equal(w.run(1).marker, true);
  // repaired: the marker goes; the next banged-up episode hints again
  w.e.car.position = { x: 100, y: 0, z: -50 };
  w.run(5.2);
  assert.equal(w.d.damage('car'), 0);
  w.e.car.position = { x: 0, y: 0, z: 0 };
  assert.equal(w.run(4).marker, false);
  w.d.set('car', 35);
  assert.equal(w.run(0.1).hint, MISSION_TEXT.hint);
  // the cost hook: a price that cannot be paid leaves the car broken (free today: REPAIR.cost 0)
  const e = entities();
  const d = createVehicleDamage({ entities: e });
  const asked = [];
  const m = createRepairMission({ damage: d, zone: ZONE, repairCost: (mode, dmg) => { asked.push([mode, dmg]); return 250; }, pay: () => false });
  d.set('car', 50);
  e.car.position = { x: 100, y: 0, z: -50 };
  for (let t = 0; t < 6; t += 0.05) m.update(0.05, 'car', e.car);
  assert.equal(d.damage('car'), 50);
  assert.deepEqual(asked[0], ['car', 50]);
  assert.equal(REPAIR.cost, 0);
});

test('the mission text: data/gf/mission-text.json, any missing key falls back; the NPC line bank is untouched', () => {
  const json = JSON.parse(read('data/gf/mission-text.json'));
  const text = parseMissionText(json);
  assert.equal(text.hint, "Your car's banged up. Get it to Buckley Tire on Warren St.");
  assert.equal(text.done, 'All set. Drive safe.');
  for (const k of Object.keys(MISSION_TEXT)) assert.ok(typeof text[k] === 'string' && text[k].length, k);
  assert.deepEqual(parseMissionText({ buckley: { hint: '', done: 'Ok.' } }), { ...MISSION_TEXT, done: 'Ok.' });
  assert.deepEqual(parseMissionText(null), MISSION_TEXT);
  // Dave's line bank (typos kept) is not edited; its Buckley family lines are not wired here (CC-CAST)
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'data/gf/npc-lines.json'))).digest('hex'),
    'f3e00f28270d36ec7db5f7619214f594d78e92617649aed04e50dcb8a7db4e81');
  for (const f of ['js/gf-vehicle-damage.js', 'js/gf-damage-view.js', 'js/gf-buckley-plan.js', 'js/gf-buckley-meshes.js']) {
    assert.doesNotMatch(read(f), /npc-lines|gf-npc/, f);
  }
});

// ---------------------------------------------------------------- the building

const { data } = applyLidarHeights(GF_BUILDINGS, GF_LIDAR_HEIGHTS);
const flat = () => 100;
const onTerrain = gfBuildingsOnTerrain(data, GF_LANDMARKS, flat);
const record = onTerrain.records.find((r) => r.model === 'buckley-tire');
const plan = planBuckley(record, { ground: flat });
const at = Object.fromEntries(GF_BUILDINGS.fields.map((f, i) => [f, i]));
const osmRow = GF_BUILDINGS.buildings.find((r) => r[at.osm] === 'w1190839200');
const osmRing = [];
for (let i = 0; i < osmRow[at.outer].length; i += 2) osmRing.push([osmRow[at.outer][i], osmRow[at.outer][i + 1]]);

test('Buckley Tire: the landmark is OSM way 1190839200 at 254 Warren St, Dave-requested, at its LiDAR height', () => {
  const doc = JSON.parse(read('tools/gf/data/gf_landmarks.json'));
  const e = doc.landmarks.find((l) => l.id === 'buckley-tire');
  assert.equal(e.osm, 'w1190839200');
  assert.equal(e.daveRequested, true);
  assert.equal(e.model.value, 'buckley-tire');
  assert.equal(e.height.value, 7.8);
  assert.equal(GF_LIDAR_HEIGHTS.heights.find((h) => h[0] === 'w1190839200')[1], 7.8, 'the LiDAR measurement');
  assert.match(e.model.note, /no Google imagery is committed, traced or used as a texture/);
  assert.equal(e.status1993.value, null, '1993 appearance: Dave to confirm');
  const b = GF_LANDMARKS.buildings.find((x) => x.id === 'buckley-tire');
  assert.deepEqual([b.osm, b.height, b.src, b.model, b.daveRequested], ['w1190839200', 7.8, 3, 'buckley-tire', true]);
  // Dave's place pin (43.3104147, -73.6266758) falls inside the OSM outline, at its Warren St front
  const [px, pz] = toLocal(-73.6266758, 43.3104147);
  assert.ok(inRing(osmRing, px, pz), 'the pin is on the footprint');
  // the record keeps the outline, collider and obstacle (only the drawing changes)
  assert.ok(record && record.landmark === 'buckley-tire');
  assert.deepEqual(record.polygons[0].outer.map((p) => [p.x, p.z]), osmRing);
});

test('Buckley Tire: the model stands on the OSM outline, front block on Warren St, workshop behind at the LiDAR roof', () => {
  // the walls are the outline: every wall vertex is an outline vertex or on an outline edge (the front / rear cut)
  const onOutline = (x, z) => osmRing.some((p, i) => {
    const q = osmRing[(i + 1) % osmRing.length], dx = q[0] - p[0], dz = q[1] - p[1], l2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / l2));
    return Math.hypot(x - p[0] - dx * t, z - p[1] - dz * t) < 1e-6;
  });
  const walls = plan.parts.wall, yRear = 100 + APPROX_BUCKLEY.rearWall;
  let onIt = 0;
  for (let i = 0; i < walls.length; i += 3) {
    const [x, y, z] = [walls[i], walls[i + 1], walls[i + 2]];
    assert.ok(inRing(osmRing, x, z) || onOutline(x, z), 'a wall outside the footprint');
    // below the workshop's wall top every wall vertex is on the outline (above it: the arched roof's gable ends)
    if (y < yRear - 1e-6) { assert.ok(onOutline(x, z), `(${x}, ${y}, ${z}) off the outline`); onIt++; }
  }
  assert.ok(onIt >= osmRing.length * 2, `${onIt} wall vertices on the outline`);
  // the front faces Warren St (south), the bays at its west end, the workshop's roof at the LiDAR height
  assert.ok(plan.frame.nIn[1] < -0.9, 'the front looks south onto Warren St');
  assert.ok(plan.frame.B[0] > plan.frame.A[0]);
  assert.equal(plan.top, 100 + 7.8);
  const ys = (k) => plan.parts[k].filter((_, i) => i % 3 === 1);
  assert.ok(Math.abs(Math.max(...ys('metalRoof')) - (100 + 7.8)) < 1e-9, 'the arched roof tops out at the LiDAR roof');
  assert.ok(Math.max(...ys('fascia')) <= 100 + APPROX_BUCKLEY.frontWall + APPROX_BUCKLEY.fascia.h + 1e-9, 'the front block is low');
  for (const k of ['wall', 'trim', 'fascia', 'shingleEdge', 'roof', 'metalRoof', 'door', 'glass', 'entryGlass', 'brick', 'mortar', 'planter', 'shrub', 'sign', 'metal', 'apron', 'paint']) {
    assert.ok(plan.parts[k] && plan.parts[k].length, `${k} drawn`);
  }
  assert.equal(plan.bays.length, 2);
  assert.ok(plan.stats.rearWindows >= 6, 'tall windows down the workshop sides');
  // the repair spot: in front of the west bays, off the footprint, on Buckley's own lot (not on the street)
  const z = plan.zone;
  assert.ok(!inRing(osmRing, z.x, z.z), 'not inside the building');
  const blocks = createGfBlocks(GF_GEO);
  const block = blocks.blockAt(z.x, z.z);
  assert.ok(block, 'on a block, not the roadway');
  for (const a of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const x = z.x + Math.cos((a * Math.PI) / 4) * z.r, zz = z.z + Math.sin((a * Math.PI) / 4) * z.r;
    assert.equal(blocks.blockAt(x, zz), block, 'the whole spot is off the street');
    assert.ok(!inRing(osmRing, x, zz), 'and clear of the walls');
  }
  assert.ok(inZone(z, z.x, z.z) && !inZone(z, z.x + z.r + 0.1, z.z));
  const bayMid = (plan.bays[0].s0 + plan.bays[1].s1) / 2;
  assert.equal(APPROX_BUCKLEY.zone.s, bayMid, 'centred on the two bays');
});

// front-frame coordinates of a world point: s along the Warren St front (west to east), t into the building
const frameOf = (x, z) => {
  const { A, u, nIn } = plan.frame;
  return [(x - A[0]) * u[0] + (z - A[1]) * u[1], (x - A[0]) * nIn[0] + (z - A[1]) * nIn[1]];
};
// a painted colour of gf-buckley-meshes.js (it imports three.js, so read from its source) and its luminance 0..1
const paint = (k) => Number(read('js/gf-buckley-meshes.js').match(new RegExp(`\\n  ${k}: (0x[0-9a-f]{6})`))[1]);
const lum = (c) => (0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)) / 255;
const verts = (k) => { const v = plan.parts[k] || [], out = []; for (let i = 0; i < v.length; i += 3) out.push([v[i], v[i + 1], v[i + 2]]); return out; };

test('Buckley Tire look (CC-BUCKLEY-fix): aluminium storefront frames, red brick piers and band, shingle rows', () => {
  const sf = plan.storefront, W = APPROX_BUCKLEY.windows, Br = APPROX_BUCKLEY.brick;
  // the storefront's frames and mullions are aluminium: no reddish-brown trim in front of the windows above the foot band
  for (const [x, y, z] of verts('trim')) {
    const [s, t] = frameOf(x, z);
    if (t < 0 && s > sf.w0 - 1e-6 && s < sf.w1 + 1e-6) assert.ok(y <= 100 + 0.35 + 1e-6, `trim at (${s.toFixed(2)}, ${y.toFixed(2)}) on the storefront`);
  }
  const metalOnFront = verts('metal').map(([x, y, z]) => [...frameOf(x, z), y]).filter(([s, t]) => t < 0 && s >= sf.w0 - W.frame - 1e-6 && s <= sf.w1 + W.frame + 1e-6);
  assert.ok(metalOnFront.some(([, , y]) => Math.abs(y - (sf.head + W.frame)) < 1e-6), 'an aluminium head');
  assert.ok(metalOnFront.some(([, , y]) => Math.abs(y - (sf.sill - W.frame)) < 1e-6), 'an aluminium sill');
  const nPanes = Math.max(1, Math.round((sf.w1 - sf.w0) / W.pane));
  const mullions = new Set(metalOnFront.filter(([, , y]) => Math.abs(y - sf.sill) < 1e-6).map(([s]) => s.toFixed(3)));
  assert.ok(mullions.size >= 2 * (nPanes + 1), `${nPanes + 1} mullions`);
  // red brick: a pier each side of the windows from the ground to the head, and a ~0.3 m band right over the windows
  assert.equal(sf.piers.length, 2);
  assert.ok(sf.piers[0][1] <= sf.w0 && sf.piers[1][0] >= sf.w1, 'the piers flank the windows');
  for (const [p0, p1] of sf.piers) assert.ok(p1 - p0 > 0.2 && p1 - p0 < 0.5, 'narrow piers');
  assert.ok(Math.abs(sf.band[1] - sf.band[0] - 0.3) < 1e-9 && Math.abs(sf.band[0] - (sf.head + W.frame)) < 1e-9, 'a 0.3 m band directly over the frame');
  const brick = verts('brick').map(([x, y, z]) => [...frameOf(x, z), y]);
  assert.ok(brick.some(([s, t, y]) => t < 0 && Math.abs(y - 100) < 1e-6 && s <= sf.w0), 'the west pier reaches the ground');
  assert.ok(brick.some(([s, t, y]) => t < 0 && Math.abs(y - sf.band[1]) < 1e-6 && s >= sf.w1), 'the band spans the windows');
  assert.ok(plan.sign.every(([, y]) => y >= sf.band[1] - 1e-6), 'the sign sits above the brick band, which stays visible');
  assert.ok(plan.stats.brickCourses >= 3 * 2 + 3 + 3, 'mortar courses on the piers and bands');
  assert.equal(paint('brick'), 0x8e3a2e, 'plain brick red');
  // the mansard: shingle rows about every 0.25 m, stepped (each row's butt stands proud), all round the front block
  assert.ok(plan.stats.shingleRows >= 4, `${plan.stats.shingleRows} shingle rows`);
  const rowYs = new Set(verts('shingleEdge').map(([, y]) => y.toFixed(4)));
  assert.equal(rowYs.size, plan.stats.shingleRows, 'a butt at each row');
  const sides = new Set();
  for (const [x, , z] of verts('shingleEdge')) { const [s, t] = frameOf(x, z); sides.add(t < 1 ? 'front' : s < 2 ? 'west' : s > plan.frame.length - 2 ? 'east' : 'back'); }
  for (const side of ['front', 'west', 'east']) assert.ok(sides.has(side), `shingles on the ${side}`);
  assert.equal(APPROX_BUCKLEY.fascia.row, 0.25);
});

test('Buckley Tire look (CC-BUCKLEY-fix): the east-corner entrance is a framed glass door with a push bar and a transom', () => {
  const e = plan.entrance, Ent = APPROX_BUCKLEY.entrance;
  assert.ok(Math.abs(e.door[1] - e.door[0] - Ent.door) < 1e-9 && e.door[0] > Ent.margin && e.door[1] < e.length - Ent.margin, 'a door with sidelights');
  assert.ok(Math.abs(e.bar - (100 + Ent.bar)) < 1e-9, 'a push bar at 1 m');
  assert.ok(e.transom[0] > e.doorTop && Math.abs(e.transom[1] - e.transom[0] - Ent.transom) < 1e-9, 'a glass transom over the door');
  assert.ok(Math.abs(e.band[1] - e.band[0] - 0.3) < 1e-9, 'the brick band over the entrance too');
  const ys = (k) => verts(k).map(([, y]) => y);
  assert.ok(ys('entryGlass').some((y) => Math.abs(y - e.transom[1]) < 1e-9), 'the transom is glass');
  assert.ok(ys('metal').some((y) => Math.abs(y - (e.bar + 0.03)) < 1e-9), 'the push bar is aluminium');
  assert.ok(ys('metal').some((y) => Math.abs(y - (e.transom[1] + Ent.frame)) < 1e-9), 'an aluminium head over the transom');
  // the transom's lettering face sits on the transom
  assert.equal(plan.transom.length, 4);
  for (const [, y] of plan.transom) assert.ok(y >= e.transom[0] - 1e-9 && y <= e.transom[1] + 1e-9);
  // its glass reads lighter and glossier than the storefront's
  assert.ok(lum(paint('entryGlass')) > lum(paint('glass')) + 0.1, 'lighter glass at the entrance');
  // every entrance part stands on the corner edge just outside the outline (not inside the building, not out on the apron)
  const onCorner = verts('entryGlass').every(([x, , z]) => !inRing(osmRing, x, z));
  assert.ok(onCorner);
});

test('Buckley Tire: no outside imagery: plain colours and a canvas-drawn sign, nothing loaded from a file or Google', () => {
  for (const f of ['js/gf-buckley-plan.js', 'js/gf-buckley-meshes.js', 'js/gf-damage-view.js', 'css/gf-damage.css']) {
    const src = read(f);
    assert.doesNotMatch(src, /TextureLoader|ImageLoader|new Image\(|\.(png|jpe?g|webp|gif|ktx2?)\b|googleapis|gstatic|streetview|maps\.google/i, f);
  }
  assert.match(read('js/gf-buckley-meshes.js'), /new THREE\.CanvasTexture\(canvas\)/);
  assert.match(read('js/gf-buckley-meshes.js'), /'BUCKLEY TIRE SERVICE'/);
  assert.match(read('js/gf-buckley-meshes.js'), /'Buckley Tire Service Inc\.'/);
  for (const f of ['js/gf-buckley-plan.js', 'js/gf-buckley-meshes.js']) {
    const code = read(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotMatch(code, /cooper|michelin|goodrich|bfg/i, `${f}: no modern brand signage`);
  }
  // no Buckley image anywhere in the repo's assets
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const images = ['js', 'css', 'data', 'tools/gf/data'].filter((d) => fs.existsSync(path.join(root, d))).flatMap(walk).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
  assert.deepEqual(images.filter((f) => /buckley/i.test(f)), []);
});

// ---------------------------------------------------------------- wiring, and New York

test('wiring: Glens Falls only, the shared modules untouched, New York loads none of it', () => {
  const main = read('js/main.js');
  const gfPre = main.slice(main.indexOf('GF_PRELOADS'), main.indexOf('];', main.indexOf('GF_PRELOADS')));
  const nycPre = main.slice(main.indexOf('NYC_PRELOADS'), main.indexOf('];', main.indexOf('NYC_PRELOADS')));
  for (const m of ['gf-buckley-plan.js', 'gf-buckley-meshes.js', 'gf-vehicle-damage.js', 'gf-damage-view.js']) {
    assert.match(gfPre, new RegExp(`'${m.replace('.', '\\.')}'`), m);
    assert.doesNotMatch(nycPre, new RegExp(m.replace('.', '\\.')), m);
  }
  assert.doesNotMatch(read('js/nyc-main.js'), /gf-vehicle-damage|gf-damage-view|gf-buckley|mission-text/);
  for (const f of ['js/controllers.js', 'js/traffic.js', 'js/touch-controls.js', 'js/cameras.js', 'js/pedestrian-system.js']) {
    assert.doesNotMatch(read(f), /damage\.hit|gf-vehicle-damage|buckley|city\s*===/i, f);
  }
  const gfMain = read('js/gf-main.js');
  // the existing collision events, the speed cap after the controllers move, the save
  assert.match(gfMain, /controllerManager\.setCollisionListener\(\(e\) => damage\.hit\(e\.a, e\.speed, impactClock\(\)\)\)/);
  assert.match(gfMain, /trafficSystem\.setCollisionListener\(\(e\) => \{ damage\.hit\(e\.a, e\.speed, impactClock\(\)\); damage\.hit\(e\.b, e\.speed, impactClock\(\)\); \}\)/);
  assert.ok(gfMain.includes('controllerManager.update(dt, elapsed, cameraSystem.initialized ? cameraSystem.currentPos : null);\n    damage.update();'),
    'the speed cap right after the controllers move the vehicles');
  assert.match(gfMain, /damage: damage\.save\(\), mission: mission\.save\(\)/);
  assert.match(gfMain, /damage\.load\(saved\.damage\);\n\s*mission\.load\(saved\.mission\);/);
  // the radar marker hook from CC-MINIMAP, with a drawn wrench
  assert.match(read('js/gf-damage-view.js'), /radar\.setMarker\('buckley-tire', \{ x: zone\.x, z: zone\.z, color: '#f5b62a', icon: 'wrench' \}\)/);
  assert.match(read('js/gf-minimap.js'), /if \(m\.icon === 'wrench'\) drawWrench\(ctx, sx, sy, 5\.2\);/);
  // the touch layout for the chip and the toast lives under body.touch-enabled (gf-mobile.css)
  const mobile = read('css/gf-mobile.css');
  assert.match(mobile, /body\.touch-enabled #gf-damage \{/);
  assert.match(mobile, /body\.touch-enabled #gf-mission \{/);
  // ...and on touch screens the chip moves to <body>, out of the blurred speed panel that would otherwise anchor its
  // fixed position (it showed behind the toast on a 390x844 screen before this)
  assert.match(read('js/gf-damage-view.js'), /const home = touch \? doc\.body : cluster;/);
});
