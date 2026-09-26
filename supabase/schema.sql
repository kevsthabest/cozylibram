-- Spicy Shelves: per-user book storage.
-- Run once in your Supabase project: Dashboard → SQL Editor → paste → Run.
--
-- One row per book per user. The whole book object lives in `data` (jsonb),
-- so the app can evolve without schema migrations. Row Level Security makes
-- sure every user can only ever see their own rows.

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id text not null,
  isbn text,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  unique (user_id, book_id)
);

create index if not exists books_user_isbn on books (user_id, isbn);

alter table books enable row level security;

drop policy if exists "own rows" on books;
create policy "own rows" on books
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Shared metadata cache: one row per ISBN, readable by every signed-in user.
-- The first user to look up a book pays the API cost (Google Books / Open
-- Library); everyone after that reads the cached metadata from here instead.
-- User-specific fields (shelf, ratings, progress, notes) are never stored here.
create table if not exists book_meta (
  isbn text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table book_meta enable row level security;

drop policy if exists "read meta" on book_meta;
create policy "read meta" on book_meta
  for select
  using (auth.role() = 'authenticated');

drop policy if exists "write meta" on book_meta;
create policy "write meta" on book_meta
  for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "refresh meta" on book_meta;
create policy "refresh meta" on book_meta
  for update
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Deletion tombstones: when a book is deleted on one device, the deletion
-- must propagate instead of the book resurrecting on the next sync.
-- One row per deleted book per user; RLS mirrors the books table.
create table if not exists deleted_books (
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id text not null,
  deleted_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

alter table deleted_books enable row level security;

drop policy if exists "own deletions" on deleted_books;
create policy "own deletions" on deleted_books
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
