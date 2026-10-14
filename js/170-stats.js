'use strict';

/* ---------------- stats view ---------------- */

/* v476: shared library-value estimate. Global so Settings (180) and the book
   modal (150) use the same number — Stats and Ledger always agree.
   Returns { value, actual }: `actual` is true when the user entered a real
   purchase price (their data is preferred, never discarded); otherwise the
   flat estimate default. Always an estimate — label it as such in UI. */
function libraryDefaultPrice() {
  try {
    var v = parseFloat(localStorage.getItem('cozylibram.defaultPrice'));
    if (!isNaN(v) && v >= 0) return Math.round(v * 100) / 100;
  } catch (e) {}
  // no stored default — fall back to the regional estimate (see below)
  var ccy = (typeof userCurrency === 'function') ? userCurrency() : 'CAD';
  return CURRENCY_DEFAULTS[ccy] != null ? CURRENCY_DEFAULTS[ccy] : 24.99;
}

/* v480: regional currency. Book values follow the reader's region: the
   browser locale maps to a currency plus a per-market default estimate.
   These are static regional averages, NOT live conversion — estimates stay
   estimates. purchasePrice is always in the user's own currency: it is
   formatted, never converted. Default: CAD (home market). */
var CURRENCY_DEFAULTS = {
  USD: 19.99,  // United States
  CAD: 24.99,  // Canada
  EUR: 17.99,  // Eurozone
  GBP: 14.99,  // United Kingdom
  AUD: 29.99,  // Australia
  NZD: 32.99,  // New Zealand
  CHF: 21.90,  // Switzerland
  SEK: 199,    // Sweden
  NOK: 219,    // Norway
  DKK: 149,    // Denmark
  MXN: 349,    // Mexico
  BRL: 99.90,  // Brazil
  INR: 499,    // India
  JPY: 2800    // Japan
};
function userCurrency() {
  var lang = '';
  try { lang = String(navigator.language || '').toLowerCase(); } catch (e) {}
  var parts = lang.split(/[-_]/);
  var country = (parts[1] || '').toUpperCase();
  var COUNTRY_CCY = {
    US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', JP: 'JPY',
    CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', MX: 'MXN', BR: 'BRL', IN: 'INR'
  };
  if (COUNTRY_CCY[country]) return COUNTRY_CCY[country];
  // language-only tags: eurozone languages default to EUR
  var EURO_LANGS = ['de', 'fr', 'es', 'it', 'nl', 'pt', 'fi', 'el', 'ga',
    'et', 'lv', 'lt', 'sk', 'sl', 'mt'];
  if (EURO_LANGS.indexOf(parts[0]) >= 0) return 'EUR';
  return 'CAD';
}
function userLocale() {
  try { return navigator.language || 'en-CA'; } catch (e) { return 'en-CA'; }
}
/* Format a money amount in the user's currency. opts.digits controls
   decimals (default 2). Falls back to bare $ on ancient engines. */
