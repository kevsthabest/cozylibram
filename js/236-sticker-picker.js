'use strict';

/* ---------------- profile picture picker (v546) ----------------
   Three layers, kept separate on purpose (the User may swap the skin
   for the Variant C dropdown later — that must be a presentation
   change, not a rebuild):
   1. DATA — what can be picked: the painted sets (js/105), the sticker
      registry (js/228's PS_STICKER_SETS catalog, reached through
      js/105's resolver), the motif index, display names.
   2. PLUMBING — candidates and the single save path. A candidate is
      { kind:'painted'|'sticker'|'upload'|'letter', id?, dataUrl?,
      name, sub, src?, letter? }. Trying a candidate saves NOTHING;
      only applyAvatarCandidate() writes.
   3. SKIN — Variant B "Collections + Fitting Room" (design of record:
      prototypes/picker-variant-b-fitting-room-2026-10-14.html).
   --------------------------------------------------------------- */

/* ================= 1. DATA ================= */

const STICKER_THEME_NAMES = {
  abyss: 'Abyss', amour: 'Amour', briarthrone: 'Briarthrone', candlelight: 'Candlelight',
  dark: 'Dark', fete: 'Fête', frost: 'Frost', harvest: 'Harvest', haunt: 'Haunt',
  hearthside: 'Hearthside', light: 'Light', midnight: 'Midnight', pastel: 'Pastel',
  shamrock: 'Shamrock', solstice: 'Solstice', stormrider: 'Stormrider', twilight: 'Twilight',
  velvet: 'Velvet', verdant: 'Verdant', voidsignal: 'Voidsignal', wisp: 'Wisp',
  wispnight: 'Wisp Night', yuletide: 'Yuletide'
};
function stickerThemeName(dir) { return STICKER_THEME_NAMES[dir] || dir; }

/* Sticker themes from the catalog: [{ key (dir), name, count, hero }]. */
function stickerThemes() {
  const cat = stickerCatalog();
  if (!cat) return [];
  return Object.keys(cat).map(dir => {
    const counts = cat[dir];
    const total = (counts[0] || 0) + (counts[1] || 0);
    return {
      key: dir, name: stickerThemeName(dir), count: total,
      hero: stickerAvatarPath({ theme: dir, stem: dir + '-a-01' })
    };
  }).filter(t => t.count > 0);
}
/* Issue #214: picker-sized derivative of a painted avatar. The catalog
   originals are 1600x1600 (2,246 KB across 22 files) but grid tiles
   render <=84px and collection heroes 52px, so picker chrome paints
   the 256px thumbs from img/avatars/thumb/ (scripts/avatar-thumbs.py;
   runtime-cached by sw.js, never precached). Candidates keep
   .src = the original: the fitting room and every applied render
   evaluate the real file. */
function avatarThumbSrc(src) {
  return typeof src === 'string' && src.indexOf('img/avatars/avatar-') === 0
    ? src.replace('img/avatars/', 'img/avatars/thumb/') : src;
}
function stickerIdFor(dir, sheet, num) {
  return STICKER_AVATAR_PREFIX + dir + '/' + dir + '-' + sheet + '-' + String(num).padStart(2, '0');
}
function stickerItemsForTheme(dir) {
  const cat = stickerCatalog();
  if (!cat || !cat[dir]) return [];
  const out = [];
  ['a', 'b'].forEach(sheet => {
    stickerSheetNumbers(dir, sheet).forEach(i => {
      const id = stickerIdFor(dir, sheet, i);
      out.push({ id: id, src: stickerAvatarSrc(id), name: stickerDisplayName(dir, sheet, i) });
    });
  });
  return out;
}

/* Display names for the stickers the Designer verified against the
   contact sheets (prototype data, sheet A of the six sampled themes +
   the motif picks). Everything else falls back to a positional label —
   names are cosmetic; registry completeness is what matters. */
