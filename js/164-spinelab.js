'use strict';

/* js/164-spinelab.js — Spine Lab: one tab of the Observatory (admin).
 *
 * An experiment, not a feature: can a web search find a usable spine
 * photo for a book? renderSpineLab() draws a title/author form, posts
 * it to /api/spine-search, and renders the returned candidates for a
 * human to judge; spineLabResultHTML() is the pure renderer for that
 * response. Nothing is saved to any library and no result touches
 * book data — until search proves reliable, photographing the spine
 * remains the dependable path.
 *
 * The Observatory shell in js/199-admin.js dispatches here at runtime
 * (adminTab === 'spine') and is this file's only caller; it still
 * reads renderSpineLab through the window bridge at the bottom of
 * this file. This file's own outbound reads are wired as real
 * imports from js/050-helpers.js (see ADR-003).
 */
import { apiFetch, esc, icon } from './050-helpers.js';

// Candidates, notes and URLs in the response are web-search output —
// untrusted text headed for innerHTML — so every interpolation below
// passes through esc, URLs included.
export function spineLabResultHTML(data) {
  if (!data) return '';
  const cands = Array.isArray(data.candidates) ? data.candidates : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  let h = '';
  if (!cands.length) {
    h += '<div class="ob-card"><h3 class="serif">No spine found</h3>' +
      '<p class="note">Gemini could not find a clear spine photo for this book. ' +
      'Photographing the spine remains the reliable path.</p></div>';
  } else {
    h += '<div class="ob-card"><h3 class="serif">Spine candidates (' + cands.length + ')</h3>' +
      '<div class="spinelab-grid">' + cands.map(c =>
        '<div class="spinelab-cand">' +
        '<img src="' + esc(c.image_url) + '" alt="spine candidate" loading="lazy">' +
        (c.note ? '<p class="note">' + esc(c.note) + '</p>' : '') +
        (c.page_url ? '<a href="' + esc(c.page_url) + '" target="_blank" rel="noopener">source page</a>' : '') +
        '</div>').join('') + '</div></div>';
  }
  if (sources.length) {
    h += '<div class="ob-card"><h3 class="serif">Search sources</h3><ul class="ob-list">' +
      sources.map(s => '<li><a href="' + esc(s.uri) + '" target="_blank" rel="noopener">' +
        esc(s.title || s.uri) + '</a></li>').join('') + '</ul></div>';
  }
  return h;
}

export async function renderSpineLab() {
  const body = document.getElementById('ob-body');
  if (!body) return;
  body.innerHTML =
    '<div class="ob-card"><h3 class="serif">' + icon('camera') + ' Spine search test</h3>' +
    '<p class="note">Search the web for this book\'s <b>spine</b> photo (Brave image search). ' +
    'An experiment — nothing is saved. If this works reliably, spine photos could one day come from search instead of the camera.</p>' +
    '<div class="spinelab-form">' +
    '<input id="sl-title" class="text-input" placeholder="Book title" autocomplete="off">' +
    '<input id="sl-author" class="text-input" placeholder="Author (optional)" autocomplete="off">' +
    '<button class="btn" id="sl-go">Search</button>' +
    '</div></div>' +
    '<div id="sl-result"></div>';
  const go = async () => {
    const title = document.getElementById('sl-title').value.trim();
    const author = document.getElementById('sl-author').value.trim();
    const res = document.getElementById('sl-result');
    if (!title) { res.innerHTML = '<p class="note">Enter a title first.</p>'; return; }
    res.innerHTML = '<p class="note">Searching…</p>';
    try {
      const r = await apiFetch('/api/spine-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, author }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { res.innerHTML = '<p class="note">Error: ' + esc(data.error || ('http ' + r.status)) + '</p>'; return; }
      res.innerHTML = spineLabResultHTML(data);
    } catch (e) {
      res.innerHTML = '<p class="note">Request failed: ' + esc((e && e.message) || e) + '</p>';
    }
  };
  document.getElementById('sl-go').addEventListener('click', go);
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. Its one consumer, js/199-admin.js, calls renderSpineLab() at runtime and still reads it as a global, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last window-reading caller has wired the read as an import
   (ADR-003). */
window.spineLabResultHTML = spineLabResultHTML;
window.renderSpineLab = renderSpineLab;
