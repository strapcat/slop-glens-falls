// CC-NPC1: what the people of Glens Falls say when the player talks to them. Every line comes from a file Dave writes
// himself, data/gf/npc-lines.json (how to edit it: data/gf/NPC-LINES.md). Nothing here writes or generates dialogue
// and nothing here calls a network service: the file is read once from the game's own folder, next to index.html.
// No DOM and no three.js, so the Node tests run exactly what the game runs.
//
// The file:
//   randos    any ordinary sidewalk or trail pedestrian: lists day, night and any (any is said at either time), and
//             (CC-NPC2) `groups`: named groups of town talk, by id: { name, day?, night?, any? }. A pedestrian first
//             picks one group, each with the same chance, among the groups that have something to say at this time of
//             day (the plain day / night / any lists count as one more group when they are not empty), then a line
//             from that group. The bubble shows the group's name.
//   specials  named characters or groups, by id: { name, where?, day?, night?, any? }. A special speaks for whatever the
//             game binds to it (bind(object, id), e.g. the Thrill Hill party's people), and, when it has a `where`, for
//             anyone the player talks to inside the place of that name (registerPlace(name, { x, z, r })). A special
//             with nothing to say at this time of day leaves the talking to the randos. A special nothing is bound to
//             and with no `where` is stored for later and never heard.
//   lines     (CC-NPC2) a line is text in quotes, or { "text": "...", "speaker": "..." }: the speaker's name, when given,
//             is shown over the line instead of the group's or the special's name.
//
// A bad file never stops the game: parseNpcLines() logs what is wrong and keeps whatever it can; a file that cannot be
// read at all (missing, not JSON) gives FALLBACK_LINES.

const PERIODS = ['day', 'night', 'any'];
const LINES_URL = '../data/gf/npc-lines.json'; // relative to this module (js/)
// Said when there is nothing to say: the file could not be read, or every list that applies is empty
const FALLBACK_LINE = 'PLACEHOLDER — npc-lines.json could not be read (see the browser console)';
const FALLBACK_LINES = Object.freeze({
  randos: Object.freeze({ day: Object.freeze([]), night: Object.freeze([]), any: Object.freeze([FALLBACK_LINE]), groups: Object.freeze({}) }),
  specials: Object.freeze({})
});
const MAX_LINE = 400; // characters: longer lines are cut (a speech bubble, not a page)

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A cleaned line's spoken text and its own speaker (null: the group's or the special's name)
const lineText = (line) => (typeof line === 'string' ? line : line.text);
const lineSpeaker = (line) => (typeof line === 'string' ? null : line.speaker || null);

