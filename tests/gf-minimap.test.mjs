import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GF_GEO } from '../js/gf-geodata.js';
import { driveLinks } from '../js/gf-roadgraph.js';
import { GF_TRAILS } from '../js/gf-trails.js';
import { GF_LANDMARKS } from '../js/gf-landmarks.js';
import { TIERS } from '../js/device-tier.js';
import { createGfCredit, OSM_COPYRIGHT, SHORT_LABEL } from '../js/gf-credit.js';
import {
  installGfMinimap, buildRadarLayers, radarAngle, worldToRadar, northOnScreen, rimPoint, radarRange, cacheCovers,
  radarKey, isTyping, tracePolyline, traceRings, tileItems, tilesIn, compileLayers, placeCreditAbove, WATER_KINDS, TILE
} from '../js/gf-minimap.js';

// CC-MINIMAP: the Glens Falls street radar (js/gf-minimap.js): heading-up, from the repo's own geography, cheap on the
// mobile tier, opened with M or a tap; New York's map untouched

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const LINKS = driveLinks(GF_GEO);
const LAYERS = buildRadarLayers({ links: LINKS, geo: GF_GEO, trails: GF_TRAILS, landmarks: GF_LANDMARKS });

// ---- what is drawn ----

test('roads come from driveLinks(GF_GEO), point for point; nothing else is traced as a road', () => {
  const source = new Set(LINKS.map((l) => l.pts.flat().join(',')));
  let count = 0;
  for (const list of Object.values(LAYERS.roads)) {
    for (const road of list) {
      assert.ok(source.has(road.pts.join(',')), 'a radar road is a driveLinks polyline as it is');
      count++;
    }
  }
  assert.equal(count, LINKS.length, 'every drivable link, once');
  // the recorder sees only the source's vertices
  const seen = [];
  const rec = { moveTo: (x, z) => seen.push(x, z), lineTo: (x, z) => seen.push(x, z), closePath() {} };
  const sample = LAYERS.roads.primary[0];
  tracePolyline(rec, sample.pts);
  assert.deepEqual(seen, sample.pts);
});

test('water is GF_GEO.water (outer + holes, coordinates as they are) without the wastewater basins', () => {
  const kept = GF_GEO.water.filter((w) => WATER_KINDS.has(w.kind));
  assert.equal(LAYERS.water.length, kept.length);
  assert.ok(GF_GEO.water.some((w) => w.kind === 'wastewater') && !LAYERS.water.some((w) => w.kind === 'wastewater'));
  for (const [i, w] of kept.entries()) assert.deepEqual(LAYERS.water[i].rings, [w.outer, ...w.holes]);
  const names = new Set(LAYERS.water.map((w) => w.name));
  for (const n of ['Crandall Pond', 'Hovey Pond', 'Glens Falls Feeder Canal', 'Halfway Brook Reservoir']) assert.ok(names.has(n), n);
  // traced rings close and keep every vertex
  const seen = [];
  let closes = 0;
  const rec = { moveTo: (x, z) => seen.push(x, z), lineTo: (x, z) => seen.push(x, z), closePath: () => closes++ };
  traceRings(rec, LAYERS.water[0].rings);
  assert.deepEqual(seen, LAYERS.water[0].rings.flat());
  assert.equal(closes, LAYERS.water[0].rings.length);
});

