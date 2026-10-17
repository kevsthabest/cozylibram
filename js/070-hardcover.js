'use strict';

/* ---------------- Hardcover (series, content warnings, moods) ---------------- */
// Free GraphQL API: https://api.hardcover.app/v1/graphql
// v89: the personal token never reaches the browser. The app POSTs queries to
// the same-origin /api/hardcover proxy (Pages Function or server.py), which
// attaches the token server-side. /config.js only carries a boolean flag.
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export const HC_API = '/api/hardcover';
export function hcReady() {
  try { return !!((window.SPICY_CONFIG && window.SPICY_CONFIG.hardcover)); }
  catch (e) { return false; }
}
export async function hcGraphQL(query) {
  if (!hcReady()) return null;
  // v77: every failure mode throws a specific, human-readable error instead of
  // silently returning undefined — callers (series overlay, test button,
  // enrichment) can finally tell "token rejected" apart from "offline".
  // v89: the proxy forwards Hardcover's own HTTP status, so the handling below
  // is unchanged.
  let r;
  try {
    r = await apiFetch(HC_API, {
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
    let gateErr = null;
    try {
      const dj = await r.json();
      detail = (dj && dj.errors && dj.errors[0] && dj.errors[0].message) || dj.message || '';
      gateErr = dj && dj.error;
    } catch (e) {}
    // v225: a 401 carrying {error:'sign-in required'} is OUR gate, not
    // Hardcover — the session expired. Don't blame the server token.
    if (gateErr === 'sign-in required') {
      throw new Error('Your sign-in expired — please sign in again.');
    }
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
export function hcHits(data) {
  try { return data.search.results.hits || []; } catch (e) { return []; }
}

// v516 (#132): does this Hardcover doc actually list the book's ISBN?
// Same guard as the page-count waterfall (js/080): normalize both sides
// and compare ISBN-13 forms, so a 10 on one side matches a 13 on the other.
export function hcDocIsbnMatch(doc, isbn) {
  const clean = String(isbn || '').replace(/[^0-9X]/gi, '').toUpperCase();
  if (!clean || !doc) return false;
  const want13 = (typeof isbn13of === 'function') ? isbn13of(clean) : clean;
  return (doc.isbns || []).some(i => {
    const n = String(i || '').replace(/[^0-9X]/gi, '').toUpperCase();
    return n === clean || ((typeof isbn13of === 'function') && isbn13of(n) === want13);
  });
}

// v516 (#132): title comparison form for the fallback matcher — the same
// recipe as normTitle (js/134): trailing "(Series, #1)" dropped, case and
// punctuation ignored.
export function hcMatchTitle(t) {
  return String(t || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Full-title agreement. The one legitimate asymmetry: a subtitle carried by
// only one side ("The Housemaid: A Novel" in the library, "The Housemaid"
// on Hardcover) — then that side's main title must BE the other side's
// whole title. The >= 4 guard keeps a colon inside a title (Re:ZERO, It)
// from turning its first fragment into a "main title". Two different
// subtitles with a shared main title ("Dune: Part One" / "Part Two") match
// neither form and are rejected.
export function hcTitleMatch(docTitle, bookTitle) {
  const a = hcMatchTitle(docTitle), b = hcMatchTitle(bookTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  const mainOf = t => {
    const raw = String(t || '');
    const i = raw.indexOf(':');
    return i >= 0 ? hcMatchTitle(raw.slice(0, i)) : '';
  };
  const am = mainOf(docTitle), bm = mainOf(bookTitle);
  return (am.length >= 4 && am === b) || (bm.length >= 4 && bm === a);
}

// First-author agreement. Either side missing author data can't disagree —
// the (already strict) title match carries the acceptance then.
export function hcAuthorMatch(doc, book) {
  const bFirst = (book.authors || [])[0], dFirst = (doc.author_names || [])[0];
  if (!bFirst || !dFirst) return true;
  const key = (typeof authorKey === 'function') ? authorKey
    : (n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim());
  if (!key(bFirst) || !key(dFirst)) return true;
  if (key(bFirst) === key(dFirst)) return true;
  // Co-author order differs between sources: either first author showing
  // up anywhere in the other side's list is agreement enough.
  return (doc.author_names || []).some(a => key(a) === key(bFirst)) ||
         (book.authors || []).some(a => key(a) === key(dFirst));
}

// v516 (#132): acceptance for the title-search fallback. Before, any doc
// whose title shared the book's first 12 characters was applied —
// "The Housemaid" picked up "The Housemaid's Secret"'s series, moods and
// content warnings. Now a doc must prove it is the same book: its isbns[]
// list the book's ISBN (the strongest signal — preferred where the data
// exists), or the full titles match AND the first authors agree. An ISBN
// mismatch alone never vetoes a title+author match: the book's ISBN may
// belong to a different edition of the same work.
export function hcFallbackDocMatches(doc, book) {
  if (!doc || !book) return false;
  if (hcDocIsbnMatch(doc, book.isbn)) return true;
  return hcTitleMatch(doc.title, book.title) && hcAuthorMatch(doc, book);
}

// Enrich a book with Hardcover data: series, content warnings, moods, genres, rating.
// Returns true when Hardcover had the book.
export async function enrichHardcover(book) {
  if (!hcReady() || book.hcEnriched) return false;
  try {
    let doc = null;
    if (book.isbn) {
      const data = await hcGraphQL('query { search(query: "' + book.isbn + '", query_type: "Book", per_page: 5) { results } }');
      doc = hcHits(data).map(h => h.document).find(d => hcDocIsbnMatch(d, book.isbn)) || null;
    }
    if (!doc && book.title) {
      const q = book.title + ' ' + (book.authors[0] || '');
      const data = await hcGraphQL('query { search(query: ' + JSON.stringify(q) + ', query_type: "Book", per_page: 3) { results } }');
      const docs = hcHits(data).map(h => h.document).filter(Boolean);
      doc = docs.find(d => hcFallbackDocMatches(d, book)) || null;
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
export async function enrichTropesFor(book) {
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

export function applyHardcoverDoc(book, doc) {
  if (Array.isArray(doc.content_warnings) && doc.content_warnings.length)
    book.contentWarnings = Array.from(new Set(doc.content_warnings.map(String)));
  const fs = doc.featured_series;
  // v239: a manually-tagged series wins — enrichment never overwrites it.
  if (!book.seriesManual) {
    if (fs && fs.series && fs.series.name) {
      book.series = { name: fs.series.name, position: (fs.position != null ? fs.position : (fs.details || null)) };
    } else if (Array.isArray(doc.series_names) && doc.series_names.length) {
      book.series = { name: doc.series_names[0], position: null };
    }
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
  // v272: fold the Hardcover id into the work's provider_ids (fire-and-forget).
  try {
    if (book.hcId != null && typeof workAttachProviderIds === 'function') {
      workAttachProviderIds(book, { hardcover_id: String(book.hcId) });
    }
  } catch (e) {}
  book.hcEnriched = true;
}

/* ---------------- Hardcover search fallback (v137) ---------------- */
// Indie titles (KU romance especially) are often in neither Google Books nor
// Open Library. The Search tab asks Hardcover last before giving up, so those
// books can still be added with full metadata instead of by hand.
export function hcDocToBook(doc) {
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

export async function hcSearchDocs(q) {
  // v196: raw Hardcover docs (unmapped) so the ISBN waterfall can verify a
  // doc's isbns[] contains the scanned ISBN before accepting the match —
  // Typesense search is fuzzy, and a near-miss title is worse than no match.
  if (!hcReady()) return [];
  try {
    const data = await hcGraphQL('query { search(query: ' + JSON.stringify(q) + ', query_type: "Book", per_page: 8) { results } }');
    return hcHits(data).map(h => h.document).filter(d => d && d.title);
  } catch (e) { return []; }
}
export async function hcSearchBooks(q) {
  return (await hcSearchDocs(q)).map(hcDocToBook);
}

// Automatic background sweep (v72): enriches books Hardcover hasn't seen yet a
// few seconds after the app boots, so "Enrich all books" never needs a manual
// tap. Shares the rate-limit pacing (60 req/min) and a busy flag with the
// manual bulk run. Books Hardcover doesn't know get hcCheckedAt so misses
// aren't re-hammered every boot (retried after 7 days); the manual button
// always retries everything.
export let hcEnrichBusy = false;
export function hcSweepTargets() {
  const weekAgo = Date.now() - 7 * 86400000;
  return library.filter(b => !b.hcEnriched && !(b.hcCheckedAt > weekAgo));
}
export async function autoEnrichSweep() {
  if (hcEnrichBusy || !hcReady()) return;
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
      await new Promise(r => setTimeout(r, 1100));
    }
  } finally { hcEnrichBusy = false; }
  // v495 (#127): one save for the whole sweep. Was N full-library rewrites;
  // with dirty flags each touched book is marked during the loop above, so a
  // single saveLibrary() persists exactly what changed (including hcCheckedAt
  // on misses, which keeps the next sweep from re-checking them).
  saveLibrary();
  if (ok > 0) {
    if (!editingId) render();
    toast('✨ Auto-enriched ' + ok + ' book' + (ok === 1 ? '' : 's') + ' from Hardcover');
  }
}

// Display-only Hardcover sections for the detail modal (series, moods, warnings).
export function hcDetailHTML(b) {
  let h = '';
  // v133: series display moved to the inline "In this series" block in the
  // modal (150-modal-discovery.js) — the name is no longer a tap-through.
  if (b.moods && b.moods.length) {
    h += '<div class="mood-row">' + b.moods.map(m => '<span class="mood-chip">' + esc(m) + '</span>').join('') + '</div>';
  }
  if (b.contentWarnings && b.contentWarnings.length) {
    // v402: progressive disclosure — if trigger_chapters is available, show
    // "Ch. 1, 3, 7" next to each matching warning. Absent = plain tags as before.
    const tc = (b.trigger_chapters && typeof b.trigger_chapters === 'object') ? b.trigger_chapters : null;
    const chapLabel = (w) => {
      if (!tc) return '';
      const key = Object.keys(tc).find(k => k.toLowerCase() === String(w).toLowerCase());
      if (!key || !Array.isArray(tc[key]) || !tc[key].length) return '';
      return ' <span class="warn-chaps">Ch. ' + tc[key].map(n => esc(String(n))).join(', ') + '</span>';
    };
    // v535 (audit #1): warning preferences apply in the modal too.
    // 'gentle' (the default) renders exactly the pre-v535 block;
    // prominent warnings come first + emphasised; 'detailed' opens the
    // section and adds taxonomy descriptions; 'on-request' holds the
    // names behind a reveal button (session-only reveal, js/226).
    const wprefs = (typeof getWarningPrefs === 'function') ? getWarningPrefs() : null;
    const wdetail = wprefs ? wprefs.detail : 'gentle';
    if (wdetail === 'on-request' && !(typeof warnIsRevealed === 'function' && warnIsRevealed(b))) {
      if (typeof warnRegisterRevealBook === 'function') warnRegisterRevealBook(b);
      const rkey = (typeof warnRevealKey === 'function') ? warnRevealKey(b) : String((b && b.id) || '');
      h += '<div class="warnings-onreq"><button type="button" class="btn ghost sm" data-warnreveal="' +
        esc(rkey) + '">' + icon('warn') + ' Content warnings — tap to view</button></div>';
    } else {
      const ordered = (wprefs && typeof warnOrderProminent === 'function')
        ? warnOrderProminent(b.contentWarnings, wprefs) : b.contentWarnings;
      h += '<details class="warnings"' + (wdetail === 'detailed' ? ' open' : '') + '><summary>' + icon('warn') + ' Content warnings (' + b.contentWarnings.length + ')</summary><div class="warn-tags">' +
        ordered.map(w => {
          const prom = wprefs && typeof warnIsProminent === 'function' && warnIsProminent(w, wprefs);
          const desc = (wdetail === 'detailed' && typeof warnDescFor === 'function') ? warnDescFor(w) : '';
          return '<span class="warn-tag' + (prom ? ' warn-tag-prom' : '') + '">' + esc(w) + chapLabel(w) + '</span>' +
            (desc ? ' <span class="warn-desc">' + esc(desc) + '</span>' : '');
        }).join('') + '</div></details>';
    }
  }
  return h;
}

// v535: on-request warning reveal in the book modal. One delegated
// listener: reveal is session-only (js/226), the repaint is just the
// gentle hcDetailHTML for the registered book.
if (typeof document !== 'undefined' && document.addEventListener && !window.__warnRevealWired) {
  window.__warnRevealWired = true;
  document.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-warnreveal]') : null;
    if (!btn) return;
    const book = (typeof warnBookForReveal === 'function') ? warnBookForReveal(btn.getAttribute('data-warnreveal')) : null;
    if (!book) return;
    if (typeof warnReveal === 'function') warnReveal(book);
    const wrap = btn.closest('.warnings-onreq');
    if (wrap) wrap.outerHTML = hcDetailHTML(book);
  });
}

// Second public-rating signal from Open Library (free, no key), merged with the
// Google Books score via a count-weighted average. Falls back gracefully.
export async function enrichRatings(book) {
  try {
    const q = book.isbn ? book.isbn : (book.title + ' ' + (book.authors[0] || '')).trim();
    if (!q) return book;
    // v494 (#126): bound the lookup — a hung Open Library request used to
    // hang enrichment forever. The outer try/catch already treats any
    // failure as "keep the Google Books data".
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, NET_TIMEOUT_MS);
    let r;
    try {
      r = await fetch('https://openlibrary.org/search.json?q=' + encodeURIComponent(q) +
        '&fields=title,ratings_average,ratings_count&limit=1', { signal: ctrl.signal });
    } finally { clearTimeout(timer); }
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

export function alreadyHave(book) {
  return library.some(b =>
    (book.isbn && b.isbn && b.isbn === book.isbn) ||
    (b.title.toLowerCase() === book.title.toLowerCase() &&
     (b.authors[0] || '').toLowerCase() === (book.authors[0] || '').toLowerCase())
  );
}

export function addBook(book, openEditor, source) {
  // v495 (#125): normalize the shape AND wrap for dirty-flag tracking — every
  // book entering the library is tracked (migrateBook is idempotent, and this
  // is also the C1 invariant: no hand-built book shapes).
  book = trackBook(migrateBook(book));
  if (alreadyHave(book)) { toast('Already on your shelves'); return null; }
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
      } else renderKeepScan(); // v195: don't tear down an active scan session
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
      else renderKeepScan(); // v195: don't tear down an active scan session
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
  // Cover-storage closure: adopt the cover into the bucket in the
  // background — the add never waits on it, and any failure keeps the
  // cover exactly as added. One hook here covers search, scan, shelf,
  // coven, reco, and discovery adds (all pass through addBook).
  if (typeof adoptBookCoverInBackground === 'function') adoptBookCoverInBackground(book);
  return book;
}


/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this file
   can see them. The consumers — 061-gbooks-key.js, 062-tropes.js,
   080-pagecount.js, 095-gate.js, 130-add.js, 132-import.js,
   133-bookmory.js, 134-verify.js, 136-coverpicker.js, 137-shelf.js,
   138-editions.js, 139-import-concierge.js, 140-collections.js,
   150-modal-discovery.js, 180-settings.js, 195-coven.js, 196-recos.js,
   198-discovery.js, 232-thought-of-you.js and 239-finale.js — reach these
   names at runtime, so the bridge republishes exactly the pre-conversion
   public surface on window. Bare-name lookups in classic scripts resolve
   through the global object, so the caller needs no changes. Module scripts
   are deferred, so the bridge is in place before any consumer can run.
   Remove a name from this bridge only when its last classic caller is gone.
 */
window.HC_API = HC_API;
window.hcReady = hcReady;
window.hcGraphQL = hcGraphQL;
window.hcHits = hcHits;
window.hcDocIsbnMatch = hcDocIsbnMatch;
window.hcMatchTitle = hcMatchTitle;
window.hcTitleMatch = hcTitleMatch;
window.hcAuthorMatch = hcAuthorMatch;
window.hcFallbackDocMatches = hcFallbackDocMatches;
window.enrichHardcover = enrichHardcover;
window.enrichTropesFor = enrichTropesFor;
window.applyHardcoverDoc = applyHardcoverDoc;
window.hcDocToBook = hcDocToBook;
window.hcSearchDocs = hcSearchDocs;
window.hcSearchBooks = hcSearchBooks;
window.hcEnrichBusy = hcEnrichBusy;
window.hcSweepTargets = hcSweepTargets;
window.autoEnrichSweep = autoEnrichSweep;
window.hcDetailHTML = hcDetailHTML;
window.enrichRatings = enrichRatings;
window.alreadyHave = alreadyHave;
window.addBook = addBook;
