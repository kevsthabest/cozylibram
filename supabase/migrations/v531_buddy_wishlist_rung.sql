-- v531: buddy presence gains the 'wishlist' rung.
--
-- The defect (found by the Security Advisor's composition pass over
-- v528 × v529): buddy_reading_state()'s status ladder predates the
-- Wishlist remodel. Its rungs were read → finished, reading →
-- reading, tbr → not_started, dnf → set_aside, else null. Since
-- v529 made 'wishlist' a real status, a buddy read whose matching
-- copy sits on the Wishlist answers null — the presence chip is
-- silently blank — where the same book pre-remodel (a tbr copy
-- carrying the tobuy facet) answered 'not_started'. Such reads
-- genuinely exist: the invite gate composes with the new status (a
-- visible Wishlist copy can anchor an invite + accept) and a copy
-- can move shelves mid-read. No disclosure issue — null is never a
-- wrong state — but it is a fidelity regression.
--
-- The fix is semantic, not a patch for symmetry: the Wishlist is
-- the pre-reading shelf by the remodel's own definition (a book
-- the reader means to read and has not started), so 'wishlist'
-- joins 'tbr' on the not_started rung. Rung precedence is
-- unchanged (finished > reading > not_started > set_aside), the
-- other rungs are byte-identical, and the function is otherwise
-- re-stated exactly as v528 shipped it.

-- One side's reading state for one book key, as the bare enum.
-- Status only — a copy's CURRENT shelf fact. (The digest elsewhere
-- counts status='read' OR a finish date as finished; presence uses
-- the status alone, so a re-read in progress reads 'reading', not
-- 'finished'.) Precedence across duplicate copies: a finished copy
-- outranks a reading one, which outranks a waiting one, which
-- outranks a set-aside one. No copy with the key → null.
-- Private machinery: revoked from everyone; only the SECURITY
-- DEFINER buddy_states() below (running as owner) calls it.
create or replace function public.buddy_reading_state(p_user uuid, p_key text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'read'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'finished'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'reading'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'reading'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' in ('tbr', 'wishlist')
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'not_started'
    when exists (
      select 1 from public.books b
      where b.user_id = p_user and b.data ->> 'status' = 'dnf'
        and public.toy_book_key(
              case when length(upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))) in (10, 13)
                   then upper(regexp_replace(coalesce(nullif(b.data ->> 'isbn', ''), b.isbn, ''), '[^0-9Xx]', '', 'g'))
                   else '' end,
              b.data ->> 'title',
              case when jsonb_typeof(b.data -> 'authors') = 'array' then b.data -> 'authors' ->> 0
                   when jsonb_typeof(b.data -> 'authors') = 'string' then b.data ->> 'authors'
                   else '' end
            ) = p_key
    ) then 'set_aside'
    else null
  end;
$$;
revoke all on function public.buddy_reading_state(uuid, text) from public;
