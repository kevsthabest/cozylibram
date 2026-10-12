'use strict';

/* ---- Cover picker (v47): some imports/scans end up with a photo of the
   physical book instead of clean cover art. The 🖼️ button on the book modal
   opens a picker with candidate covers (Google Books editions + every cover
   Open Library has for the work), plus an upload-your-own option. ---- */

const coverCandidateCache = new Map(); // isbn-or-title key -> [{url, label}] (excludes "current")

function httpsCover(u) {
  return String(u || '').replace(/^http:/, 'https:');
}

// Apple Books (iTunes Search API — free, no key). Artwork comes back at
// 100x100; the same CDN serves larger sizes, so ask for 600x600.
async function appleBookCovers(term, freshPush) {
  try {
    const r = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(term) +
      '&media=ebook&entity=ebook&limit=8');
    const d = await r.json();
    (d.results || []).forEach(x => {
      const u = String(x.artworkUrl100 || '').replace(/\d+x\d+bb\.jpg$/, '600x600bb.jpg');
      if (u) freshPush(u, 'Apple Books');
    });
  } catch (e) { /* Apple unreachable */ }
}

// Hardcover edition cover art — only when the home-server token is set.
async function hardcoverCover(isbn, freshPush) {
  if (typeof hcReady !== 'function' || !hcReady()) return;
  try {
    const q = 'query { editions(where: {isbn_13: {_eq: ' + JSON.stringify(isbn) +
      '}}, limit: 8) { image { url } } }';
    const data = await hcGraphQL(q);
    ((data || {}).editions || []).forEach(e => {
      const u = e && e.image && e.image.url;
      if (u) freshPush(u, 'Hardcover');
    });
  } catch (e) { /* token/query issue — skip silently */ }
}

// Every candidate cover for this book: current first, then Hardcover's
// edition art, Apple Books artwork, all Open Library covers for the edition
// and its work, and Google Books edition thumbnails last. Deduped.
async function fetchCoverCandidates(book) {
  const seen = new Set();
  const out = [];
  const push = (url, label) => {
    url = httpsCover(url);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url: url, label: label });
  };
  if (book.cover) push(book.cover, 'Current');
  const isbn = cleanISBN(book.isbn);
  const cacheKey = isbn || ('t:' + normTitle(book.title) + '|' + (book.authors || []).join(',').toLowerCase());
  const cached = coverCandidateCache.get(cacheKey);
  if (cached) { cached.forEach(c => push(c.url, c.label)); return out; }
  const fresh = [];
  const freshPush = (url, label) => {
    url = httpsCover(url);
    if (!url || fresh.some(c => c.url === url)) return;
    fresh.push({ url: url, label: label });
    push(url, label);
  };
  if (isbn) {
    await hardcoverCover(isbn, freshPush);
    try {
      const r = await fetch(gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=isbn:' +
        encodeURIComponent(isbn) + '&maxResults=8'));
      const d = await r.json();
      (d.items || []).forEach(it => {
        const il = ((it || {}).volumeInfo || {}).imageLinks || {};
        freshPush(il.thumbnail || il.smallThumbnail, 'Google Books');
      });
    } catch (e) { /* Google Books unreachable — others may still work */ }
    await appleBookCovers('isbn:' + isbn, freshPush);
    try {
      const ed = await (await fetch('https://openlibrary.org/isbn/' + isbn + '.json')).json();
      (ed.covers || []).forEach(id =>
        freshPush('https://covers.openlibrary.org/b/id/' + id + '-L.jpg', 'Open Library'));
      const wkey = ed && ed.works && ed.works[0] && ed.works[0].key;
      if (wkey) {
        const w = await (await fetch('https://openlibrary.org' + wkey + '.json')).json();
        (w.covers || []).forEach(id =>
          freshPush('https://covers.openlibrary.org/b/id/' + id + '-L.jpg', 'Open Library'));
      }
    } catch (e) { /* no OL covers */ }
  } else {
    try {
      const q = 'https://openlibrary.org/search.json?q=' +
        encodeURIComponent(String(book.title || '') + ' ' + (book.authors || []).join(' ')) +
        '&fields=cover_i&limit=8';
      const d = await (await fetch(q)).json();
      (d.docs || []).forEach(doc => {
        if (doc.cover_i) freshPush('https://covers.openlibrary.org/b/id/' + doc.cover_i + '-L.jpg', 'Open Library');
      });
    } catch (e) { /* offline */ }
    await appleBookCovers(String(book.title || '') + ' ' + (book.authors || []).join(' '), freshPush);
  }
  coverCandidateCache.set(cacheKey, fresh);
  return out;
}