test('land is the blocks\' lots; trails are GF_TRAILS edges; the only dots are positions already in the repo', () => {
  const ringOf = (b) => (b.lot && b.lot.length >= 6 ? b.lot : b.curb);
  const withRing = GF_GEO.blocks.filter((b) => ringOf(b) && ringOf(b).length >= 6);
  assert.ok(withRing.length > 300);
  assert.equal(LAYERS.lots.length, withRing.length);
  for (const [i, b] of withRing.entries()) assert.equal(LAYERS.lots[i].rings[0], ringOf(b), 'the block\'s own ring');
  assert.equal(LAYERS.trails.length, GF_TRAILS.edges.length);
  for (const [i, e] of GF_TRAILS.edges.entries()) assert.equal(LAYERS.trails[i].pts, e.pts);
  assert.deepEqual(LAYERS.dots.map((d) => d.id), ['thrill-hill', 'civil-war-monument']);
  assert.deepEqual([LAYERS.dots[0].x, LAYERS.dots[0].z], [GF_TRAILS.hill.crestX, GF_TRAILS.hill.crestZ]);
  assert.deepEqual([LAYERS.dots[0].x, LAYERS.dots[0].z], [-2534.55, -1272.39]);
  const monument = GF_LANDMARKS.features.find((f) => f.id === 'civil-war-monument');
  assert.deepEqual([LAYERS.dots[1].x, LAYERS.dots[1].z], [monument.x, monument.z]);
  // no Buckley Tire, no parks: GF_GEO has no park polygons and the module names none
  const src = read('js/gf-minimap.js');
  assert.doesNotMatch(src, /buckley\s*tire\b.*[-\d]+\.\d+/i);
  assert.ok(!('parks' in GF_GEO) && !('landuse' in GF_GEO));
});

test('the Path2D cache: bucketed in tiles, each polyline in every tile its box touches; a window lists its tiles', () => {
  const items = [{ pts: [10, 10, 20, 20] }, { pts: [-10, 390, 410, 410] }];
  const tiles = tileItems(items, (i) => i.pts);
  assert.deepEqual([...tiles.keys()].sort(), ['-1,0', '-1,1', '0,0', '0,1', '1,0', '1,1'].sort());
  assert.deepEqual(tiles.get('0,0'), items);
  assert.deepEqual(tilesIn(-1, -1, TILE + 1, 1), ['-1,-1', '-1,0', '0,-1', '0,0', '1,-1', '1,0']);
  // without Path2D (Node), nothing is compiled; with one, each layer has its tiles
  assert.equal(compileLayers(LAYERS, undefined), null);
  class FakePath { constructor() { this.n = 0; } moveTo() { this.n++; } lineTo() { this.n++; } closePath() {} }
  const compiled = compileLayers(LAYERS, FakePath);
  assert.ok(compiled.lots.tiles.size > 10 && compiled.water.tiles.size > 0 && compiled.trails.tiles.size > 0);
  // a river or a long road: one Path2D of its own, not one copy per tile it crosses
  assert.ok(compiled.water.big.length > 0 && compiled.water.big.every((b) => b.box[2] - b.box[0] > TILE || b.box[3] - b.box[1] > TILE));
  const bigCompiled = compileLayers({ roads: {}, lots: [], trails: [], water: [{ rings: [[0, 0, 2000, 0, 2000, 10, 0, 10]] }] }, FakePath);
  assert.equal(bigCompiled.water.tiles.size, 0);
  assert.equal(bigCompiled.water.big.length, 1);
  assert.deepEqual(bigCompiled.water.big[0].box, [0, 0, 2000, 10]);
  assert.deepEqual(compiled.roads.map((r) => r.key).slice(-2).every((k) => /motorway|trunk/.test(k)), true, 'motorways drawn last');
});

// ---- heading-up ----

