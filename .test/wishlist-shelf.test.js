'use strict';
/* v559 — the Wishlist is no longer a status. A book is on the Wishlist
 * exactly when status === 'tbr' AND owned === 'tobuy' ("the to-buy part
 * of TBR", the User's re-decision of the v529 model). This suite pins:
 *   1. the model core: STATUS has four statuses; isWishlistBook owns the
 *      derivation (tbr+tobuy true; tbr+owned/borrowed false; read /
 *      reading / dnf + tobuy false — the history exception survives);
 *      analytics enum has no wishlist peer.
 *   2. legacy degradation: migrateBook coerces a stored/synced
 *      status 'wishlist' to 'tbr' and leaves the ownership facet
 *      untouched (no ownership is ever invented on the read path).
 *   3. the one-time unification transform (wishlistUnifyTransform):
 *      stored status-'wishlist' rows -> tbr + tobuy, _mtime bumped,
 *      count reported, idempotent, own per-partition flag, never
 *      re-runs; the v529 transform stays byte-untouched beside it.
 *   4. producers: Discover release adds and external adds are born
 *      tbr + tobuy (wishlist-visible by derivation).
 *   5. consumer agreement: one fixture library -> Library chip count ==
 *      Wishlist shelf size == Shelves group size == Circle friend count.
 *   6. the modal: four status options, no Wishlist option; a tbr+tobuy
 *      draft says it is on the Wishlist; the primary action for a
 *      wishlist book is the acquisition action (mark owned).
 *   7. friend view: a friend's wishlist is their tbr+tobuy set; the
 *      'wishlist' shelf identity persists for hiding (hideableShelves).
 *   8. the database contract: from v529 the helper was the TWO-arg
 *      (owner, status) function with no SQL migration — superseded in
 *      exactly that point by v578 (issue #232): the books policy now
 *      routes through a 3-arg overload (owner, status, owned) so a
 *      hidden 'wishlist' key withholds the derived shelf server-side.
 *      The 2-arg helper itself stands for its other callers, and the
 *      v529/v559 no-migration facts stand.
 * js/040 cannot load under jsdom (no indexedDB), so storage end-to-end
 * is verified through the load functions on the legacy backend plus
 * source pins for the slot-path wiring. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL - ' + name); } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function freshWindow(ls) {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously' });
  const w = dom.window;
  w.fetch = async () => { throw new Error('no network in tests'); };
  if (ls) for (const k of Object.keys(ls)) w.localStorage.setItem(k, ls[k]);
  const harness = require('./harness');
  harness.loadApp(w);
  return w;
}
const boot = (w) => w.eval('loadLegacyAll()');
const tick = () => new Promise(r => setTimeout(r, 30));
const waitFor = async (fn, ms) => {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (fn()) return true; await tick(); }
  return fn();
};

const LIBKEY = 'spicyshelves.library.v1';
const book = (id, status, owned, extra) => Object.assign({
  id, title: 'Book ' + id, authors: ['A'], status, owned,
  cover: '', tropes: [], ratings: {}, myRating: 0, progress: 0, _mtime: 1,
}, extra || {});

/* ============ 1. model core ============ */
{
  const w = freshWindow();
  ok('STATUS has exactly the four statuses (no wishlist)',
    w.eval(`JSON.stringify(Object.keys(STATUS).sort())`) === '["dnf","read","reading","tbr"]');
  ok('isWishlistBook: tbr + tobuy is a wishlist book',
    w.eval(`isWishlistBook({ status: 'tbr', owned: 'tobuy' })`) === true);
  ok('isWishlistBook: tbr + owned is not',
    w.eval(`isWishlistBook({ status: 'tbr', owned: 'owned' })`) === false);
  ok('isWishlistBook: tbr + borrowed is not',
    w.eval(`isWishlistBook({ status: 'tbr', owned: 'borrowed' })`) === false);
  ok('isWishlistBook: read + tobuy is not (history exception)',
    w.eval(`isWishlistBook({ status: 'read', owned: 'tobuy' })`) === false);
  ok('isWishlistBook: reading + tobuy is not (history exception)',
    w.eval(`isWishlistBook({ status: 'reading', owned: 'tobuy' })`) === false);
  ok('isWishlistBook: dnf + tobuy is not (history exception)',
    w.eval(`isWishlistBook({ status: 'dnf', owned: 'tobuy' })`) === false);
  ok('isWishlistBook: null-safe',
    w.eval(`isWishlistBook(null)`) === false && w.eval(`isWishlistBook({})`) === false);
  ok('analytics transition enums have no wishlist peer',
    w.eval(`PROP_VALUES.from.includes('wishlist') || PROP_VALUES.to.includes('wishlist')`) === false);
}

