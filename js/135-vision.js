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
function visionPickPhoto() {
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
      const r = new FileReader();
      r.onload = () => visionSend(String(r.result || ''));
      r.readAsDataURL(f);
    });
    document.body.appendChild(input);
  }
  input.click();
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
  const mount = document.getElementById('scan-result');
  if (!mount) return;
  visionSetBusy(true);
  mount.innerHTML = '<p class="note">Reading the cover…</p>';
  try {
    const r = await fetch('/api/read-cover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, mode: 'single' }),
    });
    if (r.status === 503) {
      mount.innerHTML = '<p class="note">Cover reading isn\u2019t set up on this server yet (it needs an API key). Type the ISBN instead.</p>';
      return;
    }
    if (r.status === 429) {
      mount.innerHTML = '<p class="note">Too many cover reads — wait a minute and try again.</p>';
      return;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    const res = await r.json();
    // Never trust the model's ISBN without the check digit.
    const isbn = res.isbn && isbnCheckOk(res.isbn) ? res.isbn : null;
    if (isbn) {
      isbnLookupUI(isbn, mount, 'vision');
      return;
    }
    const q = [res.title, res.author].filter(Boolean).join(' ');
    if (q.length >= 2) {
      mount.innerHTML = '<p class="note">No ISBN on the cover — searching for \u201c' + esc(q) + '\u201d…</p>';
      try {
        searchResults = await searchBooks(q);
      } catch (e) {
        mount.innerHTML = '<p class="note">Search failed — check your connection.</p>';
        return;
      }
      if (!searchResults.length) {
        mount.innerHTML = '<p class="note">No matches for \u201c' + esc(q) + '\u201d. Try the ISBN, or add it manually.</p>';
        return;
      }
      paintSearchResults(mount);
      return;
    }
    mount.innerHTML = '<p class="note">Couldn\u2019t read the cover — try a clearer photo, or type the ISBN.</p>';
  } catch (e) {
    mount.innerHTML = '<p class="note">Cover reading failed — check your connection and try again.</p>';
  } finally {
    visionSetBusy(false);
  }
}
