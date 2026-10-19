'use strict';

/* ---- 217-shelf3d-view.js: 3D Shelf tab integration (v405) ----
   Integrates the Three.js 3D shelf (js/215-shelf3d.js) into the real Shelf
   tab as an alternative to the 2.5D view (js/205-shelfview.js).

   - View mode persists per device in localStorage ('shelfViewMode').
   - 3D books come from the real library via shelfBooks() + shelfSpineSpec().
   - Tapping a 3D book opens the book modal (openDetail).
   - TBR/Reading/Read chips update the 3D scene via Shelf3D.setBooks().
   - WebGL unavailable (or THREE load failure) falls back to the 2.5D view.
   - Decorations in 3D persist per bookcase (the 2.5D decor system is separate).
   - The room: a group with more than SHELF3D_MAX_BOOKS books continues onto
     further bookcases. Each case holds up to 60 books and keeps its own
     decorations; since v514 decorations displace books, case boundaries are
     computed by simulating the engine's packer (see shelf3dSliceRoom). A
     case bar pages between cases, "Find" jumps to a book, "Arrange"
     changes how the room is ordered (view only: the saved shelf order is
     untouched). */

export const SHELF3D_MAX_BOOKS = 60;   // books per bookcase
export const SHELF3D_ARRANGE_KEY = 'cozylibram.s3d.arrange';
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */

export const SHELF3D_ARRANGE_MODES = [
  ['mine', 'As I placed them'], ['title', 'Title'], ['author', 'Author'], ['series', 'Series'],
  ['colour', 'Colour (a rainbow shelf)']
];
export const SHELF3D_SPINES_KEY = 'cozylibram.s3d.spines';   // 'cover' (default) | 'classic'
export let _shelf3dPaintBusy = false, _shelf3dPaintTimer = null;

export function shelf3dSpinesMode() {
  try { return localStorage.getItem(SHELF3D_SPINES_KEY) === 'classic' ? 'classic' : 'cover'; }
  catch (e) { return 'cover'; }
}
export function shelf3dSetSpinesMode(m) {
  try { localStorage.setItem(SHELF3D_SPINES_KEY, m === 'classic' ? 'classic' : 'cover'); } catch (e) {}
}
// Cover colour for a book, or null (no cover, not read yet, or cover changed since).
export function shelf3dCoverHex(b) {
  try {
    if (typeof spineColorCache === 'undefined' || !b || !b.cover) return null;
    const c = spineColorCache[b.id];
    return (c && c.cover === b.cover && /^#[0-9a-f]{6}$/i.test(c.hex || '')) ? c.hex : null;
  } catch (e) { return null; }
}
export function _s3dRgb(hex) {
  return [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); });
}
export function _s3dHex(rgb) {
  return '#' + rgb.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join('');
}
// Keep spine titles readable: pull very light covers down to a mid-dark tone.
export function shelf3dSpineTone(hex) {
  const rgb = _s3dRgb(hex);
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  const k = lum > 0.42 ? 0.42 / lum : 1;
  return _s3dHex(rgb.map(function (v) { return v * k; }));
}
// Accent band colour: a soft light tint of the spine colour.
export function shelf3dSpineAccent(hex) {
  return _s3dHex(_s3dRgb(hex).map(function (v) { return v + (255 - v) * 0.62; }));
}
export function shelf3dHue(hex) {
  const c = _s3dRgb(hex).map(function (v) { return v / 255; });
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]), d = mx - mn;
  if (d < 0.04) return -1;   // greys/blacks gather at the start
  let h = mx === c[0] ? ((c[1] - c[2]) / d) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  h *= 60; return h < 0 ? h + 360 : h;
}
// The colour a book's spine will show in the room.
export function shelf3dSpineColors(b) {
  const spec = (typeof shelfSpineSpec === 'function')
    ? shelfSpineSpec(b) : { c1: '#5e1f2e', c2: '#380f1e' };
  const hex = shelf3dSpinesMode() === 'cover' ? shelf3dCoverHex(b) : null;
  if (!hex) return { c1: spec.c1, c2: spec.c2, fromCover: false };
  const c1 = shelf3dSpineTone(hex);
  return { c1: c1, c2: shelf3dSpineAccent(c1), fromCover: true };
}
export let _shelf3dCaseIdx = { tbr: 0, reading: 0, read: 0 };
export let _shelf3dKeysWired = false;

