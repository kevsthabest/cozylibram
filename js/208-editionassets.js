'use strict';

/* v285: one-time local migration from legacy base64 edition faces to the
   binary IndexedDB asset store. The book record keeps references only. */

var EDITION_ASSET_MIGRATION_VERSION = 1;
var editionAssetMigrationRunning = false;

function editionAssetId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : ('asset-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

function editionAssetFaceRefs(book, appearance) {
  if (!book.editionFaceRefs) book.editionFaceRefs = {};
  if (!book.editionFaceRefs[appearance]) book.editionFaceRefs[appearance] = {};
  return book.editionFaceRefs[appearance];
}

async function editionAssetStoreDataUrl(book, appearance, face, dataUrl, source) {
  if (typeof idbAssetPut !== 'function' || typeof currentDb === 'undefined' || !currentDb) return null;
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) return null;
  var blob;
  try { blob = await (await fetch(dataUrl)).blob(); } catch (e) { return null; }
  if (!blob || !blob.size) return null;
  var id = editionAssetId();
  try {
    await idbAssetPut(currentDb, {
      id: id, blob: blob,
      isbn: (typeof spinePhotoISBN === 'function' ? spinePhotoISBN(book) : (book.isbn || null)),
      face: face, appearance: appearance, createdAt: Date.now(),
      source: source || 'legacy-migration'
    });
    return id;
  } catch (e) { return null; }
}

async function editionAssetMigrateBook(book) {
  if (!book || typeof idbAssetPut !== 'function' || typeof currentDb === 'undefined' || !currentDb) return false;
  var changed = false;
  var legacy = book.editionFaces || {};
  var appearances = Object.keys(legacy);

  for (var ai = 0; ai < appearances.length; ai++) {
    var ap = appearances[ai], faces = legacy[ap];
    if (!faces || typeof faces !== 'object') continue;
    var refFaces = editionAssetFaceRefs(book, ap);
    var keys = Object.keys(faces);
    for (var fi = 0; fi < keys.length; fi++) {
      var face = keys[fi], dataUrl = faces[face];
      if (refFaces[face]) { delete faces[face]; changed = true; continue; }
      var id = await editionAssetStoreDataUrl(book, ap, face, dataUrl, 'legacy-migration');
      if (id) { refFaces[face] = id; delete faces[face]; changed = true; }
    }
    if (!Object.keys(faces).length) { delete legacy[ap]; changed = true; }
  }

  var jacket = editionAssetFaceRefs(book, 'jacket');
  if (!jacket.spine && typeof book.spinePhoto === 'string' &&
      book.spinePhoto.indexOf('data:image/') === 0) {
    var sid = await editionAssetStoreDataUrl(book, 'jacket', 'spine', book.spinePhoto, 'legacy-spine-migration');
    if (sid) { jacket.spine = sid; changed = true; }
  }
  if (book.spinePhoto && jacket.spine) { delete book.spinePhoto; changed = true; }
  if (jacket.spine) book.spinePhotoAssetId = jacket.spine;

  if (!Object.keys(legacy).length) { delete book.editionFaces; changed = true; }
  if (!Object.keys(book.editionFaceRefs || {}).length) delete book.editionFaceRefs;
  return changed;
}

async function editionAssetsRunLocalMigration() {
  if (editionAssetMigrationRunning || typeof library === 'undefined') return false;
  if (typeof idbAssetPut !== 'function' || typeof currentDb === 'undefined' || !currentDb) return false;
  editionAssetMigrationRunning = true;
  try {
    var changed = false;
    for (var i = 0; i < library.length; i++) {
      if (await editionAssetMigrateBook(library[i])) changed = true;
    }
    if (changed && typeof saveLibrary === 'function') saveLibrary();
    try { localStorage.setItem('cozylibram.edition-assets-migration.v1',
      String(EDITION_ASSET_MIGRATION_VERSION)); } catch (e) {}
    if (changed && typeof renderShelf === 'function') renderShelf();
    return changed;
  } finally { editionAssetMigrationRunning = false; }
}

/* storageReady resolves after the active user's library is loaded. */
if (typeof storageReady !== 'undefined' && storageReady &&
    typeof storageReady.then === 'function') {
  storageReady.then(function () {
    return editionAssetsRunLocalMigration();
  }).catch(function () {});
}
