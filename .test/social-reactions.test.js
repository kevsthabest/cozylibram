// Social build #1 (v525): reactions on moments.
//
// The contract under test:
// - A moment is a circle member finishing a book, derived from the same
//   book lists the circle digest uses — so the activity opt-in gate
//   (books never fetched → no moments) and the content shield (books
//   filtered before moments are computed → reaction data for a filtered
//   moment is never even requested) hold by construction.
// - Reactions live in moment_reactions, readable ONLY by the giver or
//   the moment's owner (the stub below emulates the migration's RLS):
//   a third friend cannot enumerate reactions on someone else's moment.
// - NO counts/tallies anywhere: the owner sees individual chips, a
//   giver sees only their own chip; nothing computes or renders a
//   number of reactions.
// - One reaction per person per moment: set → change → remove round-trip.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in social-reactions tests'); };
window.confirm = () => true;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

const ME = 'user-me', FAY = 'user-fay', GUS = 'user-gus', NOVA = 'user-nova';
// NOVA: not in the circle at all. FAY: opted into activity. GUS: opted
// into activity too (he reacts on FAY's moment; ME must not see it).
const dayAgo = (n) => { const d = new Date(Date.now() - n * 864e5); return d.toISOString(); };
const bookRow = (uid, id, title, status, finDaysAgo, extra) => ({
  user_id: uid, book_id: id, isbn: null,
  data: Object.assign({ id: id, title: title, authors: ['An Author'], status: status,
    dateFinished: finDaysAgo == null ? null : dayAgo(finDaysAgo) }, extra || {}),
});

