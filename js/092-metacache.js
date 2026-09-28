'use strict';

/* ---------------- shared metadata cache ---------------- */
// book_meta: one row per ISBN in Supabase, readable by every signed-in user.
// The first user to look up a book pays the API cost (Google Books / Open
// Library / Hardcover); everyone after that reads the cached metadata from
// Supabase instead of burning quota again. Entries go stale after 30 days
// (ratings drift over time) and are refreshed on the next lookup.
//
// Only signed-in users touch the cache — offline / signed-out users hit the
// APIs directly, exactly as before. The cache is best-effort: any failure
// falls back to the normal API path and never breaks adding a book.
//
// v191: the snapshot now carries the Hardcover enrichment too (series, moods,
// content warnings, release date, hcId, blended community rating), so the
// second user to add a book gets full metadata with zero API calls — the
// Hardcover re-fetch is skipped for cache-hit books (the rating blend must
// happen exactly once, never twice).
//
// Write discipline (source-of-truth rule): book_meta is written ONLY from
// API results — lookupISBN's pristine response, and addBook's pristine-base
// + Hardcover-enrichment merge. Never from user-edited books, never from
// the backfill sweep, so a personal edit (custom title, notes, rating) can
// never leak into the canonical copy.
//
// v192: the row key is the ENTERED isbn (stashed as book._cacheKey), not the
// API-returned edition isbn — Google Books may match a different edition
// than the one typed, and re-entering the same isbn must always hit the
// same row. All puts for one add are awaited in order (lookup put, then the
// enriched put after Hardcover lands), so the pre-enrichment snapshot can
// never win a write-write race and clobber the enriched row.
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
    ratingsCount: book.ratingsCount || 0,
    // v191: Hardcover enrichment fields (canonical metadata, never user edits)
    series: book.series && book.series.name
      ? { name: book.series.name, position: book.series.position == null ? null : book.series.position }
      : null,
    contentWarnings: Array.isArray(book.contentWarnings) ? book.contentWarnings.slice() : [],
    moods: Array.isArray(book.moods) ? book.moods.slice() : [],
    releaseDate: book.releaseDate || '',
    hcId: book.hcId == null ? null : book.hcId,
    hcEnriched: book.hcEnriched === true
  };
}

// Enriched snapshot: pristine API base + Hardcover-only fields. `pristine`
// must be captured (via metaSnapshot) BEFORE enrichment runs, while the book
// is still an untouched API result — a title the user typed in the seconds
// between add and enrichment landing must never become canonical.
function enrichedSnapshot(pristine, book) {
  const snap = Object.assign({}, pristine, {
    categories: Array.isArray(book.categories) ? book.categories.slice() : (pristine.categories || []),
    publicRating: book.publicRating == null ? null : book.publicRating,
    ratingsCount: book.ratingsCount || 0,
    series: book.series && book.series.name
      ? { name: book.series.name, position: book.series.position == null ? null : book.series.position }
      : null,
    contentWarnings: Array.isArray(book.contentWarnings) ? book.contentWarnings.slice() : [],
    moods: Array.isArray(book.moods) ? book.moods.slice() : [],
    releaseDate: book.releaseDate || pristine.releaseDate || '',
    hcId: book.hcId == null ? null : book.hcId,
    hcEnriched: true
  });
  return snap;
}

// Store an enriched snapshot. Add-flow only (see write discipline above):
// the book is a pristine API result here, so user edits can't pollute the
// canonical cache. Keyed by the entered isbn (book._cacheKey) so the row the
// lookup created is the row the enrichment updates. Awaited by callers: the
// lookup's put is awaited before the add flow runs, so this upsert always
// lands after it and can never lose a write-write race to the
// pre-enrichment snapshot.
async function metaCachePutEnriched(pristine, book) {
  if (!book || !book.hcEnriched) return;
  const key = book._cacheKey || book.isbn;
  if (!key) return;
  await metaCachePut(key, enrichedSnapshot(pristine, book));
}

// Rebuild a fresh book-shaped object from a cached snapshot (new id,
// today's date, derived axes/tropes — same shape lookupISBN returns).
function bookFromMeta(snap, isbnHint) {
  const book = normalizeVolume({ volumeInfo: {} }, isbnHint || (snap && snap.isbn));
  if (!snap) return book;
  book.isbn = snap.isbn || book.isbn;
  // v192: remember which isbn key this row was read from — the enriched
  // upsert must update the same row, and the add flow's re-snapshot too.
  book._cacheKey = isbnHint || snap.isbn || '';
  book.title = snap.title || book.title;
  book.authors = Array.isArray(snap.authors) ? snap.authors : [];
  book.cover = snap.cover || book.cover;
  book.description = snap.description || '';
  book.pageCount = snap.pageCount || null;
  book.publishedDate = snap.publishedDate || '';
  book.categories = Array.isArray(snap.categories) ? snap.categories : [];
  book.publicRating = snap.publicRating == null ? null : snap.publicRating;
  book.ratingsCount = snap.ratingsCount || 0;
  // v191: restore Hardcover enrichment. hcEnriched=true means the community
  // rating was already blended once — the add flow must NOT re-enrich, or
  // Hardcover's votes would be counted twice.
  if (snap.series && snap.series.name)
    book.series = { name: snap.series.name, position: snap.series.position == null ? null : snap.series.position };
  if (Array.isArray(snap.contentWarnings) && snap.contentWarnings.length)
    book.contentWarnings = snap.contentWarnings.slice();
  if (Array.isArray(snap.moods) && snap.moods.length)
    book.moods = snap.moods.slice();
  if (snap.releaseDate) book.releaseDate = snap.releaseDate;
  if (snap.hcId != null) book.hcId = snap.hcId;
  if (snap.hcEnriched) book.hcEnriched = true;
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

// Store a lookup result for future users. Never throws; callers in the add
// flow await it so the later enriched upsert for the same row lands after it.
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
