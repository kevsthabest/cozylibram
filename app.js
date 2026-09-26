/* Spicy Shelves v1 — mobile-first personal library PWA.
   Storage: localStorage (on-device). Metadata: Google Books API + Open Library covers.
   No backend, no account, works from any static host. */

'use strict';

const LS_KEY = 'spicyshelves.library.v1';
const STATUS = {
  tbr: 'To Be Read',
  reading: 'Currently Reading',
  read: 'Read',
  dnf: 'Did Not Finish'
};

let view = 'library';
let filter = 'all';
let ownFilter = 'all'; // all | owned | tobuy
let query = '';
let calY = new Date().getFullYear();
let calM = new Date().getMonth();
let calSel = null; // selected calendar day 'YYYY-MM-DD'
let layout = 'list';
try { layout = localStorage.getItem('spicyshelves.layout') || 'list'; } catch (e) {}
let animateIn = true; // staggered card entrance; disabled while typing in search
let rouletteTimer = null; // slot-machine animation handle
let pickState = { genres: [], trope: '', minIntensity: 0 };
let addTab = 'scan';
let editingId = null;
let editingDraft = null; // live draft of the open book modal (for background fills)
let refreshProgressSection = null; // re-render fn for the open modal's progress section
let searchResults = [];
let scanState = { stream: null, timer: null, active: false, quagga: false };

/* ---------------- theming ---------------- */
const ACCENTS = [
  { key: 'rose',   name: 'Rose',   color: '#e5488f' },
  { key: 'violet', name: 'Violet', color: '#8b5cf6' },
  { key: 'gold',   name: 'Gold',   color: '#c08a24' },
  { key: 'teal',   name: 'Teal',   color: '#2fa39a' },
];
function getTheme() { return localStorage.getItem('theme') || 'dark'; }
function getAccent() { return localStorage.getItem('accent') || 'rose'; }
function applyTheme() {
  const t = getTheme(), a = getAccent();
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.accent = a;
  const mc = document.querySelector('meta[name="theme-color"]');
  if (mc) mc.setAttribute('content', t === 'light' ? '#faf5ec' : '#14101a');
}

/* ---------------- genre-aware ratings ---------------- */
// Different genres get different rating axes. Spice stays for romance;
// horror gets Scare, thrillers get Suspense, fantasy/sci-fi/LitRPG get Adventure.
const RATING_AXES = [
  { key: 'spice',     emoji: '🌶️', label: 'Spice',     genres: ['romance', 'erotica'] },
  { key: 'scare',     emoji: '👻', label: 'Scare',     genres: ['horror'] },
  { key: 'suspense',  emoji: '😰', label: 'Suspense',  genres: ['thriller', 'suspense', 'mystery', 'crime'] },
  { key: 'adventure', emoji: '⚔️', label: 'Adventure', genres: ['fantasy', 'science fiction', 'litrpg', 'dungeon', 'adventure'] },
];
function axisByKey(k) { return RATING_AXES.find(a => a.key === k) || RATING_AXES[0]; }

// Guess which axes fit a book from its genres, tropes and title. Falls back to spice.
function autoDetectAxes(b) {
  const hay = (bookGenres(b).join(' ') + ' ' + (b.tropes || []).join(' ') + ' ' + (b.title || '')).toLowerCase();
  const hit = RATING_AXES.filter(a => a.genres.some(g => hay.includes(g))).map(a => a.key);
  return hit.length ? hit : ['spice'];
}

// Migrate old books (b.spice) to the new { ratings, axes } model.
function migrateBook(b) {
  if (!b.ratings) b.ratings = {};
  if (b.spice) b.ratings.spice = b.spice;
  delete b.spice;
  if (!Array.isArray(b.authors)) b.authors = [];
  if (!Array.isArray(b.tropes)) b.tropes = [];
  if (!Array.isArray(b.axes) || !b.axes.length) b.axes = autoDetectAxes(b);
  if (!Array.isArray(b.contentWarnings)) b.contentWarnings = [];
  if (!Array.isArray(b.moods)) b.moods = [];
  if (b.series === undefined) b.series = null;
  if (!Array.isArray(b.log)) b.log = []; // daily reading log { d, from, to }
  b.favorite = !!b.favorite; // pinned to the favorites bookshelf
  if (b.owned === undefined) b.owned = true; // owned vs wishlist ("to buy")
  if (b._mtime == null) b._mtime = 0; // last-modified stamp, used for cloud conflict resolution
  return b;
}

// Ownership badge: 🏠 owned vs 🛒 to buy (wishlist)
function ownedBadge(b) {
  return b.owned
    ? '<span class="badge owned">🏠 Owned</span>'
    : '<span class="badge tobuy">🛒 To buy</span>';
}

/* ---------------- storefront links ("where to buy" for wishlist books) ---------------- */
// Region-aware retailer search links. ISBN is preferred (lands on the exact
// edition); falls back to title + author. No APIs or keys needed.
const STORE_REGIONS = {
  CA: { label: 'Canada', stores: [
    { name: 'Amazon', url: q => 'https://www.amazon.ca/s?k=' + encodeURIComponent(q) },
    { name: 'Indigo', url: q => 'https://www.indigo.ca/en-ca/search?q=' + encodeURIComponent(q) },
    { name: 'Kobo', url: q => 'https://www.kobo.com/ca/en/search?query=' + encodeURIComponent(q) },
  ] },
  US: { label: 'United States', stores: [
    { name: 'Amazon', url: q => 'https://www.amazon.com/s?k=' + encodeURIComponent(q) },
    { name: 'Barnes & Noble', url: q => 'https://www.barnesandnoble.com/s/' + encodeURIComponent(q) },
    { name: 'Bookshop.org', url: q => 'https://bookshop.org/search?keywords=' + encodeURIComponent(q) },
  ] },
  UK: { label: 'United Kingdom', stores: [
    { name: 'Amazon', url: q => 'https://www.amazon.co.uk/s?k=' + encodeURIComponent(q) },
    { name: 'Waterstones', url: q => 'https://www.waterstones.com/books/search/term/' + encodeURIComponent(q).replace(/%20/g, '+') },
    { name: 'Bookshop.org', url: q => 'https://bookshop.org/search?keywords=' + encodeURIComponent(q) },
  ] },
  AU: { label: 'Australia', stores: [
    { name: 'Amazon', url: q => 'https://www.amazon.com.au/s?k=' + encodeURIComponent(q) },
    { name: 'Booktopia', url: q => 'https://www.booktopia.com.au/search.ep?keywords=' + encodeURIComponent(q) },
  ] },
};
const STORE_REGION_KEYS = Object.keys(STORE_REGIONS);

function storeRegionSetting() {
  try { return localStorage.getItem('spicyshelves.storeRegion') || 'auto'; }
  catch (e) { return 'auto'; }
}

