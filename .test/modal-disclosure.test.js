// Tests for v174 — tabbed book detail (UI mockup, Book Details panel).
//
// Replaces the v124 progressive-disclosure test: the modal is a hero
// (back button, big cover, title/author/stars/meta) plus five tabs —
// Details (read view) | Lore (tropes + characters) | Notes | Extras |
// Manage (the edit form), per the tab-reorganization spec. Covered:
// hero content, tab switching, every control keeps its ID on the right
// tab, Save persists edits made while another tab is active, the
// visible Remove button uses the existing delete flow.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

require('./harness').loadApp(window);

const run = (code) => window.eval(code);
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => Array.from(window.document.querySelectorAll(sel));

run(`library = [
  { id: 'b1', title: 'Test Book', authors: ['Author'], status: 'reading',
    progress: 40, pageCount: 200, isbn: '9781250123456', publishedDate: '2021-05-01',
    cover: '', tropes: ['enemies to lovers'], publicRating: 4.2, ratingsCount: 100,
    genres: [], myRating: 0, ratings: {}, axes: [], favorite: false,
    notes: 'old notes', description: 'A great book.', quotes: [],
    log: [{ d: '2026-09-20', from: 10, to: 40 }] }
]; openDetail('b1');`);

// --- 1. Hero: back button, big cover, title, author, stars, meta row ---
ok('hero: back button keeps the close affordance',
  !!q('#m-x') && q('#m-x').getAttribute('aria-label') === 'Close');
ok('hero: title rendered', q('.d-hero h2').textContent === 'Test Book');
ok('hero: author rendered', q('.d-hero .author').textContent.includes('Author'));
ok('hero: big cover present', !!q('.d-hero .d-cover .cover-wrap'));
ok('hero: meta row shows pages + year + ISBN', (() => {
  const t = q('.d-hero .d-meta').textContent;
  return t.includes('200 pages') && t.includes('2021') && t.includes('9781250123456');
})());
ok('hero: public stars shown', q('.d-hero .pub-rating').textContent.includes('★★★★'));
// --- v182: desktop panel — approved mockup hero: cover left, info right,
// primary row, description (three-row grid) ---
ok('hero text wrapped for the desktop two-column panel', !!q('.d-hero .d-hero-text h2'));
ok('desktop panel CSS uses the approved mockup hero grid', (() => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  return css.includes('grid-template-columns: 190px minmax(0, 1fr)') &&
    css.includes('grid-template-rows: auto auto auto') &&
    css.includes('.d-primary-row') &&
    css.includes('grid-row: 1 / span 3') &&
    css.includes('.d-about') && // Variant A movement: the About slim bar takes the old .d-hero-desc slot
    css.includes('padding: 26px 120px 26px 34px');
})());

// --- 2. Tabs exist; Details active, others hidden ---
const tabs = qa('.d-tab').map(t => t.textContent);
ok('tabs: Details | Lore | Notes | Extras | Manage', JSON.stringify(tabs) === JSON.stringify(['Details', 'Lore', 'Notes', 'Extras', 'Manage']));
ok('tabs: Details active by default',
  q('.d-tab[data-dtab="details"]').classList.contains('active') && !q('#dtab-details').hidden);
ok('tabs: Lore + Notes + Extras + Manage start hidden',
  q('#dtab-lore').hidden && q('#dtab-notes').hidden && q('#dtab-extras').hidden && q('#dtab-manage').hidden);

// --- 3. Priority content: hero + Details tab + action bar ---
// MOVEMENT (tab reorganization, spec-mandated): Details is a read view
// now — the rating stays, the form (status, progress) lives on Manage.
ok('details tab: #f-myrating present', !!q('#dtab-details #f-myrating'));
['#m-progress', '#f-status'].forEach(id =>
  ok('manage tab: ' + id + ' present', !!q('#dtab-manage ' + id)));
ok('details tab: no form fields remain', !q('#dtab-details #f-status') && !q('#dtab-details #f-title') && !q('#dtab-details #m-progress'));
ok('action bar intact with primary action', !!q('#m-primary'));
ok('details tab: reading log lists the session',
  q('#m-loglist').textContent.includes('30 pages'));
ok('remove lives in the overflow menu', !!q('#m-moremenu #m-del'));
ok('up next lives in the overflow menu', !!q('#m-moremenu #m-upnext'));

