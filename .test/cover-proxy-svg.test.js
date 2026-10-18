// Tests for the #345 fix — cover-proxy must not serve SVG inline from the
// app origin.
//
// functions/cover-proxy.js passed any upstream Content-Type starting with
// image/ through verbatim — including image/svg+xml — with no
// X-Content-Type-Options, no Content-Security-Policy and no
// Content-Disposition. An SVG is an XML document that can carry script;
// served from the app origin, a top-level navigation to the proxy URL
// executes that script where the app's session lives. Covers from every
// allowlisted provider are raster images, so SVG is never a legitimate
// cover response. These tests pin: SVG is refused like any non-image,
// and successful raster responses carry the protective headers so any
// future document-like type is inert on navigation anyway.

const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const SVG_BODY = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>';

async function main() {
  const proxyFn = await import(path.resolve(__dirname, '../functions/cover-proxy.js'));
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (url === 'https://covers.openlibrary.org/b/id/evil.svg') {
      return new Response(SVG_BODY, { headers: { 'Content-Type': 'image/svg+xml' } });
    }
    if (url === 'https://covers.openlibrary.org/b/id/evil2.svg') {
      return new Response(SVG_BODY, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } });
    }
    if (url === 'https://covers.openlibrary.org/b/id/evil3.svg') {
      return new Response(SVG_BODY, { headers: { 'Content-Type': 'Image/SVG+XML' } });
    }
    if (url === 'https://covers.openlibrary.org/b/id/1-M.jpg') {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (url === 'https://covers.openlibrary.org/b/id/page.html') {
      return new Response('<html><script>alert(1)</script></html>', { headers: { 'Content-Type': 'text/html' } });
    }
    throw new Error('network down');
  };
  const prox = (u) => proxyFn.onRequest({ request: new Request('https://app.test/cover-proxy?url=' + encodeURIComponent(u)) });

  /* ---- SVG is refused, in its type variants ---- */
  for (const [name, u] of [
    ['plain', 'https://covers.openlibrary.org/b/id/evil.svg'],
    ['with charset param', 'https://covers.openlibrary.org/b/id/evil2.svg'],
    ['mixed case', 'https://covers.openlibrary.org/b/id/evil3.svg'],
  ]) {
    const r = await prox(u);
    ok('svg345: SVG (' + name + ') is not served', r.status === 502);
    ok('svg345: SVG (' + name + ') body carries no script payload', !(await r.text()).includes('<script>'));
  }

  /* ---- raster covers still serve, with protective headers ---- */
  const good = await prox('https://covers.openlibrary.org/b/id/1-M.jpg');
  ok('svg345: raster cover still 200', good.status === 200);
  ok('svg345: raster cover type preserved', (good.headers.get('Content-Type') || '').startsWith('image/jpeg'));
  ok('svg345: raster bytes intact', (await good.arrayBuffer()).byteLength === 4);
  ok('svg345: response sets X-Content-Type-Options: nosniff',
    (good.headers.get('X-Content-Type-Options') || '').toLowerCase() === 'nosniff');
  ok('svg345: response sets a sandboxed Content-Security-Policy',
    (good.headers.get('Content-Security-Policy') || '').includes('sandbox'));

  /* ---- pre-existing contract unchanged ---- */
  const html = await prox('https://covers.openlibrary.org/b/id/page.html');
  ok('svg345: non-image upstream still 502', html.status === 502);
  const evil = await prox('https://169.254.169.254/latest/meta-data');
  ok('svg345: unlisted host still 403', evil.status === 403);

  globalThis.fetch = realFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
