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

   STORAGE NOTE (v474): Milestones sync across devices via the Supabase
   `milestones` table (see supabase/migrations/v474_milestones_sync.sql).
   localStorage remains the synchronous store and offline fallback; the
   Supabase table is the shared source of truth when signed in. The
   achievement model (detectMilestones + store shape) is still independent
   of the storage adapter — the store functions (loadMilestones /
   saveMilestones) are the seam. Merge rule: union of achieved milestones,
   earliest achievedAt wins, seen is OR. Milestones are never un-earned,
   so the sync is upsert-only (no tombstones).
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
  { id: 'revisit-first', cat: 'discovery', icon: 'bookmark',
    title: 'Revisited',
    copy: 'You returned to a story you\u2019d already finished. Some books deserve a second visit.',
    hint: 'Finish a book you\u2019ve read before' },

  // ---- Phase 1: cozy dark-academia additions ----
  { id: 'stacks-25', cat: 'journey', icon: 'library',
    title: 'The Stacks Are Growing',
    copy: 'Twenty-five books on your shelves. A proper little library.',
    hint: 'Own 25 books' },
  { id: 'stacks-50', cat: 'journey', icon: 'library',
    title: 'The Stacks Are Growing',
    copy: 'Fifty books. Your shelves are becoming a world of their own.',
    hint: 'Own 50 books' },
  { id: 'stacks-100', cat: 'journey', icon: 'library',
    title: 'The Stacks Are Growing',
    copy: 'One hundred books. Keeper of the stacks, indeed.',
    hint: 'Own 100 books' },
  { id: 'stacks-250', cat: 'journey', icon: 'library',
    title: 'The Stacks Are Growing',
    copy: 'Two hundred and fifty books. This is a sanctuary.',
    hint: 'Own 250 books' },
  { id: 'down-bad-5', cat: 'taste', icon: 'heart',
    title: 'Down Bad for Fiction',
    copy: 'Five books rated five stars. You fall hard, and you\u2019re not sorry.',
    hint: 'Give 5 stars to 5 books' },
  { id: 'series-devotee-3', cat: 'discovery', icon: 'covers',
    title: 'Series Devotee',
    copy: 'Three series completed. You commit \u2014 that\u2019s rare and wonderful.',
    hint: 'Finish 3 separate series' },
  { id: 'genres-5', cat: 'taste', icon: 'compass',
    title: 'A Little Bit of Everything',
    copy: 'Five distinct genres explored. Curiosity looks good on you.',
    hint: 'Finish books in 5 different genres' },
  { id: 'authors-new-5', cat: 'discovery', icon: 'quill',
    title: 'Beyond the Familiar',
    copy: 'Five new authors discovered. Your reading world keeps expanding.',
    hint: 'Finish books by 5 new authors' },
  { id: 'alchemist-1', cat: 'taste', icon: 'flask',
    title: 'The Book Alchemist',
    copy: 'A book enriched with your rating, your favorite mark, and its tropes. You make the library richer.',
    hint: 'Fully enrich a book entry' },
  { id: 'pages-day-100', cat: 'rhythm', icon: 'scroll',
    title: 'Lost in the Pages',
    copy: 'One hundred pages in a single day. You were well and truly gone.',
    hint: 'Read 100 pages in one day' },

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
  { id: 'aware-choice-5', cat: 'taste', icon: 'eye',
    title: 'A Thoughtful Choice',
    copy: 'You checked the warnings on 5 books before starting. Informed reader.',
    hint: 'Check content warnings on 5 books before starting' },
  { id: 'taste-devoted-3', cat: 'taste', icon: 'heart',
    title: 'Devoted fan',
    copy: 'Three books by the same author. That\u2019s not casual.',
    hint: 'Read 3 books by one author' },

  // ---- Green wave: TBR archaeology ----
  { id: 'tbr-forgotten-scroll', cat: 'journey', icon: 'scroll',
    title: 'Forgotten Scroll',
    copy: 'A book that waited a year on your shelf finally got its moment. Patience, rewarded.',
    hint: 'Finish a book that sat on your TBR for a year' },
  { id: 'tbr-dust-destiny', cat: 'journey', icon: 'hourglass',
    title: 'Dust and Destiny',
    copy: 'Two years on the shelf. Some stories are worth the wait.',
    hint: 'Finish a book that sat on your TBR for two years' },

  // ---- Green wave: Lorekeeper ----
  { id: 'lore-quotes-10', cat: 'lore', icon: 'quotes',
    title: 'Words Worth Keeping',
    copy: 'Ten passages saved. You collect sentences the way others collect stamps.',
    hint: 'Save 10 quotes' },
  { id: 'lore-notes-5', cat: 'lore', icon: 'quill',
    title: 'Marginalia Society',
    copy: 'Notes in five books. Future you says thanks.',
    hint: 'Write notes in 5 different books' },
  { id: 'lore-characters-3', cat: 'lore', icon: 'friends',
    title: 'Names in the Margins',
    copy: 'Characters tracked across three books. You remember everyone.',
    hint: 'Track characters across 3 books' },
  { id: 'lore-relationships-10', cat: 'lore', icon: 'heart',
    title: 'Web of Fate',
    copy: 'Ten verified connections mapped. Nobody\u2019s just a stranger to you.',
    hint: 'Map 10 character relationships' },

  // ---- Community corpus (v459): Lorekeeper milestones for ACCEPTED
  // contributions only. Never reward raw submissions. Credit is
  // obscurity-weighted (obscure books count more) and capped per book.
  { id: 'lore-trope-archivist', cat: 'lore', icon: 'archive',
    title: 'Trope Archivist',
    copy: 'Your trope suggestions made it into the corpus. The library remembers who helped build it.',
    hint: 'Get 3 trope suggestions accepted by the curator' },
  { id: 'lore-dramatis-personae', cat: 'lore', icon: 'masks',
    title: 'Dramatis Personae',
    copy: 'Characters you suggested joined the wiki. Every cast needs its keeper.',
    hint: 'Get 3 character suggestions accepted by the curator' },
  { id: 'lore-lookout', cat: 'lore', icon: 'lantern',
    title: 'Lookout',
    copy: 'Warnings you suggested now protect fellow readers. That\u2019s looking out for people.',
    hint: 'Get 3 trigger warnings accepted by the curator' },

  // ---- Green wave: Soul ----
  { id: 'soul-ugly-cry-3', cat: 'soul', icon: 'heart',
    title: 'Ugly Cry Club',
    copy: 'Three tearjerkers. You feel things deeply, and you\u2019re not embarrassed about it.',
    hint: 'Read 3 tearjerker books' },

  // ---- Green wave: Rituals ----
  { id: 'ritual-solstice-story', cat: 'ritual', icon: 'sun',
    title: 'Solstice Story',
    copy: 'Finished as the light turned. The year\u2019s hinge, and a story to mark it.',
    hint: 'Finish a book near a solstice or equinox' },

  // ---- Green wave: Hidden discoveries ----
  // Criteria hidden until earned — UI shows ??? for locked hidden milestones.
  { id: 'hidden-stars-aligned', cat: 'hidden', icon: 'star',
    title: 'Stars Aligned',
    copy: 'Finished on the anniversary of the day you shelved it. Some books wait for their moment.',
    hint: '???' },
  { id: 'hidden-pattern-emerges', cat: 'hidden', icon: 'sparkles',
    title: 'A Pattern Emerges',
    copy: 'Three books in a row by the same author. Someone has a new favorite.',
    hint: '???' },
  { id: 'hidden-accidental-trilogy', cat: 'hidden', icon: 'covers',
    title: 'Accidental Trilogy',
    copy: 'Three books of one series, finished back to back. That wasn\u2019t planned \u2014 or was it?',
    hint: '???' },
  { id: 'hidden-book-finds-you', cat: 'hidden', icon: 'compass',
    title: 'The Book Finds You',
    copy: 'Shelved and finished on the same day. Some books refuse to wait.',
    hint: '???' },
];

