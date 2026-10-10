# Hand-Test Checklist — Harness Gaps (v399)

These areas are unreachable in jsdom and must be verified manually on a real device.
Generated from QA Scout finding #10 (2026-10-10).

## v398 Shareable Canvas Cards

### Reading DNA card (js/212-dna.js)
- [ ] Open Stats tab → "Share my DNA" button renders
- [ ] Tap → share sheet opens (or image downloads on desktop)
- [ ] Card shows: top 5 tropes, spice bar, top 3 genres, page count, streak, top author
- [ ] Card is 1080×1920, readable text, no overflow
- [ ] With 0 read books → toast "Read some books first!" (no crash)

### Reading Wrapped card (js/214-wrapped.js)
- [ ] In December/January → banner "Your YYYY Reading Wrapped is ready!" appears
- [ ] Tap "View" → navigates to stats, wrapped view opens
- [ ] Dismiss (✕) → banner doesn't reappear (localStorage flag)
- [ ] "Share my YYYY Wrapped" → share sheet with 1080×1920 card
- [ ] Card shows: book count, pages, hours, year tropes, spice, genres, streak, 5-stars, DNFs
- [ ] With <3 books in year → no banner (not meaningful)

### Web Share API fallback
- [ ] On device without Web Share → image downloads as PNG
- [ ] On device with Web Share → native share sheet with file

## DNF Autopsy (js/213-dnf.js)

- [ ] Mark book DNF via shelf row → bottom sheet appears after ~350ms
- [ ] Sheet shows 6 reason buttons (Too slow, Hated trope, Wrong mood, Writing style, Characters, Too long)
- [ ] Tap reason → toast confirms, sheet closes
- [ ] Tap Skip → sheet closes, no reason stored
- [ ] Tap outside sheet → sheet closes
- [ ] Android back button → sheet closes (overlay history)
- [ ] Rapid double-tap DNF → only one sheet (dedup)
- [ ] Close modal within 350ms → no sheet appears
- [ ] Change status away from DNF within 350ms → no reason stamped
- [ ] Stats tab → DNF insights appear after 3+ tracked DNFs
- [ ] Supabase: dnf_reasons row created (check via sb-query)

## RLS Fail-Open Behavior

### Banned users
- [ ] Ban a user via Observatory → they get 403 on next /api/* call
- [ ] Banned user sees appropriate message (not a crash)
- [ ] Unban → access restored

### dnf_reasons RLS
- [ ] User A cannot read User B's dnf_reasons (SELECT returns 0 rows)
- [ ] User A cannot insert with different user_id (RLS blocks)
- [ ] Admin can read all (via is_admin())

### Covers bucket RLS
- [ ] Public can read covers bucket objects (no auth)
- [ ] Anonymous cannot write to covers bucket (service key only)
- [ ] Canonical URLs work offline after caching

## Service Worker Cache Bumps

- [ ] After deploy, hard refresh → sw.js has new CACHE name
- [ ] Old cache deleted, new assets fetched
- [ ] Cover images load from bucket (not opaque)
- [ ] Offline mode: cached covers render

## Canvas Card Visual Regression

Compare against previous version screenshots:
- [ ] DNA card layout matches (header, spice bar, tropes, genres, stats, footer)
- [ ] Wrapped card layout matches (hero numbers, tropes, spice, genres, fun stats)
- [ ] Year-in-Books card unchanged (170-stats.js, not refactored)
- [ ] Book card unchanged (170-stats.js, not refactored)

---

*Check off each item during UX Tester verification post-deploy.*
*File issues for any failures in the Security Advisor chat.*
