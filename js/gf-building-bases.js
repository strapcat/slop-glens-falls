import { createGfBuildingRecords } from './gf-building-records.js';
import { applyGfLandmarks } from './gf-landmark-records.js';

// Glens Falls's buildings on the CC-005b terrain: gf-building-meshes.js's buildings (the CC-003 records with the
// CC-004 landmark overrides, unchanged), each standing on its own base. Every height keeps its meaning:
//   base        the median ground in a 2-12 m ring round the footprint: the reference the CC-003b LiDAR heights were
//               measured from (roof minus the median ground in that ring), so a roof stays where it was measured. The
//               same base for every height source (tag, levels, landmark, LiDAR, default rule).
//   roof        level at base + height; never tilted to the slope, never scaled.
//   foundation  the lowest ground under the walls: the walls reach down to it, so no downhill corner floats; uphill
//               the ground covers the walls' foot. `exposed` / `burial`: how far the ground falls below / rises above
//               the base under the walls.
//   features    a roof feature (spire, flèche, gable) from its building's roof to its top above that building's base;
//               the Civil War Monument on the ground at its OSM node.
// Party walls compare absolute roofs (base + height). The colliders span foundation to roof.

const RING = [3, 7, 11]; // metres out from the walls the ring samples go (inside the LiDAR method's 2-12 m)
const RING_STEP = 3; // metres between samples along a wall

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if ((ring[i].z > z) !== (ring[j].z > z) && x < ring[i].x + ((ring[j].x - ring[i].x) * (z - ring[i].z)) / (ring[j].z - ring[i].z)) inside = !inside;
  }
  return inside;
}

// { base, foundation, burial, exposed } of a footprint ({ outer, holes } of { x, z }) on ground(x, z)
function terrainOf(polygon, ground) {
  const outer = polygon.outer, n = outer.length;
  let signed = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) signed += outer[j].x * outer[i].z - outer[i].x * outer[j].z;
  const out = signed > 0 ? -1 : 1; // which side of an edge's left normal is outside
  const ring = [], walls = [];
  for (let i = 0; i < n; i++) {
    const a = outer[i], b = outer[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const nx = (-(b.z - a.z) / len) * out, nz = ((b.x - a.x) / len) * out;
    const steps = Math.max(1, Math.round(len / RING_STEP));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      walls.push(ground(x, z));
      for (const d of RING) {
        const px = x + nx * d, pz = z + nz * d;
        if (!inRing(outer, px, pz)) ring.push(ground(px, pz));
      }
    }
    walls.push(ground(a.x, a.z));
  }
  const sorted = (v) => v.filter(Number.isFinite).sort((p, q) => p - q);
  const r = sorted(ring), w = sorted(walls);
  const base = r.length ? r[Math.floor((r.length - 1) / 2)] : w[Math.floor((w.length - 1) / 2)];
  return { base, foundation: Math.min(base, w[0]), burial: Math.max(0, w[w.length - 1] - base), exposed: Math.max(0, base - w[0]) };
}

// The CC-003 records (and CC-004 overrides) on the terrain: { records, colliders, obstacles, features, applied }
function gfBuildingsOnTerrain(data, landmarks, ground) {
  const flat = createGfBuildingRecords(data);
  const records = flat.records.map((r) => ({ ...r, ...terrainOf(r.polygons[0], ground) }));
  const onTerrain = { records, colliders: flat.colliders, obstacles: flat.obstacles };
  const result = landmarks ? applyGfLandmarks(onTerrain, landmarks) : { ...onTerrain, features: [], applied: [] };
  const n = result.records.length;
  // building colliders from foundation to roof; anything after them (the monument's plinth) on the ground at its centre
  const colliders = result.colliders.map((c, i) => {
    if (i < n) {
      const r = result.records[i];
      return { ...c, minY: r.foundation, maxY: r.base + r.height };
    }
    const g = ground((c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2);
    return { ...c, minY: c.minY + g, maxY: c.maxY + g };
  });
  const baseOf = new Map(result.records.map((r) => [r.polygons[0], r.base]));
  const features = result.features.map((f) => {
    const g = f.polygon ? baseOf.get(f.polygon) : ground(f.x, f.z);
    return { ...f, base: f.base + g, top: f.top + g, ground: g };
  });
  return { ...result, colliders, features };
}

export { gfBuildingsOnTerrain, terrainOf };
