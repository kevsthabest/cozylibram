// QA Scout item 2 — community corpus / curation WRITE PATHS, executed.
//
// Before this suite, js/222 (suggest/vote/consensus/outbox), js/223
// (ccEnrichWarnings) and js/224 (loadQueue / setStatus / cqDecide /
// renderCurationQueue) had ZERO test executions: community-corpus.test.js
// drives only js/222's pure _test helpers and otherwise asserts source
// text. The publish gate itself — cqDecide/setStatus upserting approved
// tropes into the shared book_tropes, inserting approved characters into
// book_characters, writing the admin downvote on reject — ran nowhere.
//
// This suite executes the real functions against a recording Supabase
// stub (the circle/social suites' harness pattern, in Node form):
//   - suggest -> vote -> consensus with tier-weighted tallies asserted
//     NUMERICALLY (verified=3, established=2, member=1)
//   - cqDecide/setStatus per ptype (trope / new-trope / character /
//     trigger) x accept + reject, asserting the exact update/upsert/
//     insert payloads + bumpCounters effects
//   - the offline outbox: queue with cloudClient null, flush after the
//     client is restored, asserting order, payload author fill-in, and
//     failure retention
//   - js/223's ccEnrichWarnings merge + idempotence (the v496 regression:
//     a second run must not re-append)
//
// Harness note: cqDecide / renderCqList are closure-private in js/224
// (only loadQueue/setStatus/renderCurationQueue reach window). The
// loader widens the window.CurationQueue export IN THE HARNESS ONLY —
// the same source-rewrite trick community-corpus.test.js already uses
// for js/222 — so every function executed below is the production
// function byte-for-byte; only its reachability differs.
//
// NOT executed here (named, per the item brief): js/223's sheet/DOM
// flows (openTropePicker, openCharacterSuggest, openMergeProposal,
// openTriggerPicker, the MutationObserver injection) — DOM choreography
// whose meaningful behaviour is the js/222 calls they make, which ARE
// executed below. The DB-side no-self-vote trigger is a SQL property,
// pinned by the migration structure tests in community-corpus.test.js.

const fs = require('fs');
const path = require('path');
const { classicize } = require('./harness');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
const J = (o) => JSON.stringify(o);

/* ---------------- recording Supabase stub ----------------
   Chainable builder in the PostgREST shape the app uses. Every
   mutating call is recorded as { op, table, payload, opts, filters }
   and applied to in-memory tables so follow-up selects see it. */
function mkSb(seed) {
  const tables = {};
  Object.keys(seed || {}).forEach(k => { tables[k] = (seed[k] || []).slice(); });
  const calls = [];
  const sb = { tables, calls, failTables: new Set(),
    from(table) {
      const st = { table, filters: [], op: 'select', payload: null, opts: null, countMode: false, limitN: null };
      const matches = (r) => st.filters.every(([t, c, v]) => t === 'eq' ? r[c] === v : (v || []).includes(r[c]));
      const exec = (single) => {
        const rows = tables[table] || (tables[table] = []);
        if (st.op === 'insert') {
          calls.push({ op: 'insert', table, payload: st.payload, filters: st.filters.slice() });
          if (sb.failTables.has(table)) return { data: null, error: { message: 'stub insert failure' } };
          const row = Object.assign({ id: table + '-' + (rows.length + 1) }, st.payload);
          rows.push(row);
          return { data: single ? row : [row], error: null };
        }
        if (st.op === 'upsert') {
          calls.push({ op: 'upsert', table, payload: st.payload, opts: st.opts, filters: st.filters.slice() });
          if (sb.failTables.has(table)) return { data: null, error: { message: 'stub upsert failure' } };
          rows.push(Object.assign({}, st.payload)); // visible to later selects (consensus re-reads votes)
          return { data: null, error: null };
        }
        if (st.op === 'update') {
          calls.push({ op: 'update', table, payload: st.payload, filters: st.filters.slice() });
          rows.forEach(r => { if (matches(r)) Object.assign(r, st.payload); });
          return { data: null, error: null };
        }
        let out = rows.filter(matches);
        if (st.limitN != null) out = out.slice(0, st.limitN);
        if (st.countMode) return { data: null, error: null, count: out.length };
        return { data: out, error: null, count: out.length };
      };
      const b = {
        select(cols, opts) { if (st.op === 'select' && opts && opts.count === 'exact') st.countMode = true; return b; },
        insert(p) { st.op = 'insert'; st.payload = p; return b; },
        upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return b; },
        update(p) { st.op = 'update'; st.payload = p; return b; },
        eq(c, v) { st.filters.push(['eq', c, v]); return b; },
        in(c, vs) { st.filters.push(['in', c, vs]); return b; },
        order() { return b; },
        limit(n) { st.limitN = n; return b; },
        single() { return Promise.resolve(exec(true)); },
        maybeSingle() {
          const r = exec(false);
          return Promise.resolve({ data: (r.data && r.data[0]) || null, error: null });
        },
        then(res, rej) { return Promise.resolve(exec(false)).then(res, rej); }
      };
      return b;
    }
  };
  return sb;
}
const callsTo = (sb, op, table) => sb.calls.filter(c => c.op === op && c.table === table);

