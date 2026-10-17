// Circle permissions Phase 1 (v522): the public projection contract.
//
// The ruling under test: a circle friend must not RECEIVE profile fields
// the owner hasn't shared — the payload itself must be clean, not just
// the UI. These tests drive the real app code against a stub Supabase
// client whose circle_profiles "view" faithfully mirrors migration v522
// (identity + posture flags + bio/genres only when share_bio is on;
// gender / hidden_shelves / updated_at are never projected), and assert
// at the object level what the app actually receives.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.COZYLIBRAM_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in circle-privacy tests'); };
window.confirm = () => true;

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

// ---- stub supabase client with a faithful circle_profiles emulation ----
const mkStub = () => {
  const db = {
    circle_invites: [],
    circle_links: [],
    profiles: {},   // user_id -> FULL base row (incl. private fields)
    books: [],
  };
  // The v522 view, mirrored: CASE-gated bio/genres, flags always present,
  // private columns absent entirely.
  const projectPublic = (p) => {
    const out = { user_id: p.user_id, first_name: p.first_name || '', last_name: p.last_name || '',
      avatar_id: p.avatar_id || '', avatar_path: p.avatar_path || '',
      share_library: p.share_library !== false, share_bio: p.share_bio !== false,
      share_activity: p.share_activity === true,
      // v550: the handle is a projected identity column (null until set)
      handle: p.handle || null };
    if (out.share_bio) {
      if (p.bio) out.bio = p.bio;
      if (Array.isArray(p.fav_genres) && p.fav_genres.length) out.fav_genres = p.fav_genres.slice();
    }
    return out;
  };
  const stub = { db, queries: [], missingView: false,
    rowsOf(n) {
      return n === 'profiles' ? Object.values(db.profiles)
        : n === 'circle_profiles' ? Object.values(db.profiles).map(projectPublic)
        : db[n];
    },
  };
  const applyConds = (rows, conds) => rows.filter(r => conds.every(([c, v]) => r[c] === v));
  // PostgREST honors the requested column list — mirror that for base
  // profiles selects so the legacy fallback is tested against what the
  // server would actually send (identity columns only).
  const pickCols = (name, cols, row) => {
    if (name !== 'profiles' || !cols || cols === '*') return row;
    const out = {};
    String(cols).split(',').map(s => s.trim()).forEach(c => { if (c in row) out[c] = row[c]; });
    return out;
  };
  const table = (name) => ({
    select(cols) {
      stub.queries.push({ table: name, cols: String(cols || '') });
      const qq = { _conds: [],
        eq(c, v) { qq._conds.push([c, v]); return qq; },
        ne() { return qq; }, order() { return qq; }, limit() { return qq; }, range() { return qq; },
        in(c, vs) {
          const cur = qq._conds;
          const filtered = { _in: [c, vs] };
          // return a thenable query carrying both conds and the in-list
          return {
            eq(c2, v2) { cur.push([c2, v2]); return this; },
            maybeSingle() {
              let rs = applyConds(stub.rowsOf(name), cur).filter(r => vs.indexOf(r[c]) !== -1);
              return Promise.resolve({ data: rs[0] ? pickCols(name, cols, rs[0]) : null, error: null });
            },
            then(res, rej) {
              try {
                if (name === 'circle_profiles' && stub.missingView) {
                  return res({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.circle_profiles' in the schema cache" } });
                }
                const rs = applyConds(stub.rowsOf(name), cur).filter(r => vs.indexOf(r[c]) !== -1);
                return res({ data: rs.map(r => pickCols(name, cols, r)), error: null });
              } catch (e) { return rej(e); }
            },
          };
        },
        maybeSingle() {
          if (name === 'circle_profiles' && stub.missingView) {
            return Promise.resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.circle_profiles' in the schema cache" } });
          }
          const rs = applyConds(stub.rowsOf(name), qq._conds);
          return Promise.resolve({ data: rs[0] ? pickCols(name, cols, rs[0]) : null, error: null });
        },
        then(res, rej) {
          try {
            if (name === 'circle_profiles' && stub.missingView) {
              return res({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.circle_profiles' in the schema cache" } });
            }
            return res({ data: applyConds(stub.rowsOf(name), qq._conds).map(r => pickCols(name, cols, r)), error: null });
          } catch (e) { return rej(e); }
        },
      };
      return qq;
    },
    upsert(row) {
      if (name === 'profiles') db.profiles[row.user_id] = Object.assign({}, db.profiles[row.user_id], row);
      return Promise.resolve({ error: null });
    },
  });
  stub.from = (t) => table(t);
  return stub;
};

const ME = 'user-me', FON = 'user-fon', FOFF = 'user-foff';
const stub = mkStub();
const useAs = (uid) => runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "' + uid + '@x.y" }' : 'null') + ';');

(async () => {
  require('./harness').loadApp(window);
  await tick(3);
  window.__sbStub = stub;

  // ---- fixtures: full base rows, incl. fields that must never leak ----
  stub.db.profiles[ME] = { user_id: ME, first_name: 'Me', last_name: 'Myself', gender: 'f',
    avatar_id: 'raven', avatar_path: '', share_library: true, hidden_shelves: ['dnf'],
    bio: 'My secret bio', fav_genres: ['Romantasy'], share_bio: true, share_activity: false,
    updated_at: '2026-10-01T00:00:00Z' };
  stub.db.profiles[FON] = { user_id: FON, first_name: 'Ona', last_name: 'Optin', gender: 'f',
    avatar_id: 'moon', avatar_path: '', share_library: true, hidden_shelves: ['dnf'],
    bio: 'Ona reads gothic everything', fav_genres: ['Gothic', 'Horror'], share_bio: true, share_activity: true,
    handle: 'ona_reads',
    updated_at: '2026-10-01T00:00:00Z' };
  stub.db.profiles[FOFF] = { user_id: FOFF, first_name: 'Pam', last_name: 'Private', gender: 'm',
    avatar_id: '', avatar_path: '', share_library: true, hidden_shelves: ['read'],
    bio: 'Pam bio nobody should receive', fav_genres: ['Thriller'], share_bio: false,
    // no share_activity key at all — the pre-v522 / default state: OFF
    updated_at: '2026-10-01T00:00:00Z' };
  stub.db.circle_links.push(
    { requester_id: ME, addressee_id: FON, status: 'accepted', created_at: '2026-09-01T00:00:00Z' },
    { requester_id: FOFF, addressee_id: ME, status: 'accepted', created_at: '2026-09-01T00:00:00Z' },
  );
  const bookRow = (user_id, book_id, data) => ({ user_id, book_id, isbn: data.isbn || null, data });
  stub.db.books.push(bookRow(FON, 'on1', { id: 'on1', title: 'On Book', authors: ['A'], status: 'read', myRating: 5, dateFinished: new Date().toISOString(), categories: ['Fiction / Gothic'] }));
  stub.db.books.push(bookRow(FOFF, 'off1', { id: 'off1', title: 'Off Book', authors: ['B'], status: 'read', myRating: 5, dateFinished: new Date().toISOString(), categories: ['Fiction / Thriller'] }));

  // ---------- payload-level projection assertions ----------
  useAs(ME);
  stub.queries.length = 0;
  const pOn = await probe('circleFriendProfile("' + FON + '")'); await tick();
  ok('opted-in friend: identity present', pOn && pOn.first_name === 'Ona' && pOn.avatar_id === 'moon');
  ok('opted-in friend: toggled-on bio present', pOn.bio === 'Ona reads gothic everything');
  ok('opted-in friend: toggled-on genres present', Array.isArray(pOn.fav_genres) && pOn.fav_genres.join(',') === 'Gothic,Horror');
  ok('opted-in friend: activity flag reads on', pOn.share_activity === true);
  ok('v550: a set handle rides the projection', pOn.handle === 'ona_reads');
  ok('payload has NO gender', !('gender' in pOn));
  ok('payload has NO hidden_shelves', !('hidden_shelves' in pOn));
  ok('payload has NO updated_at', !('updated_at' in pOn));
  ok('friend fetch went to the circle_profiles view', stub.queries.some(x => x.table === 'circle_profiles'));
  ok('friend fetch never touched base profiles', !stub.queries.some(x => x.table === 'profiles'));

  const pOff = await probe('circleFriendProfile("' + FOFF + '")'); await tick();
  ok('opted-out friend: identity still present', pOff && pOff.first_name === 'Pam');
  ok('bio ABSENT when share_bio is off', !('bio' in pOff));
  ok('genres ABSENT when share_bio is off', !('fav_genres' in pOff));
  ok('activity defaults OFF (no flag on the row)', pOff.share_activity === false);
  ok('opted-out payload has NO gender/hidden_shelves', !('gender' in pOff) && !('hidden_shelves' in pOff));

  const lists = await probe('circleLists()'); await tick();
  const lfOff = (lists.friends || []).find(f => f.id === FOFF);
  ok('circleLists friend profile is projected too', lfOff && !('bio' in lfOff.profile) && !('gender' in lfOff.profile) && !('hidden_shelves' in lfOff.profile));
  const lfOn = (lists.friends || []).find(f => f.id === FON);
  ok('circleLists carries toggled-on bio', lfOn && lfOn.profile.bio === 'Ona reads gothic everything');

  // ---------- own profile: full row, all toggles ----------
  const priv = await probe('circlePrivacy()'); await tick();
  ok('own privacy reads share_library', priv.share === true);
  ok('own privacy reads hidden shelves', Array.isArray(priv.hidden) && priv.hidden.join(',') === 'dnf');
  ok('own privacy reads bio toggle', priv.bio === true);
  ok('own privacy reads activity toggle', priv.activity === false);
  const ownRaw = await stub.from('profiles').select('*').eq('user_id', ME).maybeSingle();
  ok('own base-row fetch still returns the full row', ownRaw.data && ownRaw.data.gender === 'f' && Array.isArray(ownRaw.data.hidden_shelves));

  // ---------- migration defaults ----------
  stub.db.profiles[ME] = { user_id: ME, first_name: 'Me', last_name: 'Myself', share_library: false, hidden_shelves: [] };
  const privLegacyOff = await probe('circlePrivacy()'); await tick();
  ok('migration default: existing share_library=false preserved', privLegacyOff.share === false);
  ok('migration default: bio/genres initial ON for existing accounts', privLegacyOff.bio === true);
  ok('migration default: activity initial OFF for everyone', privLegacyOff.activity === false);
  stub.db.profiles[ME].share_library = true;
  const privLegacyOn = await probe('circlePrivacy()'); await tick();
  ok('migration default: existing share_library=true preserved', privLegacyOn.share === true);

  // ---------- toggle round-trip: save -> base row -> friend projection ----------
  await probe('circleSavePrivacy(false, ["tbr"], false, true)'); await tick();
  const saved = stub.db.profiles[ME];
  ok('round-trip persists share_library', saved.share_library === false);
  ok('round-trip persists hidden_shelves', Array.isArray(saved.hidden_shelves) && saved.hidden_shelves.join(',') === 'tbr');
  ok('round-trip persists share_bio', saved.share_bio === false);
  ok('round-trip persists share_activity', saved.share_activity === true);
  const privBack = await probe('circlePrivacy()'); await tick();
  ok('round-trip reads back through circlePrivacy', privBack.share === false && privBack.bio === false && privBack.activity === true);
  useAs(FON); // now view ME through a friend's eyes
  const pMe = await probe('circleFriendProfile("' + ME + '")'); await tick();
  ok('friend sees my shelves flag off', pMe.share_library === false);
  ok('friend does NOT receive my bio after I toggle it off', !('bio' in pMe));
  ok('friend sees my activity opt-in', pMe.share_activity === true);
  ok('friend still cannot see my hidden_shelves values', !('hidden_shelves' in pMe));
  useAs(ME);
  await probe('circleSavePrivacy(true, [], true, false)'); await tick();

  // ---------- fail-safe: app deployed before the migration ----------
  stub.missingView = true;
  const pLegacy = await probe('circleFriendProfile("' + FON + '")'); await tick();
  ok('missing view: falls back and still returns identity', pLegacy && pLegacy.first_name === 'Ona');
  ok('missing view: fallback payload stays clean', pLegacy && !('gender' in pLegacy) && !('hidden_shelves' in pLegacy) && !('bio' in pLegacy));
  const listsLegacy = await probe('circleLists()'); await tick();
  ok('missing view: circleLists still resolves friends', (listsLegacy.friends || []).length === 2);
  stub.missingView = false;

  // ---------- activity gates: stats + recos ----------
  runInWindow('library = [];');
  const stats = await probe('loadCovenStats()'); await tick();
  const stOn = (stats.people || []).find(p => p.id === FON);
  const stOff = (stats.people || []).find(p => p.id === FOFF);
  ok('stats include the opted-in friend\u2019s finished book', stOn && stOn.stats.finished === 1);
  ok('stats exclude the opted-out friend entirely', stOff && stOff.stats.finished === 0 && stOff.stats.books.length === 0);
  // v532 (RC1) rescoped this pin: the friend's books ARE fetched
  // now — for buddy matching only (shelf-browsing, not activity) —
  // so the payload legitimately carries a shelf view (shelfStats)
  // and a whole-object stringify would find the title there. What
  // must stay clean is every ACTIVITY surface: the activity stats
  // (asserted above), moments, digest, now-reading, trending,
  // soulmates, awards — and the buddy list too here, since a 'read'
  // book can never be a TBR match.
  ok('activity surfaces carry no trace of the opted-out friend\u2019s book',
    JSON.stringify({ moments: stats.moments, digest: stats.digest, nowReading: stats.nowReading,
      trending: stats.trending, soulmates: stats.soulmates, awards: stats.awards, buddies: stats.buddies })
      .indexOf('Off Book') === -1);
  const recos = await probe('loadRecos()'); await tick();
  ok('recos include the opted-in friend\u2019s 5-star book', recos.some(r => r.book.title === 'On Book'));
  ok('recos exclude the opted-out friend\u2019s 5-star book', !recos.some(r => r.book.title === 'Off Book'));

  // ---------- the settings panel ----------
  const panelPriv = { share: true, hidden: [], bio: true, activity: false };
  const panelHTML = probe('circlePrivacyPanelHTML(' + JSON.stringify(panelPriv) + ', "st", ["tbr","read"])');
  ok('panel presents name & avatar as identity, not a toggle', panelHTML.indexOf('Name &amp; avatar') !== -1 && panelHTML.indexOf('Always shared') !== -1);
  ok('panel has all three toggles', ['st-share', 'st-bio', 'st-act'].every(id => panelHTML.indexOf('id="' + id + '"') !== -1));
  ok('panel keeps per-shelf hiding', panelHTML.indexOf('id="st-hide"') !== -1);
  ok('panel copy promises payload-level privacy', panelHTML.indexOf('Reading activity') !== -1);
  const mount = window.document.createElement('div');
  mount.innerHTML = panelHTML;
  window.document.body.appendChild(mount);
  probe('wireCirclePrivacyPanel(document.body.lastElementChild, ' + JSON.stringify(panelPriv) + ', "st")');
  mount.querySelector('#st-act [data-v="1"]').click(); await tick(3);
  ok('panel: switching activity on persists share_activity', stub.db.profiles[ME].share_activity === true);
  mount.querySelector('#st-bio [data-v="0"]').click(); await tick(3);
  ok('panel: switching bio off persists share_bio=false', stub.db.profiles[ME].share_bio === false);
  mount.querySelector('#st-hide [data-shelf="tbr"]').click(); await tick(3);
  ok('panel: hide chip persists hidden_shelves', (stub.db.profiles[ME].hidden_shelves || []).indexOf('tbr') !== -1);
  mount.querySelector('#st-share [data-v="0"]').click(); await tick(3);
  ok('panel: shelves toggle writes the SAME share_library field', stub.db.profiles[ME].share_library === false);

  // ---------- bio/genres profile sync (js/105) ----------
  runInWindow('saveProfile({ firstName: "Me", lastName: "Myself", gender: "", avatar: { type: "letter" }, avatarCloudPath: "", updatedAt: Date.now(), bio: "Cloud bio", favGenres: ["Gothic", "Horror"] });');
  await probe('pushCloudProfile(loadProfile())'); await tick(3);
  ok('pushCloudProfile writes bio + fav_genres to the row', stub.db.profiles[ME].bio === 'Cloud bio' &&
    Array.isArray(stub.db.profiles[ME].fav_genres) && stub.db.profiles[ME].fav_genres.join(',') === 'Gothic,Horror');
  const lp = probe('loadProfile()');
  ok('loadProfile round-trips bio/genres locally', lp.bio === 'Cloud bio' && lp.favGenres.join(',') === 'Gothic,Horror');

  // ---------- migration SQL: circle_book_visible probe hardening ----------
  // The helper is RPC-callable by any authenticated user. Without the
  // books EXISTS, an accepted friend could probe the four shelf statuses
  // and reconstruct hidden_shelves even for shelves holding ZERO books —
  // the hiding configuration itself leaking to the person it's hidden
  // from. Pin the hardening in BOTH the migration and the schema.sql
  // mirror (they must stay in agreement), and pin that the accepted-link
  // check still gates everything: a stranger gets false no matter how
  // many books the owner has.
  // v526 note: the helper was superseded by migrations/v526_blocks.sql
  // (a blocked-pair branch ahead of the link check; everything else
  // carried over verbatim). The v522 migration is frozen as applied, so
  // the agreement pin now targets the NEWEST migration defining the
  // helper — the live definition must not drift between it and
  // schema.sql. The shape pins below hold for the v526 body unchanged.
  const fnBody = (sql) => {
    const i = sql.indexOf('create or replace function public.circle_book_visible');
    if (i < 0) return '';
    const j = sql.indexOf('$$;', i);
    return j < 0 ? '' : sql.slice(i, j + 3);
  };
  const migBody = fnBody(fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v526_blocks.sql'), 'utf8'));
  const schemaBody = fnBody(fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8'));
  ok('sql: helper defined in migration and schema mirror', migBody.length > 0 && schemaBody.length > 0);
  ok('sql: migration and schema.sql helper definitions agree',
    migBody.replace(/\s+/g, ' ') === schemaBody.replace(/\s+/g, ' '));
  [['migration', migBody], ['schema.sql', schemaBody]].forEach(([label, body]) => {
    ok('sql (' + label + '): true requires a book of the owner in the queried status',
      /end\)\s+and exists \(\s*select 1 from public\.books b\s+where b\.user_id = p_owner/.test(body));
    ok('sql (' + label + '): book status compared like-with-like (coalesced)',
      /coalesce\(b\.data ->> 'status', ''\) = coalesce\(p_status, ''\)/.test(body));
    ok('sql (' + label + '): accepted-link check still runs first (strangers false regardless of books)',
      /when not exists \(\s*select 1 from public\.circle_links[\s\S]*?cl\.status = 'accepted'[\s\S]*?\) then false/.test(body) &&
      body.indexOf('public.circle_links') < body.indexOf('from public.books') &&
      body.indexOf('public.circle_links') < body.indexOf('from public.profiles'));
    ok('sql (' + label + '): share_library + hidden_shelves test intact behind the link check',
      /select p\.share_library\s+and not \(coalesce\(p_status, ''\) = any \(coalesce\(p\.hidden_shelves/.test(body));
  });

  // ---------- v578: derived-wishlist server parity (issue #232) ----------
  // Since v559 the Wishlist is a DERIVED shelf (status 'tbr' + owned
  // 'tobuy'), but the 2-arg helper gated on the raw status alone, so a
  // hidden 'wishlist' key withheld nothing server-side — derived books
  // reached accepted friends as ordinary TBR rows. v578 adds a 3-arg
  // overload that delegates every 2-arg gate and withholds exactly the
  // derived set, restates the books policy to pass the row's owned
  // facet, and restates marginalia_for_book to pass the author copy's
  // facet (Advisor ruling 2026-10-15: marginalia IN, buddy reads OUT —
  // buddy visibility flows from the pair's per-book accept, not shelf
  // posture, so v528 keeps the 2-arg call by decision, not oversight).
  // Negative control (PR #185 pattern): run this file with COZYLIBRAM_DIR
  // at a pre-v578 checkout and exactly this section's pins must FAIL —
  // the migration file is absent there and schema.sql carries none of
  // it — while every earlier section still passes. readSql turns a
  // missing file into '' so the failure surfaces as named FAIL lines,
  // not a harness error.
  const readSql = (rel) => {
    try { return fs.readFileSync(path.join(APP_DIR, rel), 'utf8'); } catch (e) { return ''; }
  };
  const fnBySig = (sql, sig) => {
    const i = sql.indexOf('create or replace function public.' + sig);
    if (i < 0) return '';
    const j = sql.indexOf('$$;', i);
    return j < 0 ? '' : sql.slice(i, j + 3);
  };
  const mig578 = readSql('supabase/migrations/v578_wishlist_server_parity.sql');
  const schema578 = readSql('supabase/schema.sql');
  const OVERLOAD_SIG = 'circle_book_visible(p_owner uuid, p_status text, p_owned text)';
  const migOver = fnBySig(mig578, OVERLOAD_SIG);
  const schemaOver = fnBySig(schema578, OVERLOAD_SIG);
  ok('v578 sql: wishlist-parity migration file exists', mig578.length > 0);
  [['migration', migOver, mig578], ['schema.sql', schemaOver, schema578]].forEach(([label, body, whole]) => {
    ok('v578 sql (' + label + '): 3-arg overload defined', body.length > 0);
    ok('v578 sql (' + label + '): overload delegates every gate to the 2-arg helper',
      /select public\.circle_book_visible\(p_owner, p_status\)/.test(body));
    ok('v578 sql (' + label + '): withhold clause is exactly the derived set (tbr + tobuy + hidden wishlist)',
      /not \(\s*coalesce\(p_status, ''\) = 'tbr'\s+and coalesce\(p_owned, ''\) = 'tobuy'\s+and exists \(\s*select 1 from public\.profiles p\s+where p\.user_id = p_owner\s+and 'wishlist' = any \(coalesce\(p\.hidden_shelves/.test(body));
    ok('v578 sql (' + label + '): facet EXISTS keeps hidden indistinguishable from no-such-book',
      /and exists \(\s*select 1 from public\.books b\s+where b\.user_id = p_owner\s+and coalesce\(b\.data ->> 'status', ''\) = coalesce\(p_status, ''\)\s+and coalesce\(b\.data ->> 'owned', ''\) = coalesce\(p_owned, ''\)/.test(body));
    ok('v578 sql (' + label + '): overload EXECUTE is authenticated-only',
      whole.includes('revoke all on function public.circle_book_visible(uuid, text, text) from public;') &&
      whole.includes('grant execute on function public.circle_book_visible(uuid, text, text) to authenticated;'));
    ok('v578 sql (' + label + '): books policy passes the row facet into the check',
      whole.includes("public.circle_book_visible(books.user_id, books.data->>'status', books.data->>'owned')"));
  });
  ok('v578 sql: migration and schema.sql overload definitions agree',
    migOver.length > 0 && migOver.replace(/\s+/g, ' ') === schemaOver.replace(/\s+/g, ' '));
  // Marginalia identity: the v578 restatement must be the v574 function
  // VERBATIM apart from the one expression gaining the owned facet
  // (Advisor condition: a pin, not trust). Normalise the known
  // difference away in the v578 copy, then require byte equality.
  const MARG_2ARG = "public.circle_book_visible(n.author_id, ab.data ->> 'status')";
  const MARG_3ARG = "public.circle_book_visible(n.author_id, ab.data ->> 'status', ab.data ->> 'owned')";
  const margV574 = fnBySig(readSql('supabase/migrations/v574_marginalia.sql'), 'marginalia_for_book');
  const margV578 = fnBySig(mig578, 'marginalia_for_book');
  const margSchema = fnBySig(schema578, 'marginalia_for_book');
  ok('v578 sql: marginalia_for_book defined in v574, v578, and schema.sql',
    margV574.length > 0 && margV578.length > 0 && margSchema.length > 0);
  ok('v578 sql: restated marginalia calls the 3-arg overload exactly once, and never the 2-arg form',
    margV578.split(MARG_3ARG).length - 1 === 1 && !margV578.includes(MARG_2ARG));
  ok('v578 sql: marginalia restatement is byte-identical to v574 once the one expression is normalised back',
    margV578.length > 0 && margV578.replace(MARG_3ARG, MARG_2ARG) === margV574);
  ok('v578 sql: schema.sql marginalia_for_book matches the v578 restatement byte-for-byte',
    margSchema.length > 0 && margSchema === margV578);
  // Drift proof: a restatement drifted by a single space in the changed
  // expression must fail the identity pin (in-test string only).
  const margDrift = margV578.replace(MARG_3ARG, MARG_3ARG.replace(", ab.data", ",  ab.data"));
  ok('v578 pin drift proof: a one-space drift in the restated expression breaks the identity pin',
    margV578.length > 0 && margDrift.replace(MARG_3ARG, MARG_2ARG) !== margV574);

  // ---------- circle_profiles projection shape-pin (QA Scout item 1) ----------
  // The behaviour tests above drive a hand-written JS mirror of the view
  // (projectPublic). Until now NOTHING pinned the mirror to the SQL: add
  // `gender` (or drop a CASE gate) in the real view and every behaviour
  // test stayed green while friends received the field. These pins parse
  // the select list out of BOTH live SQL copies — the newest migration
  // definition and the schema.sql mirror — and assert the exact ordered
  // projection, both CASE gates, and the absence of the never-projected
  // columns. "Newest migration" is NOT a hardcoded filename: the scan
  // below walks supabase/migrations/ in filename (apply) order and pins
  // the LAST `create or replace view public.circle_profiles` found, so
  // a future migration that restates the view in a new file is pinned
  // too instead of bypassing a pin stuck on a stale copy (the v522
  // migration is frozen as applied; v526 currently restates its view).
  const viewSelectItems = (sql) => {
    const i = sql.indexOf('create or replace view public.circle_profiles');
    if (i < 0) return null;
    const sel = sql.indexOf('select', i);
    const from = sql.indexOf('\n  from ', sel);
    if (sel < 0 || from < 0) return null;
    return sql.slice(sel + 'select'.length, from)
      .split(',')
      .map(s => s.replace(/\s+/g, ' ').trim());
  };
  const viewStatement = (sql) => {
    const i = sql.indexOf('create or replace view public.circle_profiles');
    if (i < 0) return '';
    const j = sql.indexOf('revoke all on public.circle_profiles', i);
    const raw = j < 0 ? sql.slice(i) : sql.slice(i, j);
    // Strip comment lines: the schema.sql header above the view NAMES the
    // forbidden columns to say they are excluded — that is prose, not SQL.
    return raw.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  };
  // NAMED PIN UPDATE (v550, CONSTRAINTS rule 4): the expected projection
  // gains exactly one column — 'p.handle', appended last by migration
  // v550_handles.sql (the handle is the owner's chosen public identity,
  // projected like the other identity columns; the share_bio CASE gates
  // and every other column are unchanged, and the gate-index assertions
  // below (items 8/9) still target bio/fav_genres). The stub's
  // projectPublic above mirrors the column so behaviour tests see it.
  const EXPECTED_PROJECTION = [
    'p.user_id', 'p.first_name', 'p.last_name', 'p.avatar_id', 'p.avatar_path',
    'p.share_library', 'p.share_bio', 'p.share_activity',
    'case when p.share_bio then p.bio end as bio',
    'case when p.share_bio then p.fav_genres end as fav_genres',
    'p.handle',
  ];
  const projectionHolds = (items) =>
    Array.isArray(items) && JSON.stringify(items) === JSON.stringify(EXPECTED_PROJECTION);
  // Migration scan: read every migration in filename order and keep the
  // LAST view definition (within a file, the last one wins too — it is
  // the statement that runs last). pickLastViewDef is pure over an
  // ordered [{ name, text }] list so the ordering rule is unit-testable
  // below without touching the real directory.
  const VIEW_DEF_RE = /create\s+or\s+replace\s+view\s+public\.circle_profiles\b/gi;
  const pickLastViewDef = (entries) => {
    let found = null;
    entries.forEach(({ name, text }) => {
      const hits = [...text.matchAll(VIEW_DEF_RE)];
      if (hits.length) found = { file: name, sql: text.slice(hits[hits.length - 1].index) };
    });
    return found;
  };
  const migEntries = fs.readdirSync(path.join(APP_DIR, 'supabase/migrations'))
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(name => ({ name, text: fs.readFileSync(path.join(APP_DIR, 'supabase/migrations', name), 'utf8') }));
  const migScan = pickLastViewDef(migEntries);
  ok('sql (scan): a circle_profiles definition is found in the migrations', !!migScan);
  // Independent ordering cross-check: the literal phrase (the exact
  // phrasing both v522 and v526 use) must name the same last file, so a
  // scanner bug cannot quietly pin an earlier definition.
  const literalLast = migEntries
    .filter(e => e.text.includes('create or replace view public.circle_profiles'))
    .map(e => e.name).pop();
  ok('sql (scan): the pinned definition comes from the last migration (in filename order) that defines the view',
    !!migScan && migScan.file === literalLast);
  const migSql = migScan ? migScan.sql : '';
  const schemaSql = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
  [['migration', migSql], ['schema.sql', schemaSql]].forEach(([label, sql]) => {
    const items = viewSelectItems(sql);
    ok('sql (' + label + '): circle_profiles projection is exactly the v522 column list, in order',
      projectionHolds(items));
    ok('sql (' + label + '): bio crosses only behind the share_bio CASE gate',
      !!items && /^case when p\.share_bio then p\.bio end as bio$/.test(items[8] || ''));
    ok('sql (' + label + '): fav_genres crosses only behind the share_bio CASE gate',
      !!items && /^case when p\.share_bio then p\.fav_genres end as fav_genres$/.test(items[9] || ''));
    const stmt = viewStatement(sql);
    ok('sql (' + label + '): gender / hidden_shelves / updated_at appear nowhere in the view',
      !/\bgender\b/.test(stmt) && !/hidden_shelves/.test(stmt) && !/updated_at/.test(stmt));
  });
  ok('sql: migration and schema.sql projections agree with each other',
    JSON.stringify(viewSelectItems(migSql)) === JSON.stringify(viewSelectItems(schemaSql)));
  // Drift proof: the pin MUST fail on a mutated projection — an added
  // column, a dropped CASE gate, a dropped flag. (In-test mutated
  // strings only; the real SQL files are never touched.)
  const goodItems = viewSelectItems(schemaSql);
  const withGender = goodItems.slice(); withGender.splice(3, 0, 'p.gender');
  ok('pin drift proof: an added column (gender) breaks the pin', !projectionHolds(withGender));
  const ungated = goodItems.slice(); ungated[8] = 'p.bio as bio';
  ok('pin drift proof: dropping the bio CASE gate breaks the pin', !projectionHolds(ungated));
  const droppedFlag = goodItems.filter(c => c !== 'p.share_activity');
  ok('pin drift proof: a dropped column breaks the pin', !projectionHolds(droppedFlag));
  // Scanner drift proof: the scan must target the LAST definition, so a
  // future migration restating the view (in a new file, or later in the
  // same file) cannot slip a widened projection past a pin stuck on an
  // earlier copy. Synthetic ordered sets only — real files untouched.
  const mkView = (widened) =>
    'create or replace view public.circle_profiles as\n  select ' +
    ['p.user_id', 'p.first_name', 'p.last_name'].concat(widened ? ['p.gender'] : [],
      ['p.avatar_id', 'p.avatar_path', 'p.share_library', 'p.share_bio', 'p.share_activity',
       'case when p.share_bio then p.bio end as bio',
       'case when p.share_bio then p.fav_genres end as fav_genres',
       'p.handle']).join(',\n         ') +
    '\n  from public.profiles p\n';
  const scanWidened = pickLastViewDef([
    { name: 'v900_earlier.sql', text: mkView(false) },
    { name: 'v901_later.sql', text: mkView(true) },
  ]);
  ok('pin drift proof: the scan targets the last definition in an ordered set',
    !!scanWidened && scanWidened.file === 'v901_later.sql');
  ok('pin drift proof: a later widening restatement fails the projection check',
    !!scanWidened && !projectionHolds(viewSelectItems(scanWidened.sql)));
  const scanRestored = pickLastViewDef([
    { name: 'v900_earlier.sql', text: mkView(true) },
    { name: 'v901_later.sql', text: mkView(false) },
  ]);
  ok('pin drift proof: the scan follows order, not content (a later sound restatement passes)',
    !!scanRestored && scanRestored.file === 'v901_later.sql' &&
    projectionHolds(viewSelectItems(scanRestored.sql)));
  const scanDoubled = pickLastViewDef([
    { name: 'v900_single.sql', text: mkView(false) + '\n' + mkView(true) },
  ]);
  ok('pin drift proof: within one file, the last of two definitions is the pinned one',
    !!scanDoubled && !projectionHolds(viewSelectItems(scanDoubled.sql)));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
