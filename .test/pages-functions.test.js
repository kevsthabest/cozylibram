// Pages Functions tests: /config.js and /cover-proxy contracts.
// The function files are ESM; load them with dynamic import.
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

async function main() {
  const configFn = await import(path.resolve(__dirname, '../functions/config.js.js'));
  const proxyFn = await import(path.resolve(__dirname, '../functions/cover-proxy.js'));
  const ctx = (env, url) => ({ env, request: new Request(url || 'https://app.test/') });

  // ---- /config.js ----
  const full = await configFn.onRequest(ctx(
    { HARDCOVER_TOKEN: 'hc1', GOOGLE_BOOKS_KEY: 'gb1', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb1' },
    'https://app.test/config.js'));
  const fullText = await full.text();
  ok('config: 200', full.status === 200);
  ok('config: js content type', (full.headers.get('Content-Type') || '').includes('javascript'));
  ok('config: no-store', (full.headers.get('Cache-Control') || '').includes('no-store'));
  ok('config: SPICY_CONFIG global', fullText.startsWith('window.SPICY_CONFIG = '));
  const payload = JSON.parse(fullText.replace(/^window\.SPICY_CONFIG = /, '').replace(/;$/, ''));
  ok('config: hardcoverToken', payload.hardcoverToken === 'hc1');
  ok('config: googleBooksKey', payload.googleBooksKey === 'gb1');
  ok('config: supabase pair', payload.supabaseUrl === 'https://x.supabase.co' && payload.supabaseAnonKey === 'sb1');

  const partial = await configFn.onRequest(ctx({ HARDCOVER_TOKEN: '  hc2  ' }, 'https://app.test/config.js'));
  const partialPayload = JSON.parse((await partial.text()).replace(/^window\.SPICY_CONFIG = /, '').replace(/;$/, ''));
  ok('config: missing keys omitted', !('googleBooksKey' in partialPayload) && !('supabaseUrl' in partialPayload));
  ok('config: values trimmed', partialPayload.hardcoverToken === 'hc2');
  const empty = await configFn.onRequest(ctx({}, 'https://app.test/config.js'));
  ok('config: empty env -> empty object', (await empty.text()).includes('window.SPICY_CONFIG = {};'));

  // ---- /cover-proxy ----
  const realFetch = globalThis.fetch;
  const fakeImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  globalThis.fetch = async (url, init) => {
    if (url === 'https://covers.openlibrary.org/b/id/1-M.jpg') {
      return new Response(fakeImage, { headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (url === 'https://covers.openlibrary.org/b/id/2-M.jpg') {
      return new Response('<html>nope</html>', { headers: { 'Content-Type': 'text/html' } });
    }
    if (url === 'https://covers.openlibrary.org/b/id/3-M.jpg') {
      return new Response(new Uint8Array(5 * 1024 * 1024), { headers: { 'Content-Type': 'image/png' } });
    }
    throw new Error('network down');
  };

  const prox = (u) => proxyFn.onRequest({ request: new Request('https://app.test/cover-proxy?url=' + encodeURIComponent(u)) });

  const good = await prox('https://covers.openlibrary.org/b/id/1-M.jpg');
  ok('proxy: 200 for allowed host', good.status === 200);
  ok('proxy: image bytes pass through', (await good.arrayBuffer()).byteLength === 4);
  ok('proxy: content type preserved', (good.headers.get('Content-Type') || '').includes('image/jpeg'));
  ok('proxy: cached one day', (good.headers.get('Cache-Control') || '').includes('max-age=86400'));

  const evil = await prox('http://169.254.169.254/latest/meta-data');
  ok('proxy: non-https rejected', evil.status === 403);
  const evil2 = await prox('https://169.254.169.254/latest/meta-data');
  ok('proxy: unlisted host rejected (SSRF)', evil2.status === 403);
  const bad = await prox('not a url');
  ok('proxy: garbage url -> 400', bad.status === 400);
  const notImg = await prox('https://covers.openlibrary.org/b/id/2-M.jpg');
  ok('proxy: non-image -> 502', notImg.status === 502);
  const big = await prox('https://covers.openlibrary.org/b/id/3-M.jpg');
  ok('proxy: over 4MB -> 502', big.status === 502);
  const down = await prox('https://books.google.com/unreachable.jpg');
  ok('proxy: fetch failure -> 502', down.status === 502);

  globalThis.fetch = realFetch;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
