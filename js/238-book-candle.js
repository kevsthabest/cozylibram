/* ---- Your Book as a Candle (v564): a candle card beside Book Portrait
   on the book page + a share card in the js/220 family style.
   Spec: docs/book-candle-spec.md.

   A candle name + three scent notes derived DETERMINISTICALLY from the
   book's own fields only, via the curated table below (versioned):
     base  <- setting (setting-flavoured canonical tropes on the book)
     heart <- tropes  (the portrait's local merge: user's, then pipeline)
     top   <- genre (bookGenres), falling back to mood
   No LLM, no re-roll: the same book record always pours the same candle.
   Layers the book has no data for stay empty — the card says so ("this
   candle pours fuller as the book's data grows") instead of inventing a
   note from a field the book doesn't have. Community-async tropes are
   deliberately NOT read: the candle's identity must be stable, and the
   local record is what sync guarantees everywhere.

   The name comes from ONE swappable function (candleName) with three
   patterns; CANDLE_NAME_PATTERN picks the shipped one (the User's veto
   pick at presentation — the three patterns are listed in the PR).

   Cover tint (v567): the wax colour follows the book's cover, read from
   the spine sampler's cache (spineColorCache, js/120 — the same values
   the 3D spines use), with the same validity guard as js/217's
   shelf3dCoverHex: the cached entry's cover must equal the book's
   CURRENT cover, so the tint follows the owned edition and a stale
   sample never paints. Cache-only — this module never samples a cover
   itself. No entry yet (no cover, unsampled, sampler failure) -> the
   house default wax. The tint is derived at render from the cache, so
   for a given book + cover it is identical on every render and device.
   Scent derivation never reads the tint.
*/
(function () {
'use strict';

var CANDLE_TABLE_VERSION = 1;
var CANDLE_NAME_PATTERN = 1;
var CANDLE_THIN_NAME = 'The Unlit Candle';

/* ---------- the curated mapping table (v1) ----------
   Entry shape: { note, spark } — spark is the evocative fragment the
   name patterns draw from. Base entries also carry scene: [element,
   surface] for pattern 3. Keys: base/heart are canonical trope ids
   (js/156); topGenre/topMood keys are normalised field values. */
var CANDLE_BASE = {
  'small-town':         { note: 'porch rain & honeysuckle', spark: 'Porch Rain', scene: ['Rain', 'the Porch'] },
  'small-town-secrets': { note: 'cedar closets & dust', spark: 'Cedar Closet', scene: ['Dust', 'Cedar Shelves'] },
  'dark-academia':      { note: 'old paper & cold stone', spark: 'Old Stone', scene: ['Candlelight', 'Cold Stone'] },
  'magic-academy':      { note: 'chalk dust & polished oak', spark: 'Polished Oak', scene: ['Chalk Dust', 'Oak Desks'] },
  'haunted-house':      { note: 'cold ash & damp plaster', spark: 'Cold Ash', scene: ['Ash', 'Damp Plaster'] },
  'space-opera':        { note: 'recycled air & hot metal', spark: 'Hot Metal', scene: ['Starlight', 'the Hull'] },
  'generation-ship':    { note: 'warm circuitry & green leaf', spark: 'Green Leaf', scene: ['Lamplight', 'Green Leaves'] },
  'dystopia':           { note: 'ash & wet concrete', spark: 'Wet Concrete', scene: ['Ash', 'Wet Concrete'] },
  'cyberpunk':          { note: 'neon rain & ozone', spark: 'Neon Rain', scene: ['Rain', 'Neon Glass'] },
  'portal-fantasy':     { note: 'green sap & strange earth', spark: 'Strange Earth', scene: ['Rain', 'Strange Earth'] },
  'quest':              { note: 'trail dust & pine resin', spark: 'Pine Resin', scene: ['Dust', 'the High Trail'] },
  'road-trip':          { note: 'hot asphalt & diner coffee', spark: 'Hot Asphalt', scene: ['Heat', 'the Open Road'] },
  'royalty':            { note: 'marble & beeswax', spark: 'Beeswax', scene: ['Candlelight', 'Marble'] },
  'war-story':          { note: 'gun oil & wet wool', spark: 'Wet Wool', scene: ['Rain', 'Wet Wool'] },
  'locked-room':        { note: 'still air & dust', spark: 'Still Air', scene: ['Dust', 'a Locked Door'] },
  'workplace-romance':  { note: 'coffee & rain on glass', spark: 'Rain on Glass', scene: ['Rain', 'Glass'] },
  'mafia':              { note: 'espresso & gunmetal', spark: 'Gunmetal', scene: ['Smoke', 'Gunmetal'] },
  'biker':              { note: 'leather & hot asphalt', spark: 'Hot Leather', scene: ['Heat', 'Asphalt'] },
};

var CANDLE_HEART = {
  'enemies-to-lovers':    { note: 'smoke & rose', spark: 'Rose Smoke' },
  'forced-proximity':     { note: 'woodsmoke & shared wool', spark: 'Woodsmoke' },
  'grumpy-x-sunshine':    { note: 'black coffee & lemon', spark: 'Lemon Coffee' },
  'slow-burn':            { note: 'ember & amber', spark: 'Ember' },
  'forbidden-love':       { note: 'incense & stolen roses', spark: 'Stolen Roses' },
  'fated-mates':          { note: 'moonflower & musk', spark: 'Moonflower' },
  'fake-dating':          { note: 'champagne & lipstick', spark: 'Champagne' },
  'marriage-of-convenience': { note: 'sealing wax & cedar', spark: 'Sealing Wax' },
  'arranged-marriage':    { note: 'orange blossom & myrrh', spark: 'Orange Blossom' },
  'second-chance':        { note: 'old letters & rain', spark: 'Old Letters' },
  'secret-baby':          { note: 'powder & white iris', spark: 'White Iris' },
  'love-triangle':        { note: 'two roses & thorns', spark: 'Thorns' },
  'billionaire':          { note: 'saffron & polished leather', spark: 'Saffron' },
  'bully':                { note: 'bruised violets & smoke', spark: 'Bruised Violets' },
  'stalker':              { note: 'dark rose & night air', spark: 'Dark Rose' },
  'kidnapping':           { note: 'wax & iron', spark: 'Iron' },
  'captive':              { note: 'stone walls & tallow', spark: 'Tallow' },
  'revenge':              { note: 'ash & bitter orange', spark: 'Bitter Orange' },
  'morally-grey':         { note: 'leather & ash', spark: 'Ash' },
  'age-gap':              { note: 'vintage wine & new linen', spark: 'Vintage Wine' },
  'single-dad':           { note: 'warm milk & flannel', spark: 'Flannel' },
  'friends-to-lovers':    { note: 'sun-warmed cotton & honey', spark: 'Honey' },
  'secret-relationship':  { note: 'hidden lilies & smoke', spark: 'Hidden Lilies' },
  'bodyguard':            { note: 'steel & sandalwood', spark: 'Sandalwood' },
  'amnesia':              { note: 'fog & forget-me-nots', spark: 'Forget-Me-Nots' },
  'pregnancy':            { note: 'ginger & white tea', spark: 'Ginger' },
  'why-choose':           { note: 'three roses & spice', spark: 'Three Roses' },
  'stepbrother':          { note: 'cedar & borrowed cotton', spark: 'Borrowed Cotton' },
  'vampire':              { note: 'iron wine & night roses', spark: 'Night Roses' },
  'werewolf':             { note: 'pine & wild musk', spark: 'Wild Musk' },
  'shifter':              { note: 'wild musk & forest floor', spark: 'Forest Floor' },
  'chosen-one':           { note: 'beeswax & lightning', spark: 'Lightning' },
  'dragons':              { note: 'dragonfire & charred cedar', spark: 'Dragonfire' },
  'found-family':         { note: 'honey & warm bread', spark: 'Warm Bread' },
  'hidden-powers':        { note: 'ozone & secret gardens', spark: 'Ozone' },
  'reluctant-hero':       { note: 'dusty boots & rain', spark: 'Dusty Boots' },
  'dark-lord':            { note: 'obsidian & black amber', spark: 'Obsidian' },
  'prophecy':             { note: 'myrrh & starlight', spark: 'Starlight' },
  'political-intrigue':   { note: 'ink & sealing wax', spark: 'Ink' },
  'hard-magic':           { note: 'copper & chalk', spark: 'Copper' },
  'epic-battle':          { note: 'smoke & trampled grass', spark: 'Trampled Grass' },
  'secret-identity':      { note: 'mask & musk', spark: 'Mask' },
  'sacrifice':            { note: 'white flowers & ash', spark: 'White Flowers' },
  'mentorship':           { note: 'old books & cedar pencils', spark: 'Old Books' },
  'ai-uprising':          { note: 'hot circuits & ozone', spark: 'Hot Circuits' },
  'first-contact':        { note: 'strange fruit & thin air', spark: 'Thin Air' },
  'time-travel':          { note: 'old clocks & dust', spark: 'Old Clocks' },
  'alien-invasion':       { note: 'burnt sugar & ozone', spark: 'Burnt Sugar' },
  'faceless-enemy':       { note: 'grey mist & iron', spark: 'Grey Mist' },
  'dead-mans-switch':     { note: 'a ticking clock & cordite', spark: 'Ticking Clock' },
  'unlikely-alliance':    { note: 'shared fire & pine', spark: 'Shared Fire' },
  'whodunit':             { note: 'black tea & library dust', spark: 'Library Dust' },
  'unreliable-narrator':  { note: 'mirrors & smoke', spark: 'Mirrors' },
  'cold-case':            { note: 'cold files & dust', spark: 'Cold Files' },
  'serial-killer':        { note: 'iron & lilies', spark: 'Iron Lilies' },
  'conspiracy':           { note: 'red string & old paper', spark: 'Red String' },
  'double-cross':         { note: 'amber & smoke', spark: 'Amber' },
  'missing-person':       { note: 'an empty chair & rain', spark: 'Empty Chair' },
  'betrayal':             { note: 'broken glass & roses', spark: 'Broken Glass' },
  'heist':                { note: 'velvet gloves & gold', spark: 'Velvet Gloves' },
  'mind-game':            { note: 'chess & black pepper', spark: 'Black Pepper' },
  'deadly-trials':        { note: 'blood orange & iron', spark: 'Blood Orange' },
  'possession':           { note: 'frankincense & cold air', spark: 'Frankincense' },
  'folk-horror':          { note: 'corn husks & bonfire smoke', spark: 'Bonfire Smoke' },
  'cosmic-horror':        { note: 'deep water & old stars', spark: 'Deep Water' },
  'final-girl':           { note: 'ash & adrenaline', spark: 'Ash' },
  'found-footage':        { note: 'static & damp film', spark: 'Static' },
  'body-horror':          { note: 'copper & antiseptic', spark: 'Antiseptic' },
  'ghost-hunter':         { note: 'sage & cold spots', spark: 'Sage' },
  'survivor-guilt':       { note: 'rain & unlit candles', spark: 'Unlit Candles' },
  'family-drama':         { note: 'sunday roast & old wood', spark: 'Old Wood' },
  'coming-of-age':        { note: 'cut grass & first rain', spark: 'Cut Grass' },
  'true-crime':           { note: 'case files & coffee', spark: 'Case Files' },
  'memoir':               { note: 'ink & old photographs', spark: 'Old Photographs' },
  'misunderstanding':     { note: 'unsent letters & rain', spark: 'Unsent Letters' },
  'redemption':           { note: 'dawn & clean linen', spark: 'Dawn' },
  'protective-partner':   { note: 'safe harbour & cedar', spark: 'Safe Harbour' },
};

var CANDLE_TOP_GENRE = {
  'fantasy':           { note: 'bergamot & wild mint', spark: 'Wild Mint' },
  'romantasy':         { note: 'rose & bergamot', spark: 'Rose' },
  'romance':           { note: 'rosewater & peach', spark: 'Peach' },
  'dark romance':      { note: 'black cherry & clove', spark: 'Black Cherry' },
  'science fiction':   { note: 'ozone & green apple', spark: 'Green Apple' },
  'sci-fi':            { note: 'ozone & green apple', spark: 'Green Apple' },
  'science-fiction':   { note: 'ozone & green apple', spark: 'Green Apple' },
  'scifi':             { note: 'ozone & green apple', spark: 'Green Apple' },
  'mystery':           { note: 'black tea & lemon peel', spark: 'Lemon Peel' },
  'cozy mystery':      { note: 'tea & lemon peel', spark: 'Tea' },
  'thriller':          { note: 'iced mint & vetiver', spark: 'Iced Mint' },
  'horror':            { note: 'candle-smoke & clove', spark: 'Candle-Smoke' },
  'gothic':            { note: 'bergamot & candle-smoke', spark: 'Bergamot' },
  'historical fiction': { note: 'beeswax & dried lavender', spark: 'Lavender' },
  'historical':        { note: 'beeswax & dried lavender', spark: 'Lavender' },
  'contemporary':      { note: 'green fig & cotton', spark: 'Green Fig' },
  'young adult':       { note: 'apple blossom & pencil shavings', spark: 'Apple Blossom' },
  'paranormal':        { note: 'night jasmine & ozone', spark: 'Night Jasmine' },
  'dystopian':         { note: 'ash & bergamot', spark: 'Ash' },
  'adventure':         { note: 'lime & sea spray', spark: 'Lime' },
  'humor':             { note: 'lemon zest & mint', spark: 'Lemon Zest' },
  'humour':            { note: 'lemon zest & mint', spark: 'Lemon Zest' },
  'comedy':            { note: 'lemon zest & mint', spark: 'Lemon Zest' },
  'literary fiction':  { note: 'green tea & linen', spark: 'Green Tea' },
  'non-fiction':       { note: 'cedar & clean paper', spark: 'Clean Paper' },
  'nonfiction':        { note: 'cedar & clean paper', spark: 'Clean Paper' },
  'biography':         { note: 'clean paper & ink', spark: 'Ink' },
  'memoir':            { note: 'old photographs & ink', spark: 'Old Photographs' },
};

var CANDLE_TOP_MOOD = {
  'adventurous':  { note: 'salt air & lime', spark: 'Salt Air' },
  'dark':         { note: 'clove & candle-smoke', spark: 'Clove' },
  'emotional':    { note: 'iris & rainwater', spark: 'Iris' },
  'funny':        { note: 'lemon zest & soda', spark: 'Lemon Soda' },
  'hopeful':      { note: 'neroli & honey', spark: 'Neroli' },
  'informative':  { note: 'paper & cedar', spark: 'Cedar' },
  'inspiring':    { note: 'white tea & bergamot', spark: 'White Tea' },
  'lighthearted': { note: 'peach & vanilla blossom', spark: 'Vanilla Blossom' },
  'light-hearted': { note: 'peach & vanilla blossom', spark: 'Vanilla Blossom' },
  'mysterious':   { note: 'fig & black tea', spark: 'Fig' },
  'reflective':   { note: 'sencha & linen', spark: 'Sencha' },
  'relaxing':     { note: 'lavender & chamomile', spark: 'Chamomile' },
  'sad':          { note: 'violet & rain', spark: 'Violet' },
  'tense':        { note: 'cold mint & steel', spark: 'Cold Mint' },
  'challenging':  { note: 'black pepper & vetiver', spark: 'Vetiver' },
};

var CANDLE_TABLE = { base: CANDLE_BASE, heart: CANDLE_HEART, topGenre: CANDLE_TOP_GENRE, topMood: CANDLE_TOP_MOOD };

/* ---------- keying ---------- */
function normFieldKey(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}
function tropeKey(name) {
  try {
    if (typeof tropeResolveId === 'function') {
      var id = tropeResolveId(name);
      if (id) return id;
    }
  } catch (e) {}
  return String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
/* The portrait's local trope view (user first, then pipeline AI),
   deduped case-insensitively — raw display strings kept for labels. */
function localTropeNames(b) {
  var out = [], seen = {};
  (b.tropes || []).concat(b.tropesAI || []).forEach(function (t) {
    t = String(t || '').trim(); if (!t) return;
    var k = t.toLowerCase();
    if (!seen[k]) { seen[k] = 1; out.push(t); }
  });
  return out;
}
function firstTropeKey(names, table, exclude) {
  for (var i = 0; i < names.length; i++) {
    var id = tropeKey(names[i]);
    if (id && table[id] && !(exclude && exclude[id])) {
      return { entry: table[id], id: id, value: names[i] };
    }
  }
  return null;
}

/* ---------- derivation (pure, deterministic) ---------- */
function layerNote(hit) {
  if (!hit) return null;
  var out = { note: hit.entry.note, spark: hit.entry.spark, source: hit.source };
  if (hit.entry.scene) out.scene = hit.entry.scene;
  return out;
}
function bookCandle(b) {
  b = b || {};
  var names = localTropeNames(b);
  // base: first setting-flavoured trope on the book
  var baseHit = firstTropeKey(names, CANDLE_BASE, null);
  // heart: first keyed trope that is not the setting key (tables are
  // disjoint by construction; the exclusion keeps the layers honest
  // even if a future table edit overlaps them)
  var heartHit = firstTropeKey(names, CANDLE_HEART, CANDLE_BASE);
  // top: genres in the book's order, then moods in the book's order
  var top = null;
  var genres = [];
  try { genres = (typeof bookGenres === 'function') ? (bookGenres(b) || []) : (b.categories || []); } catch (e) { genres = []; }
  for (var i = 0; i < genres.length && !top; i++) {
    var gk = normFieldKey(genres[i]);
    if (CANDLE_TOP_GENRE[gk]) top = { entry: CANDLE_TOP_GENRE[gk], source: { kind: 'genre', value: String(genres[i]) } };
  }
  var moods = b.moods || [];
  for (var j = 0; j < moods.length && !top; j++) {
    var mk = normFieldKey(moods[j]);
    if (CANDLE_TOP_MOOD[mk]) top = { entry: CANDLE_TOP_MOOD[mk], source: { kind: 'mood', value: String(moods[j]) } };
  }
  if (baseHit) baseHit.source = { kind: 'trope', value: baseHit.value, id: baseHit.id };
  if (heartHit) heartHit.source = { kind: 'trope', value: heartHit.value, id: heartHit.id };
  var notes = { top: layerNote(top), heart: layerNote(heartHit), base: layerNote(baseHit) };
  var mapped = (notes.top ? 1 : 0) + (notes.heart ? 1 : 0) + (notes.base ? 1 : 0);
  var candle = { notes: notes, mapped: mapped, thin: mapped < 3, name: '' };
  candle.name = candleName(candle, CANDLE_NAME_PATTERN);
  return candle;
}

/* ---------- the name: one swappable function, three patterns ----------
   1 (built) "Blend" — the first two note heads joined: "Bergamot & Smoke".
   2 "The ___ Candle" — the strongest layer's evocative spark (base,
      then heart, then top): "The Porch Rain Candle".
   3 "Scene" — the base entry's scene pair, in the spec's example shape:
      "Rain on the Porch". Falls back to the blend when no scene exists. */
function headOf(note) {
  var head = String(note || '').split('&')[0].trim();
  return head.replace(/(^|\s)([a-z])/g, function (m, sp, ch) { return sp + ch.toUpperCase(); });
}
function candleName(candle, pattern) {
  var n = (candle && candle.notes) || {};
  var p = (pattern === 2 || pattern === 3) ? pattern : 1;
  if (p === 2) {
    var spark = (n.base && n.base.spark) || (n.heart && n.heart.spark) || (n.top && n.top.spark);
    return spark ? 'The ' + spark + ' Candle' : CANDLE_THIN_NAME;
  }
  if (p === 3 && n.base && n.base.scene) {
    return n.base.scene[0] + ' on ' + n.base.scene[1];
  }
  var heads = [n.top, n.heart, n.base].filter(Boolean).map(function (l) { return headOf(l.note); }).slice(0, 2);
  return heads.length ? heads.join(' & ') : CANDLE_THIN_NAME;
}

/* ---------- cover tint: the wax follows the book's cover ----------
   House default wax gradient (the pre-tint colours) — used whenever
   the sampler has no palette for the book's current cover. */
var CANDLE_WAX_DEFAULT = ['#e5b86a', '#9a6224'];
function _candleRgb(hex) {
  return [1, 3, 5].map(function (i) { return parseInt(hex.slice(i, i + 2), 16); });
}
function _candleHex(rgb) {
  return '#' + rgb.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join('');
}
function _candleLum(rgb) {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}
function _candleMix(rgb, target, k) {
  return rgb.map(function (v, i) { return v + (target[i] - v) * k; });
}
/* The sampler's cached dominant hex for the book's CURRENT cover, or
   null. Mirrors js/217 shelf3dCoverHex's guard exactly: cache entry
   must exist, its cover must equal b.cover (a cover change invalidates
   the tint until the new cover is sampled), hex must be #rrggbb. */
function candleCoverHex(b) {
  try {
    if (!b || !b.cover || typeof spineColorCache === 'undefined') return null;
    var c = spineColorCache[b.id];
    return (c && c.cover === b.cover && /^#[0-9a-f]{6}$/i.test(c.hex || '')) ? String(c.hex).toLowerCase() : null;
  } catch (e) { return null; }
}
/* Pull a cover colour into the wax band: luminance clamped to
   [0.18, 0.42] — the cap mirrors shelf3dSpineTone's light-cover
   pull-down; the floor lifts near-black covers by mixing toward white.
   Inside the band the colour passes through untouched, hue preserved. */
function candleTone(hex) {
  var rgb = _candleRgb(hex);
  var lum = _candleLum(rgb);
  if (lum > 0.42) { var k = 0.42 / lum; rgb = rgb.map(function (v) { return v * k; }); }
  else if (lum < 0.18) { rgb = _candleMix(rgb, [255, 255, 255], (0.18 - lum) / (1 - lum)); }
  return rgb;
}
/* The candle's colours for a book: { hex, top, base } (the wax gradient
   stops), or null when the book has no sampled palette yet. Pure in
   (book, cache): same inputs -> same tint, every render, every device.
   Legibility guard is structural: the tint only ever paints the wax —
   on both surfaces every label sits on the card background, never on
   the wax — and the band clamp keeps the wax a mid-tone, so the jar
   outline and flame read against it at either extreme. */
function candleTint(b) {
  var hex = candleCoverHex(b);
  if (!hex) return null;
  var tone = candleTone(hex);
  return {
    hex: _candleHex(tone),
    top: _candleHex(_candleMix(tone, [255, 255, 255], 0.38)),
    base: _candleHex(_candleMix(tone, [0, 0, 0], 0.32)),
  };
}
function candleWaxStops(b) {
  var t = candleTint(b);
  return t ? [t.top, t.base] : CANDLE_WAX_DEFAULT;
}

/* ---------- the card (sync, mirrors Book Portrait) ---------- */
function noteRowHTML(label, layer) {
  return '<div class="portrait-sec"><div class="portrait-label">' + label + '</div>' +
    '<div class="candle-row">' + esc(layer.note) +
    ' <span class="note">from ' + esc(layer.source.value) + '</span></div></div>';
}
function candleCardHTML(b) {
  if (!b) return '';
  var c = bookCandle(b);
  var stops = candleWaxStops(b);
  var html =
    '<div class="candle-card" id="candleCard" data-book="' + esc(b.id || '') + '">' +
    '<div class="portrait-head"><span style="width:22px;height:22px;color:var(--accent);flex-shrink:0;vertical-align:middle;margin-right:10px;display:inline-flex;align-items:center">' + icon('flame') + '</span>' +
    '<span class="serif portrait-title">Your Book as a Candle</span>' +
    '<button class="taplink candle-share" data-candle="share" data-book="' + esc(b.id || '') + '">Share</button></div>' +
    '<div class="candle-fig" aria-hidden="true"><span class="candle-fig-flame"></span>' +
    '<span class="candle-fig-wax" style="background:linear-gradient(180deg,' + stops[0] + ',' + stops[1] + ')"></span></div>' +
    '<div class="candle-name serif">&ldquo;' + esc(c.name) + '&rdquo;</div>';
  if (c.notes.top) html += noteRowHTML('Top notes', c.notes.top);
  if (c.notes.heart) html += noteRowHTML('Heart notes', c.notes.heart);
  if (c.notes.base) html += noteRowHTML('Base notes', c.notes.base);
  if (c.thin) {
    html += '<p class="note candle-thin">This candle pours fuller as the book\u2019s data grows.</p>';
  }
  html += '</div>';
  return html;
}

/* ---------- share card (canvas, js/220 family pattern) ---------- */
function findBook(id) {
  try {
    var lib = (typeof library !== 'undefined') ? library : [];
    for (var i = 0; i < lib.length; i++) if (lib[i] && lib[i].id === id) return lib[i];
  } catch (e) {}
  return null;
}
function drawCandleCard(b) {
  if (!b || typeof cardCanvas !== 'function') return null;
  var c = bookCandle(b);
  var made = cardCanvas();
  if (!made) return null;
  var cv = made.cv, x = made.x, W = made.W, C = made.C;
  var ink = C.ink, mut = C.mut, gold = C.gold;
  x.textAlign = 'center';

  // warm glow behind the candle
  var glow = x.createRadialGradient(W / 2, 640, 40, W / 2, 640, 620);
  glow.addColorStop(0, 'rgba(229,184,106,.25)');
  glow.addColorStop(1, 'rgba(229,184,106,0)');
  x.fillStyle = glow;
  x.fillRect(0, 0, W, made.H);

  try { x.letterSpacing = '14px'; } catch (e) {}
  x.fillStyle = mut;
  x.font = '40px system-ui, sans-serif';
  x.fillText('COZY LIBRAM', W / 2, 150);
  try { x.letterSpacing = '0px'; } catch (e) {}

  // the candle: jar + wax + flame, drawn (no image, so never tainted)
  var jarW = 300, jarH = 400, jarX = W / 2 - jarW / 2, jarY = 400;
  x.save();
  if (typeof cvRoundRect === 'function') { cvRoundRect(x, jarX, jarY, jarW, jarH, 26); }
  else x.rect(jarX, jarY, jarW, jarH);
  x.fillStyle = 'rgba(255,255,255,.06)'; x.fill();
  x.strokeStyle = 'rgba(246,239,248,.4)'; x.lineWidth = 3; x.stroke();
  x.clip();
  var stops = candleWaxStops(b);
  var wax = x.createLinearGradient(0, jarY + 110, 0, jarY + jarH);
  wax.addColorStop(0, stops[0]); wax.addColorStop(1, stops[1]);
  x.fillStyle = wax;
  x.fillRect(jarX, jarY + 110, jarW, jarH - 110);
  x.restore();
  // wick + flame
  x.strokeStyle = '#3a2410'; x.lineWidth = 5;
  x.beginPath(); x.moveTo(W / 2, jarY + 112); x.lineTo(W / 2, jarY + 74); x.stroke();
  var flame = x.createRadialGradient(W / 2, jarY + 44, 4, W / 2, jarY + 44, 58);
  flame.addColorStop(0, 'rgba(255,244,204,.95)');
  flame.addColorStop(0.45, 'rgba(229,184,106,.75)');
  flame.addColorStop(1, 'rgba(229,184,106,0)');
  x.fillStyle = flame;
  x.beginPath(); x.arc(W / 2, jarY + 44, 58, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff3cf';
  x.beginPath(); x.ellipse(W / 2, jarY + 50, 11, 22, 0, 0, Math.PI * 2); x.fill();

  // candle name
  var y = 950;
  x.fillStyle = gold;
  x.font = 'bold 88px Georgia, serif';
  var wrap = (typeof cvWrap === 'function') ? cvWrap(x, c.name, W - 160) : [c.name];
  wrap.slice(0, 2).forEach(function (t) { x.fillText(t, W / 2, y); y += 100; });
  y += 26;

  // the notes, in pour order
  [['TOP NOTES', c.notes.top], ['HEART NOTES', c.notes.heart], ['BASE NOTES', c.notes.base]]
    .forEach(function (pair) {
      if (!pair[1]) return;
      try { x.letterSpacing = '8px'; } catch (e) {}
      x.fillStyle = mut; x.font = '30px system-ui, sans-serif';
      x.fillText(pair[0], W / 2, y);
      try { x.letterSpacing = '0px'; } catch (e) {}
      y += 58;
      x.fillStyle = ink; x.font = '46px Georgia, serif';
      x.fillText(pair[1].note, W / 2, y);
      y += 96;
    });
  if (c.thin) {
    x.fillStyle = mut; x.font = 'italic 34px Georgia, serif';
    x.fillText('This candle pours fuller as the book\u2019s data grows.', W / 2, y + 6);
  }

  // the book
  x.fillStyle = mut; x.font = 'italic 40px Georgia, serif';
  var titleLines = (typeof cvWrap === 'function') ? cvWrap(x, b.title || 'Untitled', W - 200) : [b.title || 'Untitled'];
  titleLines.slice(0, 2).forEach(function (t, i) { x.fillText(t, W / 2, 1648 + i * 52); });
  if ((b.authors || []).length) {
    x.font = '34px system-ui, sans-serif';
    x.fillText((b.authors || []).join(', '), W / 2, 1648 + titleLines.slice(0, 2).length * 52 + 6);
  }

  if (typeof cardFooter === 'function') cardFooter(x, W);
  return cv;
}
function shareCandleCard(id) {
  var b = findBook(id);
  if (!b) return;
  try { toast('Making your card\u2026 \u2728'); } catch (e) {}
  var cv = drawCandleCard(b);
  if (!cv) { try { toast('Image export isn\u2019t supported on this device'); } catch (e) {} return; }
  var c = bookCandle(b);
  var safe = String(c.name || 'candle').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'candle';
  shareCanvasFile(cv, 'cozy-libram-candle-' + safe + '.png', c.name);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-candle]') : null;
    if (!el) return;
    if (el.getAttribute('data-candle') === 'share') shareCandleCard(el.getAttribute('data-book'));
  });
}

if (typeof window !== 'undefined') {
  window.bookCandle = bookCandle;
  window.candleName = candleName;
  window.candleTint = candleTint;
  window.candleCardHTML = candleCardHTML;
  window.drawCandleCard = drawCandleCard;
  window.shareCandleCard = shareCandleCard;
}
if (typeof module !== 'undefined') {
  module.exports = {
    bookCandle: bookCandle, candleName: candleName, candleCardHTML: candleCardHTML,
    drawCandleCard: drawCandleCard, candleTint: candleTint,
    CANDLE_TABLE: CANDLE_TABLE, CANDLE_TABLE_VERSION: CANDLE_TABLE_VERSION,
    CANDLE_NAME_PATTERN: CANDLE_NAME_PATTERN,
  };
}
})();
