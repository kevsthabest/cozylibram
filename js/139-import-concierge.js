'use strict';

/* ---------------- Import Concierge (public-launch #1) ---------------- */
// The friendly front door for bringing a whole library over: pick a source,
// hand over the export, watch progress, get a match report ("312 of 340
// matched"), retry the misses, done. The parsers live in js/132-import.js —
// the concierge is the forgiving UX around them. Nothing here replaces the
// classic import hub; it just holds your hand through it.

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
// Per-run state. Reset every time the concierge opens.
export var IC = null;
export var icToken = null; // v535: overlay-history token for the concierge sheet
export function icReset() {
  IC = {
    step: 'source',       // source | file | working | report | covers | coverreport | done
    formatId: null,       // 'goodreads' | 'storygraph' | 'hardcover' | 'isbn-list'
    fileName: '',
    rawText: '',
    rawRows: 0,           // data rows in the file (pre-parse), for honest counts
    rows: [],             // parsed candidate books
    classified: [],       // { book, status: 'ready'|'duplicate', raw }
    unreadable: 0,        // rows the parser couldn't turn into a book
    imported: [],          // library book objects added this run
    coverTotal: 0,
    coverMissIds: [],     // library ids still missing covers
    isbnResults: null,    // isbn-list pipeline: bulkLookupISBNs results
    aborted: false,
  };
}

// ---- tiny helpers ----------------------------------------------------------
export function icEl(id) { return document.getElementById(id); }
export function icYield() { return new Promise(r => setTimeout(r, 0)); }
export function icTrack(ev, props) { try { track(ev, props || {}); } catch (e) {} }
export function icFormat() {
  return (typeof IMPORT_FORMATS !== 'undefined' ? IMPORT_FORMATS : [])
    .filter(f => f.id === IC.formatId)[0] || null;
}
export function icSourceMeta(id) {
  const meta = {
    'goodreads': { name: 'Goodreads', icon: 'covers' },
    'storygraph': { name: 'StoryGraph', icon: 'chart' },
    'hardcover': { name: 'Hardcover', icon: 'shelf' },
    'isbn-list': { name: 'ISBN list', icon: 'barcode' },
  };
  return meta[id] || { name: id, icon: 'download' };
}

