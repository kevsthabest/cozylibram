'use strict';

/* ---------------- Google Books API key (raise the quota) ---------------- */
// Without a key, Google Books draws from one anonymous quota shared by everyone,
// which can run dry (HTTP 429). A free personal key gives your own 1,000
// requests/day. Get one: Google Cloud Console → enable "Books API" → create an
// API key (restrict it to the Books API). Stored on-device; the home server can
// also share it with LAN clients via server-config.json.
function gbServerKey() {
  try { return ((window.SPICY_CONFIG && window.SPICY_CONFIG.googleBooksKey) || '').trim(); }
  catch (e) { return ''; }
}
function gbManualKey() { return (localStorage.getItem('gbooks_key') || '').trim(); }
function gbKey() { return gbManualKey() || gbServerKey(); }
function gbKeyStatusText() {
  if (gbManualKey()) return 'API key saved ✓ (manual entry)';
  if (gbServerKey()) return '🏠 Using home-server key ✓';
  return 'No key set — using the shared anonymous quota.';
}
// Append the API key to a Google Books URL when we have one.
function gbUrl(base) {
  const k = gbKey();
  return k ? base + (base.indexOf('?') === -1 ? '?' : '&') + 'key=' + encodeURIComponent(k) : base;
}

async function lookupISBN(isbn) {
  const clean = isbn.replace(/[^0-9X]/gi, '');
  try {
    const r = await fetch(gbUrl('https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(clean)));
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

async function searchBooks(q) {
  try {
    const r = await fetch(gbUrl('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&maxResults=12'));
    const d = await r.json();
    if (d.items && d.items.length) return d.items.map(v => normalizeVolume(v));
  } catch (e) { /* fall through to Open Library */ }
  const r = await fetch('https://openlibrary.org/search.json?q=' + encodeURIComponent(q) +
    '&fields=title,author_name,cover_i,isbn,first_publish_year&limit=12');
  const d = await r.json();
  return (d.docs || []).map(olDocToBook);
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
    owned: true,
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

