// v166: Trope Lab review queue — approve inferred tropes without opening books.
// Covers the pure grouping/vote-aggregation helpers and the end-to-end
// render: review card lists inferred books, ▲ votes through trope_votes,
// and "Approve all" upvotes every inferred trope for the book in one tap.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const harness = require('./harness');

const TROPE_ROWS = [
  { id: 't1', name: 'Forced Proximity', description: 'd', genres: [] },
  { id: 't2', name: 'Enemies to Lovers', description: 'd', genres: [] },
  { id: 't3', name: 'Who Did This To You', description: 'd', genres: [] },
];

function selectBuilder(rows) {
  const b = {
    _rows: rows.slice(),
    eq(col, val) { b._rows = b._rows.filter(r => r[col] === val); return b; },
    in(col, vals) { b._rows = b._rows.filter(r => vals.indexOf(r[col]) !== -1); return b; },
    limit() { return b; },
    maybeSingle() { return b; },
    then(resolve) { return Promise.resolve({ data: b._rows, error: null }).then(resolve); },
  };
  return b;
}

const missingTable = (table) => ({
  select() {
    const b = {
      eq() { return b; }, limit() { return b; }, maybeSingle() { return b; },
      then(resolve) {
        return Promise.resolve({ data: null,
          error: { code: '42P01', message: "Could not find the table 'public." + table + "' in the schema cache" } })
          .then(resolve);
      },
    };
    return b;
  },
});

