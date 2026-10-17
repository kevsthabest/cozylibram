'use strict';

/* js/203-editionvision.js — Edition vision core: the pure
 * pixel/geometry half of edition-face capture — homography and
 * auto-scan book detection.
 *
 * This half was split out of js/206-editioncapture.js so the vision
 * unit tests can reach it without loading the whole capture wizard
 * (v557). It holds no UI and no session state: the only top-level
 * values are the functions below and the EC_ALPHA / EC_BETA corner
 * tables, and even the scan tracker is a plain object the caller
 * owns and passes back in. Contents: homography solve / invert /
 * apply plus the pixel warp, the locked-rectangle quad ops, the
 * auto-scan detection pipeline (grayscale / blur / Sobel /
 * morphology / flood fill / components / convex hull / min-area
 * rect / scan tracker), the orbit guide-ROI mapping, and two canvas
 * adapters (ecWarpCanvas, ecDataUrlToCanvas) — the only functions
 * here that touch the DOM.
 *
 * js/206-editioncapture.js is the only consumer: its capture sheet,
 * corner editor, and orbit flow call these functions through the
 * window bridge at the bottom of this file, so this module must load
 * before js/206 in index.html. The surface is pinned by
 * .test/editioncapture.test.js and .test/orbit-roi.test.js. Apart
 * from platform globals (ImageData, Uint16Array), this file reads
 * nothing from any other module.
 */

/* ---------- homography ---------- */

