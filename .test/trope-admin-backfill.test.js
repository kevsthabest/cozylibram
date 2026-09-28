/* v159 admin all-libraries backfill tests: the SQL admin-read policy, the
   persisted admin book projection, book_key dedup across users, the queue
   resolver chain (local library first, admin projection fallback), and
   queue reset clearing the projection.
   Run: node .test/trope-admin-backfill.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}

(async () => {
  /* ---- 1. SQL: admin read policy on books ---- */
  {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'tropes.sql'), 'utf8');
    ok('tropes.sql has the admin read policy on books',
      sql.includes('create policy "admins read all books" on books'));
    ok('policy is select-only via the is_admin() check',
      /for select using \(is_admin\(\)\)/.test(sql));
    ok('policy notes the analytics.sql dependency',
      sql.includes('supabase/analytics.sql'));
  }

  const memStore = {};
  const ctx = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
    localStorage: {
      getItem: k => (k in memStore ? memStore[k] : null),
      setItem: (k, v) => { memStore[k] = String(v); },
      removeItem: k => { delete memStore[k]; },
    },
    esc: s => String(s),
    SPICY_CONFIG: {},
    library: [],
    localUid: 'admin-1',
    cloudClient: async () => null,
    fetch: async () => { throw new Error('no network in tests'); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  const load = f => vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
  load('156-trope-taxonomy.js');
  load('157-trope-inference.js');

  const probe = src => vm.runInContext(src, ctx);
  const ADMIN_KEY = 'cozylibram.tropeadminbooks.v1';
  const reset = () => {
    Object.keys(memStore).forEach(k => delete memStore[k]);
    probe('tropeAdminBookCache = null;');
  };

  /* ---- 2. book_key dedups the same book across users ---- */
  {
    const k1 = probe(`bookKeyFor({ title: 'Iron Flame', authors: ['Rebecca Yarros'], isbn: '9781649374189' })`);
    const k2 = probe(`bookKeyFor({ title: 'Iron Flame (special edition)', authors: ['Rebecca Yarros'], isbn: '978-1-64937-418-9' })`);
    ok('same ISBN, different user rows -> same book_key', k1 === k2 && k1 === 'isbn:9781649374189');
    const k3 = probe(`bookKeyFor({ title: 'Iron Flame', authors: ['Rebecca Yarros'] })`);
    const k4 = probe(`bookKeyFor({ title: 'iron flame', authors: ['rebecca yarros'] })`);
    ok('same title/author without ISBN -> same t: key', k3 === k4 && k3.indexOf('t:') === 0);
  }

  /* ---- 3. admin projection round-trip ---- */
  {
    reset();
    probe(`tropeAdminBooksSave([
      { key: 'isbn:9781234567890', book: { title: 'Shared Book', authors: ['A. Uthor'], isbn: '9781234567890' } },
      { key: 't:other:writer', book: { title: 'Other', authors: ['Writer'] } },
    ])`);
    ok('projection persists to localStorage',
      JSON.parse(memStore[ADMIN_KEY]).length === 2);
    const t = probe(`tropeAdminBookById('isbn:9781234567890')`);
    ok('byId returns the projected book', t && t.title === 'Shared Book');
    ok('byId misses unknown keys', probe(`tropeAdminBookById('isbn:000')`) === null);
    probe('tropeAdminBooksClear()');
    ok('clear empties the projection',
      !(ADMIN_KEY in memStore) && probe(`tropeAdminBookById('isbn:9781234567890')`) === null);
  }

  /* ---- 4. resolver chain: local library first, admin projection fallback ---- */
  {
    reset();
    probe(`library = [{ id: 'local-1', title: 'Local Book', authors: ['Local Author'] }]`);
    probe(`tropeAdminBooksSave([
      { key: 'isbn:9781234567890', book: { title: 'Shared Book', authors: ['A. Uthor'], isbn: '9781234567890' } },
    ])`);
    probe('ensureTropeQueueWired()');
    const local = probe(`TropeQueue._resolveBook('local-1')`);
    ok('local library id resolves locally', local && local.title === 'Local Book');
    const shared = probe(`TropeQueue._resolveBook('isbn:9781234567890')`);
    ok('book_key resolves via the admin projection', shared && shared.title === 'Shared Book');
    ok('unknown id resolves null', probe(`TropeQueue._resolveBook('nope')`) === null);
    /* Local wins if both could match (same logical book, local copy richer). */
    probe(`library = [{ id: 'isbn:9781234567890', title: 'Local Rich Copy', authors: ['A. Uthor'], isbn: '9781234567890' }]`);
    const both = probe(`TropeQueue._resolveBook('isbn:9781234567890')`);
    ok('local library wins over the projection', both && both.title === 'Local Rich Copy');
  }

  /* ---- 5. queue reset clears the admin projection ---- */
  {
    reset();
    probe(`tropeAdminBooksSave([{ key: 'isbn:9781234567890', book: { title: 'Shared Book' } }])`);
    probe('TropeQueue.reset()');
    ok('reset clears the persisted projection',
      !(ADMIN_KEY in memStore) && probe(`tropeAdminBookById('isbn:9781234567890')`) === null);
  }

  /* ---- 6. projection books carry what inference needs ---- */
  {
    const key = probe(`bookKeyFor({ title: 'T', authors: ['A'], isbn: '', categories: ['romance'], description: 'd' })`);
    ok('minimal projection still keys deterministically', typeof key === 'string' && key.indexOf('t:') === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