// One list of lines: text in quotes, or { text, speaker? }; trimmed, blanks dropped. A plain string stays a string; a
// line with a speaker becomes { text, speaker }
function cleanList(value, where, warnings, { required }) {
  if (value === undefined) {
    if (required) warnings.push(`${where} is missing (using an empty list)`);
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${where} should be a list of lines in [ ] (using an empty list)`);
    return [];
  }
  const out = [];
  value.forEach((line, i) => {
    let raw = line, speaker = null;
    if (isObject(line)) {
      raw = line.text;
      if (line.speaker !== undefined) {
        if (typeof line.speaker === 'string' && line.speaker.trim()) speaker = line.speaker.trim();
        else warnings.push(`${where}[${i}].speaker should be a name in quotes (ignored)`);
      }
      if (typeof raw !== 'string') { warnings.push(`${where}[${i}] has no "text" in quotes (skipped)`); return; }
    } else if (typeof line !== 'string') { warnings.push(`${where}[${i}] is not text in quotes (skipped)`); return; }
    const text = raw.trim();
    if (!text) { warnings.push(`${where}[${i}] is empty (skipped)`); return; }
    if (text.length > MAX_LINE) warnings.push(`${where}[${i}] is longer than ${MAX_LINE} characters (cut)`);
    out.push(speaker ? { text: text.slice(0, MAX_LINE), speaker } : text.slice(0, MAX_LINE));
  });
  return out;
}

// The line file (its JSON text, or the parsed object) checked and cleaned: { lines, warnings, ok }. Never throws.
// ok is false when nothing usable came out of it (lines is then FALLBACK_LINES).
function parseNpcLines(input) {
  const warnings = [];
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      warnings.push(`npc-lines.json is not valid JSON: ${e.message}`);
      return { lines: FALLBACK_LINES, warnings, ok: false };
    }
  }
  if (!isObject(data)) {
    warnings.push('npc-lines.json should be one { } object with "randos" and "specials"');
    return { lines: FALLBACK_LINES, warnings, ok: false };
  }
  const randos = {};
  if (!isObject(data.randos)) warnings.push(`randos ${data.randos === undefined ? 'is missing' : 'should be a { } object'} (using empty lists)`);
  const r = isObject(data.randos) ? data.randos : {};
  for (const period of PERIODS) randos[period] = cleanList(r[period], `randos.${period}`, warnings, { required: isObject(data.randos) });
  // CC-NPC2: named groups of town talk (none: exactly as before)
  randos.groups = {};
  if (r.groups !== undefined && !isObject(r.groups)) warnings.push('randos.groups should be a { } object of groups (ignored)');
  for (const [id, g] of Object.entries(isObject(r.groups) ? r.groups : {})) {
    if (!isObject(g)) { warnings.push(`randos.groups.${id} should be a { } object (skipped)`); continue; }
    if (!PERIODS.some((p) => g[p] !== undefined)) warnings.push(`randos.groups.${id} has no "day", "night" or "any" list`);
    const group = { id, name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : null };
    if (g.name !== undefined && !group.name) warnings.push(`randos.groups.${id}.name should be a name in quotes (ignored)`);
    for (const period of PERIODS) group[period] = cleanList(g[period], `randos.groups.${id}.${period}`, warnings, { required: false });
    randos.groups[id] = group;
  }

  const specials = {};
  if (data.specials !== undefined && !isObject(data.specials)) warnings.push('specials should be a { } object (ignored)');
  for (const [id, s] of Object.entries(isObject(data.specials) ? data.specials : {})) {
    if (!isObject(s)) { warnings.push(`specials.${id} should be a { } object (skipped)`); continue; }
    if (!PERIODS.some((p) => s[p] !== undefined)) warnings.push(`specials.${id} has no "day", "night" or "any" list`);
    const special = { id, name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : id, where: null };
    if (s.where !== undefined) {
      if (typeof s.where === 'string' && s.where.trim()) special.where = s.where.trim();
      else warnings.push(`specials.${id}.where should be a place name in quotes (ignored)`);
    }
    for (const period of PERIODS) special[period] = cleanList(s[period], `specials.${id}.${period}`, warnings, { required: false });
    specials[id] = special;
  }
  return { lines: { randos, specials }, warnings, ok: true };
}

// Read the line file with `fetchText(url)` (a promise of its text; the game passes fetch). Resolves to parseNpcLines()'s
// result, with FALLBACK_LINES when it cannot be read; never rejects. Warnings go to `log` (console.warn).
async function loadNpcLines(fetchText, url = LINES_URL, log = (msg) => console.warn(msg)) {
  let result;
  try {
    result = parseNpcLines(await fetchText(url));
  } catch (e) {
    result = { lines: FALLBACK_LINES, warnings: [`npc-lines.json could not be read (${e && e.message ? e.message : e})`], ok: false };
  }
  for (const w of result.warnings) log(`[npc-lines] ${w}`);
  return result;
}

// The dialogue: which list applies to whom and when, and a line from it, never the same line twice in a row from the
// same person (unless it is the only one). random: () => [0, 1) (tests pass their own).
function createNpcSpeech({ lines = FALLBACK_LINES, random = Math.random } = {}) {
  let data = lines;
  const bound = new WeakMap(); // object -> special id
  const places = new Map(); // place name -> { x, z, r }
  const last = new WeakMap(); // person -> the text they said last

  const has = (list, period) => list && ((list[period] && list[period].length) || (list.any && list.any.length));
  const pool = (list, period) => [...(list[period] || []), ...(list.any || [])];
  const pick = (n) => Math.min(n - 1, Math.floor(random() * n));

  // The special that speaks for `npc` standing at (x, z) at `period` ('day' | 'night'), or null for the randos
  function specialFor(npc, x, z, period) {
    const id = npc && typeof npc === 'object' ? bound.get(npc) : undefined;
    if (id !== undefined && data.specials[id] && has(data.specials[id], period)) return data.specials[id];
    for (const s of Object.values(data.specials)) {
      const p = s.where && places.get(s.where);
      if (p && (x - p.x) ** 2 + (z - p.z) ** 2 <= p.r * p.r && has(s, period)) return s;
    }
    return null;
  }

  // The randos' groups with something to say at `period`: the named groups, then the plain lists as one more (no name)
  function randoGroups(period) {
    const out = [];
    for (const g of Object.values(data.randos.groups || {})) if (has(g, period)) out.push(g);
    if (has(data.randos, period)) out.push({ id: null, name: null, day: data.randos.day, night: data.randos.night, any: data.randos.any });
    return out;
  }

  // What `npc` at (x, z) says now: { text, speaker (the line's own, else its special's or group's name, or null),
  // special (its id, or null), group (the randos' group id, or null) }
  function say(npc, x, z, period) {
    const who = npc && typeof npc === 'object' ? npc : null;
    const before = who ? last.get(who) : undefined;
    const special = specialFor(npc, x, z, period);
    // the candidate sources in the order tried: the special; or one rando group picked with equal weight, the others
    // after it only if all its lines would repeat the last one
    let sources;
    if (special) sources = [special];
    else {
      sources = randoGroups(period);
      if (sources.length > 1) {
        const first = pick(sources.length);
        sources = [sources[first], ...sources.slice(0, first), ...sources.slice(first + 1)];
      }
    }
    let source = null, options = null;
    for (const s of sources) {
      const lines = pool(s, period);
      const fresh = lines.filter((l) => lineText(l) !== before);
      if (fresh.length) { source = s; options = fresh; break; }
      if (!source && lines.length) { source = s; options = lines; }
    }
    if (!options || !options.length) { source = null; options = [FALLBACK_LINE]; }
    const line = options[pick(options.length)];
    const text = lineText(line);
    if (who) last.set(who, text);
    return {
      text,
      speaker: lineSpeaker(line) || (source ? source.name : null) || null,
      special: special ? special.id : null,
      group: !special && source ? source.id : null
    };
  }

  return {
    say,
    specialFor,
    // Glens Falls's hook for a spawned object: `object` speaks as special `id` (an id not in the file: the randos)
    bind(object, id) { bound.set(object, id); },
    unbind(object) { bound.delete(object); },
    boundTo: (object) => bound.get(object) ?? null,
    // A named place (a special's `where`): a circle of radius r metres round (x, z)
    registerPlace(name, { x, z, r }) { places.set(name, { x, z, r }); },
    setLines(next) { data = next || FALLBACK_LINES; },
    get lines() { return data; }
  };
}

export { parseNpcLines, loadNpcLines, createNpcSpeech, lineText, lineSpeaker, FALLBACK_LINES, FALLBACK_LINE, LINES_URL, PERIODS };
