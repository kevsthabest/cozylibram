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

// Largest connected component of a binary mask, scored by area biased
// toward the frame center (the user aims at the book).
function ecLargestComponent(mask, w, h) {
  var seen = new Uint8Array(w * h);
  var best = null, bestScore = 0;
  var ccx = w / 2, ccy = h / 2, maxd = Math.hypot(ccx, ccy) || 1;
  for (var i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    var pts = ecFloodFill(mask, w, h, i % w, (i / w) | 0, seen);
    if (!pts.length) continue;
    var sx = 0, sy = 0, tb = false;
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k], x = p % w, y = (p / w) | 0;
      sx += x; sy += y;
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3) tb = true;
    }
    var cx = sx / pts.length, cy = sy / pts.length;
    var score = pts.length * (1.35 - Math.hypot(cx - ccx, cy - ccy) / maxd);
    if (score > bestScore) {
      bestScore = score;
      best = { pts: pts, area: pts.length, cx: cx, cy: cy, touchesBorder: tb };
    }
  }
  return best;
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

function ecDetectBookRect(gray, w, h) {
  var n = w * h;
  var blur = ecBlur3(gray, w, h);
  var se = ecSobel(blur, w, h);
  if (se.max < 120) return null; // too flat to see edges
  var t = Math.max(30, Math.min(110, se.max * 0.16));
  var th = ecThreshold(se.mag, w, h, t);
  if (th.count < n * 0.004 || th.count > n * 0.4) return null;
  // Path 1: the book outline is the largest edge component (cover text
  // stays as separate small components, or merges harmlessly inside).
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
  var domTeardown = function () {
    if (tornDown) return; tornDown = true;
    stopScan();
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

  var doAutoCapture = function (rect) {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) { resumeScan(); return; }
    var c = document.createElement('canvas');
    c.width = vw; c.height = vh;
    try { c.getContext('2d').drawImage(video, 0, 0); }
    catch (e) { resumeScan(); return; }
    var s = vw / EC_SCAN_W;
    var quad = rect.quad.map(function (p) { return [p[0] * s, p[1] * s]; });
    var size = ecQuadSize(quad, EC_MAX_DIM);
    var w = ecWarpCanvas(c, quad, size[0], size[1]);
    if (!w) {
      if (typeof toast === 'function') toast('Auto-scan missed \u2014 hold steadier');
      resumeScan();
      return;
    }
    var warpedUrl = null, fullUrl = null;
    try {
      warpedUrl = w.toDataURL('image/jpeg', 0.9);
      fullUrl = c.toDataURL('image/jpeg', 0.92);
    } catch (e) { resumeScan(); return; }
    domTeardown();
    ecHandoff(function () {
      return ecOpenConfirm(warpedUrl, fullUrl, quad, face, subLabel, stepLabel, cb);
    });
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
    var c = snapCanvas();
    if (!c) {
      if (typeof toast === 'function') toast('Capture failed \u2014 try again');
      return;
    }
    var quad = ecDetectQuadForCanvas(c);
    var url = null;
    try { url = c.toDataURL('image/jpeg', 0.92); } catch (e) {}
    if (url) gotPhoto(url, quad ? { quad: quad } : undefined);
    else if (typeof toast === 'function') toast('Capture failed \u2014 try again');
  });
  return token;
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
function ecExistingFaces(book) {
  var out = {};
  var ef = (book && book.editionFaces) || {};
  Object.keys(ef).forEach(function (ap) {
    var faces = ef[ap] || {};
    var ids = Object.keys(faces).filter(function (f) { return !!faces[f]; });
    if (ids.length) out[ap] = ids;
  });
  return out;
}