test('the radar turns with the heading: the player\'s forward is always up; heading 0 faces south (+z)', () => {
  for (const h of [0, 0.3, Math.PI / 2, 2, Math.PI, -1.1, 5.5]) {
    // a point 10 m ahead of the player (forward = (sin h, cos h)) is straight up the radar
    const [x, y] = worldToRadar(100 + 10 * Math.sin(h), 50 + 10 * Math.cos(h), 100, 50, h, 2);
    assert.ok(close(x, 0, 1e-9) && close(y, -20, 1e-9), `heading ${h}: ahead is up`);
    // and a point to the player's right (forward turned clockwise seen from above: (-cos h, sin h) in x/z) is right
    const [rx, ry] = worldToRadar(100 - 10 * Math.cos(h), 50 + 10 * Math.sin(h), 100, 50, h, 1);
    assert.ok(close(rx, 10, 1e-9) && close(ry, 0, 1e-9), `heading ${h}: right is right`);
  }
  // heading 0 faces south: south is up, so north (-z) is down and east (+x) on the left
  assert.deepEqual(worldToRadar(0, 10, 0, 0, 0, 1).map((v) => Math.round(v) + 0), [0, -10]);
  assert.deepEqual(northOnScreen(0).map((v) => Math.round(v) + 0), [0, 1]);
  assert.deepEqual(worldToRadar(10, 0, 0, 0, 0, 1).map((v) => Math.round(v) + 0), [-10, 0]);
  // heading PI faces north: north up, east right (the usual map)
  assert.deepEqual(northOnScreen(Math.PI).map((v) => Math.round(v) + 0), [0, -1]);
  assert.deepEqual(worldToRadar(10, 0, 0, 0, Math.PI, 1).map((v) => Math.round(v) + 0), [10, 0]);
  // facing east (heading PI/2): north is on the left
  assert.deepEqual(northOnScreen(Math.PI / 2).map((v) => Math.round(v) + 0), [-1, 0]);
  assert.equal(radarAngle(0), Math.PI);
});

test('the N pip and off-radar markers sit on the rim; the zoom widens with speed and height', () => {
  assert.deepEqual(rimPoint(0, 1, 200, 100, 10), [0, 40]);
  assert.deepEqual(rimPoint(1, 0, 200, 100, 10), [90, 0]);
  const [x, y] = rimPoint(1, 1, 200, 100, 10);
  assert.ok(close(y, 40) && close(x, 40));
  assert.equal(radarRange(0, 0), 110);
  assert.ok(radarRange(36, 0) > 250 && radarRange(36, 0) < 270, 'the car at top speed sees ~260 m');
  assert.ok(radarRange(10, 200) > radarRange(10, 0), 'the helicopter higher sees further');
  assert.equal(radarRange(500, 5000), 900, 'capped');
  assert.equal(radarRange(NaN, NaN), 110);
});

test('the cache is redrawn when the player nears its edge or the zoom drifts, not every frame', () => {
  const cache = { drawn: true, cx: 0, cz: 0, scale: 1, halfW: 300, halfH: 300 };
  assert.equal(cacheCovers(cache, 0, 0, 1, 170), true);
  assert.equal(cacheCovers(cache, 120, 0, 1, 170), true);
  assert.equal(cacheCovers(cache, 130, 0, 1, 170), false, 'near the edge');
  assert.equal(cacheCovers(cache, 0, 0, 1.2, 170), false, 'zoomed in 20 %');
  assert.equal(cacheCovers(cache, 0, 0, 0.9, 170), true, 'zoom within 15 %, the view still inside');
  assert.equal(cacheCovers(null, 0, 0, 1, 170), false);
});

// ---- controls ----

const key = (code, extra = {}) => ({ code, target: { tagName: 'CANVAS' }, ...extra });

test('M toggles, Esc closes; not while typing in a field, not with a modifier, not on key repeat', () => {
  assert.equal(radarKey(key('KeyM'), false), 'toggle');
  assert.equal(radarKey(key('KeyM'), true), 'toggle');
  assert.equal(radarKey(key('Escape'), true), 'close');
  assert.equal(radarKey(key('Escape'), false), null);
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) assert.equal(radarKey(key('KeyM', { target: { tagName } }), false), null, tagName);
  assert.equal(radarKey(key('KeyM', { target: { tagName: 'DIV', isContentEditable: true } }), false), null);
  assert.equal(radarKey(key('KeyM', { repeat: true }), false), null);
  assert.equal(radarKey(key('KeyM', { metaKey: true }), false), null);
  assert.equal(radarKey(key('KeyM', { defaultPrevented: true }), false), null);
  assert.equal(isTyping({ target: null }), false);
  for (const code of ['Digit1', 'KeyW', 'KeyF', 'KeyT', 'KeyV', 'KeyH']) assert.equal(radarKey(key(code), false), null, code);
});

