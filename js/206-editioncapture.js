'use strict';

/* ---- Edition-face capture (v274): guided multi-face edition scan ----
   The 3D-showcase goal needs one texture per face of a book: spine,
   fore-edge (sprayed edges), front, back — for the dust jacket AND, when
   the boards underneath have their own art, the naked boards too.

   Flow (started from the book modal's "Scan edition" button):
     1. Appearance: jacket only, or jacket + bare boards?
     2. Per appearance x per face: guided capture (camera or library photo)
        with an aspect hint, then a corner-drag perspective editor that
        warps the selected quad to a clean rectangle.
     3. Review grid, then save: faces land on the book locally
        (book.editionFaces[appearance][face], jacket spine also feeds
        book.spinePhoto for the shelf), and each face is contributed to
        the shared edition_images pool when the pool lacks it (first
        writer wins — never clobbers, same rule as the v259 spine pool).
        The warped output is exactly the quad the user framed, so it
        contains no background by construction and is safe to share.

   The warp is a plain homography solved in JS (no dependency): four
   source corners -> rectangle, inverse-mapped with bilinear sampling.

   v275: the editor defaults to a locked 90° rectangle (corner drags
   resize with the opposite corner anchored; a rotate handle straightens
   tilt; dragging inside moves). A lock toggle frees the quad for badly
   skewed shots. v277: handles are small visible dots with fat invisible
   grab halos; the editor swallows the long-press context menu; a "page
   edges?" step skips the sprayed-edge capture for plain page blocks.
   v278: auto-scan — live edge detection on the viewfinder (Sobel +
   morphology + min-area rect, pure and unit-tested) draws the detected
   book outline and auto-captures after 6 steady frames; the warped face
   goes to a confirm sheet (Use / Adjust corners / Retake). Manual snaps
   and chosen photos get the detected quad as an editor pre-fit. */

var EC_FACES = [
  { id: 'spine', label: 'Spine', skippable: false, guide: 'tall',
    hint: 'Hold the book upright with the spine facing you. Fill the frame.' },
  { id: 'fore_edge', label: 'Sprayed edge', skippable: false, guide: 'tall',
    hint: 'Stand the book upright with the page block facing you — capture the sprayed or plain page edges straight on.' },
  { id: 'front', label: 'Front cover', skippable: true, guide: 'portrait',
    hint: 'Lay the book flat, cover facing up. Skippable when the cover art is already right.' },
  { id: 'back', label: 'Back cover', skippable: true, guide: 'portrait',
    hint: 'Flip it over, back facing up. Skippable when it adds nothing.' },
];
var EC_APPEARANCES = [
  { id: 'jacket', label: 'Dust jacket' },
  { id: 'board', label: 'Bare boards' },
];
var EC_MAX_DIM = 1200;   // longest side of a saved face, px
var EC_PREVIEW_MAX = 260; // longest side of the live editor preview, px

/* ---------- homography ---------- */

// Solve the 3x3 homography mapping src quad -> dst quad (h33 pinned to 1).
// Quads are arrays of 4 [x, y] in TL TR BR BL order. Returns null on failure.
function ecSolveHomography(src, dst) {
  // From H[x,y,1] ~ [u,v,1]: h0*x+h1*y+h2 - u*(h6*x+h7*y) = u  (h8 = 1),
  // and likewise for v. Eight equations, eight unknowns.
  var A = [], i;
  for (i = 0; i < 4; i++) {
    var x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  var n = 8, r, c, k;
  for (c = 0; c < n; c++) {
    var piv = c;
    for (r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-9) return null;
    var tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
    var d = A[c][c];
    for (k = c; k <= n; k++) A[c][k] /= d;
    for (r = 0; r < n; r++) {
      if (r === c) continue;
      var f = A[r][c];
      if (f !== 0) for (k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  var h = [];
  for (r = 0; r < n; r++) h.push(A[r][n]);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

function ecInvert3(m) {
  var a = m[0][0], b = m[0][1], c = m[0][2],
      d = m[1][0], e = m[1][1], f = m[1][2],
      g = m[2][0], h = m[2][1], i = m[2][2];
  var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  var det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

function ecApplyH(H, x, y) {
  var X = H[0][0] * x + H[0][1] * y + H[0][2];
  var Y = H[1][0] * x + H[1][1] * y + H[1][2];
  var W = H[2][0] * x + H[2][1] * y + H[2][2];
  return [X / W, Y / W];
}

// Pure pixel warp: inverse-map every output pixel through the homography
// and bilinear-sample the source. No DOM/canvas — unit-testable.
// spx: Uint8ClampedArray RGBA, sw x sh. Returns { data, w, h } or null.
function ecWarpPixels(spx, sw, sh, quad, outW, outH) {
  var H = ecSolveHomography(quad, [[0, 0], [outW, 0], [outW, outH], [0, outH]]);
  if (!H) return null;
  var Hi = ecInvert3(H);
  if (!Hi) return null;
  var opx = new Uint8ClampedArray(outW * outH * 4);
  var x, y, ch;
  for (y = 0; y < outH; y++) {
    for (x = 0; x < outW; x++) {
      var s = ecApplyH(Hi, x, y);
      var sx = s[0], sy = s[1];
      var x0 = Math.floor(sx), y0 = Math.floor(sy);
      var fx = sx - x0, fy = sy - y0;
      var o = (y * outW + x) * 4;
      for (ch = 0; ch < 4; ch++) {
        var p00 = ecSample(spx, sw, sh, x0, y0, ch);
        var p10 = ecSample(spx, sw, sh, x0 + 1, y0, ch);
        var p01 = ecSample(spx, sw, sh, x0, y0 + 1, ch);
        var p11 = ecSample(spx, sw, sh, x0 + 1, y0 + 1, ch);
        opx[o + ch] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) +
                      p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }
  return { data: opx, w: outW, h: outH };
}

function ecSample(px, w, h, x, y, ch) {
  if (x < 0) x = 0; else if (x >= w) x = w - 1;
  if (y < 0) y = 0; else if (y >= h) y = h - 1;
  return px[(y * w + x) * 4 + ch];
}

// Output dimensions from a quad: average opposite-edge lengths, capped.
function ecQuadSize(quad, maxDim) {
  var dist = function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  var w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  var h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  var s = Math.min(1, maxDim / Math.max(w, h, 1));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// ---------- locked-rectangle helpers (v274b) ----------
// Books are always 90° rectangles, so the editor defaults to a locked
// rectangle: corner drags resize (opposite corner anchored), a rotate
// handle straightens tilt, dragging inside moves. Free-quad mode stays
// available behind the lock toggle for badly skewed shots.
var EC_ALPHA = [0, 1, 1, 0], EC_BETA = [0, 0, 1, 1]; // rect-space coords per corner (TL TR BR BL)

function ecQuadCenter(q) {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
          (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

function ecQuadAxes(q) {
  var ux = q[1][0] - q[0][0], uy = q[1][1] - q[0][1];
  var vx = q[3][0] - q[0][0], vy = q[3][1] - q[0][1];
  var ul = Math.hypot(ux, uy) || 1, vl = Math.hypot(vx, vy) || 1;
  return { u: [ux / ul, uy / ul], v: [vx / vl, vy / vl] };
}

// Resize a rectangle by dragging corner i to P; the opposite corner stays
// anchored and the 90° angles are preserved. Returns the new quad.
function ecLockedResize(q, i, P) {
  var k = (i + 2) % 4;
  var ax = ecQuadAxes(q);
  var dx = P[0] - q[k][0], dy = P[1] - q[k][1];
  var du = dx * ax.u[0] + dy * ax.u[1], dv = dx * ax.v[0] + dy * ax.v[1];
  var sau = EC_ALPHA[i] - EC_ALPHA[k], sbv = EC_BETA[i] - EC_BETA[k]; // ±1
  var w = Math.max(20, du / sau), h = Math.max(20, dv / sbv);
  var ox = q[k][0] - EC_ALPHA[k] * w * ax.u[0] - EC_BETA[k] * h * ax.v[0];
  var oy = q[k][1] - EC_ALPHA[k] * w * ax.u[1] - EC_BETA[k] * h * ax.v[1];
  return [0, 1, 2, 3].map(function (j) {
    return [ox + EC_ALPHA[j] * w * ax.u[0] + EC_BETA[j] * h * ax.v[0],
            oy + EC_ALPHA[j] * w * ax.u[1] + EC_BETA[j] * h * ax.v[1]];
  });
}

function ecRotateQuad(q, delta) {
  var c = ecQuadCenter(q), cos = Math.cos(delta), sin = Math.sin(delta);
  return q.map(function (p) {
    var x = p[0] - c[0], y = p[1] - c[1];
    return [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos];
  });
}

// Fit the closest rectangle to a free quad (used when re-enabling the lock).
function ecSnapToRect(q) {
  var c = ecQuadCenter(q);
  var ax = ecQuadAxes(q);
  var ux = ax.u[0], uy = ax.u[1];
  var vx = -uy, vy = ux; // re-orthogonalized
  if (vx * ax.v[0] + vy * ax.v[1] < 0) { vx = -vx; vy = -vy; }
  var w = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) +
           Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2;
  var h = (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) +
           Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
  var ox = c[0] - (w * ux + h * vx) / 2, oy = c[1] - (w * uy + h * vy) / 2;
  return [0, 1, 2, 3].map(function (j) {
    return [ox + EC_ALPHA[j] * w * ux + EC_BETA[j] * h * vx,
            oy + EC_ALPHA[j] * w * uy + EC_BETA[j] * h * vy];
  });
}

/* ---------- auto-scan book detection (v278) ----------
   Pure image pipeline (no DOM): downscaled grayscale in, rotated rectangle
   out. Finds the book as the largest interior region after morphological
   opening (erases cover text/partitions, keeps the book blob), fits a
   min-area rectangle to its convex hull, and verifies edge density along
   the rect perimeter. Returns { quad, cx, cy, w, h, angle } in input px
   (quad normalized: portrait winding, short edge first) or null. */

function ecToGray(rgba, w, h) {
  var g = new Uint8ClampedArray(w * h);
  for (var i = 0; i < w * h; i++) {
    g[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  }
  return g;
}

function ecBlur3(g, w, h) {
  var o = new Uint8ClampedArray(w * h);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var s = 0, n = 0;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h) { s += g[yy * w + xx]; n++; }
    }
    o[y * w + x] = s / n;
  }
  return o;
}

function ecSobel(g, w, h) {
  var mag = new Uint16Array(w * h), max = 0;
  for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
    var i = y * w + x;
    var gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
    var gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
    var m = Math.abs(gx) + Math.abs(gy);
    mag[i] = m;
    if (m > max) max = m;
  }
  return { mag: mag, max: max };
}

// v297: one-pass separated Sobel (|gx|, |gy|) for projection-based
// guided detection.
function ecSobelSep(g, w, h) {
  var gx = new Uint16Array(w * h), gy = new Uint16Array(w * h);
  for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
    var i = y * w + x;
    gx[i] = Math.abs(-g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]);
    gy[i] = Math.abs(-g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]);
  }
  return { gx: gx, gy: gy };
}

// v299: one-time precise crop for the burst frame. Aiming uses the guide
// rect (stable); here we measure the book's actual edges once — no flicker
// risk — and tighten the crop so the 3D view isn't padded with background.
// Returns a quad in the input coords, or null (caller falls back to guide).
function ecTightenQuad(gray, w, h, roi, tall) {
  var se = ecSobelSep(ecBlur3(gray, w, h), w, h);
  var x0 = Math.max(1, Math.floor(roi.x)), x1 = Math.min(w - 2, Math.ceil(roi.x + roi.w));
  var y0 = Math.max(1, Math.floor(roi.y)), y1 = Math.min(h - 2, Math.ceil(roi.y + roi.h));
  var rw = x1 - x0, rh = y1 - y0;
  if (rw < 12 || rh < 20) return null;
  function runsAlong(horizontal) {
    var n = horizontal ? rh + 1 : rw + 1, runs = [], i, j;
    for (i = 0; i < n; i++) {
      var best = 0, cur = 0;
      for (j = 0; j <= (horizontal ? rw : rh); j++) {
        var v = horizontal ? se.gy[(y0 + i) * w + x0 + j] : se.gx[(y0 + j) * w + x0 + i];
        if (v > 100) { cur++; if (cur > best) best = cur; } else cur = 0;
      }
      runs.push(best);
    }
    return runs;
  }
  function tighten(runs, axisLen, expectLen) {
    var n = runs.length, peaks = [], i, j;
    for (i = 0; i < n; i++) {
      if (runs[i] < axisLen * 0.25) continue;
      var isPeak = true;
      for (j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) {
        if (runs[j] > runs[i]) { isPeak = false; break; }
      }
      if (isPeak) peaks.push(i);
    }
    var bl = -1, br = -1, bs = 0;
    var minSep = Math.max(8, expectLen * 0.2), maxSep = expectLen * 1.35;
    for (var a = 0; a < peaks.length; a++) for (var b = a + 1; b < peaks.length; b++) {
      var sep = peaks[b] - peaks[a];
      if (sep < minSep || sep > maxSep) continue;
      var sc = runs[peaks[a]] + runs[peaks[b]];
      if (sc > bs) { bs = sc; bl = peaks[a]; br = peaks[b]; }
    }
    if (bl >= 0) return [bl, br];
    if (peaks.length) {
      var bp = peaks[0];
      for (var k = 1; k < peaks.length; k++) if (runs[peaks[k]] > runs[bp]) bp = peaks[k];
      if (bp < n / 2) return [bp, Math.min(n - 1, Math.round(bp + expectLen))];
      return [Math.max(0, Math.round(bp - expectLen)), bp];
    }
    return null;
  }
  function ok(b, expect) {
    return !!b && (b[1] - b[0]) >= expect * 0.2 && (b[1] - b[0]) <= expect * 1.35;
  }
  var xb = tighten(runsAlong(false), rh, rw);
  if (!ok(xb, rw)) return null;
  var gy0 = y0, gy1 = y1;
  if (!tall) {
    var yb = tighten(runsAlong(true), rw, rh);
    if (!ok(yb, rh)) return null;
    gy0 = y0 + yb[0]; gy1 = y0 + yb[1];
  }
  return ecNormQuad([[x0 + xb[0], gy0], [x0 + xb[1], gy0], [x0 + xb[1], gy1], [x0 + xb[0], gy1]]);
}

// v298: region contrast — the strongest object-vs-surroundings signal over
// centered candidate strips at several widths. A book bounds a region that
// differs from what's beside it; texture (floor, wall) does not.
function ecRegionContrast(gray, w, h, roi, tall) {
  var x0 = Math.max(0, Math.floor(roi.x)), x1 = Math.min(w - 1, Math.ceil(roi.x + roi.w));
  var y0 = Math.max(0, Math.floor(roi.y)), y1 = Math.min(h - 1, Math.ceil(roi.y + roi.h));
  function mean(ax0, ax1, ay0, ay1) {
    ax0 = Math.max(0, Math.floor(ax0)); ax1 = Math.min(w - 1, Math.ceil(ax1));
    ay0 = Math.max(0, Math.floor(ay0)); ay1 = Math.min(h - 1, Math.ceil(ay1));
    var s = 0, n = 0;
    for (var yy = ay0; yy <= ay1; yy++) for (var xx = ax0; xx <= ax1; xx++) { s += gray[yy * w + xx]; n++; }
    return n ? s / n : 0;
  }
  var best = 0;
  var centers = tall ? [0.35, 0.5, 0.65] : [0.5];
  var widths = [0.9, 0.65, 0.4];
  for (var ci = 0; ci < centers.length; ci++) for (var wi = 0; wi < widths.length; wi++) {
    var c = 0;
    if (tall) {
      var ccx = x0 + (x1 - x0) * centers[ci], hw = (x1 - x0) * widths[wi] / 2;
      var inner = mean(ccx - hw, ccx + hw, y0, y1);
      c = Math.abs(inner - mean(ccx - hw - 14, ccx - hw, y0, y1)) +
          Math.abs(inner - mean(ccx + hw, ccx + hw + 14, y0, y1));
    } else {
      var ccy = y0 + (y1 - y0) * centers[ci], hh = (y1 - y0) * widths[wi] / 2;
      var inner2 = mean(x0, x1, ccy - hh, ccy + hh);
      c = Math.abs(inner2 - mean(x0, x1, ccy - hh - 14, ccy - hh)) +
          Math.abs(inner2 - mean(x0, x1, ccy + hh, ccy + hh + 14));
    }
    if (c > best) best = c;
  }
  return best;
}

// v298: book-likeness in the guide. A long straight edge alone is not enough
// (wood floors have those). A book face shows FEW dominant parallel edges —
// a spine usually two, a weak-contrast spine one strong edge bounding a
// contrasting region — while texture shows many.
function ecBookPresent(gray, w, h, roi, tall) {
  var se = ecSobelSep(ecBlur3(gray, w, h), w, h);
  var x0 = Math.max(1, Math.floor(roi.x)), x1 = Math.min(w - 2, Math.ceil(roi.x + roi.w));
  var y0 = Math.max(1, Math.floor(roi.y)), y1 = Math.min(h - 2, Math.ceil(roi.y + roi.h));
  var rw = x1 - x0, rh = y1 - y0;
  if (rw < 12 || rh < 20) return false;
  var TH = 100, runs = [], i, j;
  if (tall) {
    for (i = 0; i <= rw; i++) {
      var best = 0, cur = 0;
      for (j = y0; j <= y1; j++) {
        if (se.gx[j * w + x0 + i] > TH) { cur++; if (cur > best) best = cur; } else cur = 0;
      }
      runs.push(best);
    }
  } else {
    for (j = 0; j <= rh; j++) {
      var b2 = 0, c2 = 0;
      for (i = x0; i <= x1; i++) {
        if (se.gy[(y0 + j) * w + i] > TH) { c2++; if (c2 > b2) b2 = c2; } else c2 = 0;
      }
      runs.push(b2);
    }
  }
  var len = tall ? rh : rw, strong = [];
  for (i = 0; i < runs.length; i++) {
    if (runs[i] < len * 0.35) continue;
    var peak = true;
    for (j = Math.max(0, i - 4); j <= Math.min(runs.length - 1, i + 4); j++) {
      if (runs[j] > runs[i]) { peak = false; break; }
    }
    if (peak) strong.push(i);
  }
  if (strong.length >= 5) return false; // texture (floorboards etc.), not a book
  var minSep = Math.max(10, (tall ? rw : rh) * 0.25);
  for (i = 0; i < strong.length; i++) for (j = i + 1; j < strong.length; j++) {
    if (strong[j] - strong[i] >= minSep) return true; // a bounded pair of edges
  }
  if (strong.length >= 1) {
    return ecRegionContrast(gray, w, h, roi, tall) >= 30; // one edge + contrasting region
  }
  return false;
}

function ecThreshold(mag, w, h, t) {
  var o = new Uint8Array(w * h), c = 0;
  for (var i = 0; i < w * h; i++) if (mag[i] > t) { o[i] = 1; c++; }
  return { bin: o, count: c };
}

function ecDilate(bin, w, h, iters) {
  var cur = bin;
  for (var k = 0; k < (iters || 1); k++) {
    var o = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var v = 0;
      for (var dy = -1; dy <= 1 && !v; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && cur[yy * w + xx]) { v = 1; break; }
      }
      o[y * w + x] = v;
    }
    cur = o;
  }
  return cur;
}

function ecErode(bin, w, h, iters) {
  var cur = bin;
  for (var k = 0; k < (iters || 1); k++) {
    var o = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var v = 1;
      for (var dy = -1; dy <= 1 && v; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h || !cur[yy * w + xx]) { v = 0; break; }
      }
      o[y * w + x] = v;
    }
    cur = o;
  }
  return cur;
}