/* ---------------- shared harness state ---------------- */
const store = {};
const localStorageStub = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
const win = { addEventListener: function () {} };
let sb = null;                       // current stub the delegates return
let clientImpl = async () => sb;
const cloudClientFn = async () => clientImpl();
const userObj = { id: 'user-me' };
const bookKeyForFn = (book) => (book && book.key) || null;
const toastFn = function () {};
const escFn = (s) => String(s == null ? '' : s);

const loadModule = (file, params, args, rewrites) => {
  const raw = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
  // R3 repoint (migration plan §9.3): js/224 is a real ES module since
  // phase 1b. classicize restores the classic body before evaluation
  // (identity on classic files). A converted file has no IIFE wrapper
  // to strip — and the strip patterns could match nested callbacks —
  // so the strip now runs only when classicize changed nothing, i.e.
  // the target is still a classic IIFE file (js/222, js/223 today).
  // Loading plumbing only — assertions untouched.
  let src = classicize(raw, file);
  if (src === raw) src = src.replace(/\(function \(\) \{/, '').replace(/\}\)\(\);?\s*$/, '');
  (rewrites || []).forEach(([a, b]) => { src = src.split(a).join(b); });
  const moduleObj = { exports: {} };
  const fn = new Function(...params, src);
  fn(moduleObj, ...args);
  return moduleObj;
};

/* ---------------- js/222: CommunityCorpus ---------------- */
const m222 = loadModule('222-community-corpus.js',
  ['module', 'window', 'localStorage', 'toast', 'cloudClient', 'cloudUser', 'bookKeyFor', 'document'],
  [win, localStorageStub, toastFn, cloudClientFn, userObj, bookKeyForFn,
   { readyState: 'complete', addEventListener: function () {} }],
  [["if (typeof window !== 'undefined') window.CommunityCorpus = CommunityCorpus;", 'window.CommunityCorpus = CommunityCorpus;'],
   ["if (typeof module !== 'undefined') module.exports = CommunityCorpus;", 'module.exports = CommunityCorpus;']]);
const CC = m222.exports;
const BOOK = { key: 'isbn:9780000000001' };