export function shelf3dArrangeMode() {
  try {
    const m = localStorage.getItem(SHELF3D_ARRANGE_KEY);
    if (SHELF3D_ARRANGE_MODES.some(function (x) { return x[0] === m; })) return m;
  } catch (e) {}
  return 'mine';
}
export function shelf3dSetArrangeMode(m) {
  try { localStorage.setItem(SHELF3D_ARRANGE_KEY, m); } catch (e) {}
}
export function _s3dSortKey(str) {
  return String(str || '').toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
}
export function _s3dAuthor(b) {
  if (b.authors && b.authors.length) return String(b.authors[0] || '');
  return String(b.author || '');
}
// Re-order a list of books for the room. Never mutates the input.
export function shelf3dArrange(books, mode) {
  const list = (books || []).slice();
  const cmp = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
  if (mode === 'title') {
    list.sort(function (a, b) { return cmp(_s3dSortKey(a.title), _s3dSortKey(b.title)); });
  } else if (mode === 'author') {
    list.sort(function (a, b) {
      return cmp(_s3dAuthor(a).toLowerCase(), _s3dAuthor(b).toLowerCase()) ||
        cmp(_s3dSortKey(a.title), _s3dSortKey(b.title));
    });
  } else if (mode === 'colour') {
    const hue = function (b) {
      const h = shelf3dHue(shelf3dSpineColors(b).c1);
      return h < 0 ? -1 : h;
    };
    list.sort(function (a, b) { return (hue(a) - hue(b)) || cmp(_s3dSortKey(a.title), _s3dSortKey(b.title)); });
  } else if (mode === 'series') {
    list.sort(function (a, b) {
      const sa = a.series && a.series.name ? String(a.series.name).toLowerCase() : '';
      const sb = b.series && b.series.name ? String(b.series.name).toLowerCase() : '';
      if (sa && !sb) return -1;
      if (!sa && sb) return 1;
      if (sa !== sb) return cmp(sa, sb);
      const pa = Number(a.series && a.series.position) || 0;
      const pb = Number(b.series && b.series.position) || 0;
      return (pa - pb) || cmp(_s3dSortKey(a.title), _s3dSortKey(b.title));
    });
  }
  return list;
}
// Split a list into bookcases of `size` books. Always returns at least one (empty) case.
export function shelf3dCases(books, size) {
  const n = Math.max(1, size || SHELF3D_MAX_BOOKS);
  const out = [];
  for (let i = 0; i < (books || []).length; i += n) out.push(books.slice(i, i + n));
  if (!out.length) out.push([]);
  return out;
}
export function shelf3dCaseKey(group, idx) { return group + ':' + idx; }
/* v514: decorations displace books, so cases no longer hold a fixed count.
   The saved per-case decoration layouts (the engine's v2 doc) become
   per-level obstacle intervals, and the room is sliced by simulating the
   engine's own packer (Shelf3D.packCase) case by case: books fill each
   case around its decorations and overflow into the next. A case that
   holds decorations but no books still exists (decorations stay anchored
   to their bookcase even when every book has flowed elsewhere). */
export function shelf3dDecoDoc() {
  try {
    const d = JSON.parse(localStorage.getItem('cozylibram.s3d.deco.v2') || 'null');
    if (d && d.v === 2 && d.cases && typeof d.cases === 'object') return d;
  } catch (e) {}
  return { v: 2, cases: {} };
}
export function shelf3dCaseObstacles(group, idx, doc) {
  const obs = { 0: [], 1: [], 2: [] };
  const fp = (typeof Shelf3D !== 'undefined' && Shelf3D && typeof Shelf3D.decoFootprint === 'function')
    ? Shelf3D.decoFootprint : null;
  if (!fp) return obs;
  ((doc && doc.cases[shelf3dCaseKey(group, idx)]) || []).forEach(function (d) {
    if (!d || d.room || typeof d.pi !== 'number' || typeof d.x !== 'number' || !obs[d.pi]) return;
    const fw = fp(d.type);
    if (fw > 0) obs[d.pi].push([d.x - fw / 2, d.x + fw / 2]);
  });
  return obs;
}
export function shelf3dSliceRoom(all, group) {
  const pack = (typeof Shelf3D !== 'undefined' && Shelf3D && typeof Shelf3D.packCase === 'function')
    ? Shelf3D.packCase : null;
  if (!pack) return shelf3dCases(all, SHELF3D_MAX_BOOKS);   // engine script absent: legacy chunking
  const doc = shelf3dDecoDoc();
  let minCases = 1;
  Object.keys(doc.cases).forEach(function (k) {
    const parts = k.split(':');
    if (parts[0] !== group) return;
    if (((doc.cases[k]) || []).some(function (d) { return d && !d.room; })) {
      minCases = Math.max(minCases, (parseInt(parts[1], 10) || 0) + 1);
    }
  });
  const specs = shelfBooks3D(all);
  const cases = [];
  let i = 0, ci = 0;
  while (i < all.length || ci < minCases) {
    const res = pack(specs.slice(i, i + SHELF3D_MAX_BOOKS), shelf3dCaseObstacles(group, ci, doc), SHELF3D_MAX_BOOKS);
    cases.push(all.slice(i, i + res.placed.length));
    i += res.placed.length;
    ci++;
    if (ci > 500) break;   // sanity bound on pathological saved layouts
  }
  if (!cases.length) cases.push([]);
  return cases;
}
// Which case (0-based) holds the book at position `idx` in room.all.
export function shelf3dCaseOf(room, idx) {
  if (!room || !room.starts) return Math.floor(idx / SHELF3D_MAX_BOOKS);
  let c = 0;
  for (let k = 0; k < room.starts.length; k++) { if (room.starts[k] <= idx) c = k; }
  return c;
}
// The engine's book list for a case: the case's own books plus the next
// case's — the engine lays out what fits and keeps the rest as the
// reservoir a decoration removal can pull books in from.
export function shelf3dCaseBooks(room, i) {
  return shelfBooks3D((room.cases[i] || []).concat(room.cases[i + 1] || []));
}
// The arranged books for the current group, split into cases.
export function shelf3dRoom() {
  const all = shelf3dArrange((typeof shelfBooks === 'function') ? shelfBooks() : [], shelf3dArrangeMode());
  const cases = shelf3dSliceRoom(all, shelfGroup);
  const starts = [];
  let acc = 0;
  cases.forEach(function (c) { starts.push(acc); acc += c.length; });
  return { all: all, cases: cases, starts: starts };
}
/* v514: a decoration was placed, moved, or removed in the engine — case
   boundaries may have shifted. Refresh the case bar and the neighbour
   previews; the engine reflows the visible case's books itself. */
