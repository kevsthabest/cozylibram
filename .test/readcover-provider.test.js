// v293: read-cover routes through OpenRouter when READ_COVER_PROVIDER=openrouter.
// Functions are ESM; load with dynamic import like pages-functions.test.js.
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

async function main() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'u1' }) };
    if (u.includes('banned_users')) return { ok: true, json: async () => [] };
    calls.push({ url: u, init });
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '{"isbn":"9780143127748"}' } }] }),
    };
  };

  const { onRequest } = await import(path.resolve(__dirname, '../functions/api/read-cover.js'));

  const baseEnv = {
    SUPABASE_URL: 'https://supa.test',
    SUPABASE_ANON_KEY: 'anon',
    TROPE_KEY_GEMINI: 'gem-key',
  };
  const req = (env) => onRequest({
    request: new Request('https://x/api/read-cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({ mode: 'single', image: 'data:image/jpeg;base64,AAA' }),
    }),
    env,
  });

  // 1. OpenRouter provider: URL, models fallback chain, headers.
  calls.length = 0;
  const r1 = await req({ ...baseEnv, READ_COVER_PROVIDER: 'openrouter', OPENROUTER_KEY: 'or-key' });
  const c1 = calls[calls.length - 1];
  const b1 = JSON.parse(c1.init.body);
  ok('openrouter: hits the OpenRouter endpoint',
    c1.url === 'https://openrouter.ai/api/v1/chat/completions');
  ok('openrouter: sends the free-model fallback chain',
    JSON.stringify(b1.models) === JSON.stringify(['qwen/qwen3.8-27b:free', 'google/gemma-4-31b-it:free']));
  ok('openrouter: sends referer + key headers',
    c1.init.headers['HTTP-Referer'] === 'https://cozylibram.pages.dev' &&
    c1.init.headers['Authorization'] === 'Bearer or-key');
  ok('openrouter: parses the model JSON', (await r1.json()).isbn === '9780143127748');

  // 2. Default provider is unchanged: Gemini URL + single model.
  calls.length = 0;
  await req({ ...baseEnv });
  const c2 = calls[calls.length - 1];
  const b2 = JSON.parse(c2.init.body);
  ok('default: still hits the Gemini endpoint',
    c2.url === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  ok('default: sends the single Gemini model', b2.model === 'gemini-3.8-flash' && !('models' in b2));

  // 3. OpenRouter without a key is a clean 503, not a crash.
  const { TROPE_KEY_GEMINI, ...noKeys } = baseEnv;
  const r3 = await req({ ...noKeys, READ_COVER_PROVIDER: 'openrouter' });
  ok('openrouter without key -> 503', r3.status === 503);

  // 3b. Falls back to the already-configured TROPE_API_KEY.
  calls.length = 0;
  await req({ ...baseEnv, READ_COVER_PROVIDER: 'openrouter', TROPE_API_KEY: 'trope-or-key' });
  const c3b = calls[calls.length - 1];
  ok('openrouter reuses TROPE_API_KEY when OPENROUTER_KEY unset',
    c3b.init.headers['Authorization'] === 'Bearer trope-or-key');

  // 4. Custom model list is honored.
  calls.length = 0;
  await req({ ...baseEnv, READ_COVER_PROVIDER: 'openrouter', OPENROUTER_KEY: 'or-key', VISION_OR_MODELS: 'qwen/qwen3.8-27b:free' });
  const b4 = JSON.parse(calls[calls.length - 1].init.body);
  ok('custom VISION_OR_MODELS honored',
    JSON.stringify(b4.models) === JSON.stringify(['qwen/qwen3.8-27b:free']));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
