-- Anthology support: one edition (ISBN) containing multiple independent works.
--
-- Example: Stephen King's "Different Seasons" (ISBN X) contains four novellas:
--   - "Rita Hayworth and Shawshank Redemption"
--   - "Apt Pupil"
--   - "The Body"
--   - "The Breathing Method"
--
-- Model:
--   - The collection itself is a work (e.g., "Different Seasons") — editions.work_id
--     points here. It has its own tropes, characters, etc. as a whole.
--   - Each contained story is also a work — linked via edition_works.
--   - This keeps the common case (1 work → N editions) unchanged, while
--     anthologies get 1 edition → N works via the junction.
--
-- Dependencies: public.works, public.editions (supabase/works.sql),
--   is_admin() (supabase/analytics.sql).

-- Junction: which works are contained in which edition, and in what order.
create table if not exists public.edition_works (
  edition_id uuid not null references public.editions (id) on delete cascade,
  work_id uuid not null references public.works (id) on delete cascade,
  position integer not null default 0,
  -- position: order within the anthology (1, 2, 3...). 0 = unordered.
  primary key (edition_id, work_id)
);
create index if not exists edition_works_edition_idx
  on public.edition_works (edition_id, position);
create index if not exists edition_works_work_idx
  on public.edition_works (work_id);

-- Flag on works to mark collection/anthology containers.
-- A work with is_anthology=true is expected to have entries in edition_works
-- for its editions, listing the contained stories.
alter table public.works
  add column if not exists is_anthology boolean not null default false;
alter table public.works
  add column if not exists anthology_note text;

alter table public.edition_works enable row level security;

drop policy if exists "edition_works: admin write" on public.edition_works;
create policy "edition_works: admin write" on public.edition_works
  for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "edition_works: read for signed-in" on public.edition_works;
create policy "edition_works: read for signed-in" on public.edition_works
  for select to authenticated using (true);
