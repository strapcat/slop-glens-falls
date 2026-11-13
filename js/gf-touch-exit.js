// CC-MOBILE (Glens Falls only): the F action (CC-005d: get out of the taxi or a landed helicopter, and back in) on touch
// screens. A button in the touch controls' action cluster, beside Jump (and CC-NPC1's Talk), that calls the same press
// as the F key (gf-main.js pressExit, js/vehicle-exit.js unchanged). It is there in every mode: it says what F would do
// now ("Exit", "Enter", "Land"), and when F can't, it is dimmed and shows the F chip's reason (the chip itself is
// hidden on touch screens). js/touch-controls.js shows the cluster only on touch screens, so a desktop never sees it;
// New York never loads this module.

// The button's short label for vehicle-exit.js's action
const SHORT = { 'Exit taxi': 'Exit', 'Land & exit': 'Land', 'Enter taxi': 'Enter', 'Enter helicopter': 'Enter', 'Enter vehicle': 'Enter', Exit: 'Exit' };
const shortLabel = (action) => SHORT[action] || String(action || 'Exit').split(' ')[0];

// press(): the F press (returns vehicle-exit.js's result). root: the document. Returns { button, update(status) }:
// call update with vehicle-exit.js status() (or the F chip's flashed result) whenever the chip refreshes.
function installGfTouchExit({ press, root = globalThis.document }) {
  const actions = root && root.querySelector('#touch-controls .touch-actions');
  if (!actions) return { button: null, update() {} };
  const doc = root.ownerDocument || root;
  // its stylesheet (Glens Falls only; also moves the map credit off the mode buttons on touch screens)
  if (!doc.querySelector('link[data-gf-touch-exit]')) {
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'css/gf-mobile.css';
    css.setAttribute('data-gf-touch-exit', '');
    doc.head.appendChild(css);
  }
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'touch-action exit-action';
  button.setAttribute('data-touch-tap', 'exit');
  const icon = doc.createElement('span');
  icon.className = 'exit-action-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '⇄';
  const label = doc.createElement('span');
  label.className = 'exit-action-label';
  label.textContent = 'Exit';
  const reason = doc.createElement('span');
  reason.className = 'exit-action-reason';
  reason.setAttribute('aria-hidden', 'true');
  button.append(icon, label, reason);
  actions.appendChild(button);

  let pressedTimer = null;
  const fire = () => {
    button.classList.add('is-pressed');
    clearTimeout(pressedTimer);
    pressedTimer = setTimeout(() => button.classList.remove('is-pressed'), 160);
    return press();
  };
  // a tap acts at once (pointerdown, as Jump does); keyboard activation (Enter / Space on the focused button) clicks
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    fire();
  });
  button.addEventListener('click', (e) => { if (e.detail === 0) fire(); });

  let shown = '';
  function update(st) {
    if (!st) return;
    const text = st.ok ? st.action : `${st.action}: ${st.reason}`;
    if (text === shown) return;
    shown = text;
    label.textContent = shortLabel(st.action);
    reason.textContent = st.ok ? '' : st.reason;
    button.classList.toggle('is-blocked', !st.ok);
    button.setAttribute('aria-disabled', String(!st.ok));
    button.setAttribute('aria-label', text);
    button.title = text;
  }
  return { button, update };
}

export { installGfTouchExit, shortLabel };
