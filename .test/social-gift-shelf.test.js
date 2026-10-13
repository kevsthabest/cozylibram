// Social #4 (v529): the gift shelf — a friend's wishlist appears in
// friend browsing, behind the SAME sharing machinery as the status
// shelves.
//
// The facts under test:
// - The wishlist is NOT a status: it is owned === 'tobuy' on ordinary
//   book rows. STATUS must never gain a 'wishlist' key; hidden_shelves
//   gains it as a pseudo-shelf key, labelled by shelfLabel().
// - Default posture (the User's explicit call): visible by default —
//   share_library on + 'wishlist' not hidden ⇒ the gift shelf renders.
//   The owner's per-shelf hide control is the opt-out.
// - Hidden 'wishlist' ⇒ tobuy rows stop crossing at the POLICY level
//   (the three-argument circle_book_visible overload in the books
//   policy): the friend cannot fetch them at all, so a hidden wishlist
//   is indistinguishable from an empty one (the v522 silence rule, incl.
//   its probe form: helper answers never exceed what loading shows).
// - Payload parity: gift-shelf rows are ordinary book rows — the same
//   shape the status shelves return, nothing extra, and no
//   owner-visible view tracking of any kind.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in gift-shelf tests'); };
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

/* ---------- stub: faithful v529 books-policy semantics ---------- */
const mkStub = () => {
  const db = { circle_links: [], profiles: {}, books: [], blocks: [], works: [] };
  const asUser = () => window.__uid;
  const pairBlocked = (a, b) => db.blocks.some(x =>
    (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
  const linked = (a, b, statuses) => db.circle_links.some(l => statuses.indexOf(l.status) !== -1 &&
    ((l.requester_id === a && l.addressee_id === b) || (l.addressee_id === a && l.requester_id === b)));
  // v522/v526 two-argument helper, statement-faithful (incl. the
  // trailing books EXISTS — even the owner's probe of an empty
  // status answers false).
  const helper2 = (viewer, owner, status) => {
    if (!viewer) return false;
    let base;
    if (viewer === owner) base = true;
    else if (pairBlocked(viewer, owner)) base = false;
    else if (!linked(viewer, owner, ['accepted'])) base = false;
    else {
      const p = db.profiles[owner];
      base = (!p || p.share_library !== false) &&
        ((p && p.hidden_shelves) || []).indexOf(status) === -1;
    }
    return base && db.books.some(r => r.user_id === owner && (r.data.status || '') === (status || ''));
  };
  // v529 three-argument overload: the two-argument answer, plus a
  // tobuy row crosses only when 'wishlist' is not hidden — with the
  // tobuy-keyed EXISTS so probes stay inside what loading shows.
  const helper3 = (viewer, owner, status, owned) => {
    if (!helper2(viewer, owner, status)) return false;
    if ((owned || '') !== 'tobuy') return true;
    const p = db.profiles[owner];
    if (((p && p.hidden_shelves) || []).indexOf('wishlist') !== -1) return false;
    return db.books.some(r => r.user_id === owner &&
      (r.data.status || '') === (status || '') && (r.data.owned || '') === 'tobuy');
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
    if (name === 'profiles') return Object.values(db.profiles).filter(p => p.user_id === me); // owner-only (v522)
    if (name === 'circle_profiles') {
      return Object.values(db.profiles)
        .filter(p => p.user_id === me || (linked(me, p.user_id, ['accepted', 'pending']) && !pairBlocked(me, p.user_id)))
        .map(projectPublic);
    }
    if (name === 'blocks') return db.blocks.filter(b => b.blocker_id === me);
    if (name === 'circle_links') return db.circle_links.filter(l => l.requester_id === me || l.addressee_id === me);
    if (name === 'books') {
      // the v529 policy: own rows, or an accepted link + the gate.
      // stub.policyV529 = false emulates the pre-migration policy
      // (two-argument call — the owned facet invisible to it).
      return db.books.filter(r => {
        if (r.user_id === me) return true;
        if (!linked(me, r.user_id, ['accepted'])) return false;
        return stub.policyV529
          ? helper3(me, r.user_id, r.data.status, r.data.owned)
          : helper2(me, r.user_id, r.data.status);
      });
    }
    return db[name] || [];
  };
  const stub = { db, policyV529: true, helper2, helper3,
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'not found' } }) }) },
    from(name) {
      return {
        select(cols) {
          const q = { conds: [],
            eq(c, v) { q.conds.push([c, v]); return q; },
            _run() { return rowsOf(name).filter(r => q.conds.every(([c, v]) => r[c] === v)); },
            maybeSingle() { const rs = q._run(); return Promise.resolve({ data: rs[0] || null, error: null }); },
            then(res, rej) { try { return res({ data: q._run(), error: null }); } catch (e) { return rej(e); } },
          };
          return q;
        },
        upsert(row) {
          if (name === 'profiles') db.profiles[row.user_id] = Object.assign({}, db.profiles[row.user_id], row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return stub;
};

const ME = 'user-me', PAL = 'user-pal', EVE = 'user-eve', O2 = 'user-gift2', O3 = 'user-gift3';
const stub = mkStub();
const useAs = (uid) => {
  window.__uid = uid;
  runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "' + uid + '@x.y" }' : 'null') + ';');
};
const NOW = new Date().toISOString();

(async () => {
  require('./harness').loadApp(window);
  await tick(3);
  window.__sbStub = stub;

  /* ---------- fixtures ---------- */
  const prof = (id, first, hidden) => ({ user_id: id, first_name: first, last_name: 'Reader', gender: 'f',
    avatar_id: 'moon', avatar_path: '', share_library: true, hidden_shelves: hidden || [],
    bio: '', fav_genres: [], share_bio: true, share_activity: false, updated_at: NOW });
  stub.db.profiles[ME] = prof(ME, 'Me');
  stub.db.profiles[PAL] = prof(PAL, 'Pal');
  stub.db.profiles[EVE] = prof(EVE, 'Eve');
  stub.db.profiles[O2] = prof(O2, 'Hidden', ['wishlist']); // wishlist hidden, owns NO tobuy books
  stub.db.profiles[O3] = prof(O3, 'Open');                 // wishlist visible, owns NO tobuy books
  const link = (a, b) => stub.db.circle_links.push({ requester_id: a, addressee_id: b, status: 'accepted', created_at: '2026-09-01T00:00:00Z' });
  link(ME, PAL); link(O2, PAL); link(O3, PAL);
  const bookRow = (user_id, data) => ({ user_id, book_id: data.id, isbn: null, data });
  const mbook = (id, title, status, owned, extra) => bookRow(ME, Object.assign({
    id, title, authors: ['An Author'], status, owned, myRating: 0, ratings: {},
    cover: 'https://x/' + id + '.jpg', categories: ['Fiction'] }, extra || {}));
  stub.db.books.push(mbook('wish-tbr', 'Wished For', 'tbr', 'tobuy'));
  stub.db.books.push(mbook('wish-hot', 'Wished Hot', 'tbr', 'tobuy', { ratings: { spice: 5 }, axes: ['spice'] }));
  stub.db.books.push(mbook('wish-read', 'Read And Wished', 'read', 'tobuy', { dateFinished: NOW }));
  stub.db.books.push(mbook('plain-tbr', 'Plain TBR', 'tbr', 'owned'));
  stub.db.books.push(mbook('plain-read', 'Plain Read', 'read', 'owned', { dateFinished: NOW }));
  stub.db.books.push(mbook('dnf-book', 'Set Aside', 'dnf', 'owned'));
  const fetchIds = async (viewer, owner) => {
    useAs(viewer);
    const bs = await probe('circleFriendBooks("' + owner + '")');
    return bs.map(b => b.id).sort();
  };

  /* ---------- A. representation invariants ---------- */
  ok('STATUS has exactly the four statuses (wishlist is NOT a status)',
    JSON.stringify(probe('Object.keys(STATUS)').sort()) === JSON.stringify(['dnf', 'read', 'reading', 'tbr']));
  ok('shelfLabel names the pseudo-shelf and the statuses',
    probe('shelfLabel("wishlist")') === 'Wishlist' && probe('shelfLabel("dnf")') === probe('STATUS.dnf'));
  const src195 = fs.readFileSync(path.join(APP_DIR, 'js/195-coven.js'), 'utf8');
  const src180 = fs.readFileSync(path.join(APP_DIR, 'js/180-settings.js'), 'utf8');
  ok('friend view: gift shelf is the owned facet, not a status filter',
    src195.includes("circShelf === 'wishlist' ? circBooks.filter(b => b.owned === 'tobuy')"));
  ok('owner controls: wishlist rides the hide lists in coven + settings',
    src195.includes("'tbr', 'reading', 'read', 'dnf', 'wishlist'") &&
    src180.includes("shelves.push('wishlist')"));
  ok('no wishlist view-tracking is introduced anywhere in the coven file',
    !/track\([^)]*wishlist/i.test(src195) && !/track\([^)]*gift/i.test(src195));

  /* ---------- B. SQL shape pins (migration + schema mirror) ---------- */
  const mig = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v529_gift_shelf.sql'), 'utf8');
  const sch = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
  const fnBody = (sql, sig) => {
    const i = sql.indexOf(sig);
    if (i < 0) return '';
    const j = sql.indexOf('$$;', i);
    return j < 0 ? '' : sql.slice(i, j + 3);
  };
  [['migration', mig], ['schema.sql', sch]].forEach(([label, sql]) => {
    const over = fnBody(sql, 'create or replace function public.circle_book_visible(p_owner uuid, p_status text, p_owned text)');
    ok('sql (' + label + '): three-argument overload exists', over.length > 0);
    ok('sql (' + label + '): overload delegates to the two-argument answer',
      over.includes('select public.circle_book_visible(p_owner, p_status)'));
    ok('sql (' + label + '): overload gates tobuy on wishlist not hidden',
      /coalesce\(p_owned, ''\) <> 'tobuy'/.test(over) &&
      /'wishlist' = any \(coalesce\(p\.hidden_shelves/.test(over));
    ok('sql (' + label + '): overload probe EXISTS is keyed to tobuy books',
      /coalesce\(b\.data ->> 'owned', ''\) = 'tobuy'/.test(over) &&
      /coalesce\(b\.data ->> 'status', ''\) = coalesce\(p_status, ''\)/.test(over));
    ok('sql (' + label + '): overload has its own grant, scoped to its signature',
      sql.includes('grant execute on function public.circle_book_visible(uuid, text, text) to authenticated'));
    ok('sql (' + label + '): books policy passes the owned facet to the gate',
      sql.includes("circle_book_visible(books.user_id, books.data->>'status', books.data->>'owned')"));
    ok('sql (' + label + '): two-argument definition still precedes the overload (agreement-pin order)',
      sql.indexOf('circle_book_visible(p_owner uuid, p_status text)') !== -1 &&
      sql.indexOf('circle_book_visible(p_owner uuid, p_status text)') <
      sql.indexOf('circle_book_visible(p_owner uuid, p_status text, p_owned text)'));
  });
  ok('sql: two-argument body agrees between migration and schema.sql',
    fnBody(mig, 'create or replace function public.circle_book_visible(p_owner uuid, p_status text)').replace(/\s+/g, ' ') ===
    fnBody(sch, 'create or replace function public.circle_book_visible(p_owner uuid, p_status text)').replace(/\s+/g, ' '));

  /* ---------- C. policy visibility matrix (emulated, end to end) ---------- */
  const ALL = ['dnf-book', 'plain-read', 'plain-tbr', 'wish-hot', 'wish-read', 'wish-tbr'];
  ok('default posture: friend fetches every book, wishlist included',
    JSON.stringify(await fetchIds(PAL, ME)) === JSON.stringify(ALL));
  stub.db.profiles[ME].hidden_shelves = ['dnf'];
  ok('hiding a status shelf removes only that shelf; the wishlist is unaffected',
    JSON.stringify(await fetchIds(PAL, ME)) === JSON.stringify(ALL.filter(x => x !== 'dnf-book')));
  stub.db.profiles[ME].hidden_shelves = ['wishlist'];
  ok('hiding the wishlist: NO tobuy row crosses, other shelves untouched',
    JSON.stringify(await fetchIds(PAL, ME)) === JSON.stringify(['dnf-book', 'plain-read', 'plain-tbr']));
  ok('hiding the wishlist also removes the read+tobuy row (one row, no facet split)',
    (await fetchIds(PAL, ME)).indexOf('wish-read') === -1);
  stub.db.profiles[ME].hidden_shelves = [];
  stub.db.profiles[ME].share_library = false;
  ok('share_library off: nothing crosses at all', (await fetchIds(PAL, ME)).length === 0);
  stub.db.profiles[ME].share_library = true;
  ok('stranger fetches nothing in any posture', (await fetchIds(EVE, ME)).length === 0);
  stub.db.profiles[ME].hidden_shelves = ['wishlist'];
  ok('stranger + hidden wishlist: still nothing', (await fetchIds(EVE, ME)).length === 0);
  stub.db.profiles[ME].hidden_shelves = [];

  /* ---------- D. probe silence ---------- */
  ok('probe: hidden wishlist + tobuy book present -> gate closed for tobuy only',
    stub.helper3(PAL, ME, 'tbr', 'tobuy') === true); // baseline: visible posture
  stub.db.profiles[ME].hidden_shelves = ['wishlist'];
  ok('probe: hidden wishlist closes the tobuy gate, owned gate stays open',
    stub.helper3(PAL, ME, 'tbr', 'tobuy') === false && stub.helper3(PAL, ME, 'tbr', 'owned') === true);
  stub.db.profiles[ME].hidden_shelves = [];
  ok('probe: hidden-vs-empty is indistinguishable (owner with no tobuy books)',
    stub.helper3(PAL, O2, 'tbr', 'tobuy') === false && stub.helper3(PAL, O3, 'tbr', 'tobuy') === false &&
    stub.helper3(PAL, O2, 'tbr', 'tobuy') === stub.helper3(PAL, O3, 'tbr', 'tobuy'));
  ok('probe: two-argument answers unchanged by the overload (owned never enters it)',
    stub.helper2(PAL, ME, 'tbr') === true && stub.helper2(PAL, ME, 'reading') === false);

  /* ---------- E. payload parity ---------- */
  useAs(PAL);
  const rows = await probe('circleFriendBooks("' + ME + '")');
  const keysOf = (b) => Object.keys(b).sort().join(',');
  const wishRow = rows.find(b => b.id === 'wish-tbr'), plainRow = rows.find(b => b.id === 'plain-tbr');
  ok('gift-shelf rows are ordinary book rows (identical key shape to status-shelf rows)',
    !!wishRow && !!plainRow && keysOf(wishRow) === keysOf(plainRow));
  ok('fetched rows carry no gift/view bookkeeping fields',
    rows.every(b => !('wishlist' in b) && !('gift' in b) && !('viewed' in b) && !('viewedBy' in b)));

  /* ---------- F. friend UI: the gift shelf renders ---------- */
  runInWindow('circFriend = { id: "' + ME + '", name: "Me Myself" }; circShelf = "all";');
  probe('renderCovenFriend()'); await tick(8);
  const wishChip = window.document.querySelector('[data-cf="wishlist"]');
  ok('friend view renders a Wishlist chip', !!wishChip && /Wishlist/.test(wishChip.textContent));
  ok('wishlist chip carries the tobuy count', !!wishChip && /·\s*3/.test(wishChip.textContent));
  wishChip.click(); await tick(4);
  let cards = Array.from(window.document.querySelectorAll('#view .book-card')).map(c => c.dataset.id).sort();
  ok('gift shelf shows exactly the tobuy books',
    JSON.stringify(cards) === JSON.stringify(['wish-hot', 'wish-read', 'wish-tbr']));
  // preview from the gift shelf: capture the modal call
  runInWindow('window.__pm = null; openPreviewModal = (t, o) => { window.__pm = { t, o }; };');
  const wishBook = probe('circBookMap["wish-tbr"]');
  probe('openCovenBook(circBookMap["wish-tbr"])');
  ok('preview from the gift shelf names the Wishlist shelf',
    !!window.__pm && /Wishlist shelf/.test(window.__pm.o.contextNote || ''));
  runInWindow('delete window.__pm;');
  ok('the captured book is the wishlist book itself', !!wishBook && wishBook.owned === 'tobuy');

  /* ---------- G. shield treatment on the gift shelf ---------- */
  runInWindow('circShelf = "wishlist";');
  probe('renderCovenFriendMain()'); await tick(4);
  probe('setShield(true)'); await tick(6);
  probe('renderCovenFriendMain()'); await tick(6);
  const hotCard = window.document.querySelector('.book-card[data-id="wish-hot"]');
  const calmCard = window.document.querySelector('.book-card[data-id="wish-tbr"]');
  ok('shielded viewer: high-spice gift-shelf cover is blurred + tagged',
    !!hotCard && !!hotCard.querySelector('.cover-wrap.shield-blur') && !!hotCard.querySelector('.shield-note'));
  ok('shielded viewer: unrated gift-shelf cover stays clear',
    !!calmCard && !calmCard.querySelector('.cover-wrap.shield-blur'));
  probe('setShield(false)');

  /* ---------- H. owner controls ---------- */
  useAs(ME);
  const priv = await probe('circlePrivacy()');
  const panelHtml = probe('circlePrivacyPanelHTML(' + JSON.stringify(priv) + ', "st", ["tbr", "read", "wishlist"])');
  ok('hide panel offers a Wishlist chip', panelHtml.includes('data-shelf="wishlist"') && />Wishlist</.test(panelHtml));
  const privHidden = Object.assign({}, priv, { hidden: ['wishlist'] });
  const panelHtml2 = probe('circlePrivacyPanelHTML(' + JSON.stringify(privHidden) + ', "st", ["tbr", "read", "wishlist"])');
  ok('hidden wishlist renders active in the panel',
    /data-shelf="wishlist"/.test(panelHtml2) && /chip active" data-shelf="wishlist"/.test(panelHtml2));
  // round-trip: build the panel in the DOM, click the chip, the save lands
  const host = window.document.createElement('div');
  host.id = 'gift-panel-host';
  host.innerHTML = panelHtml;
  window.document.body.appendChild(host);
  runInWindow('wireCirclePrivacyPanel(document.getElementById("gift-panel-host"), ' +
    'JSON.parse(' + JSON.stringify(JSON.stringify(priv)) + '), "st")');
  host.querySelector('[data-shelf="wishlist"]').click(); await tick(4);
  ok('clicking the Wishlist chip saves hidden_shelves with the pseudo-key',
    (stub.db.profiles[ME].hidden_shelves || []).indexOf('wishlist') !== -1);
  ok('...and the friend now fetches no tobuy rows',
    (await fetchIds(PAL, ME)).every(id => id.indexOf('wish-') !== 0));
  useAs(ME); // saves are caller-scoped: be the owner again before clicking
  host.querySelector('[data-shelf="wishlist"]').click(); await tick(4);
  ok('clicking again un-hides (round-trip restores default visibility)',
    (stub.db.profiles[ME].hidden_shelves || []).indexOf('wishlist') === -1 &&
    (await fetchIds(PAL, ME)).indexOf('wish-tbr') !== -1);
  host.remove();

  /* ---------- I. pre-migration window (old policy) ---------- */
  stub.policyV529 = false;
  stub.db.profiles[ME].hidden_shelves = ['wishlist'];
  let threw = false, oldRows = null;
  try { oldRows = await fetchIds(PAL, ME); } catch (e) { threw = true; }
  ok('pre-migration policy: client paths run, rows cross per the old rules (hide lands with the migration)',
    !threw && !!oldRows && oldRows.indexOf('wish-tbr') !== -1);
  stub.policyV529 = true;
  stub.db.profiles[ME].hidden_shelves = [];

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
