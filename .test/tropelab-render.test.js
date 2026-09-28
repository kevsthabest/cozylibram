// v162: Trope Lab must finish rendering the coverage scan. v159 introduced
// `tropeLabLastRows = rows` after the coverage try/catch while `rows` was
// declared with `let` *inside* the try block — a ReferenceError that rejected
// renderTropeLab() and left the UI stuck on "Scanning library…" forever.
// Regression: render the lab end-to-end against a DB without the v157/v160
// tables (the live state when the bug was reported) and require the coverage
// card to appear; also cover the catch path (book_tropes query throws).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const harness = require('./harness');

function buildDom(bookTropesImpl) {
  const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key',
    trope: true, tropeProvider: 'openrouter', tropeModel: 'x' };

  // PostgREST-style 404 for tables missing from the schema cache
  // (taxonomy_meta, trope_provider_settings before tropes.sql is re-run).
  const missingTable = (table) => ({
    select() {
      const b = {
        eq() { return b; }, limit() { return b; }, maybeSingle() { return b; },
        then(resolve) {
          return Promise.resolve({ data: null,
            error: { code: '42P01', message: "Could not find the table 'public." + table + "' in the schema cache" } })
            .then(resolve);
        },
      };
      return b;
    },
  });

  const tropeRows = [];
  for (let i = 0; i < 84; i++) tropeRows.push({ id: 'trope-' + i, name: 'Trope ' + i, description: 'd', genres: [] });

  const fake = {
    user: null, _cb: null,
    auth: {
      getSession: async () => ({ data: { session: fake.user ? { user: fake.user } : null } }),
      signOut: async () => { fake.user = null; return { error: null }; },
      onAuthStateChange: (cb) => { fake._cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: (table) => {
      if (table === 'app_admins') return { select: () => harness.chainableSelect([{ user_id: 'u1' }], r => r) };
      if (table === 'tropes') return { select: () => harness.chainableSelect(tropeRows, r => r) };
      if (table === 'book_tropes') return bookTropesImpl();
      return missingTable(table);
    },
    fire: (event, user) => { fake.user = user || null; fake._cb(event, user ? { user } : null); },
  };
  window.__sbStub = fake;
  window.isSecureContext = true;
  harness.loadApp(window);
  return { window, fake };
}

const runInWindow = (window, js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
const probe = (window, js) => { runInWindow(window, 'window.__probe = (' + js + ');'); return window.__probe; };
const tick = (n) => new Promise(r => { let i = 0; const step = () => (++i >= (n || 3) ? r() : setTimeout(step, 20)); step(); });

async function renderLab(window, fake) {
  await tick();
  fake.fire('SIGNED_IN', { id: 'u1', email: 'a@b.c' });
  await tick(8);
  runInWindow(window, `adminTab = 'tropes'; isAppAdmin = true;`);
  runInWindow(window, `library.push({id:'b1', title:'Kill Decision', authors:['Daniel Suarez']});`);
  runInWindow(window, 'renderAdmin()');
  let settled = false;
  for (let i = 0; i < 20 && !settled; i++) {
    await tick(5);
    const cov = window.document.getElementById('tropelab-coverage');
    settled = !!cov && !/Scanning library/.test(cov.textContent);
  }
  return settled;
}

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

(async () => {
  // A: missing v157/v160 tables — the live DB state. Coverage must render.
  {
    const { window, fake } = buildDom(() => ({ select: () => harness.chainableSelect([], r => r) }));
    const settled = await renderLab(window, fake);
    const cov = window.document.getElementById('tropelab-coverage');
    ok('coverage scan completes with missing taxonomy_meta/trope_provider_settings tables', settled);
    ok('coverage card shows scanned count', !!cov && /Books scanned/.test(cov.textContent));
    ok('backfill button wired with missing count', !!window.document.getElementById('tl-backfill'));
  }

  // B: book_tropes query throws — the catch path must still render.
  {
    const throwing = () => ({ select: () => { const b = { eq() { return b; }, limit() { return b; },
      then(resolve, reject) { reject(new Error('boom')); } }; return b; } });
    const { window, fake } = buildDom(throwing);
    const settled = await renderLab(window, fake);
    const cov = window.document.getElementById('tropelab-coverage');
    ok('coverage scan completes when the book_tropes query throws', settled);
    ok('error note names the failure', !!cov && /Cloud read failed/.test(cov.textContent));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
