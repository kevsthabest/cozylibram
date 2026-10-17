# Community corpus v1

Cozy Libram's character + trope + trigger-warning corpus is community-refined.
The model: **AI first pass, users refine, the owner always overrides.** v1 is a
suggestion system with a human curation queue. There is no automated
consensus yet — that waits for a community large enough to need it.

Three pillars, one pipeline each:

| Pillar | What users suggest | Vocabulary |
|---|---|---|
| Tropes | Suggest a catalog trope for a book, or propose a brand-new trope idea | The 89-ID controlled catalog (suggestions) · free text (new ideas) |
| Characters | Add a character, propose a merge of duplicates, correct a character | Free text + evidence (merges require evidence) |
| Trigger warnings | Suggest a warning for a book | The 30-entry controlled trigger taxonomy |

## The rules that matter

1. **Controlled vocabularies.** Trope and trigger suggestions pick from
   fixed catalogs only. Users never mint catalog IDs — new trope *ideas* are
   free text, but they go to the owner's queue and are never auto-added to the
   taxonomy.
2. **Merges are evidence-gated.** A character merge proposal without
   evidence is rejected. Accepted merges are never auto-applied: approval
   records the decision; the owner applies the merge by hand in the Character Lab.
3. **Provenance on everything.** Every suggestion records who suggested it
   and when. The owner's curation view shows full provenance; the public-facing
   credit reads "refined by the community".
4. **One vote each, no self-votes, rate-limited.** See below.
5. **Accepted contributions only.** Lorekeeper milestones reward
   *accepted* suggestions — raw submission counts earn nothing. This is
   deliberate: it rewards curation-quality work, not spam.

## Suggestion flows

**Trope suggestions** live on the book detail modal. Two kinds:

- *Catalog suggestion* — pick one of the 89 catalog tropes for this book.
  On approval, a `book_tropes` row is written with `source: 'community'`.
- *New-trope idea* — free-text proposal (name, definition, genres). These
  are curation-only: the owner may add the trope to the taxonomy by hand, but
  the pipeline never adds taxonomy entries on its own.

**Character suggestions** — three types, from the character wiki and book
detail:

- *Add* — propose a character for a book (name, role, evidence).
- *Correct* — propose a fix to an existing character (name, role, notes).
- *Merge* — propose that two character records are the same person.
  Requires evidence (text or reasoning); proposals without it are rejected.

**Trigger-warning suggestions** — pick from the 30-entry controlled
taxonomy (seeded by the owner) for a book. Accepted warnings flow into the
Start Reading trigger check, so the next reader gets the heads-up.
Thresholds are safety-biased: the bar to *apply* a warning is low, and the
reject path stays intact for bad suggestions.

## Curation queue (Observatory → Curation)

The owner's review inbox. It lists pending suggestions across all three
pillars with full provenance (he sees who suggested what and when), a
consensus snapshot per suggestion (votes for/against), and bulk
approve/reject — built for speed, not one-by-one clicking.

Approve effects:

- Catalog trope → upsert `book_tropes` (`book_key`, `trope_id`,
  `source='community'`); reject → mark rejected + admin downvote.
- New-trope idea → marked approved/rejected (the owner adds to the taxonomy
  manually).
- Character add → resolves the work, inserts `book_characters` with
  `source_type='community'`.
- Character merge/correct → marked accepted/rejected; the owner applies the
  change by hand.
- Trigger warning → marked accepted/rejected; accepted warnings enrich the
  trigger check (`ccEnrichWarnings`).

The owner's decision is final and always overrides any vote tally.

## Offline outbox and rate limits

Suggestions work offline. Submissions queue in `localStorage` and flush to
Supabase on reconnect — nothing typed offline is lost.

Abuse controls (v1, client-side):

- **Rate limits:** 20 submissions/hour, 100/day, per device. These are a
  throttle, not a security boundary — a determined client can bypass them.
  Server-side enforcement is on the roadmap before public release.
- **Per-book-per-user caps:** 5 suggestions of each kind per book per user.
- **Obscurity-weighted milestone credit:** suggesting an obvious trope on a
  famous book earns less milestone credit than surfacing something obscure.

## Contribution tiers (dormant in v1)

The data model carries tier fields so v2 needs no migration, but all tier
weights are 1 until the community exists:

- **Established** (automatic): granted after N accepted contributions.
  Votes count ×2.
- **Verified** (the owner's grant, revocable): fast-tracked suggestions, votes
  count ×3.

Accept/reject decisions already bump the `community_tiers` counters, so
the history accumulates even while the tiers do nothing.

## Lorekeeper milestones

Three milestones reward accepted contributions (`js/219-milestones.js`):
they fire only when the owner approves a suggestion, never on submission.
Submitting fifty suggestions that all get rejected earns nothing — the
system rewards judgment, not volume.

## Known limitations (pre-public)

Two items the Security Advisor flagged as acceptable for the private
alpha but required before public release:

1. **Rate limiting is client-side and bypassable.** A hostile client can
   ignore the throttle. Server-side enforcement (or at minimum
   server-side validation) must land before the corpus goes public.
2. **Rejected suggestions are readable by all authenticated users.**
   Rejection is a moderation signal; exposing it leaks who proposed what
   and that it was judged unworthy. Visibility needs tightening before
   public release.

## Tables

`supabase/migrations/v399_community_corpus_v1.sql` (additive only):

- `character_suggestions` — add/merge/correct with evidence + provenance
- `trigger_taxonomy` — the 30-entry controlled seed
- `trigger_suggestions` — taxonomy suggestions with provenance
- `community_votes` — one vote per user per suggestion, no self-votes
- `community_tiers` — accepted/rejected counters, dormant weight fields
- `trope_proposals` gains columns: `kind` (`catalog`/`new-idea`),
  `trope_id` (catalog reference), `obscurity_weight`
