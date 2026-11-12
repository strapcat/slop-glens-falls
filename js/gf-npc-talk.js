// CC-NPC1: talk to the people of Glens Falls on foot. Who can be talked to (the nearest person within reach, roughly in
// front of the player), what happens when they are (they stop, turn to face the player and say a line from Dave's file,
// gf-npc-lines.js, for TALK.seconds or until the player walks off), and two light reactions: a pedestrian steps aside
// when the walking player bumps into them, and flinches back from a player's car or bicycle passing very close.
// No DOM and no three.js (the speech bubble and the key are gf-npc-talk-ui.js), so the Node tests drive exactly what the
// game runs. Glens Falls opts in (gf-main.js); New York never loads it.
//
// Performance: no per-frame pass over the crowd. The people are binned in a coarse grid (GRID.cell metres), rebuilt
// every GRID.every seconds and only while it is needed (on foot, or driving or riding fast enough to make someone
// flinch); each frame looks only at the grid cells round the player.
//
// The city's pedestrians (pedestrian-system.js) are driven through state that system already has: a talk is one of its
// conversations (the pedestrian stands still and faces its partner, here a stand-in at the player's position), and a
// step aside is one of its dodges (dodgeTarget, avoidUntil). The Thrill Hill party's people (gf-thrill-hill.js) stand
// at the fire; a talk turns them with `talkFacing`.

const TALK_KEY = 'KeyT';
const TALK = {
  range: 3, // m: the farthest someone can be talked to
  cone: Math.cos((70 * Math.PI) / 180), // "roughly in front": within 70 degrees of the player's heading
  stickyCone: Math.cos((110 * Math.PI) / 180), // the person already talking stays the target while still near
  keep: 6, // m: walk farther than this and the talk ends
  seconds: 4 // s: each line shows this long
};
const GRID = { cell: 8, every: 0.5, margin: 2.5 }; // m, s, m: how far a person may have walked since the last rebuild
const STEP = { reach: 0.85, offset: 0.75, hold: 1.2, every: 0.1, minSpeed: 0.3 }; // stepping aside from the walker
// Flinching from the player's car or bicycle: within `clear` m of its footprint at `minSpeed` m/s or more
const FLINCH = { clear: 1.2, minSpeed: 4, offset: 0.45, hold: 0.8, cooldown: 3 };
const BODIES = { car: { halfW: 0.86, halfL: 2.18 }, cyclist: { halfW: 0.35, halfL: 0.85 } }; // traffic.js's player footprints
const HEAD = 1.72; // m above the ground: the top of a head, where the bubble hangs when the body's own height is unknown

// The person to talk to: the nearest of `candidates` ({ x, z }) within opts.range of the player ({ x, z, heading }) and
// within the cone in front of them (cos of the half-angle); `current`, someone already talking, is kept with the wider
// stickyCone. Ties go to whoever is more squarely in front. Pure: the tests call it with plain objects.
function pickTalkTarget(player, candidates, { range = TALK.range, cone = TALK.cone, current = null, stickyCone = TALK.stickyCone } = {}) {
  const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
  let best = null, bestScore = Infinity;
  for (const c of candidates) {
    const dx = c.x - player.x, dz = c.z - player.z;
    const d = Math.hypot(dx, dz);
    if (!(d <= range)) continue;
    const facing = d < 1e-6 ? 1 : (dx * fx + dz * fz) / d;
    if (facing < (c === current ? stickyCone : cone)) continue;
    // nearest first; a person off to the side counts as up to twice as far
    const score = (c === current ? 0.5 : 1) * d * (2 - Math.max(0, facing));
    if (score < bestScore) { best = c; bestScore = score; }
  }
  return best;
}

// The distance from (x, z) to a player's vehicle footprint (an oriented box round its position; 0 inside)
function footprintDistance(x, z, entity, { halfW, halfL }) {
  const h = entity.heading || 0, s = Math.sin(h), c = Math.cos(h);
  const dx = x - entity.position.x, dz = z - entity.position.z;
  const along = dx * s + dz * c, side = dx * c - dz * s;
  return Math.hypot(Math.max(0, Math.abs(along) - halfL), Math.max(0, Math.abs(side) - halfW));
}