const STICKER_NAMES = {
  'velvet-a-01': 'Cat on Books', 'velvet-a-02': 'Crescent Moon', 'velvet-a-03': 'Baby Dragon',
  'velvet-a-04': 'Candle', 'velvet-a-05': 'Open Book', 'velvet-a-06': 'Potion',
  'velvet-a-07': 'Teacup', 'velvet-a-08': 'Book Stack', 'velvet-a-09': 'Crystal Ball',
  'velvet-a-10': 'Witch Hat', 'velvet-a-11': 'Arched Window', 'velvet-a-12': 'Quill & Ink',
  'velvet-b-01': 'Candles & Book', 'velvet-b-03': 'Sleeping Cat', 'velvet-b-04': 'Sleepy Moon',
  'velvet-b-06': 'Spilt Potion', 'velvet-b-07': 'Teacup Dragon', 'velvet-b-08': 'Book Stack',
  'stormrider-a-01': 'Black Dragon', 'stormrider-a-02': 'Rider Tabby', 'stormrider-a-03': 'Gold Dragon',
  'stormrider-a-04': 'Dragon Egg', 'stormrider-a-05': 'Crossed Daggers', 'stormrider-a-06': 'Moon Dragon',
  'stormrider-a-07': 'Dragon Book', 'stormrider-a-08': 'Potion Dragon', 'stormrider-a-09': 'Book Stack',
  'stormrider-a-10': 'Flight Leathers', 'stormrider-a-11': 'Snow Globe', 'stormrider-a-12': 'Parapet',
  'stormrider-b-02': 'Sleeping Dragon', 'stormrider-b-03': 'Tabby & Backpack',
  'stormrider-b-08': 'Scale Book', 'stormrider-b-10': 'Two Readers',
  'briarthrone-a-01': 'Rose Dragon', 'briarthrone-a-02': 'Crowned Cat', 'briarthrone-a-03': 'Mountain Moon',
  'briarthrone-a-04': 'Candle & Wine', 'briarthrone-a-05': 'Star Potion', 'briarthrone-a-06': 'Teacup',
  'briarthrone-a-07': 'Thorn Books', 'briarthrone-a-08': 'Petal Book', 'briarthrone-a-09': 'Paint Palette',
  'briarthrone-a-10': 'Bow & Book', 'briarthrone-a-11': 'City Globe', 'briarthrone-a-12': 'Quill & Ink',
  'briarthrone-b-01': 'Moon Book', 'briarthrone-b-03': 'Winged Cat', 'briarthrone-b-10': 'Book Stack',
  'midnight-a-01': 'Dragon', 'midnight-a-02': 'Cat on Books', 'midnight-a-03': 'Crescent Moon',
  'midnight-a-04': 'Candle', 'midnight-a-05': 'Constellation Book', 'midnight-a-06': 'Moon Potion',
  'midnight-a-07': 'Teacup', 'midnight-a-08': 'Book Stack', 'midnight-a-09': 'Telescope',
  'midnight-a-10': 'Owl Reader', 'midnight-a-11': 'Galaxy Ball', 'midnight-a-12': 'Quill & Ink',
  'midnight-b-01': 'Wizard Cat', 'midnight-b-02': 'Moon Dragon', 'midnight-b-04': 'Book Arch',
  'abyss-a-01': 'Cat on Books', 'abyss-a-02': 'Sea Dragon', 'abyss-a-03': 'Moon Wave',
  'abyss-a-04': 'Candle Jar', 'abyss-a-05': 'Bubble Book', 'abyss-a-06': 'Potion',
  'abyss-a-07': 'Teacup', 'abyss-a-08': 'Book Stack', 'abyss-a-09': 'Jellyfish Book',
  'abyss-a-10': 'Shell Book', 'abyss-a-11': 'Aquarium Globe', 'abyss-a-12': 'Quill & Ink',
  'abyss-b-01': 'Diver Cat', 'abyss-b-02': 'Moon Boat', 'abyss-b-04': 'Shell Dragon',
  'abyss-b-05': 'Coral Books',
  'voidsignal-a-01': 'Network Dragon', 'voidsignal-a-02': 'Circuit Cat', 'voidsignal-a-03': 'Network Moon',
  'voidsignal-a-04': 'Network Map', 'voidsignal-a-05': 'AR Glasses', 'voidsignal-a-06': 'Network Book',
  'voidsignal-a-07': 'Circuit Potion', 'voidsignal-a-08': 'Circuit Mug', 'voidsignal-a-09': 'Signal Stack',
  'voidsignal-a-10': 'Chess Knight', 'voidsignal-a-11': 'Cornfield Screen', 'voidsignal-a-12': 'Network Ball',
  'voidsignal-b-02': 'Dome Cat', 'voidsignal-b-03': 'Signal Moon'
};
function stickerDisplayName(dir, sheet, num) {
  const stem = dir + '-' + sheet + '-' + String(num).padStart(2, '0');
  return STICKER_NAMES[stem] ||
    (stickerThemeName(dir) + ' · ' + sheet.toUpperCase() + '-' + String(num).padStart(2, '0'));
}

