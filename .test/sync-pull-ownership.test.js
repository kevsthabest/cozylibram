// Regression pins for issue #327: a pull begun under account A must be
// discarded if the current account/slot at apply time is no longer A.
// cloudFirstSync and cloudRealtimePull checked cloudUser once at entry,
// then applied whatever their in-flight fetches returned to the live
// globals — a sign-out (or account switch) during the pull window landed
// A's library and tombstones in the now-current slot, and the adoption
// path (or the trailing push) carried them into account B.
//
// js/229's userStatePull legs have the same shape (settings + sections
// apply after awaits with no current-account re-check), so the settings
// leg is pinned here too.
//
// The interleaving is reproduced by gating the stubbed fetches: the
// pull starts under A, the test flips cloudUser/currentDb (and swaps in
// B's library, as a slot switch does), then releases A's responses.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in sync-pull-ownership tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
const mk = (id, extra) => `({ id: '${id}', isbn: '978${id}', title: 'Book ${id}', authors: ['A'], cover: '',
  description: '', pageCount: 100, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'tbr', owned: true, ratings: {}, axes: ['spice'], myRating: 0,
  tropes: [], progress: 0, dateAdded: new Date().toISOString(), dateFinished: null, notes: ''
  ${extra || ''} })`;

// A gated PostgREST-ish builder: eq() chains, awaiting it waits for the
// gate, then resolves with the given rows.
function gatedSelect(gate, rows) {
  const b = {
    eq: () => b,
    then: (res, rej) => gate.then(() => ({ data: rows, error: null })).then(res, rej),
  };
  return b;
}
function singleBuilder(result) {
  const b = {
    eq: () => b,
    maybeSingle: async () => result,
    then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
  };
  return b;
}

(async () => {
  const upsertedBooks = [];
  let releaseTombs, releaseBooks, releaseState;
  let tombsGate, booksGate, stateGate, stateRow;
  const resetGates = () => {
    tombsGate = new Promise(r => releaseTombs = r);
    booksGate = new Promise(r => releaseBooks = r);
    stateGate = new Promise(r => releaseState = r);
    stateRow = null;
  };
  resetGates();

  const aBookRows = [{ book_id: 'aOnly', isbn: null, data: { id: 'aOnly', title: 'A Only', _mtime: 900 } }];
  // An hour old: fresh enough to survive the push's 90-day tombstone prune,
  // so a recorded tombstone is still there to assert on afterwards.
  const aTombRows = [{ book_id: 'mine1', deleted_at: new Date(Date.now() - 3600000).toISOString() }];

  window.__sbStub = {
    from: (table) => {
      if (table === 'books') return {
        select: () => gatedSelect(booksGate, aBookRows),
        upsert: async (rows) => { upsertedBooks.push(...rows); return { error: null }; },
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
      };
      if (table === 'deleted_books') return {
        select: () => gatedSelect(tombsGate, aTombRows),
        upsert: async () => ({ error: null }),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
      };
      if (table === 'profiles') return {
        select: () => singleBuilder({ data: null, error: null }),
        upsert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      if (table === 'user_state') return {
        select: () => {
          const b = {
            eq: () => b,
            maybeSingle: () => stateGate.then(() => ({ data: stateRow, error: null })),
            then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej),
          };
          return b;
        },
        upsert: async () => ({ error: null }),
      };
      return {
        select: () => singleBuilder({ data: null, error: null }),
        upsert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
      };
    },
  };

  // ---------- S1: first sync discards A's pull after a mid-pull switch ----------
  releaseState(); // user-state legs resolve empty at once; only the books/tombstone fetches are gated here
  runInWindow(`library = [${mk('mine1')}]; tombstones = []; tombstoneFloor = 0;
    cloudUser = { id: 'uA' }; currentDb = { slot: 'A' };`);
  const p1 = probe(`cloudFirstSync()`);
  await tick(80); // profile + user-state legs done; the tombstone fetch is gated in flight
  runInWindow(`cloudUser = { id: 'uB' }; currentDb = { slot: 'B' };
    library = [${mk('bBook')}];`);
  releaseTombs(); releaseBooks();
  await p1;
  ok('#327 first sync: A\'s book is not merged into B\'s library',
    probe(`library.map(b => b.id).join(',')`) === 'bBook');
  ok('#327 first sync: A\'s tombstone is not recorded in B\'s slot',
    probe(`tombstones.length`) === 0);
  ok('#327 first sync: nothing from A is pushed under B',
    !upsertedBooks.some(r => r.book_id === 'aOnly'));

  // ---------- S2: realtime pull discards A's rows after a switch ----------
  // The switch lands while the TOMBSTONE fetch is in flight. (Landing it
  // during the books fetch instead would not reproduce the merge leg:
  // mergeCloudBooks(library, await ...) captures the library array before
  // the await suspends, so that one window is shielded by argument
  // evaluation order — the tombstone leg, whose applies read the live
  // globals inside applyTombstones, is not.)
  resetGates(); releaseState();
  runInWindow(`library = [${mk('mine1')}]; tombstones = []; tombstoneFloor = 0;
    cloudUser = { id: 'uA' }; currentDb = { slot: 'A' };`);
  const p2 = probe(`cloudRealtimePull()`);
  await tick(80); // the tombstone fetch is gated in flight
  runInWindow(`cloudUser = { id: 'uB' }; currentDb = { slot: 'B' };
    library = [${mk('bBook')}]; tombstones = [];`);
  releaseTombs(); releaseBooks();
  await p2;
  ok('#327 realtime pull: A\'s book is not merged into B\'s library',
    probe(`library.map(b => b.id).join(',')`) === 'bBook');
  ok('#327 realtime pull: A\'s tombstone is not recorded in B\'s slot',
    probe(`tombstones.length`) === 0);

  // ---------- S3: control — no switch, the same pull applies normally ----------
  resetGates(); releaseTombs(); releaseBooks(); releaseState();
  runInWindow(`library = [${mk('mine1')}]; tombstones = []; tombstoneFloor = 0;
    cloudUser = { id: 'uA' }; currentDb = { slot: 'A' };`);
  await probe(`cloudFirstSync()`);
  ok('#327 control: A\'s tombstone applies when the account never changed',
    probe(`tombstones.some(t => t.id === 'mine1')`) === true &&
    probe(`library.some(b => b.id === 'mine1')`) === false);
  ok('#327 control: A\'s book merges when the account never changed',
    probe(`library.some(b => b.id === 'aOnly')`) === true);

  // ---------- S4: js/229 settings pull discards after a mid-pull switch ----------
  resetGates();
  stateRow = { settings: { _at: 9999999999999, values: { theme: 'a-theme-value' } } };
  runInWindow(`localStorage.removeItem('theme'); cloudUser = { id: 'uA' };`);
  const p4 = probe(`userStatePullSettings()`);
  await tick(60); // uid captured; the user_state select is gated in flight
  runInWindow(`cloudUser = { id: 'uB' };`);
  releaseState();
  await p4;
  ok('#327 user-state settings: A\'s settings are not applied after a switch',
    probe(`localStorage.getItem('theme')`) !== 'a-theme-value');

  console.log('\n' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
