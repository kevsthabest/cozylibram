// Edition picker (v210): edition listing, switching, persistence, UI.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });
window.fetch = async () => { throw new Error('no network in test'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (n = 10) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

(async () => {
  // Stub Hardcover: ISBN -> book id, then a messy edition list.
  window.eval(`hcReady = () => true;`);
  window.eval(`hcGraphQL = async (q) => {
    if (q.indexOf('editions(where: {isbn_13:') !== -1) {
      if (q.indexOf('9999999999999') !== -1) return { editions: [] };
      return { editions: [{ book: { id: 377567, title: 'Daemon' } }] };
    }
    if (q.indexOf('query_type') !== -1) {
      if (q.indexOf('Unknown Book') !== -1) return { search: { results: { hits: [] } } };
      return { search: { results: { hits: [{ document: { id: 377567, title: 'Daemon' } }] } } };
    }
    if (q.indexOf('books(where: {id:') !== -1) {
      return { books: [{ editions: [
        { isbn_13: '9781524741891', publisher: { name: 'Penguin' }, release_date: '2006-12-01', pages: 482, image: { url: 'https://img/hc1.jpg' } },
        { isbn_13: '9781524741891', publisher: { name: 'Penguin dup' }, release_date: '2006-12-01', pages: 482, image: null },
        { isbn_13: null, publisher: { name: 'NoISBN' }, release_date: '2009-01-08', pages: 100, image: null },
        { isbn_13: '9780525951117', publisher: { name: 'Dutton Adult' }, release_date: '2009-05-01', pages: 432, image: { url: 'https://img/hc2.jpg' } },
        { isbn_13: '9781847249449', publisher: null, release_date: null, pages: 0, image: null }
      ] }] };
    }
    throw new Error('unexpected query: ' + q.slice(0, 60));
  };`);

  // fetchEditionOptions — ISBN path
  const r1 = await window.eval(`fetchEditionOptions({ isbn: '9781524741891', title: 'Daemon', authors: ['Daniel Suarez'] })`);
  ok('editions returned', r1.editions.length === 3);
  ok('no-ISBN rows dropped', !r1.editions.some(e => !e.isbn));
  ok('duplicate ISBN deduped', r1.editions.filter(e => e.isbn === '9781524741891').length === 1);
  ok('current edition sorts first', r1.editions[0].isbn === '9781524741891');
  ok('fields mapped', r1.editions[0].publisher === 'Penguin' && r1.editions[0].year === '2006' && r1.editions[0].pages === 482);
  ok('missing publisher tolerated', r1.editions.some(e => e.isbn === '9781847249449' && e.publisher === ''));

  // no-ISBN path (manual adds): title/author search
  const r2 = await window.eval(`fetchEditionOptions({ isbn: '', title: 'Daemon', authors: ['Daniel Suarez'] })`);
  ok('no-ISBN book resolves via search', r2.editions.length === 3);

  // unknown book → error, not a crash
  const r3 = await window.eval(`fetchEditionOptions({ isbn: '9999999999999', title: 'Unknown Book', authors: ['Nobody'] })`);
  ok('unknown book yields an error', !!r3.error);

  // Hardcover unreachable (no token) → error, not a crash
  window.eval(`hcReady = () => false;`);
  const r4 = await window.eval(`fetchEditionOptions({ isbn: '9781524741891' })`);
  ok('no token yields an error', !!r4.error);
  window.eval(`hcReady = () => true;`);

  // applyEdition — set up a book and stub the side effects
  runInWindow(`localStorage.clear(); library.length = 0;
    window.__saved = 0; saveLibrary = () => { window.__saved++; };
    window.__pages = 0; fetchPageCountByISBN = async (isbn) => { window.__pages++; return 500; };
    window.__works = 0; resolveWork = async (b) => { window.__works++; return 'w1'; };
    window.__enriched = 0; enrichHardcover = async (b) => { window.__enriched++; b.hcEnriched = true; return true; };
    library.push({ id: 'e1', isbn: '9781524741891', title: 'Daemon', authors: ['Daniel Suarez'],
      cover: 'https://example.com/old.jpg', hcEnriched: true, pageCount: 482, _mtime: 0 });`);

  const bad = await window.eval(`applyEdition('e1', { isbn: 'junk' })`);
  ok('invalid ISBN rejected', bad === false);
  ok('book untouched on invalid ISBN',
    window.eval(`library[0].isbn`) === '9781524741891' && window.eval(`window.__saved`) === 0);

  const noop = await window.eval(`applyEdition('e1', { isbn: '9781524741891', cover: 'https://img/x.jpg' })`);
  ok('same ISBN is a no-op', noop === true && window.eval(`window.__saved`) === 0);

  const switched = await window.eval(`applyEdition('e1', { isbn: '9780525951117', cover: 'https://img/hc2.jpg' })`);
  await tick();
  ok('switch returns true', switched === true);
  ok('ISBN updated', window.eval(`library[0].isbn`) === '9780525951117');
  ok('cover adopted from the edition', window.eval(`library[0].cover`) === 'https://img/hc2.jpg');
  ok('page count refreshed', window.eval(`library[0].pageCount`) === 500);
  ok('new edition registered with works', window.eval(`window.__works`) === 1);
  ok('library saved', window.eval(`window.__saved`) >= 1);
  ok('already-enriched book skips re-enrich (no double rating blend)',
    window.eval(`window.__enriched`) === 0 && window.eval(`library[0].hcEnriched`) === true);

  // never-enriched books DO get the Hardcover pass
  runInWindow(`library.push({ id: 'e2', isbn: '', title: 'Daemon', authors: ['Daniel Suarez'],
    cover: '', hcEnriched: false, _mtime: 0 });`);
  await window.eval(`applyEdition('e2', { isbn: '9781847249449', cover: '' })`);
  await tick();
  ok('never-enriched book gets enriched', window.eval(`window.__enriched`) === 1);

  // custom upload cover (data: URL) is never clobbered
  runInWindow(`library.push({ id: 'e3', isbn: '9781524741891', title: 'T', authors: ['A'],
    cover: 'data:image/jpeg;base64,AAA', hcEnriched: true, _mtime: 0 });`);
  await window.eval(`applyEdition('e3', { isbn: '9780525951117', cover: 'https://img/hc2.jpg' })`);
  await tick();
  ok('uploaded cover preserved', String(window.eval(`library[2].cover`)).indexOf('data:') === 0);

  // picker UI renders — record swipe-to-close wiring (v226)
  runInWindow(`window.__wiredSheets = [];
    window.__origWireSheetDrag = wireSheetDrag;
    wireSheetDrag = function (sheet, onDismiss) {
      window.__wiredSheets.push(sheet);
      return window.__origWireSheetDrag(sheet, onDismiss);
    };`);
  runInWindow(`openEditionPicker('e1')`);
  await tick(14);
  ok('picker overlay opens', !!window.document.getElementById('edition-picker'));
  ok('edition rows render', window.document.querySelectorAll('#ep-list .ep-pick').length === 3);
  ok('current edition marked', !!window.document.querySelector('#ep-list .ep-pick.current'));
  ok('manual ISBN fallback present', !!window.document.getElementById('ep-isbn'));
  ok('picker sheet gets swipe-down-to-close wired',
    window.__wiredSheets.length === 1 &&
    window.__wiredSheets[0] === window.document.querySelector('#edition-picker .cover-picker'));
  ok('cover-picker CSS blocks pull-to-refresh chaining',
    /\.cover-picker\s*\{[^}]*overscroll-behavior:\s*contain/.test(
      require('fs').readFileSync('/home/hatch/workspace/booktok/styles.css', 'utf8')));

  // tapping a row switches the edition and closes the picker
  window.document.querySelector('#ep-list .ep-pick:not(.current)').click();
  await tick(14);
  ok('picker closes after a choice', !window.document.getElementById('edition-picker'));
  ok('choice applied to the book', window.eval(`library[0].isbn`) !== '9780525951117');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
