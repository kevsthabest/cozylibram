// Canonical cover URLs (v216): canonicalizeCoverUrl routes remote covers
// through /api/cache-cover, passes uploads and already-canonical URLs
// through untouched, and falls back to the original URL on ANY failure —
// never throws, never returns empty.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

let calls = [];
let behavior = 'ok'; // 'ok' | 'forbidden' | 'server-error' | 'down' | 'weird-shape'
const CANON = 'https://x.supabase.co/storage/v1/object/public/covers/abc123.jpg';
window.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  if (behavior === 'down') throw new Error('no network in canonical-covers tests');
  if (behavior === 'forbidden') return new Response('{"error":"host not allowed"}', { status: 403 });
  if (behavior === 'server-error') return new Response('{"error":"boom"}', { status: 500 });
  if (behavior === 'weird-shape') return new Response('{"nope":1}', { status: 200 });
  return new Response(JSON.stringify({ coverUrl: CANON }), { status: 200 });
};

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

(async () => {
  const canon = async (u) => window.eval(`canonicalizeCoverUrl(${JSON.stringify(u)})`);

  // passthroughs: fetch must not be called
  calls = []; behavior = 'ok';
  ok('data: upload passes through untouched',
    await canon('data:image/jpeg;base64,AAA') === 'data:image/jpeg;base64,AAA' && calls.length === 0);
  ok('already-canonical bucket URL passes through untouched',
    await canon(CANON) === CANON && calls.length === 0);
  ok('empty string passes through', await canon('') === '' && calls.length === 0);
  ok('non-string passes through', await canon(null) === null && calls.length === 0);

  // happy path
  calls = [];
  const remote = 'https://covers.openlibrary.org/b/id/1-L.jpg';
  const got = await canon(remote);
  ok('200 with coverUrl returns the canonical URL', got === CANON);
  ok('posts to /api/cache-cover with the url',
    calls.length === 1 && calls[0].url === '/api/cache-cover' &&
    JSON.parse(calls[0].init.body).url === remote);

  // every failure mode falls back to the remote URL — never throws, never empty
  behavior = 'forbidden';
  ok('403 falls back to the remote URL', await canon(remote) === remote);
  behavior = 'server-error';
  ok('500 falls back to the remote URL', await canon(remote) === remote);
  behavior = 'down';
  ok('network failure falls back to the remote URL', await canon(remote) === remote);
  behavior = 'weird-shape';
  ok('unexpected 200 shape falls back to the remote URL', await canon(remote) === remote);
  behavior = 'ok';

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
