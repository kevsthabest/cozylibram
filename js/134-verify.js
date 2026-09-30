'use strict';

/* ---- Metadata check (v46): compare every ISBN book against Open Library
   (free, no key) then Google Books (home-server key) and flag mismatches in
   title, authors, page count, publish year, and missing covers.
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

// One metadata lookup by ISBN. Open Library first (no key, one call); the
// returned doc must actually list the queried ISBN, otherwise a wrong-edition
// match would flag phantom differences. Google Books is the fallback.
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
  } catch (e) { /* fall through to Google Books */ }
  try {
    const d = await get(gbProxyUrl('https://www.googleapis.com/books/v1/volumes?q=isbn:' +
      encodeURIComponent(clean) + '&langRestrict=en&maxResults=5'));
    const items = (d.items || []).map(i => i.volumeInfo || {});
    const ids = it => (it.industryIdentifiers || []).map(x => isbnDigits(x.identifier));
    const hit = items.find(it => ids(it).includes(clean));
    if (hit) {
      const img = hit.imageLinks || {};
      return {
        title: hit.title || '',
        authors: hit.authors || [],
        pageCount: hit.pageCount || null,
        year: parseYear(hit.publishedDate),
        cover: String(img.thumbnail || img.smallThumbnail || '').replace(/^http:/, 'https:')
      };
    }
  } catch (e) { /* give up */ }
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
  if (meta.year && by && meta.year !== by) {
    flags.push({ field: 'year', label: 'Published', from: String(by), to: String(meta.year) });
  }
  if (!book.cover && meta.cover) {
    flags.push({ field: 'cover', label: 'Cover', from: 'No cover', to: 'Cover found' });
  }
  return flags;
}

async function applyVerifyFix(book, meta, flags) {
  for (const f of flags) {
    if (f.field === 'title') book.title = meta.title;
    else if (f.field === 'authors') book.authors = (meta.authors || []).slice();
    else if (f.field === 'pageCount') book.pageCount = meta.pageCount;
    else if (f.field === 'year') book.publishedDate = String(meta.year);
    // v216: adopted remote covers go through the canonical bucket (falls
    // back to the remote URL on any failure — never a lost cover).
    else if (f.field === 'cover') book.cover = await canonicalizeCoverUrl(meta.cover);
  }
  book._mtime = Date.now();
  saveLibrary();
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

let verifyRunning = false;
let verifyResults = []; // [{book, meta, flags}] awaiting review

async function runMetadataCheck() {
  if (verifyRunning) return;
  const btn = document.getElementById('meta-verify');
  const note = document.getElementById('meta-verify-note');
  verifyRunning = true;
  if (btn) btn.disabled = true;
  const out = await checkLibraryMetadata(350, (i, n) => {
    if (note) note.textContent = 'Checking ' + i + ' / ' + n + '…';
  });
  verifyRunning = false;
  if (btn) btn.disabled = false;
  verifyResults = out.results;
  verifyNotFound = out.notFound;
  if (note) note.textContent = 'Checked ' + out.checked + ' books — ' +
    out.results.length + ' differ.';
  openVerifyResults();
}

let verifyNotFound = 0;

function openVerifyResults() {
  view = 'verify';
  render();
  window.scrollTo(0, 0);
}

function verifyFlagHTML(f) {
  return '<span class="vf"><b>' + esc(f.label) + ':</b> <s>' + esc(f.from) +
    '</s> → <b>' + esc(f.to) + '</b></span>';
}

function renderVerify() {
  let html = '<div class="view-head"><button class="btn ghost sm" id="v-back">← Back</button></div>' +
    '<div class="wish-head"><h2 class="serif">' + icon('search') + ' Metadata check</h2>';
  if (!verifyResults.length) {
    html += '<p class="note">Everything matches Open Library / Google Books ✨</p></div>' +
      '<div class="empty"><div class="big">' + icon('sparkles') + '</div><h2 class="serif">All clean</h2>' +
      '<p>No differences found in the books we could check.</p></div>';
  } else {
    html += '<p class="note">' + verifyResults.length + ' book' +
      (verifyResults.length === 1 ? '' : 's') + ' differ' +
      (verifyNotFound ? ' · ' + verifyNotFound + ' ISBNs not found on either source' : '') +
      '</p></div>' +
      '<button class="btn block" id="v-apply-all" style="margin-bottom:12px">Apply all fixes</button>' +
      '<div class="collection-list">' + verifyResults.map(r =>
        '<div class="crow vbook">' +
        (r.book.cover
          ? '<img src="' + esc(r.book.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
          : '<span class="cnocover">' + icon('covers') + '</span>') +
        '<span class="ctext"><b>' + esc(r.book.title || 'Unknown title') + '</b>' +
        '<span class="vflags">' + r.flags.map(verifyFlagHTML).join('') + '</span></span>' +
        '<button class="btn small" data-vfix="' + esc(r.book.id) + '">Fix</button></div>'
      ).join('') + '</div>';
  }
  setView(html);
  document.getElementById('v-back').addEventListener('click', () => { view = 'settings'; render(); });
  const all = document.getElementById('v-apply-all');
  if (all) all.addEventListener('click', async () => {
    for (const r of verifyResults) await applyVerifyFix(r.book, r.meta, r.flags);
    verifyResults = [];
    toast('✅ All metadata fixes applied');
    render();
  });
  document.querySelectorAll('[data-vfix]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const i = verifyResults.findIndex(r => r.book.id === btn.dataset.vfix);
      if (i === -1) return;
      const r = verifyResults[i];
      await applyVerifyFix(r.book, r.meta, r.flags);
      verifyResults.splice(i, 1);
      toast('✅ Fixed');
      render();
    }));
}
