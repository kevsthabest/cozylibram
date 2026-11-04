// Shape pins for v647 writer as corrected by v648 for
// book_trope_claims (#408; the DELETE narrowing closes #362's
// remaining arm). Rulings of record: the User's 2026-10-18 #343
// ruling (tighten now, confirmed-writer as the named follow-up) and
// the 2026-11-04 work order sequencing it first.
//
// The migration's safety is its posture, so that is what gets
// pinned: the writer is a definer function with a caller gate, the
// survival rules and the server-side publish decision are in the
// body, the evidence envelope is assembled from validated parts
// (never trusted from the caller), the grants name their roles
// explicitly (this database grants EXECUTE per role — a PUBLIC-only
// revoke strips nothing, the #357/#420 lesson), the direct confirmed
// insert path is gone, and the DELETE policy keeps only its
// candidate arm. Behaviour against the live function is exercised
// in the post-apply probe pack, not here.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v647_claims_confirmed_writer.sql');
ok('v647 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
// v648 replaces the function with the protection classification failing
// closed; the policies and grants stay as v647 wrote them. Shape pins
// judge both files together; the classification pins below judge v648
// alone, discriminatorily.
const mig2Path = path.join(ROOT, 'supabase/migrations/v648_claims_writer_protection_fix.sql');
ok('v648 migration file exists', fs.existsSync(mig2Path));
const mig2 = fs.readFileSync(mig2Path, 'utf8');
const sql2 = mig2.replace(/--[^\n]*/g, '');
const sql = (mig + '\n' + mig2).replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

// The writer itself.
ok('writer is create-or-replace, SECURITY DEFINER, search_path pinned',
  /create or replace function public\.write_trope_claims\(/.test(sql) &&
  /security definer/.test(sql) &&
  /set search_path to 'public'/.test(sql));
ok('caller gate: a null auth.uid() raises before anything else',
  /v_me uuid := auth\.uid\(\);[\s\S]*?if v_me is null then\s+raise exception/.test(sql));
ok('referential validation: the work must exist, every trope must exist',
  /not exists \(select 1 from public\.works w where w\.id = p_work_id\)/.test(sql) &&
  /not exists \(select 1 from public\.tropes t where t\.id = v_trope\)/.test(sql));
ok('batch is capped',
  /jsonb_array_length\(p_claims\) > 200/.test(sql));

// Survival rules, server-side.
ok('rejected tropes are classified and skipped, never re-inserted',
  /c\.status = 'rejected'/.test(sql) &&
  /'reason', 'rejected'/.test(sql));
ok('regenerable test is a jsonb compare against true, no boolean cast',
  /c\.status = 'confirmed'/.test(sql) &&
  /\(c\.evidence -> 'auto_confirmed'\) = 'true'::jsonb/.test(sql) &&
  !/\(c\.evidence ->> 'auto_confirmed'\)::boolean/.test(sql));
ok('protected classification fails closed (v648): only provably-auto ai rows are unprotected',
  /c\.source_type <> 'ai'\s+or \(c\.evidence -> 'auto_confirmed'\) is distinct from 'true'::jsonb/.test(sql2));
ok('the fail-open NOT form is absent from v648 (NULL evidence keys fell through it)',
  !/not \(c\.source_type = 'ai'/.test(sql2));
ok('the delete set is the ai regenerable set, computed in the function',
  /delete from public\.book_trope_claims c\s+where c\.work_id = p_work_id and c\.source_type = 'ai'/.test(sql));

// The publish decision and the envelope.
ok('status decided server-side by the app rule: confidence >= 0.85 plus a quote',
  /v_auto := v_conf >= 0\.85 and jsonb_array_length\(v_clean_quotes\) > 0;/.test(sql));
ok('confidence is range-validated 0..1 per claim',
  /v_conf < 0 or v_conf > 1/.test(sql));
ok('evidence envelope is built by the function, auto_confirmed set by the function',
  /jsonb_build_object\([\s\S]*?'auto_confirmed', v_auto\)/.test(sql));
ok('provenance: source_id is stamped from the caller uid, server-side',
  /'ai', v_me::text,/.test(sql));
ok('return contract carries written + confirmed + skipped',
  /'written', to_jsonb\(v_written\)/.test(sql) &&
  /'confirmed', to_jsonb\(v_confirmed\)/.test(sql) &&
  /'skipped', v_skipped/.test(sql));

// Grants name their roles (per-role grant discipline).
ok('execute revoked from public AND anon by name; granted to authenticated + service_role',
  /revoke execute on function public\.write_trope_claims\(uuid, jsonb, text, text, int, int\) from public, anon;/.test(sql) &&
  /grant execute on function public\.write_trope_claims\(uuid, jsonb, text, text, int, int\) to authenticated, service_role;/.test(sql));

// Policy changes: exactly the two named moves.
ok('direct confirmed insert policy is dropped by its exact live name',
  /drop policy if exists "claims: user insert ai auto-confirmed" on public\.book_trope_claims;/.test(sql));
ok('candidate insert policy is dropped too (gate condition: no direct writer remains)',
  /drop policy if exists "claims: user insert ai candidates" on public\.book_trope_claims;/.test(sql));
ok('no replacement insert policy is created (the writer is the only client path)',
  !/create policy "claims: user insert/.test(sql));
ok('DELETE policy recreated candidates-only under its existing name',
  /drop policy if exists "claims: user replace ai regenerable" on public\.book_trope_claims;[\s\S]*?create policy "claims: user replace ai regenerable"[\s\S]*?for delete to authenticated\s+using \(source_type = 'ai' and status = 'candidate'\);/.test(sql));
ok('the read and admin policies are untouched',
  !/(drop policy|create policy)[^;]*claims: (read for signed-in|admin write)/.test(sql));

// Whole-file posture.
ok('no data statements against existing rows (the only DML lives inside the writer function)',
  !/\binsert into public\.book_trope_claims\s*\(/.test(sql.replace(
    /create or replace function public\.write_trope_claims[\s\S]*?\$function\$;/, '')) &&
  !/update\s+public\./.test(sql));
ok('no other table is altered',
  !/alter table/.test(sql));

console.log('\n' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
