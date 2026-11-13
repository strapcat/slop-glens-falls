import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectDeviceTier, TIERS, SMALL_SCREEN, HANDHELD_QUERY } from '../js/device-tier.js';
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
  assert.deepEqual(d, { pixelRatio: 1, antialias: true, ssr: true, shadowMapSize: null, treeMaxDist: null, sidewalkRange: 650, lampPool: 32, lampPoolRange: 160, compilePool: 16 });
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
