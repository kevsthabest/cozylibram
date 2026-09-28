'use strict';

/* ---------------- Hardcover (series, content warnings, moods) ---------------- */
// Free GraphQL API: https://api.hardcover.app/v1/graphql
// v89: the personal token never reaches the browser. The app POSTs queries to
// the same-origin /api/hardcover proxy (Pages Function or server.py), which
// attaches the token server-side. /config.js only carries a boolean flag.
const HC_API = '/api/hardcover';
function hcReady() {
  try { return !!((window.SPICY_CONFIG && window.SPICY_CONFIG.hardcover)); }
  catch (e) { return false; }
}
function hcStatusText() {
  if (hcReady()) return icon('owned') + ' Using server-side Hardcover key ✓';
  return 'No key set — add HARDCOVER_TOKEN (Pages env) or hardcover_token (server-config.json).';
}

async function hcGraphQL(query) {
  if (!hcReady()) return null;
  // v77: every failure mode throws a specific, human-readable error instead of
  // silently returning undefined — callers (series overlay, test button,
  // enrichment) can finally tell "token rejected" apart from "offline".
  // v89: the proxy forwards Hardcover's own HTTP status, so the handling below
  // is unchanged.
  let r;
  try {
    r = await fetch(HC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query })
    });
  } catch (e) {
    throw new Error('Network error — couldn\'t reach the server. Check your connection and try again.');
  }
  if (r.status === 503) {
    throw new Error('Hardcover isn\'t configured on this server (no token).');
  }
  if (r.status === 401 || r.status === 403) {
    // v83: a 403 isn't always the token — Hardcover also answers 403 when the
    // query itself uses a blocked operation. Surface the server's own message
    // in that case instead of blaming the token.
    let detail = '';
    try {
      const dj = await r.json();
      detail = (dj && dj.errors && dj.errors[0] && dj.errors[0].message) || dj.message || '';
    } catch (e) {}
    if (r.status === 403 && detail && /not permitted|forbidden|blocked|ilike/i.test(detail)) {
      throw new Error('Hardcover blocked this query (HTTP 403): ' + detail);
    }
    throw new Error('Hardcover rejected the server token (HTTP ' + r.status + '). It may be expired or revoked — ' +
      'Hardcover tokens expire every Jan 1. Grab a fresh one at hardcover.app → Account settings → API, ' +
      'then update it on the server.');
  }
  let d;
  try { d = await r.json(); }
  catch (e) { throw new Error('Hardcover returned an unreadable response (HTTP ' + r.status + ').'); }
  if (d.errors && d.errors.length) throw new Error('Hardcover error: ' + d.errors[0].message);
  if (!d.data) throw new Error('Hardcover returned no data — the token may be invalid or revoked.');
  return d.data;
}
function hcHits(data) {
  try { return data.search.results.hits || []; } catch (e) { return []; }
}

// Enrich a book with Hardcover data: series, content warnings, moods, genres, rating.
// Returns true when Hardcover had the book.
async function enrichHardcover(book) {
  if (!hcReady() || book.hcEnriched) return false;
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
    await enrichTropesFor(book);
    return true;
  } catch (e) { return false; }
}

// v191: trope suggestions, extracted from enrichHardcover so books that skip
// the Hardcover re-fetch (shared-cache hits, Hardcover-search adds) still get
// suggestions — refreshTropeSuggestions only needs the cached hcId.
async function enrichTropesFor(book) {
  // v81: trope suggestions ride along with enrichment (best-effort; never
  // fails the enrichment). Pace the extra tags request under the rate limit.
  try {
    await refreshTropeSuggestions(book);
    if (book._hcTagsFetched) {
      delete book._hcTagsFetched;
      await new Promise(r => setTimeout(r, 1100));
    }
  } catch (e) {}
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
  // v113: adopt a release date when the book has none (powers Coming soon).
  if (!book.releaseDate && doc.release_date) {
    const d = String(doc.release_date).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) book.releaseDate = d;
  }
  // v81: stash the Hardcover id + any tags the search document carries so the
  // trope suggester can pull community tags without another search.
  if (doc.id != null && book.hcId == null) book.hcId = doc.id;
  if (Array.isArray(doc.tags) && doc.tags.length) book._hcDocTags = doc.tags.slice(0, 20);
  book.hcEnriched = true;
}

/* ---------------- Hardcover search fallback (v137) ---------------- */
// Indie titles (KU romance especially) are often in neither Google Books nor
// Open Library. The Search tab asks Hardcover last before giving up, so those
// books can still be added with full metadata instead of by hand.
function hcDocToBook(doc) {
  const isbns = ((doc.isbns || []).map(i => String(i).replace(/[^0-9X]/gi, '')).filter(Boolean));
  const isbn = isbns.find(s => s.length === 13) || isbns[0] || '';
  const book = {
    id: uid(),
    isbn: isbn,
    title: doc.title || 'Unknown title',
    authors: (doc.author_names || []).map(String),
    cover: (doc.image && doc.image.url) || '',
    description: doc.description || '',
    pageCount: doc.pages || null,
    publishedDate: String(doc.release_date || '').slice(0, 10),
    categories: (doc.genres || []).map(String),
    publicRating: null,
    ratingsCount: 0,
    status: 'tbr',
    owned: 'owned',
    ratings: {},
    myRating: 0,
    tropes: [],
    tropesAuto: [],
    progress: 0,
    dateAdded: new Date().toISOString(),
    dateFinished: null,
    notes: ''
  };
  try { applyHardcoverDoc(book, doc); } catch (e) {} // moods, warnings, rating…
  try { book.axes = autoDetectAxes(book); } catch (e) {}
  return book;
}

