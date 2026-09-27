'use strict';
/* v100 — Coven stats: soulmate scores, superlatives, leaderboards, buddy reads.
 *
 * Everything here is computed from books the friend already shares with us —
 * hidden shelves and the share-library toggle are enforced by Supabase RLS
 * upstream (see circleFriendBooks), so stats can never leak a private shelf.
 * No new schema; this is pure client-side math over visible books.
 */

// --- per-person aggregates -----------------------------------------------
function statDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function statMonthKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
// Same reading-day logic as readingStreak(), but over any book list so it
// works for friends too (their logs ride along inside shared book data).
function statStreak(books) {
  const days = new Set();
  (books || []).forEach(b => {
    (b.log || []).forEach(e => { if (e && e.to > e.from && e.d) days.add(e.d); });
    if (b.dateFinished) { try { days.add(statDayKey(new Date(b.dateFinished))); } catch (e) {} }
  });
  const d = new Date();
  if (!days.has(statDayKey(d))) d.setDate(d.getDate() - 1); // alive if yesterday logged
  let s = 0;
  while (days.has(statDayKey(d))) { s++; d.setDate(d.getDate() - 1); }
  return s;
}
function topKeys(counts, n) {
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, n || 8);
}
function jaccard(a, b) {
  if (!a.length && !b.length) return 0;
  const bs = new Set(b);
  const inter = a.filter(x => bs.has(x)).length;
  return inter / (a.length + b.length - inter || 1);
}
// One aggregate per person: you, or one friend's visible books.
function statPersonBooks(books) {
  const s = {
    books: books || [], finished: 0, finishedDates: [], monthBooks: 0, monthPages: 0,
    streak: 0, avgDays: null, genreCounts: {}, authorCounts: {}, rated: new Map(),
    tbrKeys: new Set(), tbrBooks: [], reading: [], dnf: 0, spiceSum: 0, spiceN: 0,
  };
  const mk = statMonthKey(new Date());
  let daySum = 0, dayN = 0;
  s.books.forEach(b => {
    (bookGenres(b)).forEach(g => { s.genreCounts[g] = (s.genreCounts[g] || 0) + 1; });
    (b.authors || []).forEach(a => {
      const k = String(a).trim(); if (k) s.authorCounts[k] = (s.authorCounts[k] || 0) + 1;
    });
    const r = Number(b.myRating) || 0;
    if (r > 0) { const k = (typeof recoKey === 'function') ? recoKey(b) : ''; if (k) s.rated.set(k, r); }
    const sp = Number((b.ratings || {}).spice) || 0;
    if (sp > 0) { s.spiceSum += sp; s.spiceN++; }
    const st = b.status;
    if (st === 'dnf') s.dnf++;
    if (st === 'reading') s.reading.push(b);
    if (st === 'tbr') { const k = (typeof recoKey === 'function') ? recoKey(b) : ''; if (k) { s.tbrKeys.add(k); s.tbrBooks.push(b); } }
    const fin = b.dateFinished || (st === 'read' ? b.dateFinished : null);
    if (st === 'read' || b.dateFinished) {
      s.finished++;
      if (b.dateFinished) {
        const d = new Date(b.dateFinished);
        if (!isNaN(d)) {
          s.finishedDates.push(d);
          if (statMonthKey(d) === mk) {
            s.monthBooks++;
            s.monthPages += Number(b.pages) || 0;
          }
        }
      }
    }
    if (b.dateStarted && b.dateFinished) {
      const days = (new Date(b.dateFinished) - new Date(b.dateStarted)) / 864e5;
      if (days > 0 && days < 3650) { daySum += days; dayN++; }
    }
  });
  s.avgDays = dayN ? daySum / dayN : null;
  s.avgDaysN = dayN;
  s.spiceAvg = s.spiceN ? s.spiceSum / s.spiceN : null;
  s.streak = statStreak(s.books);
  return s;
}

// --- soulmate score --------------------------------------------------------
// 0–100 from books you both rated: rating agreement (50%), shared genres
// (25%), shared authors (25%). Needs 3+ books rated by both to say anything.
function soulmateScore(myS, frS) {
  let shared = 0, diffSum = 0;
  myS.rated.forEach((r, k) => {
    const r2 = frS.rated.get(k);
    if (r2) { shared++; diffSum += Math.abs(r - r2); }
  });
  if (shared < 3) return null;
  const agree = 1 - (diffSum / shared) / 4;
  const gJ = jaccard(topKeys(myS.genreCounts), topKeys(frS.genreCounts));
  const aJ = jaccard(topKeys(myS.authorCounts), topKeys(frS.authorCounts));
  const myG = new Set(topKeys(myS.genreCounts)), myA = new Set(topKeys(myS.authorCounts));
  return {
    score: Math.max(1, Math.round(100 * (0.5 * agree + 0.25 * gJ + 0.25 * aJ))),
    shared: shared,
    genres: topKeys(frS.genreCounts).filter(g => myG.has(g)).slice(0, 3),
    authors: topKeys(frS.authorCounts).filter(a => myA.has(a)).slice(0, 3),
  };
}

