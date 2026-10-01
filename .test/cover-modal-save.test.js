// v168: cover picker + modal Save — the modal snapshots a draft when it
// opens, so tapping Save after picking a new cover must not revert to the
// old cover (the draft's stale copy used to win via Object.assign).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const harness = require('./harness');

function buildDom() {
  const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };
  // v225: apiFetch() asks cloudClient() for the session JWT first; without a
  // stub the Supabase lib script never finishes loading under JSDOM and the
  // lookup hangs. No session here — the cover path falls back to plain fetch.
  window.__sbStub = { auth: { getSession: async () => ({ data: { session: null } }) } };
  harness.loadApp(window);
  return window;
}

const runInWindow = (window, js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
const probe = (window, js) => { runInWindow(window, 'window.__probe = (' + js + ');'); return window.__probe; };
const tick = (n) => new Promise(r => { let i = 0; const step = () => (++i >= (n || 3) ? r() : setTimeout(step, 20)); step(); });

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL - ' + name); }
}

(async () => {
  const window = buildDom();
  await tick();
  // A book with an old cover; open the real detail modal (draft snapshots here).
  runInWindow(window, `
    library.push({ id: 'cb1', title: 'Kill Decision', authors: ['A'], cover: 'old.jpg',
      status: 'tbr', owned: 'owned', ratings: {}, tropes: [], tropesAuto: [], axes: [],
      log: [], quotes: [], contentWarnings: [], moods: [] });
    bookSnapshots.set('cb1', bookSnap(library[0]));
    openDetail('cb1');
  `);
  await tick(6);
  ok(!!window.document.getElementById('m-save'), 'detail modal opened with a Save button');

  // Pick a new cover through the real picker path while the modal is open.
  runInWindow(window, `chooseCover('cb1', 'new.jpg');`);
  await tick(3);
  ok(probe(window, `library.find(b => b.id === 'cb1').cover`) === 'new.jpg',
    'cover picker updates the live book');

  // Now tap the modal's real Save button.
  window.document.getElementById('m-save').click();
  await tick(4);
  const after = probe(window, `library.find(b => b.id === 'cb1').cover`);
  ok(after === 'new.jpg', 'modal Save keeps the picked cover (got ' + after + ')');

  // And the modal is closed after saving.
  ok(!window.document.getElementById('m-save'), 'modal closed after Save');

  console.log(`\ncover-modal-save: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
