import * as THREE from 'three/webgpu';
import { drapeRoads, ROAD_LIFT } from './gf-drape.js';
import { TRAIL_LIFT } from './gf-trail-network.js';

// CC-005c: the accepted trails (gf-trails.js) drawn. Paths are ribbons draped on the terrain exactly as the roads are
// (gf-drape.js: the same breakpoints, ROAD_LIFT above the ground, which is where walkers stand: gf-trail-network.js
// TRAIL_LIFT), their colour from the mapped surface. Footbridges are plank decks on the walkers' deck surface
// (gf-surface.js footDecks: straight between the ground at their abutments, never under it) with a post-and-rail
// fence each side; the rails are the player's colliders, stopping RAIL_GAP short of each end so the bridge is walked
// onto from the path. The park drives are not drawn again: they are the game's service roads already (gf-ground.js).

const SURFACES = {
  paved: { color: 0x5b5d60, kinds: ['asphalt', 'paved', 'concrete'] },
  gravel: { color: 0x9a9283, kinds: ['gravel', 'fine_gravel', 'compacted', 'pebblestone', 'unpaved'] },
  dirt: { color: 0x7a6650, kinds: [] } // ground, dirt, earth, unmapped: a woods path
};
const surfaceOf = (s) => Object.keys(SURFACES).find((k) => SURFACES[k].kinds.includes(s)) || 'dirt';
const PATH_LAYER = 2.5; // polygon offset: under the service roads (2) a path meets, over water (3) and the ground (5)
const DECK_DEPTH = 0.3, POST = 0.09, RAIL_H = 1.0, RAIL_GAP = 1.2;
const WOOD = 0x8a6a48;

function buildTrailMeshes(scene, trails, surface) {
  if (TRAIL_LIFT !== ROAD_LIFT) throw new Error('trail walkers must stand on the drawn path (TRAIL_LIFT = ROAD_LIFT)');
  const group = new THREE.Group();
  group.name = 'Trails';
  const stats = { pathTriangles: 0, deckTriangles: 0, bySurface: {}, rails: 0 };

  // 1. Paths: one draped mesh per surface colour (gf-drape.js wants a road graph: [a, b, name, class, oneway, lanes,
  // width, inner points])
  const graph = { nodes: trails.nodes, links: [] };
  const classOf = [];
  for (const e of trails.edges) {
    if (e.kind !== 'path') continue;
    const cls = Object.keys(SURFACES).indexOf(surfaceOf(e.surface));
    graph.links.push([e.a, e.b, 0, cls, 0, 1, e.widthM, e.pts.slice(2, -2)]);
    classOf.push(cls);
  }
  Object.keys(SURFACES).forEach((name, cls) => {
    if (!classOf.includes(cls)) return;
    const { positions, indices } = drapeRoads(graph, (c) => c === cls, surface);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: SURFACES[name].color, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: PATH_LAYER, polygonOffsetUnits: 4 * PATH_LAYER
    }));
    mesh.name = `TrailPaths-${name}`;
    mesh.receiveShadow = true;
    group.add(mesh);
    stats.pathTriangles += indices.length / 3;
    stats.bySurface[name] = (stats.bySurface[name] || 0) + indices.length / 3;
  });

  // 2. Footbridges: plank slab, posts and rails
  const pos = [], idx = [];
  const quad = (a, b, c, d) => { const o = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
  const box = (cx, cy, cz, hx, hy, hz, yaw) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (x, y, z) => [cx + x * c + z * s, cy + y, cz - x * s + z * c];
    const v = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(-hx, hy, -hz), P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz)];
    for (const [a, b, cc, d] of [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]]) quad(v[a], v[b], v[cc], v[d]);
  };
  const colliders = [];
  for (const d of surface.footDecks) {
    for (const c of d.segments) {
      const ux = (c.to[0] - c.from[0]) / c.len, uz = (c.to[1] - c.from[1]) / c.len, rx = -uz, rz = ux, half = c.width / 2;
      const n = Math.max(1, Math.ceil(c.len / 1.0));
      const at = (k, o) => {
        const s = (c.len * k) / n, cx = c.from[0] + ux * s, cz = c.from[1] + uz * s, x = cx + rx * o, z = cz + rz * o;
        return [x, d.heightAt(c.s0 + s, x, z, cx, cz) + TRAIL_LIFT, z];
      };
      for (let k = 0; k < n; k++) {
        const L = (kk, o, dy = 0) => { const p = at(kk, o); return [p[0], p[1] + dy, p[2]]; };
        quad(L(k, -half), L(k + 1, -half), L(k + 1, half), L(k, half)); // planks
        quad(L(k, -half, -DECK_DEPTH), L(k, half, -DECK_DEPTH), L(k + 1, half, -DECK_DEPTH), L(k + 1, -half, -DECK_DEPTH));
        for (const side of [-1, 1]) {
          const o = side * half;
          quad(L(k, o, -DECK_DEPTH), L(k + 1, o, -DECK_DEPTH), L(k + 1, o), L(k, o));
          // the top rail between posts, RAIL_GAP clear of the deck's ends
          const s0 = c.s0 + (c.len * k) / n, s1 = c.s0 + (c.len * (k + 1)) / n;
          if (s0 < RAIL_GAP || s1 > d.length - RAIL_GAP) continue;
          const oi = side * (half - POST);
          quad(L(k, oi, RAIL_H), L(k + 1, oi, RAIL_H), L(k + 1, o, RAIL_H), L(k, o, RAIL_H));
          quad(L(k, o, RAIL_H - 0.08), L(k + 1, o, RAIL_H - 0.08), L(k + 1, o, RAIL_H), L(k, o, RAIL_H));
          quad(L(k + 1, oi, RAIL_H - 0.08), L(k, oi, RAIL_H - 0.08), L(k, oi, RAIL_H), L(k + 1, oi, RAIL_H));
          const p = at(k, (half - POST / 2) * side);
          box(p[0], p[1] + RAIL_H / 2, p[2], POST / 2, RAIL_H / 2, POST / 2, Math.atan2(ux, uz));
          const a = at(k, oi), b = at(k + 1, oi), a2 = at(k, o), b2 = at(k + 1, o);
          const outer = [{ x: a[0], z: a[2] }, { x: b[0], z: b[2] }, { x: b2[0], z: b2[2] }, { x: a2[0], z: a2[2] }];
          colliders.push({ minX: Math.min(...outer.map((q) => q.x)), maxX: Math.max(...outer.map((q) => q.x)), minZ: Math.min(...outer.map((q) => q.z)), maxZ: Math.max(...outer.map((q) => q.z)),
            minY: Math.min(a[1], b[1]) - DECK_DEPTH, maxY: Math.max(a[1], b[1]) + RAIL_H + 0.1, polygon: { outer, holes: [] }, footDeck: d.id });
          stats.rails++;
        }
      }
    }
  }
  if (idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }));
    mesh.name = 'Footbridges';
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    stats.deckTriangles = idx.length / 3;
  }
  scene.add(group);
  return { group, colliders, stats };
}

export { buildTrailMeshes, surfaceOf };