/* Motif index — cross-theme grids (the prototype's verified picks;
   every id is pinned against the registry by the sticker-avatars
   suite). Items are 'dir/stem' pairs, namespaced at build time. */
const STICKER_MOTIFS = [
  { key: 'cat', label: 'Cats', items: ['stormrider/stormrider-a-02', 'stormrider/stormrider-b-03', 'velvet/velvet-a-01', 'velvet/velvet-b-03', 'briarthrone/briarthrone-a-02', 'briarthrone/briarthrone-b-03', 'midnight/midnight-a-02', 'midnight/midnight-b-01', 'abyss/abyss-a-01', 'abyss/abyss-b-01', 'voidsignal/voidsignal-a-02', 'voidsignal/voidsignal-b-02'] },
  { key: 'dragon', label: 'Dragons', items: ['stormrider/stormrider-a-01', 'stormrider/stormrider-a-03', 'stormrider/stormrider-b-02', 'stormrider/stormrider-b-10', 'velvet/velvet-a-03', 'velvet/velvet-b-07', 'midnight/midnight-a-01', 'midnight/midnight-b-02', 'briarthrone/briarthrone-a-01', 'voidsignal/voidsignal-a-01', 'abyss/abyss-a-02', 'abyss/abyss-b-04'] },
  { key: 'moon', label: 'Moons', items: ['velvet/velvet-a-02', 'velvet/velvet-b-04', 'stormrider/stormrider-a-06', 'midnight/midnight-a-03', 'abyss/abyss-a-03', 'abyss/abyss-b-02', 'briarthrone/briarthrone-b-01', 'voidsignal/voidsignal-a-03', 'voidsignal/voidsignal-b-03'] },
  { key: 'book', label: 'Books', items: ['velvet/velvet-a-05', 'velvet/velvet-b-08', 'stormrider/stormrider-a-09', 'briarthrone/briarthrone-b-10', 'midnight/midnight-b-04', 'abyss/abyss-b-05', 'voidsignal/voidsignal-a-06', 'stormrider/stormrider-b-08'] },
  { key: 'potion', label: 'Potions', items: ['velvet/velvet-a-06', 'velvet/velvet-b-06', 'stormrider/stormrider-a-08', 'midnight/midnight-a-06', 'abyss/abyss-a-06', 'briarthrone/briarthrone-a-05', 'voidsignal/voidsignal-a-07'] },
  { key: 'candle', label: 'Candles', items: ['velvet/velvet-a-04', 'velvet/velvet-b-01', 'midnight/midnight-a-04', 'abyss/abyss-a-04', 'briarthrone/briarthrone-a-04'] }
];
function stickerCandidateFromId(id) {
  const parts = parseStickerAvatarId(id);
  const src = stickerAvatarSrc(id);
  if (!parts || !src) return null;
  return {
    kind: 'sticker', id: id, src: src,
    name: stickerDisplayName(parts.theme, parts.sheet, parts.num),
    sub: stickerThemeName(parts.theme) + ' · Stickers'
  };
}
function pickerMotifItems(motif) {
  return motif.items.map(s => stickerCandidateFromId(STICKER_AVATAR_PREFIX + s)).filter(Boolean);
}
function pickerMotifIcon(motif) {
  const first = pickerMotifItems(motif)[0];
  return first ? first.src : '';
}

/* Collections model shared by any skin: painted sets in AVATAR_SETS
   order, then sticker themes A–Z. Sticker items resolve lazily (a
   collection's grid is built only when the collection opens). */
