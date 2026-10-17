// "Reading it too" (v541, Social build #5): shared-reading presence
// on the ratified Buddy Reads model — presence, not pace.
//
// The contract under test (v528 ruling, reaffirmed v532):
// - consent = the shelf-visible path alone (accepted link, unblocked
//   pair, share_library, per-shelf visibility). The share_activity
//   toggle does NOT gate: a friend who shares shelves but not
//   activity still shows up here, exactly as in buddy matching.
// - only a friend's 'reading' copy counts; only the copy's status is
//   ever consulted — no progress, pages, logs, or dates anywhere in
//   the rendered output.
// - no counts: friends appear as avatars + names, never a numeral.
// - shield (v524): a shielded viewer gets NO row for a work whose
//   spice is known >= 4 (suppressed whole); unknown spice is not
//   high and never suppresses.
// - matching is recoKey (isbn / title+author), never row or app ids.
//
// The stub emulates the v522 books SELECT policy (circle_book_visible)
// the way social-remediation-a.test.js does; the real enforcement is
// RLS, unchanged by this feature (no migration, no new reads).
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in reading-it-too tests'); };
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

const ME = 'u-me', ALY = 'u-aly', BEN = 'u-ben', HAN = 'u-han', NOR = 'u-nor', BLR = 'u-blr', FAY = 'u-fay';
const ISBN_A = '9780000001001'; // Shared Quest — the shared read
const ISBN_Q = '9780000001002'; // Quiet Pages — Alyssa reads, mine sits on TBR
const ISBN_S = '9780000001003'; // Solo Read — nobody else reads it
const ISBN_P = '9780000001004'; // Spicy Tale — known spice 5
const ISBN_M = '9780000001005'; // Mild Mystery — no spice signal anywhere

/* ---------- Supabase stub with the v522 visibility emulation ---------- */
const mkStub = () => {
  const db = { circle_links: [], profiles: {}, books: [], blocks: [] };
  const caller = () => window.__uid;
  const linked = (a, b, statuses) => db.circle_links.some(l =>
    (!statuses || statuses.indexOf(l.status) !== -1) &&
    ((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
  const blocked = (a, b) => db.blocks.some(x =>
    (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
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
    if (name === 'profiles') return Object.values(db.profiles);
    if (name === 'circle_profiles') return Object.values(db.profiles)
      .filter(p => p.user_id === caller() || linked(caller(), p.user_id, ['accepted', 'pending']))
      .map(projectPublic);
    return db[name] || [];
  };
  // The books SELECT policy (v522 circle_book_visible), emulated.
  const bookVisible = (row) => {
    if (row.user_id === caller()) return true;
    const owner = db.profiles[row.user_id] || {};
    if (!linked(caller(), row.user_id, ['accepted'])) return false;
    if (blocked(caller(), row.user_id)) return false;
    if (owner.share_library === false) return false;
    const hidden = Array.isArray(owner.hidden_shelves) ? owner.hidden_shelves : [];
    return hidden.indexOf((row.data || {}).status) === -1;
  };
  const applyConds = (rows, conds) => rows.filter(r => conds.every(([c, v]) => r[c] === v));
  const table = (name) => ({
    select() {
      const q = { _conds: [], _in: null, _limit: null,
        eq(c, v) { q._conds.push([c, v]); return q; },
        ne() { return q; }, order() { return q; }, range() { return q; },
        limit(n) { q._limit = n; return q; },
        in(c, vs) { q._in = [c, vs]; return q; },
        maybeSingle() { const rs = q._run(); return Promise.resolve({ data: rs[0] || null, error: null }); },
        _run() {
          let rs = rowsOf(name);
          if (name === 'books') rs = rs.filter(bookVisible);
          rs = applyConds(rs, q._conds);
          if (q._in) rs = rs.filter(r => q._in[1].indexOf(r[q._in[0]]) !== -1);
          if (q._limit) rs = rs.slice(0, q._limit);
          return rs;
        },
        then(res, rej) { try { res({ data: q._run(), error: null }); } catch (e) { rej(e); } },
      };
      return q;
    },
    upsert() { return Promise.resolve({ error: null }); },
  });
  return { db, from: (t) => table(t),
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'not found' } }) }) },
    rpc() { return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'not stubbed' } }); } };
};

