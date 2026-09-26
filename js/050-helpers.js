'use strict';

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function uid() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
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

