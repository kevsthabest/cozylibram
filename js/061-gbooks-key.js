'use strict';

/* ---------------- Google Books API key (raise the quota) ---------------- */
// Without a key, Google Books draws from one anonymous quota shared by everyone,
// which can run dry (HTTP 429). A free personal key gives your own 1,000
// requests/day. Get one: Google Cloud Console → enable "Books API" → create an
// API key (restrict it to the Books API).
// v89: the key never reaches the browser. Requests go to the same-origin
// /api/gbooks proxy (Pages Function or server.py), which attaches the key
// server-side. /config.js only carries a boolean flag.
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export function gbReady() {
  try { return !!((window.SPICY_CONFIG && window.SPICY_CONFIG.gbooks)); }
  catch (e) { return false; }
}
// Rewrite a Google Books API URL to the same-origin proxy. Any client-side
// `key` param is stripped — the server attaches its own (or forwards the
// request anonymously when it has none).
export function gbProxyUrl(googleUrl) {
  try {
    const u = new URL(googleUrl);
    u.searchParams.delete('key');
    return '/api/gbooks' + u.pathname + (u.search ? u.search : '');
  } catch (e) { return googleUrl; }
}

// v243: provider_used analytics — which metadata backend served data, so
// Google Books reliance can be measured against the alternatives.
// Enum-only (no query text, no ISBNs); safe to call when track() is absent.
export function trackProvider(provider, context) {
  try { track('provider_used', { provider: provider, context: context }); } catch (e) {}
}

// v535 (UX P2-5): junk ISBNs — a "barcode" of one repeated digit
// (0000000000000 and friends). All-zeros even PASSES the ISBN-13
// checksum, and Google Books' loose q=isbn: match happily returns an
// unrelated classic for it ("The Robbers / Wallenstein"). No real
// ISBN is a single repeated digit, so these never reach the network
// or the shared cache: the lookup simply finds nothing.
export function isJunkIsbn(clean) {
  const d = String(clean || '').replace(/[^0-9X]/gi, '');
  return d.length >= 10 && /^(\d)\1+$/.test(d);
}

// ISBN lookup with the shared metadata cache in front: a cache hit returns
// instantly with zero API calls; a miss runs the normal API path and stores
// the result so the next user gets it from Supabase.
export async function lookupISBN(isbn) {
  const clean = String(isbn || '').replace(/[^0-9X]/gi, '');
  if (isJunkIsbn(clean)) return null;
  const snap = await metaCacheGet(clean);
  if (snap) { trackProvider('cache', 'isbn'); return bookFromMeta(snap, clean); }
  const book = await lookupISBNFromAPIs(clean);
  if (book && book.isbn) {
    // v192: key the canonical row by the ENTERED isbn, not the API-returned
    // edition isbn (Google Books may match a different edition than the one
    // typed) — re-entering the same isbn must always hit this row. Awaited
    // so the enriched upsert later in the add flow can't lose a write-write
    // race to this pre-enrichment snapshot.
    book._cacheKey = clean;
    await metaCachePut(clean, metaSnapshot(book)); // no longer fire-and-forget
  }
  return book;
}

