// Tests for v539 — phone bottom nav goes seven-across: Settings joins the
// bar and Add takes the true centre (4th of 7) instead of sitting a
// half-column left of it (six equal columns put the centre between Add and
// Chronicles). The fix is phone-scoped CSS (max-width:759px): flex order +
// display only — markup, DOM order, the tablet top nav (>=760px) and the
// desktop sidebar (>=1024px) are all untouched.
//
// Layout evidence (real headless-Chrome render of the shipped markup +
// styles.css, Inter loaded): at 320/360/375/390/412px the visual order is
// library/discover/stats/add/shelf/coven/settings, Add's centre equals the
// bar's centre exactly, and every label fits its column (widest: "My
// Shelves" 43.6px in a 45.7px column at 320px). At 800px and 1280px every
// button's computed order is 0 and Settings' display matches pre-v539.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log('FAIL - ' + name); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

// --- 1. Markup unchanged: seven buttons, original DOM order ---
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
const qa = (sel) => Array.from(window.document.querySelectorAll(sel));
const tabs = qa('.bottom-nav button').map(b => b.dataset.nav);
ok('markup: seven nav buttons', tabs.length === 7);
ok('markup: DOM order unchanged (library/discover/add/stats/shelf/coven/settings)',
  JSON.stringify(tabs) === JSON.stringify(['library', 'discover', 'add', 'stats', 'shelf', 'coven', 'settings']));
const settingsBtn = window.document.querySelector('.bottom-nav button.nav-settings');
ok('markup: settings button present with data-nav + aria-label',
  !!settingsBtn && settingsBtn.dataset.nav === 'settings' &&
  (settingsBtn.getAttribute('aria-label') || '').length > 0);

// --- 2. The v539 phone block carries the whole fix ---
function mediaBlockAfter(marker) {
  const at = css.indexOf(marker);
  if (at === -1) return null;
  const open = css.indexOf('{', css.indexOf('@media', at));
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) return css.slice(open, i + 1); }
  }
  return null;
}
const block = mediaBlockAfter('/* v539:');
const v539Head = css.slice(css.indexOf('/* v539:'), css.indexOf('{', css.indexOf('/* v539:')));
ok('css: v539 phone block exists and is scoped to max-width:759px',
  !!block && /@media \(max-width: 759px\)/.test(v539Head));
ok('css: v539 block un-hides Settings on phones',
  !!block && /\.bottom-nav \.nav-settings\s*\{\s*display:\s*flex;?\s*\}/.test(block));
const wantOrder = { library: 1, discover: 2, stats: 3, add: 4, shelf: 5, coven: 6, settings: 7 };
for (const [nav, ord] of Object.entries(wantOrder)) {
  ok('css: v539 order ' + nav + ' = ' + ord + (nav === 'add' ? ' (Add is 4th of 7 — the centre)' : ''),
    !!block && new RegExp('button\\[data-nav="' + nav + '"\\]\\s*\\{\\s*order:\\s*' + ord + ';?\\s*\\}').test(block));
}
ok('css: v539 labels cannot wrap (white-space: nowrap)',
  !!block && /\.bottom-nav button span\s*\{[^}]*white-space:\s*nowrap/.test(block));
ok('css: v539 labels scale with viewport and drop letter-spacing (fit at 320px)',
  !!block && /font-size:\s*clamp\(8px,\s*2\.5vw,\s*10px\)/.test(block) &&
  /letter-spacing:\s*0;/.test(block));

// --- 3. Scoping guards: nothing outside the phone block changes ---
const navOrderUses = css.match(/button\[data-nav=/g) || [];
const blockOrderUses = block ? (block.match(/button\[data-nav=/g) || []) : [];
ok('css: data-nav order rules exist ONLY inside the v539 phone block',
  navOrderUses.length === 7 && blockOrderUses.length === 7);
ok('css: base still hides Settings outside phone/sidebar breakpoints',
  /\.bottom-nav \.nav-settings \{ display: none; \}/.test(css));
ok('css: sidebar still shows Settings pinned to the bottom (>=1024px rule intact)',
  /\.bottom-nav \.nav-settings \{ display: flex; margin-top: auto; \}/.test(css));
ok('css: tablet top-nav rule intact (flex 0 1 160px, row direction)',
  /\.bottom-nav button \{\s*flex: 0 1 160px;/.test(css));

// --- 4. Discover badge anchor unchanged (button-relative, width-proof) ---
const badgeRule = css.match(/\.nav-badge\s*\{[^}]*\}/);
ok('css: nav badge still anchors at right: calc(50% - 24px) of its button',
  !!badgeRule && /right:\s*calc\(50% - 24px\)/.test(badgeRule[0]));

// --- 5. Behaviour: the delegated tap handler reaches Settings --------------
require('./harness').loadApp(window);
const run = (code) => window.eval(code);
settingsBtn.click();
ok('behaviour: tapping Settings in the bar opens the settings view', run('view') === 'settings');
ok('behaviour: Settings tab highlights itself after the tap',
  settingsBtn.classList.contains('active') &&
  !window.document.querySelector('.bottom-nav button[data-nav="library"]').classList.contains('active'));
window.document.querySelector('.bottom-nav button[data-nav="add"]').click();
ok('behaviour: Add still dispatches through the same handler', run('view') === 'add');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
