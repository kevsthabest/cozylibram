// Shape pins for v636, the RLS hardening migration for the filed
// policy/RPC holes #340–#343 (rulings of record: the User's
// 2026-10-18 class approval; #340 insert arm = trigger-set
// provenance, option (i); #343 = tighten WITH CHECK to the app's
// own auto-publish rule, server-side confirmed-writer as follow-up).
//
// The migration's safety is its posture, so that is what gets
// pinned: both RPC fixes are surgical (the unauthenticated refusal
// and nothing else), the anon revokes are present (the live ACLs
// name anon explicitly, so the revokes bite), the #340 triggers
// carry the ruled shape and revoke their own PUBLIC execute, the
// #343 replacement check encodes exactly the ruled rule, and the
// file touches no data.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v636_rls_hardening.sql');
ok('v636 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
const sql = mig.replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

// #341 — handle_available refuses anonymous callers, surgically.
ok('#341: handle_available is create-or-replace',
  /create or replace function public\.handle_available\(p_handle text\)/.test(sql));
ok('#341: the null-caller refusal is the first body statement',
  /v_me uuid := auth\.uid\(\);[\s\S]*?if v_me is null then return false; end if;/.test(sql));
ok('#341: anon execute revoked',
  /revoke execute on function public\.handle_available\(text\) from anon;/.test(sql));

// #342 — buddy_reading_state refuses anonymous callers, surgically.
ok('#342: buddy_reading_state is create-or-replace',
  /create or replace function public\.buddy_reading_state\(p_user uuid, p_key text\)/.test(sql));
ok('#342: the null-caller arm leads the CASE',
  /select case\s+when auth\.uid\(\) is null then null/.test(sql));
ok('#342: anon execute revoked',
  /revoke execute on function public\.buddy_reading_state\(uuid, text\) from anon;/.test(sql));

// #340 — provenance on insert, identity/tally guard on update.
ok('#340: created_by added guarded, nullable, no default',
  /add column if not exists created_by uuid;/.test(sql) &&
  !/add column if not exists created_by[^;]*(not null|default)/.test(sql));
ok('#340: the insert trigger overwrites created_by from auth.uid()',
  /new\.created_by := auth\.uid\(\);/.test(sql));
ok('#340: insert trigger is drop-guarded and created',
  /drop trigger if exists book_tropes_created_by on public\.book_tropes;[\s\S]*?create trigger book_tropes_created_by\s+before insert on public\.book_tropes/.test(sql));
ok('#340: update guard exempts service_role and admins only',
  /if auth\.role\(\) = 'service_role' or public\.is_admin\(\) then\s+return new;/.test(sql));
ok('#340: update guard protects exactly book_key, trope_id, upvotes, downvotes',
  /new\.book_key is distinct from old\.book_key/.test(sql) &&
  /new\.trope_id is distinct from old\.trope_id/.test(sql) &&
  /new\.upvotes is distinct from old\.upvotes/.test(sql) &&
  /new\.downvotes is distinct from old\.downvotes/.test(sql) &&
  /raise exception 'book_tropes: identity columns and vote tallies are not client-writable';/.test(sql));
ok('#340: update trigger is drop-guarded and created',
  /drop trigger if exists book_tropes_update_guard on public\.book_tropes;[\s\S]*?create trigger book_tropes_update_guard\s+before update on public\.book_tropes/.test(sql));
ok('#340: both trigger functions revoke PUBLIC execute (gate condition)',
  /revoke execute on function public\.book_tropes_set_created_by\(\) from public;/.test(sql) &&
  /revoke execute on function public\.book_tropes_guard_update\(\) from public;/.test(sql));

// #343 — the auto-confirmed insert policy, tightened to the app's rule.
ok('#343: the loose policy is dropped by its exact live name first',
  /drop policy if exists "claims: user insert ai auto-confirmed" on public\.book_trope_claims;/.test(sql));
ok('#343: replacement check requires confirmed ai claims',
  /create policy "claims: user insert ai auto-confirmed"[\s\S]*?status = 'confirmed'/.test(sql) &&
  /source_type = 'ai'/.test(sql));
ok('#343: replacement check requires the auto_confirmed flag AND confidence >= 0.85 AND a non-empty evidence array',
  /\(evidence ->> 'auto_confirmed'\) = 'true'/.test(sql) &&
  /confidence >= 0\.85/.test(sql) &&
  /jsonb_typeof\(evidence -> 'evidence'\) = 'array'/.test(sql) &&
  /jsonb_array_length\(evidence -> 'evidence'\) > 0/.test(sql));
ok('#343: no other claims policy is dropped or created',
  (sql.match(/drop policy/g) || []).length === 1 &&
  (sql.match(/create policy/g) || []).length === 1);

// Whole-file posture.
ok('no data statements at all (insert/delete/update against tables, copy)',
  !/\b(insert into|delete from|copy)\b/.test(sql) &&
  !/update\s+public\./.test(sql));
ok('no table other than book_tropes is altered',
  !/alter table\s+(?!public\.book_tropes)/.test(sql));

console.log('\n' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
