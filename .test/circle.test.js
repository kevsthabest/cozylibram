// Circle (v96): friend links via invite codes, request inbox, privacy, and
// read-only shared shelves. Supabase RLS itself is server-side (see
// supabase/schema.sql); these tests cover the app's queries and UI flows
// against a stub client.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in circle tests'); };
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
  const rowsOf = (name) => name === 'profiles' ? Object.values(db.profiles) : db[name];
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
const useAs = (uid) => runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "' + uid + '@x.y" }' : 'null') + ';');
const stub = mkStub();

(async () => {
  await tick(3);
  window.__sbStub = stub;
  const codeOf = async (uid) => { useAs(uid); return probe('ensureInviteCode()'); };

  // ---- invite codes ----
  const codeA = await codeOf(A);
  ok('invite code is 6 unambiguous chars', /^[A-Z0-9]{6}$/.test(codeA));
  const codeA2 = await codeOf(A);
  ok('invite code is stable per user', codeA2 === codeA);
  const codeB = await codeOf(B);
  ok('different users get different codes', codeB !== codeA);

  const send = (code) => probe('circleSendRequest(' + JSON.stringify(code) + ')');

  // ---- send request ----
  useAs(A);
  await send(codeB); await tick();
  ok('request creates a pending link', stub.db.circle_links.some(
    r => r.requester_id === A && r.addressee_id === B && r.status === 'pending'));

  // ---- send validations ----
  let err = '';
  try { await send(codeA); } catch (e) { err = e.message; }
  ok('cannot request yourself', /your own code/.test(err));
  err = '';
  try { await send('ZZZZZZ'); } catch (e) { err = e.message; }
  ok('unknown code is rejected', /No one uses that code/.test(err));
  err = '';
  try { await send(codeB); } catch (e) { err = e.message; }
  ok('duplicate request is rejected', /already pending/.test(err));
  err = '';
  try { await send('abc'); } catch (e) { err = e.message; }
  ok('short code is rejected', /full 6-character/.test(err));

  // ---- accept ----
  stub.db.profiles[A] = { user_id: A, first_name: 'Ann', last_name: 'Reader', avatar_id: 'raven', avatar_path: '' };
  stub.db.profiles[B] = { user_id: B, first_name: 'Ben', last_name: '', avatar_id: '', avatar_path: '' };
  useAs(B);
  await probe('circleAnswer(' + JSON.stringify(A) + ', true)'); await tick();
  ok('accept marks the link accepted', stub.db.circle_links.some(
    r => r.requester_id === A && r.addressee_id === B && r.status === 'accepted'));

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

  // ---- already-friends request is rejected ----
  useAs(A); err = '';
  try { await send(codeB); } catch (e) { err = e.message; }
  ok('cannot re-request a friend', /already in each other/.test(err));

  // ---- decline + re-request ----
  const codeC = await codeOf(C), codeD = await codeOf(D);
  // (C and D are already friends from the collapse test; use a fresh pair)
  const E = 'user-eee', F = 'user-fff';
  await codeOf(E); const codeF = await codeOf(F);
  useAs(E); await send(codeF); await tick();
  useAs(F);
  await probe('circleAnswer(' + JSON.stringify(E) + ', false)'); await tick();
  ok('decline marks the link declined', stub.db.circle_links.some(
    r => r.requester_id === E && r.addressee_id === F && r.status === 'declined'));
  useAs(E);
  const codeF2 = await codeOf(F);
  useAs(E); await send(codeF2); await tick();
  const ef = stub.db.circle_links.filter(
    r => (r.requester_id === E && r.addressee_id === F) || (r.requester_id === F && r.addressee_id === E));
  ok('re-request after decline starts fresh', ef.length === 1 && ef[0].status === 'pending' && ef[0].requester_id === E);

  // ---- cancel sent request ----
  useAs(E);
  await probe('circleCancel(' + JSON.stringify(F) + ')'); await tick();
  ok('cancel removes the sent request', !stub.db.circle_links.some(
    r => r.requester_id === E && r.addressee_id === F));

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
  await probe('renderCircle()'); await tick(5);
  ok('signed out shows the sign-in prompt', (q('#view') || {}).textContent.indexOf('lives in the cloud') !== -1);

  // ---- rendering: signed in ----
  useAs(A);
  await probe('renderCircle()'); await tick(5);
  const viewText = q('#view').textContent;
  ok('circle shows the invite code', (q('#cc-code') || {}).textContent === codeA);
  ok('circle shows the privacy section', viewText.indexOf('Privacy') !== -1);
  ok('nav has a circle tab', !!window.document.querySelector('.bottom-nav [data-nav="circle"]'));

  // ---- friend shelf view ----
  stub.db.profiles[B] = { user_id: B, first_name: 'Ben', last_name: '', avatar_id: 'moon', avatar_path: '' };
  runInWindow('circFriend = { id: ' + JSON.stringify(B) + ', name: "Ben" };');
  await probe('renderCircleFriend()'); await tick(5);
  const fvText = q('#view').textContent;
  ok('friend shelf shows their books', fvText.indexOf('Shared Tome') !== -1);
  ok('friend shelf does not leak my books', fvText.indexOf('Mine') === -1);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
