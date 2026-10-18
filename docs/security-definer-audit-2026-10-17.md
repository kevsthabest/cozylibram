# SECURITY DEFINER hygiene audit — Supabase migrations (2026-10-17)

Read-only audit of the migration record, commissioned by the User from an
external review and run by the Security Advisor seat. Scope:
`supabase/migrations/*.sql` (53 files) for function hygiene, with
`supabase/*.sql` included for the table/RLS sweep. Nothing was applied to
the live database; no existing migration was edited. Fixes are proposed
as a new migration (§5) for the User's approval only.

Method: every `security definer` mention was reconciled (88 mentions =
77 function definitions + 11 comment mentions, 0 unexplained), every
definition's final form was read with its full grant history, and the
security-critical bodies were read line by line. Baseline documents:
ADR-007 (the gift model), ADR-011 (migration discipline), the runbook's
database section.

## Headline

**No High or Medium findings. No definer function is missing a
`search_path` pin, and no definer function is executable by `anon`
anywhere in the record.** Two Low findings (one hygiene break, one
posture-dependent helper) and three informational notes follow. The gift
vault — the surface this audit was pointed at hardest — is clean at
every layer checked.

## 1. Findings

### LOW-1 — Four trigger functions lack the tree's universal REVOKE

- **Files:** `v525_moment_reactions.sql` (`moment_reactions_unfriend`),
  `v527_thought_of_you.sql` (`thought_of_you_unfriend`),
  `v528_buddy_reads.sql` (`buddy_reads_unfriend`), and
  `v194_book_meta_ownership.sql` (`book_meta_guard`).
- **What:** every other definer function in the tree (65 of 69) sits
  behind an explicit REVOKE; these four have no grant/revoke statements
  at all, so the Postgres default (EXECUTE to PUBLIC) stands.
- **Why it is Low, not worse:** all four `RETURN trigger` (the first
  three are AFTER DELETE cleanup triggers on `circle_links`, operating
  on OLD; `book_meta_guard` guards `book_meta` writes). Postgres
  refuses direct invocation of a trigger function ("trigger functions
  can only be called as a trigger"), so no API role can call them
  today. The risk is pattern drift: a future edit that changes a
  return type, or a new function copied from one of these as a
  template, would inherit a live PUBLIC grant silently.
- **Fix (proposed migration, §5):** add the standard
  `revoke all on function … from public;` lines for the four.

### LOW-2 — `buddy_reading_state` is safe by grant posture only

- **File:** `v531_buddy_wishlist_rung.sql` (defined `v528_buddy_reads.sql`).
- **What:** `buddy_reading_state(p_user uuid, p_key text)` answers
  finished/reading/tbr for **any** user id passed to it, with no caller
  binding in the body — by design: it is an internal helper composed by
  definer RPCs that have already gated the pair. It is safe today for
  exactly one reason: it holds **no EXECUTE grant to any API role**
  (revoked from PUBLIC, never granted), so only the owner (inside other
  definer functions) and `service_role` can reach it.
- **Why it matters:** the invariant is invisible in the code. A future
  migration that grants this function while debugging a 403 — a
  plausible move, since its sibling RPCs are all granted — would create
  an existence oracle over any user's reading state for a known book
  key, with no other change.
- **Fix (proposed migration, §5):** a `COMMENT ON FUNCTION` recording
  the invariant on the function itself (metadata-only, no redefinition):
  never grant EXECUTE to an API role without adding caller binding
  first. The same comment is proposed for `gift_claim_state(uuid)`,
  the gift vault's internal state helper (claim-id argument, likewise
  ungranted by design).

### INFO-1 — One function declares its attributes after the body

`book_meta_guard()` (`v194_book_meta_ownership.sql`) uses the trailing
form (`$$ language plpgsql security definer set search_path = public;`).
It is compliant — definer with `search_path = public` pinned — but it is
the tree's only instance of that ordering, and scanners that read only
the header before the body miss it (the first pass of this audit's own
parser did). Noted for future audit tooling; no fix proposed.

### INFO-2 — `search_path` values, and why `public` is sound here

73 definitions pin `search_path = public`; the four `private.*` edition
functions (`v286`, `v287`) pin `search_path = ''` — the strictest form,
forcing full qualification. A `public` pin is sound in this project for
two reasons: Supabase restricts CREATE in `public` to privileged roles
(so an API user cannot shadow a name the pin resolves to), and the
security-critical bodies schema-qualify their object references (the
gift vault qualifies `public.*`, `vault.decrypted_secrets`, and
`extensions.pgp_sym_*` throughout; the social RPCs qualify `public.*`
consistently in the bodies sampled).

