'use strict';
/* Format field + Subscription ownership + trophy wants (Decision).
 * Two additive data-model pieces and one derived view:
 *   1. book.format — 'hardcover' | 'paperback' | 'physical' | 'ebook' |
 *      'audio', unset (falsy) by default and MEANINGFULLY unset: the read
 *      path only ever unsets an invalid value; no transform ever writes
 *      a format. Binding is first-class so paperback -> hardcover is
 *      representable; 'physical' is the unspecified-print bucket.
 *   2. owned gains 'subscription' (KU / Kobo Plus-style access) — it
 *      must round-trip the modal sanitizers (never coerced to 'tobuy'),
 *      never enter the wishlist derivation, and badge/count honestly.
 *   3. book.wantFormat — "I want this book in that format too" (the
 *      trophy want). Distinct, labelled Wishlist membership via
 *      isTrophyWant; never double-counted with the to-buy set; a Got-it
 *      action clears it without touching the primary format.
 * Pins below follow the wishlist-shelf suite's harness pattern. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('FAIL - ' + name); } };

function freshWindow() {
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously' });
  const w = dom.window;
  w.fetch = async () => { throw new Error('no network in tests'); };
  w.matchMedia = () => ({ matches: false });
  require('./harness').loadApp(w);
  return w;
}
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));
const waitFor = async (fn, ms) => {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (fn()) return true; await tick(); }
  return fn();
};
const book = (id, status, owned, extra) => Object.assign({
  id, title: 'Book ' + id, authors: ['A'], status, owned,
  cover: '', tropes: [], ratings: {}, myRating: 0, progress: 0, _mtime: 1,
}, extra || {});

(async () => {

/* ============ 1. the value sets + binding text map ============ */
{
  const w = freshWindow();
  ok('BOOK_FORMATS is exactly the five values',
    w.eval(`JSON.stringify(BOOK_FORMATS.slice().sort())`) ===
    '["audio","ebook","hardcover","paperback","physical"]');
  ok('FORMAT_META labels: Hardcover / Paperback / Physical / Ebook / Audiobook',
    w.eval(`['hardcover','paperback','physical','ebook','audio'].map(f => FORMAT_META[f].label).join('|')`) ===
    'Hardcover|Paperback|Physical|Ebook|Audiobook');
  const map = (t) => w.eval(`formatFromBindingText(${JSON.stringify(t)})`);
  ok('binding map: hardcover', map('hardcover') === 'hardcover' && map('Hardcover') === 'hardcover');
  ok('binding map: paperback incl. mass market', map('Paperback') === 'paperback' && map('Mass Market Paperback') === 'paperback');
  ok('binding map: kindle / ebook -> ebook', map('Kindle Edition') === 'ebook' && map('ebook') === 'ebook');
  ok('binding map: audio', map('Audible Audiobook') === 'audio' && map('audiobook') === 'audio' && map('Audio CD') === 'audio');
  ok('binding map: board book -> physical (print, binding unspecified)', map('Board Book') === 'physical');
  ok('binding map: unknown / empty -> unset', map('Unknown Binding') === '' && map('') === '' && map(null) === '');
}

