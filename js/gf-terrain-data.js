import { decodeTerrain, createGfTerrain } from './gf-terrain.js';
import { GF_GEO } from './gf-geodata.js';
import { loadingProgress } from './gf-loading-progress.js';

// The Glens Falls terrain (CC-005b), loaded once: js/gf-terrain.bin.gz (tools/gf/build-gf-terrain.mjs, USGS 3DEP
// NY_Hudson_D22 2022-23) from this site, never from USGS at run time, decoded into the surface of js/gf-terrain.js.
// CC-MOBILE-fix: the download (the longest wait on a phone) is streamed so the loading bar can show it
const progress = loadingProgress();
progress.set('terrain', 0);
const response = await fetch(new URL('./gf-terrain.bin.gz', import.meta.url));
if (!response.ok) throw new Error(`Terrain data request failed: ${response.status}`);
const MB = (n) => (n / 1048576).toFixed(1);
async function readAll(res) {
  // Content-Length counts the bytes on the wire; with a Content-Encoding the body arrives inflated, so it can't be used
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || res.headers.get('content-encoding')) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    progress.set('terrain', 0.9 * Math.min(1, got / total), `Loading terrain ${MB(got)} / ${MB(total)} MB`);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
// Servers that send .gz files as Content-Encoding: gzip hand over bytes the browser has already inflated
const body = await readAll(response);
progress.set('terrain', 0.9, 'Unpacking terrain');
const bytes = body[0] === 0x1f && body[1] === 0x8b
  ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  : body;
progress.set('terrain', 1);
export const GF_TERRAIN = createGfTerrain(decodeTerrain(bytes), GF_GEO.frame);
export const GF_TERRAIN_BYTES = { download: body.length, inflated: bytes.length };
