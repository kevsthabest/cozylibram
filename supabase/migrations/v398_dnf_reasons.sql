-- v398: DNF reasons table for the DNF Autopsy feature.
-- Stores why users DNF books, enabling personal "avoid" profiles and
-- aggregate insights ("you DNF 80% of love triangles after 50%").

create table if not exists public.dnf_reasons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id text not null,
  reason text not null check (reason in ('too_slow','hated_trope','wrong_mood','writing_style','characters','too_long','other')),
  note text,
  progress_pct integer check (progress_pct is null or (progress_pct >= 0 and progress_pct <= 100)),
  created_at timestamptz not null default now()
);

create index if not exists idx_dnf_reasons_user on public.dnf_reasons (user_id);
create index if not exists idx_dnf_reasons_book on public.dnf_reasons (user_id, book_id);

alter table public.dnf_reasons enable row level security;

drop policy if exists "dnf_reasons: read own" on public.dnf_reasons;
create policy "dnf_reasons: read own" on public.dnf_reasons
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "dnf_reasons: insert own" on public.dnf_reasons;
create policy "dnf_reasons: insert own" on public.dnf_reasons
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "dnf_reasons: admin all" on public.dnf_reasons;
create policy "dnf_reasons: admin all" on public.dnf_reasons
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
