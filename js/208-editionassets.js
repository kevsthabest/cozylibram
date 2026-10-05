'use strict';

/* v285: one-time local migration from legacy base64 edition faces to the
   binary IndexedDB asset store. The book record keeps references only.

   v285-fix:
   - M1: the long-press spine photo (book.spinePhoto) and the scan spine
     (editionFaces.jacket.spine) are two different captures — migrate BOTH.
     A data URL is never deleted unless it was successfully converted.
   - M2: every migrated face is also uploaded to the shared pool at its
     content-addressed path, with an edition_assets candidate row, so other
     devices can adopt it. Signed-out / offline runs keep local-only assets.
   - m15: the "already migrated" marker lives in the slot's IDB kv store
     (not a single global localStorage flag), so each storage slot migrates
     independently — including after a user switch.
   - Canonical ref shape (shared with ecSaveAll and the shelf/3D readers):
       editionFaceRefs[appearance][face] =
         { assetId, bucket, path, width, height }
     path is content-addressed: <face>/<appearance>/<sha256>.jpg. */

var EDITION_ASSET_MIGRATION_VERSION = 1;
var EDITION_ASSET_MIGRATION_KV_KEY = 'edition-assets-migration-v1';
var EDITION_ASSET_SHARE_BUCKET = 'edition-images';
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

/* Normalize a face ref to its asset id. Tolerates the pre-fix plain-string
   shape so a partially-migrated book stays idempotent. */
function editionAssetRefId(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  return ref.assetId || null;
}

function editionAssetSha256Hex(blob) {
  return blob.arrayBuffer().then(function (bytes) {
    if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.subtle.digest) return null;
    return crypto.subtle.digest('SHA-256', bytes);
  }).then(function (digest) {
    if (!digest) return null;
    return Array.from(new Uint8Array(digest)).map(function (x) {
      return x.toString(16).padStart(2, '0');
    }).join('');
  }).catch(function () { return null; });
}

/* Convert one legacy data URL into a local IDB asset plus a canonical ref.
   Delete-only-after-successful-put: returns null on any failure and the
   caller must leave the data URL in place. `seen` dedupes identical captures
   within one book (sha256 -> ref) so the same bytes are stored/shared once. */
async function editionAssetConvertFace(book, appearance, face, dataUrl, seen) {
  if (typeof idbAssetPut !== 'function' || typeof currentDb === 'undefined' || !currentDb) return null;
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) return null;
  var blob;
  try { blob = await (await fetch(dataUrl)).blob(); } catch (e) { return null; }
  if (!blob || !blob.size) return null;
  var hash = await editionAssetSha256Hex(blob);
  if (hash && seen && seen[hash]) return seen[hash];
  var id = editionAssetId();
  var path = hash ? (face + '/' + appearance + '/' + hash + '.jpg') : null;
  try {
    await idbAssetPut(currentDb, {
      id: id, blob: blob,
      isbn: (typeof spinePhotoISBN === 'function' ? spinePhotoISBN(book) : (book.isbn || null)),
      face: face, appearance: appearance,
      bucket: EDITION_ASSET_SHARE_BUCKET, path: path,
      createdAt: Date.now(),
      source: 'legacy-migration'
    });
  } catch (e) { return null; }
  var width = null, height = null;
  if (typeof editionAnalyzeDataUrl === 'function') {
    try {
      var q = await editionAnalyzeDataUrl(dataUrl);
      if (q) { width = q.width || null; height = q.height || null; }
    } catch (e) {}
  }
  var ref = {
    assetId: id,
    bucket: EDITION_ASSET_SHARE_BUCKET,
    path: path,
    width: width,
    height: height
  };
  if (hash && seen) seen[hash] = ref;
  /* M2: best-effort share. Signed-out, offline, or pool errors keep the
     local-only asset — a later capture/share can upload it. Never throws. */
  try { await editionAssetShareFace(book, appearance, face, blob, width, height); } catch (e) {}
  return ref;
}

/* Contribute one migrated face to the shared pool: upload the bytes at the
   content-addressed path (upsert:false; 409/exists is fine — identical bytes
   mean identical paths) and record an edition_assets candidate row so other
   devices can adopt it. Returns false (silently) when sharing is impossible;
   the local asset is unaffected. */
