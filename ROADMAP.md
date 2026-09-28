# Cozy Libram Roadmap

Rebuilt 2026-09-27. The old v1.0 → v1.1 (public BYOK) → v1.2 (hosted APK) →
App Store track is retired: things are moving fast enough that the
public-release tracks may be irrelevant by the time we'd get to them.
If they come back, they'll be re-planned from scratch.

Two pillars now. Everything else is parked or out.

---

## Pillar 1: Trope intelligence

The differentiator. Nobody owns trope data well — not Hardcover, not
Goodreads, not StoryGraph. For the BookTok crowd, tropes *are* the search
language, and they exist in every genre, not just dark romance. The goal
is a trope-first book intelligence layer: a canonical taxonomy, per-book
trope data seeded by LLM and refined by the community, powering discovery
that no generic catalog can match.

### Phase 1 — Taxonomy + data model
- [ ] **Canonical trope taxonomy.** One curated list: id, name, description,
  applicable genres. Genre-aware by design — the LLM prompt and the UI
  only ever offer tropes that fit the book's genres. Starter coverage:
  - *Romance:* enemies to lovers, friends to lovers, forced proximity,
    fake dating, second chance, forbidden love, love triangle,
    grumpy/sunshine, single parent, billionaire, marriage of convenience
  - *Dark romance:* mafia/organized crime, captive/captor, morally grey
    MMC, stalker, revenge, non-con/dub-con dynamics, secret society
  - *Fantasy:* chosen one, magic academy, quest/party, prophecy, dark
    lord, court intrigue, dragons, fae courts
  - *Sci-Fi:* first contact, generation ship, AI uprising/sentience,
    time travel, space opera, dystopia, cyberpunk, alien invasion
  - *Mystery/Thriller:* unreliable narrator, locked room, whodunit,
    police procedural, domestic thriller, serial killer, cold case,
    spy/espionage
  - *Horror:* haunted house, final girl, cosmic horror, folk horror,
    slasher, possession, found footage
  - (expand: historical, contemporary, non-fiction "approaches")
- [ ] **Supabase tables:** `tropes` (the taxonomy) and `book_tropes`
  (book ref → trope → source [`llm`|`community`] → confidence/votes).
  Keyed the same way as the planned `book_meta` cache so it works
  per-instance now and globally later.
- [ ] **RLS + moderation shape:** users can propose/vote; admins curate
  the taxonomy. Reuse the Observatory admin pattern.

### Phase 2 — LLM backfill pipeline
- [ ] **Description → tropes inference.** Prompt constrained to the
  canonical taxonomy and the book's genres (no invented near-duplicate
  labels). Server-side key, same pattern as the Hardcover token.
- [ ] **Backfill the existing library** — a few hundred books, one
  afternoon, fractions of a cent per book.
- [ ] **Cache globally:** each book inferred once; results feed the
  shared `book_meta`-style cache. Wire into the existing trope UI
  (`tropes`, `tropesAuto`, axis pickers are already there waiting).

### Phase 3 — Community refinement
- [ ] **In-app trope voting** via the Coven: upvote/downvote tropes on
  books, propose missing ones. LLM seeds, humans correct.
- [ ] **Confidence scoring:** LLM seed + community votes → ranked trope
  list per book. Joke/spam tags die by downvote; taxonomy stays admin-
  curated.

### Phase 4 — Trope-powered discovery
- [ ] **"More like this" v2** (v110 exists, scored locally) — powered by
  the trope DB instead of only on-device data.
- [ ] **Trope search/filter:** "enemies-to-lovers, high spice, completed
  series" as a first-class query, not a keyword hack.

---

## Pillar 2: Sustained quality

- **One feature per version.** Tests green, committed, pushed — the
  definition of done doesn't change.
- **Loved-ones testers drive hardening.** Real bug reports beat
  anticipated ones; robustness work follows real pain.
- **Data-safety invariants hold:** tombstones, sync conflict resolution,
  per-user partitions, RLS — never regressed, never "simplified."
- **First-login merge hardening** (carried over): the adopt-and-merge
  path needs a deliberate test pass — two devices, offline edits, then
  sign-in.

---

## Still owed (standing items, not pillars)

- Re-run `supabase/schema.sql` (`deleted_books`, `profiles`, avatars
  bucket + storage policies, `circle_links`/`circle_invites` + RLS).
- Run `supabase/analytics.sql`; add Kevin to `app_admins`.
- Supabase Site URL / redirect URL fix (verification emails link to
  localhost).
- Revoke + replace the exposed Hardcover token; restrict the Google
  Books key to the Books API.
- Manually re-add the corrupted "Dungeon Crawler Carl" Bookmory record.

---

## Parked (not now, not never)

- Public GitHub release / self-hosted BYOK (old v1.1).
- Hosted APK track with centrally-held keys (old v1.2).
- App Store release, premium features, in-app payments.
- Full actions/repository/event-bus architecture refactor — shelved
  2026-09-27; revisit only on real pain. If revisited: architecture
  map first, then `services/` extraction for external APIs.

---

## Deliberately out of scope

- Yearly reading goals/challenges — Kevin's explicit veto, do not
  suggest again.
- Public social network features (follows, public feeds) — the Coven
  is private circles by design; that boundary stays.
- Scraping retailer sites — affiliate/search links only.
- Rewriting in a framework, replacing Supabase, or dropping
  local-first — the architecture constraints stand.
