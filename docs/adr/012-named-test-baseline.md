# ADR-012 — The test baseline is named, and moves only by named decision
Date: 2026-10-14 · Status: active

## Context

The suite carries failures that pre-date the current tree — assertions
pinned to facts that later, legitimate decisions changed. Two failure modes
threaten from opposite sides: fixing or deleting those assertions in
passing would destroy the record of what changed and why; tolerating
failures wholesale would make the suite useless as a merge gate, because a
new failure would hide inside tolerated noise. The repo needed a tolerated
set that is exact — and a change to that set that is loud.

## Decision

The tolerated set is a **named baseline**, recorded in CONSTRAINTS.md: each
entry names the suite file and its failing assertion, and a run is "green"
when it shows exactly those failures and no new one. The baseline moves
only by a named decision — its own reviewed change, with the reason stated,
never folded silently into a fix. No agent weakens, skips, deletes, or
re-baselines a test, or moves a threshold, count, or config value, to make
a run green; a change that genuinely requires a test to move states that in
its PR and moves the test as a separate, explicitly reviewed decision.
Baselines are measured serially: under parallel load a few heavy suites
fail on timeouts and pass serially, and those are suspects, not baseline.
This record states the policy only — CONSTRAINTS.md is the single place
the baseline's contents live, and this record never duplicates them.

## What we gave up

- A literally green suite: every run shows red lines that every reader —
  human or agent — must learn to read as "baseline, named, expected". The
  discipline is social as much as mechanical, and it has to be taught to
  every new arrival (which is part of why this record exists).
- Convenience: a legitimate assertion update caused by real work must wait
  for its own named change instead of riding along with the change that
  caused it.

## Evidence

- `CONSTRAINTS.md` — created 2026-10-14 with the measured baseline, the
  reconciliation note (a "7 baseline failures" figure quoted elsewhere was
  not reproduced; the measured count stands), the serial measurement rule,
  the named-decision header rule, and standing rule 4, "No drive-by test
  fixes".
- `docs/repo-legibility-spec.md` §4, seed 12 — this record's commission:
  explain why a named baseline exists, point at CONSTRAINTS.md for the
  names and counts, never duplicate them.
