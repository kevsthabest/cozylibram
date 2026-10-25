# ADR-016 — Book modal information architecture: five rooms, Details reads, Lore merges tropes + characters
Date: 2026-10-25 · Status: active

## Context

The book modal (js/150) read as overwhelming, and the weight was
never in its four content tabs. It was (a) the header zone, which
stacked the About slim bar, the Book Portrait slim bar, the Candle
card and the Ambience entry above the tab bar, and (b) the Details
tab, which mixed a read view (rating, quotes, recommendations) with
the entire edit form — about 2.5 viewports of scroll in which
looking and editing competed. The User approved a reorganization
(spec: `~/workspace/prototypes/book-modal-tabs-spec-2026-10-25.md`,
2026-10-25) separating the three intents into their own rooms.

## Decision

**Five tabs: Details | Lore | Notes | Extras | Manage**
(`data-dtab` values `details / lore / notes / extras / manage`).

**Details is a read view.** In order: the Your rating card (first,
per the standing rule that the personal rating is prominent
immediately), About (the blurb, in its slim bar), Memorable quotes,
Reading so far (the Started / Last read summary, read-only), More
like this. No form fields remain in this panel.

**Lore = tropes + characters.** The old Tropes and Characters
panels stack in one `#dtab-lore` panel, tropes first, each keeping
its internal headings, structure and ids. The merge is what makes
five tabs fit the 360px bar without truncation. Programmatic jumps
that name a retired tab land on the merged home, never no-op:
`tropes`/`characters` → `lore`, `portrait` → `extras`, unknown →
Details (mapped both in js/150's `showDTab` and in js/225's
portrait-card jump handler and suggest fallback).

**Extras takes the experiential blocks out of the header.** In
order: Ambience (entry + play control; the player sheet stays
js/241's), Book Portrait (the full card rendered directly — the
slim-bar collapse wrapper is retired), Your Book as a Candle. Each
block keeps its own self-gating; the tab itself is always present
for a predictable bar. When all three blocks render nothing, the
panel shows an honest empty state instead of a void: "Nothing
extra for this book yet — ambience, portrait, and candle land
here when they exist."

**Manage is the whole edit surface.** Everything form from the old
Details panel, in its previous relative order — the Status &
Ownership card, the progress section, the Details form card
(content warnings, Reading Log editing, title, author), the More
details expander — plus one new row: Remove from Library (danger),
bound to the same handler as the ⋯ menu's Remove (which also
stays), so the confirm and the no-flush-into-a-removed-book rule
exist exactly once.

**Relocation only.** The save model is untouched (quiet header
save-state text, instant-apply controls, form commit behaviour),
and every moved block keeps its copy, controls, internal order,
ids and handlers verbatim. The ⋯ menu, the Cover ▾ pill, the
hero, the primary CTA row and the series strip did not change;
the "Reading it too" and Marginalia header slots stay — they
render empty unless populated and were never the standing
clutter. The book modal persists no last-tab preference (the
Coven view's `cozylibram.covenTab` is a different surface), so no
stored tab values needed remapping; the alias map covers live
callers.

## What we gave up

Status and shelf edits sit one tap deeper than before (under
Manage). The primary button still covers Start Reading / Log
Pages / Rate & Review from any tab — `scrollToField` now shows
whichever panel its target lives on — but a quick "mark owned"
style edit is no longer on the first panel. That is the accepted
price of a first panel with nothing to fill in.

The Details read view's Reading so far is a render-time copy of
the log summary; the live copy (the one the progress stepper
re-renders in place) is Manage's, inside the Reading Log. The
two are produced by the same `logSummaryHTML`, so they cannot
disagree at render, but the Details copy does not refresh
mid-session.

## Evidence

- Full serial at the zero baseline with the version-moved leg
  executed (quoted in the PR body).
- Screenshots at 360px and desktop of Details, Lore, Extras and
  Manage, plus the Extras empty state at 360px, under
  `docs/pr-shots/modal-tabs/`.
- The ruling: the User's approved tab-reorganization spec,
  2026-10-25 (Extras empty state: Designer flag, accepted the
  same day).
