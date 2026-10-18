# Audiobook percentage logging — spec

Status: APPROVED by the User 2026-10-17 (incl. §6 as recommended — history
unconverted). Build dispatched to the Data & Sync seat as implementation owner.
Origin: the User, 2026-10-16 — his partner listens via Hoopla, and audiobooks
have no meaningful "page" to log. Inputs settled by the User at intake:
direct % entry; % applies when format = audio; everything else unchanged.

## Behaviour

1. **Percent logging for audio.** When a book's format is `audio`, the
   progress-logging surface takes a percentage (0–100, direct numeric
   entry) instead of a page number. Page logging for every other format
   is untouched.
2. **Progress display.** An audiobook's progress shows as a percentage
   (bar + % label) wherever progress is displayed. Reaching 100% carries
   the same meaning as reaching the last page does today (finish flow,
   status transitions).
3. **Duration field.** A book gains an optional audio-length field
   (seconds, displayed as h/m). On metadata lookup it auto-fills from
   Hardcover's `audio_seconds` (present on book and edition records —
   verified 2026-10-16; Google Books / Open Library carry no duration).
   The field is hand-editable in the book modal — editions differ, and
   the listener's copy wins. No duration is ever required: % logging
   works fully without one.
4. **Time remaining.** When a duration is known and progress is below
   100%, surfaces that show progress may also show remaining listening
   time (duration × remaining %). Display only — no pace, deadline, or
   "on track" framing (standing no-timers doctrine).
5. **Storage.** Progress-log entries for audiobooks record percent.
   The representation (unit-tagged entry vs. parallel field) is the
   Data & Sync seat's call inside its seam — local-first, sync-safe,
   and round-tripping through the existing log shape without breaking
   older entries.
6. **History (recommendation — the User's call).** Existing page-based
   log entries on audiobooks are NOT converted or rewritten; they stand
   as recorded. A book's current progress derives from its latest log
   entry, whichever unit that entry used. New entries on an audiobook
   are % entries.

## Non-goals

- No playback integration, no listening-speed adjustment.
- No changes to page-based logging, stats, or streaks for other formats.
- No migration of historical entries (see §6).

## Open decisions for the User

1. §6 history treatment — recommended as written (no conversion).
2. Nothing else is open: entry is direct %, duration source is
   Hardcover, time-remaining is display-only. Build proceeds on the
   User's approval of this spec.
