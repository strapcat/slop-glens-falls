// CC-BUCKLEY (Glens Falls only): the player's vehicles take damage, and Buckley Tire on Warren St fixes them (the first
// mission loop). No three.js and no DOM, so Node tests use it as the game does; gf-damage-view.js draws it.
//
// Every number here is an ASSUMPTION for Dave to tune (collected in DAMAGE). With these, a hard crash at 20 m/s (45 mph)
// does 34, so three hard crashes wreck a car; a parking-speed bump (under 4.5 m/s, 10 mph) does nothing.

const DAMAGE = {
  modes: ['car', 'cyclist'], // the player's vehicles that take damage (the taxi and the bike; not the helicopter)
  threshold: 4.5, // m/s of impact speed below which a bump does no damage
  perMps: 2.2, // damage per m/s of impact speed above the threshold
  maxHit: 45, // the most one impact can do
  cooldown: 0.35, // s: one crash reports over a few frames; only the hardest within this window counts
  smokeLight: 50, // above: light smoke from the hood
  smokeHeavy: 80, // above: heavier smoke and the top speed capped at capHeavy
  capHeavy: 0.5, // of the vehicle's top speed, above smokeHeavy
  capWrecked: 0.25, // of the top speed at 100 (it still limps; no explosions)
  topSpeed: { car: 36, cyclist: 19 }, // m/s: controllers.js's top speeds (the HUD's 81 and 43 mph)
  hintAt: 30 // damage at which the "get it to Buckley Tire" hint shows (once per crash-and-repair cycle)
};

// The damage one impact at `speed` m/s does
function damageFromImpact(speed, D = DAMAGE) {
  if (!(speed > D.threshold)) return 0;
  return Math.min(D.maxHit, (speed - D.threshold) * D.perMps);
}
// The share of its top speed a vehicle with `damage` keeps
function speedFactor(damage, D = DAMAGE) {
  if (damage >= 100) return D.capWrecked;
  if (damage > D.smokeHeavy) return D.capHeavy;
  return 1;
}
// 'none' | 'light' | 'heavy'
function smokeLevel(damage, D = DAMAGE) {
  if (damage > D.smokeHeavy) return 'heavy';
  if (damage > D.smokeLight) return 'light';
  return 'none';
}

// entities: { mode: entity } (controllers.js controllerManager.entities). Damage is kept per vehicle (per mode), so a
// parked, smoking taxi stays smoking.
function createVehicleDamage({ entities, D = DAMAGE } = {}) {
  const state = new Map(D.modes.map((m) => [m, { damage: 0, lastHit: -Infinity, lastSpeed: 0 }]));
  const modeOf = (entity) => {
    if (!entity) return null;
    for (const m of D.modes) if (entities && entities[m] === entity) return m;
    return null;
  };
  const api = {
    D,
    // An impact (the collision events of controllers.js and traffic.js): `entity` hit something at `speed` m/s at time
    // `now` (s). Returns the damage done.
    hit(entity, speed, now) {
      const mode = modeOf(entity);
      if (!mode) return 0;
      const s = state.get(mode);
      let add = damageFromImpact(speed, D);
      if (!add) return 0;
      if (now - s.lastHit < D.cooldown) {
        // the same crash still reporting: only what this harder report adds over the last one
        add = Math.max(0, add - damageFromImpact(s.lastSpeed, D));
        if (speed > s.lastSpeed) s.lastSpeed = speed;
        if (!add) return 0;
      } else {
        s.lastHit = now;
        s.lastSpeed = speed;
      }
      const before = s.damage;
      s.damage = Math.min(100, s.damage + add);
      return s.damage - before;
    },
    damage: (mode) => (state.has(mode) ? state.get(mode).damage : 0),
    set(mode, value) { if (state.has(mode) && Number.isFinite(value)) state.get(mode).damage = Math.max(0, Math.min(100, value)); },
    repair(mode) { if (state.has(mode)) state.get(mode).damage = 0; },
    // Cap each damaged vehicle's speed (after the controllers move it): forward and reverse
    update() {
      for (const [mode, s] of state) {
        const e = entities && entities[mode];
        if (!e || !Number.isFinite(e.speed)) continue;
        const f = speedFactor(s.damage, D);
        if (f >= 1) continue;
        const cap = (D.topSpeed[mode] || 20) * f;
        if (e.speed > cap) e.speed = cap;
        else if (e.speed < -cap) e.speed = -cap;
      }
    },
    smoke: (mode) => smokeLevel(api.damage(mode), D),
    speedFactor: (mode) => speedFactor(api.damage(mode), D),
    // for the player's save (gf-main.js): { car, cyclist }
    save: () => Object.fromEntries([...state].map(([m, s]) => [m, Math.round(s.damage * 10) / 10])),
    load(saved) { if (saved && typeof saved === 'object') for (const m of D.modes) api.set(m, Number(saved[m])); }
  };
  return api;
}

