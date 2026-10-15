# Your Book as a Candle — Spec

**Status:** Approved by the User (2026-10-15, from the wow-features brainstorm). One PR.
**Rubric snapshot:** Reader value — every book gets a playful, shareable identity card beyond its metadata. Brief-fit — pass (celebration/presentation only; no goals, timers, or pressure). Moat-fit — medium (rides Book Portrait's surface and the corpus's trope/setting data; the mapping table is ours). Scope — **S**. Placement — **Free** (the card); premium share-card styles remain the existing premium lane, not this spec. Displaced surface — none; sits beside Book Portrait.

## 1. What

On the book page, beside Book Portrait, and in the share surfaces: a candle card for the book — a candle name and three scent notes (top / heart / base) derived **deterministically** from the book's own data:

- **Base notes** from setting (coastal → sea salt & driftwood; mountains → cedar & stone; city → rain on pavement).
- **Heart notes** from tropes (enemies-to-lovers → smoke & rose; found family → honey & warm bread; morally grey → leather & ash).
- **Top notes** from genre/mood (gothic → bergamot & candle-smoke; cozy mystery → tea & lemon peel).

The mapping is a curated, versioned data table keyed only off fields the book actually has. No per-render LLM calls; the same book always produces the same candle, so the card has a stable, shareable identity.

## 2. Who

Any reader, on any book in their library — most potent on finished favorites and as a share artifact. The BookTok audience already buys book-inspired candles; this gives every book one, free, instantly.

## 3. Why now

User-approved from the wow brainstorm. It's the smallest build on that list with the highest shareability — the card most likely to travel with the app's name on it.

## 4. Scope

- Candle section on the book page (near Book Portrait), rendered from the mapping table.
- Share card via the existing share-card machinery (js/220 family), visually consistent with the Book Portrait card family.
- Mapping table v1: cover the canonical trope catalogue's high-frequency tropes, main genres, and common setting tags. Curated by hand; extends over time.
- Thin-data behaviour follows the Book Portrait precedent: fewer notes, honestly framed ("this candle pours as the book's data grows") — never notes invented from fields the book doesn't have.

## 5. Dependencies

- Book Portrait's card placement and share machinery (both live).
- Trope/setting/genre fields on the book (live via corpus + pipeline).
- Mapping table curation (Strategist drafts, Designer reviews names for charm).

## 6. Explicitly out of scope

- No re-roll/regenerate button — the candle is deterministic; that's what makes it *the book's* candle.
- No user editing of notes in v1.
- No physical product, no store tie-in (monetization build is parked).
- No LLM generation per render.

## 7. Open questions

- Candle naming pattern — recommend: *"The [evocative noun] Candle"* drawn from setting (e.g. "The Night Court Candle" is IP — avoid; pattern should be descriptive, e.g. "Rain on Stone"). Strategist/Designer to propose 3 name patterns in the PR for the User's veto-style pick.
- Exact placement on the book page relative to Book Portrait — Designer's call in the PR.
