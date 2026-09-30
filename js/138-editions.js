'use strict';

/* ---- Edition picker (v210): change which edition of a book she owns ----
   Scanned books get the right ISBN from the barcode, but search-added books
   take whatever ISBN the catalog returned first, and manual adds get none.
   Tapping the ISBN row in the book modal opens this picker: every edition
   Hardcover knows for the work (publisher, year, pages, cover), plus a
   manual-ISBN fallback for works Hardcover doesn't know.

   Switching updates the ISBN, adopts the edition's cover art (never a
   custom upload), and refreshes the page count. Work-level data (tropes,
   series, moods) is untouched — tropes live on the work, not the edition.
   Books already Hardcover-enriched skip the re-enrich so the public rating
   isn't blended twice; never-enriched books get the standard pass. */

function epCleanISBN(s) {
  return String(s || '').replace(/[^0-9X]/gi, '').toUpperCase();
}

// All usable editions Hardcover knows for this book's work.
// Returns { title, editions: [{isbn, publisher, year, pages, cover}] }
// or { error } when Hardcover can't be reached or knows nothing.
async function fetchEditionOptions(book) {
  if (typeof hcReady !== 'function' || !hcReady()) {
    return { error: 'Edition lookup needs the home-server connection (Hardcover).' };
  }
  const q = 'query { editions(where: {isbn_13: {_eq: ' + JSON.stringify(epCleanISBN(book.isbn)) +
    '}}, limit: 1) { book { id title } } }';
  const ED_FIELDS = 'editions(limit: 40) { isbn_13 publisher { name } release_date pages image { url } }';
  try {
    let bookId = null, title = book.title || 'this book';
    const isbn = epCleanISBN(book.isbn);
    if (isbn) {
      const d1 = await hcGraphQL(q);
      const hit = ((d1 || {}).editions || [])[0];
      if (hit && hit.book) { bookId = hit.book.id; title = hit.book.title || title; }
    }
    if (!bookId && book.title) {
      // No ISBN (manual adds): find the work by title + first author, using
      // the same 12-char match rule as enrichHardcover so a near-miss title
      // can't attach her book to the wrong work.
      const sq = book.title + ' ' + ((book.authors || [])[0] || '');
      const ds = await hcGraphQL('query { search(query: ' + JSON.stringify(sq) +
        ', query_type: "Book", per_page: 3) { results } }');
      const docs = hcHits(ds).map(h => h.document).filter(d => d && d.title);
      const doc = docs.find(d => String(d.title).toLowerCase().slice(0, 12) ===
        String(book.title).toLowerCase().slice(0, 12));
      if (doc) { bookId = doc.id; title = doc.title || title; }
    }
    if (!bookId) return { error: 'Hardcover doesn\u2019t know this book yet.' };
    const d2 = await hcGraphQL('query { books(where: {id: {_eq: ' + bookId + '}}) { ' + ED_FIELDS + ' } }');
    const raw = (((d2 || {}).books || [])[0] || {}).editions || [];
    const seen = new Set(), out = [];
    raw.forEach(e => {
      const ei = epCleanISBN(e.isbn_13);
      if (!ei || seen.has(ei)) return; // editions without an ISBN can't be stored
      seen.add(ei);
      out.push({
        isbn: ei,
        publisher: (e.publisher && e.publisher.name) || '',
        year: String(e.release_date || '').slice(0, 4) || '',
        pages: Number(e.pages) || 0,
        cover: (e.image && e.image.url) || ''
      });
    });
    // Current edition first, then newest.
    const cur = epCleanISBN(book.isbn);
    out.sort((a, b) => (b.isbn === cur) - (a.isbn === cur) || (b.year || '').localeCompare(a.year || ''));
    return { title: title, editions: out };
  } catch (e) {
    return { error: (e && e.message) || 'Edition lookup failed.' };
  }
}

function closeEditionPicker() {
  if (typeof document === 'undefined') return;
  const ov = document.getElementById('edition-picker');
  if (ov) ov.remove();
}

function epSubLine(e) {
  return [e.year, e.pages ? e.pages + ' pages' : '', 'ISBN ' + e.isbn]
    .filter(Boolean).join(' · ');
}

