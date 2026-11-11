// CC-005e: the strips gf-sidewalk-meshes.js draws, as plain buffers (no three.js, so the tests read them). Along each
// block's rings (gf-sidewalks.js rings, ringSamples), draped on the ground at every sample:
//   from a curb ring (only where a road runs beside it)
//     granite   the curb's face, from under the road to TOP, facing the road, and its CURB_W top
//     gutter    asphalt beyond the face, just above the draped road (the curb ring is a 1 m raster's outline, up to
//               about 0.4 m off the drawn ribbon's edge)
//   from a lot ring (only where a road runs beside the band)
//     concrete  the walk, WALK_W in 5 ft flags out from the lot line (to the curb downtown), at TOP
//     lawn      the tree lawn between the walk and the curb, where there is one (residential), a hair under TOP
//     ramp      down from TOP at the lot line to the lot's own ground (grass; downtown, paving)
// A driveway (an OSM service road crossing the band) gets a depressed curb and a concrete apron in place of its lawn.
// Strips are grouped into CELL-metre cells by segment, built on demand.

const COLOURS = {
  white: [1, 1, 1],
  apron: [0.9, 0.886, 0.855],
  lotGrass: [0.867, 0.898, 0.812],
  lotPaved: [0.42, 0.4, 0.365]
};

function createSidewalkStrips(sidewalks, CELL = 250) {
  const S = sidewalks.constants;
  const ground = sidewalks.ground;
  const cells = new Map();
  sidewalks.rings.forEach((entry, r) => {
    const ring = entry.ring, n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ci = Math.floor((ring[i * 2] + ring[j * 2]) / 2 / CELL), cj = Math.floor((ring[i * 2 + 1] + ring[j * 2 + 1]) / 2 / CELL);
      const k = ci * 100000 + cj;
      if (!cells.has(k)) cells.set(k, { i: ci, j: cj, segs: [] });
      cells.get(k).segs.push([r, i]);
    }
  });
  const samples = new Map(); // ring index -> its samples, each with what is drawn there (at)
  function samplesOf(r) {
    let list = samples.get(r);
    if (!list) {
      const entry = sidewalks.rings[r];
      list = sidewalks.ringSamples(entry);
      for (const sm of list) sm.at = entry.kind === 'curb' ? sidewalks.curbAt(sm) : sidewalks.lotAt(entry, sm);
      samples.set(r, list);
    }
    return list;
  }

  // The buffers for a list of [ring, segment] pairs: { granite, gutter, concrete, lawn, ramp }, each { pos, along, joint,
  // col, grass, idx } (plain arrays; along: the ring's arc length, for the joints)
  function build(segs) {
    const bufs = {};
    const buf = (name) => bufs[name] || (bufs[name] = { pos: [], along: [], joint: [], col: [], grass: [], idx: [] });
    // a quad a0 a1 b1 b0 (a: this sample, b: the next; 0 the inner edge, 1 the outer); a vertex [x, y, z, along,
    // colour?, grass?]
    const quad = (name, a0, a1, b0, b1, { joint = 0, color = COLOURS.white, grass = 1 } = {}) => {
      const B = buf(name), o = B.pos.length / 3;
      for (const v of [a0, a1, b1, b0]) {
        B.pos.push(v[0], v[1], v[2]);
        B.along.push(v[3]);
        B.joint.push(joint);
        const c = v[4] || color;
        B.col.push(c[0], c[1], c[2]);
        B.grass.push(v[5] ?? grass);
      }
      B.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    const P = (sm, d, dy, extra = []) => {
      const x = sm.x + sm.nx * d, z = sm.z + sm.nz * d;
      return [x, ground(x, z) + dy, z, sm.s, ...extra];
    };
    for (const [r, i] of segs) {
      const entry = sidewalks.rings[r];
      const list = samplesOf(r);
      for (let k = 0; k + 1 < list.length; k++) {
        if (list[k].seg !== i) continue;
        const a = list[k], b = list[k + 1];
        const A = a.at, B = b.at;
        if (!A.roadside || !B.roadside) continue;
        if (entry.kind === 'curb') {
          const ta = A.cut ? S.depressed : S.top, tb = B.cut ? S.depressed : S.top;
          const g = S.roadLift + 0.004;
          quad('granite', P(a, 0, -0.06), P(a, 0, ta), P(b, 0, -0.06), P(b, 0, tb)); // the face, at the ring
          quad('granite', P(a, 0, ta), P(a, -S.curbW, ta), P(b, 0, tb), P(b, -S.curbW, tb)); // the top, behind it
          quad('gutter', P(a, S.gutter, g), P(a, 0, g), P(b, S.gutter, g), P(b, 0, g));
          continue;
        }
        const lot = (sm) => (sidewalks.downtown(sm.x, sm.z) ? [COLOURS.lotPaved, 0] : [COLOURS.lotGrass, 1]);
        // the walk; at a driveway downtown its road edge comes down to the depressed curb
        const walkEdge = (at) => (at.cut && !at.lawn ? S.depressed : S.top);
        quad('concrete', P(a, 0, S.top + 0.002), P(a, A.walkOut, walkEdge(A) + 0.002), P(b, 0, S.top + 0.002), P(b, B.walkOut, walkEdge(B) + 0.002), { joint: 1 });
        if (A.lawn || B.lawn) {
          const out = (at) => (at.lawn ? at.lawnOut : at.walkOut);
          if (A.cut || B.cut) {
            const edge = (at) => (at.cut ? S.depressed : S.top - 0.004);
            quad('concrete', P(a, A.walkOut, S.top), P(a, out(A), edge(A)), P(b, B.walkOut, S.top), P(b, out(B), edge(B)), { color: COLOURS.apron });
          } else {
            quad('lawn', P(a, A.walkOut, S.top - 0.004), P(a, out(A), S.top - 0.004), P(b, B.walkOut, S.top - 0.004), P(b, out(B), S.top - 0.004));
          }
        }
        // the ramp: from inside the lot (inner) up to the lot line (outer)
        quad('ramp', P(a, -S.ramp, -0.01, lot(a)), P(a, 0, S.top - 0.003, lot(a)), P(b, -S.ramp, -0.01, lot(b)), P(b, 0, S.top - 0.003, lot(b)));
      }
    }
    return bufs;
  }

  return { cells, build, samplesOf, CELL };
}

export { createSidewalkStrips, COLOURS };