// Downscale an uploaded image to a data URL small enough for localStorage.
function fileToCoverDataURL(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const S = 512, scale = Math.min(1, S / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.85));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read that image')); };
    img.src = url;
  });
}

let coverPickerToken = null; // v220: history entry for the back-gesture
function closeCoverPickerDom() { // v220: DOM-only teardown
  const ov = document.getElementById('cover-picker');
  if (ov) ov.remove();
}
function closeCoverPicker() {
  if (coverPickerToken) { overlayClosed(coverPickerToken); coverPickerToken = null; } // v220
  closeCoverPickerDom();
}

// v507: WebP cover adopter (replaces the v216 canonicalizeCoverUrl, whose
// server-side adoption stored provider ORIGINALS in the shared bucket).
// Stored images default to WebP (Decision, 2026-10-12): the device loads
// the cover's pixels, transcodes them itself, and uploads the WebP bytes
// to the shared Supabase `covers` bucket under their SHA-256 name — one
// object per distinct image, whoever adopts it first. User uploads
// (data: URLs) convert and bucket too (same Decision) — that also keeps
// image bytes out of book records and sync payloads entirely.
//
// Contract, identical in spirit to v216's: returns the URL the book
// should carry — the bucket WebP URL on success, the ORIGINAL source on
// ANY failure (proxy down, dead provider, non-WebP encode, upload
// denied, signed out, offline, kill-switch). Never throws, never
// returns empty, and choosing/adding a cover never blocks on it
// beyond the await the call sites already had. Already-canonical
// bucket URLs pass through untouched.
const COVER_WEBP_MAX_W = 600; // px wide cap, never upscale (v218 size class)
const COVER_WEBP_MAX_PX = 2000000; // total decoded-pixel cap (Advisor follow-up: width-only caps let a tall sliver allocate a huge canvas)
const COVER_WEBP_MAX_DATA_LEN = 7 * 1024 * 1024; // data: source length cap (~5 MB binary; legit producers are ≤512px)
const coverAdoptInflight = new Map(); // source URL -> Promise<{url, hex}|null>
const coverAdoptWaiters = [];         // queued {url, resolve}
let coverAdoptActive = 0;
let coverAdoptLastStart = 0;
let coverAdoptDenyLogged = false;     // upload-denial AppLog: once per session

function coverWebpDisabled() {
  try { return localStorage.getItem('cozylibram.coverWebp') === 'off'; } catch (e) { return false; }
}
function isCanonicalCoverUrl(url) {
  return typeof url === 'string' &&
    url.indexOf('/storage/v1/object/public/covers/') !== -1;
}

// The signed-in Supabase client, or null when adoption cannot run at all
// (cloud not configured, signed out, storage unavailable). Checked before
// any pixel work so a signed-out device pays nothing.
async function coverWebpClient() {
  try {
    if (typeof cloudClient !== 'function') return null;
    const sb = await cloudClient();
    if (!sb || !sb.storage || typeof sb.storage.from !== 'function') return null;
    if (sb.auth && typeof sb.auth.getSession === 'function') {
      const s = await sb.auth.getSession().catch(() => null);
      if (!s || !s.data || !s.data.session) return null; // signed out
    }
    return sb;
  } catch (e) { return null; }
}

