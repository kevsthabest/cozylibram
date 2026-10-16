// Remediation Batch C (v535) pins:
//  1. Warning preferences have real consumers (audit #1): the resolver
//     helpers, the trigger check, the book modal (hcDetailHTML), the
//     portrait chips, "You'd love this" (loadRecos), and Recommended
//     (recoApplyWarningFilter) — each honours a set preference and is
//     unchanged at defaults.
//  2. Trope-source control renders again in Settings and drives the
//     pre-v476 stored value (audit #7).
//  3. Theme sheet + import concierge: wireSheetDrag + overlay history
//     (audit #8).
//  4. The Settings reading-log label names the real control (UX P2-7).
//     — v590 (Variant B, named movement): the Show/Hide control the
//     label named is RETIRED (the modal button is contextual; its gate
//     is hardcoded Show), so the pin now guards the retirement: no
//     such label, no such control, no placeholder ancestor text.
//  5. Junk ISBNs resolve to nothing with zero network (UX P2-5); real
//     ISBN-13 and hyphenated ISBN-10 still resolve.
//  6. ICONS.edit / ICONS.inbox exist and differ from the fallback
//     (audit #14).
//  7. Decorations inventory: close control + button tiles (UX P2-8)
//     — source pins (the 3D room needs WebGL; jsdom cannot mount it).
//  8. Discover coven heading uses the bare name (UX P2-6) — source pin
//     + covenNameBare unit pin.
//  9. Library ownership facet chip reads "Not owned" (UX P3-16); the
//     Wishlist status chip is untouched.
// 10. covenCleanCopy and addRecoBook agree on owned:'tobuy' (audit #18).
// 11. Friend grids never render the owner's favorite flag (audit #16).
// 12. Dead code + drifted copy are gone (audit #19/#20) — absence pins.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.BOOKTOK_DIR || path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
const fetchCalls = [];
window.fetch = async (url) => { fetchCalls.push(String(url)); throw new Error('no network in remediation-c tests'); };
window.confirm = () => true;

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const probe = (js) => window.eval(js);
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));

const mk = (id, title, status, extra) => Object.assign({
  id, isbn: '978' + String([...id].reduce((a, c) => a + c.charCodeAt(0), 0)).padStart(10, '0'), title,
  authors: ['Au ' + id], cover: '', description: '', pageCount: 200, publishedDate: '',
  categories: [], publicRating: null, ratingsCount: 0, status: status || 'tbr',
  owned: 'owned', ratings: {}, axes: ['spice'], myRating: 0, tropes: [], progress: 0,
  dateAdded: new Date().toISOString(), dateFinished: null, notes: '', favorite: false,
  series: null, log: [], _mtime: 0,
}, extra || {});

/* One taxonomy fixture for the whole file (the resolver caches it in
   module memory on first read). Mirrors the seeded trigger_taxonomy. */
const TAX = [
  { id: 'violence-graphic', label: 'Graphic violence', description: 'On-page gore and brutality.' },
  { id: 'violence-sexual', label: 'Sexual violence', description: 'Sexual assault or coercion.' },
  { id: 'war', label: 'War', description: 'Warfare and its aftermath.' },
  { id: 'animal-harm', label: 'Animal harm', description: 'Animals are hurt or killed.' },
  { id: 'death-grief', label: 'Grief', description: 'Bereavement and mourning.' },
];
window.localStorage.setItem('cozylibram.warnTaxonomy.v1', JSON.stringify(TAX));
const setPrefs = (p) => window.localStorage.setItem('cozylibram.warningPrefs.v1', JSON.stringify(p));
const clearPrefs = () => window.localStorage.removeItem('cozylibram.warningPrefs.v1');
clearPrefs();

