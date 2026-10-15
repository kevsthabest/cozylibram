// Tests for "Ambience That Matches the Book" (spec: docs/book-ambience-spec.md).
// Pins: recipe-selection precedence (setting > trope > genre), the honest
// thin-data fallback (house set, NO book-specific claim), the inspired-by
// label, the procedural graph's shape (asset-free: generated buffers and
// oscillators only), NO autoplay (an AudioContext exists only after the
// explicit start action), volume persistence on the roaming prefs key,
// and the three PWA touchpoints with zero audio assets in sw.js.
// WebAudio cannot run in node: the engine is driven against a recording
// stub context — everything decidable without a real AudioContext is
// pinned here; the sound itself is device-verified (stated in the PR).
'use strict';

let _pass = 0, _fail = 0;
function ok(name, cond) {
  if (cond) { _pass++; }
  else { _fail++; console.log('FAIL - ' + name); }
}
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';

/* ---------- recording stub AudioContext ---------- */
function makeStubCtx() {
  const rec = { created: [], connections: [], started: [], stopped: [], buffers: 0, suspends: 0, resumes: 0, closes: 0 };
  function param() {
    return { __isParam: true, value: 0,
      setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} };
  }
  function node(kind) {
    const n = { kind: kind, gain: param(), frequency: param(), Q: param(), type: '', buffer: null, loop: false,
      connect(dst) { rec.connections.push({ from: kind, to: dst && dst.__isParam ? 'param' : (dst && dst.kind) || 'destination' }); },
      disconnect() {},
      start() { rec.started.push(kind); }, stop() { rec.stopped.push(kind); } };
    rec.created.push(n);
    return n;
  }
  const ctx = {
    currentTime: 0, sampleRate: 44100, state: 'running',
    destination: { kind: 'destination' },
    createBuffer(ch, len) { rec.buffers++; return { __generated: true, getChannelData() { return new Float32Array(len); } }; },
    createBufferSource() { return node('bufferSource'); },
    createOscillator() { return node('oscillator'); },
    createBiquadFilter() { return node('filter'); },
    createGain() { return node('gain'); },
    suspend() { rec.suspends++; ctx.state = 'suspended'; return Promise.resolve(); },
    resume() { rec.resumes++; ctx.state = 'running'; return Promise.resolve(); },
    close() { rec.closes++; ctx.state = 'closed'; return Promise.resolve(); },
  };
  return { ctx: ctx, rec: rec };
}

/* ---------- module loading (vm, candle-test pattern) ---------- */
const taxSrc = fs.readFileSync(path.join(ROOT, 'js/156-trope-taxonomy.js'), 'utf8');
const taxSandbox = { console: console, window: {}, module: { exports: {} } };
vm.createContext(taxSandbox);
vm.runInContext(taxSrc, taxSandbox, { filename: 'js/156-trope-taxonomy.js' });
const tropeResolveId = taxSandbox.tropeResolveId || vm.runInContext('tropeResolveId', taxSandbox);

let ctxConstructions = 0;
let lastStub = null;
function FakeAudioContext() { ctxConstructions++; lastStub = makeStubCtx(); return lastStub.ctx; }

function loadModule(shared) {
  const sandbox = {
    console: console,
    document: undefined,
    localStorage: shared.ls,
    module: { exports: {} },
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    icon: name => '<svg data-icon="' + name + '"></svg>',
    bookGenres: b => (b.categories || []).slice(),
    tropeResolveId: tropeResolveId,
    userStatePush: shared.push,
    library: shared.library,
    toast: function () {},
  };
  sandbox.window = { AudioContext: FakeAudioContext };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'js/241-book-ambience.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'js/241-book-ambience.js' });
  return sandbox;
}

function makeShared() {
  const store = {};
  return {
    ls: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
      _store: store,
    },
    pushes: 0,
    push: null, // wired below (needs the object itself)
    library: [],
  };
}
const shared = makeShared();
shared.push = function () { shared.pushes++; };