// --- buddy reads: TBR books you both want ----------------------------------
function buddyReads(myS, frS) {
  const out = [];
  (frS.tbrBooks || []).forEach(b => {
    const k = (typeof recoKey === 'function') ? recoKey(b) : '';
    if (k && myS.tbrKeys.has(k) && !out.some(x => recoKey(x) === k)) out.push(b);
  });
  return out;
}

// --- load + shape everything for the UI ------------------------------------
async function loadCovenStats() {
  const friends = ((await circleLists()).friends) || [];
  const people = [{ id: 'me', name: 'You', profile: null, stats: statPersonBooks(typeof library !== 'undefined' ? library : []) }];
  for (const f of friends) {
    let books = [];
    try { books = await circleFriendBooks(f.id); } catch (e) { continue; }
    let profile = f.profile || null;
    try { profile = await circleFriendProfile(f.id); } catch (e) {}
    people.push({ id: f.id, name: f.name || 'A friend', profile: profile, stats: statPersonBooks(books) });
  }
  const me = people[0].stats;
  const others = people.slice(1);

  // Monthly leaderboard: books finished, then pages.
  const board = people.map(p => ({ p: p, books: p.stats.monthBooks, pages: p.stats.monthPages }))
    .sort((a, b) => b.books - a.books || b.pages - a.pages);

  // Superlatives across the coven (you included).
  const awards = [];
  const push = (p, label, detailFn) => { if (p) awards.push({ label: label, person: p, detail: detailFn(p) }); };
  push(people.filter(p => (p.stats.avgDaysN || 0) >= 3).sort((a, b) => a.stats.avgDays - b.stats.avgDays)[0],
    'Fastest Finisher', p => 'avg ' + p.stats.avgDays.toFixed(1) + ' days a book');
  push(people.slice().sort((a, b) => Object.keys(b.stats.genreCounts).length - Object.keys(a.stats.genreCounts).length)
    .find(p => Object.keys(p.stats.genreCounts).length > 0),
    'Genre Explorer', p => Object.keys(p.stats.genreCounts).length + ' genres and counting');
  push(people.filter(p => (p.stats.spiceN || 0) >= 3).sort((a, b) => b.stats.spiceAvg - a.stats.spiceAvg)[0],
    'Spiciest Shelf', p => 'averages ' + p.stats.spiceAvg.toFixed(1) + ' peppers');
  const devourer = board[0];
  if (devourer && devourer.books > 0) awards.push({ label: 'Page Devourer', person: devourer.p,
    detail: devourer.books + ' finished · ' + devourer.pages.toLocaleString() + ' pages this month' });
  push(people.filter(p => p.stats.dnf >= 2).sort((a, b) => b.stats.dnf - a.stats.dnf)[0],
    'DNF Royalty', p => p.stats.dnf + ' books abandoned, zero regrets');

  // Soulmate scores + taste overlap per friend.
  const soulmates = others.map(p => ({ p: p, sm: soulmateScore(me, p.stats) }))
    .filter(x => x.sm).sort((a, b) => b.sm.score - a.sm.score);

  // Buddy reads per friend.
  const buddies = [];
  others.forEach(p => {
    const shared = buddyReads(me, p.stats);
    if (shared.length) buddies.push({ p: p, books: shared.slice(0, 6) });
  });

  // Now reading across the coven.
  const nowReading = [];
  people.forEach(p => {
    (p.stats.reading || []).slice(0, 3).forEach(b => nowReading.push({ p: p, book: b }));
  });

  // Trending genres across friends' visible shelves.
  const gCounts = {};
  others.forEach(p => {
    Object.keys(p.stats.genreCounts).forEach(g => { gCounts[g] = (gCounts[g] || 0) + p.stats.genreCounts[g]; });
  });
  const trending = topKeys(gCounts, 5);

  return { people: people, board: board, awards: awards, soulmates: soulmates, buddies: buddies, nowReading: nowReading, trending: trending };
}

