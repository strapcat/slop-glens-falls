// Glens Falls road ribbons draped on the CC-005b surface (no three.js, so Node tests measure what the game draws).
// Each road-graph link segment becomes a strip three vertices wide (left curb, centre line, right curb) whose stations
// are split until every metre along it lies within DRAPE_TOL of the surface on all three lines, so long straight runs
// stay a few quads and hills, crowns and humps get as many as they need. A bridge segment (gf-bridges.js) drapes over
// its deck (gf-surface.js deckAt) instead of the ground under it. Round joins at the link ends sit on the surface too.
// Everything is lifted ROAD_LIFT above the surface, so the drawn asphalt is never under the terrain; vehicles drive at
// that height (gf-main.js).

const DRAPE_TOL = 0.02;
const ROAD_LIFT = 0.03;
const MAX_STATION = 24; // metres, the longest quad even on a perfectly straight grade (keeps shading and fog even)

// { positions: Float32Array, indices: Uint32Array, quads, stations } of the links whose highway class passes include()
function drapeRoads(graph, include, surface, bridgeSegs = new Set()) {
  const { nodes, links } = graph;
  const pos = [];
  const idx = [];
  let stations = 0;
  const vert = (x, y, z) => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  for (let li = 0; li < links.length; li++) {
    const [a, b, , cls, , , width, inner] = links[li];
    if (!include(cls)) continue;
    const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
    const r = width / 2;
    for (let s = 0; s + 1 < pts.length; s++) {
      const [x0, z0] = pts[s], [x1, z1] = pts[s + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-6) continue;
      const nx = (-(z1 - z0) / len) * r, nz = ((x1 - x0) / len) * r;
      const dir = [(x1 - x0) / len, (z1 - z0) / len];
      const onDeck = bridgeSegs.has(`${li}/${s}`);
      // surface height at station t (0..1) and lateral offset k (-1 left, 0 centre, 1 right)
      const yAt = (t, k) => {
        const x = x0 + (x1 - x0) * t + nx * k, z = z0 + (z1 - z0) * t + nz * k;
        if (onDeck) {
          const d = surface.deckAt(x, z, { dir });
          if (d) return d.y;
        }
        return surface.ground(x, z);
      };
      // adaptive stations: [t0, t1] is fine if every metre between is within DRAPE_TOL of the chord on all three lines
      const ts = [0];
      const fine = (t0, t1, y0, y1) => {
        const n = Math.ceil((t1 - t0) * len);
        for (let k = 0; k < 3; k++) {
          for (let m = 1; m < n; m++) {
            const t = t0 + ((t1 - t0) * m) / n;
            if (Math.abs(yAt(t, k - 1) - (y0[k] + ((y1[k] - y0[k]) * m) / n)) > DRAPE_TOL) return false;
          }
        }
        return true;
      };
      const ys = (t) => [yAt(t, -1), yAt(t, 0), yAt(t, 1)];
      (function split(t0, t1, y0, y1) {
        if ((t1 - t0) * len <= MAX_STATION && ((t1 - t0) * len <= 1.01 || fine(t0, t1, y0, y1))) {
          ts.push(t1);
          return;
        }
        const tm = (t0 + t1) / 2, ym = ys(tm);
        split(t0, tm, y0, ym);
        split(tm, t1, ym, y1);
      })(0, 1, ys(0), ys(1));
      stations += ts.length;
      let prev = null;
      for (const t of ts) {
        const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        const row = [-1, 0, 1].map((k) => vert(x + nx * k, yAt(t, k) + ROAD_LIFT, z + nz * k));
        if (prev) {
          // left-centre and centre-right quads, up-facing
          for (let c = 0; c < 2; c++) idx.push(prev[c], row[c + 1], row[c], prev[c], prev[c + 1], row[c + 1]);
        }
        prev = row;
      }
    }
    // round joins (8-sided fans) at every point of the link, on the surface: on the deck where a bridge segment of the
    // link starts or ends there (the deck, or the ground where that stands higher, as gf-surface.js deckAt)
    pts.forEach(([x, z], k) => {
      const onDeck = bridgeSegs.has(`${li}/${k - 1}`) || bridgeSegs.has(`${li}/${k}`);
      const yAt = (px, pz) => {
        const d = onDeck ? surface.deckAt(px, pz) : null;
        return d ? d.y : surface.ground(px, pz);
      };
      const centre = vert(x, yAt(x, z) + ROAD_LIFT, z);
      const ring = [];
      for (let m = 0; m < 8; m++) {
        const ang = (m / 8) * Math.PI * 2;
        const px = x + Math.cos(ang) * r, pz = z + Math.sin(ang) * r;
        ring.push(vert(px, yAt(px, pz) + ROAD_LIFT, pz));
      }
      for (let m = 0; m < 8; m++) idx.push(centre, ring[(m + 1) % 8], ring[m]);
    });
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), stations };
}

export { drapeRoads, DRAPE_TOL, ROAD_LIFT };