(async () => {

/* ============ A. suggest flows (online) ============ */
{
  sb = mkSb({ trope_proposals: [{ id: 'tp-old', book_key: BOOK.key, status: 'pending', proposed_by: 'someone-else' }] });
  CC._test.rateLimitReset();
  const r = await CC.suggestTrope(BOOK, 'enemies-to-lovers', { quiet: true });
  ok('suggestTrope: ok + id returned', r.ok === true && !!r.id);
  const ins = callsTo(sb, 'insert', 'trope_proposals');
  ok('suggestTrope: exactly one insert into trope_proposals', ins.length === 1);
  ok('suggestTrope: payload is a pending catalog proposal by me',
    ins.length === 1 && ins[0].payload.kind === 'catalog' && ins[0].payload.trope_id === 'enemies-to-lovers' &&
    ins[0].payload.book_key === BOOK.key && ins[0].payload.status === 'pending' && ins[0].payload.proposed_by === 'user-me');
  ok('suggestTrope: obscurity weight 1/(1+1 existing) = 0.5',
    ins.length === 1 && ins[0].payload.obscurity_weight === 0.5);
}
{
  sb = mkSb({});
  CC._test.rateLimitReset();
  const rc = await CC.suggestCharacter(BOOK, { name: '  Wyn  ', role: 'supporting', description: 'A scout.' }, { quiet: true });
  const insc = callsTo(sb, 'insert', 'character_suggestions');
  ok('suggestCharacter: ok + trimmed name + pending add payload',
    rc.ok === true && insc.length === 1 && insc[0].payload.type === 'add' && insc[0].payload.name === 'Wyn' &&
    insc[0].payload.role === 'supporting' && insc[0].payload.status === 'pending' && insc[0].payload.suggested_by === 'user-me');
  CC._test.rateLimitReset();
  const rt = await CC.suggestTrigger(BOOK, 'graphic-violence', { quiet: true });
  const inst = callsTo(sb, 'insert', 'trigger_suggestions');
  ok('suggestTrigger: ok + pending payload with taxonomy id',
    rt.ok === true && inst.length === 1 && inst[0].payload.trigger_id === 'graphic-violence' &&
    inst[0].payload.status === 'pending' && inst[0].payload.suggested_by === 'user-me');
  CC._test.rateLimitReset();
  const rn = await CC.proposeNewTrope('Secret Twin', 'Long-lost sibling reveal', BOOK);
  const insn = callsTo(sb, 'insert', 'trope_proposals');
  ok('proposeNewTrope: lands as kind=new-idea with name_key',
    rn.ok === true && insn.length === 1 && insn[0].payload.kind === 'new-idea' &&
    insn[0].payload.name_key === 'secret twin' && insn[0].payload.status === 'pending');
}
{
  sb = mkSb({});
  CC._test.rateLimitReset();
  const noEv = await CC.proposeMerge(BOOK, 'char-a', 'char-b', '   ');
  ok('proposeMerge: empty evidence refused before any write',
    noEv.ok === false && noEv.reason === 'evidence' && sb.calls.length === 0);
  CC._test.rateLimitReset();
  const rm = await CC.proposeMerge(BOOK, 'char-a', 'char-b', 'both appear in Chapter 12');
  const insm = callsTo(sb, 'insert', 'character_suggestions');
  ok('proposeMerge: merge payload carries both refs + evidence',
    rm.ok === true && insm.length === 1 && insm[0].payload.type === 'merge' &&
    insm[0].payload.character_ref === 'char-a' && insm[0].payload.merge_with_ref === 'char-b' &&
    insm[0].payload.evidence === 'both appear in Chapter 12' && insm[0].payload.status === 'pending');
}

/* ============ B. vote -> consensus (tier-weighted, numeric) ============ */
{
  sb = mkSb({
    community_tiers: [
      { user_id: 'u-verified', tier: 'verified' },
      { user_id: 'u-established', tier: 'established' },
      { user_id: 'u-member', tier: 'member' }
    ],
    community_votes: []
  });
  const voters = [['u-verified', 1], ['u-established', 1], ['u-member', -1], ['u-stranger', 1]];
  for (const [uid, v] of voters) {
    userObj.id = uid;
    const rv = await CC.vote('trope', 'tp-1', v);
    if (!rv.ok) ok('vote by ' + uid + ' accepted by stub', false);
  }
  userObj.id = 'user-me';
  const ups = callsTo(sb, 'upsert', 'community_votes');
  ok('vote: one upsert per voter with the (type,id,user) conflict key',
    ups.length === 4 && ups.every(u => u.opts && u.opts.onConflict === 'suggestion_type,suggestion_id,user_id'));
  ok('vote: payloads carry voter + normalized ±1 vote',
    ups.length === 4 && ups[0].payload.user_id === 'u-verified' && ups[0].payload.vote === 1 &&
    ups[2].payload.user_id === 'u-member' && ups[2].payload.vote === -1 &&
    ups.every(u => u.payload.suggestion_type === 'trope' && u.payload.suggestion_id === 'tp-1'));
  const con = await CC.consensus('trope', 'tp-1');
  ok('consensus: counts are up=3, down=1', con.up === 3 && con.down === 1);
  ok('consensus: weighted tally = 3(verified) + 2(established) + 1(stranger) - 1(member) = 5',
    con.weighted === 5);
  const conNone = await CC.consensus('trope', 'no-such-id');
  ok('consensus: unknown suggestion is a clean zero', conNone.up === 0 && conNone.down === 0 && conNone.weighted === 0);
}

/* ============ C. js/223: ccEnrichWarnings (flywheel read path) ============ */
{
  class MO { constructor(cb) {} observe() {} disconnect() {} }
  const doc223 = { readyState: 'complete', addEventListener: function () {}, body: {},
    getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {}, classList: { add() {} }, addEventListener() {} }) };
  loadModule('223-community-corpus-ui.js',
    ['module', 'window', 'document', 'esc', 'toast', 'cloudClient', 'bookKeyFor', 'MutationObserver', 'requestAnimationFrame', 'overlayOpened', 'overlayClosed', 'wireSheetDrag', 'TropeTaxonomy'],
    [win, doc223, escFn, toastFn, cloudClientFn, bookKeyForFn, MO, function () {}, undefined, undefined, undefined, undefined]);
  ok('js/223: ccEnrichWarnings exposed', typeof win.ccEnrichWarnings === 'function');

  sb = mkSb({ trigger_suggestions: [
    { book_key: BOOK.key, status: 'accepted', trigger_id: 'graphic-violence', trigger_taxonomy: { label: 'Graphic Violence' } },
    { book_key: BOOK.key, status: 'accepted', trigger_id: 'grief', trigger_taxonomy: { label: 'Grief' } },
    { book_key: BOOK.key, status: 'pending', trigger_id: 'stalking', trigger_taxonomy: { label: 'Stalking' } }
  ] });
  const book = { key: BOOK.key, contentWarnings: ['Violence'] };
  await win.ccEnrichWarnings(book);
  ok('ccEnrichWarnings: accepted community warnings merged with the (community) suffix',
    J(book.contentWarnings) === J(['Violence', 'Graphic Violence (community)', 'Grief (community)']));
  await win.ccEnrichWarnings(book);
  ok('ccEnrichWarnings: second run is idempotent (v496 — no re-append)',
    J(book.contentWarnings) === J(['Violence', 'Graphic Violence (community)', 'Grief (community)']));
  clientImpl = async () => null;
  const untouched = { key: BOOK.key, contentWarnings: ['Violence'] };
  await win.ccEnrichWarnings(untouched);
  ok('ccEnrichWarnings: offline returns the book unchanged', J(untouched.contentWarnings) === J(['Violence']));
  clientImpl = async () => sb;
}

