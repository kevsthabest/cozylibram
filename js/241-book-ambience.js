/* ---- Ambience That Matches the Book (v572): a procedural WebAudio
   soundscape matched to the book on its page. Spec:
   docs/book-ambience-spec.md.

   ZERO audio assets: every sound is synthesized on-device (generated
   noise buffers + oscillators through filters, with slow LFO
   movement). Nothing is licensed, downloaded, fetched, or precached —
   sw.js gains no audio files, and the feature works fully offline.

   The recipe is chosen from the book's own signals with strict
   precedence — setting first, then tropes, then genre — and labelled
   inspired-by ("Inspired by this book's setting · Dark Academia").
   Only the reader's local record is read (the same user-then-pipeline
   trope merge the Portrait and the Candle use), so the match is the
   same on every device. When no signal maps, there is NO book claim:
   the sheet offers the generic house set (Rain, Fireplace, Library,
   Night) as everyday ambience, plainly framed as unmatched.

   Playback NEVER starts on its own: an AudioContext is constructed
   lazily inside ambienceStart, which is reachable only from the
   reader's explicit play controls (the book-page entry, the sheet,
   the mini-control). Ambience keeps playing across in-app navigation
   behind a small persistent mini-control, and the context is closed
   on stop and on pagehide — it stops cleanly when the app closes.

   There is deliberately no auto-off / countdown control of any kind
   (spec section 6): ambience is a reading ritual, not a productivity
   tool.

   The volume is a reader detail: it persists on-device at
   'cozylibram.ambience.volume' and roams in the user_state prefs
   section (js/229 — a new key there, per the constraints; the frozen
   settings snapshot is untouched). js/229 reads it at collect time;
   this module reads it live at start and on slider input, the same
   point-of-use pattern as the other prefs keys.
*/
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Module scope replaces the old IIFE wrapper; the public surface is
   exported in place and the window block at the bottom (unchanged from
   the classic file) is the compatibility bridge, so classic scripts
   keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
'use strict';

var AMBIENCE_TABLE_VERSION = 1;
var AMBIENCE_VOLUME_KEY = 'cozylibram.ambience.volume';
var AMBIENCE_DEFAULT_VOLUME = 0.8;

/* ---------- drift limits: movement, never pulse ----------
   The v572 ship throbbed on a real device ("wub wub wub" in every
   recipe): the noise loop was 2 s (its loudness contour repeating at
   0.5 Hz in the brown bed every recipe carries), and gain LFOs swept
   down to base*(1-2*amount) — through zero at amount >= 0.5 — at
   depths to 0.55. The bounds below are the fix, enforced twice: the
   catalogue declares within them, and ambienceLFO() clamps any
   descriptor to them at build time, so no future recipe can emit a
   throb either. Continuous movement is DRIFT (period >= 20 s, gain
   depth <= 0.30 around a centre that keeps the sweep inside
   [base*(1-depth), base]). The one exception is a square-wave LFO,
   which is not movement but an event GATE (fire crackle, crickets,
   birdsong chirps) and is allowed full on/off depth only on whisper
   layers (gain <= gateMaxLayerGain); anywhere else it is demoted
   to drift like everything else. */
var AMBIENCE_LIMITS = {
  minBufferSeconds: 8,   // noise loop length; the contour must not repeat audibly
  fadeSeconds: 2,        // loop crossfade: the wrap is a step like any other
  driftMaxRate: 0.05,    // Hz — continuous LFOs are slower than 20 s per cycle
  driftGainMaxDepth: 0.3,
  driftFreqMaxDepth: 0.35,
  gateMaxLayerGain: 0.05,
};

/* ---------- the recipe catalogue (v1: eight, per spec) ----------
   Each recipe is a stack of procedural layers:
     { src:'noise', color:'white'|'brown', filter:{type, freq, q},
       gain, lfo? }
     { src:'tone', wave, freq, gain, lfo? }
   lfo: { rate (Hz), amount (0..1 of the base value), wave?,
          target:'gain'|'freq' } — drift within AMBIENCE_LIMITS, so
          no bed sits still and no bed pulses.
   Layers are data; ambienceBuildGraph interprets them against any
   WebAudio-like context, which is what the test suite drives. */
