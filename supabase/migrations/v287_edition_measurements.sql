-- v287: calibrated physical-edition measurements
--
-- Measurements are evidence too: each submission is retained, owned by the
-- contributor, and a private trigger chooses the strongest measurement.
-- Page count is deliberately not used as a thickness measurement.

alter table public.editions add column if not exists thickness_mm numeric;
alter table public.editions add column if not exists thickness_source text;
alter table public.editions add column if not exists thickness_confidence numeric;
alter table public.editions add column if not exists thickness_measured_at timestamptz;

create table if not exists public.edition_measurements (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid not null references public.editions(id) on delete cascade,
  isbn text not null,
  measured_by uuid references auth.users(id) on delete set null,
  thickness_mm numeric not null check (thickness_mm > 0 and thickness_mm < 100),
  reference_width_mm numeric not null default 85.60 check (reference_width_mm > 0),
  reference_pixels numeric not null check (reference_pixels > 0),
  thickness_pixels numeric not null check (thickness_pixels > 0),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 100)),
  method text not null default 'id1-card',
  verified boolean not null default false,
  rejected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists edition_measurements_edition_idx
  on public.edition_measurements (edition_id);

alter table public.edition_measurements enable row level security;

drop policy if exists "edition_measurements public read" on public.edition_measurements;
create policy "edition_measurements authenticated read" on public.edition_measurements
  for select to authenticated using (not rejected);

drop policy if exists "edition_measurements contributor insert" on public.edition_measurements;
create policy "edition_measurements contributor insert" on public.edition_measurements
  for insert to authenticated
  with check (
    measured_by = auth.uid()
    and verified = false
    and rejected = false
    and exists (
      select 1 from public.editions e
      where e.id = edition_measurements.edition_id
        and e.isbn = edition_measurements.isbn
    )
  );

drop policy if exists "edition_measurements contributor update" on public.edition_measurements;
create policy "edition_measurements contributor update" on public.edition_measurements
  for update to authenticated
  using (measured_by = auth.uid() or is_admin())
  with check (
    (measured_by = auth.uid() and verified = false and rejected = false)
    or is_admin()
  );

drop policy if exists "edition_measurements contributor delete" on public.edition_measurements;
create policy "edition_measurements contributor delete" on public.edition_measurements
  for delete to authenticated
  using (measured_by = auth.uid() or is_admin());

drop policy if exists "edition_measurements admin write" on public.edition_measurements;
create policy "edition_measurements admin write" on public.edition_measurements
  for all to authenticated using (is_admin()) with check (is_admin());

create schema if not exists private;

create or replace function private.edition_measurements_select_best(p_edition_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  best_id uuid;
  best_mm numeric;
  best_conf numeric;
  best_verified boolean;
begin
  select id, thickness_mm, confidence, verified
    into best_id, best_mm, best_conf, best_verified
  from public.edition_measurements
  where edition_id = p_edition_id
    and not rejected
  order by verified desc,
           coalesce(confidence, 0) desc,
           created_at asc,
           id asc
  limit 1;

  update public.editions
  set thickness_mm = case when best_id is null then null else best_mm end,
      thickness_source = case when best_id is null then null
        when best_verified then 'verified-measurement' else 'measurement' end,
      thickness_confidence = case when best_id is null then null else best_conf end,
      thickness_measured_at = case when best_id is null then null else now() end,
      updated_at = now()
  where id = p_edition_id;

  return best_id;
end;
$$;

revoke execute on function private.edition_measurements_select_best(uuid)
  from public, anon, authenticated;

create or replace function private.edition_measurements_canonical_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.edition_measurements_select_best(coalesce(new.edition_id, old.edition_id));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke execute on function private.edition_measurements_canonical_trigger()
  from public, anon, authenticated;

drop trigger if exists edition_measurements_canonical_after_write
  on public.edition_measurements;
create trigger edition_measurements_canonical_after_write
after insert or update of thickness_mm, confidence, verified, rejected
  or delete
on public.edition_measurements
for each row
execute function private.edition_measurements_canonical_trigger();