// Remove one saved face from the book (cleans up empty appearances).
// Returns true when something was actually removed.
function ecRemoveFace(book, appearance, face) {
  if (!book || !book.editionFaces || !book.editionFaces[appearance]) return false;
  if (!book.editionFaces[appearance][face]) return false;
  delete book.editionFaces[appearance][face];
  if (!Object.keys(book.editionFaces[appearance]).length) delete book.editionFaces[appearance];
  if (!Object.keys(book.editionFaces).length) delete book.editionFaces;
  return true;
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
  ov.querySelectorAll('[data-ec-rm]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var parts = (btn.getAttribute('data-ec-rm') || '').split(':');
      if (ecRemoveFace(b, parts[0], parts[1])) {
        if (typeof saveLibrary === 'function') saveLibrary();
        if (typeof toast === 'function') toast('Face removed');
      }
      ecRenderAppearance();
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
    ecRenderStep();
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
      thumbs += '<div class="ec-thumb"><img src="' + url + '" alt="">' +
        '<span>' + esc(f.label) + ' · ' + esc(ecAppearanceLabel(ap)) + '</span>' +
        '<button class="btn ghost sm" data-ec-retake="' + ap + ':' + f.id + '">Retake</button></div>';
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
  var saveBtn = ov.querySelector('#ec-rv-save');
  if (saveBtn) saveBtn.addEventListener('click', function () { ecSaveAll(); });
  return EC.token;
}

// Persist: local book fields + shared pool contributions (pool: first writer wins).
async function ecSaveAll() {
  if (!EC) return;
  var lib = (typeof library !== 'undefined' ? library : []);
  var b = lib.find(function (x) { return x && x.id === EC.bookId; });
  var results = EC.results;
  var token = EC.token;
  EC = null;
  ecCloseWizard();
  if (token && typeof overlayClosed === 'function') overlayClosed(token);
  if (!b) return;
  var isbn = (typeof spinePhotoISBN === 'function') ? spinePhotoISBN(b) : null;
  b.editionFaces = b.editionFaces || {};
  var order = ['jacket', 'board', 'slipcase'];
  order.forEach(function (ap) {
    var faces = results[ap];
    if (!faces) return;
    b.editionFaces[ap] = b.editionFaces[ap] || {};
    Object.keys(faces).forEach(function (face) {
      b.editionFaces[ap][face] = faces[face];
      // Shelf compatibility: the jacket spine (else any spine) feeds book.spinePhoto.
      if (face === 'spine' && !b.spinePhoto) b.spinePhoto = faces[face];
    });
  });
  if (typeof saveLibrary === 'function') saveLibrary();
  if (isbn) {
    for (var i = 0; i < order.length; i++) {
      var ap = order[i], fs = results[ap];
      if (!fs) continue;
      var keys = Object.keys(fs);
      for (var j = 0; j < keys.length; j++) {
        await ecShareFace(isbn, ap, keys[j], fs[keys[j]]); // eslint-disable-line no-await-in-loop
      }
    }
  }
  if (typeof toast === 'function') toast('Edition faces saved');
}

// Contribute one face to the shared pool — only when the pool lacks it.
async function ecShareFace(isbn, appearance, face, dataUrl) {
  try {
    if (!isbn || typeof dataUrl !== 'string' || dataUrl.indexOf('data:image') !== 0) return false;
    var sb = await (typeof cloudClient === 'function' ? cloudClient().catch(function () { return null; }) : null);
    if (!sb) return false;
    var seen = await sb.from('edition_images').select('isbn')
      .eq('isbn', isbn).eq('face', face).eq('appearance', appearance).maybeSingle();
    if (seen && seen.data) return true; // already in the pool
    var blob = await (await fetch(dataUrl)).blob();
    var path = (typeof editionImagePath === 'function')
      ? editionImagePath(isbn, face, appearance)
      : (face + '/' + appearance + '/' + isbn + '.jpg');
    var up = await sb.storage.from('edition-images').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (up.error && up.error.statusCode !== '409' && !/exists/i.test(up.error.message || '')) return false;
    await sb.from('edition_images').upsert(
      { isbn: isbn, face: face, appearance: appearance, bucket: 'edition-images', path: path },
      { onConflict: 'isbn,face,appearance', ignoreDuplicates: true });
    return true;
  } catch (e) { return false; }
}
