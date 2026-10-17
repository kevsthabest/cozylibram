/* js/204-shelf3d-layout.js — Pure layout math for the 3D shelf:
 * decoration footprints, the shared case packer, the camera
 * fit / pan math, and the face-out display geometry.
 *
 * Everything here is pure — no THREE, no DOM, no instance state —
 * which is what makes the packer shareable: shelf3dPackCase is the
 * single source of truth for how books fill a case, the engine
 * (js/215-shelf3d.js) lays out the visible case with it, and
 * js/217-shelf3d-view.js slices the room into cases by simulating
 * it, so case boundaries always match what the engine can actually
 * show. Extracted from js/215 for exactly that sharing; this file
 * must load before js/215 and js/217 (index.html + sw.js precache
 * carry it there).
 *
 * Surface: SHELF_W and MAX_BOOKS (the two case constants the packer
 * reads; js/215's remaining dimensions stay in js/215),
 * DECO_FOOTPRINTS, shelf3dDecoFootprint, s3dDim, shelf3dPackCase,
 * shelf3dFitDistance, shelf3dClampPan, shelf3dFaceWidth,
 * shelf3dFaceDepth, shelf3dFaceZ, shelf3dCoverCrop. js/215 reads the
 * packer and constants as globals through the window bridge at the
 * bottom of this file; js/217 reads shelf3dFaceWidth the same way.
 * This file reads nothing from any other module.
 */
export var SHELF_W = 10;                          // bookcase width (world units)
export var MAX_BOOKS = 60;                        // ~20 per shelf x 3 shelves

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
export var DECO_FOOTPRINTS = {
  plant: 0.75, candle: 0.55, mug: 0.6, stack: 1.2, clock: 0.6, photo: 0.55,
  succulent: 0.5, lantern: 0.45, globe: 0.62, vase: 0.5, gifts: 0.75,
  eggs: 0.7, coins: 0.42, clover: 0.45, applebowl: 0.85,
  'dragon-egg': 0.7, 'storm-lantern': 0.42, 'rider-blade': 0.7,
  'thorn-crown': 0.65, 'moon-goblet': 0.5, 'night-bloom': 0.6,
  'holo-cube': 0.5, 'signal-dish': 0.65, 'data-core': 0.55,
  'mushroom-cottage': 0.75, 'firefly-jar': 0.45, 'wisp-lantern': 0.6,
  lights: 0, stargarland: 0
};
export function shelf3dDecoFootprint(type) {
  var fw = DECO_FOOTPRINTS[type];
  return (typeof fw === 'number') ? fw : 0;
}
export function s3dDim(v, lo, hi, fb) {
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
   overflow: [indices] }. Pure: no THREE, no DOM.
   Face-out picks (b.faceOut) pack at their cover width (b.faceW) instead
   of the spine width — the ONLY special case. They wrap, jump decoration
   intervals, and overflow exactly like any other book, so js/217's case
   slicing (which simulates this packer) stays in agreement by construction. */
export function shelf3dPackCase(books, obstacles, cap) {
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
    var w = b.faceOut ? s3dDim(b.faceW, 0.9, 1.75, 1.25) : s3dDim(b.spineW, 0.3, 0.72, 0.44);
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
export function shelf3dFitDistance(aspect, fovDeg, fitW, fitH) {
  var t = Math.tan((fovDeg * Math.PI / 180) / 2);
  var dH = (fitH / 2) / t;
  var dW = (fitW / 2) / (t * Math.max(0.05, aspect || 1));
  return Math.max(dH, dW);
}
/* Clamp a pan offset so the panned view target stays in the room:
   x within +/- halfW of the case centre, target y within
   [1.2, topY - 1.2] given the unpanned target height baseY. */
export function shelf3dClampPan(px, py, halfW, baseY, topY) {
  var cx = Math.max(-halfW, Math.min(halfW, px));
  var cy = Math.max(1.2 - baseY, Math.min(topY - 1.2 - baseY, py));
  return [cx, cy];
}

/* ---------- face-out display picks ----------
   A picked book turns its cover to the room. Its shelf footprint is the
   cover's width, derived from the book's height (real covers run about
   0.62–0.70 of their height; 0.68 is the middle of that range and matches
   the approved mockup's proportions). Pure, like everything in this file:
   the engine (js/215) supplies the THREE work. */
/* Cover width for a face-out book of the given spine height. */
export function shelf3dFaceWidth(spineH) {
  var h = Number(spineH);
  if (!isFinite(h)) h = 2.0;
  return Math.min(1.6, Math.max(0.95, h * 0.68));
}
/* A face-out book's thickness: its own spine width, clamped as the packer
   clamps spines. Also the depth of its 3D box. */
export function shelf3dFaceDepth(spineW) {
  return s3dDim(spineW, 0.3, 0.72, 0.44);
}
/* Z position for a face-out mesh (spine books sit at z = 0 with depth
   1.75, so their fronts plane at z = 0.875). A face-out stands pulled
   forward, bookshop-style: its front sits 0.06 behind the spine fronts,
   its thin back floating off the case back. */
export function shelf3dFaceZ(spineW) {
  return 0.875 - 0.06 - shelf3dFaceDepth(spineW) / 2;
}
/* Crop-to-fill UV window for a cover image on a face of aspect `aspect`
   (w/h): returns {rx, ry, ox, oy} for texture.repeat / texture.offset,
   centre-cropped like the mockup's object-fit: cover. */
export function shelf3dCoverCrop(imgW, imgH, aspect) {
  var iw = Number(imgW), ih = Number(imgH), a = Number(aspect);
  if (!isFinite(iw) || !isFinite(ih) || !isFinite(a) || iw <= 0 || ih <= 0 || a <= 0) {
    return { rx: 1, ry: 1, ox: 0, oy: 0 };
  }
  var ia = iw / ih;
  if (ia > a) { var rx = a / ia; return { rx: rx, ry: 1, ox: (1 - rx) / 2, oy: 0 }; }
  var ry = ia / a;
  return { rx: 1, ry: ry, ox: 0, oy: (1 - ry) / 2 };
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Its consumers (js/215-shelf3d.js,
   js/217-shelf3d-view.js) still read this layout math as globals at
   runtime, so the bridge republishes exactly the pre-conversion
   public surface on window. Bare-name lookups resolve through the
   global object, so the callers need no changes. Module scripts are
   deferred, so the bridge is in place before any consumer can run.
   Remove a name from this bridge only when its last window-reading
   caller has wired the read as an import (ADR-003). */
window.SHELF_W = SHELF_W;
window.MAX_BOOKS = MAX_BOOKS;
window.DECO_FOOTPRINTS = DECO_FOOTPRINTS;
window.shelf3dDecoFootprint = shelf3dDecoFootprint;
window.s3dDim = s3dDim;
window.shelf3dPackCase = shelf3dPackCase;
window.shelf3dFitDistance = shelf3dFitDistance;
window.shelf3dClampPan = shelf3dClampPan;
window.shelf3dFaceWidth = shelf3dFaceWidth;
window.shelf3dFaceDepth = shelf3dFaceDepth;
window.shelf3dFaceZ = shelf3dFaceZ;
window.shelf3dCoverCrop = shelf3dCoverCrop;
