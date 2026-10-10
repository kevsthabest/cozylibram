'use strict';

/* ---- Shelf tab (v250): a 2.5D bookshelf ----
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

// v262: touch ergonomics. Finger jitter on a tap used to cross the tiny
// 10px drag threshold and start a drag, which then swallowed the tap —
// selection felt broken. The threshold is now generous. (v263: spine hit
// slop moved to a ::after pseudo-element in CSS — no JS box-model tricks.)
const SHELF_DRAG_SLOP_PX = 18;

// Deterministic spine geometry + palette slot for a book.
// v266: compact/showcase formats scale the geometry; inner text scales via
// the --svs CSS variable on #svShelves.
function shelfSpineSpec(book) {
  const h = shelfHash((book && book.id) || (book && book.title) || 'x');
  const pal = SHELF_PALETTE[h % SHELF_PALETTE.length];
  const s = (typeof shelfDensityScale === 'function') ? shelfDensityScale() : 1;
  return {
    c1: pal[0], c2: pal[1],
    w: Math.round((30 + ((h >>> 3) % 15)) * s), // >>> : h is uint32; >> would sign-extend
    h: Math.round((172 + ((h >>> 9) % 44)) * s),
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

// Shelf layouts, v261: 'manual' (hand-arranged, draggable), 'series'
// (series together in position order), 'genre' (shelves by primary
// category). Grouped layouts are auto-arranged — drag is disabled there.
function shelfLayout() {
  const o = shelfOrder();
  const l = o.layout;
  return l === 'series' || l === 'genre' ? l : 'manual';
}
function shelfSetLayout(l) {
  const o = shelfOrder();
  o.layout = (l === 'series' || l === 'genre') ? l : 'manual';
  saveShelfOrder(o);
  shelfOrderCache = o;
}
function shelfCanDrag() { return shelfLayout() === 'manual'; }
// Pure: bucket books into labeled sections for the active layout.
function shelfLayoutSections(books, layout) {
  const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''));
  if (layout === 'series') {
    const groups = new Map();
    books.forEach(b => {
      const name = b && b.series && b.series.name ? String(b.series.name) : '';
      const key = name ? 's:' + name.toLowerCase() : 's:';
      if (!groups.has(key)) groups.set(key, { label: name || 'Standalone', books: [] });
      groups.get(key).books.push(b);
    });
    const posNum = b => {
      const n = parseFloat(b && b.series && b.series.position);
      return isNaN(n) ? Infinity : n;
    };
    const arr = [...groups.values()];
    arr.forEach(g => g.books.sort((a, b) => (posNum(a) - posNum(b)) || byTitle(a, b)));
    // v400: cluster small series (<3 books) to avoid wasting planks
    const big = [], small = [];
    arr.forEach(g => {
      if (g.label === 'Standalone') big.push(g);
      else if (g.books.length >= 3) big.push(g);
      else small.push(g);
    });
    if (small.length) {
      const clustered = { label: 'More series', books: [] };
      small.sort((a, b) => a.label.localeCompare(b.label)).forEach(g => {
        clustered.books.push(...g.books);
      });
      big.push(clustered);
    }
    big.sort((a, b) => ((a.label === 'Standalone') - (b.label === 'Standalone')) || a.label.localeCompare(b.label));
    return big;
  }
  if (layout === 'genre') {
    const groups = new Map();
    books.forEach(b => {
      // v262: primary *genre* via bookGenres (strips format tags and library
      // subject headings), not the raw first category.
      const gs = (typeof bookGenres === 'function') ? bookGenres(b) : [];
      const c = gs.length ? String(gs[0]) : '';
      const key = c ? 'g:' + c.toLowerCase() : 'g:';
      if (!groups.has(key)) groups.set(key, { label: c || 'Unsorted', books: [] });
      groups.get(key).books.push(b);
    });
    const arr = [...groups.values()];
    arr.forEach(g => g.books.sort(byTitle));
    arr.sort((a, b) => ((a.label === 'Unsorted') - (b.label === 'Unsorted')) || a.label.localeCompare(b.label));
    return arr;
  }
  return [{ label: null, books: books.slice() }];
}

// Shelf formats, v266: 'standard' (classic full-width shelves), 'split'
// (two side-by-side shelf columns), 'compact' (smaller books, more per
// shelf), 'showcase' (bigger books, fewer per shelf).
function shelfFormat() {
  const o = shelfOrder();
  const f = o.format;
  return f === 'split' || f === 'compact' || f === 'showcase' ? f : 'standard';
}
function shelfSetFormat(f) {
  const o = shelfOrder();
  o.format = (f === 'split' || f === 'compact' || f === 'showcase') ? f : 'standard';
  saveShelfOrder(o);
  shelfOrderCache = o;
}
// Density multiplier applied to book geometry for compact/showcase.
function shelfDensityScale() {
  const f = shelfFormat();
  return f === 'compact' ? 0.72 : f === 'showcase' ? 1.35 : 1;
}
// Split format: distribute sections across two columns, balancing book
// count while preserving section order. Returns 1-2 columns.
function shelfSplitColumns(sections) {
  const cols = [[], []];
  const total = sections.reduce((n, s) => n + s.books.length, 0);
  let left = 0;
  sections.forEach(sec => {
    const c = (left < total / 2 || !cols[0].length) ? 0 : 1;
    cols[c].push(sec);
    if (c === 0) left += sec.books.length;
  });
  return cols[1].length ? cols : [cols[0]];
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
  summer: { label: 'Summer', icon: '☀️', decor: [] }, // v416 (T6): Solstice season — 2D tray shows year-round items; 3D has a Solstice preset
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
  if (d.getMonth() >= 5 && d.getMonth() <= 7) return 'summer'; // v416 (T6): Jun–Aug
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

// v267: split-format decoration merge. Splices decor instances into the flat
// visual sequence (left column's sections, then the right's) at their `at`
// slots, counted in book-items across the whole split view — the same order
// shelfDropGhost counts on drop, so dragging a decoration is WYSIWYG instead
// of piling everything at the end of the last column.
function shelfMergeDecorSplit(flatSections, decors) {
  (decors || []).forEach((dec, di) => {
    if (!SHELF_DECOR[dec.d]) return;
    const item = { kind: 'decor', decorId: dec.d, di, w: SHELF_DECOR[dec.d].w };
    let seen = 0, placed = false;
    for (const s of flatSections) {
      for (let i = 0; i < s.items.length; i++) {
        if (s.items[i].kind === 'decor') continue;
        seen++;
        if (seen > dec.at) { s.items.splice(i, 0, item); placed = true; break; }
      }
      if (placed) break;
    }
    if (!placed && flatSections.length) {
      flatSections[flatSections.length - 1].items.push(item);
    }
  });
}

// Flat layout items from ordered books: consecutive laid-down books form
// one horizontal stack (max 4); face-outs and uprights are single items.
function shelfLayoutItems(books) {
  const items = [];
  let pending = [];
  const ds = (typeof shelfDensityScale === 'function') ? shelfDensityScale() : 1;
  const flush = () => {
    if (pending.length) {
      items.push({ kind: 'stack', books: pending.splice(0), w: Math.round(132 * ds) });
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
        w: pose === 'face' ? Math.round(128 * ds) : shelfSpineSpec(b).w + 4,
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
/* v285: shelf photos are binary IDB assets, never book JSON. */
const shelfAssetUrls = new Map();
const shelfAssetPending = new Set();
function shelfSpineAssetId(book) {
  if (!book) return null;
  return book.spinePhotoAssetId ||
    (book.editionFaceRefs && book.editionFaceRefs.jacket && book.editionFaceRefs.jacket.spine) || null;
}
/* v286 (M2): resolve a binary asset ref to bytes. editionAssetBlob
   (js/208, sibling worker) resolves IDB-first with a network fallback from
   the public bucket and caches locally, so a ref synced from another device
   still renders. Until it lands, the local-only IDB read is the fallback;
   null keeps the generated placeholder. */
