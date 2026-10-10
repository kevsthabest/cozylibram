// Settings groups (v117, v312): Account / Library / Purchase Ledger / Appearance / Reading /
// Metadata / Offline / Privacy / About, each a collapsible card with
// persisted open/closed state; all existing controls keep working.
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
runInWindow(`view = 'settings'; renderSettings();`);

ok('9 groups render in Kevin\'s order',
  JSON.stringify(groupTitles()) ===
  JSON.stringify(['Account', 'Library', 'Purchase Ledger', 'Appearance', 'Reading', 'Metadata', 'Offline', 'Privacy', 'About']));
ok('group summaries carry tag subtitles', (() => {
  const tags = [...doc().querySelectorAll('#view > .set-group > summary .set-tag')].map(s => s.textContent);
  return /Sign in, profile & sync/.test(tags[0]) && /Version & diagnostics/.test(tags[8]);
})());
ok('first group open by default, rest collapsed', (() => {
  const g = doc().querySelectorAll('#view > .set-group');
  return g[0].open === true && g[1].open === false && g[7].open === false;
})());
ok('subsections exist inside groups',
  doc().querySelector('#view > .set-group .set-sub') !== null &&
  [...doc().querySelectorAll('.set-sub')].some(h => h.textContent === 'Coven sharing') &&
  [...doc().querySelectorAll('.set-sub')].some(h => h.textContent === 'Data management'));

const groupOf = (id) => {
  const el = doc().getElementById(id);
  const det = el && el.closest('.set-group');
  return det ? [...doc().querySelectorAll('#view > .set-group')].indexOf(det) : -1;
};
ok('controls landed in the right groups',
  groupOf('bk-wipe') === 1 &&            // Library, moved out of About
  groupOf('cover-offline') === 6 &&     // Offline, moved out of Covers
  groupOf('cover-bulk') === 5 &&        // Metadata
  groupOf('th-region') === 3 &&         // Appearance (Display)
  groupOf('pc-backfill') === 5 &&        // Metadata
  groupOf('meta-verify') === 5 &&
  groupOf('hc-test') === 5 &&
  groupOf('ac-signin') === 0 &&         // Account
  groupOf('ac-sync') === 0 &&
  groupOf('st-edit-profile') === 0 &&
  groupOf('st-privacy-go') === 7 &&      // Privacy
  groupOf('ap-update') === 8);           // About
ok('all pre-existing control ids still present',
  ['th-accent', 'th-anim', 'th-rmentry', 'bk-export', 'bk-import', 'im-pick',
   'hc-bulk', 'hc-autoseg', 'trope-srcseg', 'ac-signup', 'ac-logout', 'ap-ver']
    .every(id => !!doc().getElementById(id)));
ok('v416: theme gallery replaced the th-theme dropdown',
  !doc().getElementById('th-theme') && doc().querySelectorAll('.tcard').length === 18);

// toggling persists; a re-render restores it
runInWindow(`
  const gs = document.querySelectorAll('#view > .set-group');
  gs[0].open = false; gs[4].open = true;
  gs[4].dispatchEvent(new Event('toggle'));
  window.__saved = localStorage.getItem('spicyshelves.setgroups');
`);
ok('toggle persists open groups', window.__saved === '[4]');
runInWindow(`renderSettings();`);
ok('re-render restores persisted state', (() => {
  const g = doc().querySelectorAll('#view > .set-group');
  return g[4].open === true && g[0].open === false;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
