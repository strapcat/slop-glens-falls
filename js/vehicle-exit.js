// CC-005d: get out of the taxi (or a landed helicopter), walk, and get back in. No three.js and no city names: the
// city hands in a probe of its own world (ground, water, roadway, what is solid), so the Node tests drive exactly what
// the game runs. Glens Falls opts in (gf-main.js); New York never loads this module and keeps its mode buttons as they
// were.
//
// One key, EXIT_KEY (F): in the taxi, get out beside it (slow enough, and only onto a safe spot); in the helicopter,
// set it down and get out (only when it is slow, low and over dry, gentle ground); on foot, get into the taxi or the
// landed helicopter within reach. The vehicle stays where it was left; the walker is the game's own person
// (controllers.js updatePerson: the terrain, its colliders, the trails). The mode buttons 1-4 keep their old meaning
// (switch to that entity wherever it is); this key owns walking to and from a parked vehicle.

const EXIT_KEY = 'KeyF';
const PERSON_RADIUS = 0.48; // m: the walker's body (controllers.js)
// The vehicles' footprints (m): the taxi as traffic.js and controllers.js take it; the helicopter from its skids
// (x +-1.12, z -1.75..2.15, helicopter.js) back to its tail (z -6.1), with the skid tubes' undersides 0.022 m above its
// origin
const BODIES = {
  car: { halfW: 0.86, front: 2.18, back: 2.18, top: 1.6 },
  helicopter: { halfW: 1.25, front: 2.2, back: 6.1, top: 3.0 }
};
// The exit search, in this order: the driver's (left) side, then the right, at each distance out from the side in
// turn and at each spot along it; then behind and in front. The first spot that passes every check, preferring one off
// the carriageway (a kerb island, a park, a trail) and taking the roadway shoulder only if none is.
const SEARCH = {
  car: { sides: [1.65, 2.4, 3.2], along: [0.6, -0.6, 1.6, -1.6], ends: [1.2, 2.2] },
  helicopter: { sides: [2.2, 3.0, 4.0], along: [0.8, -0.4, 1.8], ends: [1.6, 2.6] }
};
// A spot to stand on: no step of more than STAND.step from the vehicle's own ground (no stepping off a bridge deck or
// a retaining wall), and the ground within STAND.ring of it rising or falling no more than STAND.relief (the wheels'
// climb step, controllers.js CLIMB_STEP)
const STAND = { step: 1.0, ring: 0.6, relief: 0.35 };
const EXIT_SPEED = 1.0; // m/s: the taxi must be (almost) stopped to get out
// The helicopter sets down only when (all of): horizontal speed under maxSpeed, vertical under maxVertical, its origin
// within maxHeight of the support under it (its hover floor is 0.25 m), the support under every skid end dry and
// valid, and those skid ends within maxRelief of each other (a gentle slope)
const LAND = { maxSpeed: 2.0, maxVertical: 1.5, maxHeight: 1.2, maxRelief: 0.5, skidY: 0.022 };
// Getting in: within this far of the vehicle's footprint (and the helicopter only when landed). It reaches every
// exit spot the search can choose (the farthest: the taxi's 3.2 m side, 2.34 m from its body; the helicopter's 4.0 m
// side, 2.75 m), so where you got out you can always get back in
const ENTER_REACH = { car: 2.5, helicopter: 3.0 };

// The vehicle's footprint as a collider (controllers.js buildingContact: an oriented box), owned by its entity
function vehicleBody(entity, type) {
  const b = BODIES[type];
  const h = entity.heading || 0, sin = Math.sin(h), cos = Math.cos(h);
  const mid = (b.front - b.back) / 2, hz = (b.front + b.back) / 2;
  const cx = entity.position.x + sin * mid, cz = entity.position.z + cos * mid;
  const ex = Math.abs(cos) * b.halfW + Math.abs(sin) * hz, ez = Math.abs(sin) * b.halfW + Math.abs(cos) * hz;
  return {
    minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez,
    minY: entity.position.y - 0.1, maxY: entity.position.y + b.top,
    obb: { cx, cz, cs: cos, sn: sin, hx: b.halfW, hz },
    owner: entity, type
  };
}
// The distance from (x, z) to that footprint (0 inside)
function bodyDistance(entity, type, x, z) {
  const b = BODIES[type];
  const h = entity.heading || 0, sin = Math.sin(h), cos = Math.cos(h);
  const dx = x - entity.position.x, dz = z - entity.position.z;
  const along = dx * sin + dz * cos, side = dx * cos - dz * sin;
  const qa = along > b.front ? along - b.front : along < -b.back ? -b.back - along : 0;
  const qs = Math.max(0, Math.abs(side) - b.halfW);
  return Math.hypot(qa, qs);
}

