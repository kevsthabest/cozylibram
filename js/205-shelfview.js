'use strict';

/* ---- Shelf tab (v250): a SlowRead-style 2.5D bookshelf ----
   A separate bottom-nav tab that renders the library as book spines on
   wooden shelves instead of the cover grid. Spine colors/geometry are
   derived deterministically from each book id (stable across renders).

   - TBR / Reading / Read chips switch the shelf's book set.
   - Tap a spine opens the book modal (openBookFromEl).
   - Drag a spine to rearrange; the per-group order persists device-local
     in localStorage (like upNext — a reading plan, not synced).
   - Long-press a spine (or the header camera button) to photograph the
     physical book's spine; the cropped photo replaces the generated
     spine. Stored as book.spinePhoto (small JPEG data URL), which syncs
     through the books table's data JSONB with no migration.
   - Camera capture reuses the vision photo pattern: a file input with
     capture="environment" opens the camera directly on mobile. */

const SHELF_GROUPS = ['tbr', 'reading', 'read'];
const SHELF_GROUP_LABEL = { tbr: 'TBR', reading: 'Reading', read: 'Read' };
// Books per shelf row. 8 spines + decor fits a 360px phone.
const SHELF_ROW_SIZE = 8;

// Dark, cozy spine palette: [face, edge].
const SHELF_PALETTE = [
  ['#5e1f2e', '#380f1e'], ['#1c1c26', '#0e0e14'], ['#3d2352', '#221236'],
  ['#7a2a3a', '#471724'], ['#1f3d2b', '#0f2117'], ['#1f2b4d', '#10182e'],
  ['#8a6a2f', '#54401c'], ['#4a2545', '#2a142c'], ['#2b2b33', '#15151b'],
  ['#521f33', '#2e1220'], ['#0f3d2e', '#07231a'], ['#3a3a4d', '#1e1e28'],
  ['#6b3a1f', '#3f2113'], ['#274b5e', '#152a36'],
];

/* ---------------- pure helpers (tested) ---------------- */

