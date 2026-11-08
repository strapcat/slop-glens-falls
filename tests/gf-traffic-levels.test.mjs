import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as physics from '../js/vehicle-physics.js';
import { decodeTerrain, createGfTerrain } from '../js/gf-terrain.js';
import { createGfSurface } from '../js/gf-surface.js';
import { GF_GEO } from '../js/gf-geodata.js';
import { GF_BRIDGES } from '../js/gf-bridges.js';

// CC-005b review: traffic contacts on a terrain compare levels. Each vehicle's ground or deck height is resolved
// (poseOnSurface) before collisions, and bodies whose vertical extents do not overlap (a car on a deck and one on the
// road beneath it) never touch. Without a surface (New York) no level is set and every contact is tested as before.
// The functions under test are traffic.js's own, run in a sandbox (as tests/vehicle-physics.test.cjs does), on the real
// Glens Falls surface.

const root = fileURLToPath(new URL('..', import.meta.url));
const src = fs.readFileSync(path.join(root, 'js/traffic.js'), 'utf8');
const T = createGfTerrain(decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(root, 'js/gf-terrain.bin.gz'))))), GF_GEO.frame);
const S = createGfSurface({ terrain: T, geo: GF_GEO, bridges: GF_BRIDGES });
const ROAD_LIFT = 0.03;
// as gf-main.js gives traffic its surface
const surfaceAt = (x, z, dx, dz, lastY = NaN) => S.road(x, z, dx, dz, lastY - ROAD_LIFT) + ROAD_LIFT;

