/* ---- Reader Portrait share v2 (v500): three share-card styles from one
   portrait object (buildReaderPortrait, js/212-dna.js), presented in a
   swipeable share sheet. Spec: docs/reader-portrait-share-v2-spec.md.
   A Editorial · B Cover Story · C Sticker Pack. All cards 1080x1920 via
   the v399 cardCanvas() helper, palette from the active theme's tokens.
   Branding: app icon + wordmark only. No emoji taglines, no URL/QR. ---- */

var PS_SERIF = "Georgia, 'Times New Roman', serif";
var PS_SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

const PS_STYLES = [
  { key: 'editorial', name: 'Editorial' },
  { key: 'cover', name: 'Cover Story' },
  { key: 'stickers', name: 'Sticker Pack' }
];

/* ---- Sticker artwork (C): the illustrated library in
   assets/stickers/cut-webp/<theme>/<theme>-<sheet>-<NN>.webp.
   Availability per MANIFEST.md (fused pairs and two-island splits make a
   few sheets 10-13 instead of 12; twilight's B sheet was excluded at
   cutting by design). Stickers are runtime-cached by the service worker,
   never precached — 13.1 MB must not block app install. ---- */
const PS_STICKER_DIR = { 'wisp-night': 'wispnight' };
const PS_STICKER_SETS = {
  abyss: [12, 12], amour: [12, 0], briarthrone: [12, 13], candlelight: [12, 12],
  dark: [11, 12], fete: [12, 0], frost: [12, 12], harvest: [12, 0],
  haunt: [12, 0], hearthside: [12, 10], light: [13, 12], midnight: [12, 12],
  pastel: [12, 0], shamrock: [12, 0], solstice: [12, 0], stormrider: [12, 12],
  twilight: [12, 0], velvet: [12, 12], verdant: [12, 12], voidsignal: [13, 12],
  wisp: [13, 12], wispnight: [12, 13], yuletide: [12, 0]
};
/* Seeded rotation (spec/MANIFEST freshness rule): the theme's full set,
   shuffled by a hash of reader id + month, so repeat shares rotate art
   and a reader's picks are stable within a month. Pure — unit tested. */
function psStickerPaths(themeKey, readerKey, monthKey) {
  const dir = PS_STICKER_DIR[themeKey] || themeKey;
  const counts = PS_STICKER_SETS[dir];
  if (!counts) return [];
  const all = [];
  ['a', 'b'].forEach((sheet, si) => {
    for (let i = 1; i <= counts[si]; i++) {
      all.push('assets/stickers/cut-webp/' + dir + '/' + dir + '-' + sheet + '-' +
        String(i).padStart(2, '0') + '.webp');
    }
  });
  const rng = portraitRng(portraitHash(String(readerKey || '') + ':' + String(monthKey || '')));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = all[i]; all[i] = all[j]; all[j] = tmp;
  }
  return all;
}
function psMonthKey(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
}

/* Sticker phrase bank (spec, verbatim). Identity phrases, never data
   claims. BOOKS > PEOPLE is an optional-tier filler — not a default. */
const PS_PHRASES = [
  'BOOKTOK MADE ME DO IT', 'JUST ONE MORE CHAPTER', 'PLOT TWIST MENACE',
  'EMOTIONAL SUPPORT BOOK', 'PROFESSIONAL TBR BUILDER', 'IN MY READING ERA',
  'WARNING: EASILY DISTRACTED BY BOOKS', 'HEAD LIBRARIAN',
  'DO NOT DISTURB: AT THE CLIMAX'
];
const PS_PHRASE_DRAGON = 'MY OTHER RIDE IS A DRAGON'; // fantasy clusters only
const PS_DRAGON_CLUSTERS = ['fantasy', 'romantasy', 'litrpg', 'paranormal'];
function psPickPhrases(p, count) {
  const pool = PS_PHRASES.slice();
  if (PS_DRAGON_CLUSTERS.indexOf(p.clusterKey) >= 0) pool.push(PS_PHRASE_DRAGON);
  const rng = portraitRng((p.seed ^ 0x9e3779b9) >>> 0);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, count);
}

