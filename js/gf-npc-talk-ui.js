import * as THREE from 'three/webgpu';
import { isTypingInField } from './city-runtime.js';
import { cityUniforms } from './tsl-materials.js';
import { isNight } from './gf-thrill-hill-plan.js';
import { createNpcSpeech, loadNpcLines } from './gf-npc-lines.js';
import { createNpcTalk, TALK_KEY } from './gf-npc-talk.js';

// CC-NPC1: talking to people in Glens Falls, on screen. installGfNpcTalk() is Glens Falls's one hook (gf-main.js):
// it reads Dave's line file (data/gf/npc-lines.json, gf-npc-lines.js), binds the Thrill Hill party's people to their
// special, and adds the talk prompt over the person in reach ("T Talk"; "Talk" on touch), a Talk button beside the
// touch controls' Jump (only while someone is in reach), the T key, and the speech bubble (a DOM overlay over the
// speaker's head, kept on screen inside the safe area). The rules (who, when, for how long) are gf-npc-talk.js.
//
// controllerManager: controllers.js; camera: the rendering camera; peds: the traffic's pedestrians (traffic.js peds);
// party: gf-thrill-hill.js's party or null; ground(x, z): the terrain; canStand(x, z): may a pedestrian step aside there

const THRILL_HILL = { special: 'thrill-hill-crowd', place: 'thrill-hill', radius: 30 }; // m round the fire
const EDGE = 10; // px: the bubble's margin inside the safe area

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