function harness(vehicles, { surface = surfaceAt } = {}) {
  const constants = ['CAR_LEVEL_HEIGHT', 'BUS_LEVEL_HEIGHT', 'PLAYER_LEVEL_HEIGHT'].map((n) => {
    const m = src.match(new RegExp(`^const ${n} = [^;]+;`, 'm'));
    assert.ok(m, n);
    return m[0].replace(/^const /, 'var ');
  });
  const context = { ...physics, vehicles, contactA: {}, contactB: {}, vehicleHit: {}, impacted: [], collisionStep: 0,
    surfaceAt: surface, BODY_SPECS: { sedan: { wheelZ: 1.38, wheelX: 0.78 } }, BUS_SPEC: { wheelZ: 3, wheelX: 1.05 },
    clamp: (value, lo, hi) => Math.max(lo, Math.min(hi, value)),
    shove(v, dx, dz) { v.x += dx; v.z += dz; },
    contacts: 0, reportCollision() { context.contacts++; }, spawnCollisionSparks() {} };
  vm.createContext(context);
  vm.runInContext(constants.join('\n'), context);
  for (const name of ['poseOnSurface', 'readTrafficBody', 'writeTrafficVelocity', 'impactSuspension', 'collideWithPlayer', 'collideTraffic']) {
    const source = src.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`))?.[0];
    assert.ok(source, name);
    context[name] = vm.runInContext(`(${source})`, context);
  }
  return context;
}

// A car at (x, z) heading (dx, dz), moving at speed (and knocked, so the pair loop tests it)
function car(x, z, dx, dz, speed = 0, impactTime = 0) {
  const yaw = Math.atan2(dx, dz);
  return { x, z, prevX: x, prevZ: z, yaw, yawOffset: 0, yawRate: 0, yawVel: 0, half: 2.25, halfWidth: 0.86,
    tx: dx, tz: dz, speed, vx: 0, vz: 0, impactTime, pitchVel: 0, rollVel: 0, edge: { len: 100 }, bodyType: 'sedan' };
}

// A real crossing: a road (not a bridge) passing under a deck with the most clearance, its heading and the deck's
const crossing = (() => {
  const { nodes, links, linkFields } = GF_GEO.roadGraph;
  const at = Object.fromEntries(linkFields.map((f, k) => [f, k]));
  const onBridge = new Set(GF_BRIDGES.bridges.flatMap((b) => b.segments.map(([li]) => li)));
  let best = null;
  links.forEach((l, li) => {
    if (onBridge.has(li)) return;
    const pts = [[nodes[l[at.a] * 2], nodes[l[at.a] * 2 + 1]]];
    for (let k = 0; k < l[at.pts].length; k += 2) pts.push([l[at.pts][k], l[at.pts][k + 1]]);
    pts.push([nodes[l[at.b] * 2], nodes[l[at.b] * 2 + 1]]);
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1], len = Math.hypot(bx - ax, bz - az);
      for (let i = 0; i <= len; i++) {
        const x = ax + (bx - ax) * i / len, z = az + (bz - az) * i / len;
        const d = S.deckAt(x, z);
        if (!d || d.lateral > 1) continue;
        const clearance = d.y - S.ground(x, z);
        if (!best || clearance > best.clearance) best = { x, z, clearance, road: [(bx - ax) / len, (bz - az) / len], deck: [d.dirX, d.dirZ], deckY: d.y, groundY: S.ground(x, z) };
      }
    }
  });
  return best;
})();

test('a road under a deck: the fixture is a real crossing, decks clear it by metres', () => {
  assert.ok(crossing && crossing.clearance > 4.5, JSON.stringify(crossing));
  // the two headings cross, so the surface puts each vehicle on its own level
  assert.ok(Math.abs(crossing.road[0] * crossing.deck[0] + crossing.road[1] * crossing.deck[1]) < 0.7);
});

test('traffic levels are resolved from the surface before contacts: deck and ground', () => {
  const { x, z, road, deck, deckY, groundY } = crossing;
  const onDeck = car(x, z, ...deck), below = car(x, z, ...road);
  const h = harness([onDeck, below]);
  h.poseOnSurface(onDeck);
  h.poseOnSurface(below);
  assert.ok(Math.abs(onDeck.levelY - (deckY + ROAD_LIFT)) < 1e-9, `${onDeck.levelY} on the deck ${deckY}`);
  assert.ok(Math.abs(below.levelY - (groundY + ROAD_LIFT)) < 0.05, `${below.levelY} on the ground ${groundY}`);
  assert.ok(onDeck.levelY >= below.levelTop, 'the deck is above the top of the car beneath');
});

test('traffic on different levels never collides; on the same level it does', () => {
  const { x, z, road, deck } = crossing;
  // a knocked car on the deck right over one on the road beneath (the same x, z: they would overlap in plan)
  const onDeck = car(x, z, ...deck, 8, 0.8), below = car(x + 0.3, z + 0.3, ...road, 8);
  const h = harness([onDeck, below]);
  h.poseOnSurface(onDeck); h.poseOnSurface(below);
  const before = [onDeck.x, onDeck.z, onDeck.speed, below.x, below.z, below.speed];
  h.collideTraffic();
  assert.equal(h.contacts, 0);
  assert.deepEqual([onDeck.x, onDeck.z, onDeck.speed, below.x, below.z, below.speed], before);

  // the same two cars both on the deck (nose to tail along it): a contact, momentum shared
  const [dx, dz] = deck;
  const a = car(x, z, dx, dz, 12, 0.8), b = car(x + dx * 3.5, z + dz * 3.5, dx, dz, 2);
  const h2 = harness([a, b]);
  h2.poseOnSurface(a); h2.poseOnSurface(b);
  assert.ok(Math.abs(a.levelY - b.levelY) < 0.5);
  h2.collideTraffic();
  assert.equal(h2.contacts, 1);
  assert.ok(b.speed > 2 && a.speed < 12);

  // and both on the road beneath
  const [rx, rz] = road;
  const c = car(x, z, rx, rz, 12, 0.8), d = car(x + rx * 3.5, z + rz * 3.5, rx, rz, 2);
  const h3 = harness([c, d]);
  h3.poseOnSurface(c); h3.poseOnSurface(d);
  h3.collideTraffic();
  assert.equal(h3.contacts, 1);
});

test('the player and traffic on different levels never collide; on the same level they do', () => {
  const { x, z, road, deck, deckY, groundY } = crossing;
  const player = (y, [dx, dz]) => ({
    entity: { type: 'car', position: { x, z, y }, heading: Math.atan2(dx, dz), speed: 10, prevX: x, prevZ: z,
      vx: 0, vz: 0, angularVel: 0, pitchVel: 0, rollVel: 0, heaveVel: 0 },
    halfW: 0.86, halfL: 2.18, levelY: y, levelTop: y + 2.2
  });
  for (const [who, playerY, playerDir, trafficDir] of [
    ['player beneath, traffic on the deck', groundY + ROAD_LIFT, road, deck],
    ['player on the deck, traffic beneath', deckY + ROAD_LIFT, deck, road]
  ]) {
    const traffic = car(x + 0.5, z + 0.5, ...trafficDir, 6);
    const h = harness([traffic]);
    h.poseOnSurface(traffic);
    h.player = player(playerY, playerDir);
    const before = [h.player.entity.position.x, h.player.entity.position.z, h.player.entity.speed, traffic.x, traffic.z, traffic.speed];
    h.collideWithPlayer(traffic);
    const pe = h.player.entity;
    assert.deepEqual([pe.position.x, pe.position.z, pe.speed, traffic.x, traffic.z, traffic.speed], before, who);
  }
  // the player on the deck, traffic on the deck too: they collide
  const traffic = car(x + deck[0] * 3, z + deck[1] * 3, ...deck, 0);
  const h = harness([traffic]);
  h.poseOnSurface(traffic);
  h.player = player(deckY + ROAD_LIFT, deck);
  const tz = traffic.z, tx = traffic.x;
  h.collideWithPlayer(traffic);
  assert.ok(h.player.entity.speed < 10 && traffic.speed > 0, 'momentum passed on');
  assert.ok(Math.hypot(traffic.x - tx, traffic.z - tz) > 0 || h.player.entity.position.x !== x, 'separated');
});

test('without a surface (New York) no level is set and contacts are tested as before', () => {
  // no poseOnSurface: levelY stays undefined; the player's height does not matter
  const traffic = car(0, 4.2, 0, 1, 0);
  const h = harness([traffic], { surface: null });
  h.player = { entity: { type: 'car', position: { x: 0, z: 0, y: 30 }, heading: 0, speed: 10, prevX: 0, prevZ: 0,
    vx: 0, vz: 0, angularVel: 0, pitchVel: 0, rollVel: 0, heaveVel: 0 }, halfW: 0.86, halfL: 2.18 };
  h.collideWithPlayer(traffic);
  assert.ok(h.player.entity.speed > 4 && h.player.entity.speed < 5, 'the same impulse as tests/vehicle-physics.test.cjs');
  assert.equal(traffic.levelY, undefined);
  const cars = [car(0, 0, 0, 1, 12, 0.8), car(0, 4.2, 0, 1, 0)];
  const h2 = harness(cars, { surface: null });
  h2.collideTraffic();
  assert.equal(h2.contacts, 1);
});
