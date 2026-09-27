// Hardcover error-classification tests (v77): hcGraphQL must throw a specific,
// human-readable error for each failure mode instead of silently returning
// undefined, so the UI can tell "token rejected" apart from "offline".
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.matchMedia = () => ({ matches: false });

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const setFetch = (impl) => { window.fetch = impl; };
const q = 'query { __typename }';

async function throwsWith(setup, needle) {
  setFetch(setup);
  runInWindow('window.__err = null; hcGraphQL(' + JSON.stringify(q) + ')' +
    '.then(d => { window.__res = d; }).catch(e => { window.__err = String(e && e.message); });');
  await new Promise(r => setTimeout(r, 30));
  return typeof window.__err === 'string' && window.__err.includes(needle);
}

(async () => {
  runInWindow('window.SPICY_CONFIG = { hardcoverToken: "tok" };');

  ok('401 -> token rejected',
    await throwsWith(async () => ({ status: 401, json: async () => ({ message: 'unauthorized' }) }),
      'rejected the token (HTTP 401)'));
  ok('403 -> token rejected',
    await throwsWith(async () => ({ status: 403, json: async () => ({}) }),
      'rejected the token (HTTP 403)'));
  ok('403 with blocked-operation body -> query blamed, not the token',
    await throwsWith(async () => ({ status: 403,
        json: async () => ({ message: 'ilike and related operations are not permitted on this server' }) }),
      'blocked this query (HTTP 403)'));
  ok('network failure -> network error',
    await throwsWith(async () => { throw new Error('fetch failed'); }, 'Network error'));
  ok('GraphQL errors surfaced',
    await throwsWith(async () => ({ status: 200, json: async () => ({ errors: [{ message: 'boom' }] }) }),
      'Hardcover error: boom'));
  ok('200 with no data -> invalid token hint',
    await throwsWith(async () => ({ status: 200, json: async () => ({ message: 'unauthorized' }) }),
      'token may be invalid'));
  ok('unreadable body -> readable error',
    await throwsWith(async () => ({ status: 500, json: async () => { throw new Error('bad json'); } }),
      'unreadable response (HTTP 500)'));
  ok('success returns data', await (async () => {
    setFetch(async () => ({ status: 200, json: async () => ({ data: { ok: 1 } }) }));
    runInWindow('window.__err = null; window.__res = null; hcGraphQL(' + JSON.stringify(q) + ')' +
      '.then(d => { window.__res = d; }).catch(e => { window.__err = String(e && e.message); });');
    await new Promise(r => setTimeout(r, 30));
    return window.__err === null && window.__res && window.__res.ok === 1;
  })());
  ok('no token -> null, not a throw', await (async () => {
    runInWindow('delete window.SPICY_CONFIG; window.__err = null; window.__res = "unset"; ' +
      'hcGraphQL(' + JSON.stringify(q) + ').then(d => { window.__res = d; })' +
      '.catch(e => { window.__err = String(e && e.message); });');
    await new Promise(r => setTimeout(r, 30));
    return window.__err === null && window.__res === null;
  })());

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
