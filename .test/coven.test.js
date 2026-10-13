// Coven (v96): friend links via invite links, request inbox, privacy, and
// read-only shared shelves. v240 replaced the 6-char invite codes with
// 12-char URL-safe tokens (#/invite/<token>) and one-sided acceptance via
// the accept_circle_invite rpc. Supabase RLS itself is server-side (see
// supabase/schema.sql); these tests cover the app's queries and UI flows
// against a stub client.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in coven tests'); };
window.confirm = () => true;

require('./harness').loadApp(window);

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

// ---- stub supabase client ----
const mkStub = () => {
  const db = {
    circle_invites: [], // {user_id, code}
    circle_links: [],   // {requester_id, addressee_id, status, created_at}
    profiles: {},       // user_id -> row
    books: [],          // {user_id, book_id, isbn, data}
  };
  const files = {};
  // v522: emulate the circle_profiles view — identity + posture flags, and
  // bio/genres only when share_bio is on. gender / hidden_shelves /
  // updated_at are never projected (that's the privacy contract).
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
  const table = (name) => ({
    select(cols) {
      const qq = { _conds: [], _in: null,
        eq(c, v) { qq._conds.push([c, v]); return qq; },
        in(c, vs) { qq._in = [c, vs]; return qq; },
        maybeSingle() {
          let rs = applyConds(rowsOf(name), qq._conds);
          if (qq._in) rs = rs.filter(r => qq._in[1].indexOf(r[qq._in[0]]) !== -1);
          return Promise.resolve({ data: rs[0] || null, error: null });
        },
        then(res, rej) {
          try {
            let rs = applyConds(rowsOf(name), qq._conds);
            if (qq._in) rs = rs.filter(r => qq._in[1].indexOf(r[qq._in[0]]) !== -1);
            res({ data: rs, error: null });
          } catch (e) { rej(e); }
        },
      };
      return qq;
    },
    insert(row) {
      if (name === 'circle_links') {
        if (db.circle_links.some(r => r.requester_id === row.requester_id && r.addressee_id === row.addressee_id))
          return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } });
        db.circle_links.push(Object.assign({ created_at: new Date().toISOString() }, row));
      } else if (name === 'circle_invites') {
        if (db.circle_invites.some(r => r.code === row.code && r.user_id !== row.user_id))
          return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint "circle_invites_code_key"' } });
        db.circle_invites.push(Object.assign({}, row));
      }
      return Promise.resolve({ error: null });
    },
    upsert(row) {
      if (name === 'circle_invites') {
        if (db.circle_invites.some(r => r.code === row.code && r.user_id !== row.user_id))
          return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint "circle_invites_code_key"' } });
        const i = db.circle_invites.findIndex(r => r.user_id === row.user_id);
        if (i >= 0) db.circle_invites[i] = Object.assign({}, db.circle_invites[i], row);
        else db.circle_invites.push(Object.assign({}, row));
      } else if (name === 'profiles') {
        db.profiles[row.user_id] = Object.assign({}, db.profiles[row.user_id], row);
      }
      return Promise.resolve({ error: null });
    },
    update(patch) {
      const uq = { _conds: [],
        eq(c, v) { uq._conds.push([c, v]); return uq; },
        then(res, rej) {
          try {
            const rs = applyConds(rowsOf(name), uq._conds);
            rs.forEach(r => Object.assign(r, patch));
            res({ data: rs, error: null });
          } catch (e) { rej(e); }
        },
      };
      return uq;
    },
    delete() {
      const dq = { _conds: [],
        eq(c, v) { dq._conds.push([c, v]); return dq; },
        then(res, rej) {
          try {
            const keep = rowsOf(name).filter(r => !dq._conds.every(([c, v]) => r[c] === v));
            if (name === 'profiles') { db.profiles = {}; keep.forEach(r => { db.profiles[r.user_id] = r; }); }
            else db[name] = keep;
            res({ data: [], error: null });
          } catch (e) { rej(e); }
        },
      };
      return dq;
    },
  });
  return { db, files,
    from: (t) => table(t),
    storage: { from: (bucket) => ({
      download: async (path) => files[path]
        ? { data: files[path], error: null }
        : { data: null, error: { message: 'not found' } },
    }) },
  };
};

