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
    owned: 'tobuy', // discovered = wanted
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

/* ---- book preview modal (v219): read-only detail view for books that are
   NOT on her shelves — Discovery recos, New Releases, Coven recos, friend
   shelves, missing-by-author/series. Retires the v60 openExternalDetail
   sheet: every surface that showed an unowned book tappably now opens this.

   Design note: a dedicated renderer into the SAME #modal-root, reusing the
   sheet chrome, close paths, scroll lock and the v215 drag gesture — not a
   second modal system. renderDetailModal is deliberately untouched: the
   preview path cannot write to the library by construction (no draft, no
   saveLibrary/removeBook/share/upNext/logPages/quotes/notes calls), and the
   transient book's synthetic id never enters `library`. ---- */

// Normalize any external/discovered book shape into a transient preview book.
// kind: 'reco' | 'release' | 'coven-reco' | 'friend' | 'external'
function previewTransient(src, kind) {
  const s = src || {};
  const authors = Array.isArray(s.authors) ? s.authors.slice()
    : (s.author ? [s.author] : []);
  let series = null; // -> { name, position }
  if (s.series && typeof s.series === 'object') {
    series = { name: s.series.name || '', position: s.series.position };
  } else if (s.seriesName) {
    series = { name: s.seriesName, position: s.position };
  } else if (s.series) { // coven recos carry series as a plain string
    series = { name: s.series, position: s.seriesPos };
  }
  const isbns = (s.isbns || []).map(i => String(i).replace(/[^0-9X]/gi, '')).filter(Boolean);
  const isbn = s.isbn || isbns.find(i => i.length === 13) || isbns[0] || '';
  return {
    id: 'preview-' + uid(),
    preview: true,
    kind: kind || 'external',
    title: s.title || 'Untitled',
    authors: authors,
    cover: s.cover || '',
    description: s.description || '',
    pageCount: s.pageCount || s.pages || null,
    publishedDate: s.publishedDate || '',
    releaseDate: s.releaseDate || '',
    isbn: isbn,
    series: series,
    tropes: (s.tropes || []).slice(),
    categories: (s.categories || s.genres || []).slice(),
    publicRating: s.publicRating || null,
    ratingsCount: s.ratingsCount || 0,
    hcId: s.hcId || null,
    // normalized external shape for the Wishlist path (addExternalBook)
    _ext: {
      title: s.title || 'Untitled',
      author: authors[0] || s.author || '',
      cover: s.cover || '',
      isbn: isbn,
      position: series ? series.position : (s.position != null ? s.position : null),
      seriesName: series ? series.name : null
    }
  };
}

// Which sections the preview renders for a transient — pure, unit-tested.
// The ONLY writers are the +TBR / Wishlist buttons, via opts callbacks.
function previewSections(t) {
  return {
    description: !!t.description,
    tropes: (t.tropes || []).length > 0,
    genres: bookGenres(t).length > 0,
    series: !!(t.series && t.series.name),
    actions: true
  };
}

let previewOpenId = null; // guards the async enrichment against a closed modal

