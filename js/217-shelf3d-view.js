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
     further bookcases. Each case holds 60 books and keeps its own decorations.
     A case bar pages between cases, "Find" jumps to a book, "Arrange" changes
     how the room is ordered (view only: the saved shelf order is untouched). */

const SHELF3D_MAX_BOOKS = 60;   // books per bookcase
const SHELF3D_ARRANGE_KEY = 'cozylibram.s3d.arrange';
const SHELF3D_ARRANGE_MODES = [
  ['mine', 'As I placed them'], ['title', 'Title'], ['author', 'Author'], ['series', 'Series']
];
let _shelf3dCaseIdx = { tbr: 0, reading: 0, read: 0 };
let _shelf3dKeysWired = false;

function shelf3dArrangeMode() {
  try {
    const m = localStorage.getItem(SHELF3D_ARRANGE_KEY);
    if (SHELF3D_ARRANGE_MODES.some(function (x) { return x[0] === m; })) return m;
  } catch (e) {}
  return 'mine';
}
function shelf3dSetArrangeMode(m) {
  try { localStorage.setItem(SHELF3D_ARRANGE_KEY, m); } catch (e) {}
}
function _s3dSortKey(str) {
  return String(str || '').toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
}
function _s3dAuthor(b) {
  if (b.authors && b.authors.length) return String(b.authors[0] || '');
  return String(b.author || '');
}
// Re-order a list of books for the room. Never mutates the input.
function shelf3dArrange(books, mode) {
  const list = (books || []).slice();
  const cmp = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
  if (mode === 'title') {
    list.sort(function (a, b) { return cmp(_s3dSortKey(a.title), _s3dSortKey(b.title)); });
  } else if (mode === 'author') {
    list.sort(function (a, b) {
      return cmp(_s3dAuthor(a).toLowerCase(), _s3dAuthor(b).toLowerCase()) ||
        cmp(_s3dSortKey(a.title), _s3dSortKey(b.title));
    });
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
function shelf3dCases(books, size) {
  const n = Math.max(1, size || SHELF3D_MAX_BOOKS);
  const out = [];
  for (let i = 0; i < (books || []).length; i += n) out.push(books.slice(i, i + n));
  if (!out.length) out.push([]);
  return out;
}
function shelf3dCaseKey(group, idx) { return group + ':' + idx; }
// The arranged books for the current group, split into cases.
function shelf3dRoom() {
  const all = shelf3dArrange((typeof shelfBooks === 'function') ? shelfBooks() : [], shelf3dArrangeMode());
  return { all: all, cases: shelf3dCases(all, SHELF3D_MAX_BOOKS) };
}

// Local mount-state tracking (robust even if the engine's `mounted` flag
// is missing or the engine is still loading).
let _shelf3dMounted = false;
// v408: session flag for WebGL failure — don't persist '2d', just skip 3D this session.
let _shelf3dWebGLFailed = false;
// v427: guard for the document-level menu-close listener (added once, not per render).
let _shelf3dMenuDocWired = false;
// v430 (#56, re-applied v453): robust toggle — set both hidden property and
// inline display. Belt-and-suspenders against CSS specificity issues.
function _shelf3dSetMenuVisible(visible) {
  var dd = document.getElementById('svMenuDropdown3D');
  if (!dd) return;
  dd.hidden = !visible;
  dd.style.display = visible ? '' : 'none';
}
function _shelf3dIsMenuVisible() {
  var dd = document.getElementById('svMenuDropdown3D');
  return !!(dd && !dd.hidden && dd.style.display !== 'none');
}
function _shelf3dCloseMenu(e) {
  const dd = document.getElementById('svMenuDropdown3D');
  const btn = document.getElementById('svMenu3D');
  if (dd && btn && _shelf3dIsMenuVisible() && !dd.contains(e.target) && e.target !== btn) _shelf3dSetMenuVisible(false);
}

function shelfViewMode() {
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
function shelf3DCapable() {
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
function shelfSetViewMode(m) {
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
function shelfUnmount3D() {
  if (!_shelf3dMounted) return;
  _shelf3dMounted = false;
  try {
    if (typeof Shelf3D !== 'undefined' && Shelf3D && typeof Shelf3D.unmount === 'function') {
      Shelf3D.unmount();
    }
  } catch (e) {}
}

// Map real books to the 3D engine's book spec. Uses the deterministic
// 2.5D spine palette so colors stay consistent between views.
function shelfBooks3D(books) {
  return (books || []).map(function (b) {
    const spec = (typeof shelfSpineSpec === 'function')
      ? shelfSpineSpec(b) : { c1: '#5e1f2e', c2: '#380f1e', w: 36, h: 190 };
    return {
      id: b.id,
      title: b.title || 'Untitled',
      spineC1: spec.c1,
      spineC2: spec.c2,
      // Normalize 2.5D px geometry to 3D world units (prototype scale).
      spineW: Math.max(0.3, Math.min(0.7, spec.w / 70)),
      spineH: Math.max(1.5, Math.min(2.6, spec.h / 100)),
    };
  });
}

function shelf3DApplyTheme() {
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

function renderShelf3D() {
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
    '<button class="sv-menu-item" id="svMenuShelfie">' + ((typeof icon === 'function') ? icon('camera') : '📸') + '<span>Share shelfie</span></button>' +
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
    });
  });
  wireCaseBar();

  // Mount the 3D scene.
  const container = document.getElementById('shelf3d');
  if (!container || typeof Shelf3D === 'undefined') {
    // v408: don't persist '2d' on fallback — a transient failure shouldn't
    // permanently flip the preference. Session flag only.
    _shelf3dWebGLFailed = true;
    renderShelf();
    return;
  }
  Shelf3D.mount(container, {
    onBookTap: function (id) {
      if (typeof openDetail === 'function') openDetail(id, null);
    },
    initialBooks: shelfBooks3D(shelf3dRoom().cases[Math.min(_shelf3dCaseIdx[shelfGroup] || 0, shelf3dRoom().cases.length - 1)]),
    initialNeighbours: (function () { const r = shelf3dRoom(); return shelf3dNeighbours(r, Math.min(_shelf3dCaseIdx[shelfGroup] || 0, r.cases.length - 1)); })(),
    caseKey: shelf3dCaseKey(shelfGroup, Math.min(_shelf3dCaseIdx[shelfGroup] || 0, shelf3dRoom().cases.length - 1)),
    appTheme: (typeof getTheme === 'function') ? getTheme() : 'dark',
  }).then(function () {
    _shelf3dMounted = true;
    shelf3DApplyTheme();
    shelf3dUpdateBar();
    // v414: remove the loading overlay — it was covering the canvas and intercepting taps.
    var loading = container.querySelector('.s3d-loading');
    if (loading) loading.remove();
  }).catch(function () {
    // WebGL unavailable or THREE failed to load: fall back to 2D.
    // v408: session flag only, don't persist — user can retry 3D via toggle.
    _shelf3dMounted = false;
    _shelf3dWebGLFailed = true;
    renderShelf();
  });
}

/* ---------- the room: case bar, find, arrange ---------- */
function shelf3dNeighbours(room, i) {
  return {
    prev: i > 0 ? shelfBooks3D(room.cases[i - 1]) : null,
    next: i < room.cases.length - 1 ? shelfBooks3D(room.cases[i + 1]) : null
  };
}
function shelf3dGoCase(idx, dir, thenFind) {
  const room = shelf3dRoom();
  const i = Math.max(0, Math.min(room.cases.length - 1, idx));
  // |dir| > 1 means a far jump (find / dots): slide instead of gliding past cases.
  if (dir && Math.abs(i - (_shelf3dCaseIdx[shelfGroup] || 0)) > 1) dir = dir > 0 ? 2 : -2;
  _shelf3dCaseIdx[shelfGroup] = i;
  try {
    if (_shelf3dMounted && typeof Shelf3D !== 'undefined' && Shelf3D) {
      Shelf3D.showCase(shelf3dCaseKey(shelfGroup, i), shelfBooks3D(room.cases[i]), dir || 0, shelf3dNeighbours(room, i));
      if (thenFind != null) setTimeout(function () { try { Shelf3D.highlightBook(thenFind); } catch (e) {} }, dir ? 450 : 120);
    }
  } catch (e) {}
  shelf3dUpdateBar();
}
function shelf3dUpdateBar() {
  const bar = document.getElementById('s3dCaseBar');
  if (!bar) return;
  const room = shelf3dRoom();
  const n = room.cases.length;
  const i = Math.min(_shelf3dCaseIdx[shelfGroup] || 0, n - 1);
  const first = i * SHELF3D_MAX_BOOKS + 1;
  const last = i * SHELF3D_MAX_BOOKS + room.cases[i].length;
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
function shelf3dRenderSheet(kind) {
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
      '<p class="sh-note">Only changes how the room looks. Your own shelf order is kept.</p>';
    sheet.querySelectorAll('.sh-opt').forEach(function (b) {
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
        return '<button class="sh-hit" data-id="' + esc(h.b.id) + '" data-i="' + Math.floor(h.idx / SHELF3D_MAX_BOOKS) + '">' +
          esc(h.b.title || 'Untitled') + '<small>' + esc(_s3dAuthor(h.b)) + ' · case ' + (Math.floor(h.idx / SHELF3D_MAX_BOOKS) + 1) + '</small></button>';
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
function wireCaseBar() {
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