async function editionAssetShareFace(book, appearance, face, blob, width, height) {
  try {
    if (!blob || !blob.size) return false;
    if (typeof cloudClient !== 'function') return false;
    var sb = await cloudClient().catch(function () { return null; });
    if (!sb) return false;
    var uid = null;
    try {
      var ug = await sb.auth.getUser();
      uid = (ug && ug.data && ug.data.user) ? ug.data.user.id : null;
    } catch (e) { uid = null; }
    if (!uid) return false; // signed out: local-only
    var isbn = (typeof spinePhotoISBN === 'function')
      ? spinePhotoISBN(book)
      : (book && (book.isbn13 || book.isbn) || null);
    if (!isbn) return false;
    var editionId = null;
    try {
      var er = await sb.from('editions').select('id').eq('isbn', isbn).maybeSingle();
      editionId = (er && er.data) ? er.data.id : null;
    } catch (e) { editionId = null; }
    if (!editionId) return false;

    var bytes = await blob.arrayBuffer();
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    var hash = Array.from(new Uint8Array(digest)).map(function (x) {
      return x.toString(16).padStart(2, '0');
    }).join('');
    if (!hash) return false;
    var path = face + '/' + appearance + '/' + hash + '.jpg';

    var existing = null;
    try {
      existing = await sb.from('edition_assets').select('id')
        .eq('bucket', EDITION_ASSET_SHARE_BUCKET).eq('path', path).maybeSingle();
    } catch (e) { existing = null; }
    if (existing && existing.data) return true; // bytes (and a row) already up

    var up = await sb.storage.from(EDITION_ASSET_SHARE_BUCKET).upload(path, blob, {
      contentType: 'image/jpeg', upsert: false
    });
    if (up.error && !(up.error.statusCode === '409' || up.error.statusCode === 409 ||
        /exists/i.test(up.error.message || ''))) return false;

    var row = await sb.from('edition_assets').insert({
      edition_id: editionId,
      isbn: isbn,
      face: face,
      appearance: appearance,
      bucket: EDITION_ASSET_SHARE_BUCKET,
      path: path,
      width: width || null,
      height: height || null,
      format: 'image/jpeg',
      byte_size: blob.size,
      sha256: hash,
      source_type: 'migration',
      source_user_id: uid,
      quality_score: null,
      sharpness_score: null,
      exposure_score: null,
      perspective_score: null,
      coverage_score: null,
      glare_score: null,
      resolution_score: null,
      stability_score: null
    }).select('id').single();
    if (row.error) {
      // Lost a race with another client uploading the same content.
      var raced = null;
      try {
        raced = await sb.from('edition_assets').select('id')
          .eq('bucket', EDITION_ASSET_SHARE_BUCKET).eq('path', path).maybeSingle();
      } catch (e) { raced = null; }
      if (!raced || !raced.data) return false;
    }
    return true;
  } catch (e) { return false; }
}

// Resolves an edition-face reference to a Blob. Accepts both ref shapes:
//   - string: a bare assetId (this is what existing editionFaceRefs entries
//     in the wild look like). Resolved from IDB by id; the public-bucket
//     fallback additionally applies when the stored IDB record carries
//     bucket+path (records written by this file do).
//   - object: { assetId, bucket, path } (canonical). IDB-first; on miss the
//     blob is downloaded from the public storage bucket (via cloudClient
//     storage download, anon-safe since the bucket is public) and cached in
//     IDB keyed by assetId.
// Returns null when unavailable — callers fall back to generated placeholders.
async function editionAssetBlob(ref) {
  if (!ref) return null;
  var isString = typeof ref === 'string';
  var assetId = isString ? ref : ref.assetId;
  if (!assetId) return null;
  var haveIdb = typeof idbAssetGet === 'function' &&
    typeof currentDb !== 'undefined' && !!currentDb;
  var record = null;
  if (haveIdb) {
    try { record = await idbAssetGet(currentDb, assetId); }
    catch (e) { record = null; }
    if (record && record.blob) return record.blob;
  }
  // Bucket fallback: prefer the ref's own bucket/path, else the IDB record's
  // (so a bare-string ref can still reach the public bucket when this file
  // wrote the record). A string ref with no stored path is IDB-only.
  var bucket = (!isString && ref.bucket) || (record && record.bucket) || null;
  var path = (!isString && ref.path) || (record && record.path) || null;
  if (!bucket || !path || typeof cloudClient !== 'function') return null;
  var sb = null;
  try { sb = await cloudClient().catch(function () { return null; }); }
  catch (e) { sb = null; }
  if (!sb) return null;
  try {
    var dl = await sb.storage.from(bucket).download(path);
    if (dl.error || !dl.data) return null;
    var blob = dl.data;
    if (haveIdb && typeof idbAssetPut === 'function') {
      try {
        await idbAssetPut(currentDb, {
          id: assetId, blob: blob,
          isbn: (record && record.isbn) || null,
          face: (record && record.face) || null,
          appearance: (record && record.appearance) || null,
          bucket: bucket, path: path,
          createdAt: Date.now(), source: 'shared-pool'
        });
      } catch (e) {}
    }
    return blob;
  } catch (e) { return null; }
}

