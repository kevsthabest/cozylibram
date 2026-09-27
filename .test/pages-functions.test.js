// Pages Functions tests: /config.js, /cover-proxy, /api/hardcover, /api/gbooks.
// The function files are ESM; load them with dynamic import.
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const configPayload = async (res) =>
  JSON.parse((await res.text()).replace(/^window\.SPICY_CONFIG = /, '').replace(/;$/, ''));

async function main() {
  const configFn = await import(path.resolve(__dirname, '../functions/config.js.js'));
  const proxyFn = await import(path.resolve(__dirname, '../functions/cover-proxy.js'));
  const hcFn = await import(path.resolve(__dirname, '../functions/api/hardcover.js'));
  const gbFn = await import(path.resolve(__dirname, '../functions/api/gbooks/[[path]].js'));
  const ctx = (env, url) => ({ env, request: new Request(url || 'https://app.test/') });

  // ---- /config.js: flags only, no secrets ----
  const full = await configFn.onRequest(ctx(
    { HARDCOVER_TOKEN: 'hc1', GOOGLE_BOOKS_KEY: 'gb1', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1' },
    'https://app.test/config.js'));
  const fullText = await full.text();
  ok('config: 200', full.status === 200);
  ok('config: js content type', (full.headers.get('Content-Type') || '').includes('javascript'));
  ok('config: no-store', (full.headers.get('Cache-Control') || '').includes('no-store'));
  ok('config: SPICY_CONFIG global', fullText.startsWith('window.SPICY_CONFIG = '));
  const payload = JSON.parse(fullText.replace(/^window\.SPICY_CONFIG = /, '').replace(/;$/, ''));
  ok('config: hardcover flag true', payload.hardcover === true);
  ok('config: gbooks flag true', payload.gbooks === true);
  ok('config: no secrets in payload',
    !('hardcoverToken' in payload) && !('googleBooksKey' in payload) &&
    fullText.indexOf('hc1') === -1 && fullText.indexOf('gb1') === -1);
  ok('config: supabase pair', payload.supabaseUrl === 'https://x.supabase.co' && payload.supabaseAnonKey === 'sb1');

  const partial = await configPayload(await configFn.onRequest(ctx({ HARDCOVER_TOKEN: '  hc2  ' }, 'https://app.test/config.js')));
  ok('config: only hardcover flag when only token set', partial.hardcover === true && partial.gbooks === false);
  ok('config: supabase omitted when unset', !('supabaseUrl' in partial));
  const empty = await configPayload(await configFn.onRequest(ctx({}, 'https://app.test/config.js')));
  ok('config: empty env -> both flags false', empty.hardcover === false && empty.gbooks === false);

  // ---- /api/hardcover ----
  const realFetch = globalThis.fetch;
  const seenHc = [];
  globalThis.fetch = async (url, init) => {
    seenHc.push({ url, init });
    if (url === 'https://api.hardcover.app/v1/graphql' &&
        init.headers['Authorization'] === 'Bearer realtoken') {
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }
    return new Response(JSON.stringify({ errors: [{ message: 'blocked' }] }), { status: 403 });
  };
  const hcCtx = (env, body) => ({
    env,
    request: new Request('https://app.test/api/hardcover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body === undefined ? { query: 'query { x }' } : body),
    }),
  });

  const hcOk = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 'realtoken' }));
  ok('hc: 200 on success', hcOk.status === 200);
  ok('hc: token attached server-side, never echoed',
    seenHc[0].init.headers['Authorization'] === 'Bearer realtoken' &&
    (await hcOk.text()).indexOf('realtoken') === -1);
  ok('hc: query forwarded in body',
    JSON.parse(seenHc[0].init.body).query === 'query { x }');

  const hcGet = await hcFn.onRequest({ env: { HARDCOVER_TOKEN: 't' }, request: new Request('https://app.test/api/hardcover') });
  ok('hc: GET rejected (405)', hcGet.status === 405);
  const hcBad = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' }, { nope: 1 }));
  ok('hc: missing query -> 400', hcBad.status === 400);
  const hcBig = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 't' }, { query: 'x'.repeat(9000) }));
  ok('hc: oversized query -> 400', hcBig.status === 400);
  const hcNone = await hcFn.onRequest(hcCtx({}, { query: 'query { x }' }));
  ok('hc: no token -> 503', hcNone.status === 503);
  const hcUp = await hcFn.onRequest(hcCtx({ HARDCOVER_TOKEN: 'wrong' }, { query: 'query { x }' }));
  ok('hc: upstream 403 forwarded', hcUp.status === 403);

  // ---- /api/gbooks ----
  const seenGb = [];
  globalThis.fetch = async (url) => {
    seenGb.push(url);
    return new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const gbCtx = (env, method) => ({
    env,
    params: { path: ['books', 'v1', 'volumes'] },
    request: new Request('https://app.test/api/gbooks/books/v1/volumes?q=isbn%3A123&key=CLIENTKEY',
      { method: method || 'GET' }),
  });

  const gbOk = await gbFn.onRequest(gbCtx({ GOOGLE_BOOKS_KEY: 'serverkey' }));
  ok('gb: 200', gbOk.status === 200);
  ok('gb: server key attached', seenGb[0].indexOf('key=serverkey') !== -1);
  ok('gb: client key stripped', seenGb[0].indexOf('CLIENTKEY') === -1);
  ok('gb: query preserved', seenGb[0].indexOf('q=isbn') !== -1);
  ok('gb: targets googleapis', seenGb[0].indexOf('https://www.googleapis.com/books/v1/volumes') === 0);

  const gbAnon = await gbFn.onRequest(gbCtx({}));
  ok('gb: forwards anonymously when no key', gbAnon.status === 200 && seenGb[1].indexOf('key=') === -1);

  const gbEvil = await gbFn.onRequest({
    env: { GOOGLE_BOOKS_KEY: 'serverkey' },
    params: { path: ['books', 'v1', 'mylibrary', 'bookshelves'] },
    request: new Request('https://app.test/api/gbooks/books/v1/mylibrary/bookshelves'),
  });
  ok('gb: non-volumes path -> 404', gbEvil.status === 404);
  const gbPost = await gbFn.onRequest(gbCtx({ GOOGLE_BOOKS_KEY: 'k' }, 'POST'));
  ok('gb: POST rejected (405)', gbPost.status === 405);

  globalThis.fetch = realFetch;

  // ---- /cover-proxy (unchanged contract) ----
  globalThis.fetch = async (url) => {
    if (url === 'https://covers.openlibrary.org/b/id/1-M.jpg') {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    throw new Error('network down');
  };
  const prox = (u) => proxyFn.onRequest({ request: new Request('https://app.test/cover-proxy?url=' + encodeURIComponent(u)) });
  const good = await prox('https://covers.openlibrary.org/b/id/1-M.jpg');
  ok('proxy: 200 for allowed host', good.status === 200);
  const evil = await prox('https://169.254.169.254/latest/meta-data');
  ok('proxy: unlisted host rejected (SSRF)', evil.status === 403);
  globalThis.fetch = realFetch;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
