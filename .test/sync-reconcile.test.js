// Regression pins for issues #335 and #336 (2026-11-02 review):
//
// #335: cloudPushNow upserted its batch unconditionally. A stale device
// (old _mtime, e.g. one that was offline while another device edited)
// regressed the cloud copy to its older record, and since the pull
// merge also keys on _mtime, the divergence never healed — the newer
// edits were silently lost everywhere.
//
// The fix's shape was ruled on 2026-11-02 (the User): the guard lives
// on the SERVER, not in the client — a client-side fetch-and-drop
// reconciliation shipped first and was replaced, because the fetch
// and the upsert are two round trips and a third device's push can
// land between them. The client now sends the batch to the
// push_books_guarded RPC (supabase/migrations/v643_push_books_guarded
// .sql), which compares and writes atomically per row and answers
// per-row outcomes. What is pinned HERE is the client half: the RPC
// is called with the batch, the direct upsert is not used, rejections
// are logged, a wholesale RPC failure aborts the push, and — the
// rollout window — a missing function degrades to the plain upsert
// WITH a warn line (never silently). The stub RPC below MIRRORS the
// SQL semantics against a fake store; the SQL's own posture is
// pinned in push-guard-migration.test.js and its behaviour against a
// real database is verified post-apply by
// supabase/push-guard-verification.sql (no live Postgres exists in
// this suite's world — that limit is stated, not papered over).
//
// #336: mergeAssign was Object.assign, which can add/overwrite keys
// but never remove them. A field deleted on one device (the codebase
// represents a deleted book field by the key's ABSENCE — see the
// `delete b.x` cleanups in migrateBook, js/020) resurrected from every
// peer whose copy still carried it, forever. When a remote record
// wins the merge, keys absent from the winning record must be deleted
// from the local book.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in sync-reconcile tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
const mk = (id, extra) => `({ id: '${id}', isbn: '978${id}', title: 'Book ${id}', authors: ['A'], cover: '',
  description: '', pageCount: 100, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'tbr', owned: true, ratings: {}, axes: ['spice'], myRating: 0,
  tropes: [], progress: 0, dateAdded: new Date().toISOString(), dateFinished: null, notes: ''
  ${extra || ''} })`;
// A full book record as plain data (Node side), for store fixtures
// and JSON-injected local books whose fields must match EXACTLY
// (the tie-break compares canonical forms, so fixtures that are
// meant to differ only in title must differ ONLY in title).
const mkData = (id, title, mtime) => ({
  id: id, isbn: '978' + id, title: title, authors: ['A'], cover: '',
  description: '', pageCount: 100, publishedDate: '', categories: [], publicRating: null,
  ratingsCount: 0, status: 'tbr', owned: true, ratings: {}, axes: ['spice'], myRating: 0,
  tropes: [], progress: 0, dateAdded: '2024-01-01T00:00:00.000Z', dateFinished: null, notes: '',
  _mtime: mtime,
});
const logHas = (frag) => probe(`AppLog.entries().some(e => e.tag === 'sync' && e.msg.indexOf(${JSON.stringify(frag)}) >= 0)`);

// JS mirror of the v643 SQL guard, run against the fake store. The
// owner is the stub's cloudUser ('u1'); the tie-break uses the app's
// own stableJson, the same canonical form the SQL mirrors.
function mirrorGuard(store, rows) {
  const outcomes = [];
  for (const row of rows) {
    const id = row.book_id, data = row.data;
    if (!id || !data || typeof data !== 'object') { outcomes.push({ book_id: id || null, status: 'rejected_invalid' }); continue; }
    const ix = store.findIndex(r => r.book_id === id);
    if (ix < 0) {
      store.push({ user_id: 'u1', book_id: id, isbn: row.isbn || null, data: data });
      outcomes.push({ book_id: id, status: 'written' }); continue;
    }
    const stM = (store[ix].data && store[ix].data._mtime) || 0;
    const inM = data._mtime || 0;
    if (inM > stM) {
      store[ix] = { user_id: 'u1', book_id: id, isbn: row.isbn || null, data: data };
      outcomes.push({ book_id: id, status: 'written' });
    } else if (inM < stM) {
      outcomes.push({ book_id: id, status: 'rejected_stale' });
    } else if (window.stableJson(data) > window.stableJson(store[ix].data)) {
      store[ix] = { user_id: 'u1', book_id: id, isbn: row.isbn || null, data: data };
      outcomes.push({ book_id: id, status: 'written' });
    } else if (window.stableJson(data) === window.stableJson(store[ix].data)) {
      outcomes.push({ book_id: id, status: 'written' });
    } else {
      outcomes.push({ book_id: id, status: 'rejected_tiebreak' });
    }
  }
  return outcomes;
}

