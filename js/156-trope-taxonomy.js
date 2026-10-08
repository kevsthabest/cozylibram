'use strict';

/* ---------------- Trope taxonomy (v151) ----------------
   The canonical, versioned, genre-aware trope list. Curated by hand —
   the LLM inference client (v152) may ONLY tag books with these ids;
   anything else it returns is dropped. Ships with the app so tagging
   prompts work offline and self-hosted copies get it for free.

   The `tropes` Supabase table mirrors this list (supabase/tropes.sql);
   community proposals live in `trope_proposals` until an admin approves
   them into the canon (v155), at which point this file is re-exported.

   Shape: { id, name, description, genres[] }
   - id: stable slug, lowercase alnum + hyphens.
   - genres: subset of TROPE_GENRES — used to filter the prompt per book
     so a sci-fi blurb never sees romance-only tropes.
   v207: TROPE_ALIASES / TROPE_EXCLUSIONS map model-emitted variants to
   canonical ids (or veto them); tropeResolveId() is the only entry point
   and returns canonical ids exclusively. */

const TROPE_TAXONOMY_VERSION = 1;

const TROPE_GENRES = [
  'romance', 'dark-romance', 'fantasy', 'sci-fi',
  'mystery-thriller', 'horror', 'historical', 'contemporary', 'non-fiction',
];

