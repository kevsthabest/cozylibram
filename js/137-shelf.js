// v199: bulk bookshelf-spine scanning. "Scan a bookshelf" captures a
// shelf photo, asks the vision model (mode 'shelf') for the readable
// spines left-to-right, looks each candidate up in the catalog, and shows
// a review list — nothing is added silently. Books already on the shelves
// are marked; confident matches can be added one by one or all at once.
//
// Scoring: the model's own confidence plus a token-overlap check against
// the catalog result. Foil, vertical text and tiny print stay "check this"
// rather than being trusted — review beats a wrong add.
//
// v201: every paint goes through the LIVE #scan-result node (re-acquired
// each time), and the model fetch has a 90s abort timeout. A background
// render() mid-flow replaces the node — painting into a stale reference
// was invisible ("Reading…" then nothing) — and a stalled upload used to
// hang forever with no message and nothing in the Logs tab.

let shelfBusy = false;
let shelfResults = []; // [{spine, book, status}] — status: ready|review|have|missing
let shelfScanPhoto = null; // v253: the downscaled scan photo, kept so spine
// regions can be cropped from it when books are added (auto spine photos).

const SHELF_MAX_LOOKUPS = 20;

// Normalize for comparison: lowercase alphanumerics only.
function shelfNorm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Significant words (mirrors queryTokens in 061-gbooks-key.js).
function shelfTokens(s) {
  const stop = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'by', 'in', 'on', 'to', 'for', 'with']);
  return shelfNorm(s).split(' ').filter(w => w.length >= 3 && !stop.has(w));
}

// Pick the best catalog result for a spine candidate and say how sure we
// are. 'confident' needs every significant spine-title word in the result
// title plus the author surname matching; anything weaker is 'review'.
function shelfBestMatch(cand, results) {
  const tToks = shelfTokens(cand.title);
  if (!tToks.length || !results.length) return null;
  const surname = shelfTokens(cand.author).pop() || '';
  let best = null;
  for (const b of results) {
    const hay = shelfNorm((b.title || '') + ' ' + (b.authors || []).join(' '));
    const hits = tToks.filter(t => hay.indexOf(t) !== -1).length;
    const titleOk = hits === tToks.length;
    const authorOk = !surname || hay.indexOf(surname) !== -1;
    const score = hits / tToks.length + (authorOk ? 1 : 0);
    if (!best || score > best.score) best = { book: b, score, titleOk, authorOk };
  }
  if (!best) return null;
  const confident = best.titleOk && best.authorOk && cand.confidence === 'high';
  return { book: best.book, confident };
}

// Entry point for the "Scan a bookshelf" button: live-camera frame when
// available, photo picker otherwise.
function shelfScan() {
  if (shelfBusy || visionBusy) return;
  const shot = visionGetImage();
  if (shot) shelfSend(shot);
  else visionPickPhoto(shelfSend); // photo picker feeds shelfSend
}

async function shelfSend(dataUrl) {
  if (shelfBusy || !dataUrl) return;
  if (!document.getElementById('scan-result')) return;
  shelfBusy = true;
  shelfScanPhoto = dataUrl; // v253: kept for spine-photo cropping on add
  visionSetBusy(true);
  // v201: re-acquire the live node on every paint — see the header note.
  const paint = (html) => {
    const m = document.getElementById('scan-result');
    if (m) m.innerHTML = html;
  };
  paint('<p class="note">Reading the spines…</p>');
  // v201: a stalled upload/model call must end visibly, not hang forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await apiFetch('/api/read-cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, mode: 'shelf' }),
      signal: ctrl.signal,
    });
    if (r.status === 503) {
      paint('<p class="note">Shelf scanning isn\u2019t set up on this server yet (it needs an API key).</p>');
      return;
    }
    if (r.status === 429) {
      paint('<p class="note">Too many scans — wait a minute and try again.</p>');
      return;
    }
    // v203: 502 means the model itself errored (e.g. upstream 503 overloaded) —
    // our 503 is reserved for "not set up", so this must not blame the API key.
    if (r.status === 502) {
      paint('<p class="note">The AI reader is temporarily unavailable — try again in a bit.</p>');
      return;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    const res = await r.json();
    const spines = (res.books || []).filter(b => b && (b.title || b.author));
    if (!spines.length) {
      paint('<p class="note">Couldn\u2019t read any spines — try closer, straight-on, in good light.</p>');
      return;
    }
    shelfResults = [];
    const n = Math.min(spines.length, SHELF_MAX_LOOKUPS);
    for (let i = 0; i < n; i++) {
      paint('<p class="note">Reading the spines… looking up ' + (i + 1) + ' / ' + n + '</p>');
      const spine = spines[i];
      let entry = { spine, book: null, status: 'missing' };
      try {
        const q = [spine.title, spine.author].filter(Boolean).join(' ');
        const found = await searchBooks(q);
        const m = shelfBestMatch(spine, found);
        if (m) {
          entry.book = m.book;
          if (alreadyHave(m.book)) entry.status = 'have';
          else entry.status = m.confident ? 'ready' : 'review';
        }
      } catch (e) { /* one bad lookup must not kill the whole shelf */ }
      shelfResults.push(entry);
      if (i < n - 1) await new Promise(res2 => setTimeout(res2, 250)); // be nice to the catalogs
    }
    paintShelfResults();
  } catch (e) {
    // v200: log it — caught fetch failures never reach the Logs tab's
    // uncaught-error hook, so without this the failure is invisible there.
    if (typeof AppLog !== 'undefined') AppLog.error('shelf', 'scan failed: ' + ((e && e.message) || e));
    paint(e && e.name === 'AbortError'
      ? '<p class="note">Shelf scan timed out — try a smaller photo or a better connection.</p>'
      : '<p class="note">Shelf scan failed — check your connection and try again.</p>');
  } finally {
    clearTimeout(timer);
    shelfBusy = false;
    visionSetBusy(false);
  }
}

