'use strict';

/* ---------------- YOLO book segmentation (v301+) ----------------
   On-device book detection via yolo11n-seg (ONNX, onnxruntime-web).
   Used as the second stage of the orbit burst crop: the edge-based
   tighten (ecTightenQuad) runs first for precision; YOLO refines when
   they disagree (damaged/warped books where straight edges fail).

   The model is loaded lazily (only when orbit capture runs) and the
   12MB .onnx is precached by the service worker for offline use.
   Detection is class-agnostic: we pick by guide-overlap geometry, not
   the COCO label (a spine is often called 'tie' or 'skateboard'). */

var EC_YOLO_IMG = 640;
var EC_YOLO_CONF = 0.15;
var EC_YOLO_NMS_IOU = 0.5;
var EC_YOLO_MASK_THRESH = 0.65;

var ecYoloSession = null;
var ecYoloLoading = null;
var EC_YOLO_OPT_KEY = 'cozylibram.yolo-enabled';

/* User toggle (Settings > About). Defaults on. */
function ecYoloEnabled() {
  try { return localStorage.getItem(EC_YOLO_OPT_KEY) !== '0'; } catch (e) { return true; }
}
function ecSetYoloEnabled(on) {
  try { localStorage.setItem(EC_YOLO_OPT_KEY, on ? '1' : '0'); } catch (e) {}
}

/* Dynamically load the vendored ort.min.js (lazy, not on app start). */
function ecYoloLoadOrt() {
  if (typeof ort !== 'undefined') return Promise.resolve(true);
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise(function (resolve) {
    var el = document.createElement('script');
    el.src = 'vendor/ort/ort.min.js';
    el.onload = function () { resolve(true); };
    el.onerror = function () { resolve(false); };
    document.head.appendChild(el);
  });
}

/* Lazy-load the model. Returns a promise of the session (or null). */
function ecYoloLoad() {
  if (ecYoloSession) return Promise.resolve(ecYoloSession);
  if (ecYoloLoading) return ecYoloLoading;
  ecYoloLoading = (async function () {
    var ok = await ecYoloLoadOrt();
    if (!ok || typeof ort === 'undefined') return null;
    try {
      // Point ort at the vendored WASM.
      if (ort.env && ort.env.wasm) {
        ort.env.wasm.wasmPaths = 'vendor/ort/';
      }
      var s = await ort.InferenceSession.create('yolo11n-seg.onnx', { executionProviders: ['wasm'] });
      ecYoloSession = s;
      return s;
    } catch (e) {
      return null;
    }
  })();
  return ecYoloLoading;
}

function ecYoloSigmoid(x) { return 1 / (1 + Math.exp(-x)); }

/* Pure: NMS over boxes. Returns indices to keep. */
function ecYoloNms(boxes, scores) {
  var idx = boxes.map(function (_, i) { return i; }).sort(function (a, b) { return scores[b] - scores[a]; });
  var keep = [], sup = new Array(boxes.length).fill(false), i, j;
  for (var ii = 0; ii < idx.length; ii++) {
    i = idx[ii];
    if (sup[i]) continue;
    keep.push(i);
    for (var jj = 0; jj < idx.length; jj++) {
      j = idx[jj];
      if (j === i || sup[j]) continue;
      var a = boxes[i], b = boxes[j];
      var ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
      var iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      var inter = ix * iy;
      var union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
      if (union > 0 && inter / union > EC_YOLO_NMS_IOU) sup[j] = true;
    }
  }
  return keep;
}

/* Pure: decode raw YOLO-seg outputs into detections.
   det: Float32Array(116*8400), protos: Float32Array(32*160*160).
   Returns [{ box:[x0,y0,x1,y1], conf, cls, maskBox:[x0,y0,x1,y1]|null }]
   in the 640x640 model coords. */
function ecYoloDecode(det, protos, w, h) {
  var N = 8400, NM = 32, i, c;
  var boxes = [], scores = [], coeffs = [], classes = [];
  for (i = 0; i < N; i++) {
    var best = 0, cls = -1;
    for (c = 0; c < 80; c++) {
      var s = det[(4 + c) * N + i];
      if (s > best) { best = s; cls = c; }
    }
    if (best < EC_YOLO_CONF) continue;
    var cx = det[i], cy = det[N + i], bw = det[2 * N + i], bh = det[3 * N + i];
    boxes.push([(cx - bw / 2) / EC_YOLO_IMG * w, (cy - bh / 2) / EC_YOLO_IMG * h,
                (cx + bw / 2) / EC_YOLO_IMG * w, (cy + bh / 2) / EC_YOLO_IMG * h]);
    scores.push(best); classes.push(cls);
    var cf = new Float32Array(NM);
    for (var m = 0; m < NM; m++) cf[m] = det[(84 + m) * N + i];
    coeffs.push(cf);
  }
  var keep = ecYoloNms(boxes, scores);
  var out = [];
  for (var ki = 0; ki < keep.length; ki++) {
    var k = keep[ki], cfk = coeffs[k], box = boxes[k];
    var mw = 160, mh = 160;
    var mx0 = w, my0 = h, mx1 = 0, my1 = 0, cnt = 0;
    var bx0 = box[0] / w * mw, by0 = box[1] / h * mh, bx1 = box[2] / w * mw, by1 = box[3] / h * mh;
    for (var y = 0; y < mh; y++) for (var x = 0; x < mw; x++) {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
      var ps = 0;
      for (var m2 = 0; m2 < NM; m2++) ps += cfk[m2] * protos[m2 * mw * mh + y * mw + x];
      if (ecYoloSigmoid(ps) > EC_YOLO_MASK_THRESH) {
        cnt++;
        var ox = x / mw * w, oy = y / mh * h;
        if (ox < mx0) mx0 = ox; if (ox > mx1) mx1 = ox;
        if (oy < my0) my0 = oy; if (oy > my1) my1 = oy;
      }
    }
    out.push({
      box: box, conf: scores[k], cls: classes[k],
      maskBox: cnt ? [mx0, my0, mx1, my1] : null,
    });
  }
  return out;
}