export async function lookupISBNFromAPIs(isbn) {
  const clean = isbn.replace(/[^0-9X]/gi, '');
  if (isJunkIsbn(clean)) return null;
  try {
    const r = await apiFetch(gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(clean) + '&langRestrict=en'));
    const d = await r.json();
    if (d.items && d.items.length) { trackProvider('gbooks', 'isbn'); return enrichRatings(normalizeVolume(d.items[0], clean)); }
  } catch (e) { /* fall through to Open Library */ }
  // v244: Inventaire between Google Books and Open Library — its editions
  // are bootstrapped from the BnF by ISBN, so French/small-press ISBNs
  // Google Books misses often land here.
  try {
    const inv = await invLookupISBN(clean);
    if (inv) { trackProvider('inventaire', 'isbn'); return enrichRatings(inv); }
  } catch (e) { /* fall through to Open Library */ }
  try {
    const r = await fetch('https://openlibrary.org/search.json?q=' + encodeURIComponent(clean) +
      '&fields=title,author_name,cover_i,isbn,first_publish_year,ratings_average,ratings_count&limit=1');
    const d = await r.json();
    const doc = (d.docs || [])[0];
    if (doc) {
      const b = olDocToBook(doc);
      if (doc.ratings_average && doc.ratings_count) {
        b.publicRating = Math.round(doc.ratings_average * 10) / 10;
        b.ratingsCount = doc.ratings_count;
      }
      trackProvider('openlibrary', 'isbn');
      await enrichOLBook(b, b._olKey);
      return b;
    }
  } catch (e) { /* fall through to Hardcover */ }
  // v196: Hardcover as the fourth ISBN source — catches books Google Books,
  // Inventaire and Open Library don't know (indie / KU titles). Skipped for 12-digit UPCs:
  // those aren't ISBNs and no catalog maps them to a book. Typesense search
  // is fuzzy, so the doc's isbns[] must contain the scanned ISBN — a
  // near-miss title is worse than no match.
  if (typeof hcReady === 'function' && hcReady() && /^(?:\d{13}|\d{10}|\d{9}X)$/i.test(clean)) {
    try {
      const want13 = isbn13of(clean);
      const docs = await hcSearchDocs(clean);
      const hit = docs.find(d => (d.isbns || []).some(i => {
        const n = String(i).replace(/[^0-9X]/gi, '').toUpperCase();
        return n === clean || isbn13of(n) === want13;
      }));
      if (hit) { trackProvider('hardcover', 'isbn'); return hcDocToBook(hit); }
    } catch (e) { /* no match */ }
  }
  return null;
}

// v196: normalize an ISBN-10/13 to ISBN-13 for cross-source comparison.
export function isbn13of(s) {
  s = String(s || '').replace(/[^0-9X]/gi, '').toUpperCase();
  if (/^\d{13}$/.test(s)) return s;
  if (/^\d{9}[\dX]$/.test(s)) {
    const core = '978' + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1);
    return core + ((10 - (sum % 10)) % 10);
  }
  return s;
}

export async function searchBooks(q, source) {
  // v140: "All" tries Hardcover first (strongest catalog for these shelves),
  // then Google Books, then Open Library. In "All" mode only results that
  // resemble the query count — junk from one source never blocks the next.
  // Explicit single-source picks are unfiltered. Backward compatible:
  // existing callers pass no source and get the "All" waterfall.
  source = source || 'all';
  const toks = queryTokens(q);
  const gate = (books) => source === 'all' ? books.filter(b => resultMatchesQuery(b, toks)) : books;
  if (source === 'all' || source === 'hardcover') {
    const hc = gate(await hcSearchBooks(q));
    if (hc.length || source === 'hardcover') { trackProvider('hardcover', 'search'); return hc; }
  }
  if (source === 'all' || source === 'gbooks') {
    try {
      const r = await apiFetch(gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&langRestrict=en&maxResults=12'));
      const d = await r.json();
      if (d.items && d.items.length) { trackProvider('gbooks', 'search'); return d.items.map(v => normalizeVolume(v)); }
    } catch (e) { if (source === 'gbooks') throw e; /* fall through to Open Library */ }
    if (source === 'gbooks') { trackProvider('gbooks', 'search'); return []; }
  }
  if (source === 'all' || source === 'openlibrary') {
    const r = await fetch('https://openlibrary.org/search.json?q=' + encodeURIComponent(q) +
      '&fields=title,author_name,cover_i,isbn,first_publish_year&limit=12');
    const d = await r.json();
    const ol = gate((d.docs || []).map(olDocToBook));
    if (ol.length || source === 'openlibrary') { trackProvider('openlibrary', 'search'); return ol; }
  }
  return [];
}

// Significant words in the query (v138): 3+ chars, minus stopwords.
export function queryTokens(q) {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'by', 'in', 'on', 'to', 'for', 'with']);
  return String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !stop.has(w));
}
// At least half the query's significant words must appear in the title/author.
export function resultMatchesQuery(b, toks) {
  if (!toks.length) return true;
  const hay = ((b.title || '') + ' ' + (b.authors || []).join(' ')).toLowerCase();
  const hits = toks.filter(t => hay.indexOf(t) !== -1).length;
  return hits / toks.length >= 0.5;
}

