/* ---- Reader Portrait share v2 (v500): three share-card styles from one
   portrait object (buildReaderPortrait, js/212-dna.js), presented in a
   swipeable share sheet. Spec: docs/reader-portrait-share-v2-spec.md.
   A Editorial · B Cover Story · C Sticker Pack. All cards 1080x1920 via
   the v399 cardCanvas() helper, palette from the active theme's tokens.
   Branding: app icon + wordmark only. No emoji taglines, no URL/QR. ---- */

/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */
export var PS_SERIF = "Georgia, 'Times New Roman', serif";
export var PS_SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

export const PS_STYLES = [
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
export const PS_STICKER_DIR = { 'wisp-night': 'wispnight' };
export const PS_STICKER_SETS = {
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
export function psStickerPaths(themeKey, readerKey, monthKey) {
  const dir = PS_STICKER_DIR[themeKey] || themeKey;
  const counts = PS_STICKER_SETS[dir];
  if (!counts) return [];
  const all = [];
  ['a', 'b'].forEach((sheet) => {
    // v552 (#213): the sticker numbers come from js/105's
    // stickerSheetNumbers — the same inventory truth the avatar picker
    // uses. Four shipped sheets are numbered non-contiguously (retired
    // numbers), so enumerating 1..count here produced phantom paths
    // (files that don't exist) and missed real stickers past the gaps.
    stickerSheetNumbers(dir, sheet).forEach(i => {
      all.push('assets/stickers/cut-webp/' + dir + '/' + dir + '-' + sheet + '-' +
        String(i).padStart(2, '0') + '.webp');
    });
  });
  const rng = portraitRng(portraitHash(String(readerKey || '') + ':' + String(monthKey || '')));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = all[i]; all[i] = all[j]; all[j] = tmp;
  }
  return all;
}
export function psMonthKey(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
}

/* Sticker phrase bank (spec, verbatim). Identity phrases, never data
   claims. BOOKS > PEOPLE is an optional-tier filler — not a default. */
export const PS_PHRASES = [
  'BOOKTOK MADE ME DO IT', 'JUST ONE MORE CHAPTER', 'PLOT TWIST MENACE',
  'EMOTIONAL SUPPORT BOOK', 'PROFESSIONAL TBR BUILDER', 'IN MY READING ERA',
  'WARNING: EASILY DISTRACTED BY BOOKS', 'HEAD LIBRARIAN',
  'DO NOT DISTURB: AT THE CLIMAX'
];
export const PS_PHRASE_DRAGON = 'MY OTHER RIDE IS A DRAGON'; // fantasy clusters only
export const PS_DRAGON_CLUSTERS = ['fantasy', 'romantasy', 'litrpg', 'paranormal'];
export function psPickPhrases(p, count) {
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
export function psLoadImage(src, timeoutMs) {
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
export function psLoadCover(url) {
  if (typeof loadCoverImage === 'function') return loadCoverImage(url);
  return psLoadImage(url, 8000);
}
export async function psLoadAssets(p, style) {
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
      /* Composition v2 (v502): load the theme's whole seeded set (<=25);
         the renderer picks 10-14 for the bomb and leaves the rest out. */
      const paths = psStickerPaths(themeKey, p.readerKey, psMonthKey());
      jobs.push(Promise.all(paths.map(s => psLoadImage(s))).then(imgs => {
        A.stickers = imgs.filter(Boolean);
      }));
    }
    await Promise.all(jobs);
  } catch (e) {}
  return A;
}

/* ---- shared drawing helpers ---- */
export function psWrap(x, text, maxW) {
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
export function psStars(x, cx, y, size, color) {
  x.save();
  x.fillStyle = color; x.font = size + 'px ' + PS_SANS; x.textAlign = 'center';
  try { dnaSpaced(x, '★★★★★', cx, y, Math.round(size * 0.35)); } catch (e) { x.fillText('★★★★★', cx, y); }
  x.restore();
}
/* Footer branding: icon + wordmark, sized so a link element can join the
   slot later. No emoji, no URL (spec branding rules). Adapter over the
   one shared cardFooter (js/050) — it only translates this card family's
   palette token, baseline, and preloaded icon into cardFooter options. */
export function psFooter(x, W, y, t, icon) {
  cardFooter(x, W, { y: y, color: t && t.muted, icon: icon });
}
export function psDrawCoverFit(x, img, cx, cy, w, h, r) {
  x.save();
  try {
    cvRoundRect(x, cx - w / 2, cy - h / 2, w, h, r || 8); x.clip();
    const s = Math.max(w / (img.width || w), h / (img.height || h));
    const dw = (img.width || w) * s, dh = (img.height || h) * s;
    x.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  } catch (e) {}
  x.restore();
}
export function psCoverPlaceholder(x, book, cx, cy, w, h, t) {
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
export function psCelebration(p) {
  const parts = [p.n + (p.n === 1 ? ' story' : ' stories') + ' seen through to their ending'];
  if (p.streak >= 2) parts.push('that one ' + p.streak + '-day reading cocoon');
  if (p.topAuthor) parts.push('most-read: ' + p.topAuthor.name);
  return parts.join(' · ');
}
/* Spice appetite as a blurb sentence for B: "a dragonfire palate — no
   regrets" -> "A dragonfire palate. No regrets." */
export function psBlurbSentence(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  s = s.replace(/\s—\s/g, '. ');
  s = s.replace(/\. ([a-z])/g, (m, c) => '. ' + c.toUpperCase());
  if (!/[.!?]$/.test(s)) s += '.';
  return s;
}

/* ================= A — Editorial ================= */
export function drawPortraitEditorial(x, W, H, p, t, A) {
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
export function drawPortraitCoverStory(x, W, H, p, t, A) {
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
/* Measure a pill without drawing it: box size + per-line glyph boxes in
   pill-local coords. The collage layout pass uses the glyph boxes as
   protected zones before anything is drawn. */
export function psPillMetrics(x, o) {
  const lines = o.lines || [];
  let w = 0;
  lines.forEach(L => {
    x.font = L.font;
    try { L._mw = x.measureText(L.text).width; } catch (e) { L._mw = 0; }
    w = Math.max(w, L._mw);
  });
  const gap = o.lineGap != null ? o.lineGap : 8;
  const totalH = lines.reduce((s, L) => s + L.size, 0) + gap * Math.max(0, lines.length - 1);
  let ly = -totalH / 2;
  const lineBoxes = [];
  lines.forEach(L => {
    ly += L.size;
    /* Glyph box (baseline sits at ly - 0.22*size in the draw loop). */
    lineBoxes.push({ x0: -(L._mw || 0) / 2, x1: (L._mw || 0) / 2, y0: ly - L.size * 1.05, y1: ly });
    ly += gap;
  });
  return { w: w + (o.padX || 34) * 2, h: totalH + (o.padY || 20) * 2, lines: lineBoxes, totalH, gap };
}
export function psPill(x, cx, cy, o) {
  const m = psPillMetrics(x, o);
  const lines = o.lines || [];
  const bw = m.w, bh = m.h, totalH = m.totalH, gap = m.gap;
  x.save();
  x.translate(cx, cy);
  x.rotate((o.rot || 0) * Math.PI / 180);
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
  return { w: bw, h: bh, lines: m.lines };
}
export function psStarburst(x, cx, cy, r, fill) {
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
export function psIllustrated(x, img, cx, cy, size, rot) {
  if (!img) return;
  x.save();
  x.translate(cx, cy);
  x.rotate((rot || 0) * Math.PI / 180);
  const s = size / Math.max(img.width || size, img.height || size);
  const dw = (img.width || size) * s, dh = (img.height || size) * s;
  try { x.drawImage(img, -dw / 2, -dh / 2, dw, dh); } catch (e) {}
  x.restore();
}

/* ---- composition geometry (v502): boxes keep the sticker bomb dense
   without ever covering text. A pill's protected zone is its TEXT lines
   (not the whole pill), so illustrated stickers may kiss pill borders
   exactly like a real sticker-bombed e-reader back. ---- */
export function psBox(cx, cy, w, h, rot) {
  const a = Math.abs((rot || 0) * Math.PI / 180);
  const c = Math.cos(a), s = Math.sin(a);
  const hw = (w / 2) * c + (h / 2) * s;
  const hh = (w / 2) * s + (h / 2) * c;
  return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
}
export function psBoxesHit(a, b) {
  return !!a && !!b && a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}
/* Protected zones for a drawn pill: each text line's glyph box, rotated
   into canvas coords and padded by `pad`. Returns canvas-space boxes. */
export function psPillZones(cx, cy, pill, rot, pad) {
  const a = (rot || 0) * Math.PI / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const p = pad || 0;
  return (pill.lines || []).map(L => {
    const corners = [
      [L.x0, L.y0], [L.x1, L.y0], [L.x0, L.y1], [L.x1, L.y1]
    ].map(([lx, ly]) => [cx + lx * c - ly * s, cy + lx * s + ly * c]);
    const xs = corners.map(q => q[0]), ys = corners.map(q => q[1]);
    return {
      x0: Math.min.apply(null, xs) - p, y0: Math.min.apply(null, ys) - p,
      x1: Math.max.apply(null, xs) + p, y1: Math.max.apply(null, ys) + p
    };
  });
}

/* The recent-read cover AS a sticker (v502 amendment): die-cut white
   contour + drop shadow, no polaroid frame, no caption — the cover
   carries its own title. If the cover image failed to load, a
   title-text sticker with the same contour stands in. */
export function psCoverSticker(x, img, book, cx, cy, w, h, rot, t) {
  const B = 16; // white contour width at card scale
  x.save();
  x.translate(cx, cy);
  x.rotate((rot || 0) * Math.PI / 180);
  x.shadowColor = 'rgba(0,0,0,0.4)'; x.shadowBlur = 20; x.shadowOffsetY = 9;
  cvRoundRect(x, -w / 2 - B, -h / 2 - B, w + B * 2, h + B * 2, 22);
  x.fillStyle = '#fdfbf7'; x.fill();
  x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetY = 0;
  if (img) {
    psDrawCoverFit(x, img, 0, 0, w, h, 6);
  } else {
    cvRoundRect(x, -w / 2, -h / 2, w, h, 6);
    x.fillStyle = dnaMix(t.bg2, t.accent, 0.25); x.fill();
    x.strokeStyle = dnaAlpha(t.ink, 0.2); x.lineWidth = 2; x.stroke();
    x.fillStyle = t.ink; x.textAlign = 'center';
    x.font = '600 30px ' + PS_SERIF;
    const lines = psWrap(x, (book && book.title) || 'Untitled', w - 44).slice(0, 5);
    lines.forEach((ln, i) => x.fillText(ln, 0, 12 - ((lines.length - 1) * 38) / 2 + i * 38));
    if (book && book.author) {
      x.font = '21px ' + PS_SANS; x.fillStyle = t.muted;
      x.fillText(dnaEllipsize(x, book.author, w - 44), 0, h / 2 - 24);
    }
  }
  x.restore();
}

export function drawPortraitStickerPack(x, W, H, p, t, A) {
  x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  const darkInk = '#241a2e';
  const GLYPH_PAD = 10; // protected margin around text glyphs + cover art

  /* FULL BLEED (composition v3): the canvas IS the e-reader back — no
     inset device frame floating on a background, no camera dot. Matte
     shell; stickers run to the edges and are clipped by the frame,
     like the real sticker-bombed e-readers this is modeled on. */
  let bgGrad = null;
  try {
    bgGrad = x.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, t.bg2); bgGrad.addColorStop(1, t.card2);
  } catch (e) {}
  x.fillStyle = bgGrad || t.bg2;
  x.fillRect(0, 0, W, H);

  const rng = portraitRng((p.seed ^ 0x51ab) >>> 0);

  const layout = { pills: [], coverSticker: null, coverArt: null, protectedZones: [], stickerBoxes: [], stickersDrawn: 0, coverage: 0 };

  /* ---- Phase 1: data layout. Every data element is measured first;
     its text GLYPH boxes (padded >=10px) become the collage's protected
     zones. Pill borders and shadows may be kissed by stickers; letters
     and the cover art may not. Data elements join the collage with
     varied scale/tilt (genre small, fan-club large, tilts <=8deg). ---- */
  const els = [];
  const addPill = (cx, cy, rot, o, clampX) => {
    const m = psPillMetrics(x, o);
    let box = psBox(cx, cy, m.w, m.h, rot);
    if (clampX) {
      /* Edge pills (genre, phrases) shift inward so their text is never
         clipped by the canvas edge, however long the line runs. */
      if (box.x0 < 6) { cx += 6 - box.x0; box = psBox(cx, cy, m.w, m.h, rot); }
      if (box.x1 > W - 6) { cx -= box.x1 - (W - 6); box = psBox(cx, cy, m.w, m.h, rot); }
    }
    const el = { cx, cy, rot, o, m, box };
    els.push(el);
    layout.pills.push(el.box);
    psPillZones(cx, cy, m, rot, GLYPH_PAD).forEach(z => layout.protectedZones.push(z));
    return el;
  };

  /* Focal point: the archetype sticker — the headline pill.
     Shrink-to-fit before any truncation (v502): the headline is never
     ellipsized; if it still overflows at the 38px floor, the pill takes
     two lines instead. */
  const mkFocal = (s) => '700 ' + s + 'px ' + PS_SERIF;
  const focalSize = dnaFitSize(x, p.headline, 830, mkFocal, 66, 38);
  let focalLines = [{ text: p.headline, font: mkFocal(focalSize), fg: t.gold, size: focalSize }];
  x.font = mkFocal(focalSize);
  let focalW = 0;
  try { focalW = x.measureText(p.headline).width; } catch (e) {}
  if (focalW > 830) {
    focalLines = psWrap(x, p.headline, 830).slice(0, 2)
      .map(ln => ({ text: ln, font: mkFocal(focalSize), fg: t.gold, size: focalSize }));
  }
  addPill(W / 2, 330, -2, {
    rot: -2, bg: t.card2, ring: dnaAlpha(t.gold, 0.7), padX: 52, padY: 30,
    lines: [{ text: '★ READER PORTRAIT ★', font: '600 27px ' + PS_SANS, fg: t.muted, size: 27 }].concat(focalLines),
    lineGap: 14
  });

  /* Genre sticker — deliberately small in the pile. */
  if (p.dominantGenre) {
    addPill(258, 148, -6, {
      rot: -6, bg: t.gold, padX: 26, padY: 12,
      lines: [{ text: p.dominantGenre.toUpperCase(), font: '700 34px ' + PS_SANS, fg: darkInk, size: 34 }]
    }, true);
  }

  /* Appetite pill (any ladder axis). Spice appears only when the spice
     axis actually fired — stickers never contradict the data. Same
     shrink-to-fit rule as the focal line: fit first, two lines at the
     floor, never cut. */
  let appetiteEl = null;
  if (p.appetite) {
    const mkApp = (s) => 'italic ' + s + 'px ' + PS_SERIF;
    const appSize = dnaFitSize(x, p.appetite.text, 830, mkApp, 39, 38);
    let appLines = [{ text: p.appetite.text, font: mkApp(appSize), fg: t.ink, size: appSize }];
    x.font = mkApp(appSize);
    let appW = 0;
    try { appW = x.measureText(p.appetite.text).width; } catch (e) {}
    if (appW > 830) {
      appLines = psWrap(x, p.appetite.text, 830).slice(0, 2)
        .map(ln => ({ text: ln, font: mkApp(appSize), fg: t.ink, size: appSize }));
    }
    appetiteEl = addPill(W / 2, 512, 1.5, {
      rot: 1.5, bg: t.bg, ring: dnaAlpha(t.accent, 0.8), padX: 38, padY: 18,
      lines: appLines
    });
  }

  /* The cover sticker slot: derived from the appetite pill's actual box
     — its top edge sits >=24px below the pill's bottom edge, so the two
     never intersect, whatever the appetite line does. */
  const COVER_W = 252, COVER_H = 378, COVER_B = 16, COVER_ROT = 4;
  let cover = null;
  if (p.polaroid) {
    const half = psBox(0, 0, COVER_W + COVER_B * 2, COVER_H + COVER_B * 2, COVER_ROT);
    const coverCy = appetiteEl ? Math.ceil(appetiteEl.box.y1 + 24 - half.y0) : 800;
    cover = { cx: 842, cy: coverCy, rot: COVER_ROT };
    layout.coverSticker = psBox(842, coverCy, COVER_W + COVER_B * 2, COVER_H + COVER_B * 2, COVER_ROT);
    layout.coverArt = psBox(842, coverCy, COVER_W, COVER_H, COVER_ROT);
    layout.protectedZones.push({
      x0: layout.coverArt.x0 - 10, y0: layout.coverArt.y0 - 10,
      x1: layout.coverArt.x1 + 10, y1: layout.coverArt.y1 + 10
    });
  }

  /* Top-trope quote bubble. The quote wraps to <=430px lines so the
     bubble stays clear of the cover sticker on its right. */
  const topTrope = p.tropes.length ? p.tropes[0] : null;
  if (topTrope) {
    x.font = 'italic 37px ' + PS_SERIF;
    const quoteLines = psWrap(x, '“' + topTrope.quote + '”', 430).slice(0, 3);
    const qLines = [{ text: '★★★★★', font: '24px ' + PS_SANS, fg: t.gold, size: 24 }]
      .concat(quoteLines.map(ln => ({ text: ln, font: 'italic 37px ' + PS_SERIF, fg: t.ink, size: 37 })))
      .concat([{ text: topTrope.attribution, font: '25px ' + PS_SANS, fg: t.muted, size: 25 }]);
    addPill(378, 712, -1.5, {
      rot: -1.5, bg: dnaMix(t.card2, t.ink, 0.07), padX: 34, padY: 24, radius: 34,
      lines: qLines, lineGap: 10
    });
  }

  /* Pages starburst: only its TEXT is protected — the spikes are fair
     game for sticker kisses, like the reference collages. */
  const BURST = { cx: 224, cy: 1010, r: 150 };
  const mkB = (s) => '700 ' + s + 'px ' + PS_SERIF;
  const burstSize = dnaFitSize(x, p.pages.toLocaleString(), 215, mkB, 56, 30);
  x.font = mkB(burstSize);
  let pagesW = 0;
  try { pagesW = x.measureText(p.pages.toLocaleString()).width; } catch (e) {}
  x.font = '700 29px ' + PS_SANS;
  let pagesLblW = 0;
  try { pagesLblW = x.measureText('PAGES!').width; } catch (e) {}
  const burstHW = Math.max(pagesW, pagesLblW) / 2 + GLYPH_PAD;
  layout.protectedZones.push({ x0: BURST.cx - burstHW, y0: BURST.cy - 62, x1: BURST.cx + burstHW, y1: BURST.cy + 62 });

  /* Top-author fan club sticker — deliberately large in the pile.
     Shrink-to-fit like the other text lines; never ellipsized. */
  if (p.topAuthor) {
    const fanRaw = p.topAuthor.name.toUpperCase() + ' FAN CLUB';
    const mkFan = (s) => '700 ' + s + 'px ' + PS_SANS;
    const fanSize = dnaFitSize(x, fanRaw, 800, mkFan, 37, 26);
    addPill(545, 1252, -1.5, {
      rot: -1.5, bg: t.accentDeep, padX: 42, padY: 20,
      lines: [
        { text: fanRaw, font: mkFan(fanSize), fg: '#ffffff', size: fanSize },
        { text: 'president, obviously', font: 'italic 27px ' + PS_SERIF, fg: 'rgba(255,255,255,0.85)', size: 27 }
      ],
      lineGap: 9
    });
  }

  /* Finished strip. */
  addPill(W / 2, 1402, 1, {
    rot: 1, bg: t.card2, ring: dnaAlpha(t.ink, 0.35), padX: 44, padY: 20,
    lines: [{ text: '★ ' + p.n + (p.n === 1 ? ' STORY' : ' STORIES') + ' FINISHED ★', font: '700 39px ' + PS_SANS, fg: t.ink, size: 39 }]
  });

  /* Milestone sticker: the streak, remembered — only when it is a real
     cocoon (7+ days). */
  const cocoon = p.streak >= 7;
  if (cocoon) {
    addPill(W / 2, 1536, -1, {
      rot: -1, bg: t.bg, padX: 32, padY: 14,
      lines: [{ text: 'THAT ONE ' + p.streak + '-DAY READING COCOON', font: '600 27px ' + PS_SANS, fg: t.gold, size: 27 }]
    });
  }

  /* Phrase fillers (data-adjacent pills, protected like the rest). */
  const phrases = psPickPhrases(p, cocoon ? 1 : 2);
  if (phrases[0]) {
    addPill(262, cocoon ? 1652 : 1576, -5, {
      rot: -5, bg: dnaMix(t.bg2, t.accent, 0.3), padX: 24, padY: 12,
      lines: [{ text: phrases[0], font: '700 26px ' + PS_SANS, fg: t.ink, size: 26 }]
    }, true);
  }
  if (phrases[1]) {
    addPill(812, 1586, 4, {
      rot: 4, bg: dnaMix(t.bg2, t.gold, 0.3), padX: 24, padY: 12,
      lines: [{ text: phrases[1], font: '700 26px ' + PS_SANS, fg: t.ink, size: 26 }]
    }, true);
  }

  /* Footer wordmark: soft dark backing pill so it stays legible over
     art; its glyph box is protected like the other text. */
  const FOOT_Y = 1846;
  x.font = '600 34px ' + PS_SERIF;
  let footTw = 0;
  try { footTw = x.measureText('Cozy Libram').width; } catch (e) {}
  const footW = (A.icon ? 46 + 16 : 0) + footTw;
  const footPill = { x0: W / 2 - footW / 2 - 30, y0: FOOT_Y - 52, x1: W / 2 + footW / 2 + 30, y1: FOOT_Y + 20 };
  layout.pills.push(footPill);
  layout.protectedZones.push({ x0: footPill.x0 + 12, y0: footPill.y0 + 8, x1: footPill.x1 - 12, y1: footPill.y1 - 4 });

  /* ---- Phase 2: the collage. Seeded scatter in three size classes —
     heroes ~300-350px, mids ~195-265px, fillers ~105-140px — rotations
     anywhere in +-22deg. Decorative stickers overlap EACH OTHER
     freely; a placement is valid only if its box clears every
     protected glyph zone. Placement is FIRST-VALID-WINS from a small
     candidate pool — no coverage-maximizing pick — so the pile clumps
     and gaps the way a real sticker bomb does instead of spreading
     evenly. Coverage survives only as a floor: a candidate landing
     almost entirely on already-covered canvas is rejected, and the
     coverage target is met by sticker COUNT, not placement steering.
     Heroes scatter anywhere on the canvas; a soft bias toward
     sitting flush against the edges is a bias, never anchor slots.
     NOTHING IS CLIPPED: every sticker's rotated box must lie fully
     inside the canvas — containment is a validity rule for every
     class, and candidate centers are sampled inside the inset
     region for their size+rotation so first-valid doesn't starve.
     Deterministic per reader+month (seeded rng). */
  const zones = layout.protectedZones;
  const clearOfZones = (box) => !zones.some(z => psBoxesHit(box, z));
  const CELL = 30, GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);
  const grid = new Uint8Array(GW * GH);
  const eachCell = (box, fn) => {
    const gx0 = Math.max(0, Math.floor(box.x0 / CELL)), gx1 = Math.min(GW - 1, Math.floor(box.x1 / CELL));
    const gy0 = Math.max(0, Math.floor(box.y0 / CELL)), gy1 = Math.min(GH - 1, Math.floor(box.y1 / CELL));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = gx * CELL + CELL / 2, py = gy * CELL + CELL / 2;
        if (px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1) fn(gy * GW + gx);
      }
    }
  };
  const markBox = (box) => eachCell(box, (i) => { grid[i] = 1; });
  layout.pills.forEach(markBox);
  if (layout.coverSticker) markBox(layout.coverSticker);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const dx = gx * CELL + CELL / 2 - BURST.cx, dy = gy * CELL + CELL / 2 - BURST.cy;
      if (dx * dx + dy * dy <= BURST.r * BURST.r) grid[gy * GW + gx] = 1;
    }
  }

  const layers = { hero: [], mid: [], filler: [], kiss: [] };
  const imgs = A.stickers || [];
  let imgIdx = 0;
  /* Rotated half-extent of a square sticker — the same math psBox
     uses — so candidate centers can be sampled inside the region
     where the whole rotated box stays on-canvas. */
  const halfExt = (size, rot) => {
    const a = Math.abs(rot * Math.PI / 180);
    return (size / 2) * (Math.cos(a) + Math.sin(a));
  };
  const pickFirst = (layer, candidates, minNewFrac) => {
    if (imgIdx >= imgs.length) return false;
    for (const cand of candidates) {
      const box = psBox(cand.cx, cand.cy, cand.size, cand.size, cand.rot);
      if (box.x0 < 0 || box.y0 < 0 || box.x1 > W || box.y1 > H) continue;
      if (!clearOfZones(box)) continue;
      let cells = 0, added = 0;
      eachCell(box, (i) => { cells++; if (!grid[i]) added++; });
      if (cells > 0 && added / cells < minNewFrac) continue;
      layers[layer].push({ img: imgs[imgIdx], cx: cand.cx, cy: cand.cy, size: cand.size, rot: cand.rot, box });
      markBox(box);
      imgIdx++;
      return true;
    }
    return false;
  };
  /* Uniform scatter INSIDE the canvas: rotation drawn first, then the
     center sampled in the inset region for that size+rotation — a
     sticker can sit flush against an edge, never across it. */
  const randCands = (n, size) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const rot = (rng() * 2 - 1) * 22;
      const he = halfExt(size, rot);
      arr.push({ cx: he + rng() * (W - 2 * he), cy: he + rng() * (H - 2 * he), size, rot });
    }
    return arr;
  };
  /* Hero candidates: anywhere in the inset region, with a soft bias
     toward sitting FLUSH against a random edge (~75%): the biased
     coordinate hugs its inset boundary (up to ~0.3 of a hero inward),
     the other stays uniform. A bias, never slots. */
  const heroCands = (n, size) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const rot = (rng() * 2 - 1) * 22;
      const he = halfExt(size, rot);
      let cx = he + rng() * (W - 2 * he), cy = he + rng() * (H - 2 * he);
      if (rng() < 0.75) {
        const side = Math.floor(rng() * 4), inset = rng() * size * 0.3;
        if (side === 0) cx = he + inset;
        else if (side === 1) cx = W - he - inset;
        else if (side === 2) cy = he + inset;
        else cy = H - he - inset;
      }
      arr.push({ cx, cy, size, rot });
    }
    return arr;
  };

  /* Job counts carry the coverage: a first-valid pool of ~10 finds a
     zone-clear spot only some of the time (big stickers especially),
     so jobs outnumber the stickers expected to land — surplus jobs
     just stop once the theme's set is used up. Kiss jobs run before
     fillers so the small set aside for them isn't crowded out;
     placement order is not draw order (layers draw heroes -> mids ->
     fillers -> data -> kiss regardless). */
  for (let hJob = 0; hJob < 32; hJob++) pickFirst('hero', heroCands(10, 300 + rng() * 50), 0.2);
  for (let mJob = 0; mJob < 44; mJob++) pickFirst('mid', randCands(10, 195 + rng() * 70), 0.2);

  /* Kiss fillers (drawn last, over the data layer): sampled around data
     pill borders — they may touch pill rects, never glyph zones, and
     containment applies to them too (a kiss that would cross the
     canvas edge is simply not placed there). */
  for (let kJob = 0; kJob < 4; kJob++) {
    if (imgIdx >= imgs.length || !els.length) break;
    const cands = [];
    for (let i = 0; i < 10; i++) {
      const el = els[Math.floor(rng() * els.length)];
      const size = 95 + rng() * 30;
      const rot = (rng() * 2 - 1) * 22;
      const ang = rng() * Math.PI * 2;
      const rx = (el.box.x1 - el.box.x0) / 2 + size * 0.55;
      const ry = (el.box.y1 - el.box.y0) / 2 + size * 0.55;
      cands.push({ cx: (el.box.x0 + el.box.x1) / 2 + Math.cos(ang) * rx, cy: (el.box.y0 + el.box.y1) / 2 + Math.sin(ang) * ry, size, rot });
    }
    pickFirst('kiss', cands, 0.05);
  }

  for (let fJob = 0; fJob < 36; fJob++) pickFirst('filler', randCands(10, 105 + rng() * 35), 0.15);

  /* ---- Phase 3: draw — decorative layers first, data on top, kiss
     fillers last. ---- */
  const drawLayer = (arr) => arr.forEach(s => {
    psIllustrated(x, s.img, s.cx, s.cy, s.size, s.rot);
    layout.stickerBoxes.push(s.box);
    layout.stickersDrawn++;
  });
  drawLayer(layers.hero);
  drawLayer(layers.mid);
  drawLayer(layers.filler);

  if (cover) psCoverSticker(x, A.polaroid, p.polaroid, cover.cx, cover.cy, COVER_W, COVER_H, cover.rot, t);
  els.forEach(el => psPill(x, el.cx, el.cy, el.o));

  psStarburst(x, BURST.cx, BURST.cy, BURST.r, t.gold);
  x.save();
  x.translate(BURST.cx, BURST.cy); x.rotate(-10 * Math.PI / 180);
  x.fillStyle = darkInk; x.textAlign = 'center';
  x.font = mkB(burstSize);
  x.fillText(p.pages.toLocaleString(), 0, 6);
  x.font = '700 29px ' + PS_SANS;
  x.fillText('PAGES!', 0, 48);
  x.restore();

  x.save();
  x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = 14; x.shadowOffsetY = 5;
  cvRoundRect(x, footPill.x0, footPill.y0, footPill.x1 - footPill.x0, footPill.y1 - footPill.y0, 36);
  x.fillStyle = dnaAlpha(t.bg, 0.78); x.fill();
  x.restore();
  psFooter(x, W, FOOT_Y, t, A.icon);

  drawLayer(layers.kiss);

  /* Coverage: the phase-2 grid already tracks every data box + placed
     sticker box (+ the burst disc), sampled at cell centers. */
  let covHit = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i]) covHit++;
  layout.coverage = grid.length ? covHit / grid.length : 0;
  return layout;
}