var AMBIENCE_RECIPES = {
  rain: {
    name: 'Rain on the Windows',
    blurb: 'Steady rain on glass and stone, swelling and easing.',
    layers: [
      { src: 'noise', color: 'brown', filter: { type: 'lowpass', freq: 820 }, gain: 0.50, lfo: { rate: 0.03, amount: 0.25, target: 'gain' } },
      { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 1900, q: 0.4 }, gain: 0.11, lfo: { rate: 0.045, amount: 0.25, target: 'gain' } },
      { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 3400, q: 0.8 }, gain: 0.035, lfo: { rate: 0.04, amount: 0.3, target: 'freq' } },
    ],
  },
  fireplace: {
    name: 'By the Fireplace',
    blurb: 'A low fire bed with soft, irregular crackle.',
    layers: [
      { src: 'noise', color: 'brown', filter: { type: 'lowpass', freq: 420 }, gain: 0.52, lfo: { rate: 0.04, amount: 0.25, target: 'gain' } },
      { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 2600, q: 1.2 }, gain: 0.045, lfo: { rate: 6.3, amount: 1, wave: 'square', target: 'gain' } },
      { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 1800, q: 1.6 }, gain: 0.03, lfo: { rate: 2.7, amount: 1, wave: 'square', target: 'gain' } },
    ],
  },
  ocean: {
    name: 'Waves on the Shore',
    blurb: 'Slow surf swells rolling in and drawing back.',
    layers: [
      { src: 'noise', color: 'brown', filter: { type: 'lowpass', freq: 480 }, gain: 0.52, lfo: { rate: 0.035, amount: 0.3, target: 'gain' } },
      { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 760, q: 0.5 }, gain: 0.14, lfo: { rate: 0.045, amount: 0.3, target: 'freq' } },
    ],
  },
  forest: {
    name: 'Forest Air',
    blurb: 'Leaves in a light wind, distant birds now and then.',
    layers: [
      { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 2400, q: 0.35 }, gain: 0.07, lfo: { rate: 0.04, amount: 0.25, target: 'gain' } },
      { src: 'noise', color: 'brown', filter: { type: 'lowpass', freq: 300 }, gain: 0.22 },
      { src: 'tone', wave: 'sine', freq: 2900, gain: 0.011, lfo: { rate: 0.31, amount: 1, wave: 'square', target: 'gain' } },
      { src: 'tone', wave: 'sine', freq: 3400, gain: 0.008, lfo: { rate: 0.17, amount: 1, wave: 'square', target: 'gain' } },
    ],
  },
  night: {
    name: 'Night Insects',
    blurb: 'Warm dark, and crickets keeping time.',
    layers: [
      { src: 'noise', color: 'brown', filter: { type: 'lowpass', freq: 260 }, gain: 0.16 },
      { src: 'tone', wave: 'sine', freq: 4300, gain: 0.013, lfo: { rate: 11, amount: 1, wave: 'square', target: 'gain' } },
      { src: 'tone', wave: 'sine', freq: 4700, gain: 0.009, lfo: { rate: 8.3, amount: 1, wave: 'square', target: 'gain' } },
    ],
  },
  cafe: {
    name: 'Café Murmur',
    blurb: 'The low wash of a busy room, no voice quite distinct.',
    layers: [
      { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 520, q: 0.7 }, gain: 0.20, lfo: { rate: 0.028, amount: 0.22, target: 'gain' } },
      { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 880, q: 0.9 }, gain: 0.10, lfo: { rate: 0.041, amount: 0.25, target: 'gain' } },
      { src: 'noise', color: 'brown', filter: { type: 'lowpass', freq: 240 }, gain: 0.18 },
    ],
  },
  ship: {
    name: 'Low Ship Hum',
    blurb: 'Engines through the hull, and air moving somewhere.',
    layers: [
      { src: 'tone', wave: 'sine', freq: 55, gain: 0.17, lfo: { rate: 0.03, amount: 0.2, target: 'gain' } },
      { src: 'tone', wave: 'sine', freq: 110, gain: 0.06 },
      { src: 'noise', color: 'brown', filter: { type: 'lowpass', freq: 240 }, gain: 0.13, lfo: { rate: 0.035, amount: 0.25, target: 'gain' } },
    ],
  },
  library: {
    name: 'Library Quiet',
    blurb: 'Barely there: room tone and the hush of a big quiet room.',
    layers: [
      { src: 'noise', color: 'brown', filter: { type: 'lowpass', freq: 210 }, gain: 0.11, lfo: { rate: 0.025, amount: 0.2, target: 'gain' } },
      { src: 'noise', color: 'white', filter: { type: 'highpass', freq: 6200 }, gain: 0.004 },
    ],
  },
};
/* The generic house set for thin-signal books (spec order). */
var AMBIENCE_HOUSE = ['rain', 'fireplace', 'library', 'night'];

/* ---------- signal maps: canonical trope id / genre -> recipe ----------
   Setting keys are the setting-flavoured canonical tropes (the same
   family the Candle keys as its base layer). A key present in BOTH
   maps counts as setting — precedence is by pass order below, and
   the maps are kept disjoint so a signal is never double-counted. */
