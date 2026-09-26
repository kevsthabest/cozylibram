'use strict';

/* ---------------- shared metadata cache ---------------- */
// book_meta: one row per ISBN in Supabase, readable by every signed-in user.
// The first user to look up a book pays the API cost (Google Books / Open
// Library); everyone after that reads the cached metadata from Supabase
// instead of burning quota again. Entries go stale after 30 days (ratings
// drift over time) and are refreshed on the next lookup.
//
// Only signed-in users touch the cache — offline / signed-out users hit the
// APIs directly, exactly as before. The cache is best-effort: any failure
// falls back to the normal API path and never breaks adding a book.
//
// Not cached (v1): Hardcover enrichment (series, content warnings, moods).
// That still runs per book after adding; it can join this cache later.
const META_TTL_MS = 30 * 24 * 3600 * 1000;

// The fields every user needs from a lookup. User-specific fields (id,
// status, owned, ratings, myRating, tropes, progress, notes, dates) live in
// each user's own books rows and are never cached.
function metaSnapshot(book) {
  return {
    isbn: book.isbn || '',
    title: book.title || 'Unknown title',
    authors: book.authors || [],
    cover: book.cover || '',
    description: book.description || '',
    pageCount: book.pageCount || null,
    publishedDate: book.publishedDate || '',
    categories: book.categories || [],
    publicRating: book.publicRating == null ? null : book.publicRating,
    ratingsCount: book.ratingsCount || 0
  };
}

// Rebuild a fresh book-shaped object from a cached snapshot (new id,
// today's date, derived axes/tropes — same shape lookupISBN returns).
function bookFromMeta(snap, isbnHint) {
  const book = normalizeVolume({ volumeInfo: {} }, isbnHint || (snap && snap.isbn));
  if (!snap) return book;
  book.isbn = snap.isbn || book.isbn;
  book.title = snap.title || book.title;
  book.authors = Array.isArray(snap.authors) ? snap.authors : [];
  book.cover = snap.cover || book.cover;
  book.description = snap.description || '';
  book.pageCount = snap.pageCount || null;
  book.publishedDate = snap.publishedDate || '';
  book.categories = Array.isArray(snap.categories) ? snap.categories : [];
  book.publicRating = snap.publicRating == null ? null : snap.publicRating;
  book.ratingsCount = snap.ratingsCount || 0;
  book.axes = autoDetectAxes(book);
  seedTropes(book);
  return book;
}

// Fresh cached metadata for this ISBN, or null (miss / stale / offline).
async function metaCacheGet(isbn) {
  const clean = String(isbn || '').replace(/[^0-9X]/gi, '');
  if (!clean || !cloudUser) return null;
  const sb = await cloudClient().catch(() => null);
  if (!sb) return null;
  try {
    const { data, error } = await sb.from('book_meta')
      .select('data,fetched_at').eq('isbn', clean).maybeSingle();
    if (error || !data || !data.data) return null;
    if (Date.now() - new Date(data.fetched_at).getTime() > META_TTL_MS) return null; // stale
    return data.data;
  } catch (e) { return null; }
}

// Store a lookup result for future users. Fire-and-forget: never awaited by
// callers, and never throws.
async function metaCachePut(isbn, snap) {
  const clean = String(isbn || '').replace(/[^0-9X]/gi, '');
  if (!clean || !snap || !cloudUser) return;
  const sb = await cloudClient().catch(() => null);
  if (!sb) return;
  try {
    await sb.from('book_meta').upsert(
      { isbn: clean, data: snap, fetched_at: new Date().toISOString() },
      { onConflict: 'isbn' });
  } catch (e) { /* cache is best-effort */ }
}