// ---- overlay shell ----------------------------------------------------------
export function icOpen() {
  icReset();
  if (icEl('ic-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'ic-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'Import concierge');
  ov.innerHTML =
    '<div class="ic-sheet">' +
    '<button class="ic-close" id="ic-close" aria-label="Close import concierge">×</button>' +
    '<div class="ic-steps" id="ic-steps"></div>' +
    '<div id="ic-body"></div>' +
    '</div>';
  document.body.appendChild(ov);
  icEl('ic-close').addEventListener('click', icClose);
  ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') icClose(); });
  // v535 (audit #8): the standing sheet rule — swipe-down-to-dismiss
  // via wireSheetDrag + overlay history, like every other sheet. The
  // back gesture closes the concierge through the token's domCloser.
  if (typeof overlayOpened === 'function') icToken = overlayOpened('import-concierge', icClose);
  const icSheetEl = ov.querySelector('.ic-sheet');
  if (icSheetEl && typeof wireSheetDrag === 'function') wireSheetDrag(icSheetEl, icClose);
  icTrack('import_concierge_opened', {});
  icRender();
}
export function openImportConcierge() { icOpen(); }
export function icClose() {
  if (icToken != null) {
    const t = icToken; icToken = null;
    if (typeof overlayClosed === 'function') overlayClosed(t);
  }
  const ov = icEl('ic-overlay');
  if (ov) ov.remove();
  IC = null;
}

export var IC_STEPS = ['Source', 'Your file', 'Match report', 'Covers', 'Done'];
export function icStepIndex() {
  return { source: 0, file: 1, working: 1, report: 2, covers: 3, coverreport: 3, done: 4 }[IC.step] || 0;
}
export function icRenderSteps() {
  const idx = icStepIndex();
  icEl('ic-steps').innerHTML = '<div class="ic-dots">' + IC_STEPS.map((s, i) =>
    '<span class="ic-dot' + (i === idx ? ' on' : '') + (i < idx ? ' past' : '') +
    '" title="' + esc(s) + '"></span>').join('') + '</div>' +
    '<div class="ic-stepname">' + esc(IC_STEPS[idx]) + '</div>';
}
export function icRender() {
  if (!IC || !icEl('ic-body')) return;
  icRenderSteps();
  const body = icEl('ic-body');
  if (IC.step === 'source') body.innerHTML = icSourceHTML();
  else if (IC.step === 'file') body.innerHTML = icFileHTML();
  else if (IC.step === 'working') body.innerHTML = icWorkingHTML();
  else if (IC.step === 'report') body.innerHTML = icReportHTML();
  else if (IC.step === 'covers') body.innerHTML = icCoversHTML();
  else if (IC.step === 'coverreport') body.innerHTML = icCoverReportHTML();
  else if (IC.step === 'done') body.innerHTML = icDoneHTML();
  icWire();
}

// ---- step 1: pick a source ---------------------------------------------------
export function icSourceHTML() {
  const cards = ['goodreads', 'storygraph', 'hardcover', 'isbn-list'].map(id => {
    const m = icSourceMeta(id);
    const fmt = (typeof IMPORT_FORMATS !== 'undefined' ? IMPORT_FORMATS : []).filter(f => f.id === id)[0];
    return '<button class="ic-source" data-ic-source="' + id + '">' +
      '<span class="ic-source-ic">' + icon(m.icon) + '</span>' +
      '<span class="ic-source-tx"><b>' + esc(m.name) + '</b>' +
      '<span>' + esc(fmt && fmt.hint ? fmt.hint : '') + '</span></span>' +
      '<span class="ic-source-go">→</span></button>';
  }).join('');
  return '<div class="ic-icon">' + icon('sparkles') + '</div>' +
    '<h2 class="serif">Let\u2019s bring your books home</h2>' +
    '<p class="note">Moving from another app? Hand over the export file and the concierge ' +
    'walks you through it — no rush, your books will wait.</p>' +
    '<div class="ic-sources">' + cards + '</div>' +
    '<p class="note ic-fine">Using Bookmory? Its export needs the classic importer in Settings.</p>';
}

// ---- step 2: hand over the file -----------------------------------------------
export function icFileHTML() {
  const m = icSourceMeta(IC.formatId);
  const fmt = icFormat();
  const isIsbn = IC.formatId === 'isbn-list';
  return '<button class="ic-back" data-ic-back>← Back</button>' +
    '<div class="ic-icon">' + icon(m.icon) + '</div>' +
    '<h2 class="serif">' + esc(m.name) + ' export</h2>' +
    '<p class="note">' + esc(fmt && fmt.hint ? fmt.hint : '') + '</p>' +
    (isIsbn
      ? '<textarea id="ic-paste" class="text-input" rows="6" inputmode="numeric" placeholder="978125031…&#10;9780593…&#10;one ISBN per line"></textarea>'
      : '<label class="ic-drop" id="ic-drop">' +
        '<input type="file" id="ic-file" accept=".csv,.txt" hidden>' +
        '<span class="ic-drop-ic">' + icon('upload') + '</span>' +
        '<b>Choose your export file</b><span class="note">or drop it here</span></label>' +
        '<button class="btn ghost block" id="ic-usepaste">Paste the file contents instead</button>' +
        '<textarea id="ic-paste" class="text-input" rows="6" hidden placeholder="Paste your CSV here…"></textarea>') +
    '<button class="btn block" id="ic-continue" disabled>Continue →</button>' +
    '<p class="note ic-fine">Nothing leaves your device until you say so.</p>';
}

// ---- transient: working --------------------------------------------------------
export var icWorkLabel = '', icWorkFrac = 0;
export function icWorkingHTML() {
  return '<div class="ic-icon spin">' + icon('hourglass') + '</div>' +
    '<h2 class="serif" id="ic-worklabel">' + esc(icWorkLabel) + '</h2>' +
    '<div class="ic-progress"><div class="ic-bar" id="ic-bar" style="width:' +
    Math.round(icWorkFrac * 100) + '%"></div></div>' +
    '<p class="note" id="ic-worksub"></p>';
}
export function icProgress(frac, label, sub) {
  icWorkFrac = frac;
  if (label) icWorkLabel = label;
  const bar = icEl('ic-bar'), lab = icEl('ic-worklabel'), sub2 = icEl('ic-worksub');
  if (bar) bar.style.width = Math.round(frac * 100) + '%';
  if (lab && label) lab.textContent = label;
  if (sub2) sub2.textContent = sub || '';
}

// ---- pipeline: parse + classify (chunked so the UI breathes) -------------------
export async function icRunPipeline() {
  IC.step = 'working';
  icWorkLabel = 'Reading your file…'; icWorkFrac = 0;
  icRender();
  icTrack('import_started', { source: IC.formatId });
  await icYield();

  if (IC.formatId === 'isbn-list') return icRunIsbnPipeline();

  const fmt = icFormat();
  let rows = [];
  try { rows = fmt.parse(IC.rawText) || []; } catch (e) { rows = []; }
  // Honest denominator: raw data rows in the file (header excluded).
  try { IC.rawRows = Math.max(rows.length, parseCSV(IC.rawText).length - 1); }
  catch (e) { IC.rawRows = rows.length; }
  IC.unreadable = Math.max(0, IC.rawRows - rows.length);
  IC.rows = rows;

  // Classify in chunks: ready vs already-on-shelves.
  IC.classified = [];
  const CHUNK = 150;
  for (let i = 0; i < rows.length; i += CHUNK) {
    if (!IC || IC.aborted) return;
    const slice = rows.slice(i, i + CHUNK);
    for (const book of slice) {
      let dup = false;
      try { dup = !!(book.title && alreadyHave(book)); } catch (e) { dup = false; }
      IC.classified.push({ book: book, status: dup ? 'duplicate' : 'ready' });
    }
    icProgress(i / rows.length, 'Sorting your books…', (Math.min(i + CHUNK, rows.length)) + ' of ' + rows.length);
    await icYield();
  }
  if (!IC) return;
  IC.step = 'report';
  icRender();
}

// ---- pipeline: ISBN list (lookup with progress, like the bulk tab) -------------
export async function icRunIsbnPipeline() {
  const isbns = parseISBNList(IC.rawText);
  IC.rawRows = isbns.length;
  if (!isbns.length) {
    IC.step = 'file';
    icRender();
    icTrack('import_failed', { source: 'isbn_list' });
    const t = icEl('ic-paste');
    if (t) { t.classList.add('ic-error'); t.placeholder = 'Hmm — no ISBNs in there. Try again?'; }
    return;
  }
  IC.isbnResults = [];
  for (let i = 0; i < isbns.length; i++) {
    if (!IC || IC.aborted) return;
    icProgress(i / isbns.length, 'Looking up your books…', (i + 1) + ' of ' + isbns.length + ' — grab a tea, no rush');
    let book = null;
    try { book = await lookupISBN(isbns[i]); } catch (e) { book = null; }
    let status = 'missing';
    if (book) {
      try { status = alreadyHave(book) ? 'duplicate' : 'found'; } catch (e) { status = 'found'; }
    }
    IC.isbnResults.push({ isbn: isbns[i], status: status, book: book });
    await icYield();
  }
  if (!IC) return;
  IC.step = 'report';
  icRender();
}

// ---- step 3: match report ---------------------------------------------------------
export function icCounts() {
  if (IC.formatId === 'isbn-list') {
    const r = IC.isbnResults || [];
    return {
      total: r.length,
      matched: r.filter(x => x.status === 'found').length,
      duplicates: r.filter(x => x.status === 'duplicate').length,
      unreadable: r.filter(x => x.status === 'missing').length,
    };
  }
  const c = IC.classified;
  return {
    total: IC.rawRows,
    matched: c.filter(x => x.status === 'ready').length,
    duplicates: c.filter(x => x.status === 'duplicate').length,
    unreadable: IC.unreadable,
  };
}

export function icReportHTML() {
  const n = icCounts();
  const m = icSourceMeta(IC.formatId);
  let html = '<button class="ic-back" data-ic-back>← Back</button>' +
    '<div class="ic-report-hero"><div class="ic-bignum">' + n.matched + '<span> of ' + n.total + '</span></div>' +
    '<h2 class="serif">matched</h2>' +
    '<p class="note">' + (n.matched === n.total
      ? 'Every single one found its way home. Lovely.'
      : n.matched === 0
        ? 'Hmm — nothing new in there. Your shelves may already hold them all.'
        : 'The rest are sorted below — nothing lost, nothing duplicated.') + '</p></div>';

  if (n.duplicates) {
    html += '<div class="ic-missgroup"><p class="ic-misshead">' + icon('heart') +
      ' ' + n.duplicates + ' already on your shelves</p>' +
      '<p class="note">Look at you — ahead of the game. These were skipped, never added twice.</p></div>';
  }
  const missLabel = IC.formatId === 'isbn-list' ? 'lookups came up empty' : 'rows we couldn\u2019t read';
  if (n.unreadable) {
    html += '<div class="ic-missgroup"><p class="ic-misshead">' + icon('help') +
      ' ' + n.unreadable + ' ' + missLabel + '</p>' +
      '<p class="note">' + (IC.formatId === 'isbn-list'
        ? 'No catalog knew these ISBNs. Double-check for typos, or try again later — catalogs change.'
        : 'These rows didn\u2019t have a title we could read. If your file looks right, try exporting it again.') + '</p>' +
      (IC.formatId === 'isbn-list'
        ? '<button class="btn ghost block" id="ic-retry-misses">Retry the ' + n.unreadable + ' misses</button>'
        : '') + '</div>';
  }

  // Peek at the first few incoming books.
  const ready = IC.formatId === 'isbn-list'
    ? (IC.isbnResults || []).filter(x => x.status === 'found').map(x => x.book)
    : IC.classified.filter(x => x.status === 'ready').map(x => x.book);
  if (ready.length) {
    html += '<p class="ic-misshead">' + icon('covers') + ' Coming to your shelves</p><div class="ic-peek">' +
      ready.slice(0, 4).map(b =>
        '<div class="ic-peekrow"><b>' + esc(b.title || 'Untitled') + '</b>' +
        '<span>' + esc((b.authors || []).join(', ') || 'Unknown author') + '</span></div>').join('') +
      (ready.length > 4 ? '<p class="note">…and ' + (ready.length - 4) + ' more</p>' : '') + '</div>';
  }

  html += n.matched
    ? '<button class="btn block" id="ic-shelve">Shelve ' + n.matched + ' book' + (n.matched === 1 ? '' : 's') + ' →</button>'
    : '<button class="btn ghost block" id="ic-startover">Try a different file</button>';
  if (n.matched && (n.duplicates || n.unreadable)) {
    html += '<button class="btn ghost block" id="ic-startover2">Start over with a different file</button>';
  }
  return html;
}

// ---- shelve → covers ---------------------------------------------------------------
export async function icShelve() {
  let imported = [];
  if (IC.formatId === 'isbn-list') {
    const found = (IC.isbnResults || []).filter(x => x.status === 'found').map(x => x.book);
    const before = new Set(library.map(b => b.id));
    bulkAddBooks(found, 'isbn_list');
    imported = library.filter(b => !before.has(b.id));
    icTrack('import_completed', { source: 'isbn_list', book_count: found.length });
  } else {
    const ready = IC.classified.filter(x => x.status === 'ready').map(x => x.book);
    const before = new Set(library.map(b => b.id));
    // Reuse the shared importer (dedupe + normalize + banner logic); we take
    // the diff so we know exactly which books this run added.
    importForeignBooks(ready, icSourceMeta(IC.formatId).name, IC.formatId, null);
    imported = library.filter(b => !before.has(b.id));
  }
  IC.imported = imported;
  const needCovers = imported.filter(b => !b.cover);
  if (!needCovers.length) { IC.step = 'done'; icRender(); return; }
  IC.coverTotal = needCovers.length;
  IC.coverMissIds = [];
  IC.step = 'covers';
  icWorkLabel = 'Finding covers…'; icWorkFrac = 0;
  icRender();
  await icYield();
  if (!IC) return;
  await icFindCovers(needCovers);
  if (!IC) return;
  IC.step = 'coverreport';
  icRender();
}

// Scoped cover pass over just-imported books. Misses stay listed for retry.
export async function icFindCovers(targets) {
  IC.coverMissIds = [];
  const fns = { targets: targets.slice() };
  await downloadMissingCovers((i, n) => {
    if (!IC || IC.aborted) return;
    icProgress(i / n, 'Finding covers…', i + ' of ' + n + ' — put the kettle on, no rush');
  }, fns);
  if (!IC) return; // overlay closed mid-run — nothing to report to
  IC.coverMissIds = targets.filter(b => !b.cover).map(b => b.id);
}

// ---- step 4b: cover report + retry ----------------------------------------------------
export function icCoverReportHTML() {
  const found = IC.coverTotal - IC.coverMissIds.length;
  const misses = IC.coverMissIds
    .map(id => library.filter(b => b.id === id)[0])
    .filter(Boolean);
  let html = '<div class="ic-report-hero"><div class="ic-bignum">' + found + '<span> of ' + IC.coverTotal + '</span></div>' +
    '<h2 class="serif">covers found</h2>' +
    '<p class="note">' + (found === IC.coverTotal
      ? 'Every book arrived dressed for the occasion. ✨'
      : 'A few are still camera-shy. You can retry them, look them up by hand, or leave them — covers fill in quietly over time.') + '</p></div>';

  if (misses.length) {
    html += '<button class="btn block" id="ic-retry-covers">Retry the ' + misses.length + ' misses</button>';
    html += '<div class="ic-misses">' + misses.map(b =>
      '<div class="ic-miss" data-ic-miss="' + esc(b.id) + '">' +
      '<div class="ic-miss-tx"><b>' + esc(b.title || 'Untitled') + '</b>' +
      '<span>' + esc((b.authors || []).join(', ') || 'Unknown author') +
      (b.isbn ? ' · ' + esc(b.isbn) : ' · no ISBN on file') + '</span></div>' +
      '<div class="ic-miss-actions"><button class="btn ghost sm" data-ic-retryone="' + esc(b.id) + '">Retry</button>' +
      '<button class="btn ghost sm" data-ic-findone="' + esc(b.id) + '">Find</button></div>' +
      '<div class="ic-findres" hidden></div></div>').join('') + '</div>';
  }
  html += '<button class="btn block" id="ic-finish">Done →</button>' +
    '<p class="note ic-fine">Books without covers still shelve just fine — spines look lovely too.</p>';
  return html;
}

export async function icRetryCovers() {
  const targets = IC.coverMissIds
    .map(id => library.filter(b => b.id === id)[0])
    .filter(Boolean);
  if (!targets.length) return;
  IC.step = 'covers';
  icWorkLabel = 'Giving them another look…'; icWorkFrac = 0;
  icRender();
  await icYield();
  if (!IC) return;
  await icFindCovers(targets);
  if (!IC) return;
  IC.step = 'coverreport';
  icRender();
}

export async function icRetryOne(id) {
  const b = library.filter(x => x.id === id)[0];
  if (!b) return;
  const row = document.querySelector('[data-ic-miss="' + CSS.escape(id) + '"]');
  const btn = row ? row.querySelector('[data-ic-retryone]') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Trying…'; }
  await icFindCovers([b]);
  if (!IC) return;
  icRender(); // re-render coverreport with the updated miss list
}

// Manual fix: search catalogs by title + author, tap a result to adopt it.
export async function icFindOne(id) {
  const b = library.filter(x => x.id === id)[0];
  if (!b || typeof searchBooks !== 'function') return;
  const row = document.querySelector('[data-ic-miss="' + CSS.escape(id) + '"]');
  const box = row ? row.querySelector('.ic-findres') : null;
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<p class="note">Searching…</p>';
  let results = [];
  try { results = await searchBooks((b.title || '') + ' ' + (b.authors || []).join(' ')); } catch (e) { results = []; }
  results = (results || []).slice(0, 5);
  if (!results.length) {
    box.innerHTML = '<p class="note">No luck this time — catalogs are fickle. Try the Retry button later.</p>';
    return;
  }
  box.innerHTML = results.map((r, i) =>
    '<button class="ic-pick" data-ic-pick="' + esc(b.id) + ':' + i + '">' +
    '<b>' + esc(r.title || 'Untitled') + '</b><span>' + esc((r.authors || []).join(', ')) + '</span></button>').join('');
  box._results = results;
  box.querySelectorAll('[data-ic-pick]').forEach(btn =>
    btn.addEventListener('click', () => {
      const parts = btn.getAttribute('data-ic-pick').split(':');
      const r = (box._results || [])[parseInt(parts[1], 10)];
      if (r) {
        if (r.cover) b.cover = r.cover;
        if (r.isbn && !b.isbn) b.isbn = r.isbn;
        try { saveLibrary(); } catch (e) {}
        // Cover-storage closure: adopt the matched cover into the
        // bucket in the background (it was just assigned directly).
        if (r.cover && typeof adoptBookCoverInBackground === 'function') adoptBookCoverInBackground(b);
        icTrack('import_concierge_matched', { source: IC.formatId });
      }
      icRender();
    }));
}

// ---- step 5: done -----------------------------------------------------------------------
export function icDoneHTML() {
  const n = icCounts();
  return '<div class="ic-icon">' + icon('trophy') + '</div>' +
    '<h2 class="serif">Your shelves are looking cozy</h2>' +
    '<p class="note">' +
    (IC.imported.length
      ? IC.imported.length + ' book' + (IC.imported.length === 1 ? '' : 's') + ' moved in' +
        (IC.coverTotal ? ', ' + (IC.coverTotal - IC.coverMissIds.length) + ' with covers' : '') + '.'
      : 'Nothing new this time — your shelves were already complete.') +
    (n.duplicates ? ' ' + n.duplicates + ' were already home.' : '') + '</p>' +
    '<button class="btn block" id="ic-viewlib">View your library →</button>' +
    '<button class="btn ghost block" id="ic-again">Import another file</button>';
}

// ---- wiring -------------------------------------------------------------------------------
export function icBack() {
  if (IC.step === 'file') IC.step = 'source';
  else if (IC.step === 'report') { IC.step = 'file'; }
  else return;
  icRender();
}

export function icWire() {
  const on = (sel, fn) => {
    const els = document.querySelectorAll('#ic-body ' + sel);
    els.forEach(el => el.addEventListener('click', fn));
  };
  on('[data-ic-source]', e => {
    IC.formatId = e.currentTarget.getAttribute('data-ic-source');
    IC.step = 'file';
    
    icRender();
  });
  on('[data-ic-back]', icBack);
  const drop = icEl('ic-drop'), file = icEl('ic-file'), paste = icEl('ic-paste');
  if (drop && file) {
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('over');
      if (e.dataTransfer.files[0]) icTakeFile(e.dataTransfer.files[0]);
    });
    file.addEventListener('change', () => { if (file.files[0]) icTakeFile(file.files[0]); });
  }
  const usepaste = icEl('ic-usepaste');
  if (usepaste && paste) {
    usepaste.addEventListener('click', () => {
      paste.hidden = !paste.hidden;
      usepaste.textContent = paste.hidden ? 'Paste the file contents instead' : 'Hide the paste box';
      icSyncContinue();
    });
  }
  if (paste) paste.addEventListener('input', icSyncContinue);
  on('#ic-continue', icContinue);
  on('#ic-shelve', () => { icShelve(); });
  on('#ic-startover, #ic-startover2', () => { IC.step = 'source'; icRender(); });
  on('#ic-retry-misses', icRetryIsbnMisses);
  on('#ic-retry-covers', () => { icRetryCovers(); });
  on('#ic-finish', () => { IC.step = 'done'; icRender(); });
  on('#ic-viewlib', () => { icClose(); try { go('library'); } catch (e) {} });
  on('#ic-again', () => { icReset(); IC.step = 'source'; icRender(); });
  const qsa = sel => Array.prototype.slice.call(document.querySelectorAll('#ic-body ' + sel));
  qsa('[data-ic-retryone]').forEach(btn =>
    btn.addEventListener('click', () => icRetryOne(btn.getAttribute('data-ic-retryone'))));
  qsa('[data-ic-findone]').forEach(btn =>
    btn.addEventListener('click', () => icFindOne(btn.getAttribute('data-ic-findone'))));
  const skip = icEl('ic-skipcovers');
  if (skip) skip.addEventListener('click', () => { IC.step = 'done'; icRender(); });
}

