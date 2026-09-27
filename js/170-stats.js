'use strict';

/* ---------------- stats view ---------------- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
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

/* ---- reading activity heatmap (v62): GitHub-style, last 22 weeks ----
   Monday-first columns; cell intensity = pages read that day (quartiles of
   her own nonzero days). Tap a day for the book-by-book breakdown. */
const HEAT_WEEKS = 22;
function heatmapHTML() {
  const byDay = dayActivity();
  const pagesByDay = {};
  Object.keys(byDay).forEach(k => {
    pagesByDay[k] = byDay[k].reduce((s, a) => s + (a.finished ? 0 : Math.max(0, a.to - a.from)), 0);
  });
  const vals = Object.values(pagesByDay).filter(v => v > 0).sort((a, b) => a - b);
  const qt = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
  const t1 = qt(0.25), t2 = qt(0.5), t3 = qt(0.75);
  const lvl = (k, p) => {
    if (p > t3) return 4;
    if (p > t2) return 3;
    if (p > t1) return 2;
    if (p > 0 || (byDay[k] || []).length) return 1; // a finish with no logged pages still counts
    return 0;
  };
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
      const p = future ? 0 : (pagesByDay[k] || 0);
      const cls = 'heat-cell' + (future ? ' future' : ' l' + lvl(k, p)) +
        (k === todayK ? ' today' : '') + (k === heatSel ? ' sel' : '');
      cells += '<div class="' + cls + '" data-day="' + k + '"' +
        (future ? '' : ' title="' + k + ' — ' + p + ' pages"') + '></div>';
    }
    cols += '<div class="heat-col">' + cells + '</div>';
  }

  let detail;
  if (heatSel) {
    const acts = (byDay[heatSel] || []).slice().sort((x, y) => String(x.b.title).localeCompare(String(y.b.title)));
    const dayPages = acts.reduce((s, a) => s + (a.finished ? 0 : Math.max(0, a.to - a.from)), 0);
    const nBooks = new Set(acts.map(a => a.b.id)).size;
    detail = '<div id="heat-books"><div class="stat-sub" style="margin-top:12px">' +
      fmtDate(new Date(heatSel + 'T12:00:00').toISOString()) +
      ' — 📖 ' + nBooks + ' book' + (nBooks === 1 ? '' : 's') +
      ' · 📄 ' + dayPages + ' pages</div>' +
      (acts.length ? acts.map(a => {
        const pages = a.finished ? 0 : Math.max(0, a.to - a.from);
        const pct = (!a.finished && a.b.pageCount) ? ' (' + Math.round(pages / a.b.pageCount * 100) + '%)' : '';
        return '<div class="cal-book" data-id="' + a.b.id + '">' + coverHTML(a.b) +
          '<div><h4>' + esc(a.b.title) + '</h4>' +
          (a.finished ? '<p>Finished 🎉</p>'
            : '<p>p. ' + a.from + ' → p. ' + a.to + '</p><p>+' + pages + ' pages' + pct + '</p>') +
          '</div></div>';
      }).join('') : '<p class="note">Nothing read that day.</p>') + '</div>';
  } else {
    detail = '<div id="heat-books"><p class="note">Tap a day to see what she read.</p></div>';
  }

  const noDate = library.filter(b => b.status === 'read' && !b.dateFinished).length;

  return '<div class="stat-sub">Reading activity</div>' +
    '<div class="heat-scroll"><div class="heat" id="heatmap">' + cols + '</div></div>' +
    '<div class="heat-legend"><span>Less</span>' +
    [0, 1, 2, 3, 4].map(l => '<div class="heat-cell l' + l + '"></div>').join('') +
    '<span>More</span></div>' +
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
  const avgDays = avgOf(read
    .filter(b => b.dateAdded && b.dateFinished)
    .map(b => (new Date(b.dateFinished) - new Date(b.dateAdded)) / 864e5)
      .filter(d => d >= 0 && d < 3650));
  const longest = withPages.slice().sort((a, b) => b.pageCount - a.pageCount)[0];
  const shortest = withPages.slice().sort((a, b) => a.pageCount - b.pageCount)[0];
  const streak = readingStreak(), best = longestStreak();

  let html = '<div class="stat-sub">Reading pace</div>';
  html += p30 > 0
    ? '<p class="pace-hero">Your average pace is <b>' + Math.round(perDay) + ' pages/day</b></p>' +
      '<div class="pace-grid">' +
      '<div class="pace"><div class="n">' + Math.round(perDay) + '</div><div class="l">pages / day</div></div>' +
      '<div class="pace"><div class="n">' + fmtBig(perDay * 7) + '</div><div class="l">pages / week</div></div>' +
      '<div class="pace"><div class="n">' + fmtBig(perDay * 30.44) + '</div><div class="l">pages / month</div></div>' +
      '</div>'
    : '<p class="note">Log pages for a few days and your pace will show up here.</p>';
  const kv = (label, val) =>
    '<div class="kv-row"><span>' + label + '</span><b>' + val + '</b></div>';
  const kvTap = (label, b, suffix) =>
    '<div class="kv-row tap" data-id="' + b.id + '"><span>' + label + '</span><b>' +
    esc(b.title) + ' · ' + suffix + ' ›</b></div>';
  html += '<div class="kv">' +
    (avgLen != null ? kv('📖 Average book', Math.round(avgLen) + ' pages') : '') +
    (avgDays != null ? kv('⏳ Average time to finish', Math.max(1, Math.round(avgDays)) + ' days') : '') +
    kv('🔥 Current streak', streak > 0 ? streak + '-day' : '–') +
    kv('🏅 Longest streak', best > 0 ? best + '-day' : '–') +
    (longest ? kvTap('📕 Longest book', longest, fmtBig(longest.pageCount) + ' pages') : '') +
    (shortest && shortest !== longest ? kvTap('📗 Shortest book', shortest, fmtBig(shortest.pageCount) + ' pages') : '') +
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
    '<div class="dstat-head"><span>📅 ' + fmtDate(new Date().toISOString()) + '</span>' +
    (streak > 1 ? '<span class="streak">🔥 ' + streak + '-day streak</span>' : '') + '</div>' +
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
      : '<p class="note">No pages logged yet today — open a book and tap those steppers! 📖</p>') +
    '</div>';
}

