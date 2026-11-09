import { createGfWater } from './gf-water.js';

// The Glens Falls surface contract (CC-005b): one deterministic answer, for every consumer, to "what is at (x, z)?",
// on the terrain of js/gf-terrain.js. No three.js, so the game and the Node tests ask the same functions. Heights are
// game y (NAVD88 - the anchor, see gf-terrain.js); x and z are the gf-geodata.js frame.
//
//   ground(x, z)          bare earth (the DEM): what a tree, a wall's foundation or a sign post stands in. NaN where
//                         there is no terrain (beyond the 8 m ring), never a flat fill.
//   deckAt(x, z, opts)    a bridge deck over (x, z), or null. The decks are the OSM bridge ways (gf-bridges.js) on their
//                         road-graph links, as wide as the road plus DECK_MARGIN each side. A bare-earth DEM does not
//                         measure a deck: its height runs straight between the terrain at its two abutments (the ends
//                         of the chain of bridge segments), so it meets the approach roads and never sags into the river.
//                         Within DECK_TWIST of an end it also takes the ground's cross-slope there (fading out along the
//                         deck), so it meets the approach road across its whole width, not only on the centre line.
//   support(x, z, nearY)  what something at height nearY stands on there: the highest of the ground and any deck no
//                         more than STEP_UP above nearY (a player on a bridge stays on it, one on the road beneath stays
//                         there); with nearY unknown (NaN), the highest. Roofs are not supports.
//   road(x, z, dirX, dirZ, nearY)  the drivable surface for a vehicle heading (dirX, dirZ): a deck it runs along
//                         (within DECK_ALIGN), else the ground, so a road passing under a bridge keeps to the ground;
//                         given its last height, the nearer of deck and ground (it stays on the level it is on).
//   water(x, z)           the water surface (gf-water.js) or null.
//   footDeckAt(x, z)      CC-005c (opt-in footDecks): a mapped footbridge over (x, z), or null: the same deck rule, for
//                         walkers only. support() stands on it; road() and deckAt() (vehicles) never see it.
//   normal(x, z, out)     the ground's smoothed unit normal; info(x, z) all of it, with the terrain's provenance.
// CC-005c (park trails, the Thrill Hill gathering) places paths, props and feet with support() / ground() and their
// normals here, not with a second terrain.

const DECK_MARGIN = 2.0; // metres beyond the curb either side (the bridge sidewalks)
const STEP_UP = 1.0; // metres: the most a support may be above the height asked about
const DECK_ALIGN = 0.7; // cos of the largest angle between a vehicle's heading and a deck it drives along
const NEAR_KEEP = 3; // metres: a vehicle within this of its last height keeps to the nearer of deck and ground
const DECK_TWIST = 12; // metres from an end over which a deck turns from the ground's cross-slope to level

