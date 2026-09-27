// Cloud sync tests: config precedence, merge logic, _mtime stamping,
// and a full push/pull/wipe round-trip against a fake Supabase client.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in cloud tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const waitFor = async (key) => {
  for (let i = 0; i < 100 && window[key] === undefined; i++)
    await new Promise(r => setTimeout(r, 20));
};

function makeFake() {
  const store = [];
  const deleted = [];
  const fake = {
    store,
    deleted,
    user: { id: 'user-1', email: 'wife@example.com' },
    auth: {
      getUser: async () => ({ data: { user: fake.user } }),
      getSession: async () => ({ data: { session: fake.user ? { user: fake.user } : null } }),
      signUp: async ({ email }) => { fake.user = { id: 'user-1', email }; return { data: { session: { user: fake.user } }, error: null }; },
      signInWithPassword: async ({ email }) => { fake.user = { id: 'user-1', email }; return { data: { session: { user: fake.user } }, error: null }; },
      signOut: async () => { fake.user = null; return { error: null }; },
      signInWithOAuth: async () => ({ data: { url: 'https://oauth' }, error: null }),
      onAuthStateChange: (cb) => { fake._cb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: (table) => {
      if (table === 'deleted_books') return {
        upsert: async (rows) => {
          for (const r of rows) {
            const i = deleted.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
            if (i >= 0) deleted[i] = r; else deleted.push(r);
          }
          return { error: null };
        },
        select: async () => ({ data: deleted.map(r => ({ book_id: r.book_id })), error: null }),
      };
      return {
      upsert: async (rows) => {
        for (const r of rows) {
          const i = store.findIndex(x => x.user_id === r.user_id && x.book_id === r.book_id);
          const rec = Object.assign({}, r, { updated_at: new Date().toISOString() });
          if (i >= 0) store[i] = rec; else store.push(rec);
        }
        return { error: null };
      },
      select: (cols) => require('./harness').chainableSelect(store,
        r => ({ book_id: r.book_id, isbn: r.isbn, data: r.data })),
      delete: () => ({
        eq: async (col, val) => {
          for (let i = store.length - 1; i >= 0; i--) if (store[i][col] === val) store.splice(i, 1);
          return { error: null };
        }
      }),
      };
    },
  };
  return fake;
}

(async () => {
  // 1. bookToRow mapping
  const row = window.bookToRow({ id: 'b1', isbn: '978123', title: 'T' }, 'u9');
  ok('bookToRow maps fields', row.user_id === 'u9' && row.book_id === 'b1' && row.isbn === '978123' && row.data.title === 'T');
  ok('bookToRow nulls missing isbn', window.bookToRow({ id: 'b2' }, 'u9').isbn === null);

  // 2. merge logic
  let local = [{ id: 'a', title: 'Old', _mtime: 10 }];
  let changed = window.mergeCloudBooks(local, [
    { book_id: 'a', data: { id: 'a', title: 'New', _mtime: 20 } },
    { book_id: 'b', data: { id: 'b', title: 'B', _mtime: 5 } },
  ]);
  ok('merge adds remote-only books', local.some(b => b.id === 'b'));
  ok('merge prefers newer remote', local.find(b => b.id === 'a').title === 'New');
  ok('merge reports change', changed === true);

  local = [{ id: 'a', title: 'Mine', _mtime: 30 }];
  changed = window.mergeCloudBooks(local, [{ book_id: 'a', data: { id: 'a', title: 'Theirs', _mtime: 20 } }]);
  ok('merge keeps newer local', local[0].title === 'Mine' && changed === false);

  local = [{ id: 'a', title: 'Mine', _mtime: 10 }];
  window.mergeCloudBooks(local, [{ book_id: 'a', data: { id: 'a', title: 'Theirs', _mtime: 10 } }]);
  ok('merge tie keeps local', local[0].title === 'Mine');

  changed = window.mergeCloudBooks(local, [null, { no_id: 1 }]);
  ok('merge skips malformed rows', changed === false);

  // 3. config precedence
  window.localStorage.removeItem('sb_url'); window.localStorage.removeItem('sb_key');
  delete window.SPICY_CONFIG;
  ok('cloud off when unconfigured', window.cloudConfigured() === false);
  window.SPICY_CONFIG = { supabaseUrl: 'https://srv.supabase.co', supabaseAnonKey: 'srvkey' };
  ok('server config used on LAN', window.cloudCfg().url === 'https://srv.supabase.co' && window.cloudConfigured());
  window.localStorage.setItem('sb_url', 'https://man.supabase.co');
  window.localStorage.setItem('sb_key', 'mankey');
  ok('stale manual config ignored', window.cloudCfg().url === 'https://srv.supabase.co');
  window.localStorage.removeItem('sb_url'); window.localStorage.removeItem('sb_key');

  // 4. _mtime stamping: only changed books get stamped
  runInWindow(`
    library = []; bookSnapshots.clear();
    library.push({ id: 'm1', title: 'A' });
    saveLibrary({ noCloud: true });
    window.__m1 = library[0]._mtime;
    var __before = library[0]._mtime;
    saveLibrary({ noCloud: true });
    window.__mSame = (library[0]._mtime === __before);
    library[0].title = 'B';
    saveLibrary({ noCloud: true });
    window.__mBumped = (library[0]._mtime >= __before);
    library = []; bookSnapshots.clear(); saveLibrary({ noCloud: true });
  `);
  await waitFor('__mBumped');
  ok('new book gets _mtime', window.__m1 > 0);
  ok('unchanged book keeps _mtime', window.__mSame === true);
  ok('changed book gets fresh _mtime', window.__mBumped === true);

  // 5. full round-trip against fake Supabase
  window.__sbStub = makeFake();
  runInWindow(`(async () => {
    var results = {};
    try {
      cloudUser = window.__sbStub.user;
      library = []; bookSnapshots.clear();
      library.push({ id: 'l1', title: 'Local One', isbn: '111', _mtime: 100 });
      results.pushOk = await cloudPushNow();
      results.storeAfterPush = window.__sbStub.store.length;
      results.rowUser = window.__sbStub.store[0].user_id;
      // remote-only book + remote-newer edit of l1
      window.__sbStub.store.push({ user_id: 'user-1', book_id: 'r1', isbn: null,
        data: { id: 'r1', title: 'Remote One', _mtime: 200 } });
      var lrow = window.__sbStub.store.find(function(r){ return r.book_id === 'l1'; });
      lrow.data = Object.assign({}, lrow.data, { title: 'REMOTE EDIT', _mtime: 999 });
      library = []; bookSnapshots.clear();
      await cloudFirstSync();
      results.afterSyncLen = library.length;
      results.conflictTitle = (library.find(function(b){ return b.id === 'l1'; }) || {}).title;
      results.remoteAdded = !!library.find(function(b){ return b.id === 'r1'; });
      await cloudWipe();
      results.storeAfterWipe = window.__sbStub.store.length;
      library = []; bookSnapshots.clear(); saveLibrary({ noCloud: true });
    } catch (e) { results.error = String((e && e.stack) || e); }
    window.__cloudResults = results;
  })();`);
  await waitFor('__cloudResults');
  const r = window.__cloudResults;
  ok('round-trip ran without errors', !r.error);
  if (r.error) console.log('   ' + r.error);
  ok('push uploads local books', r.pushOk === true && r.storeAfterPush === 1);
  ok('rows scoped to user', r.rowUser === 'user-1');
  ok('pull merges remote books', r.afterSyncLen === 2 && r.remoteAdded === true);
  ok('newer remote wins conflict', r.conflictTitle === 'REMOTE EDIT');
  ok('wipe clears cloud rows', r.storeAfterWipe === 0);

  // 5b. v101: the pull is scoped to the signed-in user. v96's friend-readable
  // RLS plus the old unfiltered select merged friends' shared books into the
  // local library after adding a friend (and pushed them back as own rows).
  window.__sbStub.store.push({ user_id: 'user-1', book_id: 'own1', isbn: null,
    data: { id: 'own1', title: 'Mine', _mtime: 1 } });
  window.__sbStub.store.push({ user_id: 'user-2', book_id: 'fr1', isbn: null,
    data: { id: 'fr1', title: 'Friend Book', _mtime: 1 } });
  runInWindow(`(async () => { try { window.__pulled = (await cloudPullRows()).map(r => r.book_id); } catch (e) { window.__pulled = 'ERR:' + e; } })();`);
  await waitFor('__pulled');
  ok('pull scoped to own user_id', JSON.stringify(window.__pulled) === '["own1"]');

  // 5c. v101: one-time repair removes books leaked from friends' shelves.
  // A polluted book shares its id with a friend's book; genuine copies
  // (+ TBR, manual adds) always get fresh ids, so same-title books survive.
  runInWindow(`(async () => {
    try {
      window.__origCircleLists = circleLists;
      window.__origCircleFriendBooks = circleFriendBooks;
      circleLists = async () => ({ friends: [{ id: 'friend-1', name: 'Pal' }] });
      circleFriendBooks = async () => [{ id: 'f1', title: 'Friend Book', _mtime: 5 }];
      localStorage.removeItem('spicyshelves.depollute.v1');
      library = [
        { id: 'f1', title: 'Friend Book', _mtime: 5 },
        { id: 'mine1', title: 'My Only Book', _mtime: 50 },
        { id: 'mine2', title: 'Friend Book', _mtime: 60 },
      ];
      bookSnapshots.clear(); tombstones = [];
      await repairFriendPollution();
      window.__repairLib = library.map(b => b.id);
      window.__repairTomb = tombstones.map(t => t.id);
      window.__repairFlag = localStorage.getItem('spicyshelves.depollute.v1');
      // second run is a no-op even with a new leaked id present
      library.push({ id: 'f2', title: 'Another Leak', _mtime: 5 });
      await repairFriendPollution();
      window.__repairLib2 = library.map(b => b.id);
      circleLists = window.__origCircleLists;
      circleFriendBooks = window.__origCircleFriendBooks;
      library = []; bookSnapshots.clear(); saveLibrary({ noCloud: true });
    } catch (e) { window.__repairErr = String((e && e.stack) || e); }
  })();`);
  await waitFor('__repairLib2');
  ok('repair ran without errors', !window.__repairErr);
  if (window.__repairErr) console.log('   ' + window.__repairErr);
  ok('repair removes leaked friend book', JSON.stringify(window.__repairLib) === '["mine1","mine2"]');
  ok('repair tombstones the removal', JSON.stringify(window.__repairTomb) === '["f1"]');
  ok('repair sets the done flag', window.__repairFlag === '1');
  ok('repair runs only once', JSON.stringify(window.__repairLib2) === '["mine1","mine2","f2"]');

  // 6. account UI states
  window.isSecureContext = true; // jsdom lacks webcrypto; real localhost browsers are secure contexts
  window.renderSettings();
  runInWindow(`cloudUser = null; refreshAccountUI();`);
  ok('signed-out status shown', q('#ac-status').textContent === 'Not signed in.');
  runInWindow(`cloudUser = window.__sbStub.user; refreshAccountUI();`);
  ok('signed-in status shows email', q('#ac-status').textContent.includes('wife@example.com'));
  ok('signed-in panel visible', q('#ac-signedin').style.display !== 'none');
  ok('google button on secure context', !!q('#ac-google'));
  ok('no api-key status lines in settings', !q('#hc-status') && !q('#gb-status') && !q('#ac-cfg'));

  // 7. regression: boot with a non-empty library (TDZ guards)
  // - v9 ship bug: forEach over bookSnapshots before its const declaration crashed the whole app
  // - silent-empty-library bug: loadLibrary() ran before RATING_AXES existed, so any
  //   book without `axes` (old backups) made migrateBook throw and the library load as []
  {
    const dom2 = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
    const w2 = dom2.window;
    w2.localStorage.setItem('spicyshelves.library.v1', JSON.stringify([
      { id: 'x1', title: 'Modern Book', isbn: '123', _mtime: 111, axes: ['spice'], ratings: { spice: 3 } },
      { id: 'x2', title: 'Old Backup Book', _mtime: 222 },
    ]));
    require('./harness').loadApp(w2);
    await new Promise(r => setTimeout(r, 300));
    ok('boots with non-empty library (no TDZ crash)', typeof w2.render === 'function');
    ok('library actually loads (not silently emptied)', w2.eval('library.length') === 2);
    ok('axis-less book gets migrated axes', JSON.stringify(w2.eval('library[1].axes')) === '["spice"]');
    ok('existing _mtime values preserved', w2.eval('library[0]._mtime') === 111);
  }

  // 8. missing-table error becomes an actionable message
  runInWindow(`window.__errMissing = cloudErrMsg(new Error("Could not find the table 'public.books' in the schema cache"));`);
  runInWindow(`window.__errOther = cloudErrMsg(new Error('boom'));`);
  ok('missing books table explains the fix', window.__errMissing.indexOf('schema.sql') >= 0);
  ok('other errors pass through', window.__errOther === 'Cloud sync failed: boom');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
