'use strict';

/* ---------------- stats view ---------------- */
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
  const today = new Date();
  let p30 = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const k = dayKey(d);
    library.forEach(b => { p30 += pagesOnDay(b, k); });
  }
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

  let html = '<div class="stat-sub">Reading pace</div>';
  html += p30 > 0
    ? '<p class="pace-hero">Your average pace is <b>' + Math.round(perDay) + ' pages/day</b></p>' +
      '<div class="pace-grid">' +
      '<div class="pace"><div class="n">' + Math.round(perDay) + '</div><div class="l">pages / day</div></div>' +
      '<div class="pace"><div class="n">' + Math.round(perDay * 7).toLocaleString() + '</div><div class="l">pages / week</div></div>' +
      '<div class="pace"><div class="n">' + Math.round(perDay * 30.44).toLocaleString() + '</div><div class="l">pages / month</div></div>' +
      '</div>'
    : '<p class="note">Log pages for a few days and your pace will show up here.</p>';
  const kv = (label, val) =>
    '<div class="kv-row"><span>' + label + '</span><b>' + val + '</b></div>';
  html += '<div class="kv">' +
    (avgLen != null ? kv(icon('reading') + ' Average book', Math.round(avgLen) + ' pages') : '') +
    (avgDaysLabel != null ? kv(icon('hourglass') + ' Average time to finish', avgDaysLabel) : '') +
    kv(icon('flame') + ' Current streak', streak > 0 ? streak + '-day' : '0 days — log pages today to start a streak') +
    kv(icon('medal') + ' Longest streak', best > 0 ? best + '-day' : '–') +
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
      : '<p class="note">No pages logged yet today — open a book and tap those steppers! ' + icon('reading') + '</p>') +
    '</div>';
}

/* ---- reading profile (v65): per-axis intensity meters + one plain-spoken
   line about what she reaches for. Descriptive, not judgmental. ---- */
