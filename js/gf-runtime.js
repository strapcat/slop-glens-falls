import { GF_GEO } from './gf-geodata.js';
import { gfRoadSource } from './gf-roadgraph.js';
import { createGfBlocks } from './gf-blocks.js';
import { setCityRuntime } from './city-runtime.js';

// Glens Falls in the city runtime (city-runtime.js): imported first by gf-main.js, before any shared module runs.
// No grid, park or shores: the road source's padded bbox is the land, the ground is flat at 0, and the blocks are
// GF_GEO's curb islands (gf-blocks.js), which pedestrians walk around.

const ROAD_SOURCE = gfRoadSource(GF_GEO);
const GF_BLOCKS = createGfBlocks(GF_GEO);
const { minX, maxX, minZ, maxZ } = ROAD_SOURCE.bounds;

setCityRuntime({
  ISLAND_BOUNDS: { minX, maxX, minZ, maxZ, sidewalkHeight: 0 },
  CENTRAL_PARK_BOUNDS: null,
  NJ_SHORELINE_POLYGON: [],
  LONG_ISLAND_POLYGONS: [],
  ROAD_SOURCE,
  // The player's world (controllers.js): kept inside the bbox, on flat ground with no sidewalks. gf-main.js adds the
  // start (gfSpawn) once the road network is built.
  PLAYER_WORLD: {
    bounds: ROAD_SOURCE.bounds,
    shoreAt: ROAD_SOURCE.shoreAt,
    groundHeightAt: () => 0,
    isPointOnSidewalk: () => false,
    spawn: null
  },
  blockAt: GF_BLOCKS.blockAt,
  getIslandBoundsAtZ: ROAD_SOURCE.shoreAt,
  streetZ: () => 0
});

export { GF_BLOCKS };
