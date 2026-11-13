# Glens Falls geo pipeline (v0)

Turns an OpenStreetMap extract of Glens Falls and South Glens Falls, NY into `js/gf-geodata.js`: the streets as a
node/link road graph, curb-island blocks and water polygons, in a flat local frame. It is separate from the New York
pipeline (`tools/build-geodata.mjs`), which it does not change. It shares only the geometry helpers in
`tools/geo-util.mjs`.

## Build

```sh
bash tools/gf/fetch.sh                  # Overpass -> tools/gf/data/osm_gf_{roads,water,signals,buildings,street_furniture}.json (committed)
node tools/gf/build-gf-geodata.mjs      # tools/gf/data/ -> js/gf-geodata.js, prints summary stats
node tools/gf/build-gf-signals.mjs      # tools/gf/data/osm_gf_signals.json -> js/gf-signals.js
node tools/gf/build-gf-furniture.mjs    # tools/gf/data/osm_gf_street_furniture.json -> js/gf-furniture.js, prints counts
node tools/gf/build-gf-buildings.mjs    # tools/gf/data/osm_gf_buildings.json -> js/gf-buildings.js, prints counts
node tools/gf/build-gf-landmarks.mjs    # tools/gf/data/gf_landmarks.json -> js/gf-landmarks.js, prints applied/pending
node tools/gf/build-gf-lidar-heights.mjs # tools/gf/data/gf_lidar_heights.json -> js/gf-lidar-heights.js, prints counts
node tools/gf/build-gf-trees.mjs        # tools/gf/data/gf_lidar_trees.json -> js/gf-trees.js, prints counts
node tools/gf/build-gf-terrain.mjs      # tools/gf/data/terrain/ -> js/gf-terrain.bin.gz (see Topography), prints sizes
node tools/gf/build-gf-bridges.mjs      # tools/gf/data/osm_gf_roads.json + GF_GEO -> js/gf-bridges.js
# offline, with the two original USGS tiles (728 MB, not committed) in GF_USGS_DIR (default lidar/tiles):
GF_USGS_DIR=lidar/tiles node tools/gf/prepare-gf-terrain.mjs  # checks them, proves the bundle, writes the 8 m ring
GF_USGS_DIR=lidar/tiles node tools/gf/audit-gf-terrain.mjs    # the built terrain against every source pixel
node --test tests/gf-geodata.test.mjs tests/gf-signals.test.mjs tests/gf-buildings.test.mjs tests/gf-landmarks.test.mjs tests/gf-lidar-heights.test.mjs
```

Then open `index.html?city=glensfalls&view=debug` (or `gf.html`) through a local web server for the flat debug view.

Add `&look=x,z,distance` to start the camera looking down at a point (metres) from that distance. The screenshots in
`screenshots/` use `look=0,-150,900` (downtown), `look=300,450,1300` (the Glen Street bridge over the Hudson) and
`look=-1250,-1120,700` (Crandall Pond, a hole in its block). The game-view screenshots (`cc002*`, `cc003*`) name their
places in the PR that added them; `cc003-downtown-glen.png`, `cc003-crandall-pond.png` and `cc003-overview.png` show
the buildings. `cc004-monument-square.png`, `cc004-civic-center.png`, `cc004-finch-pruyn.png` (unchanged, waiting on
data) and `cc004-overview.png` show the landmarks. `cc003b-downtown-before.png` / `-after.png` and
`cc003b-overview-before.png` / `-after.png` show the LiDAR heights, before and after, from identical cameras.

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
| `data/osm_gf_street_furniture.json` | `q_gf_street_furniture.overpassql` | `highway=stop`, `traffic_sign=stop`, `highway=give_way`, `highway=crossing`, `crossing=*` and `highway=street_lamp` nodes (see Crosswalks, stop signs, street lights) |
| `data/osm_gf_buildings.json` | `q_gf_buildings.overpassql` | `building=*` ways and relations, with their member ways and nodes (see Buildings) |
| `data/gf_landmarks.json` | none: compiled by Dave from web sources and OSM | sourced landmark heights, storeys, facades, roof features and the Civil War Monument (see Landmarks) |
| `data/gf_lidar_heights.json` | none: measured by Dave from USGS 3DEP LiDAR | a height and a quality flag per GF building (see LiDAR heights) |
| `data/gf_lidar_trees.json` | none: detected by Dave in USGS 3DEP LiDAR | one row per canopy top: position, height, crown radius and a quality flag (see Trees) |

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
  - `lot` is the property line, in from the curb, roads and water by the sidewalk band (CC-005e: 1.8 m downtown;
    CC-005f: 2.5 m elsewhere; see Sidewalks), with its own `lotHoles`. `lot` is `null` when nothing is left.
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
6. The property line (lot): the island's cells further than `BLOCK_PARAMS.sidewalk` from any roadway, water or outside
   cell, traced the same way (the largest such region per island). CC-005e: `sidewalk` is `gf-sidewalks.js`
   `sidewalkBandAt`, 1.8 m in the downtown envelope (`js/gf-downtown.js`) and (CC-005f) 2.5 m elsewhere; a plain number still
   gives one band all round.

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

