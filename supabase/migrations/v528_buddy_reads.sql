-- v528 — Social build #3: real buddy reads.
--
-- Today the Buddy tab only shows shared-TBR coincidence ("you both
-- want this — pick one and read it together") with no way to act on
-- it. This migration makes buddy reads real: invite → read together
-- → finish together, as a durable object between two circle friends.
--
-- The design went through a red-team round that killed the first
-- draft; what follows is the amended shape, and the claims it does
-- and does not make:
--
-- - KEY-ONLY ROWS. A buddy_reads row is (inviter, invitee, book_key,
--   status, created_at) and nothing else. There is NO book snapshot:
--   an invite can only land for a book BOTH parties already own (see
--   the gate below), so each client renders title/cover from its OWN
--   library copy. A snapshot would also be spoofable — book data is
--   client-written free text, an ISBN key doesn't bind title or
--   authors, and the card would impersonate the recipient's own
--   known book. Nothing to spoof when nothing is stored.
--
-- - PRESENCE IS A GRANT, NOT A LEAK, AND IT IS SERVED AS AN ENUM.
--   The buddy read carries its own consent: inviting grants your
--   state for this book to this partner; accepting grants theirs.
--   State is never stored and never derived from anyone's shelf
--   pipeline — buddy_states() computes it at read time from each
--   side's own book rows and returns ONLY the enum (not_started /
--   reading / finished / set_aside / null). No page counts, no
--   percentages, no dates, no logs ever cross: the RPC traffic for
--   this feature is a key plus an enum, by construction. The global
--   activity opt-in (share_activity) governs the AMBIENT surfaces
--   (digest, moments) and is deliberately NOT the gate here — it
--   defaults off for everyone, so gating buddy state on it would
--   make an accepted buddy read show nothing, forever; and deriving
--   state from the shelf-browsing path instead would silently
--   override that opt-out. The accept is the later, specific,
--   per-book act, and the invite card says what it grants before
--   the invitee decides. Ending the read revokes the grant at once
--   (the state RPC requires an active row). Stated honestly: a
--   partner who looks over time can notice WHEN your state changed
--   — that is inherent to any presence system; the feature ships
--   and stores no pace data, and renders no dates.
--
-- - THE INVITER HAS NO READ ON PENDINGS (the v527 lesson). A
--   pending invite is a one-way push until the invitee acts, so it
--   gets the full v527 treatment: the SELECT policy lets the
--   inviter read only ACTIVE rows; pendings are visible solely to
--   their recipient. The inviter's feedback is the appearance of an
--   active read — fire-and-forget, exactly like a Thought-of-you
--   card. Decline-by-deletion is therefore genuinely quiet (there is
--   no inviter surface where a row could be watched vanishing), a
--   decline tombstones the (pair, book) for a year in machinery no
--   one can read, pendings expire at 60 days, sends are capped
--   (5/pair/day, 20/sender/day, exact under an advisory lock, the
--   sender's own slow_down the one distinct outcome), and the
--   recipient has an opt-out (profiles.receive_buddy_invites,
--   default true, deliberately NOT projected — the same called-out
--   decision as receive_recos in v527). Invite cards carry
--   Report/Block like Thought-of-you cards do.
--
-- - THE INVITE GATE IS ANTI-ORACLE. buddy_invite() lands a row only
--   when the invitee owns a copy whose key matches AND whose shelf
--   the inviter may already browse (circle_book_visible with the
--   MATCHED COPY's status — status-granular visibility composed
--   with the copy's existence, so the pair together prove this
--   specific book was already visible to the inviter). Every other
--   outcome — no copy, hidden shelf, opted out, tombstoned,
--   duplicate — is the same silent 'ok' with no row created, and
--   with no inviter read on pendings there is no channel that
--   resolves them. The one soft edge, stated plainly: an invitee
--   whose copy is visible learns nothing about the inviter they
--   didn't choose by accepting the friendship.
--
-- - ENTITLEMENT IS RE-VALIDATED AT EVERY WRITE AND AT STATE READ
--   (the v525/v527 pattern): friendship and blocks are re-checked
--   inside invite, respond and states; respond additionally
--   re-checks that the invitee still owns the book. All three
--   mutating RPCs take the same unordered-pair advisory lock, and
--   respond acts only on a row still 'pending' under a FOR UPDATE
--   read — a stale decline cannot delete an accepted read, and an
--   accept on a vanished row is a no-op, never a resurrection.
--   Inviting someone who already has a pending invite to YOU for
--   the same book activates it (mutual intent within the pending's
--   60-day life).
--
-- - UNFRIEND CLEANUP mirrors v525/v527: when a circle link is
--   deleted and no accepted link remains, the pair's buddy rows die
--   in both directions. A block severs links (v526), which fires
--   this — a blocked pair's buddy reads end through the same
--   machinery. Read-time defence in depth (the v527 pattern): the
--   SELECT policy re-requires an accepted link right now, so a row
--   that somehow outlives its friendship is unreadable anyway.
--
-- - IDENTITY IS THE APP'S EXISTING KEY (toy_book_key, v527): ISBN
--   when a valid one exists, else normalized title + first author.
--   The known bounds come with it: different editions (different
--   ISBNs) are different keys — the same is true of every social
--   surface in this app (buddy matches, recommendations) — and the
--   title+author fallback can collide distinct works that share
--   both. State computation uses the same server-side key on both
--   sides, so the two clients can never disagree about the key.
--
-- - THE SHIELD (v524) STAYS A VIEWER-SIDE DISPLAY FILTER: the
--   server stores no title to protect and the state RPC returns an
--   enum, so there is nothing server-side to shield. The client
--   holds incoming invites for known-high-spice books whole (the
--   v527 card discipline; a held invite simply expires), blurs the
--   cover on active rows (the friend-grid discipline — the title
--   shown is the viewer's OWN copy of a book they accepted a buddy
--   read for), and never calls buddy_states() for a book its shield
--   filters. buddy_send_log and buddy_dismissals are machinery,
--   not surfaces: RLS on, every grant revoked, zero policies.

-- The recipient's off switch. Existing accounts default to
-- receiving (see header); never projected to friends.
alter table public.profiles
  add column if not exists receive_buddy_invites boolean not null default true;

create table if not exists public.buddy_reads (
  id uuid primary key default gen_random_uuid(),
  inviter_id uuid not null references auth.users (id) on delete cascade,
  invitee_id uuid not null references auth.users (id) on delete cascade,
  book_key text not null,
  status text not null default 'pending' check (status in ('pending', 'active')),
  created_at timestamptz not null default now(),
  unique (inviter_id, invitee_id, book_key),
  check (inviter_id <> invitee_id)
);
create index if not exists buddy_reads_invitee_idx
  on public.buddy_reads (invitee_id, status);
create index if not exists buddy_reads_inviter_idx
  on public.buddy_reads (inviter_id, status);

create table if not exists public.buddy_send_log (
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists buddy_send_log_sender_idx
  on public.buddy_send_log (sender_id, created_at);

create table if not exists public.buddy_dismissals (
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  book_key text not null,
  created_at timestamptz not null default now(),
  primary key (sender_id, recipient_id, book_key)
);

alter table public.buddy_reads enable row level security;
alter table public.buddy_send_log enable row level security;
alter table public.buddy_dismissals enable row level security;

-- Machinery tables: nobody reads or writes them directly, ever.
revoke all on public.buddy_send_log from public, anon, authenticated;
revoke all on public.buddy_dismissals from public, anon, authenticated;

-- Read surface. The recipient reads rows addressed to them
-- (pendings + actives); the inviter reads only ACTIVE rows — a
-- pending is fire-and-forget, so no inviter query can enumerate,
-- count, or watch their outgoing invitations. Both halves
-- re-require the friendship right now, the recipient-placed block
-- check a policy can honestly see (the v526 trap: policy subqueries
-- read blocks under the caller's RLS; the other direction is
-- covered by the sever + cleanup trigger), and pending expiry.
drop policy if exists "pair reads buddy reads" on public.buddy_reads;
create policy "pair reads buddy reads" on public.buddy_reads
  for select
  using (
    (auth.uid() = invitee_id or (auth.uid() = inviter_id and status = 'active'))
    and (status = 'active' or created_at > now() - interval '60 days')
    and exists (
      select 1 from public.circle_links cl
      where cl.status = 'accepted'
        and ((cl.requester_id = inviter_id and cl.addressee_id = invitee_id)
          or (cl.requester_id = invitee_id and cl.addressee_id = inviter_id))
    )
    and not exists (
      select 1 from public.blocks b
      where b.blocker_id = auth.uid()
        and b.blocked_id = (case when auth.uid() = inviter_id then invitee_id else inviter_id end)
    )
  );

-- (Deliberately NO insert/update/delete policies: buddy_invite(),
-- buddy_respond() and buddy_end() are the only write doors.)

-- One side's reading state for one book key, as the bare enum.
-- Status only — a copy's CURRENT shelf fact. (The digest elsewhere
-- counts status='read' OR a finish date as finished; presence uses
-- the status alone, so a re-read in progress reads 'reading', not
-- 'finished'.) Precedence across duplicate copies: a finished copy
-- outranks a reading one, which outranks a waiting one, which
-- outranks a set-aside one. No copy with the key → null.
-- Private machinery: revoked from everyone; only the SECURITY
-- DEFINER buddy_states() below (running as owner) calls it.
create or replace function public.buddy_reading_state(p_user uuid, p_key text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'read'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'finished'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'reading'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'reading'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'tbr'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'not_started'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'dnf'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'set_aside'
    else null
  end;
$$;
revoke all on function public.buddy_reading_state(uuid, text) from public;

-- The presence read. Either party to an ACTIVE buddy read may ask;
-- the answer is recomputed from both sides' own book rows at call
-- time, so both clients render the same shared truth, and ending
-- the read (or the friendship) stops the answers immediately.
-- Anything else — not a party, not active, no longer friends,
-- blocked — answers with both states null: there is no error shape
-- to probe with, and null is also the honest answer for "no state".
create or replace function public.buddy_states(p_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_r record;
  v_other uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select inviter_id, invitee_id, book_key, status into v_r
    from public.buddy_reads
   where id = p_id and (inviter_id = v_uid or invitee_id = v_uid);
  if not found or v_r.status <> 'active' then
    return jsonb_build_object('mine', null, 'theirs', null);
  end if;
  v_other := case when v_r.inviter_id = v_uid then v_r.invitee_id else v_r.inviter_id end;
  if not exists (
    select 1 from public.circle_links cl
    where cl.status = 'accepted'
      and ((cl.requester_id = v_uid and cl.addressee_id = v_other)
        or (cl.addressee_id = v_uid and cl.requester_id = v_other))
  ) or exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_other)
       or (b.blocker_id = v_other and b.blocked_id = v_uid)
  ) then
    return jsonb_build_object('mine', null, 'theirs', null);
  end if;
  return jsonb_build_object(
    'mine', public.buddy_reading_state(v_uid, v_r.book_key),
    'theirs', public.buddy_reading_state(v_other, v_r.book_key)
  );
end;
$$;
revoke all on function public.buddy_states(uuid) from public;
grant execute on function public.buddy_states(uuid) to authenticated;

-- The only invite path. The client names its own book by id and a
-- friend; the server computes the key and validates the whole
-- claim in a pinned order (see header). Answers: 'ok' for a landed
-- invite AND for every refusal the inviter must not be able to
-- distinguish; 'slow_down' only for the sender's own caps.
create or replace function public.buddy_invite(p_friend uuid, p_book_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_data jsonb;
  v_isbn text;
  v_key text;
  v_recv boolean;
  v_ex record;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  -- One pair's writes are serialised, so the caps and the
  -- existing-row checks below are exact rather than racy.
  perform pg_advisory_xact_lock(hashtextextended(
    'buddy:' || least(v_uid, p_friend)::text || ':' || greatest(v_uid, p_friend)::text, 0));
  -- The book must be the inviter's own (the server owns the key).
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  v_data := coalesce(v_row.data, '{}'::jsonb);
  if btrim(coalesce(v_data ->> 'title', '')) = '' then raise exception 'no such book'; end if;
  -- Friendship, with blocks folded into the same generic refusal
  -- (v526/v527: a blocked pair is indistinguishable from an
  -- unlinked one).
  if p_friend = v_uid
     or not exists (
       select 1 from public.circle_links cl
       where cl.status = 'accepted'
         and ((cl.requester_id = v_uid and cl.addressee_id = p_friend)
           or (cl.addressee_id = v_uid and cl.requester_id = p_friend))
     )
     or exists (
       select 1 from public.blocks b
       where (b.blocker_id = v_uid and b.blocked_id = p_friend)
          or (b.blocker_id = p_friend and b.blocked_id = v_uid)
     )
  then raise exception 'not circle friends'; end if;
  -- Recipient posture, read only after the friendship gate: a
  -- missing profile row is treated as opted out (silent), so this
  -- function is not a user-existence oracle.
  select p.receive_buddy_invites into v_recv from public.profiles p where p.user_id = p_friend;
  if not found or v_recv is distinct from true then return 'ok'; end if;

  v_isbn := upper(regexp_replace(coalesce(nullif(v_data ->> 'isbn', ''), v_row.isbn, ''), '[^0-9Xx]', '', 'g'));
  if length(v_isbn) not in (10, 13) then v_isbn := ''; end if;
  v_key := public.toy_book_key(
    v_isbn,
    v_data ->> 'title',
    case when jsonb_typeof(v_data -> 'authors') = 'array' then v_data -> 'authors' ->> 0
         when jsonb_typeof(v_data -> 'authors') = 'string' then v_data ->> 'authors'
         else '' end
  );

  -- The inviter's own caps: the one distinct outcome, checked
  -- BEFORE the silent outcomes, deliberately (the v527 order) — an
  -- over-cap inviter hears 'slow_down' uniformly, whether or not
  -- this particular invite would have landed.
  if (select count(*) from public.buddy_send_log l
       where l.sender_id = v_uid and l.recipient_id = p_friend
         and l.created_at >= date_trunc('day', now())) >= 5
     or (select count(*) from public.buddy_send_log l
       where l.sender_id = v_uid
         and l.created_at >= date_trunc('day', now())) >= 20
  then return 'slow_down'; end if;

  -- Silent outcomes (all plain 'ok'): a decline tombstone within
  -- the year; a row that already stands between this pair for this
  -- book (an active read, or my own pending); their pending invite
  -- to me for the same book, which my invite accepts (mutual
  -- intent); and the anti-oracle gate — no copy of the invitee's
  -- with this key on a shelf I may already browse.
  if exists (
    select 1 from public.buddy_dismissals d
    where d.sender_id = v_uid and d.recipient_id = p_friend and d.book_key = v_key
      and d.created_at > now() - interval '1 year'
  ) then return 'ok'; end if;
  select id, status, inviter_id into v_ex
    from public.buddy_reads
   where book_key = v_key
     and ((inviter_id = v_uid and invitee_id = p_friend)
       or (inviter_id = p_friend and invitee_id = v_uid))
   order by (status = 'active') desc
   limit 1;
  if found then
    if v_ex.status = 'active' or v_ex.inviter_id = v_uid then return 'ok'; end if;
    update public.buddy_reads set status = 'active' where id = v_ex.id;
    return 'ok';
  end if;
  if not exists (
    select 1 from public.books rb
    where rb.user_id = p_friend
      and public.toy_book_key(
            case when length(upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                 then upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))
                 else '' end,
            rb.data ->> 'title',
            case when jsonb_typeof(rb.data -> 'authors') = 'array' then rb.data -> 'authors' ->> 0
                 when jsonb_typeof(rb.data -> 'authors') = 'string' then rb.data ->> 'authors'
                 else '' end
          ) = v_key
      and public.circle_book_visible(p_friend, rb.data ->> 'status')
  ) then return 'ok'; end if;

  insert into public.buddy_reads (inviter_id, invitee_id, book_key)
  values (v_uid, p_friend, v_key)
  on conflict (inviter_id, invitee_id, book_key) do nothing;
  if not found then return 'ok'; end if;
  insert into public.buddy_send_log (sender_id, recipient_id) values (v_uid, p_friend);

  -- Opportunistic prune (bounded, indexed): the log keeps 2 days,
  -- tombstones a year, stale pendings fall away (actives end only
  -- by an explicit end or the friendship ending).
  delete from public.buddy_send_log where created_at < now() - interval '2 days';
  delete from public.buddy_dismissals where created_at < now() - interval '1 year';
  delete from public.buddy_reads where status = 'pending' and created_at < now() - interval '60 days';
  return 'ok';
end;
$$;
revoke all on function public.buddy_invite(uuid, text) from public;
grant execute on function public.buddy_invite(uuid, text) to authenticated;

-- Accept or decline a pending invite. Decline is final and quiet:
-- the row dies and a machinery tombstone remembers the answer for
-- a year; the inviter has no surface where either fact is visible.
-- Accept re-validates the founding facts that can have changed
-- (friendship, blocks, the invitee still owning the book).
create or replace function public.buddy_respond(p_id uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid;
  v_b uuid;
  v_r record;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select inviter_id, invitee_id into v_a, v_b from public.buddy_reads where id = p_id;
  if not found then return 'ok'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'buddy:' || least(v_a, v_b)::text || ':' || greatest(v_a, v_b)::text, 0));
  -- Re-read under the lock: a stale decline must not be able to
  -- delete a read that was accepted meanwhile, and an accept on a
  -- row that is gone is a no-op, never a resurrection.
  select id, inviter_id, invitee_id, book_key, status into v_r
    from public.buddy_reads
   where id = p_id
   for update;
  if not found then return 'ok'; end if;
  if v_r.invitee_id <> v_uid or v_r.status <> 'pending' then return 'ok'; end if;
  -- The pair fell apart since the invite (unfriended or blocked —
  -- the cleanup should already have taken the row; if it somehow
  -- stands, it dies here, with no tombstone: the answer belongs to
  -- a friendship that no longer exists).
  if not exists (
    select 1 from public.circle_links cl
    where cl.status = 'accepted'
      and ((cl.requester_id = v_r.inviter_id and cl.addressee_id = v_uid)
        or (cl.addressee_id = v_r.inviter_id and cl.requester_id = v_uid))
  ) or exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_r.inviter_id)
       or (b.blocker_id = v_r.inviter_id and b.blocked_id = v_uid)
  ) then
    delete from public.buddy_reads where id = p_id;
    return 'ok';
  end if;
  if not coalesce(p_accept, false) then
    insert into public.buddy_dismissals (sender_id, recipient_id, book_key)
    values (v_r.inviter_id, v_uid, v_r.book_key)
    on conflict (sender_id, recipient_id, book_key)
    do update set created_at = now();
    delete from public.buddy_reads where id = p_id;
    return 'ok';
  end if;
  -- Accept: the invitee must still own a copy with this key (any
  -- status — it is their current shelf fact, checked directly; the
  -- inviter's copy is not re-gated: their state simply reads null
  -- in buddy_states() if they have since removed it).
  if not exists (
    select 1 from public.books rb
    where rb.user_id = v_uid
      and public.toy_book_key(
            case when length(upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                 then upper(regexp_replace(coalesce(nullif(rb.data ->> 'isbn', ''), rb.isbn, ''), '[^0-9Xx]', '', 'g'))
                 else '' end,
            rb.data ->> 'title',
            case when jsonb_typeof(rb.data -> 'authors') = 'array' then rb.data -> 'authors' ->> 0
                 when jsonb_typeof(rb.data -> 'authors') = 'string' then rb.data ->> 'authors'
                 else '' end
          ) = v_r.book_key
  ) then
    delete from public.buddy_reads where id = p_id;
    return 'ok';
  end if;
  update public.buddy_reads set status = 'active' where id = p_id;
  return 'ok';
end;
$$;
revoke all on function public.buddy_respond(uuid, boolean) from public;
grant execute on function public.buddy_respond(uuid, boolean) to authenticated;

-- End a buddy read (or withdraw a pending invite) — either party,
-- any time, silently. Always 'ok': whether a row existed is the
-- caller's own business only.
create or replace function public.buddy_end(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_a uuid;
  v_b uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select inviter_id, invitee_id into v_a, v_b from public.buddy_reads where id = p_id;
  if not found then return 'ok'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'buddy:' || least(v_a, v_b)::text || ':' || greatest(v_a, v_b)::text, 0));
  delete from public.buddy_reads
   where id = p_id and (inviter_id = v_uid or invitee_id = v_uid);
  return 'ok';
end;
$$;
revoke all on function public.buddy_end(uuid) from public;
grant execute on function public.buddy_end(uuid) to authenticated;

-- Unfriend cleanup (the v525/v527 pattern): when a circle link is
-- deleted and no accepted link remains between the pair, their
-- buddy reads die in both directions, whatever their status. Block
-- inserts sever links (v526), which fires this — a blocked pair's
-- buddy reads are removed by the same machinery.
create or replace function public.buddy_reads_unfriend()
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
    delete from public.buddy_reads
    where (inviter_id = old.requester_id and invitee_id = old.addressee_id)
       or (inviter_id = old.addressee_id and invitee_id = old.requester_id);
  end if;
  return old;
end;
$$;
drop trigger if exists buddy_reads_unfriend_cleanup on public.circle_links;
create trigger buddy_reads_unfriend_cleanup
  after delete on public.circle_links
  for each row execute function public.buddy_reads_unfriend();
