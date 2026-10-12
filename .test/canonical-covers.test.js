// WebP cover adopter (v507): adoptCoverWebP loads a cover's pixels,
// transcodes to WebP on-device, uploads to the shared `covers` bucket
// under the SHA-256 of the WebP bytes, seeds the spine colour from the
// same pixels, and falls back to the ORIGINAL source on ANY failure —
// never throws, never returns empty. data: uploads convert too
// (Decision, 2026-10-12); canonical bucket URLs pass through untouched.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;

// jsdom has no WebCrypto subtle; browsers on https/localhost do.
try {
  Object.defineProperty(window, 'crypto',
    { value: require('crypto').webcrypto, configurable: true, writable: true });
} catch (e) { try { window.crypto = require('crypto').webcrypto; } catch (e2) {} }
if (!window.requestAnimationFrame) window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.fetch = async () => { throw new Error('no network in cover-adopter tests'); };

// ---- fake Supabase client (cloudClient() returns window.__sbStub) ----
let sessionOn = true;
let uploads = [];
let uploadBehavior = 'ok'; // 'ok' | 'dup' | 'denied' | 'throw'
window.__sbStub = {
  auth: { getSession: async () => ({ data: { session: sessionOn ? { user: { id: 'u1' } } : null } }) },
  storage: { from: (bucket) => ({
    upload: async (name, blob, opts) => {
      uploads.push({ bucket, name, blob, opts });
      if (uploadBehavior === 'dup') return { error: { statusCode: '409', message: 'The resource already exists' } };
      if (uploadBehavior === 'denied') return { error: { status: 403, message: 'new row violates row-level security policy' } };
      if (uploadBehavior === 'throw') throw new Error('storage exploded');
      return { error: null };
    },
    getPublicUrl: (name) => ({ data: { publicUrl: 'https://x.supabase.co/storage/v1/object/public/covers/' + name } }),
  }) },
};

// ---- fake Image: loads unless the per-test mode fn says error ----
let imgLoads = [];
let imgBehavior = () => true;
window.Image = class {
  constructor() {
    this.naturalWidth = 1200; this.naturalHeight = 1800;
    this.width = 1200; this.height = 1800;
  }
  set src(v) {
    const s = String(v);
    imgLoads.push(s);
    const okLoad = imgBehavior(s);
    setTimeout(() => {
      if (okLoad) { if (this.onload) this.onload(); }
      else if (this.onerror) this.onerror();
    }, 0);
  }
};

// ---- fake canvas: fixed red pixels (dominantHex -> '#ab0d0d'), stub toBlob ----
const fakePixels = new Uint8ClampedArray(24 * 24 * 4);
for (let i = 0; i < fakePixels.length; i += 4) {
  fakePixels[i] = 200; fakePixels[i + 1] = 30; fakePixels[i + 2] = 30; fakePixels[i + 3] = 255;
}
let blobType = 'image/webp';
let lastCanvasSize = null;
window.HTMLCanvasElement.prototype.getContext = function () {
  return { drawImage() {}, getImageData: () => ({ data: fakePixels }) };
};
window.HTMLCanvasElement.prototype.toBlob = function (cb, type) {
  lastCanvasSize = { w: this.width, h: this.height };
  setTimeout(() => cb(new window.Blob([new Uint8Array([1, 2, 3, 4])], { type: blobType })), 0);
};

require('./harness').loadApp(window);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };
const adopt = (u, b) => window.eval(`adoptCoverWebP(${JSON.stringify(u)}${b ? ', ' + JSON.stringify(b) : ''})`);
const BUCKET_RE = /^https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/covers\/[0-9a-f]{64}\.webp$/;
const reset = () => {
  uploads = []; imgLoads = []; uploadBehavior = 'ok'; imgBehavior = () => true;
  blobType = 'image/webp'; sessionOn = true; lastCanvasSize = null;
};

