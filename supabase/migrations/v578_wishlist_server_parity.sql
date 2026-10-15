-- v578 (number assigned at merge composition; #248 holds v577):
-- Server parity for derived Wishlist visibility (issue #232).
--
-- Gap: since the v559 wishlist unification, "Wishlist" is a DERIVED shelf —
-- a book is a wishlist book iff data->>'status' = 'tbr' AND
-- data->>'owned' = 'tobuy' (isWishlistBook, js/020). But
-- circle_book_visible(owner, status) gates on the raw status string against
-- profiles.hidden_shelves, so a reader who hid only the 'wishlist' shelf key
-- no longer has those books withheld server-side: they reach accepted
-- friends as ordinary TBR rows. Hiding 'tbr' still withholds them (with the
-- whole TBR shelf). The 'wishlist' key and its Settings UI were deliberately
-- preserved at v559 ship time (Advisor condition) so this parity fix needs
-- no client change and nobody has to re-ask the reader.
--
-- Fix shape (the #193-era design, which was Advisor-PASSed but superseded
-- before merge when v529 made wishlist a true status; v559 inverted the
-- model again and revived the need): a 3-arg overload of
-- circle_book_visible that additionally takes the owned facet, delegates
-- every existing gate to the 2-arg function, and withholds exactly the
-- derived set when 'wishlist' is hidden. The books SELECT policy is
-- restated to call the overload with the row's own facet. The 2-arg
-- function is NOT modified: its other callers (reactions, buddy reads —
-- all of which probe with a bare status, mostly the literal 'read', a
-- status the derivation can never produce) keep today's behaviour
-- byte-for-byte. Buddy reads stay OUT (Advisor ruling, 2026-10-15): buddy
-- visibility flows from the pair's per-book accept, not shelf posture;
-- the question reopens as its own ruling if buddy reads ever admit tbr
-- books.
--
-- Marginalia (Advisor ruling, 2026-10-15: IN): marginalia_for_book is
-- restated below because it composes circle_book_visible on the note
-- AUTHOR's matched copy — leaving the 2-arg call there would keep
-- serving a hidden-wishlist author's derived-copy notes while the book
-- row itself is withheld. The restatement is the v574 definition
-- VERBATIM except one expression: the visibility call on the author's
-- copy gains the copy's owned facet. Identity is proven, not trusted:
-- .test/circle-privacy.test.js pins byte-equality between the v574
-- definition and the restatement below once that single expression is
-- normalised back to the 2-arg form.
--
-- Oracle discipline (the v522/v526 hardening, preserved):
--   * The overload returns true only when a book of the owner's actually
--     matches BOTH the status and the facet (the facet EXISTS below) — so
--     "hidden", "no such book", "not linked", "blocked", and "not sharing"
--     all stay one indistinguishable false, exactly as the 2-arg's
--     status EXISTS keeps an empty shelf indistinguishable from a hidden
--     one.
--   * In the policy path the row under test satisfies both EXISTS checks
--     by construction, so no currently-visible row changes state except
--     derived-wishlist rows under a hidden 'wishlist' key — the intended
--     set, and only that set.
--   * Facet probing via RPC: for a status the caller may already see, the
--     owned facet of shared rows already crosses the wire on those rows
--     (standing v522 wire posture), so a (status, facet) existence answer
--     reveals nothing the shelf load doesn't. For the derived pair
--     (tbr, tobuy) under a hidden 'wishlist' key the answer is false —
--     indistinguishable from the pair being empty.
--
-- Additive only: one new function overload, one policy restatement, one
-- function restatement differing from its v574 original by a single
-- expression. No data writes, no column changes. Rollback: restate the
-- policy in its 2-arg form, restate marginalia_for_book in its v574
-- form, and drop the overload.
--
-- Applies post-merge under the standing flow (marker preamble first).
-- Acceptance: the issue's circle-pair spot-check, run RLS-faithfully
-- (SET LOCAL ROLE authenticated + request.jwt.claims) inside rolled-back
-- transactions — hide wishlist-only -> derived rows withheld, other TBR
-- rows still served; hide tbr -> all TBR withheld; unhide -> restored;
-- owner-side reads unchanged throughout; plus the marginalia cell:
-- author hides 'wishlist' -> the derived copy's notes stop serving,
-- unhide -> restored.

begin;

create or replace function public.circle_book_visible(p_owner uuid, p_status text, p_owned text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.circle_book_visible(p_owner, p_status)
     and not (
       coalesce(p_status, '') = 'tbr'
       and coalesce(p_owned, '') = 'tobuy'
       and exists (
         select 1 from public.profiles p
         where p.user_id = p_owner
           and 'wishlist' = any (coalesce(p.hidden_shelves, '{}'::text[]))
       )
     )
     and exists (
       select 1 from public.books b
       where b.user_id = p_owner
         and coalesce(b.data ->> 'status', '') = coalesce(p_status, '')
         and coalesce(b.data ->> 'owned', '') = coalesce(p_owned, '')
     );
$$;
revoke all on function public.circle_book_visible(uuid, text, text) from public;
grant execute on function public.circle_book_visible(uuid, text, text) to authenticated;

-- The books SELECT policy is the one row-context caller whose rows carry
-- the facet: restate it to pass the row's owned facet into the check.
drop policy if exists "circle reads shared shelves" on books;
create policy "circle reads shared shelves" on books
  for select
  using (
    auth.uid() = user_id
    or (
      exists (
        select 1 from circle_links cl
        where cl.status = 'accepted'
          and ((cl.requester_id = books.user_id and cl.addressee_id = auth.uid())
            or (cl.addressee_id = books.user_id and cl.requester_id = auth.uid()))
      )
      and public.circle_book_visible(books.user_id, books.data->>'status', books.data->>'owned')
    )
  );

-- marginalia_for_book, restated verbatim from v574 except the single
-- circle_book_visible expression on the author's matched copy (it gains
-- that copy's owned facet, so a hidden 'wishlist' key withholds the
-- derived copy's notes exactly as it withholds the row).
create or replace function public.marginalia_for_book(p_book_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_key text;
  v_on boolean;
  v_frac double precision;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select b.book_id, b.isbn, b.data into v_row
    from public.books b
   where b.user_id = v_uid and b.book_id = p_book_id;
  if not found then raise exception 'no such book'; end if;
  if btrim(coalesce(v_row.data ->> 'title', '')) = '' then raise exception 'no such book'; end if;
  -- The viewer's own switch: off means no notes, full stop.
  select p.marginalia_enabled into v_on from public.profiles p where p.user_id = v_uid;
  if found and v_on is distinct from true then return '[]'::jsonb; end if;

  v_key := public.marginalia_book_key(v_row.data, v_row.isbn);
  select coalesce(max(public.marginalia_copy_frac(b.data)), 0) into v_frac
    from public.books b
   where b.user_id = v_uid
     and public.marginalia_book_key(b.data, b.isbn) = v_key;

  return coalesce((
    select jsonb_agg(row_to_json(t) order by t.frac asc, t.created_at asc)
    from (
      select n.id, n.author_id, n.frac, n.page, n.page_count, n.body, n.created_at
        from public.marginalia_notes n
       where n.book_key = v_key
         and (
           n.author_id = v_uid
           or (
             n.frac <= v_frac
             -- The author's switch: off withdraws their notes.
             and coalesce((select p.marginalia_enabled from public.profiles p
                            where p.user_id = n.author_id), true)
             -- The author's matched copy is visible to me through
             -- the shelf gates (link + share_library +
             -- hidden_shelves + the copy still exists), composed
             -- per copy status like the buddy gate.
             and exists (
               select 1 from public.books ab
                where ab.user_id = n.author_id
                  and public.marginalia_book_key(ab.data, ab.isbn) = v_key
                  and public.circle_book_visible(n.author_id, ab.data ->> 'status', ab.data ->> 'owned')
             )
             -- No block in either direction (belt over the link
             -- sever + the visibility helper's own blocked branch).
             and not exists (
               select 1 from public.blocks bl
                where (bl.blocker_id = v_uid and bl.blocked_id = n.author_id)
                   or (bl.blocker_id = n.author_id and bl.blocked_id = v_uid)
             )
           )
         )
       order by n.frac asc, n.created_at asc
       limit 500
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.marginalia_for_book(text) from public;
grant execute on function public.marginalia_for_book(text) to authenticated;

commit;