/* ============ 2. migrateBook coercion — the read path only unsets ============ */
{
  const w = freshWindow();
  const mig = (o) => w.eval(`migrateBook(${JSON.stringify(o)})`);
  ok('coercion: valid format kept', mig({ id: 'a', format: 'paperback' }).format === 'paperback');
  ok('coercion: unknown format -> unset', !mig({ id: 'b', format: 'scroll' }).format);
  ok('coercion: absent format stays unset (nothing guessed)', !mig({ id: 'c' }).format);
  ok('coercion: valid wantFormat kept', mig({ id: 'd', format: 'paperback', wantFormat: 'hardcover' }).wantFormat === 'hardcover');
  ok('coercion: wantFormat === format -> unset (a want for what you have)', !mig({ id: 'e', format: 'ebook', wantFormat: 'ebook' }).wantFormat);
  ok('coercion: unknown wantFormat -> unset', !mig({ id: 'f', format: 'ebook', wantFormat: 'hologram' }).wantFormat);
  ok('coercion: owned subscription passes the read path untouched',
    mig({ id: 'g', owned: 'subscription' }).owned === 'subscription');
  ok('transforms never write a format: wishlist transforms leave format/want unset',
    w.eval(`(() => { const bs = [{ id: 't1', status: 'wishlist', owned: 'tobuy' }, { id: 't2', status: 'tbr', owned: 'tobuy' }];
      wishlistShelfTransform(bs); wishlistUnifyTransform(bs);
      return bs.every(b => !b.format && !b.wantFormat); })()`));
  ok('transforms never touch an existing format/want pair',
    w.eval(`(() => { const bs = [{ id: 't3', status: 'wishlist', owned: 'tobuy', format: 'ebook', wantFormat: 'physical' }];
      wishlistUnifyTransform(bs); const b = bs[0];
      return b.format === 'ebook' && b.wantFormat === 'physical'; })()`));
}

/* ============ 3. derivations — wishlist core unchanged, trophy distinct ============ */
{
  const w = freshWindow();
  const T = (o) => w.eval(`isTrophyWant(${JSON.stringify(o)})`);
  const W = (o) => w.eval(`isWishlistBook(${JSON.stringify(o)})`);
  ok('wishlist core unchanged: tbr + tobuy is a wishlist book', W({ status: 'tbr', owned: 'tobuy' }) === true);
  ok('wishlist core: tbr + subscription is NOT a wishlist book', W({ status: 'tbr', owned: 'subscription' }) === false);
  ok('trophy canonical: paperback -> want hardcover', T({ status: 'read', owned: 'owned', format: 'paperback', wantFormat: 'hardcover' }) === true);
  ok('trophy canonical: ebook -> want physical', T({ status: 'read', owned: 'owned', format: 'ebook', wantFormat: 'physical' }) === true);
  ok('trophy: status-independent (a reading book can carry a want)', T({ status: 'reading', owned: 'owned', format: 'audio', wantFormat: 'hardcover' }) === true);
  ok('trophy: subscription record may carry a want', T({ status: 'read', owned: 'subscription', format: 'ebook', wantFormat: 'hardcover' }) === true);
  ok('trophy: borrowed record may carry a want', T({ status: 'tbr', owned: 'borrowed', format: 'physical', wantFormat: 'ebook' }) === true);
  ok('trophy refused: want === format', T({ status: 'read', owned: 'owned', format: 'ebook', wantFormat: 'ebook' }) === false);
  ok('trophy refused: no primary format yet (nothing to want a second of)', T({ status: 'read', owned: 'owned', wantFormat: 'physical' }) === false);
  ok('trophy refused: no want', T({ status: 'read', owned: 'owned', format: 'ebook' }) === false);
  ok('trophy: the plain to-buy set wins — a wishlist book is never also a trophy',
    T({ status: 'tbr', owned: 'tobuy', format: 'ebook', wantFormat: 'physical' }) === false &&
    W({ status: 'tbr', owned: 'tobuy', format: 'ebook', wantFormat: 'physical' }) === true);
}

/* ============ 4. icons exist and are real glyphs ============ */
{
  const w = freshWindow();
  ['subscription', 'physical', 'ebook', 'audio'].forEach(n => {
    ok('icon ' + n + ' renders a real glyph (not the covers fallback)',
      w.eval(`icon('${n}') !== icon('covers') && icon('${n}').includes('<svg')`));
  });
  ok('every FORMAT_META icon name resolves in ICONS',
    w.eval(`Object.keys(FORMAT_META).every(f => typeof ICONS[FORMAT_META[f].ic] === 'string')`));
  ok('subscription icon resolves for OWNED_META use',
    w.eval(`typeof ICONS.subscription === 'string'`));
}

