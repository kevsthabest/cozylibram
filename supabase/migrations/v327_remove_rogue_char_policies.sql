-- v327: remove rogue RLS policies on book_characters that were added directly
-- to the DB (not via migration). They allowed any authenticated user to
-- INSERT/UPDATE character rows, bypassing the intended admin-write policy.
-- Found by security audit 2026-10-08.
DROP POLICY IF EXISTS "characters: user insert" ON public.book_characters;
DROP POLICY IF EXISTS "characters: user update own" ON public.book_characters;
-- Intended policies (already in place): "characters: admin write",
-- "characters: read for signed-in"