/* ============ 2. legacy degradation (migrateBook) ============ */
{
  const w = freshWindow();
  const mig = (b) => w.eval(`migrateBook(${JSON.stringify(b)})`);
  const pair = mig(book('x1', 'wishlist', 'tobuy'));
  ok('legacy: stored wishlist + tobuy degrades to tbr, facet untouched',
    pair.status === 'tbr' && pair.owned === 'tobuy');
  ok('legacy: the degraded pair is wishlist-visible by derivation',
    w.eval(`isWishlistBook(${JSON.stringify(pair)})`) === true);
  const ownedFacet = mig(book('x2', 'wishlist', 'owned'));
  ok('legacy: stored wishlist + owned degrades to plain TBR (no facet falsification)',
    ownedFacet.status === 'tbr' && ownedFacet.owned === 'owned' &&
    w.eval(`isWishlistBook(${JSON.stringify(ownedFacet)})`) === false);
  const unk = mig(book('x3', 'bogus', 'owned'));
  ok('legacy: unknown statuses still coerce to tbr', unk.status === 'tbr');
}

/* ============ 3. unification transform ============ */
{
  const w = freshWindow();
  w.eval(`window.__lib = [
    { id: 'u1', status: 'wishlist', owned: 'owned', _mtime: 5 },
    { id: 'u2', status: 'wishlist', owned: 'tobuy', _mtime: 5 },
    { id: 'u3', status: 'tbr', owned: 'tobuy', _mtime: 5 },
    { id: 'u4', status: 'read', owned: 'tobuy', _mtime: 5 },
  ];`);
  const n = w.eval('wishlistUnifyTransform(window.__lib)');
  ok('transform converts exactly the wishlist-status rows', n === 2);
  ok('transform: u1 -> tbr + tobuy (facet set by the transform, the one place it may)',
    w.eval(`window.__lib[0].status`) === 'tbr' && w.eval(`window.__lib[0].owned`) === 'tobuy');
  ok('transform: converted rows get an _mtime bump (they win the next merge)',
    w.eval(`window.__lib[0]._mtime`) > 5 && w.eval(`window.__lib[1]._mtime`) > 5);
  ok('transform: untouched rows keep status, facet and _mtime',
    w.eval(`window.__lib[2].status`) === 'tbr' && w.eval(`window.__lib[3].status`) === 'read' &&
    w.eval(`window.__lib[3]._mtime`) === 5);
  ok('transform is idempotent on its own output',
    w.eval('wishlistUnifyTransform(window.__lib)') === 0);
  ok('v529 transform still present and unchanged in behaviour',
    w.eval(`typeof wishlistShelfTransform`) === 'function' &&
    w.eval(`(() => { const l = [{ status: 'tbr', owned: 'owned' }]; return wishlistShelfTransform(l); })()`) === 0);
}