// Iterative flood fill through pixels where bin==1, marking mark[]=1.
// Returns the filled pixel indices.
function ecFloodFill(bin, w, h, sx, sy, mark) {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return [];
  var stack = [sy * w + sx], pts = [];
  while (stack.length) {
    var i = stack.pop();
    if (mark[i] || !bin[i]) continue;
    mark[i] = 1;
    pts.push(i);
    var x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return pts;
}

// Background = everything reachable from the image border through non-edge
// pixels (edges are walls).
function ecFillBackground(edges, w, h) {
  var open = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) open[i] = edges[i] ? 0 : 1;
  var bg = new Uint8Array(w * h);
  for (var x = 0; x < w; x++) {
    ecFloodFill(open, w, h, x, 0, bg);
    ecFloodFill(open, w, h, x, h - 1, bg);
  }
  for (var y = 0; y < h; y++) {
    ecFloodFill(open, w, h, 0, y, bg);
    ecFloodFill(open, w, h, w - 1, y, bg);
  }
  return bg;
}

// Top-k connected components of a binary mask, scored by area biased
// toward the frame center (the user aims at the book).
function ecTopComponents(mask, w, h, k) {
  var seen = new Uint8Array(w * h);
  var all = [];
  var ccx = w / 2, ccy = h / 2, maxd = Math.hypot(ccx, ccy) || 1;
  for (var i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    var pts = ecFloodFill(mask, w, h, i % w, (i / w) | 0, seen);
    if (!pts.length) continue;
    var sx = 0, sy = 0, tb = false;
    for (var j = 0; j < pts.length; j++) {
      var p = pts[j], x = p % w, y = (p / w) | 0;
      sx += x; sy += y;
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3) tb = true;
    }
    var cx = sx / pts.length, cy = sy / pts.length;
    all.push({ pts: pts, area: pts.length, cx: cx, cy: cy, touchesBorder: tb,
               score: pts.length * (1.35 - Math.hypot(cx - ccx, cy - ccy) / maxd) });
  }
  all.sort(function (a, b) { return b.score - a.score; });
  return all.slice(0, k || 1);
}

// Largest connected component of a binary mask, scored by area biased
// toward the frame center (the user aims at the book).
function ecLargestComponent(mask, w, h) {
  return ecTopComponents(mask, w, h, 1)[0] || null;
}

