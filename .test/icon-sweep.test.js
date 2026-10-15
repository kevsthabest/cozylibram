// Icon-slot emoji sweep (Decision): UI icon slots render the line-art
// set (ICONS + icon() in js/050-helpers.js — inherits currentColor, so
// icons theme automatically) instead of raw emoji, which do not theme.
// This suite is the regression pin:
//   1. SCAN — the swept files may contain NO pictographic emoji outside
//      the explicit ALLOW list below. The list enumerates the surviving
//      CONTENT occurrences (canvas share-card text, prose, toasts —
//      categories ruled "content, not icons") by file + context key.
//      Both directions are checked: an emoji line no entry covers fails,
//      and an entry that no longer matches any emoji line fails too
//      (stale entries must be removed with their emoji).
//   2. SLOTS — each swept slot positively renders its house glyph, and
//      every icon('name') referenced resolves to a real ICONS key (the
//      v535 failure mode: icon() silently falls back to 'covers').
//   3. DNF — DNF_REASONS keeps its 6 keys/labels byte-identical while
//      its icon field now holds ICONS names, rendered via icon().
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { loadApp, APP_DIR } = require('./harness');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const read = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');

/* ---------------- 1. scan with allowlist ---------------- */
// Pictographic emoji: astral planes + the BMP pictographs/dingbats that
// render as emoji, + U+FE0F (the variation selector that emoji-ifies a
// preceding BMP char, e.g. ✍️ = U+270D U+FE0F). Typographic symbols that
// render as text (✓ ✕ ★ ♥-free forms, ✦ U+2726, ❝) are deliberately NOT
// in this set — they are type, not emoji.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u2604\u2618\u263A-\u265F\u2668\u2728\u2B00-\u2BFF\uFE0F]/u;

const SWEPT = [
  'js/010-theming.js',
  'js/150-modal-discovery.js',
  'js/160-roulette.js',
  'js/180-settings.js',
  'js/198-discovery.js',
  'js/213-dnf.js',
  'js/214-wrapped.js',
  'js/221-trigger-check.js',
  'js/225-book-portrait.js',
];

