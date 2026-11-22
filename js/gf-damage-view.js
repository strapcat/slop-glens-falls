import * as THREE from 'three/webgpu';

// CC-BUCKLEY (Glens Falls only): what the player sees of vehicle damage and the Buckley Tire repair
// (gf-vehicle-damage.js keeps the numbers):
//   the damage chip  a wrench, a bar and a percent in the speed panel (desktop); on touch screens under the radar in the
//                    top-left corner (css/gf-mobile.css), shown only in the taxi or on the bike
//   the toast        the hint ("Your car's banged up..."), "Fixing..." with a progress bar, and "All set." near the top
//                    of the screen, clear of the touch controls; it fades
//   the smoke        light grey puffs from the hood above 50 damage, heavier and darker above 80: one instanced mesh of
//                    camera-facing quads (one draw call), its texture a soft dot drawn on a canvas here
//   the radar        a wrench marker on Buckley Tire while a vehicle is banged up (gf-minimap.js setMarker)
// No new controls: the radar's own tap / M opens the map.

const SMOKE = { pool: 48, light: { rate: 5, life: 1.7, grey: 0.78, size: [0.5, 1.7] }, heavy: { rate: 13, life: 2.3, grey: 0.36, size: [0.7, 2.4] }, rise: 1.3 };
const WRENCH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.7 19.3 13.6 10.2c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6.3 6.3 9 1.9 4.7C.8 7.1 1.2 10.1 3.2 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.1-2.1c.4-.4.4-1 0-1.3z"/></svg>';

