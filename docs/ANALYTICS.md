# Cozy Libram — First-Party Analytics (v118)

**"We measure how Cozy Libram is used, not what is inside someone's library."**

This is native product analytics: ~47 high-level events that answer product
questions ("is anyone using Roulette?", "where do imports fail?"). It is not
surveillance — the event vocabulary is a closed allowlist and the properties
are enums and counts. There is structurally no way to send a title, author,
ISBN, rating value, note, shelf listing, or message through it.

## What is collected

Each event carries exactly: `event_name`, `event_category`, a small fixed set
of properties (below), `app_version`, and a timestamp. Nothing else.

| Event | Category | Properties |
|---|---|---|
| `book_added` | library | `source`: search · isbn · barcode · isbn_list · goodreads · storygraph · hardcover · bookmory · manual · recommendation · discovery |
| `book_removed` | library | — |
| `book_opened` | library | — |
| `book_edited` | library | — |
| `book_status_changed` | library | `from`, `to`: tbr · reading · read · dnf |
| `book_rated` | library | — (no rating value) |
| `book_favorited` / `book_unfavorited` | library | — |
| `book_completed` / `book_dnf` | library | — |
| `dnf_reason` | library | `reason`, `progress_pct` (v398: DNF Autopsy) |
| `dna_shared` / `wrapped_shared` | library | `books`; wrapped adds `year` (v398) |
| `search_performed` | discovery | — |
| `discover_opened` | discovery | — |
| `author_discovery_opened` | discovery | — |
| `similar_books_opened` | discovery | — |
| `release_discovery_opened` | discovery | — |
| `release_auto_check` | discovery | `book_count` (v149: silent weekly sweep) |
| `provider_used` | discovery | `provider`, `context` (v243: metadata backend) |
| `book_preview_opened` / `preview_tbr` / `preview_wishlist` | discovery | `source`; opened adds `kind` (v219: read-only preview) |
| `recommendation_opened` | discovery | `source`: coven |
| `roulette_opened` / `roulette_spun` / `roulette_book_opened` / `roulette_book_started` | discovery | — |
| `import_started` / `import_completed` / `import_failed` | import | `source` (same list as `book_added`); `book_count` on completed |
| `rating_axis_used` | rating | `axis`: spice · scare · suspense · adventure (no rating value) |
| `coven_opened` | social | — |
| `friend_request_sent` / `friend_request_accepted` | social | — |
| `shared_shelf_viewed` | social | — |
| `friend_recommendation_used` | social | — |
| `invite_link_shared` | social | — (v240: invite sheet / clipboard) |
| `account_created` | onboarding | — |
| `onboarding_started` / `onboarding_completed` / `onboarding_skipped` | onboarding | — |
| `library_opened` | onboarding | once ever |
| `first_book_added` / `first_book_rated` | onboarding | once ever |
| `returned_within_7_days` | onboarding | once ever |
| `session_started` | session | powers active-today/week/month |

### Deliberate omissions (spec adaptations)

- **No `buddy_read_created` / `buddy_read_joined`.** Buddy reads in this app
  are a computed display (shared TBRs), not an actionable create/join flow —
  the spec says not to invent events for workflows that don't exist.
- **No `wishlist` addition source.** Wishlist is a flag books carry after
  being added elsewhere, not a creation flow.
- **Roulette funnel's final stage is `roulette_book_started`** (the real
  "Start reading" action), not "added to TBR" — roulette only picks from
  books already on the TBR.
- **`account_created` misses Google-OAuth signups** (signup and sign-in are
  indistinguishable in that redirect flow). Email/password signups are
  captured via a pending flag consumed on first `enterApp()`.

## What is NEVER collected

Book titles, authors, ISBNs, cover URLs, descriptions, tropes, genres,
specific rating values, shelf contents, recommendation text, notes, quotes,
private messages, friend names, IP addresses, device fingerprints. The
property allowlist in `js/065-analytics.js` (`EVENT_DEFS` + `PROP_VALUES`)
strips anything not explicitly declared — including anything a future
developer might naively pass.

