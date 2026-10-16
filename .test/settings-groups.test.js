// Settings groups (v117, v312, v424, v476, v590): Account / Library / Reading /
// Appearance / Offline / Privacy / About — Variant B (v590) folds the Profile
// view into the Account group, retires the Purchase Ledger group (its figures
// live in Chronicles), restores Reading as its own group (the "What you see"
// trio + Book Portrait), and retires the persisted open-state: groups always
// start with Account open and the rest collapsed, so first paint is never the
// 97-control wall the v588 census measured. Each group is a collapsible card;
// all existing controls keep working.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in settings-groups tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const doc = () => window.document;
const groupTitles = () => [...doc().querySelectorAll('#view > .set-group > summary .set-tt')].map(s => s.textContent.trim());

runInWindow(`localStorage.removeItem('spicyshelves.setgroups'); library = [];`);
// v590: the Account group carries the identity form only when signed in.
runInWindow(`cloudUser = { id: 'sg-user', email: 'sg@example.com' };`);
runInWindow(`view = 'settings'; renderSettings();`);

ok('7 groups render in the Variant B order (Ledger retired; Reading restored)',
  JSON.stringify(groupTitles()) ===
  JSON.stringify(['Account', 'Library', 'Reading', 'Appearance', 'Offline', 'Privacy', 'About']));
ok('group summaries carry tag subtitles', (() => {
  const tags = [...doc().querySelectorAll('#view > .set-group > summary .set-tag')].map(s => s.textContent);
  return /Sign in, profile & gifts/.test(tags[0]) && /Version & diagnostics/.test(tags[6]);
})());
ok('first group open by default, rest collapsed', (() => {
  const g = doc().querySelectorAll('#view > .set-group');
  return g[0].open === true && g[1].open === false && g[6].open === false;
})());
ok('subsections exist inside groups',
  doc().querySelector('#view > .set-group .set-sub') !== null &&
  [...doc().querySelectorAll('.set-sub')].some(h => h.textContent === 'Circle & privacy') &&
  [...doc().querySelectorAll('.set-sub')].some(h => h.textContent === 'What you see') &&
  [...doc().querySelectorAll('.set-sub')].some(h => h.textContent === 'Data management'));

const groupOf = (id) => {
  const el = doc().getElementById(id);
  const det = el && el.closest('.set-group');
  return det ? [...doc().querySelectorAll('#view > .set-group')].indexOf(det) : -1;
};
ok('controls landed in the right groups (v590 Variant B)',
  groupOf('bk-wipe') === 1 &&            // Library: Data management
  groupOf('cover-offline') === 4 &&      // Offline
  groupOf('st-yolo') === 3 &&            // Appearance > Display
  groupOf('th-region') === 3 &&         // Appearance (Display)
  groupOf('cover-bulk') === -1 &&        // v476: removed with Metadata group
  groupOf('pc-backfill') === -1 &&       // v476: removed with Metadata group
  groupOf('meta-verify') === -1 &&       // v476: removed with Metadata group
  groupOf('hc-test') === -1 &&           // v476: removed with Metadata group
  groupOf('ac-signin') === 0 &&          // Account
  groupOf('ac-sync') === 0 &&            // Account card, S4
  groupOf('ac-card-email') === 0 &&      // Account card, S4
  groupOf('pf-first') === 0 &&           // v590: the identity form lives in Account
  groupOf('pf-giftaddr-slot') === 0 &&   // v590: the gift cluster lives in Account
  groupOf('st-warnprefs') === 2 &&       // Reading: warning preferences entry
  groupOf('st-spoilers') === 2 &&        // Reading: Hide spoilers moved out of Privacy
  groupOf('rd-shield') === 2 &&          // Reading: the content shield sits with "What you see"
  groupOf('ap-update') === 6);           // About
ok('retired controls are gone (v590 named cuts)',
  groupOf('th-rmentry') === -1 &&        // the Show/Hide setting is retired (button is contextual now)
  groupOf('st-privacy-go') === -1 &&     // "Manage sharing" teleport button cut
  groupOf('st-edit-profile') === -1 &&   // no separate Profile view to edit in
  groupOf('st-privacy') === -1 &&        // the read-only Hearth-sharing summary is cut
  groupOf('pf-save') === -1 &&           // the account form autosaves — no Save button
  !groupTitles().includes('Purchase Ledger') &&
  doc().querySelectorAll('#view .ledger-row').length === 0);
ok('all pre-existing control ids still present (v590: th-rmentry retired with its setting)',
  ['th-accent', 'th-anim', 'bk-export', 'bk-import', 'im-pick',
   'ac-signup', 'ac-logout', 'ap-ver', 'pf-first', 'pf-last', 'pf-bio']
    .every(id => !!doc().getElementById(id)));
ok('v416: theme gallery replaced the th-theme dropdown',
  !doc().getElementById('th-theme') && doc().querySelectorAll('.tcard').length === 18);
ok('S1: header says Settings with a sync-status line (no stat row)',
  (() => {
    const h2 = doc().querySelector('#view > .view-head h2');
    const syncLine = doc().querySelector('#view > .sync-line');
    return h2 && h2.textContent.trim() === 'Settings' &&
      syncLine && syncLine.textContent.length > 0 &&
      !doc().querySelector('#view > .stat-row');
  })());
ok('S2: About has App content + collapsed Diagnostics (v476: YOLO in Display)',
  (() => {
    const groups = [...doc().querySelectorAll('#view > .set-group')];
    const about = groups[6];
    const diag = about.querySelector('details.set-diag');
    return !!doc().getElementById('ap-update') &&
      !about.querySelector('#st-yolo') &&
      !!diag && !!diag.querySelector('#ap-css') && !!diag.querySelector('#ap-css-srv');
  })());
ok('S4: sign-in note deduped; account card present with sync controls',
  (() => {
    const notes = [...doc().querySelectorAll('#view .note')];
    const note = notes.find(p => /keep your library safe and synced/.test(p.textContent));
    return !!note && !/backed up and synced/.test(note.textContent) &&
      !!doc().getElementById('ac-signedin') &&
      !!doc().getElementById('ac-card-email');
  })());
ok('S6: privacy panel loading state is skeleton shimmer or resolved content (never bare Loading text)',
  (() => {
    const box = doc().getElementById('st-circle-privacy');
    if (!box) return false;
    // Signed-out resolves immediately to the sign-in note; signed-in shows skeleton then the panel.
    return !!box.querySelector('.skel') || !/Loading\.\.\./.test(box.textContent);
  })());

// v590: the persisted open-state is retired — a stale all-open record must
// NOT resurrect the wall, and a re-render always returns to the default
// (Account open, the rest collapsed).
runInWindow(`localStorage.setItem('spicyshelves.setgroups', '[0,1,2,3,4,5,6]'); renderSettings();`);
ok('a persisted all-open record no longer restores (start-collapsed is the rule)', (() => {
  const g = doc().querySelectorAll('#view > .set-group');
  return g[0].open === true && g[3].open === false && g[6].open === false;
})());
runInWindow(`
  const gs = document.querySelectorAll('#view > .set-group');
  gs[3].open = true;
  gs[3].dispatchEvent(new Event('toggle'));
  renderSettings();
`);
ok('re-render returns to the collapsed default (no open-state persistence)', (() => {
  const g = doc().querySelectorAll('#view > .set-group');
  return g[0].open === true && g[3].open === false;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