/* ---- render entry: one portrait, three renderers ---- */
export async function renderPortraitCanvas(style) {
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
export function openPortraitShareSheet() {
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
      '<div class="pshare-stage">' +
        '<button class="pshare-nav prev" aria-label="Previous style">‹</button>' +
        '<div class="pshare-track">' +
          PS_STYLES.map(s =>
            '<div class="pshare-slide"><div class="pshare-card" data-style="' + s.key + '">' +
            '<div class="pshare-loading">Painting your portrait…</div></div></div>').join('') +
        '</div>' +
        '<button class="pshare-nav next" aria-label="Next style">›</button>' +
      '</div>' +
      '<div class="pshare-dots">' +
        PS_STYLES.map((s, i) => '<button class="pshare-dot' + (i === active ? ' on' : '') + '" data-i="' + i + '" aria-label="Show ' + s.name + '"></button>').join('') +
      '</div>' +
      '<p class="pshare-name">' + PS_STYLES[active].name + '</p>' +
      '<button class="btn pshare-go" style="width:100%">Share this portrait</button>' +
      '<button class="btn btn-ghost pshare-close" style="width:100%;margin-top:8px">Not now</button>' +
    '</div>';
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const trackEl = overlay.querySelector('.pshare-track');
  const dots = overlay.querySelectorAll('.pshare-dot');
  const nameEl = overlay.querySelector('.pshare-name');
  const prevBtn = overlay.querySelector('.pshare-nav.prev');
  const nextBtn = overlay.querySelector('.pshare-nav.next');
  const canvases = {};

  /* One place updates the active style: dots, name, arrows, and the
     remembered preference all follow the visible slide. */
  const setActive = (i) => {
    active = Math.max(0, Math.min(PS_STYLES.length - 1, i));
    dots.forEach((d, j) => d.classList.toggle('on', j === active));
    nameEl.textContent = PS_STYLES[active].name;
    if (prevBtn) prevBtn.disabled = active === 0;
    if (nextBtn) nextBtn.disabled = active === PS_STYLES.length - 1;
    try { localStorage.setItem('pshareStyle', PS_STYLES[active].key); } catch (e) {}
  };
  const goTo = (i) => {
    const target = Math.max(0, Math.min(PS_STYLES.length - 1, i));
    try { trackEl.scrollTo({ left: target * (trackEl.clientWidth || 0), behavior: 'smooth' }); }
    catch (e) { trackEl.scrollLeft = target * (trackEl.clientWidth || 0); }
    setActive(target);
  };

  const onKey = (e) => {
    if (!overlay.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (typeof overlayIsTop === 'function' && !overlayIsTop(token)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(active + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(active - 1); }
  };

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
    if (typeof overlayClosed === 'function') overlayClosed(token);
  };
  const token = (typeof overlayOpened === 'function') ? overlayOpened('portrait-share', close) : null;
  document.addEventListener('keydown', onKey);

  /* v513: drag-to-dismiss — the gesture half of the .sheet pattern.
     Every other sheet wires wireSheetDrag; this one never did, so a
     downward swipe could scroll content but never close the sheet.
     The helper's own guards cover the carousel inside: gestures
     starting in the horizontal track (or running mostly horizontal)
     are refused, and the scrollTop veto keeps a scrolled sheet up. */
  if (typeof wireSheetDrag === 'function')
    wireSheetDrag(overlay.querySelector('.pshare-sheet'), close);

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

  /* v512: JS gesture driver for the carousel. v511's touch-action
     claims weren't enough on Android — native arbitration still hands
     diagonal swipes to the sheet's vertical scroller and the cards
     never move. So the driver claims clearly-horizontal drags itself,
     in wireSheetDrag's shape (js/150): undecided until ~10px of
     travel, then either claims the horizontal axis and drives
     scrollLeft directly, or stands down for the rest of the gesture
     and lets the sheet scroll (even when the touch started on a
     card). While a drag is driven, snap is suspended (.pshare-drag)
     and the scroll-sync listener below stands aside — touchend
     settles through goTo(), the one place dots/name/preference sync.
     Touch only; mouse users keep the arrows and dots. */
  let drvX = null, drvY = null, drvScroll = 0, drvAxis = ''; // '' | 'x' | 'y'
  const drvReset = () => {
    drvX = null; drvY = null; drvAxis = '';
    trackEl.classList.remove('pshare-drag');
  };
  const drvSettle = () => {
    const w = trackEl.clientWidth || 1;
    const i = Math.max(0, Math.min(PS_STYLES.length - 1, Math.round(trackEl.scrollLeft / w)));
    drvReset();
    goTo(i);
  };
  trackEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { drvReset(); return; }
    drvX = e.touches[0].clientX; drvY = e.touches[0].clientY;
    drvScroll = trackEl.scrollLeft; drvAxis = '';
    trackEl.classList.remove('pshare-drag');
  }, { passive: true });
  trackEl.addEventListener('touchmove', (e) => {
    if (drvX == null) return;
    if (e.touches.length !== 1) { drvSettle(); return; } // second finger: end the gesture cleanly
    if (drvAxis === 'y') return; // stood down — the sheet owns this gesture
    const dx = e.touches[0].clientX - drvX;
    const dy = e.touches[0].clientY - drvY;
    if (drvAxis === '') {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; // not enough travel to call the axis
      if (Math.abs(dy) > Math.abs(dx)) { drvAxis = 'y'; return; }
      if (Math.abs(dx) === Math.abs(dy)) return; // perfectly diagonal: stay undecided
      drvAxis = 'x';
      trackEl.classList.add('pshare-drag'); // snap off while the finger drives
    }
    // Claimed: keep the sheet's vertical scroller out of this gesture
    // and drive the track straight from the gesture's total travel.
    if (e.cancelable) e.preventDefault();
    trackEl.scrollLeft = drvScroll - dx;
  }, { passive: false });
  trackEl.addEventListener('touchend', () => { if (drvX != null) drvSettle(); }, { passive: true });
  trackEl.addEventListener('touchcancel', () => { if (drvX != null) drvSettle(); }, { passive: true });

  let scrollTimer = null;
  trackEl.addEventListener('scroll', () => {
    if (drvAxis === 'x') return; // a driven drag is in progress; it settles on touchend
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const w = trackEl.clientWidth || 1;
      const i = Math.max(0, Math.min(PS_STYLES.length - 1, Math.round(trackEl.scrollLeft / w)));
      if (i !== active) setActive(i);
    }, 60);
  });

  /* Mouse/touch switching: dots and arrows drive the same carousel the
     swipe gesture uses (v502 — desktop had no path to styles 2 and 3). */
  dots.forEach(d => d.addEventListener('click', () => goTo(parseInt(d.dataset.i, 10) || 0)));
  if (prevBtn) prevBtn.addEventListener('click', () => goTo(active - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => goTo(active + 1));
  setActive(active);

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

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers, js/105-account.js and js/212-dna.js, call these functions at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.PS_SERIF = PS_SERIF;
window.PS_SANS = PS_SANS;
window.PS_STYLES = PS_STYLES;
window.PS_STICKER_DIR = PS_STICKER_DIR;
window.PS_STICKER_SETS = PS_STICKER_SETS;
window.psStickerPaths = psStickerPaths;
window.psMonthKey = psMonthKey;
window.PS_PHRASES = PS_PHRASES;
window.PS_PHRASE_DRAGON = PS_PHRASE_DRAGON;
window.PS_DRAGON_CLUSTERS = PS_DRAGON_CLUSTERS;
window.psPickPhrases = psPickPhrases;
window.psLoadImage = psLoadImage;
window.psLoadCover = psLoadCover;
window.psLoadAssets = psLoadAssets;
window.psWrap = psWrap;
window.psStars = psStars;
window.psFooter = psFooter;
window.psDrawCoverFit = psDrawCoverFit;
window.psCoverPlaceholder = psCoverPlaceholder;
window.psCelebration = psCelebration;
window.psBlurbSentence = psBlurbSentence;
window.drawPortraitEditorial = drawPortraitEditorial;
window.drawPortraitCoverStory = drawPortraitCoverStory;
window.psPillMetrics = psPillMetrics;
window.psPill = psPill;
window.psStarburst = psStarburst;
window.psIllustrated = psIllustrated;
window.psBox = psBox;
window.psBoxesHit = psBoxesHit;
window.psPillZones = psPillZones;
window.psCoverSticker = psCoverSticker;
window.drawPortraitStickerPack = drawPortraitStickerPack;
window.renderPortraitCanvas = renderPortraitCanvas;
window.openPortraitShareSheet = openPortraitShareSheet;
