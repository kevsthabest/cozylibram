-- v194: harden book_meta against defacement (security review finding #5).
--
-- The app legitimately overwrites rows (the enriched upsert lands seconds
-- after the lookup put; stale rows refresh after 30 days), so the table
-- can't be insert-only. Instead this migration adds write attribution and
-- gates UPDATEs: only the row's creator or a genuine stale refresh may
-- overwrite. Run once against the live database; safe to re-run.
--
-- Applied 2026-09-29 via the Supabase Management API.

alter table book_meta
  add column if not exists created_by uuid,
  add column if not exists updated_by uuid;

drop policy if exists "refresh meta" on book_meta;
create policy "refresh meta" on book_meta
  for update
  using (auth.role() = 'authenticated' and (
    created_by is null
    or created_by = auth.uid()
    or fetched_at < now() - interval '30 days'
  ))
  with check (auth.role() = 'authenticated');

create or replace function book_meta_guard() returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    NEW.created_by := auth.uid();
    NEW.updated_by := auth.uid();
    return NEW;
  end if;
  NEW.updated_by := auth.uid();
  if OLD.fetched_at < now() - interval '30 days' then
    NEW.created_by := auth.uid();
  else
    NEW.created_by := coalesce(OLD.created_by, auth.uid());
  end if;
  return NEW;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists book_meta_guard_trg on book_meta;
create trigger book_meta_guard_trg
  before insert or update on book_meta
  for each row execute function book_meta_guard();
