// Shared metadata cache tests: book_meta get/put, TTL, offline bypass,
// lookupISBN integration, and fetchPageCountByISBN cache use.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

const jok = (j) => ({ ok: true, json: async () => j });
let fetchCalls = 0;
const gbVol = (isbn, title, pages) => ({ items: [{ volumeInfo: {
  title, authors: ['Jane Author'], pageCount: pages,
  description: 'A great book', publishedDate: '2020-05-01',
  categories: ['Romance'], averageRating: 4.5, ratingsCount: 100,
  imageLinks: { thumbnail: 'http://example.com/cover.jpg' },
  industryIdentifiers: [{ type: 'ISBN_13', identifier: isbn }]
}}]});
window.fetch = async (url) => {
  fetchCalls++;
  const u = String(url);
  if (u.includes('googleapis.com') && u.includes('isbn:9780000000001')) return jok(gbVol('9780000000001', 'Cached Book', 321));
  if (u.includes('googleapis.com') && u.includes('isbn:9780000000002')) return jok(gbVol('9780000000002', 'Second Book', 200));
  if (u.includes('googleapis.com')) return jok({ items: [] });
  if (u.includes('openlibrary.org')) return jok({ docs: [] }); // no rating blend
  throw new Error('unexpected fetch in metacache tests: ' + u);
};

function makeMetaStub() {
  const meta = [];
  const calls = { select: 0, upsert: 0 };
  return {
    meta, calls,
    from: (table) => {
      if (table !== 'book_meta') throw new Error('unexpected table: ' + table);
      return {
        select: () => { calls.select++; return {
          eq: (col, val) => ({ maybeSingle: async () => {
            const row = meta.find(r => r.isbn === val);
            return row ? { data: { data: row.data, fetched_at: row.fetched_at }, error: null }
                       : { data: null, error: null };
          }})
        }},
        upsert: async (row) => {
          calls.upsert++;
          const i = meta.findIndex(r => r.isbn === row.isbn);
          if (i >= 0) meta[i] = row; else meta.push(row);
          return { error: null };
        }
      };
    }
  };
}

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
async function waitFor(fn, what) {
  for (let i = 0; i < 100; i++) { if (fn()) return true; await tick(); }
  throw new Error('timeout waiting for ' + what);
}

(async () => {
  const stub = makeMetaStub();
  window.__sbStub = stub;
  runInWindow(`cloudUser = { id: 'u1' };`);

  // 1. cache miss → APIs → result stored
  fetchCalls = 0;
  const b1 = await window.lookupISBN('9780000000001');
  ok('miss returns API book', b1 && b1.title === 'Cached Book' && b1.pageCount === 321);
  ok('miss hits the network', fetchCalls > 0);
  await waitFor(() => stub.meta.length === 1, 'cache write');
  ok('miss stores snapshot', stub.meta[0].isbn === '9780000000001' && stub.meta[0].data.title === 'Cached Book');
  ok('snapshot has pageCount', stub.meta[0].data.pageCount === 321);
  ok('snapshot excludes user fields',
    stub.meta[0].data.id === undefined && stub.meta[0].data.status === undefined &&
    stub.meta[0].data.ratings === undefined && stub.meta[0].data.progress === undefined &&
    stub.meta[0].data.notes === undefined);

  // 2. cache hit → zero API calls, fresh book object
  fetchCalls = 0;
  const selBefore = stub.calls.select;
  const b2 = await window.lookupISBN('9780000000001');
  ok('hit returns cached book', b2 && b2.title === 'Cached Book' && b2.pageCount === 321);
  ok('hit makes no API calls', fetchCalls === 0);
  ok('hit consulted book_meta', stub.calls.select === selBefore + 1);
  ok('hit rebuilds a fresh book', b2.id && b2.id !== b1.id);
  ok('hit derives axes/tropes', Array.isArray(b2.axes) && Array.isArray(b2.tropes));

  // 3. stale entry → refreshed from APIs
  const oldTs = new Date(Date.now() - 31 * 864e5).toISOString();
  stub.meta[0].fetched_at = oldTs;
  fetchCalls = 0;
  const b3 = await window.lookupISBN('9780000000001');
  ok('stale entry re-fetches', fetchCalls > 0 && b3.title === 'Cached Book');
  await waitFor(() => stub.meta[0].fetched_at !== oldTs, 'cache refresh');
  ok('stale entry timestamp refreshed', stub.meta[0].fetched_at !== oldTs);

  // 4. signed out → cache skipped entirely (no read, no write)
  runInWindow(`cloudUser = null;`);
  const upBefore = stub.calls.upsert, selBefore2 = stub.calls.select;
  fetchCalls = 0;
  const b4 = await window.lookupISBN('9780000000002');
  ok('signed-out still resolves via API', b4 && b4.title === 'Second Book');
  ok('signed-out hits the network', fetchCalls > 0);
  await tick(120);
  ok('signed-out skips cache read', stub.calls.select === selBefore2);
  ok('signed-out skips cache write', stub.calls.upsert === upBefore);

  // 5. fetchPageCountByISBN serves from cache with zero network
  runInWindow(`cloudUser = { id: 'u1' };`);
  stub.meta.push({ isbn: '9780000000003', fetched_at: new Date().toISOString(),
    data: { isbn: '9780000000003', title: 'PC Book', pageCount: 450 } });
  fetchCalls = 0;
  ok('page count from cache', await window.fetchPageCountByISBN('9780000000003') === 450);
  ok('page-count cache hit makes no API calls', fetchCalls === 0);

  // 6. empty ISBN never touches Supabase
  const selBefore3 = stub.calls.select;
  ok('empty isbn → null', await window.metaCacheGet('') === null);
  ok('null isbn → null', await window.metaCacheGet(null) === null);
  ok('empty isbn skips Supabase', stub.calls.select === selBefore3);

  // 7. bookFromMeta skeleton for unknown ISBN
  const skel = window.bookFromMeta(null, '9780000000009');
  ok('skeleton keeps isbn hint', skel && skel.isbn === '9780000000009');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
