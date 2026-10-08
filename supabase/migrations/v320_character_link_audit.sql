-- v320: character link audit trail + fix name_norm uniqueness.
--
-- 1. Drop the UNIQUE constraint on characters.name_norm. "John Smith" in
--    a romance and "John Smith" in a horror novel are different people;
--    uniqueness must be the reviewer's job, not the database's. Normalized
--    name remains a search/suggestion key only.
alter table public.characters drop constraint if exists characters_name_norm_key;

-- 2. First-class link table with audit trail. Replaces the bare
--    book_characters.character_id FK — every cross-book claim must be
--    traceable to a human decision (who, when, why).
create table if not exists public.character_links (
  id uuid primary key default gen_random_uuid(),
  book_character_id uuid not null references public.book_characters (id) on delete cascade,
  character_id uuid not null references public.characters (id) on delete cascade,
  linked_by uuid references auth.users (id) on delete set null,
  linked_at timestamptz not null default now(),
  note text,
  unique (book_character_id)  -- one canonical per book row
);
create index if not exists idx_character_links_character
  on public.character_links (character_id);
create index if not exists idx_character_links_book_character
  on public.character_links (book_character_id);

-- 3. Migrate any existing character_id links into the audit table.
--    (linked_by null = migrated before audit existed.)
insert into public.character_links (book_character_id, character_id)
select id, character_id from public.book_characters
where character_id is not null
on conflict (book_character_id) do nothing;

-- 4. Aliases array on canonical characters.
alter table public.characters
  add column if not exists aliases text[] not null default '{}';

-- 5. RLS for the link table (mirror characters policies).
alter table public.character_links enable row level security;
drop policy if exists "character_links: read for signed-in" on public.character_links;
create policy "character_links: read for signed-in"
  on public.character_links for select to authenticated using (true);
drop policy if exists "character_links: admin write" on public.character_links;
create policy "character_links: admin write"
  on public.character_links for all to authenticated
  using (is_admin()) with check (is_admin());
