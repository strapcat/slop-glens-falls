// CC-NPC1: what the people of Glens Falls say when the player talks to them. Every line comes from a file Dave writes
// himself, data/gf/npc-lines.json (how to edit it: data/gf/NPC-LINES.md). Nothing here writes or generates dialogue
// and nothing here calls a network service: the file is read once from the game's own folder, next to index.html.
// No DOM and no three.js, so the Node tests run exactly what the game runs.
//
// The file:
//   randos    any ordinary sidewalk pedestrian: lists day, night and any (any is said at either time)
//   specials  named characters or groups, by id: { name, where?, day?, night?, any? }. A special speaks for whatever the
//             game binds to it (bind(object, id), e.g. the Thrill Hill party's people), and, when it has a `where`, for
//             anyone the player talks to inside the place of that name (registerPlace(name, { x, z, r })). A special
//             with nothing to say at this time of day leaves the talking to the randos' lists.
//
// A bad file never stops the game: parseNpcLines() logs what is wrong and keeps whatever it can; a file that cannot be
// read at all (missing, not JSON) gives FALLBACK_LINES.

const PERIODS = ['day', 'night', 'any'];
const LINES_URL = '../data/gf/npc-lines.json'; // relative to this module (js/)
// Said when there is nothing to say: the file could not be read, or every list that applies is empty
const FALLBACK_LINE = 'PLACEHOLDER — npc-lines.json could not be read (see the browser console)';
const FALLBACK_LINES = Object.freeze({
  randos: Object.freeze({ day: Object.freeze([]), night: Object.freeze([]), any: Object.freeze([FALLBACK_LINE]) }),
  specials: Object.freeze({})
});
const MAX_LINE = 400; // characters: longer lines are cut (a speech bubble, not a page)

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// One list of lines: strings only, trimmed, blanks dropped
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
    if (typeof line !== 'string') { warnings.push(`${where}[${i}] is not text in quotes (skipped)`); return; }
    const text = line.trim();
    if (!text) { warnings.push(`${where}[${i}] is empty (skipped)`); return; }
    if (text.length > MAX_LINE) warnings.push(`${where}[${i}] is longer than ${MAX_LINE} characters (cut)`);
    out.push(text.slice(0, MAX_LINE));
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
  const last = new WeakMap(); // person -> the line they said last

  const has = (list, period) => list && ((list[period] && list[period].length) || (list.any && list.any.length));
  const pool = (list, period) => [...(list[period] || []), ...(list.any || [])];

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

  // What `npc` at (x, z) says now: { text, speaker (the special's name, or null), special (its id, or null) }
  function say(npc, x, z, period) {
    const special = specialFor(npc, x, z, period);
    let options = special ? pool(special, period) : pool(data.randos, period);
    if (!options.length) options = [FALLBACK_LINE];
    const before = npc && typeof npc === 'object' ? last.get(npc) : undefined;
    const fresh = options.filter((l) => l !== before);
    const choice = fresh.length ? fresh : options;
    const text = choice[Math.min(choice.length - 1, Math.floor(random() * choice.length))];
    if (npc && typeof npc === 'object') last.set(npc, text);
    return { text, speaker: special ? special.name : null, special: special ? special.id : null };
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

export { parseNpcLines, loadNpcLines, createNpcSpeech, FALLBACK_LINES, FALLBACK_LINE, LINES_URL, PERIODS };