function formatMoney(amount, opts) {
  opts = opts || {};
  var digits = (opts.digits != null) ? opts.digits : 2;
  try {
    return new Intl.NumberFormat(userLocale(), {
      style: 'currency',
      currency: userCurrency(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(Number(amount) || 0);
  } catch (e) {
    return '$' + (Number(amount) || 0).toFixed(digits);
  }
}
function estimateBookValue(b) {
  if (b && b.purchasePrice != null && !isNaN(b.purchasePrice))
    return { value: b.purchasePrice, actual: true };
  return { value: libraryDefaultPrice(), actual: false };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
// v128: dashboard-first. 'dash' shows this month's hero numbers + glanceable
// sections; 'detail' is the full explorer behind one tap.
let statsMode = 'dash';
const dayKey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
  '-' + String(d.getDate()).padStart(2, '0');

function dayActivity() {
  // dayKey -> [{ b, from, to, finished }]; log entries first, finish dates fill gaps
  const map = {};
  const add = (k, e) => { (map[k] = map[k] || []).push(e); };
  library.forEach(b => {
    (b.log || []).forEach(e => {
      if (e.to > e.from) add(e.d, { b: b, from: e.from, to: e.to, finished: false });
    });
    if (b.status === 'read' && b.dateFinished) {
      const k = dayKey(new Date(b.dateFinished));
      if (!(map[k] || []).some(x => x.b === b)) add(k, { b: b, from: null, to: null, finished: true });
    }
  });
  return map;
}

function pagesByDayMap() {
  const byDay = dayActivity();
  const out = {};
  Object.keys(byDay).forEach(k => {
    out[k] = {
      pages: byDay[k].reduce((s, a) => s + (a.finished ? 0 : Math.max(0, a.to - a.from)), 0),
      n: byDay[k].length
    };
  });
  return out;
}
function biggestDay() {
  const m = pagesByDayMap();
  let best = null;
  Object.keys(m).forEach(k => {
    if (m[k].pages > 0 && (!best || m[k].pages > best.pages)) best = { k: k, pages: m[k].pages, n: m[k].n };
  });
  return best;
}
// v427 (issue #53): yearly page totals must sum actual logged pages, not
// book pageCounts — the calendar, biggest-day, and pace all use logs.
// Summing pageCount diverged (e.g. 400 vs 987) when logs didn't match.
// v454: ONE helper for all log-based page sums — pagesInRange(start, end)
// takes YYYY-MM-DD strings, sums (to - from) from reading logs only.
function pagesInRange(start, end) {
  let total = 0;
  library.forEach(b => {
    (b.log || []).forEach(e => {
      const d = String(e.d || '');
      if (d >= start && d <= end && e.to > e.from) {
        total += Math.max(0, e.to - e.from);
      }
    });
  });
  return total;
}
function pagesInYear(yr) {
  return pagesInRange(String(yr) + '-01-01', String(yr) + '-12-31');
}

/* ---- shared activity intensity (v63): pages/day -> level 0..4 from her
   own quartiles, so both the heatmap and the month calendar tint alike ---- */
function activityLevels() {
  const byDay = dayActivity();
  const pmap = pagesByDayMap();
  const vals = Object.keys(pmap).map(k => pmap[k].pages).filter(v => v > 0).sort((a, b) => a - b);
  const qt = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
  const t1 = qt(0.25), t2 = qt(0.5), t3 = qt(0.75);
  return {
    byDay,
    level(k) {
      const p = (pmap[k] || { pages: 0 }).pages;
      if (p > t3) return 4;
      if (p > t2) return 3;
      if (p > t1) return 2;
      if (p > 0 || (byDay[k] || []).length) return 1; // a finish with no logged pages still counts
      return 0;
    }
  };
}

/* ---- one day-detail renderer shared by the heatmap and the calendar ---- */
function dayDetailHTML(byDay, k) {
  const acts = (byDay[k] || []).slice().sort((x, y) => String(x.b.title).localeCompare(String(y.b.title)));
  const dayPages = acts.reduce((s, a) => s + (a.finished ? 0 : Math.max(0, a.to - a.from)), 0);
  const nBooks = new Set(acts.map(a => a.b.id)).size;
  return '<div class="stat-sub" style="margin-top:12px">' +
    fmtDate(new Date(k + 'T12:00:00').toISOString()) +
    ' — ' + icon('reading') + ' ' + nBooks + ' book' + (nBooks === 1 ? '' : 's') +
    ' · ' + icon('doc') + ' ' + dayPages + ' pages</div>' +
    (acts.length ? acts.map(a => {
      const pages = a.finished ? 0 : Math.max(0, a.to - a.from);
      const pct = (!a.finished && a.b.pageCount) ? ' (' + Math.round(pages / a.b.pageCount * 100) + '%)' : '';
      return '<div class="cal-book" data-id="' + esc(a.b.id) + '">' + coverHTML(a.b) +
        '<div><h4>' + esc(a.b.title) + '</h4>' +
        (a.finished ? '<p>Finished</p>'
          : '<p>p. ' + a.from + ' → p. ' + a.to + '</p><p>+' + pages + ' pages' + pct + '</p>') +
        '</div></div>';
    }).join('') : '<p class="note">Nothing read that day.</p>');
}

/* ---- reading activity heatmap (v62): GitHub-style, last 22 weeks ----
   Monday-first columns; cell intensity = level() from shared quartiles. */
const HEAT_WEEKS = 22;
function heatmapHTML() {
  const { byDay, level } = activityLevels();
  const today = new Date();
  const todayK = dayKey(today);
  const start = new Date(today);
  start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - 7 * (HEAT_WEEKS - 1));
  const dows = ['', 'M', '', 'W', '', 'F', ''];
  let cols = '<div class="heat-col heat-dows">' +
    dows.map(d => '<span>' + d + '</span>').join('') + '</div>';
  for (let w = 0; w < HEAT_WEEKS; w++) {
    let cells = '';
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start);
      dt.setDate(start.getDate() + w * 7 + d);
      const k = dayKey(dt);
      const future = k > todayK;
      const cls = 'heat-cell' + (future ? ' future' : ' l' + level(k)) +
        (k === todayK ? ' today' : '') + (k === heatSel ? ' sel' : '');
      cells += '<div class="' + cls + '" data-day="' + k + '"' +
        (future ? '' : ' title="' + k + '"') + '></div>';
    }
    cols += '<div class="heat-col">' + cells + '</div>';
  }

  const detail = heatSel
    ? '<div id="heat-books">' + dayDetailHTML(byDay, heatSel) + '</div>'
    : '<div id="heat-books"><p class="note">Tap a day to see what you read.</p></div>';

  return '<div class="stat-sub">Reading activity</div>' +
    '<div class="heat-scroll"><div class="heat" id="heatmap">' + cols + '</div></div>' +
    '<div class="heat-legend"><span>Less</span>' +
    [0, 1, 2, 3, 4].map(l => '<div class="heat-cell l' + l + '"></div>').join('') +
    '<span>More</span></div>' +
    detail;
}

/* ---- month calendar (v63): the familiar grid with covers is back, and each
   day cell now also carries the heatmap intensity tint ---- */
function readingCalHTML() {
  const { byDay, level } = activityLevels();
  const blanks = new Date(calY, calM, 1).getDay();
  const days = new Date(calY, calM + 1, 0).getDate();
  const todayK = dayKey(new Date());
  const kk = d => calY + '-' + String(calM + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  let cells = '';
  for (let i = 0; i < blanks; i++) cells += '<div class="cal-day blank"></div>';
  for (let d = 1; d <= days; d++) {
    const k = kk(d);
    const acts = byDay[k] || [];
    const n = acts.length;
    const dp = acts.reduce((s, a) => s + (a.finished ? 0 : Math.max(0, a.to - a.from)), 0);
    const cls = 'cal-day l' + level(k) + (n ? ' has' : '') + (k === todayK ? ' today' : '') + (k === calSel ? ' sel' : '');
    cells += '<div class="' + cls + '" data-day="' + k + '"><span class="d">' + d + '</span>' +
      (n ? '<span class="ccover">' +
        (acts[0].b.cover
          ? '<img src="' + esc(acts[0].b.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
          : icon('covers')) +
        (n > 1 ? '<span class="cdot">' + n + '</span>' : '') + '</span>' : '') +
      (dp > 0 ? '<span class="cday-pages">' + icon('doc') + dp + '</span>' : '') + '</div>';
  }
  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => '<div class="cal-dow">' + x + '</div>').join('');

  const detail = calSel
    ? '<div id="cal-books">' + dayDetailHTML(byDay, calSel) + '</div>'
    : '<div id="cal-books"></div>';
  const noDate = library.filter(b => b.status === 'read' && !b.dateFinished).length;

  return '<div class="stat-sub">Reading calendar</div>' +
    '<div class="cal-head"><button class="btn ghost" id="cal-prev">‹</button>' +
    '<h3>' + MONTHS[calM] + ' ' + calY + '</h3>' +
    '<button class="btn ghost" id="cal-next">›</button></div>' +
    '<div class="cal-grid" id="readcal">' + dow + cells + '</div>' +
    detail +
    (noDate ? '<p class="note">' + noDate + ' finished book' + (noDate > 1 ? 's have' : ' has') + ' no finish date.</p>' : '');
}

/* ---- reading pace (v62): pages/day from the trailing 30 days of logs,
   plus book-length and streak facts. ---- */
function fmtBig(n) {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(n));
}
function paceHTML() {
  // Batch 4 (issue #145): was 30 days × every book × pagesOnDay — a single
  // pagesInRange() pass sums the same log entries: it counts e.to > e.from
  // entries with d in [start, end], exactly what the loop accumulated
  // (pagesOnDay's Math.max(0, …) terms are zero for the entries pagesInRange
  // skips, and both ignore entries with blank dates).
  const today = new Date();
  const start30 = new Date(today);
  start30.setDate(today.getDate() - 29);
  const p30 = pagesInRange(dayKey(start30), dayKey(today));
  const perDay = p30 / 30;
  const read = library.filter(b => b.status === 'read');
  const withPages = read.filter(b => (b.pageCount || 0) > 0);
  const avgOf = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const avgLen = avgOf(withPages.map(b => b.pageCount));
  const daysData = read
    .filter(b => b.dateAdded && b.dateFinished)
    .map(b => (new Date(b.dateFinished) - new Date(b.dateAdded)) / 864e5)
      .filter(d => d >= 0 && d < 3650);
  const avgDays = avgOf(daysData);
  // v400: qualify small-n averages
  const avgDaysLabel = avgDays != null ? (() => {
    const d = Math.max(1, Math.round(avgDays));
    const base = d + (d === 1 ? ' day' : ' days');
    return daysData.length < 5 ? base + ' <span class="note">(based on ' + daysData.length + ' book' + (daysData.length === 1 ? '' : 's') + ')</span>' : base;
  })() : null;
  const streak = readingStreak(), best = longestStreak();

  // v536 (UX P3-14): round ONCE to pages/day, then derive week and
  // month from that rounded figure. Rounding each tile independently
  // disagreed by construction ("33 pages/day" beside "233 pages/week"
  // — 33 × 7 = 231); derived from one rounded day they cannot drift.
  const dayPace = Math.round(perDay);
  let html = '<div class="stat-sub">Reading pace</div>';
  html += p30 > 0
    ? '<p class="pace-hero">Your average pace is <b>' + dayPace + ' pages/day</b></p>' +
      '<div class="pace-grid">' +
      '<div class="pace"><div class="n">' + dayPace + '</div><div class="l">pages / day</div></div>' +
      '<div class="pace"><div class="n">' + (dayPace * 7).toLocaleString() + '</div><div class="l">pages / week</div></div>' +
      '<div class="pace"><div class="n">' + Math.round(dayPace * 30.44).toLocaleString() + '</div><div class="l">pages / month</div></div>' +
      '</div>'
    : '<p class="note">Log pages for a few days and your pace will show up here.</p>';
  const kv = (label, val) =>
    '<div class="kv-row"><span>' + label + '</span><b>' + val + '</b></div>';
  html += '<div class="kv">' +
    (avgLen != null ? kv(icon('reading') + ' Average book', Math.round(avgLen) + ' pages') : '') +
    (avgDaysLabel != null ? kv(icon('hourglass') + ' Average time to finish', avgDaysLabel) : '') +
    kv(icon('flame') + ' Current streak', streak > 0 ? streak + '-day' : '0 days — log pages today to start a streak') +
    // v536 (UX P3-15): honest empty state, matching the Current streak
    // row above — a bare '–' read as a blank/broken tile.
    kv(icon('medal') + ' Longest streak', best > 0 ? best + '-day' : 'No streak yet') +
    '</div>';
  return html;
}

function dailyStatsHTML() {
  const k = dayKey(new Date());
  const rows = [];
  let total = 0;
  library.forEach(b => {
    const p = pagesOnDay(b, k);
    if (p > 0) { total += p; rows.push({ b: b, p: p }); }
  });
  rows.sort((a, b) => b.p - a.p);
  const streak = readingStreak();
  return '<div class="stat-sub">Today</div>' +
    '<div class="dstat-card">' +
    '<div class="dstat-head"><span>' + icon('calendar') + ' ' + fmtDate(new Date().toISOString()) + '</span>' +
    (streak > 1 ? '<span class="streak">' + icon('flame') + ' ' + streak + '-day streak</span>' : '') + '</div>' +
    (rows.length
      ? '<div class="dstat-total">' + total + ' page' + (total === 1 ? '' : 's') + ' read</div>' +
        rows.map(r => {
          const es = (r.b.log || []).filter(x => x.d === k);
          const from = Math.min.apply(null, es.map(x => x.from));
          const to = Math.max.apply(null, es.map(x => x.to));
          const pct = r.b.pageCount ? ' (' + Math.round(r.p / r.b.pageCount * 100) + '%)' : '';
          return '<div class="cal-book" data-id="' + r.b.id + '">' + coverHTML(r.b) +
            '<div><h4>' + esc(r.b.title) + '</h4><p>p. ' + from + ' → p. ' + to + '</p>' +
            '<p>+' + r.p + ' pages' + pct + '</p></div></div>';
        }).join('')
      : '<p class="note">Nothing logged today yet — the pages will be here when you are. ' + icon('reading') + '</p>') +
    '</div>';
}

/* ---- reading profile (v65): per-axis intensity meters + one plain-spoken
   line about what she reaches for. Descriptive, not judgmental. ---- */
/* v454: single taste gate — replaces three separate empty-state cards.
   Shows once when fewer than 3 books are rated. */
function tasteRatedCount() {
  return library.filter(b => (b.myRating || 0) > 0).length;
}
function tasteGateNeeded() {
  return tasteRatedCount() < 3;
}
function tasteGateHTML() {
  const n = Math.min(tasteRatedCount(), 3);
  const pct = Math.round(n / 3 * 100);
  return '<div class="stat-sub">Reading profile</div>' +
    '<div class="valcard"><div class="big">Your reading profile</div>' +
    '<p class="note">Your mood, spice and reader portrait appear after 3 ratings.</p>' +
    '<div class="progress-line" style="margin:8px 0"><span class="fill" style="width:' + pct + '%"></span></div>' +
    '<div class="note">' + n + ' of 3 rated</div>' +
    '<div style="margin-top:10px"><button class="btn" data-act="rate-book">Rate a book</button></div></div>';
}
function spiceProfileHTML() {
  if (tasteGateNeeded()) return '';
  const read = library.filter(b => b.status === 'read');
  const rows = RATING_AXES.map(a => {
    const vals = read.map(b => (b.ratings || {})[a.key] || 0).filter(v => v > 0);
    return vals.length ? { a: a, avg: vals.reduce((s, v) => s + v, 0) / vals.length, n: vals.length } : null;
  }).filter(Boolean).sort((x, y) => y.n - x.n);
  if (!rows.length)
    return '<div class="stat-sub">Reading profile</div>' +
      '<p class="note">Rate the intensity axes on your books and your profile will appear here.</p>' +
      '<button class="btn" data-act="rate-book">Rate a book</button>';
  const meter = avg => {
    const f = Math.round(avg / 5 * 10);
    return '<span class="mfill">' + '█'.repeat(f) + '</span><span class="mdim">' + '░'.repeat(10 - f) + '</span>';
  };
  const spice = rows.find(r => r.a.key === 'spice');
  const line = spice
    ? (spice.avg >= 4 ? '🌶️ You tend to reach for high-spice books.'
      : spice.avg >= 2.5 ? '🌶️ Your shelf runs medium-spice overall.'
      : '🌶️ You keep things fairly low-key on the spice front.')
    : icon(rows[0].a.icon || 'pepper') + ' ' + rows[0].a.label + ' is your strongest pull.';
  return '<div class="stat-sub">Reading profile</div><div class="kv">' +
    rows.map(r => '<div class="kv-row"><span>' + icon(r.a.icon || 'pepper') + ' ' + r.a.label +
      ' <i style="font-style:normal;color:var(--faint)">· ' + r.n + '</i></span><b><span class="meter">' +
      meter(r.avg) + '</span> ' + r.avg.toFixed(1) + '</b></div>').join('') +
    '</div><p class="note">' + line + '</p>';
}

/* ---- mood profile (v405): per-axis intensity distribution. Reading
   profile shows the average pull per axis; this shows the spread — how
   many books sit in the high / medium / low band of each axis. ---- */
function moodProfileHTML() {
  if (tasteGateNeeded()) return '';
  const read = library.filter(b => b.status === 'read');
  const axes = RATING_AXES.map(a => {
    const vals = read.map(b => (b.ratings || {})[a.key] || 0).filter(v => v > 0);
    if (!vals.length) return null;
    return {
      a: a, n: vals.length,
      hi: vals.filter(v => v >= 4).length,
      mid: vals.filter(v => v === 2 || v === 3).length,
      lo: vals.filter(v => v <= 1).length,
    };
  }).filter(Boolean).sort((x, y) => y.n - x.n).slice(0, 6);
  if (!axes.length)
    return '<div class="stat-sub">Mood profile</div>' +
      '<p class="note">Rate the intensity axes on your books and your mood breakdown will appear here.</p>' +
      '<button class="btn" data-act="rate-book">Rate a book</button>';
  const blocks = axes.map(x => {
    const max = Math.max(x.hi, x.mid, x.lo, 1);
    const row = (lbl, n) =>
      '<div class="dist-row"><span class="lbl">' + lbl + '</span>' +
      '<div class="bar"><div class="fill" style="width:' + Math.round(n / max * 100) +
      '%;background:' + x.a.color + '"></div></div><span class="num">' + n + '</span></div>';
    return '<div style="margin-bottom:14px"><div style="font-size:13px;font-weight:600;margin-bottom:2px">' +
      icon(x.a.icon || 'pepper') + ' ' + esc(x.a.label) +
      ' <i style="font-style:normal;color:var(--faint);font-weight:400">· ' + x.n + '</i></div>' +
      '<div class="dist">' + row('High', x.hi) + row('Med', x.mid) + row('Low', x.lo) + '</div></div>';
  }).join('');
  // plain-spoken line: axis with the biggest high-band share
  const top = axes.slice().sort((p, q) => (q.hi / q.n) - (p.hi / p.n))[0];
  const line = top && top.hi / top.n >= 0.5
    ? 'Most of your books lean high-' + top.a.label.toLowerCase() + '.'
    : 'Your moods are mixed — no single intensity dominates.';
  return '<div class="stat-sub">Mood profile</div>' + blocks +
    '<p class="note">' + line + '</p>';
}

/* ---- rating distribution (v65): histogram + the interesting read ---- */
function ratingDistHTML() {
  const read = library.filter(b => b.status === 'read' && (b.myRating || 0) > 0);
  if (!read.length)
    return '<div class="stat-sub">Ratings</div>' +
      '<p class="note">Rate your finished books and the distribution will show up here.</p>';
  const bins = [0, 0, 0, 0, 0];
  read.forEach(b => { bins[Math.min(5, Math.max(1, Math.round(b.myRating))) - 1]++; });
  const max = Math.max.apply(null, bins.concat([1]));
  const avg = read.reduce((s, b) => s + b.myRating, 0) / read.length;
  const fiveShare = bins[4] / read.length;
  const rows = [5, 4, 3, 2, 1].map(s =>
    '<div class="dist-row"><span class="lbl">' + s + ' ⭐</span>' +
    '<div class="bar"><div class="fill" style="width:' + Math.round(bins[s - 1] / max * 100) +
    '%;background:var(--gold)"></div></div>' +
    '<span class="num">' + bins[s - 1] + '</span></div>').join('');
  const take = fiveShare >= 0.2
    ? 'You finish books you like — 5-star reads make up <b style="color:var(--ink)">' +
      Math.round(fiveShare * 100) + '%</b> of your completed books.'
    : avg >= 4 ? 'A generous rater — your average sits at <b style="color:var(--ink)">' + avg.toFixed(2) + ' ⭐</b>.'
    : avg < 3 ? 'A tough critic — your average is <b style="color:var(--ink)">' + avg.toFixed(2) + ' ⭐</b>.'
    : 'Your average rating: <b style="color:var(--ink)">' + avg.toFixed(2) + ' ⭐</b>.';
  return '<div class="stat-sub">Ratings</div><div class="dist">' + rows + '</div>' +
    '<p class="note">' + take + '</p>';
}

/* ---- reading patterns (v65): calculated observations, each gated on enough
   data to mean something. No AI — just her library talking back. ---- */
// Batch 4 (issue #146): the genre-gap bar was 0.15★ — below display precision
// (a 0.15 gap renders as "0.1–0.2 ⭐ higher"), so it presented noise as a
// calculated observation. Raised to 0.5 (User's call, 2026-10-12: raise
// slightly, verify against real data, iterate upward until it's signal).
// If real-data review shows this still fires on noise, raise GENRE_GAP_MIN
// further — it's the one knob.
const GENRE_GAP_MIN = 0.5;
function patternObservations() {
  const obs = [];
  const read = library.filter(b => b.status === 'read');
  const rated = read.filter(b => (b.myRating || 0) > 0);
  const avgOf = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

  // genre rating gap
  const byGenre = {};
  rated.forEach(b => bookGenres(b).forEach(g => { (byGenre[g] = byGenre[g] || []).push(b.myRating); }));
  const gk = Object.keys(byGenre).filter(g => byGenre[g].length >= 3)
    .sort((a, b) => byGenre[b].length - byGenre[a].length).slice(0, 2);
  if (gk.length === 2) {
    const a1 = avgOf(byGenre[gk[0]]), a2 = avgOf(byGenre[gk[1]]);
    const gap = Math.abs(a1 - a2);
    if (gap >= GENRE_GAP_MIN) {
      const hi = a1 >= a2 ? gk[0] : gk[1], lo = a1 >= a2 ? gk[1] : gk[0];
      obs.push('You rate <b>' + esc(hi) + '</b> books ' + gap.toFixed(1) + ' ⭐ higher than <b>' + esc(lo) + '</b> books.');
    }
  }

  // highest-rated books' average length
  const top = rated.filter(b => b.myRating >= 4.5 && (b.pageCount || 0) > 0);
  if (top.length >= 3)
    obs.push('Your highest-rated books average <b>' + Math.round(avgOf(top.map(b => b.pageCount))) + ' pages</b>.');

  // finish likelihood by length bucket
  const buckets = [['under 250', 0, 249], ['250–450', 250, 450], ['451–650', 451, 650], ['over 650', 651, Infinity]];
  const done = library.filter(b => (b.status === 'read' || b.status === 'dnf') && (b.pageCount || 0) > 0);
  const rates = buckets.map(bk => {
    const bs = done.filter(b => b.pageCount >= bk[1] && b.pageCount <= bk[2]);
    return bs.length >= 3 ? { label: bk[0], rate: bs.filter(b => b.status === 'read').length / bs.length } : null;
  }).filter(Boolean);
  if (rates.length >= 2) {
    const best = rates.slice().sort((a, b) => b.rate - a.rate)[0];
    if (best.rate >= 0.6)
      obs.push('You\'re most likely to finish books between <b>' + best.label + ' pages</b>.');
  }

  // rating trend: last 6 months vs prior 6
  const now = Date.now(), M = 30.44 * 864e5;
  const finAge = b => b.dateFinished ? now - new Date(b.dateFinished).getTime() : Infinity;
  const recent = rated.filter(b => finAge(b) < 6 * M);
  const prior = rated.filter(b => finAge(b) >= 6 * M && finAge(b) < 12 * M);
  if (recent.length >= 2 && prior.length >= 2) {
    const r = avgOf(recent.map(b => b.myRating)), p = avgOf(prior.map(b => b.myRating));
    if (Math.abs(r - p) >= 0.2)
      obs.push('Your average rating has ' + (r > p ? 'risen' : 'dipped') + ' from <b>' +
        p.toFixed(1) + ' ⭐</b> to <b>' + r.toFixed(1) + ' ⭐</b> over the last 6 months.');
  }

  // v405: pace shift — trailing 30 days vs the 30 before that
  // Batch 4 (issue #145): was 60 days × every book × pagesOnDay — two
  // pagesInRange() passes over the same windows (cur = today-29..today,
  // prev = today-59..today-30, matching the old i<30 / i>=30 split).
  {
    const today = new Date();
    const curStart = new Date(today); curStart.setDate(today.getDate() - 29);
    const prevStart = new Date(today); prevStart.setDate(today.getDate() - 59);
    const prevEnd = new Date(today); prevEnd.setDate(today.getDate() - 30);
    const cur = pagesInRange(dayKey(curStart), dayKey(today));
    const prev = pagesInRange(dayKey(prevStart), dayKey(prevEnd));
    if (cur >= 50 && prev >= 50) {
      const ratio = cur / prev;
      const prevMonth = new Date(today);
      prevMonth.setDate(today.getDate() - 30);
      const mName = prevMonth.toLocaleDateString(undefined, { month: 'long' });
      if (ratio >= 1.5)
        obs.push('You\'re reading <b>' + ratio.toFixed(1) + '×</b> your ' + esc(mName) + ' pace — ' +
          Math.round(cur / 30) + ' pages/day vs ' + Math.round(prev / 30) + '.');
      else if (ratio <= 0.67)
        obs.push('Your pace has eased to <b>' + Math.round(ratio * 100) + '%</b> of ' + esc(mName) +
          ' — ' + Math.round(cur / 30) + ' pages/day vs ' + Math.round(prev / 30) + '.');
    }
  }

  // v405: comfort genre — genre with the biggest share of finished books
  {
    const gCount = {};
    read.forEach(b => bookGenres(b).forEach(g => { gCount[g] = (gCount[g] || 0) + 1; }));
    const top = Object.keys(gCount).sort((a, b) => gCount[b] - gCount[a])[0];
    if (top && gCount[top] >= 3 && read.length >= 5) {
      const share = Math.round(gCount[top] / read.length * 100);
      if (share >= 30)
        obs.push('<b>' + esc(top) + '</b> is your comfort genre — <b>' + share + '%</b> of your finished books.');
    }
  }

  // v405: late DNFs — share of DNFs abandoned after the halfway mark
  {
    const dnfs = library.filter(b => b.status === 'dnf' && typeof b.dnfProgressPct === 'number');
    if (dnfs.length >= 3) {
      const late = dnfs.filter(b => b.dnfProgressPct >= 50).length;
      const share = Math.round(late / dnfs.length * 100);
      if (share >= 50)
        obs.push('You DNF <b>' + share + '%</b> of books after the halfway mark — trust your gut earlier?');
    }
  }

  if (!obs.length) return [];
  return obs;
}
function patternsHTML() {
  if (tasteGateNeeded()) return '';
  const obs = patternObservations();
  if (!obs.length)
    return '<div class="stat-sub">' + icon('crystal') + ' Reading patterns</div>' +
      '<p class="note">Finish and rate a few more books and your patterns will start showing here.</p>' +
      '<button class="btn" data-act="rate-book">Rate a book</button>';
  return '<div class="stat-sub">' + icon('crystal') + ' Reading patterns</div><div class="patterns">' +
    obs.slice(0, 6).map(o => '<div class="pattern"><span class="pi">' + icon('bulb') + '</span><p>' + o + '</p></div>').join('') +
    '</div>';
}

/* ---- genre evolution (v69): how her genre mix shifts over time, with
   year / quarter / month views. Stacked shares per period from finish
   dates; one deterministic observation, everything gated on enough data. ---- */
function genreEvoHTML() {
  const gran = genreGran;
  const keyOf = d => gran === 'year' ? String(d.getFullYear())
    : gran === 'quarter' ? d.getFullYear() + '-Q' + (Math.floor(d.getMonth() / 3) + 1)
    : d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const labelOf = k => gran === 'year' ? k
    : gran === 'quarter' ? 'Q' + k.slice(6) + ' \u2019' + k.slice(2, 4)
    : MONTHS[parseInt(k.slice(5), 10) - 1].slice(0, 3) + ' \u2019' + k.slice(2, 4);
  const N = gran === 'year' ? 6 : gran === 'quarter' ? 8 : 12;
  const keys = [];
  const c = new Date(); c.setDate(1); c.setHours(12, 0, 0, 0);
  for (let i = 0; i < N; i++) {
    keys.unshift(keyOf(c));
    if (gran === 'year') c.setFullYear(c.getFullYear() - 1);
    else if (gran === 'quarter') c.setMonth(c.getMonth() - 3);
    else c.setMonth(c.getMonth() - 1);
  }
  const per = {};
  keys.forEach(k => { per[k] = []; });
  const now = Date.now();
  library.forEach(b => {
    if (b.status !== 'read' || !b.dateFinished) return;
    const t = new Date(b.dateFinished).getTime();
    if (!t || t > now) return;
    const k = keyOf(new Date(b.dateFinished));
    if (per[k]) per[k].push(b);
  });
  const nonEmpty = keys.filter(k => per[k].length > 0);
  const granBtns = [['year', icon('calendar') + ' Year'], ['quarter', icon('calendar') + ' Quarter'], ['month', icon('calendar') + ' Month']]
    .map(([g, l]) => '<button data-g="' + g + '" class="' + (gran === g ? 'active' : '') + '">' + l + '</button>').join('');
  const head = '<div class="stat-sub">' + icon('chart') + ' Genre evolution</div>' +
    '<div class="seg" id="evo-gran" style="margin-bottom:10px">' + granBtns + '</div>';
  if (nonEmpty.length < 2)
    return head + '<p class="note">Finish books across at least two ' +
      (gran === 'year' ? 'years' : gran === 'quarter' ? 'quarters' : 'months') +
      ' and your genre evolution will appear here.</p>';

  // top genres across the window (primary genre per book); the rest -> Other
  const totals = {};
  nonEmpty.forEach(k => per[k].forEach(b => {
    const g = bookGenres(b)[0] || 'Other';
    totals[g] = (totals[g] || 0) + 1;
  }));
  const topG = topEntries(totals, 5).map(e => e[0]);
  const PAL = ['#e5648e', '#6aa8e5', '#e5b86a', '#8fd18f', '#b48ce5'];
  const colorOf = g => {
    const i = topG.indexOf(g);
    return i >= 0 ? PAL[i] : '#5a5a6e'; // Other
  };
  const catOf = g => topG.includes(g) ? g : 'Other';

  const rows = nonEmpty.map(k => {
    const bs = per[k];
    const counts = {};
    bs.forEach(b => { const g = catOf(bookGenres(b)[0] || 'Other'); counts[g] = (counts[g] || 0) + 1; });
    const order = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const segs = order.map(g =>
      '<div class="evo-seg" title="' + esc(g) + ': ' + counts[g] + '" style="width:' +
      (counts[g] / bs.length * 100).toFixed(1) + '%;background:' + colorOf(g) + '"></div>').join('');
    return '<div class="evo-row"><span class="evo-lbl">' + labelOf(k) + '</span>' +
      '<div class="evo-bar">' + segs + '</div>' +
      '<span class="evo-n">' + bs.length + '</span></div>';
  }).join('');
  const legend = topG.map(g =>
    '<span><span class="evo-dot" style="background:' + colorOf(g) + '"></span>' + esc(g) + '</span>').join('') +
    (Object.keys(totals).length > topG.length
      ? '<span><span class="evo-dot" style="background:#5a5a6e"></span>Other</span>' : '');

  // one deterministic observation: biggest share swing, first vs last period
  let note = '';
  const first = per[nonEmpty[0]], last = per[nonEmpty[nonEmpty.length - 1]];
  if (first.length >= 3 && last.length >= 3) {
    const share = bs => {
      const m = {};
      bs.forEach(b => { const g = catOf(bookGenres(b)[0] || 'Other'); m[g] = (m[g] || 0) + 1; });
      Object.keys(m).forEach(g => { m[g] /= bs.length; });
      return m;
    };
    const s0 = share(first), s1 = share(last);
    let best = null, bestSwing = 0;
    new Set([...Object.keys(s0), ...Object.keys(s1)]).forEach(g => {
      const sw = (s1[g] || 0) - (s0[g] || 0);
      if (Math.abs(sw) > Math.abs(bestSwing) ||
          (Math.abs(sw) === Math.abs(bestSwing) && sw > bestSwing)) { bestSwing = sw; best = g; }
    });
    if (best && Math.abs(bestSwing) >= 0.15)
      note = '<p class="note">' + icon('bulb') + ' <b>' + esc(best) + '</b> went from <b>' +
        Math.round((s0[best] || 0) * 100) + '%</b> to <b>' + Math.round((s1[best] || 0) * 100) +
        '%</b> of your finishes between ' + labelOf(nonEmpty[0]) + ' and ' +
        labelOf(nonEmpty[nonEmpty.length - 1]) + '.</p>';
  }
  return head + '<div class="evo">' + rows + '</div>' +
    '<div class="evo-legend">' + legend + '</div>' + note;
}

/* ---- personal records (v66): the fun achievements wall. Every card taps
   through to the book; Biggest day jumps to that day in the calendar. ---- */
function recordsHTML() {
  const read = library.filter(b => b.status === 'read');
  const withPages = read.filter(b => (b.pageCount || 0) > 0);
  const rated = read.filter(b => (b.myRating || 0) > 0);
  const spiced = read.filter(b => ((b.ratings || {}).spice || 0) > 0);
  const cards = [];
  const card = (icon, label, b, stat) => {
    if (!b) return;
    // v454 Part 2: row layout — portrait cover left, label/title/value right
    cards.push('<div class="record-row" data-id="' + esc(b.id) + '">' + coverHTML(b, 'rec-cov') +
      '<div class="rmeta"><div class="rlbl">' + icon + ' ' + label + '</div>' +
      '<div class="rtitle">' + esc(b.title) + '</div>' +
      '<div class="rstat">' + stat + '</div></div></div>');
  };
  if (withPages.length) {
    const s = withPages.slice().sort((a, b) => b.pageCount - a.pageCount);
    card(icon('covers'), 'Longest', s[0], fmtBig(s[0].pageCount) + ' pages');
    card(icon('covers'), 'Shortest', s[s.length - 1], fmtBig(s[s.length - 1].pageCount) + ' pages');
  }
  if (rated.length) {
    const s = rated.slice().sort((a, b) =>
      b.myRating - a.myRating || String(b.dateFinished || '').localeCompare(String(a.dateFinished || '')));
    card(icon('heart'), 'Highest rated', s[0], '♥ ' + s[0].myRating.toFixed(1) + ' / 5');
    card(icon('heart'), 'Lowest rated', s[s.length - 1], '♥ ' + s[s.length - 1].myRating.toFixed(1) + ' / 5');
  } else if (read.length) {
    // v536 (UX P3-15): read books exist but none are rated — the rated
    // pair used to vanish silently while its sibling cards rendered,
    // reading as blank tiles. Say so honestly instead.
    cards.push('<div class="record-row"><div class="rmeta"><div class="rlbl">' + icon('heart') + ' Highest &amp; lowest rated</div>' +
      '<div class="rtitle">No ratings yet</div>' +
      '<div class="rstat">Rate a finished book and your highest and lowest will land here.</div></div></div>');
  }
  if (spiced.length) {
    const s = spiced.slice().sort((a, b) => b.ratings.spice - a.ratings.spice);
    card(icon('pepper'), 'Spiciest', s[0], icon('pepper') + ' ' + s[0].ratings.spice + ' / 5');
  }
  const bd = biggestDay();
  if (bd) cards.push('<div class="record-card" id="bigday" data-day="' + bd.k + '"><div class="rlbl">' + icon('doc') + ' Biggest day</div>' +
    '<div class="bigday-num">' + bd.pages + '</div>' +
    '<div class="rtitle">' + fmtDate(new Date(bd.k + 'T12:00:00').toISOString()) + '</div>' +
    '<div class="rstat">' + bd.pages + ' pages · ' + bd.n + ' session' + (bd.n === 1 ? '' : 's') + '</div></div>');
  if (!cards.length)
    return '<div class="stat-sub">' + icon('trophy') + ' Personal records</div>' +
      '<p class="note">Finish some books and your records will land here.</p>';
  return '<div class="stat-sub">' + icon('trophy') + ' Personal records</div><div class="records">' + cards.join('') + '</div>';
}

/* ---- series statistics (v66): books read per series + next-up from her
   TBR. No totals exist in the metadata, so progress is stated honestly. ---- */
function seriesHTML() {
  const byName = {};
  library.forEach(b => {
    const sn = b.series && b.series.name;
    if (sn) (byName[sn] = byName[sn] || []).push(b);
  });
  // v400: hide 0-progress series and single-book "series" (not real series)
  const names = Object.keys(byName)
    .filter(sn => {
      const books = byName[sn];
      if (books.length < 2) return false; // single book isn't a series
      const readN = books.filter(b => b.status === 'read').length;
      return readN > 0; // hide 0-progress
    })
    .sort((a, b) => byName[b].length - byName[a].length);
  if (!names.length)
    return '<div class="stat-sub">' + icon('series') + ' Series</div>' +
      '<p class="note">Books with series info will group here.</p>';
  const rows = names.slice(0, 10).map(sn => {
    const books = byName[sn];
    const readN = books.filter(b => b.status === 'read').length;
    // v403: "Next up" should be the next UNREAD book, not one already being read.
    // Prefer TBR books; if currently reading one, suggest the next after it.
    const sorted = books.slice().sort((a, b) =>
      ((a.series && a.series.position) || 99) - ((b.series && b.series.position) || 99));
    const currentlyReading = sorted.find(b => b.status === 'reading');
    let next;
    if (currentlyReading) {
      const idx = sorted.indexOf(currentlyReading);
      next = sorted.slice(idx + 1).find(b => b.status === 'tbr');
    } else {
      next = sorted.find(b => b.status === 'tbr');
    }
    // Fallback: if no TBR, show the earliest non-read/non-dnf (old behavior)
    if (!next) {
      next = sorted.find(b => b.status !== 'read' && b.status !== 'dnf');
    }
    return '<div class="series-row"><div class="sinfo"><span class="sname">' + esc(sn) + '</span>' +
      '<span class="scount">' + readN + ' read</span></div>' +
      (next ? '<div class="snext">Next up: <button class="taplink" data-id="' + next.id + '">' +
        esc(next.title) + '</button></div>' : '') + '</div>';
  }).join('');
  return '<div class="stat-sub">' + icon('series') + ' Series</div><div class="series-list">' + rows + '</div>' +
    '<button class="btn ghost sm" id="sr-all">View all ' + names.length + ' series →</button>';
}

/* ---- Your Year in Books (v70): a Wrapped-style visual summary of the year,
   with share-as-image (1080x1920 story format) and copy-as-text export. ---- */
let yibYear = new Date().getFullYear();

function yearInBooksYears() {
  const yrs = new Set([new Date().getFullYear()]);
  library.forEach(b => {
    if (b.status === 'read' && b.dateFinished) yrs.add(new Date(b.dateFinished).getFullYear());
  });
  return [...yrs].sort((a, b) => b - a);
}

function yearInBooksData(yr) {
  yr = yr || yibYear;
  const readYr = library.filter(b => b.status === 'read' && b.dateFinished &&
    new Date(b.dateFinished).getFullYear() === yr);
  const pages = pagesInYear(yr); // v427: sum logs, not pageCount (issue #53)
  const rated = readYr.filter(b => (b.myRating || 0) > 0);
  const avg = rated.length ? rated.reduce((s, b) => s + b.myRating, 0) / rated.length : null;
  const byGenre = {};
  readYr.forEach(b => { const g = bookGenres(b)[0] || 'Other'; byGenre[g] = (byGenre[g] || 0) + 1; });
  const topGenres = topEntries(byGenre, 3);
  const topBooks = rated.slice().sort((a, b) => b.myRating - a.myRating).slice(0, 5);
  const withPages = readYr.filter(b => (b.pageCount || 0) > 0);
  const longest = withPages.slice().sort((a, b) => b.pageCount - a.pageCount)[0] || null;
  const byAuthor = {};
  readYr.forEach(b => { const a = (b.authors || [])[0] || 'Unknown'; byAuthor[a] = (byAuthor[a] || 0) + 1; });
  const topAuthor = Object.entries(byAuthor).sort((a, b) => b[1] - a[1])[0] || null;
  const dayPages = {}, daySet = new Set();
  readYr.forEach(b => {
    (b.log || []).forEach(e => {
      if (e.to > e.from && String(e.d || '').slice(0, 4) === String(yr)) {
        dayPages[e.d] = (dayPages[e.d] || 0) + (e.to - e.from);
        daySet.add(e.d);
      }
    });
    if (b.dateFinished) daySet.add(dayKey(new Date(b.dateFinished)));
  });
  const big = Object.entries(dayPages).sort((a, b) => b[1] - a[1])[0] || null;
  // longest streak scoped to this year (UTC day math, DST-proof)
  const dayNums = [...daySet].map(k => {
    const p = k.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }).sort((a, b) => a - b);
  let streak = 0, run = 0, prev = null;
  dayNums.forEach(t => {
    run = (prev !== null && t - prev === 86400000) ? run + 1 : 1;
    if (run > streak) streak = run;
    prev = t;
  });
  return {
    yr, n: readYr.length, pages, avg, topGenres, topBooks, longest, topAuthor,
    days: daySet.size, streak,
    bigDay: big ? { k: big[0], pages: big[1] } : null,
    five: rated.filter(b => b.myRating >= 4.5).length
  };
}

function renderYearInBooks(yr) {
  const years = yearInBooksYears();
  yibYear = (yr != null && years.includes(yr)) ? yr : (years.includes(yibYear) ? yibYear : years[0]);
  const d = yearInBooksData();
  const back = '<button class="btn ghost" id="yib-back" style="margin-bottom:4px">← Chronicles</button>';
  const pills = '<div class="chips" id="yib-years" style="margin:8px 0">' +
    years.map(y => '<button class="chip' + (y === yibYear ? ' active' : '') + '" data-yr="' + y + '">' + y + '</button>').join('') +
    '</div>';
  if (!d.n) {
    setView(back + pills + '<div class="yib-hero"><div class="yib-kicker">Cozy Libram</div>' +
      '<h2 class="serif">Your ' + d.yr + ' <em>in Books</em></h2></div>' +
      '<p class="note" style="text-align:center">No finished books in ' + d.yr +
      ' yet — your wrapped summary will appear here.</p>');
    document.getElementById('yib-back').addEventListener('click', renderStats);
    document.querySelectorAll('#yib-years .chip').forEach(c =>
      c.addEventListener('click', () => renderYearInBooks(+c.dataset.yr)));
    return;
  }
  const stat = (n, l) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
  const gcols = ['#e5648e', '#6aa8e5', '#e5b86a'];
  const maxG = Math.max(1, ...d.topGenres.map(g => g[1]));
  const genres = d.topGenres.map(([g, n], i) =>
    '<div class="dist-row"><span class="lbl">' + esc(g) + '</span>' +
    '<div class="bar"><div class="fill" style="width:' + Math.round(n / maxG * 100) +
    '%;background:' + gcols[i] + '"></div></div>' +
    '<span class="num">' + n + '</span></div>').join('');
  const books = d.topBooks.map((b, i) =>
    '<div class="book-card" data-id="' + esc(b.id) + '">' + coverHTML(b) +
    '<div class="book-meta"><h3>#' + (i + 1) + ' ' + esc(b.title) + '</h3>' +
    '<p class="author">' + esc(displayAuthors(b.authors)) + ' · ♥ ' + b.myRating.toFixed(1) + '</p>' +
    '</div></div>').join('');
  const recs = [];
  if (d.longest) recs.push(stat(fmtBig(d.longest.pageCount), icon('covers') + ' Longest: ' + esc(d.longest.title.slice(0, 22))));
  if (d.bigDay) recs.push(stat(d.bigDay.pages, icon('doc') + ' Biggest day'));
  if (d.topAuthor) recs.push(stat(d.topAuthor[1] + ' ' + icon('series'), icon('pencil') + ' ' + esc(d.topAuthor[0].slice(0, 22))));
  if (d.five) recs.push(stat('♥ ' + d.five, '5-star reads'));
  setView(back + pills +
    '<div class="yib-hero"><div class="yib-kicker">Cozy Libram</div>' +
    '<h2 class="serif">Your ' + d.yr + ' <em>in Books</em></h2>' +
    '<div class="yib-sub">' + d.n + ' books · ' + fmtBig(d.pages) + ' pages · ' + d.days + ' reading days</div></div>' +
    '<div class="search-row" style="margin:12px 0"><button class="btn" id="yib-share">' + icon('share') + ' Share image</button>' +
    '<button class="btn ghost" id="yib-copy">' + icon('copy') + ' Copy text</button></div>' +
    // v224 (UX-03): the stat-row that sat here duplicated the hero's yib-sub
    // line above ("N books · M pages · N reading days") — removed. The "Year
    // records" stat-row further down stays.
    (genres ? '<div class="stat-sub yib-sec">Top genres</div><div class="dist">' + genres + '</div>' : '') +
    (books ? '<div class="stat-sub yib-sec">Highest rated</div><div class="now-reading">' + books + '</div>' : '') +
    (recs.length ? '<div class="stat-sub yib-sec">Year records</div><div class="stat-row">' + recs.join('') + '</div>' : ''));
  document.getElementById('yib-back').addEventListener('click', renderStats);
  document.querySelectorAll('#yib-years .chip').forEach(c =>
    c.addEventListener('click', () => renderYearInBooks(+c.dataset.yr)));
  document.getElementById('yib-share').addEventListener('click', shareYearImage);
  document.getElementById('yib-copy').addEventListener('click', copyYearSummary);

  document.querySelectorAll('.now-reading .book-card').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
}

function drawYearImage(d) {
  const W = 1080, H = 1920;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  if (!x) return null;
  const ink = '#f6eff8', mut = '#b9a8c6', acc = '#e5648e';
  const bg = x.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2b1535'); bg.addColorStop(1, '#120a18');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  x.textAlign = 'center';
  try { x.letterSpacing = '14px'; } catch (e) {}
  x.fillStyle = mut; x.font = '40px system-ui, sans-serif';
  x.fillText('COZY LIBRAM', W / 2, 150);
  try { x.letterSpacing = '0px'; } catch (e) {}
  x.fillStyle = ink; x.font = 'bold 118px Georgia, serif';
  x.fillText('My ' + d.yr, W / 2, 300);
  x.fillStyle = acc; x.font = 'italic 108px Georgia, serif';
  x.fillText('in Books', W / 2, 425);
  x.strokeStyle = 'rgba(229,100,142,.4)'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(140, 490); x.lineTo(W - 140, 490); x.stroke();
  const stats = [
    [String(d.n), 'books read'],
    [d.pages > 999 ? (d.pages / 1000).toFixed(1) + 'k' : String(d.pages), 'pages'],
    [d.avg != null ? d.avg.toFixed(1) + ' ♥' : '–', 'avg rating'],
    [d.streak > 0 ? '🔥 ' + d.streak : '–', 'day streak']
  ];
  stats.forEach(([n, l], i) => {
    const cx = i % 2 ? W * 0.75 : W * 0.25, cy = i < 2 ? 650 : 890;
    x.fillStyle = ink; x.font = 'bold 100px Georgia, serif';
    x.fillText(n, cx, cy);
    x.fillStyle = mut; x.font = '36px system-ui, sans-serif';
    x.fillText(l, cx, cy + 58);
  });
  x.textAlign = 'left';
  if (d.topGenres.length) {
    x.fillStyle = mut; x.font = '36px system-ui, sans-serif';
    x.fillText('TOP GENRES', 90, 1065);
    const gc = ['#e5648e', '#6aa8e5', '#e5b86a'];
    d.topGenres.forEach(([gg, n], i) => {
      const y = 1135 + i * 100;
      x.fillStyle = ink; x.font = '44px system-ui, sans-serif';
      x.fillText(gg.length > 14 ? gg.slice(0, 13) + '…' : gg, 90, y);
      x.fillStyle = gc[i];
      x.fillRect(400, y - 32, Math.max(8, 420 * n / Math.max(1, d.topGenres[0][1])), 40);
      x.fillStyle = mut; x.font = '40px system-ui, sans-serif';
      x.fillText(n + (n === 1 ? ' book' : ' books'), 850, y);
    });
  }
  if (d.topBooks.length) {
    x.fillStyle = mut; x.font = '36px system-ui, sans-serif';
    x.fillText('HIGHEST RATED', 90, 1485);
    x.fillStyle = ink; x.font = '40px system-ui, sans-serif';
    d.topBooks.forEach((b, i) => {
      let t = (i + 1) + '. ' + b.title;
      if (t.length > 40) t = t.slice(0, 39) + '…';
      x.fillText(t, 90, 1555 + i * 66);
    });
  }
  x.textAlign = 'center'; x.fillStyle = mut; x.font = '36px system-ui, sans-serif';
  x.fillText('Tracked with Cozy Libram 🌶️🖤', W / 2, 1845);
  return cv;
}

function shareYearImage() {
  const cv = drawYearImage(yearInBooksData());
  shareCanvasFile(cv, 'my-' + yibYear + '-in-books.png', 'My Year in Books');
}

/* ---- Shareable book cards (v73): 1080x1920 story-format cards per book. ---- */
function cvRoundRect(x, X, Y, W, H, R) {
  x.beginPath();
  x.moveTo(X + R, Y);
  x.arcTo(X + W, Y, X + W, Y + H, R);
  x.arcTo(X + W, Y + H, X, Y + H, R);
  x.arcTo(X, Y + H, X, Y, R);
  x.arcTo(X, Y, X + W, Y, R);
  x.closePath();
}
function cvWrap(x, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach(w => {
    const t = line ? line + ' ' + w : w;
    if (line && x.measureText(t).width > maxW) { lines.push(line); line = w; }
    else line = t;
  });
  if (line) lines.push(line);
  return lines;
}
function loadCoverImage(url) {
  return new Promise(resolve => {
    let done = false;
    const fin = (img) => { if (!done) { done = true; resolve(img); } };
    if (!url) return fin(null);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => fin(img);
      img.onerror = () => fin(null);
      img.src = url;
      setTimeout(() => fin(null), 8000);
    } catch (e) { fin(null); }
  });
}
function shareCanvasFile(cv, name, title) {
  if (!cv || !cv.toBlob) { toast('Image export isn’t supported on this device'); return; }
  cv.toBlob(async (blob) => {
    if (!blob) { toast('Could not create the image'); return; }
    // v559: the hand-off itself lives in shareOrDownloadFile (js/050);
    // the 'Image saved' toast belongs to the download outcome only, as before.
    const how = await shareOrDownloadFile({ blob: blob, filename: name, title: title });
    if (how === 'downloaded') toast('Image saved 📥');
  }, 'image/png');
}
async function drawBookCard(b) {
  const W = 1080, H = 1920;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const x = cv.getContext('2d');
  if (!x) return null;
  const ink = '#f6eff8', mut = '#b9a8c6', acc = '#e5648e', gold = '#e5b86a';
  const img = await loadCoverImage(b.cover);
  // paint() draws the whole card; withCover=false is the taint fallback when a
  // remote cover isn't CORS-clean (tainted canvases can't export).
  const paint = (withCover) => {
    const bg = x.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#2b1535'); bg.addColorStop(1, '#100a16');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    const glow = x.createRadialGradient(W / 2, 320, 40, W / 2, 320, 720);
    glow.addColorStop(0, 'rgba(229,100,142,.20)'); glow.addColorStop(1, 'rgba(229,100,142,0)');
    x.fillStyle = glow; x.fillRect(0, 0, W, H);
    x.textAlign = 'center';
    try { x.letterSpacing = '14px'; } catch (e) {}
    x.fillStyle = mut; x.font = '40px system-ui, sans-serif';
    x.fillText('COZY LIBRAM', W / 2, 140);
    try { x.letterSpacing = '0px'; } catch (e) {}
    let y;
    if (withCover && img) {
      const cw = 620, ch = 930, cx = (W - cw) / 2, cy = 200;
      x.save();
      x.shadowColor = 'rgba(0,0,0,.55)'; x.shadowBlur = 60; x.shadowOffsetY = 24;
      cvRoundRect(x, cx, cy, cw, ch, 28);
      x.clip();
      const s = Math.max(cw / img.width, ch / img.height);
      const dw = img.width * s, dh = img.height * s;
      x.drawImage(img, cx - (dw - cw) / 2, cy - (dh - ch) / 2, dw, dh);
      x.restore();
      y = cy + ch + 96;
    } else {
      x.fillStyle = 'rgba(229,100,142,.16)'; x.font = '300px Georgia, serif';
      x.fillText('❝', W / 2, 580);
      y = 730;
    }
    x.fillStyle = ink; x.font = 'bold 72px Georgia, serif';
    cvWrap(x, b.title, W - 180).slice(0, 3).forEach(t => { x.fillText(t, W / 2, y); y += 88; });
    const au = (b.authors || []).join(', ') || 'Unknown author';
    x.fillStyle = mut; x.font = '44px system-ui, sans-serif';
    cvWrap(x, au, W - 220).slice(0, 2).forEach(t => { x.fillText(t, W / 2, y); y += 58; });
    y += 34;
    if (b.series && b.series.name) {
      x.fillStyle = acc; x.font = '40px system-ui, sans-serif';
      let sl = '📚 ' + b.series.name +
        ((b.series.position != null && b.series.position !== '') ? ' · Book ' + b.series.position : '');
      if (sl.length > 44) sl = sl.slice(0, 43) + '…';
      x.fillText(sl, W / 2, y); y += 72;
    }
    const bits = [];
    if ((b.myRating || 0) > 0) bits.push('♥ ' + Number(b.myRating).toFixed(1));
    const spice = (b.ratings && b.ratings.spice) || 0;
    if (spice > 0) bits.push('🌶️'.repeat(Math.min(5, Math.round(spice))));
    if (bits.length) {
      x.fillStyle = gold; x.font = '48px system-ui, sans-serif';
      x.fillText(bits.join('   '), W / 2, y); y += 84;
    }
    x.fillStyle = ink; x.font = '44px system-ui, sans-serif';
    if (b.status === 'reading' && b.pageCount) {
      const pct = Math.min(100, Math.round((b.progress || 0) / b.pageCount * 100));
      x.fillText('📘 ' + pct + '% · page ' + (b.progress || 0) + ' of ' + b.pageCount, W / 2, y);
      y += 42;
      const bw = 560, bx = (W - bw) / 2;
      x.fillStyle = 'rgba(255,255,255,.14)';
      cvRoundRect(x, bx, y, bw, 26, 13); x.fill();
      if (pct > 0) {
        x.fillStyle = acc;
        cvRoundRect(x, bx, y, Math.max(26, bw * pct / 100), 26, 13); x.fill();
      }
      y += 64;
    } else if (b.status === 'read') {
      x.fillText('✅ Finished' + (b.dateFinished ? ' · ' + fmtDate(b.dateFinished) : ''), W / 2, y); y += 72;
    } else if (isWishlistBook(b)) {
      // v559: checked before plain tbr so a wishlist book keeps its
      // 🎁 line on the share card instead of the generic TBR line.
      x.fillText('🎁 On my wishlist', W / 2, y); y += 72;
    } else if (b.status === 'tbr') {
      x.fillText('📖 On my TBR', W / 2, y); y += 72;
    } else if (b.status === 'dnf') {
      x.fillText('🚫 DNF', W / 2, y); y += 72;
    }
    x.fillStyle = mut; x.font = '36px system-ui, sans-serif';
    x.fillText('Tracked with Cozy Libram 🌶️🖤', W / 2, H - 80);
  };
  paint(!!img);
  if (img) {
    // Remote covers taint the canvas unless they're CORS-clean — detect and
    // fall back to the typographic card so export never fails.
    let tainted = false;
    try { cv.toDataURL(); } catch (e) { tainted = e && e.name === 'SecurityError'; }
    if (tainted) paint(false);
  }
  return cv;
}
async function shareBookCard(id) {
  const b = library.find(x => x.id === id);
  if (!b) return;
  toast('Making your card… ✨');
  const cv = await drawBookCard(b);
  if (!cv) { toast('Image export isn’t supported on this device'); return; }
  const safe = String(b.title || 'book').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'book';
  shareCanvasFile(cv, 'cozy-libram-' + safe + '.png', b.title);
}

