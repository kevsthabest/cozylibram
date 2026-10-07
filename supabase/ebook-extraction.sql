-- Ebook extraction schema: trigger warnings and characters from full-text analysis.
--
-- Extends the work-keyed claims pattern from book_trope_claims (supabase/claims.sql).
-- These tables are populated by the ebook processor (~/workspace/ebook-processor/process.py)
-- which extracts structured metadata from EPUB files via LLM.
--
-- Dependencies: public.works (supabase/works.sql), is_admin() (supabase/analytics.sql).

-- Trigger warnings extracted from full text.
-- Unlike book.contentWarnings (Hardcover provider data, per-edition), these are
-- work-level claims with confidence/provenance, reviewable in the same way as tropes.
create table if not exists public.book_trigger_claims (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works (id) on delete cascade,
  warning text not null,
  status text not null default 'candidate'::text
    check (status in ('candidate', 'confirmed', 'rejected', 'disputed')),
  confidence numeric
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_type text not null
    check (source_type in ('provider', 'ai', 'community', 'admin', 'user', 'import')),
  source_id text,
  model text,
  model_version text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_id, warning)
);
create index if not exists book_trigger_claims_active_idx
  on public.book_trigger_claims (work_id) where (status <> 'rejected');

alter table public.book_trigger_claims enable row level security;

drop policy if exists "triggers: admin write" on public.book_trigger_claims;
create policy "triggers: admin write" on public.book_trigger_claims
  for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "triggers: read for signed-in" on public.book_trigger_claims;
create policy "triggers: read for signed-in" on public.book_trigger_claims
  for select to authenticated using (true);
drop policy if exists "triggers: user insert ai candidates" on public.book_trigger_claims;
create policy "triggers: user insert ai candidates" on public.book_trigger_claims
  for insert to authenticated with check (status = 'candidate' and source_type = 'import');

-- Characters extracted from full text.
-- Manual entries and AI-extracted candidates coexist; user can confirm/edit.
create table if not exists public.book_characters (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works (id) on delete cascade,
  name text not null,
  role text
    check (role is null or role in ('protagonist', 'antagonist', 'supporting', 'minor')),
  description text,
  relationships jsonb not null default '[]'::jsonb,
  -- relationships: [{"to": "Character Name", "type": "lovers/rivals/family/etc."}]
  source_type text not null default 'import'::text
    check (source_type in ('provider', 'ai', 'community', 'admin', 'user', 'import')),
  confidence numeric
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (work_id, name)
);
create index if not exists book_characters_work_idx
  on public.book_characters (work_id);

alter table public.book_characters enable row level security;

drop policy if exists "characters: admin write" on public.book_characters;
create policy "characters: admin write" on public.book_characters
  for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "characters: read for signed-in" on public.book_characters;
create policy "characters: read for signed-in" on public.book_characters
  for select to authenticated using (true);
drop policy if exists "characters: user insert" on public.book_characters;
create policy "characters: user insert" on public.book_characters
  for insert to authenticated with check (true);
drop policy if exists "characters: user update own" on public.book_characters;
create policy "characters: user update own" on public.book_characters
  for update to authenticated using (true);