const stub = mkStub();
const useAs = (uid) => { window.__uid = uid; runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "x@y.z" }' : 'null') + ';'); };
const bookRow = (uid, id, data) => ({ user_id: uid, book_id: id, isbn: data.isbn || null, data });
const B = (id, title, authors, isbn, status, extra) =>
  Object.assign({ id, title, authors, isbn, status, cover: '', coverColor: '', ratings: {} }, extra || {});

const MY_LIBRARY = [
  B('me-quest', 'Shared Quest', ['Q. Author'], ISBN_A, 'reading'),
  B('me-solo', 'Solo Read', ['S. Solo'], ISBN_S, 'reading'),
  B('me-quiet', 'Quiet Pages', ['Q. Author'], ISBN_Q, 'tbr'),
  B('me-spicy', 'Spicy Tale', ['H. Heat'], ISBN_P, 'tbr', { ratings: { spice: 5 } }),
  B('me-mild', 'Mild Mystery', ['M. Mild'], ISBN_M, 'read'),
];
const myBook = (id) => MY_LIBRARY.find(b => b.id === id);

/* The no-pace / no-count gate every rendered surface must pass:
 * presence markup may carry names and avatars only — never a
 * percentage, a page word, a date, or a numeral tally of people. */
const NO_PACE = (html) =>
  !/%/.test(html) && !/\bpages?\b/i.test(html) &&
  !/\d{4}-\d{2}-\d{2}/.test(html) && !/\b\d+\s*(friends|people|readers|others)\b/i.test(html);