function renderStats() {
  const yr = new Date().getFullYear();
  const read = library.filter(b => b.status === 'read');
  const readYr = read.filter(b => b.dateFinished && new Date(b.dateFinished).getFullYear() === yr);
  const pagesYr = readYr.reduce((s, b) => s + (b.pageCount || 0), 0);
  const avgOf = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const axisAvgs = RATING_AXES.map(a => {
    const vals = read.map(b => (b.ratings || {})[a.key] || 0).filter(v => v > 0);
    return { a: a, avg: avgOf(vals), n: vals.length };
  }).filter(x => x.avg != null);
  const ratedYr = readYr.filter(b => b.myRating > 0);
  const avgMine = avgOf((ratedYr.length ? ratedYr : read).filter(b => b.myRating > 0).map(b => b.myRating));
  const streak = readingStreak();

  const tropeCount = {};
  library.forEach(b => (b.tropes || []).forEach(t => { tropeCount[t] = (tropeCount[t] || 0) + 1; }));
  const topTropes = Object.entries(tropeCount).sort((a, b) => b[1] - a[1]).slice(0, 8);

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
    ? '<div class="stat-sub">Currently reading</div><div class="now-reading">' + reading.map(b => {
        const pct = b.pageCount ? Math.round((b.progress || 0) / b.pageCount * 100) : 0;
        return '<div class="book-card" data-id="' + b.id + '">' + coverHTML(b) +
          '<div class="book-meta"><h3>' + esc(b.title) + '</h3>' +
          '<p class="author">' + esc(b.authors.join(', ')) + '</p>' +
          (b.pageCount ? '<div class="progress-line"><div class="fill" style="width:' + pct + '%"></div></div>' +
            '<p class="author" style="margin-top:4px">' + (b.progress || 0) + ' / ' + b.pageCount + ' pages · ' + pct + '%</p>' : '') +
          '</div></div>';
      }).join('') + '</div>'
    : '';

  setView(
    '<h2 class="section serif">Reading stats</h2>' +
    '<div class="stat-sub">Overview</div>' +
    '<div class="stat-row">' +
    '<div class="stat"><div class="n">' + readYr.length + '</div><div class="l">Read in ' + yr + '</div></div>' +
    '<div class="stat"><div class="n">' + (pagesYr > 999 ? (pagesYr / 1000).toFixed(1) + 'k' : pagesYr) + '</div><div class="l">Pages</div></div>' +
    '<div class="stat"><div class="n">' + (avgMine != null ? '♥ ' + avgMine.toFixed(1) : '–') + '</div><div class="l">Avg rating</div></div>' +
    '<div class="stat"><div class="n">' + (streak > 0 ? '🔥 ' + streak : '–') + '</div><div class="l">Day streak</div></div>' +
    '</div>' +
    dailyStatsHTML() +
    '<div class="stat-sub">Explore</div>' +
    heatmapHTML() +
    paceHTML() +
    '<div class="stat-sub">Shelves</div><div class="dist">' + distRows + '</div>' +
    (topTropes.length
      ? '<div class="stat-sub">Top tropes</div><div class="trope-cloud">' +
        topTropes.map(([t, n]) => '<span class="trope-pill">' + esc(t) + '<span class="c">' + n + '</span></span>').join('') +
        '</div>'
      : '<p class="note">Tag tropes on your books and they\'ll show up here.</p>') +
    (avgMine != null ? '<p class="note">Your average personal rating: <b style="color:var(--ink)">♥ ' + avgMine.toFixed(1) + ' / 5</b></p>' : '') +
    (axisAvgs.length > 1 ? '<p class="note">Average intensity: ' +
      axisAvgs.map(x => '<b style="color:var(--ink)">' + x.a.emoji + ' ' + x.avg.toFixed(1) + '</b>').join(' · ') + '</p>' : '') +
    nowReading
  );

  document.querySelectorAll('.now-reading .book-card').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));

  document.querySelectorAll('#heatmap [data-day]').forEach(c =>
    c.addEventListener('click', () => {
      heatSel = (heatSel === c.dataset.day) ? null : c.dataset.day;
      renderStats();
    }));
  document.querySelectorAll('#heat-books .cal-book, .dstat-card .cal-book').forEach(c =>
    c.addEventListener('click', () => openBookFromEl(c, c.dataset.id)));
  document.querySelectorAll('.kv-row.tap').forEach(r =>
    r.addEventListener('click', () => openDetail(r.dataset.id)));
}

