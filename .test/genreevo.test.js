// Genre evolution tests (v69).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in genreevo tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s, root) => Array.from((root || window.document).querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};

const seed = (n) => runInWindow(`(function(){
  localStorage.clear();
  localStorage.setItem('spicyshelves.animation', 'off');
  library.length = 0;
  genreGran = 'quarter';
  const qd = (back) => { const d = new Date(); d.setDate(15); d.setMonth(d.getMonth() - back * 3); d.setHours(12, 0, 0, 0); return d.toISOString(); };
  const M = (id, title, cats, finQ, extra) => Object.assign({ id, isbn: '', title, authors: ['A'], cover: '',
    description: '', pageCount: 300, publishedDate: '', categories: cats, publicRating: null,
    ratingsCount: 0, status: 'read', ratings: {}, axes: [], myRating: 4, tropes: [],
    progress: 300, log: [], dateAdded: qd(finQ + 1), dateFinished: qd(finQ), notes: '' }, extra);
  const R = ['Fiction / Romance / General'], F = ['Fiction / Fantasy / Epic'];
  const books = [];
  if (${n} >= 12) {
    ['g1','g2','g3','g4'].forEach((id, i) => books.push(M(id, 'Rom ' + i, R, 2)));
    ['g5','g6'].forEach((id, i) => books.push(M(id, 'RomB ' + i, R, 1)));
    ['g7','g8'].forEach((id, i) => books.push(M(id, 'Fan ' + i, F, 1)));
    books.push(M('g9', 'RomC', R, 0));
    ['g10','g11','g12'].forEach((id, i) => books.push(M(id, 'FanB ' + i, F, 0)));
  } else if (${n} >= 1) {
    books.push(M('solo', 'Only Book', R, 0));
  }
  books.forEach(b => library.push(b));
})();`);

seed(12);
runInWindow(`renderStats();`);

// 1. granularity switcher renders, quarter active by default
ok('granularity switcher renders', !!q('#evo-gran'));
ok('quarter active by default', q('#evo-gran button[data-g="quarter"]').classList.contains('active'));

// 2. three quarter rows, chronological
const rows = qa('.evo-row');
ok('three non-empty quarter rows', rows.length === 3);
const lbls = rows.map(r => r.querySelector('.evo-lbl').textContent);
ok('labels look like quarters', lbls.every(l => /^Q[1-4] ’\d\d$/.test(l)));

// 3. legend names both genres
const legend = q('.evo-legend').textContent;
ok('legend has Romance and Fantasy', legend.includes('Romance') && legend.includes('Fantasy'));

// 4. stacked segments sum to ~100% per row
const sumsOk = rows.every(r => {
  const ws = qa('.evo-seg', r).map(s => parseFloat(s.style.width));
  const sum = ws.reduce((a, b) => a + b, 0);
  return Math.abs(sum - 100) < 1.5;
});
ok('segments fill each bar', sumsOk);

// 5. deterministic observation: Fantasy 0% -> 75%
const evoText = q('.evo').parentElement.textContent;
ok('swing observation names Fantasy 0% to 75%', evoText.includes('Fantasy') && evoText.includes('0%') && evoText.includes('75%'));

// 6. switching to month view re-renders with 3 rows
q('#evo-gran button[data-g="month"]').click();
ok('month view has three rows', qa('.evo-row').length === 3);
ok('month labels look right', qa('.evo-row').every(r => /^[A-Z][a-z]{2} ’\d\d$/.test(r.querySelector('.evo-lbl').textContent)));

// 7. year view: all fixtures fall in one year, so the gate note shows
q('#evo-gran button[data-g="year"]').click();
ok('year view gates on a single year of data', /at least two years/.test(window.document.body.textContent));

// 8. sparse data shows the gated note
seed(1);
runInWindow(`renderStats();`);
ok('sparse data shows the gate note', q('.stat-sub') && /at least two/.test(window.document.body.textContent));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
