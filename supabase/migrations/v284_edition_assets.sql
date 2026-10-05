-- v284: first-class edition asset repository
--
-- edition_images remains as a compatibility/read model for the existing
-- scanner and viewer. New contributions are represented as immutable assets,
-- while edition_asset_slots selects the current canonical asset per surface.
--
-- Asset identity is independent from the canonical slot so better images can
-- replace the canonical choice without destroying prior contributions.

create table if not exists public.edition_assets (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid references public.editions(id) on delete set null,
  isbn text not null,
  face text not null
    check (face in ('spine','front','back','fore_edge','top_edge','bottom_edge')),
  appearance text not null default 'jacket'
    check (appearance in ('jacket','board','slipcase')),
  bucket text not null default 'edition-images',
  path text not null,
  width integer,
  height integer,
  format text,
  byte_size bigint,
  sha256 text,
  source_type text not null default 'capture'
    check (source_type in ('capture','upload','import','perspective_corrected','sharpened','restored','derived')),
  source_user_id uuid references auth.users(id) on delete set null,
  parent_asset_id uuid references public.edition_assets(id) on delete set null,
  capture_session_id text,
  quality_score numeric,
  sharpness_score numeric,
  exposure_score numeric,
  perspective_score numeric,
  coverage_score numeric,
  glare_score numeric,
  resolution_score numeric,
  stability_score numeric,
  verified boolean not null default false,
  rejected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, path)
);

create index if not exists edition_assets_edition_idx
  on public.edition_assets (edition_id);
create index if not exists edition_assets_isbn_face_idx
  on public.edition_assets (isbn, face, appearance);
create index if not exists edition_assets_sha256_idx
  on public.edition_assets (sha256);

create table if not exists public.edition_asset_slots (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  isbn text not null,
  face text not null
    check (face in ('spine','front','back','fore_edge','top_edge','bottom_edge')),
  appearance text not null default 'jacket'
    check (appearance in ('jacket','board','slipcase')),
  canonical_asset_id uuid references public.edition_assets(id) on delete set null,
  selection_method text not null default 'automatic'
    check (selection_method in ('automatic','manual','admin')),
  selected_by uuid references auth.users(id) on delete set null,
  selected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (edition_id, face, appearance)
);

create index if not exists edition_asset_slots_isbn_idx
  on public.edition_asset_slots (isbn);

alter table public.edition_assets enable row level security;
alter table public.edition_asset_slots enable row level security;

drop policy if exists "edition_assets public read" on public.edition_assets;
create policy "edition_assets public read" on public.edition_assets
  for select using (not rejected);

drop policy if exists "edition_assets contributor insert" on public.edition_assets;
create policy "edition_assets contributor insert" on public.edition_assets
  for insert to authenticated
  with check (
    source_user_id = auth.uid()
    and rejected = false
    and exists (
      select 1 from public.editions e
      where e.id = edition_assets.edition_id
        and e.isbn = edition_assets.isbn
    )
  );

drop policy if exists "edition_assets contributor update" on public.edition_assets;
create policy "edition_assets contributor update" on public.edition_assets
  for update to authenticated
  using (source_user_id = auth.uid() or is_admin())
  with check (source_user_id = auth.uid() or is_admin());

drop policy if exists "edition_assets contributor delete" on public.edition_assets;
create policy "edition_assets contributor delete" on public.edition_assets
  for delete to authenticated
  using (source_user_id = auth.uid() or is_admin());

drop policy if exists "edition_assets admin write" on public.edition_assets;
create policy "edition_assets admin write" on public.edition_assets
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists "edition_asset_slots public read" on public.edition_asset_slots;
create policy "edition_asset_slots public read" on public.edition_asset_slots
  for select using (true);

drop policy if exists "edition_asset_slots contributor insert" on public.edition_asset_slots;
create policy "edition_asset_slots contributor insert" on public.edition_asset_slots
  for insert to authenticated
  with check (
    -- Contributors may only ever create automatic slots pointing at their
    -- own non-rejected asset. Forging 'manual'/'admin' authority would pin
    -- the asset as permanently canonical (v286 treats those as untouchable).
    selection_method = 'automatic'
    and (selected_by = auth.uid() or selected_by is null)
    and exists (
      select 1 from public.editions e
      where e.id = edition_asset_slots.edition_id
        and e.isbn = edition_asset_slots.isbn
    )
    and exists (
      select 1 from public.edition_assets a
      where a.id = edition_asset_slots.canonical_asset_id
        and a.edition_id = edition_asset_slots.edition_id
        and a.isbn = edition_asset_slots.isbn
        and a.face = edition_asset_slots.face
        and a.appearance = edition_asset_slots.appearance
        and a.source_user_id = auth.uid()
        and not a.rejected
    )
  );

drop policy if exists "edition_asset_slots contributor update" on public.edition_asset_slots;
create policy "edition_asset_slots contributor update" on public.edition_asset_slots
  for update to authenticated
  using (selected_by = auth.uid() or is_admin())
  with check (selected_by = auth.uid() or is_admin());

drop policy if exists "edition_asset_slots admin write" on public.edition_asset_slots;
create policy "edition_asset_slots admin write" on public.edition_asset_slots
  for all to authenticated using (is_admin()) with check (is_admin());

-- New repository assets are immutable content-addressed objects. The existing
-- bucket remains public because the current 3D viewer consumes public URLs.
drop policy if exists "edition-images authenticated write" on storage.objects;
create policy "edition-images authenticated write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'edition-images'
    and (storage.foldername(name))[1] in
      ('front','back','spine','fore_edge','top_edge','bottom_edge')
  );

drop policy if exists "edition-images contributor update" on storage.objects;
create policy "edition-images contributor update" on storage.objects
  for update to authenticated
  using (bucket_id = 'edition-images' and owner = auth.uid())
  with check (bucket_id = 'edition-images' and owner = auth.uid());

drop policy if exists "edition-images contributor delete" on storage.objects;
create policy "edition-images contributor delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'edition-images' and owner = auth.uid());

-- Existing legacy edition_images rows remain untouched and continue to work.
