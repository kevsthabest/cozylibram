-- Trope intelligence tables (v151). Re-run safe.
--
-- Run order: after supabase/schema.sql. analytics.sql is optional — the
-- is_admin() helper below is CREATE OR REPLACE so running this before or
-- after analytics.sql is fine.
--
-- Tables:
--   tropes            canonical taxonomy (mirrors js/156-trope-taxonomy.js)
--   book_tropes       shared per-work trope cache, keyed by book_key
--                     (ISBN-13, or t:<title>:<author> fallback)
--   trope_votes         one vote per user per (book, trope)
--   trope_proposals   user-proposed tropes pending admin review
--   trope_proposal_votes  one vote per user per proposal (normalized;
--                       counts are derived, never stored)
--
-- The seed INSERT at the bottom is generated from the taxonomy file:
--   node supabase/gen-trope-seed.js
-- Re-run the generator on every taxonomy bump and paste the output between
-- the BEGIN/END GENERATED SEED markers.

-- Admin check (same as analytics.sql; CREATE OR REPLACE keeps this file
-- runnable on its own).
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from app_admins where user_id = auth.uid());
$$;

create table if not exists tropes (
  id text primary key,
  name text not null,
  description text not null,
  genres text[] not null default '{}',
  version int not null default 1
);
alter table tropes enable row level security;

create table if not exists book_tropes (
  book_key text not null,
  trope_id text not null references tropes(id) on delete cascade,
  source text not null default 'llm' check (source in ('llm', 'community')),
  confidence real not null default 0.5 check (confidence >= 0 and confidence <= 1),
  upvotes int not null default 0,
  downvotes int not null default 0,
  model text,
  taxonomy_version int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (book_key, trope_id)
);
create index if not exists book_tropes_trope_idx on book_tropes (trope_id);
alter table book_tropes enable row level security;

create table if not exists trope_votes (
  book_key text not null,
  trope_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  vote smallint not null check (vote in (1, -1)),
  primary key (book_key, trope_id, user_id)
);
alter table trope_votes enable row level security;

create table if not exists trope_proposals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null,
  description text not null,
  genres text[] not null default '{}',
  book_key text,
  proposed_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'duplicate')),
  duplicate_of text references tropes(id),
  created_at timestamptz not null default now(),
  unique (name_key)
);
alter table trope_proposals enable row level security;

