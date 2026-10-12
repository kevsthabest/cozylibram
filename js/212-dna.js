/* ---- Reader Portrait (v398): a shareable visual card of the user's reading
   taste. Top tropes, avg spice, genre breakdown, reading volume.
   Pure frontend — all data comes from the in-memory library.
   v487: share card redesigned per the Variant B (Midnight) / Variant A
   (Hearthside) mockups — theme-aware colors, ghost numerals, ember dots
   (no glow), spice hidden when unrated, deduped tropes, longest streak. ---- */

function readingDnaData() {
  const read = library.filter(b => b.status === 'read');
  if (!read.length) return null;

  // Top tropes (v487: dedupe overlapping names — "Romance"/"Dark" yield to
  // "DarkRomance" — before taking the top 5)
  const tropeCount = {};
  read.forEach(b => (b.tropes || []).forEach(t => { tropeCount[t] = (tropeCount[t] || 0) + 1; }));
  const topTropes = topEntries(dedupeTropes(tropeCount), 5);

  // Avg spice (same pattern as spiceProfileHTML)
  const sVals = spiceVals(read);
  const avgSpice = sVals.length ? sVals.reduce((s, v) => s + v, 0) / sVals.length : 0;

  // Top genres
  const genreCount = {};
  read.forEach(b => { const g = (typeof bookGenres === 'function' ? bookGenres(b) : [])[0]; if (g) genreCount[g] = (genreCount[g] || 0) + 1; });
  const topGenres = topEntries(genreCount, 3);

  // Volume
  const totalPages = read.reduce((s, b) => s + (b.pageCount || 0), 0);
  // v487: longest streak, not the current one — a shareable portrait shows an
  // achievement, not today's status.
  const streak = typeof longestStreak === 'function' ? longestStreak() : 0;

  // Favorite author
  const authorCount = {};
  read.forEach(b => (b.authors || []).forEach(a => { authorCount[a] = (authorCount[a] || 0) + 1; }));
  const topAuthor = Object.entries(authorCount).sort((a, b) => b[1] - a[1])[0];

  // Spice label
  const spiceLabel = avgSpice >= 4 ? 'High-spice reader' : avgSpice >= 2.5 ? 'Medium-spice reader' : avgSpice > 0 ? 'Low-spice reader' : 'Spice: unrated';

  return { n: read.length, topTropes, avgSpice, spiceLabel, topGenres, totalPages, streak, topAuthor };
}

/* v487: drop a trope when a strictly longer trope name in the same set
   contains it (case-insensitive substring). Pure — unit tested. */
function dedupeTropes(tropeCount) {
  const names = Object.keys(tropeCount || {});
  const drop = new Set();
  names.forEach(a => {
    if (drop.has(a)) return;
    const al = a.toLowerCase();
    names.forEach(b => {
      if (a === b) return;
      const bl = b.toLowerCase();
      if (bl.length > al.length && bl.includes(al)) drop.add(a);
    });
  });
  const out = {};
  names.forEach(n => { if (!drop.has(n)) out[n] = tropeCount[n]; });
  return out;
}

/* ---- v487: theme-aware palette for the share card ----
   Canvas can't read CSS vars, so pull them from the root computed style.
   `light` is derived from --bg luminance (no hardcoded theme list). */
