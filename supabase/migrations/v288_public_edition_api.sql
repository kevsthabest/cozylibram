-- v288: expose the public edition repository read surface
--
-- Only canonical/non-rejected repository data is intended for public use.
-- Writes remain authenticated/admin-only under the earlier migrations.

grant select on public.editions to anon, authenticated;
grant select on public.edition_assets to anon, authenticated;
grant select on public.edition_asset_slots to anon, authenticated;
grant select on public.edition_measurements to anon, authenticated;
grant select on public.edition_images to anon, authenticated;

-- The earlier authenticated-only editions read policy is superseded by the
-- gated public read below; drop it so it cannot mask the new predicate.
drop policy if exists "editions: read for signed-in" on public.editions;

drop policy if exists "editions public read" on public.editions;
create policy "editions public read"
  on public.editions
  for select
  to anon, authenticated
  -- Editions are user-insertable with no moderation state, so the public
  -- surface only exposes editions backed by a canonical slot whose
  -- canonical asset is not rejected.
  using (
    exists (
      select 1
      from public.edition_asset_slots s
      join public.edition_assets a on a.id = s.canonical_asset_id
      where s.edition_id = editions.id
        and not a.rejected
    )
  );

-- The work catalog remains separately permissioned; the public edition API
-- intentionally returns edition metadata without exposing work embeddings.
