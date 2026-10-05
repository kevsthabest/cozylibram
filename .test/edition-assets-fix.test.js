// Edition-assets fix pass (v284-v288): withdraw-via-assets, v285 migration
// preserving both spine photos, and editionAssetBlob IDB-first resolution
// with public-bucket network fallback.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);

// jsdom lacks webcrypto subtle and its Image never loads (so the quality
// analysis promise would hang); polyfill/stub both.
window.crypto.subtle = require('crypto').webcrypto.subtle;
run(`editionAnalyzeDataUrl = async function () { return null; };
// In-memory IDB stand-ins (jsdom has no IndexedDB; currentDb is null).
window.__idbStore = {};
currentDb = { mem: true };
window.__idbPutShouldThrow = false;
idbAssetPut = async function (db, rec) {
  if (window.__idbPutShouldThrow) throw new Error('simulated IDB failure');
  window.__idbStore[rec.id] = rec;
};
idbAssetGet = async function (db, id) { return window.__idbStore[id] || null; };
idbAssetDelete = async function (db, id) { delete window.__idbStore[id]; };
// fetch maps a data-URL's base64 tail to distinct bytes per capture.
window.fetch = async function (u) {
  var m = /base64,([A-Za-z0-9+/=]+)/.exec(u || '');
  var bytes = m ? m[1] : 'x';
  return { blob: async function () { return new Blob([bytes], { type: 'image/jpeg' }); } };
};`);

/* ---------- mock cloudClient: table-aware in-memory stores ---------- */
run(`window.__t = {
  assets: [], legacy: [],
  downloads: [], downloadShouldFail: false, signedIn: true,
};
function __tFind(table, filters) {
  var store = table === 'edition_assets' ? window.__t.assets : window.__t.legacy;
  return store.filter(function (r) {
    return Object.keys(filters).every(function (k) { return r[k] === filters[k]; });
  });
}
function __tChain(table) {
  var filters = {};
  var c = {};
  c.eq = function (k, v) { filters[k] = v; return c; };
  c.select = function () { return c; };
  c.maybeSingle = async function () {
    var rows = __tFind(table, filters);
    return { data: rows[0] || null, error: null };
  };
  c.delete = function () { c._del = true; return c; };
  c.then = function (resolve) {
    var rows = __tFind(table, filters);
    if (c._del) rows.forEach(function (r) {
      var store = table === 'edition_assets' ? window.__t.assets : window.__t.legacy;
      var i = store.indexOf(r);
      if (i !== -1) store.splice(i, 1);
    });
    resolve({ data: rows, error: null });
  };
  return c;
}
window.__tMoves = [];
cloudClient = async function () {
  return {
    auth: { getUser: async function () {
      return window.__t.signedIn ? { data: { user: { id: 'user-9' } } } : { data: { user: null } };
    } },
    from: function (t) { return __tChain(t); },
    storage: { from: function (b) { return {
      download: async function (path) {
        window.__t.downloads.push(b + ':' + path);
        if (window.__t.downloadShouldFail) return { data: null, error: { message: 'nope' } };
        return { data: new Blob(['netbytes'], { type: 'image/jpeg' }), error: null };
      },
      move: async function (from, to) { window.__tMoves.push([from, to]); return { error: null }; },
    }; } },
  };
};`);