// a small fake DOM: enough for installGfMinimap
function fakeDom() {
  const listeners = new Map();
  const on = (target) => {
    target.listeners = {};
    target.addEventListener = (type, fn) => { (target.listeners[type] = target.listeners[type] || []).push(fn); };
    target.fire = (type, e = {}) => { for (const fn of target.listeners[type] || []) fn({ preventDefault() {}, ...e }); };
    return target;
  };
  const el = (tag) => on({
    tagName: tag.toUpperCase(), attrs: {}, children: [], hidden: false, style: {}, className: '', textContent: '',
    classList: { set: new Set(), add(c) { this.set.add(c); }, toggle(c, v) { if (v) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); },
    querySelector: () => null, getContext: () => ({}), clientWidth: 0, clientHeight: 0, offsetParent: null
  });
  const card = el('aside');
  const north = el('span');
  card.querySelector = (s) => (s === '.radar-north' ? north : null);
  const canvas = el('canvas');
  const win = on({ devicePixelRatio: 3, innerHeight: 800 });
  const doc = {
    head: el('head'), body: el('body'), defaultView: win,
    getElementById: (id) => ({ 'minimap-card': card, 'minimap-canvas': canvas })[id] || null,
    querySelector: () => null, createElement: el
  };
  return { doc, win, card, canvas, north, listeners };
}
const player = { getActiveEntity: () => ({ position: { x: 0, y: 0, z: 0 }, heading: 0 }) };

test('the radar card opens and closes the larger view: M, a click or tap, Enter; M ignored in a field', () => {
  const { doc, win, card, north } = fakeDom();
  const radar = installGfMinimap({ doc, controllerManager: player, layers: LAYERS, tier: 'desktop' });
  assert.ok(radar);
  assert.equal(north.style.display, 'none', 'the static N gives way to the travelling pip');
  assert.equal(card.getAttribute('role'), 'button');
  const overlay = doc.body.children.find((c) => c.attrs && c.className === 'gf-radar-expanded');
  assert.ok(overlay && overlay.hidden, 'the GF-owned larger view, closed');
  assert.ok(doc.head.children.some((c) => c.href === 'css/gf-minimap.css'));
  win.fire('keydown', key('KeyM'));
  assert.equal(radar.expanded, true);
  assert.equal(overlay.hidden, false);
  assert.equal(card.getAttribute('aria-expanded'), 'true');
  win.fire('keydown', key('Escape'));
  assert.equal(radar.expanded, false);
  card.fire('click');
  assert.equal(radar.expanded, true, 'a click or tap on the card opens it');
  card.fire('click');
  assert.equal(radar.expanded, false, 'and again closes it');
  card.fire('click');
  overlay.fire('click');
  assert.equal(radar.expanded, false, 'a tap on the larger view closes it');
  win.fire('keydown', key('KeyM', { target: { tagName: 'INPUT' } }));
  assert.equal(radar.expanded, false, 'typing M in a field');
  card.fire('keydown', { code: 'Enter' });
  assert.equal(radar.expanded, true);
  // H (clean view) closes it with the rest of the HUD
  doc.body.classList.add('hud-minimized');
  radar.update(0.016);
  assert.equal(radar.expanded, false);
  // the marker hook (a later mission icon): an id and a position, nothing placed by default
  assert.equal(radar.setMarker('later', { x: 1, z: 2 }), true);
  assert.equal(radar.setMarker('bad', { x: NaN, z: 2 }), false);
  assert.equal(radar.removeMarker('later'), true);
});

test('the mobile tier: backing store at DPR 1, no traffic; desktop up to DPR 2', () => {
  const src = read('js/gf-minimap.js');
  assert.match(src, /const dprOf = \(\) => \(mobile \? 1 : Math\.min\(win\.devicePixelRatio \|\| 1, 2\)\)/);
  assert.match(src, /cars: !mobile && cars \? cars : null/);
  assert.match(src, /if \(mobile && since < MOBILE_INTERVAL\) return;/);
  // the tiers are untouched: no radar knob in device-tier.js, desktop as before
  assert.doesNotMatch(read('js/device-tier.js'), /radar|minimap/i);
  assert.equal(TIERS.desktop.pixelRatio, 1);
  assert.equal(TIERS.mobile.lampPool, 12);
});