var AMBIENCE_SETTING = {
  'space-opera': 'ship', 'generation-ship': 'ship',
  'dark-academia': 'library', 'magic-academy': 'library', 'locked-room': 'library',
  'haunted-house': 'rain', 'small-town-secrets': 'rain', 'cyberpunk': 'rain',
  'portal-fantasy': 'forest', 'quest': 'forest',
  'royalty': 'fireplace',
  'small-town': 'cafe', 'workplace-romance': 'cafe', 'mafia': 'cafe', 'road-trip': 'cafe',
  'war-story': 'night', 'dystopia': 'night', 'biker': 'night',
};
var AMBIENCE_TROPE = {
  'vampire': 'night', 'werewolf': 'forest', 'shifter': 'forest',
  'folk-horror': 'forest', 'cosmic-horror': 'night', 'ghost-hunter': 'night',
  'possession': 'night', 'final-girl': 'night', 'body-horror': 'night',
  'faceless-enemy': 'night', 'dead-mans-switch': 'night', 'dark-lord': 'night',
  'revenge': 'night', 'stalker': 'night', 'captive': 'night',
  'kidnapping': 'night', 'serial-killer': 'night', 'double-cross': 'night',
  'betrayal': 'night', 'secret-identity': 'night', 'bully': 'night',
  'morally-grey': 'night',
  'dragons': 'fireplace', 'found-family': 'fireplace', 'forced-proximity': 'fireplace',
  'slow-burn': 'fireplace', 'fated-mates': 'fireplace', 'forbidden-love': 'fireplace',
  'secret-relationship': 'fireplace', 'protective-partner': 'fireplace',
  'single-dad': 'fireplace', 'arranged-marriage': 'fireplace', 'pregnancy': 'fireplace',
  'secret-baby': 'fireplace', 'age-gap': 'fireplace', 'sacrifice': 'fireplace',
  'family-drama': 'fireplace',
  'grumpy-x-sunshine': 'cafe', 'heist': 'cafe', 'fake-dating': 'cafe',
  'friends-to-lovers': 'cafe', 'billionaire': 'cafe', 'stepbrother': 'cafe',
  'whodunit': 'library', 'cold-case': 'library', 'conspiracy': 'library',
  'unreliable-narrator': 'library', 'time-travel': 'library', 'mentorship': 'library',
  'political-intrigue': 'library', 'hard-magic': 'library', 'mind-game': 'library',
  'memoir': 'library', 'true-crime': 'library', 'marriage-of-convenience': 'library',
  'ai-uprising': 'ship', 'first-contact': 'ship', 'alien-invasion': 'ship',
  'second-chance': 'rain', 'enemies-to-lovers': 'rain', 'missing-person': 'rain',
  'amnesia': 'rain', 'redemption': 'rain', 'survivor-guilt': 'rain',
  'love-triangle': 'rain',
  'prophecy': 'forest', 'chosen-one': 'forest', 'hidden-powers': 'forest',
  'unlikely-alliance': 'forest', 'deadly-trials': 'forest',
  'reluctant-hero': 'forest', 'coming-of-age': 'forest', 'epic-battle': 'night',
};
var AMBIENCE_GENRE = {
  'fantasy': 'forest', 'young adult': 'forest', 'adventure': 'ocean',
  'romantasy': 'fireplace', 'romance': 'fireplace', 'historical': 'fireplace',
  'historical fiction': 'fireplace',
  'dark romance': 'night', 'horror': 'night', 'paranormal': 'night', 'dystopian': 'night',
  'science fiction': 'ship', 'sci-fi': 'ship', 'science-fiction': 'ship', 'scifi': 'ship',
  'mystery': 'library', 'literary fiction': 'library', 'non-fiction': 'library',
  'nonfiction': 'library', 'biography': 'library', 'memoir': 'library',
  'cozy mystery': 'rain', 'thriller': 'rain', 'gothic': 'rain',
  'contemporary': 'cafe', 'humor': 'cafe', 'humour': 'cafe', 'comedy': 'cafe',
};

/* ---------- keying (the Candle's helpers, same discipline) ---------- */
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
/* The local trope view (user first, then pipeline AI), deduped
   case-insensitively — raw display strings kept for labels. */
function localTropeNames(b) {
  var out = [], seen = {};
  ((b && b.tropes) || []).concat((b && b.tropesAI) || []).forEach(function (t) {
    t = String(t || '').trim(); if (!t) return;
    var k = t.toLowerCase();
    if (!seen[k]) { seen[k] = 1; out.push(t); }
  });
  return out;
}

