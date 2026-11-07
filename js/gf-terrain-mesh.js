import * as THREE from 'three/webgpu';

// The Glens Falls terrain as drawn (CC-005b): a quadtree of square chunks on the 1 m source lattice of js/gf-terrain.js,
// each CELLS x CELLS cells at its level's spacing (1, 2, 4 ... m), chosen by distance from the camera. A level-0 chunk's
// vertices are the lattice nodes and its triangles the query's (diagonal north-west to south-east), so near the camera
// the mesh is the surface things stand on, exactly. Coarser levels take every 2nd, 4th ... node (a decimation, no
// smoothing) and draw with a larger depth offset per level, so the road and water overlays, which follow the exact
// surface, stay on top of them where a decimated chunk bows above it. Where a chunk borders a coarser one, its border
// vertices are lowered or raised onto that neighbour's edge (stitched), so no crack opens at the seam. Every chunk
// hangs skirts down from its edges so the seams between levels never open; the skirts draw with a depth offset beyond
// every level's, so they fill a crack and never show in front of a neighbour. A skirt quad is drawn in both windings,
// one-sided, with its edge vertex's normal and colour: whichever face shows shades as the surface beside it (a
// double-sided face seen from behind has its normal flipped, which drew the filled cracks as dark dashes). The chunks a level selects are merged
// into one mesh (rebuilt only when that level's selection changes): about one draw call per level. Chunk data are
// built on first use and kept (up to CACHE chunks). Vertex colours carry the old flat layers: the blocks' sidewalk band
// in concrete, their lots darker, open ground green.

const CELLS = 32;
const ROOT_LEVEL = 8; // 32 x 256 m = 8192 m, the whole terrain
const ROOT_MARGIN = 512; // metres the quadtree starts west / north of the lattice (keeps every level on lattice nodes)
const RING_MIN_LEVEL = 3; // outside the lattice the ring is 8 m data: no finer chunks there
const REFINE = 1.2; // a chunk splits while the camera is nearer than REFINE x its size (level 0 within ~77 m)
const CACHE = 450;
const LEVEL_OFFSET = (l) => ({ factor: 5 + 2 * l, units: 20 + 16 * l }); // polygon offset by level
const SKIRT_OFFSET = { factor: 5 + 2 * (ROOT_LEVEL + 2), units: 20 + 16 * (ROOT_LEVEL + 2) };
const COLORS = [new THREE.Color(0x4f5a44), new THREE.Color(0x8f8c83), new THREE.Color(0x6b6a61)]; // ground, sidewalk, lot

