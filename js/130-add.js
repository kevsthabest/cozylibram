'use strict';

/* ---------------- add view ---------------- */
// v172: unified — one big Scan button, one smart search field that takes a
// title, author, or ISBN, and bulk ISBN import tucked behind a disclosure.
// (The old Scan/Search/ISBN/Bulk tabs are gone; `addTab` survives only as a
// hint — 'search' focuses the field — for deep links from Discover/onboarding.)
function renderAdd() {
  // v193: the scan panel is stateful across re-renders — addBook's render()
  // used to collapse the panel and kill the camera after every add, forcing
  // the user to start the camera again for the next book.
  const keepPanel = scanState.panelOpen;
  const resumeScan = scanState.resume || scanState.active;
  scanState.resume = false;
  if (scanState.active) stopScan();
  // v139: source filter chips — target one catalog or search them all.
  const srcs = [['all', 'All'], ['gbooks', 'Google Books'], ['openlibrary', 'Open Library']];
  if (typeof hcReady === 'function' && hcReady()) srcs.push(['hardcover', 'Hardcover']);
  if (!srcs.some(s => s[0] === searchSource)) searchSource = 'all';
  let html = '<h2 class="section serif">Add a book</h2>' +
    '<button class="btn block add-scan-btn" id="add-scan-btn">' + icon('camera') + ' Scan a barcode</button>' +
    '<div id="add-scan-mount"></div>' +
    '<div class="add-or" aria-hidden="true"><span>or</span></div>' +
    '<div class="search-row"><input id="s-q" class="text-input" placeholder="Title, author, or ISBN…" enterkeyhint="search">' +
    '<button class="btn" id="s-go">Go</button></div>' +
    '<div class="chips" id="s-src" style="margin-top:10px">' +
    srcs.map(s => '<button class="chip' + (searchSource === s[0] ? ' active' : '') + '" data-s="' + s[0] + '">' + s[1] + '</button>').join('') +
    '</div><div id="s-results" style="margin-top:12px"></div>' +
    '<div class="add-alt">' +
    '<button class="btn ghost small" id="add-bulk-toggle" aria-expanded="false">' + icon('clipboard') + ' Bulk ISBN</button>' +
    '<button class="btn ghost small" id="add-import-toggle" aria-expanded="false">' + icon('download') + ' Import a library</button></div>' +
    '<div id="add-bulk-body" hidden></div>' +
    '<div id="add-import-body" hidden></div>';
  setView(html);

  // Scanner expands inline below the button; collapsing stops the camera.
  const scanBtn = document.getElementById('add-scan-btn');
  scanBtn.addEventListener('click', () => {
    const mount = document.getElementById('add-scan-mount');
    if (mount.dataset.open) {
      stopScan();
      scanState.panelOpen = false; // v193: remember the collapsed state
      mount.innerHTML = '';
      delete mount.dataset.open;
      scanBtn.style.display = '';
    } else {
      scanState.panelOpen = true; // v193: remember the expanded state
      mount.dataset.open = '1';
      mount.innerHTML = scanPanelHTML();
      wireScanPanel(mount);
      scanBtn.style.display = 'none';
    }
  });

  const input = document.getElementById('s-q');
  input.value = searchQuery; // v150: restore the last query across re-renders
  const run = async () => {
    const qv = input.value.trim();
    if (qv.length < 2) return;
    searchQuery = qv; // v150: remember it so adding books doesn't wipe the search
    const box = document.getElementById('s-results');
    const digits = qv.replace(/[^0-9X]/gi, '');
    if (/^(\d{10}|\d{13}|\d{9}X)$/i.test(digits)) {
      isbnLookupUI(digits, box, 'isbn'); // looks like an ISBN — skip the catalog search
      return;
    }
    track('search_performed');
    box.innerHTML = '<p class="note">Searching…</p>';
    try {
      searchResults = await searchBooks(qv, searchSource);
      if (!searchResults.length) {
        box.innerHTML = '<p class="note">No matches. Try different words, or add it yourself:</p>' +
          '<button class="btn small ghost" id="s-manual">Add it manually</button>';
        document.getElementById('s-manual').addEventListener('click', () => {
          const shell = normalizeVolume({ volumeInfo: { title: qv, authors: [] } }, '');
          const b = addBook(shell, false, 'search'); if (b) openDetail(b.id);
        });
        return;
      }
      paintSearchResults(box);
    } catch (e) {
      box.innerHTML = '<p class="note">Search failed — check your connection.</p>';
    }
  };
  // v150: re-rendering (e.g. addBook's render() after each add) restores the
  // results instead of forcing a fresh search for every book.
  if (searchResults.length) paintSearchResults(document.getElementById('s-results'));
  document.getElementById('s-go').addEventListener('click', run);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  document.querySelectorAll('#s-src .chip').forEach(c =>
    c.addEventListener('click', () => {
      searchSource = c.dataset.s;
      document.querySelectorAll('#s-src .chip').forEach(x => x.classList.toggle('active', x === c));
      if (input.value.trim().length >= 2) run(); // re-run under the new source
    }));

  // v224 (UX-25/UX-13): Bulk ISBN and the import hub are full rows now —
  // no more <details> disclosure. Both render lazily on first open.
  const addAltToggle = (btnId, bodyId, onOpen) => {
    const btn = document.getElementById(btnId);
    const body = document.getElementById(bodyId);
    btn.addEventListener('click', () => {
      const open = body.hidden;
      document.getElementById('add-bulk-body').hidden = true;
      document.getElementById('add-import-body').hidden = true;
      document.getElementById('add-bulk-toggle').setAttribute('aria-expanded', 'false');
      document.getElementById('add-import-toggle').setAttribute('aria-expanded', 'false');
      if (open) {
        body.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        if (!body.dataset.wired) { body.dataset.wired = '1'; onOpen(body); }
      }
    });
  };
  addAltToggle('add-bulk-toggle', 'add-bulk-body', renderBulkInto);
  addAltToggle('add-import-toggle', 'add-import-body', (body) => {
    body.innerHTML = importHubHTML('add-im');
    wireImportHub('add-im');
  });

  if (addTab === 'search') input.focus(); // deep link from Discover / onboarding

  // v193: restore the scan panel exactly as it was before the re-render, and
  // restart the camera when it was running (or an add just requested it) so a
  // stack of books can be scanned without tapping anything between adds.
  if (keepPanel) {
    const mount = document.getElementById('add-scan-mount');
    mount.dataset.open = '1';
    mount.innerHTML = scanPanelHTML();
    wireScanPanel(mount);
    scanBtn.style.display = 'none';
    if (resumeScan) startScan();
  }
}