const mkStub = () => {
  const db = {
    circle_links: [
      { requester_id: ME, addressee_id: FAY, status: 'accepted', created_at: dayAgo(30) },
      { requester_id: ME, addressee_id: GUS, status: 'accepted', created_at: dayAgo(30) },
      { requester_id: FAY, addressee_id: GUS, status: 'accepted', created_at: dayAgo(30) },
    ],
    profiles: {},
    books: [],
    works: [],
    user_state: [],
    moment_reactions: [], // {moment_key, owner_id, giver_id, kind, created_at, updated_at}
    queries: [],          // every .in('moment_key', ...) key list the client asked for
  };
  db.profiles[ME] = { user_id: ME, first_name: 'Me', last_name: 'Reader', share_library: true, share_activity: true, hidden_shelves: [] };
  db.profiles[FAY] = { user_id: FAY, first_name: 'Fay', last_name: 'Fable', share_library: true, share_activity: true, hidden_shelves: [] };
  // NOTE: GUS's own activity sharing is OFF below in the gating section
  // (his books are then never fetched for stats); that doesn't stop him
  // reacting to FAY's moments — reacting depends on the OWNER's opt-in.
  db.profiles[GUS] = { user_id: GUS, first_name: 'Gus', last_name: 'Gable', share_library: true, share_activity: true, hidden_shelves: [] };
  db.profiles[NOVA] = { user_id: NOVA, first_name: 'Nova', last_name: 'Nope', share_library: true, share_activity: true, hidden_shelves: [] };
  const projectPublic = (p) => {
    const out = { user_id: p.user_id, first_name: p.first_name || '', last_name: p.last_name || '',
      avatar_id: p.avatar_id || '', avatar_path: p.avatar_path || '',
      share_library: p.share_library !== false, share_bio: p.share_bio !== false,
      share_activity: p.share_activity === true };
    if (out.share_bio) {
      if (p.bio) out.bio = p.bio;
      if (Array.isArray(p.fav_genres) && p.fav_genres.length) out.fav_genres = p.fav_genres.slice();
    }
    return out;
  };
  const rowsOf = (name) => name === 'profiles' ? Object.values(db.profiles)
    : name === 'circle_profiles' ? Object.values(db.profiles).map(projectPublic)
    : db[name];
  const applyConds = (rows, conds) => rows.filter(r => conds.every(([c, v]) => r[c] === v));
  // The RLS emulation for moment_reactions, mirroring the migration:
  // a row is visible/writable only as its policies allow for the
  // CURRENT user (window.__uid, set by useAs below).
  const asUser = () => window.__uid;
  // v532: the giver branch additionally requires the owner's CURRENT
  // sharing posture, mirroring moment_owner_sharing() —
  // share_activity on AND circle_book_visible(owner, 'read')
  // (emulated: owner shares their library and doesn't hide 'read').
  // The owner branch stays ungated; third parties never see a row.
  const rxVisible = (r) => {
    if (r.owner_id === asUser()) return true;
    if (r.giver_id !== asUser()) return false;
    const owner = db.profiles[r.owner_id] || {};
    return owner.share_activity === true &&
      owner.share_library !== false &&
      !(Array.isArray(owner.hidden_shelves) && owner.hidden_shelves.indexOf('read') !== -1);
  };
  const rxLinked = (a, b) => db.circle_links.some(l => l.status === 'accepted' &&
    ((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
  const table = (name) => ({
    select(cols) {
      const q = { _conds: [], _in: null,
        eq(c, v) { q._conds.push([c, v]); return q; },
        in(c, vs) { q._in = [c, vs]; if (name === 'moment_reactions') db.queries.push(vs.slice()); return q; },
        maybeSingle() { const rs = q._run(); return Promise.resolve({ data: rs[0] || null, error: null }); },
        _run() {
          let rs = rowsOf(name);
          if (name === 'moment_reactions') rs = rs.filter(rxVisible);
          rs = applyConds(rs, q._conds);
          if (q._in) rs = rs.filter(r => q._in[1].indexOf(r[q._in[0]]) !== -1);
          return rs;
        },
        then(res, rej) { try { res({ data: q._run(), error: null }); } catch (e) { rej(e); } },
      };
      return q;
    },
    upsert(row, opts) {
      if (name === 'profiles') { db.profiles[row.user_id] = Object.assign({}, db.profiles[row.user_id], row); return Promise.resolve({ error: null }); }
      if (name === 'moment_reactions') {
        // There are deliberately NO insert/update policies: direct
        // writes are refused — react_to_moment() is the only door.
        return Promise.resolve({ error: { message: 'new row violates row-level security policy' } });
      }
      return Promise.resolve({ error: null });
    },
    delete() {
      const dq = { _conds: [],
        eq(c, v) { dq._conds.push([c, v]); return dq; },
        then(res, rej) {
          try {
            // DELETE policy: the giver removes their own reaction.
            // (No owner-delete in v1 — see the migration's rationale.)
            db[name] = rowsOf(name).filter(r => {
              if (!dq._conds.every(([c, v]) => r[c] === v)) return true;
              if (name === 'moment_reactions') return r.giver_id !== asUser();
              return false;
            });
            res({ data: [], error: null });
          } catch (e) { rej(e); }
        },
      };
      return dq;
    },
  });
  const stub = { db, from: (t) => table(t),
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'not found' } }) }) } };
  // react_to_moment() emulation — mirrors the migration's gates, in
  // the migration's order: signed in → kind → not own moment → day in
  // window → accepted link → owner's CURRENT share_activity →
  // circle_book_visible(owner,'read') → the book really finished then.
  stub.rpc = (fn, args) => {
    if (fn !== 'react_to_moment') return Promise.resolve({ data: null, error: { message: 'unknown rpc ' + fn } });
    const me = asUser();
    const err = (m) => Promise.resolve({ data: null, error: { message: m } });
    if (!me) return err('not signed in');
    if (['heart', 'sparkles', 'moon', 'trophy', 'smile'].indexOf(args.p_kind) === -1) return err('unknown reaction kind');
    if (me === args.p_owner) return err('cannot react to your own moment');
    const dayMs = Date.parse(String(args.p_day) + 'T00:00:00Z');
    if (isNaN(dayMs) || dayMs < Date.now() - 92 * 864e5 || dayMs > Date.now() + 864e5) return err('moment outside the reaction window');
    if (!rxLinked(me, args.p_owner)) return err('not circle friends');
    const prof = db.profiles[args.p_owner];
    if (!prof || prof.share_activity !== true) return err('owner is not sharing activity');
    const hidden = Array.isArray(prof.hidden_shelves) ? prof.hidden_shelves : [];
    const hasRead = db.books.some(r => r.user_id === args.p_owner && r.data && r.data.status === 'read');
    if (prof.share_library === false || hidden.indexOf('read') !== -1 || !hasRead) return err('read shelf is not shared');
    const book = db.books.find(r => r.user_id === args.p_owner && r.book_id === args.p_book_id);
    if (!book || !book.data || book.data.status !== 'read' ||
        String(book.data.dateFinished || '').slice(0, 10) !== args.p_day) return err('no such moment');
    const key = args.p_owner + ':' + args.p_book_id + ':' + args.p_day;
    const i = db.moment_reactions.findIndex(r => r.moment_key === key && r.giver_id === me);
    const row = { moment_key: key, owner_id: args.p_owner, giver_id: me, kind: args.p_kind, updated_at: new Date().toISOString() };
    if (i >= 0) db.moment_reactions[i] = Object.assign({}, db.moment_reactions[i], row);
    else db.moment_reactions.push(Object.assign({ created_at: new Date().toISOString() }, row));
    return Promise.resolve({ data: key, error: null });
  };
  return stub;
};