// Andrew's monotone chain.
function ecConvexHull(pts) {
  var p = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  var u = [];
  for (var i = 0; i < p.length; i++) {
    if (!i || p[i][0] !== p[i - 1][0] || p[i][1] !== p[i - 1][1]) u.push(p[i]);
  }
  if (u.length < 3) return u;
  var cross = function (o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  };
  var lower = [], upper = [], i;
  for (i = 0; i < u.length; i++) {
    while (lower.length >= 2 &&
           cross(lower[lower.length - 2], lower[lower.length - 1], u[i]) <= 0) lower.pop();
    lower.push(u[i]);
  }
  for (i = u.length - 1; i >= 0; i--) {
    while (upper.length >= 2 &&
           cross(upper[upper.length - 2], upper[upper.length - 1], u[i]) <= 0) upper.pop();
    upper.push(u[i]);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Minimum-area enclosing rectangle (a side is flush with a hull edge).
function ecMinAreaRect(hull) {
  var n = hull.length, bi = 0, best = null;
  for (var i = 0; i < n; i++) {
    var p1 = hull[i], p2 = hull[(i + 1) % n];
    var ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    var cos = Math.cos(-ang), sin = Math.sin(-ang);
    var minx = 1e18, maxx = -1e18, miny = 1e18, maxy = -1e18;
    for (var j = 0; j < n; j++) {
      var x = hull[j][0] * cos - hull[j][1] * sin;
      var y = hull[j][0] * sin + hull[j][1] * cos;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    var area = (maxx - minx) * (maxy - miny);
    if (!best || area < best.area) {
      best = { area: area, ang: ang, minx: minx, maxx: maxx, miny: miny, maxy: maxy };
      bi = i;
    }
  }
  var c2 = Math.cos(best.ang), s2 = Math.sin(best.ang);
  var quad = [[best.minx, best.miny], [best.maxx, best.miny],
              [best.maxx, best.maxy], [best.minx, best.maxy]].map(function (pt) {
    return [pt[0] * c2 - pt[1] * s2, pt[0] * s2 + pt[1] * c2];
  });
  return { quad: quad, w: best.maxx - best.minx, h: best.maxy - best.miny, angle: best.ang, edge: bi };
}

// Normalize a detected quad for the warp: clockwise winding (matching the
// warp's destination order, so output is never mirrored) and starting at
// the shortest edge (so output is always portrait, w <= h).
function ecNormQuad(quad) {
  var q = quad.slice(), i;
  var s = 0;
  for (i = 0; i < 4; i++) {
    var a = q[i], b = q[(i + 1) % 4];
    s += a[0] * b[1] - b[0] * a[1];
  }
  if (s < 0) q = [q[0], q[3], q[2], q[1]];
  var len = function (p, r) { return Math.hypot(p[0] - r[0], p[1] - r[1]); };
  var bi2 = 0, bl = 1e18;
  for (i = 0; i < 4; i++) {
    var l = len(q[i], q[(i + 1) % 4]);
    if (l < bl) { bl = l; bi2 = i; }
  }
  return [q[bi2], q[(bi2 + 1) % 4], q[(bi2 + 2) % 4], q[(bi2 + 3) % 4]];
}

// Fraction of the quad perimeter lying on/near edge pixels (validation).
function ecPerimeterDensity(edges, w, h, quad) {
  var on = 0, total = 0;
  for (var e = 0; e < 4; e++) {
    var a = quad[e], b = quad[(e + 1) % 4];
    var steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (var sN = 0; sN <= steps; sN++) {
      var x = Math.round(a[0] + (b[0] - a[0]) * sN / steps);
      var y = Math.round(a[1] + (b[1] - a[1]) * sN / steps);
      var hit = false;
      for (var dy = -1; dy <= 1 && !hit; dy++) for (var dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && edges[yy * w + xx]) { hit = true; break; }
      }
      if (hit) on++;
      total++;
    }
  }
  return total ? on / total : 0;
}

function ecDetectBookRect(gray, w, h, roi, guide) {
  var n = w * h;
  // v297: with a guide ROI, verify a book-like edge structure is present and
  // then trust the guide rect itself. The user framed the shot; the detector's
  // job is presence, not re-measuring the outline (which background clutter
  // corrupts). The rect is perfectly stable, so the stability tracker just
  // gates on continued presence.
  if (roi && guide) {
    if (ecBookPresent(gray, w, h, roi, guide === 'tall')) {
      var qx = roi.x, qy = roi.y;
      var quad = ecNormQuad([[qx, qy], [qx + roi.w, qy], [qx + roi.w, qy + roi.h], [qx, qy + roi.h]]);
      return { quad: quad, cx: qx + roi.w / 2, cy: qy + roi.h / 2, w: roi.w, h: roi.h, angle: 0 };
    }
    return null;
  }
  var blur = ecBlur3(gray, w, h);
  var se = ecSobel(blur, w, h);
  if (se.max < 120) return null; // too flat to see edges
  var t = Math.max(30, Math.min(110, se.max * 0.16));
  var th = ecThreshold(se.mag, w, h, t);
  if (th.count < n * 0.004 || th.count > n * 0.4) return null;
  // Path 1: the book outline is the largest edge component (cover text
  // stays as separate small components, or merges harmlessly inside).
  // v296: with a region of interest (the on-screen guide), try the top
  // components and take the first validated rect centered in the ROI, so
  // background clutter outside the guide can no longer win.
  var edges = ecDilate(th.bin, w, h, 3);
  var r = ecRectFromPixels(edges, ecLargestComponent(edges, w, h), edges, w, h);
  if (r) return r;
  // Path 2 (fallback): interior opening — largest interior blob after
  // morphological opening erases text partitions.
  var edges1 = ecDilate(th.bin, w, h, 1);
  var bg = ecFillBackground(edges1, w, h);
  var interior = new Uint8Array(n);
  for (var i = 0; i < n; i++) interior[i] = (!edges1[i] && !bg[i]) ? 1 : 0;
  var opened = ecErode(interior, w, h, 4);
  var comp = ecLargestComponent(opened, w, h);
  if (!comp || comp.area < n * 0.04 || comp.touchesBorder) return null;
  var rest = ecDilate(opened, w, h, 4);
  var mark = new Uint8Array(n);
  var blob = ecFloodFill(rest, w, h, Math.round(comp.cx), Math.round(comp.cy), mark);
  if (blob.length < n * 0.05) return null;
  var pts = [];
  for (var k = 0; k < blob.length; k += 3) pts.push([blob[k] % w, ((blob[k] / w) | 0)]);
  return ecRectFromPixels(edges1, { pts: pts, touchesBorder: false }, edges1, w, h);
}

// Fit a validated book rect to a pixel cloud (edge-component or blob).
function ecRectFromPixels(edges, comp, vedges, w, h) {
  var n = w * h;
  if (!comp || !comp.pts || comp.pts.length < 40 || comp.touchesBorder) return null;
  var pts = [];
  for (var k = 0; k < comp.pts.length; k += 2) {
    pts.push([comp.pts[k] % w, ((comp.pts[k] / w) | 0)]);
  }
  var hull = ecConvexHull(pts);
  if (hull.length < 4) return null;
  var quad = ecNormQuad(ecMinAreaRect(hull).quad);
  var w0 = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
  var h0 = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
  if (w0 < 1 || h0 / w0 < 1 || h0 / w0 > 8) return null;
  var area = w0 * h0;
  if (area < n * 0.06 || area > n * 0.94) return null;
  if (ecPerimeterDensity(vedges, w, h, quad) < 0.3) return null;
  return {
    quad: quad,
    cx: (quad[0][0] + quad[2][0]) / 2, cy: (quad[0][1] + quad[2][1]) / 2,
    w: w0, h: h0,
    angle: Math.atan2(quad[1][1] - quad[0][1], quad[1][0] - quad[0][0]),
  };
}

// --- stability tracking: N consecutive similar rects -> auto-capture ---
function ecNewScanTracker() { return { hist: [] }; }

function ecAngDiff(a, b) {
  var d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function ecScanTrack(tr, rect) {
  if (!rect) { tr.hist.length = 0; return { stable: false, progress: 0 }; }
  tr.hist.push(rect);
  if (tr.hist.length > 8) tr.hist.shift();
  var n = tr.hist.length;
  if (n < 6) return { stable: false, progress: n / 6 };
  var a = tr.hist[0], ok = true;
  for (var i = 1; i < n; i++) {
    var b = tr.hist[i];
    if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > 7 ||
        Math.abs(a.w - b.w) / a.w > 0.09 || Math.abs(a.h - b.h) / a.h > 0.09 ||
        Math.abs(ecAngDiff(a.angle, b.angle)) > 0.07) { ok = false; break; }
  }
  return { stable: ok, progress: ok ? 1 : 0 };
}

// Lenient per-face shape gate for auto-capture (normalized: w <= h).
function ecFaceAspectOk(face, rect) {
  if (!rect || !rect.w) return false;
  var aspect = rect.h / rect.w;
  if (face.guide === 'tall') return aspect >= 1.8;
  return aspect <= 2.8;
}

// Canvas wrapper around ecWarpPixels (browser only).
function ecWarpCanvas(srcCanvas, quad, outW, outH) {
  try {
    var sctx = srcCanvas.getContext('2d');
    var sd = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    var r = ecWarpPixels(sd.data, srcCanvas.width, srcCanvas.height, quad, outW, outH);
    if (!r) return null;
    var out = document.createElement('canvas');
    out.width = r.w; out.height = r.h;
    var octx = out.getContext('2d');
    octx.putImageData(new ImageData(r.data, r.w, r.h), 0, 0);
    return out;
  } catch (e) { return null; }
}

function ecDataUrlToCanvas(dataUrl) {
  return new Promise(function (res) {
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      res(c);
    };
    img.onerror = function () { res(null); };
    img.src = dataUrl;
  });
}


/* ---------- wizard navigation ---------- */
// In-flow handoffs adopt the current history entry (overlayReplace: no
// push/back race), so the Android back-gesture walks the flow backward
// instead of killing the scan. Terminal exits (cancel/save) use
// overlayClosed. Render functions return the active token.
function ecHandoff(openFn) {
  if (!EC) { openFn(); return null; }
  var oldToken = EC.token;
  EC.token = null;
  var nt = null;
  if (oldToken && typeof overlayReplace === 'function') {
    overlayReplace(oldToken, function () { nt = openFn(); });
  } else {
    nt = openFn();
  }
  EC.token = nt;
  return nt;
}

// Back-gesture landing: the manager already popped our entry, so re-render
// the current step with a fresh one.
function ecBackToStep() {
  if (!EC) return null;
  EC.token = null;
  return ecRenderStep();
}

/* ---------- corner-drag perspective editor ---------- */
// Full-screen sheet: photo with 4 draggable corners + live warped preview.
// onUse(warpedDataUrl); onRetake() returns to the face step. Returns the
// overlay token.
function ecOpenEditor(dataUrl, faceLabel, subLabel, onUse, onRetake, initialQuad) {
  if (typeof document === 'undefined') return null;
  var ov = document.createElement('div');
  ov.className = 'ec-backdrop';
  ov.id = 'ec-editor';
  ov.innerHTML =
    '<div class="ec-sheet" role="dialog" aria-label="Adjust the corners">' +
    '<div class="ec-head"><h3 class="serif">Adjust the corners</h3>' +
    '<p class="ec-sub">' + esc(faceLabel) + (subLabel ? ' · ' + esc(subLabel) : '') + '</p></div>' +
    '<div class="ec-stage" id="ec-ed-stage">' +
      '<img id="ec-ed-img" alt="">' +
      '<svg id="ec-ed-svg" aria-hidden="true"><polygon id="ec-ed-poly" points=""/>' +
      '<g id="ec-ed-handles"></g>' +
      '<g id="ec-ed-rotg" data-rot="1" style="display:none">' +
      '<circle class="ec-halo" id="ec-ed-rothalo"/><circle class="ec-rot" id="ec-ed-rot"/>' +
      '</g></svg>' +
    '</div>' +
    '<div class="ec-prevrow"><canvas id="ec-ed-prev"></canvas><span>Live preview — drag a corner to straighten</span></div>' +
    '<div class="ec-actions">' +
      '<button class="btn ghost sm" id="ec-ed-lock">90° lock: on</button>' +
      '<button class="btn ghost" id="ec-ed-retake">Retake</button>' +
      '<button class="btn primary" id="ec-ed-use">Use this photo</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  // Long-press context menu (Android) must not hijack corner drags.
  ov.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  var img = ov.querySelector('#ec-ed-img');
  var svg = ov.querySelector('#ec-ed-svg');
  var poly = ov.querySelector('#ec-ed-poly');
  var handlesG = ov.querySelector('#ec-ed-handles');
  var rotG = ov.querySelector('#ec-ed-rotg');
  var rotHalo = ov.querySelector('#ec-ed-rothalo');
  var rotDot = ov.querySelector('#ec-ed-rot');
  var lockBtn = ov.querySelector('#ec-ed-lock');
  var prev = ov.querySelector('#ec-ed-prev');
  var W = 0, H = 0, quad = null, srcCanvas = null, prevQueued = false, tornDown = false;
  var locked = true; // 90° rectangle mode; toggle for the free quad

  var domTeardown = function () {
    if (tornDown) return; tornDown = true;
    window.removeEventListener('resize', layout);
    var n = document.getElementById('ec-editor');
    if (n) n.remove();
  };
  // System back: return to the face step (fresh entry; ours was popped).
  var token = (typeof overlayOpened === 'function')
    ? overlayOpened('ec-editor', function () { domTeardown(); ecBackToStep(); })
    : null;

  var layout = function () {
    if (!W || !quad || tornDown) return;
    var r = img.getBoundingClientRect();
    if (!r.width) return;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.style.width = r.width + 'px';
    svg.style.height = r.height + 'px';
    // v277: small visible dots (~14 CSS px) with fat invisible grab halos
    // (~30 CSS px) — easy to grab without covering the corner.
    var hr = 14 * (W / r.width);
    var halo = 30 * (W / r.width);
    var sw = 4 * (W / r.width);
    poly.setAttribute('stroke-width', sw);
    var groups = handlesG.querySelectorAll('g[data-i]');
    if (groups.length !== 4) {
      handlesG.innerHTML = '';
      quad.forEach(function (p, i) {
        var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('data-i', i);
        var h = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        h.setAttribute('r', halo);
        h.setAttribute('class', 'ec-halo');
        var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('r', hr);
        c.setAttribute('class', 'ec-handle');
        g.appendChild(h);
        g.appendChild(c);
        handlesG.appendChild(g);
      });
    } else {
      groups.forEach(function (g) {
        g.querySelector('.ec-halo').setAttribute('r', halo);
        g.querySelector('.ec-handle').setAttribute('r', hr);
      });
    }
    rotHalo.setAttribute('r', halo);
    rotDot.setAttribute('r', hr);
    drawQuad();
  };

  // Position-only update — safe to call mid-drag (never rebuilds nodes,
  // so the captured handle survives).
  var drawQuad = function () {
    if (!quad || tornDown) return;
    poly.setAttribute('points', quad.map(function (p) { return p[0] + ',' + p[1]; }).join(' '));
    var groups = handlesG.querySelectorAll('g[data-i]');
    quad.forEach(function (p, i) {
      if (groups[i]) groups[i].setAttribute('transform', 'translate(' + p[0] + ',' + p[1] + ')');
    });
    // rotate handle: above the top-edge midpoint, only in locked mode
    var r = img.getBoundingClientRect();
    if (r.width && locked) {
      var ax = ecQuadAxes(quad);
      var mx = (quad[0][0] + quad[1][0]) / 2, my = (quad[0][1] + quad[1][1]) / 2;
      var off = 52 * (W / r.width);
      rotG.setAttribute('transform',
        'translate(' + (mx - ax.v[0] * off) + ',' + (my - ax.v[1] * off) + ')');
      rotG.style.display = '';
    } else {
      rotG.style.display = 'none';
    }
  };

  var setLocked = function (v) {
    locked = v;
    if (locked && quad) quad = ecSnapToRect(quad);
    lockBtn.textContent = locked ? '90° lock: on' : '90° lock: off';
    drawQuad();
    queuePreview();
  };
  lockBtn.addEventListener('click', function () { setLocked(!locked); });

  var queuePreview = function () {
    if (prevQueued || !srcCanvas || !quad || tornDown) return;
    prevQueued = true;
    requestAnimationFrame(function () {
      prevQueued = false;
      if (tornDown) return;
      var size = ecQuadSize(quad, EC_PREVIEW_MAX);
      var w = ecWarpCanvas(srcCanvas, quad, size[0], size[1]);
      if (!w) return;
      prev.width = w.width; prev.height = w.height;
      prev.getContext('2d').drawImage(w, 0, 0);
    });
  };

  var toImage = function (clientX, clientY) {
    var r = img.getBoundingClientRect();
    return [
      Math.max(0, Math.min(W, (clientX - r.left) / r.width * W)),
      Math.max(0, Math.min(H, (clientY - r.top) / r.height * H)),
    ];
  };

  // Unified gestures (v275): corner drag resizes (locked: opposite corner
  // anchored, 90° kept; unlocked: free quad), the ring handle rotates,
  // dragging inside the quad moves it.
  var gesture = null; // 'corner' | 'rotate' | 'move'
  var cornerI = -1, rotStart = 0, moveStart = null, quadStart = null;
  svg.addEventListener('pointerdown', function (e) {
    if (tornDown || !quad) return;
    var rotT = e.target.closest('[data-rot]');
    var cT = e.target.closest('[data-i]');
    if (rotT && locked) {
      var c = ecQuadCenter(quad), p0 = toImage(e.clientX, e.clientY);
      rotStart = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
      gesture = 'rotate';
      try { rotT.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    } else if (cT) {
      cornerI = +cT.getAttribute('data-i');
      gesture = 'corner';
      try { cT.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    }
  });
  poly.addEventListener('pointerdown', function (e) {
    if (tornDown || !quad || gesture) return;
    gesture = 'move';
    moveStart = toImage(e.clientX, e.clientY);
    quadStart = quad.map(function (p) { return [p[0], p[1]]; });
    try { poly.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  svg.addEventListener('pointermove', function (e) {
    if (!gesture || tornDown || !quad) return;
    var p = toImage(e.clientX, e.clientY);
    if (gesture === 'corner') {
      quad = locked
        ? ecLockedResize(quad, cornerI, p)
        : quad.map(function (qp, j) { return j === cornerI ? p : qp; });
    } else if (gesture === 'rotate') {
      var c = ecQuadCenter(quad);
      var a = Math.atan2(p[1] - c[1], p[0] - c[0]);
      quad = ecRotateQuad(quad, a - rotStart);
      rotStart = a;
    } else if (gesture === 'move') {
      var dx = p[0] - moveStart[0], dy = p[1] - moveStart[1];
      quad = quadStart.map(function (qp) { return [qp[0] + dx, qp[1] + dy]; });
    }
    drawQuad();
    queuePreview();
  });
  var endGesture = function () { gesture = null; cornerI = -1; };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', endGesture);

  ov.querySelector('#ec-ed-retake').addEventListener('click', function () {
    domTeardown();
    ecHandoff(function () { if (onRetake) onRetake(); return EC ? EC.token : null; });
  });
  ov.querySelector('#ec-ed-use').addEventListener('click', function () {
    if (!srcCanvas || !quad) return;
    var size = ecQuadSize(quad, EC_MAX_DIM);
    var w = ecWarpCanvas(srcCanvas, quad, size[0], size[1]);
    var url = w ? w.toDataURL('image/jpeg', 0.88) : null;
    domTeardown();
    if (url) {
      ecHandoff(function () { onUse(url); return EC ? EC.token : null; });
    } else {
      if (typeof toast === 'function') toast('Could not straighten that photo — try again');
      ecHandoff(function () { ecBackToStep(); return EC ? EC.token : null; });
    }
  });

  img.onload = function () {
    W = img.naturalWidth || img.width; H = img.naturalHeight || img.height;
    if (!W || !H) {
      if (typeof toast === 'function') toast('Could not read that photo');
      domTeardown();
      ecHandoff(function () { ecBackToStep(); return EC ? EC.token : null; });
      return;
    }
    if (initialQuad && initialQuad.length === 4) {
      try { quad = ecSnapToRect(initialQuad); }
      catch (e) { quad = null; }
    }
    if (!quad) {
      var ix = W * 0.06, iy = H * 0.06;
      quad = [[ix, iy], [W - ix, iy], [W - ix, H - iy], [ix, H - iy]];
    }
    ecDataUrlToCanvas(dataUrl).then(function (c) {
      if (tornDown) return;
      srcCanvas = c;
      layout();
      queuePreview();
    });
  };
  img.src = dataUrl;
  window.addEventListener('resize', layout);
  return token;
}

/* ---------- capture sheet ---------- */
// Generic face capture: live camera with an aspect guide, or library photo.
// cb(dataUrl) — full frame; the editor does the cropping. Returns the
// overlay token. Back (button or gesture) returns to the face step.
var EC_SCAN_W = 240; // analysis width for auto-scan (px)

// Detect a book quad in a full-size canvas; returns the quad in canvas
// coords or null. Used to pre-fit the editor after a manual snap.
function ecDetectQuadForCanvas(canvas) {
  try {
    var vw = canvas.width, vh = canvas.height;
    if (!vw || !vh || typeof document === 'undefined') return null;
    var aw = EC_SCAN_W, ah = Math.max(1, Math.round(EC_SCAN_W * vh / vw));
    var ac = document.createElement('canvas');
    ac.width = aw; ac.height = ah;
    var actx = ac.getContext('2d');
    actx.drawImage(canvas, 0, 0, aw, ah);
    var d = actx.getImageData(0, 0, aw, ah);
    var r = ecDetectBookRect(ecToGray(d.data, aw, ah), aw, ah);
    if (!r) return null;
    var s = vw / aw;
    return r.quad.map(function (p) { return [p[0] * s, p[1] * s]; });
  } catch (e) { return null; }
}

/* v287: best-of-burst capture. Motion and sharpness are measured on a
   tiny grayscale copy; the full-resolution frame is retained only for the
   winning candidate. This avoids sending or storing a burst. */
function ecBurstFrameScore(canvas, previous) {
  try {
    var w = 96, h = Math.max(1, Math.round(96 * canvas.height / canvas.width));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(canvas, 0, 0, w, h);
    var px = x.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
    var dark = 0, bright = 0;
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = px[p] * .299 + px[p + 1] * .587 + px[p + 2] * .114;
      if (g[i] < 10) dark++;
      if (g[i] > 245) bright++;
    }
    var lap = 0, count = 0;
    for (var y = 1; y < h - 1; y++) for (var xx = 1; xx < w - 1; xx++) {
      var q = y * w + xx;
      var v = g[q - w] + g[q - 1] + g[q + 1] + g[q + w] - 4 * g[q];
      lap += v * v; count++;
    }
    var lapVar = count ? lap / count : 0, motion = 0;
    if (previous && previous.length === g.length) {
      for (var j = 0; j < g.length; j++) motion += Math.abs(g[j] - previous[j]);
      motion /= g.length;
    }
    var sharpness = Math.max(0, Math.min(100, 100 * (1 - Math.exp(-lapVar / 220))));
    var stability = previous ? Math.max(0, Math.min(100, 100 - motion * 2.2)) : 100;
    var exposure = Math.max(0, Math.min(100, 100 - ((dark + bright) / g.length) * 500));
    return { score: sharpness * .55 + stability * .30 + exposure * .15, gray: g };
  } catch (e) { return { score: 0, gray: null }; }
}

function ecCaptureFace(face, subLabel, stepLabel, cb) {
  if (typeof document === 'undefined') return null;
  var ov = document.createElement('div');
  ov.className = 'ec-backdrop';
  ov.id = 'ec-capture';
  ov.innerHTML =
    '<div class="ec-sheet" role="dialog" aria-label="Photograph the ' + esc(face.label) + '">' +
    '<div class="ec-head"><h3 class="serif">' + esc(face.label) + '</h3>' +
    '<p class="ec-sub">' + esc(subLabel) + (stepLabel ? ' \u00b7 ' + esc(stepLabel) : '') + '</p></div>' +
    '<div class="ec-vf"><video id="ec-video" playsinline muted autoplay></video>' +
      '<canvas id="ec-scanfx" aria-hidden="true"></canvas>' +
      '<div class="ec-guide ec-guide-' + face.guide + '" aria-hidden="true"></div></div>' +
    '<div class="ec-scanbar" id="ec-scanbar" aria-hidden="true"><i id="ec-scanfill"></i></div>' +
    '<p class="ec-hint" id="ec-scanmsg">Point at the book \u2014 hold steady to auto-scan</p>' +
    '<p class="ec-hint" id="ec-cap-hint" hidden>' + esc(face.hint) + '</p>' +
    '<input type="file" id="ec-file" accept="image/*" hidden>' +
    '<div class="ec-actions">' +
      '<button class="btn ghost" id="ec-cap-back">Back</button>' +
      '<button class="btn ghost sm" id="ec-cap-auto">Auto-scan: on</button>' +
      '<button class="btn ghost sm" id="ec-cap-torch" hidden>Flash: off</button>' +
      '<button class="btn ghost" id="ec-cap-lib">Choose photo</button>' +
      '<button class="btn primary" id="ec-cap-snap">Capture</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  var video = ov.querySelector('#ec-video');
  var fx = ov.querySelector('#ec-scanfx');
  var fxCtx = fx.getContext('2d');
  var scanBar = ov.querySelector('#ec-scanbar');
  var scanFill = ov.querySelector('#ec-scanfill');
  var scanMsg = ov.querySelector('#ec-scanmsg');
  var capHint = ov.querySelector('#ec-cap-hint');
  var autoBtn = ov.querySelector('#ec-cap-auto');
  var stream = null, tornDown = false;
  var autoOn = true, raf = 0, lastTick = 0, scanDone = false;
  var tracker = ecNewScanTracker();
  var analysis = document.createElement('canvas');
  var actx = analysis.getContext('2d');

  var stopScan = function () {
    if (raf) { try { cancelAnimationFrame(raf); } catch (e) {} raf = 0; }
  };
  var torchCleanup = null;
  var domTeardown = function () {
    if (tornDown) return; tornDown = true;
    stopScan();
    if (torchCleanup) { try { torchCleanup(); } catch (e) {} torchCleanup = null; }
    if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; }
    var n = document.getElementById('ec-capture');
    if (n) n.remove();
  };
  var token = (typeof overlayOpened === 'function')
    ? overlayOpened('ec-capture', function () { domTeardown(); ecBackToStep(); })
    : null;

  var setAuto = function (on) {
    autoOn = on;
    autoBtn.textContent = 'Auto-scan: ' + (on ? 'on' : 'off');
    tracker = ecNewScanTracker();
    scanFill.style.width = '0';
    var show = on && !!stream;
    scanBar.style.display = show ? '' : 'none';
    scanMsg.hidden = !show;
    capHint.hidden = show;
    fx.style.display = show ? '' : 'none';
    stopScan();
    if (on && !tornDown && !scanDone && stream) {
      lastTick = 0;
      raf = requestAnimationFrame(loop);
    }
  };

  // Draw the detected quad on the overlay (video-source pixel space).
  var drawFx = function (rect) {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    if (fx.width !== vw || fx.height !== vh) { fx.width = vw; fx.height = vh; }
    fxCtx.clearRect(0, 0, vw, vh);
    if (!rect) return;
    var s = vw / EC_SCAN_W;
    fxCtx.save();
    fxCtx.strokeStyle = '#7fd08a';
    fxCtx.lineWidth = Math.max(3, vw / 280);
    fxCtx.beginPath();
    rect.quad.forEach(function (p, i) {
      var x = p[0] * s, y = p[1] * s;
      if (i) fxCtx.lineTo(x, y); else fxCtx.moveTo(x, y);
    });
    fxCtx.closePath();
    fxCtx.stroke();
    fxCtx.fillStyle = '#7fd08a';
    rect.quad.forEach(function (p) {
      fxCtx.beginPath();
      fxCtx.arc(p[0] * s, p[1] * s, Math.max(5, vw / 160), 0, 6.2832);
      fxCtx.fill();
    });
    fxCtx.restore();
  };

  var setMsg = function (t) { if (scanMsg.textContent !== t) scanMsg.textContent = t; };

  var loop = function (t) {
    raf = 0;
    if (tornDown || scanDone || !autoOn) return;
    raf = requestAnimationFrame(loop);
    if (t - lastTick < 140) return;
    lastTick = t;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    var aw = EC_SCAN_W, ah = Math.max(1, Math.round(EC_SCAN_W * vh / vw));
    if (analysis.width !== aw || analysis.height !== ah) { analysis.width = aw; analysis.height = ah; }
    var d = null;
    try {
      actx.drawImage(video, 0, 0, aw, ah);
      d = actx.getImageData(0, 0, aw, ah);
    } catch (e) { return; }
    var rect = ecDetectBookRect(ecToGray(d.data, aw, ah), aw, ah);
    var shapeOk = !!(rect && ecFaceAspectOk(face, rect));
    drawFx(rect);
    var st = ecScanTrack(tracker, shapeOk ? rect : null);
    scanFill.style.width = Math.round(st.progress * 100) + '%';
    if (!rect) setMsg('Point at the book \u2014 keep it fully in view');
    else if (!shapeOk) setMsg('Wrong shape for the ' + face.label.toLowerCase() + ' \u2014 re-aim');
    else if (!st.stable) setMsg('Hold steady\u2026');
    else {
      setMsg('Captured');
      scanDone = true;
      stopScan();
      doAutoCapture(rect);
    }
  };

  var resumeScan = function () {
    scanDone = false;
    tracker = ecNewScanTracker();
    scanFill.style.width = '0';
    setMsg('Point at the book \u2014 hold steady to auto-scan');
    lastTick = 0;
    if (autoOn && !tornDown && stream) raf = requestAnimationFrame(loop);
  };

  var captureBurst = function (count) {
    return new Promise(function (resolve) {
      var frames = [], prev = null, i = 0;
      var take = function () {
        if (tornDown || !video.videoWidth) { resolve(frames); return; }
        var c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        try {
          c.getContext('2d').drawImage(video, 0, 0);
          var m = ecBurstFrameScore(c, prev);
          prev = m.gray;
          frames.push({ canvas: c, score: m.score });
          setMsg('Capturing ' + (i + 1) + '/' + count + ' — hold still');
        } catch (e) {}
        i++;
        if (i >= count) { resolve(frames); return; }
        setTimeout(take, 90);
      };
      take();
    });
  };

  var finishBurstCapture = function (frames, fallbackRect, confirmAuto) {
    if (!frames || !frames.length) { resumeScan(); return; }
    frames.sort(function (x, y) { return y.score - x.score; });
    var best = frames[0], c = best.canvas, quad = ecDetectQuadForCanvas(c);
    if (!quad && fallbackRect) {
      var s = c.width / EC_SCAN_W;
      quad = fallbackRect.quad.map(function (p) { return [p[0] * s, p[1] * s]; });
    }
    if (!quad) { if (typeof toast === 'function') toast('Could not lock onto the book — try again'); resumeScan(); return; }
    var size = ecQuadSize(quad, EC_MAX_DIM), w = ecWarpCanvas(c, quad, size[0], size[1]);
    if (!w) { if (typeof toast === 'function') toast('Capture missed — hold steadier'); resumeScan(); return; }
    var warpedUrl = null, fullUrl = null;
    try { warpedUrl = w.toDataURL('image/jpeg', 0.9); fullUrl = c.toDataURL('image/jpeg', 0.92); }
    catch (e) { resumeScan(); return; }
    domTeardown();
    ecHandoff(function () {
      if (confirmAuto) return ecOpenConfirm(warpedUrl, fullUrl, quad, face, subLabel, stepLabel, cb);
      return cb(warpedUrl, { warped: true, burstScore: best.score });
    });
  };

  var doAutoCapture = function (rect) {
    captureBurst(8).then(function (frames) { finishBurstCapture(frames, rect, true); });
  };

  var snapCanvas = function () {
    try {
      if (!video.videoWidth) return null;
      var c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      return c;
    } catch (e) { return null; }
  };
  // Hand the photo to the wizard, adopting this overlay's history entry.
  // opts.quad pre-fits the editor; opts.warped stores the photo directly.
  var gotPhoto = function (url, opts) {
    domTeardown();
    ecHandoff(function () { return cb(url, opts); });
  };

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) {
        if (tornDown) { try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} return; }
        stream = s;
        video.srcObject = s;
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
        if (typeof ecTorchWire === 'function') {
          torchCleanup = ecTorchWire(video, ov.querySelector('#ec-cap-torch'));
        }
        setAuto(true);
      })
      .catch(function () { if (typeof toast === 'function') toast('Camera unavailable \u2014 choose a photo instead'); });
  } else {
    setAuto(false);
  }

  autoBtn.addEventListener('click', function () { setAuto(!autoOn); });
  ov.querySelector('#ec-cap-back').addEventListener('click', function () {
    domTeardown();
    ecHandoff(function () { ecRenderStep(); return EC ? EC.token : null; });
  });
  ov.querySelector('#ec-cap-lib').addEventListener('click', function () {
    ov.querySelector('#ec-file').click();
  });
  ov.querySelector('#ec-file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () {
      var url = String(fr.result || '');
      if (url.indexOf('data:image') !== 0) return;
      try {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          var quad = ecDetectQuadForCanvas(c);
          gotPhoto(url, quad ? { quad: quad } : undefined);
        };
        img.onerror = function () { gotPhoto(url); };
        img.src = url;
      } catch (err) { gotPhoto(url); }
    };
    fr.onerror = function () { if (typeof toast === 'function') toast('Could not read that photo'); };
    fr.readAsDataURL(f);
  });
  ov.querySelector('#ec-cap-snap').addEventListener('click', function () {
    if (!video.videoWidth) {
      if (typeof toast === 'function') toast('Capture failed — try again');
      return;
    }
    stopScan();
    // v291: same flow as auto-scan — sharpest frame is warped to the
    // detected quad and shown already cropped in the confirm sheet
    // (Use / Adjust corners / Retake), not the corner editor.
    captureBurst(5).then(function (frames) { finishBurstCapture(frames, null, true); });
  });
  return token;
}

