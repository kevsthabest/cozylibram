// Icon-slot emoji sweep (Decision): UI icon slots render the line-art
// set (ICONS + icon() in js/050-helpers.js — inherits currentColor, so
// icons theme automatically) instead of raw emoji, which do not theme.
// This suite is the regression pin:
//   1. SCAN — app js files may contain NO pictographic emoji outside
//      the explicit ALLOW list below. The list enumerates the surviving
//      CONTENT occurrences (canvas share-card text, prose, toasts,
//      decor/milestone systems — categories ruled "content, not
//      icons") by file + context key. Both directions are checked: an
//      emoji line no entry covers fails, and an entry that no longer
//      matches any emoji line fails too (stale entries must be removed
//      with their emoji).
//   2. SLOTS — each swept slot positively renders its house glyph, and
//      every icon('name') referenced resolves to a real ICONS key (the
//      v535 failure mode: icon() silently falls back to 'covers').
//   3. DNF — DNF_REASONS keeps its 6 keys/labels byte-identical while
//      its icon field now holds ICONS names, rendered via icon().
//
// History: v561 swept 9 named files and pinned ONLY those files. A
// survivor in an unscanned file (the Reader Portrait share button in
// js/212) proved the blind spot, so the follow-up extends the scan to
// EVERY app js file (the same top-level js/*.js set the app loads;
// js/vendor/** is vendored code, not app source, and is excluded).
// The extension surfaced four more icon slots, also swept: the shelf
// undo button (js/205, the lone emoji among icon() siblings), the
// shelfie menu fallback (js/217), the duplicates heading (js/199,
// ⚠ U+26A0 — the pictograph set below now names it, with ✅ U+2705
// and ⛄ U+26C4), and the update banner / survey send button covered
// in SLOTS.
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
const EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u2604\u2618\u263A-\u265F\u2668\u2705\u2728\u26A0\u26C4\u2B00-\u2BFF\uFE0F]/u;

// Every app js file (top-level js/*.js — the set index.html loads).
// js/vendor/** is a subdirectory, so it never appears here.
const ALL_FILES = fs.readdirSync(path.join(APP_DIR, 'js'))
  .filter(f => f.endsWith('.js'))
  .map(f => 'js/' + f)
  .sort();