function installGfNpcTalk({ controllerManager, camera, peds, party = null, ground, canStand }) {
  const speech = createNpcSpeech();
  const period = () => (isNight(cityUniforms.uInteriorGlow.value) ? 'night' : 'day');
  if (party) {
    for (const p of party.schedule.people) speech.bind(p, THRILL_HILL.special);
    const { fire } = party.stats();
    speech.registerPlace(THRILL_HILL.place, { x: fire.x, z: fire.z, r: THRILL_HILL.radius });
  }
  const talk = createNpcTalk({
    sources: () => ({ peds, party: party ? party.schedule.people : null }),
    speech, period, canStand, ground
  });
  const loaded = { ok: false, warnings: [], done: false };
  loadNpcLines((url) => fetch(new URL(url, import.meta.url), { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  })).then((result) => {
    speech.setLines(result.lines);
    Object.assign(loaded, { ok: result.ok, warnings: result.warnings, done: true });
  });

  // the overlay's own stylesheet (Glens Falls only; New York never loads it)
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = new URL('../css/gf-npc-talk.css?v=cc-npc1', import.meta.url).href;
  document.head.appendChild(css);

  const layer = el('div', 'npc-layer', document.body);
  const prompt = el('div', 'npc-prompt', layer);
  prompt.hidden = true;
  const promptKey = el('kbd', '', prompt);
  promptKey.textContent = 'T';
  el('span', 'npc-prompt-label', prompt).textContent = 'Talk';
  const bubble = el('div', 'npc-bubble', layer);
  bubble.hidden = true;
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-live', 'polite');
  const bubbleName = el('div', 'npc-bubble-name', bubble);
  const bubbleText = el('div', 'npc-bubble-text', bubble);
  const bubbleMore = el('div', 'npc-bubble-more', bubble);
  el('kbd', '', bubbleMore).textContent = 'T';
  el('span', '', bubbleMore).textContent = 'next';
  // the safe area (notch, home bar) as the browser reports it, read off a probe padded with env()
  const probe = el('div', 'npc-safe-probe', layer);
  let safe = { top: 0, right: 0, bottom: 0, left: 0 };
  const readSafe = () => {
    const cs = getComputedStyle(probe);
    safe = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  };
  readSafe();
  window.addEventListener('resize', readSafe);

  // the touch button, beside Jump (the touch controls show it only on touch screens)
  const actions = document.querySelector('#touch-controls .touch-actions');
  let button = null;
  if (actions) {
    button = el('button', 'touch-action npc-talk-action', null);
    button.type = 'button';
    button.hidden = true;
    button.setAttribute('aria-label', 'Talk');
    const icon = el('span', 'npc-talk-icon', button);
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '…';
    el('span', '', button).textContent = 'Talk';
    actions.insertBefore(button, actions.firstChild);
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      button.classList.add('is-pressed');
      setTimeout(() => button.classList.remove('is-pressed'), 160);
      press();
    });
    button.addEventListener('click', (e) => { if (e.detail === 0) press(); }); // keyboard activation
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== TALK_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingInField(e)) return;
    if (controllerManager.activeMode !== 'person') return;
    press();
  });

  let last = null;
  function press() {
    last = talk.press();
    return last;
  }

  // world (x, y, z) to the page's pixels: { x, y, on } (on: in front of the camera)
  const v = new THREE.Vector3();
  function toScreen(x, y, z) {
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    v.set(x, y, z).project(camera);
    return { x: (v.x + 1) * 0.5 * window.innerWidth, y: (1 - v.y) * 0.5 * window.innerHeight, on: v.z < 1 && v.z > -1 };
  }

  let shownText = null, bubbleW = 0, bubbleH = 0;
  function placeBubble(t) {
    if (shownText !== `${t.speaker}\n${t.text}`) {
      shownText = `${t.speaker}\n${t.text}`;
      bubbleName.textContent = t.speaker || '';
      bubbleName.hidden = !t.speaker;
      bubbleText.textContent = t.text;
      bubble.hidden = false;
      bubbleW = bubble.offsetWidth;
      bubbleH = bubble.offsetHeight;
    }
    const s = toScreen(t.x, t.y + 0.08, t.z);
    const W = window.innerWidth, H = window.innerHeight;
    const minX = safe.left + EDGE, maxX = W - safe.right - EDGE - bubbleW;
    const minY = safe.top + EDGE, maxY = H - safe.bottom - EDGE - bubbleH;
    let left, top, tail = true;
    if (s.on) {
      left = s.x - bubbleW / 2;
      top = s.y - bubbleH - 9;
    } else {
      // behind the camera: over the middle of the screen's upper part, without the tail
      left = (W - bubbleW) / 2;
      top = H * 0.22;
      tail = false;
    }
    left = Math.max(minX, Math.min(maxX, left));
    top = Math.max(minY, Math.min(maxY, top));
    // the tail points at the speaker as far as the bubble's corners allow
    const tailX = Math.max(18, Math.min(bubbleW - 18, s.x - left));
    tail = tail && s.y > top + bubbleH - 4;
    bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    bubble.style.setProperty('--tail-x', `${Math.round(tailX)}px`);
    bubble.classList.toggle('no-tail', !tail);
  }

  function update(dt, elapsed) {
    const mode = controllerManager.activeMode;
    talk.update(dt, elapsed, mode, controllerManager.getActiveEntity());
    const t = talk.talk();
    const target = talk.target();
    if (t) placeBubble(t);
    else if (!bubble.hidden) { bubble.hidden = true; shownText = null; }
    // the prompt over whoever is in reach, unless they are already talking (the bubble says "T next")
    const showPrompt = !!target && !(t && t.npc === target.npc);
    if (showPrompt) {
      const s = toScreen(target.x, target.y + 0.12, target.z);
      if (s.on) {
        prompt.hidden = false;
        prompt.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -100%)`;
      } else prompt.hidden = true;
    } else if (!prompt.hidden) prompt.hidden = true;
    if (button && button.hidden !== !target) button.hidden = !target;
  }

  const api = {
    update,
    press,
    target: () => talk.target(),
    talk: () => talk.talk(),
    stats: talk.stats,
    lines: loaded,
    speech,
    get last() { return last; }
  };
  if (globalThis.slopGlensFalls) globalThis.slopGlensFalls.npcTalk = api;
  return api;
}

export { installGfNpcTalk, THRILL_HILL };
