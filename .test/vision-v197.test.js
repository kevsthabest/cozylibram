// v197: vision cover reading — /api/read-cover endpoint + client flow.
// The model is never trusted on the ISBN: the client must validate the
// check digit before routing to lookupISBN.
const path = require('path');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(1000);

async function main() {
  // ============ Part A: Pages function ============
  const fn = await import(path.resolve(__dirname, '../functions/api/read-cover.js'));
  const realFetch = globalThis.fetch;
  let ipN = 0;
  const ctx = (env, body, method) => ({
    env,
    request: new Request('https://app.test/api/read-cover', {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'test-ip-' + (++ipN) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  });
  const post = (env, body) => fn.onRequest(ctx(env, body));

  // 1. Method guard
  let r = await fn.onRequest(ctx({}, undefined, 'GET'));
  ok('endpoint: GET -> 405', r.status === 405);

  // 2. Missing key -> 503 naming VISION_API_KEY
  r = await post({}, { image: IMG, mode: 'single' });
  ok('endpoint: no key -> 503', r.status === 503);
  ok('endpoint: 503 names VISION_API_KEY', (await r.text()).includes('VISION_API_KEY'));

  // 3. Mode allowlist (v198 adds 'shelf')
  r = await post({ VISION_API_KEY: 'k' }, { image: IMG, mode: 'shelf' });
  ok('endpoint: mode shelf rejected in v197', r.status === 400);
  r = await post({ VISION_API_KEY: 'k' }, { image: IMG, mode: 'bogus' });
  ok('endpoint: bad mode -> 400', r.status === 400);

  // 4. Image guards
  r = await post({ VISION_API_KEY: 'k' }, { mode: 'single' });
  ok('endpoint: missing image -> 400', r.status === 400);
  r = await post({ VISION_API_KEY: 'k' }, { image: 'data:image/jpeg;base64,' + 'A'.repeat(4000000), mode: 'single' });
  ok('endpoint: oversized image -> 400', r.status === 400);
  r = await post({ VISION_API_KEY: 'k' }, { image: 'data:text/plain;base64,AAAA', mode: 'single' });
  ok('endpoint: non-image data URL -> 400', r.status === 400);

  // 5. Happy path with mocked upstream
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ isbn: '9780425189863', title: 'Test Title', author: 'Jane Doe' }) } }],
    }), { status: 200 });
  };
  r = await post({ VISION_API_KEY: 'sk-test' }, { image: IMG, mode: 'single' });
  const out = await r.json();
  ok('endpoint: happy path -> 200', r.status === 200);
  ok('endpoint: returns parsed isbn/title/author',
    out.isbn === '9780425189863' && out.title === 'Test Title' && out.author === 'Jane Doe');
  ok('endpoint: upstream is api.openai.com', seen.url === 'https://api.openai.com/v1/chat/completions');
  ok('endpoint: Bearer key attached', seen.init.headers['Authorization'] === 'Bearer sk-test');
  ok('endpoint: json_object response format', seen.body.response_format && seen.body.response_format.type === 'json_object');
  ok('endpoint: temperature 0', seen.body.temperature === 0);
  ok('endpoint: image sent as image_url part',
    seen.body.messages[0].content.some(p => p.type === 'image_url' && p.image_url.url === IMG));
  ok('endpoint: key never leaks into response', !(await (await post({ VISION_API_KEY: 'sk-test' }, { image: IMG, mode: 'single' })).text()).includes('sk-test'));

  // 6. Model garbage -> cleaned, not trusted
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ isbn: 'not-an-isbn!!', title: '  ', author: 42 }) } }],
  }), { status: 200 });
  r = await post({ VISION_API_KEY: 'k' }, { image: IMG, mode: 'single' });
  const out2 = await r.json();
  ok('endpoint: non-ISBN-shaped isbn cleaned to null', out2.isbn === null);
  ok('endpoint: blank/non-string fields cleaned to null', out2.title === null && out2.author === null);

  // 7. Upstream failure passes through
  globalThis.fetch = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
  r = await post({ VISION_API_KEY: 'k' }, { image: IMG, mode: 'single' });
  ok('endpoint: upstream 401 forwarded', r.status === 401);

  // 8. Rate limit (20/min) — distinct IP, mocked upstream
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{}' } }],
  }), { status: 200 });
  const rlCtx = (body) => ({
    env: { VISION_API_KEY: 'k' },
    request: new Request('https://app.test/api/read-cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'rl-test-ip' },
      body: JSON.stringify(body),
    }),
  });
  let last = null;
  for (let i = 0; i < 21; i++) last = await fn.onRequest(rlCtx({ image: IMG, mode: 'single' }));
  ok('endpoint: 21st rapid request -> 429', last.status === 429);
  globalThis.fetch = realFetch;

  // ============ Part B: client ============
  const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.matchMedia = () => ({ matches: false });
  require('./harness').loadApp(window);
  window.Response = Response; // JSDOM's window has no Response; use Node's
  const runInWindow = (js) => {
    const s = window.document.createElement('script');
    s.textContent = js;
    window.document.body.appendChild(s);
  };
  const runInWindowRet = (js) => {
    const s = window.document.createElement('script');
    s.textContent = 'window.__ret = (function(){ return (' + js + '); })();';
    window.document.body.appendChild(s);
    return window.__ret;
  };
  const tick = (ms) => new Promise(res => setTimeout(res, ms || 40));

  ok('client: scan panel has the vision button',
    runInWindowRet(`scanPanelHTML()`).includes('id="scan-vision"'));
  ok('client: vision button carries the vision-btn class',
    runInWindowRet(`scanPanelHTML()`).includes('vision-btn'));

  // Stub the network + downstream flows; capture routing decisions.
  runInWindow(`
    document.body.innerHTML = '<div id="scan-result"></div>';
    window.__visionCalls = [];
    window.__seenIsbnUI = null;
    window.__seenSearch = null;
    window.__painted = false;
    window.visionGetImage = () => 'data:image/jpeg;base64,FAKE';
    window.fetch = async (url, init) => {
      window.__visionCalls.push(JSON.parse(init.body));
      return window.__visionResp();
    };
    window.isbnLookupUI = (isbn, mount, src) => { window.__seenIsbnUI = { isbn, src }; };
    window.searchBooks = async (q) => { window.__seenSearch = q; return window.__searchResults || []; };
    window.paintSearchResults = (box) => { window.__painted = true; };
  `);
  const setResp = (status, json) => runInWindow(
    `window.__visionResp = async () => new Response(${JSON.stringify(JSON.stringify(json))}, { status: ${status}, headers: { 'Content-Type': 'application/json' } });`);

  // B1: valid ISBN from the model -> routed to isbnLookupUI after check-digit validation
  setResp(200, { isbn: '9780425189863', title: 'T', author: 'A' });
  runInWindow(`visionSend('data:image/jpeg;base64,FAKE')`);
  await tick(60);
  ok('client: valid model ISBN -> isbnLookupUI',
    runInWindowRet(`window.__seenIsbnUI && window.__seenIsbnUI.isbn`) === '9780425189863');
  ok('client: posts image + mode single',
    runInWindowRet(`window.__visionCalls.length`) === 1 &&
    runInWindowRet(`window.__visionCalls[0].mode`) === 'single');

  // B2: check-digit-INVALID isbn + title -> falls back to title search, never lookupISBN
  runInWindow(`window.__seenIsbnUI = null; window.__seenSearch = null; window.__searchResults = [{title:'X'}];`);
  setResp(200, { isbn: '9780425189860', title: 'Some Title', author: 'Some Author' });
  runInWindow(`visionSend('data:image/jpeg;base64,FAKE')`);
  await tick(60);
  ok('client: bad-check-digit ISBN is NOT trusted',
    runInWindowRet(`window.__seenIsbnUI`) === null);
  ok('client: falls back to title+author search',
    runInWindowRet(`window.__seenSearch`) === 'Some Title Some Author');
  ok('client: paints the search results', runInWindowRet(`window.__painted`) === true);

  // B3: nothing readable -> plain message
  runInWindow(`window.__seenIsbnUI = null; window.__seenSearch = null; window.__painted = false;`);
  setResp(200, { isbn: null, title: null, author: null });
  runInWindow(`visionSend('data:image/jpeg;base64,FAKE')`);
  await tick(60);
  ok('client: unreadable cover -> helpful message',
    /Couldn.t read the cover/.test(runInWindowRet(`document.getElementById('scan-result').innerHTML`)));

  // B4: 503 -> setup-missing message (not a crash)
  setResp(503, { error: 'no key' });
  runInWindow(`visionSend('data:image/jpeg;base64,FAKE')`);
  await tick(60);
  ok('client: 503 -> setup message',
    /isn.t set up/.test(runInWindowRet(`document.getElementById('scan-result').innerHTML`)));

  // B5: 429 -> rate-limit message
  runInWindow(`window.__visionResp = async () => new Response('rate limited', { status: 429 });`);
  runInWindow(`visionSend('data:image/jpeg;base64,FAKE')`);
  await tick(60);
  ok('client: 429 -> wait message',
    /Too many cover reads/.test(runInWindowRet(`document.getElementById('scan-result').innerHTML`)));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('ERR', e); process.exit(1); });