export function shelf3dOnDecoChange() {
  try {
    if (!_shelf3dMounted) return;
    const room = shelf3dRoom();
    const i = Math.min(_shelf3dCaseIdx[shelfGroup] || 0, room.cases.length - 1);
    _shelf3dCaseIdx[shelfGroup] = i;
    if (typeof Shelf3D !== 'undefined' && Shelf3D && typeof Shelf3D.setNeighbours === 'function') {
      Shelf3D.setNeighbours(shelf3dNeighbours(room, i));
    }
    shelf3dUpdateBar();
  } catch (e) {}
}

// Local mount-state tracking (robust even if the engine's `mounted` flag
// is missing or the engine is still loading).
export let _shelf3dMounted = false;
// v408: session flag for WebGL failure — don't persist '2d', just skip 3D this session.
export let _shelf3dWebGLFailed = false;
// v427: guard for the document-level menu-close listener (added once, not per render).
export let _shelf3dMenuDocWired = false;
/* Issue #375: a persisted 3D preference must never re-trap Shelves.
   Entering the 3D view arms a per-device watchdog flag; the flag is
   cleared when the mount proves itself (measured frame delivery —
   see shelf3dWatchdogProve), on clean unmount, and on both WebGL
   fallbacks — every path where the attempt concluded without trapping
   the user. The one way the flag survives into a later page load is a
   view that wedged before any of those could run. A surviving flag
   therefore means the last attempt never proved itself: the next visit
   falls back to 2D and resets the preference, so the user lands
   somewhere escapable and re-elects 3D explicitly if they want it. */
export const SHELF3D_WATCHDOG_KEY = 'cozylibram.s3d.watchdog';
export let _shelf3dWatchdogArmedHere = false;
export let _shelf3dProofRaf = 0;
export let _shelf3dProofGen = 0;
export function shelf3dWatchdogArm() {
  _shelf3dWatchdogArmedHere = true;
  try { localStorage.setItem(SHELF3D_WATCHDOG_KEY, '1'); } catch (e) {}
}
export function shelf3dWatchdogClear() {
  _shelf3dWatchdogArmedHere = false;
  _shelf3dProofGen++;   // any proof probe still chained belongs to a concluded attempt
  if (_shelf3dProofRaf) { try { cancelAnimationFrame(_shelf3dProofRaf); } catch (e) {} _shelf3dProofRaf = 0; }
  try { localStorage.removeItem(SHELF3D_WATCHDOG_KEY); } catch (e) {}
}
/* Proof is measured interactivity, not elapsed time. Round 1 used a
   1.5 s timer, and timers fire in the gaps between multi-second frame
   tasks: in the field the flag cleared after ~4 delivered frames in
   6 s (measured headlessly), "proving" a page nobody could click, so
   the fallback never engaged and the trap re-armed on every reload.
   The probe therefore counts delivered animation frames: the mount is
   proven only when MIN_TICKS frames land inside a rolling WINDOW_MS
   span (a sustained ~4 fps or better — a click is serviced between
   frames at that rate; the wedged rate is one frame per ~2 s, which
   never accumulates). Failing proof leaves the flag set but does NOT
   yank this visit away — a slow first paint is not punished mid-
   session; the next page load reads the flag as stale and falls
   back. The probe runs until it proves, the attempt is cleared, or
   the view unmounts. */
export const SHELF3D_PROOF_WINDOW_MS = 1500;
export const SHELF3D_PROOF_MIN_TICKS = 6;
export function shelf3dWatchdogProve() {
  const gen = ++_shelf3dProofGen;
  const times = [];
  const step = function (ts) {
    if (gen !== _shelf3dProofGen || !_shelf3dWatchdogArmedHere) { _shelf3dProofRaf = 0; return; }
    const t = (typeof ts === 'number') ? ts : performance.now();
    times.push(t);
    while (times.length && t - times[0] > SHELF3D_PROOF_WINDOW_MS) times.shift();
    if (times.length >= SHELF3D_PROOF_MIN_TICKS) { _shelf3dProofRaf = 0; shelf3dWatchdogClear(); return; }
    _shelf3dProofRaf = requestAnimationFrame(step);
  };
  _shelf3dProofRaf = requestAnimationFrame(step);
}
export function shelf3dWatchdogStale() {
  if (_shelf3dWatchdogArmedHere) return false;   // armed by this page load: an attempt in flight, not a leftover
  try { return localStorage.getItem(SHELF3D_WATCHDOG_KEY) === '1'; } catch (e) { return false; }
}
// v430 (#56, re-applied v453): robust toggle — set both hidden property and
// inline display. Belt-and-suspenders against CSS specificity issues.
export function _shelf3dSetMenuVisible(visible) {
  var dd = document.getElementById('svMenuDropdown3D');
  if (!dd) return;
  dd.hidden = !visible;
  dd.style.display = visible ? '' : 'none';
}
export function _shelf3dIsMenuVisible() {
  var dd = document.getElementById('svMenuDropdown3D');
  return !!(dd && !dd.hidden && dd.style.display !== 'none');
}
export function _shelf3dCloseMenu(e) {
  const dd = document.getElementById('svMenuDropdown3D');
  const btn = document.getElementById('svMenu3D');
  if (dd && btn && _shelf3dIsMenuVisible() && !dd.contains(e.target) && e.target !== btn) _shelf3dSetMenuVisible(false);
}