/* ============ 3b. boot unification on the legacy backend ============ */
{
  const stored = [book('b1', 'wishlist', 'owned'), book('b2', 'wishlist', 'tobuy'), book('b3', 'tbr', 'owned')];
  const w = freshWindow({ [LIBKEY]: JSON.stringify(stored) });
  boot(w);
  const got = w.eval('library.map(b => b.id + ":" + b.status + ":" + b.owned).join(",")');
  ok('boot 1: stored wishlist rows unify to tbr + tobuy', got === 'b1:tbr:tobuy,b2:tbr:tobuy,b3:tbr:owned');
  ok('boot 1: the v559 flag is set for the partition',
    w.localStorage.getItem(LIBKEY + '.wishlist559') === '1');
  ok('boot 1: the unified library is persisted back',
    JSON.parse(w.localStorage.getItem(LIBKEY)).every(b => b.status !== 'wishlist'));
  // boot 2: flag set -> the transform never re-runs; a stale row an old
  // client wrote afterwards degrades through migrateBook only (status
  // coerced, facet NOT forced to tobuy).
  const stale = [book('b9', 'wishlist', 'owned')];
  const w2 = freshWindow({ [LIBKEY]: JSON.stringify(stale), [LIBKEY + '.wishlist559']: '1' });
  boot(w2);
  const got2 = w2.eval('library.map(b => b.id + ":" + b.status + ":" + b.owned).join(",")');
  ok('boot 2 (flag set): stale row degrades to tbr with its facet intact — transform did not re-run',
    got2 === 'b9:tbr:owned');
  // slot-path wiring is source-pinned (jsdom has no indexedDB)
  const src040 = read('js/040-storage.js');
  ok('slot path: loadSlotState runs the transform under its own kv flag',
    /wishlistUnifiedV559/.test(src040) && /wishlistUnifyTransform\(library\)/.test(src040));
  ok('slot path: idbPersistSlot mirrors the transform under the partition flag',
    /wishlist559/.test(src040) && (src040.match(/wishlistUnifyTransform/g) || []).length >= 3);
}