function shelfBlobFromRef(ref) {
  if (typeof editionAssetBlob === 'function') {
    try { return Promise.resolve(editionAssetBlob(ref)); } catch (e) { /* fall through */ }
  }
  const id = (ref && typeof ref === 'object') ? ref.assetId : ref;
  if (!id || typeof idbAssetGet !== 'function' || typeof currentDb === 'undefined' || !currentDb) {
    return Promise.resolve(null);
  }
  return idbAssetGet(currentDb, id).then(function (asset) {
    return (asset && asset.blob) || null;
  }).catch(function () { return null; });
}
function shelfEnsureSpineAsset(book) {
  const id = shelfSpineAssetId(book);
  if (!id || typeof currentDb === 'undefined' || !currentDb) return Promise.resolve(false);
  if (shelfAssetUrls.has(id)) return Promise.resolve(true);
  if (shelfAssetPending.has(id)) return Promise.resolve(false);
  shelfAssetPending.add(id);
  return shelfBlobFromRef(id).then(function (blob) {
    if (!blob) return false;
    if (shelfAssetUrls.has(id)) return true;
    shelfAssetUrls.set(id, URL.createObjectURL(blob));
    return true;
  }).catch(function () { return false; }).finally(function () {
    shelfAssetPending.delete(id);
  });
}


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
  var assetId = shelfSpineAssetId(book);
  var photoUrl = assetId ? shelfAssetUrls.get(assetId) : null;
  /* Legacy data URLs are display-only during migration; new saves never write them. */
  if (photoUrl || book.spinePhoto) {
    var bg = photoUrl || book.spinePhoto;
    return '<div class="spine photo" data-id="' + esc(book.id) + '" style="' + geom +
      'background-image:url(&quot;' + esc(bg) + '&quot;)" title="' + esc(title) + '">' +
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
    const ds = (typeof shelfDensityScale === 'function') ? shelfDensityScale() : 1;
    const w = Math.round((96 + ((shelfHash(b.id) >>> 5) % 24)) * ds);
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
  // v405: 3D shelf integration. Unmount any live 3D scene first (safe no-op
  // when not mounted), then branch to the 3D renderer when that's the
  // active view mode.
  if (typeof shelfUnmount3D === 'function') shelfUnmount3D();
  // v408: skip 3D if WebGL failed this session (don't keep retrying a broken context).
  const webglFailed = (typeof _shelf3dWebGLFailed !== 'undefined' && _shelf3dWebGLFailed);
  if (!webglFailed && typeof shelfViewMode === 'function' && shelfViewMode() === '3d' &&
      typeof renderShelf3D === 'function') {
    renderShelf3D();
    return;
  }
  const books = typeof library !== 'undefined' ? library : [];
  const counts = {};
  SHELF_GROUPS.forEach(g => { counts[g] = shelfGroupBooks(books, g).length; });
  const shown = shelfBooks();
  // v259: adopt shared spine photos for ISBN books missing one — one lookup
  // per book per session; a hit saves and re-renders.
  shown.forEach(function (b) {
    if (!b) return;
    var aid = shelfSpineAssetId(b);
    if (aid && !shelfAssetUrls.has(aid)) {
      shelfEnsureSpineAsset(b).then(function (hit) { if (hit) renderShelf(); }).catch(function () {});
    } else if (!aid && !b.spinePhoto && typeof spinePhotoAdopt === 'function' &&
               spinePhotoISBN(b) && !spineLookupDone.has(b.id)) {
      spinePhotoAdopt(b).then(function (hit) { if (hit) renderShelf(); }).catch(function () {});
    }
  });
  const bookItems = shelfLayoutItems(shown);
  const items = shelfMergeDecor(bookItems, shelfDecorItems(shelfGroup));
  const vw = ((document.getElementById('view') || {}).clientWidth || 360);
  const hasDecor = items.some(i => i.kind === 'decor');
  const budget = Math.max(250, Math.min(430, vw)) - 44 - (hasDecor ? 90 : 0);
  const rows = shelfFillRows(items, budget);
  const layout = shelfLayout();
  const format = shelfFormat();
  const rowHTML = (row) =>
    '<div class="sv-shelf"><div class="sv-books">' +
    row.map(shelfItemHTML).join('') +
    '</div><div class="sv-board"></div><div class="sv-shadow"></div></div>';
  const sectionHTML = (sec, secItems, secBudget) =>
    '<div class="sv-section">' +
    (sec.label ? '<div class="sv-section-label"><span>' + esc(sec.label) + '</span><em>' + sec.books.length + '</em></div>' : '') +
    shelfFillRows(secItems, secBudget).map(rowHTML).join('') + '</div>';
  let shelvesHTML;
  if (!shown.length) {
    shelvesHTML = '<div class="sv-empty">' + icon('shelf') +
      '<p>Nothing on this shelf yet.</p>' +
      '<button class="btn" id="svEmptyAdd">Add a book</button></div>';
  } else if (format === 'split') {
    // v266: two side-by-side shelf columns; each section stays whole in one
    // column, decorations ride the last section of the last column.
    const decors = shelfDecorItems(shelfGroup);
    let sections = shelfLayoutSections(shown, layout);
    if (layout === 'manual') {
      const half = Math.ceil(shown.length / 2);
      sections = [
        { label: null, books: shown.slice(0, half) },
        { label: null, books: shown.slice(half) },
      ].filter(s => s.books.length);
    }
    const colBudget = Math.max(120, Math.floor((Math.max(250, Math.min(430, vw)) - 58) / 2));
    const cols = shelfSplitColumns(sections);
    // v267: decorations flow with the whole split view in visual
    // (left-to-right) order — merge by `at` across every section, then hand
    // each section its slice back for rendering.
    const flat = [];
    cols.forEach(colSections => colSections.forEach(sec => {
      flat.push({ sec, items: shelfLayoutItems(sec.books) });
    }));
    shelfMergeDecorSplit(flat, decors);
    const flatItems = new Map(flat.map(s => [s.sec, s.items]));
    shelvesHTML = '<div class="sv-cols">' + cols.map(colSections =>
      '<div class="sv-col">' + colSections.map(sec =>
        sectionHTML(sec, flatItems.get(sec) || shelfLayoutItems(sec.books), colBudget)
      ).join('') + '</div>'
    ).join('') + '</div>';
  } else if (layout === 'manual') {
    shelvesHTML = rows.map(rowHTML).join('');
  } else {
    // Grouped layouts: labeled sections; decorations ride the last section.
    const decors = shelfDecorItems(shelfGroup);
    const sections = shelfLayoutSections(shown, layout);
    shelvesHTML = sections.map((sec, si) => {
      let secItems = shelfLayoutItems(sec.books);
      if (si === sections.length - 1) secItems = shelfMergeDecor(secItems, decors);
      return sectionHTML(sec, secItems, budget);
    }).join('');
  }
  setView(
    '<div class="shelfview">' +
    '<div class="sv-head"><h2>Shelf</h2><div class="sv-head-btns">' +
    '<button class="sv-cam" id="svView3D" aria-label="Switch to 3D view" title="Switch to 3D view">' + icon('cube') + '</button>' +
    '<button class="sv-cam" id="svLayout" aria-label="Shelf layout">' + icon('shelf') + '</button>' +
    '<button class="sv-cam" id="svDecor" aria-label="Shelf decorations">' + icon('sparkles') + '</button>' +
    '<button class="sv-cam" id="svCam" aria-label="Photograph a book spine">' + icon('camera') + '</button>' +
    '<button class="sv-cam" id="svMenu" aria-label="Shelf menu" title="Shelf menu">' + icon('dots') + '</button>' +
    '<div class="sv-menu" id="svMenuDropdown" hidden>' +
    '<button class="sv-menu-item" id="svMenuView">' + icon('cube') + '<span>Switch to 3D view</span></button>' +
    '<button class="sv-menu-item" id="svMenuDecor">' + icon('sparkles') + '<span>Decorations</span></button>' +
    '</div></div></div>' +
    '<div class="sv-chips">' + SHELF_GROUPS.map(g =>
      '<button class="sv-chip' + (g === shelfGroup ? ' active' : '') + '" data-g="' + g + '">' +
      SHELF_GROUP_LABEL[g] + ' <span class="n">' + counts[g] + '</span></button>').join('') + '</div>' +
    (pendingSpinePhoto
      ? '<div class="sv-assign">' + icon('camera') + ' Tap a spine to place this photo' +
        ' <button id="svAssignCancel">Cancel</button></div>'
      : '') +
    '<div class="sv-shelves season-' + shelfSeason() + '" id="svShelves"' +
    (shelfDensityScale() !== 1 ? ' style="--svs:' + shelfDensityScale() + '"' : '') +
    '>' + shelvesHTML + '</div>' +
    (shown.length
      ? '<div class="sv-hint">' + (shelfCanDrag()
        ? 'Drag to rearrange &middot; long-press a book for display &amp; photo options'
        : 'Grouped by ' + layout + ' &middot; switch to My order to rearrange') + '</div>'
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
  const layoutBtn = document.getElementById('svLayout');
  if (layoutBtn) layoutBtn.addEventListener('click', () => shelfOpenLayoutSheet());
  // v408: 3D view toggle — the 3D view has a 2D toggle, but 2D had no way back (launch-blocker).
  const view3DBtn = document.getElementById('svView3D');
  if (view3DBtn) view3DBtn.addEventListener('click', () => {
    if (typeof shelfSetViewMode === 'function') shelfSetViewMode('3d');
    // Clear the WebGL-failed session flag so 3D is retried.
    try { _shelf3dWebGLFailed = false; } catch (e) {}
    renderShelf();
  });
  // v411: overflow menu with shelf view toggle (Kevin: discoverable home for 2D/3D switch).
  const menuBtn = document.getElementById('svMenu');
  const menuDropdown = document.getElementById('svMenuDropdown');
  if (menuBtn && menuDropdown) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menuDropdown.hidden = !menuDropdown.hidden;
    });
    // Close menu when clicking outside.
    document.addEventListener('click', function closeMenu(e) {
      if (!menuDropdown.hidden && !menuDropdown.contains(e.target) && e.target !== menuBtn) {
        menuDropdown.hidden = true;
      }
    });
    const menuViewBtn = document.getElementById('svMenuView');
    if (menuViewBtn) menuViewBtn.addEventListener('click', () => {
      if (typeof shelfSetViewMode === 'function') shelfSetViewMode('3d');
      try { _shelf3dWebGLFailed = false; } catch (e) {}
      menuDropdown.hidden = true;
      renderShelf();
    });
    // v417: Decorations inventory in menu (Kevin: wasn't findable).
    const menuDecorBtn = document.getElementById('svMenuDecor');
    if (menuDecorBtn) menuDecorBtn.addEventListener('click', () => {
      menuDropdown.hidden = true;
      if (typeof shelfOpenDecorSheet === 'function') shelfOpenDecorSheet();
    });
  }
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
    if (!shelfCanDrag()) return; // v261: grouped layouts are auto-arranged
    const dx = ev.clientX - d.x0, dy = ev.clientY - d.y0;
    if (!d.live && Math.hypot(dx, dy) > SHELF_DRAG_SLOP_PX) {
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
  // v266: the ghost leaves #svShelves, so carry the density var with it.
  try { g.style.setProperty('--svs', shelfDensityScale()); } catch (e) {}
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
  if (typeof shelfStopCam === 'function') shelfStopCam(); // v260: never leave the camera running
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
  const curStatus = String(book.status || 'tbr');
  const { sheet, close } = shelfSheetShell(esc(book.title || 'Untitled'),
    '<div class="sv-seg" role="group" aria-label="Display style">' +
    [['up', 'Upright'], ['down', 'Laid down'], ['face', 'Face out']].map(p =>
      '<button data-pose="' + p[0] + '" class="' + (pose === p[0] ? 'active' : '') + '">' + p[1] + '</button>'
    ).join('') + '</div>' +
    // v400: move to shelf (status) from long-press menu
    '<div class="sv-seg" role="group" aria-label="Shelf">' +
    [['tbr', 'TBR'], ['reading', 'Reading'], ['read', 'Read']].map(s =>
      '<button data-shelf="' + s[0] + '" class="' + (curStatus === s[0] ? 'active' : '') + '">' + s[1] + '</button>'
    ).join('') + '</div>' +
    '<button class="sv-sheet-btn" id="svPhotoTake">' + icon('camera') + ' Photograph spine</button>' +
    /* M5: the button must also appear for binary spines (spinePhotoAssetId /
       editionFaceRefs), not just the legacy book.spinePhoto data URL. */
    ((book.spinePhoto || shelfSpineAssetId(book))
      ? '<button class="sv-sheet-btn danger" id="svPhotoRemove">Remove spine photo</button>' : '') +
    '<button class="sv-sheet-btn ghost" id="svSheetCancel">Cancel</button>');
  sheet.querySelectorAll('[data-pose]').forEach(b =>
    b.addEventListener('click', () => {
      shelfSetPose(book, b.dataset.pose); // re-renders #view; the sheet lives on body
      sheet.querySelectorAll('[data-pose]').forEach(x => x.classList.toggle('active', x === b));
    }));
  // v400: shelf move — update status and re-render
  sheet.querySelectorAll('[data-shelf]').forEach(b =>
    b.addEventListener('click', () => {
      const ns = b.dataset.shelf;
      if (ns !== book.status) {
        book.status = ns;
        book._mtime = Date.now();
        if (typeof saveLibrary === 'function') saveLibrary();
        if (typeof scheduleCloudPush === 'function') scheduleCloudPush();
        close();
        renderShelf();
      }
    }));
  document.getElementById('svSheetCancel').addEventListener('click', close);
  document.getElementById('svPhotoTake').addEventListener('click', () => { close(); shelfStartCapture(id); });
  const rm = document.getElementById('svPhotoRemove');
  if (rm) rm.addEventListener('click', () => {
    /* M5: binary spines live in IDB + editionFaceRefs, not book.spinePhoto.
       Clear every representation, drop the tracked object URL(s), and delete
       the IDB row(s) via idbAssetDelete (best effort) so replaced blobs
       never accumulate. */
    const ids = [];
    if (book.spinePhotoAssetId) ids.push(book.spinePhotoAssetId);
    const jr = book.editionFaceRefs && book.editionFaceRefs.jacket;
    if (jr && jr.spine) ids.push(jr.spine);
    ids.forEach(function (id) {
      if (shelfAssetUrls.has(id)) {
        try { URL.revokeObjectURL(shelfAssetUrls.get(id)); } catch (e) {}
        shelfAssetUrls.delete(id);
      }
      if (typeof idbAssetDelete === 'function' && typeof currentDb !== 'undefined' && currentDb) {
        try { idbAssetDelete(currentDb, id).catch(function () {}); } catch (e) {}
      }
    });
    delete book.spinePhoto;
    delete book.spinePhotoAssetId;
    if (book.editionFaceRefs && book.editionFaceRefs.jacket) {
      delete book.editionFaceRefs.jacket.spine;
      if (!Object.keys(book.editionFaceRefs.jacket).length) delete book.editionFaceRefs.jacket;
      if (!Object.keys(book.editionFaceRefs).length) delete book.editionFaceRefs;
    }
    if (book.id) spineLookupDone.add(book.id); // don't re-adopt from the pool this session
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

// Shelf layout picker: grouping + shelf format.
function shelfOpenLayoutSheet() {
  const cur = shelfLayout();
  const fmt = shelfFormat();
  const { sheet, close } = shelfSheetShell('Shelf layout',
    '<p class="sv-review-hint">Group your shelves automatically, or keep your hand-arranged order</p>' +
    '<div class="sv-layout-opts">' +
    [['manual', 'My order', 'Your arrangement — drag to rearrange'],
     ['series', 'By series', 'Series together, in reading order'],
     ['genre', 'By genre', 'One shelf per genre']].map(([k, t, d]) =>
      '<button class="sv-layout-opt' + (k === cur ? ' active' : '') + '" data-l="' + k + '">' +
      '<b>' + t + '</b><span>' + d + '</span></button>'
    ).join('') + '</div>' +
    '<p class="sv-review-hint" style="margin-top:14px">Shelf format</p>' +
    '<div class="sv-layout-opts">' +
    [['standard', 'Standard', 'Classic full-width shelves'],
     ['split', 'Split', 'Two side-by-side shelf columns'],
     ['compact', 'Compact', 'Smaller books, more per shelf'],
     ['showcase', 'Showcase', 'Bigger books, fewer per shelf']].map(([k, t, d]) =>
      '<button class="sv-layout-opt' + (k === fmt ? ' active' : '') + '" data-f="' + k + '">' +
      '<b>' + t + '</b><span>' + d + '</span></button>'
    ).join('') + '</div>');
  sheet.querySelectorAll('[data-l]').forEach(b =>
    b.addEventListener('click', () => {
      shelfSetLayout(b.dataset.l);
      close();
      renderShelf();
    }));
  sheet.querySelectorAll('[data-f]').forEach(b =>
    b.addEventListener('click', () => {
      shelfSetFormat(b.dataset.f);
      close();
      renderShelf();
    }));
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
  // v260: in-app viewfinder with a spine-alignment overlay when the camera
  // is available; otherwise the native picker.
  if (shelfCanUseCam()) shelfOpenViewfinder(bookId);
  else shelfNativeCapture(bookId);
}

function shelfCanUseCam() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

// The pre-v260 native picker, kept as the fallback (denied permission,
// desktop, or test DOMs).
function shelfNativeCapture(bookId) {
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

// v260: spine viewfinder — live preview with a spine-shaped guide
// frame so the spine lands centered. Capture grabs the frame straight into
// the existing review flow.
let shelfCamStream = null;
function shelfStopCam() {
  try {
    if (shelfCamStream) shelfCamStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
  } catch (e) {}
  shelfCamStream = null;
}
function shelfOpenViewfinder(bookId) {
  const { sheet, close } = shelfSheetShell('Center the spine',
    '<div class="sv-vf">' +
      '<video id="svVideo" playsinline muted autoplay></video>' +
      '<div class="sv-vf-mask" aria-hidden="true"><div class="sv-vf-frame">' +
        '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>' +
      '</div></div>' +
    '</div>' +
    '<p class="sv-vf-hint">Fit the spine inside the frame, then capture</p>' +
    '<div class="sv-review-actions">' +
      '<button class="sv-sheet-btn ghost" id="svVfCancel">Cancel</button>' +
      '<button class="sv-sheet-btn ghost" id="svVfLibrary">Choose photo</button>' +
      '<button class="sv-sheet-btn ghost" id="svVfTorch" hidden>Flash: off</button>' +
      '<button class="sv-sheet-btn solid" id="svVfSnap">Capture</button>' +
    '</div>');
  const video = sheet.querySelector('#svVideo');
  let torchCleanup = null;
  const done = (next) => {
    if (torchCleanup) { try { torchCleanup(); } catch (e) {} torchCleanup = null; }
    shelfStopCam(); close(); if (next) next();
  };
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then(stream => {
      shelfCamStream = stream;
      video.srcObject = stream;
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
      if (typeof ecTorchWire === 'function') {
        torchCleanup = ecTorchWire(video, sheet.querySelector('#svVfTorch'));
      }
    })
    .catch(() => done(() => shelfNativeCapture(bookId)));
  sheet.querySelector('#svVfCancel').addEventListener('click', () => done());
  sheet.querySelector('#svVfLibrary').addEventListener('click', () => done(() => shelfNativeCapture(bookId)));
  sheet.querySelector('#svVfSnap').addEventListener('click', () => {
    const url = shelfSnapFrame(video);
    done(() => { if (url) shelfReviewCapture(url, bookId); else toast('Capture failed — try again'); });
  });
}
// Grab the current viewfinder frame as a JPEG data URL (null on failure).
// v262: crops the capture to the guide-frame region, so the photo contains
// (almost) only the spine — background the user framed out (screens, walls)
// never enters the image. Falls back to the full frame when the guide rect
// can't be determined.
function shelfSnapFrame(video) {
  try {
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const c = document.createElement('canvas');
    const guide = shelfGuideSourceRect(video);
    if (guide) {
      c.width = Math.max(1, Math.round(guide.sw));
      c.height = Math.max(1, Math.round(guide.sh));
      c.getContext('2d').drawImage(video,
        guide.sx, guide.sy, guide.sw, guide.sh, 0, 0, c.width, c.height);
    } else {
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    }
    return c.toDataURL('image/jpeg', 0.92);
  } catch (e) { return null; }
}
// The guide frame's rect in video-source pixels, or null when it can't be
// determined. Maps the CSS frame rect through the video's object-fit: cover.
function shelfGuideSourceRect(video) {
  try {
    const frame = document.querySelector('.sv-vf-frame');
    if (!frame) return null;
    const vr = video.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vr.width || !vr.height || !vw || !vh || !fr.width || !fr.height) return null;
    const scale = Math.max(vr.width / vw, vr.height / vh); // object-fit: cover
    const ox = (vr.width - vw * scale) / 2;
    const oy = (vr.height - vh * scale) / 2;
    let sx = (fr.left - vr.left - ox) / scale;
    let sy = (fr.top - vr.top - oy) / scale;
    let sw = fr.width / scale, sh = fr.height / scale;
    sx = Math.max(0, Math.min(vw - 1, sx));
    sy = Math.max(0, Math.min(vh - 1, sy));
    sw = Math.max(1, Math.min(vw - sx, sw));
    sh = Math.max(1, Math.min(vh - sy, sh));
    return { sx, sy, sw, sh };
  } catch (e) { return null; }
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
      '<p class="sv-review-hint">' + (ai
      ? 'AI found the spine — look right?'
      : 'AI couldn\'t spot the spine — drag to adjust') + '</p>' +
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
// v273: the shared pool is edition_images (face/appearance keyed, API-ready).
// Legacy v259 rows still point at the spine-photos bucket. New contributions
// go through edition_assets (below); editionImagePath stays for the legacy
// read paths that still reference it.
function editionImagePath(isbn, face, appearance) {
  return face + '/' + appearance + '/' + isbn + '.jpg';
}
// SHA-256 of image bytes as lowercase hex (content-addressed storage paths).
async function spinePhotoSha256(bytes) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function (x) {
      return x.toString(16).padStart(2, '0');
    }).join('');
  } catch (e) { return null; }
}
// Natural dimensions of a data-URL image, or null — best-effort metadata on
// the candidate row.
function spinePhotoImageSize(dataUrl) {
  return new Promise(function (resolve) {
    try {
      const img = new Image();
      const safety = setTimeout(function () { resolve(null); }, 8000);
      img.onload = function () {
        clearTimeout(safety);
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        resolve(w && h ? { w: w, h: h } : null);
      };
      img.onerror = function () { clearTimeout(safety); resolve(null); };
      img.src = dataUrl;
    } catch (e) { resolve(null); }
  });
}
async function spinePhotoUid(sb) {
  try {
    const u = await sb.auth.getUser();
    return (u && u.data && u.data.user) ? u.data.user.id : null;
  } catch (e) { return null; }
}
// v286 (M7): shared spine-photo pool under the immutable-candidate model.
// AI-verified tight crops contribute as edition_assets candidates — the DB
// trigger picks the canonical slot and syncs the edition_images read model.
// The legacy direct edition_images write is gone: it bypassed moderation
// (no candidate row, no attribution) and was un-withdrawable.
async function spinePhotoShare(book, dataUrl, aiCropped) {
  try {
    if (!aiCropped) return false; // safety: only anonymous tight crops
    const isbn = spinePhotoISBN(book);
    if (!isbn || typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) return false;
    const sb = await (typeof cloudClient === 'function' ? cloudClient().catch(() => null) : null);
    if (!sb) return false;
    const blob = await (await fetch(dataUrl)).blob();
    if (!blob || !blob.size) return false;
    const sha = await spinePhotoSha256(await blob.arrayBuffer());
    if (!sha) return false;
    // No edition catalog row for this ISBN — nothing to attach the
    // candidate to; skip silently.
    const ed = await sb.from('editions').select('id').eq('isbn', isbn).maybeSingle();
    const editionId = ed && ed.data ? ed.data.id : null;
    if (!editionId) return false;
    // RLS requires source_user_id = auth.uid() on insert.
    const uid = (typeof ecPoolUid === 'function') ? await ecPoolUid(sb) : await spinePhotoUid(sb);
    if (!uid) return false;
    const path = 'spine/jacket/' + sha + '.jpg';
    const existing = await sb.from('edition_assets').select('id')
      .eq('bucket', 'edition-images').eq('path', path).maybeSingle();
    if (existing && existing.data) return true; // already a candidate
    const up = await sb.storage.from('edition-images').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (up.error && up.error.statusCode !== '409' && up.error.statusCode !== 409 && !/exists/i.test(up.error.message || '')) return false;
    const size = await spinePhotoImageSize(dataUrl);
    // NOTE: v284's check constraint allows only ('capture','upload','import',
    // 'perspective_corrected','sharpened','restored','derived') for
    // source_type, so the spine capture is recorded as 'capture'.
    // The insert RLS policy also requires edition_id + isbn to match an
    // editions row — both are set above.
    const ins = await sb.from('edition_assets').insert({
      edition_id: editionId, isbn: isbn, face: 'spine', appearance: 'jacket',
      bucket: 'edition-images', path: path,
      width: size ? size.w : null, height: size ? size.h : null,
      format: 'image/jpeg', byte_size: blob.size, sha256: sha,
      source_type: 'capture', source_user_id: uid
    });
    if (ins && ins.error) return false;
    return true;
  } catch (e) { return false; }
}
// v259: adopt a shared spine photo for an ISBN book that has none.
// Best-effort; resolves true when a photo was adopted and saved.
const spineLookupDone = new Set();
async function spinePhotoAdopt(book) {
  try {
    if (!book || shelfSpineAssetId(book)) return false;
    const isbn = spinePhotoISBN(book);
    if (!isbn || !book.id || spineLookupDone.has(book.id)) return false;
    spineLookupDone.add(book.id);
    const sb = await (typeof cloudClient === 'function' ? cloudClient().catch(() => null) : null);
    if (!sb) return false;
    let row = null, assetId = null;
    try {
      const ed = await sb.from('editions').select('id').eq('isbn', isbn).maybeSingle();
      if (ed && ed.data) {
        const slot = await sb.from('edition_asset_slots')
          .select('canonical_asset_id')
          .eq('edition_id', ed.data.id).eq('face', 'spine').eq('appearance', 'jacket').maybeSingle();
        assetId = slot && slot.data && slot.data.canonical_asset_id;
        if (assetId) {
          const ar = await sb.from('edition_assets').select('bucket,path')
            .eq('id', assetId).maybeSingle();
          if (ar && ar.data) row = ar.data;
        }
      }
    } catch (e) {}
    if (!row) {
      const res = await sb.from('edition_images').select('bucket,path,appearance')
        .eq('isbn', isbn).eq('face', 'spine').limit(5);
      const rows = (res && res.data) || [];
      row = rows.find(r => r.appearance === 'jacket') || rows[0];
    }
    const path = row && row.path;
    if (!path) return false;
    const pub = sb.storage.from(row.bucket || 'edition-images').getPublicUrl(path);
    const url = pub && pub.data && pub.data.publicUrl;
    if (!url || typeof idbAssetPut !== 'function' || typeof currentDb === 'undefined' || !currentDb) return false;
    // v286 (M2): route through editionAssetBlob when available (IDB-first
    // with network fallback); the inline public-URL fetch stays as fallback.
    let blob = null;
    if (typeof editionAssetBlob === 'function') {
      try {
        blob = await editionAssetBlob({ assetId: assetId || null,
          bucket: row.bucket || 'edition-images', path: path });
      } catch (e) { blob = null; }
    }
    if (!blob || !blob.size) blob = await (await fetch(url)).blob();
    if (!blob || !blob.size) return false;
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID() : ('asset-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    await idbAssetPut(currentDb, { id: id, blob: blob, isbn: isbn, face: 'spine',
      appearance: 'jacket', createdAt: Date.now(), source: 'shared-cache',
      remoteAssetId: assetId || null, remoteBucket: row.bucket || 'edition-images',
      remotePath: path });
    if (!book.editionFaceRefs) book.editionFaceRefs = {};
    if (!book.editionFaceRefs.jacket) book.editionFaceRefs.jacket = {};
    book.editionFaceRefs.jacket.spine = id;
    book.spinePhotoAssetId = id;
    delete book.spinePhoto;
    shelfAssetUrls.set(id, URL.createObjectURL(blob));
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

async function shelfAssignPhoto(bookId, dataUrl) {
  const book = (typeof library !== 'undefined' ? library : []).find(b => b && b.id === bookId);
  if (!book || typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) return;
  try {
    if (typeof idbAssetPut === 'function' && typeof currentDb !== 'undefined' && currentDb) {
      var blob = await (await fetch(dataUrl)).blob();
      var id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID() : ('asset-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      await idbAssetPut(currentDb, { id: id, blob: blob, isbn: spinePhotoISBN(book),
        face: 'spine', appearance: 'jacket', createdAt: Date.now(), source: 'shelf-capture' });
      var oldId = shelfSpineAssetId(book);
      if (oldId && shelfAssetUrls.has(oldId)) {
        try { URL.revokeObjectURL(shelfAssetUrls.get(oldId)); } catch (e) {}
        shelfAssetUrls.delete(oldId);
      }
      if (!book.editionFaceRefs) book.editionFaceRefs = {};
      if (!book.editionFaceRefs.jacket) book.editionFaceRefs.jacket = {};
      book.editionFaceRefs.jacket.spine = id;
      book.spinePhotoAssetId = id;
      delete book.spinePhoto;
      shelfAssetUrls.set(id, URL.createObjectURL(blob));
      saveLibrary();
      renderShelf();
      if (typeof ecShareFace === 'function') ecShareFace(spinePhotoISBN(book), 'jacket', 'spine', dataUrl).catch(function () {});
      toast('Spine photo saved');
      return;
    }
  } catch (e) {}
  book.spinePhoto = dataUrl;
  saveLibrary();
  renderShelf();
  toast('Spine photo saved');
}