/* ============ D. js/224: curation queue ============ */
const fakeEls = {};
const fakeEl = () => ({ innerHTML: '', textContent: '', dataset: {}, style: {},
  classList: { add() {}, remove() {} }, addEventListener() {}, querySelectorAll: () => [],
  querySelector: () => null, appendChild() {}, focus() {} });
const doc224 = { getElementById: (id) => fakeEls[id] || (fakeEls[id] = fakeEl()),
  createElement: () => fakeEl(), body: fakeEl() };
const libraryStub = [{ isbn: '9780000000001', title: 'Some Book', warningsReviewed: false }];
let saveLibraryCalls = 0;
const win224 = {};
loadModule('224-curation-queue.js',
  ['module', 'window', 'document', 'cloudClient', 'cloudUser', 'esc', 'toast', 'library', 'saveLibrary'],
  [win224, doc224, cloudClientFn, userObj, escFn, toastFn, libraryStub, () => { saveLibraryCalls++; }],
  // R3 anchor update (same repoint): the publication this rewrite expands
  // is, since the phase-1b conversion, the classicized declaration line
  // `const CurationQueue = { ... }` (was the window assignment inside the
  // typeof guard). The expanded literal is member-for-member identical.
  [['const CurationQueue = { loadQueue: loadQueue, setStatus: setStatus, workIdFromBookKey: workIdFromBookKey };',
    'const CurationQueue = { loadQueue: loadQueue, setStatus: setStatus, cqDecide: cqDecide, renderCqList: renderCqList, renderCurationQueue: renderCurationQueue, workIdFromBookKey: workIdFromBookKey, _items: function () { return cqItems; } };']]);
const CQ = win224.CurationQueue;
ok('js/224: CurationQueue surface loaded (loadQueue/setStatus/cqDecide/renderCurationQueue)',
  !!CQ && typeof CQ.loadQueue === 'function' && typeof CQ.setStatus === 'function' &&
  typeof CQ.cqDecide === 'function' && typeof CQ.renderCurationQueue === 'function');

