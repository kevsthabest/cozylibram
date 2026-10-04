-- Works + editions: the work identity hub.
--
-- Extracted from the live Supabase project (dvhimjkrroxuatthiizc) 2026-10-04:
-- these tables existed in production with no repo definition. This file is
-- now their source of truth — a fresh project must be able to run it.
--
-- Dependencies: is_admin() is defined in supabase/analytics.sql (policies
-- below reference it); the vector extension backs works.embedding.
-- provider_ids key conventions (see supabase/migrations/v272_work_provider_ids.sql):
--   hardcover_id    — Hardcover book id (numeric, stored as text)
--   openlibrary_id  — Open Library work key, e.g. "/works/OL123W"
--   inventaire_id   — Inventaire entity URI, e.g. "wd:Q123"
--   google_books_id — Google Books volume id
-- Edition-level provider IDs live on editions.provider_ids. Edition
-- attributes (spine photos, sprayed edges) hang off editions/isbn.

create extension if not exists pgcrypto;
create extension if not exists vector;

-- Canonical work: one row per (normalized title, normalized author).
create table if not exists public.works (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  title_norm text not null,
  authors jsonb not null default '[]'::jsonb,
  author_norm text not null default ''::text,
  series jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  embedding vector,
  provider_ids jsonb not null default '{}'::jsonb,
  unique (title_norm, author_norm)
);
create index if not exists works_provider_ids_gin
  on public.works using gin (provider_ids);

-- One row per ISBN; an ISBN never moves between works.
create table if not exists public.editions (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works (id) on delete cascade,
  isbn text not null unique,
  publisher text,
  format text,
  page_count integer,
  publication_date text,
  cover_url text,
  provider_ids jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists editions_work_idx on public.editions (work_id);

alter table public.works enable row level security;
alter table public.editions enable row level security;

-- works policies (as live)
drop policy if exists "works: admin write" on public.works;
create policy "works: admin write" on public.works
  for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "works: read for signed-in" on public.works;
create policy "works: read for signed-in" on public.works
  for select to authenticated using (true);
drop policy if exists "works: user insert" on public.works;
create policy "works: user insert" on public.works
  for insert to authenticated
  with check (title_norm is not null and title_norm <> '');

-- editions policies (as live)
drop policy if exists "editions: admin write" on public.editions;
create policy "editions: admin write" on public.editions
  for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "editions: read for signed-in" on public.editions;
create policy "editions: read for signed-in" on public.editions
  for select to authenticated using (true);
drop policy if exists "editions: user insert" on public.editions;
create policy "editions: user insert" on public.editions
  for insert to authenticated
  with check (work_id is not null and isbn is not null and isbn <> '');