async function hcSearchBooks(q) {
  if (!hcReady()) return [];
  try {
    const data = await hcGraphQL('query { search(query: ' + JSON.stringify(q) + ', query_type: "Book", per_page: 8) { results } }');
    const docs = hcHits(data).map(h => h.document).filter(d => d && d.title);
    return docs.map(hcDocToBook);
  } catch (e) { return []; }
}

// Automatic background sweep (v72): enriches books Hardcover hasn't seen yet a
// few seconds after the app boots, so "Enrich all books" never needs a manual
// tap. Shares the rate-limit pacing (60 req/min) and a busy flag with the
// manual bulk run. Books Hardcover doesn't know get hcCheckedAt so misses
// aren't re-hammered every boot (retried after 7 days); the manual button
// always retries everything.
let hcEnrichBusy = false;
const HC_AUTO_KEY = 'spicyshelves.hc_auto';
function hcAutoEnabled() {
  try { return localStorage.getItem(HC_AUTO_KEY) !== '0'; } catch (e) { return true; }
}
function hcSweepTargets() {
  const weekAgo = Date.now() - 7 * 86400000;
  return library.filter(b => !b.hcEnriched && !(b.hcCheckedAt > weekAgo));
}
async function autoEnrichSweep() {
  if (hcEnrichBusy || !hcReady() || !hcAutoEnabled()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const targets = hcSweepTargets();
  if (!targets.length) return;
  hcEnrichBusy = true;
  let ok = 0;
  try {
    for (const b of targets) {
      let hit = false;
      try { hit = await enrichHardcover(b); } catch (e) { hit = false; }
      if (hit) ok++; else b.hcCheckedAt = Date.now();
      saveLibrary();
      await new Promise(r => setTimeout(r, 1100));
    }
  } finally { hcEnrichBusy = false; }
  if (ok > 0) {
    if (!editingId) render();
    toast('✨ Auto-enriched ' + ok + ' book' + (ok === 1 ? '' : 's') + ' from Hardcover');
  }
}

// Display-only Hardcover sections for the detail modal (series, moods, warnings).
function hcDetailHTML(b) {
  let h = '';
  // v133: series display moved to the inline "In this series" block in the
  // modal (150-modal-discovery.js) — the name is no longer a tap-through.
  if (b.moods && b.moods.length) {
    h += '<div class="mood-row">' + b.moods.map(m => '<span class="mood-chip">' + esc(m) + '</span>').join('') + '</div>';
  }
  if (b.contentWarnings && b.contentWarnings.length) {
    h += '<details class="warnings"><summary>' + icon('warn') + ' Content warnings (' + b.contentWarnings.length + ')</summary><div class="warn-tags">' +
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

function addBook(book, openEditor, source) {
  if (alreadyHave(book)) { toast('Already on your shelves 📚'); return null; }
  untombstone(book.id); // re-adding the same id is an un-delete
  library.unshift(book);
  saveLibrary();
  render();
  toast('Added to To Be Read ✨');
  track('book_added', { source: source || 'manual' });
  trackOnce('first_book', 'first_book_added');
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
  if (hcReady() && !book.hcEnriched) {
    const pristine = metaSnapshot(book); // v191: pristine API base for the canonical cache
    enrichHardcover(book).then(async ok => {
      if (!ok) return;
      // v191: store the enriched snapshot so the next user gets full metadata
      // (series, moods, warnings, blended rating) from the shared cache with
      // zero API calls. Add-flow only — the backfill sweep never writes, so a
      // user-edited book can never pollute the canonical copy.
      // v192: awaited and keyed by the entered isbn (book._cacheKey) — the
      // lookup's put was awaited too, so this upsert always lands after it.
      await metaCachePutEnriched(pristine, book);
      saveLibrary();
      // Refresh only the Hardcover sections if the editor is open — never clobbers typed input.
      const hcEl = document.getElementById('m-hc');
      if (editingId === book.id && hcEl) hcEl.innerHTML = hcDetailHTML(book);
      else render();
      if (editingId === book.id) refreshSeriesInline(book); // v133: series may have arrived with enrichment
      toast('✨ Enriched from Hardcover');
    });
  } else if (hcReady() && book.hcEnriched && book.isbn) {
    // v191: arrived with Hardcover metadata (Hardcover search) or from the
    // shared cache — snapshot it canonically; the re-fetch is skipped so the
    // community rating is never blended twice. Trope suggestions still run.
    // v192: refresh the row this book was read from (entered isbn), not the
    // edition isbn, so the next lookup of the same isbn hits.
    metaCachePut(book._cacheKey || book.isbn, metaSnapshot(book));
    enrichTropesFor(book).then(() => saveLibrary());
  }
  return book;
}

