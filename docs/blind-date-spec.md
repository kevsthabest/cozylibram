# Blind Date with a Book — Spec

**Status:** Approved by the User (2026-10-15, from the wow-features brainstorm). One PR.
**Rubric snapshot:** Reader value — turns "what do I read next" from a chore of judging covers into a small event. Brief-fit — pass (a choosing delight; no goals, no streaks, no pressure to finish). Moat-fit — medium (the clues are only trustworthy because tropes/spice come from the corpus, not marketing copy). Scope — **S–M**. Placement — **Free**. Displaced surface — none; it's a mode inside Surprise Me, not a new destination.

## 1. What

A "Blind Date" mode of Surprise Me (TBR roulette, js/160; surfaced in Discover's Surprise Me area). The picked book arrives **wrapped**: cover replaced by wrap art, title and author hidden. What shows instead:

- Up to 3 trope chips (corpus/pipeline precedence, as elsewhere).
- Spice level (as the app already displays it).
- Page count and genre.
- A first line, **only where the corpus actually has one** — omitted silently otherwise, never fabricated.

Actions on the wrapped book:
- **Start reading** — unwraps, marks the book reading.
- **Unwrap** — reveals the book without changing its status.
- **Pass** — re-rolls; the passed book returns to the TBR untouched (session-level memory only, so a later blind date can offer it again).

The wrapped state is presentational only: no book data changes until Start Reading.

## 2. Who

The reader standing in front of a large TBR they can't decide on — the exact Surprise Me audience, plus anyone who judges books by covers and knows it.

## 3. Why now

User-approved from the wow brainstorm. Surprise Me already does the hard part (the pick); this is a presentation layer over it, so the wow-per-effort is the best on the list after the Candle.

## 4. Scope

- Blind Date toggle/mode within the Surprise Me flow.
- Wrapped card presentation (Designer: wrap art — reuse the book-frame asset family reserved for spotlight moments).
- Clue rendering from existing fields only.
- Pass / Unwrap / Start Reading actions wired to existing roulette + status flows.

## 5. Dependencies

- Surprise Me / TBR roulette (live).
- Trope + spice display data (live).

## 6. Explicitly out of scope

- Blind dates with books **not** in the reader's TBR (recommendations) — v2 candidate; v1 stays honest and simple.
- No "commitment" mechanics: no lock-in, no record of passes, nothing that turns a pass into a failure.
- No changes to the roulette's pick logic — presentation only.

## 7. Open questions

- Entry point placement inside the remade Discover's Surprise Me area — Builder/Designer per the shipped Discover layout; recommend a "Blind date" secondary action on the Surprise Me banner rather than a separate tile (Discover must not regrow doorways).
- Wrap art direction — Designer's, with the User's veto.
