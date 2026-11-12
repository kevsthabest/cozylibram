// Shape pins for v655, the anon EXECUTE sweep for #357 (42 of
// the public SECURITY DEFINER functions were anon-executable via
// explicit grants; all uid-bound or trigger-internal, so this is
// defence in depth — a future weakened uid check must not become
// an anonymous surface by default).
//
// No live Postgres in this suite's world: the migration's safety
// is pinned as posture, like rls-hardening.test.js pins v636 —
// every one of the 37 swept signatures carries its revoke in the
// ruled shape (PUBLIC+anon for signed-in RPCs, plus
// authenticated for trigger functions), authenticated is revoked
// on NOTHING else, and the five proven exclusions (is_admin, both
// circle_book_visible overloads, moment_owner_sharing,
// invite_inviter_name) appear nowhere as revoke targets: RLS
// policies TO public call the first four, and the fifth is the
// designed signed-out invite surface.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  NOT OK - ' + name); }
}

const migPath = path.join(ROOT, 'supabase/migrations/v655_anon_execute_sweep.sql');
ok('v655 migration file exists', fs.existsSync(migPath));
const mig = fs.readFileSync(migPath, 'utf8');
const sql = mig.replace(/--[^\n]*/g, ''); // pins judge statements, not the header prose

/* ---------- set A: signed-in RPCs lose PUBLIC + anon ---------- */
const setA = [
  'accept_circle_invite(text)', 'block_by_handle(text)', 'buddy_end(uuid)',
  'buddy_invite(uuid, text)', 'buddy_respond(uuid, boolean)', 'buddy_states(uuid)',
  'claim_handle(text)', 'clear_handle()', 'dismiss_thought_of_you(uuid)',
  'friend_formerly(uuid)', 'handle_lookup_budget()', 'handle_normalize(text)',
  'handle_screen_hit(text, text)', 'handle_screen_reserved()', 'handle_screen_slurs()',
  'lookup_handle(text)', 'marginalia_add(text, integer, text)',
  'marginalia_admin_remove(uuid)', 'marginalia_delete(uuid)', 'marginalia_for_book(text)',
  'marginalia_mine()', 'marginalia_report(uuid, text, text)', 'my_blocked_readers()',
  'my_sent_buddy_invites()', 'my_sent_thoughts()', 'react_to_moment(uuid, text, text, text)',
  'recall_thought_of_you(uuid, text)', 'report_by_handle(text, text, text)',
  'request_by_handle(text)', 'send_thought_of_you(uuid, text, text)',
];
ok('set A names thirty RPCs', setA.length === 30);
for (const fn of setA) {
  ok(`A: ${fn} revoked from public+anon (authenticated kept)`,
    sql.includes(`revoke execute on function public.${fn} from public, anon;`));
}

/* ---------- set B: trigger functions lose every client role ---------- */
const setB = [
  'blocks_sever_links()', 'book_meta_guard()', 'buddy_reads_unfriend()',
  'moment_reactions_unfriend()', 'profiles_content_screen()',
  'profiles_handle_guard()', 'thought_of_you_unfriend()',
];
ok('set B names seven trigger functions', setB.length === 7);
for (const fn of setB) {
  ok(`B: ${fn} revoked from public+anon+authenticated`,
    sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`));
}

/* ---------- the sweep is exactly these 37, nothing more ---------- */
ok('exactly 37 revoke statements in the file',
  (sql.match(/revoke execute on function/g) || []).length === 37);
ok('authenticated is revoked on exactly the seven trigger functions and nothing else',
  (sql.match(/from public, anon, authenticated;/g) || []).length === 7);
ok('no grants are issued (this file only narrows)',
  !/grant execute/.test(sql));
ok('no function body is altered and no data is touched',
  !/create or replace function|create function|alter function|insert into|delete from/.test(sql));

/* ---------- the five exclusions: never revoke targets ---------- */
const excluded = [
  'is_admin()',                      // RLS policies TO public call it
  'circle_book_visible(uuid, text)', // books circle-read policy (TO public)
  'circle_book_visible(uuid, text, text)',
  'moment_owner_sharing(uuid)',      // moment_reactions read policy (TO public)
  'invite_inviter_name(text)',       // the designed signed-out invite surface
];
for (const fn of excluded) {
  ok(`excluded: ${fn} is never a revoke target`,
    !sql.includes(`revoke execute on function public.${fn} `));
}
ok('the v636-revoked oracles stay out (already handled, not re-revoked)',
  !/handle_available|buddy_reading_state/.test(sql));
ok('the v647/v643 writers stay out (already locked down at creation)',
  !/write_trope_claims|push_books_guarded|book_canonical_json/.test(sql));

console.log(`\nanon-execute-sweep: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