test('canvas 2D only: no second renderer, scene or render target; nyc-map.js not imported or preloaded', () => {
  const src = read('js/gf-minimap.js');
  assert.doesNotMatch(src, /WebGPURenderer|WebGLRenderer|RenderTarget|new\s+\w*Scene\b|from ['"]three|import\s/);
  assert.match(src, /getContext\('2d'\)/);
  const gfMain = read('js/gf-main.js');
  assert.equal((gfMain.match(/new THREE\.WebGPURenderer/g) || []).length, 1, 'one renderer, on every tier');
  assert.doesNotMatch(gfMain, /nyc-map/);
  const main = read('js/main.js');
  const gfPre = main.slice(main.indexOf('GF_PRELOADS'), main.indexOf('];', main.indexOf('GF_PRELOADS')));
  assert.match(gfPre, /'gf-minimap\.js'/);
  assert.doesNotMatch(gfPre, /nyc-map/);
  const nycPre = main.slice(main.indexOf('NYC_PRELOADS'), main.indexOf('];', main.indexOf('NYC_PRELOADS')));
  assert.doesNotMatch(nycPre, /gf-minimap/);
  assert.doesNotMatch(read('js/nyc-main.js'), /gf-minimap/);
  // no city branches in what the radar touches; New York's map is unchanged
  for (const f of ['js/gf-minimap.js', 'js/touch-controls.js', 'js/cameras.js', 'js/controllers.js']) {
    assert.doesNotMatch(read(f), /city\s*===|glensfalls'/i, f);
  }
  assert.match(read('index.html'), /<aside id="minimap-card" class="panel radar" aria-label="Live NYC Street Radar Minimap"/);
});

test('gf-main.js: the card is no longer hidden, its label is true, the radar runs each frame, the credit moves off it', () => {
  const gfMain = read('js/gf-main.js');
  const hideList = gfMain.match(/for \(const id of \[([^\]]*)\]\) \{\s*hide/)[1];
  assert.doesNotMatch(hideList, /minimap-card/);
  for (const id of ['btn-teleport', 'btn-sound', 'hud-location', 'teleport-popover', 'fullmap-modal']) assert.match(hideList, new RegExp(`'${id}'`));
  assert.match(gfMain, /set\('#minimap-card', \{ 'aria-label': 'Street radar \[M\]', title: 'Street radar \[M\]' \}\)/);
  assert.match(gfMain, /if \(radar\) radar\.update\(dt\);/);
  assert.match(gfMain, /tier: DEVICE\.tier/);
  assert.match(gfMain, /placeCreditAbove\(document\.getElementById\('gf-attribution'\)/);
  // the credit (js/gf-credit.js) keeps the LiDAR line
  assert.match(gfMain, /createGfCredit\(document, \{ lidar: GF_LIDAR_HEIGHTS\.credit/);
  // placed just above the card (desktop)
  const credit = { style: {} };
  placeCreditAbove(credit, { offsetParent: {}, getBoundingClientRect: () => ({ top: 600, left: 20, height: 184 }) }, { innerHeight: 800 });
  assert.equal(credit.style.bottom, '206px');
  assert.equal(credit.style.left, '20px');
  placeCreditAbove(credit, { offsetParent: null, getBoundingClientRect: () => ({}) }, { innerHeight: 800 });
  assert.equal(credit.style.bottom, '6px', 'back to the corner when the card is hidden');
  // touch screens: desktop-only; the inline offsets are cleared and css/gf-mobile.css places the label
  const touchWin = { innerHeight: 800, document: { body: { classList: { contains: (c) => c === 'touch-enabled' } } } };
  placeCreditAbove(credit, { offsetParent: {}, getBoundingClientRect: () => ({ top: 600, left: 20, height: 184 }) }, touchWin);
  assert.equal(credit.style.bottom, '');
  assert.equal(credit.style.left, '');
});

// ---- touch screens ----

const cssRules = (file) => {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  // top-level rules and the rules inside each @media block, with the media query they sit in
  const re = /@media([^{]+)\{((?:[^{}]*\{[^{}]*\})*)\s*\}|([^{}@]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1]) {
      const inner = /([^{}]+)\{([^{}]*)\}/g;
      let r;
      while ((r = inner.exec(m[2]))) rules.push({ media: m[1].trim(), selectors: r[1].trim().split(',').map((x) => x.trim()), body: r[2] });
    } else rules.push({ media: null, selectors: m[3].trim().split(',').map((x) => x.trim()), body: m[4] });
  }
  return rules;
};

const calcPlus = (body, prop) => {
  const m = body.match(new RegExp(`(^|[;\\s])${prop}:\\s*calc\\([^;]*\\+\\s*(\\d+)px\\)`));
  return m ? Number(m[2]) : null;
};

test('touch screens: the GF radar is shown (style.css hides it for New York), small, in the top-left corner, also in landscape', () => {
  const rules = cssRules('css/gf-mobile.css');
  const card = rules.find((r) => !r.media && r.selectors.includes('body.touch-enabled #minimap-card'));
  assert.ok(card, 'a touch rule for the card');
  assert.match(card.body, /display:\s*block/);
  assert.match(card.body, /width:\s*80px/);
  assert.match(card.body, /height:\s*80px/);
  assert.match(card.body, /touch-action:\s*manipulation/);
  // its box (the lower-left HUD, holding only the card in GF) moves to the top-left corner: not the old +254 px slot
  const hud = rules.find((r) => !r.media && r.selectors.includes('body.touch-enabled .hud-bottom-left'));
  assert.match(hud.body, /top:\s*max\(var\(--edge, 12px\), env\(safe-area-inset-top\)\)/);
  assert.match(hud.body, /bottom:\s*auto/);
  assert.match(hud.body, /left:\s*max\(var\(--edge, 12px\), env\(safe-area-inset-left\)\)/);
  assert.match(read('js/gf-main.js'), /'hud-location'/, 'the box holds only the card: the street sign stays hidden');
  // the shared rules New York relies on are still there, untouched
  const style = read('css/style.css');
  assert.match(style, /body\.touch-enabled \.radar,/);
  assert.match(style, /@media \(max-height: 500px\) \{\s*body\.touch-enabled \.hud-bottom-left \{ display: none; \}/);
  assert.match(style, /body\.touch-enabled \.hud-bottom-left \{[^}]*bottom: calc\(max\(var\(--edge\), env\(safe-area-inset-bottom\)\) \+ 254px\)/);
  // landscape: style.css hides the lower-left box; GF shows it again, still in the top-left, and a 72 px card
  const land = rules.filter((r) => r.media && /max-height:\s*500px/.test(r.media));
  const landHud = land.find((r) => r.selectors.includes('body.touch-enabled .hud-bottom-left'));
  assert.ok(landHud && /display:\s*flex/.test(landHud.body), 'landscape keeps the radar');
  assert.match(landHud.body, /top:\s*max\(var\(--edge, 12px\), env\(safe-area-inset-top\)\)/);
  assert.match(landHud.body, /bottom:\s*auto/);
  const landCard = land.find((r) => r.selectors.includes('body.touch-enabled #minimap-card'));
  assert.match(landCard.body, /width:\s*72px/);
  assert.match(landCard.body, /height:\s*72px/);
  // the larger view: portrait below the camera switch (top + 62 + 54 px) and the 80 px radar, above the stick
  const big = rules.find((r) => !r.media && r.selectors.includes('body.touch-enabled #gf-radar-expanded'));
  assert.equal(calcPlus(big.body, 'top'), 122);
  assert.ok(calcPlus(big.body, 'top') > 80 + 8 && calcPlus(big.body, 'top') >= 62 + 54 + 6);
  assert.equal(calcPlus(big.body, 'bottom'), 254);
  const narrow = rules.find((r) => r.media && /max-width:\s*360px/.test(r.media) && r.selectors.includes('body.touch-enabled #gf-radar-expanded'));
  assert.equal(calcPlus(narrow.body, 'top'), 176, 'a wrapped toolbar drops the camera switch to + 114 px');
  // landscape: right of the stick (and the 72 px radar), left of the right-hand column, above the credit and mode bar
  const landBig = land.find((r) => r.selectors.includes('body.touch-enabled #gf-radar-expanded'));
  assert.equal(calcPlus(landBig.body, 'left'), 148);
  assert.equal(calcPlus(landBig.body, 'top'), 54);
  assert.equal(calcPlus(landBig.body, 'bottom'), 92);
  // every gf-mobile.css selector is still under body.touch-enabled or the Exit button
  for (const r of rules) for (const sel of r.selectors) assert.match(sel, /exit-action|body\.touch-enabled/, sel);
  // the radar's own stylesheet is GF-only and loaded by gf-minimap.js
  assert.ok(fs.existsSync(path.join(root, 'css/gf-minimap.css')));
  assert.doesNotMatch(read('index.html'), /gf-minimap|gf-mobile|gf-credit/);
});

test('touch screens: the credit is a one-line label beside the stick, above the mode bar; its full text opens above the stick', () => {
  const rules = cssRules('css/gf-mobile.css');
  const label = rules.find((r) => !r.media && r.selectors.includes('body.touch-enabled #gf-attribution'));
  assert.ok(label, 'a touch rule for the credit');
  assert.doesNotMatch(label.body, /display:\s*none|visibility:\s*hidden|opacity:\s*0[;\s]/, 'never hidden');
  assert.match(label.body, /top:\s*auto/);
  assert.equal(calcPlus(label.body, 'left'), 144, '8 px right of the 136 px stick');
  assert.equal(calcPlus(label.body, 'bottom'), 66, 'just above the 60 px mode bar');
  assert.match(label.body, /z-index:\s*11/, 'under the touch controls (12)');
  const full = rules.find((r) => !r.media && r.selectors.includes('body.touch-enabled #gf-credit-full'));
  assert.match(full.body, /position:\s*fixed/);
  assert.equal(calcPlus(full.body, 'bottom'), 254, 'portrait: in the free space above the stick');
  const landFull = rules.find((r) => r.media && /max-height:\s*500px/.test(r.media) && r.selectors.includes('body.touch-enabled #gf-credit-full'));
  assert.equal(calcPlus(landFull.body, 'left'), 144);
  assert.equal(calcPlus(landFull.body, 'bottom'), 92, 'landscape: right of the stick, above the mode bar');
});

test('touch: the radar never takes the stick\'s or the action buttons\' touches', () => {
  // the radar listens on its own card and overlay only (a click), never on the document's pointer / touch events
  const src = read('js/gf-minimap.js');
  assert.doesNotMatch(src, /pointerdown|touchstart|setPointerCapture/);
  assert.doesNotMatch(src, /doc\.addEventListener|document\.addEventListener/);
  // and the iOS callout guard covers the card (a .hud child) on touch screens
  const guard = cssRules('css/gf-mobile.css').find((r) => r.selectors.includes('body.touch-enabled .hud *'));
  assert.ok(guard && /-webkit-touch-callout:\s*none/.test(guard.body));
});

// ---- the map credit (CC-MINIMAP-fix) ----

function creditDom() {
  const on = (t) => {
    t.listeners = {};
    t.addEventListener = (type, fn, opts) => { (t.listeners[type] = t.listeners[type] || []).push({ fn, opts }); };
    t.fire = (type, e = {}) => { for (const { fn } of t.listeners[type] || []) fn({ preventDefault() { e.prevented = true; }, ...e }); return e; };
    return t;
  };
  const el = (tag) => on({
    tagName: tag.toUpperCase(), children: [], attrs: {}, hidden: false, style: {},
    classList: { set: new Set(), toggle(c, v) { if (v) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); },
    contains(n) { return n === this || this.children.some((c) => c && typeof c.contains === 'function' && c.contains(n)); },
    get text() { return this.children.length ? this.children.map((c) => (typeof c === 'string' ? c : c.text)).join('') : (this.textContent || ''); }
  });
  const win = on({});
  const doc = on({ head: el('head'), body: el('body'), defaultView: win, createElement: el, querySelector: () => null });
  return { doc, win };
}

test('the credit: "© OSM · USGS" on screen; a tap opens the OSM copyright link and the USGS line; tap, outside or Esc closes', () => {
  const { doc, win } = creditDom();
  const lidar = 'Building heights and trees: USGS 3D Elevation Program (3DEP), NY_Hudson_D22 LiDAR, 2022-23';
  const c = createGfCredit(doc, { lidar });
  const [full, toggle] = c.element.children;
  assert.equal(c.element.attrs.id ?? c.element.id, 'gf-attribution');
  assert.equal(SHORT_LABEL, '© OSM · USGS');
  assert.equal(toggle.textContent, '© OSM · USGS');
  assert.equal(toggle.tagName, 'BUTTON', 'Enter / Space open it from the keyboard');
  assert.equal(toggle.type, 'button');
  assert.equal(full.hidden, true, 'collapsed by default');
  assert.ok(doc.head.children.some((l) => l.href === 'css/gf-credit.css'));
  // the full credit: the OSM copyright page (ODbL) and the LiDAR line
  const link = full.children.find((n) => n.tagName === 'A');
  assert.equal(link.href, OSM_COPYRIGHT);
  assert.equal(OSM_COPYRIGHT, 'https://www.openstreetmap.org/copyright');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener');
  assert.match(full.text, /Map data © OpenStreetMap contributors \(ODbL\)/);
  assert.ok(full.children.includes(lidar));
  // tap opens, tap closes
  toggle.fire('click');
  assert.equal(c.isOpen, true);
  assert.equal(full.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.fire('click');
  assert.equal(c.isOpen, false);
  // a tap elsewhere closes it, without cancelling that touch; a tap inside does not
  c.open();
  const inside = doc.fire('pointerdown', { target: link });
  assert.equal(c.isOpen, true);
  const outside = doc.fire('pointerdown', { target: { tagName: 'CANVAS' } });
  assert.equal(c.isOpen, false);
  assert.ok(!inside.prevented && !outside.prevented, 'the touch still goes to the stick / buttons');
  assert.deepEqual(doc.listeners.pointerdown[0].opts, { capture: true, passive: true });
  // Esc closes it
  c.open();
  win.fire('keydown', { code: 'Escape' });
  assert.equal(c.isOpen, false);
  win.fire('keydown', { code: 'KeyM' });
  assert.equal(c.isOpen, false, 'M is the radar\'s, not the credit\'s');
});

test('the credit module: Glens Falls only, preloaded, made by gf-main.js; desktop label above the radar', () => {
  const main = read('js/main.js');
  const gfPre = main.slice(main.indexOf('GF_PRELOADS'), main.indexOf('];', main.indexOf('GF_PRELOADS')));
  assert.match(gfPre, /'gf-credit\.js'/);
  const nycPre = main.slice(main.indexOf('NYC_PRELOADS'), main.indexOf('];', main.indexOf('NYC_PRELOADS')));
  assert.doesNotMatch(nycPre, /gf-credit/);
  assert.doesNotMatch(read('js/nyc-main.js'), /gf-credit/);
  assert.match(read('js/gf-main.js'), /document\.body\.appendChild\(credit\.element\)/);
  const css = read('css/gf-credit.css');
  assert.match(css, /\.gf-credit-full\[hidden\] \{ display: none; \}/);
  assert.doesNotMatch(read('js/gf-credit.js'), /city\s*===|glensfalls'/);
});
