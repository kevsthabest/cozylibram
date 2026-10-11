/* ---- Milestones (v448): quiet one-time achievements from reading life.
   Deterministic detectors, durable store, backfill for existing users.
   Perks query milestone IDs later; no perk logic lives here.

   Principles:
   1. Deterministic: same library history → same milestones, no AI, no side effects.
   2. Retroactive: existing readers get credit without a celebration flood.
   3. Durable: once earned, never silently removed. Future thresholds use live counts.
   4. Separate concerns: earned vs seen vs perk-unlocked are independent.
   5. Quiet: new milestones get an inline dashboard moment, not a modal.
   6. Stable IDs: {category}-{metric}-{threshold}. Never rename an ID.

   Store: localStorage 'cozylibram.milestones' = { id: { achievedAt: ISO|null, seen: bool } }
   achievedAt null = "earned before we could date it". Never invent dates.

   STORAGE NOTE (v448): Milestones are local-only (localStorage). They do not
   sync across devices via the existing Supabase sync. This is intentional for
   v1 — the achievement model (detectMilestones + store shape) is independent
   of the storage adapter, so a future sync adapter can be added without
   changing detectors or the catalog. If this changes, the store functions
   (loadMilestones/saveMilestones) are the seam.
*/

/* Catalog: id, category, title, copy (warm, playful-never-mocking), hint for locked */
const MILESTONE_CATALOG = [
  // ---- Journey: cumulative counts ----
  { id: 'books-finished-1', cat: 'journey', icon: 'sprout',
    title: 'First finished book',
    copy: 'The first of many. Every library starts with one.',
    hint: 'Finish your first book' },
  { id: 'books-finished-10', cat: 'journey', icon: 'covers',
    title: '10 books finished',
    copy: 'You\u2019ve made room for ten stories. Here\u2019s to the next one.',
    hint: 'Finish 10 books' },
  { id: 'books-finished-25', cat: 'journey', icon: 'covers',
    title: '25 books finished',
    copy: 'A quarter hundred. Your shelf is becoming a library.',
    hint: 'Finish 25 books' },
  { id: 'books-finished-50', cat: 'journey', icon: 'library',
    title: '50 books finished',
    copy: 'Fifty stories lived. That\u2019s a proper reading life.',
    hint: 'Finish 50 books' },
  { id: 'books-finished-100', cat: 'journey', icon: 'trophy',
    title: '100 books finished',
    copy: 'One hundred. You\u2019re not a reader, you\u2019re a landscape.',
    hint: 'Finish 100 books' },

  // ---- Rhythm: streaks and patterns ----
  { id: 'streak-days-7', cat: 'rhythm', icon: 'flame',
    title: '7-day streak',
    copy: 'A week of showing up for yourself. Lovely rhythm.',
    hint: 'Read 7 days in a row' },
  { id: 'streak-days-30', cat: 'rhythm', icon: 'flame',
    title: '30-day streak',
    copy: 'A month of daily reading. That\u2019s devotion.',
    hint: 'Read 30 days in a row' },
  { id: 'streak-personal-best', cat: 'rhythm', icon: 'crown',
    title: 'Personal best streak',
    copy: 'Your longest reading run ever. Can you beat it?',
    hint: 'Set a personal reading streak record',
    dynamic: true },
  { id: 'seasons-all-four', cat: 'rhythm', icon: 'leaf',
    title: 'Read in all four seasons',
    copy: 'Spring pages, summer chapters, autumn verses, winter tales.',
    hint: 'Log reading in each season' },

  // ---- Discovery: firsts ----
  { id: 'first-five-star', cat: 'discovery', icon: 'star',
    title: 'First 5-star rating',
    copy: 'You found one that rearranged the furniture in your head.',
    hint: 'Rate a book 5 stars' },
  { id: 'first-dnf', cat: 'discovery', icon: 'heart',
    title: 'First DNF \u2014 and that\u2019s okay',
    copy: 'Knowing what you don\u2019t like is also reading. Trust your gut.',
    hint: 'Mark a book as did-not-finish' },
  { id: 'returning-author-6mo', cat: 'discovery', icon: 'compass',
    title: 'Reunited with an old favorite',
    copy: 'Back to an author you hadn\u2019t touched in half a year. Good to see them again.',
    hint: 'Return to an author after 6+ months away' },

  // ---- Taste: personalized patterns ----
  { id: 'taste-trope-5', cat: 'taste', icon: 'sparkles',
    title: 'You have a type',
    copy: 'Five books sharing a favorite trope. We see you.',
    hint: 'Read 5 books sharing a favorite trope',
    dynamic: true },
  { id: 'taste-dark-romance-10', cat: 'taste', icon: 'moon',
    title: 'You like it dangerous',
    copy: 'Ten dark romances. No judgment \u2014 only admiration.',
    hint: 'Read 10 dark romances',
    genre: 'dark romance' },
  { id: 'taste-brave-12', cat: 'taste', icon: 'shield',
    title: 'Fearless reader',
    copy: 'Twelve books with 3+ trigger warnings. You don\u2019t flinch.',
    hint: 'Read 12 books with 3+ trigger warnings' },
  { id: 'taste-devoted-3', cat: 'taste', icon: 'heart',
    title: 'Devoted fan',
    copy: 'Three books by the same author. That\u2019s not casual.',
    hint: 'Read 3 books by one author' },
  { id: 'taste-fearless-star', cat: 'taste', icon: 'star',
    title: 'Brave heart',
    copy: 'A 5-star rating on a book with 5+ warnings. Bold taste.',
    hint: 'Give 5 stars to a book with 5+ trigger warnings' },
];

