-- v321: reversible merges. Instead of deleting the loser, mark it
-- status='merged' with duplicate_of pointing at the winner. Unmerge
-- restores it. (Per Trope Review Agent: human errors need one-click undo.)
alter table public.book_characters
  add column if not exists duplicate_of uuid
  references public.book_characters (id) on delete set null;
-- Extend the v317 status check to include 'merged'.
alter table public.book_characters drop constraint if exists book_characters_status_check;
alter table public.book_characters
  add constraint book_characters_status_check
  check (status in ('candidate', 'confirmed', 'rejected', 'merged'));
create index if not exists idx_book_characters_duplicate_of
  on public.book_characters (duplicate_of);
