# CC-005b GF-wide topography source inputs

CC-005b is now terrain; old trail/party work is CC-005c. This is geographic DATA/reproduction, not game implementation. Require merged CC-005 trees; Claude implements, Dave merges.

Two bundles REQUIRED: cc005b-topography-sources.zip (base/reference/provenance) and cc005b-topography-detail-sources.zip (native1m refinement). Both fit25MB per-file handoff limit. Check separate SHA256SUMS. DETAIL-BUNDLE-REFERENCE.md pins second archive.

## Verified coverage and source
Established target WGS84 west-73.68,south43.29,east-73.61,north43.33, from original OSM README and tree meta.bbox. Padded UTM rectangle [606980,4793840,612800,4798420] has zero invalid/missing1m reference pixels, no missing edge strips. Exact target includes25,224,904 reference pixel centres, elevation21.853807–138.386780m NAVD88. This verifies source coverage, not that future/current code never uses out-of-bbox way endpoints; Claude confirms actual play area.

Two frozen original USGS1m tiles already in lidar/tiles,353057146 and375244353bytes. Exact source URLs/checksums/transforms/CRS/nodata in terrain-provenance-and-validation.json; originals not duplicated here. Source metadata https://www.fisheries.noaa.gov/inport/item/73809 . Public source root https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/NY_Hudson_D22/TIFF/ . Source TIFF hashes independently match delivered tree JSON provenance. USGS government work/public domain, credit USGS3DEP. Collection2022–23, not1993.

## Input files
- gf-dem-candidate-2m.tif:2910x2290float32 full buffered coverage. Copies original samples to aligned1m reference using nearest(<0.00004m encoded lattice shift);2x2 mean into candidate. Not final approved runtime/mesh design.
- thrill-hill-reference-dem-1m.tif:unchanged1488x725 original1m crop; hill-reference-provenance.json records transform/hash (old crop filename there). Preserve small-hill relief, not an exact party marker.
- gf-dem-refinement-patches-1m.tif is in SECOND archive. Native1m reference64m blocks where bilinear candidate error>0.25m, plus8m halo. Outside-patch nodata means USE FULL BASE, not absent source coverage or flat ground.8,236,080 source-value pixels in1,670 selected blocks before overlaps/halos accounted in mask. Final runtime must design/test seams; no implemented composite surface claim.
- terrain-provenance-and-validation.json includes full candidate audit, native-patch windows and proposed sourced downtown anchor. reference-audit-lattice.csv supplies sparse fixed original source regression values, not full validation. REPRODUCE.md, prepare-topography-inputs.py and exact library versions explain reproduction.

## Error caveat
Across all25,224,904 exact-target reference cells, bilinear2m candidate reconstruction MAE0.02125m,RMSE0.05210m,p95=0.06630m,p99=0.15145m,MAX6.92525m;9,168pixels>1m. Native-detail inputs address steep-feature outliers; do not smooth them away. Final game ground query AND mesh must be rechecked vs original source, especially roads/banks/hill/detail seams. No final runtime error claim exists.

## Coordinate/datum/interpretation caveats
TIFF encoded horizontal EPSG:26918, while project wording describes NAD83(2011). Preserve/report distinction; no silent relabel to WebMercator or WGS84, no survey-accuracy claim. Vertical NAVD88/GEOID18metres. Nodata-999999 never means ground; pixels are centres, rows southward, easting eastward. Proposed real anchor OSMnode221400851 Glen/Bay/South(-73.6464714,43.3108659), source bilinear ground104.788276672m NAVD88—not surveyed road deck. Claude reconciles actual local frame and one vertical offset; don't shiftxz.

dt_d22.npz is NOT a terrain grid:4,562,339mixed-class point records with no embedded CRS; conditional WebMercator extent approximatelylon-73.6505..-73.6385,lat43.3055..43.3160, only downtown. Use original ground TIFFs, not all pointz. Bare-earth/hydro-flattened DEM is NOT submerged bathymetry, bridge deck or roof. Ground-relative building/tree heights stay unchanged. Do not invent dams/underwater surfaces. OSM anchor attribution ©OpenStreetMap contributors,ODbL1.0 https://www.openstreetmap.org/copyright . Consult CC-005b.md; trails/party/crosswalks remain separate.
