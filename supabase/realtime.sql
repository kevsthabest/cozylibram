-- Cozy Libram v143: realtime sync.
-- Run ONCE in the Supabase SQL editor (Database → SQL → New query).
--
-- The app subscribes to live changes on these tables so a deletion (or an
-- add/edit) on one device reaches the others within seconds. Postgres only
-- sends realtime events for tables in the supabase_realtime publication.
-- Without this, subscribing silently receives nothing and the app falls back
-- to syncing when it opens — nothing breaks, it's just not instant.
--
-- Safe to re-run: adding a table that's already a member is a no-op.

alter publication supabase_realtime add table public.books;
alter publication supabase_realtime add table public.deleted_books;