/* ============ 5. modal — subscription round-trip, composed label, picks, guard ============ */
{
  const w = freshWindow();
  w.eval(`library = ${JSON.stringify([
    book('sub1', 'tbr', 'subscription', { format: 'ebook', pageCount: 200 }),
    book('own1', 'read', 'owned', { format: 'paperback', wantFormat: 'hardcover', pageCount: 200 }),
    book('plain', 'tbr', 'owned', { pageCount: 200 }),
  ])};`);
  const heroIs = (id) => { const h = w.document.querySelector('.d-hero h2'); return h && h.textContent === 'Book ' + id; };

  w.eval(`openDetail('sub1')`);
  await waitFor(() => heroIs('sub1'));
  const ownedOpts = Array.from(w.document.querySelectorAll('#f-owned [data-o]')).map(b => b.dataset.o);
  ok('modal: ownership options include Subscription', ownedOpts.includes('subscription'));
  ok('modal: Subscription option is active for a subscription book',
    w.document.querySelector('#f-owned [data-o="subscription"]').classList.contains('active'));
  ok('modal: composed row label is "Subscription · Ebook"',
    w.document.getElementById('f-owned-val').textContent === 'Subscription · Ebook');
  ok('modal: ownership summary composes too',
    w.document.getElementById('f-owned-sum') !== null &&
    w.document.getElementById('f-owned-sum').textContent.includes('Subscription · Ebook'));
  w.document.getElementById('m-x').click();
  await tick();
  ok('modal: Save does NOT coerce subscription to tobuy (sanitizer regression pin)',
    w.eval(`library.find(b => b.id === 'sub1').owned`) === 'subscription');
  ok('modal: Save keeps the format', w.eval(`library.find(b => b.id === 'sub1').format`) === 'ebook');

  w.eval(`openDetail('own1')`);
  await waitFor(() => heroIs('own1'));
  ok('modal: composed row label is "Owned · Paperback"',
    w.document.getElementById('f-owned-val').textContent === 'Owned · Paperback');
  ok('modal: format row shows the current format',
    w.document.getElementById('f-format-val').textContent === 'Paperback');
  ok('modal: want pick — hardcover chip present and active (the trophy want)',
    !!w.document.querySelector('#f-want-opts [data-w="hardcover"]') &&
    w.document.querySelector('#f-want-opts [data-w="hardcover"]').classList.contains('active'));
  ok('modal: want pick refuses the current format — no paperback chip offered',
    !w.document.querySelector('#f-want-opts [data-w="paperback"]'));
  // Change the primary format TO the wanted one: the want must clear.
  w.document.querySelector('#f-format [data-f="hardcover"]').click();
  await tick();
  w.document.getElementById('m-x').click();
  await tick();
  ok('modal: picking the wanted format as primary clears the want (want != format guard)',
    w.eval(`library.find(b => b.id === 'own1').format`) === 'hardcover' &&
    !w.eval(`library.find(b => b.id === 'own1').wantFormat`));

  w.eval(`openDetail('plain')`);
  await waitFor(() => heroIs('plain'));
  ok('modal: no format segment when unset', w.document.getElementById('f-owned-val').textContent === 'Owned');
  ok('modal: want pick waits for a format — no want chips before a format is set',
    w.document.querySelectorAll('#f-want-opts [data-w]').length === 0);
  w.document.querySelector('#f-format [data-f="ebook"]').click();
  await tick();
  ok('modal: want chips appear once a format is set',
    w.document.querySelectorAll('#f-want-opts [data-w]').length === 4);
  ok('modal: want pick refuses ebook now that ebook is the format',
    !w.document.querySelector('#f-want-opts [data-w="ebook"]'));
  w.document.querySelector('#f-want-opts [data-w="physical"]').click();
  await tick();
  w.document.getElementById('m-x').click();
  await tick();
  ok('modal: want pick persists (ebook record, want physical — the canonical trophy)',
    w.eval(`library.find(b => b.id === 'plain').wantFormat`) === 'physical' &&
    w.eval(`isTrophyWant(library.find(b => b.id === 'plain'))`) === true);
  w.eval(`openDetail('plain')`);
  await waitFor(() => heroIs('plain'));
  w.document.querySelector('#f-want-opts [data-w="physical"]').click(); // toggle off
  await tick();
  w.document.getElementById('m-x').click();
  await tick();
  ok('modal: tapping the active want chip toggles the want off',
    !w.eval(`library.find(b => b.id === 'plain').wantFormat`));
}