function pickerCollections() {
  const cols = [];
  AVATAR_SETS.forEach(s => {
    const items = DEFAULT_AVATARS.filter(a => a.set === s.key).map(a => ({
      kind: 'painted', id: a.id, name: a.label, sub: s.name, src: a.src, thumb: avatarThumbSrc(a.src)
    }));
    cols.push({ key: 'painted:' + s.key, title: s.name, kind: 'painted', hero: items.length ? (items[0].thumb || items[0].src) : '', count: items.length, items: items });
  });
  stickerThemes().forEach(t => {
    cols.push({ key: 'stickers:' + t.key, title: t.name, kind: 'sticker', hero: t.hero, count: t.count, theme: t.key });
  });
  return cols;
}
function pickerCollectionItems(col) {
  if (col.kind === 'painted') return col.items || [];
  return stickerItemsForTheme(col.theme).map(it => ({
    kind: 'sticker', id: it.id, name: it.name, sub: col.title + ' · Stickers', src: it.src
  }));
}

/* ================= 2. PLUMBING ================= */

const AVATAR_PICKER_SAVED_KEY = 'spicyshelves.avatarPicker.saved';
function avatarPickerHasSaved() {
  try { return !!localStorage.getItem(AVATAR_PICKER_SAVED_KEY); }
  catch (e) { return true; } // storage unavailable: never nag
}
function markAvatarPickerSaved() {
  try { localStorage.setItem(AVATAR_PICKER_SAVED_KEY, '1'); } catch (e) {}
}
function avatarSetName(setKey) {
  const s = AVATAR_SETS.find(x => x.key === setKey);
  return s ? s.name : '';
}
/* The profile's current avatar as a candidate (for the now-bar). */
function candidateForAvatar(av, p) {
  if (av && av.type === 'default') {
    const a = DEFAULT_AVATARS.find(x => x.id === av.id);
    if (a) return { kind: 'painted', id: a.id, name: a.label, sub: avatarSetName(a.set), src: a.src };
  }
  if (av && av.type === 'sticker') {
    const c = stickerCandidateFromId(av.id);
    if (c) return c;
  }
  if (av && av.type === 'upload' && av.dataUrl) {
    return { kind: 'upload', dataUrl: av.dataUrl, name: 'Your photo', sub: 'Uploaded', src: av.dataUrl };
  }
  const prof = p || loadProfile();
  return { kind: 'letter', name: 'Your initial', sub: 'Just the letter', letter: avatarLetter(prof) };
}
function candidateAvatarObject(cand) {
  if (!cand) return { type: 'letter' };
  if (cand.kind === 'painted') return { type: 'default', id: cand.id };
  if (cand.kind === 'sticker') return { type: 'sticker', id: cand.id };
  if (cand.kind === 'upload') return { type: 'upload', dataUrl: cand.dataUrl };
  return { type: 'letter' };
}
function sameCandidate(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'painted' || a.kind === 'sticker') return a.id === b.id;
  return true; // upload/letter: one slot each
}
/* THE save path — the only function in the picker that writes. */
function applyAvatarCandidate(cand) {
  const np = loadProfile();
  np.avatar = candidateAvatarObject(cand);
  if (np.avatar.type === 'upload') np.avatarCloudPath = ''; // new photo → re-upload
  touchProfile(np);
  pushCloudProfile(np);
  markAvatarPickerSaved();
  renderTopbar();
  return np;
}

/* ================= 3. SKIN — Variant B: Collections + Fitting Room ====
   The sheet itself is the scroller (the app's sheet pattern, cf.
   .cover-picker): wireSheetDrag reads the sheet's scrollTop, the motif
   strip is a nested horizontal scroller (the helper refuses drags that
   start inside it), and stage 1's scroll position is saved/restored
   across the trip into a grid. Only one stage's tiles ever exist in the
   DOM — compactness is structural, never the full 468. */

let avatarPickerToken = null; // overlay-history entry for the back-gesture
let apkCurrent = null;        // candidate of the saved avatar (now-bar)
let apkCandidate = null;      // candidate being tried on (not saved)
let apkItems = [];            // candidates in the open grid
let apkSavedScroll = 0;       // stage-1 scroll position, restored on back

