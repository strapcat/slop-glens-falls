// The city the shared modules (road-network.js, traffic.js, tsl-materials.js, controllers.js, cameras.js,
// gamepad-controls.js, pedestrian-system.js) run in. Each city's entry installs its values first thing
// (nyc-runtime.js, gf-runtime.js), so the shared modules never import a city's own modules: Glens Falls loads none of
// New York's. The values keep the names the shared modules used to import from city-config.js and landmarks.js, as
// live bindings: read them when a function runs or an object is built, never at module scope.
//
// No imports: everything here is either installed by a city or city-neutral.

let ISLAND_BOUNDS = null; // { minX, maxX, minZ, maxZ, sidewalkHeight, waterLevel }: the land the player and traffic keep to
let CENTRAL_PARK_BOUNDS = null; // New York's open sky in the canyon AO and its park lakes; null elsewhere
let NJ_SHORELINE_POLYGON = []; // the far shores the harbour water reflects
let LONG_ISLAND_POLYGONS = [];
let bryantParkLawn = null; // the raised lawn's box once landmarks.js has built it (setBryantParkLawn)
let ROAD_SOURCE = null; // buildRoadNetwork's city source (see road-network.js)
let PLAYER_WORLD = null; // ThirdPersonControllerManager's world (see controllers.js)

let impl = null; // the installed city's functions

const KEYS = new Set([
  'ISLAND_BOUNDS', 'CENTRAL_PARK_BOUNDS', 'NJ_SHORELINE_POLYGON', 'LONG_ISLAND_POLYGONS', 'ROAD_SOURCE', 'PLAYER_WORLD',
  'blockAt', 'getIslandBoundsAtZ', 'streetZ'
]);

// Installs a city: once, and only the values above
function setCityRuntime(rt) {
  if (impl) throw new Error('city runtime already set');
  for (const k of Object.keys(rt)) if (!KEYS.has(k)) throw new Error(`unknown city runtime key: ${k}`);
  impl = { blockAt: rt.blockAt, getIslandBoundsAtZ: rt.getIslandBoundsAtZ, streetZ: rt.streetZ };
  if ('ISLAND_BOUNDS' in rt) ISLAND_BOUNDS = rt.ISLAND_BOUNDS;
  if ('CENTRAL_PARK_BOUNDS' in rt) CENTRAL_PARK_BOUNDS = rt.CENTRAL_PARK_BOUNDS;
  if ('NJ_SHORELINE_POLYGON' in rt) NJ_SHORELINE_POLYGON = rt.NJ_SHORELINE_POLYGON;
  if ('LONG_ISLAND_POLYGONS' in rt) LONG_ISLAND_POLYGONS = rt.LONG_ISLAND_POLYGONS;
  if ('ROAD_SOURCE' in rt) ROAD_SOURCE = rt.ROAD_SOURCE;
  if ('PLAYER_WORLD' in rt) PLAYER_WORLD = rt.PLAYER_WORLD;
}

// landmarks.js builds New York's Bryant Park lawn; the player stands on it and a camera frames it
function setBryantParkLawn(v) {
  bryantParkLawn = v;
}

const installed = (name) => {
  if (!impl || !impl[name]) throw new Error('city runtime not set');
  return impl[name];
};
// The block (curb island) at (x, z), or null: also before a city is installed, as off any block
function blockAt(x, z) {
  return impl && impl.blockAt ? impl.blockAt(x, z) : null;
}
// West / east shore x at a given z
function getIslandBoundsAtZ(z) {
  return installed('getIslandBoundsAtZ')(z);
}
// z of a numbered street
function streetZ(n) {
  return installed('streetZ')(n);
}

// The city-neutral helpers below are the same code as city-config.js's, which keeps its own copies for the New York
// modules importing them from there (tests/city-runtime.test.mjs checks the two give the same answers).

// Keyboard shortcuts are ignored while typing into a form field (e.g. the map's street search box)
function isTypingInField(e) {
  return e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT');
}

// Traffic signal cycle shared by the signal heads (street-details.js) and the traffic (traffic.js), in seconds:
// avenues green until avenueAmber, amber until avenueRed; cross streets green from avenueRed until streetAmber,
// amber until the end of the cycle. Pedestrians cross with the traffic that runs parallel to them, stepping off
// only on the WALK, the first `walk` seconds of its green: long enough before the cross traffic's green for the
// slowest walker to get across the widest avenue.
const SIGNAL_TIMING = { cycle: 60, avenueAmber: 26, avenueRed: 30, streetAmber: 56, walk: 7 };

// 'green', 'amber' or 'red' for avenue or cross street traffic at a given time
function signalPhase(time, isAvenue) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const t = ((time % cycle) + cycle) % cycle;
  if (isAvenue) return t < avenueAmber ? 'green' : t < avenueRed ? 'amber' : 'red';
  return t < avenueRed ? 'red' : t < streetAmber ? 'green' : 'amber';
}

// Do pedestrians walking alongside avenue (or cross street) traffic have the WALK at a given time?
function walkSignal(time, isAvenue) {
  const { cycle, avenueRed, walk } = SIGNAL_TIMING;
  const t = (((time - (isAvenue ? 0 : avenueRed)) % cycle) + cycle) % cycle;
  return t < walk;
}

export {
  ISLAND_BOUNDS,
  CENTRAL_PARK_BOUNDS,
  NJ_SHORELINE_POLYGON,
  LONG_ISLAND_POLYGONS,
  bryantParkLawn,
  ROAD_SOURCE,
  PLAYER_WORLD,
  setCityRuntime,
  setBryantParkLawn,
  blockAt,
  getIslandBoundsAtZ,
  streetZ,
  isTypingInField,
  SIGNAL_TIMING,
  signalPhase,
  walkSignal
};
