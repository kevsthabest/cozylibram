-- v550 — Handles: a unique, findable profile handle (the User's design,
-- hardened by a doubt round before build).
--
-- The problem: friend surfaces display a reader's real first name, and
-- some readers would rather not be known by it. A handle is the chosen
-- public identity: when one is set, friend-facing surfaces show
-- @handle INSTEAD of the first name. A handle is also FINDABLE — any
-- signed-in reader who knows the exact handle can look its owner up
-- and ask to connect — but only when the owner has separately opted
-- in to being findable. The design invariants, all enforced here in
-- the database (never merely in the client):
--
--   * PENDING, NEVER INSTANT. accept_circle_invite creates a link
--     immediately because the invite TOKEN is the inviter's consent
--     artifact. A handle embodies no consent, so request_by_handle
--     creates a 'pending' circle_links row — the existing inbox shape
--     — and the recipient answers it through the existing flow.
--   * NO ORACLES. lookup_handle returns a minimal shape (handle,
--     avatar, and bio/fav_genres behind the same share_bio CASE gate
--     as the projection) and NEVER first_name / last_name. A miss, a
--     not-findable owner, a block in either direction, and a
--     rate-limited caller all return the identical empty result.
--     request_by_handle collapses every refusal (unknown, not
--     findable, blocked, already linked, duplicate pending, limited)
--     into one indistinguishable failure.
--   * FINDABLE IS A SEPARATE OPT-IN, DEFAULT OFF. Setting a handle is
--     a display choice; findable is the public act. The flag defaults
--     false for everyone, which also keeps the design consistent with
--     the ratified teen posture (discoverability default OFF) without
--     the server ever consulting an age band (v524: a band must not
--     be inferable from server behaviour — no RPC here reads one).
--   * RELEASES QUARANTINE. A released handle (cleared or renamed
--     away from) is tombstoned in handle_history for 90 days: nobody
--     else may claim it; the previous owner may reclaim it at any
--     time. Renames carry a 30-day cooldown (profiles.handle_changed_
--     at stamps every claim/change/clear; reclaiming your own
--     quarantined handle is exempt — it is the same identity
--     returning, not churn). Friends see "formerly @…" from
--     friend_formerly while the quarantine runs.
--   * LOOKUPS ARE RATE-LIMITED in the RPC itself: 30 per caller per
--     rolling hour, counted in handle_lookups; request_by_handle
--     spends from the same budget. The cap is a few dozen an hour —
--     enough for any human adding friends by hand, useless for
--     dictionary-probing the namespace.
--   * THE CLAIM RPC OWNS THE HANDLE. claim_handle / clear_handle are
--     the only write paths: a guard trigger rejects any direct
--     INSERT/UPDATE that changes profiles.handle (or its change
--     stamp) without the transaction-local flag the RPCs set, so the
--     screen, quarantine and cooldown hold against hand-built
--     PostgREST calls too. The client's profile sync NEVER writes
--     the handle column (findable, a plain posture flag, rides the
--     normal sync ladder like share_bio before it).
--   * CONTENT SCREEN. One canonical core list — slurs + reserved
--     (brand/app/staff) terms — lives in handle_screen_slurs() /
--     handle_screen_reserved() below and is mirrored token-for-token
--     in js/237-handles.js (a test asserts the two copies agree).
--     Matching always runs on a leetspeak-normalized copy (0→o, 1→i,
--     3→e, 4→a, 5→s, 7→t, 8→b, @→a, $→s, !→i, +→t), so '4dm1n' and
--     'n1gger' hit the same terms as their plain spellings.
--     Posture by field, deliberately asymmetric:
--       - handles (chosen identifiers): STRICT — a slur anywhere as
--         a substring screens the handle; a reserved term screens it
--         as a whole '_'-delimited token (so 'admin_x' and 'x_admin'
--         are out, while 'modern_reader' survives 'mod').
--       - first/last name (a person's actual name): TOKEN equality
--         only — a name is screened only when a whole token IS a
--         listed term. Names merely CONTAINING a flagged substring
--         are never blocked (the Scunthorpe rule).
--       - bio (free prose): TOKEN equality against the slur list
--         only; reserved/staff words are ordinary vocabulary in a
--         sentence and are not screened there.
--     The list is deliberately narrow — unambiguous abuse and
--     impersonation terms. Two well-known slurs are EXCLUDED on
--     purpose: one is a substring of "spice/spicy", this app's core
--     vocabulary, and one of "raccoon/tycoon"; screening them would
--     block ordinary readers while adding little (report + block
--     remain the backstop, as everywhere). The name/bio trigger
--     screens only fields whose value CHANGES, so a legacy profile
--     is never locked out of unrelated syncs by a list that grew
--     after they arrived.

alter table public.profiles
  add column if not exists handle text;
alter table public.profiles
  add column if not exists findable boolean not null default false;
alter table public.profiles
  add column if not exists handle_changed_at timestamptz;

-- Format is a hard constraint, not a convention: lowercase a-z, 0-9
-- and underscore, 3–20 chars (the charset admits no Unicode
-- confusables, so homoglyph impersonation is dead by construction).
do $$
begin
  alter table public.profiles
    add constraint profiles_handle_format
    check (handle is null or handle ~ '^[a-z0-9_]{3,20}$');
exception when duplicate_object then null;
end $$;

-- Uniqueness is case-insensitive by construction (handles store
-- lowercase — the format check admits nothing else — and the index
-- lower()s regardless, so the invariant holds even if a future write
-- path forgets to normalize).
create unique index if not exists profiles_handle_unique
  on public.profiles (lower(handle))
  where handle is not null;

-- Tombstones: one row per release (clear or rename-away). RPC/definer
-- access only — RLS is on and there are deliberately NO policies, so
-- no client query can enumerate who used to hold what.
create table if not exists public.handle_history (
  handle text not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  released_at timestamptz not null default now()
);
create index if not exists handle_history_handle_idx
  on public.handle_history (handle, released_at desc);
create index if not exists handle_history_owner_idx
  on public.handle_history (owner_id, released_at desc);
alter table public.handle_history enable row level security;

-- Lookup budget: one row per lookup/request attempt. Same posture —
-- RLS on, no policies; only the definer RPCs touch it. Rows are
-- pruned to the rolling window by the RPCs themselves.
create table if not exists public.handle_lookups (
  caller_id uuid not null references auth.users (id) on delete cascade,
  looked_at timestamptz not null default now()
);
create index if not exists handle_lookups_caller_idx
  on public.handle_lookups (caller_id, looked_at desc);
alter table public.handle_lookups enable row level security;

-- ---------- the screen: one canonical list, two halves ----------
-- Mirrored token-for-token in js/237-handles.js (HANDLE_SCREEN_SLURS /
-- HANDLE_SCREEN_RESERVED); the handles test suite asserts agreement.
create or replace function public.handle_screen_slurs()
returns text[]
language sql
immutable
security definer
set search_path = public
as $$
  select array[
    'arsehole', 'asshole', 'bastard', 'beaner', 'bitch', 'chink',
    'cunt', 'faggot', 'fuck', 'gook', 'jigaboo', 'kike', 'nigger',
    'nigga', 'pedophile', 'porchmonkey', 'raghead', 'rapist',
    'retard', 'shit', 'slut', 'tranny', 'wetback', 'whore'
  ]::text[];
$$;
revoke all on function public.handle_screen_slurs() from public;

create or replace function public.handle_screen_reserved()
returns text[]
language sql
immutable
security definer
set search_path = public
as $$
  select array[
    'admin', 'administrator', 'cozylibram', 'libram', 'luna', 'mod',
    'moderator', 'official', 'owner', 'root', 'staff', 'support',
    'system', 'team'
  ]::text[];
$$;
revoke all on function public.handle_screen_reserved() from public;

-- Leetspeak + case normalization shared by every screen check.
create or replace function public.handle_normalize(p_text text)
returns text
language sql
immutable
security definer
set search_path = public
as $$
  select translate(lower(coalesce(p_text, '')), '0134578@$!+', 'oieastbasit');
$$;
revoke all on function public.handle_normalize(text) from public;

-- handle_screen_hit(text, mode) → the listed term hit, or null.
-- Modes: 'handle' (slur substring + reserved '_'-token), 'name'
-- (slur whole-token + reserved whole-token), 'bio' (slur whole-token
-- only). Checks run against both the leet-normalized text and the
-- plain lowercase text, so neither spelling lane escapes.
create or replace function public.handle_screen_hit(p_text text, p_mode text)
returns text
language plpgsql
immutable
security definer
set search_path = public
as $$
declare
  v_raw text := lower(coalesce(p_text, ''));
  v_norm text := public.handle_normalize(p_text);
  v_term text;
  v_tok text;
  v_tokens text[];
begin
  if p_mode = 'handle' then
    foreach v_term in array public.handle_screen_slurs() loop
      if strpos(v_norm, v_term) > 0 or strpos(v_raw, v_term) > 0 then
        return v_term;
      end if;
    end loop;
    -- Reserved: a whole '_'-delimited token. Digits are stripped per
    -- token on the raw lane ('admin1' → 'admin'); the normalized lane
    -- already decodes leet ('4dm1n' → 'admin').
    foreach v_term in array public.handle_screen_reserved() loop
      foreach v_tok in array regexp_split_to_array(v_norm, '_') loop
        if v_tok = v_term then return v_term; end if;
      end loop;
      foreach v_tok in array regexp_split_to_array(v_raw, '_') loop
        if regexp_replace(v_tok, '[0-9]+$', '') = v_term then return v_term; end if;
      end loop;
    end loop;
    return null;
  end if;
  -- 'name' and 'bio': whole-token equality on whitespace/punctuation
  -- splits — a flagged SUBSTRING inside a longer token never hits.
  v_tokens := regexp_split_to_array(v_norm, '[^a-z0-9]+')
           || regexp_split_to_array(v_raw, '[^a-z0-9]+');
  foreach v_term in array public.handle_screen_slurs() loop
    if v_term = any (v_tokens) then return v_term; end if;
  end loop;
  if p_mode = 'name' then
    foreach v_term in array public.handle_screen_reserved() loop
      if v_term = any (v_tokens) then return v_term; end if;
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function public.handle_screen_hit(text, text) from public;

-- ---------- write-path guards ----------
-- The handle (and its change stamp) may only move via claim_handle /
-- clear_handle, which set a transaction-local flag first. A direct
-- PostgREST write that tries to change either is rejected, so the
-- screen / quarantine / cooldown cannot be bypassed by hand.
create or replace function public.profiles_handle_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('app.handle_claim', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.handle is not null then
      raise exception 'handles are set via claim_handle' using errcode = '42501';
    end if;
  else
    if new.handle is distinct from old.handle
       or new.handle_changed_at is distinct from old.handle_changed_at then
      raise exception 'handles are set via claim_handle' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_handle_guard() from public;

drop trigger if exists profiles_handle_guard on public.profiles;
create trigger profiles_handle_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_handle_guard();

-- Name/bio screen: fires on INSERT and on any UPDATE that CHANGES a
-- screened field (an unchanged legacy value re-syncing is not a new
-- act of naming and is never blocked).
create or replace function public.profiles_content_screen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.first_name is distinct from old.first_name then
    if public.handle_screen_hit(new.first_name, 'name') is not null then
      raise exception 'profile content screened: first_name' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' or new.last_name is distinct from old.last_name then
    if public.handle_screen_hit(new.last_name, 'name') is not null then
      raise exception 'profile content screened: last_name' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' or new.bio is distinct from old.bio then
    if public.handle_screen_hit(new.bio, 'bio') is not null then
      raise exception 'profile content screened: bio' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.profiles_content_screen() from public;

drop trigger if exists profiles_content_screen on public.profiles;
create trigger profiles_content_screen
  before insert or update on public.profiles
  for each row execute function public.profiles_content_screen();

-- ---------- claim / clear ----------
-- Typed results, never raw exceptions, so the client can message
-- honestly: { ok:true, handle } or { ok:false, error: 'invalid' |
-- 'screened' | 'reserved' | 'taken' | 'quarantined' | 'cooldown' |
-- 'not_signed_in', days_remaining? }.
create or replace function public.claim_handle(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_new text := lower(trim(coalesce(p_handle, '')));
  v_cur text;
  v_changed timestamptz;
  v_hit text;
  v_owner uuid;
  v_rel timestamptz;
  v_reclaim boolean := false;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;
  if v_new !~ '^[a-z0-9_]{3,20}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select handle, handle_changed_at into v_cur, v_changed
    from public.profiles where user_id = v_me;
  if v_cur is not null and v_cur = v_new then
    return jsonb_build_object('ok', true, 'handle', v_new, 'unchanged', true);
  end if;
  v_hit := public.handle_screen_hit(v_new, 'handle');
  if v_hit is not null then
    if v_hit = any (public.handle_screen_reserved()) then
      return jsonb_build_object('ok', false, 'error', 'reserved');
    end if;
    return jsonb_build_object('ok', false, 'error', 'screened');
  end if;
  select user_id into v_owner
    from public.profiles
   where lower(handle) = v_new and user_id <> v_me;
  if v_owner is not null then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end if;
  -- Quarantine: the latest release of this handle governs.
  select owner_id, released_at into v_owner, v_rel
    from public.handle_history
   where handle = v_new
   order by released_at desc
   limit 1;
  if v_rel is not null and v_rel > now() - interval '90 days' then
    if v_owner <> v_me then
      return jsonb_build_object('ok', false, 'error', 'quarantined');
    end if;
    v_reclaim := true; -- my own handle coming back: always allowed
  end if;
  -- Rename cooldown: 30 days between identity changes. Reclaiming
  -- your own quarantined handle is exempt.
  if not v_reclaim and v_changed is not null
     and v_changed > now() - interval '30 days' then
    return jsonb_build_object('ok', false, 'error', 'cooldown',
      'days_remaining',
      greatest(1, ceil(extract(epoch from
        (v_changed + interval '30 days' - now())) / 86400)::int));
  end if;
  perform set_config('app.handle_claim', 'on', true);
  begin
    if v_cur is not null then
      insert into public.handle_history (handle, owner_id) values (v_cur, v_me);
    end if;
    insert into public.profiles as pr (user_id, handle, handle_changed_at)
    values (v_me, v_new, now())
    on conflict (user_id) do update
      set handle = excluded.handle,
          handle_changed_at = excluded.handle_changed_at;
  exception when unique_violation then
    -- Lost a simultaneous claim race: the index held; say so plainly.
    return jsonb_build_object('ok', false, 'error', 'taken');
  end;
  return jsonb_build_object('ok', true, 'handle', v_new);
end;
$$;
revoke all on function public.claim_handle(text) from public;
grant execute on function public.claim_handle(text) to authenticated;

-- Clearing is always allowed (a privacy exit is never gated by the
-- cooldown); the released handle tombstones like any other release.
create or replace function public.clear_handle()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_cur text;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;
  select handle into v_cur from public.profiles where user_id = v_me;
  if v_cur is null then
    return jsonb_build_object('ok', true, 'cleared', false);
  end if;
  perform set_config('app.handle_claim', 'on', true);
  insert into public.handle_history (handle, owner_id) values (v_cur, v_me);
  update public.profiles
     set handle = null, handle_changed_at = now()
   where user_id = v_me;
  return jsonb_build_object('ok', true, 'cleared', true);
end;
$$;
revoke all on function public.clear_handle() from public;
grant execute on function public.clear_handle() to authenticated;

-- ---------- lookup / availability / request ----------
-- The shared budget spend: prune this caller's rows to the rolling
-- hour, record the attempt, and report whether the cap is blown.
-- Attempts count even when they return nothing — that's what makes
-- probing expensive.
create or replace function public.handle_lookup_budget()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent int;
begin
  delete from public.handle_lookups
   where caller_id = auth.uid()
     and looked_at <= now() - interval '1 hour';
  insert into public.handle_lookups (caller_id) values (auth.uid());
  select count(*) into v_recent
    from public.handle_lookups
   where caller_id = auth.uid()
     and looked_at > now() - interval '1 hour';
  return v_recent <= 30;
end;
$$;
revoke all on function public.handle_lookup_budget() from public;

-- Exact-match lookup. Minimal shape — handle, avatar, and the
-- share_bio-gated content, exactly the projection's gates. NEVER
-- first_name / last_name. No row for: unknown handle, findable off,
-- a block in either direction, the caller's own handle, a blown
-- budget, or a signed-out caller — all indistinguishable.
create or replace function public.lookup_handle(p_handle text)
returns table (
  handle text,
  avatar_id text,
  avatar_path text,
  bio text,
  fav_genres text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
begin
  if v_me is null then return; end if;
  if not public.handle_lookup_budget() then return; end if;
  return query
  select p.handle, p.avatar_id, p.avatar_path,
         case when p.share_bio then p.bio end,
         case when p.share_bio then p.fav_genres end
    from public.profiles p
   where lower(p.handle) = v_h
     and p.findable is true
     and p.user_id <> v_me
     and not exists (
       select 1 from public.blocks b
        where (b.blocker_id = v_me and b.blocked_id = p.user_id)
           or (b.blocker_id = p.user_id and b.blocked_id = v_me)
     );
end;
$$;
revoke all on function public.lookup_handle(text) from public;
grant execute on function public.lookup_handle(text) to authenticated;

-- Boolean only: claimable-by-me right now (format + screen + not
-- held + not quarantined-by-another). No owner information of any
-- kind rides along. My own current handle reports false (it is
-- taken — by me; the editor words that case itself).
create or replace function public.handle_available(p_handle text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_owner uuid;
  v_rel timestamptz;
begin
  if v_h !~ '^[a-z0-9_]{3,20}$' then return false; end if;
  if public.handle_screen_hit(v_h, 'handle') is not null then return false; end if;
  if exists (select 1 from public.profiles where lower(handle) = v_h) then
    return false;
  end if;
  select owner_id, released_at into v_owner, v_rel
    from public.handle_history
   where handle = v_h
   order by released_at desc
   limit 1;
  if v_rel is not null and v_rel > now() - interval '90 days'
     and (v_me is null or v_owner <> v_me) then
    return false;
  end if;
  return true;
end;
$$;
revoke all on function public.handle_available(text) from public;
grant execute on function public.handle_available(text) to authenticated;

-- Add by handle: creates a PENDING link (see the header — never an
-- instant friendship). Every refusal is the same { ok:false,
-- error:'unavailable' }: unknown, not findable, blocked either way,
-- already linked, duplicate pending, self, signed out, over budget.
create or replace function public.request_by_handle(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_them uuid;
  v_fail jsonb := jsonb_build_object('ok', false, 'error', 'unavailable');
begin
  if v_me is null then return v_fail; end if;
  if not public.handle_lookup_budget() then return v_fail; end if;
  select user_id into v_them
    from public.profiles
   where lower(handle) = v_h and findable is true;
  if v_them is null or v_them = v_me then return v_fail; end if;
  if exists (
    select 1 from public.blocks b
     where (b.blocker_id = v_me and b.blocked_id = v_them)
        or (b.blocker_id = v_them and b.blocked_id = v_me)
  ) then return v_fail; end if;
  if exists (
    select 1 from public.circle_links cl
     where ((cl.requester_id = v_me and cl.addressee_id = v_them)
         or (cl.requester_id = v_them and cl.addressee_id = v_me))
       and cl.status in ('accepted', 'pending')
  ) then return v_fail; end if;
  -- A declined row from an earlier round is replaced by the fresh
  -- request (minds change; the block is the abuse answer, as ever).
  delete from public.circle_links
   where ((requester_id = v_me and addressee_id = v_them)
       or (requester_id = v_them and addressee_id = v_me))
     and status = 'declined';
  insert into public.circle_links (requester_id, addressee_id, status)
  values (v_me, v_them, 'pending');
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.request_by_handle(text) from public;
grant execute on function public.request_by_handle(text) to authenticated;

-- Block from the lookup card: the card's shape carries no user_id
-- (by design), so the block resolves server-side under the same
-- gates as the lookup itself — an unresolvable handle fails with
-- the same indistinguishable shape. The insert fires the v526
-- sever trigger, exactly like the client-side block insert.
create or replace function public.block_by_handle(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_them uuid;
  v_fail jsonb := jsonb_build_object('ok', false, 'error', 'unavailable');
begin
  if v_me is null then return v_fail; end if;
  select user_id into v_them
    from public.profiles
   where lower(handle) = v_h and findable is true;
  if v_them is null or v_them = v_me then return v_fail; end if;
  insert into public.blocks (blocker_id, blocked_id)
  values (v_me, v_them)
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.block_by_handle(text) from public;
grant execute on function public.block_by_handle(text) to authenticated;

-- Report from the lookup card: same server-side resolution, same
-- reason vocabulary and table as the v246 client flow.
create or replace function public.report_by_handle(p_handle text, p_reason text, p_details text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_h text := lower(trim(coalesce(p_handle, '')));
  v_them uuid;
  v_fail jsonb := jsonb_build_object('ok', false, 'error', 'unavailable');
begin
  if v_me is null then return v_fail; end if;
  if p_reason not in ('spam', 'harassment', 'inappropriate', 'fake_account', 'other') then
    return v_fail;
  end if;
  select user_id into v_them
    from public.profiles
   where lower(handle) = v_h and findable is true;
  if v_them is null or v_them = v_me then return v_fail; end if;
  insert into public.user_reports (reporter_id, reported_user_id, reason, details)
  values (v_me, v_them, p_reason, left(coalesce(p_details, ''), 1000));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.report_by_handle(text, text, text) from public;
grant execute on function public.report_by_handle(text, text, text) to authenticated;

-- "Formerly @…": the friend's most recent released handle, while
-- its quarantine still runs. Linkage-gated (accepted circle members
-- only) and null for everything else — self, strangers, no history,
-- expired quarantine, or a handle they've since reclaimed (that one
-- is current, not former).
create or replace function public.friend_formerly(p_user uuid)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_h text;
begin
  if auth.uid() is null or auth.uid() = p_user then return null; end if;
  if not exists (
    select 1 from public.circle_links cl
     where cl.status = 'accepted'
       and ((cl.requester_id = auth.uid() and cl.addressee_id = p_user)
         or (cl.addressee_id = auth.uid() and cl.requester_id = p_user))
  ) then return null; end if;
  select h.handle into v_h
    from public.handle_history h
   where h.owner_id = p_user
     and h.released_at > now() - interval '90 days'
   order by h.released_at desc
   limit 1;
  if v_h is null then return null; end if;
  if exists (select 1 from public.profiles
              where user_id = p_user and handle = v_h) then
    return null;
  end if;
  return v_h;
end;
$$;
revoke all on function public.friend_formerly(uuid) from public;
grant execute on function public.friend_formerly(uuid) to authenticated;

-- ---------- the projection learns the handle ----------
-- v526's view, restated with exactly one additive column: p.handle,
-- appended last so the pinned projection order (QA shape-pin) moves
-- by the one named column. Every gate — the link/block WHERE, both
-- share_bio CASEs — is behaviour-identical to v526.
create or replace view public.circle_profiles as
  select p.user_id,
         p.first_name,
         p.last_name,
         p.avatar_id,
         p.avatar_path,
         p.share_library,
         p.share_bio,
         p.share_activity,
         case when p.share_bio then p.bio end as bio,
         case when p.share_bio then p.fav_genres end as fav_genres,
         p.handle
  from public.profiles p
  where p.user_id = auth.uid()
     or exists (
       select 1 from public.circle_links cl
       where cl.status in ('accepted', 'pending')
         and ((cl.requester_id = p.user_id and cl.addressee_id = auth.uid())
           or (cl.addressee_id = p.user_id and cl.requester_id = auth.uid()))
         and not exists (
           select 1 from public.blocks b
           where (b.blocker_id = p.user_id and b.blocked_id = auth.uid())
              or (b.blocker_id = auth.uid() and b.blocked_id = p.user_id)
         )
     );
revoke all on public.circle_profiles from anon;
grant select on public.circle_profiles to authenticated;

-- ---------- the inviter's name prefers their handle ----------
-- v532's function, one change: a token holder is a stranger the
-- inviter chose to reach, so the name they're entitled to learn is
-- the inviter's DISPLAY identity — @handle when one is set, else
-- the name as before. Block/own/dead-token behaviour is unchanged.
create or replace function public.invite_inviter_name(p_token text)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_them uuid;
  v_name text;
begin
  if auth.uid() is null then return null; end if;
  select user_id into v_them from public.circle_invites where code = p_token;
  if v_them is null or v_them = auth.uid() then return null; end if;
  if exists (
    select 1 from public.blocks b
     where (b.blocker_id = auth.uid() and b.blocked_id = v_them)
        or (b.blocker_id = v_them and b.blocked_id = auth.uid())
  ) then
    return null;
  end if;
  select coalesce(
           case when p.handle is not null and p.handle <> '' then '@' || p.handle end,
           nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''))
    into v_name
    from public.profiles p
   where p.user_id = v_them;
  return v_name;
end;
$$;
revoke all on function public.invite_inviter_name(text) from public;
grant execute on function public.invite_inviter_name(text) to authenticated;