// Surviving CONTENT occurrences. `key` is a substring of the source line
// carrying the emoji; `why` is the one-line justification (standing rule).
const TOAST = 'toast copy — ephemeral content, not an icon slot (leave-alone category)';
const SAY = 'announcer (say) copy — ephemeral content, not an icon slot (leave-alone category)';
const CANVAS = 'canvas share-card text (branding-settled)';
const SHARETEXT = 'plain-text share summary — branding-settled share content, not an icon slot';
const PROSE = 'prose/stat text — content, not an icon slot (leave-alone category)';
const NOTE_PROSE = 'empty-state note prose, not an icon slot';
const DECOR = 'shelf decor system (ornaments + season data) — the emoji are the content (leave-alone category)';
const MILESTONE = 'milestone icon map — the emoji are the badge content (leave-alone category)';
const COMMENT = 'code comment — never rendered';
const LEGEND = 'curation source legend — the colour fill is the signal; always paired with a text label';
const ALLOW = [
  // js/030 — comment explaining emoji-font rendering; never rendered.
  { file: 'js/030-storefront.js', key: '(notably ⚔️)', why: COMMENT },
  // js/070 — toasts only.
  { file: 'js/070-hardcover.js', key: "toast('✨ Auto-enriched", why: TOAST },
  { file: 'js/070-hardcover.js', key: "toast('Added to To Be Read", why: TOAST },
  { file: 'js/070-hardcover.js', key: "toast('📄 Found page count:", why: TOAST },
  { file: 'js/070-hardcover.js', key: "toast('✨ Enriched from Hardcover", why: TOAST },
  // js/080 — say() announcer only.
  { file: 'js/080-pagecount.js', key: "say('All books already have page counts", why: SAY },
  { file: 'js/080-pagecount.js', key: "say('📄 Found '", why: SAY },
  // js/090 — toasts only.
  { file: 'js/090-sync.js', key: '☁️ Library updated', why: TOAST },
  // (the 🧹 "Removed friend books" toast entry was removed with the
  // depollute repair it justified — named movement, retire-depollute PR)
  { file: 'js/090-sync.js', key: "toast('☁️ Account created", why: TOAST },
  // js/095 / js/105 / js/130 / js/155 — toasts only.
  { file: 'js/095-gate.js', key: "toast('Password updated", why: TOAST },
  { file: 'js/105-account.js', key: "toast('Profile saved", why: TOAST },
  { file: 'js/130-add.js', key: "toast(n ? 'Added '", why: TOAST },
  { file: 'js/155-authors.js', key: "toast('Added to wishlist", why: TOAST },
  // js/136 — a comment naming the modal cover button + one toast.
  { file: 'js/136-coverpicker.js', key: 'The 🖼️ button', why: COMMENT },
  { file: 'js/136-coverpicker.js', key: "toast('🖼️ Cover updated'", why: TOAST },
  // js/138 — toast (its 📚 is written as a \u escape; the literal ✨ is here).
  { file: 'js/138-editions.js', key: 'Edition updated ✨', why: TOAST },
  // js/139 — report-hero note prose.
  { file: 'js/139-import-concierge.js', key: 'Every book arrived dressed', why: NOTE_PROSE },
  // js/150 — toasts only; the one icon slot (Wishlist note) is swept.
  { file: 'js/150-modal-discovery.js', key: "toast('Added to wishlist", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast(s === 'reading'", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('Marked owned", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('Note saved", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('Type the quote first", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "'Pinned to favorites", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('📄 Found:", why: TOAST },
  { file: 'js/150-modal-discovery.js', key: "toast('Today", why: TOAST }, // 'Today’s entry removed 🗑️'
  // v589: the "toast('Saved ✨')" entry retired with the toast itself —
  // Variant B autosave shows the header status text instead of a toast.
  // js/160 — toasts only; the trope-badge slot is swept.
  { file: 'js/160-roulette.js', key: "toast('No matching books", why: TOAST },
  { file: 'js/160-roulette.js', key: "toast('Happy reading!", why: TOAST },
  // js/170 — Chronicles prose/stat text, canvas share-card text, the
  // plain-text share summary, comments, toasts. No icon slots (the
  // stat cards already lead with icon() glyphs).
  { file: 'js/170-stats.js', key: 'You tend to reach for', why: PROSE }, // 🌶️ observation sentence
  { file: 'js/170-stats.js', key: 'Your shelf runs medium-spice', why: PROSE },
  { file: 'js/170-stats.js', key: 'You keep things fairly low-key', why: PROSE },
  { file: 'js/170-stats.js', key: 'dist-row', why: PROSE }, // '5 ⭐' distribution label
  { file: 'js/170-stats.js', key: 'A generous rater', why: PROSE },
  { file: 'js/170-stats.js', key: 'A tough critic', why: PROSE },
  { file: 'js/170-stats.js', key: 'Your average rating:', why: PROSE },
  { file: 'js/170-stats.js', key: '0.15 gap renders as', why: COMMENT },
  { file: 'js/170-stats.js', key: '⭐ higher than', why: PROSE },
  { file: 'js/170-stats.js', key: 'over the last 6 months', why: PROSE },
  { file: 'js/170-stats.js', key: "'🔥 ' + d.streak", why: PROSE }, // stat value text ('day streak')
  { file: 'js/170-stats.js', key: "let sl = '📚 '", why: CANVAS },
  { file: 'js/170-stats.js', key: "bits.push('🌶️'.repeat", why: CANVAS },
  { file: 'js/170-stats.js', key: "fillText('📘 '", why: CANVAS },
  { file: 'js/170-stats.js', key: "fillText('✅ Finished'", why: CANVAS },
  { file: 'js/170-stats.js', key: '// 🎁 line on the share card', why: COMMENT },
  { file: 'js/170-stats.js', key: "fillText('🎁 On my wishlist'", why: CANVAS },
  { file: 'js/170-stats.js', key: "fillText('📖 On my TBR'", why: CANVAS },
  { file: 'js/170-stats.js', key: "fillText('🚫 DNF'", why: CANVAS },
  { file: 'js/170-stats.js', key: "toast('Image saved", why: TOAST },
  { file: 'js/170-stats.js', key: "toast('Making your card…", why: TOAST },
  { file: 'js/170-stats.js', key: "'✨ My ' + d.yr", why: SHARETEXT },
  { file: 'js/170-stats.js', key: "'📚 ' + d.n + ' books", why: SHARETEXT },
  { file: 'js/170-stats.js', key: 'Longest streak:', why: SHARETEXT },
  { file: 'js/170-stats.js', key: "toast('Summary copied", why: TOAST },
  // js/180 — toasts only; the Wisp variant buttons are swept.
  { file: 'js/180-settings.js', key: "toast('Accent updated", why: TOAST },
  { file: 'js/180-settings.js', key: "btn.dataset.t === 'on'", why: TOAST }, // 👁️/🙈 visibility toast
  { file: 'js/180-settings.js', key: "toast('Store region:", why: TOAST },
  { file: 'js/180-settings.js', key: "toast('Shelf view:", why: TOAST },
  { file: 'js/180-settings.js', key: "toast('Backup downloaded", why: TOAST },
  { file: 'js/180-settings.js', key: "toast('Cached '", why: TOAST },
  { file: 'js/180-settings.js', key: "toast('🗑️ Cached covers cleared", why: TOAST },
  // js/198 — ✨ lives in empty-state NOTE PROSE (ruled prose, leave).
  { file: 'js/198-discovery.js', key: 'No new releases found', why: NOTE_PROSE },
  { file: 'js/198-discovery.js', key: 'All caught up ✨', why: NOTE_PROSE },
  // js/162 — curation source legend dots (colour is the signal).
  { file: 'js/162-charlab.js', key: 'title="Reader suggestion"', why: LEGEND },
  { file: 'js/162-charlab.js', key: 'title="Pipeline suggestion"', why: LEGEND },
  // js/205 — the decor system itself: ornament html + season icon data.
  { file: 'js/205-shelfview.js', key: 'title="Pumpkin"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Ghost"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Bat"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Christmas tree"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Snowman"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Stocking"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Fireworks"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Champagne"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Party popper"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Rose"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Hearts"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Love letter"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Shamrock"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Rainbow"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Four-leaf clover"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Bunny"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Easter egg"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Chick"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Turkey"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Pumpkin pie"', why: DECOR },
  { file: 'js/205-shelfview.js', key: 'title="Autumn leaves"', why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '📚'", why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '🎆'", why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '💕'", why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '☘️'", why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '🐰'", why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '🦃'", why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '🎃'", why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '🎄'", why: DECOR },
  { file: 'js/205-shelfview.js', key: "icon: '☀️'", why: DECOR },
  // js/212 — one toast. The share BUTTON is swept (see SLOTS).
  { file: 'js/212-dna.js', key: "toast('Read some books first!", why: TOAST },
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
  // js/220 — the milestone icon map (badge content) + toasts.
  { file: 'js/220-share-moments.js', key: "sprout: '🌱'", why: MILESTONE },
  { file: 'js/220-share-moments.js', key: "flame: '🔥'", why: MILESTONE },
  { file: 'js/220-share-moments.js', key: "heart: '💛'", why: MILESTONE },
  { file: 'js/220-share-moments.js', key: "flask: '⚗️'", why: MILESTONE },
  { file: 'js/220-share-moments.js', key: 'MILESTONE_ICON_EMOJI[iconName]', why: MILESTONE },
  { file: 'js/220-share-moments.js', key: "toast('Making your card…", why: TOAST },
  { file: 'js/220-share-moments.js', key: "toast('Open the 3D shelf first", why: TOAST },
  { file: 'js/220-share-moments.js', key: "toast('Snapping your shelfie…", why: TOAST },
  // js/221 — 🤎 closes a prose note; the candle icon slot is swept.
  { file: 'js/221-trigger-check.js', key: 'Take it at your own pace. 🤎', why: 'prose note text, not an icon slot' },
  // js/226 — 🎉 is the survey title (prose, leave); the send BUTTON is
  // swept (see SLOTS); one toast.
  { file: 'js/226-dna-survey.js', key: 'You finished it!', why: PROSE },
  { file: 'js/226-dna-survey.js', key: "'Thank you 🤎'", why: TOAST },
  // js/227 / js/228 / js/236 — toasts only.
  { file: 'js/227-reading-nudges.js', key: "toast(sent ? 'Thank you 🤎'", why: TOAST },
  { file: 'js/228-portrait-share.js', key: "toast('Read some books first!", why: TOAST },
  { file: 'js/236-sticker-picker.js', key: "cand.kind === 'upload'", why: TOAST },
  { file: 'js/236-sticker-picker.js', key: "cand.kind === 'letter'", why: TOAST },
  // js/239 (The Finale) — the share-flow toast mirrors js/220's identical
  // string; the card's ★/☆ arc and ✦ medallion are typographic (outside
  // the pictograph set by design).
  { file: 'js/239-finale.js', key: "toast('Making your card…", why: TOAST },
];

const emojiLines = {}; // file -> [{n, line}]
for (const f of ALL_FILES) {
  emojiLines[f] = read(f).split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => EMOJI.test(line));
}
for (const f of ALL_FILES) {
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
ok("ICONS gained an 'undo' glyph", iconKeys.has('undo'));
for (const need of ['sun', 'moon', 'gift', 'pepper', 'sparkles', 'flame', 'search',
                    'hourglass', 'dnf', 'cloud', 'pencil', 'friends', 'ruler', 'heart',
                    'covers', 'ghost', 'portrait', 'warn', 'camera', 'undo']) {
  ok("ICONS has '" + need + "' (sweep mapping target)", iconKeys.has(need));
}
// Every icon('name') referenced by ANY app file must resolve.
for (const f of ALL_FILES) {
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

/* ---- follow-up slots (surfaced by the app-wide scan) ---- */
const s212 = read('js/212-dna.js');
const dnaShareLine = s212.split('\n').find(l => l.includes('id="dna-share-btn"')) || '';
ok('portrait share button uses icon(portrait)', dnaShareLine.includes("icon('portrait')"));

const s181 = read('js/181-appversion.js');
const bannerLine = s181.split('\n').find(l => l.includes('A new version is available')) || '';
ok('update banner uses icon(sparkles)', bannerLine.includes("icon('sparkles')"));

const s226 = read('js/226-dna-survey.js');
const sendLine = s226.split('\n').find(l => l.includes('id="svSend"')) || '';
ok('survey send button uses icon(heart)', sendLine.includes("icon('heart')"));

const s205 = read('js/205-shelfview.js');
const undoLine = s205.split('\n').find(l => l.includes('id="svUndoDecor"')) || '';
ok('shelf undo button uses icon(undo)', undoLine.includes("icon('undo')"));

const s217 = read('js/217-shelf3d-view.js');
const shelfieLine = s217.split('\n').find(l => l.includes('id="svMenuShelfie"')) || '';
ok('shelfie menu item uses icon(camera)', shelfieLine.includes("icon('camera')"));

const s162 = read('js/162-charlab.js');
const dupesLine = s162.split('\n').find(l => l.includes('Possible duplicates')) || '';
ok('duplicates heading uses icon(warn)', dupesLine.includes("icon('warn')"));

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