// Load one pixel source into an Image element; resolves the element, or
// null on error/timeout. (coverImageHex in js/120 is the same shape, but
// resolves only the sampled hex — the adopter needs the image itself.)
function coverLoadImage(src, useCors) {
  return new Promise(resolve => {
    let settled = false;
    const done = (img) => { if (!settled) { settled = true; resolve(img); } };
    try {
      const img = new Image();
      if (useCors) img.crossOrigin = 'anonymous';
      img.onload = () => done(img);
      img.onerror = () => done(null);
      setTimeout(() => done(null), 15000);
      img.src = src;
    } catch (e) { done(null); }
  });
}

// The cover's pixels as a loaded image. Remote URLs try the sampler's
// ordered sources (same-origin proxy first, then direct-with-CORS where
// the host allows it); data: URLs are already local and load directly.
async function coverPixelsImage(url) {
  if (url.indexOf('data:') === 0) return coverLoadImage(url, false);
  const sources = (typeof coverColorSources === 'function')
    ? coverColorSources(url) : [[url, false]];
  for (let i = 0; i < sources.length; i++) {
    const img = await coverLoadImage(sources[i][0], sources[i][1]);
    if (img) return img;
  }
  return null;
}

function coverUploadIsDup(err) {
  if (!err) return false;
  const sc = err.statusCode != null ? err.statusCode : err.status;
  if (sc === 409 || sc === '409') return true;
  return /already exists|duplicate/i.test(String(err.message || ''));
}
function coverHexOf(buf) {
  return Array.from(new Uint8Array(buf),
    b => b.toString(16).padStart(2, '0')).join('');
}

