// Remediation Batch D (v536) pins:
//  1. Analytics allowlist (audit #15): the nine v525–v528 social/sharing
//     events survive track(); unknown events still drop.
//  2. DNF-reason insert (audit #12): the payload carries user_id; a
//     signed-out save skips the server insert instead of failing it.
//  3. checkLibraryMetadata entry point (audit #9): Settings → Library
//     renders the control; runMetadataCheck drives the existing check
//     into the v476 model (blanks fill, conflicts store for review).
//  4. Milestone pinning (Strategist S3): pin persists, roams via the
//     milestone_state user_state section, renders on the Milestones
//     surface, unpin clears, pinning an unearned milestone is refused.
//  5. Room arrange (Strategist S4): VERIFIED WORKING — end-to-end pins
//     through shelf3dRoom() for title / series / author / mine.
//  6. Chronicles + Room + roulette nits (UX P3-14/P3-15): pace figures
//     agree by construction; "1 book" singular; honest empty states for
//     longest streak and the rated records pair; a finished book's
//     progress backfills to complete in migrateBook; German genre
//     labels normalize at display time in bookGenres.
//  7. Recommended transience (UX P3-9): two renders, one sweep; an add
//     and a dismissal each drop their book from the re-render with no
//     re-sweep; an explicit refresh re-sweeps.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in remediation-d tests'); };
window.confirm = () => true;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const probe = (js) => window.eval(js);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));
const ls = window.localStorage;

const mk = (id, title, status, extra) => Object.assign({
  id, isbn: '', title, authors: ['Au ' + id], cover: '', description: '', pageCount: 200,
  publishedDate: '', categories: [], publicRating: null, ratingsCount: 0,
  status: status || 'tbr', owned: 'owned', ratings: {}, axes: ['spice'], myRating: 0,
  tropes: [], tropesAuto: [], progress: 0, dateAdded: new Date().toISOString(),
  dateFinished: null, notes: '', favorite: false, series: null, log: [], _mtime: 0,
}, extra || {});
const setLibrary = (books) => runInWindow('library = ' + JSON.stringify(books) + ';');