/* v492: genre source for milestone detectors. `categories` (via bookGenres())
   is the live field; `genres` is kept for legacy book objects that predate it
   and for the existing detector tests, which build books with `genres`. */
function detectorGenres(b) {
  const out = bookGenres(b).slice();
  (b.genres || []).forEach(g => { if (!out.includes(g)) out.push(g); });
  return out;
}

/* Simple string hash for collision-safe IDs (djb2). Renamed from hashStr:
   classic scripts share one global namespace and 120-favorites.js already
   owns that name with a different return type. */
function milestoneIdHash(s) {
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
    // User's refinement: personal best streak (replaces longest session)
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

  // Discovery: revisit — finished a book that was already read before
  const revisited = read.find(b => (b.readCount || 0) >= 2);
  if (revisited) {
    const dt = safeDate(revisited.dateFinished);
    found.push({ id: 'revisit-first', achievedAt: dt ? dt.toISOString() : null, detail: revisited.title });
  }

  // Phase 1: The Stacks Are Growing — library size (owned, not just finished)
  [25, 50, 100, 250].forEach(n => {
    if (lib.length >= n) found.push({ id: 'stacks-' + n, achievedAt: null });
  });

  // Phase 1: Down Bad for Fiction — five 5-star ratings
  try {
    const fiveStars = read.filter(b => (b.myRating || 0) >= 5);
    if (fiveStars.length >= 5) {
      const fifth = fiveStars
        .map(b => ({ b, t: safeDate(b.dateFinished) }))
        .filter(x => x.t).sort((a, b) => a.t - b.t)[4];
      found.push({ id: 'down-bad-5', achievedAt: fifth ? fifth.t.toISOString() : null });
    }
  } catch (e) {}

  // Phase 1: A Little Bit of Everything — 5 distinct genres among finished books
  try {
    const genres = new Set();
    read.forEach(b => {
      detectorGenres(b).forEach(g => {
        const gg = String(g).toLowerCase().trim();
        if (gg) genres.add(gg);
      });
    });
    if (genres.size >= 5) found.push({ id: 'genres-5', achievedAt: null });
  } catch (e) {}

  // Phase 1: Beyond the Familiar — 5 authors new to the reader
  try {
    const byAuthor = {};
    read.forEach(b => {
      (b.authors || []).forEach(a => {
        const t = safeDate(b.dateFinished);
        if (!t) return;
        if (!byAuthor[a] || t < byAuthor[a]) byAuthor[a] = t;
      });
    });
    const authorFirsts = Object.values(byAuthor).sort((a, b) => a - b);
    const readDates = read.map(b => safeDate(b.dateFinished)).filter(Boolean).sort((a, b) => a - b);
    const threshold = readDates[2] || null;
    const discoveries = threshold ? authorFirsts.filter(t => t > threshold) : [];
    if (discoveries.length >= 5) {
      found.push({ id: 'authors-new-5', achievedAt: discoveries[4].toISOString() });
    }
  } catch (e) {}

  // Phase 1: Lost in the Pages — 100+ pages in a single day
  // (User's preference over timer-based sessions: pages-per-day from logs)
  try {
    const pagesByDay = {};
    lib.forEach(b => {
      (b.log || []).forEach(e => {
        if (!e.d || typeof e.to !== 'number' || typeof e.from !== 'number') return;
        const pages = e.to - e.from;
        if (pages <= 0) return;
        pagesByDay[e.d] = (pagesByDay[e.d] || 0) + pages;
      });
    });
    const bigDay = Object.keys(pagesByDay).find(d => pagesByDay[d] >= 100);
    if (bigDay) {
      const dt = safeDate(bigDay);
      found.push({ id: 'pages-day-100', achievedAt: dt ? dt.toISOString() : null, value: pagesByDay[bigDay] });
    }
  } catch (e) {}

  // Phase 1: The Book Alchemist — a finished book enriched with rating +
  // favorite + tropes/characters
  try {
    const enriched = read.find(b =>
      (b.myRating || 0) > 0 &&
      !!b.favorite &&
      ((b.tropes || []).length > 0 || (b.characters || []).length > 0)
    );
    if (enriched) {
      const dt = safeDate(enriched.dateFinished);
      found.push({ id: 'alchemist-1', achievedAt: dt ? dt.toISOString() : null, detail: enriched.title });
    }
  } catch (e) {}

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
    const dr = read.filter(b => detectorGenres(b).some(g => String(g).toLowerCase().indexOf('dark romance') >= 0));
    if (dr.length >= 10) found.push({ id: 'taste-dark-romance-10', achievedAt: null });
  } catch (e) {}

  // Taste: thoughtful warning checks (replaces trigger-bravery, v467)
  // Celebrates agency (checking) not exposure (pushing through).
  try {
    const checked = (typeof library !== 'undefined' ? library : []).filter(b => b && b.triggerCheckSeen).length;
    if (checked >= 5) found.push({ id: 'aware-choice-5', achievedAt: null });
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

  // Discovery: per-series completionist (User's refinement)
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
      const id = 'series-finished-' + slug + '-' + milestoneIdHash(sname);
      // achievedAt = most recent dateFinished among the series books
      const dates = books.map(b => { const d = safeDate(b.dateFinished); return d ? d.getTime() : 0; }).filter(t => t > 0);
      const latest = dates.length ? new Date(Math.max.apply(null, dates)).toISOString() : null;
      found.push({ id, achievedAt: latest, detail: sname });
    });
  } catch (e) {}

  // Phase 1: Series Devotee — 3 separate series completed
  // (runs after per-series detection above)
  try {
    const seriesDone = found.filter(d => d.id.indexOf('series-finished-') === 0);
    if (seriesDone.length >= 3) {
      const dates = seriesDone.map(d => safeDate(d.achievedAt)).filter(Boolean).sort((a, b) => a - b);
      found.push({ id: 'series-devotee-3', achievedAt: dates[2] ? dates[2].toISOString() : null });
    }
  } catch (e) {}

  // ---- Green wave: TBR archaeology ----
  // Finish a book that waited on the shelf (dateAdded -> dateFinished).
  try {
    const DAY = 864e5;
    let firstYear = null, firstTwoYear = null;
    read.forEach(b => {
      const added = safeDate(b.dateAdded);
      const fin = safeDate(b.dateFinished);
      if (!added || !fin) return;
      const wait = fin.getTime() - added.getTime();
      if (wait >= 2 * 365 * DAY && (!firstTwoYear || fin < firstTwoYear)) firstTwoYear = fin;
      if (wait >= 365 * DAY && (!firstYear || fin < firstYear)) firstYear = fin;
    });
    if (firstYear) found.push({ id: 'tbr-forgotten-scroll', achievedAt: firstYear.toISOString() });
    if (firstTwoYear) found.push({ id: 'tbr-dust-destiny', achievedAt: firstTwoYear.toISOString() });
  } catch (e) {}

  // ---- Green wave: Complete Collection (stricter than series-finished) ----
  // Own every known volume AND read them all. Completeness is verifiable only
  // when series positions form a gapless 1..N sequence — otherwise we can't
  // know volumes are missing, so the milestone stays locked (honest).
  try {
    const bySeries = {};
    lib.forEach(b => {
      const sname = b.series && b.series.name;
      if (!sname) return;
      (bySeries[sname] = bySeries[sname] || []).push(b);
    });
    Object.keys(bySeries).forEach(sname => {
      const books = bySeries[sname];
      if (books.length < 2) return;
      const positions = books
        .map(b => parseInt(b.series && b.series.position, 10))
        .filter(n => !isNaN(n) && n > 0)
        .sort((a, b) => a - b);
      // gapless 1..N check
      if (positions.length !== books.length) return;
      for (let i = 0; i < positions.length; i++) {
        if (positions[i] !== i + 1) return;
      }
      if (!books.every(b => b.status === 'read')) return;
      const slug = sname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'unknown';
      const id = 'series-complete-' + slug + '-' + milestoneIdHash(sname);
      const dates = books.map(b => { const d = safeDate(b.dateFinished); return d ? d.getTime() : 0; }).filter(t => t > 0);
      const latest = dates.length ? new Date(Math.max.apply(null, dates)).toISOString() : null;
      found.push({ id, achievedAt: latest, detail: sname });
    });
  } catch (e) {}

  // ---- Green wave: Lorekeeper ----
  // Words Worth Keeping: 10 quotes saved (local b.quotes)
  try {
    let total = 0;
    let tenthDate = null;
    const withQuotes = [];
    lib.forEach(b => {
      const qs = b.quotes || [];
      if (qs.length) withQuotes.push(b);
      total += qs.length;
    });
    if (total >= 10) {
      // achievedAt: when the 10th quote was saved (best effort via quote `at`)
      const allQuotes = [];
      withQuotes.forEach(b => {
        (b.quotes || []).forEach(q => {
          const at = safeDate(q.at || b.dateFinished);
          if (at) allQuotes.push(at);
        });
      });
      allQuotes.sort((a, b) => a - b);
      tenthDate = allQuotes[9] || null;
      found.push({ id: 'lore-quotes-10', achievedAt: tenthDate ? tenthDate.toISOString() : null, value: total });
    }
  } catch (e) {}
  // Marginalia Society: notes on 5 different books (local b.notes)
  try {
    const noted = lib.filter(b => b.notes && String(b.notes).trim().length > 0);
    if (noted.length >= 5) {
      const dates = noted.map(b => safeDate(b.dateFinished) || safeDate(b._mtime)).filter(Boolean).sort((a, b) => a - b);
      found.push({ id: 'lore-notes-5', achievedAt: dates[4] ? dates[4].toISOString() : null, value: noted.length });
    }
  } catch (e) {}

  // ---- Green wave: Soul ----
  // Ugly Cry Club: 3 books with the tearjerker trope
  try {
    const criers = read.filter(b =>
      (b.tropes || []).some(t => String(t.id || t.name || t).toLowerCase() === 'tearjerker')
    );
    if (criers.length >= 3) {
      const dates = criers.map(b => safeDate(b.dateFinished)).filter(Boolean).sort((a, b) => a - b);
      found.push({ id: 'soul-ugly-cry-3', achievedAt: dates[2] ? dates[2].toISOString() : null });
    }
  } catch (e) {}

  // ---- Green wave: Wandering ----
  // Beyond the Map: first finish in a new genre (dynamic per genre).
  // Each genre's first finished book is a discovery.
  try {
    const genreFirst = {};
    read.forEach(b => {
      const t = safeDate(b.dateFinished);
      if (!t) return;
      detectorGenres(b).forEach(g => {
        const gg = String(g).toLowerCase().trim();
        if (!gg) return;
        if (!genreFirst[gg] || t < genreFirst[gg]) genreFirst[gg] = t;
      });
    });
    Object.keys(genreFirst).forEach(gg => {
      const slug = gg.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'unknown';
      const id = 'wander-genre-' + slug + '-' + milestoneIdHash(gg);
      found.push({ id, achievedAt: genreFirst[gg].toISOString(), detail: gg });
    });
  } catch (e) {}

  // ---- Green wave: Rituals ----
  // Solstice Story: finish within a day of a solstice/equinox.
  // Nominal dates (can vary ±1 day year to year); 36h window covers the drift.
  // Locale-aware: uses the date in the user's timezone via local date parts.
  try {
    const anchors = [[3, 20], [6, 21], [9, 22], [12, 21]]; // [month, day]
    const nearAnchor = (d) => {
      const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
      return anchors.some(([am, ad]) => {
        // compare within same year; Dec solstice also checks Jan spillover implicitly via day diff
        const aThis = new Date(y, am - 1, ad);
        const diff = Math.abs(d.getTime() - aThis.getTime());
        return diff <= 36 * 36e5;
      });
    };
    const solsticeBook = byFinish.find(b => {
      const d = safeDate(b.dateFinished);
      return d && nearAnchor(d);
    });
    if (solsticeBook) {
      found.push({ id: 'ritual-solstice-story', achievedAt: new Date(solsticeBook.dateFinished).toISOString(), detail: solsticeBook.title });
    }
  } catch (e) {}

  // ---- Green wave: Hidden discoveries ----
  // Criteria hidden in UI until earned.
  const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  // Stars Aligned: finished on the anniversary (same month/day) of being added, later year
  try {
    const aligned = read.find(b => {
      const added = safeDate(b.dateAdded);
      const fin = safeDate(b.dateFinished);
      if (!added || !fin) return false;
      return fin.getFullYear() > added.getFullYear() &&
        fin.getMonth() === added.getMonth() && fin.getDate() === added.getDate();
    });
    if (aligned) {
      found.push({ id: 'hidden-stars-aligned', achievedAt: new Date(aligned.dateFinished).toISOString(), detail: aligned.title });
    }
  } catch (e) {}
  // A Pattern Emerges: 3 books by the same author finished consecutively
  try {
    const ordered = byFinish.slice(); // already sorted by dateFinished
    for (let i = 0; i + 2 < ordered.length; i++) {
      const trio = [ordered[i], ordered[i + 1], ordered[i + 2]];
      const authors = trio.map(b => (b.authors || [])[0]).filter(Boolean);
      if (authors.length === 3 && authors[0] === authors[1] && authors[1] === authors[2]) {
        found.push({
          id: 'hidden-pattern-emerges',
          achievedAt: new Date(trio[2].dateFinished).toISOString(),
          detail: authors[0],
        });
        break;
      }
    }
  } catch (e) {}
  // Accidental Trilogy: 3 consecutive finishes, all in the same series
  try {
    const ordered = byFinish.slice();
    for (let i = 0; i + 2 < ordered.length; i++) {
      const trio = [ordered[i], ordered[i + 1], ordered[i + 2]];
      const snames = trio.map(b => b.series && b.series.name).filter(Boolean);
      if (snames.length === 3 && snames[0] === snames[1] && snames[1] === snames[2]) {
        found.push({
          id: 'hidden-accidental-trilogy',
          achievedAt: new Date(trio[2].dateFinished).toISOString(),
          detail: snames[0],
        });
        break;
      }
    }
  } catch (e) {}
  // The Book Finds You: added and finished on the same calendar day
  try {
    const impulse = read.find(b => {
      const added = safeDate(b.dateAdded);
      const fin = safeDate(b.dateFinished);
      return added && fin && dayKey(added) === dayKey(fin);
    });
    if (impulse) {
      found.push({ id: 'hidden-book-finds-you', achievedAt: new Date(impulse.dateFinished).toISOString(), detail: impulse.title });
    }
  } catch (e) {}

  return found;
}