const A = 'user-aaa', B = 'user-bbb', C = 'user-ccc', D = 'user-ddd';
// Mirrors cloudUser.id for the accept_circle_invite rpc stub (Node side can't
// read the window's global lexical bindings directly).
let currentUid = null;
const useAs = (uid) => { currentUid = uid; runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "' + uid + '@x.y" }' : 'null') + ';'); };
const stub = mkStub();
// v240: server-side one-sided invite acceptance (mirrors the SQL function).
stub.rpc = (fn, args) => {
  if (fn !== 'accept_circle_invite') return Promise.resolve({ data: null, error: { message: 'unknown rpc ' + fn } });
  const me = currentUid;
  if (!me) return Promise.resolve({ data: null, error: { message: 'not signed in' } });
  const inv = stub.db.circle_invites.find(r => r.code === args.p_token);
  if (!inv) return Promise.resolve({ data: null, error: { message: 'invite not found' } });
  if (inv.user_id === me) return Promise.resolve({ data: null, error: { message: 'own invite' } });
  stub.db.circle_links = stub.db.circle_links.filter(r =>
    !((r.requester_id === me && r.addressee_id === inv.user_id) || (r.requester_id === inv.user_id && r.addressee_id === me)));
  stub.db.circle_links.push({ requester_id: me, addressee_id: inv.user_id, status: 'accepted', created_at: new Date().toISOString() });
  return Promise.resolve({ data: inv.user_id, error: null });
};

