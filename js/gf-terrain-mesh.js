import * as THREE from 'three/webgpu';

// The Glens Falls terrain as drawn (CC-005b): a quadtree of square chunks on the 1 m source lattice of js/gf-terrain.js,
// each CELLS x CELLS cells at its level's spacing (1, 2, 4 ... m), chosen by distance from the camera every frame.
// A level-0 chunk's vertices are the lattice nodes and its triangles the query's (diagonal north-west to south-east),
// so near the camera the mesh is the surface things stand on, exactly. Coarser levels take every 2nd, 4th ... node (a
// decimation, no smoothing); their chunks hang skirts down from their edges so the seams between levels never open,
// and draw with a larger depth offset per level (no geometric step at a seam) so the road and water overlays, which
// follow the exact surface, stay on top of them where a decimated chunk bows above it. Chunks are built on
// first use and kept (up to CACHE chunks). Vertex colours carry the old flat layers: the blocks' sidewalk band in
// concrete, their lots darker, open ground green.

const CELLS = 32;
const ROOT_LEVEL = 8; // 32 x 256 m = 8192 m, the whole terrain
const ROOT_MARGIN = 512; // metres the quadtree starts west / north of the lattice (keeps every level on lattice nodes)
const RING_MIN_LEVEL = 3; // outside the lattice the ring is 8 m data: no finer chunks there
const CACHE = 700;
const LEVEL_OFFSET = (l) => ({ factor: 5 + 2 * l, units: 20 + 16 * l }); // polygon offset by level
const COLORS = [new THREE.Color(0x4f5a44), new THREE.Color(0x8f8c83), new THREE.Color(0x6b6a61)]; // ground, sidewalk, lot

