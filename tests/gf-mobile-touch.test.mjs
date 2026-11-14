import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectDeviceTier, fovHookFor, applyChaseScale, TIERS, SMALL_SCREEN, HANDHELD_QUERY, CAMDIST_RANGE } from '../js/device-tier.js';
import { installGfTouchGuards } from '../js/gf-touch-guards.js';
import { createLoadingProgress, STAGES } from '../js/gf-loading-progress.js';
import { installGfTouchExit, shortLabel } from '../js/gf-touch-exit.js';

// CC-MOBILE: the device tier (capability, not the city), the Exit / Enter touch button (the F key's path), and New York
// and desktop left as they were

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// a device: which media queries match, and its screen
const device = ({ coarse = false, hover = true, screen = [1920, 1080], search = '' } = {}) => ({
  search,
  screen: { width: screen[0], height: screen[1] },
  matchMedia: (q) => ({ matches: q === HANDHELD_QUERY ? coarse && !hover : q === '(pointer: coarse)' ? coarse : q === '(hover: none)' ? !hover : false })
});

test('the device tier: mobile for a phone or a small screen, desktop for a mouse and a large screen, whatever the city', () => {
  // an iPhone (coarse primary pointer, no hover, 390 x 844), portrait or landscape
  assert.equal(detectDeviceTier(device({ coarse: true, hover: false, screen: [390, 844] })).tier, 'mobile');
  assert.equal(detectDeviceTier(device({ coarse: true, hover: false, screen: [844, 390] })).tier, 'mobile');
  // an iPad (coarse, no hover, a large screen): handheld, so mobile
  assert.equal(detectDeviceTier(device({ coarse: true, hover: false, screen: [1024, 1366] })).tier, 'mobile');
  // a small screen that claims a fine pointer: mobile by its size
  const small = detectDeviceTier(device({ screen: [360, 740] }));
  assert.equal(small.tier, 'mobile');
  assert.match(small.reason, /short side 360/);
  assert.equal(SMALL_SCREEN, 500);
  // a desktop: fine pointer that hovers, large screen, in any window size (the screen decides, not the window)
  const desk = detectDeviceTier(device({ screen: [2560, 1440] }));
  assert.equal(desk.tier, 'desktop');
  assert.equal(desk.settings, TIERS.desktop);
  // a touchscreen laptop: a fine primary pointer that hovers (any-pointer is coarse, the primary pointer is not)
  assert.equal(detectDeviceTier(device({ coarse: false, hover: true, screen: [1920, 1200] })).tier, 'desktop');
  // ?tier= overrides either way
  assert.equal(detectDeviceTier(device({ screen: [2560, 1440], search: '?city=glensfalls&tier=mobile' })).tier, 'mobile');
  assert.equal(detectDeviceTier(device({ coarse: true, hover: false, screen: [390, 844], search: '?tier=desktop' })).tier, 'desktop');
  // the city plays no part: the same device gets the same tier in either city
  for (const city of ['glensfalls', 'newyork', '']) {
    assert.equal(detectDeviceTier(device({ coarse: true, hover: false, screen: [390, 844], search: `?city=${city}` })).tier, 'mobile');
    assert.equal(detectDeviceTier(device({ screen: [2560, 1440], search: `?city=${city}` })).tier, 'desktop');
  }
  assert.doesNotMatch(read('js/device-tier.js').replace(/^\s*\/\/.*$/gm, ''), /glensfalls|newyork|city/i);
  // no window at all (a worker, a test): desktop
  assert.equal(detectDeviceTier({}).tier, 'desktop');
});