function detectStoreRegion() {
  const s = storeRegionSetting();
  if (STORE_REGIONS[s]) return s;
  // auto: device language first (en-CA -> CA), then timezone, then US
  try {
    const lang = String((typeof navigator !== 'undefined' && navigator.language) || '').toUpperCase();
    const m = lang.match(/-([A-Z]{2})$/);
    if (m) {
      if (STORE_REGIONS[m[1]]) return m[1];
      if (m[1] === 'GB') return 'UK';
    }
  } catch (e) {}
  try {
    const tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || '';
    if (/^(America\/(Halifax|Toronto|Montreal|Vancouver|Winnipeg|Edmonton|Regina|St_Johns)|Canada\/)/.test(tz)) return 'CA';
    if (tz === 'Europe/London') return 'UK';
    if (/^Australia\//.test(tz)) return 'AU';
  } catch (e) {}
  return 'US';
}

// What to search the storefront for: ISBN when we have one, else title + author.
function storeQuery(b) {
  const isbn = String(b.isbn || '').replace(/[^0-9X]/gi, '');
  if (isbn) return isbn;
  return [b.title, (b.authors || [])[0]].filter(Boolean).join(' ');
}

function storeLinks(b) {
  const q = storeQuery(b);
  return STORE_REGIONS[detectStoreRegion()].stores.map(s => ({ name: s.name, url: s.url(q) }));
}

// Badges for every rated axis, e.g. 🌶️🌶️🌶️ 👻👻
function ratingBadges(b) {
  return (b.axes || []).map(k => {
    const v = (b.ratings || {})[k] || 0;
    return v > 0 ? '<span class="badge spice">' + axisByKey(k).emoji.repeat(v) + '</span>' : '';
  }).join('');
}

// The book's "main" axis: first one with a rating, else first enabled axis.
function primaryAxisKey(b) {
  const axes = (b.axes && b.axes.length) ? b.axes : ['spice'];
  return axes.find(k => ((b.ratings || {})[k] || 0) > 0) || axes[0];
}

/* ---------------- storage ---------------- */
function loadLibrary() {
  try { return (JSON.parse(localStorage.getItem(LS_KEY)) || []).map(migrateBook); }
  catch (e) { return []; }
}
// Snapshots (excluding _mtime) so saveLibrary() can stamp only books that changed.
const bookSnapshots = new Map();
// NOTE: library loads here (not at the top of the file) because migrateBook can
// reach RATING_AXES/autoDetectAxes — both must be initialized first.
let library = loadLibrary();
loadSpineColorCache();
library.forEach(b => bookSnapshots.set(b.id, bookSnap(b)));
function bookSnap(b) {
  const c = {};
  Object.keys(b).sort().forEach(k => { if (k !== '_mtime') c[k] = b[k]; });
  return JSON.stringify(c);
}

// Daily reading log: one entry per book per day { d:'YYYY-MM-DD', from, to }.
// Logged on every page update (steppers, manual entry, mark-as-read).
function logPages(b, oldP, newP) {
  oldP = Number(oldP) || 0; newP = Number(newP) || 0;
  if (oldP === newP) return;
  if (!Array.isArray(b.log)) b.log = [];
  const k = dayKey(new Date());
  let e = b.log.find(x => x.d === k);
  if (!e) { e = { d: k, from: Math.min(oldP, newP), to: Math.max(oldP, newP) }; b.log.push(e); }
  else { e.from = Math.min(e.from, newP); e.to = Math.max(e.to, newP); }
  if (b.log.length > 730) b.log = b.log.slice(-730); // ~2 years cap
}
function pagesOnDay(b, k) {
  return (b.log || []).filter(e => e.d === k).reduce((s, e) => s + Math.max(0, e.to - e.from), 0);
}
function readingStreak() {
  const days = new Set();
  library.forEach(b => {
    (b.log || []).forEach(e => { if (e.to > e.from) days.add(e.d); });
    if (b.status === 'read' && b.dateFinished) days.add(dayKey(new Date(b.dateFinished)));
  });
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // streak alive if yesterday logged
  let s = 0;
  while (days.has(dayKey(d))) { s++; d.setDate(d.getDate() - 1); }
  return s;
}
function saveLibrary(opts) {
  opts = opts || {};
  const now = Date.now();
  for (const b of library) {
    const s = bookSnap(b);
    if (bookSnapshots.get(b.id) !== s) { b._mtime = now; bookSnapshots.set(b.id, bookSnap(b)); }
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(library)); }
  catch (e) { toast('Storage full — export a backup!'); }
  if (!opts.noCloud) scheduleCloudPush();
}

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function uid() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return ''; }
}
function toast(msg) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
function coverHTML(book, cls) {
  const inner = book.cover
    ? '<img src="' + esc(book.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
    : '📕';
  return '<div class="cover-wrap ' + (cls || '') + '">' + inner + '</div>';
}
function stars(n) {
  if (!n) return '';
  return '★'.repeat(Math.round(n)) + ' <span style="color:var(--faint)">' + Number(n).toFixed(1) + '</span>';
}

/* ---------------- metadata ---------------- */
function normalizeVolume(item, isbnHint) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const found = ids.find(i => i.type === 'ISBN_13') || ids.find(i => i.type === 'ISBN_10') || {};
  const isbn = (found.identifier || isbnHint || '').replace(/[^0-9X]/gi, '');
  let cover = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '';
  cover = cover.replace(/^http:\/\//, 'https://');
  if (!cover && isbn) cover = 'https://covers.openlibrary.org/b/isbn/' + isbn + '-L.jpg';
  const book = {
    id: uid(),
    isbn: isbn,
    title: v.title || 'Unknown title',
    authors: v.authors || [],
    cover: cover,
    description: v.description || '',
    pageCount: v.pageCount || null,
    publishedDate: v.publishedDate || '',
    categories: v.categories || [],
    publicRating: v.averageRating || null,
    ratingsCount: v.ratingsCount || 0,
    status: 'tbr',
    owned: true,
    ratings: {},
    myRating: 0,
    tropes: [],
    progress: 0,
    dateAdded: new Date().toISOString(),
    dateFinished: null,
    notes: ''
  };
  book.axes = autoDetectAxes(book);
  seedTropes(book);
  return book;
}

async function lookupISBN(isbn) {
  const clean = isbn.replace(/[^0-9X]/gi, '');
  try {
    const r = await fetch('https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(clean));
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
    const r = await fetch('https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&maxResults=12');
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

/* ---------------- Hardcover (series, content warnings, moods) ---------------- */
// Free GraphQL API: https://api.hardcover.app/v1/graphql
// Needs a personal token (hardcover.app → account settings → API), stored on-device.
const HC_API = 'https://api.hardcover.app/v1/graphql';
// Token the home server shares with LAN clients (server.py serves it only to
// internal IPs via /config.js). Manual entry in Settings always wins.
function hcServerToken() {
  try { return ((window.SPICY_CONFIG && window.SPICY_CONFIG.hardcoverToken) || '').trim(); }
  catch (e) { return ''; }
}
function hcManualToken() { return (localStorage.getItem('hc_token') || '').trim(); }
function hcToken() { return hcManualToken() || hcServerToken(); }
function hcStatusText() {
  if (hcManualToken()) return 'Token saved ✓ (manual entry)';
  if (hcServerToken()) return '🏠 Using home-server token ✓';
  return 'No token set.';
}

async function hcGraphQL(query) {
  const token = hcToken();
  if (!token) return null;
  const r = await fetch(HC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ query: query })
  });
  const d = await r.json();
  if (d.errors && d.errors.length) throw new Error(d.errors[0].message);
  return d.data;
}
function hcHits(data) {
  try { return data.search.results.hits || []; } catch (e) { return []; }
}

// Enrich a book with Hardcover data: series, content warnings, moods, genres, rating.
// Returns true when Hardcover had the book.
async function enrichHardcover(book) {
  if (!hcToken() || book.hcEnriched) return false;
  try {
    let doc = null;
    if (book.isbn) {
      const data = await hcGraphQL('query { search(query: "' + book.isbn + '", query_type: "Book", per_page: 5) { results } }');
      doc = hcHits(data).map(h => h.document).find(d =>
        d && (d.isbns || []).some(i => String(i).replace(/[^0-9X]/gi, '') === book.isbn)) || null;
    }
    if (!doc && book.title) {
      const q = book.title + ' ' + (book.authors[0] || '');
      const data = await hcGraphQL('query { search(query: ' + JSON.stringify(q) + ', query_type: "Book", per_page: 3) { results } }');
      const docs = hcHits(data).map(h => h.document).filter(Boolean);
      doc = docs.find(d => (d.title || '').toLowerCase().slice(0, 12) === book.title.toLowerCase().slice(0, 12)) || null;
    }
    if (!doc) return false;
    applyHardcoverDoc(book, doc);
    return true;
  } catch (e) { return false; }
}

function applyHardcoverDoc(book, doc) {
  if (Array.isArray(doc.content_warnings) && doc.content_warnings.length)
    book.contentWarnings = Array.from(new Set(doc.content_warnings.map(String)));
  const fs = doc.featured_series;
  if (fs && fs.series && fs.series.name) {
    book.series = { name: fs.series.name, position: (fs.position != null ? fs.position : (fs.details || null)) };
  } else if (Array.isArray(doc.series_names) && doc.series_names.length) {
    book.series = { name: doc.series_names[0], position: null };
  }
  if (Array.isArray(doc.moods) && doc.moods.length)
    book.moods = Array.from(new Set(doc.moods.map(String))).slice(0, 8);
  if (Array.isArray(doc.genres) && doc.genres.length) {
    const have = new Set((book.categories || []).map(c => String(c).toLowerCase()));
    doc.genres.forEach(g => {
      if (g && !have.has(String(g).toLowerCase())) { book.categories.push(g); have.add(String(g).toLowerCase()); }
    });
    book.axes = autoDetectAxes(book);
  }
  if (doc.rating && doc.ratings_count) {
    const n0 = book.ratingsCount || 0;
    if (book.publicRating && n0 > 0) {
      const total = n0 + doc.ratings_count;
      book.publicRating = Math.round(((book.publicRating * n0 + doc.rating * doc.ratings_count) / total) * 10) / 10;
      book.ratingsCount = total;
    } else {
      book.publicRating = Math.round(doc.rating * 10) / 10;
      book.ratingsCount = doc.ratings_count;
    }
  }
  if (!book.description && doc.description) book.description = String(doc.description);
  book.hcEnriched = true;
}

// Display-only Hardcover sections for the detail modal (series, moods, warnings).
function hcDetailHTML(b) {
  let h = '';
  if (b.series && b.series.name) {
    h += '<p class="series-line">📚 <button class="taplink" data-series="' + esc(b.series.name) + '">' +
      esc(b.series.name) + '</button>' +
      (b.series.position != null && b.series.position !== '' ? ' · Book ' + esc(String(b.series.position)) : '') + '</p>';
  }
  if (b.moods && b.moods.length) {
    h += '<div class="mood-row">' + b.moods.map(m => '<span class="mood-chip">' + esc(m) + '</span>').join('') + '</div>';
  }
  if (b.contentWarnings && b.contentWarnings.length) {
    h += '<details class="warnings"><summary>⚠️ Content warnings (' + b.contentWarnings.length + ')</summary><div class="warn-tags">' +
      b.contentWarnings.map(w => '<span class="warn-tag">' + esc(w) + '</span>').join('') + '</div></details>';
  }
  return h;
}

// Second public-rating signal from Open Library (free, no key), merged with the
// Google Books score via a count-weighted average. Falls back gracefully.
async function enrichRatings(book) {
  try {
    const q = book.isbn ? book.isbn : (book.title + ' ' + (book.authors[0] || '')).trim();
    if (!q) return book;
    const r = await fetch('https://openlibrary.org/search.json?q=' + encodeURIComponent(q) +
      '&fields=title,ratings_average,ratings_count&limit=1');
    const d = await r.json();
    const doc = (d.docs || [])[0];
    if (!doc || !doc.ratings_average || !doc.ratings_count) return book;
    // title-search sanity check: make sure OL found roughly the same book
    if (!book.isbn && doc.title &&
        doc.title.toLowerCase().slice(0, 12) !== book.title.toLowerCase().slice(0, 12)) return book;
    const oAvg = doc.ratings_average, oN = doc.ratings_count;
    const gAvg = book.publicRating, gN = book.ratingsCount || 0;
    if (gAvg && gN > 0) {
      const total = gN + oN;
      book.publicRating = Math.round(((gAvg * gN + oAvg * oN) / total) * 10) / 10;
      book.ratingsCount = total;
    } else {
      book.publicRating = Math.round(oAvg * 10) / 10;
      book.ratingsCount = oN;
    }
  } catch (e) { /* offline or OL hiccup — keep the Google Books data */ }
  return book;
}

function alreadyHave(book) {
  return library.some(b =>
    (book.isbn && b.isbn && b.isbn === book.isbn) ||
    (b.title.toLowerCase() === book.title.toLowerCase() &&
     (b.authors[0] || '').toLowerCase() === (book.authors[0] || '').toLowerCase())
  );
}

function addBook(book, openEditor) {
  if (alreadyHave(book)) { toast('Already on your shelves 📚'); return null; }
  library.unshift(book);
  saveLibrary();
  render();
  toast('Added to To Be Read ✨');
  if (openEditor) openDetail(book.id);
  // Background page-count fill — same pattern as Hardcover enrichment.
  if (!book.pageCount && book.isbn) {
    fillPageCount(book).then(ok => {
      if (!ok) return;
      if (editingId === book.id && editingDraft) {
        editingDraft.pageCount = book.pageCount;
        const inp = document.getElementById('f-pagecount');
        if (inp) inp.value = book.pageCount;
        if (refreshProgressSection) refreshProgressSection();
      } else render();
      toast('📄 Found page count: ' + book.pageCount);
    });
  }
  // Background Hardcover enrichment — lands a moment later without blocking the add.
  if (hcToken() && !book.hcEnriched) {
    enrichHardcover(book).then(ok => {
      if (!ok) return;
      saveLibrary();
      // Refresh only the Hardcover sections if the editor is open — never clobbers typed input.
      const hcEl = document.getElementById('m-hc');
      if (editingId === book.id && hcEl) hcEl.innerHTML = hcDetailHTML(book);
      else render();
      toast('✨ Enriched from Hardcover');
    });
  }
  return book;
}

/* ---------------- page-count lookup ---------------- */
// Fills total pages by ISBN when metadata didn't include it.
// Google Books ISBN-targeted query often hits a different edition record
// than title search; Open Library editions are the fallback.
async function fetchPageCountByISBN(isbn) {
  const clean = String(isbn || '').replace(/[^0-9X]/gi, '');
  if (!clean) return null;
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  };
  try {
    const data = await get('https://www.googleapis.com/books/v1/volumes?q=isbn:' + clean + '&maxResults=5');
    const items = (data.items || []).map(i => i.volumeInfo || {});
    const ids = it => (it.industryIdentifiers || []).map(x => String(x.identifier || '').replace(/[^0-9X]/gi, ''));
    const hit = items.find(it => it.pageCount > 0 && ids(it).includes(clean)) ||
      items.find(it => it.pageCount > 0);
    if (hit) return hit.pageCount;
  } catch (e) { /* fall through to Open Library */ }
  try {
    const ed = await get('https://openlibrary.org/isbn/' + clean + '.json');
    if (ed.number_of_pages > 0) return ed.number_of_pages;
    const s = await get('https://openlibrary.org/search.json?isbn=' + clean + '&fields=key&limit=10');
    for (const d of (s.docs || []).slice(0, 5)) {
      try {
        const e2 = await get('https://openlibrary.org' + d.key + '.json');
        if (e2.number_of_pages > 0) return e2.number_of_pages;
      } catch (e) { /* try next edition */ }
    }
  } catch (e) { /* give up */ }
  return null;
}

