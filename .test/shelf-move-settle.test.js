// v515: moved decorations must settle onto their claimed spot.
// Regression: the move-drag ghost follows the RAW pointer x while the
// placed record (and snap guide) hold the claimed landing (findFreeSpot's
// gap, or the clamped claim on a full level). Before v515 the drop tween
// animated only scale + Y — the mesh stayed wedged at the finger x while
// reflowBooks() flowed the books around the record's interval and
// saveDecoLayout() persisted the mesh x. Device report: candle dragged
// between books stayed stuck behind them; books never readjusted.
//
// These tests mount the REAL engine (js/215) behind a fake THREE (the
// vendored three.module.js is an ES module the jsdom harness can't load,
// and jsdom has no WebGL), restore a saved candle through the normal
// loadDecoLayout path, then drive synthetic pointer drags: raycast
// results are scripted via THREE.__rayHook (decoAt on pointerdown,
// zoneHit during the move), frames advance via the harness rAF polyfill.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const ROOT = process.env.BOOKTOK_DIR || '/home/hatch/workspace/booktok';
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
// pretendToBeVisual: jsdom otherwise reports document.hidden === true and
// the engine's frame loop (which steps every tween) skips each frame.
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true });
const window = dom.window;

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 0.02);

/* ---------- fake 2d canvas context (jsdom has no canvas package) ---------- */
function fakeCtx2D(canvas) {
  const store = { canvas: canvas };
  return new Proxy(store, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 12 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient')
        return () => ({ addColorStop() {} });
      if (p === 'getImageData')
        return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}
window.HTMLCanvasElement.prototype.getContext = function (kind) {
  return kind === '2d' ? fakeCtx2D(this) : null;
};

/* ---------- fake THREE ---------- */
function buildFakeTHREE() {
  class V3 {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = (z === undefined ? this.z : z); return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    setScalar(s) { this.x = s; this.y = s; this.z = s; return this; }
    setLength(l) { return this.normalize().multiplyScalar(l); }
    applyQuaternion() { return this; }
    applyMatrix4() { return this; }
    transformDirection() { return this; }
    length() { return Math.hypot(this.x, this.y, this.z); }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
    negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
    project() { return this; }
    unproject() { return this; }
    applyEuler() { return this; }
    setFromSphericalCoords() { return this; }
  }
  class V2 {
    constructor(x, y) { this.x = x || 0; this.y = y || 0; }
    set(x, y) { this.x = x; this.y = y; return this; }
    copy(v) { this.x = v.x; this.y = v.y; return this; }
    clone() { return new V2(this.x, this.y); }
  }
  class Color {
    constructor(c) { this._c = c; }
    set(c) { this._c = c; return this; }
    setHex() { return this; }
    setHSL() { return this; }
    clone() { return new Color(this._c); }
    copy() { return this; }
    multiplyScalar() { return this; }
    offsetHSL() { return this; }
    lerp() { return this; }
    getHexString() { return '000000'; }
  }
  class Obj {
    constructor() {
      this.position = new V3(); this.scale = new V3(1, 1, 1); this.rotation = new V3();
      this.children = []; this.userData = {}; this.visible = true; this.parent = null;
      this.isObject3D = true;
    }
    add() {
      for (const o of arguments) { if (o && o !== this) { o.parent = this; this.children.push(o); } }
      return this;
    }
    remove() {
      for (const o of arguments) {
        const i = this.children.indexOf(o);
        if (i >= 0) this.children.splice(i, 1);
        if (o) o.parent = null;
      }
      return this;
    }
    traverse(cb) { cb(this); this.children.slice().forEach(c => { if (c && c.traverse) c.traverse(cb); }); }
    getWorldDirection(v) { if (v) v.set(0, 0, -1); return v; }
    lookAt() {}
    updateMatrixWorld() {}
  }
  class Scene extends Obj { constructor() { super(); this.isScene = true; T.__scenes.push(this); } }
  class Group extends Obj {}
  class Mesh extends Obj {
    constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; this.isMesh = true; }
  }
  class Points extends Obj {
    constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; this.isPoints = true; }
  }
  class LineSeg extends Obj {
    constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; this.isLine = true; }
  }
  class Sprite extends Obj {
    constructor(mat) { super(); this.material = mat; this.isSprite = true; }
  }
  class Light extends Obj {
    constructor(color, intensity) {
      super();
      this.color = (color instanceof Color) ? color : new Color(color);
      this.intensity = (intensity === undefined ? 1 : intensity);
      this.shadow = { mapSize: new V2(512, 512), camera: {}, bias: 0, normalBias: 0 };
      this.isLight = true;
    }
  }
  class Camera extends Obj {
    constructor(fov, aspect, near, far) {
      super(); this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
      this.projectionMatrix = null;
    }
    updateProjectionMatrix() {}
  }
  class WebGLRenderer {
    constructor(opts) {
      this.domElement = (opts && opts.canvas) || null;
      this.shadowMap = {};
    }
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render() {}
    dispose() {}
  }
  class Raycaster {
    constructor() {
      this.ray = { intersectPlane: function () { return null; } };
    }
    setFromCamera() {}
    intersectObjects(objs) {
      if (typeof T.__rayHook === 'function') return T.__rayHook(objs) || [];
      return [];
    }
    intersectObject(o) { return this.intersectObjects([o]); }
  }
  class Plane {
    setFromNormalAndCoplanarPoint() { return this; }
    setFromCoplanarPoints() { return this; }
  }
  class Clock { getElapsedTime() { return 0; } getDelta() { return 0; } }
  class CanvasTexture {
    constructor(canvas) {
      this.image = canvas; this.isTexture = true;
      this.repeat = new V2(1, 1); this.offset = new V2(); this.center = new V2();
      this.rotation = 0;
    }
    dispose() {}
  }
  const genCache = {};
  function genericClass(name) {
    if (genCache[name]) return genCache[name];
    const cls = class {
      constructor() {
        const a = arguments;
        if (name === 'BoxGeometry') this.parameters = { width: a[0], height: a[1], depth: a[2] };
        if (/Geometry$/.test(name)) { this.attributes = {}; }
        if (a[0] && (Array.isArray(a[0]) || ArrayBuffer.isView(a[0]))) this.array = a[0];
        if (/Material$/.test(name)) {
          this.color = new Color(0); this.emissive = new Color(0);
          if (a[0] && typeof a[0] === 'object') Object.assign(this, a[0]);
        }
      }
      setAttribute(n, attr) { this.attributes[n] = attr; return this; }
      getAttribute(n) { return this.attributes[n]; }
      setFromPoints() { return this; }
      computeVertexNormals() { return this; }
      dispose() {}
      clone() { return this; }
      copy() { return this; }
    };
    genCache[name] = cls;
    return cls;
  }
  const impl = {
    __scenes: [], __rayHook: null,
    Vector3: V3, Vector2: V2, Color: Color,
    Scene: Scene, Group: Group, Mesh: Mesh, Points: Points,
    LineSegments: LineSeg, Line: LineSeg, Sprite: Sprite,
    AmbientLight: Light, HemisphereLight: Light, DirectionalLight: Light,
    PointLight: Light, SpotLight: Light,
    PerspectiveCamera: Camera, OrthographicCamera: Camera,
    WebGLRenderer: WebGLRenderer, Raycaster: Raycaster, Plane: Plane,
    Clock: Clock, CanvasTexture: CanvasTexture, Texture: CanvasTexture,
    Fog: class { constructor(c, n, f) { this.color = c; this.near = n; this.far = f; } },
    MathUtils: {
      clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
      lerp: (a, b, k) => a + (b - a) * k,
      degToRad: (d) => d * Math.PI / 180,
      radToDeg: (r) => r * 180 / Math.PI,
      mapLinear: (v, a, b, c, d) => c + (v - a) * (d - c) / (b - a)
    },
    SRGBColorSpace: 'srgb', PCFShadowMap: 1, PCFSoftShadowMap: 2,
    ACESFilmicToneMapping: 3, AdditiveBlending: 4, DoubleSide: 5,
    FrontSide: 6, BackSide: 7, RepeatWrapping: 8, ClampToEdgeWrapping: 9
  };
  const T = new Proxy(impl, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p !== 'string') return undefined;
      if (p === 'then') return undefined;   // Promise.resolve(THREE) must not see a thenable
      return genericClass(p);
    },
    set(t, p, v) { t[p] = v; return true; }
  });
  return T;
}
const THREE = buildFakeTHREE();
window.THREE = THREE;

