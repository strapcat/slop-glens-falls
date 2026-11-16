// CC-MINIMAP-fix (Glens Falls only): the map credit as a compact label that opens to the full credit. Collapsed, one
// short line, "© OSM · USGS"; a tap / click (or Enter / Space: it is a button) opens the full text above it: the link
// to OpenStreetMap's copyright page (ODbL) and the USGS LiDAR line. A second tap, a tap anywhere else, or Esc closes
// it. Where it sits: css/gf-credit.css (desktop: just above the radar card, placed by gf-minimap.js's
// placeCreditAbove) and css/gf-mobile.css (touch screens: beside the joystick, just above the mode bar; the full text
// opens in the free space above the stick). The outside-tap listener is passive and never cancels the touch, so the
// stick and the buttons keep every touch. New York never loads this.

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const SHORT_LABEL = '© OSM · USGS';

// doc: the document; lidar: the USGS LiDAR credit line (GF_LIDAR_HEIGHTS.credit). Returns { element, open(), close(),
// toggle(), isOpen }. The caller appends element to the page.
function createGfCredit(doc = globalThis.document, { lidar = '' } = {}) {
  const win = doc.defaultView || globalThis;
  if (doc.head && !doc.querySelector('link[data-gf-credit]')) {
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'css/gf-credit.css';
    css.setAttribute('data-gf-credit', '');
    doc.head.appendChild(css);
  }
  const credit = doc.createElement('div');
  credit.id = 'gf-attribution';
  credit.className = 'gf-credit';
  // the full credit: the legally required text, shown when open
  const full = doc.createElement('div');
  full.id = 'gf-credit-full';
  full.className = 'gf-credit-full';
  full.hidden = true;
  const link = doc.createElement('a');
  link.href = OSM_COPYRIGHT;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'OpenStreetMap contributors';
  full.append('Map data © ', link, ' (ODbL)', doc.createElement('br'), lidar);
  // the label: always on screen
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'gf-credit-toggle';
  toggle.textContent = SHORT_LABEL;
  toggle.title = 'Map data © OpenStreetMap contributors (ODbL); building heights and trees: USGS 3DEP LiDAR';
  toggle.setAttribute('aria-label', 'Map credits: OpenStreetMap contributors (ODbL) and USGS LiDAR');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'gf-credit-full');
  credit.append(full, toggle);

  let open = false;
  const setOpen = (on) => {
    open = !!on;
    full.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    credit.classList.toggle('is-open', open);
    return open;
  };
  toggle.addEventListener('click', () => setOpen(!open));
  // a tap or click anywhere else closes it (passive: the touch still goes where it was going)
  doc.addEventListener('pointerdown', (e) => {
    if (open && !(e.target && typeof credit.contains === 'function' && credit.contains(e.target))) setOpen(false);
  }, { capture: true, passive: true });
  win.addEventListener('keydown', (e) => {
    if (open && e.code === 'Escape') setOpen(false);
  });
  return {
    element: credit,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    get isOpen() { return open; }
  };
}

export { createGfCredit, OSM_COPYRIGHT, SHORT_LABEL };
