-- v288: expose the public edition repository read surface
--
-- Only canonical/non-rejected repository data is intended for public use.
-- Writes remain authenticated/admin-only under the earlier migrations.

grant select on public.editions to anon, authenticated;
grant select on public.edition_assets to anon, authenticated;
grant select on public.edition_asset_slots to anon, authenticated;
grant select on public.edition_measurements to anon, authenticated;
grant select on public.edition_images to anon, authenticated;

drop policy if exists "editions public read" on public.editions;
create policy "editions public read"
  on public.editions
  for select
  to anon, authenticated
  using (true);

-- The work catalog remains separately permissioned; the public edition API
-- intentionally returns edition metadata without exposing work embeddings.