// Map an Open Library search doc to our book shape (used when Google Books is
// unreachable — fewer fields, but enough to add the book).
export function olDocToBook(doc) {
  const isbn = ((doc.isbn || []).find(s => s.length === 13) || (doc.isbn || [])[0] || '').replace(/[^0-9X]/gi, '');
  const book = {
    id: uid(),
    isbn: isbn,
    title: doc.title || 'Unknown title',
    authors: doc.author_name || [],
    cover: doc.cover_i ? 'https://covers.openlibrary.org/b/id/' + doc.cover_i + '-L.jpg' : '',
    description: '',
    pageCount: null,
    publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
    categories: [],
    publicRating: null,
    ratingsCount: 0,
    status: 'tbr',
    owned: 'owned',
    ratings: {},
    myRating: 0,
    tropes: [],
    progress: 0,
    dateAdded: new Date().toISOString(),
    dateFinished: null,
    notes: '',
    _olKey: doc.key || null // work key for lazy enrichment on add; stripped before save
  };
  book.axes = autoDetectAxes(book);
  return book;
}

// Pull description + subjects for an Open Library-sourced book from its work
// record, then derive genre axes and starter trope tags from the subjects.
export async function enrichOLBook(book, workKey) {
  try {
    delete book._olKey;
    if (!workKey) return book;
    const r = await fetch('https://openlibrary.org' + workKey + '.json');
    const w = await r.json();
    let desc = w.description;
    if (desc && typeof desc === 'object') desc = desc.value;
    if (desc) {
      desc = String(desc).trim();
      book.description = desc.length > 2000 ? desc.slice(0, 2000) + '…' : desc;
    }
    if (Array.isArray(w.subjects) && w.subjects.length) {
      book.categories = w.subjects.slice(0, 10);
      book.axes = autoDetectAxes(book);
    }
    seedTropes(book);
  } catch (e) { /* keep the search-result data */ }
  return book;
}

export const TROPE_STOPWORDS = new Set(['general', 'fiction', 'nonfiction', 'large type', 'audiobooks', 'textbook', 'textbooks']);
// Seed editable starter tags from the book's genre/subject data.
export function seedTropes(book) {
  if (book.tropes && book.tropes.length) return;
  const tags = [];
  // v211: also consult the canonical format-junk set (js/020) — this is where
  // 'audiobook' (singular, from Open Library subjects) used to slip through.
  const junk = (typeof TROPE_FORMAT_JUNK !== 'undefined') ? TROPE_FORMAT_JUNK : TROPE_STOPWORDS;
  bookGenres(book).forEach(g => {
    const t = g.toLowerCase().trim();
    if (!t || t.length > 28 || TROPE_STOPWORDS.has(t) || junk.has(t) || tags.includes(t)) return;
    tags.push(t);
  });
  book.tropes = tags.slice(0, 6);
}


/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this file
   can see them. The consumers — js/060-metadata.js, js/070-hardcover.js,
   js/080-pagecount.js, js/092-metacache.js, js/130-add.js,
   js/135-vision.js, js/136-coverpicker.js, js/137-shelf.js,
   js/139-import-concierge.js, js/150-modal-discovery.js and
   js/161-tropelab.js — reach these names at runtime, so the bridge
   republishes exactly the pre-conversion public surface on window.
   Bare-name lookups in classic scripts resolve through the global object,
   so the caller needs no changes. Module scripts are deferred, so the
   bridge is in place before any consumer can run. Remove a name from this
   bridge only when its last classic caller is gone.
 */
window.gbReady = gbReady;
window.gbProxyUrl = gbProxyUrl;
window.trackProvider = trackProvider;
window.isJunkIsbn = isJunkIsbn;
window.lookupISBN = lookupISBN;
window.lookupISBNFromAPIs = lookupISBNFromAPIs;
window.isbn13of = isbn13of;
window.searchBooks = searchBooks;
window.queryTokens = queryTokens;
window.resultMatchesQuery = resultMatchesQuery;
window.olDocToBook = olDocToBook;
window.enrichOLBook = enrichOLBook;
window.TROPE_STOPWORDS = TROPE_STOPWORDS;
window.seedTropes = seedTropes;
