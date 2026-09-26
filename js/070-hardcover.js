'use strict';

/* ---------------- Hardcover (series, content warnings, moods) ---------------- */
// Free GraphQL API: https://api.hardcover.app/v1/graphql
// Needs a personal token (hardcover.app → account settings → API). The token
// lives in server-config.json on the home PC and is shared with LAN clients
// via /config.js (never cached).
const HC_API = 'https://api.hardcover.app/v1/graphql';
function hcToken() {
  try { return ((window.SPICY_CONFIG && window.SPICY_CONFIG.hardcoverToken) || '').trim(); }
  catch (e) { return ''; }
}
function hcStatusText() {
  if (hcToken()) return '🏠 Using home-server token ✓';
  return 'No token set — add hardcover_token to server-config.json on your home PC.';
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
  untombstone(book.id); // re-adding the same id is an un-delete
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