### INFO-3 — This audit covers the repo record, not the live database

The live project can hold objects the repo does not record (the
2026-10-12 health check found live-only archive tables), and a merged
migration file is not proof of application (runbook §5). Recommended
follow-up, not a finding: a one-time read-only live census
(`pg_proc` security flags + `pg_policies`) run under the runbook's
verification preamble, reconciled against §3's inventory.

## 2. The gift vault — verified clean (v582, v584)

Read line by line against ADR-007. No findings.

- **Reveal** (`gift_address_reveal`): the full predicate stack in order —
  caller non-null and not the owner; per-friend grant (predicate #1);
  accepted link; no block either direction; the owner's sharing toggle;
  a **live claim held by this caller against this owner**; budgets from
  the append-only log (3 per claim; 10 per pair per rolling 30 days);
  the 24-hour first-pair claim-age rule. The access-log row is inserted
  **before** any decryption is returned. Every refusal returns the
  identical `'{}'` — no oracle distinguishes which predicate failed.
  Field scoping is by the claim's `format_kind`: print reveals the
  postal fields + phone; any other kind reveals only the gift email.
- **Decryption path** (`gift_dec`, v584 form): reads the key from
  `vault.decrypted_secrets` as definer, raises (fail-closed) when the
  key is absent, and mixes the owner id into the passphrase, so
  ciphertext is owner-bound and tamper-evident (pgcrypto MDC). Both
  `gift_enc` and `gift_dec` are **revoked from public, anon, and
  authenticated** — no API role can invoke decryption directly; the
  only path to plaintext is inside `gift_address_reveal` after every
  gate above. All pgcrypto calls are schema-qualified
  (`extensions.pgp_sym_*`).
- **Claim** (`gift_claim`): caller-bound (`auth.uid()`), advisory-lock
  serialization per claimer then per recipient (fixed lock order), the
  same grant/link/block/wishlist gates with the identical `{ok:false}`
  refusal, one live claim per (recipient, book), claimer caps 2 per
  recipient / 10 global.
- **State surfaces**: the internal helpers (`gift_claim_state`,
  `gift_claim_is_live`, `gift_has_grant`, `gift_pair_linked`,
  `gift_pair_blocked`, `gift_wishlist_open`, `gift_book_format_kind`)
  are revoked from all API roles and reachable only inside definer
  callers. The recipient's opt-in view (`gift_claims_for_recipient`)
  returns `'[]'` unless the caller's **own** `gift_claims_visible` is
  on, and then only book_key + claimer + the constant state `'claimed'`
  for live claims.
- **Address write path** (`gift_address_upsert`): the teen storage ban
  is enforced server-side (band read from the owner's `user_state`,
  never from `profiles`); `gift_address_log_mine` implements the
  two-tier log visibility (72-hour fact tier; identity at resolution or
  14 days) inside the function, not the client.

## 3. Inventory — every SECURITY DEFINER function (final form)

69 distinct definer functions across 77 definitions. "Execute" is the
effective API-role reach after the full grant history (Postgres
preserves grants across `CREATE OR REPLACE`; every redefinition's chain
was checked, and none widened access). Three apparent no-`auth.uid()`
cases among granted functions resolve by composition — the body calls
an auth-bound callee (`circle_book_visible` 3-arg → 2-arg;
`moment_owner_sharing` → `circle_book_visible`) or binds
`v_uid := auth.uid()` in its DECLARE block (`send_thought_of_you`) —
each verified by reading the body, not inferred.

| Function | Defined (final) | search_path | Execute | Caller binding |
|---|---|---|---|---|
| `accept_circle_invite(text)` | v527_thought_of_you.sql | `public` | authenticated | auth.uid() in body |
| `block_by_handle(text)` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `blocks_sever_links()` | v526_blocks.sql | `public` | no API role (internal) | — |
| `book_meta_guard()` | v194_book_meta_ownership.sql | `public` (trailing-attr, INFO-1) | no API role (trigger) | auth.uid() in body |
| `buddy_end(uuid)` | v528_buddy_reads.sql | `public` | authenticated | auth.uid() in body |
| `buddy_invite(uuid,text)` | v528_buddy_reads.sql | `public` | authenticated | auth.uid() in body |
| `buddy_reading_state(uuid,text)` | v531_buddy_wishlist_rung.sql | `public` | no API role (internal) | — |
| `buddy_reads_unfriend()` | v528_buddy_reads.sql | `public` | no API role (trigger) | — |
| `buddy_respond(uuid,boolean)` | v528_buddy_reads.sql | `public` | authenticated | auth.uid() in body |
| `buddy_states(uuid)` | v528_buddy_reads.sql | `public` | authenticated | auth.uid() in body |
| `circle_book_visible(uuid,text)` | v526_blocks.sql | `public` | authenticated | auth.uid() in body |
| `circle_book_visible(uuid,text,text)` | v578_wishlist_server_parity.sql | `public` | authenticated | — |
| `claim_handle(text)` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `clear_handle()` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `dismiss_thought_of_you(uuid)` | v527_thought_of_you.sql | `public` | authenticated | auth.uid() in body |
| `edition_assets_canonical_trigger()` | v286_edition_asset_quality.sql | `''` | no API role (internal) | — |
| `edition_assets_select_best(uuid,text,text)` | v286_edition_asset_quality.sql | `''` | no API role (internal) | — |
| `edition_measurements_canonical_trigger()` | v287_edition_measurements.sql | `''` | no API role (internal) | — |
| `edition_measurements_select_best(uuid)` | v287_edition_measurements.sql | `''` | no API role (internal) | — |
| `friend_formerly(uuid)` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `gift_address_delete()` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_address_log_mine()` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_address_mine()` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_address_reveal(uuid,uuid)` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_address_set_sharing(boolean)` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_address_upsert(text,text,text,text,text,text,text,text)` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_book_format_kind(uuid,text)` | v582_gift_a_book.sql | `public` | no API role (internal) | — |
| `gift_can_gift(uuid)` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_claim(uuid,text)` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_claim_is_live(uuid)` | v582_gift_a_book.sql | `public` | no API role (internal) | — |
| `gift_claim_state(uuid)` | v582_gift_a_book.sql | `public` | no API role (internal) | — |
| `gift_claim_states_for(uuid)` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_claims_for_recipient()` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_claims_mine()` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_dec(bytea,uuid)` | v584_gift_crypto_swap.sql | `public` | no API role (internal) | — |
| `gift_enc(text,uuid)` | v584_gift_crypto_swap.sql | `public` | no API role (internal) | — |
| `gift_has_grant(uuid,uuid)` | v582_gift_a_book.sql | `public` | no API role (internal) | — |
| `gift_mark_purchased(uuid)` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_pair_blocked(uuid,uuid)` | v582_gift_a_book.sql | `public` | no API role (internal) | — |
| `gift_pair_linked(uuid,uuid)` | v582_gift_a_book.sql | `public` | no API role (internal) | — |
| `gift_release(uuid)` | v582_gift_a_book.sql | `public` | authenticated | auth.uid() in body |
| `gift_wishlist_open(uuid)` | v582_gift_a_book.sql | `public` | no API role (internal) | — |
| `handle_available(text)` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `handle_lookup_budget()` | v550_handles.sql | `public` | no API role (internal) | auth.uid() in body |
| `handle_normalize(text)` | v550_handles.sql | `public` | no API role (internal) | — |
| `handle_screen_hit(text,text)` | v550_handles.sql | `public` | no API role (internal) | — |
| `handle_screen_reserved()` | v550_handles.sql | `public` | no API role (internal) | — |
| `handle_screen_slurs()` | v550_handles.sql | `public` | no API role (internal) | — |
| `invite_inviter_name(text)` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `lookup_handle(text)` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `marginalia_add(text,integer,text)` | v574_marginalia.sql | `public` | authenticated | auth.uid() in body |
| `marginalia_admin_remove(uuid)` | v574_marginalia.sql | `public` | authenticated | auth.uid() in body |
| `marginalia_delete(uuid)` | v574_marginalia.sql | `public` | authenticated | auth.uid() in body |
| `marginalia_for_book(text)` | v578_wishlist_server_parity.sql | `public` | authenticated | auth.uid() in body |
| `marginalia_mine()` | v574_marginalia.sql | `public` | authenticated | auth.uid() in body |
| `marginalia_report(uuid,text,text)` | v574_marginalia.sql | `public` | authenticated | auth.uid() in body |
| `moment_owner_sharing(uuid)` | v532_reactions_read_posture.sql | `public` | authenticated | — |
| `moment_reactions_unfriend()` | v525_moment_reactions.sql | `public` | no API role (trigger) | — |
| `my_blocked_readers()` | v526_blocks.sql | `public` | authenticated | auth.uid() in body |
| `my_sent_buddy_invites()` | v532_sent_outbox.sql | `public` | authenticated | auth.uid() in body |
| `my_sent_thoughts()` | v532_sent_outbox.sql | `public` | authenticated | auth.uid() in body |
| `profiles_content_screen()` | v550_handles.sql | `public` | no API role (internal) | — |
| `profiles_handle_guard()` | v550_handles.sql | `public` | no API role (internal) | — |
| `react_to_moment(uuid,text,text,text)` | v525_moment_reactions.sql | `public` | authenticated | auth.uid() in body |
| `recall_thought_of_you(uuid,text)` | v527_thought_of_you.sql | `public` | authenticated | auth.uid() in body |
| `report_by_handle(text,text,text)` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `request_by_handle(text)` | v550_handles.sql | `public` | authenticated | auth.uid() in body |
| `send_thought_of_you(uuid,text,text)` | v527_thought_of_you.sql | `public` | authenticated | — |
| `thought_of_you_unfriend()` | v527_thought_of_you.sql | `public` | no API role (trigger) | — |

Notes on the table: the four `private.edition_*` functions pin
`search_path = ''` (shown as `''`). `book_meta_guard` (v194) pins
`search_path = public` in trailing-attribute form (INFO-1) and is a
trigger function. "No API role (internal)" means EXECUTE is revoked from
PUBLIC and was never granted to `anon`/`authenticated`; "no API role
(trigger)" marks LOW-1's four — no revoke exists, but the trigger
return type bars direct invocation. Invoker (non-definer) helpers —
`marginalia_book_key`, `marginalia_copy_frac`, `marginalia_isbn13`,
`marginalia_num`, `toy_book_key`, `toy_cover_ok`,
`community_tier_weight`, `community_votes_no_self`, trigger timestamp
functions — are out of this table's scope: they run with the caller's
privileges, and each is either revoked from PUBLIC or a pure function.

Spot-verdicts on granted functions that take a user id (work-order item
3): every one binds the argument to the caller — directly
(`gift_claim`, `gift_address_reveal`, `react_to_moment`,
`send_thought_of_you`, `buddy_invite`, `claim_handle`,
`accept_circle_invite` with its block fold-in and generic refusals), by
participant check on a row id (`buddy_end`, `buddy_respond`,
`gift_release`, `gift_mark_purchased`, `marginalia_delete`), by an
admin gate (`marginalia_admin_remove` checks `is_admin()` and returns
the same `'ok'` to non-admins), or by composition (§3 note).
`handle_available` is granted to `authenticated` only — the standing
ruling (authenticated-only, permanently) holds in the record.

## 4. Tables and RLS

58 tables are created across `supabase/*.sql` and the migrations.
**RLS is enabled on all 58** in the repo record, each in its creating
file. Eight tables carry no policies — `toy_send_log`, `toy_dismissals`,
`buddy_send_log`, `buddy_dismissals`, `handle_history`,
`handle_lookups`, `marginalia_send_log`, `gift_crypto` — and in each
case zero-policy **is** the documented model: internal bookkeeping
(cap counters, dismissal records, handle history) reachable only
through definer functions running as owner, plus one key table dropped
by v584. Core user-data tables carry policies matching their documented
models (spot-verified: `books` own-rows + circle-shared + admin;
`profiles` own-only; `deleted_books` own; `gift_addresses` owner-only
SELECT via its single policy with all user paths through the definer
RPCs; `gift_claims` and `gift_address_access_log` admin-read policies
with user paths exclusively through definer RPCs). Every `drop policy`
in the record is a drop-and-recreate inside the migration that owns the
table; no policy is dropped without a same-file replacement.

## 5. Proposed fix migration (for the User's approval — NOT in this PR)

One small additive migration, applied only on the User's explicit go:

```sql
-- LOW-1: uniform revoke for the four trigger functions.
revoke all on function public.moment_reactions_unfriend() from public;
revoke all on function public.thought_of_you_unfriend() from public;
revoke all on function public.buddy_reads_unfriend() from public;
revoke all on function public.book_meta_guard() from public;

-- LOW-2: record the grant-posture invariant on the helpers themselves.
comment on function public.buddy_reading_state(uuid, text) is
  'Internal helper: takes a user id with NO caller binding by design.
   Never GRANT EXECUTE to an API role without adding caller binding.';
comment on function public.gift_claim_state(uuid) is
  'Internal helper: ungranted by design; reachable only inside
   SECURITY DEFINER callers that have gated the pair.';
```

Nothing else is proposed. In particular, no `search_path` changes (none
are missing) and no grant changes to any reachable function.
