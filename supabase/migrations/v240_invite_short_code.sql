-- v240: shareable invite links.
--
-- The old 6-char invite codes were enumerable by any signed-in user
-- ("read codes" policy). Rotate every code to a 12-char URL-safe
-- crypto-random token (72 bits, unguessable) that doubles as the
-- invite-link slug: https://cozylibram.pages.dev/#/invite/<code>
--
-- One-sided acceptance: the token itself proves the inviter's consent, so
-- the invitee's Accept creates the friendship immediately with no pending
-- round-trip. The plain "send requests" RLS policy only allows inserting
-- pending rows (deliberately — an open accepted-insert would let anyone
-- force-friend anyone), so acceptance goes through a SECURITY DEFINER
-- function that validates the token server-side.

update circle_invites
set code = translate(encode(gen_random_bytes(9), 'base64'), '+/', '-_'),
    created_at = now()
where length(code) < 10;

create or replace function public.accept_circle_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_them uuid;
begin
  if v_me is null then
    raise exception 'not signed in';
  end if;
  select user_id into v_them from circle_invites where code = p_token;
  if v_them is null then
    raise exception 'invite not found';
  end if;
  if v_them = v_me then
    raise exception 'own invite';
  end if;
  delete from circle_links
   where (requester_id = v_me and addressee_id = v_them)
      or (requester_id = v_them and addressee_id = v_me);
  insert into circle_links (requester_id, addressee_id, status)
  values (v_me, v_them, 'accepted');
  return v_them;
end;
$$;

revoke all on function public.accept_circle_invite(text) from public;
grant execute on function public.accept_circle_invite(text) to authenticated;
