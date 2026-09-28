// v167: on-device diagnostic log (AppLog) + Observatory Logs tab.
// Covers the ring buffer, level filtering, localStorage persistence across
// reload, the global error/rejection safety net, and the Logs tab render.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const harness = require('./harness');

function buildDom() {
  const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };
  const fake = {
    user: null, _cb: null,
    auth: {
      getSession: async () => ({ data: { session: fake.user ? { user: fake.user } : null } }),
      signOut: async () => { fake.user = null; return { error: null }; },
      onAuthStateChange: (cb) => { fake._cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: () => ({ select: () => harness.chainableSelect([], r => r) }),
    fire: (event, user) => { fake.user = user || null; fake._cb(event, user ? { user } : null); },
  };
  window.__sbStub = fake;
  harness.loadApp(window);
  return { window, fake };
}

const runInWindow = (window, js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
const probe = (window, js) => { runInWindow(window, 'window.__probe = (' + js + ');'); return window.__probe; };
const tick = (n) => new Promise(r => { let i = 0; const step = () => (++i >= (n || 3) ? r() : setTimeout(step, 20)); step(); });

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; /* console.log('  ok - ' + name); */ }
  else { fail++; console.log('  FAIL - ' + name); }
}

(async () => {
  // --- 1: basic write + newest-first ordering ---
  {
    const { window } = buildDom();
    runInWindow(window, `AppLog.clear(); AppLog.info('t','first'); AppLog.warn('t','second'); AppLog.error('t','third');`);
    const levels = probe(window, `AppLog.entries().map(e => e.level).join(',')`);
    ok(levels === 'error,warn,info', 'entries are newest-first (' + levels + ')');
    const e0 = probe(window, `AppLog.entries()[0]`);
    ok(e0.tag === 't' && e0.msg === 'third' && typeof e0.t === 'number', 'entry carries tag, msg, timestamp');
  }

  // --- 2: level filtering (that level and above) ---
  {
    const { window } = buildDom();
    runInWindow(window, `AppLog.clear(); AppLog.info('t','i'); AppLog.warn('t','w'); AppLog.error('t','e');`);
    ok(probe(window, `AppLog.entries('info').length`) === 3, 'info filter shows all');
    ok(probe(window, `AppLog.entries('warn').length`) === 2, 'warn filter shows warn+error');
    ok(probe(window, `AppLog.entries('error').length`) === 1, 'error filter shows errors only');
  }

  // --- 3: ring buffer cap ---
  {
    const { window } = buildDom();
    runInWindow(window, `AppLog.clear(); for (let i = 0; i < 350; i++) AppLog.info('t','m'+i);`);
    ok(probe(window, `AppLog._mem.length`) === 300, 'memory capped at 300');
    ok(probe(window, `AppLog.entries()[299].msg`) === 'm50', 'oldest entries evicted first');
  }

  // --- 4: persistence across reload ---
  {
    const { window } = buildDom();
    runInWindow(window, `AppLog.clear(); AppLog.error('sync','push failed: boom');`);
    const stored = window.localStorage.getItem('cozylibram.applog.v1');
    const parsed = JSON.parse(stored);
    ok(Array.isArray(parsed) && parsed.some(e => e.msg === 'push failed: boom'), 'entries persisted to localStorage');
    // simulate a reload: seed a fresh window's storage before the scripts load
    const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
    const dom2 = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
    dom2.window.localStorage.setItem('cozylibram.applog.v1', stored);
    dom2.window.fetch = async () => { throw new Error('no network in tests'); };
    dom2.window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };
    harness.loadApp(dom2.window);
    const restored = probe(dom2.window, `AppLog.entries().map(e => e.msg).join('|')`);
    ok(/push failed: boom/.test(restored), 'entries restored after reload');
  }

  // --- 5: corrupt storage does not break the log ---
  {
    const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
    const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
    dom.window.localStorage.setItem('cozylibram.applog.v1', 'not-json{{{');
    dom.window.fetch = async () => { throw new Error('no network in tests'); };
    dom.window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };
    let threw = false;
    try { harness.loadApp(dom.window); } catch (e) { threw = true; }
    ok(!threw, 'corrupt stored log does not break script load');
    runInWindow(dom.window, `AppLog.info('t','after-corrupt')`);
    ok(probe(dom.window, `AppLog.entries().length`) === 1, 'log still usable after corrupt storage');
  }

  // --- 6: global error + unhandledrejection safety net ---
  {
    const { window } = buildDom();
    runInWindow(window, `AppLog.clear();`);
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'kaboom', filename: 'http://x/js/090-sync.js', lineno: 12 }));
    await tick();
    const errs = probe(window, `AppLog.entries('error').map(e => e.tag + ':' + e.msg).join('|')`);
    ok(/js:.*kaboom/.test(errs), 'uncaught error captured (' + errs + ')');
    const rej = new window.Event('unhandledrejection');
    rej.reason = new Error('rej-boom');
    window.dispatchEvent(rej);
    await tick();
    const errs2 = probe(window, `AppLog.entries('error').map(e => e.msg).join('|')`);
    ok(/unhandled rejection: rej-boom/.test(errs2), 'unhandled rejection captured');
  }

  // --- 7: logging never throws, even on junk input ---
  {
    const { window } = buildDom();
    let threw = false;
    try {
      runInWindow(window, `AppLog.info(null, undefined); AppLog.warn({}, {toString(){throw new Error('x')}}); AppLog.error('t','x'.repeat(5000));`);
    } catch (e) { threw = true; }
    ok(!threw, 'AppLog is throw-safe on junk input');
    ok(probe(window, `AppLog.entries()[0].msg.length`) <= 500, 'messages are length-capped');
  }

  // --- 8: chooseCover logs the change ---
  {
    const { window } = buildDom();
    await tick();
    runInWindow(window, `AppLog.clear(); library.push({id:'b1', title:'Kill Decision', authors:['A']}); chooseCover('b1', 'https://x/c.jpg');`);
    await tick();
    const cover = probe(window, `AppLog.entries().filter(e => e.tag === 'cover').map(e => e.msg).join('|')`);
    ok(/cover set for "Kill Decision"/.test(cover), 'cover change logged with title (' + cover + ')');
    const sync = probe(window, `AppLog.entries().filter(e => e.tag === 'sync').map(e => e.msg).join('|')`);
    ok(/push scheduled/.test(sync), 'cover save schedules a logged cloud push');
  }

  // --- 9: Logs tab renders in the Observatory ---
  {
    const { window, fake } = buildDom();
    await tick();
    fake.fire('SIGNED_IN', { id: 'u1', email: 'a@b.c' });
    await tick(6);
    runInWindow(window, `isAppAdmin = true; adminTab = 'logs'; AppLog.clear(); AppLog.error('sync','push failed: 503'); AppLog.info('cover','cover set for "X"');`);
    runInWindow(window, `renderAdmin()`);
    await tick(4);
    const body = window.document.getElementById('ob-body');
    ok(body && /push failed: 503/.test(body.textContent), 'log entries render in the Logs tab');
    ok(body && /Errors only/.test(body.textContent), 'level filter buttons render');
    ok(body && /never leave your device/.test(body.textContent), 'on-device privacy note renders');
    // filter down to errors only
    const errBtn = Array.from(body.querySelectorAll('[data-logf]')).find(b => b.dataset.logf === 'error');
    errBtn.click();
    await tick(2);
    ok(/push failed: 503/.test(body.textContent) && !/cover set for/.test(body.textContent), 'Errors-only filter hides info entries');
  }

  console.log(`\napplog: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