async function fillPageCount(book) {
  if (!book || book.pageCount > 0 || !book.isbn) return false;
  const n = await fetchPageCountByISBN(book.isbn);
  if (!n) return false;
  book.pageCount = n;
  saveLibrary();
  return true;
}

// Backfill every book missing a page count (Settings → Library tools).
async function backfillPageCounts(paceMs) {
  paceMs = paceMs == null ? 1200 : paceMs;
  const targets = library.filter(b => !(b.pageCount > 0) && b.isbn);
  if (!targets.length) { toast('All books already have page counts ✨'); return 0; }
  let found = 0;
  const note = document.getElementById('pc-backfill-note');
  for (let i = 0; i < targets.length; i++) {
    if (note) note.textContent = 'Looking up ' + (i + 1) + ' / ' + targets.length + '…';
    try { if (await fillPageCount(targets[i])) found++; } catch (e) { /* next */ }
    if (paceMs && i < targets.length - 1) await new Promise(r => setTimeout(r, paceMs));
  }
  if (note) note.textContent = 'Done — found page counts for ' + found + ' of ' + targets.length + ' books.';
  toast('📄 Found ' + found + ' page counts');
  render();
  return found;
}

/* ---------------- Cloud sync (Supabase, optional) ---------------- */
// Per-user long-term storage. Needs a Supabase project (see supabase/schema.sql).
// Credentials: the home server shares them with LAN clients via /config.js, or
// enter them manually in Settings → Account. The anon key is safe in the
// browser — Row Level Security ensures each user only sees their own rows.
const SB_LIB_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
let sbClient = null, sbClientCfg = '', cloudUser = null;
let cloudTimer = null, cloudLastSync = 0, cloudSyncing = false;

function cloudServerCfg() {
  try {
    const c = window.SPICY_CONFIG || {};
    return { url: (c.supabaseUrl || '').trim(), key: (c.supabaseAnonKey || '').trim() };
  } catch (e) { return { url: '', key: '' }; }
}
function cloudManualCfg() {
  return { url: (localStorage.getItem('sb_url') || '').trim(),
           key: (localStorage.getItem('sb_key') || '').trim() };
}
function cloudCfg() { const m = cloudManualCfg(); return (m.url && m.key) ? m : cloudServerCfg(); }
function cloudConfigured() { const c = cloudCfg(); return !!(c.url && c.key); }

function loadSupabaseLib() {
  return new Promise((resolve, reject) => {
    if (window.__sbStub) return resolve(); // tests
    if (window.supabase && window.supabase.createClient) return resolve();
    const s = document.createElement('script');
    s.src = SB_LIB_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Supabase library (are you online?)'));
    document.head.appendChild(s);
  });
}
async function cloudClient() {
  if (window.__sbStub) return window.__sbStub;
  if (!cloudConfigured()) return null;
  const c = cloudCfg(), k = c.url + '|' + c.key;
  if (sbClient && sbClientCfg === k) return sbClient;
  await loadSupabaseLib();
  sbClient = window.supabase.createClient(c.url, c.key);
  sbClientCfg = k;
  return sbClient;
}

function bookToRow(b, userId) {
  return { user_id: userId, book_id: b.id, isbn: b.isbn || null, data: b };
}
// Merge cloud rows into the local library. Newer _mtime wins conflicts.
function mergeCloudBooks(local, remoteRows) {
  const byId = new Map(local.map(b => [b.id, b]));
  let changed = false;
  for (const r of remoteRows) {
    if (!r || !r.book_id) continue;
    const lb = byId.get(r.book_id);
    const rd = migrateBook(Object.assign({}, r.data || {}));
    if (!lb) { local.push(rd); byId.set(r.book_id, rd); changed = true; }
    else if ((rd._mtime || 0) > (lb._mtime || 0)) { Object.assign(lb, rd); changed = true; }
  }
  return changed;
}

async function cloudPushNow() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser || cloudSyncing) return false;
  cloudSyncing = true;
  try {
    const rows = library.map(b => bookToRow(b, cloudUser.id));
    if (rows.length) {
      const { error } = await sb.from('books').upsert(rows, { onConflict: 'user_id,book_id' });
      if (error) throw error;
    }
    cloudLastSync = Date.now();
    return true;
  } catch (e) {
    toast('Cloud sync failed: ' + e.message);
    return false;
  } finally {
    cloudSyncing = false;
    refreshAccountUI();
  }
}
function scheduleCloudPush() {
  if (!cloudConfigured()) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => { cloudPushNow(); }, 2500);
}
async function cloudPullRows() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return [];
  const { data, error } = await sb.from('books').select('book_id,isbn,data');
  if (error) throw error;
  return data || [];
}
async function cloudFirstSync() {
  // After sign-in (or on boot with a session): pull, merge, push.
  if (!cloudUser) return;
  try {
    const remote = await cloudPullRows();
    if (mergeCloudBooks(library, remote)) { saveLibrary({ noCloud: true }); render(); }
    await cloudPushNow();
    toast('☁️ Library synced');
  } catch (e) { toast('Cloud sync failed: ' + e.message); }
}
async function cloudWipe() {
  const sb = await cloudClient().catch(() => null);
  if (!sb || !cloudUser) return;
  const { error } = await sb.from('books').delete().eq('user_id', cloudUser.id);
  if (error) toast('Cloud wipe failed: ' + error.message);
}

async function cloudSignUp(email, password) {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Add your Supabase project details first'); return; }
  const { data, error } = await sb.auth.signUp({ email: email, password: password });
  if (error) { toast('Sign up failed: ' + error.message); return; }
  if (data && data.session) toast('☁️ Account created — signed in');
  else toast('Account created — check your email to confirm, then sign in.');
}
async function cloudSignIn(email, password) {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Add your Supabase project details first'); return; }
  const { error } = await sb.auth.signInWithPassword({ email: email, password: password });
  if (error) { toast('Sign in failed: ' + error.message); return; }
  // onAuthStateChange fires SIGNED_IN → cloudFirstSync runs there.
}
async function cloudSignOut() {
  const sb = await cloudClient().catch(() => null);
  if (sb) await sb.auth.signOut().catch(() => {});
  toast('Signed out — your books stay on this device');
}
async function cloudGoogle() {
  const sb = await cloudClient().catch(() => null);
  if (!sb) { toast('Add your Supabase project details first'); return; }
  await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.href.split('#')[0] }
  });
}

async function initCloud() {
  if (!cloudConfigured()) return;
  try {
    const sb = await cloudClient();
    sb.auth.onAuthStateChange((event, session) => {
      cloudUser = (session && session.user) || null;
      if (event === 'SIGNED_IN') cloudFirstSync();
      refreshAccountUI();
    });
    const { data } = await sb.auth.getSession();
    cloudUser = (data && data.session && data.session.user) || null;
    if (cloudUser) await cloudFirstSync();
    refreshAccountUI();
  } catch (e) { /* offline or bad config — app keeps working locally */ }
}

function refreshAccountUI() {
  const st = document.getElementById('ac-status');
  if (!st) return; // settings not open
  const inEl = document.getElementById('ac-signedin');
  const outEl = document.getElementById('ac-signedout');
  if (!cloudConfigured()) {
    st.textContent = 'Cloud sync is off — add your Supabase project below (or let the home server share it).';
    if (inEl) inEl.style.display = 'none';
    if (outEl) outEl.style.display = '';
    return;
  }
  if (cloudUser) {
    st.textContent = '☁️ Signed in as ' + cloudUser.email;
    if (inEl) inEl.style.display = '';
    if (outEl) outEl.style.display = 'none';
    const last = document.getElementById('ac-last');
    if (last) last.textContent = cloudSyncing ? 'Syncing…' :
      (cloudLastSync ? 'Last synced ' + new Date(cloudLastSync).toLocaleString() : 'Not synced yet');
  } else {
    st.textContent = 'Not signed in.';
    if (inEl) inEl.style.display = 'none';
    if (outEl) outEl.style.display = '';
  }
}

/* ---------------- navigation ---------------- */
function go(v) {
  stopScan();
  if (rouletteTimer) { clearInterval(rouletteTimer); rouletteTimer = null; }
  view = v;
  animateIn = true;
  document.querySelectorAll('.bottom-nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.nav === v));
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.bottom-nav button').forEach(b =>
  b.addEventListener('click', () => go(b.dataset.nav)));

/* ---------------- library view ---------------- */
function filteredBooks() {
  const q = query.trim().toLowerCase();
  return library.filter(b => {
    if (filter !== 'all' && b.status !== filter) return false;
    if (ownFilter === 'owned' && !b.owned) return false;
    if (ownFilter === 'tobuy' && b.owned) return false;
    if (!q) return true;
    return (b.title + ' ' + b.authors.join(' ') + ' ' + b.tropes.join(' '))
      .toLowerCase().includes(q);
  });
}

function bookCard(b, i) {
  const badges = ['<span class="badge status-' + b.status + '">' + STATUS[b.status] + '</span>', ownedBadge(b)];
  if (b.publicRating) badges.push('<span class="badge">★ ' + Number(b.publicRating).toFixed(1) + '</span>');
  badges.push(ratingBadges(b));
  if (b.myRating > 0) badges.push('<span class="badge">' + '♥'.repeat(b.myRating) + '</span>');
  const anim = animateIn ? ' rise" style="--d:' + Math.min((i || 0) * 40, 400) + 'ms' : '';
  let progHTML = '';
  if (b.status === 'reading' && b.pageCount) {
    const pct = Math.max(0, Math.min(100, Math.round((b.progress || 0) / b.pageCount * 100)));
    progHTML = '<div class="progress-line slim"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<p class="card-progress">p. ' + (b.progress || 0) + ' / ' + b.pageCount + ' · ' + pct + '%</p>';
  }
  return '<div class="book-card' + anim + '" data-id="' + b.id + '">' +
    coverHTML(b) +
    '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
    '<p class="author">' + esc(b.authors.join(', ') || 'Unknown author') + '</p>' +
    '<div class="badges">' + badges.join('') + '</div>' + progHTML + '</div></div>';
}

function coverTile(b, i) {
  const short = { tbr: 'TBR', reading: 'Reading', read: 'Read', dnf: 'DNF' };
  const inner = b.cover
    ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
    : '📕';
  const anim = animateIn ? ' rise" style="--d:' + Math.min((i || 0) * 35, 420) + 'ms' : '';
  const pk = primaryAxisKey(b);
  const pv = (b.ratings || {})[pk] || 0;
  const ratingOverlay = pv > 0
    ? '<span class="tile-spice">' + axisByKey(pk).emoji + pv + '</span>' : '';
  return '<div class="cover-tile' + anim + '" data-id="' + b.id + '">' +
    '<div class="tile-cover">' + inner +
    '<span class="tile-status s-' + b.status + '">' + short[b.status] + '</span>' +
    (b.owned ? '' : '<span class="tile-buy" title="To buy">🛒</span>') +
    ratingOverlay +
    '</div>' +
    '<div class="tile-title">' + esc(b.title) + '</div>' +
    '<div class="tile-author">' + esc(b.authors.join(', ') || 'Unknown author') + '</div></div>';
}

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
// Dominant color of a cover image (darkened a touch so spine text stays readable).
// Falls back to null when the image can't be read (CORS-tainted canvas etc.).
function coverDominantColor(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
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
        if (!best) return resolve(null);
        const rgb = best.split(',').map(x => Math.round(Math.min(255, ((Number(x) << 5) + 16) * 0.82)));
        resolve('#' + rgb.map(x => x.toString(16).padStart(2, '0')).join(''));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
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
  let overlay = null;
  if (b.cover) {
    overlay = document.createElement('div');
    overlay.className = 'pull-overlay';
    overlay.innerHTML = '<img src="' + esc(b.cover) + '" alt="">';
    document.body.appendChild(overlay);
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('show')));
  }
  setTimeout(() => {
    if (overlay) overlay.remove();
    el.classList.remove('pulling');
    pullBusy = false;
    openDetail(id);
  }, b.cover ? 950 : 380);
}