/* ---- loadQueue: mapping, pending-only, cross-table sort ---- */
{
  sb = mkSb({
    trope_proposals: [
      { id: 'tp-1', kind: 'catalog', trope_id: 'enemies-to-lovers', book_key: BOOK.key, proposed_by: 'user-a', created_at: '2026-10-01T00:00:00Z', status: 'pending', obscurity_weight: 0.5 },
      { id: 'tp-2', kind: 'new-idea', name: 'Secret Twin', description: 'A reveal.', book_key: BOOK.key, proposed_by: 'user-b', created_at: '2026-10-03T00:00:00Z', status: 'pending', obscurity_weight: 1 },
      { id: 'tp-3', kind: 'catalog', trope_id: 'found-family', book_key: BOOK.key, proposed_by: 'user-a', created_at: '2026-09-01T00:00:00Z', status: 'accepted' }
    ],
    character_suggestions: [
      { id: 'cs-1', type: 'add', name: 'Wyn', role: 'supporting', description: 'A scout.', book_key: BOOK.key, suggested_by: 'user-c', created_at: '2026-10-02T00:00:00Z', status: 'pending', obscurity_weight: 1 },
      { id: 'cs-2', type: 'merge', character_ref: 'char-a', merge_with_ref: 'char-b', evidence: 'Ch 12', book_key: BOOK.key, suggested_by: 'user-c', created_at: '2026-10-04T00:00:00Z', status: 'pending', obscurity_weight: 1 }
    ],
    trigger_suggestions: [
      { id: 'ts-1', trigger_id: 'graphic-violence', book_key: BOOK.key, suggested_by: 'user-d', created_at: '2026-10-05T00:00:00Z', status: 'pending', obscurity_weight: 1, trigger_taxonomy: { label: 'Graphic Violence' } }
    ]
  });
  const items = await CQ.loadQueue(sb);
  ok('loadQueue: pending only — 5 of 6 seeded rows (accepted trope excluded)', items.length === 5);
  ok('loadQueue: ptype mapping (catalog->trope, new-idea->new-trope, char, trigger)',
    J(items.map(i => i.ptype).sort()) === J(['character', 'character', 'new-trope', 'trigger', 'trope']));
  ok('loadQueue: items sorted by created_at across tables',
    J(items.map(i => i.id)) === J(['tp-1', 'cs-1', 'tp-2', 'cs-2', 'ts-1']));
  const trig = items.find(i => i.id === 'ts-1');
  ok('loadQueue: trigger title uses the taxonomy label when present',
    !!trig && trig.title === 'Warning: Graphic Violence');
  const merge = items.find(i => i.id === 'cs-2');
  ok('loadQueue: merge title + evidence in detail',
    !!merge && merge.title.indexOf('Merge: char-a') === 0 && merge.detail.indexOf('Evidence: Ch 12') !== -1);
}

