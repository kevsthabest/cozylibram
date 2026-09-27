'use strict';

/* ---------------- lightweight onboarding (v127) ---------------- */
// Three-step welcome shown once to brand-new libraries: get books in,
// explain the shelves, make it yours. Skippable at any point, never blocks,
// never shows again once dismissed — or once the library isn't new.

const ONBOARD_KEY = 'spicyshelves.onboarded';
function onboarded() {
  try { return localStorage.getItem(ONBOARD_KEY) === '1'; } catch (e) { return true; }
}
function setOnboarded() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) {}
}
function maybeOnboard() {
  if (typeof library === 'undefined') return;
  if (onboarded() || document.getElementById('onb-overlay')) return;
  if (library.length) { setOnboarded(); return; } // not new — don't ask again
  track('onboarding_started');
  showOnbStep(0);
}

function onbHTML(n) {
  const dots = '<div class="onb-dots">' + [0, 1, 2].map(i =>
    '<span class="' + (i === n ? 'on' : '') + '"></span>').join('') + '</div>';
  const skip = '<button class="onb-skip" id="onb-skip">Skip tour</button>';
  if (n === 0) {
    return '<div class="onb-sheet">' +
      '<div class="onb-icon">' + icon('covers') + '</div>' +
      '<h2 class="serif">Welcome to Cozy Libram</h2>' +
      '<p class="onb-tag">Your library. Your rules.</p>' +
      '<p>Let’s get a few books in here.</p>' +
      '<button class="btn block" id="onb-search">' + icon('search') + ' Search for a Book</button>' +
      '<button class="btn ghost block" id="onb-scan">' + icon('camera') + ' Scan an ISBN</button>' +
      '<button class="btn ghost block" id="onb-import">' + icon('download') + ' Import a Library</button>' +
      dots + skip + '</div>';
  }
  if (n === 1) {
    const shelf = (ic, name, desc) =>
      '<div class="onb-shelf"><span class="onb-shelf-ic">' + icon(ic) + '</span>' +
      '<div><b>' + name + '</b><span>' + desc + '</span></div></div>';
    return '<div class="onb-sheet">' +
      '<h2 class="serif">Organize your reading</h2>' +
      shelf('tbr', 'TBR', 'Books you want to read') +
      shelf('reading', 'Reading', 'What you’re on right now') +
      shelf('read', 'Read', 'Finished — with ratings & notes') +
      shelf('dnf', 'DNF', 'Not for you. No shame in it.') +
      '<button class="btn block" id="onb-next">Next</button>' +
      dots + skip + '</div>';
  }
  return '<div class="onb-sheet">' +
    '<h2 class="serif">Make it yours</h2>' +
    '<div class="onb-shelf"><span class="onb-shelf-ic">' + icon('heart') + '</span>' +
    '<div><b>Favorites</b><span>Pin beloved books to their own shelf</span></div></div>' +
    '<div class="onb-shelf"><span class="onb-shelf-ic">' + icon('sparkles') + '</span>' +
    '<div><b>Ratings</b><span>Stars plus genre-aware axes — spice, scares, feels</span></div></div>' +
    '<div class="onb-shelf"><span class="onb-shelf-ic">' + icon('doc') + '</span>' +
    '<div><b>Tropes</b><span>Tag the tropes you love (or love to hate)</span></div></div>' +
    '<p class="onb-tag">You’re ready. The rest of Cozy Libram is here whenever you want it.</p>' +
    '<button class="btn block" id="onb-done">Start shelving</button>' +
    dots + skip + '</div>';
}

function showOnbStep(n) {
  let ov = document.getElementById('onb-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'onb-overlay';
    document.body.appendChild(ov);
  }
  ov.innerHTML = onbHTML(n);
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('onb-skip', () => onbDone(true));
  on('onb-next', () => showOnbStep(n + 1));
  on('onb-done', () => onbDone(false));
  on('onb-search', () => { addTab = 'search'; onbDone(false); go('add'); });
  on('onb-scan', () => { addTab = 'scan'; onbDone(false); go('add'); });
  on('onb-import', () => {
    // Settings → Library group holds the import hub (Goodreads, StoryGraph,
    // Hardcover, Bookmory, ISBN lists…).
    try { localStorage.setItem('spicyshelves.setgroups', JSON.stringify([1])); } catch (e) {}
    onbDone(false);
    go('settings');
  });
}

function onbDone(skipped) {
  setOnboarded();
  const ov = document.getElementById('onb-overlay');
  if (ov) ov.remove();
  track(skipped ? 'onboarding_skipped' : 'onboarding_completed');
}
