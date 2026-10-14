// Sticker profile pictures + the Collections / Fitting Room picker
// (v546). Pins: the portrait sticker catalog (js/228 PS_STICKER_SETS) IS
// the avatar registry and matches the shipped cut-webp inventory file
// for file; the namespaced 'stk:<theme>/<stem>' id round-trips through
// js/105's read/write paths (incl. the cloud-row shape) and falls back
// to the letter avatar when bogus; stickers render CONTAIN via the
// shared avatar helpers (own profile/topbar + circAvatarHTML for
// friends) and degrade to the initial if the image fails; NO sticker is
// precached; and the picker is try-on only — tapping never saves, "Use
// this picture" is the single save path, the "nothing saved yet"
// explainer shows only until the first-ever save, stage 1 renders no
// grid, a grid renders only its opened slice, and stage-1 scroll
// survives the trip into a grid and back.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const { loadApp, APP_DIR } = require('./harness');
const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in sticker avatar tests'); };
window.confirm = () => true;

loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const q = (s) => window.document.querySelector(s);
const qa = (s) => Array.from(window.document.querySelectorAll(s));
const runInWindow = (js) => {
  const s = window.document.createElement('script');
  s.textContent = js;
  window.document.body.appendChild(s);
};
const probe = (js) => window.eval(js);
const tick = (n = 1) => new Promise(r => { const f = () => --n <= 0 ? r() : setTimeout(f, 0); setTimeout(f, 0); });
const lsGet = (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } };

