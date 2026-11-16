import { GF_GEO } from '../js/gf-geodata.js';
import { driveLinks } from '../js/gf-roadgraph.js';
const { nodes, links, classes } = GF_GEO.roadGraph;
const segs = [];
for (const [a, b, , cls, , , width, inner] of links) {
  if (classes[cls] === 'service') continue;
  const pts = [[nodes[a*2], nodes[a*2+1]]]; for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k+1]]); pts.push([nodes[b*2], nodes[b*2+1]]);
  for (let k = 0; k + 1 < pts.length; k++) segs.push([...pts[k], ...pts[k+1], width / 2]);
}
const G = 40, grid = new Map();
for (const s of segs) { const pad = s[4] + 3;
  for (let i = Math.floor((Math.min(s[0], s[2]) - pad) / G); i <= Math.floor((Math.max(s[0], s[2]) + pad) / G); i++)
  for (let j = Math.floor((Math.min(s[1], s[3]) - pad) / G); j <= Math.floor((Math.max(s[1], s[3]) + pad) / G); j++) { const k = i*100000+j; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(s); } }
const sd = (x, z) => { let best = Infinity; for (const s of grid.get(Math.floor(x/G)*100000+Math.floor(z/G)) || []) { const dx = s[2]-s[0], dz = s[3]-s[1], l2 = dx*dx+dz*dz; const t = l2 ? Math.max(0, Math.min(1, ((x-s[0])*dx+(z-s[1])*dz)/l2)) : 0; const d = Math.hypot(x-s[0]-dx*t, z-s[1]-dz*t) - s[4]; if (d < best) best = d; } return best; };
const vals = []; let edges = 0, stairEdges = 0, verts = 0;
for (const b of GF_GEO.blocks) {
  const r = b.curb, n = r.length / 2; verts += n;
  for (let i = 0; i < n; i++) { const j = (i+1)%n; const ax=r[i*2], az=r[i*2+1], bx=r[j*2], bz=r[j*2+1]; const L = Math.hypot(bx-ax, bz-az);
    edges++; if (L <= 1.6 && (Math.abs(bx-ax) < 0.05 || Math.abs(bz-az) < 0.05)) stairEdges++;
    for (let s = 0; s < L; s += 0.5) { const x = ax + (bx-ax)*s/L, z = az + (bz-az)*s/L; const v = sd(x, z); if (Math.abs(v) < 1.5) vals.push(v); } }
}
const abs = vals.map(Math.abs).sort((a,b)=>a-b); const p = (q) => abs[Math.floor(q*(abs.length-1))];
const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
console.log(JSON.stringify({ samples: vals.length, meanSigned: +mean.toFixed(3), absP50: +p(0.5).toFixed(3), absP90: +p(0.9).toFixed(3), absP99: +p(0.99).toFixed(3), absMax: +abs[abs.length-1].toFixed(3), over03: +(abs.filter(v=>v>0.3).length/abs.length).toFixed(3), curbVerts: verts, edges, shortAxisAlignedEdges: stairEdges }));
// candidate poses: per non-service link segment >= 50 m, the worst curb deviation within 6 m beside it
import { GF_DOWNTOWN } from '../js/gf-downtown.js';
const names = GF_GEO.roadGraph.names;
const cands = [];
for (const [a, b, nm, cls, , , width, inner] of links) {
  const c = classes[cls]; if (c === 'service') continue;
  const pts = [[nodes[a*2], nodes[a*2+1]]]; for (let k = 0; k < inner.length; k += 2) pts.push([inner[k], inner[k+1]]); pts.push([nodes[b*2], nodes[b*2+1]]);
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k+1]; const L = Math.hypot(bx-ax, bz-az); if (L < 50) continue;
    const ux = (bx-ax)/L, uz = (bz-az)/L, nx = -uz, nz = ux; const r = width/2;
    let worst = 0;
    for (const side of [1, -1]) for (let s = 10; s < L - 10; s += 1) {
      // nearest curb vertex distance along the normal: sample the signed curb offset by searching rings
      const x = ax + ux*s + nx*side*r, z = az + uz*s + nz*side*r;
      let dmin = Infinity;
      for (const bl of GF_GEO.blocks) { const rr = bl.curb; if (Math.abs(rr[0]-x) > 600 || Math.abs(rr[1]-z) > 600) continue;
        for (let i = 0; i < rr.length; i += 2) { const j = (i+2)%rr.length; const dx = rr[j]-rr[i], dz = rr[j+1]-rr[i+1], l2 = dx*dx+dz*dz; const t = l2 ? Math.max(0, Math.min(1, ((x-rr[i])*dx+(z-rr[i+1])*dz)/l2)) : 0; dmin = Math.min(dmin, Math.hypot(x-rr[i]-dx*t, z-rr[i+1]-dz*t)); } }
      if (dmin < 1.5) worst = Math.max(worst, dmin);
    }
    cands.push({ name: names[nm], cls: c, ax, az, bx, bz, L: Math.round(L), width, worst: +worst.toFixed(2), mx: Math.round((ax+bx)/2), mz: Math.round((az+bz)/2) });
  }
}
const glen = cands.filter((c) => c.name === 'Glen Street' && Math.hypot(c.mx + 192, c.mz + 167) < 400).sort((p, q) => q.worst - p.worst).slice(0, 5);
const res = cands.filter((c) => c.cls === 'residential' && Math.hypot(c.mx + 192, c.mz + 167) > 700 && Math.hypot(c.mx + 192, c.mz + 167) < 1500).sort((p, q) => q.worst - p.worst).slice(0, 5);
console.log('GLEN', JSON.stringify(glen)); console.log('RES', JSON.stringify(res));