test('the tiers: desktop keeps today\'s settings; mobile is capped as documented', () => {
  const d = TIERS.desktop, m = TIERS.mobile;
  // desktop pins: the modules' own defaults
  assert.deepEqual(d, { pixelRatio: 1, antialias: true, ssr: true, shadowMapSize: null, treeMaxDist: null, sidewalkRange: 650, lampPool: 32, lampPoolRange: 160, compilePool: 16, chaseDistanceScale: 1, chaseHeightScale: 1, portraitFov: null });
  assert.match(read('js/trees.js'), /^const MAX_DIST = \[3000, 1600, 950\];/m);
  assert.match(read('js/trees.js'), /function createTreeField\(_scene, sites, colliders = \[\], \{ maxDist = MAX_DIST \} = \{\}\)/);
  assert.match(read('js/gf-sidewalk-meshes.js'), /^const RANGE = 650;/m);
  assert.match(read('js/gf-sidewalk-meshes.js'), /\{ range = RANGE \} = \{\}/);
  assert.match(read('js/gf-street-furniture-meshes.js'), /^const POOL = 32;/m);
  assert.match(read('js/gf-street-furniture-meshes.js'), /^const POOL_RANGE = 160;/m);
  assert.match(read('js/lighting.js'), /const tile = shadowMapSize \|\| \(maxTex >= 6144 \? 3072 : 2048\);/);
  // mobile caps
  assert.equal(m.pixelRatio, 1);
  assert.equal(m.antialias, false);
  assert.equal(m.ssr, false);
  assert.equal(m.shadowMapSize, 1024);
  assert.deepEqual(m.treeMaxDist, [1000, 700, 420]);
  assert.ok(m.treeMaxDist.every((v, i) => v < [3000, 1600, 950][i]));
  assert.ok(m.sidewalkRange < d.sidewalkRange && m.lampPool < d.lampPool && m.compilePool < d.compilePool);
  // gf-main.js applies every knob from the tier it detected
  const main = read('js/gf-main.js');
  for (const re of [
    /const DEVICE = detectDeviceTier\(window\);/,
    /antialias: TIER\.antialias,/,
    /renderer\.setPixelRatio\(TIER\.pixelRatio\);/,
    /new LightingSystem\(scene, renderer, \{ shadowMapSize: TIER\.shadowMapSize \}\)/,
    /createGfSidewalkMeshes\(scene, GF_SIDEWALKS, \{ range: TIER\.sidewalkRange \}\)/,
    /createTreeField\(scene, treePlan\.sites, \[\], TIER\.treeMaxDist \? \{ maxDist: TIER\.treeMaxDist \} : \{\}\)/,
    /pool: TIER\.lampPool,\s*poolRange: TIER\.lampPoolRange/,
    /if \(TIER\.ssr\) \{/,
    /const COMPILE_POOL = TIER\.compilePool;/,
    /backend \$\{backendName\}; tier \$\{DEVICE\.tier\}/
  ]) assert.match(main, re);
});

// a minimal DOM for the touch button
function fakeDom() {
  const el = (tag) => {
    const listeners = {};
    const attrs = {};
    const classes = new Set();
    return {
      tag, children: [], textContent: '', title: '', className: '', type: '',
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)) },
      setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k],
      addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
      dispatch: (t, e = {}) => (listeners[t] || []).forEach((f) => f({ button: 0, detail: 1, preventDefault() {}, stopPropagation() {}, ...e })),
      append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; }
    };
  };
  const head = el('head');
  const actions = el('div');
  const doc = { head, createElement: el, querySelector: (s) => (s === '#touch-controls .touch-actions' ? actions : s === 'link[data-gf-touch-exit]' ? head.children.find((c) => c.tag === 'link') || null : null) };
  return { doc, actions, head };
}

