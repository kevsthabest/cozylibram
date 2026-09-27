# Cozy Libram Roadmap

## v1.0 — "Share with loved ones" (private testers)
Goal: stable, no data loss, easy for non-technical family to pick up.
Target user: Kevin's wife (primary) + a handful of family/friend testers.

### Must-have: data safety & sync
- [x] **Deletion tombstones** (v33) — deletions propagate as tombstones
  (`deleted_books` table + per-user on-device set) instead of resurrecting.
- [x] **Password-reset UI** (v33) — "Forgot password?" on the gate sends a
  Supabase reset email; the link returns to the app with a new-password form.
- [ ] **First-login merge hardening** — the adopt-and-merge path works, but it
  needs a deliberate test pass (two devices, offline edits, then sign-in).

### Must-have: getting books in
- [x] **Bulk ISBN import** (v34) — new 📋 Bulk tab in Add: paste a stack of
  ISBNs, paced metacache-backed lookup, per-ISBN status, one-tap add to TBR.
- [x] **Unified import hub** (v34) — Settings → Backup → "Import from other
  apps": one file picker, format auto-detection (Goodreads CSV, StoryGraph
  CSV, plain ISBN lists), preview, deduped import. New sources are one
  registry entry.
- [x] **Bookmory import** (v44) — the `Database.bookmory` ZIP is read directly
  in the browser (dependency-free ZIP + inflate + SQLite readers): 189 books
  with statuses, ratings, page logs, favorites and tags; one binary-corrupted
  record ("Dungeon Crawler Carl") is reported by name for manual re-adding.
  Re-imports update in place via stable `bm-` ids; written reading memos are
  not in the export file.

### Should-have: tester onboarding
- [ ] **Supabase Site URL fix** — verification emails still link to
  `localhost:3000`. Set Site URL + Redirect URLs to the real app address
  (Kevin's task, ~5 min in the Supabase dashboard).
- [ ] **First-run welcome** — 2–3 swipeable slides (scan a barcode → shelves
  → roulette) so non-technical testers get the core loop immediately.

### Should-have: delight
- [ ] **Yearly reading goal** — "Read N books in 2026" with a progress ring
  in Stats. A BookTok staple, and a natural fit for a prolific reader.
- [ ] **Reading reminders (opt-in)** — gentle daily nudge; keep it optional
  and off by default.

### Stretch (only if time)
- [ ] Shared shelf view — see a loved one's shelf (read-only) without
  account switching. Only if testers ask for it; per-user libraries stay
  the default.

---

## Backburner — not started until v1.0 is comfortable
(Kevin's call; roadmap kept here so the direction isn't lost.)

### v1.1 — Public GitHub release (self-hosted, BYOK)
- [ ] Key-leak audit: `server-config.json` handling, `/config.js` exposure (gating removed 2026-09-26 — keep port off public internet)
  sharing, no tokens in client bundle or repo history.
- [ ] BYOK setup docs polish (README + `server-config.example.json`).
- [ ] `book_meta` becomes a per-instance shared cache — document it.
- [ ] Rate limiting / abuse notes for self-hosters.

### v1.2 — Hosted APK track
- [ ] Central hosting: API proxy holds keys server-side, one global
  `book_meta` cache for all APK users.
- [ ] Capacitor packaging: Google OAuth deep-link callbacks, camera/barcode
  in Android WebView, `localStorage`, service-worker review.
- [ ] Password-reset + email deep links working against the hosted domain.

### Future — App Store
- [ ] Premium features + in-app payments (entitlements validated server-side).
- [ ] Mood-based recommendation "sommelier".
- [ ] Monitoring, backups, production HTTPS/domain.

---

## Deliberately out of scope
- Social network features (follows, feeds) — this is a personal library app.
- Scraping retailer sites — affiliate/search links only.
