import { GF_GEO } from './gf-geodata.js';
import { gfRoadSource } from './gf-roadgraph.js';
import { createGfBlocks } from './gf-blocks.js';
import { setCityRuntime } from './city-runtime.js';
import { GF_TERRAIN } from './gf-terrain-data.js';
import { GF_BRIDGES } from './gf-bridges.js';
import { createGfSurface } from './gf-surface.js';

// Glens Falls in the city runtime (city-runtime.js): imported first by gf-main.js, before any shared module runs.
// No grid, park or shores: the road source's padded bbox is the land and the blocks are GF_GEO's curb islands
// (gf-blocks.js), which pedestrians walk around. CC-005b: the ground is the sourced USGS 3DEP terrain (gf-terrain.js),
// asked through the one surface contract (gf-surface.js): bare earth, bridge decks, water.

const ROAD_SOURCE = gfRoadSource(GF_GEO);
const GF_BLOCKS = createGfBlocks(GF_GEO);
const GF_SURFACE = createGfSurface({ terrain: GF_TERRAIN, geo: GF_GEO, bridges: GF_BRIDGES });
const { minX, maxX, minZ, maxZ } = ROAD_SOURCE.bounds;

// The player's ground: what each mode last stood on decides between a bridge deck and the ground beneath it
// (GF_SURFACE.support), so a player on a bridge stays on it and one on the road under it stays there. setNear(mode, y)
// seeds it (a saved position's height); unknown (NaN), the highest support wins (a teleport onto a bridge).
const nearY = { person: NaN, car: NaN, cyclist: NaN, helicopter: NaN };
const PLAYER_WORLD = {
  bounds: ROAD_SOURCE.bounds,
  shoreAt: ROAD_SOURCE.shoreAt,
  groundHeightAt(x, z, mode = 'person') {
    const y = GF_SURFACE.support(x, z, mode === 'helicopter' ? NaN : nearY[mode]);
    if (mode !== 'helicopter' && Number.isFinite(y)) nearY[mode] = y;
    return Number.isFinite(y) ? y : 0;
  },
  // The ground's slope for the vehicles' pitch and roll, and for the cameras and the helicopter's clearance
  groundNormalAt: (x, z, out) => GF_SURFACE.normal(x, z, out),
  setNear(mode, y) { nearY[mode] = y; },
  isPointOnSidewalk: () => false,
  spawn: null
};

setCityRuntime({
  ISLAND_BOUNDS: { minX, maxX, minZ, maxZ, sidewalkHeight: 0 },
  CENTRAL_PARK_BOUNDS: null,
  NJ_SHORELINE_POLYGON: [],
  LONG_ISLAND_POLYGONS: [],
  ROAD_SOURCE,
  // The player's world (controllers.js): kept inside the bbox, on the terrain with no raised sidewalks. gf-main.js adds
  // the start (gfSpawn) once the road network is built.
  PLAYER_WORLD,
  blockAt: GF_BLOCKS.blockAt,
  getIslandBoundsAtZ: ROAD_SOURCE.shoreAt,
  streetZ: () => 0
});

export { GF_BLOCKS, GF_SURFACE, GF_TERRAIN };