const sbx = loadModule(shared);
const M = sbx.module.exports;
ok('module exports present', !!M && typeof M.ambienceSelect === 'function');
const { AMBIENCE_RECIPES, AMBIENCE_HOUSE, ambienceSelect, ambienceEntryHTML, ambienceBuildGraph } = M;

/* ---------- fixtures ---------- */
const settingBook = { // setting (space-opera -> ship) + trope (slow-burn) + genre (Romance -> fireplace)
  id: 'a1', title: 'Stars and Slow Burns', authors: ['A'],
  tropes: ['Slow Burn'], tropesAI: ['Space Opera'], categories: ['Romance'], moods: [],
};
const tropeBook = { // trope (vampire -> night) + genre (Fantasy -> forest); no setting signal
  id: 'a2', title: 'Fangs', authors: ['B'],
  tropes: ['Vampire'], tropesAI: [], categories: ['Fantasy'], moods: [],
};
const genreBook = { // genre only (Science Fiction -> ship)
  id: 'a3', title: 'Orbital', authors: ['C'],
  tropes: [], tropesAI: [], categories: ['Science Fiction'], moods: [],
};
const coastalBook = { // genre Adventure -> ocean
  id: 'a4', title: 'Salt', authors: ['D'],
  tropes: [], tropesAI: [], categories: ['Adventure'], moods: [],
};
const thinBook = { // nothing maps: unlisted trope + unmapped genre
  id: 'a5', title: 'Obscure', authors: ['E'],
  tropes: [], tropesAI: [], categories: ['Cookbooks'], moods: [],
};

/* ---------- recipe catalogue integrity ---------- */
const recipeIds = Object.keys(AMBIENCE_RECIPES).sort();
eq('catalogue is exactly the v1 eight',
  JSON.stringify(recipeIds),
  JSON.stringify(['cafe', 'fireplace', 'forest', 'library', 'night', 'ocean', 'rain', 'ship']));
ok('every recipe has a name, a blurb, and >= 2 layers',
  recipeIds.every(id => { const r = AMBIENCE_RECIPES[id]; return r.name && r.blurb && Array.isArray(r.layers) && r.layers.length >= 2; }));
ok('every layer is a sane procedural descriptor',
  recipeIds.every(id => AMBIENCE_RECIPES[id].layers.every(l =>
    (l.src === 'noise' || l.src === 'tone') &&
    typeof l.gain === 'number' && l.gain > 0 && l.gain <= 1 &&
    (l.src !== 'noise' || (l.filter && typeof l.filter.freq === 'number')) &&
    (l.src !== 'tone' || typeof l.freq === 'number'))));
eq('house set is the spec four (Rain, Fireplace, Library, Night)',
  JSON.stringify(AMBIENCE_HOUSE), JSON.stringify(['rain', 'fireplace', 'library', 'night']));
ok('house set recipes all exist in the catalogue',
  AMBIENCE_HOUSE.every(id => !!AMBIENCE_RECIPES[id]));

/* ---------- selection precedence: setting > trope > genre ---------- */
const selSetting = ambienceSelect(settingBook);
eq('setting beats trope and genre', selSetting.recipe, 'ship');
eq('setting source kind', selSetting.source && selSetting.source.kind, 'setting');
ok('setting label is an inspired-by book claim naming the setting',
  /Inspired by this book/.test(selSetting.label) && /setting/i.test(selSetting.label));
ok('alternatives keep the lower-precedence matches for "a different mood"',
  selSetting.options.length >= 2 && selSetting.options[0] === 'ship' && selSetting.options.includes('fireplace'));

const selTrope = ambienceSelect(tropeBook);
eq('trope beats genre', selTrope.recipe, 'night');
eq('trope source kind', selTrope.source && selTrope.source.kind, 'trope');
ok('trope label names the trope layer', /Inspired by this book/.test(selTrope.label) && /trope/i.test(selTrope.label));

