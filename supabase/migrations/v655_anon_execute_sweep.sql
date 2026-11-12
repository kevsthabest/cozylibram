-- v655: anon EXECUTE sweep over public SECURITY DEFINER
-- functions (#357).
--
-- DRAFT — not applied. Gate: Security Advisor review; the apply
-- rides under the User's RLS class approval of 2026-10-19 (the
-- same class as the v636 anon revokes for #340–#343). Drafted
-- 2026-11-12 against the live database — the full definer census
-- below was re-read the same day, not carried from the triage.
-- The v655 number is a draft allocation and renames cleanly if
-- the landing sequence changes it.
--
-- The gap: 42 of the 68 SECURITY DEFINER functions in public are
-- executable by the anon role through explicit anon grants (the
-- count was 42 of 67 at triage; the +1 definer since is
-- write_trope_claims, which v647 correctly locked down — the
-- anon count did not move). Every one of the 42 is uid-bound or
-- trigger-internal, so an anonymous caller gets errors or
-- no-ops today: this is defence in depth, not a live breach.
-- The cost of leaving it is that any future edit weakening a
-- function's internal uid check silently becomes an anonymous
-- data surface. v636 revoked anon on the two oracle functions
-- (handle_available, buddy_reading_state); this file finishes
-- the class.
--
-- The sweep, in two shapes:
--   A. Thirty signed-in RPCs: EXECUTE revoked from PUBLIC and
--      anon; authenticated keeps its explicit grant (every one
--      of these is called by the signed-in client, several via
--      js/237's handleRpc, which itself refuses to fire signed
--      out). The set: the Circle/buddy/thought/marginalia RPCs
--      and the handle RPCs, plus the handle system's internal
--      helpers (handle_lookup_budget, handle_normalize,
--      handle_screen_hit, handle_screen_reserved,
--      handle_screen_slurs — called from inside other definers,
--      where the call runs in the owner's context and never
--      needed the caller's grant) and marginalia_admin_remove.
--   B. Seven trigger functions (blocks_sever_links,
--      book_meta_guard, buddy_reads_unfriend,
--      moment_reactions_unfriend, profiles_content_screen,
--      profiles_handle_guard, thought_of_you_unfriend): EXECUTE
--      revoked from PUBLIC, anon, AND authenticated — no client
--      execution is legitimate for a trigger function at all (a
--      trigger-typed function cannot even be served as an RPC),
--      and trigger firing does not consult the session role's
--      EXECUTE grant, so the triggers keep working untouched.
--
-- Deliberately EXCLUDED — five functions keep their anon grant,
-- each for a proven reason (census 2026-11-12):
--   * is_admin() — RLS policies TO public (which every role,
--     anon included, evaluates) call it on at least eight
--     tables (books, app_admins, banned_users, analytics_events,
--     gift_claims, gift_address_access_log, marginalia_notes,
--     user_reports). Revoking anon's EXECUTE would turn
--     permitted anonymous reads on those tables into
--     permission-denied errors. It also holds a PUBLIC grant,
--     left untouched for the same reason.
--   * circle_book_visible(uuid, text) and
--     circle_book_visible(uuid, text, text) — the books
--     "circle reads shared shelves" policy (TO public) resolves
--     through this name; policy text does not disambiguate the
--     overloads, and both are pure predicates over the same
--     sharing posture the policy itself publishes. Excluding
--     both is the only safe reading.
--   * moment_owner_sharing(uuid) — the moment_reactions
--     "giver or owner reads reactions" policy (TO public) calls
--     it; same reasoning as is_admin().
--   * invite_inviter_name(text) — the ONE designed signed-out
--     RPC surface: the invite landing resolves the inviter's
--     display name from the invite token before the invitee has
--     an account (js/195; the token is the inviter's consent
--     artifact and the function returns null for a dead code or
--     a blocked pair). Revoking anon would break invite
--     redemption's first screen.
-- The pattern to carry forward: a definer that an RLS policy
-- references, or that a signed-out flow calls by design, keeps
-- the grant its consumers need; every other definer is born
-- authenticated-only (or fully locked, for helpers/triggers),
-- with the revokes naming PUBLIC, anon and authenticated
-- explicitly wherever no client execution is intended — the
-- #420 lesson, since default privileges hand EXECUTE to
-- authenticated on creation and a PUBLIC-only revoke strips
-- nothing on this database.
--
-- Re-runnable posture: revokes are idempotent; re-running the
-- file lands the same ACLs. No function body changes, no data
-- is touched, and authenticated loses EXECUTE on nothing except
-- the seven trigger functions in set B.

-- ------------------------------------------------------------------
-- A. Signed-in RPCs: no PUBLIC, no anon. Authenticated keeps its
-- explicit grants throughout.
-- ------------------------------------------------------------------

revoke execute on function public.accept_circle_invite(text) from public, anon;
revoke execute on function public.block_by_handle(text) from public, anon;
revoke execute on function public.buddy_end(uuid) from public, anon;
revoke execute on function public.buddy_invite(uuid, text) from public, anon;
revoke execute on function public.buddy_respond(uuid, boolean) from public, anon;
revoke execute on function public.buddy_states(uuid) from public, anon;
revoke execute on function public.claim_handle(text) from public, anon;
revoke execute on function public.clear_handle() from public, anon;
revoke execute on function public.dismiss_thought_of_you(uuid) from public, anon;
revoke execute on function public.friend_formerly(uuid) from public, anon;
revoke execute on function public.handle_lookup_budget() from public, anon;
revoke execute on function public.handle_normalize(text) from public, anon;
revoke execute on function public.handle_screen_hit(text, text) from public, anon;
revoke execute on function public.handle_screen_reserved() from public, anon;
revoke execute on function public.handle_screen_slurs() from public, anon;
revoke execute on function public.lookup_handle(text) from public, anon;
revoke execute on function public.marginalia_add(text, integer, text) from public, anon;
revoke execute on function public.marginalia_admin_remove(uuid) from public, anon;
revoke execute on function public.marginalia_delete(uuid) from public, anon;
revoke execute on function public.marginalia_for_book(text) from public, anon;
revoke execute on function public.marginalia_mine() from public, anon;
revoke execute on function public.marginalia_report(uuid, text, text) from public, anon;
revoke execute on function public.my_blocked_readers() from public, anon;
revoke execute on function public.my_sent_buddy_invites() from public, anon;
revoke execute on function public.my_sent_thoughts() from public, anon;
revoke execute on function public.react_to_moment(uuid, text, text, text) from public, anon;
revoke execute on function public.recall_thought_of_you(uuid, text) from public, anon;
revoke execute on function public.report_by_handle(text, text, text) from public, anon;
revoke execute on function public.request_by_handle(text) from public, anon;
revoke execute on function public.send_thought_of_you(uuid, text, text) from public, anon;

-- ------------------------------------------------------------------
-- B. Trigger functions: no client execution by any role.
-- Trigger firing does not consult these grants.
-- ------------------------------------------------------------------

revoke execute on function public.blocks_sever_links() from public, anon, authenticated;
revoke execute on function public.book_meta_guard() from public, anon, authenticated;
revoke execute on function public.buddy_reads_unfriend() from public, anon, authenticated;
revoke execute on function public.moment_reactions_unfriend() from public, anon, authenticated;
revoke execute on function public.profiles_content_screen() from public, anon, authenticated;
revoke execute on function public.profiles_handle_guard() from public, anon, authenticated;
revoke execute on function public.thought_of_you_unfriend() from public, anon, authenticated;