/* ============ 4. producers ============ */
(async () => {
  const w = freshWindow();
  w.eval(`library = [];`);
  const rel = w.eval(`addReleaseBook({ title: 'Future One', authors: ['Ann Author'],
    isbns: ['9780000000001'], cover: '', description: '', pages: 300,
    releaseDate: '2999-01-01', hcId: 7 })`);
  ok('Discover release add is born tbr + tobuy',
    rel.status === 'tbr' && rel.owned === 'tobuy');
  ok('Discover release add is wishlist-visible by derivation',
    w.eval(`isWishlistBook(library.find(b => b.title === 'Future One'))`) === true);
  const ext = w.eval(`addExternalBook({ title: 'Ext One', authors: ['Ann Author'], cover: '',
    description: '', pageCount: 200, isbn: '', hcId: null })`);
  ok('external add (+ Wishlist) is born tbr + tobuy',
    !!ext && ext.status === 'tbr' && ext.owned === 'tobuy' &&
    w.eval(`isWishlistBook(${JSON.stringify(ext)})`) === true);
  const reco = w.eval(`addRecoBook({ title: 'Reco One', authors: ['Ann Author'],
    isbns: ['9780000000002'], cover: '', description: '', pages: 250, hcId: 9 })`);
  ok('reco add unchanged mechanically (tbr) — and wishlist-visible by derivation',
    reco.status === 'tbr' && w.eval(`isWishlistBook(${JSON.stringify(reco)})`) === true);

  /* ============ 5. consumer agreement (owner surfaces) ============ */
  const w2 = freshWindow();
  w2.eval(`library = ${JSON.stringify([
    book('w1', 'tbr', 'tobuy', { releaseDate: '2999-05-01', dateAdded: '2026-01-01T00:00:00.000Z' }),
    book('w2', 'tbr', 'tobuy'),
    book('o1', 'tbr', 'owned'),
    book('r1', 'read', 'tobuy'),
  ])}; view = 'library';`);
  w2.eval(`filter = 'all'; ownFilter = 'all'; query = ''; renderLibrary();`);
  const tileWish = Number((w2.document.querySelector('#view').innerHTML
    .match(/data-shelf="wishlist"[\s\S]*?<b>(\d+)<\/b>/) || [])[1]);
  ok('agreement: library shelf tile counts the derived set', tileWish === 2);
  const chip = w2.document.querySelector('[data-f="wishlist"]');
  ok('agreement: library Wishlist chip counts the derived set',
    !!chip && chip.textContent.includes('Wishlist · 2'));
  ok('agreement: library filter wishlist = derived set',
    w2.eval(`filter = 'wishlist'; filteredBooks().map(b => b.id).join(',')`) === 'w1,w2');
  ok('agreement: library filter tbr includes the wishlist books (subset of TBR)',
    w2.eval(`filter = 'tbr'; filteredBooks().map(b => b.id).join(',')`) === 'w1,w2,o1');
  w2.eval(`filter = 'all';`);
  ok('agreement: roulette pool includes to-buy TBR books naturally',
    w2.eval(`tbrBooks().map(b => b.id).join(',')`) === 'w1,w2,o1');
  w2.eval(`view = 'wishlist'; renderWishlist();`);
  ok('agreement: Wishlist shelf renders exactly the derived set',
    w2.document.querySelectorAll('#view .book-card').length === 2);
  ok('agreement: Shelves wishlist group = derived set; tbr group includes it',
    w2.eval(`shelfGroupBooks(library, 'wishlist').map(b => b.id).join(',')`) === 'w1,w2' &&
    w2.eval(`shelfGroupBooks(library, 'tbr').map(b => b.id).join(',')`) === 'w1,w2,o1');

  /* ============ 6. modal ============ */
  const w3 = freshWindow();
  w3.eval(`library = ${JSON.stringify([
    book('m1', 'tbr', 'tobuy', { pageCount: 200 }),
    book('m2', 'tbr', 'owned', { pageCount: 200 }),
  ])};`);
  w3.eval(`openDetail('m1')`);
  await waitFor(() => { const h = w3.document.querySelector('.d-hero h2'); return h && h.textContent === 'Book m1'; });
  const statusOpts = Array.from(w3.document.querySelectorAll('#f-status [data-s]')).map(b => b.dataset.s);
  ok('modal: exactly four status options, no Wishlist option',
    statusOpts.length === 4 && !statusOpts.includes('wishlist'));
  ok('modal: a tbr + tobuy draft says the book is on the Wishlist',
    !!w3.document.getElementById('m-wishnote') && w3.document.getElementById('m-wishnote').hidden === false &&
    w3.document.getElementById('m-wishnote').textContent.includes('On your Wishlist'));
  const prim1 = (w3.document.getElementById('m-primary') || { textContent: '' }).textContent;
  ok('modal: primary for a wishlist book is the acquisition action', prim1.includes('Mark owned'));
  w3.document.getElementById('m-primary').click();
  await tick();
  ok('modal: acquisition primary marks owned, status stays tbr, book leaves the Wishlist',
    w3.eval(`library.find(b => b.id === 'm1').owned`) === 'owned' &&
    w3.eval(`library.find(b => b.id === 'm1').status`) === 'tbr' &&
    w3.eval(`isWishlistBook(library.find(b => b.id === 'm1'))`) === false);
  const prim2 = (w3.document.getElementById('m-primary') || { textContent: '' }).textContent;
  ok('modal: primary repaints to Start Reading after acquisition', prim2.includes('Start Reading'));
  w3.eval(`openDetail('m2')`);
  await waitFor(() => { const h = w3.document.querySelector('.d-hero h2'); return h && h.textContent === 'Book m2'; });
  const prim3 = (w3.document.getElementById('m-primary') || { textContent: '' }).textContent;
  ok('modal: primary for a plain TBR book stays Start Reading', prim3.includes('Start Reading'));
  ok('modal: a tbr + owned draft shows no Wishlist note',
    !!w3.document.getElementById('m-wishnote') && w3.document.getElementById('m-wishnote').hidden === true);

  /* ============ 7. friend view ============ */
  const w4 = freshWindow();
  w4.eval(`
    cloudUser = { id: 'me-1' };
    circFriend = { id: 'pal-2', name: 'Pal' };
    circProfiles['pal-2'] = { first_name: 'Pal', avatar_id: '', bio: '', fav_genres: [] };
    circBooks = [
      migrateBook({ id: 'fw', title: 'Friend Wish', authors: ['A'], status: 'wishlist', owned: 'tobuy', cover: '', tropes: [] }),
      migrateBook({ id: 'fp', title: 'Friend ToBuy TBR', authors: ['A'], status: 'tbr', owned: 'tobuy', cover: '', tropes: [] }),
      migrateBook({ id: 'fo', title: 'Friend TBR', authors: ['A'], status: 'tbr', owned: 'owned', cover: '', tropes: [] }),
    ];
    circShelf = 'all'; renderCovenFriendMain();
  `);
  await tick();
  const fchip = (v) => Array.from(w4.document.querySelectorAll('[data-cf]')).find(c => c.dataset.cf === v);
  ok('friend: wishlist chip counts the derived set (degraded old-status row + tbr+tobuy row)',
    !!fchip('wishlist') && /Wishlist · 2/.test(fchip('wishlist').textContent));
  ok('friend: agreement — friend wishlist count == owner derived count for the same shapes',
    !!fchip('wishlist') && /· 2/.test(fchip('wishlist').textContent));
  ok('friend: tbr chip counts all tbr-status books (wishlist is a subset of TBR)',
    !!fchip('tbr') && /· 3/.test(fchip('tbr').textContent));
  w4.eval(`circShelf = 'wishlist'; renderCovenFriendMain();`);
  ok('friend: wishlist shelf shows the derived set',
    w4.document.querySelector('#view').textContent.includes('Friend Wish') &&
    w4.document.querySelector('#view').textContent.includes('Friend ToBuy TBR') &&
    !w4.document.querySelector('#view').textContent.includes('Friend TBR'));
  w4.eval(`circShelf = 'tbr'; renderCovenFriendMain();`);
  ok('friend: tbr shelf includes the wishlist books',
    w4.document.querySelector('#view').textContent.includes('Friend Wish') &&
    w4.document.querySelector('#view').textContent.includes('Friend ToBuy TBR') &&
    w4.document.querySelector('#view').textContent.includes('Friend TBR'));

  /* ============ 7b. hideable shelf identity persists ============ */
  ok('hideable shelves = the four statuses + wishlist (view identity persists)',
    w4.eval(`JSON.stringify(hideableShelves())`) === '["tbr","reading","read","dnf","wishlist"]');
  const panel = w4.eval(`circlePrivacyPanelHTML({ share: true, hidden: ['wishlist'], bio: true, activity: false, recos: true, buddy: true }, 't', hideableShelves())`);
  ok('privacy panel offers a Wishlist hide chip, labelled and active when hidden',
    panel.includes('data-shelf="wishlist"') && panel.includes('>Wishlist</button>') &&
    /class="chip active" data-shelf="wishlist"/.test(panel));
  const src180 = read('js/180-settings.js');
  const src195 = read('js/195-coven.js');
  ok('both privacy surfaces build their shelf list from hideableShelves()',
    /hideableShelves\(\)/.test(src180) && /hideableShelves\(\)/.test(src195));

  /* ============ 8. database contract (v529 shape; policy form superseded by v578 / #232) ============ */
  const booksPolicy = read('supabase/schema.sql');
  // NAMED PIN MOVEMENT (v578, CONSTRAINTS rule 4): this pin asserted the
  // 2-arg policy call — the exact shape issue #232's approved design
  // replaces, because the 2-arg check cannot see the owned facet the
  // derived shelf is made of. The pin now asserts the 3-arg form with
  // the same strength (the policy must route through the helper, with
  // the facet). The old 'no 3-arg overload' pin is replaced too: its
  // regex never matched the public.-qualified definition text (it
  // passed both before and after the overload existed — vacuous), so
  // it is succeeded by real existence pins for both overloads.
  ok('schema: books select routes visibility through the 3-arg circle_book_visible(owner, status, owned) — v578 / #232',
    /circle_book_visible\(\s*books\.user_id\s*,\s*books\.data\s*->>\s*'status'\s*,\s*books\.data\s*->>\s*'owned'\s*\)/.test(booksPolicy));
  ok('schema: the 3-arg overload is defined, and the 2-arg helper remains for its other callers',
    /function\s+public\.circle_book_visible\(p_owner uuid, p_status text, p_owned text\)/.test(booksPolicy) &&
    /function\s+public\.circle_book_visible\(p_owner uuid, p_status text\)/.test(booksPolicy));
  ok('no v529 SQL migration exists (the shelf split was client-side)',
    !fs.existsSync(path.join(ROOT, 'supabase/migrations/v529_wishlist_shelf.sql')));
  ok('no v559 SQL migration (the unification is client-side)',
    !fs.existsSync(path.join(ROOT, 'supabase/migrations/v559_wishlist_unify.sql')));

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