// opts: { why: [html chips], contextNote, source, onAddTBR: () => book|null }
function openPreviewModal(t, opts) {
  opts = opts || {};
  const root = document.getElementById('modal-root');
  if (!root || !t) return;
  previewOpenId = t.id;
  lockBodyScroll(); // v215: the library behind must not scroll while open
  const why = (opts.why || []).filter(Boolean);
  const seriesLine = t.series && t.series.name
    ? '<span>' + icon('sparkles') + ' ' + esc(t.series.name) +
      (t.series.position != null && t.series.position !== ''
        ? ' #' + esc(String(t.series.position)) : '') + '</span>' : '';
  const metaHTML = () =>
    (t.pageCount ? '<span>' + icon('reading') + ' ' + t.pageCount + ' pages</span>' : '') +
    (t.publishedDate ? '<span>' + icon('calendar') + ' ' + esc(String(t.publishedDate).slice(0, 4)) + '</span>' : '') +
    (t.isbn ? '<span>' + icon('barcode') + ' ISBN ' + esc(t.isbn) + '</span>' : '') +
    seriesLine;
  const descId = 'p-desc';
  const descHTML = () =>
    (t.description
      ? '<div class="m-desc" id="' + descId + '"><p>' +
        esc(String(t.description).replace(/<[^>]*>/g, '')) + '</p>' +
        '<button class="taplink" id="' + descId + '-toggle">Read more</button></div>'
      : '');
  const tagSecHTML = () => {
    let h = '';
    if ((t.tropes || []).length) {
      h += '<div class="field"><label>' + icon('sparkles') + ' Tropes</label><div class="chips wrap">' +
        t.tropes.map(x => '<span class="chip">' + esc(x) + '</span>').join('') + '</div></div>';
    }
    // v237: bookGenres strips format tags ("Audiobook" is not a genre); the
    // wrap class lets the row flow onto multiple lines on desktop, where the
    // hidden-scrollbar horizontal scroll is unreachable.
    const pGenres = bookGenres(t);
    if (pGenres.length) {
      h += '<div class="field"><label>' + icon('doc') + ' Genres</label><div class="chips wrap">' +
        pGenres.map(x => '<span class="chip">' + esc(x) + '</span>').join('') + '</div></div>';
    }
    return h;
  };
  const wireDescToggle = () => {
    const w = document.getElementById(descId);
    if (!w) return;
    const p = w.querySelector('p'), tg = document.getElementById(descId + '-toggle');
    if (!p || !tg) return;
    if (p.scrollHeight <= p.clientHeight + 2) tg.style.display = 'none';
    tg.addEventListener('click', () => {
      const open = w.classList.toggle('open');
      tg.textContent = open ? 'Show less' : 'Read more';
    });
  };

  root.innerHTML =
    '<div class="modal-backdrop" id="p-back"><div class="modal detail-v174" role="dialog" aria-modal="true" aria-label="Book preview">' +
    '<div class="sheet-grabber" aria-hidden="true"></div>' + // v215: drag-to-dismiss affordance (touch)
    '<button class="d-back" id="p-x" aria-label="Close">←</button>' +
    '<div class="d-hero">' +
    '<div class="d-cover">' + coverHTML(t, 'd-cov') + '</div>' +
    '<div class="d-hero-text">' +
    '<h2 class="serif">' + esc(t.title) + '</h2>' +
    '<p class="author">' + (t.authors.length ? esc(displayAuthors(t.authors)) : 'Unknown author') + '</p>' +
    (t.publicRating ? '<div class="pub-rating">' + stars(t.publicRating) +
      ' <span class="note-inline">· ' + t.ratingsCount + ' ratings</span></div>' : '') +
    '<div class="d-meta" id="p-meta">' + metaHTML() + '</div>' +
    (releaseCountdown(t.releaseDate) ? '<div class="pub-rating release-line">' + icon('calendar') +
      ' Releases ' + esc(fmtDate(t.releaseDate)) + ' · ' + releaseCountdown(t.releaseDate) + '</div>' : '') +
    (opts.contextNote ? '<p class="note">' + esc(opts.contextNote) + '</p>' : '') +
    '</div>' +
    '<div class="d-primary-row"><button class="btn primary d-primary" id="p-tbr">＋ TBR</button>' +
    '<button class="btn ghost" id="p-wish">' + icon('gift') + ' Wishlist</button></div>' +
    (why.length ? '<div class="why-chips">' + why.join('') + '</div>' : '') +
    '<div id="p-descread">' + descHTML() + '</div>' +
    '</div>' +
    '<div class="d-panel"><div id="p-tags">' + tagSecHTML() + '</div></div>' +
    '</div></div>';

  // v220: DOM-only teardown — the history entry is owned by overlayOpened.
  const closePreviewDom = () => {
    document.removeEventListener('keydown', escClose);
    unlockBodyScroll(); // v215: release the background scroll lock
    previewOpenId = null;
    root.innerHTML = '';
  };
  const ovToken = overlayOpened('modal-root', closePreviewDom); // v220: back-gesture closes
  const closePreview = () => { overlayClosed(ovToken); closePreviewDom(); }; // v220: programmatic close consumes the entry
  const escClose = e => { if (e.key === 'Escape' && overlayIsTop(ovToken)) closePreview(); }; // v129: escape closes, v220: topmost only
  document.addEventListener('keydown', escClose);
  document.getElementById('p-x').addEventListener('click', closePreview);
  document.getElementById('p-back').addEventListener('click', e => { if (e.target.id === 'p-back') closePreview(); });
  wireSheetDrag(root.querySelector('#p-back .modal'), closePreview); // v215: drag-to-dismiss

  // +TBR: add via the surface's existing add path, then hand off to the REAL
  // library modal for the newly added book.
  document.getElementById('p-tbr').addEventListener('click', () => {
    const nb = opts.onAddTBR ? opts.onAddTBR() : null;
    if (nb && nb.id) {
      const id = nb.id;
      track('preview_tbr', { source: opts.source || 'preview' });
      closePreviewDom(); // v220: DOM teardown first (the unlock+relock around openDetail is synchronous)
      overlayReplace(ovToken, () => openDetail(id)); // v220: the real modal adopts the history entry
    }
  });
  // Wishlist: the row buttons' addExternalBook path; the button becomes a
  // confirmation, like the retired v60 sheet.
  document.getElementById('p-wish').addEventListener('click', () => {
    addExternalBook(t._ext);
    const btn = document.getElementById('p-wish');
    if (btn) btn.outerHTML = '<p class="note" style="text-align:center">' + icon('gift') + ' In your wishlist</p>';
    track('preview_wishlist', { source: opts.source || 'preview' });
    toast('Added to wishlist 💝');
  });

  // Sparse rows (missing-by-author/series) carry no description — enrich
  // exactly like the v60 sheet did: ISBN lookup, then title+author search.
  if (!t.description && t.isbn) {
    const myId = t.id;
    (async () => {
      let full = null;
      try { full = await lookupISBN(t.isbn); } catch (e) { /* show what we have */ }
      if (!full) {
        try {
          const res = await searchBooks((t.title || '') + ' ' + (t.authors[0] || ''));
          const nt = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
          full = ((res || []).find(r => nt(r.title) === nt(t.title)) || (res || [])[0]) || null;
        } catch (e) { /* show what we have */ }
      }
      if (!full || previewOpenId !== myId || !document.getElementById('p-back')) return;
      if (full.description) t.description = full.description;
      if (full.pageCount) t.pageCount = full.pageCount;
      if (full.publishedDate) t.publishedDate = full.publishedDate;
      if (full.categories && full.categories.length) t.categories = full.categories.slice();
      if (full.tropes && full.tropes.length) t.tropes = full.tropes.slice();
      if (full.publicRating) { t.publicRating = full.publicRating; t.ratingsCount = full.ratingsCount || 0; }
      document.getElementById('p-meta').innerHTML = metaHTML();
      document.getElementById('p-descread').innerHTML = descHTML();
      document.getElementById('p-tags').innerHTML = tagSecHTML();
      wireDescToggle();
    })();
  } else {
    wireDescToggle();
  }
  track('book_preview_opened', { source: opts.source || 'preview', kind: t.kind });
}