export function shelfViewMode() {
  try {
    // v409: URL override (?shelf=3d or ?shelf=2d) for emergency escape from stuck states.
    // Checked first, before localStorage.
    const params = new URLSearchParams(window.location.search);
    const urlMode = params.get('shelf');
    if (urlMode === '3d' || urlMode === '2d') return urlMode;
    return localStorage.getItem('shelfViewMode') || '3d';
  }
  catch (e) { return '3d'; }
}
/* Phase 1: capability gate — check if device can handle 3D, fall back to 2.5D if not */
export function shelf3DCapable() {
  try {
    // Explicit user preference overrides the gate
    const params = new URLSearchParams(window.location.search);
    if (params.get('shelf') === '3d') return true;
    if (params.get('shelf') === '2d') return false;
    // Check if user explicitly chose 3D (stored preference)
    const stored = localStorage.getItem('shelfViewMode');
    if (stored === '3d') return true;  // user opted in, respect it
    if (stored === '2d') return false;
    // No stored preference: run capability check
    // Check 1: WebGL available
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    // Check 2: Device memory (if available)
    if (navigator.deviceMemory && navigator.deviceMemory < 4) return false;
    // Check 3: Hardware concurrency (if available)
    if (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4) return false;
    // Check 4: Mobile with small screen and low DPR might struggle
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    if (isMobile && window.devicePixelRatio > 2.5) {
      // Very high DPR on mobile = expensive; still allow but adaptive res will handle it
    }
    return true;
  } catch (e) {
    return true;  // Fail open: if check fails, allow 3D (existing behavior)
  }
}
export function shelfSetViewMode(m) {
  try {
    localStorage.setItem('shelfViewMode', m === '2d' ? '2d' : '3d');
    // v414: clear the ?shelf= URL override — it was preventing the toggle from working
    // (URL param takes precedence over localStorage in shelfViewMode()).
    var url = new URL(window.location.href);
    if (url.searchParams.has('shelf')) {
      url.searchParams.delete('shelf');
      window.history.replaceState({}, '', url.toString());
    }
  }
  catch (e) {}
}
// Safe no-op when Shelf3D isn't loaded or isn't mounted.
export function shelfUnmount3D() {
  if (!_shelf3dMounted) return;
  _shelf3dMounted = false;
  // Leaving a live view concludes the attempt — the watchdog proof is
  // moot once the user has navigated away under their own power.
  shelf3dWatchdogClear();
  try {
    if (typeof Shelf3D !== 'undefined' && Shelf3D && typeof Shelf3D.unmount === 'function') {
      Shelf3D.unmount();
    }
  } catch (e) {}
}

// Map real books to the 3D engine's book spec. Uses the deterministic
// 2.5D spine palette so colors stay consistent between views.
export function shelfBooks3D(books) {
  return (books || []).map(function (b) {
    const spec = (typeof shelfSpineSpec === 'function')
      ? shelfSpineSpec(b) : { c1: '#5e1f2e', c2: '#380f1e', w: 36, h: 190 };
    const col = shelf3dSpineColors(b);
    // Normalize 2.5D px geometry to 3D world units (prototype scale).
    const spineH = Math.max(1.5, Math.min(2.6, spec.h / 100));
    return {
      id: b.id,
      title: b.title || 'Untitled',
      author: _s3dAuthor(b),
      cover: b.cover || '',
      // Face-out display pick (book.faceOut, set in the book modal): the
      // packer and the engine both read these; unpicked books render
      // exactly as before.
      faceOut: !!b.faceOut,
      faceW: (typeof shelf3dFaceWidth === 'function') ? shelf3dFaceWidth(spineH) : 1.25,
      spineC1: col.c1,
      spineC2: col.c2,
      spineW: Math.max(0.3, Math.min(0.7, spec.w / 70)),
      spineH: spineH,
    };
  });
}

export function shelf3DApplyTheme() {
  try {
    if (!_shelf3dMounted) return;
    if (typeof Shelf3D === 'undefined' || !Shelf3D) return;
    if (typeof Shelf3DTheme === 'undefined' || !Shelf3DTheme) return;
    const themeKey = (typeof getTheme === 'function') ? getTheme() : 'dark';
    // v416: effective accent (user pick else theme default) so the 3D scene
    // matches the app's designed look when no accent was explicitly chosen.
    const accentKey = (typeof effectiveAccent === 'function') ? effectiveAccent()
      : ((typeof getAccent === 'function' && getAccent()) || 'rose');
    const params = Shelf3DTheme.forTheme(themeKey, accentKey);
    if (typeof Shelf3D.setThemeParams === 'function') Shelf3D.setThemeParams(params);
    else if (typeof Shelf3D.setTheme === 'function') Shelf3D.setTheme('default');
    // v406: tell the engine the app theme key (dress-button label). Never
    // rearranges decorations — the button only fires on explicit tap.
    if (typeof Shelf3D.setAppTheme === 'function') Shelf3D.setAppTheme(themeKey);
  } catch (e) {}
}

