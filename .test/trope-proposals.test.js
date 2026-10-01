/* v155 proposal tests: TropeProposals submit/duplicate-check/voting/slug/
   approve/reject/duplicate, and the guarantee that inference only accepts
   taxonomy ids. v157: approval bumps taxonomy_meta.rev, stamps
   taxonomy_rev on the auto-tag, and makes the trope live instantly via
   TropeTaxonomy.noteApproved (the JS export snippet is gone).
   Run: node .test/trope-proposals.test.js */
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
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    SPICY_CONFIG: {},
    library: [],
    localUid: 'user-1',
    cloudClient: async () => null,
    fetch: async () => { throw new Error('no network in tests'); },
    // v225: inferBookTropes defaults to apiFetch (js/050-helpers.js, not
    // loaded here); pass through to the ctx fetch stub, which tests reassign.
    apiFetch: async (url, opts) => ctx.fetch(url, opts),
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  const load = f => vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
  load('156-trope-taxonomy.js');
  load('157-trope-inference.js');

  const probe = src => vm.runInContext(src, ctx);

  /* In-memory supabase fake with a chainable query builder. */
  function makeDb() {
    return { trope_proposals: [], trope_proposal_votes: [], tropes: [],
      book_tropes: [], taxonomy_meta: [{ id: 1, rev: 1 }] };
  }
  function useDb(db, log) {
    probe(`window.__db = ${JSON.stringify(db)}; window.__log = []; window.__sb = null;`);
    probe(`window.__newFakeClient = () => {
      const db = window.__db, log = window.__log;
      function query(table) {
        const rows = db[table];
        const q = {
          _filters: [], _order: null,
          select() { return this; },
          limit() { return this; },
          eq(col, val) { this._filters.push(r => r[col] === val); return this; },
          in(col, vals) { this._filters.push(r => vals.indexOf(r[col]) !== -1); return this; },
          like(col, pat) {
            const re = new RegExp('^' + pat.replace(/%/g, '.*').replace(/_/g, '.') + '$');
            this._filters.push(r => re.test(r[col])); return this;
          },
          order(col, o) { this._order = { col, asc: !o || o.ascending !== false }; return this; },
          _run() {
            let out = rows.filter(r => this._filters.every(f => f(r)));
            if (this._order) { const c = this._order.col, a = this._order.asc ? 1 : -1;
              out = out.slice().sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * a); }
            return out;
          },
          maybeSingle() { const o = this._run(); return Promise.resolve({ data: o[0] || null, error: null }); },
          single() { const o = this._run();
            return o.length ? Promise.resolve({ data: o[0], error: null })
                            : Promise.resolve({ data: null, error: new Error('not found') }); },
          then(res, rej) { return Promise.resolve({ data: this._run(), error: null }).then(res, rej); },
          insert(row) {
            log.push(['insert', table, row.name || row.trope_id || '']);
            const r = Object.assign({}, row);
            if (table === 'trope_proposals' && !r.id) r.id = 'prop-' + (rows.length + 1);
            if (!r.created_at) r.created_at = new Date().toISOString();
            rows.push(r);
            return { select: () => ({ single: () => Promise.resolve({ data: r, error: null }) }) };
          },
          update(patch) { return { eq: (col, val) => {
            log.push(['update', table, JSON.stringify(patch)]);
            rows.forEach(r => { if (r[col] === val) Object.assign(r, patch); });
            return Promise.resolve({ error: null });
          } }; },
          upsert(row, opt) {
            log.push(['upsert', table, row.id || row.trope_id || row.proposal_id || '']);
            const keys = ((opt && opt.onConflict) || '').split(',').map(s => s.trim()).filter(Boolean);
            const i = keys.length ? rows.findIndex(r => keys.every(k => r[k] === row[k])) : -1;
            if (i >= 0) rows[i] = Object.assign({}, rows[i], row); else rows.push(Object.assign({}, row));
            return Promise.resolve({ error: null });
          },
          delete() { const self = this;
            return { eq(col, val) { self._filters.push(r => r[col] === val); return {
              eq(c2, v2) { self._filters.push(r => r[c2] === v2);
                log.push(['delete', table]);
                for (let i = rows.length - 1; i >= 0; i--)
                  if (self._filters.every(f => f(rows[i]))) rows.splice(i, 1);
                return Promise.resolve({ error: null }); } }; } };
          },
        };
        return q;
      }
      return { from: (t) => query(t) };
    };`);
    probe(`window.__sb = window.__newFakeClient();`);
    probe(`TropeProposals.configure({ getClient: async () => window.__sb })`);
    /* v157: the live taxonomy layer reads through the global cloudClient,
       so point it at the same fake. */
    probe(`cloudClient = async () => window.__sb || null;`);
    return {
      db: () => probe('window.__db'),
      log: () => probe('window.__log'),
    };
  }

  /* v157: TropeTaxonomy caches live state in-memory; reset between
     sections so each one starts from a known baseline. */
  function resetTax() {
    probe(`TropeTaxonomy._db = null; TropeTaxonomy._rev = 1; TropeTaxonomy._ready = false;`);
    probe(`localStorage.removeItem('cozylibram.tropetaxonomy.v1')`);
  }

  /* ---- 1. duplicate checking ---- */
  {
    const d1 = probe(`TropeProposals.checkDuplicate('Enemies to Lovers')`);
    ok('exact duplicate detected', d1 && d1.kind === 'exact' && d1.trope.id === 'enemies-to-lovers');
    const d2 = probe(`TropeProposals.checkDuplicate('forced closeness')`);
    ok('fuzzy duplicate detected', d2 && d2.kind === 'similar' && d2.trope.id === 'forced-proximity');
    ok('no match returns null', probe(`TropeProposals.checkDuplicate('xyzzy plugh trope')`) === null);
    ok('empty name returns null', probe(`TropeProposals.checkDuplicate('')`) === null);
    ok('genre labels', probe(`tropeGenreLabel('dark-romance')`) === 'Dark Romance');
  }

  /* ---- 2. submit validation ---- */
  {
    const { db, log } = useDb(makeDb());
    const sub = (o) => probe(`TropeProposals.submit(${JSON.stringify(o)})`);
    const bad = async (o) => { try { await sub(o); return 'NO-THROW'; } catch (e) { return e.message; } };
    ok('rejects short name', (await bad({ name: 'ab', description: 'A fine one-line definition here.', genres: ['romance'] })).includes('3–60'));
    ok('rejects long definition', (await bad({ name: 'Valid Name', description: 'x'.repeat(161), genres: ['romance'] })).includes('10–160'));
    ok('rejects missing genres', (await bad({ name: 'Valid Name', description: 'A fine one-line definition here.', genres: [] })).includes('genre'));
    ok('rejects exact duplicates', (await bad({ name: 'Enemies to Lovers', description: 'A fine one-line definition here.', genres: ['romance'] })).includes('already exists'));
    const id = await sub({ name: 'Only One Bed', description: 'One bed, two people, inevitable.', genres: ['romance', 'bogus'], bookKey: 'isbn:123' });
    ok('valid submit returns an id', typeof id === 'string' && id.length > 0);
    const rows = db().trope_proposals;
    ok('row stored pending as self',
      rows.length === 1 && rows[0].status === 'pending' && rows[0].proposed_by === 'user-1');
    ok('name_key + book_key stored, bad genres dropped',
      rows[0].name_key === 'onlyonebed' && rows[0].book_key === 'isbn:123' &&
      JSON.stringify(rows[0].genres) === '["romance"]');
    probe('localUid = null');
    ok('signed-out submit throws', (await bad({ name: 'Another', description: 'A fine one-line definition here.', genres: ['romance'] })).includes('Sign in'));
    probe('localUid = "user-1"');
  }

  /* ---- 3. listPending: derived counts, mine flag, sort ---- */
  {
    const seed = makeDb();
    seed.trope_proposals = [
      { id: 'p1', name: 'Alpha', description: 'd', genres: ['romance'], proposed_by: 'user-9', status: 'pending', created_at: '2026-01-02' },
      { id: 'p2', name: 'Beta', description: 'd', genres: ['fantasy'], proposed_by: 'user-1', status: 'pending', created_at: '2026-01-01' },
      { id: 'p3', name: 'Gamma', description: 'd', genres: ['horror'], proposed_by: 'user-9', status: 'approved', created_at: '2026-01-03' },
    ];
    seed.trope_proposal_votes = [
      { proposal_id: 'p1', user_id: 'user-1', vote: 1 },
      { proposal_id: 'p1', user_id: 'user-2', vote: 1 },
      { proposal_id: 'p1', user_id: 'user-3', vote: -1 },
      { proposal_id: 'p2', user_id: 'user-2', vote: -1 },
    ];
    useDb(seed);
    const list = await probe(`TropeProposals.listPending()`);
    ok('only pending listed', list.length === 2 && list.every(p => p.id !== 'p3'));
    ok('counts derived from normalized rows',
      list[0].id === 'p1' && list[0].votes.up === 2 && list[0].votes.down === 1);
    ok('mine vote detected', list[0].votes.mine === 1);
    ok('own proposal flagged', list[1].mine === true && list[1].id === 'p2');
    ok('sorted by net votes desc', list[0].id === 'p1');
  }

  /* ---- 4. proposal vote toggle ---- */
  {
    const { db, log } = useDb(makeDb());
    const t1 = await probe(`TropeProposals.toggleVote('p9', 1)`);
    ok('upvote recorded', t1 === 1 && db().trope_proposal_votes.length === 1);
    const t2 = await probe(`TropeProposals.toggleVote('p9', 1)`);
    ok('tap again retracts', t2 === 0 && db().trope_proposal_votes.length === 0);
    const t3 = await probe(`TropeProposals.toggleVote('p9', -1)`);
    ok('downvote recorded', t3 === -1 && db().trope_proposal_votes[0].vote === -1);
    ok('one row per user per proposal',
      log().filter(l => l[0] === 'upsert').length === 2 && db().trope_proposal_votes.length === 1);
  }

  /* ---- 5. collision-safe slugs ---- */
  {
    resetTax();
    const seed = makeDb();
    seed.tropes = [{ id: 'only-one-bed', name: 'Only One Bed', description: 'x', genres: ['romance'] }];
    useDb(seed);
    ok('local taxonomy collision suffixed',
      (await probe(`TropeProposals.slugFor('Enemies to Lovers')`)) === 'enemies-to-lovers-2');
    ok('db collision suffixed',
      (await probe(`TropeProposals.slugFor('Only One Bed')`)) === 'only-one-bed-2');
    ok('clean name needs no suffix',
      (await probe(`TropeProposals.slugFor('Star-Crossed Pact')`)) === 'star-crossed-pact');
  }

  /* ---- 6. approve / reject / duplicate ---- */
  {
    resetTax();
    const seed = makeDb();
    seed.trope_proposals = [
      { id: 'p1', name: 'Only One Bed', description: 'One bed, two people.', genres: ['romance'], book_key: 'isbn:123', proposed_by: 'user-2', status: 'pending' },
      { id: 'p2', name: 'Rejected Idea', description: 'Not great.', genres: ['horror'], book_key: null, proposed_by: 'user-2', status: 'pending' },
      { id: 'p3', name: 'Forced Closeness', description: 'Close quarters.', genres: ['romance'], book_key: null, proposed_by: 'user-2', status: 'pending' },
    ];
    const { db } = useDb(seed);
    const r = await probe(`TropeProposals.approve('p1', { tagBook: true })`);
    ok('approve returns the slug', r.slug === 'only-one-bed');
    ok('approve returns the bumped rev', r.rev === 2);
    const tropeRow = db().tropes.find(t => t.id === 'only-one-bed');
    ok('canonical row written to shared taxonomy',
      tropeRow && tropeRow.name === 'Only One Bed' && tropeRow.version === 1);
    ok('taxonomy rev bumped in the db',
      db().taxonomy_meta.find(m => m.id === 1).rev === 2);
    ok('proposal marked approved',
      db().trope_proposals.find(p => p.id === 'p1').status === 'approved');
    const tag = db().book_tropes.find(b => b.book_key === 'isbn:123');
    ok('originating book auto-tagged as community',
      tag && tag.trope_id === 'only-one-bed' && tag.source === 'community' && tag.confidence === 0.85);
    ok('auto-tag stamps the new taxonomy rev', tag && tag.taxonomy_rev === 2);
    ok('approved trope is live instantly on this device',
      probe(`TropeTaxonomy.byId('only-one-bed')`) &&
      probe(`TropeTaxonomy.byId('only-one-bed').name`) === 'Only One Bed' &&
      probe(`TropeTaxonomy.rev()`) === 2);
    await probe(`TropeProposals.approve('p2', { tagBook: true })`);
    ok('approve without a book skips tagging',
      !db().book_tropes.some(b => b.trope_id === 'rejected-idea'));
    await probe(`TropeProposals.reject('p2')`);
    ok('reject marks rejected',
      db().trope_proposals.find(p => p.id === 'p2').status === 'rejected');
    await probe(`TropeProposals.markDuplicate('p3', 'forced-proximity')`);
    const dup = db().trope_proposals.find(p => p.id === 'p3');
    ok('duplicate links the canonical id',
      dup.status === 'duplicate' && dup.duplicate_of === 'forced-proximity');
    let threw = false;
    try { await probe(`TropeProposals.markDuplicate('p3', 'no-such-trope')`); }
    catch (e) { threw = true; }
    ok('duplicate of unknown id throws', threw);
  }

  /* ---- 7. freshly approved trope is inferable (no file edit) ---- */
  {
    // state left by section 6: 'only-one-bed' approved and live via noteApproved
    const acc = probe(`validateTropeResults([{ id: 'only-one-bed', confidence: 0.9 }, { id: 'nope', confidence: 0.5 }])`);
    ok('approved community id passes validation',
      acc.length === 1 && acc[0].id === 'only-one-bed');
    const dup = probe(`TropeProposals.checkDuplicate('Only One Bed')`);
    ok('duplicate check sees the live-approved trope',
      dup && dup.kind === 'exact' && dup.trope.id === 'only-one-bed');
    const pool = probe(`TropeTaxonomy.forGenres(['romance']).map(t => t.id)`);
    ok('genre prompt pool includes the live-approved trope',
      Array.isArray(pool) && pool.indexOf('only-one-bed') !== -1);
  }

  /* ---- 8. inference only accepts taxonomy ids ---- */
  {
    resetTax(); // 'only-one-bed' must NOT be live here — unapproved ids are rejected
    probe(`SPICY_CONFIG = ({ trope: true, tropeProvider: 'openrouter', tropeModel: 'm' })`);
    probe(`fetch = async () => ({ ok: true, status: 200, json: async () => ({
      choices: [{ message: { content: '{"tropes":[{"id":"only-one-bed","confidence":0.9},{"id":"dragons","confidence":0.8}]}' } }] }) })`);
    const book = { id: 'b8', title: 'X', authors: ['Y'], description: 'A sufficiently long description for the inference client to accept.' };
    const out = await probe(`inferBookTropes(${JSON.stringify(book)})`);
    ok('unapproved proposal ids are rejected by the parser',
      out.tropes.length === 1 && out.tropes[0].id === 'dragons');
    probe('SPICY_CONFIG = {}');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
