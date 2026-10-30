// Entry point: loads the city the URL asks for, and only that city's modules.
//   ?city=glensfalls&view=debug   the Glens Falls geodata debug view (gf.html)
//   ?city=glensfalls              Glens Falls (gf-main.js)
//   anything else                 New York (nyc-main.js)
const params = new URLSearchParams(location.search);
if (params.get('city') === 'glensfalls') {
  if (params.get('view') === 'debug') location.replace(`./gf.html${location.search}`);
  else import('./gf-main.js');
} else {
  // New York's building and tree data start downloading with its modules (preloaded here rather than in index.html, so
  // that Glens Falls never fetches them)
  for (const file of ['building-geodata.bin.gz', 'tree-geodata.bin.gz']) {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'fetch';
    link.crossOrigin = 'anonymous';
    link.href = new URL(file, import.meta.url).href;
    document.head.appendChild(link);
  }
  import('./nyc-main.js');
}
