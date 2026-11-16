// CC-MINIMAP (Glens Falls only): a GTA-style street radar in the lower-left corner. The map turns with the player
// (heading-up): the player's arrow stays in the middle pointing up, and a small "N" pip travels round the rim. It draws
// only geography the repo already has: the drivable roads (driveLinks(GF_GEO), the same graph the cars drive), the
// water (GF_GEO.water, without the wastewater basins), the blocks' lots as land (GF_GEO.blocks), the park trails
// (GF_TRAILS) and two dots at positions already in the repo (the Thrill Hill crest, GF_TRAILS.hill, and the Civil War
// Monument, GF_LANDMARKS). No street, park or pin is made up; there are no park fills because GF_GEO has no park polygons.
//
// Cheap: canvas 2D only (no second renderer, scene or render target). The static layers are traced once into Path2D
// objects, bucketed in TILE m tiles, and drawn into an offscreen, north-up cache canvas round the player; each frame
// only blits that cache, rotated, and draws the arrow, the N pip and (desktop) the traffic. The cache is redrawn when
// the zoom drifts or the player nears its edge (the same idea as nyc-map.js's miniCache; nyc-map.js is not imported).
// The mobile tier backs the canvas at DPR 1, draws at most 30 times a second and skips the traffic.
//
// Controls: M (desktop) or a tap / click on the radar opens a larger view of the same radar; M, Esc, the close button
// or a tap on it closes it. The larger view sits in the upper part of the screen, so the joystick and the action
// buttons stay free. H (clean view) hides the radar with the rest of the HUD.
//
// Frame: 1 unit = 1 m, x = east, z = south (north = -z). A heading h faces (sin h, cos h): heading 0 faces south (+z).

const TILE = 400; // m: the Path2D buckets
const MOBILE_INTERVAL = 1 / 30; // s between radar draws on the mobile tier

// What the radar may draw: driveLinks highway classes by weight (the rest are drawn as minor roads)
const ROAD_STYLE = {
  motorway: { color: '#f0c46a', min: 2.6, order: 3 },
  motorway_link: { color: '#f0c46a', min: 1.8, order: 3 },
  trunk: { color: '#f0c46a', min: 2.4, order: 3 },
  trunk_link: { color: '#f0c46a', min: 1.8, order: 3 },
  primary: { color: '#eef2f6', min: 2.4, order: 2 },
  primary_link: { color: '#eef2f6', min: 1.8, order: 2 },
  secondary: { color: '#e2e7ec', min: 2.2, order: 2 },
  secondary_link: { color: '#e2e7ec', min: 1.6, order: 2 },
  tertiary: { color: '#c3ccd5', min: 1.9, order: 1 },
  tertiary_link: { color: '#c3ccd5', min: 1.5, order: 1 },
  minor: { color: '#8e9aa6', min: 1.3, order: 0 }
};
const COLORS = {
  land: '#1d252d', // outside the blocks (and beyond the data)
  lot: '#2f3c49', // GF_GEO.blocks lots
  water: '#3f78a8',
  trail: '#86b673',
  arrow: '#ffffff',
  halo: 'rgba(8, 11, 15, 0.9)'
};
// Water kinds drawn: everything in GF_GEO.water but the sewage plant's wastewater basins
const WATER_KINDS = new Set(['river', 'canal', 'pond', 'reservoir', 'water']);

// --- Geometry (no DOM: tests) ------------------------------------------------------------------------------------

// The canvas rotation that turns the world, north-up as drawn (x right, z down), so the player's heading points up:
// R(a) maps the forward (sin h, cos h) to (0, -1) for a = PI + h.
function radarAngle(heading) {
  return Math.PI + heading;
}

// A world point relative to the player, in radar pixels from the centre (x right, y down), at scale px per metre
function worldToRadar(x, z, px, pz, heading, scale) {
  const a = radarAngle(heading), c = Math.cos(a), s = Math.sin(a);
  const dx = (x - px) * scale, dz = (z - pz) * scale;
  return [dx * c - dz * s, dx * s + dz * c];
}

