/* v205 Work/Edition resolution tests: workKeysFor normalization, claim
   resolution rule (rejected wins), WorkStore.resolve find-or-create, and
   the TropeStore work-keyed read path with legacy fallback.
   Run: node .test/works.test.js */
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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
