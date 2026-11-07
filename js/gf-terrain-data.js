import { decodeTerrain, createGfTerrain } from './gf-terrain.js';
import { GF_GEO } from './gf-geodata.js';

// The Glens Falls terrain (CC-005b), loaded once: js/gf-terrain.bin.gz (tools/gf/build-gf-terrain.mjs, USGS 3DEP
// NY_Hudson_D22 2022-23) from this site, never from USGS at run time, decoded into the surface of js/gf-terrain.js.
const response = await fetch(new URL('./gf-terrain.bin.gz', import.meta.url));
if (!response.ok) throw new Error(`Terrain data request failed: ${response.status}`);
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = new Uint8Array(await response.arrayBuffer());
const bytes = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
export const GF_TERRAIN = createGfTerrain(decodeTerrain(bytes), GF_GEO.frame);
export const GF_TERRAIN_BYTES = { download: body.length, inflated: bytes.length };