const TROPES = [
  /* ---- romance / dark romance ---- */
  { id: 'enemies-to-lovers', name: 'Enemies to Lovers',
    description: 'Two characters who start out hostile or opposed fall for each other.',
    genres: ['romance', 'dark-romance', 'fantasy'] },
  { id: 'forced-proximity', name: 'Forced Proximity',
    description: 'Circumstances trap two characters together until feelings develop.',
    genres: ['romance', 'dark-romance', 'fantasy', 'contemporary'] },
  { id: 'grumpy-x-sunshine', name: 'Grumpy x Sunshine',
    description: 'A brooding, closed-off character paired with a cheerful optimist.',
    genres: ['romance', 'dark-romance', 'contemporary'] },
  { id: 'slow-burn', name: 'Slow Burn',
    description: 'Romantic tension builds gradually over most of the story.',
    genres: ['romance', 'dark-romance', 'fantasy'] },
  { id: 'forbidden-love', name: 'Forbidden Love',
    description: 'The romance is barred by family, duty, law, or society.',
    genres: ['romance', 'dark-romance', 'fantasy', 'historical'] },
  { id: 'fated-mates', name: 'Fated Mates',
    description: 'Destiny, biology, or magic declares two characters meant for each other.',
    genres: ['romance', 'dark-romance', 'fantasy'] },
  { id: 'fake-dating', name: 'Fake Dating',
    description: 'A pretend relationship staged for appearances turns real.',
    genres: ['romance', 'contemporary'] },
  { id: 'marriage-of-convenience', name: 'Marriage of Convenience',
    description: 'Wed for practical reasons — money, protection, alliance — then fall in love.',
    genres: ['romance', 'dark-romance', 'historical', 'fantasy'] },
  { id: 'arranged-marriage', name: 'Arranged Marriage',
    description: 'Families or rulers dictate the match; the couple must make it work.',
    genres: ['romance', 'dark-romance', 'historical', 'fantasy'] },
  { id: 'second-chance', name: 'Second Chance',
    description: 'Former lovers reunite years later and try again.',
    genres: ['romance', 'contemporary'] },
  { id: 'secret-baby', name: 'Secret Baby',
    description: 'A hidden pregnancy or child complicates the romance.',
    genres: ['romance', 'dark-romance', 'contemporary'] },
  { id: 'love-triangle', name: 'Love Triangle',
    description: 'One character torn between two love interests.',
    genres: ['romance', 'dark-romance', 'fantasy'] },
  { id: 'billionaire', name: 'Billionaire',
    description: 'An ultra-wealthy love interest with power to reshape the heroine\u2019s world.',
    genres: ['romance', 'dark-romance', 'contemporary'] },
  { id: 'mafia', name: 'Mafia',
    description: 'Organized-crime families, loyalty codes, and dangerous devotion.',
    genres: ['romance', 'dark-romance', 'mystery-thriller'] },
  { id: 'bully', name: 'Bully',
    description: 'A cruel or tormenting love interest who softens into devotion.',
    genres: ['romance', 'dark-romance'] },
  { id: 'stalker', name: 'Stalker',
    description: 'Obsessive pursuit framed as dark, possessive romance.',
    genres: ['dark-romance', 'mystery-thriller'] },
  { id: 'kidnapping', name: 'Kidnapping',
    description: 'Abduction sparks a twisted captor-captive dynamic.',
    genres: ['dark-romance', 'mystery-thriller'] },
  { id: 'captive', name: 'Captive / Captor',
    description: 'One character held by the other; power and desire blur.',
    genres: ['dark-romance', 'fantasy', 'mystery-thriller'] },
  { id: 'revenge', name: 'Revenge',
    description: 'A quest for vengeance drives the plot — sometimes aimed at a lover.',
    genres: ['dark-romance', 'fantasy', 'mystery-thriller'] },
  { id: 'morally-grey', name: 'Morally Grey Love Interest',
    description: 'The love interest does terrible things and the story loves them anyway.',
    genres: ['dark-romance', 'fantasy'] },
  { id: 'age-gap', name: 'Age Gap',
    description: 'A significant age difference the story treats as a feature.',
    genres: ['romance', 'dark-romance', 'contemporary'] },
  { id: 'single-dad', name: 'Single Dad',
    description: 'A devoted father balancing parenthood with new love.',
    genres: ['romance', 'contemporary'] },
  { id: 'workplace-romance', name: 'Workplace Romance',
    description: 'Sparks fly between colleagues, bosses, or rivals at work.',
    genres: ['romance', 'contemporary'] },
  { id: 'small-town', name: 'Small Town Romance',
    description: 'Close-knit town, nosy neighbors, and love around every corner.',
    genres: ['romance', 'contemporary'] },
  { id: 'friends-to-lovers', name: 'Friends to Lovers',
    description: 'Longtime friends realize the real thing was there all along.',
    genres: ['romance', 'contemporary'] },
  { id: 'secret-relationship', name: 'Secret Relationship',
    description: 'The couple hides their romance from everyone around them.',
    genres: ['romance', 'dark-romance'] },
  { id: 'bodyguard', name: 'Bodyguard',
    description: 'Hired protection turns into something far more personal.',
    genres: ['romance', 'dark-romance', 'mystery-thriller'] },
  { id: 'royalty', name: 'Royalty',
    description: 'Princes, kings, and court intrigue meet romance.',
    genres: ['romance', 'fantasy', 'historical'] },
  { id: 'amnesia', name: 'Amnesia',
    description: 'Memory loss erases — or rewrites — a love story.',
    genres: ['romance', 'mystery-thriller'] },
  { id: 'pregnancy', name: 'Pregnancy',
    description: 'An unexpected pregnancy forces two people together.',
    genres: ['romance', 'dark-romance'] },
  { id: 'why-choose', name: 'Why Choose / Reverse Harem',
    description: 'The heroine keeps them all — no choosing between love interests.',
    genres: ['dark-romance', 'fantasy', 'romance'] },
  { id: 'stepbrother', name: 'Stepbrother (Taboo)',
    description: 'Blended-family proximity with a forbidden charge.',
    genres: ['dark-romance', 'romance'] },
  { id: 'biker', name: 'Biker / MC',
    description: 'Motorcycle-club culture: brotherhood, danger, loyalty.',
    genres: ['romance', 'dark-romance'] },
  { id: 'vampire', name: 'Vampire',
    description: 'Blood-drinkers as lovers, predators, or aristocrats.',
    genres: ['dark-romance', 'fantasy', 'horror', 'romance'] },
  { id: 'werewolf', name: 'Werewolf',
    description: 'Shifters, packs, and moon-driven instinct.',
    genres: ['dark-romance', 'fantasy', 'romance'] },
  { id: 'shifter', name: 'Shifter (Non-Wolf)',
    description: 'Characters who change into animals other than wolves.',
    genres: ['dark-romance', 'fantasy', 'romance'] },
  { id: 'dark-academia', name: 'Dark Academia',
    description: 'Elite schools, classical obsession, secrets in the stacks.',
    genres: ['romance', 'fantasy', 'mystery-thriller'] },
  { id: 'misunderstanding', name: 'Misunderstanding',
    description: 'A wrong assumption or missed conversation drives the conflict \u2014 solvable by one honest talk.',
    genres: ['romance', 'dark-romance', 'contemporary'] },
  { id: 'redemption', name: 'Redemption',
    description: 'A character with a dark past fights to atone and earn forgiveness.',
    genres: ['fantasy', 'romance', 'dark-romance'] },
  { id: 'protective-partner', name: 'Protective Partner',
    description: 'One partner is fiercely, sometimes possessively, protective of the other.',
    genres: ['romance', 'dark-romance'] },

  /* ---- fantasy ---- */
  { id: 'chosen-one', name: 'Chosen One',
    description: 'Prophecy or destiny singles out an unlikely hero.',
    genres: ['fantasy'] },
  { id: 'magic-academy', name: 'Magic Academy',
    description: 'A school for magic users — lessons, rivalries, deadly exams.',
    genres: ['fantasy', 'romance'] },
  { id: 'dragons', name: 'Dragons',
    description: 'Dragons as mounts, bonded partners, or ancient powers.',
    genres: ['fantasy', 'romance'] },
  { id: 'found-family', name: 'Found Family',
    description: 'Misfits who choose each other and become family.',
    genres: ['fantasy', 'sci-fi', 'contemporary', 'romance'] },
  { id: 'quest', name: 'Quest',
    description: 'A journey to find, deliver, or destroy something vital.',
    genres: ['fantasy'] },
  { id: 'hidden-powers', name: 'Hidden Powers',
    description: 'The protagonist conceals — or discovers — extraordinary abilities.',
    genres: ['fantasy', 'sci-fi'] },
  { id: 'reluctant-hero', name: 'Reluctant Hero',
    description: 'Dragged into heroism against every instinct to stay out.',
    genres: ['fantasy', 'sci-fi'] },
  { id: 'dark-lord', name: 'Dark Lord',
    description: 'A supreme evil whose shadow hangs over the whole story.',
    genres: ['fantasy'] },
  { id: 'prophecy', name: 'Prophecy',
    description: 'A foretelling that shapes — or misleads — the characters.',
    genres: ['fantasy'] },
  { id: 'political-intrigue', name: 'Political Intrigue',
    description: 'Courts, councils, and factions scheming for power.',
    genres: ['fantasy', 'sci-fi', 'historical', 'mystery-thriller'] },
  { id: 'hard-magic', name: 'Hard Magic System',
    description: 'Magic with strict rules, costs, and clever exploitation.',
    genres: ['fantasy'] },
  { id: 'portal-fantasy', name: 'Portal Fantasy',
    description: 'An ordinary person crosses into a magical world.',
    genres: ['fantasy'] },
  { id: 'epic-battle', name: 'Epic Battle',
    description: 'Large-scale warfare decides the fate of kingdoms.',
    genres: ['fantasy', 'sci-fi'] },
  { id: 'secret-identity', name: 'Secret Identity',
    description: 'A character hides who they really are \u2014 name, lineage, powers, or allegiance.',
    genres: ['fantasy', 'romance', 'dark-romance', 'mystery-thriller', 'sci-fi'] },
  { id: 'sacrifice', name: 'Sacrifice',
    description: 'A character gives up something precious \u2014 power, safety, love, or life \u2014 for others.',
    genres: ['fantasy', 'romance', 'dark-romance', 'sci-fi', 'contemporary'] },
  { id: 'mentorship', name: 'Mentorship',
    description: 'An experienced guide trains the protagonist, shaping their growth.',
    genres: ['fantasy', 'sci-fi', 'contemporary', 'romance'] },

  /* ---- sci-fi ---- */
  { id: 'ai-uprising', name: 'AI Uprising',
    description: 'Artificial intelligence turns on its creators — or demands rights.',
    genres: ['sci-fi', 'mystery-thriller'] },
  { id: 'space-opera', name: 'Space Opera',
    description: 'Sweeping interstellar adventure across star systems.',
    genres: ['sci-fi'] },
  { id: 'first-contact', name: 'First Contact',
    description: 'Humanity meets alien intelligence for the first time.',
    genres: ['sci-fi'] },
  { id: 'time-travel', name: 'Time Travel',
    description: 'Characters move through time and face the paradoxes.',
    genres: ['sci-fi', 'romance', 'mystery-thriller'] },
  { id: 'dystopia', name: 'Dystopia',
    description: 'An oppressive future regime the characters resist or survive.',
    genres: ['sci-fi'] },
  { id: 'cyberpunk', name: 'Cyberpunk',
    description: 'High tech, low life: neon cities, hackers, megacorps.',
    genres: ['sci-fi'] },
  { id: 'generation-ship', name: 'Generation Ship',
    description: 'A self-contained world aboard a centuries-long voyage.',
    genres: ['sci-fi'] },
  { id: 'alien-invasion', name: 'Alien Invasion',
    description: 'Earth under attack by an extraterrestrial force.',
    genres: ['sci-fi', 'horror'] },
  { id: 'deadly-trials', name: 'Deadly Trials',
    description: 'A brutal competition where losing means death.',
    genres: ['fantasy', 'sci-fi'] },
  { id: 'faceless-enemy', name: 'Faceless Enemy',
    description: 'An adversary whose identity or nature stays hidden.',
    genres: ['sci-fi', 'mystery-thriller', 'horror'] },
  { id: 'dead-mans-switch', name: "Dead Man's Switch",
    description: 'A contingency that triggers on the creator\u2019s death or silence.',
    genres: ['sci-fi', 'mystery-thriller'] },
  { id: 'unlikely-alliance', name: 'Unlikely Alliance',
    description: 'Enemies or strangers forced to cooperate against a bigger threat.',
    genres: ['sci-fi', 'fantasy'] },

  /* ---- mystery / thriller ---- */
  { id: 'whodunit', name: 'Whodunit',
    description: 'A classic puzzle mystery: uncover the culprit among suspects.',
    genres: ['mystery-thriller'] },
  { id: 'unreliable-narrator', name: 'Unreliable Narrator',
    description: 'The narrator\u2019s version of events can\u2019t be trusted.',
    genres: ['mystery-thriller', 'horror'] },
  { id: 'locked-room', name: 'Locked Room',
    description: 'An impossible crime in a sealed space.',
    genres: ['mystery-thriller'] },
  { id: 'cold-case', name: 'Cold Case',
    description: 'An old unsolved crime reopened years later.',
    genres: ['mystery-thriller'] },
  { id: 'serial-killer', name: 'Serial Killer',
    description: 'A repeating murderer hunted across the story.',
    genres: ['mystery-thriller', 'horror'] },
  { id: 'conspiracy', name: 'Conspiracy',
    description: 'A hidden network pulling strings behind events.',
    genres: ['mystery-thriller', 'sci-fi'] },
  { id: 'double-cross', name: 'Double-Cross',
    description: 'Alliances flip; nobody\u2019s loyalty is what it seemed.',
    genres: ['mystery-thriller'] },
  { id: 'missing-person', name: 'Missing Person',
    description: 'A disappearance drives the search for truth.',
    genres: ['mystery-thriller'] },
  { id: 'small-town-secrets', name: 'Small-Town Secrets',
    description: 'A quiet town where everyone is hiding something.',
    genres: ['mystery-thriller', 'horror'] },
  { id: 'betrayal', name: 'Betrayal',
    description: 'A trusted ally or loved one turns against the protagonist.',
    genres: ['romance', 'dark-romance', 'fantasy', 'mystery-thriller', 'contemporary'] },
  { id: 'heist', name: 'Heist',
    description: 'A planned theft or infiltration requiring teamwork, timing, and deception.',
    genres: ['fantasy', 'mystery-thriller', 'sci-fi', 'contemporary'] },
  { id: 'mind-game', name: 'Mind Game',
    description: 'Characters wage psychological warfare \u2014 manipulation, mind games, and head trips.',
    genres: ['mystery-thriller', 'dark-romance', 'horror'] },

  /* ---- horror ---- */
  { id: 'haunted-house', name: 'Haunted House',
    description: 'A dwelling with a malign presence or history.',
    genres: ['horror'] },
  { id: 'possession', name: 'Possession',
    description: 'An entity takes over a human body or mind.',
    genres: ['horror'] },
  { id: 'folk-horror', name: 'Folk Horror',
    description: 'Rural rituals, old gods, and communities with dark customs.',
    genres: ['horror'] },
  { id: 'cosmic-horror', name: 'Cosmic Horror',
    description: 'Vast indifferent entities; humanity\u2019s insignificance is the scare.',
    genres: ['horror', 'sci-fi'] },
  { id: 'final-girl', name: 'Final Girl',
    description: 'One survivor — usually a young woman — outlasts the horror.',
    genres: ['horror'] },
  { id: 'found-footage', name: 'Found Footage',
    description: 'The story unfolds through recovered recordings or documents.',
    genres: ['horror'] },
  { id: 'body-horror', name: 'Body Horror',
    description: 'Terror through transformation, mutation, or violation of the flesh.',
    genres: ['horror', 'sci-fi'] },
  { id: 'ghost-hunter', name: 'Ghost Hunter',
    description: 'A protagonist who investigates or hunts the paranormal, as calling or profession.',
    genres: ['horror', 'mystery-thriller'] },
  { id: 'survivor-guilt', name: 'Survivor Guilt',
    description: 'A character is haunted by surviving when others did not.',
    genres: ['horror', 'dark-romance', 'fantasy'] },

  /* ---- historical / contemporary / non-fiction ---- */
  { id: 'war-story', name: 'War Story',
    description: 'Armed conflict and its cost, on the front or the home front.',
    genres: ['historical'] },
  { id: 'coming-of-age', name: 'Coming of Age',
    description: 'A young protagonist grows up over the course of the story.',
    genres: ['contemporary', 'historical'] },
  { id: 'road-trip', name: 'Road Trip',
    description: 'The journey — literal miles — changes the travelers.',
    genres: ['contemporary'] },
  { id: 'family-drama', name: 'Family Drama',
    description: 'Intergenerational conflict, inheritance, and old wounds.',
    genres: ['contemporary', 'historical'] },
  { id: 'memoir', name: 'Memoir',
    description: 'A true personal life story, told by the one who lived it.',
    genres: ['non-fiction'] },
  { id: 'true-crime', name: 'True Crime',
    description: 'Real criminal cases investigated and retold.',
    genres: ['non-fiction', 'mystery-thriller'] },
];

