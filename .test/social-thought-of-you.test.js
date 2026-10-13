// "Thought of you" directed recommendations (v527, Social build #2):
// a reader sends one of their own books to a specific circle friend
// with an optional short note; it lands as a card in the friend's
// Hearth with one-tap +TBR and a dismiss.
//
// House discipline (migration v527): writes ONLY through
// send_thought_of_you(), which re-validates at write time — the book
// is the sender's own (the server builds the snapshot), accepted
// friendship, no block either direction (one generic refusal), the
// recipient's receive_recos posture — and answers with outcomes that
// are indistinguishable in return value, except the sender's own
// rate caps. The sender has NO read or delete policy (a PostgREST
// delete count would be a receipt oracle); dismissal tombstones the
// (pair, book); known-high-spice cards are held whole for shielded
// recipients before any HTML is built.
//
// The stub emulates v522+v524+v525+v526+v527 RLS/RPC semantics. The
// REAL enforcement lives in supabase/migrations/v527_thought_of_you.sql
// (shape-pinned below, mirrored in schema.sql).
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP_DIR = process.env.BOOKTOK_DIR || path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok -', label); } else { fail++; console.log('  NOT OK -', label); } };
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

/* ================= SQL shape: the real enforcement ================= */
const mig = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v527_thought_of_you.sql'), 'utf8');
const schema = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
for (const [label, sql] of [['migration', mig], ['schema.sql', schema]]) {
  ok(label + ': thought_of_you table with the dedupe constraint and note cap',
    /create table if not exists public\.thought_of_you/.test(sql) &&
    /unique \(sender_id, recipient_id, book_key\)/.test(sql) &&
    /note text not null default '' check \(char_length\(note\) <= 140\)/.test(sql) &&
    /check \(sender_id <> recipient_id\)/.test(sql));
  ok(label + ': machinery tables exist and are RLS-locked with ZERO policies',
    /create table if not exists public\.toy_send_log/.test(sql) &&
    /create table if not exists public\.toy_dismissals/.test(sql) &&
    /alter table public\.toy_send_log enable row level security/.test(sql) &&
    /alter table public\.toy_dismissals enable row level security/.test(sql) &&
    /revoke all on public\.toy_send_log from public, anon, authenticated/.test(sql) &&
    /revoke all on public\.toy_dismissals from public, anon, authenticated/.test(sql) &&
    !/create policy "[^"]*" on public\.toy_(send_log|dismissals)/.test(sql));
  ok(label + ': recipient SELECT policy = recipient + accepted link + 60-day expiry',
    /create policy "recipient reads recommendations" on public\.thought_of_you\s+for select\s+using \(\s+auth\.uid\(\) = recipient_id\s+and created_at > now\(\) - interval '60 days'\s+and exists \(\s+select 1 from public\.circle_links/.test(sql) &&
    /cl\.status = 'accepted'/.test(sql));
  ok(label + ': recipient DELETE policy (their own inbox only)',
    /create policy "recipient deletes recommendations" on public\.thought_of_you\s+for delete\s+using \(auth\.uid\(\) = recipient_id\)/.test(sql));
  ok(label + ': exactly two policies on thought_of_you (NO sender read/delete, NO insert/update)',
    (sql.match(/create policy "[^"]*" on public\.thought_of_you/g) || []).length === 2);
  ok(label + ': receive_recos lands on profiles with default true',
    /alter table public\.profiles\s+add column if not exists receive_recos boolean not null default true/.test(sql));
  ok(label + ': send RPC re-validates + builds the snapshot server-side',
    /function public\.send_thought_of_you\(p_recipient uuid, p_book_id text, p_note text\)[\s\S]{0,300}security definer/.test(sql) &&
    /from public\.books b\s+where b\.user_id = v_uid and b\.book_id = p_book_id/.test(sql) &&
    /jsonb_build_object\(/.test(sql) &&
    /public\.toy_cover_ok\(v_cover\)/.test(sql));
  ok(label + ': send RPC validation order is pinned (note → book → friends → consent → caps → silent)',
    (() => {
      const s0 = sql.indexOf('function public.send_thought_of_you');
      const body = sql.slice(s0, sql.indexOf('$$;', s0));
      const i0 = body.indexOf("if v_uid is null then raise exception 'not signed in'");
      const i1 = body.indexOf("raise exception 'note too long'");
      const i2 = body.indexOf("raise exception 'no such book'");
      const i3 = body.indexOf("raise exception 'not circle friends'");
      const i4 = body.indexOf('select p.receive_recos into v_recv');
      const i5 = body.indexOf('from public.toy_dismissals d');
      const i6 = body.indexOf("return 'slow_down'");
      return i0 !== -1 && i0 < i1 && i1 < i2 && i2 < i3 && i3 < i4 && i4 < i6 && i6 < i5;
    })());
  ok(label + ': blocked pair folds into the generic friendship refusal inside the RPC',
    /or exists \(\s+select 1 from public\.blocks b\s+where \(b\.blocker_id = v_uid and b\.blocked_id = p_recipient\)/.test(sql));
  ok(label + ': caps are exact — advisory lock before counting an append-only log',
    /perform pg_advisory_xact_lock\(hashtextextended\('toy-send:'/.test(sql) &&
    /insert into public\.toy_send_log/.test(sql) &&
    />= 5/.test(sql) && />= 20/.test(sql) &&
    sql.indexOf('pg_advisory_xact_lock') < sql.indexOf('insert into public.toy_send_log'));
  ok(label + ': dedupe insert is on-conflict-do-nothing behind the log write order',
    /on conflict \(sender_id, recipient_id, book_key\) do nothing/.test(sql));
  ok(label + ': dismiss RPC tombstones before deleting; recall always answers ok',
    (() => {
      const d = sql.indexOf('function public.dismiss_thought_of_you');
      const ins = sql.indexOf('insert into public.toy_dismissals', d);
      const del = sql.indexOf('delete from public.thought_of_you where id = p_id', d);
      return d !== -1 && ins > d && del > ins;
    })() &&
    /function public\.recall_thought_of_you[\s\S]*?return 'ok';\s+end;/.test(sql));
  ok(label + ': unfriend cleanup trigger mirrors v525 (guarded on no accepted link remaining)',
    /create trigger thought_of_you_unfriend_cleanup\s+after delete on public\.circle_links/.test(sql) &&
    /function public\.thought_of_you_unfriend\(\)[\s\S]{0,600}if not exists \(\s+select 1 from public\.circle_links cl\s+where cl\.status = 'accepted'/.test(sql));
  ok(label + ': opportunistic prune bounds all three tables',
    /delete from public\.toy_send_log where created_at < now\(\) - interval '2 days'/.test(sql) &&
    /delete from public\.toy_dismissals where created_at < now\(\) - interval '1 year'/.test(sql) &&
    /delete from public\.thought_of_you where created_at < now\(\) - interval '60 days'/.test(sql));
  ok(label + ': RPCs revoked from public, granted to authenticated only',
    /revoke all on function public\.send_thought_of_you\(uuid, text, text\) from public/.test(sql) &&
    /grant execute on function public\.send_thought_of_you\(uuid, text, text\) to authenticated/.test(sql) &&
    /revoke all on function public\.dismiss_thought_of_you\(uuid\) from public/.test(sql) &&
    /revoke all on function public\.recall_thought_of_you\(uuid, text\) from public/.test(sql));
}
/* The #190 fix must live in BOTH files, identically, and AFTER the
 * block check + own-invite check. */
const inviteBody = (sql) => {
  const i = sql.indexOf('create or replace function public.accept_circle_invite');
  if (i < 0) return '';
  const j = sql.indexOf('$$;', i);
  return j < 0 ? '' : sql.slice(i, j + 3);
};
ok('#190: migration and schema.sql invite definitions agree',
  inviteBody(mig).replace(/\s+/g, ' ') === inviteBody(schema).replace(/\s+/g, ' '));
for (const [label, sql] of [['migration', mig], ['schema.sql', schema]]) {
  const b = inviteBody(sql);
  const iBlock = b.indexOf('from public.blocks b');
  const iOwn = b.indexOf("raise exception 'own invite'");
  const iEarly = b.indexOf("values (v_me, v_them, 'accepted');");
  const iAcceptedCheck = b.indexOf("status = 'accepted'", iOwn);
  const iStale = b.indexOf("status <> 'accepted'", iOwn);
  const iMainDelete = b.indexOf('delete from circle_links', iEarly > 0 ? 0 : 0);
  ok(label + ': #190 early return sits after block + own-invite checks, before the delete/re-insert',
    iBlock !== -1 && iOwn > iBlock && iAcceptedCheck > iOwn && iStale > iAcceptedCheck &&
    b.indexOf('return v_them;', iStale) !== -1 &&
    b.indexOf('return v_them;', iStale) < b.lastIndexOf('delete from circle_links'));
}
/* receive_recos is never projected to friends. */
ok('receive_recos is NOT in the circle_profiles view definition',
  (() => {
    const i = schema.indexOf('create or replace view public.circle_profiles');
    const j = schema.indexOf(';', i);
    return i !== -1 && !schema.slice(i, j).includes('receive_recos');
  })());
ok('receive_recos is NOT in the client friend-projection columns (js/195)',
  !fs.readFileSync(path.join(APP_DIR, 'js/195-coven.js'), 'utf8')
    .match(/const CIRCLE_PROFILE_COLS = '[^']*'/)?.[0].includes('receive_recos'));
/* Cover hosts: three copies, one set — pinned EQUAL in both
 * directions (an extra host smuggled into any copy fails). */
const hostSet = (arr) => new Set(arr.map(h => h.toLowerCase()));
const coverHostsSrc = fs.readFileSync(path.join(APP_DIR, 'functions/_lib/cover-hosts.js'), 'utf8');
const quotedHosts = (s) => Array.from(s.matchAll(/'([a-z0-9.-]+\.[a-z]{2,})'/gi)).map(m => m[1]);
const arrAfter = (src, marker, endMark) => {
  const i = src.indexOf(marker);
  if (i < 0) return [];
  const j = src.indexOf(endMark, i);
  return quotedHosts(src.slice(i, j < 0 ? undefined : j));
};
const libHosts = hostSet([].concat(
  arrAfter(coverHostsSrc, 'COVER_HOSTS_SHARED = new Set([', ']);'),
  arrAfter(coverHostsSrc, 'COVER_PROXY_ONLY = [', '];'),
  arrAfter(coverHostsSrc, 'CACHE_COVER_ONLY = [', '];')));
const sqlHosts = hostSet(arrAfter(mig, 'unnest(array[', ']) as h(host)'));
const js232Src = fs.readFileSync(path.join(APP_DIR, 'js/232-thought-of-you.js'), 'utf8');
const clientHosts = hostSet(arrAfter(js232Src, 'TOY_COVER_HOSTS = [', '];'));
const setsEqual = (a, b) => a.size === b.size && Array.from(a).every(x => b.has(x));
ok('cover allowlist: cover-hosts.js union == SQL == js/232 (both directions)',
  setsEqual(libHosts, sqlHosts) && setsEqual(libHosts, clientHosts) && libHosts.size === 14);
ok('toy_cover_ok: parsed-authority equality, content-addressed bucket shape, capped data URLs',
  mig.includes("replace(h.host, '.', '" + String.fromCharCode(92) + ".')") &&
  /\[0-9a-f\]\{64\}/.test(mig) &&
  /left\(p_url, 11\) = 'data:image\/' and length\(p_url\) <= 204800/.test(mig) &&
  mig.includes('dvhimjkrroxuatthiizc' + String.fromCharCode(92) + '.supabase' + String.fromCharCode(92) + '.co'));
/* Client wiring pins. */
ok('index.html + sw.js register js/232; version pair is v527',
  fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8').includes('<script src="js/232-thought-of-you.js"></script>') &&
  fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8').includes("'232-thought-of-you.js'"));
ok('book detail menu carries "Recommend to a friend" (js/150)',
  (() => { const s = fs.readFileSync(path.join(APP_DIR, 'js/150-modal-discovery.js'), 'utf8');
    return s.includes('id="m-toy"') && s.includes('Recommend to a friend') && s.includes('openToyCompose(b'); })());
ok('Hearth render carries the inbox slot + refresh hook + privacy toggle (js/195)',
  (() => { const s = fs.readFileSync(path.join(APP_DIR, 'js/195-coven.js'), 'utf8');
    return s.includes('id="toy-slot"') && s.includes('refreshThoughtOfYou()') &&
      s.includes('Book recommendations from friends') && s.includes("p + '-recos'"); })());
ok('js/232 renders no counts/tallies of recommendations',
  !/thought of you[\s\S]{0,200}\.length|recommendations? (sent|received)[:\s]*\d/i.test(js232Src) &&
  js232Src.includes('Some recommendations are hidden by your content shield.'));

/* ================= stub: faithful v522–v527 semantics ================= */
const ME = 'user-me', PAL = 'user-pal', PET = 'user-pet', REX = 'user-rex', STR = 'user-str';
const baseProfiles = () => ([
  { user_id: ME, first_name: 'Maren', last_name: 'Vale', avatar_id: 'cat', avatar_path: null, share_library: true, hidden_shelves: [], share_bio: true, share_activity: true, bio: '', fav_genres: [], receive_recos: true },
  { user_id: PAL, first_name: 'Pete', last_name: 'Pal', avatar_id: 'fox', avatar_path: null, share_library: true, hidden_shelves: [], share_bio: true, share_activity: true, bio: '', fav_genres: [], receive_recos: true },
  { user_id: PET, first_name: 'Petra', last_name: 'Petal', avatar_id: 'owl', avatar_path: null, share_library: true, hidden_shelves: [], share_bio: true, share_activity: true, bio: '', fav_genres: [], receive_recos: true },
  { user_id: REX, first_name: 'Rex', last_name: 'Ray', avatar_id: 'bee', avatar_path: null, share_library: true, hidden_shelves: [], share_bio: true, share_activity: true, bio: '', fav_genres: [], receive_recos: true },
  { user_id: STR, first_name: 'Stan', last_name: 'Stranger', avatar_id: 'elk', avatar_path: null, share_library: true, hidden_shelves: [], share_bio: true, share_activity: true, bio: '', fav_genres: [], receive_recos: true },
]);
const prof = (uid, extra) => Object.assign({
  id: null, title: 'A Book', authors: [], isbn: '', cover: '', coverColor: '',
  status: 'read', series: null, seriesPos: '', genres: [], categories: [],
  description: '', pageCount: 0, publishedDate: '', ratings: {}, progress: 0,
}, extra || {});
const seedBooks = () => ([
  // PAL's shelf
  { user_id: PAL, book_id: 'pal-dragon', isbn: '9780000000001', data: prof('pal-dragon', { title: 'The Dragon Ledger', authors: ['Dana Drake'], isbn: '9780000000001', cover: 'https://covers.openlibrary.org/b/id/1-L.jpg', coverColor: '#7a4a21', series: { name: 'Ledger Saga', position: '1', planted: 'x' }, pageCount: '321', publishedDate: '2020-05-01' }) },
  { user_id: PAL, book_id: 'pal-explicit', isbn: '9780000000002', data: prof('pal-explicit', { title: 'Velvet Sin', authors: ['Vera Vain'], isbn: '9780000000002', cover: 'https://img.hardcover.app/x.jpg', ratings: { spice: 5 } }) },
  { user_id: PAL, book_id: 'pal-tracker', isbn: '', data: prof('pal-tracker', { title: 'Quiet Meadows', authors: ['Fern Low'], cover: 'https://track.evil.example/pixel.png', coverColor: 'red' }) },
  { user_id: PAL, book_id: 'pal-tame', isbn: '', data: prof('pal-tame', { title: 'A Gentle Season', authors: ['Fern Low'], cover: 'https://books.google.com/thumb.jpg' }) },
  { user_id: PET, book_id: 'pet-one', isbn: '', data: prof('pet-one', { title: 'Harbour Lights', authors: ['Ana Mar'] }) },
  { user_id: PET, book_id: 'pet-two', isbn: '', data: prof('pet-two', { title: 'Second Harbour', authors: ['Ana Mar'] }) },
  { user_id: PET, book_id: 'pet-three', isbn: '', data: prof('pet-three', { title: 'Third Harbour', authors: ['Ana Mar'] }) },
  { user_id: PET, book_id: 'pet-four', isbn: '', data: prof('pet-four', { title: 'Fourth Harbour', authors: ['Ana Mar'] }) },
  { user_id: PET, book_id: 'pet-five', isbn: '', data: prof('pet-five', { title: 'Fifth Harbour', authors: ['Ana Mar'] }) },
  { user_id: PET, book_id: 'pet-six', isbn: '', data: prof('pet-six', { title: 'Sixth Harbour', authors: ['Ana Mar'] }) },
  { user_id: ME, book_id: 'me-own', isbn: '', data: prof('me-own', { title: 'My Own Book', authors: ['Me Myself'] }) },
]);

const COVER_HOSTS = ['covers.openlibrary.org', 'books.google.com', 'assets.hardcover.app', 'img.hardcover.app', 'images-na.ssl-images-amazon.com', 'm.media-amazon.com', 'archive.org', 'hardcover.app', 'i.gr-assets.com', 'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com', 'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'];
function normIsbn(v) {
  const s = String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return (s.length === 10 || s.length === 13) ? s : '';
}
function firstAuthorOf(data) {
  if (Array.isArray(data && data.authors)) return data.authors[0] || '';
  if (typeof (data && data.authors) === 'string') return data.authors;
  return '';
}
function keyOf(isbn, title, firstAuthor) {
  const n = normIsbn(isbn);
  return n ? 'isbn:' + n : 'ta:' + String(title || '').trim().toLowerCase() + '|' + String(firstAuthor || '').trim().toLowerCase();
}
function coverOk(u) {
  if (!u) return true;
  if (u.indexOf('data:image/') === 0) return u.length <= 204800;
  if (u.length > 1000) return false;
  if (/^https:\/\/dvhimjkrroxuatthiizc\.supabase\.co\/storage\/v1\/object\/public\/covers\/[0-9a-f]{64}\.(jpg|jpeg|png|webp|gif|avif)$/.test(u)) return true;
  let parsed; try { parsed = new URL(u); } catch (e) { return false; }
  return parsed.protocol === 'https:' && COVER_HOSTS.indexOf(parsed.hostname) !== -1;
}
function buildSnapshot(row) {
  const d = row.data || {};
  const authors = (Array.isArray(d.authors) ? d.authors : (typeof d.authors === 'string' ? [d.authors] : []))
    .filter(a => typeof a === 'string' && a.trim()).slice(0, 8).map(a => a.slice(0, 120));
  let series = null;
  if (d.series && typeof d.series === 'object' && typeof d.series.name === 'string' && d.series.name.trim()) {
    series = { name: d.series.name.slice(0, 200), position: String(d.series.position == null ? '' : d.series.position).slice(0, 20) };
  }
  let cover = typeof d.cover === 'string' ? d.cover : '';
  if (!coverOk(cover)) cover = '';
  return {
    title: String(d.title || '').slice(0, 300),
    authors,
    isbn: normIsbn(d.isbn || row.isbn || ''),
    cover,
    coverColor: /^#[0-9a-fA-F]{6}$/.test(d.coverColor || '') ? d.coverColor : '',
    series, seriesPos: String(d.seriesPos || '').slice(0, 20),
    genres: (Array.isArray(d.genres) ? d.genres : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 12),
    categories: (Array.isArray(d.categories) ? d.categories : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 12),
    description: String(d.description || '').slice(0, 2000),
    pageCount: /^[0-9]+$/.test(String(d.pageCount == null ? '' : d.pageCount)) ? Math.min(Number(d.pageCount), 100000) : 0,
    publishedDate: /^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(d.publishedDate || '') ? String(d.publishedDate).slice(0, 10) : '',
  };
}

const mkStub = () => {
  const db = {
    circle_links: [], circle_invites: [], invites: {}, profiles: baseProfiles(), books: seedBooks(),
    blocks: [], moment_reactions: [], thought_of_you: [], toy_send_log: [], toy_dismissals: [],
    works: [], user_state: [],
    noToy: false, noRecosCol: false,
  };
  let uid = null, seq = 0;
  const err = (message, code) => ({ data: null, error: { message, code: code || 'PGRST000' } });
  const pairKey = (a, b) => [a, b].sort().join('|');
  const acceptedLink = (a, b) => db.circle_links.some(l => l.status === 'accepted' &&
    ((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
  const pairBlocked = (a, b) => db.blocks.some(x => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
  const cleanupPair = (a, b) => {
    if (acceptedLink(a, b)) return;
    db.moment_reactions = db.moment_reactions.filter(r => !((r.giver_id === a && r.owner_id === b) || (r.giver_id === b && r.owner_id === a)));
    db.thought_of_you = db.thought_of_you.filter(r => !((r.sender_id === a && r.recipient_id === b) || (r.sender_id === b && r.recipient_id === a)));
  };
  const deleteLinks = (pred) => {
    const removed = db.circle_links.filter(pred);
    db.circle_links = db.circle_links.filter(l => !pred(l));
    removed.forEach(l => cleanupPair(l.requester_id, l.addressee_id));
  };
  const visibleTo = (viewer, targetUid) => {
    if (viewer === targetUid) return true;
    if (pairBlocked(viewer, targetUid)) return false;
    return db.circle_links.some(l =>
      ((l.requester_id === viewer && l.addressee_id === targetUid) || (l.requester_id === targetUid && l.addressee_id === viewer)) &&
      (l.status === 'accepted' || l.status === 'pending'));
  };
  const toyRowVisible = (row) => uid === row.recipient_id &&
    (Date.now() - new Date(row.created_at).getTime()) < 60 * 86400e3 &&
    acceptedLink(row.sender_id, row.recipient_id) &&
    !db.blocks.some(b => b.blocker_id === uid && b.blocked_id === row.sender_id);
  const MISSING_TOY = () => err('relation "public.thought_of_you" does not exist', '42P01');
  const MISSING_RPC = (fn) => err('function ' + fn + ' does not exist in the schema cache', 'PGRST202');

  const rpcFns = {
    send_thought_of_you(args) {
      if (db.noToy) return MISSING_RPC('send_thought_of_you');
      if (!uid) return err('not signed in');
      if (String(args.p_note || '').length > 140) return err('note too long');
      const row = db.books.find(b => b.user_id === uid && b.book_id === args.p_book_id);
      if (!row || !String((row.data || {}).title || '').trim()) return err('no such book');
      if (args.p_recipient === uid || !acceptedLink(uid, args.p_recipient) || pairBlocked(uid, args.p_recipient)) {
        return err('not circle friends');
      }
      const recip = db.profiles.find(p => p.user_id === args.p_recipient);
      if (!recip || recip.receive_recos !== true) return { data: 'ok', error: null };
      // Caps run BEFORE the silent-state checks (mirrors the SQL): an
      // over-cap sender hears 'slow_down' uniformly, so the answer
      // reports only the sender's own volume — never a dismissal receipt.
      const today = db.toy_send_log.filter(l => Date.now() - l.ts < 86400e3);
      if (today.filter(l => l.sender_id === uid && l.recipient_id === args.p_recipient).length >= 5 ||
          today.filter(l => l.sender_id === uid).length >= 20) return { data: 'slow_down', error: null };
      const snap = buildSnapshot(row);
      const key = keyOf(snap.isbn, snap.title, snap.authors[0] || '');
      if (db.toy_dismissals.some(d => d.sender_id === uid && d.recipient_id === args.p_recipient && d.book_key === key)) return { data: 'ok', error: null };
      if (db.thought_of_you.some(t => t.sender_id === uid && t.recipient_id === args.p_recipient && t.book_key === key)) return { data: 'ok', error: null };
      const owned = db.books.some(b => b.user_id === args.p_recipient &&
        keyOf(b.data && b.data.isbn || b.isbn, b.data && b.data.title, firstAuthorOf(b.data)) === key);
      if (owned) return { data: 'ok', error: null };
      db.thought_of_you.push({
        id: 'toy-' + (++seq), sender_id: uid, recipient_id: args.p_recipient,
        sender_book_id: args.p_book_id, book_key: key, book: snap,
        note: String(args.p_note || '').trim(), created_at: new Date().toISOString(),
      });
      db.toy_send_log.push({ sender_id: uid, recipient_id: args.p_recipient, ts: Date.now() });
      return { data: 'ok', error: null };
    },
    dismiss_thought_of_you(args) {
      if (db.noToy) return MISSING_RPC('dismiss_thought_of_you');
      if (!uid) return err('not signed in');
      const row = db.thought_of_you.find(t => t.id === args.p_id && t.recipient_id === uid);
      if (!row) return { data: 'ok', error: null };
      const ex = db.toy_dismissals.find(d => d.sender_id === row.sender_id && d.recipient_id === uid && d.book_key === row.book_key);
      if (ex) ex.created_at = new Date().toISOString();
      else db.toy_dismissals.push({ sender_id: row.sender_id, recipient_id: uid, book_key: row.book_key, created_at: new Date().toISOString() });
      db.thought_of_you = db.thought_of_you.filter(t => t.id !== args.p_id);
      return { data: 'ok', error: null };
    },
    recall_thought_of_you(args) {
      if (db.noToy) return MISSING_RPC('recall_thought_of_you');
      if (!uid) return err('not signed in');
      db.thought_of_you = db.thought_of_you.filter(t =>
        !(t.sender_id === uid && t.recipient_id === args.p_recipient && t.sender_book_id === args.p_book_id));
      return { data: 'ok', error: null };
    },
    accept_circle_invite(args) {
      const them = db.invites[args.p_token];
      if (!them) return err('invite not found');
      if (pairBlocked(uid, them)) return err('invite not found');
      if (them === uid) return err('own invite');
      const isPair = (l) => (l.requester_id === uid && l.addressee_id === them) || (l.requester_id === them && l.addressee_id === uid);
      if (acceptedLink(uid, them)) { // v527 early return
        deleteLinks(l => isPair(l) && l.status !== 'accepted');
        return { data: them, error: null };
      }
      deleteLinks(isPair);
      db.circle_links.push({ requester_id: uid, addressee_id: them, status: 'accepted' });
      return { data: them, error: null };
    },
    react_to_moment() { return err('unused here'); },
  };

  const projectPublic = (r) => ({
    user_id: r.user_id, first_name: r.first_name, last_name: r.last_name,
    avatar_id: r.avatar_id, avatar_path: r.avatar_path,
    share_library: r.share_library, hidden_shelves: r.hidden_shelves,
    share_bio: r.share_bio, share_activity: r.share_activity,
    bio: r.bio, fav_genres: r.fav_genres,
  });
  function table(name) {
    let mode = 'select', payload = null, single = false, maybe = false;
    const filters = [];
    const matches = (row) => filters.every(f => f.fn(row));
    const run = () => {
      if (name === 'toy_send_log' || name === 'toy_dismissals') {
        return err('permission denied for table ' + name, '42501');
      }
      if (name === 'thought_of_you') {
        if (db.noToy) return MISSING_TOY();
        if (mode === 'select') {
          let rows = db.thought_of_you.filter(r => toyRowVisible(r) && matches(r));
          return { data: rows.map(r => Object.assign({}, r)), error: null };
        }
        if (mode === 'delete') {
          db.thought_of_you = db.thought_of_you.filter(r => !(uid === r.recipient_id && matches(r)));
          return { data: null, error: null };
        }
        return err('new row violates row-level security policy for table "thought_of_you"', '42501');
      }
      if (name === 'circle_profiles') {
        let rows = db.profiles.filter(p => visibleTo(uid, p.user_id)).map(projectPublic);
        rows = rows.filter(matches);
        if (single || maybe) return { data: rows[0] || null, error: null };
        return { data: rows, error: null };
      }
      if (name === 'profiles') {
        if (mode === 'upsert') {
          if (db.noRecosCol && payload && 'receive_recos' in payload) {
            return err('column profiles.receive_recos does not exist', '42703');
          }
          const i = db.profiles.findIndex(p => p.user_id === payload.user_id);
          if (i === -1) db.profiles.push(Object.assign({}, payload));
          else db.profiles[i] = Object.assign({}, db.profiles[i], payload);
          return { data: null, error: null };
        }
        if (db.noRecosCol && table._cols && /receive_recos/.test(table._cols)) {
          return err('column profiles.receive_recos does not exist', '42703');
        }
        let rows = db.profiles.filter(p => p.user_id === uid && matches(p));
        if (single || maybe) return { data: rows[0] || null, error: null };
        return { data: rows.map(r => Object.assign({}, r)), error: null };
      }
      if (name === 'blocks') {
        if (mode === 'insert') {
          const row = { blocker_id: uid, blocked_id: payload.blocked_id, created_at: new Date().toISOString() };
          if (!db.blocks.some(b => b.blocker_id === row.blocker_id && b.blocked_id === row.blocked_id)) db.blocks.push(row);
          deleteLinks(l => (l.requester_id === row.blocker_id && l.addressee_id === row.blocked_id) ||
                           (l.requester_id === row.blocked_id && l.addressee_id === row.blocker_id));
          return { data: null, error: null };
        }
        if (mode === 'delete') {
          db.blocks = db.blocks.filter(b => !(b.blocker_id === uid && matches(b)));
          return { data: null, error: null };
        }
        return { data: db.blocks.filter(b => b.blocker_id === uid && matches(b)), error: null };
      }
      const rows = () => (db[name] || []).slice();
      if (mode === 'select') {
        let out = rows().filter(matches);
        return { data: out, error: null };
      }
      return { data: null, error: null };
    };
    const chain = {
      select(cols) { table._cols = cols; return chain; },
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
    rpc: async (fn, args) => (rpcFns[fn] ? rpcFns[fn](args || {}) : err('unknown rpc ' + fn)),
    auth: { getSession: async () => ({ data: { session: null } }) },
    storage: { from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: 'https://example.invalid/' + p } }) }) },
  };
  return { db, sb, setUid: (u) => { uid = u; }, cleanupPair, acceptedLink, pairBlocked };
};

/* ================= harness: the real app over the stub =================
 * (The house pattern — shared harness, scripts as classic tags.) */
const indexHtml = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window;
w.fetch = async () => { throw new Error('no network in thought-of-you tests'); };
w.confirm = () => true;
require('./harness').loadApp(w);
const runInWindow = (js) => {
  const s = w.document.createElement('script');
  s.textContent = js;
  w.document.body.appendChild(s);
};
const probe = (js) => w.eval(js);
const slotHTML = () => { const s = w.document.getElementById('toy-slot'); return s ? s.innerHTML : '(no slot)'; };

/* ================= behavior ================= */
(async () => {
  const stub = mkStub();
  const db = stub.db;
  const link = (a, b, status) => db.circle_links.push({ requester_id: a, addressee_id: b, status: status || 'accepted', created_at: new Date().toISOString() });
  link(ME, PAL); link(ME, PET); link(ME, REX); link(PET, PAL);
  w.__sbStub = stub.sb;
  const signIn = (uid) => {
    stub.setUid(uid);
    runInWindow('cloudUser = ' + (uid ? JSON.stringify({ id: uid, email: uid + '@example.test' }) : 'null') + ';');
  };
  const ev = (code) => probe(code);
  const rpc = (fn, args) => stub.sb.rpc(fn, args);
  signIn(ME);
  runInWindow('library = [];');
  const renderInbox = async () => {
    const view = w.document.getElementById('view');
    if (!w.document.getElementById('toy-slot')) view.innerHTML = '<div id="toy-slot"></div>';
    await ev('refreshThoughtOfYou()');
    await tick(4);
  };

  /* ---- send: the server builds the snapshot ---- */
  let r = await (signIn(PAL), rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-dragon', p_note: 'The ledger magic made me think of you' }));
  ok('send: PAL → ME dragon book lands', r.data === 'ok' && db.thought_of_you.length === 1);
  const snap = db.thought_of_you[0].book;
  ok('send: snapshot carries only clean-copy fields (no ratings/progress/dates)',
    snap.title === 'The Dragon Ledger' && snap.isbn === '9780000000001' &&
    !('ratings' in snap) && !('progress' in snap) && !('status' in snap) && !('datesRead' in snap) && !('id' in snap));
  ok('send: series rebuilt as {name, position} — planted extra keys dropped',
    snap.series && snap.series.name === 'Ledger Saga' && snap.series.position === '1' && !('planted' in snap.series));
  ok('send: string pageCount coerced to a number server-side', snap.pageCount === 321);
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-tracker', p_note: '' });
  ok('send: tracker-host cover stripped to empty, invalid coverColor stripped',
    r.data === 'ok' && db.thought_of_you[1].book.cover === '' && db.thought_of_you[1].book.coverColor === '');
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-dragon', p_note: 'again' });
  ok('send: duplicate is a silent ok (one row, one log entry — no cap burn)',
    r.data === 'ok' && db.thought_of_you.length === 2 && db.toy_send_log.length === 2);
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'not-mine', p_note: '' });
  ok('send: a book the sender does not own is refused', r.error && /no such book/.test(r.error.message));
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'me-own', p_note: '' });
  ok('send: naming SOMEONE ELSE\u2019s book id is refused the same way', r.error && /no such book/.test(r.error.message));
  r = await rpc('send_thought_of_you', { p_recipient: STR, p_book_id: 'pal-tame', p_note: '' });
  ok('send: non-friend refused with the generic shape', r.error && /not circle friends/.test(r.error.message));
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-tame', p_note: 'x'.repeat(141) });
  ok('send: 141-char note refused (cap enforced server-side)', r.error && /note too long/.test(r.error.message));

  /* ---- receive: the card renders, escaped ---- */
  await (signIn(ME), renderInbox());
  let html = slotHTML();
  ok('inbox: card renders title, sender, note',
    html.includes('The Dragon Ledger') && html.includes('Pete') && html.includes('The ledger magic made me think of you'));
  ok('inbox: stripped tracker cover renders the placeholder, never the URL',
    !html.includes('track.evil.example') && html.includes('Quiet Meadows'));
  r = await (signIn(PAL), rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-tame', p_note: '<img src=x onerror="window.__pwned=1"> & <b>hi</b>' }));
  ok('send: markup note is stored plain', r.data === 'ok');
  await (signIn(ME), renderInbox());
  html = slotHTML();
  ok('inbox: note markup renders ESCAPED (no live img, no injection)',
    !w.document.querySelector('#toy-slot img[src="x"]') && html.includes('&lt;img') && w.__pwned !== 1);
  ok('inbox: three cards present, each with +TBR and Dismiss/Report/Block',
    (html.match(/data-toy-add=/g) || []).length === 3 &&
    (html.match(/data-toy-dismiss=/g) || []).length === 3 &&
    (html.match(/data-toy-report=/g) || []).length === 3 &&
    (html.match(/data-toy-block=/g) || []).length === 3);

  /* ---- +TBR round-trip (no tombstone) ---- */
  const dragonCard = db.thought_of_you.find(t => t.book_key.indexOf('isbn:') === 0);
  w.document.querySelector('[data-toy-add="' + dragonCard.id + '"]').click();
  await tick(6);
  const added = probe('library.find(b => b.title === "The Dragon Ledger")');
  ok('+TBR: book lands on the recipient TBR, clean',
    !!added && added.status === 'tbr' && added.isbn === '9780000000001' &&
    added.series && added.series.name === 'Ledger Saga' && !('ratings' in added && added.ratings && added.ratings.spice));
  db.books.push({ user_id: ME, book_id: 'me-dragon', isbn: '9780000000001', data: prof('me-dragon', { title: 'The Dragon Ledger', authors: ['Dana Drake'], isbn: '9780000000001', status: 'tbr' }) });
  ok('+TBR: the card row is removed and NO tombstone is written',
    !db.thought_of_you.some(t => t.id === dragonCard.id) && db.toy_dismissals.length === 0);
  r = await (signIn(PAL), rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-dragon', p_note: '' }));
  ok('re-send while owned: silent ok, still no row (owned check, not a tombstone)',
    r.data === 'ok' && !db.thought_of_you.some(t => t.book_key.indexOf('isbn:') === 0));
  runInWindow('library = library.filter(b => b.title !== "The Dragon Ledger");');
  db.books = db.books.filter(b => b.book_id !== 'me-dragon');
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-dragon', p_note: 'try again' });
  ok('re-send after the recipient removed it from TBR: lands again (+TBR never tombstoned)',
    r.data === 'ok' && db.thought_of_you.some(t => t.book_key.indexOf('isbn:') === 0));

  /* ---- dismiss tombstones ---- */
  await (signIn(ME), renderInbox());
  const tameCard = db.thought_of_you.find(t => t.book.title === 'A Gentle Season');
  w.document.querySelector('[data-toy-dismiss="' + tameCard.id + '"]').click();
  await tick(6);
  ok('dismiss: row deleted and a tombstone written',
    !db.thought_of_you.some(t => t.id === tameCard.id) && db.toy_dismissals.length === 1);
  r = await (signIn(PAL), rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-tame', p_note: '' }));
  ok('dismissed (pair, book): re-send is a silent ok and never lands',
    r.data === 'ok' && !db.thought_of_you.some(t => t.book.title === 'A Gentle Season'));

  /* ---- no sender surface: reads, deletes, receipts ---- */
  let sel = await stub.sb.from('thought_of_you').select('id');
  ok('sender CANNOT read rows they sent (no select policy — fire-and-forget)',
    sel.data.length === 0);
  await stub.sb.from('thought_of_you').delete().eq('sender_id', PAL);
  ok('sender CANNOT delete rows (a delete count would be a receipt oracle)',
    db.thought_of_you.some(t => t.sender_id === PAL));
  signIn(PET);
  sel = await stub.sb.from('thought_of_you').select('id');
  ok('third-party friend reads nothing', sel.data.length === 0);
  signIn(STR);
  sel = await stub.sb.from('thought_of_you').select('id');
  ok('stranger reads nothing', sel.data.length === 0);
  const mach = await stub.sb.from('toy_dismissals').select('*');
  ok('machinery tables are unreadable by clients (a dismissal record is not a surface)',
    !!mach.error && mach.data === null);
  r = await rpc('recall_thought_of_you', { p_recipient: ME, p_book_id: 'pal-dragon' });
  ok('recall by a NON-sender answers ok and deletes nothing',
    r.data === 'ok' && db.thought_of_you.some(t => t.sender_book_id === 'pal-dragon'));
  signIn(PAL);
  r = await rpc('recall_thought_of_you', { p_recipient: ME, p_book_id: 'pal-dragon' });
  ok('recall by the sender removes the pending card, answering plain ok', r.data === 'ok' &&
    !db.thought_of_you.some(t => t.sender_book_id === 'pal-dragon'));
  r = await rpc('recall_thought_of_you', { p_recipient: ME, p_book_id: 'pal-dragon' });
  ok('recall of an already-gone card answers the same ok (no existence signal)', r.data === 'ok');

  /* ---- consent: opted-out recipient ---- */
  db.profiles.find(p => p.user_id === ME).receive_recos = false;
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-tame', p_note: '' });
  const before = db.thought_of_you.length;
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-explicit', p_note: '' });
  ok('opted-out recipient: send is a silent ok and nothing lands',
    r.data === 'ok' && db.thought_of_you.length === before);
  db.profiles.find(p => p.user_id === ME).receive_recos = true;

  /* ---- caps ---- */
  signIn(PET);
  const petBooks = ['pet-one', 'pet-two', 'pet-three', 'pet-four', 'pet-five'];
  for (const b of petBooks) await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: b, p_note: '' });
  ok('caps: five sends in a pair-day land', db.thought_of_you.filter(t => t.sender_id === PET).length === 5);
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pet-six', p_note: '' });
  ok('caps: the sixth is refused with the sender\u2019s own slow_down (no row)',
    r.data === 'slow_down' && !db.thought_of_you.some(t => t.sender_book_id === 'pet-six'));
  db.toy_send_log.length = 0;
  for (let i = 0; i < 20; i++) db.toy_send_log.push({ sender_id: PET, recipient_id: 'user-x', ts: Date.now() });
  r = await rpc('send_thought_of_you', { p_recipient: PAL, p_book_id: 'pet-six', p_note: '' });
  ok('caps: the 20/day global cap refuses a fresh pair too', r.data === 'slow_down');
  db.toy_send_log.length = 0;

  /* ---- caps ORDER: caps answer before the silent-state checks, so an
   * over-cap sender hears 'slow_down' uniformly. Were the silent checks
   * first, a dismissed/duplicate/owned book would answer 'ok' while a
   * fresh book answered 'slow_down' — a differential that resolves to
   * a dismissal receipt. ---- */
  const burnCap = (who) => { for (let i = 0; i < 20; i++) db.toy_send_log.push({ sender_id: who, recipient_id: 'user-x', ts: Date.now() }); };
  burnCap(PAL);
  r = await (signIn(PAL), rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-tame', p_note: '' }));
  ok('caps order: an over-cap re-send of a DISMISSED book answers slow_down (no dismissal receipt)',
    r.data === 'slow_down' && !db.thought_of_you.some(t => t.book.title === 'A Gentle Season'));
  db.books.push({ user_id: ME, book_id: 'me-dragon', isbn: '9780000000001', data: prof('me-dragon', { title: 'The Dragon Ledger', authors: ['Dana Drake'], isbn: '9780000000001', status: 'tbr' }) });
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-dragon', p_note: '' });
  ok('caps order: an over-cap send of an ALREADY-OWNED book answers slow_down, not the silent ok',
    r.data === 'slow_down');
  db.books = db.books.filter(b => b.book_id !== 'me-dragon');
  db.toy_send_log.length = 0;
  burnCap(PET);
  r = await (signIn(PET), rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pet-one', p_note: '' }));
  ok('caps order: an over-cap re-send of a DUPLICATE still in the inbox answers slow_down, not the silent ok',
    r.data === 'slow_down' && db.thought_of_you.filter(t => t.sender_id === PET).length === 5);
  db.toy_send_log.length = 0;

  /* ---- blocks: silent refusal + sever sweep ---- */
  signIn(PAL);
  await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-explicit', p_note: 'before the block' });
  ok('block setup: a pending card exists from PAL', db.thought_of_you.some(t => t.sender_id === PAL && t.recipient_id === ME));
  signIn(ME);
  await stub.sb.from('blocks').insert({ blocked_id: PAL });
  ok('block: the sever sweeps the blocked sender\u2019s pending cards (cleanup trigger)',
    !db.thought_of_you.some(t => t.sender_id === PAL));
  signIn(PAL);
  r = await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-tame', p_note: '' });
  ok('blocked pair: send refused with the generic not-friends shape',
    r.error && /not circle friends/.test(r.error.message));
  signIn(REX);
  await stub.sb.from('blocks').insert({ blocked_id: ME });
  signIn(ME);
  r = await rpc('send_thought_of_you', { p_recipient: REX, p_book_id: 'me-own', p_note: '' });
  ok('blocked the other direction: identical generic refusal',
    r.error && /not circle friends/.test(r.error.message));

  /* ---- expiry: a 61-day-old card is unreadable ---- */
  signIn(PET);
  await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pet-six', p_note: 'old news' });
  const oldRow = db.thought_of_you.find(t => t.sender_book_id === 'pet-six');
  oldRow.created_at = new Date(Date.now() - 61 * 86400e3).toISOString();
  await (signIn(ME), renderInbox());
  ok('expiry: cards older than 60 days do not render', !slotHTML().includes('Sixth Harbour'));

  /* ---- shield: known high-spice held whole; unknown follows v524 ---- */
  const tn = (s) => ev('tropeNormIdent(' + JSON.stringify(s) + ')');
  db.works.push({ title_norm: tn('Velvet Sin'), author_norm: tn('Vera Vain'), spice_detected: 5, spice_manual: null });
  db.works.push({ title_norm: tn('Harbour Lights'), author_norm: tn('Ana Mar'), spice_detected: 1, spice_manual: null });
  signIn(PAL);
  // relink ME–PAL for the shield scenario (the block severed it; clear the block as an unblock would)
  db.blocks = db.blocks.filter(b => !(b.blocker_id === ME && b.blocked_id === PAL));
  if (!stub.acceptedLink(ME, PAL)) link(PAL, ME);
  await rpc('send_thought_of_you', { p_recipient: ME, p_book_id: 'pal-explicit', p_note: 'the spicy one' });
  signIn(ME);
  ev('setShield(true)');
  await renderInbox();
  html = slotHTML();
  ok('shield ON: known-high-spice card held whole — no title, no note, no cover URL',
    !html.includes('Velvet Sin') && !html.includes('the spicy one') && !html.includes('img.hardcover.app'));
  ok('shield ON: a content-free held line shows (no number, no sender)',
    html.includes('Some recommendations are hidden by your content shield.') &&
    !/hidden by your content shield/.test(html.replace('Some recommendations are hidden by your content shield.', '')) &&
    !/\d+\s+recommendation/.test(html));
  ok('shield ON: known-tame and unknown-spice cards still render (v524 unknown rule)',
    html.includes('Harbour Lights') && html.includes('Second Harbour'));
  ev('setShield(false)');
  await renderInbox();
  ok('shield OFF: the held card renders in full', slotHTML().includes('Velvet Sin'));

  /* ---- #190: re-redeeming a friend\u2019s invite keeps their cards ---- */
  db.invites['CODE-PET'] = PET;
  ok('#190 setup: PET has a live card to ME', db.thought_of_you.some(t => t.sender_id === PET && t.recipient_id === ME));
  db.circle_links.push({ requester_id: ME, addressee_id: PET, status: 'pending', created_at: new Date().toISOString() });
  r = await rpc('accept_circle_invite', { p_token: 'CODE-PET' });
  ok('#190: re-redeem returns the friend', r.data === PET && !r.error);
  ok('#190: the pair\u2019s recommendation cards SURVIVE the re-redeem',
    db.thought_of_you.some(t => t.sender_id === PET && t.recipient_id === ME));
  ok('#190: the stale pending row is cleared, the accepted link stands',
    stub.acceptedLink(ME, PET) && !db.circle_links.some(l => l.status === 'pending' &&
      ((l.requester_id === ME && l.addressee_id === PET) || (l.requester_id === PET && l.addressee_id === ME))));

  /* ---- unfriend sweeps the pair\u2019s cards ---- */
  stub.db.circle_links = db.circle_links.filter(l => !((l.requester_id === ME && l.addressee_id === PET) || (l.requester_id === PET && l.addressee_id === ME)));
  stub.cleanupPair(ME, PET);
  ok('unfriend: the pair\u2019s cards are deleted in both directions',
    !db.thought_of_you.some(t => (t.sender_id === PET && t.recipient_id === ME) || (t.sender_id === ME && t.recipient_id === PET)));

  /* ---- compose sheet ---- */
  link(ME, PET); // friends again after the unfriend scenario
  signIn(ME);
  w.document.getElementById('view').innerHTML = '';
  await ev('openToyCompose({ id: "me-own", title: "My Own Book", authors: ["Me Myself"], cover: "", coverColor: "" })');
  await tick(6);
  const sheet = w.document.getElementById('covenSheet');
  ok('compose: sheet opens with the book and friend chips',
    !!sheet && sheet.textContent.includes('My Own Book') && !!sheet.querySelector('[data-toy-friend="' + PET + '"]'));
  const sendBtn = sheet.querySelector('#toy-send');
  ok('compose: send stays disabled until a friend is picked', sendBtn.disabled === true);
  sheet.querySelector('[data-toy-friend="' + PET + '"]').click();
  sheet.querySelector('#toy-note').value = 'Thought of you!';
  sendBtn.click();
  await tick(6);
  ok('compose: send creates the row for the picked friend and closes the sheet',
    db.thought_of_you.some(t => t.sender_id === ME && t.recipient_id === PET && t.note === 'Thought of you!') &&
    !w.document.getElementById('covenSheet'));

  /* ---- privacy panel: the receive toggle ---- */
  const privNow = await ev('circlePrivacy()');
  ok('privacy: circlePrivacy reports recos=true by default', privNow.recos === true);
  const host = w.document.createElement('div');
  host.innerHTML = ev('circlePrivacyPanelHTML({ share: true, hidden: [], bio: true, activity: false, recos: true }, "st", [])');
  w.document.body.appendChild(host);
  ok('privacy panel: the recommendations toggle renders (On active)',
    host.textContent.includes('Book recommendations from friends') &&
    host.querySelector('#st-recos button[data-v="1"]').classList.contains('active'));
  ev('wireCirclePrivacyPanel(document.body, { share: true, hidden: [], bio: true, activity: false, recos: true }, "st")');
  host.querySelector('#st-recos button[data-v="0"]').click();
  await tick(6);
  ok('privacy panel: toggling Off persists receive_recos=false on the OWN profile',
    db.profiles.find(p => p.user_id === ME).receive_recos === false);
  db.profiles.find(p => p.user_id === ME).receive_recos = true;

  /* ---- pre-migration tolerance ---- */
  db.noToy = true; db.noRecosCol = true;
  ev('toyTableMissing = false; toySupportKnown = null;');
  ok('pre-migration: support probe answers false', await ev('toySupported()') === false);
  await renderInbox();
  ok('pre-migration: inbox fails quiet (no throw, empty slot)', slotHTML() === '');
  const res = await ev('toySend("user-pet", { id: "me-own" }, "")');
  ok('pre-migration: send fails quiet as unavailable', res === 'unavailable');
  const privOld = await ev('circlePrivacy()');
  ok('pre-migration: circlePrivacy defaults recos=true without the column', privOld.recos === true);
  await ev('circleSavePrivacy(true, [], true, false, false)');
  ok('pre-migration: saving with recos retries without the column and lands',
    db.profiles.find(p => p.user_id === ME).share_library === true);
  db.noToy = false; db.noRecosCol = false;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