/* Simple string hash for collision-safe IDs (djb2). */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* Safe date parsing: returns a valid Date or null. Never throws. */
function safeDate(v) {
  if (!v) return null;
  try {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  } catch (e) { return null; }
}

/* Pure streak calculator: takes a library, returns longest consecutive-day run.
   Mirrors longestStreak() in 040-storage.js but without the global dependency. */
function longestStreakFor(lib) {
  const days = new Set();
  const dk = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
  (lib || []).forEach(b => {
    (b.log || []).forEach(e => { if (e.to > e.from) days.add(e.d); });
    if (b.status === 'read' && b.dateFinished) {
      const dt = new Date(b.dateFinished);
      if (!isNaN(dt.getTime())) days.add(dk(dt));
    }
  });
  const sorted = Array.from(days).sort();
  let best = 0, run = 0, prev = null;
  sorted.forEach(k => {
    const t = new Date(k + 'T12:00:00').getTime(); // local noon dodges DST edges
    if (isNaN(t)) return;
    run = (prev != null && t - prev === 864e5) ? run + 1 : 1;
    if (run > best) best = run;
    prev = t;
  });
  return best;
}

/* ---- Pure detectors: library -> [{ id, achievedAt }] ----
   achievedAt is an ISO date string when determinable, null when the
   milestone is earned but the date can't be established. Never invent. */
