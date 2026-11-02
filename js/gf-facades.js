// Glens Falls facade tones, shared by the buildings (gf-building-meshes.js, through the pre-war masonry shader) and the
// landmark shapes (gf-landmark-meshes.js, which take their stone and trim colours). brick and stone take New York's
// two masonry presets' colours; clapboard is a light painted tone for houses.
const FACADES = {
  brick: { stoneColor: 0xa45a45, trimColor: 0xcab9a0, windowGlassColor: 0x16222e, windowWidth: 2.4, litProbability: 0.56, warmth: 0.86, seed: 27.8 },
  stone: { stoneColor: 0xd8cdb8, trimColor: 0x9e937f, windowGlassColor: 0x1a2836, windowWidth: 2.6, litProbability: 0.54, warmth: 0.80, seed: 12.4 },
  clapboard: { stoneColor: 0xd6d0c2, trimColor: 0x5e5a52, windowGlassColor: 0x1a2430, windowWidth: 2.2, litProbability: 0.4, warmth: 0.85, seed: 51.3 }
};

export { FACADES };