const selGenre = ambienceSelect(genreBook);
eq('genre decides when nothing higher speaks', selGenre.recipe, 'ship');
eq('genre source kind', selGenre.source && selGenre.source.kind, 'genre');
eq('ocean is reachable (Adventure -> ocean)', ambienceSelect(coastalBook).recipe, 'ocean');

/* ---------- thin data: house set, NO book claim ---------- */
const selThin = ambienceSelect(thinBook);
eq('thin book gets no matched recipe', selThin.recipe, null);
eq('thin selection makes no book claim', selThin.claimed, false);
eq('thin selection offers exactly the house set',
  JSON.stringify(selThin.options), JSON.stringify(AMBIENCE_HOUSE));
ok('thin label carries no inspired-by book claim',
  !/Inspired by this book/.test(selThin.label || ''));

/* ---------- the entry point: label honesty in the HTML ---------- */
const entryFull = ambienceEntryHTML(settingBook);
ok('entry names the matched recipe', entryFull.includes(AMBIENCE_RECIPES.ship.name));
ok('entry carries the inspired-by framing', /from this book/.test(entryFull));
ok('entry has an explicit play control and an open control',
  entryFull.includes('data-amb="toggle"') && entryFull.includes('data-amb="open"'));
const entryThin = ambienceEntryHTML(thinBook);
ok('thin entry offers house sounds', /House sounds/.test(entryThin));
ok('thin entry never claims a book match', !/from this book/.test(entryThin));

/* ---------- the graph: procedural, asset-free, connected ---------- */
const g1 = makeStubCtx();
const graph = ambienceBuildGraph(g1.ctx, AMBIENCE_RECIPES.rain);
ok('graph builds for rain', !!graph && typeof graph.stop === 'function');
const sources = g1.rec.created.filter(n => n.kind === 'bufferSource' || n.kind === 'oscillator');
ok('graph starts sound sources', sources.length >= 2 && g1.rec.started.length >= 2);
ok('every buffer is generated on-device (createBuffer), none loaded',
  g1.rec.buffers >= 1 && g1.rec.created.filter(n => n.kind === 'bufferSource').every(n => n.buffer && n.buffer.__generated));
ok('no source carries a URL/src (asset-free by construction)',
  g1.rec.created.every(n => !('src' in n) || n.src === undefined));
ok('the chain reaches the destination',
  g1.rec.connections.some(c => c.to === 'destination'));
ok('LFO movement exists (an oscillator feeds a depth gain that lands on an AudioParam)',
  g1.rec.connections.some(c => c.from === 'oscillator' && c.to === 'gain') &&
  g1.rec.connections.some(c => c.from === 'gain' && c.to === 'param'));
const createdBefore = g1.rec.created.length;
graph.stop();
ok('graph.stop() stops every started source',
  g1.rec.stopped.length >= g1.rec.started.length && g1.rec.stopped.length > 0);
ok('graph.stop() creates nothing new', g1.rec.created.length === createdBefore);

/* every recipe builds a working graph (the catalogue is engine-true) */
for (const id of recipeIds) {
  const g = makeStubCtx();
  const gr = ambienceBuildGraph(g.ctx, AMBIENCE_RECIPES[id]);
  ok('recipe ' + id + ' builds and sounds', !!gr && g.rec.started.length >= 2 &&
    g.rec.connections.some(c => c.to === 'destination'));
  gr.stop();
}