// The candidate spots round a vehicle, in search order: { x, z, heading (away from the vehicle), where }
function exitCandidates(entity, type) {
  const b = BODIES[type], q = SEARCH[type];
  const h = entity.heading || 0, fx = Math.sin(h), fz = Math.cos(h);
  // left of the heading (the driver's side): (fz, -fx); right: (-fz, fx) (controllers.js placeAtSpawn)
  const out = [];
  for (const d of q.sides) {
    for (const [sx, sz, where] of [[fz, -fx, 'left'], [-fz, fx, 'right']]) {
      for (const a of q.along) {
        out.push({ x: entity.position.x + sx * d + fx * a, z: entity.position.z + sz * d + fz * a, heading: Math.atan2(sx, sz), where: `${where} ${d} m` });
      }
    }
  }
  for (const d of q.ends) {
    out.push({ x: entity.position.x - fx * (b.back + d), z: entity.position.z - fz * (b.back + d), heading: Math.atan2(-fx, -fz), where: `behind ${d} m` });
    out.push({ x: entity.position.x + fx * (b.front + d), z: entity.position.z + fz * (b.front + d), heading: h, where: `in front ${d} m` });
  }
  return out;
}

// The first safe spot beside the vehicle, or { reason }. probe: { ground(x, z, nearY) -> the walker's standing height
// there (NaN off the map), water(x, z, y) -> true over water at that height, blocked(x, z, y, radius) -> true inside
// a building, trunk, rail or prop collider (or another vehicle), roadway(x, z) -> true on the carriageway }.
// vehicleY: the height the walker would stand at beside the vehicle (its own ground).
function findExitSpot(entity, type, probe, vehicleY) {
  const tally = { map: 0, water: 0, step: 0, steep: 0, blocked: 0, vehicle: 0 };
  let shoulder = null;
  for (const c of exitCandidates(entity, type)) {
    const y = probe.ground(c.x, c.z, vehicleY);
    if (!Number.isFinite(y)) { tally.map++; continue; }
    if (probe.water(c.x, c.z, y)) { tally.water++; continue; }
    if (Math.abs(y - vehicleY) > STAND.step) { tally.step++; continue; }
    let steep = false;
    for (let k = 0; k < 8 && !steep; k++) {
      const a = (k / 8) * Math.PI * 2, gy = probe.ground(c.x + Math.cos(a) * STAND.ring, c.z + Math.sin(a) * STAND.ring, y);
      if (!Number.isFinite(gy) || Math.abs(gy - y) > STAND.relief) steep = true;
    }
    if (steep) { tally.steep++; continue; }
    if (bodyDistance(entity, type, c.x, c.z) < PERSON_RADIUS + 0.05) { tally.vehicle++; continue; }
    if (probe.blocked(c.x, c.z, y, PERSON_RADIUS)) { tally.blocked++; continue; }
    const spot = { ...c, y, roadway: !!probe.roadway(c.x, c.z) };
    if (!spot.roadway) return spot;
    shoulder = shoulder || spot;
  }
  if (shoulder) return shoulder;
  const worst = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  const words = { map: 'no ground there', water: 'water alongside', step: 'a drop alongside', steep: 'too steep alongside', blocked: 'no room alongside', vehicle: 'no room alongside' };
  return { reason: worst[1] ? words[worst[0]] : 'no room alongside', tally };
}

// May the helicopter set down here and now? probe: { support(x, z) -> the bare support under it (NaN off the map),
// water(x, z, y) }. Returns { ok, reason, y (where it sets down) }
function landingGate(h, probe) {
  // where first (no ground, water, too high: the reasons a pilot must move for), then how (speeds), then the slope
  const sin = Math.sin(h.heading || 0), cos = Math.cos(h.heading || 0), x = h.position.x, z = h.position.z;
  const centre = probe.support(x, z);
  if (!Number.isFinite(centre)) return { ok: false, reason: 'no ground below' };
  // the four skid ends (x +-1.12, z -1.75 and +2.15) and the centre
  const under = [];
  for (const [s, a] of [[-1.12, 2.15], [1.12, 2.15], [-1.12, -1.75], [1.12, -1.75], [0, 0]]) {
    const px = x + cos * s + sin * a, pz = z - sin * s + cos * a, y = probe.support(px, pz);
    if (!Number.isFinite(y)) return { ok: false, reason: 'no ground below' };
    if (probe.water(px, pz, y)) return { ok: false, reason: 'over water' };
    under.push(y);
  }
  if (h.position.y - centre > LAND.maxHeight) return { ok: false, reason: 'too high to land' };
  if (Math.abs(h.speed || 0) > LAND.maxSpeed) return { ok: false, reason: 'too fast to land' };
  if (Math.abs(h.verticalSpeed || 0) > LAND.maxVertical) return { ok: false, reason: 'descending too fast' };
  const lo = Math.min(...under), hi = Math.max(...under);
  if (hi - lo > LAND.maxRelief) return { ok: false, reason: 'ground too steep' };
  // set down with its origin on the highest support under the skids (the tubes 0.022 m above it), never into the ground
  return { ok: true, y: hi };
}

