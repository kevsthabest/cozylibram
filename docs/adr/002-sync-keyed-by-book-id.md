# ADR-002 — Sync merges are keyed by book id, never by title
Date: 2026-10-16 · Status: active

## Context

On 2026-10-16, corrupted records in the UX test account — books carrying
another book's content and progress, grouped visibly by title — raised
the fear that editing a book's title in the detail modal had stopped
being id-keyed and become title-value-keyed: that one title edit wrote
over every record sharing the title. A general "don't edit titles"
warning was in force while the claim was investigated.

The investigation settled the claim with an automated case against the
real write path before any code was touched, and the current tree was
exonerated: the corruption was whole-content mis-pairing from the test
account's reseed/rebuild era, faithfully propagated by correctly
id-keyed sync. The full account is the incident summary cited below.

## Decision

Every layer of a book write is keyed by book id, end to end:

- the modal commit assigns the id-resolved object (`applyDetailForm`,
  `js/150` — the tree's only book assign);
- persist plans are computed from id sets (`js/040`);
- cloud push upserts and merge matching key on `book_id` (`js/090`),
  against the table's `unique (user_id, book_id)`;
- within an id-keyed row, merges resolve by `_mtime` — newest edit wins.

Titles are display data, never keys. Any future write path that matches
books by title — or by any display value — is a defect by definition,
not a design option.

## What we gave up

Title-matching conveniences: no dedupe-by-title, no "fix every copy"
writes. Matching two records is always an explicit operation carrying
ids. We also gave up the suspected fix — the tree was exonerated, and
changing correct code is not a fix; the deliverable was the regression
pin, not a patch.

## Evidence

- `docs/incidents/2026-10-16-title-write-misdiagnosis.md` — what
  happened, what the evidence showed, what changed.
- `.test/title-write-keying.test.js` — three records sharing one title
  value edited through the real modal autosave path, asserted on the
  in-memory library, the persist write set, and the cloud push payload:
  id-keyed 6/6. Landed by PR #268 (merged 2026-10-16).
- Marker-disciplined server read during the diagnosis: zero duplicate
  `(user_id, book_id)` pairs in the whole `books` table.
