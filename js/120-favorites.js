'use strict';

/* ---------------- favorites bookshelf ---------------- */
// No free source serves real spine art (Google Books / Open Library only
// have front covers), so spines are generated: title + author, colored
// deterministically, sized by page count.
let favExpanded = false;
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
  return '<div class="spine" data-id="' + b.id + '" title="' + esc(b.title) + '"' +
    ' style="--sc:' + c + ';width:' + w + 'px;height:' + h + 'px">' +
    '<span class="spine-band"></span><span class="spine-title">' + esc(b.title) + '</span>' +
    (author ? '<span class="spine-author">' + esc(author) + '</span>' : '') + '</div>';
}
/* ---- recently read: quick access to books with fresh reading activity ---- */
// Latest reading-activity day key for a book: newest log entry or finish date.
function lastReadActivity(b) {
  let k = '';
  (b.log || []).forEach(e => { if (e.d && e.d > k) k = e.d; });
  if (b.dateFinished) {
    try { const fk = dayKey(new Date(b.dateFinished)); if (fk > k) k = fk; } catch (e) {}
  }
  return k;
}
function recentBooks(limit) {
  return library
    .filter(b => b.status === 'reading' || lastReadActivity(b))
    .sort((a, b) => {
      const ka = lastReadActivity(a), kb = lastReadActivity(b);
      if (ka !== kb) return ka < kb ? 1 : -1;
      return String(b.dateAdded || '') < String(a.dateAdded || '') ? 1 : -1;
    })
    .slice(0, limit || 8);
}
function recentStripHTML() {
  const rec = recentBooks(8);
  if (!rec.length) return '';
  return '<div class="recent-strip"><div class="recent-head"><h3 class="serif">🕘 Recently read</h3></div>' +
    '<div class="recent-row">' + rec.map(b => {
      const total = b.pageCount || 0;
      const cur = total ? Math.min(b.progress || 0, total) : (b.progress || 0);
      const pct = b.status === 'read' ? 100 : (total ? Math.round(cur / total * 100) : 0);
      const sub = b.status === 'read' ? 'Finished 🎉'
        : (total ? 'p. ' + cur + ' / ' + total + ' · ' + pct + '%' : 'p. ' + cur);
      const cov = b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy">'
        : '<div class="recent-nocover">📖</div>';
      return '<button class="recent-card" data-id="' + b.id + '" title="' + esc(b.title) + '">' + cov +
        '<span class="recent-title">' + esc(b.title) + '</span>' +
        '<span class="recent-prog"><span class="fill" style="width:' + pct + '%"></span></span>' +
        '<span class="recent-sub">' + sub + '</span></button>';
    }).join('') + '</div></div>';
}

function favShelfHTML() {
  const favs = library.filter(b => b.favorite);
  const vw = (document.getElementById('view') || {}).clientWidth || 360;
  const perRow = Math.max(4, Math.floor(vw / 58));
  const rows = [];
  for (let i = 0; i < favs.length; i += perRow) rows.push(favs.slice(i, i + perRow));
  const shown = favExpanded ? rows : rows.slice(0, 1);
  let html = '<div class="fav-shelf"><div class="fav-head"><h3 class="serif">❤️ Favorites</h3>' +
    (rows.length > 1
      ? '<button class="btn ghost sm" id="fav-toggle">' + (favExpanded ? 'Show less ↑' : 'Show all ' + favs.length + ' ↓') + '</button>'
      : '') + '</div>';
  if (!favs.length) {
    html += '<div class="shelf-row"><p class="note" style="padding:6px 12px">Tap 🤍 on any book to pin it to this shelf.</p></div>' +
      '<div class="shelf-plank"></div>';
  } else {
    shown.forEach(r => {
      html += '<div class="shelf-row"><div class="shelf-books">' + r.map(spineHTML).join('') + '</div></div>' +
        '<div class="shelf-plank"></div>';
    });
  }
  return html + '</div>';
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

function renderLibrary() {
  const books = filteredBooks();
  const counts = { tbr: 0, reading: 0, read: 0, dnf: 0 };
  library.forEach(b => { if (counts[b.status] != null) counts[b.status]++; });

  let html = recentStripHTML() + favShelfHTML() + '<div class="toolbar"><input id="q" class="search" placeholder="Search title, author, trope…" value="' + esc(query) + '">' +
    '<div class="view-toggle"><button data-l="list" class="' + (layout === 'list' ? 'active' : '') + '" aria-label="List view">☰</button>' +
    '<button data-l="grid" class="' + (layout === 'grid' ? 'active' : '') + '" aria-label="Cover grid">▦</button></div></div>';
  html += '<div class="chips">' +
    chip('all', 'All · ' + library.length, filter === 'all') +
    chip('tbr', '📖 TBR · ' + counts.tbr, filter === 'tbr') +
    chip('reading', '📘 Reading · ' + counts.reading, filter === 'reading') +
    chip('read', '✅ Read · ' + counts.read, filter === 'read') +
    chip('dnf', '🚫 DNF · ' + counts.dnf, filter === 'dnf') +
    '</div>';
  const ownCounts = { owned: 0, tobuy: 0 };
  library.forEach(b => { b.owned ? ownCounts.owned++ : ownCounts.tobuy++; });
  html += '<div class="chips">' +
    '<button class="chip' + (ownFilter === 'all' ? ' active' : '') + '" data-of="all">Ownership: All</button>' +
    '<button class="chip' + (ownFilter === 'owned' ? ' active' : '') + '" data-of="owned">🏠 Owned · ' + ownCounts.owned + '</button>' +
    '<button class="chip' + (ownFilter === 'tobuy' ? ' active' : '') + '" data-of="tobuy">🛒 To buy · ' + ownCounts.tobuy + '</button>' +
    '</div>';

  if (!books.length) {
    html += '<div class="empty"><div class="big">📚</div><h2 class="serif">No books here yet</h2>' +
      '<p>Tap <b>Add</b> below to scan a barcode<br>or search by title.</p>' +
      '<button class="btn" data-nav="add">Add your first book</button></div>';
  } else if (layout === 'grid') {
    html += '<div class="covers">' + books.map((b, i) => coverTile(b, i)).join('') + '</div>';
  } else {
    html += '<div class="grid">' + books.map((b, i) => bookCard(b, i)).join('') + '</div>';
  }
  setView(html);
  tileGuard(); // v55: enforce uniform 2:3 boxes even if styles.css is stale

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
  document.querySelectorAll('.book-card, .cover-tile').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
  document.querySelectorAll('.recent-card').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
  document.querySelectorAll('.spine').forEach(s =>
    s.addEventListener('click', () => pullSpine(s, s.dataset.id)));
  const ft = document.getElementById('fav-toggle');
  if (ft) ft.addEventListener('click', () => { favExpanded = !favExpanded; render(); });
  paintSpineColors();
  const addBtn = document.querySelector('#view [data-nav="add"]');
  if (addBtn) addBtn.addEventListener('click', () => go('add'));
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

