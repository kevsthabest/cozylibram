// Bulk cover download (v107): downloadMissingCovers fills coverless books with
// the first loadable candidate, skips books that already have covers, and the
// Settings page exposes the button.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in cover-bulk tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 50));

(async () => {
  // stub candidate + verify functions: book A gets a dead first URL then a good
  // one, book B gets nothing loadable, book C already has a cover.
  runInWindow(`library = [
    { id: 'a', isbn: '9780000000001', title: 'No Cover A', authors: ['Author A'], cover: '' },
    { id: 'b', isbn: '9780000000002', title: 'No Cover B', authors: ['Author B'], cover: '' },
    { id: 'c', isbn: '9780000000003', title: 'Has Cover', authors: ['Author C'], cover: 'https://x/keep.jpg' },
  ];`);
  runInWindow(`
    window.__cands = async (b) => b.id === 'a'
      ? [{ url: 'https://x/dead.jpg', label: 'X' }, { url: 'https://x/good.jpg', label: 'X' }]
      : [];
    window.__verify = async (u) => u === 'https://x/good.jpg';
    window.__progress = [];
    downloadMissingCovers((i, n) => window.__progress.push([i, n]),
      { candidates: window.__cands, verify: window.__verify })
      .then(r => { window.__res = r; });
  `);
  await tick(1500);
  const res = window.__res;
  ok('reports total + done', res && res.total === 2 && res.done === 1);
  runInWindow(`window.__covers = library.map(b => b.id + '=' + (b.cover || '(none)')).join('|');`);
  ok('first loadable candidate wins (dead URL skipped)',
    window.__covers.includes('a=https://x/good.jpg'));
  ok('book with no loadable candidate stays coverless',
    window.__covers.includes('b=(none)'));
  ok('book that already had a cover is untouched',
    window.__covers.includes('c=https://x/keep.jpg'));
  ok('progress reported per book',
    JSON.stringify(window.__progress) === JSON.stringify([[1, 2], [2, 2]]));

  // settings page exposes the button + live missing-cover count
  runInWindow(`view = 'settings'; renderSettings();`);
  const btn = window.document.getElementById('cover-bulk');
  ok('settings has the Download missing covers button', !!btn);
  const note = window.document.getElementById('cover-bulk-note');
  ok('note shows the missing-cover count', !!note && /1 of 3 books are missing covers/.test(note.textContent));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
