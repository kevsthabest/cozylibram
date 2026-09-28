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

// Every candidate cover for this book: current first, then Google Books
// edition thumbnails, Apple Books artwork, all Open Library covers for the
// edition and its work, and Hardcover's edition art. Deduped.
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
    await hardcoverCover(isbn, freshPush);
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

function closeCoverPicker() {
  const ov = document.getElementById('cover-picker');
  if (ov) ov.remove();
}

function chooseCover(bookId, url) {
  const b = library.find(x => x.id === bookId);
  if (!b || !url) return;
  b.cover = url;
  b._mtime = Date.now();
  saveLibrary();
  /* v167: trace the cover change end to end — the log shows whether the
     follow-up cloud push actually ran. */
  AppLog.info('cover', 'cover set for "' + (b.title || bookId) + '"' +
    (url.indexOf('data:') === 0 ? ' (uploaded image)' : ''));
  closeCoverPicker();
  const wrap = document.querySelector('#modal-root .modal-head .cover-wrap');
  if (wrap) wrap.outerHTML = coverHTML(b);
  render(); // refresh the shelf behind the modal
  toast('🖼️ Cover updated');
}

function openCoverPicker(bookId) {
  const b = library.find(x => x.id === bookId);
  if (!b) return;
  closeCoverPicker();
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
      btn.addEventListener('click', () => chooseCover(bookId, btn.dataset.cpurl)));
  });
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
  const targets = library.filter(b => !b.cover);
  let done = 0;
  for (let i = 0; i < targets.length; i++) {
    const b = targets[i];
    try { if (onProgress) onProgress(i + 1, targets.length); } catch (e) {}
    try {
      const cands = await getCands(b);
      const list = Array.isArray(cands) ? cands.slice(0, 4) : [];
      for (const c of list) {
        const url = c && c.url;
        if (url && await verify(url)) { b.cover = url; done++; break; }
      }
    } catch (e) { /* skip this book */ }
    await new Promise(r => setTimeout(r, 400)); // be polite to the cover sources
  }
  if (done) { saveLibrary(); render(); }
  return { total: targets.length, done: done };
}
