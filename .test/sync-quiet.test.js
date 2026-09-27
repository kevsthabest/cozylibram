// Quiet sync (v144): background syncs stay silent — no toast. A manual
// "Sync now" announces its result. The topbar sync dot is the passive
// activity indicator for pushes, pulls, and realtime events.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in sync-quiet tests'); };

const tick = (ms) => new Promise(r => setTimeout(r, ms === undefined ? 40 : ms));
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok  -', name); }
  else { fail++; console.log('  FAIL-', name); }
}

function makeStub() {
  const books = [], deleted = [], profiles = [];
  function from(table) {
    if (table === 'profiles') {
      return { select() { return { eq() { return { maybeSingle: async () => ({ data: null, error: null }) }; } }; } };
    }
    if (table === 'deleted_books') {
      return { select() { return { eq: async (col, uid) => ({ data: deleted.filter(d => d.user_id === uid), error: null }) }; },
        upsert: async (rows) => { rows.forEach(r => { const i = deleted.findIndex(d => d.user_id === r.user_id && d.book_id === r.book_id); i >= 0 ? deleted[i] = r : deleted.push(r); }); return { error: null }; } };
    }
    if (table === 'books') {
      return {
        upsert: async (rows) => { rows.forEach(r => { const i = books.findIndex(b => b.user_id === r.user_id && b.book_id === r.book_id); i >= 0 ? books[i] = r : books.push(r); }); return { error: null }; },
        select() { return { eq: async (col, uid) => ({ data: books.filter(b => b.user_id === uid), error: null }) }; },
      };
    }
    throw new Error('unexpected table ' + table);
  }
  return { books, deleted, profiles, from, channel() { return { on() { return this; }, subscribe() { return this; } }; }, removeChannel() {} };
}

require('./harness').loadApp(window);

(async () => {
  const stub = makeStub();
  window.__sbStub = stub;
  const toasts = [];
  window.toast = (m) => { toasts.push(String(m)); };
  window.eval(`cloudUser = { id: 'u1', email: 't@t.t' };`);
  window.eval(`library = []; tombstones = []; saveTombstones(); saveLibrary({noCloud:true});`);

  const dot = () => window.document.getElementById('sync-dot');
  const cls = () => dot() ? dot().className : '';

  // 1. The dot is present in the topbar.
  ok('sync dot exists in topbar', !!dot());

  // 2. Boot-style sync (no announce): silent, dot ends idle.
  toasts.length = 0;
  await window.cloudFirstSync();
  await tick(50);
  ok('boot sync toasts nothing', toasts.length === 0);
  ok('dot idle after quiet sync', !cls().includes('on') && !cls().includes('done'));

  // 3. Manual sync with nothing new: announces "up to date".
  toasts.length = 0;
  await window.cloudFirstSync({ announce: true });
  await tick(50);
  ok('manual sync says already up to date', toasts.includes('☁️ Already up to date'));

  // 4. Manual sync with a new remote book: announces the update.
  stub.books.push({ user_id: 'u1', book_id: 'q1', isbn: null,
    data: { id: 'q1', title: 'Q1', _mtime: 10 } });
  toasts.length = 0;
  await window.cloudFirstSync({ announce: true });
  await tick(50);
  ok('manual sync announces updates', toasts.includes('☁️ Library updated'));
  ok('book merged from cloud', window.eval(`library.some(b => b.id === 'q1')`));

  // 5. Dot states cycle directly.
  window.setSyncDot('syncing');
  ok('dot pulses while syncing', cls().includes('on'));
  window.setSyncDot('done');
  ok('dot shows done', cls().includes('done'));
  await tick(2700);
  ok('dot fades back to idle', !cls().includes('on') && !cls().includes('done'));

  // 6. Realtime pull with a change: silent, dot shows done.
  stub.books.push({ user_id: 'u1', book_id: 'q2', isbn: null,
    data: { id: 'q2', title: 'Q2', _mtime: 10 } });
  toasts.length = 0;
  await window.cloudRealtimePull();
  ok('realtime pull merges', window.eval(`library.some(b => b.id === 'q2')`));
  ok('realtime pull toasts nothing', toasts.length === 0);
  ok('dot shows done after realtime change', cls().includes('done'));

  // 7. Realtime pull with nothing new: dot stays idle.
  await tick(2700);
  await window.cloudRealtimePull();
  ok('dot idle when realtime changed nothing', !cls().includes('on') && !cls().includes('done'));

  // 8. Push activity never leaves the dot stuck.
  await window.cloudPushNow();
  await tick(50);
  ok('dot idle after push', !cls().includes('on'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
