// Realtime sync (v143): subscribing to book + tombstone changes pulls remote
// changes within seconds; stop unsubscribes; rapid events batch into one pull;
// the realtime pull never pushes (no echo loops).
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in realtime tests'); };

const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
function runInWindow(code) { return window.eval(code); }

function makeRealtimeStub() {
  const books = [];   // { user_id, book_id, isbn, data }
  const deleted = []; // { user_id, book_id, deleted_at }
  const bindings = []; // { channel, table, filter, cb }
  const channels = [];
  const removed = [];
  let selectCalls = 0;
  const api = {
    books, deleted, bindings, channels, removed,
    selectCalls: () => selectCalls,
    from: (table) => {
      if (table === 'books') return {
        upsert: async (rows) => {
          for (const r of rows) {
            const i = books.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
            if (i >= 0) books[i] = r; else books.push(r);
          }
          return { error: null };
        },
        select: () => {
          selectCalls++;
          return require('./harness').chainableSelect(books,
            r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data }));
        },
      };
      if (table === 'deleted_books') return {
        upsert: async (rows) => {
          for (const r of rows) {
            const i = deleted.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
            if (i >= 0) deleted[i] = r; else deleted.push(r);
          }
          return { error: null };
        },
        select: (cols) => {
          selectCalls++;
          return require('./harness').chainableSelect(deleted,
            r => ({ book_id: r.book_id, deleted_at: r.deleted_at }));
        },
      };
      throw new Error('unexpected table: ' + table);
    },
    channel: (name) => {
      const ch = {
        name,
        on: (type, params, cb) => { bindings.push({ channel: ch, table: params.table, filter: params.filter, cb }); return ch; },
        subscribe: (statusCb) => { if (statusCb) statusCb('SUBSCRIBED'); return ch; },
      };
      channels.push(ch);
      return ch;
    },
    removeChannel: async (ch) => { removed.push(ch.name); return 'ok'; },
    // simulate a postgres_changes event arriving on every live binding
    fire: (table) => bindings
      .filter(b => b.table === table && !removed.includes(b.channel.name))
      .forEach(b => b.cb({})),
  };
  return api;
}

require('./harness').loadApp(window);

(async () => {
  const stub = makeRealtimeStub();
  window.__sbStub = stub;
  runInWindow(`cloudUser = { id: 'u1', email: 't@t.t' };`);
  runInWindow(`library = []; tombstones = []; saveTombstones(); saveLibrary({noCloud:true});`);

  // 1. start subscribes with the right bindings
  await window.cloudRealtimeStart();
  await tick(50);
  ok('one channel opened', stub.channels.length === 1);
  ok('book binding registered', stub.bindings.some(b => b.table === 'books'));
  ok('tombstone binding registered', stub.bindings.some(b => b.table === 'deleted_books'));
  ok('bindings filtered to this user', stub.bindings.every(b => b.filter === 'user_id=eq.u1'));
  ok('status live after subscribe', window.eval(`rtStatus`) === 'live');

  // 2. a book added on another device arrives via event
  stub.books.push({ user_id: 'u1', book_id: 'n1', isbn: null, data: { id: 'n1', title: 'New', _mtime: 10 } });
  stub.fire('books');
  await tick(2000); // past the 1500ms debounce
  ok('remote book merged after event', window.eval(`library.some(b => b.id === 'n1')`));
  ok('realtime pull never pushes (no echo)', stub.books.length === 1 && stub.deleted.length === 0);

  // 3. a deletion on another device arrives via event
  stub.deleted.push({ user_id: 'u1', book_id: 'n1', deleted_at: new Date().toISOString() });
  stub.fire('deleted_books');
  await tick(2000);
  ok('remote deletion applied', window.eval(`!library.some(b => b.id === 'n1')`));
  ok('tombstone recorded locally', window.eval(`tombstones.some(t => t.id === 'n1')`));

  // 4. rapid events batch into a single pull
  stub.books.push({ user_id: 'u1', book_id: 'n2', isbn: null, data: { id: 'n2', title: 'N2', _mtime: 10 } });
  stub.books.push({ user_id: 'u1', book_id: 'n3', isbn: null, data: { id: 'n3', title: 'N3', _mtime: 10 } });
  const c0 = stub.selectCalls();
  stub.fire('books'); stub.fire('books'); stub.fire('books');
  await tick(2000);
  ok('batched: one pull for three events', stub.selectCalls() - c0 === 2); // tombstones + books selects
  ok('all batched books merged', window.eval(`library.some(b => b.id === 'n2') && library.some(b => b.id === 'n3')`));

  // 5. stop unsubscribes; later events are ignored
  await window.cloudRealtimeStop();
  ok('channel removed on stop', stub.removed.length === 1 && stub.removed[0] === stub.channels[0].name);
  ok('status off after stop', window.eval(`rtStatus`) === 'off');
  stub.books.push({ user_id: 'u1', book_id: 'n4', isbn: null, data: { id: 'n4', title: 'N4', _mtime: 10 } });
  stub.fire('books');
  await tick(2000);
  ok('no pull after stop', window.eval(`!library.some(b => b.id === 'n4')`));

  // 6. start is idempotent — restarting replaces the old channel
  await window.cloudRealtimeStart();
  await tick(50);
  await window.cloudRealtimeStart();
  await tick(50);
  ok('restart opens a fresh channel', stub.channels.length === 3);
  ok('old channel removed on restart', stub.removed.length === 2 && stub.removed[1] === stub.channels[1].name);
  await window.cloudRealtimeStop();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
