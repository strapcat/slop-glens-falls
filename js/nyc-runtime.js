import {
  ALL_AVENUES,
  ALL_STREETS,
  ISLAND_BOUNDS,
  CENTRAL_PARK_BOUNDS,
  NJ_SHORELINE_POLYGON,
  LONG_ISLAND_POLYGONS,
  getIslandBoundsAtZ,
  BLOCKS,
  blockAt,
  streetZ
} from './city-config.js';
import { GEO } from './nyc-geodata.js';
import { setCityRuntime } from './city-runtime.js';

// New York in the city runtime (city-runtime.js): imported first by nyc-main.js, before any shared module runs.
// (landmarks.js hands over Bryant Park's lawn itself once it has built it, see setBryantParkLawn.)

// The city the road network is built for (road-network.js): Manhattan's avenue corridors and cross streets, its blocks
// (for their median malls), the street centreline graph, the island's bounds and shore, and the names of major roads
const NYC_SOURCE = {
  avenues: ALL_AVENUES,
  streets: ALL_STREETS,
  blocks: BLOCKS,
  roadGraph: GEO.roadGraph,
  bounds: ISLAND_BOUNDS,
  shoreAt: getIslandBoundsAtZ,
  majorName: /\bAVE\b|AVENUE|BROADWAY|BOWERY|BLVD|PARK ROW/
};

// The player's world (controllers.js): the island and its shore; Manhattan's parks, lawns and raised curbs for the
// ground and sidewalks (null: controllers.js's own), and the start on 5th Ave at 37th St (null)
const NYC_WORLD = { bounds: ISLAND_BOUNDS, shoreAt: getIslandBoundsAtZ, groundHeightAt: null, isPointOnSidewalk: null, spawn: null };

setCityRuntime({
  ISLAND_BOUNDS,
  CENTRAL_PARK_BOUNDS,
  NJ_SHORELINE_POLYGON,
  LONG_ISLAND_POLYGONS,
  ROAD_SOURCE: NYC_SOURCE,
  PLAYER_WORLD: NYC_WORLD,
  blockAt,
  getIslandBoundsAtZ,
  streetZ
});

export { NYC_SOURCE };