function yearTextSummary(d) {
  const lines = [
    '✨ My ' + d.yr + ' in Books ✨',
    '📚 ' + d.n + ' books · 📄 ' + d.pages + ' pages' + (d.avg != null ? ' · ♥ ' + d.avg.toFixed(1) + ' avg' : '')
  ];
  if (d.topGenres.length)
    lines.push('Top genres: ' + d.topGenres.map(([g, n]) => g + ' (' + n + ')').join(', '));
  if (d.topBooks.length) {
    lines.push('Highest rated:');
    d.topBooks.forEach((b, i) =>
      lines.push((i + 1) + '. ' + b.title + ' — ' + (b.authors || []).join(', ') + ' ♥' + b.myRating.toFixed(1)));
  }
  if (d.streak > 0) lines.push('🔥 Longest streak: ' + d.streak + ' days');
  lines.push('Tracked with Cozy Libram 🌶️🖤');
  return lines.join('\n');
}

function copyYearSummary() {
  const t = yearTextSummary(yearInBooksData());
  const done = () => toast('Summary copied 📋');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
  } else fallbackCopy(t, done);
}
function fallbackCopy(t, done) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); }
  ta.remove();
}

function renderStats() {
  // v448: backfill milestones once (idempotent — no-op after first run)
  try { if (typeof backfillMilestones === 'function') backfillMilestones(); } catch (e) {}
  // v454 Part 2: Overview / Details segmented control
  const modeSeg = '<div class="seg seg-2" id="st-modeseg" style="margin-bottom:14px">' +
    '<button data-m="dash"' + (statsMode === 'dash' ? ' class="active"' : '') + '>Overview</button>' +
    '<button data-m="detail"' + (statsMode === 'detail' ? ' class="active"' : '') + '>Details</button></div>';
  const wireModeSeg = () => {
    document.querySelectorAll('#st-modeseg button').forEach(b =>
      b.addEventListener('click', () => { statsMode = b.dataset.m; renderStats(); }));
  };
  const yr = new Date().getFullYear();
  const read = library.filter(b => b.status === 'read');
  const readYr = read.filter(b => b.dateFinished && new Date(b.dateFinished).getFullYear() === yr);
  const pagesYr = pagesInYear(yr); // v427: sum logs, not pageCount (issue #53)
  const avgOf = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const ratedYr = readYr.filter(b => b.myRating > 0);
  const ratedAll = (ratedYr.length ? ratedYr : read).filter(b => b.myRating > 0);
  const avgMine = avgOf(ratedAll.map(b => b.myRating));
  const streak = readingStreak();

  // v128: this month's numbers power the dashboard hero cards.
  const nowD = new Date();
  const mStart = new Date(nowD.getFullYear(), nowD.getMonth(), 1);
  const readMo = read.filter(b => { const d = b.dateFinished && new Date(b.dateFinished); return d && d >= mStart; });
  // v447: dashboard pages use logged session pages (not finished books' page
  // counts) so in-progress reading counts and the number matches the detail view.
  // v454: via the single pagesInRange helper.
  const mLast = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate();
  const mPfx = nowD.getFullYear() + '-' + String(nowD.getMonth() + 1).padStart(2, '0');
  const pagesMo = pagesInRange(mPfx + '-01', mPfx + '-' + String(mLast).padStart(2, '0'));
  const ratedMo = readMo.filter(b => b.myRating > 0);
  const avgMo = avgOf(ratedMo.map(b => b.myRating));
  const hrsMo = Math.round(pagesMo / 60); // ~1 page a minute
  const monthName = nowD.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // v559: four status buckets — to-buy TBR books count as TBR (the
  // Wishlist is the to-buy part of TBR, not a peer bucket).
  const counts = { tbr: 0, reading: 0, read: 0, dnf: 0 };
  library.forEach(b => { if (counts[b.status] != null) counts[b.status]++; });
  const max = Math.max(1, counts.tbr, counts.reading, counts.read, counts.dnf);
  const barColor = { tbr: 'var(--gold)', reading: '#6aa8e5', read: 'var(--ok)', dnf: 'var(--danger)' };
  const distRows = Object.keys(STATUS).map(s =>
    '<div class="dist-row"><span class="lbl">' + STATUS[s] + '</span>' +
    '<div class="bar"><div class="fill" style="width:' + Math.round(counts[s] / max * 100) + '%;background:' + barColor[s] + '"></div></div>' +
    '<span class="num">' + counts[s] + '</span></div>').join('');

  const reading = library.filter(b => b.status === 'reading');
  const nowReading = reading.length
    ? '<div class="stat-sub">' + icon('reading') + ' Currently reading</div><div class="now-reading">' + reading.map(b => {
        const pct = b.pageCount ? Math.round((b.progress || 0) / b.pageCount * 100) : 0;
        return '<div class="book-card" data-id="' + esc(b.id) + '">' + coverHTML(b) +
          '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
          '<p class="author">' + esc(displayAuthors(b.authors)) + '</p>' +
          (b.pageCount ? '<div class="progress-line"><div class="fill" style="width:' + pct + '%"></div></div>' +
            '<p class="author" style="margin-top:4px">' + (b.progress || 0) + ' / ' + b.pageCount + ' pages · ' + pct + '%</p>' : '') +
          '</div></div>';
      }).join('') + '</div>'
    : '';

  const heroCard = (ic, n, l) =>
    '<div class="stat hero"><div class="n">' + icon(ic) + ' ' + n + '</div><div class="l">' + l + '</div></div>';

  // v476: library value — automated estimates, no manual entry required.
  // estimateBookValue() is global so Settings and the book modal share it.
  // purchasePrice wins when the user entered one (their data is kept);
  // otherwise the flat estimate default. Always labeled an estimate.
  var libEst = 0;
  try {
    library.forEach(function(b) {
      libEst += estimateBookValue(b).value;
    });
  } catch (e) {}
  const valueSection =
    '<div class="stat-sub">' + icon('chart') + ' Library value</div>' +
    '<div class="valcard"><div class="big">≈ ' + esc(formatMoney(libEst, { digits: 0 })) + '</div>' +
    '<div>Estimated collection value</div>' +
    '<div class="note">A rough estimate — actual prices vary.</div></div>';

  // v128: dashboard first — this month at a glance. The full explorer lives
  // one tap behind "Explore detailed stats".
  if (statsMode === 'dash') {
    // v447: insight of the week — the most engaging pattern, pulled to the top
    const insights = patternObservations();
    const insightCard = insights.length
      ? '<div class="insight-card"><span class="pi">' + icon('bulb') + '</span><p>' + insights[0] + '</p></div>'
      : '';
    // v448: milestone celebration — quiet inline card for the newest unseen milestone
    let milestoneCard = '';
    try {
      if (typeof checkMilestones === 'function') checkMilestones();
      if (typeof newestUnseenMilestone === 'function') {
        const nm = newestUnseenMilestone();
        if (nm) {
          milestoneCard = '<div class="milestone-celebration" data-mid="' + esc(nm.def.id) + '">' +
            '<div class="micon">' + icon(nm.def.icon || 'sparkles') + '</div><div style="flex:1">' +
            '<div class="mtitle">A little reading milestone</div>' +
            '<h3>' + esc(nm.def.title) + '</h3><p>' + esc(nm.def.copy) + '</p>' +
            '<a href="#" data-act="milestones">View milestones \u2192</a></div>' +
            '<button class="btn ghost sm" data-act="dismiss-milestone" aria-label="Dismiss" style="flex:none">\u2715</button></div>';
        }
      }
    } catch (e) {}
    setView(
      '<h2 class="section serif">Chronicles</h2>' +
      modeSeg +
      milestoneCard +
      insightCard +
      '<div class="stat-sub">' + icon('calendar') + ' ' + esc(monthName) + '</div>' +
      '<div class="stat-row">' +
      heroCard('covers', readMo.length, 'Books finished') +
      heroCard('doc', pagesMo > 999 ? (pagesMo / 1000).toFixed(1) + 'k' : pagesMo, 'Pages') +
      (ratedMo.length
        ? heroCard('heart', avgMo.toFixed(1) + ' ★', 'Avg rating (' + ratedMo.length + ')')
        : '<button class="stat hero" data-act="rate-book" style="cursor:pointer"><div class="n">' + icon('heart') + '</div><div class="l">Rate a book</div></button>') +
      heroCard('history', hrsMo > 0 ? '~' + hrsMo + 'h' : '–', 'Reading time (est.)') +
      '</div>' +
      // v447: gentle month-over-month note — cozy framing, not KPI deltas
      // v454: via the single pagesInRange helper.
      (() => {
        const lastMo = new Date(nowD.getFullYear(), nowD.getMonth() - 1, 1);
        const lastPfx = lastMo.getFullYear() + '-' + String(lastMo.getMonth() + 1).padStart(2, '0');
        const lastLast = new Date(lastMo.getFullYear(), lastMo.getMonth() + 1, 0).getDate();
        const pagesLast = pagesInRange(lastPfx + '-01', lastPfx + '-' + String(lastLast).padStart(2, '0'));
        if (pagesLast < 20 || pagesMo < 20) return '';
        const ratio = pagesMo / pagesLast;
        const lastName = lastMo.toLocaleDateString(undefined, { month: 'long' });
        let note;
        if (ratio >= 1.25) note = 'A lively month — well ahead of ' + esc(lastName) + '.';
        else if (ratio >= 1.05) note = 'A little more reading than ' + esc(lastName) + '.';
        else if (ratio >= 0.95) note = 'Keeping a steady pace with ' + esc(lastName) + '.';
        else if (ratio >= 0.75) note = 'A quieter month than ' + esc(lastName) + ' — cozy counts too.';
        else note = 'A restful month after ' + esc(lastName) + '.';
        return '<p class="note" style="margin-top:8px">' + note + '</p>';
      })() +
      // v405 (T1): one full-width streak banner with the definition inline —
      // not a separate stat card + orphaned detail. Always visible; the copy
      // adapts when there's no active streak.
      '<div class="streak-banner">' + icon('flame') + ' <b>' +
      (streak > 0 ? streak + '-day streak' : 'No active streak') + '</b>' +
      '<span class="streak-def">' +
      (streak > 0
        ? 'Consecutive days with logged pages or a finished book.'
        : 'Log pages today and the count begins — one day at a time.') +
      '</span></div>' +
      nowReading +
      '<div class="stat-sub">' + icon('covers') + ' Shelves</div><div class="dist">' + distRows + '</div>' +
      valueSection
    );
    wireModeSeg();
    document.querySelectorAll('.now-reading .book-card').forEach(c =>
      c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
    // v448: milestone celebration — "seen" means the reader engaged:
    // clicking "View milestones" or explicitly dismissing the card.
    // Merely rendering the card does not consume the celebration.
    document.querySelectorAll('[data-act="milestones"]').forEach(a =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const card = a.closest('.milestone-celebration');
        const mid = card && card.dataset.mid;
        if (mid && typeof markMilestoneSeen === 'function') markMilestoneSeen(mid);
        if (typeof renderMilestones === 'function') renderMilestones();
      }));
    document.querySelectorAll('[data-act="dismiss-milestone"]').forEach(b =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const card = b.closest('.milestone-celebration');
        const mid = card && card.dataset.mid;
        if (mid && typeof markMilestoneSeen === 'function') markMilestoneSeen(mid);
        if (card) card.style.display = 'none';
      }));
    return;
  }

  setView(
    '<h2 class="section serif">Chronicles</h2>' +
    modeSeg +
    '<div class="stat-sub">Overview</div>' +
    '<div class="stat-row">' +
    '<div class="stat"><div class="n">' + readYr.length + '</div><div class="l">Read in ' + yr + '</div></div>' +
    '<div class="stat"><div class="n">' + (pagesYr > 999 ? (pagesYr / 1000).toFixed(1) + 'k' : pagesYr) + '</div><div class="l">Pages</div></div>' +
    (ratedAll.length
      ? '<div class="stat"><div class="n">' + icon('heart') + ' ' + avgMine.toFixed(1) + ' ★</div><div class="l">Avg rating (' + ratedAll.length + ')</div></div>'
      : '<button class="stat" data-act="rate-book" style="cursor:pointer"><div class="n">' + icon('heart') + '</div><div class="l">Rate a book</div></button>') +
    '<div class="stat"><div class="n">' + icon('flame') + ' ' + (streak > 0 ? streak : '0') + '</div><div class="l">Day streak</div></div>' +
    '</div>' +
    '<button class="yib-card" id="st-yib">' + icon('sparkles') +
    '<div><div class="yib-title">My ' + yr + ' in Books</div>' +
    '<div class="note">Your year, beautifully summarized — ready to share.</div></div>' +
    '<span class="yib-go">›</span></button>' +
    nowReading +
    dailyStatsHTML() +
    (typeof dnaHeroHTML === 'function' ? dnaHeroHTML() : '') +
    // v447: section navigation for the long detail view
    '<div class="stat-nav sticky">' +
    ['Activity|st-sec-activity', 'Pace|st-sec-pace', 'Taste|st-sec-taste', 'Records|st-sec-records'].map(s => {
      const parts = s.split('|');
      return '<button class="chip" data-target="' + parts[1] + '">' + parts[0] + '</button>';
    }).join('') +
    '</div>' +
    '<div class="stat-sub">Explore</div>' +
    '<div class="st-sec" id="st-sec-activity"><button class="st-sec-head" data-sec="st-sec-activity"><span>Activity</span><span class="chev">▾</span></button><div class="st-sec-body">' + heatmapHTML() + readingCalHTML() + '</div></div>' +
    '<div class="stat-detail-grid">' +
    '<div class="st-sec" id="st-sec-pace"><button class="st-sec-head" data-sec="st-sec-pace"><span>Pace</span><span class="chev">▾</span></button><div class="st-sec-body">' + paceHTML() + '</div></div>' +
    '<div class="st-sec" id="st-sec-taste"><button class="st-sec-head" data-sec="st-sec-taste"><span>Taste</span><span class="chev">▾</span></button><div class="st-sec-body">' + (tasteGateNeeded() ? tasteGateHTML() : spiceProfileHTML() + moodProfileHTML()) +
    (typeof dnfInsightsHTML === 'function' ? dnfInsightsHTML() : '') +
    ratingDistHTML() + patternsHTML() + genreEvoHTML() + '</div></div>' +
    '</div>' +
    '<div class="st-sec" id="st-sec-records"><button class="st-sec-head" data-sec="st-sec-records"><span>Records</span><span class="chev">▾</span></button><div class="st-sec-body">' + recordsHTML() + seriesHTML() + '</div></div>' +
    '<div class="stat-sub">Shelves</div><div class="dist">' + distRows + '</div>'
  );

  // v447: section nav chips scroll to anchors
  document.querySelectorAll('.stat-nav .chip').forEach(c =>
    c.addEventListener('click', () => {
      const t = document.getElementById(c.dataset.target);
      if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

  document.querySelectorAll('.now-reading .book-card').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));

  document.querySelectorAll('#heatmap [data-day]').forEach(c =>
    c.addEventListener('click', () => {
      heatSel = (heatSel === c.dataset.day) ? null : c.dataset.day;
      renderStats();
    }));
  document.getElementById('cal-prev').addEventListener('click', () => {
    calM--; if (calM < 0) { calM = 11; calY--; } renderStats();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calM++; if (calM > 11) { calM = 0; calY++; } renderStats();
  });
  document.querySelectorAll('#readcal [data-day]').forEach(c =>
    c.addEventListener('click', () => {
      calSel = (calSel === c.dataset.day) ? null : c.dataset.day;
      renderStats();
    }));
  document.querySelectorAll('#heat-books .cal-book, #cal-books .cal-book, .dstat-card .cal-book, .record-card[data-id], .record-row[data-id], .series-row [data-id]').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
  const sra = document.getElementById('sr-all');
  if (sra) sra.addEventListener('click', () => { seriesReturn = 'stats'; go('series'); });
  // v398: wire Reading DNA share button
  if (typeof wireDnaShare === 'function') wireDnaShare();
  // v398: maybe show Reading Wrapped banner (Dec/Jan)
  if (typeof maybeShowWrappedBanner === 'function') maybeShowWrappedBanner();
  const big = document.getElementById('bigday');
  if (big) big.addEventListener('click', () => {
    const parts = big.dataset.day.split('-');
    calY = parseInt(parts[0], 10); calM = parseInt(parts[1], 10) - 1;
    calSel = big.dataset.day; heatSel = null;
    renderStats();
    setTimeout(() => {
      const el = document.getElementById('readcal');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  });
  wireModeSeg();
  // v454 Part 2: jump chips scroll to sections; section heads collapse/expand
  document.querySelectorAll('.stat-nav .chip').forEach(ch =>
    ch.addEventListener('click', () => {
      const el = document.getElementById(ch.dataset.target);
      if (el) {
        el.classList.remove('collapsed');
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }));
  document.querySelectorAll('.st-sec-head').forEach(h =>
    h.addEventListener('click', () => {
      document.getElementById(h.dataset.sec).classList.toggle('collapsed');
    }));
  document.getElementById('st-yib').addEventListener('click', () => renderYearInBooks(new Date().getFullYear()));
  document.querySelectorAll('#evo-gran button').forEach(b2 =>
    b2.addEventListener('click', () => { genreGran = b2.dataset.g; renderStats(); }));
  document.querySelectorAll('.kv-row.tap').forEach(r =>
    r.addEventListener('click', () => openDetail(r.dataset.id)));
  // v400: empty-state CTA — open a read book to rate axes
  document.querySelectorAll('[data-act="rate-book"]').forEach(b =>
    b.addEventListener('click', () => {
      const read = library.filter(x => x.status === 'read');
      if (read.length) openDetail(read[0].id);
      else go('library');
    }));
}

/* ---- Milestones page (v448) ---- */
function renderMilestones() {
  const store = typeof loadMilestones === 'function' ? loadMilestones() : {};
  const cats = [
    { id: 'journey', name: 'Journey', desc: 'The road so far \u2014 books finished, pages turned.' },
    { id: 'rhythm', name: 'Rhythm', desc: 'The shape of your reading days.' },
    { id: 'discovery', name: 'Discovery', desc: 'Firsts and new horizons.' },
    { id: 'taste', name: 'Taste', desc: 'Your reading personality, in milestones.' },
    { id: 'lore', name: 'Lorekeeper', desc: 'Notes, quotes, and the people in the margins.' },
    { id: 'soul', name: 'Soul', desc: 'Books that rearranged your furniture.' },
    { id: 'wander', name: 'Wandering', desc: 'New horizons, one genre at a time.' },
    { id: 'ritual', name: 'Rituals', desc: 'Reading aligned with the turning year.' },
    { id: 'hidden', name: 'Hidden', desc: 'Some milestones don\u2019t announce themselves.' },
  ];
  let html = '<button class="btn ghost sm" id="ms-back" style="margin-bottom:10px">\u2190 Chronicles</button>' +
    '<h2 class="section serif">Milestones</h2>' +
    '<p class="note" style="margin-bottom:16px">Moments from your reading life, kept quietly.</p>';
  // v536: the pinned milestone (one earned milestone, chosen by the
  // reader) rides at the top; every earned row carries the pin toggle.
  const pinId = typeof milestonePin === 'function' ? milestonePin() : null;
  const pinBtn = (id) => '<button class="ms-pin' + (pinId === id ? ' pinned' : '') + '" data-ms="' + esc(id) +
    '" aria-label="' + (pinId === id ? 'Unpin this milestone' : 'Pin this milestone') + '" title="' +
    (pinId === id ? 'Pinned \u2014 tap to unpin' : 'Pin this milestone') + '">' + icon('medal') + '</button>';
  if (pinId && store[pinId] && typeof milestoneDef === 'function') {
    const pdef = milestoneDef(pinId, store[pinId]);
    if (pdef) {
      const pst = store[pinId];
      const pdate = pst.achievedAt
        ? 'Earned ' + new Date(pst.achievedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
        : 'Earned before milestones launched';
      html += '<div class="milestone-row pinned-row"><div class="micon">' + icon(pdef.icon || 'sparkles') + '</div>' +
        '<div class="minfo"><div class="mname">' + esc(pdef.title) + '</div>' +
        '<div class="mdate">' + esc(pdate) + ' \u00b7 Pinned</div></div>' +
        pinBtn(pinId) +
        '<button class="ms-share" data-ms="' + esc(pinId) + '" aria-label="Share this milestone" title="Share">' + icon('share') + '</button>' +
        '<div class="mcheck">\u2713</div></div>';
    }
  }
  cats.forEach(cat => {
    const items = MILESTONE_CATALOG.filter(m => m.cat === cat.id);
    const earned = items.filter(m => store[m.id]);
    // Dynamic milestones live under their categories (not in the static catalog)
    const DYN_PREFIXES = {
      discovery: ['series-finished-', 'series-complete-'],
      wander: ['wander-genre-'],
    };
    let dynHtml = '';
    let dynCount = 0;
    const prefixes = DYN_PREFIXES[cat.id] || [];
    if (prefixes.length && typeof milestoneDef === 'function') {
      Object.keys(store).filter(id => prefixes.some(p => id.indexOf(p) === 0)).forEach(id => {
        const def = milestoneDef(id, store[id]);
        if (!def) return;
        dynCount++;
        const st = store[id];
        const dateStr = st.achievedAt
          ? 'Earned ' + new Date(st.achievedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
          : 'Earned before milestones launched';
        dynHtml += '<div class="milestone-row"><div class="micon">' + icon(def.icon) + '</div>' +
          '<div class="minfo"><div class="mname">' + esc(def.title) + '</div>' +
          '<div class="mdate">' + esc(dateStr) + '</div></div>' +
          pinBtn(id) +
          '<button class="ms-share" data-ms="' + esc(id) + '" aria-label="Share this milestone" title="Share">' + icon('share') + '</button>' +
          '<div class="mcheck">\u2713</div></div>';
      });
    }
    const earnedCount = earned.length + dynCount;
    const totalLabel = dynCount ? items.length + '+' : items.length;
    html += '<div class="cat-header" style="display:flex;align-items:baseline;gap:8px;margin:20px 0 4px">' +
      '<h3 style="font-size:15px">' + cat.name + '</h3>' +
      '<span class="note">' + earnedCount + ' of ' + totalLabel + '</span></div>' +
      '<p class="note" style="margin-bottom:10px">' + cat.desc + '</p>' + dynHtml;
    items.forEach(m => {
      const st = store[m.id];
      const def = (typeof milestoneDef === 'function' && st) ? milestoneDef(m.id, st) : m;
      if (st) {
        const dateStr = st.achievedAt
          ? 'Earned ' + new Date(st.achievedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
          : 'Earned before milestones launched';
        html += '<div class="milestone-row"><div class="micon">' + icon(def.icon || 'sparkles') + '</div>' +
          '<div class="minfo"><div class="mname">' + esc(def.title) + '</div>' +
          '<div class="mdate">' + esc(dateStr) + '</div></div>' +
          pinBtn(m.id) +
          '<button class="ms-share" data-ms="' + esc(m.id) + '" aria-label="Share this milestone" title="Share">' + icon('share') + '</button>' +
          '<div class="mcheck">\u2713</div></div>';
      } else {
        // Hidden milestones: criteria concealed until earned
        const isHidden = m.cat === 'hidden';
        const lockTitle = isHidden ? '???' : m.title;
        const lockHint = isHidden ? 'A hidden milestone. Keep reading\u2026' : m.hint;
        html += '<div class="milestone-row locked"><div class="micon">' + icon(m.icon || 'sparkles') + '</div>' +
          '<div class="minfo"><div class="mname">' + esc(lockTitle) + '</div>' +
          '<div class="mhint">' + esc(lockHint) + '</div></div></div>';
      }
    });
  });
  setView(html);
  document.getElementById('ms-back').addEventListener('click', () => {
    statsMode = 'dash';
    renderStats();
  });
  if (typeof wireMilestoneShare === 'function') wireMilestoneShare();
  // v536: pin toggles — set or clear the one pin, then repaint so the
  // banner and every toggle agree.
  document.querySelectorAll('.ms-pin').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-ms');
    if (typeof milestoneSetPin !== 'function' || !id) return;
    milestoneSetPin(milestonePin() === id ? null : id);
    renderMilestones();
  }));
}

