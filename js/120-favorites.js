'use strict';

/* ---------------- favorites bookshelf ---------------- */
// No free source serves real spine art (Google Books / Open Library only
// have front covers), so spines are generated: title + author, colored
// deterministically, sized by page count.
let favExpanded = false;
// v61: shelf display style — 'spines' (default) or 'covers'.
let favStyle = 'spines';
try { favStyle = localStorage.getItem('spicyshelves.favstyle') === 'covers' ? 'covers' : 'spines'; } catch (e) {}
const SPINE_COLORS = ['#7b2d43', '#2d4a7b', '#3f6b4f', '#8a5a2b', '#5b2d7b', '#a03a2e',
  '#2e6b6b', '#6b3f2a', '#4a4a6b', '#7b5a2d', '#94425f', '#365a8a'];
function hashStr(s) {
  let h = 0; s = String(s || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function spineHTML(b) {
  const c = SPINE_COLORS[hashStr(b.title) % SPINE_COLORS.length];
  const w = 34 + Math.min(22, Math.round((b.pageCount || 300) / 35)); // thicker books, thicker spines
  const h = 122 + (hashStr(b.title + '|h') % 38);
  const author = (b.authors[0] || '').trim().split(/\s+/).pop() || '';
  // v186: foil redesign — near-black cover-tinted base, gold-foil title,
  // double hairline rules top and bottom.
  return '<div class="spine" data-id="' + b.id + '" title="' + esc(b.title) + '"' +
    ' style="--sc:' + c + ';width:' + w + 'px;height:' + h + 'px">' +
    '<span class="spine-rule" aria-hidden="true"></span><span class="spine-title">' + esc(b.title) + '</span>' +
    (author ? '<span class="spine-author">' + esc(author) + '</span>' : '') +
    '<span class="spine-rule" aria-hidden="true"></span></div>';
}
/* ---- recently added (v173): newest arrivals first, per the home mockup ---- */
function recentlyAddedHTML() {
  const rec = library.slice()
    .sort((a, b) => String(b.dateAdded || b._mtime || '')
      .localeCompare(String(a.dateAdded || a._mtime || '')))
    .slice(0, 10);
  if (!rec.length) return '';
  return '<section class="home-sec"><div class="recent-strip"><div class="recent-head"><h3 class="serif">' + icon('history') + ' Recently Added</h3>' +
    '<button class="btn ghost sm" id="ra-all">View All \u2192</button></div>' +
    '<div class="recent-row">' + rec.map(b => {
      const cov = b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy">'
        : '<div class="recent-nocover">' + icon('covers') + '</div>';
      return '<button class="recent-card" data-id="' + b.id + '" title="' + esc(b.title) + '">' + cov +
        '<span class="recent-title">' + esc(b.title) + '</span></button>';
    }).join('') + '</div></div></section>';
}

function favShelfHTML() {
  const favs = library.filter(b => b.favorite);
  const vw = (document.getElementById('view') || {}).clientWidth || 360;
  const perRow = Math.max(4, Math.floor(vw / 58));
  const rows = [];
  for (let i = 0; i < favs.length; i += perRow) rows.push(favs.slice(i, i + perRow));
  const shown = favExpanded ? rows : rows.slice(0, 1);
  // v61: style toggle — spines or covers. Covers mode shows every favorite
  // in one grid (no collapse needed); spines keep the old rows + show-all.
  const styleBtn = '<button class="btn ghost sm" id="fav-style" title="Switch shelf style">' +
    (favStyle === 'spines' ? icon('covers') + ' Covers' : icon('spines') + ' Spines') + '</button>';
  let html = '<div class="fav-shelf"><div class="fav-head"><h3 class="serif">' + icon('heart') + ' Favorites</h3>' +
    '<span class="fav-btns">' + styleBtn +
    (rows.length > 1 && favStyle === 'spines'
      ? '<button class="btn ghost sm" id="fav-toggle">' + (favExpanded ? 'Show less ↑' : 'Show all ' + favs.length + ' ↓') + '</button>'
      : '') + '</span></div>';
  if (!favs.length) {
    html += '<div class="shelf-row"><p class="note" style="padding:6px 12px">Tap ' + icon('heart') + ' on any book to pin it to this shelf.</p></div>' +
      '<div class="shelf-plank"></div>';
  } else if (favStyle === 'covers') {
    html += '<div class="book-grid fav-covers">' + favs.map((b, i) => bookTile(b, i)).join('') + '</div>';
  } else {
    shown.forEach(r => {
      html += '<div class="shelf-row"><div class="shelf-books">' + r.map(spineHTML).join('') + '</div></div>' +
        '<div class="shelf-plank"></div>';
    });
  }
  return html + '</div>';
}

/* ---------------- "Up Next" queue (v74) ---------------- */
// Ordered reading shortlist: ids live in `upNext` (040-storage.js, per-user,
// local-only). Queue ops keep DOM and storage in sync.
function upNextBooks() {
  const byId = new Map(library.map(b => [b.id, b]));
  return upNext.map(id => byId.get(id)).filter(Boolean);
}
function upNextAdd(id) {
  if (!upNext.includes(id)) { upNext.push(id); saveUpNext(); }
}
function upNextRemove(id) {
  if (upNext.includes(id)) { upNext = upNext.filter(x => x !== id); saveUpNext(); }
}
function upNextMove(id, dir) {
  const i = upNext.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= upNext.length) return;
  const t = upNext[i]; upNext[i] = upNext[j]; upNext[j] = t;
  saveUpNext();
}
function upNextShelfHTML() {
  const books = upNextBooks();
  let html = '<div class="un-strip"><div class="recent-head"><h3 class="serif">⏭️ Up Next</h3>' +
    (books.length ? '<button class="btn ghost sm" id="un-manage">Manage</button>' : '') + '</div>';
  if (!books.length) {
    html += '<div class="shelf-row"><p class="note" style="padding:6px 12px">' +
      'Queue up what to read next — open any book and tap <b>⏭️ Up Next</b>.</p></div>';
  } else {
    html += '<div class="recent-row">' + books.slice(0, 8).map((b, i) => {
      const cov = b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy">'
        : '<div class="recent-nocover">' + icon('covers') + '</div>';
      return '<button class="recent-card" data-id="' + b.id + '" title="#' + (i + 1) + ' · ' + esc(b.title) + '">' +
        '<span class="un-num">' + (i + 1) + '</span>' + cov +
        '<span class="recent-title">' + esc(b.title) + '</span></button>';
    }).join('') + '</div>';
  }
  return html + '</div>';
}
function renderUpNext() {
  const books = upNextBooks();
  let html = '<button class="btn ghost" id="un-back">← Shelves</button>' +
    '<h2 class="section serif" style="font-size:26px;margin-top:10px">' + icon('upnext') + ' Up Next</h2>';
  if (!books.length) {
    html += emptyState({
      icon: 'upnext', title: 'Nothing queued',
      body: 'Open any book and tap <b>' + icon('upnext') + ' Up Next</b><br>to build your reading shortlist.',
      cta: { label: 'Browse your library', go: 'library' },
    });
  } else {
    html += '<p class="note">Your reading shortlist, in order — start at the top.</p><div class="un-list">' +
      books.map((b, i) =>
        '<div class="un-row" data-id="' + b.id + '">' +
        '<span class="un-pos">' + (i + 1) + '</span>' +
        (b.cover ? '<img class="un-thumb" src="' + esc(b.cover) + '" alt="" loading="lazy">'
                 : '<div class="un-thumb un-nonecover">' + icon('covers') + '</div>') +
        '<button class="un-info" data-open="' + b.id + '"><span class="un-title">' + esc(b.title) + '</span>' +
        '<span class="un-sub">' + esc((b.authors || []).join(', ') || 'Unknown author') + '</span></button>' +
        '<span class="un-btns">' +
        '<button class="btn ghost sm" data-mv="-1" title="Move up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="btn ghost sm" data-mv="1" title="Move down"' + (i === books.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button class="btn ghost sm" data-rm="1" title="Remove from queue">✕</button>' +
        '</span></div>').join('') + '</div>';
  }
  setView(html);
  document.getElementById('un-back').addEventListener('click', () => go('library'));
  document.querySelectorAll('.un-row [data-mv]').forEach(btn =>
    btn.addEventListener('click', () => {
      upNextMove(btn.closest('.un-row').dataset.id, Number(btn.dataset.mv));
      animateIn = false; renderUpNext();
    }));
  document.querySelectorAll('.un-row [data-rm]').forEach(btn =>
    btn.addEventListener('click', () => {
      upNextRemove(btn.closest('.un-row').dataset.id);
      animateIn = false; renderUpNext();
    }));
  document.querySelectorAll('.un-row [data-open]').forEach(btn =>
    btn.addEventListener('click', () => openDetail(btn.dataset.open)));
}

/* ---- spine colors from covers + pull-out animation ---- */
const spineColorCache = {}; // bookId -> { hex, cover }
const spinePaintInflight = new Set();
function loadSpineColorCache() {
  try { Object.assign(spineColorCache, JSON.parse(localStorage.getItem('spicyshelves.spinecolors') || '{}')); } catch (e) {}
}
function saveSpineColorCache() {
  try { localStorage.setItem('spicyshelves.spinecolors', JSON.stringify(spineColorCache)); } catch (e) {}
}
loadSpineColorCache();
// Hosts verified (2026-09-26) to send `Access-Control-Allow-Origin: *` on
// cover images, so pixel reads work there. Google Books (books.google.com)
// sends none — requesting CORS there only spams the console, so we load
// those without it and take the graceful null fallback instead.
function coverCorsOK(url) {
  if (!url || url.indexOf('data:') === 0 || url.indexOf('blob:') === 0) return true;
  const m = /^https?:\/\/([^/]+)/i.exec(url || '');
  const host = (m && m[1] || '').toLowerCase();
  return /(^|\.)covers\.openlibrary\.org$/.test(host) ||
         /(^|\.)mzstatic\.com$/.test(host);
}
// Same-origin cover proxy (server.py /cover-proxy): lets us read cover pixels
// from hosts that don't send CORS headers (e.g. Google Books). Only when the
// app is served over http(s); file:// has no server to proxy through.
function coverProxyURL(url) {
  try {
    if (!/^https?:/i.test(url || '')) return url; // data:/blob: need no proxy
    if (!/^https?:$/.test(location.protocol)) return url;
    return '/cover-proxy?url=' + encodeURIComponent(url);
  } catch (e) { return url; }
}
// Load one image and read its dominant color. Resolves {hex} when pixels were
// read, {hex:null} when the image loaded but pixels are unreadable (tainted
// canvas), or {loadError:true} when the image itself failed to load.
function coverImageHex(src, useCors) {
  return new Promise(resolve => {
    const img = new Image();
    if (useCors) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try { resolve({ hex: dominantHex(img) }); }
      catch (e) { resolve({ hex: null }); }
    };
    img.onerror = () => resolve({ loadError: true });
    img.src = src;
  });
}
// Ordered pixel sources for a cover: same-origin proxy first (reads pixels
// from any host), then the direct URL (CORS only where the host allows it).
function coverColorSources(url) {
  const sources = [];
  const proxy = coverProxyURL(url);
  if (proxy !== url) sources.push([proxy, false]); // same-origin: no CORS needed
  sources.push([url, coverCorsOK(url)]);            // direct, CORS only where allowed
  return sources;
}
// Dominant color of a cover image (darkened a touch so spine text stays readable).
// Falls back to null when the image can't be read.
function coverDominantColor(url) {
  const sources = coverColorSources(url);
  return (async () => {
    for (const [src, cors] of sources) {
      const r = await coverImageHex(src, cors);
      if (!r.loadError) return r.hex;
    }
    return null;
  })();
}
// Dominant non-gray, non-border color of a loaded image, darkened ~18%.
function dominantHex(img) {
  const S = 24, c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const buckets = {};
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (d[i + 3] < 128) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 12) continue; // near-gray tells us nothing
    if (mx > 242 && mn > 225) continue; // white borders
    if (mx < 16) continue; // black borders
    const k = (r >> 5) + ',' + (g >> 5) + ',' + (b >> 5);
    buckets[k] = (buckets[k] || 0) + 1;
  }
  let best = null, bestN = 0;
  for (const k in buckets) if (buckets[k] > bestN) { bestN = buckets[k]; best = k; }
  if (!best) return null;
  const rgb = best.split(',').map(x => Math.round(Math.min(255, ((Number(x) << 5) + 16) * 0.82)));
  return '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('');
}
function paintSpineColors() {
  document.querySelectorAll('.fav-shelf .spine').forEach(sp => {
    const b = library.find(x => x.id === sp.dataset.id);
    if (!b || !b.cover) return;
    const cached = spineColorCache[b.id];
    if (cached && cached.cover === b.cover) { sp.style.setProperty('--sc', cached.hex); return; }
    if (spinePaintInflight.has(b.id)) return;
    spinePaintInflight.add(b.id);
    coverDominantColor(b.cover).then(hex => {
      spinePaintInflight.delete(b.id);
      if (!hex) return;
      spineColorCache[b.id] = { hex: hex, cover: b.cover };
      saveSpineColorCache();
      document.querySelectorAll('.fav-shelf .spine[data-id="' + b.id + '"]')
        .forEach(el => el.style.setProperty('--sc', hex));
    });
  });
}
function animEnabled() {
  try { return localStorage.getItem('spicyshelves.animation') !== 'off'; } catch (e) { return true; }
}
const reducedMotion = () => !animEnabled() ||
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
let pullBusy = false;
function pullSpine(el, id) {
  const b = library.find(x => x.id === id);
  if (!b || pullBusy) return;
  if (reducedMotion()) { openDetail(id); return; }
  pullBusy = true;
  el.classList.add('pulling');
  let overlay = null, popImg = null;
  if (b.cover) {
    overlay = document.createElement('div');
    overlay.className = 'pull-overlay';
    overlay.innerHTML = '<img src="' + esc(b.cover) + '" alt="">';
    document.body.appendChild(overlay);
    popImg = overlay.querySelector('img');
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('show')));
  }
  setTimeout(() => {
    el.classList.remove('pulling');
    pullBusy = false;
    // Hand the popped cover to the book-opening transition: it swings open
    // from exactly where the pop left it.
    openDetail(id, overlay ? { fromEl: popImg, dropEl: overlay } : null);
  }, b.cover ? 950 : 380);
}