// Fill a "more books" box: the overlay's #c-more, or the modal's inline
// #m-series-more (bare mode: compact heading, no overlay chrome).
async function fillMoreSection(kind, name, fromId, box, bare) {
  if (!box) return;
  // The icon is trusted markup — only the text (which carries the library's
  // own author/series name) goes through esc().
  const headingHTML = bare
    ? '<p class="series-more-h">Every book in this series</p>'
    : '<h3 class="serif c-more-h">' + icon('search') + ' ' +
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
        '<p class="note">' + (bare ? 'No other books in this series found.' : 'Nothing missing — nice shelf!') + '</p>';
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
    // v219: tapping the row itself opens the read-only preview modal
    box.querySelectorAll('[data-ext]').forEach(row =>
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-extadd]')) return;
        const x = rows[Number(row.dataset.ext)];
        if (!x) return;
        openPreviewModal(previewTransient(x, 'external'), {
          source: kind === 'author' ? 'author-missing' : 'series-missing',
          onAddTBR: () => addExternalBook(x)
        });
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

/* ---- v133: series books inline in Series & Discovery — the series name is
   display-only now; the books themselves are listed right away, no tap-through. ---- */
// v239: manual series tagging — name (autocompletes the library's existing
// series) + position. Committed via the sticky Save bar; a hand-set series
// is never overwritten by enrichment (seriesManual flag, see 070-hardcover).
function seriesEditHTML(b, id) {
  const names = [...new Set(library
    .filter(x => x.id !== id && x.series && x.series.name)
    .map(x => String(x.series.name).trim()).filter(Boolean))]
    .sort((a, c) => a.localeCompare(c));
  const cur = b.series || {};
  return '<div class="series-edit">' +
    '<input id="f-series" class="text-input" list="f-series-list" autocomplete="off"' +
    ' placeholder="Series name — e.g. Delta-V" value="' + esc(cur.name || '') + '">' +
    '<datalist id="f-series-list">' + names.map(n => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
    '<input id="f-series-pos" class="text-input" inputmode="decimal" placeholder="#"' +
    ' aria-label="Position in series" value="' + esc(cur.position == null ? '' : String(cur.position)) + '">' +
    '</div>';
}
function seriesInlineHTML(b, id) {
  if (!(b.series && b.series.name)) return '';
  const key = String(b.series.name).trim().toLowerCase();
  const others = library.filter(x => x.id !== id && x.series && x.series.name &&
    String(x.series.name).trim().toLowerCase() === key);
  others.sort((x, y) => {
    const px = parseFloat(x.series && x.series.position), py = parseFloat(y.series && y.series.position);
    return (isNaN(px) ? 1e9 : px) - (isNaN(py) ? 1e9 : py);
  });
  const pos = (b.series.position != null && b.series.position !== '')
    ? ' · Book ' + esc(String(b.series.position)) : '';
  return '<div class="field" id="m-series"><label>' + icon('series') + ' In this series' +
    '<span class="note-inline"> · ' + esc(b.series.name) + pos + '</span></label>' +
    (others.length
      ? '<div class="collection-list">' + others.map(collectionRowHTML).join('') + '</div>'
      : '<p class="note">The only one on your shelves so far.</p>') +
    '<div id="m-series-more"><p class="note">Looking for the full series…</p></div></div>';
}
function wireSeriesRows(scope) {
  scope.querySelectorAll('#m-series [data-book]').forEach(el =>
    el.addEventListener('click', () => openDetail(el.dataset.book)));
}
// v133: re-render the inline series block when background Hardcover
// enrichment lands (the block has no inputs, so this never clobbers typing).
function refreshSeriesInline(book) {
  const wrap = document.getElementById('m-series-wrap');
  if (!wrap || !(book.series && book.series.name) || wrap.querySelector('#m-series')) return;
  wrap.innerHTML = seriesInlineHTML(book, book.id);
  wireSeriesRows(wrap);
  const sBox = wrap.querySelector('#m-series-more');
  if (sBox) fillMoreSection('series', book.series.name, book.id, sBox, true);
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
  const closeDom = () => ov.remove();
  const ovToken = overlayOpened('collection', closeDom); // v220: back-gesture closes
  const close = () => { overlayClosed(ovToken); closeDom(); }; // v220: programmatic close consumes the entry
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(ov.querySelector('#c-back .modal'), close); // v227: swipe-down-to-close
  ov.querySelector('#c-back').addEventListener('click', e => { if (e.target.id === 'c-back') close(); });
  ov.querySelector('#c-x').addEventListener('click', close);
  ov.querySelectorAll('[data-book]').forEach(el =>
    el.addEventListener('click', () => {
      const r = el.getBoundingClientRect(); // capture before close() detaches it
      const id = el.dataset.book;
      closeDom(); // v220: DOM teardown; the history entry transfers below
      overlayReplace(ovToken, () => openDetail(id, { fromRect: r })); // v220
    }));
  fillMoreSection(kind, name, fromId, ov.querySelector('#c-more'));
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
/* ---- v215: bottom-sheet drag-to-dismiss (touch only) + background scroll lock.
   The sheet follows the finger only when its scrollable content is at the
   very top (scrollTop <= 0) — otherwise the gesture is a normal content
   scroll. Desktop keeps the close button; no mouse-drag. Gesture feel needs
   on-phone QA; the decision math below is unit-tested. ---- */
const SHEET_DISMISS_PX = 120; // drag distance that dismisses the sheet
const SHEET_FLICK_V = 0.55;   // px/ms downward velocity that dismisses (a flick)
// Pure decision logic — testable in node.
function shouldDismissDrag(dy, v, scrollTop) {
  if (dy <= 0 || scrollTop > 0) return false;
  return dy >= SHEET_DISMISS_PX || v >= SHEET_FLICK_V;
}
// Idempotent: safe to call on every re-render (e.g. jumping to a similar
// book re-renders without closing first); one unlock releases the lock.
let bodyScrollLocked = false, bodyScrollPrev = '';
function lockBodyScroll() {
  if (bodyScrollLocked || typeof document === 'undefined') return;
  bodyScrollLocked = true;
  bodyScrollPrev = document.body.style.overflow || '';
  document.body.style.overflow = 'hidden';
}
function unlockBodyScroll() {
  if (!bodyScrollLocked || typeof document === 'undefined') return;
  bodyScrollLocked = false;
  document.body.style.overflow = bodyScrollPrev;
}
function wireSheetDrag(sheet, onDismiss) {
  if (!sheet || typeof window === 'undefined' || !('ontouchstart' in window)) return;
  let y0 = null, t0 = 0, dragging = false, dy = 0;
  const cancel = () => {
    y0 = null; dragging = false; dy = 0;
    sheet.style.transition = ''; sheet.style.transform = '';
  };
  sheet.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { y0 = null; return; }
    y0 = e.touches[0].clientY; t0 = e.timeStamp; dragging = false; dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (y0 == null || e.touches.length !== 1) { if (e.touches.length !== 1) cancel(); return; }
    const d = e.touches[0].clientY - y0;
    if (!dragging) {
      if (d < 10 || sheet.scrollTop > 0) return; // not a top-of-sheet downward swipe
      dragging = true;
      // Re-anchor: the sheet starts following from this finger position so it
      // can't jump if the gesture reached the top mid-swipe.
      y0 = e.touches[0].clientY; t0 = e.timeStamp; dy = 0;
      sheet.style.transition = 'none';
      return;
    }
    if (d <= 0) { // finger came back up — hand the gesture back, re-anchor
      dragging = false; dy = 0;
      sheet.style.transition = ''; sheet.style.transform = '';
      y0 = e.touches[0].clientY; t0 = e.timeStamp;
      return;
    }
    dy = d;
    // passive:false — stop scroll chaining so the library behind can't move.
    if (e.cancelable) e.preventDefault();
    sheet.style.transform = 'translateY(' + d + 'px)';
  }, { passive: false });
  sheet.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dt = Math.max(1, (e.timeStamp || 0) - t0);
    const dist = dy, v = dist / dt, wasDragging = dragging;
    y0 = null; dragging = false; dy = 0;
    if (!wasDragging) return;
    if (shouldDismissDrag(dist, v, sheet.scrollTop)) {
      sheet.style.transition = 'transform .18s ease-in';
      sheet.style.transform = 'translateY(110%)';
      setTimeout(onDismiss, 190);
    } else { // spring back
      sheet.style.transition = ''; sheet.style.transform = '';
    }
  }, { passive: true });
  sheet.addEventListener('touchcancel', cancel, { passive: true });
}
function renderDetailModal(b, viaBook) {
  const id = b.id;
  editingId = id;
  lockBodyScroll(); // v215: the library behind must not scroll while open
  const root = document.getElementById('modal-root');

  // v182: mockup alignment — shelf/ownership become tappable rows that expand
  // to choose. Labels + icons for the row display and the option lists.
  const STATUS_META = {
    tbr:     { label: 'TBR',               ic: 'tbr' },
    reading: { label: 'Currently Reading', ic: 'reading' },
    read:    { label: 'Read',              ic: 'read' },
    dnf:     { label: 'DNF',               ic: 'dnf' },
  };
  const OWNED_META = {
    owned:    { label: 'Owned',    ic: 'owned' },
    tobuy:    { label: 'To buy',   ic: 'tobuy' },
    borrowed: { label: 'Borrowed', ic: 'borrowed' },
  };
  // v182: the description appears twice per the mockup — in the hero
  // (desktop only) and under "About this book" on the Details tab.
  const descHTML = (idpfx, cls) =>
    (b.description
      ? '<div class="m-desc' + (cls ? ' ' + cls : '') + '" id="' + idpfx + '"><p>' +
        esc(String(b.description).replace(/<[^>]*>/g, '')) + '</p>' +
        '<button class="taplink" id="' + idpfx + '-toggle">Read more</button></div>'
      : '');

  const hearts = [1, 2, 3, 4, 5].map(n =>
    '<button data-v="' + n + '" class="' + (b.myRating >= n ? 'on' : '') + '">' + icon('heart') + '</button>').join('');

  // draft copy the controls edit until Save
  const draft = Object.assign({}, b, {
    tropes: (b.tropes || []).slice(),
    ratings: Object.assign({}, b.ratings),
    axes: (b.axes || []).slice(),
    // v239: deep-copy the series object so typing in the series editor
    // doesn't mutate the saved book before Save.
    series: b.series ? { name: b.series.name || '', position: b.series.position } : null
  });
  if (draft.owned === true) draft.owned = 'owned'; // v148: tolerate legacy booleans
  else if (draft.owned === false) draft.owned = 'tobuy';
  // v182: option buttons for the tappable shelf/ownership rows (needs the draft).
  const statusOpts = Object.keys(STATUS_META).map(s =>
    '<button data-s="' + s + '" class="' + (draft.status === s ? 'active' : '') + '">' +
    icon(STATUS_META[s].ic) + ' ' + STATUS_META[s].label + '</button>').join('');
  const ownedOpts = Object.keys(OWNED_META).map(o =>
    '<button data-o="' + o + '" class="' + (draft.owned === o ? 'active' : '') + '">' +
    icon(OWNED_META[o].ic) + ' ' + OWNED_META[o].label + '</button>').join('');
  if (!draft.axes.length) draft.axes = autoDetectAxes(draft);
  editingDraft = draft;
  // v224 (UX-11): rating/axis taps commit live now, so snapshot the rating
  // state at open — the Save-time diff still reports what actually changed.
  const ratingBefore = { myRating: b.myRating || 0, ratings: Object.assign({}, b.ratings || {}) };

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

  // v174: recent reading sessions for the Details tab (log data already exists).
  const logListHTML = (() => {
    const log = (b.log || []).slice()
      .sort((x, y) => String(y.d || '').localeCompare(String(x.d || ''))).slice(0, 5);
    if (!log.length) return '<p class="note">No sessions yet — the progress stepper logs them automatically.</p>';
    return '<ul class="d-log">' + log.map(e => {
      const n = Math.max(0, (e.to || 0) - (e.from || 0));
      return '<li><span>' + esc(fmtDate(e.d)) + '</span><b>' + n + ' page' + (n === 1 ? '' : 's') + '</b></li>';
    }).join('') + '</ul>';
  })();
  const rmLogHTML = (() => { // v68: optional "remove today's entry" button (Settings → Reading log)
    if (!logRemoveEnabled()) return '';
    const tk = dayKey(new Date());
    const n = pagesOnDay(b, tk);
    if (!n) return '';
    return '<button class="btn ghost danger sm" id="m-rmlog" style="margin-top:8px">' + icon('trash') + ' Remove today’s entry (' + n + ' pages)</button>';
  })();

  // v182: mockup reading-log card header — Started / Last read.
  const logSummaryHTML = (() => {
    const ds = (b.log || []).map(x => x.d).filter(Boolean).sort();
    if (!ds.length) return '';
    return '<div class="log-summary"><span>Started <b>' + esc(fmtDate(ds[0])) + '</b></span>' +
      '<span>Last read <b>' + esc(fmtDate(ds[ds.length - 1])) + '</b></span></div>';
  })();

  root.innerHTML =
    '<div class="modal-backdrop' + (viaBook ? ' from-book' : '') + '" id="m-back"><div class="modal detail-v174" role="dialog" aria-modal="true" aria-label="Book details">' +
    '<div class="sheet-grabber" aria-hidden="true"></div>' + // v215: drag-to-dismiss affordance (touch)
    '<button class="d-back" id="m-x" aria-label="Close">←</button>' +
    // v182: mockup top-right cluster — favorite + overflow menu (moved out of
    // the bottom bar). The menu is a floating card now.
    '<div class="d-topactions">' +
    '<button class="fav-btn' + (draft.favorite ? ' on' : '') + '" id="f-fav" aria-label="Toggle favorite">' + icon('heart') + '</button>' +
    '<div class="more-wrap"><button class="btn ghost" id="m-more" aria-label="More actions" aria-haspopup="true">' + icon('dots') + '</button>' +
    '<div class="more-menu" id="m-moremenu" hidden>' +
    '<button class="more-item" id="m-share">' + icon('share') + ' <span>Share</span></button>' +
    '<button class="more-item" id="m-favmenu">' + icon('heart') + ' <span>Add to Favorites</span></button>' +
    '<button class="more-item" id="m-upnext">' + icon('upnext') + ' <span>Add to Up Next</span></button>' +
    '<button class="more-item" id="m-covermenu">' + icon('camera') + ' <span>Change Cover</span></button>' +
    '<div class="more-sep"></div>' +
    '<button class="more-item danger" id="m-del">' + icon('trash') + ' <span>Remove from Library</span></button>' +
    '</div></div></div>' +
    // v182: mockup hero — desktop is cover left / info right / primary row /
    // description; mobile stacks cover, title, author, rating, meta, action.
    '<div class="d-hero">' +
    '<div class="d-cover">' + coverHTML(b, 'd-cov') +
    '<button class="btn ghost sm" id="m-changecover">' + icon('camera') + ' Change Cover</button></div>' +
    '<div class="d-hero-text">' +
    '<h2 class="serif">' + esc(b.title) + '</h2>' +
    '<p class="author">' + ((b.authors && b.authors.length)
      ? b.authors.map(a => '<button class="taplink" data-author="' + esc(a) + '">' + esc(displayAuthorName(a)) + '</button>').join(', ')
      : 'Unknown author') + '</p>' +
    (b.publicRating ? '<div class="pub-rating">' + stars(b.publicRating) + ' <span class="note-inline">· ' + b.ratingsCount + ' ratings</span></div>' : '') +
    '<div class="d-meta">' +
    (b.pageCount ? '<span id="m-pagespan">' + icon('reading') + ' ' + b.pageCount + ' pages</span>' : '') +
    (b.publishedDate ? '<span>' + icon('calendar') + ' ' + esc(b.publishedDate.slice(0, 4)) + '</span>' : '') +
    // v210: the ISBN row opens the edition picker (or sets one for manual adds).
    '<button class="taplink" id="m-edition" title="Choose edition">' + icon('barcode') +
    (b.isbn ? ' ISBN ' + esc(b.isbn) : ' Set edition') + '</button>' +
    '</div>' +
    (releaseCountdown(b.releaseDate) ? '<div class="pub-rating release-line">' + icon('calendar') + ' Releases ' + esc(fmtDate(b.releaseDate)) + ' · ' + releaseCountdown(b.releaseDate) + '</div>' : '') +
    '</div>' +
    '<div class="d-primary-row"><button class="btn primary d-primary" id="m-primary"></button>' +
    '<button class="fav-btn d-fav2' + (draft.favorite ? ' on' : '') + '" id="f-fav2" aria-label="Toggle favorite">' + icon('heart') + '</button>' +
    '<button class="d-fav2" id="m-share2" aria-label="Share this book">' + icon('share') + '</button></div>' +
    descHTML('m-desc-hero', 'd-hero-desc') +
    '</div>' +
    // v174: tabbed detail view — Details | Tropes | Notes (replaces the v124
    // collapsible sections; every control keeps its id). v182: mockup tab icons.
    '<div class="d-tabs" role="tablist">' +
    '<button class="d-tab active" data-dtab="details" role="tab" aria-selected="true">' + icon('doc') + 'Details</button>' +
    '<button class="d-tab" data-dtab="tropes" role="tab" aria-selected="false">' + icon('sparkles') + 'Tropes</button>' +
    '<button class="d-tab" data-dtab="notes" role="tab" aria-selected="false">' + icon('clipboard') + 'Notes</button></div>' +

    '<div class="d-panel" id="dtab-details" role="tabpanel">' +
    // v182: mockup "About this book" section (the hero carries its own copy on desktop).
    (b.description ? '<div class="field"><label>About this book</label>' + descHTML('m-desc') + '</div>' : '') +
    // v131: your rating — hearts + word label, now on the Details tab.
    '<div class="field"><label>Your rating</label>' +
    '<div class="hrate-row"><div class="picker" id="f-myrating">' + hearts + '</div>' +
    '<span class="rate-word' + (b.myRating ? '' : ' plain') + '" id="f-myrating-word">' +
    (b.myRating ? RATING_WORDS[b.myRating] : 'Unrated') + '</span></div></div>' +
    '<div id="m-progress"></div>' +

    // v182: mockup tappable rows — tap to expand, pick, collapse.
    '<div class="field"><label>Shelf / Status</label>' +
    '<div class="mselect" id="f-status">' +
    '<button class="mrow" data-mrow="status"><span class="mrow-ic" id="f-status-ic">' + icon((STATUS_META[draft.status] || STATUS_META.tbr).ic) + '</span>' +
    '<span class="mrow-val" id="f-status-val">' + (STATUS_META[draft.status] || STATUS_META.tbr).label + '</span><span class="mrow-chev">›</span></button>' +
    '<div class="mrow-opts" hidden>' + statusOpts + '</div></div>' +
    '<label class="checkline" id="f-prevwrap" style="' + (draft.status === 'read' ? '' : 'display:none') + '">' +
    '<input type="checkbox" id="f-prevread"' + (draft.previouslyRead ? ' checked' : '') + '> ' + icon('history') + ' Previously read' +
    '<span class="chk-hint">read before tracking — no date stamp, no log</span></label></div>' +

    '<div class="field"><label>Ownership</label>' +
    '<div class="mselect" id="f-owned">' +
    '<button class="mrow" data-mrow="owned"><span class="mrow-ic" id="f-owned-ic">' + icon((OWNED_META[draft.owned] || OWNED_META.tobuy).ic) + '</span>' +
    '<span class="mrow-val" id="f-owned-val">' + (OWNED_META[draft.owned] || OWNED_META.tobuy).label + '</span><span class="mrow-chev">›</span></button>' +
    '<div class="mrow-opts" hidden>' + ownedOpts + '</div></div></div>' +
    '<div class="field" id="m-buywrap" style="display:' + (draft.owned === 'owned' ? 'none' : '') + '">' +
    '<label>Where to buy <span class="note-inline">· ' + esc(STORE_REGIONS[detectStoreRegion()].label) + '</span></label>' +
    '<div class="buy-row">' + storeLinks(draft).map(l =>
      '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(l.url) + '">' + esc(l.name) + ' ' + icon('external') + '</a>').join('') +
    '</div></div>' +

    '<div class="field"><label>Mood</label>' +
    '<div id="f-axrows">' + draft.axes.map(axRowHTML).join('') + '</div>' +
    '<div class="chips" id="f-axadd">' + axAddHTML() + '</div></div>' +

    '<div class="field"><label>' + icon('history') + ' Reading Log</label>' +
    logSummaryHTML +
    '<div id="m-loglist">' + logListHTML + '</div>' + rmLogHTML + '</div>' +

    '<div class="field"><label>' + icon('sparkles') + ' Series & Discovery</label>' +
    '<div id="m-hc">' + hcDetailHTML(b) + '</div>' +
    seriesEditHTML(b, id) +
    '<div id="m-series-wrap">' + seriesInlineHTML(b, id) + '</div>' +
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
    })() + '</div></div>' +

    '<details class="m-more-details"><summary><span>More details</span></summary>' +
    '<div class="field secondary"><label>Total pages</label>' +
    '<div class="row-flex"><input id="f-pagecount" class="text-input" type="number" min="0" inputmode="numeric" placeholder="e.g. 384" value="' + (draft.pageCount || '') + '">' +
    (b.isbn ? '<button class="btn ghost" id="pc-lookup" title="Look up page count by ISBN">' + icon('search') + '</button>' : '') + '</div></div>' +
    '<div class="field secondary"><label>Current page</label>' +
    '<input id="f-progress" class="text-input" type="number" min="0" inputmode="numeric" value="' + (draft.progress || 0) + '"></div>' +
    '<div class="field secondary"><label>' + icon('calendar') + ' Release date</label>' +
    '<input id="f-releasedate" class="text-input" type="date" value="' + esc(b.releaseDate || '') + '">' +
    '<p class="note">For announced books — the Wishlist surfaces them under “Coming soon”.</p></div>' +
    '</details>' +
    '</div>' +

    '<div class="d-panel" id="dtab-tropes" role="tabpanel" hidden>' +
    // v182: mockup tropes — your tropes as chips (+ Add), suggested tropes
    // with View more, trope intelligence card. The hidden #f-tropes input
    // stays the save-flow source of truth; chips mirror it.
    '<div class="field"><label>Your tropes</label>' +
    '<div class="chips" id="f-tropechips"></div>' +
    '<button class="chip" id="f-tropeaddtoggle">+ Add</button>' +
    '<div class="tadd-row" id="f-tropeaddwrap" hidden>' +
    '<input id="f-tropeadd" class="text-input" placeholder="e.g. forced proximity" aria-label="Add a trope">' +
    '<button class="btn sm" id="f-tropeaddbtn">Add</button></div>' +
    '<input id="f-tropes" type="hidden" value="' + esc(b.tropes.join(', ')) + '"></div>' +
    '<div class="field"><label>Suggested tropes</label>' +
    '<div id="f-tropesugg" class="chips"></div>' +
    '<button class="taplink" id="m-tropemore" hidden>View more →</button></div>' +
    '<div class="field"><label>' + icon('sparkles') + ' Trope intelligence</label>' +
    '<div class="tcard"><div id="m-tropedb" class="chips"><p class="note">Checking…</p></div>' +
    '<button class="btn ghost sm" id="m-tropepropose" style="margin-top:4px">＋ Propose a trope</button></div></div>' +
    '</div>' +

    '<div class="d-panel" id="dtab-notes" role="tabpanel" hidden>' +
    '<div class="field"><label>My notes</label>' +
    '<textarea id="f-notes" class="text-input" placeholder="Thoughts, quotes, warnings for future self…">' + esc(b.notes) + '</textarea>' +
    '<div class="row-flex" style="margin-top:8px"><button class="btn sm" id="m-notesave">Save note</button></div></div>' +
    '<div class="field"><label>' + icon('quotes') + ' Saved quotes <span class="note-inline">· ' + (b.quotes || []).length + '</span></label>' +
    '<div id="m-quotes"></div></div>' +
    '</div>' +

    '<div class="modal-actions">' +
    '<span class="save-hint" id="m-savehint" hidden>' + icon('warn') + ' Swiping away discards unsaved changes</span>' +
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
    root.querySelectorAll('#f-status [data-s]').forEach(x => x.classList.toggle('active', x.dataset.s === s));
    paintShelfRow(); // v182: keep the tappable shelf row in sync
    paintPrimary();
    renderProgressSection();
  };
  const scrollToField = (fid) => {
    showDTab('details'); // v174: tabbed modal — the target lives on Details
    const el = document.getElementById(fid);
    if (!el) return;
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
  // v224 (UX-11): rating/axis taps commit live — a swipe-to-close can no
  // longer silently discard them. Text fields still go through Save.
  const syncRatingLive = () => {
    b.myRating = draft.myRating;
    b.axes = draft.axes.slice();
    b.ratings = Object.assign({}, draft.ratings);
    saveLibrary();
  };
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
        syncRatingLive(); // v224 (UX-11)
      }));
      const rm = row.querySelector('[data-axrm]');
      if (rm) rm.addEventListener('click', () => {
        draft.axes = draft.axes.filter(x => x !== k);
        delete draft.ratings[k];
        renderAxSection();
        syncRatingLive(); // v224 (UX-11)
      });
    });
    root.querySelectorAll('#f-axadd [data-axadd]').forEach(c => c.addEventListener('click', () => {
      draft.axes = draft.axes.concat(c.dataset.axadd);
      renderAxSection();
      syncRatingLive(); // v224 (UX-11)
    }));
  };

  // v182: mockup tappable rows — the row button expands the options; picking
  // one sets the draft value, repaints the row, and collapses.
  const paintShelfRow = () => {
    const m = STATUS_META[draft.status] || STATUS_META.tbr;
    const v = document.getElementById('f-status-val');
    const ic = document.getElementById('f-status-ic');
    if (v) v.textContent = m.label;
    if (ic) ic.innerHTML = icon(m.ic);
  };
  const paintOwnedRow = () => {
    const m = OWNED_META[draft.owned] || OWNED_META.tobuy;
    const v = document.getElementById('f-owned-val');
    const ic = document.getElementById('f-owned-ic');
    if (v) v.textContent = m.label;
    if (ic) ic.innerHTML = icon(m.ic);
  };
  root.querySelectorAll('[data-mrow]').forEach(t => t.addEventListener('click', (e) => {
    e.stopPropagation();
    const opts = t.parentElement.querySelector('.mrow-opts');
    const willOpen = opts.hidden;
    root.querySelectorAll('.mrow-opts').forEach(o => { o.hidden = true; });
    root.querySelectorAll('.mrow-chev').forEach(c => { c.textContent = '›'; });
    opts.hidden = !willOpen;
    t.querySelector('.mrow-chev').textContent = willOpen ? '⌄' : '›';
  }));
  root.addEventListener('click', (e) => {
    if (!e.target.closest('.mselect')) {
      root.querySelectorAll('.mrow-opts').forEach(o => { o.hidden = true; });
      root.querySelectorAll('.mrow-chev').forEach(c => { c.textContent = '›'; });
    }
  });

  root.querySelectorAll('#f-status [data-s]').forEach(btn =>
    btn.addEventListener('click', () => {
      draft.status = btn.dataset.s;
      root.querySelectorAll('#f-status [data-s]').forEach(x => x.classList.toggle('active', x === btn));
      const pv = document.getElementById('f-prevwrap');
      if (pv) pv.style.display = draft.status === 'read' ? '' : 'none';
      if (draft.status === 'read' && !draft.dateFinished && !draft.previouslyRead) draft.dateFinished = new Date().toISOString();
      if (draft.status !== 'read') draft.dateFinished = null;
      if (draft.status === 'read' && draft.pageCount && !draft.previouslyRead) {
        draft.progress = draft.pageCount; // Save logs the completion delta
        const pi = document.getElementById('f-progress');
        if (pi) pi.value = draft.progress;
      }
      paintShelfRow();
      const opts = btn.closest('.mrow-opts');
      if (opts) { opts.hidden = true; }
      const chev = btn.closest('.mselect').querySelector('.mrow-chev');
      if (chev) chev.textContent = '›';
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

  root.querySelectorAll('#f-owned [data-o]').forEach(btn =>
    btn.addEventListener('click', () => {
      draft.owned = btn.dataset.o; // v148: 'owned' | 'tobuy' | 'borrowed'
      root.querySelectorAll('#f-owned [data-o]').forEach(x => x.classList.toggle('active', x === btn));
      paintOwnedRow();
      const opts = btn.closest('.mrow-opts');
      if (opts) { opts.hidden = true; }
      const chev = btn.closest('.mselect').querySelector('.mrow-chev');
      if (chev) chev.textContent = '›';
      const bw = document.getElementById('m-buywrap');
      if (bw) bw.style.display = draft.owned === 'owned' ? 'none' : '';
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
          if (w) {
            const rv = draft[key] || 0;
            w.textContent = rv ? RATING_WORDS[rv] : 'Unrated'; // v224 (UX-09)
            w.classList.toggle('plain', !rv);
          }
          syncRatingLive(); // v224 (UX-11): hearts commit live
        }
      }));
  };
  wirePicker('#f-myrating', 'myRating');
  wireAxRows();
  // v224 (UX-01/02): the sticky bar names the unsaved-changes risk, but only
  // while a text field is focused — ratings/axes commit live (UX-11).
  const saveHint = document.getElementById('m-savehint');
  if (saveHint) {
    root.querySelectorAll('input.text-input, textarea.text-input').forEach(el => {
      el.addEventListener('focus', () => { saveHint.hidden = false; });
      el.addEventListener('blur', () => { saveHint.hidden = true; });
    });
  }

  const escClose = e => { if (e.key === 'Escape' && overlayIsTop(ovToken)) close(); }; // v129: escape closes, v220: topmost only
  // v220: DOM-only teardown — the history entry is owned by overlayOpened.
  const closeDom = () => {
    document.removeEventListener('keydown', escClose);
    unlockBodyScroll(); // v215: release the background scroll lock
    root.innerHTML = ''; editingId = null; editingDraft = null; refreshProgressSection = null;
  };
  const ovToken = overlayOpened('modal-root', closeDom); // v220: back-gesture closes the modal
  const close = () => { overlayClosed(ovToken); closeDom(); }; // v220: programmatic close consumes the entry
  document.addEventListener('keydown', escClose);
  root.querySelectorAll('[data-sim]').forEach(el => // v110: jump to a similar book
    el.addEventListener('click', () => openDetail(el.dataset.sim)));
  document.getElementById('m-x').addEventListener('click', close);
  // v174: tab switching — Details | Tropes | Notes.
  const showDTab = (name) => {
    root.querySelectorAll('.d-tab').forEach(t => {
      const on = t.dataset.dtab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    root.querySelectorAll('.d-panel').forEach(p => { p.hidden = p.id !== 'dtab-' + name; });
  };
  root.querySelectorAll('.d-tab').forEach(t =>
    t.addEventListener('click', () => showDTab(t.dataset.dtab)));
  document.getElementById('m-changecover').addEventListener('click', () => openCoverPicker(id));
  // v210: edition picker — change which edition of the book she owns.
  document.getElementById('m-edition').addEventListener('click', () => openEditionPicker(id));
  document.getElementById('m-back').addEventListener('click', e => { if (e.target.id === 'm-back') close(); });
  // v215: bottom-sheet drag-to-dismiss (touch only) on the sheet element.
  wireSheetDrag(root.querySelector('#m-back .modal'), close);
  // v182: description read-more toggles — hero (desktop) + Details tab.
  // Hidden when the text fits unclamped.
  const wireDescToggle = (wrapId) => {
    const dWrap = document.getElementById(wrapId);
    if (!dWrap) return;
    const dP = dWrap.querySelector('p');
    const dT = document.getElementById(wrapId + '-toggle');
    if (!dP || !dT) return;
    if (dP.scrollHeight <= dP.clientHeight + 2) dT.style.display = 'none';
    dT.addEventListener('click', () => {
      const open = dWrap.classList.toggle('open');
      dT.textContent = open ? 'Show less' : 'Read more';
    });
  };
  wireDescToggle('m-desc');
  wireDescToggle('m-desc-hero');
  root.querySelectorAll('[data-author]').forEach(el =>
    el.addEventListener('click', () => openCollection('author', el.dataset.author, id)));
  // v133: series books are inline now — wire their rows + the full-series fill.
  wireSeriesRows(root);
  const sBox = root.querySelector('#m-series-more');
  if (sBox && b.series && b.series.name) fillMoreSection('series', b.series.name, id, sBox, true);
  renderProgressSection();

  // v182: mockup "Your tropes" — chips with × remove, + Add reveals the
  // input. The hidden #f-tropes input stays the save-flow source of truth;
  // chips mirror it so suggestions and Save keep working unchanged.
  const syncTropeChips = () => {
    const inp = document.getElementById('f-tropes');
    const box = document.getElementById('f-tropechips');
    if (!inp || !box) return;
    const list = inp.value.split(',').map(t => t.trim()).filter(Boolean);
    // v212: badge the tropes the AI auto-added so she can tell them apart
    const aiSet = new Set((b.tropesAI || []).map(t => String(t).toLowerCase()));
    box.innerHTML = list.length
      ? list.map(t => {
          const ai = aiSet.has(t.toLowerCase());
          return '<span class="chip on' + (ai ? ' ai' : '') + '">' + (ai ? '✦ ' : '') + esc(t) +
            '<button data-trm="' + esc(t.toLowerCase()) + '" aria-label="Remove ' + esc(t) + '">×</button></span>';
        }).join('')
      : '<span class="note">No tropes yet — tap + Add for what you love about this book.</span>';
    box.querySelectorAll('[data-trm]').forEach(btn => btn.addEventListener('click', () => {
      const removed = btn.dataset.trm;
      const cur = inp.value.split(',').map(t => t.trim()).filter(Boolean)
        .filter(t => t.toLowerCase() !== removed);
      inp.value = cur.join(', ');
      // v212: ×-removing an AI-added trope tombstones it so auto-add never
      // resurrects it (work-wide rejection stays admin-only per RLS).
      try {
        if (aiSet.has(removed)) {
          b.tropesAI = (b.tropesAI || []).filter(t => String(t).toLowerCase() !== removed);
          b.tropes = (b.tropes || []).filter(t => String(t).toLowerCase() !== removed);
          if (typeof TropeTaxonomy !== 'undefined' && typeof dismissAutoTrope === 'function') {
            const id = TropeTaxonomy.resolveId(removed);
            if (id) dismissAutoTrope(b, id);
          }
        }
      } catch (e) {}
      syncTropeChips();
      renderTropeSuggestions();
    }));
  };
  const commitTropeAdd = () => {
    const addEl = document.getElementById('f-tropeadd');
    const inp = document.getElementById('f-tropes');
    if (!addEl || !inp) return;
    const v = addEl.value.trim().toLowerCase();
    if (!v) return;
    const cur = inp.value.split(',').map(t => t.trim()).filter(Boolean);
    if (!cur.map(t => t.toLowerCase()).includes(v)) cur.push(v);
    inp.value = cur.join(', ');
    addEl.value = '';
    syncTropeChips();
    renderTropeSuggestions();
  };
  document.getElementById('f-tropeaddtoggle').addEventListener('click', () => {
    const w = document.getElementById('f-tropeaddwrap');
    w.hidden = !w.hidden;
    if (!w.hidden) document.getElementById('f-tropeadd').focus();
  });
  document.getElementById('f-tropeaddbtn').addEventListener('click', commitTropeAdd);
  document.getElementById('f-tropeadd').addEventListener('keydown', e => { if (e.key === 'Enter') commitTropeAdd(); });

  // v81: trope suggestions — tappable chips. Tap to add to her list;
  // suggestions never overwrite what she typed. v182: mockup "View more".
  let tropeSuggExpanded = false;
  const renderTropeSuggestions = () => {
    const box = document.getElementById('f-tropesugg');
    if (!box) return;
    const inp = document.getElementById('f-tropes');
    const mine = new Set((inp ? inp.value : '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
    const sugg = (b.tropesAuto || []).filter(t => !mine.has(String(t).toLowerCase()));
    const shown = tropeSuggExpanded ? sugg : sugg.slice(0, 6);
    box.innerHTML = shown.length
      ? '<span class="note">Suggested — tap to add:</span> ' + shown.map(t =>
        '<button class="chip sugg" data-tsugg="' + esc(t) + '">+ ' + esc(t) + '</button>').join('')
      : '';
    box.querySelectorAll('[data-tsugg]').forEach(btn => btn.addEventListener('click', () => {
      const cur = inp.value.split(',').map(t => t.trim()).filter(Boolean);
      if (!cur.map(t => t.toLowerCase()).includes(btn.dataset.tsugg.toLowerCase())) {
        cur.push(btn.dataset.tsugg);
        inp.value = cur.join(', ');
      }
      syncTropeChips();
      renderTropeSuggestions();
    }));
    const moreBtn = document.getElementById('m-tropemore');
    if (moreBtn) {
      moreBtn.hidden = sugg.length <= 6;
      moreBtn.textContent = tropeSuggExpanded ? 'Show less' : 'View more →';
    }
  };
  const tropeMoreBtn = document.getElementById('m-tropemore');
  if (tropeMoreBtn) tropeMoreBtn.addEventListener('click', () => {
    tropeSuggExpanded = !tropeSuggExpanded;
    renderTropeSuggestions();
  });
  if ((b.tropeSrc || '') !== tropeSourceKey()) {
    refreshTropeSuggestions(b).then(() => {
      try { delete b._hcTagsFetched; } catch (e) {}
      saveLibrary();
      renderTropeSuggestions();
    });
  }
  renderTropeSuggestions();
  syncTropeChips();

  // v153: trope-intelligence chips — DB tropes when present (with a subtle
  // source indicator), heuristic suggestions otherwise. Fills in async.
  // v212: onAutoAdd unions the AI-augmented book list with any in-flight
  // chip edits instead of clobbering what she typed while claims loaded.
  renderDbTropeChips(b, () => {
    const inp = document.getElementById('f-tropes');
    if (!inp) return;
    const cur = inp.value.split(',').map(t => t.trim()).filter(Boolean);
    const have = new Set(cur.map(t => t.toLowerCase()));
    for (const t of (b.tropes || [])) {
      if (!have.has(String(t).toLowerCase())) { cur.push(t); have.add(String(t).toLowerCase()); }
    }
    inp.value = cur.join(', ');
    syncTropeChips();
  });
  // v155: propose-a-trope sheet, with this book as the originating book.
  const tpb = document.getElementById('m-tropepropose');
  if (tpb) tpb.addEventListener('click', () => openTropeProposalSheet(b));

  // v182: mockup "Save note" — notes save immediately (like quotes), and the
  // draft stays in sync so the modal Save can't clobber them.
  document.getElementById('m-notesave').addEventListener('click', () => {
    const v = document.getElementById('f-notes').value;
    b.notes = v;
    draft.notes = v;
    saveLibrary();
    toast('Note saved 📝');
  });

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

  // v182: the mockup shows favorite in three places — top-right heart, hero
  // heart beside the primary action, and the ⋮ menu. One toggle, all repaint.
  const paintFav = () => {
    const on = !!draft.favorite;
    ['f-fav', 'f-fav2'].forEach(fid => {
      const el = document.getElementById(fid);
      if (el) el.classList.toggle('on', on);
    });
    const fm = document.getElementById('m-favmenu');
    if (fm) fm.innerHTML = icon('heart') + ' <span>' +
      (on ? 'Remove from Favorites' : 'Add to Favorites') + '</span>';
  };
  const toggleFavorite = () => {
    draft.favorite = !draft.favorite;
    b.favorite = draft.favorite; // immediate — no need to hit Save
    saveLibrary();
    paintFav();
    render(); // refresh the shelf behind the modal
    track(draft.favorite ? 'book_favorited' : 'book_unfavorited');
    toast(draft.favorite ? 'Pinned to favorites ❤️' : 'Removed from favorites 🤍');
  };
  document.getElementById('f-fav').addEventListener('click', toggleFavorite);
  document.getElementById('f-fav2').addEventListener('click', toggleFavorite);
  document.getElementById('m-favmenu').addEventListener('click', () => {
    toggleFavorite();
    document.getElementById('m-moremenu').hidden = true;
  });
  paintFav(); // sync the menu label with the initial state

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
    document.getElementById('m-upnext').innerHTML = icon('upnext') + ' <span>' +
      (upNext.includes(b.id) ? 'In your Up Next queue — tap to remove' : 'Add to Up Next') + '</span>';
    moreMenu.hidden = true;
  });
  // v182: mockup menu — Change Cover joins the floating card.
  document.getElementById('m-covermenu').addEventListener('click', () => {
    moreMenu.hidden = true;
    openCoverPicker(id);
  });
  document.getElementById('m-share').addEventListener('click', () => {
    moreMenu.hidden = true;
    shareBookCard(b.id);
  });
  // v224 (UX-10): Share also sits in the primary row, next to the heart.
  document.getElementById('m-share2').addEventListener('click', () => shareBookCard(b.id));
  document.getElementById('m-save').addEventListener('click', () => {
    draft.tropes = document.getElementById('f-tropes').value.split(',')
      .map(t => t.trim().toLowerCase()).filter(Boolean);
    draft.notes = document.getElementById('f-notes').value;
    draft.releaseDate = document.getElementById('f-releasedate').value || '';
    // v239: manual series tagging — a name sets seriesManual so enrichment
    // never clobbers it; clearing the name removes the series entirely.
    const sName = document.getElementById('f-series').value.trim();
    const sPos = document.getElementById('f-series-pos').value.trim();
    if (sName) {
      draft.series = { name: sName, position: sPos || null };
      draft.seriesManual = true;
    } else {
      draft.series = null;
      draft.seriesManual = false;
    }
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
    draft.cover = b.cover; // v168: the cover picker saves immediately too — don't clobber it
    draft.isbn = b.isbn; // v210: the edition picker saves immediately too — don't clobber it
    const _aBefore = { // v118: snapshot for analytics diff (never book content)
      status: b.status, myRating: ratingBefore.myRating, title: b.title, notes: b.notes,
      releaseDate: b.releaseDate, tropes: (b.tropes || []).slice(),
      pageCount: b.pageCount, ratings: ratingBefore.ratings, // v224 (UX-11): live taps predate Save
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

/* v153: fill the Trope intelligence row — DB tropes when present, heuristic
   suggestions otherwise. v154: vote buttons (tap again to retract).
   v212: high-confidence AI tropes also auto-add to her list via
   autoAddConfirmedTropes; onAutoAdd (optional) re-syncs the editor chips.
   Async; leaves a fallback note on failure. */
async function renderDbTropeChips(book, onAutoAdd) {
  const box = document.getElementById('m-tropedb');
  if (!box) return;
  try {
    const key = bookKeyFor(book);
    const [{ tropes, origin }, votes] = await Promise.all([
      TropeStore.getBookTropes(book),
      TropeVotes.getVotes(key),
    ]);
    box.innerHTML = dbTropeChipsHTML(tropes, origin, votes);
    box.querySelectorAll('[data-tv]').forEach(btn => btn.addEventListener('click', async () => {
      const tid = btn.dataset.tid;
      const want = parseInt(btn.dataset.tv, 10);
      try {
        btn.disabled = true;
        await TropeVotes.toggleVote(key, tid, want);
        renderDbTropeChips(book, onAutoAdd); // re-render: counts, highlight, adjusted confidence
      } catch (e) {
        btn.disabled = false;
      }
    }));
    try {
      if (typeof autoAddConfirmedTropes === 'function' &&
          autoAddConfirmedTropes(book, tropes) &&
          typeof onAutoAdd === 'function') onAutoAdd();
    } catch (e) {}
  } catch (e) {
    box.innerHTML = '<p class="note">No trope data yet.</p>';
  }
}
