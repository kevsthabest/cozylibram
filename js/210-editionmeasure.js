'use strict';

/* v287: calibrated thickness capture. The reference is the ISO ID-1 card
   size (85.60 mm wide); the user selects the reference and book edge in the
   captured side-on image. Page count is metadata/validation only, never the
   scale source. */

const ED_MEASURE_REF_MM = 85.60;

function editionMeasureClamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || 0));
}

function editionMeasureDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function editionMeasureAngle(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
}

function editionMeasureOpenEditor(dataUrl, bookId) {
  return new Promise(function (resolve) {
    if (typeof document === 'undefined') { resolve(false); return; }
    var book = (typeof library !== 'undefined' ? library : []).find(function (b) {
      return b && String(b.id) === String(bookId);
    });
    if (!book) { resolve(false); return; }

    var ov = document.createElement('div');
    ov.className = 'ec-backdrop';
    ov.id = 'ed-measure';
    ov.innerHTML =
      '<div class="ec-sheet" role="dialog" aria-label="Measure book thickness">' +
      '<div class="ec-head"><h3 class="serif">Measure thickness</h3>' +
      '<p class="ec-sub">Drag the four points so the blue line spans the card and the green line spans the book thickness.</p></div>' +
      '<div class="ed-measure-stage"><img id="edm-img" alt="Measurement photo">' +
      '<svg id="edm-svg" aria-hidden="true">' +
      '<line id="edm-ref" stroke="#6aa7ff" stroke-width="6" stroke-linecap="round"></line>' +
      '<line id="edm-book" stroke="#6fd08a" stroke-width="6" stroke-linecap="round"></line>' +
      '<circle class="edm-point ref" data-i="0"></circle><circle class="edm-point ref" data-i="1"></circle>' +
      '<circle class="edm-point book" data-i="2"></circle><circle class="edm-point book" data-i="3"></circle>' +
      '</svg></div>' +
      '<p class="ec-hint">Use a standard bank/credit card beside the book, in the same plane and as close to the book as practical. This gives a real mm scale instead of guessing from page count.</p>' +
      '<div class="ec-actions"><button class="btn ghost" id="edm-cancel">Cancel</button><button class="btn primary" id="edm-save">Measure &amp; save</button></div></div>';
    document.body.appendChild(ov);
    var img = ov.querySelector('#edm-img'), svg = ov.querySelector('#edm-svg');
    var refLine = ov.querySelector('#edm-ref'), bookLine = ov.querySelector('#edm-book');
    var pts = [
      {x: 0, y: 0}, {x: 0, y: 0}, {x: 0, y: 0}, {x: 0, y: 0}
    ];
    var active = -1, token = (typeof overlayOpened === 'function')
      ? overlayOpened('ed-measure', function () { ov.remove(); resolve(false); }) : null;

    var draw = function () {
      svg.setAttribute('viewBox', '0 0 ' + (img.naturalWidth || 1) + ' ' + (img.naturalHeight || 1));
      refLine.setAttribute('x1', pts[0].x); refLine.setAttribute('y1', pts[0].y);
      refLine.setAttribute('x2', pts[1].x); refLine.setAttribute('y2', pts[1].y);
      bookLine.setAttribute('x1', pts[2].x); bookLine.setAttribute('y1', pts[2].y);
      bookLine.setAttribute('x2', pts[3].x); bookLine.setAttribute('y2', pts[3].y);
      svg.querySelectorAll('.edm-point').forEach(function (n) {
        var i = +n.getAttribute('data-i');
        n.setAttribute('cx', pts[i].x); n.setAttribute('cy', pts[i].y);
      });
    };

    var pointer = function (e) {
      var r = img.getBoundingClientRect();
      var sx = (img.naturalWidth || 1) / Math.max(1, r.width);
      var sy = (img.naturalHeight || 1) / Math.max(1, r.height);
      return {
        x: Math.max(0, Math.min(img.naturalWidth, (e.clientX - r.left) * sx)),
        y: Math.max(0, Math.min(img.naturalHeight, (e.clientY - r.top) * sy))
      };
    };
    svg.addEventListener('pointerdown', function (e) {
      var n = e.target.closest('.edm-point');
      if (!n) return;
      active = +n.getAttribute('data-i');
      try { n.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    svg.addEventListener('pointermove', function (e) {
      if (active < 0) return;
      pts[active] = pointer(e); draw(); e.preventDefault();
    });
    svg.addEventListener('pointerup', function () { active = -1; });
    svg.addEventListener('pointercancel', function () { active = -1; });

    ov.querySelector('#edm-cancel').addEventListener('click', function () {
      ov.remove(); resolve(false);
    });
    ov.querySelector('#edm-save').addEventListener('click', async function () {
      var refPx = editionMeasureDistance(pts[0], pts[1]);
      var bookPx = editionMeasureDistance(pts[2], pts[3]);
      if (refPx < 20 || bookPx < 2) {
        if (typeof toast === 'function') toast('Make both measurement lines longer and try again');
        return;
      }
      var a1 = editionMeasureAngle(pts[0], pts[1]);
      var a2 = editionMeasureAngle(pts[2], pts[3]);
      var angleDelta = Math.abs((((a1 - a2) + 180) % 360) - 180);
      var confidence = editionMeasureClamp(100 - angleDelta * 3 - (bookPx < 6 ? 25 : 0), 0, 100);
      var thickness = ED_MEASURE_REF_MM * bookPx / refPx;
      if (!isFinite(thickness) || thickness <= 0 || thickness >= 100) {
        if (typeof toast === 'function') toast('That measurement looks invalid — check the selected points');
        return;
      }

      var saved = false;
      try {
        var sb = await (typeof cloudClient === 'function' ? cloudClient().catch(function () { return null; }) : null);
        if (sb) {
          var er = await sb.from('editions').select('id').eq('isbn', spinePhotoISBN(book)).maybeSingle();
          if (er && er.data) {
            var uidr = await sb.auth.getUser();
            var uid = uidr && uidr.data && uidr.data.user && uidr.data.user.id;
            if (uid) {
              var ins = await sb.from('edition_measurements').insert({
                edition_id: er.data.id, isbn: spinePhotoISBN(book), measured_by: uid,
                thickness_mm: thickness, reference_width_mm: ED_MEASURE_REF_MM,
                reference_pixels: refPx, thickness_pixels: bookPx,
                confidence: confidence, method: 'id1-card'
              });
              saved = !(ins && ins.error);
            }
          }
        }
      } catch (e) {}
      /* Offline/local fallback keeps the user's measurement useful without
         pretending it is community-canonical until it reaches Supabase. */
      book.thicknessMm = Math.round(thickness * 100) / 100;
      book.thicknessSource = 'id1-card';
      book.thicknessConfidence = Math.round(confidence * 10) / 10;
      if (typeof saveLibrary === 'function') saveLibrary();
      if (typeof toast === 'function') toast(saved
        ? 'Thickness measured: ' + book.thicknessMm.toFixed(2) + ' mm'
        : 'Thickness saved locally: ' + book.thicknessMm.toFixed(2) + ' mm');
      ov.remove(); resolve(true);
    });

    img.onload = function () {
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      /* Reasonable starting guesses; the user always adjusts all four points. */
      pts[0] = {x: w * .12, y: h * .35};
      pts[1] = {x: w * .52, y: h * .35};
      pts[2] = {x: w * .15, y: h * .68};
      pts[3] = {x: w * .25, y: h * .68};
      draw();
    };
    img.onerror = function () { ov.remove(); resolve(false); };
    img.src = dataUrl;
  });
}

function editionMeasureThickness(bookId) {
  if (typeof document === 'undefined') return null;
  var input = document.getElementById('edm-input');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file'; input.id = 'edm-input'; input.accept = 'image/*';
    input.capture = 'environment'; input.hidden = true;
    document.body.appendChild(input);
  }
  input.onchange = function () {
    var f = input.files && input.files[0]; input.value = '';
    if (!f) return;
    var fr = new FileReader();
    fr.onload = function () { editionMeasureOpenEditor(String(fr.result || ''), bookId); };
    fr.onerror = function () { if (typeof toast === 'function') toast('Could not read that photo'); };
    fr.readAsDataURL(f);
  };
  input.click();
}
