# Incident summary — the depollute repair, retired at v568

*2026-10-15 · Blameless summary (Legibility Standard, Layer 5). The full
record is PR #242 and commits `13b4e86` / `e1d17c0` in git history.*

## What happened

In the v96–v100 era, friend-readable book policies met a sync pull with
no `user_id` filter: the first sync after adding a friend merged their
shared books into your local library, and the next push re-uploaded them
as your own rows. v101 (2026-09-27) fixed the pull (scoped with
`.eq('user_id', …)`) and added a one-time repair,
`repairFriendPollution` (`js/090-sync.js`): on first sync, remove local
books whose id matched a friend's shared book id, via the normal
tombstone path so the cleanup propagated to other devices.

The repair kept running at the end of every `cloudFirstSync` in any fresh
context. On 2026-10-15 the UX test account lost exactly 4 books — Dune,
Book Lovers, Modern Classic, Fourth Wing Bonus — whose ids collided with
its accepted friend's visible library, tombstoned in one batch
(2026-10-15 02:00:17.594 UTC). Tombstoning deleted the cloud rows on the
next push and propagated the loss to the account's other devices.

## What the evidence showed

An id collision cannot distinguish a genuine pre-fix leak from the same
record legitimately present in two friended accounts — seeded fixtures
and shared backup imports both produce legitimate collisions. The
production loss above was exactly the collision set, nothing else. A
grep audit found the only references to the repair or its
`spicyshelves.depollute.v1` flag were `js/090-sync.js` and
`.test/cloud.test.js`.

## What changed

- PR #242 (v568, merged 2026-10-15) retired the repair outright: the
  function and its `cloudFirstSync` invocation were removed from
  `js/090-sync.js`, with a retirement note left in the file (still there,
  `js/090-sync.js` at the `cloudFirstSync` site). Genuine deletion —
  `removeBook`, tombstone creation/application, `cloudWipe` — was
  untouched.
- The five depollution assertions in `.test/cloud.test.js` were replaced
  (a named movement under `CONSTRAINTS.md` rule 4) with a regression pin
  of the exact incident scenario: a fresh-context first sync whose
  library shares ids with a friend's visible library loses nothing. The
  pin was RED before the retirement, GREEN after.
- The `spicyshelves.depollute.v1` localStorage key was deliberately left
  on devices that hold it — orphaned and unread, it is harmless; its
  removal rides the sync-seam work order (candidate 8).

**Lesson.** A self-healing repair keyed on a signal that cannot
distinguish damage from legitimate state will eventually delete
legitimate state. Repairs need a distinguishing signal and an expiry,
and a cleanup that propagates deletions is held to the same bar as a
deletion.
