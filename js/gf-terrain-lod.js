// The Glens Falls terrain's levels of detail (CC-005b), without three.js, so the game (gf-terrain-mesh.js) and the Node
// audit (tools/gf/audit-gf-terrain-mesh.mjs) and tests draw exactly the same triangles.
//
// A quadtree of square chunks on the 1 m source lattice of js/gf-terrain.js, each CELLS x CELLS cells at its level's
// spacing (1, 2, 4 ... m). A level-0 chunk's vertices are the lattice nodes and its triangles the query's (diagonal
// north-west to south-east), so it is the surface things stand on, exactly. Coarser levels take every 2nd, 4th ... node
// (a decimation, no smoothing). A chunk splits while the camera is nearer than REFINE x its size, or while its drawn
// surface's largest departure from the query (its error, gf-terrain-lod-errors.js, exact at every lattice node) would
// show as more than SCREEN_TOL of the distance to it (about a pixel), so a wall, cliff or bank keeps its fine levels
// where a decimation would draw it metres off. Where a chunk borders a coarser one, its border vertices are moved onto
// that neighbour's edge as the neighbour draws it (stitched), so no crack opens at the seam.

const CELLS = 32;
const ROOT_LEVEL = 8; // 32 x 256 m = 8192 m, the whole terrain
const ROOT_MARGIN = 512; // metres the quadtree starts west / north of the lattice (keeps every level on lattice nodes)
const RING_MIN_LEVEL = 3; // outside the lattice the ring is 8 m data: no finer chunks there
const REFINE = 1.2; // a chunk splits while the camera is nearer than REFINE x its size (level 0 within ~77 m)
const SCREEN_TOL = 0.0012; // its error over its distance: ~1 pixel at 900 pixels and a 60 degree field of view
const N = CELLS + 1;
const VERTICES = N * N;

// A chunk's triangles as vertex indices: the grid's two per cell (up-facing, the query's diagonal)
const SURFACE = (() => {
  const out = new Uint32Array(CELLS * CELLS * 6);
  let k = 0;
  for (let b = 0; b < CELLS; b++) {
    for (let a = 0; a < CELLS; a++) {
      const v00 = b * N + a, v10 = v00 + 1, v01 = v00 + N, v11 = v01 + 1;
      out[k++] = v00; out[k++] = v11; out[k++] = v10; out[k++] = v00; out[k++] = v01; out[k++] = v11;
    }
  }
  return out;
})();