/* ---- image loading (every failure resolves null; cards degrade) ---- */
function psLoadImage(src, timeoutMs) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const img = new Image();
      img.onload = () => fin(img);
      img.onerror = () => fin(null);
      img.src = src;
      setTimeout(() => fin(null), timeoutMs || 6000);
    } catch (e) { fin(null); }
  });
}
function psLoadCover(url) {
  if (typeof loadCoverImage === 'function') return loadCoverImage(url);
  return psLoadImage(url, 8000);
}
async function psLoadAssets(p, style) {
  const A = { covers: [], polaroid: null, stickers: [], icon: null };
  try {
    const jobs = [psLoadImage('icon.svg').then(img => { A.icon = img; })];
    if (style === 'cover') {
      jobs.push(Promise.all(p.coverStrip.map(b => psLoadCover(b.cover))).then(imgs => { A.covers = imgs; }));
    }
    if (style === 'stickers') {
      if (p.polaroid) jobs.push(psLoadCover(p.polaroid.cover).then(img => { A.polaroid = img; }));
      let themeKey = 'dark';
      try { themeKey = (typeof getTheme === 'function') ? getTheme() : (document.documentElement.dataset.theme || 'dark'); } catch (e) {}
      const paths = psStickerPaths(themeKey, p.readerKey, psMonthKey()).slice(0, 8);
      jobs.push(Promise.all(paths.map(s => psLoadImage(s))).then(imgs => {
        A.stickers = imgs.filter(Boolean).slice(0, 4);
      }));
    }
    await Promise.all(jobs);
  } catch (e) {}
  return A;
}