function createGfSurface({ terrain, geo, bridges, footDecks = null }) {
  const ground = terrain.heightAt;
  const { nodes, links, linkFields } = geo.roadGraph;
  const at = Object.fromEntries(linkFields.map((f, i) => [f, i]));
  const linkPts = (li) => {
    const l = links[li];
    const pts = [[nodes[l[at.a] * 2], nodes[l[at.a] * 2 + 1]]];
    const inner = l[at.pts] || [];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push([nodes[l[at.b] * 2], nodes[l[at.b] * 2 + 1]]);
    return pts;
  };

  // A deck from its chain of segments ({ from, to, len, s0, width, margin? }): bounds, its straight abutment-to-abutment
  // line and height (see heightAt)
  function makeDeck(chain, id, len, meta) {
    const first = chain[0].from, last = chain[chain.length - 1].to;
    const y0 = ground(first[0], first[1]), y1 = ground(last[0], last[1]);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of chain) {
      const half = c.width / 2 + (c.margin ?? DECK_MARGIN);
      for (const q of [c.from, c.to]) {
        minX = Math.min(minX, q[0] - half); maxX = Math.max(maxX, q[0] + half);
        minZ = Math.min(minZ, q[1] - half); maxZ = Math.max(maxZ, q[1] + half);
      }
    }
    return {
      id, ...meta, length: len,
      ends: [first, last], endY: [y0, y1], segments: chain, bounds: { minX, maxX, minZ, maxZ },
      yAt: (s) => y0 + ((y1 - y0) * Math.min(len, Math.max(0, s))) / len,
      // the deck at (x, z), s along it, whose centre line point is (cx, cz): the straight line, plus near an end the
      // ground's rise from the centre line to (x, z), fading out over DECK_TWIST; never under the ground
      heightAt(s, x, z, cx, cz) {
        const g = ground(x, z);
        const w = Math.max(0, 1 - Math.min(s, len - s) / DECK_TWIST);
        const y = this.yAt(s) + (w > 0 ? w * (g - ground(cx, cz)) : 0);
        return Math.max(y, g);
      }
    };
  }

  // Bridge segments, chained where they share an end: each chain is one deck from abutment to abutment
  const segs = [];
  for (const b of bridges.bridges) {
    for (const [li, s] of b.segments) {
      const pts = linkPts(li);
      segs.push({ osm: b.osm, name: b.name, highway: b.highway, link: li, seg: s, a: pts[s], b: pts[s + 1], width: links[li][at.width] });
    }
  }
  const key = (p) => `${p[0]},${p[1]}`;
  const byEnd = new Map();
  segs.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      if (!byEnd.has(key(p))) byEnd.set(key(p), []);
      byEnd.get(key(p)).push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  const decks = [];
  segs.forEach((s0, i0) => {
    if (used[i0]) return;
    // the chain's segments (connected through shared ends), then walk it from an end only one of them reaches
    const comp = new Set([i0]);
    for (const todo = [i0]; todo.length;) {
      const s = segs[todo.pop()];
      for (const p of [s.a, s.b]) for (const k of byEnd.get(key(p))) if (!comp.has(k)) { comp.add(k); todo.push(k); }
    }
    const degree = (p) => byEnd.get(key(p)).filter((k) => comp.has(k)).length;
    const startSeg = [...comp].sort((a, b) => a - b).find((k) => degree(segs[k].a) === 1 || degree(segs[k].b) === 1) ?? i0;
    const start = degree(segs[startSeg].a) === 1 ? segs[startSeg].a : degree(segs[startSeg].b) === 1 ? segs[startSeg].b : segs[startSeg].a;
    const chain = [];
    let p = start, cur = byEnd.get(key(p)).find((k) => comp.has(k) && !used[k]);
    while (cur !== undefined) {
      used[cur] = 1;
      const s = segs[cur];
      const fwd = key(s.a) === key(p);
      chain.push({ ...s, from: fwd ? s.a : s.b, to: fwd ? s.b : s.a });
      p = fwd ? s.b : s.a;
      cur = byEnd.get(key(p)).find((k) => comp.has(k) && !used[k]);
    }
    let len = 0;
    for (const c of chain) {
      c.s0 = len;
      c.len = Math.hypot(c.to[0] - c.from[0], c.to[1] - c.from[1]);
      len += c.len;
    }
    decks.push(makeDeck(chain, decks.length, len, { osm: [...new Set(chain.map((c) => c.osm))], name: chain[0].name, highway: chain[0].highway }));
  });

  // CC-005c (opt-in): footbridges (gf-trails.js footDecks: { id, way, widthM, pts: [x, z, ...] }) as decks for walkers,
  // by the same rule (straight between the ground at its two abutments, never under the ground), as wide as the
  // footbridge (no sidewalk margin). Vehicles never use them: road() and deckAt() see road decks only.
  const footDeckList = (footDecks || []).map((f, k) => {
    const chain = [];
    let len = 0;
    for (let i = 0; i + 3 < f.pts.length; i += 2) {
      const from = [f.pts[i], f.pts[i + 1]], to = [f.pts[i + 2], f.pts[i + 3]];
      const l = Math.hypot(to[0] - from[0], to[1] - from[1]);
      chain.push({ from, to, len: l, s0: len, width: f.widthM, margin: 0 });
      len += l;
    }
    return makeDeck(chain, k, len, { osm: [f.way], name: f.id, highway: 'footway', foot: true });
  });

  // The deck over (x, z), if any: { deck, y, s (along the deck), lateral, halfWidth, dirX, dirZ }. With opts.dir
  // ([dirX, dirZ]), only a deck running along it
  function deckAt(x, z, opts = {}) {
    return deckIn(decks, x, z, opts);
  }
  // CC-005c: the footbridge deck over (x, z), if any (as deckAt)
  function footDeckAt(x, z, opts = {}) {
    return footDeckList.length ? deckIn(footDeckList, x, z, opts) : null;
  }
  function deckIn(list, x, z, opts) {
    let best = null;
    for (const d of list) {
      const b = d.bounds;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      d.segments.forEach((c, k) => {
        const ex = c.to[0] - c.from[0], ez = c.to[1] - c.from[1];
        let t = ((x - c.from[0]) * ex + (z - c.from[1]) * ez) / (c.len * c.len);
        const half = c.width / 2 + (c.margin ?? DECK_MARGIN);
        let lateral;
        if (t >= -1e-6 && t <= 1 + 1e-6) {
          t = Math.min(1, Math.max(0, t));
          lateral = Math.abs((x - c.from[0]) * ez - (z - c.from[1]) * ex) / c.len;
        } else if (t < 0 && k > 0) {
          // the outside of a bend in the chain: round the joint, so the deck has no gap there
          t = 0;
          lateral = Math.hypot(x - c.from[0], z - c.from[1]);
        } else if (t > 1 && k < d.segments.length - 1) {
          t = 1;
          lateral = Math.hypot(x - c.to[0], z - c.to[1]);
        } else return;
        if (lateral > half) return;
        const dirX = ex / c.len, dirZ = ez / c.len;
        if (opts.dir && Math.abs(opts.dir[0] * dirX + opts.dir[1] * dirZ) < DECK_ALIGN) return;
        // the straight abutment-to-abutment line, or the ground where that stands higher (right by an abutment)
        if (!best || lateral < best.lateral) {
          const s = c.s0 + t * c.len;
          best = { deck: d, y: d.heightAt(s, x, z, c.from[0] + ex * t, c.from[1] + ez * t), s, lateral, halfWidth: half, dirX, dirZ };
        }
      });
    }
    return best;
  }

  function support(x, z, nearY = NaN) {
    const g = ground(x, z);
    const d = deckAt(x, z), f = footDeckAt(x, z);
    if (!d && !f) return g;
    if (!Number.isFinite(nearY)) return Math.max(g, d ? d.y : -Infinity, f ? f.y : -Infinity);
    // the highest within reach; with all above, the ground (whatever stands below the ground rises onto it)
    const limit = nearY + STEP_UP;
    let best = g <= limit ? g : -Infinity;
    if (d && d.y <= limit) best = Math.max(best, d.y);
    if (f && f.y <= limit) best = Math.max(best, f.y);
    return best === -Infinity ? g : best;
  }

  // The drivable surface for a vehicle at (x, z) heading (dirX, dirZ). Given where it was (nearY, its last height), it
  // keeps to whichever of a deck and the ground beneath is nearer that (within NEAR_KEEP), so a car turning off a bridge
  // at its end stays on the deck it is on; otherwise (or with none), a deck it runs along, else the ground
  function road(x, z, dirX, dirZ, nearY = NaN) {
    const g = ground(x, z);
    if (Number.isFinite(nearY)) {
      const any = deckAt(x, z);
      if (!any) return g;
      const dd = Math.abs(any.y - nearY), dg = Math.abs(g - nearY);
      if (Math.min(dd, dg) < NEAR_KEEP) return dd <= dg ? any.y : g;
    }
    const d = deckAt(x, z, { dir: [dirX, dirZ] });
    return d ? d.y : g;
  }

  const water = createGfWater(geo, ground);

  function info(x, z) {
    const t = terrain.infoAt(x, z);
    const d = deckAt(x, z);
    return {
      ground: t.y, valid: t.valid, normal: t.normal, slope: t.slope, source: t.source, resolution: t.resolution, navd88: t.navd88,
      deck: d ? { id: d.deck.id, osm: d.deck.osm, name: d.deck.name, y: d.y } : null,
      ...(footDeckList.length ? { footDeck: footDeckAt(x, z) ? { id: footDeckAt(x, z).deck.name, osm: footDeckAt(x, z).deck.osm, y: footDeckAt(x, z).y } : null } : {}),
      water: water.surfaceAt(x, z)
    };
  }

  return {
    terrain, ground, decks, deckAt, support, road, water, info, footDecks: footDeckList, footDeckAt,
    normal: (x, z, out) => terrain.normalAt(x, z, out),
    valid: (x, z) => Number.isFinite(ground(x, z)),
    constants: { DECK_MARGIN, STEP_UP, DECK_ALIGN, DECK_TWIST }
  };
}

export { createGfSurface, DECK_MARGIN, STEP_UP, DECK_ALIGN, DECK_TWIST };