export function renderShelf3D() {
  // #375 watchdog: a flag still set at a fresh page load means the last
  // 3D attempt wedged before it could prove itself. Break the re-trap —
  // reset the preference and land in the 2D view instead.
  if (shelf3dWatchdogStale()) {
    shelf3dWatchdogClear();
    shelfSetViewMode('2d');
    renderShelf();
    return;
  }
  shelf3dWatchdogArm();
  const books = (typeof library !== 'undefined' ? library : []);
  const counts = {};
  SHELF_GROUPS.forEach(function (g) {
    counts[g] = (typeof shelfGroupBooks === 'function' ? shelfGroupBooks(books, g) : []).length;
  });
  const shown = (typeof shelfBooks === 'function') ? shelfBooks() : [];
  const icon2d = (typeof icon === 'function') ? icon('shelf') : '2D';

  setView(
    '<div class="shelfview">' +
    '<div class="sv-head"><h2>Shelf</h2><div class="sv-head-btns">' +
    '<button class="sv-cam" id="svViewToggle" aria-label="Switch to classic 2D shelf view" title="Classic view">' + icon2d + '</button>' +
    '<button class="sv-cam" id="svMenu3D" aria-label="Shelf menu" title="Shelf menu">' + ((typeof icon === 'function') ? icon('dots') : '⋮') + '</button>' +
    '<div class="sv-menu" id="svMenuDropdown3D" hidden>' +
    '<button class="sv-menu-item" id="svMenuView3D">' + ((typeof icon === 'function') ? icon('shelf') : '') + '<span>Switch to classic 2D view</span></button>' +
    '<button class="sv-menu-item" id="svMenuDecor3D">' + ((typeof icon === 'function') ? icon('sparkles') : '') + '<span>Decorations</span></button>' +
    '<button class="sv-menu-item" id="svMenuShelfie">' + ((typeof icon === 'function') ? icon('camera') : '') + '<span>Share shelfie</span></button>' +
    '</div></div></div>' +
    '<div class="sv-chips">' + SHELF_GROUPS.map(function (g) {
      return '<button class="sv-chip' + (g === shelfGroup ? ' active' : '') + '" data-g="' + g + '">' +
        SHELF_GROUP_LABEL[g] + ' <span class="n">' + counts[g] + '</span></button>';
    }).join('') + '</div>' +
    '<div class="s3d-casebar" id="s3dCaseBar">' +
      '<button class="cb-nav" id="cbPrev" aria-label="Previous bookcase">&#8249;</button>' +
      '<div class="cb-mid"><span class="cb-label" id="cbLabel"></span><span class="cb-dots" id="cbDots"></span></div>' +
      '<button class="cb-nav" id="cbNext" aria-label="Next bookcase">&#8250;</button>' +
      '<button class="cb-tool" id="cbFind">Find</button>' +
      '<button class="cb-tool" id="cbArrange">Arrange</button>' +
    '</div>' +
    '<div class="s3d-sheet" id="s3dSheet" hidden></div>' +
    '<div id="shelf3d"><div class="s3d-loading"><p>Loading 3D shelf…</p></div></div>' +
    '<div class="sv-hint">Tap a book to open it &middot; swipe the case bar or use &#8249; &#8250; to walk the room</div>' +
    '</div>'
  );

  // Header: toggle back to 2D.
  const toggle = document.getElementById('svViewToggle');
  if (toggle) toggle.addEventListener('click', function () {
    shelfSetViewMode('2d');
    renderShelf();
  });
  // v411: overflow menu with 2D toggle (User: discoverable home for view switch).
  const menuBtn3D = document.getElementById('svMenu3D');
  const menuDropdown3D = document.getElementById('svMenuDropdown3D');
  if (menuBtn3D && menuDropdown3D) {
    menuBtn3D.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      _shelf3dSetMenuVisible(!_shelf3dIsMenuVisible());
    });
    // v427: wired once (was leaking a listener per render).
    if (!_shelf3dMenuDocWired) {
      document.addEventListener('click', _shelf3dCloseMenu);
      _shelf3dMenuDocWired = true;
    }
    const menuView3DBtn = document.getElementById('svMenuView3D');
    if (menuView3DBtn) menuView3DBtn.addEventListener('click', function () {
      shelfSetViewMode('2d');
      _shelf3dSetMenuVisible(false);
      renderShelf();
    });
    // v417: Decorations inventory in menu (User: wasn't findable in 3D).
    // Triggers the existing s3dInvBtn; the ▦ button itself is hidden via CSS.
    const menuDecor3DBtn = document.getElementById('svMenuDecor3D');
    if (menuDecor3DBtn) menuDecor3DBtn.addEventListener('click', function () {
      _shelf3dSetMenuVisible(false);
      var invBtn = document.getElementById('s3dInvBtn');
      if (invBtn) invBtn.click();
    });
    // v455: shelfie — capture the 3D canvas as a shareable image.
    const menuShelfieBtn = document.getElementById('svMenuShelfie');
    if (menuShelfieBtn) menuShelfieBtn.addEventListener('click', function () {
      _shelf3dSetMenuVisible(false);
      if (typeof shareShelfie === 'function') shareShelfie();
    });
  }

  // Chips: update the 3D scene in place (no remount).
  document.querySelectorAll('.sv-chip').forEach(function (ch) {
    ch.addEventListener('click', function () {
      shelfGroup = ch.dataset.g;
      document.querySelectorAll('.sv-chip').forEach(function (c) {
        c.classList.toggle('active', c === ch);
      });
      shelf3dGoCase(_shelf3dCaseIdx[shelfGroup] || 0, 0);
      shelf3dPaintCovers();
    });
  });
  wireCaseBar();

  // Mount the 3D scene.
  const container = document.getElementById('shelf3d');
  if (!container || typeof Shelf3D === 'undefined') {
    // v408: don't persist '2d' on fallback — a transient failure shouldn't
    // permanently flip the preference. Session flag only.
    _shelf3dWebGLFailed = true;
    shelf3dWatchdogClear();   // the attempt concluded (fell back), so it is not a trap leftover
    renderShelf();
    return;
  }
  Shelf3D.mount(container, {
    onBookTap: function (id) {
      if (typeof openDetail === 'function') openDetail(id, null);
    },
    onDecoChange: shelf3dOnDecoChange,
    initialBooks: (function () { const r = shelf3dRoom(); return shelf3dCaseBooks(r, Math.min(_shelf3dCaseIdx[shelfGroup] || 0, r.cases.length - 1)); })(),
    initialNeighbours: (function () { const r = shelf3dRoom(); return shelf3dNeighbours(r, Math.min(_shelf3dCaseIdx[shelfGroup] || 0, r.cases.length - 1)); })(),
    caseKey: shelf3dCaseKey(shelfGroup, Math.min(_shelf3dCaseIdx[shelfGroup] || 0, shelf3dRoom().cases.length - 1)),
    appTheme: (typeof getTheme === 'function') ? getTheme() : 'dark',
  }).then(function () {
    _shelf3dMounted = true;
    // #375: the mount resolved and the view is painting. Proof is
    // measured frame delivery (shelf3dWatchdogProve): the watchdog
    // clears only if the loop demonstrably keeps delivering frames —
    // a wedged loop delivers almost none, so its flag survives to the
    // next page load and the stale-check above breaks the trap.
    shelf3dWatchdogProve();
    shelf3DApplyTheme();
    shelf3dUpdateBar();
    shelf3dPaintCovers();
    // v414: remove the loading overlay — it was covering the canvas and intercepting taps.
    var loading = container.querySelector('.s3d-loading');
    if (loading) loading.remove();
  }).catch(function () {
    // WebGL unavailable or THREE failed to load: fall back to 2D.
    // v408: session flag only, don't persist — user can retry 3D via toggle.
    _shelf3dMounted = false;
    _shelf3dWebGLFailed = true;
    shelf3dWatchdogClear();   // concluded attempt — must not read as a trap leftover next load
    renderShelf();
  });
}