// Unit vector, on screen, from the centre towards north (-z)
function northOnScreen(heading) {
  const [x, y] = worldToRadar(0, -1, 0, 0, heading, 1);
  return [x, y];
}

// Where a direction from the centre meets a w x h box inset by `inset` px (relative to the centre)
function rimPoint(dx, dy, w, h, inset) {
  const hx = Math.max(1, w / 2 - inset), hy = Math.max(1, h / 2 - inset);
  const t = Math.min(dx ? hx / Math.abs(dx) : Infinity, dy ? hy / Math.abs(dy) : Infinity);
  return [dx * t, dy * t];
}

// Metres from the centre to the radar's nearer edge: 110 m on foot, out to ~260 m at the car's top speed, and further
// with the helicopter's height above the ground
function radarRange(speed, above) {
  const s = Math.max(0, Number.isFinite(speed) ? Math.abs(speed) : 0);
  const a = Math.max(0, Number.isFinite(above) ? above - 15 : 0);
  return Math.min(900, 110 + 4.2 * s + 1.1 * a);
}

// Does the cache (a north-up window round cx, cz: halfW x halfH m, drawn at scale cs) still cover a view of radius
// `radius` px round (px, pz) at `scale`? Redraw when it does not, or when the zoom drifted more than 15 %.
function cacheCovers(cache, px, pz, scale, radius) {
  if (!cache || !cache.drawn) return false;
  if (Math.abs(scale / cache.scale - 1) > 0.15) return false;
  const r = radius / scale + 4 / scale;
  return Math.abs(px - cache.cx) + r <= cache.halfW && Math.abs(pz - cache.cz) + r <= cache.halfH;
}