function spiceProfileHTML() {
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
function patternsHTML() {
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
    if (gap >= 0.15) {
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

  // trope rating
  const byTrope = {};
  rated.forEach(b => (b.tropes || []).forEach(t => { (byTrope[t] = byTrope[t] || []).push(b.myRating); }));
  const tk = Object.keys(byTrope).filter(t => byTrope[t].length >= 3)
    .sort((a, b) => avgOf(byTrope[b]) - avgOf(byTrope[a]))[0];
  if (tk)
    obs.push('Books tagged <b>' + esc(tk) + '</b> average <b>' + avgOf(byTrope[tk]).toFixed(1) + ' ⭐</b> for you.');

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
    cards.push('<div class="record-card" data-id="' + esc(b.id) + '"><div class="rlbl">' + icon + ' ' + label + '</div>' +
      coverHTML(b) + '<div class="rtitle">' + esc(b.title) + '</div>' +
      '<div class="rstat">' + stat + '</div></div>');
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
    const next = books.filter(b => b.status !== 'read' && b.status !== 'dnf')
      .sort((a, b) => ((a.series && a.series.position) || 99) - ((b.series && b.series.position) || 99))[0];
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
  const pages = readYr.reduce((s, b) => s + (b.pageCount || 0), 0);
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
  const back = '<button class="btn ghost" id="yib-back" style="margin-bottom:4px">← Stats</button>';
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
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: title || name }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Image saved 📥');
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
  const yr = new Date().getFullYear();
  const read = library.filter(b => b.status === 'read');
  const readYr = read.filter(b => b.dateFinished && new Date(b.dateFinished).getFullYear() === yr);
  const pagesYr = readYr.reduce((s, b) => s + (b.pageCount || 0), 0);
  const avgOf = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const ratedYr = readYr.filter(b => b.myRating > 0);
  const avgMine = avgOf((ratedYr.length ? ratedYr : read).filter(b => b.myRating > 0).map(b => b.myRating));
  const streak = readingStreak();

  // v128: this month's numbers power the dashboard hero cards.
  const nowD = new Date();
  const mStart = new Date(nowD.getFullYear(), nowD.getMonth(), 1);
  const readMo = read.filter(b => { const d = b.dateFinished && new Date(b.dateFinished); return d && d >= mStart; });
  const pagesMo = readMo.reduce((s, b) => s + (b.pageCount || 0), 0);
  const avgMo = avgOf(readMo.filter(b => b.myRating > 0).map(b => b.myRating));
  const hrsMo = Math.round(pagesMo / 60); // ~1 page a minute
  const monthName = nowD.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

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

  // v324: library value — actual spent vs estimated value
  var libActual = 0, libEst = 0, libPriced = 0;
  var libDefault = 24.99;
  try { var dpv = parseFloat(localStorage.getItem('cozylibram.defaultPrice')); if (!isNaN(dpv) && dpv >= 0) libDefault = dpv; } catch (e) {}
  try {
    library.forEach(function(b) {
      if (b.purchasePrice != null && !isNaN(b.purchasePrice)) {
        libActual += b.purchasePrice;
        libPriced++;
        libEst += b.purchasePrice; // actual price counts toward value too
      } else if (b.listPrice == null || isNaN(b.listPrice)) {
        libEst += libDefault;
      }
      if (b.listPrice != null && !isNaN(b.listPrice)) libEst += b.listPrice;
    });
  } catch (e) {}
  const valueSection =
    '<div class="stat-sub">' + icon('chart') + ' Library value</div><div class="stat-row">' +
    heroCard('covers', '$' + libActual.toFixed(2), 'Actual spent') +
    heroCard('sparkles', '$' + libEst.toFixed(2), 'Est. value') +
    '</div>' +
    (libPriced < library.length
      ? '<p class="note">' + libPriced + ' of ' + library.length + ' books priced — rest use the default estimate.</p>'
      : '');

  // v128: dashboard first — this month at a glance. The full explorer lives
  // one tap behind "Explore detailed stats".
  if (statsMode === 'dash') {
    setView(
      '<h2 class="section serif">Reading stats</h2>' +
      '<div class="stat-sub">' + icon('calendar') + ' ' + esc(monthName) + '</div>' +
      '<div class="stat-row">' +
      heroCard('covers', readMo.length, 'Books finished') +
      heroCard('doc', pagesMo > 999 ? (pagesMo / 1000).toFixed(1) + 'k' : pagesMo, 'Pages') +
      heroCard('heart', avgMo != null ? '♥ ' + avgMo.toFixed(1) : '–', 'Avg rating') +
      heroCard('history', hrsMo > 0 ? '~' + hrsMo + 'h' : '–', 'Reading time') +
      '</div>' +
      (streak > 0
        ? '<div class="stat-sub">' + icon('flame') + ' Streak</div><div class="stat-row">' +
          heroCard('flame', streak > 0 ? streak : '0', 'Day streak') + '</div>'
        : '') +
      nowReading +
      '<div class="stat-sub">' + icon('covers') + ' Shelves</div><div class="dist">' + distRows + '</div>' +
      valueSection +
      '<div class="search-row" style="margin:16px 0"><button class="btn ghost block" id="st-explore">' +
      icon('chart') + ' Explore detailed stats →</button></div>'
    );
    document.querySelectorAll('.now-reading .book-card').forEach(c =>
      c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
    document.getElementById('st-explore').addEventListener('click', () => {
      statsMode = 'detail';
      renderStats();
    });
    return;
  }

  setView(
    '<button class="btn ghost sm" id="st-backdash" style="margin-bottom:10px">← Dashboard</button>' +
    '<h2 class="section serif">Reading stats</h2>' +
    '<div class="stat-sub">Overview</div>' +
    '<div class="stat-row">' +
    '<div class="stat"><div class="n">' + readYr.length + '</div><div class="l">Read in ' + yr + '</div></div>' +
    '<div class="stat"><div class="n">' + (pagesYr > 999 ? (pagesYr / 1000).toFixed(1) + 'k' : pagesYr) + '</div><div class="l">Pages</div></div>' +
    '<div class="stat"><div class="n">' + (avgMine != null ? '♥ ' + avgMine.toFixed(1) : '–') + '</div><div class="l">Avg rating</div></div>' +
    '<div class="stat"><div class="n">' + (streak > 0 ? '🔥 ' + streak : '0') + '</div><div class="l">Day streak</div></div>' +
    '</div>' +
    '<div class="search-row" style="margin:10px 0 2px"><button class="btn ghost" id="st-yib">' + icon('sparkles') + ' My ' + yr + ' in Books</button></div>' +
    nowReading +
    dailyStatsHTML() +
    '<div class="stat-sub">Explore</div>' +
    heatmapHTML() +
    readingCalHTML() +
    paceHTML() +
    spiceProfileHTML() +
    (typeof dnaSectionHTML === 'function' ? dnaSectionHTML() : '') +
    (typeof dnfInsightsHTML === 'function' ? dnfInsightsHTML() : '') +
    ratingDistHTML() +
    patternsHTML() +
    genreEvoHTML() +
    recordsHTML() +
    seriesHTML() +
    '<div class="stat-sub">Shelves</div><div class="dist">' + distRows + '</div>'
  );

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
  document.querySelectorAll('#heat-books .cal-book, #cal-books .cal-book, .dstat-card .cal-book, .record-card[data-id], .series-row [data-id]').forEach(c =>
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
  document.getElementById('st-backdash').addEventListener('click', () => {
    statsMode = 'dash';
    renderStats();
  });
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