function softDot(doc) {
  const c = doc.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// scene: where the smoke goes (its root is returned, for gf-main.js's dynamic roots); camera: for the billboards;
// damage, mission: gf-vehicle-damage.js; entities: controllerManager.entities; radar: gf-minimap.js (or null);
// zone: Buckley's repair spot { x, z }
function installGfDamageView({ doc = globalThis.document, scene, camera, damage, entities, radar = null, zone = null }) {
  if (!doc.querySelector('link[data-gf-damage]')) {
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'css/gf-damage.css';
    css.setAttribute('data-gf-damage', '');
    doc.head.appendChild(css);
  }
  // the damage chip, in the speed panel
  const chip = doc.createElement('div');
  chip.id = 'gf-damage';
  chip.className = 'gf-damage';
  chip.hidden = true;
  chip.setAttribute('role', 'status');
  chip.innerHTML = `<span class="gf-damage-icon">${WRENCH_SVG}</span><span class="gf-damage-label">Damage</span>`
    + '<span class="gf-damage-bar"><span class="gf-damage-fill"></span></span><span class="gf-damage-pct">0%</span>';
  const cluster = doc.querySelector('.hud-bottom-right .cluster') || doc.body;
  const cameraSwitch = cluster.querySelector && cluster.querySelector('#camera-switch');
  // On touch screens the chip lives on <body> (css/gf-mobile.css pins it under the radar): the panel's backdrop blur
  // would otherwise be the box its fixed position is measured from. Checked every frame, as touch can switch on later.
  const placeChip = () => {
    const touch = !!doc.body.classList && doc.body.classList.contains('touch-enabled');
    const home = touch ? doc.body : cluster;
    if (chip.parentNode === home) return;
    if (!touch && cameraSwitch) cluster.insertBefore(chip, cameraSwitch);
    else home.appendChild(chip);
  };
  placeChip();
  const fill = chip.querySelector('.gf-damage-fill');
  const pct = chip.querySelector('.gf-damage-pct');

  // the toast
  const toast = doc.createElement('div');
  toast.id = 'gf-mission';
  toast.className = 'gf-mission';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = '<span class="gf-mission-icon">' + WRENCH_SVG + '</span><span class="gf-mission-text"></span>'
    + '<span class="gf-mission-progress" hidden><span class="gf-mission-progress-fill"></span></span>';
  doc.body.appendChild(toast);
  const toastText = toast.querySelector('.gf-mission-text');
  const bar = toast.querySelector('.gf-mission-progress');
  const barFill = toast.querySelector('.gf-mission-progress-fill');

  // the smoke
  const root = new THREE.Group();
  root.name = 'GlensFallsVehicleSmoke';
  const material = new THREE.MeshBasicMaterial({ map: softDot(doc), transparent: true, opacity: 0.42, depthWrite: false, color: 0xffffff });
  const smoke = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, SMOKE.pool);
  smoke.frustumCulled = false;
  smoke.count = 0;
  smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  smoke.setColorAt(0, new THREE.Color(1, 1, 1));
  root.add(smoke);
  scene.add(root);
  const puffs = [];
  const emitAcc = new Map();
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
  let clock = 0;
  let last = { shown: null, text: null, progress: null, damage: -1, marker: null };

  function emit(entity, level) {
    if (puffs.length >= SMOKE.pool) puffs.shift();
    const h = entity.heading || 0, fx = Math.sin(h), fz = Math.cos(h);
    const bike = entity.type === 'cyclist' || entity === entities.cyclist;
    const ahead = bike ? 0.5 : 1.55, up = bike ? 0.9 : 1.05;
    const p = entity.position;
    puffs.push({ x: p.x + fx * ahead + (Math.random() - 0.5) * 0.3, y: p.y + up, z: p.z + fz * ahead + (Math.random() - 0.5) * 0.3,
      vx: (Math.random() - 0.5) * 0.4, vz: (Math.random() - 0.5) * 0.4, age: 0, ...SMOKE[level] });
  }

  return {
    root,
    chip,
    toast,
    // view: createRepairMission().update(...); mode: the active mode
    update(dt, mode, view) {
      clock += dt;
      placeChip();
      // the chip: in the taxi or on the bike
      const inVehicle = damage.D.modes.includes(mode);
      const d = inVehicle ? damage.damage(mode) : 0;
      if (chip.hidden === inVehicle) chip.hidden = !inVehicle;
      if (inVehicle && Math.round(d) !== last.damage) {
        last.damage = Math.round(d);
        fill.style.transform = `scaleX(${Math.max(0, Math.min(1, d / 100))})`;
        pct.textContent = `${last.damage}%`;
        chip.dataset.level = d >= 100 ? 'wrecked' : d > damage.D.smokeHeavy ? 'heavy' : d > damage.D.smokeLight ? 'light' : d > 0 ? 'scratched' : 'ok';
      }
      // the toast: fixing (with progress) > a message > the hint
      const text = view.fixingText || view.message || view.hint || null;
      if (text !== last.text) {
        last.text = text;
        if (text) toastText.textContent = text;
        toast.classList.toggle('is-shown', !!text);
        toast.dataset.kind = view.fixingText ? 'fixing' : view.message ? 'message' : view.hint ? 'hint' : '';
      }
      const showBar = view.progress !== null;
      if (bar.hidden === showBar) bar.hidden = !showBar;
      if (showBar && view.progress !== last.progress) {
        last.progress = view.progress;
        barFill.style.transform = `scaleX(${view.progress})`;
      }
      // the radar's wrench
      if (radar && zone && view.marker !== last.marker) {
        last.marker = view.marker;
        if (view.marker) radar.setMarker('buckley-tire', { x: zone.x, z: zone.z, color: '#f5b62a', icon: 'wrench' });
        else radar.removeMarker('buckley-tire');
      }
      // the smoke: emit from every smoking vehicle, age the puffs, face them to the camera
      for (const m of damage.D.modes) {
        const level = damage.smoke(m);
        const e = entities[m];
        if (level === 'none' || !e || !e.position) { emitAcc.set(m, 0); continue; }
        let acc = (emitAcc.get(m) || 0) + dt * SMOKE[level].rate;
        while (acc >= 1) { emit(e, level); acc -= 1; }
        emitAcc.set(m, acc);
      }
      let n = 0;
      for (let i = 0; i < puffs.length; i++) {
        const p = puffs[i];
        p.age += dt;
        if (p.age >= p.life) continue;
        p.x += p.vx * dt; p.z += p.vz * dt; p.y += SMOKE.rise * dt;
        const f = p.age / p.life;
        const s = (p.size[0] + (p.size[1] - p.size[0]) * f) * (f > 0.75 ? (1 - f) / 0.25 : 1);
        pos.set(p.x, p.y, p.z);
        scl.set(s, s, s);
        m4.compose(pos, camera.quaternion, scl);
        smoke.setMatrixAt(n, m4);
        col.setScalar(p.grey + f * 0.15);
        smoke.setColorAt(n, col);
        puffs[n++] = p;
      }
      puffs.length = n;
      smoke.count = n;
      if (n) {
        smoke.instanceMatrix.needsUpdate = true;
        if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;
      }
    },
    stats: () => ({ puffs: puffs.length, chip: !chip.hidden, toast: last.text, marker: last.marker })
  };
}

export { installGfDamageView, SMOKE };