/* ---------- selection (pure): setting > trope > genre ---------- */
function ambienceSelect(b) {
  b = b || {};
  var names = localTropeNames(b);
  var options = [], firstSource = {};
  function offer(recipe, source) {
    if (!recipe || !AMBIENCE_RECIPES[recipe]) return;
    if (!firstSource[recipe]) firstSource[recipe] = source;
    if (options.indexOf(recipe) === -1) options.push(recipe);
  }
  // pass 1: setting signals, in the book's trope order
  names.forEach(function (n) {
    var id = tropeKey(n);
    if (AMBIENCE_SETTING[id]) offer(AMBIENCE_SETTING[id], { kind: 'setting', value: n, id: id });
  });
  // pass 2: trope signals
  names.forEach(function (n) {
    var id = tropeKey(n);
    if (AMBIENCE_TROPE[id]) offer(AMBIENCE_TROPE[id], { kind: 'trope', value: n, id: id });
  });
  // pass 3: genre signals, in the book's genre order
  var genres = [];
  try { genres = (typeof bookGenres === 'function') ? (bookGenres(b) || []) : (b.categories || []); } catch (e) { genres = []; }
  genres.forEach(function (g) {
    var gk = normFieldKey(g);
    if (AMBIENCE_GENRE[gk]) offer(AMBIENCE_GENRE[gk], { kind: 'genre', value: String(g) });
  });

  if (!options.length) {
    // Thin data: the house set, and NO claim about this book.
    return {
      recipe: null, source: null, claimed: false,
      options: AMBIENCE_HOUSE.slice(),
      label: 'House sounds — everyday ambience, not matched to this book.',
    };
  }
  var primary = options[0], src = firstSource[primary];
  var layerWord = src.kind === 'setting' ? 'setting' : (src.kind === 'trope' ? 'tropes' : 'genre');
  return {
    recipe: primary, source: src, claimed: true,
    options: options,
    label: 'Inspired by this book\u2019s ' + layerWord + ' · ' + src.value,
  };
}

/* ---------- volume (persisted; roams via the prefs section) ---------- */
function ambienceVolume() {
  try {
    var raw = localStorage.getItem(AMBIENCE_VOLUME_KEY);
    if (raw == null) return AMBIENCE_DEFAULT_VOLUME;
    var v = parseFloat(raw);
    if (isNaN(v)) return AMBIENCE_DEFAULT_VOLUME;
    return Math.min(1, Math.max(0, v));
  } catch (e) { return AMBIENCE_DEFAULT_VOLUME; }
}
function volumeCurve(v) { return v * v; }
function ambienceSetVolume(v) {
  var n = parseFloat(v);
  if (isNaN(n)) return ambienceVolume();
  n = Math.min(1, Math.max(0, n));
  try { localStorage.setItem(AMBIENCE_VOLUME_KEY, String(Math.round(n * 100) / 100)); } catch (e) {}
  // Roam it (hash-gated inside userStatePush; a no-op signed out).
  try { if (typeof userStatePush === 'function') userStatePush(); } catch (e) {}
  if (amb.ctx && amb.graph) {
    try { amb.graph.master.gain.setTargetAtTime(volumeCurve(n), amb.ctx.currentTime, 0.03); } catch (e) {}
  }
  return n;
}

/* ---------- the engine: a recipe -> a live graph ----------
   Interprets the layer descriptors against any WebAudio-like
   context. Every sound source is a generated buffer or an
   oscillator — there is no load path at all. */
/* Noise loops are LONG (AMBIENCE_LIMITS.minBufferSeconds) and
   seamless: the process is generated past the end of the buffer and
   the head crossfades into its own continuation, so the wrap point is
   a step like any other instead of a state jump. The v572 buffer was
   2 s looped raw: its loudness contour repeated at 0.5 Hz in the
   brown bed of every recipe — half of the shipped throb. */
function noiseBuffer(ctx, color) {
  var len = Math.floor(AMBIENCE_LIMITS.minBufferSeconds * ctx.sampleRate);
  var fade = Math.floor(AMBIENCE_LIMITS.fadeSeconds * ctx.sampleRate);
  var buf = ctx.createBuffer(1, len, ctx.sampleRate);
  var d = buf.getChannelData(0);
  var total = len + fade;
  var gen = new Float32Array(total);
  var s = 22222, last = 0;
  function rnd() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x40000000 - 1; }
  for (var i = 0; i < total; i++) {
    var w = rnd();
    if (color === 'brown') { last = (last + 0.02 * w) / 1.02; gen[i] = last * 3.2; }
    else gen[i] = w * 0.7;
  }
  for (i = 0; i < len; i++) {
    if (i < fade) { var t = i / fade; d[i] = gen[len + i] * (1 - t) + gen[i] * t; }
    else d[i] = gen[i];
  }
  return buf;
}
/* The one place a descriptor's LFO becomes an emitted LFO. A square
   wave on a whisper layer is an event gate and keeps full depth;
   anything else is clamped to drift: rate and depth inside
   AMBIENCE_LIMITS, wave forced to sine. */
