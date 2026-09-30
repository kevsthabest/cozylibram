// v199: bulk bookshelf-spine scanning — /api/read-cover mode 'shelf' +
// client review flow. Nothing is added silently: confident matches get an
// "add all", everything else is reviewed one by one, and books already on
// the shelves are marked.
const path = require('path');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(1000);

async function main() {
  // ============ Part A: Pages function, shelf mode ============
  const fn = await import(path.resolve(__dirname, '../functions/api/read-cover.js'));
  const realFetch = globalThis.fetch;
  let ipN = 0;
  const ctx = (env, body, method) => ({
    env,
    request: new Request('https://app.test/api/read-cover', {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'shelf-test-' + (++ipN) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  });
  const post = (env, body) => fn.onRequest(ctx(env, body));

  let r = await post({ VISION_API_KEY: 'k' }, { image: IMG, mode: 'nope' });
  ok('endpoint: unknown mode -> 400', r.status === 400);

  r = await post({ VISION_API_KEY: 'k' }, { image: IMG }); // no mode
  ok('endpoint: missing mode -> 400', r.status === 400);

  let seen = null;
  const shelfPayload = {
    books: [
      { title: 'Fourth Wing', author: 'Rebecca Yarros', confidence: 'high' },
      { title: 'Iron Flame', author: 'Rebecca Yarros', confidence: 'medium' },
      { title: null, author: null, confidence: 'high' }, // unreadable: dropped
      { title: 'A Court of Thorns and Roses', author: 'Sarah J. Maas', confidence: 'bogus' }, // -> low
      { title: 'x'.repeat(400), author: '  ', confidence: 'high' }, // trimmed / blanked
    ],
  };
  globalThis.fetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(shelfPayload) } }],
    }), { status: 200 });
  };
  r = await post({ VISION_API_KEY: 'k' }, { image: IMG, mode: 'shelf' });
  ok('endpoint: shelf mode -> 200', r.status === 200);
  const out = await r.json();
  ok('endpoint: shelf prompt asks for spines left-to-right',
    seen.body.messages[0].content[0].text.includes('bookshelf') &&
    seen.body.messages[0].content[0].text.includes('left-to-right'));
  ok('endpoint: shelf gets a bigger token budget', seen.body.max_tokens === 2000);
  ok('endpoint: unreadable spine dropped', out.books.length === 4);
  ok('endpoint: fields trimmed, blank author nulled',
    out.books[3].title.length === 300 && out.books[3].author === null);
  ok('endpoint: bogus confidence coerced to low',
    out.books.find(b => b.title === 'A Court of Thorns and Roses').confidence === 'low');
  ok('endpoint: good entry passes through',
    out.books[0].title === 'Fourth Wing' && out.books[0].confidence === 'high');

  // Cap at 30 spines.
  const many = { books: Array.from({ length: 40 }, (_, i) => ({ title: 'T' + i, author: 'A', confidence: 'high' })) };
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(many) } }],
  }), { status: 200 });
  r = await post({ VISION_API_KEY: 'k' }, { image: IMG, mode: 'shelf' });
  ok('endpoint: shelf caps at 30 spines', (await r.json()).books.length === 30);

  // Garbage model answer -> empty list, not a crash.
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"nope": true}' } }],
  }), { status: 200 });
  r = await post({ VISION_API_KEY: 'k' }, { image: IMG, mode: 'shelf' });
  const empty = await r.json();
  ok('endpoint: non-shelf JSON -> empty books list',
    r.status === 200 && Array.isArray(empty.books) && empty.books.length === 0);
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

  ok('client: scan panel has the shelf button',
    runInWindowRet(`scanPanelHTML()`).includes('id="scan-shelf"'));
  ok('client: shelf button shares the vision busy-state class',
    runInWindowRet(`scanPanelHTML()`).includes('id="scan-shelf"') &&
    runInWindowRet(`scanPanelHTML().split('id="scan-shelf"')[0].split('id="scan-vision"')[1].includes('vision-btn') || scanPanelHTML().includes('vision-btn" id="scan-shelf')`));

  // --- shelfBestMatch scoring ---
  const match = (cand, results) => runInWindowRet(
    `JSON.stringify(shelfBestMatch(${JSON.stringify(cand)}, ${JSON.stringify(results)}))`);
  const res1 = [{ title: 'Fourth Wing', authors: ['Rebecca Yarros'] }];
  let m = JSON.parse(match({ title: 'Fourth Wing', author: 'Rebecca Yarros', confidence: 'high' }, res1));
  ok('client: exact title + surname + high confidence -> confident',
    m && m.confident === true && m.book.title === 'Fourth Wing');
  m = JSON.parse(match({ title: 'Fourth Wing', author: 'Rebecca Yarros', confidence: 'medium' }, res1));
  ok('client: medium model confidence -> review, not confident', m && m.confident === false);
  m = JSON.parse(match({ title: 'Fourth Wing', author: 'Someone Else', confidence: 'high' }, res1));
  ok('client: author mismatch -> review, not confident', m && m.confident === false);
  m = JSON.parse(match({ title: 'Fourth Wing', author: 'Rebecca Yarros', confidence: 'high' }, []));
  ok('client: no catalog results -> null', m === null);
  m = JSON.parse(match({ title: 'A', author: '', confidence: 'high' }, res1));
  ok('client: no significant title tokens -> null', m === null);

  // --- shelfSend flow: review list, add-all, already-have ---
  runInWindow(`
    document.body.insertAdjacentHTML('beforeend', '<div id="scan-result"></div>');
    window.__shelfCalls = [];
    window.__shelfCatalog = {
      'Fourth Wing Rebecca Yarros': [{ title: 'Fourth Wing', authors: ['Rebecca Yarros'], isbn: '9781649374042' }],
      'Iron Flame Rebecca Yarros': [{ title: 'Iron Flame', authors: ['Rebecca Yarros'], isbn: '9781649374178' }],
    };
    window.searchBooks = async (q) => { window.__shelfCalls.push(q); return window.__shelfCatalog[q] || []; };
    library.push({ id: 'have-1', title: 'Iron Flame', authors: ['Rebecca Yarros'], isbn: '9781649374178' });
    window.fetch = async (url, init) => new Response(JSON.stringify({
      books: [
        { title: 'Fourth Wing', author: 'Rebecca Yarros', confidence: 'high' },
        { title: 'Iron Flame', author: 'Rebecca Yarros', confidence: 'high' },
        { title: 'Some Obscure Tome', author: 'Unknown Scribe', confidence: 'low' },
      ],
    }), { status: 200 });
  `);
  runInWindow(`shelfSend('data:image/jpeg;base64,FAKE')`);
  await tick(900); // 3 lookups, 250ms pacing between them
  const mountHTML = () => runInWindowRet(`document.getElementById('scan-result').innerHTML`);
  ok('client: review list names the spines', mountHTML().includes('Fourth Wing'));
  ok('client: confident match badged', mountHTML().includes('confident match'));
  ok('client: book already on shelves badged', mountHTML().includes('already on shelves'));
  ok('client: no-match spine shown', mountHTML().includes('no match found'));
  ok('client: add-all button counts only confident matches',
    mountHTML().includes('Add 1 confident match'));
  ok('client: nothing added silently', runInWindowRet(`library.length`) === 1);

  // Add-all -> the confident book lands in the library, card marked done.
  runInWindow(`document.getElementById('shelf-add-all').click()`);
  await tick(300);
  ok('client: add-all adds the confident match',
    runInWindowRet(`library.length`) === 2 &&
    runInWindowRet(`library.some(b => b.title === 'Fourth Wing')`));

  // 503 -> setup message.
  runInWindow(`
    window.fetch = async () => new Response('{"error":"nope"}', { status: 503 });
    shelfBusy = false;
  `);
  runInWindow(`shelfSend('data:image/jpeg;base64,FAKE')`);
  await tick(120);
  ok('client: 503 -> setup message', mountHTML().includes('isn\u2019t set up'));

  // Empty books -> helpful message.
  runInWindow(`
    window.fetch = async () => new Response('{"books":[]}', { status: 200 });
    shelfBusy = false;
  `);
  runInWindow(`shelfSend('data:image/jpeg;base64,FAKE')`);
  await tick(120);
  ok('client: no readable spines -> helpful message',
    mountHTML().includes('Couldn\u2019t read any spines'));

  // v200: a failed scan lands in the on-device Logs tab, not just on screen.
  runInWindow(`
    window.fetch = async () => { throw new Error('boom'); };
    if (typeof AppLog !== 'undefined') AppLog.clear();
    shelfBusy = false;
  `);
  runInWindow(`shelfSend('data:image/jpeg;base64,FAKE')`);
  await tick(120);
  ok('client: failed scan paints a message', mountHTML().includes('Shelf scan failed'));
  ok('client: failed scan is logged to the Logs tab',
    runInWindowRet(`typeof AppLog !== 'undefined' && AppLog.entries('error').some(e => e.tag === 'shelf')`));

  // v201: a re-render mid-scan replaces #scan-result — the review list must
  // land in the LIVE node, not the stale reference (the "Reading…" then
  // nothing bug).
  runInWindow(`
    window.fetch = async () => {
      await new Promise(r => setTimeout(r, 150)); // model "thinking"
      return new Response(JSON.stringify({
        books: [{ title: 'Fourth Wing', author: 'Rebecca Yarros', confidence: 'high' }],
      }), { status: 200 });
    };
    window.searchBooks = async (q) => [{ title: 'Fourth Wing', authors: ['Rebecca Yarros'] }];
    shelfBusy = false;
    shelfSend('data:image/jpeg;base64,FAKE');
    // Simulate renderAdd() rebuilding the panel mid-flight.
    setTimeout(() => {
      document.getElementById('scan-result').outerHTML = '<div id="scan-result"></div>';
    }, 60);
  `);
  await tick(600);
  ok('client: review list survives a mid-scan re-render',
    mountHTML().includes('Fourth Wing') && mountHTML().includes('spine'));

  // v201: an aborted (timed-out) model call gets its own message + log entry.
  runInWindow(`
    window.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    if (typeof AppLog !== 'undefined') AppLog.clear();
    shelfBusy = false;
  `);
  runInWindow(`shelfSend('data:image/jpeg;base64,FAKE')`);
  await tick(120);
  ok('client: timed-out scan says so', mountHTML().includes('timed out'));
  ok('client: timed-out scan is logged',
    runInWindowRet(`typeof AppLog !== 'undefined' && AppLog.entries('error').some(e => e.tag === 'shelf')`));

  // v201: visionDownscale never breaks the flow — undecodable input falls
  // back to the original data URL (JSDOM can't decode images at all).
  runInWindow(`window.__downscaleP = visionDownscale('data:image/jpeg;base64,FAKE', 1024, 50).then(v => { window.__downscaleV = v; });`);
  await tick(300);
  ok('client: visionDownscale falls back to the original',
    runInWindowRet(`window.__downscaleV`) === 'data:image/jpeg;base64,FAKE');
}

main().then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error('FATAL', e); process.exit(1); });
