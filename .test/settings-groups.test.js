// Settings groups (v117, v312, v424, v476, v590, hybrid): Account / Library /
// Reading / Appearance / Offline / Privacy / Circle & privacy / About.
// v590 (Variant B) folded the Profile view into the Account group; the
// HYBRID (user decision, 2026-10-16) re-homes it: Profile is a view again
// and holds identity + the gift cluster, so the Account group is sign-in
// only and the Circle & privacy panel stands as its OWN group (the shared
// component, Settings + Hearth doors). The Purchase Ledger group stays
// retired (its figures live in Chronicles), Reading keeps the "What you
// see" trio + Book Portrait, and the persisted open-state stays retired:
// groups always start with Account open and the rest collapsed, so first
// paint is never the 97-control wall the v588 census measured. Each group
// is a collapsible card; all existing controls keep working.
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
// Hybrid: the Account group is sign-in only — the identity form lives on
// the Profile view now (asserted in profile.test.js), signed in or not.
runInWindow(`cloudUser = { id: 'sg-user', email: 'sg@example.com' };`);
runInWindow(`view = 'settings'; renderSettings();`);

ok('8 groups render in the hybrid order (Ledger retired; Circle & privacy its own group)',
  JSON.stringify(groupTitles()) ===
  JSON.stringify(['Account', 'Library', 'Reading', 'Appearance', 'Offline', 'Privacy', 'Circle & privacy', 'About']));
ok('group summaries carry tag subtitles', (() => {
  const tags = [...doc().querySelectorAll('#view > .set-group > summary .set-tag')].map(s => s.textContent);
  return /Sign in & sync/.test(tags[0]) && /Version & diagnostics/.test(tags[7]);
})());
ok('first group open by default, rest collapsed', (() => {
  const g = doc().querySelectorAll('#view > .set-group');
  return g[0].open === true && g[1].open === false && g[7].open === false;
})());
ok('subsections exist inside groups',
  doc().querySelector('#view > .set-group .set-sub') !== null &&
  [...doc().querySelectorAll('.set-sub')].some(h => h.textContent === 'What you see') &&
  [...doc().querySelectorAll('.set-sub')].some(h => h.textContent === 'Data management'));

const groupOf = (id) => {
  const el = doc().getElementById(id);
  const det = el && el.closest('.set-group');
  return det ? [...doc().querySelectorAll('#view > .set-group')].indexOf(det) : -1;
};
ok('controls landed in the right groups (hybrid)',
  groupOf('bk-wipe') === 1 &&            // Library: Data management
  groupOf('cover-offline') === 4 &&      // Offline
  groupOf('st-yolo') === 3 &&            // Appearance > Display
  groupOf('th-region') === 3 &&         // Appearance (Display)
  groupOf('cover-bulk') === -1 &&        // v476: removed with Metadata group
  groupOf('pc-backfill') === -1 &&       // v476: removed with Metadata group
  groupOf('meta-verify') === -1 &&       // v476: removed with Metadata group
  groupOf('hc-test') === -1 &&           // v476: removed with Metadata group
  groupOf('ac-signin') === 0 &&          // Account (sign-in only, hybrid)
  groupOf('ac-sync') === 0 &&            // Account card, S4
  groupOf('ac-card-email') === 0 &&      // Account card, S4
  groupOf('pf-first') === -1 &&          // hybrid: the identity form lives on Profile
  groupOf('pf-giftaddr-slot') === -1 &&  // hybrid: the gift cluster lives on Profile
  groupOf('st-giftclaims') === -1 &&     // hybrid: the See-claims seg moved with the cluster
  groupOf('st-circle-privacy') === 6 &&  // Circle & privacy: the shared panel, its own group
  groupOf('st-warnprefs') === 2 &&       // Reading: warning preferences entry
  groupOf('st-spoilers') === 2 &&        // Reading: Hide spoilers moved out of Privacy
  groupOf('rd-shield') === 2 &&          // Reading: the content shield sits with "What you see"
  groupOf('ap-update') === 7);           // About
ok('retired controls are gone (v590 named cuts)',
  groupOf('th-rmentry') === -1 &&        // the Show/Hide setting is retired (button is contextual now)
  groupOf('st-privacy-go') === -1 &&     // "Manage sharing" teleport button cut
  groupOf('st-edit-profile') === -1 &&   // no separate Profile view to edit in
  groupOf('st-privacy') === -1 &&        // the read-only Hearth-sharing summary is cut
  groupOf('pf-save') === -1 &&           // the account form autosaves — no Save button
  !groupTitles().includes('Purchase Ledger') &&
  doc().querySelectorAll('#view .ledger-row').length === 0);
ok('all pre-existing control ids still present (v590: th-rmentry retired with its setting; hybrid: pf-* ids live on Profile)',
  ['th-accent', 'th-anim', 'bk-export', 'bk-import', 'im-pick',
   'ac-signup', 'ac-logout', 'ap-ver']
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
    const about = groups[7];
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
