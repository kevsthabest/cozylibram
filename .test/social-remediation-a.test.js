// Remediation Batch A (v532): Hearth/social fixes.
//
// Pins, per item:
//  1. Buddy reachability — matches compute from SHELF-visible books
//     for every friend (RC1: an activity-OFF but library-shared
//     friend sharing a TBR key matches; library unshared or the
//     TBR shelf hidden → no match; a shielded viewer's matches
//     compute over shield-filtered books), while the ACTIVITY
//     surfaces (stats/moments/digest) keep excluding activity-off
//     friends exactly as before. Empty states render (RC2), the
//     support probe logs non-missing errors (RC3), and the offer
//     gate accepts Wishlist copies alongside TBR.
//  2. Sender outbox — the v532 RPC shapes (caller-scoped, NO
//     recipient-state fields; the buddy RPC doesn't return the
//     row's status at all), the rendered "Things you've sent"
//     section (newest first, no status words), Unsend wired to
//     recall_thought_of_you, and quiet pre-migration hiding.
//  3. ToY × "You'd love this" suppression — a work sitting in the
//     viewer's inbox is excluded from loadRecos while the card
//     lives, and returns when it goes.
//  4. The reactions read posture lives in social-reactions.test.js
//     (its stub emulation mirrors moment_owner_sharing).
//  5. Copy/names — the moment row names the finisher in the
//     sentence; the invite dialog names a fresh inviter via
//     invite_inviter_name (and stays generic for a blocked pair);
//     the blocked-accept copy no longer advises asking for a fresh
//     link; the Hearth header reads "Around The Hearth".
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in remediation-a tests'); };
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

const ME = 'u-me', FAY = 'u-fay', PAM = 'u-pam', HID = 'u-hid', SHY = 'u-shy', RIN = 'u-rin';
const ISBN_A = '9780000000001'; // Shared Quest
const ISBN_B = '9780000000002'; // Spicy Shared
const ISBN_C = '9780000000003'; // Wish Match
const ISBN_D = '9780000000004'; // Wish Two
const ISBN_F = '9780000000005'; // Fay Favorite