-- One vote (+1/-1) per user per proposal. Counts are always derived from
-- these rows; no aggregate counters are stored.
create table if not exists trope_proposal_votes (
  proposal_id uuid not null references trope_proposals(id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  vote smallint not null check (vote in (1, -1)),
  primary key (proposal_id, user_id)
);
alter table trope_proposal_votes enable row level security;

-- RLS: the taxonomy is readable by every signed-in user, writable by admins.
drop policy if exists "tropes: read for signed-in" on tropes;
create policy "tropes: read for signed-in"
  on tropes for select to authenticated using (true);
drop policy if exists "tropes: admin write" on tropes;
create policy "tropes: admin write"
  on tropes for all to authenticated using (is_admin()) with check (is_admin());

-- book_tropes is a shared cache: everyone reads; any signed-in client may
-- upsert llm/community seeds (source is constrained by the CHECK above).
drop policy if exists "book_tropes: read for signed-in" on book_tropes;
create policy "book_tropes: read for signed-in"
  on book_tropes for select to authenticated using (true);
drop policy if exists "book_tropes: seed upsert" on book_tropes;
create policy "book_tropes: seed upsert"
  on book_tropes for insert to authenticated
  with check (source in ('llm', 'community'));
drop policy if exists "book_tropes: seed update" on book_tropes;
create policy "book_tropes: seed update"
  on book_tropes for update to authenticated
  using (true) with check (source in ('llm', 'community'));

-- Votes: everyone reads; users manage only their own rows.
drop policy if exists "trope_votes: read for signed-in" on trope_votes;
create policy "trope_votes: read for signed-in"
  on trope_votes for select to authenticated using (true);
drop policy if exists "trope_votes: own votes" on trope_votes;
create policy "trope_votes: own votes"
  on trope_votes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Proposals: everyone reads; users can propose (as themselves); only admins
-- change status or delete.
drop policy if exists "trope_proposals: read for signed-in" on trope_proposals;
create policy "trope_proposals: read for signed-in"
  on trope_proposals for select to authenticated using (true);
drop policy if exists "trope_proposals: propose" on trope_proposals;
create policy "trope_proposals: propose"
  on trope_proposals for insert to authenticated
  with check (proposed_by = auth.uid() and status = 'pending');
drop policy if exists "trope_proposals: admin review" on trope_proposals;
create policy "trope_proposals: admin review"
  on trope_proposals for update to authenticated
  using (is_admin()) with check (is_admin());
drop policy if exists "trope_proposals: admin delete" on trope_proposals;
create policy "trope_proposals: admin delete"
  on trope_proposals for delete to authenticated using (is_admin());

-- Proposal votes: everyone reads; users manage only their own rows.
drop policy if exists "trope_proposal_votes: read for signed-in" on trope_proposal_votes;
create policy "trope_proposal_votes: read for signed-in"
  on trope_proposal_votes for select to authenticated using (true);
drop policy if exists "trope_proposal_votes: own votes" on trope_proposal_votes;
create policy "trope_proposal_votes: own votes"
  on trope_proposal_votes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- BEGIN GENERATED SEED (from js/156-trope-taxonomy.js v1, 84 tropes)
-- Regenerate with: node supabase/gen-trope-seed.js
insert into tropes (id, name, description, genres, version, aliases, exclusions)
values
  ('enemies-to-lovers', 'Enemies to Lovers', 'Two characters who start out hostile or opposed fall for each other.', ARRAY['romance', 'dark-romance', 'fantasy'], 1, ARRAY['enemy to lover', 'enemies to lover'], ARRAY[]),
  ('forced-proximity', 'Forced Proximity', 'Circumstances trap two characters together until feelings develop.', ARRAY['romance', 'dark-romance', 'fantasy', 'contemporary'], 1, ARRAY['forced closeness'], ARRAY[]),
  ('grumpy-x-sunshine', 'Grumpy x Sunshine', 'A brooding, closed-off character paired with a cheerful optimist.', ARRAY['romance', 'dark-romance', 'contemporary'], 1, ARRAY['grumpy sunshine', 'grumpy/sunshine'], ARRAY[]),
  ('slow-burn', 'Slow Burn', 'Romantic tension builds gradually over most of the story.', ARRAY['romance', 'dark-romance', 'fantasy'], 1, ARRAY[], ARRAY[]),
  ('forbidden-love', 'Forbidden Love', 'The romance is barred by family, duty, law, or society.', ARRAY['romance', 'dark-romance', 'fantasy', 'historical'], 1, ARRAY[], ARRAY[]),
  ('fated-mates', 'Fated Mates', 'Destiny, biology, or magic declares two characters meant for each other.', ARRAY['romance', 'dark-romance', 'fantasy'], 1, ARRAY['fated mate', 'destined mates'], ARRAY[]),
  ('fake-dating', 'Fake Dating', 'A pretend relationship staged for appearances turns real.', ARRAY['romance', 'contemporary'], 1, ARRAY['fake relationship'], ARRAY[]),
  ('marriage-of-convenience', 'Marriage of Convenience', 'Wed for practical reasons — money, protection, alliance — then fall in love.', ARRAY['romance', 'dark-romance', 'historical', 'fantasy'], 1, ARRAY['convenience marriage'], ARRAY[]),
  ('arranged-marriage', 'Arranged Marriage', 'Families or rulers dictate the match; the couple must make it work.', ARRAY['romance', 'dark-romance', 'historical', 'fantasy'], 1, ARRAY[], ARRAY[]),
  ('second-chance', 'Second Chance', 'Former lovers reunite years later and try again.', ARRAY['romance', 'contemporary'], 1, ARRAY['second chance romance'], ARRAY[]),
  ('secret-baby', 'Secret Baby', 'A hidden pregnancy or child complicates the romance.', ARRAY['romance', 'dark-romance', 'contemporary'], 1, ARRAY['hidden baby'], ARRAY[]),
  ('love-triangle', 'Love Triangle', 'One character torn between two love interests.', ARRAY['romance', 'dark-romance', 'fantasy'], 1, ARRAY[], ARRAY[]),
  ('billionaire', 'Billionaire', 'An ultra-wealthy love interest with power to reshape the heroine’s world.', ARRAY['romance', 'dark-romance', 'contemporary'], 1, ARRAY[], ARRAY[]),
  ('mafia', 'Mafia', 'Organized-crime families, loyalty codes, and dangerous devotion.', ARRAY['romance', 'dark-romance', 'mystery-thriller'], 1, ARRAY['mob', 'mafia romance', 'organized crime'], ARRAY[]),
  ('bully', 'Bully', 'A cruel or tormenting love interest who softens into devotion.', ARRAY['romance', 'dark-romance'], 1, ARRAY['bullying', 'bullies'], ARRAY[]),
  ('stalker', 'Stalker', 'Obsessive pursuit framed as dark, possessive romance.', ARRAY['dark-romance', 'mystery-thriller'], 1, ARRAY['stalking'], ARRAY[]),
  ('kidnapping', 'Kidnapping', 'Abduction sparks a twisted captor-captive dynamic.', ARRAY['dark-romance', 'mystery-thriller'], 1, ARRAY['kidnap'], ARRAY[]),
  ('captive', 'Captive / Captor', 'One character held by the other; power and desire blur.', ARRAY['dark-romance', 'fantasy', 'mystery-thriller'], 1, ARRAY['captor', 'captive/captor', 'captive romance'], ARRAY[]),
  ('revenge', 'Revenge', 'A quest for vengeance drives the plot — sometimes aimed at a lover.', ARRAY['dark-romance', 'fantasy', 'mystery-thriller'], 1, ARRAY[], ARRAY[]),
  ('morally-grey', 'Morally Grey Love Interest', 'The love interest does terrible things and the story loves them anyway.', ARRAY['dark-romance', 'fantasy'], 1, ARRAY['morally gray', 'morally gray love interest', 'morally grey love interest'], ARRAY[]),
  ('age-gap', 'Age Gap', 'A significant age difference the story treats as a feature.', ARRAY['romance', 'dark-romance', 'contemporary'], 1, ARRAY['age difference'], ARRAY[]),
  ('single-dad', 'Single Dad', 'A devoted father balancing parenthood with new love.', ARRAY['romance', 'contemporary'], 1, ARRAY['single father'], ARRAY[]),
  ('workplace-romance', 'Workplace Romance', 'Sparks fly between colleagues, bosses, or rivals at work.', ARRAY['romance', 'contemporary'], 1, ARRAY['office romance'], ARRAY[]),
  ('small-town', 'Small Town Romance', 'Close-knit town, nosy neighbors, and love around every corner.', ARRAY['romance', 'contemporary'], 1, ARRAY['small town romance'], ARRAY[]),
  ('friends-to-lovers', 'Friends to Lovers', 'Longtime friends realize the real thing was there all along.', ARRAY['romance', 'contemporary'], 1, ARRAY['friend to lover'], ARRAY[]),
  ('secret-relationship', 'Secret Relationship', 'The couple hides their romance from everyone around them.', ARRAY['romance', 'dark-romance'], 1, ARRAY[], ARRAY[]),
  ('bodyguard', 'Bodyguard', 'Hired protection turns into something far more personal.', ARRAY['romance', 'dark-romance', 'mystery-thriller'], 1, ARRAY[], ARRAY[]),
  ('royalty', 'Royalty', 'Princes, kings, and court intrigue meet romance.', ARRAY['romance', 'fantasy', 'historical'], 1, ARRAY['royals'], ARRAY['prince', 'princess']),
  ('amnesia', 'Amnesia', 'Memory loss erases — or rewrites — a love story.', ARRAY['romance', 'mystery-thriller'], 1, ARRAY['memory loss'], ARRAY[]),
  ('pregnancy', 'Pregnancy', 'An unexpected pregnancy forces two people together.', ARRAY['romance', 'dark-romance'], 1, ARRAY['unplanned pregnancy', 'pregnant'], ARRAY[]),
  ('why-choose', 'Why Choose / Reverse Harem', 'The heroine keeps them all — no choosing between love interests.', ARRAY['dark-romance', 'fantasy', 'romance'], 1, ARRAY['why choose', 'reverse harem'], ARRAY[]),
  ('stepbrother', 'Stepbrother (Taboo)', 'Blended-family proximity with a forbidden charge.', ARRAY['dark-romance', 'romance'], 1, ARRAY['step brother'], ARRAY[]),
  ('biker', 'Biker / MC', 'Motorcycle-club culture: brotherhood, danger, loyalty.', ARRAY['romance', 'dark-romance'], 1, ARRAY['bikers', 'mc romance', 'motorcycle club'], ARRAY[]),
  ('vampire', 'Vampire', 'Blood-drinkers as lovers, predators, or aristocrats.', ARRAY['dark-romance', 'fantasy', 'horror', 'romance'], 1, ARRAY['vampires'], ARRAY[]),
  ('werewolf', 'Werewolf', 'Shifters, packs, and moon-driven instinct.', ARRAY['dark-romance', 'fantasy', 'romance'], 1, ARRAY['werewolves'], ARRAY[]),
  ('shifter', 'Shifter (Non-Wolf)', 'Characters who change into animals other than wolves.', ARRAY['dark-romance', 'fantasy', 'romance'], 1, ARRAY['shifters', 'shapeshifter', 'shapeshifters'], ARRAY[]),
  ('dark-academia', 'Dark Academia', 'Elite schools, classical obsession, secrets in the stacks.', ARRAY['romance', 'fantasy', 'mystery-thriller'], 1, ARRAY[], ARRAY[]),
  ('chosen-one', 'Chosen One', 'Prophecy or destiny singles out an unlikely hero.', ARRAY['fantasy'], 1, ARRAY[], ARRAY[]),
  ('magic-academy', 'Magic Academy', 'A school for magic users — lessons, rivalries, deadly exams.', ARRAY['fantasy', 'romance'], 1, ARRAY['magic school'], ARRAY[]),
  ('dragons', 'Dragons', 'Dragons as mounts, bonded partners, or ancient powers.', ARRAY['fantasy', 'romance'], 1, ARRAY['dragon'], ARRAY[]),
  ('found-family', 'Found Family', 'Misfits who choose each other and become family.', ARRAY['fantasy', 'sci-fi', 'contemporary', 'romance'], 1, ARRAY[], ARRAY[]),
  ('quest', 'Quest', 'A journey to find, deliver, or destroy something vital.', ARRAY['fantasy'], 1, ARRAY[], ARRAY[]),
  ('hidden-powers', 'Hidden Powers', 'The protagonist conceals — or discovers — extraordinary abilities.', ARRAY['fantasy', 'sci-fi'], 1, ARRAY['hidden magic'], ARRAY[]),
  ('reluctant-hero', 'Reluctant Hero', 'Dragged into heroism against every instinct to stay out.', ARRAY['fantasy', 'sci-fi'], 1, ARRAY[], ARRAY[]),
  ('dark-lord', 'Dark Lord', 'A supreme evil whose shadow hangs over the whole story.', ARRAY['fantasy'], 1, ARRAY[], ARRAY[]),
  ('prophecy', 'Prophecy', 'A foretelling that shapes — or misleads — the characters.', ARRAY['fantasy'], 1, ARRAY[], ARRAY[]),
  ('political-intrigue', 'Political Intrigue', 'Courts, councils, and factions scheming for power.', ARRAY['fantasy', 'sci-fi', 'historical', 'mystery-thriller'], 1, ARRAY['court intrigue'], ARRAY[]),
  ('hard-magic', 'Hard Magic System', 'Magic with strict rules, costs, and clever exploitation.', ARRAY['fantasy'], 1, ARRAY['hard magic'], ARRAY[]),
  ('portal-fantasy', 'Portal Fantasy', 'An ordinary person crosses into a magical world.', ARRAY['fantasy'], 1, ARRAY[], ARRAY[]),
  ('epic-battle', 'Epic Battle', 'Large-scale warfare decides the fate of kingdoms.', ARRAY['fantasy', 'sci-fi'], 1, ARRAY[], ARRAY[]),
  ('ai-uprising', 'AI Uprising', 'Artificial intelligence turns on its creators — or demands rights.', ARRAY['sci-fi', 'mystery-thriller'], 1, ARRAY['robot uprising'], ARRAY[]),
  ('space-opera', 'Space Opera', 'Sweeping interstellar adventure across star systems.', ARRAY['sci-fi'], 1, ARRAY[], ARRAY[]),
  ('first-contact', 'First Contact', 'Humanity meets alien intelligence for the first time.', ARRAY['sci-fi'], 1, ARRAY[], ARRAY[]),
  ('time-travel', 'Time Travel', 'Characters move through time and face the paradoxes.', ARRAY['sci-fi', 'romance', 'mystery-thriller'], 1, ARRAY[], ARRAY[]),
  ('dystopia', 'Dystopia', 'An oppressive future regime the characters resist or survive.', ARRAY['sci-fi'], 1, ARRAY['dystopian'], ARRAY[]),
  ('cyberpunk', 'Cyberpunk', 'High tech, low life: neon cities, hackers, megacorps.', ARRAY['sci-fi'], 1, ARRAY[], ARRAY[]),
  ('generation-ship', 'Generation Ship', 'A self-contained world aboard a centuries-long voyage.', ARRAY['sci-fi'], 1, ARRAY[], ARRAY[]),
  ('alien-invasion', 'Alien Invasion', 'Earth under attack by an extraterrestrial force.', ARRAY['sci-fi', 'horror'], 1, ARRAY[], ARRAY[]),
  ('deadly-trials', 'Deadly Trials', 'A brutal competition where losing means death.', ARRAY['fantasy', 'sci-fi'], 1, ARRAY[], ARRAY[]),
  ('faceless-enemy', 'Faceless Enemy', 'An adversary whose identity or nature stays hidden.', ARRAY['sci-fi', 'mystery-thriller', 'horror'], 1, ARRAY[], ARRAY[]),
  ('dead-mans-switch', 'Dead Man''s Switch', 'A contingency that triggers on the creator’s death or silence.', ARRAY['sci-fi', 'mystery-thriller'], 1, ARRAY['dead man''s switch', 'dead man switch'], ARRAY[]),
  ('unlikely-alliance', 'Unlikely Alliance', 'Enemies or strangers forced to cooperate against a bigger threat.', ARRAY['sci-fi', 'fantasy'], 1, ARRAY[], ARRAY[]),
  ('whodunit', 'Whodunit', 'A classic puzzle mystery: uncover the culprit among suspects.', ARRAY['mystery-thriller'], 1, ARRAY['who dunnit', 'murder mystery'], ARRAY[]),
  ('unreliable-narrator', 'Unreliable Narrator', 'The narrator’s version of events can’t be trusted.', ARRAY['mystery-thriller', 'horror'], 1, ARRAY[], ARRAY[]),
  ('locked-room', 'Locked Room', 'An impossible crime in a sealed space.', ARRAY['mystery-thriller'], 1, ARRAY['locked room mystery'], ARRAY[]),
  ('cold-case', 'Cold Case', 'An old unsolved crime reopened years later.', ARRAY['mystery-thriller'], 1, ARRAY[], ARRAY[]),
  ('serial-killer', 'Serial Killer', 'A repeating murderer hunted across the story.', ARRAY['mystery-thriller', 'horror'], 1, ARRAY[], ARRAY[]),
  ('conspiracy', 'Conspiracy', 'A hidden network pulling strings behind events.', ARRAY['mystery-thriller', 'sci-fi'], 1, ARRAY[], ARRAY[]),
  ('double-cross', 'Double-Cross', 'Alliances flip; nobody’s loyalty is what it seemed.', ARRAY['mystery-thriller'], 1, ARRAY['double cross'], ARRAY['betrayal']),
  ('missing-person', 'Missing Person', 'A disappearance drives the search for truth.', ARRAY['mystery-thriller'], 1, ARRAY['missing persons'], ARRAY[]),
  ('small-town-secrets', 'Small-Town Secrets', 'A quiet town where everyone is hiding something.', ARRAY['mystery-thriller', 'horror'], 1, ARRAY[], ARRAY[]),
  ('haunted-house', 'Haunted House', 'A dwelling with a malign presence or history.', ARRAY['horror'], 1, ARRAY[], ARRAY[]),
  ('possession', 'Possession', 'An entity takes over a human body or mind.', ARRAY['horror'], 1, ARRAY['possessed', 'demonic possession'], ARRAY[]),
  ('folk-horror', 'Folk Horror', 'Rural rituals, old gods, and communities with dark customs.', ARRAY['horror'], 1, ARRAY[], ARRAY[]),
  ('cosmic-horror', 'Cosmic Horror', 'Vast indifferent entities; humanity’s insignificance is the scare.', ARRAY['horror', 'sci-fi'], 1, ARRAY['lovecraftian'], ARRAY[]),
  ('final-girl', 'Final Girl', 'One survivor — usually a young woman — outlasts the horror.', ARRAY['horror'], 1, ARRAY[], ARRAY[]),
  ('found-footage', 'Found Footage', 'The story unfolds through recovered recordings or documents.', ARRAY['horror'], 1, ARRAY[], ARRAY[]),
  ('body-horror', 'Body Horror', 'Terror through transformation, mutation, or violation of the flesh.', ARRAY['horror', 'sci-fi'], 1, ARRAY[], ARRAY[]),
  ('war-story', 'War Story', 'Armed conflict and its cost, on the front or the home front.', ARRAY['historical'], 1, ARRAY['military'], ARRAY[]),
  ('coming-of-age', 'Coming of Age', 'A young protagonist grows up over the course of the story.', ARRAY['contemporary', 'historical'], 1, ARRAY['bildungsroman'], ARRAY[]),
  ('road-trip', 'Road Trip', 'The journey — literal miles — changes the travelers.', ARRAY['contemporary'], 1, ARRAY[], ARRAY[]),
  ('family-drama', 'Family Drama', 'Intergenerational conflict, inheritance, and old wounds.', ARRAY['contemporary', 'historical'], 1, ARRAY[], ARRAY[]),
  ('memoir', 'Memoir', 'A true personal life story, told by the one who lived it.', ARRAY['non-fiction'], 1, ARRAY[], ARRAY[]),
  ('true-crime', 'True Crime', 'Real criminal cases investigated and retold.', ARRAY['non-fiction', 'mystery-thriller'], 1, ARRAY[], ARRAY[])
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  genres = excluded.genres,
  version = excluded.version,
  aliases = excluded.aliases,
  exclusions = excluded.exclusions;
-- END GENERATED SEED


-- v157: live taxonomy. The shared `tropes` table is now the source of truth
-- at runtime (the app merges it over the bundled js/156-trope-taxonomy.js).
-- `taxonomy_meta` holds a single revision counter, bumped on every Trope Lab
-- approval; book_tropes rows stamp the rev they were inferred under so
-- Trope Lab can mark books stale when the taxonomy grows.
create table if not exists taxonomy_meta (
  id int primary key check (id = 1),
  rev int not null default 1,
  updated_at timestamptz not null default now()
);
alter table taxonomy_meta enable row level security;
insert into taxonomy_meta (id, rev) values (1, 1)
on conflict (id) do nothing;

drop policy if exists "taxonomy_meta: read for signed-in" on taxonomy_meta;
create policy "taxonomy_meta: read for signed-in"
  on taxonomy_meta for select to authenticated using (true);
drop policy if exists "taxonomy_meta: admin write" on taxonomy_meta;
create policy "taxonomy_meta: admin write"
  on taxonomy_meta for all to authenticated using (is_admin()) with check (is_admin());

alter table book_tropes
  add column if not exists taxonomy_rev int not null default 1;

-- v159: admins can read every user's books so Trope Lab can backfill all
-- libraries in one pass. (is_admin() comes from supabase/analytics.sql,
-- same as the taxonomy_meta policies above.)
drop policy if exists "admins read all books" on books;
create policy "admins read all books" on books
  for select using (is_admin());

-- v160: shared trope provider/model override. The admin picks the inference
-- provider + model in Trope Lab; the choice applies to all devices. An empty
-- row means "use the server env defaults". API keys stay server-side — the
-- proxy holds one key per provider (TROPE_KEY_<PROVIDER>) and the client
-- only names the provider.
create table if not exists trope_provider_settings (
  id int primary key check (id = 1),
  provider text not null default '',
  model text not null default '',
  updated_at timestamptz not null default now()
);
insert into trope_provider_settings (id, provider, model)
  values (1, '', '') on conflict (id) do nothing;

alter table trope_provider_settings enable row level security;

drop policy if exists "trope_provider_settings: signed-in read" on trope_provider_settings;
create policy "trope_provider_settings: signed-in read"
  on trope_provider_settings for select to authenticated using (true);

drop policy if exists "trope_provider_settings: admin write" on trope_provider_settings;
create policy "trope_provider_settings: admin write"
  on trope_provider_settings for all to authenticated using (is_admin()) with check (is_admin());
