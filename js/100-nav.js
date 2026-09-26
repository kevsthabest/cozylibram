'use strict';

/* ---------------- navigation ---------------- */
function go(v) {
  stopScan();
  if (rouletteTimer) { clearInterval(rouletteTimer); rouletteTimer = null; }
  view = v;
  animateIn = true;
  document.querySelectorAll('.bottom-nav button').forEach(b =>
    b.classList.toggle('active', b.dataset.nav === v));
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.bottom-nav button').forEach(b =>
  b.addEventListener('click', () => go(b.dataset.nav)));

