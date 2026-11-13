// CC-006: Glens Falls street lights (no three.js; drawn by gf-street-furniture-meshes.js). OSM maps almost none of the
// town's lamps (24 highway=street_lamp nodes), so they are ASSUMED: procedurally spaced along every curb a road runs
// beside (gf-sidewalks.js curb rings), SPACING_DOWNTOWN apart in the Three Squares envelope and SPACING_RESIDENTIAL
// elsewhere, OFFSET in from the curb's face: on a residential tree lawn's middle, beside the curb on a downtown walk;
// never in the carriageway, never at the middle of a walk. Not 1993 and not a survey. A spot is skipped (the next sample
// on is tried, up to SLIDE) on a driveway, a tree trunk, a building, a stop or signal post, or off its block. OSM lamps
// on a curb band replace the procedural ones within REPLACE of them.
// The lamps glow by lampGlow(interiorGlow): 0 at midday and golden hour, rising through dusk to 1 by twilight and
// midnight (lighting.js TIME_PRESETS interiorGlow; the party's NIGHT_GLOW threshold sits in that ramp).

const SPACING_DOWNTOWN = 30; // m along the curb
const SPACING_RESIDENTIAL = 42; // m
const OFFSET = 0.55; // m in from the curb's face (curb 0.15 + half of a 0.9 m lawn; downtown: on the walk by the curb)
const SLIDE = 6; // m a lamp may move along the curb to a clear spot
const CLEAR = { trunk: 0.9, post: 2.0, building: 0.6 }; // m: from a trunk's bark, from a post; a building's box slack before its footprint test (gf-main.js avoid)
const REPLACE = 15; // m: an OSM lamp replaces procedural ones this near
const GLOW_ON = [0.65, 1.2]; // lighting.js interiorGlow: off below, full above

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lampGlow = (interiorGlow) => smooth(GLOW_ON[0], GLOW_ON[1], interiorGlow);

// sidewalks: gf-sidewalks.js. avoid(x, z): a reason a lamp may not stand there (trunks, posts, buildings), or null.
// osmLamps: [{ x, z, osm }]. Returns { lamps: [{ x, z, nx, nz (unit, towards the road: the arm reaches over it), kind:
// 'assumed' | 'osm', osm? }], counts }
function placeStreetLights(sidewalks, { avoid = () => null, osmLamps = [] } = {}) {
  const lamps = [];
  const counts = { assumed: 0, osm: 0, osmOffBand: 0, skipped: {} };
  const skip = (why) => { counts.skipped[why] = (counts.skipped[why] || 0) + 1; };
  const at = (sm, off) => ({ x: sm.x - sm.nx * off, z: sm.z - sm.nz * off });
  for (const entry of sidewalks.rings) {
    if (entry.kind !== 'curb') continue;
    const list = sidewalks.ringSamples(entry);
    let next = 0; // arc length of the next lamp
    for (let k = 0; k < list.length - 1; k++) {
      const sm = list[k];
      if (sm.s < next) continue;
      if (sm.s > next + SLIDE) next = sm.s; // a long gap (no road beside it): start afresh here
      const why = (() => {
        const c = sidewalks.curbAt(sm);
        if (!c.roadside) return 'no road';
        if (c.cut) return 'driveway';
        if (sm.corner) return 'curb corner';
        const p = at(sm, OFFSET);
        if (sidewalks.bandAt(p.x, p.z) === null && !sidewalks.walkAt(p.x, p.z)) return 'off the band';
        if (sidewalks.roadEdge(p.x, p.z) < 0.25) return 'carriageway';
        return avoid(p.x, p.z);
      })();
      if (why) { skip(why); if (why === 'no road') next = sm.s; continue; }
      const p = at(sm, OFFSET);
      const l = Math.hypot(sm.nx, sm.nz) || 1;
      lamps.push({ x: +p.x.toFixed(2), z: +p.z.toFixed(2), nx: sm.nx / l, nz: sm.nz / l, kind: 'assumed', downtown: sidewalks.downtown(p.x, p.z), ring: entry, s: sm.s });
      next = sm.s + (sidewalks.downtown(p.x, p.z) ? SPACING_DOWNTOWN : SPACING_RESIDENTIAL);
    }
  }
  // OSM lamps standing on a curb band (between a road and its lot line) replace the assumed ones near them
  for (const o of osmLamps) {
    const b = sidewalks.bandAt(o.x, o.z);
    if (!b || b.inLot || sidewalks.roadEdge(o.x, o.z) < 0.25) { counts.osmOffBand++; continue; }
    for (let i = lamps.length - 1; i >= 0; i--) if (lamps[i].kind === 'assumed' && Math.hypot(lamps[i].x - o.x, lamps[i].z - o.z) < REPLACE) lamps.splice(i, 1);
    lamps.push({ x: o.x, z: o.z, nx: b.n.x, nz: b.n.z, kind: 'osm', osm: o.osm, downtown: sidewalks.downtown(o.x, o.z) });
  }
  counts.assumed = lamps.filter((l) => l.kind === 'assumed').length;
  counts.osm = lamps.filter((l) => l.kind === 'osm').length;
  return { lamps, counts };
}

export { placeStreetLights, lampGlow, SPACING_DOWNTOWN, SPACING_RESIDENTIAL, OFFSET, GLOW_ON, CLEAR, REPLACE };
