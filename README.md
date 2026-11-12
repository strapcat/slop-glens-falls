# Slop Glens Falls

Glens Falls and South Glens Falls, New York, built with [three.js](https://threejs.org/), WebGPURenderer and TSL. Drive, cycle, walk or fly a helicopter around town. A fork of [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork).

**Play:** [strapcat.github.io/slop-glens-falls/?city=glensfalls](https://strapcat.github.io/slop-glens-falls/?city=glensfalls)

Keep `?city=glensfalls` on the link. The bare page (`index.html` with no query) still opens the original New York City, which stays available at the same address.

**Controls:** `1`–`4` Walk / Drive / Cycle / Fly, `WASD` to move, `V` to cycle cameras, `T` (the **Talk** button on touch screens) to talk to someone in reach on foot, `H` to hide the HUD. The street map (`M`) is New York only for now.

## How accurate is it?

The town is **inspired by 1993**. It is not a surveyed reconstruction of 1993. Roads, blocks and building footprints come from today's OpenStreetMap. Terrain, trees and most building heights come from USGS 3DEP elevation and the 2022–23 NY Hudson LiDAR. Anything 1993-specific comes from local knowledge, and the Thrill Hill party is fictional.

## Make it your own

Fork it, remix it, take it wherever you want. Explore other cities and community remixes in [Slop Cities](https://github.com/zz85/slop-cities).

## License and data

The code is available under the [MIT License](LICENSE).

Glens Falls data:
- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL): roads, blocks, building footprints, signals, bridges, water and park trails.
- USGS 3D Elevation Program (3DEP), NY_Hudson_D22 LiDAR 2022–23 and the 1 m DEM (public domain): terrain, tree positions and heights, and building heights. Overture Maps buildings help mask where trees can stand.
- Warren County trail maps were used as reference only. No county map artwork is copied into the game.

New York City data: NYC Open Data (including [building footprints and heights](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue) and [tree locations](https://data.cityofnewyork.us/Environment/Forestry-Tree-Points/hn5i-inap)), [MTA subway entrances](https://data.ny.gov/Transportation/MTA-Subway-Entrances-and-Exits-2024/i9wp-a4ja), and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL).

Third-party data and dependencies keep their own licenses. More detail on the Glens Falls sources is in [tools/gf/README.md](tools/gf/README.md).
