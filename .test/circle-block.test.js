// Blocking (v526): sever + silence + sticky, enforced in the database.
//
// The contract under test:
// - A block row is readable ONLY by its creator. The blocked party can
//   read NOTHING about it — no row, no count, no existence probe — so
//   there is deliberately no pair_blocked() helper a caller could
//   invoke (it would be an oracle); the both-directions check is
//   inlined in the view / SECURITY DEFINER functions instead.
// - Inserting a block severs the pair's circle links in the same
//   transaction (trigger), which fires the v525 unfriend trigger, so
//   the pair's moment reactions die with the friendship.
// - While a block stands either way, no link can be created: invite
//   redemption raises the SAME 'invite not found' as a dead token, and
//   the direct-insert policy on circle_links is gone (creation is
//   RPC-only), because a policy cannot see the "they blocked me" half.
// - Even with an anomalous link row present, the projection and the
//   books path exclude a blocked pair outright.
// The stub below emulates those semantics faithfully; the SQL text
// assertions pin the real enforcement in BOTH the migration and
// schema.sql.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in circle-block tests'); };
window.confirm = () => true;

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

/* ================= SQL shape: the real enforcement ================= */
const mig = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v526_blocks.sql'), 'utf8');
const schema = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
for (const [label, sql] of [['migration', mig], ['schema.sql', schema]]) {
  ok(label + ': blocks table with (blocker, blocked) PK and no-self check',
    /create table if not exists public\.blocks/.test(sql) &&
    /primary key \(blocker_id, blocked_id\)/.test(sql) &&
    /check \(blocker_id <> blocked_id\)/.test(sql));
  ok(label + ': blocks RLS enabled', /alter table public\.blocks enable row level security/.test(sql));
  ok(label + ': read policy is creator-only',
    /create policy "read own blocks" on public\.blocks\s+for select\s+using \(auth\.uid\(\) = blocker_id\)/.test(sql));
  ok(label + ': insert policy is creator-only',
    /create policy "block a reader" on public\.blocks\s+for insert\s+with check \(auth\.uid\(\) = blocker_id\)/.test(sql));
  ok(label + ': delete policy is creator-only (unblock)',
    /create policy "unblock a reader" on public\.blocks\s+for delete\s+using \(auth\.uid\(\) = blocker_id\)/.test(sql));
  ok(label + ': NO update policy on blocks (created or deleted, never edited)',
    !/create policy "[^"]*" on public\.blocks\s+for update/.test(sql));
  ok(label + ': no blocks policy ever keys visibility to the blocked party',
    !/on public\.blocks[\s\S]{0,200}using \(auth\.uid\(\) = blocked_id\)/.test(sql));
  ok(label + ': sever trigger deletes the pair links in BOTH directions',
    /create trigger blocks_sever\s+after insert on public\.blocks/.test(sql) &&
    /requester_id = new\.blocker_id and addressee_id = new\.blocked_id/.test(sql) &&
    /requester_id = new\.blocked_id and addressee_id = new\.blocker_id/.test(sql));
  ok(label + ': sever function is SECURITY DEFINER with pinned search_path, revoked from public',
    /function public\.blocks_sever_links\(\)[\s\S]{0,200}security definer/.test(sql) &&
    /revoke all on function public\.blocks_sever_links\(\) from public/.test(sql) &&
    !/grant execute on function public\.blocks_sever_links/.test(sql));
  ok(label + ': my_blocked_readers returns ONLY the caller\'s own blocks',
    /where b\.blocker_id = auth\.uid\(\)/.test(sql) &&
    /grant execute on function public\.my_blocked_readers\(\) to authenticated/.test(sql));
  ok(label + ': accept_circle_invite checks the pair and raises the dead-token error',
    (sql.match(/raise exception 'invite not found'/g) || []).length === 2 &&
    /select 1 from public\.blocks b\s+where \(b\.blocker_id = v_me and b\.blocked_id = v_them\)/.test(sql));
  ok(label + ': circle_profiles excludes blocked pairs inside the link branch',
    /create or replace view public\.circle_profiles[\s\S]*?not exists \(\s+select 1 from public\.blocks b/.test(sql));
  ok(label + ': circle_book_visible answers false for a blocked pair BEFORE the link test',
    (() => { const i = sql.indexOf('b.blocker_id = auth.uid() and b.blocked_id = p_owner');
             const j = sql.indexOf('select 1 from public.circle_links cl', i);
             return i !== -1 && j > i; })());
  ok(label + ': "send requests" direct-insert policy is dropped, never created',
    /drop policy if exists "send requests" on (public\.)?circle_links/.test(sql) &&
    !/create policy "send requests"/.test(sql));
  ok(label + ': "answer requests" refuses an answerer who blocked the requester',
    /create policy "answer requests" on (public\.)?circle_links[\s\S]{0,400}not exists \(\s+select 1 from public\.blocks b\s+where b\.blocker_id = auth\.uid\(\)/.test(sql));
  ok(label + ': NO caller-invokable pair_blocked helper exists (it would be an oracle)',
    !/function public\.(circle_)?pair_blocked/.test(sql));
}

/* ================= stub: faithful v522+v525+v526 semantics ================= */
const ME = 'user-me', PAL = 'user-pal', PET = 'user-pet', REX = 'user-rex';
const mkStub = () => {
  const db = {
    circle_links: [], circle_invites: [], profiles: {}, books: [], blocks: [], moment_reactions: [],
  };
  const asUser = () => window.__uid;
  const pairBlocked = (a, b) => db.blocks.some(x =>
    (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
  const linked = (a, b, statuses) => db.circle_links.some(l => statuses.indexOf(l.status) !== -1 &&
    ((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
  // v525 unfriend trigger emulation: after a link row is deleted, if no
  // accepted link remains between the pair, their reactions die.
  const unfriendSweep = (a, b) => {
    if (!linked(a, b, ['accepted'])) {
      db.moment_reactions = db.moment_reactions.filter(r =>
        !((r.owner_id === a && r.giver_id === b) || (r.owner_id === b && r.giver_id === a)));
    }
  };
  const severPair = (a, b) => {
    const before = db.circle_links.length;
    db.circle_links = db.circle_links.filter(l =>
      !((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
    if (db.circle_links.length !== before) unfriendSweep(a, b);
  };
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
  const rowsOf = (name) => {
    const me = asUser();
    if (name === 'profiles') return Object.values(db.profiles).filter(p => p.user_id === me); // v522: base rows owner-only
    if (name === 'circle_profiles') {
      // v522 view + v526 exclusion: self, or linked (accepted/pending) and not blocked either way.
      return Object.values(db.profiles)
        .filter(p => p.user_id === me || (linked(me, p.user_id, ['accepted', 'pending']) && !pairBlocked(me, p.user_id)))
        .map(projectPublic);
    }
    if (name === 'blocks') return db.blocks.filter(b => b.blocker_id === me); // own rows ONLY
    if (name === 'circle_links') return db.circle_links.filter(l => l.requester_id === me || l.addressee_id === me);
    if (name === 'books') {
      return db.books.filter(r => {
        if (r.user_id === me) return true;
        const owner = db.profiles[r.user_id];
        if (!owner || !linked(me, r.user_id, ['accepted']) || pairBlocked(me, r.user_id)) return false;
        if (owner.share_library === false) return false;
        return (owner.hidden_shelves || []).indexOf(r.data && r.data.status) === -1;
      });
    }
    return db[name];
  };
  const applyConds = (rows, conds) => rows.filter(r => conds.every(([c, v]) => r[c] === v));
  const rlsErr = { code: '42501', message: 'new row violates row-level security policy' };
  const missingErr = (what) => ({ code: 'PGRST205', message: "Could not find the table 'public." + what + "' in the schema cache" });
  const table = (name) => ({
    select(cols) {
      const q = { _conds: [], _in: null,
        eq(c, v) { q._conds.push([c, v]); return q; },
        in(c, vs) { q._in = [c, vs]; return q; },
        ne() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
        maybeSingle() {
          if (name === 'blocks' && stub.missingBlocks) return Promise.resolve({ data: null, error: missingErr('blocks') });
          const rs = q._run();
          return Promise.resolve({ data: rs[0] || null, error: null });
        },
        _run() {
          let rs = rowsOf(name);
          rs = applyConds(rs, q._conds);
          if (q._in) rs = rs.filter(r => q._in[1].indexOf(r[q._in[0]]) !== -1);
          return rs;
        },
        then(res, rej) {
          try {
            if (name === 'blocks' && stub.missingBlocks) return res({ data: null, error: missingErr('blocks') });
            res({ data: q._run(), error: null });
          } catch (e) { rej(e); }
        },
      };
      return q;
    },
    insert(row) {
      if (name === 'blocks') {
        if (stub.missingBlocks) return Promise.resolve({ error: missingErr('blocks') });
        const me = asUser();
        if (!me || row.blocker_id !== me || row.blocker_id === row.blocked_id) return Promise.resolve({ error: rlsErr });
        if (db.blocks.some(b => b.blocker_id === row.blocker_id && b.blocked_id === row.blocked_id)) {
          return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "blocks_pkey"' } });
        }
        db.blocks.push({ blocker_id: row.blocker_id, blocked_id: row.blocked_id, created_at: new Date().toISOString() });
        severPair(row.blocker_id, row.blocked_id); // blocks_sever trigger
        return Promise.resolve({ error: null });
      }
      if (name === 'circle_links') {
        // v526: the direct-insert policy is dropped — creation is RPC-only.
        return Promise.resolve({ error: rlsErr });
      }
      db[name].push(row);
      return Promise.resolve({ error: null });
    },
    upsert(row) {
      if (name === 'profiles') { db.profiles[row.user_id] = Object.assign({}, db.profiles[row.user_id], row); return Promise.resolve({ error: null }); }
      return Promise.resolve({ error: null });
    },
    update(patch) {
      const q = { _conds: [],
        eq(c, v) { q._conds.push([c, v]); return q; },
        then(res, rej) {
          try {
            if (name === 'circle_links') {
              const me = asUser();
              const targets = db.circle_links.filter(r => q._conds.every(([c, v]) => r[c] === v));
              // "answer requests" emulation: addressee + pending only, and
              // (v526) the answerer must not have blocked the requester.
              for (const r of targets) {
                if (r.addressee_id !== me || r.status !== 'pending') return res({ data: null, error: rlsErr });
                if (patch.status === 'accepted' || patch.status === 'declined') {
                  if (db.blocks.some(b => b.blocker_id === me && b.blocked_id === r.requester_id)) {
                    return res({ data: null, error: rlsErr });
                  }
                }
                Object.assign(r, patch);
              }
              return res({ data: targets, error: null });
            }
            res({ data: [], error: null });
          } catch (e) { rej(e); }
        },
      };
      return q;
    },
    delete() {
      const dq = { _conds: [],
        eq(c, v) { dq._conds.push([c, v]); return dq; },
        then(res, rej) {
          try {
            const me = asUser();
            if (name === 'blocks') {
              if (stub.missingBlocks) return res({ data: null, error: missingErr('blocks') });
              db.blocks = db.blocks.filter(r => !(r.blocker_id === me && dq._conds.every(([c, v]) => r[c] === v)));
              return res({ data: [], error: null });
            }
            if (name === 'circle_links') {
              const gone = db.circle_links.filter(r => dq._conds.every(([c, v]) => r[c] === v) &&
                (r.requester_id === me || r.addressee_id === me));
              db.circle_links = db.circle_links.filter(r => gone.indexOf(r) === -1);
              gone.forEach(r => unfriendSweep(r.requester_id, r.addressee_id));
              return res({ data: [], error: null });
            }
            res({ data: [], error: null });
          } catch (e) { rej(e); }
        },
      };
      return dq;
    },
  });
  const stub = { db, missingBlocks: false, from: (t) => table(t),
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'not found' } }) }) } };
  stub.rpc = (fn, args) => {
    const me = asUser();
    const err = (m, code) => Promise.resolve({ data: null, error: { code: code || 'P0001', message: m } });
    if (fn === 'accept_circle_invite') {
      if (!me) return err('not signed in');
      const inv = db.circle_invites.find(i => i.code === (args && args.p_token));
      if (!inv) return err('invite not found');
      if (pairBlocked(me, inv.user_id)) return err('invite not found'); // identical shape — silence
      if (inv.user_id === me) return err('own invite');
      severPairRaw(me, inv.user_id);
      db.circle_links.push({ requester_id: me, addressee_id: inv.user_id, status: 'accepted', created_at: new Date().toISOString() });
      return Promise.resolve({ data: inv.user_id, error: null });
    }
    if (fn === 'my_blocked_readers') {
      if (stub.missingBlocks) return err("Could not find the function public.my_blocked_readers in the schema cache", 'PGRST202');
      if (!me) return err('not signed in');
      const rows = db.blocks.filter(b => b.blocker_id === me).map(b => {
        const p = db.profiles[b.blocked_id] || {};
        return { user_id: b.blocked_id, first_name: p.first_name || '', last_name: p.last_name || '',
          avatar_id: p.avatar_id || '', avatar_path: p.avatar_path || '', blocked_at: b.created_at };
      });
      return Promise.resolve({ data: rows, error: null });
    }
    return err('unknown rpc ' + fn);
  };
  // accept_circle_invite deletes pair links WITHOUT the unfriend sweep
  // mattering (it immediately re-creates an accepted row).
  function severPairRaw(a, b) {
    db.circle_links = db.circle_links.filter(l =>
      !((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
  }
  return stub;
};

const stub = mkStub();
const useAs = (uid) => {
  window.__uid = uid;
  runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "' + uid + '@x.y" }' : 'null') + ';');
};

(async () => {
  require('./harness').loadApp(window);
  await tick(3);
  window.__sbStub = stub;
  const db = stub.db;
  const prof = (id, fn, ln) => { db.profiles[id] = { user_id: id, first_name: fn, last_name: ln, gender: 'x',
    avatar_id: '', avatar_path: '', share_library: true, hidden_shelves: [], bio: '', fav_genres: [],
    share_bio: true, share_activity: true, updated_at: '2026-10-01T00:00:00Z' }; };
  prof(ME, 'Me', 'Myself'); prof(PAL, 'Pal', 'Reader'); prof(PET, 'Pet', 'Asker'); prof(REX, 'Rex', 'Control');
  db.circle_links.push(
    { requester_id: ME, addressee_id: PAL, status: 'accepted', created_at: '2026-09-01T00:00:00Z' },
    { requester_id: ME, addressee_id: REX, status: 'accepted', created_at: '2026-09-01T00:00:00Z' },
    { requester_id: PET, addressee_id: ME, status: 'pending', created_at: '2026-09-02T00:00:00Z' },
  );
  db.circle_invites.push(
    { user_id: ME, code: 'code-me-123456', created_at: '2026-09-01T00:00:00Z' },
    { user_id: PAL, code: 'code-pal-123456', created_at: '2026-09-01T00:00:00Z' },
  );
  const bookRow = (user_id, book_id, data) => ({ user_id, book_id, isbn: null, data });
  db.books.push(bookRow(PAL, 'pal1', { id: 'pal1', title: 'Pal Book', authors: ['A'], status: 'read', dateFinished: new Date().toISOString() }));
  db.books.push(bookRow(ME, 'me1', { id: 'me1', title: 'My Book', authors: ['B'], status: 'read', dateFinished: new Date().toISOString() }));
  db.moment_reactions.push(
    { moment_key: PAL + ':pal1:2026-10-12', owner_id: PAL, giver_id: ME, kind: 'heart', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' },
    { moment_key: ME + ':me1:2026-10-12', owner_id: ME, giver_id: PAL, kind: 'moon', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' },
    { moment_key: ME + ':me1:2026-10-12', owner_id: ME, giver_id: REX, kind: 'trophy', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' },
  );

  /* ---------- baseline ---------- */
  useAs(ME);
  let lists = await probe('circleLists()'); await tick();
  ok('baseline: PAL and REX are friends, PET is a pending request',
    lists.friends.some(f => f.id === PAL) && lists.friends.some(f => f.id === REX) &&
    lists.received.some(r => r.id === PET));
  ok('baseline: friend books load', (await probe('circleFriendBooks("' + PAL + '")')).length === 1);

  /* ---------- sever on block ---------- */
  await probe('circleBlock("' + PAL + '")'); await tick();
  ok('block row recorded (mine)', db.blocks.length === 1 && db.blocks[0].blocker_id === ME && db.blocks[0].blocked_id === PAL);
  ok('sever: the accepted link is gone', !db.circle_links.some(l =>
    (l.requester_id === ME && l.addressee_id === PAL) || (l.requester_id === PAL && l.addressee_id === ME)));
  ok('reactions: the pair\'s reactions died with the friendship (v525 trigger path)',
    !db.moment_reactions.some(r => (r.owner_id === PAL && r.giver_id === ME) || (r.owner_id === ME && r.giver_id === PAL)));
  ok('reactions: the control pair (ME/REX) is untouched',
    db.moment_reactions.some(r => r.owner_id === ME && r.giver_id === REX));
  lists = await probe('circleLists()'); await tick();
  ok('after block: PAL no longer appears as a friend', !lists.friends.some(f => f.id === PAL));
  ok('after block: friend profile resolves to nothing', (await probe('circleFriendProfile("' + PAL + '")')) === null);
  ok('after block: friend books are gone', (await probe('circleFriendBooks("' + PAL + '")')).length === 0);

  /* ---------- silence: the blocked party can learn NOTHING ---------- */
  useAs(PAL);
  const palBlockRows = await stub.from('blocks').select('*');
  ok('silence: PAL\'s blocks select returns only PAL\'s own rows (none) — the block on PAL is unreadable',
    Array.isArray(palBlockRows.data) && palBlockRows.data.length === 0);
  const palCount = await stub.from('blocks').select('*').eq('blocked_id', PAL);
  ok('silence: even a direct probe for rows about PAL returns nothing',
    Array.isArray(palCount.data) && palCount.data.length === 0);
  const palList = await probe('circleBlockedReaders()'); await tick();
  ok('silence: my_blocked_readers as PAL shows only people PAL blocked (none) — never ME',
    Array.isArray(palList) && palList.length === 0);
  ok('silence: PAL sees ME\'s profile as nothing (projection)', (await probe('circleFriendProfile("' + ME + '")')) === null);
  ok('silence: PAL sees none of ME\'s books', (await probe('circleFriendBooks("' + ME + '")')).length === 0);

  /* ---------- belt-and-braces: an anomalous link changes nothing ---------- */
  db.circle_links.push({ requester_id: PAL, addressee_id: ME, status: 'accepted', created_at: '2026-10-13T00:00:00Z' });
  ok('anomalous link: projection STILL excludes the blocker for the blocked party',
    (await probe('circleFriendProfile("' + ME + '")')) === null);
  ok('anomalous link: books STILL invisible to the blocked party',
    (await probe('circleFriendBooks("' + ME + '")')).length === 0);
  useAs(ME);
  ok('anomalous link: projection excludes the blocked party for the blocker too',
    (await probe('circleFriendProfile("' + PAL + '")')) === null);
  db.circle_links = db.circle_links.filter(l => !(l.requester_id === PAL && l.addressee_id === ME));

  /* ---------- sticky: no way back in while the block stands ---------- */
  useAs(PAL);
  const eBlocked = await probe('acceptInviteToken("code-me-123456").then(() => "ok", e => e.message || String(e))');
  useAs(ME);
  const eBlocker = await probe('acceptInviteToken("code-pal-123456").then(() => "ok", e => e.message || String(e))');
  const eBad = await probe('acceptInviteToken("code-nope-000000").then(() => "ok", e => e.message || String(e))');
  ok('sticky: the BLOCKED party redeeming the blocker\'s code fails', eBlocked !== 'ok');
  ok('sticky: the BLOCKER redeeming the blocked party\'s code fails too', eBlocker !== 'ok');
  ok('silence: all three failure messages are IDENTICAL (blocked either way == dead token)',
    eBlocked === 'invite not found' && eBlocker === 'invite not found' && eBad === 'invite not found');
  ok('sticky: no link was created by the refused redemptions',
    !db.circle_links.some(l => (l.requester_id === ME && l.addressee_id === PAL) || (l.requester_id === PAL && l.addressee_id === ME)));
  const directIns = await stub.from('circle_links').insert({ requester_id: PAL, addressee_id: ME, status: 'pending' });
  ok('sticky: direct REST insert into circle_links is refused (creation is RPC-only now)',
    !!directIns.error && /row-level security/.test(directIns.error.message));

  /* ---------- sever covers pending too; the answer guard ---------- */
  useAs(ME);
  await probe('circleBlock("' + PET + '")'); await tick();
  lists = await probe('circleLists()'); await tick();
  ok('sever: blocking a pending requester deletes the pending row',
    !db.circle_links.some(l => l.requester_id === PET && l.addressee_id === ME) && lists.received.length === 0);
  // An anomalous pending row (created before the block, say) cannot be answered back into a link:
  db.circle_links.push({ requester_id: PET, addressee_id: ME, status: 'pending', created_at: '2026-10-13T00:00:00Z' });
  const ans = await probe('circleAnswer("' + PET + '", true).then(() => "ok", e => "err")');
  const petRow = db.circle_links.find(l => l.requester_id === PET && l.addressee_id === ME);
  ok('answer guard: an answerer who blocked the requester cannot accept them back',
    ans === 'err' && petRow && petRow.status === 'pending');
  db.circle_links = db.circle_links.filter(l => !(l.requester_id === PET && l.addressee_id === ME));

  /* ---------- unblock: list management + fresh invite required ---------- */
  const mine = await probe('circleBlockedReaders()'); await tick();
  ok('owner list: ME sees exactly the people ME blocked (PAL + PET), with names',
    Array.isArray(mine) && mine.length === 2 &&
    mine.some(r => r.user_id === PAL && r.first_name === 'Pal') && mine.some(r => r.user_id === PET));
  await probe('circleUnblock("' + PAL + '")'); await tick();
  ok('unblock removes only my row for that pair', db.blocks.length === 1 && db.blocks[0].blocked_id === PET);
  lists = await probe('circleLists()'); await tick();
  ok('unblock does NOT restore the old friendship', !lists.friends.some(f => f.id === PAL));
  useAs(PAL);
  const rejoin = await probe('acceptInviteToken("code-me-123456").then(() => "ok", e => e.message || String(e))');
  ok('after unblock, a FRESH invite connects again', rejoin === 'ok');
  useAs(ME);
  lists = await probe('circleLists()'); await tick();
  ok('reconnected pair are friends again', lists.friends.some(f => f.id === PAL));

  /* ---------- settings list rendering ---------- */
  await probe('circleBlock("' + REX + '")'); await tick();
  runInWindow('window.__blBox = document.createElement("div"); document.body.appendChild(window.__blBox);');
  await probe('renderBlockedReaders(window.__blBox)'); await tick(3);
  const blHtml = probe('window.__blBox.innerHTML');
  ok('settings list renders the blocked readers with names (PET + REX)',
    /Blocked readers/.test(blHtml) && blHtml.indexOf('Pet') !== -1 && blHtml.indexOf('Rex') !== -1);
  ok('settings list offers Unblock per reader', (blHtml.match(/data-unblock=/g) || []).length === 2);
  ok('settings list copy says they aren\'t told and unblocking needs a fresh invite',
    /aren’t told/.test(blHtml) && /fresh invite/.test(blHtml));

  /* ---------- block confirm sheet ---------- */
  probe('openBlockSheet("' + REX + '", "Rex Control")'); await tick(2);
  const sheetHtml = probe('document.body.innerHTML');
  ok('block sheet renders with calm copy (removed, can\'t re-add, won\'t be told)',
    /Block Rex Control\?/.test(sheetHtml) && /won’t be told/.test(sheetHtml) && /neither of you will be able to add the other/.test(sheetHtml));
  ok('block sheet ships with swipe-to-dismiss wiring (standing app rule)',
    fs.readFileSync(path.join(APP_DIR, 'js/195-coven.js'), 'utf8').indexOf("wireSheetDrag(ov.querySelector('#bl-back .modal'), close)") !== -1);
  probe('document.querySelector(".collection-overlay").remove()');

  /* ---------- pre-migration tolerance ---------- */
  stub.missingBlocks = true;
  runInWindow('circBlocksState = null;');
  ok('pre-migration: circleBlocksSupported() reports false (missing-table shape)',
    (await probe('circleBlocksSupported()')) === false);
  ok('pre-migration: circleBlockedReaders() returns null so the Settings section hides',
    (await probe('circleBlockedReaders()')) === null);
  runInWindow('window.__bb = document.createElement("button"); window.__bb.setAttribute("data-block", "x"); document.body.appendChild(window.__bb);');
  await probe('applyBlockUi(document)'); await tick(2);
  ok('pre-migration: block buttons hide when the table is absent',
    probe('window.__bb.style.display') === 'none');
  const blkErr = await probe('circleBlock("' + REX + '").then(() => "resolved", e => blocksMissing(e) ? "missing" : "other:" + (e.message || e))');
  ok('pre-migration: circleBlock fails quiet with a missing-shape error (no crash, no false success)',
    blkErr === 'missing');
  ok('pre-migration: the failed block wrote nothing', db.blocks.filter(b => b.blocked_id === REX).length === 1); // the real one from before
  stub.missingBlocks = false;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
