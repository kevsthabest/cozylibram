-- v286: quality scoring and automatic canonical selection for edition assets
--
-- Canonical is a pointer, not the first upload. Every non-rejected candidate
-- participates in selection; verified candidates outrank unverified ones, then
-- the computed quality score breaks ties. Historical candidates are retained.

alter table public.edition_assets
  drop constraint if exists edition_assets_quality_score_check;
alter table public.edition_assets
  add constraint edition_assets_quality_score_check
  check (quality_score is null or (quality_score >= 0 and quality_score <= 100));

alter table public.edition_asset_slots
  drop constraint if exists edition_asset_slots_selection_method_check;
alter table public.edition_asset_slots
  add constraint edition_asset_slots_selection_method_check
  check (selection_method in ('automatic','manual','admin','quality','verified-quality'));

-- Contributors may submit evidence, but verification/rejection are moderation
-- state and cannot be self-assigned.
drop policy if exists "edition_assets contributor insert" on public.edition_assets;
create policy "edition_assets contributor insert" on public.edition_assets
  for insert to authenticated
  with check (
    source_user_id = auth.uid()
    and rejected = false
    and verified = false
    and exists (
      select 1 from public.editions e
      where e.id = edition_assets.edition_id
        and e.isbn = edition_assets.isbn
    )
  );

create schema if not exists private;

create or replace function private.edition_assets_select_best(
  p_edition_id uuid,
  p_face text,
  p_appearance text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  best_id uuid;
  best_isbn text;
  best_bucket text;
  best_path text;
  best_user uuid;
  best_verified boolean;
begin
  select a.id, a.isbn, a.bucket, a.path, a.source_user_id, a.verified
    into best_id, best_isbn, best_bucket, best_path, best_user, best_verified
  from public.edition_assets a
  where a.edition_id = p_edition_id
    and a.face = p_face
    and a.appearance = p_appearance
    and not a.rejected
  order by
    a.verified desc,
    coalesce(a.quality_score, 0) desc,
    coalesce(a.sharpness_score, 0) desc,
    coalesce(a.resolution_score, 0) desc,
    a.created_at asc,
    a.id asc
  limit 1;

  if best_id is null then
    delete from public.edition_asset_slots
      where edition_id = p_edition_id
        and face = p_face
        and appearance = p_appearance;
    delete from public.edition_images
      where edition_id = p_edition_id
        and face = p_face
        and appearance = p_appearance;
    return null;
  end if;

  insert into public.edition_asset_slots (
    edition_id, isbn, face, appearance, canonical_asset_id,
    selection_method, selected_by, selected_at, updated_at
  ) values (
    p_edition_id, best_isbn, p_face, p_appearance, best_id,
    case when best_verified then 'verified-quality' else 'quality' end,
    best_user, now(), now()
  )
  on conflict (edition_id, face, appearance)
  do update set
    isbn = excluded.isbn,
    canonical_asset_id = excluded.canonical_asset_id,
    selection_method = excluded.selection_method,
    selected_by = excluded.selected_by,
    selected_at = excluded.selected_at,
    updated_at = now();

  -- Keep the old viewer/read model synchronized with the current canonical.
  insert into public.edition_images (
    isbn, edition_id, face, appearance, bucket, path, uploaded_by,
    verified, updated_at
  ) values (
    best_isbn, p_edition_id, p_face, p_appearance, best_bucket, best_path,
    best_user, best_verified, now()
  )
  on conflict (isbn, face, appearance)
  do update set
    edition_id = excluded.edition_id,
    bucket = excluded.bucket,
    path = excluded.path,
    uploaded_by = excluded.uploaded_by,
    verified = excluded.verified,
    updated_at = now();

  return best_id;
end;
$$;

revoke execute on function private.edition_assets_select_best(uuid,text,text)
  from public, anon, authenticated;

create or replace function private.edition_assets_canonical_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.edition_assets_select_best(
    coalesce(new.edition_id, old.edition_id),
    coalesce(new.face, old.face),
    coalesce(new.appearance, old.appearance)
  );
  return coalesce(new, old);
end;
$$;

revoke execute on function private.edition_assets_canonical_trigger()
  from public, anon, authenticated;

drop trigger if exists edition_assets_canonical_after_write
  on public.edition_assets;
create trigger edition_assets_canonical_after_write
after insert or update of quality_score, sharpness_score, exposure_score,
  perspective_score, coverage_score, glare_score, resolution_score,
  stability_score, verified, rejected, face, appearance, edition_id
  or delete
on public.edition_assets
for each row
execute function private.edition_assets_canonical_trigger();

-- Re-evaluate assets created by v284 before this migration existed.
do $$
declare
  r record;
begin
  for r in
    select distinct edition_id, face, appearance
    from public.edition_assets
    where edition_id is not null
  loop
    perform private.edition_assets_select_best(r.edition_id, r.face, r.appearance);
  end loop;
end;
$$;
