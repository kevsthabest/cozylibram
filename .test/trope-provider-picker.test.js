/* v160 in-app provider/model picker tests:
   1. SQL: trope_provider_settings table + RLS policies in supabase/tropes.sql.
   2. Client: get/set round-trip, localStorage fallback, the override riding
      along in the /api/trope-infer request body (and omitted when unset),
      tropeProviderInfo reflecting the override.
   3. Proxy (functions/api/trope-infer.js, imported as ESM with a stubbed
      upstream): default env path unchanged, client override routes to the
      per-provider key + allowlist URL, missing key -> descriptive 503,
      unknown provider / unpaired provider+model / bad model -> 400, and
      TROPE_API_KEY still backs the env-default provider.
   Run: node .test/trope-provider-picker.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'tropes.sql'), 'utf8');

(async () => {
  /* ---- 1. SQL ---- */
  ok('tropes.sql creates trope_provider_settings',
    /create table if not exists trope_provider_settings/.test(sql));
  ok('settings row is single-row (id = 1)',
    /check \(id = 1\)/.test(sql));
  ok('settings: signed-in read, admin write',
    sql.includes('"trope_provider_settings: signed-in read"') &&
    sql.includes('"trope_provider_settings: admin write"'));
  ok('admin write policy uses is_admin()',
    /trope_provider_settings: admin write"[\s\S]*?is_admin\(\)/.test(sql));

  /* ---- 2. Client ---- */
  const memStore = {};
  let sbRow = null; // the shared settings row, as the fake Supabase sees it
  let upsertArgs = null;
  const fakeSb = {
    from: (t) => {
      if (t !== 'trope_provider_settings') throw new Error('unexpected table ' + t);
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: sbRow, error: null }) }) }),
        upsert: async (row, opts) => { upsertArgs = { row, opts }; sbRow = row; return { error: null }; },
      };
    },
  };
  const ctx = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
    localStorage: {
      getItem: k => (k in memStore ? memStore[k] : null),
      setItem: (k, v) => { memStore[k] = String(v); },
      removeItem: k => { delete memStore[k]; },
    },
    esc: s => String(s),
    SPICY_CONFIG: { tropeProvider: 'openrouter', tropeModel: 'env-model' },
    library: [],
    localUid: 'admin-1',
    cloudClient: async () => fakeSb,
    fetch: async () => { throw new Error('no network in tests'); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const load = f => vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
  load('156-trope-taxonomy.js');
  load('157-trope-inference.js');
  const probe = src => vm.runInContext(src, ctx);
  const resetProvider = () => {
    probe('tropeProviderCache = null;');
    Object.keys(memStore).forEach(k => delete memStore[k]);
    sbRow = null; upsertArgs = null;
  };
  const BOOK = { id: 'b1', title: 'Iron Flame', authors: ['Rebecca Yarros'], categories: ['romance'], description: 'dragons' };
  const goodBody = { choices: [{ finish_reason: 'stop', message: { content: '{"tropes": []}' } }] };

  resetProvider();
  ok('get with no row -> empty override (server default)',
    JSON.stringify(await probe('tropeProviderGet()')) === JSON.stringify({ provider: '', model: '' }));

  await probe(`tropeProviderSet('gemini', 'gemini-2.0-flash')`);
  ok('set upserts id=1 with provider+model',
    upsertArgs && upsertArgs.row.id === 1 && upsertArgs.row.provider === 'gemini' &&
    upsertArgs.row.model === 'gemini-2.0-flash' && upsertArgs.opts.onConflict === 'id');
  ok('set caches locally for offline',
    JSON.parse(memStore['cozylibram.tropeprovider.v1']).provider === 'gemini');

  probe('tropeProviderCache = null;');
  ok('get reads the shared row',
    JSON.stringify(await probe('tropeProviderGet()')) === JSON.stringify({ provider: 'gemini', model: 'gemini-2.0-flash' }));

  ok('tropeProviderInfo reflects the override',
    (() => {
      const i = probe('tropeProviderInfo()');
      return i.provider === 'gemini' && i.model === 'gemini-2.0-flash' && i.overridden === true;
    })());

  /* inference carries the override in the proxy request body */
  {
    let sentBody = null;
    const fetchFn = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => goodBody };
    };
    ctx.__fetchFn = fetchFn;
    await probe(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, delayFn: () => Promise.resolve() })`);
    ok('override rides in the proxy request body',
      sentBody.provider === 'gemini' && sentBody.model === 'gemini-2.0-flash');
    delete ctx.__fetchFn;
  }

  /* empty override -> body has no provider/model (env defaults rule) */
  {
    resetProvider();
    let sentBody = null;
    const fetchFn = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => goodBody };
    };
    ctx.__fetchFn = fetchFn;
    await probe(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, delayFn: () => Promise.resolve() })`);
    ok('no override -> no provider/model in body',
      sentBody && !('provider' in sentBody) && !('model' in sentBody));
    ok('info falls back to server env values',
      (() => { const i = probe('tropeProviderInfo()'); return i.provider === 'openrouter' && i.model === 'env-model' && !i.overridden; })());
    delete ctx.__fetchFn;
  }

  /* ---- 3. Proxy ---- */
  const mod = await import(pathToFileURL(path.join(ROOT, 'functions', 'api', 'trope-infer.js')).href);
  const { onRequest } = mod;
  // v225: the /api/* sign-in gate. The mock answers the Supabase auth check
  // from the token; upstream assertions below only see provider calls.
  const SUPA_URL = 'https://x.supabase.co';
  const penv = (e) => Object.assign({ SUPABASE_URL: SUPA_URL, SUPABASE_ANON_KEY: 'sb1' }, e);
  let upstream = null;
  const enc = new TextEncoder();
  globalThis.fetch = async (url, opts) => {
    if (String(url) === SUPA_URL + '/auth/v1/user') {
      const good = opts && opts.headers && opts.headers.Authorization === 'Bearer good-token';
      return { ok: good, status: good ? 200 : 401,
        headers: { get: () => null }, json: async () => (good ? { id: 'u1' } : {}) };
    }
    upstream = { url, opts: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return {
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => enc.encode(JSON.stringify(goodBody)).buffer,
    };
  };
  const req = (body, auth) => ({ method: 'POST', json: async () => body,
    headers: { get: (k) => String(k).toLowerCase() === 'authorization'
      ? (auth === undefined ? 'Bearer good-token' : auth) : null } });
  const msgs = [{ role: 'user', content: 'hi' }];

  // v225: the sign-in gate.
  let r = await onRequest({ request: req({ messages: msgs }, null),
    env: penv({ TROPE_API_KEY: 'K1', TROPE_MODEL: 'm' }) });
  ok('missing auth header -> 401', r.status === 401);
  r = await onRequest({ request: req({ messages: msgs }, 'Bearer bad-token'),
    env: penv({ TROPE_API_KEY: 'K1', TROPE_MODEL: 'm' }) });
  ok('invalid session token -> 401', r.status === 401);

  upstream = null;
  r = await onRequest({ request: req({ messages: msgs, max_tokens: 500 }),
    env: penv({ TROPE_PROVIDER: 'openrouter', TROPE_MODEL: 'env-model', TROPE_API_KEY: 'K1' }) });
  ok('default path: status forwarded', r.status === 200);
  ok('default path: env provider URL + model + key',
    upstream.url === 'https://openrouter.ai/api/v1/chat/completions' &&
    upstream.opts.model === 'env-model' && upstream.auth === 'Bearer K1' &&
    !('provider' in upstream.opts));

  upstream = null;
  r = await onRequest({ request: req({ messages: msgs, max_tokens: 500, provider: 'gemini', model: 'gemini-2.0-flash' }),
    env: penv({ TROPE_PROVIDER: 'openrouter', TROPE_MODEL: 'env-model', TROPE_API_KEY: 'K1', TROPE_KEY_GEMINI: 'GK' }) });
  ok('override: gemini URL + per-provider key + client model',
    r.status === 200 &&
    upstream.url === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' &&
    upstream.opts.model === 'gemini-2.0-flash' && upstream.auth === 'Bearer GK');

  r = await onRequest({ request: req({ messages: msgs, provider: 'gemini', model: 'gemini-2.0-flash' }),
    env: penv({ TROPE_PROVIDER: 'openrouter', TROPE_MODEL: 'env-model', TROPE_API_KEY: 'K1' }) });
  ok('override without a key -> descriptive 503',
    r.status === 503 && (await r.json()).error.includes("no API key configured for provider 'gemini'"));

  r = await onRequest({ request: req({ messages: msgs, provider: 'evil', model: 'x' }),
    env: penv({ TROPE_API_KEY: 'K1', TROPE_MODEL: 'm' }) });
  ok('unknown provider -> 400', r.status === 400);

  r = await onRequest({ request: req({ messages: msgs, provider: 'gemini' }),
    env: penv({ TROPE_API_KEY: 'K1', TROPE_MODEL: 'm' }) });
  ok('provider without model -> 400', r.status === 400);

  r = await onRequest({ request: req({ messages: msgs, provider: 'gemini', model: 'not a model!!' }),
    env: penv({ TROPE_API_KEY: 'K1', TROPE_MODEL: 'm' }) });
  ok('bad model name -> 400', r.status === 400);

  upstream = null;
  r = await onRequest({ request: req({ messages: msgs, max_tokens: 500, provider: 'openrouter', model: 'some-model' }),
    env: penv({ TROPE_PROVIDER: 'openrouter', TROPE_MODEL: 'env-model', TROPE_API_KEY: 'K1' }) });
  ok('TROPE_API_KEY still backs the env-default provider',
    r.status === 200 && upstream.auth === 'Bearer K1' && upstream.opts.model === 'some-model');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
