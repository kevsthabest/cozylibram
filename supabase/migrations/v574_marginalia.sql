-- v574 — Marginalia (wow queue #6): progress-gated circle notes on
-- the book page. Friends reading the same book leave short notes
-- pinned to a point in the book; a note is served to a viewer only
-- when the viewer's own progress has reached it.
--
-- The design, and the claims it does and does not make:
--
-- - POSITION IS A FRACTION, COMPUTED BY THE SERVER FROM THE
--   AUTHOR'S OWN COPY. A note stores (book_key, frac, page,
--   page_count, body). frac = the pinned page / the author's
--   edition pageCount; the client never supplies a fraction or a
--   key — marginalia_add() names the author's own book row, and the
--   server computes both. Page numbers lie across editions;
--   fractions don't. The pinned page defaults to the author's
--   current progress and may not exceed it (anti-spoiler by
--   construction: you cannot pin a note in territory you haven't
--   read). The honest bound, stated plainly: the gate governs
--   POSITION, not content — a carelessly written note pinned early
--   can still discuss later pages in its text. The body screen,
--   report-with-snapshot, block and caps below are the controls for
--   that residue; no mechanism in this migration claims otherwise.
--
-- - LOCKED NOTES NEVER CROSS THE WIRE. There is deliberately NO
--   select policy for friends on marginalia_notes: any direct table
--   read would bypass the fraction gate. The only read door is
--   marginalia_for_book(), which computes the viewer's fraction
--   from the viewer's own book rows at call time and returns only
--   notes at or below it (plus the viewer's own notes, always).
--   A locked note is not blurred, not counted, not hinted — it is
--   absent from the payload, the same omission discipline the
--   spoiler surfaces settled on. The one SELECT policy on the
--   table is the admins' (is_admin(), the Observatory's read);
--   writes are RPC-only (INSERT/UPDATE grants revoked; deletes go
--   through marginalia_delete / marginalia_admin_remove).
--
-- - PROGRESS IS THE CLOUD COPY, AND THE CLIENT MEETS IT HALFWAY.
--   The RPCs read public.books, which lags local progress by the
--   sync debounce — a note posted the second after logging pages
--   could otherwise pin at a stale, earlier position. The client
--   therefore flushes its push and re-reads its own row before
--   calling marginalia_add, and refuses to post when it cannot
--   confirm the push landed. The read side fails safe on the same
--   lag: notes unlock late, never early.
--
-- - FINISHED IS HISTORICAL, NOT CURRENT. A copy counts as finished
--   when its status is 'read' OR it carries a finish date OR a
--   readCount ≥ 1 OR previouslyRead — so starting a re-read (status
--   back to 'reading', progress low) never re-locks notes the first
--   read unlocked (spec: "when you finish the book, all friends'
--   notes unlock"). The viewer's fraction is the max over all their
--   copies with the key, each clamped to 1.
--
-- - CLIENT-WRITTEN JSONB IS PARSED DEFENSIVELY. books.data is
--   free-form (the v528 warning); marginalia_num() accepts only
--   JSON numbers and numeric strings and returns null for anything
--   else — a poisoned duplicate copy degrades to "no progress",
--   never an exception that kills the whole read.
--
-- - VISIBILITY COMPOSES WITH THE SHELF GATES. A friend's note is
--   served only while the author still owns a copy of the book
--   whose own status passes circle_book_visible(author, status)
--   for this viewer — share_library and hidden_shelves govern
--   notes exactly as they govern shelves ("friends still see you,
--   but none of your books" includes your margin notes). Deleting
--   every copy withdraws the notes from friends (they persist,
--   hidden; the author can still enumerate and delete them via
--   marginalia_mine()). Friendship and blocks are re-checked on
--   every read, so unfriending hides in both directions at once —
--   there is deliberately NO unfriend cleanup trigger: notes are
--   author × book, not pair × book, and other friends with the
--   book keep their shared margin.
--
-- - THE OPT-OUT HAS SERVER TEETH. profiles.marginalia_enabled
--   (default true, deliberately NOT projected to friends — the
--   receive_recos / receive_buddy_invites decision) is
--   authoritative for serving: off means the author's notes are
--   not served to anyone, their writes refuse, and their own read
--   RPC returns nothing. The client mirrors the flag in the roamed
--   prefs key for UI state and reconciles from profiles.
--
-- - MODERATION IS WIRED BEFORE VISIBILITY (spec §5). Every note
--   carries Report and Block in the client; Report goes through
--   marginalia_report(), which snapshots the note's id, position
--   and body into the user_reports row server-side — an admin
--   reviewing in the Observatory sees the actual text, not a
--   reporter's paraphrase — and admins can read the notes table
--   (the is_admin policy) and remove a note outright
--   (marginalia_admin_remove()). Block severs the circle link
--   (v526), which the read-time friendship check turns into
--   invisibility in both directions. The body is additionally
--   screened at write time with the v550 slur screen
--   (handle_screen_hit, 'bio' mode — whole-token, the profile-bio
--   lane); a hit refuses the post with a generic shape that never
--   echoes the term. Screen + report + block are layers, in that
--   order; none of them claims to make a determined spoiler
--   impossible — see the position/content bound above.
--
-- - CAPS ARE EXACT, NOT RACED. Sends take a per-author advisory
--   transaction lock (the v527 discipline) before counting: 50
--   notes/day per author, 20 live notes per (author, book). The
--   read returns at most 500 notes for a book.
--
-- - THE EDITION BOUND, STATED. Keys are toy_book_key (v527) with
--   one refinement: the ISBN is normalized to ISBN-13 first
--   (marginalia_isbn13), so a 10-digit and a 13-digit copy of the
--   same edition meet here even though the app's other surfaces key
--   on the stored form; both RPCs share marginalia_book_key, so
--   the feature is internally consistent by construction.
--   Different ISBN-13s remain different books, as on every social
--   surface in this app; ISBN-less copies key on title + first
--   author and DO meet across editions — that meeting is where the
--   fraction position and the client's "about a third in" label
--   earn their keep.
--
-- - RETENTION: notes persist after both readers finish (the margin
--   record of a shared read), deletable by the author anytime —
--   including after the author's own copy is gone, via
--   marginalia_mine().

-- The author's off switch. Existing accounts default to enabled
-- (see header); never projected to friends.
alter table public.profiles
  add column if not exists marginalia_enabled boolean not null default true;

create table if not exists public.marginalia_notes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users (id) on delete cascade,
  book_key text not null,
  frac double precision not null check (frac > 0 and frac <= 1),
  page integer not null check (page >= 1),
  page_count integer not null check (page_count >= 1),
  body text not null check (char_length(body) between 1 and 280),
  created_at timestamptz not null default now()
);
create index if not exists marginalia_notes_book_idx
  on public.marginalia_notes (book_key, frac);
create index if not exists marginalia_notes_author_idx
  on public.marginalia_notes (author_id, created_at);

create table if not exists public.marginalia_send_log (
  author_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists marginalia_send_log_author_idx
  on public.marginalia_send_log (author_id, created_at);

alter table public.marginalia_notes enable row level security;
alter table public.marginalia_send_log enable row level security;

-- Machinery table: nobody reads or writes it directly, ever.
revoke all on public.marginalia_send_log from public, anon, authenticated;

-- Notes table: reads exist only through marginalia_for_book() and
-- the admin policy below. Direct INSERT/UPDATE/DELETE grants are
-- revoked so no PostgREST path can bypass the RPC doors; SELECT
-- stays granted but is row-gated by the lone admin policy — a
-- non-admin's direct select returns zero rows.
revoke insert, update, delete on public.marginalia_notes from authenticated;
revoke all on public.marginalia_notes from anon;

-- The Observatory's read (and the only SELECT policy on the table).
drop policy if exists "admins read marginalia notes" on public.marginalia_notes;
create policy "admins read marginalia notes" on public.marginalia_notes
  for select
  using (is_admin());

-- (Deliberately NO other policies: marginalia_add(),
-- marginalia_for_book(), marginalia_delete(), marginalia_report(),
-- marginalia_mine() and marginalia_admin_remove() are the only
-- doors, and the read door is fraction-gated.)

-- ---------- private machinery (definer-called only) ----------

-- A numeric-ish jsonb field: JSON numbers and numeric strings
-- count; anything else is null. Never raises (books.data is
-- client-written free-form jsonb — see header).
create or replace function public.marginalia_num(p_data jsonb, p_key text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when p_data is null then null
    when jsonb_typeof(p_data -> p_key) = 'number' then (p_data ->> p_key)::numeric
    when jsonb_typeof(p_data -> p_key) = 'string'
         and (p_data ->> p_key) ~ '^[0-9]+(\.[0-9]+)?$' then (p_data ->> p_key)::numeric
    else null
  end;
$$;
revoke all on function public.marginalia_num(jsonb, text) from public;

-- ISBN-10 → ISBN-13 (978 prefix + recomputed check digit); a
-- 13-digit input passes through; anything else returns ''.
create or replace function public.marginalia_isbn13(p_isbn text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := coalesce(p_isbn, '');
  v12 text;
  v_sum int := 0;
  v_i int;
begin
  if length(v) = 13 then return v; end if;
  if length(v) <> 10 then return ''; end if;
  v12 := '978' || left(v, 9);
  for v_i in 1..12 loop
    v_sum := v_sum + (substr(v12, v_i, 1)::int) * (case when v_i % 2 = 1 then 1 else 3 end);
  end loop;
  return v12 || ((10 - (v_sum % 10)) % 10)::text;
end;
$$;
revoke all on function public.marginalia_isbn13(text) from public;

-- The feature's book key: toy_book_key (v527) over an
-- ISBN-13-normalized ISBN, computed from a books row's data exactly
-- as v528 computes it (data.isbn first, the column as fallback;
-- first author from the array-or-string field). Both marginalia
-- RPCs use this and only this, so writer and viewer always agree.
create or replace function public.marginalia_book_key(p_data jsonb, p_isbn_col text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_isbn text;
begin
  v_isbn := upper(regexp_replace(coalesce(nullif(p_data ->> 'isbn', ''), p_isbn_col, ''), '[^0-9Xx]', '', 'g'));
  if length(v_isbn) not in (10, 13) then v_isbn := ''; else v_isbn := public.marginalia_isbn13(v_isbn); end if;
  return public.toy_book_key(
    v_isbn,
    p_data ->> 'title',
    case when jsonb_typeof(p_data -> 'authors') = 'array' then p_data -> 'authors' ->> 0
         when jsonb_typeof(p_data -> 'authors') = 'string' then p_data ->> 'authors'
         else '' end
  );
end;
$$;
revoke all on function public.marginalia_book_key(jsonb, text) from public;

-- One copy's HISTORICAL read fraction (see header): 1 for a copy
-- the reader has finished by any recorded evidence, else the
-- clamped progress fraction, else 0.
create or replace function public.marginalia_copy_frac(p_data jsonb)
returns double precision
language plpgsql
immutable
set search_path = public
as $$
declare
  v_prog numeric := public.marginalia_num(p_data, 'progress');
  v_pc numeric := public.marginalia_num(p_data, 'pageCount');
begin
  if coalesce(p_data ->> 'status', '') = 'read'
     or nullif(btrim(coalesce(p_data ->> 'dateFinished', '')), '') is not null
     or coalesce(public.marginalia_num(p_data, 'readCount'), 0) >= 1
     or coalesce(p_data ->> 'previouslyRead', '') = 'true'
  then return 1; end if;
  if v_pc is null or v_pc <= 0 or v_prog is null or v_prog <= 0 then return 0; end if;
  return least(1, v_prog / v_pc)::double precision;
end;
$$;
revoke all on function public.marginalia_copy_frac(jsonb) from public;

-- ---------- the write door ----------

-- Leave a note. The client names its own book by id and (only) a
-- page + text; the server owns the key, the fraction, the
-- eligibility and the caps. Answers: 'ok', 'slow_down' (the daily
-- cap — the author's own fact, safe to name), 'off' (the author's
-- own switch). Validation failures raise honest errors — they are
-- all facts about the CALLER's own book and note, never about
-- anyone else.
create or replace function public.marginalia_add(p_book_id text, p_page integer, p_body text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_key text;
  v_on boolean;
  v_prog numeric;
  v_pc numeric;
  v_cur integer;
  v_pci integer;
  v_page integer;
  v_body text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  -- One author's writes are serialised, so the caps below are
  -- exact rather than racy (the v527 discipline).
  perform pg_advisory_xact_lock(hashtextextended('marginalia:' || v_uid::text, 0));
  -- The book must be the author's own (the server owns the key).
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  if btrim(coalesce(v_row.data ->> 'title', '')) = '' then raise exception 'no such book'; end if;
  -- The author's own switch, checked before any other work.
  select p.marginalia_enabled into v_on from public.profiles p where p.user_id = v_uid;
  if found and v_on is distinct from true then return 'off'; end if;

  v_prog := public.marginalia_num(v_row.data, 'progress');
  v_pc := public.marginalia_num(v_row.data, 'pageCount');
  v_cur := coalesce(floor(v_prog)::integer, 0);
  if v_cur < 1 then raise exception 'no progress yet'; end if;
  if v_pc is null or v_pc < 1 then raise exception 'page count needed'; end if;
  v_pci := floor(v_pc)::integer;
  v_page := coalesce(p_page, v_cur);
  if v_page < 1 or v_page > v_cur then raise exception 'pin outside your progress'; end if;

  v_body := btrim(coalesce(p_body, ''));
  if char_length(v_body) < 1 or char_length(v_body) > 280 then raise exception 'note length'; end if;
  -- The v550 slur screen ('bio' lane: whole-token). A hit refuses
  -- with a generic shape; the term is never echoed back.
  if public.handle_screen_hit(v_body, 'bio') is not null then raise exception 'note refused'; end if;

  v_key := public.marginalia_book_key(v_row.data, v_row.isbn);

  -- Caps, under the lock: 50/day per author (the one distinct
  -- outcome), 20 live notes per (author, book).
  if (select count(*) from public.marginalia_send_log l
       where l.author_id = v_uid
         and l.created_at >= date_trunc('day', now())) >= 50
  then return 'slow_down'; end if;
  if (select count(*) from public.marginalia_notes n
       where n.author_id = v_uid and n.book_key = v_key) >= 20
  then raise exception 'too many notes on this book'; end if;

  insert into public.marginalia_notes (author_id, book_key, frac, page, page_count, body)
  values (v_uid, v_key, v_page::double precision / v_pci::double precision, v_page, v_pci, v_body);
  insert into public.marginalia_send_log (author_id) values (v_uid);

  -- Opportunistic prune (bounded, indexed): the log keeps 2 days.
  delete from public.marginalia_send_log where created_at < now() - interval '2 days';
  return 'ok';
end;
$$;
revoke all on function public.marginalia_add(text, integer, text) from public;
grant execute on function public.marginalia_add(text, integer, text) to authenticated;

-- ---------- the read door (fraction-gated) ----------

-- The notes for one of the caller's own books, gated by the
-- caller's own progress (see header). Returns a jsonb array of
-- {id, author_id, frac, page, page_count, body, created_at} ordered
-- by position. Anything not returned does not exist as far as the
-- payload is concerned: no count, no placeholder, no error shape
-- distinguishing "locked notes exist" from "no notes".
create or replace function public.marginalia_for_book(p_book_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_key text;
  v_on boolean;
  v_frac double precision;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  if btrim(coalesce(v_row.data ->> 'title', '')) = '' then raise exception 'no such book'; end if;
  -- The viewer's own switch: off means no notes, full stop.
  select p.marginalia_enabled into v_on from public.profiles p where p.user_id = v_uid;
  if found and v_on is distinct from true then return '[]'::jsonb; end if;

  v_key := public.marginalia_book_key(v_row.data, v_row.isbn);
  select coalesce(max(public.marginalia_copy_frac(b.data)), 0) into v_frac
    from public.books b
   where b.user_id = v_uid
     and public.marginalia_book_key(b.data, b.isbn) = v_key;

  return coalesce((
    select jsonb_agg(row_to_json(t) order by t.frac asc, t.created_at asc)
    from (
      select n.id, n.author_id, n.frac, n.page, n.page_count, n.body, n.created_at
        from public.marginalia_notes n
       where n.book_key = v_key
         and (
           n.author_id = v_uid
           or (
             n.frac <= v_frac
             -- The author's switch: off withdraws their notes.
             and coalesce((select p.marginalia_enabled from public.profiles p
                            where p.user_id = n.author_id), true)
             -- The author's matched copy is visible to me through
             -- the shelf gates (link + share_library +
             -- hidden_shelves + the copy still exists), composed
             -- per copy status like the buddy gate.
             and exists (
               select 1 from public.books ab
                where ab.user_id = n.author_id
                  and public.marginalia_book_key(ab.data, ab.isbn) = v_key
                  and public.circle_book_visible(n.author_id, ab.data ->> 'status')
             )
             -- No block in either direction (belt over the link
             -- sever + the visibility helper's own blocked branch).
             and not exists (
               select 1 from public.blocks bl
                where (bl.blocker_id = v_uid and bl.blocked_id = n.author_id)
                   or (bl.blocker_id = n.author_id and bl.blocked_id = v_uid)
             )
           )
         )
       order by n.frac asc, n.created_at asc
       limit 500
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.marginalia_for_book(text) from public;
grant execute on function public.marginalia_for_book(text) to authenticated;

-- ---------- the author's own doors ----------

-- Delete one of my notes. Always 'ok': whether a row existed is
-- the caller's own business only.
create or replace function public.marginalia_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  delete from public.marginalia_notes
   where id = p_id and author_id = v_uid;
  return 'ok';
end;
$$;
revoke all on function public.marginalia_delete(uuid) from public;
grant execute on function public.marginalia_delete(uuid) to authenticated;

-- My notes, all of them, for the "My margin notes" list — the
-- author's enumeration that survives losing the book copy (see
-- header: deleting a copy must not strand its notes beyond the
-- author's reach). Caller-scoped by construction.
create or replace function public.marginalia_mine()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  return coalesce((
    select jsonb_agg(row_to_json(t) order by t.created_at desc)
    from (
      select n.id, n.book_key, n.frac, n.page, n.page_count, n.body, n.created_at
        from public.marginalia_notes n
       where n.author_id = v_uid
       order by n.created_at desc
       limit 200
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.marginalia_mine() from public;
grant execute on function public.marginalia_mine() to authenticated;

-- ---------- moderation doors ----------

-- Report a note. The server snapshots the note (id, key, position,
-- body) into the report's details, so the Observatory reviews the
-- actual text. Reasons are the user_reports CHECK list; anything
-- else files as 'other'. Reporting your own note, or a note that
-- doesn't exist, is a silent 'ok' — the reporter's business only.
create or replace function public.marginalia_report(p_note_id uuid, p_reason text, p_details text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_n record;
  v_reason text := coalesce(p_reason, 'other');
  v_details text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if v_reason not in ('spam', 'harassment', 'inappropriate', 'fake_account', 'other') then
    v_reason := 'other';
  end if;
  select id, author_id, book_key, frac, body into v_n
    from public.marginalia_notes where id = p_note_id;
  if not found or v_n.author_id = v_uid then return 'ok'; end if;
  v_details := left(coalesce(p_details, ''), 500)
    || '\n— Margin note ' || v_n.id::text
    || ' (book key ' || v_n.book_key
    || ', position ' || round((v_n.frac * 100)::numeric)::text || '% in): "'
    || v_n.body || '"';
  insert into public.user_reports (reporter_id, reported_user_id, reason, details)
  values (v_uid, v_n.author_id, v_reason, v_details);
  return 'ok';
end;
$$;
revoke all on function public.marginalia_report(uuid, text, text) from public;
grant execute on function public.marginalia_report(uuid, text, text) to authenticated;

-- Admin removal (the Observatory's delete). A non-admin call is a
-- silent no-op — the function's existence is public, its effect is
-- not probeable.
create or replace function public.marginalia_admin_remove(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not is_admin() then return 'ok'; end if;
  delete from public.marginalia_notes where id = p_id;
  return 'ok';
end;
$$;
revoke all on function public.marginalia_admin_remove(uuid) from public;
grant execute on function public.marginalia_admin_remove(uuid) to authenticated;