// classify(x, z): 0 ground, 1 a block's sidewalk band, 2 a lot
function createGfTerrainMesh(terrain, { classify = () => 0, refine = REFINE } = {}) {
  const L = terrain.lattice, hull = terrain.hull, ring = terrain.ringBox;
  const OE = L.e0 - ROOT_MARGIN, ON = L.n0 + ROOT_MARGIN;
  const ANCHOR = terrain.ANCHOR;
  const group = new THREE.Group();
  group.name = 'GlensFallsTerrain';
  const material = (o, side = THREE.DoubleSide) => new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0, side, polygonOffset: true, polygonOffsetFactor: o.factor, polygonOffsetUnits: o.units
  });
  const skirtMaterial = material(SKIRT_OFFSET, THREE.FrontSide);
  const levels = Array.from({ length: ROOT_LEVEL + 1 }, (_, l) => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [material(LEVEL_OFFSET(l)), skirtMaterial]);
    mesh.name = `TerrainLevel-${l}`;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    group.add(mesh);
    return { mesh, keys: '' };
  });

  // A chunk's triangles: the grid's two per cell (up-facing, the query's diagonal), then its skirt quads (edge vertex to
  // the copy below it, both windings) round the four edges
  const N = CELLS + 1;
  const surface = [];
  for (let b = 0; b < CELLS; b++) {
    for (let a = 0; a < CELLS; a++) {
      const v00 = b * N + a, v10 = v00 + 1, v01 = v00 + N, v11 = v01 + 1;
      surface.push(v00, v11, v10, v00, v01, v11);
    }
  }
  const edge = [];
  for (let a = 0; a < CELLS; a++) edge.push([a, a + 1]); // north edge (b = 0)
  for (let b = 0; b < CELLS; b++) edge.push([b * N + CELLS, (b + 1) * N + CELLS]); // east
  for (let a = CELLS; a > 0; a--) edge.push([CELLS * N + a, CELLS * N + a - 1]); // south
  for (let b = CELLS; b > 0; b--) edge.push([b * N, (b - 1) * N]); // west
  const ring0 = edge.map((e) => e[0]);
  const skirtOf = new Map(ring0.map((v, k) => [v, N * N + k]));
  const skirt = [];
  for (const [p, q] of edge) {
    const sp = skirtOf.get(p), sq = skirtOf.get(q);
    skirt.push(p, sp, q, q, sp, sq, p, q, sp, q, sq, sp);
  }
  const vertexCount = N * N + ring0.length;

  const inHull = (e, n) => e >= hull.e0 && e <= hull.e1 && n >= hull.n0 && n <= hull.n1;
  const clampRing = (e, n) => [Math.min(ring.e1, Math.max(ring.e0, e)), Math.min(ring.n1, Math.max(ring.n0, n))];
  // NAVD88 at a quadtree vertex: the lattice node itself in the lattice, else the ring / blend surface (clamped to it)
  function navdAt(e, n) {
    if (inHull(e, n)) return terrain.nodeNavd(Math.round(e - L.e0), Math.round(L.n0 - n));
    const [ce, cn] = clampRing(e, n);
    return terrain.sampleUtm(ce, cn).navd;
  }

  const cache = new Map(); // key -> { pos, nor, col, used }
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
    for (let b = 0; b < N; b++) {
      for (let a = 0; a < N; a++) {
        const v = b * N + a;
        const [e, n] = clampRing(e0 + a * s, n0 - b * s);
        const [x, z] = terrain.fromUtm(e, n);
        pos[v * 3] = x; pos[v * 3 + 1] = h[(b + 1) * M + a + 1] - ANCHOR; pos[v * 3 + 2] = z;
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
    builds++;
    return { pos, nor, col, used: 0 };
  }

  // The four edges of a chunk as [first vertex, vertex step, UTM start, UTM step per vertex (de, dn), outward (de, dn)]
  const EDGES = [
    [0, 1, (e0, n0) => [e0, n0], [1, 0], [0, 1]], // north
    [CELLS, N, (e0, n0, size) => [e0 + size, n0], [0, -1], [1, 0]], // east
    [CELLS * N, 1, (e0, n0, size) => [e0, n0 - size], [1, 0], [0, -1]], // south
    [0, N, (e0, n0) => [e0, n0], [0, -1], [-1, 0]] // west
  ];
  // The level of the selected chunk just outside each edge of chunk (l, kx, ky) when it is coarser, else -1
  function coarserNeighbours(l, kx, ky, chosen) {
    const size = CELLS * 2 ** l, e0 = OE + kx * size, n0 = ON - ky * size;
    return EDGES.map(([, , start, step, out]) => {
      const [se, sn] = start(e0, n0, size);
      const e = se + step[0] * size / 2 + out[0] * 0.5, n = sn + step[1] * size / 2 + out[1] * 0.5;
      for (let L = l + 1; L <= ROOT_LEVEL; L++) {
        const sz = CELLS * 2 ** L;
        if (chosen.has(`${L}/${Math.floor((e - OE) / sz)}/${Math.floor((ON - n) / sz)}`)) return L;
      }
      return -1;
    });
  }
  // Heights of chunk (l, kx, ky)'s edge vertices on the edges of its coarser neighbours (levels in `stitch`): linear
  // between that neighbour's own edge vertices, as its triangles draw it
  function stitchInto(pos, base, l, kx, ky, stitch) {
    const s = 2 ** l, size = CELLS * s, e0 = OE + kx * size, n0 = ON - ky * size;
    stitch.forEach((L, k) => {
      if (L < 0) return;
      const [v0, dv, start, step] = EDGES[k];
      const S = 2 ** L;
      const [se, sn] = start(e0, n0, size);
      for (let i = 0; i <= CELLS; i++) {
        const e = se + step[0] * i * s, n = sn + step[1] * i * s;
        // position along the edge in the neighbour's spacing (its vertices are every S m on the root grid)
        const u = step[0] ? (e - OE) / S : (ON - n) / S;
        const u0 = Math.floor(u + 1e-9), f = u - u0;
        if (f < 1e-9) continue; // a vertex the neighbour shares
        const at = (uu) => step[0] ? navdAt(OE + uu * S, n) : navdAt(e, ON - uu * S);
        const y = at(u0) * (1 - f) + at(u0 + 1) * f - ANCHOR;
        pos[(base + v0 + i * dv) * 3 + 1] = y;
      }
    });
  }

  // One level's selected chunks as one geometry: their surfaces (group 0), then their skirts (group 1)
  function merge(chunks) {
    const n = chunks.length;
    const pos = new Float32Array(n * vertexCount * 3), nor = new Float32Array(n * vertexCount * 3), col = new Float32Array(n * vertexCount * 3);
    const index = new Uint32Array(n * (surface.length + skirt.length));
    chunks.forEach((c, k) => {
      pos.set(c.pos, k * vertexCount * 3); nor.set(c.nor, k * vertexCount * 3); col.set(c.col, k * vertexCount * 3);
      if (c.stitch) stitchInto(pos, k * vertexCount, c.l, c.kx, c.ky, c.stitch);
      const o = k * vertexCount;
      for (let i = 0; i < surface.length; i++) index[k * surface.length + i] = surface[i] + o;
      for (let i = 0; i < skirt.length; i++) index[n * surface.length + k * skirt.length + i] = skirt[i] + o;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.addGroup(0, n * surface.length, 0);
    g.addGroup(n * surface.length, n * skirt.length, 1);
    g.computeBoundingSphere();
    return g;
  }

  const selected = [];
  let stamp = 0;
  // Choose and draw the chunks for a camera at local (x, y, z)
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
    const chosen = new Set(selected.map(([l, kx, ky]) => `${l}/${kx}/${ky}`));
    const byLevel = levels.map(() => []);
    for (const [l, kx, ky] of selected) {
      const stitch = coarserNeighbours(l, kx, ky, chosen);
      byLevel[l].push({ key: `${l}/${kx}/${ky}`, l, kx, ky, stitch: stitch.some((L) => L >= 0) ? stitch : null });
    }
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
        return { pos: c.pos, nor: c.nor, col: c.col, l, kx, ky, stitch };
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
    group, update, levels,
    stats: () => ({ chunks: selected.length, cached: cache.size, builds, drawCalls: levels.filter((lv) => lv.mesh.visible).length * 2,
      triangles: selected.length * (surface.length + skirt.length) / 3 })
  };
}

export { createGfTerrainMesh, CELLS, LEVEL_OFFSET, REFINE };
