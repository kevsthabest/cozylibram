-- v618: Cast tiers — the tier marker on book_characters.
--
-- The curation programme's tiered cast model stores only Tier 1
-- (principals) and Tier 2 (significant) characters as full rows.
-- The Tier 3 roster remainder lives in a local store on the
-- operator's machine and reaches this table only when the operator
-- pushes a character, landing as "other cast". These two columns
-- are how a stored row says which tier it is, and how it got it:
--
--   tier         1 = principal, 2 = significant, 3 = other cast.
--                NULL on every pre-v618 row — deliberately no
--                backfill: NULL is the honest state for a row no
--                tier pass has classified yet, and readers treat
--                NULL as Tier 1 posture (full row, every surface),
--                which is the posture those rows have today.
--   tier_source  'computed' = the pipeline's own tier computation,
--                'pushed'   = pushed from the local Tier 3 store,
--                'override' = an operator decision on a stored row
--                (including a demoted row kept as a reference for
--                its link/merge history).
--
-- The CHECK constraints keep both vocabularies closed: a tier
-- outside 1–3 or a fourth source string cannot be written by
-- accident — widening either is a schema decision, not a code
-- edit that quietly starts minting unmarked meanings.
--
-- Additive and nullable; own-table columns, no policy changes (the
-- existing book_characters RLS governs them unchanged). Nothing
-- reads these columns yet: the processor's tier pass and the
-- console's push path are separate work that lands against them.
alter table public.book_characters
  add column if not exists tier smallint,
  add column if not exists tier_source text;

alter table public.book_characters
  add constraint book_characters_tier_range
    check (tier is null or tier in (1, 2, 3)),
  add constraint book_characters_tier_source_vocab
    check (tier_source is null
           or tier_source in ('computed', 'pushed', 'override'));
