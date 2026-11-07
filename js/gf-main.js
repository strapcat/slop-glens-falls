import { GF_BLOCKS, GF_SURFACE, GF_TERRAIN } from './gf-runtime.js'; // first: installs Glens Falls in the city runtime before any shared module runs
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { createPostProcessing } from './post-processing.js';
import { createTrafficSystem } from './traffic.js';
import { buildRoadPaint } from './road-paint.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { ROAD_SOURCE, PLAYER_WORLD, isTypingInField } from './city-runtime.js';
import { GF_GEO } from './gf-geodata.js';
import { gfSpawn } from './gf-roadgraph.js';
import { buildGfTerrainGround, ROAD_LIFT } from './gf-ground.js';
import { DRAPE_TOL } from './gf-drape.js';
import { GF_BRIDGES } from './gf-bridges.js';
import { GF_TERRAIN_BYTES } from './gf-terrain-data.js';
import { GF_SIGNALS } from './gf-signals.js';
import { buildGfSignalHeads } from './gf-signal-heads.js';
import { GF_BUILDINGS } from './gf-buildings.js';
import { buildGfBuildingsOnTerrain } from './gf-building-terrain.js';
import { GF_LANDMARKS } from './gf-landmarks.js';
import { GF_LIDAR_HEIGHTS } from './gf-lidar-heights.js';
import { applyLidarHeights } from './gf-building-heights.js';
import { polygonContains } from './building-collision.js';
import { createTreeField } from './trees.js';
import { GF_TREES } from './gf-trees.js';
import { placeGfTrees } from './gf-tree-placements.js';

// Glens Falls game view (index.html?city=glensfalls): the town from GF_GEO (roads, water, blocks) on its sourced terrain
// (CC-005b: USGS 3DEP bare earth, gf-terrain.js, asked through gf-surface.js by everything that stands on it), its road graph
// driven by AI cars stopping at the OSM traffic signals, pedestrians on the blocks' sidewalks, road markings, signal
// heads and the player. Setup, shader warm-up and frame loop follow nyc-main.js, without New York's city grid, boroughs,
// landmarks, buildings, street details, map, teleports or audio.

const NUM_CARS = 40;
// Pedestrians walk the sidewalk band between each block's curb and its lot (1.8 m wide), on two walking lines 0.6 and
// 1.2 m from the roadway, on the terrain (a deck where their track runs along a bridge); there are no crosswalks yet.
// Their sidewalk is the ground's own (2 cm above it); crossing a road they walk on its draped asphalt
const PEDESTRIANS = {
  numPeds: 120,
  sidewalkY: 0.02,
  crosswalkY: ROAD_LIFT + 0.012,
  onSidewalk: GF_BLOCKS.onSidewalk,
  trackInsets: [0.6, 1.2],
  groundAt: (x, z, ux, uz) => GF_SURFACE.road(x, z, ux, uz)
};
// The drawn asphalt (draped ribbons, gf-drape.js) for a vehicle heading (dirX, dirZ) that last stood at lastY: deck or
// ground, plus ROAD_LIFT
const roadSurface = (x, z, dirX, dirZ, lastY = NaN) => GF_SURFACE.road(x, z, dirX, dirZ, lastY - ROAD_LIFT) + ROAD_LIFT;
const STATE_KEY = 'gf-player-state';
// Follow cameras only: New York's scenic cameras look at Manhattan landmarks
const FOLLOW_CAMERAS = CAMERA_PRESETS.filter((p) => p.category === 'follow');

