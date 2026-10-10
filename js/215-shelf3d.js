/* 208-shelf3d.js — real-3D bookshelf tab (Three.js), ported from the
   prototype/threejs-shelf spike (prototype-shelf.html, v7).

   Renders the user's library as physical books on a wooden bookcase in a
   cozy room: decoration inventory with counts (Shelf/Room tabs), all 21
   decorations (plant, candle, mug, book stack, fairy lights, clock, photo
   frame, succulent, lantern, globe, spiderweb, pumpkin, stems vase, crescent
   moon, star garland, gift boxes, painted eggs, snowflake, gold coins,
   clover, apple bowl), per-theme presets with a "Dress shelf for <theme>"
   button, tilt + sound toggles, dust motes, candle flicker / fairy twinkle
   animations, confirm dialog and toasts. Tap a book to open it.

   Three.js (r159 UMD, vendored at js/vendor/three.min.js) is LAZY-loaded on
   first mount via the b3dEnsureThree() pattern from js/207-book3d.js, so the
   ~600 KB never touches initial page load.

   Classic script, no modules. Exposes:
     window.Shelf3D = {
       mount(container, opts),   // -> Promise<handle>; opts = { onBookTap(bookId), initialBooks, appTheme }
       unmount(),
       setBooks(books),          // books: [{id, title, spineC1, spineC2, spineW, spineH}]
       setTheme(themeKey),       // 'autumn' or anything else (= default look)
       setThemeParams(params),   // full app-theme params from Shelf3DTheme.forTheme()
       setAppTheme(themeKey)     // app theme key: updates the dress button label (never rearranges)
     }

   The instance owns ALL of its state (no module-level Three.js objects), so
   the Shelf tab can mount/unmount freely on tab switches without leaking:
   unmount() cancels the frame loop, disposes every geometry/material/texture,
   removes all DOM and window listeners, disconnects the resize observer and
   closes the audio context.

   Convention notes: the HUD/inventory DOM is built inside `container` (which
   must be positioned with a real size); all pointer math is container-relative
   via getBoundingClientRect(), never window.innerWidth. If WebGL is
   unavailable, mount() rejects with an Error and the caller falls back to
   the 2.5D shelf. Floor-placed decorations are clamped into FLOOR_BOUNDS and
   pushed out of the bookcase footprint, so they can never land under the
   shelves (the prototype's pumpkin-under-shelf bug). */

'use strict';