/* ---------- orbit capture (v294) ----------
   Hands-free multi-face scan: the user rotates the book through the prompted
   faces while the viewfinder watches. When the detected quad is stable and
   matches the target face's aspect, a burst fires, the sharpest frame is
   warped to the book edges, and the flow advances — no taps, no corner
   editor. Front/back share an aspect, so prompt order disambiguates them
   (same as the classic flow). Manual mode (the classic per-face flow) stays
   one tap away and resumes at the current face. */
// v296: map the dashed guide's box to analysis pixels. The viewfinder shows
// the video with object-fit: cover, so the guide rect is mapped through the
// cover crop back onto the video frame. Pure math — unit tested.
function ecGuideRoiMath(gr, vr, vw, vh, aw, ah) {
  if (!gr || !vr || !gr.width || !vr.width || !vw || !vh) return null;
  var elA = vr.width / vr.height, vidA = vw / vh;
  var visW, visH;
  if (vidA >= elA) { visW = elA / vidA; visH = 1; }
  else { visW = 1; visH = vidA / elA; }
  var x0 = (1 - visW) / 2, y0 = (1 - visH) / 2;
  var vx = x0 + ((gr.left - vr.left) / vr.width) * visW;
  var vy = y0 + ((gr.top - vr.top) / vr.height) * visH;
  return { x: vx * aw, y: vy * ah,
           w: (gr.width / vr.width) * visW * aw,
           h: (gr.height / vr.height) * visH * ah };
}

