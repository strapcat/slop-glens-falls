// js/gf-furniture.js — EMPTY: NOT YET GENERATED. CC-006's OSM street-furniture extract (q_gf_street_furniture.overpassql)
// could not be fetched from the build environment (every Overpass server refused it), so this stand-in holds no OSM
// nodes at all: no sourced stops, give-ways, marked crossings or lamps. Nothing here is invented. Replace it with
//   bash tools/gf/fetch.sh && node tools/gf/build-gf-furniture.mjs
// (tests/gf-crosswalks-signs-lights.test.mjs "sources" fails until then). Until then the game shows the signalled
// crosswalks (gf-signals.js), inferred stop signs and assumed street lamps only.
export const GF_FURNITURE = {
  frame: {"lat0":43.3095,"lon0":-73.644,"theta":0},
  osmBase: null,
  counts: {"notFetched":true},
  stops: [],
  giveWays: [],
  crossings: [],
  lamps: [],
  attribution: null
};