function closeAvatarPickerDom() { // DOM-only teardown (history closer)
  const ov = document.getElementById('avatar-picker');
  if (ov) ov.remove();
}
function closeAvatarPicker() {
  if (avatarPickerToken) { overlayClosed(avatarPickerToken); avatarPickerToken = null; }
  closeAvatarPickerDom();
}

function apkImgStyle(cand) {
  return cand && cand.kind === 'sticker' ? 'object-fit:contain;padding:9%' : 'object-fit:cover';
}
/* Preview disc content (now-bar, fitting room, size previews). */
function apkDiscHTML(cand) {
  if (!cand) return '';
  if (cand.kind === 'letter') {
    return '<span class="apk-disc letter">' + esc(cand.letter || '•') + '</span>';
  }
  return '<span class="apk-disc"><img src="' + esc(cand.src || '') + '" alt="" style="' + apkImgStyle(cand) + '"></span>';
}
function apkRenderCurrent() {
  const cur = document.getElementById('apk-cur');
  if (cur) cur.innerHTML = apkDiscHTML(apkCurrent);
  const sub = document.getElementById('apk-sub');
  if (sub) sub.textContent = 'Currently: ' + (apkCurrent ? apkCurrent.name : '');
}

function apkCardHTML(c) {
  // Designer critique cut: single hero per card — the mock's 4-image
  // mosaics were the busiest surface in the design; don't ship them.
  const hero = '<span class="apk-card-hero' + (c.kind === 'sticker' ? ' stk' : '') + '">' +
    '<img src="' + esc(c.hero) + '" alt="" loading="lazy"></span>';
  const unit = c.kind === 'sticker' ? ' stickers' : ' pictures';
  return '<button class="apk-card" data-apk-col="' + esc(c.key) + '">' + hero +
    '<span class="apk-card-meta"><b>' + esc(c.title) + '</b><small>' + c.count + unit + '</small></span></button>';
}
function apkStage1HTML() {
  const cols = pickerCollections();
  const painted = cols.filter(c => c.kind === 'painted');
  const themes = cols.filter(c => c.kind === 'sticker');
  const featured = ['velvet', 'stormrider', 'briarthrone', 'midnight', 'abyss', 'voidsignal']
    .map(k => themes.find(t => t.theme === k)).filter(Boolean);
  const totalStickers = themes.reduce((n, t) => n + t.count, 0);
  let h = '<div class="apk-sec">Browse by motif</div><div class="apk-motifs">';
  STICKER_MOTIFS.forEach(m => {
    h += '<button class="apk-motif" data-apk-motif="' + m.key + '">' +
      '<span class="apk-motif-disc"><img src="' + esc(pickerMotifIcon(m)) + '" alt="" loading="lazy"></span>' +
      '<span>' + esc(m.label) + '</span></button>';
  });
  h += '</div>';
  h += '<div class="apk-sec">Yours</div>' +
    '<button class="apk-card wide" data-apk-yours="1">' +
      '<span class="apk-yours-icons"><span class="apk-yours-up">' + icon('camera') + '</span>' +
      '<span class="apk-yours-letter">' + esc(avatarLetter(loadProfile())) + '</span></span>' +
      '<span class="apk-card-meta"><b>Your photo, or just your initial</b>' +
      '<small>Uploads follow you across devices</small></span></button>';
  h += '<div class="apk-sec">Painted avatars</div><div class="apk-cards">';
  painted.forEach(c => { h += apkCardHTML(c); });
  h += '</div>';
  h += '<div class="apk-sec">Stickers</div><div class="apk-cards">';
  featured.forEach(c => { h += apkCardHTML(c); });
  // The mock's "+17 more themes" dead-end card is a real A–Z list here.
  h += '<button class="apk-card allthemes" data-apk-allthemes="1">' +
    '<span class="apk-card-meta"><b>All themes A–Z</b><small>' +
    themes.length + ' themes · ' + totalStickers + ' stickers</small></span></button>';
  h += '</div>';
  return h;
}