// HUD parts nyc-main.js wires that have nothing to do here: teleports, the map, sound, the street-name signs and
// New York's scenic cameras
function trimHud() {
  const hide = (el) => { if (el) el.style.display = 'none'; };
  for (const id of ['btn-teleport', 'btn-open-map', 'btn-sound', 'minimap-card', 'hud-location', 'teleport-popover', 'fullmap-modal']) {
    hide(document.getElementById(id));
  }
  document.querySelectorAll('[data-camera]').forEach((btn) => {
    if (!FOLLOW_CAMERAS.some((p) => p.id === btn.getAttribute('data-camera'))) hide(btn);
  });
  document.title = 'Slop Glens Falls';
  const title = document.querySelector('.loader-title');
  if (title) title.textContent = 'Slop Glens Falls';
  const heading = document.querySelector('.brand-heading h1');
  if (heading) heading.textContent = 'Slop Glens Falls';
  for (const bullet of document.querySelectorAll('.loader-bullet, .brand .mta-bullet')) bullet.textContent = 'GF';
  // The rest of index.html's New York wording, for screen readers, link previews and the hidden map parts
  const set = (selector, attrs) => {
    const el = document.querySelector(selector);
    if (el) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  };
  set('meta[name="description"]', { content: 'Slop Glens Falls: a three.js WebGPU sim of Glens Falls and South Glens Falls, NY, '
    + 'built from OpenStreetMap roads, signals and building footprints; a fork of mrdoob/slop-newyork.' });
  set('#canvas-container', { 'aria-label': '3D Interactive Slop Glens Falls Viewport' });
  set('.repo-link', { href: 'https://github.com/strapcat/slop-glens-falls/',
    'aria-label': 'Slop Glens Falls on GitHub, a fork of mrdoob/slop-newyork (opens in a new tab)',
    title: 'strapcat/slop-glens-falls, forked from mrdoob/slop-newyork' });
  set('#btn-open-map', { title: 'Street map (not available in Glens Falls)', 'aria-label': 'Street map (not available in Glens Falls)' });
  set('#minimap-card', { 'aria-label': 'Street radar minimap (not available in Glens Falls)', title: 'Street map (not available in Glens Falls)' });
  set('#fullmap-modal', { 'aria-label': 'Street map (not available in Glens Falls)' });
  // © OpenStreetMap contributors: every road, block and pond on screen comes from OSM (ODbL)
  const credit = document.createElement('div');
  credit.id = 'gf-attribution';
  credit.style.cssText = 'position:fixed;left:8px;bottom:6px;z-index:40;font:11px/1.3 Inter,system-ui,sans-serif;' +
    'color:rgba(255,255,255,0.85);background:rgba(10,12,16,0.55);padding:3px 7px;border-radius:4px;pointer-events:auto';
  const link = document.createElement('a');
  link.href = 'https://www.openstreetmap.org/copyright';
  link.target = '_blank';
  link.rel = 'noopener';
  link.style.color = 'inherit';
  link.textContent = 'OpenStreetMap contributors';
  credit.append('Map data © ', link, ' (ODbL)', document.createElement('br'), GF_LIDAR_HEIGHTS.credit.replace(/^Building heights:/, 'Building heights and trees:'));
  document.body.appendChild(credit);
}

