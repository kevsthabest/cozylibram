'use strict';

/* ---------------- Google Books API key (raise the quota) ---------------- */
// Without a key, Google Books draws from one anonymous quota shared by everyone,
// which can run dry (HTTP 429). A free personal key gives your own 1,000
// requests/day. Get one: Google Cloud Console → enable "Books API" → create an
// API key (restrict it to the Books API).
// v89: the key never reaches the browser. Requests go to the same-origin
// /api/gbooks proxy (Pages Function or server.py), which attaches the key
// server-side. /config.js only carries a boolean flag.
function gbReady() {
  try { return !!((window.SPICY_CONFIG && window.SPICY_CONFIG.gbooks)); }
  catch (e) { return false; }
}
function gbKeyStatusText() {
  if (gbReady()) return icon('owned') + ' Using server-side Google Books key ✓';
  return 'No key set — add GOOGLE_BOOKS_KEY (Pages env) or google_books_key (server-config.json).';
}
// Rewrite a Google Books API URL to the same-origin proxy. Any client-side
// `key` param is stripped — the server attaches its own (or forwards the
// request anonymously when it has none).
function gbProxyUrl(googleUrl) {
  try {
    const u = new URL(googleUrl);
    u.searchParams.delete('key');
    return '/api/gbooks' + u.pathname + (u.search ? u.search : '');
  } catch (e) { return googleUrl; }
}

// ISBN lookup with the shared metadata cache in front: a cache hit returns
// instantly with zero API calls; a miss runs the normal API path and stores
// the result so the next user gets it from Supabase.
async function lookupISBN(isbn) {
  const clean = String(isbn || '').replace(/[^0-9X]/gi, '');
  const snap = await metaCacheGet(clean);
  if (snap) return bookFromMeta(snap, clean);
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

async function lookupISBNFromAPIs(isbn) {
  const clean = isbn.replace(/[^0-9X]/gi, '');
  try {
    const r = await fetch(gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(clean) + '&langRestrict=en'));
    const d = await r.json();
    if (d.items && d.items.length) return enrichRatings(normalizeVolume(d.items[0], clean));
  } catch (e) { /* fall through to Open Library */ }
  try {
    const r = await fetch('https://openlibrary.org/search.json?q=' + encodeURIComponent(clean) +
      '&fields=title,author_name,cover_i,isbn,first_publish_year,ratings_average,ratings_count&limit=1');
    const d = await r.json();
    const doc = (d.docs || [])[0];
    if (!doc) return null;
    const b = olDocToBook(doc);
    if (doc.ratings_average && doc.ratings_count) {
      b.publicRating = Math.round(doc.ratings_average * 10) / 10;
      b.ratingsCount = doc.ratings_count;
    }
    await enrichOLBook(b, b._olKey);
    return b;
  } catch (e) { return null; }
}

async function searchBooks(q, source) {
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
    if (hc.length || source === 'hardcover') return hc;
  }
  if (source === 'all' || source === 'gbooks') {
    try {
      const r = await fetch(gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&langRestrict=en&maxResults=12'));
      const d = await r.json();
      if (d.items && d.items.length) return d.items.map(v => normalizeVolume(v));
    } catch (e) { if (source === 'gbooks') throw e; /* fall through to Open Library */ }
    if (source === 'gbooks') return [];
  }
  if (source === 'all' || source === 'openlibrary') {
    const r = await fetch('https://openlibrary.org/search.json?q=' + encodeURIComponent(q) +
      '&fields=title,author_name,cover_i,isbn,first_publish_year&limit=12');
    const d = await r.json();
    const ol = gate((d.docs || []).map(olDocToBook));
    if (ol.length || source === 'openlibrary') return ol;
  }
  return [];
}

// Significant words in the query (v138): 3+ chars, minus stopwords.
function queryTokens(q) {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'by', 'in', 'on', 'to', 'for', 'with']);
  return String(q || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !stop.has(w));
}
// At least half the query's significant words must appear in the title/author.
function resultMatchesQuery(b, toks) {
  if (!toks.length) return true;
  const hay = ((b.title || '') + ' ' + (b.authors || []).join(' ')).toLowerCase();
  const hits = toks.filter(t => hay.indexOf(t) !== -1).length;
  return hits / toks.length >= 0.5;
}

// Map an Open Library search doc to our book shape (used when Google Books is
// unreachable — fewer fields, but enough to add the book).
function olDocToBook(doc) {
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
async function enrichOLBook(book, workKey) {
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

const TROPE_STOPWORDS = new Set(['general', 'fiction', 'nonfiction', 'large type', 'audiobooks', 'textbook', 'textbooks']);
// Seed editable starter tags from the book's genre/subject data.
function seedTropes(book) {
  if (book.tropes && book.tropes.length) return;
  const tags = [];
  bookGenres(book).forEach(g => {
    const t = g.toLowerCase().trim();
    if (!t || t.length > 28 || TROPE_STOPWORDS.has(t) || tags.includes(t)) return;
    tags.push(t);
  });
  book.tropes = tags.slice(0, 6);
}

