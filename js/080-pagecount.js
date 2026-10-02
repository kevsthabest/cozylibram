'use strict';

/* ---------------- page-count lookup ---------------- */
// Fills total pages by ISBN when metadata didn't include it.
// v245: source order is Hardcover → Inventaire → Open Library →
// Google Books. Hardcover first (strongest catalog for these shelves);
// Google Books last (its ToS/attribution baggage, pending the v243
// usage review).
async function fetchPageCountByISBN(isbn) {
  const clean = String(isbn || '').replace(/[^0-9X]/gi, '');
  if (!clean) return null;
  // Someone may already have looked this book up: free page count, no APIs.
  try {
    const snap = await metaCacheGet(clean);
    if (snap && snap.pageCount > 0) return snap.pageCount;
  } catch (e) { /* fall through to APIs */ }
  const norm = s => String(s || '').replace(/[^0-9X]/gi, '').toUpperCase();
  const want13 = (typeof isbn13of === 'function') ? isbn13of(clean) : norm(clean);

  // 1. Hardcover — verify the doc's isbns[] holds the scanned ISBN first:
  // Typesense search is fuzzy (same guard as the v196 ISBN waterfall).
  try {
    if (typeof hcSearchDocs === 'function') {
      const docs = await hcSearchDocs(clean);
      const hit = docs.find(d => (d.isbns || []).some(i => {
        const n = norm(i);
        return n === norm(clean) || (typeof isbn13of === 'function' && isbn13of(n) === want13);
      }));
      if (hit && hit.pages > 0) { trackProvider('hardcover', 'pagecount'); return hit.pages; }
    }
  } catch (e) { /* fall through to Inventaire */ }
  // 2. Inventaire edition P1104 (pages) via the proxy — one call.
  try {
    if (typeof invByUris === 'function') {
      const d = await invByUris('isbn:' + clean);
      const edition = (d.entities || {})[((d.redirects || {})['isbn:' + clean])];
      const pages = edition ? invClaim(edition, 'P1104') : null;
      if (pages > 0) { trackProvider('inventaire', 'pagecount'); return +pages; }
    }
  } catch (e) { /* fall through to Open Library */ }
  // 3. Open Library editions (public API — plain fetch is fine).
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  };
  try {
    const ed = await get('https://openlibrary.org/isbn/' + clean + '.json');
    if (ed.number_of_pages > 0) { trackProvider('openlibrary', 'pagecount'); return ed.number_of_pages; }
    const s = await get('https://openlibrary.org/search.json?isbn=' + clean + '&fields=key&limit=10');
    for (const d of (s.docs || []).slice(0, 5)) {
      try {
        const e2 = await get('https://openlibrary.org' + d.key + '.json');
        if (e2.number_of_pages > 0) { trackProvider('openlibrary', 'pagecount'); return e2.number_of_pages; }
      } catch (e) { /* try next edition */ }
    }
  } catch (e) { /* fall through to Google Books */ }
  // 4. Google Books last — apiFetch (not plain fetch) so the v225 sign-in
  // gate passes. Plain fetch 401'd here, silently skipping GB since v225.
  try {
    const r = await apiFetch(gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=isbn:' + clean + '&maxResults=5'));
    if (!r.ok) throw new Error('http ' + r.status);
    const data = await r.json();
    const items = (data.items || []).map(i => i.volumeInfo || {});
    const ids = it => (it.industryIdentifiers || []).map(x => String(x.identifier || '').replace(/[^0-9X]/gi, ''));
    const hit = items.find(it => it.pageCount > 0 && ids(it).includes(clean)) ||
      items.find(it => it.pageCount > 0);
    if (hit) { trackProvider('gbooks', 'pagecount'); return hit.pageCount; }
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