export function icSyncContinue() {
  const btn = icEl('ic-continue'), paste = icEl('ic-paste');
  if (!btn) return;
  const hasFile = !!IC.rawText;
  const hasPaste = paste && !paste.hidden && paste.value.trim().length > 10;
  btn.disabled = !(hasFile || hasPaste);
  if (hasPaste && !hasFile) { IC.rawText = paste.value; IC.fileName = 'pasted text'; }
}

export function icTakeFile(f) {
  IC.fileName = f.name || 'file';
  const r = new FileReader();
  r.onload = () => {
    IC.rawText = String(r.result || '');
    const paste = icEl('ic-paste');
    if (paste) { paste.hidden = true; paste.value = ''; }
    icSyncContinue();
    const cont = icEl('ic-continue');
    if (cont && !cont.disabled) { /* wait for the tap — no auto-advance */ }
  };
  r.readAsText(f);
}

export function icContinue() {
  const paste = icEl('ic-paste');
  if (paste && !paste.hidden && paste.value.trim()) { IC.rawText = paste.value; IC.fileName = 'pasted text'; }
  if (!IC.rawText || !IC.rawText.trim()) return;
  // Auto-detect when the source step was skipped or the file disagrees.
  if (IC.formatId !== 'isbn-list') {
    try {
      const det = detectImportFormat(IC.rawText, IC.fileName);
      if (det && !det.needsLookup) IC.formatId = det.id;
      else if (!det) {
        IC.step = 'file';
        icRender();
        const p2 = icEl('ic-paste');
        if (p2) { p2.hidden = false; p2.classList.add('ic-error'); }
        const note = document.createElement('p');
        note.className = 'note';
        note.textContent = 'Hmm — that didn\u2019t look like a Goodreads, StoryGraph, or Hardcover export. ' +
          'Check the file, or paste the contents below.';
        icEl('ic-body').appendChild(note);
        return;
      }
    } catch (e) {}
  }
  icRunPipeline();
}

