-- v399: Community corpus refinement v1 — suggestion flows with provenance,
-- curation queue support, contribution tiers (dormant), community votes,
-- trigger taxonomy seed.
--
-- ADDITIVE ONLY. No existing tables are altered except trope_proposals
-- (new nullable columns). No destructive statements.
--
-- Pillars: tropes (catalog suggestions + new-idea proposals), characters
-- (add/merge/correct), trigger warnings (taxonomy suggestions).
-- v1 behavior: Kevin's curation queue. Tier fields exist so v2 needs no
-- migration; all tier weights are 1 until the community exists.

-- ---------------------------------------------------------------------------
-- 1. trope_proposals: kind + catalog trope_id (additive columns)
-- ---------------------------------------------------------------------------
alter table public.trope_proposals
  add column if not exists kind text not null default 'new-idea'
    check (kind in ('catalog', 'new-idea')),
  add column if not exists trope_id text references public.tropes (id) on delete set null,
  add column if not exists obscurity_weight numeric not null default 1
    check (obscurity_weight > 0 and obscurity_weight <= 1);

comment on column public.trope_proposals.kind is
  'catalog = suggest an existing 89-catalog trope for a book (trope_id set); new-idea = free-text proposal outside the catalog (Kevin curates, never auto-added)';
comment on column public.trope_proposals.trope_id is
  'Catalog trope id for kind=catalog suggestions. Users never mint catalog IDs.';

-- Anti-gaming: cap suggestions per book per user (5 of each kind).
-- Partial unique indexes can't express "5 max"; enforced client-side +
-- documented here for a future trigger if abuse appears.
create index if not exists trope_proposals_book_kind_idx
  on public.trope_proposals (book_key, kind) where (status = 'pending');

-- ---------------------------------------------------------------------------
-- 2. character_suggestions: add / merge / correct with evidence + provenance
-- ---------------------------------------------------------------------------
create table if not exists public.character_suggestions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('add', 'merge', 'correct')),
  book_key text not null,
  -- add: the proposed character. merge: character A id (canonical target).
  -- correct: the character being corrected. References are best-effort text
  -- because client-side character ids may be pipeline ids, not UUIDs.
  character_ref text,
  -- merge only: the duplicate character id proposed to fold into character_ref
  merge_with_ref text,
  name text,
  role text check (role is null or role in ('protagonist', 'antagonist', 'supporting', 'minor')),
  description text,
  -- merge proposals REQUIRE evidence (e.g. "both appear in Chapter 12").
  -- Enforced: merge rows must have non-empty evidence.
  evidence text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  suggested_by uuid not null references auth.users (id) on delete cascade,
  obscurity_weight numeric not null default 1
    check (obscurity_weight > 0 and obscurity_weight <= 1),
  created_at timestamptz not null default now(),
  constraint character_suggestions_merge_evidence
    check (type <> 'merge' or length(trim(evidence)) > 0),
  constraint character_suggestions_merge_refs
    check (type <> 'merge' or (character_ref is not null and merge_with_ref is not null))
);
create index if not exists character_suggestions_book_idx
  on public.character_suggestions (book_key) where (status = 'pending');
create index if not exists character_suggestions_suggester_idx
  on public.character_suggestions (suggested_by);

comment on column public.character_suggestions.obscurity_weight is
  'Anti-gaming: 1/(1 + existing suggestion count for the book) at insert time. Milestones sum weights, not raw counts.';

alter table public.character_suggestions enable row level security;

drop policy if exists "character_suggestions: read for signed-in" on public.character_suggestions;
create policy "character_suggestions: read for signed-in"
  on public.character_suggestions for select to authenticated using (true);
drop policy if exists "character_suggestions: suggest own" on public.character_suggestions;
create policy "character_suggestions: suggest own"
  on public.character_suggestions for insert to authenticated
  with check (suggested_by = auth.uid() and status = 'pending');
drop policy if exists "character_suggestions: retract own pending" on public.character_suggestions;
create policy "character_suggestions: retract own pending"
  on public.character_suggestions for delete to authenticated
  using (suggested_by = auth.uid() and status = 'pending');
