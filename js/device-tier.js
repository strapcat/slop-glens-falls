// CC-MOBILE: which quality tier this device gets by default, from the device's own capabilities, never from the city.
//   mobile   the primary pointer is coarse and cannot hover (a phone or tablet held in the hand: matchMedia
//            '(pointer: coarse) and (hover: none)'), or the screen's short side is at most SMALL_SCREEN CSS px (a phone,
//            whatever it reports). The SCREEN, not the window: a desktop window made narrow keeps the desktop tier, and
//            a touchscreen laptop (a fine primary pointer that hovers) stays desktop too.
//   desktop  everything else: today's settings, unchanged.
// ?tier=mobile or ?tier=desktop in the page URL overrides the detector (for testing either tier on any device).
// The tier is only a default for the class of device; it never reads the city, so New York could use it too.

const SMALL_SCREEN = 500; // CSS px: the short side of a phone's screen (iPhone 320-440); tablets start near 600
const HANDHELD_QUERY = '(pointer: coarse) and (hover: none)';

// What each tier sets. desktop is today's behaviour (null: the module's own default).
const TIERS = {
  desktop: {
    pixelRatio: 1, // already capped at 1 for every device
    antialias: true,
    ssr: true, // half-resolution screen-space reflections (and their normal / metal-rough render targets)
    shadowMapSize: null, // lighting.js picks 3072 px cascade tiles where the GPU allows, else 2048
    treeMaxDist: null, // trees.js MAX_DIST: 3000 / 1600 / 950 m by tier (every GF tree is tier 2: 950 m)
    sidewalkRange: 650, // gf-sidewalk-meshes.js RANGE (m)
    lampPool: 32, // gf-street-furniture-meshes.js POOL point lights
    lampPoolRange: 160, // m
    compilePool: 16, // shader batches compiled at once behind the loading screen
    chaseDistanceScale: 1, // the follow camera's distance behind the player (controllers.js chaseDistance)
    chaseHeightScale: 1, // ... and its height (chaseHeight)
    portraitFov: null // cameras.js preset FOVs (chase 56, action 60, pov 68) at every aspect
  },
  mobile: {
    pixelRatio: 1,
    antialias: false, // no 4x MSAA colour / depth buffers
    ssr: false, // no reflections pass, no MRT normal / metal-rough targets
    shadowMapSize: 1024, // two 1024 px cascade tiles (about 8 MB of depth) instead of 2 x 3072 (about 75 MB)
    treeMaxDist: [1000, 700, 420], // m by tier: GF's trees (all tier 2) are drawn to 420 m
    sidewalkRange: 320,
    lampPool: 12,
    lampPoolRange: 100,
    compilePool: 4, // fewer pipelines in flight at once: a lower GPU-memory peak while loading
    // CC-MOBILE-fix (assumed starting values; Dave tunes by eye): the follow camera further back and a little higher
    // (person 4.3 -> 5.8 m, car 6.9 -> 9.3, cyclist 4.8 -> 6.5, helicopter 11.4 -> 15.4), and in portrait wider
    // vertical FOVs (a 56 deg vFOV is only ~27 deg across on a 390 x 844 screen). ?camdist= overrides the distance.
    chaseDistanceScale: 1.35,
    chaseHeightScale: 1.2,
    portraitFov: { chase: 70, action: 74, pov: 80 }
  }
};

function mediaMatches(matchMedia, query) {
  try {
    return typeof matchMedia === 'function' && !!matchMedia(query).matches;
  } catch {
    return false;
  }
}

// ?camdist= (a number from CAMDIST_RANGE): the follow camera's distance scale, on either tier; anything else is ignored
const CAMDIST_RANGE = [0.5, 3];
function camdistOf(params) {
  const raw = params.get('camdist');
  if (raw === null || raw.trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= CAMDIST_RANGE[0] && v <= CAMDIST_RANGE[1] ? v : null;
}
const withCamdist = (settings, camdist) => (camdist === null ? settings : { ...settings, chaseDistanceScale: camdist });

// env: { matchMedia, screen: { width, height }, search } (window by default). Returns { tier, settings, reason }.
function detectDeviceTier(env = globalThis) {
  const search = env.search ?? (env.location && env.location.search) ?? '';
  const params = new URLSearchParams(search);
  const camdist = camdistOf(params);
  const forced = params.get('tier');
  if (forced === 'mobile' || forced === 'desktop') return { tier: forced, settings: withCamdist(TIERS[forced], camdist), reason: `?tier=${forced}` };
  const matchMedia = env.matchMedia ? env.matchMedia.bind(env) : null;
  const handheld = mediaMatches(matchMedia, HANDHELD_QUERY);
  const screen = env.screen || {};
  const short = Math.min(Number(screen.width) || Infinity, Number(screen.height) || Infinity);
  const small = short <= SMALL_SCREEN;
  const tier = handheld || small ? 'mobile' : 'desktop';
  const reason = handheld ? HANDHELD_QUERY : small ? `screen short side ${short} px <= ${SMALL_SCREEN}` : 'fine or hovering pointer, large screen';
  return { tier, settings: withCamdist(TIERS[tier], camdist), reason };
}

// The follow cameras' FOV hook for cameras.js (null on a tier that keeps the presets'): portraitFov below aspect 1
function fovHookFor(settings) {
  const portrait = settings && settings.portraitFov;
  if (!portrait) return null;
  return (preset, aspect) => (aspect < 1 && Number.isFinite(portrait[preset.id]) ? portrait[preset.id] : null);
}

// Scale the controller entities' chase distance and height (controllers.js) by the tier's camera knobs
function applyChaseScale(entities, settings) {
  const d = settings.chaseDistanceScale ?? 1, h = settings.chaseHeightScale ?? 1;
  if (d === 1 && h === 1) return;
  for (const entity of Object.values(entities || {})) {
    if (!entity || !Number.isFinite(entity.chaseDistance)) continue;
    entity.chaseDistance *= d;
    if (Number.isFinite(entity.chaseHeight)) entity.chaseHeight *= h;
  }
}

export { detectDeviceTier, fovHookFor, applyChaseScale, TIERS, SMALL_SCREEN, HANDHELD_QUERY, CAMDIST_RANGE };