/* ---------------- library home (v122, v173) ----------------
   The Library tab is the app's home. v173 restyles it per the mockup:
   greeting hero → Currently Reading hero card → stat tiles → Recently
   Added → the rest. Shown only on the unfiltered view; filtering drops
   into the plain browser. */
function homeGreetingHTML() {
  const h = new Date().getHours();
  const tod = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : 'evening';
  // v177: the term of endearment follows the profile gender — unset keeps
  // the long-standing "beautiful" default.
  const g = (typeof loadProfile === 'function' && loadProfile().gender) || '';
  const term = g === 'm' ? 'handsome' : g === 'other' ? 'friend' : 'beautiful';
  return '<section class="home-sec home-greet"><h2 class="serif">Good ' + tod + ', ' + term + ' ' + icon('covers') + '</h2>' +
    '<p>What are you in the mood for?</p></section>';
}

function readingHeroHTML() {
  // Featured book = the reading book touched most recently.
  const reading = library.filter(b => b.status === 'reading')
    .sort((a, b) => String(b._mtime || '').localeCompare(String(a._mtime || '')));
  let html = '<section class="home-sec"><h3 class="home-sec-title">' + icon('reading') + ' Currently Reading</h3>';
  if (!reading.length) {
    html += '<div class="home-empty"><p>Nothing you\u2019re reading right now.</p>' +
      '<div class="home-empty-btns"><button class="btn sm" id="he-tbr">Browse TBR</button>' +
      '<button class="btn ghost sm" id="he-disc">Discover something</button></div></div>';
  } else {
    const b = reading[0];
    const total = b.pageCount || 0;
    const cur = total ? Math.min(b.progress || 0, total) : (b.progress || 0);
    const pct = total ? Math.round(cur / total * 100) : 0;
    html += '<div class="cr-hero">' +
      '<button class="cr-cover" data-cr="' + b.id + '" aria-label="Open ' + esc(b.title) + '">' +
      coverHTML(b, 'cr-cov') + '</button>' +
      '<div class="cr-info"><p class="cr-eyebrow">Currently Reading</p>' +
      '<h4 class="serif">' + esc(b.title) + '</h4>' +
      '<p class="cr-author">' + esc((b.authors || []).join(', ') || 'Unknown author') + '</p>' +
      (b.publicRating ? '<div class="cr-stars">' + stars(b.publicRating) + '</div>' : '') +
      '<div class="cr-prog"><span class="progress-line"><span class="fill" style="width:' + pct + '%"></span></span>' +
      '<small>page ' + cur + ' of ' + (total || '\u2013') + ' \u00b7 ' + pct + '%</small></div>' +
      '<button class="btn sm" data-cr="' + b.id + '">Update Progress</button></div></div>';
    if (reading.length > 1) {
      html += '<div class="cr-also">' + reading.slice(1, 5).map(o =>
        '<button class="cr-mini" data-cr="' + o.id + '" title="' + esc(o.title) + '" aria-label="Open ' + esc(o.title) + '">' +
        (o.cover ? '<img src="' + esc(o.cover) + '" alt="" loading="lazy">' : icon('covers')) +
        '</button>').join('') + '</div>';
    }
  }
  return html + '</section>';
}