drop policy if exists "character_suggestions: admin review" on public.character_suggestions;
create policy "character_suggestions: admin review"
  on public.character_suggestions for update to authenticated
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- 3. trigger_taxonomy: controlled vocabulary, Kevin-seeded and curated
-- ---------------------------------------------------------------------------
create table if not exists public.trigger_taxonomy (
  id text primary key,
  label text not null,
  description text not null default '',
  category text not null default 'other',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.trigger_taxonomy is
  'Controlled trigger vocabulary (like the 89-trope catalog). Users suggest from these IDs; new-term ideas go to Kevin''s curation queue. Prevents duplicate fragmentation.';

alter table public.trigger_taxonomy enable row level security;

drop policy if exists "trigger_taxonomy: read for signed-in" on public.trigger_taxonomy;
create policy "trigger_taxonomy: read for signed-in"
  on public.trigger_taxonomy for select to authenticated using (true);
drop policy if exists "trigger_taxonomy: admin write" on public.trigger_taxonomy;
create policy "trigger_taxonomy: admin write"
  on public.trigger_taxonomy for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- 4. trigger_suggestions: community-proposed warnings from the taxonomy
-- ---------------------------------------------------------------------------
create table if not exists public.trigger_suggestions (
  id uuid primary key default gen_random_uuid(),
  book_key text not null,
  trigger_id text not null references public.trigger_taxonomy (id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  suggested_by uuid not null references auth.users (id) on delete cascade,
  obscurity_weight numeric not null default 1
    check (obscurity_weight > 0 and obscurity_weight <= 1),
  created_at timestamptz not null default now(),
  unique (book_key, trigger_id, suggested_by)
);
create index if not exists trigger_suggestions_book_idx
  on public.trigger_suggestions (book_key) where (status = 'pending');

alter table public.trigger_suggestions enable row level security;

drop policy if exists "trigger_suggestions: read for signed-in" on public.trigger_suggestions;
create policy "trigger_suggestions: read for signed-in"
  on public.trigger_suggestions for select to authenticated using (true);
drop policy if exists "trigger_suggestions: suggest own" on public.trigger_suggestions;
create policy "trigger_suggestions: suggest own"
  on public.trigger_suggestions for insert to authenticated
  with check (suggested_by = auth.uid() and status = 'pending');
drop policy if exists "trigger_suggestions: retract own pending" on public.trigger_suggestions;
create policy "trigger_suggestions: retract own pending"
  on public.trigger_suggestions for delete to authenticated
  using (suggested_by = auth.uid() and status = 'pending');
drop policy if exists "trigger_suggestions: admin review" on public.trigger_suggestions;
create policy "trigger_suggestions: admin review"
  on public.trigger_suggestions for update to authenticated
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- 5. community_votes: one vote per user per suggestion, no self-voting
--    (v1: Kevin's queue displays consensus; the public "tend the library"
--    surface is parked. Votes are dormant but the model is final.)
-- ---------------------------------------------------------------------------
create table if not exists public.community_votes (
  suggestion_type text not null
    check (suggestion_type in ('trope', 'new-trope', 'character', 'trigger')),
  suggestion_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  vote smallint not null check (vote in (1, -1)),
  created_at timestamptz not null default now(),
  primary key (suggestion_type, suggestion_id, user_id)
);
comment on table public.community_votes is
  'Approve/reject votes on pending suggestions. One vote per user per suggestion. No self-voting (enforced by trigger below). Tier-weighted in display; all weights 1 in v1.';

alter table public.community_votes enable row level security;

drop policy if exists "community_votes: read for signed-in" on public.community_votes;
create policy "community_votes: read for signed-in"
  on public.community_votes for select to authenticated using (true);
drop policy if exists "community_votes: own votes" on public.community_votes;
create policy "community_votes: own votes"
  on public.community_votes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- No self-voting: the voter may not be the suggester. Checks the matching
-- suggestion table by type.
create or replace function public.community_votes_no_self()
returns trigger language plpgsql as $$
declare
  suggester uuid;
begin
  if NEW.suggestion_type in ('trope', 'new-trope') then
    select proposed_by into suggester from public.trope_proposals where id = NEW.suggestion_id;
  elsif NEW.suggestion_type = 'character' then
    select suggested_by into suggester from public.character_suggestions where id = NEW.suggestion_id;
  elsif NEW.suggestion_type = 'trigger' then
    select suggested_by into suggester from public.trigger_suggestions where id = NEW.suggestion_id;
  end if;
  if suggester is not null and suggester = NEW.user_id then
    raise exception 'cannot vote on your own suggestion';
  end if;
  return NEW;
end $$;

drop trigger if exists community_votes_no_self_trigger on public.community_votes;
create trigger community_votes_no_self_trigger
  before insert or update on public.community_votes
  for each row execute function public.community_votes_no_self();

-- ---------------------------------------------------------------------------
-- 6. community_tiers: trust tiers (DORMANT in v1 — v1 is Kevin's queue).
--    member: everyone. established: auto at >=10 accepted w/ >=75% rate.
--    verified: Kevin's grant, revocable. Vote weights 1/2/3 when live.
-- ---------------------------------------------------------------------------
create table if not exists public.community_tiers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tier text not null default 'member'
    check (tier in ('member', 'established', 'verified')),
  accepted_count int not null default 0 check (accepted_count >= 0),
  rejected_count int not null default 0 check (rejected_count >= 0),
  granted_by uuid references auth.users (id) on delete set null,
  granted_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.community_tiers is
  'Contribution trust tiers. DORMANT in v1 (Kevin curates everything). established = automatic at >=10 accepted with >=75% acceptance; verified = Kevin grant, revocable. Vote weights member=1, established=2, verified=3 when the tend-the-library surface ships.';

alter table public.community_tiers enable row level security;

drop policy if exists "community_tiers: read own" on public.community_tiers;
create policy "community_tiers: read own"
  on public.community_tiers for select to authenticated
  using (user_id = auth.uid() or is_admin());
drop policy if exists "community_tiers: admin write" on public.community_tiers;
create policy "community_tiers: admin write"
  on public.community_tiers for all to authenticated
  using (is_admin()) with check (is_admin());

-- Tier weight lookup for consensus display (all 1 in v1).
create or replace function public.community_tier_weight(p_user_id uuid)
returns int language sql stable as $$
  select case coalesce((select tier from public.community_tiers where user_id = p_user_id), 'member')
    when 'verified' then 3
    when 'established' then 2
    else 1 end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Trigger taxonomy seed (starter set for Kevin to curate)
-- ---------------------------------------------------------------------------
insert into public.trigger_taxonomy (id, label, description, category) values
  ('violence-graphic', 'Graphic violence', 'Detailed depictions of physical violence or gore', 'violence'),
  ('violence-sexual', 'Sexual violence', 'Sexual assault, rape, or coercion depicted or described', 'violence'),
  ('violence-domestic', 'Domestic abuse', 'Intimate partner violence or coercive control', 'violence'),
  ('violence-gun', 'Gun violence', 'Shootings or firearm violence', 'violence'),
  ('violence-torture', 'Torture', 'Prolonged physical or psychological torment', 'violence'),
  ('death-suicide', 'Suicide', 'Suicide depicted, attempted, or discussed in detail', 'death'),
  ('death-child', 'Death of a child', 'A child character dies', 'death'),
  ('death-grief', 'Grief and loss', 'Sustained focus on mourning a death', 'death'),
  ('death-miscarriage', 'Pregnancy loss', 'Miscarriage, stillbirth, or infant loss', 'death'),
  ('mental-selfharm', 'Self-harm', 'Self-injury depicted or described', 'mental-health'),
  ('mental-eating', 'Eating disorders', 'Disordered eating depicted or discussed', 'mental-health'),
  ('mental-depression', 'Depression', 'Sustained depiction of depressive episodes', 'mental-health'),
  ('mental-anxiety', 'Anxiety and panic', 'Panic attacks or severe anxiety depicted', 'mental-health'),
  ('mental-addiction', 'Addiction', 'Substance abuse or addiction as a theme', 'mental-health'),
  ('abuse-emotional', 'Emotional abuse', 'Gaslighting, manipulation, verbal cruelty', 'abuse'),
  ('abuse-child', 'Child abuse', 'Abuse or neglect of a child character', 'abuse'),
  ('identity-homophobia', 'Homophobia', 'Anti-LGBTQ+ discrimination or slurs', 'identity'),
  ('identity-racism', 'Racism', 'Racial discrimination, slurs, or hate', 'identity'),
  ('identity-transphobia', 'Transphobia', 'Anti-trans discrimination or misgendering', 'identity'),
  ('identity-misogyny', 'Misogyny', 'Sustained sexist abuse or degradation', 'identity'),
  ('medical-hospital', 'Medical trauma', 'Graphic medical procedures or hospital horror', 'medical'),
  ('medical-needles', 'Needles', 'Injections or needle-focused scenes', 'medical'),
  ('animal-harm', 'Animal harm', 'An animal is hurt or killed', 'other'),
  ('pregnancy', 'Pregnancy', 'Pregnancy as a plot element (may distress some readers)', 'other'),
  ('infidelity', 'Infidelity', 'Cheating as a significant plot element', 'relationships'),
  ('stalking', 'Stalking', 'A character is stalked or surveilled', 'abuse'),
  ('kidnapping', 'Kidnapping', 'Abduction or captivity', 'violence'),
  ('war', 'War', 'Battlefield violence or war trauma', 'violence'),
  ('body-horror', 'Body horror', 'Graphic bodily transformation or mutilation', 'violence'),
  ('claustrophobia', 'Confinement', 'Being trapped or confined at length', 'other')
on conflict (id) do nothing;
