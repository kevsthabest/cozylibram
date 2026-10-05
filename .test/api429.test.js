// v292: api429Message distinguishes our per-IP limiter from upstream quota.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const run = (js) => window.eval(js);

const fakeRes = (body, contentType) => ({
  status: 429,
  headers: { get: (n) => String(n).toLowerCase() === 'content-type' ? contentType : null },
  text: async () => body,
});

(async () => {
  // Our limiter: exact text body "rate limited" -> the local message survives.
  window.__r1 = fakeRes('rate limited', 'text/plain');
  const m1 = await run(`api429Message(window.__r1, 'Too many scans — wait a minute.')`);
  ok('our limiter keeps the wait-a-minute message', m1 === 'Too many scans — wait a minute.');

  // Upstream quota: JSON body -> the quota message names Google, not "too many".
  window.__r2 = fakeRes(JSON.stringify({ error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }), 'application/json');
  const m2 = await run(`api429Message(window.__r2, 'Too many scans — wait a minute.')`);
  ok('upstream quota names the real cause',
    m2.indexOf('quota') !== -1 && m2.indexOf('Google') !== -1);

  // Missing/unreadable body degrades to the upstream message, never throws.
  window.__r3 = { status: 429, headers: { get: () => null } };
  const m3 = await run(`api429Message(window.__r3, 'local msg')`);
  ok('unreadable body degrades safely', typeof m3 === 'string' && m3.indexOf('Google') !== -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
