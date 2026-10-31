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
  'building-footprints.js',
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
  'gf-runtime.js',
  'gf-ground.js',
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
  if (params.get('view') === 'debug') location.replace(`./gf.html${location.search}`);
  else {
    preload(GF_PRELOADS, { rel: 'modulepreload' });
    import('./gf-main.js');
  }
} else {
  preload(NYC_PRELOADS, { rel: 'modulepreload' });
  // New York's building and tree data start downloading with its modules
  preload(['building-geodata.bin.gz', 'tree-geodata.bin.gz'], { rel: 'preload', as: 'fetch', crossOrigin: 'anonymous' });
  import('./nyc-main.js');
}
