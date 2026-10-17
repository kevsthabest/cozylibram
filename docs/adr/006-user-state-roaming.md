# ADR-006 — All user details roam via user_state; shipped keys are frozen
Date: 2026-10-13 · Status: active

## Context

Settings lived in localStorage, which is per-device: the PC and the
phone drifted apart — a different theme on each — for a reader who uses
the app on several devices. Each feature's state needed a home that
followed the account, without disturbing the features that already read
and wrote localStorage.

## Decision

All user details sync between devices through the `user_state` row
(own-rows-only RLS), read and written only through
`js/229-user-state.js`. localStorage stays the runtime source; the
module mirrors snapshots of it to the row and applies newer snapshots
back.

- One column per section, each section carrying its own conflict clock
  (`_at` inside the payload); a pull applies only when the server's
  clock is strictly newer than the last one this device synced.
- The settings snapshot came first (v518, 2026-10-13). Sibling sections
  followed the same pattern — never a new mechanism: warning prefs,
  Up Next, release state (v520), shelf (v521), privacy (v524),
  milestone pin (v536), prefs (v537), finale (v567), reco (v575) —
  nine sections beside the snapshot.
- Only sync-engine internals, disposable caches, and navigation
  transients stay local.
- **Settings keys are frozen once shipped** (CONSTRAINTS.md rule 3):
  an existing key is never renamed or repurposed; new behaviour gets a
  new key, so every already-synced device keeps its meaning.
- Sync is fail-open throughout: offline or any error logs and moves on
  — no throw, no state change, never a blocker for boot or sign-in. A
  different account signing in is baselined, never seeded with the
  previous account's values.

## What we gave up

Per-device divergence as a feature — a theme is the reader's, not the
device's — and the freedom to tidy old keys: frozen keys and sections
accumulate by design, because renaming one would silently reinterpret
state already synced to devices we cannot reach. The snapshot also
duplicates state by construction (localStorage plus the row); the
per-section clocks are the price of keeping that safe.

## Evidence

- `supabase/migrations/v518_user_state.sql` (commit `ea5a3b8`,
  2026-10-13) and the section migrations that followed the pattern:
  v520, v521, v524, v536, v537, v567, v575.
- `js/229-user-state.js` — the module header doctrine and
  `USER_STATE_SECTION_COLS` (the nine section columns).
- `.test/user-state.test.js` — newer-pull applies, older-pull ignored,
  hash-gated push, cross-account baseline, offline fail-open.
- CONSTRAINTS.md rule 3 (frozen settings keys); RULEBOOK §2 rule 7
  (roaming state pattern).
