// Shape pins for v653, the server-side catalogue registration
// RPC for #363 (works/editions user INSERT policies were
// presence-only: any signed-in user could register any title
// pair with pre-filled provider_ids/spice, and squat any ISBN).
//
// No live Postgres in this suite's world: the migration's safety
// is pinned as posture, like push-guard-migration.test.js pins
// v643 — the caller comes from auth.uid() and never from the
// payload, validation and the ISBN check digit are present in the
// ruled shapes, provider ids are allowlisted and fill-missing,
// the spice columns are never written by registration, the
// grants name their roles explicitly (helper locked to NO client
// role), the two user insert policies are dropped, and the file
// touches no data. Behaviour against a real database is verified
// post-apply by a probe pack (see the migration header for the
// companion-client sequencing warning it carries).
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v653_catalogue_registration_rpc.sql');
ok('v653 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
const sql = mig.replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

/* ---------- isbn_is_valid: the check-digit gate ---------- */
ok('isbn helper is create-or-replace and immutable',
  /create or replace function public\.isbn_is_valid\(p_isbn text\)\s+returns boolean\s+language plpgsql\s+immutable/.test(sql));
ok('isbn-13 requires the 978/979 prefix',
  /left\(s, 3\) not in \('978', '979'\) then return false;/.test(sql));
ok('isbn-13 verifies the mod-10 check digit',
  /\(case when i % 2 = 1 then 1 else 3 end\)/.test(sql) && /return total % 10 = 0;/.test(sql));
ok('isbn-10 verifies the mod-11 check digit (X counts 10)',
  /substr\(s, i, 1\) = 'X' then 10/.test(sql) && /return total % 11 = 0;/.test(sql));
ok('isbn helper is revoked from PUBLIC',
  /revoke execute on function public\.isbn_is_valid\(text\) from public;/.test(sql));
ok('isbn helper is revoked from anon',
  /revoke execute on function public\.isbn_is_valid\(text\) from anon;/.test(sql));
ok('isbn helper is revoked from authenticated (default privileges grant it, so the role must be named)',
  /revoke execute on function public\.isbn_is_valid\(text\) from authenticated;/.test(sql));

/* ---------- register_work: ownership and validation ---------- */
ok('register_work is create-or-replace, jsonb out',
  /create or replace function public\.register_work\(\s+p_title text,/.test(sql) &&
  /returns jsonb\s+language plpgsql\s+security definer\s+set search_path to 'public'/.test(sql));
ok('register_work captures the caller once, from auth.uid()',
  /v_me uuid := auth\.uid\(\);/.test(sql));
ok('register_work refuses an unauthenticated caller before touching rows',
  /if v_me is null then\s+raise exception 'register_work: an authenticated caller is required';/.test(sql));
ok('empty title and empty title_norm are refused',
  /btrim\(p_title\) = ''/.test(sql) && /btrim\(p_title_norm\) = ''/.test(sql));
ok('authors must be a jsonb array of strings',
  /jsonb_typeof\(p_authors\) <> 'array'/.test(sql) && /jsonb_typeof\(e\.val\) <> 'string'/.test(sql));
ok('series, when present, must be an object with a name',
  /jsonb_typeof\(p_series\) <> 'object'/.test(sql) && /p_series ->> 'name'/.test(sql));

/* ---------- provider ids: propose/own, allowlist, fill-missing ---------- */
ok('only the two corpus provider keys are accepted',
  /p_provider_ids ->> 'hardcover_id'/.test(sql) && /p_provider_ids ->> 'openlibrary_id'/.test(sql) &&
  !/p_provider_ids - /.test(sql));
ok('openlibrary_id must carry its canonical /works/OL…W shape',
  /\^\/works\/OL\[0-9\]\+W\$/.test(sql));
ok('the provider merge fills missing keys only (existing keys win)',
  /where not \(w\.provider_ids \? e\.key\)/.test(sql));

/* ---------- find-or-create + the edition leg ---------- */
ok('the work insert arbitrates on the natural key (title_norm, author_norm)',
  /on conflict \(title_norm, author_norm\) do nothing/.test(sql));
ok('the edition insert arbitrates on isbn and never updates',
  /insert into public\.editions \(work_id, isbn\)[\s\S]*?on conflict \(isbn\) do nothing/.test(sql));
ok('an invalid ISBN never sinks the work (state reported, no raise)',
  /v_isbn_state := 'rejected';/.test(sql));
ok('a taken ISBN is a conflict, never a reassignment (edition id withheld)',
  /v_isbn_state := 'conflict';/.test(sql) && /v_edition_id := null;/.test(sql));
ok('the result reports the full outcome shape',
  /'work_id', v_work_id/.test(sql) && /'created_work', v_created_work/.test(sql) &&
  /'created_edition', v_created_edition/.test(sql) && /'isbn', v_isbn_state/.test(sql));

/* ---------- the columns registration must never write ---------- */
ok('the work insert names exactly the six registration-owned columns (no spice, no embedding, no analysis fields)',
  /insert into public\.works \(title, title_norm, authors, author_norm, series, provider_ids\)/.test(sql));
ok('the words for the pipeline-owned columns never appear as write targets',
  !/set[^;]*(spice_detected|spice_manual|embedding)\s*=/.test(sql));

/* ---------- grants + the one-way door ---------- */
ok('register_work is revoked from PUBLIC and anon',
  /revoke execute on function public\.register_work\(text, text, jsonb, text, jsonb, text, jsonb\) from public;/.test(sql) &&
  /revoke execute on function public\.register_work\(text, text, jsonb, text, jsonb, text, jsonb\) from anon;/.test(sql));
ok('register_work is granted to authenticated',
  /grant execute on function public\.register_work\(text, text, jsonb, text, jsonb, text, jsonb\) to authenticated;/.test(sql));
ok('the works user insert policy is dropped',
  /drop policy if exists "works: user insert" on public\.works;/.test(sql));
ok('the editions user insert policy is dropped',
  /drop policy if exists "editions: user insert" on public\.editions;/.test(sql));
ok('the admin write policies are NOT touched (the correction path stays)',
  !/drop policy if exists "works: admin write"/.test(sql) && !/drop policy if exists "editions: admin write"/.test(sql));
ok('no deletes anywhere; the only inserts are the two registration legs',
  !/delete from/.test(sql) &&
  (sql.match(/insert into public\./g) || []).length === 2);

console.log(`\ncatalogue-registration: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
