// v197: vision cover reading. "Read the cover" captures a still from the
// live camera (or falls back to a photo pick), asks the vision model for the
// printed ISBN, and routes the answer into the existing flows:
//   valid ISBN -> isbnLookupUI (the same result card as a barcode scan)
//   title/author only -> text search, painted into #scan-result
//   nothing readable -> plain message, typed ISBN stays the fallback
// The model is never trusted on the ISBN: isbnCheckOk must pass first, so a
// misread becomes "couldn't read it", never the wrong book.

let visionBusy = false;

// A still from the live scan camera, downscaled for upload. Null when the
// camera isn't running (tests override this for a canned data URL).
function visionGetImage() {
  try {
    const video = document.getElementById('scan-video');
    if (video && video.videoWidth) {
      const maxDim = 1024;
      const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(video.videoWidth * scale));
      c.height = Math.max(1, Math.round(video.videoHeight * scale));
      c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    }
  } catch (e) { /* no usable frame */ }
  return null;
}

// Photo picker fallback for when the live camera isn't running.
// onPick defaults to visionSend (single-cover flow); shelf mode passes
// shelfSend instead. The callback is read off the input at change time so
// the shared picker always delivers to the flow that opened it.
function visionPickPhoto(onPick) {
  let input = document.getElementById('vision-file');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = 'vision-file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.value = '';
      if (!f) return;
      const deliver = input._deliver || visionSend;
      const r = new FileReader();
      // v201: downscale before upload — a full-res phone photo blows past
      // the endpoint's ~2.6MB cap (instant 400) and uploads slowly on mobile.
      r.onload = async () => deliver(await visionDownscale(String(r.result || ''), 1024));
      r.readAsDataURL(f);
    });
    document.body.appendChild(input);
  }
  input._deliver = onPick || visionSend;
  input.click();
}

// v201: downscale a data-URL image so its long edge is <= maxDim,
// re-encoded as JPEG. The vision endpoint caps uploads at ~2.6MB and the
// model reads spines/covers fine at 1024px — a 12MP phone photo would
// otherwise fail instantly (400) or crawl on mobile data. Resolves with
// the ORIGINAL data URL on any failure (or if decoding takes longer than
// timeoutMs), so this can never break the flow.
function visionDownscale(dataUrl, maxDim, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const safety = setTimeout(() => done(dataUrl), timeoutMs || 8000);
    const done = (v) => { if (!settled) { settled = true; clearTimeout(safety); resolve(v); } };
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth, h = img.naturalHeight;
          const scale = Math.min(1, (maxDim || 1024) / Math.max(w, h));
          if (!(scale < 1)) return done(dataUrl);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          done(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { done(dataUrl); }
      };
      img.onerror = () => done(dataUrl);
      img.src = dataUrl;
    } catch (e) { done(dataUrl); }
  });
}

// v201: paint into the LIVE #scan-result node, re-acquired every time. A
// background render() mid-flow replaces the node; painting into a stale
// reference would be invisible (the "Reading…" then nothing bug).
function visionPaint(html) {
  const m = document.getElementById('scan-result');
  if (m) m.innerHTML = html;
}

function visionSetBusy(busy) {
  visionBusy = busy;
  document.querySelectorAll('.vision-btn').forEach(b => {
    b.disabled = busy;
    if (busy) { b.dataset.label = b.innerHTML; b.innerHTML = 'Reading…'; }
    else if (b.dataset.label) { b.innerHTML = b.dataset.label; delete b.dataset.label; }
  });
}

// Entry point for the "Read the cover" buttons.
function visionReadCover() {
  if (visionBusy) return;
  const shot = visionGetImage();
  if (shot) visionSend(shot);
  else visionPickPhoto(); // no live frame — photo picker feeds visionSend
}

async function visionSend(dataUrl) {
  if (visionBusy || !dataUrl) return;
  if (!document.getElementById('scan-result')) return;
  visionSetBusy(true);
  visionPaint('<p class="note">Reading the cover…</p>');
  // v201: a stalled upload/model call must end visibly, not hang forever.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await apiFetch('/api/read-cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, mode: 'single' }),
      signal: ctrl.signal,
    });
    if (r.status === 503) {
      visionPaint('<p class="note">Cover reading isn\u2019t set up on this server yet (it needs an API key). Type the ISBN instead.</p>');
      return;
    }
    if (r.status === 429) {
      visionPaint('<p class="note">' + esc(await api429Message(r, 'Too many cover reads — wait a minute and try again.')) + '</p>');
      return;
    }
    // v203: 502 means the model itself errored (e.g. upstream 503 overloaded) —
    // our 503 is reserved for "not set up", so this must not blame the API key.
    if (r.status === 502) {
      visionPaint('<p class="note">The AI reader is temporarily unavailable — try again in a bit.</p>');
      return;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    const res = await r.json();
    // Never trust the model's ISBN without the check digit.
    const isbn = res.isbn && isbnCheckOk(res.isbn) ? res.isbn : null;
    if (isbn) {
      const m = document.getElementById('scan-result');
      if (m) isbnLookupUI(isbn, m, 'vision');
      return;
    }
    const q = [res.title, res.author].filter(Boolean).join(' ');
    if (q.length >= 2) {
      visionPaint('<p class="note">No ISBN on the cover — searching for \u201c' + esc(q) + '\u201d…</p>');
      try {
        searchResults = await searchBooks(q);
      } catch (e) {
        visionPaint('<p class="note">Search failed — check your connection.</p>');
        return;
      }
      if (!searchResults.length) {
        visionPaint('<p class="note">No matches for \u201c' + esc(q) + '\u201d. Try the ISBN, or add it manually.</p>');
        return;
      }
      const m2 = document.getElementById('scan-result');
      if (m2) paintSearchResults(m2);
      return;
    }
    visionPaint('<p class="note">Couldn\u2019t read the cover — try a clearer photo, or type the ISBN.</p>');
  } catch (e) {
    // v200: log it — caught fetch failures never reach the Logs tab's
    // uncaught-error hook, so without this the failure is invisible there.
    if (typeof AppLog !== 'undefined') AppLog.error('vision', 'cover read failed: ' + ((e && e.message) || e));
    visionPaint(e && e.name === 'AbortError'
      ? '<p class="note">Cover reading timed out — try a smaller photo or a better connection.</p>'
      : '<p class="note">Cover reading failed — check your connection and try again.</p>');
  } finally {
    clearTimeout(timer);
    visionSetBusy(false);
  }
}
