'use strict';

/* js/060-metadata.js — Metadata: turn a Google Books volume into the
 * app's book-record shape.
 *
 * normalizeVolume(item, isbnHint) is the one function here, and every
 * path that creates a record from a Google Books result reaches it —
 * js/061's search, js/092's metadata cache, js/130's add flow and
 * js/180 all call it — so the record defaults live exactly once. A
 * record is born status 'tbr' / owned 'owned' with empty ratings and
 * trope lists: the wishlist is a derived pair over exactly those two
 * fields, never a status of its own (see ADR-001). ISBN-13 is
 * preferred over ISBN-10; the cover URL is upgraded to https and
 * falls back to OpenLibrary's by-ISBN cover when Google has none; a
 * full YYYY-MM-DD publishedDate doubles as releaseDate (it powers
 * Coming Soon) while a partial date does not.
 *
 * The new record's id, rating axes and seeded trope suggestions come
 * from wired imports — uid from js/050-helpers.js, autoDetectAxes
 * from js/020-ratings.js, seedTropes from js/061-gbooks-key.js (see
 * ADR-003).
 */
import { autoDetectAxes } from './020-ratings.js';
import { uid } from './050-helpers.js';
import { seedTropes } from './061-gbooks-key.js';

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
   file can see them. Its consumers — js/061-gbooks-key.js,
   js/092-metacache.js, js/130-add.js and js/180-settings.js — still
   read normalizeVolume as a global at runtime, so the bridge
   republishes exactly the pre-conversion public surface on window.
   Bare-name lookups resolve through the global object, so the callers
   need no changes. Module scripts are deferred, so the bridge is in
   place before any consumer can run. Remove a name from this bridge
   only when its last window-reading caller has wired the read as an
   import (ADR-003). */
window.normalizeVolume = normalizeVolume;
