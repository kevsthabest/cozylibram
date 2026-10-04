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

/* ---------------- poses & decorations (v252) ---------------- */

// Per-book display pose: 'up' (spine, default), 'down' (laid flat in a
// stack), 'face' (cover facing out, bookstore style). Stored on the book so
// it syncs; 'up' is the absence of the field.
const SHELF_POSES = ['up', 'down', 'face'];
function shelfPoseOf(book) {
  const p = book && book.shelfPose;
  return p === 'down' || p === 'face' ? p : 'up';
}
function shelfSetPose(book, pose) {
  if (!book) return;
  if (pose === 'up') delete book.shelfPose; else book.shelfPose = pose;
  saveLibrary();
  renderShelf();
}

// Decoration registry: id -> label, HTML, reserved width.
const SHELF_DECOR = {
  plant: { label: 'Plant', w: 76,
    html: '<div class="sv-decor sv-plant" aria-hidden="true"><div class="leaves"><i></i><i></i><i></i><i></i></div><div class="pot"></div></div>' },
  candle: { label: 'Candle', w: 56,
    html: '<div class="sv-decor sv-candle" aria-hidden="true"><div class="flame"></div><div class="wax"></div><div class="plate"></div></div>' },
  mug: { label: 'Mug', w: 64,
    html: '<div class="sv-decor sv-mug" aria-hidden="true"><div class="steam"><i></i><i></i></div><div class="cup"><i class="handle"></i></div></div>' },
  books: { label: 'Book stack', w: 118,
    html: '<div class="sv-decor sv-dstack" aria-hidden="true"><div class="sv-dbook"></div><div class="sv-dbook"></div><div class="sv-dbook"></div></div>' },
  lights: { label: 'Fairy lights', w: 110,
    html: '<div class="sv-decor sv-lights" aria-hidden="true"><svg viewBox="0 0 110 34">' +
      '<path d="M4 6 Q 55 34 106 6" stroke="#6b5a48" stroke-width="1.5" fill="none"/>' +
      [[18, 12], [36, 19], [55, 21.5], [74, 19], [92, 12]].map(function (pt, i) {
        return '<circle cx="' + pt[0] + '" cy="' + pt[1] + '" r="3.2" fill="#ffd76a" class="tw" style="animation-delay:' + (i * 0.4) + 's"/>';
      }).join('') + '</svg></div>' },
  // v255: seasonal sets — only offered while their season is active.
  pumpkin: { label: 'Pumpkin', w: 44, season: 'halloween',
    html: '<span class="sv-decor" style="font-size:30px" title="Pumpkin">🎃</span>' },
  ghost: { label: 'Ghost', w: 40, season: 'halloween',
    html: '<span class="sv-decor" style="font-size:30px" title="Ghost">👻</span>' },
  bat: { label: 'Bat', w: 44, season: 'halloween',
    html: '<span class="sv-decor" style="font-size:26px" title="Bat">🦇</span>' },
  tree: { label: 'Christmas tree', w: 46, season: 'christmas',
    html: '<span class="sv-decor" style="font-size:32px" title="Christmas tree">🎄</span>' },
  snowman: { label: 'Snowman', w: 44, season: 'christmas',
    html: '<span class="sv-decor" style="font-size:30px" title="Snowman">⛄</span>' },
  stocking: { label: 'Stocking', w: 40, season: 'christmas',
    html: '<span class="sv-decor" style="font-size:28px" title="Stocking">🧦</span>' },
  // v256: New Year's
  fireworks: { label: 'Fireworks', w: 44, season: 'newyear',
    html: '<span class="sv-decor" style="font-size:30px" title="Fireworks">🎆</span>' },
  champagne: { label: 'Champagne', w: 40, season: 'newyear',
    html: '<span class="sv-decor" style="font-size:30px" title="Champagne">🥂</span>' },
  popper: { label: 'Party popper', w: 40, season: 'newyear',
    html: '<span class="sv-decor" style="font-size:28px" title="Party popper">🎉</span>' },
  // v256: Valentine's
  rose: { label: 'Rose', w: 40, season: 'valentine',
    html: '<span class="sv-decor" style="font-size:30px" title="Rose">🌹</span>' },
  hearts: { label: 'Hearts', w: 44, season: 'valentine',
    html: '<span class="sv-decor" style="font-size:28px" title="Hearts">💕</span>' },
  loveletter: { label: 'Love letter', w: 40, season: 'valentine',
    html: '<span class="sv-decor" style="font-size:28px" title="Love letter">💌</span>' },
  // v256: St. Patrick's
  shamrock: { label: 'Shamrock', w: 40, season: 'stpatrick',
    html: '<span class="sv-decor" style="font-size:30px" title="Shamrock">☘️</span>' },
  rainbow: { label: 'Rainbow', w: 46, season: 'stpatrick',
    html: '<span class="sv-decor" style="font-size:30px" title="Rainbow">🌈</span>' },
  clover: { label: 'Four-leaf clover', w: 40, season: 'stpatrick',
    html: '<span class="sv-decor" style="font-size:30px" title="Four-leaf clover">🍀</span>' },
  // v256: Easter
  bunny: { label: 'Bunny', w: 42, season: 'easter',
    html: '<span class="sv-decor" style="font-size:30px" title="Bunny">🐰</span>' },
  easteregg: { label: 'Easter egg', w: 40, season: 'easter',
    html: '<span class="sv-decor" style="font-size:30px" title="Easter egg">🥚</span>' },
  chick: { label: 'Chick', w: 40, season: 'easter',
    html: '<span class="sv-decor" style="font-size:28px" title="Chick">🐣</span>' },
  // v256: Thanksgiving (Canadian)
  turkey: { label: 'Turkey', w: 46, season: 'thanksgiving',
    html: '<span class="sv-decor" style="font-size:30px" title="Turkey">🦃</span>' },
  pie: { label: 'Pumpkin pie', w: 42, season: 'thanksgiving',
    html: '<span class="sv-decor" style="font-size:30px" title="Pumpkin pie">🥧</span>' },
  leaves: { label: 'Autumn leaves', w: 44, season: 'thanksgiving',
    html: '<span class="sv-decor" style="font-size:28px" title="Autumn leaves">🍂</span>' },
};
const SHELF_DECOR_ORDER = ['plant', 'candle', 'mug', 'books', 'lights',
  'pumpkin', 'ghost', 'bat', 'tree', 'snowman', 'stocking',
  'fireworks', 'champagne', 'popper', 'rose', 'hearts', 'loveletter',
  'shamrock', 'rainbow', 'clover', 'bunny', 'easteregg', 'chick',
  'turkey', 'pie', 'leaves'];