// Stable FNV-1a hash -> uint32.
function shelfHash(str) {
  let h = 2166136261;
  str = String(str == null ? '' : str);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic spine geometry + palette slot for a book.
function shelfSpineSpec(book) {
  const h = shelfHash((book && book.id) || (book && book.title) || 'x');
  const pal = SHELF_PALETTE[h % SHELF_PALETTE.length];
  return {
    c1: pal[0], c2: pal[1],
    w: 30 + ((h >>> 3) % 15), // >>> : h is uint32; >> would sign-extend
    h: 172 + ((h >>> 9) % 44),
  };
}

function shelfGroupBooks(books, group) {
  return (books || []).filter(b => String((b && b.status) || 'tbr') === group);
}

// Merge a saved id-order with the live book list: saved order first,
// books missing from the order appended in library order, dead ids dropped.
function shelfApplyOrder(books, orderIds) {
  const byId = new Map();
  (books || []).forEach(b => { if (b && b.id != null) byId.set(b.id, b); });
  const out = [];
  (orderIds || []).forEach(id => {
    const b = byId.get(id);
    if (b) { out.push(b); byId.delete(id); }
  });
  (books || []).forEach(b => { if (b && byId.has(b.id)) out.push(b); });
  return out;
}

function shelfChunk(books, n) {
  const rows = [];
  for (let i = 0; i < books.length; i += n) rows.push(books.slice(i, i + n));
  return rows;
}

// Center-crop rect cutting a spine-aspect (1:5.2) strip out of a photo.
function spineCropRect(w, h) {
  const aspect = 1 / 5.2;
  let cw = w, ch = w / aspect;
  if (ch > h) { ch = h; cw = h * aspect; }
  cw = Math.max(1, Math.round(cw));
  ch = Math.max(1, Math.round(ch));
  return { x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: cw, h: ch };
}

// Device-local shelf arrangement (mirrors upNext: local-only, not synced).
function shelfOrderKey() {
  return typeof localUid !== 'undefined' && localUid
    ? 'spicyshelves.shelforder.v1.' + localUid : 'spicyshelves.shelforder.v1';
}
function loadShelfOrder() {
  try { return JSON.parse(localStorage.getItem(shelfOrderKey())) || {}; }
  catch (e) { return {}; }
}
function saveShelfOrder(o) {
  try { localStorage.setItem(shelfOrderKey(), JSON.stringify(o)); } catch (e) {}
}

/* ---------------- view ---------------- */

let shelfGroup = 'tbr';
let shelfOrderCache = null;
let pendingSpinePhoto = null; // cropped data URL waiting for the user to tap a spine
let shelfSheetToken = null;

function shelfOrder() {
  if (!shelfOrderCache) shelfOrderCache = loadShelfOrder();
  return shelfOrderCache;
}

function shelfBooks() {
  const books = typeof library !== 'undefined' ? library : [];
  return shelfApplyOrder(shelfGroupBooks(books, shelfGroup), shelfOrder()[shelfGroup]);
}

function shelfBookAuthor(book) {
  if (book.authors && book.authors.length) return book.authors[0];
  return book.author || '';
}

function shelfSpineHTML(book) {
  const spec = shelfSpineSpec(book);
  const title = book.title || 'Untitled';
  const author = shelfBookAuthor(book);
  const geom = 'width:' + spec.w + 'px;height:' + spec.h + 'px;';
  if (book.spinePhoto) {
    return '<div class="spine photo" data-id="' + esc(book.id) + '" style="' + geom +
      'background-image:url(&quot;' + book.spinePhoto + '&quot;)" title="' + esc(title) + '">' +
      '<span class="phototag">' + icon('camera') + '</span></div>';
  }
  return '<div class="spine" data-id="' + esc(book.id) + '" style="' + geom +
    'background:linear-gradient(90deg,' + spec.c2 + ',' + spec.c1 + ' 55%,' + spec.c2 + ')"' +
    ' title="' + esc(title) + '">' +
    '<span class="sp-t">' + esc(title) + '</span>' +
    (author ? '<span class="sp-a">' + esc(author) + '</span>' : '') + '</div>';
}

const SHELF_PLANT_HTML =
  '<div class="sv-decor sv-plant" aria-hidden="true"><div class="leaves"><i></i><i></i><i></i><i></i></div><div class="pot"></div></div>';
const SHELF_CANDLE_HTML =
  '<div class="sv-decor sv-candle" aria-hidden="true"><div class="flame"></div><div class="wax"></div><div class="plate"></div></div>';

function renderShelf() {
  const books = typeof library !== 'undefined' ? library : [];
  const counts = {};
  SHELF_GROUPS.forEach(g => { counts[g] = shelfGroupBooks(books, g).length; });
  const shown = shelfBooks();
  const rows = shelfChunk(shown, SHELF_ROW_SIZE);
  let shelvesHTML;
  if (!shown.length) {
    shelvesHTML = '<div class="sv-empty">' + icon('shelf') +
      '<p>Nothing on this shelf yet.</p>' +
      '<button class="btn" id="svEmptyAdd">Add a book</button></div>';
  } else {
    shelvesHTML = rows.map((row, i) => {
      const decor = i === 0 ? SHELF_PLANT_HTML
        : (i === rows.length - 1 ? SHELF_CANDLE_HTML : '');
      return '<div class="sv-shelf"><div class="sv-books">' +
        row.map(shelfSpineHTML).join('') + decor +
        '</div><div class="sv-board"></div><div class="sv-shadow"></div></div>';
    }).join('');
  }
  setView(
    '<div class="shelfview">' +
    '<div class="sv-head"><h2>Shelf</h2>' +
    '<button class="sv-cam" id="svCam" aria-label="Photograph a book spine">' + icon('camera') + '</button></div>' +
    '<div class="sv-chips">' + SHELF_GROUPS.map(g =>
      '<button class="sv-chip' + (g === shelfGroup ? ' active' : '') + '" data-g="' + g + '">' +
      SHELF_GROUP_LABEL[g] + ' <span class="n">' + counts[g] + '</span></button>').join('') + '</div>' +
    (pendingSpinePhoto
      ? '<div class="sv-assign">' + icon('camera') + ' Tap a spine to place this photo' +
        ' <button id="svAssignCancel">Cancel</button></div>'
      : '') +
    '<div class="sv-shelves" id="svShelves">' + shelvesHTML + '</div>' +
    (shown.length
      ? '<div class="sv-hint">Drag a spine to rearrange &middot; long-press for spine photo</div>'
      : '') +
    '</div>'
  );
  wireShelf();
}

/* ---------------- interactions: tap / drag / long-press ---------------- */

let shelfDrag = null;
let shelfIgnoreClickUntil = 0;

function wireShelf() {
  document.querySelectorAll('.sv-chip').forEach(ch =>
    ch.addEventListener('click', () => { shelfGroup = ch.dataset.g; renderShelf(); }));
  const cam = document.getElementById('svCam');
  if (cam) cam.addEventListener('click', () => shelfStartCapture(null));
  const emptyAdd = document.getElementById('svEmptyAdd');
  if (emptyAdd) emptyAdd.addEventListener('click', () => go('add'));
  const cancel = document.getElementById('svAssignCancel');
  if (cancel) cancel.addEventListener('click', () => { pendingSpinePhoto = null; renderShelf(); });
  const shelves = document.getElementById('svShelves');
  if (!shelves) return;
  shelves.querySelectorAll('.spine').forEach(sp => {
    sp.addEventListener('pointerdown', e => shelfPointerDown(e, sp));
    sp.addEventListener('click', e => shelfSpineClick(e, sp));
  });
}

function shelfPointerDown(e, sp) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const id = sp.dataset.id;
  const d = shelfDrag = {
    id, el: sp, x0: e.clientX, y0: e.clientY, live: false, ghost: null, ph: null,
    timer: setTimeout(() => {
      shelfCleanupDragListeners(d);
      shelfDrag = null;
      shelfIgnoreClickUntil = Date.now() + 600;
      try { if (navigator.vibrate) navigator.vibrate(25); } catch (_) {}
      shelfOpenPhotoSheet(id);
    }, 550),
  };
  const move = (ev) => {
    if (shelfDrag !== d) return;
    const dx = ev.clientX - d.x0, dy = ev.clientY - d.y0;
    if (!d.live && Math.hypot(dx, dy) > 10) {
      clearTimeout(d.timer);
      d.live = true;
      shelfStartGhost(d, ev);
    }
    if (d.live) shelfMoveGhost(d, ev);
  };
  const up = () => {
    shelfCleanupDragListeners(d);
    if (shelfDrag !== d) return;
    clearTimeout(d.timer);
    const wasLive = d.live;
    if (wasLive) shelfDropGhost(d);
    shelfDrag = null;
    if (wasLive) shelfIgnoreClickUntil = Date.now() + 400;
  };
  d.move = move; d.up = up;
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function shelfCleanupDragListeners(d) {
  if (!d) return;
  window.removeEventListener('pointermove', d.move);
  window.removeEventListener('pointerup', d.up);
  window.removeEventListener('pointercancel', d.up);
}

function shelfStartGhost(d, e) {
  const r = d.el.getBoundingClientRect();
  const g = d.el.cloneNode(true);
  g.removeAttribute('data-id');
  g.style.cssText += ';position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;' +
    'width:' + r.width + 'px;height:' + r.height + 'px;z-index:300;pointer-events:none;margin:0;';
  g.classList.add('dragging');
  document.body.appendChild(g);
  d.ghost = g;
  d.offX = e.clientX - r.left;
  d.offY = e.clientY - r.top;
  const ph = document.createElement('div');
  ph.className = 'spine-ph';
  ph.style.width = r.width + 'px';
  ph.style.height = r.height + 'px';
  d.el.parentNode.insertBefore(ph, d.el);
  d.ph = ph;
  d.el.classList.add('drag-src');
}

function shelfMoveGhost(d, e) {
  d.ghost.style.left = (e.clientX - d.offX) + 'px';
  d.ghost.style.top = (e.clientY - d.offY) + 'px';
  const spines = Array.from(document.querySelectorAll('#svShelves .spine'))
    .filter(el => el !== d.el && el !== d.ghost);
  let before = null, bestRow = null, bestDy = Infinity;
  for (const el of spines) {
    const r = el.getBoundingClientRect();
    const row = el.parentNode;
    const dy = Math.abs(e.clientY - (r.top + r.height / 2));
    if (dy < bestDy && row.classList.contains('sv-books')) { bestDy = dy; bestRow = row; }
    if (dy > r.height * 0.8) continue; // not this row
    if (e.clientX < r.left + r.width / 2) { before = el; break; }
  }
  if (before) {
    before.parentNode.insertBefore(d.ph, before);
  } else if (bestRow) {
    bestRow.appendChild(d.ph);
  }
}

function shelfDropGhost(d) {
  if (d.ph.parentNode) d.ph.parentNode.insertBefore(d.el, d.ph);
  d.el.classList.remove('drag-src');
  if (d.ghost) d.ghost.remove();
  if (d.ph) d.ph.remove();
  // Read the flat DOM order across all rows — that IS the new shelf order.
  const ids = Array.from(document.querySelectorAll('#svShelves .spine'))
    .map(el => el.dataset.id).filter(Boolean);
  shelfCommitOrder(ids);
}

// Persist a flat id order for the current group.
function shelfCommitOrder(ids) {
  const o = shelfOrder();
  o[shelfGroup] = ids.slice();
  saveShelfOrder(o);
  shelfOrderCache = o;
}

function shelfSpineClick(e, sp) {
  if (Date.now() < shelfIgnoreClickUntil) return;
  const id = sp.dataset.id;
  if (pendingSpinePhoto) {
    const url = pendingSpinePhoto;
    pendingSpinePhoto = null;
    shelfAssignPhoto(id, url);
    return;
  }
  openBookFromEl(sp, id);
}

/* ---------------- spine photo: sheet, capture, review ---------------- */

function shelfCloseSheet() {
  ['svSheetScrim', 'svSheet'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
  if (shelfSheetToken && typeof overlayClosed === 'function') {
    overlayClosed(shelfSheetToken);
    shelfSheetToken = null;
  }
}

function shelfSheetShell(title, bodyHTML) {
  shelfCloseSheet();
  const scrim = document.createElement('div');
  scrim.className = 'sv-scrim'; scrim.id = 'svSheetScrim';
  const sheet = document.createElement('div');
  sheet.className = 'sv-sheet'; sheet.id = 'svSheet';
  sheet.innerHTML = '<div class="sv-sheet-title">' + title + '</div>' + bodyHTML;
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add('open'));
  const close = () => shelfCloseSheet();
  scrim.addEventListener('click', close);
  if (typeof overlayOpened === 'function') shelfSheetToken = overlayOpened('shelf-photo', close);
  return { sheet, close };
}

// Long-press action sheet for one spine.
function shelfOpenPhotoSheet(id) {
  const book = (typeof library !== 'undefined' ? library : []).find(b => b && b.id === id);
  if (!book) return;
  const { close } = shelfSheetShell(esc(book.title || 'Untitled'),
    '<button class="sv-sheet-btn" id="svPhotoTake">' + icon('camera') + ' Photograph spine</button>' +
    (book.spinePhoto
      ? '<button class="sv-sheet-btn danger" id="svPhotoRemove">Remove spine photo</button>' : '') +
    '<button class="sv-sheet-btn ghost" id="svSheetCancel">Cancel</button>');
  document.getElementById('svSheetCancel').addEventListener('click', close);
  document.getElementById('svPhotoTake').addEventListener('click', () => { close(); shelfStartCapture(id); });
  const rm = document.getElementById('svPhotoRemove');
  if (rm) rm.addEventListener('click', () => {
    delete book.spinePhoto;
    saveLibrary();
    close();
    renderShelf();
    toast('Spine photo removed');
  });
}

// Camera capture via the native camera (file input + capture="environment",
// the same pattern visionPickPhoto uses). bookId may be null (header
// button) — then the photo waits for the user to tap a spine.
function shelfStartCapture(bookId) {
  let input = document.getElementById('sv-photo-input');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'sv-photo-input';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      const target = input._bookId;
      input.value = '';
      if (!f) return;
      const r = new FileReader();
      r.onload = () => shelfReviewCapture(String(r.result || ''), target);
      r.readAsDataURL(f);
    });
    document.body.appendChild(input);
  }
  input._bookId = bookId;
  input.click();
}