// The state machine. manager: controllers.js ThirdPersonControllerManager (activeMode, entities, parkVehicle,
// landHelicopter, placePerson, boardPerson, setParkedColliders); probe as above, with walkerGround(x, z, nearY) for the
// walker and support(x, z) for the helicopter. press() returns { ok, action, reason, mode } (mode: the mode to switch
// to, which the caller selects with its own HUD); status() says what press() would do, without doing it.
function createVehicleExit(manager, probe) {
  const walkerProbe = { ground: probe.walkerGround, water: probe.water, blocked: probe.blocked, roadway: probe.roadway };
  let last = null;
  const near = () => {
    const p = manager.entities.person;
    let best = null;
    for (const type of ['car', 'helicopter']) {
      const e = manager.entities[type];
      if (!e) continue;
      if (type === 'helicopter' && !e.landed) continue;
      const d = bodyDistance(e, type, p.position.x, p.position.z);
      if (d <= ENTER_REACH[type] && (!best || d < best.d)) best = { type, d };
    }
    return best;
  };
  // the parked bodies the walker (and the other vehicles) bump into: every vehicle not driven now
  function parkedColliders() {
    const out = [];
    if (manager.activeMode !== 'car') out.push(vehicleBody(manager.entities.car, 'car'));
    const h = manager.entities.helicopter;
    if (manager.activeMode !== 'helicopter' && h.landed) out.push(vehicleBody(h, 'helicopter'));
    return out;
  }
  function refresh() {
    manager.setParkedColliders(parkedColliders());
  }
  function status() {
    const mode = manager.activeMode;
    if (mode === 'car') {
      const c = manager.entities.car;
      if (Math.abs(c.speed || 0) > EXIT_SPEED) return { mode, action: 'Exit taxi', ok: false, reason: 'stop to get out' };
      const spot = findExitSpot(c, 'car', walkerProbe, probe.walkerGround(c.position.x, c.position.z, c.position.y));
      return spot.reason ? { mode, action: 'Exit taxi', ok: false, reason: spot.reason } : { mode, action: 'Exit taxi', ok: true, spot };
    }
    if (mode === 'helicopter') {
      const h = manager.entities.helicopter;
      const gate = h.landed ? { ok: true, y: h.position.y } : landingGate(h, probe);
      if (!gate.ok) return { mode, action: 'Land & exit', ok: false, reason: gate.reason };
      const standY = probe.walkerGround(h.position.x, h.position.z, gate.y);
      const spot = findExitSpot({ ...h, position: { x: h.position.x, y: gate.y, z: h.position.z } }, 'helicopter', walkerProbe, standY);
      const action = h.landed ? 'Exit helicopter' : 'Land & exit';
      return spot.reason ? { mode, action, ok: false, reason: spot.reason, landY: gate.y } : { mode, action, ok: true, spot, landY: gate.y };
    }
    if (mode === 'person') {
      const n = near();
      if (!n) return { mode, action: 'Enter vehicle', ok: false, reason: 'no taxi or landed helicopter within reach' };
      return { mode, action: n.type === 'car' ? 'Enter taxi' : 'Enter helicopter', ok: true, target: n.type };
    }
    return { mode, action: 'Exit', ok: false, reason: 'not from the bicycle' };
  }
  function press() {
    const s = status();
    if (!s.ok) return (last = { ok: false, action: s.action, reason: s.reason, mode: s.mode });
    if (s.mode === 'car' || s.mode === 'helicopter') {
      if (s.mode === 'helicopter' && !manager.entities.helicopter.landed) manager.landHelicopter(s.landY);
      manager.parkVehicle(s.mode);
      manager.placePerson(s.spot.x, s.spot.y, s.spot.z, s.spot.heading);
      last = { ok: true, action: s.action, mode: 'person', spot: { x: s.spot.x, z: s.spot.z, y: s.spot.y, where: s.spot.where, roadway: s.spot.roadway } };
    } else {
      manager.boardPerson();
      last = { ok: true, action: s.action, mode: s.target };
    }
    return last;
  }
  return { status, press, refresh, parkedColliders, get last() { return last; } };
}

// The parked vehicles as traffic.js setParked bodies ({ x, z, halfW, halfL, levelY }): the taxi whenever nobody drives
// it, the helicopter when it stands landed with nobody aboard
function trafficBodies(manager) {
  const out = [];
  const add = (e, type) => {
    const o = vehicleBody(e, type).obb;
    out.push({ x: o.cx, z: o.cz, halfW: o.hx, halfL: o.hz, levelY: e.position.y, type });
  };
  if (manager.activeMode !== 'car') add(manager.entities.car, 'car');
  if (manager.activeMode !== 'helicopter' && manager.entities.helicopter.landed) add(manager.entities.helicopter, 'helicopter');
  return out;
}

export { createVehicleExit, trafficBodies, findExitSpot, landingGate, exitCandidates, vehicleBody, bodyDistance, EXIT_KEY, PERSON_RADIUS, BODIES, SEARCH, STAND, LAND, EXIT_SPEED, ENTER_REACH };
