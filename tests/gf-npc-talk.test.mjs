import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseNpcLines, loadNpcLines, createNpcSpeech, lineText, FALLBACK_LINES, FALLBACK_LINE, LINES_URL, PERIODS } from '../js/gf-npc-lines.js';
import { createNpcTalk, createOneBound, pickTalkTarget, createNpcGrid, footprintDistance, TALK_KEY, TALK, STEP, FLINCH } from '../js/gf-npc-talk.js';

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

// CC-NPC2: the starter line bank (Dave's Notion page, 2026-11-16): every group and its count
const BANK = {
  groups: { 'thrill-hill-talk': 21, 'gf-history-talk': 45, 'hockey-red-wings': 28, 'hockey-icehawks': 20, 'hockey-phantoms': 20,
    'hockey-thunder': 20, 'hockey-gfhs-93': 20 },
  specials: { 'thrill-hill-crowd': { night: 33, day: 8 }, 'party-oregano-guy': 15, 'thrill-cop': 10, 'buckley-tire': 8, 'jeff-hammel': 5,
    'charles-penguin': 4, 'cast-link-lines': 8, rodin: 3, haus: 3, 'wing-ghost': 3, 'glen-ghost': 3 }
};
const bankText = () => read('data/gf/npc-lines.json');
// every line in the file: [where, text, speaker]
function allLines(lines) {
  const out = [];
  const add = (where, list) => list.forEach((l) => out.push([where, lineText(l), typeof l === 'string' ? null : l.speaker]));
  for (const p of PERIODS) add(`randos.${p}`, lines.randos[p]);
  for (const g of Object.values(lines.randos.groups)) for (const p of PERIODS) add(g.id, g[p]);
  for (const sp of Object.values(lines.specials)) for (const p of PERIODS) add(sp.id, sp[p]);
  return out;
}

