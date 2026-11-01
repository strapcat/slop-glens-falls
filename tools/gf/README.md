# Glens Falls geo pipeline (v0)

Turns an OpenStreetMap extract of Glens Falls and South Glens Falls, NY into `js/gf-geodata.js`: the streets as a
node/link road graph, curb-island blocks and water polygons, in a flat local frame. It is separate from the New York
pipeline (`tools/build-geodata.mjs`), which it does not change. It shares only the geometry helpers in
`tools/geo-util.mjs`.

## Build

```sh
bash tools/gf/fetch.sh                  # Overpass -> tools/gf/data/osm_gf_{roads,water,signals,buildings}.json (committed)
node tools/gf/build-gf-geodata.mjs      # tools/gf/data/ -> js/gf-geodata.js, prints summary stats
node tools/gf/build-gf-signals.mjs      # tools/gf/data/osm_gf_signals.json -> js/gf-signals.js
node tools/gf/build-gf-buildings.mjs    # tools/gf/data/osm_gf_buildings.json -> js/gf-buildings.js, prints counts
node --test tests/gf-geodata.test.mjs tests/gf-signals.test.mjs tests/gf-buildings.test.mjs
```

Then open `index.html?city=glensfalls&view=debug` (or `gf.html`) through a local web server for the flat debug view.

Add `&look=x,z,distance` to start the camera looking down at a point (metres) from that distance. The screenshots in
`screenshots/` use `look=0,-150,900` (downtown), `look=300,450,1300` (the Glen Street bridge over the Hudson) and
`look=-1250,-1120,700` (Crandall Pond, a hole in its block). The game-view screenshots (`cc002*`, `cc003*`) name their
places in the PR that added them; `cc003-downtown-glen.png`, `cc003-crandall-pond.png` and `cc003-overview.png` show
the buildings.

- `fetch.sh` runs each query through `tools/overpass.sh`, which keeps its endpoint fallback and retries and only
  replaces a file after a complete, valid response. The User-Agent is `OVERPASS_UA` (default
  `slop-glens-falls/0.1 ...`).
- The raw responses are committed, so the build runs offline. It depends only on them: there are no timestamps, and
  every input is sorted by OSM id, so two builds are byte-identical. `osmBase` in the output records the OSM snapshot
  time Overpass reported. `GF_DATA=<dir>` reads the raw JSON from another folder. An optional argument sets the
  output path.

**Tests:** `node --test tests/*.test.cjs tests/*.test.mjs` runs the whole suite on Node 20, 22 and 24. (`node --test
tests/` fails on Node 22 and later, which read the directory as a module.)

## Inputs

| File | Query | Content |
| --- | --- | --- |
| `data/osm_gf_roads.json` | `q_gf_roads.overpassql` | `highway` = motorway, trunk, primary, secondary, tertiary, unclassified, residential, service, living_street and their `_link` variants, with their nodes. Footways, paths, cycleways and steps are not fetched yet. |
| `data/osm_gf_water.json` | `q_gf_water.overpassql` | `natural=water` and `waterway=riverbank\|river\|canal` ways and relations, with their member ways and nodes |
| `data/osm_gf_signals.json` | `q_gf_signals.overpassql` | `highway=traffic_signals` and `crossing=traffic_signals` nodes (see Signals) |
| `data/osm_gf_buildings.json` | `q_gf_buildings.overpassql` | `building=*` ways and relations, with their member ways and nodes (see Buildings) |

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

### City runtime

The modules both cities share (`road-network.js`, `traffic.js`, `tsl-materials.js`, `controllers.js`, `cameras.js`,
`gamepad-controls.js`, `pedestrian-system.js` and what they import) take their city from `js/city-runtime.js`, which
has no imports of its own:

- **The values** are live bindings, read when a function runs or an object is built, never at module scope:
  - the land's bounds and shore (`ISLAND_BOUNDS`, `getIslandBoundsAtZ`), New York's park and far shores
    (`CENTRAL_PARK_BOUNDS`, `NJ_SHORELINE_POLYGON`, `LONG_ISLAND_POLYGONS`) and Bryant Park's lawn (`bryantParkLawn`);
  - `blockAt` and `streetZ`;
  - the road network's source (`ROAD_SOURCE`) and the player's world (`PLAYER_WORLD`).
