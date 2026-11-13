// CC-006: Glens Falls street lights (no three.js; drawn by gf-street-furniture-meshes.js). OSM maps almost none of the
// town's lamps (24 highway=street_lamp nodes), so they are ASSUMED: procedurally spaced along every curb a road runs
// beside (gf-sidewalks.js curb rings), SPACING_DOWNTOWN apart in the Three Squares envelope and SPACING_RESIDENTIAL
// elsewhere, OFFSET in from the curb's face: on a residential tree lawn's middle, beside the curb on a downtown walk;
// never in the carriageway, never at the middle of a walk. Not 1993 and not a survey. A spot is skipped (the next sample
// on is tried, up to SLIDE) on a driveway, a tree trunk, a building, a stop or signal post, or off its block. OSM lamps
// on a curb band replace the procedural ones within REPLACE of them.
// CC-006b: two styles. Downtown (sidewalks.downtown, the Three Squares envelope) every lamp is a GASLIGHT-style post
// (Dave, 2026-11-12: in 1993 downtown's street lamps were old gaslight-style posts, not cobra heads); elsewhere a
// COBRA head on an arm. The OSM lamps downtown (a row along Glen St) stand where OSM puts them when that is on a walk
// or open ground (not in a building, not within CARRIAGEWAY of the roadway); one in or at the carriageway snaps to the
// nearest curb-side walk spot within SNAP; else it is skipped, with its reason. Each replaces the assumed lamps within
// REPLACE of it. OSM lamps outside downtown keep CC-006's rule.
// The lamps glow by lampGlow(interiorGlow), both styles alike: 0 at midday and golden hour, rising through dusk to 1 by
// twilight and midnight (lighting.js TIME_PRESETS interiorGlow; the party's NIGHT_GLOW threshold sits in that ramp).

const SPACING_DOWNTOWN = 30; // m along the curb (assumed)
const SPACING_RESIDENTIAL = 42; // m (assumed)
const OFFSET = 0.55; // m in from the curb's face (curb 0.15 + half of a 0.9 m lawn; downtown: on the walk by the curb)
const SLIDE = 6; // m a lamp may move along the curb to a clear spot
const CLEAR = { trunk: 0.9, post: 2.0, building: 0.6 }; // m: from a trunk's bark, from a post; a building's box slack before its footprint test (gf-main.js avoid)
const REPLACE = 15; // m: an OSM lamp replaces procedural ones this near
const CARRIAGEWAY = 0.25; // m: nearer the roadway's edge than this is in the carriageway
const SNAP = 10; // m: how far an OSM downtown lamp in the carriageway may move to a curb-side walk spot
const GLOW_ON = [0.65, 1.2]; // lighting.js interiorGlow: off below, full above
const STYLES = ['cobra', 'gaslight'];

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// the same ramp for both styles (style is accepted so callers can say which lamp they mean)
const lampGlow = (interiorGlow, style = 'cobra') => (STYLES.includes(style) ? smooth(GLOW_ON[0], GLOW_ON[1], interiorGlow) : 0);
const styleAt = (sidewalks, x, z) => (sidewalks.downtown(x, z) ? 'gaslight' : 'cobra');