// v255: seasonal shelf themes. Each season unlocks its decor set and
// restyles the boards; the shelf picks one by date until overridden.
// v256: New Year's, Valentine's, St. Patrick's, Easter, Thanksgiving.
const SHELF_SEASONS = {
  none: { label: 'All year', icon: '📚', decor: [] },
  newyear: { label: "New Year's", icon: '🎆', decor: ['fireworks', 'champagne', 'popper'] },
  valentine: { label: "Valentine's", icon: '💕', decor: ['rose', 'hearts', 'loveletter'] },
  stpatrick: { label: "St. Patrick's", icon: '☘️', decor: ['shamrock', 'rainbow', 'clover'] },
  easter: { label: 'Easter', icon: '🐰', decor: ['bunny', 'easteregg', 'chick'] },
  thanksgiving: { label: 'Thanksgiving', icon: '🦃', decor: ['turkey', 'pie', 'leaves'] },
  halloween: { label: 'Halloween', icon: '🎃', decor: ['pumpkin', 'ghost', 'bat'] },
  christmas: { label: 'Christmas', icon: '🎄', decor: ['tree', 'snowman', 'stocking'] },
};

// Easter Sunday via the Anonymous Gregorian algorithm (valid 1583-4099).
function shelfEasterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
// Canadian Thanksgiving: second Monday of October.
function shelfCanadianThanksgiving(year) {
  const first = new Date(year, 9, 1);
  return new Date(year, 9, 1 + ((8 - first.getDay()) % 7) + 7);
}
// Active shelf season (device-local): auto-detected by date until the
// user picks one explicitly in the decorations tray.
function shelfDefaultSeason(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const t = new Date(y, d.getMonth(), d.getDate()).getTime();
  const inRange = (m0, d0, m1, d1) =>
    t >= new Date(y, m0, d0).getTime() && t <= new Date(y, m1, d1).getTime();
  if (inRange(11, 27, 11, 31) || inRange(0, 1, 0, 7)) return 'newyear';
  if (inRange(1, 1, 1, 14)) return 'valentine';
  if (inRange(2, 10, 2, 17)) return 'stpatrick';
  const eas = shelfEasterSunday(y).getTime();
  if (t >= eas - 7 * 864e5 && t <= eas) return 'easter';
  const th = shelfCanadianThanksgiving(y).getTime();
  if (t >= th - 7 * 864e5 && t <= th) return 'thanksgiving';
  if (d.getMonth() === 9) return 'halloween';
  if (d.getMonth() === 11) return 'christmas';
  return 'none';
}
function shelfSeason() {
  const o = shelfOrder();
  return (o.season && SHELF_SEASONS[o.season]) ? o.season : shelfDefaultSeason();
}
function shelfSetSeason(s) {
  if (!SHELF_SEASONS[s]) return;
  const o = shelfOrder();
  o.season = s;
  saveShelfOrder(o);
  shelfOrderCache = o;
}
// Decorations the tray offers right now: year-round + the active season's set.
function shelfTrayDecor() {
  const seasonal = (SHELF_SEASONS[shelfSeason()] || {}).decor || [];
  return SHELF_DECOR_ORDER.filter(id => {
    const dec = SHELF_DECOR[id];
    return dec && (!dec.season || seasonal.indexOf(id) !== -1);
  });
}

