-- v527 — Social build #2: "Thought of you" directed recommendations.
--
-- A reader sends one of THEIR OWN books to a specific circle friend,
-- with an optional short note. It lands as a card in the friend's
-- Hearth ("Thought of you"): sender, book, note, one-tap +TBR,
-- dismiss. Until now recommendations were algorithmic only (v97).
--
-- The design went through two red-team rounds; the load-bearing
-- decisions, and the claims this file does and does not make:
--
-- - THE SERVER OWNS THE BOOK. The client names a book by id only.
--   send_thought_of_you() reads the sender's own books row and builds
--   the display snapshot itself from whitelisted scalar fields with
--   type checks and length caps (series is rebuilt as {name,
--   position}; nothing nested passes through). The sender's personal
--   fields (their ratings — including their spice rating — progress,
--   dates, notes) never enter the row: the covenCleanCopy rule (v97),
--   enforced at the only write door. A client-supplied book payload
--   is never accepted, so a "recommendation" cannot be fabricated
--   content in a book costume.
--
-- - COVERS CANNOT PHONE HOME. A snapshot cover is stored only when
--   toy_cover_ok() passes: a data:image/ URL (self-contained, length
--   capped), this project's content-addressed covers-bucket URL
--   (the cache-cover adoption shape: sha256 key under
--   /storage/v1/object/public/covers/), or an https URL whose parsed
--   host is exactly one of the cover-provider hosts (the union of
--   the sets in functions/_lib/cover-hosts.js — pinned equal by
--   test). No sender-chosen host can ever load in the recipient's
--   client, so the card cannot become a tracking pixel / read
--   receipt. Host matching is parsed-authority equality, never a
--   prefix LIKE: userinfo, suffix and subdomain shapes all fail.
--
-- - FIRE-AND-FORGET, IN RETURN VALUE. There are no counts or
--   tallies of recommendations anywhere, no sent list, and no read
--   receipts — and the receipts are closed at the data layer, not
--   the UI: the sender has NO select policy and NO delete policy on
--   thought_of_you (a PostgREST delete returns an affected-row
--   count, which would be a one-bit receipt oracle). The send RPC
--   returns the constant 'ok' for a real insert AND for every
--   refusal the sender must not be able to distinguish: duplicate,
--   dismissal tombstone, recipient opted out, recipient already owns
--   the book. Probing is idempotent — it creates the state it asks
--   about and learns nothing. The one distinct outcome is
--   'slow_down', returned when the SENDER's own daily caps refuse
--   the send: a sender's own volume is their own state (like the
--   'note too long' refusal), not a signal about the recipient.
--   Recall, for a mis-sent book, goes through
--   recall_thought_of_you(), which always answers 'ok' whether or
--   not a row existed. (Indistinguishability is claimed for return
--   values; no timing guarantee is made or needed at this scale.)
--
-- - ENTITLEMENT IS RE-VALIDATED AT WRITE TIME (the v525 pattern):
--   signed-in → note length → the book is really the sender's →
--   accepted friendship AND no block in either direction (one
--   generic 'not circle friends': a blocked pair is
--   indistinguishable from an unfriended one, per v526) → only then
--   the silent outcomes. A nonexistent recipient profile is treated
--   as opted-out AFTER the friendship gate, so the RPC is not a
--   user-existence oracle either.
--
-- - CAPS ARE EXACT, NOT ASPIRATIONAL. The send RPC takes a
--   per-sender advisory transaction lock before counting, so the
--   5-per-pair-per-day and 20-per-sender-per-day caps cannot be
--   raced. Caps count the append-only toy_send_log, which dismissals
--   never touch — regaining capacity therefore leaks nothing about
--   the recipient. Dedupe is a real unique constraint
--   (sender_id, recipient_id, book_key) with insert-on-conflict-do-
--   nothing behind the explicit duplicate check.
--
-- - DISMISSAL MEANS NO. Dismiss goes through
--   dismiss_thought_of_you(), which writes a toy_dismissals
--   tombstone before deleting the row; a tombstoned (pair, book)
--   silently no-ops for a year. +TBR does NOT tombstone (the
--   already-owned check suppresses re-sends while the book is
--   owned; if the recipient later removes it, a friend may
--   recommend it again). Cleanup-trigger deletions and recalls
--   don't tombstone either — they aren't the recipient saying no.
--
-- - READ-TIME DEFENCE IN DEPTH (the v526 pattern, stated honestly):
--   the SELECT policy requires recipient + an accepted link right
--   now + the card younger than 60 days (expiry), so a card that
--   outlives its friendship is unreadable even before the cleanup
--   trigger removes it. The policy's block predicate can only see
--   blocks the RECIPIENT placed (policy subqueries read blocks
--   under the caller's RLS — the v526 trap); the other direction is
--   covered by the sever (a block deletes the pair's links, which
--   the link predicate then fails) plus the cleanup trigger below.
--
-- - THE SHIELD (v524) APPLIES AT RENDER, ON THE RECIPIENT'S SIDE:
--   the recipient's client filters cards before any HTML is built,
--   awaiting the spice map first (the js/196 discipline). Known
--   high-spice (≥4, the v524 threshold) cards are held — cover,
--   title and note together; unknown spice follows the v524 rule
--   (not high-spice). The bound the shield claims is known work
--   identity, not content: it is a viewer-side display filter,
--   never a server boundary, exactly as v524 states. A shielded
--   recipient with held cards sees a content-free line ("some
--   recommendations are hidden by your content shield") — no
--   number, no sender, no title.
--
-- - CONSENT: profiles.receive_recos (default true) is the
--   recipient's off switch, in the Circle & privacy panel. It is
--   deliberately NOT added to the circle_profiles projection — its
--   value is itself a private fact (a friend who could read it
--   would know the refusal shape), unlike the share_* posture flags
--   the view carries. Default true is a called-out decision: the
--   exposure is inbound-only, from friends the recipient
--   affirmatively accepted, and every card carries Report/Block.
--
-- - UNFRIEND CLEANUP + THE #190 FIX: the trigger below mirrors
--   v525 (delete the pair's rows when no accepted link remains).
--   accept_circle_invite() used to delete + re-insert links, which
--   fires those triggers while the friendship is alive (issue
--   #190's mechanism: re-redeeming an existing friend's invite
--   wipes the pair's reactions). This migration amends the
--   function: after the block check and the own-invite check, an
--   already-accepted pair returns immediately (clearing any stale
--   non-accepted rows, whose deletion cannot fire cleanup while
--   the accepted link stands). That fixes the mechanism for both
--   features.
--
-- - toy_send_log and toy_dismissals are machinery, not surfaces:
--   RLS on, every grant revoked, zero policies. Only the definer
--   functions below touch them, so neither a social graph of pushes
--   nor a record of rejections is readable by anyone.

-- The recipient's off switch. Existing accounts default to receiving
-- (see header); never projected to friends.
alter table public.profiles
  add column if not exists receive_recos boolean not null default true;

-- The dedupe key, implemented once, here (the client-side recoKey in
-- js/196 has the same semantics; Unicode case-folding edges may
-- differ, and every divergence fails safe: a duplicate card or a
-- silent no-op, never a leak). ISBN when a valid one exists (10/13
-- stripped chars — the RPC normalises before calling), else
-- normalized title + first author.
create or replace function public.toy_book_key(p_isbn text, p_title text, p_first_author text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_isbn, '') <> '' then 'isbn:' || p_isbn
    else 'ta:' || lower(btrim(coalesce(p_title, ''))) || '|' || lower(btrim(coalesce(p_first_author, '')))
  end;
$$;
revoke all on function public.toy_book_key(text, text, text) from public;
grant execute on function public.toy_book_key(text, text, text) to authenticated;

-- Cover admissibility (see header). Parsed-authority host equality
-- against the union of the cover-hosts.js sets; the bucket shape is
-- this project's content-addressed adoption path only.
create or replace function public.toy_cover_ok(p_url text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_url is null or p_url = '' then true
    when left(p_url, 11) = 'data:image/' and length(p_url) <= 204800 then true
    when length(p_url) > 1000 then false
    when p_url ~ '^https://dvhimjkrroxuatthiizc\.supabase\.co/storage/v1/object/public/covers/[0-9a-f]{64}\.(jpg|jpeg|png|webp|gif|avif)$' then true
    when exists (
      select 1
      from unnest(array[
        'covers.openlibrary.org', 'books.google.com', 'assets.hardcover.app',
        'img.hardcover.app', 'images-na.ssl-images-amazon.com', 'm.media-amazon.com',
        'archive.org', 'hardcover.app', 'i.gr-assets.com',
        'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
        'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'
      ]) as h(host)
      where p_url ~ ('^https://' || replace(h.host, '.', '\.') || '(:[0-9]+)?([/?#]|$)')
    ) then true
    else false
  end;
$$;
revoke all on function public.toy_cover_ok(text) from public;
grant execute on function public.toy_cover_ok(text) to authenticated;

create table if not exists public.thought_of_you (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  sender_book_id text not null,
  book_key text not null,
  book jsonb not null,
  note text not null default '' check (char_length(note) <= 140),
  created_at timestamptz not null default now(),
  unique (sender_id, recipient_id, book_key),
  check (sender_id <> recipient_id)
);
create index if not exists thought_of_you_recipient_idx
  on public.thought_of_you (recipient_id, created_at desc);

create table if not exists public.toy_send_log (
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists toy_send_log_sender_idx
  on public.toy_send_log (sender_id, created_at);

create table if not exists public.toy_dismissals (
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  book_key text not null,
  created_at timestamptz not null default now(),
  primary key (sender_id, recipient_id, book_key)
);

alter table public.thought_of_you enable row level security;
alter table public.toy_send_log enable row level security;
alter table public.toy_dismissals enable row level security;

-- Machinery tables: nobody reads or writes them directly, ever.
revoke all on public.toy_send_log from public, anon, authenticated;
revoke all on public.toy_dismissals from public, anon, authenticated;

-- The recipient reads their inbox — while the friendship stands,
-- unexpired (60 days), and (for blocks they placed) unblocked.
drop policy if exists "recipient reads recommendations" on public.thought_of_you;
create policy "recipient reads recommendations" on public.thought_of_you
  for select
  using (
    auth.uid() = recipient_id
    and created_at > now() - interval '60 days'
    and exists (
      select 1 from public.circle_links cl
      where cl.status = 'accepted'
        and ((cl.requester_id = sender_id and cl.addressee_id = recipient_id)
          or (cl.requester_id = recipient_id and cl.addressee_id = sender_id))
    )
    and not exists (
      select 1 from public.blocks b
      where b.blocker_id = auth.uid() and b.blocked_id = sender_id
    )
  );

-- The recipient may delete rows addressed to them (the +TBR path
-- removes a card once the book is theirs; Dismiss proper goes
-- through the RPC so it can tombstone). The count a delete returns
-- tells the recipient only about their own inbox.
drop policy if exists "recipient deletes recommendations" on public.thought_of_you;
create policy "recipient deletes recommendations" on public.thought_of_you
  for delete
  using (auth.uid() = recipient_id);

-- (Deliberately NO sender policies: no select — fire-and-forget;
-- no delete — a delete's row count would be a receipt oracle;
-- no insert/update — send_thought_of_you() is the only door.)

-- The only write path. SECURITY DEFINER (the react_to_moment
-- pattern): validates the whole claim in a pinned order, builds the
-- snapshot from the sender's own book row, and answers with the
-- indistinguishable outcomes described in the header.
create or replace function public.send_thought_of_you(p_recipient uuid, p_book_id text, p_note text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_data jsonb;
  v_title text;
  v_authors jsonb;
  v_first_author text;
  v_isbn text;
  v_cover text;
  v_key text;
  v_snap jsonb;
  v_recv boolean;
  v_inserted boolean;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  -- One sender's sends are serialised, so the cap counts below are
  -- exact rather than racy (check-then-insert under READ COMMITTED
  -- would let concurrent calls both pass).
  perform pg_advisory_xact_lock(hashtextextended('toy-send:' || v_uid::text, 0));
  if char_length(coalesce(p_note, '')) > 140 then
    raise exception 'note too long';
  end if;
  -- The book must be the sender's own (the server owns the book).
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  v_data := coalesce(v_row.data, '{}'::jsonb);
  v_title := left(coalesce(v_data ->> 'title', ''), 300);
  if btrim(v_title) = '' then raise exception 'no such book'; end if;
  -- Friendship, with blocks folded into the same generic refusal
  -- (v526: a blocked pair is indistinguishable from an unlinked one).
  if p_recipient = v_uid
     or not exists (
       select 1 from public.circle_links cl
       where cl.status = 'accepted'
         and ((cl.requester_id = v_uid and cl.addressee_id = p_recipient)
           or (cl.addressee_id = v_uid and cl.requester_id = p_recipient))
     )
     or exists (
       select 1 from public.blocks b
       where (b.blocker_id = v_uid and b.blocked_id = p_recipient)
          or (b.blocker_id = p_recipient and b.blocked_id = v_uid)
     )
  then raise exception 'not circle friends'; end if;
  -- Recipient posture, read only after the friendship gate: a
  -- missing profile row is treated as opted out (silent), so this
  -- function is not a user-existence oracle.
  select p.receive_recos into v_recv from public.profiles p where p.user_id = p_recipient;
  if not found or v_recv is distinct from true then return 'ok'; end if;

  -- The sender's own caps: the one distinct outcome (see header).
  -- Checked BEFORE the silent outcomes below, deliberately: an
  -- over-cap sender must hear 'slow_down' uniformly, so the answer
  -- reports only the sender's own volume. Were the silent checks
  -- first, a dismissed (or duplicate, or already-owned) book would
  -- answer 'ok' while a fresh book answered 'slow_down' — and that
  -- differential would resolve to a dismissal receipt.
  if (select count(*) from public.toy_send_log l
       where l.sender_id = v_uid and l.recipient_id = p_recipient
         and l.created_at >= date_trunc('day', now())) >= 5
     or (select count(*) from public.toy_send_log l
       where l.sender_id = v_uid
         and l.created_at >= date_trunc('day', now())) >= 20
  then return 'slow_down'; end if;

  -- Snapshot: a fresh object built from whitelisted scalars only.
  v_authors := (
    select coalesce(jsonb_agg(a order by ord), '[]'::jsonb)
    from (
      select left(a, 120) as a, ord
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_data -> 'authors') = 'array' then v_data -> 'authors'
          when jsonb_typeof(v_data -> 'authors') = 'string' then jsonb_build_array(v_data ->> 'authors')
          else '[]'::jsonb
        end
      ) with ordinality as t(a, ord)
      where btrim(a) <> ''
      limit 8
    ) s
  );
  v_first_author := coalesce(v_authors ->> 0, '');
  v_isbn := upper(regexp_replace(coalesce(nullif(v_data ->> 'isbn', ''), v_row.isbn, ''), '[^0-9Xx]', '', 'g'));
  if length(v_isbn) not in (10, 13) then v_isbn := ''; end if;
  v_cover := coalesce(v_data ->> 'cover', '');
  if not public.toy_cover_ok(v_cover) then v_cover := ''; end if;
  v_key := public.toy_book_key(v_isbn, v_title, v_first_author);
  v_snap := jsonb_build_object(
    'title', v_title,
    'authors', v_authors,
    'isbn', v_isbn,
    'cover', v_cover,
    'coverColor', case when coalesce(v_data ->> 'coverColor', '') ~ '^#[0-9a-fA-F]{6}$'
                       then v_data ->> 'coverColor' else '' end,
    'series', case when jsonb_typeof(v_data -> 'series') = 'object'
                        and btrim(coalesce(v_data -> 'series' ->> 'name', '')) <> ''
                   then jsonb_build_object(
                     'name', left(v_data -> 'series' ->> 'name', 200),
                     'position', left(coalesce(v_data -> 'series' ->> 'position', ''), 20))
                   else null end,
    'seriesPos', left(coalesce(v_data ->> 'seriesPos', ''), 20),
    'genres', (
      select coalesce(jsonb_agg(g order by ord), '[]'::jsonb)
      from (
        select left(g, 60) as g, ord
        from jsonb_array_elements_text(
          case when jsonb_typeof(v_data -> 'genres') = 'array' then v_data -> 'genres' else '[]'::jsonb end
        ) with ordinality as t(g, ord)
        where btrim(g) <> ''
        limit 12
      ) s
    ),
    'categories', (
      select coalesce(jsonb_agg(g order by ord), '[]'::jsonb)
      from (
        select left(g, 60) as g, ord
        from jsonb_array_elements_text(
          case when jsonb_typeof(v_data -> 'categories') = 'array' then v_data -> 'categories' else '[]'::jsonb end
        ) with ordinality as t(g, ord)
        where btrim(g) <> ''
        limit 12
      ) s
    ),
    'description', left(coalesce(v_data ->> 'description', ''), 2000),
    'pageCount', case when coalesce(v_data ->> 'pageCount', '') ~ '^[0-9]+$'
                      then least((v_data ->> 'pageCount')::int, 100000) else 0 end,
    'publishedDate', case when coalesce(v_data ->> 'publishedDate', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                          then left(v_data ->> 'publishedDate', 10) else '' end
  );

  -- Silent outcomes (all plain 'ok'): dismissal tombstone (1 year),
  -- duplicate still sitting in the inbox, already on the
  -- recipient's shelves.
  if exists (
    select 1 from public.toy_dismissals d
    where d.sender_id = v_uid and d.recipient_id = p_recipient and d.book_key = v_key
      and d.created_at > now() - interval '1 year'
  ) then return 'ok'; end if;
  if exists (
    select 1 from public.thought_of_you t
    where t.sender_id = v_uid and t.recipient_id = p_recipient and t.book_key = v_key
  ) then return 'ok'; end if;
  if exists (
    select 1 from public.books rb
    where rb.user_id = p_recipient
      and public.toy_book_key(
            case when length(upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                 then upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))
                 else '' end,
            rb.data ->> 'title',
            case when jsonb_typeof(rb.data -> 'authors') = 'array' then rb.data -> 'authors' ->> 0
                 when jsonb_typeof(rb.data -> 'authors') = 'string' then rb.data ->> 'authors'
                 else '' end
          ) = v_key
  ) then return 'ok'; end if;

  insert into public.thought_of_you (sender_id, recipient_id, sender_book_id, book_key, book, note)
  values (v_uid, p_recipient, p_book_id, v_key, v_snap, btrim(coalesce(p_note, '')))
  on conflict (sender_id, recipient_id, book_key) do nothing;
  v_inserted := found;
  if not v_inserted then return 'ok'; end if;
  insert into public.toy_send_log (sender_id, recipient_id) values (v_uid, p_recipient);

  -- Opportunistic prune (bounded, indexed): the log keeps 2 days,
  -- tombstones a year, expired inbox rows are reaped here since
  -- read-time expiry alone would leave them forever.
  delete from public.toy_send_log where created_at < now() - interval '2 days';
  delete from public.toy_dismissals where created_at < now() - interval '1 year';
  delete from public.thought_of_you where created_at < now() - interval '60 days';
  return 'ok';
end;
$$;
revoke all on function public.send_thought_of_you(uuid, text, text) from public;
grant execute on function public.send_thought_of_you(uuid, text, text) to authenticated;

-- Dismiss: the recipient says no — tombstone first, then delete.
-- Always 'ok': an already-gone card is the same answer.
create or replace function public.dismiss_thought_of_you(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sender uuid;
  v_key text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select sender_id, book_key into v_sender, v_key
    from public.thought_of_you
   where id = p_id and recipient_id = v_uid;
  if not found then return 'ok'; end if;
  insert into public.toy_dismissals (sender_id, recipient_id, book_key)
  values (v_sender, v_uid, v_key)
  on conflict (sender_id, recipient_id, book_key)
  do update set created_at = now();
  delete from public.thought_of_you where id = p_id and recipient_id = v_uid;
  return 'ok';
end;
$$;
revoke all on function public.dismiss_thought_of_you(uuid) from public;
grant execute on function public.dismiss_thought_of_you(uuid) to authenticated;

-- Recall: a mis-sent book can be taken back. Always 'ok', whether
-- or not a row existed — the answer must not become the receipt
-- the sender-delete policy would have been.
create or replace function public.recall_thought_of_you(p_recipient uuid, p_book_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from public.thought_of_you
   where sender_id = auth.uid()
     and recipient_id = p_recipient
     and sender_book_id = p_book_id;
  return 'ok';
end;
$$;
revoke all on function public.recall_thought_of_you(uuid, text) from public;
grant execute on function public.recall_thought_of_you(uuid, text) to authenticated;

-- Unfriend cleanup (the v525 pattern): when a circle link is
-- deleted and no accepted link remains between the pair, their
-- recommendations die in both directions. Block inserts sever
-- links (v526), which fires this — a blocked pair's pending cards
-- are removed by the same machinery.
create or replace function public.thought_of_you_unfriend()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.circle_links cl
    where cl.status = 'accepted'
      and ((cl.requester_id = old.requester_id and cl.addressee_id = old.addressee_id)
        or (cl.requester_id = old.addressee_id and cl.addressee_id = old.requester_id))
  ) then
    delete from public.thought_of_you
    where (sender_id = old.requester_id and recipient_id = old.addressee_id)
       or (sender_id = old.addressee_id and recipient_id = old.requester_id);
  end if;
  return old;
end;
$$;
drop trigger if exists thought_of_you_unfriend_cleanup on public.circle_links;
create trigger thought_of_you_unfriend_cleanup
  after delete on public.circle_links
  for each row execute function public.thought_of_you_unfriend();

-- #190 fix: re-redeeming an existing friend's invite must not
-- delete + re-insert the pair's link — the delete fires the
-- cleanup triggers above (and v525's) while the friendship is
-- alive. The early return goes AFTER the block check and the
-- own-invite check, and clears stale non-accepted rows (their
-- deletion cannot fire cleanup: the accepted link stands).
create or replace function public.accept_circle_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_them uuid;
begin
  if v_me is null then
    raise exception 'not signed in';
  end if;
  select user_id into v_them from circle_invites where code = p_token;
  if v_them is null then
    raise exception 'invite not found';
  end if;
  if exists (
    select 1 from public.blocks b
     where (b.blocker_id = v_me and b.blocked_id = v_them)
        or (b.blocker_id = v_them and b.blocked_id = v_me)
  ) then
    raise exception 'invite not found';
  end if;
  if v_them = v_me then
    raise exception 'own invite';
  end if;
  -- v527: already friends — the invite is honoured by the link that
  -- stands. Return without touching it.
  if exists (
    select 1 from circle_links
     where status = 'accepted'
       and ((requester_id = v_me and addressee_id = v_them)
         or (requester_id = v_them and addressee_id = v_me))
  ) then
    delete from circle_links
     where status <> 'accepted'
       and ((requester_id = v_me and addressee_id = v_them)
         or (requester_id = v_them and addressee_id = v_me));
    return v_them;
  end if;
  delete from circle_links
   where (requester_id = v_me and addressee_id = v_them)
      or (requester_id = v_them and addressee_id = v_me);
  insert into circle_links (requester_id, addressee_id, status)
  values (v_me, v_them, 'accepted');
  return v_them;
end;
$$;
revoke all on function public.accept_circle_invite(text) from public;
grant execute on function public.accept_circle_invite(text) to authenticated;
