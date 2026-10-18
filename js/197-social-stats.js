'use strict';
/* v100 — Hearth stats: soulmate scores, superlatives, circle digest, buddy reads.
 * v474: the monthly "leaderboard" is now a circle digest — per-friend activity
 * in circle order (you first), no ordinal ranks, no sorted-by-output ordering.
 * Playful, never pressuring: nobody wins the month; everyone's just visible.
 *
 * Everything here is computed from books the friend already shares with us —
 * hidden shelves and the share-library toggle are enforced by Supabase RLS
 * upstream (see circleFriendBooks), so stats can never leak a private shelf.
 * No new schema; this is pure client-side math over visible books.
 */

// --- per-person aggregates -----------------------------------------------
/* ES MODULE (ES-modules migration, bridge-everything pass): this file is
   a real ES module — loaded via <script type="module"> in index.html.
   Its public surface is exported in place and republished on window by
   the compatibility bridge at the bottom of this file, so classic
   scripts keep resolving the same globals. See
   docs/es-modules-migration-plan.md (§3–§4) for the pattern. */

export function statDayKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function statMonthKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
// v454: normalise genre names — lowercase, trimmed, so "Dark Romance",
// "dark romance " and "DARK ROMANCE" count as one.
export function normGenre(g) {
  return String(g || '').trim().toLowerCase();
}
// v454: shared log-based page sum. Sums (to - from) from reading logs within
// [start, end] (YYYY-MM-DD). Returns { pages, estimated } — estimated is true
// when falling back to finished books' pageCounts (no logs).
export function pagesInRangeFor(books, start, end) {
  let pages = 0, hasLogs = false;
  (books || []).forEach(b => {
    (b.log || []).forEach(e => {
      const d = String(e.d || '');
      // Percent entries are not page logs: they add no pages here and do
      // not count as hasLogs — that flag means "page logs exist" and
      // gates the estimated-pageCount fallback below.
      if (d >= start && d <= end && e.to > e.from && entryUnit(e) === 'page') {
        pages += Math.max(0, e.to - e.from);
        hasLogs = true;
      }
    });
  });
  if (!hasLogs) {
    // Fallback: sum pageCounts of books finished in range, labelled estimated
    (books || []).forEach(b => {
      // Bucket by the LOCAL day, like every sibling aggregate here
      // (monthBooks via statMonthKey, streaks via statDayKey): slicing
      // the ISO string takes the UTC date, which put a late-evening
      // local finish (and its pages) in the neighbouring month while
      // monthBooks counted the book itself in the local one.
      const f = b.dateFinished ? statDayKey(new Date(b.dateFinished)) : '';
      if ((b.status === 'read' || f) && f >= start && f <= end) {
        pages += Number(b.pageCount) || Number(b.pages) || 0;
      }
    });
    return { pages: pages, estimated: true };
  }
  return { pages: pages, estimated: false };
}
// Same reading-day logic as readingStreak(), but over any book list so it
// works for friends too (their logs ride along inside shared book data).
export function statStreak(books) {
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
export function topKeys(counts, n) {
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, n || 8);
}
export function jaccard(a, b) {
  if (!a.length && !b.length) return 0;
  const bs = new Set(b);
  const inter = a.filter(x => bs.has(x)).length;
  return inter / (a.length + b.length - inter || 1);
}
// One aggregate per person: you, or one friend's visible books.
export function statPersonBooks(books) {
  const s = {
    books: books || [], finished: 0, finishedDates: [], monthBooks: 0, monthPages: 0,
    streak: 0, avgDays: null, genreCounts: {}, authorCounts: {}, rated: new Map(),
    tbrKeys: new Set(), tbrBooks: [], reading: [], dnf: 0, spiceSum: 0, spiceN: 0,
  };
  const mk = statMonthKey(new Date());
  let daySum = 0, dayN = 0;
  s.books.forEach(b => {
    (bookGenres(b)).forEach(g => { const ng = normGenre(g); if (ng) s.genreCounts[ng] = (s.genreCounts[ng] || 0) + 1; });
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
  // v454: month pages from logs (not b.pages which doesn't exist)
  const now = new Date();
  const mPfx = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const mLast = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const mp = pagesInRangeFor(s.books, mPfx + '-01', mPfx + '-' + String(mLast).padStart(2, '0'));
  s.monthPages = mp.pages;
  s.monthPagesEst = mp.estimated;
  return s;
}

// --- soulmate score --------------------------------------------------------
// 0–100 from books you both rated: rating agreement (50%), shared genres
// (25%), shared authors (25%). Needs 3+ books rated by both to say anything.
export function soulmateScore(myS, frS) {
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
export function buddyReads(myS, frS) {
  const out = [];
  (frS.tbrBooks || []).forEach(b => {
    const k = (typeof recoKey === 'function') ? recoKey(b) : '';
    if (k && myS.tbrKeys.has(k) && !out.some(x => recoKey(x) === k)) out.push(b);
  });
  return out;
}

// --- superlatives: who in the circle gets which playful award ----------------
// Extracted as a pure function for testability. people = [{ id, name,
// profile, stats }] in circle order (you first).
// v474: pace-based awards retired per the product brief ("Playful, never
// pressuring"). Fastest Finisher (avg days per book) and Page Devourer
// (most output this month) are gone. Replacements are character-flavored,
// never pace comparisons: Deep Diver (longest book braved), Author Devotee
// (loyalty to one author). Fearless Quitter is the model — playful, not
// pressuring — and stays, with Genre Explorer and Spiciest Shelf.
export function longestFinishedBook(stats) {
  let best = null;
  (stats.books || []).forEach(b => {
    if (b.status === 'read' || b.dateFinished) {
      const pc = Number(b.pageCount) || Number(b.pages) || 0;
      if (pc > 0 && (!best || pc > best.pages)) best = { title: b.title || 'Untitled', pages: pc };
    }
  });
  return best;
}
export function mostReadAuthor(stats) {
  let top = null;
  Object.keys(stats.authorCounts || {}).forEach(k => {
    const n = stats.authorCounts[k];
    if (n >= 2 && (!top || n > top.n)) top = { author: k, n: n };
  });
  return top;
}
export function covenAwards(people) {
  const awards = [];
  const push = (p, label, detailFn) => { if (p) awards.push({ label: label, person: p, detail: detailFn(p) }); };
  push(people.slice().sort((a, b) => Object.keys(b.stats.genreCounts).length - Object.keys(a.stats.genreCounts).length)
    .find(p => Object.keys(p.stats.genreCounts).length > 0),
    'Genre Explorer', p => { const n = Object.keys(p.stats.genreCounts).length; return (n > 40 ? '40+' : n) + ' genres and counting'; });
  push(people.filter(p => (p.stats.spiceN || 0) >= 3).sort((a, b) => b.stats.spiceAvg - a.stats.spiceAvg)[0],
    'Spiciest Shelf', p => 'averages ' + p.stats.spiceAvg.toFixed(1) + ' peppers');
  const diver = people.map(p => ({ p: p, lb: longestFinishedBook(p.stats) }))
    .filter(x => x.lb).sort((a, b) => b.lb.pages - a.lb.pages)[0];
  push(diver && diver.p, 'Deep Diver', p => {
    const lb = longestFinishedBook(p.stats);
    return 'braved ' + lb.title + ' (' + lb.pages.toLocaleString() + ' pages)';
  });
  const devotee = people.map(p => ({ p: p, ta: mostReadAuthor(p.stats) }))
    .filter(x => x.ta).sort((a, b) => b.ta.n - a.ta.n)[0];
  push(devotee && devotee.p, 'Author Devotee', p => {
    const ta = mostReadAuthor(p.stats);
    return ta.n + ' books by ' + ta.author;
  });
  push(people.filter(p => p.stats.dnf >= 2).sort((a, b) => b.stats.dnf - a.stats.dnf)[0],
    'Fearless Quitter', p => p.stats.dnf + ' books abandoned, zero regrets');
  return awards;
}

// --- load + shape everything for the UI ------------------------------------
export async function loadCovenStats() {
  const friends = ((await circleLists()).friends) || [];
  const people = [{ id: 'me', name: 'You', profile: null, stats: statPersonBooks(typeof library !== 'undefined' ? library : []) }];
  for (const f of friends) {
    // v522: reading activity is opt-in. A friend whose projection says
    // share_activity is off contributes NOTHING to the activity
    // surfaces (digest, moments, soulmates, now-reading, trending,
    // awards): their activity stats stay empty, exactly as before.
    // The person row remains so counts of circle members stay
    // honest.
    //
    // v532 (remediation Batch A, RC1): their books are now FETCHED
    // anyway — for buddy-read matching only. The assertion, stated
    // plainly: discovering a shared-TBR match is SHELF-BROWSING, not
    // activity. The fetch rides the same circleFriendBooks RLS path
    // as opening their shelves (share_library, hidden shelves and
    // blocks govern what comes back; share_library off → nothing
    // comes back), and v528's ratified presence model is a per-book
    // grant whose server gate (buddy_invite) never consulted
    // share_activity. This restores that consent model; it does not
    // widen it — the activity gate stays exactly where it belongs,
    // on the activity surfaces, via the `stats` view below.
    const activityOff = !!(f.profile && f.profile.share_activity === false);
    // v496 (#140): fetch books + profile concurrently per friend instead of
    // two sequential round-trips. Error semantics: a books failure
    // still skips the friend for stats; a profile failure falls back
    // to f.profile. An activity-off friend was never going to
    // contribute stats, so their row survives a failed fetch with
    // empty stats (and no shelf view, so no matches either).
    const [booksRes, profileRes] = await Promise.all([
      circleFriendBooks(f.id).then(books => ({ ok: true, books }), () => ({ ok: false })),
      circleFriendProfile(f.id).then(profile => ({ ok: true, profile }), () => ({ ok: false }))
    ]);
    const profile = profileRes.ok ? profileRes.profile : (f.profile || null);
    if (!booksRes.ok) {
      if (activityOff) people.push({ id: f.id, name: f.name || 'A friend', profile: profile, stats: statPersonBooks([]), shelfStats: statPersonBooks([]) });
      continue;
    }
    let books = booksRes.books;
    // v524: content shield — a shielded viewer's circle stats are
    // computed WITHOUT friends' adult (high-spice) titles: they leave
    // every aggregate (digest counts, soulmate inputs, buddy reads,
    // now-reading, trending). The viewer's OWN books (people[0], from
    // the local library) are never filtered — the shield never touches
    // your own library.
    if (typeof shieldOn === 'function' && shieldOn() && typeof shieldIsHighSpice === 'function') {
      let smap = {};
      if (typeof shieldSpiceMapFor === 'function') { try { smap = await shieldSpiceMapFor(books); } catch (e) { smap = {}; } }
      books = books.filter(b => !shieldIsHighSpice(b, smap));
    }
    // Two views of the one fetched list (v532): the SHELF view is
    // everything RLS handed back and feeds buddy matching only; the
    // ACTIVITY view is empty unless the friend opted in, and feeds
    // every other surface. Both inherit the shield filtering above,
    // so a shielded viewer's matches compute over filtered books.
    const shelfStats = statPersonBooks(books);
    const stats = activityOff ? statPersonBooks([]) : shelfStats;
    people.push({ id: f.id, name: f.name || 'A friend', profile: profile, stats: stats, shelfStats: shelfStats });
  }
  const me = people[0].stats;
  const others = people.slice(1);

  // Superlatives across the circle (you included). v524: for a shielded
  // viewer the "Spiciest Shelf" award itself is a spice indicator —
  // it's suppressed, not just computed over filtered books.
  const awards = (typeof shieldOn === 'function' && shieldOn())
    ? covenAwards(people).filter(a => a.label !== 'Spiciest Shelf')
    : covenAwards(people);

  // v525: moments — discrete finishes (js/231) for the reaction feed.
  // Computed from the ACTIVITY view of each person (p.stats): a
  // friend who hasn't opted into activity has empty activity stats
  // → no moments (their shelf view, fetched for buddy matching,
  // never reaches this code), and a shielded viewer's friends' books
  // were shield-filtered before this point, so a filtered book yields
  // no moment and its reactions are never fetched. Own books are
  // never filtered (the shield never touches your own library).
  let moments = [];
  if (typeof momentsFromBooks === 'function') {
    const now = new Date();
    const ownM = [], friendM = [];
    people.forEach(p => {
      const ownerId = p.id === 'me'
        ? ((typeof cloudUser !== 'undefined' && cloudUser) ? cloudUser.id : 'me')
        : p.id;
      const list = p.id === 'me' ? ownM : friendM;
      momentsFromBooks(ownerId, p.stats.books, now).forEach(m => { m.person = p; list.push(m); });
    });
    // Your own moments get guaranteed slots: a prolific circle must
    // not push the finishes you received reactions on out of the feed
    // (they're the rows this feature exists to show you). Friends fill
    // the rest; the merged feed stays capped and newest-first.
    const byDayDesc = (a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0);
    ownM.sort(byDayDesc); friendM.sort(byDayDesc);
    moments = ownM.slice(0, 10).concat(friendM.slice(0, 20)).sort(byDayDesc);
    if (typeof MOMENT_FEED_MAX === 'number') moments = moments.slice(0, MOMENT_FEED_MAX);
  }

  // Soulmate scores + taste overlap per friend.
  const soulmates = others.map(p => ({ p: p, sm: soulmateScore(me, p.stats) }))
    .filter(x => x.sm).sort((a, b) => b.sm.score - a.sm.score);

  // Buddy reads per friend. v532: computed from the SHELF view —
  // a shared-TBR match is shelf-browsing, not activity (see the
  // fetch above), so an activity-off friend can still match, while
  // a friend whose RLS fetch returned nothing (library unshared,
  // shelves hidden, blocked) cannot.
  const buddies = [];
  others.forEach(p => {
    const shared = buddyReads(me, p.shelfStats || p.stats);
    if (shared.length) buddies.push({ p: p, books: shared.slice(0, 6) });
  });

  // v541: "Reading it too" — my currently-reading books that a
  // friend is also visibly reading. Computed from the SHELF view
  // (the v532 consent split: shelf-visible is the consent and the
  // share_activity toggle is never consulted; the shield filter
  // above already removed friends' high-spice copies for a shielded
  // viewer, so a suppressed work simply never overlaps). Presence
  // only — js/235 derives nothing from progress, logs, or dates.
  const readingToo = (typeof ritOverlaps === 'function')
    ? ritOverlaps(me.reading || [],
        others.map(p => ({ person: p, reading: ((p.shelfStats || p.stats).reading || []) })))
    : [];

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

  return { people: people, awards: awards, soulmates: soulmates, buddies: buddies, nowReading: nowReading, trending: trending, moments: moments, readingToo: readingToo };
}

// --- UI --------------------------------------------------------------------
export function statAvatar(p) {
  if (p.profile) return circAvatarHTML(p.profile, 'c-avatar');
  // v454: letter circle with the person's initial — never the dragon default
  const initial = esc(String(p.name || '?').trim().charAt(0).toUpperCase() || '?');
  return '<span class="c-avatar letter" aria-hidden="true">' + initial + '</span>';
}
export function covenStatsHTML(d) {
  if (!d || !d.people || d.people.length < 2) return '';
  // v454: tabbed layout — Activity | Buddy reads | Discover
  let activityHTML = '', buddyHTML = '', discoverHTML = '';

  // Soulmate scores -> Discover
  if (d.soulmates.length) {
    discoverHTML += '<div class="circle-card"><h3 style="margin:0 0 10px">Book soulmates</h3>';
    d.soulmates.forEach(x => {
      const bits = [];
      if (x.sm.genres.length) bits.push('both love ' + x.sm.genres.map(esc).join(', '));
      if (x.sm.authors.length) bits.push(esc(x.sm.authors[0]) + (x.sm.authors.length > 1 ? ' +' + (x.sm.authors.length - 1) : ''));
      discoverHTML += '<div class="circle-row">' + statAvatar(x.p) +
        '<div class="circle-meta"><b>' + esc(x.p.name) + '</b>' +
        '<span class="note">' + x.sm.shared + ' books rated in common' + (bits.length ? ' · ' + bits.join(' · ') : '') + '</span>' +
        '<div class="progress-line slim"><div class="fill" style="width:' + x.sm.score + '%"></div></div></div>' +
        '<div class="circle-actions"><b class="serif" style="font-size:20px">' + x.sm.score + '%</b></div></div>';
    });
    discoverHTML += '</div>';
  }

  // v525: Recent finishes — the discrete moments friends can react to
  // (js/231). Newest first across the whole circle, you included (your
  // rows are where reactions you received show up).
  if (d.moments && d.moments.length && typeof momentRowHTML === 'function') {
    activityHTML += '<div class="circle-card"><h3 style="margin:0 0 10px">Recent finishes</h3><div class="circle-list">' +
      d.moments.map(m => momentRowHTML(m)).join('') + '</div></div>';
  }

  // v541: Reading it too (js/235) — shared reads among your own
  // currently-reading books. Renders nothing when there are no
  // overlaps (no heading over nothing, the v535 discipline).
  if (d.readingToo && d.readingToo.length && typeof ritHearthCardHTML === 'function') {
    activityHTML += ritHearthCardHTML(d.readingToo);
  }

  // Circle digest: this month's activity in circle order (you first, then
  // friends). Deliberately unsorted — nobody wins the month; everyone's
  // just visible. No ordinal ranks.
  if (d.people.some(p => p.stats.monthBooks > 0)) {
    activityHTML += '<div class="circle-card"><h3 style="margin:0 0 10px">This month</h3>';
    d.people.forEach(p => {
      const st = p.stats;
      const est = st.monthPagesEst ? ' <span style="color:var(--faint)">est.</span>' : '';
      activityHTML += '<div class="circle-row">' + statAvatar(p) +
        '<div class="circle-meta"><b>' + esc(p.name) + '</b>' +
        '<span class="note">' + st.monthBooks + ' finished · ' + st.monthPages.toLocaleString() + ' pages' + est + '</span></div></div>';
    });
    activityHTML += '</div>';
  }

  // Superlatives — only with 3+ people (you + 2 friends)
  if (d.awards.length && d.people.length >= 3) {
    discoverHTML += '<div class="circle-card"><h3 style="margin:0 0 10px">Superlatives</h3><div class="circle-list">';
    d.awards.forEach(a => {
      discoverHTML += '<div class="circle-row">' + statAvatar(a.person) +
        '<div class="circle-meta"><b>' + esc(a.label) + ' — ' + esc(a.person.name) + '</b>' +
        '<span class="note">' + esc(a.detail) + '</span></div></div>';
    });
    discoverHTML += '</div></div>';
  }

  // Buddy reads
  if (d.buddies.length) {
    buddyHTML += '<div class="circle-card"><h3 style="margin:0 0 4px">Buddy reads</h3>' +
      '<p class="note" style="margin:0 0 10px">On both your TBRs — pick one and read it together.</p><div class="circle-list">';
    d.buddies.forEach(bd => {
      bd.books.forEach(b => {
        buddyHTML += '<div class="circle-row">' + statAvatar(bd.p) +
          '<div class="circle-meta"><b>' + esc(b.title || 'Untitled') + '</b>' +
          '<span class="note">you + ' + esc(bd.p.name) + '</span></div>' +
          // v528: the match becomes an invitation (js/233 wires it;
          // pre-migration the button hides and the card reads as before).
          '<div class="circle-actions"><button class="btn ghost sm" data-buddy-invite="' +
          esc(typeof recoKey === 'function' ? recoKey(b) : '') + '" data-buddy-friend="' + esc(bd.p.id) + '">Read together</button></div></div>';
      });
    });
    buddyHTML += '</div></div>';
  }

  // v532 (RC2): the Buddy tab gets an empty state. Before this, a
  // circle with no shared-TBR matches rendered a literally empty
  // panel — no list, no guidance (UX wave P1-1) — and the tab read
  // as broken rather than merely quiet. If invitations or active
  // reads exist, js/233 removes this note when it paints them.
  if (!buddyHTML) {
    buddyHTML = '<p class="note" id="buddy-empty-note" style="text-align:center;padding:10px 6px">' +
      'Books that sit on both your TBR and a friend\u2019s will show up here, ready to read together. ' +
      'You can also open any book on a friend\u2019s shelf and invite them from there.</p>';
  }

  // v532 (RC2): the same for the Discover tab — when soulmates and
  // awards are empty at render time and recommendations (the
  // #reco-slot, filled async by js/196) don't land either, the tab
  // says so instead of showing a blank. js/196 removes this note
  // when recommendations render.
  if (!discoverHTML) {
    discoverHTML = '<p class="note" id="discover-empty-note" style="text-align:center;padding:10px 6px">' +
      'Nothing here yet \u2014 as your friends share their reading, recommendations and soulmate scores will gather here.</p>';
  }

  // Now reading + trending
  if (d.nowReading.length || d.trending.length) {
    // v532: covenName() already carries the article ("The Hearth")
    // — "Around The Hearth", never "Around the the hearth".
    activityHTML += '<div class="circle-card"><h3 style="margin:0 0 10px">Around ' + esc(covenName()) + '</h3>';
    d.nowReading.slice(0, 6).forEach(nr => {
      activityHTML += '<div class="circle-row">' + statAvatar(nr.p) +
        '<div class="circle-meta"><b>' + esc(nr.p.name) + '</b>' +
        '<span class="note">is reading ' + esc(nr.book.title || 'Untitled') + '</span></div></div>';
    });
    if (d.trending.length) {
      activityHTML += '<p class="note" style="margin:10px 0 0">Trending: ' + d.trending.map(esc).join(' · ') + '</p>';
    }
    activityHTML += '</div>';
  }

  // v454: assemble tabs
  let lastTab = "activity";
  try { lastTab = localStorage.getItem("cozylibram.covenTab") || "activity"; } catch (e) {}
  if (["activity", "buddy", "discover"].indexOf(lastTab) === -1) lastTab = "activity";
  // Activity empty state (Phase 2 will bring the real feed)
  if (!activityHTML) activityHTML = '<p class="note" style="text-align:center">Your friends\u2019 reading will show up here.</p>';
  else activityHTML += '<p class="note" style="text-align:center">Your friends\u2019 reading will show up here.</p>';
  let html = '<div class="seg seg-3" id="coven-tabs" style="margin:12px 0">' +
    '<button data-t="activity"' + (lastTab === "activity" ? ' class="active"' : "") + '>Activity</button>' +
    '<button data-t="buddy"' + (lastTab === "buddy" ? ' class="active"' : "") + '>Buddy reads</button>' +
    '<button data-t="discover"' + (lastTab === "discover" ? ' class="active"' : "") + '>Discover</button></div>' +
    '<div class="coven-tab" id="ctab-activity"' + (lastTab !== "activity" ? ' hidden' : "") + '>' + activityHTML + '</div>' +
    '<div class="coven-tab" id="ctab-buddy"' + (lastTab !== "buddy" ? ' hidden' : "") + '>' + buddyHTML + '</div>' +
    '<div class="coven-tab" id="ctab-discover"' + (lastTab !== "discover" ? ' hidden' : "") + '><div id="reco-slot"></div>' + discoverHTML + '</div>';
  return html;
}

// Fill the #stats-slot left by renderCovenMain; safe to call repeatedly.
export function refreshCovenStats() {
  const slot = document.getElementById('stats-slot');
  if (!slot || typeof circleLists !== 'function') return;
  slot.innerHTML = '<p class="note" style="text-align:center">Crunching ' + esc(covenName().toLowerCase()) + ' stats…</p>';
  loadCovenStats()
    .then(d => {
      const el = document.getElementById('stats-slot');
      if (!el) return;
      el.innerHTML = covenStatsHTML(d);
      // v454: tab switching
      el.querySelectorAll('#coven-tabs button').forEach(b =>
        b.addEventListener('click', () => {
          const t = b.dataset.t;
          try { localStorage.setItem('cozylibram.covenTab', t); } catch (e) {}
          el.querySelectorAll('#coven-tabs button').forEach(x => x.classList.toggle('active', x === b));
          ['activity', 'buddy', 'discover'].forEach(k => {
            const panel = el.querySelector('#ctab-' + k);
            if (panel) panel.hidden = (k !== t);
          });
        }));
      // Recos fill the Discover tab's slot
      if (typeof refreshRecos === 'function') refreshRecos();
      // v525: reactions for exactly the rendered moments
      if (typeof wireMomentReactions === 'function') wireMomentReactions(el, d.moments || []);
      // v528: buddy read invitations + active reads into the Buddy tab
      if (typeof wireBuddyReads === 'function') wireBuddyReads(el);
    })
    .catch(() => {
      // v532 (RC2): a failed load used to erase the slot outright,
      // leaving the Hearth looking merely empty. Say what happened
      // instead of swallowing it.
      const el = document.getElementById('stats-slot');
      if (el) el.innerHTML = '<p class="note" style="text-align:center">Couldn\u2019t load your circle stats just now \u2014 reopen this tab to try again.</p>';
    });
}

/* ---- Compatibility bridge (ES-module transition pattern — see
   docs/es-modules-migration-plan.md §3) ----
   A module's top-level names are module-private: nothing outside this
   file can see them. The consumers — js/195-coven.js, js/231-reactions.js and js/233-buddy-reads.js — reach these
   names at runtime, so the bridge republishes exactly the
   pre-conversion public surface on window. Bare-name lookups in classic
   scripts resolve through the global object, so the caller needs no
   changes. Module scripts are deferred, so the bridge is in place
   before any consumer can run. Remove a name from this bridge only
   when its last classic caller is gone. */
window.statDayKey = statDayKey;
window.statMonthKey = statMonthKey;
window.normGenre = normGenre;
window.pagesInRangeFor = pagesInRangeFor;
window.statStreak = statStreak;
window.topKeys = topKeys;
window.jaccard = jaccard;
window.statPersonBooks = statPersonBooks;
window.soulmateScore = soulmateScore;
window.buddyReads = buddyReads;
window.longestFinishedBook = longestFinishedBook;
window.mostReadAuthor = mostReadAuthor;
window.covenAwards = covenAwards;
window.loadCovenStats = loadCovenStats;
window.statAvatar = statAvatar;
window.covenStatsHTML = covenStatsHTML;
window.refreshCovenStats = refreshCovenStats;