// Decorations, v254: ordered instances [{d, at}] where `at` is the number
// of book-items before the instance in the flat layout (0 = very start).
// Decorations are shelf furniture: they keep their slot while books are
// rearranged around them. Drag a decoration anywhere; long-press removes it.
// Migrates the v252 plain-id arrays (treated as end-of-shelf).
function shelfDecorRaw(group) {
  const o = shelfOrder();
  if (!o.decor) o.decor = {};
  if (!Array.isArray(o.decor[group])) {
    o.decor[group] = [{ d: 'plant', at: 1e9 }, { d: 'candle', at: 1e9 }];
  }
  return o.decor[group];
}
function shelfDecorItems(group) {
  return shelfDecorRaw(group)
    .map(x => (typeof x === 'string' ? { d: x, at: 1e9 } : x))
    .filter(x => x && SHELF_DECOR[x.d])
    .map(x => ({ d: x.d, at: Math.max(0, x.at | 0) }));
}
function shelfSaveDecor(group, list) {
  const o = shelfOrder();
  if (!o.decor) o.decor = {};
  o.decor[group] = list;
  saveShelfOrder(o);
  shelfOrderCache = o;
}
function shelfDecorAdd(group, decorId, bookCount) {
  if (!SHELF_DECOR[decorId]) return;
  const list = shelfDecorItems(group);
  if (list.filter(x => x.d === decorId).length >= 3 || list.length >= 6) return;
  list.push({ d: decorId, at: bookCount });
  shelfSaveDecor(group, list);
}
function shelfDecorRemove(group, di) {
  const list = shelfDecorItems(group);
  list.splice(di, 1);
  shelfSaveDecor(group, list);
}
function shelfDecorMove(group, di, at) {
  const list = shelfDecorItems(group);
  if (!list[di]) return;
  list[di] = { d: list[di].d, at: Math.max(0, at | 0) };
  shelfSaveDecor(group, list);
}
// Pure: splice decor instances into the flat book-item list at their `at`
// slots (counted in book-items, decor items don't shift each other).
function shelfMergeDecor(bookItems, decors) {
  const items = bookItems.slice();
  (decors || []).forEach((dec, di) => {
    if (!SHELF_DECOR[dec.d]) return;
    let seen = 0, idx = items.length;
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'decor') continue;
      seen++;
      if (seen > dec.at) { idx = i; break; }
    }
    items.splice(idx, 0, { kind: 'decor', decorId: dec.d, di, w: SHELF_DECOR[dec.d].w });
  });
  return items;
}

// Flat layout items from ordered books: consecutive laid-down books form
// one horizontal stack (max 4); face-outs and uprights are single items.
function shelfLayoutItems(books) {
  const items = [];
  let pending = [];
  const flush = () => {
    if (pending.length) {
      items.push({ kind: 'stack', books: pending.splice(0), w: 132 });
    }
  };
  (books || []).forEach(b => {
    const pose = shelfPoseOf(b);
    if (pose === 'down') {
      pending.push(b);
      if (pending.length >= 4) flush();
    } else {
      flush();
      items.push({
        kind: pose === 'face' ? 'face' : 'spine',
        books: [b],
        w: pose === 'face' ? 128 : shelfSpineSpec(b).w + 4,
      });
    }
  });
  flush();
  return items;
}

// Greedy row fill by pixel budget.
function shelfFillRows(items, budget) {
  const rows = [];
  let cur = [], used = 0;
  (items || []).forEach(it => {
    if (cur.length && used + it.w > budget) { rows.push(cur); cur = []; used = 0; }
    cur.push(it);
    used += it.w;
  });
  if (cur.length) rows.push(cur);
  return rows;
}

/* ---------------- view ---------------- */

