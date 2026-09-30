/* v206 claims write-path tests: the queue's upsertClaims (rejection filter,
   confirmed exclusion, delete-then-insert replace, provenance), the pump's
   claims-vs-legacy branch, and TropeClaims.listCandidates/setStatus.
   Run: node .test/claims-write.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

(async () => {
  const memStore = {};
  const ctx = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {
      getItem: k => (k in memStore ? memStore[k] : null),
      setItem: (k, v) => { memStore[k] = String(v); },
      removeItem: k => { delete memStore[k]; },
    },
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    SPICY_CONFIG: {},
    library: [],
    cloudClient: async () => null,
    fetch: async () => { throw new Error('no network in tests'); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  const load = f => vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
  load('156-trope-taxonomy.js');
  load('157-trope-inference.js');
  load('158-works.js');

  const probe = src => vm.runInContext(src, ctx);

  /* Fake Supabase client for the claims writer. */
  const claimsSb = ({ existing, calls }) => ({
    from: (table) => {
      if (table !== 'book_trope_claims') throw new Error('unexpected table ' + table);
      return {
        select: () => ({
          eq: (col, val) => {
            calls.push('select:' + col + '=' + val);
            return Promise.resolve({ data: existing, error: null });
          },
        }),
        delete: () => ({
          eq: (c1, v1) => ({ eq: (c2, v2) => ({ eq: (c3, v3) => {
            calls.push('delete:' + c1 + '=' + v1 + ',' + c2 + '=' + v2 + ',' + c3 + '=' + v3);
            return Promise.resolve({ error: null });
          } }) }),
        }),
        insert: (rows) => {
          calls.push('insert:' + rows.map(r => r.trope_id).join(','));
          calls.push('insertRows:' + JSON.stringify(rows));
          return Promise.resolve({ error: null });
        },
      };
    },
  });

  /* ---- A. upsertClaims: rejection filter + replace semantics ---- */
  {
    probe('ensureTropeQueueWired()');
    const calls = [];
    const existing = [
      { trope_id: 'vampire', status: 'rejected' },   // must never be resurrected
      { trope_id: 'dragons', status: 'confirmed' },  // must never be demoted
      { trope_id: 'revenge', status: 'candidate' },  // replaced
    ];
    vm.runInContext('cloudClient = async () => __sb;',
      Object.assign(ctx, { __sb: claimsSb({ existing, calls }) }));
    const upsert = probe('TropeQueue._upsertClaims');
    await probe(`(${upsert.toString()})('w-1', [
      { trope_id: 'vampire', confidence: 0.95 },
      { trope_id: 'dragons', confidence: 0.9 },
      { trope_id: 'revenge', confidence: 0.8 },
      { trope_id: 'mafia', confidence: 0.7 },
    ], { model: 'test-model' })`).catch(e => 'THREW: ' + e.message);

    ok('rejected trope never re-inserted', !calls.some(c => c === 'insert:vampire' || (c.indexOf('insert:') === 0 && c.includes('vampire'))));
    const insRows = JSON.parse(calls.find(c => c.indexOf('insertRows:') === 0).slice('insertRows:'.length));
    const ids = insRows.map(r => r.trope_id).sort();
    ok('only fresh candidates inserted (rejected+confirmed filtered)',
      JSON.stringify(ids) === JSON.stringify(['mafia', 'revenge']));
    ok('inserted rows carry provenance',
      insRows.every(r => r.status === 'candidate' && r.source_type === 'ai' &&
        r.work_id === 'w-1' && r.model === 'test-model' &&
        r.evidence && r.evidence.taxonomy_version === 1));
    ok('old AI candidates deleted first (replace semantics)',
      calls.some(c => c === 'delete:work_id=w-1,status=candidate,source_type=ai'));
  }

  {
    // No fresh tropes: delete still runs, insert skipped.
    const calls = [];
    vm.runInContext('cloudClient = async () => __sb;',
      Object.assign(ctx, { __sb: claimsSb({ existing: [{ trope_id: 'vampire', status: 'rejected' }], calls }) }));
    const upsert = probe('TropeQueue._upsertClaims');
    await probe(`(${upsert.toString()})('w-2', [{ trope_id: 'vampire', confidence: 0.9 }], {})`);
    ok('all-rejected set: delete runs, nothing inserted',
      calls.some(c => c.indexOf('delete:') === 0) && !calls.some(c => c.indexOf('insert:') === 0));
  }

  {
    // Signed out: writer throws so the queue marks the job failed (retryable).
    vm.runInContext('cloudClient = async () => null;', ctx);
    const upsert = probe('TropeQueue._upsertClaims');
    let threw = false;
    try { await probe(`(${upsert.toString()})('w-3', [{ trope_id: 'mafia', confidence: 0.5 }], {})`); }
    catch (e) { threw = true; }
    ok('null client throws (job fails, retried later)', threw);
  }

  /* ---- B. pump branch: work resolved -> claims; unresolvable -> legacy ---- */
  async function pumpOnce({ workId, legacyRows }) {
    probe('TropeQueue.reset()');
    const calls = [];
    vm.runInContext('cloudClient = async () => __sb;',
      Object.assign(ctx, { __sb: claimsSb({ existing: [], calls }) }));
    probe(`inferBookTropes = async (book) => ({ tropes: [{ id: 'dragons', confidence: 0.9 }], model: 'm' });
      resolveWork = async (book) => ${JSON.stringify(workId)};
      window.__legacyRows = null;
      TropeQueue.configure({
        resolveBook: (id) => ({ id, title: 'T', authors: ['A'] }),
        upsertRows: async (rows) => { window.__legacyRows = rows; },
      });`);
    probe(`TropeQueue.enqueue(['b1']); TropeQueue.start();`);
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const done = probe('TropeQueue.snapshot().done');
      if (done >= 1) break;
      await new Promise(r => setTimeout(r, 100));
    }
    return { calls, legacyRows: probe('window.__legacyRows'),
             done: probe('TropeQueue.snapshot().done') };
  }

  {
    const r = await pumpOnce({ workId: 'w-9' });
    ok('pump completes via claims path', r.done === 1);
    ok('claims inserted on the pump path',
      r.calls.some(c => c === 'insert:dragons'));
    ok('legacy book_tropes write NOT used when work resolves', r.legacyRows === null);
    probe('TropeQueue.reset()');
  }

  {
    const r = await pumpOnce({ workId: null });
    ok('pump completes via legacy fallback', r.done === 1);
    ok('legacy book_tropes write used when work is unresolvable',
      Array.isArray(r.legacyRows) && r.legacyRows.length === 1 &&
      r.legacyRows[0].trope_id === 'dragons' && r.legacyRows[0].book_key);
    ok('claims untouched on the fallback path',
      !r.calls.some(c => c.indexOf('insert:') === 0));
    probe('TropeQueue.reset()');
  }

  /* ---- C. TropeClaims.listCandidates: grouping + name resolution ---- */
  {
    const rows = [
      { work_id: 'w-1', trope_id: 'dragons', confidence: 0.9,
        works: { title: 'Fourth Wing', authors: ['Rebecca Yarros'] } },
      { work_id: 'w-1', trope_id: 'bogus-id', confidence: 0.99,
        works: { title: 'Fourth Wing', authors: ['Rebecca Yarros'] } },
      { work_id: 'w-2', trope_id: 'mafia', confidence: 0.7,
        works: { title: 'Mafia Book', authors: ['Anon'] } },
    ];
    const calls = [];
    const sb = {
      from: (table) => ({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({
          limit: async () => { calls.push('list:' + table); return { data: rows, error: null }; },
        }) }) }) }),
      }),
    };
    vm.runInContext('cloudClient = async () => __sb;', Object.assign(ctx, { __sb: sb }));
    const groups = await probe('TropeClaims.listCandidates(500)');
    ok('candidates grouped by work', groups.length === 2);
    const g1 = groups.find(g => g.workId === 'w-1');
    ok('work title/authors resolved', g1.title === 'Fourth Wing' && g1.authors === 'Rebecca Yarros');
    ok('unknown trope ids dropped', g1.tropes.length === 1 && g1.tropes[0].id === 'dragons');
    ok('taxonomy name attached', g1.tropes[0].name === 'Dragons');
  }

  {
    // Signed out -> [] (never throws).
    vm.runInContext('cloudClient = async () => null;', ctx);
    const groups = await probe('TropeClaims.listCandidates(500)');
    ok('listCandidates returns [] when signed out', Array.isArray(groups) && groups.length === 0);
  }

  /* ---- D. TropeClaims.setStatus ---- */
  {
    const calls = [];
    const sb = {
      from: (table) => ({
        update: (patch) => ({ eq: (c1, v1) => ({ eq: (c2, v2) => ({ eq: (c3, v3) => {
          calls.push('update:' + JSON.stringify(patch) + '|' + c1 + '=' + v1 + ',' + c2 + '=' + v2 + ',' + c3 + '=' + v3);
          return Promise.resolve({ error: null });
        } }) }) }),
      }),
    };
    vm.runInContext('cloudClient = async () => __sb;', Object.assign(ctx, { __sb: sb }));
    probe(`TropeStore._cache['w:w-7'] = { tropes: [], at: Date.now() };`);
    await probe(`TropeClaims.setStatus('w-7', 'dragons', 'rejected')`);
    ok('reject updates only candidate rows',
      calls.some(c => c === 'update:{"status":"rejected"}|work_id=w-7,trope_id=dragons,status=candidate'));
    ok('work cache invalidated after moderation',
      probe(`!('w:w-7' in TropeStore._cache)`));

    await probe(`TropeClaims.setStatus('w-7', 'mafia', 'confirmed')`);
    ok('confirm updates only candidate rows',
      calls.some(c => c.indexOf('"status":"confirmed"') !== -1));

    let threw = false;
    try { await probe(`TropeClaims.setStatus('w-7', 'mafia', 'bogus')`); }
    catch (e) { threw = true; }
    ok('invalid status rejected', threw);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