// classify(x, z): 0 ground, 1 a block's sidewalk band, 2 a lot
function createGfTerrainMesh(terrain, { classify = () => 0, refine = 2.6 } = {}) {
  const L = terrain.lattice, hull = terrain.hull, ring = terrain.ringBox;
  const OE = L.e0 - ROOT_MARGIN, ON = L.n0 + ROOT_MARGIN;
  const ANCHOR = terrain.ANCHOR;
  const group = new THREE.Group();
  group.name = 'GlensFallsTerrain';
  const materials = Array.from({ length: ROOT_LEVEL + 1 }, (_, l) => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: LEVEL_OFFSET(l).factor, polygonOffsetUnits: LEVEL_OFFSET(l).units
  }));

  // One index buffer for every chunk: the grid's two triangles per cell (up-facing, the query's diagonal), then the
  // skirt quads (edge vertex to the copy below it) round the four edges
  const N = CELLS + 1;
  const index = [];
  for (let b = 0; b < CELLS; b++) {
    for (let a = 0; a < CELLS; a++) {
      const v00 = b * N + a, v10 = v00 + 1, v01 = v00 + N, v11 = v01 + 1;
      index.push(v00, v11, v10, v00, v01, v11);
    }
  }
  const edge = [];
  for (let a = 0; a < CELLS; a++) edge.push([a, a + 1]); // north edge (b = 0)
  for (let b = 0; b < CELLS; b++) edge.push([b * N + CELLS, (b + 1) * N + CELLS]); // east
  for (let a = CELLS; a > 0; a--) edge.push([CELLS * N + a, CELLS * N + a - 1]); // south
  for (let b = CELLS; b > 0; b--) edge.push([b * N, (b - 1) * N]); // west
  const ring0 = edge.map((e) => e[0]);
  const skirtOf = new Map(ring0.map((v, k) => [v, N * N + k]));
  for (const [p, q] of edge) {
    const sp = skirtOf.get(p), sq = skirtOf.get(q);
    index.push(p, sp, q, q, sp, sq);
  }
  const indexArray = Uint16Array.from(index); // each chunk gets its own copy, so disposing one frees nothing shared
  const vertexCount = N * N + ring0.length;

  const inHull = (e, n) => e >= hull.e0 && e <= hull.e1 && n >= hull.n0 && n <= hull.n1;
  const clampRing = (e, n) => [Math.min(ring.e1, Math.max(ring.e0, e)), Math.min(ring.n1, Math.max(ring.n0, n))];
  // NAVD88 at a quadtree vertex: the lattice node itself in the lattice, else the ring / blend surface (clamped to it)
  function navdAt(e, n) {
    if (inHull(e, n)) return terrain.nodeNavd(Math.round(e - L.e0), Math.round(L.n0 - n));
    const [ce, cn] = clampRing(e, n);
    return terrain.sampleUtm(ce, cn).navd;
  }

  const cache = new Map();
  let builds = 0;
  function build(l, kx, ky) {
    const s = 2 ** l, size = CELLS * s;
    const e0 = OE + kx * size, n0 = ON - ky * size;
    const pos = new Float32Array(vertexCount * 3), nor = new Float32Array(vertexCount * 3), col = new Float32Array(vertexCount * 3);
    // heights with a one-vertex margin for the normals
    const M = N + 2;
    const h = new Float64Array(M * M);
    for (let b = -1; b <= N; b++) for (let a = -1; a <= N; a++) h[(b + 1) * M + a + 1] = navdAt(e0 + a * s, n0 - b * s);
    // the local frame's gradient from UTM's (a chunk is small enough for one Jacobian)
    const [cx, cz] = terrain.fromUtm(e0 + size / 2, n0 - size / 2);
    const [ex1, nx1] = terrain.toUtm(cx + 1, cz), [ex0, nx0] = terrain.toUtm(cx - 1, cz);
    const [ez1, nz1] = terrain.toUtm(cx, cz + 1), [ez0, nz0] = terrain.toUtm(cx, cz - 1);
    const dEdx = (ex1 - ex0) / 2, dNdx = (nx1 - nx0) / 2, dEdz = (ez1 - ez0) / 2, dNdz = (nz1 - nz0) / 2;
    let minY = Infinity, maxY = -Infinity;
    for (let b = 0; b < N; b++) {
      for (let a = 0; a < N; a++) {
        const v = b * N + a;
        const [e, n] = clampRing(e0 + a * s, n0 - b * s);
        const [x, z] = terrain.fromUtm(e, n);
        const y = h[(b + 1) * M + a + 1] - ANCHOR;
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        const hE = (h[(b + 1) * M + a + 2] - h[(b + 1) * M + a]) / (2 * s);
        const hN = (h[b * M + a + 1] - h[(b + 2) * M + a + 1]) / (2 * s);
        const gx = hE * dEdx + hN * dNdx, gz = hE * dEdz + hN * dNdz;
        const il = 1 / Math.hypot(gx, 1, gz);
        nor[v * 3] = -gx * il; nor[v * 3 + 1] = il; nor[v * 3 + 2] = -gz * il;
        const c = COLORS[classify(x, z)];
        col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      }
    }
    const depth = 2 + s;
    ring0.forEach((v, k) => {
      const w = N * N + k;
      pos[w * 3] = pos[v * 3]; pos[w * 3 + 1] = pos[v * 3 + 1] - depth; pos[w * 3 + 2] = pos[v * 3 + 2];
      for (let c = 0; c < 3; c++) { nor[w * 3 + c] = nor[v * 3 + c]; col[w * 3 + c] = col[v * 3 + c]; }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setIndex(new THREE.BufferAttribute(indexArray.slice(), 1));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, materials[l]);
    mesh.name = `TerrainChunk-L${l}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData = { level: l, minY: minY - depth, maxY };
    const twin = [...cache.values()].find((e) => e.mesh.userData.level === l);
    if (twin) mesh.userData.sharesPipelineWith = twin.mesh;
    builds++;
    return mesh;
  }

  const selected = [];
  let stamp = 0;
  // Choose and show the chunks for a camera at local (x, y, z)
  function update(camera) {
    const [ce, cn] = terrain.toUtm(camera.x, camera.z);
    const g = terrain.heightAt(camera.x, camera.z);
    const above = Math.max(0, camera.y - (Number.isFinite(g) ? g : 0));
    selected.length = 0;
    stamp++;
    (function visit(l, kx, ky) {
      const size = CELLS * 2 ** l;
      const e0 = OE + kx * size, e1 = e0 + size, n1 = ON - ky * size, n0 = n1 - size;
      if (e1 < ring.e0 || e0 > ring.e1 || n1 < ring.n0 || n0 > ring.n1) return;
      const overlapsHull = !(e1 < hull.e0 || e0 > hull.e1 || n1 < hull.n0 || n0 > hull.n1);
      const minLevel = overlapsHull ? 0 : RING_MIN_LEVEL;
      const dx = Math.max(0, e0 - ce, ce - e1), dn = Math.max(0, n0 - cn, cn - n1);
      const d = Math.hypot(dx, dn, above);
      if (l > minLevel && d < refine * size) {
        for (let k = 0; k < 4; k++) visit(l - 1, kx * 2 + (k & 1), ky * 2 + (k >> 1));
      } else selected.push([l, kx, ky]);
    })(ROOT_LEVEL, 0, 0);
    for (const [l, kx, ky] of selected) {
      const key = `${l}/${kx}/${ky}`;
      let entry = cache.get(key);
      if (!entry) {
        entry = { mesh: build(l, kx, ky), used: 0 };
        cache.set(key, entry);
        group.add(entry.mesh);
      } else {
        // most recently used last (Map order)
        cache.delete(key);
        cache.set(key, entry);
      }
      entry.used = stamp;
    }
    for (const entry of cache.values()) entry.mesh.visible = entry.used === stamp;
    if (cache.size > CACHE) {
      for (const [key, entry] of cache) {
        if (cache.size <= CACHE) break;
        if (entry.used === stamp) continue;
        group.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        cache.delete(key);
      }
    }
    return selected.length;
  }

  return {
    group, materials, update,
    stats: () => ({ chunks: selected.length, cached: cache.size, builds, triangles: selected.length * index.length / 3 })
  };
}

export { createGfTerrainMesh, CELLS, LEVEL_OFFSET };