function ambienceLFO(layer) {
  var lfo = layer.lfo;
  if (!lfo) return null;
  var wave = lfo.wave || 'sine';
  if (wave === 'square' && lfo.target !== 'freq' &&
      layer.gain <= AMBIENCE_LIMITS.gateMaxLayerGain) {
    return { rate: lfo.rate, amount: 1, wave: 'square', target: lfo.target, gate: true };
  }
  return {
    rate: Math.min(Math.max(0.001, lfo.rate || 0), AMBIENCE_LIMITS.driftMaxRate),
    amount: Math.min(Math.max(0, lfo.amount || 0),
      lfo.target === 'freq' ? AMBIENCE_LIMITS.driftFreqMaxDepth : AMBIENCE_LIMITS.driftGainMaxDepth),
    wave: 'sine', target: lfo.target, gate: false,
  };
}
function ambienceBuildGraph(ctx, recipe) {
  var buffers = {};
  var noiseStarts = 0;
  var master = ctx.createGain();
  master.gain.value = 0; // the engine ramps it in (no click, no blast)
  master.connect(ctx.destination);
  var nodes = [], sources = [], stopped = false;

  function wireLFO(param, base, lfo) {
    var osc = ctx.createOscillator();
    osc.type = lfo.wave || 'sine';
    osc.frequency.value = lfo.rate;
    var depth = ctx.createGain();
    var amount = Math.min(1, Math.max(0, lfo.amount || 0));
    if (lfo.target === 'freq') {
      depth.gain.value = base * amount;
    } else {
      // Centre the sweep on base*(1 - amount/2) so gain moves inside
      // [base*(1-amount), base]: it can breathe but never cross zero
      // (the v572 wiring centred on base*(1-amount) and swept a full
      // +/- base*amount, dipping to base*(1-2*amount)).
      param.value = base * (1 - amount / 2);
      depth.gain.value = base * amount / 2;
    }
    osc.connect(depth);
    depth.connect(param);
    nodes.push(osc, depth); sources.push(osc);
    osc.start();
  }

  (recipe.layers || []).forEach(function (layer) {
    var g = ctx.createGain();
    g.gain.value = layer.gain;
    var head = g;
    if (layer.src === 'noise') {
      if (!buffers[layer.color]) buffers[layer.color] = noiseBuffer(ctx, layer.color);
      var src = ctx.createBufferSource();
      src.buffer = buffers[layer.color];
      src.loop = true;
      var f = ctx.createBiquadFilter();
      f.type = layer.filter.type;
      f.frequency.value = layer.filter.freq;
      if (layer.filter.q) f.Q.value = layer.filter.q;
      src.connect(f); f.connect(g);
      nodes.push(src, f); sources.push(src);
      head = f;
      // Layers sharing one colour buffer start at spread offsets, so
      // the same loop never runs sample-identical in two layers.
      src.start(0, (noiseStarts++ * 2.93) % AMBIENCE_LIMITS.minBufferSeconds);
    } else { // tone
      var osc = ctx.createOscillator();
      osc.type = layer.wave || 'sine';
      osc.frequency.value = layer.freq;
      osc.connect(g);
      nodes.push(osc); sources.push(osc);
      head = osc;
      osc.start();
    }
    g.connect(master);
    nodes.push(g);
    if (layer.lfo) {
      var lfo = ambienceLFO(layer);
      if (lfo) {
        if (lfo.target === 'freq' && layer.src === 'noise') wireLFO(head.frequency, layer.filter.freq, lfo);
        else wireLFO(g.gain, layer.gain, lfo);
      }
    }
  });

  return {
    master: master,
    stop: function () {
      if (stopped) return;
      stopped = true;
      sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
      nodes.forEach(function (n) { try { n.disconnect(); } catch (e) {} });
      try { master.disconnect(); } catch (e) {}
    },
  };
}

/* ---------- player state ---------- */
var amb = { ctx: null, graph: null, bookId: null, title: '', sel: null, options: [], idx: 0, playing: false };
var focus = { bookId: null, title: '', sel: null, idx: 0 }; // the sheet's book, before anything plays

export function ambienceState() {
  return {
    ctxCreated: !!amb.ctx,
    playing: amb.playing,
    recipeId: amb.bookId ? amb.options[amb.idx] || null : null,
    bookId: amb.bookId,
  };
}
function findBook(id) {
  try {
    var lib = (typeof library !== 'undefined') ? library : [];
    for (var i = 0; i < lib.length; i++) if (lib[i] && lib[i].id === id) return lib[i];
  } catch (e) {}
  return null;
}
function lazyCtx() {
  if (amb.ctx) return amb.ctx;
  var AC = (typeof window !== 'undefined') ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!AC) return null;
  amb.ctx = new AC();
  return amb.ctx;
}
function teardownGraph() {
  if (amb.graph) { try { amb.graph.stop(); } catch (e) {} amb.graph = null; }
}
function buildFor(recipeId) {
  var ctx = amb.ctx;
  teardownGraph();
  amb.graph = ambienceBuildGraph(ctx, AMBIENCE_RECIPES[recipeId]);
  amb.graph.master.gain.setTargetAtTime(volumeCurve(ambienceVolume()), ctx.currentTime, 0.4);
}