test('Exit / Enter on touch: a button in the touch actions that calls the F key\'s press, dimmed with its reason', () => {
  const { doc, actions, head } = fakeDom();
  const presses = [];
  const exit = installGfTouchExit({ press: () => { presses.push('press'); return { ok: true }; }, root: doc });
  assert.equal(actions.children.length, 1);
  const b = exit.button;
  assert.equal(b.getAttribute('data-touch-tap'), 'exit');
  assert.equal(b.getAttribute('data-touch-action'), undefined, 'not a hold action: touch-controls.js leaves it alone');
  assert.ok(head.children.some((c) => c.tag === 'link' && c.href === 'css/gf-mobile.css'));
  // a tap presses (once), as F does
  b.dispatch('pointerdown');
  assert.deepEqual(presses, ['press']);
  // a mouse's other buttons do nothing; keyboard activation (click with detail 0) presses; a pointer click does not twice
  b.dispatch('pointerdown', { button: 2 });
  b.dispatch('click', { detail: 1 });
  b.dispatch('click', { detail: 0 });
  assert.deepEqual(presses, ['press', 'press']);
  // the label follows vehicle-exit.js's status
  exit.update({ ok: true, action: 'Exit taxi' });
  assert.equal(b.children[1].textContent, 'Exit');
  assert.equal(b.getAttribute('aria-disabled'), 'false');
  assert.equal(b.classList.contains('is-blocked'), false);
  exit.update({ ok: false, action: 'Exit taxi', reason: 'stop to get out' });
  assert.equal(b.classList.contains('is-blocked'), true);
  assert.equal(b.getAttribute('aria-disabled'), 'true');
  assert.equal(b.children[2].textContent, 'stop to get out');
  assert.equal(b.getAttribute('aria-label'), 'Exit taxi: stop to get out');
  exit.update({ ok: true, action: 'Enter helicopter' });
  assert.equal(b.children[1].textContent, 'Enter');
  assert.equal(b.children[2].textContent, '');
  assert.deepEqual(['Exit taxi', 'Land & exit', 'Enter taxi', 'Enter helicopter', 'Enter vehicle', 'Exit'].map(shortLabel), ['Exit', 'Land', 'Enter', 'Enter', 'Enter', 'Exit']);
  // no touch controls in the page: nothing installed
  assert.equal(installGfTouchExit({ press() {}, root: { querySelector: () => null } }).button, null);
});