// A coarse grid of entries ({ npc, kind, x, z }), rebuilt from scratch; query() lists the entries in the cells that
// touch a circle (positions as of the rebuild; callers re-check the live position)
function createNpcGrid(cell = GRID.cell) {
  const cells = new Map();
  const used = [];
  const pool = [];
  const key = (ix, iz) => (ix + 32768) * 65536 + (iz + 32768);
  return {
    clear() {
      for (const list of used) { list.length = 0; pool.push(list); }
      used.length = 0;
      cells.clear();
    },
    add(entry) {
      const k = key(Math.floor(entry.x / cell), Math.floor(entry.z / cell));
      let list = cells.get(k);
      if (!list) { list = pool.pop() || []; cells.set(k, list); used.push(list); }
      list.push(entry);
    },
    query(x, z, r, out = []) {
      out.length = 0;
      const x0 = Math.floor((x - r) / cell), x1 = Math.floor((x + r) / cell);
      const z0 = Math.floor((z - r) / cell), z1 = Math.floor((z + r) / cell);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = cells.get(key(ix, iz));
          if (list) for (const e of list) out.push(e);
        }
      }
      return out;
    },
    get size() { let n = 0; for (const list of used) n += list.length; return n; }
  };
}

// The city's pedestrians (pedestrian-system.js peds): talked to through that system's conversations, moved aside
// through its dodges. Only someone on a sidewalk (not out in a crosswalk's roadway), not already dodging, diving or
// running from a car, can be talked to.
// Break off a pedestrian's conversation with another pedestrian (as pedestrian-system.js endConversation)
function breakConversation(p, clock) {
  const c = p.conversation;
  if (!c || c.npcTalk) return;
  c.a.conversation = null; c.b.conversation = null; c.remaining = 0;
  c.a.socialTime = c.b.socialTime = clock + 30;
}
const PED = {
  kind: 'ped',
  eligible: (p, clock) => p.placed && !(p.node && p.t > 2 && p.t < p.len - 2) && !p.dodge && !p.dodgeTarget && !(clock < p.avoidUntil),
  start(p, clock, px, pz) {
    breakConversation(p, clock);
    const stand = { x: px, z: pz, conversation: null, socialTime: 0 }; // the partner it faces: the player
    const conversation = { a: p, b: stand, remaining: Infinity, npcTalk: true };
    p.conversation = conversation;
    p.v = 0;
    return { conversation, stand };
  },
  hold(p, st, px, pz) { st.stand.x = px; st.stand.z = pz; },
  valid: (p, st) => p.placed && p.conversation === st.conversation,
  stop(p, st, clock) {
    if (p.conversation !== st.conversation) return;
    p.conversation = null;
    p.socialTime = Math.max(p.socialTime || 0, clock + 20); // walks on rather than starting a new chat at once
  },
  headY: (p, ground) => (p.rig && p.rig.placed && Number.isFinite(p.rig.pelvisY) ? p.rig.pelvisY + 0.78 * (p.rig.s || 1) : ground(p.x, p.z) + HEAD)
};

// The Thrill Hill party's people (gf-thrill-hill.js schedule.people): only someone standing at the fire. They stay where
// they are and turn to the player (talkFacing, radians; NaN: back to the fire)
const PARTY = {
  kind: 'party',
  eligible: (p) => p.phase === 'at',
  start(p, clock, px, pz) { p.talkFacing = Math.atan2(px - p.x, pz - p.z); return {}; },
  hold(p, st, px, pz) { p.talkFacing = Math.atan2(px - p.x, pz - p.z); },
  valid: (p) => p.phase === 'at',
  stop(p) { p.talkFacing = NaN; },
  headY: (p, ground) => ground(p.x, p.z) + HEAD
};

