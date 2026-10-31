# Glens Falls geo pipeline (v0)

Turns an OpenStreetMap extract of Glens Falls and South Glens Falls, NY into `js/gf-geodata.js`: the streets as a
node/link road graph, curb-island blocks and water polygons, in a flat local frame. It is separate from the New York
pipeline (`tools/build-geodata.mjs`), which it does not change. It shares only the geometry helpers in
`tools/geo-util.mjs`.

## Build

```sh
bash tools/gf/fetch.sh                  # Overpass -> tools/gf/data/osm_gf_{roads,water}.json (committed)
node tools/gf/build-gf-geodata.mjs      # tools/gf/data/ -> js/gf-geodata.js, prints summary stats
node --test tests/gf-geodata.test.mjs
```

Then open `index.html?city=glensfalls&view=debug` (or `gf.html`) through a local web server for the flat debug view.
Add `&look=x,z,distance` to start the camera looking down at a point (metres) from that distance. The screenshots in
`screenshots/` use `look=0,-150,900` (downtown), `look=300,450,1300` (the Glen Street bridge over the Hudson) and
`look=-1250,-1120,700` (Crandall Pond, a hole in its block).

- `fetch.sh` runs both queries through `tools/overpass.sh`, which keeps its endpoint fallback and retries and only
  replaces a file after a complete, valid response. The User-Agent is `OVERPASS_UA` (default
  `slop-glens-falls/0.1 ...`).
- The raw responses are committed, so the build runs offline. It depends only on them: there are no timestamps, and
  every input is sorted by OSM id, so two builds are byte-identical. `osmBase` in the output records the OSM snapshot
  time Overpass reported. `GF_DATA=<dir>` reads the raw JSON from another folder. An optional argument sets the
  output path.

## Inputs

| File | Query | Content |
| --- | --- | --- |
| `data/osm_gf_roads.json` | `q_gf_roads.overpassql` | `highway` = motorway, trunk, primary, secondary, tertiary, unclassified, residential, service, living_street and their `_link` variants, with their nodes. Footways, paths, cycleways and steps are not fetched yet. |
| `data/osm_gf_water.json` | `q_gf_water.overpassql` | `natural=water` and `waterway=riverbank\|river\|canal` ways and relations, with their member ways and nodes |

Bounding box: south 43.290, west -73.680, north 43.330, east -73.610.

## Frame (`geo-frame.mjs`)

This is a tangent plane at **LAT0 43.3095, LON0 -73.6440** with THETA = 0 (axes on true north). The axes follow the
NYC convention: x = east, z = south, y = up, and 1 unit = 1 m. Polygons are flat `[x0, z0, x1, z1, ...]` arrays
rounded to 0.1 m.

> **The origin is provisional.** It is an approximate downtown centroid. If it moves, every coordinate in
> `js/gf-geodata.js` shifts.

## Output (`GF_GEO`)

- `roadGraph`
  - `nodes` (flat x, z) sit at way ends, at junctions (an OSM node shared by two road pieces) and where a way crosses
    the bbox edge.
  - Each row of `links` follows `linkFields`: `[a, b, name, highway, oneway, lanes, width, pts]`.
    - `name` and `highway` index `names` and `classes`.
    - `oneway` is 1 along the OSM way, -1 against it, 0 both ways.
    - `lanes` is 0 when untagged.
    - `width` is the estimated curb-to-curb width in metres.
    - `pts` are the inner shape points, simplified to 0.25 m.
- `roads`: `[osmWayId, [link indices]]`, one row per OSM way.
- `blocks`: `{ area, curb, curbHoles, lot, lotHoles }`.
  - `curb` is the curb-island outline. `curbHoles` are the holes in it: ponds and other water inside the island, or a
    block-bounding roadway it encloses.
  - `lot` is the property line, 1.8 m in from the curb, roads and water, with its own `lotHoles`. `lot` is `null` when
    nothing is left.
  - `area` (m²) is the curb outline minus its holes, so it matches the emitted geometry.
- `water`: `{ osm, name, kind, outer, holes }` polygons, clipped to the bbox.
- `frame`, `bbox` (degrees and metres), `osmBase`, `version`, `attribution`.

### Widths

These come from `WIDTH_DEFAULTS` in `build-gf-geodata.mjs`, in this order:

