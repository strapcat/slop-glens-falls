const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// createBuildingFootprints's base option (the height its walls stand on): New York's 0.22 m sidewalk by default,
// 0 on Glens Falls's flat ground. Same three.js stubs as building-footprints.test.cjs.

class Attribute {
  constructor(array, itemSize) { this.array = Float32Array.from(array); this.itemSize = itemSize; }
}
class Geometry {
  constructor() { this.attributes = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  setIndex(value) { this.index = value; }
  computeBoundingSphere() {}
}
class Mesh {
  constructor(geometry, material) { Object.assign(this, { geometry, material, userData: {} }); }
}
const signedArea = points => points.reduce((sum, p, i) => {
  const next = points[(i + 1) % points.length];
  return sum + p.x * next.y - next.x * p.y;
}, 0) / 2;
const THREE = {
  Vector2: class {
    constructor(x, y) { Object.assign(this, { x, y }); }
    equals(p) { return this.x === p.x && this.y === p.y; }
  },
  Group: class { constructor() { this.children = []; } add(child) { this.children.push(child); } },
  BufferGeometry: Geometry, Float32BufferAttribute: Attribute, Mesh,
  ShapeUtils: {
    isClockWise: points => signedArea(points) < 0,
    // Fixtures are convex
    triangulateShape: (outer, holes) => (holes.length ? [] : Array.from({ length: outer.length - 2 }, (_, i) => [0, i + 2, i + 1]))
  }
};
const collision = loadModule(readFileSync(join(__dirname, '../js/building-collision.js'), 'utf8'));
const { createBuildingFootprints } = loadModule(readFileSync(join(__dirname, '../js/building-footprints.js'), 'utf8'), {
  imports: { 'three/webgpu': THREE, './tsl-materials.js': { WALL_KINDS: { shop: 0, front: 1, rear: 2, lotLine: 3 } },
    './building-collision.js': collision }
});

const p = (x, z) => ({ x, z });
const box = (x0, z0, x1, z1) => [p(x0, z0), p(x1, z0), p(x1, z1), p(x0, z1)];
const record = (outer, height, extra = {}) => {
  const xs = outer.map(q => q.x), zs = outer.map(q => q.z);
  return { polygons: [{ outer, holes: [] }], height, seed: 7, tone: 0.3,
    cx: (Math.min(...xs) + Math.max(...xs)) / 2, cz: (Math.min(...zs) + Math.max(...zs)) / 2, ...extra };
};
// Two buildings sharing a wall, a third across a 1 km cell boundary, one with storefronts, one angled
const records = () => [
  record(box(0, 0, 10, 12), 18, { storefronts: true }),
  record(box(10, 0, 22, 12), 9),
  record([p(1010, 5), p(1026, 2), p(1029, 15), p(1013, 18)], 30),
  record(box(40, 40, 52, 47), 6.6)
];
const neighbours = list => b => list
  .filter(n => n !== b)
  .map(n => ({ polygons: n.polygons, height: n.height + 0.22, x0: Math.min(...n.polygons[0].outer.map(q => q.x)),
    x1: Math.max(...n.polygons[0].outer.map(q => q.x)), z0: Math.min(...n.polygons[0].outer.map(q => q.z)),
    z1: Math.max(...n.polygons[0].outer.map(q => q.z)) }));
const arrays = group => group.children.map(m => ['position', 'normal', 'box', 'facadeWall']
  .map(a => Buffer.from(m.geometry.attributes[a].array.buffer)).concat(Buffer.from(JSON.stringify(m.geometry.index))));

test('no options builds exactly what { base: 0.22 } builds (New York calls it with three arguments)', () => {
  const list = records();
  const plain = arrays(createBuildingFootprints({}, list, neighbours(list)));
  const explicit = arrays(createBuildingFootprints({}, list, neighbours(list), { base: 0.22 }));
  assert.equal(plain.length, 2, 'two 1 km cells');
  plain.forEach((mesh, i) => mesh.forEach((buf, k) => assert.ok(buf.equals(explicit[i][k]), `mesh ${i} attribute ${k}`)));
  // and the walls stand on the sidewalk
  const ys = new Set(createBuildingFootprints({}, list).children.flatMap(m => [...m.geometry.attributes.position.array].filter((_, i) => i % 3 === 1)));
  assert.ok(ys.has(Math.fround(0.22)));
});

test('{ base: 0 }: walls from the ground to the height, roofs at the height', () => {
  const list = records();
  const group = createBuildingFootprints({}, list, undefined, { base: 0 });
  const heights = new Set(list.map(r => Math.fround(r.height)));
  let walls = 0, roofs = 0;
  for (const mesh of group.children) {
    const pos = mesh.geometry.attributes.position.array, normal = mesh.geometry.attributes.normal.array;
    for (let v = 0; v < pos.length / 3; v++) {
      const y = pos[v * 3 + 1];
      if (normal[v * 3 + 1] === 1) {
        assert.ok(heights.has(y), `roof vertex at ${y}`);
        roofs++;
      } else {
        // wall quads: two vertices at the foot, two at the top
        assert.ok(y === 0 || heights.has(y), `wall vertex at ${y}`);
        walls++;
      }
    }
  }
  assert.equal(walls, 4 * 4 * 4, 'four walls of four vertices per building');
  assert.equal(roofs, 4 * 4);
  const feet = group.children.flatMap(m => [...m.geometry.attributes.position.array].filter((y, i) => i % 3 === 1 && y === 0));
  assert.equal(feet.length, 4 * 4 * 2);
});