function portraitTheme() {
  let cs = null;
  try { cs = (typeof getComputedStyle === 'function') ? getComputedStyle(document.documentElement) : null; } catch (e) {}
  const g = (n, fb) => {
    let v = '';
    try { v = cs ? String(cs.getPropertyValue(n) || '').trim() : ''; } catch (e) {}
    return v || fb;
  };
  const bg = g('--bg', '#14101a');
  const t = {
    bg: bg,
    bg2: g('--bg2', '#1d1526'),
    card2: g('--card2', '#2c2040'),
    ink: g('--ink', '#f3e9f5'),
    muted: g('--muted', '#b9a8c4'),
    line: g('--line', '#3a2b4d'),
    gold: g('--gold', '#c9a86a'),
    accent: g('--accent', '#8b5cf6'),
    accentDeep: g('--accent-deep', '#6d3fd4')
  };
  t.light = dnaLum(bg) > 0.4;
  return t;
}
function dnaLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
function dnaMix(a, b, t) {
  const pa = /^#?([0-9a-f]{6})$/i.exec(String(a || '').trim());
  const pb = /^#?([0-9a-f]{6})$/i.exec(String(b || '').trim());
  if (!pa || !pb) return a;
  const na = parseInt(pa[1], 16), nb = parseInt(pb[1], 16);
  const ch = (s) => Math.round(((na >> s) & 255) * (1 - t) + (((nb >> s) & 255) * t));
  return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('');
}
function dnaAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* v487: centered letterspaced text (ctx.letterSpacing is spotty cross-browser). */
function dnaSpaced(x, text, cx, y, spacing) {
  const chars = [...String(text)];
  const widths = chars.map(c => { try { return x.measureText(c).width; } catch (e) { return 0; } });
  const total = widths.reduce((s, w) => s + w, 0) + spacing * Math.max(0, chars.length - 1);
  let px = cx - total / 2;
  const prev = x.textAlign; x.textAlign = 'left';
  chars.forEach((c, i) => { x.fillText(c, px, y); px += widths[i] + spacing; });
  x.textAlign = prev;
}
/* v487: shrink a font to fit maxW, then ellipsize if still too wide. */
function dnaFitSize(x, text, maxW, mkFont, base, min) {
  let s = base;
  x.font = mkFont(s);
  while (s > min) {
    let w = 0;
    try { w = x.measureText(text).width; } catch (e) {}
    if (w <= maxW) break;
    s -= 2; x.font = mkFont(s);
  }
  return s;
}
function dnaEllipsize(x, text, maxW) {
  text = String(text);
  let w = 0;
  try { w = x.measureText(text).width; } catch (e) {}
  if (w <= maxW) return text;
  let t = text;
  while (t.length > 1) {
    t = t.slice(0, -1);
    try { w = x.measureText(t + '…').width; } catch (e) { w = 0; }
    if (w <= maxW) break;
  }
  return t + '…';
}

var SERIF = "Georgia, 'Times New Roman', serif";
var SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/* v487: ember dots for the spice level. No glow (Kevin's critique: the italic
   title + ghost numerals are decoration enough). */
function dnaSpiceDots(x, d, t, x0, cy) {
  const r = 29, gap = 24;
  const full = Math.min(5, Math.floor(d.avgSpice + 1e-6));
  const frac = d.avgSpice - Math.floor(d.avgSpice + 1e-6);
  const darkDot = dnaMix(t.bg, t.ink, 0.10);
  for (let i = 0; i < 5; i++) {
    const cx = x0 + r + i * (r * 2 + gap);
    x.beginPath();
    try { x.arc(cx, cy, r, 0, Math.PI * 2); } catch (e) {}
    if (i < full) {
      let g = null;
      try {
        g = x.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
        g.addColorStop(0, t.accent); g.addColorStop(1, t.accentDeep);
      } catch (e) {}
      x.fillStyle = g || t.accent; x.fill();
    } else if (i === full && frac > 0.05) {
      let g = null;
      try {
        g = x.createLinearGradient(cx - r, 0, cx + r, 0);
        g.addColorStop(0, t.accent); g.addColorStop(frac, t.accent);
        g.addColorStop(frac, darkDot); g.addColorStop(1, darkDot);
      } catch (e) {}
      x.fillStyle = g || t.accent; x.fill();
    } else {
      x.fillStyle = dnaMix(t.bg2, t.ink, 0.08); x.fill();
      x.strokeStyle = t.line; x.lineWidth = 3;
      try { x.stroke(); } catch (e) {}
    }
  }
}