/* Pure: look up one trope by id. Returns the trope or null. */
function tropeById(id) {
  if (!id) return null;
  for (const t of TROPES) if (t.id === id) return t;
  return null;
}

/* ---------------- Aliases & exclusions (v207) ----------------
   The model doesn't always emit the exact canonical id — it writes
   "reverse harem" instead of "why-choose", "morally gray" instead of
   "morally-grey". Rather than dropping those near-misses (lost tags) or
   accepting free text (invented tags), validation resolves them here:
   aliases map a variant to its canonical id, exclusions veto a variant
   that is too generic to auto-map.

   Only canonical ids ever leave the resolver — storage, claims, and the
   UI never see an alias. Live `tropes` table rows may carry their own
   `aliases`/`exclusions` arrays (added v207); a row-level array, when
   present, overrides the bundled map below for that trope. */

const TROPE_ALIASES = {
  'enemies-to-lovers': ['enemy to lover', 'enemies to lover'],
  'forced-proximity': ['forced closeness'],
  'grumpy-x-sunshine': ['grumpy sunshine', 'grumpy/sunshine'],
  'fated-mates': ['fated mate', 'destined mates'],
  'fake-dating': ['fake relationship'],
  'marriage-of-convenience': ['convenience marriage'],
  'second-chance': ['second chance romance'],
  'secret-baby': ['hidden baby'],
  'mafia': ['mob', 'mafia romance', 'organized crime'],
  'bully': ['bullying', 'bullies'],
  'stalker': ['stalking'],
  'kidnapping': ['kidnap'],
  'captive': ['captor', 'captive/captor', 'captive romance'],
  'morally-grey': ['morally gray', 'morally gray love interest', 'morally grey love interest'],
  'age-gap': ['age difference'],
  'single-dad': ['single father'],
  'workplace-romance': ['office romance'],
  'small-town': ['small town romance'],
  'friends-to-lovers': ['friend to lover'],
  'royalty': ['royals'],
  'amnesia': ['memory loss'],
  'pregnancy': ['unplanned pregnancy', 'pregnant'],
  'why-choose': ['why choose', 'reverse harem'],
  'stepbrother': ['step brother'],
  'biker': ['bikers', 'mc romance', 'motorcycle club'],
  'vampire': ['vampires'],
  'werewolf': ['werewolves'],
  'shifter': ['shifters', 'shapeshifter', 'shapeshifters'],
  'magic-academy': ['magic school'],
  'dragons': ['dragon'],
  'hidden-powers': ['hidden magic'],
  'political-intrigue': ['court intrigue'],
  'hard-magic': ['hard magic'],
  'ai-uprising': ['robot uprising'],
  'dystopia': ['dystopian'],
  'dead-mans-switch': ["dead man's switch", 'dead man switch'],
  'whodunit': ['who dunnit', 'murder mystery'],
  'locked-room': ['locked room mystery'],
  'double-cross': ['double cross'],
  'missing-person': ['missing persons'],
  'possession': ['possessed', 'demonic possession'],
  'cosmic-horror': ['lovecraftian'],
  'war-story': ['military'],
  'coming-of-age': ['bildungsroman'],
};

