import * as THREE from 'three/webgpu';
import { createGfTerrainMesh } from './gf-terrain-mesh.js';
import { drapeRoads, ROAD_LIFT } from './gf-drape.js';

// Glens Falls ground from GF_GEO (js/gf-geodata.js): road ribbons at their curb widths, water, block tint and the
// ground under them. The ribbon and shape builders are shared with the geodata debug view (gf-debug.js), which stays
// flat; buildGfGround() is the flat layout (y = 0) the game drew before CC-005b; buildGfTerrainGround() lays the game
// view's ground (gf-main.js) on the sourced terrain (gf-surface.js), with the road markings (road-paint.js) just above.

// Polygons are flat [x0, z0, x1, z1, ...] arrays. Shapes are built in (x, -z) and turned flat with rotateX(-90°),
// which maps shape (x, y) to world (x, z = -y)
const unflat = (f) => { const r = []; for (let i = 0; i < f.length; i += 2) r.push(new THREE.Vector2(f[i], -f[i + 1])); return r; };
const shapeOf = (outer, holes) => {
  const s = new THREE.Shape(unflat(outer));
  for (const h of holes) s.holes.push(new THREE.Path(unflat(h)));
  return s;
};
function flatShapes(shapes, y, extrude) {
  const g = extrude ? new THREE.ExtrudeGeometry(shapes, { depth: extrude, bevelEnabled: false }) : new THREE.ShapeGeometry(shapes);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

// Flat ribbon (quad per segment + round joins) at height y of every link whose highway class index passes include()
function roadRibbonGeometry(graph, include, y) {
  const { nodes, links } = graph;
  const pos = [];
  const disc = (x, z, r) => {
    const n = 8;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      pos.push(x, y, z, x + Math.cos(a1) * r, y, z + Math.sin(a1) * r, x + Math.cos(a0) * r, y, z + Math.sin(a0) * r);
    }
  };
  for (const [a, b, , cls, , , width, inner] of links) {
    if (!include(cls)) continue;
    const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
    const r = width / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 1e-6) continue;
      const nx = (-(z1 - z0) / L) * r, nz = ((x1 - x0) / L) * r;
      pos.push(x0 + nx, y, z0 + nz, x1 - nx, y, z1 - nz, x1 + nx, y, z1 + nz);
      pos.push(x0 + nx, y, z0 + nz, x0 - nx, y, z0 - nz, x1 - nx, y, z1 - nz);
    }
    for (const [x, z] of pts) disc(x, z, r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// The game view's layers, all flat and centimetres apart over kilometres: polygon offset (larger = further back) keeps
// the markings over the roads, the roads over water (bridges) and blocks, and everything over the ground
const LAYERS = { road: 1, service: 2, water: 3, lot: 3.5, block: 4, ground: 5 };
const flatMaterial = (color, roughness, layer) => new THREE.MeshStandardMaterial({
  color, roughness, metalness: 0, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: layer, polygonOffsetUnits: 4 * layer
});
// Lit as the flat ground it is, whichever way its triangles wind
function faceUp(g) {
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

// The ground plane over the bbox (padded), water, block tint (curb islands, flat: the sidewalk band between curb and
// lot in concrete, the lots darker over it) and road ribbons of every class: service roads (drawn, not driven, see
// gf-roadgraph.js DRIVE_CLASSES) a shade lighter
function buildGfGround(scene, geo, { blocks = true } = {}) {
  const group = new THREE.Group();
  group.name = 'GlensFallsGround';
  const { bbox, roadGraph, water } = geo;
  const meshes = [];
  const add = (g, mat, name) => {
    const m = new THREE.Mesh(faceUp(g), mat);
    m.name = name;
    m.receiveShadow = true;
    meshes.push(m);
    group.add(m);
  };

  const pad = 400;
  const ground = new THREE.PlaneGeometry(bbox.x1 - bbox.x0 + 2 * pad, bbox.z1 - bbox.z0 + 2 * pad);
  ground.rotateX(-Math.PI / 2);
  ground.translate((bbox.x0 + bbox.x1) / 2, -0.04, (bbox.z0 + bbox.z1) / 2);
  add(ground, flatMaterial(0x4f5a44, 0.95, LAYERS.ground), 'Ground');
  if (blocks && geo.blocks.length) {
    add(flatShapes(geo.blocks.map((b) => shapeOf(b.curb, b.curbHoles)), -0.03), flatMaterial(0x8f8c83, 0.9, LAYERS.block), 'BlockTint');
    const lots = geo.blocks.filter((b) => b.lot);
    if (lots.length) add(flatShapes(lots.map((b) => shapeOf(b.lot, b.lotHoles)), -0.025), flatMaterial(0x6b6a61, 0.95, LAYERS.lot), 'LotTint');
  }
  if (water.length) add(flatShapes(water.map((w) => shapeOf(w.outer, w.holes)), -0.02), flatMaterial(0x2b5a7c, 0.25, LAYERS.water), 'Water');
  const service = roadGraph.classes.indexOf('service');
  add(roadRibbonGeometry(roadGraph, (c) => c === service, 0), flatMaterial(0x4a4c50, 0.85, LAYERS.service), 'ServiceRoads');
  add(roadRibbonGeometry(roadGraph, (c) => c !== service, 0), flatMaterial(0x34363a, 0.85, LAYERS.road), 'Roads');

  scene.add(group);
  return { group, meshes };
}

const WATER_LIFT = 0.05; // the water surface over the hydro-flattened DEM it lies on
const WATER_EDGE = 6; // metres: graded water is subdivided until no triangle edge is longer
const CHUNK = 1000; // metres: road ribbons are cut into cells this size so the camera culls them

// Longest-edge bisection of a triangle soup until no edge is longer than maxEdge (shared midpoints, so no cracks)
function subdivide(pos, tris, maxEdge) {
  const mids = new Map();
  const mid = (a, b) => {
    const k = a < b ? a * 1e7 + b : b * 1e7 + a;
    let m = mids.get(k);
    if (m === undefined) {
      m = pos.length / 3;
      pos.push((pos[a * 3] + pos[b * 3]) / 2, 0, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
      mids.set(k, m);
    }
    return m;
  };
  const len2 = (a, b) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
  const out = [];
  const stack = [...tris];
  while (stack.length) {
    const [a, b, c] = stack.pop();
    const ab = len2(a, b), bc = len2(b, c), ca = len2(c, a);
    const m = Math.max(ab, bc, ca);
    if (m <= maxEdge * maxEdge) { out.push(a, b, c); continue; }
    if (m === ab) { const d = mid(a, b); stack.push([a, d, c], [d, b, c]); }
    else if (m === bc) { const d = mid(b, c); stack.push([a, b, d], [a, d, c]); }
    else { const d = mid(c, a); stack.push([a, b, d], [d, b, c]); }
  }
  return out;
}

// A water body as a mesh: a flat body as its OSM shape at its level; a graded one subdivided and draped on its surface
function waterGeometry(body, water) {
  const shape = shapeOf(body.polygon.outer, body.polygon.holes || []);
  if (body.type === 'flat') return flatShapes([shape], body.level + WATER_LIFT);
  const { shape: outer, holes } = shape.extractPoints(1);
  const pts = [...outer, ...holes.flat()];
  const tris = THREE.ShapeUtils.triangulateShape(outer, holes);
  const pos = [];
  for (const p of pts) pos.push(p.x, 0, -p.y);
  const index = subdivide(pos, tris, WATER_EDGE);
  for (let i = 0; i < pos.length; i += 3) {
    // the body's surface; a vertex on its very outline (which the polygon test may leave out) the same way
    const x = pos[i], z = pos[i + 2];
    const g = water.groundAt(x, z), l = water.levelOf(body, x, z);
    pos[i + 1] = (Number.isFinite(l) ? Math.min(l, g) : g) + WATER_LIFT;
  }
  // ShapeUtils winds the (x, -z) shape anticlockwise: reversed, its triangles face up in (x, z)
  for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

// A triangle soup (positions, indices) cut into CHUNK cells by triangle centroid, one geometry per cell
function chunked(positions, indices) {
  const cells = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3, cz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
    const k = `${Math.floor(cx / CHUNK)},${Math.floor(cz / CHUNK)}`;
    if (!cells.has(k)) cells.set(k, { map: new Map(), pos: [], idx: [] });
    const cell = cells.get(k);
    for (const v of [a, b, c]) {
      let w = cell.map.get(v);
      if (w === undefined) {
        w = cell.pos.length / 3;
        cell.pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
        cell.map.set(v, w);
      }
      cell.idx.push(w);
    }
  }
  return [...cells.values()].map(({ pos, idx }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  });
}

// The bridge decks (gf-surface.js) as slabs: a concrete top the width of the road and its sidewalks just under the
// asphalt ribbon, sides 1 m deep and an underside, and a parapet 0.9 m high along each edge. Their railings, as the
// player's colliders (not drawn: the parapets are), keep a car or walker from stepping off the side of a deck over
// the river; they stop 6 m short of each abutment, where the deck meets the approach road.
const DECK_DEPTH = 1.0, PARAPET = 0.9, PARAPET_W = 0.25, RAIL_GAP = 6;
function deckGeometry(surface) {
  const pos = [], idx = [];
  const quad = (a, b, c, d) => {
    const o = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  const colliders = [];
  for (const d of surface.decks) {
    for (const c of d.segments) {
      const n = Math.max(1, Math.ceil(c.len / 4));
      const ux = (c.to[0] - c.from[0]) / c.len, uz = (c.to[1] - c.from[1]) / c.len;
      const half = c.width / 2 + surface.constants.DECK_MARGIN;
      const rx = -uz, rz = ux;
      const at = (k) => {
        const s = (c.len * k) / n, x = c.from[0] + ux * s, z = c.from[1] + uz * s;
        return { x, z, y: Math.max(d.yAt(c.s0 + s), surface.ground(x, z)) + ROAD_LIFT - 0.01 };
      };
      for (let k = 0; k < n; k++) {
        const p = at(k), q = at(k + 1);
        const L = (o, dy = 0, P = p) => [P.x + rx * o, P.y + dy, P.z + rz * o];
        quad(L(-half, 0, p), L(-half, 0, q), L(half, 0, q), L(half, 0, p)); // top
        quad(L(-half, -DECK_DEPTH, p), L(half, -DECK_DEPTH, p), L(half, -DECK_DEPTH, q), L(-half, -DECK_DEPTH, q)); // underside
        for (const side of [-1, 1]) {
          const o = side * half, oi = side * (half - PARAPET_W);
          quad(L(o, -DECK_DEPTH, p), L(o, -DECK_DEPTH, q), L(o, PARAPET, q), L(o, PARAPET, p)); // outer face
          quad(L(oi, 0, p), L(oi, PARAPET, p), L(oi, PARAPET, q), L(oi, 0, q)); // inner face
          quad(L(o, PARAPET, p), L(o, PARAPET, q), L(oi, PARAPET, q), L(oi, PARAPET, p)); // top of the parapet
        }
      }
      // railings: every 4 m piece of each edge more than RAIL_GAP from the chain's ends
      for (let k = 0; k < n; k++) {
        const p = at(k), q = at(k + 1);
        const s0 = c.s0 + (c.len * k) / n, s1 = c.s0 + (c.len * (k + 1)) / n;
        if (s0 < RAIL_GAP || s1 > d.length - RAIL_GAP) continue;
        for (const side of [-1, 1]) {
          const o0 = side * (half - PARAPET_W), o1 = side * half;
          const outer = [
            { x: p.x + rx * o0, z: p.z + rz * o0 }, { x: q.x + rx * o0, z: q.z + rz * o0 },
            { x: q.x + rx * o1, z: q.z + rz * o1 }, { x: p.x + rx * o1, z: p.z + rz * o1 }
          ];
          colliders.push({
            minX: Math.min(...outer.map((v) => v.x)), maxX: Math.max(...outer.map((v) => v.x)),
            minZ: Math.min(...outer.map((v) => v.z)), maxZ: Math.max(...outer.map((v) => v.z)),
            minY: Math.min(p.y, q.y) - DECK_DEPTH, maxY: Math.max(p.y, q.y) + 1.1, polygon: { outer, holes: [] }, deck: d.id
          });
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geometry: g, colliders };
}

// The game view's ground on the terrain: the terrain mesh (gf-terrain-mesh.js; its vertex colours are the old block
// and lot tints), draped road ribbons (gf-drape.js, decks over the bridges), deck slabs and the water bodies
// (gf-water.js). Returns { group, terrain (call terrain.update(camera position) every frame), deckColliders, stats }.
function buildGfTerrainGround(scene, geo, surface, blocks, bridges) {
  const group = new THREE.Group();
  group.name = 'GlensFallsGround';
  const classify = (x, z) => {
    const b = blocks.blockAt(x, z);
    if (!b) return 0;
    return b.lot && polygonIn(b.lot, x, z) ? 2 : 1;
  };
  const terrain = createGfTerrainMesh(surface.terrain, { classify });
  group.add(terrain.group);
  // Draped: the normals follow the slope, turned to face up whichever way the triangles wind
  const add = (g, mat, name) => {
    g.computeVertexNormals();
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) if (n.getY(i) < 0) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const { roadGraph } = geo;
  const service = roadGraph.classes.indexOf('service');
  const bridgeSegs = new Set(bridges.bridges.flatMap((b) => b.segments.map(([l, s]) => `${l}/${s}`)));
  const stats = { roadTriangles: 0, waterTriangles: 0, roadChunks: 0 };
  for (const [name, include, color, layer] of [['ServiceRoads', (c) => c === service, 0x4a4c50, LAYERS.service], ['Roads', (c) => c !== service, 0x34363a, LAYERS.road]]) {
    const { positions, indices } = drapeRoads(roadGraph, include, surface, bridgeSegs);
    const mat = flatMaterial(color, 0.85, layer);
    for (const g of chunked(positions, indices)) {
      add(g, mat, name);
      stats.roadTriangles += g.index.count / 3;
      stats.roadChunks++;
    }
  }
  const waterMat = flatMaterial(0x2b5a7c, 0.25, LAYERS.water);
  for (const body of surface.water.bodies) {
    const g = waterGeometry(body, surface.water);
    stats.waterTriangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    add(g, waterMat, `Water-${body.type}`);
  }
  const decks = deckGeometry(surface);
  const deckMesh = new THREE.Mesh(decks.geometry, new THREE.MeshStandardMaterial({ color: 0x8a8780, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }));
  deckMesh.name = 'BridgeDecks';
  deckMesh.castShadow = deckMesh.receiveShadow = true;
  group.add(deckMesh);
  scene.add(group);
  return { group, terrain, deckColliders: decks.colliders, stats };
}

// Point in a { outer, holes } polygon of { x, z } points
function polygonIn(poly, x, z) {
  const ring = (r) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i].z > z) !== (r[j].z > z) && x < r[i].x + ((r[j].x - r[i].x) * (z - r[i].z)) / (r[j].z - r[i].z)) inside = !inside;
    }
    return inside;
  };
  return ring(poly.outer) && !(poly.holes || []).some(ring);
}

export { unflat, shapeOf, flatShapes, roadRibbonGeometry, buildGfGround, buildGfTerrainGround, ROAD_LIFT, WATER_LIFT };