(async () => {
  await tick(3);
  window.__sbStub = stub;
  const codeOf = async (uid) => { useAs(uid); return probe('ensureInviteCode()'); };

  // ---- invite tokens (v240: 12-char URL-safe, doubles as the link slug) ----
  const codeA = await codeOf(A);
  ok('invite token is 12 URL-safe chars', /^[A-Za-z0-9\-_]{12}$/.test(codeA));
  const codeA2 = await codeOf(A);
  ok('invite token is stable per user', codeA2 === codeA);
  const codeB = await codeOf(B);
  ok('different users get different tokens', codeB !== codeA);

  // legacy 6-char rows rotate to tokens lazily on read
  stub.db.circle_invites.push({ user_id: 'user-legacy', code: 'ABCDEF' });
  useAs('user-legacy');
  const codeLegacy = await probe('ensureInviteCode()'); await tick();
  ok('legacy code is rotated to a token', /^[A-Za-z0-9\-_]{12}$/.test(codeLegacy) && codeLegacy !== 'ABCDEF');

  // ---- token parsing ----
  ok('bare token parses', probe('parseInviteToken(' + JSON.stringify(codeB) + ')') === codeB);
  ok('full link parses to its token',
    probe("parseInviteToken('https://cozylibram.pages.dev/#/invite/" + codeB + "')") === codeB);
  ok('garbage input is rejected', probe("parseInviteToken('hello world')") === '');
  ok('link builder uses the #/invite/ slug',
    probe('inviteLinkFor(' + JSON.stringify(codeB) + ')') === 'http://localhost:8000/#/invite/' + codeB);

  const resolve = (raw) => probe('resolveInviteToken(' + JSON.stringify(raw) + ')');
  const accept = (tok) => probe('acceptInviteToken(' + JSON.stringify(tok) + ')');

  // ---- resolve + one-sided accept ----
  useAs(A);
  const inv = await resolve(codeB); await tick();
  ok('resolve finds the inviter', inv.userId === B && inv.token === codeB);
  await accept(inv.token); await tick();
  ok('accept creates the friendship immediately (no pending round-trip)', stub.db.circle_links.some(
    r => r.requester_id === A && r.addressee_id === B && r.status === 'accepted'));

  // ---- invite validations ----
  let err = '';
  try { await resolve(codeA); } catch (e) { err = e.message; }
  ok('cannot invite yourself', /your own invite link/.test(err));
  err = '';
  try { await resolve('k7X2mQ9aZ4wB'); } catch (e) { err = e.message; }
  ok('unknown token is rejected', /no longer valid/.test(err));
  err = '';
  try { await resolve('not a link'); } catch (e) { err = e.message; }
  ok('garbage input is rejected before lookup', /doesn’t look like an invite link/.test(err));
  err = '';
  try { await resolve(codeB); } catch (e) { err = e.message; }
  ok('already-friends resolve is rejected', /already in each other/.test(err));

  // ---- rotation invalidates the old link ----
  useAs(B);
  const codeB2 = await probe('rotateInviteCode()'); await tick();
  ok('rotation issues a fresh token', codeB2 !== codeB && /^[A-Za-z0-9\-_]{12}$/.test(codeB2));
  useAs(A);
  err = '';
  try { await resolve(codeB); } catch (e) { err = e.message; }
  ok('rotated link is rejected', /no longer valid/.test(err));

  // ---- profiles for the friend list ----
  stub.db.profiles[A] = { user_id: A, first_name: 'Ann', last_name: 'Reader', avatar_id: 'raven', avatar_path: '' };
  stub.db.profiles[B] = { user_id: B, first_name: 'Ben', last_name: '', avatar_id: '', avatar_path: '' };

  // ---- reverse pending row is cleaned up on accept ----
  stub.db.circle_links.push({ requester_id: D, addressee_id: C, status: 'pending', created_at: new Date().toISOString() });
  stub.db.circle_links.push({ requester_id: C, addressee_id: D, status: 'pending', created_at: new Date().toISOString() });
  useAs(C);
  await probe('circleAnswer(' + JSON.stringify(D) + ', true)'); await tick();
  const cd = stub.db.circle_links.filter(
    r => (r.requester_id === C && r.addressee_id === D) || (r.requester_id === D && r.addressee_id === C));
  ok('mutual requests collapse to one accepted link', cd.length === 1 && cd[0].status === 'accepted');

  // ---- lists ----
  useAs(B);
  const lists = await probe('circleLists()'); await tick();
  ok('friends list shows the accepted friend', lists.friends.length === 1 && lists.friends[0].id === A);
  ok('friend name comes from their profile', lists.friends[0].name === 'Ann Reader');
  ok('no pending requests remain', lists.received.length === 0 && lists.sent.length === 0);

  // ---- decline + re-invite after decline ----
  const E = 'user-eee', F = 'user-fff';
  const codeF = await codeOf(F);
  stub.db.circle_links.push({ requester_id: E, addressee_id: F, status: 'pending', created_at: new Date().toISOString() });
  useAs(F);
  await probe('circleAnswer(' + JSON.stringify(E) + ', false)'); await tick();
  ok('decline marks the link declined', stub.db.circle_links.some(
    r => r.requester_id === E && r.addressee_id === F && r.status === 'declined'));
  useAs(E);
  await accept(codeF); await tick(); // E re-invites via F's link after the decline
  const ef = stub.db.circle_links.filter(
    r => (r.requester_id === E && r.addressee_id === F) || (r.requester_id === F && r.addressee_id === E));
  ok('re-invite after decline starts fresh', ef.length === 1 && ef[0].status === 'accepted' && ef[0].requester_id === E);

  // ---- accept is idempotent ----
  await accept(codeF); await tick();
  const ef2 = stub.db.circle_links.filter(
    r => (r.requester_id === E && r.addressee_id === F) || (r.requester_id === F && r.addressee_id === E));
  ok('double accept leaves exactly one link', ef2.length === 1 && ef2[0].status === 'accepted');

  // ---- cancel sent request ----
  const G = 'user-ggg', H = 'user-hhh';
  stub.db.circle_links.push({ requester_id: G, addressee_id: H, status: 'pending', created_at: new Date().toISOString() });
  useAs(G);
  await probe('circleCancel(' + JSON.stringify(H) + ')'); await tick();
  ok('cancel removes the sent request', !stub.db.circle_links.some(
    r => r.requester_id === G && r.addressee_id === H));

  // ---- remove friend ----
  useAs(A);
  await probe('circleRemove(' + JSON.stringify(B) + ')'); await tick();
  ok('remove deletes the friendship', !stub.db.circle_links.some(
    r => (r.requester_id === A && r.addressee_id === B) || (r.requester_id === B && r.addressee_id === A)));

  // ---- privacy ----
  useAs(A);
  const priv0 = await probe('circlePrivacy()'); await tick();
  ok('sharing defaults to on', priv0.share === true && Array.isArray(priv0.hidden) && priv0.hidden.length === 0);
  await probe('circleSavePrivacy(false, ["dnf", "tbr"])'); await tick();
  const prow = stub.db.profiles[A];
  ok('privacy persists to the profiles row', prow.share_library === false && prow.hidden_shelves.join(',') === 'dnf,tbr');
  const priv1 = await probe('circlePrivacy()'); await tick();
  ok('privacy reads back', priv1.share === false && priv1.hidden.join(',') === 'dnf,tbr');

  // ---- friend shelves ----
  stub.db.books.push({ user_id: B, book_id: 'bk1', isbn: null,
    data: { id: 'bk1', title: 'Shared Tome', authors: ['A. Writer'], status: 'read', myRating: 5 } });
  stub.db.books.push({ user_id: A, book_id: 'bk2', isbn: null,
    data: { id: 'bk2', title: 'Mine', authors: ['Me'], status: 'tbr' } });
  const fb = await probe('circleFriendBooks(' + JSON.stringify(B) + ')'); await tick();
  ok('friend shelf returns their books', fb.length === 1 && fb[0].title === 'Shared Tome');

  // ---- rendering: signed out ----
  useAs(null);
  await probe('renderCoven()'); await tick(5);
  ok('signed out shows the sign-in prompt', (q('#view') || {}).textContent.indexOf('lives in the cloud') !== -1);

  // ---- rendering: signed in ----
  useAs(A);
  await probe('renderCoven()'); await tick(5);
  const viewText = q('#view').textContent;
  ok('coven shows the friends strip', !!q('#friendStrip'));
  ok('coven shows the invite tile', !!q('#cc-invite-open'));
  ok('coven shows the privacy gear', !!q('#cc-privacy-gear'));
  // tabs render async via refreshCovenStats — covered in socialstats.test.js
  ok('nav has a coven tab', !!window.document.querySelector('.bottom-nav [data-nav="coven"]'));

  // ---- v240: deep-link token renders the accept card ----
  const I = 'user-iii', J = 'user-jjj';
  const codeI = await codeOf(I);
  stub.db.profiles[I] = { user_id: I, first_name: 'Ivy', last_name: 'Novel', avatar_id: '', avatar_path: '' };
  useAs(J);
  window.sessionStorage.setItem('cozylibram.invite', codeI);
  await probe('renderCoven()'); await tick(5);
  ok('invite accept card appears for a deep link (in sheet)',
    !!q('#cc-accept') && window.document.body.textContent.indexOf('Ivy Novel') !== -1);
  q('#cc-accept').click(); await tick(5);
  ok('accepting the deep-link invite befriends immediately', stub.db.circle_links.some(
    r => r.requester_id === J && r.addressee_id === I && r.status === 'accepted'));
  ok('token is consumed after accept', window.sessionStorage.getItem('cozylibram.invite') === null);

  // ---- friend shelf view ----
  stub.db.profiles[B] = { user_id: B, first_name: 'Ben', last_name: '', avatar_id: 'moon', avatar_path: '' };
  runInWindow('circFriend = { id: ' + JSON.stringify(B) + ', name: "Ben" };');
  await probe('renderCovenFriend()'); await tick(5);
  const fvText = q('#view').textContent;
  ok('friend shelf shows their books', fvText.indexOf('Shared Tome') !== -1);
  ok('friend shelf does not leak my books', fvText.indexOf('Mine') === -1);

  // ---- social section is always "The Hearth" (Kevin's call, 2026-10-11) ----
  // Theme-specific names (Night Court, Harvest Court, ...) are retired.
  ok('covenName() is always The Hearth', probe('covenName()') === 'The Hearth');

  window.localStorage.setItem('theme', 'twilight');
  useAs(A);
  await probe('renderCoven()'); await tick(5);
  ok('heading is The Hearth regardless of theme', q('#view').textContent.indexOf('The Hearth') !== -1);
  ok('nav label is The Hearth regardless of theme', window.document.querySelector('.bottom-nav [data-nav="coven"] span').textContent === 'The Hearth');
  window.localStorage.setItem('theme', 'dark');
  await probe('renderCoven()'); await tick(5);
  ok('heading stays The Hearth on dark', q('#view h2').textContent.indexOf('The Hearth') !== -1);

  // ---- v100: stats slot integration (real refresh path, stub cloud) ----
  useAs(A);
  // v522: stats are reading activity — Ben has opted in to sharing it.
  stub.db.profiles[B] = Object.assign({}, stub.db.profiles[B], { share_activity: true });
  stub.db.circle_links.push({ requester_id: A, addressee_id: B, status: 'accepted', created_at: new Date().toISOString() });
  runInWindow('library = ' + JSON.stringify([
    { id: 'm1', title: 'Shared Tome', authors: ['A. Writer'], status: 'read', myRating: 5, categories: ['Fiction / Romance'] },
    { id: 'm2', title: 'Second Shared', authors: ['A. Writer'], isbn: '9780000000002', status: 'read', myRating: 4, categories: ['Fiction / Romance'] },
    { id: 'm3', title: 'Third Shared', authors: ['B. Scribe'], isbn: '9780000000003', status: 'read', myRating: 4, categories: ['Fiction / Fantasy'] },
    { id: 'm4', title: 'Buddy Tome', authors: ['C. Pal'], isbn: '9780000000004', status: 'tbr' },
  ]));
  stub.db.books.push({ user_id: B, book_id: 'bk3', isbn: null,
    data: { id: 'bk3', title: 'Second Shared', authors: ['A. Writer'], isbn: '9780000000002', status: 'read', myRating: 5, categories: ['Fiction / Romance'] } });
  stub.db.books.push({ user_id: B, book_id: 'bk4', isbn: null,
    data: { id: 'bk4', title: 'Third Shared', authors: ['B. Scribe'], isbn: '9780000000003', status: 'read', myRating: 4,
      categories: ['Fiction / Fantasy'], dateStarted: '2026-09-20', dateFinished: new Date().toISOString(), pages: 320 } });
  stub.db.books.push({ user_id: B, book_id: 'bk5', isbn: null,
    data: { id: 'bk5', title: 'Buddy Tome', authors: ['C. Pal'], isbn: '9780000000004', status: 'tbr' } });
  await probe('renderCoven()'); await tick(30);
  const slotHTML = (q('#stats-slot') || {}).innerHTML || '';
  ok('stats slot fills with tabs', slotHTML.indexOf('coven-tabs') !== -1);
  ok('soulmate block renders for 3+ shared ratings', slotHTML.indexOf('Book soulmates') !== -1);
  ok('leaderboard renders the monthly finish', slotHTML.indexOf('This month') !== -1);
  // superlatives need 3+ people — this fixture has 2, so hidden (v454)
  ok('superlatives hidden with 2 people', slotHTML.indexOf('Superlatives') === -1);
  ok('buddy read surfaces the shared TBR', slotHTML.indexOf('Buddy Tome') !== -1);

  // v227: remove-friend sheet gets swipe-down-to-close like the other sheets
  runInWindow(`window.__wiredSheets = [];
    window.__origWire = wireSheetDrag;
    wireSheetDrag = function (sheet, onDismiss) {
      window.__wiredSheets.push(sheet); return window.__origWire(sheet, onDismiss);
    };
    openRemoveFriendSheet('f1', 'Test Friend');`);
  await tick(2);
  ok('remove-friend sheet wired for swipe-down-to-close',
    window.__wiredSheets.length === 1 && window.__wiredSheets[0] === q('#rf-back .modal'));
  q('#rf-cancel').click();

  // ---- v476: shelf-share consent on first Hearth accept (private by default) ----
  useAs(A);
  window.localStorage.removeItem('cozylibram.shelfShareAsked');
  stub.db.profiles[A] = { user_id: A, share_library: true, hidden_shelves: [] }; // silent default
  await probe('maybeAskShelfShare("Zoe")'); await tick(5);
  const ssSheet = q('#covenSheet');
  ok('consent sheet appears on first accept', !!ssSheet && ssSheet.textContent.indexOf('Share your shelves?') !== -1);
  ok('consent sheet names the new friend', ssSheet.textContent.indexOf('Zoe') !== -1);
  ok('consent offers equally prominent Yes/No',
    !!q('#cc-ss-yes') && !!q('#cc-ss-no') &&
    q('#cc-ss-yes').className === q('#cc-ss-no').className);
  q('#cc-ss-yes').click(); await tick(5);
  ok('Yes shares shelves', stub.db.profiles[A].share_library === true);
  ok('Yes records the choice', window.localStorage.getItem('cozylibram.shelfShareAsked') === '1');
  ok('sheet closes after choosing', !q('#covenSheet'));

  // "Not now" defers, does not revoke: an existing opt-in stays untouched
  window.localStorage.removeItem('cozylibram.shelfShareAsked');
  stub.db.profiles[A].share_library = true;
  await probe('maybeAskShelfShare("Zoe")'); await tick(5);
  q('#cc-ss-no').click(); await tick(5);
  ok('Not now leaves existing sharing untouched', stub.db.profiles[A].share_library === true);
  ok('Not now records the choice', window.localStorage.getItem('cozylibram.shelfShareAsked') === '1');

  // already asked: no sheet on later accepts
  await probe('maybeAskShelfShare("Zoe")'); await tick(5);
  ok('no repeat prompt once asked', !q('#covenSheet'));

  // dismiss (Escape) counts as "not now": defer, never revoke
  window.localStorage.removeItem('cozylibram.shelfShareAsked');
  stub.db.profiles[A].share_library = true;
  await probe('maybeAskShelfShare("Zoe")'); await tick(5);
  await probe("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))"); await tick(5);
  ok('Escape dismisses the sheet', !q('#covenSheet'));
  ok('dismiss leaves existing sharing untouched', stub.db.profiles[A].share_library === true);
  ok('dismiss records the choice', window.localStorage.getItem('cozylibram.shelfShareAsked') === '1');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