const mkStub = () => {
  const db = {
    circle_links: [], circle_invites: [], profiles: {}, books: [],
    thought_of_you: [], buddy_reads: [], blocks: [],
    rpcCalls: [], noOutbox: false, probeError: false,
  };
  const caller = () => window.__uid;
  const linked = (a, b, statuses) => db.circle_links.some(l =>
    (!statuses || statuses.indexOf(l.status) !== -1) &&
    ((l.requester_id === a && l.addressee_id === b) || (l.requester_id === b && l.addressee_id === a)));
  const blocked = (a, b) => db.blocks.some(x =>
    (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a));
  const fullName = (p) => p ? (((p.first_name || '') + ' ' + (p.last_name || '')).trim() || null) : null;
  // The v522 view, mirrored: self + linked (accepted/pending) users
  // only — a fresh inviter is NOT in it (that's item 5's whole bug).
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
  // The books SELECT policy (v522 circle_book_visible), emulated:
  // your own rows always; a friend's rows only behind an accepted
  // link, an unblocked pair, share_library on, and the row's shelf
  // not hidden.
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
    select(cols) {
      const q = { _conds: [], _in: null, _limit: null,
        eq(c, v) { q._conds.push([c, v]); return q; },
        ne() { return q; }, order() { return q; }, range() { return q; },
        limit(n) { q._limit = n; return q; },
        in(c, vs) { q._in = [c, vs]; return q; },
        maybeSingle() { const rs = q._run(); return Promise.resolve({ data: rs[0] || null, error: null }); },
        _run() {
          if (name === 'buddy_reads' && db.probeError) throw new Error('connection reset by peer');
          let rs = rowsOf(name);
          if (name === 'books') rs = rs.filter(bookVisible);
          if (name === 'thought_of_you') rs = rs.filter(r => r.recipient_id === caller());
          if (name === 'buddy_reads') rs = rs.filter(r => r.inviter_id === caller() || r.invitee_id === caller());
          rs = applyConds(rs, q._conds);
          if (q._in) rs = rs.filter(r => q._in[1].indexOf(r[q._in[0]]) !== -1);
          if (q._limit) rs = rs.slice(0, q._limit);
          return rs;
        },
        then(res, rej) { try { res({ data: q._run(), error: null }); } catch (e) { rej(e); } },
      };
      return q;
    },
    upsert(row) {
      if (name === 'profiles') db.profiles[row.user_id] = Object.assign({}, db.profiles[row.user_id], row);
      return Promise.resolve({ error: null });
    },
    delete() {
      const dq = { _conds: [],
        eq(c, v) { dq._conds.push([c, v]); return dq; },
        then(res) {
          db[name] = (db[name] || []).filter(r => !dq._conds.every(([c, v]) => r[c] === v));
          res({ data: [], error: null });
        },
      };
      return dq;
    },
  });
  const stub = { db, from: (t) => table(t),
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'not found' } }) }) },
    rpc(name, args) {
      db.rpcCalls.push({ name, args: args || {} });
      const missing = (fn) => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + fn + ' in the schema cache' } });
      if (name === 'my_sent_thoughts') {
        if (db.noOutbox) return missing('my_sent_thoughts');
        const data = db.thought_of_you.filter(r => r.sender_id === caller())
          .map(r => ({ id: r.id, recipient_id: r.recipient_id, recipient_name: fullName(db.profiles[r.recipient_id]),
            sender_book_id: r.sender_book_id, book: r.book, note: r.note, created_at: r.created_at }));
        return Promise.resolve({ data, error: null });
      }
      if (name === 'my_sent_buddy_invites') {
        if (db.noOutbox) return missing('my_sent_buddy_invites');
        // The RPC's column set — deliberately NO status key.
        const data = db.buddy_reads.filter(r => r.inviter_id === caller())
          .map(r => ({ id: r.id, invitee_id: r.invitee_id, invitee_name: fullName(db.profiles[r.invitee_id]),
            book_key: r.book_key, created_at: r.created_at }));
        return Promise.resolve({ data, error: null });
      }
      if (name === 'recall_thought_of_you') {
        db.thought_of_you = db.thought_of_you.filter(r =>
          !(r.sender_id === caller() && r.recipient_id === args.p_recipient && r.sender_book_id === args.p_book_id));
        return Promise.resolve({ data: 'ok', error: null });
      }
      if (name === 'invite_inviter_name') {
        // Faithful emulation of the v532 function.
        const inv = db.circle_invites.find(i => i.code === args.p_token);
        if (!inv || inv.user_id === caller() || blocked(caller(), inv.user_id)) return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: fullName(db.profiles[inv.user_id]), error: null });
      }
      if (name === 'buddy_states') return Promise.resolve({ data: { mine: 'not_started', theirs: 'not_started' }, error: null });
      return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'function ' + name + ' not stubbed' } });
    },
  };
  return stub;
};

const stub = mkStub();
const useAs = (uid) => { window.__uid = uid; runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "x@y.z" }' : 'null') + ';'); };
const bookRow = (uid, id, data) => ({ user_id: uid, book_id: id, isbn: data.isbn || null, data });
const dayAgoISO = (n) => new Date(Date.now() - n * 864e5).toISOString();

const MY_LIBRARY = [
  { id: 'me-quest', title: 'Shared Quest', authors: ['Q. Author'], isbn: ISBN_A, status: 'tbr', cover: '', coverColor: '', ratings: {} },
  { id: 'me-spicy', title: 'Spicy Shared', authors: ['H. Heat'], isbn: ISBN_B, status: 'tbr', cover: '', coverColor: '', ratings: { spice: 5 } },
  { id: 'me-wish', title: 'Wish Match', authors: ['W. One'], isbn: ISBN_C, status: 'tbr', owned: 'tobuy', cover: '', coverColor: '', ratings: {} },
  { id: 'me-wish2', title: 'Wish Two', authors: ['W. Two'], isbn: ISBN_D, status: 'tbr', cover: '', coverColor: '', ratings: {} },
];