function ecOrbitCapture() {
  if (typeof document === 'undefined' || !EC || !EC.steps || !EC.steps.length) return null;
  var obIdx = 0, obPhase = 'aim', obTornDown = false;
  var obStream = null, obRaf = 0, obLastTick = 0, obAimSince = 0, obRoi = null;
  var obTracker = ecNewScanTracker(), obTorchCleanup = null;

  var ov = document.createElement('div');
  ov.className = 'ec-backdrop';
  ov.id = 'ec-orbit';
  ov.innerHTML =
    '<div class="ec-sheet" role="dialog" aria-label="Orbit scan">' +
    '<div class="ec-head"><h3 class="serif" id="ec-ob-title"></h3>' +
    '<p class="ec-sub" id="ec-ob-sub"></p></div>' +
    '<div class="ec-vf"><video id="ec-ob-video" playsinline muted autoplay></video>' +
    '<canvas id="ec-ob-fx" aria-hidden="true"></canvas>' +
    '<div class="ec-guide" id="ec-ob-guide" aria-hidden="true"></div></div>' +
    '<div class="ec-orbit-dots" id="ec-ob-dots" aria-hidden="true"></div>' +
    '<p class="ec-hint" id="ec-ob-msg"></p>' +
    '<div class="ec-actions">' +
    '<button class="btn ghost" id="ec-ob-cancel">Cancel</button>' +
    '<button class="btn ghost" id="ec-ob-skip">Skip</button>' +
    '<button class="btn ghost sm" id="ec-ob-torch" hidden>Flash: off</button>' +
    '<button class="btn ghost" id="ec-ob-manual">Manual mode</button>' +
    '<button class="btn primary" id="ec-ob-ready">Ready</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  var video = ov.querySelector('#ec-ob-video');
  var fx = ov.querySelector('#ec-ob-fx');
  var fxCtx = null;
  try { fxCtx = fx.getContext('2d'); } catch (e) {}
  var guide = ov.querySelector('#ec-ob-guide');
  var titleEl = ov.querySelector('#ec-ob-title'), subEl = ov.querySelector('#ec-ob-sub');
  var msgEl = ov.querySelector('#ec-ob-msg'), dotsEl = ov.querySelector('#ec-ob-dots');
  var skipBtn = ov.querySelector('#ec-ob-skip');
  var readyBtn = ov.querySelector('#ec-ob-ready');
  var analysis = document.createElement('canvas'), actx = null;
  try { actx = analysis.getContext('2d'); } catch (e) {}

  var obTeardownDom = function () {
    if (obTornDown) return; obTornDown = true;
    if (obRaf) { try { cancelAnimationFrame(obRaf); } catch (e) {} obRaf = 0; }
    if (obTorchCleanup) { try { obTorchCleanup(); } catch (e) {} obTorchCleanup = null; }
    if (obStream) { try { obStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} obStream = null; }
    var n = document.getElementById('ec-orbit'); if (n) n.remove();
  };
  var obToken = (typeof overlayOpened === 'function')
    ? overlayOpened('ec-orbit', function () { obTeardownDom(); ecCancelScan(); }) : null;

  var obSetMsg = function (t) { if (msgEl.textContent !== t) msgEl.textContent = t; };

  var obRenderDots = function () {
    var h = '';
    EC.steps.forEach(function (st, i) {
      h += '<i class="' + (i < obIdx ? 'done' : i === obIdx ? 'cur' : '') + '"></i>';
    });
    dotsEl.innerHTML = h;
  };

  var obRenderFace = function () {
    var st = EC.steps[obIdx], face = ecFaceDef(st.face);
    titleEl.textContent = face.label;
    subEl.textContent = ecAppearanceLabel(st.appearance) + ' · Face ' + (obIdx + 1) + ' of ' + EC.steps.length;
    guide.className = 'ec-guide ec-guide-' + face.guide;
    skipBtn.style.display = st.skippable ? '' : 'none';
    obTracker = ecNewScanTracker();
    obAimSince = Date.now();
    obRoi = null; // recomputed on first loop tick (guide class just changed)
    obPhase = 'ready';
    try { obDrawFx(null, video.videoWidth, video.videoHeight); } catch (e) {}
    readyBtn.style.display = '';
    obSetMsg('Position the ' + face.label.toLowerCase() + ' in the guide, then tap Ready');
    obRenderDots();
  };


  readyBtn.addEventListener('click', function () {
    if (obTornDown || obPhase !== 'ready') return;
    obTracker = ecNewScanTracker();
    obAimSince = Date.now();
    obRoi = null;
    obPhase = 'aim';
    obLastTick = 0;
    readyBtn.style.display = 'none';
    obSetMsg('Show the ' + ecFaceDef(EC.steps[obIdx].face).label.toLowerCase() + ' — hold steady');
    obRaf = requestAnimationFrame(obLoop);
  });

  var obDrawFx = function (rect, vw, vh) {
    if (!fxCtx || !vw) return;
    if (fx.width !== vw || fx.height !== vh) { fx.width = vw; fx.height = vh; }
    try {
      fxCtx.clearRect(0, 0, vw, vh);
      if (!rect || !rect.quad) return;
      var sc = vw / EC_SCAN_W;
      fxCtx.save();
      fxCtx.strokeStyle = '#7fd08a';
      fxCtx.lineWidth = Math.max(3, vw / 280);
      fxCtx.beginPath();
      rect.quad.forEach(function (p, i) {
        var x = p[0] * sc, y = p[1] * sc;
        if (i) fxCtx.lineTo(x, y); else fxCtx.moveTo(x, y);
      });
      fxCtx.closePath(); fxCtx.stroke(); fxCtx.restore();
    } catch (e) {}
  };

  var obBurst = function (count) {
    return new Promise(function (resolve) {
      var frames = [], prev = null, i = 0;
      var take = function () {
        if (obTornDown || !video.videoWidth) { resolve(frames); return; }
        var c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        try {
          c.getContext('2d').drawImage(video, 0, 0);
          var m = ecBurstFrameScore(c, prev);
          prev = m.gray;
          frames.push({ canvas: c, score: m.score });
          obSetMsg('Capturing ' + (i + 1) + '/' + count + ' — hold still');
        } catch (e) {}
        i++;
        if (i >= count) { resolve(frames); return; }
        setTimeout(take, 90);
      };
      take();
    });
  };

  var obResume = function () {
    obTracker = ecNewScanTracker();
    obAimSince = Date.now();
    obPhase = 'aim';
    obLastTick = 0;
    if (!obTornDown) obRaf = requestAnimationFrame(obLoop);
  };

  var obAdvance = function () {
    obIdx++;
    if (obIdx >= EC.steps.length) {
      obTeardownDom();
      ecHandoff(ecRenderReview);
      return;
    }
    obSetMsg('\u2713 captured');
    setTimeout(function () {
      if (obTornDown) return;
      obRenderFace();
      obLastTick = 0;
      obRaf = requestAnimationFrame(obLoop);
    }, 900);
  };

  var obFinishBurst = function (frames) {
    if (!frames.length) { obResume(); return; }
    frames.sort(function (x, y) { return y.score - x.score; });
    var c = frames[0].canvas;
    var st0 = EC.steps[obIdx], face0 = ecFaceDef(st0.face);
    obPhase = 'processing';
    obSetMsg('Processing…');
    // Two-stage crop (v301): edge tighten first, YOLO refines on disagreement.
    var cropMethod = 'guide';
    var done = function (quad) {
      if (obTornDown) return;
      var url = null;
      if (quad) {
        var size = ecQuadSize(quad, EC_MAX_DIM), w = null;
        try { w = ecWarpCanvas(c, quad, size[0], size[1]); } catch (e) {}
        if (w) { try { url = w.toDataURL('image/jpeg', 0.9); } catch (e) {} }
      }
      if (!url) {
        if (typeof toast === 'function') toast('Couldn\u2019t crop that one — hold it steadier');
        obResume();
        return;
      }
      var st = EC.steps[obIdx];
      (EC.results[st.appearance] = EC.results[st.appearance] || {})[st.face] = url;
      (EC.cropMethods = EC.cropMethods || {})[st.appearance + ':' + st.face] = cropMethod;
      // Keep the full frame + quad so Review → Adjust can re-crop.
      (EC.fullFrames = EC.fullFrames || {})[st.appearance + ':' + st.face] = c.toDataURL('image/jpeg', 0.85);
      (EC.quads = EC.quads || {})[st.appearance + ':' + st.face] = quad;
      obPhase = 'captured';
      obAdvance();
    };
    (async function () {
      var quad = null;
      try {
        if (obRoi && c.width) {
          var s = c.width / EC_SCAN_W;
          // Stage 1: edge tighten (fast, precise on clean books).
          var aw2 = EC_SCAN_W, ah2 = Math.max(1, Math.round(EC_SCAN_W * c.height / c.width));
          var ac2 = document.createElement('canvas'); ac2.width = aw2; ac2.height = ah2;
          var ax2 = ac2.getContext('2d');
          ax2.drawImage(c, 0, 0, aw2, ah2);
          var dd = ax2.getImageData(0, 0, aw2, ah2);
          var tight240 = ecTightenQuad(ecToGray(dd.data, aw2, ah2), aw2, ah2, obRoi, face0.guide === 'tall');
          var edgeQuad = tight240 ? ecNormQuad(tight240).map(function (p) { return [p[0] * s, p[1] * s]; }) : null;
          // Stage 2: YOLO (robust on damaged/warped books).
          var yoloQuad = null, yoloUsed = false;
          try {
            if (typeof ecYoloDetect === 'function' && (typeof ecYoloEnabled !== 'function' || ecYoloEnabled())) {
              obSetMsg('AI refining crop…');
              var dets = await ecYoloDetect(c);
              var roiFull = { x: obRoi.x * s, y: obRoi.y * s, w: obRoi.w * s, h: obRoi.h * s };
              var best = ecYoloBestForGuide(dets, roiFull);
              yoloQuad = ecYoloQuad(best);
              yoloUsed = !!yoloQuad;
              obSetMsg(yoloUsed ? 'AI crop applied' : 'Processing…');
            }
          } catch (e) {}
          var guideQuad = [[obRoi.x * s, obRoi.y * s], [(obRoi.x + obRoi.w) * s, obRoi.y * s],
                           [(obRoi.x + obRoi.w) * s, (obRoi.y + obRoi.h) * s], [obRoi.x * s, (obRoi.y + obRoi.h) * s]];
          var ensembled = (typeof ecEnsembleQuad === 'function' ? ecEnsembleQuad(edgeQuad, yoloQuad) : (edgeQuad || yoloQuad));
          quad = ensembled || guideQuad;
          if (quad === yoloQuad) cropMethod = 'yolo';
          else if (quad === edgeQuad) cropMethod = 'edge';
        } else {
          quad = ecDetectQuadForCanvas(c);
        }
      } catch (e) {}
      done(quad);
    })();
  };

  var obLoop = function (t) {
    obRaf = 0;
    if (obTornDown || obPhase !== 'aim') return;
    obRaf = requestAnimationFrame(obLoop);
    if (t - obLastTick < 140) return;
    obLastTick = t;
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !actx) return;
    var aw = EC_SCAN_W, ah = Math.max(1, Math.round(EC_SCAN_W * vh / vw));
    if (analysis.width !== aw || analysis.height !== ah) { analysis.width = aw; analysis.height = ah; }
    var d = null;
    try {
      actx.drawImage(video, 0, 0, aw, ah);
      d = actx.getImageData(0, 0, aw, ah);
    } catch (e) { return; }
    if (!obRoi) {
      try {
        obRoi = ecGuideRoiMath(guide.getBoundingClientRect(), video.getBoundingClientRect(),
                               video.videoWidth, video.videoHeight, aw, ah);
      } catch (e) { obRoi = null; }
    }
    var st = EC.steps[obIdx], face = ecFaceDef(st.face);
    var rect = ecDetectBookRect(ecToGray(d.data, aw, ah), aw, ah, obRoi, face.guide);
    var shapeOk = !!(rect && ecFaceAspectOk(face, rect));
    obDrawFx(rect, vw, vh);
    var trk = ecScanTrack(obTracker, shapeOk ? rect : null);
    // v295: graduated guidance. A book held too far away is the common
    // failure (the detector rejects tiny targets), and a flash hotspot
    // blinds edge detection — say so instead of repeating "hold steady".
    var noLock = !rect || !shapeOk;
    if (noLock) {
      var dt = Date.now() - obAimSince;
      if (dt > 20000) obSetMsg('Still nothing — move closer, try the flash off, or use Manual mode');
      else if (dt > 8000) obSetMsg('Move closer — fill the dashed guide with the ' + face.label.toLowerCase());
      else if (!rect) obSetMsg('Show the ' + face.label.toLowerCase() + ' — hold steady');
      else obSetMsg('Wrong shape — show the ' + face.label.toLowerCase());
    }
    else if (!trk.stable) obSetMsg('Hold steady\u2026');
    else {
      obPhase = 'burst';
      if (obRaf) { try { cancelAnimationFrame(obRaf); } catch (e) {} obRaf = 0; }
      obBurst(5).then(obFinishBurst);
      return;
    }
  };

  ov.querySelector('#ec-ob-cancel').addEventListener('click', function () {
    obTeardownDom();
    if (obToken && typeof overlayClosed === 'function') overlayClosed(obToken);
    ecCancelScan();
  });
  skipBtn.addEventListener('click', function () {
    if ((obPhase !== 'aim' && obPhase !== 'ready') || !EC.steps[obIdx].skippable) return;
    if (obRaf) { try { cancelAnimationFrame(obRaf); } catch (e) {} obRaf = 0; }
    obAdvance();
  });
  ov.querySelector('#ec-ob-manual').addEventListener('click', function () {
    if (obPhase !== 'aim' && obPhase !== 'ready') return;
    obTeardownDom();
    EC.idx = obIdx;
    ecHandoff(ecRenderStep);
  });

  // Render the first prompt immediately so the sheet is never empty, even
  // with no camera (the user can still hit Manual mode).
  obRenderFace();
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) {
        if (obTornDown) { try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} return; }
        obStream = s;
        video.srcObject = s;
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
        if (typeof ecTorchWire === 'function') {
          obTorchCleanup = ecTorchWire(video, ov.querySelector('#ec-ob-torch'));
        }
        obLastTick = 0;
        obRaf = requestAnimationFrame(obLoop);
      })
      .catch(function () {
        if (typeof toast === 'function') toast('Camera unavailable — use Manual mode instead');
      });
  } else {
    if (typeof toast === 'function') toast('Camera unavailable — use Manual mode instead');
  }
  return obToken;
}

