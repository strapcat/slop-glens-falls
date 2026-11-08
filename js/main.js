// Entry point: loads the city the URL asks for, and only that city's modules.
//   ?city=glensfalls&view=debug   the Glens Falls geodata debug view (gf.html)
//   ?city=glensfalls              Glens Falls (gf-main.js)
//   anything else                 New York (nyc-main.js)
// index.html preloads the modules both cities share; each city's own modules are preloaded here, so that neither
// downloads the other's. (tests/city-runtime.test.mjs checks these lists against the cities' import graphs.)
const NYC_PRELOADS = [
  'nyc-geodata.js',
  'city-config.js',
  'nyc-runtime.js',
  'trees.js',
  'tree-placements.js',
  'tree-geodata.js',
  'city-grid.js',
  'boroughs.js',
  'buildings.js',
  'building-details.js',
  'building-geodata.js',
  'fire-escapes.js',
  'landmarks.js',
  'street-details.js',
  'street-props.js',
  'subway-geodata.js',
  'subway-entrances.js',
  'nyc-map.js',
  'scene-culling.js',
  'audio-synthesis.js',
  'audio-events.js',
  'audio-sources.js',
  'audio-acoustics.js',
  'audio-system.js',
  'nyc-main.js'
];
const GF_PRELOADS = [
  'gf-geodata.js',
  'gf-roadgraph.js',
  'gf-blocks.js',
  'gf-utm.js',
  'gf-terrain.js',
  'gf-terrain-data.js',
  'gf-water.js',
  'gf-bridges.js',
  'gf-surface.js',
  'gf-runtime.js',
  'gf-terrain-lod.js',
  'gf-terrain-lod-codec.js',
  'gf-terrain-lod-errors.js',
  'gf-terrain-mesh.js',
  'gf-drape.js',
  'gf-ground.js',
  'gf-signals.js',
  'gf-signal-heads.js',
  'gf-buildings.js',
  'gf-building-records.js',
  'gf-building-bases.js',
  'gf-building-terrain.js',
  'gf-facades.js',
  'gf-landmarks.js',
  'gf-landmark-records.js',
  'gf-landmark-meshes.js',
  'gf-lidar-heights.js',
  'gf-building-heights.js',
  'trees.js',
  'gf-trees.js',
  'gf-tree-placements.js',
  'gf-main.js'
];

// <link>s in the head for files next to this module (rel and the like in `attributes`)
function preload(files, attributes) {
  for (const file of files) {
    const link = document.createElement('link');
    Object.assign(link, attributes);
    link.href = new URL(file, import.meta.url).href;
    document.head.appendChild(link);
  }
}

const params = new URLSearchParams(location.search);
if (params.get('city') === 'glensfalls') {
  // before gf-main.js loads, so the tab never flashes index.html's New York title
  document.title = 'Slop Glens Falls';
  if (params.get('view') === 'debug') location.replace(`./gf.html${location.search}`);
  else {
    preload(GF_PRELOADS, { rel: 'modulepreload' });
    // CC-005b: the terrain starts downloading with the modules
    preload(['gf-terrain.bin.gz'], { rel: 'preload', as: 'fetch', crossOrigin: 'anonymous' });
    import('./gf-main.js');
  }
} else {
  preload(NYC_PRELOADS, { rel: 'modulepreload' });
  // New York's building and tree data start downloading with its modules
  preload(['building-geodata.bin.gz', 'tree-geodata.bin.gz'], { rel: 'preload', as: 'fetch', crossOrigin: 'anonymous' });
  import('./nyc-main.js');
}
