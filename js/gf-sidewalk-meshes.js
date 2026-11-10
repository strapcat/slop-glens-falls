import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, color, attribute, positionWorld, normalWorldGeometry, cameraPosition, floor, fract, sin, dot, mix,
  smoothstep, abs, max, min, length, fwidth
} from 'three/tsl';
import { SIDEWALK } from './gf-sidewalks.js';
import { createSidewalkStrips } from './gf-sidewalk-strips.js';

// CC-005e: Glens Falls's curbs, tree lawns and walks as meshes: the strips of gf-sidewalk-strips.js (the layout and its
// sources: gf-sidewalks.js) in four materials, granite, concrete (walk flags, driveway aprons), grass (lawns, ramps) and
// the gutter's asphalt. The strips are cut into CELL-metre cells, each built the first time the camera comes within
// RANGE of it and shown only while it is (beyond that the terrain's own colours, gf-ground.js, show the bands): about
// one draw call per material per cell in range.

const CELL = 250;
const RANGE = 650; // m from the camera to a cell's nearest point
// TSL helpers (as tsl-materials.js's, which it does not export)
const hash2D = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const noise2D = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  return mix(mix(hash2D(i), hash2D(i.add(vec2(1, 0))), u.x), mix(hash2D(i.add(vec2(0, 1))), hash2D(i.add(vec2(1, 1))), u.x), u.y);
});
// a repeating anti-aliased line across coord every period, halfWidth wide
const gridLine = Fn(([coord, period, halfWidth]) => {
  const g = float(coord).div(period).toVar();
  const d = float(0.5).sub(abs(fract(g).sub(0.5))).toVar();
  const aa = fwidth(g).max(0.0001).toVar();
  const hw = float(halfWidth).div(period).toVar();
  const eff = max(hw, aa.mul(0.5)).toVar();
  return smoothstep(eff.add(aa), eff.sub(aa), d).mul(min(float(1.0), hw.div(eff)));
});

// Poured concrete in flags: tone, stains and grit in world space; the tooled joints across the walk every FLAG metres
// of its length (attribute `along`, the lot line's arc length) where `joint` is 1; tinted by the vertex colour
function concreteMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.9 });
  const along = attribute('along', 'float');
  const joint = attribute('joint', 'float');
  const tint = attribute('color', 'vec3');
  mat.colorNode = Fn(() => {
    const wxz = positionWorld.xz;
    const detail = smoothstep(160.0, 14.0, length(positionWorld.sub(cameraPosition)));
    const flag = floor(along.div(SIDEWALK.flag));
    const flagTone = hash2D(vec2(flag, floor(wxz.x.mul(0.01)))).sub(0.5).mul(0.12).add(1.0);
    const tone = noise2D(wxz.mul(0.45));
    const stain = smoothstep(0.55, 0.9, noise2D(wxz.mul(0.9).add(17.0))).mul(0.14);
    const grit = noise2D(wxz.mul(14.0)).sub(0.5).mul(0.07).mul(detail);
    const base = mix(color(0x8f8a80), color(0xaba69c), tone).mul(flagTone).mul(float(1.0).sub(stain)).add(grit);
    const joints = gridLine(along, SIDEWALK.flag, 0.004).mul(joint).mul(detail);
    return base.mul(float(1.0).sub(joints.mul(0.55))).mul(tint);
  })();
  return mat;
}

// Granite curbstone: grey speckled stone (dark mica and pale feldspar flecks), stones FLAG-ish long (attribute
// `along`: the curb ring's arc length), the road face darker with grime
function graniteMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.04, roughness: 0.7 });
  const along = attribute('along', 'float');
  mat.colorNode = Fn(() => {
    const wp = positionWorld;
    const detail = smoothstep(120.0, 10.0, length(wp.sub(cameraPosition)));
    const tone = noise2D(vec2(wp.x.add(wp.y), wp.z).mul(0.7));
    const fleck = hash2D(floor(vec3(wp.x, wp.y, wp.z).xz.mul(90.0)).add(floor(wp.y.mul(90.0))));
    const dark = smoothstep(0.82, 0.95, fleck).mul(0.2).mul(detail);
    const pale = smoothstep(0.1, 0.02, fleck).mul(0.1).mul(detail);
    const stone = mix(color(0x8c8d88), color(0xa4a59f), tone).mul(float(1.0).sub(dark)).add(vec3(pale));
    const joints = gridLine(along, 1.83, 0.006).mul(detail);
    const top = smoothstep(0.5, 0.85, normalWorldGeometry.y);
    return mix(stone.mul(0.82), stone, top).mul(float(1.0).sub(joints.mul(0.45)));
  })();
  return mat;
}

