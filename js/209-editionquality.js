'use strict';

/* v286: lightweight image-quality analysis for edition repository candidates.
   No ML dependency: the capture is already perspective-corrected, so a small
   canvas pass is enough to score the evidence consistently. */

function editionClampScore(n) {
  n = Number(n);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function editionQualityScore(m) {
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

function editionAnalyzeDataUrl(dataUrl) {
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
