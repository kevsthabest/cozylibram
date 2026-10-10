/* ---- Reading Wrapped (v398): year-end shareable stats, Spotify-Wrapped-style.
   Builds on yearInBooksData() from 170-stats.js, adding spice distribution
   and year-in-tropes. Auto-shows a banner in December/January. ---- */

function wrappedData(yr) {
  const base = yearInBooksData(yr);
  if (!base || !base.n) return base;

  const readYr = library.filter(b => b.status === 'read' && b.dateFinished &&
    new Date(b.dateFinished).getFullYear() === (yr || yibYear));

  // Spice distribution for the year
  const spiceVals = readYr.map(b => (b.ratings || {}).spice || 0).filter(v => v > 0);
  const avgSpice = spiceVals.length ? spiceVals.reduce((s, v) => s + v, 0) / spiceVals.length : 0;
  const spiceDist = [0, 0, 0, 0, 0]; // buckets for 1-5
  spiceVals.forEach(v => { spiceDist[Math.min(4, Math.max(0, Math.round(v) - 1))]++; });

  // Year in tropes (top 5 tropes from this year's reads)
  const tropeCount = {};
  readYr.forEach(b => (b.tropes || []).forEach(t => { tropeCount[t] = (tropeCount[t] || 0) + 1; }));
  const yearTropes = Object.entries(tropeCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Total hours (1 page ≈ 1 minute)
  const hours = Math.round(base.pages / 60);

  // DNF count for the year
  const dnfs = library.filter(b => b.status === 'dnf' && b.dnfAt &&
    new Date(b.dnfAt).getFullYear() === (yr || yibYear)).length;

  return Object.assign({}, base, { avgSpice, spiceDist, yearTropes, hours, dnfs });
}

function drawWrappedImage(d) {
  const W = 1080, H = 1920;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  if (!x) return null;
  const ink = '#f6eff8', mut = '#b9a8c6', acc = '#e5648e', gold = '#e5b86a', grn = '#7de2a8';

  const bg = x.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1a0f2e'); bg.addColorStop(0.5, '#2b1535'); bg.addColorStop(1, '#100a16');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);

  // Festive header
  x.textAlign = 'center'; x.fillStyle = gold;
  x.font = '700 80px system-ui, sans-serif';
  x.fillText('✨ ' + d.yr + ' Wrapped ✨', W / 2, 160);
  x.fillStyle = mut; x.font = '40px system-ui, sans-serif';
  x.fillText('Your year in books', W / 2, 220);

  let y = 340;
  x.textAlign = 'left';

  // Hero numbers
  const hero = (label, val, color) => {
    x.fillStyle = color; x.font = '700 88px system-ui, sans-serif';
    x.fillText(String(val), 80, y);
    x.fillStyle = mut; x.font = '40px system-ui, sans-serif';
    x.fillText(label, 80, y + 50); y += 140;
  };
  hero('books finished', d.n, acc);
  hero('pages devoured', d.pages.toLocaleString(), gold);
  if (d.hours > 0) hero('hours reading', d.hours, grn);

  y += 20;

  // Top tropes
  if (d.yearTropes.length) {
    x.fillStyle = acc; x.font = '700 48px system-ui, sans-serif';
    x.fillText('📚 Your year in tropes', 80, y); y += 70;
    x.font = '42px system-ui, sans-serif';
    d.yearTropes.forEach(([t, c], i) => {
      x.fillStyle = i === 0 ? gold : ink;
      const lines = cvWrap(x, (i + 1) + '. ' + t + '  (' + c + ')', W - 200);
      lines.forEach(ln => { x.fillText(ln, 100, y); y += 56; });
    });
    y += 30;
  }

  // Spice + genres
  if (d.avgSpice > 0) {
    x.fillStyle = gold; x.font = '700 48px system-ui, sans-serif';
    x.fillText('🌶️ Spice level', 80, y); y += 65;
    x.fillStyle = ink; x.font = '42px system-ui, sans-serif';
    x.fillText('Average: ' + d.avgSpice.toFixed(1) + '/5', 100, y); y += 80;
  }
  if (d.topGenres.length) {
    x.fillStyle = grn; x.font = '700 48px system-ui, sans-serif';
    x.fillText('🎭 Top genres', 80, y); y += 65;
    x.fillStyle = ink; x.font = '42px system-ui, sans-serif';
    d.topGenres.forEach(([g, c]) => { x.fillText('• ' + g, 100, y); y += 56; });
    y += 20;
  }

  // Fun stats
  x.fillStyle = mut; x.font = '700 44px system-ui, sans-serif';
  x.fillText('📊 Fun stats', 80, y); y += 65;
  x.fillStyle = ink; x.font = '40px system-ui, sans-serif';
  if (d.streak > 1) { x.fillText('🔥 Longest streak: ' + d.streak + ' days', 100, y); y += 56; }
  if (d.five > 0) { x.fillText('⭐ 5-star books: ' + d.five, 100, y); y += 56; }
  if (d.topAuthor) { x.fillText('✍️ Top author: ' + d.topAuthor[0], 100, y); y += 56; }
  if (d.dnfs > 0) { x.fillText('📕 DNFs: ' + d.dnfs + ' (no shame)', 100, y); y += 56; }

  x.textAlign = 'center'; x.fillStyle = mut; x.font = '36px system-ui, sans-serif';
  x.fillText('Tracked with Cozy Libram 🌶️🖤', W / 2, 1845);
  return cv;
}

function shareWrappedImage(yr) {
  const d = wrappedData(yr);
  if (!d || !d.n) { toast('No books finished this year yet! 📚'); return; }
  const cv = drawWrappedImage(d);
  if (cv) {
    shareCanvasFile(cv, 'my-' + d.yr + '-wrapped.png', 'My ' + d.yr + ' Reading Wrapped');
    track('wrapped_shared', { year: d.yr, books: d.n });
  }
}

/* ---- Wrapped banner: auto-show in Dec/Jan ---- */
function maybeShowWrappedBanner() {
  const m = new Date().getMonth(); // 0-indexed
  if (m !== 11 && m !== 0) return; // only Dec + Jan
  if (localStorage.getItem('wrapped-banner-' + new Date().getFullYear())) return;
  const yr = m === 11 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const d = wrappedData(yr);
  if (!d || d.n < 3) return; // need at least 3 books for a meaningful wrapped

  const banner = document.createElement('div');
  banner.className = 'wrapped-banner';
  banner.innerHTML =
    '<div class="wrapped-banner-inner">' +
    '<span>✨ Your ' + yr + ' Reading Wrapped is ready!</span>' +
    '<button class="btn" id="wrapped-banner-btn">View ✨</button>' +
    '<button class="wrapped-dismiss" id="wrapped-banner-x">✕</button>' +
    '</div>';
  document.body.appendChild(banner);

  document.getElementById('wrapped-banner-btn').addEventListener('click', () => {
    localStorage.setItem('wrapped-banner-' + new Date().getFullYear(), '1');
    banner.remove();
    // Navigate to stats tab and trigger wrapped view
    if (typeof showTab === 'function') showTab('stats');
    setTimeout(() => openWrappedView(yr), 300);
  });
  document.getElementById('wrapped-banner-x').addEventListener('click', () => {
    localStorage.setItem('wrapped-banner-' + new Date().getFullYear(), '1');
    banner.remove();
  });
}

function openWrappedView(yr) {
  const d = wrappedData(yr);
  if (!d || !d.n) { toast('No data for ' + yr); return; }
  // Reuse the year-in-books view, then add a share button
  if (typeof renderYearInBooks === 'function') renderYearInBooks(yr);
  setTimeout(() => {
    const container = document.querySelector('.yib-wrap, .year-in-books');
    if (container && !document.getElementById('wrapped-share-btn')) {
      const btn = document.createElement('button');
      btn.id = 'wrapped-share-btn';
      btn.className = 'btn';
      btn.style.margin = '16px auto';
      btn.style.display = 'block';
      btn.textContent = 'Share my ' + yr + ' Wrapped ✨';
      btn.addEventListener('click', () => shareWrappedImage(yr));
      container.appendChild(btn);
    }
  }, 100);
}