- **Installing a city:** each city's entry imports its runtime first, which installs these values once with
  `setCityRuntime()`:
  - `js/nyc-runtime.js` from `city-config.js` and `nyc-geodata.js`;
  - `js/gf-runtime.js` from `gf-geodata.js` and `gf-roadgraph.js`. It has no park, shores or blocks (`blockAt` → `null`
    for now), and the road source's padded bbox is the land.
- **Downloads:** Glens Falls neither evaluates nor downloads any New York module. `index.html` preloads only `main.js`
  and the shared modules, and `main.js` preloads the chosen city's own modules (`NYC_PRELOADS`, `GF_PRELOADS`).
- **Tests:** `tests/city-runtime.test.mjs` walks both cities' static import graphs to check this, and that each city's
  modules are preloaded.

The Glens Falls view (`js/gf-main.js`) has:

- **The ground** (`js/gf-ground.js`): flat at y = 0, with a ground plane, water, the blocks (the sidewalk band in
  concrete, the lots a shade darker), and road ribbons at their curb widths for every class. Service roads are drawn a
  shade lighter but not driven.
- **The road network**: `js/road-network.js` builds it from `GF_GEO.roadGraph` through `gfRoadSource()`
  (`js/gf-roadgraph.js`, installed as `ROAD_SOURCE` by `gf-runtime.js`), with no avenues, cross streets or blocks, so its centreline step (4b) carries the whole town.
  The source:
  - keeps the links in `DRIVE_CLASSES` (every class but `service`);
  - rejoins pieces of one street that `GF_GEO` split only where a service road met it;
  - cuts a street that rejoins into a loop back to its own junction (a cul-de-sac loop) at its shape points nearest a
    third and two thirds of the way round, into three links with distinct ends (`road-network.js` drops a link that
    starts and ends at one junction). All six such loops (Simione Court, Dixon Court, North Court, Boylston Street, Bush
    Street, Chelsea Way) are long enough; North Court still drops out with the dead ends at the bbox edge, its only way
    in (Old Mill Lane) leaving the box;
  - cuts long gentle curves at their own shape points, so no straight run strays more than 1.5 m from the street.

  Lanes and right of way come from each link's width, lanes and direction. No major-road names are used.
- **40 AI cars** (`js/traffic.js` with `numCars: 40, numBuses: 0`), stopping at the OSM traffic signals (see Signals),
  120 pedestrians on the sidewalks (see Pedestrians), and the road markings (`js/road-paint.js`), all from that network,
  plus the signal heads (`js/gf-signal-heads.js`).
- **The buildings** (see Buildings): OSM footprints extruded with flat roofs. The player collides with them;
  pedestrians walk around them; cars don't notice them.
- **The player** (`js/controllers.js` with the Glens Falls `PLAYER_WORLD` from `gf-runtime.js`):
  - kept inside the bbox, on flat ground with no sidewalks, and out of the buildings;
  - starting in the rightmost lane of the longest Glen Street edge (`gfSpawn()`);
  - saved under the `gf-player-state` localStorage key. A saved position inside a building (saved before the
    buildings stood) returns to the spawn.
- **The HUD**: modes, the follow cameras, time of day and the OSM attribution. The car and bike are labelled `Taxi` and
  `Cyclist`. Teleports, the map, sound and New York's scenic cameras are hidden.

There is no terrain and there are no landmarks yet. Unsignalled junctions give the widest road right of way.
`tests/gf-roadnetwork.test.mjs` checks the network: deterministic, every lane
leading on, everything inside the bbox, and every edge along a drive link. Twelve edges are listed exceptions:

- the chord across the small Centennial Circle roundabout;
- five streets that meet another road at two OSM nodes 9-13 m apart, which `road-network.js` merges into one junction.

### Signals

- **Data:** `q_gf_signals.overpassql` fetches the bbox's `highway=traffic_signals` nodes (signalled junctions) and
  `crossing=traffic_signals` nodes (signalled pedestrian crossings) into `data/osm_gf_signals.json`. The committed file
  is from OSM base 2026-10-31T11:54:00Z: 75 nodes, sha256 `cd1b47f4…bc68`.