/* v487: Variant B (Midnight) — dark, dramatic. Ghost numerals, ember dots. */
function drawPortraitMidnight(x, W, H, d, t) {
  const pad = 90;
  x.fillStyle = t.bg; x.fillRect(0, 0, W, H);
  // Radial glow behind the title (theme-tinted, no extra decoration)
  try {
    x.save(); x.translate(W / 2, 340); x.scale(1, 0.62);
    const rg = x.createRadialGradient(0, 0, 0, 0, 0, 660);
    rg.addColorStop(0, dnaMix(t.bg2, t.ink, 0.16));
    rg.addColorStop(0.55, t.bg2);
    rg.addColorStop(1, dnaAlpha(t.bg2, 0));
    x.fillStyle = rg; x.fillRect(-560, -560, 1120, 3120);
    x.restore();
  } catch (e) { try { x.restore(); } catch (_) {} }

  x.textAlign = 'center'; x.textBaseline = 'alphabetic';

  // Title — italic gold display serif (kept; glow on dots was cut instead)
  x.fillStyle = t.gold;
  x.font = 'italic 700 100px ' + SERIF;
  x.fillText('My Reader', W / 2, 215);
  x.fillText('Portrait', W / 2, 325);

  // Book count
  x.fillStyle = t.muted; x.font = '32px ' + SANS;
  dnaSpaced(x, d.n + ' BOOKS ANALYZED', W / 2, 400, 10);

  let y = 490;

  // Spice — ember dots + caption (renders only when rated)
  if (d.avgSpice > 0) {
    x.textAlign = 'left'; x.fillStyle = t.muted; x.font = '30px ' + SANS;
    dnaSpaced(x, 'SPICE', pad + 130, y, 8); y += 30;
    dnaSpiceDots(x, d, t, pad, y + 35); y += 110;
    x.fillStyle = t.muted; x.font = 'italic 34px ' + SERIF;
    x.fillText(d.spiceLabel.toLowerCase() + ' · ' + d.avgSpice.toFixed(1) + ' of 5', pad, y); y += 90;
  } else {
    y += 10;
  }

  // Signature tropes — ghost numerals
  const rowH = 120;
  d.topTropes.forEach(([name, c], i) => {
    const cy = y + i * rowH;
    x.textAlign = 'left'; x.font = 'italic 700 100px ' + SERIF;
    x.save(); x.globalAlpha = 0.16; x.fillStyle = t.gold;
    x.fillText(i < 9 ? '0' + (i + 1) : String(i + 1), pad, cy + 34);
    x.restore();
    const mkN = (s) => '48px ' + SERIF;
    const fs = dnaFitSize(x, name, 560, mkN, 48, 30);
    x.font = mkN(fs); x.fillStyle = t.ink;
    x.fillText(dnaEllipsize(x, name, 560), 275, cy + 16);
    x.textAlign = 'right'; x.font = '34px ' + SANS; x.fillStyle = t.muted;
    x.fillText(String(c), W - pad, cy + 12);
  });
  y += d.topTropes.length * rowH + 40;

  // Beloved genres
  x.textAlign = 'left'; x.fillStyle = t.muted; x.font = '30px ' + SANS;
  dnaSpaced(x, 'BELOVED GENRES', pad + 175, y, 8); y += 30;
  d.topGenres.forEach(([gname, c], i) => {
    const cy = y + i * 74;
    const mkG = (s) => 'italic 48px ' + SERIF;
    const fs = dnaFitSize(x, gname, 560, mkG, 48, 30);
    x.font = mkG(fs); x.fillStyle = t.ink; x.textAlign = 'left';
    x.fillText(dnaEllipsize(x, gname, 560), pad, cy + 16);
    x.textAlign = 'right'; x.font = '34px ' + SANS; x.fillStyle = t.muted;
    x.fillText(c + (c === 1 ? ' book' : ' books'), W - pad, cy + 12);
    if (i < d.topGenres.length - 1) {
      x.strokeStyle = dnaAlpha(t.ink, 0.18); x.lineWidth = 2;
      x.beginPath(); x.moveTo(pad, cy + 52); x.lineTo(W - pad, cy + 52); x.stroke();
    }
  });
  y += d.topGenres.length * 74 + 50;

  // By the numbers — gold stat figures
  x.textAlign = 'left'; x.fillStyle = t.muted; x.font = '30px ' + SANS;
  dnaSpaced(x, 'BY THE NUMBERS', pad + 175, y, 8); y += 40;
  const cols = [270, 540, 810];
  const stats = [
    [d.totalPages.toLocaleString(), 'PAGES', 64],
    [String(d.streak), 'LONGEST STREAK', 64],
    [d.topAuthor ? d.topAuthor[0] : '—', 'TOP AUTHOR', 40]
  ];
  stats.forEach(([val, lab], i) => {
    const mkS = (s) => '700 ' + s + 'px ' + SERIF;
    const fs = dnaFitSize(x, val, 280, mkS, lab === 'TOP AUTHOR' ? 40 : 64, 24);
    x.font = mkS(fs); x.fillStyle = t.gold; x.textAlign = 'center';
    x.fillText(dnaEllipsize(x, val, 280), cols[i], y + 62);
    x.fillStyle = t.muted; x.font = '26px ' + SANS;
    dnaSpaced(x, lab, cols[i], y + 108, 3);
  });
  x.strokeStyle = dnaAlpha(t.ink, 0.25); x.lineWidth = 2;
  [405, 675].forEach(dx => { x.beginPath(); x.moveTo(dx, y + 8); x.lineTo(dx, y + 118); x.stroke(); });

  // Footer — minimal, keeps the BookTok-native emoji
  x.fillStyle = t.muted; x.font = '32px ' + SANS;
  dnaSpaced(x, 'tracked with cozy libram 🌶️🖤', W / 2, 1865, 4);
}