// Scanner panel: viewfinder + camera toggle + photo fallback.
function scanPanelHTML() {
  const insecure = !window.isSecureContext;
  return '<div class="scan-box"><video id="scan-video" playsinline muted></video>' +
    '<div class="scan-dim" aria-hidden="true"></div>' +
    '<div class="scan-frame" aria-hidden="true"><i class="c1"></i><i class="c2"></i><i class="c3"></i><i class="c4"></i><div class="scan-line"></div></div>' +
    '<div class="scan-hint">Point the camera at the barcode on the back cover</div></div>' +
    '<div id="scan-result"></div>' +
    '<button class="btn ghost block" id="scan-toggle">Start camera</button>' +
    '<button class="btn ghost block" id="scan-photo">' + icon('camera') + ' Snap a barcode photo</button>' +
    '<button class="btn ghost block vision-btn" id="scan-vision">' + icon('sparkles') + ' Read the cover with AI</button>' +
    '<button class="btn ghost block vision-btn" id="scan-shelf">' + icon('sparkles') + ' Scan a bookshelf with AI</button>' +
    '<input type="file" id="scan-file" accept="image/*" capture="environment" style="display:none">' +
    (insecure ? '<p class="note">' + icon('warn') + ' Live camera needs a secure (HTTPS) connection — this page is on plain http://, so the browser blocks it. The photo button above works without it.</p>' : '') +
    '<p class="note">Tip: on a phone, install this as an app (Share → Add to Home Screen) for the full experience.</p>';
}
function wireScanPanel(mount) {
  const toggle = mount.querySelector('#scan-toggle');
  toggle.addEventListener('click', () => {
    if (scanState.active) stopScan();
    else startScan();
  });
  const file = mount.querySelector('#scan-file');
  mount.querySelector('#scan-photo').addEventListener('click', () => file.click());
  // v197: vision cover reading — ISBN off the back cover, or title/author
  // when no ISBN is printed.
  mount.querySelector('#scan-vision').addEventListener('click', () => visionReadCover());
  // v199: bulk bookshelf-spine scanning with a review list before adding.
  mount.querySelector('#scan-shelf').addEventListener('click', () => shelfScan());
  file.addEventListener('change', () => {
    if (file.files && file.files[0]) {
      const f = file.files[0];
      file.value = '';
      decodePhotoFile(f);
    }
  });
}

