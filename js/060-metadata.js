'use strict';

/* ---------------- metadata ---------------- */
function normalizeVolume(item, isbnHint) {
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
    owned: true,
    ratings: {},
    myRating: 0,
    tropes: [],
    tropesAuto: [], // v81: auto-suggested tropes (never overwrites tropes)
    progress: 0,
    dateAdded: new Date().toISOString(),
    dateFinished: null,
    notes: ''
  };
  book.axes = autoDetectAxes(book);
  seedTropes(book);
  return book;
}

