# The Finale — Series Completion Ceremony — Spec

**Status:** Approved by the User (2026-10-15, from the wow-features brainstorm). One PR.
**Rubric snapshot:** Reader value — finishing a long series is one of the biggest emotional moments in a reading life; today it gets the same quiet checkmark as a novella. Brief-fit — pass (celebrates what already happened; looks only backward; no "next book" pressure). Moat-fit — medium-high (series + character data from the corpus; the ratings arc is the reader's own). Scope — **S–M**. Placement — **Free** (a celebration of the reader's own data; withholding it would fail the placement test). Displaced surface — none; the ceremony presents once, the keepsake lives in the series view.

## 1. What

When a reader finishes a series, the app marks the moment:

- **Trigger.** The reader marks read a book that is the highest series position in their library, with every book of that series in their library read. Two honest labels:
  - **"Series complete"** — only when the corpus/metadata knows the series total and this book's position equals it.
  - **"All caught up"** — library-complete, but the total is unknown or more may exist. The app never claims "complete" it can't back (earned, not guessed).
- **The ceremony.** A celebration card (milestone-card pattern, dismissible) presents once per series per reader: series name, the journey span (first finish date → finale date), books count, total pages, the ratings arc (per-book stars in series order), and a favorite character from the series if the reader has one favorited.
- **The keepsake.** The card persists in the series view and is shareable via the existing share-card machinery.
- **The wax seal.** A "Series complete" series gains a wax-seal mark on its shelf/series header (Designer asset). Caught-up series do not get the seal — the seal means *complete*.

## 2. Who

Series readers — the app's core audience reads romantasy and fantasy series almost by default. The longer the series, the bigger the moment this honors.

## 3. Why now

User-approved from the wow brainstorm. All inputs already exist (series name/position, finish dates, ratings, pages, character favorites) — this is composition, not new data.

## 4. Scope

- Completion detection on the mark-read path (idempotent: once per series per reader; re-reads don't re-trigger).
- Ceremony card + persistent keepsake in the series view + share card.
- Wax seal rendering for complete series.
- Manual override on the series view: "Mark as finished" for edge cases (middle book owned in another format, out-of-order reading). The override produces the **caught-up** card, never the seal, unless the total is known and met.

## 5. Dependencies

- Series model (`b.series.name` / `b.series.position` — live).
- Finish dates, ratings, page counts (live).
- Share-card machinery (live).
- Seal asset (Designer).

## 6. Explicitly out of scope

- No detection across books not in the reader's library (we celebrate *their* shelf, not the bibliography).
- No "finish the series" prompts, nudges, or incomplete-series lists anywhere — the ceremony only ever looks backward.
- No changes to milestone families (this is a moment, not a milestone; it doesn't enter the milestone catalogue).

## 7. Open questions

- Seal art — Designer's, User's veto applies.
- Does the ceremony auto-present on the mark-read flow (recommend yes, milestone-card pattern) or wait in the series view (recommend no — the moment is the point)? Strategist recommends auto-present, once, dismissible.
