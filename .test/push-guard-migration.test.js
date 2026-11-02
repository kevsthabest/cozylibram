// Shape pins for v643, the server-side push guard for #335 (cloud
// push must never regress a newer cloud record). Decision of record:
// the User, 2026-11-02 — the guard lives on the server (atomic
// compare-and-write, one rule for every writer) rather than in the
// client; the client-side fetch-and-drop reconciliation it replaced
// is pinned as ABSENT in sync-reconcile.test.js.
//
// There is no live Postgres in this suite's world, so the migration's
// safety is pinned as posture, exactly like rls-hardening.test.js
// pins v636: ownership comes from auth.uid() and never from the
// payload, the staleness comparison and the #129 tie-break are
// present in the ruled shape, the execute grants are locked down,
// and the file touches no data and no table. Behaviour against a
// real database is verified post-apply by
// supabase/push-guard-verification.sql (see the migration header).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v643_push_books_guarded.sql');
ok('v643 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
const sql = mig.replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

/* ---------- book_canonical_json: the #129 canonical form ---------- */
ok('canonical helper is create-or-replace',
  /create or replace function public\.book_canonical_json\(v jsonb\)/.test(sql));
ok('canonical helper is immutable (pure function of its input)',
  /book_canonical_json\(v jsonb\)[\s\S]*?immutable/.test(sql));
ok('canonical helper sorts object keys byte-wise (collation "C")',
  /order by keys\.k collate "C"/.test(sql));
ok('canonical helper recurses into objects and arrays',
  (sql.match(/public\.book_canonical_json\(/g) || []).length >= 3);
ok('canonical helper carries no anon execute',
  /revoke execute on function public\.book_canonical_json\(jsonb\) from anon;/.test(sql));
ok('canonical helper carries no PUBLIC execute',
  /revoke execute on function public\.book_canonical_json\(jsonb\) from public;/.test(sql));

/* ---------- push_books_guarded: shape and ownership ---------- */
ok('guard is create-or-replace, jsonb in, jsonb out',
  /create or replace function public\.push_books_guarded\(p_rows jsonb\)\s+returns jsonb/.test(sql));
ok('guard is security definer with a pinned search_path',
  /push_books_guarded\(p_rows jsonb\)[\s\S]*?security definer\s+set search_path to 'public'/.test(sql));
ok('guard captures the caller once, from auth.uid()',
  /v_me uuid := auth\.uid\(\);/.test(sql));
ok('guard refuses an unauthenticated caller before touching rows',
  /if v_me is null then\s+raise exception 'push_books_guarded: an authenticated caller is required';/.test(sql));
ok('guard refuses a non-array payload',
  /jsonb_typeof\(p_rows\) <> 'array'/.test(sql));
ok('the payload user_id is never read (ownership cannot be aimed)',
  !/->>\s*'user_id'/.test(sql) && !/->\s*'user_id'/.test(sql));
ok('inserts stamp the caller as the owner',
  /insert into public\.books \(user_id, book_id, isbn, data\)\s+values \(v_me, v_book_id, v_isbn, v_data\);/.test(sql));
ok('the stored-row lookup is scoped to the caller',
  /where b\.user_id = v_me and b\.book_id = v_book_id;/.test(sql));
ok('updates are scoped to the caller',
  (sql.match(/where user_id = v_me and book_id = v_book_id;/g) || []).length === 2);
ok('pushes serialize per account (advisory xact lock)',
  /perform pg_advisory_xact_lock\(hashtext\('push_books_guarded:' \|\| v_me::text\)\);/.test(sql));

/* ---------- guard semantics: staleness, tie-break, outcomes ---------- */
ok('a strictly newer incoming row is written',
  /if v_in_mtime > v_stored_mtime then[\s\S]*?v_status := 'written';/.test(sql));
ok('a strictly older incoming row is rejected_stale',
  /elsif v_in_mtime < v_stored_mtime then\s+v_status := 'rejected_stale';/.test(sql));
ok('equal _mtime falls to the canonical tie-break',
  /elsif public\.book_canonical_json\(v_data\) > public\.book_canonical_json\(v_stored_data\) then/.test(sql));
ok('a tie-break loser is rejected_tiebreak',
  /v_status := 'rejected_tiebreak';/.test(sql));
ok('malformed rows are rejected_invalid, never written',
  /v_status := 'rejected_invalid'/.test(sql) === false &&
  /jsonb_build_object\('book_id', v_book_id, 'status', 'rejected_invalid'\)/.test(sql));
ok('per-row outcomes return as {book_id, status} objects',
  /jsonb_build_object\('book_id', v_book_id, 'status', v_status\)/.test(sql));
ok('_mtime defaults to 0 when missing or non-numeric (client parity)',
  (sql.match(/then v_mtime_txt::numeric else 0 end;/g) || []).length === 2 ||
  (sql.match(/::numeric else 0 end/g) || []).length === 2);

/* ---------- grants ---------- */
ok('guard execute revoked from PUBLIC',
  /revoke execute on function public\.push_books_guarded\(jsonb\) from public;/.test(sql));
ok('guard execute revoked from anon',
  /revoke execute on function public\.push_books_guarded\(jsonb\) from anon;/.test(sql));
ok('guard execute granted to authenticated',
  /grant execute on function public\.push_books_guarded\(jsonb\) to authenticated;/.test(sql));

/* ---------- the file's blast radius: functions only ---------- */
ok('the migration creates no table', !/create table/i.test(sql));
ok('the migration alters no table (books RLS and shape untouched)',
  !/alter table/i.test(sql));
ok('the migration deletes no data', !/delete from/i.test(sql));
ok('the migration drops nothing', !/drop (table|policy|function)/i.test(sql));
ok('the migration never writes deleted_books (tombstones stay client-owned)',
  !/insert into public\.deleted_books|update public\.deleted_books/.test(sql));

console.log('\n' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
