import * as THREE from 'three/webgpu';
import { createTerrainLod, CELLS, N, VERTICES, SURFACE, REFINE, ROOT_LEVEL } from './gf-terrain-lod.js';

// The Glens Falls terrain as drawn (CC-005b): the levels of detail of gf-terrain-lod.js (which chunks, their heights and
// their stitched seams; shared with the Node audit and tests), as three.js meshes. A level-0 chunk is the surface things
// stand on, exactly; coarser chunks are chosen only where their error is below about a pixel at their distance, and
// draw with a larger depth offset per level, so the road and water overlays, which follow the exact surface, stay on top
// where a decimated chunk bows above it. (No skirts: a vertical skirt facing the camera takes almost none of a depth
// offset's slope term, so it showed through the water in front of it.) The chunks a level selects are merged into one
// mesh (rebuilt only when that level's selection or stitching changes): about one draw call per level. Chunk data are
// built on first use and kept (up to CACHE chunks). Vertex colours carry the old flat layers, CC-005e's palette: open
// ground green; a block's sidewalk band concrete downtown, a lawn-and-walk grey-green elsewhere (gf-sidewalk-meshes.js
// draws the curbs, lawns and walks over it near the camera); its lot a yard's green, downtown paving.

const CACHE = 450;
const LEVEL_OFFSET = (l) => ({ factor: 5 + 2 * l, units: 20 + 16 * l }); // polygon offset by level
// ground, downtown band, residential lot, downtown lot, residential band
const COLORS = [0x4f5a44, 0x8f8c83, 0x56663f, 0x6b665d, 0x6c7361].map((c) => new THREE.Color(c));

// classify(x, z): an index into COLORS. errors: gf-terrain-lod-errors.js (per-chunk errors)
function createGfTerrainMesh(terrain, { classify = () => 0, refine = REFINE, errors = null } = {}) {
  const lod = createTerrainLod(terrain, { refine, errors });
  const ANCHOR = terrain.ANCHOR;
  const group = new THREE.Group();
  group.name = 'GlensFallsTerrain';
  const material = (o) => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: o.factor, polygonOffsetUnits: o.units
  });
  const levels = Array.from({ length: ROOT_LEVEL + 1 }, (_, l) => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material(LEVEL_OFFSET(l)));
    mesh.name = `TerrainLevel-${l}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    group.add(mesh);
    return { mesh, keys: '' };
  });

  const cache = new Map(); // key -> { h, pos, nor, col, used }
  let builds = 0;
  function build(l, kx, ky) {
    const s = 2 ** l;
    const [e0, n0, size] = lod.origin(l, kx, ky);
    const h = lod.heights(l, kx, ky);
    const pos = new Float32Array(VERTICES * 3), nor = new Float32Array(VERTICES * 3), col = new Float32Array(VERTICES * 3);
    // heights one vertex beyond the chunk, for the normals at its edges
    const at = (a, b) => (a >= 0 && a < N && b >= 0 && b < N ? h[b * N + a] : lod.navdAt(e0 + a * s, n0 - b * s));
    // the local frame's gradient from UTM's (a chunk is small enough for one Jacobian)
    const [cx, cz] = terrain.fromUtm(e0 + size / 2, n0 - size / 2);
    const [ex1, nx1] = terrain.toUtm(cx + 1, cz), [ex0, nx0] = terrain.toUtm(cx - 1, cz);
    const [ez1, nz1] = terrain.toUtm(cx, cz + 1), [ez0, nz0] = terrain.toUtm(cx, cz - 1);
    const dEdx = (ex1 - ex0) / 2, dNdx = (nx1 - nx0) / 2, dEdz = (ez1 - ez0) / 2, dNdz = (nz1 - nz0) / 2;
    for (let b = 0; b < N; b++) {
      for (let a = 0; a < N; a++) {
        const v = b * N + a;
        const [e, n] = lod.clampRing(e0 + a * s, n0 - b * s);
        const [x, z] = terrain.fromUtm(e, n);
        pos[v * 3] = x; pos[v * 3 + 1] = h[v] - ANCHOR; pos[v * 3 + 2] = z;
        const hE = (at(a + 1, b) - at(a - 1, b)) / (2 * s);
        const hN = (at(a, b - 1) - at(a, b + 1)) / (2 * s);
        const gx = hE * dEdx + hN * dNdx, gz = hE * dEdz + hN * dNdz;
        const il = 1 / Math.hypot(gx, 1, gz);
        nor[v * 3] = -gx * il; nor[v * 3 + 1] = il; nor[v * 3 + 2] = -gz * il;
        const c = COLORS[classify(x, z)];
        col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      }
    }
    builds++;
    return { h, pos, nor, col, used: 0 };
  }

  // One level's selected chunks as one geometry, each stitched onto its coarser neighbours
  function merge(chunks) {
    const n = chunks.length;
    const pos = new Float32Array(n * VERTICES * 3), nor = new Float32Array(n * VERTICES * 3), col = new Float32Array(n * VERTICES * 3);
    const index = new Uint32Array(n * SURFACE.length);
    chunks.forEach((c, k) => {
      pos.set(c.pos, k * VERTICES * 3); nor.set(c.nor, k * VERTICES * 3); col.set(c.col, k * VERTICES * 3);
      if (c.stitch) {
        const h = lod.stitchInto(Float64Array.from(c.h), c.l, c.kx, c.ky, c.stitch);
        for (let v = 0; v < VERTICES; v++) pos[(k * VERTICES + v) * 3 + 1] = h[v] - ANCHOR;
      }
      const o = k * VERTICES;
      for (let i = 0; i < SURFACE.length; i++) index[k * SURFACE.length + i] = SURFACE[i] + o;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
    return g;
  }

  let selected = [];
  let stamp = 0;
  // Choose and draw the chunks for a camera at local (x, y, z)
  function update(camera) {
    const [ce, cn] = terrain.toUtm(camera.x, camera.z);
    const g = terrain.heightAt(camera.x, camera.z);
    const above = Math.max(0, camera.y - (Number.isFinite(g) ? g : 0));
    stamp++;
    selected = lod.select(ce, cn, above).chunks;
    const byLevel = levels.map(() => []);
    for (const c of selected) byLevel[c.l].push(c);
    byLevel.forEach((items, l) => {
      const lv = levels[l];
      const id = items.map((it) => it.key + (it.stitch ? ':' + it.stitch.join(',') : '')).join(' ');
      if (id === lv.keys) {
        for (const it of items) cache.get(it.key).used = stamp;
        return;
      }
      const chunks = items.map(({ key, kx, ky, stitch }) => {
        let c = cache.get(key);
        if (!c) {
          c = build(l, kx, ky);
          cache.set(key, c);
        }
        c.used = stamp;
        return { ...c, l, kx, ky, stitch };
      });
      lv.mesh.geometry.dispose();
      lv.mesh.geometry = chunks.length ? merge(chunks) : new THREE.BufferGeometry();
      lv.mesh.visible = chunks.length > 0;
      lv.keys = id;
    });
    if (cache.size > CACHE) {
      for (const [key, c] of cache) {
        if (cache.size <= CACHE) break;
        if (c.used !== stamp) cache.delete(key);
      }
    }
    return selected.length;
  }

  return {
    group, update, levels, lod,
    stats: () => ({ chunks: selected.length, cached: cache.size, builds, drawCalls: levels.filter((lv) => lv.mesh.visible).length,
      triangles: selected.length * SURFACE.length / 3 })
  };
}

export { createGfTerrainMesh, CELLS, LEVEL_OFFSET, REFINE };