// Confirm sheet after an auto-scan: the warped face is already straightened.
function ecOpenConfirm(warpedUrl, fullUrl, quad, face, subLabel, stepLabel, cb) {
  if (typeof document === 'undefined') return null;
  var ov = document.createElement('div');
  ov.className = 'ec-backdrop';
  ov.id = 'ec-confirm';
  ov.innerHTML =
    '<div class="ec-sheet" role="dialog" aria-label="Confirm the ' + esc(face.label) + ' scan">' +
    '<div class="ec-head"><h3 class="serif">Look right?</h3>' +
    '<p class="ec-sub">' + esc(face.label) + ' \u00b7 ' + esc(subLabel) + '</p></div>' +
    '<div class="ec-confirmimg"><img alt="Scanned ' + esc(face.label) + '"></div>' +
    '<div class="ec-actions">' +
      '<button class="btn ghost" id="ec-cf-retake">Retake</button>' +
      '<button class="btn ghost" id="ec-cf-adjust">Adjust corners</button>' +
      '<button class="btn primary" id="ec-cf-use">Use this</button>' +
    '</div></div>';
  ov.querySelector('img').src = warpedUrl;
  document.body.appendChild(ov);
  var tornDown = false;
  var domTeardown = function () {
    if (tornDown) return; tornDown = true;
    var n = document.getElementById('ec-confirm');
    if (n) n.remove();
  };
  var token = (typeof overlayOpened === 'function')
    ? overlayOpened('ec-confirm', function () { domTeardown(); ecBackToStep(); })
    : null;
  ov.querySelector('#ec-cf-use').addEventListener('click', function () {
    domTeardown();
    ecHandoff(function () { return cb(warpedUrl, { warped: true }); });
  });
  ov.querySelector('#ec-cf-adjust').addEventListener('click', function () {
    domTeardown();
    ecHandoff(function () {
      return ecOpenEditor(fullUrl, face.label, subLabel,
        function (warped) { return cb(warped); },
        function () { ecBackToStep(); return EC ? EC.token : null; },
        quad);
    });
  });
  ov.querySelector('#ec-cf-retake').addEventListener('click', function () {
    domTeardown();
    ecHandoff(function () { return ecCaptureFace(face, subLabel, stepLabel, cb); });
  });
  return token;
}

/* ---------- guided wizard ---------- */
var EC = null; // active scan session

function ecStartScan(bookId) {
  var lib = (typeof library !== 'undefined' ? library : []);
  var b = lib.find(function (x) { return x && x.id === bookId; });
  if (!b) return null;
  EC = { bookId: bookId, token: null, appearances: null, steps: [], idx: 0, results: {} };
  return ecRenderAppearance();
}

function ecAppearanceLabel(id) {
  var a = EC_APPEARANCES.find(function (x) { return x.id === id; });
  return a ? a.label : id;
}
function ecFaceDef(id) {
  return EC_FACES.find(function (x) { return x.id === id; });
}

// Pure step-list builder (tested): appearances x faces, jacket first.
// hasEdges === false drops the fore-edge face (plain page blocks need no photo).
function ecBuildSteps(appearances, hasEdges) {
  var steps = [];
  (appearances || []).forEach(function (ap) {
    EC_FACES.forEach(function (f) {
      if (f.id === 'fore_edge' && hasEdges === false) return;
      steps.push({ appearance: ap, face: f.id, skippable: !!f.skippable });
    });
  });
  return steps;
}

function ecWizardShell(inner) {
  ecCloseWizard();
  var ov = document.createElement('div');
  ov.className = 'ec-backdrop';
  ov.id = 'ec-wizard';
  ov.innerHTML = '<div class="ec-sheet" role="dialog" aria-label="Scan edition">' + inner + '</div>';
  document.body.appendChild(ov);
  return ov;
}

function ecCloseWizard() {
  var n = typeof document !== 'undefined' && document.getElementById('ec-wizard');
  if (n) n.remove();
}

function ecCancelScan() {
  if (EC && EC.token && typeof overlayClosed === 'function') overlayClosed(EC.token);
  EC = null;
  ecCloseWizard();
}

// Faces already saved on the book, grouped by appearance: { jacket: ['spine', ...] }.
// Unions the legacy data-URL faces (book.editionFaces) and the binary asset
// refs (book.editionFaceRefs) — both are real scans the user should see.
function ecExistingFaces(book) {
  var out = {};
  var seen = function (ap, face) {
    if (out[ap] && out[ap].indexOf(face) !== -1) return;
    out[ap] = out[ap] || [];
    out[ap].push(face);
  };
  var ef = (book && book.editionFaces) || {};
  Object.keys(ef).forEach(function (ap) {
    var faces = ef[ap] || {};
    Object.keys(faces).forEach(function (f) { if (faces[f]) seen(ap, f); });
  });
  var er = (book && book.editionFaceRefs) || {};
  Object.keys(er).forEach(function (ap) {
    var refs = er[ap] || {};
    Object.keys(refs).forEach(function (f) { if (refs[f]) seen(ap, f); });
  });
  return out;
}

// Asset id out of a ref, tolerating the v284/v285 plain-string shape and the
// canonical { assetId, bucket, path, width, height } object shape.
function ecRefAssetId(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  return ref.assetId || null;
}

// Remove one saved face from the book (cleans up empty appearances).
// Reads both stores; removing a binary face also drops its local IDB row so
// replaced scans don't accumulate blobs forever, and clears the shelf's
// spine pointer when it named that asset. Best effort, never throws.
// Returns true when something was actually removed.
function ecRemoveFace(book, appearance, face) {
  if (!book || !appearance || !face) return false;
  var removed = false;
  var removedAssetId = null;
  if (book.editionFaces && book.editionFaces[appearance] && book.editionFaces[appearance][face]) {
    delete book.editionFaces[appearance][face];
    if (!Object.keys(book.editionFaces[appearance]).length) delete book.editionFaces[appearance];
    if (!Object.keys(book.editionFaces).length) delete book.editionFaces;
    removed = true;
  }
  if (book.editionFaceRefs && book.editionFaceRefs[appearance] && book.editionFaceRefs[appearance][face]) {
    removedAssetId = ecRefAssetId(book.editionFaceRefs[appearance][face]);
    delete book.editionFaceRefs[appearance][face];
    if (!Object.keys(book.editionFaceRefs[appearance]).length) delete book.editionFaceRefs[appearance];
    if (!Object.keys(book.editionFaceRefs).length) delete book.editionFaceRefs;
    removed = true;
  }
  if (removedAssetId) {
    try {
      if (typeof idbAssetDelete === 'function' && typeof currentDb !== 'undefined' && currentDb) {
        idbAssetDelete(currentDb, removedAssetId).catch(function () {});
      }
    } catch (e) {}
    if (face === 'spine' && book.spinePhotoAssetId === removedAssetId) delete book.spinePhotoAssetId;
  }
  return removed;
}

function ecRenderAppearance() {
  if (typeof document === 'undefined' || !EC) return null;
  var lib = (typeof library !== 'undefined' ? library : []);
  var b = lib.find(function (x) { return x && x.id === EC.bookId; });
  var existing = ecExistingFaces(b);
  var exHtml = '';
  Object.keys(existing).forEach(function (ap) {
    var chips = existing[ap].map(function (f) {
      var fd = ecFaceDef(f);
      return '<span class="ec-chip">' + esc(fd ? fd.label : f) +
        '<button class="ec-chipse" data-ec-eh="' + esc(ap) + ':' + esc(f) + '" aria-label="Enhance">\u2728</button>' +
        '<button class="ec-chipx" data-ec-rm="' + esc(ap) + ':' + esc(f) + '" aria-label="Remove">\u00d7</button></span>';
    }).join('');
    exHtml += '<div class="ec-exrow"><span class="ec-exap">' + esc(ecAppearanceLabel(ap)) + '</span>' + chips + '</div>';
  });
  if (exHtml) {
    exHtml = '<div class="ec-existing"><p class="ec-hint">Scanned so far — tap \u00d7 to remove a face. ' +
      'New scans replace existing ones.</p>' + exHtml + '</div>';
  }
  var ov = ecWizardShell(
    '<div class="ec-head"><h3 class="serif">Scan edition</h3>' +
    '<p class="ec-sub">' + esc((b && b.title) || 'This book') + '</p></div>' +
    exHtml +
    '<p class="ec-hint">Photograph each face of this copy — spine, sprayed edges, covers. ' +
    'Does it have a dust jacket with <em>different art underneath</em>?</p>' +
    '<div class="ec-pick">' +
    '<button class="btn ghost big" id="ec-ap-jacket">Jacket only</button>' +
    '<button class="btn ghost big" id="ec-ap-both">Jacket + bare boards</button>' +
    '</div>' +
    '<div class="ec-actions"><button class="btn ghost" id="ec-ap-cancel">Cancel</button></div>');
  EC.token = (typeof overlayOpened === 'function') ? overlayOpened('ec-wizard', ecCancelScan) : null;
  ov.querySelector('#ec-ap-cancel').addEventListener('click', ecCancelScan);
  var go = function (aps) {
    EC.appearances = aps;
    ecRenderEdges();
  };
  ov.querySelector('#ec-ap-jacket').addEventListener('click', function () { go(['jacket']); });
  ov.querySelector('#ec-ap-both').addEventListener('click', function () { go(['jacket', 'board']); });
  ov.querySelectorAll('[data-ec-eh]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var parts = (btn.getAttribute('data-ec-eh') || '').split(':');
      var ap = parts[0], face = parts[1];
      var url = (b.editionFaces && b.editionFaces[ap] && b.editionFaces[ap][face]) || null;
      var ref = !url && b.editionFaceRefs && b.editionFaceRefs[ap] ? b.editionFaceRefs[ap][face] : null;
      if (!url && !ref) return;
      if (!url && ref && typeof editionAssetBlob === 'function') {
        editionAssetBlob(ref).then(function (blob) {
          if (!blob) {
            if (typeof toast === 'function') toast("Couldn't load this face for enhancing");
            return;
          }
          ecBlobToDataUrl(blob).then(function (dataUrl) {
            ecEnhancePicker(ap, face, ecEnhanceSavedCtx(b, ap, face, dataUrl, true));
          }, function () {
            if (typeof toast === 'function') toast("Couldn't load this face for enhancing");
          });
        }, function () {
          if (typeof toast === 'function') toast("Couldn't load this face for enhancing");
        });
        return;
      }
      ecEnhancePicker(ap, face, ecEnhanceSavedCtx(b, ap, face, url, false));
    });
  });
  ov.querySelectorAll('[data-ec-rm]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var parts = (btn.getAttribute('data-ec-rm') || '').split(':');
      if (!ecRemoveFace(b, parts[0], parts[1])) { ecRenderAppearance(); return; }
      if (typeof saveLibrary === 'function') saveLibrary();
      ecRenderAppearance();
      // v283: withdrawing a face you contributed also pulls it from the shared
      // pool, so a bad photo can't linger there after you've deleted it.
      ecWithdrawFace(b, parts[0], parts[1]).then(function (withdrew) {
        if (typeof toast === 'function') {
          toast(withdrew ? 'Face removed, shared copy withdrawn' : 'Face removed');
        }
      });
    });
  });
  return EC.token;
}

// v277: plain page blocks skip the sprayed-edge capture entirely.
function ecRenderEdges() {
  if (typeof document === 'undefined' || !EC) return null;
  var ov = ecWizardShell(
    '<div class="ec-head"><h3 class="serif">Page edges</h3>' +
    '<p class="ec-sub">' + esc(EC.appearances.map(ecAppearanceLabel).join(' + ')) + '</p></div>' +
    '<p class="ec-hint">Are the page edges decorated — sprayed, stenciled, or printed? ' +
    'A plain paperback doesn\u2019t need this photo.</p>' +
    '<div class="ec-pick">' +
    '<button class="btn ghost big" id="ec-edge-yes">Decorated edges</button>' +
    '<button class="btn ghost big" id="ec-edge-no">Plain pages</button>' +
    '</div>' +
    '<div class="ec-actions"><button class="btn ghost" id="ec-edge-back">Back</button></div>');
  EC.token = (typeof overlayOpened === 'function') ? overlayOpened('ec-wizard', ecCancelScan) : null;
  ov.querySelector('#ec-edge-back').addEventListener('click', ecRenderAppearance);
  var go = function (hasEdges) {
    EC.hasEdges = hasEdges;
    EC.steps = ecBuildSteps(EC.appearances, hasEdges);
    EC.idx = 0;
    // v294: orbit capture is the scan flow now — rotate the book through the
    // prompted faces hands-free. The classic per-face flow remains one tap
    // away via the orbit sheet's Manual mode button.
    ecOrbitCapture();
  };
  ov.querySelector('#ec-edge-yes').addEventListener('click', function () { go(true); });
  ov.querySelector('#ec-edge-no').addEventListener('click', function () { go(false); });
  return EC.token;
}

function ecRenderStep() {
  if (typeof document === 'undefined' || !EC) return null;
  if (EC.idx >= EC.steps.length) return ecRenderReview();
  var st = EC.steps[EC.idx];
  var face = ecFaceDef(st.face);
  var apLabel = ecAppearanceLabel(st.appearance);
  var stepLabel = 'Face ' + (EC.idx + 1) + ' of ' + EC.steps.length;
  var ov = ecWizardShell(
    '<div class="ec-head"><h3 class="serif">' + esc(face.label) + '</h3>' +
    '<p class="ec-sub">' + esc(apLabel) + ' · ' + esc(stepLabel) + '</p></div>' +
    '<div class="ec-guide ec-guide-' + face.guide + ' ec-guide-static" aria-hidden="true"></div>' +
    '<p class="ec-hint">' + esc(face.hint) + '</p>' +
    '<div class="ec-actions">' +
    (st.skippable ? '<button class="btn ghost" id="ec-st-skip">Skip</button>' : '') +
    '<button class="btn ghost" id="ec-st-cancel">Cancel scan</button>' +
    '<button class="btn primary" id="ec-st-photo">Take photo</button>' +
    '</div>');
  // Same-slot re-render reuses the single wizard history entry.
  EC.token = (typeof overlayOpened === 'function') ? overlayOpened('ec-wizard', ecCancelScan) : null;
  ov.querySelector('#ec-st-cancel').addEventListener('click', ecCancelScan);
  var skipBtn = ov.querySelector('#ec-st-skip');
  if (skipBtn) skipBtn.addEventListener('click', function () { EC.idx++; ecRenderStep(); });
  ov.querySelector('#ec-st-photo').addEventListener('click', function () {
    ecCloseWizard(); // DOM only; the handoff adopts the history entry
    ecHandoff(function () {
      return ecCaptureFace(face, apLabel, stepLabel, function (url, opts) {
        if (!url) { ecRenderStep(); return EC ? EC.token : null; }
        if (opts && opts.warped) {
          // Auto-scan already straightened the face: store it directly.
          (EC.results[st.appearance] = EC.results[st.appearance] || {})[st.face] = url;
          EC.idx++;
          ecRenderStep();
          return EC ? EC.token : null;
        }
        return ecOpenEditor(url, face.label, apLabel, function (warped) {
          (EC.results[st.appearance] = EC.results[st.appearance] || {})[st.face] = warped;
          EC.idx++;
          ecRenderStep();
          return EC ? EC.token : null;
        }, function () { ecRenderStep(); return EC ? EC.token : null; },
        opts && opts.quad);
      });
    });
  });
  return EC.token;
}