function renderLibrary() {
  const books = filteredBooks();
  const counts = { tbr: 0, reading: 0, read: 0, dnf: 0 };
  library.forEach(b => { if (counts[b.status] != null) counts[b.status]++; });

  let html = favShelfHTML() + '<div class="toolbar"><input id="q" class="search" placeholder="Search title, author, trope…" value="' + esc(query) + '">' +
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
    c.addEventListener('click', () => openDetail(c.dataset.id)));
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

/* ---------------- add view ---------------- */
function renderAdd() {
  let html = '<h2 class="section serif">Add a book</h2>' +
    '<div class="tabs">' +
    tab('scan', '📷 Scan') + tab('search', '🔍 Search') + tab('isbn', '⌨️ ISBN') +
    '</div><div id="add-body"></div>';
  setView(html);
  document.querySelectorAll('.tabs button').forEach(b =>
    b.addEventListener('click', () => { addTab = b.dataset.t; stopScan(); renderAdd(); }));
  if (addTab === 'scan') renderScanTab();
  if (addTab === 'search') renderSearchTab();
  if (addTab === 'isbn') renderIsbnTab();
}
function tab(t, label) {
  return '<button data-t="' + t + '" class="' + (addTab === t ? 'active' : '') + '">' + label + '</button>';
}

function renderScanTab() {
  const body = document.getElementById('add-body');
  const insecure = !window.isSecureContext;
  body.innerHTML =
    '<div class="scan-box"><video id="scan-video" playsinline muted></video>' +
    '<div class="scan-hint">Point the camera at the barcode on the back cover</div></div>' +
    '<div id="scan-result"></div>' +
    '<button class="btn ghost block" id="scan-toggle">Start camera</button>' +
    '<button class="btn ghost block" id="scan-photo">📸 Snap a barcode photo</button>' +
    '<input type="file" id="scan-file" accept="image/*" capture="environment" style="display:none">' +
    (insecure ? '<p class="note">⚠️ Live camera needs a secure (HTTPS) connection — this page is on plain http://, so the browser blocks it. The photo button above works without it.</p>' : '') +
    '<p class="note">Tip: on a phone, install this as an app (Share → Add to Home Screen) for the full experience.</p>';
  const toggle = document.getElementById('scan-toggle');
  toggle.addEventListener('click', () => {
    if (scanState.active) stopScan();
    else startScan();
  });
  const file = document.getElementById('scan-file');
  document.getElementById('scan-photo').addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    if (file.files && file.files[0]) {
      const f = file.files[0];
      file.value = '';
      decodePhotoFile(f);
    }
  });
}

// Photo fallback: uses the camera app directly (no getUserMedia permission needed,
// works over plain http://), then decodes the barcode from the snapshot.
async function decodePhotoFile(file) {
  const mount = document.getElementById('scan-result') || document.getElementById('add-body');
  mount.innerHTML = '<p class="note">Reading barcode…</p>';
  try {
    const bmp = await createImageBitmap(file);
    if ('BarcodeDetector' in window) {
      try {
        const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        const codes = await det.detect(bmp);
        if (codes && codes.length) { onBarcode(codes[0].rawValue); return; }
      } catch (e) { /* fall through to quagga */ }
    }
    await loadQuagga();
    const url = URL.createObjectURL(file);
    Quagga.decodeSingle({
      src: url,
      numOfWorkers: 0,
      inputStream: { size: 1024 },
      decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'] },
      locate: true
    }, result => {
      URL.revokeObjectURL(url);
      const code = result && result.codeResult && result.codeResult.code;
      if (code) onBarcode(code);
      else { mount.innerHTML = ''; toast('No barcode found — try closer, in good light'); }
    });
  } catch (e) {
    mount.innerHTML = '';
    toast('Could not read that photo');
  }
}

async function startScan() {
  const video = document.getElementById('scan-video');
  const toggle = document.getElementById('scan-toggle');
  const result = document.getElementById('scan-result');
  if (!video) return;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Live camera needs HTTPS — use the photo button instead');
    return;
  }
  try {
    scanState.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    toast('Camera blocked — use the photo button, or Search/ISBN');
    return;
  }
  video.srcObject = scanState.stream;
  await video.play().catch(() => {});
  scanState.active = true;
  if (toggle) toggle.textContent = 'Stop camera';

  if ('BarcodeDetector' in window) {
    try {
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      scanState.timer = setInterval(async () => {
        if (!scanState.active) return;
        try {
          const codes = await det.detect(video);
          if (codes && codes.length) onBarcode(codes[0].rawValue);
        } catch (e) {}
      }, 600);
      return;
    } catch (e) { /* fall through to quagga */ }
  }
  // Fallback: Quagga2 via CDN
  try {
    await loadQuagga();
    startQuagga(video);
  } catch (e) {
    toast('Live scanning not supported here — use Search or ISBN');
  }
}

function onBarcode(raw) {
  const isbn = String(raw).replace(/[^0-9X]/gi, '');
  if (isbn.length < 10) return;
  stopScan();
  isbnLookupUI(isbn, document.getElementById('scan-result') || document.getElementById('add-body'));
}

function stopScan() {
  scanState.active = false;
  if (scanState.timer) { clearInterval(scanState.timer); scanState.timer = null; }
  if (scanState.stream) { scanState.stream.getTracks().forEach(t => t.stop()); scanState.stream = null; }
  stopQuagga();
  const toggle = document.getElementById('scan-toggle');
  if (toggle) toggle.textContent = 'Start camera';
  const video = document.getElementById('scan-video');
  if (video) video.srcObject = null;
}