// ISBN-list: one-tap retry for the misses.
export async function icRetryIsbnMisses() {
  const misses = (IC.isbnResults || []).filter(x => x.status === 'missing').map(x => x.isbn);
  if (!misses.length) return;
  IC.step = 'working';
  icWorkLabel = 'Giving them another look…'; icWorkFrac = 0;
  icRender();
  await icYield();
  for (let i = 0; i < misses.length; i++) {
    if (!IC || IC.aborted) return;
    icProgress(i / misses.length, 'Retrying…', (i + 1) + ' of ' + misses.length);
    let book = null;
    try { book = await lookupISBN(misses[i]); } catch (e) { book = null; }
    const rec = IC.isbnResults.filter(x => x.isbn === misses[i])[0];
    if (rec) {
      if (book) {
        let dup = false;
        try { dup = alreadyHave(book); } catch (e) {}
        rec.status = dup ? 'duplicate' : 'found';
        rec.book = book;
      }
    }
    await icYield();
  }
  icTrack('import_concierge_retry', { source: 'isbn_list', book_count: misses.length });
  if (!IC) return;
  IC.step = 'report';
  icRender();
}

// Covers step gets a skip link (covers fill in quietly later anyway).
export function icCoversHTML() {
  return '<div class="ic-icon spin">' + icon('hourglass') + '</div>' +
    '<h2 class="serif" id="ic-worklabel">' + esc(icWorkLabel) + '</h2>' +
    '<div class="ic-progress"><div class="ic-bar" id="ic-bar" style="width:0%"></div></div>' +
    '<p class="note" id="ic-worksub"></p>' +
    '<button class="btn ghost block" id="ic-skipcovers">Skip — covers can wait</button>';
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The classic consumers, js/096-onboarding.js and js/132-import.js, call openImportConcierge() at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.IC = IC;
window.icToken = icToken;
window.icReset = icReset;
window.icEl = icEl;
window.icYield = icYield;
window.icTrack = icTrack;
window.icFormat = icFormat;
window.icSourceMeta = icSourceMeta;
window.icOpen = icOpen;
window.openImportConcierge = openImportConcierge;
window.icClose = icClose;
window.IC_STEPS = IC_STEPS;
window.icStepIndex = icStepIndex;
window.icRenderSteps = icRenderSteps;
window.icRender = icRender;
window.icSourceHTML = icSourceHTML;
window.icFileHTML = icFileHTML;
window.icWorkLabel = icWorkLabel;
window.icWorkFrac = icWorkFrac;
window.icWorkingHTML = icWorkingHTML;
window.icProgress = icProgress;
window.icRunPipeline = icRunPipeline;
window.icRunIsbnPipeline = icRunIsbnPipeline;
window.icCounts = icCounts;
window.icReportHTML = icReportHTML;
window.icShelve = icShelve;
window.icFindCovers = icFindCovers;
window.icCoverReportHTML = icCoverReportHTML;
window.icRetryCovers = icRetryCovers;
window.icRetryOne = icRetryOne;
window.icFindOne = icFindOne;
window.icDoneHTML = icDoneHTML;
window.icBack = icBack;
window.icWire = icWire;
window.icSyncContinue = icSyncContinue;
window.icTakeFile = icTakeFile;
window.icContinue = icContinue;
window.icRetryIsbnMisses = icRetryIsbnMisses;
window.icCoversHTML = icCoversHTML;
