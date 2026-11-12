/* v205 Work/Edition resolution tests: workKeysFor normalization, claim
   resolution rule (rejected wins), WorkStore.resolve find-or-create, and
   the TropeStore work-keyed read path with legacy fallback.
   Run: node .test/works.test.js */
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

  /* ---- A. workKeysFor: pure identity normalization ---- */
  {
    const k = probe(`workKeysFor({ title: 'The Fourth Wing', authors: ['Rebecca Yarros'], isbn: '9781649374189' })`);
    ok('title norm strips leading "the"', k.titleNorm === 'fourth wing');
    ok('author norm lowercased+joined', k.authorNorm === 'rebecca yarros');
    ok('isbn-13 kept', k.isbn === '9781649374189');
    ok('authors array preserved', JSON.stringify(k.authors) === '["Rebecca Yarros"]');

    ok('empty title -> null', probe(`workKeysFor({ title: '  ', authors: ['A'] })`) === null);
    ok('missing title -> null', probe('workKeysFor({ authors: ["A"] })') === null);

    const ks = probe(`workKeysFor({ title: 'Dune', authors: 'Frank Herbert' })`);
    ok('string author wrapped to array', JSON.stringify(ks.authors) === '["Frank Herbert"]');

    const k10 = probe(`workKeysFor({ title: 'Dune', isbn: '0441172717' })`);
    ok('isbn-10 kept', k10.isbn === '0441172717');
    const kBad = probe(`workKeysFor({ title: 'Dune', isbn: 'abc' })`);
    ok('garbage isbn -> null', kBad.isbn === null);

    const kDia = probe(`workKeysFor({ title: 'Café Society', authors: ['Émile Zola'] })`);
    ok('diacritics normalized', kDia.titleNorm === 'cafe society' && kDia.authorNorm === 'emile zola');
  }

  /* ---- B. resolveClaims: the rejected-wins resolution rule ---- */
  {
    // candidate + rejected coexist -> hidden
    let r = probe(`resolveClaims([
      { trope_id: 'enemies-to-lovers', status: 'candidate', confidence: 0.9, source_type: 'ai' },
      { trope_id: 'enemies-to-lovers', status: 'rejected', confidence: 0.4, source_type: 'community' },
      { trope_id: 'forced-proximity', status: 'candidate', confidence: 0.8, source_type: 'ai' },
    ])`);
    ok('rejected wins over candidate (hidden)', r.length === 1 && r[0].id === 'forced-proximity');

    // confirmed beats candidate
    r = probe(`resolveClaims([
      { trope_id: 'dragons', status: 'candidate', confidence: 0.95, source_type: 'ai' },
      { trope_id: 'dragons', status: 'confirmed', confidence: 0.6, source_type: 'community' },
    ])`);
    ok('confirmed outranks candidate', r.length === 1 && r[0].status === 'confirmed');

    // highest-confidence candidate wins among candidates
    r = probe(`resolveClaims([
      { trope_id: 'dragons', status: 'candidate', confidence: 0.5, source_type: 'ai' },
      { trope_id: 'dragons', status: 'candidate', confidence: 0.88, source_type: 'ai' },
    ])`);
    ok('best candidate wins', r.length === 1 && r[0].confidence === 0.88);

    // unknown trope ids dropped, disputed hidden, sorted desc
    r = probe(`resolveClaims([
      { trope_id: 'bogus-id', status: 'candidate', confidence: 0.99, source_type: 'ai' },
      { trope_id: 'vampire', status: 'disputed', confidence: 0.9, source_type: 'community' },
      { trope_id: 'revenge', status: 'candidate', confidence: 0.7, source_type: 'ai' },
      { trope_id: 'mafia', status: 'candidate', confidence: 0.85, source_type: 'ai' },
    ])`);
    ok('unknown ids dropped, disputed hidden',
      r.length === 2 && r.every(t => t.id === 'mafia' || t.id === 'revenge'));
    ok('sorted by confidence desc', r[0].id === 'mafia' && r[1].id === 'revenge');
    ok('names come from taxonomy', r[0].name === 'Mafia');

    ok('empty claims -> empty', probe('resolveClaims([])').length === 0);
    ok('null claims -> empty', probe('resolveClaims(null)').length === 0);
  }

  /* ---- C. WorkStore.resolve: find-or-create with injected client ---- */
  const fakeSb = ({ workId, upsertId, failUpsert, calls }) => ({
    from: (table) => {
      if (table === 'works') return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => {
          calls.push('works.select');
          return { data: workId ? { id: workId } : null, error: null };
        } }) }) }),
        upsert: (row, opts) => ({ select: () => ({ maybeSingle: async () => {
          calls.push('works.upsert:' + (opts && opts.onConflict));
          if (failUpsert) return { data: null, error: new Error('RLS denied') };
          return { data: { id: upsertId || 'w-new' }, error: null };
        } }) }),
      };
      if (table === 'editions') return {
        upsert: async (row, opts) => {
          calls.push('editions.upsert:' + JSON.stringify(row));
          return { data: null, error: null };
        },
      };
      throw new Error('unexpected table ' + table);
    },
  });
  const book = { id: 'b1', title: 'Fourth Wing', authors: ['Rebecca Yarros'], isbn: '9781649374189' };

  // Real injection path: stash the fake client on window, resolve via a wrapper.
  probe(`window.__fakeSb = null;
    window.__resolveWith = async (b) => WorkStore.resolve(b, { getClient: async () => window.__fakeSb });`);

  {
    probe('WorkStore.clear()');
    const calls = [];
    probe('window.__fakeSb = null'); // placeholder; set below via runInContext
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSb({ workId: 'w-1', calls }) }));
    const id = await probe('window.__resolveWith(' + JSON.stringify(book) + ')');
    ok('existing work resolves by select', id === 'w-1');
    ok('no upsert when work exists', !calls.some(c => c.indexOf('works.upsert') === 0));
    ok('edition registered by isbn', calls.some(c =>
      c.indexOf('editions.upsert') === 0 && c.indexOf('9781649374189') !== -1 && c.indexOf('w-1') !== -1));
    // Session cache: second resolve hits no client at all.
    calls.length = 0;
    const id2 = await probe('window.__resolveWith(' + JSON.stringify(book) + ')');
    ok('resolved id cached per session', id2 === 'w-1' && calls.length === 0);
    probe('WorkStore.clear()');
  }

  {
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSb({ workId: null, upsertId: 'w-2', calls }) }));
    const id = await probe('window.__resolveWith(' + JSON.stringify(book) + ')');
    ok('missing work is created via upsert', id === 'w-2');
    ok('upsert uses the norm unique constraint',
      calls.some(c => c === 'works.upsert:title_norm,author_norm'));
    probe('WorkStore.clear()');
  }

  {
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSb({ workId: null, failUpsert: true, calls }) }));
    const id = await probe('window.__resolveWith(' + JSON.stringify(book) + ')');
    ok('RLS denial resolves null (never throws)', id === null);
    const before = calls.filter(c => c.indexOf('works.upsert') === 0).length;
    await probe('window.__resolveWith(' + JSON.stringify(book) + ')');
    const after = calls.filter(c => c.indexOf('works.upsert') === 0).length;
    ok('failure is session-cached (no retry storm)', before === 1 && after === 1);
    probe('WorkStore.clear()');
  }

  {
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSb({ workId: 'w-9', calls }) }));
    const id = await probe(`window.__resolveWith({ title: '   ' })`);
    ok('untitled book -> null without touching the client', id === null && calls.length === 0);
    const id2 = await probe('WorkStore.resolve({ title: "x" }, { getClient: async () => null })');
    ok('null client -> null (never throws)', id2 === null);
    probe('WorkStore.clear()');
  }

  /* ---- D. TropeStore work-keyed read path + legacy fallback ----
     NOTE: getBookTropes calls ensureTropeQueueWired(), which configures the
     real readers — so wire first, then override with test doubles. */
  probe('ensureTropeQueueWired()');
  {
    probe(`resolveWork = async (b) => 'w-claims';
      TropeStore.configure({ readClaims: async (wid) => (wid === 'w-claims' ? [
        { trope_id: 'enemies-to-lovers', status: 'candidate', confidence: 0.9, source_type: 'ai' },
        { trope_id: 'enemies-to-lovers', status: 'rejected', confidence: 0.3, source_type: 'community' },
        { trope_id: 'dragons', status: 'confirmed', confidence: 0.85, source_type: 'community' },
      ] : []) });
      TropeStore.invalidate();`);
    const r = await probe(`TropeStore.getBookTropes(${JSON.stringify(book)})`);
    ok('claims path returns db origin', r.origin === 'db');
    ok('rejected trope hidden via claims path',
      r.tropes.length === 1 && r.tropes[0].id === 'dragons');
    ok('confirmed status preserved', r.tropes[0].status === 'confirmed');
    probe('TropeStore.invalidate()');
  }

  {
    // Work with no claims -> falls back to the legacy book_tropes read.
    probe(`resolveWork = async (b) => 'w-empty';
      TropeStore.configure({ readClaims: async () => [],
        readRows: async () => [{ trope_id: 'revenge', confidence: 0.77, source: 'llm' }] });
      TropeStore.invalidate();`);
    const r = await probe(`TropeStore.getBookTropes(${JSON.stringify(book)})`);
    ok('empty claims fall back to legacy book_tropes',
      r.origin === 'db' && r.tropes.length === 1 && r.tropes[0].id === 'revenge');
    probe('TropeStore.invalidate()');
  }

  {
    // resolveWork failing (158 missing / offline) -> legacy path, never throws.
    probe(`resolveWork = async (b) => { throw new Error('offline'); };
      TropeStore.configure({ readClaims: async () => { throw new Error('unreachable'); },
        readRows: async () => [{ trope_id: 'mafia', confidence: 0.66, source: 'llm' }] });
      TropeStore.invalidate();`);
    const r = await probe(`TropeStore.getBookTropes(${JSON.stringify(book)})`);
    ok('resolve failure still falls back to legacy',
      r.origin === 'db' && r.tropes.length === 1 && r.tropes[0].id === 'mafia');
    probe('TropeStore.invalidate()');
  }

  /* ---- E. v272 work identity hub + #363 register_work client ---- */
  ok('providerIdsFromBook picks up hcId', JSON.stringify(
    probe(`providerIdsFromBook({ title: 'T', hcId: 12345 })`)) === '{"hardcover_id":"12345"}');
  ok('providerIdsFromBook picks up OL work key', JSON.stringify(
    probe(`providerIdsFromBook({ title: 'T', workKey: '/works/OL123W' })`)) === '{"openlibrary_id":"/works/OL123W"}');
  ok('providerIdsFromBook ignores garbage workKey', JSON.stringify(
    probe(`providerIdsFromBook({ title: 'T', workKey: 'nonsense' })`)) === '{}');
  ok('providerIdsFromBook empty book -> {}', JSON.stringify(
    probe('providerIdsFromBook(null)')) === '{}');

  // #363: with register_work on the server, resolve() registers through
  // the RPC alone — the direct writes (select/upsert/update) are the
  // pre-migration fallback, exercised only when the function is absent.
  const fakeSbRpc = ({ result, rpcError, calls }) => ({
    rpc: async (fn, args) => {
      calls.push('rpc:' + fn + ':' + JSON.stringify(args));
      if (rpcError) return { data: null, error: rpcError };
      return { data: result, error: null };
    },
    from: (table) => {
      calls.push('from:' + table);
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
        upsert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'w-direct' }, error: null }) }) }),
        update: () => ({ eq: async () => ({ data: null, error: null }) }),
      };
    },
  });
  const rpcArgs = calls => {
    const c = calls.find(x => x.indexOf('rpc:register_work:') === 0);
    return c ? JSON.parse(c.slice('rpc:register_work:'.length)) : null;
  };
  probe(`window.__resolveWith = async (b) => WorkStore.resolve(b, { getClient: async () => window.__fakeSb });`);

  {
    // RPC preferred: identity keys + proposed provider ids go up in one
    // call; the work id comes back; no direct table write is issued, so
    // provider ids merge server-side (the retired client UPDATE is gone).
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSbRpc({
      result: { work_id: 'w-rpc', edition_id: 'e-1', created_work: true, created_edition: true, isbn: 'registered' },
      calls }) }));
    probe('WorkStore.clear()');
    const id = await probe(`window.__resolveWith({ id: 'b-rpc', title: 'Fourth Wing', authors: ['Rebecca Yarros'], isbn: '9781649374189', hcId: 777, workKey: '/works/OL123W' })`);
    ok('RPC path resolves the work id', id === 'w-rpc');
    const args = rpcArgs(calls);
    ok('RPC receives the identity keys',
      !!args && args.p_title === 'Fourth Wing' && args.p_title_norm === 'fourth wing' &&
      args.p_author_norm === 'rebecca yarros' && args.p_isbn === '9781649374189');
    ok('provider ids are proposed to the RPC',
      !!args && args.p_provider_ids.hardcover_id === '777' &&
      args.p_provider_ids.openlibrary_id === '/works/OL123W');
    ok('RPC path issues no direct writes (no select/upsert/UPDATE)',
      !calls.some(c => c.indexOf('from:') === 0));
    probe('WorkStore.clear()');
  }

  {
    // Function missing (PGRST202): the tolerant client falls back to the
    // direct writes the pre-migration policies still allow.
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSbRpc({
      result: null,
      rpcError: { code: 'PGRST202', message: 'Could not find the function public.register_work(p_title, p_title_norm) in the schema cache' },
      calls }) }));
    probe('WorkStore.clear()');
    const id = await probe(`window.__resolveWith({ id: 'b-fb', title: 'Fallback Book', authors: ['A U Thor'], isbn: '9781649374189' })`);
    ok('missing RPC falls back to the direct upsert', id === 'w-direct');
    ok('fallback wrote directly to works', calls.some(c => c === 'from:works'));
    probe('WorkStore.clear()');
  }

  {
    // Rejected ISBN: the work still registers and resolves — the bad
    // scan is not a catalogue event, and resolve() surfaces no new UI.
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSbRpc({
      result: { work_id: 'w-rej', edition_id: null, created_work: true, created_edition: false, isbn: 'rejected' },
      calls }) }));
    probe('WorkStore.clear()');
    const id = await probe(`window.__resolveWith({ id: 'b-rej', title: 'Bad Scan', authors: ['A U Thor'], isbn: '9781649374180' })`);
    ok('rejected ISBN still resolves the work', id === 'w-rej');
    probe('WorkStore.clear()');
  }

  {
    // Conflict ISBN: taken by another work's edition — never reassigned,
    // no edition id handed back, and the caller's own work still resolves.
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSbRpc({
      result: { work_id: 'w-conf', edition_id: null, created_work: false, created_edition: false, isbn: 'conflict' },
      calls }) }));
    probe('WorkStore.clear()');
    const id = await probe(`window.__resolveWith({ id: 'b-conf', title: 'Same ISBN Other Work', authors: ['A U Thor'], isbn: '9781649374189' })`);
    ok('conflict ISBN still resolves the caller\'s work', id === 'w-conf');
    probe('WorkStore.clear()');
  }

  {
    // A real RPC error (not the missing-function class) fails closed:
    // resolve() returns null and does NOT fall back to blind writes.
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSbRpc({
      result: null,
      rpcError: { code: 'P0001', message: 'register_work: an authenticated caller is required' },
      calls }) }));
    probe('WorkStore.clear()');
    const id = await probe(`window.__resolveWith({ id: 'b-err', title: 'No Auth', authors: ['A U Thor'] })`);
    ok('real RPC error resolves null without fallback writes',
      id === null && !calls.some(c => c.indexOf('from:') === 0));
    probe('WorkStore.clear()');
  }

  {
    // workAttachProviderIds: a late-learned provider id attaches by
    // re-registering through the RPC — no direct UPDATE anywhere.
    const calls = [];
    vm.runInContext('window.__fakeSb = __sb;', Object.assign(ctx, { __sb: fakeSbRpc({
      result: { work_id: 'w-att', edition_id: null, created_work: false, created_edition: false, isbn: 'absent' },
      calls }) }));
    probe('window.__realCloud = cloudClient; cloudClient = async () => window.__fakeSb;');
    await probe(`workAttachProviderIds({ title: 'Attach Me', authors: ['A U Thor'] }, { hardcover_id: '999' })`);
    probe('cloudClient = window.__realCloud;');
    const args = rpcArgs(calls);
    ok('attach proposes the learned ids through the RPC',
      !!args && args.p_provider_ids.hardcover_id === '999');
    ok('attach issues no direct UPDATE', !calls.some(c => c.indexOf('from:') === 0));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
