// Cover picker (v47): candidate gathering, dedupe, selection, persistence.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

let fetchCalls = [];
let gbItems = [];
let olEdition = null;
let olWork = null;
let olSearchDocs = [];
let appleResults = [];
window.fetch = async (url) => {
  const u = String(url);
  fetchCalls.push(u);
  if (u.includes('googleapis.com/books/v1/volumes') || u.includes('/api/gbooks/books/v1/volumes')) return { json: async () => ({ items: gbItems }) };
  if (u.includes('itunes.apple.com/search')) return { json: async () => ({ results: appleResults }) };
  if (u.includes('openlibrary.org/isbn/')) return { json: async () => olEdition };
  if (u.includes('openlibrary.org/works/')) return { json: async () => olWork };
  if (u.includes('openlibrary.org/search.json')) return { json: async () => ({ docs: olSearchDocs }) };
  throw new Error('unexpected fetch: ' + u);
};

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (n = 6) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });
const mk = (id, fields) =>
  `Object.assign({ id: '${id}', isbn: '', title: 'T', authors: ['A'], cover: '', owned: true, status: 'read', _mtime: 0 }, ${JSON.stringify(fields)})`;

(async () => {
  gbItems = [
    { volumeInfo: { imageLinks: { thumbnail: 'http://example.com/a.jpg' } } },
    { volumeInfo: { imageLinks: { thumbnail: 'http://example.com/a.jpg' } } }, // dup
    { volumeInfo: { imageLinks: { smallThumbnail: 'https://example.com/b.jpg' } } },
    { volumeInfo: {} }, // no image
  ];
  olEdition = { works: [{ key: '/works/OL1W' }], covers: [999] };
  olWork = { covers: [111, 222] };
  appleResults = [
    { trackName: 'T', artworkUrl100: 'https://is1-ssl.mzstatic.com/x/abc/100x100bb.jpg' },
    { trackName: 'T', artworkUrl100: 'https://is1-ssl.mzstatic.com/x/abc/100x100bb.jpg' }, // dup
    { trackName: 'T' }, // no artwork
  ];
  window.eval(`hcReady = () => true; hcGraphQL = async (q) =>
    ({ editions: [{ image: { url: 'https://img.hardcover.app/hc1.jpg' } }, { image: null }] });`);

  runInWindow(`localStorage.clear(); library.length = 0;
    library.push(${mk('k1', { isbn: '9780061120084', title: 'T', cover: 'https://example.com/current.jpg' })});`);
  fetchCalls = [];
  const cands = await window.eval(`fetchCoverCandidates(library[0])`);
  const urls = cands.map(c => c.url);
  ok('current cover comes first', urls[0] === 'https://example.com/current.jpg');
  ok('GB thumbnails included, https-upgraded', urls.includes('https://example.com/a.jpg'));
  ok('duplicate GB thumbnail deduped', urls.filter(u => u === 'https://example.com/a.jpg').length === 1);
  ok('OL work covers included', urls.includes('https://covers.openlibrary.org/b/id/111-L.jpg') &&
    urls.includes('https://covers.openlibrary.org/b/id/222-L.jpg'));
  ok('OL edition covers included', urls.includes('https://covers.openlibrary.org/b/id/999-L.jpg'));
  ok('Apple Books artwork upscaled to 600px', urls.includes('https://is1-ssl.mzstatic.com/x/abc/600x600bb.jpg'));
  ok('Apple Books duplicates deduped', urls.filter(u => u.includes('mzstatic')).length === 1);
  ok('Hardcover edition art included',
    cands.some(c => c.url === 'https://img.hardcover.app/hc1.jpg' && c.label === 'Hardcover'));
  ok('Apple searched by ISBN', fetchCalls.some(u => u.includes('itunes.apple.com') && u.includes('isbn')));
  ok('labels carried through', cands.find(c => c.url.endsWith('111-L.jpg')).label === 'Open Library');

  // second call serves from cache — no new fetches
  const nCalls = fetchCalls.length;
  await window.eval(`fetchCoverCandidates(library[0])`);
  ok('candidates cached per ISBN', fetchCalls.length === nCalls);

  // no ISBN → title/author fallback via OL search + Apple Books
  olSearchDocs = [{ cover_i: 333 }, { cover_i: 333 }, {}];
  runInWindow(`library.push(${mk('k2', { isbn: '', title: 'Some Title', authors: ['Some Author'] })});`);
  fetchCalls = [];
  const c2 = await window.eval(`fetchCoverCandidates(library[1])`);
  const urls2 = c2.map(c => c.url);
  ok('no-ISBN fallback finds OL covers, deduped',
    urls2.filter(u => u === 'https://covers.openlibrary.org/b/id/333-L.jpg').length === 1);
  ok('no-ISBN fallback also asks Apple Books by title',
    fetchCalls.some(u => u.includes('itunes.apple.com') && !u.includes('isbn')));

  // Hardcover skipped gracefully when no token is configured
  window.eval(`hcReady = () => false; coverCandidateCache.clear();`);
  runInWindow(`library.push(${mk('k3', { isbn: '9780553382563', title: 'T3' })});`);
  const c3 = await window.eval(`fetchCoverCandidates(library[2])`);
  ok('no token → no Hardcover candidates, no crash',
    !c3.some(c => c.label === 'Hardcover') && c3.some(c => c.label === 'Apple Books'));

  // picker UI renders the options
  runInWindow(`openCoverPicker('k1')`);
  await tick(10);
  const picks = window.document.querySelectorAll('#cp-grid .cp-pick');
  ok('picker grid renders candidates', picks.length >= 5);
  ok('current cover marked', !!window.document.querySelector('#cp-grid .cp-pick.current'));
  ok('picker shows count note', window.document.getElementById('cp-note').textContent.includes('tap one'));

  // choosing a cover persists, refreshes the modal cover, closes the picker
  runInWindow(`document.getElementById('modal-root').innerHTML =
    '<div class="modal"><div class="modal-head"><div class="cover-wrap">OLD</div></div></div>';`);
  const newUrl = 'https://covers.openlibrary.org/b/id/222-L.jpg';
  await window.eval(`chooseCover('k1', '${newUrl}')`);
  await tick(2);
  ok('chooseCover updates the book', window.eval(`library[0].cover`) === newUrl);
  ok('chooseCover persists', window.eval(`JSON.parse(localStorage.getItem(libKey())).find(b => b.id === 'k1').cover`) === newUrl);
  ok('chooseCover refreshes the modal cover', window.document.querySelector('#modal-root .cover-wrap').textContent !== 'OLD');
  ok('chooseCover closes the picker', !window.document.getElementById('cover-picker'));

  // cancel closes without changing anything
  runInWindow(`openCoverPicker('k1')`);
  window.document.getElementById('cp-cancel').click();
  ok('cancel closes the picker', !window.document.getElementById('cover-picker'));
  ok('cancel changes nothing', window.eval(`library[0].cover`) === newUrl);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
