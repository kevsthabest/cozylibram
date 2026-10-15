'use strict';

/* ---- "missing books" discovery: more by author / full series from outside the library ---- */
const authorCache = new Map(); // author key -> external rows
const seriesCache = new Map(); // series key -> { rows } or { needsToken: true }

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
  if (!hcReady()) { const r = { needsToken: true, rows: [], found: false }; seriesCache.set(key, r); return r; }
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
  // `found` says the listing itself resolved (vs. the series simply not
  // being on Hardcover): the Finale (js/239) may only call a series total
  // "known" when the listing was actually found.
  const out = { rows, found: !!hit };
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
// v559: that means the born pair status 'tbr' + owned 'tobuy' — the
// Wishlist is the to-buy part of TBR (isWishlistBook, js/000), derived
// from the pair, never a status of its own.
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
    owned: 'tobuy', // discovered = wanted, not yet in hand
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
/* v402: Spice Forecast sparkline — inline SVG, no external libs.
   Takes an array of per-chapter spice levels (0-5), renders a small
   area sparkline. Returns '' when data is insufficient. */
function spiceSparklineHTML(levels) {
  try {
    if (!Array.isArray(levels) || levels.length < 2) return '';
    const vals = levels.map(v => {
      const n = Number(v);
      return (isFinite(n) && n >= 0 && n <= 5) ? n : 0;
    });
    const W = 220, H = 36, PAD = 3;
    const max = 5;
    const stepX = (W - PAD * 2) / (vals.length - 1);
    const pts = vals.map((v, i) => {
      const x = (PAD + i * stepX).toFixed(1);
      const y = (H - PAD - (v / max) * (H - PAD * 2)).toFixed(1);
      return x + ',' + y;
    });
    const line = pts.join(' ');
    const area = PAD + ',' + (H - PAD) + ' ' + line + ' ' + (W - PAD) + ',' + (H - PAD);
    const peak = Math.max(...vals);
    return '<div class="chaptermeta-row spice-forecast">' +
      '<span class="chaptermeta-label">' + (typeof icon === 'function' ? icon('pepper') : '') + ' Spice forecast</span>' +
      '<svg class="sparkline" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-label="Per-chapter spice levels, peak ' + peak + ' of 5">' +
      '<polygon points="' + area + '" class="spark-area"/>' +
      '<polyline points="' + line + '" class="spark-line"/>' +
      '</svg></div>';
  } catch (e) { return ''; }
}

/* v329: shared character-tab loader — used by renderDetailModal (the full
   book modal). Takes the book object directly; caches per book id so
   re-opening the tab doesn't refetch. */
async function loadCharsTabForBook(t) {
  // v403 fix: no persistent cache across modal instances.
  // The modal HTML re-renders fresh each time with "Loading...", so a stale
  // cache hit leaves the placeholder forever. Just load every time.
  const box = document.getElementById('m-charstab');
  if (!box) return;
  if (typeof CharacterWiki === 'undefined') {
    box.innerHTML = '<p class="note">Character module not loaded — try fully closing and reopening the app.</p>';
    return;
  }
  // v404: separate timeouts per stage, retry button on failure
  const loadWithRetry = async (attempt) => {
    try {
      const stageTimeout = (ms, label) => new Promise((_, rej) =>
        setTimeout(() => rej(new Error(label + ' timeout')), ms));
      const workId = await Promise.race([
        resolveWork(t),
        stageTimeout(8000, 'work-resolve')
      ]);
      if (!workId) { box.innerHTML = '<p class="note">No work linked.</p>'; return; }
      const cast = await Promise.race([
        CharacterWiki.getCast(workId),
        stageTimeout(8000, 'character-fetch')
      ]);
      if (!cast.total) { box.innerHTML = '<p class="note">No characters recorded for this book yet.</p>'; return; }
    const card = (c) => {
      // v329: all characters tappable — linked open the wiki, unlinked open book detail
      const tapAttr = c.characterId
        ? 'data-chwiki="' + esc(c.characterId) + '"'
        : 'data-chbook="' + esc(c.id) + '"';
      const link = '<button class="taplink" ' + tapAttr + '>' + esc(c.name) + '</button>';
      const desc = c.description ? '<p class="note">' + esc(c.description.slice(0, 160)) + (c.description.length > 160 ? '…' : '') + '</p>' : '';
      // v402: progressive disclosure — "Introduced in Ch. 3" only when pipeline provided it
      const intro = (c.firstAppearance != null && c.firstAppearance !== '')
        ? '<p class="note ch-intro">Introduced in Ch. ' + esc(String(c.firstAppearance)) + '</p>' : '';
      const rels = (c.relationships && c.relationships.length)
        ? '<p class="note">' + c.relationships.slice(0, 3).map(r => esc(r.to) + ' <i>(' + esc(r.type) + ')</i>').join(' · ') + '</p>' : '';
      return '<div class="ch-card">' + link + desc + intro + rels + '</div>';
    };
    const section = (title, list, id, hideTitle) => {
      if (!list.length) return '';
      return (hideTitle ? '' : '<h4 class="serif">' + title + ' (' + list.length + ')</h4>') +
        '<div class="ch-list" id="' + id + '"' + (id !== 'm-ct1' ? ' style="display:none"' : '') + '>' +
        list.map(card).join('') + '</div>';
    };
    let h = section('Protagonists', cast.tier1, 'm-ct1', false);
    if (cast.tier1b.length) h += section('Antagonists', cast.tier1b, 'm-ct1b', false);
    if (cast.tier2.length) h += '<p><button class="taplink" id="m-ct2-t">Supporting cast (' + cast.tier2.length + ')</button></p>' + section('', cast.tier2, 'm-ct2', true);
    if (cast.tier3.length) h += '<p><button class="taplink" id="m-ct3-t">Minor characters (' + cast.tier3.length + ')</button></p>' + section('', cast.tier3, 'm-ct3', true);
    box.innerHTML = h;
    const wire = (btnId, listId) => {
      const b = document.getElementById(btnId);
      if (b) b.addEventListener('click', () => {
        const l = document.getElementById(listId);
        if (l) l.style.display = l.style.display === 'none' ? '' : 'none';
      });
    };
    wire('m-ct2-t', 'm-ct2'); wire('m-ct3-t', 'm-ct3');
    box.querySelectorAll('[data-chwiki]').forEach(b => b.addEventListener('click', () => {
      openCharacter(b.getAttribute('data-chwiki'));
    }));
    box.querySelectorAll('[data-chbook]').forEach(b => b.addEventListener('click', () => {
      openBookCharacter(b.getAttribute('data-chbook'));
    }));
    } catch (e) {
      const msg = esc((e && e.message) || 'unknown error');
      box.innerHTML = '<p class="note">Could not load characters: ' + msg + '</p>' +
        '<p><button class="btn sm" id="m-chars-retry">Retry</button></p>';
      const rb = document.getElementById('m-chars-retry');
      if (rb) rb.addEventListener('click', () => {
        box.innerHTML = '<p class="note">Loading characters…</p>';
        loadWithRetry((attempt || 0) + 1);
      });
    }
  };
  loadWithRetry(0);
}