/* v487: Variant A (Hearthside) — light, bookplate. Used on light themes. */
function drawPortraitHearthside(x, W, H, d, t) {
  const pad = 90;
  let bg = null;
  try {
    bg = x.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, t.bg);
    bg.addColorStop(0.6, dnaMix(t.bg, t.bg2, 0.5));
    bg.addColorStop(1, t.bg2);
  } catch (e) {}
  x.fillStyle = bg || t.bg; x.fillRect(0, 0, W, H);
  x.textAlign = 'center'; x.textBaseline = 'alphabetic';

  x.fillStyle = t.gold; x.font = '54px ' + SERIF;
  x.fillText('❦', W / 2, 150);

  x.fillStyle = t.ink; x.font = '40px ' + SANS;
  dnaSpaced(x, 'MY READER PORTRAIT', W / 2, 225, 14);

  x.fillStyle = t.muted; x.font = 'italic 34px ' + SERIF;
  x.fillText(d.n + ' books analyzed', W / 2, 290);

  x.strokeStyle = t.gold; x.lineWidth = 2;
  x.beginPath(); x.moveTo(210, 350); x.lineTo(W - 210, 350); x.stroke();

  let y = 430;

  // Spice — big number + ember bar (renders only when rated)
  if (d.avgSpice > 0) {
    x.fillStyle = t.muted; x.font = '30px ' + SANS;
    dnaSpaced(x, 'SPICE LEVEL', W / 2, y, 8); y += 110;
    const num = d.avgSpice.toFixed(1), den = '/ 5';
    x.font = '700 110px ' + SERIF; x.fillStyle = t.ink;
    let nw = 0, dw = 0;
    try { nw = x.measureText(num).width; } catch (e) {}
    x.font = '40px ' + SANS; x.fillStyle = t.muted;
    try { dw = x.measureText(den).width; } catch (e) {}
    const total = nw + 24 + dw, sx = W / 2 - total / 2;
    x.textAlign = 'left'; x.font = '700 110px ' + SERIF; x.fillStyle = t.ink;
    x.fillText(num, sx, y);
    x.font = '40px ' + SANS; x.fillStyle = t.muted;
    x.fillText(den, sx + nw + 24, y);
    x.textAlign = 'center'; y += 60;
    const barW = W - pad * 2, fillW = Math.round(d.avgSpice / 5 * barW);
    x.fillStyle = dnaMix(t.bg2, t.ink, 0.22);
    cvRoundRect(x, pad, y, barW, 16, 8); x.fill();
    if (fillW > 0) {
      let fg = null;
      try {
        fg = x.createLinearGradient(pad, 0, pad + barW, 0);
        fg.addColorStop(0, t.accent); fg.addColorStop(1, t.accentDeep);
      } catch (e) {}
      x.fillStyle = fg || t.accent;
      cvRoundRect(x, pad, y, Math.max(fillW, 16), 16, 8); x.fill();
    }
    y += 110;
  }

  // Signature tropes
  x.fillStyle = t.muted; x.font = '30px ' + SANS;
  dnaSpaced(x, 'SIGNATURE TROPES', W / 2, y, 8); y += 30;
  d.topTropes.forEach(([name, c], i) => {
    const cy = y + i * 96;
    x.textAlign = 'left'; x.font = '700 60px ' + SERIF; x.fillStyle = t.accent;
    x.fillText(String(i + 1), pad, cy + 20);
    const mkN = (s) => s + 'px ' + SERIF;
    const fs = dnaFitSize(x, name, 540, mkN, 44, 28);
    x.font = mkN(fs); x.fillStyle = t.ink;
    x.fillText(dnaEllipsize(x, name, 540), 210, cy + 16);
    x.textAlign = 'right'; x.font = 'italic 34px ' + SERIF; x.fillStyle = t.muted;
    x.fillText(c + (c === 1 ? ' book' : ' books'), W - pad, cy + 12);
    if (i < d.topTropes.length - 1) {
      x.strokeStyle = t.line; x.lineWidth = 2;
      x.beginPath(); x.moveTo(pad, cy + 58); x.lineTo(W - pad, cy + 58); x.stroke();
    }
  });
  y += d.topTropes.length * 96 + 60;

  // Beloved genres
  x.fillStyle = t.muted; x.font = '30px ' + SANS;
  dnaSpaced(x, 'BELOVED GENRES', W / 2, y, 8); y += 30;
  d.topGenres.forEach(([gname, c]) => {
    const mkG = (s) => 'italic ' + s + 'px ' + SERIF;
    const fs = dnaFitSize(x, gname, 600, mkG, 44, 28);
    x.font = mkG(fs); x.fillStyle = t.ink; x.textAlign = 'left';
    x.fillText(dnaEllipsize(x, gname, 600), pad, y + 40);
    x.textAlign = 'right'; x.font = '34px ' + SANS; x.fillStyle = t.muted;
    x.fillText(String(c), W - pad, y + 36);
    y += 66;
  });
  y += 40;

  // By the numbers
  x.fillStyle = t.muted; x.font = '30px ' + SANS;
  dnaSpaced(x, 'BY THE NUMBERS', W / 2, y, 8); y += 30;
  const cols = [270, 540, 810];
  const stats = [
    [d.totalPages.toLocaleString(), 'PAGES DEVOURED', 56],
    [String(d.streak), 'LONGEST STREAK', 56],
    [d.topAuthor ? d.topAuthor[0] : '—', 'TOP AUTHOR', 40]
  ];
  stats.forEach(([val, lab], i) => {
    const mkS = (s) => '700 ' + s + 'px ' + SERIF;
    const fs = dnaFitSize(x, val, 280, mkS, lab === 'TOP AUTHOR' ? 40 : 56, 22);
    x.font = mkS(fs); x.fillStyle = t.ink; x.textAlign = 'center';
    x.fillText(dnaEllipsize(x, val, 280), cols[i], y + 58);
    x.fillStyle = t.muted; x.font = '26px ' + SANS;
    dnaSpaced(x, lab, cols[i], y + 100, 2);
  });
  x.strokeStyle = t.line; x.lineWidth = 2;
  [405, 675].forEach(dx => { x.beginPath(); x.moveTo(dx, y + 6); x.lineTo(dx, y + 110); x.stroke(); });

  // Footer
  x.strokeStyle = t.gold; x.lineWidth = 2;
  x.beginPath(); x.moveTo(290, 1760); x.lineTo(W - 290, 1760); x.stroke();
  x.fillStyle = t.muted; x.font = '32px ' + SANS;
  dnaSpaced(x, 'TRACKED WITH COZY LIBRAM', W / 2, 1820, 6);
}

