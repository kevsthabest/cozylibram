// Metadata compare sheet (v476): blanks auto-fill, conflicts get a
// per-field compare sheet. Hardcover-first priority is kept (see
// verify.test.js); these tests cover the new blank/conflict split.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in meta-compare tests'); };

require('./harness').loadApp(window);
window.hcSearchDocs = async () => [];

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const mk = (id, fields) =>
  `Object.assign({ id: '${id}', isbn: '', title: 'Unknown title', authors: [], cover: '', ` +
  `pageCount: null, publishedDate: '', owned: true, status: 'read', _mtime: 0 }, ${JSON.stringify(fields)})`;

(async () => {
  // --- blank vs conflict classification
  ok('pageCount blank is blank-fill',
    window.eval(`isBlankFillFlag({field:'pageCount', from:'(missing)'})`) === true);
  ok('cover blank is blank-fill',
    window.eval(`isBlankFillFlag({field:'cover', from:'No cover'})`) === true);
  ok('year blank is blank-fill',
    window.eval(`isBlankFillFlag({field:'year', from:'(missing)'})`) === true);
  ok('pageCount conflict is not blank-fill',
    window.eval(`isBlankFillFlag({field:'pageCount', from:'100'})`) === false);
  ok('title blank still goes to the sheet (not auto-filled)',
    window.eval(`isBlankFillFlag({field:'title', from:'(none)'})`) === false);
  ok('authors conflict is not blank-fill',
    window.eval(`isBlankFillFlag({field:'authors', from:'A'})`) === false);

  // --- compareBookMeta: missing year is a blank flag now
  runInWindow(`var cb1 = ${mk('c1', { title: 'Dune', authors: ['Frank Herbert'], pageCount: 412, publishedDate: '', cover: 'c' })};
    var cm1 = { title: 'Dune', authors: ['Frank Herbert'], pageCount: 412, year: 1965, cover: 'c' };
    var cf1 = compareBookMeta(cb1, cm1);`);
  ok('missing year flags as blank-fill',
    window.eval(`cf1.length === 1 && cf1[0].field === 'year' && isBlankFillFlag(cf1[0])`));

  // --- applyMetaField: per-field granularity
  runInWindow(`var ab = ${mk('a1', { title: 'Wrong', authors: ['X'], pageCount: 100, publishedDate: '1999', cover: '' })};
    var am = { title: 'Right', authors: ['Y'], pageCount: 200, year: 2001, cover: 'http://x/c.jpg' };`);
  await window.eval(`applyMetaField(ab, am, 'title')`);
  ok('applyMetaField writes only its field',
    window.eval(`ab.title === 'Right' && ab.pageCount === 100 && ab.publishedDate === '1999'`));

  // --- sweep: blanks auto-fill silently, conflicts stored
  runInWindow(`localStorage.clear(); library.length = 0;
    localStorage.removeItem('spicyshelves.meta_compare_at');
    library.push(${mk('s1', { isbn: '9780441172719', title: 'Dune Messed Up', authors: ['Frank Herbert'], pageCount: null, publishedDate: '', cover: '' })});
    window.__metaStub = { title: 'Dune', authors: ['Frank Herbert'], pageCount: 412, year: 1965, cover: 'http://x/dune.jpg' };
    fetchMetaByISBN = async () => window.__metaStub;`);
  await window.eval(`runMetaCompareSweep()`);
  const s1 = window.eval(`({ pageCount: library[0].pageCount, year: library[0].publishedDate, cover: library[0].cover, title: library[0].title })`);
  ok('sweep auto-fills blank pageCount', s1.pageCount === 412);
  ok('sweep auto-fills blank year', s1.year === '1965');
  ok('sweep auto-fills blank cover', s1.cover === 'http://x/dune.jpg');
  ok('sweep does not touch conflicting title', s1.title === 'Dune Messed Up');
  ok('sweep stores the title conflict',
    window.eval(`!!metaConflictFor('s1') && metaConflictFor('s1').flags.length === 1 && metaConflictFor('s1').flags[0].field === 'title'`));
  ok('conflicts persist to localStorage',
    window.eval(`JSON.parse(localStorage.getItem('spicyshelves.meta_conflicts.v1')).s1.flags[0].field`) === 'title');
  ok('sweep stamps the 24h throttle',
    window.eval(`Number(localStorage.getItem('spicyshelves.meta_compare_at'))`) > 0);

  // --- compare sheet: per-field picks, default Yours, apply is scoped
  runInWindow(`localStorage.clear(); library.length = 0;
    library.push(${mk('h1', { isbn: '9780441172719', title: 'My Title', authors: ['Me'], pageCount: 100, publishedDate: '1999', cover: '' })});
    metaConflicts['h1'] = { meta: { title: 'Found Title', authors: ['Them'], pageCount: 200, year: 2001, cover: '' },
      flags: [{ field: 'title', label: 'Title', from: 'My Title', to: 'Found Title' },
              { field: 'pageCount', label: 'Pages', from: '100', to: '200' }] };
    openMetaCompareSheet('h1');`);
  const q = (s) => window.document.querySelector(s);
  ok('sheet renders one field row per conflict', q('#mc-fields').querySelectorAll('.mcmp-field').length === 2);
  ok('Yours is selected by default',
    Array.from(q('#mc-fields').querySelectorAll('.mcmp-opt.on')).every(o => o.dataset.pick === 'yours'));
  // pick "Found" for title only
  const titleField = q('.mcmp-field[data-mf="title"]');
  titleField.querySelector('[data-pick="found"]').click();
  ok('per-field selection is independent',
    titleField.querySelector('[data-pick="found"]').classList.contains('on') &&
    q('.mcmp-field[data-mf="pageCount"]').querySelector('[data-pick="yours"]').classList.contains('on'));
  q('#mc-apply').click();
  await new Promise(r => setTimeout(r, 50));
  const h1 = window.eval(`({ title: library[0].title, pageCount: library[0].pageCount })`);
  ok('apply writes only picked fields', h1.title === 'Found Title' && h1.pageCount === 100);
  ok('conflict cleared after apply', window.eval(`metaConflictFor('h1')`) === null);
  ok('sheet closed after apply', !q('#mc-back'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
