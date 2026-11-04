/* v206 claims write-path tests: the queue's upsertClaims, the pump's
   claims-vs-legacy branch, and TropeClaims.listCandidates/setStatus.
   v646 (#408): the replace cycle, the survival rules and the publish
   decision moved server-side into the write_trope_claims RPC, so the
   writer sections here pin the CLIENT seam — the proposal payload,
   the written-set pass-through the legacy mirror depends on, and the
   throw-on-error contract. The server's semantics are pinned by
   .test/claims-writer.test.js (migration posture) and exercised
   against the live function in the post-apply probe pack.
   Run: node .test/claims-write.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classicize } = require('./harness');

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

  // R3 repoint (migration plan §9.3): js/156 is a real ES module since
  // phase 2 batch 6. classicize restores the classic body before
  // evaluation (identity on the classic files loaded here). Loading
  // plumbing only — assertions untouched.
  const load = f => vm.runInContext(
    classicize(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), f), ctx, { filename: f });
  load('156-trope-taxonomy.js');
  load('157-trope-inference.js');
  load('158-works.js');

  const probe = src => vm.runInContext(src, ctx);

  /* Fake Supabase client for the claims writer: the v646 writer speaks
     rpc only. rpcResult is the canned server reply; by default the fake
     echoes the proposed trope_ids as the written set (the seam contract
     — survival filtering is the server's job, pinned elsewhere). Any
     direct table access throws: the client must not go back to running
     the replace cycle itself. */
  const claimsSb = ({ rpcResult, calls }) => ({
    rpc: (fn, args) => {
      calls.push('rpc:' + fn);
      calls.push('rpcArgs:' + JSON.stringify(args));
      if (rpcResult) return Promise.resolve(rpcResult);
      const written = (args.p_claims || []).map(c => c.trope_id);
      return Promise.resolve({
        data: { written, confirmed: [], skipped: [] }, error: null });
    },
    from: (table) => {
      throw new Error('claims writer must not touch tables directly (' + table + ')');
    },
  });

  /* ---- A. upsertClaims: the proposal seam (v646) ----
     The survival rules (rejected never resurrected, human-confirmed
     never demoted, only regenerable rows replaced) and the publish
     decision are the server's now; what this section pins is that the
     client proposes faithfully and consumes the verdict faithfully. */
  {
    probe('ensureTropeQueueWired()');
    const calls = [];
    vm.runInContext('cloudClient = async () => __sb;',
      Object.assign(ctx, { __sb: claimsSb({ calls }) }));
    const upsert = probe('TropeQueue._upsertClaims');
    const written = await probe(`(${upsert.toString()})('w-1', [
      { trope_id: 'vampire', confidence: 0.95, evidence: ['vampires stalk the night'] },
      { trope_id: 'dragons', confidence: 0.9, evidence: ['dragons soar above'] },
      { trope_id: 'revenge', confidence: 0.8, evidence: ['she seeks revenge'] },
      { trope_id: 'grumpy-x-sunshine', confidence: 0.7 },
      { trope_id: 'mafia', confidence: 0.92, evidence: ['the mafia family rules'] },
    ], { model: 'test-model', inputHash: 'h1' })`).catch(e => 'THREW: ' + e.message);

    ok('writer calls the confirmed-writer RPC and nothing else',
      calls.length === 2 && calls[0] === 'rpc:write_trope_claims');
    const args = JSON.parse(calls[1].slice('rpcArgs:'.length));
    ok('proposal targets the work and carries the run provenance',
      args.p_work_id === 'w-1' && args.p_model === 'test-model' &&
      args.p_input_hash === 'h1' && args.p_taxonomy_version === 1 &&
      typeof args.p_taxonomy_rev === 'number');
    ok('every proposed trope rides with confidence + evidence quotes',
      Array.isArray(args.p_claims) && args.p_claims.length === 5 &&
      args.p_claims.every(c => typeof c.trope_id === 'string' &&
        typeof c.confidence === 'number' && Array.isArray(c.evidence)));
    ok('the proposal carries no status and no evidence envelope (server decides)',
      args.p_claims.every(c => !('status' in c) && !('auto_confirmed' in c)));
    ok('written set passes through for the legacy mirror',
      JSON.stringify(written) === JSON.stringify(
        ['vampire', 'dragons', 'revenge', 'grumpy-x-sunshine', 'mafia']));
  }

  {
    // An empty proposal still runs the replace cycle server-side (the
    // wholesale delete of regenerable rows must not be short-circuited
    // by a client-side early return), and an rpc error throws so the
    // queue marks the job failed and retries later.
    const calls = [];
    vm.runInContext('cloudClient = async () => __sb;',
      Object.assign(ctx, { __sb: claimsSb({ calls }) }));
    const upsert = probe('TropeQueue._upsertClaims');
    const out = await probe(`(${upsert.toString()})('w-2', [], {})`);
    ok('empty proposal still calls the RPC (replace cycle is server-side)',
      calls.some(c => c === 'rpc:write_trope_claims') &&
      JSON.parse(calls.find(c => c.indexOf('rpcArgs:') === 0).slice('rpcArgs:'.length)).p_claims.length === 0 &&
      Array.isArray(out) && out.length === 0);

    const errCalls = [];
    vm.runInContext('cloudClient = async () => __sb;',
      Object.assign(ctx, { __sb: claimsSb({
        rpcResult: { data: null, error: { message: 'boom' } }, calls: errCalls }) }));
    let threw = false;
    try { await probe(`(${upsert.toString()})('w-2', [{ trope_id: 'mafia', confidence: 0.5 }], {})`); }
    catch (e) { threw = true; }
    ok('rpc error throws (job fails, retried later)', threw);
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
      Object.assign(ctx, { __sb: claimsSb({ calls }) }));
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
    ok('claims proposed on the pump path',
      r.calls.some(c => c.indexOf('rpcArgs:') === 0 && c.includes('dragons')));
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
      !r.calls.some(c => c === 'rpc:write_trope_claims'));
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
