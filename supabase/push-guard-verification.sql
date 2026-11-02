-- push-guard-verification.sql — post-apply verification for
-- supabase/migrations/v643_push_books_guarded.sql (#335 server guard).
--
-- The .test suites pin the migration's posture but cannot execute it
-- (no live Postgres in CI). Run this script in the Supabase SQL
-- editor AFTER v643 is applied, against the real project, to prove
-- the behaviour end to end. It is safe to run in production: every
-- write uses one scratch book_id and the script deletes its scratch
-- rows at the end.
--
-- Before running: replace BOTH placeholder UUIDs below (search for
-- '00000000-') with the ids of two real accounts — yours (A) and any
-- second account (B) whose library the probes must NOT touch. The
-- probes impersonate A via the standard JWT-claims idiom, so
-- auth.uid() inside the function sees A exactly as the app would.

/* ================================================================
   1. Posture: functions exist, definer set, grants locked down.
   Expected: two rows; prosecdef = t for push_books_guarded;
   anon_execute = f for both; authenticated_execute = t for
   push_books_guarded.
   ================================================================ */
select p.proname,
       p.prosecdef,
       has_function_privilege('anon', p.oid, 'execute')          as anon_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
  from pg_proc p
 where p.proname in ('push_books_guarded', 'book_canonical_json');

/* ================================================================
   2. Behaviour, impersonating account A.
   ================================================================ */
-- === EDIT THESE TWO LINES ===
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}', false);
-- (Account B, only ever named in a payload, never impersonated:
--  00000000-0000-0000-0000-00000000000b)

-- 2a. First push of a new book -> [{'book_id': ..., 'status': 'written'}]
select public.push_books_guarded(jsonb_build_array(jsonb_build_object(
  'book_id', '__guard_probe__',
  'isbn', null,
  'data', jsonb_build_object('id', '__guard_probe__', 'title', 'Probe v1', '_mtime', 100)
)));

-- 2b. Stale re-push (older _mtime, different content) -> 'rejected_stale',
--     and the stored row must still be Probe v1 / _mtime 100.
select public.push_books_guarded(jsonb_build_array(jsonb_build_object(
  'book_id', '__guard_probe__',
  'isbn', null,
  'data', jsonb_build_object('id', '__guard_probe__', 'title', 'Probe STALE', '_mtime', 50)
)));
select data ->> 'title' as stored_title, data ->> '_mtime' as stored_mtime
  from public.books
 where book_id = '__guard_probe__' and user_id = auth.uid();
-- Expected: Probe v1 / 100

-- 2c. Tie at _mtime 100 with a canonically GREATER record -> 'written'.
--     ('Probe v2' > 'Probe v1' at the first differing key, title.)
select public.push_books_guarded(jsonb_build_array(jsonb_build_object(
  'book_id', '__guard_probe__',
  'isbn', null,
  'data', jsonb_build_object('id', '__guard_probe__', 'title', 'Probe v2', '_mtime', 100)
)));

-- 2d. Tie at _mtime 100 with a canonically SMALLER record -> 'rejected_tiebreak',
--     stored row still Probe v2.
select public.push_books_guarded(jsonb_build_array(jsonb_build_object(
  'book_id', '__guard_probe__',
  'isbn', null,
  'data', jsonb_build_object('id', '__guard_probe__', 'title', 'Probe v0', '_mtime', 100)
)));
select data ->> 'title' as stored_title
  from public.books
 where book_id = '__guard_probe__' and user_id = auth.uid();
-- Expected: Probe v2

-- 2e. Ownership: a payload that NAMES account B as user_id must land
--     under A anyway. -> 'written', and step 3 must find the row
--     under A and NO row under B.
select public.push_books_guarded(jsonb_build_array(jsonb_build_object(
  'user_id', '00000000-0000-0000-0000-00000000000b',
  'book_id', '__guard_probe_forged__',
  'isbn', null,
  'data', jsonb_build_object('id', '__guard_probe_forged__', 'title', 'Forged', '_mtime', 1)
)));

/* ================================================================
   3. Back to the editor's own role: check the forged row's owner,
      then clean up every scratch row.
   Expected: one row listing A's uuid as owner; the B count is 0.
   ================================================================ */
reset role;
select user_id as forged_row_owner
  from public.books where book_id = '__guard_probe_forged__';
select count(*) as rows_under_b
  from public.books
 where book_id in ('__guard_probe__', '__guard_probe_forged__')
   and user_id = '00000000-0000-0000-0000-00000000000b';
-- Expected: 0

delete from public.books
 where book_id in ('__guard_probe__', '__guard_probe_forged__');