/* ---- Store: localStorage (sync) + Supabase (shared) ----
   loadMilestones()/saveMilestones() stay synchronous with the exact old
   contract — localStorage is read fresh on every load, so it remains the
   durable offline copy and the single sync-path store. The Supabase
   `milestones` table is the cross-device truth when signed in: writes push
   on a 2.5s debounce (same cadence as the library sync); reads merge remote
   rows on sign-in and on first sync load (fire-and-forget — the sync path
   never blocks on network). Milestones are never un-earned, so the sync is
   upsert-only. */
const MILESTONE_KEY = 'cozylibram.milestones';
const MILESTONE_OWNER_KEY = 'cozylibram.milestones.owner';
var __msMergedUid = null;    // uid we last merged remote milestones for
var __msMergeRetryAt = 0;    // backoff: don't hammer a failing pull
var __msPushTimer = null;

function msLocalLoad() {
  try { return JSON.parse(localStorage.getItem(MILESTONE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function msLocalSave(store) {
  try { localStorage.setItem(MILESTONE_KEY, JSON.stringify(store)); } catch (e) {}
}
function msOwner() {
  try { return localStorage.getItem(MILESTONE_OWNER_KEY); } catch (e) { return null; }
}
function msSignedUid() {
  try { return (typeof cloudUser !== 'undefined' && cloudUser && cloudUser.id) || null; }
  catch (e) { return null; }
}
function loadMilestones() {
  var store = msLocalLoad();
  // Lazy first-merge: once per signed-in user, pull remote milestones and
  // union them in. Fire-and-forget; a failed pull backs off for 60s.
  var uid = msSignedUid();
  if (uid && __msMergedUid !== uid && Date.now() >= __msMergeRetryAt) {
    __msMergedUid = uid;
    try { syncMilestonesFromCloud().catch(function () {}); } catch (e) {}
  }
  return store;
}
function saveMilestones(store) {
  msLocalSave(store);
  scheduleMilestonePush();
}
/* Reset the sync state on sign-out so the next sign-in re-merges. A pending
   push is flushed first (fire-and-forget): clearing the timer without pushing
   would drop achievements earned <2.5s before sign-out, and the next sign-in
   would overwrite localStorage before they ever reached the cloud. At this
   point in leaveApp the auth session is still valid, so the push lands. */
function resetMilestoneSync() {
  __msMergedUid = null;
  __msMergeRetryAt = 0;
  if (__msPushTimer) {
    clearTimeout(__msPushTimer); __msPushTimer = null;
    try { pushMilestonesToCloud().catch(function () {}); } catch (e) {}
  }
}

/* Pure merge for milestone stores. Union of achieved milestones:
   earliest achievedAt wins, seen is OR, detail prefers the richer copy,
   value (personal-best style) takes the max. No side effects. */
function mergeMilestoneStores(local, remote) {
  var out = {};
  var ids = {};
  Object.keys(local || {}).forEach(function (id) { ids[id] = 1; });
  Object.keys(remote || {}).forEach(function (id) { ids[id] = 1; });
  Object.keys(ids).forEach(function (id) {
    var l = (local || {})[id], r = (remote || {})[id];
    if (l && r) {
      var m = { achievedAt: earliestAchievedAt(l.achievedAt, r.achievedAt), seen: !!(l.seen || r.seen) };
      var detail = (l.detail !== undefined && l.detail !== null) ? l.detail : r.detail;
      if (detail !== undefined && detail !== null) m.detail = detail;
      var lv = (typeof l.value === 'number') ? l.value : null;
      var rv = (typeof r.value === 'number') ? r.value : null;
      if (lv !== null || rv !== null) m.value = Math.max(lv === null ? -Infinity : lv, rv === null ? -Infinity : rv);
      out[id] = m;
    } else {
      out[id] = l || r;
    }
  });
  return out;
}
/* Earliest of two achievedAt values. Compared as Date objects, not ISO
   strings: Supabase returns timestamptz with +00:00 offsets while the client
   writes .000Z, and string comparison would be wrong if formats ever mixed
   (e.g. a local date-only string). Null means "earned before we could date
   it" and loses to any real date. */
function earliestAchievedAt(a, b) {
  if (a && b) {
    var ta = new Date(a).getTime(), tb = new Date(b).getTime();
    if (!isNaN(ta) && !isNaN(tb)) return ta <= tb ? a : b;
  }
  return a || b || null;
}

/* Pull this user's milestone rows, merge with local, write back to both.
   Local-only achievements (earned offline, or pre-sync legacy data) are
   pushed up afterwards — nothing is ever lost in the merge. Silent: the
   merge never triggers celebrations for milestones earned on another device. */
async function syncMilestonesFromCloud() {
  try {
    if (typeof cloudClient !== 'function') return;
    var sb = await cloudClient().catch(function () { return null; });
    var uid = msSignedUid();
    if (!sb || !uid) return;
    var res = await sb.from('milestones').select('milestone_id, achieved_at, seen').eq('user_id', uid);
    if (res.error) throw res.error;
    var remote = {};
    (res.data || []).forEach(function (r) {
      remote[r.milestone_id] = { achievedAt: r.achieved_at || null, seen: !!r.seen };
    });
    var owner = msOwner();
    var local = msLocalLoad();
    var base = (owner && owner !== uid) ? {} : local;
    var merged = mergeMilestoneStores(base, remote);
    msLocalSave(merged);
    try { localStorage.setItem(MILESTONE_OWNER_KEY, uid); } catch (e) {}
    __msMergeRetryAt = 0;
    scheduleMilestonePush();
  } catch (e) {
    __msMergedUid = null;
    __msMergeRetryAt = Date.now() + 60000;
    try { if (typeof AppLog !== 'undefined') AppLog.error('sync', 'milestone pull failed: ' + ((e && e.message) || e)); } catch (_) {}
  }
}

/* Debounced upsert of the whole store. Signed-in only; offline or signed-out
   is a silent no-op (localStorage already has the data). The next save
   re-schedules, so nothing is lost. */
function scheduleMilestonePush() {
  if (__msPushTimer) clearTimeout(__msPushTimer);
  __msPushTimer = setTimeout(function () {
    __msPushTimer = null;
    try { pushMilestonesToCloud().catch(function () {}); } catch (e) {}
  }, 2500);
}
async function pushMilestonesToCloud() {
  try {
    if (typeof cloudClient !== 'function') return;
    var sb = await cloudClient().catch(function () { return null; });
    var uid = msSignedUid();
    if (!sb || !uid) return;
    var store = msLocalLoad();
    var ids = Object.keys(store);
    if (!ids.length) return;
    var now = new Date().toISOString();
    var rows = ids.map(function (id) {
      return {
        user_id: uid,
        milestone_id: id,
        achieved_at: store[id].achievedAt || null,
        seen: !!store[id].seen,
        updated_at: now
      };
    });
    var res = await sb.from('milestones').upsert(rows, { onConflict: 'user_id,milestone_id' });
    if (res.error) throw res.error;
  } catch (e) {
    try { if (typeof AppLog !== 'undefined') AppLog.info('sync', 'milestone push deferred (offline?)'); } catch (_) {}
  }
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
  // Fire-and-forget async social detectors (Supabase-backed characters/
  // relationships). Never blocks the synchronous path.
  try {
    if (typeof checkSocialMilestones === 'function') {
      checkSocialMilestones().catch(function () {});
    }
  } catch (e) {}
  // v459: community corpus milestones (async, Supabase-backed accepted counts)
  try {
    if (typeof checkCommunityMilestones === 'function') {
      checkCommunityMilestones().catch(function () {});
    }
  } catch (e) {}
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

/* ---- Async social detectors (Supabase-backed) ----
   Characters and relationships live in Supabase (book_characters table),
   not on the local book objects — so these can't run in the synchronous
   detectMilestones(). This is fire-and-forget: called from checkMilestones(),
   never blocks, never throws. If Supabase is unavailable, the milestones
   simply don't trigger (safe default, no false positives).

   "Names in the Margins": characters tracked across 3+ distinct works.
   "Web of Fate": 10+ relationship entries with non-empty type+target
   (unverified/empty AI connections don't count). */
async function checkSocialMilestones() {
  try {
    if (typeof CharacterWiki === 'undefined' || !CharacterWiki._sb) return;
    const sb = await CharacterWiki._sb();
    if (!sb) return;
    // Distinct works with tracked characters
    let works = new Set();
    let relCount = 0;
    // Paginate defensively (1000-row pages)
    for (let page = 0; page < 10; page++) {
      const { data, error } = await sb.from('book_characters')
        .select('work_id, relationships')
        .range(page * 1000, page * 1000 + 999);
      if (error || !data || !data.length) break;
      data.forEach(c => {
        if (c.work_id) works.add(c.work_id);
        (c.relationships || []).forEach(r => {
          if (r && r.to && r.type) relCount++;
        });
      });
      if (data.length < 1000) break;
    }
    const store = loadMilestones();
    let changed = false;
    const fresh = [];
    if (works.size >= 3 && !store['lore-characters-3']) {
      store['lore-characters-3'] = { achievedAt: null, seen: false, value: works.size };
      fresh.push('lore-characters-3');
      changed = true;
    }
    if (relCount >= 10 && !store['lore-relationships-10']) {
      store['lore-relationships-10'] = { achievedAt: null, seen: false, value: relCount };
      fresh.push('lore-relationships-10');
      changed = true;
    }
    if (changed) {
      saveMilestones(store);
      // Surface through the same quiet-celebration path if available
      if (typeof onMilestonesEarned === 'function') {
        try { onMilestonesEarned(fresh); } catch (e) {}
      }
    }
  } catch (e) { /* silent: social milestones are best-effort */ }
}

/* ---- Async community-corpus detectors (v459, Supabase-backed) ----
   Lorekeeper milestones for ACCEPTED contributions only — never raw
   submissions. Credit uses the obscurity-weighted sum (cached by
   CommunityCorpus.acceptedCounts, refreshed here). Threshold 3. */
async function checkCommunityMilestones() {
  try {
    if (typeof CommunityCorpus === 'undefined' || !CommunityCorpus.acceptedCounts) return;
    var counts = await CommunityCorpus.acceptedCounts();
    var store = loadMilestones();
    var changed = false;
    var fresh = [];
    /* Weighted threshold 3 per pillar: obscurity-weighted credit, so
       obscure-book contributions count more. Per-book caps enforced
       in the query. Never rewards raw submissions — accepted only. */
    var defs = [
      ['lore-trope-archivist', counts.tropeW || 0, counts.trope || 0],
      ['lore-dramatis-personae', counts.characterW || 0, counts.character || 0],
      ['lore-lookout', counts.triggerW || 0, counts.trigger || 0]
    ];
    defs.forEach(function (d) {
      if (d[1] >= 3 && !store[d[0]]) {
        store[d[0]] = { achievedAt: new Date().toISOString(), seen: false, value: d[2] };
        fresh.push(d[0]);
        changed = true;
      }
    });
    if (changed) {
      saveMilestones(store);
      if (typeof onMilestonesEarned === 'function') {
        try { onMilestonesEarned(fresh); } catch (e) {}
      }
    }
  } catch (e) { /* silent: best-effort */ }
}
function markMilestoneSeen(id) {
  const store = loadMilestones();
  if (store[id]) { store[id].seen = true; saveMilestones(store); }
}
/* ---- v536: the pinned milestone (Strategist S3, built small) ----
   ONE earned milestone the reader chooses to wear. The pin is a user
   preference, so it roams: it lives in its own user_state section
   (milestone_state, js/229) — never in the settings snapshot, whose
   key list is frozen at its v518 shape. On-device it is a single id in
   localStorage; the milestones store itself stays the only record of
   what is earned, and a milestone can never be un-earned, so a stored
   pin can only ever point at an earned milestone. Display: the
   Milestones surface in Chronicles (js/170). user_state is
   own-rows-only, so friends cannot read the pin — no friend-visible
   projection is built on it. */
const MILESTONE_PIN_KEY = 'cozylibram.milestonePin.v1';
function milestonePin() {
  try {
    const id = localStorage.getItem(MILESTONE_PIN_KEY);
    if (!id) return null;
    return loadMilestones()[id] ? id : null; // unearned ids read as no pin
  } catch (e) { return null; }
}
function milestoneSetPin(id) {
  try {
    if (!id) {
      localStorage.removeItem(MILESTONE_PIN_KEY);
    } else {
      if (!loadMilestones()[id]) return false; // cannot pin what isn't earned
      localStorage.setItem(MILESTONE_PIN_KEY, id);
    }
  } catch (e) { return false; }
  // Roam it (hash-gated inside userStatePush; a no-op signed out).
  try { if (typeof userStatePush === 'function') userStatePush(); } catch (e) {}
  return true;
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
  // Dynamic: series-complete-{slug} (stricter — gapless 1..N, all read)
  if (id.indexOf('series-complete-') === 0) {
    const sname = (state && state.detail) || 'a series';
    return {
      id, cat: 'discovery', icon: 'trophy',
      title: 'Complete Collection: ' + sname,
      copy: 'Every volume that exists, on your shelf and read. The whole story, cover to cover.',
      hint: 'Own and read every volume of a series',
    };
  }
  // Dynamic: wander-genre-{slug} (first finish in a genre)
  if (id.indexOf('wander-genre-') === 0) {
    const gname = (state && state.detail) || 'a new genre';
    return {
      id, cat: 'wander', icon: 'compass',
      title: 'Beyond the Map: ' + gname,
      copy: 'Your first finished book in ' + gname + '. New territory.',
      hint: 'Finish a book in a new genre',
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