/* ---------- NO autoplay: a context exists only after the explicit start ---------- */
eq('loading the module constructed no AudioContext', ctxConstructions, 0);
eq('selection and entry rendering constructed no AudioContext', ctxConstructions, 0);
eq('player state reports no context before start', M.ambienceState().ctxCreated, false);
shared.library = [settingBook, tropeBook, genreBook, coastalBook, thinBook];
const started = M.ambienceStart(settingBook);
ok('the explicit start action succeeds', started === true);
eq('start constructed exactly one AudioContext', ctxConstructions, 1);
eq('state reports playing the setting recipe', M.ambienceState().recipeId, 'ship');
eq('state reports playing', M.ambienceState().playing, true);
M.ambiencePause();
eq('pause suspends the context (graph kept)', lastStub.rec.suspends, 1);
eq('state reports paused', M.ambienceState().playing, false);
M.ambienceResume();
eq('resume resumes the same context', lastStub.rec.resumes, 1);
eq('resume constructed no new context', ctxConstructions, 1);
M.ambienceStopAll();
eq('stop closes the context (clean shutdown)', lastStub.rec.closes, 1);
eq('state is cleared after stop', M.ambienceState().bookId, null);
eq('a fresh start after stop builds a fresh context', (M.ambienceStart(genreBook), ctxConstructions), 2);
M.ambienceStopAll();

/* ---------- volume: persisted on the roaming prefs key ---------- */
eq('volume key is the prefs-roamed key', M.AMBIENCE_VOLUME_KEY, 'cozylibram.ambience.volume');
eq('default volume when unset', M.ambienceVolume(), 0.8);
const pushesBefore = shared.pushes;
M.ambienceSetVolume(0.5);
eq('setVolume writes the device key', shared.ls.getItem('cozylibram.ambience.volume'), '0.5');
ok('setVolume schedules a user-state push (the key roams)', shared.pushes > pushesBefore);
eq('volume clamps above 1', (M.ambienceSetVolume(7), M.ambienceVolume()), 1);
eq('volume clamps below 0', (M.ambienceSetVolume(-2), M.ambienceVolume()), 0);
M.ambienceSetVolume(0.5);
const sbx2 = loadModule(shared);
eq('volume survives a fresh module load (persistence round-trip)', sbx2.module.exports.ambienceVolume(), 0.5);