function loadQuagga() {
  return new Promise((resolve, reject) => {
    if (window.Quagga) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function startQuagga(video) {
  if (!window.Quagga || !video) return;
  scanState.quagga = true;
  Quagga.init({
    inputStream: { name: 'Live', type: 'LiveStream', target: video.parentElement,
      constraints: { facingMode: 'environment' } },
    decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'] },
    locate: true
  }, err => {
    if (err) { scanState.quagga = false; return; }
    Quagga.start();
    Quagga.onDetected(d => {
      const code = d && d.codeResult && d.codeResult.code;
      if (code) onBarcode(code);
    });
  });
}
function stopQuagga() {
  if (scanState.quagga && window.Quagga) {
    try { Quagga.stop(); Quagga.offDetected(); } catch (e) {}
  }
  scanState.quagga = false;
}

async function isbnLookupUI(isbn, mount) {
  mount.innerHTML = '<p class="note">Looking up ' + esc(isbn) + '…</p>';
  try {
    const book = await lookupISBN(isbn);
    if (book) {
      mount.innerHTML = '<div class="result-card">' + coverHTML(book) +
        '<div class="book-meta"><h3>' + esc(book.title) + '</h3>' +
        '<p class="author">' + esc(book.authors.join(', ')) + '</p>' +
        (book.publicRating ? '<div class="pub-rating">' + stars(book.publicRating) + ' (' + book.ratingsCount + ' ratings)</div>' : '') +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn small" id="rc-add">Add to TBR</button>' +
        '<button class="btn small ghost" id="rc-edit">Add & edit details</button></div></div></div>';
      document.getElementById('rc-add').addEventListener('click', () => { addBook(book, false); mount.innerHTML = ''; });
      document.getElementById('rc-edit').addEventListener('click', () => { const b = addBook(book, false); if (b) openDetail(b.id); mount.innerHTML = ''; });
    } else {
      mount.innerHTML = '<div class="result-card">' +
        '<div class="book-meta"><h3>No match for ' + esc(isbn) + '</h3>' +
        '<p class="author">Neither Google Books nor Open Library knows this one.</p>' +
        '<button class="btn small ghost" id="rc-manual">Add it manually</button></div></div>';
      document.getElementById('rc-manual').addEventListener('click', () => {
        const shell = normalizeVolume({ volumeInfo: { title: '', authors: [] } }, isbn);
        const b = addBook(shell, false); if (b) openDetail(b.id);
      });
    }
  } catch (e) {
    mount.innerHTML = '<p class="note">Lookup failed — check your connection and try again.</p>';
  }
}

function renderSearchTab() {
  const body = document.getElementById('add-body');
  body.innerHTML =
    '<div class="search-row"><input id="s-q" class="text-input" placeholder="Title or author…" enterkeyhint="search">' +
    '<button class="btn" id="s-go">Go</button></div><div id="s-results" style="margin-top:12px"></div>';
  const input = document.getElementById('s-q');
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const box = document.getElementById('s-results');
    box.innerHTML = '<p class="note">Searching…</p>';
    try {
      searchResults = await searchBooks(q);
      if (!searchResults.length) { box.innerHTML = '<p class="note">No matches. Try different words.</p>'; return; }
      box.innerHTML = '<div class="grid">' + searchResults.map((b, i) =>
        '<div class="book-card" data-i="' + i + '">' + coverHTML(b) +
        '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
        '<p class="author">' + esc(b.authors.join(', ')) +
        (b.publishedDate ? ' · ' + esc(b.publishedDate.slice(0, 4)) : '') + '</p>' +
        (b.publicRating ? '<div class="pub-rating">' + stars(b.publicRating) + '</div>' : '') +
        '</div><div style="align-self:center"><button class="btn small">＋</button></div></div>'
      ).join('') + '</div>';
      box.querySelectorAll('.book-card').forEach(c =>
        c.addEventListener('click', async () => {
          const b = searchResults[Number(c.dataset.i)];
          const enriched = Object.assign({}, b, { id: uid() });
          if (!enriched._olKey) await enrichRatings(enriched); // Google-sourced: blend OL ratings
          await enrichOLBook(enriched, enriched._olKey); // OL-sourced: description/subjects/tropes
          const added = addBook(enriched, false);
          if (added) c.style.opacity = '0.4';
        }));
    } catch (e) {
      box.innerHTML = '<p class="note">Search failed — check your connection.</p>';
    }
  };
  document.getElementById('s-go').addEventListener('click', run);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

function renderIsbnTab() {
  const body = document.getElementById('add-body');
  body.innerHTML =
    '<div class="search-row"><input id="i-q" class="text-input" inputmode="numeric" placeholder="978…">' +
    '<button class="btn" id="i-go">Look up</button></div><div id="i-result"></div>' +
    '<p class="note">Paste a stack of ISBNs? Do them one at a time for now — bulk import is coming.</p>';
  const run = () => {
    const v = document.getElementById('i-q').value.trim();
    if (v.length < 10) { toast('That ISBN looks too short'); return; }
    isbnLookupUI(v, document.getElementById('i-result'));
  };
  document.getElementById('i-go').addEventListener('click', run);
  document.getElementById('i-q').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

/* ---------------- detail modal ---------------- */
/* ---- author / series collections: "more like this" from your own shelves ---- */
function collectionRowHTML(b) {
  const sub = (b.series && b.series.name
    ? '📚 ' + esc(b.series.name) +
      (b.series.position != null && b.series.position !== '' ? ' #' + esc(String(b.series.position)) : '') + ' · '
    : '') +
    esc((b.authors || []).join(', ') || 'Unknown author') + ' · ' + STATUS[b.status];
  return '<button class="crow" data-book="' + b.id + '">' +
    (b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
      : '<span class="cnocover">📕</span>') +
    '<span class="ctext"><b>' + esc(b.title) + '</b><small>' + sub + '</small></span>' +
    '<span class="cgo">›</span></button>';
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
    '<h2 class="serif" style="margin-top:0">' + (kind === 'author' ? '✍️ ' : '📚 ') + esc(name) + '</h2>' +
    '<p class="note">' + others.length + ' other book' + (others.length === 1 ? '' : 's') + ' on your shelves</p>' +
    (others.length
      ? '<div class="collection-list">' + others.map(collectionRowHTML).join('') + '</div>'
      : '<p class="note">Nothing else here yet — this is the only one.</p>') +
    '</div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#c-back').addEventListener('click', e => { if (e.target.id === 'c-back') close(); });
  ov.querySelector('#c-x').addEventListener('click', close);
  ov.querySelectorAll('[data-book]').forEach(el =>
    el.addEventListener('click', () => { close(); openDetail(el.dataset.book); }));
}

function openDetail(id) {
  const b = library.find(x => x.id === id);
  if (!b) return;
  editingId = id;
  const root = document.getElementById('modal-root');

  const segBtns = Object.keys(STATUS).map(s =>
    '<button data-s="' + s + '" class="' + (b.status === s ? 'active' : '') + '">' +
    ({ tbr: '📖 TBR', reading: '📘 Reading', read: '✅ Read', dnf: '🚫 DNF' })[s] + '</button>').join('');

  const hearts = [1, 2, 3, 4, 5].map(n =>
    '<button data-v="' + n + '" class="' + (b.myRating >= n ? 'on' : '') + '">❤️</button>').join('');

  // draft copy the controls edit until Save
  const draft = Object.assign({}, b, {
    tropes: (b.tropes || []).slice(),
    ratings: Object.assign({}, b.ratings),
    axes: (b.axes || []).slice()
  });
  if (!draft.axes.length) draft.axes = autoDetectAxes(draft);
  editingDraft = draft;

  // rating-type toggle chips + per-axis emoji pickers
  const axRowsHTML = () => draft.axes.map(k => {
    const a = axisByKey(k);
    const v = draft.ratings[k] || 0;
    const btns = [1, 2, 3, 4, 5].map(n =>
      '<button data-v="' + n + '" class="' + (v >= n ? 'on' : '') + '">' + a.emoji + '</button>').join('');
    return '<div class="axrow"><span>' + a.emoji + ' ' + a.label + '</span>' +
      '<div class="picker" data-ax="' + k + '">' + btns + '</div></div>';
  }).join('');
  const axChipsHTML = RATING_AXES.map(a =>
    '<button class="chip' + (draft.axes.includes(a.key) ? ' active' : '') + '" data-axchip="' + a.key + '">' +
    a.emoji + ' ' + a.label + '</button>').join('');

  // Quick page tracker for books being read: steppers save immediately.
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
      '<div class="stepper-row">' +
      ['−10', '−1', '+1', '+10'].map(d =>
        '<button class="btn ghost step" data-step="' + d.replace('−', '-') + '">' + d + '</button>').join('') +
      '</div></div>';
  };
  const renderProgressSection = () => {
    const el = document.getElementById('m-progress');
    if (!el) return;
    el.innerHTML = progressQuickHTML();
    el.querySelectorAll('[data-step]').forEach(btn =>
      btn.addEventListener('click', () => {
        const total = draft.pageCount || 0;
        const oldP = draft.progress || 0;
        const next = oldP + Number(btn.dataset.step);
        draft.progress = total ? Math.max(0, Math.min(total, next)) : Math.max(0, next);
        logPages(b, oldP, draft.progress);
        draft.log = b.log; // logPages may have created the array on b
        b.progress = draft.progress; // immediate save — no need to hit Save
        saveLibrary();
        const inp = document.getElementById('f-progress');
        if (inp) inp.value = draft.progress;
        renderProgressSection();
      }));
  };
  refreshProgressSection = renderProgressSection;

  root.innerHTML =
    '<div class="modal-backdrop" id="m-back"><div class="modal" role="dialog">' +
    '<button class="modal-close" id="m-x">✕</button>' +
    '<div class="modal-head">' + coverHTML(b) +
    '<div><h2>' + esc(b.title) + '</h2>' +
    '<p class="author">' + ((b.authors && b.authors.length)
      ? b.authors.map(a => '<button class="taplink" data-author="' + esc(a) + '">' + esc(a) + '</button>').join(', ')
      : 'Unknown author') + '</p>' +
    (b.publicRating ? '<div class="pub-rating">Public: ' + stars(b.publicRating) + ' · ' + b.ratingsCount + ' ratings</div>' : '<div class="pub-rating">No public rating found</div>') +
    (b.pageCount ? '<div class="pub-rating">' + b.pageCount + ' pages' + (b.publishedDate ? ' · ' + esc(b.publishedDate.slice(0, 4)) : '') + '</div>' : '') +
    '</div>' +
    '<button class="fav-btn' + (draft.favorite ? ' on' : '') + '" id="f-fav" aria-label="Toggle favorite">' + (draft.favorite ? '❤️' : '🤍') + '</button></div>' +
    (b.description ? '<div class="desc">' + b.description + '</div>' : '') +
    '<div id="m-hc">' + hcDetailHTML(b) + '</div>' +
    '<div id="m-progress"></div>' +

    '<div class="field"><label>Shelf</label><div class="seg" id="f-status">' + segBtns + '</div></div>' +

    '<div class="field"><label>Ownership</label><div class="seg" id="f-owned" style="grid-template-columns:1fr 1fr">' +
    '<button data-o="1" class="' + (draft.owned ? 'active' : '') + '">🏠 Owned</button>' +
    '<button data-o="0" class="' + (!draft.owned ? 'active' : '') + '">🛒 To buy</button></div></div>' +

    '<div class="field" id="m-buywrap" style="display:' + (draft.owned ? 'none' : '') + '">' +
    '<label>Where to buy <span class="note-inline">· ' + esc(STORE_REGIONS[detectStoreRegion()].label) + '</span></label>' +
    '<div class="buy-row">' + storeLinks(draft).map(l =>
      '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(l.url) + '">' + esc(l.name) + ' ↗</a>').join('') +
    '</div></div>' +

    '<div class="field"><label>Ratings</label>' +
    '<div class="chips" id="f-axes">' + axChipsHTML + '</div>' +
    '<div id="f-axrows">' + axRowsHTML() + '</div></div>' +
    '<div class="field"><label>My rating</label><div class="picker" id="f-myrating">' + hearts + '</div></div>' +

    '<div class="field"><label>Tropes (comma separated)</label>' +
    '<input id="f-tropes" class="text-input" placeholder="enemies to lovers, forced proximity…" value="' + esc(b.tropes.join(', ')) + '"></div>' +

    '<div class="field"><label>Total pages</label>' +
    '<div class="row-flex"><input id="f-pagecount" class="text-input" type="number" min="0" inputmode="numeric" placeholder="e.g. 384" value="' + (draft.pageCount || '') + '">' +
    (b.isbn ? '<button class="btn ghost" id="pc-lookup" title="Look up page count by ISBN">🔍</button>' : '') + '</div></div>' +
    '<div class="field"><label>Current page</label>' +
    '<input id="f-progress" class="text-input" type="number" min="0" inputmode="numeric" value="' + (draft.progress || 0) + '"></div>' +

    '<div class="field"><label>My notes</label>' +
    '<textarea id="f-notes" class="text-input" placeholder="Thoughts, quotes, warnings for future self…">' + esc(b.notes) + '</textarea></div>' +

    '<div class="modal-actions"><button class="btn ghost" id="m-del">Remove</button>' +
    '<button class="btn" id="m-save">Save</button></div>' +
    '</div></div>';

  // wire controls (work on the draft copy until Save)
  const wireAxRows = () => {
    root.querySelectorAll('#f-axrows [data-ax]').forEach(row => {
      const k = row.dataset.ax;
      row.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
        const v = Number(btn.dataset.v);
        draft.ratings[k] = (draft.ratings[k] === v) ? 0 : v; // tap again to clear
        row.querySelectorAll('button').forEach((x, i) =>
          x.classList.toggle('on', i < draft.ratings[k]));
      }));
    });
  };

  root.querySelectorAll('#f-status button').forEach(btn =>
    btn.addEventListener('click', () => {
      draft.status = btn.dataset.s;
      root.querySelectorAll('#f-status button').forEach(x => x.classList.toggle('active', x === btn));
      if (draft.status === 'read' && !draft.dateFinished) draft.dateFinished = new Date().toISOString();
      if (draft.status !== 'read') draft.dateFinished = null;
      if (draft.status === 'read' && draft.pageCount) {
        draft.progress = draft.pageCount; // Save logs the completion delta
        const pi = document.getElementById('f-progress');
        if (pi) pi.value = draft.progress;
      }
      renderProgressSection();
    }));

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
      }));
  };
  wirePicker('#f-myrating', 'myRating');
  wireAxRows();

  root.querySelectorAll('#f-axes [data-axchip]').forEach(c => c.addEventListener('click', () => {
    const k = c.dataset.axchip;
    if (draft.axes.includes(k)) {
      draft.axes = draft.axes.filter(x => x !== k);
      delete draft.ratings[k];
    } else {
      draft.axes = draft.axes.concat(k);
    }
    c.classList.toggle('active');
    document.getElementById('f-axrows').innerHTML = axRowsHTML();
    wireAxRows();
  }));

  const close = () => { root.innerHTML = ''; editingId = null; editingDraft = null; refreshProgressSection = null; };
  document.getElementById('m-x').addEventListener('click', close);
  document.getElementById('m-back').addEventListener('click', e => { if (e.target.id === 'm-back') close(); });
  root.querySelectorAll('[data-author]').forEach(el =>
    el.addEventListener('click', () => openCollection('author', el.dataset.author, id)));
  root.querySelectorAll('[data-series]').forEach(el =>
    el.addEventListener('click', () => openCollection('series', el.dataset.series, id)));
  renderProgressSection();

  document.getElementById('f-fav').addEventListener('click', () => {
    draft.favorite = !draft.favorite;
    b.favorite = draft.favorite; // immediate — no need to hit Save
    saveLibrary();
    const fb = document.getElementById('f-fav');
    fb.textContent = draft.favorite ? '❤️' : '🤍';
    fb.classList.toggle('on', draft.favorite);
    render(); // refresh the shelf behind the modal
    toast(draft.favorite ? 'Pinned to favorites ❤️' : 'Removed from favorites 🤍');
  });

  const lk = document.getElementById('pc-lookup');
  if (lk) lk.addEventListener('click', async () => {
    lk.disabled = true; lk.textContent = '…';
    const n = await fetchPageCountByISBN(b.isbn);
    lk.disabled = false; lk.textContent = '🔍';
    if (n) {
      draft.pageCount = n;
      document.getElementById('f-pagecount').value = n;
      renderProgressSection();
      toast('📄 Found: ' + n + ' pages');
    } else toast('No page count found for this ISBN');
  });

  document.getElementById('m-save').addEventListener('click', () => {
    draft.tropes = document.getElementById('f-tropes').value.split(',')
      .map(t => t.trim().toLowerCase()).filter(Boolean);
    draft.notes = document.getElementById('f-notes').value;
    const totalEl = document.getElementById('f-pagecount');
    draft.pageCount = Math.max(0, Number(totalEl.value) || 0) || null;
    const prog = document.getElementById('f-progress');
    const cap = draft.pageCount || Infinity;
    draft.progress = Math.max(0, Math.min(cap, Number(prog.value) || 0));
    if (!draft.title.trim()) draft.title = 'Untitled';
    logPages(b, b.progress, draft.progress);
    draft.log = b.log;
    Object.assign(b, draft);
    saveLibrary(); close(); render();
    toast('Saved ✨');
  });

  document.getElementById('m-del').addEventListener('click', () => {
    if (!confirm('Remove "' + b.title + '" from your shelves?')) return;
    library = library.filter(x => x.id !== id);
    saveLibrary(); close(); render();
    toast('Removed');
  });
}