(function () {

  /* ---------- Three.js lazy load ----------
     Reuses 207's global loader when present; falls back to an identical local
     loader so this module also works standalone. Resolves with window.THREE. */
  function s3dLoadThreeLocal() {
    if (window.THREE) return Promise.resolve(window.THREE);
    if (s3dLoadThreeLocal.p) return s3dLoadThreeLocal.p;
    s3dLoadThreeLocal.p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'js/vendor/three.min.js';
      s.onload = function () {
        if (window.THREE) resolve(window.THREE);
        else { s3dLoadThreeLocal.p = null; reject(new Error('three failed to define THREE')); }
      };
      s.onerror = function () { s3dLoadThreeLocal.p = null; reject(new Error('three failed to load')); };
      document.head.appendChild(s);
    });
    return s3dLoadThreeLocal.p;
  }
  function s3dEnsureThree() {
    if (typeof window.b3dEnsureThree === 'function') return window.b3dEnsureThree();
    return s3dLoadThreeLocal();
  }

  /* ---------- dimensions ---------- */
  var SHELF_W = 10, PLANK_D = 2.6, PLANK_T = 0.28, SIDE_T = 0.3;
  var LEVELS = [0.64, 3.64, 6.64];           // top surface Y of each plank
  var TOP_Y = 8.04;
  var WALL_Z = -PLANK_D / 2 - 0.16;          // bookcase back panel plane
  var MAX_BOOKS = 60;                        // ~20 per shelf x 3 shelves

  /* Pumpkin-under-shelf fix: floor-placed decorations live inside FLOOR_BOUNDS
     (the visible floor area) and are pushed out of SHELF_FOOTPRINT (the
     rectangle under the bookcase), so they can never end up hidden beneath
     the shelves or outside the visible room. */
  var FLOOR_BOUNDS = { minX: -9, maxX: 9, minZ: -2, maxZ: 5 };
  var SHELF_FOOTPRINT = {
    minX: -(SHELF_W / 2 + SIDE_T) - 0.35, maxX: (SHELF_W / 2 + SIDE_T) + 0.35,
    minZ: -(PLANK_D / 2) - 0.35, maxZ: (PLANK_D / 2) + 0.35
  };

  /* ---------- scoped CSS (prototype CSS, namespaced under .s3d-root) ---------- */
  var S3D_CSS = [
    '.s3d-root{position:absolute;inset:0;overflow:hidden;background:#14101c;',
    '  font-family:Georgia,\'Times New Roman\',serif;color:#f6eff8;}',
    '.s3d-root *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}',
    '.s3d-root #s3dScene{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:pan-y;}',
    '.s3d-root #s3dVignette{position:absolute;inset:0;pointer-events:none;',
    '  background:radial-gradient(ellipse at 50% 42%,transparent 55%,rgba(8,5,12,.55) 100%);}',
    '.s3d-root #s3dHud{position:absolute;top:0;left:0;right:0;',
    '  padding:calc(10px + env(safe-area-inset-top)) 14px 8px;',
    '  display:flex;align-items:center;justify-content:space-between;pointer-events:none;z-index:5;}',
    '.s3d-root #s3dHud .title{font-size:17px;letter-spacing:.04em;color:#f6eff8;',
    '  text-shadow:0 2px 8px rgba(0,0,0,.6);}',
    '.s3d-root #s3dHud .title small{display:block;font-family:system-ui,sans-serif;font-size:10px;',
    '  letter-spacing:.22em;color:#e5b86a;text-transform:uppercase;margin-bottom:2px;}',
    '.s3d-root #s3dHud .btns{display:flex;gap:8px;pointer-events:auto;}',
    '.s3d-root .pill{font-family:system-ui,sans-serif;font-size:12px;font-weight:600;',
    '  border:1px solid rgba(229,184,106,.45);background:rgba(20,14,26,.72);color:#e5b86a;',
    '  border-radius:999px;padding:8px 14px;cursor:pointer;backdrop-filter:blur(6px);}',
    '.s3d-root .pill:active{transform:scale(.96);}',
    '.s3d-root .pill.dim{opacity:.45;}',
    '.s3d-root .pill.on{background:#e5b86a;color:#241a10;border-color:#e5b86a;}',
    '.s3d-root #s3dHint{position:absolute;bottom:calc(86px + env(safe-area-inset-bottom));left:0;right:0;',
    '  text-align:center;font-family:system-ui,sans-serif;font-size:12.5px;color:#f6eff8;',
    '  pointer-events:none;z-index:9;padding:0 24px;opacity:0;transform:translateY(8px);',
    '  transition:opacity .25s ease,transform .25s ease;}',
    '.s3d-root #s3dHint.show{opacity:1;transform:translateY(0);}',
    '.s3d-root #s3dHint span{background:rgba(20,14,26,.82);border:1px solid rgba(229,184,106,.4);',
    '  border-radius:999px;padding:8px 16px;display:inline-block;',
    '  box-shadow:0 4px 14px rgba(0,0,0,.5);backdrop-filter:blur(6px);}',
    '.s3d-root #s3dConfirmOv{position:absolute;inset:0;z-index:30;display:none;',
    '  align-items:center;justify-content:center;background:rgba(8,5,12,.6);',
    '  backdrop-filter:blur(3px);padding:24px;}',
    '.s3d-root #s3dConfirmOv.show{display:flex;}',
    '.s3d-root #s3dConfirmOv .box{background:rgba(26,19,34,.97);border:1px solid rgba(229,184,106,.5);',
    '  border-radius:16px;padding:20px;max-width:320px;text-align:center;',
    '  font-family:system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);}',
    '.s3d-root #s3dConfirmOv p{margin:0 0 16px;font-size:14px;line-height:1.5;color:#f6eff8;}',
    '.s3d-root #s3dConfirmOv .row{display:flex;gap:10px;}',
    '.s3d-root #s3dConfirmOv button{flex:1;border-radius:10px;padding:10px;font-size:13px;font-weight:700;',
    '  cursor:pointer;font-family:system-ui,sans-serif;}',
    '.s3d-root #s3dConfirmNo{background:transparent;color:#b9a8c6;border:1px solid rgba(185,168,198,.4);}',
    '.s3d-root #s3dConfirmYes{background:#e5b86a;color:#241a10;border:none;}',
    '.s3d-root #s3dInvBtn{position:absolute;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:6;',
    '  width:58px;height:58px;border-radius:50%;border:1px solid rgba(229,184,106,.55);',
    '  background:rgba(32,24,40,.92);color:#e5b86a;font-size:24px;cursor:pointer;',
    '  box-shadow:0 4px 16px rgba(0,0,0,.5);backdrop-filter:blur(6px);',
    '  display:none;}',  // v417: hidden — inventory now in the ⋮ overflow menu
    '.s3d-root #s3dInvBtn:active{transform:scale(.93);}',
    '.s3d-root #s3dInvPanel{position:absolute;left:0;right:0;bottom:0;z-index:8;max-height:62%;',
    '  background:rgba(18,13,24,.97);border-top:1px solid rgba(229,184,106,.35);',
    '  border-radius:20px 20px 0 0;padding:14px 16px calc(16px + env(safe-area-inset-bottom));',
    '  transform:translateY(105%);transition:transform .28s cubic-bezier(.2,.9,.3,1.1);overflow-y:auto;}',
    '.s3d-root #s3dInvPanel.open{transform:translateY(0);}',
    '.s3d-root #s3dInvPanel h3{margin:0 0 4px;font-size:15px;color:#f6eff8;font-family:system-ui,sans-serif;}',
    '.s3d-root #s3dInvPanel .sub{font-size:11px;color:#b9a8c6;font-family:system-ui,sans-serif;margin-bottom:10px;}',
    '.s3d-root #s3dInvGrid{display:flex;gap:10px;overflow-x:auto;padding:6px 2px 10px;',
    '  -webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;}',
    '.s3d-root .inv-item{flex:0 0 auto;width:70px;background:rgba(40,30,52,.9);border:1px solid rgba(229,184,106,.25);border-radius:12px;',
    '  padding:10px 4px 8px;text-align:center;cursor:pointer;touch-action:pan-x;',  // v442: horizontal row; swipe scrolls, vertical drag picks up
    '  font-family:system-ui,sans-serif;font-size:10px;color:#f6eff8;',
    '  user-select:none;-webkit-user-select:none;position:relative;}',
    '.s3d-root .inv-item:active{transform:scale(.94);border-color:#e5b86a;}',
    '.s3d-root .inv-item svg{width:34px;height:34px;display:block;margin:0 auto 4px;}',
    '.s3d-root .inv-item.picked{border-color:#e5b86a;background:rgba(229,184,106,.16);',
    '  box-shadow:0 0 0 2px rgba(229,184,106,.5);}',
    '.s3d-root .inv-item .cnt{position:absolute;top:4px;right:6px;font-size:10px;color:#e5b86a;font-weight:700;}',
    '.s3d-root #s3dSelmenu{position:absolute;z-index:7;display:none;transform:translate(-50%,-110%);',
    '  background:rgba(24,17,32,.94);border:1px solid rgba(229,184,106,.5);border-radius:12px;',
    '  padding:6px;gap:6px;box-shadow:0 8px 24px rgba(0,0,0,.5);}',
    '.s3d-root #s3dSelmenu.show{display:flex;}',
    '.s3d-root #s3dSelmenu button{font-family:system-ui,sans-serif;font-size:12px;font-weight:600;border:none;',
    '  border-radius:8px;padding:8px 12px;cursor:pointer;}',
    '.s3d-root #s3dSelmenu .mv{background:#e5b86a;color:#241a10;}',
    '.s3d-root #s3dSelmenu .del{background:rgba(200,60,60,.18);color:#ff9a9a;border:1px solid rgba(200,60,60,.5);}',
    '.s3d-root #s3dSelmenu .done{background:transparent;color:#b9a8c6;}',
    '.s3d-root #s3dTiltDbg{position:absolute;top:64px;left:12px;z-index:15;display:none;',
    '  font:10px/1.5 ui-monospace,monospace;color:#b9a8c6;background:rgba(10,8,14,.55);',
    '  padding:4px 8px;border-radius:6px;pointer-events:none;white-space:pre;}',
    '.s3d-root #s3dInvTabs{display:flex;gap:6px;margin:8px 0 2px;}',
    '.s3d-root #s3dInvTabs button{flex:1;border:1px solid rgba(229,184,106,.35);background:transparent;',
    '  color:#b9a8c6;border-radius:8px;padding:6px;font-size:12px;}',
    '.s3d-root #s3dInvTabs button.on{background:rgba(229,184,106,.2);color:#f6eff8;}',
    '.s3d-root #s3dPlaceBar{position:absolute;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:9;',
    '  display:none;align-items:center;gap:10px;background:rgba(24,17,32,.96);',
    '  border:1px solid rgba(229,184,106,.5);border-radius:14px;padding:10px 12px;',
    '  font-family:system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5);}',
    '.s3d-root #s3dPlaceBar.show{display:flex;}',
    '.s3d-root #s3dPlaceMsg{flex:1;font-size:13px;color:#f6eff8;}',
    '.s3d-root #s3dPlaceMsg b{color:#e5b86a;}',
    '.s3d-root #s3dPlaceBar button{font-family:system-ui,sans-serif;font-size:12px;font-weight:600;border:none;',
    '  border-radius:8px;padding:8px 12px;cursor:pointer;white-space:nowrap;}',
    '.s3d-root #s3dPlaceUndo{background:#e5b86a;color:#241a10;}',
    '.s3d-root #s3dPlaceCancel{background:transparent;color:#b9a8c6;border:1px solid rgba(185,168,198,.4);}'
  ].join('\n');

  /* ---------- DOM markup (built inside the mount container) ---------- */
  var S3D_MARKUP = [
    '<canvas id="s3dScene"></canvas>',
    '<div id="s3dVignette"></div>',
    '<div id="s3dHud">',
    '  <div class="title"><small>Cozy Libram</small>3D Shelf</div>',
    '  <div class="btns">',
    '    <button class="pill" id="s3dTiltBtn">Tilt: off</button>',
    '    <button class="pill" id="s3dSndBtn">Sound: on</button>',
    '    <button class="pill" id="s3dPresetBtn">Dress shelf</button>',
    '  </div>',
    '</div>',
    '<div id="s3dTiltDbg"></div>',
    '<div id="s3dHint"><span></span></div>',
    '<button id="s3dInvBtn" aria-label="Open decoration inventory">\u25a6</button>',
    '<div id="s3dInvPanel">',
    '  <h3>Decoration inventory</h3>',
    '  <div class="sub">Tap to pick up, then tap a shelf to place &middot; or drag straight onto a shelf</div>',
    '  <div id="s3dInvTabs"><button data-tab="shelf" class="on">Shelf</button><button data-tab="room">Room</button></div>',
    '  <div id="s3dInvGrid"></div>',
    '</div>',
    '<div id="s3dPlaceBar"><span id="s3dPlaceMsg"></span>',
    '  <button id="s3dPlaceUndo" style="display:none">Put back</button>',
    '  <button id="s3dPlaceCancel">Cancel</button></div>',
    '<div id="s3dSelmenu">',
    '  <button class="mv" id="s3dSelMove">Move</button>',
    '  <button class="del" id="s3dSelDelete">Delete</button>',
    '  <button class="done" id="s3dSelDone">Done</button>',
    '</div>',
    '<div id="s3dConfirmOv"><div class="box"><p id="s3dConfirmMsg"></p><div class="row">',
    '  <button id="s3dConfirmNo">Cancel</button><button id="s3dConfirmYes">Continue</button>',
    '</div></div></div>'
  ].join('');

  /* ---------- small pure helpers ---------- */
  function clampNum(v, lo, hi, fb) {
    v = Number(v);
    if (!isFinite(v)) return fb;
    return Math.min(hi, Math.max(lo, v));
  }
  function safeColor(THREE, css, fb) {
    try { return new THREE.Color(css || fb); }
    catch (e) { return new THREE.Color(fb); }
  }
  /* Deep-dispose a Three.js subtree: geometries, materials, textures. Uses
     visited sets so shared textures/materials are only disposed once. */
  function disposeDeep(obj) {
    var geos = [], mats = [], texs = [];
    function seen(arr, v) { return arr.indexOf(v) >= 0; }
    obj.traverse(function (o) {
      if (o.geometry && !seen(geos, o.geometry)) geos.push(o.geometry);
      if (o.material) {
        var list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach(function (m) { if (!seen(mats, m)) mats.push(m); });
      }
    });
    mats.forEach(function (m) {
      ['map', 'emissiveMap', 'alphaMap', 'bumpMap', 'normalMap', 'roughnessMap'].forEach(function (k) {
        if (m[k] && m[k].isTexture && !seen(texs, m[k])) texs.push(m[k]);
      });
      if (typeof m.dispose === 'function') m.dispose();
    });
    texs.forEach(function (t) { if (typeof t.dispose === 'function') t.dispose(); });
    geos.forEach(function (g) { if (typeof g.dispose === 'function') g.dispose(); });
  }

  /* ============================== instance ==============================
     Everything below lives inside one mount() call, so unmount() can tear
     it all down without touching any other part of the page. */
  function createInstance(container, opts) {
    var THREE = window.THREE;
    var dead = false;

    /* ----- DOM ----- */
    var root = document.createElement('div');
    root.className = 's3d-root';
    var styleEl = document.createElement('style');
    styleEl.textContent = S3D_CSS;
    root.appendChild(styleEl);
    var body = document.createElement('div');
    body.innerHTML = S3D_MARKUP;
    while (body.firstChild) root.appendChild(body.firstChild);
    container.appendChild(root);
    function $(id) { return root.querySelector('#' + id); }
    var canvas = $('s3dScene');

    /* ----- tracked listeners (all removed on unmount) ----- */
    var listeners = [];
    function on(target, type, fn, opt) {
      target.addEventListener(type, fn, opt);
      listeners.push([target, type, fn, opt]);
    }
    function offAll() {
      listeners.forEach(function (l) {
        try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {}
      });
      listeners.length = 0;
    }

    /* ----- renderer (WebGL check: failure rejects mount()) ----- */
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    } catch (e) {
      if (root.parentNode) root.parentNode.removeChild(root);
      throw new Error('WebGL is unavailable: ' + (e && e.message ? e.message : e));
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;  // Phase 1: cheaper than PCFSoft
    renderer.shadowMap.autoUpdate = false;  // Phase 1: bake shadows, update on demand
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14101c);
    scene.fog = new THREE.Fog(0x14101c, 20, 38);

    var camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    /* pulled-back default framing + gentle dolly-in on load */
    var camBase = new THREE.Vector3(0, 4.8, 13.4);
    var camTarget = new THREE.Vector3(0, 3.6, 0);
    camera.position.copy(camBase);
    camera.position.z *= 1.22;   // dolly start; eases to camBase over ~2.2s
    camera.lookAt(camTarget);
    var loadT0 = performance.now();
    var lastInteract = performance.now(), driftAmt = 0;
    on(window, 'pointerdown', function () { lastInteract = performance.now(); }, true);
    // v412: pinch/wheel zoom (Kevin: spines too small on mobile).
    // zoomFactor 1.0 = default, <1 = closer, >1 = farther. Clamped 0.5–2.0.
    var zoomFactor = 1.0;
    function setZoom(f) {
      zoomFactor = Math.max(0.5, Math.min(2.0, f));
      lastInteract = performance.now();
    }

    /* lights — soft warm key + cool rim fill, lifted ambient so wood grain reads */
    var ambLight = new THREE.AmbientLight(0x9a8a76, 0.85);
    scene.add(ambLight);
    var hemi = new THREE.HemisphereLight(0x8a7ab0, 0x2a1c12, 0.55);
    scene.add(hemi);
    var sun = new THREE.DirectionalLight(0xffe2b8, 2.3);
    sun.position.set(6, 11, 8);
    // v409: warm downlight above the bookcase by default (Kevin: spines hard to read on mobile).
    // Makes book titles legible without washing out the mood.
    var downLight = new THREE.PointLight(0xffd9a0, 12, 18, 1.8);
    downLight.position.set(0, 9.5, 2.5);
    scene.add(downLight);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);  // Phase 1: 1024 instead of 2048 (4x cheaper)
    sun.shadow.camera.left = -9; sun.shadow.camera.right = 9;
    sun.shadow.camera.top = 11; sun.shadow.camera.bottom = -2;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 32;
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.035;   // kills the triangular light-leak on the bottom shelf
    scene.add(sun);
    var rim = new THREE.DirectionalLight(0x7a6ac0, 0.6);
    rim.position.set(-7, 6, -4);
    scene.add(rim);

    /* ----- shelf ----- */
    /* procedural wood grain — flat brown reads cheap, satin sheen reads expensive */
    /* Phase 1: seeded RNG so wood is stable across mounts */
    var woodSeed = 1234567;
    function srand() {
      woodSeed = (woodSeed * 1103515245 + 12345) & 0x7fffffff;
      return woodSeed / 0x7fffffff;
    }
    function woodTexture(base, streakDark, streakLight) {
      var c = document.createElement('canvas'); c.width = c.height = 256;
      var g = c.getContext('2d');
      g.fillStyle = base; g.fillRect(0, 0, 256, 256);
      var i, y, h, w, x;
      for (i = 0; i < 80; i++) {           // long grain streaks
        y = srand() * 256; h = 1 + srand() * 3;
        w = 120 + srand() * 136; x = srand() * 256 - 60;
        g.fillStyle = srand() < 0.55 ? streakDark : streakLight;
        g.globalAlpha = 0.05 + srand() * 0.11;
        g.fillRect(x, y, w, h);
      }
      g.globalAlpha = 0.05;                    // fine speckle
      for (i = 0; i < 420; i++) {
        g.fillStyle = srand() < 0.5 ? '#000' : '#fff';
        g.fillRect(srand() * 256, srand() * 256, 1.6, 1.6);
      }
      g.globalAlpha = 1;
      var t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(2, 1);
      return t;
    }
    var woodMat = new THREE.MeshStandardMaterial({
      map: woodTexture('#6e4a2c', '#281608', '#c89664'), roughness: 0.52, metalness: 0.05 });
    var woodDark = new THREE.MeshStandardMaterial({
      map: woodTexture('#4e3320', '#1c0e05', '#9a7048'), roughness: 0.58, metalness: 0.05 });

    function box(w, h, d, mat, x, y, z, shadow) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = shadow !== false; m.receiveShadow = true;
      scene.add(m);
      return m;
    }
    LEVELS.forEach(function (topY) {
      box(SHELF_W, PLANK_T, PLANK_D, woodMat, 0, topY - PLANK_T / 2, 0);   // v442: planks sit between the side panels (was SHELF_W + SIDE_T * 2) — fixes z-fighting where planks met sides
    });
    box(SIDE_T, TOP_Y - 0.3, PLANK_D, woodDark, -(SHELF_W / 2 + SIDE_T / 2), (TOP_Y - 0.3) / 2, 0);
    box(SIDE_T, TOP_Y - 0.3, PLANK_D, woodDark,  (SHELF_W / 2 + SIDE_T / 2), (TOP_Y - 0.3) / 2, 0);
    box(SHELF_W + SIDE_T * 2, 0.3, PLANK_D, woodMat, 0, TOP_Y - 0.15, 0);          // crown
    var back = new THREE.Mesh(new THREE.PlaneGeometry(SHELF_W + SIDE_T * 2, TOP_Y),
      new THREE.MeshStandardMaterial({ color: 0x241a20, roughness: 0.95 }));
    back.position.set(0, TOP_Y / 2, WALL_Z);
    back.receiveShadow = true;
    scene.add(back);

    /* ground the room — radial vignette floor + hint of wall (fixes the black
       void, gives the pumpkin/spiderweb context) */
    function floorTexture() {
      var c = document.createElement('canvas'); c.width = c.height = 512;
      var g = c.getContext('2d');
      var gr = g.createRadialGradient(256, 256, 30, 256, 256, 256);
      gr.addColorStop(0, '#3a2a20'); gr.addColorStop(0.45, '#241a20');
      gr.addColorStop(1, '#14101c');
      g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }
    var floor = new THREE.Mesh(new THREE.CircleGeometry(26, 40),
      new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0; floor.receiveShadow = true;
    scene.add(floor);
    (function wallHint() {   // faint warm wall far behind the bookcase
      var c = document.createElement('canvas'); c.width = 4; c.height = 128;
      var g = c.getContext('2d');
      var gr = g.createLinearGradient(0, 0, 0, 128);
      gr.addColorStop(0, '#221822'); gr.addColorStop(0.7, '#1a1420'); gr.addColorStop(1, '#14101c');
      g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      var wall = new THREE.Mesh(new THREE.PlaneGeometry(60, 18),
        new THREE.MeshBasicMaterial({ map: t, fog: true }));
      wall.position.set(0, 8, -9); scene.add(wall);
    })();

    /* dust motes drifting in the light — cheap Points, ~130 particles */
    var MOTES = 130;
    var moteBase = new Float32Array(MOTES * 3), motePhase = new Float32Array(MOTES);
    var moteGeo = new THREE.BufferGeometry();
    (function () {
      var pos = new Float32Array(MOTES * 3);
      for (var i = 0; i < MOTES; i++) {
        moteBase[i * 3] = -7 + Math.random() * 14;
        moteBase[i * 3 + 1] = 0.5 + Math.random() * 8;
        moteBase[i * 3 + 2] = -2 + Math.random() * 6;
        motePhase[i] = Math.random() * Math.PI * 2;
        pos[i * 3] = moteBase[i * 3]; pos[i * 3 + 1] = moteBase[i * 3 + 1]; pos[i * 3 + 2] = moteBase[i * 3 + 2];
      }
      moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    })();
    var motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({ color: 0xffd9a0, size: 0.05,
      transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false }));
    scene.add(motes);

    /* ============================== books ==============================
       Real library books replace the prototype's hardcoded demo fills.
       setBooks() lays them out left-to-right, top shelf first; anything past
       MAX_BOOKS (~60) is ignored. */
    var occupied = LEVELS.map(function () { return []; });  // occupied x-intervals per shelf level
    var shelfBooks = [];   // {mesh, li, rec}

    function spineTexture(title, bgCss, accentCss) {
      var c = document.createElement('canvas'); c.width = 128; c.height = 512;
      var g = c.getContext('2d');
      g.fillStyle = bgCss; g.fillRect(0, 0, 128, 512);
      var grad = g.createLinearGradient(0, 0, 128, 0);
      grad.addColorStop(0, 'rgba(0,0,0,.28)'); grad.addColorStop(0.18, 'rgba(0,0,0,0)');
      grad.addColorStop(0.82, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,.28)');
      g.fillStyle = grad; g.fillRect(0, 0, 128, 512);
      g.fillStyle = accentCss;   // palette accent bands (was a hardcoded gold)
      g.fillRect(14, 26, 100, 5); g.fillRect(14, 481, 100, 5);
      var fs = 36;
      function setF() { g.font = '600 ' + fs + 'px Georgia, serif'; }
      setF();
      var t = String(title || 'Untitled'), orig = t;
      while (g.measureText(t).width > 400 && fs > 15) { fs -= 2; setF(); }
      while (g.measureText(t).width > 400 && t.length > 5) t = t.slice(0, -2);
      if (t !== orig) t = t.trimEnd().slice(0, -1) + '\u2026';
      g.fillStyle = 'rgba(246,239,248,.94)';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.save(); g.translate(64, 256); g.rotate(-Math.PI / 2);
      g.fillText(t, 0, 0); g.restore();
      var tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      return tex;
    }
    function makeBook(b, w, h, d) {
      var css = b.spineC1 || '#5a4a6a';
      var accent = b.spineC2 || '#e5b86a';
      var col = safeColor(THREE, css, '#5a4a6a');
      var spine = new THREE.MeshStandardMaterial({ map: spineTexture(b.title, css, accent), roughness: 0.75 });
      var cloth = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.82), roughness: 0.85 });
      var pages = new THREE.MeshStandardMaterial({ color: 0xe6dabd, roughness: 0.95 });
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [cloth, cloth, pages, cloth, spine, cloth]);
      m.castShadow = true; m.receiveShadow = true;
      m.userData.bookId = b.id;
      return m;
    }
    function clearBooks() {
      shelfBooks.forEach(function (sb) {
        scene.remove(sb.mesh);
        disposeDeep(sb.mesh);
        var oi = occupied[sb.li].indexOf(sb.rec);
        if (oi >= 0) occupied[sb.li].splice(oi, 1);
      });
      shelfBooks.length = 0;
    }
    function setBooks(books) {
      clearBooks();
      if (!books || !books.length) { renderer.shadowMap.needsUpdate = true; markDirty(); return; }
      var list = books.slice(0, MAX_BOOKS);
      var order = [2, 1, 0];   // fill the top shelf first, like the prototype
      var li = 0;
      var startX = -SHELF_W / 2 + 0.35;
      var x = startX;
      list.forEach(function (b) {
        if (!b) return;
        var w = clampNum(b.spineW, 0.3, 0.72, 0.44);
        var h = clampNum(b.spineH, 1.4, 2.7, 2.0);
        var d = 1.75;
        while (li < 3 && x + w > startX + (SHELF_W - 0.7)) { li++; x = startX; }
        if (li >= 3) return;   // shelves are full — ignore the rest
        var mesh = makeBook(b, w, h, d);
        mesh.position.set(x + w / 2, LEVELS[order[li]] + h / 2, 0);
        scene.add(mesh);
        var rec = [x, x + w];
        occupied[order[li]].push(rec);
        shelfBooks.push({ mesh: mesh, li: order[li], rec: rec });
        x += w + 0.025;
      });
      renderer.shadowMap.needsUpdate = true;  // Phase 1: rebake shadows after books change
      markDirty();
    }
    var ray = new THREE.Raycaster();
    var ptr = new THREE.Vector2();
    function setPtr(e) {
      var r = canvas.getBoundingClientRect();
      ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    }
    function bookAt(e) {
      setPtr(e); ray.setFromCamera(ptr, camera);
      var meshes = shelfBooks.map(function (s) { return s.mesh; });
      var hits = ray.intersectObjects(meshes, false);
      return hits.length ? hits[0].object : null;
    }

    /* ============================== helpers ==============================
       toast/hint, tiny tween engine, WebAudio sfx, promise confirm dialog */
    var toastTimer = null, onboardTimer = null;
    var DEFAULT_HINT = 'Open inventory to decorate \u00b7 tap a placed decoration to select it';
    function setHint(msg) {
      var h = $('s3dHint');
      h.firstElementChild.textContent = msg;
      h.classList.add('show');
      clearTimeout(toastTimer); toastTimer = null;
    }
    function toast(msg, ms) {
      setHint(msg);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { $('s3dHint').classList.remove('show'); }, ms || 2400);
    }
    var tweens = [];
    function tween(dur, onU, onC) { tweens.push({ t0: performance.now(), dur: dur, onU: onU, onC: onC }); }
    function stepTweens(now) {
      for (var i = tweens.length - 1; i >= 0; i--) {
        var tw = tweens[i], k = Math.min(1, (now - tw.t0) / tw.dur);
        tw.onU(k);
        if (k >= 1) { tweens.splice(i, 1); if (tw.onC) tw.onC(); }
      }
    }
    var easeOutBack = function (k) { var c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
    var easeOut = function (k) { return 1 - Math.pow(1 - k, 3); };

    /* subtle WebAudio sfx — mutable via the Sound pill */
    var audioCtx = null, soundOn = true;
    function ac() {
      if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
      return audioCtx;
    }
    function sfx(kind) {
      if (!soundOn) return;
      var a = ac(); if (!a) return;
      if (a.state === 'suspended') a.resume();
      var t0 = a.currentTime;
      if (kind === 'place' || kind === 'delete') {
        var o = a.createOscillator(), g = a.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(kind === 'place' ? 430 : 300, t0);
        o.frequency.exponentialRampToValueAtTime(kind === 'place' ? 170 : 120, t0 + 0.09);
        g.gain.setValueAtTime(0.10, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
        o.connect(g); g.connect(a.destination);
        o.start(t0); o.stop(t0 + 0.13);
      } else if (kind === 'preset') {
        var len = 0.5, buf = a.createBuffer(1, a.sampleRate * len, a.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        var src = a.createBufferSource(); src.buffer = buf;
        var f = a.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.1;
        f.frequency.setValueAtTime(380, t0);
        f.frequency.exponentialRampToValueAtTime(2400, t0 + len);
        var g2 = a.createGain();
        g2.gain.setValueAtTime(0.08, t0);
        g2.gain.exponentialRampToValueAtTime(0.001, t0 + len);
        src.connect(f); f.connect(g2); g2.connect(a.destination);
        src.start(t0);
      }
    }
    on(window, 'pointerdown', function () { ac(); }, { once: true });  // unlock audio on first gesture

    /* confirm dialog (promise-based) */
    var confirmRes = null;
    function confirmDlg(msg) {
      return new Promise(function (res) {
        confirmRes = res;
        $('s3dConfirmMsg').textContent = msg;
        $('s3dConfirmOv').classList.add('show');
      });
    }
    $('s3dConfirmYes').addEventListener('click', function () {
      $('s3dConfirmOv').classList.remove('show');
      if (confirmRes) { confirmRes(true); confirmRes = null; }
    });
    $('s3dConfirmNo').addEventListener('click', function () {
      $('s3dConfirmOv').classList.remove('show');
      if (confirmRes) { confirmRes(false); confirmRes = null; }
    });

    /* ============================== decorations ============================== */
    function shadowify(g) {
      g.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return g;
    }

    /* leaf texture — plants read as folded paper with cones; textured quads read as leaves */
    function leafTexture(c1, c2) {
      var c = document.createElement('canvas'); c.width = 64; c.height = 128;
      var g = c.getContext('2d');
      var gr = g.createLinearGradient(0, 0, 0, 128);
      gr.addColorStop(0, c1); gr.addColorStop(1, c2);
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(32, 4);
      g.bezierCurveTo(56, 34, 54, 84, 32, 124);
      g.bezierCurveTo(10, 84, 8, 34, 32, 4);
      g.fill();
      g.strokeStyle = 'rgba(20,40,16,.55)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(32, 10); g.lineTo(32, 118); g.stroke();
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }
    var plantLeafTex = leafTexture('#5d8d46', '#3d6a30');

    function makePlant() {
      var g = new THREE.Group();
      var pot = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.21, 0.4, 14),
        new THREE.MeshStandardMaterial({ color: 0xa85f32, roughness: 0.85 }));
      pot.position.y = 0.2; g.add(pot);
      var soil = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.05, 14),
        new THREE.MeshStandardMaterial({ color: 0x2e2118, roughness: 1 }));
      soil.position.y = 0.4; g.add(soil);
      var leafMat = new THREE.MeshStandardMaterial({ map: plantLeafTex, transparent: true,
        alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9 });
      for (var i = 0; i < 7; i++) {
        var tall = i === 0;
        var a = (i / 7) * Math.PI * 2;
        var r = tall ? 0 : 0.13;
        var w = tall ? 0.34 : 0.26 + Math.random() * 0.08;
        var h = tall ? 1.0 : 0.6 + Math.random() * 0.25;
        // two crossed quads per leaf for a hint of volume
        for (var k = 0; k < 2; k++) {
          var leaf = new THREE.Mesh(new THREE.PlaneGeometry(w, h), leafMat);
          leaf.position.set(Math.cos(a) * r, 0.42 + h / 2 - 0.05, Math.sin(a) * r);
          leaf.rotation.y = a + k * Math.PI / 2;
          if (!tall) { leaf.rotation.z = Math.cos(a) * 0.38; leaf.rotation.x = -Math.sin(a) * 0.38; }
          g.add(leaf);
        }
      }
      g.userData = { decoType: 'plant', fw: 0.75, fd: 0.75 };
      return shadowify(g);
    }

    /* flame as a flickering additive sprite — the flat white cone never read as fire */
    function flameTexture() {
      var c = document.createElement('canvas'); c.width = c.height = 64;
      var g = c.getContext('2d');
      var gr = g.createRadialGradient(32, 36, 2, 32, 32, 30);
      gr.addColorStop(0, 'rgba(255,244,214,1)');
      gr.addColorStop(0.35, 'rgba(255,186,96,.95)');
      gr.addColorStop(0.7, 'rgba(255,122,30,.4)');
      gr.addColorStop(1, 'rgba(255,100,20,0)');
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(32, 32, 20, 28, 0, 0, 7); g.fill();
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }
    var flameTex = flameTexture();

    var candleFlames = [];

    /* ---- mobile point-light budget (Pixel 7 Pro reference) ----
       Forward renderer: every point light adds per-fragment shader cost.
       Cap decoration point lights at 12 simultaneous; emissive materials
       still glow when the budget is exhausted, so the scene never looks
       broken — it just stops adding new real lights. Ghost groups (drag
       previews) also draw from the budget and release it on discard. */
    var DECO_LIGHT_CAP = 2;  // Phase 1: max 2 decoration point lights (was 12)
    var decoLightCount = 0;
    function decoLight(g, light) {
      g.userData.decoLights = g.userData.decoLights || 0;
      if (decoLightCount < DECO_LIGHT_CAP) {
        g.add(light);
        g.userData.decoLights++;
        decoLightCount++;
      }
      return light;
    }
    function releaseDecoLights(g) {
      var n = (g.userData && g.userData.decoLights) || 0;
      decoLightCount = Math.max(0, decoLightCount - n);
      if (g.userData) g.userData.decoLights = 0;
    }

    function makeCandle(opts) {
      opts = opts || {};
      var g = new THREE.Group();
      var brass = new THREE.MeshStandardMaterial({ color: 0x9a743d, roughness: 0.45, metalness: 0.7 });
      var saucer = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.27, 0.05, 18), brass);
      saucer.position.y = 0.025; g.add(saucer);
      var b2 = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.165, 0.55, 18),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(opts.tint || '#e9dcc4'), roughness: 0.6 }));
      b2.position.y = 0.325; g.add(b2);
      var wick = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.09, 6),
        new THREE.MeshStandardMaterial({ color: 0x1a1410 }));
      wick.position.y = 0.63; g.add(wick);
      var flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      flame.position.y = 0.78; flame.scale.set(0.24, 0.34, 1); g.add(flame);
      var glow = new THREE.PointLight(new THREE.Color(opts.glow || opts.tint2 || '#ff9a3c'), 14, 11, 1.6);
      glow.position.y = 0.85; decoLight(g, glow);
      g.userData = { decoType: 'candle', fw: 0.55, fd: 0.55, glow: glow, flame: flame, seed: Math.random() * 10 };
      candleFlames.push(g);
      return shadowify(g);
    }

    function makeMug() {
      var g = new THREE.Group();
      var mat = new THREE.MeshStandardMaterial({ color: 0xb5542a, roughness: 0.55 });
      var b2 = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.36, 18), mat);
      b2.position.y = 0.18; g.add(b2);
      var coffee = new THREE.Mesh(new THREE.CircleGeometry(0.165, 18),
        new THREE.MeshStandardMaterial({ color: 0x2e1c10, roughness: 0.35 }));
      coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.362; g.add(coffee);
      var handle = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.032, 10, 20, Math.PI), mat);
      handle.position.set(0.2, 0.19, 0); handle.rotation.z = -Math.PI / 2; g.add(handle);
      g.userData = { decoType: 'mug', fw: 0.6, fd: 0.6 };
      return shadowify(g);
    }

    function makeStack() {
      var g = new THREE.Group();
      var cols = ['#7a4a5a', '#3a5a7a', '#8a6a2a'];
      var sizes = [[1.1, 0.22, 0.8], [0.94, 0.2, 0.74], [1.0, 0.18, 0.7]];
      var y = 0;
      sizes.forEach(function (s, i) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(s[0], s[1], s[2]),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(cols[i]), roughness: 0.8 }));
        m.position.y = y + s[1] / 2; m.rotation.y = (i - 1) * 0.14;
        g.add(m); y += s[1];
      });
      g.userData = { decoType: 'stack', fw: 1.2, fd: 0.9 };
      return shadowify(g);
    }

    var fairyBulbs = [];
    function makeFairyLights(opts) {
      opts = opts || {};
      var g = new THREE.Group();
      var W = 6, pts = [];
      var n = 26;
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        pts.push(new THREE.Vector3(-W / 2 + t * W, -0.28 * Math.sin(Math.PI * t) - 0.04, 0));
      }
      var curve = new THREE.CatmullRomCurve3(pts);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.016, 6),
        new THREE.MeshStandardMaterial({ color: 0x33291d, roughness: 0.9 })));
      var bulbGeo = new THREE.SphereGeometry(0.055, 10, 10);
      var bulbC = new THREE.Color(opts.tint || '#ffd9a0');
      var glowC = new THREE.Color(opts.glow || opts.tint || '#ffb84d');
      pts.forEach(function (p, i) {
        if (i % 2 === 0) return;
        var b = new THREE.Mesh(bulbGeo, new THREE.MeshStandardMaterial({
          color: bulbC, emissive: glowC, emissiveIntensity: 1.7, roughness: 0.4 }));
        b.position.copy(p); b.position.y -= 0.08;
        b.userData.phase = (fairyBulbs.length % 13) * 0.75;   // staggered wave along the string
        g.add(b); fairyBulbs.push(b);
      });
      g.userData = { decoType: 'lights', fw: 6.4, fd: 0.5, edge: true };
      // 3 strategic point lights along the string so bulbs cast real light
      // on nearby books/shelf (one per ~2 bulbs, perf-safe)
      [-2, 0, 2].forEach(function (lx) {
        var pl = new THREE.PointLight(glowC, 5, 5.5, 1.8);
        pl.position.set(lx, -0.15, 0.25);
        decoLight(g, pl);
      });
      return shadowify(g);
    }

    function makeClock(opts) {
      opts = opts || {};
      var g = new THREE.Group();
      var wood = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.7 });
      var frame = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.65, 0.12), wood);
      frame.position.y = 0.325; g.add(frame);
      var face = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24),
        new THREE.MeshStandardMaterial({ color: 0xf2e8d5, roughness: 0.6 }));
      face.position.set(0, 0.35, 0.065); g.add(face);
      var handMat = new THREE.MeshStandardMaterial({ color: 0x2a2018 });
      // variant 'midnight': both hands at 12 for the fête theme
      var hourA = opts.variant === 'midnight' ? 0 : -0.9;
      var minA = opts.variant === 'midnight' ? 0 : 0.5;
      var hourH = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.13, 0.01), handMat);
      hourH.position.set(0, 0.38, 0.07); hourH.rotation.z = hourA; g.add(hourH);
      var minH = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.19, 0.01), handMat);
      minH.position.set(0, 0.40, 0.07); minH.rotation.z = minA; g.add(minH);
      g.userData = { decoType: 'clock', fw: 0.6, fd: 0.3 };
      return shadowify(g);
    }
    function makePhoto() {
      var g = new THREE.Group();
      var frame = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.62, 0.06),
        new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.5, metalness: 0.3 }));
      frame.position.y = 0.31; g.add(frame);
      // canvas "photo": warm gradient with moon circle
      var c = document.createElement('canvas'); c.width = 96; c.height = 120;
      var x2 = c.getContext('2d');
      var gr = x2.createLinearGradient(0, 0, 0, 120);
      gr.addColorStop(0, '#2a3a5a'); gr.addColorStop(1, '#e5b86a');
      x2.fillStyle = gr; x2.fillRect(0, 0, 96, 120);
      x2.fillStyle = '#f6eff8'; x2.beginPath(); x2.arc(68, 32, 14, 0, 7); x2.fill();
      x2.fillStyle = 'rgba(20,14,26,.85)';
      x2.beginPath(); x2.moveTo(0, 120); x2.lineTo(34, 62); x2.lineTo(62, 120); x2.fill();
      x2.beginPath(); x2.moveTo(40, 120); x2.lineTo(72, 74); x2.lineTo(96, 120); x2.fill();
      var tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      var pic = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.52),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
      pic.position.set(0, 0.31, 0.035); g.add(pic);
      var stand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.04), frame.material);
      stand.position.set(0, 0.15, -0.08); stand.rotation.x = 0.35; g.add(stand);
      g.userData = { decoType: 'photo', fw: 0.55, fd: 0.3 };
      return shadowify(g);
    }
    var succLeafTex = leafTexture('#7aaa8a', '#55855f');
    function makeSucculent() {
      var g = new THREE.Group();
      var pot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.28, 12),
        new THREE.MeshStandardMaterial({ color: 0x7a8a9a, roughness: 0.7 }));
      pot.position.y = 0.14; g.add(pot);
      var leafMat = new THREE.MeshStandardMaterial({ map: succLeafTex, transparent: true,
        alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.85 });
      for (var ring = 0; ring < 3; ring++) {
        var nn = 5 + ring * 2, r = 0.05 + ring * 0.055, y = 0.3 + ring * 0.09;
        for (var i = 0; i < nn; i++) {
          var a = (i / nn) * Math.PI * 2 + ring * 0.4;
          var leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.3), leafMat);
          leaf.position.set(Math.cos(a) * r, y + 0.08, Math.sin(a) * r);
          leaf.rotation.y = a;
          leaf.rotation.z = Math.cos(a) * 0.65; leaf.rotation.x = -Math.sin(a) * 0.65;
          g.add(leaf);
        }
      }
      g.userData = { decoType: 'succulent', fw: 0.5, fd: 0.5 };
      return shadowify(g);
    }
    /* unlockable decorations — earned by placing, not bought */
    function makeLantern() {
      var g = new THREE.Group();
      var frame = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.55, metalness: 0.45 });
      var post = new THREE.BoxGeometry(0.05, 0.5, 0.05);
      [[-0.14, -0.14], [0.14, -0.14], [-0.14, 0.14], [0.14, 0.14]].forEach(function (p2) {
        var p = new THREE.Mesh(post, frame); p.position.set(p2[0], 0.32, p2[1]); g.add(p);
      });
      var capT = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.06, 0.38), frame);
      capT.position.y = 0.6; g.add(capT);
      var capB = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.05, 0.38), frame);
      capB.position.y = 0.05; g.add(capB);
      var knob = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 8, 16), frame);
      knob.position.y = 0.66; g.add(knob);
      var glass = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.48, 0.27),
        new THREE.MeshStandardMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.22, roughness: 0.15 }));
      glass.position.y = 0.32; g.add(glass);
      var core = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xffcf7a, emissive: 0xff9a2a, emissiveIntensity: 2.6 }));
      core.position.y = 0.3; g.add(core);
      var gl = new THREE.PointLight(0xff9a3c, 6, 5.5, 1.8);
      gl.position.y = 0.36; decoLight(g, gl);
      g.userData = { decoType: 'lantern', fw: 0.45, fd: 0.45 };
      return shadowify(g);
    }
    function makeGlobe() {
      var g = new THREE.Group();
      var c = document.createElement('canvas'); c.width = 128; c.height = 64;
      var x2 = c.getContext('2d');
      x2.fillStyle = '#2a5a8a'; x2.fillRect(0, 0, 128, 64);
      x2.fillStyle = '#4a7a3a';
      [[30, 20, 13, 7], [70, 36, 17, 9], [102, 18, 9, 6], [52, 50, 11, 5]].forEach(function (q) {
        x2.beginPath(); x2.ellipse(q[0], q[1], q[2], q[3], 0.4, 0, 7); x2.fill();
      });
      var tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      var ball = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 16),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
      ball.position.y = 0.52; ball.rotation.z = 0.41; g.add(ball);
      var standMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.6 });
      var stand = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 0.3, 10), standMat);
      stand.position.y = 0.15; g.add(stand);
      var baseD = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.05, 14), standMat);
      baseD.position.y = 0.025; g.add(baseD);
      g.userData = { decoType: 'globe', fw: 0.62, fd: 0.62 };
      return shadowify(g);
    }
    /* ---- P0 new builds (per-theme catalog) ---- */
    function vasePalette(variant) {
      var D = (window.Shelf3DDecor && Shelf3DDecor.get('vase')) || {};
      var v = (D.variants && D.variants[variant]) || {};
      return { flower: v.flower || '#e5488f', stem: v.stem || '#4a7a3a' };
    }
    function makeVase(opts) {
      opts = opts || {};
      var pal = opts.variant ? vasePalette(opts.variant)
        : { flower: opts.tint || '#e5488f', stem: opts.tint2 || '#4a7a3a' };
      var g = new THREE.Group();
      // lathe vase profile
      var pts = [];
      [[0.001, 0], [0.16, 0], [0.2, 0.06], [0.22, 0.18], [0.15, 0.34], [0.09, 0.42], [0.1, 0.48]]
        .forEach(function (p) { pts.push(new THREE.Vector2(p[0], p[1])); });
      var vase = new THREE.Mesh(new THREE.LatheGeometry(pts, 18),
        new THREE.MeshStandardMaterial({ color: 0x7a8a9a, roughness: 0.35, metalness: 0.1 }));
      g.add(vase);
      var stemMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(pal.stem), roughness: 0.9 });
      var flowerMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(pal.flower), roughness: 0.7 });
      var heads = [[-0.09, 0.78, 0.02], [0.07, 0.88, -0.03], [0.0, 0.98, 0.04], [-0.02, 0.7, -0.06], [0.1, 0.72, 0.05]];
      heads.forEach(function (h, i) {
        var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.42, 6), stemMat);
        stem.position.set(h[0] / 2, 0.62, h[2] / 2);
        stem.rotation.z = -h[0] * 1.4; stem.rotation.x = h[2] * 1.4;
        g.add(stem);
        var bloom = new THREE.Mesh(new THREE.IcosahedronGeometry(0.055 + (i % 2) * 0.015, 0), flowerMat);
        bloom.position.set(h[0], h[1], h[2]);
        g.add(bloom);
      });
      g.userData = { decoType: 'vase', fw: 0.5, fd: 0.5 };
      return shadowify(g);
    }
    function makeMoon(opts) {
      opts = opts || {};
      var g = new THREE.Group();
      // crescent: outer disc with an offset disc hole, extruded thin
      var shape = new THREE.Shape();
      shape.absarc(0, 0, 0.42, 0, Math.PI * 2, false);
      var hole = new THREE.Path();
      hole.absarc(0.17, 0.1, 0.36, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      var geo = new THREE.ExtrudeGeometry(shape, { depth: 0.07, bevelEnabled: false, curveSegments: 28 });
      var moon = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: new THREE.Color(opts.tint || '#dfe8ff'), emissive: new THREE.Color(opts.tint || '#b8ccff'),
        emissiveIntensity: 0.85, roughness: 0.5 }));
      g.add(moon);
      var ml = new THREE.PointLight(0xb8c8ff, 3, 6, 1.8);
      ml.position.set(0, 0, 0.5); decoLight(g, ml);
      g.userData = { decoType: 'moon', fw: 0.9, fd: 0.9 };
      return shadowify(g);
    }
    function starShape(r) {
      var s = new THREE.Shape();
      for (var i = 0; i < 10; i++) {
        var a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        var rr = i % 2 === 0 ? r : r * 0.45;
        var x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
      }
      s.closePath();
      return s;
    }
    function makeStarGarland(opts) {
      opts = opts || {};
      var g = new THREE.Group();
      var W = 5.2, pts = [];
      var n = 22;
      for (var i = 0; i <= n; i++) {
        var t = i / n;
        pts.push(new THREE.Vector3(-W / 2 + t * W, -0.24 * Math.sin(Math.PI * t) - 0.04, 0));
      }
      var curve = new THREE.CatmullRomCurve3(pts);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 36, 0.014, 6),
        new THREE.MeshStandardMaterial({ color: 0x2c2c34, roughness: 0.9 })));
      var starGeo = new THREE.ExtrudeGeometry(starShape(0.075), { depth: 0.03, bevelEnabled: false });
      var glowC = new THREE.Color(opts.glow || opts.tint || '#cfe0ff');
      pts.forEach(function (p, i) {
        if (i % 3 !== 1) return;
        var st = new THREE.Mesh(starGeo, new THREE.MeshStandardMaterial({
          color: 0xe8f0ff, emissive: glowC, emissiveIntensity: 1.9, roughness: 0.4 }));
        st.position.set(p.x - 0.075, p.y - 0.16, -0.015);
        st.userData.phase = (fairyBulbs.length % 11) * 0.9;
        g.add(st); fairyBulbs.push(st);
      });
      g.userData = { decoType: 'stargarland', fw: 5.6, fd: 0.5, edge: true };
      [-1.5, 1.5].forEach(function (lx) {
        var pl = new THREE.PointLight(glowC, 4, 5, 1.8);
        pl.position.set(lx, -0.15, 0.25);
        decoLight(g, pl);
      });
      return shadowify(g);
    }
    function makeGifts(opts) {
      opts = opts || {};
      var g = new THREE.Group();
      var boxC = new THREE.Color(opts.tint || '#d43a55');
      var box2C = new THREE.Color(opts.tint2 || '#2a6a3a');
      var ribC = new THREE.Color(opts.ribbon || '#f2d06a');
      var mk = function (w, h, d, c, x, y, z, ry) {
        var b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
          new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 }));
        b.position.set(x, y, z); b.rotation.y = ry || 0; g.add(b);
        var r1 = new THREE.Mesh(new THREE.BoxGeometry(w + 0.012, h + 0.012, 0.07),
          new THREE.MeshStandardMaterial({ color: ribC, roughness: 0.5 }));
        r1.position.set(x, y, z); r1.rotation.y = ry || 0; g.add(r1);
        var r2 = new THREE.Mesh(new THREE.BoxGeometry(0.07, h + 0.012, d + 0.012),
          new THREE.MeshStandardMaterial({ color: ribC, roughness: 0.5 }));
        r2.position.set(x, y, z); r2.rotation.y = ry || 0; g.add(r2);
      };
      mk(0.62, 0.4, 0.5, boxC, -0.05, 0.2, 0, 0.1);
      mk(0.44, 0.32, 0.4, box2C, 0.02, 0.56, 0.02, -0.14);
      var bow = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.018, 8, 14),
        new THREE.MeshStandardMaterial({ color: ribC, roughness: 0.5 }));
      bow.position.set(0.02, 0.75, 0.02); bow.rotation.x = Math.PI / 2; g.add(bow);
      g.userData = { decoType: 'gifts', fw: 0.75, fd: 0.6 };
      return shadowify(g);
    }
    function makeEggs(opts) {
      opts = opts || {};
      var g = new THREE.Group();
      var pts = [];
      [[0.001, 0], [0.2, 0], [0.3, 0.05], [0.32, 0.12], [0.28, 0.16]]
        .forEach(function (p) { pts.push(new THREE.Vector2(p[0], p[1])); });
      var bowl = new THREE.Mesh(new THREE.LatheGeometry(pts, 16),
        new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.7, side: THREE.DoubleSide }));
      g.add(bowl);
      var cols = opts.tints || ['#f2a3c0', '#b9a3f2', '#a8d8c8'];
      cols.forEach(function (c, i) {
        var e = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: 0.45 }));
        e.scale.y = 1.3;
        e.position.set(-0.14 + i * 0.14, 0.22, (i % 2) * 0.06 - 0.03);
        e.rotation.z = (i - 1) * 0.2;
        g.add(e);
      });
      g.userData = { decoType: 'eggs', fw: 0.7, fd: 0.7 };
      return shadowify(g);
    }
    function makeSnowflake() {
      var g = new THREE.Group();
      var mat = new THREE.MeshStandardMaterial({ color: 0xdfeaf8, emissive: 0x9fc4e8,
        emissiveIntensity: 0.7, roughness: 0.3, metalness: 0.2 });
      for (var i = 0; i < 3; i++) {
        var armG = new THREE.Group();
        var arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.85, 0.035), mat);
        armG.add(arm);
        // small branches near both tips, angled outward
        [0.28, -0.28].forEach(function (y) {
          [0.55, -0.55].forEach(function (a) {
            var br = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.18, 0.03), mat);
            br.position.set(Math.sin(a) * 0.08, y + Math.cos(a) * 0.07, 0);
            br.rotation.z = -a;
            armG.add(br);
          });
        });
        armG.rotation.z = (i / 3) * Math.PI;
        g.add(armG);
      }
      var hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 6), mat);
      hub.rotation.x = Math.PI / 2; g.add(hub);
      g.userData = { decoType: 'snowflake', fw: 0.95, fd: 0.95 };
      return shadowify(g);
    }
    /* ---- P1 new builds ---- */
    function makeCoins() {
      var g = new THREE.Group();
      var gold = new THREE.MeshStandardMaterial({ color: 0xd8a83a, roughness: 0.3, metalness: 0.9 });
      var y = 0;
      for (var i = 0; i < 6; i++) {
        var c = new THREE.Mesh(new THREE.CylinderGeometry(0.16 - (i % 3) * 0.012, 0.16 - (i % 3) * 0.012, 0.055, 16), gold);
        c.position.set(((i * 37) % 5 - 2) * 0.012, y + 0.028, ((i * 53) % 5 - 2) * 0.012);
        g.add(c); y += 0.055;
      }
      g.userData = { decoType: 'coins', fw: 0.42, fd: 0.42 };
      return shadowify(g);
    }
    function makeClover() {
      var g = new THREE.Group();
      var pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.22, 12),
        new THREE.MeshStandardMaterial({ color: 0x8a5a3a, roughness: 0.8 }));
      pot.position.y = 0.11; g.add(pot);
      var leafMat = new THREE.MeshStandardMaterial({ color: 0x2a8a4a, roughness: 0.85, side: THREE.DoubleSide });
      var stemMat = new THREE.MeshStandardMaterial({ color: 0x1f6a38, roughness: 0.9 });
      [[-0.09, 0.42, 0.03], [0.09, 0.46, -0.02], [0.0, 0.54, 0.04], [0.05, 0.38, -0.05]].forEach(function (p) {
        var st = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.24, 6), stemMat);
        st.position.set(p[0] / 2, 0.3, p[2] / 2); st.rotation.z = -p[0] * 2; g.add(st);
        for (var l = 0; l < 3; l++) {
          var leaf = new THREE.Mesh(new THREE.CircleGeometry(0.055, 10), leafMat);
          var a = (l / 3) * Math.PI * 2;
          leaf.position.set(p[0] + Math.cos(a) * 0.05, p[1], p[2] + Math.sin(a) * 0.05);
          leaf.rotation.x = -Math.PI / 2 + 0.5;
          leaf.rotation.z = a;
          g.add(leaf);
        }
      });
      g.userData = { decoType: 'clover', fw: 0.45, fd: 0.45 };
      return shadowify(g);
    }
    function makeAppleBowl() {
      var g = new THREE.Group();
      var pts = [];
      [[0.001, 0], [0.24, 0], [0.36, 0.06], [0.38, 0.16], [0.34, 0.2]]
        .forEach(function (p) { pts.push(new THREE.Vector2(p[0], p[1])); });
      var bowl = new THREE.Mesh(new THREE.LatheGeometry(pts, 18),
        new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.65, side: THREE.DoubleSide }));
      g.add(bowl);
      var appleCols = [0xc0392b, 0xd43a55, 0xa83232];
      appleCols.forEach(function (c, i) {
        var a = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12),
          new THREE.MeshStandardMaterial({ color: c, roughness: 0.35 }));
        a.position.set(-0.15 + i * 0.15, 0.26, (i % 2) * 0.08 - 0.04);
        g.add(a);
        var st = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6),
          new THREE.MeshStandardMaterial({ color: 0x4a3a22, roughness: 0.9 }));
        st.position.set(a.position.x, 0.37, a.position.z); g.add(st);
      });
      g.userData = { decoType: 'applebowl', fw: 0.85, fd: 0.85 };
      return shadowify(g);
    }

    /* ---- v423: premium theme pack builders (procedural, same style) ---- */
    /* Stormrider */
    function makeDragonEgg() {
      var g = new THREE.Group();
      var shell = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 16),
        new THREE.MeshStandardMaterial({ color: 0x3a4a6a, roughness: 0.35, metalness: 0.25 }));
      shell.scale.set(1, 1.3, 1); shell.position.y = 0.39; g.add(shell);
      var arcMat = new THREE.MeshStandardMaterial({ color: 0x7fb3e8, roughness: 0.4, metalness: 0.3 });
      for (var r = 0; r < 3; r++) {
        for (var i = 0; i < 6; i++) {
          var a = (i / 6) * Math.PI * 2 + r * 0.5;
          var arc = new THREE.Mesh(new THREE.TorusGeometry(0.16 - r * 0.03, 0.018, 6, 12, Math.PI * 0.9), arcMat);
          arc.position.set(Math.cos(a) * 0.2, 0.28 + r * 0.16, Math.sin(a) * 0.2);
          arc.rotation.set(Math.PI / 2 + 0.4, 0, -a);
          g.add(arc);
        }
      }
      var bolt = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.22),
        new THREE.MeshBasicMaterial({ color: 0xe8a94e, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
      bolt.position.set(0.08, 0.5, 0.26); bolt.rotation.z = 0.2; g.add(bolt);
      g.userData = { decoType: 'dragon-egg', fw: 0.7, fd: 0.7 };
      return shadowify(g);
    }
    function makeStormLantern() {
      var g = new THREE.Group();
      var frame = new THREE.MeshStandardMaterial({ color: 0x1c1c28, roughness: 0.5, metalness: 0.6 });
      [[-0.12, -0.12], [0.12, -0.12], [-0.12, 0.12], [0.12, 0.12]].forEach(function (p2) {
        var p = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.46, 0.045), frame);
        p.position.set(p2[0], 0.3, p2[1]); g.add(p);
      });
      var capT = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.34), frame);
      capT.position.y = 0.56; g.add(capT);
      var capB = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.34), frame);
      capB.position.y = 0.025; g.add(capB);
      var glass = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.44, 0.24),
        new THREE.MeshStandardMaterial({ color: 0x9ab8d8, transparent: true, opacity: 0.25, roughness: 0.1 }));
      glass.position.y = 0.3; g.add(glass);
      var boltMat = new THREE.MeshStandardMaterial({ color: 0xe8a94e, emissive: 0xe8a94e, emissiveIntensity: 2.4 });
      var bolt = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.26), boltMat);
      bolt.position.y = 0.3; g.add(bolt);
      var bolt2 = bolt.clone(); bolt2.rotation.y = Math.PI / 2; g.add(bolt2);
      var gl = new THREE.PointLight(0xe8a94e, 5, 5, 1.8);
      gl.position.y = 0.34; decoLight(g, gl);
      g.userData = { decoType: 'storm-lantern', fw: 0.42, fd: 0.42 };
      return shadowify(g);
    }
    function makeRiderBlade() {
      var g = new THREE.Group();
      var steel = new THREE.MeshStandardMaterial({ color: 0xb8c4d4, roughness: 0.25, metalness: 0.85 });
      var blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.52, 0.02), steel);
      blade.position.y = 0.52; g.add(blade);
      var tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 4), steel);
      tip.position.y = 0.84; tip.rotation.y = Math.PI / 4; g.add(tip);
      var wingMat = new THREE.MeshStandardMaterial({ color: 0x7fb3e8, roughness: 0.4, metalness: 0.5 });
      [-1, 1].forEach(function (s) {
        var wing = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.03), wingMat);
        wing.position.set(s * 0.16, 0.28, 0); wing.rotation.z = s * 0.5; g.add(wing);
      });
      var grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.16, 10),
        new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 }));
      grip.position.y = 0.16; g.add(grip);
      var pommel = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), wingMat);
      pommel.position.y = 0.05; g.add(pommel);
      g.userData = { decoType: 'rider-blade', fw: 0.7, fd: 0.2 };
      return shadowify(g);
    }
    /* Briarthrone */
    function makeThornCrown() {
      var g = new THREE.Group();
      var band = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.045, 10, 24),
        new THREE.MeshStandardMaterial({ color: 0x8a6a5a, roughness: 0.7 }));
      band.rotation.x = Math.PI / 2; band.position.y = 0.3; g.add(band);
      var thornMat = new THREE.MeshStandardMaterial({ color: 0x6a4a3a, roughness: 0.75 });
      for (var i = 0; i < 8; i++) {
        var a = (i / 8) * Math.PI * 2;
        var thorn = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.22 + (i % 3) * 0.05, 8), thornMat);
        thorn.position.set(Math.cos(a) * 0.26, 0.42, Math.sin(a) * 0.26);
        thorn.rotation.z = -Math.cos(a) * 0.25; thorn.rotation.x = Math.sin(a) * 0.25;
        g.add(thorn);
      }
      var gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.05),
        new THREE.MeshStandardMaterial({ color: 0xe0637f, emissive: 0xe0637f, emissiveIntensity: 1.2, roughness: 0.2 }));
      gem.position.set(0, 0.32, 0.28); g.add(gem);
      g.userData = { decoType: 'thorn-crown', fw: 0.65, fd: 0.65 };
      return shadowify(g);
    }
    function makeMoonGoblet() {
      var g = new THREE.Group();
      var pts = [];
      [[0.001, 0], [0.2, 0], [0.24, 0.02], [0.2, 0.3], [0.14, 0.34], [0.13, 0.5]]
        .forEach(function (p) { pts.push(new THREE.Vector2(p[0], p[1])); });
      var cup = new THREE.Mesh(new THREE.LatheGeometry(pts, 18),
        new THREE.MeshStandardMaterial({ color: 0x4a3a5a, roughness: 0.3, metalness: 0.7, side: THREE.DoubleSide }));
      cup.position.y = 0.14; g.add(cup);
      var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8),
        new THREE.MeshStandardMaterial({ color: 0x4a3a5a, roughness: 0.3, metalness: 0.7 }));
      stem.position.y = 0.07; g.add(stem);
      var moon = new THREE.Mesh(new THREE.CircleGeometry(0.09, 20),
        new THREE.MeshStandardMaterial({ color: 0xdfe8ff, emissive: 0xb8c8ff, emissiveIntensity: 0.8 }));
      moon.position.set(0, 0.42, 0.16); g.add(moon);
      var bite = new THREE.Mesh(new THREE.CircleGeometry(0.075, 20),
        new THREE.MeshStandardMaterial({ color: 0x4a3a5a, roughness: 0.3, metalness: 0.7 }));
      bite.position.set(0.035, 0.44, 0.165); g.add(bite);
      g.userData = { decoType: 'moon-goblet', fw: 0.5, fd: 0.5 };
      return shadowify(g);
    }
    function makeNightBloom() {
      var g = new THREE.Group();
      var petalMat = new THREE.MeshStandardMaterial({ color: 0xc9b3f5, roughness: 0.6, side: THREE.DoubleSide });
      var petalMat2 = new THREE.MeshStandardMaterial({ color: 0x9a7fd4, roughness: 0.6, side: THREE.DoubleSide });
      for (var ring = 0; ring < 2; ring++) {
        var n = 6, r = 0.22 - ring * 0.07, y = 0.42 + ring * 0.06;
        for (var i = 0; i < n; i++) {
          var a = (i / n) * Math.PI * 2 + ring * 0.5;
          var petal = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.24), ring ? petalMat2 : petalMat);
          petal.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
          petal.rotation.y = -a + Math.PI / 2; petal.rotation.x = -0.5;
          g.add(petal);
        }
      }
      var heart = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xe0637f, emissive: 0xe0637f, emissiveIntensity: 1.0 }));
      heart.position.y = 0.46; g.add(heart);
      var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.4, 8),
        new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 0.9 }));
      stem.position.y = 0.2; g.add(stem);
      var leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.07), petalMat2);
      leaf.position.set(0.1, 0.28, 0); leaf.rotation.z = -0.5; leaf.rotation.y = 0.4; g.add(leaf);
      g.userData = { decoType: 'night-bloom', fw: 0.6, fd: 0.6 };
      return shadowify(g);
    }
    /* Voidsignal */
    function makeHoloCube() {
      var g = new THREE.Group();
      var s = 0.3;
      var edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(s, s, s));
      g.add(new THREE.LineSegments(edges,
        new THREE.LineBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.9 })));
      var core = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12),
        new THREE.MeshStandardMaterial({ color: 0x38e1ff, emissive: 0x38e1ff, emissiveIntensity: 2.2 }));
      core.position.y = 0; g.add(core);
      var nodeMat = new THREE.MeshBasicMaterial({ color: 0x38e1ff });
      [[-s/2,-s/2,-s/2],[s/2,-s/2,-s/2],[-s/2,s/2,-s/2],[s/2,s/2,-s/2],
       [-s/2,-s/2,s/2],[s/2,-s/2,s/2],[-s/2,s/2,s/2],[s/2,s/2,s/2]].forEach(function (p) {
        var nd = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), nodeMat);
        nd.position.set(p[0], p[1], p[2]); g.add(nd);
      });
      var holder = new THREE.Group(); holder.add(g);
      var inner = new THREE.Group();
      while (g.children.length) inner.add(g.children[0]);
      holder.add(inner); inner.position.y = 0.42;
      var base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.06, 14),
        new THREE.MeshStandardMaterial({ color: 0x1a2a34, roughness: 0.5, metalness: 0.6 }));
      base.position.y = 0.03; holder.add(base);
      var gl = new THREE.PointLight(0x38e1ff, 4, 4.5, 1.8);
      gl.position.y = 0.42; decoLight(holder, gl);
      holder.userData = { decoType: 'holo-cube', fw: 0.5, fd: 0.5 };
      return shadowify(holder);
    }
    function makeSignalDish() {
      var g = new THREE.Group();
      var dishMat = new THREE.MeshStandardMaterial({ color: 0x3a4a5a, roughness: 0.4, metalness: 0.6, side: THREE.DoubleSide });
      var dish = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.35), dishMat);
      dish.rotation.x = Math.PI * 0.72; dish.position.y = 0.52; g.add(dish);
      var arm = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), dishMat);
      arm.position.set(0, 0.52, 0.12); arm.rotation.x = 0.9; g.add(arm);
      var tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x38e1ff, emissive: 0x38e1ff, emissiveIntensity: 2.0 }));
      tip.position.set(0, 0.62, 0.24); g.add(tip);
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.4, 10), dishMat);
      pole.position.y = 0.2; g.add(pole);
      var base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.06, 14), dishMat);
      base.position.y = 0.03; g.add(base);
      g.userData = { decoType: 'signal-dish', fw: 0.65, fd: 0.65 };
      return shadowify(g);
    }
    function makeDataCore() {
      var g = new THREE.Group();
      var shellMat = new THREE.MeshStandardMaterial({ color: 0x1a2a34, roughness: 0.35, metalness: 0.7, transparent: true, opacity: 0.55 });
      var tube = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.55, 18, 1, true), shellMat);
      tube.position.y = 0.36; g.add(tube);
      var capMat = new THREE.MeshStandardMaterial({ color: 0x2a3a44, roughness: 0.4, metalness: 0.7 });
      var capT = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.06, 18), capMat);
      capT.position.y = 0.66; g.add(capT);
      var capB = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.25, 0.06, 18), capMat);
      capB.position.y = 0.03; g.add(capB);
      for (var i = 0; i < 3; i++) {
        var ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.018, 8, 24),
          new THREE.MeshStandardMaterial({ color: 0x38e1ff, emissive: 0x38e1ff, emissiveIntensity: 2.0 }));
        ring.rotation.x = Math.PI / 2; ring.position.y = 0.22 + i * 0.14; g.add(ring);
      }
      var gl = new THREE.PointLight(0x38e1ff, 4, 4.5, 1.8);
      gl.position.y = 0.4; decoLight(g, gl);
      g.userData = { decoType: 'data-core', fw: 0.55, fd: 0.55 };
      return shadowify(g);
    }
    /* Wisp */
    function makeMushroomCottage() {
      var g = new THREE.Group();
      var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.42, 14),
        new THREE.MeshStandardMaterial({ color: 0xf7ecd8, roughness: 0.8 }));
      stem.position.y = 0.21; g.add(stem);
      var cap = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
        new THREE.MeshStandardMaterial({ color: 0xe86a92, roughness: 0.6 }));
      cap.position.y = 0.42; g.add(cap);
      var spotMat = new THREE.MeshStandardMaterial({ color: 0xfdf6ec, roughness: 0.7 });
      [[0.12, 0.62, 0.2], [-0.15, 0.58, 0.18], [0, 0.68, -0.15]].forEach(function (p) {
        var sp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), spotMat);
        sp.position.set(p[0], p[1], p[2]); sp.scale.y = 0.5; g.add(sp);
      });
      var door = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.8 }));
      door.position.set(0, 0.18, 0.235); g.add(door);
      var knob = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8),
        new THREE.MeshStandardMaterial({ color: 0xffd76a, emissive: 0xffd76a, emissiveIntensity: 1.0 }));
      knob.position.set(0.045, 0.18, 0.245); g.add(knob);
      g.userData = { decoType: 'mushroom-cottage', fw: 0.75, fd: 0.75 };
      return shadowify(g);
    }
    function makeFireflyJar() {
      var g = new THREE.Group();
      var glass = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.17, 0.44, 16),
        new THREE.MeshStandardMaterial({ color: 0xd8e4e8, transparent: true, opacity: 0.3, roughness: 0.1 }));
      glass.position.y = 0.26; g.add(glass);
      var lidMat = new THREE.MeshStandardMaterial({ color: 0x8a7a68, roughness: 0.7 });
      var lid = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 16), lidMat);
      lid.position.y = 0.5; g.add(lid);
      var base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.19, 0.04, 16), lidMat);
      base.position.y = 0.02; g.add(base);
      var flyMat = new THREE.MeshStandardMaterial({ color: 0xffd76a, emissive: 0xffd76a, emissiveIntensity: 2.6 });
      [[0.06, 0.3, 0.05], [-0.07, 0.22, -0.03], [0.02, 0.38, -0.06], [-0.04, 0.33, 0.08]].forEach(function (p) {
        var f = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), flyMat);
        f.position.set(p[0], p[1], p[2]); g.add(f);
        var halo = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.25 }));
        halo.position.copy(f.position); g.add(halo);
      });
      var gl = new THREE.PointLight(0xffd76a, 5, 4.5, 1.8);
      gl.position.y = 0.3; decoLight(g, gl);
      g.userData = { decoType: 'firefly-jar', fw: 0.45, fd: 0.45 };
      return shadowify(g);
    }
    function makeWispLantern() {
      var g = new THREE.Group();
      var paper = new THREE.Mesh(new THREE.SphereGeometry(0.26, 18, 14),
        new THREE.MeshStandardMaterial({ color: 0xfdf6ec, roughness: 0.9, transparent: true, opacity: 0.92 }));
      paper.scale.y = 0.85; paper.position.y = 0.42; g.add(paper);
      var starMat = new THREE.MeshStandardMaterial({ color: 0xe86a92, emissive: 0xe86a92, emissiveIntensity: 1.4 });
      for (var i = 0; i < 5; i++) {
        var a = (i / 5) * Math.PI * 2;
        var star = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), starMat);
        star.position.set(Math.cos(a) * 0.2, 0.42 + Math.sin(i * 2.3) * 0.1, Math.sin(a) * 0.2);
        star.lookAt(0, 0.42, 0); star.rotateY(Math.PI);
        g.add(star);
      }
      var ribMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc8, roughness: 0.8 });
      for (var r = 0; r < 3; r++) {
        var rib = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.008, 6, 24), ribMat);
        rib.rotation.x = Math.PI / 2; rib.scale.y = 0.85;
        rib.position.y = 0.32 + r * 0.1; g.add(rib);
      }
      var cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.05, 10), ribMat);
      cap.position.y = 0.66; g.add(cap);
      var tassel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.14, 6), ribMat);
      tassel.position.y = 0.1; g.add(tassel);
      var gl = new THREE.PointLight(0xffe0a0, 4, 4.5, 1.8);
      gl.position.y = 0.42; decoLight(g, gl);
      g.userData = { decoType: 'wisp-lantern', fw: 0.6, fd: 0.6 };
      return shadowify(g);
    }

    var DECO_MAKERS = { plant: makePlant, candle: makeCandle, mug: makeMug, stack: makeStack,
      lights: makeFairyLights, clock: makeClock, photo: makePhoto, succulent: makeSucculent,
      lantern: makeLantern, globe: makeGlobe, vase: makeVase, stargarland: makeStarGarland,
      gifts: makeGifts, eggs: makeEggs, coins: makeCoins, clover: makeClover,
      applebowl: makeAppleBowl,
      /* v423: premium packs */
      dragonEgg: makeDragonEgg, stormLantern: makeStormLantern, riderBlade: makeRiderBlade,
      thornCrown: makeThornCrown, moonGoblet: makeMoonGoblet, nightBloom: makeNightBloom,
      holoCube: makeHoloCube, signalDish: makeSignalDish, dataCore: makeDataCore,
      mushroomCottage: makeMushroomCottage, fireflyJar: makeFireflyJar, wispLantern: makeWispLantern };

    /* v439: catalog id -> maker function. The v424 pack decorations have
       hyphenated catalog ids but camelCase DECO_MAKERS keys, linked by the
       catalog `build` field (which nothing consumed until now). Falls back
       to the raw id so un-catalogued types keep working. */
    function decoMakerFor(type) {
      var key = type;
      var D = (typeof window.Shelf3DDecor !== 'undefined') ? window.Shelf3DDecor : null;
      var def = D ? D.get(type) : null;
      if (def && def.build) key = def.build;
      return DECO_MAKERS[key] || null;
    }

    /* ============================== placement ============================== */
    var placed = [];   // {group, pi, rec, type} or {group, room:true, anchor, type}

    /* drop zones: invisible boxes over each plank for raycast snapping */
    var zones = LEVELS.map(function (topY, pi) {
      var z = new THREE.Mesh(new THREE.BoxGeometry(SHELF_W + 0.6, 0.9, PLANK_D + 1.2),
        new THREE.MeshBasicMaterial({ visible: false }));
      z.position.set(0, topY + 0.25, 0);
      z.userData.pi = pi;
      scene.add(z);
      return z;
    });
    var snapGuide = new THREE.Mesh(new THREE.BoxGeometry(1, 0.06, 1),
      new THREE.MeshBasicMaterial({ color: 0xe5b86a, transparent: true, opacity: 0.38, depthWrite: false }));
    snapGuide.visible = false; scene.add(snapGuide);
    /* v442: shelf drop-target highlights — shown while an item is picked up or dragged */
    var zoneHL = LEVELS.map(function (topY) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(SHELF_W, 0.6),
        new THREE.MeshBasicMaterial({ color: 0xe5b86a, transparent: true, opacity: 0.22,
          depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, topY + 0.05, 0);
      m.visible = false;
      scene.add(m);
      return m;
    });
    function highlightZones(on) {
      zoneHL.forEach(function (m) { m.visible = !!on; });
      markDirty();
    }
    /* blob shadow under the dragged item — tightens as it lands */
    var blobShadow = (function () {
      var c = document.createElement('canvas'); c.width = c.height = 64;
      var g = c.getContext('2d');
      var gr = g.createRadialGradient(32, 32, 4, 32, 32, 30);
      gr.addColorStop(0, 'rgba(0,0,0,.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
      var t = new THREE.CanvasTexture(c);
      var m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m);
      return m;
    })();

    function findFreeSpot(pi, x, fw) {
      var minX = -SHELF_W / 2 + 0.45 + fw / 2, maxX = SHELF_W / 2 - 0.45 - fw / 2;
      x = THREE.MathUtils.clamp(x, minX, maxX);
      var occ = occupied[pi].slice().sort(function (a, b) { return a[0] - b[0]; });
      for (var off = 0; off <= SHELF_W; off += 0.15) {
        var cands = [x + off, x - off];
        for (var ci = 0; ci < cands.length; ci++) {
          var sx = cands[ci];
          if (sx < minX || sx > maxX) continue;
          var a = sx - fw / 2 - 0.07, b = sx + fw / 2 + 0.07;
          var blocked = occ.some(function (o) { return a < o[1] && b > o[0]; });
          if (!blocked) return sx;
        }
      }
      return x;
    }
    function registerSpot(pi, x, fw) {
      var rec = [x - fw / 2, x + fw / 2];
      occupied[pi].push(rec);
      return rec;
    }
    /* placements consume inventory — every placement path funnels through
       placeDeco/placeRoomDeco, so owned counts always decrement. `free`
       skips the count for preset items. */
    function consumeInventory(type) {
      var inv = null;
      INVENTORY.forEach(function (i) { if (i.type === type) inv = i; });
      if (inv && inv.owned > 0) { inv.owned--; }
      buildInventory();
    }
    function placeDeco(type, pi, x, free, opts) {
      /* v439: resolve the catalog build key — v424 pack decorations use
         hyphenated ids ('holo-cube') while DECO_MAKERS is keyed by the
         catalog `build` name ('holoCube'). Without this, placing any of
         the 12 pack decorations throws "DECO_MAKERS[type] is not a function". */
      var maker = decoMakerFor(type);
      if (!maker) throw new Error('Unknown decoration: ' + type);
      var g = maker(opts || {});
      var fw = g.userData.fw;
      x = findFreeSpot(pi, x, fw);
      if (g.userData.edge) {
        g.position.set(x, LEVELS[pi] + 0.06, PLANK_D / 2 - 0.4);
      } else {
        g.position.set(x, LEVELS[pi], 0.1);
      }
      g.scale.setScalar(0.01);   // 220ms ease-out-back pop on place
      scene.add(g);
      var rec = registerSpot(pi, x, fw);
      placed.push({ group: g, pi: pi, rec: rec, type: type, opts: opts || null });
      tween(220, function (k) { g.scale.setScalar(Math.max(0.01, easeOutBack(k))); });
      if (!free) consumeInventory(type);
      sfx('place');
      return g;
    }
    function removeDeco(g) {
      var i = -1;
      placed.forEach(function (p, idx) { if (p.group === g) i = idx; });
      if (i >= 0) {
        var p = placed.splice(i, 1)[0];
        if (p.room) { if (p.anchor) p.anchor.usedBy = null; }
        else { var oi = occupied[p.pi].indexOf(p.rec); if (oi >= 0) occupied[p.pi].splice(oi, 1); }
      }
      var ci = candleFlames.indexOf(g);
      if (ci >= 0) candleFlames.splice(ci, 1);
      releaseDecoLights(g);
      g.traverse(function (o) {
        if (o.isMesh && o.material && o.material.emissive) {
          var bi = fairyBulbs.indexOf(o); if (bi >= 0) fairyBulbs.splice(bi, 1);
        }
      });
      scene.remove(g);
      disposeDeep(g);
      deselect();
    }
    function clearDecos() { placed.slice().forEach(function (p) { removeDeco(p.group); }); }

    /* ============================== room decorations ==============================
       Placed freely anywhere in the room (not on planks): Halloween spiderweb +
       pumpkin — pairs with the app's seasonal themes. */
    function makeWeb() {
      var g = new THREE.Group();
      var pts = [];
      var R = 0.95, spokes = 8, rings = 4;
      for (var s = 0; s < spokes; s++) {
        var a = (s / spokes) * Math.PI * 2;
        pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
      }
      for (var r = 1; r <= rings; r++) {
        var rr = (r / rings) * R;
        for (var s2 = 0; s2 < spokes; s2++) {
          var a0 = (s2 / spokes) * Math.PI * 2, a1 = ((s2 + 1) / spokes) * Math.PI * 2;
          var sag = 0.05 * rr * Math.sin(((s2 + 0.5) / spokes) * Math.PI * 2);
          pts.push(new THREE.Vector3(Math.cos(a0) * rr, Math.sin(a0) * rr - sag, 0),
                   new THREE.Vector3(Math.cos(a1) * rr, Math.sin(a1) * rr - sag, 0));
        }
      }
      pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, R + 0.55, 0)); // hanging thread
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xe8ecf4, transparent: true, opacity: 0.55 })));
      var spider = new THREE.Group();
      spider.add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10),
        new THREE.MeshStandardMaterial({ color: 0x1c1420, roughness: 0.7 })));
      var legMat = new THREE.MeshBasicMaterial({ color: 0x1c1420 });
      for (var i = 0; i < 8; i++) {
        var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.17, 4), legMat);
        var la = (i / 8) * Math.PI * 2;
        leg.position.set(Math.cos(la) * 0.1, -0.01, Math.sin(la) * 0.1);
        leg.rotation.z = Math.cos(la) * 1.15; leg.rotation.x = -Math.sin(la) * 1.15;
        spider.add(leg);
      }
      spider.position.set(0.32, -0.38, 0.03);
      g.add(spider);
      g.userData = { decoType: 'web', room: true };
      return g;
    }
    function makePumpkin() {
      var g = new THREE.Group();
      var bodyP = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14),
        new THREE.MeshStandardMaterial({ color: 0xc25a1e, roughness: 0.65 }));
      bodyP.scale.y = 0.78; bodyP.position.y = 0.33; g.add(bodyP);
      var ridgeMat = new THREE.MeshStandardMaterial({ color: 0x9c4413, roughness: 0.7 });
      for (var i = 0; i < 6; i++) {
        var r = new THREE.Mesh(new THREE.TorusGeometry(0.415, 0.03, 8, 24), ridgeMat);
        r.position.y = 0.33; r.scale.y = 0.78; r.rotation.y = (i / 6) * Math.PI;
        g.add(r);
      }
      var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.22, 8),
        new THREE.MeshStandardMaterial({ color: 0x4a5a2a, roughness: 0.9 }));
      stem.position.y = 0.7; stem.rotation.z = 0.15; g.add(stem);
      g.userData = { decoType: 'pumpkin', room: true };
      return shadowify(g);
    }
    var ROOM_MAKERS = { web: makeWeb, pumpkin: makePumpkin, moon: makeMoon, snowflake: makeSnowflake };
    var ROOM_ANCHORS = [
      { id: 'webL', types: ['web'], pos: new THREE.Vector3(-SHELF_W / 2 - 0.4, TOP_Y - 1.1, 0.7) },
      { id: 'webR', types: ['web'], pos: new THREE.Vector3(SHELF_W / 2 + 0.4, TOP_Y - 1.1, 0.7) },
      { id: 'floorL', types: ['pumpkin'], pos: new THREE.Vector3(-SHELF_W / 2 - 2.0, 0, 1.5) },
      { id: 'floorR', types: ['pumpkin'], pos: new THREE.Vector3(SHELF_W / 2 + 2.0, 0, 1.5) },
      { id: 'moonC', types: ['moon'], pos: new THREE.Vector3(SHELF_W / 2 - 0.8, TOP_Y - 2.2, WALL_Z + 0.1) },
      { id: 'flakeC', types: ['snowflake'], pos: new THREE.Vector3(-SHELF_W / 2 + 0.8, TOP_Y - 2.6, WALL_Z + 0.1) }
    ];
    ROOM_ANCHORS.forEach(function (a) { a.usedBy = null; });
    function placeRoomDeco(type, pos, anchor, free, opts) {
      var g = ROOM_MAKERS[type](opts || {});
      g.position.copy(pos);
      g.scale.setScalar(0.01);   // 220ms ease-out-back pop on place
      scene.add(g);
      tween(220, function (k) { g.scale.setScalar(Math.max(0.01, easeOutBack(k))); });
      if (anchor) anchor.usedBy = g;
      placed.push({ group: g, room: true, anchor: anchor || null, type: type, opts: opts || null });
      if (!free) consumeInventory(type); else buildInventory();
      setHint(DEFAULT_HINT);
      select(g);
      sfx('place');
      return g;
    }
    /* Pumpkin-under-shelf fix: clamp a floor position into FLOOR_BOUNDS and
       push it out of the bookcase footprint, so a dropped pumpkin can never
       end up hidden under the shelves or outside the visible floor. */
    function clampFloorPos(v) {
      v.x = THREE.MathUtils.clamp(v.x, FLOOR_BOUNDS.minX, FLOOR_BOUNDS.maxX);
      v.z = THREE.MathUtils.clamp(v.z, FLOOR_BOUNDS.minZ, FLOOR_BOUNDS.maxZ);
      var f = SHELF_FOOTPRINT;
      if (v.x > f.minX && v.x < f.maxX && v.z > f.minZ && v.z < f.maxZ) {
        var dxl = v.x - f.minX, dxr = f.maxX - v.x;
        var dzl = v.z - f.minZ, dzr = f.maxZ - v.z;
        var m = Math.min(dxl, dxr, dzl, dzr);
        if (m === dzl) v.z = f.minZ;
        else if (m === dzr) v.z = f.maxZ;
        else if (m === dxl) v.x = f.minX;
        else v.x = f.maxX;
        v.x = THREE.MathUtils.clamp(v.x, FLOOR_BOUNDS.minX, FLOOR_BOUNDS.maxX);
        v.z = THREE.MathUtils.clamp(v.z, FLOOR_BOUNDS.minZ, FLOOR_BOUNDS.maxZ);
      }
      return v;
    }
    /* free placement — the drop point is used directly, per decoration type:
       floor items sit on the floor (clamped, never under the bookcase),
       wall items stick to the wall (back panel plane). */
    var ROOM_WALL_TYPES = ['web', 'moon', 'snowflake'];
    function roomDropPos(type, x, y, z) {
      if (type === 'pumpkin') {
        return clampFloorPos(new THREE.Vector3(x, 0, z));
      }
      // wall: pin to the wall plane, facing outward; keep within the panel bounds
      return new THREE.Vector3(THREE.MathUtils.clamp(x, -5.3, 5.3),
        THREE.MathUtils.clamp(y, 1, 7.6), WALL_Z + 0.05);
    }
    function discardGhost(g) {
      var ci = candleFlames.indexOf(g);
      if (ci >= 0) candleFlames.splice(ci, 1);
      releaseDecoLights(g);
      var keep = [];
      g.traverse(function (o) { if (o.isMesh && fairyBulbs.indexOf(o) >= 0) keep.push(o); });
      keep.forEach(function (o) { fairyBulbs.splice(fairyBulbs.indexOf(o), 1); });
      scene.remove(g);
      disposeDeep(g);
    }

    /* ============================== inventory ============================== */
    /* v442: gesture disambiguation (replaces pressHoldToDrag — no hold timer).
       Tiles live in a single horizontal row with touch-action:pan-x, so
       horizontal swipes scroll the row natively (the browser takes the
       gesture and we get pointercancel). A vertical drag picks the item up
       instantly and starts a 3D drag. Tap/click = pick up for tap-to-place.
       Mouse: drag starts after ~6px of movement; a plain click = pick up. */
    function bindTileGestures(el, item) {
      var sx = 0, sy = 0, live = false, decided = false, pid = null;
      function reset() { live = false; decided = false; pid = null; }
      el.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        sx = e.clientX; sy = e.clientY; live = true; decided = false; pid = e.pointerId;
      });
      el.addEventListener('pointermove', function (e) {
        if (!live || decided || e.pointerId !== pid) return;
        var dx = e.clientX - sx, dy = e.clientY - sy;
        var ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax > 12 && ax > ay * 1.4) { decided = true; return; }  // horizontal: let it scroll
        var thresh = (e.pointerType === 'mouse') ? 6 : 10;
        if (ay > thresh && ay > ax) {
          decided = true;
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          if (item.room) startRoomDrag(e, item, el); else startInvDrag(e, item, el);
          return;
        }
        if (Math.hypot(dx, dy) > 16) decided = true;  // diagonal drift: treat as scroll
      });
      el.addEventListener('pointerup', function (e) {
        if (!live || e.pointerId !== pid) return;
        var wasTap = !decided;
        reset();
        if (wasTap) pickUp(item);
      });
      el.addEventListener('pointercancel', function () { reset(); });
      el.addEventListener('lostpointercapture', function () { cancelActiveDrag(); });
    }
    /* inventory lookup by catalog id */
    function invByType(type) {
      var found = null;
      INVENTORY.forEach(function (i) { if (i.type === type) found = i; });
      return found;
    }
    function firstFreeAnchor(type) {
      var a = null;
      ROOM_ANCHORS.forEach(function (x) {
        if (!a && x.types.indexOf(type) >= 0 && !x.usedBy) a = x;
      });
      return a;
    }
    function restoreInventory(type) {
      var inv = invByType(type);
      if (inv) inv.owned++;
      buildInventory();
    }
    /* slim placing bar: "Placing: X. Tap a shelf" + Cancel, or "Placed X." + Put back */
    var pendingUndo = null;   // {type, name, group}
    function showPlacingBar(item) {
      $('s3dPlaceMsg').innerHTML = 'Placing: <b>' + esc(item.name) + '</b> &middot; tap a shelf to place';
      $('s3dPlaceUndo').style.display = 'none';
      $('s3dPlaceCancel').style.display = '';
      $('s3dPlaceBar').classList.add('show');
      highlightZones(true);
    }
    function showUndoBar(item, group) {
      pendingUndo = { type: item.type, name: item.name, group: group };
      $('s3dPlaceMsg').innerHTML = 'Placed <b>' + esc(item.name) + '</b>';
      $('s3dPlaceCancel').style.display = 'none';
      $('s3dPlaceUndo').style.display = '';
      $('s3dPlaceBar').classList.add('show');
      highlightZones(false);
    }
    function hidePlaceBar() {
      $('s3dPlaceBar').classList.remove('show');
      highlightZones(false);
      pendingUndo = null;
    }
    function clearUndo() { if (pendingUndo) hidePlaceBar(); }
    /* tap on a tile = pick up for tap-to-place (panel closes, shelves stay visible) */
    function pickUp(item) {
      clearUndo();
      deselect();
      pickedType = item.type;
      closeInventory();
      showPlacingBar(item);
      setHint(item.room ? 'Tap the room to place the ' + item.name.toLowerCase()
                        : 'Tap a shelf to place the ' + item.name.toLowerCase());
    }
    /* shared post-placement: select + undo bar so a mistake costs one tap */
    function afterPlace(item, group) {
      if (!item || !group) return;
      pickedType = null;
      select(group);
      showUndoBar(item, group);
      setHint(DEFAULT_HINT);
    }
    /* cancel any in-flight drag: discard ghost, clear state (inventory is only
       consumed on drop, so no stock to restore) */
    function cancelActiveDrag() {
      var had = false;
      if (trayDrag) { discardGhost(trayDrag.group); trayDrag = null; had = true; }
      if (roomDrag) { discardGhost(roomDrag.group); roomDrag = null; had = true; }
      if (moveDrag) {
        var m = moveDrag; moveDrag = null; had = true;
        if (m.orig && m.orig.rec) {
          var rec = null;
          placed.forEach(function (p) { if (p.group === m.group) rec = p; });
          if (rec) {
            var oi = occupied[rec.pi].indexOf(rec.rec);
            if (oi >= 0) occupied[rec.pi].splice(oi, 1);
            rec.pi = m.orig.pi;
            rec.rec[0] = m.orig.rec[0]; rec.rec[1] = m.orig.rec[1];
            occupied[rec.pi].push(rec.rec);
            m.group.position.set((rec.rec[0] + rec.rec[1]) / 2, m.orig.y, m.group.position.z);
          }
          m.group.scale.setScalar(1);
          select(m.group);
        }
      }
      if (had) { snapGuide.visible = false; highlightZones(false); markDirty(); }
    }
    /* Inventory sourced from the decoration catalog (js/218-shelf3d-decor.js).
       `owned` is session state; everything else (name, icon, room tab,
       premium flag) comes from the catalog. Lantern + globe are unlocked
       per Kevin's approval — no locks, no paywall during alpha. */
    var INVENTORY = (function () {
      var D = (typeof window.Shelf3DDecor !== 'undefined' && window.Shelf3DDecor)
        ? window.Shelf3DDecor.CATALOG : [];
      return D.map(function (d) {
        return { type: d.id, name: d.name, room: !!d.room, mount: d.mount || null,
          premium: !!d.premium, owned: d.stock || 0, svg: d.svg };
      });
    })();
    var pickedType = null, invTab = 'shelf';
    function buildInventory() {
      var grid = $('s3dInvGrid');
      grid.innerHTML = '';
      var tabs = root.querySelectorAll('#s3dInvTabs button');
      for (var ti = 0; ti < tabs.length; ti++) {
        tabs[ti].classList.toggle('on', tabs[ti].dataset.tab === invTab);
      }
      INVENTORY.filter(function (item) { return (invTab === 'room') === !!item.room; })
        .forEach(function (item) {
          var d = document.createElement('div');
          d.className = 'inv-item' + (pickedType === item.type ? ' picked' : '');
          d.dataset.deco = item.type;
          d.innerHTML = item.svg + '<div>' + item.name + '</div>' +
            '<span class="cnt">\u00d7' + item.owned + '</span>';
          if (item.owned > 0) bindTileGestures(d, item);   // v442: swipe scrolls, vertical drag picks up, tap picks up
          grid.appendChild(d);
        });
      var sub = root.querySelector('#s3dInvPanel .sub');
      if (sub) sub.textContent = invTab === 'room'
        ? 'Swipe to browse \u00b7 drag up to place \u00b7 tap to pick up, then tap the room'
        : 'Swipe to browse \u00b7 drag up to place \u00b7 tap to pick up, then tap a shelf';
    }
    var invTabBtns = root.querySelectorAll('#s3dInvTabs button');
    for (var ibi = 0; ibi < invTabBtns.length; ibi++) {
      (function (b) {
        b.addEventListener('click', function () { invTab = b.dataset.tab; buildInventory(); });
      })(invTabBtns[ibi]);
    }
    function startInvDrag(e, item, el) {
      e.preventDefault();
      clearUndo();
      deselect();
      closeInventory();
      var maker = decoMakerFor(item.type);
      if (!maker) { toast('Could not load ' + item.name, 2200); return; }
      var g = maker();
      g.visible = false; scene.add(g);
      trayDrag = { type: item.type, group: g, pi: -1, x: 0, moved: false,
        sx: e.clientX, sy: e.clientY, targetX: 0, targetY: 0, targetZ: 0, hasTarget: false };
      highlightZones(true);
      // position the ghost under the pointer immediately (1:1 on grab)
      queueRaycast(e);
    }
    /* free placement — drag anywhere in the room, drop where the finger lets go */
    function startRoomDrag(e, item, el) {
      e.preventDefault();
      clearUndo();
      deselect();
      closeInventory();
      var g = ROOM_MAKERS[item.type]();
      g.visible = false; scene.add(g);
      roomDrag = { type: item.type, group: g, moved: false,
        sx: e.clientX, sy: e.clientY, targetX: 0, targetY: 0, targetZ: 0, hasTarget: false };
      // position the ghost under the pointer immediately (1:1 on grab)
      queueRaycast(e);
    }
    function openInventory() { $('s3dInvPanel').classList.add('open'); }
    function closeInventory() {
      $('s3dInvPanel').classList.remove('open');
    }
    $('s3dInvBtn').addEventListener('click', function () {
      var p = $('s3dInvPanel');
      if (p.classList.contains('open')) closeInventory();
      else { clearUndo(); buildInventory(); openInventory(); }
    });
    /* v442: placing-bar buttons */
    $('s3dPlaceCancel').addEventListener('click', function () {
      pickedType = null; hidePlaceBar(); setHint(DEFAULT_HINT);
    });
    $('s3dPlaceUndo').addEventListener('click', function () {
      var u = pendingUndo; pendingUndo = null;
      if (u) { removeDeco(u.group); restoreInventory(u.type); }
      hidePlaceBar(); setHint(DEFAULT_HINT); buildInventory();
    });
    /* Escape reliably dismisses the panel and clears selection */
    on(window, 'keydown', function (e) {
      if (e.key === 'Escape') { closeInventory(); deselect(); pickedType = null; hidePlaceBar(); setHint(DEFAULT_HINT); }
    });
    buildInventory();

    /* tap-shelf-to-place when a type is picked */
    var tapPlacedDeco = false, downX = 0, downY = 0;
    canvas.addEventListener('pointerdown', function (e) {
      downX = e.clientX; downY = e.clientY;
      if (pickedType && !trayDrag && !roomDrag) {
        var item = invByType(pickedType);
        if (item && item.room) {
          // room deco picked up: tap = auto-place at first free anchor
          var a = firstFreeAnchor(item.type);
          pickedType = null; hidePlaceBar(); setHint(DEFAULT_HINT);
          if (a) { var g2 = placeRoomDeco(item.type, a.pos, a); afterPlace(item, g2); }
          else toast('No free spot for the ' + item.name.toLowerCase(), 2200);
          tapPlacedDeco = true;   // suppress book-tap on the matching pointerup
        } else if (item) {
          var hit = zoneHit(e);
          if (hit) {
            var g = placeDeco(pickedType, hit.pi, hit.point.x);  // decrements inventory
            afterPlace(item, g);
            tapPlacedDeco = true;   // suppress book-tap on the matching pointerup
          }
        }
      }
    });

    /* ============================== interaction ============================== */
    /* reusable camera-facing plane for 1:1 room-deco drag follow */
    var dragPlane = new THREE.Plane();
    function zoneHit(e) {
      setPtr(e); ray.setFromCamera(ptr, camera);
      var hits = ray.intersectObjects(zones, false);
      return hits.length ? { pi: hits[0].object.userData.pi, point: hits[0].point } : null;
    }
    function decoAt(e) {
      setPtr(e); ray.setFromCamera(ptr, camera);
      var groups = placed.map(function (p) { return p.group; });
      var hits = ray.intersectObjects(groups, true);
      if (!hits.length) return null;
      var o = hits[0].object;
      while (o && !o.userData.decoType) o = o.parent;
      return o;
    }
    function showSnap(type, pi, x) {
      var edge = (type === 'lights' || type === 'stargarland');
      var gw = { plant: 0.75, candle: 0.55, mug: 0.6, stack: 1.2, lights: 6.4, stargarland: 5.6,
        vase: 0.5, gifts: 0.75, eggs: 0.7, coins: 0.42, clover: 0.45, applebowl: 0.85,
        lantern: 0.45, globe: 0.62, clock: 0.6, photo: 0.55, succulent: 0.5 }[type] || 0.7;
      if (edge) {
        snapGuide.scale.set(type === 'lights' ? 6.2 : 5.4, 1, 0.5);
        snapGuide.position.set(THREE.MathUtils.clamp(x, -SHELF_W / 2 + 3.2, SHELF_W / 2 - 3.2),
          LEVELS[pi] + 0.05, PLANK_D / 2 - 0.4);
      } else {
        snapGuide.scale.set(gw, 1, 0.8);
        snapGuide.position.set(x, LEVELS[pi] + 0.03, 0.1);
      }
      snapGuide.visible = true;
    }

    /* selection — soft pulsing glow hugging the footprint (not a flat ellipse) */
    function glowRingTexture() {
      var c = document.createElement('canvas'); c.width = c.height = 128;
      var g = c.getContext('2d');
      g.strokeStyle = '#e5b86a'; g.lineWidth = 9;
      g.shadowColor = '#e5b86a'; g.shadowBlur = 20;
      g.beginPath(); g.arc(64, 64, 42, 0, 7); g.stroke();
      g.shadowBlur = 0; g.lineWidth = 3; g.strokeStyle = 'rgba(255,240,210,.9)';
      g.beginPath(); g.arc(64, 64, 42, 0, 7); g.stroke();
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }
    var selRing = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: glowRingTexture(), transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    selRing.rotation.x = -Math.PI / 2; selRing.visible = false; scene.add(selRing);
    var selected = null;
    var selmenu = $('s3dSelmenu');
    function toScreen(v3) {
      var r = canvas.getBoundingClientRect();
      var v = v3.clone().project(camera);
      return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height };
    }
    function select(g) {
      selected = g;
      var p = null;
      placed.forEach(function (pp) { if (pp.group === g) p = pp; });
      var baseY = (p && p.room) ? g.position.y : LEVELS[p.pi];
      var r2 = (p && p.room) ? 0.8
        : Math.max(g.userData.fw || 0.8, g.userData.fd || 0.8) / 2 + 0.18;
      var gs = r2 * 2.6;   // glow texture is a soft ring on a 1x1 plane
      selRing.scale.set(gs, gs, 1);
      if (p && p.room && p.type === 'web') {   // web hangs vertical on the wall
        selRing.rotation.set(0, 0, 0);
        selRing.position.set(g.position.x, g.position.y, g.position.z + 0.12);
      } else {
        selRing.rotation.set(-Math.PI / 2, 0, 0);
        selRing.position.set(g.position.x, baseY + 0.03, g.position.z);
      }
      selRing.visible = true;
      markDirty();
      // room decos can't be moved (Delete only)
      $('s3dSelMove').style.display = (p && p.room) ? 'none' : '';
      var s = toScreen(new THREE.Vector3(g.position.x, baseY + 1.15, g.position.z));
      var cr = canvas.getBoundingClientRect();
      selmenu.style.left = Math.max(90, Math.min(cr.width - 90, s.x)) + 'px';
      selmenu.style.top = Math.max(120, s.y) + 'px';
      selmenu.classList.add('show');
    }
    function deselect() {
      selected = null; selRing.visible = false; selmenu.classList.remove('show');
      markDirty();
    }
    $('s3dSelDelete').addEventListener('click', function () {
      if (!selected) return;
      var g = selected;   // shrink-out over 180ms instead of vanishing
      deselect(); sfx('delete');
      tween(180, function (k) { g.scale.setScalar(Math.max(0.001, 1 - k)); },
        function () { removeDeco(g); });
    });
    $('s3dSelDone').addEventListener('click', deselect);
    $('s3dSelMove').addEventListener('click', function () {
      selmenu.classList.remove('show');
      toast('Drag the decoration to move it \u00b7 tap elsewhere to finish', 2600);
    });

    /* drag from inventory — lerped ghost follow + scale feedback for tactile feel */
    var trayDrag = null;
    var roomDrag = null; // room-deco drag from inventory
    var moveDrag = null; // drag placed decorations
    var raycastQueued = false, lastRayEvent = null;
    // throttle raycasts to once per animation frame for smooth 60fps drag
    function queueRaycast(e) { lastRayEvent = e; raycastQueued = true; }
    on(window, 'pointermove', function (e) {
      if (trayDrag || moveDrag || roomDrag) { queueRaycast(e); return; }
      // hover parallax (desktop)
      var r = canvas.getBoundingClientRect();
      pointerPX = ((e.clientX - r.left) / r.width) * 2 - 1;
      pointerPY = ((e.clientY - r.top) / r.height) * 2 - 1;
    });
    /* per-frame drag processing — raycast once per frame, lerp ghost to target */
    function processDragFrame() {
      if (!raycastQueued) return;
      raycastQueued = false;
      var e = lastRayEvent;
      if (trayDrag) {
        if (Math.hypot(e.clientX - trayDrag.sx, e.clientY - trayDrag.sy) > 8) {
          if (!trayDrag.moved) {
            trayDrag.moved = true;
            trayDrag.group.scale.setScalar(1.18); // tactile pick-up feedback
          }
        }
        var hit = zoneHit(e);
        if (hit) {
          var fw = trayDrag.group.userData.fw;
          var x = findFreeSpot(hit.pi, hit.point.x, fw); // snapped, for drop
          trayDrag.pi = hit.pi; trayDrag.x = x;
          trayDrag.group.visible = true;
          // 1:1 follow — ghost tracks the raw pointer x (not the snapped
          // spot); the snap guide shows the landing spot. Touch lifts the ghost
          // so the finger doesn't occlude it.
          var rawX = THREE.MathUtils.clamp(hit.point.x, -SHELF_W / 2 + 0.4, SHELF_W / 2 - 0.4);
          var lift = (e.pointerType === 'touch') ? 0.45 : 0;
          if (trayDrag.group.userData.edge) {
            trayDrag.targetX = THREE.MathUtils.clamp(rawX, -SHELF_W / 2 + 3.2, SHELF_W / 2 - 3.2);
            trayDrag.targetY = LEVELS[hit.pi] + 0.06 + lift;
            trayDrag.targetZ = PLANK_D / 2 - 0.4;
          } else {
            trayDrag.targetX = rawX; trayDrag.targetY = LEVELS[hit.pi] + lift; trayDrag.targetZ = 0.1;
          }
          trayDrag.hasTarget = true;
          showSnap(trayDrag.type, hit.pi, x);
        } else {
          trayDrag.pi = -1; trayDrag.group.visible = false; snapGuide.visible = false;
          trayDrag.hasTarget = false;
        }
      } else if (roomDrag) {
        /* 1:1 follow — the ghost tracks the pointer on a camera-facing plane
           through the bookcase (no easing); the drop snaps to the landing
           rules per decoration type. Touch lifts the ghost so the finger
           doesn't occlude it. */
        if (Math.hypot(e.clientX - roomDrag.sx, e.clientY - roomDrag.sy) > 8) {
          if (!roomDrag.moved) {
            roomDrag.moved = true;
            roomDrag.group.scale.setScalar(1.18); // tactile pick-up feedback
          }
        }
        setPtr(e); ray.setFromCamera(ptr, camera);
        var camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        dragPlane.setFromNormalAndCoplanarPoint(camDir, new THREE.Vector3(0, 3, 0));
        var pt = new THREE.Vector3();
        if (ray.ray.intersectPlane(dragPlane, pt)) {
          roomDrag.group.visible = true;
          var lift2 = (e.pointerType === 'touch') ? 0.45 : 0;
          roomDrag.targetX = THREE.MathUtils.clamp(pt.x, -9, 9);
          roomDrag.targetY = THREE.MathUtils.clamp(pt.y + lift2, 0.2, 9);
          roomDrag.targetZ = THREE.MathUtils.clamp(pt.z, -4, 4);
          roomDrag.hasTarget = true;
        }
      } else if (moveDrag) {
        if (Math.hypot(e.clientX - moveDrag.sx, e.clientY - moveDrag.sy) > 8) {
          if (!moveDrag.moved) {
            moveDrag.moved = true;
            moveDrag.group.scale.setScalar(1.18);
            deselect();
          }
        }
        if (moveDrag.moved) {
          var hit2 = zoneHit(e);
          if (hit2) {
            var rec = null;
            placed.forEach(function (p) { if (p.group === moveDrag.group) rec = p; });
            var fw2 = moveDrag.group.userData.fw;
            var oi = occupied[hit2.pi].indexOf(rec.rec);
            if (oi >= 0) occupied[hit2.pi].splice(oi, 1);
            var x2 = findFreeSpot(hit2.pi, hit2.point.x, fw2); // snapped, for drop
            occupied[hit2.pi].push(rec.rec);
            rec.pi = hit2.pi;
            rec.rec[0] = x2 - fw2 / 2; rec.rec[1] = x2 + fw2 / 2;
            // v422: update restY when shelf changes (fixes cross-shelf drag snapping back)
            var isEdge2 = !!moveDrag.group.userData.edge;
            moveDrag.restY = LEVELS[hit2.pi] + (isEdge2 ? 0.06 : 0);
            // 1:1 follow — ghost tracks raw pointer x; snap guide shows landing
            var rawX2 = THREE.MathUtils.clamp(hit2.point.x, -SHELF_W / 2 + 0.4, SHELF_W / 2 - 0.4);
            var lift3 = (e.pointerType === 'touch') ? 0.45 : 0;
            if (moveDrag.group.userData.edge) {
              moveDrag.targetX = THREE.MathUtils.clamp(rawX2, -SHELF_W / 2 + 3.2, SHELF_W / 2 - 3.2);
              moveDrag.targetY = LEVELS[hit2.pi] + 0.06 + lift3;
              moveDrag.targetZ = PLANK_D / 2 - 0.4;
            } else {
              moveDrag.targetX = rawX2; moveDrag.targetY = LEVELS[hit2.pi] + lift3; moveDrag.targetZ = 0.1;
            }
            moveDrag.hasTarget = true;
            showSnap(moveDrag.group.userData.decoType, hit2.pi, x2);
          }
        }
      }
    }

    on(window, 'pointerup', function (e) {
      snapGuide.visible = false;
      if (roomDrag) {
        /* free placement — the item lands exactly where the finger drops it
           (pumpkins clamped into FLOOR_BOUNDS, never under the bookcase).
           v442: tap no longer starts a drag (tap = pick up instead), so a
           release without a target cancels instead of auto-placing. */
        var r = roomDrag; roomDrag = null;
        r.group.scale.setScalar(1);
        highlightZones(false);
        if (r.moved && r.hasTarget) {
          discardGhost(r.group);
          var g = placeRoomDeco(r.type, roomDropPos(r.type, r.targetX, r.targetY, r.targetZ), null);
          afterPlace(invByType(r.type), g);
        } else {
          discardGhost(r.group); // dropped outside: cancel
        }
        return;
      }
      if (trayDrag) {
        var t = trayDrag; trayDrag = null;
        t.group.scale.setScalar(1); // restore scale on drop
        highlightZones(false);
        if (t.pi >= 0) {
          discardGhost(t.group);
          var g2 = placeDeco(t.type, t.pi, t.x);
          afterPlace(invByType(t.type), g2);
        } else {
          discardGhost(t.group); // dropped outside: cancel
        }
        return;
      }
      if (moveDrag) {
        var m = moveDrag; moveDrag = null;
        highlightZones(false);
        if (m.group) {
          var g3 = m.group;
          // soft settle on drop instead of an instant scale snap
          // v413: tween Y back to rest (fixes floating decor)
          // v422: restY is updated during drag when pi changes, so cross-shelf
          // drags settle on the new shelf.
          if (m.moved) {
            var startY2 = g3.position.y, endY2 = (typeof m.restY === 'number') ? m.restY : g3.position.y;
            tween(180, function (k) {
              g3.scale.setScalar(Math.max(1, 1.18 - 0.18 * easeOut(k)));
              g3.position.y = startY2 + (endY2 - startY2) * easeOut(k);
            });
          } else g3.scale.setScalar(1);
          select(g3);   // re-select after move
        }
        return;
      }
    });

    // v442: pointercancel (browser claimed the gesture mid-drag, interruption, …)
    // discards the ghost and clears drag state instead of leaving it stuck.
    on(window, 'pointercancel', function (e) { cancelActiveDrag(); });

    /* drag placed decorations + tap select (canvas); tap a book -> onBookTap */
    canvas.addEventListener('pointerdown', function (e) {
      var g = decoAt(e);
      if (g && g.userData.room) { select(g); return; } // room decos tap-select (no drag)
      if (g) {
        var rec0 = null, pi0 = -1;
        placed.forEach(function (pp) { if (pp.group === g) { rec0 = pp.rec.slice(); pi0 = pp.pi; } });
        moveDrag = { group: g, moved: false, sx: e.clientX, sy: e.clientY,
          targetX: 0, targetY: 0, targetZ: 0, hasTarget: false,
          // v413: capture rest Y to fix floating-decor bug (lift not reset on drop)
          restY: g.position.y,
          // v442: snapshot for pointercancel restore
          orig: { pi: pi0, rec: rec0, y: g.position.y } };
        highlightZones(true);
      }
    });
    canvas.addEventListener('pointerup', function (e) {
      // handled in window pointerup via moveDrag; tap-empty deselects here,
      // and a clean tap on a book reports it to the app.
      if (!moveDrag) {
        if (!decoAt(e)) {
          if (!tapPlacedDeco && Math.hypot(e.clientX - downX, e.clientY - downY) < 8) {
            var b = bookAt(e);
            if (b && b.userData.bookId != null) {
              deselect();
              tapPlacedDeco = false;
              if (typeof opts.onBookTap === 'function') opts.onBookTap(b.userData.bookId);
              return;
            }
          }
          deselect();
        }
      }
      tapPlacedDeco = false;
    });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // v412: wheel zoom (desktop) + pinch zoom (mobile).
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      // Wheel up = zoom in (closer), wheel down = zoom out.
      setZoom(zoomFactor * (e.deltaY > 0 ? 1.08 : 0.92));
    }, { passive: false });
    // Pinch: track two-pointer distance.
    var pinchStartDist = 0, pinchStartZoom = 1.0;
    canvas.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist = Math.hypot(dx, dy);
        pinchStartZoom = zoomFactor;
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault();  // prevent page scroll during pinch
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.hypot(dx, dy);
        // Pinch out (dist grows) = zoom in (closer).
        setZoom(pinchStartZoom * (pinchStartDist / dist));
      }
    }, { passive: false });
    canvas.addEventListener('touchend', function (e) {
      if (e.touches.length < 2) pinchStartDist = 0;
    }, { passive: true });

    /* ============================== mood / autumn preset ============================== */
    /* autumn preset crossfades warm over ~800ms instead of instant */
    function setMood(name, ms) {
      ms = ms || 800;
      var T = name === 'autumn'
        ? { amb: 0.72, hemi: 0.5, sun: 2.7, sunC: 0xffc98a, rim: 0.8, exp: 1.25 }
        : { amb: 0.85, hemi: 0.55, sun: 2.3, sunC: 0xffe2b8, rim: 0.6, exp: 1.15 };
      var S = { amb: ambLight.intensity, hemi: hemi.intensity, sun: sun.intensity,
        sunC: sun.color.clone(), rim: rim.intensity, exp: renderer.toneMappingExposure };
      var TC = new THREE.Color(T.sunC);
      tween(ms, function (k) {
        ambLight.intensity = S.amb + (T.amb - S.amb) * k;
        hemi.intensity = S.hemi + (T.hemi - S.hemi) * k;
        sun.intensity = S.sun + (T.sun - S.sun) * k;
        sun.color.copy(S.sunC).lerp(TC, k);
        rim.intensity = S.rim + (T.rim - S.rim) * k;
        renderer.toneMappingExposure = S.exp + (T.exp - S.exp) * k;
      });
    }
    function setTheme(themeKey) {
      setMood(themeKey === 'autumn' ? 'autumn' : 'default');
    }

    /* v405: apply full app-theme params (from Shelf3DTheme.forTheme).
       Tweens lighting like setMood; regenerates wood textures with the new
       base colors; recolors fairy-bulb emissive to the accent glow. */
    function shadeHex(hex, amt) {
      var n = parseInt(String(hex).replace('#', ''), 16);
      var r = Math.max(0, Math.min(255, (n >> 16) + amt));
      var g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
      var b = Math.max(0, Math.min(255, (n & 255) + amt));
      return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
    }
    function setThemeParams(p) {
      if (!p) return;
      try {
        // Lighting tween (800ms, same feel as preset crossfade).
        var T = {
          amb: p.ambientLevel != null ? p.ambientLevel : 0.85,
          sunC: new THREE.Color(p.lightWarm || '#ffe2b8'),
          rimC: new THREE.Color(p.lightCool || '#7a6ac0'),
          exp: p.exposure != null ? p.exposure : 1.15,
        };
        var S = {
          amb: ambLight.intensity,
          sunC: sun.color.clone(), rimC: rim.color.clone(),
          exp: renderer.toneMappingExposure,
        };
        tween(800, function (k) {
          ambLight.intensity = S.amb + (T.amb - S.amb) * k;
          sun.color.copy(S.sunC).lerp(T.sunC, k);
          rim.color.copy(S.rimC).lerp(T.rimC, k);
          renderer.toneMappingExposure = S.exp + (T.exp - S.exp) * k;
        });
        // Wood: regenerate grain textures with the theme base colors.
        if (p.woodBase) {
          var wt = woodTexture(p.woodBase, shadeHex(p.woodBase, -40), shadeHex(p.woodBase, 38));
          woodMat.map = wt; woodMat.needsUpdate = true;
        }
        if (p.woodDark) {
          var wd = woodTexture(p.woodDark, shadeHex(p.woodDark, -28), shadeHex(p.woodDark, 30));
          woodDark.map = wd; woodDark.needsUpdate = true;
        }
        // Fairy bulbs: accent glow.
        if (p.accentGlow) {
          var ac = new THREE.Color(p.accentGlow);
          fairyBulbs.forEach(function (b) {
            if (b.material && b.material.emissive) b.material.emissive.copy(ac);
          });
        }
      } catch (e) {}
    }

    /* ---- per-theme presets + "Dress shelf for <theme>" ----
       Each app theme has a preset arrangement (js/218-shelf3d-decor.js).
       - A fresh mount starts empty, so it auto-applies the current theme's
         preset immediately (decorations are session-only).
       - The dress button applies the preset on explicit tap ONLY: switching
         the app theme never rearranges mid-session decorations.
       - Toggleable: tapping again restores the pre-dress arrangement. */
    var dressBtn = $('s3dPresetBtn');
    var dressOn = false, preDress = null, appTheme = 'dark', dressedTheme = null;
    function themeDisplayName(k) {
      return String(k || 'dark').replace(/^[a-z]/, function (c) { return c.toUpperCase(); });
    }
    function dressLabel() {
      dressBtn.textContent = dressOn ? 'Default look' : 'Dress shelf for ' + themeDisplayName(appTheme);
      dressBtn.classList.toggle('on', dressOn);
    }
    function snapshotDecos() {
      return placed.map(function (p) {
        return { type: p.type, room: !!p.room, pi: p.pi, pos: p.group.position.clone(), opts: p.opts };
      });
    }
    function restoreDecos(snap) {
      clearDecos();
      snap.forEach(function (s) {
        if (s.room) placeRoomDeco(s.type, s.pos, null, true, s.opts);
        else placeDeco(s.type, s.pi, s.pos.x, true, s.opts);
      });
      deselect();
    }
    function applyPreset(themeKey) {
      var D = (typeof window.Shelf3DDecor !== 'undefined') ? window.Shelf3DDecor : null;
      var items = D ? D.presetFor(themeKey) : [];
      items.forEach(function (it) {
        if (it.room) {
          placeRoomDeco(it.deco, roomDropPos(it.deco, it.x || 0, it.y || 3, it.z || 1), null, true, it);
        } else {
          placeDeco(it.deco, it.pi || 0, it.x || 0, true, it);
        }
      });
      dressedTheme = themeKey;
      deselect();
    }
    /* Public: the host view calls this when the app theme changes. Updates
       the dress button label; never touches existing decorations. */
    function setAppTheme(key) {
      appTheme = key || 'dark';
      dressLabel();
    }
    dressBtn.addEventListener('click', function () {
      if (dressOn) {   // toggle back to the user's own arrangement
        restoreDecos(preDress);
        preDress = null; dressOn = false;
        dressLabel();
        sfx('preset');
        toast('Back to your decorations');
        return;
      }
      var doApply = function () {
        preDress = snapshotDecos();
        clearDecos();
        applyPreset(appTheme);
        dressOn = true;
        dressLabel();
        sfx('preset');
      };
      if (placed.length) {
        confirmDlg('This replaces your current decorations. Continue?').then(function (ok) {
          if (ok) doApply();
        });
      } else {
        doApply();
      }
    });

    /* ============================== parallax / tilt / sound ============================== */
    /* explicit user toggle (all platforms) + debug readout of raw sensor values */
    var pointerPX = 0, pointerPY = 0;
    var tilt = { x: 0, y: 0 }, tiltOn = false, tiltEvents = 0, tiltLast = null;
    function onTilt(e) {
      tiltEvents++;
      tiltLast = e;
      if (e.gamma == null || e.beta == null) { tiltDbg(); return; }
      tilt.x = THREE.MathUtils.clamp(e.gamma / 35, -1, 1);
      tilt.y = THREE.MathUtils.clamp((e.beta - 45) / 35, -1, 1);
      tiltDbg();
    }
    var tiltBtn = $('s3dTiltBtn');
    var canTilt = ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
      typeof DeviceOrientationEvent !== 'undefined';
    if (!canTilt) {
      tiltBtn.classList.add('dim');
      tiltBtn.title = 'Tilt parallax needs a mobile device with motion sensors';
    }
    tiltBtn.addEventListener('click', function () {
      if (!canTilt) { toast('Tilt needs a mobile device with motion sensors'); return; }
      setTilt(!tiltOn);
    });
    /* sound mute toggle */
    var sndBtn = $('s3dSndBtn');
    sndBtn.addEventListener('click', function () {
      soundOn = !soundOn;
      sndBtn.textContent = soundOn ? 'Sound: on' : 'Sound: off';
      sndBtn.classList.toggle('dim', !soundOn);
      if (soundOn) sfx('place');
    });
    function tiltDbg() {
      var d = $('s3dTiltDbg');
      if (!tiltOn) { d.style.display = 'none'; return; }
      d.style.display = 'block';
      if (!tiltEvents) { d.textContent = 'tilt: waiting for sensor events\u2026'; return; }
      var l = tiltLast, f = function (v) { return v == null ? '\u2013' : v.toFixed(0); };
      d.textContent = 'tilt ev#' + tiltEvents + '  \u03b1' + f(l.alpha) + ' \u03b2' + f(l.beta) + ' \u03b3' + f(l.gamma);
    }
    function setTilt(on) {
      if (on === tiltOn) { tiltDbg(); return; }
      if (on) {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
          DeviceOrientationEvent.requestPermission().then(function (res) {
            if (res !== 'granted') return;
            tiltEvents = 0; tiltLast = null;
            on(window, 'deviceorientation', onTilt);
            tiltOn = true;
            tiltBtn.textContent = 'Tilt: on';
            tiltBtn.classList.add('on');
            tiltDbg();
          }).catch(function () {});
          return;
        }
        tiltEvents = 0; tiltLast = null;
        on(window, 'deviceorientation', onTilt);
        tiltOn = true;
      } else {
        try { window.removeEventListener('deviceorientation', onTilt); } catch (e) {}
        // also drop it from the tracked list so offAll() stays accurate
        for (var i = listeners.length - 1; i >= 0; i--) {
          if (listeners[i][1] === 'deviceorientation') listeners.splice(i, 1);
        }
        tiltOn = false;
        tilt.x = 0; tilt.y = 0;   // camera lerps back to pointer control
      }
      tiltBtn.textContent = tiltOn ? 'Tilt: on' : 'Tilt: off';
      tiltBtn.classList.toggle('on', tiltOn);
      tiltDbg();
    }

    /* ============================== layout / loop ============================== */
    function layout() {
      var r = container.getBoundingClientRect();
      var w = Math.max(1, r.width), h = Math.max(1, r.height), a = w / h;
      camera.aspect = a; camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      // v409: tighter mobile framing (Kevin: shelf too small on Pixel).
      // Portrait phones get closer instead of the old 2.1x pullback.
      camBase.set(0, 4.8, a >= 1 ? 13.4 : 13.4 * Math.min(1.45, 1.05 / a));
    }
    var resizeObs = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(function () { if (!dead) layout(); });
      resizeObs.observe(container);
    }
    layout();

    var clockT = new THREE.Clock();
    var rafId = 0;
    /* Phase 1: render on demand + adaptive resolution */
    var needsRender = true;  // true when camera moving, tween active, pointer down, etc.
    var frameTimes = [];     // rolling window for adaptive resolution
    var curPixelRatio = 1.5; // Phase 1: start at 1.5, adapt 1.0–2.0 from frame time
    var lastFrameT = performance.now();
    renderer.setPixelRatio(curPixelRatio);
    /* Phase 1: WebGL context loss/restore handling */
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();  // allow restore
      cancelAnimationFrame(rafId);
      rafId = 0;
      // Show calm retry message
      try {
        var msg = root.querySelector('#s3dCtxMsg');
        if (!msg) {
          msg = document.createElement('div');
          msg.id = 's3dCtxMsg';
          msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(20,14,26,.92);color:#f6eff8;font-family:system-ui,sans-serif;font-size:14px;text-align:center;padding:24px;z-index:20;';
          msg.innerHTML = '<div><p style="margin:0 0 12px;">The 3D shelf paused to save memory.</p><button id="s3dCtxRetry" style="background:#e5b86a;color:#241a10;border:none;border-radius:10px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;">Tap to reload</button></div>';
          root.appendChild(msg);
          msg.querySelector('#s3dCtxRetry').addEventListener('click', function () {
            try { window.location.reload(); } catch (_) {}
          });
        }
        msg.style.display = 'flex';
      } catch (_) {}
    }, false);
    canvas.addEventListener('webglcontextrestored', function () {
      try {
        var msg = root.querySelector('#s3dCtxMsg');
        if (msg) msg.style.display = 'none';
      } catch (_) {}
      // Rebuild GPU resources by re-rendering; shadows need rebake
      renderer.shadowMap.needsUpdate = true;
      markDirty();
      if (!rafId && !dead) animate();
    }, false);
    function markDirty() { needsRender = true; }
    // Pause when tab hidden; resume when visible
    var wasHidden = false;
    function onVisChange() {
      if (document.hidden) {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        markDirty();  // re-render on return
      }
    }
    on(document, 'visibilitychange', onVisChange);
    // Check if book modal is open (pause rendering when it covers the canvas)
    function isModalOpen() {
      return !!(document.querySelector('.book-modal.open, #bookModal.open, .modal.open'));
    }
    function animate() {
      if (dead) return;
      rafId = requestAnimationFrame(animate);
      // Phase 1: skip entirely when tab hidden or modal open
      if (document.hidden || isModalOpen()) return;
      var t = clockT.getElapsedTime();
      var now = performance.now();
      var dt = Math.min(0.1, (now - lastFrameT) / 1000);  // seconds, clamped
      lastFrameT = now;
      stepTweens(now);   // all UI tweens (place pop, delete shrink, mood crossfade)
      var tweensActive = tweens.length > 0;
      processDragFrame();
      // 1:1 drag follow — ghost tracks the pointer with no easing lag, so the
      // item feels held, not chased. (Drop still snaps to the guide/rules.)
      if (trayDrag && trayDrag.hasTarget && trayDrag.group.visible) {
        trayDrag.group.position.set(trayDrag.targetX, trayDrag.targetY, trayDrag.targetZ);
      }
      if (roomDrag && roomDrag.hasTarget && roomDrag.group.visible) {
        roomDrag.group.position.set(roomDrag.targetX, roomDrag.targetY, roomDrag.targetZ);
      }
      if (moveDrag && moveDrag.hasTarget && moveDrag.moved) {
        moveDrag.group.position.set(moveDrag.targetX, moveDrag.targetY, moveDrag.targetZ);
      }
      // blob shadow under shelf drags — visible while lifted, tightens on landing
      var shelfDrag = (trayDrag && trayDrag.hasTarget && trayDrag.pi >= 0) ? trayDrag
        : (moveDrag && moveDrag.hasTarget && moveDrag.moved) ? moveDrag : null;
      if (shelfDrag) {
        var sg = shelfDrag.group, fw = sg.userData.fw || 0.8;
        var spi = shelfDrag === trayDrag ? trayDrag.pi
          : (function () {
              var found = null;
              placed.forEach(function (p) { if (p.group === sg) found = p.pi; });
              return found;
            })();
        if (spi != null && spi >= 0) {
          blobShadow.visible = true;
          blobShadow.position.set(shelfDrag.targetX, LEVELS[spi] + 0.02, shelfDrag.targetZ);
          var ss = fw * 1.7;
          blobShadow.scale.set(ss, ss, 1);
          blobShadow.material.opacity += (0.32 - blobShadow.material.opacity) * 0.2;
        }
      } else if (blobShadow.visible) {
        blobShadow.material.opacity -= 0.06;   // tighten + fade on landing
        var bs = blobShadow.scale.x;
        blobShadow.scale.set(bs * 0.94, bs * 0.94, 1);
        if (blobShadow.material.opacity <= 0.01) blobShadow.visible = false;
      }
      // candle flicker — sprite flame + synced point light
      for (var ci = 0; ci < candleFlames.length; ci++) {
        var cg = candleFlames[ci], u = cg.userData, s = u.seed;
        u.glow.intensity = 14 + Math.sin(t * 13 + s) * 2.2 + Math.sin(t * 29 + s * 1.7) * 1.4;
        u.flame.scale.set(0.24 * (1 + Math.sin(t * 17 + s) * 0.14),
                          0.34 * (1 + Math.sin(t * 23 + s) * 0.18), 1);
        u.flame.position.x = Math.sin(t * 11 + s) * 0.012;
      }
      // fairy twinkle — staggered wave along the string
      for (var bi = 0; bi < fairyBulbs.length; bi++) {
        var bb = fairyBulbs[bi];
        bb.material.emissiveIntensity = 1.55 + Math.sin(t * 2.2 + bb.userData.phase) * 0.4;
      }
      // dust motes drifting in the light
      var mp = moteGeo.attributes.position;
      for (var mi = 0; mi < MOTES; mi++) {
        var ph = motePhase[mi];
        mp.array[mi * 3] = moteBase[mi * 3] + Math.sin(t * 0.22 + ph) * 0.35;
        mp.array[mi * 3 + 1] = moteBase[mi * 3 + 1] + Math.sin(t * 0.16 + ph * 1.7) * 0.4;
      }
      mp.needsUpdate = true;
      // selection glow pulse
      if (selRing.visible) selRing.material.opacity = 0.62 + Math.sin(t * 3.2) * 0.22;
      // dolly-in on load (2.2s ease-out)
      var lk = Math.min(1, (now - loadT0) / 2200);
      var dollyK = 1 - Math.pow(1 - lk, 3);
      // v412: apply user zoom (pinch/wheel) to the target distance.
      var targetZ = camBase.z * (1.22 * (1 - dollyK) + dollyK) * zoomFactor;
      // slow idle drift after 6s without interaction (Phase 1: time-based, stops after 30s)
      var idle = (now - lastInteract) > 6000 && (now - lastInteract) < 36000;
      var driftTarget = idle ? 1 : 0;
      driftAmt += (driftTarget - driftAmt) * (1 - Math.exp(-dt * 2));
      var driftX = Math.sin(t * 0.24) * 0.4 * driftAmt;
      var driftY = Math.cos(t * 0.19) * 0.22 * driftAmt;
      // camera parallax (Phase 1: time-based damping, frame-rate independent)
      var dampK = 1 - Math.exp(-dt * 7);  // ~0.045 at 60fps, scales with dt
      var px = tiltOn ? tilt.x : pointerPX * 0.55;
      var py = tiltOn ? tilt.y : pointerPY * 0.4;
      var camTX = camBase.x + px * 0.9 + driftX;
      var camTY = camBase.y - py * 0.55 + driftY;
      var dx = camTX - camera.position.x;
      var dy = camTY - camera.position.y;
      var dz = targetZ - camera.position.z;
      var camMoved = Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001 || Math.abs(dz) > 0.001;
      camera.position.x += dx * dampK;
      camera.position.y += dy * dampK;
      camera.position.z += dz * dampK;
      camera.lookAt(camTarget);
      // Phase 1: render on demand — only when something changed
      var animating = tweensActive || camMoved || driftAmt > 0.01 ||
        (trayDrag && trayDrag.hasTarget) || (moveDrag && moveDrag.hasTarget && moveDrag.moved) ||
        (roomDrag && roomDrag.hasTarget) || candleFlames.length > 0 || fairyBulbs.length > 0;
      if (animating || needsRender) {
        renderer.render(scene, camera);
        needsRender = false;
        // Phase 1: adaptive resolution — track frame time, adjust pixel ratio 1.0–2.0
        var frameMs = performance.now() - now;
        frameTimes.push(frameMs);
        if (frameTimes.length > 60) frameTimes.shift();
        if (frameTimes.length === 60) {
          var avg = frameTimes.reduce(function (a, b) { return a + b; }, 0) / 60;
          var target = curPixelRatio;
          if (avg > 24 && curPixelRatio > 1.0) target = Math.max(1.0, curPixelRatio - 0.25);
          else if (avg < 12 && curPixelRatio < 2.0) target = Math.min(2.0, curPixelRatio + 0.25);
          if (target !== curPixelRatio) {
            curPixelRatio = target;
            renderer.setPixelRatio(curPixelRatio);
          }
          frameTimes.length = 0;  // reset window after adjustment
        }
      }
    }

    /* ----- teardown: leak-free unmount ----- */
    function unmount() {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(rafId);
      if (resizeObs) { try { resizeObs.disconnect(); } catch (e) {} resizeObs = null; }
      offAll();
      clearTimeout(toastTimer); toastTimer = null;
      clearTimeout(onboardTimer); onboardTimer = null;
      tweens.length = 0;
      trayDrag = null; roomDrag = null; moveDrag = null;
      if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
      try { disposeDeep(scene); } catch (e) {}
      try { renderer.dispose(); } catch (e) {}
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    /* ----- go ----- */
    if (opts.initialBooks) setBooks(opts.initialBooks);
    /* Phase 1: persist decoration layout to localStorage */
    var DECO_STORE_KEY = 'cozylibram.s3d.deco.v1';
    function saveDecoLayout() {
      try {
        var data = placed.map(function (p) {
          return {
            type: p.type,
            pi: p.pi,
            x: p.group.position.x,
            z: p.group.position.z,
            room: !!p.room
          };
        });
        localStorage.setItem(DECO_STORE_KEY, JSON.stringify(data));
      } catch (_) {}
    }
    function loadDecoLayout() {
      try {
        var raw = localStorage.getItem(DECO_STORE_KEY);
        if (!raw) return false;
        var data = JSON.parse(raw);
        if (!Array.isArray(data) || !data.length) return false;
        data.forEach(function (d) {
          try {
            if (d.room) {
              // Room decorations need anchor lookup; skip if not available
              return;
            }
            // placeDeco signature: (type, pi, x, free, opts) — free=true so
            // restoring a saved layout never consumes inventory counts.
            if (typeof placeDeco === 'function') {
              placeDeco(d.type, d.pi, d.x, true);
              // Adjust z if needed
              var p = placed[placed.length - 1];
              if (p && d.z != null) p.group.position.z = d.z;
            }
          } catch (_) {}
        });
        return placed.length > 0;
      } catch (_) { return false; }
    }
    /* Fresh mount: try to restore saved decorations, else dress for theme.
       Decorations are now persistent, not session-only. */
    appTheme = (opts && opts.appTheme) || 'dark';
    dressLabel();
    var restored = loadDecoLayout();
    if (!restored && !placed.length) applyPreset(appTheme);
    // Save on changes: hook into placeDeco and removeDeco via wrappers
    var _origPlaceDeco = placeDeco;
    placeDeco = function () {
      var r = _origPlaceDeco.apply(this, arguments);
      saveDecoLayout();
      renderer.shadowMap.needsUpdate = true;  // Phase 1: rebake after deco change
      markDirty();
      return r;
    };
    var _origRemoveDeco = removeDeco;
    removeDeco = function () {
      var r = _origRemoveDeco.apply(this, arguments);
      saveDecoLayout();
      renderer.shadowMap.needsUpdate = true;
      markDirty();
      return r;
    };
    onboardTimer = setTimeout(function () {
      if (!dead) toast(DEFAULT_HINT, 4200);   // brief onboarding, then it gets out of the way
    }, 900);
    animate();

    return { setBooks: setBooks, setTheme: setTheme, setThemeParams: setThemeParams,
      setAppTheme: setAppTheme, unmount: unmount };
  }

  /* ============================== public API ============================== */
  var active = null;

  function mount(container, opts) {
    opts = opts || {};
    return s3dEnsureThree().then(function () {
      if (!container || !container.appendChild) {
        return Promise.reject(new Error('Shelf3D.mount: a container element is required'));
      }
      if (active) { try { active.unmount(); } catch (e) {} active = null; }
      var inst;
      try {
        inst = createInstance(container, opts);   // throws when WebGL is unavailable
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      active = inst;
      return { setBooks: inst.setBooks, setTheme: inst.setTheme, setThemeParams: inst.setThemeParams,
        setAppTheme: inst.setAppTheme, unmount: unmount };
    });
  }
  function unmount() {
    if (active) { try { active.unmount(); } catch (e) {} active = null; }
  }
  function setBooks(books) {
    if (active) active.setBooks(books);
  }
  function setTheme(themeKey) {
    if (active) active.setTheme(themeKey);
  }
  function setThemeParams(p) {
    if (active) active.setThemeParams(p);
  }
  function setAppTheme(key) {
    if (active) active.setAppTheme(key);
  }

  window.Shelf3D = { mount: mount, unmount: unmount, setBooks: setBooks, setTheme: setTheme,
    setThemeParams: setThemeParams, setAppTheme: setAppTheme };

})();
