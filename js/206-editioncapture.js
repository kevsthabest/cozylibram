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
   source corners -> rectangle, inverse-mapped with bilinear sampling. */

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
function ecOpenEditor(dataUrl, faceLabel, subLabel, onUse, onRetake) {
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
      '<svg id="ec-ed-svg" aria-hidden="true"><polygon id="ec-ed-poly" points=""/><g id="ec-ed-handles"></g></svg>' +
    '</div>' +
    '<div class="ec-prevrow"><canvas id="ec-ed-prev"></canvas><span>Live preview — drag a corner to straighten</span></div>' +
    '<div class="ec-actions">' +
      '<button class="btn ghost" id="ec-ed-retake">Retake</button>' +
      '<button class="btn primary" id="ec-ed-use">Use this photo</button>' +
    '</div></div>';
  document.body.appendChild(ov);

  var img = ov.querySelector('#ec-ed-img');
  var svg = ov.querySelector('#ec-ed-svg');
  var poly = ov.querySelector('#ec-ed-poly');
  var handlesG = ov.querySelector('#ec-ed-handles');
  var prev = ov.querySelector('#ec-ed-prev');
  var W = 0, H = 0, quad = null, srcCanvas = null, prevQueued = false, tornDown = false;

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
    // handles stay ~30 CSS px regardless of photo resolution
    var hr = 30 * (W / r.width);
    var sw = 4 * (W / r.width);
    poly.setAttribute('stroke-width', sw);
    var circles = handlesG.querySelectorAll('circle');
    if (circles.length !== 4) {
      handlesG.innerHTML = '';
      quad.forEach(function (p, i) {
        var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('r', hr);
        c.setAttribute('class', 'ec-handle');
        c.setAttribute('data-i', i);
        handlesG.appendChild(c);
      });
      circles = handlesG.querySelectorAll('circle');
    } else {
      circles.forEach(function (c) { c.setAttribute('r', hr); });
    }
    drawQuad();
  };

  // Position-only update — safe to call mid-drag (never rebuilds nodes,
  // so the captured handle survives).
  var drawQuad = function () {
    if (!quad || tornDown) return;
    poly.setAttribute('points', quad.map(function (p) { return p[0] + ',' + p[1]; }).join(' '));
    var circles = handlesG.querySelectorAll('circle');
    quad.forEach(function (p, i) {
      if (circles[i]) { circles[i].setAttribute('cx', p[0]); circles[i].setAttribute('cy', p[1]); }
    });
  };

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

  var dragI = -1;
  handlesG.addEventListener('pointerdown', function (e) {
    var t = e.target.closest('circle');
    if (!t) return;
    dragI = +t.getAttribute('data-i');
    try { t.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  handlesG.addEventListener('pointermove', function (e) {
    if (dragI < 0) return;
    quad[dragI] = toImage(e.clientX, e.clientY);
    drawQuad();
    queuePreview();
  });
  var endDrag = function () { dragI = -1; };
  handlesG.addEventListener('pointerup', endDrag);
  handlesG.addEventListener('pointercancel', endDrag);

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
    var ix = W * 0.06, iy = H * 0.06;
    quad = [[ix, iy], [W - ix, iy], [W - ix, H - iy], [ix, H - iy]];
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
function ecCaptureFace(face, subLabel, stepLabel, cb) {
  if (typeof document === 'undefined') return null;
  var ov = document.createElement('div');
  ov.className = 'ec-backdrop';
  ov.id = 'ec-capture';
  ov.innerHTML =
    '<div class="ec-sheet" role="dialog" aria-label="Photograph the ' + esc(face.label) + '">' +
    '<div class="ec-head"><h3 class="serif">' + esc(face.label) + '</h3>' +
    '<p class="ec-sub">' + esc(subLabel) + (stepLabel ? ' · ' + esc(stepLabel) : '') + '</p></div>' +
    '<div class="ec-vf"><video id="ec-video" playsinline muted autoplay></video>' +
      '<div class="ec-guide ec-guide-' + face.guide + '" aria-hidden="true"></div></div>' +
    '<p class="ec-hint">' + esc(face.hint) + '</p>' +
    '<input type="file" id="ec-file" accept="image/*" hidden>' +
    '<div class="ec-actions">' +
      '<button class="btn ghost" id="ec-cap-back">Back</button>' +
      '<button class="btn ghost" id="ec-cap-lib">Choose photo</button>' +
      '<button class="btn primary" id="ec-cap-snap">Capture</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  var video = ov.querySelector('#ec-video');
  var stream = null, tornDown = false;

  var domTeardown = function () {
    if (tornDown) return; tornDown = true;
    if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; }
    var n = document.getElementById('ec-capture');
    if (n) n.remove();
  };
  var token = (typeof overlayOpened === 'function')
    ? overlayOpened('ec-capture', function () { domTeardown(); ecBackToStep(); })
    : null;

  var snap = function () {
    try {
      if (!video.videoWidth) return null;
      var c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      return c.toDataURL('image/jpeg', 0.92);
    } catch (e) { return null; }
  };
  // Hand the photo to the editor, adopting this overlay's history entry.
  var gotPhoto = function (url) {
    domTeardown();
    ecHandoff(function () { return cb(url); });
  };

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) {
        if (tornDown) { try { s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} return; }
        stream = s;
        video.srcObject = s;
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      })
      .catch(function () { if (typeof toast === 'function') toast('Camera unavailable — choose a photo instead'); });
  }

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
      gotPhoto(url.indexOf('data:image') === 0 ? url : null);
    };
    fr.onerror = function () { if (typeof toast === 'function') toast('Could not read that photo'); };
    fr.readAsDataURL(f);
  });
  ov.querySelector('#ec-cap-snap').addEventListener('click', function () {
    var url = snap();
    if (url) gotPhoto(url);
    else if (typeof toast === 'function') toast('Capture failed — try again');
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
function ecBuildSteps(appearances) {
  var steps = [];
  (appearances || []).forEach(function (ap) {
    EC_FACES.forEach(function (f) {
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

function ecRenderAppearance() {
  if (typeof document === 'undefined' || !EC) return null;
  var lib = (typeof library !== 'undefined' ? library : []);
  var b = lib.find(function (x) { return x && x.id === EC.bookId; });
  var ov = ecWizardShell(
    '<div class="ec-head"><h3 class="serif">Scan edition</h3>' +
    '<p class="ec-sub">' + esc((b && b.title) || 'This book') + '</p></div>' +
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
    EC.steps = ecBuildSteps(aps);
    EC.idx = 0;
    ecRenderStep();
  };
  ov.querySelector('#ec-ap-jacket').addEventListener('click', function () { go(['jacket']); });
  ov.querySelector('#ec-ap-both').addEventListener('click', function () { go(['jacket', 'board']); });
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
      return ecCaptureFace(face, apLabel, stepLabel, function (url) {
        if (!url) { ecRenderStep(); return EC ? EC.token : null; }
        return ecOpenEditor(url, face.label, apLabel, function (warped) {
          (EC.results[st.appearance] = EC.results[st.appearance] || {})[st.face] = warped;
          EC.idx++;
          ecRenderStep();
          return EC ? EC.token : null;
        }, function () { ecRenderStep(); return EC ? EC.token : null; });
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
