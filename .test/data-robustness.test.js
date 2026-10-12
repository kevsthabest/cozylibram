// v494 data-robustness batch (#126, #129, #130, #133, #134):
// sync timeouts, _mtime tiebreak determinism, slot-switch ordering,
// AppLog persistence throttle, malformed metacache fetched_at.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.BOOKTOK_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function buildDom() {
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
  const window = dom.window;
  window.fetch = async () => { throw new Error('no network in tests'); };
  window.SPICY_CONFIG = { supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'anon-key' };
  require('./harness').loadApp(window);
  return window;
}

let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (window, js) => { const s = window.document.createElement('script'); s.textContent = js; window.document.body.appendChild(s); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- #129: _mtime tiebreak is deterministic and converges ----------
  {
    const window = buildDom();
    const mk = (title) => window.migrateBook({ id: 'b1', title, authors: ['A'], status: 'tbr', _mtime: 1000 });
    const recA = mk('Alpha Title'), recB = mk('Beta Title');
    const clone = (o) => JSON.parse(JSON.stringify(o));
    // direction 1: local=A, remote=B
    const local1 = [clone(recA)];
    const ch1 = window.mergeCloudBooks(local1, [{ book_id: 'b1', data: clone(recB) }]);
    // direction 2: local=B, remote=A — must pick the SAME winner
    const local2 = [clone(recB)];
    const ch2 = window.mergeCloudBooks(local2, [{ book_id: 'b1', data: clone(recA) }]);
    ok(local1[0].title === local2[0].title,
      'tiebreak converges: both sides pick "' + local1[0].title + '"');
    // direction 2 started with the converged winner locally, so correctly no-ops
    ok(ch1 === true && ch2 === false, 'remote-wins reports changed; converged local is a no-op');
    // identical records on tie: no-op
    const same = [clone(recA)];
    const chSame = window.mergeCloudBooks(same, [{ book_id: 'b1', data: clone(recA) }]);
    ok(chSame === false && same[0].title === 'Alpha Title', 'identical records on tie: no change');
    // zero _mtime on both sides: legacy behavior kept (local wins, no tiebreak)
    const zloc = [window.migrateBook({ id: 'b2', title: 'Local Zero', authors: [] })];
    const chz = window.mergeCloudBooks(zloc, [{ book_id: 'b2', data: { id: 'b2', title: 'Remote Zero', authors: [] } }]);
    ok(chz === false && zloc[0].title === 'Local Zero', 'missing _mtime on both sides keeps local (no tiebreak)');
    // strictly-greater still wins outright
    const gloc = [window.migrateBook({ id: 'b3', title: 'Old', authors: [], _mtime: 5 })];
    const chg = window.mergeCloudBooks(gloc, [{ book_id: 'b3', data: { id: 'b3', title: 'New', authors: [], _mtime: 9 } }]);
    ok(chg === true && gloc[0].title === 'New', 'newer _mtime still wins outright');
    // stableJson is key-order independent (incl. nested)
    const s1 = window.stableJson({ b: 2, a: 1, n: { y: 1, x: [3, 2] } });
    const s2 = window.stableJson({ a: 1, n: { x: [3, 2], y: 1 }, b: 2 });
    ok(s1 === s2, 'stableJson ignores key insertion order');
  }

  // ---------- #134: malformed fetched_at reads as stale ----------
  {
    const window = buildDom();
    const rows = [
      { isbn: '9780000000001', data: { title: 'Bad Date' }, fetched_at: 'not-a-date' },
      { isbn: '9780000000002', data: { title: 'Empty Date' }, fetched_at: '' },
      { isbn: '9780000000003', data: { title: 'Fresh' }, fetched_at: new Date().toISOString() },
      { isbn: '9780000000004', data: { title: 'Old' }, fetched_at: new Date(Date.now() - 31 * 864e5).toISOString() },
    ];
    window.__sbStub = {
      from: (t) => {
        if (t !== 'book_meta') throw new Error('unexpected table ' + t);
        return { select: () => ({ eq: (c, v) => ({ maybeSingle: async () => {
          const r = rows.find(x => x.isbn === v);
          return r ? { data: { data: r.data, fetched_at: r.fetched_at }, error: null }
                   : { data: null, error: null };
        }})}) };
      }
    };
    runInWindow(window, 'cloudUser = { id: "u1" };');
    ok(await window.metaCacheGet('9780000000001') === null, 'unparseable fetched_at → stale (null)');
    ok(await window.metaCacheGet('9780000000002') === null, 'empty fetched_at → stale (null)');
    const fresh = await window.metaCacheGet('9780000000003');
    ok(fresh && fresh.title === 'Fresh', 'valid recent fetched_at → cache hit');
    ok(await window.metaCacheGet('9780000000004') === null, '31-day-old fetched_at → stale (null)');
    ok(await window.metaCacheGet('9780000000009') === null, 'cache miss → null');
  }

  // ---------- #133: AppLog persistence is throttled, flushed on pagehide ----------
  // (jsdom's Storage methods are non-writable, so instead of spying on
  // setItem we assert on the persisted payload itself.)
  {
    const window = buildDom();
    const KEY = 'cozylibram.applog.v1';
    runInWindow(window, 'AppLog.clear();');
    ok(window.localStorage.getItem(KEY) === null, 'clear() removes the stored log');
    runInWindow(window, `for (let i = 0; i < 5; i++) AppLog.info('t', 'm' + i);`);
    const afterRapid = JSON.parse(window.localStorage.getItem(KEY));
    ok(afterRapid.length === 1 && afterRapid[0].msg === 'm0',
      '5 rapid writes → 1 persisted entry (throttled), got ' + (afterRapid && afterRapid.length));
    ok(window.eval('AppLog.entries().length') === 5, 'all 5 entries kept in memory');
    ok(window.eval('AppLog._persistPending') === true, '_persistPending set while throttled');
    runInWindow(window, 'AppLog._flush();');
    const afterFlush = JSON.parse(window.localStorage.getItem(KEY));
    ok(afterFlush.length === 5 && afterFlush.some(e => e.msg === 'm4'),
      'explicit _flush() persists everything');
    ok(window.eval('AppLog._persistPending') === false, '_persistPending cleared by flush');
    runInWindow(window, `AppLog.info('t', 'before-unload');`);
    window.dispatchEvent(new window.Event('pagehide'));
    const afterHide = JSON.parse(window.localStorage.getItem(KEY));
    ok(afterHide.length === 6 && afterHide.some(e => e.msg === 'before-unload'),
      'pagehide flushes the throttled-pending entry');
  }

  // ---------- #126: hung sync push aborts and resets cloudSyncing ----------
  {
    const window = buildDom();
    // abortSignal-aware hanging upsert: never resolves on its own, rejects on abort
    const hangingUpsert = () => {
      const b = {
        abortSignal(sig) { b._sig = sig; return b; },
        then(resolve, reject) {
          if (b._sig) b._sig.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
        }
      };
      return b;
    };
    window.__sbStub = {
      auth: { getSession: async () => ({ data: { session: null } }) },
      from: (t) => {
        if (t === 'books') return {
          upsert: hangingUpsert,
          delete: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
        };
        return { upsert: async () => ({ error: null }) };
      }
    };
    runInWindow(window, 'cloudUser = { id: "u1" };');
    runInWindow(window, 'library = [{ id: "b1", title: "T", authors: ["A"], _mtime: 5 }];');
    runInWindow(window, 'NET_TIMEOUT_MS = 80;');
    const t0 = Date.now();
    const res = await window.cloudPushNow();
    const dt = Date.now() - t0;
    ok(res === false, 'hung push settles as failure instead of hanging forever');
    ok(dt < 5000, 'hung push settled in ' + dt + 'ms (timeout fired)');
    ok(window.eval('cloudSyncing') === false, 'cloudSyncing reset after abort');
    runInWindow(window, 'NET_TIMEOUT_MS = 30000;');
    // normal (fast) path still works through the abortable wrapper
    window.__sbStub.from = (t) => ({
      upsert: async () => ({ error: null }),
      delete: () => ({ eq: () => ({ in: () => Promise.resolve({ error: null }) }) }),
    });
    const res2 = await window.cloudPushNow();
    ok(res2 === true, 'fast push still succeeds through the abort wrapper');
    ok(window.eval('cloudSyncing') === false, 'cloudSyncing false after successful push');
  }

  // ---------- #126: apiFetch + enrichRatings time out on hung network ----------
  {
    const window = buildDom();
    window.__sbStub = { auth: { getSession: async () => ({ data: { session: null } }) } };
    window.fetch = (url, init) => new Promise((_, reject) => {
      const sig = init && init.signal;
      if (!sig) return; // hang forever without a signal (shouldn't happen)
      if (sig.aborted) return reject(new Error('already aborted'));
      sig.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
    });
    runInWindow(window, 'NET_TIMEOUT_MS = 80;');
    let threw = null;
    const t0 = Date.now();
    try { await window.apiFetch('/api/ping'); } catch (e) { threw = e; }
    ok(!!threw, 'apiFetch rejects on hung network (timeout fired)');
    ok(Date.now() - t0 < 5000, 'apiFetch settled promptly');
    const book = { isbn: '', title: 'Some Title', authors: ['Some Author'] };
    const out = await window.enrichRatings(book);
    ok(out === book, 'enrichRatings survives a hung lookup (outer catch keeps the book)');
    runInWindow(window, 'NET_TIMEOUT_MS = 30000;');
  }

  // ---------- #130: currentDb flips only after the new slot's state loads ----------
  {
    const window = buildDom();
    runInWindow(window, 'idbDisabled = false; localUid = null;');
    const fakeDb = { name: 'slot-u2' };
    window.__fakeDb = fakeDb;
    const calls = [];
    window.idbOpenSlot = async (uid) => { calls.push('open:' + uid); return fakeDb; };
    window.migrateSlotFromLegacy = async () => { calls.push('migrate'); };
    window.idbPersistSlot = async () => { calls.push('persistSlot'); };
    window.snapshotBooks = () => {};
    let seenDuringLoad = 'unset';
    window.loadSlotState = async () => {
      calls.push('load');
      seenDuringLoad = window.eval('currentDb === window.__fakeDb ? "already-new" : "still-old"');
      window.eval('library = [{ id: "n1", title: "New Slot Book" }];');
    };
    await window.setLocalUserIdb('u2');
    ok(seenDuringLoad === 'still-old',
      'currentDb still points at the old slot while the new slot loads (no wrong-slot window)');
    ok(window.eval('currentDb') === fakeDb, 'currentDb is the new slot db after the switch');
    ok(window.eval('localUid') === 'u2', 'localUid updated');
    ok(JSON.stringify(calls.slice(0, 4)) === JSON.stringify(['persistSlot', 'open:u2', 'migrate', 'load']),
      'switch order: flush old → open → migrate → load (' + calls.join(',') + ')');
    // an in-window save would have targeted the old db: prove the pairing is safe
    ok(window.eval('library')[0].title === 'New Slot Book', 'library holds the new slot books after switch');
  }

  console.log(`\ndata-robustness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