/* raycast scripting: 'deco' answers decoAt (pointerdown), 'zone' answers
   zoneHit (the drag's per-frame raycast) with a chosen level + world x. */
let rayMode = { kind: 'none' };
THREE.__rayHook = function (objs) {
  if (rayMode.kind === 'deco') {
    const g = (objs || []).find(o => o && o.userData && o.userData.decoType === rayMode.type);
    return g ? [{ object: g, point: new THREE.Vector3(0, 0, 0) }] : [];
  }
  if (rayMode.kind === 'zone') {
    const z = (objs || []).find(o => o && o.userData && typeof o.userData.pi === 'number');
    return z ? [{ object: { userData: { pi: rayMode.pi } }, point: new THREE.Vector3(rayMode.x, 0, 0) }] : [];
  }
  return [];
};

require('./harness').loadApp(window);

/* ---------- shared scenario plumbing ---------- */
const LEVELS = [0.64, 3.64, 6.64];
const BW = 31 / 70;          // deterministic spine width (19 per unobstructed level)
const CANDLE_FW = 0.55;
const books = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'bk' + i, title: 'Book ' + i, spineC1: '#334455', spineC2: '#667788', spineW: BW, spineH: 2
}));
const origMatchMedia = window.matchMedia;

async function mountShelf(bookList, decoCases) {
  window.localStorage.clear();
  if (decoCases) {
    window.localStorage.setItem('cozylibram.s3d.deco.v2',
      JSON.stringify({ v: 2, cases: decoCases }));
  }
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const handle = await window.Shelf3D.mount(container,
    { appTheme: 'dark', caseKey: 'tbr:0', initialBooks: bookList });
  const scene = THREE.__scenes[THREE.__scenes.length - 1];
  return { container: container, handle: handle, scene: scene, canvas: container.querySelector('canvas') };
}
function unmountShelf(m) {
  try { window.Shelf3D.unmount(); } catch (e) {}
  if (m && m.container && m.container.parentNode) m.container.parentNode.removeChild(m.container);
  rayMode = { kind: 'none' };
  window.matchMedia = origMatchMedia;
}
function allObjs(scene) { const out = []; scene.traverse(o => out.push(o)); return out; }
function findDeco(scene, type) {
  return allObjs(scene).find(o => o.userData && o.userData.decoType === type) || null;
}
function bookInfo(scene) {
  return allObjs(scene)
    .filter(o => o.userData && o.userData.bookId != null)
    .map(m => {
      const base = m.position.y - 1;   // spineH 2 -> centre y = LEVELS[li] + 1
      let li = 0, bd = 1e9;
      LEVELS.forEach((y, i) => { const d = Math.abs(y - base); if (d < bd) { bd = d; li = i; } });
      return { li: li, a: m.position.x - BW / 2, b: m.position.x + BW / 2 };
    });
}
function overlapsOnLevel(scene, li, a, b) {
  return bookInfo(scene).some(r => r.li === li && a < r.b - 1e-9 && b > r.a + 1e-9);
}
function savedDeco() {
  try {
    const d = JSON.parse(window.localStorage.getItem('cozylibram.s3d.deco.v2') || 'null');
    const list = (d && d.cases && d.cases['tbr:0']) || [];
    return list.find(x => x.type === 'candle') || null;
  } catch (e) { return null; }
}
/* One full drag: grab the candle, move it (scripted zone hit), drop.
   Returns after the settle + reflow have run to completion. */