// Surviving CONTENT occurrences. `key` is a substring of the source line
// carrying the emoji; `why` is the one-line justification (standing rule).
const TOAST = 'toast copy — ephemeral content, not an icon slot (leave-alone category)';
const ALLOW = [
  // js/150 — toasts only; the one icon slot (Wishlist note) is swept.
  { file: 'js/150-modal-discovery.js', key: "toast('Added to wishlist", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast(s === 'reading'", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('Marked owned", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('Note saved", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('Type the quote first", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "'Pinned to favorites", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('📄 Found:", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('Today", why: TOAST }, // 'Today’s entry removed 🗑️'
  { file: 'js/150-modal-discovery.js', key: "toast('Saved ✨')", why: TOAST },
  // js/160 — toasts only; the trope-badge slot is swept.
  { file: 'js/160-roulette.js', key: "toast('No matching books", why: TOAST },
  { file: 'js/160-roulette.js', key: "toast('Happy reading!", why: TOAST },
  // js/180 — toasts only; the Wisp variant buttons are swept.
  { file: 'js/180-settings.js', key: "toast('Accent updated", why: TOAST },
  { file: 'js/180-settings.js', key: "btn.dataset.t === 'on'", why: TOAST }, // 👁️/🙈 visibility toast
  { file: 'js/180-settings.js', key: "toast('Store region:", why: TOAST },
  { file: 'js/180-settings.js', key: "toast('Shelf view:", why: TOAST },
  { file: 'js/180-settings.js', key: "toast('Backup downloaded", why: TOAST },
  { file: 'js/180-settings.js', key: "toast('Cached '", why: TOAST },
  { file: 'js/180-settings.js', key: "toast('🗑️ Cached covers cleared", why: TOAST },
  // js/198 — ✨ lives in empty-state NOTE PROSE (ruled prose, leave).
  { file: 'js/198-discovery.js', key: 'No new releases found', why: 'empty-state note prose, not an icon slot' },
  { file: 'js/198-discovery.js', key: 'All caught up ✨', why: 'empty-state note prose, not an icon slot' },
  // js/214 — canvas share-card text (fillText) is branding-settled image
  // copy, and the fun lines are the Wrapped plain-text share content.
  { file: 'js/214-wrapped.js', key: "fillText('✨ '", why: 'canvas share-card title text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: "fillText('📚 Your year in tropes'", why: 'canvas share-card heading text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: "fillText('🌶️ Spice level'", why: 'canvas share-card heading text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: "fillText('🎭 Top genres'", why: 'canvas share-card heading text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: "fillText('📊 Fun stats'", why: 'canvas share-card heading text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: 'Longest streak:', why: 'canvas share-card text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: '5-star books:', why: 'canvas share-card text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: 'Top author:', why: 'canvas share-card text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: 'DNFs:', why: 'canvas share-card text (branding-settled)' },
  { file: 'js/214-wrapped.js', key: "toast('No books finished", why: TOAST },
  // js/221 — 🤎 closes a prose note; the candle icon slot is swept.
  { file: 'js/221-trigger-check.js', key: 'Take it at your own pace. 🤎', why: 'prose note text, not an icon slot' },
];

const emojiLines = {}; // file -> [{n, line}]
for (const f of SWEPT) {
  emojiLines[f] = read(f).split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => EMOJI.test(line));
}
for (const f of SWEPT) {
  const uncovered = emojiLines[f].filter(({ line }) =>
    !ALLOW.some(a => a.file === f && line.includes(a.key)));
  ok('scan: no unlisted emoji in ' + f, uncovered.length === 0);
  for (const u of uncovered) console.log('    uncovered ' + f + ':' + u.n + ' :: ' + u.line.trim().slice(0, 110));
}
for (const a of ALLOW) {
  const hits = (emojiLines[a.file] || []).filter(({ line }) => line.includes(a.key));
  ok('allowlist entry still matches: ' + a.file + ' :: ' + a.key, hits.length > 0);
}

/* ---------------- 2. slots render house glyphs ---------------- */
const src050 = read('js/050-helpers.js');
const iconsBlock = src050.slice(src050.indexOf('const ICONS = {'), src050.indexOf('\n};', src050.indexOf('const ICONS = {')));
const iconKeys = new Set(Array.from(iconsBlock.matchAll(/^  (\w+): '/gm), m => m[1]));
ok("ICONS gained a 'tag' glyph", iconKeys.has('tag'));
ok("ICONS gained a 'leaf' glyph", iconKeys.has('leaf'));
for (const need of ['sun', 'moon', 'gift', 'pepper', 'sparkles', 'flame', 'search',
                    'hourglass', 'dnf', 'cloud', 'pencil', 'friends', 'ruler', 'heart', 'covers', 'ghost']) {
  ok("ICONS has '" + need + "' (sweep mapping target)", iconKeys.has(need));
}
// Every icon('name') referenced by a swept file must resolve.
for (const f of SWEPT) {
  const names = Array.from(read(f).matchAll(/icon\('(\w+)'\)/g), m => m[1]);
  const missing = names.filter(n => !iconKeys.has(n));
  ok('all icon() names in ' + f + ' exist in ICONS', missing.length === 0);
  if (missing.length) console.log('    missing: ' + missing.join(', '));
}

const s180 = read('js/180-settings.js');
ok('wisp Daybreak button uses icon(sun)', s180.includes("icon('sun')") && s180.includes('Daybreak'));
ok('wisp Firefly Night button uses icon(moon)', s180.includes("icon('moon')") && s180.includes('Firefly Night'));

const s150 = read('js/150-modal-discovery.js');
const wishnoteLine = s150.split('\n').find(l => l.includes('id="m-wishnote"')) || '';
ok('wishlist note uses icon(gift)', wishnoteLine.includes("icon('gift')"));

const s160 = read('js/160-roulette.js');
ok('roulette trope badges use icon(tag)', s160.includes("icon('tag')"));

const s225 = read('js/225-book-portrait.js');
ok('portrait spice meta uses icon(pepper)', s225.includes("icon('pepper')"));

const s214 = read('js/214-wrapped.js');
ok('wrapped banner uses icon(sparkles)', (s214.match(/icon\('sparkles'\)/g) || []).length >= 3);

const s221 = read('js/221-trigger-check.js');
const css = read('styles.css');
ok('trigger-check candle slot uses icon(flame)', s221.includes("icon('flame')"));
ok('tc-emoji class retired in js', !s221.includes('tc-emoji'));
ok('tc-emoji class retired in css', !css.includes('.tc-emoji'));
ok('tc-glyph sizing rule exists in css', /\.tc-glyph \.ticon \{[^}]*width: 30px/.test(css));

const s010 = read('js/010-theming.js');
ok('season nudge no longer reads SHELF_SEASONS icon', !s010.includes('SHELF_SEASONS[season].icon'));
ok('season nudge maps seasons to glyph names', s010.includes('SEASON_NUDGE_ICONS'));

/* ---------------- 3. DNF reasons carry glyph names ---------------- */
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in icon-sweep tests'); };
window.confirm = () => true;
loadApp(window);
const run = (js) => window.eval(js);

const EXPECTED_DNF = [
  ['too_slow', 'Too slow', 'hourglass'],
  ['hated_trope', 'Hated the trope', 'dnf'],
  ['wrong_mood', 'Wrong mood', 'cloud'],
  ['writing_style', 'Writing style', 'pencil'],
  ['characters', "Didn't connect with characters", 'friends'],
  ['too_long', 'Too long', 'ruler'],
];
const dnfActual = run('DNF_REASONS.map(r => [r.key, r.label, r.icon])');
ok('DNF_REASONS: 6 reasons, keys/labels byte-identical, icon = glyph name',
  JSON.stringify(dnfActual) === JSON.stringify(EXPECTED_DNF));
ok('DNF chip render goes through icon()', read('js/213-dnf.js').includes("icon(r.icon)"));
ok('DNF Autopsy header uses icon(search)', read('js/213-dnf.js').includes("icon('search')"));
ok('DNF toast no longer interpolates the icon field', !read('js/213-dnf.js').includes("reason.icon"));

/* -------- behavioural: the season nudge renders an SVG glyph -------- */
run(`Object.keys(SEASON_THEMES).forEach(s => localStorage.removeItem('seasonThemeNudge:' + s));`);
run(`shelfSetSeason('halloween'); localStorage.setItem('theme','dark'); localStorage.removeItem('seasonThemeNudge:halloween');`);
const nudge = run('seasonThemeNudgeHTML()');
ok('season nudge renders an inline SVG glyph', typeof nudge === 'string' && nudge.includes('<svg'));
ok('season nudge carries no emoji', !EMOJI.test(nudge || ''));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