// The typing check for M (a field, a select, a text area or an editable element keeps its keys)
function isTyping(e) {
  const t = e && e.target;
  if (!t) return false;
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

// The radar's key handling: 'toggle' for M, 'close' for Esc while open, else null
function radarKey(e, expanded) {
  if (!e || e.defaultPrevented || isTyping(e)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.code === 'KeyM' && !e.repeat) return 'toggle';
  if (e.code === 'Escape' && expanded) return 'close';
  return null;
}

// --- Layers (no DOM: tests) --------------------------------------------------------------------------------------

const flatOf = (pts) => pts.flat();

// The radar's static layers from the repo's data, as flat [x0, z0, x1, z1, ...] arrays (the source coordinates as
// they are): roads by style key, water polygons (outer + holes), block lots, trail lines, and the dots.
//   links     driveLinks(GF_GEO)
//   geo       GF_GEO (water, blocks)
//   trails    GF_TRAILS (edges, hill), optional
//   landmarks GF_LANDMARKS (features), optional
function buildRadarLayers({ links = [], geo = {}, trails = null, landmarks = null } = {}) {
  const roads = {};
  for (const link of links) {
    const key = ROAD_STYLE[link.highway] ? link.highway : 'minor';
    (roads[key] = roads[key] || []).push({ pts: flatOf(link.pts), width: Number.isFinite(link.width) ? link.width : 6 });
  }
  const water = [];
  for (const w of geo.water || []) {
    if (!WATER_KINDS.has(w.kind)) continue;
    water.push({ rings: [w.outer, ...(w.holes || [])], kind: w.kind, name: w.name || '' });
  }
  const lots = [];
  for (const b of geo.blocks || []) {
    const ring = b.lot && b.lot.length >= 6 ? b.lot : b.curb;
    if (ring && ring.length >= 6) lots.push({ rings: [ring, ...((b.lot && b.lot.length >= 6 ? b.lotHoles : b.curbHoles) || [])] });
  }
  const trailLines = [];
  for (const e of (trails && trails.edges) || []) {
    if (e.pts && e.pts.length >= 4) trailLines.push({ pts: e.pts, kind: e.kind });
  }
  return { roads, water, lots, trails: trailLines, dots: radarDots(trails, landmarks) };
}

// The landmark dots, only where the repo already has a position: the Thrill Hill crest and the Civil War Monument
function radarDots(trails, landmarks) {
  const dots = [];
  const hill = trails && trails.hill;
  if (hill && Number.isFinite(hill.crestX) && Number.isFinite(hill.crestZ)) {
    dots.push({ id: 'thrill-hill', label: 'Thrill Hill', x: hill.crestX, z: hill.crestZ, color: '#8fd06e' });
  }
  const monument = landmarks && (landmarks.features || []).find((f) => f.id === 'civil-war-monument');
  if (monument && Number.isFinite(monument.x) && Number.isFinite(monument.z)) {
    dots.push({ id: 'civil-war-monument', label: 'Civil War Monument', x: monument.x, z: monument.z, color: '#ffffff' });
  }
  return dots;
}

// Trace flat rings / lines into a path-like target (a Path2D, a canvas context, or a test recorder)
function tracePolyline(target, pts) {
  target.moveTo(pts[0], pts[1]);
  for (let k = 2; k < pts.length; k += 2) target.lineTo(pts[k], pts[k + 1]);
}
function traceRings(target, rings) {
  for (const ring of rings) {
    if (!ring || ring.length < 6) continue;
    tracePolyline(target, ring);
    target.closePath();
  }
}

function bboxOf(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < pts.length; k += 2) {
    const x = pts[k], z = pts[k + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return [x0, z0, x1, z1];
}

// Bucket items into TILE m tiles by their bbox: Map 'i,j' -> items (an item may sit in several tiles)
function tileItems(items, ptsOf) {
  const tiles = new Map();
  for (const item of items) {
    const [x0, z0, x1, z1] = bboxOf(ptsOf(item));
    for (let i = Math.floor(x0 / TILE); i <= Math.floor(x1 / TILE); i++) {
      for (let j = Math.floor(z0 / TILE); j <= Math.floor(z1 / TILE); j++) {
        const key = `${i},${j}`;
        if (!tiles.has(key)) tiles.set(key, []);
        tiles.get(key).push(item);
      }
    }
  }
  return tiles;
}

// --- Drawing (browser) ---------------------------------------------------------------------------------------------

// Per layer and tile, one Path2D (traced once); null where Path2D is missing
function compileLayers(layers, Path2DCtor = globalThis.Path2D) {
  if (typeof Path2DCtor !== 'function') return null;
  // Items within a tile's size go into the tiles their box touches; larger ones (a river, a long road) get a Path2D
  // of their own, drawn once when their box meets the window (in every tile they would be drawn several times over)
  const compile = (items, ptsOf, trace) => {
    const small = [], big = [];
    for (const item of items) {
      const box = bboxOf(ptsOf(item));
      if (box[2] - box[0] > TILE || box[3] - box[1] > TILE) {
        const p = new Path2DCtor();
        trace(p, item);
        big.push({ path: p, box });
      } else small.push(item);
    }
    const tiles = new Map();
    for (const [key, list] of tileItems(small, ptsOf)) {
      const p = new Path2DCtor();
      for (const item of list) trace(p, item);
      tiles.set(key, p);
    }
    return { tiles, big };
  };
  const roads = Object.keys(layers.roads)
    .sort((a, b) => ROAD_STYLE[a].order - ROAD_STYLE[b].order)
    .map((key) => {
      const items = layers.roads[key];
      const width = items.reduce((t, r) => t + r.width, 0) / Math.max(1, items.length);
      return { key, style: ROAD_STYLE[key], width, tiles: compile(items, (r) => r.pts, (p, r) => tracePolyline(p, r.pts)) };
    });
  return {
    lots: compile(layers.lots, (l) => l.rings[0], (p, l) => traceRings(p, l.rings)),
    water: compile(layers.water, (w) => w.rings[0], (p, w) => traceRings(p, w.rings)),
    trails: compile(layers.trails, (t) => t.pts, (p, t) => tracePolyline(p, t.pts)),
    roads
  };
}

// The tiles a north-up window x0..x1, z0..z1 touches
function tilesIn(x0, z0, x1, z1) {
  const keys = [];
  for (let i = Math.floor(x0 / TILE); i <= Math.floor(x1 / TILE); i++) {
    for (let j = Math.floor(z0 / TILE); j <= Math.floor(z1 / TILE); j++) keys.push(`${i},${j}`);
  }
  return keys;
}

// Draw the static layers, north-up, into a cache canvas centred on (cx, cz) at `scale` px / m (dpr: backing pixels)
function drawCache(cache, compiled, cx, cz, scale, dpr) {
  const ctx = cache.ctx;
  const W = cache.canvas.width, H = cache.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.land;
  ctx.fillRect(0, 0, W, H);
  const k = scale * dpr;
  ctx.setTransform(k, 0, 0, k, W / 2 - cx * k, H / 2 - cz * k);
  const keys = tilesIn(cx - cache.halfW, cz - cache.halfH, cx + cache.halfW, cz + cache.halfH);
  const x0 = cx - cache.halfW, z0 = cz - cache.halfH, x1 = cx + cache.halfW, z1 = cz + cache.halfH;
  const each = (layer, fn) => {
    for (const key of keys) { const p = layer.tiles.get(key); if (p) fn(p); }
    for (const { path, box } of layer.big) if (box[0] <= x1 && box[2] >= x0 && box[1] <= z1 && box[3] >= z0) fn(path);
  };
  ctx.fillStyle = COLORS.lot;
  each(compiled.lots, (p) => ctx.fill(p, 'evenodd'));
  ctx.fillStyle = COLORS.water;
  each(compiled.water, (p) => ctx.fill(p, 'evenodd'));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLORS.trail;
  ctx.lineWidth = 1.2 / scale;
  ctx.setLineDash([3 / scale, 3 / scale]);
  each(compiled.trails, (p) => ctx.stroke(p));
  ctx.setLineDash([]);
  for (const road of compiled.roads) {
    ctx.strokeStyle = road.style.color;
    ctx.lineWidth = Math.max(road.width * 0.75, road.style.min / scale);
    each(road.tiles, (p) => ctx.stroke(p));
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  cache.cx = cx;
  cache.cz = cz;
  cache.scale = scale;
  cache.drawn = true;
}

// Player arrow at the (rotated) centre, pointing up
function drawArrow(ctx, size) {
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.72, size * 0.8);
  ctx.lineTo(0, size * 0.38);
  ctx.lineTo(-size * 0.72, size * 0.8);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLORS.halo;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = COLORS.arrow;
  ctx.fill();
}

function drawPip(ctx, x, y, r, text, fill) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.stroke();
  if (text) {
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(r * 1.15)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }
}

// One radar view (the compact card or the larger view): a canvas, its cache, its range factor
function createView(canvas, { rangeFactor = 1, cacheFactor = 1.5 } = {}) {
  return { canvas, ctx: canvas.getContext('2d'), rangeFactor, cacheFactor, w: 0, h: 0, dpr: 1, cache: null };
}

function sizeView(view, dpr) {
  const w = view.canvas.clientWidth, h = view.canvas.clientHeight;
  if (!w || !h) return false;
  // a large view on a HiDPI screen: keep the backing store and its cache within a few megapixels
  const d = Math.max(0.5, Math.min(dpr, Math.sqrt(3e6 / Math.max(1, w * h))));
  if (w !== view.w || h !== view.h || d !== view.dpr) {
    view.w = w;
    view.h = h;
    view.dpr = d;
    view.canvas.width = Math.round(w * d);
    view.canvas.height = Math.round(h * d);
    view.cache = null;
  }
  return true;
}

// Draw one view: the cache rotated round the player, the dots, the traffic, the markers, the arrow and the N pip
function drawView(view, compiled, layers, state) {
  const { px, pz, heading, range, cars, markers } = state;
  const { ctx, w, h, dpr } = view;
  const scale = Math.min(w, h) / 2 / (range * view.rangeFactor);
  const radius = Math.hypot(w, h) / 2; // the view's half-diagonal: what the rotated cache must cover
  if (!cacheCovers(view.cache, px, pz, scale, radius)) {
    if (!view.cache) {
      const side = Math.ceil(2 * radius * view.cacheFactor);
      const canvas = view.canvas.ownerDocument.createElement('canvas');
      // the cache's own pixel ratio: at most ~4 megapixels (a large view on a HiDPI screen draws it a little softer)
      const cdpr = Math.max(0.5, Math.min(dpr, Math.sqrt(4e6 / (side * side))));
      canvas.width = Math.round(side * cdpr);
      canvas.height = Math.round(side * cdpr);
      view.cache = { canvas, ctx: canvas.getContext('2d'), side, dpr: cdpr, drawn: false, redraws: 0 };
    }
    view.cache.halfW = view.cache.halfH = view.cache.side / 2 / scale;
    drawCache(view.cache, compiled, px, pz, scale, view.cache.dpr);
    view.cache.redraws++;
  }
  const c = view.cache;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.land;
  ctx.fillRect(0, 0, view.canvas.width, view.canvas.height);
  // centre, heading-up rotation, then the cache (north-up round c.cx, c.cz at c.scale) moved to the player
  const k = scale / c.scale;
  ctx.setTransform(dpr, 0, 0, dpr, (w / 2) * dpr, (h / 2) * dpr);
  ctx.rotate(radarAngle(heading));
  ctx.drawImage(c.canvas, ((c.cx - px) * scale) - (c.side / 2) * k, ((c.cz - pz) * scale) - (c.side / 2) * k, c.side * k, c.side * k);
  ctx.setTransform(dpr, 0, 0, dpr, (w / 2) * dpr, (h / 2) * dpr);

  const inView = (sx, sy, pad) => Math.abs(sx) < w / 2 - pad && Math.abs(sy) < h / 2 - pad;
  if (cars) {
    ctx.fillStyle = 'rgba(232, 238, 244, 0.55)';
    for (const car of cars) {
      if (!car.placed) continue;
      const [sx, sy] = worldToRadar(car.x, car.z, px, pz, heading, scale);
      if (inView(sx, sy, 2)) ctx.fillRect(sx - 1.5, sy - 1.5, 3, 3);
    }
  }
  for (const dot of layers.dots) {
    const [sx, sy] = worldToRadar(dot.x, dot.z, px, pz, heading, scale);
    if (!inView(sx, sy, 5)) continue;
    drawPip(ctx, sx, sy, 4.5, '', COLORS.halo);
    drawPip(ctx, sx, sy, 3, '', dot.color);
  }
  // markers (a later mission icon): clamped to the rim when off the radar, like GTA's blips
  for (const m of markers.values()) {
    let [sx, sy] = worldToRadar(m.x, m.z, px, pz, heading, scale);
    if (!inView(sx, sy, 9)) [sx, sy] = rimPoint(sx, sy, w, h, 9);
    drawPip(ctx, sx, sy, 6.5, m.glyph || '', m.color || '#f5b62a');
  }
  drawArrow(ctx, Math.max(6, Math.min(11, Math.min(w, h) * 0.075)));
  // the N pip, a little smaller on a small card (the phone's 72-80 px radar)
  const pipR = Math.max(6, Math.min(8.5, Math.min(w, h) * 0.09));
  const [nx, ny] = northOnScreen(heading);
  const [rx, ry] = rimPoint(nx, ny, w, h, pipR + 2.5);
  drawPip(ctx, rx, ry, pipR, 'N', 'rgba(10, 12, 15, 0.82)');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return scale;
}

// --- The radar ---------------------------------------------------------------------------------------------------

// doc: the document. Needs #minimap-card / #minimap-canvas (index.html's radar card, un-hidden by gf-main.js).
//   controllerManager  the player (getActiveEntity(): position, heading)
//   layers             buildRadarLayers(...)
//   tier               'mobile' or 'desktop' (js/device-tier.js): DPR 1, 30 Hz and no traffic on mobile
//   cars               the traffic's cars ({ x, z, placed }), desktop only
//   heightAbove        (x, z, y) -> metres above the ground (the helicopter's zoom)
// Returns { update(dt), open(), close(), toggle(), expanded, setMarker(id, { x, z, color, glyph }), removeMarker(id),
// stats() }.
function installGfMinimap({ doc = globalThis.document, controllerManager, layers, tier = 'desktop', cars = null, heightAbove = null } = {}) {
  const card = doc.getElementById('minimap-card');
  const canvas = doc.getElementById('minimap-canvas');
  if (!card || !canvas || typeof canvas.getContext !== 'function') return null;
  const mobile = tier === 'mobile';
  const win = doc.defaultView || globalThis;
  const dprOf = () => (mobile ? 1 : Math.min(win.devicePixelRatio || 1, 2));

  if (!doc.querySelector('link[data-gf-minimap]')) {
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'css/gf-minimap.css';
    css.setAttribute('data-gf-minimap', '');
    doc.head.appendChild(css);
  }
  card.classList.add('gf-radar');
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-expanded', 'false');
  card.setAttribute('aria-controls', 'gf-radar-expanded');
  const staticNorth = card.querySelector('.radar-north');
  if (staticNorth) staticNorth.style.display = 'none'; // the N pip travels round the rim instead (.radar-north sets display)

  // The larger view: a GF-owned overlay in the upper part of the screen (not New York's #fullmap-modal)
  const overlay = doc.createElement('div');
  overlay.id = 'gf-radar-expanded';
  overlay.className = 'gf-radar-expanded';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Street radar, larger view');
  const big = doc.createElement('canvas');
  big.className = 'gf-radar-expanded-canvas';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'gf-radar-close';
  close.setAttribute('aria-label', 'Close the street radar [M]');
  close.title = 'Close [M / Esc]';
  close.textContent = '×';
  const caption = doc.createElement('div');
  caption.className = 'gf-radar-caption';
  caption.textContent = 'Map data © OpenStreetMap contributors (ODbL)';
  overlay.append(big, close, caption);
  doc.body.appendChild(overlay);

  const compiled = compileLayers(layers);
  const views = { compact: createView(canvas), expanded: createView(big, { rangeFactor: 2.6, cacheFactor: 1.35 }) };
  const markers = new Map();
  let expanded = false;
  let range = radarRange(0, 0);
  let last = null; // last position, for the speed
  let speed = 0;
  let since = Infinity;
  let draws = 0;
  let drawMs = 0;

  function setExpanded(on) {
    on = !!on;
    if (on === expanded) return expanded;
    expanded = on;
    overlay.hidden = !on;
    card.setAttribute('aria-expanded', String(on));
    card.classList.toggle('is-open', on);
    since = Infinity; // draw at once
    return expanded;
  }
  const api = {
    open: () => setExpanded(true),
    close: () => setExpanded(false),
    toggle: () => setExpanded(!expanded),
    get expanded() { return expanded; },
    // a later mission icon (CC-BUCKLEY): an id and a position in the GF frame; nothing is placed by default
    setMarker(id, { x, z, color, glyph } = {}) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      markers.set(String(id), { x, z, color, glyph });
      return true;
    },
    removeMarker: (id) => markers.delete(String(id)),
    stats: () => ({
      tier, expanded, range, speed, draws, drawMs,
      cacheRedraws: { compact: views.compact.cache?.redraws || 0, expanded: views.expanded.cache?.redraws || 0 },
      backing: { w: canvas.width, h: canvas.height, dpr: views.compact.dpr }
    }),
    update(dt) {
      const ent = controllerManager.getActiveEntity();
      if (!ent || !ent.position) return;
      const p = ent.position;
      if (last && dt > 0) {
        const v = Math.hypot(p.x - last.x, p.z - last.z) / dt;
        // a teleport or a mode change is not speed
        if (v < 120) speed += (v - speed) * (1 - Math.exp(-dt * 3));
      }
      last = { x: p.x, z: p.z };
      const above = heightAbove ? heightAbove(p.x, p.z, p.y) : 0;
      range += (radarRange(speed, above) - range) * (1 - Math.exp(-dt * 1.5));
      since += dt;
      if (mobile && since < MOBILE_INTERVAL) return;
      // nothing to draw while the radar is hidden (clean view, a narrow desktop window)
      if (doc.body.classList.contains('hud-minimized')) {
        if (expanded) setExpanded(false);
        return;
      }
      if (!compiled) return;
      since = 0;
      const t0 = win.performance ? win.performance.now() : 0;
      const state = { px: p.x, pz: p.z, heading: ent.heading || 0, range, markers, cars: !mobile && cars ? cars : null };
      // the card (unless a narrow desktop window hides it), and the larger view while it is open
      let drew = false;
      if (canvas.offsetParent && sizeView(views.compact, dprOf())) drew = !!drawView(views.compact, compiled, layers, state);
      if (expanded && sizeView(views.expanded, dprOf())) drew = !!drawView(views.expanded, compiled, layers, state) || drew;
      if (!drew) return;
      if (win.performance) drawMs += (win.performance.now() - t0 - drawMs) * 0.05;
      draws++;
    }
  };

  // M (desktop), a click / tap on the card or the larger view, Enter / Space on the focused card; Esc closes
  win.addEventListener('keydown', (e) => {
    const action = radarKey(e, expanded);
    if (action === 'toggle') api.toggle();
    else if (action === 'close') api.close();
  });
  card.addEventListener('click', () => api.toggle());
  card.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      api.toggle();
    }
  });
  overlay.addEventListener('click', () => api.close());
  return api;
}