/* ---------- the room: case bar, find, arrange ---------- */
export function shelf3dNeighbours(room, i) {
  return {
    prev: i > 0 ? shelfBooks3D(room.cases[i - 1]) : null,
    next: i < room.cases.length - 1 ? shelfBooks3D(room.cases[i + 1]) : null
  };
}
export function shelf3dGoCase(idx, dir, thenFind) {
  const room = shelf3dRoom();
  const i = Math.max(0, Math.min(room.cases.length - 1, idx));
  // |dir| > 1 means a far jump (find / dots): slide instead of gliding past cases.
  if (dir && Math.abs(i - (_shelf3dCaseIdx[shelfGroup] || 0)) > 1) dir = dir > 0 ? 2 : -2;
  _shelf3dCaseIdx[shelfGroup] = i;
  try {
    if (_shelf3dMounted && typeof Shelf3D !== 'undefined' && Shelf3D) {
      Shelf3D.showCase(shelf3dCaseKey(shelfGroup, i), shelf3dCaseBooks(room, i), dir || 0, shelf3dNeighbours(room, i));
      if (thenFind != null) setTimeout(function () { try { Shelf3D.highlightBook(thenFind); } catch (e) {} }, dir ? 450 : 120);
    }
  } catch (e) {}
  shelf3dUpdateBar();
}
export function shelf3dUpdateBar() {
  const bar = document.getElementById('s3dCaseBar');
  if (!bar) return;
  const room = shelf3dRoom();
  const n = room.cases.length;
  const i = Math.min(_shelf3dCaseIdx[shelfGroup] || 0, n - 1);
  const first = (room.starts ? room.starts[i] : i * SHELF3D_MAX_BOOKS) + 1;
  const last = (room.starts ? room.starts[i] : i * SHELF3D_MAX_BOOKS) + room.cases[i].length;
  const label = document.getElementById('cbLabel');
  if (label) {
    label.textContent = n > 1 ? 'Case ' + (i + 1) + ' of ' + n
      : (room.all.length ? 'Your bookcase' : 'An empty bookcase, waiting');
    label.title = room.all.length ? 'Books ' + first + '\u2013' + last + ' of ' + room.all.length : '';
  }
  const dots = document.getElementById('cbDots');
  if (dots) {
    dots.innerHTML = n > 1 ? room.cases.map(function (_, k) {
      return '<button class="cb-dot' + (k === i ? ' on' : '') + '" data-i="' + k + '" aria-label="Go to case ' + (k + 1) + '"></button>';
    }).join('') : '';
  }
  const prev = document.getElementById('cbPrev'), next = document.getElementById('cbNext');
  if (prev) { prev.hidden = n < 2; prev.disabled = i <= 0; }
  if (next) { next.hidden = n < 2; next.disabled = i >= n - 1; }
}
export function shelf3dRenderSheet(kind) {
  const sheet = document.getElementById('s3dSheet');
  if (!sheet) return;
  if (!kind || sheet.dataset.kind === kind && !sheet.hidden) { sheet.hidden = true; sheet.dataset.kind = ''; return; }
  sheet.dataset.kind = kind;
  sheet.hidden = false;
  if (kind === 'arrange') {
    const cur = shelf3dArrangeMode();
    sheet.innerHTML = '<p class="sh-title">Arrange this room</p>' +
      SHELF3D_ARRANGE_MODES.map(function (m) {
        return '<button class="sh-opt' + (m[0] === cur ? ' on' : '') + '" data-m="' + m[0] + '">' + m[1] + '</button>';
      }).join('') +
      '<p class="sh-title" style="margin-top:10px">Spines</p>' +
      '<button class="sh-opt sh-spine' + (shelf3dSpinesMode() === 'cover' ? ' on' : '') + '" data-s="cover">Colours from the covers</button>' +
      '<button class="sh-opt sh-spine' + (shelf3dSpinesMode() === 'classic' ? ' on' : '') + '" data-s="classic">Classic cloth</button>' +
      '<p class="sh-note">Only changes how the room looks. Your own shelf order is kept.</p>';
    sheet.querySelectorAll('.sh-spine').forEach(function (b) {
      b.addEventListener('click', function () {
        shelf3dSetSpinesMode(b.dataset.s);
        shelf3dRenderSheet(null);
        shelf3dGoCase(_shelf3dCaseIdx[shelfGroup] || 0, 0);
        if (b.dataset.s === 'cover') shelf3dPaintCovers();
      });
    });
    sheet.querySelectorAll('.sh-opt:not(.sh-spine)').forEach(function (b) {
      b.addEventListener('click', function () {
        shelf3dSetArrangeMode(b.dataset.m);
        _shelf3dCaseIdx[shelfGroup] = 0;
        shelf3dRenderSheet(null);
        shelf3dGoCase(0, 0);
      });
    });
  } else {
    sheet.innerHTML = '<input class="sh-find" id="s3dFindInput" type="search" placeholder="Find a book on these shelves…" autocomplete="off">' +
      '<div class="sh-results" id="s3dFindResults"></div>';
    const input = document.getElementById('s3dFindInput');
    const out = document.getElementById('s3dFindResults');
    const draw = function () {
      const q = input.value.trim().toLowerCase();
      const room = shelf3dRoom();
      if (!q) { out.innerHTML = ''; return; }
      const hits = [];
      room.all.forEach(function (b, idx) {
        const hay = (String(b.title || '') + ' ' + _s3dAuthor(b)).toLowerCase();
        if (hay.indexOf(q) >= 0 && hits.length < 8) hits.push({ b: b, idx: idx });
      });
      out.innerHTML = hits.length ? hits.map(function (h) {
        return '<button class="sh-hit" data-id="' + esc(h.b.id) + '" data-i="' + shelf3dCaseOf(room, h.idx) + '">' +
          esc(h.b.title || 'Untitled') + '<small>' + esc(_s3dAuthor(h.b)) + ' · case ' + (shelf3dCaseOf(room, h.idx) + 1) + '</small></button>';
      }).join('') : '<p class="sh-note">Nothing on these shelves matches. Try another group above.</p>';
      out.querySelectorAll('.sh-hit').forEach(function (hb) {
        hb.addEventListener('click', function () {
          const target = parseInt(hb.dataset.i, 10) || 0;
          const dir = target === (_shelf3dCaseIdx[shelfGroup] || 0) ? 0 : (target > (_shelf3dCaseIdx[shelfGroup] || 0) ? 1 : -1);
          shelf3dRenderSheet(null);
          const idv = hb.dataset.id;
          const real = (typeof library !== 'undefined' ? library : []).find(function (x) { return String(x.id) === idv; });
          shelf3dGoCase(target, dir, real ? real.id : idv);
        });
      });
    };
    input.addEventListener('input', draw);
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 30);
  }
}
export function wireCaseBar() {
  const q = function (id) { return document.getElementById(id); };
  const step = function (d) { shelf3dGoCase((_shelf3dCaseIdx[shelfGroup] || 0) + d, d); };
  if (q('cbPrev')) q('cbPrev').addEventListener('click', function () { step(-1); });
  if (q('cbNext')) q('cbNext').addEventListener('click', function () { step(1); });
  if (q('cbFind')) q('cbFind').addEventListener('click', function () { shelf3dRenderSheet('find'); });
  if (q('cbArrange')) q('cbArrange').addEventListener('click', function () { shelf3dRenderSheet('arrange'); });
  const dots = q('cbDots');
  if (dots) dots.addEventListener('click', function (e) {
    const b = e.target.closest && e.target.closest('.cb-dot');
    if (!b) return;
    const t = parseInt(b.dataset.i, 10) || 0, cur = _shelf3dCaseIdx[shelfGroup] || 0;
    if (t !== cur) shelf3dGoCase(t, t > cur ? 1 : -1);
  });
  // Swipe the case bar to walk the room.
  const bar = q('s3dCaseBar');
  if (bar) {
    let x0 = null;
    bar.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    bar.addEventListener('touchend', function (e) {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  if (!_shelf3dKeysWired) {
    _shelf3dKeysWired = true;
    document.addEventListener('keydown', function (e) {
      if (!_shelf3dMounted || !document.getElementById('s3dCaseBar')) return;
      const t = e.target && e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') shelf3dGoCase((_shelf3dCaseIdx[shelfGroup] || 0) + 1, 1);
      else if (e.key === 'ArrowLeft') shelf3dGoCase((_shelf3dCaseIdx[shelfGroup] || 0) - 1, -1);
    });
  }
  shelf3dUpdateBar();
}

/* Read cover colours in the background (the cache is shared with the favourites
   shelf and persists). Current case first; a quiet batch per visit; the room
   refreshes once colours land. Covers that can't be read keep the classic cloth. */
export function shelf3dPaintCovers() {
  if (_shelf3dPaintBusy || shelf3dSpinesMode() !== 'cover') return;
  if (typeof coverDominantColor !== 'function' || typeof spineColorCache === 'undefined') return;
  const room = shelf3dRoom();
  const cur = Math.min(_shelf3dCaseIdx[shelfGroup] || 0, room.cases.length - 1);
  const order = room.cases[cur].concat(room.all.filter(function (b) { return room.cases[cur].indexOf(b) < 0; }));
  const todo = order.filter(function (b) {
    return b.cover && !shelf3dCoverHex(b) && !(typeof spinePaintInflight !== 'undefined' && spinePaintInflight.has(b.id));
  }).slice(0, 60);
  if (!todo.length) return;
  _shelf3dPaintBusy = true;
  let i = 0, done = 0;
  const refresh = function () {
    clearTimeout(_shelf3dPaintTimer);
    _shelf3dPaintTimer = setTimeout(function () {
      if (_shelf3dMounted && document.getElementById('s3dCaseBar')) shelf3dGoCase(_shelf3dCaseIdx[shelfGroup] || 0, 0);
    }, 900);
  };
  const worker = function () {
    if (i >= todo.length || !_shelf3dMounted) return Promise.resolve();
    const b = todo[i++];
    return coverDominantColor(b.cover).then(function (hex) {
      if (hex) {
        spineColorCache[b.id] = { hex: hex, cover: b.cover };
        done++;
        if (done % 6 === 0) refresh();
      }
    }, function () {}).then(worker);
  };
  Promise.all([worker(), worker()]).then(function () {
    _shelf3dPaintBusy = false;
    if (typeof saveSpineColorCache === 'function') saveSpineColorCache();
    if (done) refresh();
  });
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The classic consumers — js/205-shelfview.js (the
   2D shelf branches here via shelfViewMode / renderShelf3D /
   shelfUnmount3D, reads the WebGL-failure flag on every render, and
   resets it from its view toggles so 3D is retried) and
   js/180-settings.js (shelfViewMode / shelfSetViewMode) — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in
   classic scripts resolve through the global object, so the caller
   needs no changes. Module scripts are deferred, so the bridge is in
   place before any consumer can run. Remove a name from this bridge
   only when its last classic caller is gone.
   _shelf3dWebGLFailed is republished as an accessor property, not a
   value copy: this file sets it when a 3D mount fails, and js/205
   both reads it (the session skip in renderShelf) and reassigns it
   (the 3D toggles clear it so a failed context is retried). A value
   copy would freeze the boot value and silently drop those writes;
   the getter/setter pair forwards every read and write to the module
   binding, so no consumer expression changes. */
window.SHELF3D_MAX_BOOKS = SHELF3D_MAX_BOOKS;
window.SHELF3D_ARRANGE_KEY = SHELF3D_ARRANGE_KEY;
window.SHELF3D_ARRANGE_MODES = SHELF3D_ARRANGE_MODES;
window.SHELF3D_SPINES_KEY = SHELF3D_SPINES_KEY;
window._shelf3dPaintBusy = _shelf3dPaintBusy;
window._shelf3dPaintTimer = _shelf3dPaintTimer;
window.shelf3dSpinesMode = shelf3dSpinesMode;
window.shelf3dSetSpinesMode = shelf3dSetSpinesMode;
window.shelf3dCoverHex = shelf3dCoverHex;
window._s3dRgb = _s3dRgb;
window._s3dHex = _s3dHex;
window.shelf3dSpineTone = shelf3dSpineTone;
window.shelf3dSpineAccent = shelf3dSpineAccent;
window.shelf3dHue = shelf3dHue;
window.shelf3dSpineColors = shelf3dSpineColors;
window._shelf3dCaseIdx = _shelf3dCaseIdx;
window._shelf3dKeysWired = _shelf3dKeysWired;
window.shelf3dArrangeMode = shelf3dArrangeMode;
window.shelf3dSetArrangeMode = shelf3dSetArrangeMode;
window._s3dSortKey = _s3dSortKey;
window._s3dAuthor = _s3dAuthor;
window.shelf3dArrange = shelf3dArrange;
window.shelf3dCases = shelf3dCases;
window.shelf3dCaseKey = shelf3dCaseKey;
window.shelf3dDecoDoc = shelf3dDecoDoc;
window.shelf3dCaseObstacles = shelf3dCaseObstacles;
window.shelf3dSliceRoom = shelf3dSliceRoom;
window.shelf3dCaseOf = shelf3dCaseOf;
window.shelf3dCaseBooks = shelf3dCaseBooks;
window.shelf3dRoom = shelf3dRoom;
window.shelf3dOnDecoChange = shelf3dOnDecoChange;
window._shelf3dMounted = _shelf3dMounted;
Object.defineProperty(window, '_shelf3dWebGLFailed', { get: () => _shelf3dWebGLFailed, set: (v) => { _shelf3dWebGLFailed = v; }, enumerable: true, configurable: true });
window._shelf3dMenuDocWired = _shelf3dMenuDocWired;
window._shelf3dSetMenuVisible = _shelf3dSetMenuVisible;
window._shelf3dIsMenuVisible = _shelf3dIsMenuVisible;
window._shelf3dCloseMenu = _shelf3dCloseMenu;
window.shelfViewMode = shelfViewMode;
window.shelf3DCapable = shelf3DCapable;
window.shelfSetViewMode = shelfSetViewMode;
window.shelfUnmount3D = shelfUnmount3D;
window.shelfBooks3D = shelfBooks3D;
window.shelf3DApplyTheme = shelf3DApplyTheme;
window.renderShelf3D = renderShelf3D;
window.shelf3dNeighbours = shelf3dNeighbours;
window.shelf3dGoCase = shelf3dGoCase;
window.shelf3dUpdateBar = shelf3dUpdateBar;
window.shelf3dRenderSheet = shelf3dRenderSheet;
window.wireCaseBar = wireCaseBar;
window.shelf3dPaintCovers = shelf3dPaintCovers;