(async () => {
  require('./harness').loadApp(window);
  await tick(3);
  window.__sbStub = stub;

  /* ---------- fixtures ---------- */
  const prof = (user_id, first_name, extra) => Object.assign({
    user_id, first_name, last_name: '', avatar_id: '', avatar_path: '',
    share_library: true, hidden_shelves: [], share_bio: true, share_activity: false, bio: '', fav_genres: [],
  }, extra || {});
  const db = stub.db;
  db.profiles[ME] = prof(ME, 'Me', { share_activity: true });
  db.profiles[ALY] = prof(ALY, 'Alyssa', { share_activity: false }); // activity OFF — must still appear
  db.profiles[BEN] = prof(BEN, 'Ben', { share_activity: true });
  db.profiles[HAN] = prof(HAN, 'Hana', { share_activity: true, hidden_shelves: ['reading'] }); // reading shelf hidden
  db.profiles[NOR] = prof(NOR, 'Noor', { share_activity: true, share_library: false });        // library not shared
  db.profiles[BLR] = prof(BLR, 'Blair', { share_activity: true });                              // blocked pair
  db.profiles[FAY] = prof(FAY, 'Fay', { share_activity: true });
  [ALY, BEN, HAN, NOR, FAY].forEach(id =>
    db.circle_links.push({ requester_id: ME, addressee_id: id, status: 'accepted', created_at: '2026-01-01' }));
  db.circle_links.push({ requester_id: ME, addressee_id: BLR, status: 'pending', created_at: '2026-01-01' });
  db.blocks.push({ blocker_id: ME, blocked_id: BLR });

  db.books.push(bookRow(ALY, 'aly-quest', B('aly-quest', 'Shared Quest', ['Q. Author'], ISBN_A, 'reading')));
  db.books.push(bookRow(ALY, 'aly-quiet', B('aly-quiet', 'Quiet Pages', ['Q. Author'], ISBN_Q, 'reading')));
  db.books.push(bookRow(BEN, 'ben-quest', B('ben-quest', 'Shared Quest', ['Q. Author'], ISBN_A, 'reading')));
  db.books.push(bookRow(HAN, 'han-quest', B('han-quest', 'Shared Quest', ['Q. Author'], ISBN_A, 'reading')));
  db.books.push(bookRow(NOR, 'nor-quest', B('nor-quest', 'Shared Quest', ['Q. Author'], ISBN_A, 'reading')));
  db.books.push(bookRow(BLR, 'blr-quest', B('blr-quest', 'Shared Quest', ['Q. Author'], ISBN_A, 'reading')));
  db.books.push(bookRow(FAY, 'fay-spicy', B('fay-spicy', 'Spicy Tale', ['H. Heat'], ISBN_P, 'reading', { ratings: { spice: 5 } })));
  db.books.push(bookRow(FAY, 'fay-mild', B('fay-mild', 'Mild Mystery', ['M. Mild'], ISBN_M, 'reading')));

  useAs(ME);
  runInWindow('library = ' + JSON.stringify(MY_LIBRARY) + ';');

  const freshSlot = () => {
    runInWindow('document.getElementById("modal-root").innerHTML = "<div id=\\"m-rittoo\\"></div>"; ritShelvesCache = null;');
    return window.document.getElementById('m-rittoo');
  };
  const fill = async (book) => {
    freshSlot();
    runInWindow('window.__ritBook = ' + JSON.stringify(book) + ';');
    await probe('fillReadingItToo(window.__ritBook)');
    await tick(2);
    return window.document.getElementById('m-rittoo');
  };

  /* ================= modal surface ================= */
  {
    const slot = await fill(myBook('me-quiet'));
    ok('modal: one visible reading friend renders the presence row',
      slot.innerHTML.indexOf('rit-row') !== -1 && slot.innerHTML.indexOf('Alyssa is reading this too') !== -1);
    ok('modal: share_activity OFF does NOT gate (the v528/v532 ruling)',
      slot.innerHTML.indexOf('Alyssa') !== -1 && db.profiles[ALY].share_activity === false);
    ok('modal: the row carries the friend\u2019s avatar', slot.innerHTML.indexOf('data-cav="' + ALY + '"') !== -1);
    ok('modal: viewer\u2019s own copy need not be reading (mine is TBR)', myBook('me-quiet').status === 'tbr');
    ok('modal: presence markup has no pace data and no counts', NO_PACE(slot.innerHTML));
  }
  {
    const slot = await fill(myBook('me-quest'));
    ok('modal: two friends listed by name', slot.innerHTML.indexOf('Alyssa and Ben are reading this too') !== -1);
    ok('modal: hidden reading shelf contributes nobody', slot.innerHTML.indexOf('Hana') === -1);
    ok('modal: share_library OFF contributes nobody', slot.innerHTML.indexOf('Noor') === -1);
    ok('modal: blocked pair contributes nobody', slot.innerHTML.indexOf('Blair') === -1);
    ok('modal: multi-friend markup has no pace data and no counts', NO_PACE(slot.innerHTML));
  }
  {
    const slot = await fill(myBook('me-solo'));
    ok('modal: nobody reading it -> slot stays empty (no placeholder)', slot.innerHTML === '');
  }

  /* ---- shield: known-high suppresses whole, unknown never does ---- */
  runInWindow('localStorage.setItem("cozylibram.privacy.v1", JSON.stringify({ shield: true, band: "teen" }));');
  ok('shield fixture: shield is on', probe('shieldOn()') === true);
  {
    const slot = await fill(myBook('me-spicy'));
    ok('shield: known-high-spice (5) presence is suppressed ENTIRELY', slot.innerHTML === '');
  }
  {
    const slot = await fill(myBook('me-mild'));
    ok('shield: unknown spice is NOT high — row still renders',
      slot.innerHTML.indexOf('Fay is reading this too') !== -1);
  }
  runInWindow('localStorage.setItem("cozylibram.privacy.v1", JSON.stringify({ shield: false, band: "adult" }));');
  {
    const slot = await fill(myBook('me-spicy'));
    ok('shield off: the same high-spice presence renders', slot.innerHTML.indexOf('Fay is reading this too') !== -1);
  }

  /* ================= pure matcher ================= */
  {
    const shelves = [
      { friend: { id: 'f1', name: 'One', profile: null }, books: [B('x1', 'Keyless Tale', ['A. Writer'], '', 'reading')] },
      { friend: { id: 'f2', name: 'Two', profile: null }, books: [B('x2', 'Keyless Tale', ['A. Writer'], '', 'read')] },
      { friend: { id: 'f3', name: 'Three', profile: null }, books: [B('x3', 'keyless tale', ['a. writer'], '', 'reading'), B('x4', 'Keyless Tale', ['A. Writer'], '', 'reading')] },
    ];
    runInWindow('window.__ritShelves = ' + JSON.stringify(shelves) + ';');
    const m = probe('ritMatchesForKey("ta:keyless tale|a. writer", window.__ritShelves)');
    ok('matcher: title+author key matches across different app ids (no ISBN)',
      Array.isArray(m) && m.length === 2 && m[0].friendId === 'f1' && m[1].friendId === 'f3');
    ok('matcher: a finished copy does not count, duplicate copies count once',
      Array.isArray(m) && !m.some(x => x.friendId === 'f2') && m.filter(x => x.friendId === 'f3').length === 1);
  }
  {
    const mine = [B('m1', 'Shared Quest', ['Q. Author'], ISBN_A, 'reading'),
                  B('m2', 'Quiet Pages', ['Q. Author'], ISBN_Q, 'tbr')];
    const others = [
      { person: { id: 'p1', name: 'Pia' }, reading: [B('p1q', 'Shared Quest', ['Q. Author'], ISBN_A, 'reading')] },
      { person: { id: 'p2', name: 'Pam' }, reading: [B('p2q', 'Quiet Pages', ['Q. Author'], ISBN_Q, 'reading')] },
    ];
    runInWindow('window.__ritMine = ' + JSON.stringify(mine) + '; window.__ritOthers = ' + JSON.stringify(others) + ';');
    const ov = probe('ritOverlaps(window.__ritMine, window.__ritOthers)');
    ok('overlaps: only MY reading books anchor a shared read (my TBR book does not)',
      Array.isArray(ov) && ov.length === 1 && ov[0].book.id === 'm1' && ov[0].friends.length === 1 && ov[0].friends[0].person.id === 'p1');
    ok('overlaps: empty in -> empty out, and empty renders as no section',
      probe('ritOverlaps([], window.__ritOthers).length') === 0 && probe('ritHearthCardHTML([])') === '');
  }

  /* ================= Hearth surface ================= */
  {
    const d = await probe('loadCovenStats()');
    ok('hearth: exactly one shared read among my current reads',
      Array.isArray(d.readingToo) && d.readingToo.length === 1 && d.readingToo[0].book.title === 'Shared Quest');
    const ids = (d.readingToo[0].friends || []).map(f => f.person.id).sort();
    ok('hearth: friends come from the SHELF view — activity-off Alyssa included, hidden/unshared/blocked excluded',
      JSON.stringify(ids) === JSON.stringify([ALY, BEN].sort()));
    // render via a fresh stats call so the object stays in-window
    const htmlStr = await probe('loadCovenStats().then(d2 => covenStatsHTML(d2))');
    ok('hearth: section renders with cover, title, avatars + names',
      htmlStr.indexOf('Reading it too') !== -1 && htmlStr.indexOf('Shared Quest') !== -1 &&
      htmlStr.indexOf('Alyssa and Ben are reading this too') !== -1 &&
      htmlStr.indexOf('data-cav="' + ALY + '"') !== -1);
    const cardOnly = await probe('loadCovenStats().then(d2 => ritHearthCardHTML(d2.readingToo))');
    ok('hearth: card markup has no pace data and no counts', NO_PACE(cardOnly));
  }
  {
    runInWindow('library = ' + JSON.stringify([MY_LIBRARY[1]]) + ';'); // Solo Read only
    const d = await probe('loadCovenStats()');
    ok('hearth: no overlaps -> readingToo is empty', Array.isArray(d.readingToo) && d.readingToo.length === 0);
    const htmlStr = await probe('loadCovenStats().then(d2 => covenStatsHTML(d2))');
    ok('hearth: no overlaps -> the section is absent entirely', htmlStr.indexOf('Reading it too') === -1);
    runInWindow('library = ' + JSON.stringify(MY_LIBRARY) + ';');
  }

  /* ================= registration + hygiene ================= */
  const src235 = fs.readFileSync(path.join(APP_DIR, 'js/235-reading-it-too.js'), 'utf8');
  const src150 = fs.readFileSync(path.join(APP_DIR, 'js/150-modal-discovery.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  const swText = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  ok('registration: index.html loads js/235', indexHtml.indexOf('js/235-reading-it-too.js') !== -1);
  ok('registration: sw.js precaches js/235', swText.indexOf('235-reading-it-too.js') !== -1);
  ok('modal wiring: js/150 carries the slot and the fill call',
    src150.indexOf('id="m-rittoo"') !== -1 && src150.indexOf('fillReadingItToo(b)') !== -1);
  ok('hygiene: js/235 never touches pace fields (dates, logs, page counts)',
    !/dateFinished|dateStarted|currentPage|\.log\b/.test(src235));
  ok('hygiene: js/235 performs no writes (no rpc, no upsert/insert/update/delete)',
    !/\.rpc\(|\.upsert\(|\.insert\(|\.update\(|\.delete\(/.test(src235));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
