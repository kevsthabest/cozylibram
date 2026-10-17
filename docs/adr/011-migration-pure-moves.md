# ADR-011 — Conversions are pure moves; the comment pass is a separate phase
Date: 2026-10-16 · Status: active

## Context

The ES-modules migration converted the tree's module files in three phases
(95 of 104 top-level JS files; the rest sit behind the phase-4 boundary).
Each conversion's correctness claim rests on identity evidence: a
census-verified export surface, a bridge that republishes the identical
objects, and a suite run at exactly baseline. That evidence only exists if
a conversion changes nothing but the wiring. In the middle of the series
the User adopted the comment standard (2026-10-16): comments explain *why*
in plain sentences, never restate the code, and a wrong comment is worse
than none — which made every stale comment in a file being converted a
temptation to fix it on the spot.

## Decision

A conversion is a pure move — nothing changes but the wiring (exports
added, bridge appended, the script tag flipped). Comments are carried
verbatim, including stale and mechanical ones: during the migration a stale
comment is carried, not fixed, and is **not a finding** at any gate.
Applying the comment standard to existing files is a successor phase over
the finished modular tree, with its own spec and review — the combined
headers/wiring pass (docs/repo-legibility-spec.md §9) — never smeared into
conversion diffs. The standard governs *new* code from its adoption date;
nothing applies it retroactively inside this program.

## What we gave up

- Opportunistic cleanup: known-stale comments were knowingly carried
  through dozens of conversions on the promise of a later pass — had that
  pass never been scheduled, the migration would have preserved the mess
  it touched.
- Review convenience: two wanted changes (wiring, comments) took two
  programs instead of one, because a combined diff would have made a
  wording change and a wiring change indistinguishable in review and
  destroyed the surface-identity proof each conversion stood on.

## Evidence

- `docs/es-modules-migration-plan.md` §4, item 10 — "A conversion is a pure
  move — nothing changes but the wiring"; and the §4 passage that follows
  it: "Comments are carried verbatim… carried, not fixed, and is not a
  finding at any gate."
- Same plan, §13 — the successor-phase seed text, stamped "(User decision,
  2026-10-16, re-sequenced the same day: the comment updates apply after
  the migration completes, not during it)", including why: keeping the
  passes separate "preserves this program's evidence discipline".
- AGENTS.md — the comment standard itself (adopted 2026-10-16), including
  the same sequencing note for existing files.