// sidewalks: gf-sidewalks.js. avoid(x, z): a reason a lamp may not stand there (trunks, posts, buildings), or null.
// inBuilding(x, z): true inside a building's footprint (the OSM downtown lamps; defaults to avoid's 'building').
// osmLamps: [{ x, z, osm }]. Returns { lamps: [{ x, z, nx, nz (unit, towards the road: the cobra's arm reaches over
// it), kind: 'assumed' | 'osm', style: 'cobra' | 'gaslight', osm?, placed?: 'as-is' | 'snapped', from? }], counts }
function placeStreetLights(sidewalks, { avoid = () => null, inBuilding = null, osmLamps = [] } = {}) {
  const building = inBuilding || ((x, z) => avoid(x, z) === 'building');
  const lamps = [];
  const counts = { assumed: 0, osm: 0, osmOffBand: 0, gaslight: 0, cobra: 0, skipped: {}, osmDowntown: { asIs: 0, snapped: 0, skipped: [] } };
  const skip = (why) => { counts.skipped[why] = (counts.skipped[why] || 0) + 1; };
  const at = (sm, off) => ({ x: sm.x - sm.nx * off, z: sm.z - sm.nz * off });
  // why a curb sample's lamp spot (OFFSET in from the curb) may not hold a lamp, or null
  const spotWhy = (sm) => {
    const c = sidewalks.curbAt(sm);
    if (!c.roadside) return 'no road';
    if (c.cut) return 'driveway';
    if (sm.corner) return 'curb corner';
    const p = at(sm, OFFSET);
    if (sidewalks.bandAt(p.x, p.z) === null && !sidewalks.walkAt(p.x, p.z)) return 'off the band';
    if (sidewalks.roadEdge(p.x, p.z) < CARRIAGEWAY) return 'carriageway';
    return avoid(p.x, p.z);
  };
  const lampAt = (sm, extra) => {
    const p = at(sm, OFFSET);
    const l = Math.hypot(sm.nx, sm.nz) || 1;
    return { x: +p.x.toFixed(2), z: +p.z.toFixed(2), nx: sm.nx / l, nz: sm.nz / l, downtown: sidewalks.downtown(p.x, p.z), style: styleAt(sidewalks, p.x, p.z), ...extra };
  };
  for (const entry of sidewalks.rings) {
    if (entry.kind !== 'curb') continue;
    const list = sidewalks.ringSamples(entry);
    let next = 0; // arc length of the next lamp
    for (let k = 0; k < list.length - 1; k++) {
      const sm = list[k];
      if (sm.s < next) continue;
      if (sm.s > next + SLIDE) next = sm.s; // a long gap (no road beside it): start afresh here
      const why = spotWhy(sm);
      if (why) { skip(why); if (why === 'no road') next = sm.s; continue; }
      const lamp = lampAt(sm, { kind: 'assumed', ring: entry, s: sm.s });
      lamps.push(lamp);
      next = sm.s + (lamp.downtown ? SPACING_DOWNTOWN : SPACING_RESIDENTIAL);
    }
  }
  const replaceNear = (x, z) => {
    for (let i = lamps.length - 1; i >= 0; i--) if (lamps[i].kind === 'assumed' && Math.hypot(lamps[i].x - x, lamps[i].z - z) < REPLACE) lamps.splice(i, 1);
  };
  // the nearest curb-side walk spot (a lamp spot on the walk, OFFSET in from a curb) within SNAP of (x, z), or null
  const snapSpot = (x, z) => {
    let best = null, bd = SNAP;
    for (const entry of sidewalks.rings) {
      if (entry.kind !== 'curb') continue;
      const b = entry.box;
      if (x < b.minX - SNAP || x > b.maxX + SNAP || z < b.minZ - SNAP || z > b.maxZ + SNAP) continue;
      for (const sm of sidewalks.ringSamples(entry)) {
        const p = at(sm, OFFSET);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d >= bd || !sidewalks.walkAt(p.x, p.z) || spotWhy(sm)) continue;
        bd = d; best = sm;
      }
    }
    return best;
  };
  for (const o of osmLamps) {
    if (sidewalks.downtown(o.x, o.z)) {
      // CC-006b: downtown OSM lamps (the Glen St row) as gaslights where OSM puts them
      const nowhere = (reason) => counts.osmDowntown.skipped.push({ osm: o.osm, x: o.x, z: o.z, reason });
      if (building(o.x, o.z)) { nowhere('in a building'); continue; }
      const b = sidewalks.bandAt(o.x, o.z);
      if (sidewalks.roadEdge(o.x, o.z) >= CARRIAGEWAY) {
        replaceNear(o.x, o.z);
        lamps.push({ x: o.x, z: o.z, nx: b ? b.n.x : 0, nz: b ? b.n.z : 0, kind: 'osm', osm: o.osm, downtown: true, style: 'gaslight', placed: 'as-is' });
        counts.osmDowntown.asIs++;
        continue;
      }
      const sm = snapSpot(o.x, o.z);
      if (!sm) { nowhere(`in the carriageway, no curb-side walk spot within ${SNAP} m`); continue; }
      const lamp = lampAt(sm, { kind: 'osm', osm: o.osm, placed: 'snapped', from: { x: o.x, z: o.z } });
      if (lamp.style !== 'gaslight') { nowhere('in the carriageway; its nearest walk spot is outside downtown'); continue; }
      replaceNear(lamp.x, lamp.z);
      lamps.push(lamp);
      counts.osmDowntown.snapped++;
      continue;
    }
    // OSM lamps standing on a curb band (between a road and its lot line) replace the assumed ones near them
    const b = sidewalks.bandAt(o.x, o.z);
    if (!b || b.inLot || sidewalks.roadEdge(o.x, o.z) < CARRIAGEWAY) { counts.osmOffBand++; continue; }
    replaceNear(o.x, o.z);
    lamps.push({ x: o.x, z: o.z, nx: b.n.x, nz: b.n.z, kind: 'osm', osm: o.osm, downtown: false, style: 'cobra' });
  }
  counts.assumed = lamps.filter((l) => l.kind === 'assumed').length;
  counts.osm = lamps.filter((l) => l.kind === 'osm').length;
  counts.gaslight = lamps.filter((l) => l.style === 'gaslight').length;
  counts.cobra = lamps.filter((l) => l.style === 'cobra').length;
  return { lamps, counts };
}

export { placeStreetLights, lampGlow, styleAt, SPACING_DOWNTOWN, SPACING_RESIDENTIAL, OFFSET, GLOW_ON, CLEAR, REPLACE, CARRIAGEWAY, SNAP, STYLES };
