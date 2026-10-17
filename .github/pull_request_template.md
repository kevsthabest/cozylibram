<!--
  PR body discipline for this repo — the practiced shape of PRs #283–#286,
  written down by the Repo Legibility Standard programme (spec §10).
  Fill every section. Quote evidence — counts, diffs, results — never
  summarize it away: the Advisor gate re-derives from what is written here.
  Merge model: tests at or above the CONSTRAINTS baseline (CONSTRAINTS.md),
  Advisor gate PASS / PASS_WITH_RISK before merge. Docs-only PRs do not
  bump APP_VERSION / CACHE.
-->

## Programme / work-order context

<!-- What authorizes this change — the spec section, work order, or finding,
     linked. State the base commit and the branch. -->

## What changed

<!-- Per file or per change, before → after. Name anything explicitly out of
     scope, and who owns it. -->

## Evidence

<!-- The proofs the gate will re-derive: inventories, counts, diffs, censuses,
     A/B results. Numbers are quoted from the artefact that produced them,
     never restated from memory. -->

## Test evidence

<!-- The suite command exactly as run, its pass/fail signature, and the named
     baseline failures it is compared against (CONSTRAINTS.md). Disclose any
     flake or adjudication — never absorb one silently. -->

## Merge danger

<!-- Two-way door | One-way door — one sentence of justification.
     Blast radius: one line. -->

## Review ask

<!-- What the Advisor should scrutinize most. Whether UX Tester verification
     is needed post-merge, and on what surface. -->

## Legibility conformance — spec §10

<!-- Mark each box, or mark it N/A with the reason. Never leave one silently
     unchecked. -->

- [ ] Headers/comments on touched files comply with Layer 1 (prose header;
      local comments state the why, never restate the code)
- [ ] A decision was made or reversed → ADR added or superseded and linked
      (`docs/adr/`; a superseded record is never edited)
- [ ] js files added, removed, or re-surfaced → module map regenerated
      (`docs/module-map.md`)

## Definition of Done

<!-- Acceptance criteria, as met. Residual risks. What must NOT be redone.
     Next steps, with file paths. -->
