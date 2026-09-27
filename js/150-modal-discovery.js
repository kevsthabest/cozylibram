'use strict';

/* ---- "missing books" discovery: more by author / full series from outside the library ---- */
const authorCache = new Map(); // author key -> external rows
const seriesCache = new Map(); // series key -> { rows } or { needsToken: true }

function normISBN(s) { return String(s || '').replace(/[^0-9X]/gi, ''); }

// true when an external result is already on her shelves (ISBN or title+author match)
// v116: title comparison uses the loose key so "Hallowed Ground - Flight &
// Glory #4" matches a shelf entry titled just "Hallowed Ground".
function inLibrary(x) {
  const isbn = normISBN(x.isbn);
  const xt = looseTitleKey(x.title);
  const xa = String(x.author || '').trim().toLowerCase();
  return library.some(b => {
    if (isbn && normISBN(b.isbn) === isbn) return true;
    return !!xt && looseTitleKey(b.title) === xt &&
      String((b.authors || [])[0] || '').trim().toLowerCase() === xa;
  });
}

// v116: loose title key for messy Open Library work titles — "(…)"
// qualifiers, " - Series #N" suffixes and a leading "The " are noise when
// deciding whether two rows are the same book.
function looseTitleKey(t, keepThe) {
  const k = String(t || '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return keepThe ? k : k.replace(/^the /, '');
}

// v116: dedupe that collapses subtitle/special-edition variants of the same
// book ("Hallowed Ground - Flight & Glory #4" vs "Hallowed ground").
function dedupeLoose(rows) {
  const seenTitle = new Set();
  const seenIsbn = new Set();
  return rows.filter(x => {
    const t = looseTitleKey(x.title) + '|' + String(x.author || '').trim().toLowerCase();
    const isbn = normISBN(x.isbn);
    if ((t !== '|' && seenTitle.has(t)) || (isbn && seenIsbn.has(isbn))) return false;
    if (t !== '|') seenTitle.add(t);
    if (isbn) seenIsbn.add(isbn);
    return true;
  });
}

// v116: works Open Library only lists in another language — noise on an English shelf.
function isForeignOnly(x) {
  const langs = x.languages || [];
  return langs.length > 0 && !langs.some(l => String(l).toLowerCase() === 'eng');
}

// v116: placeholder records, box sets and merch are not books she's missing.
function isJunkTitle(x) {
  const t = String(x.title || '');
  return t.indexOf(' / ') !== -1 ||
    /^untitled\b/i.test(t) ||
    /box set|collection set/i.test(t) ||
    /\btarot\b/i.test(t);
}

// v116: "Great and Precious Things The Last Letter" — two titles mashed into
// one bad work record. Drop it when it decomposes into two other rows.
function isMashedTitle(x, all) {
  const k = looseTitleKey(x.title, true);
  if (!k) return false;
  const keys = new Set(all.map(y => looseTitleKey(y.title, true)));
  for (const other of keys) {
    if (!other || other === k || !k.startsWith(other)) continue;
    const rest = k.slice(other.length).trim();
    if (rest && keys.has(rest)) return true;
  }
  return false;
}

function dedupeExternal(rows) {
  // Dedupe primarily by title+author so different editions of the same book
  // (different ISBNs) collapse; ISBN catches exact-duplicate rows too.
  const seenTitle = new Set();
  const seenIsbn = new Set();
  return rows.filter(x => {
    const t = String(x.title || '').trim().toLowerCase() + '|' + String(x.author || '').trim().toLowerCase();
    const isbn = normISBN(x.isbn);
    if ((t !== '|' && seenTitle.has(t)) || (isbn && seenIsbn.has(isbn))) return false;
    if (t !== '|') seenTitle.add(t);
    if (isbn) seenIsbn.add(isbn);
    return true;
  });
}

// More books by an author via Open Library (no key, no quota).
async function fetchMoreByAuthor(author) {
  const key = String(author).trim().toLowerCase();
  if (authorCache.has(key)) return authorCache.get(key);
  const url = 'https://openlibrary.org/search.json?author=' + encodeURIComponent(author) +
    '&limit=40&fields=key,title,author_name,isbn,cover_i,language';
  const d = await (await fetch(url)).json();
  const raw = ((d || {}).docs || []).map(doc => ({
    title: doc.title || '',
    author: ((doc.author_name || [])[0]) || author,
    cover: doc.cover_i ? 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-M.jpg' : '',
    isbn: normISBN((doc.isbn || [])[0]),
    position: null,
    seriesName: null,
    workKey: doc.key || '',      // v115: /works/OL…W, for translated-title repair
    languages: doc.language || [] // v115
  }));
  await repairTranslatedTitles(raw); // v115: before dedupe so dupes collapse
  await resolveForeignTitles(raw); // v116: Hardcover canonical title via ISBN
  const deduped = dedupeLoose(raw); // v116: collapse subtitle/edition variants
  // Skip omnibus/box-set editions ("Book A / Book B / ...") — clutter in an author list.
  const rows = deduped.filter(x =>
    x.title && !isForeignOnly(x) && !isJunkTitle(x) && !inLibrary(x))
    .filter((x, i, a) => !isMashedTitle(x, a)) // v116: "Book ABook B" mashups
    .slice(0, 30);
  await backfillCovers(rows); // v116: edition covers for coverless survivors
  authorCache.set(key, rows);
  return rows;
}

// v115: Open Library work records are sometimes created from a translated
// edition, so the work's canonical title can be non-English ("Alas de ónix"
// instead of "Onyx Storm") even when English editions exist. For suspicious
// titles, pull the work's editions and take the first English one's title.
async function repairTranslatedTitles(rows) {
  const suspects = rows.filter(r =>
    /[^\x00-\x7F]/.test(r.title) && // non-ASCII in the title…
    (r.languages || []).some(l => l === 'eng') && // …but English editions exist
    r.workKey);
  for (const r of suspects) {
    try {
      const d = await (await fetch('https://openlibrary.org' + r.workKey + '/editions.json?limit=50')).json();
      const eng = ((d || {}).entries || []).find(e =>
        (e.languages || []).some(l => String(l.key || '').endsWith('/eng')) && e.title);
      if (eng) {
        if (eng.title && eng.title !== r.title) r.title = eng.title;
        if (!r.cover && (eng.covers || []).length) // v116: editions often have art the work lacks
          r.cover = 'https://covers.openlibrary.org/b/id/' + eng.covers[0] + '-M.jpg';
      }
    } catch (e) { /* keep the original title */ }
  }
}

// v116: some works only exist in Open Library as a translation ("Alas de
// sangre (Empíreo 1)" is really Fourth Wing). When the Hardcover token is
// available, resolve the edition ISBN to Hardcover's canonical book so the row
// shows the real title — and matches her shelf instead of looking "missing".
async function resolveForeignTitles(rows) {
  if (typeof hcReady !== 'function' || !hcReady()) return;
  const targets = rows.filter(r =>
    /[^\x00-\x7F]/.test(r.title) && /^\d{13}$/.test(normISBN(r.isbn)));
  if (!targets.length) return;
  const isbns = [...new Set(targets.map(r => normISBN(r.isbn)))];
  try {
    const q = 'query { books(where: {editions: {isbn_13: {_in: [' +
      isbns.map(s => JSON.stringify(s)).join(',') + ']}}, limit: 25) ' +
      '{ title image { url } editions { isbn_13 } } }';
    const data = await hcGraphQL(q);
    const byIsbn = {};
    ((data || {}).books || []).forEach(b => {
      (b.editions || []).forEach(e => { if (e.isbn_13) byIsbn[normISBN(e.isbn_13)] = b; });
    });
    targets.forEach(r => {
      const b = byIsbn[normISBN(r.isbn)];
      if (b && b.title) {
        r.title = b.title;
        if (!r.cover && b.image && b.image.url) r.cover = b.image.url;
      }
    });
  } catch (e) { /* keep the Open Library titles */ }
}

// v116: some works have no cover at the work level but their editions do.
async function backfillCovers(rows) {
  for (const r of rows.filter(x => !x.cover && x.workKey)) {
    try {
      const d = await (await fetch('https://openlibrary.org' + r.workKey + '/editions.json?limit=20')).json();
      const withCover = ((d || {}).entries || []).find(e => (e.covers || []).length);
      if (withCover) r.cover = 'https://covers.openlibrary.org/b/id/' + withCover.covers[0] + '-M.jpg';
    } catch (e) { /* stays coverless */ }
  }
}

// Every book in a series via Hardcover (needs the token).
async function fetchSeriesBooks(seriesName, authorName) {
  const key = String(seriesName).trim().toLowerCase();
  if (seriesCache.has(key)) return seriesCache.get(key);
  if (!hcReady()) { const r = { needsToken: true, rows: [] }; seriesCache.set(key, r); return r; }
  const fullFields = 'id name author { name }' +
    ' book_series(distinct_on: position, order_by: [{position: asc}, {book: {users_count: desc}}],' +
    ' where: {compilation: {_eq: false}, book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}}}) {' +
    ' position details book { id title image { url } default_physical_edition { isbn_13 } } }';
  // Slim variant (no nested image/edition objects) in case the server enforces
  // a shallower max query depth — rows come back cover-less rather than
  // failing outright. The row mapper below is already null-safe for this.
  const slimFields = fullFields.replace(' image { url } default_physical_edition { isbn_13 }', '');
  // v82 fix: books_count/canonical_id are *filters* — they belong inside the
  // where clause (Hardcover's documented GettingBooksInSeries query). As
  // sibling arguments they were rejected by GraphQL validation.
  const qDetail = (whereInner, fields) => 'query { series(where: {' + whereInner +
    ', books_count: {_gt: 0}, canonical_id: {_is_null: true}}, limit: 5) { ' + fields + ' } }';
  const noData = () => { throw new Error('Hardcover returned no data — the token may be invalid or revoked.'); };
  // Runs the detail query, retrying once with the slim field set if the
  // server rejects the nesting depth.
  async function detail(whereInner) {
    try {
      const d = await hcGraphQL(qDetail(whereInner, fullFields));
      if (!d) noData();
      return d.series || [];
    } catch (e) {
      if (!/depth/i.test(e.message || '')) throw e;
      const d = await hcGraphQL(qDetail(whereInner, slimFields));
      if (!d) noData();
      return d.series || [];
    }
  }
  // v83: pattern operators (_ilike and friends) are blocked server-side (HTTP
  // 403), so the name lookup uses _eq; anything fuzzier goes through the
  // Typesense search endpoint to resolve the series id first.
  let list = await detail('name: {_eq: ' + JSON.stringify(seriesName) + '}');
  if (!list.length) {
    const sid = await searchSeriesId(seriesName, authorName);
    if (sid) list = await detail('id: {_eq: ' + sid + '}');
  }
  const want = String(authorName || '').trim().toLowerCase();
  const hit = list.find(s => want && String((s.author || {}).name || '').trim().toLowerCase() === want) || list[0];
  let rows = [];
  if (hit) {
    const sAuthor = (hit.author || {}).name || authorName || '';
    rows = dedupeExternal((hit.book_series || []).map(bs => {
      const bk = bs.book || {};
      const pos = parseFloat(bs.position);
      return {
        title: bk.title || '',
        author: sAuthor,
        cover: (bk.image || {}).url || '',
        isbn: normISBN((bk.default_physical_edition || {}).isbn_13),
        position: isNaN(pos) ? (bs.details || null) : (Number.isInteger(pos) ? pos : Math.round(pos * 10) / 10),
        seriesName: hit.name,
      };
    }).filter(x => x.title && !inLibrary(x)));
  }
  const out = { rows };
  seriesCache.set(key, out);
  return out;
}

// Resolve a Hardcover series id via the Typesense search endpoint, since
// pattern operators (_ilike and friends) are blocked by the API (HTTP 403).
// Prefers the hit whose author matches, otherwise the top hit. Returns the
// numeric id or null.
async function searchSeriesId(seriesName, authorName) {
  const q = 'query { search(query: ' + JSON.stringify(seriesName) +
    ', query_type: "Series", per_page: 5, page: 1) { results } }';
  const data = await hcGraphQL(q);
  if (!data) return null;
  const docs = hcHits(data).map(h => (h && h.document) || {}).filter(d => d.id != null);
  const want = String(authorName || '').trim().toLowerCase();
  const hit = docs.find(d => want && String(d.author_name || '').trim().toLowerCase() === want) || docs[0];
  const sid = hit && Number(hit.id);
  return sid || null;
}

// Add a discovered book straight to the wishlist (she doesn't own it yet).
function addExternalBook(x) {
  const book = {
    id: uid(),
    isbn: x.isbn || '',
    title: x.title,
    authors: x.author ? [x.author] : [],
    cover: x.cover || '',
    description: '',
    pageCount: null,
    publishedDate: '',
    categories: [],
    publicRating: null,
    ratingsCount: 0,
    status: 'tbr',
    owned: false, // discovered = wanted
    ratings: {},
    myRating: 0,
    tropes: [],
    progress: 0,
    dateAdded: new Date().toISOString(),
    dateFinished: null,
    notes: '',
    favorite: false,
    series: x.seriesName ? { name: x.seriesName, position: x.position } : null,
    log: [],
    _mtime: Date.now(),
  };
  book.axes = autoDetectAxes(book);
  library.unshift(book);
  saveLibrary();
  return book;
}

function externalRowHTML(x, i) {
  const sub = (x.position != null && x.position !== '' ? '#' + esc(String(x.position)) + ' · ' : '') +
    esc(x.author || 'Unknown author');
  return '<div class="crow ext" data-ext="' + i + '">' +
    (x.cover ? '<img src="' + esc(x.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
      : '<span class="cnocover">' + icon('covers') + '</span>') +
    '<span class="ctext"><b>' + esc(x.title) + '</b><small>' + sub + '</small></span>' +
    '<button class="btn small" data-extadd="' + i + '">+ Wishlist</button></div>';
}

/* ---- external book detail sheet (v60): tap a missing/discovered book to see
   its details. Enriches live via ISBN lookup (Google Books → Open Library),
   falling back to a title+author search when there is no ISBN. ---- */
function openExternalDetail(x) {
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  const sub = (x.position != null && x.position !== '' ? '#' + esc(String(x.position)) + ' · ' : '') +
    (x.seriesName ? esc(x.seriesName) + ' · ' : '') + esc(x.author || 'Unknown author');
  ov.innerHTML =
    '<div class="modal-backdrop" id="x-back" style="z-index:80"><div class="modal" role="dialog">' +
    '<button class="modal-close" id="x-x">✕</button>' +
    '<div class="ext-detail">' +
    (x.cover ? '<img class="ext-cover" src="' + esc(x.cover) + '" alt="" onerror="this.remove()">'
      : '<div class="ext-nocover">' + icon('covers') + '</div>') +
    '<h2 class="serif">' + esc(x.title) + '</h2>' +
    '<p class="note">' + sub + '</p>' +
    '<div id="x-meta"><p class="note">Looking up details…</p></div>' +
    '<div id="x-desc"></div>' +
    '<button class="btn" id="x-wish" style="width:100%;margin-top:14px">' + icon('gift') + ' Wishlist</button>' +
    '</div></div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#x-back').addEventListener('click', e => { if (e.target.id === 'x-back') close(); });
  ov.querySelector('#x-x').addEventListener('click', close);
  let added = false;
  ov.querySelector('#x-wish').addEventListener('click', () => {
    if (added) return;
    added = true;
    addEnrichedToWishlist(x, ov._full);
    const btn = ov.querySelector('#x-wish');
    if (btn) btn.outerHTML = '<p class="note" style="text-align:center">' + icon('gift') + ' In your wishlist</p>';
    toast('Added to wishlist 💝');
  });
  // enrich in the background; the sheet stays usable meanwhile
  (async () => {
    let full = null;
    try {
      if (x.isbn) full = await lookupISBN(x.isbn);
      if (!full) {
        const res = await searchBooks((x.title || '') + ' ' + (x.author || ''));
        const nt = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        full = ((res || []).find(r => nt(r.title) === nt(x.title)) || (res || [])[0]) || null;
      }
    } catch (e) { /* show what we have */ }
    ov._full = full;
    const metaBox = ov.querySelector('#x-meta');
    if (!metaBox) return; // sheet was closed already
    if (!full) {
      metaBox.innerHTML = '<p class="note">Couldn\'t pull full details for this one.</p>';
      return;
    }
    const bits = [];
    if (full.pageCount) bits.push(full.pageCount + ' pages');
    const yr = String(full.publishedDate || '').slice(0, 4);
    if (/^\d{4}$/.test(yr)) bits.push(yr);
    if (full.publicRating) bits.push('★ ' + full.publicRating +
      (full.ratingsCount ? ' (' + full.ratingsCount + ')' : ''));
    metaBox.innerHTML = bits.length
      ? '<p class="ext-bits">' + bits.map(esc).join(' · ') + '</p>' : '';
    if (full.description) {
      const d = ov.querySelector('#x-desc');
      if (d) d.innerHTML = '<p class="ext-desc">' + esc(full.description) + '</p>';
    }
    const img = ov.querySelector('.ext-cover');
    if (full.cover && img && img.getAttribute('src') !== full.cover) img.src = full.cover;
  })();
}

// Add an external book to the wishlist, keeping any enriched metadata.
function addEnrichedToWishlist(x, full) {
  const ex = {
    title: (full && full.title) || x.title,
    author: ((full && full.authors && full.authors[0]) || x.author || ''),
    cover: (full && full.cover) || x.cover || '',
    isbn: (full && full.isbn) || x.isbn || '',
    position: x.position != null ? x.position
      : (full && full.series && full.series.position),
    seriesName: x.seriesName || (full && full.series && full.series.name) || null,
  };
  const book = addExternalBook(ex);
  if (full) {
    if (full.description) book.description = full.description;
    if (full.pageCount) book.pageCount = full.pageCount;
    if (full.publishedDate) book.publishedDate = full.publishedDate;
    if (full.categories && full.categories.length) book.categories = full.categories;
    if (full.publicRating) {
      book.publicRating = full.publicRating;
      book.ratingsCount = full.ratingsCount || 0;
    }
    book.axes = autoDetectAxes(book);
    saveLibrary();
  }
  return book;
}

// Fill the "more books" section of the collection sheet (async, after it opens).
async function fillMoreSection(kind, name, fromId, ov) {
  const box = ov.querySelector('#c-more');
  if (!box) return;
  // The icon is trusted markup — only the text (which carries the library's
  // own author/series name) goes through esc().
  const headingHTML = '<h3 class="serif c-more-h">' + icon('search') + ' ' +
    esc(kind === 'author' ? 'More by ' + name : 'Every book in this series') + '</h3>';
  try {
    let rows;
    if (kind === 'author') {
      rows = await fetchMoreByAuthor(name);
    } else {
      const from = library.find(b => b.id === fromId);
      const r = await fetchSeriesBooks(name, from && from.authors[0]);
      if (r.needsToken) {
        box.innerHTML = headingHTML +
          '<p class="note">' + icon('bulb') + ' Connect Hardcover in Settings to see every book in this series.</p>';
        return;
      }
      rows = r.rows;
    }
    if (!rows.length) {
      box.innerHTML = headingHTML +
        '<p class="note">Nothing missing — nice shelf!</p>';
      return;
    }
    box.innerHTML = headingHTML +
      '<div class="collection-list">' + rows.map(externalRowHTML).join('') + '</div>';
    box.querySelectorAll('[data-extadd]').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addExternalBook(rows[Number(btn.dataset.extadd)]);
        btn.outerHTML = '<span class="c-added">' + icon('gift') + ' In wishlist</span>';
        toast('Added to wishlist 💝');
      }));
    // v60: tapping the row itself opens the detail sheet
    box.querySelectorAll('[data-ext]').forEach(row =>
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-extadd]')) return;
        openExternalDetail(rows[Number(row.dataset.ext)]);
      }));
  } catch (e) {
    // v77: hcGraphQL errors are specific now (token rejected / network /
    // Hardcover error), so show the real reason instead of a generic hint.
    const hint = kind === 'series'
      ? 'Hardcover lookup failed — ' + esc(String((e && e.message) || 'unknown error'))
      : 'Couldn\'t look up more books right now.';
    box.innerHTML = headingHTML +
      '<p class="note">' + hint + '</p>';
  }
}