// terrain: js/gf-terrain.js. errors: per level 1..ROOT_LEVEL, a grid of (2^(ROOT_LEVEL - l))^2 chunk errors in metres
// (gf-terrain-lod-errors.js), or null (distance only)
function createTerrainLod(terrain, { refine = REFINE, screenTol = SCREEN_TOL, errors = null } = {}) {
  const L = terrain.lattice, hull = terrain.hull, ring = terrain.ringBox;
  const OE = L.e0 - ROOT_MARGIN, ON = L.n0 + ROOT_MARGIN;
  const inHull = (e, n) => e >= hull.e0 && e <= hull.e1 && n >= hull.n0 && n <= hull.n1;
  const clampRing = (e, n) => [Math.min(ring.e1, Math.max(ring.e0, e)), Math.min(ring.n1, Math.max(ring.n0, n))];
  // NAVD88 at a quadtree vertex: the lattice node itself in the lattice, else the ring / blend surface (clamped to it)
  function navdAt(e, n) {
    if (inHull(e, n)) return terrain.nodeNavd(Math.round(e - L.e0), Math.round(L.n0 - n));
    const [ce, cn] = clampRing(e, n);
    return terrain.sampleUtm(ce, cn).navd;
  }
  const origin = (l, kx, ky) => {
    const size = CELLS * 2 ** l;
    return [OE + kx * size, ON - ky * size, size];
  };
  const errorOf = (l, kx, ky) => {
    if (!errors || l === 0) return 0;
    const across = 2 ** (ROOT_LEVEL - l);
    return errors[l][ky * across + kx] ?? 0;
  };

  // A chunk's vertex heights (NAVD88, row-major, north row first) before any stitching
  function heights(l, kx, ky) {
    const s = 2 ** l, [e0, n0] = origin(l, kx, ky);
    const h = new Float64Array(VERTICES);
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) h[b * N + a] = navdAt(e0 + a * s, n0 - b * s);
    return h;
  }

  // The four edges of a chunk as [first vertex, vertex step, UTM start, UTM step per vertex (de, dn), outward (de, dn)]
  const EDGES = [
    [0, 1, (e0, n0) => [e0, n0], [1, 0], [0, 1]], // north
    [CELLS, N, (e0, n0, size) => [e0 + size, n0], [0, -1], [1, 0]], // east
    [CELLS * N, 1, (e0, n0, size) => [e0, n0 - size], [1, 0], [0, -1]], // south
    [0, N, (e0, n0) => [e0, n0], [0, -1], [-1, 0]] // west
  ];
  // The selected chunk containing UTM (e, n) at level > l, as its level, or -1
  const coarserAt = (l, e, n, chosen) => {
    for (let K = l + 1; K <= ROOT_LEVEL; K++) {
      const sz = CELLS * 2 ** K;
      if (chosen.has(`${K}/${Math.floor((e - OE) / sz)}/${Math.floor((ON - n) / sz)}`)) return K;
    }
    return -1;
  };
  // The level of the selected chunk just outside each edge of chunk (l, kx, ky) when it is coarser, else -1
  function coarserNeighbours(l, kx, ky, chosen) {
    const [e0, n0, size] = origin(l, kx, ky);
    return EDGES.map(([, , start, step, out]) => {
      const [se, sn] = start(e0, n0, size);
      return coarserAt(l, se + step[0] * size / 2 + out[0] * 0.5, sn + step[1] * size / 2 + out[1] * 0.5, chosen);
    });
  }
  // Stitch heights h (NAVD88, from heights()) of chunk (l, kx, ky) onto its coarser neighbours (levels in `stitch`): each
  // edge vertex the neighbour does not share takes the height of the neighbour's edge there, linear between the
  // neighbour's own edge vertices (their raw heights: the neighbour, coarser, is never stitched along this edge, and its
  // vertices at this edge's ends are on the root grid of its level, so ours share them)
  function stitchInto(h, l, kx, ky, stitch) {
    const s = 2 ** l, [e0, n0, size] = origin(l, kx, ky);
    stitch.forEach((K, k) => {
      if (K < 0) return;
      const [v0, dv, start, step] = EDGES[k];
      const S = 2 ** K;
      const [se, sn] = start(e0, n0, size);
      for (let i = 0; i <= CELLS; i++) {
        const e = se + step[0] * i * s, n = sn + step[1] * i * s;
        // position along the edge in the neighbour's spacing (its vertices are every S m on the root grid)
        const u = step[0] ? (e - OE) / S : (ON - n) / S;
        const u0 = Math.floor(u + 1e-9), f = u - u0;
        if (f < 1e-9) continue; // a vertex the neighbour shares
        const at = (uu) => (step[0] ? navdAt(OE + uu * S, n) : navdAt(e, ON - uu * S));
        h[v0 + i * dv] = at(u0) * (1 - f) + at(u0 + 1) * f;
      }
    });
    return h;
  }

  // The chunks for a camera at UTM (ce, cn), `above` metres over the ground: [{ key, l, kx, ky, stitch }] (stitch: the
  // coarser neighbours' levels per edge, or null)
  function select(ce, cn, above) {
    const out = [];
    (function visit(l, kx, ky) {
      const [e0, n1, size] = origin(l, kx, ky);
      const e1 = e0 + size, n0 = n1 - size;
      if (e1 < ring.e0 || e0 > ring.e1 || n1 < ring.n0 || n0 > ring.n1) return;
      const overlapsHull = !(e1 < hull.e0 || e0 > hull.e1 || n1 < hull.n0 || n0 > hull.n1);
      const minLevel = overlapsHull ? 0 : RING_MIN_LEVEL;
      const dx = Math.max(0, e0 - ce, ce - e1), dn = Math.max(0, n0 - cn, cn - n1);
      const d = Math.hypot(dx, dn, above);
      if (l > minLevel && (d < refine * size || errorOf(l, kx, ky) > screenTol * d)) {
        for (let k = 0; k < 4; k++) visit(l - 1, kx * 2 + (k & 1), ky * 2 + (k >> 1));
      } else out.push({ key: `${l}/${kx}/${ky}`, l, kx, ky, stitch: null });
    })(ROOT_LEVEL, 0, 0);
    const chosen = new Set(out.map((c) => c.key));
    for (const c of out) {
      const st = coarserNeighbours(c.l, c.kx, c.ky, chosen);
      if (st.some((K) => K >= 0)) c.stitch = st;
    }
    return { chunks: out, chosen };
  }

  // NAVD88 of the drawn chunk (heights h, from heights() and stitchInto()) at UTM (e, n) inside it: its triangles
  function drawnAt(l, kx, ky, h, e, n) {
    const s = 2 ** l, [e0, n0] = origin(l, kx, ky);
    const fa = (e - e0) / s, fb = (n0 - n) / s;
    const a = Math.min(CELLS - 1, Math.max(0, Math.floor(fa))), b = Math.min(CELLS - 1, Math.max(0, Math.floor(fb)));
    const fx = fa - a, fy = fb - b;
    const h00 = h[b * N + a], h11 = h[(b + 1) * N + a + 1];
    if (fx >= fy) return h00 + fx * (h[b * N + a + 1] - h00) + fy * (h11 - h[b * N + a + 1]);
    const h01 = h[(b + 1) * N + a];
    return h00 + fy * (h01 - h00) + fx * (h11 - h01);
  }

  return { OE, ON, origin, navdAt, heights, stitchInto, coarserNeighbours, select, drawnAt, errorOf, clampRing, EDGES };
}

export { createTerrainLod, CELLS, ROOT_LEVEL, ROOT_MARGIN, RING_MIN_LEVEL, REFINE, SCREEN_TOL, N, VERTICES, SURFACE };
