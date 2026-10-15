# The App Dresses for Your Book — Spec

**Status:** Approved by the User (2026-10-15, from the wow-features brainstorm). One PR.
**Rubric snapshot:** Reader value — the app visibly responds to what you're reading; it's the feature a user shows a friend in the first thirty seconds. Brief-fit — pass (presentation delight tied to the current read; nothing tracked, scored, or pressured). Moat-fit — low-medium (uses cover-palette extraction the app already built for spines; no competitor does it). Scope — **M**. Placement — **Free** for the core effect (curated "dressing styles" are a natural premium extension later — not this spec). Displaced surface — none; it's a tint layer over the user's existing theme.

## 1. What

While the reader has a book marked **reading**, the app's accent layer — `--accent`, `--accent-deep`, and the floral tint that follows the accent — shifts to a palette derived from that book's cover, reusing the spine-colour extraction and per-device cache (js/120 family). Buttons, highlights, and tints take on the book's colour; when no book is reading, or the feature is toggled off, the reader's chosen theme applies exactly as today. Transitions fade softly; nothing flashes (the v543 theme-flash lesson applies: resolve before first paint where feasible).

Rules that keep it safe:

- **Accent only.** Backgrounds, surfaces, and body text colours never change. Contrast is structurally preserved.
- **Contrast gate.** The derived accent must pass the same contrast expectations as the built-in accents against the surfaces it tints; if the raw palette fails, shift lightness until it passes; if it still can't, dress in the nearest passing hue or don't dress for that book.
- **Which book.** With several books reading, dress for the one with the most recent progress update.
- **The theme is never replaced.** Dressing is a layer over the reader's theme, and their theme choice remains the base everywhere the accent doesn't reach.

## 2. Who

Every reader, automatically — the wow lands hardest on readers mid-book in a strongly-coloured series (romantasy covers are dramatic for a reason).

## 3. Why now

User-approved from the wow brainstorm. The palette pipeline already exists for spines; the accent-variable theming system (js/010 + styles.css vars) is exactly the seam this needs.

## 4. Scope

- Runtime accent override driven by the current-reading book's cached palette, with the contrast gate.
- Settings → Display toggle: "Dress for my current book" (default ON — the wow needs discovering; the toggle is one tap and permanent off is respected absolutely, including across sync).
- Palette freshness: recompute when the reading book's cover/palette cache updates.

## 5. Dependencies

- Spine palette extraction + cache (live).
- Reading status + progress recency (live).
- Theme system via CSS variables (live).
- Settings sync: the toggle is a user detail — it roams with settings like the other preferences (per the all-details-sync rule).

## 6. Explicitly out of scope

- No background/image dressing, no per-book custom themes, no layout changes.
- No dressing from books not marked reading (hovering a TBR book changes nothing).
- No premium styles in v1.

## 7. Open questions

- Tint strength — Designer's call with two variants for the User's pick (restrained first, per the design QA bar).
- Should the book page itself show a "dressed for this book" hint? Recommend a tiny, dismissible-once note the first time dressing activates, so users understand what happened and where the off switch is.
