import * as THREE from 'three/webgpu';

// Flat Glens Falls ground from GF_GEO (js/gf-geodata.js): road ribbons at their curb widths, water, block tint and the
// ground under them. The ribbon and shape builders are shared with the geodata debug view (gf-debug.js); buildGfGround()
// lays the game view's ground (gf-main.js) at y = 0, the height the cars drive at, with the road markings
// (road-paint.js) just above.

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
const LAYERS = { road: 1, service: 2, water: 3, block: 4, ground: 5 };
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

// The ground plane over the bbox (padded), water, block tint (curb islands, flat) and road ribbons of every class:
// service roads (drawn, not driven, see gf-roadgraph.js DRIVE_CLASSES) a shade lighter
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
    add(flatShapes(geo.blocks.map((b) => shapeOf(b.curb, b.curbHoles)), -0.03), flatMaterial(0x77766d, 0.9, LAYERS.block), 'BlockTint');
  }
  if (water.length) add(flatShapes(water.map((w) => shapeOf(w.outer, w.holes)), -0.02), flatMaterial(0x2b5a7c, 0.25, LAYERS.water), 'Water');
  const service = roadGraph.classes.indexOf('service');
  add(roadRibbonGeometry(roadGraph, (c) => c === service, 0), flatMaterial(0x4a4c50, 0.85, LAYERS.service), 'ServiceRoads');
  add(roadRibbonGeometry(roadGraph, (c) => c !== service, 0), flatMaterial(0x34363a, 0.85, LAYERS.road), 'Roads');

  scene.add(group);
  return { group, meshes };
}

export { unflat, shapeOf, flatShapes, roadRibbonGeometry, buildGfGround };