/* ---------------- TBR roulette ---------------- */
// Genres come from the Google Books categories saved on each book,
// e.g. "Fiction / Romance / Contemporary" -> ["Romance", "Contemporary"].
function bookGenres(b) {
  const out = [];
  (b.categories || []).forEach(c => {
    String(c).split('/').map(s => s.trim()).forEach(s => {
      if (!s || /^(fiction|nonfiction|general)$/i.test(s)) return;
      if (!out.includes(s)) out.push(s);
    });
  });
  return out;
}

function tbrBooks() { return library.filter(b => b.status === 'tbr'); }

function allPickGenres() {
  const set = [];
  tbrBooks().forEach(b => bookGenres(b).forEach(g => { if (!set.includes(g)) set.push(g); }));
  return set.sort();
}

function pickCandidates() {
  const q = pickState.trope.trim().toLowerCase();
  return tbrBooks().filter(b => {
    if (pickState.genres.length && !bookGenres(b).some(g => pickState.genres.includes(g))) return false;
    if (q && !(b.tropes || []).join(' ').toLowerCase().includes(q)) return false;
    const pk = primaryAxisKey(b);
    if (((b.ratings || {})[pk] || 0) < pickState.minIntensity) return false;
    return true;
  });
}

function renderPick() {
  const tbr = tbrBooks();
  const genres = allPickGenres();
  const intensityOpts = [
    [0, 'Any'], [1, '💥+'], [2, '💥💥+'], [3, '💥💥💥+']
  ];

  let html = '<h2 class="section serif" style="font-size:26px">🎲 TBR Roulette</h2>' +
    '<p class="note">Can\'t decide what to read next? Set your mood, spin the wheel, and let fate choose.</p>';

  if (!tbr.length) {
    html += '<div class="empty"><div class="big">🎲</div><h2 class="serif">Your TBR is empty</h2>' +
      '<p>Add some books first,<br>then come back and spin.</p>' +
      '<button class="btn" data-nav="add">Add books</button></div>';
    setView(html);
    const btn = document.querySelector('#view [data-nav="add"]');
    if (btn) btn.addEventListener('click', () => go('add'));
    return;
  }

  html += '<div class="pick-filters">';
  if (genres.length) {
    html += '<div class="stat-sub">Genre</div><div class="chips">' +
      genres.map(g => '<button class="chip' + (pickState.genres.includes(g) ? ' active' : '') +
        '" data-g="' + esc(g) + '">' + esc(g) + '</button>').join('') + '</div>';
  }
  html += '<div class="stat-sub">Trope or tag</div>' +
    '<input id="pk-trope" class="text-input" placeholder="e.g. enemies to lovers, dragons…" value="' + esc(pickState.trope) + '">' +
    '<div class="stat-sub">How intense?</div><div class="chips">' +
    intensityOpts.map(([v, l]) => '<button class="chip' + (pickState.minIntensity === v ? ' active' : '') +
      '" data-s="' + v + '">' + l + '</button>').join('') + '</div>';
  html += '</div>';

  html += '<p class="note" id="pick-count"></p>' +
    '<button class="btn pick-btn" id="pk-spin">🎲 Pick my next read</button>' +
    '<div id="roulette-result" style="margin-top:18px"></div>';

  setView(html);
  updatePickCount();

  document.querySelectorAll('#view [data-g]').forEach(c => c.addEventListener('click', () => {
    const g = c.dataset.g;
    pickState.genres = pickState.genres.includes(g)
      ? pickState.genres.filter(x => x !== g)
      : pickState.genres.concat(g);
    c.classList.toggle('active');
    updatePickCount();
  }));
  document.querySelectorAll('#view [data-s]').forEach(c => c.addEventListener('click', () => {
    pickState.minIntensity = Number(c.dataset.s);
    document.querySelectorAll('#view [data-s]').forEach(x => x.classList.toggle('active', x === c));
    updatePickCount();
  }));
  document.getElementById('pk-trope').addEventListener('input', e => {
    pickState.trope = e.target.value;
    updatePickCount();
  });
  document.getElementById('pk-spin').addEventListener('click', runRoulette);
}

function updatePickCount() {
  const el = document.getElementById('pick-count');
  if (!el) return;
  const n = pickCandidates().length;
  el.innerHTML = n
    ? '<b style="color:var(--gold)">' + n + '</b> book' + (n === 1 ? '' : 's') + ' match your mood'
    : 'No TBR books match — loosen the filters a little.';
  const btn = document.getElementById('pk-spin');
  if (btn) btn.disabled = !n;
}

function runRoulette() {
  const candidates = pickCandidates();
  if (!candidates.length) { toast('No matching books 🎲'); return; }
  if (rouletteTimer) clearInterval(rouletteTimer);

  const box = document.getElementById('roulette-result');
  const btn = document.getElementById('pk-spin');
  if (btn) btn.disabled = true;

  box.innerHTML = '<div class="slot"><div class="slot-cover" id="slot-cover"></div>' +
    '<div class="slot-title" id="slot-title"></div></div>';
  const coverEl = document.getElementById('slot-cover');
  const titleEl = document.getElementById('slot-title');

  let ticks = 0;
  const total = 16;
  rouletteTimer = setInterval(() => {
    const b = candidates[Math.floor(Math.random() * candidates.length)];
    coverEl.innerHTML = b.cover
      ? '<img src="' + esc(b.cover) + '" alt="" onerror="this.remove()">'
      : '📕';
    titleEl.textContent = b.title;
    if (++ticks >= total) {
      clearInterval(rouletteTimer);
      rouletteTimer = null;
      // Fisher-Yates pick
      const pool = candidates.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      showWinner(pool[0]);
      if (btn) btn.disabled = false;
    }
  }, 90);
}

function showWinner(b) {
  const box = document.getElementById('roulette-result');
  const genres = bookGenres(b);
  const pills = genres.map(g => '<span class="badge">' + esc(g) + '</span>').join('') +
    ratingBadges(b) +
    (b.tropes || []).slice(0, 4).map(t => '<span class="badge">🏷️ ' + esc(t) + '</span>').join('');
  box.innerHTML = '<div class="winner">' +
    '<div class="stat-sub" style="margin-top:0">Fate has spoken ✨</div>' +
    '<div class="winner-cover">' + (b.cover
      ? '<img src="' + esc(b.cover) + '" alt="" onerror="this.remove()">'
      : '📕') + '</div>' +
    '<h3 class="serif">' + esc(b.title) + '</h3>' +
    '<p class="author">' + esc(b.authors.join(', ') || 'Unknown author') + '</p>' +
    (b.description ? '<p class="winner-desc">' + esc(b.description.slice(0, 220)) +
      (b.description.length > 220 ? '…' : '') + '</p>' : '') +
    '<div class="badges" style="justify-content:center">' + pills + '</div>' +
    '<div class="winner-actions">' +
    '<button class="btn" id="w-start">📖 Start reading</button>' +
    '<button class="btn ghost" id="w-again">🎲 Again</button>' +
    '<button class="btn ghost" id="w-detail">🔍 Details</button>' +
    '</div></div>';

  document.getElementById('w-start').addEventListener('click', () => {
    b.status = 'reading';
    saveLibrary();
    toast('Happy reading! 📖');
    filter = 'reading';
    go('library');
  });
  document.getElementById('w-again').addEventListener('click', runRoulette);
  document.getElementById('w-detail').addEventListener('click', () => openDetail(b.id));
}