// Photo fallback: uses the camera app directly (no getUserMedia permission needed,
// works over plain http://), then decodes the barcode from the snapshot.
async function decodePhotoFile(file) {
  const mount = document.getElementById('scan-result') || document.getElementById('add-scan-mount');
  mount.innerHTML = '<p class="note">Reading barcode…</p>';
  try {
    const bmp = await createImageBitmap(file);
    if ('BarcodeDetector' in window) {
      try {
        const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        const codes = await det.detect(bmp);
        // v193: instant — a photo is a single decode, no consensus possible.
        // A check-digit failure here means a garbled read, not a bad book.
        if (codes && codes.length) {
          if (onBarcode(codes[0].rawValue, true)) return;
          mount.innerHTML = '';
          toast('Barcode read was garbled — try closer, in good light');
          return;
        }
      } catch (e) { /* fall through to quagga */ }
    }
    await loadQuagga();
    const url = URL.createObjectURL(file);
    Quagga.decodeSingle({
      src: url,
      numOfWorkers: 0,
      inputStream: { size: 1024 },
      decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'] },
      locate: true
    }, result => {
      URL.revokeObjectURL(url);
      const code = result && result.codeResult && result.codeResult.code;
      // v193: instant — single decode, no consensus; garbled reads fail the
      // check digit and report cleanly instead of hanging on "Reading…".
      if (code) {
        if (onBarcode(code, true)) return;
        mount.innerHTML = '';
        toast('Barcode read was garbled — try closer, in good light');
      }
      else { mount.innerHTML = ''; toast('No barcode found — try closer, in good light'); }
    });
  } catch (e) {
    mount.innerHTML = '';
    toast('Could not read that photo');
  }
}

async function startScan() {
  const video = document.getElementById('scan-video');
  const toggle = document.getElementById('scan-toggle');
  const result = document.getElementById('scan-result');
  if (!video) return;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Live camera needs HTTPS — use the photo button instead');
    return;
  }
  try {
    scanState.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    toast('Camera blocked — use the photo button, or Search/ISBN');
    return;
  }
  video.srcObject = scanState.stream;
  await video.play().catch(() => {});
  scanState.active = true;
  const scanBox = video.closest('.scan-box');
  if (scanBox) scanBox.classList.add('live');
  if (toggle) toggle.textContent = 'Stop camera';

  if ('BarcodeDetector' in window) {
    try {
      const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      scanState.timer = setInterval(async () => {
        if (!scanState.active) return;
        try {
          const codes = await det.detect(video);
          if (codes && codes.length) onBarcode(codes[0].rawValue);
        } catch (e) {}
      }, 600);
      return;
    } catch (e) { /* fall through to quagga */ }
  }
  // Fallback: Quagga2 via CDN
  try {
    await loadQuagga();
    startQuagga(video);
  } catch (e) {
    toast('Live scanning not supported here — use Search or ISBN');
  }
}

function onBarcode(raw, instant) {
  const isbn = String(raw).replace(/[^0-9X]/gi, '').toUpperCase();
  if (!/^(\d{13}|\d{12}|\d{9}[\dX])$/.test(isbn)) return false; // partial read — keep scanning
  if (!isbnCheckOk(isbn)) return false; // v193: misread (bad check digit) — keep scanning silently
  if (!instant) {
    // v193: consensus — the same value must be reported twice in a row before
    // we accept it, so a single bad frame can't trigger a failed lookup.
    if (scanState.lastCode === isbn) scanState.hits++;
    else { scanState.lastCode = isbn; scanState.hits = 1; }
    if (scanState.hits < 2) return false;
  }
  scanState.lastCode = null; scanState.hits = 0;
  stopScan();
  isbnLookupUI(isbn, document.getElementById('scan-result') || document.getElementById('add-scan-mount'), 'barcode');
  return true;
}

