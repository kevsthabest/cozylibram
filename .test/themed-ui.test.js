// Tests for v185 — themed moons + dividers wired into the UI.
//
// Covered: the Discover hero renders a themed moon ornament slot; the
// emptyState() helper renders a themed divider slot; styles.css maps both
// slots per theme to real files; the slots are decorative (aria-hidden) and
// the original content (sparkles icon, big icon) is preserved.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL - ' + name); }
}

const THEMES = ['twilight', 'verdant', 'velvet', 'abyss', 'frost', 'midnight', 'dark', 'light', 'hearthside', 'candlelight'];

const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const helpers = fs.readFileSync(path.join(ROOT, 'js/050-helpers.js'), 'utf8');
const discovery = fs.readFileSync(path.join(ROOT, 'js/198-discovery.js'), 'utf8');

// Discover hero renders a themed moon slot, decorative, above the icon badge
ok('discovery: disc-moon slot rendered in disc-hero',
  discovery.includes('disc-hero') && discovery.includes('class="disc-moon"'));
ok('discovery: disc-moon is aria-hidden', discovery.includes('disc-moon" aria-hidden="true"'));
ok('discovery: sparkles badge still present', discovery.includes("icon('sparkles')"));

// emptyState renders a themed divider slot, decorative, between body and CTA
const es = helpers.slice(helpers.indexOf('function emptyState'), helpers.indexOf('document.addEventListener'));
ok('emptyState: empty-div slot rendered', es.includes('class="empty-div"'));
ok('emptyState: empty-div is aria-hidden', es.includes('empty-div" aria-hidden="true"'));
ok('emptyState: divider sits before the CTA', es.indexOf('empty-div') < es.indexOf('data-empty-go'));
ok('emptyState: big icon still rendered', es.includes("icon(o.icon || 'covers')"));

// every theme maps both slots to real files
for (const t of THEMES) {
  const moonFile = t === 'midnight' ? 'Asset/moon-sparkle.svg' : `Asset/themes/moon-${t}.svg`;
  const divFile = t === 'midnight' ? 'Asset/divider-botanical.svg' : `Asset/themes/divider-${t}.svg`;
  ok(`css: ${t} disc-moon -> ${moonFile}`,
    css.includes(`[data-theme="${t}"] .disc-moon { background-image: url("${moonFile}"); }`));
  ok(`css: ${t} empty-div -> ${divFile}`,
    css.includes(`[data-theme="${t}"] .empty-div { background-image: url("${divFile}"); }`));
  ok(`disk: ${moonFile} exists`, fs.existsSync(path.join(ROOT, moonFile)));
  ok(`disk: ${divFile} exists`, fs.existsSync(path.join(ROOT, divFile)));
}

// slot sizing keeps them decorative, not content-sized
ok('css: .disc-moon sized', /\.disc-moon\s*{[^}]*width:\s*56px/.test(css));
ok('css: .empty-div constrained', /\.empty-div\s*{[^}]*max-width:\s*260px/.test(css));

// APP_VERSION bumped to v196
const v = fs.readFileSync(path.join(ROOT, 'js/181-appversion.js'), 'utf8');
const m = /const APP_VERSION = '([^']+)'/.exec(v);
ok('APP_VERSION is v200', m && m[1] === 'v200');
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
ok('sw.js cache name matches APP_VERSION',
  sw.includes(`const CACHE = 'cozy-libram-${m[1]}';`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