function apkOpenStage2(title) {
  const sheet = document.getElementById('apk-sheet');
  const s1 = document.getElementById('apk-stage1');
  const s2 = document.getElementById('apk-stage2');
  if (!sheet || !s1 || !s2) return;
  if (s1.style.display !== 'none') apkSavedScroll = sheet.scrollTop;
  s1.style.display = 'none';
  s2.style.display = '';
  s2.classList.remove('apk-enter'); void s2.offsetWidth; s2.classList.add('apk-enter');
  sheet.classList.add('tall');
  sheet.scrollTop = 0;
  document.getElementById('apk-title').textContent = title;
  document.getElementById('apk-back').style.visibility = 'visible';
}
function apkBack() {
  apkCloseFitting();
  const sheet = document.getElementById('apk-sheet');
  const s1 = document.getElementById('apk-stage1');
  const s2 = document.getElementById('apk-stage2');
  if (!sheet || !s1 || !s2) return;
  s2.style.display = 'none';
  s2.innerHTML = '';
  apkItems = [];
  s1.style.display = '';
  sheet.classList.remove('tall');
  sheet.scrollTop = apkSavedScroll;
  document.getElementById('apk-title').textContent = 'Choose a picture';
  document.getElementById('apk-back').style.visibility = 'hidden';
}

function apkTileHTML(cand, i) {
  const sel = sameCandidate(cand, apkCurrent) ? ' sel' : '';
  return '<button class="apk-tile ' + (cand.kind === 'sticker' ? 'stk' : 'painted') + sel + '"' +
    ' data-apk-i="' + i + '" title="' + esc(cand.name) + '" aria-label="' + esc(cand.name) + '">' +
    '<img src="' + esc(cand.thumb || cand.src) + '" alt="" loading="lazy" style="' + apkImgStyle(cand) + '">' +
    '<span class="apk-ring"></span><span class="apk-ck">✓</span></button>';
}
function apkRenderGrid(items, title) {
  apkItems = items;
  const s2 = document.getElementById('apk-stage2');
  let h = '<div class="apk-grid">';
  items.forEach((cand, i) => { h += apkTileHTML(cand, i); });
  h += '</div>';
  h += avatarPickerHasSaved()
    ? '<p class="apk-hint">Tap a picture to try it on below.</p>'
    : '<p class="apk-hint">Tap a picture to try it on below. Nothing changes for your circle until you tap “Use this picture”.</p>';
  s2.innerHTML = h;
  s2.querySelectorAll('[data-apk-i]').forEach(t =>
    t.addEventListener('click', () => {
      const cand = apkItems[parseInt(t.dataset.apkI, 10)];
      if (cand) apkTryOn(cand, t);
    }));
  apkOpenStage2(title);
}
function apkOpenThemes() {
  const themes = stickerThemes().slice().sort((a, b) => a.name.localeCompare(b.name));
  const s2 = document.getElementById('apk-stage2');
  s2.innerHTML = '<div class="apk-trows">' + themes.map(t =>
    '<button class="apk-trow" data-apk-theme="' + esc(t.key) + '">' +
    '<span class="apk-trow-hero"><img src="' + esc(t.hero) + '" alt="" loading="lazy"></span>' +
    '<span class="apk-trow-meta"><b>' + esc(t.name) + '</b><small>' + t.count + ' stickers</small></span>' +
    '<span class="apk-trow-chev">›</span></button>').join('') + '</div>';
  s2.querySelectorAll('[data-apk-theme]').forEach(r =>
    r.addEventListener('click', () => {
      const col = pickerCollections().find(c => c.key === 'stickers:' + r.dataset.apkTheme);
      if (col) apkRenderGrid(pickerCollectionItems(col), col.title + ' — Stickers');
    }));
  apkOpenStage2('All themes A–Z');
}
function apkOpenYours() {
  apkItems = [];
  const p = loadProfile();
  const letterCand = { kind: 'letter', name: 'Your initial', sub: 'Just the letter', letter: avatarLetter(p) };
  const upSel = apkCurrent && apkCurrent.kind === 'upload';
  const letterSel = apkCurrent && apkCurrent.kind === 'letter';
  const s2 = document.getElementById('apk-stage2');
  s2.innerHTML = '<div class="apk-grid yours">' +
    '<button class="apk-tile special' + (upSel ? ' sel' : '') + '" id="apk-up-tile" title="Upload your own" aria-label="Upload your own">' +
      (upSel
        ? '<img src="' + esc(apkCurrent.src) + '" alt="" style="object-fit:cover">'
        : '<span class="apk-up-ic">' + icon('camera') + '</span>') +
      '<span class="apk-ring"></span><span class="apk-ck">✓</span></button>' +
    '<button class="apk-tile special' + (letterSel ? ' sel' : '') + '" id="apk-letter-tile" title="Just my initial" aria-label="Just my initial">' +
      '<span class="apk-letter-disc">' + esc(letterCand.letter) + '</span>' +
      '<span class="apk-ring"></span><span class="apk-ck">✓</span></button>' +
    '</div>' +
    (avatarPickerHasSaved() ? '' :
      '<p class="apk-hint">Trying a photo or your initial works the same way — nothing changes until you tap “Use this picture”.</p>');
  document.getElementById('apk-up-tile').addEventListener('click', () =>
    document.getElementById('apk-file').click());
  document.getElementById('apk-letter-tile').addEventListener('click', (e) =>
    apkTryOn(letterCand, e.currentTarget));
  apkOpenStage2('Yours');
}

