# CC-005c — Crandall Park trails and reachable Thrill Hill gathering

Renumbered at Dave's explicit instruction: CC-005 trees -> CC-005b GF-wide topography -> CC-005c trails/Thrill Hill party -> CC-006 crosswalks. Earlier CC-005b trail/party handoffs are superseded; do not implement terrain in this task. Claude Code implements a separate draft PR after both prerequisites merge; Dave merges. Neither prerequisite merge is asserted here.

## Scope and provenance
Dave confirmed trails existed in1993 (local knowledge, not independently documented exact alignment). His green marker in thrill-hill-dave-marked.png identifies Thrill Hill at Camel Humps just north of The Wall, west of Dead Fox Hill, north of Halfway Brook. That is Cole's Woods: allow only the minimum sourced connection from park to hill, not whole woods. His night keg/fire gathering with daytime ash/log remains and empty red cups is fictional scene dressing, not verified party history. Fire mandatory at night, extinguished by day, existing game clock/deterministic states; use CC-005c.md.

## Geographic inputs are candidates, not an approved connected graph
- Original park OSM extract / boundary and21 candidate lines (13park-route,8sidewalk/crossing context) retain exact coordinates/nodeIDs/versions/tags; selection is any vertex inside park, not clipping or topology validation.
- Larger OSM corridor XML and47 candidate walking/track ways retain exact coordinates/nodeIDs/tags. Private/restricted/out-of-scope branches and bridges are NOT approved/filtered. acceptedForImplementation=false throughout. No invented connector or nearest-line shortcut.
- county-coles-loop.geojson preserves original county feature19:one197-vertex loop polyline,reported4.586977km. Not a junction-aware graph or current tread survey. Original county-ski-query.json included. Hiking query returned0features in original small park envelope; not proof no paths.
- Four park candidates are tagged wooden footbridges; other corridor bridges require source/physical deck validation. Bare-earth ground does not provide bridge decks. Use merged topography's support surfaces; return a prerequisite gap if necessary rather than implementing another terrain/deck system here.
- OSM Newell Way source=survey, survey:date=2022-05-20, not1993 survey. Many widths/surfaces unknown: gameplay assumptions must be explicitly labelled, not claimed measured.

## Hill alignment uncertainty
The marked map is schematic, not an orthorectified survey. Friends of Cole's Woods history describes top of Wall -> drop -> second Camel Hump, but does not independently name Thrill Hill or a party. Qualitative county-loop topology suggests original vertices136–142. thrill-hill-search-area.geojson is a65m buffer around that segment: approximate analyst search allowance, NOT a fitted georeference, measured uncertainty, exact summit, party anchor or permission to clear trees. Corroborate trail junctions/brook/actual merged terrain; if ambiguous between humps, return a labelled geographic comparison for Dave before locking a site.

county-loop-dem-profile.json and thrill-hill-terrain-evidence.png show measured topography evidence, not game terrain or an image-to-coordinate transformation of Dave's marker. Samples #137~117.392m,#139~114.104m,#140~116.422m demonstrate local bumps only. Not exact summit/party spot. No DEM duplicated: TOPOGRAPHY-REFERENCE.md pins separate terrain kit and original crop/source integrity. Preserve prerequisite terrain bytes and surface contract.

## Map/reference limits and licenses
Crandall_Park_Map.pdf (WarrenCountyGIS April2021,itemmodifiedOctober21,2021) is image-only/cartographic, no dependable embedded geographic registration established. It contains modern2020 disc-golf fairways, NOT 1993 walking paths. Coles-Woods-Map.pdf is also illustrated/schematic: no tracing arbitrary pixels to world coordinates. Map artwork reuse grant not established; reference, do not copy artwork into game or assume public domain. User annotation is local-knowledge input, not a map-artwork license.
OSM ©OpenStreetMap contributors,ODbL1.0 https://www.openstreetmap.org/copyright ; retain derivative-data/provenance obligations. County GIS/map terms not established in records read; do not assume all public data is public domain. USGS terrain is public-domain government work,credit3DEP,in CC-005b kit. Winter map warns against walking groomed ski trails: summer/leafy non-groomed game setting,not winteraccess guidance.

## Source URLs
https://cityofglensfallsny.gov/248/Glens-Falls-Parks
https://www.arcgis.com/home/item.html?id=21213b834dcb4243859b92a489af5843
https://www.arcgis.com/sharing/rest/content/items/21213b834dcb4243859b92a489af5843/data
https://www.openstreetmap.org/api/0.6/map?bbox=-73.667,43.3163,-73.6577,43.323
https://www.openstreetmap.org/api/0.6/map?bbox=-73.6805,43.3195,-73.6615,43.3265
https://www.openstreetmap.org/way/98662107
https://services6.arcgis.com/Fg3XpDIUTR3JZZES/arcgis/rest/services/recreation_mapper/FeatureServer/4
https://www.friendsofcoleswoods.org/trail-map-history
https://insideedgeskiandbike.com/downloads/Coles%20Woods%20Map%20Color.pdf
https://www.arcgis.com/home/item.html?id=5db78878b48549da9aef487559ab3f5b (disc golf built2020)

Freeze accepted route/provenance, validate real entrances/continuous route/ground/deck/tree-body clearances, and use deterministic minimal trunk-only corridor exclusions. No broad party clearing or moving LiDARtrees. SHA256SUMS verifies every attached file. Read CC-005c.md for implementation gates, tests, both day/night visual states and scope constraints.