// --- UI --------------------------------------------------------------------
function statAvatar(p) {
  if (p.profile) return circAvatarHTML(p.profile, 'c-avatar');
  return '<span class="c-avatar" aria-hidden="true">Y</span>';
}
function covenStatsHTML(d) {
  if (!d || !d.people || d.people.length < 2) return '';
  let html = '<h2 class="section serif">' + esc(covenName()) + ' stats</h2>';

  // Soulmate scores
  if (d.soulmates.length) {
    html += '<div class="circle-card"><h3 style="margin:0 0 10px">Book soulmates</h3>';
    d.soulmates.forEach(x => {
      const bits = [];
      if (x.sm.genres.length) bits.push('both love ' + x.sm.genres.map(esc).join(', '));
      if (x.sm.authors.length) bits.push(esc(x.sm.authors[0]) + (x.sm.authors.length > 1 ? ' +' + (x.sm.authors.length - 1) : ''));
      html += '<div class="circle-row">' + statAvatar(x.p) +
        '<div class="circle-meta"><b>' + esc(x.p.name) + '</b>' +
        '<span class="note">' + x.sm.shared + ' books rated in common' + (bits.length ? ' · ' + bits.join(' · ') : '') + '</span>' +
        '<div class="progress-line slim"><div class="fill" style="width:' + x.sm.score + '%"></div></div></div>' +
        '<div class="circle-actions"><b class="serif" style="font-size:20px">' + x.sm.score + '%</b></div></div>';
    });
    html += '</div>';
  }

  // Monthly leaderboard
  if (d.board.some(r => r.books > 0)) {
    html += '<div class="circle-card"><h3 style="margin:0 0 10px">This month</h3>';
    d.board.forEach((r, i) => {
      html += '<div class="circle-row">' + statAvatar(r.p) +
        '<div class="circle-meta"><b>' + esc(r.p.name) + '</b>' +
        '<span class="note">' + r.books + ' finished · ' + r.pages.toLocaleString() + ' pages</span></div>' +
        '<div class="circle-actions"><b class="serif" style="font-size:20px">' + (i + 1) + '</b></div></div>';
    });
    const streakers = d.board.filter(r => r.p.stats.streak > 0);
    if (streakers.length) {
      html += '<p class="note" style="margin:10px 0 0">' + icon('flame') + ' streaks: ' +
        streakers.map(r => esc(r.p.name) + ' ' + r.p.stats.streak + 'd').join(' · ') + '</p>';
    }
    html += '</div>';
  }

  // Superlatives
  if (d.awards.length) {
    html += '<div class="circle-card"><h3 style="margin:0 0 10px">Superlatives</h3><div class="circle-list">';
    d.awards.forEach(a => {
      html += '<div class="circle-row">' + statAvatar(a.person) +
        '<div class="circle-meta"><b>' + esc(a.label) + ' — ' + esc(a.person.name) + '</b>' +
        '<span class="note">' + esc(a.detail) + '</span></div></div>';
    });
    html += '</div></div>';
  }

  // Buddy reads
  if (d.buddies.length) {
    html += '<div class="circle-card"><h3 style="margin:0 0 4px">Buddy reads</h3>' +
      '<p class="note" style="margin:0 0 10px">On both your TBRs — pick one and read it together.</p><div class="circle-list">';
    d.buddies.forEach(bd => {
      bd.books.forEach(b => {
        html += '<div class="circle-row">' + statAvatar(bd.p) +
          '<div class="circle-meta"><b>' + esc(b.title || 'Untitled') + '</b>' +
          '<span class="note">you + ' + esc(bd.p.name) + '</span></div></div>';
      });
    });
    html += '</div></div>';
  }

  // Now reading + trending
  if (d.nowReading.length || d.trending.length) {
    html += '<div class="circle-card"><h3 style="margin:0 0 10px">Around the ' + esc(covenName().toLowerCase()) + '</h3>';
    d.nowReading.slice(0, 6).forEach(nr => {
      html += '<div class="circle-row">' + statAvatar(nr.p) +
        '<div class="circle-meta"><b>' + esc(nr.p.name) + '</b>' +
        '<span class="note">is reading ' + esc(nr.book.title || 'Untitled') + '</span></div></div>';
    });
    if (d.trending.length) {
      html += '<p class="note" style="margin:10px 0 0">Trending: ' + d.trending.map(esc).join(' · ') + '</p>';
    }
    html += '</div>';
  }

  // Streaks live inside the leaderboard card footer — compact, no extra card.
  return html;
}

// Fill the #stats-slot left by renderCovenMain; safe to call repeatedly.
function refreshCovenStats() {
  const slot = document.getElementById('stats-slot');
  if (!slot || typeof circleLists !== 'function') return;
  slot.innerHTML = '<p class="note" style="text-align:center">Crunching ' + esc(covenName().toLowerCase()) + ' stats…</p>';
  loadCovenStats()
    .then(d => { const el = document.getElementById('stats-slot'); if (el) el.innerHTML = covenStatsHTML(d); })
    .catch(() => { const el = document.getElementById('stats-slot'); if (el) el.innerHTML = ''; });
}