/* Fitting room — a bar inside the sheet, never a nested sheet. Trying
   saves nothing; "Use this picture" is the only save action. */
function apkTryOn(cand, tileEl) {
  apkCandidate = cand;
  document.querySelectorAll('#apk-stage2 .apk-tile').forEach(x => x.classList.remove('try'));
  if (tileEl) tileEl.classList.add('try');
  document.getElementById('apk-fit-big').innerHTML = apkDiscHTML(cand);
  document.getElementById('apk-sz1').innerHTML = apkDiscHTML(cand);
  document.getElementById('apk-sz2').innerHTML = apkDiscHTML(cand);
  document.getElementById('apk-fit-name').textContent = cand.name || '';
  // The "nothing saved yet" explainer: only until the first-ever save.
  document.getElementById('apk-fit-sub').textContent =
    avatarPickerHasSaved() ? (cand.sub || '') : 'Trying it on — nothing saved yet';
  document.getElementById('apk-fitting').classList.add('open');
  const sheet = document.getElementById('apk-sheet');
  if (sheet) sheet.classList.add('fit-open'); // scroll clearance under the pinned bar
}
function apkCloseFitting() {
  const f = document.getElementById('apk-fitting');
  if (f) f.classList.remove('open');
  const sheet = document.getElementById('apk-sheet');
  if (sheet) sheet.classList.remove('fit-open');
  apkCandidate = null;
  document.querySelectorAll('#apk-stage2 .apk-tile.try').forEach(x => x.classList.remove('try'));
}
function apkUse() {
  if (!apkCandidate) return;
  const cand = apkCandidate;
  applyAvatarCandidate(cand);
  const p = loadProfile();
  apkCurrent = candidateForAvatar(p.avatar, p);
  apkRenderCurrent();
  document.querySelectorAll('#apk-stage2 [data-apk-i]').forEach(t => {
    const c = apkItems[parseInt(t.dataset.apkI, 10)];
    t.classList.toggle('sel', !!c && sameCandidate(c, apkCurrent));
  });
  apkCloseFitting();
  toast(cand.kind === 'upload' ? 'Photo uploaded ✨'
    : cand.kind === 'letter' ? 'Avatar cleared ✨' : 'Avatar updated ✨');
  if (typeof view !== 'undefined' && view === 'profile' && typeof renderProfile === 'function') renderProfile();
}

