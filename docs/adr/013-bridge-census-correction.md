# ADR-013 — Bridge census correction (supersedes ADR-003's census figure)
Date: 2026-10-17 · Status: active (supersedes ADR-003 as to the census figure only)

## Context

ADR-003's Evidence recorded the ES-modules series-end measurement as
"95 bridge blocks publishing 1,864 names — 20 accessor-published,
1,844 value-published." The Advisor gate on PR #298 re-derived that
figure and found it was produced by counting whole-file text
occurrences of a `window.NAME =` pattern — occurrences, not
publications. The decision ADR-003 records is unaffected; only the
measurement was wrong, by exactly 8.

## Decision

**ADR-003's decision stands, re-affirmed in substance.** A converted
file is a real ES module: named `export`s plus an explicit bridge
block assigning exactly its pre-conversion public surface onto
`window`; cross-file-written names publish through accessor bridges
(`Object.defineProperty` get/set forwarding), never value snapshots.
Convergence rule unchanged: a bridge assignment is deleted when its
last classic consumer converts. No build step.

**The census figure is corrected to 1,856 published names: 1,836
value-published + 20 accessor-published.** This record supersedes
ADR-003 only as to that figure; ADR-003's Evidence bullet stands as
written, with its Status line pointing here.

**Counting method, for every future census.** Count distinct
(file, name) publications in tokenized, comment-stripped source:
a value publication is a `window.NAME =` assignment token sequence,
an accessor publication is an `Object.defineProperty(window, 'NAME',
…)` call. Occurrences are not publications — comparisons, comment
text, and a second assignment of the same name in the same file do
not add to the count.

Precision note: 3 of the 1,836 value publications are genuine
runtime window publications outside the typographic bridge block —
`window.THREE` in js/207-book3d.js and js/215-shelf3d.js, and
`window.__warnRevealWired` in js/070-hardcover.js. A strict
in-block-only count therefore reads 1,853.

## What we gave up

The one-grep occurrence count: cheap, and silently inflated — it
cannot tell a feature check from a publication. We also give up
fixing ADR-003's Evidence in place: records are immutable (§4), so
the wrong figure stays visible in ADR-003 and the correction lives
here, reachable through ADR-003's Status line. A reader who stops
at ADR-003 sees a superseded number; that is the price of an
append-only record, paid deliberately.

## Evidence

- PR #298's Advisor gate — the settling record for the corrected
  figure. Its accounting of the 8-name overcount, by cause:
  6 comparison occurrences the naive pattern mistook for
  assignments (`typeof window.X === 'function'` feature checks —
  js/150-modal-discovery.js ×2, js/160-roulette.js, js/215-shelf3d.js,
  js/225-book-portrait.js ×2 on one line); 1 comment phantom
  (js/215-shelf3d.js, inside a header comment); 1 duplicate
  publication (js/222-community-corpus.js assigns
  `window.CommunityCorpus` twice — guarded and bridge — one distinct
  publication).
- Independent recount prepared with this record: a tokenized,
  comment-stripped census of the top-level `js/*.js` files
  reproducing 1,836 value + 20 accessor = 1,856 distinct (file,
  name) publications, with the accessor set matching ADR-003's 20
  names exactly, and 1,844 − 6 − 1 − 1 = 1,836 reconciling the
  original occurrence count.
- ADR-003 (the decision and the figure it recorded);
  `docs/es-modules-migration-plan.md` (the census method's origin).
