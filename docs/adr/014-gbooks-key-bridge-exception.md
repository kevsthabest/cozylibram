# ADR-014 — js/061-gbooks-key stays bridge-fed: a documented exception
Date: 2026-10-17 · Status: active

## Context

The bridge pattern (ADR-003) is transitional by design: a converted
file's bridge assignments are deleted as the file is wired to static
imports, and the successor pass has been doing exactly that, file by
file. `js/061-gbooks-key.js` is a real ES module that imports nothing
and bridge-publishes 14 names (`docs/module-map.md` carries the row;
its classic and module consumers — js/060, js/070, js/080, js/092,
js/130, js/135, js/136, js/137, js/139, js/150, js/161 — reach those
names at runtime). On its face it reads as one more unwired file.
It is not: this file cannot be wired without closing an import
cycle.

The cycle, concretely. `js/060-metadata.js` already imports from it —
`import { seedTropes } from './061-gbooks-key.js'` (js/060, line 25).
In the other direction, js/061's own functions resolve their
collaborators through the window bridge at call time, and one of
them is js/060's own export: `lookupISBN` and `searchBooks` call
`normalizeVolume(...)` (js/061, lines 77 and 151), which js/060
defines and bridge-publishes. The remaining call-time reads point
the same way into the already-wired graph: `apiFetch` (js/050),
`track` (js/065), and `autoDetectAxes`, `TROPE_FORMAT_JUNK` and
`bookGenres` (js/020). Converting js/061's bridge reads into static
imports adds the edge js/061 → js/060 for `normalizeVolume`, which
closes a direct two-file cycle against the existing js/060 → js/061
`seedTropes` edge. The question put to the User was whether to wire
it anyway (option B: accept the cycle, or restructure the two files
to break it) or to leave the file bridge-fed and say so (option A).

## Decision

**Option A (Decision, 2026-10-17): `js/061-gbooks-key.js` remains
bridge-fed, as a documented exception — by decision, not by
omission.** Its bridge block and its 14 publications stay as they
are; the file is not wired, and no restructuring of js/060 or js/061
is undertaken to make wiring possible. The exception is recorded
where a reader of the wiring state will see it: the module map's
generator (`scripts/module-map.mjs`) carries a one-entry
BRIDGE_EXCEPTIONS registry naming this record, which marks the
file's row and generates the map's "Documented bridge exceptions"
section.

**Revisit conditions.** The exception lapses — and the file then
joins the normal per-file wiring pattern, with the registry entry
removed in the same change — when any of these stops being true:

- `seedTropes` moves out of js/061, or js/060 stops importing from
  js/061 (the existing edge of the cycle disappears);
- phase 4 (the knot/boot conversion) reshapes the import graph
  around js/060/js/061 so the cycle no longer closes.

The census is unaffected: js/061's publications are still counted
by the ADR-013 method and still included in its totals. An
exception changes a file's status, never its count.

## What we gave up

A completely wired import graph: one file's consumers keep
resolving its names through `window` at call time, indefinitely,
and every future wiring pass must treat this bridge as
load-bearing rather than as burn-down debt. We also give up the
module map's purity: the generator takes exactly one hand-recorded
input (the exceptions registry), because a decision cannot be
derived from source — the tree shows a bridge, never the reason it
stays. The registry is kept minimal (file, ADR, one-line reason,
one-line revisit condition) and the honesty note travels with it,
in the generator's header and in the generated section. The
alternative shapes were worse: wiring through a live cycle makes
two files' load order a correctness question, and restructuring
js/060/js/061 to break the cycle is a change to two working files
in the metadata hot path, bought with nothing but symmetry.

## Evidence

- The two edges, read from the tree: `js/060-metadata.js` line 25
  imports `seedTropes` from `./061-gbooks-key.js`; `js/061-gbooks-key.js`
  calls `normalizeVolume` at lines 77 and 151 with no import in the
  file (its only resolution path is the bridge), and likewise reads
  `apiFetch` (lines 75, 149), `track` (line 36), `autoDetectAxes`
  (lines 205, 225), `TROPE_FORMAT_JUNK` (line 239) and `bookGenres`
  (line 240) at call time.
- The bridge block: `js/061-gbooks-key.js` lines 263–276 publish
  exactly the 14 names the module map's row lists for the file
  (ADR-013 counting method).
- `docs/module-map.md` — js/061's row (module, imports nothing,
  imported-by `060-metadata.js`, 14 value publications), generated
  by `scripts/module-map.mjs`; the same generator change that
  carries this record's registry marks that row
  "(exception: ADR-014)".
- ADR-003 (the bridge-publishing decision and its convergence
  rule) and ADR-013 (the census this file's publications are
  counted in; the convergence rule restated).
- The ruling: Decision, 2026-10-17 — option A, documented
  exception, over wiring through or restructuring around the
  cycle.