// sources: () => { peds: [...], party: [...] } (the live lists); speech: createNpcSpeech(); period(): 'day' | 'night';
// canStand(x, z): may a pedestrian step aside onto (x, z) (on a kerb island, clear of buildings); ground(x, z): the
// ground's height (for the bubble's anchor)
function createNpcTalk({ sources, speech, period, canStand = () => true, ground = () => 0 }) {
  const grid = createNpcGrid();
  const entries = []; // reused grid entries
  const near = [];
  const candidates = [];
  let nextGrid = -Infinity, nextStep = 0, clock = 0;
  let target = null; // grid entry
  let talk = null; // { entry, st, until, text, speaker, special, count }
  let player = null;
  const stats = { rebuilds: 0, gridSize: 0, stepAsides: 0, flinches: 0, talks: 0 };

  function rebuild() {
    grid.clear();
    const lists = sources();
    let n = 0;
    const put = (npc, adapter) => {
      const e = entries[n] || (entries[n] = { npc: null, a: null, x: 0, z: 0 });
      e.npc = npc; e.a = adapter; e.x = npc.x; e.z = npc.z;
      n++;
      grid.add(e);
    };
    for (const p of lists.peds || []) if (p.placed) put(p, PED);
    for (const p of lists.party || []) if (p.phase === 'at') put(p, PARTY);
    for (let i = n; i < entries.length; i++) entries[i].npc = null;
    nextGrid = clock + GRID.every;
    stats.rebuilds++;
    stats.gridSize = n;
  }

  function endTalk() {
    if (!talk) return;
    talk.entry.a.stop(talk.entry.npc, talk.st, clock);
    talk = null;
  }

  // the entry for someone being talked to stays valid across rebuilds (entries are reused): keep a copy
  const own = (e) => ({ npc: e.npc, a: e.a, x: e.npc.x, z: e.npc.z });

  function stepAside(p, px, pz) {
    const side = Math.sign((p.x - px) * p.uz - (p.z - pz) * p.ux) || 1;
    for (const off of [side * STEP.offset, -side * STEP.offset]) {
      const x = p.ax + p.ux * p.t + p.uz * off, z = p.az + p.uz * p.t - p.ux * off;
      if (!canStand(x, z)) continue;
      dodge(p, off, STEP.hold);
      stats.stepAsides++;
      return true;
    }
    p.pause = Math.max(p.pause || 0, 1); // no room either side: stop and let the player by
    return false;
  }
  function dodge(p, offset, hold) {
    breakConversation(p, clock);
    p.dodgeTarget = offset;
    p.avoidUntil = clock + hold;
    p.avoidSpeed = 0;
    p.avoidT = p.t;
  }

  function flinch(p, entity, body) {
    if (p.dodge || p.dodgeTarget || clock < p.avoidUntil || clock < (p.npcFlinchUntil || 0)) return false;
    if (footprintDistance(p.x, p.z, entity, body) > FLINCH.clear) return false;
    p.npcFlinchUntil = clock + FLINCH.cooldown;
    const side = Math.sign((p.x - entity.position.x) * p.uz - (p.z - entity.position.z) * p.ux) || 1;
    const off = side * FLINCH.offset;
    if (canStand(p.ax + p.ux * p.t + p.uz * off, p.az + p.uz * p.t - p.ux * off)) dodge(p, off, FLINCH.hold);
    p.pause = Math.max(p.pause || 0, FLINCH.hold);
    stats.flinches++;
    return true;
  }

  // Every frame. mode: the player's mode ('person' on foot); entity: the player's entity ({ position, heading, speed })
  function update(dt, elapsed, mode, entity) {
    clock = elapsed;
    player = entity;
    if (!entity) return;
    const px = entity.position.x, pz = entity.position.z;
    if (mode !== 'person') {
      endTalk();
      target = null;
      const body = BODIES[mode];
      const speed = Math.abs(entity.speed || 0);
      if (!body || speed < FLINCH.minSpeed) return;
      if (clock >= nextGrid) rebuild();
      for (const e of grid.query(px, pz, body.halfL + FLINCH.clear + GRID.margin, near)) {
        if (e.a === PED && e.npc && e.npc.placed) flinch(e.npc, entity, body);
      }
      return;
    }
    if (clock >= nextGrid) rebuild();
    grid.query(px, pz, TALK.range + GRID.margin, near);

    // the talk: ends after its time, when the player walks off, or when the person is gone (respawned far away,
    // ran from a car, the party went home)
    if (talk) {
      const n = talk.entry.npc;
      if (!talk.entry.a.valid(n, talk.st) || clock >= talk.until || Math.hypot(n.x - px, n.z - pz) > TALK.keep) endTalk();
      else talk.entry.a.hold(n, talk.st, px, pz);
    }

    // who can be talked to now
    candidates.length = 0;
    let current = null;
    for (const e of near) {
      if (!e.npc) continue;
      if (talk && e.npc === talk.entry.npc) { current = e; candidates.push(e); continue; }
      if (!e.a.eligible(e.npc, clock)) continue;
      e.x = e.npc.x; e.z = e.npc.z;
      candidates.push(e);
    }
    if (current) { current.x = current.npc.x; current.z = current.npc.z; }
    target = pickTalkTarget({ x: px, z: pz, heading: entity.heading || 0 }, candidates, { current });

    // stepping aside from a walking player who bumps into them
    if (clock >= nextStep && Math.abs(entity.speed || 0) > STEP.minSpeed) {
      nextStep = clock + STEP.every;
      const fx = Math.sin(entity.heading || 0) * Math.sign(entity.speed), fz = Math.cos(entity.heading || 0) * Math.sign(entity.speed);
      for (const e of near) {
        const p = e.npc;
        if (e.a !== PED || !p || !p.placed || (talk && p === talk.entry.npc)) continue;
        const dx = p.x - px, dz = p.z - pz;
        if (dx * dx + dz * dz > STEP.reach * STEP.reach || dx * fx + dz * fz < -0.1) continue;
        if (!PED.eligible(p, clock)) continue;
        stepAside(p, px, pz);
      }
    }
  }

  // The talk key or button: start talking to the target, or the next line from the person already talking
  function press() {
    if (!target || !player) return { ok: false, reason: 'nobody in reach' };
    const px = player.position.x, pz = player.position.z;
    if (!talk || talk.entry.npc !== target.npc) {
      endTalk();
      const entry = own(target);
      talk = { entry, st: entry.a.start(entry.npc, clock, px, pz), until: 0, text: '', speaker: null, special: null, count: 0 };
      stats.talks++;
    }
    const n = talk.entry.npc;
    const line = speech.say(n, n.x, n.z, period());
    Object.assign(talk, line, { until: clock + TALK.seconds, count: talk.count + 1 });
    return { ok: true, kind: talk.entry.a.kind, ...line };
  }

  return {
    update,
    press,
    end: endTalk,
    // the target ({ kind, npc, x, y, z }: y is the head, for the prompt) or null
    target() {
      if (!target || !target.npc) return null;
      const n = target.npc;
      return { kind: target.a.kind, npc: n, x: n.x, y: target.a.headY(n, ground), z: n.z };
    },
    // the talk ({ kind, npc, text, speaker, special, x, y, z, remaining, count }) or null
    talk() {
      if (!talk) return null;
      const n = talk.entry.npc;
      return { kind: talk.entry.a.kind, npc: n, text: talk.text, speaker: talk.speaker, special: talk.special,
        x: n.x, y: talk.entry.a.headY(n, ground), z: n.z, remaining: Math.max(0, talk.until - clock), count: talk.count };
    },
    stats
  };
}

export { createNpcTalk, pickTalkTarget, createNpcGrid, footprintDistance, TALK_KEY, TALK, GRID, STEP, FLINCH, PED, PARTY };