let shelfGroup = 'tbr';
let shelfOrderCache = null;
let pendingSpinePhoto = null; // cropped data URL waiting for the user to tap a spine
let pendingSpinePhotoAi = false; // v259: was it an AI-verified tight crop? (shareable)
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
  // v254: a whisper of tilt (±1°) so the shelf feels hand-placed, not stamped.
  const tilt = (((shelfHash(book.id + '|tilt') % 5) - 2) * 0.5).toFixed(1);
  const geom = 'width:' + spec.w + 'px;height:' + spec.h + 'px;transform:rotate(' + tilt + 'deg);';
  if (book.spinePhoto) {
    return '<div class="spine photo" data-id="' + esc(book.id) + '" style="' + geom +
      'background-image:url(&quot;' + book.spinePhoto + '&quot;)" title="' + esc(title) + '">' +
      '<span class="phototag">' + icon('camera') + '</span></div>';
  }
  return '<div class="spine" data-id="' + esc(book.id) + '" style="' + geom +
    'background:linear-gradient(90deg,' + spec.c2 + ',' + spec.c1 + ' 55%,' + spec.c2 + ')"' +
    ' title="' + esc(title) + '">' +
    '<span class="sp-pages" aria-hidden="true"></span>' +
    '<span class="sp-t">' + esc(title) + '</span>' +
    (author ? '<span class="sp-a">' + esc(author) + '</span>' : '') + '</div>';
}

function shelfFaceHTML(book) {
  const spec = shelfSpineSpec(book);
  const title = book.title || 'Untitled';
  const inner = book.cover
    ? '<img src="' + esc(book.cover) + '" alt="" loading="lazy" draggable="false">'
    : '<div class="faceout-gen" style="background:linear-gradient(135deg,' + spec.c1 + ',' + spec.c2 + ')"><span>' + esc(title) + '</span></div>';
  return '<div class="faceout" data-id="' + esc(book.id) + '" title="' + esc(title) + '">' + inner + '</div>';
}

function shelfStackHTML(books) {
  const ids = books.map(b => b.id).join(',');
  const top = books[books.length - 1] || {};
  const layers = books.map(b => {
    const spec = shelfSpineSpec(b);
    const w = 96 + ((shelfHash(b.id) >>> 5) % 24);
    return '<div class="sv-hbook" style="width:' + w + 'px;background:linear-gradient(180deg,' +
      spec.c1 + ',' + spec.c2 + ')"><span>' + esc(b.title || 'Untitled') + '</span></div>';
  }).join('');
  // Interactions apply to the top book of the stack.
  return '<div class="hstack" data-ids="' + esc(ids) + '" data-id="' + esc(top.id || '') +
    '" title="' + esc(top.title || 'Untitled') + '">' + layers + '</div>';
}

function shelfItemHTML(item) {
  if (item.kind === 'face') return shelfFaceHTML(item.books[0]);
  if (item.kind === 'stack') return shelfStackHTML(item.books);
  if (item.kind === 'decor') {
    return '<div class="sv-dragdecor" data-decor="' + item.decorId + '" data-di="' + item.di +
      '" title="' + SHELF_DECOR[item.decorId].label + '">' + SHELF_DECOR[item.decorId].html + '</div>';
  }
  return shelfSpineHTML(item.books[0]);
}

