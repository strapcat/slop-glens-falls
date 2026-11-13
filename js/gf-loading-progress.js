// CC-MOBILE-fix (Glens Falls only): an honest loading bar. The overlay (#loading-status, #loading-progress) shows the
// stage and an overall percent across the whole load, weighted by each stage's rough cost, instead of a sweep that
// only fills during shader compilation. Three sources feed it, in order:
//   code     js/main.js counts the modulepreload links as they land
//   terrain  js/gf-terrain-data.js streams js/gf-terrain.bin.gz (bytes received / Content-Length) and inflates it
//   the rest js/gf-main.js's start-up stages (the [init] timings), shader compilation by batches
// The bar never moves back. No DOM (a test): it only keeps the numbers.

// [id, label, weight]: weights from the [init] timings of a mobile-tier load (headless; terrain and code by download
// size: the 6.85 MB terrain is the longest wait on a phone)
const STAGES = [
  ['code', 'Loading code', 12],
  ['terrain', 'Loading terrain', 30],
  ['graphics', 'Starting graphics', 1],
  ['lighting', 'Sky and lighting', 1],
  ['ground', 'Terrain, roads and water', 11],
  ['buildings', 'Raising buildings', 4],
  ['trees', 'Planting trees', 4],
  ['traffic', 'Creating traffic', 3],
  ['roadPaint', 'Road markings', 2],
  ['streetFurniture', 'Crosswalks, signs and lamps', 2],
  ['controllers', 'Player, vehicles and controls', 4],
  ['ui', 'Effects and interface', 2],
  ['compile', 'Compiling shaders', 15],
  ['firstFrame', 'First frame', 9]
];

function createLoadingProgress(stages = STAGES) {
  const total = stages.reduce((t, s) => t + s[2], 0);
  const start = new Map();
  let at = 0;
  for (const [id, , w] of stages) { start.set(id, at); at += w; }
  const labelOf = new Map(stages.map(([id, label]) => [id, label]));
  const weightOf = new Map(stages.map(([id, , w]) => [id, w]));
  let shown = 0, stage = stages[0][0], text = `${stages[0][1]}… 0%`;
  const listeners = new Set();
  const api = {
    // a stage reached (fraction of it done: 0 at its start); label overrides the stage's own words; returns the text
    set(id, fraction = 0, label = null) {
      if (!start.has(id)) return text;
      const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
      const value = (start.get(id) + weightOf.get(id) * f) / total;
      // a stage already passed (a late report: modules still landing after the terrain began) changes nothing
      if (value < shown && id !== stage) return text;
      if (value >= shown) { shown = value; stage = id; }
      text = `${label || labelOf.get(id)}… ${api.percent()}%`;
      for (const fn of listeners) fn(api);
      return text;
    },
    done() {
      shown = 1; stage = stages[stages.length - 1][0]; text = 'Ready… 100%';
      for (const fn of listeners) fn(api);
    },
    percent: () => Math.min(100, Math.floor(shown * 100)),
    fraction: () => shown,
    stage: () => stage,
    text: () => text,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
  return api;
}

// The page's one progress, shared by main.js, gf-terrain-data.js and gf-main.js; drawn into the overlay when there is
// one (the label in #loading-status, the bar #loading-progress, no longer sweeping)
function loadingProgress(doc = globalThis.document) {
  if (globalThis.__gfLoadingProgress) return globalThis.__gfLoadingProgress;
  const p = createLoadingProgress();
  globalThis.__gfLoadingProgress = p;
  if (doc && typeof doc.getElementById === 'function') {
    p.onChange(() => {
      const status = doc.getElementById('loading-status');
      const fill = doc.getElementById('loading-progress');
      const track = fill && fill.parentElement;
      if (status) status.textContent = p.text();
      if (track && track.classList) track.classList.remove('is-indeterminate');
      if (fill) fill.style.transform = `scaleX(${p.fraction()})`;
    });
  }
  return p;
}

export { createLoadingProgress, loadingProgress, STAGES };
