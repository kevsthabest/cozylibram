// Auth gate + per-user on-device libraries (v30): the app opens on a sign-in
// gate when cloud sync is configured; each user gets a partitioned local
// library; sign-out returns to the gate without leaking books between users.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in auth tests'); };
// Backend configured BEFORE boot so the gate path is exercised.
window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };

function makeFake() {
  const store = [];
  const fake = {
    store, user: null, _cb: null,
    auth: {
      getSession: async () => ({ data: { session: fake.user ? { user: fake.user } : null } }),
      signUp: async ({ email }) => { fake.user = { id: 'u-' + email, email }; return { data: { session: { user: fake.user } }, error: null }; },
      signInWithPassword: async ({ email }) => { fake.user = { id: 'u-' + email, email }; return { data: { session: { user: fake.user } }, error: null }; },
      signOut: async () => { fake.user = null; return { error: null }; },
      signInWithOAuth: async () => ({ data: {}, error: null }),
      onAuthStateChange: (cb) => { fake._cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: () => ({
      upsert: async (rows) => {
        for (const r of rows) {
          const i = store.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
          const rec = Object.assign({}, r);
          if (i >= 0) store[i] = rec; else store.push(rec);
        }
        return { error: null };
      },
      // RLS-faithful: a signed-in user only ever sees their own rows.
      select: async () => ({ data: store.filter(r => fake.user && r.user_id === fake.user.id).map(r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data })), error: null }),
      delete: () => ({ eq: async (col, val) => { for (let i = store.length - 1; i >= 0; i--) if (store[i][col] === val) store.splice(i, 1); return { error: null }; } }),
    }),
    fire: (event, user) => { fake.user = user || null; fake._cb(event, user ? { user } : null); },
  };
  return fake;
}
window.__sbStub = makeFake();
window.isSecureContext = true; // jsdom doesn't implement it; real localhost is a secure context

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
const tick = (n) => new Promise(r => { let i = 0; const step = () => (++i >= (n || 3) ? r() : setTimeout(step, 20)); step(); });
const probe = (js) => { runInWindow('window.__probe = (' + js + ');'); return window.__probe; };
const lsGet = (k) => window.localStorage.getItem(k);
const lsBooks = (k) => { try { return JSON.parse(lsGet(k)) || []; } catch (e) { return []; } };

(async () => {
  await tick();

  ok('gate shown when signed out', !!q('#gate-signin') && !!q('#gate-signup') && !!q('#gate-email'));
  ok('gate has Google button on secure localhost', !!q('#gate-google'));
  ok('bottom nav hidden on gate', q('.bottom-nav').style.display === 'none');
  ok('legacy storage key while signed out', probe('libKey()') === 'spicyshelves.library.v1');

  // Continue offline → library, no gate; choice persists; nav restored.
  q('#gate-offline').click();
  await tick();
  ok('offline choice opens library', !q('#gate-signin') && !!q('#view .toolbar'));
  ok('offline flag persisted', lsGet('spicyshelves.offline') === '1');
  ok('nav restored after leaving gate', q('.bottom-nav').style.display === '');

  // Back to the gate after clearing the flag (simulates next launch).
  runInWindow("localStorage.removeItem('spicyshelves.offline'); boot();");
  await tick();
  ok('gate returns when offline flag cleared', !!q('#gate-signin'));

  // Sign in with an existing offline library → adopted into the per-user slot.
  runInWindow(`
    localStorage.setItem('spicyshelves.library.v1',
      JSON.stringify([{ id: 'b1', title: 'Offline Book', authors: ['A U Thor'], status: 'tbr' }]));
    library = loadLibrary();
  `);
  window.__sbStub.fire('SIGNED_IN', { id: 'user-1', email: 'wife@example.com' });
  await tick(6);
  ok('signed in → library view', !q('#gate-signin') && !!q('#view .toolbar'));
  ok('per-user storage key active', probe('libKey()') === 'spicyshelves.library.v2.user-1');
  ok('offline books adopted to user library', probe('library.some(b => b.id === "b1")') === true);
  ok('legacy key removed after adoption', lsGet('spicyshelves.library.v1') === null);
  ok('books persisted under per-user key', lsBooks('spicyshelves.library.v2.user-1').some(b => b.id === 'b1'));
  ok('cloud received the books', window.__sbStub.store.some(r => r.user_id === 'user-1' && r.book_id === 'b1'));

  // Sign out → gate, memory cleared, per-user data kept on device.
  await window.cloudSignOut();
  await tick();
  ok('gate shown after sign-out', !!q('#gate-signin'));
  ok('in-memory library cleared', probe('library.length') === 0);
  ok('per-user books kept on device', lsBooks('spicyshelves.library.v2.user-1').some(b => b.id === 'b1'));

  // Second user → clean shelf; first user's data untouched.
  window.__sbStub.fire('SIGNED_IN', { id: 'user-2', email: 'friend@example.com' });
  await tick(6);
  ok('second user starts with empty shelf', probe('library.length') === 0);
  ok('second user has own storage key', probe('libKey()') === 'spicyshelves.library.v2.user-2');
  ok('first user shelf untouched', lsBooks('spicyshelves.library.v2.user-1').some(b => b.id === 'b1'));

  // Sign back in as user-1 → shelf restored from the per-user slot.
  await window.cloudSignOut();
  window.__sbStub.fire('SIGNED_IN', { id: 'user-1', email: 'wife@example.com' });
  await tick(6);
  ok('first user shelf restored on re-sign-in', probe('library.some(b => b.id === "b1")') === true);

  // No backend configured → no gate, classic behavior.
  await window.cloudSignOut();
  runInWindow('delete window.SPICY_CONFIG;');
  await window.initCloud();
  runInWindow('boot();');
  await tick();
  ok('no gate without backend config', !q('#gate-signin') && !!q('#view .toolbar'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
