'use strict';

/* js/209-editionquality.js — Edition image quality: lightweight,
 * dependency-free scoring of edition-capture photos, so repository
 * candidates can be compared on evidence instead of eyeballing.
 *
 * No ML: the capture is already perspective-corrected by the time a
 * photo gets here, so a small canvas pass is enough.
 * editionAnalyzeDataUrl(dataUrl) downscales the image to at most
 * 360px on its long side and derives sharpness (Laplacian variance),
 * exposure and glare (dark/bright clipping fractions) and resolution;
 * perspective, coverage and stability are reported as the constant
 * 100 — this pass does not measure them, and the weighted blend in
 * editionQualityScore (weights sum to 1) counts them at full marks.
 * The promise never rejects: a non-image input, a decode failure or
 * any error resolves null, so a bad photo simply has no score.
 *
 * The two scorers are used inside this file; the surface other files
 * reach is editionAnalyzeDataUrl, read as a global through the window
 * bridge by js/206-editioncapture.js and js/208-editionassets.js.
 * This file reads nothing from any other module.
 */
export function editionClampScore(n) {
  n = Number(n);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function editionQualityScore(m) {
  m = m || {};
  return Math.round((
    editionClampScore(m.sharpness) * 0.25 +
    editionClampScore(m.exposure) * 0.10 +
    editionClampScore(m.perspective) * 0.15 +
    editionClampScore(m.coverage) * 0.15 +
    editionClampScore(m.glare) * 0.10 +
    editionClampScore(m.resolution) * 0.15 +
    editionClampScore(m.stability) * 0.10
  ) * 100) / 100;
}

export function editionAnalyzeDataUrl(dataUrl) {
  return new Promise(function (resolve) {
    if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0 ||
        typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(null); return;
    }
    var img = new Image();
    img.onload = function () {
      try {
        var width = img.naturalWidth || img.width || 0;
        var height = img.naturalHeight || img.height || 0;
        if (!width || !height) { resolve(null); return; }
        var scale = Math.min(1, 360 / Math.max(width, height));
        var w = Math.max(1, Math.round(width * scale));
        var h = Math.max(1, Math.round(height * scale));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        var px = ctx.getImageData(0, 0, w, h).data;
        var gray = new Float32Array(w * h);
        var dark = 0, bright = 0;
        for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
          var g = (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114);
          gray[i] = g;
          if (g < 10) dark++;
          if (g > 245) bright++;
        }

        var mean = 0;
        for (var j = 0; j < gray.length; j++) mean += gray[j];
        mean /= gray.length;

        var variance = 0;
        for (var k = 0; k < gray.length; k++) {
          var d = gray[k] - mean;
          variance += d * d;
        }
        variance /= gray.length;

        var lapMean = 0, lapCount = 0, lapVals = [];
        for (var y = 1; y < h - 1; y++) {
          for (var x = 1; x < w - 1; x++) {
            var q = y * w + x;
            var lap = gray[q - w] + gray[q - 1] + gray[q + 1] + gray[q + w] - 4 * gray[q];
            lapVals.push(lap);
            lapMean += lap;
            lapCount++;
          }
        }
        lapMean = lapCount ? lapMean / lapCount : 0;
        var lapVar = 0;
        for (var z = 0; z < lapVals.length; z++) {
          var ld = lapVals[z] - lapMean;
          lapVar += ld * ld;
        }
        lapVar = lapCount ? lapVar / lapCount : 0;

        var clipping = (dark + bright) / Math.max(1, gray.length);
        var exposure = editionClampScore(100 - clipping * 500);
        /* Bright clipped area is the useful proxy for glare in a normalized
           still; a future polarizer/capture pipeline can replace this signal. */
        var glare = editionClampScore(100 - (bright / Math.max(1, gray.length)) * 700);
        var sharpness = editionClampScore(100 * (1 - Math.exp(-lapVar / 180)));
        var resolution = editionClampScore(
          20 + 80 * Math.min(1, Math.max(width, height) / 1400)
        );

        var metrics = {
          width: width, height: height,
          sharpness: sharpness,
          exposure: exposure,
          perspective: 100,
          coverage: 100,
          glare: glare,
          resolution: resolution,
          stability: 100
        };
        metrics.quality = editionQualityScore(metrics);
        resolve(metrics);
      } catch (e) { resolve(null); }
    };
    img.onerror = function () { resolve(null); };
    img.src = dataUrl;
  });
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Its consumers — js/206-editioncapture.js and
   js/208-editionassets.js — still read editionAnalyzeDataUrl as a
   global at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups resolve
   through the global object, so the callers need no changes. Module
   scripts are deferred, so the bridge is in place before any consumer
   can run. Remove a name from this bridge only when its last
   window-reading caller has wired the read as an import (ADR-003). */
window.editionClampScore = editionClampScore;
window.editionQualityScore = editionQualityScore;
window.editionAnalyzeDataUrl = editionAnalyzeDataUrl;
