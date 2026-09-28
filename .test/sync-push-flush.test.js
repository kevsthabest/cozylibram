// v162: the debounced cloud push (2.5s) must not be silently dropped.
// Two drops existed: signing out before the timer fired (the timer later ran
// with cloudUser == null and did nothing), and a push landing while another
// sync was in flight (returned false, never retried). Both lost the change
// with no error — e.g. a cover update that looked saved but reverted after
// clearing site data.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in tests'); };
window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };

function makeFake() {
  const store = [];
  const fake = {
    store, user: null, _cb: null,
    auth: {
      getSession: async () => ({ data: { session: fake.user ? { user: fake.user } : null } }),
      signInWithPassword: async ({ email }) => { fake.user = { id: 'u-' + email, email }; return { data: { session: { user: fake.user } }, error: null }; },
      signOut: async () => { fake.user = null; return { error: null }; },
      onAuthStateChange: (cb) => { fake._cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: (table) => {
      if (table === 'deleted_books') return {
        upsert: async () => ({ error: null }),
        select: () => require('./harness').chainableSelect([], () => ({})),
        delete: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
      };
      return {
        upsert: async (rows) => {
          for (const r of rows) {
            const i = store.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
            const rec = Object.assign({}, r);
            if (i >= 0) store[i] = rec; else store.push(rec);
          }
          return { error: null };
        },
        select: () => require('./harness').chainableSelect(
          store.filter(r => fake.user && r.user_id === fake.user.id),
          r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data })),
        delete: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
      };
    },
    fire: (event, user) => { fake.user = user || null; fake._cb(event, user ? { user } : null); },
  };
  return fake;
}
window.__sbStub = makeFake();
window.isSecureContext = true;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
const probe = (js) => { runInWindow('window.__probe = (' + js + ');'); return window.__probe; };
const tick = (n) => new Promise(r => { let i = 0; const step = () => (++i >= (n || 3) ? r() : setTimeout(step, 20)); step(); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cloudCover = (id) => {
  const r = window.__sbStub.store.find(x => x.book_id === id);
  return r && r.data && r.data.cover;
};

(async () => {
  await tick();
  window.__sbStub.fire('SIGNED_IN', { id: 'u1', email: 'a@b.c' });
  await tick(8);

  // A: sign-out flushes the pending debounced push.
  probe(`library.push({id:'kd', title:'Kill Decision', authors:['Daniel Suarez'], cover:'OLD'}); saveLibrary();`);
  await tick(4);
  probe(`library.find(b => b.id === 'kd').cover = 'NEW'; saveLibrary();`);
  await window.cloudSignOut(); // immediately — the 2.5s timer has not fired
  ok('sign-out flushes the pending push', cloudCover('kd') === 'NEW');
  ok('sign-out still lands on the gate', probe('cloudUser') === null);

  // B: a push that lands mid-sync is retried, not dropped.
  window.__sbStub.fire('SIGNED_IN', { id: 'u1', email: 'a@b.c' });
  await tick(8);
  const fake = window.__sbStub;
  const origFrom = fake.from.bind(fake);
  let releaseUpsert = null;
  fake.from = (table) => {
    const q = origFrom(table);
    if (table === 'books') {
      const origUpsert = q.upsert;
      q.upsert = (rows, opts) => new Promise(res => { releaseUpsert = () => res(origUpsert(rows, opts)); });
    }
    return q;
  };
  const p1 = window.cloudPushNow(); // holds cloudSyncing = true
  await tick(4);
  probe(`library.find(b => b.id === 'kd').cover = 'NEWER'; saveLibrary();`); // schedules a 2.5s push
  await sleep(2800); // debounced push fires while the first sync is still in flight
  releaseUpsert(); // first sync completes
  await p1;
  await sleep(2800); // the retried push fires
  ok('push during an in-flight sync is retried', cloudCover('kd') === 'NEWER');
  fake.from = origFrom;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