/* Pure: pick the detection overlapping the guide ROI best (class ignored).
   Detections and roi are in the same coords. Returns the detection or null. */
function ecYoloBestForGuide(detections, roi) {
  var best = null, bestIoU = 0.15; // minimum overlap to consider
  for (var i = 0; i < detections.length; i++) {
    var b = detections[i].maskBox || detections[i].box;
    var ix = Math.max(0, Math.min(b[2], roi.x + roi.w) - Math.max(b[0], roi.x));
    var iy = Math.max(0, Math.min(b[3], roi.y + roi.h) - Math.max(b[1], roi.y));
    var inter = ix * iy;
    var union = (b[2] - b[0]) * (b[3] - b[1]) + roi.w * roi.h - inter;
    var iou = union > 0 ? inter / union : 0;
    if (iou > bestIoU) { bestIoU = iou; best = detections[i]; }
  }
  return best;
}

/* Pure: IoU between two quads' bounding boxes (for the ensemble vote). */
function ecQuadIoU(q1, q2) {
  function bb(q) {
    var xs = q.map(function (p) { return p[0]; }), ys = q.map(function (p) { return p[1]; });
    return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
  }
  var a = bb(q1), b = bb(q2);
  var ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  var iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  var inter = ix * iy;
  var union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/* Run YOLO on a canvas. Returns detections in the canvas's coords (or []). */
async function ecYoloDetect(canvas) {
  if (!ecYoloEnabled()) return [];
  var session = await ecYoloLoad();
  if (!session || typeof document === 'undefined') return [];
  var w = canvas.width, h = canvas.height;
  var side = Math.min(w, h);
  var sx = (w - side) / 2, sy = (h - side) / 2;
  var c = document.createElement('canvas'); c.width = c.height = EC_YOLO_IMG;
  var cx = c.getContext('2d');
  cx.drawImage(canvas, sx, sy, side, side, 0, 0, EC_YOLO_IMG, EC_YOLO_IMG);
  var d = cx.getImageData(0, 0, EC_YOLO_IMG, EC_YOLO_IMG).data;
  var chw = new Float32Array(3 * EC_YOLO_IMG * EC_YOLO_IMG);
  for (var i = 0; i < EC_YOLO_IMG * EC_YOLO_IMG; i++) {
    chw[i] = d[i * 4] / 255;
    chw[EC_YOLO_IMG * EC_YOLO_IMG + i] = d[i * 4 + 1] / 255;
    chw[2 * EC_YOLO_IMG * EC_YOLO_IMG + i] = d[i * 4 + 2] / 255;
  }
  var tensor = new ort.Tensor('float32', chw, [1, 3, EC_YOLO_IMG, EC_YOLO_IMG]);
  var out = await session.run({ [session.inputNames[0]]: tensor });
  var det = out[session.outputNames[0]].data;
  var protos = out[session.outputNames[1]].data;
  // Map from square-crop coords back to canvas coords.
  var dets = ecYoloDecode(det, protos, side, side);
  return dets.map(function (dt) {
    function mp(b) { return [b[0] + sx, b[1] + sy, b[2] + sx, b[3] + sy]; }
    return { box: mp(dt.box), conf: dt.conf, cls: dt.cls, maskBox: dt.maskBox ? mp(dt.maskBox) : null };
  });
}

/* Two-stage ensemble: combine the edge-based tighten quad with the YOLO quad.
   Both quads must be in the same coords. Returns the winner, or null.
   Agree (IoU > 0.7): edge is more precise, keep it. Disagree: trust YOLO. */
function ecEnsembleQuad(edgeQuad, yoloQuad) {
  if (edgeQuad && yoloQuad) {
    return ecQuadIoU(edgeQuad, yoloQuad) > 0.7 ? edgeQuad : yoloQuad;
  }
  return edgeQuad || yoloQuad || null;
}

/* Build an axis-aligned quad from a YOLO detection's box. */
function ecYoloQuad(det) {
  if (!det) return null;
  var b = det.maskBox || det.box;
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
}
