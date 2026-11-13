import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeTerrain, createGfTerrain } from '../js/gf-terrain.js';
import { createGfSurface } from '../js/gf-surface.js';
import { createGfBlocks } from '../js/gf-blocks.js';
import { gfBuildingsOnTerrain } from '../js/gf-building-bases.js';
import { applyLidarHeights } from '../js/gf-building-heights.js';
import { polygonContains } from '../js/building-collision.js';
import { GF_GEO } from '../js/gf-geodata.js';
import { GF_BRIDGES } from '../js/gf-bridges.js';
import { GF_BUILDINGS } from '../js/gf-buildings.js';
import { GF_LANDMARKS } from '../js/gf-landmarks.js';
import { GF_LIDAR_HEIGHTS } from '../js/gf-lidar-heights.js';
import { GF_FURNITURE } from '../js/gf-furniture.js';
import { createGfSidewalks } from '../js/gf-sidewalks.js';
import { placeStreetLights, lampGlow, styleAt, STYLES, SPACING_DOWNTOWN, REPLACE, CARRIAGEWAY, SNAP } from '../js/gf-street-lights.js';

// CC-006b: downtown's street lamps are gaslight-style posts (Dave, 1993); OSM's Glen St row stands where OSM puts it

const root = fileURLToPath(new URL('..', import.meta.url));
const terrain = createGfTerrain(decodeTerrain(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(root, 'js/gf-terrain.bin.gz'))))), GF_GEO.frame);
const surface = createGfSurface({ terrain, geo: GF_GEO, bridges: GF_BRIDGES });
const blocks = createGfBlocks(GF_GEO);
const sidewalks = createGfSidewalks({ geo: GF_GEO, blocks, ground: surface.ground });
const { obstacles } = gfBuildingsOnTerrain(applyLidarHeights(GF_BUILDINGS, GF_LIDAR_HEIGHTS).data, GF_LANDMARKS, surface.ground);
const buildings = obstacles.filter((c) => c.polygon);
const inBuilding = (x, z) => buildings.some((c) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && polygonContains(c.polygon, x, z));
const osmLamps = GF_FURNITURE.lamps.map(([x, z, osm]) => ({ x, z, osm: String(osm) }));
const plan = placeStreetLights(sidewalks, { inBuilding, osmLamps });
const downtownOsm = osmLamps.filter((o) => sidewalks.downtown(o.x, o.z));

test('every downtown lamp is gaslight-style, and no other is', () => {
  for (const l of plan.lamps) {
    const downtown = sidewalks.downtown(l.x, l.z);
    assert.equal(l.style, downtown ? 'gaslight' : 'cobra', `lamp at (${l.x}, ${l.z})`);
    assert.equal(styleAt(sidewalks, l.x, l.z), l.style);
  }
  const c = plan.counts;
  assert.ok(c.gaslight > 100 && c.cobra > 5000, JSON.stringify({ gaslight: c.gaslight, cobra: c.cobra }));
  assert.equal(c.gaslight + c.cobra, plan.lamps.length);
  // downtown keeps its assumed spacing and its lamps on the walk by the curb
  assert.equal(SPACING_DOWNTOWN, 30);
  for (const l of plan.lamps.filter((l) => l.style === 'gaslight' && l.kind === 'assumed')) {
    assert.ok(sidewalks.walkAt(l.x, l.z) || sidewalks.bandAt(l.x, l.z), `assumed gaslight at (${l.x}, ${l.z}) on the walk`);
    assert.ok(sidewalks.roadEdge(l.x, l.z) >= CARRIAGEWAY - 0.05);
  }
});

