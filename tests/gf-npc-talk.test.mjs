import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseNpcLines, loadNpcLines, createNpcSpeech, FALLBACK_LINES, FALLBACK_LINE, LINES_URL, PERIODS } from '../js/gf-npc-lines.js';
import { createNpcTalk, pickTalkTarget, createNpcGrid, footprintDistance, TALK_KEY, TALK, STEP, FLINCH } from '../js/gf-npc-talk.js';

// CC-NPC1: talking to people in Glens Falls. The line file (Dave's data/gf/npc-lines.json) and its fallback, the
// choice of line (day / night / any, never twice in a row), the Thrill Hill crowd's special, who can be talked to (range
// and facing), the talk itself and the light reactions on the pedestrians' own state, and New York never loading any of it.

const root = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const read = (f) => fs.readFileSync(root(f), 'utf8');
// a seeded random in [0, 1), so the draws are the same on every run
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const quiet = () => {};

const SAMPLE = {
  randos: { day: ['d1', 'd2'], night: ['n1', 'n2'], any: ['a1'] },
  specials: {
    'thrill-hill-crowd': { name: 'Thrill Hill crowd', where: 'thrill-hill', night: ['tn1', 'tn2', 'tn3'], day: ['td1'] },
    'night-only': { name: 'Night only', night: ['x1'] }
  }
};

// ---------------------------------------------------------------- the line file

test('the line file Dave edits: valid, every list seeded with 2-3 marked placeholders, no real dialogue', () => {
  const text = read('data/gf/npc-lines.json');
  const { lines, warnings, ok } = parseNpcLines(text);
  assert.equal(ok, true);
  assert.deepEqual(warnings, []);
  const lists = [...PERIODS.map((p) => ['randos.' + p, lines.randos[p]])];
  const crowd = lines.specials['thrill-hill-crowd'];
  assert.ok(crowd, 'the thrill-hill-crowd special');
  assert.equal(crowd.name, 'Thrill Hill crowd');
  assert.equal(crowd.where, 'thrill-hill');
  lists.push(['thrill-hill-crowd.night', crowd.night], ['thrill-hill-crowd.day', crowd.day]);
  for (const [name, list] of lists) {
    assert.ok(list.length >= 2 && list.length <= 3, `${name}: 2-3 lines`);
    for (const line of list) assert.match(line, /^PLACEHOLDER — Dave writes this/, `${name}: a marked placeholder`);
  }
  // the guide sits next to it
  assert.match(read('data/gf/NPC-LINES.md'), /npc-lines\.json/);
  // the game reads it from its own folder (relative to js/), nothing else
  assert.equal(new URL(LINES_URL, 'https://example.org/game/js/gf-npc-lines.js').pathname, '/game/data/gf/npc-lines.json');
});

test('bad JSON: a warning and the placeholder set, never a throw', () => {
  for (const bad of ['{ "randos": { "day": ["a",] } }', '', 'not json', '{"randos":']) {
    const r = parseNpcLines(bad);
    assert.equal(r.ok, false);
    assert.equal(r.lines, FALLBACK_LINES);
    assert.match(r.warnings[0], /not valid JSON/);
  }
  for (const wrong of [[], 'null', '42', '"text"', null]) {
    const r = parseNpcLines(wrong);
    assert.equal(r.ok, false);
    assert.equal(r.lines, FALLBACK_LINES);
    assert.equal(r.warnings.length, 1);
  }
  // the placeholder set still gives a line to say
  const speech = createNpcSpeech();
  assert.equal(speech.say({}, 0, 0, 'day').text, FALLBACK_LINE);
});