/* ---- shared drawing helpers ---- */
function psWrap(x, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  words.forEach(w => {
    const trial = cur ? cur + ' ' + w : w;
    let tw = 0;
    try { tw = x.measureText(trial).width; } catch (e) {}
    if (cur && tw > maxW) { lines.push(cur); cur = w; } else cur = trial;
  });
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
function psStars(x, cx, y, size, color) {
  x.save();
  x.fillStyle = color; x.font = size + 'px ' + PS_SANS; x.textAlign = 'center';
  try { dnaSpaced(x, '★★★★★', cx, y, Math.round(size * 0.35)); } catch (e) { x.fillText('★★★★★', cx, y); }
  x.restore();
}
/* Footer branding: icon + wordmark, sized so a link element can join the
   slot later. No emoji, no URL (spec branding rules). */
function psFooter(x, W, y, t, icon) {
  const word = 'Cozy Libram';
  x.save();
  x.font = '600 34px ' + PS_SERIF;
  let tw = 0;
  try { tw = x.measureText(word).width; } catch (e) {}
  const iw = icon ? 46 : 0, gap = icon ? 16 : 0;
  let sx = W / 2 - (iw + gap + tw) / 2;
  if (icon) {
    try { x.drawImage(icon, sx, y - 38, 46, 46); } catch (e) {}
    sx += iw + gap;
  }
  x.fillStyle = t.muted; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
  x.fillText(word, sx, y);
  x.restore();
}
function psDrawCoverFit(x, img, cx, cy, w, h, r) {
  x.save();
  try {
    cvRoundRect(x, cx - w / 2, cy - h / 2, w, h, r || 8); x.clip();
    const s = Math.max(w / (img.width || w), h / (img.height || h));
    const dw = (img.width || w) * s, dh = (img.height || h) * s;
    x.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  } catch (e) {}
  x.restore();
}
function psCoverPlaceholder(x, book, cx, cy, w, h, t) {
  x.save();
  cvRoundRect(x, cx - w / 2, cy - h / 2, w, h, 8);
  x.fillStyle = dnaMix(t.bg2, t.accent, 0.25); x.fill();
  x.strokeStyle = dnaAlpha(t.ink, 0.25); x.lineWidth = 2; x.stroke();
  x.fillStyle = t.ink; x.textAlign = 'center';
  x.font = '600 25px ' + PS_SERIF;
  const lines = psWrap(x, book.title || 'Untitled', w - 28).slice(0, 5);
  lines.forEach((ln, i) => x.fillText(ln, cx, cy - h / 4 + i * 32));
  if (book.author) {
    x.font = '21px ' + PS_SANS; x.fillStyle = t.muted;
    x.fillText(dnaEllipsize(x, book.author, w - 28), cx, cy + h / 2 - 26);
  }
  x.restore();
}
/* Celebration line parts (rule 6): finishing celebrated, longest streak
   only as a memory, top author as a personal fact. No score framing. */
function psCelebration(p) {
  const parts = [p.n + (p.n === 1 ? ' story' : ' stories') + ' seen through to their ending'];
  if (p.streak >= 2) parts.push('that one ' + p.streak + '-day reading cocoon');
  if (p.topAuthor) parts.push('most-read: ' + p.topAuthor.name);
  return parts.join(' · ');
}
/* Spice appetite as a blurb sentence for B: "a dragonfire palate — no
   regrets" -> "A dragonfire palate. No regrets." */
function psBlurbSentence(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  s = s.replace(/\s—\s/g, '. ');
  s = s.replace(/\. ([a-z])/g, (m, c) => '. ' + c.toUpperCase());
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

/* ================= A — Editorial ================= */
function drawPortraitEditorial(x, W, H, p, t, A) {
  x.textAlign = 'center'; x.textBaseline = 'alphabetic';

  x.fillStyle = t.muted; x.font = '30px ' + PS_SANS;
  dnaSpaced(x, 'COZY LIBRAM · READER PORTRAIT', W / 2, 148, 10);

  // Headline (archetype, or the soft-mode line)
  const mkH = (s) => 'italic 700 ' + s + 'px ' + PS_SERIF;
  let hs = dnaFitSize(x, p.headline, 900, mkH, 104, 50);
  x.font = mkH(hs); x.fillStyle = t.gold;
  if (hs <= 50 && x.measureText(p.headline).width > 900) {
    const words = p.headline.split(' ');
    const mid = Math.ceil(words.length / 2);
    x.fillText(words.slice(0, mid).join(' '), W / 2, 292);
    x.fillText(words.slice(mid).join(' '), W / 2, 292 + hs * 1.12);
    var headBottom = 292 + hs * 1.12;
  } else {
    x.fillText(p.headline, W / 2, 300);
    var headBottom = 300;
  }
  let y = headBottom + 26;

  // Appetite line (ladder result; absent when no axis has evidence)
  if (p.appetite) {
    y += 52;
    x.font = 'italic 41px ' + PS_SERIF; x.fillStyle = t.ink;
    x.fillText(dnaEllipsize(x, p.appetite.text, 920), W / 2, y);
  }

  // Gold rule
  y += 56;
  x.strokeStyle = t.gold; x.lineWidth = 2;
  x.beginPath(); x.moveTo(W / 2 - 200, y); x.lineTo(W / 2 + 200, y); x.stroke();
  y += 84;

  if (!p.softMode) {
    // Trope praise-quotes. The appetite trope (trope-axis ladder) is the
    // line above, so it is not repeated here.
    const quotes = p.tropes.filter(tr => !(p.appetite && p.appetite.axis === 'trope' && p.appetite.trope === tr.name)).slice(0, 3);
    quotes.forEach(tr => {
      psStars(x, W / 2, y, 27, t.gold); y += 22;
      x.font = 'italic 46px ' + PS_SERIF; x.fillStyle = t.ink;
      psWrap(x, '“' + tr.quote + '”', 830).forEach(ln => { y += 60; x.fillText(ln, W / 2, y); });
      y += 46;
      x.font = '28px ' + PS_SANS; x.fillStyle = t.muted;
      x.fillText(tr.attribution, W / 2, y);
      y += 74;
    });
    if (!quotes.length) y += 30;
  } else {
    // Soft mode: whatever exists, gently presented. No claims, no counts
    // dressed as evidence.
    x.fillStyle = t.muted; x.font = '29px ' + PS_SANS;
    dnaSpaced(x, 'ON THE SHELVES SO FAR', W / 2, y, 8); y += 26;
    p.genres.forEach(g => {
      y += 58;
      x.font = 'italic 43px ' + PS_SERIF; x.fillStyle = t.ink;
      x.fillText(g.name + ' · ' + g.count + (g.count === 1 ? ' book' : ' books'), W / 2, y);
    });
    if (p.gentleTropes.length) {
      y += 84;
      x.fillStyle = t.muted; x.font = '29px ' + PS_SANS;
      dnaSpaced(x, 'TROPES ON THE HORIZON', W / 2, y, 8); y += 54;
      x.font = 'italic 38px ' + PS_SERIF; x.fillStyle = t.ink;
      psWrap(x, p.gentleTropes.map(tr => tr.name).join(' · '), 830)
        .forEach(ln => { x.fillText(ln, W / 2, y); y += 50; });
    }
    y += 30;
  }

  // Pages: the hero number.
  y = Math.max(y + 96, 1252);
  const mkP = (s) => '700 ' + s + 'px ' + PS_SERIF;
  const ps = dnaFitSize(x, p.pages.toLocaleString(), 860, mkP, 148, 60);
  x.font = mkP(ps); x.fillStyle = t.ink;
  x.fillText(p.pages.toLocaleString(), W / 2, y);
  y += 58;
  x.font = 'italic 36px ' + PS_SERIF; x.fillStyle = t.muted;
  x.fillText('pages wandered, every one worth it', W / 2, y);

  // Celebration line
  y += 104;
  x.font = '33px ' + PS_SANS; x.fillStyle = t.muted;
  psWrap(x, psCelebration(p), 860).slice(0, 2).forEach(ln => { x.fillText(ln, W / 2, y); y += 46; });

  psFooter(x, W, 1852, t, A.icon);
}

/* ================= B — Cover Story ================= */
function drawPortraitCoverStory(x, W, H, p, t, A) {
  x.textAlign = 'center'; x.textBaseline = 'alphabetic';

  // Cover frame: double rule.
  x.strokeStyle = t.gold; x.lineWidth = 3; x.strokeRect(48, 48, W - 96, H - 96);
  x.lineWidth = 1; x.strokeRect(66, 66, W - 132, H - 132);

  x.fillStyle = t.muted; x.font = '33px ' + PS_SANS;
  dnaSpaced(x, 'COZY LIBRAM PRESS', W / 2, 172, 12);
  x.strokeStyle = dnaAlpha(t.gold, 0.6); x.lineWidth = 2;
  x.beginPath(); x.moveTo(250, 208); x.lineTo(W - 250, 208); x.stroke();

  x.fillStyle = t.muted; x.font = 'italic 44px ' + PS_SERIF;
  x.fillText('The', W / 2, 302);

  // Title: archetype split across two lines (soft mode: the soft line).
  const titleText = p.headline;
  const words = titleText.split(' ');
  const line1 = p.softMode ? titleText : words[0];
  const line2 = p.softMode ? '' : words.slice(1).join(' ');
  const mkT = (s) => '700 ' + s + 'px ' + PS_SERIF;
  const probe = line2 && line2.length > line1.length ? line2 : line1;
  const ts = dnaFitSize(x, probe, 850, mkT, 118, 56);
  x.font = mkT(ts); x.fillStyle = t.gold;
  if (p.softMode) {
    const wrapped = psWrap(x, titleText, 850);
    wrapped.forEach((ln, i) => x.fillText(ln, W / 2, 428 + i * (ts * 1.05)));
    var titleBottom = 428 + (wrapped.length - 1) * (ts * 1.05);
  } else {
    x.fillText(line1, W / 2, 428);
    if (line2) x.fillText(line2, W / 2, 428 + ts * 1.05);
    var titleBottom = 428 + (line2 ? ts * 1.05 : 0);
  }
  let y = titleBottom + 78;
  x.font = 'italic 36px ' + PS_SERIF; x.fillStyle = t.muted;
  x.fillText('a reader portrait, in their own genre', W / 2, y);
  if (p.appetite && p.appetite.axis === 'genre') {
    y += 52;
    x.font = 'italic 36px ' + PS_SERIF; x.fillStyle = t.gold;
    x.fillText(p.appetite.text, W / 2, y);
  }

  // Praise blurbs: spice appetite (as a blurb "from the spice shelf"),
  // then trope quotes. Counts live only inside attributions.
  const blurbs = [];
  if (p.appetite && p.appetite.axis === 'spice') {
    blurbs.push({ quote: psBlurbSentence(p.appetite.text), attribution: '— the spice shelf' });
  }
  p.tropes
    .filter(tr => !(p.appetite && p.appetite.axis === 'trope' && p.appetite.trope === tr.name))
    .slice(0, blurbs.length ? 2 : 3)
    .forEach(tr => blurbs.push(tr));
  y += 92;
  blurbs.forEach(b => {
    psStars(x, W / 2, y, 26, t.gold); y += 20;
    x.font = 'italic 44px ' + PS_SERIF; x.fillStyle = t.ink;
    psWrap(x, '“' + b.quote + '”', 800).forEach(ln => { y += 58; x.fillText(ln, W / 2, y); });
    y += 42;
    x.font = '27px ' + PS_SANS; x.fillStyle = t.muted;
    x.fillText(b.attribution, W / 2, y);
    y += 66;
  });

  // Also on these shelves: recent-read covers, favourites filling in.
  if (p.coverStrip.length) {
    y = Math.max(y + 36, 1210);
    x.fillStyle = t.muted; x.font = '29px ' + PS_SANS;
    dnaSpaced(x, 'ALSO ON THESE SHELVES', W / 2, y, 9);
    y += 42;
    const cw = 196, ch = 294, gap = 22;
    const totalW = p.coverStrip.length * cw + (p.coverStrip.length - 1) * gap;
    let cx = W / 2 - totalW / 2 + cw / 2;
    p.coverStrip.forEach((b, i) => {
      const img = A.covers[i];
      if (img) psDrawCoverFit(x, img, cx, y + ch / 2, cw, ch, 8);
      else psCoverPlaceholder(x, b, cx, y + ch / 2, cw, ch, t);
      cx += cw + gap;
    });
    y += ch + 76;
  } else {
    y += 60;
  }

  // Stats as a colophon line, not a scoreboard.
  x.font = '40px ' + PS_SERIF; x.fillStyle = t.ink;
  x.fillText(p.pages.toLocaleString() + ' pages · ' + psCelebration(p).split(' · ')[0], W / 2, y);
  const rest = psCelebration(p).split(' · ').slice(1).join(' · ');
  if (rest) {
    y += 48;
    x.font = '31px ' + PS_SANS; x.fillStyle = t.muted;
    x.fillText('featuring ' + rest, W / 2, y);
  }

  psFooter(x, W, 1822, t, A.icon);
}

/* ================= C — Sticker Pack ================= */
function psPill(x, cx, cy, o) {
  x.save();
  x.translate(cx, cy);
  x.rotate((o.rot || 0) * Math.PI / 180);
  const lines = o.lines || [];
  let w = 0;
  lines.forEach(L => { x.font = L.font; try { w = Math.max(w, x.measureText(L.text).width); } catch (e) {} });
  const gap = o.lineGap != null ? o.lineGap : 8;
  const totalH = lines.reduce((s, L) => s + L.size, 0) + gap * Math.max(0, lines.length - 1);
  const bw = w + (o.padX || 34) * 2, bh = totalH + (o.padY || 20) * 2;
  const r = o.radius != null ? o.radius : bh / 2;
  x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = 16; x.shadowOffsetY = 7;
  cvRoundRect(x, -bw / 2, -bh / 2, bw, bh, r);
  x.fillStyle = o.bg; x.fill();
  x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetY = 0;
  if (o.border !== false) { x.strokeStyle = '#ffffff'; x.lineWidth = 10; x.stroke(); }
  if (o.ring) {
    cvRoundRect(x, -bw / 2 + 10, -bh / 2 + 10, bw - 20, bh - 20, Math.max(6, r - 10));
    x.strokeStyle = o.ring; x.lineWidth = 2.5; x.stroke();
  }
  let ly = -totalH / 2;
  x.textAlign = 'center';
  lines.forEach(L => {
    x.font = L.font; x.fillStyle = L.fg;
    ly += L.size;
    x.fillText(L.text, 0, ly - L.size * 0.22);
    ly += gap;
  });
  x.restore();
  return { w: bw, h: bh };
}
function psStarburst(x, cx, cy, r, fill) {
  x.save();
  x.beginPath();
  const points = 16;
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 ? r * 0.8 : r;
    const a = (Math.PI * i) / points - Math.PI / 2;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
  }
  x.closePath();
  x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = 16; x.shadowOffsetY = 7;
  x.fillStyle = fill; x.fill();
  x.restore();
}
function psIllustrated(x, img, cx, cy, size, rot) {
  if (!img) return;
  x.save();
  x.translate(cx, cy);
  x.rotate((rot || 0) * Math.PI / 180);
  const s = size / Math.max(img.width || size, img.height || size);
  const dw = (img.width || size) * s, dh = (img.height || size) * s;
  try { x.drawImage(img, -dw / 2, -dh / 2, dw, dh); } catch (e) {}
  x.restore();
}

function drawPortraitStickerPack(x, W, H, p, t, A) {
  x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  const darkInk = '#241a2e';

  // The device: back of a sticker-bombed e-reader, flat-lay.
  let dev = null;
  try {
    dev = x.createLinearGradient(0, 110, 0, 1810);
    dev.addColorStop(0, t.bg2); dev.addColorStop(1, t.card2);
  } catch (e) {}
  x.save();
  x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = 40; x.shadowOffsetY = 18;
  cvRoundRect(x, 64, 110, W - 128, 1700, 64);
  x.fillStyle = dev || t.bg2; x.fill();
  x.restore();
  cvRoundRect(x, 64, 110, W - 128, 1700, 64);
  x.strokeStyle = dnaAlpha(t.ink, 0.22); x.lineWidth = 3; x.stroke();
  x.beginPath();
  try { x.arc(W / 2, 152, 9, 0, Math.PI * 2); } catch (e) {}
  x.fillStyle = dnaAlpha(t.ink, 0.3); x.fill();

  const rng = portraitRng((p.seed ^ 0x51ab) >>> 0);
  const jit = (n) => (rng() - 0.5) * 2 * n;

  /* Focal point: the archetype sticker — largest element on the device. */
  x.font = '700 66px ' + PS_SERIF;
  const focalText = dnaEllipsize(x, p.headline, 780);
  psPill(x, W / 2, 330, {
    rot: -2, bg: t.card2, ring: dnaAlpha(t.gold, 0.7), padX: 52, padY: 30,
    lines: [
      { text: '★ READER PORTRAIT ★', font: '600 27px ' + PS_SANS, fg: t.muted, size: 27 },
      { text: focalText, font: '700 66px ' + PS_SERIF, fg: t.gold, size: 66 }
    ],
    lineGap: 14
  });

  /* Genre sticker (top-left of the device). */
  if (p.dominantGenre) {
    psPill(x, 262 + jit(8), 196 + jit(6), {
      rot: -8, bg: t.gold, padX: 26, padY: 13,
      lines: [{ text: p.dominantGenre.toUpperCase(), font: '700 29px ' + PS_SANS, fg: darkInk, size: 29 }]
    });
  }

  /* Appetite pill (any ladder axis; falls back to a phrase sticker).
     Spice stickers appear only when the spice axis actually fired —
     fillers never contradict the data. */
  if (p.appetite) {
    x.font = 'italic 39px ' + PS_SERIF;
    const appetiteText = dnaEllipsize(x, p.appetite.text, 790);
    psPill(x, W / 2, 512, {
      rot: 1.5, bg: t.bg, ring: dnaAlpha(t.accent, 0.8), padX: 38, padY: 18,
      lines: [{ text: appetiteText, font: 'italic 39px ' + PS_SERIF, fg: t.ink, size: 39 }]
    });
  }

  /* Top-trope quote bubble (protected zone: left-center, near-level). */
  const topTrope = p.tropes.length ? p.tropes[0] : null;
  if (topTrope) {
    psPill(x, 382, 712, {
      rot: -1, bg: dnaMix(t.card2, t.ink, 0.07), padX: 34, padY: 24, radius: 34,
      lines: [
        { text: '★★★★★', font: '24px ' + PS_SANS, fg: t.gold, size: 24 },
        { text: '“' + topTrope.quote + '”', font: 'italic 37px ' + PS_SERIF, fg: t.ink, size: 37 },
        { text: topTrope.attribution, font: '25px ' + PS_SANS, fg: t.muted, size: 25 }
      ],
      lineGap: 10
    });
  }

  /* One polaroid: the most recent read (else the top favourite). */
  if (p.polaroid) {
    x.save();
    x.translate(838, 716); x.rotate(4 * Math.PI / 180);
    x.shadowColor = 'rgba(0,0,0,0.4)'; x.shadowBlur = 20; x.shadowOffsetY = 9;
    x.fillStyle = '#fdfbf7'; x.fillRect(-152, -206, 304, 412);
    x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetY = 0;
    if (A.polaroid) psDrawCoverFit(x, A.polaroid, 0, -46, 268, 300, 2);
    else {
      x.fillStyle = '#e8e2d4'; x.fillRect(-134, -196, 268, 300);
      x.fillStyle = '#5a4a3a'; x.font = 'italic 24px ' + PS_SERIF; x.textAlign = 'center';
      psWrap(x, p.polaroid.title || '', 230).slice(0, 3).forEach((ln, i) => x.fillText(ln, 0, -110 + i * 32));
    }
    x.fillStyle = '#4a3b2c'; x.font = 'italic 25px ' + PS_SERIF; x.textAlign = 'center';
    x.fillText(dnaEllipsize(x, p.polaroid.title || '', 250), 0, 168);
    x.restore();
  }

  /* Pages starburst. */
  psStarburst(x, 228, 1012, 148, t.gold);
  x.save();
  x.translate(228, 1012); x.rotate(-10 * Math.PI / 180);
  x.fillStyle = darkInk; x.textAlign = 'center';
  const mkB = (s) => '700 ' + s + 'px ' + PS_SERIF;
  const bs = dnaFitSize(x, p.pages.toLocaleString(), 215, mkB, 56, 30);
  x.font = mkB(bs);
  x.fillText(p.pages.toLocaleString(), 0, 6);
  x.font = '700 29px ' + PS_SANS;
  x.fillText('PAGES!', 0, 48);
  x.restore();

  /* Top-author fan club sticker. */
  if (p.topAuthor) {
    x.font = '700 37px ' + PS_SANS;
    const fanText = dnaEllipsize(x, p.topAuthor.name.toUpperCase() + ' FAN CLUB', 800);
    psPill(x, W / 2, 1258, {
      rot: -1.5, bg: t.accentDeep, padX: 40, padY: 20,
      lines: [
        { text: fanText, font: '700 37px ' + PS_SANS, fg: '#ffffff', size: 37 },
        { text: 'president, obviously', font: 'italic 27px ' + PS_SERIF, fg: 'rgba(255,255,255,0.85)', size: 27 }
      ],
      lineGap: 9
    });
  }

  /* Finished strip. */
  psPill(x, W / 2, 1448, {
    rot: 0.8, bg: t.card2, ring: dnaAlpha(t.ink, 0.35), padX: 44, padY: 20,
    lines: [{ text: '★ ' + p.n + (p.n === 1 ? ' STORY' : ' STORIES') + ' FINISHED ★', font: '700 39px ' + PS_SANS, fg: t.ink, size: 39 }]
  });

  /* Milestone sticker: the streak, remembered — only when it is a real
     cocoon (7+ days). */
  const cocoon = p.streak >= 7;
  if (cocoon) {
    psPill(x, W / 2, 1588, {
      rot: -1, bg: t.bg, padX: 32, padY: 14,
      lines: [{ text: 'THAT ONE ' + p.streak + '-DAY READING COCOON', font: '600 27px ' + PS_SANS, fg: t.gold, size: 27 }]
    });
  }

  /* Phrase fillers + illustrated stickers fill the remaining space —
     visual balance, not a fixed count. Zones avoid the data slots. */
  const phrases = psPickPhrases(p, cocoon ? 1 : 2);
  if (phrases[0]) {
    psPill(x, 268 + jit(10), 1606 + jit(8), {
      rot: -6, bg: dnaMix(t.bg2, t.accent, 0.3), padX: 24, padY: 12,
      lines: [{ text: phrases[0], font: '700 26px ' + PS_SANS, fg: t.ink, size: 26 }]
    });
  }
  if (phrases[1]) {
    psPill(x, 806 + jit(10), 1612 + jit(8), {
      rot: 5, bg: dnaMix(t.bg2, t.gold, 0.3), padX: 24, padY: 12,
      lines: [{ text: phrases[1], font: '700 26px ' + PS_SANS, fg: t.ink, size: 26 }]
    });
  }
  psIllustrated(x, A.stickers[0], 884 + jit(10), 222 + jit(8), 178, 6 + jit(4));
  psIllustrated(x, A.stickers[1], 592 + jit(10), 1032 + jit(8), 172, -5 + jit(4));
  psIllustrated(x, A.stickers[2], 884 + jit(10), 1212 + jit(8), 158, 8 + jit(4));
  if (!cocoon && A.stickers[3]) {
    // extra art low-center when no cocoon sticker claims the slot
    psIllustrated(x, A.stickers[3], W / 2, 1596, 120, jit(5));
  }

  psFooter(x, W, 1762, t, A.icon);
}

/* ---- render entry: one portrait, three renderers ---- */
async function renderPortraitCanvas(style) {
  const p = buildReaderPortrait();
  if (!p) return null;
  const t = portraitTheme();
  const A = await psLoadAssets(p, style);
  const made = (typeof cardCanvas === 'function')
    ? cardCanvas([[0, t.bg], [0.55, t.bg2], [1, t.bg]])
    : null;
  if (!made) return null;
  if (style === 'cover') drawPortraitCoverStory(made.x, made.W, made.H, p, t, A);
  else if (style === 'stickers') drawPortraitStickerPack(made.x, made.W, made.H, p, t, A);
  else drawPortraitEditorial(made.x, made.W, made.H, p, t, A);
  return made.cv;
}

/* ---- share sheet: swipeable carousel of the three styles ---- */
function openPortraitShareSheet() {
  const p = buildReaderPortrait();
  if (!p) { toast('Read some books first! 📚'); return; }
  if (document.querySelector('.pshare-sheet')) return;

  let active = 0;
  try {
    const last = localStorage.getItem('pshareStyle');
    const i = PS_STYLES.findIndex(s => s.key === last);
    if (i >= 0) active = i;
  } catch (e) {}

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML =
    '<div class="sheet pshare-sheet">' +
      '<div class="sheet-grabber" aria-hidden="true"></div>' +
      '<p class="pshare-title">Share your portrait</p>' +
      '<div class="pshare-track">' +
        PS_STYLES.map(s =>
          '<div class="pshare-slide"><div class="pshare-card" data-style="' + s.key + '">' +
          '<div class="pshare-loading">Painting your portrait…</div></div></div>').join('') +
      '</div>' +
      '<div class="pshare-dots">' +
        PS_STYLES.map((s, i) => '<span class="pshare-dot' + (i === active ? ' on' : '') + '"></span>').join('') +
      '</div>' +
      '<p class="pshare-name">' + PS_STYLES[active].name + '</p>' +
      '<button class="btn pshare-go" style="width:100%">Share this portrait</button>' +
      '<button class="btn btn-ghost pshare-close" style="width:100%;margin-top:8px">Not now</button>' +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const close = () => {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
    if (typeof overlayClosed === 'function') overlayClosed(token);
  };
  const token = (typeof overlayOpened === 'function') ? overlayOpened('portrait-share', close) : null;

  const trackEl = overlay.querySelector('.pshare-track');
  const dots = overlay.querySelectorAll('.pshare-dot');
  const nameEl = overlay.querySelector('.pshare-name');
  const canvases = {};

  PS_STYLES.forEach(async (s) => {
    const cv = await renderPortraitCanvas(s.key);
    const mount = overlay.querySelector('.pshare-card[data-style="' + s.key + '"]');
    if (!mount || !overlay.isConnected) return;
    if (cv) { mount.innerHTML = ''; mount.appendChild(cv); canvases[s.key] = cv; }
    else mount.innerHTML = '<div class="pshare-loading">Could not paint this style</div>';
  });

  requestAnimationFrame(() => {
    if (active > 0) trackEl.scrollLeft = active * (trackEl.clientWidth || 0);
  });

  let scrollTimer = null;
  trackEl.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const w = trackEl.clientWidth || 1;
      const i = Math.max(0, Math.min(PS_STYLES.length - 1, Math.round(trackEl.scrollLeft / w)));
      if (i !== active) {
        active = i;
        dots.forEach((d, j) => d.classList.toggle('on', j === active));
        nameEl.textContent = PS_STYLES[active].name;
        try { localStorage.setItem('pshareStyle', PS_STYLES[active].key); } catch (e) {}
      }
    }, 60);
  });

  overlay.querySelector('.pshare-go').addEventListener('click', async () => {
    const key = PS_STYLES[active].key;
    const cv = canvases[key] || await renderPortraitCanvas(key);
    if (cv) {
      shareCanvasFile(cv, 'my-reader-portrait.png', 'My Reader Portrait');
      track('dna_shared', { books: p.n, style: key });
      close();
    }
  });
  overlay.querySelector('.pshare-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}