test('the OSM Glen St row: each downtown OSM lamp placed as-is, snapped to the walk, or skipped with a reason', () => {
  const d = plan.counts.osmDowntown;
  // the frozen extract's downtown lamps are the Glen St row: 12 nodes
  assert.equal(downtownOsm.length, 12);
  assert.equal(d.asIs + d.snapped + d.skipped.length, downtownOsm.length);
  for (const s of d.skipped) assert.ok(s.reason, `skipped ${s.osm} says why`);
  const placed = plan.lamps.filter((l) => l.kind === 'osm' && l.style === 'gaslight');
  assert.equal(placed.length, d.asIs + d.snapped);
  for (const l of placed) {
    const o = downtownOsm.find((m) => m.osm === l.osm);
    assert.ok(o, `OSM lamp ${l.osm} is one of the downtown nodes`);
    // never in the carriageway or a building
    assert.ok(sidewalks.roadEdge(l.x, l.z) >= CARRIAGEWAY, `${l.osm} out of the carriageway`);
    assert.ok(!inBuilding(l.x, l.z), `${l.osm} not in a building`);
    if (l.placed === 'as-is') assert.deepEqual([l.x, l.z], [o.x, o.z], `${l.osm} where OSM puts it`);
    else {
      assert.equal(l.placed, 'snapped');
      // it was in (or at) the carriageway, and moved at most SNAP onto a curb-side walk spot
      assert.ok(sidewalks.roadEdge(o.x, o.z) < CARRIAGEWAY, `${l.osm} was in the carriageway`);
      assert.ok(Math.hypot(l.x - o.x, l.z - o.z) <= SNAP && sidewalks.walkAt(l.x, l.z), `${l.osm} snapped within ${SNAP} m onto the walk`);
    }
    // it replaced the assumed lamps near it
    for (const a of plan.lamps.filter((a) => a.kind === 'assumed')) assert.ok(Math.hypot(a.x - l.x, a.z - l.z) >= REPLACE);
  }
  // the frozen extract: 10 stand where OSM puts them, 1 (in Glen St's carriageway) snaps to the walk, 1 (inside a
  // building's OSM footprint) is skipped
  assert.deepEqual([d.asIs, d.snapped, d.skipped.length], [10, 1, 1]);
  assert.deepEqual(d.skipped.map((s) => [s.osm, s.reason]), [['6842442842', 'in a building']]);
  // no other OSM lamp moved: outside downtown, CC-006's rule (on a curb band, else unused)
  for (const l of plan.lamps.filter((l) => l.kind === 'osm' && l.style === 'cobra')) {
    const o = osmLamps.find((m) => m.osm === l.osm);
    assert.deepEqual([l.x, l.z], [o.x, o.z]);
  }
  assert.equal(plan.counts.osmOffBand + plan.lamps.filter((l) => l.kind === 'osm' && l.style === 'cobra').length, osmLamps.length - downtownOsm.length);
});

test('both styles glow by the same ramp: off at midday and golden hour, on at twilight and midnight', () => {
  const lighting = fs.readFileSync(path.join(root, 'js/lighting.js'), 'utf8');
  assert.deepEqual(STYLES, ['cobra', 'gaslight']);
  for (const style of STYLES) {
    const glow = {};
    for (const id of ['golden', 'midday', 'twilight', 'midnight']) {
      const block = lighting.slice(lighting.indexOf(`  ${id}: {`));
      glow[id] = lampGlow(Number(block.match(/interiorGlow: ([0-9.]+)/)[1]), style);
    }
    assert.equal(glow.golden, 0, style);
    assert.equal(glow.midday, 0, style);
    assert.ok(glow.twilight > 0 && glow.midnight > 0, `${style}: ${JSON.stringify(glow)}`);
  }
  // the meshes: one instanced mesh per style, both lit by that ramp, neither casting sun shadows; the pool unchanged
  const meshes = fs.readFileSync(path.join(root, 'js/gf-street-furniture-meshes.js'), 'utf8');
  assert.match(meshes, /gaslight: \{ name: 'GaslightStreetLights', geometry: gaslightGeometry/);
  assert.match(meshes, /mat\.emissiveNode = color\(spec\.glow\)\.mul\(glow\)\.mul\(smoothstep\(GLOW_ON\[0\], GLOW_ON\[1\], cityUniforms\.uInteriorGlow\)\)/);
  assert.match(meshes, /new THREE\.InstancedMesh\(geometry, mat, list\.length\)/);
  assert.match(meshes, /mesh\.castShadow = false;/);
  assert.match(meshes, /^const POOL = 32;/m);
  // the gaslight's proportions are one assumed constant, about 4 m tall, near-black, no arm
  const g = meshes.slice(meshes.indexOf('const GASLIGHT = {'), meshes.indexOf('};', meshes.indexOf('const GASLIGHT = {')));
  assert.match(meshes, /every proportion here is ASSUMED/);
  const top = Number(g.match(/shaft: \{ r: [0-9.]+, top: ([0-9.]+)/)[1]) + Number(g.match(/collar: \{ r: [0-9.]+, h: ([0-9.]+)/)[1])
    + Number(g.match(/lantern: \{ w: [0-9.]+, h: ([0-9.]+)/)[1]) + Number(g.match(/cap: \{ r: [0-9.]+, h: ([0-9.]+)/)[1]) + 2 * Number(g.match(/finial: ([0-9.]+)/)[1]);
  assert.ok(top > 3.6 && top < 4.4, `gaslight ${top.toFixed(2)} m tall`);
  assert.doesNotMatch(g, /\barm\b/);
});

test('New York loads none of it', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  for (const f of ['js/nyc-main.js', 'js/nyc-runtime.js', 'js/city-runtime.js', 'js/street-details.js', 'js/city-grid.js', 'js/traffic.js']) {
    assert.doesNotMatch(read(f), /gaslight|gf-street-lights|gf-street-furniture-meshes/i, f);
  }
  const main = read('js/main.js');
  const nyc = main.slice(main.indexOf('NYC_PRELOADS'), main.indexOf('];', main.indexOf('NYC_PRELOADS')));
  assert.doesNotMatch(nyc, /gf-/);
});