function openEditionPicker(bookId) {
  if (typeof document === 'undefined') return;
  const b = (typeof library !== 'undefined' ? library : []).find(x => x.id === bookId);
  if (!b) return;
  closeEditionPicker();
  const ov = document.createElement('div');
  ov.className = 'cover-picker-backdrop';
  ov.id = 'edition-picker';
  ov.innerHTML =
    '<div class="cover-picker" role="dialog" aria-label="Choose an edition">' +
    '<h3 class="serif">' + icon('barcode') + ' Choose an edition</h3>' +
    '<p class="note" id="ep-note">Looking up editions…</p>' +
    '<div class="ep-list" id="ep-list"></div>' +
    '<div class="ep-manual"><input class="text-input" id="ep-isbn" inputmode="numeric" ' +
    'placeholder="Or enter an ISBN manually">' +
    '<button class="btn small" id="ep-apply">Use ISBN</button></div>' +
    '<div class="cp-actions" style="margin-top:12px">' +
    '<button class="btn ghost" id="ep-cancel">Cancel</button></div></div>';
  document.body.appendChild(ov);
  document.getElementById('ep-cancel').addEventListener('click', closeEditionPicker);
  ov.addEventListener('click', e => { if (e.target === ov) closeEditionPicker(); });
  document.getElementById('ep-apply').addEventListener('click', () => {
    const v = document.getElementById('ep-isbn').value;
    applyEdition(bookId, { isbn: v, cover: '' });
  });
  fetchEditionOptions(b).then(res => {
    const list = document.getElementById('ep-list');
    const note = document.getElementById('ep-note');
    if (!list) return; // picker was closed while loading
    if (res.error || !res.editions.length) {
      if (note) note.textContent = res.error || 'No editions found — enter the ISBN manually below.';
      return;
    }
    const cur = epCleanISBN(b.isbn);
    if (note) note.textContent = res.editions.length + ' edition' +
      (res.editions.length === 1 ? '' : 's') + ' of \u201C' + res.title + '\u201D — tap one to switch.';
    list.innerHTML = res.editions.map(e =>
      '<button class="ep-pick' + (e.isbn === cur ? ' current' : '') + '" data-isbn="' + esc(e.isbn) + '">' +
      (e.cover
        ? '<img class="ep-thumb" src="' + esc(e.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
        : '<span class="ep-thumb ep-nocover">' + icon('covers') + '</span>') +
      '<span class="ep-info"><span class="ep-pub">' + esc(e.publisher || 'Unknown publisher') + '</span>' +
      '<span class="ep-sub">' + esc(epSubLine(e)) + '</span></span>' +
      (e.isbn === cur ? '<span class="ep-badge">Current</span>' : '') +
      '</button>').join('');
    list.querySelectorAll('[data-isbn]').forEach(btn =>
      btn.addEventListener('click', () => {
        const pick = res.editions.find(e => e.isbn === btn.dataset.isbn);
        if (pick) applyEdition(bookId, pick);
      }));
  });
}

// Switch the book to the picked edition and refresh edition-level details.
async function applyEdition(bookId, ed) {
  const lib = typeof library !== 'undefined' ? library : [];
  const b = lib.find(x => x.id === bookId);
  const isbn = epCleanISBN(ed && ed.isbn);
  if (!b || !/^(?:\d{13}|\d{9}[\dX])$/.test(isbn)) {
    if (typeof toast === 'function') toast('That ISBN doesn\u2019t look valid');
    return false;
  }
  if (isbn === epCleanISBN(b.isbn)) { closeEditionPicker(); return true; } // no-op
  closeEditionPicker();
  b.isbn = isbn;
  b._mtime = Date.now();
  // Adopt the edition's cover art — unless she uploaded her own (data: URL).
  // v216: remote covers go through the canonical bucket (falls back to the
  // remote URL on any failure; the data: guard is double-covered by the helper).
  if (ed.cover && String(b.cover || '').indexOf('data:') !== 0) b.cover = await canonicalizeCoverUrl(ed.cover);
  const wasEnriched = b.hcEnriched === true;
  if (typeof editingId !== 'undefined' && editingId === bookId &&
      typeof editingDraft !== 'undefined' && editingDraft) {
    editingDraft.isbn = isbn;
    editingDraft.cover = b.cover;
  }
  if (typeof saveLibrary === 'function') saveLibrary();
  epRefreshModalBits(b);
  if (typeof toast === 'function') toast('\uD83D\uDCDA Edition updated — refreshing details…');
  try {
    // Only enrich books Hardcover hasn't seen: re-running the pass on an
    // enriched book would blend the same doc's rating in twice.
    if (!wasEnriched && typeof enrichHardcover === 'function') await enrichHardcover(b);
  } catch (e) {}
  try {
    if (typeof fetchPageCountByISBN === 'function') {
      const n = await fetchPageCountByISBN(b.isbn);
      if (n) {
        b.pageCount = n;
        if (typeof editingId !== 'undefined' && editingId === bookId &&
            typeof editingDraft !== 'undefined' && editingDraft) editingDraft.pageCount = n;
      }
    }
  } catch (e) {}
  try { if (typeof resolveWork === 'function') await resolveWork(b); } catch (e) {} // register the new edition
  b._mtime = Date.now();
  if (typeof saveLibrary === 'function') saveLibrary();
  epRefreshModalBits(b);
  if (typeof render === 'function') render();
  if (typeof toast === 'function') toast('\uD83D\uDCDA Edition updated ✨');
  return true;
}

// Patch the open book modal's edition bits without a full re-render.
function epRefreshModalBits(b) {
  if (typeof document === 'undefined' || !b) return;
  const btn = document.getElementById('m-edition');
  if (btn && typeof icon === 'function' && typeof esc === 'function') {
    btn.innerHTML = icon('barcode') + (b.isbn ? ' ISBN ' + esc(b.isbn) : ' Set edition');
  }
  if (typeof coverHTML === 'function') {
    const wrap = document.querySelector('#modal-root .d-cover .cover-wrap');
    if (wrap) wrap.outerHTML = coverHTML(b, 'd-cov');
  }
  const pages = document.getElementById('m-pagespan');
  if (b.pageCount && typeof icon === 'function') {
    const html = icon('reading') + ' ' + b.pageCount + ' pages';
    if (pages) pages.innerHTML = html;
    else if (btn && btn.parentNode) {
      const s = document.createElement('span');
      s.id = 'm-pagespan'; s.innerHTML = html;
      btn.parentNode.insertBefore(s, btn);
    }
  }
  const pc = document.getElementById('f-pagecount');
  if (pc && b.pageCount) pc.value = b.pageCount;
}
