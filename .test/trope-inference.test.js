// Trope inference tests (v152): prompt building, genre mapping, book keys,
// response parsing/validation, retry behavior (mock provider), and the
// paced queue — all with no network and no API key.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const APP = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(APP + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const probe = (js) => window.eval(js);

function mockResp(status, body, headers) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (headers || {})[k.toLowerCase()] || null },
    json: async () => body,
  };
}
const chatBody = (content, model) => ({
  model: model || 'test-model',
  choices: [{ message: { content } }],
});

async function main() {
  // ---- genre mapping ----
  ok('dark romance maps to dark-romance (and romance)',
    (() => { const g = probe("appGenresToTropeGenres(['Dark Romance'])"); return g.includes('dark-romance') && g.includes('romance'); })());
  ok('science fiction maps to sci-fi',
    probe("appGenresToTropeGenres(['Science Fiction'])").join() === 'sci-fi');
  ok('multiple genres map', (() => {
    const g = probe("appGenresToTropeGenres(['Fantasy', 'Mystery'])");
    return g.includes('fantasy') && g.includes('mystery-thriller');
  })());
  ok('unknown categories map to nothing',
    probe("appGenresToTropeGenres(['Poetry'])").length === 0);
  ok('empty categories map to nothing',
    probe('appGenresToTropeGenres([])').length === 0);

  // ---- prompt builder: genre filtering keeps prompts small ----
  const sciFiPrompt = probe(`buildTropePrompt(${JSON.stringify({
    title: 'Daemon', authors: ['Daniel Suarez'], categories: ['Science Fiction'],
    description: 'A dead game designer unleashes an AI daemon.',
  })})`);
  ok('prompt has system + user', !!sciFiPrompt.system && !!sciFiPrompt.user);
  ok('sci-fi prompt includes ai-uprising', sciFiPrompt.system.includes('ai-uprising'));
  ok('sci-fi prompt excludes romance-only tropes', !sciFiPrompt.system.includes('billionaire'));
  ok('sci-fi prompt excludes fantasy-only tropes', !sciFiPrompt.system.includes('magic-academy'));
  ok('user message carries title/author/description',
    sciFiPrompt.user.includes('Daemon') && sciFiPrompt.user.includes('Daniel Suarez') &&
    sciFiPrompt.user.includes('AI daemon'));
  ok('system prompt states the 0-8 rule', sciFiPrompt.system.includes('Tag 0-8 tropes'));
  ok('system prompt demands description grounding',
    sciFiPrompt.system.includes('Never tag from the title, author, or genre alone'));
  ok('system prompt forbids invented ids', sciFiPrompt.system.includes('Never invent'));

  const noGenrePrompt = probe('buildTropePrompt({title:"X",description:"Y"})');
  ok('no genres -> full taxonomy in prompt', noGenrePrompt.tropeCount === probe('TROPES.length'));

  // ---- book keys ----
  ok('ISBN-13 wins', probe("bookKeyFor({isbn:'978-0-7653-2000-5',title:'X',authors:['Y']})") === 'isbn:9780765320005');
  ok('title/author fallback', probe("bookKeyFor({title:'Fourth Wing',authors:['Rebecca Yarros']})") === 't:fourth wing:rebecca yarros');
  ok('"The" prefix stripped', probe("bookKeyFor({title:'The Hobbit',authors:['Tolkien']})") === 't:hobbit:tolkien');
  ok('diacritics + punctuation folded',
    probe("bookKeyFor({title:'Café Society!',authors:['Renée']})") === 't:cafe society:renee');
  ok('ISBN-10 falls back to title/author',
    probe("bookKeyFor({isbn:'0765320002',title:'X',authors:['Y']})") === 't:x:y');
  ok('same book, different library rows -> same key',
    probe("bookKeyFor({isbn:'9780765320005',title:'Whatever',authors:['Nobody']})") ===
    probe("bookKeyFor({isbn:'978-0-7653-2000-5',title:'Other',authors:['Else']})"));

  // ---- response parser ----
  ok('parses clean JSON', probe(`parseTropeResponse('{"tropes":[{"id":"dragons","confidence":0.9}]}').length`) === 1);
  ok('strips markdown fences',
    probe("parseTropeResponse('```json\\n{\"tropes\":[]}\\n```').length") === 0);
  ok('accepts bare arrays', probe("parseTropeResponse('[{\"id\":\"dragons\"}]').length") === 1);
  ok('extracts JSON embedded in prose',
    probe("parseTropeResponse('Here you go: {\"tropes\":[{\"id\":\"dragons\"}]} done').length") === 1);
  ok('throws on garbage', (() => { try { probe("parseTropeResponse('nope nope')"); return false; } catch (e) { return true; } })());
  ok('throws on empty', (() => { try { probe("parseTropeResponse('')"); return false; } catch (e) { return true; } })());
  ok('throws when no tropes array', (() => { try { probe('parseTropeResponse(\'{"foo":1}\')'); return false; } catch (e) { return true; } })());

  // ---- validation ----
  ok('drops unknown ids', probe("validateTropeResults([{id:'dragons',confidence:0.9},{id:'forced-closeness',confidence:0.9}]).length") === 1);
  ok('clamps confidence', (() => {
    const r = probe("validateTropeResults([{id:'dragons',confidence:2},{id:'quest',confidence:-1}])");
    return r[0].confidence === 1 && r[1].confidence === 0;
  })());
  ok('caps at 8', (() => {
    const ids = probe('TROPES').slice(0, 10).map(t => ({ id: t.id, confidence: 0.9 }));
    return probe(`validateTropeResults(${JSON.stringify(ids)}).length`) === 8;
  })());
  ok('dedupes ids', probe("validateTropeResults([{id:'dragons',confidence:0.9},{id:'Dragons',confidence:0.5}]).length") === 1);
  ok('skips non-objects', probe("validateTropeResults([null,'x',{id:'dragons',confidence:0.9}]).length") === 1);
  ok('skips NaN confidence', probe("validateTropeResults([{id:'dragons',confidence:'high'}]).length") === 0);

  // ---- backoff ----
  ok('backoff sequence 1s/4s/16s',
    probe('tropeBackoffMs(0)') === 1000 && probe('tropeBackoffMs(1)') === 4000 &&
    probe('tropeBackoffMs(2)') === 16000 && probe('tropeBackoffMs(9)') === 16000);
  ok('honors Retry-After', probe('tropeBackoffMs(0, 30)') === 30000);
  ok('Retry-After capped at 120s', probe('tropeBackoffMs(0, 9999)') === 120000);

  // ---- inferBookTropes with a mock provider ----
  const book = { title: 'Daemon', authors: ['Daniel Suarez'], categories: ['Science Fiction'], description: 'AI daemon.' };

  window.fetch = async () => mockResp(200, chatBody('{"tropes":[{"id":"ai-uprising","confidence":0.95},{"id":"made-up","confidence":0.9}]}'));
  const res = await probe(`inferBookTropes(${JSON.stringify(book)}, { delayFn: () => Promise.resolve() })`);
  ok('success returns validated tropes', res.tropes.length === 1 && res.tropes[0].id === 'ai-uprising');
  ok('success returns model name', res.model === 'test-model');

  // 429 then success: retried
  let calls429 = 0;
  window.fetch = async () => (++calls429 === 1
    ? mockResp(429, {}, { 'retry-after': '0' })
    : mockResp(200, chatBody('{"tropes":[]}')));
  await probe(`inferBookTropes(${JSON.stringify(book)}, { delayFn: () => Promise.resolve() })`);
  ok('429 is retried', calls429 === 2);

  // 429 forever: gives up after 4 attempts
  let calls429x = 0;
  window.fetch = async () => { calls429x++; return mockResp(429, {}); };
  let threw429 = false;
  try { await probe(`inferBookTropes(${JSON.stringify(book)}, { delayFn: () => Promise.resolve() })`); }
  catch (e) { threw429 = true; }
  ok('persistent 429 throws after 4 attempts', threw429 && calls429x === 4);

  // 401: fatal, no retry
  let calls401 = 0;
  window.fetch = async () => { calls401++; return mockResp(401, {}); };
  let fatal = null;
  try { await probe(`inferBookTropes(${JSON.stringify(book)}, { delayFn: () => Promise.resolve() })`); }
  catch (e) { fatal = e; }
  ok('401 throws fatal immediately', !!fatal && fatal.fatal === true && calls401 === 1);

  // bad JSON then clean JSON: one nudge retry, second request has 3 messages
  let bodies = [];
  window.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return bodies.length === 1
      ? mockResp(200, chatBody('Here is some prose with no JSON at all'))
      : mockResp(200, chatBody('{"tropes":[{"id":"dragons","confidence":0.8}]}'));
  };
  const nudgeRes = await probe(`inferBookTropes(${JSON.stringify(book)}, { delayFn: () => Promise.resolve() })`);
  ok('unparseable output triggers one JSON-only nudge',
    bodies.length === 2 && bodies[1].messages.length === 3 &&
    bodies[1].messages[2].content.includes('JSON only'));
  ok('nudge retry result validates', nudgeRes.tropes.length === 1);

  // empty model content: throws (never cached as "no tropes")
  window.fetch = async () => mockResp(200, chatBody(''));
  let threwEmpty = false;
  try { await probe(`inferBookTropes(${JSON.stringify(book)}, { delayFn: () => Promise.resolve() })`); }
  catch (e) { threwEmpty = true; }
  ok('empty model content throws', threwEmpty);

  // request shape
  let sentBody = null;
  window.fetch = async (url, opts) => { sentBody = JSON.parse(opts.body); return mockResp(200, chatBody('{"tropes":[]}')); };
  await probe(`inferBookTropes(${JSON.stringify(book)}, { delayFn: () => Promise.resolve() })`);
  ok('posts to the same-origin proxy', sentBody && sentBody.messages.length === 2);
  ok('max_tokens generous for reasoning models', sentBody.max_tokens >= 1000);
  ok('request carries only messages + max_tokens (no credentials)',
    JSON.stringify(Object.keys(sentBody).sort()) === '["max_tokens","messages"]');

  // ---- TropeQueue ----
  probe('TropeQueue.reset()');
  probe('TropeQueue._delayMs = 0');
  const qBooks = {
    b1: { id: 'b1', title: 'Book One', authors: ['A'], description: 'd1' },
    b2: { id: 'b2', title: 'Book Two', authors: ['B'], description: 'd2' },
  };
  const upserted = [];
  window.__qBooks = qBooks;
  window.__upserted = upserted;
  window.eval(`TropeQueue.configure({
    resolveBook: id => window.__qBooks[id] || null,
    upsertRows: async rows => { window.__upserted.push(...rows); },
    onEvent: () => {},
  })`);
  window.fetch = async () => mockResp(200, chatBody('{"tropes":[{"id":"dragons","confidence":0.9}]}', 'm1'));
  const enq = probe("TropeQueue.enqueue(['b1','b2','b1'])");
  ok('enqueue dedupes', enq === 2);
  probe('TropeQueue.start()');
  await new Promise(r => setTimeout(r, 300));
  const snap = probe('TropeQueue.snapshot()');
  ok('queue processed both books', snap.done === 2 && snap.pending === 0);
  ok('upserted rows carry book_key + taxonomy version',
    upserted.length === 2 && upserted.every(r =>
      r.book_key && r.book_key.startsWith('t:') && r.source === 'llm' &&
      r.taxonomy_version === probe('TROPE_TAXONOMY_VERSION')));
  ok('queue is idle when drained', snap.running === false);

  // failure marking: one book throws, the other still processes
  probe('TropeQueue.reset()');
  window.__qBooks = { good: qBooks.b1, bad: { id: 'bad', title: 'Bad', authors: ['X'] } };
  window.fetch = async (url, opts) => {
    const u = JSON.parse(opts.body).messages[1].content;
    return u.includes('Title: Bad') ? mockResp(500, {}) : mockResp(200, chatBody('{"tropes":[]}'));
  };
  window.eval(`TropeQueue.configure({
    resolveBook: id => window.__qBooks[id] || null,
    upsertRows: async rows => { window.__upserted.push(...rows); },
    onEvent: () => {},
  })`);
  probe("TropeQueue.enqueue(['good','bad'])");
  probe('TropeQueue.start()');
  await new Promise(r => setTimeout(r, 500));
  const snap2 = probe('TropeQueue.snapshot()');
  ok('one failure recorded, other book done', snap2.failed === 1 && snap2.done === 1);

  // persistence across "reload": state survives localStorage round-trip
  probe('TropeQueue.reset()');
  probe("TropeQueue.enqueue(['b1'])");
  probe('TropeQueue.pause()');
  probe('TropeQueue._state = null'); // simulate reload
  const snap3 = probe('TropeQueue.snapshot()');
  ok('queue state persists across reload', snap3.pending === 1 && snap3.total === 1);

  // fatal error stops the queue
  probe('TropeQueue.reset()');
  window.__qBooks = { b1: qBooks.b1 };
  window.fetch = async () => mockResp(401, {});
  probe("TropeQueue.enqueue(['b1'])");
  probe('TropeQueue.start()');
  await new Promise(r => setTimeout(r, 300));
  const snap4 = probe('TropeQueue.snapshot()');
  ok('fatal error stops the queue with a message',
    snap4.running === false && /API key/.test(snap4.fatalError));

  // ---- config helpers ----
  ok('tropeInferenceConfigured false without config', probe('tropeInferenceConfigured()') === false);
  window.SPICY_CONFIG = { trope: true, tropeProvider: 'openrouter', tropeModel: 'm' };
  ok('tropeInferenceConfigured true with flag', probe('tropeInferenceConfigured()') === true);
  ok('tropeProviderInfo exposes names only',
    (() => { const i = probe('tropeProviderInfo()'); return i.provider === 'openrouter' && i.model === 'm' && !('key' in i); })());
  window.SPICY_CONFIG = undefined;

  // ---- tropeLabCoverage (pure-ish) ----
  const cov = probe(`tropeLabCoverage(
    [{id:'a',title:'A'},{id:'b',title:'B'},{id:'c',title:'C'}],
    [{book_key: bookKeyFor({title:'A'}), taxonomy_version: 1},
     {book_key: bookKeyFor({title:'B'}), taxonomy_version: 0}])`);
  ok('coverage counts tagged/missing/stale',
    cov.total === 3 && cov.tagged === 1 && cov.missing.length === 1 && cov.stale.length === 1);
  // v157: staleness is rev-aware (taxonomy_meta.rev bumps on every approval)
  const cov2 = probe(`tropeLabCoverage(
    [{id:'a',title:'A'},{id:'b',title:'B'},{id:'c',title:'C'}],
    [{book_key: bookKeyFor({title:'A'}), taxonomy_version: 1, taxonomy_rev: 1},
     {book_key: bookKeyFor({title:'B'}), taxonomy_version: 1, taxonomy_rev: 3},
     {book_key: bookKeyFor({title:'C'}), taxonomy_version: 1}],
    { version: 1, rev: 3 })`);
  ok('rev-aware staleness: old rev is stale, current rev is tagged, missing rev counts as rev 1',
    cov2.total === 3 && cov2.tagged === 1 && cov2.stale.length === 2);

  // index.html + sw.js wiring
  ok('index.html includes 157-trope-inference.js', html.includes('js/157-trope-inference.js'));
  ok('sw.js precaches 157-trope-inference.js',
    fs.readFileSync(APP + '/sw.js', 'utf8').includes('157-trope-inference.js'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS ERROR', e); process.exit(1); });