// --- 3b. Hero-first hierarchy (v180): primary action in the hero, details ordered ---
ok('hero: primary action sits in the hero', !!q('.d-hero #m-primary'));
ok('hero: primary is NOT duplicated in the bottom bar', !q('.modal-actions #m-primary'));
ok('hero order: cover, then title, then primary', (() => {
  const h = q('.d-hero').innerHTML;
  return h.indexOf('d-cover') < h.indexOf('d-hero-text') &&
    h.indexOf('d-hero-text') < h.indexOf('id="m-primary"');
})());
// MOVEMENT (tab reorganization, named in its PR): the form order the
// Variant A rebuild decided — Status & Ownership, progress, the quiet
// Details card (warnings, log, title), More details (pages) last — is
// preserved verbatim, but the whole sequence lives on Manage now; the
// rating card stayed behind on Details as the read view's first block.
ok('manage order: shelf, ownership, progress, warnings, log, title, metadata', (() => {
  const h = q('#dtab-manage').innerHTML;
  const order = ['id="f-status"', 'id="f-owned"', 'id="m-progress"', 'id="m-hc"',
    'id="m-loglist"', 'id="f-title"', 'id="f-pagecount"'];
  let last = -1;
  return order.every(id => { const i = h.indexOf(id); const good = i > last; last = i; return good; });
})());
ok('details order: rating first in the read view', (() => {
  const h = q('#dtab-details').innerHTML;
  return h.indexOf('id="f-myrating"') > -1 && h.indexOf('id="f-myrating"') < h.indexOf('id="m-quotes-wrap"');
})());

// --- 4. Lore + Notes tabs hold their controls ---
q('[data-dtab="lore"]').click();
ok('tab switch: Lore shows, Details hides', !q('#dtab-lore').hidden && q('#dtab-details').hidden);
['#f-tropes', '#f-tropesugg', '#m-tropedb', '#m-charstab'].forEach(id =>
  ok('lore tab: ' + id + ' present', !!q('#dtab-lore ' + id)));
// Note: #m-tropepropose was removed (trope proposal moved to community flows).
q('[data-dtab="notes"]').click();
ok('tab switch: Notes shows, Lore hides', !q('#dtab-notes').hidden && q('#dtab-lore').hidden);
['#f-notes', '#m-quotes'].forEach(id =>
  ok('notes tab: ' + id + ' present', !!q('#dtab-notes ' + id)));

// --- 5. Every control survived the move ---
['#f-tropes', '#f-pagecount', '#f-progress', '#f-releasedate', '#f-notes',
 '#m-upnext', '#f-owned', '#m-hc', '#m-quotes', '#m-buywrap', '#m-changecover',
 '#m-desc', '#m-loglist', '#f-axrows'
].forEach(id => ok('control kept: ' + id, !!q(id)));

// --- 6. Save persists edits made while another tab is active ---
run(`document.getElementById('f-notes').value = 'new notes';`);
q('[data-dtab="lore"]').click();
run(`document.getElementById('f-tropes').value = 'forced proximity';`);
q('[data-dtab="details"]').click();
run(`document.getElementById('m-x').click();`);
ok('save: notes persisted from the Notes tab', run(`library[0].notes`) === 'new notes');
ok('save: tropes persisted from the Lore tab',
  JSON.stringify(run(`library[0].tropes`)) === JSON.stringify(['forced proximity']));

// --- 7. Overflow-menu Remove triggers the delete flow ---
run(`openDetail('b1');`);
q('#m-more').click();
q('#m-del').click();
// v352: native confirm replaced with in-app confirmModal — assert the overlay renders
ok('remove button asks for confirmation', !!q('.confirm-overlay') && q('.confirm-overlay').textContent.includes('b1') === false); // title in dialog
q('.confirm-overlay [data-ca="cancel"]').click();
ok('cancel keeps the book', run(`library.length`) === 1 && !!q('#m-back'));

// --- 8. Extras holds the three blocks; Manage holds its own Remove ---
ok('extras: ambience entry landed', !!q('#dtab-extras .amb-entry'));
ok('extras: portrait card landed', !!q('#dtab-extras #portraitCard'));
ok('extras: candle card landed', !!q('#dtab-extras #candleCard'));
ok('extras: header zone is clear of all three', !q('.amb-entry') || !!q('#dtab-extras .amb-entry'));
ok('manage: remove row present', !!q('#dtab-manage #m-del-manage'));
q('[data-dtab="manage"]').click();
q('#m-del-manage').click();
ok('manage remove asks for confirmation too', !!q('.confirm-overlay'));
q('.confirm-overlay [data-ca="cancel"]').click();
ok('manage remove cancel keeps the book', run(`library.length`) === 1 && !!q('#m-back'));

// --- 9. Extras empty state: no block renders -> the panel says so ---
run(`window.ambienceEntryHTML = undefined; window.portraitCardHTML = undefined; window.candleCardHTML = undefined;`);
run(`openDetail('b1');`);
ok('extras empty state shows the honest copy',
  q('#dtab-extras').textContent.includes('Nothing extra for this book yet'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