- **Generator:** `build-gf-signals.mjs` projects them into the `GF_GEO` frame as they are, with no point added, moved
  or dropped. It writes `js/gf-signals.js` (`GF_SIGNALS.junctions`: 51 `[x, z, osmId, direction|null]`;
  `GF_SIGNALS.crossings`: 24 `[x, z, osmId]`), and a rebuild is byte-identical.
- **Matching:** the game passes the 51 junction signals to `buildRoadNetwork`, whose step 8 signals the junction node
  within 6 m of each, never a bend (a shape node).
- **Result:** **41 junctions are signalled, from 42 of the 51 signals** (two signals mark one junction):
  - **Skipped:** one lies on a bend, Quaker Ridge Blvd at a service driveway (OSM 1141401582).
  - **Unmatched (8):** these have no network node near them, because their corridors leave the bbox and drop out with
    its dead ends (CC-002a):
    - Upper Glen St / Lafayette St / Foster Ave (221437271, 221437275);
    - Upper Glen St and Aviation Rd at service driveways (1001656622, 691144630);
    - Aviation Rd / Greenway North (221447701);
    - Lower Warren St / Boulevard / Highland Ave (691085958);
    - Quaker Rd / Dix Ave (221444435, 37 m away);
    - Main St at the I-87 Exit 18 ramps (221338711).
- **Timing:** the signals run New York's cycle (`signalPhase`). A junction's widest road (right-of-way group 0) gets
  the avenue phase, and every other road the street phase.
- **Signal heads:** `js/gf-signal-heads.js` draws one post with a three-lamp head per arriving road, on its right-hand
  curb 1.5 m before the stop line.
- **Not used yet:** the 24 signalled crossings.

### Pedestrians

- **Where they walk:** the sidewalk band of each block, between its curb and its lot (`GF_GEO.blocks`: the lot is 1.8 m
  inside the curb). `js/gf-blocks.js` provides:
  - `blockAt` (the curb outline minus its holes, under a 64 m grid index), which `gf-runtime.js` installs in the city
    runtime;
  - the lots, as obstacles to pedestrians only, so the car network is the same with them as without (tested);
  - `onSidewalk` (on a block, outside its lot).
- **Settings:** 120 pedestrians on two walking lines 0.6 and 1.2 m from the roadway (New York's lie 1.7 and 2.8 m out,
  on its 4.6 m sidewalks), at `sidewalkY` 0.02 on the flat ground.
