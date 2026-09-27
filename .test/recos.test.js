// Recos (v97): "You'd love this" — friends' 4★+ books you don't own yet.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in recos tests'); };
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

// ---- compact stub supabase client ----
const mkStub = () => {
  const db = { circle_invites: [], circle_links: [], profiles: {}, books: [] };
  const rowsOf = (n) => n === 'profiles' ? Object.values(db.profiles) : db[n];
  const table = (name) => ({
    select() {
      const qq = { _conds: [], _in: null,
        eq(c, v) { qq._conds.push([c, v]); return qq; },
        in(c, vs) { qq._in = [c, vs]; return qq; },
        maybeSingle() {
          let rs = rowsOf(name).filter(r => qq._conds.every(([c, v]) => r[c] === v));
          if (qq._in) rs = rs.filter(r => qq._in[1].indexOf(r[qq._in[0]]) !== -1);
          return Promise.resolve({ data: rs[0] || null, error: null });
        },
        then(res, rej) {
          try {
            let rs = rowsOf(name).filter(r => qq._conds.every(([c, v]) => r[c] === v));
            if (qq._in) rs = rs.filter(r => qq._in[1].indexOf(r[qq._in[0]]) !== -1);
            res({ data: rs, error: null });
          } catch (e) { rej(e); }
        },
      };
      return qq;
    },
    upsert(row) {
      if (name === 'circle_invites') {
        const i = db.circle_invites.findIndex(r => r.user_id === row.user_id);
        if (i >= 0) db.circle_invites[i] = Object.assign({}, db.circle_invites[i], row);
        else db.circle_invites.push(Object.assign({}, row));
      } else if (name === 'profiles') {
        db.profiles[row.user_id] = Object.assign({}, db.profiles[row.user_id], row);
      }
      return Promise.resolve({ error: null });
    },
  });
  return { db, from: (t) => table(t) };
};

const A = 'user-aaa', B = 'user-bbb', C = 'user-ccc';
const useAs = (uid) => runInWindow('cloudUser = ' + (uid ? '{ id: "' + uid + '", email: "' + uid + '@x.y" }' : 'null') + ';');
const stub = mkStub();
const bookRow = (user_id, book_id, data) => ({ user_id, book_id, isbn: data.isbn || null, data });

(async () => {
  await tick(3);
  window.__sbStub = stub;
  // me + two friends
  stub.db.circle_links.push(
    { requester_id: A, addressee_id: B, status: 'accepted' },
    { requester_id: C, addressee_id: A, status: 'accepted' },
  );
  stub.db.profiles[B] = { user_id: B, first_name: 'Ann', last_name: 'Reader', avatar_id: '', avatar_path: '' };
  stub.db.profiles[C] = { user_id: C, first_name: 'Cat', last_name: '', avatar_id: '', avatar_path: '' };
  // Ann: one 5★ book, one 3★ book (below the bar)
  stub.db.books.push(bookRow(B, 'g1', { id: 'g1', title: 'Great Book', authors: ['W. Riter'], isbn: '978123', myRating: 5, status: 'read', cover: '' }));
  stub.db.books.push(bookRow(B, 'ok1', { id: 'ok1', title: 'Okay Book', authors: ['O. Kaye'], myRating: 3, status: 'read', cover: '' }));
  // Cat: same book via differently-formatted ISBN (dedupes), plus a book I own
  stub.db.books.push(bookRow(C, 'g1b', { id: 'g1b', title: 'Great Book', authors: ['W. Riter'], isbn: '978-123', myRating: 4, status: 'read', cover: '' }));
  stub.db.books.push(bookRow(C, 'm1b', { id: 'm1b', title: 'Owned Book', authors: ['Me'], myRating: 5, status: 'read', cover: '' }));
  // my library already has Owned Book
  runInWindow('library.length = 0;');
  runInWindow('library.push({ id: "m1", title: "Owned Book", authors: ["Me"], status: "read", _mtime: 1 });');
  // capture addBook + renderCircle instead of running the real ones
  runInWindow('var recoCapturedAdd = null, recoRenderCalls = 0;');
  runInWindow('addBook = function(b, open) { recoCapturedAdd = b; library.unshift(b); return b; };');
  runInWindow('renderCircle = function() { recoRenderCalls++; };');

  // ---- recoKey ----
  ok('recoKey normalizes ISBN dashes', probe('recoKey({ isbn: "978-1-23" })') === 'isbn:978123');
  ok('recoKey falls back to title+author', probe('recoKey({ title: "Dune", authors: ["Frank Herbert"] })') === 'ta:dune|frank herbert');
  ok('recoKey empty without a title', probe('recoKey({})') === '');

  // ---- loadRecos ----
  useAs(A);
  const recos = await probe('loadRecos()'); await tick();
  ok('one recommendation aggregated', recos.length === 1);
  ok('recommendation is the 4★+ book', recos[0].book.title === 'Great Book');
  ok('both friends counted (ISBN dedupe)', recos[0].count === 2);
  ok('average rating is correct', Math.abs(recos[0].avg - 4.5) < 0.001);
  ok('rater names carried along', recos[0].ratings.map(r => r.name).join(',').indexOf('Ann') !== -1 &&
    recos[0].ratings.map(r => r.name).join(',').indexOf('Cat') !== -1);

  // ---- section HTML ----
  const section = probe('recoSectionHTML(' + JSON.stringify(recos) + ')');
  ok('section shows the book and raters', section.indexOf('Great Book') !== -1 && section.indexOf('Ann') !== -1 && section.indexOf('Cat') !== -1);
  ok('section has an add button', section.indexOf('data-reco-add="0"') !== -1);

  // ---- refreshRecos fills the slot ----
  runInWindow('document.getElementById("view").innerHTML = \'<div id="reco-slot"></div>\';');
  await probe('refreshRecos()'); await tick(5);
  ok('slot renders recommendations', q('#reco-slot').innerHTML.indexOf('Great Book') !== -1);

  // ---- add to TBR ----
  probe('recoAddToTBR(0)'); await tick(3);
  const added = probe('recoCapturedAdd');
  ok('add builds a clean TBR book', added && added.status === 'tbr' && added.title === 'Great Book');
  ok('friend personal data is not copied', added && !('myRating' in added));
  ok('new id, not the friend\u2019s book id', added && added.id !== 'g1' && added.id !== 'g1b');
  ok('circle re-renders after add', probe('recoRenderCalls') >= 1);
  const recos2 = await probe('loadRecos()'); await tick();
  ok('added book leaves the recommendations', recos2.length === 0);

  // ---- signed out ----
  useAs(null);
  const recos3 = await probe('loadRecos()'); await tick();
  ok('no recommendations when signed out', recos3.length === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