/* v487: theme-aware entry. Dark themes → Midnight (B); light → Hearthside (A).
   Spice section renders only when avgSpice > 0. */
function drawDnaImage(d) {
  const W = 1080, H = 1920;
  let cv = null;
  try {
    cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
  } catch (e) { return null; }
  const x = cv.getContext('2d');
  if (!x) return null;
  const t = portraitTheme();
  if (t.light) drawPortraitHearthside(x, W, H, d, t);
  else drawPortraitMidnight(x, W, H, d, t);
  return cv;
}

function shareDnaImage() {
  const d = readingDnaData();
  if (!d) { toast('Read some books first! 📚'); return; }
  const cv = drawDnaImage(d);
  if (cv) {
    shareCanvasFile(cv, 'my-reader-portrait.png', 'My Reader Portrait');
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
  return '<div class="stat-sub">' + icon('crystal') + ' Reader Portrait</div>' +
    '<div class="dna-preview">' +
    (d.avgSpice > 0 ? '<p><b>' + d.spiceLabel + '</b> · avg ' + d.avgSpice.toFixed(1) + '/5</p>' : '') +
    '<div class="chip-row">' + tropeChips + '</div>' +
    '<div class="chip-row" style="margin-top:8px">' + genreChips + '</div>' +
    '<p class="note">' + d.n + ' books · ' + d.totalPages.toLocaleString() + ' pages' +
    (d.topAuthor ? ' · top author: ' + esc(d.topAuthor[0]) : '') + '</p>' +
    '<button class="btn" id="dna-share-btn" style="margin-top:12px">Share my portrait 📖</button>' +
    '</div>';
}

function wireDnaShare() {
  const btn = document.getElementById('dna-share-btn');
  if (btn) btn.addEventListener('click', shareDnaImage);
}

/* ---- Reader Portrait hero card (v486): prominent placement at the top of
   the Details view. Wraps dnaSectionHTML(); returns '' when gated/empty. ---- */
function dnaHeroHTML() {
  if (typeof dnaSectionHTML !== 'function') return '';
  const h = dnaSectionHTML();
  return h ? '<div class="dna-hero">' + h + '</div>' : '';
}
