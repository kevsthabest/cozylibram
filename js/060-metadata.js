'use strict';

/* ---------------- metadata ---------------- */
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */

export function normalizeVolume(item, isbnHint) {
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
    owned: 'owned',
    ratings: {},
    myRating: 0,
    tropes: [],
    tropesAuto: [], // v81: auto-suggested tropes (never overwrites tropes)
    progress: 0,
    dateAdded: new Date().toISOString(),
    dateFinished: null,
    notes: ''
  };
  // v113: a full publishedDate doubles as the release date (powers Coming soon).
  if (/^\d{4}-\d{2}-\d{2}$/.test(v.publishedDate || '')) book.releaseDate = v.publishedDate.slice(0, 10);
  book.axes = autoDetectAxes(book);
  seedTropes(book);
  return book;
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/061-gbooks-key.js, js/092-metacache.js,
   js/130-add.js and js/180-settings.js — reach these names at
   runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.normalizeVolume = normalizeVolume;
