// Audiobook percentage logging (spec docs/audiobook-percent-spec.md):
// percent entries are unit-tagged log entries (u:'pct'; absence = pages),
// page statistics never sum percent spans as pages, current progress
// derives from the latest entry's unit (history unconverted), duration
// (audioSecs) comes from Hardcover or by hand and is never required.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in audiobook-percent tests'); };

require('./harness').loadApp(window);
window.confirmModal = () => Promise.resolve(true);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const ev = (expr) => { runInWindow(`window.__r = (${expr});`); return window.__r; };
const dayK = (off) => {
  const d = new Date(); d.setDate(d.getDate() + (off || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const todayK = dayK(0), yestK = dayK(-1);

const baseBook = (over) => Object.assign({
  id: 'x', isbn: '', title: 'T', authors: ['A'], cover: '', description: '',
  pageCount: 352, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0,
  status: 'reading', owned: 'owned', ratings: {}, axes: [], myRating: 0, tropes: [],
  tropesAuto: [], tropesAI: [], tropesAIDismissed: [], contentWarnings: [], moods: [],
  progress: 0, log: [], dateAdded: new Date().toISOString(), dateFinished: null, notes: ''
}, over || {});

/* ---------- seam: unit-tagged entries, unit-aware fold ---------- */
runInWindow(`library.length = 0; localStorage.clear();`);
window.__ab = baseBook({ id: 'ab1', format: 'audio' });
runInWindow(`library.push(window.__ab);`);
ev(`logProgress(window.__ab, 0, 40, 'pct')`);
let log = window.__ab.log;
ok('pct log creates a tagged entry', log.length === 1 && log[0].u === 'pct' && log[0].from === 0 && log[0].to === 40 && log[0].d === todayK);
ev(`logProgress(window.__ab, 40, 55, 'pct')`);
ok('second pct log folds into the same entry', window.__ab.log.length === 1 && window.__ab.log[0].to === 55);
ev(`logPages(window.__ab, 10, 60)`);
log = window.__ab.log;
ok('a page log on the same day is a separate, untagged entry', log.length === 2 && log[1].u === undefined && log[1].from === 10 && log[1].to === 60);
ok('the pct entry is untouched by the page fold', log[0].u === 'pct' && log[0].from === 0 && log[0].to === 55);
ok('pagesOnDay counts pages only', ev(`pagesOnDay(window.__ab, '${todayK}')`) === 50);
ok('loggedOnDay pct counts percent points', ev(`loggedOnDay(window.__ab, '${todayK}', 'pct')`) === 55);

/* ---------- unit derivation + display percent ---------- */
ok('progressUnitOf derives pct from the field', ev(`progressUnitOf({ progressUnit: 'pct', log: [] })`) === 'pct');
ok('progressUnitOf derives from the last entry when no field', ev(`progressUnitOf({ log: [{ d: '2026-01-01', from: 0, to: 10 }, { d: '2026-01-02', from: 0, to: 5, u: 'pct' }] })`) === 'pct');
ok('progressUnitOf defaults to page', ev(`progressUnitOf({ log: [] })`) === 'page');
ok('progressPctOf passes a percent through', ev(`progressPctOf({ progressUnit: 'pct', progress: 45 })`) === 45);
ok('progressPctOf divides pages by pageCount', ev(`progressPctOf({ progress: 88, pageCount: 352, log: [] })`) === 25);
ok('progressPctOf is null for a page book with no pageCount', ev(`progressPctOf({ progress: 88, pageCount: 0, log: [] })`) === null);

/* ---------- time remaining ---------- */
ok('audioLeftSecs: duration x remaining %', ev(`audioLeftSecs({ format: 'audio', audioSecs: 36000, progressUnit: 'pct', progress: 25, log: [] })`) === 27000);
ok('audioLeftSecs: null without a duration', ev(`audioLeftSecs({ format: 'audio', progressUnit: 'pct', progress: 25, log: [] })`) === null);
ok('audioLeftSecs: null in page unit', ev(`audioLeftSecs({ format: 'audio', audioSecs: 36000, progress: 88, pageCount: 352, log: [] })`) === null);
ok('audioLeftSecs: null at 100%', ev(`audioLeftSecs({ format: 'audio', audioSecs: 36000, progressUnit: 'pct', progress: 100, log: [] })`) === null);
ok('audioLeftSecs: null for non-audio', ev(`audioLeftSecs({ format: 'paperback', audioSecs: 36000, progressUnit: 'pct', progress: 25, log: [] })`) === null);
ok('fmtHMS shapes', ev(`fmtHMS(27000)`) === '7 h 30 min' && ev(`fmtHMS(3600)`) === '1 h' && ev(`fmtHMS(2520)`) === '42 min');

/* ---------- migrateBook coercion ---------- */
runInWindow(`window.__m1 = { id: 'm1', progressUnit: 'bogus', audioSecs: -5, log: [] };
  window.__m2 = { id: 'm2', progressUnit: 'pct', audioSecs: 3600, log: [] };`);
ev(`migrateBook(window.__m1)`);
ok('migrateBook drops a bogus progressUnit and a non-positive audioSecs',
  window.__m1.progressUnit === undefined && window.__m1.audioSecs === undefined);
ev(`migrateBook(window.__m2)`);
ok('migrateBook keeps pct + a positive audioSecs',
  window.__m2.progressUnit === 'pct' && window.__m2.audioSecs === 3600);

/* ---------- streaks count listening days ---------- */
window.__sb = baseBook({ id: 'sb1', format: 'audio', log: [
  { d: yestK, from: 0, to: 30, u: 'pct' }, { d: todayK, from: 30, to: 45, u: 'pct' }
] });
runInWindow(`library.length = 0; library.push(window.__sb);`);
ok('reading streak counts percent days', ev(`readingStreak()`) >= 2);

/* ---------- page statistics exclude percent spans ---------- */
window.__pb = baseBook({ id: 'pb1', format: 'paperback', log: [{ d: todayK, from: 100, to: 150 }] });
runInWindow(`library.push(window.__pb);`);
ok('pagesInRange sums pages only', ev(`pagesInRange('${todayK}', '${todayK}')`) === 50);
runInWindow(`window.__da = dayActivity(); window.__pm = pagesByDayMap();`);
ok('day activity counts the percent book as activity', (window.__pm[todayK] || {}).n === 2);
ok('pagesByDayMap adds no pages for percent spans', (window.__pm[todayK] || {}).pages === 50);
runInWindow(`window.__ms = detectMilestones(library);`);
ok('a 0->100% day does not trip the 100-page-day milestone',
  !window.__ms.some(m => m.id === 'pages-day-100'));
window.__big = baseBook({ id: 'big1', format: 'paperback', log: [{ d: todayK, from: 0, to: 120 }] });
runInWindow(`library.push(window.__big); window.__ms2 = detectMilestones(library);`);
ok('control: a real 120-page day trips the milestone',
  window.__ms2.some(m => m.id === 'pages-day-100'));

/* ---------- Hardcover duration + meta snapshot ---------- */
runInWindow(`window.__h1 = { id: 'h1', log: [] }; window.__h2 = { id: 'h2', audioSecs: 111, log: [] };`);
ev(`applyHardcoverDoc(window.__h1, { audio_seconds: 36000 })`);
ok('applyHardcoverDoc adopts audio_seconds when the book has none', window.__h1.audioSecs === 36000);
ev(`applyHardcoverDoc(window.__h2, { audio_seconds: 36000 })`);
ok('applyHardcoverDoc never overwrites a hand-set duration', window.__h2.audioSecs === 111);
runInWindow(`window.__snap = metaSnapshot({ isbn: '9780000000001', title: 'X', audioSecs: 7200 });
  window.__reb = bookFromMeta(window.__snap, '9780000000001');`);
ok('meta snapshot carries audioSecs', window.__snap.audioSecs === 7200);
ok('bookFromMeta restores audioSecs', window.__reb.audioSecs === 7200);

/* ---------- modal: percent surface on audiobooks ---------- */
const openBook = (b) => {
  window.__cur = b;
  runInWindow(`library.length = 0; library.push(window.__cur); openDetail('${b.id}');`);
};
const closeModal = () => { const x = q('#m-x'); if (x) x.click(); };

// §6 legacy: page history stands; the surface derives percent for display
// and the first percent write flips the unit without touching the old entry.
window.__leg = baseBook({ id: 'leg1', format: 'audio', progress: 176, log: [{ d: yestK, from: 100, to: 176 }] });
openBook(window.__leg);
ok('legacy audiobook derives page unit before any percent entry', ev(`progressUnitOf(window.__leg)`) === 'page');
const legSection = (q('#m-progress') || {}).textContent || '';
ok('quick section shows the derived percent for a legacy audiobook', legSection.includes('50%'));
qa('#m-progress [data-step]').find(x => x.dataset.step === '+10').click();
ok('stepper writes percent progress', window.__leg.progress === 60 && window.__leg.progressUnit === 'pct');
ok('the legacy page entry is byte-untouched', window.__leg.log.length === 2 &&
  window.__leg.log[0].u === undefined && window.__leg.log[0].from === 100 && window.__leg.log[0].to === 176);
ok('the new entry is a percent entry', window.__leg.log[1].u === 'pct' && window.__leg.log[1].from === 50 && window.__leg.log[1].to === 60);
closeModal();

// Fresh audiobook: direct % entry, time-left line with a duration set.
window.__au = baseBook({ id: 'au1', format: 'audio', pageCount: 0, audioSecs: 36000, progress: 0, log: [] });
openBook(window.__au);
const pq = q('#pq-page');
pq.value = '45';
q('#pq-set').click();
ok('direct percent entry sets progress + unit', window.__au.progress === 45 && window.__au.progressUnit === 'pct');
ok('direct percent entry logs a percent entry', window.__au.log.length === 1 &&
  window.__au.log[0].u === 'pct' && window.__au.log[0].from === 0 && window.__au.log[0].to === 45);
const auSection = (q('#m-progress') || {}).textContent || '';
ok('time remaining shows when a duration exists', auSection.includes('5 h 30 min') && auSection.includes('left'));
closeModal();

// Duration hand-edit round-trips through the form (hours/minutes -> seconds).
openBook(window.__au);
const dh = q('#f-dur-h'), dm = q('#f-dur-m');
ok('duration inputs exist for an audiobook', !!dh && !!dm);
if (dh && dm) { dh.value = '11'; dm.value = '30'; }
closeModal();
ok('duration edit saves as seconds', window.__au.audioSecs === 41400);

// Finishing an audiobook: status -> read lands on 100%, not pageCount.
openBook(window.__au);
const readBtn = qa('#f-status [data-s]').find(x => x.dataset.s === 'read');
if (readBtn) readBtn.click();
closeModal();
ok('marking an audiobook read sets progress to 100 (percent)', window.__au.progress === 100 && window.__au.progressUnit === 'pct');
ok('the finish is logged as a percent entry to 100',
  window.__au.log.some(e => e.u === 'pct' && e.to === 100));

/* ---------- remove today's entry (percent) ---------- */
window.__rm = baseBook({ id: 'rm1', format: 'audio', progress: 45, progressUnit: 'pct',
  log: [{ d: todayK, from: 20, to: 45, u: 'pct' }, { d: todayK, from: 0, to: 10 }] });
openBook(window.__rm);
const rmBtn = q('#m-rmlog');
ok('remove-today button offers the percent amount', !!rmBtn && rmBtn.textContent.includes('25%'));
if (rmBtn) {
  rmBtn.click();
  // confirmModal is stubbed true; the handler is async — let it settle.
  setTimeout(() => {
    ok('removing today removes the percent entry and keeps the page entry',
      window.__rm.log.length === 1 && window.__rm.log[0].u === undefined);
    ok('progress rolls back to the percent entry start', window.__rm.progress === 20);
    closeModal();
    finish();
  }, 50);
} else { closeModal(); finish(); }

/* ---------- non-audio parity ---------- */
function finish() {
  window.__pp = baseBook({ id: 'pp1', format: 'paperback', progress: 100, log: [] });
  openBook(window.__pp);
  qa('#m-progress [data-step]').find(x => x.dataset.step === '+10').click();
  ok('paper book stepper still logs pages, untagged', window.__pp.progress === 110 &&
    window.__pp.log.length === 1 && window.__pp.log[0].u === undefined && window.__pp.log[0].to === 110);
  closeModal();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