const stub = mkStub();
let currentUid = null;
const useAs = (uid) => {
  currentUid = uid; window.__uid = uid;
  runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "' + uid + '@x.y" }' : 'null') + ';');
};

const finishBook = { id: 'book-dune', title: 'Dune', authors: ['Frank Herbert'], status: 'read', dateFinished: dayAgo(2) };

(async () => {
  await tick(3);
  window.__sbStub = stub;

  /* ---------- moment identity ---------- */
  useAs(ME);
  const key1 = probe('momentKeyFor(' + JSON.stringify(FAY) + ', ' + JSON.stringify(finishBook) + ')');
  ok('moment key = owner:book:day (the exact string the RPC builds server-side)',
    key1 === FAY + ':book-dune:' + dayAgo(2).slice(0, 10));
  ok('moment key is deterministic (same inputs → same key)',
    probe('momentKeyFor(' + JSON.stringify(FAY) + ', ' + JSON.stringify(finishBook) + ')') === key1);
  ok('moment key changes with the finish day (re-key on edit)',
    probe('momentKeyFor(' + JSON.stringify(FAY) + ', ' + JSON.stringify(Object.assign({}, finishBook, { dateFinished: dayAgo(3) })) + ')') !== key1);
  ok('no moment for a book still being read',
    probe('momentKeyFor(' + JSON.stringify(FAY) + ', ' + JSON.stringify(Object.assign({}, finishBook, { status: 'reading' })) + ')') === '');
  ok('no moment without a finish date',
    probe('momentKeyFor(' + JSON.stringify(FAY) + ', ' + JSON.stringify(Object.assign({}, finishBook, { dateFinished: null })) + ')') === '');
  ok('the key claims no secrecy: entitlement lives in the RPC + RLS, not the key',
    key1.split(':').length === 3 && key1.split(':')[0] === FAY);
  const old = probe('momentsFromBooks(' + JSON.stringify(FAY) + ', [' +
    JSON.stringify(Object.assign({}, finishBook, { id: 'book-old', dateFinished: dayAgo(120) })) + ']).length');
  ok('finishes older than the 90-day window are not moments', old === 0);

  /* ---------- reaction set shape ---------- */
  ok('reaction set: five warm kinds, all icons exist in ICONS',
    probe('REACTION_KINDS.length') === 5 &&
    probe('REACTION_KINDS.every(k => !!ICONS[k.icon])') === true);
  ok('reaction set has no negative/downvote kind',
    probe('REACTION_KINDS.every(k => ["heart","sparkles","moon","trophy","smile"].indexOf(k.id) !== -1)') === true);

  /* ---------- gating: opt-in + shield by construction ---------- */
  // FAY opted in with two finishes (one high-spice); GUS opted OUT of
  // activity (share_activity false → his books are never fetched for
  // stats, the loadCovenStats rule) — modelled here by only FAY's and
  // ME's books reaching momentsFromBooks through loadCovenStats.
  stub.db.profiles[GUS].share_activity = false; // opted OUT: no moments from GUS
  stub.db.books.push(
    bookRow(FAY, 'book-dune', 'Dune', 'read', 2),
    bookRow(FAY, 'book-filthy', 'Filthy Tome', 'read', 1, { ratings: { spice: 5 } }),
    bookRow(GUS, 'book-gus', 'Gus Book', 'read', 1),
    bookRow(ME, 'book-mine', 'My Finish', 'read', 3),
  );
  runInWindow('library = ' + JSON.stringify([Object.assign({}, finishBook, { id: 'book-mine', title: 'My Finish', dateFinished: dayAgo(3) })]) + ';');
  useAs(ME);
  const stats = await probe('loadCovenStats()'); await tick();
  const momentTitles = (stats.moments || []).map(m => m.title);
  ok('moments include an opted-in friend’s finish', momentTitles.indexOf('Dune') !== -1);
  ok('moments include my own finish (where received reactions land)', momentTitles.indexOf('My Finish') !== -1);
  ok('no moments for the friend who opted out of activity', momentTitles.indexOf('Gus Book') === -1);

  // Shield on: FAY's spice-5 finish must vanish from MY moments, and a
  // reactions fetch for the rendered set must never ask for its key.
  runInWindow('setShield(true)');
  const shielded = await probe('loadCovenStats()'); await tick();
  const shTitles = (shielded.moments || []).map(m => m.title);
  ok('shielded: the high-spice finish produces no moment', shTitles.indexOf('Filthy Tome') === -1 && shTitles.indexOf('Dune') !== -1);
  const filthyKey = probe('momentKeyFor(' + JSON.stringify(FAY) + ', ' +
    JSON.stringify({ id: 'book-filthy', title: 'Filthy Tome', status: 'read', dateFinished: dayAgo(1) }) + ')');
  stub.db.queries.length = 0;
  await probe('reactionsFetch(' + JSON.stringify((shielded.moments || []).map(m => m.key)) + ')'); await tick();
  ok('shielded: reaction data for the filtered moment is never requested',
    stub.db.queries.length === 1 && stub.db.queries[0].indexOf(filthyKey) === -1);
  runInWindow('setShield(false)');

  /* ---------- the round-trip: set → change → remove ---------- */
  const fayMoment = (stats.moments || []).find(m => m.title === 'Dune');
  ok('moment carries owner + key for the write path', !!fayMoment && fayMoment.ownerId === FAY);
  useAs(ME);
  ok('set a reaction', await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "heart")') === true);
  let rows = stub.db.moment_reactions.filter(r => r.moment_key === fayMoment.key);
  ok('one row stored, giver = me, owner = the friend', rows.length === 1 && rows[0].giver_id === ME && rows[0].owner_id === FAY && rows[0].kind === 'heart');
  ok('change the reaction (one per person — still one row)',
    await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "moon")') === true &&
    stub.db.moment_reactions.filter(r => r.moment_key === fayMoment.key).length === 1 &&
    stub.db.moment_reactions[0].kind === 'moon');
  ok('an unknown kind is refused client-side',
    await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "thumbsdown")') === false &&
    stub.db.moment_reactions.filter(r => r.moment_key === fayMoment.key).length === 1);

  /* ---------- the write gate is the server, not the client ----------
     Each of these asks the RPC directly (via reactionSet) AFTER the
     owner's posture changed — the honest app would never render the
     moment in these states, but a hand-built client could ask, and
     the answer must still be no. */
  stub.db.profiles[FAY].share_activity = false;
  ok('owner turns activity OFF → existing reaction can no longer be changed',
    await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "heart")') === false &&
    stub.db.moment_reactions.filter(r => r.moment_key === fayMoment.key)[0].kind === 'moon');
  stub.db.profiles[FAY].share_activity = true;
  stub.db.profiles[FAY].hidden_shelves = ['read'];
  ok('owner hides the read shelf → reactions stop',
    await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "heart")') === false);
  stub.db.profiles[FAY].hidden_shelves = [];
  ok('a phantom moment (book that does not exist) is refused by the server',
    await probe('reactionSet(' + JSON.stringify(Object.assign({}, fayMoment,
      { key: FAY + ':book-nope:' + fayMoment.day, bookId: 'book-nope' })) + ', "heart")') === false);
  ok('a direct table write is refused (no insert policy — RPC or nothing)',
    (await window.__sbStub.from('moment_reactions').upsert(
      { moment_key: fayMoment.key, owner_id: FAY, giver_id: ME, kind: 'heart' })).error !== null);

  /* ---------- visibility: giver / owner / third friend / stranger ---------- */
  // A second reaction on the same moment, from GUS (FAY's other friend).
  useAs(GUS);
  ok('a second friend can react to the same moment', await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "sparkles")') === true);
  // ME fetches: RLS returns only rows where ME is giver or owner.
  useAs(ME);
  const meSees = await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])');
  ok('giver sees ONLY their own reaction on a friend’s moment',
    meSees.length === 1 && meSees[0].giver_id === ME);
  ok('giver’s strip renders their own chip and not the other giver’s',
    (() => { const h = probe('rxStripHTML(' + JSON.stringify(fayMoment) + ', ' + JSON.stringify(meSees) + ')');
      return h.indexOf('You') !== -1 && h.indexOf('Gus') === -1; })());
  // Owner fetches: sees BOTH, as individuals. (FAY's client populates
  // its own circProfiles via circleLists — that's where chip names
  // come from in production too.)
  useAs(FAY);
  await probe('circleLists()'); await tick();
  const faySees = await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])');
  ok('owner sees every reaction on their moment', faySees.length === 2);
  const fayStrip = probe('rxStripHTML(' + JSON.stringify(fayMoment) + ', ' + JSON.stringify(faySees) + ')');
  ok('owner’s strip shows each giver as an individual chip (names, kinds)',
    fayStrip.indexOf('Me') !== -1 && fayStrip.indexOf('Gus') !== -1 && (fayStrip.match(/rx-chip/g) || []).length === 2);
  ok('no chip or strip renders a tally (no ×N, no "N reactions")',
    !/×\s*\d|\d+\s*reactions?/i.test(fayStrip) &&
    !/×\s*\d|\d+\s*reactions?/i.test(probe('momentRowHTML(' + JSON.stringify(fayMoment) + ')')));
  // A third friend who is NOT a giver on this moment and NOT the owner:
  // simulate by asking as NOVA (stranger) — RLS gives her nothing; and
  // as GUS fetching a moment he didn't react to — also owner/giver only.
  useAs(NOVA);
  const novaSees = await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])');
  ok('a non-friend cannot read any reaction on the moment', novaSees.length === 0);
  ok('a non-friend cannot insert a reaction (no accepted link)',
    await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "heart")') === false);
  ok('the owner cannot react to their own moment',
    await (async () => { useAs(FAY); const r = await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "heart")'); useAs(ME); return r; })() === false);

  /* ---------- remove round-trip ---------- */
  useAs(ME);
  ok('remove my reaction', await probe('reactionRemove(' + JSON.stringify(fayMoment.key) + ')') === true &&
    stub.db.moment_reactions.filter(r => r.moment_key === fayMoment.key && r.giver_id === ME).length === 0);
  ok('the other giver’s reaction survives my removal',
    stub.db.moment_reactions.filter(r => r.moment_key === fayMoment.key && r.giver_id === GUS).length === 1);

  /* ---------- rendered feed: rows + wiring ---------- */
  useAs(ME);
  const d2 = await probe('loadCovenStats()'); await tick();
  runInWindow('document.body.insertAdjacentHTML("beforeend", \'<div id="stats-slot"></div>\')');
  const slot = window.document.getElementById('stats-slot');
  slot.innerHTML = probe('covenStatsHTML(' + JSON.stringify(d2) + ')');
  ok('the Activity feed renders a Recent finishes card with the friend’s moment',
    slot.innerHTML.indexOf('Recent finishes') !== -1 && slot.innerHTML.indexOf('Dune') !== -1);
  ok('a friend’s moment row offers React; my own moment row does not',
    !!slot.querySelector('[data-react="' + fayMoment.key + '"]') &&
    !slot.querySelector('[data-react="' + (d2.moments.find(m => m.title === 'My Finish') || {}).key + '"]'));
  await probe('wireMomentReactions(document.getElementById("stats-slot"), ' +
    JSON.stringify(d2.moments) + ')'); await tick(3);
  // GUS's sparkles is on FAY's moment; I am neither giver (removed) nor
  // owner → my strip for that moment must be empty even after wiring.
  const strip = slot.querySelector('[data-mstrip="' + fayMoment.key + '"]');
  ok('after wiring, a third-party reaction stays invisible on the giver-side view',
    !!strip && strip.innerHTML === '');
  // React through the picker UI itself.
  slot.querySelector('[data-react="' + fayMoment.key + '"]').click(); await tick();
  const picker = slot.querySelector('[data-mpicker="' + fayMoment.key + '"]');
  ok('React opens the picker with the five kinds', !!picker && !picker.hidden &&
    picker.querySelectorAll('.rx-kind[data-kind]').length === 5);
  picker.querySelector('[data-kind="trophy"]').click(); await tick(3);
  ok('picking a kind stores it and paints my chip',
    stub.db.moment_reactions.some(r => r.moment_key === fayMoment.key && r.giver_id === ME && r.kind === 'trophy') &&
    slot.querySelector('[data-mstrip="' + fayMoment.key + '"]').innerHTML.indexOf('You') !== -1);

  /* ---------- v532: the read posture follows the owner's CURRENT sharing ----------
     The giver's row still EXISTS in the table throughout — what
     changes is whether RLS hands it to the giver. The owner reads
     it in every state. */
  useAs(ME);
  ok('v532: giver reads their reaction while the owner is sharing',
    (await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])')).length === 1);
  stub.db.profiles[FAY].share_activity = false;
  ok('v532: owner turns activity OFF → the giver reads nothing (the row still exists)',
    (await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])')).length === 0 &&
    stub.db.moment_reactions.some(r => r.moment_key === fayMoment.key && r.giver_id === ME));
  useAs(FAY);
  ok('v532: the owner still reads every reaction while activity is off',
    (await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])')).length === 2);
  useAs(ME);
  stub.db.profiles[FAY].share_activity = true;
  stub.db.profiles[FAY].hidden_shelves = ['read'];
  ok('v532: owner hides the Read shelf → the giver reads nothing',
    (await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])')).length === 0);
  useAs(FAY);
  ok('v532: the owner still reads every reaction while the Read shelf is hidden',
    (await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])')).length === 2);
  stub.db.profiles[FAY].hidden_shelves = [];
  useAs(ME);
  ok('v532: posture restored → the giver reads their reaction again',
    (await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])')).length === 1);
  useAs(NOVA);
  ok('v532: a third party reads nothing in every posture',
    (await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])')).length === 0);
  useAs(ME);

  /* ---------- pre-migration tolerance ---------- */
  const realRpc = stub.rpc;
  stub.rpc = () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.react_to_moment' } });
  ok('missing RPC (pre-migration): the write no-ops and the missing latch sets',
    await probe('reactionSet(' + JSON.stringify(fayMoment) + ', "heart")') === false &&
    probe('rxTableMissing') === true);
  ok('missing table: fetch resolves empty while latched (feed still renders)',
    (await probe('reactionsFetch([' + JSON.stringify(fayMoment.key) + '])')).length === 0);
  stub.rpc = realRpc;
  runInWindow('rxTableMissing = false');

  /* ---------- feed composition: my moments can't be crowded out ---------- */
  for (let i = 0; i < 25; i++) stub.db.books.push(bookRow(FAY, 'book-flood-' + i, 'Flood ' + i, 'read', (i % 28) + 1));
  runInWindow('library = ' + JSON.stringify([1, 2, 3].map(n => ({
    id: 'book-own-' + n, title: 'Own ' + n, authors: ['Me'], status: 'read', dateFinished: dayAgo(n + 3),
  }))) + ';');
  const flood = await probe('loadCovenStats()'); await tick();
  ok('feed stays capped at 30 with a prolific friend',
    (flood.moments || []).length > 0 && (flood.moments || []).length <= 30);
  ok('all of my own finishes survive the cap (received reactions stay visible)',
    [1, 2, 3].every(n => (flood.moments || []).some(m => m.title === 'Own ' + n)));

  /* ---------- migration shape (SQL pins) ---------- */
  const sql = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v525_moment_reactions.sql'), 'utf8');
  ok('migration creates moment_reactions with RLS enabled',
    /create table if not exists public\.moment_reactions/.test(sql) &&
    /alter table public\.moment_reactions enable row level security/.test(sql));
  ok('migration: one reaction per person per moment (PK) + no self-reaction check',
    /primary key \(moment_key, giver_id\)/.test(sql) && /check \(giver_id <> owner_id\)/.test(sql));
  ok('migration: kind is constrained to the warm set',
    REACTION_KINDS_SQL.every(k => sql.indexOf("'" + k + "'") !== -1));
  ok('migration: SELECT is giver-or-owner only (no third-friend enumeration)',
    /for select[\s\S]{0,200}auth\.uid\(\) = giver_id or auth\.uid\(\) = owner_id/.test(sql));
  ok('migration: NO insert/update policies — writes go through the RPC only',
    !/create policy[^;]*moment_reactions[^;]*for (insert|update)/.test(sql) &&
    /create or replace function public\.react_to_moment/.test(sql) &&
    /security definer/.test(sql));
  ok('migration: the RPC re-validates friendship + current activity opt-in + shelf visibility + the real book',
    /react_to_moment[\s\S]*status = 'accepted'/.test(sql) &&
    /p\.share_activity = true/.test(sql) &&
    /circle_book_visible\(p_owner, 'read'\)/.test(sql) &&
    /b\.data ->> 'status' = 'read'/.test(sql));
  ok('migration: DELETE is giver-only (no owner-delete in v1)',
    /for delete[\s\S]{0,200}using \(auth\.uid\(\) = giver_id\)/.test(sql));
  ok('migration: unfriending removes the pair’s reactions (trigger on circle_links delete)',
    /moment_reactions_unfriend/.test(sql) && /after delete on public\.circle_links/.test(sql));
  const schema = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
  ok('schema.sql mirrors the table + its policies',
    schema.indexOf('moment_reactions') !== -1 && /giver or owner reads reactions/.test(schema));

  /* ---------- v532 migration shape (read posture) ---------- */
  const sql532 = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v532_reactions_read_posture.sql'), 'utf8');
  ok('v532: the posture helper is a definer function composing both facts',
    /create or replace function public\.moment_owner_sharing\(p_owner uuid\)/.test(sql532) &&
    /security definer/.test(sql532) &&
    /p\.share_activity/.test(sql532) &&
    /circle_book_visible\(p_owner, 'read'\)/.test(sql532));
  ok('v532: the helper is granted to authenticated only',
    /revoke all on function public\.moment_owner_sharing\(uuid\) from public/.test(sql532) &&
    /grant execute on function public\.moment_owner_sharing\(uuid\) to authenticated/.test(sql532));
  ok('v532: the SELECT policy gates only the giver branch on the helper',
    /auth\.uid\(\) = owner_id\s+or \(auth\.uid\(\) = giver_id and public\.moment_owner_sharing\(owner_id\)\)/.test(sql532));
  ok('v532: the DELETE policy is untouched by the migration',
    !/for delete/.test(sql532));
  ok('v532: schema.sql mirrors the helper + restated policy in place',
    /create or replace function public\.moment_owner_sharing\(p_owner uuid\)/.test(schema) &&
    /auth\.uid\(\) = giver_id and public\.moment_owner_sharing\(owner_id\)/.test(schema));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });

const REACTION_KINDS_SQL = ['heart', 'sparkles', 'moon', 'trophy', 'smile'];
