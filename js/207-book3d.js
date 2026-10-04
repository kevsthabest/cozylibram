/* 207-book3d.js — 3D edition viewer (v279).
   "Share and show off the books you own": a rotatable 3D book built from
   the scanned edition faces (js/206), with graceful fallbacks so EVERY book
   renders — scanned faces upgrade it, generated art fills the gaps.

   Three.js (r159 UMD, vendored at js/vendor/three.min.js) is LAZY-loaded on
   first viewer open so the 668 KB never touches initial page load; it IS in
   the service-worker precache list so the viewer works offline once seen.
   (Deliberate exception to the index.html touchpoint convention.)

   Geometry: front/back/spine are planes wearing the scanned faces; the page
   block is an inset box (fore-edge + top/bottom page textures). Real face
   proportions come from the scanned images themselves (front and spine
   share a physical height, so their aspect ratios give cover width and
   thickness with no guessing). */

'use strict';

// ---------- pure helpers (tested) ----------

// Physical proportions from real scanned face sizes (both share the book's
// height, so aspect ratios are enough). H is fixed at 2 units.
function b3dDims(frontSize, spineSize, physical) {
  var H = 2, coverW = 1.3, thick = 0.26;
  if (frontSize && frontSize.h > 0) {
    var fa = frontSize.w / frontSize.h;
    coverW = Math.min(1.7, Math.max(0.9, H * fa));
  }
  if (spineSize && spineSize.h > 0) {
    var sa = spineSize.w / spineSize.h;
    thick = Math.min(0.75, Math.max(0.1, H * sa));
  }
  /* A calibrated physical measurement is preferred when it exists. The
     height is still normalized to H=2, so an absolute mm value only changes
     thickness when a physical book height is also known. */
  if (physical && Number(physical.thicknessMm) > 0 && Number(physical.heightMm) > 0) {
    thick = Math.min(0.75, Math.max(0.1,
      H * Number(physical.thicknessMm) / Number(physical.heightMm)));
  }
  return { H: H, coverW: coverW, thick: thick };
}

// Default appearance: jacket wins, then boards.
function b3dPickAppearance(byAp) {
  var has = function (ap) {
    return byAp && byAp[ap] && Object.keys(byAp[ap]).length > 0;
  };
  if (has('jacket')) return 'jacket';
  if (has('board')) return 'board';
  return null;
}

// Merge face slots: local scan wins, then the shared pool (same
// appearance, then the other one). Pure; pool rows are pre-shaped.
function b3dMergeFaces(localAp, poolAp, poolOther) {
  var out = {};
  ['front', 'back', 'spine', 'fore_edge'].forEach(function (f) {
    out[f] = (localAp && localAp[f]) ||
             (poolAp && poolAp[f]) ||
             (poolOther && poolOther[f]) || null;
  });
  return out;
}

// ---------- three.js lazy load ----------

var b3dThreePromise = null;
function b3dEnsureThree() {
  if (typeof window !== 'undefined' && window.THREE) return Promise.resolve(window.THREE);
  if (b3dThreePromise) return b3dThreePromise;
  b3dThreePromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = 'js/vendor/three.min.js';
    s.onload = function () {
      if (window.THREE) resolve(window.THREE);
      else { b3dThreePromise = null; reject(new Error('three failed to define THREE')); }
    };
    s.onerror = function () { b3dThreePromise = null; reject(new Error('three failed to load')); };
    document.head.appendChild(s);
  });
  return b3dThreePromise;
}

// ---------- image helpers ----------

