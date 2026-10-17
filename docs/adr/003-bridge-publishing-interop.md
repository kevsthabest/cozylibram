# ADR-003 — Bridge-publishing interop for ES modules; no build step
Date: 2026-10-16 · Status: active

## Context

The client was 104 classic scripts sharing one global namespace. A full
AST census (2,125 public names, 745 cross-file reference edges, only 5
of them eval-time — all inside the boot/storage/sync knot that every
ordering puts last) showed the tree could convert file by file, but only
if already-converted files never forced their ~100 classic consumers to
change in the same step.

## Decision

**Bridge-publishing, one direction.** A converted file becomes a real
ES module: it exports its public surface with named `export`s and ends
with a small explicit bridge block that assigns exactly its
pre-conversion public surface onto `window`. Classic files keep
consuming bare names, unchanged. Converted files read classic-owned
globals as free variables — sound because module scripts are deferred,
so every classic script has run before any module evaluates. Where
another file writes or reassigns a name, the bridge is an accessor
(`Object.defineProperty` get/set forwarding), never a value snapshot.

**Convergence rule.** When a classic consumer of a bridged name
converts during the import-wiring phase, it switches that read to a
real `import`; a bridge assignment is deleted when its last classic
consumer is gone. Bridges are scaffolding with a demolition schedule,
not a permanent dialect.

**No build step.** Native ES modules only. If any part of a later phase
turns out to require a bundler, that part stops and returns as a
separate proposal.

## What we gave up

A real import graph during the transition: a module's classic-global
reads are implicit dependencies with no import list in the file header.
The mitigation is procedural — the census re-runs per conversion and
each conversion PR prints the file's outbound edge list as its recorded
dependency list until wiring makes it syntactic. We also gave up the
reverse direction (modules importing a globals-bridge module): it
contains this direction as a subset, adds a layer, and still cannot
serve classic consumers, which cannot `import` at all.

## Evidence

- `docs/es-modules-migration-plan.md` §3 (the decision and its four
  reasons) and §8 (no build step, settled by the census); the plan was
  approved by Decision 2026-10-16, fork-first, with the fork's
  offline-reload device gate passed before production work began.
- Phases 1–3 completed with PR #283 (merged 2026-10-17), production at
  v607: 95 of 104 top-level `js/` files are ES modules; the 9 classic
  remainder files are the phase-4 knot/boot set (plan §2.3, §11).
- Measured remainder on the merged tree at series end: 95 bridge blocks
  publishing 1,864 names — 20 accessor-published, 1,844
  value-published. That is the burn-down inventory the import-wiring
  phase works against.
