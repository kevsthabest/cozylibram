-- book_trope_claims: work-keyed trope claims with status/confidence/provenance.
--
-- Extracted from the live Supabase project (dvhimjkrroxuatthiizc) 2026-10-04:
-- this table existed in production with no repo definition. This file is now
-- its source of truth — a fresh project must be able to run it.
--
-- Dependencies: is_admin() is defined in supabase/analytics.sql; the
-- trope_id foreign key targets public.tropes (supabase/tropes.sql) and the
-- work_id foreign key targets public.works (supabase/works.sql).
--
-- Status lifecycle: the AI backfill writes candidates (or confirmed rows for
-- high-confidence claims with quoted evidence); Trope Lab review flips them
-- to confirmed/rejected. A rejection wins over any candidate on the same
-- trope, and re-inference never re-inserts a rejected trope.

create table if not exists public.book_trope_claims (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.works (id) on delete cascade,
  trope_id text not null references public.tropes (id) on delete cascade,
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
  updated_at timestamptz not null default now()
);

-- Live lookups: a work's non-rejected claims, and claims by trope.
create index if not exists book_trope_claims_active_idx
  on public.book_trope_claims (work_id, trope_id) where (status <> 'rejected');
create index if not exists book_trope_claims_trope_idx
  on public.book_trope_claims (trope_id);

alter table public.book_trope_claims enable row level security;

-- policies (as live)
drop policy if exists "claims: admin write" on public.book_trope_claims;
create policy "claims: admin write" on public.book_trope_claims
  for all to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "claims: read for signed-in" on public.book_trope_claims;
create policy "claims: read for signed-in" on public.book_trope_claims
  for select to authenticated using (true);
drop policy if exists "claims: user insert ai candidates" on public.book_trope_claims;
create policy "claims: user insert ai candidates" on public.book_trope_claims
  for insert to authenticated
  with check (status = 'candidate' and source_type = 'ai');
drop policy if exists "claims: user insert ai auto-confirmed" on public.book_trope_claims;
create policy "claims: user insert ai auto-confirmed" on public.book_trope_claims
  for insert to authenticated
  with check (status = 'confirmed' and source_type = 'ai'
    and (evidence ->> 'auto_confirmed') = 'true');
drop policy if exists "claims: user replace ai regenerable" on public.book_trope_claims;
create policy "claims: user replace ai regenerable" on public.book_trope_claims
  for delete to authenticated
  using (source_type = 'ai' and (status = 'candidate'
    or (status = 'confirmed' and (evidence ->> 'auto_confirmed') = 'true')));