async function editionAssetMigrateBook(book) {
  if (!book || typeof idbAssetPut !== 'function' || typeof currentDb === 'undefined' || !currentDb) return false;
  var changed = false;
  var legacy = book.editionFaces || {};
  var appearances = Object.keys(legacy);
  var seen = {}; // sha256 -> ref: dedupes identical captures within this book

  for (var ai = 0; ai < appearances.length; ai++) {
    var ap = appearances[ai], faces = legacy[ap];
    if (!faces || typeof faces !== 'object') continue;
    // Read-only view first: never create the refs structure speculatively —
    // a failed conversion must leave the book (and `changed`) untouched.
    var refFaces = (book.editionFaceRefs && book.editionFaceRefs[ap]) || {};
    var keys = Object.keys(faces);
    for (var fi = 0; fi < keys.length; fi++) {
      var face = keys[fi], dataUrl = faces[face];
      // Idempotent: a previous pass already converted this face — drop the
      // leftover data URL only because the asset exists.
      if (editionAssetRefId(refFaces[face])) { delete faces[face]; changed = true; continue; }
      var ref = await editionAssetConvertFace(book, ap, face, dataUrl, seen);
      if (ref) { editionAssetFaceRefs(book, ap)[face] = ref; delete faces[face]; changed = true; }
    }
    if (!Object.keys(faces).length) { delete legacy[ap]; changed = true; }
  }

  /* M1: the long-press spine photo and the scan spine are different captures;
     migrate both. The shelf renderer prefers spinePhotoAssetId, so the
     explicit long-press photo keeps the shelf slot; the scan spine lives in
     the face refs. Neither data URL is deleted without a successful put. */
  if (typeof book.spinePhoto === 'string' && book.spinePhoto.indexOf('data:image/') === 0) {
    var photoRef = await editionAssetConvertFace(book, 'jacket', 'spine', book.spinePhoto, seen);
    if (photoRef) {
      book.spinePhotoAssetId = photoRef.assetId;
      delete book.spinePhoto;
      changed = true;
    }
  }
  var jacket = (book.editionFaceRefs && book.editionFaceRefs.jacket) || {};
  var scanSpineId = editionAssetRefId(jacket.spine);
  if (scanSpineId && !book.spinePhotoAssetId) {
    // Scan-only book: the scan spine doubles as the shelf spine photo.
    book.spinePhotoAssetId = scanSpineId;
    changed = true;
  }
  if (book.editionFaceRefs && book.editionFaceRefs.jacket &&
      !Object.keys(book.editionFaceRefs.jacket).length) {
    delete book.editionFaceRefs.jacket;
    changed = true;
  }

  if (book.editionFaces && !Object.keys(legacy).length) { delete book.editionFaces; changed = true; }
  if (book.editionFaceRefs && !Object.keys(book.editionFaceRefs).length) {
    delete book.editionFaceRefs;
    changed = true;
  }
  return changed;
}

/* m15: the "already migrated" marker is per storage slot (IDB kv), not a
   global localStorage flag — every slot migrates its own legacy URLs. */
async function editionAssetsSlotMigrated() {
  if (typeof idbKvGet !== 'function' || typeof currentDb === 'undefined' || !currentDb) return false;
  try {
    return (await idbKvGet(currentDb, EDITION_ASSET_MIGRATION_KV_KEY)) === EDITION_ASSET_MIGRATION_VERSION;
  } catch (e) { return false; }
}

async function editionAssetsRunLocalMigration() {
  if (editionAssetMigrationRunning || typeof library === 'undefined') return false;
  if (typeof idbAssetPut !== 'function' || typeof currentDb === 'undefined' || !currentDb) return false;
  editionAssetMigrationRunning = true;
  try {
    // IDB unavailable above returns early (no marker) so the next load retries.
    if (await editionAssetsSlotMigrated()) return false;
    var changed = false;
    for (var i = 0; i < library.length; i++) {
      if (await editionAssetMigrateBook(library[i])) changed = true;
    }
    if (changed && typeof saveLibrary === 'function') saveLibrary();
    try { await idbKvPut(currentDb, EDITION_ASSET_MIGRATION_KV_KEY, EDITION_ASSET_MIGRATION_VERSION); } catch (e) {}
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

/* m15: the boot hook above fires once. A user switch (js/040-storage.js
   setLocalUserIdb) opens a fresh slot whose legacy data URLs would otherwise
   never migrate — wrap the switch so the per-slot migration runs for the new
   slot too. 040 itself is untouched. */
if (typeof setLocalUserIdb === 'function' && !setLocalUserIdb.__editionAssetsWrapped) {
  var __editionAssetsSetLocalUserIdbOrig = setLocalUserIdb;
  setLocalUserIdb = async function (uid) {
    var r = await __editionAssetsSetLocalUserIdbOrig(uid);
    try { await editionAssetsRunLocalMigration(); } catch (e) {}
    return r;
  };
  setLocalUserIdb.__editionAssetsWrapped = true;
}
