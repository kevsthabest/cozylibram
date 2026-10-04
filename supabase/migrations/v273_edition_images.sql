-- v273: edition image pool — shared face textures per edition, API-ready.
--
-- One canonical image per (isbn, face, appearance):
--   faces:      spine | front | back | fore_edge | top_edge | bottom_edge
--               (sprayed edges live on fore_edge/top_edge/bottom_edge)
--   appearances: jacket (dust jacket on) | board (naked boards) | slipcase
-- A book with different art under its jacket stores both appearances; the
-- 3D viewer toggles between them.
--
-- Designed for a future public API (e.g. GET /api/editions/:isbn/faces):
-- public SELECT, authenticated INSERT, admin moderation. Storage paths:
--   {face}/{appearance}/{isbn}.jpg   e.g. spine/jacket/9781234567890.jpg
-- `bucket` keeps migrated spine_photos rows pointing at the legacy bucket.

-- Public bucket for edition face images.
insert into storage.buckets (id, name, public)
values ('edition-images', 'edition-images', true)
on conflict (id) do nothing;

drop policy if exists "edition-images public read" on storage.objects;
create policy "edition-images public read" on storage.objects
  for select using (bucket_id = 'edition-images');
drop policy if exists "edition-images authenticated write" on storage.objects;
create policy "edition-images authenticated write" on storage.objects
  for insert to authenticated with check (bucket_id = 'edition-images');

create table if not exists public.edition_images (
  id uuid primary key default gen_random_uuid(),
  isbn text not null,
  edition_id uuid references public.editions(id) on delete set null,
  face text not null
    check (face in ('spine','front','back','fore_edge','top_edge','bottom_edge')),
  appearance text not null default 'jacket'
    check (appearance in ('jacket','board','slipcase')),
  bucket text not null default 'edition-images',
  path text not null,
  uploaded_by uuid,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (isbn, face, appearance)
);
create index if not exists edition_images_isbn_idx on public.edition_images (isbn);

alter table public.edition_images enable row level security;
drop policy if exists "edition_images public read" on public.edition_images;
create policy "edition_images public read" on public.edition_images
  for select using (true);
drop policy if exists "edition_images authenticated insert" on public.edition_images;
create policy "edition_images authenticated insert" on public.edition_images
  for insert to authenticated with check (true);
drop policy if exists "edition_images admin write" on public.edition_images;
create policy "edition_images admin write" on public.edition_images
  for all to authenticated using (is_admin()) with check (is_admin());

-- Migrate the v259 spine pool (bucket-aware rows keep the legacy paths).
insert into public.edition_images (isbn, face, appearance, bucket, path, created_at)
select isbn, 'spine', 'jacket', 'spine-photos', path, created_at
from public.spine_photos
on conflict (isbn, face, appearance) do nothing;