test('gf-main.js: the button and the F key share pressExit; the button follows the F chip', () => {
  const main = read('js/gf-main.js');
  assert.match(main, /touchExit = installGfTouchExit\(\{ press: pressExit \}\);/);
  assert.match(main, /else if \(e\.code === EXIT_KEY && !e\.repeat\) pressExit\(\);/);
  assert.match(main, /const st = exitFlash && now < exitFlash\.until \? exitFlash : vehicleExit\.status\(\);\n\s*if \(touchExit\) touchExit\.update\(st\);/);
  // vehicle-exit.js's state machine is untouched by this pass (no touch code in it)
  assert.doesNotMatch(read('js/vehicle-exit.js'), /touch/i);
  // a failed start shows a message instead of a stuck loading screen
  assert.match(main, /initApp\(\)\.catch\(/);
});

test('New York and the shared modules: no Exit button, no city branches, no device tier forced on', () => {
  // the page itself has no Exit button: gf-touch-exit.js adds it in Glens Falls
  assert.doesNotMatch(read('index.html'), /data-touch-tap|exit-action/);
  const nyc = read('js/nyc-main.js');
  assert.doesNotMatch(nyc, /gf-touch-exit|device-tier|gf-mobile/);
  for (const f of ['js/touch-controls.js', 'js/cameras.js', 'js/controllers.js', 'js/post-processing.js', 'js/trees.js', 'js/lighting.js', 'js/gamepad-controls.js']) {
    assert.doesNotMatch(read(f), /glensfalls|city\s*===|gf-touch-exit|device-tier/i, f);
  }
  // touch-controls.js is upstream's, unchanged by this pass: still the coarse-pointer / first-touch availability
  assert.match(read('js/touch-controls.js'), /window\.matchMedia\('\(any-pointer: coarse\)'\)/);
  const main = read('js/main.js');
  const nycPre = main.slice(main.indexOf('NYC_PRELOADS'), main.indexOf('];', main.indexOf('NYC_PRELOADS')));
  assert.doesNotMatch(nycPre, /device-tier|gf-touch-exit/);
  const gfPre = main.slice(main.indexOf('GF_PRELOADS'), main.indexOf('];', main.indexOf('GF_PRELOADS')));
  assert.match(gfPre, /'device-tier\.js'/);
  assert.match(gfPre, /'gf-touch-exit\.js'/);
  // the stylesheet only restyles under body.touch-enabled or its own button
  const css = read('css/gf-mobile.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of css.split('}').map((r) => r.split('{')[0].trim()).filter((r) => r && !r.startsWith('@media'))) {
    assert.match(rule, /exit-action|body\.touch-enabled/, rule);
  }
});

// ---- CC-MOBILE-fix (Dave's iPhone test) ----

const cssRules = () => {
  const css = read('css/gf-mobile.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) rules.push({ selectors: m[1].trim().split(',').map((x) => x.trim()), body: m[2] });
  return rules;
};
const ruleFor = (selector, prop) => cssRules().find((r) => r.selectors.includes(selector) && new RegExp(`(^|[;\\s])${prop.replace(/[-]/g, '\\-')}\\s*:`).test(r.body));

test('steering on iPhone Safari: no selection, callout, magnifier or double-tap zoom on what a thumb holds', () => {
  for (const sel of ['#touch-stick', '#touch-stick-knob', '#canvas-container', '#canvas-container canvas', '.touch-action', '.touch-caption', '#touch-controls', '.mode-btn']) {
    const full = `body.touch-enabled ${sel}`;
    for (const prop of ['-webkit-user-select', 'user-select', '-webkit-touch-callout']) assert.ok(ruleFor(full, prop), `${full} { ${prop} }`);
  }
  for (const sel of ['#touch-stick', '#touch-stick-knob', '#canvas-container', '#canvas-container canvas', '.touch-action', '.touch-caption']) {
    const r = ruleFor(`body.touch-enabled ${sel}`, 'touch-action');
    assert.ok(r && /touch-action:\s*none/.test(r.body), `body.touch-enabled ${sel} { touch-action: none }`);
  }
  const body = ruleFor('body.touch-enabled', 'touch-action');
  assert.ok(body && /touch-action:\s*manipulation/.test(body.body), 'the page: no double-tap zoom');
  // the shared viewport meta is untouched (New York and desktop keep pinch zoom)
  assert.match(read('index.html'), /<meta name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover" \/>/);
  // every rule still only restyles touch screens or the button
  for (const r of cssRules()) for (const sel of r.selectors) assert.match(sel, /exit-action|body\.touch-enabled/, sel);
});

test('the touch guards cancel a held touch on the controls, only on touch screens, never on a link', () => {
  const listeners = {};
  const classes = new Set(['touch-enabled']);
  const doc = { body: { classList: { contains: (c) => classes.has(c) } }, addEventListener: (t, f, o) => { listeners[t] = { f, o }; }, removeEventListener: (t) => { delete listeners[t]; } };
  const guards = installGfTouchGuards(doc);
  assert.equal(listeners.touchstart.o.passive, false, 'touchstart can be cancelled');
  const ev = (sel) => { const e = { prevented: false, preventDefault() { this.prevented = true; }, target: { closest: (q) => (q.split(',').map((x) => x.trim()).includes(sel) ? {} : null) } }; return e; };
  const fire = (type, sel) => { const e = ev(sel); listeners[type].f(e); return e.prevented; };
  assert.equal(fire('touchstart', '#touch-stick'), true);
  assert.equal(fire('touchstart', '#touch-controls .touch-action'), true);
  assert.equal(fire('touchstart', 'canvas'), false, 'the canvas keeps its own pointer gestures');
  assert.equal(fire('selectstart', 'div'), true);
  assert.equal(fire('contextmenu', 'div'), true);
  assert.equal(fire('selectstart', 'a'), false, 'the credit\'s OSM link stays a link');
  // desktop (no touch-enabled): nothing is cancelled
  classes.delete('touch-enabled');
  for (const [t, sel] of [['touchstart', '#touch-stick'], ['selectstart', 'div'], ['contextmenu', 'div'], ['dblclick', 'div']]) assert.equal(fire(t, sel), false, t);
  guards.remove();
  assert.deepEqual(Object.keys(listeners), []);
  assert.match(read('js/gf-main.js'), /installGfTouchGuards\(document\);/);
  assert.doesNotMatch(read('js/nyc-main.js'), /gf-touch-guards/);
});

test('the GitHub badge is hidden on touch screens; the OSM / USGS credit stays, in the corner, as a link', () => {
  const hide = ruleFor('body.touch-enabled .hud-top-left', 'display');
  assert.ok(hide && /display:\s*none/.test(hide.body), 'the badge is hidden on touch screens');
  const credit = cssRules().find((r) => r.selectors.includes('body.touch-enabled #gf-attribution') && /top:/.test(r.body));
  assert.ok(credit, 'the credit is placed');
  assert.doesNotMatch(credit.body, /display:\s*none|visibility:\s*hidden|opacity:\s*0[;\s]/);
  assert.doesNotMatch(read('css/gf-mobile.css'), /\+ (112|58)px/, 'no offsets left over from clearing the badge');
  assert.match(credit.body, /top:\s*max\(var\(--edge, 12px\), env\(safe-area-inset-top\)\)/);
  // gf-main.js still makes the credit: the OSM copyright link (ODbL) and the USGS LiDAR line
  const main = read('js/gf-main.js');
  assert.match(main, /credit\.id = 'gf-attribution';/);
  assert.match(main, /link\.href = 'https:\/\/www\.openstreetmap\.org\/copyright';/);
  assert.match(main, /credit\.append\('Map data © ', link, ' \(ODbL\)', document\.createElement\('br'\), GF_LIDAR_HEIGHTS\.credit/);
});

test('the follow camera: unchanged on desktop and New York; backed off and wider in portrait on the mobile tier; ?camdist= overrides', () => {
  // shared defaults untouched: preset FOVs and entity distances
  assert.match(read('js/cameras.js'), /\{ id: 'chase',\s+name: '3rd-Person Chase',\s+category: 'follow', fov: 56 \}/);
  assert.match(read('js/cameras.js'), /\{ id: 'action',\s+name: 'Low-Angle Action',\s+category: 'follow', fov: 60 \}/);
  assert.match(read('js/cameras.js'), /\{ id: 'pov',\s+name: 'First-Person \/ Cockpit',\s+category: 'follow', fov: 68 \}/);
  const ctl = read('js/controllers.js');
  for (const [d, h] of [['4.3', '1.95'], ['6.9', '2.12'], ['4.8', '2.05'], ['11.4', '3.3']]) assert.match(ctl, new RegExp(`chaseDistance: ${d.replace('.', '\\.')},\\s*chaseHeight: ${h.replace('.', '\\.')}`));
  assert.doesNotMatch(ctl, /device-tier|glensfalls/);
  // desktop: no scale, no FOV hook
  const ents = () => ({ person: { chaseDistance: 4.3, chaseHeight: 1.95 }, car: { chaseDistance: 6.9, chaseHeight: 2.12 }, cyclist: { chaseDistance: 4.8, chaseHeight: 2.05 }, helicopter: { chaseDistance: 11.4, chaseHeight: 3.3 } });
  const desk = ents();
  applyChaseScale(desk, TIERS.desktop);
  assert.deepEqual(desk, ents());
  assert.equal(fovHookFor(TIERS.desktop), null);
  // mobile: 1.35 x distance, 1.2 x height (person 5.8, car 9.3, cyclist 6.5, helicopter 15.4 m)
  assert.equal(TIERS.mobile.chaseDistanceScale, 1.35);
  assert.equal(TIERS.mobile.chaseHeightScale, 1.2);
  const mob = ents();
  applyChaseScale(mob, TIERS.mobile);
  assert.deepEqual(Object.values(mob).map((e) => +e.chaseDistance.toFixed(2)), [5.8, 9.32, 6.48, 15.39]);
  assert.deepEqual(Object.values(mob).map((e) => +e.chaseHeight.toFixed(2)), [2.34, 2.54, 2.46, 3.96]);
  // portrait FOVs: chase 70, action 74, pov 80 below aspect 1; the presets' in landscape
  const hook = fovHookFor(TIERS.mobile);
  assert.deepEqual(['chase', 'action', 'pov'].map((id) => hook({ id }, 390 / 844)), [70, 74, 80]);
  assert.deepEqual(['chase', 'action', 'pov'].map((id) => hook({ id }, 844 / 390)), [null, null, null]);
  // ?camdist= overrides the distance scale (either tier); missing or invalid leaves the tier's
  const phone = { coarse: true, hover: false, screen: [390, 844] };
  assert.equal(detectDeviceTier(device({ ...phone, search: '?city=glensfalls&camdist=1.5' })).settings.chaseDistanceScale, 1.5);
  assert.equal(detectDeviceTier(device({ ...phone, search: '?camdist=1.2&tier=mobile' })).settings.chaseDistanceScale, 1.2);
  for (const bad of ['', 'x', '0', '-1', '9', 'NaN']) assert.equal(detectDeviceTier(device({ ...phone, search: `?camdist=${bad}` })).settings.chaseDistanceScale, 1.35, `camdist=${bad}`);
  assert.equal(detectDeviceTier(device({ ...phone })).settings, TIERS.mobile, 'no camdist: the tier itself');
  assert.equal(detectDeviceTier(device({ screen: [2560, 1440] })).settings, TIERS.desktop);
  assert.deepEqual(CAMDIST_RANGE, [0.5, 3]);
  // gf-main.js applies them before the camera exists, and only through the tier
  assert.match(read('js/gf-main.js'), /applyChaseScale\(controllerManager\.entities, TIER\);\n\s*const fovFor = fovHookFor\(TIER\);\n\s*const cameraSystem = new CameraSystem\(renderer\.domElement, controllerManager, fovFor \? \{ fovFor \} : \{\}\);/);
});

test('loading: a stage and an overall percent across the whole load, weighted, never backwards', () => {
  const p = createLoadingProgress();
  assert.equal(p.percent(), 0);
  assert.match(p.set('code', 0.5, 'Loading code 20 / 40'), /^Loading code 20 \/ 40… \d+%$/);
  const afterCode = p.percent();
  assert.ok(afterCode > 0 && afterCode < 15);
  // the terrain download is the long wait: a third of the bar
  const t0 = p.set('terrain', 0) && p.percent();
  p.set('terrain', 1);
  assert.ok(p.percent() - t0 >= 28, `${p.percent() - t0}% for the terrain`);
  // a late code report after the terrain began changes nothing
  const before = p.text();
  assert.equal(p.set('code', 1, 'Loading code 40 / 40'), before);
  // stages in order; each says its name and the overall percent
  let last = p.percent();
  for (const [id] of STAGES.slice(2)) {
    const text = p.set(id, 0.5);
    assert.match(text, /… \d+%$/);
    assert.ok(p.percent() >= last, id);
    last = p.percent();
  }
  assert.ok(last < 100);
  p.done();
  assert.equal(p.percent(), 100);
  // every gf-main.js stage message names its stage; compilation and the terrain report their fraction
  const main = read('js/gf-main.js');
  const ids = new Set(STAGES.map(([id]) => id));
  const calls = [...main.matchAll(/await showLoadingStage\((?:'[^']*'|`[^`]*`), '(\w+)'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 12);
  for (const id of calls) assert.ok(ids.has(id), id);
  assert.match(main, /progress\.set\('compile', done \/ jobs\.length/);
  assert.match(read('js/gf-terrain-data.js'), /progress\.set\('terrain', 0\.9 \* Math\.min\(1, got \/ total\)/);
  assert.match(read('js/main.js'), /set\('code', landed \/ links\.length/);
});