/* ---- setStatus matrix: exact payloads per ptype x verdict ---- */
const seedTiers = () => ({ community_tiers: [{ user_id: 'user-a', accepted_count: 2, rejected_count: 1, tier: 'member' }] });
const tierBump = (sb, field) => {
  const u = callsTo(sb, 'upsert', 'community_tiers');
  return u.length === 1 && u[0].payload[field] !== undefined ? u[0].payload : null;
};
{ // trope ACCEPT — the publish gate itself
  sb = mkSb(seedTiers());
  const item = { ptype: 'trope', id: 'tp-1', bookKey: BOOK.key, by: 'user-a', raw: { trope_id: 'enemies-to-lovers' } };
  await CQ.setStatus(sb, item, true);
  const upd = callsTo(sb, 'update', 'trope_proposals');
  ok('setStatus trope accept: proposal marked accepted',
    upd.length === 1 && upd[0].payload.status === 'accepted' && J(upd[0].filters) === J([['eq', 'id', 'tp-1']]));
  const up = callsTo(sb, 'upsert', 'book_tropes');
  ok('setStatus trope accept: upserts into shared book_tropes as community (conf 0.7, taxonomy v1)',
    up.length === 1 && up[0].payload.book_key === BOOK.key && up[0].payload.trope_id === 'enemies-to-lovers' &&
    up[0].payload.source === 'community' && up[0].payload.confidence === 0.7 && up[0].payload.taxonomy_version === 1 &&
    typeof up[0].payload.updated_at === 'string' && !!up[0].opts && up[0].opts.onConflict === 'book_key,trope_id');
  const callOrder = sb.calls.map(c => c.op + ':' + c.table);
  ok('setStatus trope accept: upsert lands BEFORE the status flip (issue #258 ordering)',
    callOrder.indexOf('upsert:book_tropes') !== -1 &&
    callOrder.indexOf('upsert:book_tropes') < callOrder.indexOf('update:trope_proposals'));
  const bump = tierBump(sb, 'accepted_count');
  ok('setStatus trope accept: suggester counters bumped (accepted 2->3, rejected stays 1)',
    !!bump && bump.accepted_count === 3 && bump.rejected_count === 1 && bump.user_id === 'user-a');
  ok('setStatus trope accept: NO admin downvote written', callsTo(sb, 'upsert', 'trope_votes').length === 0);
}
{ // trope ACCEPT, the book_tropes upsert itself fails — status stays pending (issue #258)
  sb = mkSb(Object.assign(seedTiers(), {
    trope_proposals: [{ id: 'tp-7', status: 'pending' }]
  }));
  sb.failTables.add('book_tropes');
  const item = { ptype: 'trope', id: 'tp-7', bookKey: BOOK.key, by: 'user-a', raw: { trope_id: 'enemies-to-lovers' } };
  let threw = '';
  try { await CQ.setStatus(sb, item, true); } catch (e) { threw = e.message || ''; }
  ok('setStatus trope accept (upsert fails): throws the upsert error',
    threw.indexOf('stub upsert failure') !== -1);
  ok('setStatus trope accept (upsert fails): status NOT flipped — proposal stays pending (issue #258)',
    callsTo(sb, 'update', 'trope_proposals').length === 0 &&
    sb.tables.trope_proposals[0].status === 'pending');
}
{ // trope REJECT — stays down via the admin downvote
  sb = mkSb(seedTiers());
  userObj.id = 'user-admin';
  const item = { ptype: 'trope', id: 'tp-9', bookKey: BOOK.key, by: 'user-a', raw: { trope_id: 'found-family' } };
  await CQ.setStatus(sb, item, false);
  const upd = callsTo(sb, 'update', 'trope_proposals');
  ok('setStatus trope reject: proposal marked rejected', upd.length === 1 && upd[0].payload.status === 'rejected');
  ok('setStatus trope reject: NO book_tropes upsert (nothing published)', callsTo(sb, 'upsert', 'book_tropes').length === 0);
  const dv = callsTo(sb, 'upsert', 'trope_votes');
  ok('setStatus trope reject: admin downvote recorded (vote -1, curator id)',
    dv.length === 1 && dv[0].payload.vote === -1 && dv[0].payload.user_id === 'user-admin' &&
    dv[0].payload.trope_id === 'found-family' && !!dv[0].opts && dv[0].opts.onConflict === 'book_key,trope_id,user_id');
  const bump = tierBump(sb, 'rejected_count');
  ok('setStatus trope reject: counters bumped (rejected 1->2)', !!bump && bump.rejected_count === 2 && bump.accepted_count === 2);
  userObj.id = 'user-me';
}
{ // new-trope ACCEPT — 'approved', not 'accepted', and nothing published
  sb = mkSb(seedTiers());
  const item = { ptype: 'new-trope', id: 'tp-2', bookKey: BOOK.key, by: 'user-a', raw: { name: 'Secret Twin' } };
  await CQ.setStatus(sb, item, true);
  const upd = callsTo(sb, 'update', 'trope_proposals');
  ok("setStatus new-trope accept: status is 'approved' (curator adds to taxonomy manually)",
    upd.length === 1 && upd[0].payload.status === 'approved');
  ok('setStatus new-trope accept: no book_tropes write, no downvote',
    callsTo(sb, 'upsert', 'book_tropes').length === 0 && callsTo(sb, 'upsert', 'trope_votes').length === 0);
}
{ // character ACCEPT (add) — resolves the work, inserts into book_characters
  sb = mkSb(Object.assign(seedTiers(), { editions: [{ isbn: '9780000000001', work_id: 'work-42' }] }));
  const item = { ptype: 'character', id: 'cs-1', bookKey: BOOK.key, by: 'user-a',
    raw: { type: 'add', name: 'Wyn', role: 'supporting', description: 'A scout.' } };
  await CQ.setStatus(sb, item, true);
  const ins = callsTo(sb, 'insert', 'book_characters');
  ok('setStatus character accept: inserted into book_characters as community for the resolved work',
    ins.length === 1 && ins[0].payload.work_id === 'work-42' && ins[0].payload.name === 'Wyn' &&
    ins[0].payload.role === 'supporting' && ins[0].payload.description === 'A scout.' &&
    ins[0].payload.source_type === 'community');
  const upd = callsTo(sb, 'update', 'character_suggestions');
  ok('setStatus character accept: suggestion marked accepted', upd.length === 1 && upd[0].payload.status === 'accepted');
  const callOrder = sb.calls.map(c => c.op + ':' + c.table);
  ok('setStatus character accept: insert lands BEFORE the status flip (issue #219 ordering)',
    callOrder.indexOf('insert:book_characters') !== -1 &&
    callOrder.indexOf('insert:book_characters') < callOrder.indexOf('update:character_suggestions'));
}
{ // character ACCEPT with unresolvable work — throws, inserts nothing, stays pending (issue #219)
  sb = mkSb(Object.assign(seedTiers(), {
    character_suggestions: [{ id: 'cs-2', status: 'pending' }]
  }));
  const item = { ptype: 'character', id: 'cs-2', bookKey: 'isbn:9789999999999', by: 'user-a',
    raw: { type: 'add', name: 'Ghost', role: null, description: '' } };
  let threw = '';
  try { await CQ.setStatus(sb, item, true); } catch (e) { threw = e.message || ''; }
  ok('setStatus character accept (no work): throws the resolve error, cqDecide would log it failed',
    threw.indexOf('could not resolve work') === 0);
  ok('setStatus character accept (no work): NO book_characters insert', callsTo(sb, 'insert', 'book_characters').length === 0);
  ok('setStatus character accept (no work): status NOT flipped — suggestion stays pending (issue #219)',
    callsTo(sb, 'update', 'character_suggestions').length === 0 &&
    sb.tables.character_suggestions[0].status === 'pending');
}
{ // character ACCEPT, work resolves but the insert itself fails — status stays pending (issue #219)
  sb = mkSb(Object.assign(seedTiers(), {
    editions: [{ isbn: '9780000000001', work_id: 'work-42' }],
    character_suggestions: [{ id: 'cs-9', status: 'pending' }]
  }));
  sb.failTables.add('book_characters');
  const item = { ptype: 'character', id: 'cs-9', bookKey: BOOK.key, by: 'user-a',
    raw: { type: 'add', name: 'Wyn', role: 'supporting', description: 'A scout.' } };
  let threw = '';
  try { await CQ.setStatus(sb, item, true); } catch (e) { threw = e.message || ''; }
  ok('setStatus character accept (insert fails): throws the insert error',
    threw.indexOf('stub insert failure') !== -1);
  ok('setStatus character accept (insert fails): status NOT flipped — suggestion stays pending (issue #219)',
    callsTo(sb, 'update', 'character_suggestions').length === 0 &&
    sb.tables.character_suggestions[0].status === 'pending');
}
{ // character REJECT + merge ACCEPT — decisions recorded, nothing applied
  sb = mkSb(seedTiers());
  const rej = { ptype: 'character', id: 'cs-3', bookKey: BOOK.key, by: 'user-a', raw: { type: 'add', name: 'X' } };
  await CQ.setStatus(sb, rej, false);
  const mrg = { ptype: 'character', id: 'cs-4', bookKey: BOOK.key, by: 'user-a', raw: { type: 'merge', character_ref: 'a', merge_with_ref: 'b' } };
  await CQ.setStatus(sb, mrg, true);
  const upds = callsTo(sb, 'update', 'character_suggestions');
  ok('setStatus character reject/merge: statuses recorded (rejected, accepted)',
    upds.length === 2 && upds[0].payload.status === 'rejected' && upds[1].payload.status === 'accepted');
  ok('setStatus character reject/merge: merges are never auto-applied (no insert)',
    callsTo(sb, 'insert', 'book_characters').length === 0);
}
{ // trigger ACCEPT — marks the local book warnings-reviewed (v468)
  sb = mkSb(seedTiers());
  libraryStub[0].warningsReviewed = false; saveLibraryCalls = 0;
  const item = { ptype: 'trigger', id: 'ts-1', bookKey: BOOK.key, by: 'user-a', raw: { trigger_id: 'graphic-violence' } };
  await CQ.setStatus(sb, item, true);
  const upd = callsTo(sb, 'update', 'trigger_suggestions');
  ok('setStatus trigger accept: suggestion marked accepted', upd.length === 1 && upd[0].payload.status === 'accepted');
  ok('setStatus trigger accept: local book flagged warnings-reviewed + saved',
    libraryStub[0].warningsReviewed === true && saveLibraryCalls === 1);
  const item2 = { ptype: 'trigger', id: 'ts-2', bookKey: BOOK.key, by: 'user-a', raw: { trigger_id: 'grief' } };
  libraryStub[0].warningsReviewed = false; saveLibraryCalls = 0;
  await CQ.setStatus(sb, item2, false);
  ok('setStatus trigger reject: no warnings-reviewed side effect',
    libraryStub[0].warningsReviewed === false && saveLibraryCalls === 0);
}
{ // workIdFromBookKey: the t: (title/author) path
  sb = mkSb({ works: [{ id: 'work-t', title_norm: 'some book', author_norm: 'an author' }] });
  const wid = await CQ.workIdFromBookKey(sb, 't:some book:an author');
  ok('workIdFromBookKey: t: keys resolve via works.title_norm/author_norm', wid === 'work-t');
}