// v193: ISBN/EAN check-digit validation — rejects the garbled first-frame
// reads that used to fail the lookup and force a manual rescan.
// ISBN-13 and UPC-A/EAN-12 use mod-10; ISBN-10 uses mod-11 (X = 10).
function isbnCheckOk(isbn) {
  // A 12-digit UPC-A is an EAN-13 with a leading zero — validate it as one.
  if (/^\d{12}$/.test(isbn)) isbn = '0' + isbn;
  if (/^\d{13}$/.test(isbn)) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += (isbn.charCodeAt(i) - 48) * (i % 2 ? 3 : 1);
    return (10 - (s % 10)) % 10 === (isbn.charCodeAt(12) - 48);
  }
  if (/^\d{9}[\dX]$/.test(isbn)) {
    let s = 0;
    for (let i = 0; i < 9; i++) s += (isbn.charCodeAt(i) - 48) * (10 - i);
    const c = isbn[9];
    s += c === 'X' ? 10 : (c.charCodeAt(0) - 48);
    return s % 11 === 0;
  }
  return false;
}

function stopScan() {
  scanState.active = false;
  scanState.lastCode = null; scanState.hits = 0; // v193: reset misread consensus
  if (scanState.timer) { clearInterval(scanState.timer); scanState.timer = null; }
  if (scanState.stream) { scanState.stream.getTracks().forEach(t => t.stop()); scanState.stream = null; }
  stopQuagga();
  const toggle = document.getElementById('scan-toggle');
  if (toggle) toggle.textContent = 'Start camera';
  const video = document.getElementById('scan-video');
  if (video) video.srcObject = null;
  const box = video && video.closest('.scan-box');
  if (box) box.classList.remove('live');
}

// v195: background refreshes (Hardcover enrichment, page-count fill) must not
// re-render while the scan panel is open. Their render() lands a second or
// two after "Add to TBR" — right in the middle of the camera restart — and
// tears the panel down mid-getUserMedia, leaving a dead "Start camera"
// button. The data is already saved, so skipping the render loses nothing:
// the UI picks the enriched data up on the next navigation render.
function renderKeepScan() {
  const mount = document.getElementById('add-scan-mount');
  if (mount && mount.dataset.open) return;
  render();
}