/* ---------- source-level pins: no assets, no fetch, no timer ---------- */
const src = fs.readFileSync(path.join(ROOT, 'js/241-book-ambience.js'), 'utf8');
ok('module never fetches audio', !/fetch\s*\(|XMLHttpRequest|\.(mp3|wav|ogg|m4a|flac)\b|new Audio\s*\(/.test(src));
ok('module ships no sleep-timer UI (deliberate, per spec)', !/sleep/i.test(src) && !/ambienceTimer|setTimer/.test(src));
ok('AudioContext is constructed lazily, exactly one construction site',
  (src.match(/new\s+AC\s*\(/g) || []).length === 1 || (src.match(/AudioContext\s*\(/g) || []).length <= 2);
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
ok('sw.js precaches the module (three-touchpoint rule)', swSrc.includes('241-book-ambience.js'));
ok('sw.js gains NO audio assets', !/\.(mp3|wav|ogg|m4a|flac)/.test(swSrc));
const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok('index.html loads the module', indexSrc.includes('js/241-book-ambience.js'));

/* ---------- version pairing (generic: survives renumbering) ---------- */
const appSrc = fs.readFileSync(path.join(ROOT, 'js/181-appversion.js'), 'utf8');
const vApp = /APP_VERSION = '(v\d+)'/.exec(appSrc)[1];
const vSw = /cozy-libram-(v\d+)/.exec(swSrc)[1];
eq('APP_VERSION and sw CACHE are paired', vApp, vSw);

/* ---------- drift, not pulse: the wobble regression pins ----------
   The v572 ship throbbed on the User's phone ("wub wub wub", every
   recipe). Diagnosis (numbers in the fix PR): (1) the noise buffer was
   2.0 s, looped raw — its loudness contour repeats at 0.5 Hz in the
   brown bed layer every recipe carries at the highest gain; (2) the
   gain-LFO wiring swept param.value = base*(1-amount) +/- base*amount,
   i.e. down to base*(1-2*amount) and through zero outright at
   amount >= 0.5 (ocean 0.55), at rates 0.05-0.13 Hz with depths to
   0.55; (3) near-rate LFO pairs (rain 0.07/0.11, cafe 0.07/0.113)
   beat against each other. These pins bound what the builder may
   emit so movement stays DRIFT: slow, shallow, never periodic at
   audible depth, and a gain sweep never crosses zero. */
const LIMITS = M.AMBIENCE_LIMITS || {};
ok('module exports the drift limits',
  typeof LIMITS.driftMaxRate === 'number' && typeof LIMITS.driftGainMaxDepth === 'number' &&
  typeof LIMITS.driftFreqMaxDepth === 'number' && typeof LIMITS.minBufferSeconds === 'number' &&
  typeof LIMITS.gateMaxLayerGain === 'number');

/* descriptor bounds: everything the catalogue declares is drift or a gate */
ok('every declared continuous LFO rate is within the drift ceiling',
  recipeIds.every(id => AMBIENCE_RECIPES[id].layers.every(l =>
    !l.lfo || l.lfo.wave === 'square' || l.lfo.rate <= LIMITS.driftMaxRate + 1e-9)));
ok('every declared continuous gain LFO depth is within the drift ceiling',
  recipeIds.every(id => AMBIENCE_RECIPES[id].layers.every(l =>
    !l.lfo || l.lfo.wave === 'square' || l.lfo.target === 'freq' ||
    l.lfo.amount <= LIMITS.driftGainMaxDepth + 1e-9)));
ok('every declared freq LFO depth is within the freq ceiling',
  recipeIds.every(id => AMBIENCE_RECIPES[id].layers.every(l =>
    !l.lfo || l.lfo.target !== 'freq' || l.lfo.amount <= LIMITS.driftFreqMaxDepth + 1e-9)));
ok('square-wave LFOs exist only as gates on whisper layers',
  recipeIds.every(id => AMBIENCE_RECIPES[id].layers.every(l =>
    !l.lfo || l.lfo.wave !== 'square' || l.gain <= LIMITS.gateMaxLayerGain + 1e-9)));

/* data stub: buffers carry real sample data, starts record offsets */
function makeDataCtx() {
  const rec = { created: [], connections: [], starts: [], buffersMade: [] };
  function param() {
    return { __isParam: true, value: 0,
      setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} };
  }
  function node(kind) {
    const n = { kind: kind, gain: param(), frequency: param(), Q: param(), type: '', buffer: null, loop: false,
      connect(dst) { rec.connections.push({ from: n, to: dst }); },
      disconnect() {},
      start(when, offset) { rec.starts.push({ node: n, offset: offset || 0 }); },
      stop() {} };
    rec.created.push(n);
    return n;
  }
  const ctx = {
    currentTime: 0, sampleRate: 44100, state: 'running',
    destination: { kind: 'destination' },
    createBuffer(ch, len, rate) {
      const arr = new Float32Array(len);
      const b = { duration: len / rate, getChannelData() { return arr; }, _arr: arr };
      rec.buffersMade.push(b);
      return b;
    },
    createBufferSource() { return node('bufferSource'); },
    createOscillator() { return node('oscillator'); },
    createBiquadFilter() { return node('filter'); },
    createGain() { return node('gain'); },
    suspend() { return Promise.resolve(); },
    resume() { return Promise.resolve(); },
    close() { return Promise.resolve(); },
  };
  return { ctx: ctx, rec: rec };
}
/* gain nodes whose output lands on an AudioParam are LFO depth gains;
   the param's owner node carries the sweep centre in the same param. */
function depthSweeps(rec) {
  const owners = new Map();
  rec.created.forEach(n => { owners.set(n.gain, n); owners.set(n.frequency, n); });
  const out = [];
  rec.connections.forEach(c => {
    if (c.from.kind === 'gain' && c.to && c.to.__isParam) {
      const owner = owners.get(c.to);
      out.push({ depth: c.from.gain.value, centre: owner ? c.to.value : NaN });
    }
  });
  return out;
}

/* buffer: long loops, decorrelated starts */
{
  const g = makeDataCtx();
  const gr = ambienceBuildGraph(g.ctx, AMBIENCE_RECIPES.rain);
  ok('every generated noise buffer is at least the minimum loop length',
    g.rec.buffersMade.length >= 1 &&
    g.rec.buffersMade.every(b => b._arr.length >= LIMITS.minBufferSeconds * g.ctx.sampleRate - 1));
  const noiseStarts = g.rec.starts.filter(s => s.node.kind === 'bufferSource');
  ok('noise layers sharing a buffer start at decorrelated offsets',
    noiseStarts.length >= 2 &&
    new Set(noiseStarts.map(s => s.offset)).size === noiseStarts.length);
  gr.stop();
}

/* no built graph sweeps a gain (or filter) below zero — ever */
for (const id of recipeIds) {
  const g = makeDataCtx();
  const gr = ambienceBuildGraph(g.ctx, AMBIENCE_RECIPES[id]);
  const sweeps = depthSweeps(g.rec);
  ok('recipe ' + id + ': no LFO sweep crosses zero',
    sweeps.length >= 1 && sweeps.every(s => s.centre - s.depth >= -1e-9));
  gr.stop();
}

/* the builder clamps a hostile descriptor instead of emitting a throb */
{
  const hostile = { layers: [
    { src: 'noise', color: 'white', filter: { type: 'lowpass', freq: 900 }, gain: 0.5,
      lfo: { rate: 2, amount: 1, target: 'gain' } },
  ] };
  const g = makeDataCtx();
  const gr = ambienceBuildGraph(g.ctx, hostile);
  const lfoOscs = g.rec.created.filter(n => n.kind === 'oscillator');
  ok('builder clamps a 2 Hz LFO down to the drift ceiling',
    lfoOscs.length === 1 && lfoOscs[0].frequency.value <= LIMITS.driftMaxRate + 1e-9);
  const sweeps = depthSweeps(g.rec);
  ok('builder clamps LFO depth so the sweep stays shallow and positive',
    sweeps.length === 1 &&
    sweeps[0].depth <= 0.5 * LIMITS.driftGainMaxDepth / 2 + 1e-9 &&
    sweeps[0].centre - sweeps[0].depth >= 0.5 * (1 - LIMITS.driftGainMaxDepth) - 1e-9);
  gr.stop();
}
/* a square gate declared on a LOUD layer is demoted to drift */
{
  const loudGate = { layers: [
    { src: 'noise', color: 'white', filter: { type: 'lowpass', freq: 900 }, gain: 0.5,
      lfo: { rate: 5, amount: 1, wave: 'square', target: 'gain' } },
  ] };
  const g = makeDataCtx();
  const gr = ambienceBuildGraph(g.ctx, loudGate);
  const lfoOscs = g.rec.created.filter(n => n.kind === 'oscillator');
  ok('a square LFO on a loud layer does not survive as a fast gate',
    lfoOscs.length === 1 &&
    (lfoOscs[0].type !== 'square' || lfoOscs[0].frequency.value <= LIMITS.driftMaxRate + 1e-9));
  gr.stop();
}
/* a square gate on a whisper layer stays a gate, centred [0, base] */
{
  const gate = { layers: [
    { src: 'noise', color: 'white', filter: { type: 'bandpass', freq: 2600, q: 1.2 }, gain: 0.04,
      lfo: { rate: 5, amount: 1, wave: 'square', target: 'gain' } },
  ] };
  const g = makeDataCtx();
  const gr = ambienceBuildGraph(g.ctx, gate);
  const sweeps = depthSweeps(g.rec);
  ok('whisper-layer gate sweeps exactly [0, base] and never negative',
    sweeps.length === 1 &&
    Math.abs(sweeps[0].centre - 0.02) < 1e-9 && Math.abs(sweeps[0].depth - 0.02) < 1e-9);
  gr.stop();
}

console.log('book-ambience: ' + _pass + ' passed, ' + _fail + ' failed');
process.exit(_fail ? 1 : 0);
