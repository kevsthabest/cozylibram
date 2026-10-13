// "Wishlist as a true shelf" (v529) — supersedes the v529 gift-shelf
// facet build (PR #193, never merged) per Decision A: the wishlist is
// a STATUS, not the owned === 'tobuy' facet it was until now.
//
// Model under test:
// - STATUS gains 'wishlist'; wishlist-ness derives ONLY from status.
//   'tobuy' survives as a pure ownership facet ("not in hand yet") on
//   books of any shelf — a reco add is tbr + tobuy and is NOT a
//   wishlist book.
// - One-time, per-partition-flagged migration (wishlistShelfTransform):
//   tobuy without reading history -> Wishlist shelf (facet kept);
//   tobuy with history (read/reading) -> history wins, facet
//   normalized to 'owned'. Never re-runs (the flag), because after the
//   migration tbr + tobuy is a legitimate new state again.
// - NO SQL migration: books.data carries status and the books policy
//   already routes every status through the 2-arg
//   circle_book_visible(owner, status) — 'wishlist' hides via
//   hidden_shelves as a real status key. (The facet build's 3-arg
//   overload must NOT exist.)
// - Unknown statuses still coerce to 'tbr' at migrateBook — the
//   mixed-version window degrades, never corrupts.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP_DIR = process.env.BOOKTOK_DIR || path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok -', label); } else { fail++; console.log('  NOT OK -', label); } };
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });

const read = (p) => fs.readFileSync(path.join(APP_DIR, p), 'utf8');

/* ================= no-SQL + no-overload shape pins ================= */
const schema = read('supabase/schema.sql');
ok('schema: books policy routes status through the 2-arg circle_book_visible',
  /circle_book_visible\(books\.user_id, books\.data->>'status'\)/.test(schema));