function detectMilestones(lib) {
  const found = [];
  const read = lib.filter(b => b.status === 'read');
  const byFinish = read
    .filter(b => safeDate(b.dateFinished))
    .sort((a, b) => safeDate(a.dateFinished) - safeDate(b.dateFinished));

  // Journey: Nth finished book — date from the Nth book's dateFinished
  [1, 10, 25, 50, 100].forEach(n => {
    if (read.length >= n) {
      const nth = byFinish[n - 1];
      const dt = nth ? safeDate(nth.dateFinished) : null;
      found.push({ id: 'books-finished-' + n, achievedAt: dt ? dt.toISOString() : null });
    }
  });

  // Rhythm: streaks (pure — calculated from the supplied library)
  try {
    const best = longestStreakFor(lib);
    if (best >= 7) found.push({ id: 'streak-days-7', achievedAt: null });
    if (best >= 30) found.push({ id: 'streak-days-30', achievedAt: null });
    // Kevin's refinement: personal best streak (replaces longest session)
    if (best > 0) found.push({ id: 'streak-personal-best', achievedAt: null, value: best });
  } catch (e) {}

  // Rhythm: all four seasons (from dateFinished or log dates)
  try {
    const seasons = new Set();
    const seasonOf = m => m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'autumn' : 'winter';
    lib.forEach(b => {
      (b.log || []).forEach(e => {
        if (e.d) seasons.add(seasonOf(parseInt(e.d.split('-')[1], 10)));
      });
      if (b.dateFinished) seasons.add(seasonOf(new Date(b.dateFinished).getMonth() + 1));
    });
    if (seasons.size >= 4) found.push({ id: 'seasons-all-four', achievedAt: null });
  } catch (e) {}

  // Discovery: firsts
  // First 5-star: use the earliest dateFinished among 5-star books.
  // Note: this is the finish date, not necessarily when the rating was given —
  // CozyLibram doesn't store a separate rating timestamp. We document this
  // fallback rather than presenting an arbitrary date.
  const fiveStars = read.filter(b => (b.myRating || 0) >= 5);
  if (fiveStars.length) {
    const dated = fiveStars
      .map(b => ({ b, t: b.dateFinished ? new Date(b.dateFinished).getTime() : 0 }))
      .filter(x => x.t > 0 && !isNaN(x.t))
      .sort((a, b) => a.t - b.t);
    const earliest = dated.length ? dated[0].b : fiveStars[0];
    const dt = earliest.dateFinished ? new Date(earliest.dateFinished) : null;
    found.push({
      id: 'first-five-star',
      achievedAt: dt && !isNaN(dt.getTime()) ? dt.toISOString() : null,
    });
  }
  const dnf = lib.find(b => b.status === 'dnf');
  if (dnf) found.push({ id: 'first-dnf', achievedAt: null });

  // Discovery: returning to an author after 6+ month gap
  // (renamed from "new author" — the detector finds a reader coming back
  // to an author they hadn't touched in half a year)
  try {
    const SIX_MO = 6 * 30.44 * 864e5;
    const authorBooks = {};
    lib.forEach(b => {
      (b.authors || []).forEach(a => {
        (authorBooks[a] = authorBooks[a] || []).push(b);
      });
    });
    for (const a of Object.keys(authorBooks)) {
      const dates = authorBooks[a]
        .map(b => b.dateFinished ? new Date(b.dateFinished).getTime() : 0)
        .filter(t => t > 0 && !isNaN(t)).sort((x, y) => x - y);
      for (let i = 1; i < dates.length; i++) {
        if (dates[i] - dates[i - 1] >= SIX_MO) {
          found.push({ id: 'returning-author-6mo', achievedAt: new Date(dates[i]).toISOString(), detail: a });
          break;
        }
      }
      if (found.some(f => f.id === 'returning-author-6mo')) break;
    }
  } catch (e) {}

  // Taste: trope affinity (5+ books sharing a trope)
  try {
    const tropeCount = {};
    read.forEach(b => {
      (b.tropes || []).forEach(t => {
        const key = String(t.id || t.name || t).toLowerCase();
        tropeCount[key] = (tropeCount[key] || 0) + 1;
      });
    });
    const top = Object.keys(tropeCount).sort((a, b) => tropeCount[b] - tropeCount[a])[0];
    if (top && tropeCount[top] >= 5) found.push({ id: 'taste-trope-5', achievedAt: null, detail: top });
  } catch (e) {}

  // Taste: dark romance count
  try {
    const dr = read.filter(b => (b.genres || []).some(g => String(g).toLowerCase().indexOf('dark romance') >= 0));
    if (dr.length >= 10) found.push({ id: 'taste-dark-romance-10', achievedAt: null });
  } catch (e) {}

  // Taste: trigger-warning bravery
  try {
    const brave = read.filter(b => (b.triggerWarnings || b.contentWarnings || []).length >= 3);
    if (brave.length >= 12) found.push({ id: 'taste-brave-12', achievedAt: null });
    const fearless = brave.find(b => (b.myRating || 0) >= 5 && (b.triggerWarnings || b.contentWarnings || []).length >= 5);
    if (fearless) found.push({ id: 'taste-fearless-star', achievedAt: fearless.dateFinished ? new Date(fearless.dateFinished).toISOString() : null });
  } catch (e) {}

  // Taste: devoted fan (3+ books, one author)
  try {
    const authorCount = {};
    read.forEach(b => {
      (b.authors || []).forEach(a => { authorCount[a] = (authorCount[a] || 0) + 1; });
    });
    const top = Object.keys(authorCount).sort((a, b) => authorCount[b] - authorCount[a])[0];
    if (top && authorCount[top] >= 3) found.push({ id: 'taste-devoted-3', achievedAt: null, detail: top });
  } catch (e) {}

  // Discovery: per-series completionist (Kevin's refinement)
  // 2+ books owned in a series, all read. One milestone per series.
  // Re-earnable: reading a newly-added book updates achievedAt.
  try {
    const bySeries = {};
    lib.forEach(b => {
      const sname = b.series && b.series.name;
      if (!sname) return;
      (bySeries[sname] = bySeries[sname] || []).push(b);
    });
    Object.keys(bySeries).forEach(sname => {
      const books = bySeries[sname];
      if (books.length < 2) return; // single book never counts
      const allRead = books.every(b => b.status === 'read');
      if (!allRead) return;
      // Collision-safe ID: slug + hash of the full name. Display name kept in detail.
      const slug = sname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'unknown';
      const id = 'series-finished-' + slug + '-' + hashStr(sname);
      // achievedAt = most recent dateFinished among the series books
      const dates = books.map(b => { const d = safeDate(b.dateFinished); return d ? d.getTime() : 0; }).filter(t => t > 0);
      const latest = dates.length ? new Date(Math.max.apply(null, dates)).toISOString() : null;
      found.push({ id, achievedAt: latest, detail: sname });
    });
  } catch (e) {}

  return found;
}

