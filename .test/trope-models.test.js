/* v164 live model list for the Trope Lab provider picker.
   1. Proxy (functions/api/trope-models.js, imported as ESM with a stubbed
      upstream): GET only; provider allowlisted (custom/ollama/unknown ->
      400 with a clear message); gemini/groq need their server-side key
      (503 when missing); OpenRouter's public list works keyless; the
      response maps OpenAI-format {data:[{id,name}]} to {id,name} and never
      reflects key material.
   2. Client tropeModelList() (js/157-trope-inference.js in a vm sandbox):
      maps + caches per provider, rejects with the server's message.
   3. End-to-end (jsdom): picking a provider fills the model datalist with
      the live list and a count note; a failed load falls back to the
      hardcoded suggestions.
   Run: node .test/trope-models.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');
const harness = require('./harness');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

(async () => {
  /* ---- 1. Proxy ---- */
  const mod = await import(pathToFileURL(path.join(ROOT, 'functions', 'api', 'trope-models.js')).href);
  const { onRequest } = mod;
  let upstreamCalls = [];
  let upstreamHandler = null;
  globalThis.fetch = async (url, opts) => {
    upstreamCalls.push({ url, auth: (opts.headers || {}).Authorization,
      googKey: (opts.headers || {})['x-goog-api-key'] });
    return upstreamHandler(url, opts);
  };
  const req = (method, provider) => ({
    method,
    headers: { get: () => null },
    url: 'https://cozylibram.pages.dev/api/trope-models' + (provider ? '?provider=' + provider : ''),
  });
  const modelsBody = { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'x-1', name: 'X One' }] };
  const okUpstream = () => ({ ok: true, status: 200, json: async () => modelsBody });
  /* v165: Google's native list shape. */
  const geminiBody = { models: [
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash',
      supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.8-flash-tts', displayName: 'Gemini 3.8 Flash TTS',
      supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', displayName: 'Gemini Embedding',
      supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro',
      supportedGenerationMethods: ['generateContent'] },
    { name: 'models/mystery-model' }, // no methods listed -> kept (fail open)
  ] };
  const okGeminiUpstream = () => ({ ok: true, status: 200, json: async () => geminiBody });

  upstreamCalls = []; upstreamHandler = okUpstream;
  let r = await onRequest({ request: req('POST', 'gemini'), env: {} });
  ok('non-GET -> 405', r.status === 405);

  r = await onRequest({ request: req('GET', ''), env: {} });
  ok('missing provider -> 400', r.status === 400);

  r = await onRequest({ request: req('GET', 'evil'), env: {} });
  ok('unknown provider -> 400', r.status === 400 && upstreamCalls.length === 0);

  r = await onRequest({ request: req('GET', 'custom'), env: {} });
  ok('custom -> 400 with a clear message',
    r.status === 400 && (await r.json()).error.includes('type the model name'));

  r = await onRequest({ request: req('GET', 'ollama'), env: {} });
  ok('ollama -> 400 (Pages edge cannot reach localhost)',
    r.status === 400 && (await r.json()).error.includes('own machine'));

  r = await onRequest({ request: req('GET', 'gemini'), env: { TROPE_API_KEY: 'K1' } });
  ok('gemini without its key -> descriptive 503',
    r.status === 503 && (await r.json()).error.includes('TROPE_KEY_GEMINI'));

  upstreamCalls = []; upstreamHandler = okGeminiUpstream;
  r = await onRequest({ request: req('GET', 'gemini'),
    env: { TROPE_PROVIDER: 'openrouter', TROPE_API_KEY: 'K1', TROPE_KEY_GEMINI: 'GK' } });
  const gj = await r.json();
  ok('gemini: 200 + native endpoint + x-goog-api-key (not Bearer)',
    r.status === 200 && upstreamCalls.length === 1 &&
    upstreamCalls[0].url === 'https://generativelanguage.googleapis.com/v1beta/models' &&
    upstreamCalls[0].googKey === 'GK' && !upstreamCalls[0].auth);
  ok('gemini: chat-capable models kept, models/ prefix stripped, displayName used',
    gj.provider === 'gemini' &&
    gj.models.some(m => m.id === 'gemini-3.8-flash' && m.name === 'Gemini 3.8 Flash') &&
    gj.models.some(m => m.id === 'gemini-2.5-pro'));
  ok('gemini: TTS + embedding + non-generateContent models filtered out',
    gj.models.every(m => !/tts|embed/i.test(m.id)) &&
    gj.models.some(m => m.id === 'mystery-model'));
  ok('response carries no key material', !JSON.stringify(gj).includes('GK'));

  upstreamCalls = []; upstreamHandler = okUpstream;
  r = await onRequest({ request: req('GET', 'openrouter'), env: {} });
  ok('openrouter works keyless (public endpoint)',
    r.status === 200 && upstreamCalls.length === 1 &&
    upstreamCalls[0].url === 'https://openrouter.ai/api/v1/models' &&
    !upstreamCalls[0].auth);

  upstreamCalls = []; upstreamHandler = okUpstream;
  r = await onRequest({ request: req('GET', 'openrouter'),
    env: { TROPE_PROVIDER: 'openrouter', TROPE_API_KEY: 'K1' } });
  ok('TROPE_API_KEY backs the env-default provider',
    r.status === 200 && upstreamCalls[0].auth === 'Bearer K1');

  upstreamCalls = [];
  upstreamHandler = () => ({ ok: false, status: 401, json: async () => ({}) });
  r = await onRequest({ request: req('GET', 'groq'),
    env: { TROPE_PROVIDER: 'openrouter', TROPE_KEY_GROQ: 'QK' } });
  const ej = await r.json();
  ok('upstream 401 -> 502 without leaking the key',
    r.status === 502 && ej.error.includes('401') && !JSON.stringify(ej).includes('QK'));

  upstreamHandler = () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  r = await onRequest({ request: req('GET', 'groq'),
    env: { TROPE_PROVIDER: 'openrouter', TROPE_KEY_GROQ: 'QK' } });
  ok('unparsable upstream body -> 502', r.status === 502);

  /* ---- 2. Client tropeModelList ---- */
  const ctx = { console, setTimeout, clearTimeout, fetch: null };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', '157-trope-inference.js'), 'utf8'), ctx,
    { filename: '157-trope-inference.js' });
  const probe = src => vm.runInContext(src, ctx);
  let fetchCalls = [];
  ctx.fetch = async (url) => {
    fetchCalls.push(url);
    return { ok: true, status: 200,
      json: async () => ({ provider: 'gemini', models: [{ id: 'gemini-3.8-flash' }, { id: 'x', name: 'X' }] }) };
  };
  const listed = await probe(`tropeModelList('gemini')`);
  ok('tropeModelList maps {id,name}',
    listed.length === 2 && listed[0].name === 'gemini-3.8-flash' && listed[1].name === 'X');
  await probe(`tropeModelList('gemini')`);
  ok('tropeModelList caches per provider (one fetch for two calls)', fetchCalls.length === 1);
  ok('fetch hits the same-origin proxy',
    fetchCalls[0] === '/api/trope-models?provider=gemini');

  ctx.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'no API key configured' }) });
  probe('tropeModelListCache = {};');
  let rejectedWith = '';
  try { await probe(`tropeModelList('groq')`); } catch (e) { rejectedWith = e.message; }
  ok('failed load rejects with the server message', rejectedWith.includes('no API key configured'));

  rejectedWith = '';
  try { await probe(`tropeModelList('')`); } catch (e) { rejectedWith = e.message; }
  ok('empty provider rejects', !!rejectedWith);

  /* ---- 3. End-to-end datalist ---- */
  function buildDom(modelsImpl) {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
    const window = dom.window;
    window.fetch = async (url, opts) => {
      if (String(url).startsWith('/api/trope-models')) return modelsImpl(url);
      throw new Error('no network in tests');
    };
    window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key',
      trope: true, tropeProvider: 'openrouter', tropeModel: 'x' };

    // PostgREST-style 404 for tables missing from the schema cache
    // (taxonomy_meta, trope_provider_settings before tropes.sql is re-run).
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

    const tropeRows = [];
    for (let i = 0; i < 84; i++) tropeRows.push({ id: 'trope-' + i, name: 'Trope ' + i, description: 'd', genres: [] });

    const fake = {
      user: null, _cb: null,
      auth: {
        getSession: async () => ({ data: { session: fake.user ? { user: fake.user } : null } }),
        signOut: async () => { fake.user = null; return { error: null }; },
        onAuthStateChange: (cb) => { fake._cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      },
      from: (table) => {
        if (table === 'app_admins') return { select: () => harness.chainableSelect([{ user_id: 'u1' }], r => r) };
        if (table === 'tropes') return { select: () => harness.chainableSelect(tropeRows, r => r) };
        if (table === 'book_tropes') return { select: () => harness.chainableSelect([], r => r) };
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
  const tick = (n) => new Promise(r => { let i = 0; const step = () => (++i >= (n || 3) ? r() : setTimeout(step, 20)); step(); });

  // Live list populates the datalist.
  {
    const liveModels = [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }];
    const { window, fake } = buildDom(async () => ({ ok: true, status: 200,
      json: async () => ({ provider: 'gemini', models: liveModels }) }));
    await tick();
    fake.fire('SIGNED_IN', { id: 'u1', email: 'a@b.c' });
    await tick(8);
    runInWindow(window, `adminTab = 'tropes'; isAppAdmin = true; renderAdmin();`);
    await tick(20);
    const sel = window.document.getElementById('tl-provider-sel');
    ok('provider picker renders', !!sel);
    runInWindow(window, `document.getElementById('tl-provider-sel').value = 'gemini';
      document.getElementById('tl-provider-sel').dispatchEvent(new Event('change'));`);
    await tick(10);
    const opts = Array.from(window.document.querySelectorAll('#tl-model-list option')).map(o => o.value);
    ok('datalist populated with the live model list',
      opts.includes('gemini-3.8-flash') && opts.includes('gemini-2.5-pro'));
    const note = window.document.getElementById('tl-models-note').textContent;
    ok('count note shown', /2 models available/.test(note));
  }

  // Failed load falls back to the hardcoded suggestions.
  {
    const { window, fake } = buildDom(async () => { throw new Error('proxy down'); });
    await tick();
    fake.fire('SIGNED_IN', { id: 'u1', email: 'a@b.c' });
    await tick(8);
    runInWindow(window, `adminTab = 'tropes'; isAppAdmin = true; renderAdmin();`);
    await tick(20);
    runInWindow(window, `document.getElementById('tl-provider-sel').value = 'groq';
      document.getElementById('tl-provider-sel').dispatchEvent(new Event('change'));`);
    await tick(10);
    const opts = Array.from(window.document.querySelectorAll('#tl-model-list option')).map(o => o.value);
    ok('failed load falls back to suggestions', opts.includes('llama-3.3-70b-versatile'));
    const note = window.document.getElementById('tl-models-note').textContent;
    ok('fallback note shown', /Could not load the live model list/.test(note));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