function renderShelf() {
  const books = typeof library !== 'undefined' ? library : [];
  const counts = {};
  SHELF_GROUPS.forEach(g => { counts[g] = shelfGroupBooks(books, g).length; });
  const shown = shelfBooks();
  // v259: adopt shared spine photos for ISBN books missing one — one lookup
  // per book per session; a hit saves and re-renders.
  if (typeof spinePhotoAdopt === 'function') {
    shown.forEach(b => {
      if (b && !b.spinePhoto && spinePhotoISBN(b) && !spineLookupDone.has(b.id)) {
        spinePhotoAdopt(b).then(hit => { if (hit) renderShelf(); }).catch(() => {});
      }
    });
  }
  const bookItems = shelfLayoutItems(shown);
  const items = shelfMergeDecor(bookItems, shelfDecorItems(shelfGroup));
  const vw = ((document.getElementById('view') || {}).clientWidth || 360);
  const hasDecor = items.some(i => i.kind === 'decor');
  const budget = Math.max(250, Math.min(430, vw)) - 44 - (hasDecor ? 90 : 0);
  const rows = shelfFillRows(items, budget);
  let shelvesHTML;
  if (!shown.length) {
    shelvesHTML = '<div class="sv-empty">' + icon('shelf') +
      '<p>Nothing on this shelf yet.</p>' +
      '<button class="btn" id="svEmptyAdd">Add a book</button></div>';
  } else {
    shelvesHTML = rows.map((row) =>
      '<div class="sv-shelf"><div class="sv-books">' +
      row.map(shelfItemHTML).join('') +
      '</div><div class="sv-board"></div><div class="sv-shadow"></div></div>'
    ).join('');
  }
  setView(
    '<div class="shelfview">' +
    '<div class="sv-head"><h2>Shelf</h2><div class="sv-head-btns">' +
    '<button class="sv-cam" id="svDecor" aria-label="Shelf decorations">' + icon('sparkles') + '</button>' +
    '<button class="sv-cam" id="svCam" aria-label="Photograph a book spine">' + icon('camera') + '</button></div></div>' +
    '<div class="sv-chips">' + SHELF_GROUPS.map(g =>
      '<button class="sv-chip' + (g === shelfGroup ? ' active' : '') + '" data-g="' + g + '">' +
      SHELF_GROUP_LABEL[g] + ' <span class="n">' + counts[g] + '</span></button>').join('') + '</div>' +
    (pendingSpinePhoto
      ? '<div class="sv-assign">' + icon('camera') + ' Tap a spine to place this photo' +
        ' <button id="svAssignCancel">Cancel</button></div>'
      : '') +
    '<div class="sv-shelves season-' + shelfSeason() + '" id="svShelves">' + shelvesHTML + '</div>' +
    (shown.length
      ? '<div class="sv-hint">Drag to rearrange &middot; long-press a book for display &amp; photo options</div>'
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
  const decorBtn = document.getElementById('svDecor');
  if (decorBtn) decorBtn.addEventListener('click', () => shelfOpenDecorSheet());
  const emptyAdd = document.getElementById('svEmptyAdd');
  if (emptyAdd) emptyAdd.addEventListener('click', () => go('add'));
  const cancel = document.getElementById('svAssignCancel');
  if (cancel) cancel.addEventListener('click', () => { pendingSpinePhoto = null; pendingSpinePhotoAi = false; renderShelf(); });
  const shelves = document.getElementById('svShelves');
  if (!shelves) return;
  shelves.querySelectorAll('.spine, .faceout, .hstack, .sv-dragdecor').forEach(sp => {
    sp.addEventListener('pointerdown', e => shelfPointerDown(e, sp));
    sp.addEventListener('click', e => shelfSpineClick(e, sp));
  });
}

function shelfPointerDown(e, sp) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const isDecor = sp.hasAttribute('data-decor');
  const id = sp.dataset.id;
  const d = shelfDrag = {
    id, el: sp, x0: e.clientX, y0: e.clientY, live: false, ghost: null, ph: null,
    isDecor, di: Number(sp.dataset.di),
    timer: setTimeout(() => {
      shelfCleanupDragListeners(d);
      shelfDrag = null;
      shelfIgnoreClickUntil = Date.now() + 600;
      try { if (navigator.vibrate) navigator.vibrate(25); } catch (_) {}
      if (isDecor) shelfOpenDecorRemoveSheet(Number(sp.dataset.di));
      else shelfOpenPhotoSheet(id);
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
  const spines = Array.from(document.querySelectorAll(
    '#svShelves .spine, #svShelves .faceout, #svShelves .hstack, #svShelves .sv-dragdecor'))
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
  if (d.isDecor) {
    // Decorations keep a book-index slot: count book-items before the
    // placeholder in flat DOM order, then re-render from data.
    let at = 0;
    const els = [];
    document.querySelectorAll('#svShelves .sv-books').forEach(row => {
      Array.from(row.children).forEach(el => els.push(el));
    });
    for (const el of els) {
      if (el === d.ph) break;
      if (el.classList.contains('spine') || el.classList.contains('faceout') ||
          el.classList.contains('hstack')) at++;
    }
    if (d.ghost) d.ghost.remove();
    if (d.ph) d.ph.remove();
    shelfIgnoreClickUntil = Date.now() + 400;
    shelfDecorMove(shelfGroup, d.di, at);
    renderShelf();
    return;
  }
  if (d.ph.parentNode) d.ph.parentNode.insertBefore(d.el, d.ph);
  d.el.classList.remove('drag-src');
  if (d.ghost) d.ghost.remove();
  if (d.ph) d.ph.remove();
  // Read the flat DOM order across all rows — stacks expand back to ids.
  const ids = [];
  document.querySelectorAll('#svShelves .sv-books').forEach(row => {
    Array.from(row.children).forEach(el => {
      if (el.classList.contains('hstack') && el.dataset.ids) {
        el.dataset.ids.split(',').forEach(id => { if (id) ids.push(id); });
      } else if (el.dataset && el.dataset.id) {
        ids.push(el.dataset.id);
      }
    });
  });
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
  if (sp.hasAttribute('data-decor')) return; // decorations: drag/long-press only
  const id = sp.dataset.id;
  if (pendingSpinePhoto) {
    const url = pendingSpinePhoto;
    const ai = pendingSpinePhotoAi;
    pendingSpinePhoto = null;
    pendingSpinePhotoAi = false;
    shelfAssignPhoto(id, url);
    const bk = (typeof library !== 'undefined' ? library : []).find(b => b && b.id === id);
    if (ai && bk) spinePhotoShare(bk, url, true); // v259: contribute the anonymous crop
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
  // rAF is unavailable in some test DOMs — fall back to a direct class add.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => sheet.classList.add('open'));
  else sheet.classList.add('open');
  const close = () => shelfCloseSheet();
  scrim.addEventListener('click', close);
  if (typeof overlayOpened === 'function') shelfSheetToken = overlayOpened('shelf-photo', close);
  return { sheet, close };
}

// Long-press action sheet for one book: display pose + spine photo.
function shelfOpenPhotoSheet(id) {
  const book = (typeof library !== 'undefined' ? library : []).find(b => b && b.id === id);
  if (!book) return;
  const pose = shelfPoseOf(book);
  const { sheet, close } = shelfSheetShell(esc(book.title || 'Untitled'),
    '<div class="sv-seg" role="group" aria-label="Display style">' +
    [['up', 'Upright'], ['down', 'Laid down'], ['face', 'Face out']].map(p =>
      '<button data-pose="' + p[0] + '" class="' + (pose === p[0] ? 'active' : '') + '">' + p[1] + '</button>'
    ).join('') + '</div>' +
    '<button class="sv-sheet-btn" id="svPhotoTake">' + icon('camera') + ' Photograph spine</button>' +
    (book.spinePhoto
      ? '<button class="sv-sheet-btn danger" id="svPhotoRemove">Remove spine photo</button>' : '') +
    '<button class="sv-sheet-btn ghost" id="svSheetCancel">Cancel</button>');
  sheet.querySelectorAll('[data-pose]').forEach(b =>
    b.addEventListener('click', () => {
      shelfSetPose(book, b.dataset.pose); // re-renders #view; the sheet lives on body
      sheet.querySelectorAll('[data-pose]').forEach(x => x.classList.toggle('active', x === b));
    }));
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

// Decorations tray: tap to add an instance (up to 3 per kind); drag it
// anywhere on the shelf; long-press it to remove. Season chips switch the
// seasonal theme and unlock its decorations.
function shelfOpenDecorSheet() {
  const group = shelfGroup;
  const { sheet, close } = shelfSheetShell('Decorations',
    '<p class="sv-review-hint">Tap to add to your ' + SHELF_GROUP_LABEL[group] +
    ' shelves — drag decorations anywhere, long-press one to remove it</p>' +
    '<div class="sv-season-row" id="svSeasonRow"></div>' +
    '<div class="sv-decor-grid" id="svDecorGrid"></div>' +
    '<button class="sv-sheet-btn ghost" id="svDecorDone">Done</button>');
  const paintSeasons = () => {
    const cur = shelfSeason();
    const row = document.getElementById('svSeasonRow');
    if (!row) return;
    row.innerHTML = Object.keys(SHELF_SEASONS).map(s =>
      '<button class="sv-season-chip' + (s === cur ? ' active' : '') + '" data-s="' + s + '">' +
      SHELF_SEASONS[s].icon + ' ' + SHELF_SEASONS[s].label + '</button>'
    ).join('');
    row.querySelectorAll('[data-s]').forEach(ch =>
      ch.addEventListener('click', () => {
        shelfSetSeason(ch.dataset.s);
        paintSeasons();
        paintChips();
        renderShelf();
      }));
  };
  const paintChips = () => {
    const counts = {};
    shelfDecorItems(group).forEach(x => { counts[x.d] = (counts[x.d] || 0) + 1; });
    const grid = document.getElementById('svDecorGrid');
    if (!grid) return;
    grid.innerHTML = shelfTrayDecor().map(id =>
      '<button class="sv-decor-chip' + (counts[id] ? ' active' : '') + '" data-d="' + id + '">' +
      SHELF_DECOR[id].label + (counts[id] ? ' <span class="n">×' + counts[id] + '</span>' : '') + '</button>'
    ).join('');
    grid.querySelectorAll('[data-d]').forEach(ch =>
      ch.addEventListener('click', () => {
        shelfDecorAdd(group, ch.dataset.d, shelfBooks().length);
        paintChips();
        renderShelf(); // refresh the shelves behind the sheet
      }));
  };
  paintSeasons();
  paintChips();
  document.getElementById('svDecorDone').addEventListener('click', close);
}

// Long-press a decoration: offer removal.
function shelfOpenDecorRemoveSheet(di) {
  const items = shelfDecorItems(shelfGroup);
  const it = items[di];
  if (!it || !SHELF_DECOR[it.d]) return;
  const label = SHELF_DECOR[it.d].label;
  const { close } = shelfSheetShell(esc(label),
    '<button class="sv-sheet-btn danger" id="svDecorRm">Remove from shelf</button>' +
    '<button class="sv-sheet-btn ghost" id="svDecorCancel">Cancel</button>');
  document.getElementById('svDecorCancel').addEventListener('click', close);
  document.getElementById('svDecorRm').addEventListener('click', () => {
    shelfDecorRemove(shelfGroup, di);
    close();
    renderShelf();
    toast(label + ' removed');
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
  // Downscale (reuse the vision pipeline's safe resizer), then let the AI
  // find the spine's tight box and pre-fit the crop to it — falling back
  // to the center strip when detection finds nothing usable.
  const down = (typeof visionDownscale === 'function')
    ? visionDownscale(dataUrl, 600) : Promise.resolve(dataUrl);
  if (typeof toast === 'function') toast('Finding the spine…');
  down.then(d => spineDetectBox(d).then(box => ({ d, box }))).then(({ d, box }) => {
    const cropP = (box && typeof spineBoxPhotoToDataURL === 'function')
      ? spineBoxPhotoToDataURL(d, box.x0, box.x1, 168, box.y0, box.y1).then(c => c || spineCropToDataURL(d, 168))
      : spineCropToDataURL(d, 168);
    return cropP.then(cropped => ({ cropped, ai: !!box }));
  }).then(({ cropped, ai }) => {
    const book = (typeof library !== 'undefined' ? library : []).find(b => b && b.id === bookId);
    const { close } = shelfSheetShell('Spine photo' + (book ? ' — ' + esc(book.title || '') : ''),
      '<div class="sv-review"><img alt="Cropped spine photo"></div>' +
      '<p class="sv-review-hint">' + (ai ? 'AI found the spine — look right?' : 'Cropped to the spine — look right?') + '</p>' +
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
        const bk = (typeof library !== 'undefined' ? library : []).find(b => b && b.id === bookId);
        if (ai && bk) spinePhotoShare(bk, cropped, true); // v259: contribute the anonymous crop
      } else {
        pendingSpinePhoto = cropped;
        pendingSpinePhotoAi = ai;
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
          done(shelfDrawCrop(img, r, targetW) || dataUrl);
        } catch (e) { done(dataUrl); }
      };
      img.onerror = () => { clearTimeout(safety); done(dataUrl); };
      img.src = dataUrl;
    } catch (e) { clearTimeout(safety); done(dataUrl); }
  });
}

// Pixel rect for a 0-1000 spine box on a w×h photo: the box at full size,
// then the 1:5.2 spine aspect fitted inside it. y0/y1 are optional — when
// absent the full image height is used (v253 behavior).
// Returns null when the box is unusable (missing, inverted, a sliver).
function spineBoxCropRect(w, h, x0, x1, y0, y1) {
  if (x0 == null || x1 == null || x0 === '' || x1 === '') return null;
  x0 = Number(x0); x1 = Number(x1);
  if (!isFinite(x0) || !isFinite(x1)) return null;
  x0 = Math.max(0, Math.min(1000, x0));
  x1 = Math.max(0, Math.min(1000, x1));
  if (x1 - x0 < 5) return null;
  let yt0 = 0, yt1 = 1000;
  if (y0 != null && y0 !== '' && y1 != null && y1 !== '') {
    const a = Number(y0), b = Number(y1);
    if (isFinite(a) && isFinite(b)) {
      yt0 = Math.max(0, Math.min(1000, a));
      yt1 = Math.max(0, Math.min(1000, b));
    }
  }
  if (yt1 - yt0 < 20) return null;
  const sx = Math.round(x0 / 1000 * w);
  const bw = Math.round(x1 / 1000 * w) - sx;
  const sy = Math.round(yt0 / 1000 * h);
  const bh = Math.round(yt1 / 1000 * h) - sy;
  const inner = spineCropRect(bw, bh);
  return { x: sx + inner.x, y: sy + inner.y, w: inner.w, h: inner.h };
}

// v259: shared spine-photo pool. AI-verified tight crops (never fallback
// center-crops, which may include background) are contributed automatically,
// keyed by ISBN. The crop contains no personal information by construction,
// so no opt-in is needed — the library itself stays private as before.
function spinePhotoISBN(book) {
  const raw = book && (book.isbn13 || book.isbn || '');
  const d = String(raw).replace(/[^0-9X]/gi, '').toUpperCase();
  return /^(?:\d{13}|\d{10}|\d{9}X)$/.test(d) ? d : null;
}
async function spinePhotoShare(book, dataUrl, aiCropped) {
  try {
    if (!aiCropped) return false; // safety: only anonymous tight crops
    const isbn = spinePhotoISBN(book);
    if (!isbn || typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) return false;
    const sb = await (typeof cloudClient === 'function' ? cloudClient().catch(() => null) : null);
    if (!sb) return false;
    const seen = await sb.from('spine_photos').select('isbn').eq('isbn', isbn).maybeSingle();
    if (seen && seen.data) return true; // already in the pool
    const blob = await (await fetch(dataUrl)).blob();
    const path = 'spines/' + isbn + '.jpg';
    const up = await sb.storage.from('spine-photos').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (up.error && up.error.statusCode !== '409' && !/exists/i.test(up.error.message || '')) return false;
    await sb.from('spine_photos').upsert({ isbn, path }, { onConflict: 'isbn', ignoreDuplicates: true });
    return true;
  } catch (e) { return false; }
}
// v259: adopt a shared spine photo for an ISBN book that has none.
// Best-effort; resolves true when a photo was adopted and saved.
const spineLookupDone = new Set();
async function spinePhotoAdopt(book) {
  try {
    if (!book || book.spinePhoto) return false;
    const isbn = spinePhotoISBN(book);
    if (!isbn || !book.id || spineLookupDone.has(book.id)) return false;
    spineLookupDone.add(book.id);
    const sb = await (typeof cloudClient === 'function' ? cloudClient().catch(() => null) : null);
    if (!sb) return false;
    const row = await sb.from('spine_photos').select('path').eq('isbn', isbn).maybeSingle();
    const path = row && row.data && row.data.path;
    if (!path) return false;
    const pub = sb.storage.from('spine-photos').getPublicUrl(path);
    const url = pub && pub.data && pub.data.publicUrl;
    if (!url) return false;
    const blob = await (await fetch(url)).blob();
    if (!blob || !blob.size) return false;
    const dataUrl = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ''));
      fr.onerror = () => res('');
      fr.readAsDataURL(blob);
    });
    if (dataUrl.indexOf('data:image') !== 0) return false;
    book.spinePhoto = dataUrl;
    if (typeof saveLibrary === 'function') saveLibrary();
    return true;
  } catch (e) { return false; }
}

// v258: ask the vision model for a tight box around the single prominent
// spine in a close-up photo. Resolves with {x0,y0,x1,y1} or null — never
// rejects, so the manual flow always falls back to the center crop.
// Failures are logged (Logs tab) with the reason instead of failing silent.
function spineDetectBox(dataUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v, reason) => {
      if (!settled) {
        settled = true;
        if (!v && reason && typeof AppLog !== 'undefined') {
          try { AppLog.error('spine', 'AI spine detect: ' + reason); } catch (e) {}
        }
        resolve(v);
      }
    };
    const safety = setTimeout(() => done(null, 'timed out after 25s'), 25000);
    try {
      const fetchFn = (typeof apiFetch === 'function') ? apiFetch : fetch;
      fetchFn('/api/read-cover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, mode: 'spine' }),
      }).then(r => {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(j => {
        clearTimeout(safety);
        const b = j && j.box;
        done(b && typeof b === 'object' ? b : null, b ? null : 'model found no spine in the photo');
      }).catch((e) => { clearTimeout(safety); done(null, 'request failed: ' + ((e && e.message) || e)); });
    } catch (e) { clearTimeout(safety); done(null, 'setup failed'); }
  });
}