const TROPE_EXCLUSIONS = {
  /* Terms deliberately never auto-mapped: considered, rejected as too
     generic. Documented here so nobody re-adds them as aliases.
     v314: 'betrayal' removed — now a canonical trope in its own right. */
  'royalty': ['prince', 'princess'],
};

/* Pure: normalize a free-text trope term to slug form so "Enemies To
   Lovers", "enemies_to_lovers" and "enemies-to-lovers" all match. */
function tropeNormTerm(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* Pure: resolve a free-text term to a canonical trope id, or null.
   Order: exact id → alias (unless excluded for that trope). Only
   canonical ids are ever returned. `pool` defaults to the bundled list;
   pass the merged live list (whose rows may carry aliases/exclusions)
   and row-level arrays take precedence over the bundled maps. */
function tropeResolveId(term, pool) {
  const n = tropeNormTerm(term);
  if (!n) return null;
  const list = pool || TROPES;
  for (const t of list) if (t && t.id === n) return t.id;
  for (const t of list) {
    if (!t || !t.id) continue;
    const ex = Array.isArray(t.exclusions) ? t.exclusions : (TROPE_EXCLUSIONS[t.id] || []);
    if (ex.some(x => tropeNormTerm(x) === n)) continue;
    const al = Array.isArray(t.aliases) ? t.aliases : (TROPE_ALIASES[t.id] || []);
    if (al.some(a => tropeNormTerm(a) === n)) return t.id;
  }
  return null;
}

/* Pure: tropes whose genres intersect the book's genres. Used to keep the
   LLM prompt small and genre-relevant. Unknown genres are ignored.
   v157: optional `pool` (live merged taxonomy); defaults to TROPES. */
function tropesForGenres(genres, pool) {
  const want = new Set((genres || []).map(g => String(g).toLowerCase()));
  const list = pool || TROPES;
  if (!want.size) return list.slice();
  return list.filter(t => t.genres.some(g => want.has(g)));
}

/* Pure: normalize a trope name for dedup ("Forced Proximity!" -> "forcedproximity"). */
function tropeNameKey(name) {
  return String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/* Pure: split a name into normalized words for fuzzy matching. */
function tropeWords(name) {
  return String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/* Pure: fuzzy-ish match of a free-text name against the canonical taxonomy.
   Returns { trope, score } for the best match, or null. Used by the proposal
   flow to redirect near-duplicates ("forced closeness" -> forced-proximity).
   score: 1 = exact name_key match, 0.9 = one contains the other,
   otherwise word overlap ratio. */
/* v157: optional `pool` so callers can fuzzy-match over the live (merged)
   taxonomy instead of just the bundled file. Defaults to TROPES. */
function findSimilarTrope(name, pool) {
  const key = tropeNameKey(name);
  if (!key) return null;
  const words = new Set(tropeWords(name));
  let best = null, bestScore = 0;
  for (const t of (pool || TROPES)) {
    const tk = tropeNameKey(t.name);
    if (tk === key) return { trope: t, score: 1 };
    let score = 0;
    if (tk.includes(key) || key.includes(tk)) {
      score = 0.9;
    } else {
      const tWords = new Set(tropeWords(t.name));
      let overlap = 0;
      words.forEach(w => { if (tWords.has(w)) overlap++; });
      score = overlap / Math.max(words.size, tWords.size);
    }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best && bestScore >= 0.5 ? { trope: best, score: bestScore } : null;
}

/* Pure: build a collision-safe slug from a proposed name. `taken` is a Set
   of ids already in use. "Forced Proximity" -> "forced-proximity",
   "forced-proximity-2" on collision. */
function tropeSlugFor(name, taken) {
  const base = String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'trope';
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(base + '-' + n)) n++;
  return base + '-' + n;
}
