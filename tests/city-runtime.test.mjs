import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The city runtime (js/city-runtime.js): which modules each city loads, the preloads that fetch them, and the
// runtime's own contract.

const js = (f) => readFileSync(fileURLToPath(new URL(`../js/${f}`, import.meta.url)), 'utf8');

// The relative specifiers of a module's static import statements, in order (`import … from './x.js'` and
// `import './x.js'`; bare `three/*` specifiers and dynamic import() are not followed)
function staticImports(source) {
  const out = [];
  for (const m of source.matchAll(/^\s*import\s+(?:[\w$*{][\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}
// Every module reached from `entry` through static imports (file names in js/)
function staticGraph(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of staticImports(js(file))) if (spec.startsWith('./')) walk(spec.slice(2));
  };
  walk(entry);
  return seen;
}
const gfGraph = staticGraph('gf-main.js');
const nycGraph = staticGraph('nyc-main.js');

test('Glens Falls statically imports none of New York\'s modules', () => {
  const deny = ['nyc-geodata.js', 'city-config.js', 'nyc-runtime.js', 'landmarks.js', 'city-grid.js', 'boroughs.js',
    'buildings.js', 'street-details.js', 'nyc-main.js', 'nyc-map.js'];
  const leaks = [...gfGraph].filter((f) => deny.includes(f) || /^audio-.*\.js$/.test(f) || /^tree.*\.js$/.test(f));
  assert.deepEqual(leaks, []);
  assert.ok(gfGraph.has('city-runtime.js') && gfGraph.has('traffic.js'), 'the walk reaches the shared modules');
  assert.ok(nycGraph.has('city-config.js') && nycGraph.has('landmarks.js'), 'and New York\'s');
});

test('each city installs its runtime with its first import', () => {
  assert.equal(staticImports(js('nyc-main.js'))[0], './nyc-runtime.js');
  assert.equal(staticImports(js('gf-main.js'))[0], './gf-runtime.js');
});

test('preloads: index.html has the shared modules, main.js each city\'s own', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const indexPreloads = new Set([...html.matchAll(/<link rel="modulepreload" href="\.\/js\/([^"]+)"/g)].map((m) => m[1]));
  const main = js('main.js');
  const list = (name) => {
    const m = main.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`));
    assert.ok(m, `${name} in main.js`);
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1]));
  };
  const nycPreloads = list('NYC_PRELOADS');
  const gfPreloads = list('GF_PRELOADS');
  const missing = (graph, preloads) => [...graph].filter((f) => !indexPreloads.has(f) && !preloads.has(f));
  assert.deepEqual(missing(nycGraph, nycPreloads), [], 'New York\'s graph is preloaded');
  assert.deepEqual(missing(gfGraph, gfPreloads), [], 'Glens Falls\'s graph is preloaded');
  const nycOnly = [...nycGraph].filter((f) => !gfGraph.has(f));
  assert.deepEqual(nycOnly.filter((f) => indexPreloads.has(f) || gfPreloads.has(f)), [], 'Glens Falls preloads no New York module');
  assert.deepEqual([...nycPreloads].filter((f) => f.startsWith('gf-')), [], 'New York preloads no Glens Falls module');
  assert.deepEqual([...indexPreloads].filter((f) => f !== 'main.js' && !(gfGraph.has(f) && nycGraph.has(f))), [],
    'index.html preloads only main.js and modules both cities share');
});

test('city runtime: delegates once installed, installs once, knows its keys', async () => {
  const rt = await import('../js/city-runtime.js');
  assert.throws(() => rt.getIslandBoundsAtZ(0), /city runtime not set/);
  assert.throws(() => rt.streetZ(42), /city runtime not set/);
  assert.equal(rt.blockAt(1, 2), null, 'off any block before a city is installed');
  assert.throws(() => rt.setCityRuntime({ streetZ: () => 0, SHORE: [] }), /unknown city runtime key: SHORE/);
  assert.throws(() => rt.streetZ(42), /city runtime not set/, 'a refused install installs nothing');

  const block = { id: 'b' };
  const bounds = { minX: -1, maxX: 1, minZ: -2, maxZ: 2, sidewalkHeight: 0 };
  rt.setCityRuntime({
    ISLAND_BOUNDS: bounds,
    CENTRAL_PARK_BOUNDS: null,
    ROAD_SOURCE: { name: 'source' },
    PLAYER_WORLD: { name: 'world' },
    blockAt: (x, z) => (x === 3 && z === 4 ? block : null),
    getIslandBoundsAtZ: (z) => ({ westX: -z, eastX: z }),
    streetZ: (n) => n * 10
  });
  assert.equal(rt.blockAt(3, 4), block);
  assert.equal(rt.blockAt(0, 0), null);
  assert.deepEqual(rt.getIslandBoundsAtZ(5), { westX: -5, eastX: 5 });
  assert.equal(rt.streetZ(42), 420);
  assert.equal(rt.ISLAND_BOUNDS, bounds, 'live bindings');
  assert.equal(rt.CENTRAL_PARK_BOUNDS, null);
  assert.equal(rt.ROAD_SOURCE.name, 'source');
  assert.equal(rt.PLAYER_WORLD.name, 'world');
  assert.equal(rt.bryantParkLawn, null);
  rt.setBryantParkLawn({ top: 1.3 });
  assert.equal(rt.bryantParkLawn.top, 1.3);
  assert.throws(() => rt.setCityRuntime({ streetZ: () => 0 }), /already set/);
});

test('city runtime: signal cycle and typing check match city-config.js', async () => {
  const rt = await import('../js/city-runtime.js');
  const nyc = await import('../js/city-config.js');
  assert.deepEqual(rt.SIGNAL_TIMING, nyc.SIGNAL_TIMING);
  for (let t = 0; t <= 120; t += 0.5) {
    for (const ave of [true, false]) {
      assert.equal(rt.signalPhase(t, ave), nyc.signalPhase(t, ave), `signalPhase(${t}, ${ave})`);
      assert.equal(rt.walkSignal(t, ave), nyc.walkSignal(t, ave), `walkSignal(${t}, ${ave})`);
    }
  }
  for (const tagName of ['INPUT', 'SELECT', 'TEXTAREA', 'DIV']) {
    assert.equal(rt.isTypingInField({ target: { tagName } }), nyc.isTypingInField({ target: { tagName } }));
  }
});