function buildDom() {
  const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key',
    trope: true, tropeProvider: 'openrouter', tropeModel: 'x' };

  const fake = {
    user: null, _cb: null,
    bookTropesRows: [], tropeVoteRows: [], upserts: [], deletes: [],
    auth: {
      getSession: async () => ({ data: { session: fake.user ? { user: fake.user } : null } }),
      signOut: async () => { fake.user = null; return { error: null }; },
      onAuthStateChange: (cb) => { fake._cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: (table) => {
      if (table === 'app_admins') return { select: () => harness.chainableSelect([{ user_id: 'u1' }], r => r) };
      if (table === 'tropes') return { select: () => selectBuilder(TROPE_ROWS) };
      if (table === 'book_tropes') return { select: () => selectBuilder(fake.bookTropesRows) };
      if (table === 'trope_votes') return {
        select: () => selectBuilder(fake.tropeVoteRows),
        upsert: async (obj) => {
          fake.upserts.push(obj);
          // keep subsequent reads consistent with the write
          const i = fake.tropeVoteRows.findIndex(r =>
            r.book_key === obj.book_key && r.trope_id === obj.trope_id && r.user_id === obj.user_id);
          const row = { book_key: obj.book_key, trope_id: obj.trope_id, user_id: obj.user_id, vote: obj.vote };
          if (i >= 0) fake.tropeVoteRows[i] = row; else fake.tropeVoteRows.push(row);
          return { error: null };
        },
        delete: () => ({ eq: () => ({ eq: () => ({ eq: async () => {
          fake.deletes.push(1); return { error: null }; } }) }) }),
      };
      return missingTable(table);
    },
    fire: (event, user) => { fake.user = user || null; fake._cb(event, user ? { user } : null); },
  };
  window.__sbStub = fake;
  window.isSecureContext = true;
  harness.loadApp(window);
  return { window, fake };
}

const runInWindow = (window, js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
const probe = (window, js) => { runInWindow(window, 'window.__probe = (' + js + ');'); return window.__probe; };
const tick = (n) => new Promise(r => { let i = 0; const step = () => (++i >= (n || 3) ? r() : setTimeout(step, 20)); step(); });

async function renderLab(window, fake, key1) {
  await tick();
  fake.bookTropesRows = [
    { book_key: key1, trope_id: 't1', confidence: 0.9, source: 'llm', taxonomy_version: 999, taxonomy_rev: 999 },
    { book_key: key1, trope_id: 't2', confidence: 0.7, source: 'llm', taxonomy_version: 999, taxonomy_rev: 999 },
    { book_key: key1, trope_id: 'nope', confidence: 0.5, source: 'llm', taxonomy_version: 999, taxonomy_rev: 999 },
    { book_key: 't:ghost:book:x', trope_id: 't3', confidence: 0.8, source: 'llm', taxonomy_version: 999, taxonomy_rev: 999 },
  ];
  fake.fire('SIGNED_IN', { id: 'u1', email: 'a@b.c' });
  await tick(8);
  runInWindow(window, `adminTab = 'tropes'; isAppAdmin = true;`);
  runInWindow(window, `library.push({id:'b1', title:'Kill Decision', authors:['Daniel Suarez']});`);
  runInWindow(window, 'tropeLabReviewShown = 15; renderAdmin()');
  for (let i = 0; i < 30; i++) {
    await tick(5);
    const el = window.document.getElementById('tropelab-review');
    if (el && /Review inferred tropes/.test(el.textContent) && !/Loading/.test(el.textContent)) break;
  }
  return window.document.getElementById('tropelab-review');
}

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

(async () => {
  // A: pure grouping helper.
  {
    const { window } = buildDom();
    await tick();
    const entries = probe(window,
      `tropeLabReviewEntries([
        {book_key:'k1', trope_id:'t2', confidence:0.7, source:'llm'},
        {book_key:'k1', trope_id:'t1', confidence:0.9, source:'llm'},
        {book_key:'k1', trope_id:'t1', confidence:0.9, source:'llm'},
        {book_key:'k1', trope_id:'unknown', confidence:0.5, source:'llm'},
        {book_key:'k2', trope_id:'t3', confidence:0.8, source:'llm'},
        null,
      ], id => ({t1:{id:'t1',name:'Forced Proximity'},t2:{id:'t2',name:'Enemies to Lovers'},t3:{id:'t3',name:'Who Did This To You'}})[id] || null)`);
    ok('groups rows by book_key', entries.length === 2);
    const k1 = entries.find(e => e.bookKey === 'k1');
    ok('drops unknown trope ids and dedupes', k1 && k1.tropes.length === 2);
    ok('sorts tropes by confidence desc',
      k1 && k1.tropes[0].id === 't1' && k1.tropes[1].id === 't2');
    ok('carries names through', k1 && k1.tropes[0].name === 'Forced Proximity');
  }

  // B: pure vote aggregation helper.
  {
    const { window } = buildDom();
    await tick();
    const agg = probe(window,
      `tropeLabReviewVotes([
        {book_key:'k1', trope_id:'t1', vote:1, user_id:'u1'},
        {book_key:'k1', trope_id:'t1', vote:1, user_id:'u2'},
        {book_key:'k1', trope_id:'t1', vote:-1, user_id:'u3'},
        {book_key:'k1', trope_id:'t2', vote:-1, user_id:'u2'},
      ], 'u1')`);
    ok('aggregates up/down counts', agg.k1.t1.up === 2 && agg.k1.t1.down === 1);
    ok('marks my vote', agg.k1.t1.mine === 1 && agg.k1.t2.mine === 0);
  }

  // C: review card renders inferred books with vote buttons.
  {
    const { window, fake } = buildDom();
    const key1 = probe(window, `bookKeyFor({title:'Kill Decision', authors:['Daniel Suarez']})`);
    const el = await renderLab(window, fake, key1);
    ok('review card renders', !!el && /Review inferred tropes/.test(el.textContent));
    ok('lists the inferred book by title', /Kill Decision/.test(el.textContent));
    ok('shows inferred trope chips', /Forced Proximity/.test(el.textContent) && /Enemies to Lovers/.test(el.textContent));
    ok('drops tropes missing from the taxonomy', !/nope/.test(el.textContent));
    const upBtn = el.querySelector('[data-review-book] [data-tv="1"][data-tid="t1"]');
    ok('▲ vote button wired per trope', !!upBtn);
    ok('Approve all button present', !!el.querySelector('[data-approve-all]'));
  }

  // D: ▲ writes a trope_votes upsert for the book.
  {
    const { window, fake } = buildDom();
    const key1 = probe(window, `bookKeyFor({title:'Kill Decision', authors:['Daniel Suarez']})`);
    const el = await renderLab(window, fake, key1);
    const upBtn = el.querySelector('[data-tv="1"][data-tid="t1"]');
    upBtn.click();
    await tick(10);
    const w = fake.upserts.find(u => u.trope_id === 't1');
    ok('▲ upserts vote=1 for (book, trope, user)',
      !!w && w.book_key === key1 && w.user_id === 'u1' && w.vote === 1);
    const el2 = window.document.getElementById('tropelab-review');
    ok('review re-renders after voting', !!el2 && /Forced Proximity/.test(el2.textContent));
  }

  // E: Approve all upvotes every inferred trope for the book.
  {
    const { window, fake } = buildDom();
    const key1 = probe(window, `bookKeyFor({title:'Kill Decision', authors:['Daniel Suarez']})`);
    const el = await renderLab(window, fake, key1);
    const btn = el.querySelector('[data-review-book] [data-approve-all]');
    btn.click();
    await tick(10);
    const votes = fake.upserts.filter(u => u.book_key === key1 && u.vote === 1).map(u => u.trope_id).sort();
    ok('Approve all votes 1 for each inferred trope',
      votes.length === 2 && votes[0] === 't1' && votes[1] === 't2');
  }

  // F: empty book_tropes shows the empty state, not a crash.
  {
    const { window, fake } = buildDom();
    await tick();
    fake.fire('SIGNED_IN', { id: 'u1', email: 'a@b.c' });
    await tick(8);
    runInWindow(window, `adminTab = 'tropes'; isAppAdmin = true; renderAdmin()`);
    await tick(15);
    const el = window.document.getElementById('tropelab-review');
    ok('empty state when nothing inferred',
      !!el && /No inferred tropes yet/.test(el.textContent));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