// Solve the 3x3 homography mapping src quad -> dst quad (h33 pinned to 1).
// Quads are arrays of 4 [x, y] in TL TR BR BL order. Returns null on failure.
export function ecSolveHomography(src, dst) {
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

export function ecInvert3(m) {
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

export function ecApplyH(H, x, y) {
  var X = H[0][0] * x + H[0][1] * y + H[0][2];
  var Y = H[1][0] * x + H[1][1] * y + H[1][2];
  var W = H[2][0] * x + H[2][1] * y + H[2][2];
  return [X / W, Y / W];
}

// Pure pixel warp: inverse-map every output pixel through the homography
// and bilinear-sample the source. No DOM/canvas — unit-testable.
// spx: Uint8ClampedArray RGBA, sw x sh. Returns { data, w, h } or null.
export function ecWarpPixels(spx, sw, sh, quad, outW, outH) {
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

export function ecSample(px, w, h, x, y, ch) {
  if (x < 0) x = 0; else if (x >= w) x = w - 1;
  if (y < 0) y = 0; else if (y >= h) y = h - 1;
  return px[(y * w + x) * 4 + ch];
}

// Output dimensions from a quad: average opposite-edge lengths, capped.
export function ecQuadSize(quad, maxDim) {
  var dist = function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  var w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  var h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  var s = Math.min(1, maxDim / Math.max(w, h, 1));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// ---------- locked-rectangle helpers ----------
// Books are always 90° rectangles, so the editor defaults to a locked
// rectangle: corner drags resize (opposite corner anchored), a rotate
// handle straightens tilt, dragging inside moves. Free-quad mode stays
// available behind the lock toggle for badly skewed shots.
export var EC_ALPHA = [0, 1, 1, 0], EC_BETA = [0, 0, 1, 1]; // rect-space coords per corner (TL TR BR BL)

export function ecQuadCenter(q) {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
          (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

export function ecQuadAxes(q) {
  var ux = q[1][0] - q[0][0], uy = q[1][1] - q[0][1];
  var vx = q[3][0] - q[0][0], vy = q[3][1] - q[0][1];
  var ul = Math.hypot(ux, uy) || 1, vl = Math.hypot(vx, vy) || 1;
  return { u: [ux / ul, uy / ul], v: [vx / vl, vy / vl] };
}

// Resize a rectangle by dragging corner i to P; the opposite corner stays
// anchored and the 90° angles are preserved. Returns the new quad.
export function ecLockedResize(q, i, P) {
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

export function ecRotateQuad(q, delta) {
  var c = ecQuadCenter(q), cos = Math.cos(delta), sin = Math.sin(delta);
  return q.map(function (p) {
    var x = p[0] - c[0], y = p[1] - c[1];
    return [c[0] + x * cos - y * sin, c[1] + x * sin + y * cos];
  });
}

// Fit the closest rectangle to a free quad (used when re-enabling the lock).
export function ecSnapToRect(q) {
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

/* ---------- auto-scan book detection ----------
   Pure image pipeline (no DOM): downscaled grayscale in, rotated rectangle
   out. Finds the book as the largest interior region after morphological
   opening (erases cover text/partitions, keeps the book blob), fits a
   min-area rectangle to its convex hull, and verifies edge density along
   the rect perimeter. Returns { quad, cx, cy, w, h, angle } in input px
   (quad normalized: portrait winding, short edge first) or null. */

export function ecToGray(rgba, w, h) {
  var g = new Uint8ClampedArray(w * h);
  for (var i = 0; i < w * h; i++) {
    g[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  }
  return g;
}

export function ecBlur3(g, w, h) {
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

export function ecSobel(g, w, h) {
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

// One-pass separated Sobel (|gx|, |gy|): the guided-detection code
// projects the two gradient directions separately, so it needs them
// unmixed (v297).
export function ecSobelSep(g, w, h) {
  var gx = new Uint16Array(w * h), gy = new Uint16Array(w * h);
  for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
    var i = y * w + x;
    gx[i] = Math.abs(-g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]);
    gy[i] = Math.abs(-g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]);
  }
  return { gx: gx, gy: gy };
}

// One-time precise crop for the burst frame. Aiming uses the guide
// rect (stable); here we measure the book's actual edges once — no
// flicker risk — and tighten the crop so the 3D view isn't padded
// with background. Returns a quad in the input coords, or null
// (caller falls back to guide). (v299)
export function ecTightenQuad(gray, w, h, roi, tall) {
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

// Region contrast — the strongest object-vs-surroundings signal over
// centered candidate strips at several widths. A book bounds a region
// that differs from what's beside it; texture (floor, wall) does
// not. (v298)
export function ecRegionContrast(gray, w, h, roi, tall) {
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

// Book-likeness in the guide. A long straight edge alone is not
// enough (wood floors have those). A book face shows FEW dominant
// parallel edges — a spine usually two, a weak-contrast spine one
// strong edge bounding a contrasting region — while texture shows
// many. (v298)
export function ecBookPresent(gray, w, h, roi, tall) {
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

export function ecThreshold(mag, w, h, t) {
  var o = new Uint8Array(w * h), c = 0;
  for (var i = 0; i < w * h; i++) if (mag[i] > t) { o[i] = 1; c++; }
  return { bin: o, count: c };
}

export function ecDilate(bin, w, h, iters) {
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

export function ecErode(bin, w, h, iters) {
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
export function ecFloodFill(bin, w, h, sx, sy, mark) {
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
export function ecFillBackground(edges, w, h) {
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
export function ecTopComponents(mask, w, h, k) {
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
export function ecLargestComponent(mask, w, h) {
  return ecTopComponents(mask, w, h, 1)[0] || null;
}

// Andrew's monotone chain.
export function ecConvexHull(pts) {
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
export function ecMinAreaRect(hull) {
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
export function ecNormQuad(quad) {
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
export function ecPerimeterDensity(edges, w, h, quad) {
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

export function ecDetectBookRect(gray, w, h, roi, guide) {
  var n = w * h;
  // With a guide ROI, verify a book-like edge structure is present
  // and then trust the guide rect itself. The user framed the shot;
  // the detector's job is presence, not re-measuring the outline
  // (which background clutter corrupts). The rect is perfectly
  // stable, so the stability tracker just gates on continued
  // presence. (v297)
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
  // Path 1: the book outline is the largest edge component (cover
  // text stays as separate small components, or merges harmlessly
  // inside).
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
export function ecRectFromPixels(edges, comp, vedges, w, h) {
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
export function ecNewScanTracker() { return { hist: [] }; }

export function ecAngDiff(a, b) {
  var d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function ecScanTrack(tr, rect) {
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
export function ecFaceAspectOk(face, rect) {
  if (!rect || !rect.w) return false;
  var aspect = rect.h / rect.w;
  if (face.guide === 'tall') return aspect >= 1.8;
  return aspect <= 2.8;
}

// Canvas wrapper around ecWarpPixels (browser only).
export function ecWarpCanvas(srcCanvas, quad, outW, outH) {
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

export function ecDataUrlToCanvas(dataUrl) {
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


/* ---------- guide ROI math (orbit capture) ---------- */

// Map the dashed guide's box to analysis pixels. The viewfinder
// shows the video with object-fit: cover, so the guide rect is
// mapped through the cover crop back onto the video frame. Pure
// math — unit tested. (v296)
export function ecGuideRoiMath(gr, vr, vw, vh, aw, ah) {
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

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Its one consumer, js/206-editioncapture.js,
   still calls these vision functions as globals at runtime, so the
   bridge republishes exactly the pre-conversion public surface on
   window. Bare-name lookups resolve through the global object, so
   the caller needs no changes. Module scripts are deferred, so the
   bridge is in place before any consumer can run. Remove a name
   from this bridge only when its last window-reading caller has
   wired the read as an import (ADR-003). */
window.EC_ALPHA = EC_ALPHA;
window.EC_BETA = EC_BETA;
window.ecAngDiff = ecAngDiff;
window.ecApplyH = ecApplyH;
window.ecBlur3 = ecBlur3;
window.ecBookPresent = ecBookPresent;
window.ecConvexHull = ecConvexHull;
window.ecDataUrlToCanvas = ecDataUrlToCanvas;
window.ecDetectBookRect = ecDetectBookRect;
window.ecDilate = ecDilate;
window.ecErode = ecErode;
window.ecFaceAspectOk = ecFaceAspectOk;
window.ecFillBackground = ecFillBackground;
window.ecFloodFill = ecFloodFill;
window.ecGuideRoiMath = ecGuideRoiMath;
window.ecInvert3 = ecInvert3;
window.ecLargestComponent = ecLargestComponent;
window.ecLockedResize = ecLockedResize;
window.ecMinAreaRect = ecMinAreaRect;
window.ecNewScanTracker = ecNewScanTracker;
window.ecNormQuad = ecNormQuad;
window.ecPerimeterDensity = ecPerimeterDensity;
window.ecQuadAxes = ecQuadAxes;
window.ecQuadCenter = ecQuadCenter;
window.ecQuadSize = ecQuadSize;
window.ecRectFromPixels = ecRectFromPixels;
window.ecRegionContrast = ecRegionContrast;
window.ecRotateQuad = ecRotateQuad;
window.ecSample = ecSample;
window.ecScanTrack = ecScanTrack;
window.ecSnapToRect = ecSnapToRect;
window.ecSobel = ecSobel;
window.ecSobelSep = ecSobelSep;
window.ecSolveHomography = ecSolveHomography;
window.ecThreshold = ecThreshold;
window.ecTightenQuad = ecTightenQuad;
window.ecToGray = ecToGray;
window.ecTopComponents = ecTopComponents;
window.ecWarpCanvas = ecWarpCanvas;
window.ecWarpPixels = ecWarpPixels;