test('missing or broken lists: a warning each, empty lists, the rest kept', () => {
  const r = parseNpcLines({
    randos: { day: ['ok', 42, '   ', 'x'.repeat(500)], any: 'oops' },
    specials: { a: { name: '', night: ['n'] }, b: 'no', c: { where: 3 }, d: { day: [] } }
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.randos.day.slice(0, 1), ['ok']);
  assert.equal(r.lines.randos.day[1].length, 400, 'cut to 400 characters');
  assert.deepEqual(r.lines.randos.night, []);
  assert.deepEqual(r.lines.randos.any, []);
  assert.equal(r.lines.specials.a.name, 'a', 'no name: its id');
  assert.deepEqual(r.lines.specials.a.night, ['n']);
  assert.ok(!r.lines.specials.b, 'a special that is not an object is skipped');
  assert.equal(r.lines.specials.c.where, null);
  const expect = [/randos\.day\[1\] is not text/, /randos\.day\[2\] is empty/, /randos\.day\[3\] is longer/, /randos\.night is missing/,
    /randos\.any should be a list/, /specials\.b should be/, /specials\.c has no/, /specials\.c\.where/];
  for (const re of expect) assert.ok(r.warnings.some((w) => re.test(w)), `warns ${re}`);
  // no randos at all, specials not an object
  const r2 = parseNpcLines({ specials: [] });
  assert.ok(r2.warnings.some((w) => /randos is missing/.test(w)) && r2.warnings.some((w) => /specials should be/.test(w)));
  assert.deepEqual(r2.lines.randos, { day: [], night: [], any: [] });
  // nothing to say anywhere: the placeholder line
  assert.equal(createNpcSpeech({ lines: r2.lines }).say({}, 0, 0, 'night').text, FALLBACK_LINE);
});

test('loading: a fetch that fails or returns junk logs and falls back; never rejects', async () => {
  const logged = [];
  const log = (m) => logged.push(m);
  let r = await loadNpcLines(() => Promise.reject(new Error('HTTP 404')), LINES_URL, log);
  assert.equal(r.ok, false);
  assert.equal(r.lines, FALLBACK_LINES);
  assert.match(logged[0], /^\[npc-lines\] npc-lines\.json could not be read \(HTTP 404\)/);
  r = await loadNpcLines(() => { throw new Error('offline'); }, LINES_URL, log);
  assert.equal(r.ok, false);
  r = await loadNpcLines(async () => '{ broken', LINES_URL, log);
  assert.equal(r.ok, false);
  assert.ok(logged.some((m) => /not valid JSON/.test(m)));
  r = await loadNpcLines(async (url) => (url === LINES_URL ? read('data/gf/npc-lines.json') : ''), LINES_URL, log);
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- the choice of line

test('day, night and any: day draws from day + any, night from night + any', () => {
  const speech = createNpcSpeech({ lines: parseNpcLines(SAMPLE).lines, random: seeded(7) });
  const seen = { day: new Set(), night: new Set() };
  for (let i = 0; i < 200; i++) {
    seen.day.add(speech.say({}, 0, 0, 'day').text);
    seen.night.add(speech.say({}, 0, 0, 'night').text);
  }
  assert.deepEqual([...seen.day].sort(), ['a1', 'd1', 'd2']);
  assert.deepEqual([...seen.night].sort(), ['a1', 'n1', 'n2']);
  const r = speech.say({}, 0, 0, 'day');
  assert.equal(r.speaker, null);
  assert.equal(r.special, null);
});

test('no line twice in a row from the same person (unless it is the only one)', () => {
  const speech = createNpcSpeech({ lines: parseNpcLines(SAMPLE).lines, random: seeded(3) });
  const a = {}, b = {};
  let lastA = null;
  for (let i = 0; i < 300; i++) {
    const t = speech.say(a, 0, 0, i % 7 < 4 ? 'day' : 'night').text;
    assert.notEqual(t, lastA, `draw ${i}`);
    lastA = t;
    speech.say(b, 0, 0, 'day'); // someone else's lines do not count
  }
  // a random that always returns the same value still alternates
  const stuck = createNpcSpeech({ lines: parseNpcLines(SAMPLE).lines, random: () => 0 });
  const p = {};
  const draws = Array.from({ length: 6 }, () => stuck.say(p, 0, 0, 'day').text);
  for (let i = 1; i < draws.length; i++) assert.notEqual(draws[i], draws[i - 1]);
  // only one line: it repeats
  const one = createNpcSpeech({ lines: parseNpcLines({ randos: { day: ['only'], night: [], any: [] } }).lines });
  assert.equal(one.say(p, 0, 0, 'day').text, 'only');
  assert.equal(one.say(p, 0, 0, 'day').text, 'only');
});

// ---------------------------------------------------------------- the Thrill Hill crowd

test('thrill-hill-crowd: bound people speak its lines at night; its place gives them to anyone there; else the randos', () => {
  const speech = createNpcSpeech({ lines: parseNpcLines(SAMPLE).lines, random: seeded(11) });
  const guest = {}, walker = {};
  speech.bind(guest, 'thrill-hill-crowd');
  assert.equal(speech.boundTo(guest), 'thrill-hill-crowd');
  // bound: its lines, its name, wherever the guest stands
  for (let i = 0; i < 20; i++) {
    const r = speech.say(guest, 999, 999, 'night');
    assert.match(r.text, /^tn\d$/);
    assert.equal(r.speaker, 'Thrill Hill crowd');
    assert.equal(r.special, 'thrill-hill-crowd');
  }
  assert.equal(speech.say(guest, 999, 999, 'day').text, 'td1');
  // the place: anyone within its radius of the fire, nobody outside it
  speech.registerPlace('thrill-hill', { x: 100, z: 50, r: 30 });
  assert.equal(speech.specialFor(walker, 110, 60, 'day').id, 'thrill-hill-crowd');
  assert.equal(speech.specialFor(walker, 100, 81, 'day'), null);
  assert.equal(speech.say(walker, 100, 81, 'day').speaker, null);
  // a special with nothing to say now leaves it to the randos; one tied to nobody speaks for nobody
  const quietCrowd = createNpcSpeech({ lines: parseNpcLines({ randos: SAMPLE.randos, specials: { 'thrill-hill-crowd': { night: ['tn'] } } }).lines });
  quietCrowd.bind(guest, 'thrill-hill-crowd');
  assert.equal(quietCrowd.say(guest, 0, 0, 'day').speaker, null);
  assert.equal(quietCrowd.say(guest, 0, 0, 'night').text, 'tn');
  assert.equal(speech.specialFor(walker, 0, 0, 'night'), null, 'night-only has no binding and no place');
  // a binding to an id the file does not have (deleted later): the randos
  const ghost = {};
  speech.bind(ghost, 'crandall-ghost-carriage');
  assert.equal(speech.say(ghost, 0, 0, 'night').speaker, null);
  // a future special added by data only, bound by the one hook
  speech.setLines(parseNpcLines({ ...SAMPLE, specials: { ...SAMPLE.specials, 'crandall-ghost-carriage': { name: 'Ghost carriage (fiction)', night: ['g1'] } } }).lines);
  assert.deepEqual(speech.say(ghost, 0, 0, 'night'), { text: 'g1', speaker: 'Ghost carriage (fiction)', special: 'crandall-ghost-carriage' });
  speech.unbind(ghost);
  assert.equal(speech.boundTo(ghost), null);
});

test('the game binds the party\'s people to thrill-hill-crowd and its fire to the thrill-hill place', () => {
  const ui = read('js/gf-npc-talk-ui.js');
  assert.match(ui, /THRILL_HILL = \{ special: 'thrill-hill-crowd', place: 'thrill-hill', radius: 30 \}/);
  assert.match(ui, /for \(const p of party\.schedule\.people\) speech\.bind\(p, THRILL_HILL\.special\)/);
  assert.match(ui, /speech\.registerPlace\(THRILL_HILL\.place, \{ x: fire\.x, z: fire\.z, r: THRILL_HILL\.radius \}\)/);
  // and the data's special names the same place
  assert.equal(parseNpcLines(read('data/gf/npc-lines.json')).lines.specials['thrill-hill-crowd'].where, 'thrill-hill');
  // the party turns a guest to the player while talking (talkFacing), and back to the fire after
  assert.match(read('js/gf-thrill-hill.js'), /Number\.isFinite\(p\.talkFacing\) \? p\.talkFacing : p\.heading \+ sway/);
});

// ---------------------------------------------------------------- who can be talked to

test('target selection: within range, roughly in front, nearest first', () => {
  const player = { x: 0, z: 0, heading: 0 }; // facing +z
  const ahead = { x: 0, z: 2 }, near = { x: 0.3, z: 1.2 }, behind = { x: 0, z: -1 }, far = { x: 0, z: 3.2 }, side = { x: 2, z: 0.1 }, angled = { x: 1.2, z: 1.2 };
  assert.equal(pickTalkTarget(player, [ahead, behind, far]), ahead);
  assert.equal(pickTalkTarget(player, [ahead, near]), near, 'the nearer one');
  assert.equal(pickTalkTarget(player, [behind]), null, 'not behind');
  assert.equal(pickTalkTarget(player, [side]), null, 'not beside (87 degrees off)');
  assert.equal(pickTalkTarget(player, [far]), null, `not beyond ${TALK.range} m`);
  assert.equal(pickTalkTarget(player, [angled]), angled, '45 degrees off is in front');
  const edge = { x: 0, z: 3 };
  assert.equal(pickTalkTarget(player, [edge]), edge, 'exactly at range counts');
  assert.equal(pickTalkTarget(player, []), null);
  // heading pi/2 faces +x
  assert.equal(pickTalkTarget({ x: 0, z: 0, heading: Math.PI / 2 }, [ahead, side]), side);
  // someone already talking stays the target a little off to the side
  assert.equal(pickTalkTarget(player, [side], { current: side }), side);
  assert.equal(pickTalkTarget(player, [behind], { current: behind }), null, 'but not behind');
  // squarely in front beats a nearer one far off to the side
  const offAxis = { x: 1.25, z: 0.55 }, straight = { x: 0, z: 1.5 };
  assert.equal(pickTalkTarget(player, [offAxis, straight]), straight);
});

test('grid: only the cells round a point', () => {
  const grid = createNpcGrid(8);
  const pts = [];
  for (let x = -40; x <= 40; x += 2) for (let z = -40; z <= 40; z += 2) pts.push({ x, z });
  for (const p of pts) grid.add(p);
  assert.equal(grid.size, pts.length);
  const got = grid.query(1, 1, 3);
  assert.ok(got.length < pts.length / 10, 'a few cells, not everyone');
  for (const p of pts) if (Math.hypot(p.x - 1, p.z - 1) <= 3) assert.ok(got.includes(p), 'everyone within the radius is listed');
  grid.clear();
  assert.equal(grid.size, 0);
  assert.deepEqual(grid.query(0, 0, 5), []);
});

test('footprint distance: 0 inside, the gap to the nearest side outside', () => {
  const car = { position: { x: 10, z: 0 }, heading: 0 };
  const body = { halfW: 1, halfL: 2 };
  assert.equal(footprintDistance(10, 1, car, body), 0);
  assert.equal(footprintDistance(12.5, 0, car, body), 1.5);
  assert.equal(footprintDistance(10, 3, car, body), 1);
  assert.ok(Math.abs(footprintDistance(10, 2.5, { ...car, heading: Math.PI / 2 }, body) - 1.5) < 1e-9, 'turned 90 degrees');
});

// ---------------------------------------------------------------- the talk on the pedestrians' own state

// A pedestrian as pedestrian-system.js keeps one: on a sidewalk track from (ax, az) along (ux, uz), t metres along
function ped(x, z, extra = {}) {
  return { placed: true, x, z, ax: x, az: z - 5, ux: 0, uz: 1, t: 5, len: 20, dir: 1, node: null, v: 1.3, speed: 1.3, pause: 0,
    conversation: null, socialTime: 0, dodge: 0, dodgeTarget: 0, avoidUntil: 0, avoidSpeed: 0, avoidT: 0, rig: { placed: true, pelvisY: 1, s: 1 }, ...extra };
}
function world({ peds = [], party = [], night = false, canStand = () => true } = {}) {
  const speech = createNpcSpeech({ lines: parseNpcLines(SAMPLE).lines, random: seeded(5) });
  const talk = createNpcTalk({ sources: () => ({ peds, party }), speech, period: () => (night ? 'night' : 'day'), canStand, ground: () => 0 });
  const player = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0 };
  let clock = 0;
  const step = (seconds = 0.1, mode = 'person') => {
    for (let s = 0; s < seconds - 1e-9; s += 0.05) { clock += 0.05; talk.update(0.05, clock, mode, player); }
  };
  return { talk, speech, player, step, get clock() { return clock; } };
}

test('talk: the pedestrian stops, faces the player, says a line; again: the next line; it ends after 4 s and they walk on', () => {
  const p = ped(0, 2);
  const w = world({ peds: [p] });
  assert.deepEqual(w.talk.press(), { ok: false, reason: 'nobody in reach' }, 'before the first update');
  w.step();
  assert.equal(w.talk.target().npc, p);
  assert.equal(w.talk.target().y, 1.9, 'the prompt over the head');
  const first = w.talk.press();
  assert.equal(first.ok, true);
  assert.equal(first.kind, 'ped');
  assert.match(first.text, /^(d1|d2|a1)$/);
  // stopped (a conversation stops a pedestrian, pedestrian-system.js walk) and facing its partner: the player
  assert.ok(p.conversation && p.conversation.a === p && p.conversation.npcTalk);
  assert.equal(p.v, 0);
  w.player.position.x = 0.5;
  w.step();
  assert.equal(p.conversation.b.x, 0.5, 'the partner it faces follows the player');
  assert.equal(p.conversation.remaining, Infinity, 'the crowd does not end it; the talk does');
  // T again: the next line from the same person, and the timer starts over
  w.step(3);
  const second = w.talk.press();
  assert.notEqual(second.text, first.text);
  assert.equal(w.talk.talk().count, 2);
  assert.ok(w.talk.talk().remaining > 3.9);
  w.step(3.5);
  assert.ok(w.talk.talk(), 'still talking 3.5 s after the second line');
  w.step(1);
  assert.equal(w.talk.talk(), null, 'over after 4 s');
  assert.equal(p.conversation, null, 'walks on');
  assert.ok(p.socialTime > w.clock, 'and does not start another chat at once');
  assert.equal(w.talk.stats.talks, 1);
});

test('talk: ends when the player walks beyond 6 m, leaves foot, or the pedestrian is gone', () => {
  const p = ped(0, 2);
  const w = world({ peds: [p] });
  w.step();
  w.talk.press();
  w.player.position.z = -3.9; // 5.9 m
  w.step();
  assert.ok(w.talk.talk());
  w.player.position.z = -4.2; // 6.2 m
  w.step();
  assert.equal(w.talk.talk(), null);
  assert.equal(p.conversation, null);
  // getting into the taxi ends it
  w.player.position.z = 0;
  w.step();
  w.talk.press();
  w.step(0.1, 'car');
  assert.equal(w.talk.talk(), null);
  assert.equal(w.talk.target(), null);
  // respawned far off by the crowd (its conversation replaced): over
  w.step();
  w.talk.press();
  p.conversation = null;
  w.step();
  assert.equal(w.talk.talk(), null);
});

test('who can be talked to: nobody in a crosswalk\'s roadway, dodging or running; a chat with another pedestrian is broken off', () => {
  const inRoad = ped(0, 2, { node: {}, t: 5, len: 12 });
  const w = world({ peds: [inRoad] });
  w.step();
  assert.equal(w.talk.target(), null);
  inRoad.t = 1; // at the curb, waiting
  w.step(0.6);
  assert.equal(w.talk.target().npc, inRoad);
  const dodging = ped(0, 2, { dodgeTarget: 1 });
  const w2 = world({ peds: [dodging] });
  w2.step(0.6);
  assert.equal(w2.talk.target(), null);
  // two pedestrians chatting: talking to one ends their chat
  const a = ped(0, 2), b = ped(0.8, 2.2);
  const chat = { a, b, remaining: 8 };
  a.conversation = b.conversation = chat;
  const w3 = world({ peds: [a, b] });
  w3.step();
  assert.equal(w3.talk.target().npc, a);
  w3.talk.press();
  assert.equal(b.conversation, null);
  assert.equal(chat.remaining, 0);
  assert.ok(a.conversation.npcTalk);
});

test('the Thrill Hill crowd: a guest at the fire turns to the player and speaks the special\'s night lines', () => {
  const guest = { phase: 'at', x: 0, z: 2, heading: Math.PI };
  const walking = { phase: 'arriving', x: 0, z: 1, heading: 0 };
  const w = world({ party: [guest, walking], night: true });
  w.speech.bind(guest, 'thrill-hill-crowd');
  w.speech.bind(walking, 'thrill-hill-crowd');
  w.step(0.6);
  assert.equal(w.talk.target().npc, guest, 'only someone standing at the fire');
  const r = w.talk.press();
  assert.equal(r.kind, 'party');
  assert.equal(r.speaker, 'Thrill Hill crowd');
  assert.match(r.text, /^tn\d$/);
  assert.ok(Math.abs(guest.talkFacing - Math.atan2(0 - 0, 0 - 2)) < 1e-9, 'faces the player');
  w.step(4.2);
  assert.ok(Number.isNaN(guest.talkFacing), 'back to the fire');
});

test('step aside: a pedestrian the walking player bumps into steps off the line, away from the player, where there is room', () => {
  const p = ped(0.2, 0.6);
  const w = world({ peds: [p] });
  w.player.speed = 1.4;
  w.step(0.6);
  assert.equal(p.dodgeTarget, STEP.offset, 'to the side away from the player');
  assert.ok(p.avoidUntil > w.clock);
  assert.equal(w.talk.stats.stepAsides, 1);
  // nobody steps aside from a player standing still, or someone behind the player
  const q = ped(0.2, 0.6), r = ped(0.1, -0.5);
  const w2 = world({ peds: [q, r] });
  w2.step(0.6);
  assert.equal(q.dodgeTarget, 0);
  w2.player.speed = 1.4;
  w2.step(0.2);
  assert.equal(r.dodgeTarget, 0, 'behind');
  // no room on the far side: the near side; no room on either: they stop
  const s = ped(0.2, 0.6);
  const w3 = world({ peds: [s], canStand: (x) => x < 0 });
  w3.player.speed = 1.4;
  w3.step(0.2);
  assert.equal(s.dodgeTarget, -STEP.offset);
  const u = ped(0.2, 0.6);
  const w4 = world({ peds: [u], canStand: () => false });
  w4.player.speed = 1.4;
  w4.step(0.2);
  assert.equal(u.dodgeTarget, 0);
  assert.ok(u.pause >= 0.9);
});

test('flinch: a pedestrian close to the player\'s fast car steps back once; a slow car or a distant one does nothing', () => {
  const close = ped(1.6, 0), far = ped(4, 0);
  const w = world({ peds: [close, far] });
  w.player.speed = 12;
  w.step(0.1, 'car');
  assert.equal(close.dodgeTarget, FLINCH.offset, 'away from the car (+x)');
  assert.ok(close.pause >= FLINCH.hold - 1e-9);
  assert.equal(far.dodgeTarget, 0);
  assert.equal(w.talk.stats.flinches, 1);
  w.step(1, 'car');
  assert.equal(w.talk.stats.flinches, 1, `once per ${FLINCH.cooldown} s`);
  const q = ped(1.6, 0);
  const w2 = world({ peds: [q] });
  w2.player.speed = 2;
  w2.step(0.5, 'car');
  assert.equal(q.dodgeTarget, 0);
  assert.equal(w2.talk.stats.rebuilds, 0, 'no grid at all while slow and not on foot');
});

test('performance: the crowd is binned twice a second, and only while needed', () => {
  const peds = Array.from({ length: 300 }, (_, i) => ped((i % 30) * 10, Math.floor(i / 30) * 10));
  const w = world({ peds });
  w.step(2);
  assert.ok(w.talk.stats.rebuilds >= 4 && w.talk.stats.rebuilds <= 5, `${w.talk.stats.rebuilds} rebuilds in 2 s`);
  assert.equal(w.talk.stats.gridSize, 300);
  const before = w.talk.stats.rebuilds;
  w.player.speed = 0;
  w.step(2, 'helicopter');
  assert.equal(w.talk.stats.rebuilds, before, 'none in the helicopter');
});

// ---------------------------------------------------------------- Glens Falls only

test('New York: the talk is not loaded; Glens Falls opts in through its own modules and preloads', () => {
  const nyc = read('js/nyc-main.js');
  assert.doesNotMatch(nyc, /npc|KeyT|talk/i);
  const mainJs = read('js/main.js');
  const nycList = mainJs.slice(mainJs.indexOf('const NYC_PRELOADS'), mainJs.indexOf('const GF_PRELOADS'));
  const gfList = mainJs.slice(mainJs.indexOf('const GF_PRELOADS'), mainJs.indexOf('];', mainJs.indexOf('const GF_PRELOADS')));
  for (const f of ['gf-npc-lines.js', 'gf-npc-talk.js', 'gf-npc-talk-ui.js']) {
    assert.doesNotMatch(nycList, new RegExp(f.replace(/\./g, '\\.')));
    assert.match(gfList, new RegExp(`'${f.replace(/\./g, '\\.')}'`));
  }
  assert.doesNotMatch(read('index.html'), /npc/i, 'no markup or stylesheet in the shared page');
  assert.doesNotMatch(read('css/style.css'), /npc/i);
  // the shared modules carry no city names for it, and the talk modules no city branching
  for (const f of ['js/gf-npc-lines.js', 'js/gf-npc-talk.js', 'js/gf-npc-talk-ui.js']) assert.doesNotMatch(read(f), /city ===|params\.get\('city'\)|'glensfalls'/);
  // gf-main.js: one import, one install, one update, the hint
  const gf = read('js/gf-main.js');
  assert.equal(gf.match(/installGfNpcTalk/g).length, 2);
  assert.equal(gf.match(/npcTalk\.update\(dt, elapsed\)/g).length, 1);
  assert.match(gf, /\[\['T'\], 'Talk'\]/);
  // T is free: no other binding in Glens Falls's controls
  assert.equal(TALK_KEY, 'KeyT');
  for (const f of ['js/controllers.js', 'js/gamepad-controls.js', 'js/cameras.js', 'js/gf-main.js']) assert.doesNotMatch(read(f), /KeyT/);
  assert.match(read('README.md'), /`T`/);
});
