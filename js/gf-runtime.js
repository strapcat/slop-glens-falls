import { GF_GEO } from './gf-geodata.js';
import { gfRoadSource } from './gf-roadgraph.js';
import { createGfBlocks } from './gf-blocks.js';
import { setCityRuntime } from './city-runtime.js';
import { GF_TERRAIN } from './gf-terrain-data.js';
import { GF_BRIDGES } from './gf-bridges.js';
import { createGfSurface } from './gf-surface.js';
import { GF_TRAILS } from './gf-trails.js';
import { ROAD_LIFT } from './gf-drape.js';
import { createGfSidewalks } from './gf-sidewalks.js';

// Glens Falls in the city runtime (city-runtime.js): imported first by gf-main.js, before any shared module runs.
// No grid, park or shores: the road source's padded bbox is the land and the blocks are GF_GEO's curb islands
// (gf-blocks.js), which pedestrians walk around. CC-005b: the ground is the sourced USGS 3DEP terrain (gf-terrain.js),
// asked through the one surface contract (gf-surface.js): bare earth, bridge decks, water.

const ROAD_SOURCE = gfRoadSource(GF_GEO);
const GF_BLOCKS = createGfBlocks(GF_GEO);
// CC-005c: the mapped footbridges on the accepted trails (gf-trails.js) are decks for walkers (gf-surface.js footDecks)
const GF_SURFACE = createGfSurface({ terrain: GF_TERRAIN, geo: GF_GEO, bridges: GF_BRIDGES, footDecks: GF_TRAILS.footDecks });
const { minX, maxX, minZ, maxZ } = ROAD_SOURCE.bounds;
// CC-005e: the raised curbs, tree lawns and walks along the roads (gf-sidewalks.js; drawn by gf-sidewalk-meshes.js)
const GF_SIDEWALKS = createGfSidewalks({ geo: GF_GEO, blocks: GF_BLOCKS, ground: GF_SURFACE.ground });
// On the ground (not a deck), what stands there: a curb, lawn or walk raises a walker, cyclist or car to its top
const onRaised = (x, z, y) => {
  const g = GF_SURFACE.ground(x, z);
  if (Math.abs(y - g) > 0.05) return y;
  const r = GF_SIDEWALKS.raiseAt(x, z);
  return r > ROAD_LIFT ? Math.max(y, g + r - ROAD_LIFT) : y;
};

// The player's ground: what each mode last stood on decides between a bridge deck and the ground beneath it
// (GF_SURFACE.support), so a player on a bridge stays on it and one on the road under it stays there. setNear(mode, y)
// seeds it (a saved position's height); unknown (NaN), the highest support wins (a teleport onto a bridge). Walkers,
// cars and bicycles stand ROAD_LIFT above it: on the draped asphalt (gf-drape.js), never in it; the helicopter's floor
// is the support itself.
const nearY = { person: NaN, car: NaN, cyclist: NaN, helicopter: NaN };
const PLAYER_WORLD = {
  bounds: ROAD_SOURCE.bounds,
  shoreAt: ROAD_SOURCE.shoreAt,
  groundHeightAt(x, z, mode = 'person') {
    if (mode === 'helicopter') {
      const y = GF_SURFACE.support(x, z, NaN);
      return Number.isFinite(y) ? y : 0;
    }
    const y = GF_SURFACE.support(x, z, nearY[mode] - ROAD_LIFT);
    if (!Number.isFinite(y)) return 0;
    nearY[mode] = y + ROAD_LIFT;
    return onRaised(x, z, y) + ROAD_LIFT;
  },
  // The ground's slope for the vehicles' pitch and roll, and for the cameras and the helicopter's clearance
  groundNormalAt: (x, z, out) => GF_SURFACE.normal(x, z, out),
  setNear(mode, y) { nearY[mode] = y; },
  isPointOnSidewalk: () => false,
  // CC-005d: the player's walker and cyclist drawn under the WebGL 2 fallback too (controllers.js, pedestrians.js)
  textureFallback: true,
  spawn: null
};

setCityRuntime({
  ISLAND_BOUNDS: { minX, maxX, minZ, maxZ, sidewalkHeight: 0 },
  CENTRAL_PARK_BOUNDS: null,
  NJ_SHORELINE_POLYGON: [],
  LONG_ISLAND_POLYGONS: [],
  ROAD_SOURCE,
  // The player's world (controllers.js): kept inside the bbox, on the terrain and (CC-005e) the raised sidewalks. gf-main.js adds
  // the start (gfSpawn) once the road network is built.
  PLAYER_WORLD,
  blockAt: GF_BLOCKS.blockAt,
  getIslandBoundsAtZ: ROAD_SOURCE.shoreAt,
  streetZ: () => 0
});

export { GF_BLOCKS, GF_SURFACE, GF_TERRAIN, GF_SIDEWALKS, onRaised };
