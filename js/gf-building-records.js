// Glens Falls buildings as data (no three.js, so Node tests use it as the game does): GF_BUILDINGS (js/gf-buildings.js)
// turned into createBuildingFootprints records, the player's colliders and the road network's pedestrian obstacles.
//
// Each record has a facade style:
//   stone      civic buildings (schools, churches, hospitals, town hall, library, post office...)
//   clapboard  houses and small outbuildings, and untyped (building=yes) footprints under 250 m² with no shop or amenity
//   brick      everything else (downtown blocks, shops, mills, big boxes)
// Heights are GF_BUILDINGS's: tagged where OSM has a height or levels, else its default rule (an approximation).

const STONE_KINDS = ['school', 'church', 'chapel', 'hospital', 'civic', 'public', 'government', 'cathedral'];
const STONE_USES = ['amenity=townhall', 'amenity=library', 'amenity=place_of_worship', 'amenity=courthouse', 'amenity=post_office'];
const CLAPBOARD_KINDS = ['house', 'detached', 'semidetached_house', 'residential', 'terrace', 'garage', 'garages', 'shed',
  'outbuilding', 'carport', 'greenhouse', 'hut', 'kiosk'];
const SHOP_KINDS = ['retail', 'commercial', 'supermarket'];
const SHOP_USES = ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'bank', 'pharmacy', 'ice_cream'].map((v) => `amenity=${v}`);
const STYLES = ['brick', 'stone', 'clapboard'];

// Same generator as js/buildings.js and tools/gf/build-gf-buildings.mjs
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const points = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i], z: flat[i + 1] });
  return out;
};
const area = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return Math.abs(a / 2);
};

function styleOf(kind, use, footprintArea) {
  if (STONE_KINDS.includes(kind) || STONE_USES.includes(use)) return 'stone';
  if (CLAPBOARD_KINDS.includes(kind) || (kind === 'yes' && footprintArea < 250 && !use)) return 'clapboard';
  return 'brick';
}

// { records, colliders, obstacles } of GF_BUILDINGS, in its order
function createGfBuildingRecords(data) {
  const at = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  const records = [];
  const colliders = [];
  const obstacles = [];
  for (const row of data.buildings) {
    const osm = row[at.osm], kind = row[at.kind], use = row[at.use], height = row[at.height];
    const polygon = { outer: points(row[at.outer]), holes: row[at.holes].map(points) };
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of polygon.outer) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const footprintArea = area(polygon.outer) - polygon.holes.reduce((s, h) => s + area(h), 0);
    const rand = mulberry32(Number(osm.slice(1)) ^ 0x5eed);
    const seed = Math.floor(rand() * 1000);
    const tone = rand();
    const storefronts = height >= 3.5 && (SHOP_KINDS.includes(kind) || (use || '').startsWith('shop=') || SHOP_USES.includes(use));
    records.push({
      osm, kind, use, name: row[at.name], src: row[at.src], style: styleOf(kind, use, footprintArea), storefronts,
      polygons: [polygon], height, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, seed, tone, minX, maxX, minZ, maxZ
    });
    colliders.push({ minX, maxX, minZ, maxZ, minY: 0, maxY: height, polygon });
    obstacles.push({ minX, maxX, minZ, maxZ, polygon, pedestrianOnly: true });
  }
  return { records, colliders, obstacles };
}

// getNeighbours for createBuildingFootprints's party walls (like js/buildings.js nearbyReserves(b, 2)): every record
// whose bounds come within 2 m of the building's, from a 128 m grid index. The walls stand on the flat ground (base
// 0), so a neighbour's roof is at its height.
function neighboursFor(records, padding = 2) {
  const cells = new Map();
  const reserves = records.map((r) => ({ x0: r.minX, x1: r.maxX, z0: r.minZ, z1: r.maxZ, height: r.height, polygons: r.polygons }));
  reserves.forEach((r, index) => {
    for (let ix = Math.floor(r.x0 / 128); ix <= Math.floor(r.x1 / 128); ix++) {
      for (let iz = Math.floor(r.z0 / 128); iz <= Math.floor(r.z1 / 128); iz++) {
        const key = ix + ',' + iz;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(index);
      }
    }
  });
  return (b) => {
    const minX = b.minX - padding, maxX = b.maxX + padding, minZ = b.minZ - padding, maxZ = b.maxZ + padding;
    const found = new Set();
    for (let ix = Math.floor(minX / 128); ix <= Math.floor(maxX / 128); ix++) {
      for (let iz = Math.floor(minZ / 128); iz <= Math.floor(maxZ / 128); iz++) {
        for (const index of cells.get(ix + ',' + iz) || []) {
          const r = reserves[index];
          if (r.x0 < maxX && r.x1 > minX && r.z0 < maxZ && r.z1 > minZ) found.add(index);
        }
      }
    }
    return Array.from(found, (index) => reserves[index]);
  };
}

export { createGfBuildingRecords, neighboursFor, STYLES };
