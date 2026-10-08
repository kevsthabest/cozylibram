-- v322: per-user character notes. Shared character data stays canonical;
-- personal annotations live here, keyed by user.
create table if not exists public.character_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  character_id uuid not null references public.characters (id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, character_id)
);
create index if not exists idx_character_notes_character
  on public.character_notes (character_id);

alter table public.character_notes enable row level security;
drop policy if exists "character_notes: owner all" on public.character_notes;
create policy "character_notes: owner all"
  on public.character_notes for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
