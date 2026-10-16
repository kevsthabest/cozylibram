// "Marginalia" (v574): progress-gated circle notes on the book page.
//
// House discipline (migration v574, after a red-team round amended
// the first design): position is a FRACTION computed by the server
// from the author's own copy; locked notes are ABSENT from the
// read RPC's payload (the notes table carries no friend SELECT
// policy at all — the gated RPC is the only read door); shelf
// visibility composes at read time; the body is screened (v550)
// and reports snapshot the note server-side so moderation is
// actionable; the profiles opt-out is authoritative for serving.
//
// The stub emulates the v574 RPC semantics. The REAL enforcement
// lives in supabase/migrations/v574_marginalia.sql (shape-pinned
// below, mirrored in schema.sql).
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP_DIR = process.env.BOOKTOK_DIR || path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok -', label); } else { fail++; console.log('  NOT OK -', label); } };
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

/* ================= SQL shape: the real enforcement ================= */
const mig = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v574_marginalia.sql'), 'utf8');
const schema = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
// v578 restates marginalia_for_book (issue #232 parity): the migration arm's
// read-composition pin targets the LAST migration defining the function,
// not the founding v574 text (the PR #218 last-definition pattern).
const migRead = fs.readdirSync(path.join(APP_DIR, 'supabase/migrations'))
  .filter(f => f.endsWith('.sql')).sort()
  .map(f => fs.readFileSync(path.join(APP_DIR, 'supabase/migrations', f), 'utf8'))
  .filter(s => s.includes('function public.marginalia_for_book')).pop() || mig;
