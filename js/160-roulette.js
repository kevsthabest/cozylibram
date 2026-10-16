'use strict';

/* ---------------- TBR roulette ---------------- */
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export function tbrBooks() { return library.filter(b => b.status === 'tbr'); }

export function allPickGenres() {
  const set = [];
  tbrBooks().forEach(b => bookGenres(b).forEach(g => { if (!set.includes(g)) set.push(g); }));
  return set.sort();
}

// v235 (UX-19): the TBR's dominant axis — most common primaryAxisKey across
// TBR books, falling back to spice. Labels the roulette intensity filter
// ("Spice level", "Scare level", ...) instead of the pepper-only metaphor.
// v236: trope autocomplete for the roulette filter. TBR tropes come first
// (they guarantee matches), ranked by how many TBR books carry them; the
// canonical catalog fills the rest. Pure.
export function tropeSuggestions(q, limit) {
  const qk = tropeNameKey(q);
  const counts = {}; // key -> { name, count }
  tbrBooks().forEach(b => (b.tropes || []).forEach(t => {
    const k = tropeNameKey(t);
    if (!k) return;
    if (!counts[k]) counts[k] = { name: String(t), count: 0 };
    counts[k].count++;
  }));
  const hits = Object.values(counts)
    .filter(h => !qk || tropeNameKey(h.name).includes(qk))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  const seen = new Set(Object.keys(counts));
  const extra = TROPES
    .filter(t => !seen.has(tropeNameKey(t.name)) && (!qk || tropeNameKey(t.name).includes(qk)))
    .map(t => ({ name: t.name, count: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return hits.concat(extra).slice(0, limit || 8);
}

export function dominantPickAxis() {
  const counts = {};
  tbrBooks().forEach(b => {
    const k = primaryAxisKey(b);
    counts[k] = (counts[k] || 0) + 1;
  });
  let best = 'spice', bestN = -1;
  Object.keys(counts).forEach(k => { if (counts[k] > bestN) { best = k; bestN = counts[k]; } });
  return axisByKey(best);
}

export function pickCandidates() {
  const q = pickState.trope.trim().toLowerCase();
  return tbrBooks().filter(b => {
    if (pickState.upNextOnly && !upNext.includes(b.id)) return false; // v74
    if (pickState.genres.length && !bookGenres(b).some(g => pickState.genres.includes(g))) return false;
    if (q && !(b.tropes || []).join(' ').toLowerCase().includes(q)) return false;
    const pk = primaryAxisKey(b);
    if (((b.ratings || {})[pk] || 0) < pickState.minIntensity) return false;
    return true;
  });
}

/* ---------------- Blind Date (v564) ----------------
   A wrapped mode of the roulette above (spec: docs/blind-date-spec.md).
   The pick logic is untouched — blindPool() is pickCandidates() minus
   this session's passes. The wrapped state is presentational only: no
   book data changes until Start Reading, and Pass writes nothing at
   all (the passed set lives in module memory, so a later session can
   offer the book again). */
export let blindDate = { on: false };
export let blindPassed = {}; // session-only: bookId -> true

export function setBlindDate(on) { blindDate.on = !!on; }

export function blindPool() {
  const c = pickCandidates();
  let left = c.filter(b => !blindPassed[b.id]);
  if (!left.length && c.length) { blindPassed = {}; left = c; } // spent pile: everyone back in
  return left;
}

/* The clues a wrapped book may show — existing fields only (spec §1).
   Tropes follow the decided precedence (v547) as far as local data
   reaches: pipeline (tropesAI) first, then the reader's own, deduped,
   capped at 3. Spice is the app's own axis display (ratingBadges).
   First line: a record either carries one verbatim (firstLine) or the
   clue is omitted — the corpus stores no opening lines today, and the
   description / saved quotes are never substituted for one. */
export function blindDateClues(b) {
  const seen = {}, tropes = [];
  const push = list => (list || []).forEach(t => {
    const name = String(t || '').trim();
    if (!name) return;
    const k = name.toLowerCase();
    if (!seen[k]) { seen[k] = 1; tropes.push(name); }
  });
  push(b.tropesAI);
  push(b.tropes);
  const genres = (typeof bookGenres === 'function') ? bookGenres(b) : [];
  return {
    tropes: tropes.slice(0, 3),
    spiceHTML: (typeof ratingBadges === 'function') ? ratingBadges(b) : '',
    pages: (b.pageCount > 0) ? b.pageCount : null,
    genres: genres.slice(0, 2),
    firstLine: (typeof b.firstLine === 'string' && b.firstLine.trim()) ? b.firstLine.trim() : null,
  };
}

/* The wrapped card. Title, author, cover, description and series are
   never read here — nothing identifying reaches the DOM until the
   reader unwraps (showWinner) or starts the book. */
export function blindDateHTML(b) {
  const c = blindDateClues(b);
  const meta = c.genres.map(g => esc(g));
  if (c.pages) meta.push(c.pages + ' pages');
  return '<div class="winner bd-wrapped">' +
    '<div class="stat-sub" style="margin-top:0">A blind date ' + icon('gift') + '</div>' +
    '<div class="bd-wrap" aria-hidden="true"><span class="bd-wrap-ic">' + icon('gift') + '</span></div>' +
    '<p class="bd-tagline">Wrapped — so the cover can\'t sway you.</p>' +
    (c.tropes.length
      ? '<div class="badges" style="justify-content:center">' +
        c.tropes.map(t => '<span class="badge bd-chip">' + icon('tag') + ' ' + esc(t) + '</span>').join('') + '</div>'
      : '') +
    (c.spiceHTML ? '<div class="bd-spice">' + c.spiceHTML + '</div>' : '') +
    (meta.length ? '<p class="bd-meta">' + meta.join(' · ') + '</p>' : '') +
    (c.firstLine
      ? '<blockquote class="bd-firstline"><span class="stat-sub">First line</span>\u201C' +
        esc(c.firstLine) + '\u201D</blockquote>'
      : '') +
    '<div class="winner-actions">' +
    '<button class="btn" id="bd-start">' + icon('reading') + ' Start reading</button>' +
    '<button class="btn ghost" id="bd-unwrap">' + icon('gift') + ' Unwrap</button>' +
    '<button class="btn ghost" id="bd-pass">' + icon('dice') + ' Pass</button>' +
    '</div></div>';
}

export function runBlindDate() {
  const pool = blindPool();
  const box = document.getElementById('roulette-result');
  if (!pool.length) { toast('No matching books 🎲'); return; }
  track('blind_date_dealt');
  const b = pool[Math.floor(Math.random() * pool.length)];
  box.innerHTML = blindDateHTML(b);
  document.getElementById('bd-pass').addEventListener('click', () => {
    blindPassed[b.id] = true; // memory only — the book itself is untouched
    track('blind_date_pass');
    runBlindDate();
  });
  document.getElementById('bd-unwrap').addEventListener('click', () => {
    track('blind_date_unwrap');
    showWinner(b); // reveal only — status unchanged
  });
  document.getElementById('bd-start').addEventListener('click', () => {
    track('blind_date_start');
    showWinner(b); // Start reading unwraps first (spec §1)
    startRouletteBook(b);
  });
}

export function spinPick() { if (blindDate.on) runBlindDate(); else runRoulette(); }

// v236: dismiss trope suggestions on outside tap (module scope — runs once,
// not per render; the box is re-created by each renderPick).
document.addEventListener('click', e => {
  const box = document.getElementById('pk-suggest');
  if (box && !box.hidden && !e.target.closest('.pk-trope-wrap')) box.hidden = true;
});

export function renderPick() {
  const tbr = tbrBooks();
  const genres = allPickGenres();
  // v235 (UX-19): v224 referenced a `domAxis` that was never defined, so
  // renderPick() threw and Surprise Me went dead. The dominant axis is the
  // most common primary axis across the TBR; its icon replaces the peppers.
  const domAxis = dominantPickAxis();
  const axIcon = icon(domAxis.icon);
  // v359: legible intensity icons (UX backlog #1 — tiny glyphs looked like artifacts)
  const intensityOpts = [
    [0, 'Any'],
    [1, '<span class="pk-int">' + axIcon + '</span> Mild'],
    [2, '<span class="pk-int">' + axIcon + axIcon + '</span> Medium'],
    [3, '<span class="pk-int">' + axIcon + axIcon + axIcon + '</span> Spicy'],
  ];

  let html = '<h2 class="section serif" style="font-size:26px">' + icon('dice') + ' TBR Roulette</h2>' +
    '<p class="note">Can\'t decide what to read next? Set your mood, spin the wheel, and let fate choose.</p>';

  if (!tbr.length) {
    html += emptyState({
      icon: 'dice', title: 'Your TBR is empty',
      body: 'Add some books first,<br>then come back and spin.',
      cta: { label: 'Add books', go: 'add' },
    });
    setView(html);
    return;
  }

  html += '<div class="pick-filters">';
  if (genres.length) {
    // v359: fade-mask scroll container (UX backlog #1 — was raw scrollbar)
    html += '<div class="stat-sub">Genre</div><div class="chip-scroll"><div class="chips">' +
      genres.map(g => '<button class="chip' + (pickState.genres.includes(g) ? ' active' : '') +
        '" data-g="' + esc(g) + '">' + esc(g) + '</button>').join('') + '</div></div>';
  }
  html += '<div class="stat-sub">Trope or tag</div>' +
    // v236: autocomplete — the wrap anchors the suggestion dropdown.
    '<div class="pk-trope-wrap"><input id="pk-trope" class="text-input" autocomplete="off" placeholder="e.g. enemies to lovers, dragons…" value="' + esc(pickState.trope) + '">' +
    '<div id="pk-suggest" class="pk-suggest" hidden></div></div>' +
    '<div class="stat-sub">' + esc(domAxis.label) + ' level</div><div class="chips">' +
    intensityOpts.map(([v, l]) => '<button class="chip' + (pickState.minIntensity === v ? ' active' : '') +
      '" data-s="' + v + '">' + l + '</button>').join('') + '</div>';
  html += '<div class="stat-sub">Queue</div><div class="chips">' +
    '<button class="chip' + (pickState.upNextOnly ? ' active' : '') + '" id="pk-upnext">' + icon('upnext') + ' Up Next only (' + upNext.length + ')</button></div>';
  html += '</div>';

  // v564: Blind Date mode toggle — a mode of this surface, not a new
  // destination. Face up is the classic roulette; Blind date deals the
  // same pick wrapped (blindDateHTML).
  html += '<div class="stat-sub">Pick style</div><div class="chips pk-modes">' +
    '<button class="chip' + (blindDate.on ? '' : ' active') + '" data-bdmode="open">' + icon('covers') + ' Face up</button>' +
    '<button class="chip' + (blindDate.on ? ' active' : '') + '" data-bdmode="blind">' + icon('gift') + ' Blind date</button></div>';

  html += '<p class="note" id="pick-count"></p>' +
    // v359: matching-books preview strip (UX backlog #1 — visual payoff for filters)
    '<div id="pk-preview" class="pk-preview"></div>' +
    '<div class="pk-cta-row">' +
    '<button class="btn pick-btn" id="pk-spin">' + icon('dice') + (blindDate.on ? ' Pick my blind date' : ' Pick my next read') + '</button>' +
    // v359: reset as secondary button next to CTA (was detached floating link)
    '<button class="btn ghost" id="pk-reset">Reset</button>' +
    '</div>' +
    '<div id="roulette-result" style="margin-top:18px"></div>';

  setView(html);
  updatePickCount();
  track('roulette_opened', null, { dedupeKey: 'roulette-open', dedupeMs: 60000 });

  document.querySelectorAll('#view [data-g]').forEach(c => c.addEventListener('click', () => {
    const g = c.dataset.g;
    pickState.genres = pickState.genres.includes(g)
      ? pickState.genres.filter(x => x !== g)
      : pickState.genres.concat(g);
    c.classList.toggle('active');
    updatePickCount();
  }));
  document.querySelectorAll('#view [data-s]').forEach(c => c.addEventListener('click', () => {
    pickState.minIntensity = Number(c.dataset.s);
    document.querySelectorAll('#view [data-s]').forEach(x => x.classList.toggle('active', x === c));
    updatePickCount();
  }));
  // v236: trope autocomplete.
  const pkTrope = document.getElementById('pk-trope');
  const pkSuggest = document.getElementById('pk-suggest');
  const renderTropeSuggest = () => {
    const list = tropeSuggestions(pkTrope.value, 8);
    if (!list.length) { pkSuggest.hidden = true; return; }
    pkSuggest.innerHTML = list.map((s, i) =>
      '<button type="button" data-ts="' + i + '"><span>' + esc(s.name) + '</span>' +
      (s.count ? '<span class="pk-count">' + s.count + ' book' + (s.count === 1 ? '' : 's') + '</span>' : '') +
      '</button>').join('');
    pkSuggest.hidden = false;
    pkSuggest.querySelectorAll('[data-ts]').forEach(btn =>
      btn.addEventListener('click', () => {
        pkTrope.value = list[Number(btn.dataset.ts)].name;
        pickState.trope = pkTrope.value;
        updatePickCount();
        pkSuggest.hidden = true;
        pkTrope.focus();
      }));
  };
  pkTrope.addEventListener('input', () => {
    pickState.trope = pkTrope.value;
    updatePickCount();
    renderTropeSuggest();
  });
  pkTrope.addEventListener('focus', renderTropeSuggest);
  pkTrope.addEventListener('keydown', e => { if (e.key === 'Escape') pkSuggest.hidden = true; });
  document.getElementById('pk-upnext').addEventListener('click', (e) => {
    pickState.upNextOnly = !pickState.upNextOnly;
    e.currentTarget.classList.toggle('active', pickState.upNextOnly);
    updatePickCount();
  });
  // v224 (UX-20): reset all filters and re-render.
  document.getElementById('pk-reset').addEventListener('click', (e) => {
    if (e.currentTarget.disabled) return;
    pickState.genres = [];
    pickState.trope = '';
    pickState.minIntensity = 0;
    pickState.upNextOnly = false;
    renderPick();
  });
  document.querySelectorAll('#view [data-bdmode]').forEach(c => c.addEventListener('click', () => {
    setBlindDate(c.dataset.bdmode === 'blind');
    renderPick();
  }));
  document.getElementById('pk-spin').addEventListener('click', spinPick);
}

export function updatePickCount() {
  const el = document.getElementById('pick-count');
  if (!el) return;
  const candidates = pickCandidates();
  const n = candidates.length;
  el.innerHTML = n
    ? '<b style="color:var(--gold)">' + n + '</b>&nbsp;book' + (n === 1 ? '' : 's') + ' match your mood'
    : 'No TBR books match — loosen the filters a little.';
  const btn = document.getElementById('pk-spin');
  if (btn) btn.disabled = !n;
  // v359: preview strip of matching books
  const prev = document.getElementById('pk-preview');
  if (prev) {
    // v564: in Blind Date mode the strip must not leak what it's
    // previewing — wrapped tiles, no covers, no titles, no tap-through.
    if (blindDate.on) {
      prev.innerHTML = candidates.slice(0, 6).map(() =>
        '<span class="pk-prev-book pk-prev-wrapped">' + icon('gift') + '</span>').join('') +
        (n > 6 ? '<span class="note">+' + (n - 6) + ' more</span>' : '');
    } else {
      prev.innerHTML = candidates.slice(0, 6).map(b =>
        '<button class="pk-prev-book" data-pkprev="' + esc(b.id) + '" title="' + esc(b.title) + '">' +
        // v360: gradient tile with title (consistent with v357 character pages)
        (b.cover ? '<img src="' + esc(b.cover) + '" alt="" loading="lazy">' : '<span class="pk-nocover">' + esc(b.title || '?') + '</span>') +
        '</button>').join('') +
        (n > 6 ? '<span class="note">+' + (n - 6) + ' more</span>' : '');
      prev.querySelectorAll('[data-pkprev]').forEach(im => im.addEventListener('click', () => {
        const book = (typeof library !== 'undefined' ? library : []).find(x => x.id === im.dataset.pkprev);
        if (book && typeof openPreviewModal === 'function') openPreviewModal(book);
      }));
    }
  }
  // v359: reset button disabled state
  const reset = document.getElementById('pk-reset');
  if (reset) {
    const active = pickState.genres.length || pickState.trope || pickState.minIntensity || pickState.upNextOnly;
    reset.disabled = !active;
    reset.style.opacity = active ? '' : '.4';
  }
}

export function runRoulette() {
  const candidates = pickCandidates();
  if (!candidates.length) { toast('No matching books 🎲'); return; }
  track('roulette_spun');
  if (rouletteTimer) clearInterval(rouletteTimer);

  const box = document.getElementById('roulette-result');
  const btn = document.getElementById('pk-spin');
  if (btn) btn.disabled = true;

  box.innerHTML = '<div class="slot"><div class="slot-cover" id="slot-cover"></div>' +
    '<div class="slot-title" id="slot-title"></div></div>';
  const coverEl = document.getElementById('slot-cover');
  const titleEl = document.getElementById('slot-title');

  let ticks = 0;
  const total = 16;
  rouletteTimer = setInterval(() => {
    const b = candidates[Math.floor(Math.random() * candidates.length)];
    coverEl.innerHTML = b.cover
      ? '<img src="' + esc(b.cover) + '" alt="" onerror="this.remove()">'
      : icon('covers');
    titleEl.textContent = b.title;
    if (++ticks >= total) {
      clearInterval(rouletteTimer);
      rouletteTimer = null;
      // Fisher-Yates pick
      const pool = candidates.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      showWinner(pool[0]);
      if (btn) btn.disabled = false;
    }
  }, 90);
}

/* The winner card's Start Reading flow, shared with Blind Date's
   Start (v564): mark reading, with the one-time trigger-check heads-up
   in front of it exactly as the modal's Start behaves. */
export function startRouletteBook(b) {
  const doStart = () => {
    b.status = 'reading';
    saveLibrary();
    track('roulette_book_started');
    toast('Happy reading! 📖');
    filter = 'reading';
    go('library');
  };
  // v455: trigger check — same one-time heads-up as the modal's Start Reading
  // v459: enrich with accepted community trigger warnings first (flywheel).
  (async () => {
    try { if (typeof window.ccEnrichWarnings === 'function') await window.ccEnrichWarnings(b); } catch (e) {}
    if (typeof triggerCheckNeeded === 'function' && triggerCheckNeeded(b)) {
      openTriggerCheckSheet(b, doStart);
      return;
    }
    doStart();
  })();
}

export function showWinner(b) {
  const box = document.getElementById('roulette-result');
  const genres = bookGenres(b);
  const pills = genres.map(g => '<span class="badge">' + esc(g) + '</span>').join('') +
    ratingBadges(b) +
    (b.tropes || []).slice(0, 4).map(t => '<span class="badge">' + icon('tag') + ' ' + esc(t) + '</span>').join('');
  box.innerHTML = '<div class="winner">' +
    '<div class="stat-sub" style="margin-top:0">Fate has spoken ' + icon('sparkles') + '</div>' +
    '<div class="winner-cover">' + (b.cover
      ? '<img src="' + esc(b.cover) + '" alt="" onerror="this.remove()">'
      : icon('covers')) + '</div>' +
    '<h3 class="serif">' + esc(b.title) + '</h3>' +
    '<p class="author">' + esc(displayAuthors(b.authors) || 'Unknown author') + '</p>' +
    (b.description ? '<p class="winner-desc">' + esc(b.description.slice(0, 220)) +
      (b.description.length > 220 ? '…' : '') + '</p>' : '') +
    '<div class="badges" style="justify-content:center">' + pills + '</div>' +
    '<div class="winner-actions">' +
    '<button class="btn" id="w-start">' + icon('reading') + ' Start reading</button>' +
    '<button class="btn ghost" id="w-again">' + icon('dice') + ' Again</button>' +
    '<button class="btn ghost" id="w-detail">' + icon('search') + ' Details</button>' +
    '</div></div>';

  document.getElementById('w-start').addEventListener('click', () => startRouletteBook(b));
  document.getElementById('w-again').addEventListener('click', spinPick);
  document.getElementById('w-detail').addEventListener('click', e => {
    track('roulette_book_opened');
    openDetail(b.id, { fromEl: e.currentTarget });
  });
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The classic consumers, js/198-discovery.js and js/200-boot.js, call these functions at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.tbrBooks = tbrBooks;
window.allPickGenres = allPickGenres;
window.tropeSuggestions = tropeSuggestions;
window.dominantPickAxis = dominantPickAxis;
window.pickCandidates = pickCandidates;
window.blindDate = blindDate;
window.blindPassed = blindPassed;
window.setBlindDate = setBlindDate;
window.blindPool = blindPool;
window.blindDateClues = blindDateClues;
window.blindDateHTML = blindDateHTML;
window.runBlindDate = runBlindDate;
window.spinPick = spinPick;
window.renderPick = renderPick;
window.updatePickCount = updatePickCount;
window.runRoulette = runRoulette;
window.startRouletteBook = startRouletteBook;
window.showWinner = showWinner;