// Mown grass (a tree lawn, the ramps), tinted by the vertex colour (a downtown ramp's paving: no grass)
function lawnMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.92 });
  const tint = attribute('color', 'vec3');
  const grass = attribute('grass', 'float');
  mat.colorNode = Fn(() => {
    const wp = positionWorld.xz;
    const patch = noise2D(wp.mul(0.08));
    const clover = noise2D(wp.mul(0.5));
    const blade = noise2D(wp.mul(4.0));
    const lawn = mix(mix(color(0x2f5526), color(0x46702f), patch.mul(0.55).add(clover.mul(0.45))), color(0x66903c), blade.mul(0.3));
    return mix(vec3(1.0), lawn, grass).mul(tint);
  })();
  return mat;
}

function createGfSidewalkMeshes(scene, sidewalks) {
  const ground = sidewalks.ground;
  const group = new THREE.Group();
  group.name = 'GlensFallsSidewalks';
  scene.add(group);
  const materials = {
    granite: graniteMaterial(),
    concrete: concreteMaterial(),
    lawn: lawnMaterial(),
    gutter: new THREE.MeshStandardMaterial({ color: 0x34363a, roughness: 0.85, metalness: 0 })
  };
  for (const m of Object.values(materials)) m.side = THREE.DoubleSide;
  const strips = createSidewalkStrips(sidewalks, CELL);
  const stats = { cells: strips.cells.size, built: 0, triangles: 0, visible: 0, drawCalls: 0, buildMs: 0 };

  function buildCell(cell) {
    const t0 = performance.now();
    const meshes = [];
    for (const [name, B] of Object.entries(strips.build(cell.segs))) {
      if (!B.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
      g.setAttribute('along', new THREE.Float32BufferAttribute(B.along, 1));
      g.setAttribute('joint', new THREE.Float32BufferAttribute(B.joint, 1));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
      g.setAttribute('grass', new THREE.Float32BufferAttribute(B.grass, 1));
      g.setIndex(B.idx);
      g.computeVertexNormals();
      // lit as the ground it lies on whichever way it winds (the curb's face keeps its own, level normal)
      const nrm = g.attributes.normal;
      for (let v = 0; v < nrm.count; v++) if (nrm.getY(v) < -0.2) nrm.setXYZ(v, -nrm.getX(v), -nrm.getY(v), -nrm.getZ(v));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, materials[name === 'ramp' ? 'lawn' : name]);
      m.name = `Sidewalk-${name}`;
      m.receiveShadow = true;
      m.castShadow = name === 'granite';
      group.add(m);
      meshes.push(m);
      stats.triangles += B.idx.length / 3;
    }
    stats.built++;
    stats.buildMs += performance.now() - t0;
    return meshes;
  }

  // Build and show the cells within RANGE of the camera at (x, y, z); hide the rest
  function update(camera) {
    let visible = 0, draws = 0;
    for (const cell of strips.cells.values()) {
      const nx = Math.max(cell.i * CELL, Math.min(camera.x, (cell.i + 1) * CELL));
      const nz = Math.max(cell.j * CELL, Math.min(camera.z, (cell.j + 1) * CELL));
      const g = ground(nx, nz);
      const near = Math.hypot(camera.x - nx, camera.z - nz, Math.max(0, camera.y - (Number.isFinite(g) ? g : 0))) < RANGE;
      if (near && !cell.meshes) cell.meshes = buildCell(cell);
      if (cell.meshes) for (const m of cell.meshes) m.visible = near;
      if (near) { visible++; draws += cell.meshes.length; }
    }
    stats.visible = visible;
    stats.drawCalls = draws;
    return visible;
  }

  return { group, update, materials, stats, strips, CELL, RANGE };
}

export { createGfSidewalkMeshes, CELL, RANGE };
