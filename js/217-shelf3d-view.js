'use strict';

/* ---- 217-shelf3d-view.js: 3D Shelf tab integration (v405) ----
   Integrates the Three.js 3D shelf (js/215-shelf3d.js) into the real Shelf
   tab as an alternative to the 2.5D view (js/205-shelfview.js).

   - View mode persists per device in localStorage ('shelfViewMode').
   - 3D books come from the real library via shelfBooks() + shelfSpineSpec().
   - Tapping a 3D book opens the book modal (openDetail).
   - TBR/Reading/Read chips update the 3D scene via Shelf3D.setBooks().
   - WebGL unavailable (or THREE load failure) falls back to the 2.5D view.
   - Decorations in 3D are session-only (the 2.5D decor system is separate).
   - Performance: book count capped at 60 for the 3D scene. */

const SHELF3D_MAX_BOOKS = 60;

// Local mount-state tracking (robust even if the engine's `mounted` flag
// is missing or the engine is still loading).
let _shelf3dMounted = false;

function shelfViewMode() {
  try { return localStorage.getItem('shelfViewMode') || '3d'; }
  catch (e) { return '3d'; }
}
function shelfSetViewMode(m) {
  try { localStorage.setItem('shelfViewMode', m === '2d' ? '2d' : '3d'); }
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
  return (books || []).slice(0, SHELF3D_MAX_BOOKS).map(function (b) {
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
    const accentKey = (typeof getAccent === 'function') ? getAccent() : 'rose';
    const params = Shelf3DTheme.forTheme(themeKey, accentKey);
    if (typeof Shelf3D.setThemeParams === 'function') Shelf3D.setThemeParams(params);
    else if (typeof Shelf3D.setTheme === 'function') Shelf3D.setTheme('default');
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
    '</div></div>' +
    '<div class="sv-chips">' + SHELF_GROUPS.map(function (g) {
      return '<button class="sv-chip' + (g === shelfGroup ? ' active' : '') + '" data-g="' + g + '">' +
        SHELF_GROUP_LABEL[g] + ' <span class="n">' + counts[g] + '</span></button>';
    }).join('') + '</div>' +
    '<div id="shelf3d"><div class="s3d-loading"><p>Loading 3D shelf…</p></div></div>' +
    (shown.length > SHELF3D_MAX_BOOKS
      ? '<div class="sv-hint">Showing first ' + SHELF3D_MAX_BOOKS + ' books in 3D</div>'
      : '<div class="sv-hint">Tap a book to open it &middot; drag decorations from the inventory</div>') +
    '</div>'
  );

  // Header: toggle back to 2D.
  const toggle = document.getElementById('svViewToggle');
  if (toggle) toggle.addEventListener('click', function () {
    shelfSetViewMode('2d');
    renderShelf();
  });

  // Chips: update the 3D scene in place (no remount).
  document.querySelectorAll('.sv-chip').forEach(function (ch) {
    ch.addEventListener('click', function () {
      shelfGroup = ch.dataset.g;
      document.querySelectorAll('.sv-chip').forEach(function (c) {
        c.classList.toggle('active', c === ch);
      });
      try {
        if (_shelf3dMounted && typeof Shelf3D !== 'undefined' && Shelf3D) {
          Shelf3D.setBooks(shelfBooks3D(
            (typeof shelfBooks === 'function') ? shelfBooks() : []
          ));
        }
      } catch (e) {}
    });
  });

  // Mount the 3D scene.
  const container = document.getElementById('shelf3d');
  if (!container || typeof Shelf3D === 'undefined') {
    shelfSetViewMode('2d');
    renderShelf();
    return;
  }
  Shelf3D.mount(container, {
    onBookTap: function (id) {
      if (typeof openDetail === 'function') openDetail(id, null);
    },
    initialBooks: shelfBooks3D(shown),
  }).then(function () {
    _shelf3dMounted = true;
    shelf3DApplyTheme();
  }).catch(function () {
    // WebGL unavailable or THREE failed to load: fall back to 2D.
    _shelf3dMounted = false;
    shelfSetViewMode('2d');
    renderShelf();
  });
}