// One adoption job: pixels → WebP → bucket. Resolves {url, hex} (hex =
// the cover's dominant colour sampled from the same pixels, may be
// null), or null on any failure — the caller keeps the original source.
async function coverWebpConvert(url) {
  try {
    if (url.indexOf('data:') === 0 && url.length > COVER_WEBP_MAX_DATA_LEN) return null;
    const sb = await coverWebpClient();
    if (!sb) return null;
    const img = await coverPixelsImage(url);
    if (!img) return null;
    const nw = img.naturalWidth || img.width || 0;
    const nh = img.naturalHeight || img.height || 0;
    if (!nw || !nh) return null;
    // Spine colour from the pixels already in hand (js/120's sampler);
    // a tainted read just means no seed — the painters retry later.
    let hex = null;
    try { hex = (typeof dominantHex === 'function') ? dominantHex(img) : null; }
    catch (e) { hex = null; }
    const scale = Math.min(1, COVER_WEBP_MAX_W / nw,
      Math.sqrt(COVER_WEBP_MAX_PX / (nw * nh)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(nw * scale));
    c.height = Math.max(1, Math.round(nh * scale));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    // A browser that cannot encode WebP silently substitutes another
    // format in toBlob — anything that is not WebP is a failure, never
    // a mislabelled object (the throw here also catches tainted pixels).
    const blob = await new Promise(res => {
      let settled = false;
      const fin = (b) => { if (!settled) { settled = true; res(b); } };
      try { c.toBlob(fin, 'image/webp', 0.85); } catch (e) { fin(null); }
      setTimeout(() => fin(null), 10000);
    });
    if (!blob || blob.type !== 'image/webp') return null;
    const bytes = await blob.arrayBuffer();
    if (!bytes || !bytes.byteLength) return null;
    const name = coverHexOf(await crypto.subtle.digest('SHA-256', bytes)) + '.webp';
    const up = await sb.storage.from('covers').upload(name, blob,
      { contentType: 'image/webp', upsert: false });
    if (up && up.error && !coverUploadIsDup(up.error)) {
      // Policy not migrated yet / denied: diagnosable, not silent-looped.
      if (!coverAdoptDenyLogged) {
        coverAdoptDenyLogged = true;
        AppLog.error('cover', 'WebP adoption upload denied: ' +
          ((up.error && up.error.message) || 'unknown error'));
      }
      return null;
    }
    const pub = sb.storage.from('covers').getPublicUrl(name);
    const publicUrl = pub && pub.data && pub.data.publicUrl;
    if (typeof publicUrl !== 'string' || publicUrl.indexOf('https://') !== 0) return null;
    AppLog.info('cover', 'cover adopted as WebP to the shared bucket');
    return { url: publicUrl, hex: hex };
  } catch (e) {
    return null;
  }
}

// Modest queue: max 2 adoptions at once, ~350 ms between starts (the
// bulk filler's politeness, shared by every adoption caller).
function coverAdoptPump() {
  while (coverAdoptActive < 2 && coverAdoptWaiters.length) {
    const job = coverAdoptWaiters.shift();
    coverAdoptActive++;
    const wait = Math.max(0, 350 - (Date.now() - coverAdoptLastStart));
    setTimeout(() => {
      coverAdoptLastStart = Date.now();
      coverWebpConvert(job.url)
        .then(r => job.resolve(r), () => job.resolve(null))
        .then(() => { coverAdoptActive--; coverAdoptPump(); });
    }, wait);
  }
}
function coverAdoptSchedule(url) {
  const hit = coverAdoptInflight.get(url);
  if (hit) return hit;
  const p = new Promise(resolve => {
    coverAdoptWaiters.push({ url: url, resolve: resolve });
    coverAdoptPump();
  });
  coverAdoptInflight.set(url, p);
  p.then(() => { if (coverAdoptInflight.get(url) === p) coverAdoptInflight.delete(url); });
  return p;
}

// adoptCoverWebP(url, book?) → the URL the book should carry. When a
// book is attached and the cover was sampled during ingest, its spine
// colour is seeded against the NEW bucket URL, so adopted covers never
// need the network sampler (the exact cache write the painters make).
async function adoptCoverWebP(url, book) {
  try {
    if (!url || typeof url !== 'string') return url;
    if (isCanonicalCoverUrl(url)) return url;
    if (url.indexOf('data:') !== 0 && !/^https?:\/\//i.test(url)) return url;
    if (coverWebpDisabled()) return url; // kill-switch: app behaves as v506
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return url;
    const r = await coverAdoptSchedule(url);
    if (!r || !r.url) return url;
    if (book && book.id && r.hex &&
        typeof spineColorCache !== 'undefined' &&
        typeof saveSpineColorCache === 'function') {
      try {
        spineColorCache[book.id] = { hex: r.hex, cover: r.url };
        saveSpineColorCache();
      } catch (e) { /* cache seed is a bonus, never a blocker */ }
    }
    return r.url;
  } catch (e) {
    return url;
  }
}

async function chooseCover(bookId, url) {
  const b = library.find(x => x.id === bookId);
  if (!b || !url) return;
  b.cover = await adoptCoverWebP(url, b);
  b._mtime = Date.now();
  saveLibrary();
  /* v167: trace the cover change end to end — the log shows whether the
     follow-up cloud push actually ran. */
  AppLog.info('cover', 'cover set for "' + (b.title || bookId) + '"' +
    (url.indexOf('data:') === 0 ? ' (uploaded image)' : ''));
  closeCoverPicker();
  // v174: the modal hero cover (was .modal-head .cover-wrap pre-tabs).
  const wrap = document.querySelector('#modal-root .d-cover .cover-wrap') ||
               document.querySelector('#modal-root .modal-head .cover-wrap');
  if (wrap) wrap.outerHTML = coverHTML(b, 'd-cov');
  render(); // refresh the shelf behind the modal
  toast('🖼️ Cover updated');
}

function openCoverPicker(bookId) {
  const b = library.find(x => x.id === bookId);
  if (!b) return;
  // v220: defensive re-open adopts the existing history entry (no push/back churn)
  const reopenToken = coverPickerToken; coverPickerToken = null;
  closeCoverPickerDom();
  const doOpen = () => {
  const ov = document.createElement('div');
  ov.className = 'cover-picker-backdrop';
  ov.id = 'cover-picker';
  ov.innerHTML =
    '<div class="cover-picker" role="dialog" aria-label="Choose a cover">' +
    '<h3 class="serif">' + icon('image') + ' Choose a cover</h3>' +
    '<p class="note" id="cp-note">Looking for covers…</p>' +
    '<div class="cp-grid" id="cp-grid"></div>' +
    '<div class="cp-actions">' +
    '<button class="btn ghost" id="cp-upload">' + icon('upload') + ' Upload your own</button>' +
    '<input type="file" id="cp-file" accept="image/*" style="display:none">' +
    '<button class="btn ghost" id="cp-cancel">Cancel</button>' +
    '</div></div>';
  document.body.appendChild(ov);
  // v227: swipe-down-to-close like the edition picker — a downward swipe
  // must not chain out to pull-to-refresh and reload the tab.
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(ov.querySelector('.cover-picker'), closeCoverPicker);
  document.getElementById('cp-cancel').addEventListener('click', closeCoverPicker);
  ov.addEventListener('click', e => { if (e.target === ov) closeCoverPicker(); });
  document.getElementById('cp-upload').addEventListener('click', () =>
    document.getElementById('cp-file').click());
  document.getElementById('cp-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      chooseCover(bookId, await fileToCoverDataURL(f));
    } catch (err) {
      AppLog.error('cover', 'upload failed: ' + ((err && err.message) || err));
      toast('Could not read that image');
    }
  });
  fetchCoverCandidates(b).then(cands => {
    const grid = document.getElementById('cp-grid');
    const note = document.getElementById('cp-note');
    if (!grid) return; // picker was closed while loading
    if (!cands.length) {
      if (note) note.textContent = 'No covers found — try uploading your own.';
      return;
    }
    if (note) note.textContent = cands.length + ' option' + (cands.length === 1 ? '' : 's') +
      ' — tap one to use it.';
    grid.innerHTML = cands.map((c, i) =>
      '<button class="cp-pick' + (i === 0 && b.cover ? ' current' : '') + '" data-cpurl="' +
      esc(c.url) + '" title="' + esc(c.label) + '">' +
      '<img src="' + esc(c.url) + '" alt="' + esc(c.label) + '" loading="lazy" onerror="this.closest(\'.cp-pick\').remove()">' +
      '<span>' + esc(c.label) + '</span></button>').join('');
    grid.querySelectorAll('[data-cpurl]').forEach(btn =>
      btn.addEventListener('click', async () => { await chooseCover(bookId, btn.dataset.cpurl); }));
  });
  coverPickerToken = overlayOpened('picker', closeCoverPickerDom); // v220: back-gesture closes
  }; // doOpen
  if (reopenToken) overlayReplace(reopenToken, doOpen); // v220: re-open adopts the entry
  else doOpen();
}