// Lift the desktop map credit (js/gf-credit.js #gf-attribution, fixed at the bottom left) above the radar card, so it
// does not sit on the map. Desktop only: on touch screens css/gf-mobile.css places it (and this clears the inline offsets).
// below: what to stay above when the card is hidden (a narrow desktop window: style.css hides the radar under 620 px),
// the bottom-centre HUD with the Walk / Drive / Cycle / Fly bar, so the label and its open credit never sit on it.
function placeCreditAbove(credit, card, win = globalThis, below = null) {
  if (!credit || !card) return;
  // touch screens: css/gf-mobile.css places the credit beside the joystick (the radar is in the top-left there)
  const body = win.document && win.document.body;
  if (body && body.classList && body.classList.contains('touch-enabled')) {
    credit.style.bottom = '';
    credit.style.left = '';
    return;
  }
  const rect = card.offsetParent ? card.getBoundingClientRect() : null;
  if (rect && rect.height) {
    credit.style.bottom = `${Math.round(win.innerHeight - rect.top + 6)}px`;
    credit.style.left = `${Math.round(rect.left)}px`;
    return;
  }
  // (the bottom-centre HUD is position: fixed, so it has no offsetParent: its box tells whether it is shown)
  const bar = below && typeof below.getBoundingClientRect === 'function' ? below.getBoundingClientRect() : null;
  credit.style.bottom = bar && bar.height ? `${Math.round(win.innerHeight - bar.top + 6)}px` : '6px';
  credit.style.left = '8px';
}

export {
  installGfMinimap, buildRadarLayers, radarDots, radarAngle, worldToRadar, northOnScreen, rimPoint, radarRange,
  cacheCovers, radarKey, isTyping, tracePolyline, traceRings, tileItems, tilesIn, compileLayers, placeCreditAbove,
  ROAD_STYLE, WATER_KINDS, TILE, MOBILE_INTERVAL
};
