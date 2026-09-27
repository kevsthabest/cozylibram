'use strict';

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function uid() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
// v79: cohesive line-art icon set (inline SVG, inherits text color). Used for
// the library toolbar and view headers instead of mixed emoji glyphs.
const ICONS = {
  // two book covers side by side (grid / covers view)
  covers: '<rect x="3.5" y="4.5" width="7" height="15" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="15" rx="1.5"/>',
  // list view
  list: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>' +
    '<circle cx="4.8" cy="6" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="4.8" cy="12" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="4.8" cy="18" r="1.15" fill="currentColor" stroke="none"/>',
  // three book spines on a shelf (series)
  series: '<path d="M4.5 16.5v-8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v8"/><path d="M10.5 16.5v-11a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v11"/><path d="M16.5 16.5v-6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v6"/><line x1="3" y1="20" x2="21" y2="20"/>',
  // upright book spines (favorites shelf style)
  spines: '<rect x="3.5" y="4" width="3.5" height="16" rx="1"/><rect x="8.5" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="3" height="16" rx="1"/><rect x="18.5" y="4" width="3" height="16" rx="1"/>',
  // quotation mark (quotes)
  quotes: '<path d="M9.5 6.5C6.7 6.5 5 8.6 5 11.4v5.1h5.5V11H7.8"/><path d="M19 6.5c-2.8 0-4.5 2.1-4.5 4.9v5.1H20V11h-2.7"/>',
};
function icon(name) {
  const body = ICONS[name] || ICONS.covers;
  return '<svg class="ticon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body + '</svg>';
}
function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return ''; }
}
function toast(msg) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
function coverHTML(book, cls) {
  const inner = book.cover
    ? '<img src="' + esc(book.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
    : '📕';
  return '<div class="cover-wrap ' + (cls || '') + '">' + inner + '</div>';
}
function stars(n) {
  if (!n) return '';
  return '★'.repeat(Math.round(n)) + ' <span style="color:var(--faint)">' + Number(n).toFixed(1) + '</span>';
}