// Shared canvas core: draw rect r of img into a targetW-wide JPEG data URL.
// A whisper of contrast/saturation counteracts the flat look of a crop.
function shelfDrawCrop(img, r, targetW) {
  try {
    const targetH = Math.max(1, Math.round(targetW * (r.h / r.w)));
    const c = document.createElement('canvas');
    c.width = targetW; c.height = targetH;
    const ctx = c.getContext('2d');
    try { ctx.filter = 'contrast(1.07) saturate(1.05)'; } catch (e) {}
    ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, targetW, targetH);
    return c.toDataURL('image/jpeg', 0.85);
  } catch (e) { return null; }
}

// Crop a 0-1000 x-range box out of a photo data URL to spine aspect.
// Resolves with a small JPEG data URL, or null when the box is unusable.
function spineBoxPhotoToDataURL(dataUrl, x0, x1, targetW, y0, y1) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v || null); } };
    const safety = setTimeout(() => done(null), 8000);
    try {
      const img = new Image();
      img.onload = () => {
        clearTimeout(safety);
        try {
          const r = spineBoxCropRect(img.naturalWidth || img.width, img.naturalHeight || img.height, x0, x1, y0, y1);
          done(r ? shelfDrawCrop(img, r, targetW) : null);
        } catch (e) { done(null); }
      };
      img.onerror = () => { clearTimeout(safety); done(null); };
      img.src = dataUrl;
    } catch (e) { clearTimeout(safety); done(null); }
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
