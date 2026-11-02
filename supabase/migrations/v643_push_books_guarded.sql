-- v643: server-side push guard for #335 (cloud push must never regress
-- a newer cloud record).
--
-- Decision of record (User, 2026-11-02): the guard lives on the
-- SERVER, not in the client. A client-side reconciliation shipped
-- first on the builder branch (fetch the cloud rows, drop the stale
-- ones, upsert the rest); the User reviewed both shapes and ruled
-- for the server-side guard instead: the compare-and-write must be
-- atomic (the client fetch-then-upsert leaves a race window between
-- the read and the write that no client discipline can close), and
-- the rule must hold for every writer, including clients too old to
-- reconcile for themselves.
--
-- What this file does: creates public.book_canonical_json(jsonb)
-- (the #129 tie-break canonical form, in SQL) and
-- public.push_books_guarded(jsonb) (the guarded batch push the
-- client calls instead of upserting public.books directly). No table
-- is created, altered, or touched; no data moves. The books table's
-- existing RLS ("own rows" FOR ALL, plus the circle read policy) is
-- unchanged — old clients keep their direct-upsert path until the
-- lockdown follow-up (revoking direct table writes) is ruled on;
-- this migration deliberately does NOT revoke anything on books.
--
-- Gate / rollout: Security Advisor review gates this file before
-- apply, and it applies post-merge under the marker discipline. The
-- pairing client (v643) tolerates the function not existing yet: it
-- detects the missing-function error and falls back to the plain
-- upsert WITH a warn-level AppLog line, so shipping the client first
-- and applying this migration after is safe — the fallback is the
-- exact behaviour every previously shipped client already has, and
-- the log line keeps the unguarded window visible instead of silent.
--
-- Re-runnable posture (v618/v636 idiom): create-or-replace for both
-- functions; the grants/revokes are idempotent.
--
-- Guard semantics (push_books_guarded), per row:
--   * The row's owner is auth.uid() — ALWAYS. The payload's user_id
--     is never read, and the stored-row lookup is scoped to the
--     caller, so a crafted payload cannot write, overwrite, or even
--     probe another account's library: naming someone else's book_id
--     just addresses the caller's own row of that id (or creates it).
--   * No stored row -> insert, outcome 'written'.
--   * Incoming _mtime strictly greater -> update, 'written'.
--   * Incoming _mtime strictly smaller -> the stored copy is newer;
--     writing would regress it (that is #335). Outcome
--     'rejected_stale'; the stored row is untouched. The pushing
--     device converges on its next pull, whose merge prefers the
--     newer _mtime it already holds in the cloud.
--   * Equal _mtime -> the #129 deterministic tie-break, mirrored
--     from the pull side (mergeCloudBooks / stableJson in
--     js/090-sync.js): the record whose canonical JSON (object keys
--     sorted recursively) is lexicographically GREATER wins.
--     Incoming greater -> update, 'written'. Canonically identical
--     -> the cloud already holds exactly this record, 'written'
--     (no write performed). Incoming smaller -> the stored record
--     wins the tie, outcome 'rejected_tiebreak', stored row
--     untouched; the pushing device adopts the stored record on its
--     next pull, where its own stableJson comparison reaches the
--     same winner. Rejecting the tie-loser is what makes the system
--     converge: writing it would leave the stored record's holder
--     permanently diverged (it never re-pushes an unedited book).
--   * Malformed rows (missing/empty book_id, non-object data) are
--     never written; outcome 'rejected_invalid'.
--   * _mtime is read from data._mtime with the same defaulting the
--     client uses (missing or non-numeric -> 0).
-- Outcomes return as one jsonb array of {book_id, status} objects in
-- payload order, so the client can AppLog rejections per book.
-- A wholesale failure (unauthenticated caller, non-array payload)
-- raises, rolling the whole batch back: the function is one
-- transaction, so a push lands completely or not at all.
--
-- Concurrency: the compare-and-write reads the stored row and then
-- writes it; two devices of the SAME account pushing at once could
-- interleave read/read, write/write and let timing pick the winner.
-- A per-account advisory lock (transaction-scoped) serializes one
-- account's pushes; different accounts never contend.
--
-- Tie-break fidelity — the canonical form in SQL: book_canonical_json
-- reproduces js/090's stableJson (recursive key sort, JSON.stringify
-- leaf forms) using jsonb's own text form for scalars and a
-- byte-wise (collation "C") key sort. The comparisons between the
-- two canonical strings in push_books_guarded are C-collated on
-- both operands as well, so a tie is decided by byte order end to
-- end. That collation is load-bearing, not decorative: production's
-- database collation is en_US.UTF-8, and locale ordering weighs
-- punctuation and case differently from the client's JS code-unit
-- comparison, so an uncollated comparison would flip tie winners
-- on ordinary data — and the client's high-water mark advances
-- past a rejected row, so a flipped winner would diverge silently
-- and permanently rather than self-heal on a later push. The
-- C-collated comparisons belong to the same byte-order discipline
-- as the key sort; they are not a further deviation. Two bounded
-- deviations from the JS original, both confined to the
-- equal-_mtime tie case:
--   1. Key order: JS sorts keys by UTF-16 code unit; collation "C"
--      sorts by code point (equivalently UTF-8 byte order). These
--      agree for every BMP character; they can differ only for
--      object KEYS containing non-BMP (astral-plane) characters
--      sorted against BMP keys at or above U+E000. Book record keys
--      are the app's ASCII field names, at every nesting level.
--   2. Leaf text forms: jsonb's escaping of control characters in
--      strings and its numeric formatting can differ from
--      JSON.stringify's in style (e.g. exponent notation at
--      magnitudes book fields never reach: page counts, 0-5
--      ratings, epoch-ms _mtime). A comparison flips only if two
--      different records' canonical forms first differ at exactly
--      such a position.
-- Worst case under either deviation: one equal-_mtime record's tie
-- resolves differently on the server than on one device until that
-- record's next edit. The #335 guarantee itself — never regress to
-- a strictly older _mtime — is a pure numeric comparison and is
-- unaffected.