function shelfReviewCapture(dataUrl, bookId) {
  // Downscale (reuse the vision pipeline's safe resizer), then crop the
  // center strip at spine aspect and re-encode small.
  const down = (typeof visionDownscale === 'function')
    ? visionDownscale(dataUrl, 600) : Promise.resolve(dataUrl);
  down.then(d => spineCropToDataURL(d, 168)).then(cropped => {
    const book = (typeof library !== 'undefined' ? library : []).find(b => b && b.id === bookId);
    const { close } = shelfSheetShell('Spine photo' + (book ? ' — ' + esc(book.title || '') : ''),
      '<div class="sv-review"><img alt="Cropped spine photo"></div>' +
      '<p class="sv-review-hint">Cropped to the spine — look right?</p>' +
      '<div class="sv-review-actions">' +
      '<button class="sv-sheet-btn ghost" id="svRetake">Retake</button>' +
      '<button class="sv-sheet-btn solid" id="svUsePhoto">Use photo</button>' +
      '</div>');
    const img = document.querySelector('#svSheet .sv-review img');
    if (img) img.src = cropped;
    document.getElementById('svRetake').addEventListener('click', () => { close(); shelfStartCapture(bookId); });
    document.getElementById('svUsePhoto').addEventListener('click', () => {
      if (bookId) {
        shelfAssignPhoto(bookId, cropped);
      } else {
        pendingSpinePhoto = cropped;
        renderShelf();
        toast('Photo ready — tap a spine to place it');
      }
    });
  });
}

// Crop a photo data URL to spine aspect at targetW wide, JPEG-encoded.
// Never rejects: falls back to the original on any failure.
function spineCropToDataURL(dataUrl, targetW) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const safety = setTimeout(() => done(dataUrl), 8000);
    try {
      const img = new Image();
      img.onload = () => {
        clearTimeout(safety);
        try {
          const r = spineCropRect(img.naturalWidth || img.width, img.naturalHeight || img.height);
          const targetH = Math.max(1, Math.round(targetW * (r.h / r.w)));
          const c = document.createElement('canvas');
          c.width = targetW; c.height = targetH;
          c.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, targetW, targetH);
          done(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { done(dataUrl); }
      };
      img.onerror = () => { clearTimeout(safety); done(dataUrl); };
      img.src = dataUrl;
    } catch (e) { clearTimeout(safety); done(dataUrl); }
  });
}

function shelfAssignPhoto(bookId, dataUrl) {
  const book = (typeof library !== 'undefined' ? library : []).find(b => b && b.id === bookId);
  if (!book) return;
  book.spinePhoto = dataUrl;
  saveLibrary();
  renderShelf();
  toast('Spine photo saved');
}
