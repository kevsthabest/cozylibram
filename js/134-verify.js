'use strict';

/* ---- Metadata check (v46): compare every ISBN book against Hardcover
   (home-server token) then Open Library (free, no key) and flag mismatches
   in title, authors, page count, publish year, and missing covers.
   Nothing is overwritten on its own — she reviews each difference and
   applies per book or all at once. Books without an ISBN can't be checked. */

function isbnDigits(isbn) {
  return String(isbn || '').replace(/[^0-9X]/gi, '').toUpperCase();
}

function parseYear(s) {
  const m = String(s || '').match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

// Comparison form: trailing " (Series, #1)" dropped, case/punctuation ignored.
function normTitle(t) {
  return String(t || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// One metadata lookup by ISBN. v270: Hardcover first (home-server token;
// replaces the old Google Books fallback), then Open Library (no key).
// The returned doc must actually list the queried ISBN, otherwise a
// wrong-edition match would flag phantom differences.
async function fetchMetaByISBN(isbn) {
  const clean = isbnDigits(isbn);
  if (!clean) return null;
  try {
    const snap = await metaCacheGet(clean);
    if (snap) {
      return {
        title: snap.title || '', authors: snap.authors || [],
        pageCount: snap.pageCount || null, year: parseYear(snap.publishedDate),
        cover: snap.cover || ''
      };
    }
  } catch (e) { /* fall through to APIs */ }
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  };
  // v270: Hardcover first — same ISBN guard as the page-count waterfall.
  try {
    if (typeof hcSearchDocs === 'function') {
      const docs = await hcSearchDocs(clean);
      const hit = docs.find(d => (d.isbns || []).some(i => isbnDigits(i) === clean));
      if (hit) {
        return {
          title: hit.title || '',
          authors: (hit.author_names || []).map(String),
          pageCount: hit.pages || null,
          year: parseYear(hit.release_date),
          cover: (hit.image && hit.image.url) || ''
        };
      }
    }
  } catch (e) { /* fall through to Open Library */ }
  try {
    const d = await get('https://openlibrary.org/search.json?isbn=' + encodeURIComponent(clean) +
      '&fields=key,title,author_name,isbn,number_of_pages_median,first_publish_year,cover_i&limit=5');
    const hit = (d.docs || []).find(x =>
      (x.isbn || []).map(s => isbnDigits(s)).includes(clean));
    if (hit) {
      return {
        title: hit.title || '',
        authors: hit.author_name || [],
        pageCount: hit.number_of_pages_median || null,
        year: hit.first_publish_year || null,
        cover: hit.cover_i ? 'https://covers.openlibrary.org/b/id/' + hit.cover_i + '-L.jpg' : ''
      };
    }
  } catch (e) { /* no more sources — give up */ }
  return null;
}

// flags: [{field, label, from, to}]
function compareBookMeta(book, meta) {
  const flags = [];
  if (meta.title && normTitle(book.title) !== normTitle(meta.title)) {
    flags.push({ field: 'title', label: 'Title', from: book.title || '(none)', to: meta.title });
  }
  const keySet = arr => (arr || []).map(authorKey).filter(Boolean).sort().join('|');
  const have = keySet(book.authors), found = keySet(meta.authors);
  if (found && have !== found) {
    flags.push({
      field: 'authors', label: 'Authors',
      from: (book.authors || []).join(', ') || '(none)',
      to: (meta.authors || []).join(', ')
    });
  }
  if (!(book.pageCount > 0) && meta.pageCount > 0) {
    flags.push({ field: 'pageCount', label: 'Pages', from: '(missing)', to: String(meta.pageCount) });
  } else if (book.pageCount > 0 && meta.pageCount > 0 && book.pageCount !== meta.pageCount) {
    flags.push({ field: 'pageCount', label: 'Pages', from: String(book.pageCount), to: String(meta.pageCount) });
  }
  const by = parseYear(book.publishedDate);
  if (meta.year && !by) {
    // v476: missing year is a blank-fill, not a conflict
    flags.push({ field: 'year', label: 'Published', from: '(missing)', to: String(meta.year) });
  } else if (meta.year && by && meta.year !== by) {
    flags.push({ field: 'year', label: 'Published', from: String(by), to: String(meta.year) });
  }
  if (!book.cover && meta.cover) {
    flags.push({ field: 'cover', label: 'Cover', from: 'No cover', to: 'Cover found' });
  }
  return flags;
}

// v476: blanks auto-fill silently (they can never clobber an intentional
// edit); conflicts go to the compare sheet. Only pageCount/cover/year
// auto-fill — title/authors blanks are decided by the reader in the sheet.
var META_BLANK_FILL = { pageCount: 1, cover: 1, year: 1 };
function isBlankFillFlag(f) {
  return !!META_BLANK_FILL[f.field] &&
    (f.from === '(missing)' || f.from === 'No cover');
}

// Field-scoped apply (v476): the compare sheet applies per-field picks.
async function applyMetaField(book, meta, field) {
  if (field === 'title') book.title = meta.title;
  else if (field === 'authors') book.authors = (meta.authors || []).slice();
  else if (field === 'pageCount') book.pageCount = meta.pageCount;
  else if (field === 'year') book.publishedDate = String(meta.year);
  // v216: adopted remote covers go through the canonical bucket (falls
  // back to the remote URL on any failure — never a lost cover).
  else if (field === 'cover') book.cover = await canonicalizeCoverUrl(meta.cover);
}

async function applyVerifyFix(book, meta, flags) {
  for (const f of flags) await applyMetaField(book, meta, f.field);
  book._mtime = Date.now();
  saveLibrary();
}

// v476: conflict store — books whose metadata disagrees with the source on
// both-sides-present fields. Persisted so the quiet badge survives reloads.
var META_CONFLICTS_KEY = 'spicyshelves.meta_conflicts.v1';
var metaConflicts = {};
function metaConflictsLoad() {
  try { metaConflicts = JSON.parse(localStorage.getItem(META_CONFLICTS_KEY)) || {}; }
  catch (e) { metaConflicts = {}; }
}
function metaConflictsSave() {
  try { localStorage.setItem(META_CONFLICTS_KEY, JSON.stringify(metaConflicts)); }
  catch (e) {}
}
function metaConflictFor(bookId) { return metaConflicts[bookId] || null; }
function metaConflictClear(bookId) { delete metaConflicts[bookId]; metaConflictsSave(); }
metaConflictsLoad();

// v476: quiet background compare sweep. Runs at most once per 24h, paced,
// offline-guarded, no toasts. Blanks auto-fill; conflicts are stored for
// the quiet badge in the book modal. Hardcover-first priority lives in
// fetchMetaByISBN (v270) — do not regress it.
var META_COMPARE_KEY = 'spicyshelves.meta_compare_at';
async function runMetaCompareSweep() {
  try {
    const last = Number(localStorage.getItem(META_COMPARE_KEY) || 0);
    if (Date.now() - last < 86400000) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const targets = library.filter(b => cleanISBN(b.isbn));
    for (let i = 0; i < targets.length; i++) {
      const book = targets[i];
      try {
        const meta = await fetchMetaByISBN(book.isbn);
        if (!meta) continue;
        const flags = compareBookMeta(book, meta);
        if (!flags.length) { delete metaConflicts[book.id]; continue; }
        const blanks = flags.filter(isBlankFillFlag);
        const conflicts = flags.filter(f => !isBlankFillFlag(f));
        if (blanks.length) await applyVerifyFix(book, meta, blanks);
        if (conflicts.length) metaConflicts[book.id] = { meta: meta, flags: conflicts };
        else delete metaConflicts[book.id];
      } catch (e) { /* next book */ }
      await new Promise(r => setTimeout(r, 350));
    }
    metaConflictsSave();
    localStorage.setItem(META_COMPARE_KEY, String(Date.now()));
  } catch (e) {}
}

// The check itself, separated from the UI so tests can drive it directly.
async function checkLibraryMetadata(paceMs, onProgress) {
  const targets = library.filter(b => cleanISBN(b.isbn));
  const results = [];
  let notFound = 0;
  for (let i = 0; i < targets.length; i++) {
    if (onProgress) onProgress(i + 1, targets.length);
    try {
      const meta = await fetchMetaByISBN(targets[i].isbn);
      if (!meta) { notFound++; continue; }
      const flags = compareBookMeta(targets[i], meta);
      if (flags.length) results.push({ book: targets[i], meta: meta, flags: flags });
    } catch (e) { /* next book */ }
    if (paceMs && i < targets.length - 1) await new Promise(r => setTimeout(r, paceMs));
  }
  return { results: results, notFound: notFound, checked: targets.length };
}

// v476: the old bulk flow (runMetadataCheck → verify view → "Apply all
// fixes") is replaced by the compare sheet (openMetaCompareSheet) below.
// Blanks auto-fill in runMetaCompareSweep; conflicts get per-field review.

function verifyFlagHTML(f) {
  return '<span class="vf"><b>' + esc(f.label) + ':</b> <s>' + esc(f.from) +
    '</s> → <b>' + esc(f.to) + '</b></span>';
}

// v476: the full-page verify view is replaced by the compare sheet below.
// verifyFlagHTML's <s>old</s> → <b>new</b> diff visual is reused there.

/* ---- Metadata compare sheet (v476) ---- */

/* Per-field compare: "Yours" vs "Found", default Yours (safe). Nothing
   changes until the reader confirms. Uses the app's sheet pattern
   (collection-overlay + modal-backdrop + overlayOpened, wireSheetDrag). */
function openMetaCompareSheet(bookId) {
  const entry = metaConflictFor(bookId);
  if (!entry) return;
  const book = library.find(b => b.id === bookId);
  if (!book) { metaConflictClear(bookId); return; }
  const flags = entry.flags, meta = entry.meta;
  const sel = {};
  flags.forEach(f => { sel[f.field] = 'yours'; });

  const rowHTML = (f) =>
    '<div class="mcmp-field" data-mf="' + esc(f.field) + '">' +
    '<div class="mcmp-lab">' + esc(f.label) + '</div>' +
    '<div class="mcmp-opts">' +
    '<button class="mcmp-opt on" data-pick="yours"><span class="mcmp-who">Yours</span>' +
    '<span class="mcmp-val">' + esc(f.from) + '</span></button>' +
    '<button class="mcmp-opt" data-pick="found"><span class="mcmp-who">Found</span>' +
    '<span class="mcmp-val">' + esc(f.to) + '</span></button>' +
    '</div></div>';

  const ov = document.createElement('div');
  ov.className = 'collection-overlay';
  ov.innerHTML =
    '<div class="modal-backdrop" id="mc-back"><div class="modal" role="dialog" aria-label="Compare metadata">' +
    '<button class="modal-close" id="mc-x">\u2715</button>' +
    '<h2 class="serif">We found some differences</h2>' +
    '<p class="note">Which looks right? Tap your pick for each field — nothing changes until you confirm.</p>' +
    '<div id="mc-fields">' + flags.map(rowHTML).join('') + '</div>' +
    '<div class="modal-actions">' +
    '<button class="btn ghost" id="mc-keep">Keep mine</button>' +
    '<button class="btn" id="mc-apply">Apply my picks</button></div>' +
    '</div></div>';
  document.body.appendChild(ov);
  const closeDom = () => ov.remove();
  const ovToken = overlayOpened('sheet', closeDom);
  const close = () => { overlayClosed(ovToken); closeDom(); };
  if (typeof wireSheetDrag === 'function') wireSheetDrag(ov.querySelector('#mc-back .modal'), close);
  ov.querySelector('#mc-back').addEventListener('click', e => { if (e.target.id === 'mc-back') close(); });
  ov.querySelector('#mc-x').addEventListener('click', close);
  ov.querySelector('#mc-keep').addEventListener('click', close);
  ov.querySelectorAll('.mcmp-field').forEach(fieldEl => {
    const fname = fieldEl.dataset.mf;
    fieldEl.querySelectorAll('.mcmp-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        sel[fname] = opt.dataset.pick;
        fieldEl.querySelectorAll('.mcmp-opt').forEach(o => o.classList.toggle('on', o === opt));
      });
    });
  });
  ov.querySelector('#mc-apply').addEventListener('click', async () => {
    const fields = flags.map(f => f.field).filter(fd => sel[fd] === 'found');
    for (const fd of fields) await applyMetaField(book, meta, fd);
    if (fields.length) { book._mtime = Date.now(); saveLibrary(); }
    metaConflictClear(bookId);
    close();
    const wrap = document.getElementById('m-metadiff-wrap');
    if (wrap) wrap.remove();
    toast(fields.length ? 'Updated — thanks for checking \uD83E\uDD0E' : 'Kept yours — no changes');
  });
}
