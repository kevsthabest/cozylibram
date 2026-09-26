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

function readingCalHTML() {
  const byDay = dayActivity();
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
    const cls = 'cal-day' + (n ? ' has' : '') + (k === todayK ? ' today' : '') + (k === calSel ? ' sel' : '');
    cells += '<div class="' + cls + '" data-day="' + k + '"><span class="d">' + d + '</span>' +
      (n ? '<span class="ccover">' +
        (acts[0].b.cover
          ? '<img src="' + esc(acts[0].b.cover) + '" alt="" loading="lazy" onerror="this.remove()">'
          : '📕') +
        (n > 1 ? '<span class="cdot">' + n + '</span>' : '') + '</span>' : '') + '</div>';
  }
  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(x => '<div class="cal-dow">' + x + '</div>').join('');

  let listHTML = '';
  if (calSel) {
    const acts = (byDay[calSel] || []).slice().sort((x, y) => x.b.title.localeCompare(y.b.title));
    const dayPages = acts.reduce((s, a) => s + (a.finished ? 0 : a.to - a.from), 0);
    listHTML = acts.length
      ? '<div class="stat-sub" style="margin-top:12px">' + fmtDate(new Date(calSel + 'T12:00:00').toISOString()) +
        ' — ' + dayPages + ' pages</div>' +
        acts.map(a => {
          const pages = a.finished ? 0 : a.to - a.from;
          const pct = (!a.finished && a.b.pageCount) ? ' (' + Math.round(pages / a.b.pageCount * 100) + '%)' : '';
          return '<div class="cal-book" data-id="' + a.b.id + '">' + coverHTML(a.b) +
            '<div><h4>' + esc(a.b.title) + '</h4>' +
            (a.finished ? '<p>Finished 🎉</p>'
              : '<p>p. ' + a.from + ' → p. ' + a.to + '</p><p>+' + pages + ' pages' + pct + '</p>') +
            '</div></div>';
        }).join('')
      : '<p class="note">Nothing read that day.</p>';
  }

  const noDate = library.filter(b => b.status === 'read' && !b.dateFinished).length;

  return '<div class="stat-sub">Reading calendar</div>' +
    '<div class="cal-head"><button class="btn ghost" id="cal-prev">‹</button>' +
    '<h3>' + MONTHS[calM] + ' ' + calY + '</h3>' +
    '<button class="btn ghost" id="cal-next">›</button></div>' +
    '<div class="cal-grid" id="readcal">' + dow + cells + '</div>' +
    '<div id="cal-books">' + listHTML + '</div>' +
    (noDate ? '<p class="note">' + noDate + ' finished book' + (noDate > 1 ? 's have' : ' has') + ' no finish date.</p>' : '');
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
  const pages = read.reduce((s, b) => s + (b.pageCount || 0), 0);
  const avgOf = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const axisAvgs = RATING_AXES.map(a => {
    const vals = read.map(b => (b.ratings || {})[a.key] || 0).filter(v => v > 0);
    return { a: a, avg: avgOf(vals), n: vals.length };
  }).filter(x => x.avg != null);
  const topAxis = axisAvgs.slice().sort((x, y) => y.n - x.n)[0];
  const avgMine = avgOf(read.filter(b => b.myRating > 0).map(b => b.myRating));

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
    '<div class="stat-row">' +
    '<div class="stat"><div class="n">' + readYr.length + '</div><div class="l">Read in ' + yr + '</div></div>' +
    '<div class="stat"><div class="n">' + read.length + '</div><div class="l">Total read</div></div>' +
    '<div class="stat"><div class="n">' + (pages > 999 ? (pages / 1000).toFixed(1) + 'k' : pages) + '</div><div class="l">Pages</div></div>' +
    '<div class="stat"><div class="n">' + (topAxis ? topAxis.avg.toFixed(1) : '–') + '</div><div class="l">' + (topAxis ? 'Avg ' + topAxis.a.emoji : 'Avg 💥') + '</div></div>' +
    '</div>' +
    dailyStatsHTML() +
    readingCalHTML() +
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
    c.addEventListener('click', () => openDetail(c.dataset.id)));

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
  document.querySelectorAll('#cal-books .cal-book, .dstat-card .cal-book').forEach(c =>
    c.addEventListener('click', () => openDetail(c.dataset.id)));
}

