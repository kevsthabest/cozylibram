# Cloud sync setup (Supabase) — Spicy Shelves

Optional. The app works fully offline without this. Setting it up gives you
per-user login (email/password + Google) and long-term cloud storage of the
library, synced across devices.

## 1. Create a Supabase project

1. Go to https://supabase.com → **New project**.
2. Pick a name (e.g. `spicy-shelves`), a database password, and a region close to you.
3. Wait for the project to finish provisioning.

## 2. Create the tables

1. In the Supabase dashboard, open **SQL Editor** → **New query**.
2. Paste the contents of `schema.sql` (in this folder) and **Run**.
3. This creates:
   - a `books` table with one row per book per user, and a Row Level
     Security policy so each signed-in user can only read/write their own rows;
   - a `book_meta` table: a shared per-ISBN metadata cache (covers,
     descriptions, ratings, page counts) readable by every signed-in user,
     so the first person to look up a book pays the API cost and everyone
     after reads it from Supabase.
4. Re-running `schema.sql` later is safe — it only adds what's missing, so
   run it again after updating the app to pick up new tables.

## 3. Get your API credentials

1. Open **Project Settings → API**.
2. Copy the **Project URL** (looks like `https://xyzcompany.supabase.co`).
3. Copy the **anon public** key (the long `eyJ…` token). This key is designed to
   be public — it goes in the browser. Row Level Security protects the data.

## 4. Point the app at Supabase

In `server-config.json` on your PC, add `supabase_url` and `supabase_anon_key`
(see `server-config.example.json`). The server shares them with devices on your
home network only, via `/config.js`.

## 5. Email login (on by default)

Supabase enables email sign-up out of the box. If you want to require email
confirmation before first sign-in:

1. **Authentication → Providers → Email** → turn on **Confirm email**.

Without confirmation, new accounts sign in immediately.

> **Important:** confirmation emails link back to the **Site URL** below. If you
> leave it at the default `http://localhost:3000`, the link in the email won't
> open your app. Set the Site URL (step 6.3) even if you never use Google sign-in.

## 6. Google sign-in (optional)

1. In the Google Cloud Console, create an **OAuth client ID** (Web application)
   for your project. Under **Authorized redirect URIs**, add
   `https://<your-project-ref>.supabase.co/auth/v1/callback`
   (replace `<your-project-ref>` with the subdomain of your Supabase Project URL).
2. In Supabase: **Authentication → Providers → Google** → enable, paste the
   **Client ID** and **Client secret**, and **Save**.
3. **Authentication → URL Configuration**:
   - **Site URL:** your app's address, e.g. `http://192.168.1.10:8000`
     (use whatever address you actually open the app at).
   - **Redirect URLs:** add the same address (and `http://localhost:8000` if you
     test on the PC). Google OAuth only works on localhost or HTTPS — on plain
     `http://<lan-ip>` from a phone, use email/password instead; the app hides
     the Google button there automatically.

## 7. Test it

1. Open Spicy Shelves → you'll land on a **sign-in gate** (it only appears
   while signed out and only when the backend is configured).
2. **Create account**, then add a book on one device.
3. **Sign in** on another device → the book appears after the first sync.
4. **Sync now** forces a sync; the last-sync time shows under the account panel.
5. **Sign out** (Settings → Account) returns to the gate. Each user gets their
   own on-device library, so sharing one device between testers is safe.

## How syncing works

- Each book is one row, keyed by `(user_id, book_id)`.
- Changes merge by timestamp (`_mtime`): the newest edit wins, never a blind overwrite.
- On-device libraries are partitioned per user (`spicyshelves.library.v2.<uid>`);
  signing out clears the in-memory shelf and the next sign-in loads that user's
  own library. The old single-device library is adopted into the new per-user
  slot on first sign-in, never silently dropped.
- Signing in on a new device **pulls** your cloud library and merges it with
  whatever is on the device — nothing is ever silently deleted.
- "Delete everything" wipes the device library *and* your cloud rows.

## Resetting everything

To start over: delete all rows in the Supabase **Table Editor → books**, or drop
the table and re-run `schema.sql`.
