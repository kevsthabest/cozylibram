/* ---- Reading DNA (v398): a shareable visual "genome" card of the user's
   reading taste. Top tropes, avg spice, genre breakdown, reading volume.
   Pure frontend — all data comes from the in-memory library. ---- */

function readingDnaData() {
  const read = library.filter(b => b.status === 'read');
  if (!read.length) return null;

  // Top tropes (same pattern as renderStats line 921)
  const tropeCount = {};
  read.forEach(b => (b.tropes || []).forEach(t => { tropeCount[t] = (tropeCount[t] || 0) + 1; }));
  const topTropes = topEntries(tropeCount, 5);

  // Avg spice (same pattern as spiceProfileHTML)
  const sVals = spiceVals(read);
  const avgSpice = sVals.length ? sVals.reduce((s, v) => s + v, 0) / spiceVals.length : 0;

  // Top genres
  const genreCount = {};
  read.forEach(b => { const g = (typeof bookGenres === 'function' ? bookGenres(b) : [])[0]; if (g) genreCount[g] = (genreCount[g] || 0) + 1; });
  const topGenres = topEntries(genreCount, 3);

  // Volume
  const totalPages = read.reduce((s, b) => s + (b.pageCount || 0), 0);
  const streak = typeof readingStreak === 'function' ? readingStreak() : 0;

  // Favorite author
  const authorCount = {};
  read.forEach(b => (b.authors || []).forEach(a => { authorCount[a] = (authorCount[a] || 0) + 1; }));
  const topAuthor = Object.entries(authorCount).sort((a, b) => b[1] - a[1])[0];

  // Spice label
  const spiceLabel = avgSpice >= 4 ? 'High-spice reader' : avgSpice >= 2.5 ? 'Medium-spice reader' : avgSpice > 0 ? 'Low-spice reader' : 'Spice: unrated';

  return { n: read.length, topTropes, avgSpice, spiceLabel, topGenres, totalPages, streak, topAuthor };
}

function drawDnaImage(d) {
  const c = cardCanvas();
  if (!c) return null;
  const { cv, x, W, H, C } = c;
  const { ink, mut, acc, gold, grn } = C;

  // Header
  x.textAlign = 'center'; x.fillStyle = ink;
  x.font = '700 72px system-ui, sans-serif';
  x.fillText('🧬 My Reading DNA', W / 2, 180);
  x.fillStyle = mut; x.font = '40px system-ui, sans-serif';
  x.fillText(d.n + ' books analyzed', W / 2, 245);

  let y = 360;

  // Spice section
  x.textAlign = 'left'; x.fillStyle = gold; x.font = '700 48px system-ui, sans-serif';
  x.fillText('🌶️ Spice Level', 80, y); y += 70;
  x.fillStyle = ink; x.font = '56px system-ui, sans-serif';
  x.fillText(d.spiceLabel + (d.avgSpice > 0 ? '  (' + d.avgSpice.toFixed(1) + '/5)' : ''), 80, y); y += 60;
  // Spice bar
  const barW = W - 160, filled = Math.round(d.avgSpice / 5 * barW);
  x.fillStyle = '#3a2545'; cvRoundRect(x, 80, y, barW, 36, 18); x.fill();
  if (filled > 0) { x.fillStyle = acc; cvRoundRect(x, 80, y, filled, 36, 18); x.fill(); }
  y += 110;

  // Top tropes section
  x.fillStyle = acc; x.font = '700 48px system-ui, sans-serif';
  x.fillText('📚 Top Tropes', 80, y); y += 70;
  x.font = '44px system-ui, sans-serif';
  d.topTropes.forEach(([t, c], i) => {
    x.fillStyle = i === 0 ? gold : ink;
    const label = (i + 1) + '. ' + t;
    const lines = cvWrap(x, label, W - 200);
    lines.forEach(ln => { x.fillText(ln, 100, y); y += 58; });
    x.fillStyle = mut; x.font = '36px system-ui, sans-serif';
    x.fillText(c + ' books', 100, y); y += 62;
    x.font = '44px system-ui, sans-serif';
  });
  y += 30;

  // Genres section
  x.fillStyle = grn; x.font = '700 48px system-ui, sans-serif';
  x.fillText('🎭 Top Genres', 80, y); y += 70;
  x.fillStyle = ink; x.font = '44px system-ui, sans-serif';
  d.topGenres.forEach(([g, c]) => {
    x.fillText('• ' + g + '  (' + c + ')', 100, y); y += 62;
  });
  y += 50;

  // Volume stats
  x.fillStyle = mut; x.font = '700 48px system-ui, sans-serif';
  x.fillText('📊 By the Numbers', 80, y); y += 70;
  x.fillStyle = ink; x.font = '44px system-ui, sans-serif';
  x.fillText('📖 ' + d.totalPages.toLocaleString() + ' pages devoured', 100, y); y += 62;
  if (d.streak > 0) { x.fillText('🔥 ' + d.streak + '-day reading streak', 100, y); y += 62; }
  if (d.topAuthor) { x.fillText('✍️ Most-read: ' + d.topAuthor[0], 100, y); y += 62; }

  // Footer
  cardFooter(x, W);
  return cv;
}

function shareDnaImage() {
  const d = readingDnaData();
  if (!d) { toast('Read some books first! 📚'); return; }
  const cv = drawDnaImage(d);
  if (cv) {
    shareCanvasFile(cv, 'my-reading-dna.png', 'My Reading DNA');
    track('dna_shared', { books: d.n });
  }
}

/* ---- Reading DNA section in the Stats tab ---- */
function dnaSectionHTML() {
  const d = readingDnaData();
  if (!d) return '';
  const tropeChips = d.topTropes.map(([t, c]) =>
    '<span class="chip">' + esc(t) + ' <b>' + c + '</b></span>').join('');
  const genreChips = d.topGenres.map(([g, c]) =>
    '<span class="chip">' + esc(g) + '</span>').join('');
  return '<div class="stat-sub">🧬 Reading DNA</div>' +
    '<div class="dna-preview">' +
    '<p><b>' + d.spiceLabel + '</b>' + (d.avgSpice > 0 ? ' · avg ' + d.avgSpice.toFixed(1) + '/5' : '') + '</p>' +
    '<div class="chip-row">' + tropeChips + '</div>' +
    '<div class="chip-row" style="margin-top:8px">' + genreChips + '</div>' +
    '<p class="note">' + d.n + ' books · ' + d.totalPages.toLocaleString() + ' pages' +
    (d.topAuthor ? ' · top author: ' + esc(d.topAuthor[0]) : '') + '</p>' +
    '<button class="btn" id="dna-share-btn" style="margin-top:12px">Share my DNA 🧬</button>' +
    '</div>';
}

function wireDnaShare() {
  const btn = document.getElementById('dna-share-btn');
  if (btn) btn.addEventListener('click', shareDnaImage);
}
