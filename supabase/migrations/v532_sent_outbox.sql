-- v532 — Sender outbox RPCs (remediation Batch A, item 2).
--
-- The gap (Product Strategist completeness #1, the review wave's
-- top social finding): Thought-of-you sends and buddy invites are
-- both fire-and-forget with NO durable record the sender can look
-- at. The inviter's only trace was a session-local marker; a ToY
-- sender had nothing at all. Zero confirmation is indistinguishable
-- from the app eating the action.
--
-- The shape is the email model's Sent folder, NOT a receipt
-- system — and the boundary is drawn in the RETURNED COLUMNS:
--
--   * Each function is SECURITY DEFINER and caller-scoped: it
--     returns only rows where auth.uid() is the sender. The tables
--     gain NO new policies (thought_of_you stays recipient-read,
--     buddy_reads keeps its asymmetric read); these functions are
--     the sender's only door, and they open onto the sender's own
--     sends only.
--   * A row carries what the sender already knows: the book
--     (the stored snapshot / the book key), who it went to, the
--     note they wrote, and when they sent it.
--   * A row NEVER carries recipient-side state. There is no
--     dismissed / read / accepted field to return — and
--     my_sent_buddy_invites does not return the buddy row's status
--     column at all, so an invite reads the same whether it is
--     pending, active (already visible to both in Reading
--     together), or anything else. A declined invite's row is
--     deleted by buddy_respond, so it leaves the list; a
--     dismissed ToY card likewise. What the sender can observe is
--     only that a send no longer stands — never why (dismissed,
--     added to their TBR, expired at 60 days, unsent here, or the
--     pair parted), and two of those outcomes are the good ones.
--     That ambiguity is the anti-receipt property, kept on purpose.
--   * The recipient's display name rides along (a left join on
--     profiles): it is the sender's own history of who THEY chose
--     to send to, not a fact about the recipient's behaviour. It
--     stays readable even if the pair later parts — the record of
--     having sent is the sender's.
--
-- Client: js/234 renders the section; pre-migration the functions
-- don't exist and the section hides quietly.

create or replace function public.my_sent_thoughts()
returns table (
  id uuid,
  recipient_id uuid,
  recipient_name text,
  sender_book_id text,
  book jsonb,
  note text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select t.id,
         t.recipient_id,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         t.sender_book_id,
         t.book,
         t.note,
         t.created_at
    from public.thought_of_you t
    left join public.profiles p on p.user_id = t.recipient_id
   where t.sender_id = auth.uid()
   order by t.created_at desc
   limit 50;
$$;
revoke all on function public.my_sent_thoughts() from public;
grant execute on function public.my_sent_thoughts() to authenticated;

create or replace function public.my_sent_buddy_invites()
returns table (
  id uuid,
  invitee_id uuid,
  invitee_name text,
  book_key text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select r.id,
         r.invitee_id,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         r.book_key,
         r.created_at
    from public.buddy_reads r
    left join public.profiles p on p.user_id = r.invitee_id
   where r.inviter_id = auth.uid()
   order by r.created_at desc
   limit 50;
$$;
revoke all on function public.my_sent_buddy_invites() from public;
grant execute on function public.my_sent_buddy_invites() to authenticated;
