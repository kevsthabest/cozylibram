# ADR-008 — Handles: findability is a separate opt-in, and lookup is no-oracle
Date: 2026-10-14 · Status: active

## Context

Friend surfaces displayed a reader's real first name, and some readers would
rather not be known by it. A handle is a chosen public identity: friend-facing
surfaces show @handle instead of the first name, and a handle can be looked
up to ask for a connection. But a findable namespace is also an enumeration
target, and a handle embodies no consent toward whoever looks it up — an
invite token is the inviter's consent artifact, a handle is not. The
invariants are therefore enforced in the database, never merely in the
client.

## Decision

- **Findability is a separate opt-in, default OFF.** Setting a handle is a
  display choice; being findable is the public act. `profiles.findable`
  defaults false for everyone. The client's profile sync never writes the
  handle column — claims and clears go only through the claim RPC, which
  owns the screen, the quarantine, and the cooldown.
- **Add-by-handle is a pending request, never instant.**
  `request_by_handle` creates a pending circle link in the existing inbox
  shape; the recipient answers it through the existing flow. No door turns
  a lookup into a connection without the recipient's answer.
- **Lookup never returns a real name, and every refusal is identical.**
  `lookup_handle` returns a minimal shape (handle, avatar, bio fields behind
  the same share gate as the profile projection) and never first/last name.
  An unknown handle, a not-findable owner, a block in either direction, and
  a rate-limited caller all return the identical empty result; request
  refusals (unknown, not findable, blocked, already linked, duplicate
  pending, limited) collapse into one indistinguishable failure. Blocked
  and missing are indistinguishable. Lookups are rate-limited inside the
  RPC: 30 per caller per rolling hour.
- **Released handles quarantine; renames cool down.** A released handle is
  tombstoned in `handle_history` for 90 days: nobody else may claim it, and
  friends see "formerly @…" while the quarantine runs. The previous owner
  may reclaim at any time; renames carry a 30-day cooldown, from which
  reclaiming your own quarantined handle is exempt.
- **Handles are required at signup** (v551): the form collects one, with
  the claim deferred to the claim RPC so the screen, quarantine, and
  cooldown apply from a reader's first handle.

## What we gave up

- Frictionless friending: discovery by handle deliberately cannot become
  connection without the recipient's answer, where an invite link can.
- Diagnostic clarity: a mistyped handle, a private reader, and a blocked
  caller are indistinguishable — by design; there is no oracle to consult,
  including for support.
- Namespace liquidity: a released handle sits unusable by anyone else for
  90 days, shrinking the claimable pool to protect identity continuity.

## Evidence

- `supabase/migrations/v550_handles.sql` — the migration header states the
  invariants verbatim ("PENDING, NEVER INSTANT", "NO ORACLES",
  "FINDABLE IS A SEPARATE OPT-IN, DEFAULT OFF", "RELEASES QUARANTINE")
  and the enforcement points; shipped as v550 (PR #221, 2026-10-14).
- v551 (PR #222, 2026-10-14): required handle at signup — form field,
  deferred claim.
- `js/237-handles.js` mirrors the migration's content screen token-for-token;
  a test asserts the two copies agree (per the v550 header).