-- ------------------------------------------------------------------
-- Canonical JSON for the #129 tie-break: object keys sorted
-- recursively, so two devices (or the server) holding the same
-- record content produce the same string regardless of key order.
-- Internal helper for push_books_guarded; not a client surface, so
-- it carries no anon/PUBLIC execute (v636 trigger-function idiom).
-- ------------------------------------------------------------------
create or replace function public.book_canonical_json(v jsonb)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_type text := jsonb_typeof(v);
  v_parts text[] := '{}';
  v_key text;
  v_rec record;
begin
  if v is null or v_type is null or v_type = 'null' then
    return 'null';
  elsif v_type = 'object' then
    for v_key in
      select keys.k
        from jsonb_object_keys(v) as keys(k)
       order by keys.k collate "C"
    loop
      v_parts := v_parts || (to_json(v_key)::text || ':' || public.book_canonical_json(v -> v_key));
    end loop;
    return '{' || array_to_string(v_parts, ',') || '}';
  elsif v_type = 'array' then
    for v_rec in
      select t.elem
        from jsonb_array_elements(v) with ordinality as t(elem, ord)
       order by t.ord
    loop
      v_parts := v_parts || public.book_canonical_json(v_rec.elem);
    end loop;
    return '[' || array_to_string(v_parts, ',') || ']';
  else
    return v::text;
  end if;
end;
$function$;

revoke execute on function public.book_canonical_json(jsonb) from public;
revoke execute on function public.book_canonical_json(jsonb) from anon;
-- authenticated must be named too: the platform's default privileges
-- grant execute on new functions to it, so revoking only PUBLIC and
-- anon would leave this helper callable by any signed-in user. The
-- push function is unaffected — it is SECURITY DEFINER and reaches
-- the helper as its owner, not through the caller's grants.
revoke execute on function public.book_canonical_json(jsonb) from authenticated;

