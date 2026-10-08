-- v318: canonical character identity for cross-work linking.
-- A canonical character (e.g. Pete Sebeck) spans multiple works;
-- pipeline-extracted book_characters rows link to it via character_id.
-- Links are human-confirmed in the Character Lab UI, never auto-matched.
-- Additive only.

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_norm text not null unique,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_characters_name_norm
  on public.characters (name_norm);

alter table public.book_characters
  add column if not exists character_id uuid
  references public.characters (id) on delete set null;
create index if not exists idx_book_characters_character_id
  on public.book_characters (character_id);

-- RLS: mirror the book_characters policies (admin write, authenticated read).
-- Adjust to match your existing book_characters policies.
alter table public.characters enable row level security;
drop policy if exists "characters: read for signed-in" on public.characters;
create policy "characters: read for signed-in"
  on public.characters for select to authenticated using (true);
drop policy if exists "characters: admin write" on public.characters;
create policy "characters: admin write"
  on public.characters for all to authenticated
  using (is_admin()) with check (is_admin());
