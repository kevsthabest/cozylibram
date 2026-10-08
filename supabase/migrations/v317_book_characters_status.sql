-- v317: review workflow for pipeline-extracted characters.
-- Additive only: status column with candidate/confirmed/rejected,
-- matching the book_trope_claims pattern.
alter table public.book_characters
  add column if not exists status text not null default 'candidate'
  check (status in ('candidate', 'confirmed', 'rejected'));

create index if not exists idx_book_characters_status
  on public.book_characters (work_id, status);