-- ------------------------------------------------------------------
-- The guarded push. SECURITY DEFINER because the guard must see and
-- write the stored row under one rule for every caller; ownership
-- is enforced in the body (v_me below) rather than by RLS, the same
-- posture as v636's RPC fixes: auth.uid() is the only owner input,
-- and it is captured once, before any row is processed.
-- ------------------------------------------------------------------
create or replace function public.push_books_guarded(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_me uuid := auth.uid();
  v_row jsonb;
  v_book_id text;
  v_data jsonb;
  v_isbn text;
  v_mtime_txt text;
  v_in_mtime numeric;
  v_stored_data jsonb;
  v_stored_mtime numeric;
  v_found boolean;
  v_status text;
  v_results jsonb := '[]'::jsonb;
begin
  if v_me is null then
    raise exception 'push_books_guarded: an authenticated caller is required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'push_books_guarded: p_rows must be a jsonb array of book rows';
  end if;

  -- Serialize this account's pushes for the length of the call (see
  -- the header's concurrency note). hashtext collisions across
  -- accounts would only ever add a moment's serialization, never a
  -- wrong result.
  perform pg_advisory_xact_lock(hashtext('push_books_guarded:' || v_me::text));

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_book_id := v_row ->> 'book_id';
    v_data := v_row -> 'data';
    if v_book_id is null or v_book_id = '' or jsonb_typeof(v_data) is distinct from 'object' then
      v_results := v_results || jsonb_build_object('book_id', v_book_id, 'status', 'rejected_invalid');
      continue;
    end if;
    v_isbn := v_row ->> 'isbn';

    -- The lookup is scoped to the caller: a payload naming another
    -- account's book_id finds (or creates) the CALLER's row of that
    -- id, never the other account's.
    select b.data into v_stored_data
      from public.books b
     where b.user_id = v_me and b.book_id = v_book_id;
    v_found := found;

    v_mtime_txt := v_data ->> '_mtime';
    v_in_mtime := case when v_mtime_txt ~ '^-?[0-9]+(\.[0-9]+)?$'
                       then v_mtime_txt::numeric else 0 end;

    if not v_found then
      insert into public.books (user_id, book_id, isbn, data)
      values (v_me, v_book_id, v_isbn, v_data);
      v_status := 'written';
    else
      v_mtime_txt := v_stored_data ->> '_mtime';
      v_stored_mtime := case when v_mtime_txt ~ '^-?[0-9]+(\.[0-9]+)?$'
                             then v_mtime_txt::numeric else 0 end;
      if v_in_mtime > v_stored_mtime then
        update public.books
           set isbn = v_isbn, data = v_data
         where user_id = v_me and book_id = v_book_id;
        v_status := 'written';
      elsif v_in_mtime < v_stored_mtime then
        v_status := 'rejected_stale';
      -- The tie-break comparisons collate "C" on both operands:
      -- byte order, matching the key sort in book_canonical_json
      -- and the client's code-unit comparison. The database's
      -- locale collation would pick different winners on ordinary
      -- data (see the header's tie-break fidelity note).
      elsif public.book_canonical_json(v_data) collate "C" > public.book_canonical_json(v_stored_data) collate "C" then
        update public.books
           set isbn = v_isbn, data = v_data
         where user_id = v_me and book_id = v_book_id;
        v_status := 'written';
      elsif public.book_canonical_json(v_data) collate "C" = public.book_canonical_json(v_stored_data) collate "C" then
        v_status := 'written';
      else
        v_status := 'rejected_tiebreak';
      end if;
    end if;

    v_results := v_results || jsonb_build_object('book_id', v_book_id, 'status', v_status);
  end loop;

  return v_results;
end;
$function$;

-- Signed-in clients only: the anon role has no library to push, and
-- the body's null-caller refusal is the second line, not the first.
revoke execute on function public.push_books_guarded(jsonb) from public;
revoke execute on function public.push_books_guarded(jsonb) from anon;
grant execute on function public.push_books_guarded(jsonb) to authenticated;
