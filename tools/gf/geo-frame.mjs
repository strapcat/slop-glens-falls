// Glens Falls world frame: WGS84 -> local metres on the tangent plane at (LAT0, LON0).
// Same axis convention as the NYC frame (tools/geo-base.mjs): 1 unit = 1 m, x = east, z = south (north = -z), y = up.
// THETA = 0: the axes follow true north (Glens Falls has no single street grid to align to).
// The origin is a provisional downtown centroid; moving it shifts every coordinate in js/gf-geodata.js.

export const LAT0 = 43.3095;
export const LON0 = -73.644;
export const THETA = 0;
// Overpass bounding box of the extract (Glens Falls + South Glens Falls across the Hudson)
export const BBOX = { south: 43.29, west: -73.68, north: 43.33, east: -73.61 };

const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;

// [x, z] metres of a lon/lat; linear in both, so the lat/lon bbox maps to an axis-aligned rectangle
export function toLocal(lon, lat) {
  const e = (lon - LON0) * KX, n = (lat - LAT0) * KY;
  const c = Math.cos(THETA), s = Math.sin(THETA);
  return [e * c - n * s, -(e * s + n * c)];
}

// Inverse of toLocal: [lon, lat] of a local [x, z]
export function toLonLat(x, z) {
  const c = Math.cos(THETA), s = Math.sin(THETA);
  const e = x * c - z * s, n = -(x * s + z * c);
  return [LON0 + e / KX, LAT0 + n / KY];
}

export const q = (v) => Math.round(v * 10) / 10;
export const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);

// The bbox in metres: { x0, x1, z0, z1 } with x0 < x1 and z0 < z1 (z0 is the north edge)
export const BBOX_M = (() => {
  const [x0, z0] = toLocal(BBOX.west, BBOX.north);
  const [x1, z1] = toLocal(BBOX.east, BBOX.south);
  return { x0: q(x0), x1: q(x1), z0: q(z0), z1: q(z1) };
})();
