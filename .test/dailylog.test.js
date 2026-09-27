// Daily reading-log tests: stepper/save logging, calendar covers,
// day detail page ranges, daily stats card, streak, migration.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in dailylog tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const todayK = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
const yestK = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();

runInWindow(`localStorage.clear();
  window.__b = { id: 'dl1', isbn: '', title: 'Log Book', authors: ['A'], cover: 'https://x/y.jpg',
    description: '', pageCount: 400, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0,
    status: 'reading', ratings: {}, axes: [], myRating: 0, tropes: [], progress: 100,
    dateAdded: new Date().toISOString(), dateFinished: null, notes: '' };
  library.push(window.__b);`);

function step(d) {
  qa('#m-progress [data-step]').find(x => x.dataset.step === d).click();
}

// 1. stepper creates + extends today's log entry
runInWindow(`openDetail('dl1');`);
step('+10');
let e = window.__b.log;
ok('stepper creates log entry', e.length === 1 && e[0].d === todayK && e[0].from === 100 && e[0].to === 110);
step('+10');
ok('second stepper extends same entry', window.__b.log.length === 1 && window.__b.log[0].from === 100 && window.__b.log[0].to === 120);

// 2. manual save logs the delta without double counting
q('#f-progress').value = '150';
q('#m-save').click();
e = window.__b.log;
ok('save extends entry to new page', e.length === 1 && e[0].from === 100 && e[0].to === 150);

// 3. downward correction doesn't corrupt the entry
runInWindow(`openDetail('dl1');`);
q('#f-progress').value = '140';
q('#m-save').click();
e = window.__b.log;
ok('downward correction keeps entry sane', e.length === 1 && e[0].from === 100 && e[0].to === 150);

// 4. mark-as-read logs the completion stretch
runInWindow(`openDetail('dl1');`);
qa('#f-status button').find(x => x.dataset.s === 'read').click();
q('#m-save').click();
e = window.__b.log;
ok('mark-as-read extends log to total', e[0].to === 400);
ok('book finished', window.__b.status === 'read' && window.__b.progress === 400);

// 5. heatmap lights up logged days; day list shows page ranges
runInWindow(`heatSel = null; renderStats();`);
const cell = q('#heatmap [data-day="' + todayK + '"]');
ok('logged day is lit', /l[1-4]/.test(cell.className));
cell.click();
const listTxt = q('#heat-books').textContent;
ok('day list shows page range', /p\.\s*100\s*→\s*p\.\s*400/.test(listTxt));
ok('day list shows pages read', listTxt.includes('+300 pages'));
ok('finished book not duplicated in day list', qa('#heat-books .cal-book').length === 1);

// 6. daily stats card
const dstat = q('.dstat-card').textContent;
ok('daily card shows total pages', dstat.includes('300 pages read'));
ok('daily card shows per-book range', /p\.\s*100\s*→\s*p\.\s*400/.test(dstat));

// 7. streak counts consecutive logged days
runInWindow(`window.__b.log.push({ d: '${yestK}', from: 50, to: 100 }); renderStats();`);
ok('2-day streak shown', q('.dstat-card').textContent.includes('2-day streak'));

// 8. migration adds log array to old books
runInWindow(`window.__mig = migrateBook({ title: 'old' });`);
ok('migrateBook adds log array', Array.isArray(window.__mig.log));

// 9. finished-without-log day still shows Finished row
runInWindow(`
  library.push({ id: 'dl2', isbn: '', title: 'Old Finish', authors: ['B'], cover: '', description: '',
    pageCount: 200, publishedDate: '', categories: [], publicRating: null, ratingsCount: 0, status: 'read',
    ratings: {}, axes: [], myRating: 0, tropes: [], progress: 200, log: [],
    dateAdded: new Date().toISOString(), dateFinished: new Date(new Date().setDate(new Date().getDate() - 3)).toISOString(), notes: '' });
  renderStats();`);
const oldK = (() => { const d = new Date(); d.setDate(d.getDate() - 3); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
q('#heatmap [data-day="' + oldK + '"]').click();
ok('finish-only day shows Finished row', q('#heat-books').textContent.includes('Finished 🎉'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