// A __sbStub whose books upserts are captured (and, in fallback
// scenarios, applied unconditionally — the legacy semantics), whose
// rpc is supplied by the scenario, and whose deleted_books surface
// satisfies the tombstone leg (never exercised: tombstones stay []).
function mkStub(store, upsertCalls, rpcImpl) {
  const stub = {
    from: (table) => {
      if (table === 'books') return {
        upsert: async (rows) => {
          upsertCalls.push(...rows);
          for (const row of rows) {
            const ix = store.findIndex(r => r.book_id === row.book_id);
            if (ix < 0) store.push(row); else store[ix] = row;
          }
          return { error: null };
        },
        select: () => require('./harness').chainableSelect(store,
          r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data })),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
      };
      if (table === 'deleted_books') return {
        upsert: async () => ({ error: null }),
        select: () => require('./harness').chainableSelect([], () => ({})),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }) }) }),
      };
      throw new Error('unexpected table: ' + table);
    },
  };
  if (rpcImpl) stub.rpc = rpcImpl;
  return stub;
}

(async () => {
  await window.eval('storageReady');
  // ---------- #336: a winning merge deletes keys the winner lacks ----------
  runInWindow(`library = [${mk('d1', ", _mtime: 100, legacyJunk: 'gone', progressUnit: 'pct'")}]; tombstones = []; tombstoneFloor = 0;`);
  runInWindow(`mergeCloudBooks(library, [{ book_id: 'd1', isbn: null, data: { id: 'd1', title: 'Winner', _mtime: 200 } }]);`);
  ok('#336 winning merge applies the winner\'s values', probe(`library[0].title`) === 'Winner');
  ok('#336 a key absent from the winning record is deleted locally',
    probe(`'legacyJunk' in library[0]`) === false);
  ok('#336 a real field absent from the winner is deleted too',
    probe(`'progressUnit' in library[0]`) === false);
  ok('#336 the deletion is stable across a re-merge (no resurrection)',
    probe(`mergeCloudBooks(library, [{ book_id: 'd1', isbn: null, data: { id: 'd1', title: 'Winner', _mtime: 200 } }]), 'legacyJunk' in library[0]`) === false);

  // ---------- #335: the client-side reconciliation is gone ----------
  const syncSrc = fs.readFileSync(path.join(__dirname, '..', 'js/090-sync.js'), 'utf8');
  ok('#335 the client-side reconcilePushRows is removed (superseded by the server guard)',
    probe(`typeof reconcilePushRows`) === 'undefined' && !syncSrc.includes('reconcilePushRows'));
  ok('#335 the push leg names the server guard',
    syncSrc.includes("sb.rpc('push_books_guarded'"));

  // ---------- #335 scenario A: guarded push — stale rejected, fresh written ----------
  const storeA = [
    { user_id: 'u1', book_id: 's1', isbn: null, data: { id: 's1', title: 'Cloud Newer', _mtime: 9000 } },
  ];
  const upsertsA = [], rpcCallsA = [];
  window.__sbStub = mkStub(storeA, upsertsA, async (fn, args) => {
    rpcCallsA.push({ fn: fn, rows: args.p_rows });
    return { data: mirrorGuard(storeA, args.p_rows), error: null };
  });
  runInWindow(`cloudUser = { id: 'u1' }; tombstones = []; AppLog.clear();
    library = [${mk('s1', ", _mtime: 100")}, ${mk('s2', ", _mtime: 500")}];
    library[0].title = 'Stale Local'; markDirty(library[0]); markDirty(library[1]);`);
  const pushedA = await probe(`cloudPushNow()`);
  await tick(30);
  ok('#335 guarded push reports success', pushedA === true);
  ok('#335 the batch went to push_books_guarded exactly once',
    rpcCallsA.length === 1 && rpcCallsA[0].fn === 'push_books_guarded' && rpcCallsA[0].rows.length === 2);
  ok('#335 the guarded path never touches the direct upsert', upsertsA.length === 0);
  ok('#335 the stale book did NOT regress the newer cloud copy',
    storeA.find(r => r.book_id === 's1').data.title === 'Cloud Newer' &&
    storeA.find(r => r.book_id === 's1').data._mtime === 9000);
  ok('#335 a book the cloud does not hold newer still pushes normally',
    !!storeA.find(r => r.book_id === 's2'));
  ok('#335 the stale rejection is logged by book id',
    logHas('push guard: skipped 1 stale row(s)') && logHas('(s1)'));

  // ---------- #335 scenario B: equal _mtime resolves by the #129 tie-break ----------
  const storeB = [
    { user_id: 'u1', book_id: 't1', isbn: null, data: mkData('t1', 'Mango', 700) },
    { user_id: 'u1', book_id: 't2', isbn: null, data: mkData('t2', 'Zebra', 700) },
  ];
  const upsertsB = [];
  window.__sbStub = mkStub(storeB, upsertsB, async (fn, args) => ({ data: mirrorGuard(storeB, args.p_rows), error: null }));
  runInWindow(`cloudUser = { id: 'u1' }; tombstones = []; AppLog.clear();
    library = [${JSON.stringify(mkData('t1', 'Zebra', 700))}, ${JSON.stringify(mkData('t2', 'Mango', 700))}];
    library.forEach(b => markDirty(b));`);
  const pushedB = await probe(`cloudPushNow()`);
  await tick(30);
  ok('#335 tie-break push reports success', pushedB === true);
  ok('#335 the canonically greater record wins the tie (incoming t1 written)',
    storeB.find(r => r.book_id === 't1').data.title === 'Zebra');
  ok('#335 the canonically smaller record loses the tie (stored t2 kept)',
    storeB.find(r => r.book_id === 't2').data.title === 'Zebra');
  ok('#335 the tie-break rejection is logged by book id',
    logHas('lost the #129 tie-break') && logHas('(t2)'));

  // ---------- #335 scenario C: a wholesale RPC failure aborts the push ----------
  const storeC = [];
  const upsertsC = [];
  window.__sbStub = mkStub(storeC, upsertsC, async () => ({ data: null, error: { code: 'XX000', message: 'guard exploded' } }));
  runInWindow(`cloudUser = { id: 'u1' }; tombstones = []; AppLog.clear();
    library = [${mk('e1', ", _mtime: 800")}]; markDirty(library[0]);`);
  const pushedC = await probe(`cloudPushNow()`);
  await tick(30);
  ok('#335 a wholesale RPC error fails the push (no blind upsert)', pushedC === false);
  ok('#335 nothing was written on wholesale failure',
    storeC.length === 0 && upsertsC.length === 0);
  ok('#335 the failure is logged', logHas('push failed'));

  // ---------- #335 scenario D: function missing -> logged fallback to the plain upsert ----------
  const storeD = [
    { user_id: 'u1', book_id: 'm1', isbn: null, data: { id: 'm1', title: 'Cloud Newer', _mtime: 9000 } },
  ];
  const upsertsD = [];
  window.__sbStub = mkStub(storeD, upsertsD, async () => ({
    data: null,
    error: { code: 'PGRST202', message: 'Could not find the function public.push_books_guarded(p_rows) in the schema cache' },
  }));
  runInWindow(`cloudUser = { id: 'u1' }; tombstones = []; AppLog.clear();
    library = [${mk('m1', ", _mtime: 850")}]; library[0].title = 'Stale Local'; markDirty(library[0]);`);
  const pushedD = await probe(`cloudPushNow()`);
  await tick(30);
  ok('#335 pre-migration push still succeeds via the fallback', pushedD === true);
  ok('#335 the fallback is the plain upsert (legacy semantics, hole and all)',
    upsertsD.length === 1 && storeD.find(r => r.book_id === 'm1').data.title === 'Stale Local');
  ok('#335 the fallback warns — the unguarded window is never silent',
    probe(`AppLog.entries().some(e => e.level === 'warn' && e.msg.indexOf('push_books_guarded unavailable') >= 0)`) === true);

  // ---------- #335 scenario E: a client surface with no rpc at all -> same fallback ----------
  const storeE = [];
  const upsertsE = [];
  window.__sbStub = mkStub(storeE, upsertsE, null);
  runInWindow(`cloudUser = { id: 'u1' }; tombstones = []; AppLog.clear();
    library = [${mk('n1', ", _mtime: 860")}]; markDirty(library[0]);`);
  const pushedE = await probe(`cloudPushNow()`);
  await tick(30);
  ok('#335 no-rpc surface falls back and pushes', pushedE === true && upsertsE.length === 1);
  ok('#335 the no-rpc fallback warns too',
    probe(`AppLog.entries().some(e => e.level === 'warn' && e.msg.indexOf('push_books_guarded unavailable') >= 0)`) === true);

  console.log('\n' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
