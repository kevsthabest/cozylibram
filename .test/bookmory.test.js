// Bookmory import (v44): ZIP reader, pure-JS inflate, minimal SQLite reader,
// field mapping, and the import/update flow.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const zlib = require('zlib');

const BM_PATH = '/home/hatch/workspace/user/files/Database.bookmory';
const zipBytes = new Uint8Array(fs.readFileSync(BM_PATH));

// load the app so the 133-bookmory.js globals exist for the flow tests
const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });
window.fetch = async () => { throw new Error('no network in bookmory tests'); };
require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (n = 2) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

(async () => {
  const P = window.eval; // pure functions live on the jsdom window

  // --- ZIP: find the database entry ---
  const files = P('bmZipList')(zipBytes);
  const dbEntry = files.find(f => f.name === 'new_bookmory.db');
  ok('zip lists new_bookmory.db', !!dbEntry && dbEntry.method === 8);

  // --- inflate: my implementation must match Node's zlib byte-for-byte ---
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const lh = dbEntry.lhOff;
  const comp = zipBytes.subarray(lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true),
    lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true) + dbEntry.csize);
  const mine = P('bmInflateRaw')(comp);
  const ref = zlib.inflateRawSync(Buffer.from(comp));
  ok('pure-JS inflate matches zlib (length)', mine.length === ref.length);
  ok('pure-JS inflate matches zlib (bytes)', mine.length === ref.length &&
    mine.every((b, i) => b === ref[i]));

  // --- SQLite: the real database parses to 190 books ---
  const db = P('bmZipExtract')(zipBytes, dbEntry);
  const rows = P('bmSqliteReadEntry')(db);
  const books = rows.filter(r => r.store === 'books' && !r.deleted);
  ok('sqlite reader finds 190 bookmory books', books.length === 190);
  const haunting = books.find(r => JSON.parse(r.value).title === 'Haunting Adeline');
  ok('spot check: Haunting Adeline is DONE', haunting && JSON.parse(haunting.value).status_list[0] === 'DONE');

  // --- full parse pipeline ---
  const parsed = P('parseBookmoryExport')(zipBytes);
  ok('parseBookmoryExport yields 189 books', parsed.books.length === 189);
  ok('one binary-corrupted record reported by name',
    parsed.skippedTitles.length === 1 && /dungeon crawler carl/i.test(parsed.skippedTitles[0]));
  ok('local cover images found in zip', parsed.imageEntries.length === 3);
  const m = parsed.books.find(b => b.title === 'Haunting Adeline');
  ok('status DONE maps to read', m && m.status === 'read');
  ok('stable bm- id', m && m.id.startsWith('bm-'));
  ok('owned defaults to owned', parsed.books.every(b => b.owned === 'owned'));
  ok('favorites mapped (4)', parsed.books.filter(b => b.favorite).length === 4);
  const tagged = parsed.books.find(b => b.tropes.length > 0);
  ok('tags map to tropes without #', tagged && tagged.tropes.every(t => !t.includes('#')));
  const rated = parsed.books.find(b => b.myRating > 0);
  ok('ratings map 0-5', rated && rated.myRating >= 0.5 && rated.myRating <= 5);
  const finished = parsed.books.find(b => b.dateFinished);
  ok('finish dates are YYYY-MM-DD', finished && /^\d{4}-\d{2}-\d{2}$/.test(finished.dateFinished));
  const withLog = parsed.books.find(b => b.log.length > 0);
  ok('page logs convert to {d,from,to}', withLog && withLog.log.every(e => e.d && e.to > e.from));
  const dnf = parsed.books.find(b => b.status === 'dnf');
  ok('GIVE_UP maps to dnf', !!dnf);

  // --- mapper unit checks on a synthetic record ---
  const syn = P('mapBookmoryBook')('123', {
    title: 'Syn Book', authors: ['Ann Author'], isbn: '9781234567890',
    status_list: ['NOT_STARTED'], tags: '#Fantasy #Dark Romance',
    reads: [{ star: 4.5, page_log_list: [
      { page: 10, created_at: 1704427200000 }, { page: 30, created_at: 1704427200000 },
      { page: 50, created_at: 1704513600000 } ] }],
    real_total_page: 200, page_type: 'PAGE', created_at: 1704427200000,
    publication_date: '2024/3/5', collection_keys: [],
  });
  ok('synthetic: tbr + tropes + rating', syn.status === 'tbr' && syn.tropes.join(',') === 'Fantasy,Dark,Romance' &&
    syn.myRating === 4.5 && syn.id === 'bm-123');
  ok('synthetic: log merged per day', syn.log.length === 2 && syn.log[0].d && syn.log[0].from === 0 && syn.log[0].to === 30);
  ok('synthetic: publication date normalized', syn.publishedDate === '2024-03-05');

  // --- import flow: add / skip / update-in-place ---
  runInWindow(`localStorage.clear();
    library.push(migrateBook({ id: 'bm-123', title: 'Old Title', authors: ['Ann Author'],
      notes: 'her own note', ratings: { spice: 5 }, axes: ['spice'], _mtime: 1 }));
    library.push(migrateBook({ id: 'x2', title: 'Dup Title', authors: ['Dup Author'] }));`);
  const synDup = { id: 'bm-dup', title: 'Dup Title', authors: ['Dup Author'], isbn: '', status: 'tbr', owned: true };
  const synNew = { id: 'bm-new1', title: 'Brand New', authors: ['Bob Writer'], isbn: '', status: 'tbr', owned: true };
  const res = window.eval(`importBookmoryBooks([${JSON.stringify(Object.assign({}, syn, { _bmLocalImage: undefined }))},
    ${JSON.stringify(synDup)}, ${JSON.stringify(synNew)}])`);
  ok('import adds new books', res.added === 1);
  ok('import skips alreadyHave dupes', res.skipped === 1);
  ok('import updates bm- ids in place', res.updated === 1 &&
    window.eval(`library.find(b => b.id === 'bm-123').status`) === 'tbr' &&
    window.eval(`library.find(b => b.id === 'bm-123').title`) === 'Syn Book');
  const kept = window.eval(`library.find(b => b.id === 'bm-123')`);
  ok('update preserves in-app notes and spice ratings', kept.notes === 'her own note' && kept.ratings.spice === 5);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
