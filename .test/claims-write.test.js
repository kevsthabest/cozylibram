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
          in: (col, vals) => {
            calls.push('delete:in:' + col + '=' + vals.join(','));
            return Promise.resolve({ error: null });
          },
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
      { id: 'r1', trope_id: 'vampire', status: 'rejected', source_type: 'ai' }, // never resurrected
      { id: 'c1', trope_id: 'dragons', status: 'confirmed', source_type: 'ai' }, // human-confirmed: never demoted
      { id: 'c2', trope_id: 'revenge', status: 'candidate', source_type: 'ai' }, // replaced
      { id: 'c3', trope_id: 'mafia', status: 'confirmed', source_type: 'ai', // auto: regenerable
        evidence: { auto_confirmed: true } },
    ];
    vm.runInContext('cloudClient = async () => __sb;',
      Object.assign(ctx, { __sb: claimsSb({ existing, calls }) }));
    const upsert = probe('TropeQueue._upsertClaims');
    await probe(`(${upsert.toString()})('w-1', [
      { trope_id: 'vampire', confidence: 0.95, evidence: ['vampires stalk the night'] },
      { trope_id: 'dragons', confidence: 0.9, evidence: ['dragons soar above'] },
      { trope_id: 'revenge', confidence: 0.8, evidence: ['she seeks revenge'] },
      { trope_id: 'grumpy-x-sunshine', confidence: 0.7 },
      { trope_id: 'mafia', confidence: 0.92, evidence: ['the mafia family rules'] },
    ], { model: 'test-model', inputHash: 'h1' })`).catch(e => 'THREW: ' + e.message);

    ok('rejected trope never re-inserted', !calls.some(c => c === 'insert:vampire' || (c.indexOf('insert:') === 0 && c.includes('vampire'))));
    const insRows = JSON.parse(calls.find(c => c.indexOf('insertRows:') === 0).slice('insertRows:'.length));
    const ids = insRows.map(r => r.trope_id).sort();
    ok('only fresh tropes inserted (rejected + human-confirmed filtered)',
      JSON.stringify(ids) === JSON.stringify(['grumpy-x-sunshine', 'mafia', 'revenge']));
    const byId = Object.fromEntries(insRows.map(r => [r.trope_id, r]));
    ok('high-confidence + evidence auto-publishes as confirmed',
      byId.mafia.status === 'confirmed' && byId.mafia.evidence.auto_confirmed === true);
    ok('medium trope stays candidate even with evidence',
      byId.revenge.status === 'candidate' && byId.revenge.evidence.auto_confirmed !== true);
    ok('high-confidence without evidence stays candidate',
      byId['grumpy-x-sunshine'].status === 'candidate');
    ok('inserted rows carry provenance incl. input hash',
      insRows.every(r => r.source_type === 'ai' && r.work_id === 'w-1' &&
        r.model === 'test-model' && r.evidence &&
        r.evidence.taxonomy_version === 1 && r.evidence.input_hash === 'h1' &&
        Array.isArray(r.evidence.evidence)));
    ok('regenerable rows deleted by id (candidate + auto-confirmed)',
      calls.some(c => c === 'delete:in:id=c2,c3'));
    ok('human-confirmed + rejected rows never deleted',
      !calls.some(c => /delete:in.*c1/.test(c) || /delete:in.*r1/.test(c)));
  }

  {
    // No fresh tropes and nothing regenerable: no delete, no insert.
    const calls = [];
    vm.runInContext('cloudClient = async () => __sb;',
      Object.assign(ctx, { __sb: claimsSb({ existing: [{ id: 'r1', trope_id: 'vampire', status: 'rejected', source_type: 'ai' }], calls }) }));
    const upsert = probe('TropeQueue._upsertClaims');
    await probe(`(${upsert.toString()})('w-2', [{ trope_id: 'vampire', confidence: 0.9 }], {})`);
    ok('all-rejected set: nothing deleted, nothing inserted',
      !calls.some(c => c.indexOf('delete:') === 0) && !calls.some(c => c.indexOf('insert:') === 0));
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
    // v271: dual-write — the legacy table mirrors the claims-kept tropes so
    // Trope Lab coverage and the review queue keep working.
    ok('legacy book_tropes write mirrors claims-kept tropes when work resolves',
      Array.isArray(r.legacyRows) && r.legacyRows.length === 1 &&
      r.legacyRows[0].trope_id === 'dragons' && r.legacyRows[0].book_key);
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
        status: 'candidate', source_type: 'ai',
        works: { title: 'Fourth Wing', authors: ['Rebecca Yarros'] } },
      { work_id: 'w-1', trope_id: 'bogus-id', confidence: 0.99,
        status: 'candidate', source_type: 'ai',
        works: { title: 'Fourth Wing', authors: ['Rebecca Yarros'] } },
      { work_id: 'w-2', trope_id: 'mafia', confidence: 0.7,
        status: 'candidate', source_type: 'ai',
        works: { title: 'Mafia Book', authors: ['Anon'] } },
      { work_id: 'w-3', trope_id: 'revenge', confidence: 0.95,
        status: 'confirmed', source_type: 'ai', evidence: { auto_confirmed: true },
        works: { title: 'Auto Book', authors: ['Anon'] } },
      { work_id: 'w-3', trope_id: 'vampire', confidence: 0.9,
        status: 'confirmed', source_type: 'ai', evidence: {},
        works: { title: 'Auto Book', authors: ['Anon'] } },
    ];
    const calls = [];
    const sb = {
      from: (table) => ({
        select: () => ({ eq: () => ({ in: () => ({ order: () => ({
          limit: async () => { calls.push('list:' + table); return { data: rows, error: null }; },
        }) }) }) }),
      }),
    };
    vm.runInContext('cloudClient = async () => __sb;', Object.assign(ctx, { __sb: sb }));
    const groups = await probe('TropeClaims.listCandidates(500)');
    ok('candidates grouped by work', groups.length === 3);
    const g1 = groups.find(g => g.workId === 'w-1');
    ok('work title/authors resolved', g1.title === 'Fourth Wing' && g1.authors === 'Rebecca Yarros');
    ok('unknown trope ids dropped', g1.tropes.length === 1 && g1.tropes[0].id === 'dragons');
    ok('taxonomy name attached', g1.tropes[0].name === 'Dragons');
    const g3 = groups.find(g => g.workId === 'w-3');
    ok('auto-published claim listed with auto flag',
      g3.tropes.length === 1 && g3.tropes[0].id === 'revenge' && g3.tropes[0].auto === true);
    ok('human-confirmed claim excluded from review', !g3.tropes.some(t => t.id === 'vampire'));
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
    // __selRow: the row the pre-check select returns.
    const mkSb = (selRow) => ({
      from: (table) => ({
        select: (cols) => ({ eq: (c1, v1) => ({ eq: (c2, v2) => ({
          limit: async () => ({ data: selRow ? [selRow] : [], error: null }),
        }) }) }),
        update: (patch) => ({ eq: (c1, v1) => ({ eq: (c2, v2) => {
          calls.push('update:' + JSON.stringify(patch) + '|' + c1 + '=' + v1 + ',' + c2 + '=' + v2);
          return Promise.resolve({ error: null });
        } }) }),
      }),
    });
    const asSb = (selRow) =>
      vm.runInContext('cloudClient = async () => __sb;', Object.assign(ctx, { __sb: mkSb(selRow) }));
    asSb({ status: 'candidate', source_type: 'ai', evidence: {} });
    probe(`TropeStore._cache['w:w-7'] = { tropes: [], at: Date.now() };`);
    await probe(`TropeClaims.setStatus('w-7', 'dragons', 'rejected')`);
    ok('candidate can be rejected',
      calls.some(c => c === 'update:{"status":"rejected"}|work_id=w-7,trope_id=dragons'));
    ok('work cache invalidated after moderation',
      probe(`!('w:w-7' in TropeStore._cache)`));

    await probe(`TropeClaims.setStatus('w-7', 'mafia', 'confirmed')`);
    ok('candidate can be confirmed',
      calls.some(c => c.indexOf('"status":"confirmed"') !== -1));

    let threw = false;
    try { await probe(`TropeClaims.setStatus('w-7', 'mafia', 'bogus')`); }
    catch (e) { threw = true; }
    ok('invalid status rejected', threw);

    // Auto-published claim: reject allowed, confirm refused.
    asSb({ status: 'confirmed', source_type: 'ai', evidence: { auto_confirmed: true } });
    await probe(`TropeClaims.setStatus('w-7', 'dragons', 'rejected')`);
    ok('auto-published claim can be rejected', calls.length === 3);
    threw = false;
    try { await probe(`TropeClaims.setStatus('w-7', 'dragons', 'confirmed')`); }
    catch (e) { threw = true; }
    ok('auto-published claim cannot be re-confirmed', threw);

    // Human-confirmed claim: neither transition allowed.
    asSb({ status: 'confirmed', source_type: 'ai', evidence: {} });
    threw = false;
    try { await probe(`TropeClaims.setStatus('w-7', 'dragons', 'rejected')`); }
    catch (e) { threw = true; }
    ok('human-confirmed claim not reviewable', threw);

    // Non-AI row: refused.
    asSb({ status: 'candidate', source_type: 'community', evidence: {} });
    threw = false;
    try { await probe(`TropeClaims.setStatus('w-7', 'dragons', 'rejected')`); }
    catch (e) { threw = true; }
    ok('community claim not moderated here', threw);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