// ---- the repair loop: Buckley Tire ----

// The first mission's timings (assumptions)
const REPAIR = {
  settle: 2, // s stopped in the repair spot before the work starts
  work: 3, // s of "Fixing..."
  stopped: 0.5, // m/s: under this the vehicle counts as stopped
  hintSeconds: 6, // the hint fades after this
  doneSeconds: 3.5, // "All set." shows this long
  cost: 0 // no money yet: the hook for a price later (repairCost below)
};

// The text the mission shows (data/gf/mission-text.json overrides it; Dave writes the real lines)
const MISSION_TEXT = {
  hint: "Your car's banged up. Get it to Buckley Tire on Warren St.",
  settle: 'Pull in and stop at the Buckley Tire bays.',
  fixing: 'Fixing…',
  done: 'All set. Drive safe.',
  marker: 'Buckley Tire'
};

// damage: createVehicleDamage(); zone: { x, z, r } (gf-buckley-plan.js); text: MISSION_TEXT-like; repairCost(mode,
// damage) and pay(cost): the hooks for money later (free now). Returns { update(dt, mode, entity) -> view, ... }
function createRepairMission({ damage, zone, text = MISSION_TEXT, R = REPAIR, repairCost = () => R.cost, pay = () => true } = {}) {
  let hinted = false; // the hint shown in this crash-and-repair cycle
  let hintUntil = 0, doneUntil = 0, clock = 0;
  let phase = 'idle', timer = 0, fixingMode = null; // idle | settling | fixing
  let firstRepairDone = false;
  let repairs = 0;
  const inZone = (x, z) => !!zone && (x - zone.x) ** 2 + (z - zone.z) ** 2 <= zone.r * zone.r;
  const worst = () => Math.max(...damage.D.modes.map((m) => damage.damage(m)));
  const api = {
    get phase() { return phase; },
    get firstRepairDone() { return firstRepairDone; },
    get repairs() { return repairs; },
    inZone,
    // view: { hint (text or null), marker (show Buckley on the radar), progress (0..1 while fixing, or null), message
    // (text or null), phase }
    update(dt, mode, entity) {
      clock += dt;
      const d = damage.damage(mode);
      if (!hinted && worst() >= damage.D.hintAt) { hinted = true; hintUntil = clock + R.hintSeconds; }
      const vehicle = damage.D.modes.includes(mode) && entity && entity.position;
      const here = vehicle && d > 0 && inZone(entity.position.x, entity.position.z);
      const still = vehicle && Math.abs(entity.speed || 0) < R.stopped;
      if (!here || !still || (fixingMode && fixingMode !== mode)) {
        phase = 'idle';
        timer = 0;
        fixingMode = null;
      } else if (phase === 'idle') {
        phase = 'settling';
        timer = 0;
        fixingMode = mode;
      } else {
        timer += dt;
        if (phase === 'settling' && timer >= R.settle) { phase = 'fixing'; timer = 0; }
        else if (phase === 'fixing' && timer >= R.work) {
          const cost = repairCost(mode, d);
          if (pay(cost)) {
            damage.repair(mode);
            repairs++;
            firstRepairDone = true;
            doneUntil = clock + R.doneSeconds;
            hinted = worst() >= damage.D.hintAt; // a new crash-and-repair cycle (another vehicle may still be banged up)
            hintUntil = 0;
          }
          phase = 'idle';
          timer = 0;
          fixingMode = null;
        }
      }
      const message = clock < doneUntil ? text.done : phase === 'settling' ? text.settle : null;
      return {
        phase,
        hint: clock < hintUntil && phase === 'idle' && clock >= doneUntil ? text.hint : null,
        marker: worst() >= damage.D.hintAt || phase !== 'idle',
        progress: phase === 'fixing' ? Math.min(1, timer / R.work) : null,
        fixingText: phase === 'fixing' ? text.fixing : null,
        message
      };
    },
    // the text, once data/gf/mission-text.json has loaded (parseMissionText)
    setText(next) { if (next && typeof next === 'object') text = next; },
    get text() { return text; },
    save: () => ({ firstRepairDone, repairs }),
    load(saved) {
      if (!saved || typeof saved !== 'object') return;
      firstRepairDone = !!saved.firstRepairDone;
      repairs = Number.isFinite(saved.repairs) ? saved.repairs : 0;
    }
  };
  return api;
}

// mission-text.json -> the text, any missing or empty key falling back to MISSION_TEXT
function parseMissionText(json) {
  const out = { ...MISSION_TEXT };
  const src = json && typeof json === 'object' ? (json.buckley || json) : {};
  for (const k of Object.keys(MISSION_TEXT)) if (typeof src[k] === 'string' && src[k].trim()) out[k] = src[k];
  return out;
}

export {
  DAMAGE, REPAIR, MISSION_TEXT, damageFromImpact, speedFactor, smokeLevel, createVehicleDamage, createRepairMission,
  parseMissionText
};
