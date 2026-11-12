// Shape pins for v654, the book_tropes write-policy fix for #358
// (the UPDATE policy's qual was `true` — confidence, model,
// taxonomy, source and created_by rewritable on every row by any
// signed-in user — and INSERT took fakes at confidence 1.0 with
// arbitrary tallies; v636's guard froze only identity + tallies).
//
// No live Postgres in this suite's world: the migration's safety
// is pinned as posture, like rls-hardening.test.js pins v636 —
// the birth rule (zero tallies, community reserved to admins),
// the update scoping by old-row source, the guard's verbatim
// v636 block plus its two new freezes, and the tally CHECKs in
// the table's existing naming style. Confidence/source ranges
// are pinned as NOT re-added — their CHECKs already exist.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v654_book_tropes_write_policies.sql');
ok('v654 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
const sql = mig.replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

/* ---------- insert: the birth rule ---------- */
ok('the seed upsert policy is replaced',
  /drop policy if exists "book_tropes: seed upsert" on public\.book_tropes;/.test(sql) &&
  /create policy "book_tropes: seed upsert"/.test(sql));
ok('a fresh row is born voteless (tallies must start at zero)',
  /with check \(\s+source = any \(array\['llm', 'community'\]\)\s+and upvotes = 0\s+and downvotes = 0/.test(sql));
ok('a row may not be born community from a non-admin caller',
  /create policy "book_tropes: seed upsert"[\s\S]*?and \(source = 'llm' or public\.is_admin\(\)\)\s+\);/.test(sql));

/* ---------- update: scoped by the old row's source ---------- */
ok('the seed update policy is replaced',
  /drop policy if exists "book_tropes: seed update" on public\.book_tropes;/.test(sql) &&
  /create policy "book_tropes: seed update"/.test(sql));
ok('the qual-true hole is gone (no update policy qualifies on true)',
  !/for update\s+to authenticated\s+using \(true\)/.test(sql));
ok('community rows are admin-only to update (qual on the old row)',
  /create policy "book_tropes: seed update"[\s\S]*?using \(source = 'llm' or public\.is_admin\(\)\)/.test(sql));
ok('a non-admin update can neither flip to community nor keep it',
  /create policy "book_tropes: seed update"[\s\S]*?with check \(\s+source = any \(array\['llm', 'community'\]\)\s+and \(source = 'llm' or public\.is_admin\(\)\)\s+\);/.test(sql));

/* ---------- the guard: v636 verbatim + two freezes ---------- */
ok('the guard is create-or-replace with its service/admin bypass intact',
  /create or replace function public\.book_tropes_guard_update\(\)/.test(sql) &&
  /if auth\.role\(\) = 'service_role' or public\.is_admin\(\) then\s+return new;\s+end if;/.test(sql));
ok("v636's identity/tally block survives verbatim (same condition, same message)",
  /or new\.downvotes is distinct from old\.downvotes then\s+raise exception 'book_tropes: identity columns and vote tallies are not client-writable';/.test(sql));
ok('created_by is newly frozen (server-stamped provenance)',
  /if new\.created_by is distinct from old\.created_by then\s+raise exception 'book_tropes: created_by is server-stamped provenance and is not client-writable';/.test(sql));
ok('community demotion is newly frozen for non-admin writers',
  /if old\.source = 'community' and new\.source is distinct from old\.source then\s+raise exception 'book_tropes: a community row cannot be demoted by a non-admin writer';/.test(sql));

/* ---------- the tally ranges, in the table's naming style ---------- */
ok('upvotes gets its nonneg check',
  /add constraint book_tropes_upvotes_check\s+check \(upvotes >= 0\);/.test(sql));
ok('downvotes gets its nonneg check',
  /add constraint book_tropes_downvotes_check\s+check \(downvotes >= 0\);/.test(sql));
ok('confidence/source ranges are NOT re-added (their checks already exist)',
  !/book_tropes_confidence_check/.test(sql) && !/book_tropes_source_check/.test(sql));
ok('no existing data is touched',
  !/update public\.book_tropes\s|delete from public\.book_tropes|insert into public\.book_tropes/.test(sql));

console.log(`\nbook-tropes-policies: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
