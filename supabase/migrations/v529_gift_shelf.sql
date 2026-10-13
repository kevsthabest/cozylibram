-- v529 — Social build #4: the gift shelf.
--
-- The wishlist was the one shelf with no presence in friend browsing.
-- Not because a policy excluded it — the books policy never did —
-- but because it is not a shelf in the data: a wishlist book is an
-- ordinary books row carrying owned = 'tobuy', an ownership facet
-- orthogonal to its status. Friends already received those rows inside
-- the status shelves. Missing were the gift-shelf grouping in the
-- friend view (client, js/195), an owner control to hide it, and —
-- for that hiding to mean anything — row-level enforcement.
--
-- Default posture (the User's explicit call): the gift shelf is
-- visible by default, exactly like the other shelves: share_library
-- on and 'wishlist' not hidden means friends see it. The owner's
-- per-shelf hide control (hidden_shelves gains 'wishlist' as a
-- pseudo-shelf key — never a status) is the opt-out.
--
-- Enforcement: when 'wishlist' is hidden, tobuy rows stop crossing
-- to circle friends entirely — the same row-level treatment a
-- hidden status shelf gets. Stated consequence: a book that is both
-- read and tobuy (read a borrowed copy, wants their own) also leaves
-- the friend's Read shelf while the wishlist is hidden; a books row
-- is one row, and RLS cannot split it by facet.
--
-- Shape: the two-argument circle_book_visible is re-stated verbatim
-- (it stays the newest definition site for the agreement pin) and a
-- three-argument overload adds the gift-shelf gate for the books
-- policy. Every other caller (reactions, buddy reads) keeps the
-- two-argument form and its exact behaviour.

create or replace function public.circle_book_visible(p_owner uuid, p_status text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select (case
    when auth.uid() is null then false
    when auth.uid() = p_owner then true
    -- v526: a blocked pair (either direction) sees nothing — a plain
    -- false, indistinguishable from every other false this returns.
    when exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = p_owner)
         or (b.blocker_id = p_owner and b.blocked_id = auth.uid())
    ) then false
    when not exists (
      select 1 from public.circle_links cl
      where cl.status = 'accepted'
        and ((cl.requester_id = auth.uid() and cl.addressee_id = p_owner)
          or (cl.addressee_id = auth.uid() and cl.requester_id = p_owner))
    ) then false
    else coalesce((
      select p.share_library
         and not (coalesce(p_status, '') = any (coalesce(p.hidden_shelves, '{}'::text[])))
      from public.profiles p
      where p.user_id = p_owner
    ), true)
  end)
  and exists (
    select 1 from public.books b
    where b.user_id = p_owner
      and coalesce(b.data ->> 'status', '') = coalesce(p_status, '')
  );
$$;
revoke all on function public.circle_book_visible(uuid, text) from public;
grant execute on function public.circle_book_visible(uuid, text) to authenticated;

-- The gift-shelf gate. The two-argument helper cannot see the owned
-- facet, so this overload is its answer plus one conjunct: a tobuy
-- row crosses only when the owner has not hidden 'wishlist'.
-- Probe-safety follows the v522 rule — the extra EXISTS is keyed
-- to tobuy books in the queried status, so an answer never exceeds
-- what loading the shelf already shows: a hidden wishlist whose owner
-- has no tobuy book in the queried status answers false here,
-- indistinguishable from an empty shelf; in the policy path the row
-- under test satisfies the EXISTS itself.
create or replace function public.circle_book_visible(p_owner uuid, p_status text, p_owned text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.circle_book_visible(p_owner, p_status)
    and (coalesce(p_owned, '') <> 'tobuy'
      or (not exists (
            select 1 from public.profiles p
            where p.user_id = p_owner
              and 'wishlist' = any (coalesce(p.hidden_shelves, '{}'::text[]))
          )
          and exists (
            select 1 from public.books b
            where b.user_id = p_owner
              and coalesce(b.data ->> 'status', '') = coalesce(p_status, '')
              and coalesce(b.data ->> 'owned', '') = 'tobuy'
          )));
$$;
revoke all on function public.circle_book_visible(uuid, text, text) from public;
grant execute on function public.circle_book_visible(uuid, text, text) to authenticated;

-- The books policy passes the row's owned facet through the gate, so
-- a hidden wishlist keeps tobuy rows from crossing at all.
drop policy if exists "circle reads shared shelves" on public.books;
create policy "circle reads shared shelves" on public.books
  for select
  using (
    auth.uid() = user_id
    or (
      exists (
        select 1 from public.circle_links cl
        where cl.status = 'accepted'
          and ((cl.requester_id = books.user_id and cl.addressee_id = auth.uid())
            or (cl.addressee_id = books.user_id and cl.requester_id = auth.uid()))
      )
      and public.circle_book_visible(books.user_id, books.data->>'status', books.data->>'owned')
    )
  );