- **Coverage:** 2187 of the network's 2498 edges have sidewalk tracks.
- **Limits:** there are no crosswalks at Glens Falls junctions yet (`pedestrian-routes.js` `across()` only knows New
  York's grid corners), so pedestrians walk around their block but don't cross streets.

### Buildings

- **Data:** `q_gf_buildings.overpassql` fetches every `building=*` way and relation in the bbox, with their nodes, into
  `data/osm_gf_buildings.json`. The committed file is from OSM base 2026-11-01T13:05:10Z: 7,825 buildings (7,824
  closed ways and one multipolygon relation), sha256 `ea8ac7bd…0509`.
- **Generator:** `build-gf-buildings.mjs` writes `js/gf-buildings.js`, about 1.05 MB, one building per line. It
  projects each footprint into the `GF_GEO` frame at 0.1 m, joins a relation's member ways with `joinRings`, and drops
  repeated points. It keeps a ring only with 3 or more points, 1 m² or more and no self-intersection (none is dropped
  today). Nothing is moved, merged or clipped, and a rebuild is byte-identical.
- **Schema:** `GF_BUILDINGS = { osmBase, attribution, storey: 3.3, heightRule, fields, buildings }`. Each row is
  `[osm, kind, use, name, start, levels, height, src, outer, holes]`:
  - `osm` is `w<id>` or `r<id>`; ways come first, then relations, each sorted by id;
  - `kind` is the `building` value; `use` is `shop=…`, else `amenity=…`, else null;
  - `name`, `start` (`start_date`) and `levels` are the raw tags or null;
  - `src` says where the height came from (below);
  - `outer` is a flat `[x, z, …]` ring with no closing point, and `holes` is a list of such rings.
- **Skipped (36):**
  - 17 `building=roof`, open canopies such as fuel-station roofs, which walls would turn into solid boxes;
  - 1 `building=construction`;
  - 18 whose outer ring's bounding-box centre is outside the bbox.

  The 21 that straddle the edge but are centred inside are kept whole.
- **Heights (`HEIGHT_RULE`, copied into `GF_BUILDINGS.heightRule`):**
  1. An OSM `height` tag (m, ft or ') wins: `src` 0. No building has one today.
  2. Else `building:levels`: levels × 3.3 + 0.6 m, `src` 1. 49 buildings.
  3. Else **a default that is an approximation, not a survey** (`src` 2). 7,740 buildings, **99.4% of the town.**
     - Levels by type:
       - 1: garage, shed, outbuilding, carport, greenhouse, supermarket, industrial, warehouse, chapel and the like;
       - 2: house, residential, commercial, retail, school, church and the like;
       - 3: apartments, office, hospital, parking;
       - an untyped `yes`: 1 under 40 m², else 2.
     - Footprints of 2,000 m² or more get 7.5 m flat (one tall storey for big boxes and mills), unless they are a
       school, hospital, apartments, office, parking or church.
     - Otherwise a seeded draw from the OSM id (`mulberry32`) takes a level off 15% of the time, or adds one 15%
       of the time, to multi-storey buildings that aren't a church, school or hospital.

     Then height = levels × 3.3 + 0.6 m, rounded to 0.1 m. The result: 3–6 m 1,387; 6–9 m 5,140; 9–12 m 1,246;
     12–15 m 12; 4 taller, up to 36.9 m (Herman T Stichman Towers, 11 levels tagged). The mean is 7.16 m.
- **Records** (`js/gf-building-records.js`, pure): `createGfBuildingRecords()` turns the rows into:
  - `createBuildingFootprints` records, each with a facade style:
    - **stone** (37): civic buildings: schools, churches, hospitals, town hall, library, post office;
    - **clapboard** (6,820): houses, garages and sheds, and untyped buildings under 250 m² with no shop or amenity;
    - **brick** (932): everything else.
  - storefronts on 150 shops, restaurants and banks of 3.5 m or more;
  - the player's colliders;
  - pedestrian-only obstacles for the road network.

  `neighboursFor()` gives brick and stone buildings blank party walls where they adjoin a neighbour.
- **Meshes** (`js/gf-building-meshes.js`): `building-footprints.js` with `{ base: 0 }` (walls on the flat ground; New
  York's stand on its 0.22 m sidewalk). It makes one merged mesh per 1 km cell and style, from the pre-war masonry
  shader on 3.3 m storeys:
  - brick and stone take New York's two masonry presets' colours;
  - clapboard is a light painted tone (stone `0xd6d0c2`, trim `0x5e5a52`, glass `0x1a2430`).
- **Collision and obstacles:**
  - The player collides with every footprint, up to its roof.
  - Pedestrians walk around them: the walking lines inside a footprint go. That leaves 2,184 edges with tracks
    instead of 2,187, and 9,759 tracks instead of 9,806.
  - The car network is unchanged (tested).
  - No drive-link centreline runs through a building (tested on segment midpoints and every 5 m).
- **Known gaps:**
  - every roof is flat, and only one building has a `roof:shape` tag;
  - 99% of heights are the approximation above;
  - **the 1993 look:** most modern big-box and plaza buildings are probably newer than 1993, but OSM dates only 5 of
    the kept buildings, and one of those after 1993: South Glens Falls Hydroelectric, 1994 (w120878979). Clearing them
    out is a later task.
  - there are no landmarks, interiors or building details.

## Source and licence

Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The raw extracts in
`tools/gf/data/` and the derived `js/gf-geodata.js` are ODbL. The attribution "© OpenStreetMap contributors" appears
here, in `GF_GEO.attribution` and on screen in the debug and game views. No other datasets are used, and no geography is placed
by hand.
