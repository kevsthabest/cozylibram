'use strict';

/* ---------------- TBR roulette ---------------- */
function tbrBooks() { return library.filter(b => b.status === 'tbr'); }

function allPickGenres() {
  const set = [];
  tbrBooks().forEach(b => bookGenres(b).forEach(g => { if (!set.includes(g)) set.push(g); }));
  return set.sort();
}

function pickCandidates() {
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

function renderPick() {
  const tbr = tbrBooks();
  const genres = allPickGenres();
  const intensityOpts = [
    [0, 'Any'], [1, icon('pepper') + '+'], [2, icon('pepper') + icon('pepper') + '+'], [3, icon('pepper') + icon('pepper') + icon('pepper') + '+']
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
    html += '<div class="stat-sub">Genre</div><div class="chips">' +
      genres.map(g => '<button class="chip' + (pickState.genres.includes(g) ? ' active' : '') +
        '" data-g="' + esc(g) + '">' + esc(g) + '</button>').join('') + '</div>';
  }
  html += '<div class="stat-sub">Trope or tag</div>' +
    '<input id="pk-trope" class="text-input" placeholder="e.g. enemies to lovers, dragons…" value="' + esc(pickState.trope) + '">' +
    '<div class="stat-sub">How intense?</div><div class="chips">' +
    intensityOpts.map(([v, l]) => '<button class="chip' + (pickState.minIntensity === v ? ' active' : '') +
      '" data-s="' + v + '">' + l + '</button>').join('') + '</div>';
  html += '<div class="stat-sub">Queue</div><div class="chips">' +
    '<button class="chip' + (pickState.upNextOnly ? ' active' : '') + '" id="pk-upnext">⏭️ Up Next only (' + upNext.length + ')</button></div>';
  html += '</div>';

  html += '<p class="note" id="pick-count"></p>' +
    '<button class="btn pick-btn" id="pk-spin">' + icon('dice') + ' Pick my next read</button>' +
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
  document.getElementById('pk-trope').addEventListener('input', e => {
    pickState.trope = e.target.value;
    updatePickCount();
  });
  document.getElementById('pk-upnext').addEventListener('click', (e) => {
    pickState.upNextOnly = !pickState.upNextOnly;
    e.currentTarget.classList.toggle('active', pickState.upNextOnly);
    updatePickCount();
  });
  document.getElementById('pk-spin').addEventListener('click', runRoulette);
}

function updatePickCount() {
  const el = document.getElementById('pick-count');
  if (!el) return;
  const n = pickCandidates().length;
  el.innerHTML = n
    ? '<b style="color:var(--gold)">' + n + '</b> book' + (n === 1 ? '' : 's') + ' match your mood'
    : 'No TBR books match — loosen the filters a little.';
  const btn = document.getElementById('pk-spin');
  if (btn) btn.disabled = !n;
}

function runRoulette() {
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

function showWinner(b) {
  const box = document.getElementById('roulette-result');
  const genres = bookGenres(b);
  const pills = genres.map(g => '<span class="badge">' + esc(g) + '</span>').join('') +
    ratingBadges(b) +
    (b.tropes || []).slice(0, 4).map(t => '<span class="badge">🏷️ ' + esc(t) + '</span>').join('');
  box.innerHTML = '<div class="winner">' +
    '<div class="stat-sub" style="margin-top:0">Fate has spoken ' + icon('sparkles') + '</div>' +
    '<div class="winner-cover">' + (b.cover
      ? '<img src="' + esc(b.cover) + '" alt="" onerror="this.remove()">'
      : icon('covers')) + '</div>' +
    '<h3 class="serif">' + esc(b.title) + '</h3>' +
    '<p class="author">' + esc(b.authors.join(', ') || 'Unknown author') + '</p>' +
    (b.description ? '<p class="winner-desc">' + esc(b.description.slice(0, 220)) +
      (b.description.length > 220 ? '…' : '') + '</p>' : '') +
    '<div class="badges" style="justify-content:center">' + pills + '</div>' +
    '<div class="winner-actions">' +
    '<button class="btn" id="w-start">' + icon('reading') + ' Start reading</button>' +
    '<button class="btn ghost" id="w-again">' + icon('dice') + ' Again</button>' +
    '<button class="btn ghost" id="w-detail">' + icon('search') + ' Details</button>' +
    '</div></div>';

  document.getElementById('w-start').addEventListener('click', () => {
    b.status = 'reading';
    saveLibrary();
    track('roulette_book_started');
    toast('Happy reading! 📖');
    filter = 'reading';
    go('library');
  });
  document.getElementById('w-again').addEventListener('click', runRoulette);
  document.getElementById('w-detail').addEventListener('click', e => {
    track('roulette_book_opened');
    openDetail(b.id, { fromEl: e.currentTarget });
  });
}

