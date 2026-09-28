/* v157 live taxonomy tests: TropeTaxonomy merge semantics, refresh(),
   localStorage cache/offline restore, and the empty-table guard.
   Run: node .test/trope-taxonomy-live.test.js */
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
    localUid: 'user-1',
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

  /* Minimal supabase fake: only what refresh() needs. */
  function fakeClient(db) {
    const table = t => ({
      select() { return this; },
      limit() { return this; },
      eq() { return this; },
      maybeSingle: async () => ({ data: db.meta, error: null }),
      then(res) { return Promise.resolve({ data: db.tropes, error: null }).then(res); },
    });
    return { from: t => table(t) };
  }
  const bundledCount = probe('TROPES.length');

  function reset() {
    probe(`TropeTaxonomy._db = null; TropeTaxonomy._rev = 1; TropeTaxonomy._ready = false;`);
    probe(`localStorage.removeItem('cozylibram.tropetaxonomy.v1')`);
    Object.keys(memStore).forEach(k => delete memStore[k]);
  }

  /* ---- 1. bundled fallback before any refresh ---- */
  {
    reset();
    ok('list() is the bundled taxonomy when never refreshed',
      probe('TropeTaxonomy.list().length') === bundledCount && bundledCount === 84);
    ok('byId falls back to the bundled file',
      probe(`TropeTaxonomy.byId('forced-proximity').name`) === 'Forced Proximity');
    ok('byId misses unknown ids', probe(`TropeTaxonomy.byId('nope')`) === null);
    ok('rev starts at 1', probe('TropeTaxonomy.rev()') === 1);
  }

  /* ---- 2. refresh() adopts the live table + rev ---- */
  {
    reset();
    const db = {
      tropes: [
        { id: 'mafia-princess', name: 'Mafia Princess', description: 'Crime family royalty.', genres: ['dark-romance'] },
        { id: 'dragons', name: 'Dragons, But Make It Spicy', description: 'DB override.', genres: ['fantasy'] },
      ],
      meta: { rev: 5 },
    };
    const setFake = vm.runInContext('(c) => { cloudClient = async () => c; }', ctx);
    setFake(fakeClient(db));
    const reached = await probe('TropeTaxonomy.refresh()');
    ok('refresh reaches the live table', reached === true);
    ok('rev adopted from taxonomy_meta', probe('TropeTaxonomy.rev()') === 5);
    ok('community row merged into the list (override does not duplicate)',
      probe('TropeTaxonomy.list().length') === bundledCount + 1);
    ok('community trope lookable by id',
      probe(`TropeTaxonomy.byId('mafia-princess').name`) === 'Mafia Princess');
    ok('db row overrides the bundled entry with the same id',
      probe(`TropeTaxonomy.byId('dragons').name`) === 'Dragons, But Make It Spicy');
    ok('live taxonomy cached to localStorage',
      !!memStore['cozylibram.tropetaxonomy.v1']);
  }

  /* ---- 3. offline restore from cache ---- */
  {
    // cache was written by section 2; drop memory, go offline
    probe(`TropeTaxonomy._db = null; TropeTaxonomy._rev = 1; TropeTaxonomy._ready = false;`);
    vm.runInContext('cloudClient = async () => null', ctx);
    const reached = await probe('TropeTaxonomy.refresh()');
    ok('offline refresh reports not reached', reached === false);
    ok('offline refresh restores the cached live taxonomy',
      probe(`TropeTaxonomy.byId('mafia-princess')`) !== null &&
      probe('TropeTaxonomy.rev()') === 5);
    ok('genre pool works from the restored cache',
      probe(`TropeTaxonomy.forGenres(['dark-romance']).some(t => t.id === 'mafia-princess')`) === true);
  }

  /* ---- 4. empty live table keeps the bundled file ---- */
  {
    reset();
    const setFake = vm.runInContext('(c) => { cloudClient = async () => c; }', ctx);
    setFake(fakeClient({ tropes: [], meta: { rev: 9 } }));
    const reached = await probe('TropeTaxonomy.refresh()');
    ok('empty table is not adopted', reached === false);
    ok('bundled taxonomy still served',
      probe('TropeTaxonomy.list().length') === bundledCount);
    ok('rev untouched by the empty table', probe('TropeTaxonomy.rev()') === 1);
  }

  /* ---- 5. noteApproved is live without a refresh round-trip ---- */
  {
    reset();
    probe(`TropeTaxonomy.noteApproved({ id: 'love-triangle-squared', name: 'Love Triangle Squared',
      description: 'Four people, one mess.', genres: ['romance'] }, 3)`);
    ok('noted trope is in the merged list',
      probe('TropeTaxonomy.list().length') === bundledCount + 1);
    ok('noted trope lookable by id',
      probe(`TropeTaxonomy.byId('love-triangle-squared').description`) === 'Four people, one mess.');
    ok('rev updated by the approval', probe('TropeTaxonomy.rev()') === 3);
    ok('validator accepts the noted id',
      probe(`validateTropeResults([{id:'love-triangle-squared',confidence:0.7}]).length`) === 1);
    // a second approval of the same slug replaces, not duplicates
    probe(`TropeTaxonomy.noteApproved({ id: 'love-triangle-squared', name: 'Love Triangle Cubed',
      description: 'x', genres: ['romance'] }, 4)`);
    ok('re-approval replaces the entry',
      probe('TropeTaxonomy.list().length') === bundledCount + 1 &&
      probe(`TropeTaxonomy.byId('love-triangle-squared').name`) === 'Love Triangle Cubed');
  }

  /* ---- 6. refresh failure never throws, keeps last state ---- */
  {
    reset();
    probe(`TropeTaxonomy.noteApproved({ id: 'x1', name: 'X1', description: 'x', genres: [] }, 2)`);
    const setFake = vm.runInContext('(c) => { cloudClient = async () => c; }', ctx);
    setFake({ from: () => { throw new Error('boom'); } });
    let threw = false, reached = false;
    try { reached = await probe('TropeTaxonomy.refresh()'); }
    catch (e) { threw = true; }
    ok('refresh swallows client errors', !threw && reached === false);
    ok('in-memory state survives the failed refresh',
      probe(`TropeTaxonomy.byId('x1')`) !== null && probe('TropeTaxonomy.rev()') === 2);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