function ecRenderReview() {
  if (typeof document === 'undefined' || !EC) return null;
  var aps = EC.appearances;
  var thumbs = '';
  aps.forEach(function (ap) {
    EC_FACES.forEach(function (f) {
      var url = EC.results[ap] && EC.results[ap][f.id];
      if (!url) return;
      var cm = EC.cropMethods && EC.cropMethods[ap + ':' + f.id];
      var badge = cm === 'yolo' ? ' <b style="color:#8f8">AI</b>' : (cm === 'edge' ? ' <span style="opacity:.6">edge</span>' : '');
      thumbs += '<div class="ec-thumb"><img src="' + url + '" alt="">' +
        '<span>' + esc(f.label) + ' · ' + esc(ecAppearanceLabel(ap)) + badge + '</span>' +
        '<div class="ec-thumbbtns">' +
        '<button class="btn ghost sm" data-ec-retake="' + ap + ':' + f.id + '">Retake</button>' +
        '<button class="btn ghost sm" data-ec-adjust="' + ap + ':' + f.id + '">Adjust</button>' +
        '<button class="btn ghost sm" data-ec-aicrop="' + ap + ':' + f.id + '">\uD83E\uDD16 AI crop</button>' +
        '<button class="btn ghost sm" data-ec-enhance="' + ap + ':' + f.id + '">\u2728 Enhance</button>' +
        '</div></div>';
    });
  });
  var ov = ecWizardShell(
    '<div class="ec-head"><h3 class="serif">Review</h3>' +
    '<p class="ec-sub">Faces captured — save them to this edition</p></div>' +
    (thumbs ? '<div class="ec-grid">' + thumbs + '</div>'
            : '<p class="ec-hint">Nothing captured.</p>') +
    '<div class="ec-actions">' +
    '<button class="btn ghost" id="ec-rv-cancel">Discard</button>' +
    (thumbs ? '<button class="btn primary" id="ec-rv-save">Save faces</button>' : '') +
    '</div>');
  EC.token = (typeof overlayOpened === 'function') ? overlayOpened('ec-wizard', ecCancelScan) : null;
  ov.querySelector('#ec-rv-cancel').addEventListener('click', ecCancelScan);
  ov.querySelectorAll('[data-ec-retake]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var parts = btn.getAttribute('data-ec-retake').split(':');
      var i = EC.steps.findIndex(function (s) { return s.appearance === parts[0] && s.face === parts[1]; });
      if (i >= 0) { delete EC.results[parts[0]][parts[1]]; EC.idx = i; ecRenderStep(); }
    });
  });
  ov.querySelectorAll('[data-ec-enhance]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var parts = btn.getAttribute('data-ec-enhance').split(':');
      ecEnhancePicker(parts[0], parts[1]);
    });
  });
  ov.querySelectorAll('[data-ec-aicrop]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var parts = btn.getAttribute('data-ec-aicrop').split(':');
      var ap = parts[0], fid = parts[1], key = ap + ':' + fid;
      var fullUrl = EC.fullFrames && EC.fullFrames[key];
      if (!fullUrl) { if (typeof toast === 'function') toast('No full frame saved'); return; }
      if (typeof ecYoloDetect !== 'function') { if (typeof toast === 'function') toast('AI module not loaded'); return; }
      btn.disabled = true;
      btn.textContent = 'Working…';
      try {
        var img = new Image();
        await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = fullUrl; });
        var cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        var dets = await ecYoloDetect(cv);
        if (!dets.length) { toast('AI found no book in this frame'); return; }
        // Pick the largest detection (manual mode: no guide ROI stored)
        var best = dets[0];
        for (var i = 1; i < dets.length; i++) {
          var a = dets[i], b = best;
          var aa = (a.box[2]-a.box[0])*(a.box[3]-a.box[1]), bb = (b.box[2]-b.box[0])*(b.box[3]-b.box[1]);
          if (a.conf > b.conf && aa > bb * 0.5) best = a;
        }
        var qb = best.maskBox || best.box;
        var quad = [[qb[0],qb[1]],[qb[2],qb[1]],[qb[2],qb[3]],[qb[0],qb[3]]];
        var size = ecQuadSize(quad, EC_MAX_DIM);
        var w = ecWarpCanvas(cv, quad, size[0], size[1]);
        var url = w.toDataURL('image/jpeg', 0.9);
        (EC.results[ap] = EC.results[ap] || {})[fid] = url;
        (EC.cropMethods = EC.cropMethods || {})[key] = 'yolo';
        (EC.quads = EC.quads || {})[key] = quad;
        var w2 = document.getElementById('ec-wizard');
        if (w2) w2.remove();
        ecRenderReview();
        toast('AI crop applied');
      } catch (e) {
        toast('AI crop failed: ' + (e && e.message ? e.message : e));
      } finally {
        btn.disabled = false;
        btn.textContent = '\uD83E\uDD16 AI crop';
      }
    });
  });
  ov.querySelectorAll('[data-ec-adjust]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var parts = btn.getAttribute('data-ec-adjust').split(':');
      var ap = parts[0], fid = parts[1];
      var key = ap + ':' + fid;
      var fullUrl = EC.fullFrames && EC.fullFrames[key];
      var quad = EC.quads && EC.quads[key];
      if (!fullUrl) { if (typeof toast === 'function') toast('No full frame saved for manual adjust'); return; }
      var face = ecFaceDef(fid);
      // Hide the review while the editor is open; re-render on close.
      var wiz = document.getElementById('ec-wizard');
      if (wiz) wiz.style.display = 'none';
      ecOpenEditor(fullUrl, face.label, ecAppearanceLabel(ap),
        function (warped) {
          (EC.results[ap] = EC.results[ap] || {})[fid] = warped;
          var w2 = document.getElementById('ec-wizard');
          if (w2) w2.remove();
          ecRenderReview();
        },
        function () {
          var w2 = document.getElementById('ec-wizard');
          if (w2) w2.style.display = '';
        },
        quad);
    });
  });
  var saveBtn = ov.querySelector('#ec-rv-save');
  if (saveBtn) saveBtn.addEventListener('click', function () { ecSaveAll(); });
  return EC.token;
}

/* ---------- AI face enhancement (v281) ----------
   Opt-in per face: 'sharpen' deblurs soft camera text, 'restore' removes
   stickers/scuffs and reconstructs hidden artwork — via /api/enhance-face
   (server-side Gemini key, same as the cover reader). Always before/after
   with Keep/Discard; never applied silently. Runs in its own overlay on
   top of the review so the back gesture returns to the review. */

function ecRunEnhance(imageUrl, mode) {
  return fetch('/api/enhance-face', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageUrl, mode: mode }),
  }).then(function (res) {
    if (res.status === 429) return api429Message(res, 'The AI is busy — try again in a minute')
      .then(function (m) { throw new Error(m); });
    if (res.status === 503) throw new Error('Enhancement is not set up on this server');
    if (!res.ok) throw new Error('Enhancement failed');
    return res.json();
  }).then(function (j) {
    if (!j || typeof j.image !== 'string' || j.image.indexOf('data:image') !== 0) {
      throw new Error('The AI returned no image');
    }
    return j.image;
  });
}

function ecEnhanceShell(inner, label) {
  var old = document.getElementById('ec-enhance');
  if (old) old.remove();
  var ov = document.createElement('div');
  ov.className = 'ec-backdrop';
  ov.id = 'ec-enhance';
  ov.innerHTML = '<div class="ec-sheet" role="dialog" aria-label="' + esc(label) + '">' + inner + '</div>';
  document.body.appendChild(ov);
  return ov;
}

function ecEnhanceClose(then) {
  if (EC) EC.ehToken = null;
  var n = document.getElementById('ec-enhance');
  if (n) n.remove();
  if (then) then();
}

// Where the enhance flow reads/writes. Session faces (review screen) live in
// EC.results; saved faces (appearance screen) live on the book.
function ecEnhanceSessionCtx(ap, face) {
  return {
    label: function () { return ecEnhanceLabel(ap, face); },
    getUrl: function () { return EC && EC.results[ap] && EC.results[ap][face]; },
    store: function (url) {
      if (!EC) return;
      (EC.results[ap] = EC.results[ap] || {})[face] = url;
    },
    after: function () { ecRenderReview(); },
  };
}
// Saved-face enhance context. resolvedUrl is the face as a data URL (already
// resolved from a legacy data URL or a binary asset ref); wasBinary selects
// the binary write-back path (new IDB asset + ref update, never data URLs).
function ecEnhanceSavedCtx(book, ap, face, resolvedUrl, wasBinary) {
  return {
    label: function () { return ecEnhanceLabel(ap, face); },
    getUrl: function () {
      if (resolvedUrl) return resolvedUrl;
      return book && book.editionFaces && book.editionFaces[ap] && book.editionFaces[ap][face];
    },
    store: function (url) {
      if (!book || typeof url !== 'string') return;
      if (!wasBinary) {
        book.editionFaces = book.editionFaces || {};
        (book.editionFaces[ap] = book.editionFaces[ap] || {})[face] = url;
        if (typeof saveLibrary === 'function') saveLibrary();
        return;
      }
      var self = this;
      (async function () {
        try {
          var blob = await (await fetch(url)).blob();
          var id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID() : ('asset-' + Date.now() + '-' + Math.random().toString(36).slice(2));
          var hasIdb = (typeof idbAssetPut === 'function') &&
            (typeof currentDb !== 'undefined') && currentDb;
          if (hasIdb) {
            await idbAssetPut(currentDb, {
              id: id, blob: blob,
              isbn: (typeof spinePhotoISBN === 'function') ? spinePhotoISBN(book) : null,
              face: face, appearance: ap, createdAt: Date.now(), source: 'enhanced'
            });
          }
          var hash = (typeof ecBlobSha256 === 'function') ? await ecBlobSha256(blob) : null;
          var size = (typeof ecDataUrlSize === 'function') ? await ecDataUrlSize(url) : null;
          book.editionFaceRefs = book.editionFaceRefs || {};
          (book.editionFaceRefs[ap] = book.editionFaceRefs[ap] || {})[face] = {
            assetId: id,
            bucket: 'edition-images',
            path: face + '/' + ap + '/' + (hash || id) + '.jpg',
            width: size ? size.width : null,
            height: size ? size.height : null
          };
          if (face === 'spine') book.spinePhotoAssetId = id;
          if (typeof saveLibrary === 'function') saveLibrary();
          // Share the enhanced face as a candidate so the pool can adopt it.
          var isbn = (typeof spinePhotoISBN === 'function') ? spinePhotoISBN(book) : null;
          if (isbn && typeof ecShareFace === 'function') {
            var st = (self && self.mode === 'restore') ? 'restored' : 'sharpened';
            ecShareFace(isbn, ap, face, url, st).catch(function () {});
          }
        } catch (e) {
          if (typeof toast === 'function') toast('Could not save the enhanced face');
        }
      })();
    },
    after: function () { ecRenderAppearance(); },
  };
}
function ecEnhanceLabel(ap, face) {
  var fd = ecFaceDef(face);
  return (fd ? fd.label : face) + ' \u00b7 ' + ecAppearanceLabel(ap);
}

function ecEnhancePicker(ap, face, ctx) {
  if (typeof document === 'undefined' || !EC) return null;
  EC.eh = ctx || ecEnhanceSessionCtx(ap, face);
  if (!EC.eh.getUrl()) return null;
  var ov = ecEnhanceShell(
    '<div class="ec-head"><h3 class="serif">Enhance face</h3>' +
    '<p class="ec-sub">' + esc(EC.eh.label()) + '</p></div>' +
    '<p class="ec-hint">AI post-processing — you will see before/after and choose.</p>' +
    '<div class="ec-pick">' +
    '<button class="btn ghost big" id="ec-eh-sharpen">Sharpen text &amp; detail</button>' +
    '<button class="btn ghost big" id="ec-eh-restore">Restore damage</button>' +
    '</div>' +
    '<div class="ec-actions"><button class="btn ghost" id="ec-eh-cancel">Cancel</button></div>',
    'Enhance face');
  var closer = function () { var eh = EC && EC.eh; ecEnhanceClose(function () { if (eh) eh.after(); }); };
  EC.ehToken = (typeof overlayOpened === 'function') ? overlayOpened('ec-enhance', closer) : null;
  ov.querySelector('#ec-eh-cancel').addEventListener('click', function () {
    if (EC.ehToken && typeof overlayClosed === 'function') overlayClosed(EC.ehToken);
    var eh = EC && EC.eh;
    ecEnhanceClose(function () { if (eh) eh.after(); });
  });
  var go = function (mode) { ecEnhanceProgress(ap, face, mode); };
  ov.querySelector('#ec-eh-sharpen').addEventListener('click', function () { go('sharpen'); });
  ov.querySelector('#ec-eh-restore').addEventListener('click', function () { go('restore'); });
  return EC.ehToken;
}

function ecEnhanceProgress(ap, face, mode) {
  if (typeof document === 'undefined' || !EC || !EC.eh) return null;
  EC.eh.mode = mode;
  var url = EC.eh.getUrl();
  if (!url) { EC.eh.after(); return null; }
  var ov = ecEnhanceShell(
    '<div class="ec-head"><h3 class="serif">Enhancing\u2026</h3>' +
    '<p class="ec-sub">' + esc(EC.eh.label()) + ' \u00b7 ' +
    (mode === 'restore' ? 'Restore damage' : 'Sharpen') + '</p></div>' +
    '<div class="b3d-load"><span class="spinner"></span></div>' +
    '<p class="ec-hint" id="ec-eh-err" hidden></p>' +
    '<div class="ec-actions"><button class="btn ghost" id="ec-eh-back">Back</button></div>',
    'Enhancing face');
  var closer = function () { var eh = EC && EC.eh; ecEnhanceClose(function () { if (eh) eh.after(); }); };
  EC.ehToken = (typeof overlayOpened === 'function') ? overlayOpened('ec-enhance', closer) : null;
  ov.querySelector('#ec-eh-back').addEventListener('click', function () {
    if (EC.ehToken && typeof overlayClosed === 'function') overlayClosed(EC.ehToken);
    var eh = EC && EC.eh;
    ecEnhanceClose(function () { if (eh) eh.after(); });
  });
  ecRunEnhance(url, mode).then(function (enhanced) {
    if (!EC || !EC.eh) return;
    ecEnhanceCompare(url, enhanced);
  }).catch(function (err) {
    var e = document.querySelector('#ec-eh-err');
    if (e) { e.hidden = false; e.textContent = (err && err.message) || 'Enhancement failed'; }
    var l = ov.querySelector('.b3d-load');
    if (l) l.style.display = 'none';
  });
  return EC.ehToken;
}