/* The ONLY entry into playback — called exclusively by the explicit
   play controls (entry toggle, sheet play, mini toggle). */
function ambienceStart(book, recipeId) {
  if (!book) return false;
  var ctx = lazyCtx();
  if (!ctx) { try { toast('Audio isn\u2019t available on this device'); } catch (e) {} return false; }
  var sel = ambienceSelect(book);
  var options = sel.options.slice();
  var target = recipeId || sel.recipe || options[0];
  var idx = options.indexOf(target);
  if (idx === -1) { options.unshift(target); idx = 0; }
  amb.bookId = book.id; amb.title = book.title || '';
  amb.sel = sel; amb.options = options; amb.idx = idx;
  buildFor(target);
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
  amb.playing = true;
  paintAmbience();
  return true;
}
function ambiencePause() {
  if (!amb.ctx) return;
  try { amb.ctx.suspend(); } catch (e) {}
  amb.playing = false;
  paintAmbience();
}
function ambienceResume() {
  if (!amb.ctx || !amb.graph) return;
  try { amb.ctx.resume(); } catch (e) {}
  amb.playing = true;
  paintAmbience();
}
export function ambienceStopAll() {
  if (amb.graph && amb.ctx) {
    try { amb.graph.master.gain.setTargetAtTime(0, amb.ctx.currentTime, 0.03); } catch (e) {}
  }
  teardownGraph();
  if (amb.ctx) { try { amb.ctx.close(); } catch (e) {} amb.ctx = null; }
  amb.bookId = null; amb.title = ''; amb.sel = null; amb.options = []; amb.idx = 0; amb.playing = false;
  paintAmbience();
}
export function ambienceToggleFor(book) {
  if (!book) return;
  if (amb.bookId === book.id && amb.graph) {
    if (amb.playing) ambiencePause(); else ambienceResume();
  } else ambienceStart(book);
}
function ambienceSwitch(recipeId) {
  // Act on whatever the sheet is showing (ambienceView resolves it):
  // the live session when the sheet is about the playing book —
  // rebuild the graph on the new bed, pause state preserved — or
  // just the sheet's pending pick when nothing has started yet.
  var view = ambienceView();
  if (!view) return;
  if (view.started) {
    var idx = amb.options.indexOf(recipeId);
    if (idx === -1) return;
    amb.idx = idx;
    buildFor(recipeId);
    paintAmbience();
  } else {
    var fi = focus.sel.options.indexOf(recipeId);
    if (fi !== -1) focus.idx = fi;
    paintAmbience();
  }
}
function ambienceCycle() {
  var view = ambienceView();
  if (!view || view.options.length < 2) return;
  ambienceSwitch(view.options[(view.idx + 1) % view.options.length]);
}

/* ---------- the book-page entry (rendered by js/150) ---------- */
export function ambienceEntryHTML(b) {
  if (!b) return '';
  var sel = ambienceSelect(b);
  var isThis = amb.bookId === b.id && !!amb.graph;
  var small = sel.claimed
    ? AMBIENCE_RECIPES[sel.recipe].name + ' · from this book\u2019s ' + sel.source.kind
    : 'House sounds · pick a mood';
  return '<div class="amb-entry">' +
    '<button class="slimbar amb-open" data-amb="open" data-book="' + esc(b.id || '') + '">' +
    '<span class="slim-ic">' + icon('audio') + '</span>' +
    '<span class="slimbar-main"><b>Ambience</b><small>' + esc(small) + '</small></span>' +
    '<span class="mrow-chev">›</span></button>' +
    '<button class="amb-entry-play" data-amb="toggle" data-book="' + esc(b.id || '') + '"' +
    ' aria-label="' + (isThis && amb.playing ? 'Pause ambience' : 'Play ambience for this book') + '">' +
    icon(isThis && amb.playing ? 'pause' : 'play') + '</button></div>';
}