(async () => {
  ok('adopter is defined', await window.eval('typeof adoptCoverWebP') === 'function');
  ok('v216 canonicalizer is retired', await window.eval('typeof canonicalizeCoverUrl') === 'undefined');

  // ---- pass-throughs: zero network, zero uploads ----
  reset();
  const canonJpg = 'https://x.supabase.co/storage/v1/object/public/covers/abc123.jpg';
  const canonWebp = 'https://x.supabase.co/storage/v1/object/public/covers/abc123.webp';
  ok('canonical .jpg bucket URL passes through', await adopt(canonJpg) === canonJpg);
  ok('canonical .webp bucket URL passes through', await adopt(canonWebp) === canonWebp);
  ok('empty string passes through', await adopt('') === '');
  ok('non-string passes through', await adopt(null) === null);
  ok('blob: URL passes through', await adopt('blob:https://x/1') === 'blob:https://x/1');
  ok('pass-throughs made no loads or uploads', imgLoads.length === 0 && uploads.length === 0);

  // ---- remote success: proxy first, WebP into the bucket, colour seeded ----
  reset();
  const remote = 'https://img.hardcover.app/hc1.jpg';
  const book = { id: 'bk1', title: 'Remote' };
  const got = await adopt(remote, book);
  ok('remote cover adopts to a bucket .webp URL', BUCKET_RE.test(got));
  ok('pixels came through the same-origin proxy first',
    imgLoads.length === 1 && imgLoads[0] === '/cover-proxy?url=' + encodeURIComponent(remote));
  ok('one upload, WebP content type, no upsert',
    uploads.length === 1 && uploads[0].bucket === 'covers' &&
    uploads[0].opts.contentType === 'image/webp' && uploads[0].opts.upsert === false);
  ok('canvas capped at 600px wide, aspect kept',
    lastCanvasSize && lastCanvasSize.w === 600 && lastCanvasSize.h === 900);
  const seeded = await window.eval(`spineColorCache['bk1']`);
  ok('spine colour seeded at ingest against the bucket URL',
    seeded && seeded.hex === '#ab0d0d' && seeded.cover === got);
  const persisted = JSON.parse(window.localStorage.getItem('spicyshelves.spinecolors') || '{}');
  ok('seeded colour persisted', persisted.bk1 && persisted.bk1.hex === '#ab0d0d');

  // ---- data: upload success: pixels local, no proxy, still bucketed ----
  reset();
  const dataUrl = 'data:image/jpeg;base64,AAAA';
  const gotData = await adopt(dataUrl, { id: 'bk2', title: 'Upload' });
  ok('data: upload adopts to a bucket .webp URL', BUCKET_RE.test(gotData));
  ok('data: loads directly, never via the proxy',
    imgLoads.length === 1 && imgLoads[0] === dataUrl && uploads.length === 1);

  // ---- failure modes: the original source survives every one ----
  reset();
  imgBehavior = (s) => !s.includes('dead');
  ok('all pixel sources dead -> remote URL kept',
    await adopt('https://x/dead.jpg') === 'https://x/dead.jpg' && uploads.length === 0);

  reset();
  imgBehavior = (s) => !(s.startsWith('/cover-proxy') && s.includes('proxydead'));
  const viaDirect = await adopt('https://x/proxydead.jpg');
  ok('proxy dead but direct CORS loads -> still adopts', BUCKET_RE.test(viaDirect));
  ok('sources tried in order: proxy, then direct',
    imgLoads.length === 2 && imgLoads[0].startsWith('/cover-proxy?url=') &&
    imgLoads[1] === 'https://x/proxydead.jpg');

  reset();
  uploadBehavior = 'dup';
  ok('duplicate upload (409) is a dedup hit -> bucket URL',
    BUCKET_RE.test(await adopt('https://img.hardcover.app/dup.jpg')));

  reset();
  uploadBehavior = 'denied';
  ok('upload denied (policy not migrated) -> remote URL kept',
    await adopt('https://img.hardcover.app/denied.jpg') === 'https://img.hardcover.app/denied.jpg');

  reset();
  uploadBehavior = 'throw';
  ok('upload throws -> remote URL kept, adopter never throws',
    await adopt('https://img.hardcover.app/boom.jpg') === 'https://img.hardcover.app/boom.jpg');

  reset();
  blobType = 'image/png'; // a browser that silently substitutes the encode
  ok('non-WebP blob -> remote URL kept, nothing stored',
    await adopt('https://img.hardcover.app/png.jpg') === 'https://img.hardcover.app/png.jpg' &&
    uploads.length === 0);

  // ---- signed out: gate fires before any pixel work ----
  reset();
  sessionOn = false;
  ok('signed out -> remote URL kept',
    await adopt('https://img.hardcover.app/out.jpg') === 'https://img.hardcover.app/out.jpg');
  ok('signed out made no loads or uploads', imgLoads.length === 0 && uploads.length === 0);

  // ---- kill-switch: pass-through, no work at all ----
  reset();
  window.localStorage.setItem('cozylibram.coverWebp', 'off');
  ok('kill-switch -> remote URL kept',
    await adopt('https://img.hardcover.app/kill.jpg') === 'https://img.hardcover.app/kill.jpg');
  ok('kill-switch made no loads or uploads', imgLoads.length === 0 && uploads.length === 0);
  window.localStorage.removeItem('cozylibram.coverWebp');

  // ---- inflight dedup: two books, one cover, one upload, both seeded ----
  reset();
  const shared = 'https://img.hardcover.app/shared.jpg';
  const [r1, r2] = await Promise.all([
    adopt(shared, { id: 'bkA', title: 'A' }),
    adopt(shared, { id: 'bkB', title: 'B' }),
  ]);
  ok('concurrent adopts of one URL -> one upload', uploads.length === 1);
  ok('both callers get the same bucket URL', r1 === r2 && BUCKET_RE.test(r1));
  const seedA = await window.eval(`spineColorCache['bkA']`);
  const seedB = await window.eval(`spineColorCache['bkB']`);
  ok('both books seeded from the shared adoption',
    seedA && seedA.cover === r1 && seedB && seedB.cover === r2);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
