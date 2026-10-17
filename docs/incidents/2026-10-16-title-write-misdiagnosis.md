# Incident summary — the title-write misdiagnosis

*2026-10-16 · Blameless summary (Legibility Standard, Layer 5). The full
diagnosis record stays in the workspace (Data & Sync seat,
`title-write-diagnosis-2026-10-16`); the regression suite is
`.test/title-write-keying.test.js`.*

## What happened

Corrupted records in the UX test account — books carrying another book's
content and reading progress, grouped visibly by title — raised the fear
that editing a book's title in the detail modal had stopped being
id-keyed and become title-value-keyed: that a title edit wrote one book's
data over every record sharing the title. A general "don't edit titles"
warning was in force while the claim was investigated.

## What the evidence showed

The claim did not survive an automated case. The diagnosis (Data & Sync
seat) edited three records sharing one title value through the real
modal autosave path and asserted on all three sinks — the in-memory
library, the persist write set and store bytes, and the cloud push
payload: id-keyed end to end, 6/6. A static audit agreed: the tree's
only book assign (`applyDetailForm`, `js/150`) resolves its object by
id; persist plans are computed from id sets (`js/040`); cloud push
upserts and merge matching key on `book_id` (`js/090`); the database has
`unique (user_id, book_id)` and no title-keyed write exists.

The corruption was real but historical. Marker-disciplined server reads
(the runbook §5 preamble) showed: real-user data clean, verified
record-by-record; zero duplicate `(user_id, book_id)` pairs in the whole
table. The test account's library had been rebuilt in an Oct-15
reseed/restore era — an Oct-8 census showed 23 correct books; by Oct-16
it held 9 records with whole content mis-paired under the wrong ids
(e.g. a 517-page progress entry, another book's page count, logged under
records whose books have 352). Correctly id-keyed sync then faithfully
propagated the mis-pairing. Which operation in that rebuild paired ids
to the wrong content is not recoverable from the artifacts — recorded
as unknown, not guessed.

## What changed

- No code fix — the current tree was exonerated, and changing correct
  code is not a fix. The investigation's deliverable was the regression
  suite: PR #268 landed `.test/title-write-keying.test.js`, pinning
  id-keyed writes permanently.
- The general "don't edit titles" warning was **lifted**, narrowed to
  the already-mis-paired test-account records only. Repairing those
  records stays a separate, approval-gated data step (canonical titles
  per ISBN are held in `book_meta`).
- One residual seam was found and dispositioned, not fixed on the spot:
  merge ingest did not assert the embedded `data.id` against the row's
  `book_id`. A marker-disciplined read verified all 297/297 rows agree,
  so the ingest guard was folded into the sync-seam work order
  (candidate 8) as optional hardening with a merge-ingest pin.

**Lesson.** Settle a frightening prose claim with an automated case
against the real path before touching code — and check the data before
theorizing about the write path. The suite, not the incident write-up,
is what stays behind as protection.
