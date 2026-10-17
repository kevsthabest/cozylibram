# ADR-005 — Offline is a resilience requirement, not a hosting ban
Date: 2026-10-16 · Status: active

## Context

The old stack policy bundled two different ideas: "the app must work
offline" and "nothing may be hosted". Read literally, the second half
banned capabilities that only exist as hosted services, and it made
every framework, package, or build-tooling question a policy fight
instead of a capability case. The two halves needed separating.

## Decision

Decision, 2026-10-16 (refined the same day):

- The core loop — library, shelves, tracking — works fully offline.
  Everything user-generated (page progress, starting a book, edits) is
  local-first and resyncs when the connection returns. Core-path code
  ships vendored or bundled.
- Offline is a resilience requirement, not a hosting ban. Any feature
  may use hosted services or hosted scripts when the capability
  requires them, provided a lost connection degrades that feature to a
  clean unavailable state and never breaks the core app. Occasional
  hiccups are the design case.
- Around that rule: frameworks, packages, build tooling, TypeScript,
  and ES modules are available when they unlock a capability the
  current stack cannot deliver — the case to make is the capability,
  not the fashion. Adopting a framework or a build step for the
  production app is a per-proposal decision the User approves, proven
  in a fork first, never straight to production; incremental packages
  go through the normal gates. The bug-fix auto-ship lane still
  excludes new dependencies — that is lane scope, not a stack ban.

## What we gave up

The simplicity of a blanket ban. "Is it hosted?" is no longer a
sufficient objection; each hosted capability is judged on its
degradation behaviour instead — what the reader sees when the
connection drops mid-use, and whether the core loop is untouched. That
judgment is per-feature and permanent: a hosted dependency accepted
today must still degrade cleanly after every later change around it.

## Evidence

- RULEBOOK §1 rule 11 — the stack-policy rule as consolidated
  2026-10-14 and updated by the 2026-10-16 Decision (workspace
  rulebook; cited as evidence, left in place).
- CONTRIBUTING.md — the stack policy as carried in the canonical
  in-repo protocol.
- The ES-modules migration is the first exercise of the per-proposal
  rail: proposed, fork-proven, then approved (ADR-003).