## How it works

- `track(eventName, props?, opts?)` in `js/065-analytics.js`. Safe to call
  anywhere: unknown events are dropped, failures are silent, it never throws.
- Only signed-in users emit events; guests emit nothing (no anonymous
  attribution). The Settings → Privacy toggle ("Usage analytics") opts out
  entirely and clears the queued events.
- Events batch in memory (flush every 15 s or 50 events), persist per-user in
  `localStorage` while offline, and upload via the Supabase client when
  connectivity returns. Failed uploads requeue with a 5-minute backoff so a
  broken pipeline can't spin the network or lose events.
- `trackOnce(flag, event, props)` fires at most once ever per user (onboarding
  funnel). `initAnalyticsFlags()` seeds those flags from existing state so
  long-time users don't pollute funnels.
- Frequent UI re-renders use `opts.dedupeKey` (default 8 s window) so one
  logical action records one event.

## Adding a new event

1. Ask the spec's question first: *does this answer a specific product
   question?* If not, don't track it. (~45–50 events is the target; don't
   instrument every click.)
2. Add it to `EVENT_DEFS` in `js/065-analytics.js` with a category and the
   minimal property keys. Property values must be enums in `PROP_VALUES` or
   numeric counts — never free text about books.
3. Call `track('your_event', { … })` at the action site. Wrap nothing; it
   can't throw.
4. Add the event to the table above and to `.test/analytics.test.js`.

## Supabase setup

1. Run `supabase/schema.sql` (if not already), then `supabase/analytics.sql`
   in the SQL editor. Both are re-run safe.
2. Register yourself as admin:
   ```sql
   insert into app_admins (user_id)
   select id from auth.users where email = 'you@example.com';
   ```
3. Security model (enforced server-side, never client-side):
   - `is_admin()` is a `SECURITY DEFINER` function reading `app_admins`.
   - Users may **insert only their own** events (`auth.uid() = user_id`).
   - Users have **no select/update/delete** on analytics.
   - Admins may **select** all events (the Observatory dashboard).
   - `app_admins` is readable only by admins; the registry is managed from
     the SQL editor, never from the client.

## Offline behavior

Events queue in `localStorage` (per user, cap 500) and upload on the next
flush once online. The app works identically offline — analytics failure
never blocks adding/editing books, statuses, imports, sync, auth, or offline
use. (Covered by tests: offline flush, failed-upload requeue + cooldown.)

## The Libram Observatory (v119)

The dashboard lives in the app at `/#admin` (account menu → **Observatory**,
admins only). It shows, for the selected date range:

- **Overview**: active users, new signups, books added/completed/rated,
  favorites, discovery uses, total events.
- **Feature usage**: per-event users, uses, and adoption % (users ÷ active
  users in the range).
- **Funnels**: roulette (opened → spun → pick opened → pick started),
  onboarding (account → library → first book → first rating → returned),
  imports (started → completed, with failures as the leak).
- **Import sources** (started/completed/failed + books) and **book-add
  sources**.
- **User activity**: truncated account IDs (first 8 characters — still linked to accounts, shown short for readability), last active, event
  count, top area — activity only, never library contents.

Aggregation is client-side over a capped raw fetch (20,000 most recent
events). `aggregateAnalytics()` is pure and fully tested in
`.test/admin.test.js`.

## Interpreting the data

- **Active users**: distinct `user_id`s with `session_started` in the window.
- **Feature adoption**: distinct users per `event_name` ÷ total active users.
- **Funnels**: `roulette_opened → roulette_spun → roulette_book_opened →
  roulette_book_started`; onboarding `account_created → library_opened →
  first_book_added → first_book_rated → returned_within_7_days`; imports
  `import_started → import_completed` (with `import_failed` as the leak).
- **Sources**: `book_added` grouped by `source`; `import_completed` by
  `source` with `book_count` summed.
- The dashboard is about **feature usage, not reading surveillance**. Never
  join analytics against library content to reconstruct what someone reads.
