# Stats rebalance spec: leveling the field toward understanding

**Status:** spec, not code. The User reviews before anything builds.
**Brief gate:** test #3 — "does it help someone understand a book, or only count
it?" The User's call: keep the numbers, elevate the understanding layer so it's not
outnumbered.

## 1. Audit: what's in Stats today

**Counting** (kept — the User likes them):
- Dashboard: month hero cards (books finished, pages, avg rating, reading time),
  month-over-month note, streak banner, shelves distribution, library value.
- Details: overview row, daily stats, Activity (heatmap, calendar), Pace,
  Records, series completion.

**Understanding** (present, outnumbered ~2:1):
- Details → Taste: spice profile, mood profile, Reading DNA section, DNF
  insights, rating distribution, reading patterns (≤6 observations), genre
  evolution.
- Dashboard: one rotating insight card at top.

**The structural issue:** Dashboard — the default view — is nearly 100%
counting. Understanding lives a tap away in Details → Taste, *below* three
counting sections. A reader who never taps "Details" never meets their own
taste. The fix is placement and weight, not just new modules.

## 2. New understanding content

Everything below reads existing data. No new tracking, no new tables, no new
pressure mechanics.

### 2a. Trope fingerprint (headline addition)
Top tropes across finished books, from `book_trope_claims` (accepted/confirmed
only — the rejections-outrank-candidates rule applies). "You reach for ___."
Plus trope pairs where the data supports it. This is the differentiator most
absent from Stats: tropes are core to the product's identity and invisible in
the numbers. Taste-gated like the existing patterns module.

### 2b. What your 5★s have in common
Trope overlap among top-rated books. "Your 5-star reads are 3× more likely to
feature found family." Same data as 2a, one join further. Gate on a minimum
5-star count; degrade to the standard taste-gate empty state below it.

### 2c. Characters you couldn't put down
Most-favorited characters plus favorite-role distribution ("you fall for the
mentors"). Feeds the characters differentiator from the *attachment* angle —
the wiki covers the books' side, this covers the reader's side.

### 2d. The books you return to
Re-reads framed as attachment, not count. "Three books you've read more than
once — your comfort shelf." Data: status/read history. Counting in service of
understanding.

### 2e. Sensitivity map (private, never shareable)
Trigger categories most encountered across the reader's reading; "you check
warnings most before dark romance." Content-warning history is sensitive data:
it lives on this screen only, is excluded from Wrapped/DNA share cards by
construction, and never aggregates across readers.

### 2f. Elevate, don't just add
The taste-summary module (user-facing today as "Reading DNA" — proposed
rename: "Reader Portrait", see §6) and the patterns module already exist and
are good — they move up (see §3) rather than merely gaining company.

### Anti-proposals (brief guardrails)
- No pace-ranked or "efficiency" insights. Pace stays descriptive, never
  prescriptive.
- No social comparison anywhere in Stats — the amended brief's "unranked" rule
  extends here.
- Insights describe the past, never prescribe the future. "You reach for
  enemies-to-lovers," never "You should try more sci-fi." No goals derived
  from patterns (test #1).

## 3. Layout

**Principle:** understanding leads, counting stays. The default view must
introduce the reader to their own taste.

- **Dashboard:** one understanding hero module directly under the month hero
  cards — the trope fingerprint ("You reach for ___") as the default, falling
  back to the rotating insight card when data is thin. Dashboard becomes:
  numbers (month) → who you are as a reader → gentle month note → the rest.
  Counting keeps its home; it stops being the only home.
- **Details:** reorder sections to Activity → Taste → Pace → Records (Taste
  above Pace, in both the section nav and scroll order). Test #3 as information
  architecture: understand first, then the mechanics of counting.
- **Taste internal order:** taste summary ("Reader Portrait", §6) → trope
  fingerprint → 5★ commons → patterns → character attachment → mood/spice →
  genre evolution → DNF insights → rating distribution. Newest and most
  differentiating first.
- **Shareables:** Wrapped and Reader Portrait (§6) share cards may include the
  trope fingerprint and 5★ commons (playful, shareable). Sensitivity map and
  DNF insights never appear in shareables.

## 4. Data & gating notes (for the Builder)

- New modules read: `book_trope_claims` (accepted/confirmed), character
  favorites, status/read history, warning-check events. Nothing new is tracked.
- Reuse the tasteGate pattern everywhere: thin data degrades to the existing
  "finish and rate a few more books" empty state. No invented insights, ever.
- Insights are deterministic (the patternsHTML precedent) — no per-render
  model calls.
- Copy rule (brief voice): past tense, warm, brief. Observations, never
  prescriptions.

## 6. Rename: "Reading DNA" → "Reader Portrait"

**Direction (2026-10-11):** the *name* "Reading DNA" retires from user-facing
copy — the phrasing, not the concept. Internal code names (`js/212-dna.js`,
function names, the `dna_shared` event) stay untouched.

**Proposed: "Reader Portrait".** Follows the established precedent — internal
"Book DNA" ships user-facing as "Book Portrait". One learnable concept: a
Portrait is Cozy Libram's little summary of what something is like — the book's
portrait, the reader's portrait. Consistent, warm, and already proven in the
product's voice. Backup: "Tasting Notes".

**Scope:** 9 user-facing strings across `js/170-stats.js` (2),
`js/212-dna.js` (5), `js/220-share-moments.js` (2) — section header ("My Reader
Portrait"), share-card title, canvas filename/label. Rolls into the rebalance
build. Code comments may be updated incidentally; nothing structural changes.

## 7. Open questions (the User / UX Tester)

- Dashboard hero: trope fingerprint pinned, or rotate among understanding
  modules the way the insight card does today?
- "Characters you couldn't put down" (personal, Stats) vs. "Loved by N readers"
  (commons, character flywheel spec) — same screen, or separate homes?
- Sensitivity map: is "you check warnings most before X" exactly the
  trust-building the warnings pillar promises, or too revealing even privately?
