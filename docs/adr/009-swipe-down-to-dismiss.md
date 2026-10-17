# ADR-009 — Every sheet dismisses by swipe-down, through one shared helper
Date: 2026-10-12 · Status: active

## Context

Sheets and modals are the app's dominant surface on phones. Close behaviour
that differs per sheet — a button here, no gesture there — is a papercut
repeated daily, and hand-rolled drag implementations drift apart: scroll
conflicts, flick thresholds, scroll-lock bugs, each sheet its own dialect.
The gesture also interacts with real content: sheets contain horizontally
scrolling rails (chip rows, similar-books carousels) whose swipes must never
be stolen by the dismiss gesture.

## Decision

Every sheet and modal ships with downward-drag-to-dismiss, wired through the
shared helper `wireSheetDrag`, or through a documented equivalent where the
helper genuinely cannot apply. A sheet without the gesture is unfinished,
not a variant, and new surfaces get the gesture when they are built — not in
a later consistency pass. The helper's contract:

- The sheet follows the finger only when its scrollable content is at the
  very top (`scrollTop <= 0`); otherwise the gesture is a normal content
  scroll. Dismissal fires past a shared distance threshold or on a
  downward flick (the helper's constants, one tuning for every surface).
- A drag that starts inside a nested horizontally scrollable descendant
  belongs to that scroller, not to the sheet; predominantly horizontal
  gestures are content swipes.
- Touch only; desktop keeps the close button. Wiring is idempotent and
  pairs the drag with the body scroll lock.

The helper lives in `js/055-sheetdrag.js`, extracted from the modal module
at v553 as a pure relocation, so the machinery loads before all consumers
(first consumer is js/134).

## What we gave up

- Per-sheet gesture tuning: thresholds and feel are the helper's, shared by
  every surface, so no sheet gets a bespoke dismissal personality.
- Implementation freedom for unusual surfaces: an exception must ship as a
  documented equivalent, never as a quiet variant.

## Evidence

- AGENTS.md, "Cozy Libram app conventions" — the rule as recorded: swipe-to-
  dismiss on every sheet/modal via the shared helper or a documented
  equivalent (Decision, 2026-10-12).
- `js/055-sheetdrag.js` — `wireSheetDrag` defined at line 60 and republished
  for classic consumers at line 141; the header records the v553 extraction;
  lines 41–45 and 75 carry the nested-horizontal-scroller refusal (v511).
- `docs/gift-purchase-spec.md` §4 — a later spec citing the rule as a given:
  the "Send this gift" sheet ships "swipe-down-to-dismiss per the app rule,
  like every sheet."