/* ============ 6. library — badge, counts, chip, filter ============ */
{
  const w = freshWindow();
  w.eval(`layout = 'list'; library = ${JSON.stringify([
    book('o', 'tbr', 'owned'), book('s', 'tbr', 'subscription'), book('t', 'tbr', 'tobuy'), book('b', 'tbr', 'borrowed'),
  ])}; renderLibrary();`);
  await tick();
  ok('badge: a subscription book badges as Subscription (not Owned)',
    !!w.document.querySelector('.book-card[data-id="s"] .badge.subscription') &&
    w.document.querySelector('.book-card[data-id="s"] .badge.subscription').textContent.includes('Subscription'));
  const chipOf = (v) => Array.from(w.document.querySelectorAll('[data-of]')).find(c => c.dataset.of === v);
  ok('chips: Subscription chip appears with its count',
    !!chipOf('subscription') && chipOf('subscription').textContent.includes('Subscription · 1'));
  ok('chips: Owned count excludes subscription books',
    !!chipOf('owned') && chipOf('owned').textContent.includes('Owned · 1'));
  chipOf('subscription').click();
  await tick();
  const shown = Array.from(w.document.querySelectorAll('.book-card')).map(el => el.dataset.id);
  ok('filter: subscription filter shows only subscription books', shown.length === 1 && shown[0] === 's');
}

/* ============ 7. wishlist — trophy section, distinct label, no double count, Got it ============ */
{
  const w = freshWindow();
  w.eval(`library = ${JSON.stringify([
    book('wish1', 'tbr', 'tobuy'),
    book('trophy1', 'read', 'owned', { format: 'ebook', wantFormat: 'physical' }),
    book('trophy2', 'tbr', 'owned', { format: 'paperback', wantFormat: 'hardcover' }),
    book('plain1', 'read', 'owned', { format: 'ebook' }),
  ])};`);
  w.eval(`view = 'wishlist'; renderWishlist();`);
  await tick();
  const viewText = w.document.querySelector('#view').textContent;
  ok('wishlist: header counts only the to-buy set (trophies not folded in)',
    /1 book you want to get your hands on/.test(viewText));
  ok('wishlist: a labelled Trophy wants section exists',
    Array.from(w.document.querySelectorAll('#view .wish-section')).some(h => h.textContent.includes('Trophy wants')));
  ok('wishlist: trophy cards are labelled with what is wanted',
    viewText.includes('Trophy') && viewText.includes('want Physical') && viewText.includes('want Hardcover'));
  ok('wishlist: trophy books render as cards in their own section',
    w.document.querySelectorAll('#view .book-card').length === 3 &&
    viewText.includes('Book trophy1') && viewText.includes('Book trophy2'));
  ok('wishlist: a plain owned book with no want does not appear',
    !viewText.includes('Book plain1'));
  ok('counts: the library Wishlist chip still counts only the to-buy set (no double count)',
    w.eval(`filter = 'all'; ownFilter = 'all'; renderLibrary();`) === undefined &&
    (() => { const c = w.document.querySelector('[data-f="wishlist"]'); return !!c && c.textContent.includes('Wishlist · 1'); })());
  ok('counts: Shelves wishlist group is the to-buy set only',
    w.eval(`shelfGroupBooks(library, 'wishlist').map(b => b.id).join(',')`) === 'wish1');
  const before = w.eval(`library.find(b => b.id === 'trophy1')._mtime`);
  w.eval(`trophyGotIt('trophy1')`);
  await tick();
  ok('got it: clears wantFormat and bumps _mtime',
    !w.eval(`library.find(b => b.id === 'trophy1').wantFormat`) &&
    w.eval(`library.find(b => b.id === 'trophy1')._mtime`) > before);
  ok('got it: the primary format is NOT changed by resolving a want',
    w.eval(`library.find(b => b.id === 'trophy1').format`) === 'ebook');
  w.eval(`view = 'wishlist'; renderWishlist();`);
  await tick();
  ok('got it: the resolved book leaves the trophy section',
    !w.document.querySelector('#view').textContent.includes('Book trophy1') &&
    w.document.querySelector('#view').textContent.includes('Book trophy2'));
}

