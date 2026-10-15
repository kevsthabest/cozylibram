# Marginalia — Spec

**Status:** Approved by the User (2026-10-15, from the wow-features brainstorm). One PR for Phase 1; the safety dependencies in §5 are ship-blockers, not follow-ups.
**Rubric snapshot:** Reader value — the book club that lives inside the book: friends' reactions find you exactly when you reach the moment, at your own pace. Brief-fit — pass (circle-only, opt-in by friendship, progress-gated so it can never spoil; no schedules, no pace data shown — the anti-book-club-pressure shape). Moat-fit — **high** (it monetizes the app's existing spoiler discipline: progress tracking + the content shield + key-only social architecture). Scope — **L**. Placement — **Free** (social core is free — standing constraint). Displaced surface — none; a new section on the book page.

## 1. What

Circle friends reading the same book leave short notes pinned to a point in the book. A note appears for you only when **your own logged progress** reaches it — so a margin note can never spoil you, and there's no schedule: each reader moves at their own pace, and the notes wait.

- **Writing.** From the book page: "Leave a note" — pinned at your current progress by default; you cannot pin a note beyond your own progress (anti-spoiler by construction). Cap 280 characters.
- **Position model.** Store the note's position as a **fraction of the book** (writer's page ÷ writer's pageCount), plus the writer's page number and edition pageCount. Same-edition readers see "p. 212"; other editions see "about a third in." Page numbers differ across editions; fractions don't lie.
- **Reading.** A Marginalia section on the book page lists unlocked notes in book order, margin-note styling, with author and position. Locked notes are invisible — not blurred, not counted (the spoiler-fix precedent: omitted, not teased). When you finish the book, all friends' notes for it unlock.
- **Whose notes.** Accepted circle friends only, who have the same canonical book (key-matched, the buddy-reads precedent). Unfriending hides notes in both directions.

## 2. Who

Pairs and circles reading the same book at different speeds — the exact shape buddy reads (v528) proved exists. This is what buddy reads grows into: presence becomes conversation.

## 3. Why now

User-approved from the wow brainstorm. Its foundations shipped in the last three days: progress tracking (live), buddy reads' key-only per-book grants (v528), block (v550), report (v246), the content shield (v524). This is the first feature that composes all of them.

## 4. Scope (Phase 1)

- Notes table + RLS in the established social pattern (key-only rows; renders from the viewer's own library copy).
- Write/read UI on the book page, fraction-based gating against the viewer's progress.
- Report on every note; block fully effective (a blocked user's notes never render, either direction).
- Content shield: notes on shielded books are held for shielded viewers exactly as other social surfaces hold them.
- Delete own note. (Editing: out — delete + repost keeps it simple and honest.)

## 5. Dependencies — ship-blockers

- **Report + block wired before the feature is visible to anyone** (the book-talk safety rule from the social gap review: moderation precedes conversation surfaces).
- Progress data (`b.progress` / `pageCount`) — live.
- Canonical book keys + friendship gating — live patterns from buddy reads.

## 6. Explicitly out of scope

- No public or follower-visible notes — circle only, ever, in v1.
- No reactions on notes, no threads/replies (Phase 2 candidates, decided after Phase 1 lives).
- No pace anything: no "Maya is ahead of you," no percentages of friends, no timestamps framed as speed.
- No notes on books the writer hasn't started (position ≤ their progress enforces this structurally).

## 7. Open questions

- Note visibility default within the circle: all friends with the book (recommend), or per-book opt-in per pair (safer, more friction)? Recommend all-friends-with-the-book for v1, with the shield + block as the safety net, and a per-user "Marginalia off" toggle in Circle & privacy settings.
- Retention: do notes persist after both readers finish? Recommend yes — they become the margin record of a shared read, deletable by the author anytime.
