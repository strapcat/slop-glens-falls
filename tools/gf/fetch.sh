#!/bin/bash
# usage: bash tools/gf/fetch.sh
# Downloads the Glens Falls OpenStreetMap extract (roads, water, traffic signals, buildings) through
# tools/overpass.sh into tools/gf/data/.
# The raw responses are committed so the generators (tools/gf/build-gf-*.mjs) run offline.
set -euo pipefail
GF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export OVERPASS_UA=${OVERPASS_UA:-"slop-glens-falls/0.1 (three.js city sim; github.com/strapcat/slop-glens-falls)"}
mkdir -p "$GF/data"
bash "$GF/../overpass.sh" "$GF/data/osm_gf_roads.json" "$GF/q_gf_roads.overpassql"
bash "$GF/../overpass.sh" "$GF/data/osm_gf_water.json" "$GF/q_gf_water.overpassql"
bash "$GF/../overpass.sh" "$GF/data/osm_gf_signals.json" "$GF/q_gf_signals.overpassql"
bash "$GF/../overpass.sh" "$GF/data/osm_gf_buildings.json" "$GF/q_gf_buildings.overpassql"