/* ---------- the sheet + the mini-control (DOM; guarded) ---------- */
function ambienceView() {
  // A sheet opened for a DIFFERENT book than the one playing is about
  // that book (a pending pick), not about the live session.
  if (focus.bookId && focus.bookId !== amb.bookId)
    return { bookId: focus.bookId, title: focus.title, sel: focus.sel, options: focus.sel.options, idx: focus.idx, started: false, playing: false };
  if (amb.bookId) return { bookId: amb.bookId, title: amb.title, sel: amb.sel, options: amb.options, idx: amb.idx, started: true, playing: amb.playing };
  if (focus.bookId) return { bookId: focus.bookId, title: focus.title, sel: focus.sel, options: focus.sel.options, idx: focus.idx, started: false, playing: false };
  return null;
}
export function openAmbienceSheet(bookId) {
  if (typeof document === 'undefined') return;
  var book = findBook(bookId);
  if (amb.bookId === bookId && amb.graph) {
    // the live session is the sheet's subject; focus follows it
    focus.bookId = amb.bookId; focus.title = amb.title; focus.sel = amb.sel; focus.idx = amb.idx;
  } else if (book) {
    focus.bookId = book.id; focus.title = book.title || '';
    focus.sel = ambienceSelect(book); focus.idx = 0;
  } else if (!focus.bookId) return;
  closeAmbienceSheet();
  var scrim = document.createElement('div');
  scrim.className = 'amb-scrim'; scrim.id = 'ambScrim';
  var sheet = document.createElement('div');
  sheet.className = 'amb-sheet'; sheet.id = 'ambSheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Ambience');
  sheet.innerHTML =
    '<div class="sheet-grabber" aria-hidden="true"></div>' +
    '<h3 class="serif" style="margin:0 0 2px">Ambience</h3>' +
    '<p class="note amb-for" id="ambFor"></p>' +
    '<div class="amb-recipe serif" id="ambRecipeName"></div>' +
    '<p class="note amb-src" id="ambSrcLine"></p>' +
    '<div class="amb-chips" id="ambChips"></div>' +
    '<div class="amb-controls">' +
    '<button class="btn amb-play" id="ambPlayBtn" data-amb="playpause"></button>' +
    '<button class="btn ghost" data-amb="cycle">A different mood</button>' +
    '</div>' +
    '<label class="amb-vol"><span>Volume</span>' +
    '<input type="range" min="0" max="100" step="1" data-amb="vol" aria-label="Ambience volume"></label>' +
    '<p class="note amb-note">Sounds are generated on this device — nothing is downloaded, and nothing plays until you press play.</p>';
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { sheet.classList.add('open'); });
  else sheet.classList.add('open');
  var vol = sheet.querySelector('[data-amb="vol"]');
  if (vol) vol.value = String(Math.round(ambienceVolume() * 100));
  var closeDom = function () {
    ['ambScrim', 'ambSheet'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  };
  var token = null;
  try { if (typeof overlayOpened === 'function') token = overlayOpened('sheet', closeDom); } catch (e) {}
  var close = function () {
    try { if (token != null && typeof overlayClosed === 'function') overlayClosed(token); } catch (e) {}
    closeDom();
  };
  sheet._ambClose = close;
  scrim.addEventListener('click', close);
  var onKey = function (e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  if (typeof wireSheetDrag === 'function') wireSheetDrag(sheet, close);
  paintAmbienceSheet();
}
function closeAmbienceSheet() {
  if (typeof document === 'undefined') return;
  var sheet = document.getElementById('ambSheet');
  if (sheet && sheet._ambClose) { sheet._ambClose(); return; }
  ['ambScrim', 'ambSheet'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
}
function paintAmbienceSheet() {
  if (typeof document === 'undefined') return;
  var sheet = document.getElementById('ambSheet');
  if (!sheet) return;
  var view = ambienceView();
  if (!view) return;
  var recipe = AMBIENCE_RECIPES[view.options[view.idx]];
  var forEl = document.getElementById('ambFor');
  if (forEl) forEl.innerHTML = 'for <b>' + esc(view.title || 'this book') + '</b>';
  var nameEl = document.getElementById('ambRecipeName');
  if (nameEl) nameEl.textContent = recipe.name;
  var srcEl = document.getElementById('ambSrcLine');
  if (srcEl) srcEl.textContent = view.sel.claimed ? view.sel.label : 'House sounds — this book\u2019s signals are quiet, so these make no claim to match it. Pick the room you want to read in.';
  var chips = document.getElementById('ambChips');
  if (chips) {
    chips.innerHTML = view.options.map(function (id, i) {
      return '<button class="chip amb-chip' + (i === view.idx ? ' on' : '') + '" data-amb="chip" data-recipe="' + id + '">' +
        esc(AMBIENCE_RECIPES[id].name) + '</button>';
    }).join('');
  }
  var playBtn = document.getElementById('ambPlayBtn');
  if (playBtn) {
    playBtn.innerHTML = view.started && view.playing
      ? icon('pause') + '<span>Pause</span>'
      : icon('play') + '<span>Play</span>';
  }
}
function ensureMini() {
  var el = document.getElementById('ambMini');
  if (el) return el;
  el = document.createElement('div');
  el.className = 'amb-mini'; el.id = 'ambMini'; el.hidden = true;
  el.innerHTML =
    '<button class="amb-mini-main" data-amb="reopen" aria-label="Open ambience controls">' +
    '<span class="amb-mini-ic">' + icon('audio') + '</span>' +
    '<span class="amb-mini-txt"><b id="ambMiniName"></b><small id="ambMiniBook"></small></span></button>' +
    '<button class="amb-mini-btn" data-amb="toggle-current" id="ambMiniToggle" aria-label="Pause ambience">' + icon('pause') + '</button>' +
    '<button class="amb-mini-btn" data-amb="stop" aria-label="Stop ambience">✕</button>';
  document.body.appendChild(el);
  return el;
}
function paintAmbience() {
  if (typeof document === 'undefined') return;
  var mini = ensureMini();
  if (amb.bookId && amb.graph) {
    mini.hidden = false;
    var recipe = AMBIENCE_RECIPES[amb.options[amb.idx]];
    var nameEl = document.getElementById('ambMiniName');
    if (nameEl) nameEl.textContent = recipe ? recipe.name : '';
    var bookEl = document.getElementById('ambMiniBook');
    if (bookEl) bookEl.textContent = amb.title || '';
    var tog = document.getElementById('ambMiniToggle');
    if (tog) {
      tog.innerHTML = icon(amb.playing ? 'pause' : 'play');
      tog.setAttribute('aria-label', amb.playing ? 'Pause ambience' : 'Resume ambience');
    }
  } else {
    mini.hidden = true;
  }
  // keep any visible book-page entries honest about play state
  try {
    document.querySelectorAll('[data-amb="toggle"]').forEach(function (btn) {
      var isThis = amb.bookId === btn.getAttribute('data-book') && !!amb.graph;
      btn.innerHTML = icon(isThis && amb.playing ? 'pause' : 'play');
      btn.setAttribute('aria-label', isThis && amb.playing ? 'Pause ambience' : 'Play ambience for this book');
    });
  } catch (e) {}
  paintAmbienceSheet();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-amb]') : null;
    if (!el) return;
    var action = el.getAttribute('data-amb');
    if (action === 'open') openAmbienceSheet(el.getAttribute('data-book'));
    else if (action === 'toggle') ambienceToggleFor(findBook(el.getAttribute('data-book')));
    else if (action === 'toggle-current') { var b = findBook(amb.bookId); if (b) ambienceToggleFor(b); else ambienceStopAll(); }
    else if (action === 'playpause') {
      var view = ambienceView();
      if (!view) return;
      if (view.started) { if (view.playing) ambiencePause(); else ambienceResume(); }
      else ambienceStart(findBook(view.bookId), view.options[view.idx]);
    }
    else if (action === 'cycle') ambienceCycle();
    else if (action === 'chip') ambienceSwitch(el.getAttribute('data-recipe'));
    else if (action === 'stop') ambienceStopAll();
    else if (action === 'reopen') { if (amb.bookId) openAmbienceSheet(amb.bookId); }
  });
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el && el.getAttribute && el.getAttribute('data-amb') === 'vol') {
      ambienceSetVolume(parseFloat(el.value) / 100);
    }
  });
}
if (typeof window !== 'undefined' && window.addEventListener) {
  // Stops cleanly when the app closes: the context dies with the page.
  window.addEventListener('pagehide', function () {
    teardownGraph();
    if (amb.ctx) { try { amb.ctx.close(); } catch (e) {} amb.ctx = null; }
    amb.playing = false;
  });
}