/* ============ 8. friend view — trophy included, labelled, count stays plain ============ */
{
  const w = freshWindow();
  w.eval(`
    cloudUser = { id: 'me-1' };
    circFriend = { id: 'pal-2', name: 'Pal' };
    circProfiles['pal-2'] = { first_name: 'Pal', avatar_id: '', bio: '', fav_genres: [] };
    circBooks = [
      migrateBook({ id: 'fp', title: 'Friend Plain Wish', authors: ['A'], status: 'tbr', owned: 'tobuy', cover: '', tropes: [] }),
      migrateBook({ id: 'ft', title: 'Friend Trophy', authors: ['A'], status: 'read', owned: 'owned', format: 'ebook', wantFormat: 'hardcover', cover: '', tropes: [] }),
      migrateBook({ id: 'fo', title: 'Friend TBR', authors: ['A'], status: 'tbr', owned: 'owned', cover: '', tropes: [] }),
    ];
    circShelf = 'wishlist'; renderCovenFriendMain();
  `);
  await tick();
  const fchip = Array.from(w.document.querySelectorAll('[data-cf]')).find(c => c.dataset.cf === 'wishlist');
  ok('friend: wishlist chip counts the plain to-buy set only',
    !!fchip && /Wishlist · 1/.test(fchip.textContent));
  const vtext = w.document.querySelector('#view').textContent;
  ok('friend: wishlist shelf includes the trophy book, labelled as a trophy want',
    vtext.includes('Friend Plain Wish') && vtext.includes('Friend Trophy') &&
    vtext.includes('Trophy wants') && vtext.includes('want Hardcover'));
  ok('friend: non-wishlist books stay off the wishlist shelf', !vtext.includes('Friend TBR'));
}