function b3dImageSize(url) {
  return new Promise(function (resolve) {
    try {
      var img = new Image();
      if (url.indexOf('data:') !== 0) img.crossOrigin = 'anonymous';
      img.onload = function () {
        resolve({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    } catch (e) { resolve(null); }
  });
}

function b3dLoadTexture(THREE, url) {
  return new Promise(function (resolve) {
    try {
      var img = new Image();
      if (url.indexOf('data:') !== 0) img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var tex = new THREE.CanvasTexture(img);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          resolve(tex);
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    } catch (e) { resolve(null); }
  });
}

function b3dCanvasTexture(THREE, canvas) {
  var tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------- procedural fallbacks ----------

function b3dPalette(book) {
  try {
    if (typeof shelfSpineSpec === 'function') {
      var spec = shelfSpineSpec(book);
      return [spec.c1 || '#5b4a68', spec.c2 || '#3d3247'];
    }
  } catch (e) {}
  return ['#5b4a68', '#3d3247'];
}

function b3dFitFont(ctx, text, maxW, base) {
  var size = base;
  ctx.font = '600 ' + size + 'px Georgia, serif';
  while (size > 10 && ctx.measureText(text).width > maxW) {
    size -= 2;
    ctx.font = '600 ' + size + 'px Georgia, serif';
  }
  return size;
}

// Spine fallback: deterministic palette + vertical title, like the shelf.
function b3dSpineCanvas(book) {
  var pal = b3dPalette(book);
  var c = document.createElement('canvas');
  c.width = 200; c.height = 1200;
  var x = c.getContext('2d');
  var g = x.createLinearGradient(0, 0, c.width, 0);
  g.addColorStop(0, pal[1]); g.addColorStop(0.5, pal[0]); g.addColorStop(1, pal[1]);
  x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = 'rgba(255,255,255,0.75)';
  x.fillRect(14, 40, c.width - 28, 3);
  x.fillRect(14, c.height - 43, c.width - 28, 3);
  var title = String((book && book.title) || 'Untitled');
  if (title.length > 30) title = title.slice(0, 29) + '…';
  x.save();
  x.translate(c.width / 2, c.height / 2);
  x.rotate(Math.PI / 2);
  x.fillStyle = 'rgba(255,255,255,0.92)';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  b3dFitFont(x, title, c.height - 220, 54);
  x.fillText(title, 0, 0);
  x.restore();
  return c;
}

// Cover fallback: palette gradient + centered title/author.
function b3dCoverCanvas(book, face) {
  var pal = b3dPalette(book);
  var c = document.createElement('canvas');
  c.width = 660; c.height = 1000;
  var x = c.getContext('2d');
  var g = x.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, pal[0]); g.addColorStop(1, pal[1]);
  x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
  x.strokeStyle = 'rgba(255,255,255,0.35)';
  x.lineWidth = 3;
  x.strokeRect(28, 28, c.width - 56, c.height - 56);
  x.fillStyle = 'rgba(255,255,255,0.94)';
  x.textAlign = 'center';
  var title = String((book && book.title) || 'Untitled');
  b3dFitFont(x, title, c.width - 140, 64);
  x.textBaseline = 'middle';
  // naive wrap on words
  var words = title.split(' '), lines = [], line = '';
  words.forEach(function (w0) {
    var t = line ? line + ' ' + w0 : w0;
    if (x.measureText(t).width > c.width - 140 && line) { lines.push(line); line = w0; }
    else line = t;
  });
  if (line) lines.push(line);
  lines = lines.slice(0, 4);
  var y = face === 'back' ? c.height * 0.3 : c.height * 0.38;
  lines.forEach(function (ln, i) { x.fillText(ln, c.width / 2, y + i * 76); });
  var authors = (book && book.authors && book.authors.length)
    ? book.authors.map(function (a) {
        return (typeof displayAuthorName === 'function') ? displayAuthorName(a) : a;
      }).join(', ')
    : '';
  if (authors) {
    x.font = '400 34px Georgia, serif';
    x.fillStyle = 'rgba(255,255,255,0.75)';
    if (authors.length > 42) authors = authors.slice(0, 41) + '…';
    x.fillText(authors, c.width / 2, y + lines.length * 76 + 40);
  }
  return c;
}

// Page-block texture: warm paper with fine page lines.
function b3dPageCanvas() {
  var c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  var x = c.getContext('2d');
  x.fillStyle = '#f1e9d6'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = 'rgba(120,100,70,0.16)';
  for (var y = 0; y < c.height; y += 3) x.fillRect(0, y, c.width, 1);
  return c;
}

// ---------- shared-pool faces (best effort) ----------

async function b3dPoolFaces(isbn) {
  var out = {};
  try {
    if (!isbn || typeof cloudClient !== 'function') return out;
    var sb = await cloudClient().catch(function () { return null; });
    if (!sb) return out;
    var canonical = await sb.from('edition_asset_slots')
      .select('face,appearance,canonical_asset:edition_assets(bucket,path)')
      .eq('isbn', isbn);
    (canonical.data || []).forEach(function (r) {
      var a = r.canonical_asset;
      if (!a || !a.path || !r.face) return;
      var url = null;
      try { url = sb.storage.from(a.bucket || 'edition-images').getPublicUrl(a.path).data.publicUrl; }
      catch (e) { return; }
      if (!url) return;
      var ap = r.appearance || 'jacket';
      out[ap] = out[ap] || {};
      out[ap][r.face] = url;
    });
    var legacy = await sb.from('edition_images').select('face,appearance,bucket,path').eq('isbn', isbn);
    (legacy.data || []).forEach(function (r) {
      if (!r.path || !r.face) return;
      var url = null;
      try { url = sb.storage.from(r.bucket || 'edition-images').getPublicUrl(r.path).data.publicUrl; }
      catch (e) { return; }
      if (!url) return;
      var ap = r.appearance || 'jacket';
      out[ap] = out[ap] || {};
      if (!out[ap][r.face]) out[ap][r.face] = url;
    });
  } catch (e) {}
  return out;
}

async function b3dLocalFaces(book, revokeList) {
  var refs = (book && book.editionFaceRefs) || {};
  var legacy = (book && book.editionFaces) || {};
  var out = {};
  var aps = ['jacket', 'board', 'slipcase'];
  for (var ai = 0; ai < aps.length; ai++) {
    var ap = aps[ai];
    var faces = refs[ap] || {};
    var legacyFaces = legacy[ap] || {};
    var keys = Object.keys(faces);
    if (!keys.length) keys = Object.keys(legacyFaces);
    if (!keys.length) continue;
    out[ap] = {};
    for (var i = 0; i < keys.length; i++) {
      var face = keys[i], url = null;
      if (faces[face] && typeof currentDb !== 'undefined' && currentDb && typeof idbAssetGet === 'function') {
        try {
          var asset = await idbAssetGet(currentDb, faces[face]);
          if (asset && asset.blob) {
            url = URL.createObjectURL(asset.blob);
            if (revokeList) revokeList.push(url);
          }
        } catch (e) {}
      }
      if (!url && legacyFaces[face]) url = legacyFaces[face];
      if (url) out[ap][face] = url;
    }
  }
  return out;
}

// Resolve the faces to render: local scans win, pool fills gaps, procedural
// art covers the rest. Returns { appearance, tex: {face: url|null(real scan?)},
// real: {face: bool}, dims }.
async function b3dResolveFaces(book, revokeList, poolOverride) {
  var local = await b3dLocalFaces(book, revokeList);
  var isbn = (typeof spinePhotoISBN === 'function') ? spinePhotoISBN(book) : null;
  var pool = poolOverride || await b3dPoolFaces(isbn);
  var pick = b3dPickAppearance(local) || b3dPickAppearance(pool) || 'jacket';
  var other = pick === 'jacket' ? 'board' : 'jacket';
  var merged = b3dMergeFaces(local[pick], pool[pick], pool[other]);
  var real = {};
  ['front', 'back', 'spine', 'fore_edge'].forEach(function (f) {
    real[f] = !!(merged[f] && local[pick] && local[pick][f]);
  });
  var frontSize = merged.front ? await b3dImageSize(merged.front) : null;
  var spineSize = merged.spine && real.spine ? await b3dImageSize(merged.spine) : null;
  var physical = { thicknessMm: Number(book && book.thicknessMm) || 0,
    heightMm: Number(book && book.heightMm) || 0 };
  if (!physical.thicknessMm && typeof cloudClient === 'function' && isbn) {
    try {
      var dsb = await cloudClient().catch(function () { return null; });
      if (dsb) {
        var dr = await dsb.from('editions').select('thickness_mm').eq('isbn', isbn).maybeSingle();
        if (dr && dr.data) physical.thicknessMm = Number(dr.data.thickness_mm) || 0;
      }
    } catch (e) {}
  }
  return {
    appearance: pick,
    other: (local[other] && Object.keys(local[other]).length) || (pool[other] && Object.keys(pool[other]).length)
      ? other : null,
    urls: merged, real: real, dims: b3dDims(frontSize, spineSize, physical), local: local, pool: pool
  };
}

// ---------- the viewer ----------

function b3dOpenViewer(bookId) {
  if (typeof document === 'undefined') return;
  var lib = (typeof library !== 'undefined' ? library : []);
  var book = lib.find(function (b) { return b && String(b.id) === String(bookId); });
  if (!book) { if (typeof toast === 'function') toast('Book not found'); return; }

  var ov = document.createElement('div');
  ov.className = 'ec-backdrop';
  ov.id = 'b3d-view';
  ov.innerHTML =
    '<div class="b3d-wrap" role="dialog" aria-label="3D book viewer">' +
    '<div class="b3d-top"><div><h3 class="serif">' + esc(book.title || 'Untitled') + '</h3>' +
    '<p class="ec-sub">' + esc(((book.authors && book.authors[0]) || '')) + '</p></div>' +
    '<button class="btn ghost sm" id="b3d-close" aria-label="Close">✕</button></div>' +
    '<div class="b3d-stage"><canvas id="b3d-canvas"></canvas>' +
    '<div class="b3d-load" id="b3d-load"><span class="spinner"></span></div></div>' +
    '<div class="b3d-bar"><div class="b3d-appear" id="b3d-appear" hidden></div>' +
    '<p class="b3d-hint">Drag to spin · pinch or scroll to zoom</p></div>' +
    '</div>';
  document.body.appendChild(ov);
  var tornDown = false;
  var domTeardown = function () {
    if (tornDown) return; tornDown = true;
    var n = document.getElementById('b3d-view');
    if (n) n.remove();
  };
  var token = (typeof overlayOpened === 'function')
    ? overlayOpened('b3d-view', function () { teardownGL(); domTeardown(); })
    : null;

  var renderer = null, raf = 0, disposables = [], localObjectUrls = [], buildGeneration = 0, poolCache = null;
  var teardownGL = function () {
    buildGeneration++;
    if (raf) { try { cancelAnimationFrame(raf); } catch (e) {} raf = 0; }
    window.removeEventListener('resize', onResize);
    disposables.forEach(function (d) { try { d.dispose(); } catch (e) {} });
    disposables = [];
    localObjectUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    localObjectUrls = [];
    if (renderer) { try { renderer.dispose(); } catch (e) {} renderer = null; }
  };
  var track = function (d) { disposables.push(d); return d; };

  ov.querySelector('#b3d-close').addEventListener('click', function () {
    teardownGL(); domTeardown();
    if (token && typeof overlayClosed === 'function') overlayClosed(token);
    else if (typeof history !== 'undefined' && history.length) { try { history.back(); } catch (e) {} }
  });

  var canvas = ov.querySelector('#b3d-canvas');
  var stage = ov.querySelector('.b3d-stage');
  var loadEl = ov.querySelector('#b3d-load');

  var onResize = function () {
    if (!renderer || tornDown) return;
    var w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  var camera = null;

  var build = async function (appearance) {
    teardownGL();
    var myGeneration = buildGeneration;
    loadEl.style.display = '';
    var THREE;
    try {
      THREE = await b3dEnsureThree();
    } catch (e) {
      if (typeof toast === 'function') toast('3D engine failed to load');
      loadEl.style.display = 'none';
      return;
    }
    var resolved = await b3dResolveFaces(book, localObjectUrls, poolCache);
    if (!poolCache) poolCache = resolved.pool;
    if (myGeneration !== buildGeneration || tornDown) return;
    if (tornDown) return;
    if (appearance) {
      // Rebuild with the other appearance (same book, no re-resolve needed
      // beyond swapping the merged set).
      var local = resolved.local || {};
      var pool = resolved.pool || {};
      var other = appearance === 'jacket' ? 'board' : 'jacket';
      resolved = {
        appearance: appearance,
        other: (local[other] && Object.keys(local[other]).length) || (pool[other] && Object.keys(pool[other]).length)
          ? other : null,
        urls: b3dMergeFaces(local[appearance], pool[appearance], pool[other]),
        real: {},
        dims: resolved.dims, local: local, pool: pool
      };
      ['front', 'back', 'spine', 'fore_edge'].forEach(function (f) {
        resolved.real[f] = !!(resolved.urls[f] && local[appearance] && local[appearance][f]);
      });
    }

    var dims = resolved.dims;
    var H = dims.H, coverW = dims.coverW, thick = dims.thick;
    var oh = 0.035; // cover overhang ("squares")

    var texFront, texBack, texSpine, texFore, texPage;
    var pageTex = track(b3dCanvasTexture(THREE, b3dPageCanvas()));
    var getTex = async function (url, fallbackCanvas) {
      var t = url ? await b3dLoadTexture(THREE, url) : null;
      if (t) return track(t);
      return track(b3dCanvasTexture(THREE, fallbackCanvas()));
    };
    // Front: scanned face, else the book's cover art, else generated.
    var frontUrl = resolved.urls.front;
    if (!frontUrl && book.cover) {
      var coverTex = await b3dLoadTexture(THREE, book.cover);
      texFront = coverTex ? track(coverTex)
        : track(b3dCanvasTexture(THREE, b3dCoverCanvas(book, 'front')));
    } else {
      texFront = await getTex(frontUrl, function () { return b3dCoverCanvas(book, 'front'); });
    }
    texBack = await getTex(resolved.urls.back, function () { return b3dCoverCanvas(book, 'back'); });
    texSpine = await getTex(resolved.urls.spine, function () { return b3dSpineCanvas(book); });
    texFore = await getTex(resolved.urls.fore_edge, b3dPageCanvas);
    texPage = pageTex;
    if (myGeneration !== buildGeneration || tornDown) return;

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    } catch (e) {
      if (typeof toast === 'function') toast('WebGL is unavailable on this device');
      loadEl.style.display = 'none';
      return;
    }
    track(renderer);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x141020);
    scene.fog = new THREE.Fog(0x141020, 9, 16);

    camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
    var camDist = 5.2, camTarget = new THREE.Vector3(0, 0, 0);
    var placeCam = function () {
      camera.position.set(
        camTarget.x + camDist * 0.55,
        camTarget.y + camDist * 0.28,
        camTarget.z + camDist * 0.8);
      camera.lookAt(camTarget);
    };
    placeCam();

    scene.add(new THREE.HemisphereLight(0xfff4e2, 0x2a2438, 0.85));
    var key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(3.5, 5.5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -3; key.shadow.camera.right = 3;
    key.shadow.camera.top = 3; key.shadow.camera.bottom = -3;
    key.shadow.camera.far = 20;
    key.shadow.bias = -0.002;
    scene.add(key);
    var fill = new THREE.DirectionalLight(0xbfd0ff, 0.45);
    fill.position.set(-4, 2, -3.5);
    scene.add(fill);

    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 14),
      new THREE.ShadowMaterial({ opacity: 0.32 }));
    track(ground.geometry); track(ground.material);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -H / 2 - 0.45;
    ground.receiveShadow = true;
    scene.add(ground);

    var book3d = new THREE.Group();
    scene.add(book3d);

    var mat = function (t) {
      return track(new THREE.MeshStandardMaterial({ map: t, roughness: 0.62, metalness: 0.04 }));
    };
    var plainDark = track(new THREE.MeshStandardMaterial({ color: 0x2b2536, roughness: 0.9 }));

    var front = new THREE.Mesh(new THREE.PlaneGeometry(coverW, H), mat(texFront));
    track(front.geometry);
    front.position.z = thick / 2;
    var back = new THREE.Mesh(new THREE.PlaneGeometry(coverW, H), mat(texBack));
    track(back.geometry);
    back.rotation.y = Math.PI;
    back.position.z = -thick / 2;
    var spine = new THREE.Mesh(new THREE.PlaneGeometry(thick, H), mat(texSpine));
    track(spine.geometry);
    spine.rotation.y = -Math.PI / 2;
    spine.position.x = -coverW / 2;
    [front, back, spine].forEach(function (m) { m.castShadow = true; book3d.add(m); });

    var pw = coverW - oh - 0.02, ph = H - 2 * oh, pd = thick - 0.05;
    var pages = new THREE.Mesh(
      track(new THREE.BoxGeometry(pw, ph, pd)),
      [mat(texFore), plainDark, mat(texPage), mat(texPage), plainDark, plainDark]);
    pages.position.set((0.02 - oh) / 2, 0, 0);
    pages.castShadow = true;
    book3d.add(pages);

    // appearance toggle
    var appearEl = ov.querySelector('#b3d-appear');
    var mkBtn = function (ap, label) {
      var b = document.createElement('button');
      b.className = 'btn ghost sm' + (resolved.appearance === ap ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', function () {
        if (resolved.appearance !== ap) build(ap);
      });
      return b;
    };
    appearEl.innerHTML = '';
    if (resolved.other || resolved.appearance) {
      appearEl.hidden = false;
      appearEl.appendChild(mkBtn('jacket', 'Jacket'));
      appearEl.appendChild(mkBtn('board', 'Boards'));
      if (!resolved.other) {
        // only one appearance has faces — disable the empty one
        var btns = appearEl.querySelectorAll('button');
        var emptyAp = resolved.appearance === 'jacket' ? 'board' : 'jacket';
        btns[emptyAp === 'jacket' ? 0 : 1].disabled = true;
      }
    }

    // controls: drag to orbit (damped), wheel/pinch to zoom, auto-spin first
    var pointers = new Map();
    var tRY = 0.55, tRX = 0.14, auto = true;
    var pinchD0 = 0, camD0 = 0;
    canvas.style.touchAction = 'none';
    var onPointerDown = function (e) {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      auto = false;
      if (pointers.size === 2) {
        var p = Array.from(pointers.values());
        pinchD0 = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
        camD0 = camDist;
      }
    };
    var onPointerMove = function (e) {
      if (!pointers.has(e.pointerId)) return;
      var prev = pointers.get(e.pointerId);
      var dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 1) {
        tRY += dx * 0.0062;
        tRX = Math.min(1.1, Math.max(-1.1, tRX + dy * 0.0062));
      } else if (pointers.size === 2 && pinchD0 > 0) {
        var p = Array.from(pointers.values());
        var d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
        camDist = Math.min(10, Math.max(2.6, camD0 * pinchD0 / Math.max(1, d)));
        placeCam();
      }
    };
    var endPointer = function (e) { pointers.delete(e.pointerId); };
    var onWheel = function (e) {
      e.preventDefault();
      auto = false;
      camDist = Math.min(10, Math.max(2.6, camDist * (1 + e.deltaY * 0.0011)));
      placeCam();
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    disposables.push({
      dispose: function () {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', endPointer);
        canvas.removeEventListener('pointercancel', endPointer);
        canvas.removeEventListener('wheel', onWheel);
        pointers.clear();
      }
    });

    window.addEventListener('resize', onResize);
    onResize();
    loadEl.style.display = 'none';

    var loop = function () {
      if (tornDown || !renderer) return;
      raf = requestAnimationFrame(loop);
      if (auto) tRY += 0.0075;
      book3d.rotation.y += (tRY - book3d.rotation.y) * 0.14;
      book3d.rotation.x += (tRX - book3d.rotation.x) * 0.14;
      renderer.render(scene, camera);
    };
    loop();
  };

  window.addEventListener('resize', onResize);
  build(null);
}