function cantDecideHTML() {
  const tbr = library.filter(b => b.status === 'tbr').length;
  if (!tbr) return '';
  return '<section class="home-sec"><button class="cant-decide" id="cd-pick">' +
    '<span class="disc-ic">' + icon('dice') + '</span>' +
    '<span class="disc-tx"><b>Can\u2019t decide?</b>' +
    '<small>Let Cozy Libram pick your next read from ' + tbr + ' waiting book' + (tbr === 1 ? '' : 's') + '.</small></span>' +
    '<span class="disc-go" aria-hidden="true">\u2192</span></button></section>';
}

function shelfTilesHTML(counts) {
  // v173: six tiles per the mockup — the four shelves plus Favorites and
  // Wishlist (books marked "to buy").
  const fav = library.filter(b => b.favorite).length;
  const wish = library.filter(b => b.owned === 'tobuy').length;
  const tiles = [
    ['tbr', 'TBR', counts.tbr], ['reading', 'Reading', counts.reading],
    ['read', 'Read', counts.read], ['dnf', 'DNF', counts.dnf],
    ['favorites', 'Favorites', fav], ['wishlist', 'Wishlist', wish],
  ];
  return '<section class="home-sec"><h3 class="home-sec-title">' + icon('covers') + ' Your Library</h3>' +
    '<div class="shelf-tiles tiles-6">' + tiles.map(t =>
      '<button class="shelf-tile" data-shelf="' + t[0] + '"><b>' + t[2] + '</b><span>' + t[1] + '</span></button>'
    ).join('') + '</div></section>';
}