/* v337: load memorable quotes for a book's work into the modal Details tab. */
async function loadQuotesForBook(t) {
  try {
    const wrap = document.getElementById('m-quotes-wrap');
    const box = document.getElementById('m-quotes');
    if (!wrap || !box || typeof CharacterWiki === 'undefined') return;
    const workId = await resolveWork(t);
    if (!workId) return;
    const quotes = await CharacterWiki.getQuotesForWork(workId);
    if (!quotes.length) return;
    box.innerHTML = '<div class="ch-quotes">' + quotes.slice(0, 4).map(q =>
      '<blockquote class="ch-quote"><p>"' + esc(q.quote) + '"</p>' +
      (q.speaker ? '<cite>— ' + esc(q.speaker) + '</cite>' : '') +
      (q.context ? '<span class="note"> ' + esc(q.context) + '</span>' : '') +
      '</blockquote>'
    ).join('') + '</div>';
    wrap.style.display = '';
  } catch (e) {}
}

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
    '<button class="btn ghost" id="p-wish">' + icon('gift') + ' Wishlist</button>' +
    // v528: an opt-in extra action for callers that have one (the
    // friend-shelf buddy-read invitation, js/195/js/233). Absent
    // unless opts.onBuddyRead is passed — every other caller renders
    // exactly as before.
    (opts.onBuddyRead ? '<button class="btn ghost" id="p-buddy">' + icon('friends') + ' Read together</button>' : '') + '</div>' +
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

  // v528: the opt-in buddy-read action (see the render above). The
  // callback owns the RPC + toasts; here we just guard double taps
  // and settle the button's label.
  const pBuddy = document.getElementById('p-buddy');
  if (pBuddy && opts.onBuddyRead) pBuddy.addEventListener('click', async () => {
    pBuddy.disabled = true;
    let okSent = false;
    try { okSent = !!(await opts.onBuddyRead()); } catch (e) { okSent = false; }
    if (okSent) { pBuddy.textContent = 'Invitation sent'; }
    else { pBuddy.disabled = false; }
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
          '<p class="note">' + icon('bulb') + ' Hardcover isn’t available right now, so the full series can’t be shown.</p>';
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
/* ---- Modal Variant A: the series strip lives in the header zone, above
   the tabs — one horizontal row. Owned books (this one included) render
   as cover figures captioned "#pos · Status"; missing books join the
   same row as "+ Wishlist" figures when the full-series lookup lands
   (fillSeriesStrip) — one tap adds, like the old list's button. ---- */
const SERIES_STATUS_LABEL = { tbr: 'TBR', reading: 'Reading', read: 'Read', dnf: 'DNF' };
let stripExtRows = null; // { bookId, rows } — the open modal's missing-books fill

function seriesStripHTML(b, id) {
  if (!(b.series && b.series.name)) return '';
  stripExtRows = { bookId: id, rows: null };
  return '<div class="m-series-zone" id="m-series"><div class="lbl">In this series' +
    '<span class="note-inline"> · ' + esc(b.series.name) + '</span></div>' +
    '<div class="strip" id="m-strip"></div></div>';
}

// Paints owned + missing figures merged in position order and wires them.
// Re-run after the external fill lands and after a wishlist add (the added
// book is owned then, so it repaints from the library side).
function paintSeriesStrip(b) {
  const strip = document.getElementById('m-strip');
  if (!strip || !(b.series && b.series.name)) return;
  const key = String(b.series.name).trim().toLowerCase();
  const inSeries = (x) => x.series && x.series.name &&
    String(x.series.name).trim().toLowerCase() === key;
  const posOf = (p) => { const n = parseFloat(p); return isNaN(n) ? 1e9 : n; };
  const entries = library.filter(inSeries).map(bk => ({ bk, ext: null, pos: posOf(bk.series.position) }));
  if (stripExtRows && stripExtRows.bookId === b.id && stripExtRows.rows) {
    stripExtRows.rows.forEach(x => entries.push({ bk: null, ext: x, pos: posOf(x.position) }));
  }
  entries.sort((a, c) => a.pos - c.pos);
  const figCover = (cover, title) => cover
    ? '<img src="' + esc(cover) + '" alt="" loading="lazy" onerror="this.remove()">'
    : '<span class="strip-nocover">' + esc(title || '') + '</span>';
  strip.innerHTML = entries.map(e => {
    if (e.ext) {
      const pos = (e.ext.position != null && e.ext.position !== '') ? '#' + esc(String(e.ext.position)) : '#–';
      return '<figure class="strip-fig ext" data-extfig="' + entries.indexOf(e) + '" role="button" tabindex="0" ' +
        'aria-label="Add ' + esc(e.ext.title || '') + ' to the wishlist">' +
        figCover(e.ext.cover, e.ext.title) +
        '<figcaption>' + pos + ' · + Wishlist</figcaption></figure>';
    }
    const bk = e.bk;
    const pos = (bk.series.position != null && bk.series.position !== '')
      ? '#' + esc(String(bk.series.position)) : '#–';
    const cap = pos + ' · ' + (SERIES_STATUS_LABEL[bk.status] || 'TBR');
    const cur = bk.id === b.id;
    return '<figure class="strip-fig' + (cur ? ' cur' : '') + '"' +
      (cur ? '' : ' data-book="' + esc(bk.id) + '" role="button" tabindex="0" aria-label="' + esc(bk.title || '') + '"') + '>' +
      figCover(bk.cover, bk.title) + '<figcaption>' + cap + '</figcaption></figure>';
  }).join('');
  strip.querySelectorAll('[data-book]').forEach(el =>
    el.addEventListener('click', () => openDetail(el.dataset.book)));
  strip.querySelectorAll('[data-extfig]').forEach(fig => fig.addEventListener('click', () => {
    const e = entries[Number(fig.dataset.extfig)];
    if (!e || !e.ext) return;
    addExternalBook(e.ext);
    toast('Added to wishlist 💝');
    if (stripExtRows) stripExtRows.rows = (stripExtRows.rows || []).filter(x => x !== e.ext);
    paintSeriesStrip(b);
  }));
}

async function fillSeriesStrip(b) {
  if (!(b.series && b.series.name) || !document.getElementById('m-strip')) return;
  try {
    const r = await fetchSeriesBooks(b.series.name, (b.authors || [])[0]);
    if (!document.getElementById('m-strip')) return; // modal moved on
    if (!stripExtRows || stripExtRows.bookId !== b.id) return;
    if (r.needsToken) {
      const strip = document.getElementById('m-strip');
      if (strip && !strip.querySelector('.strip-note')) {
        strip.insertAdjacentHTML('beforeend',
          '<span class="strip-note">Hardcover isn’t available right now, so the full series can’t be shown.</span>');
      }
      return;
    }
    stripExtRows.rows = r.rows;
    paintSeriesStrip(b);
  } catch (e) { /* the owned strip stands on its own */ }
}
function wireSeriesRows(scope) {
  scope.querySelectorAll('#m-series [data-book]').forEach(el =>
    el.addEventListener('click', () => openDetail(el.dataset.book)));
}
/* js/070 calls this after background enrichment lands more data, so the
   strip (and the series position in the header) can repaint without a
   reopen. Modal Variant A: the strip lives in #m-series-wrap. */
function refreshSeriesInline(book) {
  if (!book) return;
  const wrap = document.getElementById('m-series-wrap');
  if (wrap && book.series && book.series.name) {
    wrap.innerHTML = seriesStripHTML(book, book.id);
    paintSeriesStrip(book);
    fillSeriesStrip(book);
  }
  const hdrPos = document.getElementById('d-pos');
  if (hdrPos) hdrPos.textContent = (book.series && book.series.position != null && book.series.position !== '')
    ? ' · Book ' + book.series.position : '';
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
/* ---- Modal Variant A: the save-model seam ------------------------------
   ModalFormState: dirty-state tracking for the book modal's ONE save
   model, deliberately decoupled from any UI. Every staged control
   registers a read() here (draft fields or input values); the tracker
   diffs reads against the baseline captured at open (arm()). The sticky
   Save bar is a pure VIEW of count() — it owns no state. Variant B
   (autosave) can swap the bar's commit trigger for a debounced
   commitForm() without touching a single field registration: the
   switch is a behaviour change at this seam, not a restructure.
   Instant actions (favourite, progress steppers, primary actions) are
   NOT fields — when one also moves a staged value it blesses exactly
   its own field via commitValue(), so the bar never double-reports an
   already-committed change. */
function createModalFormState() {
  const fields = new Map();
  let baseline = {};
  let armed = false;
  const subs = [];
  const clone = (v) => { try { return JSON.parse(JSON.stringify(v == null ? null : v)); } catch (e) { return v; } };
  const readAll = () => {
    const o = {};
    fields.forEach((f, k) => { try { o[k] = clone(f()); } catch (e) { o[k] = null; } });
    return o;
  };
  const api = {
    register(key, read) { fields.set(key, read); },
    arm() { baseline = readAll(); armed = true; },
    current(key) { const f = fields.get(key); if (!f) return null; try { return clone(f()); } catch (e) { return null; } },
    count() {
      if (!armed) return 0;
      const cur = readAll(); let n = 0;
      fields.forEach((_, k) => { if (JSON.stringify(cur[k]) !== JSON.stringify(baseline[k])) n++; });
      return n;
    },
    isDirty() { return api.count() > 0; },
    isFieldDirty(key) {
      if (!armed) return false;
      return JSON.stringify(api.current(key)) !== JSON.stringify(baseline[key]);
    },
    commitValue(key, value) { baseline[key] = clone(value); api.touch(); },
    markSaved() { baseline = readAll(); api.touch(); },
    onChange(cb) { subs.push(cb); },
    touch() { if (!armed) return; const n = api.count(); subs.forEach(cb => { try { cb(n); } catch (e) {} }); }
  };
  return api;
}

function renderDetailModal(b, viaBook) {
  const id = b.id;
  editingId = id;
  // v459: community corpus — stash the open book for suggestion flows
  try { if (typeof window.ccSetBook === 'function') window.ccSetBook(b); } catch (e) {}
  lockBodyScroll(); // v215: the library behind must not scroll while open
  const root = document.getElementById('modal-root');

  // v182: mockup alignment — shelf/ownership become tappable rows that expand
  // to choose. Labels + icons for the row display and the option lists.
  const STATUS_META = {
    tbr:     { label: 'TBR',               ic: 'tbr' },
    reading: { label: 'Currently Reading', ic: 'reading' },
    read:    { label: 'Read',              ic: 'read' },
    dnf:     { label: 'DNF',               ic: 'dnf' },
    // v559: four statuses only — the Wishlist is not a shelf choice;
    // it derives from TBR + To buy (see the buy-wrap note below).
  };
  const OWNED_META = {
    owned:    { label: 'Owned',    ic: 'owned' },
    tobuy:    { label: 'To buy',   ic: 'tobuy' },
    borrowed: { label: 'Borrowed', ic: 'borrowed' },
    // v563 (Decision): subscription access (KU / Kobo Plus) — held,
    // not owned; its own facet value, never a tobuy in disguise.
    subscription: { label: 'Subscription', ic: 'subscription' },
  };
  // v563: the ownership row's label COMPOSES facet + format —
  // "Owned · Ebook", "Subscription · Ebook", "Borrowed · Physical" —
  // with the format segment omitted when the format is unset.
  const ownedLabel = (d) => (OWNED_META[d.owned] || OWNED_META.tobuy).label +
    (FORMAT_META[d.format] ? ' · ' + FORMAT_META[d.format].label : '');
  // Variant A: the description renders ONCE — in the header's About bar.
  const descHTML = (idpfx, cls) =>
    (b.description
      ? '<div class="m-desc' + (cls ? ' ' + cls : '') + '" id="' + idpfx + '"><p>' +
        esc(String(b.description).replace(/<[^>]*>/g, '')) + '</p>' +
        '<button class="taplink" id="' + idpfx + '-toggle">Read more</button></div>'
      : '');

  // Variant A: stars, always stars — outline when unlit, filled when lit
  // (the .on fill comes from CSS). Accessible names per star.
  const stars5 = [1, 2, 3, 4, 5].map(n =>
    '<button data-v="' + n + '" class="' + (b.myRating >= n ? 'on' : '') + '" aria-label="Rate ' + n + ' star' + (n === 1 ? '' : 's') + '">' + icon('star') + '</button>').join('');

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
  // v453: ensure a valid ownership value — undefined/null would render with
  // no active option and could clobber b.owned on save.
  // v563: 'subscription' joins the list DELIBERATELY — without it the
  // sanitizer silently coerced every subscription book to 'tobuy'.
  if (!['owned', 'tobuy', 'borrowed', 'subscription'].includes(draft.owned)) draft.owned = 'tobuy';
  // v563: same discipline for the format pair — an invalid draft value
  // unsets (never guesses), and a want naming the current format is not
  // a want. The pickers below are the only draft writers after this.
  if (!BOOK_FORMATS.includes(draft.format)) draft.format = '';
  if (!BOOK_FORMATS.includes(draft.wantFormat) || draft.wantFormat === draft.format) draft.wantFormat = '';
  // v182: option buttons for the tappable shelf/ownership rows (needs the draft).
  const statusOpts = Object.keys(STATUS_META).map(s =>
    '<button data-s="' + s + '" class="' + (draft.status === s ? 'active' : '') + '">' +
    icon(STATUS_META[s].ic) + ' ' + STATUS_META[s].label + '</button>').join('');
  const ownedOpts = Object.keys(OWNED_META).map(o =>
    '<button data-o="' + o + '" class="' + (draft.owned === o ? 'active' : '') + '">' +
    icon(OWNED_META[o].ic) + ' ' + OWNED_META[o].label + '</button>').join('');
  // v563: format options — the five bindings plus an explicit Not set.
  const formatOpts = [''].concat(BOOK_FORMATS).map(f =>
    '<button data-f="' + f + '" class="' + ((draft.format || '') === f ? 'active' : '') + '">' +
    (f ? icon(FORMAT_META[f].ic) + ' ' + FORMAT_META[f].label : 'Not set') + '</button>').join('');
  if (!draft.axes.length) draft.axes = autoDetectAxes(draft);
  editingDraft = draft;
  // Variant A: register every Save-model field with the tracker. Reads
  // are lazy (draft fields + live input values), so registration can
  // happen before the DOM exists; arm() runs once the controls are
  // wired and painted (see below — the bar subscribes there).
  const formState = createModalFormState();
  const elVal = (eid) => { const e = document.getElementById(eid); return e ? e.value : ''; };
  formState.register('title', () => elVal('f-title').trim());
  formState.register('authors', () => elVal('f-author'));
  formState.register('status', () => draft.status);
  formState.register('owned', () => draft.owned);
  formState.register('format', () => draft.format || '');
  formState.register('wantFormat', () => draft.wantFormat || '');
  formState.register('prevread', () => { const e = document.getElementById('f-prevread'); return !!(e && e.checked); });
  formState.register('faceOut', () => { const e = document.getElementById('f-faceout'); return !!(e && e.checked); }); // v564, composed at rebase
  formState.register('myRating', () => draft.myRating || 0);
  formState.register('ratings', () => draft.ratings || {});
  formState.register('axes', () => (draft.axes || []).slice());
  formState.register('tropes', () => elVal('f-tropes').split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
  formState.register('notes', () => elVal('f-notes'));
  formState.register('pageCount', () => elVal('f-pagecount'));
  formState.register('progressInput', () => elVal('f-progress'));
  formState.register('releaseDate', () => elVal('f-releasedate'));
  formState.register('series', () => [elVal('f-series').trim(), elVal('f-series-pos').trim()]);
  formState.register('purchaseSource', () => draft.purchaseSource || '');
  formState.register('purchaseDate', () => draft.purchaseDate || '');
  // v313: work-level spice baseline (pipeline-detected or manual override).
  // Shown as outline segments until the user rates spice themselves.
  // { value: 0-5, source: 'detected'|'manual' } or null.
  let spiceBaseline = null;
  const spiceBaseValue = () => {
    if (draft.ratings.spice) return 0; // user rating wins, no baseline shown
    if (!spiceBaseline) return 0;
    const v = spiceBaseline.source === 'manual' ? spiceBaseline.manual : spiceBaseline.detected;
    return (v >= 1 && v <= 5) ? v : 0;
  };
  // Snapshot the rating state at open — the Save-time diff reports
  // what actually changed (Variant A: taps stage into the draft).
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
    // v313: spice shows the work-level detected baseline as outline
    // segments when the user hasn't rated it themselves.
    const det = (k === 'spice') ? spiceBaseValue() : 0;
    const segs = [1, 2, 3, 4, 5].map(n => {
      let cls = '';
      if (v >= n) cls = 'f';
      else if (det >= n) cls = 'det';
      return '<i data-v="' + n + '" class="' + cls + '"></i>';
    }).join('');
    const word = v ? axWord(a, v)
      : det ? esc(a.levels[det - 1]) + ' <span class="axdet-tag">(' +
        (spiceBaseline.source === 'manual' ? 'curated' : 'detected') + ')</span>'
      : 'Tap to rate';
    return '<div class="axrow" data-ax="' + k + '" style="--axc:' + a.color + '">' +
      '<div class="axhead"><span class="axlab">' + icon(a.icon || 'pepper') + ' ' + esc(a.label) + '</span>' +
      '<span class="axword">' + word + '</span></div>' +
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
    // Variant A: the stepper committed for real — bless the field it
    // wrote so the Save bar doesn't double-report it.
    formState.commitValue('progressInput', String(draft.progress));
    renderProgressSection();
    // v353: refresh log summary after stepper changes
    const summEl = document.getElementById('m-logsummary');
    if (summEl) summEl.outerHTML = logSummaryHTML();
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
  // v353: log summary as function so stepper can re-render it (Advisor triage #10)
  const logSummaryHTML = () => {
    const ds = (b.log || []).map(x => x.d).filter(Boolean).sort();
    if (!ds.length) return '<div id="m-logsummary"></div>';
    return '<div id="m-logsummary" class="log-summary"><span>Started <b>' + esc(fmtDate(ds[0])) + '</b></span>' +
      '<span>Last read <b>' + esc(fmtDate(ds[ds.length - 1])) + '</b></span></div>';
  };

  root.innerHTML =
    '<div class="modal-backdrop' + (viaBook ? ' from-book' : '') + '" id="m-back"><div class="modal detail-v174" role="dialog" aria-modal="true" aria-label="Book details">' +
    '<div class="sheet-grabber" aria-hidden="true"></div>' + // v215: drag-to-dismiss affordance (touch)
    '<button class="d-back" id="m-x" aria-label="Close">←</button>' +
    // v405 (M1): single favorite heart lives in the CTA row (f-fav2) —
    // the top-right duplicate is removed. Overflow menu keeps its entry.
    '<div class="d-topactions">' +
    '<div class="more-wrap"><button class="btn ghost" id="m-more" aria-label="More actions" aria-haspopup="true">' + icon('dots') + '</button>' +
    '<div class="more-menu" id="m-moremenu" hidden>' +
    '<button class="more-item" id="m-share">' + icon('share') + ' <span>Share</span></button>' +
    '<button class="more-item" id="m-toy">' + icon('gift') + ' <span>Recommend to a friend</span></button>' +
    '<button class="more-item" id="m-favmenu">' + icon('heart') + ' <span>Add to Favorites</span></button>' +
    '<button class="more-item" id="m-upnext">' + icon('upnext') + ' <span>Add to Up Next</span></button>' +
    '<button class="more-item" id="m-covermenu">' + icon('camera') + ' <span>Change Cover</span></button>' +
    '<div class="more-sep"></div>' +
    '<button class="more-item danger" id="m-del">' + icon('trash') + ' <span>Remove from Library</span></button>' +
    '</div></div></div>' +
    // v182: mockup hero — desktop is cover left / info right / primary row /
    // description; mobile stacks cover, title, author, rating, meta, action.
    '<div class="d-hero">' +
    '<div class="d-cover">' + coverHTML(b, 'd-cov') + '</div>' +
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
    '<button class="d-fav2" id="m-share2" aria-label="Share this book">' + icon('share') + '</button>' +
    // Variant A: cover tools sit behind this "Cover ▾" pill (same ids,
    // same sheets) instead of the toolbar that sat under the cover.
    '<div class="more-wrap cover-wrap"><button class="btn ghost" id="m-coverpill" aria-haspopup="true">Cover ▾</button>' +
    '<div class="more-menu" id="m-covertools" hidden>' +
    '<button class="more-item" id="m-changecover">' + icon('image') + ' <span>Change Cover</span></button>' +
    '<button class="more-item" id="m-scanfaces">' + icon('camera') + ' <span>Scan Edition</span></button>' +
    '<button class="more-item" id="m-measurethick">' + icon('ruler') + ' <span>Measure thickness</span></button>' +
    '<button class="more-item" id="m-view3d">' + icon('cube') + ' <span>View in 3D</span></button>' +
    '</div></div></div>' +
    // Variant A: the blurb lives HERE and only here — the header
    // "About this book" slim bar (one summary line, tap to expand).
    // The v182 hero copy and the Details-tab copy are both deleted.
    (function() {
      if (!b.description) return '';
      var txt = String(b.description).replace(/<[^>]*>/g, '').trim();
      var teaser = txt.length > 110 ? txt.slice(0, 110) + '…' : txt;
      return '<div class="d-about"><button class="slimbar" id="m-about-toggle" aria-expanded="false">' +
        '<span class="slimbar-main"><b>About this book</b><small>' + esc(teaser) + '</small></span>' +
        '<span class="mrow-chev">›</span></button>' +
        '<div id="m-about-body" hidden>' + descHTML('m-desc') + '</div></div>';
    })() +
    '</div>' +
    // v541: "Reading it too" presence slot (js/235 fills it async;
    // stays empty unless a circle friend is visibly reading this).
    '<div id="m-rittoo"></div>' +
    // Variant A: Book Portrait is a one-line slim bar in the header
    // zone; the full v468 card renders inside it, collapsed.
    (typeof portraitCardHTML === 'function'
      ? '<div class="portrait-slim"><button class="slimbar" id="m-portrait-toggle" aria-expanded="false">' +
        '<span class="slim-ic">' + icon('portrait') + '</span>' +
        '<span class="slimbar-main"><b>Book Portrait</b><small id="ptSlimSum">' +
        (typeof portraitSlimLine === 'function' ? esc(portraitSlimLine(b)) : '') +
        '</small></span><span class="mrow-chev">›</span></button>' +
        '<div id="m-portrait-body" hidden>' + portraitCardHTML(b) + '</div></div>'
      : '') +
    // v565: Your Book as a Candle — directly beside (below) Book Portrait
    // (composition at the Variant A rebase: below the portrait slim bar,
    // same header-zone position the candle shipped in).
    (typeof candleCardHTML === 'function' ? candleCardHTML(b) : '') +
    // v571: Ambience — one entry on the book page, directly below the
    // Candle (same header zone): a slim bar naming the matched recipe
    // (or the house sounds) + its own play control. The player sheet
    // and mini-control are js/240's own.
    (typeof ambienceEntryHTML === 'function' ? ambienceEntryHTML(b) : '') +
    // Variant A: the series strip — header zone, immediately above the tabs.
    '<div id="m-series-wrap">' + seriesStripHTML(b, id) + '</div>' +
    // v174: tabbed detail view — Details | Tropes | Notes (replaces the v124
    // collapsible sections; every control keeps its id). v182: mockup tab icons.
    '<div class="d-tabs" role="tablist">' +
    '<button class="d-tab active" data-dtab="details" role="tab" aria-selected="true">' + icon('doc') + 'Details</button>' +
    '<button class="d-tab" data-dtab="tropes" role="tab" aria-selected="false">' + icon('sparkles') + 'Tropes</button>' +
    '<button class="d-tab" data-dtab="notes" role="tab" aria-selected="false">' + icon('clipboard') + 'Notes</button>' +
    '<button class="d-tab" data-dtab="characters" role="tab" aria-selected="false">' + icon('friends') + 'Characters</button></div>' +

    '<div class="d-panel" id="dtab-details" role="tabpanel">' +
    // Variant A §1: Rating first — stars + axes reunited in ONE card.
    // The axes lived in a collapsed "Mood" accordion halfway down; the
    // stars were hearts until now (always stars: outline → filled).
    '<div class="field m-card"><label>Your rating</label>' +
    '<div class="hrate-row"><div class="picker" id="f-myrating">' + stars5 + '</div>' +
    '<span class="rate-word' + (b.myRating ? '' : ' plain') + '" id="f-myrating-word">' +
    (b.myRating ? RATING_WORDS[b.myRating] : 'Unrated') + '</span></div>' +
    '<div id="f-axrows">' + draft.axes.map(axRowHTML).join('') + '</div>' +
    // v402: progressive disclosure — Spice Forecast sparkline + dialogue
    // ratio, populated async when pipeline data exists; hidden otherwise.
    '<div id="m-chaptermeta"></div>' +
    '<div class="chips" id="f-axadd">' + axAddHTML() + '</div>' +
    '<p class="note" style="margin:6px 0 0">Only the axes that fit this book are shown.</p></div>' +

    // Variant A §2: Status & Ownership — one card. The v405 ownership
    // accordion dissolves; the ownership summary lives in the label row
    // now (paintOwnedRow still updates #f-owned-sum). The v563 Format
    // field + trophy want keep their real controls inside this card.
    '<div class="field m-card"><label>Status & Ownership</label>' +
    // v182: mockup tappable rows — tap to expand, pick, collapse.
    '<div class="field"><label>Shelf / Status</label>' +
    '<div class="mselect" id="f-status">' +
    '<button class="mrow" data-mrow="status"><span class="mrow-ic" id="f-status-ic">' + icon((STATUS_META[draft.status] || STATUS_META.tbr).ic) + '</span>' +
    '<span class="mrow-val" id="f-status-val">' + (STATUS_META[draft.status] || STATUS_META.tbr).label + '</span><span class="mrow-chev">›</span></button>' +
    '<div class="mrow-opts" hidden>' + statusOpts + '</div></div>' +
    '<label class="checkline" id="f-prevwrap" style="' + (draft.status === 'read' ? '' : 'display:none') + '">' +
    '<input type="checkbox" id="f-prevread"' + (draft.previouslyRead ? ' checked' : '') + '> ' + icon('history') + ' Previously read' +
    '<span class="chk-hint">read before tracking — no date stamp, no log</span></label></div>' +

    '<div class="field"><label>Ownership <span class="note-inline" id="f-owned-sum">· ' + esc(ownedLabel(draft)) + '</span></label>' +
    '<div class="mselect" id="f-owned">' +
    '<button class="mrow" data-mrow="owned"><span class="mrow-ic" id="f-owned-ic">' + icon((OWNED_META[draft.owned] || OWNED_META.tobuy).ic) + '</span>' +
    '<span class="mrow-val" id="f-owned-val">' + esc(ownedLabel(draft)) + '</span><span class="mrow-chev">›</span></button>' +
    '<div class="mrow-opts" hidden>' + ownedOpts + '</div></div></div>' +
    // v563: format — its own picker beside ownership, in the same
    // section; and the trophy want ("want another format") below it.
    '<div class="field"><label>Format</label>' +
    '<div class="mselect" id="f-format">' +
    '<button class="mrow" data-mrow="format"><span class="mrow-ic" id="f-format-ic">' + icon(FORMAT_META[draft.format] ? FORMAT_META[draft.format].ic : 'help') + '</span>' +
    '<span class="mrow-val" id="f-format-val">' + (FORMAT_META[draft.format] ? FORMAT_META[draft.format].label : 'Not set') + '</span><span class="mrow-chev">›</span></button>' +
    '<div class="mrow-opts" hidden>' + formatOpts + '</div></div></div>' +
    '<div class="field" id="f-wantwrap"><label>Want another format</label>' +
    '<div class="want-opts" id="f-want-opts"></div>' +
    '<p class="note" id="f-want-note" style="margin:6px 0 0"></p></div>' +
    // v564: face-out display pick — on the book record (faceOut), so it
    // rides library sync and survives shelf re-sorts. The 3D shelf reads
    // it. (Composition at the Variant A rebase: inside this card, where
    // the dissolved ownership accordion used to hold it.)
    '<div class="field"><label>' + icon('shelf') + ' 3D shelf</label>' +
    '<label class="checkline"><input type="checkbox" id="f-faceout"' + (draft.faceOut ? ' checked' : '') + '> Display face-out' +
    '<span class="chk-hint">show the cover on the 3D shelf instead of the spine</span></label></div>' +
    '<div class="field" id="m-buywrap" style="display:' + (draft.owned === 'owned' ? 'none' : '') + '">' +
    // v559: membership legibility — a TBR book marked To buy IS on the
    // Wishlist (derived, js/000); say so where the reader is looking.
    '<p class="note" id="m-wishnote" style="margin:0 0 6px"' + (isWishlistBook(draft) ? '' : ' hidden') + '>' + icon('gift') + ' On your Wishlist — books on your TBR marked To buy live on the Wishlist.</p>' +
    '<label>Where to buy <span class="note-inline">· ' + esc(STORE_REGIONS[detectStoreRegion()].label) + '</span></label>' +
    '<div class="buy-row">' + storeLinks(draft).map(l =>
      '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(l.url) + '">' + esc(l.name) + ' ' + icon('external') + '</a>').join('') +
    '</div></div>' +
    '</div>' + // end Status & Ownership card
    '<div id="m-progress"></div>' +


    // Variant A §4: the quiet Details card — content warnings + the
    // Reading Log as rows (log collapsed by default now, always), then
    // the editable title/author fields.
    '<div class="field m-card"><label>Details</label>' +
    '<div class="field"><label>' + icon('warn') + ' Content warnings</label>' +
    '<div id="m-hc">' + hcDetailHTML(b) + '</div></div>' +
    '<details class="m-collapsible"><summary><span>' + icon('history') + ' Reading Log</span></summary>' +
    '<div class="field"><label>' + icon('history') + ' Reading Log</label>' +
    logSummaryHTML() +
    '<div id="m-loglist">' + logListHTML + '</div>' + rmLogHTML + '</div></details>' +
    // v354: editable title/author — fixes stranded manual-add data (Advisor: in scope)
    '<div class="field"><label>' + icon('edit') + ' Title</label>' +
    '<input class="text-input" id="f-title" value="' + esc(b.title || '') + '" maxlength="300"></div>' +
    '<div class="field"><label>' + icon('user') + ' Author(s)</label>' +
    '<input class="text-input" id="f-author" value="' + esc((b.authors || []).join(', ')) + '" maxlength="300" placeholder="Separate multiple with commas"></div>' +
    // v476: quiet metadata-diff badge — opens the compare sheet, never interrupts
    (typeof metaConflictFor === 'function' && metaConflictFor(b.id) ?
      '<div class="field" id="m-metadiff-wrap"><button class="taplink" id="m-metadiff">' +
      icon('search') + ' We found some differences — which looks right?</button></div>' : '') +
    '</div>' + // end quiet Details card

    // Variant A §5: More details — Purchase lives inside it now (the
    // audit's coldest block was a top-level accordion), the series
    // editor joins it, and the quiet fields follow as before.
    '<details class="m-more-details"><summary><span>More details</span></summary>' +
    // v312: purchase ledger — what you paid, where, when
    // v476: no manual price entry — the value is an automated estimate.
    // purchasePrice is shown read-only when the user previously entered one.
    '<div class="field secondary"><label>Purchase</label>' +
    (function() {
      var est = (typeof estimateBookValue === 'function') ? estimateBookValue(draft) : null;
      if (draft.purchasePrice != null && !isNaN(draft.purchasePrice))
        return '<div class="note-inline">You paid ' + esc(formatMoney(Number(draft.purchasePrice))) + '</div>';
      if (est) return '<div class="note-inline">Est. value: ' + esc(formatMoney(est.value)) + ' (estimate)</div>';
      return '';
    })() +
    '<div class="purchase-row">' +
    '<select id="f-purchase-source">' +
    '<option value="">Source…</option>' +
    ['Amazon','Indigo','Walmart'].map(function(nm) {
      return '<option value="' + nm + '"' + (draft.purchaseSource === nm ? ' selected' : '') + '>' + nm + '</option>';
    }).join('') +
    '<option value="__other"' + (draft.purchaseSource && ['Amazon','Indigo','Walmart'].indexOf(draft.purchaseSource) < 0 ? ' selected' : '') + '>Other…</option>' +
    '</select>' +
    '<input type="date" id="f-purchase-date" value="' + (draft.purchaseDate ? esc(draft.purchaseDate) : '') + '" />' +
    '</div>' +
    '<input type="text" id="f-purchase-source-custom" placeholder="Store name (e.g. Blue Heron Books)" value="' + (draft.purchaseSource && ['Amazon','Indigo','Walmart'].indexOf(draft.purchaseSource) < 0 ? esc(draft.purchaseSource) : '') + '" style="display:' + (draft.purchaseSource && ['Amazon','Indigo','Walmart'].indexOf(draft.purchaseSource) < 0 ? '' : 'none') + ';margin-top:6px;" />' +
    '</div>' +
    '<div class="field secondary"><label>' + icon('series') + ' Series</label>' + seriesEditHTML(b, id) + '</div>' +
    '<div class="field secondary"><label>Total pages</label>' +
    '<div class="row-flex"><input id="f-pagecount" class="text-input" type="number" min="0" inputmode="numeric" placeholder="e.g. 384" value="' + (draft.pageCount || '') + '">' +
    (b.isbn ? '<button class="btn ghost" id="pc-lookup" title="Look up page count by ISBN">' + icon('search') + '</button>' : '') + '</div></div>' +
    '<div class="field secondary"><label>Current page</label>' +
    '<input id="f-progress" class="text-input" type="number" min="0" inputmode="numeric" value="' + (draft.progress || 0) + '"></div>' +
    '<div class="field secondary"><label>' + icon('calendar') + ' Release date</label>' +
    '<input id="f-releasedate" class="text-input" type="date" value="' + esc(b.releaseDate || '') + '">' +
    '<p class="note">For announced books — the Wishlist surfaces them under “Coming soon”.</p></div>' +
    '</details>' +
    // Variant A: discovery sits BELOW the form under a divider —
    // outside the edit path entirely.
    '<div class="field m-explore"><div class="zone-div"><span>Keep exploring</span></div>' +
    '<label>' + icon('sparkles') + ' More like this <span class="note-inline">· from your shelves</span></label>' +
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
    '<div class="tropedb-card"><div id="m-tropedb" class="chips"><p class="note">Checking…</p></div></div></div>' +
    '</div>' +

    '<div class="d-panel" id="dtab-characters" role="tabpanel" hidden>' +
    '<div id="m-charstab"><p class="note">Loading characters…</p></div></div>' +
    '<div class="d-panel" id="dtab-notes" role="tabpanel" hidden>' +
    '<div class="field"><label>My notes</label>' +
    '<textarea id="f-notes" class="text-input" placeholder="Thoughts, quotes, warnings for future self…">' + esc(b.notes) + '</textarea>' +
    '<div class="row-flex" style="margin-top:8px"><button class="btn sm" id="m-notesave">Save note</button></div></div>' +
    '<div class="field"><label>' + icon('quotes') + ' Saved quotes <span class="note-inline">· ' + (b.quotes || []).length + '</span></label>' +
    '<div id="m-quotes"></div></div>' +
    '</div>' +

    // Variant A: the sticky Save bar — a pure VIEW of ModalFormState
    // (see createModalFormState above). Hidden while the form is clean;
    // rises with the unsaved-change count when it goes dirty.
    '<div class="modal-actions m-savebar" id="m-savebar" hidden>' +
    '<span class="save-count" id="m-savecount" role="status"></span>' +
    '<button class="btn ghost" id="m-discard">Discard</button>' +
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
  // v559: a wishlist book is already TBR, so its "Move to TBR" primary
  // is gone; the primary act for a wishlist-derived draft is the
  // acquisition — mark it owned, and it leaves the Wishlist by
  // derivation (status stays 'tbr'). The resolver keys on the DRAFT,
  // like the status map it extends, so staged ownership picks repaint
  // the primary too (paintOwnedRow calls paintPrimary).
  const primaryCfg = () => isWishlistBook(draft)
    ? { label: 'Mark owned', ic: 'owned', run: () => primaryMarkOwned() }
    : (PRIMARY[draft.status] || PRIMARY.tbr);
  const paintPrimary = () => {
    const cfg = primaryCfg();
    const btn = document.getElementById('m-primary');
    if (btn) btn.innerHTML = icon(cfg.ic) + ' ' + esc(cfg.label);
  };
  const primarySetStatus = (s) => {
    const from = b.status;
    if (from === s) return;
    // v455: trigger check — one-time gentle heads-up before starting a TBR
    // book that has content warnings. Never a gate: "Not now" just dismisses.
    // v459: enrich with accepted community trigger warnings first (flywheel).
    if (s === 'reading' && typeof triggerCheckNeeded === 'function') {
      (async () => {
        try { if (typeof window.ccEnrichWarnings === 'function') await window.ccEnrichWarnings(b); } catch (e) {}
        if (triggerCheckNeeded(b)) { openTriggerCheckSheet(b, () => primarySetStatus(s)); return; }
        primarySetStatusGo(s, from);
      })();
      return;
    }
    primarySetStatusGo(s, from);
  };
  const primarySetStatusGo = (s, from) => {
    b.status = s; draft.status = s;
    if (['reading', 'read', 'dnf'].includes(s)) upNextRemove(id);
    if (s === 'read' && b.pageCount && !b.previouslyRead) b.progress = b.pageCount;
    // v449: track rereads — completing a book that was already finished
    // increments readCount (enables the "An Old Friend" milestone).
    // dateFinished is set by the draft save flow, not here.
    if (s === 'read') {
      const wasRead = from === 'read' || (b.readCount || 0) > 0;
      b.readCount = wasRead ? (b.readCount || 1) + 1 : 1;
      draft.readCount = b.readCount;
    }
    saveLibrary();
    formState.commitValue('status', s); // Variant A: instant commit — bless the status field
    track('book_status_changed', { from: from, to: s });
    if (s === 'read') track('book_completed');
    // v468: post-completion portrait survey — fires on completion (User's call).
    if (s === 'read') { try { if (typeof maybeShowDnaSurvey === 'function') maybeShowDnaSurvey(b); } catch (e) {} }
    // v449: cozy phrasing — returning to a finished book is a "revisit"
    const isRevisit = s === 'reading' && (b.readCount || 0) >= 1;
    toast(s === 'reading' ? (isRevisit ? 'Happy revisiting ✨' : 'Happy reading ✨') : 'Back on the TBR');
    root.querySelectorAll('#f-status [data-s]').forEach(x => x.classList.toggle('active', x.dataset.s === s));
    paintShelfRow(); // v182: keep the tappable shelf row in sync
    paintPrimary();
    renderProgressSection();
  };
  // v559: the acquisition primary — mirrors primarySetStatusGo's
  // commit-and-repaint shape, but flips the ownership facet instead of
  // the status: the book stays on the TBR and leaves the Wishlist by
  // derivation (isWishlistBook, js/000).
  const primaryMarkOwned = () => {
    if (b.owned === 'owned') return;
    b.owned = 'owned'; draft.owned = 'owned';
    saveLibrary();
    formState.commitValue('owned', 'owned'); // Variant A: instant commit — bless the owned field
    root.querySelectorAll('#f-owned [data-o]').forEach(x => x.classList.toggle('active', x.dataset.o === 'owned'));
    paintOwnedRow(); // facet row label/icon + buy-wrap note follow
    const bw = document.getElementById('m-buywrap');
    if (bw) bw.style.display = 'none';
    paintPrimary();
    toast('Marked owned 📚');
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
    primaryCfg().run();
  });
  const moreBtn = document.getElementById('m-more');
  const moreMenu = document.getElementById('m-moremenu');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  });
  root.addEventListener('click', (e) => {
    if (!moreMenu.hidden && !e.target.closest('.more-wrap')) moreMenu.hidden = true;
    const ct = document.getElementById('m-covertools');
    if (ct && !ct.hidden && !e.target.closest('.cover-wrap')) ct.hidden = true;
  });

  // wire controls (work on the draft copy until Save)
  // Variant A: rating/axis taps STAGE into the draft under the one save
  // model — this deliberately reverses v224's live-commit (the decided
  // design: the bar is the single save model for the whole form, so a
  // rating tap raises the bar like every other edit, and Discard can
  // undo it). The ratingBefore snapshot still powers trackBookSaveDiff
  // at Save. Variant B would re-add a commit here — at the seam only.
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
        // v313: user rating replaces the detected baseline display
        bar.querySelectorAll('i').forEach((x, i) => {
          x.classList.toggle('f', i < nv);
          if (nv) x.classList.remove('det');
        });
        bar.setAttribute('aria-valuenow', nv);
        row.querySelector('.segnum').textContent = nv || '–';
        const a = axisByKey(k); // v132: level word follows the value
        // v313: once rated, the word is the user's level; clearing the
        // rating restores the detected baseline word if one exists.
        const detAfter = (k === 'spice' && !nv) ? spiceBaseValue() : 0;
        row.querySelector('.axword').innerHTML = nv ? esc(a.levels[nv - 1])
          : detAfter ? esc(a.levels[detAfter - 1]) + ' <span class="axdet-tag">(' +
            (spiceBaseline.source === 'manual' ? 'curated' : 'detected') + ')</span>'
          : 'Tap to rate';
        formState.touch(); // Variant A: staged — the bar counts it
      }));
      const rm = row.querySelector('[data-axrm]');
      if (rm) rm.addEventListener('click', () => {
        draft.axes = draft.axes.filter(x => x !== k);
        delete draft.ratings[k];
        renderAxSection();
        formState.touch(); // Variant A: staged — the bar counts it
      });
    });
    root.querySelectorAll('#f-axadd [data-axadd]').forEach(c => c.addEventListener('click', () => {
      draft.axes = draft.axes.concat(c.dataset.axadd);
      renderAxSection();
      formState.touch(); // Variant A: staged — the bar counts it
    }));
  };

  // v313: fetch the work-level spice baseline async — the modal renders
  // immediately and the spice row repaints when the data arrives. Never
  // blocks modal open; failures leave the row as-is.
  const loadSpiceBaseline = () => {
    try {
      if (typeof WorkStore === 'undefined' || !WorkStore || typeof WorkStore.getSpice !== 'function') return;
      // Only fetch when the spice axis is visible and unrated
      if (!draft.axes.includes('spice') || draft.ratings.spice) return;
      WorkStore.getSpice(b).then(res => {
        if (!res) return;
        const manual = res.manual, detected = res.detected;
        if (manual == null && detected == null) return;
        spiceBaseline = {
          detected, manual,
          source: manual != null ? 'manual' : 'detected',
        };
        // Repaint only if the user hasn't rated spice while we were fetching
        if (!draft.ratings.spice && document.getElementById('f-axrows')) renderAxSection();
      }).catch(() => {});
    } catch (e) {}
  };
  loadSpiceBaseline();

  // v402: fetch chapter-level metadata async for progressive disclosure.
  // Renders Spice Forecast sparkline + dialogue ratio only when data exists.
  // Also attaches trigger_chapters to the book for the warnings section.
  const loadChapterMeta = () => {
    try {
      if (typeof WorkStore === 'undefined' || !WorkStore || typeof WorkStore.getChapterMeta !== 'function') return;
      WorkStore.getChapterMeta(b).then(meta => {
        if (!meta) return;
        const box = document.getElementById('m-chaptermeta');
        // Attach trigger chapters to book so hcDetailHTML can use them on repaint
        if (meta.triggerChapters) {
          b.trigger_chapters = meta.triggerChapters;
          const hcEl = document.getElementById('m-hc');
          if (hcEl && typeof hcDetailHTML === 'function') hcEl.innerHTML = hcDetailHTML(b);
        }
        if (!box) return;
        let h = '';
        // Spice Forecast sparkline (inline SVG, no libs)
        if (meta.chapterSpice && meta.chapterSpice.length > 1) {
          h += spiceSparklineHTML(meta.chapterSpice);
        }
        // Dialogue ratio stat
        if (meta.avgDialogueRatio != null) {
          const pct = Math.round(meta.avgDialogueRatio * 100);
          h += '<div class="chaptermeta-row"><span class="chaptermeta-label">' + icon('quotes') + ' Dialogue</span>' +
            '<span class="chaptermeta-val">' + pct + '% dialogue</span></div>';
        }
        if (h) box.innerHTML = h;
      }).catch(() => {});
    } catch (e) {}
  };
  loadChapterMeta();

  // v182: mockup tappable rows — the row button expands the options; picking
  // one sets the draft value, repaints the row, and collapses.
  // v559: the buy-wrap's Wishlist note follows the DRAFT pair — staging
  // To buy on a TBR book shows it, staging Owned (or another shelf)
  // hides it, all before Save commits anything.
  const paintWishNote = () => {
    const n = document.getElementById('m-wishnote');
    if (n) n.hidden = !isWishlistBook(draft);
  };
  const paintShelfRow = () => {
    const m = STATUS_META[draft.status] || STATUS_META.tbr;
    const v = document.getElementById('f-status-val');
    const ic = document.getElementById('f-status-ic');
    if (v) v.textContent = m.label;
    if (ic) ic.innerHTML = icon(m.ic);
    paintWishNote();
  };
  const paintOwnedRow = () => {
    const m = OWNED_META[draft.owned] || OWNED_META.tobuy;
    const v = document.getElementById('f-owned-val');
    const ic = document.getElementById('f-owned-ic');
    const sum = document.getElementById('f-owned-sum');
    // v563: the row label and the section summary both show the
    // composed facet · format label.
    if (v) v.textContent = ownedLabel(draft);
    if (sum) sum.textContent = '· ' + ownedLabel(draft);
    if (ic) ic.innerHTML = icon(m.ic);
    paintWishNote();
    paintPrimary(); // v559: the acquisition primary follows the facet too
  };
  // v563: format + trophy-want painters. The want pick offers every
  // format EXCEPT the record's current one (want != format is refused
  // by construction — the chip is never rendered), and tapping the
  // active chip toggles the want off. With no format set there is
  // nothing to want a second of, so the pick shows a hint instead.
  const paintWantRow = () => {
    const box = document.getElementById('f-want-opts');
    const note = document.getElementById('f-want-note');
    if (!box) return;
    if (!FORMAT_META[draft.format]) {
      box.innerHTML = '';
      if (note) note.textContent = 'Set a format first — a trophy want is a second copy of a book you already have in one format.';
      return;
    }
    box.innerHTML = BOOK_FORMATS.filter(f => f !== draft.format).map(f =>
      '<button data-w="' + f + '" class="' + (draft.wantFormat === f ? 'active' : '') + '">' +
      icon(FORMAT_META[f].ic) + ' ' + FORMAT_META[f].label + '</button>').join('');
    box.querySelectorAll('[data-w]').forEach(btn => btn.addEventListener('click', () => {
      draft.wantFormat = draft.wantFormat === btn.dataset.w ? '' : btn.dataset.w;
      paintWantRow();
      formState.touch(); // Variant A: staged — the bar counts it
    }));
    if (note) note.textContent = draft.wantFormat
      ? 'Trophy want — this book sits in your Wishlist\u2019s Trophy wants until you mark it Got it. You have the ' + FORMAT_META[draft.format].label + ' copy.'
      : 'Tap a format to add this book to your Wishlist\u2019s Trophy wants — a second copy you\u2019re hunting.';
  };
  const paintFormatRow = () => {
    const fm = FORMAT_META[draft.format];
    const v = document.getElementById('f-format-val');
    const ic = document.getElementById('f-format-ic');
    if (v) v.textContent = fm ? fm.label : 'Not set';
    if (ic) ic.innerHTML = icon(fm ? fm.ic : 'help');
    root.querySelectorAll('#f-format [data-f]').forEach(x =>
      x.classList.toggle('active', x.dataset.f === (draft.format || '')));
    paintWantRow();
    paintOwnedRow(); // the composed label carries the format segment
  };
  paintWantRow();
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
      // v534: the shelf picker STAGES into the draft until Save. It used
      // to write b.status + saveLibrary() on tap (v353), so a pick the
      // user never saved leaked: the reopened modal showed the unsaved
      // status while the grid tag and header counts kept the old one.
      // Now a discarded pick changes nothing anywhere; Save commits it
      // (including the DNF reason prompt, below). The primary action
      // button still commits immediately — it's an action, not a picker.
      draft.status = btn.dataset.s;
      root.querySelectorAll('#f-status [data-s]').forEach(x => x.classList.toggle('active', x === btn));
      const pv = document.getElementById('f-prevwrap');
      if (pv) pv.style.display = draft.status === 'read' ? '' : 'none';
      if (draft.status === 'read' && !draft.dateFinished && !draft.previouslyRead) draft.dateFinished = new Date().toISOString();
      if (draft.status !== 'read') draft.dateFinished = null;
      if (draft.status === 'read' && draft.pageCount && !draft.previouslyRead) {
        draft.progress = draft.pageCount; // Save logs the completion delta
        const pi = document.getElementById('f-progress');
        if (pi) { pi.value = draft.progress; formState.commitValue('progressInput', pi.value); } // the pick wrote it mechanically — bless
      }
      paintShelfRow();
      const opts = btn.closest('.mrow-opts');
      if (opts) { opts.hidden = true; }
      const chev = btn.closest('.mselect').querySelector('.mrow-chev');
      if (chev) chev.textContent = '›';
      renderProgressSection();
      paintPrimary(); // v123: primary action follows the shelf
      formState.touch(); // Variant A: staged status — the bar counts it
    }));

  // v476: no manual price entry — f-purchase-price input removed.
  // draft.purchasePrice is preserved when previously set (read-only display).
  var ps = document.getElementById('f-purchase-source');
  var psc = document.getElementById('f-purchase-source-custom');
  if (ps) ps.addEventListener('change', e => {
    var v = e.target.value;
    if (v === '__other') {
      if (psc) psc.style.display = '';
      draft.purchaseSource = psc && psc.value ? psc.value : '';
    } else {
      if (psc) psc.style.display = 'none';
      draft.purchaseSource = v || null;
    }
    formState.touch(); // Variant A: staged — the bar counts it
  });
  if (psc) psc.addEventListener('input', e => {
    if (ps && ps.value === '__other') { draft.purchaseSource = e.target.value || null; formState.touch(); }
  });
  var pd = document.getElementById('f-purchase-date');
  if (pd) pd.addEventListener('change', e => {
    draft.purchaseDate = e.target.value || null;
    formState.touch(); // Variant A: staged — the bar counts it
  });
  const _faceoutEl = document.getElementById('f-faceout');
  if (_faceoutEl) _faceoutEl.addEventListener('change', e => {
    draft.faceOut = e.target.checked;
  });
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
    // Variant A: the handler moved the progress input mechanically —
    // bless that field; the checkbox itself is a tracked field and the
    // delegated change listener counts it.
    if (pi) formState.commitValue('progressInput', pi.value);
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
      formState.touch(); // Variant A: staged — the bar counts it
    }));

  // v563: format picker — same pick/collapse shape as ownership.
  root.querySelectorAll('#f-format [data-f]').forEach(btn =>
    btn.addEventListener('click', () => {
      draft.format = btn.dataset.f;
      // v563: the want != format guard, enforced at pick time — taking
      // the wanted format as the primary resolves the want.
      if (draft.wantFormat && draft.wantFormat === draft.format) draft.wantFormat = '';
      paintFormatRow();
      const opts = btn.closest('.mrow-opts');
      if (opts) { opts.hidden = true; }
      const chev = btn.closest('.mselect').querySelector('.mrow-chev');
      if (chev) chev.textContent = '›';
      formState.touch(); // Variant A: staged — the bar counts it
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
          formState.touch(); // Variant A: staged — the bar counts it
        }
      }));
  };
  wirePicker('#f-myrating', 'myRating');
  wireAxRows();
  // Variant A: the sticky Save bar — a pure view of ModalFormState.
  // It subscribes to the tracker and renders count(); it owns no state.
  // (The v224 focus/blur save-hint is gone: the bar + the dirty-close
  // prompt below are the legible risk surface now.)
  const saveBar = document.getElementById('m-savebar');
  const saveCountEl = document.getElementById('m-savecount');
  const renderSaveBar = () => {
    const n = formState.count();
    if (saveBar) saveBar.hidden = n === 0;
    if (saveCountEl) saveCountEl.textContent = n ? (n + ' unsaved change' + (n === 1 ? '' : 's')) : '';
  };
  formState.onChange(renderSaveBar);
  // Text inputs and selects report through one delegated pair of
  // listeners — recompute is idempotent, and inputs that aren't
  // registered fields (e.g. the quick page box) can't dirty anything.
  root.addEventListener('input', () => formState.touch());
  root.addEventListener('change', () => formState.touch());
  formState.arm();
  renderSaveBar();
  // Variant A: Discard = a true reset. Staged fields live only in the
  // draft + inputs, so a fresh render of the same book IS the reset
  // (instant commits — favourite, logged pages — stay committed).
  const discardBtn = document.getElementById('m-discard');
  if (discardBtn) discardBtn.addEventListener('click', () => renderDetailModal(b, false));

  const escClose = e => { if (e.key === 'Escape' && overlayIsTop(ovToken)) close(); }; // v129: escape closes, v220: topmost only
  // v220: DOM-only teardown — the history entry is owned by overlayOpened.
  const closeDom = () => {
    document.removeEventListener('keydown', escClose);
    unlockBodyScroll(); // v215: release the background scroll lock
    root.innerHTML = ''; editingId = null; editingDraft = null; refreshProgressSection = null;
  };
  const ovToken = overlayOpened('modal-root', closeDom); // v220: back-gesture closes the modal
  // Variant A: closing with a dirty form must NOT silently discard —
  // every user close path (×, backdrop tap, Escape, swipe-down) funnels
  // through close() and prompts first. Programmatic paths that already
  // know the answer pass force (the Delete flow; post-Save the tracker
  // is clean anyway). The Android back gesture goes through closeDom —
  // the history entry is already consumed by then — and keeps its v220
  // semantics; in-modal book-to-book navigation likewise stays as-is.
  let discardPromptOpen = false;
  const closeNow = () => { overlayClosed(ovToken); closeDom(); }; // v220: programmatic close consumes the entry
  const close = (force) => {
    if (force || !formState.isDirty()) { closeNow(); return; }
    if (discardPromptOpen) return;
    discardPromptOpen = true;
    // A swipe-down may have already translated the sheet off-screen —
    // reset it before prompting so the modal is visible behind the ask.
    const sheet = root.querySelector('#m-back .modal');
    if (sheet) { sheet.style.transition = ''; sheet.style.transform = ''; }
    const n = formState.count();
    confirmModal('You have ' + n + ' unsaved change' + (n === 1 ? '' : 's') + ' to “' + (b.title || 'this book') + '”. Discard them?',
      { okLabel: 'Discard', cancelLabel: 'Keep editing' })
      .then(ok => { discardPromptOpen = false; if (ok) closeNow(); });
  };
  document.addEventListener('keydown', escClose);
  root.querySelectorAll('[data-sim]').forEach(el => // v110: jump to a similar book
    el.addEventListener('click', () => openDetail(el.dataset.sim)));
  // NB: never bind close directly as an event listener — the event
  // object would land in the force parameter and skip the prompt.
  document.getElementById('m-x').addEventListener('click', () => close());
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
  // v329: character tab loader — calls shared module-level function
  root.querySelectorAll('[data-dtab="characters"]').forEach(btn =>
    btn.addEventListener('click', () => loadCharsTabForBook(b)));
  // v337: load memorable quotes for the Details tab
  loadQuotesForBook(b);
  // v541: shared-reading presence (js/235) — fills #m-rittoo when a
  // circle friend is visibly reading this book; silent otherwise.
  if (typeof fillReadingItToo === 'function') fillReadingItToo(b);
  document.getElementById('m-changecover').addEventListener('click', () => { coverTools.hidden = true; openCoverPicker(id); });
  // v274: guided multi-face edition scan (spine, sprayed edges, covers).
  document.getElementById('m-scanfaces').addEventListener('click', () => { coverTools.hidden = true; ecStartScan(id); });
  // v287: calibrated physical thickness capture using an ID-1 reference card.
  document.getElementById('m-measurethick').addEventListener('click', () => { coverTools.hidden = true; editionMeasureThickness(id); });
  // v279: 3D edition viewer (spine/covers/sprayed edges from scanned faces).
  document.getElementById('m-view3d').addEventListener('click', () => { coverTools.hidden = true; b3dOpenViewer(id); });
  // v210: edition picker — change which edition of the book she owns.
  document.getElementById('m-edition').addEventListener('click', () => openEditionPicker(id));
  document.getElementById('m-back').addEventListener('click', e => { if (e.target.id === 'm-back') close(); });
  // v215: bottom-sheet drag-to-dismiss (touch only) on the sheet element.
  wireSheetDrag(root.querySelector('#m-back .modal'), () => close());
  // v182: description read-more toggle — the single header copy now.
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
  // Variant A: the header slim bars (About / Book Portrait) expand in place.
  const wireSlimToggle = (btnId, bodyId) => {
    const btn = document.getElementById(btnId);
    const body = document.getElementById(bodyId);
    if (!btn || !body) return;
    btn.addEventListener('click', () => {
      body.hidden = !body.hidden;
      btn.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
      btn.classList.toggle('open', !body.hidden);
    });
  };
  wireSlimToggle('m-about-toggle', 'm-about-body');
  wireSlimToggle('m-portrait-toggle', 'm-portrait-body');
  // Variant A: the Cover pill opens the cover-tools menu.
  const coverPill = document.getElementById('m-coverpill');
  const coverTools = document.getElementById('m-covertools');
  if (coverPill && coverTools) {
    coverPill.addEventListener('click', (e) => {
      e.stopPropagation();
      coverTools.hidden = !coverTools.hidden;
    });
  }
  root.querySelectorAll('[data-author]').forEach(el =>
    el.addEventListener('click', () => openCollection('author', el.dataset.author, id)));
  // Variant A: the series strip (header zone) — paint owned + missing.
  if (b.series && b.series.name) { paintSeriesStrip(b); fillSeriesStrip(b); }
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
    formState.touch(); // Variant A: chip edits stage into the save model
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
    // Variant A: the auto-add is a contribution surface, not a user
    // edit — if the field was clean before the union, bless the union
    // so the bar doesn't rise for it. If she already edited, her edit
    // stays dirty (the union rides along with it to Save).
    const wasClean = !formState.isFieldDirty('tropes');
    const cur = inp.value.split(',').map(t => t.trim()).filter(Boolean);
    const have = new Set(cur.map(t => t.toLowerCase()));
    for (const t of (b.tropes || [])) {
      if (!have.has(String(t).toLowerCase())) { cur.push(t); have.add(String(t).toLowerCase()); }
    }
    inp.value = cur.join(', ');
    syncTropeChips();
    if (wasClean) formState.commitValue('tropes', formState.current('tropes'));
  });
  // v155: trope proposal UI removed (v401) — tropes are fully automated.

  // v182: mockup "Save note" — notes save immediately (like quotes), and the
  // draft stays in sync so the modal Save can't clobber them.
  document.getElementById('m-notesave').addEventListener('click', () => {
    const v = document.getElementById('f-notes').value;
    b.notes = v;
    draft.notes = v;
    saveLibrary();
    formState.commitValue('notes', v); // Variant A: composer committed — bless the notes field
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

  // v405 (M1): single favorite heart in the CTA row (f-fav2) + the ⋮ menu
  // entry. One toggle, all repaint.
  const paintFav = () => {
    const on = !!draft.favorite;
    const el = document.getElementById('f-fav2');
    if (el) el.classList.toggle('on', on);
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
      formState.touch(); // Variant A: the lookup stages a page-count edit
      toast('📄 Found: ' + n + ' pages');
    } else toast('No page count found for this ISBN');
  });

  const rmlog = document.getElementById('m-rmlog');
  if (rmlog) rmlog.addEventListener('click', async () => {
    const tk = dayKey(new Date());
    const e = (b.log || []).find(x => x.d === tk);
    const n = e ? Math.max(0, e.to - e.from) : 0;
    if (!n) return;
    // v352: in-app confirm
    const ok = await confirmModal('Remove today\u2019s log entry (' + n + ' pages) for \u201c' + b.title + '\u201d?', { okLabel: 'Remove' });
    if (!ok) return;
    b.log = (b.log || []).filter(x => x.d !== tk);
    draft.log = b.log;
    b.progress = draft.progress = e.from; // roll progress back to where the day started
    startProgress = e.from; // keep Save from re-logging the removed entry
    const pi = document.getElementById('f-progress');
    if (pi) pi.value = draft.progress;
    saveLibrary();
    formState.commitValue('progressInput', String(draft.progress)); // Variant A: committed — bless the field
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
  // v527: "Thought of you" — recommend this book to a circle friend
  // (js/232). The compose sheet opens over the modal via the coven
  // sheet stack; signed-out use gets the gentle toast inside.
  const toyItem = document.getElementById('m-toy');
  if (toyItem) toyItem.addEventListener('click', () => {
    moreMenu.hidden = true;
    if (typeof openToyCompose === 'function') openToyCompose(b, toyItem);
  });
  // v224 (UX-10): Share also sits in the primary row, next to the heart.
  document.getElementById('m-share2').addEventListener('click', () => shareBookCard(b.id));
  // v476: quiet metadata-diff badge → compare sheet
  const mdBtn = document.getElementById('m-metadiff');
  if (mdBtn) mdBtn.addEventListener('click', () => openMetaCompareSheet(b.id));
  // Variant A: the ONE commit path for the whole form — the bar's Save
  // button calls it. (Variant B/autosave would call it from a debounce
  // at the ModalFormState seam instead; no field code changes.)
  const commitDetailForm = () => {
    // v354: save edited title/author
    const newTitle = document.getElementById('f-title').value.trim();
    const newAuthors = document.getElementById('f-author').value.split(',').map(a => a.trim()).filter(Boolean);
    if (newTitle) draft.title = newTitle;
    draft.authors = newAuthors;
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
    const _foSave = document.getElementById('f-faceout');
    if (_foSave) draft.faceOut = _foSave.checked;
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
    draft._mtime = b._mtime; // P0 fix: the draft copied a stale _mtime at open; live edits
    // may have stamped b._mtime fresh since. Never overwrite it with the stale copy —
    // stampMtimes() in saveLibrary() will stamp fresh if content actually changed.
    // v453: same for owned — if the draft's value is missing/invalid (e.g. the
    // ownership row never rendered its options before Save), keep the book's
    // live value instead of clobbering it with undefined.
    if (!['owned', 'tobuy', 'borrowed', 'subscription'].includes(draft.owned)) {
      draft.owned = ['owned', 'tobuy', 'borrowed', 'subscription'].includes(b.owned) ? b.owned : 'tobuy';
    }
    // v563: same for the format pair — an invalid draft format keeps
    // the book's live value; a want that names the (possibly just
    // changed) primary format is not a want and unsets.
    if (!BOOK_FORMATS.includes(draft.format)) {
      draft.format = BOOK_FORMATS.includes(b.format) ? b.format : '';
    }
    if (!BOOK_FORMATS.includes(draft.wantFormat) || draft.wantFormat === draft.format) draft.wantFormat = '';
    const _aBefore = { // v118: snapshot for analytics diff (never book content)
      status: b.status, myRating: ratingBefore.myRating, title: b.title, notes: b.notes,
      releaseDate: b.releaseDate, tropes: (b.tropes || []).slice(),
      pageCount: b.pageCount, ratings: ratingBefore.ratings, // open-time snapshot (see ratingBefore)
    };
    Object.assign(b, draft);
    // Batch 4 (issue #148): title/author edits must bust the WorkStore cache —
    // without this, the spice baseline, trope intelligence, and chapter
    // metadata keep attaching to the OLD work for the rest of the session.
    try { if (typeof WorkStore !== 'undefined' && WorkStore.invalidate) WorkStore.invalidate(b); } catch (e) {}
    // v74: starting (or finishing) a book takes it off the Up Next queue —
    // it's no longer "next" once she's reading it.
    // v559: a wishlist book IS a TBR book now, so it is exactly what the
    // queue holds — no eviction for the derived shelf; the three
    // non-TBR statuses still evict.
    if (['reading', 'read', 'dnf'].includes(draft.status)) upNextRemove(id);
    var _becameRead = draft.status === 'read' && _aBefore.status !== 'read';
    formState.markSaved(); // Variant A: the tracker resets before close
    saveLibrary(); close(); render();
    trackBookSaveDiff(_aBefore, draft); // v118: status/rating/axis/edited events
    toast('Saved ✨');
    // v468: post-completion portrait survey (save-flow path to 'read').
    if (_becameRead) { try { if (typeof maybeShowDnaSurvey === 'function') maybeShowDnaSurvey(b); } catch (e) {} }
    // The Finale: if this save finished a series, mark the moment
    // (js/238 decides — library-complete + honest total — and presents
    // at most once per series). Fire-and-forget; never blocks the save.
    if (_becameRead) { try { if (typeof maybeFinaleCeremony === 'function') maybeFinaleCeremony(b); } catch (e) {} }
    // v534: DNF Autopsy prompt — follows the now-staged shelf pick, so
    // it fires on Save when the book newly lands on DNF (the pick-time
    // prompt went away with the picker's immediate save: an unsaved
    // DNF pick must not prompt for a reason).
    if (draft.status === 'dnf' && _aBefore.status !== 'dnf' && typeof openDnfReasonSheet === 'function') {
      try { openDnfReasonSheet(b); } catch (e) {}
    }
  };
  document.getElementById('m-save').addEventListener('click', commitDetailForm);

  document.getElementById('m-del').addEventListener('click', async () => {
    // v352: in-app confirm (native confirm blocks renderer)
    const ok = await confirmModal('Remove "' + b.title + '" from your shelves?', { okLabel: 'Remove' });
    if (!ok) return;
    removeBook(id);
    close(true); render(); // Variant A: the book is gone — no dirty prompt on top of Remove's own confirm
    toast('Removed');
  });

  // v418: theme-matched modal flairs (vine/corners/divider/garland/watermark).
  try { if (typeof ModalFlairs !== 'undefined') ModalFlairs.apply(); } catch (e) {}
  // v468: fill portrait async sections (characters, community tropes/warnings).
  try { if (typeof portraitEnhance === 'function') portraitEnhance(b); } catch (e) {}
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
   v473: provenance labels + tap-to-confirm replace the ▲▼ buttons
   (Part 1: no vote counts shown; throttled/offline votes queue quietly).
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
    const userTags = new Set((book.tropes || []).map(t => String(t).toLowerCase()));
    box.innerHTML = dbTropeChipsHTML(tropes, origin, votes, userTags);
    // v473: confirm/dispute — tapping an unconfirmed chip opens the row
    if (typeof TropeConfirm !== 'undefined') {
      box.querySelectorAll('[data-tid][tabindex]').forEach(chip => {
        const openRow = () => {
          TropeConfirm.open(box, {
            bookKey: key,
            tropeId: chip.getAttribute('data-tid'),
            onDone: () => renderDbTropeChips(book, onAutoAdd)
          });
        };
        chip.addEventListener('click', openRow);
        chip.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openRow(); }
        });
      });
    }
    try {
      if (typeof autoAddConfirmedTropes === 'function' &&
          autoAddConfirmedTropes(book, tropes) &&
          typeof onAutoAdd === 'function') onAutoAdd();
    } catch (e) {}
  } catch (e) {
    box.innerHTML = '<p class="note">No trope data yet.</p>';
  }
}