if (typeof window !== 'undefined') {
  window.ambienceEntryHTML = ambienceEntryHTML;
  window.openAmbienceSheet = openAmbienceSheet;
  window.ambienceToggleFor = ambienceToggleFor;
  window.ambienceStopAll = ambienceStopAll;
  window.ambienceState = ambienceState;
}
if (typeof module !== 'undefined') {
  module.exports = {
    AMBIENCE_RECIPES: AMBIENCE_RECIPES, AMBIENCE_HOUSE: AMBIENCE_HOUSE,
    AMBIENCE_LIMITS: AMBIENCE_LIMITS,
    AMBIENCE_TABLE_VERSION: AMBIENCE_TABLE_VERSION,
    AMBIENCE_VOLUME_KEY: AMBIENCE_VOLUME_KEY,
    ambienceSelect: ambienceSelect, ambienceEntryHTML: ambienceEntryHTML,
    ambienceBuildGraph: ambienceBuildGraph,
    ambienceVolume: ambienceVolume, ambienceSetVolume: ambienceSetVolume,
    ambienceStart: ambienceStart, ambiencePause: ambiencePause,
    ambienceResume: ambienceResume, ambienceStopAll: ambienceStopAll,
    ambienceToggleFor: ambienceToggleFor, ambienceState: ambienceState,
  };
}