function ecEnhanceCompare(origUrl, newUrl) {
  if (typeof document === 'undefined' || !EC || !EC.eh) return null;
  var eh = EC.eh;
  var ov = ecEnhanceShell(
    '<div class="ec-head"><h3 class="serif">Before / after</h3>' +
    '<p class="ec-sub">' + esc(eh.label()) + '</p></div>' +
    '<div class="ec-compare">' +
    '<figure><img id="ec-cmp-before" alt="Before"><figcaption>Before</figcaption></figure>' +
    '<figure><img id="ec-cmp-after" alt="After"><figcaption>After</figcaption></figure>' +
    '</div>' +
    '<div class="ec-actions">' +
    '<button class="btn ghost" id="ec-eh-discard">Discard</button>' +
    '<button class="btn primary" id="ec-eh-keep">Keep enhancement</button>' +
    '</div>',
    'Compare enhancement');
  ov.querySelector('#ec-cmp-before').src = origUrl;
  ov.querySelector('#ec-cmp-after').src = newUrl;
  var closer = function () { var eh2 = EC && EC.eh; ecEnhanceClose(function () { if (eh2) eh2.after(); }); };
  if (typeof overlayOpened === 'function') overlayOpened('ec-enhance', closer);
  var done = function (storeIt) {
    return function () {
      if (EC && EC.ehToken && typeof overlayClosed === 'function') overlayClosed(EC.ehToken);
      var eh3 = EC && EC.eh;
      ecEnhanceClose(function () {
        if (storeIt && eh3) eh3.store(newUrl);
        if (eh3) eh3.after();
      });
    };
  };
  ov.querySelector('#ec-eh-discard').addEventListener('click', done(false));
  ov.querySelector('#ec-eh-keep').addEventListener('click', done(true));
  return true;
}

// sha256 hex of a Blob (content-addressed pool path), or null on failure.
function ecBlobToDataUrl(blob) {
  return new Promise(function (resolve, reject) {
    try {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('read failed')); };
      fr.readAsDataURL(blob);
    } catch (e) { reject(e); }
  });
}
async function ecBlobSha256(blob) {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle || !blob) return null;
    var bytes = await blob.arrayBuffer();
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function (x) {
      return x.toString(16).padStart(2, '0');
    }).join('');
  } catch (e) { return null; }
}

// Pixel dimensions of a data URL, dependency-free. Null when undecodable
// (e.g. no DOM) — the ref then just carries null width/height.
function ecDataUrlSize(dataUrl) {
  return new Promise(function (resolve) {
    if (typeof Image === 'undefined' || typeof dataUrl !== 'string') { resolve(null); return; }
    var img = new Image();
    img.onload = function () { resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 }); };
    img.onerror = function () { resolve(null); };
    img.src = dataUrl;
  });
}

// Persist: local book fields + shared pool contributions (pool: first writer wins).
async function ecSaveAll() {
  if (!EC) return;
  var lib = (typeof library !== 'undefined' ? library : []);
  var b = lib.find(function (x) { return x && x.id === EC.bookId; });
  var results = EC.results;
  var token = EC.token;
  var hasEdges = EC.hasEdges;
  var appearances = EC.appearances;
  EC = null;
  ecCloseWizard();
  if (token && typeof overlayClosed === 'function') overlayClosed(token);
  if (!b) return;

  var isbn = (typeof spinePhotoISBN === 'function') ? spinePhotoISBN(b) : null;
  b.editionFaceRefs = b.editionFaceRefs || {};
  var order = ['jacket', 'board', 'slipcase'];

  // v284: persist captured binaries separately from the book record when the
  // IndexedDB asset store is available. Keep the old data-URL representation
  // only as a compatibility fallback for browsers without IndexedDB.
  var useAssetStore = typeof idbAssetPut === 'function' && typeof currentDb !== 'undefined' && currentDb;
  for (var oi = 0; oi < order.length; oi++) {
    var ap0 = order[oi], fs0 = results[ap0];
    if (!fs0) continue;
    b.editionFaceRefs[ap0] = b.editionFaceRefs[ap0] || {};
    var keys0 = Object.keys(fs0);
    for (var ki = 0; ki < keys0.length; ki++) {
      var face0 = keys0[ki], data0 = fs0[face0];
      if (!useAssetStore) {
        b.editionFaces = b.editionFaces || {};
        b.editionFaces[ap0] = b.editionFaces[ap0] || {};
        b.editionFaces[ap0][face0] = data0;
        continue;
      }
      try {
        var blob0 = await (await fetch(data0)).blob();
        var id0 = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID() : ('asset-' + Date.now() + '-' + Math.random().toString(36).slice(2));
        await idbAssetPut(currentDb, {
          id: id0,
          blob: blob0,
          isbn: isbn || null,
          face: face0,
          appearance: ap0,
          createdAt: Date.now(),
          source: 'capture'
        });
        // v285+: the ref is the canonical binary shape
        // { assetId, bucket, path, width, height }. The content-addressed path
        // matches the shared-pool upload convention so a later share dedups
        // against this exact object.
        var hash0 = await ecBlobSha256(blob0);
        var size0 = await ecDataUrlSize(data0);
        b.editionFaceRefs[ap0][face0] = {
          assetId: id0,
          bucket: 'edition-images',
          path: face0 + '/' + ap0 + '/' + (hash0 || id0) + '.jpg',
          width: size0 ? size0.width : null,
          height: size0 ? size0.height : null
        };
        if (face0 === 'spine') {
          // Shelf compatibility: the shelf renderer resolves spinePhotoAssetId
          // to the local binary, so scanned spines keep showing on the shelf.
          // Clear any stale embedded data URL — book JSON and sync payloads
          // must never carry image bytes again.
          b.spinePhotoAssetId = id0;
          if (typeof b.spinePhoto === 'string' && b.spinePhoto.indexOf('data:image/') === 0) {
            delete b.spinePhoto;
          }
        }
      } catch (e) {
        // Never discard the only local copy if the asset store fails.
        b.editionFaces = b.editionFaces || {};
        b.editionFaces[ap0] = b.editionFaces[ap0] || {};
        b.editionFaces[ap0][face0] = data0;
      }
    }
  }

  // v282: "Plain pages" deliberately removes stale fore-edge captures.
  if (hasEdges === false) {
    (appearances || []).forEach(function (ap) {
      if (b.editionFaceRefs[ap]) {
        delete b.editionFaceRefs[ap].fore_edge;
        if (!Object.keys(b.editionFaceRefs[ap]).length) delete b.editionFaceRefs[ap];
      }
      if (b.editionFaces && b.editionFaces[ap]) {
        delete b.editionFaces[ap].fore_edge;
        if (!Object.keys(b.editionFaces[ap]).length) delete b.editionFaces[ap];
      }
    });
  }
  if (!Object.keys(b.editionFaceRefs).length) delete b.editionFaceRefs;
  if (b.editionFaces && !Object.keys(b.editionFaces).length) delete b.editionFaces;

  if (typeof saveLibrary === 'function') saveLibrary();

  if (isbn) {
    for (var i = 0; i < order.length; i++) {
      var ap = order[i], fs = results[ap];
      if (!fs) continue;
      var keys = Object.keys(fs);
      for (var j = 0; j < keys.length; j++) {
        await ecShareFace(isbn, ap, keys[j], fs[keys[j]]);
      }
    }
  }
  if (typeof toast === 'function') toast('Edition faces saved');
}

// The signed-in user's id for pool attribution, or null.
async function ecPoolUid(sb) {
  try {
    var ug = await sb.auth.getUser();
    return (ug && ug.data && ug.data.user) ? ug.data.user.id : null;
  } catch (e) { return null; }
}

// Contribute one face to the shared pool. First writer wins between users,
// but the original contributor's newer capture auto-replaces their own image
// (v283) — a bad first photo can never get permanently stuck.
async function ecShareFace(isbn, appearance, face, dataUrl, sourceType) {
  try {
    if (!isbn || typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) return false;
    var sb = await (typeof cloudClient === 'function' ? cloudClient().catch(function () { return null; }) : null);
    if (!sb) return false;
    var uid = await ecPoolUid(sb);
    if (!uid) return false;

    // v286: every upload is an immutable candidate. The database trigger
    // continuously chooses the best non-rejected candidate, so a better
    // later scan can replace a weak first upload without deleting evidence.
    var editionRes = await sb.from('editions').select('id').eq('isbn', isbn).maybeSingle();
    var editionId = editionRes && editionRes.data ? editionRes.data.id : null;
    if (!editionId) return false;

    var quality = null;
    if (typeof editionAnalyzeDataUrl === 'function') {
      try { quality = await editionAnalyzeDataUrl(dataUrl); } catch (e) { quality = null; }
    }
    var blob = await (await fetch(dataUrl)).blob();
    var bytes = await blob.arrayBuffer();
    var digest = await crypto.subtle.digest('SHA-256', bytes);
    var hash = Array.from(new Uint8Array(digest)).map(function (x) {
      return x.toString(16).padStart(2, '0');
    }).join('');
    var path = face + '/' + appearance + '/' + hash + '.jpg';

    var existing = await sb.from('edition_assets').select('id').eq('bucket', 'edition-images').eq('path', path).maybeSingle();
    var assetId = existing && existing.data ? existing.data.id : null;
    if (!assetId) {
      var up = await sb.storage.from('edition-images').upload(path, blob, {
        contentType: 'image/jpeg', upsert: false
      });
      if (up.error && !(up.error.statusCode === '409' || up.error.statusCode === 409 ||
          /exists/i.test(up.error.message || ''))) return false;

      var row = await sb.from('edition_assets').insert({
        edition_id: editionId,
        isbn: isbn,
        face: face,
        appearance: appearance,
        bucket: 'edition-images',
        path: path,
        width: quality && quality.width || null,
        height: quality && quality.height || null,
        format: 'image/jpeg',
        byte_size: blob.size,
        sha256: hash,
        source_type: sourceType || 'capture',
        source_user_id: uid,
        quality_score: quality && quality.quality || null,
        sharpness_score: quality && quality.sharpness || null,
        exposure_score: quality && quality.exposure || null,
        perspective_score: quality && quality.perspective || null,
        coverage_score: quality && quality.coverage || null,
        glare_score: quality && quality.glare || null,
        resolution_score: quality && quality.resolution || null,
        stability_score: quality && quality.stability || null
      }).select('id').single();
      if (row.error) {
        var raced = await sb.from('edition_assets').select('id').eq('bucket', 'edition-images').eq('path', path).maybeSingle();
        assetId = raced && raced.data ? raced.data.id : null;
        if (!assetId) return false;
      } else {
        assetId = row.data.id;
      }
    }

    var slot = await sb.from('edition_asset_slots')
      .select('canonical_asset_id')
      .eq('edition_id', editionId)
      .eq('face', face)
      .eq('appearance', appearance)
      .maybeSingle();

    if (!slot || !slot.data) {
      // unique(edition_id, face, appearance): the trigger usually creates the
      // slot first, so insert-only-if-absent — a 409 here used to look like
      // failure. Never overwrite the trigger's row on a race.
      var si = await sb.from('edition_asset_slots').upsert({
        edition_id: editionId,
        isbn: isbn,
        face: face,
        appearance: appearance,
        canonical_asset_id: assetId,
        selection_method: 'automatic',
        selected_by: uid
      }, { onConflict: 'edition_id,face,appearance', ignoreDuplicates: true });
      if (si.error) {
        var racedSlot = await sb.from('edition_asset_slots')
          .select('canonical_asset_id')
          .eq('edition_id', editionId).eq('face', face).eq('appearance', appearance)
          .maybeSingle();
        if (!racedSlot || !racedSlot.data) return false;
      }
    }

    // Compatibility read model: only expose this asset through the legacy
    // table when it is actually canonical. Existing viewers therefore keep
    // working while the new repository model is rolled out.
    var canonical = await sb.from('edition_asset_slots')
      .select('canonical_asset_id')
      .eq('edition_id', editionId).eq('face', face).eq('appearance', appearance)
      .maybeSingle();
    if (canonical && canonical.data && canonical.data.canonical_asset_id === assetId) {
      await sb.from('edition_images').upsert({
        isbn: isbn, edition_id: editionId, face: face, appearance: appearance,
        bucket: 'edition-images', path: path, uploaded_by: uid,
        updated_at: new Date().toISOString()
      }, { onConflict: 'isbn,face,appearance' });
    }
    return true;
  } catch (e) { return false; }
}

// v285+: withdraw a contributed pool image under the immutable-candidate model.
// Finds this user's edition_assets candidates for (isbn, face, appearance),
// quarantines each storage object using its STORED path (never recomputed —
// new paths are content-addressed), then deletes the candidate row. The
// contributor self-delete policy permits this; the canonical-selection trigger
// re-runs on candidate delete and repoints the slot automatically, so the slot
// is deliberately left alone. The legacy edition_images compat row is
// withdrawn the same way when owned by this user (ownership on uploaded_by).
// Returns true only when at least one candidate (or legacy row) was actually
// withdrawn, so the "shared copy withdrawn" toast stays truthful.
async function ecWithdrawFace(book, appearance, face) {
  try {
    var isbn = (typeof spinePhotoISBN === 'function') ? spinePhotoISBN(book) : null;
    if (!isbn) return false;
    var sb = await (typeof cloudClient === 'function' ? cloudClient().catch(function () { return null; }) : null);
    if (!sb) return false;
    var uid = await ecPoolUid(sb);
    if (!uid) return false;
    var withdrew = false;

    var cands = await sb.from('edition_assets').select('id,bucket,path,source_user_id')
      .eq('isbn', isbn).eq('face', face).eq('appearance', appearance);
    var rows = (cands && cands.data) || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || r.source_user_id !== uid) continue; // not mine to withdraw
      if (r.path) {
        var short = String(r.id || '').replace(/-/g, '').slice(0, 8) || 'x';
        try {
          await sb.storage.from(r.bucket || 'edition-images').move(r.path,
            'quarantine/withdrawn-' + face + '-' + appearance + '-' + isbn + '-' + short + '.jpg');
        } catch (e) {}
      }
      var del = await sb.from('edition_assets').delete().eq('id', r.id);
      if (del && !del.error) withdrew = true;
    }

    var seen = await sb.from('edition_images').select('isbn,uploaded_by')
      .eq('isbn', isbn).eq('face', face).eq('appearance', appearance).maybeSingle();
    if (seen && seen.data && seen.data.uploaded_by === uid) {
      var ldel = await sb.from('edition_images').delete()
        .eq('isbn', isbn).eq('face', face).eq('appearance', appearance);
      if (ldel && !ldel.error) withdrew = true;
    }
    return withdrew;
  } catch (e) { return false; }
}