/* ============ 9. scan funnel + import maps ============ */
{
  const w = freshWindow();
  w.eval(`document.body.insertAdjacentHTML('beforeend', '<div id="t-mount"></div>'); library = [];`);
  // Success, no binding stated by the provider -> physical (object in hand).
  w.eval(`window.lookupISBN = async () => migrateBook({ id: 'scan1', isbn: '9781234567897', title: 'Scanned Book', authors: ['A'], status: 'tbr', owned: 'owned' });`);
  w.eval(`isbnLookupUI('9781234567897', document.getElementById('t-mount'), 'barcode');`);
  await waitFor(() => !!w.document.querySelector('#rc-add'));
  w.document.querySelector('#rc-add').click();
  await tick();
  ok('scan add: unstated binding pre-fills physical',
    w.eval(`(library.find(b => b.id === 'scan1') || {}).format`) === 'physical');
  // Success, binding stated on the looked-up record -> the binding wins.
  w.eval(`window.lookupISBN = async () => migrateBook({ id: 'scan2', isbn: '9781234567803', title: 'Bound Book', authors: ['A'], status: 'tbr', owned: 'owned', binding: 'Hardcover' });`);
  w.eval(`isbnLookupUI('9781234567803', document.getElementById('t-mount'), 'barcode');`);
  await waitFor(() => !!w.document.querySelector('#rc-add'));
  w.document.querySelector('#rc-add').click();
  await tick();
  ok('scan add: a stated binding pre-fills that binding',
    w.eval(`(library.find(b => b.id === 'scan2') || {}).format`) === 'hardcover');
  // No catalog match -> the manual shell from an in-hand scan is physical too.
  w.eval(`window.lookupISBN = async () => null;`);
  w.eval(`isbnLookupUI('9781234561111', document.getElementById('t-mount'), 'barcode');`);
  await waitFor(() => !!w.document.querySelector('#rc-manual'));
  w.document.querySelector('#rc-manual').click();
  await tick(60);
  ok('scan add: manual fallback shell (in-hand object) pre-fills physical',
    w.eval(`library.some(b => b.format === 'physical' && b.id !== 'scan1' && b.id !== 'scan2')`) === true);

  // Import maps: stated binding/format columns land; unstated stays unset.
  const grHead = 'Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies';
  const grRow = (id, title, binding) => `${id},${title},"Yarros, Rebecca","Yarros, Rebecca","","","9780000000000",0,4.5,P,${binding},600,2023,2023,,2024/01/10,to-read,,to-read,,,,0,1`;
  const gr = w.eval(`parseGoodreadsCSV(${JSON.stringify(grHead + '\r\n' + [grRow(1, 'GR Kindle', 'Kindle Edition'), grRow(2, 'GR HC', 'Hardcover'), grRow(3, 'GR MMP', 'Mass Market Paperback'), grRow(4, 'GR None', '')].join('\r\n'))})`);
  ok('import Goodreads: Kindle Edition -> ebook', gr[0].format === 'ebook');
  ok('import Goodreads: Hardcover -> hardcover', gr[1].format === 'hardcover');
  ok('import Goodreads: Mass Market Paperback -> paperback', gr[2].format === 'paperback');
  ok('import Goodreads: no binding stated -> format unset', !gr[3].format);
  const sgHead = 'Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Character- or Plot-Driven?,Strong Character Development?,Loveable Characters?,Diverse Characters?,Flawed Characters?,Star Rating,Review,Content Warnings,Content Warning Description,Tags,Owned?';
  const sgRow = (title, fmt) => `${title},Some Author,,12345,${fmt},to-read,2024/05/01,,,,,,,,,,,,,0,,,"",no`;
  const sg = w.eval(`parseStoryGraphCSV(${JSON.stringify(sgHead + '\n' + [sgRow('SG Audio', 'audiobook'), sgRow('SG HC', 'hardcover'), sgRow('SG Blank', '')].join('\n'))})`);
  ok('import StoryGraph: audiobook -> audio', sg[0].format === 'audio');
  ok('import StoryGraph: hardcover -> hardcover', sg[1].format === 'hardcover');
  ok('import StoryGraph: no format stated -> unset', !sg[2].format);
}

/* ============ 10. sync round-trip — whole-record JSON carries the new fields ============ */
{
  const w = freshWindow();
  ok('sync: bookToRow carries format / wantFormat / subscription verbatim',
    w.eval(`(() => { const r = bookToRow({ id: 's1', owned: 'subscription', format: 'audio', wantFormat: 'hardcover' }, 'u1');
      return r.data.owned === 'subscription' && r.data.format === 'audio' && r.data.wantFormat === 'hardcover'; })()`));
  ok('sync: cloud merge of a newer row keeps the new fields (migrate keeps valid values)',
    w.eval(`(() => { const local = [migrateBook({ id: 's2', status: 'tbr', owned: 'owned', _mtime: 1 })];
      mergeCloudBooks(local, [{ book_id: 's2', data: { id: 's2', status: 'read', owned: 'subscription', format: 'ebook', wantFormat: 'physical', _mtime: 99 } }]);
      const b = local[0];
      return b.owned === 'subscription' && b.format === 'ebook' && b.wantFormat === 'physical'; })()`));
  ok('sync: export shape is the whole library record (new fields ride along)',
    read('js/180-settings.js').includes('books: library'));
}

/* ============ 11. source pins — the deliberate sanitizer updates ============ */
{
  ok('source: js/150 open + save sanitizers name subscription (no silent coercion)',
    (read('js/150-modal-discovery.js').match(/\['owned', 'tobuy', 'borrowed', 'subscription'\]/g) || []).length >= 3);
  ok('source: the scan funnel assigns a format before addBook',
    /book\.format = formatFromBindingText/.test(read('js/130-add.js')));
}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