(async () => {
  require('./harness').loadApp(window);
  await tick(3);
  window.__sbStub = stub;

  /* ---------- fixtures ---------- */
  const prof = (user_id, first_name, extra) => Object.assign({
    user_id, first_name, last_name: '', avatar_id: '', avatar_path: '',
    share_library: true, hidden_shelves: [], share_bio: true, share_activity: false, bio: '', fav_genres: [],
  }, extra || {});
  stub.db.profiles[ME] = prof(ME, 'Me', { share_activity: true });
  stub.db.profiles[FAY] = prof(FAY, 'Fay', { last_name: 'Fable', share_activity: true });
  stub.db.profiles[PAM] = prof(PAM, 'Pam', { last_name: 'Private' }); // activity OFF (default), library shared
  stub.db.profiles[HID] = prof(HID, 'Hid', { share_activity: true, hidden_shelves: ['tbr'] });
  stub.db.profiles[SHY] = prof(SHY, 'Shy', { share_activity: true, share_library: false });
  stub.db.profiles[RIN] = prof(RIN, 'Rin', { last_name: 'Sable', share_activity: true });
  [FAY, PAM, HID, SHY].forEach(f => stub.db.circle_links.push(
    { requester_id: ME, addressee_id: f, status: 'accepted', created_at: dayAgoISO(30) }));
  stub.db.circle_invites.push({ code: 'code-rin-0001', user_id: RIN });

  const brow = (uid, id, title, author, isbn, status, extra) => bookRow(uid, id,
    Object.assign({ id, title, authors: [author], isbn, status, cover: '', coverColor: '', ratings: {} }, extra || {}));
  stub.db.books.push(
    brow(FAY, 'fay-quest', 'Shared Quest', 'Q. Author', ISBN_A, 'tbr'),
    brow(FAY, 'fay-dune', 'Dune', 'Frank Herbert', '9780000000090', 'read', { dateFinished: dayAgoISO(2), myRating: 5 }),
    brow(FAY, 'fay-fav', 'Fay Favorite', 'An Author', ISBN_F, 'read', { dateFinished: dayAgoISO(9), myRating: 5 }),
    brow(PAM, 'pam-quest', 'Shared Quest', 'Q. Author', ISBN_A, 'tbr'),
    brow(PAM, 'pam-spicy', 'Spicy Shared', 'H. Heat', ISBN_B, 'tbr', { ratings: { spice: 5 } }),
    brow(PAM, 'pam-wish', 'Wish Match', 'W. One', ISBN_C, 'tbr'),
    brow(PAM, 'pam-wish2', 'Wish Two', 'W. Two', ISBN_D, 'wishlist'),
    brow(PAM, 'pam-secret', 'Pam Secret', 'P. Author', '9780000000091', 'read', { dateFinished: dayAgoISO(0), myRating: 5 }),
    brow(HID, 'hid-quest', 'Shared Quest', 'Q. Author', ISBN_A, 'tbr'),
    brow(SHY, 'shy-quest', 'Shared Quest', 'Q. Author', ISBN_A, 'tbr'),
  );
  runInWindow('library = ' + JSON.stringify(MY_LIBRARY) + ';');
  useAs(ME);

  /* ================= item 1: buddy reachability ================= */
  const stats = await probe('loadCovenStats()'); await tick();
  const byId = (id) => (stats.people || []).find(p => p.id === id);
  const buddyOf = (id) => (stats.buddies || []).find(b => b.p.id === id);
  const buddyTitles = (id) => { const b = buddyOf(id); return b ? b.books.map(x => x.title) : []; };

  ok('RC1: activity-OFF + library-shared friend sharing a TBR key MATCHES',
    buddyTitles(PAM).indexOf('Shared Quest') !== -1);
  ok('RC1: the activity-ON friend still matches (no regression)',
    buddyTitles(FAY).indexOf('Shared Quest') !== -1);
  ok('RC1: no match when the friend hides the TBR shelf (RLS returns nothing for it)',
    !buddyOf(HID));
  ok('RC1: no match when the friend does not share their library',
    !buddyOf(SHY));
  ok('RC1: the activity view stays empty for the activity-off friend (stats gate unmoved)',
    byId(PAM) && byId(PAM).stats.finished === 0 && byId(PAM).stats.books.length === 0);
  ok('RC1: the shelf view carries the shared books the activity view withholds',
    byId(PAM) && byId(PAM).shelfStats && byId(PAM).shelfStats.books.some(b => b.title === 'Shared Quest'));
  ok('RC1: moments exclude the activity-off friend\u2019s finish',
    !(stats.moments || []).some(m => m.title === 'Pam Secret'));
  ok('RC1: moments still carry the activity-on friend\u2019s finish',
    (stats.moments || []).some(m => m.title === 'Dune'));

  // Shield: a shielded viewer's matches compute over filtered books.
  await probe('setShield(true)'); await tick();
  const shielded = await probe('loadCovenStats()'); await tick();
  const shieldBuddyTitles = (id) => { const b = (shielded.buddies || []).find(x => x.p.id === id); return b ? b.books.map(x => x.title) : []; };
  ok('RC1: shield filtering applies to matches (the spice-5 shared book drops out)',
    shieldBuddyTitles(PAM).indexOf('Spicy Shared') === -1);
  ok('RC1: the shield leaves unshielded matches alone',
    shieldBuddyTitles(PAM).indexOf('Shared Quest') !== -1);
  await probe('setShield(false)'); await tick();
  ok('RC1: unshielded, the spicy match returns',
    buddyTitles(PAM).indexOf('Spicy Shared') !== -1 ||
    (await probe('loadCovenStats()')).buddies.some(b => b.p.id === PAM && b.books.some(x => x.title === 'Spicy Shared')));

  /* ---------- RC2: empty states ---------- */
  const emptyStats = { people: stats.people.slice(0, 2), digest: { lines: [], busiest: null },
    soulmates: [], awards: [], buddies: [], moments: [], nowReading: [], trending: [], myTbrKeys: [] };
  const emptyHTML = probe('covenStatsHTML(' + JSON.stringify(emptyStats) + ')');
  ok('RC2: an all-quiet circle renders the Buddy empty-state guidance',
    emptyHTML.indexOf('id="buddy-empty-note"') !== -1 && emptyHTML.indexOf('will show up here') !== -1);
  ok('RC2: an all-quiet circle renders the Discover empty-state line',
    emptyHTML.indexOf('id="discover-empty-note"') !== -1 && emptyHTML.indexOf('Nothing here yet') !== -1);
  ok('RC2: the stats-load failure copy replaced the silent erase',
    fs.readFileSync(path.join(APP_DIR, 'js/197-social-stats.js'), 'utf8')
      .indexOf('load your circle stats just now') !== -1);

  /* ---------- RC3: the probe logs non-missing errors ---------- */
  const src233 = fs.readFileSync(path.join(APP_DIR, 'js/233-buddy-reads.js'), 'utf8');
  ok('RC3: non-missing probe errors are logged via buddyLog',
    src233.indexOf("buddyLog('support probe failed:'") !== -1 &&
    src233.indexOf("buddyLog('support probe threw'") !== -1);
  stub.db.probeError = true;
  runInWindow('buddySupportKnown = null;'); // the probe memoizes — force a fresh one
  ok('RC3: a throwing probe still fails quiet (no crash, no false support)',
    await probe('buddySupported()') === false);
  stub.db.probeError = false;
  runInWindow('buddySupportKnown = null;');

  /* ---------- Wishlist offers ---------- */
  // v559: a wishlist book IS a tbr book (tbr + tobuy), so the
  // pre-reading rule is the tbr term alone — the probes below use the
  // post-migration shapes a wishlist copy actually carries now.
  ok('wishlist: buddyPreReading accepts tbr (wishlist books included), refuses the rest',
    probe('buddyPreReading("tbr")') === true &&
    probe('buddyPreReading("read")') === false && probe('buddyPreReading("reading")') === false);
  ok('wishlist: their Wishlist copy (tbr + tobuy) is offerable when my copy is on TBR',
    probe('buddyOfferBookId("' + PAM + '", { status: "tbr", owned: "tobuy", title: "Wish Two", authors: ["W. Two"], isbn: "' + ISBN_D + '" })') === 'me-wish2');
  ok('wishlist: their TBR copy is offerable when MY copy sits on the Wishlist',
    probe('buddyOfferBookId("' + PAM + '", { status: "tbr", title: "Wish Match", authors: ["W. One"], isbn: "' + ISBN_C + '" })') === 'me-wish');
  ok('wishlist: a read copy is still not offerable',
    probe('buddyOfferBookId("' + PAM + '", { status: "read", title: "Shared Quest", authors: ["Q. Author"], isbn: "' + ISBN_A + '" })') === '');

  /* ================= item 2: the sender outbox ================= */
  stub.db.thought_of_you.push({
    id: 'toy-sent-1', sender_id: ME, recipient_id: FAY, sender_book_id: 'me-send-book',
    book: { title: 'The Sent Book', authors: ['S. Sender'], isbn: '9780000000099', cover: '', coverColor: '#123456' },
    note: 'You will cry (nicely)', created_at: dayAgoISO(1),
  });
  stub.db.buddy_reads.push({
    id: 'br-sent-1', inviter_id: ME, invitee_id: PAM, book_key: 'isbn:' + ISBN_A,
    status: 'pending', created_at: dayAgoISO(3),
  });
  runInWindow('document.body.insertAdjacentHTML("beforeend", \'<div id="sent-slot"></div>\')');
  await probe('refreshSentOutbox()'); await tick(2);
  const sentSlot = window.document.getElementById('sent-slot');
  const sentHTML = sentSlot.innerHTML;
  ok('outbox: the section renders with its title', sentHTML.indexOf('Things you\u2019ve sent') !== -1);
  ok('outbox: a sent Thought-of-you renders book, recipient, and the note I wrote',
    sentHTML.indexOf('The Sent Book') !== -1 && sentHTML.indexOf('Fay Fable') !== -1 &&
    sentHTML.indexOf('You will cry (nicely)') !== -1);
  ok('outbox: a sent buddy invite renders the book and the invitee',
    sentHTML.indexOf('Shared Quest') !== -1 && sentHTML.indexOf('Buddy read invitation') !== -1 &&
    sentHTML.indexOf('Pam') !== -1);
  ok('outbox: newest first (the 1-day-old thought ahead of the 3-day-old invite)',
    sentHTML.indexOf('The Sent Book') < sentHTML.indexOf('Buddy read invitation'));
  ok('outbox: NO recipient-side state leaks (no status words anywhere)',
    !/pending|accepted|declined|dismissed/i.test(sentHTML));
  ok('outbox: the anti-receipt line is on the section',
    sentHTML.indexOf('record of sending') !== -1);

  // The RPC column sets ride in the stub's mapping; assert the real
  // SQL carries exactly those columns and nothing recipient-side.
  const outboxSQL = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v532_sent_outbox.sql'), 'utf8');
  const thoughtsCols = (outboxSQL.split('my_sent_thoughts()')[1].split(')')[0] || '');
  ok('outbox SQL: my_sent_thoughts returns exactly the sender-known columns',
    ['id uuid', 'recipient_id uuid', 'recipient_name text', 'sender_book_id text', 'book jsonb', 'note text', 'created_at timestamptz']
      .every(c => thoughtsCols.indexOf(c) !== -1));
  const invitesFn = (outboxSQL.split('function public.my_sent_buddy_invites')[1] || '').split('$$;')[0];
  ok('outbox SQL: my_sent_buddy_invites returns NO status column (the anti-receipt pin)',
    invitesFn.indexOf('status') === -1 &&
    ['invitee_id uuid', 'invitee_name text', 'book_key text'].every(c => invitesFn.indexOf(c) !== -1));
  ok('outbox SQL: both RPCs are caller-scoped definers, granted to authenticated only',
    /my_sent_thoughts[\s\S]*security definer/.test(outboxSQL) &&
    /my_sent_buddy_invites[\s\S]*security definer/.test(outboxSQL) &&
    outboxSQL.indexOf('t.sender_id = auth.uid()') !== -1 &&
    outboxSQL.indexOf('r.inviter_id = auth.uid()') !== -1 &&
    (outboxSQL.match(/grant execute on function public\.my_sent_(thoughts|buddy_invites)\(\) to authenticated/g) || []).length === 2);
  ok('outbox SQL: no new table policies (the RPCs are the only door)',
    !/create policy/.test(outboxSQL));

  // Unsend: the button calls recall_thought_of_you with MY book id.
  stub.db.rpcCalls.length = 0;
  sentSlot.querySelector('[data-sent-unsend]').click(); await tick(3);
  const recall = stub.db.rpcCalls.find(c => c.name === 'recall_thought_of_you');
  ok('outbox: Unsend calls recall_thought_of_you(recipient, my book id)',
    !!recall && recall.args.p_recipient === FAY && recall.args.p_book_id === 'me-send-book');
  ok('outbox: the recalled send leaves the list on refresh',
    window.document.getElementById('sent-slot').innerHTML.indexOf('The Sent Book') === -1 &&
    stub.db.thought_of_you.filter(r => r.id === 'toy-sent-1').length === 0);

  // Pre-migration: the RPCs 404 → the section hides quietly.
  stub.db.noOutbox = true;
  runInWindow('sentUnsupported = false;');
  await probe('refreshSentOutbox()'); await tick(2);
  ok('outbox: pre-migration the section hides quietly and latches unsupported',
    window.document.getElementById('sent-slot').innerHTML === '' && probe('sentUnsupported') === true);
  stub.db.noOutbox = false;

  /* ================= item 3: ToY × You'd-love-this suppression ================= */
  stub.db.thought_of_you.push({
    id: 'toy-in-1', sender_id: FAY, recipient_id: ME, sender_book_id: 'fay-fav',
    book: { title: 'Fay Favorite', authors: ['An Author'], isbn: ISBN_F, cover: '', coverColor: '#234567' },
    note: '', created_at: dayAgoISO(0),
  });
  ok('suppression: the inbox keys carry the sent work',
    (await probe('(async () => Array.from(await toyInboxKeys()))()')).indexOf('isbn:' + ISBN_F) !== -1);
  const recosIn = await probe('loadRecos()'); await tick();
  ok('suppression: while the card lives, the work is out of You\u2019d love this',
    !recosIn.some(r => r.book.title === 'Fay Favorite'));
  stub.db.thought_of_you = stub.db.thought_of_you.filter(r => r.id !== 'toy-in-1');
  const recosOut = await probe('loadRecos()'); await tick();
  ok('suppression: once the card goes, the work recommends again',
    recosOut.some(r => r.book.title === 'Fay Favorite'));

  /* ================= item 5: copy / names ================= */
  const src231 = fs.readFileSync(path.join(APP_DIR, 'js/231-reactions.js'), 'utf8');
  ok('copy: the moment row puts the finisher in the sentence (source)',
    src231.indexOf('finished <i>') !== -1 && src231.indexOf('who') !== -1);
  const mHTML = probe('momentRowHTML({ key: "k1", ownerId: "' + FAY + '", title: "Dune", day: "2026-10-11", person: { name: "Fay Fable", profile: null } })');
  ok('copy: a friend\u2019s moment row reads "Fay finished Dune"',
    mHTML.indexOf('Fay finished <i>Dune</i>') !== -1);
  const myHTML = probe('momentRowHTML({ key: "k2", ownerId: "' + ME + '", title: "Dune", day: "2026-10-11", person: { name: "Me", profile: null } })');
  ok('copy: my own moment row reads "You finished Dune"',
    myHTML.indexOf('You finished <i>Dune</i>') !== -1);

  const invite = await probe('resolveInviteToken("code-rin-0001")'); await tick();
  ok('names: the invite dialog names a fresh (unlinked) inviter via the RPC',
    invite && invite.name === 'Rin Sable');
  stub.db.blocks.push({ blocker_id: ME, blocked_id: RIN });
  const inviteBlocked = await probe('resolveInviteToken("code-rin-0001")').catch(e => ({ name: 'THREW: ' + e.message }));
  ok('names: a blocked pair learns nothing — the name stays generic',
    inviteBlocked && inviteBlocked.name === 'A reader');
  stub.db.blocks = [];
  const invSQL = fs.readFileSync(path.join(APP_DIR, 'supabase/migrations/v532_invite_inviter.sql'), 'utf8');
  ok('names SQL: invite_inviter_name is a definer returning null for own/dead/blocked tokens',
    /function public\.invite_inviter_name\(p_token text\)/.test(invSQL) &&
    /security definer/.test(invSQL) &&
    invSQL.indexOf('blocker_id = auth.uid()') !== -1 && invSQL.indexOf('blocked_id = auth.uid()') !== -1 &&
    /grant execute on function public\.invite_inviter_name\(text\) to authenticated/.test(invSQL));

  const src195 = fs.readFileSync(path.join(APP_DIR, 'js/195-coven.js'), 'utf8');
  ok('copy: the accept failure is neutral and never advises a fresh link',
    src195.indexOf('Couldn\u2019t accept \u2014 this invite is no longer usable.') !== -1 &&
    src195.indexOf('this invite link is no longer valid. Ask for a fresh one.') === -1);

  const feedStats = Object.assign({}, emptyStats, { nowReading: [{ p: byId(FAY), book: { title: 'Dune' } }] });
  const feedHTML = probe('covenStatsHTML(' + JSON.stringify(feedStats) + ')');
  ok('copy: the Hearth feed header reads "Around The Hearth" (single article)',
    feedHTML.indexOf('Around The Hearth') !== -1 && feedHTML.indexOf('the the') === -1);

  /* ---------- registration ---------- */
  const schema = fs.readFileSync(path.join(APP_DIR, 'supabase/schema.sql'), 'utf8');
  ok('schema.sql mirrors all three v532 RPCs',
    schema.indexOf('my_sent_thoughts') !== -1 && schema.indexOf('my_sent_buddy_invites') !== -1 &&
    schema.indexOf('invite_inviter_name') !== -1);
  // R1 repoint (migration plan §9.3): js/234's tag is a module tag since
  // its ESM conversion, and js/233's since phase 2 batch 4; both
  // positions are taken from either tag form — the same assertion
  // (js/234 registers after js/233), coverage unchanged.
  ok('index.html registers js/234-outbox.js after js/233',
    Math.max(html.indexOf('<script src="js/234-outbox.js"></script>'),
      html.indexOf('<script type="module" src="js/234-outbox.js"></script>')) >
    Math.max(html.indexOf('<script src="js/233-buddy-reads.js"></script>'),
      html.indexOf('<script type="module" src="js/233-buddy-reads.js"></script>')));
  ok('sw.js precaches 234-outbox.js',
    fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8').indexOf("'234-outbox.js'") !== -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
