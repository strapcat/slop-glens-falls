// Glens Falls building heights measured from LiDAR (CC-003b), as data (no three.js, so Node tests use it as the game
// does): GF_LIDAR_HEIGHTS (js/gf-lidar-heights.js) applied to a copy of GF_BUILDINGS (js/gf-buildings.js), which stays
// as it is.
//
// Precedence: an OSM height tag (src 0) or building:levels (src 1) wins; else a usable LiDAR height (src 4, flown
// 2022-23); else CC-003's default rule stays (src 2, an approximation). CC-004's sourced landmarks (src 3) go on top of
// the records built from this copy, so they win over all of these.

// { data, applied }: data is a new GF_BUILDINGS-shaped object (same keys and fields, plus `lidar`) whose default-rule
// rows with a LiDAR height are copies with that height and src = lidar.srcCode; every other row is passed through
function applyLidarHeights(data, lidar) {
  const at = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  const heights = new Map(lidar.heights);
  const bySrc = { 0: 0, 1: 0, 2: 0, 4: 0 };
  let skippedOsm = 0;
  const buildings = data.buildings.map((row) => {
    const src = row[at.src];
    const h = heights.get(row[at.osm]);
    if (h !== undefined && src === 2) {
      const copy = [...row];
      copy[at.height] = h;
      copy[at.src] = lidar.srcCode;
      bySrc[lidar.srcCode] = (bySrc[lidar.srcCode] || 0) + 1;
      return copy;
    }
    if (h !== undefined) skippedOsm++;
    bySrc[src] = (bySrc[src] || 0) + 1;
    return row;
  });
  const { srcCode, srcLabel, dataset, collected, credit, sha256 } = lidar;
  return {
    data: { ...data, buildings, lidar: { srcCode, srcLabel, dataset, collected, credit, sha256 } },
    applied: { bySrc, lidar: bySrc[lidar.srcCode], skippedOsm }
  };
}

export { applyLidarHeights };