/* ---- renderCurationQueue + cqDecide: the end-to-end path ---- */
{
  sb = mkSb(Object.assign(seedTiers(), {
    trope_proposals: [
      { id: 'tp-1', kind: 'catalog', trope_id: 'enemies-to-lovers', book_key: BOOK.key, proposed_by: 'user-a', created_at: '2026-10-01T00:00:00Z', status: 'pending', obscurity_weight: 1 },
      { id: 'tp-2', kind: 'catalog', trope_id: 'found-family', book_key: BOOK.key, proposed_by: 'user-a', created_at: '2026-10-02T00:00:00Z', status: 'pending', obscurity_weight: 1 }
    ],
    character_suggestions: [], trigger_suggestions: [],
    circle_profiles: [{ user_id: 'user-a', first_name: 'Ana' }]
  }));
  await win224.renderCurationQueue();
  ok('renderCurationQueue: queue loads both pending items', CQ._items().length === 2);
  await CQ.cqDecide(sb, ['tp-1'], true);
  ok('cqDecide approve: book_tropes gained the community trope',
    callsTo(sb, 'upsert', 'book_tropes').length === 1);
  ok('cqDecide approve: queue reloaded without the decided item',
    CQ._items().length === 1 && CQ._items()[0].id === 'tp-2');
  ok('cqDecide approve: status line reports the outcome',
    (fakeEls['cq-msg'] && fakeEls['cq-msg'].textContent.indexOf('1 approved') === 0));
  await CQ.cqDecide(sb, ['tp-2'], false);
  ok('cqDecide reject: admin downvote written, queue now empty',
    callsTo(sb, 'upsert', 'trope_votes').length === 1 && CQ._items().length === 0);
  ok('cqDecide reject: status line reports the outcome',
    (fakeEls['cq-msg'] && fakeEls['cq-msg'].textContent.indexOf('1 rejected') === 0));
}

