-- v532 — Name the inviter (remediation Batch A, item 5).
--
-- The defect (UX wave P3-11): the invite-accept dialog called the
-- inviter "A reader" in both directions. The dialog resolves the
-- inviter's profile through the circle_profiles projection (v522),
-- which only covers readers already LINKED to the viewer
-- (accepted or pending) — by design. A fresh inviter, the normal
-- case for an invite link, is not linked yet, so the projection
-- returns nothing and the dialog fell back to the generic label.
--
-- The token is the inviter's own consent artifact, created to be
-- shared; the person holding it is meant to learn who invited
-- them (accepting would make them friends and reveal the full
-- projected profile anyway). This function returns ONLY the
-- inviter's display name for a token:
--
--   * unknown / rotated code        → null (the dialog keeps its
--                                     generic label; no oracle for
--                                     code existence beyond what
--                                     redemption itself reveals)
--   * the caller's own code         → null
--   * a block in either direction   → null (v526 silence: a blocked
--     between caller and inviter      pair learns nothing here,
--                                     exactly as accept refuses
--                                     with the identical shape)
--   * blank profile name            → null
--
-- SECURITY DEFINER, execute for authenticated only — the same
-- boolean-or-null discipline as the other circle helpers: it
-- hands back one name the token already entitles the holder to
-- see, and nothing else about anyone.

create or replace function public.invite_inviter_name(p_token text)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_them uuid;
  v_name text;
begin
  if auth.uid() is null then return null; end if;
  select user_id into v_them from public.circle_invites where code = p_token;
  if v_them is null or v_them = auth.uid() then return null; end if;
  if exists (
    select 1 from public.blocks b
     where (b.blocker_id = auth.uid() and b.blocked_id = v_them)
        or (b.blocker_id = v_them and b.blocked_id = auth.uid())
  ) then
    return null;
  end if;
  select nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
    into v_name
    from public.profiles
   where user_id = v_them;
  return v_name;
end;
$$;
revoke all on function public.invite_inviter_name(text) from public;
grant execute on function public.invite_inviter_name(text) to authenticated;