(async () => {
  await tick(3);

  /* ---- registry == shipped file inventory ----
     The registry is enumerated through the app's own picker plumbing
     (stickerItemsForTheme → stickerSheetNumbers), not re-derived here,
     so the pin covers the exact lists the app ships. */
  const cat = probe('PS_STICKER_SETS');
  const regPaths = new Set();
  Object.keys(cat).forEach(dir => {
    probe("stickerItemsForTheme('" + dir + "')").forEach(it => { if (it.src) regPaths.add(it.src); });
  });
  ok('the sticker registry enumerates 446 stickers across 23 themes',
    regPaths.size === 446 && Object.keys(cat).length === 23);
  ok('every registry entry exists on disk',
    Array.from(regPaths).every(p => fs.existsSync(path.join(APP_DIR, p))));
  const diskFiles = [];
  const cutRoot = path.join(APP_DIR, 'assets/stickers/cut-webp');
  for (const dir of fs.readdirSync(cutRoot)) {
    for (const f of fs.readdirSync(path.join(cutRoot, dir))) {
      if (f.endsWith('.webp')) diskFiles.push('assets/stickers/cut-webp/' + dir + '/' + f);
    }
  }
  ok('every shipped cut-webp file is registered (no orphans, none missing)',
    diskFiles.length === 446 && diskFiles.every(p => regPaths.has(p)));

  /* ---- id shape: parse / validate / resolve ---- */
  ok('a sticker id parses into theme/sheet/num/stem',
    JSON.stringify(probe("parseStickerAvatarId('stk:velvet/velvet-a-01')")) ===
      '{"theme":"velvet","sheet":"a","num":1,"stem":"velvet-a-01"}');
  ok('an id whose stem theme differs from its directory is rejected',
    probe("parseStickerAvatarId('stk:velvet/stormrider-a-01')") === null);
  ok('a painted catalog id does not parse as a sticker id',
    probe("parseStickerAvatarId('tabby')") === null);
  ok('stickerAvatarValid accepts a registered sticker',
    probe("stickerAvatarValid('stk:velvet/velvet-a-01')") === true);
  ok('stickerAvatarValid rejects an out-of-range number',
    probe("stickerAvatarValid('stk:velvet/velvet-a-99')") === false);
  ok('stickerAvatarValid rejects number 00',
    probe("stickerAvatarValid('stk:velvet/velvet-a-00')") === false);
  ok('stickerAvatarValid rejects an unknown theme',
    probe("stickerAvatarValid('stk:nope/nope-a-01')") === false);
  // Four sheets are numbered non-contiguously on disk (retired numbers):
  // gap numbers must reject, shipped numbers past the naive range must pass.
  ok('gap numbers in irregular sheets reject (briarthrone b-04, midnight b-09, wisp b-04)',
    probe("stickerAvatarValid('stk:briarthrone/briarthrone-b-04')") === false &&
    probe("stickerAvatarValid('stk:midnight/midnight-b-09')") === false &&
    probe("stickerAvatarValid('stk:wisp/wisp-b-04')") === false);
  ok('shipped numbers past the contiguous range validate (briarthrone b-21, light a-14)',
    probe("stickerAvatarValid('stk:briarthrone/briarthrone-b-21')") === true &&
    probe("stickerAvatarValid('stk:light/light-a-14')") === true);
  ok('no painted catalog id validates as a sticker (namespace is collision-proof)',
    probe('DEFAULT_AVATARS.every(a => !stickerAvatarValid(a.id))') === true);
  ok('stickerAvatarSrc resolves the shipped path',
    probe("stickerAvatarSrc('stk:abyss/abyss-b-05')") === 'assets/stickers/cut-webp/abyss/abyss-b-05.webp');
  ok('stickerAvatarSrc is null for a bogus id (letter renders instead)',
    probe("stickerAvatarSrc('stk:velvet/velvet-a-99')") === null);
  ok('themedOrLetterAvatar resolves a sticker id',
    JSON.stringify(probe("themedOrLetterAvatar('stk:velvet/velvet-a-01')")) ===
      '{"type":"sticker","id":"stk:velvet/velvet-a-01"}');
  ok('themedOrLetterAvatar drops a bogus sticker id to the letter',
    JSON.stringify(probe("themedOrLetterAvatar('stk:velvet/velvet-a-99')")) === '{"type":"letter"}');

  /* ---- cloud-row shape (profiles.avatar_id carries the id verbatim) ---- */
  ok('cloudAvatarId writes the namespaced id for a sticker avatar',
    probe("cloudAvatarId({ avatar: { type: 'sticker', id: 'stk:velvet/velvet-a-01' } })") === 'stk:velvet/velvet-a-01');
  ok('cloudAvatarId still writes the catalog id for a painted avatar',
    probe("cloudAvatarId({ avatar: { type: 'default', id: 'tabby' } })") === 'tabby');
  ok('cloudAvatarId writes empty for upload and letter avatars',
    probe("cloudAvatarId({ avatar: { type: 'upload', dataUrl: 'data:x' } })") === '' &&
    probe("cloudAvatarId({ avatar: { type: 'letter' } })") === '');

  /* ---- loadProfile round-trip (sanitize-on-read) ---- */
  window.localStorage.setItem('spicyshelves.profile.offline',
    JSON.stringify({ firstName: 'Ink', avatar: { type: 'sticker', id: 'stk:midnight/midnight-b-01' } }));
  const loaded = probe('loadProfile()');
  ok('loadProfile keeps a synced sticker avatar',
    loaded.avatar.type === 'sticker' && loaded.avatar.id === 'stk:midnight/midnight-b-01');
  window.localStorage.setItem('spicyshelves.profile.offline',
    JSON.stringify({ firstName: 'Ink', avatar: { type: 'sticker', id: 'stk:velvet/velvet-a-99' } }));
  ok('loadProfile drops a bogus sticker id to the initial',
    probe('loadProfile()').avatar.type === 'letter');
  window.localStorage.setItem('spicyshelves.profile.offline',
    JSON.stringify({ firstName: 'Ink', avatar: { type: 'sticker', id: 'stk:midnight/midnight-b-01' } }));

  /* ---- rendering: contain via the shared helpers ---- */
  const own = probe("avatarHTML(loadProfile(), 'pf-avatar')");
  ok('own avatar renders an avatar-stk img with the sticker path',
    own.includes('<img') && own.includes('avatar-stk') &&
    own.includes('assets/stickers/cut-webp/midnight/midnight-b-01.webp'));
  // The topbar shows the profile avatar only when signed in.
  runInWindow('cloudUser = { id: "u1", email: "ink@example.com" };');
  window.localStorage.setItem('spicyshelves.profile.u1',
    JSON.stringify({ firstName: 'Ink', avatar: { type: 'sticker', id: 'stk:midnight/midnight-b-01' } }));
  probe('renderTopbar()');
  ok('topbar renders the sticker avatar',
    !!q('#menu-btn img.avatar-stk') &&
    q('#menu-btn img.avatar-stk').src.includes('assets/stickers/cut-webp/midnight/midnight-b-01.webp'));
  const css = fs.readFileSync(path.join(APP_DIR, 'styles.css'), 'utf8');
  ok('styles.css pins img.avatar-stk to object-fit: contain',
    /img\.avatar-stk\s*\{[^}]*object-fit:\s*contain/.test(css));
  // v548: the Settings account card renders avatarHTML(prof,
  // 'st-avatar-card') — the class MUST carry its own bounded disc rule,
  // or the <img> renders at natural size (full card width).
  const cardRule = /\.st-avatar-card\s*\{([^}]*)\}/.exec(css);
  const cardW = cardRule && /width:\s*(\d+)px/.exec(cardRule[1]);
  const cardH = cardRule && /height:\s*(\d+)px/.exec(cardRule[1]);
  ok('styles.css bounds .st-avatar-card to a disc of at most 96px',
    !!cardRule && !!cardW && !!cardH &&
    +cardW[1] <= 96 && +cardH[1] <= 96 && cardW[1] === cardH[1] &&
    /border-radius:\s*50%/.test(cardRule[1]) && /object-fit:\s*cover/.test(cardRule[1]));
  ok('styles.css gives .st-avatar-card.letter a centred letter treatment',
    /\.st-avatar-card\.letter\s*\{[^}]*justify-content:\s*center/.test(css));
  const friend = probe("circAvatarHTML({ user_id: 'u9', first_name: 'Pal', last_name: '', avatar_id: 'stk:velvet/velvet-a-01' }, 'c-avatar')");
  ok('a friend sticker avatar renders through circAvatarHTML',
    friend.includes('avatar-stk') && friend.includes('assets/stickers/cut-webp/velvet/velvet-a-01.webp'));
  ok('circAvatarHTML still stamps data-cav on the sticker render',
    friend.includes('data-cav="u9"'));
  const friendBogus = probe("circAvatarHTML({ user_id: 'u9', first_name: 'Pal', last_name: '', avatar_id: 'stk:velvet/velvet-a-99' }, 'c-avatar')");
  ok('a friend bogus sticker id degrades to the letter, never a broken img',
    !friendBogus.includes('<img') && friendBogus.includes('letter'));

  /* ---- a failed sticker image degrades to the initial ---- */
  const host = window.document.createElement('div');
  host.innerHTML = probe("avatarHTML(loadProfile(), 'c-avatar')");
  window.document.body.appendChild(host);
  const stkImg = host.querySelector('img.avatar-stk');
  ok('degradation fixture starts as a sticker img', !!stkImg);
  stkImg.dispatchEvent(new window.Event('error'));
  ok('a failed sticker image swaps to the letter span with the profile initial',
    !host.querySelector('img') && !!host.querySelector('span.letter') &&
    host.querySelector('span.letter').textContent === 'I');
  host.remove();

  /* ---- no mass precache; picker module wired + precached ---- */
  const sw = fs.readFileSync(path.join(APP_DIR, 'sw.js'), 'utf8');
  const precacheLines = sw.split('\n')
    .filter(l => /^const (JS|AVATARS|VENDOR|THEME_ART|ASSETS)/.test(l)).join('\n');
  ok('no sticker file appears in any sw.js precache list',
    !precacheLines.includes('cut-webp') && !precacheLines.includes('stickers/'));
  ok('sw.js precaches the picker module itself',
    sw.includes("'236-sticker-picker.js'"));
  ok('index.html loads the picker module',
    html.includes('<script src="js/236-sticker-picker.js"></script>'));

  /* ---- motif index integrity ---- */
  ok('every motif pick resolves against the registry',
    probe('STICKER_MOTIFS.every(m => pickerMotifItems(m).length === m.items.length)') === true);
  ok('the Cats motif grid is the curated 12',
    JSON.stringify(probe("pickerMotifItems(STICKER_MOTIFS.find(m => m.key === 'cat')).map(c => c.id)")) ===
      JSON.stringify(['stk:stormrider/stormrider-a-02', 'stk:stormrider/stormrider-b-03',
        'stk:velvet/velvet-a-01', 'stk:velvet/velvet-b-03', 'stk:briarthrone/briarthrone-a-02',
        'stk:briarthrone/briarthrone-b-03', 'stk:midnight/midnight-a-02', 'stk:midnight/midnight-b-01',
        'stk:abyss/abyss-a-01', 'stk:abyss/abyss-b-01', 'stk:voidsignal/voidsignal-a-02',
        'stk:voidsignal/voidsignal-b-02']));

  /* ---- the picker: try-on only, single save path ---- */
  window.localStorage.removeItem('spicyshelves.profile.offline');
  runInWindow('cloudUser = { id: "u1", email: "ink@example.com" };');
  window.localStorage.setItem('spicyshelves.profile.u1',
    JSON.stringify({ firstName: 'Ink', lastName: '', avatar: { type: 'letter' } }));
  window.localStorage.removeItem('spicyshelves.avatarPicker.saved');
  probe('renderTopbar()');
  q('#menu-btn').click(); await tick();
  q('#menu-pop [data-m="profile"]').click(); await tick();
  q('#pf-change').click(); await tick();

  ok('the picker sheet opens', !!q('#avatar-picker'));
  ok('stage 1 renders NO grid tiles (compactness: cards + strip only)',
    qa('#avatar-picker .apk-tile').length === 0);
  ok('stage 1 image count stays in the teens (heroes + motif icons, never the 468)',
    qa('#avatar-picker img').length > 0 && qa('#avatar-picker img').length <= 20);
  ok('stage 1 shows the motif strip (6), 3 painted cards, 6 featured themes + the A–Z card',
    qa('#apk-stage1 [data-apk-motif]').length === 6 &&
    qa('#apk-stage1 [data-apk-col]').length === 9 && !!q('#apk-stage1 [data-apk-allthemes]'));
  ok('the current avatar is anchored in the header (now-bar)',
    q('#apk-sub').textContent === 'Currently: Your initial' &&
    !!q('#apk-cur .apk-disc.letter'));

  // Stage-1 scroll must survive the trip into a grid and back.
  q('#apk-sheet').scrollTop = 120;
  q('#apk-stage1 [data-apk-motif="cat"]').click(); await tick();
  ok('the Cats motif grid renders exactly its 12 stickers',
    qa('#apk-stage2 .apk-tile').length === 12);
  ok('every motif tile is a registered sticker path',
    qa('#apk-stage2 .apk-tile img').every(im => regPaths.has(new URL(im.src).pathname.replace(/^\//, ''))));
  q('#apk-back').click(); await tick();
  ok('back returns to stage 1 with its scroll position restored',
    q('#apk-stage1').style.display !== 'none' && q('#apk-sheet').scrollTop === 120);

  // Try-on: tap ≠ save; the explainer shows pre-first-save.
  q('#apk-stage1 [data-apk-col="stickers:velvet"]').click(); await tick();
  ok('a theme grid renders only its own slice (Velvet = 24)',
    qa('#apk-stage2 .apk-tile').length === 24);
  const beforeTry = lsGet('spicyshelves.profile.u1');
  qa('#apk-stage2 .apk-tile')[0].click(); await tick();
  ok('tapping a sticker opens the fitting room and saves nothing',
    q('#apk-fitting').classList.contains('open') && lsGet('spicyshelves.profile.u1') === beforeTry);
  ok('the fitting room previews at the real sizes (big disc + top bar + circle)',
    q('#apk-fit-big img').src.includes('assets/stickers/cut-webp/velvet/velvet-a-01.webp') &&
    !!q('#apk-sz1 img') && !!q('#apk-sz2 img'));
  ok('the "nothing saved yet" explainer shows before the first-ever save',
    q('#apk-fit-sub').textContent === 'Trying it on — nothing saved yet');
  q('#apk-keep').click(); await tick();
  ok('"Keep looking" closes the fitting room and still saves nothing',
    !q('#apk-fitting').classList.contains('open') && lsGet('spicyshelves.profile.u1') === beforeTry);

  // Save: "Use this picture" is the only save action.
  qa('#apk-stage2 .apk-tile')[0].click(); await tick();
  q('#apk-use').click(); await tick();
  const saved = JSON.parse(lsGet('spicyshelves.profile.u1'));
  ok('"Use this picture" saves the sticker avatar with its namespaced id',
    saved.avatar.type === 'sticker' && saved.avatar.id === 'stk:velvet/velvet-a-01');
  ok('the first save persists the explainer-off flag',
    lsGet('spicyshelves.avatarPicker.saved') === '1');
  ok('the saved tile is marked selected and the now-bar follows',
    qa('#apk-stage2 .apk-tile')[0].classList.contains('sel') &&
    q('#apk-sub').textContent === 'Currently: Cat on Books');
  ok('the topbar now renders the sticker',
    !!q('#menu-btn img.avatar-stk') &&
    q('#menu-btn img.avatar-stk').src.includes('assets/stickers/cut-webp/velvet/velvet-a-01.webp'));
  qa('#apk-stage2 .apk-tile')[1].click(); await tick();
  ok('after the first save the explainer never shows again',
    q('#apk-fit-sub').textContent === 'Velvet · Stickers');
  q('#apk-keep').click(); await tick();

  // Painted avatars go through the same fitting room.
  q('#apk-back').click(); await tick();
  q('#apk-stage1 [data-apk-col="painted:stormrider"]').click(); await tick();
  qa('#apk-stage2 .apk-tile').find(t => t.getAttribute('title') === "Rider's Tabby").click(); await tick();
  q('#apk-use').click(); await tick();
  const savedPainted = JSON.parse(lsGet('spicyshelves.profile.u1'));
  ok('a painted avatar saves through the fitting room as a default avatar',
    savedPainted.avatar.type === 'default' && savedPainted.avatar.id === 'tabby');

  // All themes A–Z is a real list, and rows drill into theme grids.
  q('#apk-back').click(); await tick();
  q('#apk-stage1 [data-apk-allthemes]').click(); await tick();
  ok('the A–Z view lists all 23 themes', qa('#apk-stage2 .apk-trow').length === 23);
  qa('#apk-stage2 .apk-trow').find(r => r.dataset.apkTheme === 'velvet').click(); await tick();
  ok('a theme row opens that theme grid (24 tiles)',
    qa('#apk-stage2 .apk-tile').length === 24 &&
    q('#apk-title').textContent === 'Velvet — Stickers');

  // Yours: the initial is a first-class fitting-room candidate.
  q('#apk-back').click(); await tick();
  q('#apk-stage1 [data-apk-yours]').click(); await tick();
  q('#apk-letter-tile').click(); await tick();
  ok('trying on the initial opens the fitting room',
    q('#apk-fitting').classList.contains('open') &&
    q('#apk-fit-name').textContent === 'Your initial');
  q('#apk-use').click(); await tick();
  ok('saving the initial clears the avatar to the letter',
    JSON.parse(lsGet('spicyshelves.profile.u1')).avatar.type === 'letter');
  q('#apk-close').click(); await tick();
  ok('the sheet closes cleanly', !q('#avatar-picker'));

  console.log(`\nsticker-avatars: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
