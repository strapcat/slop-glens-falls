// CC-MOBILE-fix (Glens Falls only): on iPhone Safari, holding the joystick brought up the copy / paste callout and the
// text magnifier, and a quick second tap zoomed the page. css/gf-mobile.css turns off selection, callouts and
// double-tap zoom under body.touch-enabled; Safari does not always honour that on a held touch, so this also cancels,
// on touch screens only:
//   touchstart on the joystick and the touch action buttons (the pointer events the controls use still arrive: iOS
//   sends pointerdown before touchstart, and touch-controls.js / gf-touch-exit.js act on pointerdown),
//   selectstart and contextmenu anywhere but a link or a text field (the map credit's OSM link stays a link),
//   dblclick (double-tap zoom on older iOS) outside text fields.
// Desktop (no body.touch-enabled) is untouched: every handler checks the class first. New York never loads this.

const HELD = '#touch-stick, #touch-stick-knob, #touch-controls .touch-action';
const KEEP = 'a, input, textarea, select, [contenteditable="true"]';

const touchOn = (doc) => !!doc.body && doc.body.classList.contains('touch-enabled');
const closest = (target, selector) => (target && typeof target.closest === 'function' ? target.closest(selector) : null);

// doc: the document. Returns { remove() } (tests), and the handlers it installed.
function installGfTouchGuards(doc = globalThis.document) {
  if (!doc || typeof doc.addEventListener !== 'function') return { remove() {}, handlers: {} };
  const handlers = {
    touchstart: (e) => { if (touchOn(doc) && closest(e.target, HELD)) e.preventDefault(); },
    selectstart: (e) => { if (touchOn(doc) && !closest(e.target, KEEP)) e.preventDefault(); },
    contextmenu: (e) => { if (touchOn(doc) && !closest(e.target, KEEP)) e.preventDefault(); },
    dblclick: (e) => { if (touchOn(doc) && !closest(e.target, KEEP)) e.preventDefault(); }
  };
  // touchstart must not be passive, or preventDefault is ignored
  const options = { touchstart: { passive: false, capture: true }, selectstart: { capture: true }, contextmenu: { capture: true }, dblclick: { capture: true } };
  for (const [type, fn] of Object.entries(handlers)) doc.addEventListener(type, fn, options[type]);
  return {
    handlers,
    remove() { for (const [type, fn] of Object.entries(handlers)) doc.removeEventListener(type, fn, options[type]); }
  };
}

export { installGfTouchGuards, HELD, KEEP };
