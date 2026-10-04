-- v259: shared spine-photo pool.
-- Anonymous AI-cropped spine photos, keyed by ISBN, contributed automatically
-- by every user's AI-verified crops and readable by all users. The library
-- itself stays private (existing RLS untouched); only the tight spine crop
-- — which contains no personal information by construction — is shared.
-- Never shared: fallback center-crops (may include background).

-- Public bucket for the spine images.
insert into storage.buckets (id, name, public)
values ('spine-photos', 'spine-photos', true)
on conflict (id) do nothing;

-- Anyone (even anon) can read shared spines; only signed-in users may add.
drop policy if exists "spine-photos public read" on storage.objects;
create policy "spine-photos public read" on storage.objects
  for select using (bucket_id = 'spine-photos');
drop policy if exists "spine-photos authenticated write" on storage.objects;
create policy "spine-photos authenticated write" on storage.objects
  for insert to authenticated with check (bucket_id = 'spine-photos');

-- Registry: one row per ISBN, first contribution wins.
create table if not exists public.spine_photos (
  isbn text primary key,
  path text not null,
  created_at timestamptz not null default now()
);
alter table public.spine_photos enable row level security;
drop policy if exists "spine_photos public read" on public.spine_photos;
create policy "spine_photos public read" on public.spine_photos
  for select using (true);
drop policy if exists "spine_photos authenticated insert" on public.spine_photos;
create policy "spine_photos authenticated insert" on public.spine_photos
  for insert to authenticated with check (true);
