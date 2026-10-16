/* ---- Reader Portrait (v398): a shareable visual card of the user's reading
   taste. Top tropes, avg spice, genre breakdown, reading volume.
   Pure frontend — all data comes from the in-memory library.
   v487: share card redesigned per the Variant B (Midnight) / Variant A
   (Hearthside) mockups — theme-aware colors, ghost numerals, ember dots
   (no glow), spice hidden when unrated, deduped tropes, longest streak. ---- */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export function readingDnaData() {
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
export function dedupeTropes(tropeCount) {
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
export function portraitTheme() {
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
export function dnaLum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
export function dnaMix(a, b, t) {
  const pa = /^#?([0-9a-f]{6})$/i.exec(String(a || '').trim());
  const pb = /^#?([0-9a-f]{6})$/i.exec(String(b || '').trim());
  if (!pa || !pb) return a;
  const na = parseInt(pa[1], 16), nb = parseInt(pb[1], 16);
  const ch = (s) => Math.round(((na >> s) & 255) * (1 - t) + (((nb >> s) & 255) * t));
  return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('');
}
export function dnaAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* v487: centered letterspaced text (ctx.letterSpacing is spotty cross-browser). */
export function dnaSpaced(x, text, cx, y, spacing) {
  const chars = [...String(text)];
  const widths = chars.map(c => { try { return x.measureText(c).width; } catch (e) { return 0; } });
  const total = widths.reduce((s, w) => s + w, 0) + spacing * Math.max(0, chars.length - 1);
  let px = cx - total / 2;
  const prev = x.textAlign; x.textAlign = 'left';
  chars.forEach((c, i) => { x.fillText(c, px, y); px += widths[i] + spacing; });
  x.textAlign = prev;
}
/* v487: shrink a font to fit maxW, then ellipsize if still too wide. */
export function dnaFitSize(x, text, maxW, mkFont, base, min) {
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
export function dnaEllipsize(x, text, maxW) {
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

export var SERIF = "Georgia, 'Times New Roman', serif";
export var SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/* v487: ember dots for the spice level. No glow (User's critique: the italic
   title + ghost numerals are decoration enough). */
export function dnaSpiceDots(x, d, t, x0, cy) {
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
export function drawPortraitMidnight(x, W, H, d, t) {
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

  // Footer — standard branding (shared cardFooter: mark + wordmark)
  cardFooter(x, W, { y: 1865, color: t.muted });
}

/* v487: Variant A (Hearthside) — light, bookplate. Used on light themes. */
export function drawPortraitHearthside(x, W, H, d, t) {
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
  x.fillText(d.n + (d.n === 1 ? ' book' : ' books') + ' analyzed', W / 2, 290); // v536 (UX P3-14): was "1 books"

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
  cardFooter(x, W, { y: 1820, color: t.muted });
}

/* v487: theme-aware entry. Dark themes → Midnight (B); light → Hearthside (A).
   Spice section renders only when avgSpice > 0. */
export function drawDnaImage(d) {
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

export function shareDnaImage() {
  // v500: v2 share sheet is the default. The v1 card stays reachable behind
  // a flag (localStorage portraitShareV1 = '1') until v2 verifies live.
  let v1 = false;
  try { v1 = localStorage.getItem('portraitShareV1') === '1'; } catch (e) {}
  if (!v1 && typeof openPortraitShareSheet === 'function') { openPortraitShareSheet(); return; }
  const d = readingDnaData();
  if (!d) { toast('Read some books first! 📚'); return; }
  const cv = drawDnaImage(d);
  if (cv) {
    shareCanvasFile(cv, 'my-reader-portrait.png', 'My Reader Portrait');
    track('dna_shared', { books: d.n });
  }
}

/* ---- Reading DNA section in the Stats tab ---- */
export function dnaSectionHTML() {
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
    '<p class="note">' + d.n + (d.n === 1 ? ' book' : ' books') + ' · ' + d.totalPages.toLocaleString() + ' pages' + // v536 (UX P3-14): was "1 books"
    (d.topAuthor ? ' · top author: ' + esc(d.topAuthor[0]) : '') + '</p>' +
    '<button class="btn" id="dna-share-btn" style="margin-top:12px">Share my portrait ' + icon('portrait') + '</button>' +
    '</div>';
}

export function wireDnaShare() {
  const btn = document.getElementById('dna-share-btn');
  if (btn) btn.addEventListener('click', shareDnaImage);
}

/* ---- Reader Portrait hero card (v486): prominent placement at the top of
   the Details view. Wraps dnaSectionHTML(); returns '' when gated/empty. ---- */
export function dnaHeroHTML() {
  if (typeof dnaSectionHTML !== 'function') return '';
  const h = dnaSectionHTML();
  return h ? '<div class="dna-hero">' + h + '</div>' : '';
}

/* =====================================================================
   Reader Portrait v2 (v500) — the honesty layer.
   Spec: docs/reader-portrait-share-v2-spec.md. One portrait object feeds
   three canvas renderers in js/228-portrait-share.js. Copy banks below
   are the spec's, verbatim. Archetype titles are variant pools (spec
   amendment 7c5044b): selection uses the same seeded reader+month
   rotation as stickers/quotes. Dark Romance ships the full five-title
   pool; other clusters are single-entry pools for now. One flagged
   exception remains:
   - Genre-axis appetite lines exist in the bank for only four clusters;
     the remaining lines are draft extensions in the bank's voice, marked
     DRAFT-EXT, awaiting veto.
   ===================================================================== */

/* FNV-1a string hash — the deterministic per-reader seed. */
export function portraitHash(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/* mulberry32 PRNG from a numeric seed. */
export function portraitRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function portraitReaderKey() {
  try { if (typeof cloudUser !== 'undefined' && cloudUser && cloudUser.id) return 'u:' + cloudUser.id; } catch (e) {}
  try { if (typeof localUid !== 'undefined' && localUid) return 'l:' + localUid; } catch (e) {}
  return 'local-reader';
}
/* Distinct-work key: duplicate editions of the same work count once. */
export function portraitWorkKey(b) {
  try {
    if (typeof workKeysFor === 'function') {
      const k = workKeysFor(b);
      if (k) return 'w:' + k.titleNorm + '|' + k.authorNorm;
    }
  } catch (e) {}
  const t = String((b && b.title) || '').trim().toLowerCase();
  const a = ((b && b.authors) || []).join(' ').trim().toLowerCase();
  return 'w:' + t + '|' + a;
}
export function portraitFinishedAt(b) {
  if (b && b.dateFinished) { const d = new Date(b.dateFinished); if (!isNaN(d)) return d; }
  let best = null;
  ((b && b.log) || []).forEach(e => {
    if (e && e.d) { const d = new Date(e.d); if (!isNaN(d) && (!best || d > best)) best = d; }
  });
  return best;
}


/* Variant pools (spec amendment): copy with tasteful variants stays a
   pool; selection is seeded by reader id + month, matching the sticker
   rotation — stable for a reader's share, fresh across months. */
export function portraitMonthKey(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
}
export function portraitPickFromPool(pool, readerKey, salt) {
  if (!pool || !pool.length) return null;
  if (pool.length === 1) return pool[0];
  const rng = portraitRng(portraitHash(String(readerKey || '') + ':' + portraitMonthKey() + ':' + String(salt || '')));
  return pool[Math.floor(rng() * pool.length)];
}

/* Genre clusters: each book votes for the FIRST cluster it matches, so one
   book = one vote and dominance is honest. Genre tests are substring checks
   against the book's normalized genre list; dark romance also accepts the
   trope signal (it is often shelved as plain "Romance"). */
export const PORTRAIT_CLUSTERS = [
  { key: 'romantasy',   titles: ['Romantasy Royalty'],    tagline: 'here for the courts and the chaos',
    test: (g) => g('romantasy') || (g('romance') && g('fantasy')) },
  { key: 'darkromance', titles: ['Dark Romance Darling', 'Dark Romance Devotee', 'Dark Romance Romantic', 'Dark Romance Shadow Romantic', 'Dark Romance Midnight Romantic'], tagline: 'here for the darkness and the devotion', // DRAFT-EXT tagline
    test: (g, t) => g('dark romance') || (g('romance') && t('dark romance')) },
  { key: 'cozymystery', titles: ['Cozy Detective'],       tagline: 'here for the clues and the cocoa', // DRAFT-EXT
    test: (g) => g('cozy mystery') || (g('cozy') && g('mystery')) },
  { key: 'litrpg',      titles: ['Dungeon Delver'],       tagline: 'here for the grind and the loot',
    test: (g) => g('litrpg') || g('gamelit') || g('game lit') },
  { key: 'scifi',       titles: ['Star Voyager'],         tagline: 'here for the stars and the strange',
    test: (g) => g('science fiction') || g('sci-fi') || g('scifi') || g('science-fiction') },
  { key: 'horror',      titles: ['Horror Devotee'],       tagline: 'here for the chills after dark', // DRAFT-EXT
    test: (g) => g('horror') },
  { key: 'mystery',     titles: ['Plot Twist Hunter'],    tagline: 'here for the twist, every time',
    test: (g) => g('mystery') || g('thriller') || g('suspense') || g('crime') || g('detective') },
  { key: 'historical',  titles: ['Time Traveller'],       tagline: 'here for the centuries and the secrets', // DRAFT-EXT
    test: (g) => g('historical') },
  { key: 'paranormal',  titles: ['Paranormal Devotee'],   tagline: 'here for the ghosts and the glamour', // DRAFT-EXT
    test: (g) => g('paranormal') },
  { key: 'fantasy',     titles: ['Fantasy Worldwalker'],  tagline: 'here for the quests and the magic', // DRAFT-EXT
    test: (g) => g('fantasy') },
  { key: 'romance',     titles: ['Hopeless Romantic'],    tagline: 'here for the happily-ever-after', // DRAFT-EXT
    test: (g) => g('romance') },
  { key: 'literary',    titles: ['Literary Wanderer'],    tagline: 'here for the sentences that stay with you', // DRAFT-EXT
    test: (g) => g('literary fiction') || g('literature') },
  { key: 'memoir',      titles: ['Life Story Collector'], tagline: 'here for the lives behind the stories', // DRAFT-EXT
    test: (g) => g('memoir') || g('biography') || g('autobiography') },
];
export const PORTRAIT_GENRE_HOPPER = { key: 'hopper', titles: ['Genre Hopper'], tagline: null };

/* Trope praise-quotes (spec bank, verbatim). Keys are normalized trope
   names: lowercase, alphanumerics only. */
export const PORTRAIT_TROPE_QUOTES = {
  enemiestolovers: 'Devastating taste in enemies-to-lovers.',
  forcedproximity: 'One bed? Say less.',
  morallygrey: 'Here for the morally grey, every time.',
  grumpysunshine: 'Grumpy meets sunshine? Already seated.',
  foundfamily: 'Found family finds them, every time.',
  slowburn: 'Patience of a saint, payoff of a sinner.',
  fatedmates: 'Fate keeps setting them up.',
  touchheranddie: 'Protective to a fault — theirs.',
  whohurtyou: 'Who hurt you? Wrong answers only.',
  secondchance: 'Believes in the second chance.',
  friendstolovers: 'It was never just friendship.',
  forbiddenlove: 'Rules were made to be broken.',
  secretidentity: 'Loves a double life.',
  possessive: 'Mine, said the book boyfriend.',
  billionaire: 'Old money, new problems.'
};
export function portraitTropeKey(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
export function portraitTropeQuote(name) {
  const q = PORTRAIT_TROPE_QUOTES[portraitTropeKey(name)];
  if (q) return q;
  // Fallback in the bank's voice for tropes outside the bank.
  return 'Here for the ' + String(name || '').toLowerCase() + ', every time.';
}

/* Attribution patterns. "and counting" is reserved for tropes whose history
   is actively growing (rule 3); the two static forms rotate by seed+rank. */
export function portraitAttribution(n, growing, seed, rank) {
  if (growing) return '— ' + n + ' books and counting';
  const forms = ['— ' + n + " books' worth of evidence", '— ' + n + ' books deep'];
  return forms[Math.abs((seed || 0) + (rank || 0)) % forms.length];
}

/* Appetite ladder (rule 4): first axis with evidence wins; never guessed.
   Spice needs 10+ spice-rated read books. "a slow burn with teeth" fires
   ONLY when Slow Burn is itself a qualifying trope. */
export function portraitAppetite(spiceRated, avgSpice, qualifyingTropes, cluster) {
  if (spiceRated >= 10 && avgSpice > 0) {
    if (avgSpice >= 4.0) return { axis: 'spice', text: 'a dragonfire palate — no regrets' };
    if (avgSpice >= 3.0) {
      const slow = (qualifyingTropes || []).some(t => portraitTropeKey(t.name) === 'slowburn');
      return { axis: 'spice', text: slow ? 'a slow burn with teeth' : 'brings the heat, keeps the heart' };
    }
    if (avgSpice >= 2.0) return { axis: 'spice', text: 'soft spot for the sweeter side' };
    return { axis: 'spice', text: 'a sweet tooth, proudly' };
  }
  if (qualifyingTropes && qualifyingTropes.length) {
    const top = qualifyingTropes[0];
    return { axis: 'trope', text: portraitTropeQuote(top.name), trope: top.name };
  }
  if (cluster && cluster.tagline) return { axis: 'genre', text: cluster.tagline };
  return null;
}

export function buildReaderPortrait() {
  const read = library.filter(b => b.status === 'read');
  if (!read.length) return null;

  /* Distinct works (duplicate editions collapse to one). The representative
     record per work is the one with a finish date, else the first seen. */
  const workMap = new Map();
  read.forEach(b => {
    const k = portraitWorkKey(b);
    const prev = workMap.get(k);
    if (!prev || (!portraitFinishedAt(prev) && portraitFinishedAt(b))) workMap.set(k, b);
  });
  const works = [...workMap.values()];

  /* Tropes: distinct read books per trope (rule 3), v487 name dedupe,
     floor of 2, "growing" = present in a book finished within 90 days. */
  const tropeBooks = {}; // display name -> Set of work keys
  const tropeFresh = {}; // display name -> true when a containing work is recent
  const cutoff = Date.now() - 90 * 864e5;
  works.forEach(b => {
    const wk = portraitWorkKey(b);
    const fin = portraitFinishedAt(b);
    const recent = !!(fin && fin.getTime() >= cutoff);
    (b.tropes || []).forEach(t => {
      const name = String(t || '').trim();
      if (!name) return;
      (tropeBooks[name] = tropeBooks[name] || new Set()).add(wk);
      if (recent) tropeFresh[name] = true;
    });
  });
  const tropeCounts = {};
  Object.keys(tropeBooks).forEach(n => { tropeCounts[n] = tropeBooks[n].size; });
  const deduped = dedupeTropes(tropeCounts);
  const readerKey = portraitReaderKey();
  const seed = portraitHash(readerKey);
  const qualifying = Object.keys(deduped)
    .filter(n => deduped[n] >= 2)
    .sort((a, b) => (deduped[b] - deduped[a]) || (portraitHash(a) - portraitHash(b)))
    .slice(0, 4)
    .map((n, i) => ({
      name: n, count: deduped[n], growing: !!tropeFresh[n],
      quote: portraitTropeQuote(n),
      attribution: portraitAttribution(deduped[n], !!tropeFresh[n], seed, i)
    }));
  const softMode = qualifying.length < 3;
  // Non-qualifying tropes, gently presented in soft mode only.
  const gentleTropes = softMode
    ? topEntries(deduped, 3).map(([name, count]) => ({ name, count }))
    : [];

  /* Genre clusters over distinct works (one vote per work). */
  const votes = {};
  works.forEach(b => {
    const genres = (typeof bookGenres === 'function' ? bookGenres(b) : []).map(s => String(s).toLowerCase());
    const g = (sub) => genres.some(x => x.indexOf(sub) >= 0);
    const t = (sub) => (b.tropes || []).some(x => String(x).toLowerCase().indexOf(sub) >= 0);
    for (const c of PORTRAIT_CLUSTERS) { if (c.test(g, t)) { votes[c.key] = (votes[c.key] || 0) + 1; break; } }
  });
  let cluster = null, clusterVotes = 0;
  PORTRAIT_CLUSTERS.forEach(c => { if ((votes[c.key] || 0) > clusterVotes) { cluster = c; clusterVotes = votes[c.key]; } });
  if (!cluster || clusterVotes < 2) cluster = PORTRAIT_GENRE_HOPPER;
  const clusterTitle = portraitPickFromPool(cluster.titles, readerKey, 'archetype:' + cluster.key);

  /* Display genres: primary genre per book (same basis as the v1 card). */
  const genreCount = {};
  read.forEach(b => { const g = (typeof bookGenres === 'function' ? bookGenres(b) : [])[0]; if (g) genreCount[g] = (genreCount[g] || 0) + 1; });
  const topGenres = topEntries(genreCount, 3).map(([name, count]) => ({ name, count }));

  /* Spice: read-list basis (matches the v1 card and the in-app preview). */
  const sVals = spiceVals(read);
  const avgSpice = sVals.length ? sVals.reduce((s, v) => s + v, 0) / sVals.length : 0;

  const appetite = portraitAppetite(sVals.length, avgSpice, qualifying, cluster);

  /* Celebration stats (rule 6). */
  const totalPages = read.reduce((s, b) => s + (b.pageCount || 0), 0);
  const streak = typeof longestStreak === 'function' ? longestStreak() : 0;
  const authorCount = {};
  read.forEach(b => (b.authors || []).forEach(a => { authorCount[a] = (authorCount[a] || 0) + 1; }));
  const ta = Object.entries(authorCount).sort((a, b) => b[1] - a[1])[0];
  const topAuthor = ta ? { name: ta[0], count: ta[1] } : null;

  /* Covers (rule 7): most recently finished first; favourites fill the rest. */
  const withCover = works.filter(b => b.cover);
  const recent = withCover.slice().sort((a, b) => {
    const da = portraitFinishedAt(a), db = portraitFinishedAt(b);
    if (da && db) return db - da;
    if (db) return 1;
    if (da) return -1;
    return 0;
  });
  const isFav = (b) => !!b.favorite || (b.myRating || 0) >= 4.5;
  const favs = withCover.filter(isFav).sort((a, b) =>
    ((b.myRating || 0) - (a.myRating || 0)) || String(a.title || '').localeCompare(String(b.title || '')));
  const ref = (b) => ({ cover: b.cover, title: b.title || '', author: (b.authors || [])[0] || '' });
  const strip = [];
  const inStrip = new Set();
  recent.concat(favs).forEach(b => {
    const k = portraitWorkKey(b);
    if (strip.length < 4 && !inStrip.has(k)) { inStrip.add(k); strip.push(ref(b)); }
  });
  const polaroidRef = recent.length ? ref(recent[0]) : (favs.length ? ref(favs[0]) : null);

  return {
    v: 2,
    n: read.length,
    headline: softMode ? 'A story still being written' : clusterTitle,
    archetype: softMode ? null : clusterTitle,
    clusterKey: cluster.key,
    softMode: softMode,
    genres: topGenres,
    dominantGenre: topGenres.length ? topGenres[0].name : null,
    tropes: qualifying,
    gentleTropes: gentleTropes,
    appetite: appetite,
    spice: { avg: avgSpice, rated: sVals.length },
    pages: totalPages,
    streak: streak,
    topAuthor: topAuthor,
    coverStrip: strip,
    polaroid: polaroidRef,
    seed: seed,
    readerKey: readerKey
  };
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The classic consumers, js/170-stats.js and js/228-portrait-share.js, call these functions at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.readingDnaData = readingDnaData;
window.dedupeTropes = dedupeTropes;
window.portraitTheme = portraitTheme;
window.dnaLum = dnaLum;
window.dnaMix = dnaMix;
window.dnaAlpha = dnaAlpha;
window.dnaSpaced = dnaSpaced;
window.dnaFitSize = dnaFitSize;
window.dnaEllipsize = dnaEllipsize;
window.SERIF = SERIF;
window.SANS = SANS;
window.dnaSpiceDots = dnaSpiceDots;
window.drawPortraitMidnight = drawPortraitMidnight;
window.drawPortraitHearthside = drawPortraitHearthside;
window.drawDnaImage = drawDnaImage;
window.shareDnaImage = shareDnaImage;
window.dnaSectionHTML = dnaSectionHTML;
window.wireDnaShare = wireDnaShare;
window.dnaHeroHTML = dnaHeroHTML;
window.portraitHash = portraitHash;
window.portraitRng = portraitRng;
window.portraitReaderKey = portraitReaderKey;
window.portraitWorkKey = portraitWorkKey;
window.portraitFinishedAt = portraitFinishedAt;
window.portraitMonthKey = portraitMonthKey;
window.portraitPickFromPool = portraitPickFromPool;
window.PORTRAIT_CLUSTERS = PORTRAIT_CLUSTERS;
window.PORTRAIT_GENRE_HOPPER = PORTRAIT_GENRE_HOPPER;
window.PORTRAIT_TROPE_QUOTES = PORTRAIT_TROPE_QUOTES;
window.portraitTropeKey = portraitTropeKey;
window.portraitTropeQuote = portraitTropeQuote;
window.portraitAttribution = portraitAttribution;
window.portraitAppetite = portraitAppetite;
window.buildReaderPortrait = buildReaderPortrait;