test('the line file Dave edits: valid JSON, every group of the starter bank present with its count, no warnings', () => {
  const text = bankText();
  assert.doesNotThrow(() => JSON.parse(text));
  const { lines, warnings, ok } = parseNpcLines(text);
  assert.equal(ok, true);
  assert.deepEqual(warnings, []);
  // the plain rando lists stay empty: town talk comes from the named groups
  for (const p of PERIODS) assert.deepEqual(lines.randos[p], [], `randos.${p}`);
  assert.deepEqual(Object.keys(lines.randos.groups).sort(), Object.keys(BANK.groups).sort());
  for (const [id, n] of Object.entries(BANK.groups)) {
    const g = lines.randos.groups[id];
    assert.equal(g.day.length + g.night.length + g.any.length, n, `${id}: ${n} lines`);
    assert.ok(g.name, `${id} has a name for the bubble`);
  }
  assert.deepEqual(Object.keys(lines.specials).sort(), Object.keys(BANK.specials).sort());
  for (const [id, n] of Object.entries(BANK.specials)) {
    const sp = lines.specials[id];
    if (typeof n === 'number') assert.equal(sp.day.length + sp.night.length + sp.any.length, n, `${id}: ${n} lines`);
    else for (const [p, k] of Object.entries(n)) assert.equal(sp[p].length, k, `${id}.${p}: ${k} lines`);
  }
  const crowd = lines.specials['thrill-hill-crowd'];
  assert.equal(crowd.name, 'Thrill Hill crowd');
  assert.equal(crowd.where, 'thrill-hill');
  // only the crowd has a place: the cop, Oregano Guy and the stored characters must not take it over
  assert.deepEqual(Object.values(lines.specials).filter((sp) => sp.where).map((sp) => sp.id), ['thrill-hill-crowd']);
  // no placeholders, no source notes in the spoken text, nothing over the cap
  const every = allLines(lines);
  for (const [where, t] of every) {
    assert.doesNotMatch(t, /PLACEHOLDER|Source:|Wikipedia|https?:/i, where);
    assert.ok(t.length <= 400, `${where}: ${t.length} characters (the cap)`);
  }
  // Dave's wording as written: spot checks of the odd ones (not to be fixed)
  const has = (re) => every.some(([, t]) => re.test(t));
  assert.ok(has(/^Keg stand\?   No\?   you must be a freshman$/));
  assert.ok(every.some(([, t, sp]) => sp === 'Key guy' && /^Keg stand/.test(t)));
  assert.ok(has(/dont harsh are mellow\.$/));
  assert.ok(has(/^I’m puking \(bends over and “blaaaaaaahhhh” appears as text\) -$/));
  assert.ok(has(/^Thrill Hill's the only place in town where you can do a proper keg stand$/));
  assert.ok(has(/^Skip Thrill Hill\? Sure, if you’re a nerd\.$/));
  assert.ok(has(/MF Doom mash/) && has(/April 14, 1965/));
  assert.ok(has(/^Eager\. Hey man, you holding\?/));
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
  assert.deepEqual(r2.lines.randos, { day: [], night: [], any: [], groups: {} });
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
  assert.deepEqual(speech.say(ghost, 0, 0, 'night'), { text: 'g1', speaker: 'Ghost carriage (fiction)', special: 'crandall-ghost-carriage', group: null });
  speech.unbind(ghost);
  assert.equal(speech.boundTo(ghost), null);
});

test('the game binds the party\'s people to thrill-hill-crowd and its fire to the thrill-hill place', () => {
  const ui = read('js/gf-npc-talk-ui.js');
  assert.match(ui, /THRILL_HILL = \{ special: 'thrill-hill-crowd', place: 'thrill-hill', radius: 30 \}/);
  // every guest is the crowd but the last, who is Oregano Guy
  assert.match(ui, /people\.forEach\(\(p, k\) => speech\.bind\(p, k === people\.length - 1 \? OREGANO_GUY : THRILL_HILL\.special\)\)/);
  assert.match(ui, /OREGANO_GUY = 'party-oregano-guy'/);
  // by day one trail walker is the Thrill Cop (not a place: that would take the crowd's day lines in the 30 m circle)
  assert.match(ui, /THRILL_COP = \{ special: 'thrill-cop'/);
  assert.match(ui, /thrillCop\.update\(elapsed, peds, period\(\) === 'day'\)/);
  assert.match(ui, /speech\.registerPlace\(THRILL_HILL\.place, \{ x: fire\.x, z: fire\.z, r: THRILL_HILL\.radius \}\)/);
  // and the data's special names the same place
  assert.equal(parseNpcLines(read('data/gf/npc-lines.json')).lines.specials['thrill-hill-crowd'].where, 'thrill-hill');
  // the party turns a guest to the player while talking (talkFacing), and back to the fire after
  assert.match(read('js/gf-thrill-hill.js'), /Number\.isFinite\(p\.talkFacing\) \? p\.talkFacing : p\.heading \+ sway/);
});

// ---------------------------------------------------------------- CC-NPC2: the starter bank's rules

test('Jeff Hammel and Charles Penguin stay separate: neither group names the other, no line names both', () => {
  const { lines } = parseNpcLines(bankText());
  const hammel = lines.specials['jeff-hammel'].any.map(lineText), penguin = lines.specials['charles-penguin'].any.map(lineText);
  assert.ok(hammel.length && penguin.length);
  for (const t of hammel) assert.doesNotMatch(t, /charles|penguin/i, t);
  for (const t of penguin) assert.doesNotMatch(t, /jeff|hammel/i, t);
  for (const [where, t, speaker] of allLines(lines)) {
    const both = `${t} ${speaker || ''}`;
    assert.ok(!(/jeff|hammel/i.test(both) && /charles|penguin/i.test(both)), `${where}: ${t}`);
  }
  // and neither is placed in the game yet (stored for CC-CAST)
  assert.doesNotMatch(read('js/gf-npc-talk-ui.js'), /jeff-hammel|charles-penguin/);
});

test('object lines: { text, speaker } parse, the speaker shows over the line, and no-repeat compares the text', () => {
  const r = parseNpcLines({ randos: { day: [], night: [], any: [] }, specials: { s: { name: 'Group', any: [
    { text: '  one  ', speaker: ' Keg guy ' }, { text: 'two' }, 'three', { text: 'one', speaker: 'Someone else' },
    { speaker: 'nobody' }, { text: '   ' }, { text: 'four', speaker: 7 }, { text: 'x'.repeat(450), speaker: 'Long' }
  ] } } });
  const list = r.lines.specials.s.any;
  assert.deepEqual(list.slice(0, 5), [{ text: 'one', speaker: 'Keg guy' }, 'two', 'three', { text: 'one', speaker: 'Someone else' }, 'four']);
  assert.equal(list[5].text.length, 400, 'cut at 400 like a plain line');
  for (const re of [/any\[4\] has no "text"/, /any\[5\] is empty/, /any\[6\]\.speaker should be a name/, /any\[7\] is longer/]) {
    assert.ok(r.warnings.some((w) => re.test(w)), `warns ${re}`);
  }
  const speech = createNpcSpeech({ lines: r.lines, random: seeded(9) });
  const npc = {};
  speech.bind(npc, 's');
  const seen = new Map();
  let before = null;
  for (let i = 0; i < 300; i++) {
    const said = speech.say(npc, 0, 0, i % 2 ? 'day' : 'night');
    assert.notEqual(said.text, before, `draw ${i}: never the same text twice in a row (the two "one" lines count as one)`);
    before = said.text;
    seen.set(`${said.text}|${said.speaker}`, true);
  }
  assert.ok(seen.has('one|Keg guy') && seen.has('one|Someone else'), 'each object line keeps its own speaker');
  assert.ok(seen.has('two|Group') && seen.has('three|Group'), 'a line without a speaker shows the special\'s name');
});

test('rando groups: one group picked with equal weight among those with lines now, then a line from it, by time of day', () => {
  const lines = parseNpcLines({ randos: { day: [], night: [], any: [], groups: {
    big: { name: 'Big', any: Array.from({ length: 40 }, (_, i) => `b${i}`) },
    small: { name: 'Small', any: ['s1', 's2'] },
    days: { name: 'Days', day: ['dd1', 'dd2'] },
    nights: { name: 'Nights', night: ['nn1', 'nn2'] },
    empty: { name: 'Empty', day: [], night: [] }
  } } }).lines;
  const speech = createNpcSpeech({ lines, random: seeded(21) });
  const count = (period) => {
    const c = {};
    for (let i = 0; i < 3000; i++) {
      const r = speech.say({}, 0, 0, period); // a new person each time: no-repeat does not bend the odds
      c[r.group] = (c[r.group] || 0) + 1;
      assert.equal(r.speaker, lines.randos.groups[r.group].name, 'the bubble shows the group\'s name');
      assert.equal(r.special, null);
    }
    return c;
  };
  const day = count('day'), night = count('night');
  assert.deepEqual(Object.keys(day).sort(), ['big', 'days', 'small'], 'by day: day + any groups only');
  assert.deepEqual(Object.keys(night).sort(), ['big', 'nights', 'small'], 'by night: night + any groups only');
  for (const n of [...Object.values(day), ...Object.values(night)]) assert.ok(n > 850 && n < 1150, `about a third each, not by size (${n})`);
  // no immediate repeat for one person across groups
  const p = {};
  let before = null;
  for (let i = 0; i < 300; i++) { const t = speech.say(p, 0, 0, 'day').text; assert.notEqual(t, before); before = t; }
  // a group whose only line was just said hands over to another group rather than repeat
  const solo = createNpcSpeech({ lines: parseNpcLines({ randos: { day: [], night: [], any: [], groups: { a: { any: ['only'] }, b: { any: ['other'] } } } }).lines, random: () => 0 });
  const q = {};
  assert.deepEqual([solo.say(q, 0, 0, 'day').text, solo.say(q, 0, 0, 'day').text, solo.say(q, 0, 0, 'day').text], ['only', 'other', 'only']);
  assert.equal(solo.say({}, 0, 0, 'day').speaker, null, 'a group without a name shows no name');
  // the plain lists, when not empty, are one more group (no name)
  const mixed = createNpcSpeech({ lines: parseNpcLines({ randos: { day: ['plain'], night: [], any: [], groups: { g: { name: 'G', any: ['grouped'] } } } }).lines, random: seeded(4) });
  const got = new Set(Array.from({ length: 200 }, () => mixed.say({}, 0, 0, 'day').speaker));
  assert.deepEqual([...got].sort(), [null, 'G'].sort());
});

test('the real bank: town talk by day and night comes from the groups (never the placeholder); the crowd keeps its own lists', () => {
  const { lines } = parseNpcLines(bankText());
  const speech = createNpcSpeech({ lines, random: seeded(17) });
  const groups = new Set();
  for (let i = 0; i < 2000; i++) {
    for (const period of ['day', 'night']) {
      const r = speech.say({}, 5000, 5000, period);
      assert.notEqual(r.text, FALLBACK_LINE);
      assert.ok(r.group && lines.randos.groups[r.group], 'a town group');
      groups.add(r.group);
    }
  }
  assert.deepEqual([...groups].sort(), Object.keys(BANK.groups).sort(), 'every group is heard');
  // the crowd: night lines at night (with their speakers), day lines by day, never each other's
  const guest = {};
  speech.bind(guest, 'thrill-hill-crowd');
  const night = new Set(lines.specials['thrill-hill-crowd'].night.map(lineText)), day = new Set(lines.specials['thrill-hill-crowd'].day.map(lineText));
  for (let i = 0; i < 200; i++) {
    const n = speech.say(guest, 0, 0, 'night');
    assert.ok(night.has(n.text) && n.speaker && n.speaker !== 'Thrill Hill crowd', 'a crowd line with its own speaker');
    assert.ok(day.has(speech.say(guest, 0, 0, 'day').text), 'by day, the day list (the night list is not chosen)');
  }
  // anyone within 30 m of the fire by day: the crowd's day lines, not the cop's
  speech.registerPlace('thrill-hill', { x: 0, z: 0, r: 30 });
  assert.equal(speech.specialFor({}, 10, 10, 'day').id, 'thrill-hill-crowd');
  // the bound characters
  const oregano = {}, cop = {};
  speech.bind(oregano, 'party-oregano-guy');
  speech.bind(cop, 'thrill-cop');
  assert.equal(speech.say(oregano, 0, 0, 'night').speaker, 'Oregano Guy');
  assert.equal(speech.say(cop, 900, 900, 'day').speaker, 'The Thrill Cop');
  // the stored groups speak for nobody unless bound
  for (const id of ['buckley-tire', 'jeff-hammel', 'charles-penguin', 'cast-link-lines', 'rodin', 'haus', 'wing-ghost', 'glen-ghost', 'thrill-cop', 'party-oregano-guy']) {
    assert.equal(lines.specials[id].where, null, `${id}: no place`);
  }
});

test('a file with no randos.groups loads and speaks exactly as before; a malformed groups is ignored with a warning', () => {
  const plain = parseNpcLines(SAMPLE);
  assert.deepEqual(plain.warnings, []);
  assert.deepEqual(plain.lines.randos.groups, {});
  // the same draws as a speech made from the same lines without the groups key at all
  const a = createNpcSpeech({ lines: plain.lines, random: seeded(8) }), b = createNpcSpeech({ lines: { ...plain.lines, randos: { ...plain.lines.randos, groups: undefined } }, random: seeded(8) });
  const pa = {}, pb = {};
  for (let i = 0; i < 50; i++) assert.deepEqual(a.say(pa, 0, 0, i % 3 ? 'day' : 'night'), b.say(pb, 0, 0, i % 3 ? 'day' : 'night'));
  assert.equal(a.say({}, 0, 0, 'day').speaker, null);
  for (const groups of [[], 'x', 3, null]) {
    const r = parseNpcLines({ ...SAMPLE, randos: { ...SAMPLE.randos, groups } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.lines.randos.groups, {});
    assert.ok(r.warnings.some((w) => /randos\.groups should be/.test(w)), String(groups));
  }
  const r = parseNpcLines({ ...SAMPLE, randos: { ...SAMPLE.randos, groups: { bad: 'no', blank: { name: '' , any: ['x'] }, none: { name: 'N' } } } });
  assert.ok(r.warnings.some((w) => /randos\.groups\.bad should be/.test(w)));
  assert.ok(r.warnings.some((w) => /randos\.groups\.blank\.name/.test(w)));
  assert.ok(r.warnings.some((w) => /randos\.groups\.none has no/.test(w)));
  assert.equal(r.lines.randos.groups.blank.name, null);
  // empty plain lists plus groups: never the "could not be read" placeholder
  const only = createNpcSpeech({ lines: parseNpcLines({ randos: { day: [], night: [], any: [], groups: { g: { name: 'G', night: ['late'] } } } }).lines });
  assert.equal(only.say({}, 0, 0, 'night').text, 'late');
  assert.equal(only.say({}, 0, 0, 'day').text, FALLBACK_LINE, 'nothing at all for the day: the placeholder, as before');
});

test('the Thrill Cop: one trail walker at a time by day, the nearest to the fire; let go at night or when they leave', () => {
  const speech = createNpcSpeech({ lines: parseNpcLines(bankText()).lines });
  const trail = { trail: { edge: 1 } }, street = { edge: {} };
  const a = { placed: true, x: 100, z: 0, route: trail }, b = { placed: true, x: 50, z: 0, route: trail }, c = { placed: true, x: 10, z: 0, route: street }, d = { placed: true, x: 5, z: 0, route: trail };
  speech.bind(d, 'thrill-hill-crowd'); // already someone else
  const peds = [a, b, c, d];
  const cop = createOneBound({ speech, special: 'thrill-cop', anchor: { x: 0, z: 0 }, eligible: (p) => !!(p.route && p.route.trail) && Math.hypot(p.x, p.z) < 1000 });
  assert.equal(cop.update(0, peds, true), b, 'the nearest eligible walker not already bound');
  assert.equal(speech.boundTo(b), 'thrill-cop');
  assert.equal(speech.boundTo(c), null, 'not a street walker');
  assert.equal(cop.update(1, peds, true), b, 'checked every 2 s, not every frame');
  b.x = 5000; // respawned far away
  assert.equal(cop.update(2.1, peds, true), a);
  assert.equal(speech.boundTo(b), null, 'let go');
  assert.equal(cop.update(4.2, peds, false), null, 'nobody at night');
  assert.equal(speech.boundTo(a), null);
  assert.equal(speech.say(a, 100, 0, 'night').special, null, 'the old holder is a rando again');
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
  assert.ok(Math.abs(w.talk.target().y - 1.78) < 1e-9, 'the prompt over the head (pelvis + 0.78 m)');
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