ok('schema: NO 3-arg circle_book_visible overload (the facet build stays superseded)',
  !/circle_book_visible\(uuid, text, text\)/.test(schema) &&
  !/function public\.circle_book_visible\(p_owner uuid, p_status text, p_owned/.test(schema));
const migDir = fs.readdirSync(path.join(APP_DIR, 'supabase/migrations'));
ok('no v529 SQL migration exists (status rides books.data; none is needed)',
  !migDir.some(f => /v529/.test(f)));

/* ================= app load ================= */
const indexHtml = read('index.html');
const dom = new JSDOM(indexHtml, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window;
require('./harness').loadApp(w);
const probe = (js) => w.eval(js);
const q = (s) => w.document.querySelector(s);
const qa = (s) => [...w.document.querySelectorAll(s)];

ok('STATUS has the Wishlist shelf', probe(`STATUS.wishlist`) === 'Wishlist');
ok('analytics status-change allowlists know the new shelf',
  probe(`PROP_VALUES.from.includes('wishlist') && PROP_VALUES.to.includes('wishlist')`));

/* ================= unknown-status safety ================= */
ok('migrateBook keeps status wishlist (it is a real status now)',
  probe(`migrateBook({ id: 'x1', status: 'wishlist', authors: [], tropes: [] }).status`) === 'wishlist');
ok('migrateBook still coerces an unknown status to tbr (mixed-version window degrades)',
  probe(`migrateBook({ id: 'x2', status: 'bogus', authors: [], tropes: [] }).status`) === 'tbr');

/* ================= the migration transform ================= */
probe(`
  window.__mx = [
    { id: 'm1', status: 'tbr',     owned: 'tobuy',    _mtime: 1 },
    { id: 'm2', status: 'dnf',     owned: 'tobuy',    _mtime: 1 },
    { id: 'm3', status: 'read',    owned: 'tobuy',    _mtime: 1 },
    { id: 'm4', status: 'reading', owned: 'tobuy',    _mtime: 1 },
    { id: 'm5', status: 'wishlist',owned: 'tobuy',    _mtime: 1 },
    { id: 'm6', status: 'tbr',     owned: 'owned',    _mtime: 1 },
    { id: 'm7', status: 'tbr',     owned: 'borrowed', _mtime: 1 },
    { id: 'm8', status: 'read',    owned: 'tobuy',    _mtime: 1 },
  ];
  window.__mxN = wishlistShelfTransform(window.__mx);
  window.__mxById = {}; window.__mx.forEach(b => { window.__mxById[b.id] = b; });
`);
ok('transform changes exactly the 5 tobuy rows with a stale signal', probe(`window.__mxN`) === 5);
ok('tbr + tobuy -> Wishlist shelf, facet kept (not in hand yet)',
  probe(`window.__mxById.m1.status`) === 'wishlist' && probe(`window.__mxById.m1.owned`) === 'tobuy');
ok('dnf + tobuy -> Wishlist shelf (no reading history per the rule)',
  probe(`window.__mxById.m2.status`) === 'wishlist');
ok('read + tobuy -> history wins: shelf kept, facet normalized to owned',
  probe(`window.__mxById.m3.status`) === 'read' && probe(`window.__mxById.m3.owned`) === 'owned');
ok('reading + tobuy -> history wins too',
  probe(`window.__mxById.m4.status`) === 'reading' && probe(`window.__mxById.m4.owned`) === 'owned');
ok('already-wishlist + tobuy is untouched (not counted)',
  probe(`window.__mxById.m5.status`) === 'wishlist' && probe(`window.__mxById.m5._mtime`) === 1);
ok('non-tobuy books are untouched', probe(`window.__mxById.m6._mtime`) === 1 && probe(`window.__mxById.m7._mtime`) === 1);
ok('changed books get a fresh _mtime (they must win the next merge and push once)',
  probe(`window.__mxById.m1._mtime`) > 1 && probe(`window.__mxById.m3._mtime`) > 1);
ok('transform is idempotent on its own output', probe(`wishlistShelfTransform(window.__mx)`) === 0);

/* ================= load-path flag (legacy backend) ================= */
// Boot 1: a pre-migration library in localStorage is transformed at
// load, persisted back, and the per-partition flag is set.
{
  const dom2 = new JSDOM(indexHtml, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.localStorage.setItem('spicyshelves.library.v1', JSON.stringify([
    { id: 'L1', title: 'Legacy Wish', authors: ['A'], status: 'tbr', owned: 'tobuy', tropes: [] },
    { id: 'L2', title: 'Legacy Read', authors: ['A'], status: 'read', owned: 'tobuy', tropes: [] },
  ]));
  require('./harness').loadApp(w2);
  const lib2 = w2.eval(`library.map(b => b.id + ':' + b.status + ':' + b.owned).join(',')`);
  ok('boot migrates the stored library (wishlist shelf + history-wins facet)',
    lib2 === 'L1:wishlist:tobuy,L2:read:owned');
  ok('boot sets the per-partition migration flag',
    w2.localStorage.getItem('spicyshelves.library.v1.wishlist529') === '1');
  const stored = JSON.parse(w2.localStorage.getItem('spicyshelves.library.v1'));
  ok('boot persists the migrated library back to storage',
    stored.find(b => b.id === 'L1').status === 'wishlist' && stored.find(b => b.id === 'L2').owned === 'owned');
}
// Boot 2: with the flag set, a NEW tbr + tobuy book (the legitimate
// post-migration state) is NOT swept onto the wishlist.
{
  const dom3 = new JSDOM(indexHtml, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
  const w3 = dom3.window;
  w3.localStorage.setItem('spicyshelves.library.v1.wishlist529', '1');
  w3.localStorage.setItem('spicyshelves.library.v1', JSON.stringify([
    { id: 'N1', title: 'Reco Add', authors: ['A'], status: 'tbr', owned: 'tobuy', tropes: [] },
  ]));
  require('./harness').loadApp(w3);
  ok('flag set -> no re-run: a post-migration tbr + tobuy book stays on TBR',
    w3.eval(`library[0].status`) === 'tbr');
}

/* ================= producers ================= */
probe(`library = [];`);
const rel = probe(`addReleaseBook({ title: 'Future Wish', authors: ['Ann'], cover: '', description: '', pages: 100, releaseDate: '2099-01-01', isbns: [], hcId: 42 })`);
ok('Discover release add lands on the Wishlist shelf (facet: tobuy)',
  !!rel && rel.status === 'wishlist' && rel.owned === 'tobuy');
const ext = probe(`addExternalBook({ title: 'Series Next', author: 'Ann', cover: '', isbn: '', seriesName: 'S', position: 2 })`);
ok('external/series add lands on the Wishlist shelf',
  !!ext && ext.status === 'wishlist' && ext.owned === 'tobuy');
const reco = probe(`addRecoBook({ title: 'Reco Pick', authors: ['Ann'], cover: '', description: '', pages: 100, isbns: [], hcId: 7 })`);
ok('+TBR reco add stays TBR (it was never a wishlist add)',
  !!reco && reco.status === 'tbr');

/* ================= owner surfaces ================= */
const DAY = 864e5;
const future = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
probe(`
  library = [
    { id: 'w1', title: 'Wish Future', authors: ['A'], status: 'wishlist', owned: 'tobuy', cover: '', tropes: [], releaseDate: '${future}', dateAdded: '2026-01-03T00:00:00.000Z' },
    { id: 'w2', title: 'Wish Plain', authors: ['A'], status: 'wishlist', owned: 'tobuy', cover: '', tropes: [], dateAdded: '2026-01-02T00:00:00.000Z' },
    { id: 'f1', title: 'Facet Only', authors: ['A'], status: 'tbr', owned: 'tobuy', cover: '', tropes: [], dateAdded: '2026-01-01T00:00:00.000Z' },
    { id: 'r1', title: 'Read One', authors: ['A'], status: 'read', owned: 'owned', cover: '', tropes: [], dateAdded: '2026-01-01T00:00:00.000Z' },
  ];
  view = 'wishlist'; renderWishlist();
`);
ok('wishlist view shows Wishlist-shelf books', q('#view').textContent.includes('Wish Plain'));
ok('wishlist view: future release lands in Coming soon',
  !!q('.wish-section') && q('#view').textContent.includes('Wish Future'));
ok('wishlist view: a tbr + tobuy facet book is NOT a wishlist book anymore',
  !q('#view').textContent.includes('Facet Only'));
probe(`view = 'library'; filter = 'all'; ownFilter = 'all'; query = ''; renderLibrary();`);
ok('library home shelf tiles count the Wishlist shelf by status',
  q('#view').textContent.includes('Wishlist') && probe(`shelfTilesHTML({ tbr: 1, reading: 0, read: 1, dnf: 0, wishlist: 2 })`).includes('<b>2</b>'));
ok('library filter chips offer the Wishlist shelf with its count',
  !!qa('.chip').find(c => c.dataset.f === 'wishlist' && /Wishlist · 2/.test(c.textContent)));
ok('filteredBooks honours the wishlist filter',
  probe(`filter = 'wishlist'; filteredBooks().map(b => b.id).join(',')`) === 'w1,w2');
probe(`filter = 'all';`);
ok('TBR roulette pool excludes the Wishlist shelf by status',
  probe(`tbrBooks().map(b => b.id).join(',')`) === 'f1');

/* ================= book modal: shelf move ================= */
(async () => {
  probe(`openDetail('w2');`);
  await tick(6);
  ok('modal names the Wishlist shelf on the shelf row',
    !!q('#f-status-val') && q('#f-status-val').textContent === 'Wishlist');
  ok('modal shelf options include Wishlist',
    !!qa('#f-status [data-s]').find(b => b.dataset.s === 'wishlist'));
  qa('#f-status [data-s]').find(b => b.dataset.s === 'tbr').click();
  q('#m-save').click();
  await tick(4);
  ok('moving Wishlist -> TBR in the sheet is an ordinary status save',
    probe(`library.find(b => b.id === 'w2').status`) === 'tbr');
  probe(`openDetail('f1');`);
  await tick(6);
  qa('#f-status [data-s]').find(b => b.dataset.s === 'wishlist').click();
  q('#m-save').click();
  await tick(4);
  ok('moving TBR -> Wishlist in the sheet works the other way',
    probe(`library.find(b => b.id === 'f1').status`) === 'wishlist');

  /* ================= friend view: the gift shelf ================= */
  probe(`
    cloudUser = { id: 'me-1' };
    circFriend = { id: 'pal-2', name: 'Pal' };
    circBooks = [
      migrateBook({ id: 'fw', title: 'Friend Wish', authors: ['A'], status: 'wishlist', owned: 'tobuy', cover: '', tropes: [] }),
      migrateBook({ id: 'ft', title: 'Friend TBR', authors: ['A'], status: 'tbr', owned: 'owned', cover: '', tropes: [] }),
      migrateBook({ id: 'fp', title: 'Friend PreMigration', authors: ['A'], status: 'tbr', owned: 'tobuy', cover: '', tropes: [] }),
    ];
    circShelf = 'all'; renderCovenFriendMain();
  `);
  ok('friend view has a Wishlist chip counting shelf books only',
    !!qa('[data-cf]').find(c => c.dataset.cf === 'wishlist' && /Wishlist · 1/.test(c.textContent)));
  probe(`circShelf = 'wishlist'; renderCovenFriendMain();`);
  ok('friend Wishlist shelf shows the wishlist book',
    q('#view').textContent.includes('Friend Wish'));
  ok('friend Wishlist shelf does NOT show a pre-migration facet book (mixed-state window)',
    !q('#view').textContent.includes('Friend PreMigration'));
  probe(`circShelf = 'tbr'; renderCovenFriendMain();`);
  ok('pre-migration friend rows keep old semantics: facet book sits on their TBR shelf',
    q('#view').textContent.includes('Friend PreMigration') && q('#view').textContent.includes('Friend TBR'));
  ok('friend book preview names the Wishlist shelf via STATUS (no special case)',
    probe(`STATUS['wishlist']`) === 'Wishlist');

  /* ================= privacy panel ================= */
  const panel = probe(`circlePrivacyPanelHTML({ share: true, hidden: ['wishlist'], bio: true, activity: false, recos: true, buddy: true }, 'st', Object.keys(STATUS))`);
  ok('privacy panel offers Wishlist as a hideable shelf, active when hidden',
    panel.includes('data-shelf="wishlist"') && /data-shelf="wishlist"/.test(panel) && panel.includes('>Wishlist</button>'));
  ok('settings + coven derive hideable shelves from STATUS (wishlist included by construction)',
    /Object\.keys\(STATUS\)\.filter/.test(read('js/180-settings.js')) &&
    /const shelves = Object\.keys\(STATUS\);/.test(read('js/195-coven.js')));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR', e); process.exit(1); });