/* ============ E. offline outbox: queue -> flush ============ */
{
  clientImpl = async () => null;
  CC._test.rateLimitReset();
  const q1 = await CC.suggestTrope(BOOK, 'found-family', { quiet: true });
  CC._test.rateLimitReset();
  const q2 = await CC.suggestTrigger(BOOK, 'grief', { quiet: true });
  ok('outbox: offline suggests report queued', q1.ok === true && q1.queued === true && q2.ok === true && q2.queued === true);
  let box = JSON.parse(store['cozylibram.cc.outbox.v1'] || '[]');
  ok('outbox: two entries queued in order (trope, then trigger)',
    box.length === 2 && box[0].table === 'trope_proposals' && box[1].table === 'trigger_suggestions');

  sb = mkSb({});
  clientImpl = async () => sb;
  userObj.id = 'user-me';
  await CC.flushOutbox();
  const fins = sb.calls.filter(c => c.op === 'insert');
  ok('flushOutbox: both queued payloads inserted, in queue order',
    fins.length === 2 && fins[0].table === 'trope_proposals' && fins[1].table === 'trigger_suggestions');
  ok('flushOutbox: author filled at flush (proposed_by / suggested_by = me)',
    fins.length === 2 && fins[0].payload.proposed_by === 'user-me' && fins[1].payload.suggested_by === 'user-me');
  box = JSON.parse(store['cozylibram.cc.outbox.v1'] || '[]');
  ok('flushOutbox: outbox drained after a clean flush', box.length === 0);

  // failure retention: a failing insert stays queued, later entries still flush
  clientImpl = async () => null;
  CC._test.rateLimitReset();
  await CC.suggestTrope(BOOK, 'slow-burn', { quiet: true });
  CC._test.rateLimitReset();
  await CC.suggestTrigger(BOOK, 'stalking', { quiet: true });
  sb = mkSb({});
  sb.failTables.add('trope_proposals');
  clientImpl = async () => sb;
  await CC.flushOutbox();
  box = JSON.parse(store['cozylibram.cc.outbox.v1'] || '[]');
  ok('flushOutbox: failed entry retained, successful entry gone',
    box.length === 1 && box[0].table === 'trope_proposals');
  sb.failTables.clear();
  await CC.flushOutbox();
  box = JSON.parse(store['cozylibram.cc.outbox.v1'] || '[]');
  ok('flushOutbox: retained entry flushes once the table recovers', box.length === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