function openAvatarPicker() {
  // Defensive re-open adopts the existing history entry (v220 pattern).
  const reopenToken = avatarPickerToken; avatarPickerToken = null;
  closeAvatarPickerDom();
  const doOpen = () => {
    const p = loadProfile();
    apkCurrent = candidateForAvatar(p.avatar, p);
    apkCandidate = null;
    apkItems = [];
    const ov = document.createElement('div');
    ov.className = 'apk-backdrop';
    ov.id = 'avatar-picker';
    ov.innerHTML =
      '<div class="apk-sheet" id="apk-sheet" role="dialog" aria-label="Choose a picture">' +
        '<div class="apk-top">' +
          '<div class="apk-handle"><i></i></div>' +
          '<div class="apk-head">' +
            '<button class="apk-iconbtn" id="apk-back" style="visibility:hidden" aria-label="Back">‹</button>' +
            '<div class="apk-ttl"><b id="apk-title">Choose a picture</b><small id="apk-sub"></small></div>' +
            '<div class="apk-curdisc" id="apk-cur"></div>' +
            '<button class="apk-iconbtn" id="apk-close" aria-label="Close">✕</button>' +
          '</div>' +
        '</div>' +
        '<div class="apk-stage" id="apk-stage1">' + apkStage1HTML() + '</div>' +
        '<div class="apk-stage" id="apk-stage2" style="display:none"></div>' +
        '<div class="apk-fitting" id="apk-fitting">' +
          '<div class="apk-fit-row">' +
            '<div class="apk-fit-big" id="apk-fit-big"></div>' +
            '<div class="apk-fit-meta">' +
              '<div class="apk-fit-name" id="apk-fit-name"></div>' +
              '<div class="apk-fit-sub" id="apk-fit-sub"></div>' +
              '<div class="apk-sizes">' +
                '<figure><div class="apk-discwrap s30" id="apk-sz1"></div><figcaption>Top bar</figcaption></figure>' +
                '<figure><div class="apk-discwrap s38" id="apk-sz2"></div><figcaption>Circle</figcaption></figure>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="apk-fit-btns">' +
            '<button class="btn" id="apk-use" style="flex:1">Use this picture</button>' +
            '<button class="btn ghost" id="apk-keep">Keep looking</button>' +
          '</div>' +
        '</div>' +
        '<input type="file" id="apk-file" accept="image/*" hidden>' +
      '</div>';
    document.body.appendChild(ov);
    if (typeof wireSheetDrag === 'function') {
      wireSheetDrag(ov.querySelector('.apk-sheet'), closeAvatarPicker);
    }
    apkRenderCurrent();
    ov.querySelectorAll('[data-apk-motif]').forEach(b =>
      b.addEventListener('click', () => {
        const m = STICKER_MOTIFS.find(x => x.key === b.dataset.apkMotif);
        if (m) apkRenderGrid(pickerMotifItems(m), m.label + ' — every theme');
      }));
    ov.querySelectorAll('[data-apk-col]').forEach(b =>
      b.addEventListener('click', () => {
        const col = pickerCollections().find(c => c.key === b.dataset.apkCol);
        if (col) apkRenderGrid(pickerCollectionItems(col),
          col.kind === 'sticker' ? col.title + ' — Stickers' : col.title);
      }));
    const yours = ov.querySelector('[data-apk-yours]');
    if (yours) yours.addEventListener('click', apkOpenYours);
    const all = ov.querySelector('[data-apk-allthemes]');
    if (all) all.addEventListener('click', apkOpenThemes);
    document.getElementById('apk-back').addEventListener('click', apkBack);
    document.getElementById('apk-close').addEventListener('click', closeAvatarPicker);
    document.getElementById('apk-keep').addEventListener('click', apkCloseFitting);
    document.getElementById('apk-use').addEventListener('click', apkUse);
    document.getElementById('apk-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const dataUrl = await fileToAvatarDataURL(f);
        apkTryOn({ kind: 'upload', dataUrl: dataUrl, name: 'Your photo', sub: 'Uploaded', src: dataUrl }, null);
      } catch (err) { toast('Could not use that photo — try a JPG or PNG.'); }
    });
    ov.addEventListener('click', e => { if (e.target === ov) closeAvatarPicker(); });
    if (typeof overlayOpened === 'function') {
      avatarPickerToken = overlayOpened('picker', closeAvatarPickerDom);
    }
  };
  if (reopenToken && typeof overlayReplace === 'function') overlayReplace(reopenToken, doOpen);
  else doOpen();
}
