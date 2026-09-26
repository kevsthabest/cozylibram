'use strict';

/* ---------------- add view ---------------- */
function renderAdd() {
  let html = '<h2 class="section serif">Add a book</h2>' +
    '<div class="tabs">' +
    tab('scan', '📷 Scan') + tab('search', '🔍 Search') + tab('isbn', '⌨️ ISBN') +
    '</div><div id="add-body"></div>';
  setView(html);
  document.querySelectorAll('.tabs button').forEach(b =>
    b.addEventListener('click', () => { addTab = b.dataset.t; stopScan(); renderAdd(); }));
  if (addTab === 'scan') renderScanTab();
  if (addTab === 'search') renderSearchTab();
  if (addTab === 'isbn') renderIsbnTab();
}
function tab(t, label) {
  return '<button data-t="' + t + '" class="' + (addTab === t ? 'active' : '') + '">' + label + '</button>';
}

function renderScanTab() {
  const body = document.getElementById('add-body');
  const insecure = !window.isSecureContext;
  body.innerHTML =
    '<div class="scan-box"><video id="scan-video" playsinline muted></video>' +
    '<div class="scan-hint">Point the camera at the barcode on the back cover</div></div>' +
    '<div id="scan-result"></div>' +
    '<button class="btn ghost block" id="scan-toggle">Start camera</button>' +
    '<button class="btn ghost block" id="scan-photo">📸 Snap a barcode photo</button>' +
    '<input type="file" id="scan-file" accept="image/*" capture="environment" style="display:none">' +
    (insecure ? '<p class="note">⚠️ Live camera needs a secure (HTTPS) connection — this page is on plain http://, so the browser blocks it. The photo button above works without it.</p>' : '') +
    '<p class="note">Tip: on a phone, install this as an app (Share → Add to Home Screen) for the full experience.</p>';
  const toggle = document.getElementById('scan-toggle');
  toggle.addEventListener('click', () => {
    if (scanState.active) stopScan();
    else startScan();
  });
  const file = document.getElementById('scan-file');
  document.getElementById('scan-photo').addEventListener('click', () => file.click());
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
  const mount = document.getElementById('scan-result') || document.getElementById('add-body');
  mount.innerHTML = '<p class="note">Reading barcode…</p>';
  try {
    const bmp = await createImageBitmap(file);
    if ('BarcodeDetector' in window) {
      try {
        const det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        const codes = await det.detect(bmp);
        if (codes && codes.length) { onBarcode(codes[0].rawValue); return; }
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
      if (code) onBarcode(code);
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

function onBarcode(raw) {
  const isbn = String(raw).replace(/[^0-9X]/gi, '');
  if (isbn.length < 10) return;
  stopScan();
  isbnLookupUI(isbn, document.getElementById('scan-result') || document.getElementById('add-body'));
}

function stopScan() {
  scanState.active = false;
  if (scanState.timer) { clearInterval(scanState.timer); scanState.timer = null; }
  if (scanState.stream) { scanState.stream.getTracks().forEach(t => t.stop()); scanState.stream = null; }
  stopQuagga();
  const toggle = document.getElementById('scan-toggle');
  if (toggle) toggle.textContent = 'Start camera';
  const video = document.getElementById('scan-video');
  if (video) video.srcObject = null;
}

function loadQuagga() {
  return new Promise((resolve, reject) => {
    if (window.Quagga) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/quagga/0.12.1/quagga.min.js';
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

async function isbnLookupUI(isbn, mount) {
  mount.innerHTML = '<p class="note">Looking up ' + esc(isbn) + '…</p>';
  try {
    const book = await lookupISBN(isbn);
    if (book) {
      mount.innerHTML = '<div class="result-card">' + coverHTML(book) +
        '<div class="book-meta"><h3>' + esc(book.title) + '</h3>' +
        '<p class="author">' + esc(book.authors.join(', ')) + '</p>' +
        (book.publicRating ? '<div class="pub-rating">' + stars(book.publicRating) + ' (' + book.ratingsCount + ' ratings)</div>' : '') +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn small" id="rc-add">Add to TBR</button>' +
        '<button class="btn small ghost" id="rc-edit">Add & edit details</button></div></div></div>';
      document.getElementById('rc-add').addEventListener('click', () => { addBook(book, false); mount.innerHTML = ''; });
      document.getElementById('rc-edit').addEventListener('click', () => { const b = addBook(book, false); if (b) openDetail(b.id); mount.innerHTML = ''; });
    } else {
      mount.innerHTML = '<div class="result-card">' +
        '<div class="book-meta"><h3>No match for ' + esc(isbn) + '</h3>' +
        '<p class="author">Neither Google Books nor Open Library knows this one.</p>' +
        '<button class="btn small ghost" id="rc-manual">Add it manually</button></div></div>';
      document.getElementById('rc-manual').addEventListener('click', () => {
        const shell = normalizeVolume({ volumeInfo: { title: '', authors: [] } }, isbn);
        const b = addBook(shell, false); if (b) openDetail(b.id);
      });
    }
  } catch (e) {
    mount.innerHTML = '<p class="note">Lookup failed — check your connection and try again.</p>';
  }
}

function renderSearchTab() {
  const body = document.getElementById('add-body');
  body.innerHTML =
    '<div class="search-row"><input id="s-q" class="text-input" placeholder="Title or author…" enterkeyhint="search">' +
    '<button class="btn" id="s-go">Go</button></div><div id="s-results" style="margin-top:12px"></div>';
  const input = document.getElementById('s-q');
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) return;
    const box = document.getElementById('s-results');
    box.innerHTML = '<p class="note">Searching…</p>';
    try {
      searchResults = await searchBooks(q);
      if (!searchResults.length) { box.innerHTML = '<p class="note">No matches. Try different words.</p>'; return; }
      box.innerHTML = '<div class="grid">' + searchResults.map((b, i) =>
        '<div class="book-card" data-i="' + i + '">' + coverHTML(b) +
        '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
        '<p class="author">' + esc(b.authors.join(', ')) +
        (b.publishedDate ? ' · ' + esc(b.publishedDate.slice(0, 4)) : '') + '</p>' +
        (b.publicRating ? '<div class="pub-rating">' + stars(b.publicRating) + '</div>' : '') +
        '</div><div style="align-self:center"><button class="btn small">＋</button></div></div>'
      ).join('') + '</div>';
      box.querySelectorAll('.book-card').forEach(c =>
        c.addEventListener('click', async () => {
          const b = searchResults[Number(c.dataset.i)];
          const enriched = Object.assign({}, b, { id: uid() });
          if (!enriched._olKey) await enrichRatings(enriched); // Google-sourced: blend OL ratings
          await enrichOLBook(enriched, enriched._olKey); // OL-sourced: description/subjects/tropes
          const added = addBook(enriched, false);
          if (added) c.style.opacity = '0.4';
        }));
    } catch (e) {
      box.innerHTML = '<p class="note">Search failed — check your connection.</p>';
    }
  };
  document.getElementById('s-go').addEventListener('click', run);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

function renderIsbnTab() {
  const body = document.getElementById('add-body');
  body.innerHTML =
    '<div class="search-row"><input id="i-q" class="text-input" inputmode="numeric" placeholder="978…">' +
    '<button class="btn" id="i-go">Look up</button></div><div id="i-result"></div>' +
    '<p class="note">Paste a stack of ISBNs? Do them one at a time for now — bulk import is coming.</p>';
  const run = () => {
    const v = document.getElementById('i-q').value.trim();
    if (v.length < 10) { toast('That ISBN looks too short'); return; }
    isbnLookupUI(v, document.getElementById('i-result'));
  };
  document.getElementById('i-go').addEventListener('click', run);
  document.getElementById('i-q').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
}