(async () => {
  /* ================= 1. warning prefs: resolver helpers ================= */
  ok('defaults: gentle, nothing excluded or prominent',
    probe('getWarningPrefs().detail') === 'gentle' &&
    probe('getWarningPrefs().excluded.length') === 0 &&
    probe('getWarningPrefs().prominent.length') === 0);
  ok('resolver: taxonomy label matches its id',
    JSON.stringify(probe('warnHitIds(["War"], ["war"])')) === '["war"]');
  ok('resolver: the id itself matches',
    JSON.stringify(probe('warnHitIds(["violence-graphic"], ["violence-graphic"])')) === '["violence-graphic"]');
  ok('resolver: label in any case matches',
    JSON.stringify(probe('warnHitIds(["GRAPHIC VIOLENCE"], ["violence-graphic"])')) === '["violence-graphic"]');
  ok('resolver: community suffix is stripped',
    JSON.stringify(probe('warnHitIds(["Sexual violence (community)"], ["violence-sexual"])')) === '["violence-sexual"]');
  ok('resolver: unrelated free string does not match',
    probe('warnHitIds(["Murder"], ["war"]).length') === 0);
  ok('resolver: description resolves through the label',
    probe('warnDescFor("War")') === 'Warfare and its aftermath.');
  ok('resolver: no description for an unknown string',
    probe('warnDescFor("Murder")') === '');
  ok('excluded: book with a matching warning is excluded',
    probe('warnBookExcluded({ contentWarnings: ["War"] }, { excluded: ["war"], prominent: [], detail: "gentle" })') === true);
  ok('excluded: empty excluded set excludes nothing',
    probe('warnBookExcluded({ contentWarnings: ["War"] }, { excluded: [], prominent: [], detail: "gentle" })') === false);
  ok('excluded: book without warnings is never excluded',
    probe('warnBookExcluded({ title: "x" }, { excluded: ["war"], prominent: [], detail: "gentle" })') === false);
  ok('prominent ordering: prominent first, rest keep their order',
    JSON.stringify(probe('warnOrderProminent(["Animal harm", "War", "Graphic violence"], { excluded: [], prominent: ["war"], detail: "gentle" })')) ===
    JSON.stringify(['War', 'Animal harm', 'Graphic violence']));
  ok('prominent ordering: no prominent prefs = original order',
    JSON.stringify(probe('warnOrderProminent(["Animal harm", "War"], { excluded: [], prominent: [], detail: "gentle" })')) ===
    JSON.stringify(['Animal harm', 'War']));

  /* ================= 1c. book modal (hcDetailHTML) ================= */
  const modalBook = mk('m1', 'Modal Book', 'tbr', { contentWarnings: ['Graphic violence', 'War', 'Animal harm'] });
  clearPrefs();
  const gentle = probe('hcDetailHTML(' + JSON.stringify(modalBook) + ')');
  ok('modal gentle (default): collapsed details, original order, no emphasis',
    gentle.includes('<details class="warnings">') && !gentle.includes('warn-tag-prom') &&
    gentle.indexOf('Graphic violence') < gentle.indexOf('War'));
  setPrefs({ excluded: [], prominent: ['war'], detail: 'gentle' });
  const prom = probe('hcDetailHTML(' + JSON.stringify(modalBook) + ')');
  ok('modal prominent: War tag first and emphasised',
    prom.indexOf('warn-tag-prom') !== -1 &&
    prom.indexOf('warn-tag-prom') < prom.indexOf('Graphic violence') &&
    prom.slice(prom.indexOf('warn-tag-prom'), prom.indexOf('warn-tag-prom') + 60).includes('>War<'));
  setPrefs({ excluded: [], prominent: [], detail: 'detailed' });
  const det = probe('hcDetailHTML(' + JSON.stringify(modalBook) + ')');
  ok('modal detailed: section open with taxonomy descriptions',
    det.includes('<details class="warnings" open>') && det.includes('Warfare and its aftermath.'));
  setPrefs({ excluded: [], prominent: [], detail: 'on-request' });
  const onreq = probe('hcDetailHTML(' + JSON.stringify(modalBook) + ')');
  ok('modal on-request: names held behind a reveal button',
    onreq.includes('data-warnreveal="m1"') && !onreq.includes('warn-tag'));
  const mwrap = window.document.createElement('div');
  mwrap.innerHTML = onreq;
  window.document.body.appendChild(mwrap);
  mwrap.querySelector('[data-warnreveal]').click();
  await tick();
  ok('modal on-request: tapping reveal swaps in the warning tags',
    mwrap.innerHTML.includes('warn-tag') && !mwrap.innerHTML.includes('warnings-onreq'));
  mwrap.remove();
  clearPrefs();

  /* ================= 1c. portrait chips ================= */
  const pBook = mk('p1', 'Portrait Book', 'read', { contentWarnings: ['Graphic violence', 'War', 'Animal harm', 'Grief'] });
  runInWindow('library.length = 0; library.push(' + JSON.stringify(pBook) + ');');
  const chipsOf = (book) => {
    const d = window.document.createElement('div');
    d.innerHTML = probe('portraitCardHTML(' + JSON.stringify(book) + ')');
    return d.querySelector('#ptWarns');
  };
  clearPrefs();
  const chipsDefault = chipsOf(pBook);
  ok('portrait default: 3 chips + "+1" truncation, original order',
    chipsDefault.querySelectorAll('.warn-tag').length === 3 &&
    chipsDefault.textContent.includes('+1') &&
    chipsDefault.querySelector('.warn-tag').textContent === 'Graphic violence');
  setPrefs({ excluded: [], prominent: ['war'], detail: 'gentle' });
  const chipsProm = chipsOf(pBook);
  ok('portrait prominent: War chip first with emphasis class',
    chipsProm.querySelector('.warn-tag').textContent === 'War' &&
    chipsProm.querySelector('.warn-tag').classList.contains('warn-tag-prom'));
  setPrefs({ excluded: [], prominent: [], detail: 'detailed' });
  const chipsDet = chipsOf(pBook);
  ok('portrait detailed: all chips shown, no truncation',
    chipsDet.querySelectorAll('.warn-tag').length === 4 && !chipsDet.textContent.includes('+1'));
  setPrefs({ excluded: [], prominent: [], detail: 'on-request' });
  const chipsHold = chipsOf(pBook);
  ok('portrait on-request: chips held behind a tap link',
    !!chipsHold.querySelector('[data-pt="warn-reveal"]') && chipsHold.querySelectorAll('.warn-tag').length === 0);
  const pwrap = window.document.createElement('div');
  pwrap.innerHTML = probe('portraitCardHTML(' + JSON.stringify(pBook) + ')');
  window.document.body.appendChild(pwrap);
  pwrap.querySelector('[data-pt="warn-reveal"]').click();
  await tick();
  ok('portrait on-request: tapping reveals the chips',
    pwrap.querySelectorAll('#ptWarns .warn-tag').length === 3);
  pwrap.remove();
  clearPrefs();

  /* ================= 1b. trigger check ================= */
  const tcBook = () => mk('tc1', 'Trigger Book', 'tbr', { contentWarnings: ['Graphic violence', 'War'] });
  const openTc = async (book) => { probe('openTriggerCheckSheet(' + JSON.stringify(book) + ', function () {})'); await tick(30); };
  // The sheet's close animates out over 250ms before the node is removed.
  const closeTc = async () => {
    const b = q('#tcLater'); if (b) b.click();
    for (let i = 0; i < 20 && q('.tc-sheet'); i++) await tick(50);
  };
  clearPrefs();
  await openTc(tcBook());
  ok('trigger gentle (default): original order, no emphasis',
    !!q('.tc-sheet') && qa('.tc-sheet .warn-tag').length === 2 &&
    qa('.tc-sheet .warn-tag')[0].textContent === 'Graphic violence' &&
    !q('.tc-sheet .warn-tag-prom'));
  await closeTc();
  ok('trigger sheet closed after Not now', !q('.tc-sheet'));
  setPrefs({ excluded: [], prominent: ['war'], detail: 'detailed' });
  await openTc(tcBook());
  ok('trigger prominent+detailed: War first, emphasised, described',
    qa('.tc-sheet .warn-tag')[0].textContent === 'War' &&
    qa('.tc-sheet .warn-tag')[0].classList.contains('warn-tag-prom') &&
    q('.tc-sheet').textContent.includes('Warfare and its aftermath.'));
  await closeTc();
  setPrefs({ excluded: [], prominent: [], detail: 'on-request' });
  await openTc(tcBook());
  ok('trigger on-request: names held, reveal button offered',
    !!q('#tcShowWarns') && !q('#tcTags').textContent.includes('War'));
  q('#tcShowWarns').click();
  await tick(20);
  ok('trigger on-request: reveal shows the warnings',
    q('#tcTags').textContent.includes('War') && !q('#tcShowWarns'));
  await closeTc();
  clearPrefs();

  /* ================= 1a. You'd love this (loadRecos) ================= */
  window.__friendBook = { id: 'fb1', title: 'War And Peace Tales', authors: ['A U Thor'], isbn: '9780000000011',
    myRating: 5, status: 'read', contentWarnings: ['War'], cover: '' };
  runInWindow(`
    cloudUser = { id: 'me1' };
    library.length = 0;
    circleLists = async () => ({ friends: [{ id: 'f1', name: 'Fay Reader', profile: { share_activity: true, share_library: true } }] });
    circleFriendBooks = async () => [window.__friendBook];
  `);
  setPrefs({ excluded: ['war'], prominent: [], detail: 'gentle' });
  const recosFiltered = await probe('loadRecos()'); await tick();
  ok("You'd love this: excluded-warning book is filtered out", recosFiltered.length === 0);
  clearPrefs();
  const recosDefault = await probe('loadRecos()'); await tick();
  ok("You'd love this: default prefs keep the book", recosDefault.length === 1);
  setPrefs({ excluded: ['violence-graphic'], prominent: [], detail: 'gentle' });
  const recosOther = await probe('loadRecos()'); await tick();
  ok("You'd love this: a non-matching exclusion keeps the book", recosOther.length === 1);
  clearPrefs();

  /* ================= 1a. Recommended (recoApplyWarningFilter) ================= */
  let searchCalls = 0;
  window.hcSearchDocs = async (shim) => {
    searchCalls++;
    const docs = {
      'Alpha Wars': [{ isbns: ['9781111111111'], title: 'Alpha Wars', authors: ['Ann'], content_warnings: ['War'] }],
      'Beta Tale': [{ isbns: ['9782222222222'], title: 'Beta Tale', authors: ['Bob'], content_warnings: ['Romance'] }],
      // Unverifiable doc: wrong ISBN, wrong title, wrong author.
      'Gamma Lie': [{ isbns: ['9789999999999'], title: 'Some Other Book', authors: ['Someone Else'], content_warnings: ['War'] }],
    };
    if (shim.title === 'Delta Fail') throw new Error('search down');
    return docs[shim.title] || [];
  };
  const rankedFixture = () => ([
    { c: { title: 'Alpha Wars', authors: ['Ann'], isbns: ['9781111111111'] }, sim: 0.9 },
    { c: { title: 'Beta Tale', authors: ['Bob'], isbns: ['9782222222222'] }, sim: 0.8 },
    { c: { title: 'Gamma Lie', authors: ['Gus'], isbns: ['9783333333333'] }, sim: 0.7 },
    { c: { title: 'Delta Fail', authors: ['Dee'], isbns: ['9784444444444'] }, sim: 0.6 },
  ]);
  setPrefs({ excluded: ['war'], prominent: [], detail: 'gentle' });
  const kept = await probe('recoApplyWarningFilter(' + JSON.stringify(rankedFixture()) + ')');
  const keptTitles = kept.map(r => r.c.title);
  ok('reco filter: verified doc with excluded warning drops the candidate', !keptTitles.includes('Alpha Wars'));
  ok('reco filter: clean candidate kept', keptTitles.includes('Beta Tale'));
  ok('reco filter: unverifiable doc does NOT drop the candidate', keptTitles.includes('Gamma Lie'));
  ok('reco filter: lookup failure keeps the candidate (fail-open)', keptTitles.includes('Delta Fail'));
  clearPrefs();
  searchCalls = 0;
  const keptAll = await probe('recoApplyWarningFilter(' + JSON.stringify(rankedFixture()) + ')');
  ok('reco filter: no exclusions = list untouched and zero lookups',
    keptAll.length === 4 && searchCalls === 0);

  /* ================= 10. add producers agree (audit #18) ================= */
  ok("covenCleanCopy sets owned:'tobuy'",
    probe('covenCleanCopy({ title: "Shared Gem", authors: ["Ann"] }).owned') === 'tobuy');
  runInWindow('library.length = 0;');
  probe('addRecoBook({ hcId: 7, title: "Reco Gem", authors: ["Ann"], isbns: ["9781111111111"], cover: "", description: "", pages: 120 })');
  await tick();
  ok("addRecoBook sets owned:'tobuy' with status tbr",
    probe('library.filter(b => b.title === "Reco Gem").length') === 1 &&
    probe('library.find(b => b.title === "Reco Gem").owned') === 'tobuy' &&
    probe('library.find(b => b.title === "Reco Gem").status') === 'tbr');

  /* ================= 2 + 4. Settings: trope control + label ================= */
  window.localStorage.setItem('spicyshelves.tropesrc', 'keywords');
  runInWindow("view = 'settings'; renderSettings();");
  await tick();
  ok('trope control renders in Settings', !!q('#trope-srcseg'));
  ok('trope control shows the pre-v476 stored value active',
    !!q('#trope-srcseg button[data-t="keywords"].active'));
  q('#trope-srcseg button[data-t="off"]').click();
  await tick(20);
  ok('trope control click persists through setTropeSource',
    probe('tropeSource()') === 'off' &&
    window.localStorage.getItem('spicyshelves.tropesrc') === 'off');
  ok('v590: the reading-log Show/Hide control is retired (label and control gone; modal button is contextual)',
    !qa('label').some(l => l.textContent.includes("Remove today")) &&
    !window.document.getElementById('th-rmentry') &&
    !window.document.body.innerHTML.includes('Log cleanup button'));
  ok('warning-prefs note no longer claims device-only storage',
    !window.document.body.innerHTML.includes('Private to this device'));

  /* ================= 3. sheet gestures + history ================= */
  runInWindow('window.__realWD = wireSheetDrag; window.__wd = []; wireSheetDrag = function (el) { window.__wd.push(el ? el.className : ""); };');
  const depth0 = probe('__overlayStackDepth()');
  runInWindow('tsOpenSheet(THEMES[0]);');
  await tick(20);
  ok('theme sheet registers with overlay history', probe('__overlayStackDepth()') === depth0 + 1);
  ok('theme sheet is wired to wireSheetDrag', window.__wd.some(c => String(c).includes('tsheet')));
  window.dispatchEvent(new window.PopStateEvent('popstate'));
  await tick(30);
  ok('theme sheet: back gesture dismisses it (revert path)',
    !q('#tsSheetWrap') && probe('__overlayStackDepth()') === depth0);
  runInWindow('tsOpenSheet(THEMES[0]); tsConfirm();');
  await tick(20);
  ok('theme sheet: confirm consumes the history entry',
    !q('#tsSheetWrap') && probe('__overlayStackDepth()') === depth0);
  runInWindow('icOpen();');
  await tick(20);
  ok('import concierge registers with overlay history', probe('__overlayStackDepth()') === depth0 + 1);
  ok('import concierge is wired to wireSheetDrag', window.__wd.some(c => String(c).includes('ic-sheet')));
  runInWindow('icClose();');
  await tick(20);
  ok('import concierge: close consumes the history entry',
    !q('#ic-overlay') && probe('__overlayStackDepth()') === depth0);
  runInWindow('wireSheetDrag = window.__realWD;');

  /* ================= 5. junk ISBN (UX P2-5) ================= */
  ok('junk: all-zeros ISBN-13 is junk', probe('isJunkIsbn("0000000000000")') === true);
  ok('junk: repeated-digit ISBN-10 is junk', probe('isJunkIsbn("1111111111")') === true);
  ok('junk: a real ISBN-13 is not junk', probe('isJunkIsbn("9781649374189")') === false);
  ok('junk: a real ISBN-10 is not junk', probe('isJunkIsbn("0306406152")') === false);
  fetchCalls.length = 0;
  const junkRes = await probe('lookupISBN("0000000000000")');
  ok('junk ISBN lookup returns no book', junkRes === null);
  ok('junk ISBN lookup makes zero network calls', fetchCalls.length === 0);
  // Legitimate lookups still resolve: stub the transport at apiFetch.
  window.__gbPayload = { items: [{ volumeInfo: { title: 'Iron Flame', authors: ['Rebecca Yarros'],
    industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781649374189' }], pageCount: 640 } }] };
  runInWindow('apiFetch = async () => ({ ok: true, status: 200, json: async () => window.__gbPayload });');
  const realRes = await probe('lookupISBNFromAPIs("9781649374189")');
  ok('real ISBN-13 still resolves', !!realRes && realRes.title === 'Iron Flame');
  window.__gbPayload = { items: [{ volumeInfo: { title: 'Dune', authors: ['Frank Herbert'],
    industryIdentifiers: [{ type: 'ISBN_10', identifier: '0306406152' }], pageCount: 688 } }] };
  const tenRes = await probe('lookupISBNFromAPIs("0-306-40615-2")');
  ok('hyphenated ISBN-10 still resolves', !!tenRes && tenRes.title === 'Dune');

  /* ================= 6. icons (audit #14) ================= */
  ok("ICONS.edit exists and is not the covers fallback",
    probe('typeof ICONS.edit') === 'string' && probe('icon("edit")') !== probe('icon("covers")'));
  ok("ICONS.inbox exists and is not the covers fallback",
    probe('typeof ICONS.inbox') === 'string' && probe('icon("inbox")') !== probe('icon("covers")'));

  /* ================= 9. dual-filter naming (UX P3-16) ================= */
  runInWindow('library.length = 0; library.push(' +
    JSON.stringify(mk('L1', 'Facet Book', 'tbr', { owned: 'tobuy' })) + ', ' +
    JSON.stringify(mk('L2', 'Wish Book', 'wishlist', { owned: 'tobuy' })) + '); renderLibrary();');
  await tick();
  ok('ownership facet chip reads "Not owned"',
    !!q('[data-of="tobuy"]') && q('[data-of="tobuy"]').textContent.includes('Not owned'));
  ok('Wishlist status chip still present and distinct',
    !!q('[data-f="wishlist"]'));

  /* ================= 11. favorites sharing boundary (audit #16) ================= */
  runInWindow(`
    view = 'coven';
    circFriend = { id: 'f9', name: 'Fay' };
    circShelf = 'all';
    circBooks = [${JSON.stringify(mk('cb1', 'Fav Book', 'read', { favorite: true }))}];
    renderCovenFriendMain();
  `);
  await tick();
  ok('friend grid does not render the owner\u2019s favorite flag',
    !q('#view').innerHTML.includes('card-fav'));
  ok('the shared book record itself keeps its favorite flag',
    probe('circBookMap["cb1"].favorite') === true);
  ok('control: the owner-side card renderer still shows favorites',
    probe('bookCard(circBookMap["cb1"], 0)').includes('card-fav'));

  /* ================= 7 + 8 + 12. source pins ================= */
  const src = (f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  const s215 = src('215-shelf3d.js');
  ok('inventory panel has a labelled close button in its header',
    s215.includes('id="s3dInvClose"') && s215.includes('aria-label="Close decoration inventory"'));
  ok('inventory tiles are real buttons; keyboard clicks pick up, unowned disabled',
    s215.includes("document.createElement('button')") && s215.includes('e.detail === 0') && s215.includes('d.disabled = true'));
  const s198 = src('198-discovery.js');
  ok('Discover coven heading uses the bare coven name',
    s198.includes("From Your ' + esc(covenNameBare())") && !s198.includes("From Your ' + esc(covenName())"));
  ok('covenNameBare strips the article', probe('covenNameBare()') === 'Hearth');
  const allJs = fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))
    .map(f => src(f)).join('\n');
  ['buddyAvatar', 'charGroupRelationships', 'syncAgo', 'ccPatchTriggerCheck',
   'shelfChunk', 'previewSections', 'gbKeyStatusText', 'hcStatusText', 'tropeDisplayConfidence']
    .forEach((name) => ok('dead code removed: ' + name, !allJs.includes('function ' + name)));
  ok('no live string points at the removed Settings → Hardcover section',
    !s198.includes('Settings \u2192 Hardcover') && !src('150-modal-discovery.js').includes('Connect Hardcover in Settings') &&
    !src('130-add.js').includes('Settings \u2192 Hardcover'));
  ok('warning-prefs copy no longer claims device-only storage anywhere',
    !allJs.includes('Private to this device') && !allJs.includes('Private per-device store'));
  ok('the five esc wrappers collapsed onto esc()',
    !allJs.includes('function escHtml') && !allJs.includes('function escH'));

  console.log('\nremediation-c: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('remediation-c crashed:', e); process.exit(2); });