async function dragCandle(m, pi, rawX, settleMs) {
  rayMode = { kind: 'deco', type: 'candle' };
  m.canvas.dispatchEvent(new window.MouseEvent('pointerdown',
    { bubbles: true, clientX: 100, clientY: 100 }));
  rayMode = { kind: 'zone', pi: pi, x: rawX };
  window.dispatchEvent(new window.MouseEvent('pointermove',
    { bubbles: true, clientX: 170, clientY: 100 }));
  await sleep(90);   // frames: processDragFrame claims the spot, ghost follows raw x
  window.dispatchEvent(new window.MouseEvent('pointerup',
    { bubbles: true, clientX: 170, clientY: 100 }));
  await sleep(settleMs === undefined ? 650 : settleMs);
}


/* ---------- scenarios ---------- */
(async function main() {

  /* ----- A: a free gap exists elsewhere on the level -----
     25 books: top level packs around the seeded candle, middle level is
     partly filled from the left with a wide free run to the right. The
     candle is dropped at raw x -3.0 — inside the middle level's book run
     (wedged). findFreeSpot claims a gap in the free run instead; the mesh
     must settle THERE, books must flow around that interval, and the
     saved layout must agree with the mesh. */
  {
    const m = await mountShelf(books(25), { 'tbr:0': [{ type: 'candle', pi: 2, x: -3.5, room: false }] });
    const candle = findDeco(m.scene, 'candle');
    ok('A: candle restored on the top level at its saved x',
      !!candle && near(candle.position.x, -3.5, 0.01) && near(candle.position.y, LEVELS[2], 0.01));
    ok('A: 25 books on the case', bookInfo(m.scene).length === 25);

    await dragCandle(m, 1, -3.0);
    ok('A: candle moved to the middle level', near(candle.position.y, LEVELS[1], 0.01));
    ok('A: candle did NOT stay at the raw drop x (-3.0)', !near(candle.position.x, -3.0, 0.05));
    ok('A: candle settled in the free run right of the packed books', candle.position.x > -1.2);
    ok('A: no book overlaps the candle interval on its level',
      !overlapsOnLevel(m.scene, 1, candle.position.x - CANDLE_FW / 2, candle.position.x + CANDLE_FW / 2));
    const sv = savedDeco();
    ok('A: saved layout agrees (x == mesh x, pi == 1)',
      !!sv && sv.pi === 1 && near(sv.x, candle.position.x, 1e-9));
    unmountShelf(m);
  }

  /* ----- B: drop on a FULL level — the claim is the clamped drop x -----
     57 books pack the case completely; no gap anywhere on the top level.
     Dropping beyond the shelf edge (raw 4.6) claims the clamped spot
     (4.275); the mesh must end there (not at the finger x), with the
     displaced books flowed out of its interval. */
  {
    const m = await mountShelf(books(57), { 'tbr:0': [{ type: 'candle', pi: 1, x: 0, room: false }] });
    const candle = findDeco(m.scene, 'candle');
    ok('B: candle restored on the middle level', !!candle && near(candle.position.y, LEVELS[1], 0.01));

    await dragCandle(m, 2, 4.6);
    ok('B: candle settled at the clamped claim (4.275), not the finger x (4.6)',
      near(candle.position.x, 4.275, 0.01) && near(candle.position.y, LEVELS[2], 0.01));
    ok('B: candle interval is book-free on the top level',
      !overlapsOnLevel(m.scene, 2, candle.position.x - CANDLE_FW / 2, candle.position.x + CANDLE_FW / 2));
    const sv = savedDeco();
    ok('B: saved layout agrees (x == mesh x, pi == 2)',
      !!sv && sv.pi === 2 && near(sv.x, candle.position.x, 1e-9));
    unmountShelf(m);
  }

  /* ----- C: pointercancel restores record + mesh to the origin ----- */
  {
    const m = await mountShelf(books(25), { 'tbr:0': [{ type: 'candle', pi: 2, x: -3.5, room: false }] });
    const candle = findDeco(m.scene, 'candle');
    rayMode = { kind: 'deco', type: 'candle' };
    m.canvas.dispatchEvent(new window.MouseEvent('pointerdown',
      { bubbles: true, clientX: 100, clientY: 100 }));
    rayMode = { kind: 'zone', pi: 1, x: -3.0 };
    window.dispatchEvent(new window.MouseEvent('pointermove',
      { bubbles: true, clientX: 170, clientY: 100 }));
    await sleep(90);
    window.dispatchEvent(new window.MouseEvent('pointercancel', { bubbles: true }));
    await sleep(120);
    ok('C: cancel returns the candle to its original spot',
      near(candle.position.x, -3.5, 0.01) && near(candle.position.y, LEVELS[2], 0.01));
    const sv = savedDeco();
    ok('C: saved layout untouched by the cancelled drag',
      !!sv && sv.pi === 2 && near(sv.x, -3.5, 1e-9));
    ok('C: books unchanged (still 25, candle interval book-free)',
      bookInfo(m.scene).length === 25 &&
      !overlapsOnLevel(m.scene, 2, -3.5 - CANDLE_FW / 2, -3.5 + CANDLE_FW / 2));
    unmountShelf(m);
  }

  /* ----- D: reduced motion — the settle snaps, same end state ----- */
  {
    const m = await mountShelf(books(25), { 'tbr:0': [{ type: 'candle', pi: 2, x: -3.5, room: false }] });
    const candle = findDeco(m.scene, 'candle');
    window.matchMedia = function (q) {
      return { matches: /prefers-reduced-motion/.test(q), media: q,
        addEventListener: function () {}, removeEventListener: function () {},
        addListener: function () {}, removeListener: function () {} };
    };
    await dragCandle(m, 1, -3.0, 250);
    ok('D: reduced-motion drop still lands on the claim, not the raw x',
      near(candle.position.y, LEVELS[1], 0.01) && !near(candle.position.x, -3.0, 0.05) &&
      candle.position.x > -1.2);
    ok('D: no book overlaps the candle interval',
      !overlapsOnLevel(m.scene, 1, candle.position.x - CANDLE_FW / 2, candle.position.x + CANDLE_FW / 2));
    const sv = savedDeco();
    ok('D: saved layout agrees (x == mesh x, pi == 1)',
      !!sv && sv.pi === 1 && near(sv.x, candle.position.x, 1e-9));
    unmountShelf(m);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error('ERROR', e && e.stack || e);
  process.exit(1);
});