async function initApp() {
  trimHud();
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingTrack = loadingOverlay ? loadingOverlay.querySelector('.loader-track') : null;
  const loadingFill = document.getElementById('loading-progress');
  // Only shader compilation has measurable progress; other stages use the sweeping bar.
  const setLoadingProgress = (p) => {
    if (!loadingFill) return;
    if (loadingTrack) loadingTrack.classList.remove('is-indeterminate');
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };

  async function showLoadingStage(message) {
    if (loadingStatus) loadingStatus.textContent = message;
    if (loadingTrack) loadingTrack.classList.add('is-indeterminate');
    if (document.hidden) return;
    // Let the label paint before synchronous work. The timeout also lets hidden tabs keep loading.
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        setTimeout(resolve, 0);
      });
    });
  }

  await showLoadingStage('Initializing graphics...');

  // 1. WebGPURenderer with 32-bit float reversedDepthBuffer
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true
  });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    initTimings.push(`${label} ${Math.round(now - initMark)}ms`);
    initMark = now;
  };

  await renderer.init();
  markInit('renderer');

  // 2. Scene, atmosphere and lighting
  await showLoadingStage('Creating sky and environment lighting...');
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);
  markInit('lighting');

  // 3. The terrain, roads, water and bridge decks; road graph & traffic, road markings
  await showLoadingStage('Laying out the terrain, roads and water...');
  const ground = buildGfTerrainGround(scene, GF_GEO, GF_SURFACE, GF_BLOCKS, GF_BRIDGES);
  {
    const h = GF_TERRAIN.header;
    const waterTypes = GF_SURFACE.water.bodies.reduce((o, b) => ({ ...o, [b.type]: (o[b.type] || 0) + 1 }), {});
    console.info(`[gf] terrain: USGS 3DEP ${h.base.cols} x ${h.base.rows} at 2 m + ${h.patches.tilesKept} native 1 m tiles + ${h.ring.cols} x ${h.ring.rows} ring at 8 m (${GF_TERRAIN_BYTES.download} bytes); anchor OSM ${h.anchor.osmNode} at ${h.anchor.navd88.toFixed(3)} m NAVD88 = y 0; ${GF_SURFACE.decks.length} bridge decks, water ${Object.entries(waterTypes).map(([t, n]) => `${n} ${t}`).join(', ')}; roads ${ground.stats.roadTriangles} triangles in ${ground.stats.roadChunks} chunks`);
  }
  markInit('ground');
  await showLoadingStage('Raising buildings...');
  // OSM footprints, flat-roofed. Heights: OSM height or levels where tagged; else measured from USGS 3DEP LiDAR
  // (2022-23, gf-lidar-heights.js, src 4) where the measurement passed its quality checks; else gf-buildings.js's
  // default rule (an approximation, see heightRule). CC-004: the sourced landmark overrides (gf-landmarks.js) go on
  // top of those records and win, with their roof shapes and the Civil War Monument
  const { data: gfBuildings, applied: heights } = applyLidarHeights(GF_BUILDINGS, GF_LIDAR_HEIGHTS);
  // CC-005b: each building on its own base on the terrain (gf-building-terrain.js), its height above that base
  const buildings = buildGfBuildingsOnTerrain(scene, gfBuildings, GF_LANDMARKS, GF_SURFACE.ground);
  const { records: perStyle, meshes, triangles } = buildings.stats;
  console.info(`[gf] ${Object.values(perStyle).reduce((n, v) => n + v, 0)} buildings (${Object.entries(perStyle).map(([s, n]) => `${n} ${s}`).join(', ')}): ${meshes} meshes, ${triangles} triangles`);
  {
    const { applied, features, pending, shapes } = buildings.landmarks;
    const daveWaiting = pending.filter((p) => p.daveRequested);
    console.info(`[gf] landmarks: ${applied.length} buildings overridden (${applied.filter((a) => a.after.src === GF_LANDMARKS.srcCode).length} src 3 sourced heights), ${features.length} features (${Object.entries(shapes.types).map(([t, n]) => `${n} ${t}`).join(', ')}), ${pending.length} pending`);
    console.info(`[gf] landmarks pending for Dave: ${daveWaiting.map((p) => `${p.id} (${p.what})`).join('; ')}`);
  }
  {
    // the final height source of every building: the LiDAR copy's, then any landmark overrides (CC-004) on top
    const LABELS = { 0: 'tag', 1: 'levels', 3: 'landmark', [GF_LIDAR_HEIGHTS.srcCode]: GF_LIDAR_HEIGHTS.srcLabel, 2: 'default rule (approximation)' };
    const bySrc = { ...heights.bySrc };
    for (const a of buildings.landmarks?.applied ?? []) {
      bySrc[a.before.src]--;
      bySrc[a.after.src] = (bySrc[a.after.src] || 0) + 1;
    }
    heights.final = Object.fromEntries([0, 1, 3, GF_LIDAR_HEIGHTS.srcCode, 2].map((k) => [LABELS[k], bySrc[k] || 0]));
    console.info(`[gf] heights: ${Object.entries(heights.final).map(([k, n]) => `${n} ${k}`).join(', ')}`);
    const t = buildings.stats.terrain;
    console.info(`[gf] building bases on the terrain: ${t.foundationsOver1m} with the ground falling > 1 m under their walls (> 3 m: ${t.foundationsOver3m}, deepest ${t.maxFoundation.toFixed(1)} m), ${t.buriedOver1m} with it rising > 1 m (> 3 m: ${t.buriedOver3m}, most ${t.maxBurial.toFixed(1)} m)`);
  }
  markInit('buildings');
  await showLoadingStage('Planting trees...');
  // CC-005: one tree per usable LiDAR canopy top (gf-trees.js, USGS 3DEP 2022-23), at its measured height and about its
  // measured spread, drawn by the shared renderer (trees.js; no New York tree data). The species slot is a visual
  // shape mix, not a surveyed species. No building colliders go to the renderer: the data already keeps tops about
  // 1 m off every wall, and real crowns do overhang roofs (slopGlensFalls.trees.diagnoseBuildingColliders() counts
  // how many trees they would drop).
  const treePlan = placeGfTrees(GF_TREES, { buildings: GF_BUILDINGS, geo: GF_GEO, ground: GF_SURFACE.ground });
  const treeField = createTreeField(scene, treePlan.sites, []);
  scene.add(treeField.group);
  {
    const { water, road, building } = treePlan.skipped;
    const mix = treePlan.speciesCounts.map((n, s) => `${['plane', 'locust', 'elm'][s]}-shape ${n}`).join(', ');
    console.info(`[gf] trees: ${treeField.stats.trees} of ${GF_TREES.counts.usable} LiDAR tops (skipped water ${water}, road ${road}, building ${building}), ${treeField.group.children.length} cells, species mix ${mix} (visual only)`);
  }
  markInit('trees');
  await showLoadingStage('Creating traffic...');
  // The OSM signals (gf-signals.js) as they are: the network signals the junction within 6 m of each (road-network.js 8.)
  const signalPoints = GF_SIGNALS.junctions.map(([x, z]) => ({ x, z }));
  // Lots and buildings stop pedestrians only; cars keep the road network they had without them
  const trafficSystem = createTrafficSystem(scene, [], [...GF_BLOCKS.lotObstacles, ...buildings.obstacles], signalPoints, {
    roadSource: ROAD_SOURCE, numCars: NUM_CARS, numBuses: 0, pedestrians: true, pedestrianOptions: PEDESTRIANS, surfaceAt: roadSurface
  });
  const signalHeads = buildGfSignalHeads(scene, trafficSystem.network, GF_SURFACE.ground);
  console.info(`[gf] ${trafficSystem.network.nodes.filter((n) => n.signal).length} signalled junctions of ${signalPoints.length} OSM signals, ${signalHeads.count} signal heads, ${PEDESTRIANS.numPeds} pedestrians`);
  markInit('traffic');
  await showLoadingStage('Adding road markings...');
  // on the draped asphalt, high enough above it to clear the ribbon wherever its chord bows up (DRAPE_TOL)
  buildRoadPaint(scene, trafficSystem.network, null, { surfaceAt: roadSurface, lift: 0.012 + DRAPE_TOL });
  markInit('roadPaint');

  // 4. Player (Person, Car, Cyclist, Helicopter) & cameras
  await showLoadingStage('Preparing player, vehicles and controls...');
  const spawn = gfSpawn(trafficSystem.network, GF_GEO);
  console.info(`[gf] spawn on ${spawn.street || 'the longest edge (no Glen Street edge)'}: edge ${spawn.edge} at (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}), heading ${(spawn.heading * 180 / Math.PI).toFixed(1)}°`);
  // A point inside a building's walls (below its roof, above its foundation): no place to start or return to. On the
  // terrain a walker or a car is where the ground puts it, so that is the height tested
  const insideBuilding = (x, z, y = GF_SURFACE.support(x, z)) => buildings.colliders.some((c) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ
    && y < c.maxY && y >= c.minY - 0.5 && polygonContains(c.polygon, x, z));
  if (insideBuilding(spawn.x, spawn.z)) console.warn('[gf] the spawn point is inside a building');
  // The player's world (gf-runtime.js: the bbox, the terrain, no raised sidewalks), starting at the spawn; buildings
  // collide ... and tree trunks (gf-tree-placements.js), which the player bumps into and flies over, and the bridge
  // railings (gf-ground.js), which keep the player on a deck
  const controllerManager = new ThirdPersonControllerManager(scene, [...buildings.colliders, ...treePlan.trunks, ...ground.deckColliders], { ...PLAYER_WORLD, spawn });
  // The terrain's chunks round the start, built now so that the shader warm-up sees them
  ground.terrain.update({ x: spawn.x, y: GF_SURFACE.ground(spawn.x, spawn.z) + 3, z: spawn.z });
  // Glens Falls names in the HUD (controllers.js labels the car New York's yellow cab)
  controllerManager.entities.car.label = 'Taxi';
  controllerManager.entities.cyclist.label = 'Cyclist';
  // Reuse teleport placement so saved players return at rest, close to their last positions.
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY));
    if (saved?.version === 1) {
      for (const mode of Object.keys(controllerManager.entities)) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode);
        // The saved height picks the deck or the ground under it (a save from the flat town, y about 0, takes
        // whichever is nearer 0; it is put on the ground either way, never left under it)
        if (mode !== 'helicopter') PLAYER_WORLD.setNear(mode, p.y);
        // A position saved before the buildings stood may now be inside one: back to the spawn
        if (insideBuilding(p.x, p.z, mode === 'helicopter' ? p.y : GF_SURFACE.support(p.x, p.z, p.y))) {
          console.info(`[gf] saved ${mode} position (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) is inside a building: back to the spawn`);
          controllerManager.teleportActiveTo(spawn.x, spawn.z, spawn.heading);
        } else controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y);
      }
      controllerManager.setMode(Object.hasOwn(controllerManager.entities, saved.activeMode) ? saved.activeMode : 'car');
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }

  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading
      }]));
      localStorage.setItem(STATE_KEY, JSON.stringify({ version: 1, activeMode: controllerManager.activeMode, entities }));
    } catch { /* Storage may be disabled or full. */ }
  }

  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  const touchControls = new TouchControls(controllerManager);
  window.addEventListener('pagehide', savePlayerState);
  // For the console and automated checks (cars driving, where the player is)
  globalThis.slopGlensFalls = {
    trafficSystem, controllerManager, cameraSystem, spawn, buildings: buildings.stats,
    // CC-003b: the count of buildings per final height source (LiDAR, landmark, OSM, default rule)
    heights,
    // CC-004: what was applied (with sources and confidence), what is waiting on data, and the approximate shape sizes
    landmarks: {
      applied: buildings.landmarks.applied,
      features: buildings.landmarks.features.map(({ polygon, ...f }) => f),
      pending: buildings.landmarks.pending,
      flagged: buildings.landmarks.flagged,
      shapes: buildings.landmarks.shapes
    },
    // CC-005b: the terrain and its one surface contract (ground, decks, support, road, water, info at any x, z), the
    // ground meshes and how the buildings sit on it
    terrain: {
      surface: GF_SURFACE,
      info: (x, z) => GF_SURFACE.info(x, z),
      header: GF_TERRAIN.header,
      bytes: GF_TERRAIN_BYTES,
      mesh: ground.terrain.stats,
      ground: ground.stats,
      buildings: buildings.stats.terrain,
      // seed the deck-or-ground choice for a mode (a saved height), as the saved-player restore does
      setNear: PLAYER_WORLD.setNear
    },
    // CC-005: the LiDAR tree field (renderer stats) and the trees the placement skipped as a safety net
    trees: {
      stats: { ...treeField.stats, placed: treePlan.sites.length, usable: GF_TREES.counts.usable, cells: treeField.group.children.length, speciesCounts: treePlan.speciesCounts },
      skipped: treePlan.skipped,
      // Diagnostic only: how many trees createTreeField would drop if it were given the building colliders. Builds a
      // second, throwaway field, so it runs only when called.
      diagnoseBuildingColliders: () => {
        const probe = createTreeField(null, treePlan.sites, buildings.colliders);
        return { placed: treePlan.sites.length, kept: probe.stats.trees, wouldDrop: treePlan.sites.length - probe.stats.trees };
      }
    }
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });
  markInit('controllers');

  // Static world matrices once; the player and traffic move every frame
  const dynamicRoots = [
    trafficSystem.group,
    ...Object.values(controllerManager.entities).map((entity) => entity.mesh),
    controllerManager.entities.cyclist.helmet
  ];
  scene.updateMatrixWorld(true);
  scene.matrixWorldAutoUpdate = false;

  // On WebGPU, small InstancedMeshes keep their matrices in uniform buffers re-uploaded on every draw of every pass;
  // storage attributes only upload when needed (see nyc-main.js). WebGL2 needs ordinary instanced attributes.
  if (renderer.backend.isWebGPUBackend) {
    scene.traverse((object) => {
      if (object.isInstancedMesh) {
        object.instanceMatrix = new THREE.StorageInstancedBufferAttribute(object.instanceMatrix.array, 16);
      }
    });
  }

  // 5. TSL RenderPipeline with Half-Res Screen Space Reflections (SSRNode), Bloom & Filmic Toning (as nyc-main.js)
  await showLoadingStage('Setting up visual effects and interface...');
  const scenePass = pass(scene, cameraSystem.camera);
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  const sceneMRT = mrt({
    output: output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);

  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassDepth = scenePass.getTextureNode('depth');
  const scenePassNormal = scenePass.getTextureNode('normal');
  const scenePassMetalRough = scenePass.getTextureNode('metalRough');

  const ssrPass = ssr(scenePassColor, scenePassDepth, scenePassNormal, {
    metalnessNode: scenePassMetalRough.r,
    roughnessNode: scenePassMetalRough.g,
    camera: cameraSystem.camera
  });
  ssrPass.resolutionScale = 0.5;
  ssrPass.blurQuality = 1;
  ssrPass.maxDistance.value = 42;
  ssrPass.thickness.value = 0.85;
  ssrPass.quality.value = 0.25;
  ssrPass.binaryRefine = true;
  ssrPass.intensity.value = 0.50;
  ssrPass.screenEdgeFadeBlack = true;

  const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
  const reflections = ssrPass.mul(reflectionMask);
  const colorGrade = createPostProcessing(renderer, scenePassColor, reflections);
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // 6. UI: modes, follow cameras, time of day, HUD toggle (safe DOM APIs only)
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  touchControls.onAvailabilityChange = placeModeIndicator;

  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'helicopter'];
      selectMode(modes[(modes.indexOf(controllerManager.activeMode) + step + modes.length) % modes.length]);
    },
    onCycleCamera: cycleCamera,
    onToggleMap: () => {},
    onCloseMap: () => {}
  });

  // Keyboard guide for each mode: [keys, action]
  const controlHints = {
    person: [[['W', 'S'], 'Walk / Run'], [['A', 'D'], 'Turn'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
    car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['Drag'], 'Orbit']],
    cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Drag'], 'Orbit']],
    helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Ascend'], [['Q', 'C'], 'Descend']]
  };
  // Top speeds in mph (controllers.js caps them at 8.2, 36, 19 & 52 m/s): full scale of the speed meter
  const topSpeedMph = { person: 18, car: 81, cyclist: 43, helicopter: 116 };

  function renderControlHints(mode) {
    if (!elControlsHint) return;
    const items = (controlHints[mode] || []).map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = action;
      item.appendChild(label);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }

  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  function selectMode(mode) {
    controllerManager.setMode(mode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    document.body.dataset.mode = mode;
    placeModeIndicator();
    const ent = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = ent.label;
    renderControlHints(mode);
  }

  function selectCamera(camId, snap = false) {
    if (!FOLLOW_CAMERAS.some((p) => p.id === camId)) return;
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
    });
    const preset = cameraSystem.getActivePreset();
    if (elCamera) elCamera.textContent = preset.name;
  }

  // Steps through the follow cameras (V / Shift+V, and the arrows either side of the camera name)
  function cycleCamera(step) {
    const n = FOLLOW_CAMERAS.length;
    const idx = FOLLOW_CAMERAS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(FOLLOW_CAMERAS[(idx + step + n) % n].id, true);
  }

  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-time') === timeId);
    });
  }

  // Popovers (native [popover]) open against the control that toggles them (as nyc-main.js)
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  modeButtons.forEach((btn) => btn.addEventListener('click', () => selectMode(btn.getAttribute('data-mode'))));
  cameraButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCamera(btn.getAttribute('data-camera'), true);
      closePopovers();
    });
  });
  document.getElementById('cam-prev')?.addEventListener('click', () => cycleCamera(-1));
  document.getElementById('cam-next')?.addEventListener('click', () => cycleCamera(1));
  timeButtons.forEach((btn) => btn.addEventListener('click', () => selectTime(btn.getAttribute('data-time'))));

  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      const isMin = document.body.classList.contains('hud-minimized');
      hudToggleBtn.setAttribute('aria-pressed', String(isMin));
      hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
      hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
      if (isMin) closePopovers();
    });
  }

  // Keyboard shortcuts for modes (1-4), follow cameras (V / 5-7) and the HUD (H)
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    const modes = { Digit1: 'person', Digit2: 'car', Digit3: 'cyclist', Digit4: 'helicopter' };
    const cameras = { Digit5: 'chase', Digit6: 'action', Digit7: 'pov' };
    if (modes[e.code]) selectMode(modes[e.code]);
    else if (cameras[e.code]) selectCamera(cameras[e.code], true);
    else if (e.code === 'KeyV') cycleCamera(e.shiftKey ? -1 : 1);
    else if (e.code === 'KeyH' && hudToggleBtn) hudToggleBtn.click();
  });

  window.addEventListener('resize', () => {
    cameraSystem.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeModeIndicator();
  });

  selectMode(controllerManager.activeMode);
  selectCamera('chase', true);
  selectTime('golden');
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  markInit('ui');

  // Compile shaders behind the loading screen (as nyc-main.js)
  const COMPILE_POOL = 16;
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  async function precompileShaders() {
    await showLoadingStage('Preparing reflections and bloom...');
    scene.visible = false;
    renderPipeline.render();
    scene.visible = true;
    markInit('postFX');

    const culled = [];
    const jobs = [];
    const jobByMaterial = new Map();
    const pipelines = new Set();
    scene.traverseVisible((o) => {
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      if (o.userData.shadowProxy) return;
      const pipeline = o.userData.sharesPipelineWith || o;
      if (pipelines.has(pipeline)) return;
      pipelines.add(pipeline);
      if (o.isInstancedMesh || Array.isArray(o.material)) {
        jobs.push([o]);
        return;
      }
      let job = jobByMaterial.get(o.material);
      if (!job) {
        job = [];
        jobByMaterial.set(o.material, job);
        jobs.push(job);
      }
      job.push(o);
    });

    await showLoadingStage(`Compiling scene shaders... 0 / ${jobs.length} batches`);
    setLoadingProgress(0);
    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(sceneMRT);
    const compile = async (object) => {
      await nextTask();
      try {
        await renderer.compileAsync(object, cameraSystem.camera, scene);
      } catch (e) {
        console.warn('[compile]', e); // the warm-up frame compiles it instead
      }
    };
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        for (const object of job) await compile(object);
        done++;
        if (loadingStatus) {
          loadingStatus.textContent = `Compiling scene shaders... ${done} / ${jobs.length} batches (${Math.round((done / jobs.length) * 100)}%)`;
        }
        setLoadingProgress(done / jobs.length);
      }
    };
    await Promise.all(Array.from({ length: COMPILE_POOL }, worker));
    renderer.setMRT(null);
    renderer.setRenderTarget(null);
    for (const o of culled) o.frustumCulled = true;
  }

  await precompileShaders();
  markInit('compile');
  await showLoadingStage('Preparing shadows and the first frame...');

  // 7. Animation Loop
  let lastTime = performance.now();
  let elapsed = 0;
  // Console / automated checks: run the clock and the traffic ahead by `seconds` (30 steps a second) without rendering,
  // e.g. to let queues form at the signals where frames are slow
  globalThis.slopGlensFalls.advance = (seconds) => {
    for (let i = 0; i < seconds * 30; i++) {
      elapsed += 1 / 30;
      trafficSystem.update(1 / 30, elapsed, cameraSystem.currentPos, controllerManager.getActiveEntity(), controllerManager.activeMode, cameraSystem.camera);
    }
    signalHeads.update(elapsed);
    treeField.update(cameraSystem.currentPos);
    return elapsed;
  };
  let frameCount = 0;
  let fpsTimer = 0;
  const shadowFocus = new THREE.Vector3();
  let nextPlayerSave = 0;
  let warmedUp = false;

  if (elFps) elFps.textContent = '60';

  renderer.setAnimationLoop((now) => {
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;

    gamepadControls.update(dt);
    controllerManager.update(dt, elapsed, cameraSystem.initialized ? cameraSystem.currentPos : null);
    cameraSystem.update(dt, elapsed);
    ground.terrain.update(cameraSystem.camera.position);
    treeField.update(cameraSystem.currentPos);
    trafficSystem.update(
      dt,
      elapsed,
      cameraSystem.currentPos,
      controllerManager.getActiveEntity(),
      controllerManager.activeMode,
      cameraSystem.camera
    );
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    signalHeads.update(elapsed);
    // the shadow distance grows with the camera's height above the ground (not above y = 0, which the terrain is not)
    const cam = cameraSystem.currentPos, below = GF_SURFACE.ground(cam.x, cam.z);
    shadowFocus.set(cam.x, cam.y - (Number.isFinite(below) ? below : 0), cam.z);
    lightingSystem.update(shadowFocus);
    for (const root of dynamicRoots) root.updateMatrixWorld();

    if (!warmedUp) {
      // First frame = pipeline warm-up behind the loading screen, with frustum culling off (see nyc-main.js)
      const culled = [];
      const pipelines = new Set();
      scene.traverseVisible((o) => {
        const pipeline = o.userData.sharesPipelineWith || o;
        if (pipelines.has(pipeline)) return;
        pipelines.add(pipeline);
        if (o.frustumCulled) {
          culled.push(o);
          o.frustumCulled = false;
        }
      });
      renderPipeline.render();
      for (const o of culled) o.frustumCulled = true;
      markInit('warmup');
    }
    renderPipeline.render();
    if (!warmedUp) {
      warmedUp = true;
      markInit('firstFrame');
      const device = renderer.backend.device;
      if (loadingStatus) loadingStatus.textContent = 'Waiting for graphics to finish the first frame...';
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${initTimings.join(', ')}`);
        initTimings = null;
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        setLoadingProgress(1);
      });
    }

    // Telemetry uses wall time (updates DOM every 250ms)
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;
      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const mph = Math.round(Math.abs(activeEnt.speed) * 2.237);
      const groundY = GF_SURFACE.ground(activeEnt.position.x, activeEnt.position.z);
      const altFt = Math.max(0, Math.round((activeEnt.position.y - (Number.isFinite(groundY) ? groundY : 0)) * 3.281));
      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(mph);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, mph / (topSpeedMph[mode] || 80))})`;
      if (elAltitude) elAltitude.textContent = altFt.toLocaleString('en-US');
    }
  });
}

initApp();