(async () => {

  /* ================= 1. analytics allowlist ================= */
  runInWindow("cloudUser = { id: 'u-d', email: 't@t.t' };");
  const nine = ['toy_compose_opened', 'toy_sent', 'buddy_invite_sent', 'buddy_accepted',
    'buddy_ended', 'reader_blocked', 'milestone_shared', 'shelfie_shared', 'reco_viewed'];
  for (const ev of nine) {
    ok('allowlist: ' + ev + ' survives track()', probe("track('" + ev + "')") === true);
  }
  ok('allowlist: milestone_shared carries its id prop',
    probe("track('milestone_shared', { id: 'books-finished-1', title: 'strip me' })") === true);
  ok('allowlist: unknown events still drop', probe("track('definitely_not_real')") === false);
  const defs = probe('EVENT_DEFS');
  ok('allowlist: all nine defs present with categories',
    nine.every(ev => defs[ev]) &&
    defs.buddy_invite_sent.c === 'social' && defs.reco_viewed.c === 'discovery' &&
    JSON.stringify(defs.reco_viewed.p) === '["count","embedded"]');
  ok('allowlist: stale buddy-read NOTE is gone',
    !fs.readFileSync(path.join(ROOT, 'js/065-analytics.js'), 'utf8').includes('buddy_read_created'));

  /* ================= 2. DNF-reason insert ================= */
  setLibrary([mk('dnf1', 'DNF Book', 'dnf', { pageCount: 400, progress: 100 })]);
  window.__dnfInserts = [];
  runInWindow('supa = { from: (t) => ({ insert: (row) => { window.__dnfInserts.push({ t: t, row: row }); return Promise.resolve({ error: null }); } }) };');
  runInWindow("cloudUser = { id: 'user-42' };");
  probe("saveDnfReason(library[0], 'too_slow')");
  ok('dnf: insert targets dnf_reasons', window.__dnfInserts.length === 1 && window.__dnfInserts[0].t === 'dnf_reasons');
  ok('dnf: insert payload includes user_id', window.__dnfInserts[0] && window.__dnfInserts[0].row.user_id === 'user-42');
  ok('dnf: insert payload keeps book/reason/progress',
    window.__dnfInserts[0] && window.__dnfInserts[0].row.book_id === 'dnf1' &&
    window.__dnfInserts[0].row.reason === 'too_slow' && window.__dnfInserts[0].row.progress_pct === 25);
  window.__dnfInserts = [];
  runInWindow('cloudUser = null;');
  probe("saveDnfReason(library[0], 'wrong_mood')");
  ok('dnf: signed out, the doomed insert is skipped entirely', window.__dnfInserts.length === 0);
  ok('dnf: the on-book reason still records locally', probe('library[0].dnfReason') === 'wrong_mood');

  /* ================= 3. metadata check entry point ================= */
  const isbnA = '9780306406157', isbnB = '9783161484100';
  setLibrary([
    mk('mc1', 'Blank Pages', 'read', { isbn: isbnA, pageCount: 0, publishedDate: '' }),
    mk('mc2', 'My Title', 'read', { isbn: isbnB, pageCount: 300 }),
    mk('mc3', 'No ISBN', 'read', { isbn: '' }),
  ]);
  window.fetchMetaByISBN = async (isbn) => {
    if (isbn === isbnA) return { title: 'Blank Pages', authors: ['Au mc1'], pageCount: 321, year: 2020, cover: '' };
    if (isbn === isbnB) return { title: 'Their Title', authors: ['Au mc2'], pageCount: 300, year: '', cover: '' };
    return null;
  };
  const summary = await probe('runMetadataCheck()');
  ok('metadata: runner checks only ISBN books', summary && summary.checked === 2);
  ok('metadata: blank pageCount auto-filled via the v476 path',
    summary.filled === 1 && probe("library.find(b => b.id === 'mc1').pageCount") === 321);
  ok('metadata: a differing book is counted for review', summary.differ === 1);
  ok('metadata: conflict stored for the compare sheet',
    !!probe("metaConflictFor('mc2')") && probe("metaConflictFor('mc2').flags[0].field") === 'title');
  ok('metadata: manual run stamps the sweep gate',
    Number(ls.getItem('spicyshelves.meta_compare_at') || 0) > 0);
  ls.removeItem('spicyshelves.meta_conflicts.v1');
  runInWindow('metaConflicts = {};');
  // The Settings → Library door exists and is wired to the runner.
  probe('renderSettings()');
  const metaBtn = window.document.getElementById('bk-metacheck');
  ok('metadata: Settings → Library renders the check button', !!metaBtn);
  const outEl = window.document.getElementById('bk-metacheck-out');
  metaBtn.click();
  await tick(1000); // the check paces 350ms between books, like the sweep
  ok('metadata: clicking the button runs the check and reports',
    !!outEl && /Checked 2 books/.test(outEl.textContent || ''));

  /* ================= 4. milestone pinning ================= */
  ls.setItem('cozylibram.milestones', JSON.stringify({
    'books-finished-1': { achievedAt: '2026-09-01T00:00:00.000Z', seen: true },
    'books-finished-10': { achievedAt: '2026-10-01T00:00:00.000Z', seen: true },
  }));
  ls.removeItem('cozylibram.milestonePin.v1');
  ok('pin: none by default', probe('milestonePin()') === null);
  ok('pin: an unearned milestone cannot be pinned', probe("milestoneSetPin('books-finished-25')") === false);
  ok('pin: a bogus id cannot be pinned', probe("milestoneSetPin('not-a-milestone')") === false);
  ok('pin: still none after refused pins', probe('milestonePin()') === null);
  ok('pin: an earned milestone pins', probe("milestoneSetPin('books-finished-1')") === true);
  ok('pin: persists on the device key', ls.getItem('cozylibram.milestonePin.v1') === 'books-finished-1');
  ok('pin: reads back', probe('milestonePin()') === 'books-finished-1');
  // Renders on the Milestones surface: banner + toggles.
  probe('renderMilestones()');
  const viewHtml = window.document.getElementById('view').innerHTML;
  ok('pin: pinned banner renders on the Milestones surface',
    viewHtml.includes('pinned-row') && viewHtml.includes('Pinned'));
  ok('pin: earned rows carry the pin toggle',
    window.document.querySelectorAll('.ms-pin').length >= 2);
  ok('pin: the pinned toggle shows its pinned state',
    !!window.document.querySelector('.ms-pin.pinned'));
  // Unpin through the UI toggle clears everything.
  window.document.querySelector('.ms-pin.pinned').click();
  ok('pin: unpin via the toggle clears the pin', probe('milestonePin()') === null &&
    ls.getItem('cozylibram.milestonePin.v1') === null);
  ok('pin: banner gone after unpin',
    !window.document.getElementById('view').innerHTML.includes('pinned-row'));
  // Roams: push carries the milestone_state section; a newer remote
  // section applies on pull (device B).
  probe("milestoneSetPin('books-finished-1')");
  const fake = {
    rows: new Map(), upserts: [],
    from() {
      const self = this;
      return {
        select(cols) {
          const b = { _uid: null, eq(c, v) { b._uid = v; return b; },
            maybeSingle: async () => {
              const r = self.rows.get(b._uid);
              if (!r) return { data: null, error: null };
              const out = {};
              String(cols).split(',').forEach(c => { c = c.trim(); out[c] = (c in r) ? r[c] : {}; });
              return { data: out, error: null };
            } };
          return b;
        },
        upsert: async (row) => {
          self.upserts.push(row);
          self.rows.set(row.user_id, Object.assign({}, self.rows.get(row.user_id) || {}, row));
          return { error: null };
        },
      };
    },
  };
  window.cloudClient = async () => fake;
  runInWindow("cloudUser = { id: 'pin-user' };");
  await probe('userStatePull()'); // baseline first, as sign-in does
  await probe('userStatePush()');
  const up = fake.upserts[fake.upserts.length - 1];
  ok('pin: push upserts the milestone_state section with the pinned id',
    !!up && !!up.milestone_state && up.milestone_state.value === 'books-finished-1' &&
    typeof up.milestone_state._at === 'number');
  ls.removeItem('cozylibram.milestonePin.v1');
  const meta = JSON.parse(ls.getItem('cozylibram.userstate.v1.pin-user') || '{}');
  if (meta.sections && meta.sections.milestone) meta.sections.milestone.at = 0;
  ls.setItem('cozylibram.userstate.v1.pin-user', JSON.stringify(meta));
  fake.rows.set('pin-user', Object.assign({}, fake.rows.get('pin-user') || {}, {
    user_id: 'pin-user',
    milestone_state: { _at: Date.now() + 60000, value: 'books-finished-10' },
  }));
  await probe('userStatePullSections(null)');
  ok('pin: a newer remote pin applies on the other device',
    ls.getItem('cozylibram.milestonePin.v1') === 'books-finished-10');
  ok('pin: applied pin reads as earned', probe('milestonePin()') === 'books-finished-10');
  runInWindow('cloudUser = null;');

  /* ================= 5. Room arrange — verified working ================= */
  setLibrary([
    mk('ar1', 'The Zebra', 'read', { authors: ['Mina'] }),
    mk('ar2', 'apple pie', 'read', { authors: ['Zed'], series: { name: 'Saga', position: 2 } }),
    mk('ar3', 'Mango', 'read', { authors: ['Ann'], series: { name: 'Saga', position: 1 } }),
  ]);
  runInWindow("shelfGroup = 'read';");
  const roomTitles = () => probe('shelf3dRoom().all.map(b => b.title).join("|")');
  probe("shelf3dSetArrangeMode('mine')");
  ok('arrange: mine keeps the placed order', roomTitles() === 'The Zebra|apple pie|Mango');
  probe("shelf3dSetArrangeMode('title')");
  ok('arrange: title visibly reorders (leading articles stripped)',
    roomTitles() === 'apple pie|Mango|The Zebra');
  probe("shelf3dSetArrangeMode('series')");
  ok('arrange: series groups in position order, standalone last',
    roomTitles() === 'Mango|apple pie|The Zebra');
  probe("shelf3dSetArrangeMode('author')");
  ok('arrange: author reorders by first author', roomTitles() === 'Mango|The Zebra|apple pie');
  probe("shelf3dSetArrangeMode('mine')");
  ok('arrange: back to mine restores the placed order', roomTitles() === 'The Zebra|apple pie|Mango');

  /* ================= 6a. pace figures agree ================= */
  const todayKey = probe("(function(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()");
  setLibrary([mk('pc1', 'Pace Book', 'read', {
    pageCount: 1000, dateFinished: new Date().toISOString(),
    log: [{ d: todayKey, from: 0, to: 1000 }],
  })]);
  const pace = probe('paceHTML()');
  const paceNums = Array.from(pace.matchAll(/<div class="n">([\d,]+)<\/div>/g)).map(m => Number(m[1].replace(/,/g, '')));
  ok('pace: 1000 pages / 30 days renders a day figure', paceNums[0] === 33);
  ok('pace: week is day x 7 by construction (231, not 233)', paceNums[1] === 231 && paceNums[0] * 7 === paceNums[1]);
  ok('pace: month derives from the same rounded day', paceNums[2] === Math.round(33 * 30.44));

  /* ================= 6c. honest empty states ================= */
  setLibrary([mk('pc2', 'Quiet Book', 'read', { pageCount: 300 })]);
  const pace2 = probe('paceHTML()');
  ok('streak: longest streak has an honest empty state', pace2.includes('No streak yet'));
  ok('streak: no bare dash tile remains in the pace block', !pace2.includes('<b>–</b>'));
  const recs = probe('recordsHTML()');
  ok('records: unrated library gets an honest rated-pair row',
    recs.includes('No ratings yet') && recs.includes('Longest'));
  setLibrary([mk('pc3', 'Rated Book', 'read', { pageCount: 300, myRating: 2 })]);
  const recs2 = probe('recordsHTML()');
  ok('records: rated library shows the real pair again',
    recs2.includes('Highest rated') && recs2.includes('Lowest rated') && !recs2.includes('No ratings yet'));

  /* ================= 6b. "1 book", not "1 books" ================= */
  const dna = probe('dnaSectionHTML()');
  ok('portrait: one read book reads "1 book"', dna.includes('1 book ·') && !dna.includes('1 books'));
  ok('portrait: the share-card line is singular-safe too (source pin)',
    fs.readFileSync(path.join(ROOT, 'js/212-dna.js'), 'utf8')
      .includes("(d.n === 1 ? ' book' : ' books') + ' analyzed'"));

  /* ================= 6d. finished books do not read as untouched ================= */
  const mig = (o) => probe('migrateBook(' + JSON.stringify(o) + ')');
  const baseMig = { id: 'm1', authors: [], tropes: [], tropesAuto: [], tropesAI: [], tropesAIDismissed: [] };
  ok('progress: a finished book at 0 backfills to complete',
    mig(Object.assign({}, baseMig, { status: 'read', pageCount: 416, progress: 0 })).progress === 416);
  ok('progress: a finished book with no progress field backfills',
    mig(Object.assign({}, baseMig, { status: 'read', pageCount: 416 })).progress === 416);
  ok('progress: previouslyRead stays exempt (no page record by design)',
    mig(Object.assign({}, baseMig, { status: 'read', pageCount: 416, progress: 0, previouslyRead: true })).progress === 0);
  ok('progress: a partial value is the reader\u2019s own record and stays',
    mig(Object.assign({}, baseMig, { status: 'read', pageCount: 416, progress: 200 })).progress === 200);
  ok('progress: a book still being read is untouched',
    mig(Object.assign({}, baseMig, { status: 'reading', pageCount: 416, progress: 0 })).progress === 0);

  /* ================= 6e. foreign genre labels normalize at display ================= */
  ok('genres: "Action & Abenteuer" displays as "Action & Adventure"',
    JSON.stringify(probe("bookGenres({ categories: ['Action & Abenteuer'] })")) === '["Action & Adventure"]');
  ok('genres: German and English variants dedupe to one chip',
    JSON.stringify(probe("bookGenres({ categories: ['Action & Adventure', 'Action & Abenteuer'] })")) === '["Action & Adventure"]');
  ok('genres: stored categories are never rewritten',
    probe("(function(){ const b = { categories: ['Action & Abenteuer'] }; bookGenres(b); return b.categories[0]; })()") === 'Action & Abenteuer');

  /* ================= 7. Recommended-list transience ================= */
  window.document.body.insertAdjacentHTML('beforeend', '<div id="disc-reco"></div>');
  setLibrary([mk('p1', 'Loved One', 'read', { authors: ['Author A'], myRating: 5 })]);
  let sweepCalls = 0;
  const hcBook = (id, title) => ({
    id, title, description: 'A book.', release_date: '2026-01-01', image: { url: '' },
    contributions: [{ author: { name: 'Author A' } }],
    default_physical_edition: { isbn_13: '978111111111' + id },
  });
  // Count only genuine sweep queries: the add flow legitimately spends
  // other Hardcover calls (trope suggestions, page-count backfill) that
  // are not re-sweeps.
  window.hcGraphQL = async (q) => {
    if (String(q).includes('canonical_id')) { sweepCalls++; return { books: [hcBook(101, 'New Find'), hcBook(102, 'Second Find')] }; }
    return { books: [] };
  };
  window.topLovedAuthors = () => ['Author A'];
  window.hcReady = () => true;
  window.resolveWork = async (b) => 'w:' + b.id;
  window.fetchWorkEmbeddings = async () => ({ 'w:p1': [1, 0] });
  window.embedTextsClient = async (texts) => texts.map(() => [1, 0]);
  const recoBox = () => window.document.getElementById('disc-reco');
  await probe('refreshRecommendations()');
  const afterFirst = sweepCalls;
  ok('reco: first render sweeps and lists both finds',
    afterFirst > 0 && recoBox().textContent.includes('New Find') && recoBox().textContent.includes('Second Find'));
  await probe('refreshRecommendations()');
  ok('reco: second render performs NO new sweep', sweepCalls === afterFirst);
  ok('reco: second render still lists both finds',
    recoBox().textContent.includes('New Find') && recoBox().textContent.includes('Second Find'));
  // Add the first find through the real card button, then re-render.
  const addBtn = recoBox().querySelector('[data-add]');
  ok('reco: the rendered card has an add button', !!addBtn);
  addBtn.click();
  await tick(30);
  ok('reco: the add landed in the library', probe("library.some(b => b.title === 'New Find')") === true);
  await probe('refreshRecommendations()');
  ok('reco: after the add, the re-render drops the added book with NO re-sweep',
    sweepCalls === afterFirst && !recoBox().textContent.includes('New Find') &&
    recoBox().textContent.includes('Second Find'));
  // Dismiss the other find; re-render drops it too, still no sweep.
  await probe("recoDismiss('hc:102')");
  await probe('refreshRecommendations()');
  ok('reco: after a dismissal, the re-render drops it with NO re-sweep',
    sweepCalls === afterFirst && !recoBox().textContent.includes('Second Find'));
  // Explicit refresh always re-sweeps.
  await probe('refreshRecommendations(true)');
  ok('reco: an explicit refresh re-sweeps', sweepCalls > afterFirst);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
