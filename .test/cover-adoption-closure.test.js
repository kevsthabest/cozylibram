// Cover-storage PR C: adoption closure + boot straggler sweep.
// Every cover-setting flow that used to stop at a remote URL now
// enqueues background adoption (addBook hook, bulkAddBooks,
// importForeignBooks, Settings JSON import, the concierge's direct
// assignment), and sweepCoverAdoptions() (backfill round 2) adopts
// whatever is still non-canonical — remote URLs AND data: uploads.
// Adoption never blocks the caller, never throws, and on any failure
// the cover stays exactly as it was.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync((process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok') + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

try {
  Object.defineProperty(window, 'crypto',
    { value: require('crypto').webcrypto, configurable: true, writable: true });
} catch (e) { try { window.crypto = require('crypto').webcrypto; } catch (e2) {} }
if (!window.requestAnimationFrame) window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
window.fetch = async () => { throw new Error('no network in cover-closure tests'); };

// ---- fake Supabase client (cloudClient() returns window.__sbStub) ----
let sessionOn = true;
let uploads = [];
let uploadBehavior = 'ok'; // 'ok' | 'dup' | 'denied' | 'throw'
window.__sbStub = {
  auth: { getSession: async () => ({ data: { session: sessionOn ? { user: { id: 'u1' } } : null } }) },
  storage: { from: (bucket) => ({
    upload: async (name, blob, opts) => {
      uploads.push({ bucket, name, blob, opts });
      if (uploadBehavior === 'dup') return { error: { statusCode: '409', message: 'The resource already exists' } };
      if (uploadBehavior === 'denied') return { error: { status: 403, message: 'new row violates row-level security policy' } };
      if (uploadBehavior === 'throw') throw new Error('storage exploded');
      return { error: null };
    },
    getPublicUrl: (name) => ({ data: { publicUrl: 'https://x.supabase.co/storage/v1/object/public/covers/' + name } }),
  }) },
};

// ---- fake Image: loads unless the per-test mode fn says error ----
let imgLoads = [];
let imgBehavior = () => true;
window.Image = class {
  constructor() {
    this.naturalWidth = 1200; this.naturalHeight = 1800;
    this.width = 1200; this.height = 1800;
  }
  set src(v) {
    const s = String(v);
    imgLoads.push(s);
    const okLoad = imgBehavior(s);
    setTimeout(() => {
      if (okLoad) { if (this.onload) this.onload(); }
      else if (this.onerror) this.onerror();
    }, 0);
  }
};

// ---- fake canvas (same fixed red pixels as the adopter tests) ----
const fakePixels = new Uint8ClampedArray(24 * 24 * 4);
for (let i = 0; i < fakePixels.length; i += 4) {
  fakePixels[i] = 200; fakePixels[i + 1] = 30; fakePixels[i + 2] = 30; fakePixels[i + 3] = 255;
}
window.HTMLCanvasElement.prototype.getContext = function () {
  return { drawImage() {}, getImageData: () => ({ data: fakePixels }) };
};
window.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
  setTimeout(() => cb(new window.Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/webp' })), 0);
};

require('./harness').loadApp(window);
window.track = () => {};

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
let asyncCrash = null;
process.on('unhandledRejection', (e) => { asyncCrash = e; });
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 50));
const ev = (js) => window.eval(js);
const coverOf = (id) => ev(`(library.find(b => b.id === ${JSON.stringify(id)}) || {}).cover`);
const waitFor = async (fn, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 9000)) {
    if (await fn()) return true;
    await tick(60);
  }
  return !!(await fn());
};
const BUCKET_RE = /^https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/covers\/[0-9a-f]{64}\.webp$/;
const CANON = 'https://x.supabase.co/storage/v1/object/public/covers/already.jpg';
const mk = (id, cover) => ({
  id, isbn: '', title: 'Closure ' + id, authors: ['A ' + id], cover,
  description: '', pageCount: 100, publishedDate: '', categories: [],
  publicRating: null, ratingsCount: 0, status: 'tbr', ratings: {}, axes: ['spice'],
  myRating: 0, tropes: [], progress: 0, dateAdded: new Date().toISOString(),
  dateFinished: null, notes: '',
});
const resetLib = (books) => runInWindow(
  `library = ${JSON.stringify(books || [])}; try { saveLibrary({ noCloud: true }); } catch (e) {}`);
const resetStubs = () => {
  uploads = []; imgLoads = []; uploadBehavior = 'ok'; imgBehavior = () => true; sessionOn = true;
};

