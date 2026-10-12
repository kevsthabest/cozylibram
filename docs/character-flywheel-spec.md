# Character flywheel spec

**Status:** spec, not code. Vehicle: the character wiki rework.
**Brief alignment:** "Readers contribute what they notice, so every reader makes
the app better for the next one." Characters are the pillar this engine leans on
hardest ("live in the book after loving it"), and the one readers can currently
do the least with.

## 1. What exists today

| Action | Entry point | State |
|---|---|---|
| Suggest a missing character ("Who did we miss?") | Book modal → Characters tab | Live (PR #90) |
| Propose a merge ("Are these the same person?") | Character cards in modal | Live (PR #90, evidence required) |
| Suggest a trope / trope idea | Book modal → Tropes tab | Live (PR #90) |
| Suggest a content warning | Start-reading check / book modal | Live (PR #90) |

The pattern works: lightweight suggest → provenance → curator queue → canonical.
What's missing is everything a reader notices *about* a character who is already
listed.

## 2. New contribution actions

All five follow the existing pattern: one lightweight sheet, evidence where it
matters, curator confirms, nothing auto-applies.

### 2a. Suggest a connection ("Who matters to whom?")
Readers notice relationships constantly — it's the most natural character
observation there is. Flow: pick a character card → "Suggest a connection" →
pick the other character → pick the relationship type → optional note.

**Spoiler-safe type allowlist** (suggestible): family, friend, rival, mentor,
colleague, neighbor, romantic. **Excluded from suggestion**: any type that
implies plot (killer, victim, betrayer, secret-identity reveals). Those stay
pipeline- or curator-only. The allowlist is the spoiler protection; the curator
is the quality gate.

### 2b. Suggest an alias ("Also called…")
Nicknames, titles, married names — readers trip over these mid-book. Flow: on a
character page → "Also called…" → the alias → optional "where you saw it."
Chapter-anchored evidence follows the read-status rule: only accepted when the
suggesting reader has the book marked read.

### 2c. Attribute a quote ("Who said it?")
The wiki keeps memorable quotes; readers remember lines before they remember
who said them. Flow: on a character page → "Attribute a quote" → the quote
text → optional chapter. Curator judges spoiler-safety of the quote text itself
before it goes live.

### 2d. Correct a detail
Role, description, or existing alias is wrong. Flow: on the field → "Suggest a
fix" → proposed value → one-line why. Smallest possible friction: this is the
one-tap correction the brief's philosophy already promises.

### 2e. Favorite → commons signal ("Loved by N readers")
Private favorites already exist. The flywheel addition: with the reader's
existing privacy posture unchanged, aggregate favorite counts surface on
canonical pages as "Loved by N readers." No names, no ranking, no leaderboard —
pure warmth, and it makes the private act quietly improve the commons. This one
needs no evidence and no curator step; aggregation is automatic.

## 3. Entry points (in the reading moment, not just the wiki)

Contributions happen where noticing happens:

- **Book modal → Characters tab:** "Who did we miss?" (exists), "Suggest a
  connection" (new, on each character card).
- **Character page:** "Also called…", "Attribute a quote", "Suggest a fix"
  (all new, quiet ghost buttons — the page stays browse-first).
- **Quote long-press** (future consideration): "Who said it?" offered on any
  unattributed quote. Not in v1 scope; noted for the UX Tester.

The wiki rework must keep these one tap away and never turn the character page
into a form. Browse-first stays; contribution is a whisper, not a shout.

## 4. What the wiki rework must expose

For the flywheel to feel real, readers need to see the loop close:

- **Pending state:** a reader's suggestion shows as "under review" where they
  made it — no silent void.
- **Provenance line:** accepted data carries "added by a reader, confirmed by
  the curator" (no names — the brief's privacy posture holds for contributors
  too).
- **Your contributions:** a quiet list of what the reader has suggested and its
  state (pending / accepted). This is the feedback loop that makes the second
  contribution happen.

## 5. Curation & incentives

- All five actions feed the existing curation queue; the tiered contributor
  model (established/verified) applies as designed once the community exists.
- Accepted-only Lorekeeper milestones extend to the new action types. No points,
  no contribution leaderboard — the amended brief ("playful, never pressuring")
  forbids ranking contributors.
- Rejection is kind and specific: "not quite — here's why" beats silence, and
  a rejected suggestion never penalizes the suggester.

## 6. Explicitly out of scope

- **Character status (alive/dead) suggestions** — pipeline-owned; too
  spoiler-sensitive for community input in v1.
- **First-appearance chapter data** — pipeline-owned; gated by the read-status
  rule (2026-10-11 decision).
- **Auto-apply** — nothing the community suggests reaches canonical without the
  curator. Ever.
- **"Tend the library" voting UI** — parked; the suggestion flows are the
  on-ramp, not the destination.

## 7. Open questions

- **UX Tester:** best interaction for "suggest a connection between two
  characters" — picker sheet vs. on-card affordance vs. both?
- **Spoiler policy:** should quote attribution require the book marked read,
  like chapter-anchored alias evidence?
- **Scope check:** does 2e ("Loved by N readers") want a minimum-count threshold
  before displaying, to avoid thin-data oddity on obscure characters?
