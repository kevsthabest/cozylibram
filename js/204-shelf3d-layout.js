/* 204-shelf3d-layout.js — pure layout math for the 3D shelf: decoration
   footprints, the shared case packer, and the camera fit / pan math.

   Extracted from js/215-shelf3d.js: this zone was already pure (no THREE,
   no DOM, no instance state) and already shared — js/217-shelf3d-view.js
   slices the room into cases by simulating this packer through the
   window.Shelf3D facade. Classic script, no modules, no side effects:
   it only defines the globals below. Must load before js/215 and js/217
   (index.html + sw.js precache carry it there).

   Globals: SHELF_W, MAX_BOOKS (the two case constants the packer reads;
   js/215's remaining dimensions stay in js/215), DECO_FOOTPRINTS,
   shelf3dDecoFootprint, shelf3dPackCase, shelf3dFitDistance,
   shelf3dClampPan. */

var SHELF_W = 10;                          // bookcase width (world units)
var MAX_BOOKS = 60;                        // ~20 per shelf x 3 shelves

/* ---------- decoration footprints + the shared case packer (v514) ----------
   Shelf decorations are anchored (saved per bookcase: level + x) and books
   flow around them. One pure packer is the single source of truth for how
   books fill a case: the engine lays out the visible case with it, and
   js/217-shelf3d-view.js slices the room into cases by simulating it, so
   case boundaries always match what the engine can actually show.
   Footprints mirror the makers' userData.fw (guarded by
   .test/shelf-reflow.test.js, which parses the makers). Edge-draped pieces
   (fairy lights, star garland) hang at the plank's front edge in front of
   the books — they never displace books, so their footprint here is 0. */
var DECO_FOOTPRINTS = {
  plant: 0.75, candle: 0.55, mug: 0.6, stack: 1.2, clock: 0.6, photo: 0.55,
  succulent: 0.5, lantern: 0.45, globe: 0.62, vase: 0.5, gifts: 0.75,
  eggs: 0.7, coins: 0.42, clover: 0.45, applebowl: 0.85,
  'dragon-egg': 0.7, 'storm-lantern': 0.42, 'rider-blade': 0.7,
  'thorn-crown': 0.65, 'moon-goblet': 0.5, 'night-bloom': 0.6,
  'holo-cube': 0.5, 'signal-dish': 0.65, 'data-core': 0.55,
  'mushroom-cottage': 0.75, 'firefly-jar': 0.45, 'wisp-lantern': 0.6,
  lights: 0, stargarland: 0
};
function shelf3dDecoFootprint(type) {
  var fw = DECO_FOOTPRINTS[type];
  return (typeof fw === 'number') ? fw : 0;
}
function s3dDim(v, lo, hi, fb) {
  v = Number(v);
  if (!isFinite(v)) return fb;
  return Math.min(hi, Math.max(lo, v));
}
/* Pack `books` ([{spineW, spineH}]) into one bookcase around per-level
   obstacle intervals (decorations). Levels fill top-first (LEVELS order
   [2, 1, 0] by index, as setBooks has always done). A book that cannot fit
   in the rest of a level — shelf end or the next obstacle — retries on the
   next level; a book that fits nowhere in the case overflows (the caller
   flows it into the next case). Returns { placed: [{i, li, x, w, h}],
   overflow: [indices] }. Pure: no THREE, no DOM. */
function shelf3dPackCase(books, obstacles, cap) {
  var order = [2, 1, 0];
  var startX = -SHELF_W / 2 + 0.35, limit = startX + (SHELF_W - 0.7);
  var gap = 0.025;
  var maxN = (typeof cap === 'number' && cap > 0) ? cap : MAX_BOOKS;
  var obs = order.map(function (li) {
    return ((obstacles && obstacles[li]) || []).slice().sort(function (a, b) { return a[0] - b[0]; });
  });
  var placed = [], overflow = [];
  var li = 0, x = startX;
  (books || []).forEach(function (b, i) {
    if (!b) { overflow.push(i); return; }
    if (placed.length >= maxN) { overflow.push(i); return; }
    var w = s3dDim(b.spineW, 0.3, 0.72, 0.44);
    var h = s3dDim(b.spineH, 1.4, 2.7, 2.0);
    var done = false;
    while (li < 3 && !done) {
      var lvl = order[li], blocked = obs[li];
      var cx = x;
      for (;;) {
        if (cx + w > limit) break;
        var hit = null;
        for (var oi = 0; oi < blocked.length; oi++) {
          if (cx < blocked[oi][1] && cx + w > blocked[oi][0]) { hit = blocked[oi]; break; }
        }
        if (!hit) { done = true; break; }
        cx = hit[1] + gap;
      }
      if (done) {
        placed.push({ i: i, li: lvl, x: cx, w: w, h: h });
        x = cx + w + gap;
      } else { li++; x = startX; }
    }
    if (!done) overflow.push(i);
  });
  return { placed: placed, overflow: overflow };
}

/* ---------- camera fit / pan math (pure — unit tested) ---------- */
/* Distance at which a `fitW` x `fitH` frame (world units, centred on the
   view target) exactly fills a PerspectiveCamera with vertical fov
   `fovDeg` at the given aspect. The binding axis wins. */
function shelf3dFitDistance(aspect, fovDeg, fitW, fitH) {
  var t = Math.tan((fovDeg * Math.PI / 180) / 2);
  var dH = (fitH / 2) / t;
  var dW = (fitW / 2) / (t * Math.max(0.05, aspect || 1));
  return Math.max(dH, dW);
}
/* Clamp a pan offset so the panned view target stays in the room:
   x within +/- halfW of the case centre, target y within
   [1.2, topY - 1.2] given the unpanned target height baseY. */
function shelf3dClampPan(px, py, halfW, baseY, topY) {
  var cx = Math.max(-halfW, Math.min(halfW, px));
  var cy = Math.max(1.2 - baseY, Math.min(topY - 1.2 - baseY, py));
  return [cx, cy];
}