function loadQuagga() {
  return new Promise((resolve, reject) => {
    if (window.Quagga) return resolve();
    const s = document.createElement('script');
    // v194 (security): vendored as js/vendor/quagga.min.js (pinned 0.12.1,
    // see js/vendor/SOURCES.txt). Same-origin, no CDN, works offline.
    s.src = 'js/vendor/quagga.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function startQuagga(video) {
  if (!window.Quagga || !video) return;
  scanState.quagga = true;
  Quagga.init({
    inputStream: { name: 'Live', type: 'LiveStream', target: video.parentElement,
      constraints: { facingMode: 'environment' } },
    decoder: { readers: ['ean_reader', 'ean_8_reader', 'upc_reader', 'upc_e_reader'] },
    locate: true
  }, err => {
    if (err) { scanState.quagga = false; return; }
    Quagga.start();
    Quagga.onDetected(d => {
      const code = d && d.codeResult && d.codeResult.code;
      if (code) onBarcode(code);
    });
  });
}
function stopQuagga() {
  if (scanState.quagga && window.Quagga) {
    try { Quagga.stop(); Quagga.offDetected(); } catch (e) {}
  }
  scanState.quagga = false;
}

async function isbnLookupUI(isbn, mount, source) {
  const src = source || 'isbn';
  mount.innerHTML = '<p class="note">Looking up ' + esc(isbn) + '…</p>';
  try {
    const book = await lookupISBN(isbn);
    if (book) {
      mount.innerHTML = '<div class="result-card">' + coverHTML(book) +
        '<div class="book-meta"><h3>' + esc(book.title) + '</h3>' +
        '<p class="author">' + esc(displayAuthors(book.authors)) + '</p>' +
        (book.publicRating ? '<div class="pub-rating">' + stars(book.publicRating) + ' (' + book.ratingsCount + ' ratings)</div>' : '') +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn small" id="rc-add">Add to TBR</button>' +
        '<button class="btn small ghost" id="rc-edit">Add & edit details</button></div></div></div>';
      document.getElementById('rc-add').addEventListener('click', () => {
        // v193: after a *barcode* add, keep the scan panel open and the camera
        // running — the re-render restores both, so a stack of books can be
        // scanned back-to-back. (Typed-ISBN adds leave the panel as it was.)
        if (src === 'barcode') { scanState.panelOpen = true; scanState.resume = true; }
        addBook(book, false, src);
      });
      document.getElementById('rc-edit').addEventListener('click', () => { const b = addBook(book, false, src); if (b) openDetail(b.id); mount.innerHTML = ''; });
    } else {
      // v196: a 12-digit scan is a retail UPC, not an ISBN — no catalog maps
      // those old UPCs to a book, so say so plainly instead of a bare miss.
      const isUPC = src === 'barcode' && /^\d{12}$/.test(isbn);
      mount.innerHTML = '<div class="result-card">' +
        '<div class="book-meta"><h3>No match for ' + esc(isbn) + '</h3>' +
        (isUPC
          ? '<p class="author">That scanned as a retail UPC, not an ISBN — this edition only has the UPC barcoded, and no catalog maps UPCs to books. Type the ISBN printed above the barcode instead.</p>'
          : '<p class="author">None of the catalogs (Google Books, Open Library, Hardcover) know this one.</p>') +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn small ghost" id="rc-manual">Add it manually</button>' +
        // v193: a failed scan shouldn't force the user to rebuild the panel —
        // one tap restarts the camera right here.
        (src === 'barcode' ? '<button class="btn small" id="rc-rescan">Scan again</button>' : '') +
        // v197: the highest-value spot for vision reading — the exact moment
        // a UPC-only or unknown barcode needs the printed ISBN instead.
        (src === 'barcode' ? '<button class="btn small vision-btn" id="rc-vision">Read the ISBN off the cover</button>' : '') +
        '</div></div></div>';
      document.getElementById('rc-manual').addEventListener('click', () => {
        const shell = normalizeVolume({ volumeInfo: { title: '', authors: [] } }, isbn);
        const b = addBook(shell, false, src); if (b) openDetail(b.id);
      });
      const rescan = document.getElementById('rc-rescan');
      if (rescan) rescan.addEventListener('click', () => startScan());
      const rcVision = document.getElementById('rc-vision');
      if (rcVision) rcVision.addEventListener('click', () => visionReadCover());
    }
  } catch (e) {
    mount.innerHTML = '<p class="note">Lookup failed — check your connection and try again.</p>';
  }
}

// v150: paints the cached searchResults. Entries already on her shelves — or
// added during this search session — show a ✓ instead of ＋, so several
// books by one author can be added from a single search.
function paintSearchResults(box) {
  box.innerHTML = '<div class="grid">' + searchResults.map((b, i) => {
    const have = b._added || alreadyHave(b);
    return '<div class="book-card" data-i="' + i + '"' + (have ? ' style="opacity:0.4"' : '') + '>' + coverHTML(b) +
      '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
      '<p class="author">' + esc(displayAuthors(b.authors)) +
      (b.publishedDate ? ' · ' + esc(b.publishedDate.slice(0, 4)) : '') + '</p>' +
      (b.publicRating ? '<div class="pub-rating">' + stars(b.publicRating) + '</div>' : '') +
      '</div><div style="align-self:center">' +
      (have ? '<button class="btn small ghost" disabled>✓</button>'
            : '<button class="btn small">＋</button>') +
      '</div></div>';
  }).join('') + '</div>';
  box.querySelectorAll('.book-card').forEach(c =>
    c.addEventListener('click', async () => {
      const b = searchResults[Number(c.dataset.i)];
      if (!b) return;
      if (b._added || alreadyHave(b)) { if (!b._added) toast('Already on your shelves'); return; }
      const enriched = Object.assign({}, b, { id: uid() });
      if (!enriched._olKey) await enrichRatings(enriched); // Google-sourced: blend OL ratings
      await enrichOLBook(enriched, enriched._olKey); // OL-sourced: description/subjects/tropes
      // Flag first so addBook's render() repaints this card as ✓ via paintSearchResults.
      b._added = true;
      if (!addBook(enriched, false, 'search')) b._added = false; // add refused — revert
    }));
}

/* ---------------- bulk ISBN import ---------------- */
// Split pasted text into clean, deduped ISBN candidates (10 or 13 digits).
function parseISBNList(text) {
  const seen = new Set();
  const out = [];
  String(text || '').split(/[\s,;]+/).forEach(raw => {
    const clean = raw.replace(/[^0-9X]/gi, '').toUpperCase();
    if ((clean.length === 10 || clean.length === 13) && !seen.has(clean)) {
      seen.add(clean); out.push(clean);
    }
  });
  return out;
}

// Look up a list of ISBNs one by one (300ms pacing, metacache-backed).
// Returns [{ isbn, status: 'found'|'duplicate'|'missing', book }].
async function bulkLookupISBNs(isbns, onStep) {
  const results = [];
  for (let i = 0; i < isbns.length; i++) {
    if (onStep) onStep(i + 1, isbns.length);
    let book = null;
    try { book = await lookupISBN(isbns[i]); } catch (e) { book = null; }
    if (!book) results.push({ isbn: isbns[i], status: 'missing', book: null });
    else if (alreadyHave(book)) results.push({ isbn: isbns[i], status: 'duplicate', book: book });
    else results.push({ isbn: isbns[i], status: 'found', book: book });
    if (i < isbns.length - 1) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// Add a batch of books at once: one save, one render, one toast.
// Skips background enrichment/page-count fetch — lookupISBN already fills
// page counts, and Settings → Hardcover → "Enrich all" backfills the rest.
function bulkAddBooks(books, source) {
  let n = 0;
  for (const book of books) {
    if (alreadyHave(book)) continue;
    untombstone(book.id);
    library.unshift(book);
    n++;
  }
  saveLibrary();
  render();
  toast(n ? 'Added ' + n + ' book' + (n === 1 ? '' : 's') + ' ✨' : 'Nothing new to add');
  return n;
}

function renderBulkInto(body) {
  body.innerHTML =
    '<textarea id="b-isbns" class="text-input" rows="6" inputmode="numeric" ' +
    'placeholder="978125031…&#10;9780593…&#10;one ISBN per line"></textarea>' +
    '<button class="btn block" id="b-go">Look up all</button>' +
    '<p class="note" id="b-progress"></p><div id="b-results"></div>' +
    '<p class="note">Tip: series &amp; moods fill in later via Settings → Hardcover → “Enrich all books”.</p>';
  document.getElementById('b-go').addEventListener('click', async () => {
    const isbns = parseISBNList(document.getElementById('b-isbns').value);
    const prog = document.getElementById('b-progress');
    const resEl = document.getElementById('b-results');
    if (!isbns.length) { toast('Paste some ISBNs first'); return; }
    document.getElementById('b-go').disabled = true;
    track('import_started', { source: 'isbn_list' });
    const results = await bulkLookupISBNs(isbns,
      (i, n) => { prog.textContent = 'Looking up ' + i + ' / ' + n + '…'; });
    prog.textContent = '';
    const found = results.filter(r => r.status === 'found');
    const chip = (r) => r.status === 'found' ? '<span class="badge owned">' + icon('read') + ' ready</span>'
      : r.status === 'duplicate' ? '<span class="badge tobuy">' + icon('covers') + ' already on shelves</span>'
      : '<span class="badge">' + icon('help') + ' not found</span>';
    resEl.innerHTML = results.map(r =>
      '<div class="result-card">' +
      (r.book ? coverHTML(r.book) : '<div class="cover-ph"></div>') +
      '<div class="book-meta"><h3>' + esc(r.book ? r.book.title : r.isbn) + '</h3>' +
      '<p class="author">' + esc(r.book ? displayAuthors(r.book.authors) : 'no match in Google Books / Open Library') + '</p>' +
      chip(r) + '</div></div>').join('') +
      (found.length
        ? '<button class="btn block" id="b-add">Add ' + found.length + ' book' +
          (found.length === 1 ? '' : 's') + ' to TBR</button>'
        : '<p class="note">Nothing new to add.</p>');
    const add = document.getElementById('b-add');
    if (add) add.addEventListener('click', () => {
      const n = bulkAddBooks(found.map(r => r.book), 'isbn_list');
      track('import_completed', { source: 'isbn_list', book_count: n });
    });
  });
}
