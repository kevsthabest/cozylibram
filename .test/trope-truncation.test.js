// Trope truncation tests (v156): the reasoning-budget failure mode.
//
// Free reasoning models (Nemotron, Qwen) can spend 1000+ tokens on
// chain-of-thought inside the max_tokens budget, so the visible content is
// truncated mid-JSON or is pure reasoning prose ("unparseable model output"
// even after the JSON-only retry). These tests cover the v156 recovery:
//   - the proxy converts finish_reason:length into 502 {error:'truncated'}
//     (verified against mock upstreams, not unit-tested here)
//   - the client retries a truncated response with a doubled token budget
//   - the client retries unparseable output with a JSON-only nudge AND a
//     doubled budget (the old nudge-only retry could not recover)
//   - the parser extracts JSON embedded in reasoning prose, plus bare arrays
//   - the system prompt forbids reasoning text
// v158: failures are descriptive — a 502 carrying an upstream error object
// surfaces its message ("provider HTTP 502: <reason>"), and truncation that
// persists at the max budget fails fast naming itself instead of looking
// like a provider outage.
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
const chatBody = (content) => ({
  model: 'test-model',
  choices: [{ message: { content } }],
});
const BOOK = { id: 'b1', title: 'Dungeon Crawler Carl', authors: ['Matt Dinniman'], categories: ['Science Fiction'], description: 'd' };

async function main() {
  // ---- parser: JSON embedded in reasoning prose ----
  ok('parser extracts JSON from reasoning prose',
    (() => {
      const raw = probe(`JSON.stringify(parseTropeResponse('Let me think... \\\\n{"tropes": [{"id": "alien-invasion", "confidence": 0.8}]} \\\\nThat seems right.'))`);
      return JSON.parse(raw)[0].id === 'alien-invasion';
    })());
  ok('parser accepts a bare array',
    (() => {
      const raw = probe(`JSON.stringify(parseTropeResponse('[{"id": "found-family", "confidence": 0.7}]'))`);
      return JSON.parse(raw)[0].id === 'found-family';
    })());
  ok('parser accepts a bare array inside prose',
    (() => {
      const raw = probe(`JSON.stringify(parseTropeResponse('Here you go: \\\\n[{"id": "quest", "confidence": 0.9}]\\\\nDone.'))`);
      return JSON.parse(raw)[0].id === 'quest';
    })());
  ok('parser still rejects pure prose with no JSON',
    probe(`(() => { try { parseTropeResponse('just some words, no braces at all'); return false; } catch (e) { return true; } })()`));

  // ---- prompt ----
  ok('system prompt forbids reasoning text',
    probe('buildTropePrompt(' + JSON.stringify(BOOK) + ').system').includes('no reasoning text'));
  ok('default token budget is 2000', probe('TROPE_MAX_TOKENS') === 2000);

  // ---- 502 truncated -> immediate retry with doubled budget ----
  {
    const w = window;
    const seen = [];
    const fetchFn = async (url, opts) => {
      seen.push(JSON.parse(opts.body).max_tokens);
      if (seen.length === 1) return mockResp(502, { error: 'truncated' });
      return mockResp(200, chatBody('{"tropes": [{"id": "alien-invasion", "confidence": 0.8}]}'));
    };
    w.__fetchFn = fetchFn;
    const res = await w.eval(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, delayFn: () => Promise.resolve() })`);
    ok('truncated 502 recovers on retry', res.tropes.length === 1 && res.tropes[0].id === 'alien-invasion');
    ok('truncated retry doubles the token budget', seen.length === 2 && seen[0] === 2000 && seen[1] === 4000);
    delete w.__fetchFn;
  }

  // ---- unparseable -> retry with nudge AND doubled budget ----
  {
    const w = window;
    const seen = [];
    const bodies = [];
    const fetchFn = async (url, opts) => {
      const b = JSON.parse(opts.body);
      seen.push(b.max_tokens);
      bodies.push(b.messages.map(m => m.content).join('\n'));
      if (seen.length === 1) return mockResp(200, chatBody('thinking thinking no json here'));
      return mockResp(200, chatBody('{"tropes": [{"id": "deadly-trials", "confidence": 0.85}]}'));
    };
    w.__fetchFn = fetchFn;
    const res = await w.eval(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, delayFn: () => Promise.resolve() })`);
    ok('unparseable recovers on retry', res.tropes.length === 1 && res.tropes[0].id === 'deadly-trials');
    ok('unparseable retry doubles the token budget', seen.length === 2 && seen[0] === 2000 && seen[1] === 4000);
    ok('unparseable retry adds a JSON-only nudge', bodies[1].includes('Reply with JSON only'));
    delete w.__fetchFn;
  }

  // ---- still unparseable after the recovery retry -> recorded failure ----
  {
    const w = window;
    const fetchFn = async () => mockResp(200, chatBody('more reasoning, still no json'));
    w.__fetchFn = fetchFn;
    let err = '';
    try {
      await w.eval(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, delayFn: () => Promise.resolve() })`);
    } catch (e) { err = e.message; }
    ok('double-unparseable still surfaces a failure', err === 'unparseable model output');
    delete w.__fetchFn;
  }

  // ---- non-truncated 502 still goes through the generic 5xx path ----
  {
    const w = window;
    let calls = 0;
    const fetchFn = async () => { calls++; return mockResp(502, { error: 'something else' }); };
    w.__fetchFn = fetchFn;
    let err = '';
    try {
      await w.eval(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, delayFn: () => Promise.resolve() })`);
    } catch (e) { err = e.message; }
    ok('non-truncated 502 retries then fails as provider error', calls === 4 && /provider HTTP 502/.test(err));
    delete w.__fetchFn;
  }

  // ---- v158: descriptive failures ----
  {
    // Upstream's own message is surfaced, not just the status code.
    const w = window;
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return mockResp(502, { error: { message: 'No available provider (529 overloaded)' } });
    };
    w.__fetchFn = fetchFn;
    let err = '';
    try {
      await w.eval(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, delayFn: () => Promise.resolve() })`);
    } catch (e) { err = e.message; }
    ok('502 surfaces the upstream message',
      calls === 4 && err === 'provider HTTP 502: No available provider (529 overloaded)');
    delete w.__fetchFn;
  }
  {
    // Empty/non-JSON 502 body still says something useful.
    const w = window;
    const fetchFn = async () => ({
      status: 502, ok: false,
      headers: { get: () => null },
      json: async () => { throw new Error('not json'); },
    });
    w.__fetchFn = fetchFn;
    let err = '';
    try {
      await w.eval(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, delayFn: () => Promise.resolve() })`);
    } catch (e) { err = e.message; }
    ok('bodyless 502 names the missing reason',
      err === 'provider HTTP 502 (upstream gave no reason)');
    delete w.__fetchFn;
  }
  {
    // Truncation that persists at the max budget fails fast with its own
    // message instead of masquerading as a provider outage.
    const w = window;
    let calls = 0;
    const fetchFn = async () => { calls++; return mockResp(502, { error: 'truncated' }); };
    w.__fetchFn = fetchFn;
    let err = '';
    try {
      await w.eval(`inferBookTropes(${JSON.stringify(BOOK)}, { fetchFn: window.__fetchFn, maxTokens: 4000, delayFn: () => Promise.resolve() })`);
    } catch (e) { err = e.message; }
    ok('truncation at max budget fails fast and says so',
      calls === 1 && /truncated its response at the max token budget/.test(err));
    delete w.__fetchFn;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