function libraryHomeHTML(counts) {
  return homeGreetingHTML() + readingHeroHTML() + shelfTilesHTML(counts) +
    recentlyAddedHTML() + upNextShelfHTML() + cantDecideHTML() + favShelfHTML();
}

function renderLibrary() {
  const books = filteredBooks();
  const counts = { tbr: 0, reading: 0, read: 0, dnf: 0 };
  library.forEach(b => { if (counts[b.status] != null) counts[b.status]++; });
  const isHome = filter === 'all' && ownFilter === 'all' && !query.trim();

  let html = (isHome && library.length ? libraryHomeHTML(counts) : '') +
    '<div class="toolbar"><input id="q" class="search" placeholder="Search title, author, trope…" value="' + esc(query) + '">' +
    '<div class="view-toggle"><button data-l="list" class="' + (layout === 'list' ? 'active' : '') + '" aria-label="List view">' + icon('list') + '</button>' +
    '<button data-l="grid" class="' + (layout === 'grid' ? 'active' : '') + '" aria-label="Cover grid">' + icon('covers') + '</button></div>' +
    '<button class="btn ghost sm" id="lib-wishlist" title="Wishlist">' + icon('gift') + ' Wishlist</button>' +
    '<button class="btn ghost sm" id="lib-quotes" title="Browse saved quotes">' + icon('quotes') + ' Quotes</button>' +
    '<button class="btn ghost sm" id="lib-series" title="Series overview">' + icon('series') + ' Series</button></div>';
  html += '<div class="chips">' +
    chip('all', 'All · ' + library.length, filter === 'all') +
    chip('tbr', icon('tbr') + ' TBR · ' + counts.tbr, filter === 'tbr') +
    chip('reading', icon('reading') + ' Reading · ' + counts.reading, filter === 'reading') +
    chip('read', icon('read') + ' Read · ' + counts.read, filter === 'read') +
    chip('dnf', icon('dnf') + ' DNF · ' + counts.dnf, filter === 'dnf') +
    '</div>';
  const ownCounts = { owned: 0, tobuy: 0, borrowed: 0 };
  library.forEach(b => { const k = b.owned === 'tobuy' ? 'tobuy' : b.owned === 'borrowed' ? 'borrowed' : 'owned'; ownCounts[k]++; });
  html += '<div class="chips">' +
    '<button class="chip' + (ownFilter === 'all' ? ' active' : '') + '" data-of="all">Ownership: All</button>' +
    '<button class="chip' + (ownFilter === 'owned' ? ' active' : '') + '" data-of="owned">' + icon('owned') + ' Owned · ' + ownCounts.owned + '</button>' +
    '<button class="chip' + (ownFilter === 'tobuy' ? ' active' : '') + '" data-of="tobuy">' + icon('tobuy') + ' To buy · ' + ownCounts.tobuy + '</button>' +
    '<button class="chip' + (ownFilter === 'borrowed' ? ' active' : '') + '" data-of="borrowed">' + icon('borrowed') + ' Borrowed · ' + ownCounts.borrowed + '</button>' +
    '</div>';

  if (!books.length) {
    html += libraryEmptyHTML();
  } else if (layout === 'grid') {
    html += '<div class="book-grid">' + books.map((b, i) => bookTile(b, i)).join('') + '</div>';
  } else {
    html += '<div class="grid">' + books.map((b, i) => bookCard(b, i)).join('') + '</div>';
  }
  setView(html);
  tileGuard(); // v57: enforce uniform 2:3 cover boxes even if styles.css is stale

  document.getElementById('q').addEventListener('input', e => {
    query = e.target.value;
    animateIn = false; // don't replay entrance while typing
    const pos = e.target.selectionStart;
    renderLibraryKeepFocus(pos);
  });
  document.querySelectorAll('.view-toggle button').forEach(t =>
    t.addEventListener('click', () => {
      layout = t.dataset.l;
      try { localStorage.setItem('spicyshelves.layout', layout); } catch (e) {}
      animateIn = true;
      render();
    }));
  document.querySelectorAll('.chip:not([data-of])').forEach(c =>
    c.addEventListener('click', () => { filter = c.dataset.f; animateIn = true; render(); }));
  document.querySelectorAll('[data-of]').forEach(c =>
    c.addEventListener('click', () => { ownFilter = c.dataset.of; animateIn = true; render(); }));
  document.querySelectorAll('.book-card, .book-tile').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
  document.querySelectorAll('.recent-card').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
  document.querySelectorAll('.spine').forEach(s =>
    s.addEventListener('click', () => pullSpine(s, s.dataset.id)));
  const unm = document.getElementById('un-manage');
  if (unm) unm.addEventListener('click', () => go('upnext'));
  // v122 home-section wiring
  document.querySelectorAll('[data-cr]').forEach(el =>
    el.addEventListener('click', () => openDetail(el.dataset.cr)));
  const het = document.getElementById('he-tbr');
  if (het) het.addEventListener('click', () => { filter = 'tbr'; animateIn = true; render(); });
  const hed = document.getElementById('he-disc');
  if (hed) hed.addEventListener('click', () => go('discover'));
  const cdp = document.getElementById('cd-pick');
  if (cdp) cdp.addEventListener('click', () => go('pick'));
  document.querySelectorAll('.shelf-tile').forEach(t =>
    t.addEventListener('click', () => {
      const s = t.dataset.shelf;
      // v173: favorites and wishlist tiles navigate instead of filtering.
      if (s === 'wishlist') { go('wishlist'); return; }
      if (s === 'favorites') {
        const el = document.querySelector('.fav-shelf');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        return;
      }
      filter = s; animateIn = true; render();
    }));
  const raa = document.getElementById('ra-all');
  if (raa) raa.addEventListener('click', () => {
    const qel = document.getElementById('q');
    if (qel && qel.scrollIntoView) qel.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  });
  const lq = document.getElementById('lib-quotes');
  if (lq) lq.addEventListener('click', () => go('quotes'));
  const lw = document.getElementById('lib-wishlist');
  if (lw) lw.addEventListener('click', () => go('wishlist'));
  const ls = document.getElementById('lib-series');
  if (ls) ls.addEventListener('click', () => { seriesReturn = 'library'; go('series'); });
  const ft = document.getElementById('fav-toggle');
  if (ft) ft.addEventListener('click', () => { favExpanded = !favExpanded; render(); });
  const fst = document.getElementById('fav-style');
  if (fst) fst.addEventListener('click', () => {
    favStyle = favStyle === 'spines' ? 'covers' : 'spines';
    try { localStorage.setItem('spicyshelves.favstyle', favStyle); } catch (e) {}
    animateIn = true;
    render();
  });
  paintSpineColors();
  const addBtn = document.querySelector('#view [data-nav="add"]');
  if (addBtn) addBtn.addEventListener('click', () => go('add'));
}

