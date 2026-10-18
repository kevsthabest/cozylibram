// Regression pins for issue #336 (bounded replace, ruled option (b)):
// mergeAssign was a pure Object.assign, so a field deleted on one
// device survived on every peer and was pushed back to the deleter on
// their next edit. A winning merge now reconciles deletions for the
// known deletion-managed fields ONLY — spinePhoto, spinePhotoAssetId,
// editionFaceRefs, editionFaces, shelfPose, plus migrateBook's legacy
// drop (spice). Absence of any other key never deletes.
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP_DIR = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const { loadApp } = require(path.join(APP_DIR, '.test', 'harness'));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

(async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  loadApp(window);
  const run = (js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
  const probe = (js) => window.eval(js);
  await probe('storageReady');

  const row = (id, data) => ({ book_id: id, isbn: null, data });
  const merge = (rows) => probe(`mergeCloudBooks(library, ${JSON.stringify(rows)})`);

  // Newer remote that dropped the managed fields (and an unmanaged one).
  run(`library = [{ id: 'x', title: 'X', _mtime: 100,
    spinePhoto: 'data:photo', spinePhotoAssetId: 'asset-1',
    editionFaceRefs: ['f1'], editionFaces: { front: 'e1' }, shelfPose: { x: 1 },
    myCustomField: 'keep-me' }];
   tombstones = []; tombstoneFloor = 0;`);
  merge([row('x', { id: 'x', title: 'X2', _mtime: 200 })]);
  ok('#336 winning merge deletes spinePhoto when the winner dropped it',
    probe(`library[0].spinePhoto`) === undefined);
  ok('#336 winning merge deletes spinePhotoAssetId, editionFaceRefs, editionFaces, shelfPose',
    probe(`library[0].spinePhotoAssetId`) === undefined &&
    probe(`library[0].editionFaceRefs`) === undefined &&
    probe(`library[0].editionFaces`) === undefined &&
    probe(`library[0].shelfPose`) === undefined);
  ok('#336 absence of an unmanaged field never deletes it',
    probe(`library[0].myCustomField`) === 'keep-me');
  ok('#336 the winning record still overwrites as before',
    probe(`library[0].title`) === 'X2');

  // Older remote without the field: no win, no reconcile.
  run(`library = [{ id: 'y', title: 'Y', _mtime: 300, spinePhoto: 'data:photo' }];`);
  merge([row('y', { id: 'y', title: 'Y-old', _mtime: 200 })]);
  ok('#336 a losing (older) record deletes nothing',
    probe(`library[0].spinePhoto`) === 'data:photo' && probe(`library[0].title`) === 'Y');

  // Newer remote WITH the field: value wins (control).
  run(`library = [{ id: 'z', title: 'Z', _mtime: 100, spinePhoto: 'data:old' }];`);
  merge([row('z', { id: 'z', title: 'Z', _mtime: 200, spinePhoto: 'data:new' })]);
  ok('#336 a winner carrying the field overwrites it',
    probe(`library[0].spinePhoto`) === 'data:new');

  // The reconciled deletion persists locally without becoming a local
  // edit (persist-only, not dirty) — the PR #382 split carries it.
  run(`library = [{ id: 'w', title: 'W', _mtime: 100, spinePhoto: 'data:photo' }];`);
  merge([row('w', { id: 'w', title: 'W', _mtime: 200 })]);
  ok('#336 the reconciled book is persist-only, not dirty',
    probe(`persistOnlyBooks.has(library[0])`) === true &&
    probe(`dirtyBooks.has(library[0])`) === false);

  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