for (const [label, sql] of [['migration', mig], ['schema.sql', schema]]) {
  ok(label + ': profiles gains marginalia_enabled, default true',
    /add column if not exists marginalia_enabled boolean not null default true/.test(sql));
  ok(label + ': notes table shape — key + fraction + writer page/count + body, NO book snapshot',
    /create table if not exists public\.marginalia_notes/.test(sql) &&
    /book_key text not null/.test(sql) &&
    /frac double precision not null check \(frac > 0 and frac <= 1\)/.test(sql) &&
    /page integer not null check \(page >= 1\)/.test(sql) &&
    /page_count integer not null check \(page_count >= 1\)/.test(sql) &&
    /body text not null check \(char_length\(body\) between 1 and 280\)/.test(sql) &&
    /author_id uuid not null references auth\.users \(id\) on delete cascade/.test(sql) &&
    !/marginalia_notes \([^)]*\btitle\b/.test(sql));
  ok(label + ': exactly ONE policy on the notes table — the admins read (no friend SELECT door)',
    (sql.match(/create policy "[^"]*" on public\.marginalia_notes/g) || []).length === 1 &&
    /create policy "admins read marginalia notes" on public\.marginalia_notes\s+for select\s+using \(is_admin\(\)\)/.test(sql));
  ok(label + ': direct writes revoked; machinery log locked down with zero policies',
    /revoke insert, update, delete on public\.marginalia_notes from authenticated/.test(sql) &&
    /alter table public\.marginalia_send_log enable row level security/.test(sql) &&
    /revoke all on public\.marginalia_send_log from public, anon, authenticated/.test(sql) &&
    !/create policy "[^"]*" on public\.marginalia_send_log/.test(sql));
  ok(label + ': jsonb numerics are guarded (typeof + numeric-string regex, never a bare cast)',
    /function public\.marginalia_num\(jsonb, text\)/.test(sql) &&
    /jsonb_typeof\(p_data -> p_key\) = 'number'/.test(sql) &&
    sql.includes("'^[0-9]+(") && sql.includes("[0-9]+)?$'"));
  ok(label + ': finished is HISTORICAL (status read OR finish date OR readCount OR previouslyRead)',
    /function public\.marginalia_copy_frac\(jsonb\)/.test(sql) &&
    /dateFinished/.test(sql) && /readCount/.test(sql) && /previouslyRead/.test(sql) &&
    /least\(1, v_prog \/ v_pc\)/.test(sql));
  ok(label + ': ISBN-13 normalization inside the feature key (978 + check digit)',
    /function public\.marginalia_isbn13\(text\)/.test(sql) &&
    /'978' \|\| left\(v, 9\)/.test(sql) &&
    /function public\.marginalia_book_key\(jsonb, text\)/.test(sql) &&
    /public\.toy_book_key\(/.test(sql));
  const addFn = (sql.split('function public.marginalia_add')[1] || '').split('$$;')[0];
  ok(label + ': add — advisory lock BEFORE caps, screen inside, fraction server-computed',
    /pg_advisory_xact_lock\(hashtextextended\('marginalia:'/.test(addFn) &&
    /handle_screen_hit\(v_body, 'bio'\)/.test(addFn) &&
    /v_page::double precision \/ v_pci::double precision/.test(addFn) &&
    />= 50[\s\S]{0,400}return 'slow_down'/.test(addFn) &&
    />= 20/.test(addFn) &&
    /pin outside your progress/.test(addFn) &&
    /page count needed/.test(addFn));
  const readFn = ((label === 'migration' ? migRead : sql).split('function public.marginalia_for_book')[1] || '').split('$$;')[0];
  ok(label + ': read — fraction gate + author switch + shelf visibility + blocks composed',
    /n\.frac <= v_frac/.test(readFn) &&
    /marginalia_enabled/.test(readFn) &&
    /public\.circle_book_visible\(n\.author_id, ab\.data ->> 'status', ab\.data ->> 'owned'\)/.test(readFn) &&
    /from public\.blocks bl/.test(readFn) &&
    /limit 500/.test(readFn) &&
    /n\.author_id = v_uid/.test(readFn));
  ok(label + ': report snapshots the note into user_reports; reasons clamped to the CHECK list',
    /function public\.marginalia_report\(uuid, text, text\)/.test(sql) &&
    /insert into public\.user_reports \(reporter_id, reported_user_id, reason, details\)/.test(sql) &&
    /Margin note /.test(sql) && /v_n\.body/.test(sql) &&
    /'spam', 'harassment', 'inappropriate', 'fake_account', 'other'/.test(sql));
  ok(label + ': admin removal is is_admin-gated; mine() enumerates the author (orphan-note reach)',
    /function public\.marginalia_admin_remove\(p_id uuid\)[\s\S]{0,800}is_admin\(\)/.test(sql) &&
    /function public\.marginalia_mine\(\)/.test(sql) &&
    /where n\.author_id = v_uid/.test(sql));
  ok(label + ': all six RPCs granted to authenticated only',
    (sql.match(/grant execute on function public\.marginalia_(add|for_book|delete|report|mine|admin_remove)/g) || []).length === 6);
}

/* ================= registration ================= */
const indexHtml = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const swText = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
ok('index.html registers js/242-marginalia.js after js/241',
  indexHtml.includes('<script src="js/242-marginalia.js"></script>') &&
  indexHtml.indexOf('js/242-marginalia.js') > indexHtml.indexOf('js/241-book-ambience.js'));
ok('sw.js precaches 242-marginalia.js', swText.includes("'242-marginalia.js'"));
ok('version pairing is v592',
  /APP_VERSION = 'v592'/.test(fs.readFileSync(path.join(APP_DIR, 'js/181-appversion.js'), 'utf8')) &&
  swText.includes("cozy-libram-v592"));
const js150 = fs.readFileSync(path.join(APP_DIR, 'js/150-modal-discovery.js'), 'utf8');
ok('js/150 carries the slot + the fill call',
  js150.includes('<div id="m-marginalia"></div>') && js150.includes("fillMarginalia(b)"));
const js229 = fs.readFileSync(path.join(APP_DIR, 'js/229-user-state.js'), 'utf8');
ok('js/229 prefs inventory carries the marginalia key (never the frozen settings list)',
  /PREFS_STATE_KEYS = \[[^\]]*'cozylibram\.marginalia'/.test(js229));
const js195 = fs.readFileSync(path.join(APP_DIR, 'js/195-coven.js'), 'utf8');
ok('js/195: panel seg + privacy read/write carry marginalia',
  js195.includes("p + '-marginalia'") && js195.includes('marginalia_enabled') &&
  /circleSavePrivacy\(share, hidden, bio, activity, recos, buddy, marginalia\)/.test(js195));
const js242 = fs.readFileSync(path.join(APP_DIR, 'js/242-marginalia.js'), 'utf8');
ok('js/242: shield precedes the read RPC (fetch discipline)',
  js242.indexOf('shieldIsHighSpice') < js242.indexOf('await marginaliaFetch(book)') &&
  /never called for a book the viewer's shield holds/.test(js242));
ok('js/242: the gate keeps own notes unconditionally and never renders counts for locked notes',
  /n\.author_id === myId \|\|/.test(js242) && !/locked/i.test(js242.split('function marginaliaSectionHTML')[1].split('function wireMarginaliaSection')[0]));

/* ================= stub (v574 RPC semantics) ================= */
const ME = 'me-1', PAL = 'pal-2', PET = 'pet-3', STR = 'str-5';
const isbn13check = (v12) => { let s = 0; for (let i = 0; i < 12; i++) s += Number(v12[i]) * (i % 2 ? 3 : 1); return String((10 - (s % 10)) % 10); };
const ISBN = (n) => { const v12 = '9780000000' + String(n).padStart(2, '0'); return v12 + isbn13check(v12); };
const isbn10Of = (i13) => {
  const core = i13.slice(3, 12); let s = 0;
  for (let i = 0; i < 9; i++) s += Number(core[i]) * (10 - i);
  const c = (11 - (s % 11)) % 11;
  return core + (c === 10 ? 'X' : String(c));
};
const isbn13 = (raw) => {
  const s = String(raw || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (s.length === 13) return s;
  if (s.length !== 10) return '';
  const v12 = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(v12[i]) * (i % 2 === 0 ? 1 : 3);
  return v12 + String((10 - (sum % 10)) % 10);
};
const keyOf = (isbn, title, firstAuthor) => {
  const n = isbn13(isbn);
  return n ? 'isbn:' + n : 'ta:' + String(title || '').trim().toLowerCase() + '|' + String(firstAuthor || '').trim().toLowerCase();
};
const firstAuthorOf = (d) => !d ? '' : Array.isArray(d.authors) ? (d.authors[0] || '') : String(d.authors || '');
const keyOfRow = (row) => keyOf((row.data && row.data.isbn) || row.isbn, row.data && row.data.title, firstAuthorOf(row.data));
const numOf = (d, k) => {
  const v = d ? d[k] : undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^[0-9]+(\.[0-9]+)?$/.test(v)) return Number(v);
  return null;
};
const copyFrac = (d) => {
  if (!d) return 0;
  if (d.status === 'read' || (d.dateFinished && String(d.dateFinished).trim() !== '') ||
      (numOf(d, 'readCount') || 0) >= 1 || d.previouslyRead === true || d.previouslyRead === 'true') return 1;
  const pc = numOf(d, 'pageCount'), pr = numOf(d, 'progress');
  if (!pc || pc <= 0 || !pr || pr <= 0) return 0;
  return Math.min(1, pr / pc);
};

const mkStub = () => {
  const prof = (user_id, first_name, extra) => Object.assign({
    user_id, first_name, last_name: '', avatar_id: '', avatar_path: '',
    share_library: true, hidden_shelves: [], share_bio: true, share_activity: false,
    bio: '', fav_genres: [], receive_recos: true, receive_buddy_invites: true,
    marginalia_enabled: true,
  }, extra || {});
  const brow = (user_id, id, isbn, title, author, status, extra) => ({
    user_id, book_id: id, isbn,
    data: Object.assign({ id, title, authors: [author], isbn, status, cover: '', coverColor: '' }, extra || {}),
  });
  const db = {
    circle_links: [], profiles: [prof(ME, 'Me'), prof(PAL, 'Pete'), prof(PET, 'Petra'), prof(STR, 'Stray')],
    books: [], blocks: [], marginalia_notes: [], marginalia_send_log: [], user_reports: [],
    user_state: [], works: [], missing: false, rpcCalls: [], seq: 0,
  };
  let uid = null;
  const err = (message, code) => ({ data: null, error: { message, code: code || 'PGRST000' } });
  const MISSING_COL = () => err('column profiles.marginalia_enabled does not exist', '42703');
  const MISSING_RPC = (fn) => err('Could not find the function public.' + fn + ' in the schema cache', 'PGRST202');
  const acceptedLink = (a, b) => db.circle_links.some(l => l.status === 'accepted' &&
    ((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
  const pairBlocked = (a, b) => db.blocks.some(x => (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
  const bookVisible = (owner, status) => {
    // circle_book_visible(owner, status) as the CALLER (uid), v526 shape.
    if (pairBlocked(uid, owner) || !acceptedLink(uid, owner)) return false;
    const p = db.profiles.find(x => x.user_id === owner);
    if (!p || p.share_library === false) return false;
    if ((p.hidden_shelves || []).indexOf(status || '') !== -1) return false;
    return db.books.some(b => b.user_id === owner && (b.data.status || '') === (status || ''));
  };
  const rpcFns = {
    marginalia_add: ({ p_book_id, p_page, p_body }) => {
      if (db.missing) return MISSING_RPC('marginalia_add');
      const row = db.books.find(b => b.user_id === uid && b.book_id === p_book_id);
      if (!row || !String((row.data && row.data.title) || '').trim()) return err('no such book', 'P0001');
      const me = db.profiles.find(p => p.user_id === uid);
      if (me && me.marginalia_enabled !== true) return { data: 'off', error: null };
      const prog = numOf(row.data, 'progress'), pc = numOf(row.data, 'pageCount');
      const cur = Math.floor(prog || 0);
      if (cur < 1) return err('no progress yet', 'P0001');
      if (!pc || pc < 1) return err('page count needed', 'P0001');
      const pci = Math.floor(pc);
      const page = (p_page == null ? cur : p_page);
      if (page < 1 || page > cur) return err('pin outside your progress', 'P0001');
      const body = String(p_body || '').trim();
      if (body.length < 1 || body.length > 280) return err('note length', 'P0001');
      const today = db.marginalia_send_log.filter(l => l.author_id === uid).length;
      if (today >= 50) return { data: 'slow_down', error: null };
      const key = keyOfRow(row);
      if (db.marginalia_notes.filter(n => n.author_id === uid && n.book_key === key).length >= 20) {
        return err('too many notes on this book', 'P0001');
      }
      db.marginalia_notes.push({
        id: 'note-' + (++db.seq), author_id: uid, book_key: key,
        frac: page / pci, page, page_count: pci, body,
        created_at: new Date(Date.now() + db.seq).toISOString(),
      });
      db.marginalia_send_log.push({ author_id: uid, created_at: new Date().toISOString() });
      return { data: 'ok', error: null };
    },
    marginalia_for_book: ({ p_book_id }) => {
      if (db.missing) return MISSING_RPC('marginalia_for_book');
      const row = db.books.find(b => b.user_id === uid && b.book_id === p_book_id);
      if (!row || !String((row.data && row.data.title) || '').trim()) return err('no such book', 'P0001');
      const me = db.profiles.find(p => p.user_id === uid);
      if (me && me.marginalia_enabled !== true) return { data: [], error: null };
      const key = keyOfRow(row);
      const vfrac = Math.max(0, ...db.books.filter(b => b.user_id === uid && keyOfRow(b) === key).map(b => copyFrac(b.data)));
      const out = db.marginalia_notes.filter(n => n.book_key === key && (
        n.author_id === uid || (
          n.frac <= vfrac &&
          ((db.profiles.find(p => p.user_id === n.author_id) || {}).marginalia_enabled !== false) &&
          db.books.some(ab => ab.user_id === n.author_id && keyOfRow(ab) === key && bookVisible(n.author_id, ab.data.status || '')) &&
          !pairBlocked(uid, n.author_id)
        )))
        .sort((a, b) => (a.frac - b.frac) || (a.created_at < b.created_at ? -1 : 1))
        .slice(0, 500);
      return { data: out, error: null };
    },
    marginalia_delete: ({ p_id }) => {
      if (db.missing) return MISSING_RPC('marginalia_delete');
      db.marginalia_notes = db.marginalia_notes.filter(n => !(n.id === p_id && n.author_id === uid));
      return { data: 'ok', error: null };
    },
    marginalia_report: ({ p_note_id, p_reason, p_details }) => {
      if (db.missing) return MISSING_RPC('marginalia_report');
      const n = db.marginalia_notes.find(x => x.id === p_note_id);
      if (!n || n.author_id === uid) return { data: 'ok', error: null };
      const reason = ['spam', 'harassment', 'inappropriate', 'fake_account', 'other'].includes(p_reason) ? p_reason : 'other';
      db.user_reports.push({
        reporter_id: uid, reported_user_id: n.author_id, reason,
        details: String(p_details || '').slice(0, 500) +
          '\n— Margin note ' + n.id + ' (book key ' + n.book_key + ', position ' +
          Math.round(n.frac * 100) + '% in): "' + n.body + '"',
      });
      return { data: 'ok', error: null };
    },
    marginalia_mine: () => {
      if (db.missing) return MISSING_RPC('marginalia_mine');
      return { data: db.marginalia_notes.filter(n => n.author_id === uid).slice(0, 200), error: null };
    },
  };
  const table = (name) => {
    let mode = 'select', payload = null, filters = [], single = false, maybe = false, cols = '';
    const run = () => {
      if (db.missing && name === 'profiles' && /marginalia_enabled/.test(cols)) return MISSING_COL();
      const project = (r) => {
        if (name === 'circle_profiles') {
          const c = Object.assign({}, r);
          delete c.receive_recos; delete c.receive_buddy_invites; delete c.marginalia_enabled;
          return c;
        }
        return r;
      };
      const rows = () => (db[name] || []).slice();
      const matches = (r) => filters.every(f => f(r));
      if (name === 'user_state') {
        if (mode === 'select') {
          const rr = rows().filter(matches);
          if (single || maybe) return { data: rr[0] || null, error: null };
          return { data: rr, error: null };
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
      if (mode === 'select') {
        const rr = rows().filter(matches).map(project);
        if (single || maybe) return { data: rr[0] || null, error: null };
        return { data: rr, error: null };
      }
      if (mode === 'upsert') {
        const p = Object.assign({}, payload);
        const i = db.profiles.findIndex(r => r.user_id === p.user_id);
        if (db.missing && 'marginalia_enabled' in p) return err('column marginalia_enabled does not exist', '42703');
        if (i === -1) db.profiles.push(p); else db.profiles[i] = Object.assign({}, db.profiles[i], p);
        return { data: null, error: null };
      }
      if (mode === 'insert') {
        if (name === 'user_reports') db.user_reports.push(Object.assign({}, payload));
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const chain = {
      select(c) { cols = c || ''; mode = 'select'; return chain; },
      eq(c, v) { filters.push(r => r[c] === v); return chain; },
      in(c, vs) { filters.push(r => vs.indexOf(r[c]) !== -1); return chain; },
      gt(c, v) { filters.push(r => r[c] > v); return chain; },
      order() { return chain; }, limit() { return chain; },
      single() { single = true; return chain; },
      maybeSingle() { maybe = true; return chain; },
      upsert(p) { mode = 'upsert'; payload = p; return chain; },
      insert(p) { mode = 'insert'; payload = p; return chain; },
      delete() { mode = 'delete'; return chain; },
      update(p) { mode = 'update'; payload = p; return chain; },
      then(res, rej) { Promise.resolve().then(() => run()).then(res, rej); },
    };
    return chain;
  };
  const sb = {
    from: table,
    rpc: async (fn, args) => { db.rpcCalls.push(fn); return rpcFns[fn] ? rpcFns[fn](args || {}) : err('unknown rpc ' + fn); },
    auth: { getSession: async () => ({ data: { session: null } }) },
    storage: { from: () => ({ getPublicUrl: (p) => ({ data: { publicUrl: 'https://example.invalid/' + p } }) }) },
  };
  return { db, sb, setUid: (u) => { uid = u; }, acceptedLink, pairBlocked, keyOfRow };
};

/* ================= app scenarios (js/242 against the stub) ================= */
const harness = require('./harness');
const wait = async (ms) => new Promise(r => setTimeout(r, ms));
const S = mkStub();
const A = S.db;

const clientDragon = { id: 'b-dragon', isbn: ISBN(7), title: 'Dragon Tale', authors: ['R. Author'], status: 'reading', progress: 150, pageCount: 300, cover: '', coverColor: '' };
const seed = () => {
  A.circle_links = [
    { id: 'l1', requester_id: ME, addressee_id: PAL, status: 'accepted' },
    { id: 'l2', requester_id: ME, addressee_id: PET, status: 'accepted' },
  ];
  A.books = [
    // my copies (server rows mirror the client library for ME)
    { user_id: ME, book_id: 'b-dragon', isbn: ISBN(7), data: Object.assign({}, clientDragon) },
    { user_id: ME, book_id: 'b-shield', isbn: ISBN(8), data: { id: 'b-shield', title: 'Dark Vale', authors: ['V. Vale'], isbn: ISBN(8), status: 'reading', progress: 200, pageCount: 400, ratings: { spice: 5 }, cover: '', coverColor: '' } },
    { user_id: ME, book_id: 'b-unstarted', isbn: ISBN(9), data: { id: 'b-unstarted', title: 'Unstarted', authors: ['U. Null'], isbn: ISBN(9), status: 'toread', cover: '', coverColor: '' } },
    { user_id: ME, book_id: 'b-nopc', isbn: ISBN(10), data: { id: 'b-nopc', title: 'No Pages', authors: ['N. Pages'], isbn: ISBN(10), status: 'reading', progress: 40, cover: '', coverColor: '' } },
    // Pete's copies (a different-edition pageCount on the dragon book)
    { user_id: PAL, book_id: 'p-dragon', isbn: ISBN(7), data: { id: 'p-dragon', title: 'Dragon Tale', authors: ['R. Author'], isbn: ISBN(7), status: 'reading', progress: 280, pageCount: 400, cover: '', coverColor: '' } },
    { user_id: PAL, book_id: 'p-shield', isbn: ISBN(8), data: { id: 'p-shield', title: 'Dark Vale', authors: ['V. Vale'], isbn: ISBN(8), status: 'reading', progress: 300, pageCount: 400, cover: '', coverColor: '' } },
    // Petra's copy: SAME book, ISBN-10 form — must meet via the normalized key.
    { user_id: PET, book_id: 't-dragon', isbn: isbn10Of(ISBN(7)), data: { id: 't-dragon', title: 'Dragon Tale', authors: ['R. Author'], isbn: isbn10Of(ISBN(7)), status: 'reading', progress: 180, pageCount: 300, cover: '', coverColor: '' } },
  ];
  A.blocks = []; A.marginalia_notes = []; A.marginalia_send_log = []; A.user_reports = [];
  A.missing = false; A.rpcCalls = [];
  A.profiles.forEach(p => { p.marginalia_enabled = true; p.share_library = true; p.hidden_shelves = []; });
};

(async () => {
  const indexForDom = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(indexForDom, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  harness.loadApp(w);
  w.__sbStub = S.sb;
  const run = (code) => w.eval(code);
  const slot = () => w.document.getElementById('m-marginalia');
  const freshSlot = () => {
    let s = w.document.getElementById('m-marginalia');
    if (!s) { s = w.document.createElement('div'); s.id = 'm-marginalia'; w.document.body.appendChild(s); }
    s.innerHTML = '';
  };
  const resetClient = () => {
    run('cloudUser = { id: "me-1", email: "me@example.com" };' +
        'library = ' + JSON.stringify([clientDragon,
          { id: 'b-shield', isbn: ISBN(8), title: 'Dark Vale', authors: ['V. Vale'], status: 'reading', progress: 200, pageCount: 400, ratings: { spice: 5 }, cover: '', coverColor: '' },
          { id: 'b-unstarted', isbn: ISBN(9), title: 'Unstarted', authors: ['U. Null'], status: 'toread', cover: '', coverColor: '' },
          { id: 'b-nopc', isbn: ISBN(10), title: 'No Pages', authors: ['N. Pages'], status: 'reading', progress: 40, cover: '', coverColor: '' }]) + ';' +
        'Object.keys(circProfiles).forEach(k => delete circProfiles[k]);' +
        'cloudPushNow = async () => true;');
    w.localStorage.clear();
    run('margTableMissing = false; margSupportKnown = null; margReconciled = false;');
  };
  const note = (author, book, page, pc, body) => ({
    id: 'seed-' + (++A.seq), author_id: author,
    book_key: S.keyOfRow(A.books.find(b => b.user_id === author && b.book_id === book)),
    frac: page / pc, page, page_count: pc, body,
    created_at: new Date(Date.now() + A.seq * 1000).toISOString(),
  });

  /* ---- pure gate/labels (client, unit) ---- */
  run('window.__gate = marginaliaGate(' +
    '[{id:"n1",author_id:"pal-2",frac:0.5},{id:"n2",author_id:"me-1",frac:0.9},{id:"n3",author_id:"pal-2",frac:0.2}], "me-1", 0.4);');
  ok('client gate: friend note beyond the viewer frac is OUT; own always IN; reading order out',
    JSON.stringify(w.__gate.map(n => n.id)) === '["n3","n2"]');
  run('window.__lab1 = marginaliaPositionLabel({page:212,page_count:400}, {pageCount:400});' +
      'window.__lab2 = marginaliaPositionLabel({frac:0.32,page_count:512}, {pageCount:400});' +
      'window.__lab3 = marginaliaPositionLabel({frac:0.5,page_count:512}, {pageCount:400});' +
      'window.__lab4 = marginaliaPositionLabel({frac:0.99,page:8,page_count:8}, null);');
  ok('labels: same edition → real page; other edition → honest fraction phrase, never a %',
    w.__lab1 === 'p. 212' && w.__lab2 === 'about a third in' && w.__lab3 === 'about halfway in' &&
    w.__lab4 === 'near the end' && !/%/.test(w.__lab2 + w.__lab3));
  run('window.__frac = [marginaliaBookFrac({status:"reading",progress:150,pageCount:300}),' +
    'marginaliaBookFrac({status:"read",progress:0,pageCount:300}),' +
    'marginaliaBookFrac({status:"reading",progress:10,pageCount:300,dateFinished:"2026-01-01"}),' +
    'marginaliaBookFrac({status:"reading",progress:0,pageCount:0}),' +
    'marginaliaBookFrac({status:"toread",progress:0,pageCount:300})];');
  ok('client frac mirrors the server rule (progress ratio; finished evidence = 1; unstarted = 0)',
    JSON.stringify(w.__frac) === JSON.stringify([0.5, 1, 1, 0, 0]));

  /* ---- stub RPC semantics, direct ---- */
  seed();
  S.setUid(PAL);
  let r = await S.sb.rpc('marginalia_add', { p_book_id: 'p-dragon', p_page: 212, p_body: 'The map scene lands.' });
  ok('add: ok, and the stored row carries the WRITER edition fraction + page + count',
    r.data === 'ok' && A.marginalia_notes.length === 1 &&
    Math.abs(A.marginalia_notes[0].frac - 212 / 400) < 1e-9 &&
    A.marginalia_notes[0].page === 212 && A.marginalia_notes[0].page_count === 400);
  r = await S.sb.rpc('marginalia_add', { p_book_id: 'p-dragon', p_page: 281, p_body: 'past my progress' });
  ok('add: a pin beyond the writer’s own progress is refused server-side', !!r.error && /pin outside/.test(r.error.message));
  r = await S.sb.rpc('marginalia_add', { p_book_id: 'p-dragon', p_page: 10, p_body: 'x'.repeat(281) });
  ok('add: over 280 chars is refused', !!r.error && /note length/.test(r.error.message));
  S.setUid(ME);
  r = await S.sb.rpc('marginalia_add', { p_book_id: 'b-unstarted', p_page: 1, p_body: 'not started' });
  ok('add: a book the writer has not started refuses', !!r.error && /no progress yet/.test(r.error.message));
  r = await S.sb.rpc('marginalia_add', { p_book_id: 'b-nopc', p_page: 1, p_body: 'no count' });
  ok('add: a copy without a page count refuses (no honest fraction exists)', !!r.error && /page count needed/.test(r.error.message));
  // ISBN-10/13 meeting: Petra writes via her ISBN-10 copy.
  S.setUid(PET);
  r = await S.sb.rpc('marginalia_add', { p_book_id: 't-dragon', p_page: 60, p_body: 'Petra was here, early.' });
  const petraKey = A.marginalia_notes.find(n => n.author_id === PET).book_key;
  const peteKey = A.marginalia_notes.find(n => n.author_id === PAL).book_key;
  ok('ISBN-10 and ISBN-13 copies of the same edition share one book key',
    r.data === 'ok' && petraKey === peteKey && petraKey === 'isbn:' + ISBN(7));
  // Author switch off → for_book serves nothing of theirs and add returns 'off'.
  A.profiles.find(p => p.user_id === PAL).marginalia_enabled = false;
  S.setUid(ME);
  r = await S.sb.rpc('marginalia_for_book', { p_book_id: 'b-dragon' });
  ok('author toggle OFF: their notes stop being served to friends',
    Array.isArray(r.data) && !r.data.some(n => n.author_id === PAL) && r.data.some(n => n.author_id === PET));
  S.setUid(PAL);
  r = await S.sb.rpc('marginalia_add', { p_book_id: 'p-dragon', p_page: 5, p_body: 'while off' });
  ok('author toggle OFF: add returns off', r.data === 'off');
  A.profiles.find(p => p.user_id === PAL).marginalia_enabled = true;

  /* ---- DOM: fraction gating end to end ---- */
  seed(); resetClient(); S.setUid(ME);
  A.marginalia_notes.push(
    note(PAL, 'p-dragon', 120, 400, 'Early Pete note — the map.'),
    note(PAL, 'p-dragon', 212, 400, 'SPOILER Pete note — the betrayal.'),
    note(PAL, 'p-dragon', 390, 400, 'LATE Pete note — the ending.'),
    note(PET, 't-dragon', 60, 300, 'Petra early note.'),
    note(ME, 'b-dragon', 290, 300, 'My own late note.'));
  freshSlot();
  run('window.__f = fillMarginalia(' + JSON.stringify(clientDragon) + ');');
  await w.__f; await tick(3);
  const html1 = slot().innerHTML;
  ok('DOM: notes at/below my progress render (Pete early, Petra early)',
    html1.includes('Early Pete note') && html1.includes('Petra early note'));
  ok('DOM: notes beyond my progress are ABSENT — not blurred, not counted, not hinted',
    !html1.includes('SPOILER Pete note') && !html1.includes('LATE Pete note') &&
    !/locked|more note|hidden note/i.test(html1));
  ok('DOM: my own note renders even beyond my current progress (author asymmetry)',
    html1.includes('My own late note'));
  ok('DOM: same page count shows the real page; a different edition shows the fraction phrase',
    !html1.includes('p. 120') && html1.includes('p. 60') && html1.includes('about a third in'));
  ok('DOM: Report and Block are wired on friends’ notes; Delete on mine',
    /data-marg-report="seed-/.test(html1) && /data-marg-block="pal-2"/.test(html1) &&
    /data-marg-del="seed-/.test(html1));
  // The stub payload itself never carried the locked notes.
  S.setUid(ME);
  const payload = await S.sb.rpc('marginalia_for_book', { p_book_id: 'b-dragon' });
  ok('DATA: the read payload itself omits locked notes (server-side gate, not client hiding)',
    !payload.data.some(n => n.body.includes('SPOILER')) && !payload.data.some(n => n.body.includes('LATE Pete')));
  // Finishing the book unlocks everything.
  run('library[0].status = "read";');
  A.books.find(b => b.book_id === 'b-dragon').data.status = 'read';
  run('window.__f2 = fillMarginalia(library[0]);');
  await w.__f2; await tick(3);
  ok('DOM: finishing the book unlocks all friends’ notes',
    slot().innerHTML.includes('SPOILER Pete note') && slot().innerHTML.includes('LATE Pete note'));
  // Re-read: progress back to 10 but a finish date stands → still unlocked.
  run('library[0].status = "reading"; library[0].progress = 10; library[0].dateFinished = "2026-09-01";');
  A.books.find(b => b.book_id === 'b-dragon').data = Object.assign({}, A.books.find(b => b.book_id === 'b-dragon').data,
    { status: 'reading', progress: 10, dateFinished: '2026-09-01' });
  run('window.__f3 = fillMarginalia(library[0]);');
  await w.__f3; await tick(3);
  ok('DOM: a re-read never re-locks (historical finish evidence)',
    slot().innerHTML.includes('SPOILER Pete note'));
  run('library[0].dateFinished = null; library[0].progress = 150; library[0].status = "reading";');
  A.books.find(b => b.book_id === 'b-dragon').data.dateFinished = null;
  A.books.find(b => b.book_id === 'b-dragon').data.progress = 150;
  A.books.find(b => b.book_id === 'b-dragon').data.status = 'reading';

  /* ---- unfriend + block hide in both directions ---- */
  A.circle_links = A.circle_links.filter(l => l.addressee_id !== PAL);
  run('window.__f4 = fillMarginalia(' + JSON.stringify(clientDragon) + ');');
  await w.__f4; await tick(3);
  ok('DOM: unfriending hides their notes (read-time recheck, nothing cached open)',
    !slot().innerHTML.includes('Early Pete note') && slot().innerHTML.includes('Petra early note'));
  A.circle_links.push({ id: 'l1b', requester_id: ME, addressee_id: PAL, status: 'accepted' });
  A.blocks.push({ id: 'bl1', blocker_id: ME, blocked_id: PAL });
  run('window.__f5 = fillMarginalia(' + JSON.stringify(clientDragon) + ');');
  await w.__f5; await tick(3);
  ok('DOM: a block in either direction hides the notes',
    !slot().innerHTML.includes('Early Pete note'));
  A.blocks = [];

  /* ---- shield: no fetch, no text ---- */
  A.marginalia_notes.push(note(PAL, 'p-shield', 100, 400, 'Shield-tale secret note.'));
  w.localStorage.setItem('cozylibram.privacy.v1', JSON.stringify({ shield: true }));
  A.rpcCalls = [];
  run('window.__f6 = fillMarginalia(library[1]);');
  await w.__f6; await tick(3);
  ok('shield: the read RPC is NEVER called for a shield-held book',
    !A.rpcCalls.includes('marginalia_for_book'));
  ok('shield: only the content-free line renders (no note bodies, no author names)',
    slot().innerHTML.includes('content shield') && !slot().innerHTML.includes('Shield-tale secret') &&
    !slot().innerHTML.includes('Pete'));
  w.localStorage.removeItem('cozylibram.privacy.v1');

  /* ---- toggle OFF (client + server agreement) ---- */
  freshSlot();
  w.localStorage.setItem('cozylibram.marginalia', 'off');
  A.rpcCalls = [];
  run('window.__f7 = fillMarginalia(' + JSON.stringify(clientDragon) + ');');
  await w.__f7; await tick(3);
  ok('toggle OFF locally: no section renders and the RPC is never called',
    slot().innerHTML === '' && !A.rpcCalls.includes('marginalia_for_book'));
  w.localStorage.removeItem('cozylibram.marginalia');
  freshSlot();
  A.profiles.find(p => p.user_id === ME).marginalia_enabled = false;
  run('margReconciled = false; window.__f8 = fillMarginalia(' + JSON.stringify(clientDragon) + ');');
  await w.__f8; await tick(3);
  ok('toggle OFF server-side: reconcile mirrors it locally and the section stays empty',
    slot().innerHTML === '' && w.localStorage.getItem('cozylibram.marginalia') === 'off');
  A.profiles.find(p => p.user_id === ME).marginalia_enabled = true;
  w.localStorage.removeItem('cozylibram.marginalia');
  run('margReconciled = false;');

  /* ---- report: the snapshot lands in user_reports ---- */
  run('window.__f9 = fillMarginalia(' + JSON.stringify(clientDragon) + ');');
  await w.__f9; await tick(3);
  const peteNoteEl = [...slot().querySelectorAll('.marg-note')].find(el => el.textContent.includes('Early Pete note'));
  const repBtn = peteNoteEl.querySelector('[data-marg-report]');
  repBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(3);
  const repSheet = w.document.querySelector('.coven-sheet');
  ok('report: tapping Report opens the reason sheet (swipe-dismiss sheet family)',
    !!repSheet && repSheet.textContent.includes('Report margin note'));
  const sendBtn = [...repSheet.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send report');
  sendBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(4);
  ok('report: the row lands with the NOTE SNAPSHOT attached (moderation can act without the RPC)',
    A.user_reports.length === 1 && A.user_reports[0].reported_user_id === PAL &&
    A.user_reports[0].details.includes('Early Pete note') &&
    A.user_reports[0].details.includes('Margin note'));

  /* ---- composer: pin bound, 280 cap, stored shape ---- */
  run('window.__f10 = fillMarginalia(' + JSON.stringify(clientDragon) + ');');
  await w.__f10; await tick(3);
  const composeBtn = slot().querySelector('[data-marg-compose]');
  ok('composer: offered on a started book with a page count', !!composeBtn);
  composeBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 60 && !w.document.querySelector('#marg-page'); i++) await tick(2);
  const sheet = [...w.document.querySelectorAll('.coven-sheet')].pop();
  const pin = sheet.querySelector('#marg-page');
  const body = sheet.querySelector('#marg-body');
  ok('composer: the pin defaults to my progress and CANNOT exceed it',
    pin.value === '150' && pin.max === '150');
  body.value = 'A note at my exact place.';
  body.dispatchEvent(new w.Event('input', { bubbles: true }));
  const postBtn = [...sheet.querySelectorAll('button')].find(b => b.textContent.trim() === 'Leave note');
  const before = A.marginalia_notes.filter(n => n.author_id === ME).length;
  postBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(8);
  const mine = A.marginalia_notes.filter(n => n.author_id === ME);
  ok('composer: posting stores frac = pin / MY edition page count',
    mine.length === before + 1 && Math.abs(mine[mine.length - 1].frac - 150 / 300) < 1e-9 &&
    mine[mine.length - 1].page_count === 300);
  // Unstarted + no-page-count books offer no composer.
  run('window.__f11 = fillMarginalia(library[2]);');
  await w.__f11; await tick(3);
  ok('composer: not offered on an unstarted book', !slot().querySelector('[data-marg-compose]'));
  run('window.__f12 = fillMarginalia(library[3]);');
  await w.__f12; await tick(3);
  ok('composer: a book without a page count shows the honest hint instead',
    slot().innerHTML.includes('page count') && !slot().querySelector('[data-marg-compose]'));

  /* ---- my-notes list (orphan reach): delete from Settings ---- */
  const mineBox = w.document.createElement('div');
  w.document.body.appendChild(mineBox);
  const renderMine = run('renderMarginaliaMine');
  await renderMine(mineBox); await tick(4);
  ok('my notes: the author’s list renders with Delete wired',
    mineBox.innerHTML.includes('My margin notes') &&
    !!mineBox.querySelector('[data-marg-mine-del]'));
  const delBtn = mineBox.querySelector('[data-marg-mine-del]');
  const delId = delBtn.getAttribute('data-marg-mine-del');
  delBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await tick(6);
  ok('my notes: Delete removes the row server-side',
    !A.marginalia_notes.some(n => n.id === delId));

  /* ---- fail closed: backend absent ---- */
  A.missing = true;
  run('margTableMissing = false; margSupportKnown = null; margReconciled = false;');
  freshSlot();
  let threw = false;
  try { run('window.__f13 = fillMarginalia(' + JSON.stringify(clientDragon) + ');'); await w.__f13; } catch (e) { threw = true; }
  await tick(3);
  ok('fail closed: pre-migration the feature is invisible and nothing throws',
    !threw && slot().innerHTML === '' && run('marginaliaEnabled()') === true);
  A.missing = false;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