function shelfStatusChip(entry) {
  if (entry.status === 'have') return '<span class="badge tobuy">' + icon('covers') + ' already on shelves</span>';
  if (entry.status === 'ready') return '<span class="badge owned">' + icon('read') + ' confident match</span>';
  if (entry.status === 'review') return '<span class="badge">' + icon('help') + ' check this one</span>';
  return '<span class="badge">' + icon('help') + ' no match found</span>';
}

function shelfSpineLabel(entry) {
  return esc([entry.spine.title, entry.spine.author].filter(Boolean).join(' — ')) +
    (entry.spine.confidence && entry.spine.confidence !== 'high'
      ? ' <span class="note">(' + esc(entry.spine.confidence) + ' confidence)</span>' : '');
}

// v253: crop this scan entry's spine region out of the kept scan photo.
// v258: the model now also returns y0/y1, so the crop hugs the spine
// vertically instead of taking the full-height strip.
// Resolves with a small JPEG data URL, or null when the model gave no
// usable box (older scans, unreadable positions) — the book is still
// added, just with a generated spine.
async function shelfScanSpinePhoto(entry) {
  try {
    if (!shelfScanPhoto || !entry || !entry.spine) return null;
    const x0 = entry.spine.x0, x1 = entry.spine.x1;
    if (x0 == null || x1 == null) return null;
    if (typeof spineBoxPhotoToDataURL !== 'function') return null;
    return await spineBoxPhotoToDataURL(shelfScanPhoto, x0, x1, 168, entry.spine.y0, entry.spine.y1);
  } catch (e) { return null; }
}

function paintShelfResults() {
  // v201: grab the live node — the caller may have been awaiting across a
  // re-render. Bail quietly if the user navigated away mid-scan.
  const mount = document.getElementById('scan-result');
  if (!mount) return;
  const ready = shelfResults.filter(e => e.status === 'ready' && !e._added);
  mount.innerHTML =
    '<p class="note"><strong>' + shelfResults.length + ' spine' +
    (shelfResults.length === 1 ? '' : 's') + ' read.</strong> ' +
    'Nothing is added until you say so — tap ＋ on the ones you want.</p>' +
    (ready.length
      ? '<button class="btn block" id="shelf-add-all">Add ' + ready.length +
        ' confident match' + (ready.length === 1 ? '' : 'es') + '</button>'
      : '<p class="note">No confident matches to add in bulk — review below.</p>') +
    '<div class="grid">' + shelfResults.map((e, i) => {
      const done = e._added || e.status === 'have';
      return '<div class="book-card" data-i="' + i + '"' + (done ? ' style="opacity:0.4"' : '') + '>' +
        (e.book ? coverHTML(e.book) : '<div class="cover-ph"></div>') +
        '<div class="book-meta"><h3>' + (e.book ? esc(e.book.title) : shelfSpineLabel(e)) + '</h3>' +
        '<p class="author">' + (e.book ? esc(displayAuthors(e.book.authors)) +
          (e.book.publishedDate ? ' · ' + esc(e.book.publishedDate.slice(0, 4)) : '')
          : 'spine: ' + shelfSpineLabel(e)) + '</p>' +
        shelfStatusChip(e) + '</div>' +
        '<div style="align-self:center">' +
        (done ? '<button class="btn small ghost" disabled>✓</button>'
          : e.book ? '<button class="btn small shelf-add">＋</button>'
          : '<button class="btn small ghost" disabled>–</button>') +
        '</div></div>';
    }).join('') + '</div>';

  const addAll = mount.querySelector('#shelf-add-all');
  if (addAll) addAll.addEventListener('click', async () => {
    const books = [];
    for (const e of shelfResults.filter(e => e.status === 'ready' && !e._added && e.book)) {
      const b = Object.assign({}, e.book, { id: uid() });
      const photo = await shelfScanSpinePhoto(e); // v253: auto spine photo
      if (photo) b.spinePhoto = photo;
      books.push(b);
    }
    const n = bulkAddBooks(books, 'shelf');
    shelfResults.forEach(e => { if (e.status === 'ready' && e.book) e._added = true; });
    // bulkAddBooks re-renders (tearing down #scan-result); repaint the review.
    paintShelfResults();
  });

  mount.querySelectorAll('.shelf-add').forEach(btn =>
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const card = btn.closest('.book-card');
      const e = shelfResults[Number(card.dataset.i)];
      if (!e || !e.book || e._added || alreadyHave(e.book)) return;
      const enriched = Object.assign({}, e.book, { id: uid() });
      const photo = await shelfScanSpinePhoto(e); // v253: auto spine photo
      if (photo) enriched.spinePhoto = photo;
      if (!enriched._olKey) await enrichRatings(enriched);
      await enrichOLBook(enriched, enriched._olKey);
      e._added = true;
      if (!addBook(enriched, false, 'shelf')) e._added = false;
      // addBook's render() repaints the page — put the review back up.
      const m2 = document.getElementById('scan-result');
      if (m2) paintShelfResults(m2);
    }));
}
