-- v532 — Reactions read posture (remediation Batch A, item 4).
--
-- The defect (Codebase audit #17, Security Advisor ruling): the
-- moment_reactions SELECT policy was `giver or owner` — full stop.
-- Writes re-validate the owner's CURRENT posture at write time
-- (react_to_moment: accepted friendship → share_activity on →
-- circle_book_visible(owner, 'read')), but READS never re-checked
-- it. A giver who reacted while the owner was sharing kept reading
-- that reaction row forever via direct API — after the owner turned
-- activity off, after they hid the Read shelf — even though the
-- app's own feed (which derives moments from the owner's currently
-- shared books) had stopped showing the moment entirely.
--
-- The fix (the ruling's verbatim shape): the GIVER branch of the
-- read policy additionally requires the same two facts the write
-- RPC checks — the owner's CURRENT share_activity is on, and
-- circle_book_visible(owner, 'read') holds for the caller. The
-- OWNER branch stays ungated (your own moments' reactions are
-- yours to read regardless of your sharing posture), and the
-- giver DELETE policy is untouched (removing your own reaction is
-- always allowed).
--
-- The two facts are composed inside a SECURITY DEFINER helper,
-- never as a raw cross-table subquery in the policy: post-v522 the
-- profiles base table is owner-only under RLS, so a policy
-- subquery against it would run with the CALLER's rights, see no
-- owner row, and fail closed for every giver. The definer helper
-- (the circle_book_visible pattern) reads what it needs and hands
-- back only a boolean.
--
-- Client: none. js/231 keeps reading the table; rows the new
-- posture excludes simply stop arriving.

create or replace function public.moment_owner_sharing(p_owner uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
           select 1 from public.profiles p
            where p.user_id = p_owner
              and p.share_activity
         )
         and public.circle_book_visible(p_owner, 'read');
$$;
revoke all on function public.moment_owner_sharing(uuid) from public;
grant execute on function public.moment_owner_sharing(uuid) to authenticated;

drop policy if exists "giver or owner reads reactions" on public.moment_reactions;
create policy "giver or owner reads reactions" on public.moment_reactions
  for select
  using (
    auth.uid() = owner_id
    or (auth.uid() = giver_id and public.moment_owner_sharing(owner_id))
  );