(async () => {
  ok('closure helper is defined', ev('typeof adoptBookCoverInBackground') === 'function');
  ok('boot sweep is defined', ev('typeof sweepCoverAdoptions') === 'function');
  runInWindow(`window.__toasts = []; toast = (m) => window.__toasts.push(m);`);

  // ---- addBook hook: remote cover adopts in the background ----
  resetStubs(); resetLib([]);
  const remote1 = 'https://img.hardcover.app/add1.jpg';
  runInWindow(`window.__added = addBook(${JSON.stringify(mk('add1', remote1))});`);
  ok('addBook returns the book synchronously', !!ev('window.__added && window.__added.id') );
  ok('addBook does not wait on adoption (cover still remote in the same tick)',
    coverOf('add1') === remote1);
  ok('addBook adoption enqueued (pixels loading)', await waitFor(() => imgLoads.length >= 1, 3000));
  ok('record repointed to the bucket once adoption lands',
    await waitFor(() => BUCKET_RE.test(coverOf('add1') || '')));
  ok('exactly one upload for the added cover', uploads.length === 1);

  // ---- addBook hook: failure leaves the cover exactly as added ----
  resetStubs(); resetLib([]);
  imgBehavior = (s) => !s.includes('deadadd');
  const dead = 'https://img.hardcover.app/deadadd.jpg';
  runInWindow(`addBook(${JSON.stringify(mk('add2', dead))});`);
  await tick(1500);
  ok('failed adoption leaves the added cover untouched', coverOf('add2') === dead && uploads.length === 0);

  // ---- addBook hook: data: uploads convert too ----
  resetStubs(); resetLib([]);
  runInWindow(`addBook(${JSON.stringify(mk('add3', 'data:image/jpeg;base64,AAAA'))});`);
  ok('data: cover adopts via the addBook hook',
    await waitFor(() => BUCKET_RE.test(coverOf('add3') || '')));

  // ---- addBook hook: coverless + canonical books cost nothing ----
  resetStubs(); resetLib([]);
  runInWindow(`addBook(${JSON.stringify(mk('add4', ''))}); addBook(${JSON.stringify(mk('add5', CANON))});`);
  await tick(700);
  ok('no loads or uploads for coverless/canonical adds', imgLoads.length === 0 && uploads.length === 0);

  // ---- race guard: a mid-flight cover change wins over the repoint ----
  resetStubs(); resetLib([]);
  const raceSrc = 'https://img.hardcover.app/race1.jpg';
  runInWindow(`addBook(${JSON.stringify(mk('race1', raceSrc))});`);
  runInWindow(`(function(){ const b = library.find(x => x.id === 'race1');` +
    ` if (b) { b.cover = 'https://img.hardcover.app/manual.jpg'; } })();`);
  await tick(1800);
  ok('mid-flight cover change is not overwritten by the adoption repoint',
    coverOf('race1') === 'https://img.hardcover.app/manual.jpg');

  // ---- race guard: a mid-flight delete is not resurrected ----
  resetStubs(); resetLib([]);
  runInWindow(`addBook(${JSON.stringify(mk('race2', 'https://img.hardcover.app/race2.jpg'))});`);
  runInWindow(`library = library.filter(x => x.id !== 'race2');`);
  await tick(1800);
  ok('mid-flight delete is not resurrected by the adoption repoint',
    ev(`library.some(x => x.id === 'race2')`) === false);

  // ---- Bookmory import: fresh data: covers enqueue adoption too ----
  resetStubs(); resetLib([]);
  runInWindow(`importBookmoryBooks([${JSON.stringify(mk('bm1', 'data:image/jpeg;base64,BBBB'))}], [], null);`);
  ok('Bookmory-imported data: cover adopts in the background',
    await waitFor(() => BUCKET_RE.test(coverOf('bm1') || '')));

  // ---- bulkAddBooks: every new book enqueued, batch never waits ----
  resetStubs(); resetLib([mk('dupe', '')]);
  const bulkRes = ev(`bulkAddBooks([${JSON.stringify(mk('blk1', 'https://img.hardcover.app/blk1.jpg'))},` +
    `${JSON.stringify(mk('blk2', 'https://books.google.com/blk2.jpg'))},` +
    `${JSON.stringify(mk('dupe', 'https://img.hardcover.app/dupe.jpg'))}], 'test')`);
  ok('bulkAddBooks adds the two new books', bulkRes === 2);
  ok('bulk covers repoint after the batch returns',
    await waitFor(() => BUCKET_RE.test(coverOf('blk1') || '') && BUCKET_RE.test(coverOf('blk2') || '')));
  ok('one upload per bulk cover, dupe untouched', uploads.length === 2 && coverOf('dupe') === '');

  // ---- importForeignBooks: imported covers enqueued ----
  resetStubs(); resetLib([]);
  const imp = ev(`importForeignBooks([{ title: 'Imp One', authors: ['Au'], isbn: '9780000000011', cover: 'https://covers.openlibrary.org/imp1.jpg', status: 'tbr' }], 'Test', 'test', null).added`);
  ok('importForeignBooks adds the book', imp === 1);
  ok('imported cover adopts in the background',
    await waitFor(() => BUCKET_RE.test(ev(`(library.find(b => b.title === 'Imp One') || {}).cover`) || '')));

  // ---- Settings JSON import: imported covers enqueued ----
  resetStubs(); resetLib([]);
  runInWindow(`view = 'settings'; renderSettings();`);
  await tick(100);
  const fileInput = window.document.getElementById('bk-file');
  ok('settings backup file input exists', !!fileInput);
  const backup = JSON.stringify({ books: [{ title: 'Backup One', authors: ['Bk'], isbn: '9780000000022', cover: 'https://img.hardcover.app/bk1.jpg' }] });
  const file = new window.File([backup], 'backup.json', { type: 'application/json' });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event('change'));
  ok('settings import lands the book',
    await waitFor(() => !!ev(`library.find(b => b.title === 'Backup One')`), 4000));
  ok('settings-imported cover adopts in the background',
    await waitFor(() => BUCKET_RE.test(ev(`(library.find(b => b.title === 'Backup One') || {}).cover`) || '')));

  // ---- concierge: direct cover assignment fires adoption ----
  resetStubs(); resetLib([Object.assign(mk('miss1', ''), { title: 'Miss One' })]);
  runInWindow(`
    searchBooks = async () => [{ title: 'Miss One', authors: ['A miss1'], cover: 'https://img.hardcover.app/picked.jpg', isbn: '9780000000033' }];
    if (!document.getElementById('ic-overlay')) openImportConcierge();
    IC.step = 'coverreport'; IC.formatId = 'goodreads'; IC.rawRows = 1;
    IC.classified = []; IC.unreadable = 0; IC.imported = [];
    IC.coverTotal = 1; IC.coverMissIds = ['miss1'];
    icRender();
  `);
  await tick(100);
  const findBtn = window.document.querySelector('[data-ic-findone="miss1"]');
  ok('concierge miss row renders a Find button', !!findBtn);
  findBtn.click();
  await tick(300);
  const pickBtn = window.document.querySelector('[data-ic-pick^="miss1:"]');
  ok('concierge find renders a pickable result', !!pickBtn);
  pickBtn.click();
  ok('picked cover assigned immediately (remote, adoption pending)',
    coverOf('miss1') === 'https://img.hardcover.app/picked.jpg');
  ok('concierge-assigned cover adopts in the background',
    await waitFor(() => BUCKET_RE.test(coverOf('miss1') || '')));
  runInWindow(`icClose();`);

  // ---- sweep: straggler set = remote + data:, canonical/none/blob skipped ----
  resetStubs();
  resetLib([
    mk('s-canon', CANON),
    mk('s-remote', 'https://img.hardcover.app/sweep1.jpg'),
    mk('s-data', 'data:image/png;base64,BBBB'),
    mk('s-none', ''),
    mk('s-blob', 'blob:https://x/1'),
  ]);
  ev('sweepCoverAdoptions()');
  ok('sweep adopts the remote straggler',
    await waitFor(() => BUCKET_RE.test(coverOf('s-remote') || '')));
  ok('sweep adopts the data: straggler',
    await waitFor(() => BUCKET_RE.test(coverOf('s-data') || '')));
  ok('sweep leaves canonical/empty/blob covers alone',
    coverOf('s-canon') === CANON && coverOf('s-none') === '' && coverOf('s-blob') === 'blob:https://x/1');
  ok('sweep uploaded only the two stragglers', uploads.length === 2);

  // ---- sweep: adopted library is a cheap no-op on the next boot ----
  resetStubs();
  ev('sweepCoverAdoptions()');
  await tick(800);
  ok('repeat sweep on an adopted library does no work', imgLoads.length === 0 && uploads.length === 0);

  // ---- sweep: kill-switch, offline, signed-out all mean no work ----
  resetStubs(); resetLib([mk('g1', 'https://img.hardcover.app/gated1.jpg')]);
  window.localStorage.setItem('cozylibram.coverWebp', 'off');
  ev('sweepCoverAdoptions()');
  await tick(700);
  ok('kill-switch: sweep does nothing', imgLoads.length === 0 && uploads.length === 0 &&
    coverOf('g1') === 'https://img.hardcover.app/gated1.jpg');
  window.localStorage.removeItem('cozylibram.coverWebp');

  let onLineSet = false;
  try {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    onLineSet = window.navigator.onLine === false;
  } catch (e) {}
  if (onLineSet) {
    ev('sweepCoverAdoptions()');
    await tick(700);
    ok('offline: sweep does nothing', imgLoads.length === 0 && uploads.length === 0);
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  } else {
    ok('offline: sweep does nothing (navigator.onLine not stub-able here)', true);
  }

  sessionOn = false;
  ev('sweepCoverAdoptions()');
  await tick(900);
  ok('signed out: sweep converts nothing', uploads.length === 0 &&
    coverOf('g1') === 'https://img.hardcover.app/gated1.jpg');
  sessionOn = true;

  // ---- sweep: resumable — a failed pass leaves the set for next boot ----
  resetStubs(); resetLib([mk('r1', 'https://img.hardcover.app/resume1.jpg')]);
  uploadBehavior = 'denied';
  ev('sweepCoverAdoptions()');
  await tick(1200);
  ok('denied pass leaves the straggler in place', coverOf('r1') === 'https://img.hardcover.app/resume1.jpg');
  uploadBehavior = 'ok';
  ev('sweepCoverAdoptions()');
  ok('next sweep resumes and adopts it',
    await waitFor(() => BUCKET_RE.test(coverOf('r1') || '')));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (asyncCrash) { console.log('ASYNC CRASH:', asyncCrash); fail++; }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
