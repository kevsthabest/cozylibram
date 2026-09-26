'use strict';

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
    const data = await get(gbUrl('https://www.googleapis.com/books/v1/volumes?q=isbn:' + clean + '&maxResults=5'));
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