/* ---------------- stats view ---------------- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const dayKey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
  '-' + String(d.getDate()).padStart(2, '0');

function dayActivity() {
  // dayKey -> [{ b, from, to, finished }]; log entries first, finish dates fill gaps
  const map = {};
  const add = (k, e) => { (map[k] = map[k] || []).push(e); };
  library.forEach(b => {
    (b.log || []).forEach(e => {
      if (e.to > e.from) add(e.d, { b: b, from: e.from, to: e.to, finished: false });
    });
    if (b.status === 'read' && b.dateFinished) {
      const k = dayKey(new Date(b.dateFinished));
      if (!(map[k] || []).some(x => x.b === b)) add(k, { b: b, from: null, to: null, finished: true });
    }
  });
  return map;
}

function readingCalHTML() {
  const byDay = dayActivity();
  const blanks = new Date(calY, calM, 1).getDay();
  const days = new Date(calY, calM + 1, 0).getDate();
  const todayK = dayKey(new Date());
  const kk = d => calY + '-' + String(calM + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  let cells = '';
  for (let i = 0; i < blanks; i++) cells += '<div class="cal-day blank"></div>';
  for (let d = 1; d <= days; d++) {
    const k = kk(d);
    const acts = byDay[k] || [];
    const n = acts.length;
    const cls = 'cal-day' + (n ? ' has' : '') + (k === todayK ? ' today' : '') + (k === calSel ? ' sel' : '');
    cells += '<div class="' + cls + '" data-day="' + k + '"><span class="d">' + d + '</span>' +
      (n ? '<span class="ccover">' +
        (acts[0].b.cover
          ? '<img src="' + esc(acts[0].b.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
          : '📕') +
        (n > 1 ? '<span class="cdot">' + n + '</span>' : '') + '</span>' : '') + '</div>';
  }
  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => '<div class="cal-dow">' + x + '</div>').join('');

  let listHTML = '';
  if (calSel) {
    const acts = (byDay[calSel] || []).slice().sort((x, y) => x.b.title.localeCompare(y.b.title));
    const dayPages = acts.reduce((s, a) => s + (a.finished ? 0 : a.to - a.from), 0);
    listHTML = acts.length
      ? '<div class="stat-sub" style="margin-top:12px">' + fmtDate(new Date(calSel + 'T12:00:00').toISOString()) +
        ' — ' + dayPages + ' pages</div>' +
        acts.map(a => {
          const pages = a.finished ? 0 : a.to - a.from;
          const pct = (!a.finished && a.b.pageCount) ? ' (' + Math.round(pages / a.b.pageCount * 100) + '%)' : '';
          return '<div class="cal-book" data-id="' + a.b.id + '">' + coverHTML(a.b) +
            '<div><h4>' + esc(a.b.title) + '</h4>' +
            (a.finished ? '<p>Finished 🎉</p>'
              : '<p>p. ' + a.from + ' → p. ' + a.to + '</p><p>+' + pages + ' pages' + pct + '</p>') +
            '</div></div>';
        }).join('')
      : '<p class="note">Nothing read that day.</p>';
  }

  const noDate = library.filter(b => b.status === 'read' && !b.dateFinished).length;

  return '<div class="stat-sub">Reading calendar</div>' +
    '<div class="cal-head"><button class="btn ghost" id="cal-prev">‹</button>' +
    '<h3>' + MONTHS[calM] + ' ' + calY + '</h3>' +
    '<button class="btn ghost" id="cal-next">›</button></div>' +
    '<div class="cal-grid" id="readcal">' + dow + cells + '</div>' +
    '<div id="cal-books">' + listHTML + '</div>' +
    (noDate ? '<p class="note">' + noDate + ' finished book' + (noDate > 1 ? 's have' : ' has') + ' no finish date.</p>' : '');
}

function dailyStatsHTML() {
  const k = dayKey(new Date());
  const rows = [];
  let total = 0;
  library.forEach(b => {
    const p = pagesOnDay(b, k);
    if (p > 0) { total += p; rows.push({ b: b, p: p }); }
  });
  rows.sort((a, b) => b.p - a.p);
  const streak = readingStreak();
  return '<div class="stat-sub">Today</div>' +
    '<div class="dstat-card">' +
    '<div class="dstat-head"><span>📅 ' + fmtDate(new Date().toISOString()) + '</span>' +
    (streak > 1 ? '<span class="streak">🔥 ' + streak + '-day streak</span>' : '') + '</div>' +
    (rows.length
      ? '<div class="dstat-total">' + total + ' page' + (total === 1 ? '' : 's') + ' read</div>' +
        rows.map(r => {
          const es = (r.b.log || []).filter(x => x.d === k);
          const from = Math.min.apply(null, es.map(x => x.from));
          const to = Math.max.apply(null, es.map(x => x.to));
          const pct = r.b.pageCount ? ' (' + Math.round(r.p / r.b.pageCount * 100) + '%)' : '';
          return '<div class="cal-book" data-id="' + r.b.id + '">' + coverHTML(r.b) +
            '<div><h4>' + esc(r.b.title) + '</h4><p>p. ' + from + ' → p. ' + to + '</p>' +
            '<p>+' + r.p + ' pages' + pct + '</p></div></div>';
        }).join('')
      : '<p class="note">No pages logged yet today — open a book and tap those steppers! 📖</p>') +
    '</div>';
}

function renderStats() {
  const yr = new Date().getFullYear();
  const read = library.filter(b => b.status === 'read');
  const readYr = read.filter(b => b.dateFinished && new Date(b.dateFinished).getFullYear() === yr);
  const pages = read.reduce((s, b) => s + (b.pageCount || 0), 0);
  const avgOf = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const axisAvgs = RATING_AXES.map(a => {
    const vals = read.map(b => (b.ratings || {})[a.key] || 0).filter(v => v > 0);
    return { a: a, avg: avgOf(vals), n: vals.length };
  }).filter(x => x.avg != null);
  const topAxis = axisAvgs.slice().sort((x, y) => y.n - x.n)[0];
  const avgMine = avgOf(read.filter(b => b.myRating > 0).map(b => b.myRating));

  const tropeCount = {};
  library.forEach(b => (b.tropes || []).forEach(t => { tropeCount[t] = (tropeCount[t] || 0) + 1; }));
  const topTropes = Object.entries(tropeCount).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const counts = { tbr: 0, reading: 0, read: 0, dnf: 0 };
  library.forEach(b => { if (counts[b.status] != null) counts[b.status]++; });
  const max = Math.max(1, counts.tbr, counts.reading, counts.read, counts.dnf);
  const barColor = { tbr: 'var(--gold)', reading: '#6aa8e5', read: 'var(--ok)', dnf: 'var(--danger)' };
  const distRows = Object.keys(STATUS).map(s =>
    '<div class="dist-row"><span class="lbl">' + STATUS[s] + '</span>' +
    '<div class="bar"><div class="fill" style="width:' + Math.round(counts[s] / max * 100) + '%;background:' + barColor[s] + '"></div></div>' +
    '<span class="num">' + counts[s] + '</span></div>').join('');

  const reading = library.filter(b => b.status === 'reading');
  const nowReading = reading.length
    ? '<div class="stat-sub">Currently reading</div><div class="now-reading">' + reading.map(b => {
        const pct = b.pageCount ? Math.round((b.progress || 0) / b.pageCount * 100) : 0;
        return '<div class="book-card" data-id="' + b.id + '">' + coverHTML(b) +
          '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
          '<p class="author">' + esc(b.authors.join(', ')) + '</p>' +
          (b.pageCount ? '<div class="progress-line"><div class="fill" style="width:' + pct + '%"></div></div>' +
            '<p class="author" style="margin-top:4px">' + (b.progress || 0) + ' / ' + b.pageCount + ' pages · ' + pct + '%</p>' : '') +
          '</div></div>';
      }).join('') + '</div>'
    : '';

  setView(
    '<h2 class="section serif">Reading stats</h2>' +
    '<div class="stat-row">' +
    '<div class="stat"><div class="n">' + readYr.length + '</div><div class="l">Read in ' + yr + '</div></div>' +
    '<div class="stat"><div class="n">' + read.length + '</div><div class="l">Total read</div></div>' +
    '<div class="stat"><div class="n">' + (pages > 999 ? (pages / 1000).toFixed(1) + 'k' : pages) + '</div><div class="l">Pages</div></div>' +
    '<div class="stat"><div class="n">' + (topAxis ? topAxis.avg.toFixed(1) : '–') + '</div><div class="l">' + (topAxis ? 'Avg ' + topAxis.a.emoji : 'Avg 💥') + '</div></div>' +
    '</div>' +
    dailyStatsHTML() +
    readingCalHTML() +
    '<div class="stat-sub">Shelves</div><div class="dist">' + distRows + '</div>' +
    (topTropes.length
      ? '<div class="stat-sub">Top tropes</div><div class="trope-cloud">' +
        topTropes.map(([t, n]) => '<span class="trope-pill">' + esc(t) + '<span class="c">' + n + '</span></span>').join('') +
        '</div>'
      : '<p class="note">Tag tropes on your books and they\'ll show up here.</p>') +
    (avgMine != null ? '<p class="note">Your average personal rating: <b style="color:var(--ink)">♥ ' + avgMine.toFixed(1) + ' / 5</b></p>' : '') +
    (axisAvgs.length > 1 ? '<p class="note">Average intensity: ' +
      axisAvgs.map(x => '<b style="color:var(--ink)">' + x.a.emoji + ' ' + x.avg.toFixed(1) + '</b>').join(' · ') + '</p>' : '') +
    nowReading
  );

  document.querySelectorAll('.now-reading .book-card').forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.id)));

  document.getElementById('cal-prev').addEventListener('click', () => {
    calM--; if (calM < 0) { calM = 11; calY--; } renderStats();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calM++; if (calM > 11) { calM = 0; calY++; } renderStats();
  });
  document.querySelectorAll('#readcal [data-day]').forEach(c =>
    c.addEventListener('click', () => {
      calSel = (calSel === c.dataset.day) ? null : c.dataset.day;
      renderStats();
    }));
  document.querySelectorAll('#cal-books .cal-book, .dstat-card .cal-book').forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.id)));
}

/* ---------------- backup view ---------------- */
function renderSettings() {
  const counts = { tbr: 0, reading: 0, read: 0, dnf: 0 };
  const axTot = {};
  library.forEach(b => {
    if (counts[b.status] != null) counts[b.status]++;
    if (b.status !== 'read') return;
    RATING_AXES.forEach(a => {
      const v = (b.ratings || {})[a.key] || 0;
      if (v > 0) {
        axTot[a.key] = axTot[a.key] || { t: 0, n: 0 };
        axTot[a.key].t += v; axTot[a.key].n++;
      }
    });
  });
  const ax0 = Object.keys(axTot).sort((x, y) => axTot[y].n - axTot[x].n)[0];

  setView(
    '<h2 class="section serif">Your shelves at a glance</h2>' +
    '<div class="stat-row">' +
    '<div class="stat"><div class="n">' + counts.tbr + '</div><div class="l">TBR</div></div>' +
    '<div class="stat"><div class="n">' + counts.reading + '</div><div class="l">Reading</div></div>' +
    '<div class="stat"><div class="n">' + counts.read + '</div><div class="l">Read</div></div>' +
    '<div class="stat"><div class="n">' + (ax0 ? (axTot[ax0].t / axTot[ax0].n).toFixed(1) : '–') + '</div><div class="l">' + (ax0 ? 'Avg ' + axisByKey(ax0).emoji : 'Avg 💥') + '</div></div>' +
    '</div>' +
    '<h2 class="section serif">Appearance</h2>' +
    '<div class="field"><label>Theme</label><div class="seg" id="th-theme" style="grid-template-columns:1fr 1fr">' +
    ['dark', 'light'].map(t =>
      '<button data-t="' + t + '" class="' + (getTheme() === t ? 'active' : '') + '">' +
      (t === 'dark' ? '🌙 Dark' : '☀️ Light') + '</button>').join('') +
    '</div></div>' +
    '<div class="field"><label>Accent</label><div class="swatches" id="th-accent">' +
    ACCENTS.map(a =>
      '<button class="sw' + (getAccent() === a.key ? ' active' : '') + '" data-a="' + a.key + '"' +
      ' style="--sw:' + a.color + '" title="' + a.name + '" aria-label="' + a.name + ' accent"></button>').join('') +
    '</div></div>' +
    '<div class="field"><label>Book pull-out animation</label><div class="seg" id="th-anim" style="grid-template-columns:1fr 1fr">' +
    ['on', 'off'].map(t =>
      '<button data-t="' + t + '" class="' + (animEnabled() === (t === 'on') ? 'active' : '') + '">' +
      (t === 'on' ? '✨ On' : '🚫 Off') + '</button>').join('') +
    '</div></div>' +
    '<h2 class="section serif" style="margin-top:26px">Shopping</h2>' +
    '<p class="note">Wishlist books show “Where to buy” links for stores in your region.</p>' +
    '<div class="field"><label>Storefront region</label><div class="seg" id="th-region" style="grid-template-columns:1fr 1fr">' +
    ['auto'].concat(STORE_REGION_KEYS).map(r =>
      '<button data-r="' + r + '" class="' + (storeRegionSetting() === r ? 'active' : '') + '">' +
      (r === 'auto' ? '🌍 Auto' : STORE_REGIONS[r].label) + '</button>').join('') +
    '</div></div>' +
    '<h2 class="section serif">Backup</h2>' +
    '<p class="note">Your library lives on this device. Export it regularly — future you will be grateful.</p>' +
    '<button class="btn block" id="bk-export">⬇ Export library (' + library.length + ' books)</button>' +
    '<button class="btn ghost block" id="bk-import">⬆ Import from file</button>' +
    '<input type="file" id="bk-file" accept="application/json" style="display:none">' +
    '<p class="note">Import merges by ISBN — books you already have are skipped.</p>' +
    '<h2 class="section serif" style="margin-top:26px">Page counts</h2>' +
    '<p class="note">Look up total pages by ISBN for books that are missing them — ' +
    'checked via Google Books first, then Open Library.</p>' +
    '<button class="btn ghost block" id="pc-backfill">📄 Fill missing page counts</button>' +
    '<p class="note" id="pc-backfill-note"></p>' +
    '<h2 class="section serif" style="margin-top:26px">Hardcover</h2>' +
    '<p class="note">Connect your free Hardcover account to auto-pull series info, content warnings, and moods. ' +
    'On your home network the server can share the token automatically (see server-config.json) — ' +
    'otherwise paste it here; it stays on this device. Get one at hardcover.app → Account settings → API.</p>' +
    (hcServerToken() && !hcManualToken() ? '<p class="note">🏠 Using the token from your home server — no need to enter anything.</p>' : '') +
    '<div class="search-row"><input id="hc-token" type="password" class="text-input" ' +
    'placeholder="hc_pat_…" value="' + esc(hcManualToken()) + '">' +
    '<button class="btn" id="hc-save">Save</button></div>' +
    '<div class="search-row"><button class="btn ghost" id="hc-test">Test connection</button>' +
    '<button class="btn ghost" id="hc-bulk">Enrich all books</button></div>' +
    '<p class="note" id="hc-status">' + hcStatusText() + '</p>' +
    '<h2 class="section serif" style="margin-top:26px">Account & cloud sync</h2>' +
    '<p class="note">Sign in to keep your library safe in your own cloud database and synced across devices. ' +
    'The app works fine without it — everything stays on this device.</p>' +
    '<p class="note" id="ac-status">Checking…</p>' +
    '<div id="ac-signedout">' +
    '<div class="search-row"><input id="ac-email" type="email" class="text-input" placeholder="Email" autocomplete="email">' +
    '<input id="ac-pass" type="password" class="text-input" placeholder="Password" autocomplete="current-password"></div>' +
    '<div class="search-row"><button class="btn" id="ac-signin">Sign in</button>' +
    '<button class="btn ghost" id="ac-signup">Create account</button></div>' +
    (window.isSecureContext
      ? '<button class="btn ghost block" id="ac-google" style="margin-top:8px">Sign in with Google</button>'
      : '<p class="note">Google sign-in needs localhost or HTTPS — on this connection, use email &amp; password.</p>') +
    '</div>' +
    '<div id="ac-signedin" style="display:none">' +
    '<div class="search-row"><button class="btn ghost" id="ac-sync">☁️ Sync now</button>' +
    '<button class="btn ghost" id="ac-logout">Sign out</button></div>' +
    '<p class="note" id="ac-last"></p>' +
    '</div>' +
    '<p class="note">Supabase project — from your Supabase dashboard → Project Settings → API:</p>' +
    (cloudServerCfg().url ? '<p class="note">🏠 Using the home server’s Supabase config — no need to enter anything.</p>' : '') +
    '<div class="search-row"><input id="ac-url" class="text-input" placeholder="https://xyzcompany.supabase.co" ' +
    'value="' + esc(cloudManualCfg().url) + '" autocapitalize="off" spellcheck="false"></div>' +
    '<div class="search-row"><input id="ac-key" type="password" class="text-input" placeholder="anon public key" ' +
    'value="' + esc(cloudManualCfg().key) + '" autocapitalize="off" spellcheck="false">' +
    '<button class="btn" id="ac-save">Save</button></div>' +
    '<button class="btn danger block" id="bk-wipe" style="margin-top:26px">Delete everything</button>'
  );

  // Appearance wiring
  document.querySelectorAll('#th-theme button').forEach(btn =>
    btn.addEventListener('click', () => {
      localStorage.setItem('theme', btn.dataset.t);
      applyTheme();
      document.querySelectorAll('#th-theme button').forEach(x => x.classList.toggle('active', x === btn));
    }));
  document.querySelectorAll('#th-accent .sw').forEach(btn =>
    btn.addEventListener('click', () => {
      localStorage.setItem('accent', btn.dataset.a);
      applyTheme();
      document.querySelectorAll('#th-accent .sw').forEach(x => x.classList.toggle('active', x === btn));
      toast('Accent updated ✨');
    }));
  document.querySelectorAll('#th-anim button').forEach(btn =>
    btn.addEventListener('click', () => {
      try { localStorage.setItem('spicyshelves.animation', btn.dataset.t); } catch (e) {}
      document.querySelectorAll('#th-anim button').forEach(x => x.classList.toggle('active', x === btn));
    }));
  document.querySelectorAll('#th-region button').forEach(btn =>
    btn.addEventListener('click', () => {
      try { localStorage.setItem('spicyshelves.storeRegion', btn.dataset.r); } catch (e) {}
      document.querySelectorAll('#th-region button').forEach(x => x.classList.toggle('active', x === btn));
      toast('Store region: ' + (btn.dataset.r === 'auto' ? 'auto-detect 🌍' : STORE_REGIONS[btn.dataset.r].label));
    }));

  document.getElementById('bk-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'spicy-shelves', version: 1, exported: new Date().toISOString(), books: library }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spicy-shelves-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup downloaded 💾');
  });
  document.getElementById('bk-import').addEventListener('click', () =>
    document.getElementById('bk-file').click());
  document.getElementById('bk-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        const books = Array.isArray(data) ? data : data.books;
        if (!Array.isArray(books)) throw new Error('bad file');
        let added = 0, skipped = 0;
        books.forEach(b => {
          if (!b || !b.title) { skipped++; return; }
          const nb = Object.assign(normalizeVolume({ volumeInfo: {} }), b, { id: uid() });
          migrateBook(nb);
          if (alreadyHave(nb)) { skipped++; return; }
          library.push(nb); added++;
        });
        saveLibrary(); render();
        toast('Imported ' + added + ' books' + (skipped ? ' (' + skipped + ' skipped)' : ''));
      } catch (err) { toast('Could not read that file'); }
    };
    r.readAsText(f);
    e.target.value = '';
  });
  // Account wiring
  document.getElementById('ac-signin').addEventListener('click', () => {
    const em = document.getElementById('ac-email').value.trim();
    const pw = document.getElementById('ac-pass').value;
    if (!em || !pw) { toast('Enter email and password'); return; }
    cloudSignIn(em, pw);
  });
  document.getElementById('ac-signup').addEventListener('click', () => {
    const em = document.getElementById('ac-email').value.trim();
    const pw = document.getElementById('ac-pass').value;
    if (!em || !pw) { toast('Enter email and password'); return; }
    if (pw.length < 6) { toast('Password needs at least 6 characters'); return; }
    cloudSignUp(em, pw);
  });
  const ggBtn = document.getElementById('ac-google');
  if (ggBtn) ggBtn.addEventListener('click', cloudGoogle);
  document.getElementById('ac-logout').addEventListener('click', cloudSignOut);
  document.getElementById('ac-sync').addEventListener('click', async () => {
    toast('Syncing…'); await cloudFirstSync();
  });
  document.getElementById('ac-save').addEventListener('click', () => {
    const u = document.getElementById('ac-url').value.trim();
    const k = document.getElementById('ac-key').value.trim();
    if (u) localStorage.setItem('sb_url', u); else localStorage.removeItem('sb_url');
    if (k) localStorage.setItem('sb_key', k); else localStorage.removeItem('sb_key');
    sbClient = null; sbClientCfg = ''; cloudUser = null; // force reconnect
    toast(u && k ? 'Supabase config saved' : 'Supabase config cleared');
    initCloud();
  });
  refreshAccountUI();

  document.getElementById('bk-wipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL ' + library.length + ' books? Export a backup first!')) return;
    if (!confirm('Really? This cannot be undone.')) return;
    library = []; bookSnapshots.clear(); saveLibrary({ noCloud: true }); render();
    await cloudWipe();
    toast('Shelves cleared');
  });

  // Hardcover wiring
  const hcStatus = () => document.getElementById('hc-status');
  document.getElementById('hc-save').addEventListener('click', () => {
    const v = document.getElementById('hc-token').value.trim();
    if (v) localStorage.setItem('hc_token', v);
    else localStorage.removeItem('hc_token');
    const st = hcStatus(); if (st) st.textContent = hcStatusText();
    toast(v ? 'Hardcover token saved' : 'Hardcover token removed');
  });
  document.getElementById('pc-backfill').addEventListener('click', () => backfillPageCounts());
  document.getElementById('hc-test').addEventListener('click', async () => {
    const st = hcStatus(); if (!st) return;
    if (!hcToken()) { st.textContent = 'Save a token first.'; return; }
    st.textContent = 'Testing…';
    try {
      const data = await hcGraphQL('query { search(query: "Dune", query_type: "Book", per_page: 1) { results } }');
      const hits = hcHits(data);
      st.textContent = hits.length ? 'Connected ✓ — found "' + hits[0].document.title + '"' : 'Connected, but got no results.';
    } catch (e) { st.textContent = 'Failed: ' + e.message; }
  });
  document.getElementById('hc-bulk').addEventListener('click', async () => {
    const btn = document.getElementById('hc-bulk');
    if (!hcToken()) { toast('Save a Hardcover token first'); return; }
    if (btn.disabled) return;
    btn.disabled = true;
    const targets = library.filter(b => !b.hcEnriched);
    let ok = 0;
    for (let i = 0; i < targets.length; i++) {
      const st = hcStatus(); if (st) st.textContent = 'Enriching ' + (i + 1) + '/' + targets.length + '… (' + ok + ' matched)';
      try { if (await enrichHardcover(targets[i])) ok++; } catch (e) { /* skip */ }
      await new Promise(r => setTimeout(r, 1100)); // stay under the 60 req/min limit
    }
    saveLibrary(); render();
    const st2 = hcStatus(); if (st2) st2.textContent = 'Done — ' + ok + ' of ' + targets.length + ' books enriched ✨';
    toast('Hardcover enrichment complete ✨');
  });
}

/* ---- wishlist tab: books marked "to buy" ---- */
function renderWishlist() {
  const books = library.filter(b => !b.owned)
    .sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')));
  let html = '<div class="wish-head"><h2 class="serif">💝 Wishlist</h2>' +
    '<p class="note">' + books.length + ' book' + (books.length === 1 ? '' : 's') +
    ' you want to get your hands on</p></div>';
  if (!books.length) {
    html += '<div class="empty"><div class="big">💝</div><h2 class="serif">Nothing on the wishlist</h2>' +
      '<p>Open any book and choose <b>🛒 To buy</b><br>under Ownership to add it here.</p></div>';
  } else {
    html += '<div class="grid">' + books.map((b, i) => bookCard(b, i)).join('') + '</div>';
  }
  setView(html);
  document.querySelectorAll('.book-card').forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.id)));
}

/* ---------------- render root ---------------- */
function setView(html) { document.getElementById('view').innerHTML = html; }
function render() {
  if (view === 'library') renderLibrary();
  else if (view === 'wishlist') renderWishlist();
  else if (view === 'add') renderAdd();
  else if (view === 'pick') renderPick();
  else if (view === 'stats') renderStats();
  else if (view === 'settings') renderSettings();
}

applyTheme();
render();
initCloud();