function openCollection(kind, name, fromId) {
  const key = String(name).trim().toLowerCase();
  const match = b => kind === 'author'
    ? (b.authors || []).some(a => String(a).trim().toLowerCase() === key)
    : (b.series && b.series.name && String(b.series.name).trim().toLowerCase() === key);
  const others = library.filter(b => b.id !== fromId && match(b));
  others.sort((a, b) => {
    if (kind === 'series') {
      const pa = parseFloat(a.series && a.series.position), pb = parseFloat(b.series && b.series.position);
      const d = (isNaN(pa) ? 1e9 : pa) - (isNaN(pb) ? 1e9 : pb);
      if (d) return d;
    }
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="c-back" style="z-index:70"><div class="modal" role="dialog">' +
    '<button class="modal-close" id="c-x">✕</button>' +
    '<h2 class="serif" style="margin-top:0">' + icon(kind === 'author' ? 'pencil' : 'series') + ' ' + esc(name) + '</h2>' +
    '<p class="note">' + others.length + ' other book' + (others.length === 1 ? '' : 's') + ' on your shelves</p>' +
    (others.length
      ? '<div class="collection-list">' + others.map(collectionRowHTML).join('') + '</div>'
      : '<p class="note">Nothing else here yet — this is the only one.</p>') +
    '<div id="c-more"><p class="note">Looking for more books…</p></div>' +
    '</div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#c-back').addEventListener('click', e => { if (e.target.id === 'c-back') close(); });
  ov.querySelector('#c-x').addEventListener('click', close);
  ov.querySelectorAll('[data-book]').forEach(el =>
    el.addEventListener('click', () => {
      const r = el.getBoundingClientRect(); // capture before close() detaches it
      close();
      openDetail(el.dataset.book, { fromRect: r });
    }));
  fillMoreSection(kind, name, fromId, ov);
}

/* ---- book-opening transition: the tapped cover flies to center, then swings
   open like a real book cover, revealing the detail modal behind it ---- */
function bookCoverFaceHTML(b) {
  if (b.cover) return '<img src="' + esc(b.cover) + '" alt="">';
  const c = (typeof spineColorCache !== 'undefined' && spineColorCache[b.id] && spineColorCache[b.id].hex) ||
    SPINE_COLORS[hashStr(b.title || '?') % SPINE_COLORS.length];
  return '<div class="bo-nocover" style="background:' + c + '"><span>' + icon('covers') + '</span><b>' +
    esc(b.title || 'Untitled') + '</b></div>';
}
// from: element or rect the cover starts from. dropEl: removed in the same
// frame (used by the spine pull-out so its popped cover swaps seamlessly).
function playBookOpen(b, from, dropEl, done) {
  const r = from && from.getBoundingClientRect ? from.getBoundingClientRect() : from;
  const vw = window.innerWidth || 360, vh = window.innerHeight || 640;
  const bw = Math.min(230, vw * 0.62), bh = bw * 1.5;
  const cx = (vw - bw) / 2, cy = Math.max(8, (vh - bh) / 2 - 24);
  const start = (r && r.width > 4)
    ? 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px'
    : 'left:' + cx + 'px;top:' + cy + 'px;width:' + bw + 'px;height:' + bh + 'px';
  const ov = document.createElement('div');
  ov.className = 'bookopen-overlay';
  ov.innerHTML =
    '<div class="bookopen-backdrop"></div>' +
    '<div class="bookopen-stage" style="' + start + '">' +
      '<div class="bookopen-book">' +
        '<div class="bookopen-pages"><div class="bop-title">' + esc(b.title || 'Untitled') + '</div>' +
        '<div class="bop-lines"></div></div>' +
        '<div class="bookopen-cover">' + bookCoverFaceHTML(b) + '</div>' +
      '</div></div>';
  if (dropEl && dropEl.remove) dropEl.remove();
  document.body.appendChild(ov);
  const stage = ov.querySelector('.bookopen-stage');
  const book = ov.querySelector('.bookopen-book');
  const raf = window.requestAnimationFrame || (fn => setTimeout(fn, 16));
  raf(() => raf(() => {
    ov.classList.add('lit');
    stage.style.left = cx + 'px'; stage.style.top = cy + 'px';
    stage.style.width = bw + 'px'; stage.style.height = bh + 'px';
  }));
  const FLY = 400, FLIP = 750;
  setTimeout(() => book.classList.add('open'), FLY);
  setTimeout(() => { done(); ov.classList.add('gone'); }, FLY + Math.round(FLIP * 0.55));
  setTimeout(() => ov.remove(), FLY + Math.round(FLIP * 0.55) + 450);
}
// Open a book's detail modal, playing the book-opening transition when the
// call site has a cover element (or rect) to start from and motion is allowed.
function openBookFromEl(el, id) {
  openDetail(id, el ? { fromEl: el } : null);
}
/* ---- v110: "More like this" — similar books from her own shelves ---- */
// Ranked by shared tropes (3 pts), shared genres (2 pts), same author (4 pts),
// spice-level closeness, with a nudge for books she rated 4★+. Purely local.
function similarBooks(book, limit) {
  const norm = s => String(s || '').trim().toLowerCase();
  const bTropes = new Set((book.tropes || []).map(norm));
  const bCats = new Set((book.categories || []).map(norm));
  const bAuthors = new Set((book.authors || []).map(norm));
  const bSpice = Number((book.ratings || {}).spice) || 0;
  const scored = [];
  library.forEach(o => {
    if (!o || o.id === book.id) return;
    let score = 0;
    (o.tropes || []).forEach(t => { if (bTropes.has(norm(t))) score += 3; });
    (o.categories || []).forEach(c => { if (bCats.has(norm(c))) score += 2; });
    if ((o.authors || []).some(a => bAuthors.has(norm(a)))) score += 4;
    const oSpice = Number((o.ratings || {}).spice) || 0;
    if (bSpice && oSpice) score += Math.max(0, 3 - Math.abs(bSpice - oSpice));
    if (score <= 0) return;
    if ((o.myRating || 0) >= 4) score += 1;
    scored.push({ book: o, score: score });
  });
  scored.sort((x, y) => y.score - x.score ||
    String(x.book.title || '').localeCompare(String(y.book.title || '')));
  return scored.slice(0, limit || 6).map(s => s.book);
}
function openDetail(id, opts) {
  const b = library.find(x => x.id === id);
  if (!b) return;
  track('book_opened', null, { dedupeKey: 'open-' + id, dedupeMs: 60000 });
  const from = opts && (opts.fromEl || opts.fromRect);
  if (from && !reducedMotion()) {
    playBookOpen(b, from, opts.dropEl, () => renderDetailModal(b, true));
  } else {
    if (opts && opts.dropEl && opts.dropEl.remove) opts.dropEl.remove();
    renderDetailModal(b, false);
  }
}
function renderDetailModal(b, viaBook) {
  const id = b.id;
  editingId = id;
  const root = document.getElementById('modal-root');

  const segBtns = Object.keys(STATUS).map(s =>
    '<button data-s="' + s + '" class="' + (b.status === s ? 'active' : '') + '">' +
    ({ tbr: icon('tbr') + ' TBR', reading: icon('reading') + ' Reading', read: icon('read') + ' Read', dnf: icon('dnf') + ' DNF' })[s] + '</button>').join('');

  const hearts = [1, 2, 3, 4, 5].map(n =>
    '<button data-v="' + n + '" class="' + (b.myRating >= n ? 'on' : '') + '">' + icon('heart') + '</button>').join('');

  // draft copy the controls edit until Save
  const draft = Object.assign({}, b, {
    tropes: (b.tropes || []).slice(),
    ratings: Object.assign({}, b.ratings),
    axes: (b.axes || []).slice()
  });
  if (!draft.axes.length) draft.axes = autoDetectAxes(draft);
  editingDraft = draft;

  // v67: previously-read default from history — a finish older than 60 days
  // means she read it before tracking, so don't stamp or log today.
  if (draft.previouslyRead == null) {
    draft.previouslyRead = !!(draft.dateFinished && Date.now() - new Date(draft.dateFinished).getTime() > 60 * 864e5);
  }
  let startProgress = draft.progress || 0; // v67: only genuine progress edits log pages

  // v131: mood ratings as segmented bars — icon + label, 5 tap segments,
  // numeric readout, × removes the axis; unapplied axes offered as + chips.
  const RATING_WORDS = ['Tap to rate', 'Not for me', 'Meh', 'Liked it', 'Really liked it', 'Loved it'];
  // v132: per-axis color + level word (e.g. Spice 4 = "Explicit").
  const axWord = (a, v) => v ? a.levels[v - 1] : 'Tap to rate';
  const axRowHTML = (k) => {
    const a = axisByKey(k);
    const v = draft.ratings[k] || 0;
    const segs = [1, 2, 3, 4, 5].map(n =>
      '<i data-v="' + n + '" class="' + (v >= n ? 'f' : '') + '"></i>').join('');
    return '<div class="axrow" data-ax="' + k + '" style="--axc:' + a.color + '">' +
      '<div class="axhead"><span class="axlab">' + icon(a.icon || 'pepper') + ' ' + esc(a.label) + '</span>' +
      '<span class="axword">' + esc(axWord(a, v)) + '</span></div>' +
      '<div class="axbar-row"><div class="segbar" role="slider" aria-label="' + esc(a.label) + ' rating" ' +
      'aria-valuemin="0" aria-valuemax="5" aria-valuenow="' + v + '">' + segs + '</div>' +
      '<span class="segnum">' + (v || '–') + '</span>' +
      '<button class="axrm" data-axrm="' + k + '" aria-label="Remove ' + esc(a.label) + ' rating">×</button></div></div>';
  };
  const axAddHTML = () => RATING_AXES.filter(a => !draft.axes.includes(a.key)).map(a =>
    '<button class="chip" data-axadd="' + a.key + '">+ ' + esc(a.label) + '</button>').join('');

  // Quick page tracker for books being read: steppers + manual entry save
  // immediately — no need to dig into Details or hit Save.
  const applyProgress = (next) => {
    const total = draft.pageCount || 0;
    const oldP = draft.progress || 0;
    draft.progress = total ? Math.max(0, Math.min(total, next)) : Math.max(0, next);
    logPages(b, oldP, draft.progress);
    draft.log = b.log; // logPages may have created the array on b
    b.progress = draft.progress; // immediate save — no need to hit Save
    saveLibrary();
    const inp = document.getElementById('f-progress');
    if (inp) inp.value = draft.progress;
    renderProgressSection();
  };
  const progressQuickHTML = () => {
    if (draft.status !== 'reading') return '';
    const total = draft.pageCount || 0;
    const cur = total ? Math.min(draft.progress || 0, total) : (draft.progress || 0);
    const pct = total ? Math.round(cur / total * 100) : 0;
    return '<div class="field"><label>Reading progress</label>' +
      '<div class="progress-line big"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<p class="pq-label">' + (total
        ? 'Page <b>' + cur + '</b> of ' + total + ' · ' + pct + '%'
        : 'Page <b>' + cur + '</b> — set total pages below to see %') + '</p>' +
      '<div class="pq-manual"><input id="pq-page" class="text-input" type="number" min="0" ' +
      'inputmode="numeric" placeholder="Page number…" aria-label="Go to page">' +
      '<button class="btn" id="pq-set">Set page</button></div>' +
      '<div class="stepper-row">' +
      ['−10', '−1', '+1', '+10'].map(d =>
        '<button class="btn ghost step" data-step="' + d.replace('−', '-') + '" aria-label="Adjust by ' + d + ' pages">' + d + '</button>').join('') +
      '</div></div>';
  };
  const renderProgressSection = () => {
    const el = document.getElementById('m-progress');
    if (!el) return;
    el.innerHTML = progressQuickHTML();
    el.querySelectorAll('[data-step]').forEach(btn =>
      btn.addEventListener('click', () => applyProgress((draft.progress || 0) + Number(btn.dataset.step))));
    const setBtn = document.getElementById('pq-set');
    const pageInp = document.getElementById('pq-page');
    const setFromInput = () => {
      const v = parseInt(pageInp.value, 10);
      if (isNaN(v) || v < 0) { pageInp.focus(); return; }
      applyProgress(v);
    };
    if (setBtn) setBtn.addEventListener('click', setFromInput);
    if (pageInp) pageInp.addEventListener('keydown', e => { if (e.key === 'Enter') setFromInput(); });
  };
  refreshProgressSection = renderProgressSection;

  root.innerHTML =
    '<div class="modal-backdrop' + (viaBook ? ' from-book' : '') + '" id="m-back"><div class="modal" role="dialog" aria-modal="true" aria-label="Book details">' +
    '<button class="modal-close" id="m-x" aria-label="Close">✕</button>' +
    '<div class="modal-head"><div class="mcover-col">' + coverHTML(b) +
    '<button class="btn ghost sm" id="m-changecover" title="Choose a different cover">' + icon('image') + '</button></div>' +
    '<div><h2>' + esc(b.title) + '</h2>' +
    '<p class="author">' + ((b.authors && b.authors.length)
      ? b.authors.map(a => '<button class="taplink" data-author="' + esc(a) + '">' + esc(a) + '</button>').join(', ')
      : 'Unknown author') + '</p>' +
    (b.publicRating ? '<div class="pub-rating">Public: ' + stars(b.publicRating) + ' · ' + b.ratingsCount + ' ratings</div>' : '<div class="pub-rating">No public rating found</div>') +
    // v131: your rating lives in the header — visible the moment the modal opens.
    '<div class="hrate"><span class="hrate-label">Your rating</span>' +
    '<div class="hrate-row"><div class="picker" id="f-myrating">' + hearts + '</div>' +
    '<span class="rate-word" id="f-myrating-word">' + RATING_WORDS[b.myRating || 0] + '</span></div></div>' +
    (b.pageCount ? '<div class="pub-rating">' + b.pageCount + ' pages' + (b.publishedDate ? ' · ' + esc(b.publishedDate.slice(0, 4)) : '') + '</div>' : '') +
    (releaseCountdown(b.releaseDate) ? '<div class="pub-rating release-line">' + icon('calendar') + ' Releases ' + esc(fmtDate(b.releaseDate)) + ' · ' + releaseCountdown(b.releaseDate) + '</div>' : '') +
    // v130: description lives with the cover — clamped with a Read more toggle.
    (b.description
      ? '<div class="m-desc" id="m-desc"><p>' + esc(String(b.description).replace(/<[^>]*>/g, '')) + '</p>' +
        '<button class="taplink" id="m-desc-toggle">Read more</button></div>'
      : '') +
    '</div>' +
    '<button class="fav-btn' + (draft.favorite ? ' on' : '') + '" id="f-fav" aria-label="Toggle favorite">' + icon('heart') + '</button></div>' +
    // v124: priority first — progress, shelf, ratings. Everything else
    // collapses into labeled sections (simple by default, powerful when needed).
    '<div id="m-progress"></div>' +

    '<div class="field"><label>Shelf</label><div class="seg" id="f-status">' + segBtns + '</div>' +
    '<label class="checkline" id="f-prevwrap" style="' + (draft.status === 'read' ? '' : 'display:none') + '">' +
    '<input type="checkbox" id="f-prevread"' + (draft.previouslyRead ? ' checked' : '') + '> ' + icon('history') + ' Previously read' +
    '<span class="chk-hint">read before tracking — no date stamp, no log</span></label></div>' +

    '<div class="field"><label>Mood ratings</label>' +
    '<div id="f-axrows">' + draft.axes.map(axRowHTML).join('') + '</div>' +
    '<div class="chips" id="f-axadd">' + axAddHTML() + '</div></div>' +

    '<details class="m-collapsible" id="m-sec-details"><summary>' + icon('doc') + ' Details</summary>' +
    '<div class="field"><label>Tropes (comma separated)</label>' +
    '<input id="f-tropes" class="text-input" placeholder="enemies to lovers, forced proximity…" value="' + esc(b.tropes.join(', ')) + '">' +
    '<div id="f-tropesugg" class="chips" style="margin-top:6px"></div></div>' +
    '<div class="field"><label>Total pages</label>' +
    '<div class="row-flex"><input id="f-pagecount" class="text-input" type="number" min="0" inputmode="numeric" placeholder="e.g. 384" value="' + (draft.pageCount || '') + '">' +
    (b.isbn ? '<button class="btn ghost" id="pc-lookup" title="Look up page count by ISBN">' + icon('search') + '</button>' : '') + '</div></div>' +
    '<div class="field"><label>Current page</label>' +
    '<input id="f-progress" class="text-input" type="number" min="0" inputmode="numeric" value="' + (draft.progress || 0) + '"></div>' +
    '<div class="field"><label>' + icon('calendar') + ' Release date</label>' +
    '<input id="f-releasedate" class="text-input" type="date" value="' + esc(b.releaseDate || '') + '">' +
    '<p class="note">For announced books — the Wishlist surfaces them under “Coming soon”.</p></div>' +
    '</details>' +

    '<details class="m-collapsible" id="m-sec-discovery"><summary>' + icon('sparkles') + ' Series & Discovery</summary>' +
    '<div id="m-hc">' + hcDetailHTML(b) + '</div>' +
    '<div class="field"><label>' + icon('sparkles') + ' More like this <span class="note-inline">· from your shelves</span></label>' +
    (() => { // v110: similar owned books, ranked by tropes/genres/author/spice
      const sims = similarBooks(b, 6);
      if (!sims.length) return '<p class="note">No close matches yet — tropes and genres power this.</p>';
      track('similar_books_opened', null, { dedupeKey: 'sim-' + b.id, dedupeMs: 60000 });
      return '<div class="sim-row">' + sims.map(o =>
        '<button class="sim-cover" data-sim="' + o.id + '" aria-label="' + esc(o.title) + '">' +
        (o.cover ? '<img src="' + esc(o.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
                 : '<span class="sim-nocover">' + icon('covers') + '</span>') +
        '<small>' + esc(o.title) + '</small></button>').join('') + '</div>';
    })() + '</div>' +
    '</details>' +

    '<details class="m-collapsible" id="m-sec-personal"><summary>' + icon('pencil') + ' Personal</summary>' +
    '<div class="field"><button class="btn ghost block" id="m-upnext">' +
    (upNext.includes(b.id) ? '✓ In your Up Next queue — tap to remove' : icon('upnext') + ' Add to Up Next') +
    '</button></div>' +
    '<div class="field"><label>My notes</label>' +
    '<textarea id="f-notes" class="text-input" placeholder="Thoughts, quotes, warnings for future self…">' + esc(b.notes) + '</textarea></div>' +
    (() => { // v68: optional "remove today's entry" button (Settings → Reading log)
      if (!logRemoveEnabled()) return '';
      const tk = dayKey(new Date());
      const n = pagesOnDay(b, tk);
      if (!n) return '';
      return '<div class="field"><button class="btn ghost danger" id="m-rmlog">' + icon('trash') + ' Remove today’s entry (' + n + ' pages)</button></div>';
    })() +
    '</details>' +

    '<details class="m-collapsible" id="m-sec-owned"><summary>' + icon('gift') + ' Ownership</summary>' +
    '<div class="field"><label>Ownership</label><div class="seg" id="f-owned" style="grid-template-columns:1fr 1fr">' +
    '<button data-o="1" class="' + (draft.owned ? 'active' : '') + '">' + icon('owned') + ' Owned</button>' +
    '<button data-o="0" class="' + (!draft.owned ? 'active' : '') + '">' + icon('tobuy') + ' To buy</button></div></div>' +
    '<div class="field" id="m-buywrap" style="display:' + (draft.owned ? 'none' : '') + '">' +
    '<label>Where to buy <span class="note-inline">· ' + esc(STORE_REGIONS[detectStoreRegion()].label) + '</span></label>' +
    '<div class="buy-row">' + storeLinks(draft).map(l =>
      '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(l.url) + '">' + esc(l.name) + ' ' + icon('external') + '</a>').join('') +
    '</div></div>' +
    '</details>' +

    '<details class="m-collapsible"><summary>' + icon('quotes') + ' Quotes <span class="note-inline">· ' + (b.quotes || []).length + '</span></summary>' +
    '<div id="m-quotes"></div></details>' +

    '<div class="modal-actions"><button class="btn primary" id="m-primary"></button>' +
    '<div class="more-wrap"><button class="btn ghost" id="m-more" aria-label="More actions" aria-haspopup="true">' + icon('dots') + '</button>' +
    '<div class="more-menu" id="m-moremenu" hidden>' +
    '<button class="more-item" id="m-share">' + icon('share') + ' Share</button>' +
    '<button class="more-item danger" id="m-del">Remove</button>' +
    '</div></div>' +
    '<button class="btn" id="m-save">Save</button></div>' +
    '</div></div>';

  // v123: contextual primary action — the one thing she most likely wants,
  // based on the book's shelf. Secondary actions live behind the ⋮ menu.
  const PRIMARY = {
    tbr:     { label: 'Start Reading',    ic: 'reading', run: () => primarySetStatus('reading') },
    reading: { label: 'Log Pages',        ic: 'pencil',  run: () => scrollToField('m-progress') },
    read:    { label: 'Rate & Review',    ic: 'heart',   run: () => scrollToField('f-myrating') },
    dnf:     { label: 'Give it another go', ic: 'tbr',   run: () => primarySetStatus('tbr') },
  };
  const paintPrimary = () => {
    const cfg = PRIMARY[draft.status] || PRIMARY.tbr;
    const btn = document.getElementById('m-primary');
    if (btn) btn.innerHTML = icon(cfg.ic) + ' ' + esc(cfg.label);
  };
  const primarySetStatus = (s) => {
    const from = b.status;
    if (from === s) return;
    b.status = s; draft.status = s;
    if (['reading', 'read', 'dnf'].includes(s)) upNextRemove(id);
    if (s === 'read' && b.pageCount && !b.previouslyRead) b.progress = b.pageCount;
    saveLibrary();
    track('book_status_changed', { from: from, to: s });
    if (s === 'read') track('book_completed');
    toast(s === 'reading' ? 'Happy reading ✨' : 'Back on the TBR');
    root.querySelectorAll('#f-status button').forEach(x => x.classList.toggle('active', x.dataset.s === s));
    paintPrimary();
    renderProgressSection();
  };
  const scrollToField = (fid) => {
    const el = document.getElementById(fid);
    if (!el) return;
    let d = el.closest('details'); // v124: open collapsed ancestors first
    while (d) { d.open = true; d = d.parentElement ? d.parentElement.closest('details') : null; }
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  };
  paintPrimary();
  document.getElementById('m-primary').addEventListener('click', () => {
    const cfg = PRIMARY[draft.status] || PRIMARY.tbr;
    cfg.run();
  });
  const moreBtn = document.getElementById('m-more');
  const moreMenu = document.getElementById('m-moremenu');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  });
  root.addEventListener('click', (e) => {
    if (!moreMenu.hidden && !e.target.closest('.more-wrap')) moreMenu.hidden = true;
  });

  // wire controls (work on the draft copy until Save)
  const renderAxSection = () => {
    document.getElementById('f-axrows').innerHTML = draft.axes.map(axRowHTML).join('');
    document.getElementById('f-axadd').innerHTML = axAddHTML();
    wireAxRows();
  };
  const wireAxRows = () => {
    root.querySelectorAll('#f-axrows [data-ax]').forEach(row => {
      const k = row.dataset.ax;
      const bar = row.querySelector('.segbar');
      bar.querySelectorAll('i').forEach(seg => seg.addEventListener('click', () => {
        const v = Number(seg.dataset.v);
        draft.ratings[k] = (draft.ratings[k] === v) ? 0 : v; // tap again to clear
        const nv = draft.ratings[k];
        bar.querySelectorAll('i').forEach((x, i) => x.classList.toggle('f', i < nv));
        bar.setAttribute('aria-valuenow', nv);
        row.querySelector('.segnum').textContent = nv || '–';
        const a = axisByKey(k); // v132: level word follows the value
        row.querySelector('.axword').textContent = nv ? a.levels[nv - 1] : 'Tap to rate';
      }));
      const rm = row.querySelector('[data-axrm]');
      if (rm) rm.addEventListener('click', () => {
        draft.axes = draft.axes.filter(x => x !== k);
        delete draft.ratings[k];
        renderAxSection();
      });
    });
    root.querySelectorAll('#f-axadd [data-axadd]').forEach(c => c.addEventListener('click', () => {
      draft.axes = draft.axes.concat(c.dataset.axadd);
      renderAxSection();
    }));
  };

  root.querySelectorAll('#f-status button').forEach(btn =>
    btn.addEventListener('click', () => {
      draft.status = btn.dataset.s;
      root.querySelectorAll('#f-status button').forEach(x => x.classList.toggle('active', x === btn));
      const pv = document.getElementById('f-prevwrap');
      if (pv) pv.style.display = draft.status === 'read' ? '' : 'none';
      if (draft.status === 'read' && !draft.dateFinished && !draft.previouslyRead) draft.dateFinished = new Date().toISOString();
      if (draft.status !== 'read') draft.dateFinished = null;
      if (draft.status === 'read' && draft.pageCount && !draft.previouslyRead) {
        draft.progress = draft.pageCount; // Save logs the completion delta
        const pi = document.getElementById('f-progress');
        if (pi) pi.value = draft.progress;
      }
      renderProgressSection();
      paintPrimary(); // v123: primary action follows the shelf
    }));

  document.getElementById('f-prevread').addEventListener('change', e => {
    draft.previouslyRead = e.target.checked;
    const pi = document.getElementById('f-progress');
    if (draft.previouslyRead) {
      if (draft.dateFinished && !b.dateFinished) draft.dateFinished = null; // undo today's stamp
      draft.progress = startProgress; // undo the auto completion bump
      if (pi) pi.value = draft.progress;
    } else if (draft.status === 'read' && !draft.dateFinished) {
      draft.dateFinished = new Date().toISOString();
      if (draft.pageCount) {
        draft.progress = draft.pageCount;
        if (pi) pi.value = draft.progress;
      }
    }
  });

  root.querySelectorAll('#f-owned button').forEach(btn =>
    btn.addEventListener('click', () => {
      draft.owned = btn.dataset.o === '1';
      root.querySelectorAll('#f-owned button').forEach(x => x.classList.toggle('active', x === btn));
      const bw = document.getElementById('m-buywrap');
      if (bw) bw.style.display = draft.owned ? 'none' : '';
    }));

  const wirePicker = (sel, key) => {
    root.querySelectorAll(sel + ' button').forEach(btn =>
      btn.addEventListener('click', () => {
        const v = Number(btn.dataset.v);
        draft[key] = (draft[key] === v) ? 0 : v; // tap again to clear
        root.querySelectorAll(sel + ' button').forEach((x, i) =>
          x.classList.toggle('on', i < draft[key]));
        if (key === 'myRating') { // v131: live word label in the header
          const w = document.getElementById('f-myrating-word');
          if (w) w.textContent = RATING_WORDS[draft[key] || 0];
        }
      }));
  };
  wirePicker('#f-myrating', 'myRating');
  wireAxRows();

  const escClose = e => { if (e.key === 'Escape') close(); }; // v129: escape closes
  const close = () => {
    document.removeEventListener('keydown', escClose);
    root.innerHTML = ''; editingId = null; editingDraft = null; refreshProgressSection = null;
  };
  document.addEventListener('keydown', escClose);
  root.querySelectorAll('[data-sim]').forEach(el => // v110: jump to a similar book
    el.addEventListener('click', () => openDetail(el.dataset.sim)));
  document.getElementById('m-x').addEventListener('click', close);
  document.getElementById('m-changecover').addEventListener('click', () => openCoverPicker(id));
  document.getElementById('m-back').addEventListener('click', e => { if (e.target.id === 'm-back') close(); });
  // v130: description read-more toggle — hidden when the text fits unclamped.
  const dWrap = document.getElementById('m-desc');
  if (dWrap) {
    const dP = dWrap.querySelector('p');
    const dT = document.getElementById('m-desc-toggle');
    if (dP.scrollHeight <= dP.clientHeight + 2) dT.style.display = 'none';
    dT.addEventListener('click', () => {
      const open = dWrap.classList.toggle('open');
      dT.textContent = open ? 'Show less' : 'Read more';
    });
  }
  root.querySelectorAll('[data-author]').forEach(el =>
    el.addEventListener('click', () => openCollection('author', el.dataset.author, id)));
  root.querySelectorAll('[data-series]').forEach(el =>
    el.addEventListener('click', () => openCollection('series', el.dataset.series, id)));
  renderProgressSection();

  // v81: trope suggestions — tappable chips under the tropes input. Tap to add
  // to her list; suggestions never overwrite what she typed. Refreshes when the
  // Settings source changed since they were computed.
  const renderTropeSuggestions = () => {
    const box = document.getElementById('f-tropesugg');
    if (!box) return;
    const inp = document.getElementById('f-tropes');
    const mine = new Set((inp ? inp.value : '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
    const sugg = (b.tropesAuto || []).filter(t => !mine.has(String(t).toLowerCase()));
    box.innerHTML = sugg.length
      ? '<span class="note">Suggested — tap to add:</span> ' + sugg.map(t =>
        '<button class="chip sugg" data-tsugg="' + esc(t) + '">+ ' + esc(t) + '</button>').join('')
      : '';
    box.querySelectorAll('[data-tsugg]').forEach(btn => btn.addEventListener('click', () => {
      const cur = inp.value.split(',').map(t => t.trim()).filter(Boolean);
      if (!cur.map(t => t.toLowerCase()).includes(btn.dataset.tsugg.toLowerCase())) {
        cur.push(btn.dataset.tsugg);
        inp.value = cur.join(', ');
      }
      renderTropeSuggestions();
    }));
  };
  if ((b.tropeSrc || '') !== tropeSourceKey()) {
    refreshTropeSuggestions(b).then(() => {
      try { delete b._hcTagsFetched; } catch (e) {}
      saveLibrary();
      renderTropeSuggestions();
    });
  }
  renderTropeSuggestions();

  // v75: quotes save immediately (like the progress steppers), independent of
  // the draft — Save syncs draft.quotes from the book so they aren't clobbered.
  const renderQuotesSection = () => {
    const el = document.getElementById('m-quotes');
    if (!el) return;
    const qs = b.quotes || [];
    el.innerHTML = qs.map((qt, i) =>
      '<div class="quote-row"><span class="quote-mark">❝</span>' +
      '<div class="quote-body"><p>' + esc(qt.t) + '</p>' +
      (qt.p ? '<span class="quote-page">p. ' + qt.p + '</span>' : '') + '</div>' +
      '<button class="btn ghost sm" data-qdel="' + i + '" title="Delete quote">✕</button></div>'
    ).join('') +
    '<div id="m-qform" hidden><textarea id="m-qtext" class="text-input" rows="2" ' +
      'placeholder="Type the quote…"></textarea>' +
      '<div class="row-flex"><input id="m-qpage" class="text-input" type="number" min="0" ' +
      'inputmode="numeric" placeholder="Page (optional)">' +
      '<button class="btn" id="m-qsave">Save quote</button>' +
      '<button class="btn ghost" id="m-qcancel">Cancel</button></div></div>' +
    '<button class="btn ghost sm" id="m-qadd">＋ Add quote</button>';
    el.querySelector('#m-qadd').addEventListener('click', () => {
      el.querySelector('#m-qform').hidden = false;
      el.querySelector('#m-qadd').hidden = true;
      el.querySelector('#m-qtext').focus();
    });
    el.querySelector('#m-qcancel').addEventListener('click', renderQuotesSection);
    el.querySelector('#m-qsave').addEventListener('click', () => {
      const t = el.querySelector('#m-qtext').value.trim();
      if (!t) { toast('Type the quote first ✍️'); return; }
      const p = Math.max(0, Number(el.querySelector('#m-qpage').value) || 0) || null;
      if (!Array.isArray(b.quotes)) b.quotes = [];
      b.quotes.push({ t: t.slice(0, 2000), p: p, at: new Date().toISOString() });
      saveLibrary();
      toast('Quote saved ❝');
      renderQuotesSection();
    });
    el.querySelectorAll('[data-qdel]').forEach(btn => btn.addEventListener('click', () => {
      b.quotes.splice(Number(btn.dataset.qdel), 1);
      saveLibrary();
      renderQuotesSection();
    }));
  };
  renderQuotesSection();

  document.getElementById('f-fav').addEventListener('click', () => {
    draft.favorite = !draft.favorite;
    b.favorite = draft.favorite; // immediate — no need to hit Save
    saveLibrary();
    const fb = document.getElementById('f-fav');
    fb.classList.toggle('on', draft.favorite); // v84: line-art heart fills via CSS
    render(); // refresh the shelf behind the modal
    track(draft.favorite ? 'book_favorited' : 'book_unfavorited');
    toast(draft.favorite ? 'Pinned to favorites ❤️' : 'Removed from favorites 🤍');
  });

  const lk = document.getElementById('pc-lookup');
  if (lk) lk.addEventListener('click', async () => {
    lk.disabled = true; lk.textContent = '…';
    const n = await fetchPageCountByISBN(b.isbn);
    lk.disabled = false; lk.innerHTML = icon('search');
    if (n) {
      draft.pageCount = n;
      document.getElementById('f-pagecount').value = n;
      renderProgressSection();
      toast('📄 Found: ' + n + ' pages');
    } else toast('No page count found for this ISBN');
  });

  const rmlog = document.getElementById('m-rmlog');
  if (rmlog) rmlog.addEventListener('click', () => {
    const tk = dayKey(new Date());
    const e = (b.log || []).find(x => x.d === tk);
    const n = e ? Math.max(0, e.to - e.from) : 0;
    if (!n) return;
    if (!confirm('Remove today’s log entry (' + n + ' pages) for “' + b.title + '”?')) return;
    b.log = (b.log || []).filter(x => x.d !== tk);
    draft.log = b.log;
    b.progress = draft.progress = e.from; // roll progress back to where the day started
    startProgress = e.from; // keep Save from re-logging the removed entry
    const pi = document.getElementById('f-progress');
    if (pi) pi.value = draft.progress;
    saveLibrary();
    rmlog.closest('.field').remove();
    renderProgressSection();
    toast('Today’s entry removed 🗑️');
  });

  document.getElementById('m-upnext').addEventListener('click', () => {
    if (upNext.includes(b.id)) { upNextRemove(b.id); toast('Removed from Up Next'); }
    else { upNextAdd(b.id); toast('Added to Up Next'); }
    document.getElementById('m-upnext').innerHTML =
      upNext.includes(b.id) ? '✓ In your Up Next queue — tap to remove' : icon('upnext') + ' Add to Up Next';
  });
  document.getElementById('m-share').addEventListener('click', () => shareBookCard(b.id));
  document.getElementById('m-save').addEventListener('click', () => {
    draft.tropes = document.getElementById('f-tropes').value.split(',')
      .map(t => t.trim().toLowerCase()).filter(Boolean);
    draft.notes = document.getElementById('f-notes').value;
    draft.releaseDate = document.getElementById('f-releasedate').value || '';
    draft.previouslyRead = document.getElementById('f-prevread').checked;
    const totalEl = document.getElementById('f-pagecount');
    draft.pageCount = Math.max(0, Number(totalEl.value) || 0) || null;
    const prog = document.getElementById('f-progress');
    const cap = draft.pageCount || Infinity;
    const enteredProg = Math.max(0, Number(prog.value) || 0);
    // v67: only a genuine change to the progress field logs pages — fixing the
    // total (which can clamp progress) no longer fabricates a reading session,
    // and previously-read books never log.
    if (!draft.previouslyRead && enteredProg !== startProgress) logPages(b, startProgress, enteredProg);
    draft.progress = Math.min(cap, enteredProg);
    if (!draft.title.trim()) draft.title = 'Untitled';
    draft.log = b.log;
    draft.quotes = b.quotes; // v75: quotes save immediately — don't clobber them
    const _aBefore = { // v118: snapshot for analytics diff (never book content)
      status: b.status, myRating: b.myRating || 0, title: b.title, notes: b.notes,
      releaseDate: b.releaseDate, tropes: (b.tropes || []).slice(),
      pageCount: b.pageCount, ratings: Object.assign({}, b.ratings || {}),
    };
    Object.assign(b, draft);
    // v74: starting (or finishing) a book takes it off the Up Next queue —
    // it's no longer "next" once she's reading it.
    if (['reading', 'read', 'dnf'].includes(draft.status)) upNextRemove(id);
    saveLibrary(); close(); render();
    trackBookSaveDiff(_aBefore, draft); // v118: status/rating/axis/edited events
    toast('Saved ✨');
  });

  document.getElementById('m-del').addEventListener('click', () => {
    if (!confirm('Remove "' + b.title + '" from your shelves?')) return;
    removeBook(id);
    close(); render();
    toast('Removed');
  });
}


/* ---------------- quotes browser (v75) ---------------- */
// Every saved quote across the library, newest first.
function allQuotes() {
  const out = [];
  library.forEach(b => (b.quotes || []).forEach(qt =>
    out.push({ book: b, q: qt })));
  out.sort((a, b) => {
    const ka = (a.q && a.q.at) || '', kb = (b.q && b.q.at) || '';
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  return out;
}
function quoteCardHTML(book, qt, feat) {
  return '<div class="q-card' + (feat ? ' feat' : '') + '" data-book="' + book.id + '">' +
    '<p class="q-text">❝' + esc(qt.t) + '❞</p>' +
    '<div class="q-meta">' +
    (book.cover ? '<img src="' + esc(book.cover) + '" alt="" loading="lazy">' : '') +
    '<span><b>' + esc(book.title) + '</b><span class="q-by">' +
    esc((book.authors || []).join(', ') || 'Unknown author') +
    (qt.p ? ' · p. ' + qt.p : '') + '</span></span></div></div>';
}
function renderQuotes() {
  const all = allQuotes();
  let html = '<button class="btn ghost" id="q-back">← Shelves</button>' +
    '<h2 class="section serif" style="font-size:26px;margin-top:10px">' + icon('quotes') + ' Quotes' +
    (all.length ? ' <span class="note-inline">· ' + all.length + '</span>' : '') + '</h2>';
  if (!all.length) {
    html += '<div class="empty"><div class="big">' + icon('quotes') + '</div><h2 class="serif">No quotes yet</h2>' +
      '<p>Open any book and tap <b>＋ Add quote</b><br>to start your collection.</p></div>';
  } else {
    html += '<button class="btn ghost" id="q-random">' + icon('dice') + ' Surprise me</button>' +
      '<div id="q-spot"></div><div class="q-list">' +
      all.map(e => quoteCardHTML(e.book, e.q, false)).join('') + '</div>';
  }
  setView(html);
  document.getElementById('q-back').addEventListener('click', () => go('library'));
  const rnd = document.getElementById('q-random');
  if (rnd) rnd.addEventListener('click', () => {
    const e = all[Math.floor(Math.random() * all.length)];
    const spot = document.getElementById('q-spot');
    spot.innerHTML = quoteCardHTML(e.book, e.q, true);
    spot.querySelector('.q-card').addEventListener('click', () => openDetail(e.book.id));
    if (spot.scrollIntoView) spot.scrollIntoView({ block: 'nearest' });
  });
  document.querySelectorAll('.q-list .q-card').forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.book)));
}