// Bulk cover fill (v107): give every coverless book its first loadable cover
// candidate. Candidates come from the same sources as the picker; each URL is
// verified with a real image load (8s timeout) before it is saved, so a dead
// link can never be stamped onto a book. Re-runnable — it always targets
// whatever is still missing a cover.
function coverURLLoads(url) {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const img = new Image();
      img.onload = () => done(true);
      img.onerror = () => done(false);
      setTimeout(() => done(false), 8000);
      img.src = url;
    } catch (e) { done(false); }
  });
}

async function downloadMissingCovers(onProgress, fns) {
  const getCands = (fns && fns.candidates) || fetchCoverCandidates;
  const verify = (fns && fns.verify) || coverURLLoads;
  // v455 (import concierge): fns.targets scopes the run to a given book list
  // instead of the whole library. Default behavior is unchanged.
  const targets = (fns && fns.targets) || library.filter(b => !b.cover);
  let done = 0;
  for (let i = 0; i < targets.length; i++) {
    const b = targets[i];
    try { if (onProgress) onProgress(i + 1, targets.length); } catch (e) {}
    try {
      const cands = await getCands(b);
      const list = Array.isArray(cands) ? cands.slice(0, 4) : [];
      for (const c of list) {
        const url = c && c.url;
        // v507: adopted covers go through the WebP adopter (falls back
        // to the remote URL on any failure — the 400 ms politeness pacing
        // below also paces adoptions; failures are picked up by the
        // straggler sweep).
        if (url && await verify(url)) { b.cover = await adoptCoverWebP(url, b); done++; break; }
      }
    } catch (e) { /* skip this book */ }
    await new Promise(r => setTimeout(r, 400)); // be polite to the cover sources
  }
  if (done) { saveLibrary(); render(); }
  return { total: targets.length, done: done };
}
