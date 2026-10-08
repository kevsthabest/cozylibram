-- v336: book quotes for the premium character wiki (Phase B).
-- Stores memorable quotes extracted by the pipeline, linked to works
-- and optionally to specific characters.
create table if not exists public.book_quotes (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works (id) on delete cascade,
  book_character_id uuid references public.book_characters (id) on delete set null,
  quote text not null,
  context text,
  speaker_name text,
  source_type text not null default 'pipeline' check (source_type in ('pipeline', 'manual')),
  confidence numeric,
  created_at timestamptz not null default now()
);
create index if not exists idx_book_quotes_work on public.book_quotes (work_id);
create index if not exists idx_book_quotes_character on public.book_quotes (book_character_id);

alter table public.book_quotes enable row level security;
drop policy if exists "book_quotes: read for signed-in" on public.book_quotes;
create policy "book_quotes: read for signed-in"
  on public.book_quotes for select to authenticated using (true);
drop policy if exists "book_quotes: admin write" on public.book_quotes;
create policy "book_quotes: admin write"
  on public.book_quotes for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
