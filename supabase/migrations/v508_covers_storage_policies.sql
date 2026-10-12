-- v508: covers bucket storage policies for the WebP adopter.
-- (Applied live 2026-10-12 ahead of the shipping PR; number follows
-- the app version it ships with.)
--
-- Background: the `covers` bucket was created out-of-band in 2026-09
-- (v216 canonical cover cache) and is written today only by the
-- /api/cache-cover Pages Function using the service key, which
-- bypasses RLS. Its policy state was never captured in repo SQL —
-- the open item from the 2026-10-01 security review ("unconfirmed
-- covers-bucket RLS").
--
-- The cover-storage WebP build (docs/cover-storage-webp-spec.md)
-- moves adoption client-side: the app uploads converted WebP covers
-- with the signed-in user's session (the js/206 edition-images
-- pattern). That needs one additive policy: INSERT-only for
-- authenticated users on this bucket. No UPDATE/DELETE policy is
-- granted to authenticated — replacements upload a new
-- content-addressed object and repoint the record; orphan cleanup
-- runs through the service key as a separate, gated step.
--
-- Public read is restated (drop + create) so the repo holds the
-- deterministic policy set regardless of what the dashboard
-- currently has. BEFORE RUNNING: list the existing policies on
-- storage.objects for bucket_id = 'covers' in the Supabase
-- dashboard and reconcile — if an unknown broader policy exists
-- under a different name, this file does NOT remove it.
--
-- Additive only. Idempotent: safe to run more than once.

-- The bucket itself (already exists; this is a no-op safeguard).
insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do nothing;

-- Public read: covers display by URL everywhere in the app.
drop policy if exists "covers public read" on storage.objects;
create policy "covers public read" on storage.objects
  for select using (bucket_id = 'covers');

-- Authenticated write: INSERT only, this bucket only.
drop policy if exists "covers authenticated insert" on storage.objects;
create policy "covers authenticated insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'covers');
