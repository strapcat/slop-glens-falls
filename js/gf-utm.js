// UTM zone 18N (the CRS the USGS 3DEP NY_Hudson_D22 tiles encode, EPSG:26918) to and from longitude/latitude, and the
// Glens Falls local frame (gf-geodata.js frame: x = east, z = south, metres on the tangent plane at 43.3095 N 73.644 W).
// No three.js, so the terrain generator, the game and the Node tests share it.
//
// Transverse Mercator by the Kruger series to n^6 (Karney 2011, "Transverse Mercator with an accuracy of a few
// nanometers"), sub-millimetre over a UTM zone, on GRS80 (NAD83's ellipsoid). OSM's WGS84 lon/lat go in unchanged: like
// pyproj's EPSG:4326 -> EPSG:26918 default (which made the CC-005b terrain inputs' anchor), WGS84 and NAD83 are taken as
// coincident here. They differ by about 1-2 m on the ground today (NAD83(2011) vs WGS84 realisations), so this is a
// consistent mapping, not a survey-grade datum transformation.

const A = 6378137.0;
const F = 1 / 298.257222101; // GRS80
const K0 = 0.9996;
const LON0 = -75; // zone 18 central meridian
const FE = 500000;
const N_ = F / (2 - F);
const n2 = N_ * N_, n3 = n2 * N_, n4 = n3 * N_, n5 = n4 * N_, n6 = n5 * N_;
const A_RECT = (A / (1 + N_)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const ALPHA = [
  N_ / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
  (212378941 / 319334400) * n6
];
const BETA = [
  N_ / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5 + (96199 / 604800) * n6,
  (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5 - (1118711 / 3870720) * n6,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
  (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
  (4583 / 161280) * n5 - (108847 / 3991680) * n6,
  (20648693 / 638668800) * n6
];
const E = Math.sqrt(F * (2 - F)); // first eccentricity
const D2R = Math.PI / 180;

// [easting, northing] metres of a lon/lat (degrees)
function lonLatToUtm(lon, lat) {
  const phi = lat * D2R, lam = (lon - LON0) * D2R;
  // conformal latitude
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E * Math.atanh(E * s));
  const xi1 = Math.atan2(t, Math.cos(lam));
  const eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 6; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1);
  }
  return [FE + K0 * A_RECT * eta, K0 * A_RECT * xi];
}

// [lon, lat] degrees of a UTM 18N easting/northing
function utmToLonLat(e, n) {
  const xi = n / (K0 * A_RECT), eta = (e - FE) / (K0 * A_RECT);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 6; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const tau1 = Math.sin(xi1) / Math.sqrt(Math.sinh(eta1) ** 2 + Math.cos(xi1) ** 2);
  const lam = Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  // geodetic latitude from the conformal one (Newton on tan, as Karney eq. 19-21)
  let tau = tau1;
  for (let k = 0; k < 6; k++) {
    const sig = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
    const taup = tau * Math.sqrt(1 + sig * sig) - sig * Math.sqrt(1 + tau * tau);
    const dtau = ((tau1 - taup) / Math.sqrt(1 + taup * taup)) * ((1 + (1 - E * E) * tau * tau) / ((1 - E * E) * Math.sqrt(1 + tau * tau)));
    tau += dtau;
    if (Math.abs(dtau) < 1e-14) break;
  }
  return [LON0 + lam / D2R, Math.atan(tau) / D2R];
}

// The local frame of gf-geodata.js (tools/gf/geo-frame.mjs, the same constants): linear in lon/lat
function localFrame(frame) {
  const a = 6378137.0, e2 = 6.69437999014e-3;
  const phi0 = (frame.lat0 * Math.PI) / 180, s0 = Math.sin(phi0);
  const nrad = a / Math.sqrt(1 - e2 * s0 * s0), mrad = (a * (1 - e2)) / Math.pow(1 - e2 * s0 * s0, 1.5);
  const kx = (Math.PI / 180) * nrad * Math.cos(phi0), ky = (Math.PI / 180) * mrad;
  const c = Math.cos(frame.theta || 0), s = Math.sin(frame.theta || 0);
  return {
    toLocal(lon, lat) {
      const e = (lon - frame.lon0) * kx, n = (lat - frame.lat0) * ky;
      return [e * c - n * s, -(e * s + n * c)];
    },
    toLonLat(x, z) {
      const e = x * c - z * s, n = -(x * s + z * c);
      return [frame.lon0 + e / kx, frame.lat0 + n / ky];
    }
  };
}

export { lonLatToUtm, utmToLonLat, localFrame };
