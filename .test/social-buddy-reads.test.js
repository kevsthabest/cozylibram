// "Buddy reads" (v528, Social build #3): invite → read together →
// finish together, as a durable object between two circle friends.
//
// House discipline (migration v528, after a red-team round killed
// the first design): rows are KEY-ONLY (no book snapshot exists to
// spoof); the inviter has NO read on pendings (declines are
// invisible — fire-and-forget like v527); presence is a per-book
// grant served by buddy_states() as a bare enum (never stored,
// never derived from shelf pipelines); decline tombstones the pair +
// book for a year; pendings expire at 60 days; sends are capped;
// the recipient has an opt-out; the invite gate composes the matched
// copy's existence with ITS OWN shelf visibility (anti-oracle).
//
// The stub emulates v522–v528 RLS/RPC semantics. The REAL
// enforcement lives in supabase/migrations/v528_buddy_reads.sql
// (shape-pinned below, mirrored in schema.sql).
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP_DIR = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok -', label); } else { fail++; console.log('  NOT OK -', label); } };
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

/* ================= SQL shape: the real enforcement ================= */
const mig = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v528_buddy_reads.sql'), 'utf8');
const schema = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
for (const [label, sql] of [['migration', mig], ['schema.sql', schema]]) {
  ok(label + ': buddy_reads is KEY-ONLY (no snapshot column of any kind)',
    /create table if not exists public\.buddy_reads/.test(sql) &&
    /unique \(inviter_id, invitee_id, book_key\)/.test(sql) &&
    /check \(inviter_id <> invitee_id\)/.test(sql) &&
    /references auth\.users \(id\) on delete cascade/.test(sql) &&
    !/buddy_reads \([^)]*\bbook jsonb/.test(sql) &&
    !/create table if not exists public\.buddy_reads \([^)]*\bbook\b(?!_key)/.test(sql));
  ok(label + ': status is pending|active only',
    /status text not null default 'pending' check \(status in \('pending', 'active'\)\)/.test(sql));
  ok(label + ': machinery tables exist, RLS-locked, grants revoked, ZERO policies',
    /create table if not exists public\.buddy_send_log/.test(sql) &&
    /create table if not exists public\.buddy_dismissals/.test(sql) &&
    /alter table public\.buddy_send_log enable row level security/.test(sql) &&
    /alter table public\.buddy_dismissals enable row level security/.test(sql) &&
    /revoke all on public\.buddy_send_log from public, anon, authenticated/.test(sql) &&
    /revoke all on public\.buddy_dismissals from public, anon, authenticated/.test(sql) &&
    !/create policy "[^"]*" on public\.buddy_(send_log|dismissals)/.test(sql));
  ok(label + ': exactly ONE policy on buddy_reads (the asymmetric read)',
    (sql.match(/create policy "[^"]*" on public\.buddy_reads/g) || []).length === 1);
  ok(label + ': read policy = recipient all + inviter ACTIVE-only + link + blocked-by-me + pending expiry',
    /auth\.uid\(\) = invitee_id or \(auth\.uid\(\) = inviter_id and status = 'active'\)/.test(sql) &&
    /status = 'active' or created_at > now\(\) - interval '60 days'/.test(sql) &&
    /from public\.circle_links cl/.test(sql) &&
    /b\.blocker_id = auth\.uid\(\)/.test(sql));
  ok(label + ': receive_buddy_invites lands on profiles with default true',
    /alter table public\.profiles\s+add column if not exists receive_buddy_invites boolean not null default true/.test(sql));
  const statesFn = (sql.split('function public.buddy_states')[1] || '').split('grant execute on function public.buddy_states')[0];
  ok(label + ': buddy_states serves a BARE ENUM (no book fields, no pace fields)',
    /function public\.buddy_states\(p_id uuid\)[\s\S]{0,200}security definer/.test(sql) &&
    /jsonb_build_object\(\s*'mine', public\.buddy_reading_state/.test(sql) &&
    !/pageCount|progress|currentPage|percent/i.test(statesFn));
  ok(label + ': buddy_reading_state is private machinery (revoked, never granted)',
    /revoke all on function public\.buddy_reading_state\(uuid, text\) from public/.test(sql) &&
    !/grant execute on function public\.buddy_reading_state/.test(sql));
  ok(label + ': invite RPC — advisory pair lock, caps before silent outcomes, matched-copy gate',
    /function public\.buddy_invite\(p_friend uuid, p_book_id text\)[\s\S]{0,200}security definer/.test(sql) &&
    /pg_advisory_xact_lock\(hashtextextended\(\s*'buddy:'/.test(sql) &&
    />= 5[\s\S]{0,2000}return 'ok'/.test(sql) &&
    /public\.circle_book_visible\(p_friend, rb\.data ->> 'status'\)/.test(sql) &&
    /receive_buddy_invites into v_recv/.test(sql));
  ok(label + ': invite auto-accepts a crossed pending (mutual intent)',
    /update public\.buddy_reads set status = 'active' where id = v_ex\.id/.test(sql));
  ok(label + ': respond RPC — row lock, pending-only, decline tombstones, accept re-checks ownership',
    /function public\.buddy_respond\(p_id uuid, p_accept boolean\)[\s\S]{0,200}security definer/.test(sql) &&
    /for update/.test(sql) &&
    /v_r\.status <> 'pending'/.test(sql) &&
    /insert into public\.buddy_dismissals/.test(sql));
  ok(label + ': end RPC — either party, always ok',
    /function public\.buddy_end\(p_id uuid\)[\s\S]{0,200}security definer/.test(sql) &&
    /delete from public\.buddy_reads\s+where id = p_id and \(inviter_id = v_uid or invitee_id = v_uid\)/.test(sql));
  ok(label + ': unfriend cleanup trigger deletes the pair\u2019s rows both directions',
    /create trigger buddy_reads_unfriend_cleanup\s+after delete on public\.circle_links/.test(sql) &&
    /delete from public\.buddy_reads\s+where \(inviter_id = old\.requester_id and invitee_id = old\.addressee_id\)/.test(sql));
  ok(label + ': all four RPCs granted to authenticated only',
    (sql.match(/grant execute on function public\.buddy_(invite|respond|end|states)/g) || []).length === 4);
}

/* ---- v531: the wishlist rung (v528 ladder × v529 status) ----
 * v529 made 'wishlist' a real status, but the v528 ladder had no
 * rung for it, so a buddy read whose matching copy sits on the
 * Wishlist answered null (blank presence chip) where the same book
 * pre-remodel (tbr + tobuy) answered 'not_started'. v531 joins
 * 'wishlist' to the not_started rung — the Wishlist is the
 * pre-reading shelf by definition. v528 stays historical; the
 * CURRENT shape lives in the v531 migration + schema.sql. */
const mig531 = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v531_buddy_wishlist_rung.sql'), 'utf8');
for (const [label, sql] of [['v531 migration', mig531], ['schema.sql', schema]]) {
  const fnBody = (sql.split('function public.buddy_reading_state')[1] || '').split('$$;')[0];
  ok(label + ': buddy_reading_state maps wishlist WITH tbr to not_started (v531 rung)',
    /b\.data ->> 'status' in \('tbr', 'wishlist'\)[\s\S]{0,1200}then 'not_started'/.test(fnBody) &&
    !/b\.data ->> 'status' = 'tbr'/.test(fnBody));
  ok(label + ': the other rungs are unchanged (read/reading/dnf, same order of checks)',
    /b\.data ->> 'status' = 'read'[\s\S]{0,1200}then 'finished'/.test(fnBody) &&
    /b\.data ->> 'status' = 'reading'[\s\S]{0,1200}then 'reading'/.test(fnBody) &&
    /b\.data ->> 'status' = 'dnf'[\s\S]{0,1200}then 'set_aside'/.test(fnBody) &&
    fnBody.indexOf("then 'finished'") < fnBody.indexOf("then 'not_started'") &&
    fnBody.indexOf("then 'not_started'") < fnBody.indexOf("then 'set_aside'"));
  ok(label + ': buddy_reading_state stays private machinery (revoked, never granted)',
    /revoke all on function public\.buddy_reading_state\(uuid, text\) from public/.test(sql) &&
    !/grant execute on function public\.buddy_reading_state/.test(sql));
}

/* ---------- registration ---------- */
const indexHtml = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const swText = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
// R1 repoint (migration plan §9.3): js/233's tag is a module tag since
// its ESM conversion; the registration assertion accepts either exact
// tag form — the same assertion, coverage unchanged.
ok('index.html registers js/233-buddy-reads.js after js/232',
  indexHtml.includes('<script src="js/233-buddy-reads.js"></script>') ||
  indexHtml.includes('<script type="module" src="js/233-buddy-reads.js"></script>'));
ok('sw.js precaches 233-buddy-reads.js', swText.includes("'233-buddy-reads.js'"));

/* ================= stub (v522–v528 semantics) ================= */
const ME = 'me-1', PAL = 'pal-2', PET = 'pet-3', REX = 'rex-4', STR = 'str-5';
const ISBN = (n) => '97800000000' + String(n).padStart(2, '0');
const keyOf = (isbn, title, firstAuthor) => {
  const norm = String(isbn || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (norm.length === 10 || norm.length === 13) return 'isbn:' + norm;
  return 'ta:' + String(title || '').trim().toLowerCase() + '|' + String(firstAuthor || '').trim().toLowerCase();
};
const firstAuthorOf = (d) => !d ? '' : Array.isArray(d.authors) ? (d.authors[0] || '') : String(d.authors || '');
const keyOfRow = (row) => keyOf((row.data && row.data.isbn) || row.isbn, row.data && row.data.title, firstAuthorOf(row.data));

const mkStub = () => {
  const prof = (user_id, first_name, extra) => Object.assign({
    user_id, first_name, last_name: '', avatar_id: '', avatar_path: '',
    share_library: true, hidden_shelves: [], share_bio: true, share_activity: false,
    bio: '', fav_genres: [], receive_recos: true, receive_buddy_invites: true,
  }, extra || {});
  const brow = (user_id, id, isbn, title, author, status, extra) => ({
    user_id, book_id: id, isbn,
    data: Object.assign({ id, title, authors: [author], isbn, status, cover: '', coverColor: '' }, extra || {}),
  });
  const db = {
    circle_links: [], profiles: [
      prof(ME, 'Me'), prof(PAL, 'Pete'), prof(PET, 'Petra'), prof(REX, 'Rex'), prof(STR, 'Stray'),
    ],
    // PAL hides the 'read' shelf: the matched-copy gate must use the
    // copy's OWN status, so PAL's read copy of Secret Vale is
    // invisible even though PAL's TBR shelf is browsable.
    books: [], blocks: [], buddy_reads: [], buddy_send_log: [], buddy_dismissals: [],
    works: [], user_state: [], noBuddy: false, rpcCalls: [],
  };
  db.profiles.find(p => p.user_id === PAL).hidden_shelves = ['read'];
  db.books.push(
    brow(ME, 'me-dragon', ISBN(1), 'The Dragon Ledger', 'Robin Hobb', 'tbr'),
    brow(PAL, 'pal-dragon', ISBN(1), 'The Dragon Ledger', 'Robin Hobb', 'tbr'),
    brow(ME, 'me-meadows', ISBN(2), 'Quiet Meadows', 'A. Meadows', 'tbr'),
    brow(PAL, 'pal-meadows', ISBN(2), 'Quiet Meadows', 'A. Meadows', 'tbr'),
    brow(ME, 'me-secret', ISBN(3), 'Secret Vale', 'V. Vale', 'tbr'),
    brow(PAL, 'pal-secret', ISBN(3), 'Secret Vale', 'V. Vale', 'read'),
    brow(ME, 'me-solo', ISBN(4), 'Solo Flight', 'S. Solo', 'tbr'),
    brow(ME, 'me-sauce', ISBN(5), 'Saucy Tales', 'H. Heat', 'tbr', { ratings: { spice: 5 } }),
    brow(PAL, 'pal-sauce', ISBN(5), 'Saucy Tales', 'H. Heat', 'tbr', { ratings: { spice: 5 } }),
    brow(REX, 'rex-dragon', ISBN(1), 'The Dragon Ledger', 'Robin Hobb', 'tbr'),
    // cap pair: ME ↔ PET share six TBR books
    ...[11, 12, 13, 14, 15, 16].flatMap(n => [
      brow(ME, 'me-cap' + n, ISBN(n), 'Cap Book ' + n, 'C. Cap', 'tbr'),
      brow(PET, 'pet-cap' + n, ISBN(n), 'Cap Book ' + n, 'C. Cap', 'tbr'),
    ]),
  );
  let uid = null, seq = 0;
  const err = (message, code) => ({ data: null, error: { message, code: code || 'PGRST000' } });
  const acceptedLink = (a, b) => db.circle_links.some(l => l.status === 'accepted' &&
    ((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
  const pairBlocked = (a, b) => db.blocks.some(x => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
  const cleanupPair = (a, b) => {
    if (acceptedLink(a, b)) return;
    db.buddy_reads = db.buddy_reads.filter(r => !((r.inviter_id === a && r.invitee_id === b) || (r.inviter_id === b && r.invitee_id === a)));
  };
  const deleteLinks = (pred) => {
    const removed = db.circle_links.filter(pred);
    db.circle_links = db.circle_links.filter(l => !pred(l));
    removed.forEach(l => cleanupPair(l.requester_id, l.addressee_id));
  };
  const bookVisible = (owner, status) => {
    // circle_book_visible(owner, status) as the CALLER (uid)
    if (pairBlocked(uid, owner) || !acceptedLink(uid, owner)) return false;
    const p = db.profiles.find(x => x.user_id === owner);
    if (!p || p.share_library === false) return false;
    if ((p.hidden_shelves || []).indexOf(status || '') !== -1) return false;
    return db.books.some(b => b.user_id === owner && (b.data.status || '') === (status || ''));
  };
  const stateOf = (user, key) => {
    const have = (s) => db.books.some(b => b.user_id === user && b.data.status === s && keyOfRow(b) === key);
    if (have('read')) return 'finished';
    if (have('reading')) return 'reading';
    if (have('tbr') || have('wishlist')) return 'not_started'; // v531: wishlist shares the tbr rung
    if (have('dnf')) return 'set_aside';
    return null;
  };
  const MISSING_T = () => err('relation "public.buddy_reads" does not exist', '42P01');
  const MISSING_RPC = (fn) => err('Could not find the function public.' + fn + ' in the schema cache', 'PGRST202');
  const todayLog = () => db.buddy_send_log.filter(l => Date.now() - l.ts < 86400e3);

  const rpcFns = {
    buddy_invite(args) {
      if (db.noBuddy) return MISSING_RPC('buddy_invite');
      if (!uid) return err('not signed in');
      const row = db.books.find(b => b.user_id === uid && b.book_id === args.p_book_id);
      if (!row || !String(row.data.title || '').trim()) return err('no such book');
      if (args.p_friend === uid || !acceptedLink(uid, args.p_friend) || pairBlocked(uid, args.p_friend)) return err('not circle friends');
      const recip = db.profiles.find(p => p.user_id === args.p_friend);
      if (!recip || recip.receive_buddy_invites !== true) return { data: 'ok', error: null };
      const key = keyOfRow(row);
      if (todayLog().filter(l => l.sender_id === uid && l.recipient_id === args.p_friend).length >= 5 ||
          todayLog().filter(l => l.sender_id === uid).length >= 20) return { data: 'slow_down', error: null };
      if (db.buddy_dismissals.some(d => d.sender_id === uid && d.recipient_id === args.p_friend && d.book_key === key &&
          Date.now() - new Date(d.created_at).getTime() < 365 * 86400e3)) return { data: 'ok', error: null };
      const ex = db.buddy_reads.find(r => r.book_key === key &&
        ((r.inviter_id === uid && r.invitee_id === args.p_friend) || (r.inviter_id === args.p_friend && r.invitee_id === uid)));
      if (ex) {
        if (ex.status === 'active' || ex.inviter_id === uid) return { data: 'ok', error: null };
        ex.status = 'active';
        return { data: 'ok', error: null };
      }
      const gate = db.books.some(b => b.user_id === args.p_friend && keyOfRow(b) === key && bookVisible(args.p_friend, b.data.status));
      if (!gate) return { data: 'ok', error: null };
      db.buddy_reads.push({
        id: 'br-' + (++seq), inviter_id: uid, invitee_id: args.p_friend,
        book_key: key, status: 'pending', created_at: new Date().toISOString(),
      });
      db.buddy_send_log.push({ sender_id: uid, recipient_id: args.p_friend, ts: Date.now() });
      return { data: 'ok', error: null };
    },
    buddy_respond(args) {
      if (db.noBuddy) return MISSING_RPC('buddy_respond');
      if (!uid) return err('not signed in');
      const row = db.buddy_reads.find(r => r.id === args.p_id);
      if (!row) return { data: 'ok', error: null };
      if (row.invitee_id !== uid || row.status !== 'pending') return { data: 'ok', error: null };
      if (!acceptedLink(row.inviter_id, uid) || pairBlocked(row.inviter_id, uid)) {
        db.buddy_reads = db.buddy_reads.filter(r => r.id !== args.p_id);
        return { data: 'ok', error: null };
      }
      if (!args.p_accept) {
        const ex = db.buddy_dismissals.find(d => d.sender_id === row.inviter_id && d.recipient_id === uid && d.book_key === row.book_key);
        if (ex) ex.created_at = new Date().toISOString();
        else db.buddy_dismissals.push({ sender_id: row.inviter_id, recipient_id: uid, book_key: row.book_key, created_at: new Date().toISOString() });
        db.buddy_reads = db.buddy_reads.filter(r => r.id !== args.p_id);
        return { data: 'ok', error: null };
      }
      const owns = db.books.some(b => b.user_id === uid && keyOfRow(b) === row.book_key);
      if (!owns) {
        db.buddy_reads = db.buddy_reads.filter(r => r.id !== args.p_id);
        return { data: 'ok', error: null };
      }
      row.status = 'active';
      return { data: 'ok', error: null };
    },
    buddy_end(args) {
      if (db.noBuddy) return MISSING_RPC('buddy_end');
      if (!uid) return err('not signed in');
      db.buddy_reads = db.buddy_reads.filter(r => !(r.id === args.p_id && (r.inviter_id === uid || r.invitee_id === uid)));
      return { data: 'ok', error: null };
    },
    buddy_states(args) {
      if (db.noBuddy) return MISSING_RPC('buddy_states');
      if (!uid) return err('not signed in');
      const row = db.buddy_reads.find(r => r.id === args.p_id && (r.inviter_id === uid || r.invitee_id === uid));
      const nulls = { data: { mine: null, theirs: null }, error: null };
      if (!row || row.status !== 'active') return nulls;
      const other = row.inviter_id === uid ? row.invitee_id : row.inviter_id;
      if (!acceptedLink(uid, other) || pairBlocked(uid, other)) return nulls;
      return { data: { mine: stateOf(uid, row.book_key), theirs: stateOf(other, row.book_key) }, error: null };
    },
    accept_circle_invite() { return err('unused here'); },
    react_to_moment() { return err('unused here'); },
  };

  const rowVisible = (r) => {
    const mineHalf = (uid === r.invitee_id) || (uid === r.inviter_id && r.status === 'active');
    if (!mineHalf) return false;
    if (!(r.status === 'active' || Date.now() - new Date(r.created_at).getTime() < 60 * 86400e3)) return false;
    if (!acceptedLink(r.inviter_id, r.invitee_id)) return false;
    const other = uid === r.inviter_id ? r.invitee_id : r.inviter_id;
    if (db.blocks.some(b => b.blocker_id === uid && b.blocked_id === other)) return false;
    return true;
  };
  function table(name) {
    let mode = 'select', payload = null, single = false, maybe = false, cols = null;
    const filters = [];
    const matches = (row) => filters.every(f => f.fn(row));
    const run = () => {
      if (name === 'buddy_reads') {
        if (db.noBuddy) return MISSING_T();
        if (mode === 'select') {
          let out = db.buddy_reads.filter(r => rowVisible(r) && matches(r));
          if (cols) {
            const wanted = cols.split(',').map(s => s.trim());
            out = out.map(r => { const o = {}; wanted.forEach(c => { o[c] = r[c]; }); return o; });
          }
          return { data: out.map(r => Object.assign({}, r)), error: null };
        }
        return err('new row violates row-level security policy for table "buddy_reads"', '42501');
      }
      if (name === 'buddy_send_log' || name === 'buddy_dismissals') {
        return err('permission denied for table ' + name, '42501');
      }
      if (name === 'blocks') {
        if (mode === 'insert') {
          const row = { blocker_id: uid, blocked_id: payload.blocked_id, created_at: new Date().toISOString() };
          if (!db.blocks.some(b => b.blocker_id === row.blocker_id && b.blocked_id === row.blocked_id)) db.blocks.push(row);
          deleteLinks(l => (l.requester_id === row.blocker_id && l.addressee_id === row.blocked_id) ||
                           (l.requester_id === row.blocked_id && l.addressee_id === row.blocker_id));
          return { data: null, error: null };
        }
        if (mode === 'delete') { db.blocks = db.blocks.filter(b => !(b.blocker_id === uid && matches(b))); return { data: null, error: null }; }
        return { data: db.blocks.filter(b => b.blocker_id === uid && matches(b)), error: null };
      }
      if (name === 'profiles') {
        if (mode === 'upsert') {
          const i = db.profiles.findIndex(p => p.user_id === payload.user_id);
          if (i === -1) db.profiles.push(Object.assign({}, payload));
          else db.profiles[i] = Object.assign({}, db.profiles[i], payload);
          return { data: null, error: null };
        }
        let rows = db.profiles.filter(p => p.user_id === uid && matches(p));
        if (single || maybe) return { data: rows[0] || null, error: null };
        return { data: rows.map(r => Object.assign({}, r)), error: null };
      }
      if (name === 'user_state') {
        if (mode === 'select') {
          let rows = db.user_state.filter(r => r.user_id === uid && matches(r));
          if (single || maybe) return { data: rows[0] || null, error: null };
          return { data: rows, error: null };
        }
        if (mode === 'upsert') {
          const i = db.user_state.findIndex(r => r.user_id === (payload || {}).user_id);
          if (i === -1) db.user_state.push(Object.assign({}, payload));
          else db.user_state[i] = Object.assign({}, db.user_state[i], payload);
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
      if (name === 'works') return { data: [], error: null };
      const rows = () => (db[name] || []).slice();
      if (mode === 'select') return { data: rows().filter(matches), error: null };
      return { data: null, error: null };
    };
    const chain = {
      select(c) { cols = c; return chain; },
      eq(c, v) { filters.push({ fn: r => r[c] === v }); return chain; },
      in(c, vs) { filters.push({ fn: r => vs.indexOf(r[c]) !== -1 }); return chain; },
      gt(c, v) { filters.push({ fn: r => r[c] > v }); return chain; },
      order() { return chain; }, limit() { return chain; },
      single() { single = true; return chain; },
      maybeSingle() { maybe = true; return chain; },
      upsert(p) { mode = 'upsert'; payload = p; return chain; },
      insert(p) { mode = 'insert'; payload = p; return chain; },
      delete() { mode = 'delete'; return chain; },
      then(res, rej) { Promise.resolve().then(() => run()).then(res, rej); },
    };
    return chain;
  }
  const sb = {
    from: table,
    rpc: async (fn, args) => { db.rpcCalls.push(fn); return rpcFns[fn] ? rpcFns[fn](args || {}) : err('unknown rpc ' + fn); },
    auth: { getSession: async () => ({ data: { session: null } }) },
    storage: { from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: 'https://example.invalid/' + p } }) }) },
  };
  return { db, sb, setUid: (u) => { uid = u; }, deleteLinks, acceptedLink, keyOfRow };
};

/* ================= harness: the real app over the stub ================= */
const dom = new JSDOM(indexHtml, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window;
w.fetch = async () => { throw new Error('no network in buddy-read tests'); };
w.confirm = () => true;
require('./harness').loadApp(w);
const runInWindow = (js) => {
  const s = w.document.createElement('script');
  s.textContent = js;
  w.document.body.appendChild(s);
};
const probe = (js) => w.eval(js);
const CLIENT_BOOKS = {
  [ME]: [
    { id: 'me-dragon', title: 'The Dragon Ledger', authors: ['Robin Hobb'], isbn: ISBN(1), status: 'tbr', cover: '', coverColor: '', ratings: {} },
    { id: 'me-meadows', title: 'Quiet Meadows', authors: ['A. Meadows'], isbn: ISBN(2), status: 'tbr', cover: '', coverColor: '', ratings: {} },
    { id: 'me-sauce', title: 'Saucy Tales', authors: ['H. Heat'], isbn: ISBN(5), status: 'tbr', cover: '', coverColor: '', ratings: { spice: 5 } },
  ],
  [PAL]: [
    { id: 'pal-dragon', title: 'The Dragon Ledger', authors: ['Robin Hobb'], isbn: ISBN(1), status: 'tbr', cover: '', coverColor: '', ratings: {} },
    { id: 'pal-meadows', title: 'Quiet Meadows', authors: ['A. Meadows'], isbn: ISBN(2), status: 'tbr', cover: '', coverColor: '', ratings: {} },
    { id: 'pal-sauce', title: 'Saucy Tales', authors: ['H. Heat'], isbn: ISBN(5), status: 'tbr', cover: '', coverColor: '', ratings: { spice: 5 } },
  ],
};

(async () => {
  const stub = mkStub();
  const db = stub.db;
  const link = (a, b) => db.circle_links.push({ requester_id: a, addressee_id: b, status: 'accepted' });
  link(ME, PAL); link(ME, PET); link(ME, REX); link(PAL, REX);
  w.__sbStub = stub.sb;
  const signIn = (uidv) => {
    stub.setUid(uidv);
    runInWindow('cloudUser = ' + JSON.stringify({ id: uidv, email: uidv + '@example.test' }) + ';');
    runInWindow('library = ' + JSON.stringify(CLIENT_BOOKS[uidv] || []) + ';');
    // circProfiles is a const cache object — mutate it, never assign.
    runInWindow('Object.keys(circProfiles).forEach(k => delete circProfiles[k]); Object.assign(circProfiles, ' + JSON.stringify({
      [PAL]: { user_id: PAL, first_name: 'Pete', last_name: '', avatar_id: '', avatar_path: '', share_library: true, share_bio: true, share_activity: false },
      [ME]: { user_id: ME, first_name: 'Me', last_name: '', avatar_id: '', avatar_path: '', share_library: true, share_bio: true, share_activity: false },
      [PET]: { user_id: PET, first_name: 'Petra', last_name: '', avatar_id: '', avatar_path: '', share_library: true, share_bio: true, share_activity: false },
      [REX]: { user_id: REX, first_name: 'Rex', last_name: '', avatar_id: '', avatar_path: '', share_library: true, share_bio: true, share_activity: false },
    }) + ');');
  };
  const ev = (code) => probe(code);
  const rpc = (fn, args) => stub.sb.rpc(fn, args);
  const rowsAs = async (uidv) => {
    stub.setUid(uidv);
    const r = await stub.sb.from('buddy_reads').select('id,inviter_id,invitee_id,book_key,status');
    return r.data || [];
  };
  const renderBuddyTab = async () => {
    const view = w.document.getElementById('view');
    view.innerHTML = '<div id="stats-slot"><div id="ctab-buddy"></div></div>';
    await ev('wireBuddyReads(document.getElementById("stats-slot"))');
    await tick(6);
    return w.document.getElementById('ctab-buddy').innerHTML;
  };

  /* ---- invite round-trip + the fire-and-forget read surface ---- */
  signIn(ME);
  let r = await rpc('buddy_invite', { p_friend: PAL, p_book_id: 'me-dragon' });
  ok('invite: ME → PAL dragon lands (pending row)', r.data === 'ok' && db.buddy_reads.length === 1 && db.buddy_reads[0].status === 'pending');
  ok('invite: the row is KEY-ONLY (no book data stored)',
    Object.keys(db.buddy_reads[0]).sort().join(',') === 'book_key,created_at,id,invitee_id,inviter_id,status');
  let seen = await rowsAs(PAL);
  ok('read surface: the INVITEE sees the pending', seen.length === 1);
  seen = await rowsAs(ME);
  ok('read surface: the INVITER cannot see their own pending (fire-and-forget)', seen.length === 0);
  seen = await rowsAs(REX);
  ok('read surface: a non-pair friend sees nothing', seen.length === 0);
  seen = await rowsAs(STR);
  ok('read surface: a stranger sees nothing', seen.length === 0);

  /* ---- the invite card renders from the invitee\u2019s OWN copy ---- */
  signIn(PAL);
  let html = await renderBuddyTab();
  ok('card: renders the title (own copy), the inviter, and the consent line',
    html.includes('The Dragon Ledger') && html.includes('Me invited you to read this together') &&
    html.includes('you’ll each see whether the other has started or finished this book'));
  ok('card: Accept + Decline/Report/Block affordances present',
    /data-buddy-accept=/.test(html) && /data-buddy-decline=/.test(html) && /data-buddy-report=/.test(html) && /data-buddy-block=/.test(html));
  ok('card: NO pace surface in the invite (no %, no pages, no dates)',
    !/\d+\s*%/.test(html) && !/page/i.test(html) && !/\d{4}-\d{2}-\d{2}/.test(html));

  /* ---- accept → active; presence flows as enums only ---- */
  w.document.querySelector('[data-buddy-accept]').click();
  await tick(6);
  ok('accept: the row activates', db.buddy_reads[0].status === 'active');
  seen = await rowsAs(ME);
  ok('accept: the active read now appears for the inviter', seen.length === 1);
  // Server-side shelf facts drive state (ME started; PAL not yet).
  db.books.find(b => b.book_id === 'me-dragon').data.status = 'reading';
  let st = await (signIn(ME), rpc('buddy_states', { p_id: db.buddy_reads[0].id }));
  ok('states: enum pair from the server (mine reading / theirs not_started)',
    st.data.mine === 'reading' && st.data.theirs === 'not_started');
  st = await (signIn(STR), rpc('buddy_states', { p_id: db.buddy_reads[0].id }));
  ok('states: a non-party gets nulls (no oracle)', st.data.mine === null && st.data.theirs === null);
  signIn(ME);
  html = await renderBuddyTab();
  ok('active row: state chips render enum labels only',
    html.includes('You · Reading') && html.includes('Pete · Not started'));
  ok('active row: NO pace surface (no %, no pages, no dates)',
    !/\d+\s*%/.test(html) && !/page/i.test(html) && !/\d{4}-\d{2}-\d{2}/.test(html));
  // PAL finishes; ME still reading.
  db.books.find(b => b.book_id === 'pal-dragon').data.status = 'read';
  st = await rpc('buddy_states', { p_id: db.buddy_reads[0].id });
  ok('states: partner finish reads finished', st.data.theirs === 'finished');
  // PAL sets it aside instead (dnf outranks nothing — status precedence: read copy gone → dnf).
  db.books.find(b => b.book_id === 'pal-dragon').data.status = 'dnf';
  st = await rpc('buddy_states', { p_id: db.buddy_reads[0].id });
  ok('states: DNF is its own honest state (set_aside), not a lie', st.data.theirs === 'set_aside');
  // PAL moves their copy onto the Wishlist shelf mid-read (a real
  // status since v529): presence must answer not_started — NOT the
  // blank null the v528 ladder gave a status it had no rung for (v531).
  db.books.find(b => b.book_id === 'pal-dragon').data.status = 'wishlist';
  st = await rpc('buddy_states', { p_id: db.buddy_reads[0].id });
  ok('states: a Wishlist copy reads not_started (v531 rung), not a blank null',
    st.data.theirs === 'not_started' && st.data.mine === 'reading');
  // Both finished → the payoff line.
  db.books.find(b => b.book_id === 'pal-dragon').data.status = 'read';
  db.books.find(b => b.book_id === 'me-dragon').data.status = 'read';
  html = await renderBuddyTab();
  ok('finished together: the shared payoff line renders', html.includes('You both finished it'));
  ok('finished together: both chips say Finished', html.includes('You · Finished'));

  /* ---- stale decline cannot kill an accepted read ---- */
  r = await (signIn(PAL), rpc('buddy_respond', { p_id: db.buddy_reads[0].id, p_accept: false }));
  ok('respond: acting on an ACTIVE row is a no-op (the read survives)',
    r.data === 'ok' && db.buddy_reads.length === 1 && db.buddy_reads[0].status === 'active');

  /* ---- end: either party, silently ---- */
  r = await rpc('buddy_end', { p_id: db.buddy_reads[0].id });
  ok('end: the invitee can end the read', r.data === 'ok' && db.buddy_reads.length === 0);
  st = await rpc('buddy_states', { p_id: 'br-gone' });
  ok('end: states stop with the read', st.data.mine === null && st.data.theirs === null);

  /* ---- decline is quiet AND final (tombstone) ---- */
  r = await (signIn(ME), rpc('buddy_invite', { p_friend: PAL, p_book_id: 'me-meadows' }));
  ok('decline setup: meadows invite lands', r.data === 'ok' && db.buddy_reads.length === 1);
  html = await (signIn(PAL), renderBuddyTab());
  w.document.querySelector('[data-buddy-decline]').click();
  await tick(6);
  ok('decline: the row dies and a machinery tombstone remembers',
    db.buddy_reads.length === 0 && db.buddy_dismissals.length === 1);
  seen = await rowsAs(ME);
  ok('decline: the inviter\u2019s surface shows nothing (no receipt)', seen.length === 0);
  r = await (signIn(ME), rpc('buddy_invite', { p_friend: PAL, p_book_id: 'me-meadows' }));
  ok('decline: re-inviting the same book is a silent ok that creates NO row',
    r.data === 'ok' && db.buddy_reads.length === 0);

  /* ---- anti-oracle gates: all silent, all distinct causes ---- */
  r = await rpc('buddy_invite', { p_friend: PAL, p_book_id: 'me-secret' });
  ok('gate: invitee copy on a HIDDEN shelf does not land (matched-copy status), even with a visible TBR',
    r.data === 'ok' && db.buddy_reads.length === 0);
  r = await rpc('buddy_invite', { p_friend: PAL, p_book_id: 'me-solo' });
  ok('gate: a book the invitee does not own does not land', r.data === 'ok' && db.buddy_reads.length === 0);
  r = await rpc('buddy_invite', { p_friend: STR, p_book_id: 'me-dragon' });
  ok('gate: a non-friend is refused with the generic shape', r.error && /not circle friends/.test(r.error.message));
  r = await rpc('buddy_invite', { p_friend: PAL, p_book_id: 'pal-dragon' });
  ok('gate: naming someone else\u2019s book id is refused', r.error && /no such book/.test(r.error.message));

  /* ---- caps: the sender\u2019s own slow_down ---- */
  let last;
  for (const n of [11, 12, 13, 14, 15, 16]) last = await (signIn(ME), rpc('buddy_invite', { p_friend: PET, p_book_id: 'me-cap' + n }));
  ok('caps: five invites to one friend land, the sixth hears slow_down',
    db.buddy_reads.filter(x => x.invitee_id === PET).length === 5 && last.data === 'slow_down');

  /* ---- opt-out ---- */
  db.profiles.find(p => p.user_id === PET).receive_buddy_invites = false;
  r = await rpc('buddy_invite', { p_friend: PET, p_book_id: 'me-dragon' });
  ok('opt-out: receive_buddy_invites=false swallows invites silently',
    r.data === 'ok' && db.buddy_reads.filter(x => x.invitee_id === PET).length === 5);
  db.profiles.find(p => p.user_id === PET).receive_buddy_invites = true;

  /* ---- crossed invites auto-accept ---- */
  r = await (signIn(REX), rpc('buddy_invite', { p_friend: ME, p_book_id: 'rex-dragon' }));
  const rexRow = db.buddy_reads.find(x => x.inviter_id === REX && x.invitee_id === ME);
  ok('crossed: REX → ME pending stands', r.data === 'ok' && !!rexRow && rexRow.status === 'pending');
  r = await (signIn(ME), rpc('buddy_invite', { p_friend: REX, p_book_id: 'me-dragon' }));
  ok('crossed: my invite back ACTIVATES their pending (one row, mutual intent)',
    r.data === 'ok' && rexRow.status === 'active' &&
    db.buddy_reads.filter(x => x.book_key === rexRow.book_key).length === 1);

  /* ---- block mid-read ends it (sever → cleanup) ---- */
  await stub.sb.from('blocks').insert({ blocked_id: ME });
  // (insert ran as REX — the stub's uid is ME here; re-do as REX)
  db.blocks = db.blocks.filter(b => !(b.blocker_id === ME && b.blocked_id === ME));
  stub.setUid(REX);
  await stub.sb.from('blocks').insert({ blocked_id: ME });
  ok('block: severing the link deletes the pair\u2019s buddy rows',
    !db.buddy_reads.some(x => x.id === rexRow.id));
  r = await (signIn(ME), rpc('buddy_invite', { p_friend: REX, p_book_id: 'me-dragon' }));
  ok('block: invites across a block fail with the generic shape',
    r.error && /not circle friends/.test(r.error.message));

  /* ---- unfriend mid-read ends it ---- */
  r = await (signIn(PAL), rpc('buddy_invite', { p_friend: ME, p_book_id: 'pal-meadows' }));
  const mrow = db.buddy_reads.find(x => x.inviter_id === PAL && x.invitee_id === ME);
  await (signIn(ME), rpc('buddy_respond', { p_id: mrow.id, p_accept: true }));
  ok('unfriend setup: PAL ↔ ME meadows read active', mrow.status === 'active');
  stub.deleteLinks(l => (l.requester_id === ME && l.addressee_id === PAL) || (l.requester_id === PAL && l.addressee_id === ME));
  ok('unfriend: link deletion removes the pair\u2019s buddy rows', !db.buddy_reads.some(x => x.id === mrow.id));
  link(ME, PAL); // restore for the shield section

  /* ---- expired pendings are invisible ---- */
  db.buddy_reads.push({
    id: 'br-stale', inviter_id: PAL, invitee_id: ME, book_key: keyOf(ISBN(2), 'Quiet Meadows', 'A. Meadows'),
    status: 'pending', created_at: new Date(Date.now() - 61 * 86400e3).toISOString(),
  });
  seen = await rowsAs(ME);
  ok('expiry: a 61-day-old pending is not readable', !seen.some(x => x.id === 'br-stale'));
  db.buddy_reads = db.buddy_reads.filter(x => x.id !== 'br-stale');

  /* ---- accept after the invitee removed the book: row dies ---- */
  r = await (signIn(PAL), rpc('buddy_invite', { p_friend: ME, p_book_id: 'pal-meadows' }));
  const orphan = db.buddy_reads.find(x => x.inviter_id === PAL && x.invitee_id === ME);
  db.books = db.books.filter(b => !(b.user_id === ME && stub.keyOfRow(b) === orphan.book_key && b.book_id === 'me-meadows'));
  // (ME still owns other meadows-keyed rows? no — only me-meadows had that key)
  await (signIn(ME), rpc('buddy_respond', { p_id: orphan.id, p_accept: true }));
  ok('accept: invitee no longer owns the book → the row dies instead of activating',
    !db.buddy_reads.some(x => x.id === orphan.id));

  /* ---- the shield: held invites, blurred covers, no state fetch ---- */
  signIn(ME);
  await ev('setShield(true)');
  ok('shield: ME\u2019s shield is on for this section', ev('shieldOn()') === true);
  r = await (signIn(PAL), rpc('buddy_invite', { p_friend: ME, p_book_id: 'pal-sauce' }));
  ok('shield setup: PAL → ME sauce invite lands server-side', r.data === 'ok');
  signIn(ME);
  html = await renderBuddyTab();
  ok('shield: a known-high-spice invite is HELD WHOLE (no title, no sender, content-free line only)',
    !html.includes('Saucy Tales') && !html.includes('Pete invited you') &&
    html.includes('Some invitations are hidden by your content shield.'));
  // Accept it unshielded, then re-shield: the active row blurs and
  // never asks the server for state.
  await ev('setShield(false)');
  html = await renderBuddyTab();
  w.document.querySelector('[data-buddy-accept]').click();
  await tick(6);
  const sauceRow = db.buddy_reads.find(x => x.book_key === keyOf(ISBN(5), 'Saucy Tales', 'H. Heat'));
  ok('shield: unshielded accept activates the read', !!sauceRow && sauceRow.status === 'active');
  await ev('setShield(true)');
  db.rpcCalls = [];
  html = await renderBuddyTab();
  ok('shield: the active row\u2019s cover is blurred for a shielded viewer',
    /cover-wrap[^"]*shield-blur/.test(html) && html.includes('Saucy Tales'));
  ok('shield: buddy_states is NEVER called for a shield-filtered book (fetch discipline)',
    db.rpcCalls.filter(f => f === 'buddy_states').length === 0 &&
    !html.includes('· Finished') && !html.includes('· Reading'));
  await ev('setShield(false)');

  /* ---- pre-migration tolerance ---- */
  db.noBuddy = true;
  signIn(ME);
  await ev('buddyTableMissing = false; buddySupportKnown = null;');
  ok('pre-migration: buddySupported() fails quiet', (await ev('buddySupported()')) === false);
  const statsHTML = ev('covenStatsHTML({people:[{id:"me",name:"You",profile:null,stats:{}},{id:"' + PAL + '",name:"Pete",profile:null,stats:{}}],buddies:[{p:{id:"' + PAL + '",name:"Pete",profile:null},books:[{title:"The Dragon Ledger",authors:["Robin Hobb"],isbn:"' + ISBN(1) + '",status:"tbr",cover:"",coverColor:""}]}],nowReading:[],trending:[],moments:[],awards:[],soulmates:[]})');
  ok('pre-migration: the v197 matches card still renders (Buddy reads + the match + the inert button markup)',
    statsHTML.includes('Buddy reads') && statsHTML.includes('The Dragon Ledger') && statsHTML.includes('data-buddy-invite='));
  const view = w.document.getElementById('view');
  view.innerHTML = '<div id="stats-slot"><div id="ctab-buddy">' + statsHTML.split('id="ctab-buddy"')[1].split('</div>')[0] + '</div></div>';
  // Simpler: rebuild a panel containing just the match button markup.
  view.innerHTML = '<div id="stats-slot"><div id="ctab-buddy"><button data-buddy-invite="isbn:' + ISBN(1) + '" data-buddy-friend="' + PAL + '">Read together</button></div></div>';
  await ev('wireBuddyReads(document.getElementById("stats-slot"))');
  await tick(4);
  const btn = w.document.querySelector('[data-buddy-invite]');
  ok('pre-migration: offer buttons hide; nothing throws', !!btn && btn.style.display === 'none');
  db.noBuddy = false;

  /* ---- the modal slot (js/150 opts.onBuddyRead) ---- */
  signIn(ME);
  ev('openPreviewModal(migrateBook({ title: "Modal Book", authors: ["M. Ode"], isbn: "", status: "tbr" }), { source: "test" })');
  await tick(3);
  ok('modal: no buddy button without the option', !w.document.getElementById('p-buddy'));
  ev('openPreviewModal(migrateBook({ title: "Modal Book", authors: ["M. Ode"], isbn: "", status: "tbr" }), { source: "test", onBuddyRead: async () => true })');
  await tick(3);
  ok('modal: the Read together button appears only with opts.onBuddyRead', !!w.document.getElementById('p-buddy'));

  console.log('\nsocial-buddy-reads: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('social-buddy-reads crashed:', e); process.exit(1); });