/* ---- Store: localStorage, idempotent, backfill-safe ---- */
const MILESTONE_KEY = 'cozylibram.milestones';
function loadMilestones() {
  try {
    return JSON.parse(localStorage.getItem(MILESTONE_KEY) || '{}');
  } catch (e) { return {}; }
}
function saveMilestones(store) {
  try { localStorage.setItem(MILESTONE_KEY, JSON.stringify(store)); } catch (e) {}
}
/* Check for new milestones. Idempotent: never recomputes achievedAt once set,
   EXCEPT for re-earnable series milestones (updates achievedAt when extended). */
function checkMilestones() {
  if (typeof library === 'undefined' || !library) return [];
  const store = loadMilestones();
  const detected = detectMilestones(library);
  const fresh = [];
  detected.forEach(d => {
    if (!store[d.id]) {
      store[d.id] = { achievedAt: d.achievedAt || null, seen: false };
      if (d.detail) store[d.id].detail = d.detail;
      if (d.value != null) store[d.id].value = d.value;
      fresh.push(d.id);
    } else if (d.id.indexOf('series-finished-') === 0 && d.achievedAt) {
      // Re-earnable: series extended with a newly-read book — update the date
      const prev = store[d.id].achievedAt;
      if (!prev || d.achievedAt > prev) {
        store[d.id].achievedAt = d.achievedAt;
        store[d.id].seen = false; // celebrate the extension
        fresh.push(d.id);
      }
    } else if (d.id === 'streak-personal-best' && d.value != null) {
      // Personal best: update the record value when beaten
      if ((store[d.id].value || 0) < d.value) {
        store[d.id].value = d.value;
        store[d.id].seen = false;
        fresh.push(d.id);
      }
    }
  });
  saveMilestones(store);
  return fresh;
}
/* Backfill: same as check, but marks everything seen (no celebration flood). */
function backfillMilestones() {
  if (typeof library === 'undefined' || !library) return;
  const store = loadMilestones();
  // only backfill once — if the key exists at all, we've already done it
  if (localStorage.getItem(MILESTONE_KEY) !== null) return;
  detectMilestones(library).forEach(d => {
    store[d.id] = { achievedAt: d.achievedAt || null, seen: true };
  });
  saveMilestones(store);
}
function markMilestoneSeen(id) {
  const store = loadMilestones();
  if (store[id]) { store[id].seen = true; saveMilestones(store); }
}
/* Resolve a milestone ID to its definition, including dynamic series ones. */
function milestoneDef(id, state) {
  const def = MILESTONE_CATALOG.find(m => m.id === id);
  if (def) {
    // Personal best: inject the record value into the copy
    if (id === 'streak-personal-best' && state && state.value) {
      return Object.assign({}, def, {
        title: 'Personal best: ' + state.value + '-day streak',
        copy: 'Your longest reading run ever: ' + state.value + ' days. Can you beat it?',
      });
    }
    // Trope affinity: generate copy from the actual detected trope
    if (id === 'taste-trope-5' && state && state.detail) {
      const tropeName = state.detail;
      return Object.assign({}, def, {
        copy: 'Five books with the ' + tropeName + ' trope. We see you.',
      });
    }
    return def;
  }
  // Dynamic: series-finished-{slug}
  if (id.indexOf('series-finished-') === 0) {
    const sname = (state && state.detail) || 'a series';
    return {
      id, cat: 'discovery', icon: 'covers',
      title: 'Finished your ' + sname + ' collection',
      copy: 'Every book you own in this series, read. That\u2019s commitment.',
      hint: 'Read all owned books in a series',
    };
  }
  return null;
}
function newestUnseenMilestone() {
  const store = loadMilestones();
  const ids = Object.keys(store).filter(id => !store[id].seen);
  if (!ids.length) return null;
  // most recently achieved first (null dates sort last)
  ids.sort((a, b) => {
    const da = store[a].achievedAt, db = store[b].achievedAt;
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return db.localeCompare(da);
  });
  const id = ids[0];
  const def = typeof milestoneDef === 'function' ? milestoneDef(id, store[id]) : MILESTONE_CATALOG.find(m => m.id === id);
  return def ? { def, state: store[id] } : null;
}