/* v126: empathetic, actionable empty states for the library — the copy
   acknowledges the situation instead of just reporting zero results. */
function libraryEmptyHTML() {
  const q = query.trim();
  if (!library.length) return emptyState({
    icon: 'covers', title: 'Your shelves are waiting',
    body: 'Every great library starts with a single<br>“just one more chapter.”',
    cta: { label: 'Add your first book', go: 'add' },
  });
  if (q) return emptyState({
    icon: 'search', title: 'No matches for “' + q + '”',
    body: 'Try a different spelling — or add it<br>to your shelves anyway.',
    cta: { label: 'Add a book', go: 'add' },
  });
  if (ownFilter !== 'all') return emptyState({
    icon: 'covers', title: 'Nothing under this filter',
    body: 'Try widening the Ownership filter above.',
  });
  const per = {
    tbr: { icon: 'tbr', title: 'A deliciously empty TBR',
      body: 'Suspiciously responsible. Discover is full<br>of tempting trouble, if you want it.',
      cta: { label: 'Discover books', go: 'discover' } },
    reading: { icon: 'reading', title: 'Nothing on the nightstand',
      body: 'Pick something from your TBR<br>and settle in for a chapter.',
      cta: { label: 'Discover books', go: 'discover' } },
    read: { icon: 'read', title: 'No finished books yet',
      body: 'Every finished book starts with page one.',
      cta: { label: 'Add your first book', go: 'add' } },
    dnf: { icon: 'dnf', title: 'No mercy kills yet',
      body: 'DNF isn’t failure — it’s curation.' },
  };
  return emptyState(per[filter] || per.tbr);
}

function renderLibraryKeepFocus(pos) {
  // re-render list only, keep the search input focused
  renderLibrary();
  const input = document.getElementById('q');
  input.focus();
  try { input.setSelectionRange(pos, pos); } catch (e) {}
}

function chip(f, label, active) {
  return '<button class="chip' + (active ? ' active' : '') + '" data-f="' + f + '">' + label + '</button>';
}

