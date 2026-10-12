-- v509: repo/live RLS policy reconciliation for character tables.
--
-- Why this exists: the 2026-10-12 Supabase health check (finding C2)
-- found that the repo SQL's net state disagreed with live on two tables,
-- in the dangerous direction. Live was corrected directly at some point
-- and is healthy; the repo never caught up, so a full in-order re-run of
-- the repo files (the documented maintenance flow) would resurrect both
-- holes, because Postgres policies are permissive-OR:
--
--   1. v377 created "Allow authenticated insert/update/delete" on
--      character_relationships with USING/WITH CHECK (true) — any
--      signed-in user could write or delete any relationship row.
--      v381 installed the intended restricted set ("relationships: user
--      suggest", "relationships: user retract own pending",
--      "relationships: admin all") but dropped a policy named
--      "relationships: admin write", which exists nowhere in repo SQL,
--      so the v377 trio was never removed by the migration sequence.
--   2. supabase/ebook-extraction.sql still created the rogue
--      book_characters policies "characters: user insert"
--      (WITH CHECK true) and "characters: user update own" (USING true,
--      not actually own-scoped) that v327 removed. The rogue pair has
--      also been stripped from ebook-extraction.sql itself; the drops
--      below are kept so the sequence lands on the live state even if
--      an older copy of the base file is re-run first.
--
-- This migration only removes those five policies, by their exact
-- names, IF EXISTS. It creates nothing and changes no other object.
-- Applied live it is a no-op (the policies are already absent there);
-- it exists so the repo sequence reproduces the live state. Safe to
-- re-run. History files v377/v381/v327 are intentionally left as-is.

DROP POLICY IF EXISTS "Allow authenticated insert" ON public.character_relationships;
DROP POLICY IF EXISTS "Allow authenticated update" ON public.character_relationships;
DROP POLICY IF EXISTS "Allow authenticated delete" ON public.character_relationships;

DROP POLICY IF EXISTS "characters: user insert" ON public.book_characters;
DROP POLICY IF EXISTS "characters: user update own" ON public.book_characters;