(async () => {
  /* ---- 1. withdraw-via-assets: own candidates withdrawn via stored paths ---- */
  run(`window.__t.assets = [
    { id: 'cand-a1', isbn: '9780000000011', face: 'fore_edge', appearance: 'jacket',
      bucket: 'edition-images', path: 'fore_edge/jacket/stored-a.jpg', source_user_id: 'user-9' },
    { id: 'cand-a2', isbn: '9780000000011', face: 'fore_edge', appearance: 'jacket',
      bucket: 'edition-images', path: 'fore_edge/jacket/stored-b.jpg', source_user_id: 'user-9' },
    { id: 'cand-a3', isbn: '9780000000011', face: 'fore_edge', appearance: 'jacket',
      bucket: 'edition-images', path: 'fore_edge/jacket/stored-c.jpg', source_user_id: 'user-2' }
  ];
  window.__t.legacy = [
    { isbn: '9780000000011', face: 'fore_edge', appearance: 'jacket',
      bucket: 'edition-images', path: 'fore_edge/jacket/9780000000011.jpg', uploaded_by: 'user-9' }
  ];
  window.__tMoves = [];
  window.__wdDone = false;
  ecWithdrawFace({ id: 'w1', isbn13: '9780000000011', title: 'W' }, 'jacket', 'fore_edge')
    .then(function (r) { window.__wdRes = r; window.__wdDone = true; });`);
  const t0 = Date.now();
  while (run(`window.__wdDone`) !== true && Date.now() - t0 < 5000) {
    await new Promise(r => setTimeout(r, 20));
  }
  ok('withdraw deletes own candidates and returns true',
    run(`window.__wdRes`) === true &&
    run(`window.__t.assets`).length === 1 &&
    run(`window.__t.assets[0].id`) === 'cand-a3' &&
    run(`window.__t.legacy`).length === 0);
  ok('withdraw quarantines via the STORED path (never recomputed)',
    JSON.stringify(run(`window.__tMoves`)) === JSON.stringify([
      ['fore_edge/jacket/stored-a.jpg', 'quarantine/withdrawn-fore_edge-jacket-9780000000011-canda1.jpg'],
      ['fore_edge/jacket/stored-b.jpg', 'quarantine/withdrawn-fore_edge-jacket-9780000000011-canda2.jpg'],
    ]));

  /* ---- 2. withdraw returns false when nothing was withdrawn ---- */
  const wdFalse = await run(`(async function () {
    window.__t.assets = [
      { id: 'cand-b1', isbn: '9780000000012', face: 'spine', appearance: 'jacket',
        bucket: 'edition-images', path: 'spine/jacket/other.jpg', source_user_id: 'user-2' }
    ];
    window.__t.legacy = [
      { isbn: '9780000000012', face: 'spine', appearance: 'jacket', uploaded_by: 'user-2' }
    ];
    window.__tMoves = [];
    return await ecWithdrawFace({ id: 'w2', isbn13: '9780000000012' }, 'jacket', 'spine');
  })()`);
  ok("withdraw returns false when nothing belongs to the user (other's rows untouched)",
    wdFalse === false &&
    run(`window.__t.assets`).length === 1 &&
    run(`window.__t.legacy`).length === 1 &&
    run(`window.__tMoves`).length === 0);

  /* ---- 3. v285 migration preserves BOTH spine photos, no data loss ---- */
  const mig = await run(`(async function () {
    window.__idbStore = {};
    var book = {
      id: 'm1', title: 'Two Spines', isbn13: '9780000000013',
      editionFaces: { jacket: { spine: 'data:image/jpeg;base64,SCANSPINE' } },
      spinePhoto: 'data:image/jpeg;base64,LONGPRESS'
    };
    var changed = await editionAssetMigrateBook(book);
    return { changed: changed, book: book, storeKeys: Object.keys(window.__idbStore) };
  })()`);
  const mref = mig.book.editionFaceRefs && mig.book.editionFaceRefs.jacket && mig.book.editionFaceRefs.jacket.spine;
  ok('migration converts the scan spine to a canonical ref object',
    mig.changed === true &&
    mref && typeof mref === 'object' &&
    typeof mref.assetId === 'string' && mref.bucket === 'edition-images' &&
    /^spine\/jacket\/[0-9a-f]{64}\.jpg$/.test(mref.path) &&
    mig.book.editionFaces === undefined);
  ok('migration moves the long-press photo to spinePhotoAssetId (distinct asset)',
    typeof mig.book.spinePhotoAssetId === 'string' &&
    mig.book.spinePhotoAssetId !== mref.assetId &&
    mig.book.spinePhoto === undefined &&
    /^spine\/jacket\/[0-9a-f]{64}\.jpg$/.test(
      (mig.book.editionFaceRefs.jacket.spine || {}).path || ''));
  const blobTexts = await run(`(async function () {
    var texts = [];
    var keys = Object.keys(window.__idbStore);
    for (var i = 0; i < keys.length; i++) {
      texts.push(await window.__idbStore[keys[i]].blob.text());
    }
    return texts.sort();
  })()`);
  ok('migration loses no bytes (both captures land in IDB)',
    mig.storeKeys.length === 2 &&
    JSON.stringify(blobTexts) === JSON.stringify(['LONGPRESS', 'SCANSPINE']) &&
    mig.storeKeys.every(function (k) { return window.__idbStore[k].isbn === '9780000000013'; }));

  /* ---- 4. migration never deletes a data URL that failed to convert ---- */
  const migFail = await run(`(async function () {
    window.__idbPutShouldThrow = true;
    var book = {
      id: 'm2', title: 'Failing', isbn13: '9780000000014',
      editionFaces: { jacket: { spine: 'data:image/jpeg;base64,NEVERCONVERTS' } }
    };
    var changed = await editionAssetMigrateBook(book);
    window.__idbPutShouldThrow = false;
    return { changed: changed, book: book };
  })()`);
  ok('failed conversion leaves the data URL in place (no data loss)',
    migFail.changed === false &&
    migFail.book.editionFaces.jacket.spine === 'data:image/jpeg;base64,NEVERCONVERTS' &&
    !migFail.book.editionFaceRefs);

  /* ---- 5. editionAssetBlob: IDB hit returns without network ---- */
  run(`window.__t.downloads = [];
window.__idbStore = {};
window.__seedBlob = new Blob(['cached'], { type: 'image/jpeg' });`);
  const hitBlob = await run(`(async function () {
    await idbAssetPut(currentDb, { id: 'hit-1', blob: window.__seedBlob, isbn: '1',
      face: 'spine', appearance: 'jacket', createdAt: Date.now(), source: 'capture' });
    return await editionAssetBlob({ assetId: 'hit-1', bucket: 'edition-images', path: 'spine/jacket/x.jpg' });
  })()`);
  ok('editionAssetBlob resolves IDB-first (no download on hit)',
    hitBlob && await hitBlob.text() === 'cached' && run(`window.__t.downloads`).length === 0);

  /* ---- 6. editionAssetBlob: network fallback on IDB miss, then cached ---- */
  const missBlob = await run(`(async function () {
    var b = await editionAssetBlob({ assetId: 'miss-1', bucket: 'edition-images', path: 'spine/jacket/net.jpg' });
    return b ? { size: b.size, cached: !!(await idbAssetGet(currentDb, 'miss-1')) } : null;
  })()`);
  ok('editionAssetBlob falls back to the public bucket on IDB miss and caches locally',
    missBlob && missBlob.size === 8 &&
    JSON.stringify(run(`window.__t.downloads`)) === JSON.stringify(['edition-images:spine/jacket/net.jpg']) &&
    missBlob.cached === true &&
    run(`window.__idbStore['miss-1'].source`) === 'shared-pool');

  /* ---- 7. editionAssetBlob: string ref resolves via the stored record's path ---- */
  run(`window.__t.downloads = [];`);
  const strBlob = await run(`(async function () {
    // IDB record without bytes but with bucket+path (written by the migration
    // before this file learned the fallback) still reaches the bucket.
    await idbAssetPut(currentDb, { id: 'str-1', isbn: '1', face: 'spine',
      appearance: 'jacket', bucket: 'edition-images', path: 'spine/jacket/str.jpg',
      createdAt: Date.now(), source: 'legacy-migration' });
    return await editionAssetBlob('str-1');
  })()`);
  ok('editionAssetBlob string ref falls back through the stored record path',
    strBlob && await strBlob.text() === 'netbytes' &&
    JSON.stringify(run(`window.__t.downloads`)) === JSON.stringify(['edition-images:spine/jacket/str.jpg']));

  /* ---- 8. editionAssetBlob: null when unavailable ---- */
  const nulls = await run(`(async function () {
    var out = {};
    out.noRef = await editionAssetBlob(null);
    out.noPath = await editionAssetBlob({ assetId: 'np-1', bucket: null, path: null });
    window.__t.downloadShouldFail = true;
    out.dlFail = await editionAssetBlob({ assetId: 'df-1', bucket: 'edition-images', path: 'x.jpg' });
    window.__t.downloadShouldFail = false;
    return out;
  })()`);
  ok('editionAssetBlob returns null when unavailable (no ref, no path, download fails)',
    nulls.noRef === null && nulls.noPath === null && nulls.dlFail === null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