1. The `width` tag (metres, or feet with `'`/`ft`).
2. Otherwise `lanes` × 3.3 m.
3. Otherwise the class default: primary/secondary 12 m, tertiary 10 m, residential/unclassified 8 m, service 5 m.
   Defaults not specified in CC-001: motorway/trunk 11 m (one carriageway), living_street 6 m, `*_link` 6 m.

### Blocks

The method follows `tools/geo-blocks.mjs`, with parameters in `BLOCK_PARAMS`:

1. Rasterise the bbox at 1 m, removing water and every block-bounding roadway, stamped as capsules at curb width.
2. Label the 4-connected curb islands that remain.
3. Trace each island and remove the raster stair steps, then simplify (RDP 0.5 m). If that self-intersects, the build
   falls back to 0.25 m, then no simplification, then raw corners.
4. Trace the island's holes the same way. A hole is the cells in the island's bounding box that can't reach the box
   edge through other non-island cells (8-connected, so a hole never touches the outline). Holes under 10 m² are
   ignored. If simplified rings touch or cross, all rings of that island fall back to raw corners. A hole that still
   touches another ring is dropped, and the build counts and logs it.
5. Drop islands under 150 m² and any island touching the bbox edge.

The tracer throws if a contour walk runs longer than a closed outline can be (4 × the island's cells), so a broken
outline stops the build instead of reaching the output.

Block-bounding roads are all fetched roads except tunnels and `service` ways (driveways, parking aisles, untagged
service roads), which run into lots. `service=alley` does bound blocks. All service ways stay in the road graph.

### Water

Closed `natural=water` / `waterway=riverbank` ways and `multipolygon` relations are kept. Relation member ways are
joined into rings, and each hole goes to the outer ring around it. Anything that cannot be closed is skipped and
logged, including `waterway=river|canal` centre lines, which are lines rather than areas.

## Game view

`index.html?city=glensfalls` opens Glens Falls in the game itself. `js/main.js` now only dispatches:

| URL | Loads |
| --- | --- |
| `index.html` | New York (`js/nyc-main.js`, the former `main.js`) |
| `index.html?city=glensfalls` | Glens Falls (`js/gf-main.js`) |
| `index.html?city=glensfalls&view=debug` | the flat debug view (`gf.html`) |

The Glens Falls view (`js/gf-main.js`) has:

- **The ground** (`js/gf-ground.js`): flat at y = 0, with a ground plane, water, a flat tint over the blocks, and road
  ribbons at their curb widths for every class. Service roads are drawn a shade lighter but not driven.
- **The road network**: `js/road-network.js` builds it from `GF_GEO.roadGraph` through `gfRoadSource()`
  (`js/gf-roadgraph.js`), with no avenues, cross streets or blocks, so its centreline step (4b) carries the whole town.
  The source:
  - keeps the links in `DRIVE_CLASSES` (every class but `service`);
  - rejoins pieces of one street that `GF_GEO` split only where a service road met it;
  - cuts long gentle curves at their own shape points, so no straight run strays more than 1.5 m from the street.

  Lanes and right of way come from each link's width, lanes and direction. No major-road names are used.
- **40 AI cars** (`js/traffic.js` with `numCars: 40, numBuses: 0, pedestrians: false`) and the road markings
  (`js/road-paint.js`), both from that network.
- **The player** (`js/controllers.js` with a Glens Falls `world`):
  - kept inside the bbox, on flat ground with no sidewalks;
  - starting in the rightmost lane of the longest Glen Street edge (`gfSpawn()`);
  - saved under the `gf-player-state` localStorage key.
- **The HUD**: modes, the follow cameras, time of day and the OSM attribution. Teleports, the map, sound and New York's
  scenic cameras are hidden.

There are no buildings, terrain, landmarks, pedestrians or traffic signals yet. Every junction is unsignalised, with
the widest road given right of way. `tests/gf-roadnetwork.test.mjs` checks the network: deterministic, every lane
leading on, everything inside the bbox, and every edge along a drive link. Twelve edges are listed exceptions:

- the chord across the small Centennial Circle roundabout;
- five streets that meet another road at two OSM nodes 9-13 m apart, which `road-network.js` merges into one junction.

## Source and licence

Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The raw extracts in
`tools/gf/data/` and the derived `js/gf-geodata.js` are ODbL. The attribution "© OpenStreetMap contributors" appears
here, in `GF_GEO.attribution` and on screen in the debug and game views. No other datasets are used, and no geography is placed
by hand.