- **The ground** (`js/gf-ground.js` `buildGfTerrainGround`): the sourced terrain (see Topography), its vertex colours
  the old flat layers (CC-005e: the band concrete downtown and a lawn-and-walk grey-green elsewhere, the lots a yard's
  green or downtown paving, open ground green; the curbs, lawns and walks themselves are drawn over it, see
  Sidewalks), road ribbons
  at their curb widths for every class draped on it (decks over the bridges), and the water at its own levels. Service
  roads are drawn a shade lighter but not driven. (Before CC-005b everything was flat at y = 0; `buildGfGround`, the flat
  layout, is still what the debug view's helpers draw.)
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
  - kept inside the bbox, on the terrain (on a bridge deck where it is on one) with no raised sidewalks, and out of the
    buildings;
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
- **Signalled crossings (CC-006):** the 24 `crossing=traffic_signals` nodes mark crosswalks (see Crosswalks, stop
  signs, street lights). Their own WALK heads are not drawn.

### Pedestrians

- **Where they walk:** the sidewalk band of each block, between its curb and its lot (`GF_GEO.blocks`; CC-005e: on the
  walk's concrete, see Sidewalks). `js/gf-blocks.js` provides:
  - `blockAt` (the curb outline minus its holes, under a 64 m grid index), which `gf-runtime.js` installs in the city
    runtime;
  - the lots, as obstacles to pedestrians only, so the car network is the same with them as without (tested);
  - `onSidewalk` (on a block, outside its lot).
- **Settings:** 120 pedestrians on two walking lines 0.6 and 1.2 m from the roadway (New York's lie 1.7 and 2.8 m out,
  on its 4.6 m sidewalks), at `sidewalkY` 0.02 above the terrain (CC-005b; a deck where their track runs along a
  bridge), and on the draped asphalt where they cross a road. CC-005e: the lines are set per street side on the walk
  (`gf-sidewalks.js` `insetsFor`: about 0.6/1.2 m downtown, 1.9/2.5 m behind a residential lawn), `onSidewalk` is
  `onWalk`, and the walkers stand 0.02 m over the raised walk.
- **Coverage:** 2187 of the network's 2498 edges have sidewalk tracks (CC-005e: 2126; CC-005f: 2187 again, on the walk's concrete).
- **Crossing (CC-006):** pedestrians cross on painted crosswalks at the signalled junctions (on the WALK of the
  junction's own phase) and at OSM marked crossings (see Crosswalks, stop signs, street lights). Elsewhere they still
  walk around their block.

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
  York's stand on its 0.22 m sidewalk). Since CC-005b the game draws them through `js/gf-building-terrain.js`, each on
  its own base on the terrain (see Topography); `gf-building-meshes.js` is unchanged. It makes one merged mesh per 1 km cell and style, from the pre-war masonry
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
  - 99% of these heights are the approximation above; most are now replaced by measured LiDAR heights (see LiDAR
    heights);
  - **the 1993 look:** most modern big-box and plaza buildings are probably newer than 1993, but OSM dates only 5 of
    the kept buildings, and one of those after 1993: South Glens Falls Hydroelectric, 1994 (w120878979). Clearing them
    out is a later task.
  - there are no landmarks, interiors or building details.

### Landmarks

- **Data:** `data/gf_landmarks.json` (schema `gf-landmarks/1`; its `rules` block documents it) comes from
  `gf-landmarks.zip`, compiled by Dave on 1 Nov 2026 from:
  - the City of Glens Falls 2024 walking tour and the Glens Falls MRA and Queensbury Hotel NRHP forms;
  - glensfalls.com history pages and Glens Falls Chronicle articles;
  - the arena's 2026 promoter guide, the First Presbyterian church brochure and the Glens Falls Housing Authority;
  - SKYDB (heights it credits to Sanborn maps where noted), Finch Paper's history and Bonacio;
  - OSM: building ids from the CC-003 extract, and the monument node.

  The file is 44,652 bytes, sha256 `37582dfb…8127`, and is not edited here.
- **The schema:**
  - **Values:** each is `{ value, source: [https URLs], confidence: high|medium|low, note?, unit?, basis? }`. A null
    value means unsourced.
  - **Entries:** `id`, `name`, `daveRequested`, `status` (`use`, `needs-data`, `no-change`, `flag-only`), `osm`, then
    `height`, `levels`, `facade` (`value.style`: brick, stone or clapboard), `features[]`, `built`, `status1993`,
    `missing[]` and `notes`. The monument also has `kind: 'monument'`, `node { lat, lon }` and `form`.
- **Generator:** `build-gf-landmarks.mjs` writes `js/gf-landmarks.js`, about 10 KB: `GF_LANDMARKS = { source, sha256,
  attribution, srcCode: 3, buildings, features, pending, flagged }`, each list sorted by id. Every applied entry keeps
  its source URLs and the lowest confidence of what was applied.

  It throws on:
  - an unknown OSM id or a duplicate id;
  - an unknown status, feature type or facade style;
  - a value without an `https://` source, or a confidence other than high, medium or low;
  - a building height outside 2.5–60 m or a feature height outside 1–80 m;
  - non-positive levels;
  - a node without a numeric lat/lon.

  A rebuild is byte-identical.
- **Precedence, for `use` buildings:**
  1. `height.value` (metres) wins.
  2. Else `levels.value` × 3.3 + 0.6 m (CC-003's storey rule).
  3. Else the CC-003 height stays.

  A height from 1 or 2 is **`src 3`, a sourced landmark**. A sourced facade style replaces the CC-003 style.
- **Applied at run time:** `js/gf-landmark-records.js` applies the layer on top of the CC-003 records.
  `js/gf-buildings.js` and `js/gf-building-records.js` are unchanged. An overridden record and its collider are copies
  with the new height, `src` and style. Pedestrian and car obstacles are untouched, so the road network and the
  sidewalk tracks are CC-003's. Party walls see the new heights.
- **Applied today:** 18 buildings (16 with a sourced height, 2 with only a facade style), First Presbyterian's flèche
  and the Civil War Monument.
- **CC-004b, LiDAR exterior roofs:** nine landmark heights that disagreed with the measured USGS 3DEP LiDAR roof (see
  LiDAR heights) by more than about 2 m now use that LiDAR value in `gf_landmarks.json`, still as `src 3`, sourced to the
  USGS project report:

  | landmark | OSM | was | now |
  | --- | --- | --- | --- |
  | civic-center | w120878994 | 19.7 m (interior high beam to floor) | 12.1 m |
  | monument-square-333-glen | w126823063 | 38.1 m (SKYDB) | 47.5 m (p90; main roof p50 about 45.9 m) |
  | city-hall | w120878995 | 10.5 m (3 storeys) | 22.6 m |
  | empire-theatre | w301593962 | 10.5 m (3 storeys) | 21.8 m |
  | st-marys-academy | w187527429 | 10.5 m (3 storeys) | 20.4 m |
  | mcechron-house | w741473065 | 8.9 m (2½ storeys) | 13.0 m |
  | colvin-building | w1095429994 | 17.1 m (SKYDB) | 20.5 m |
  | hyde-house | w244907795 | 7.2 m (2 storeys) | 9.5 m |
  | first-presbyterian | w732804477 | 21.3 m (nave interior lower bound) | 18.8 m (the flèche now starts there) |

  These are **2022–23 exterior measurements**, not 1993 reconstructions. For these long-standing downtown buildings
  that is acceptable in a prototype inspired by 1993. Overlays within about 2 m of LiDAR (Cronin, Queensbury, Ordway,
  Rogers, Stichman, Sandy's, Davidson) were left alone, as were the style-only rows, the monument and every pending
  placeholder.
- **Placeholders stay placeholders:** `needs-data`, `no-change` and `flag-only` entries apply nothing. A feature that is
  `needs-data`, or has no sourced height or (unless anchored) position, is skipped. Every skip and every `missing[]`
  item is listed in `GF_LANDMARKS.pending`, Dave-requested first; `flagged` lists the post-1993 buildings (14 Hudson,
  South Glens Falls Hydroelectric), reported only.
- **Shapes** (`js/gf-landmark-meshes.js`): simple procedural geometry, one mesh per material, in the stone and trim
  colours of the feature's facade style (`js/gf-facades.js`). No textures. Only a feature's base and top (and the
  monument's position) are sourced; every other size is a named constant, **approximate, not sourced**:

  | shape | drawn as | approximate sizes |
  | --- | --- | --- |
  | spire (steeple) | square pyramid from the roof to the top, a cross making up its top 2.1 m (First Presbyterian's 7 ft cross) | base 4.0 m (`APPROX_SPIRE_BASE`); cross arm 1.2 m, bars 0.22 m (`APPROX_CROSS`) |
  | tower | square prism from the roof | 5.0 m wide (`APPROX_TOWER_W`) |
  | clock tower | a tower with four clock faces in the trim colour | faces 2.4 m (`APPROX_CLOCK_D`) |
  | dome | half ellipsoid from the roof to the top | 8.0 m across (`APPROX_DOME_D`) unless given |
  | smokestack | tapered cylinder from the ground | radius 2.0 → 1.2 m (`APPROX_STACK_R`) |
  | gable, hip | roof over the footprint's minimum-area rectangle; skipped when the footprint fills under 90% of it | none |
  | obelisk | plinth, tapered shaft, pyramidion and an eagle stand-in block; exactly the sourced total | plinth 3.0 × 1.8 m, shaft 1.4 → 1.0 m, pyramidion 1.0 m, eagle block 0.8 m (`APPROX_OBELISK`) |

  No dome, clock tower, gable or hip is sourced on any landmark yet; tests exercise them on fixtures.
- **The Civil War Monument:**
  - an obelisk at OSM node n1354280283, local (−192.2, −167.4), 12.8 m (42 ft) high, in the stone tone;
  - inside no building and 8.0 m from the nearest drive link (Bay St);
  - the player collides with its plinth. It is no pedestrian obstacle; the nearest sidewalk track is 8.6 m away.
- **Dave-requested:**

  | landmark | OSM | CC-004 |
  | --- | --- | --- |
  | Glens Falls Civic Center (Harding Mazzotti Arena) | w120878994 | 12.1 m, `high`: the LiDAR exterior roof (CC-004b; CC-004 had 19.7 m, interior-derived from high beam to floor 64′6″); roof flat |
  | Finch Pruyn paper mill | w187195024 | pending: no sourced heights; smokestacks and wood pile not placed |
  | Sandy's Clam Bar, 41 South St | w301593952 | 3 storeys → 10.5 m, `medium` |
  | Crandall Public Library | w120878969 | pending: the 1993 massing (1931 building plus 1969 addition) is unsourced |
  | Talk of the Town, 74 Hudson Ave | w695870843 | pending: identity and place sourced, size not |
  | Civil War Monument | n1354280283 | 12.8 m obelisk |
- **Sourced vs approximate vs pending:**

  | | what | where it shows |
  | --- | --- | --- |
  | sourced | 16 heights (`src 3`), 8 facade styles, the flèche top (44.8 m), the monument's height and position | `GF_LANDMARKS.buildings` and `features`, with URLs and confidence |
  | approximate | every other building height (CC-003's rule); the flèche's place (footprint centroid, `low`); every shape size above | `heightRule`, the `APPROX_*` constants, `slopGlensFalls.landmarks.shapes.approx` |
  | pending | Finch Pruyn heights, stacks and wood pile; Crandall's 1993 massing; Talk of the Town's size; First Presbyterian's twin towers; the Church of the Messiah's bell tower and height; the `missing[]` items of applied landmarks | `GF_LANDMARKS.pending`, `slopGlensFalls.landmarks.pending` and the `[gf] landmarks pending for Dave` log line |

### LiDAR heights

- **Data:** `data/gf_lidar_heights.json` came from `gf-lidar-heights.zip`, prepared by Dave on 1 Nov 2026.
  - zip: 36,335 bytes, sha256 `f1b1a8dc…e6e5`;
  - file: 256,592 bytes, sha256 `f4d7d4c7…42fbf`. It is not edited here.
  - It holds one `[height_m, flag]` per GF building, keyed by OSM id, measured against the CC-003 extract (same
    `osmBase` and sha256).
- **Dataset:** USGS 3DEP **NY_Hudson_D22** (work unit NY_Hudson_1_D22): QL2, Sanborn, Riegl VQ-1560 II, flown
  **leaf-off from 8 Nov 2022 to 15 Apr 2023**.
  - [Project report](https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/metadata/NY_Hudson_D22/USGS_NY_Hudson_D22_Project_Report.pdf).
  - Points come from the public EPT; ground from the USGS 1 m bare-earth DEM.
  - USGS 3DEP data are **public domain**; the credit "USGS 3D Elevation Program" is requested, and the game view shows
    it under the OSM attribution.
- **Method:** for each OSM footprint (shrunk by 0.75 m), height = the 90th-percentile elevation of its non-ground,
  non-noise, non-water, non-bridge points, minus the median ground point in a 2–12 m ring around it (the DEM as a
  fallback), rounded to 0.1 m. Parapets and pitched-roof ridges count; spires and chimneys mostly don't. The dataset
  has no building class, so trees over or beside a footprint can contaminate a value, which the flags catch.
- **Flags** (the JSON's `rules`; the first that matches wins). Only `ok` and `reviewed` are applied:

  | flag | rule | count | applied |
  | --- | --- | --- | --- |
  | `reviewed` | hand-checked and kept, although `tall` would flag it | 5 | yes |
  | `sparse` | fewer than 10 roof points | 2 | no |
  | `low` | p90 < 2.0 m: not built at flight time, demolished, or offset | 17 | no |
  | `ground` | p50 < 2.0 m: half the footprint reads at ground level | 30 | no |
  | `mixed` | footprint < 500 m² and p90 − p50 > 6 m: tree canopy over a small building | 446 | no |
  | `tall` | p90 > 6 + √area: implausibly tall for the footprint, usually a tree | 13 | no |
  | `cap` | over 60 m | 0 | no |
  | `ok` | passes every check | 7,271 | yes |

- **Reviewed:**
  - w1191920422, a 56.9 m Lehigh Cement plant structure (tower or silo block);
  - w823185948, a 22.7 m Lehigh plant structure;
  - the two water towers, w302693279 and w302693280, about 37 m;
  - Stichman Towers, w1131808794 (whose OSM levels win anyway).
- **Matched:** 7,784 of the 7,789 GF buildings. The other five:
  - w696012135, w799190076 and w817028882, which straddle the bbox edge;
  - w835350997 (9 Rogers St), which fell on a tile seam;
  - r11213302, the one relation (only ways were measured).
- **Generator:** `build-gf-lidar-heights.mjs` writes `js/gf-lidar-heights.js`, about 177 KB: the 7,276 usable heights
  in `GF_BUILDINGS` order, plus the dataset, dates, method, credit and counts.
  - It throws on an unknown or duplicate id, an unknown flag, `rules.use` other than `ok, reviewed`, a usable height
    outside 2.0–60 m, and an `osmBase` that isn't `GF_BUILDINGS`'s.
  - A rebuild is byte-identical.
- **Precedence** (`js/gf-building-heights.js`, pure). `applyLidarHeights()` copies `GF_BUILDINGS`, which is unchanged,
  and replaces only default-rule rows that have a usable value. Highest first:
  1. a sourced landmark (`src 3`, CC-004, applied on top of the records when it is merged);
  2. an OSM `height` tag (`src 0`) or `building:levels` (`src 1`);
  3. **LiDAR, `src 4` = `lidar 2022-23`**;
  4. CC-003's default rule (`src 2`, an approximation).

  The records, colliders, storefronts and party walls all follow the new heights. The obstacles are the same polygons,
  so the car network and sidewalk tracks don't change.
- **Sources:** `[src 0, 1, 2, 3, 4]` goes from `[0, 49, 7740, 0, 0]` to **`[0, 49, 509, 0, 7231]`: 92.8% measured**.
  - 45 usable values are on buildings with OSM levels and aren't applied.
  - The 509 still on the default rule are 506 flagged values and 3 unmatched buildings.
  - With CC-004's landmarks on top (they win), the game's final sources are **`[0, 47, 509, 16, 7217]`**: 14 landmarks
    that would otherwise be LiDAR and 2 that would be OSM levels (333 Glen St, Stichman Towers) are `src 3`. The two
    style-only landmarks (Church of the Messiah, First National Bank) show their LiDAR heights, 10.7 m and 13.6 m.
  - Where LiDAR and a landmark disagree, the landmark wins. Since CC-004b the nine landmarks that disagreed by more
    than about 2 m carry the LiDAR value themselves (see Landmarks), so the remaining differences are within about
    2 m.
- **Heights:**
  - the mean goes from 7.16 m to 7.29 m; the max is 56.9 m (the Lehigh plant) and the min 2.3 m;
  - 3 m bins: 0–3 m 50, 3–6 m 1,984, 6–9 m 4,362, 9–12 m 1,206, 12–15 m 144, 15–18 m 18, 18–21 m 12, 21–24 m 5,
    24–27 m 2, 27–30 m 1, 33–36 m 1, 36–39 m 3, 54–57 m 1;
  - downtown changes most: Cronin 24.7 m, Queensbury 17.9 m, City Hall 22.6 m, Empire Theatre 21.8 m.
- **Known gaps:**
  - **Era:** the heights are as flown in **2022–23, not 1993**. Buildings built or raised since 1993 are measured as
    they stand: 14 Hudson (w682532345, built 2016–17) is 20.0 m, and the Lehigh plant tower's date is unknown. Houses
    built after spring 2023 (the w13590970xx subdivision) read as ground and keep the default rule. Nothing post-1993
    is hidden or lowered yet.
  - **Roofs:** p90 includes pitched-roof ridges, so pitched houses come out a little taller than their eaves.
  - **Flagged and unmatched:** 506 flagged values and 3 unmatched buildings keep the approximation.

### Trees

- **Data:** `data/gf_lidar_trees.json` came from `gf-lidar-trees.zip`, prepared by Dave.
  - zip: 719,521 bytes, sha256 `8e70dc7d…f580`;
  - file: 3,357,577 bytes, sha256 `d52158dd…35fd`. It is not edited here.
  - Each row is `[lon, lat, height_m, crown_r_m, flag]`, one per canopy top.
- **Source:** USGS 3DEP **NY_Hudson_D22** airborne LiDAR, flown **leaf-off from 8 Nov 2022 to 15 Apr 2023**, with the
  USGS 1 m bare-earth DEM as the ground. It is public domain, and the credit "USGS 3D Elevation Program (3DEP),
  NY_Hudson_D22 LiDAR, 2022-23" is requested. The building masks used in preparation are © OpenStreetMap contributors
  (ODbL 1.0) and Overture Maps buildings.
- **Method:** the point cloud has no vegetation or building class, so vegetation was inferred.
  - Points 2–50 m above the DEM, off every building footprint (grown 1 m), make a 1 m canopy height model.
  - Its local maxima are the tree tops. Each top gets its height (the highest return near the peak) and a crown
    radius (the equal-area radius of its canopy).
  - Each top gets one flag; the full method is in the JSON's `meta.method` and `meta.params`.
- **Flags:** only `ok` is drawn.

  | flag | count |
  | --- | --- |
  | `ok` | 77,976 |
  | `building-edge` | 2,775 |
  | `in-road` | 2,340 |
  | `sparse` | 1,603 |
  | `structure` | 1,550 |
  | `water` | 453 |
  | `small` | 369 |
  | `near-wall` | 154 |
  | `low` | 138 |
  | `tall` | 114 |
  | `linear` | 31 |

  That's 87,503 candidates. Usable heights run 3.0–40.0 m (median 19.7 m), and crown radii 1.5–8.8 m (median 4.4 m).
- **Generator:** `build-gf-trees.mjs` writes `js/gf-trees.js`, about 1.79 MB (0.53 MB gzipped): the usable rows only,
  in JSON order, as a flat `[x, z, h, r, …]` array at 0.1 m.
  - It throws, naming the row or value, on: `rules.use` ≠ `["ok"]`, unexpected `fields`, an unknown flag, a usable
    row outside the bbox, a usable height outside 3–40 m, a usable crown outside 1.5–9 m, two rows at one lon/lat, and
    counts that don't match the rows.
  - A rebuild is byte-identical.
- **Placement** (`js/gf-tree-placements.js`, pure): one renderer site per usable top, where it was measured. As a
  safety net it skips, and never moves, a trunk in water, in a carriageway or inside a building footprint.
  - Today that skips the **6** bank trees whose rounded positions fall just inside the river, the reservoir or a pond,
    and nothing else: **77,970 trees are placed**.
  - Each site's `scale` is `h / H` and its crown stretch `sx = sz` is `r / (R · scale)`, clamped to 0.6–1.6. `H` and
    `R` are the renderer model's height and crown half-width at scale 1 (plane 12.61 / 5.00 m, locust 9.88 / 4.79 m,
    elm 13.50 / 5.57 m, measured from `trees.js`'s LOD-0 geometry). So a drawn tree is about as tall and wide as
    measured.
  - Every tree is draw-distance tier 2 (950 m). Tier 1 (1,600 m) nearly doubled the frame time of the overview from
    300 m (headless WebGL2: 1.47 s → 2.85 s a frame, 108 → 929 draw calls); tier 2 for the trees under 12 m alone gave
    2.62 s; tier 2 for all gives 1.87 s (487 draw calls). No tree is dropped from the data.
- **Renderer:** the shared `js/trees.js`, unchanged, with no New York tree data. GF never loads `tree-geodata.js` or
  `tree-placements.js`.
  - It gets no building colliders: the data already keeps tops about 1 m off every wall, and real crowns overhang
    roofs. `slopGlensFalls.trees.diagnoseBuildingColliders()` counts what colliders would drop.
  - The player bumps into a small trunk collider per tree (half-side `max(0.25, 0.03 h)`, up to `min(4, 0.35 h)` m)
    and can fly over.
- **Known gaps:**
  - **Era:** trees as flown in **2022–23, not 1993**. Nothing planted, grown or felled since 1993 is corrected, and
    nothing post-1993 is hidden.
  - **Species:** LiDAR gives none. The renderer's species slot (plane, locust, elm) is a **visual shape mix only**,
    seeded from the position (40% elm-shape, 35% plane-shape, 25% locust-shape). These are not surveyed species.
  - **Leaf-off scan, summer foliage:** the scan was leaf-off, but the renderer draws summer leaves. Small and thin
    deciduous trees are undercounted (`sparse`), some big crowns show as two trees, and touching crowns in woods as
    one.
  - **Street trees:** 2,340 real street trees whose crown peak overhangs the road are left out (`in-road`), not moved
    to the verge. Some trees hugging houses are lost as `building-edge`.
  - **Draw distance:** at tier 2 no tree is drawn beyond 950 m from the camera, so from high up the canopy ends in a
    visible line (see `screenshots/cc005-overview-after.png`). The trees are still in the data and reappear as the
    camera nears.
  - **Pedestrians:** 1,278 placed trunks stand in the 1.8 m sidewalk band (by `gf-blocks.js` `onSidewalk`; about 1,276
    by the data's own count), and pedestrians can walk through them; trees are not pedestrian obstacles yet.

### Topography (CC-005b)

The whole play area stands on the USGS 3DEP bare-earth DEM: hills, the river gorge, the quarry and the Thrill Hill /
Cole's Woods relief, with every road, car, walker, building, tree and pond on it.

- **Source:** USGS 3DEP **NY_Hudson_D22** 1 m DEM (bare earth, hydro-flattened), flown leaf-off November 2022 – April 2023,
  so **2022–23 ground, not a 1993 landform**. Public domain; credit "USGS 3D Elevation Program". Metadata
  <https://www.fisheries.noaa.gov/inport/item/73809>; tiles
  `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/NY_Hudson_D22/TIFF/`.

  | | |
  | --- | --- |
  | original tiles | `USGS_1M_18_x60y480_NY_Hudson_D22.tif` 353,057,146 bytes `e7a48ffc…b2a3`; `…x61y480…` 375,244,353 bytes `76e5f1f3…9933` (not committed) |
  | horizontal | EPSG:26918 as the TIFFs encode it (the metadata describes NAD83(2011) UTM 18N: reported, not relabelled) |
  | vertical | NAVD88 (GEOID18) metres |
  | OSM to UTM | `js/gf-utm.js`, Krüger to n⁶ on GRS80, WGS84 taken as NAD83 (as pyproj's default, which made the bundle's anchor; matched to < 1 µm): consistent, not survey-grade (the realisations differ ~1–2 m) |
  | game height | **y = NAVD88 − 104.788276672**: the sourced anchor, OSM node 221400851 (Glen / Bay / South Street), whose bilinear 1 m sample that is (not a surveyed road deck). x and z are `GF_GEO`'s frame, unchanged |
  | coverage | the established bbox (W −73.680, S 43.290, E −73.610, N 43.330) inside the bundle's UTM rectangle 606980–612800 E, 4793840–4798420 N (every 1 m pixel valid) with ≥ 19.6 m to spare; the player's bounds (bbox + 20 m) reach at most 0.7 m past it, into the blend towards the ring; the 8 m ring (the same source's means) reaches 426 m beyond for the view and the helicopter |

- **Inputs** (`data/terrain/`, the CC-005b bundle, unedited; both `SHA256SUMS` verify): `gf-dem-candidate-2m.tif` (2 × 2
  means), `gf-dem-refinement-patches-1m.tif` (native 1 m where the 2 m reconstruction is off by > 0.25 m, + 8 m halo),
  `thrill-hill-reference-dem-1m.tif`, the provenance JSON, the audit lattice and the bundle's own script.
  `prepare-gf-terrain.mjs` (offline, with the originals) checks the tiles' bytes and hashes, rebuilds the aligned 1 m
  lattice (each reference pixel centre takes the source pixel it falls in, x60 then x61, valid samples only) and proves
  the bundle is that lattice: **all 6,663,900 candidate pixels and all 8,236,080 patch pixels equal it, to the bit**.
  It writes the ring (`gf_dem_ring_8m.f32`, 8 × 8 means) and `gf_terrain_prepare.json`. Nothing is filled or smoothed:
  a missing sample stops it.
- **Runtime data** (`build-gf-terrain.mjs`, repo inputs only, byte-identical on rebuild): `js/gf-terrain.bin.gz`,
  **6,853,989 bytes** (16.1 MB inflated): the 2 m base (2910 × 2290) at 5 mm steps, **12,711 native 8 m tiles** (810,176
  1 m nodes, to 1 cm) wherever a native sample misses the base's reconstruction by > 0.25 m (the bundle's own threshold),
  and the ring, each grid MED-predicted and split into byte planes. Fetched from this site with the modules (never from
  USGS); about 18 MB of typed arrays in memory.
- **The surface** (`js/gf-terrain.js`): a lattice of 1 m nodes at the source pixel centres; a node is its native value
  where a tile holds it, else the base's bilinear reconstruction; between nodes, two triangles per cell (north-west to
  south-east diagonal). Outside the lattice the ring, blended in over 24 m; beyond the ring, `valid: false` (NaN), never
  a flat fill. Continuous everywhere (tested along lines across native tiles and into the ring).
- **Error against the original 1 m source** (`audit-gf-terrain.mjs`, every one of the 25,224,904 pixel centres in the
  exact bbox; `data/terrain/gf_terrain_audit.json`), with the bundle's 2 m candidate for comparison:

  | | n | MAE | p95 | p99 | max | > 0.25 m |
  | --- | --- | --- | --- | --- | --- | --- |
  | candidate (bilinear 2 m) | 25,224,904 | 0.021 | 0.066 | 0.151 | 6.925 | 91,119 |
  | **game surface** | 25,224,904 | **0.018** | **0.057** | **0.106** | **0.250** | **0** |
  | on roads | 1,946,453 | 0.013 | 0.035 | 0.058 | 0.248 | 0 |
  | river banks / shores (10 m) | 603,232 | 0.020 | 0.097 | 0.160 | 0.250 | 0 |
  | under bridge decks | 14,883 | 0.018 | 0.089 | 0.156 | 0.242 | 0 |
  | hill reference crop | 1,074,291 | 0.020 | 0.058 | 0.100 | 0.249 | 0 |

  Tolerance: 0.25 m at any pixel (the bundle's selection threshold; a tighter one inside the patches would not lower the
  worst case outside them). The bundle's hill reference crop (`thrill-hill-reference-dem-1m.tif`) equals the source
  pixel for pixel (1,078,800 of 1,078,800), but **the game surface there is not exact**: MAE 0.020 m, p95 0.058 m, max
  **0.249 m** (x −2597.5, z −1737.9, a base-2 m node just within the keep threshold). Each subset's ten worst
  locations (true maxima, whatever their size) are in the audit JSON.
- **The mesh** (`js/gf-terrain-lod.js`, no three.js, drawn by `js/gf-terrain-mesh.js`): a quadtree of 32 × 32-cell
  chunks, level n every 2ⁿ-th node (a decimation; level 0 is the surface itself). A chunk splits while the camera is
  nearer than 1.2 × its size (level 0 within ~77 m) **or while its drawn error exceeds 0.005 of its distance** (~4 px
  at 900 px and a 60° view): each chunk's error is its largest |drawn − query| over its lattice nodes, measured by
  `tools/gf/audit-gf-terrain-mesh.mjs` (`js/gf-terrain-lod-errors.js`, cm rounded up). Coarser levels take a larger
  depth offset, so overlays on the exact surface stay on top. Where a chunk borders a coarser one its border vertices
  are moved onto that neighbour's edge (stitched): no crack, no skirts. Each level's visible chunks are one mesh.
- **The drawn terrain against the query** (`audit-gf-terrain-mesh.mjs`, `data/terrain/gf_terrain_mesh_audit.json`;
  exact, not sampled: drawn triangles and the query are both linear on lattice triangles, so every node is checked).
  Worst |drawn − query| per level over the whole lattice (location; on roads / banks / the hill):

  | level | spacing | worst | at (x, z) | p95 | roads | banks | hill |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 0 | 1 m | **0** | | 0 | 0 | 0 | 0 |
  | 1 | 2 m | 12.0 m | 2744.7, 494.7 (gorge wall) | 0.029 | 2.11 | 7.78 | 0.70 |
  | 2 | 4 m | 15.9 m | 2741.7, 494.6 | 0.097 | 3.12 | 15.2 | 1.19 |
  | 3 | 8 m | 18.2 m | 2734.7, 498.5 | 0.265 | 4.16 | 12.9 | 1.71 |
  | 4 | 16 m | 22.0 m | 2757.8, 492.9 | 0.62 | 9.74 | 19.1 | 3.26 |
  | 5–8 | 32–256 m | 26–44 m | gorge, 2392, 1046 | 1.3–7.1 | 13–39 | 21–29 | 5.7–9.5 |

  Stitched seams (each level against every coarser neighbour, every edge) are in the JSON. Before the error rule the
  LOD chose by distance alone, so these walls and banks were drawn metres off a few hundred metres away, under cars,
  trees and water edges standing on the query. With it, the game's own selection from ~60 cameras (town, river, hill,
  the hill top, the overview, a grid of street-level points): **no crack**, every chunk within ~4 px (5.1 px at worst,
  a stitched seam), **≤ 0.13 m within 50 m** (a level-0 seam stitched onto a 2 m neighbour), 112–576 chunks (median
  274; distance only: ~190).
- **The surface contract** (`js/gf-surface.js`, one instance in `gf-runtime.js`, `slopGlensFalls.terrain.surface`):
  `ground(x, z)` (bare earth), `deckAt(x, z, { dir })`, `support(x, z, nearY)` (what stands there: a deck within 1 m
  above nearY, else the ground), `road(x, z, dirX, dirZ, nearY)` (a deck the vehicle runs along, or the level it is on),
  `water.surfaceAt(x, z)`, `normal(x, z)`, `info(x, z)` (with `source`: native-1m / base-2m / blend / ring-8m /
  outside, and `resolution`). **CC-005c** places paths, props and feet with `support()` / `ground()` and `normal()` here
  (tested example: a table's feet on the hill crop), never with a second terrain.
- **Consumers:**
  - roads and service roads draped (`js/gf-drape.js`, 3 cm above the surface): along every line within 2 cm of the
    surface at each lattice line it crosses; 2–16 quads across, chosen by cross-sections every 4 m (within 8 cm at
    every lattice crossing); adaptive round joins at link ends and wedges on the outside of bends. Every triangle's
    interior, sampled every 0.5 m (`tests/gf-terrain.test.mjs`): over the whole network about 1.4 in 10,000 samples
    are more than 0.1 m off, the worst 0.40 m at abutment walls (a 3.6 m drop within 2 m beside Murray Street's deck,
    the bank across Bush Street's approach), which lines 0.5 m apart cannot follow. Road paint on them (`road-paint.js`
    opt-in `surfaceAt`), in 1 km chunks;
  - traffic (`traffic.js` opt-in `surfaceAt`): every vehicle at its road's height, pitched and rolled by its four wheels,
    keeping to the level it is on (deck or ground); wheels, shadows, lamps, sparks follow. Its level is resolved before
    contacts, and bodies whose heights do not overlap (a car on a deck, one on the road beneath; the player on another
    level) never collide or yield to each other (`tests/gf-traffic-levels.test.mjs`); New York sets no level;
  - pedestrians (`pedestrian-system.js` opt-in `groundAt`): feet on the terrain, a deck where their track runs along one;
  - the player (`controllers.js`, `cameras.js`, opt-in by `world.groundNormalAt`): walking, cycling and driving follow
    grades (a wheel climbs up to 45° or a 0.35 m step, follows drops up to 50°, falls off anything steeper), the car and
    bike pitch (and the car rolls) with the ground; the helicopter flies free above a floor 0.25 m over the ground or a
    deck; teleports, spawn and saved positions (a flat-era save included) land on the surface; the follow cameras keep
    0.55 m above the ground under them;
  - buildings (`js/gf-building-bases.js`, drawn by `js/gf-building-terrain.js`): heights unchanged, above a
    **base = the median ground in a 2–12 m ring round the footprint** (the reference the CC-003b LiDAR heights were
    measured from); roofs level at base + height; walls down to the lowest ground under them (no floating corner),
    uphill feet in the ground; storeys counted from the base (`tsl-materials.js` opt-in `footprintBase`); colliders
    foundation to roof. 103 buildings stand where the ground falls > 1 m under their walls (10 > 3 m) and 124 where it
    rises > 1 m (9 > 3 m); the extremes are the mills built into the gorge at the falls (SCA Tissue 17.9 m, Finch Paper
    10.3 m / 8.1 m buried), single footprints over terraced banks;
  - landmark features keep their CC-004 / CC-004b heights: the First Presbyterian spire from its church's roof (26 m), the
    Civil War Monument on the ground at its node (12.8 m);
  - trees (CC-005 data unchanged): each site's y and its trunk's vertical range follow the bare earth, nothing else;
  - signal posts on the ground;
  - the WebGL 2 fallback (no WebGPU) draws the street crowd from a data texture (`pedestrians.js` /
    `pedestrian-system.js` opt-in `textureFallback`): that backend reads a storage buffer as a plain vertex attribute,
    ignoring the bone index, which drew the people below y = 0 as sky-sized triangles. WebGPU is unaffected; New York
    keeps the default.
- **Bridges** (`js/gf-bridges.js` from the OSM `bridge=yes` ways, matched to their road-graph segments): a bare-earth
  DEM does not measure decks, so a deck runs straight between the terrain at its two abutments (or the ground, where
  that stands higher right by them), and within 12 m of an end takes the ground's cross-slope, so it meets the
  approach road across its whole width (it was up to 1.85 m off at a curb, Bush Street): 16 decks from 17 ways,
  Cooper's Cave Bridge ~20 m above the water below the falls,
  the Northway's ~5–6 m over the roads beneath. Each is drawn as a 1 m slab with 0.9 m parapets, whose railings keep the
  player on it. No piers, no new spans; deck heights are inferred, not surveyed (flagged). Layer −1 / tunnel ways
  (Warren Street's underpass) and the untagged layer-1 service ways (parking ramps) stay on the DEM.
- **Water** (`js/gf-water.js`): the DEM over water is the hydro-flattened surface, not a bed; nothing underwater is
  invented. A body mostly flattened at one level (26: the ponds, the reservoir pool at −23.0, the river above the
  Feeder Dam at −18.9) is a plane at that level; a reach that falls or steps (21: the river below the falls, −38.2 to
  −41.8 over 2.5 km, the canals, the treatment basins) takes the level of its nearest flattened cell, capped by the DEM,
  so it falls downstream, follows the falls down and never climbs a bank. OSM x/z unchanged; islands stay dry.
- **Uncertainties:** deck heights are inferred (abutment to abutment); the WGS84 / NAD83 mapping is consistent, not
  survey-grade; building bases are one level per footprint (the mills on the gorge are the worst fit); the dam faces
  and falls are only as sharp as the 1 m DEM; ring terrain (beyond the play area) is 8 m.
- **Screenshots:** `screenshots/cc005b-{downtown,river,hill,overview}-{before,after}.png` (helicopter views from the
  same teleports: x, z, heading and altitude over what is beneath, so the camera is lower or higher where the ground is).

### Trails and Thrill Hill (CC-005c)

Walkers, the player and the cyclist can follow the sourced paths through Crandall Park and the shortest sourced
corridor through Cole's Woods to Thrill Hill. On the hill a **fictional** keg party burns at night and leaves ash, charred
logs and red cups by day.

- **Inputs** (`data/trails/`, the CC-005c kit, unedited; its `SHA256SUMS` verifies every committed file): the OSM
  extracts (`osm-park.xml`, `osm-crandall-context.xml`, `osm-coles-corridor-context.xml`), the candidate GeoJSONs, the
  county ski loop and its DEM profile, and the Thrill Hill search area. The two map PDFs and the PNGs are referenced by
  hash and not committed: no reuse grant for the artwork was established.
- **Selection** (`select-gf-crandall-trails.mjs` → `data/gf_crandall_trails.geojson`, regenerates byte for byte):
  - **park paths:** the OSM park walking ways;
  - **park drives:** the park's `foot=designated` service drives. They are the only links between the park's path
    groups (Dave: "don't isolate"). They are already drawn as the game's service roads and are not driven, so they are
    not drawn again;
  - **Cole's Woods:** only the shortest foot-permitted route over the OSM network from each woods entrance (Park View
    Avenue at the Fire Road curve, 742.8 m; Angel Lane, 969.7 m) to Thrill Hill. Ways are kept as node ranges, so the
    rest of the woods stays out.
  - Everything else is listed with a reason: 46 excluded features.
- **Thrill Hill:** Dave marked the **Camel Humps vicinity** on a schematic map (local knowledge, not an official name;
  the map is not reproduced here). The game needs one point, so it uses a **provisional interpretation**, not a
  location Dave confirmed:
  - the anchor is the **trail crest**: the highest point of the game's terrain along the accepted hill path (OSM way
    1089938465), at 117.18 m NAVD88. The generator splits the path there, so walkers make for the top itself;
  - county ski loop vertex **#137** (117.39 m), the loop's highest vertex on the first hump, is the reference the
    route selection started from. It lies 10.7 m from the crest. That is a separation between two candidate points
    on unsurveyed lines, **not a measure of accuracy**.
  - `screenshots/cc005c-hill-candidates.png` compares every candidate, labelled, on the CC-005b terrain:
    - the crest;
    - the path junction below it;
    - county vertices #134–#144;
    - six terrain summits inside the kit's 65 m search area, including S1, 117.92 m, 9.7 m from the crest.
  - The choice is for review.
- **Graph** (`build-gf-crandall-trails.mjs` → `js/gf-trails.js`, regenerates byte for byte, tested): 46 edges in 3
  components, with 7 entrances.
  - Lengths: path 2,027.7 m, footbridge 97.3 m, drive 1,494.1 m.
  - Each line is cut where it reaches its street's outer walking line (the road's half width + 1.2 m).
  - Widths: the one tagged path is 1 m; the others are a **2 m gameplay assumption** (labelled in every edge's
    `widthBasis`); the drives take their service road's 5 m.
  - The generator refuses coordinates outside the town, a missing source or access tag, impossible widths, duplicates,
    zero-length edges and any component without an entrance.
  - It also refuses any edge whose **whole surface** meets mapped water (footbridges excepted) or a building footprint.
    The test is exact, not sampled (`js/gf-trail-clearance.js`): each segment is swept by a disc of half the path's
    width, a capsule. The union of those capsules contains the drawn ribbon, its round joins and the outside of every
    bend, so an obstacle anywhere on the surface is found, including between any two sample lines or stations.
- **Entrances:** a street entrance joins the game's own sidewalk on the same side of the street. Park View Avenue's
  meets it at the Fire Road curve, where the game's sidewalk stops short of the junction.
  - At run time (`js/gf-trail-network.js`), each trail end attaches to the nearest point of a sidewalk track, at most
    15 m away.
  - The straight connector never comes within 1 m of a street's centre line, so no street is crossed.
  - Swept by a 0.48 m body, the connector must also clear water, buildings and every kept trunk (exact capsule test,
    in the game and the tests).
  - Measured attachments run from 0.5 m to 9.7 m; each connector's nearest obstacle is at least 8 m away.
  - Angel Lane has no sidewalks in the game's network, so it is an entrance for the player only.
  - Walking from the park to the hill uses the existing sidewalks and the signalled Glen Street / Fire Road junction.
    CC-005c added no crosswalks; CC-006 paints one on each arm of that junction.
- **Footbridges** (5, 97 m): `gf-surface.js` has an opt-in `footDecks` list using the road decks' rule: straight between
  the ground at the two abutments, never under it, as wide as the bridge. `support()` stands on these decks; `road()`
  and `deckAt()` (vehicles) never see them. Each is drawn as a plank deck with post-and-rail sides, and the rails are
  player colliders, stopping 1.2 m short of each end. The decks stand at most 0.64 m over the ground; two of them cross
  mapped pond water.
- **Trees:** 70 LiDAR trees are left out (`placeGfTrees` opt-in `exclude`; 11 in the park, 59 in the woods). These are
  exactly the trees whose trunk square reaches a path or footbridge corridor: half the path width + 0.48 m, the player's
  body. Drives are not included. No tree is moved, and none is removed for the party.
- **Walkers:** pedestrians whose index is 3 modulo 10 (12 of the 120) are trail walkers. `pedestrian-system.js` has an
  opt-in `routes` wrapper, and New York is unchanged.
  - At a split sidewalk a trail walker turns in 7 times in 10. It walks a lane 0.4 m right of the path's centre (1 m on
    a drive), using a shortest-path table to a target, then leaves by an entrance of the same component.
    - In the woods, the target is the crest.
    - In the park, it is a path node.
  - On a trail the walker stands on the drawn path (ground or deck + 3 cm). Nobody dodges sideways off a trail.
- **Thrill Hill party** (`js/gf-thrill-hill-plan.js` holds the layout, schedule and the scene's provenance;
  `js/gf-thrill-hill.js` draws it): **a fictional scene**. It depicts no real event or person.
  - Placement is a fixed rule, not a survey. The fire goes at the first site 4.5–7.5 m off the trail centre line beside
    the crest that has:
    - no kept trunk within 3.5 m (it found 12.4 m);
    - its ring at least 1 m beyond the path's edge;
    - no water;
    - < 0.6 m of relief across the circle.
  - A circle of 8 of the game's generic people (their own `PersonCrowd`) stands round it, with the keg 3.4 m away.
  - The fire's stone ring and the keg are player colliders; the cups are visual only.
  - **Night** is the twilight and midnight presets: `interiorGlow` above 0.65, the threshold that switches on vehicle
    lamps. At night the fire burns with flames, embers and one flickering point light (a clustered light, parked and
    dark by day), and the group walks up the trail from 45 m or more down it.
  - From the crest, each person takes a route to their place round the fire ring, the keg and every kept trunk. The
    route is a 0.25 m grid search kept 0.45 m from each (body 0.35 + 0.1 margin), then straightened only where the
    straight line, swept by the body, stays clear. The way out is the same route walked back. A place with no clear
    route stays empty; none does today.
  - Every piece of every route, and every step taken through 15 simulated minutes of random clock changes (reversals
    mid-way included), clears the fire, the keg and the trunks by the body's width (tested exactly).
  - **Day** is golden hour and midday. The group walks away, leaving ash, charred logs, the keg and 14 empty red cups.
  - The first setting on load places everyone at once; later changes send them walking.
  - The schedule is deterministic and idempotent. A repeated setting changes nothing. Each person exists once through
    any sequence of changes and through `advance()`.
  - `?party=off` leaves the scene out.
- **Diagnostics:** `slopGlensFalls.trails` (data, network, meshes, `walkers()`), `slopGlensFalls.party` (scene, plan,
  `stats()`), `slopGlensFalls.selectTime(id)`.
- **Uncertainties:** the trails existed in 1993 according to Dave; the exact 1993 alignments are not documented. The
  OSM geometry is current, and widths other than those tagged are assumed. The hill point is a provisional
  interpretation of a vicinity mark (see the candidate comparison); no accuracy is claimed for it. The party is
  invented.
- **Screenshots** (`screenshots/cc005c-*`):
  - before/after pairs from the same cameras: woods path, Crandall Pond footbridge, Park View and Glen St entrances,
    the hill crest, and the hill's side/oblique relief;
  - the party from one camera at golden hour, twilight, midnight and the morning after;
  - the coverage diagram, the hill layout and the labelled hill candidate comparison.
- **Tests:** `tests/gf-crandall-trails.test.mjs` covers:
  - the kit's hashes, and both generators regenerating byte for byte;
  - malformed inputs;
  - accepted-only sources;
  - lanes clear of buildings, water (off a deck) and every kept trunk;
  - foot decks;
  - the exact tree set;
  - entrances and their connectors;
  - seeded walkers entering, reaching the crest and leaving;
  - the party's layout and its night/day schedule;
  - the wiring.

### On foot from a vehicle (CC-005d)

In Glens Falls, **F** gets you out of the taxi or a landed helicopter onto safe ground beside it, and back in.
`js/vehicle-exit.js` is pure: no three.js and no city names. The city passes it a probe; `gf-main.js` wires it.
New York does not load it.

- **The key and the HUD:** `F`. A chip in the controls hint says what F does now (*Exit taxi*, *Land & exit*,
  *Exit helicopter*, *Enter taxi*, *Enter helicopter*) or, dimmed, why not (*stop to get out*, *too high to land*,
  *over water*, *no room alongside*, …). A refused press shows its reason for 1.5 s. The mode buttons and keys 1–4
  keep their old meaning (switch to that entity wherever it is); F owns walking to and from a parked vehicle. Not from
  the bicycle.
- **Getting out of the taxi:** only below 1 m/s. The search tries, in order:
  1. the driver's (left) side, then the right, at 1.65, 2.4 and 3.2 m out from the centre line, each at 0.6, −0.6,
     1.6 and −1.6 m along;
  2. behind and then in front, 1.2 and 2.2 m beyond the bumpers.

  It takes the first spot that passes every check:
  - finite ground under it (`GF_SURFACE.support`, seeded with the taxi's level, so a deck stays a deck);
  - not mapped water at that height;
  - no more than **1.0 m** above or below the taxi's own ground (never off a bridge or a retaining wall);
  - the ground within 0.6 m rising or falling no more than **0.35 m** (the wheels' climb step);
  - clear of the taxi's footprint by the walker's 0.48 m body;
  - clear of every building, trunk, footbridge rail and party prop collider, and any parked vehicle (the walker's own
    contact test).

  A spot off the carriageway (a kerb island, the park, a trail) is preferred. Only if none passes does it use the
  first clear road shoulder rather than refuse. If nothing passes, F is refused with the commonest reason.
- **The helicopter:** it sets down only if all of these hold:
  - under 2 m/s horizontally and 1.5 m/s vertically (not counted at its hover floor, where it cannot sink further);
  - its origin within 1.2 m of the support (its hover floor is 0.25 m);
  - support at all four skid ends and the centre, none of it water, with the skid ends within 0.5 m of each other.

  When several fail, the HUD gives where before how: no ground, over water or too high, then too fast or descending,
  then too steep. Roofs are not support in the surface contract, so a helicopter over a roof is simply too high. Set down, its skids
  sit on the highest support under them and its rotor stops. It stays on its skids, ignoring the throttle, until the
  pilot climbs (Space/E). Getting out follows the taxi's rules round its own footprint: the skids, back to the tail.
- **Getting in:** within 2.5 m of the taxi's body or 3.0 m of a landed helicopter's (it reaches every spot the exit
  search can choose, so you can always get back in where you got out). The walker is then aboard:
  hidden, no longer strolling about on its own, with no body. Pressing 1 brings it back where it was left.
- **Parked vehicles:** any vehicle not being driven stays exactly where it was left (the taxi whenever you are not in
  it, the helicopter once landed and empty).
  - **To the walker:** it is a solid body (`controllers.js` `setParkedColliders`).
  - **To traffic** (`traffic.js` opt-in `setParked`): AI cars keep behind it in their lane like a stopped car, change
    lanes only clear of it, and never spawn within 25 m of it. Nobody drives it or pushes it. On a one-lane street they
    wait behind it.
- **The walker drawn everywhere:** the player's own walker and cyclist rider now take the street crowd's WebGL 2
  data-texture fallback when the world asks for it (`controllers.js` opt-in `world.textureFallback`, set in
  `gf-runtime.js`). Without it that backend never drew the player on foot. WebGPU is unaffected.
- **New York:** neither call is made, so both lists stay empty and every path is unchanged. The controllers' new
  branches key on flags only this module sets (`landed`, `boarded`); `tests/gf-vehicle-exit.test.mjs` checks the
  defaults (the idle walker strolls on, the helicopter hovers at its old floor, no parked bodies).
- **Not included:** touch and gamepad bindings, getting off the bicycle, door or seat animations, interiors, saving the
  parked state across reloads (a reload restores the vehicles where they were, unparked).

### Sidewalks (CC-005e)

The street edges as they looked: a raised granite curb, a grass tree lawn on residential streets, and concrete walks in
5 ft flags. Lots no longer read as the same pale slab as the walk. Modules: `js/gf-sidewalks.js` (layout, no three.js),
`js/gf-sidewalk-strips.js` (the strips as buffers), `js/gf-sidewalk-meshes.js` (materials, cells), `js/gf-downtown.js`
(generated by `tools/gf/build-gf-downtown.mjs`).

**Design basis.**

| | what | source |
| --- | --- | --- |
| Dave (local knowledge, from memory, not a survey) | 1993 residential streets: a grass strip between a granite curb and the sidewalk; downtown: concrete to the granite curb, no grass strip; granite: grey speckled stone, a visible face | Dave, 2026-11-09 |
| sourced | downtown = the Three Squares Historic District (NRIS 84003420, listed 1984-09-29; boundary increase NRIS 100008374, 2022-11-15), roughly bounded by South, Glen, Maple and Ridge Sts (1984) and Broad, Maple, Pine and Glen Sts (2022) | NRHP listings (nomination map not fetched: see below) |
| sourced (modern practice, not 1993 proof) | a 5 ft walk with a 4 ft snow-storage strip between curb and walk (Goodwin Ave); driveway aprons in concrete | City of Glens Falls city-engineer agenda item, encroachment permit |
| sourced (general practice) | 5 ft (1.524 m) preferred pedestrian route; a 2-6 ft utility/snow strip, 4 ft or more with street trees | NYSDOT HDM ch. 18; Region 1 RDI 17-03 |
| Dave (preview of CC-005e, 2026-11-11; not a survey) | the ~1.3 m grass strips were too wide; trees must not stand in the middle of the sidewalk | Dave, 2026-11-11 (CC-005f) |
| assumption (Dave may override) | curb reveal 0.13 m; downtown walk ~2.05 m to the curb; residential tree lawn `SIDEWALK.lawnTarget` 0.9 m (3 ft; CC-005f, narrower than the city's 4 ft and NYSDOT's 4-6 ft) and a walk of at least 1.65 m; downtown lots paved, residential lots yard green; paved corners | this build |

**Downtown envelope** (`js/gf-downtown.js`, APPROXIMATE, Dave to confirm). The nomination map and NPS boundary GIS
(npgallery.nps.gov, mapservices.nps.gov) could not be reached from the build environment, so the envelope is drawn only
from the published bounding streets, along their OSM centrelines in the frozen extract (OSM base
2026-10-30T14:35:11Z):

- loop A (1984): Ridge St north from Centennial Circle to Maple St, Maple St west to Bay St, Bay St south to Glen St at
  Monument Square (where South St begins), Glen St back to the circle: 38 OSM nodes, 7.9 acres inside;
- loop B (2022 increase): Glen St north-west from Monument Square to Pine St, Pine St south to Broad St, Broad St east to
  South St, South St north: 24 OSM nodes, 13.0 acres inside;
- plus 20 m either side of every loop street (the far frontage of a bounding street is downtown too).

With its frontage the envelope covers 29.5 acres. The 1984 listing is 23 acres, and the 2022 increase adds an area
not fetched here, so the sizes are of the same order but the shape is not the surveyed one. Not included: lower Glen St
south of Centennial Circle, Warren St east of the circle, Ridge St north of Maple St. Every vertex is an OSM node; no
freehand shape.

**Widths** (as built, measured on the regenerated `GF_GEO`; `tests/gf-sidewalk-appearance.test.mjs`):

| | generator band | curb to lot line (median) | curb | lawn | walk |
| --- | --- | --- | --- | --- | --- |
| downtown | 1.8 m | 2.2 m | 0.15 m granite | none (under 0.6 m is paved) | ~2.05 m, to the curb |
| residential (CC-005f) | 2.5 m | 2.85 m | 0.15 m granite | 0.9 m grass (`lawnTarget`, 3 ft; under 0.6 m is paved) | at least 1.65 m (5.4 ft), median ~1.8 m |

CC-005e had 2.8 m, a ~3.1 m band and a ~1.3 m lawn. CC-005f narrows the lawn to `SIDEWALK.lawnTarget` (0.9 m) after
Dave's preview. The generator's residential parameter follows from it: `curbW + lawnTarget + walkW − rasterShift`.
The property line is traced on a 1 m raster, so it moves in steps: 2.4 m gives a band of about 2.6 m (a 0.8 m lawn,
paved wherever the band is narrower), and 2.5 or 2.6 m gives about 2.85 m. The layout caps the lawn at `lawnTarget`,
and the walk takes the rest of the band, so it is never narrower than 1.65 m. To retune, change `lawnTarget` and
rebuild the geodata.

**Heights.** The road is ROAD_LIFT (0.03 m) above the ground. The curb face rises 0.13 m from under the road to the
top, 0.16 m above the ground. The walk, lawn and curb top stand at that height; a 0.5 m ramp inside the lot line takes it
back down to the lot (grass; downtown paving). `raiseAt(x, z)` gives that height for walkers (`sidewalkY` 0.02 over it),
the player's walker, cyclist and taxi (`gf-runtime.js` `onRaised`), and the CC-005d exit spots. The helicopter's floor is
unchanged.

**What is drawn** (`gf-sidewalk-strips.js`; only where a road runs beside the band, so not along water, the bbox edge
or alleys):

- **Curb:** granite face and top along the curb ring, joints every 1.83 m, darker on the face. A 0.45 m asphalt gutter
  beyond it covers the curb ring's raster offset (±0.4 m, 90% of samples) from the road ribbon's edge.
- **Walk:** concrete strip out from the lot line, tooled joints every 1.524 m along it, faded with distance.
- **Lawn:** mown grass between walk and curb, residential only.
- **Corners:** paved to the curb within 3.5 m (along the lot line) of a lot corner turning 36° or more, and within 12 m
  of a junction of three or more roads (where the walking lines meet the crossings).
- **Driveways:** sourced only. Where an OSM `highway=service` way crosses the band, the curb is depressed (0.06 m) and
  the lawn becomes a concrete apron (downtown: the walk slopes down to the curb). About 4,300 curb samples, roughly
  1,700 driveways. No parcel driveway is invented.

**Meshes and cost.** 250 m cells, each built the first time the camera comes within 650 m of it and shown only then.
That is about one draw call per material per visible cell (granite, concrete, lawn, gutter; ramps share the lawn
material). Strips are draped at every 2 m sample. Beyond 650 m the terrain's colours show the bands.

**Pedestrians** (`onWalk`, `insetsFor`):

- **Placement:** each street side's two walking lines are set from the walk measured at the edge's middle: 0.45 m in
  from its road edge and 0.7 m in from the lot line, or one line in the middle if it is too narrow.
- **`onWalk`** (the game's `onSidewalk`): the walk, the paved corners and the junction zones; not the lawn, the lot or the
  road. Measured on the game's network, 98.8% of track points are on it. CC-005f: 2,187 of 2,498 edges have walking
  lines (CC-005e: 2,126).
- **`gf-blocks.js` `onSidewalk`** keeps its CC-002 meaning (block minus lot) for the older tests.
- **`pedestrian-routes.js`:** its `insets` option may now be a function `(edge, side)`. An array (New York) is used as
  before.
- **CC-005c trails:** all six walkers' entrances still attach to a sidewalk, their connectors clear of water, buildings
  and kept trunks (tested).

**New York.** Nothing loads there: no NYC or shared module imports the CC-005e modules, and they are not in the NYC
preload list (tested). The only shared edit is the opt-in function `insets`. `tsl-materials.js` is untouched: the GF
materials carry their own copies of its small TSL helpers.

**Limits.**

- Crosswalks came later, in CC-006 (see Crosswalks, stop signs, street lights).
- No full driveway inventory: only OSM service ways.
- OSM `sidewalk=*` tags are unused (about 50 of 2,078 ways, too sparse) and no per-edge sidewalk geometry is invented.
- **Trees and the walk:** see **Trees off the walk (CC-005f)** below. Trees are still not pedestrian obstacles (as in
  CC-005), and there are no tree pits.
- **No car-curb collision:** cars ride up a curb (their ground includes the raise).
- **Curves:** a curb follows the 1 m raster outline, simplified to 0.5 m, so curb returns are faceted.

### Trees off the walk (CC-005f)

`gf-tree-placements.js` puts each trunk under its measured LiDAR canopy top (USGS 3DEP 2022-23, `gf-trees.js`). That
left trunks standing in the concrete wherever a crown reaches over a walk (about 1,470 in CC-005e). Dave's preview
(2026-11-11) asked for no trees in the middle of the sidewalk. `js/gf-tree-walk.js` `keepTreesOffWalk` runs on the
placement plan in `gf-main.js`.

- **Rule:** a site whose trunk centre is on the drawn concrete (`gf-sidewalks.js` `walkAt`: the walk, a paved corner,
  a junction's apron) is moved straight across the band, along the lot line's normal:
  1. to the tree lawn's middle, if there is a lawn there at least the trunk's width plus 0.1 m;
  2. else into the lot, 0.3 m beyond the ramp plus the trunk's half width;
  3. else it is dropped.
- **Clear means:** not on the walk, on the same block, not in water, no carriageway within the trunk's half width, not
  in a building footprint, not in a trail corridor (CC-005c's cleared trees stay cleared).
- **Counts** (with this branch's 0.9 m lawn): 1,589 trunks stood on the concrete. 600 moved to the lawn, 957 into the
  lot and 32 were dropped (no lawn and the lot too shallow or built on). 76,311 stayed as placed. A move is 1.9 m at the
  median and 4.8 m at most.
- **Provenance:** no tree is added and `gf-trees.js` is untouched. A moved site keeps its LiDAR top as `site.lidar`
  `{ x, z }` and `site.moved` (`'lawn'` | `'lot'`). Its height, spread, shape and tier are unchanged; its trunk collider
  and ground height follow it. `slopGlensFalls.trees.offWalk` lists every move (`{ index, from, to, where }`) and drop
  (`{ index, at, reason }`) by the tree's index in `gf-trees.js`.
- **Lot-less islands:** the 75 trees on islands with no property line (traffic islands and medians, where no walk is
  drawn) stay where they are.
- **Limits:** the moved trees are 2022-23 LiDAR trees nudged to a plausible spot, not a 1993 tree survey; there are no
  tree pits.

### Crosswalks, stop signs, street lights (CC-006)

Dave (2026-11-11) asked for street lights, stop signs and traffic lights. The traffic lights were already in (Signals:
41 signalled junctions, AI cars stop on red, three-lamp heads) and are unchanged. CC-006 adds painted crosswalks, stop
signs and street lamps. Modules: `js/gf-crossings.js`, `js/gf-stop-signs.js`, `js/gf-street-lights.js` (placement, no
three.js), `js/gf-street-furniture-meshes.js` (drawing), `js/gf-furniture.js` (generated by
`tools/gf/build-gf-furniture.mjs` from `data/osm_gf_street_furniture.json`). OSM is modern, not 1993.

**What each thing rests on.**

| | what | source |
| --- | --- | --- |
| Dave | the ask: street lights, stop signs, traffic lights | Dave, 2026-11-11 |
| sourced | signalled junctions (41) and the 24 signalled crossings | OSM `highway=traffic_signals`, `crossing=traffic_signals` (CC-002b extract, unchanged) |
| sourced | marked crossings: `crossing=marked\|zebra`, or `crossing:markings` / `crossing_ref` other than no/none | OSM, `data/osm_gf_street_furniture.json` |
| sourced | stop signs: `highway=stop` and `traffic_sign=stop` nodes, with `stop=all` | OSM, same extract |
| inferred (a rule, Dave may tighten it) | a stop on a minor road where it meets a higher-class road at an unsignalled junction | this build, from OSM `highway` classes and the network's right-of-way groups |
| assumed (not 1993, not a survey) | street lamps every 30 m downtown and 42 m elsewhere, 0.55 m in from the curb face | this build |

**The extract.** `data/osm_gf_street_furniture.json`: OSM base 2026-11-12T11:26:55Z, 415 nodes, sha256
`52b4aa5b…e7f3`, fetched by Dave through the maps.mail.ru Overpass mirror (the overpass-api.de servers refused the build
environment; `tools/overpass.sh` now falls back to that mirror). It holds what the CC-006 spec counts for the bbox:
55 `highway=stop` (37 `stop=all`) and 4 more `traffic_sign=stop`-only nodes, 7 `highway=give_way`, 325 crossing nodes
(162 of them marked by the rule below) and 24 `highway=street_lamp`.

**Counts in the game.**

| | count |
| --- | --- |
| junction crosswalks | 203 on 80 junctions: 140 on the arms of all 41 signalled junctions, 63 on 39 unsignalled junctions an OSM marked crossing lies at |
| mid-block crosswalks | 31 (marked or signalled crossings on no junction arm) |
| marked and signalled crossings not painted | 65 of 186: 62 on no road of the drive network (service ways, paths, roads cut at the bbox edge), 3 inside a junction's core on none of its arms (listed with their reason in `slopGlensFalls.streetFurniture.midBlock.lost`) |
| crosswalk walking tracks | 156 at 35 signalled junctions, 80 at 31 unsignalled ones |
| OSM stops placed | 48 of 59, giving 140 signs (127 of them all-way); 11 unmatched (10 with no junction within 25 m, mostly at the bbox edge; 1 not on an approach) |
| inferred stops | 60 signs at 52 junctions (373 junctions skipped as two roads of one class, 42 for an OSM stop, 37 signalled, 4 for a give-way, 19 one road) |
| stop signs drawn | 190 of 200 (10 have no curb within 10 m) |
| street lamps | 5,814 assumed; 0 of OSM's 24 used (below) |

**Crosswalks** (`gf-crossings.js`):

- **Where:** every arm of a signalled junction, and every arm of an unsignalled junction that an OSM marked crossing
  lies on (within 30 m of the junction, across its road). A marked or signalled crossing that is on no junction arm is
  painted across the nearest road, where it is (`midBlock`). None is invented.
- **Shape:** a ladder of 0.45 m bars, 0.55 m apart and 2.2 m long, across the whole road at the arm's stop line (its
  centre `CROSSWALK` 2.5 m / 2 beyond it), from curb to curb as `blockAt` finds them. The bars are one merged mesh draped
  on the asphalt.
- **Walking:** `pedestrian-routes.js` takes an opt-in `crossings` function (New York passes none and keeps its grid
  corners, tested). Each crosswalk gives two walking lines 0.75 m either side of its middle, ending 1.8-2 m onto the
  walk beyond the curb. At a signal, people wait for the WALK of the junction's own phase (`traffic.js` `walkOn` by the
  arm's right-of-way group); elsewhere they cross as cars allow (`mayCross`, as before).

**Stop signs** (`gf-stop-signs.js`):

- **Sourced:** each OSM stop goes to the nearest junction within 25 m. On the junction itself (within 6 m) or tagged
  `stop=all`, it stops every arriving road (all-way) or, for a plain two-way stop, the minor roads (right-of-way group
  not 0). On an arm, it stops the traffic arriving over that arm. A stop with no junction near, or not on an approach,
  is listed in `slopGlensFalls.streetFurniture.stops.unmatched` with its reason.
- **Inferred:** at every other junction of 3+ arms with no signal, no OSM stop and no OSM give-way within 25 m, the
  approaches of roads of a lower OSM `highway` class than the junction's highest get a stop, unless they are that
  top-class road itself going on (group 0, or its class tag changing at the junction). Two roads of the same class: no
  stop (nothing says which one would have it).
- **Drawn:** a post and an octagonal face reading STOP, on the right-hand curb 0.6 m before the stop line, facing the
  arriving traffic (two instanced meshes). Where no curb is found within 10 m (a bridge, an open lot edge) the approach
  still stops but no post is drawn in the road.
- **AI:** `traffic.js` gains an opt-in `edge.stopSign`. A car on such an approach comes to a full stop at the line
  (below 0.3 m/s, within 2 m), then goes by the junction's usual right of way. Police cars do not stop. New York sets
  no `stopSign`, so its traffic is unchanged (tested).

**Street lights** (`gf-street-lights.js`):

- **Placement:** along every curb with a road beside it (`gf-sidewalks.js` curb rings), 30 m apart in the downtown
  envelope and 42 m elsewhere, 0.55 m in from the curb face: on the tree lawn on residential streets, on the walk by the
  curb downtown. A spot on a driveway, a curb corner, off the band, within 0.25 m of the carriageway, within 0.9 m of a
  trunk, 2 m of a signal or stop post, or inside a building moves on along the curb, up to 6 m. OSM's few
  `highway=street_lamp` nodes, where they stand on a curb band, replace the assumed lamps within 15 m.
- **OSM's 24 lamps:** none stands on a curb band, so none is used. 11 are a row along Glen St downtown 5-9 m back
  from the roadway, inside the lot line; 1 more of that row is in the carriageway; 10 stand beside roads that have no
  curb blocks drawn; 2 are well inside lots. Dave may want the Glen St row kept where OSM puts it.
- **Drawn:** one instanced mesh, a post with an arm and a head over the road. The head glows by
  `smoothstep(0.65, 1.2, interiorGlow)` (`lighting.js` presets): 0 at midday (0.24) and golden hour (0.48), full at
  twilight (1.25) and midnight (1.55).
- **Light:** a pool of 32 point lights (warm, 120 cd, 32 m reach) moves to the lamps nearest the camera within 160 m, every
  0.3 s, while the glow is on. No lamp has a light of its own.

**Cost** (headless Chromium, software WebGL, so frame times are only relative; main and this branch measured back to
back, car on Glen St at Monument Square and on Maple St, golden hour and midnight): +204k to +261k triangles (the
5,801 lamps are one instanced mesh with no sun shadows; the 234 crosswalks' 1,782 bars one merged mesh; 190 signs two
instanced meshes), draw calls within the traffic's own swing (-4 to +8), 32 point lights at night, about 0.4 s more
start-up, and median frame time +5% to +8%, +21% at night on Glen St with the light pool on.

**Limits.**

- No 1993 lamp, sign or crossing inventory: OSM is modern and the lamps are assumed.
- Signals unchanged: 8 OSM signals still have no network node at the bbox edge (see Signals), and no signalled
  junction is invented.
- No WALK/DON'T WALK heads; pedestrians follow the phase without them.
- 36 junction crosswalks find no curb and are drawn across the road's width; some crosswalk lines are not walked
  because an end is off the walk or blocked.

## Source and licence

Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The raw extracts in
`tools/gf/data/` and the derived `js/gf-geodata.js` are ODbL. The attribution "© OpenStreetMap contributors" appears
here, in `GF_GEO.attribution` and on screen in the debug and game views. The other dataset is USGS 3DEP, for the building
heights and the trees (LiDAR) and the terrain (the 1 m DEM) (public domain; credited "USGS 3D Elevation Program" in the
game view, in `GF_LIDAR_HEIGHTS.credit`, `GF_TREES.credit` and the terrain's header, see LiDAR heights, Trees and
Topography). No geography is placed by hand. The Thrill Hill party (CC-005c) is fictional scene dressing, placed by a
fixed rule beside the sourced trail crest.
