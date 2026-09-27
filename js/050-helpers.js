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
  // ---- book modal chrome (v84) ----
  // TBR pile: two stacked books
  tbr: '<rect x="4" y="12.5" width="16" height="4.5" rx="1"/><path d="M6.5 12.5V8a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v4.5"/>',
  // currently reading: open book
  reading: '<path d="M12 6.5C10 5 7.5 4.5 4.5 4.5v13.5c3 0 5.5.5 7.5 2 2-1.5 4.5-2 7.5-2V4.5c-3 0-5.5.5-7.5 2z"/><line x1="12" y1="6.5" x2="12" y2="20"/>',
  // read: check in circle
  read: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.4l2.6 2.6 4.8-5.4"/>',
  // DNF: x in circle
  dnf: '<circle cx="12" cy="12" r="8.5"/><line x1="9.2" y1="9.2" x2="14.8" y2="14.8"/><line x1="14.8" y1="9.2" x2="9.2" y2="14.8"/>',
  // up next: skip-forward
  upnext: '<path d="M6 5.5l8 6.5-8 6.5z" fill="currentColor" stroke="none"/><line x1="16.5" y1="5.5" x2="16.5" y2="18.5"/>',
  // owned: home
  owned: '<path d="M4 11l8-7 8 7"/><path d="M6.2 9.3V20h11.6V9.3"/>',
  // to buy: cart
  tobuy: '<path d="M3 4.5h2l2.4 11.5h10.8L21 8H7"/><circle cx="9.6" cy="19.6" r="1.3" fill="currentColor" stroke="none"/><circle cx="16.4" cy="19.6" r="1.3" fill="currentColor" stroke="none"/>',
  // external link
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M18.5 13.5V19a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1H11"/>',
  // previously read: clock
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  // trash
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7"/><line x1="10" y1="11" x2="10" y2="16.5"/><line x1="14" y1="11" x2="14" y2="16.5"/>',
  // magnifier
  search: '<circle cx="11" cy="11" r="6.5"/><line x1="15.8" y1="15.8" x2="20.3" y2="20.3"/>',
  // picture (change cover)
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 16.8l4.8-3.8 3.7 2.8 3-2.3 4 3"/>',
  // heart (favorite)
  heart: '<path d="M12 20.3C7.2 16.6 3.8 13.4 3.8 9.7A4.4 4.4 0 0 1 8.2 5.3c1.6 0 3 .8 3.8 2.1a4.6 4.6 0 0 1 3.8-2.1 4.4 4.4 0 0 1 4.4 4.4c0 3.7-3.4 6.9-8.2 10.6z"/>',
  // ---- axis rating glyphs (v84) ----
  // chili pepper (spice)
  pepper: '<path d="M14.6 5.2c.4-1.9 1.9-2.9 4-3.1"/><path d="M14.8 5.4c-4.2.9-7.4 4.3-8 8.8-.3 2.8 1 5.2 3.1 5.7 2.5.6 3.6-1 3.1-3.6-.7-3.6.3-7.8 1.8-10.9z"/>',
  // ghost (scare)
  ghost: '<path d="M12 3.8c-3.9 0-6.3 2.9-6.3 6.8v8.6l2.1-1.5 2.1 1.5 2.1-1.5 2.1 1.5 2.1-1.5 2.1 1.5v-8.6c0-3.9-2.4-6.8-6.3-6.8z"/><circle cx="9.8" cy="10.2" r=".95" fill="currentColor" stroke="none"/><circle cx="14.2" cy="10.2" r=".95" fill="currentColor" stroke="none"/>',
  // shocked face (suspense)
  shock: '<circle cx="12" cy="12" r="8.5"/><circle cx="9.4" cy="10" r=".95" fill="currentColor" stroke="none"/><circle cx="14.6" cy="10" r=".95" fill="currentColor" stroke="none"/><ellipse cx="12" cy="15.2" rx="2.1" ry="2.7"/>',
  // crossed swords (adventure)
  swords: '<path d="M6.8 6.8l9.5 9.5"/><path d="M4.6 4.6l2.9-.7-.7 2.9z"/><path d="M17.2 6.8l-9.5 9.5"/><path d="M19.4 4.6l-2.9-.7.7 2.9z"/>',
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

