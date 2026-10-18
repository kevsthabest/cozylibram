# Contributing — the agent-team protocol

## Purpose

This document is the canonical statement of how the agent team coordinates
across its two repos: the Cozy Libram PWA (this repo,
`kevsthabest/cozylibram`) and the ebook-processor repo (a sibling repo).
It is the in-repo copy of the protocol, landed under the Repo Legibility
Standard ([docs/repo-legibility-spec.md](docs/repo-legibility-spec.md)
§11, Q3 — ruled 2026-10-17). Working copies of the team's playbooks
("skills") live in the team's workspace and point here; where a working
copy and this document differ on the protocol, this document governs.

The User sets scope and policy; merges run on gates, not on per-PR approval
(the merge model below — Decision, 2026-10-15; the 👍-to-merge rule is
retired).

Nothing here overrides an explicit instruction from the User in the
current task.

## Merge model — Decision, 2026-10-15 (👍-to-merge retired)

**A PR merges when the gates pass.** No per-PR approval from the User and
no 👍 is required or waited for. The gates:

- Tests at or above the repo's CONSTRAINTS baseline — constraints HELD
  (see [CONSTRAINTS.md](CONSTRAINTS.md)).
- Security Advisor verdict **PASS**, or **PASS_WITH_RISK** with the risk
  documented in the PR body and in the shipped report.
- **Feature PRs** additionally require an approved spec / work order to
  exist before build. Gates alone never authorize inventing a feature.

After merge: push → verify on the live URL (the served version string) →
batched shipped report (the release bars, below). The Advisor's verdict is
the merge authority; the Advisor never reviews its own implementation.

**Still stops for the User** (unchanged): migrations / schema changes;
data-affecting writes; product-policy changes; parked tracks; unresolved
Blocker/High findings; judgment calls on correct behaviour; anything an
agent cannot confidently classify. When in doubt, ask the User (one
question) rather than guessing.

## Stack policy — Decision, 2026-10-16 (restriction retired)

The old no-frameworks / no-build-step / no-new-dependencies restriction is
RETIRED. Frameworks, packages, build tooling, TypeScript, and ES modules
are all available when they unlock a capability the current stack can't
deliver — the case to make is the capability, not the fashion. Rails that
stay: (1) adopting a framework or a build step for the production app is a
per-proposal decision the User approves (big-move rule), proven in a fork
first, never straight to prod; (2) packages for incremental needs go
through the normal gates (tests + Advisor); (3) offline is a resilience
requirement, not a hosting ban (refined by the User, 2026-10-16): the core
loop (library, shelves, tracking) must work fully offline — everything
user-generated (page progress, starting a book, edits) is local-first and
resyncs when the connection returns — and any feature may use hosted
services or scripts when the capability requires it — provided a lost
connection degrades it to a clean unavailable state and never breaks the
core app; occasional hiccups are the design case. Core-path code still
ships vendored or bundled; (4) the auto-ship bug lane below still excludes
new dependencies — that is lane scope, not a stack ban. The ES-modules
fork is the standing pilot for module adoption; its pilot-only status is
unchanged until the User rules on a specific proposal.

## Roles

Build/review roles: **Builder** (one per repo), **Security Advisor**,
**UX Tester**, **Docs agent**, **UI Designer**, **Codebase Reviewer**,
**Data & Sync Engineer**, plus scheduled reviewers (QA scout, security
digest, PM digest, docs sweep, code-practices). The two planning roles
never build:

**Product Strategist** — recommends; the User picks; the Builder builds.

- *Standing inputs:* the product brief, the parked list, the business
  plan, and `GLOSSARY.md`. Coordinators do not re-paste these into
  briefs — the Strategist reads them from source.
- *Output contract:* ranked feature lists, each item carrying scope
  (S/M/L) and a free/premium placement; spec docs the Builder can consume
  directly; explicit rulings on questions put to it. No code, no PRs.

**Business Project Manager** — owns the commercialization record, kept in
the team's workspace (decisions log, open-questions file, dormant
rollout checklist).

- *Standing inputs:* the decisions log, the open-questions file, the
  dormant rollout checklist.
- *Output contract:* every User decision is logged the same day it lands,
  and the plan doc's affected sections are reconciled in the same
  session — a decision that exists only in the log while the plan says
  otherwise is unfinished work. Plans, never builds; pricing decisions
  are the User's.

**Tech Lead / Architect** — the coordinator role. Plans the smallest sound
change; owns work orders (outcome, scope/non-goals, invariants, acceptance
criteria, affected files, rollback notes), file ownership per task, and
reviewer routing. Escalates trade-offs that change product policy or data
semantics to the User. May not waive security findings, expand scope, or
self-review high-risk work.

**Feature Engineer** — Builder subagents working under the Tech Lead.
Implements the assigned work order at the smallest coherent diff:
feature/UI behaviour, loading/empty/error states, focused tests, and the
handoff packet. States its understanding and acceptance criteria before
editing; no unrelated cleanup, ever. May not change schema, RLS, auth,
storage contracts, service-worker strategy, or dependencies on its own —
those route to Data & Sync and/or the Advisor.

**Data & Sync Engineer** — first-class role with its own standing seat
(Decision, 2026-10-15).

- *Mission:* protect correctness, ownership, and recoverability across
  IndexedDB, sync, and account slots — the app's highest-risk surface
  (the depollution incident —
  [docs/incidents/2026-10-15-depollute.md](docs/incidents/2026-10-15-depollute.md) —
  cross-slot leakage, and tombstone propagation all live here).
- *Owns:* library state and its sanctioned seams (`replaceLibrary()` /
  `clearLibrary()`), Proxy dirty tracking, tombstones, the up-next queue,
  slot lifecycle, migration drafting, and conflict semantics.
- *Rules:* candidate data is loaded, validated, migrated, and sanitized
  off to the side and published only on success — a failed load leaves
  the previous slot intact. Never retain book objects across an `await`:
  use stable IDs plus a slot/generation check and resolve the current
  object at commit time. Persisted-shape or conflict-semantics changes
  are named decisions, never silent.
- *Required tests per change:* failed load preserves the old slot; no
  cross-slot dirty/tombstone leakage; late async work cannot write to
  the wrong slot; sanitization never bypassed or double-wrapped; retries
  and duplicate IDs safe.
- *Gates:* Security Advisor review mandatory for authorization,
  ownership, RLS, or trust-boundary changes; QA browser verification
  mandatory for slot switching, IndexedDB, offline, and
  service-worker-sensitive work.

**UI Designer (Product & UX)** — standing checklist for every design
judgement, the five product tests: (1) Does it make reading feel like a
chore? (2) Would a reader feel watched, scored, or compared? (3) Does it
help someone understand a book, or only count it? (4) Does it ask readers
to do work the app could do itself? (5) Does it preserve trust even when
trust conflicts with engagement?

## Auto-ship lane (bug fixes) — standing approval, 2026-10-10

Bug fixes do NOT wait for the User's per-item approval. (Since 2026-10-15
the lane's merge step simply matches the general merge model above; the
lane's operations and narrow qualification are unchanged.) Flow:

1. Reviewer (QA scout, UX Tester, security digest) files the finding →
   Builder auto-claims it. No "please fix" round-trip.
2. Builder fixes on `agent/builder/<ticket>`; tests green
   (verify-before-done).
3. Security Advisor reviews the diff — automated gate, not a human wait.
   PASS / PASS_WITH_RISK proceeds; BLOCKED stops the lane and escalates
   to the User.
4. Merge to main via PR (green), push, verify on the live URL
   (the Cozy Libram release bar).
5. Terse shipped-report to the User; batch several together when they
   land together.

**Qualifies as a bug fix** — all must hold:

- Restores intended behavior: matches docs, an approved spec, or behavior
  before a regression. No new features, no new UI, no behavior change
  beyond the fix itself.
- No database migrations / schema changes. No new dependencies.
- Diff stays small and reviewable.

**Still needs the User's explicit approval** (never auto-ships):

- The "correct" behavior is a judgment call (design / product decision).
- Irreversible or data-affecting: migrations, bulk data changes, deletes.
- Anything the Builder cannot confidently classify as a pure bug fix —
  when in doubt, ask the User (one question) rather than guessing.

**Remediation-batch exception.** A batch that carries migrations or other
data-affecting changes may ship on the bug-fix lane only under one
explicit blanket approval from the User naming the batch's scope (e.g.
"fix everything in Batches A–E"). The Security Advisor gate still applies
per batch; a batch outside the named scope, or one with no blanket
approval, follows the normal approval path.

**Release bars** — each repo has one, and "shipped" means its bar was met:

- *Cozy Libram:* tests green → commit → push → verified on the live URL,
  including the served version string.
- *Ebook processor:* there is no live URL. The gate is **preview
  validation on the User's PC** (preview plan read before any write),
  suite counts quoted in the report, Security Advisor PASS, then
  fast-forward merge to master and push. Processor work never borrows
  the PWA's "live URL" step.

## Manager delegation — standing approval, 2026-10-10

Each role agent (Builder, Security Advisor, UX Tester, UI Designer, Docs
reviewer) is the *manager* of its own team. When a work order arrives —
from an agent-team cron or directly from the User — the manager may break
it into a plan and delegate chunks to subagents, staffing as many as the
task responsibly requires.

**Responsible delegation:**

- The manager stays accountable for the whole work order's Definition of
  Done. A subagent's completion report is a claim, not a result — the
  manager verifies the integration (tests, diff review) before reporting
  done.
- One level deep only: a manager's subagents cannot spawn their own
  (platform nesting limit). If a chunk needs further splitting, the
  manager re-plans and spawns fresh.
- Claim-before-touch, one branch per task, and worktrees apply *between*
  the manager's subagents exactly as between roles. Subagents never touch
  another role's active claim.
- Fan out only on truly independent chunks; keep it lean when the work is
  sequential. Delegate to parallelize or specialize — never to avoid
  thinking through the plan. (The User flags friction if usage spikes.)
- Give each subagent a self-contained brief: goal, files, constraints,
  done-criteria — plus the relevant playbook pointers for its chunk (a
  fix chunk gets verify-before-done, a review chunk gets code-review,
  etc.). Subagents inherit the mission, not the whole transcript.
- Loop caps hold: max 3 review→fix rounds per item, then escalate.

## Workflow

1. **Claim before touch.** Before editing code, announce: branch name +
   exact files/directories owned for this task. Never edit files under
   another agent's active claim. Never merge to main outside a PR:
   merges run on the merge model's gates (tests at baseline, Advisor
   PASS or documented PASS_WITH_RISK; feature PRs only behind an
   approved spec/work order) — no 👍 is required. Pull/fetch before
   reading shared state.
2. **One branch per task.** `agent/<role>/<ticket>` (e.g.
   `agent/builder/shelf-3d-v2`). Merges serialize — one branch at a
   time: rebase onto current main, run the test suite, merge via PR when
   green. Sharing a branch: `git pull --rebase` before committing, push
   immediately after, atomic commits that leave tests passing,
   `git add` specific files only (never `git add -A`); on rebase
   conflict, report back — never force-push.
3. **Parallel agents use worktrees.** `git worktree add
   ../<repo>-<task> -b agent/<role>/<ticket>`; never two agents in one
   working directory. Each worktree needs its own untracked setup
   (node_modules, .env, server-config). Delete the worktree after merge.
   Under jj, workspaces are the mechanism; see the Jujutsu subsection at
   the end of this section.
4. **Definition of Done** — no agent reports complete until every box
   ticks: acceptance criteria met; scope stayed in bounds (no silent
   additions); tests added/updated and executed, with evidence; the
   exact touched code path was exercised; lint/typecheck/build pass (or
   skipped with reason + residual risk); residual risks listed; final
   verdict clear (done / done-with-risk / blocked).
   **Completion integrity:** a completion report is a claim, not a
   result — the receiving manager verifies the deliverable exists
   before accepting it: the branch and PR (or the merged commit), the
   named files, the live version string. A report whose deliverable
   cannot be found is not done, whatever it says.
5. **Handoff note.** End every task with: decisions + rationale
   ("chose X because Y; considered Z, rejected for W"), work that must
   NOT be redone, open items + blockers, next steps with file paths and
   verification commands — grounded in `git status` / `git diff --stat`,
   never from memory. The next agent reads the handoff, not the
   transcript. The full executable-handoff format (verification
   predicates the receiver runs first) lives in the workspace playbook
   library (session-handoff).
6. **No unapproved scope.** Implement exactly the approved work order.
   Anything beyond scope goes under "Proposals" in the handoff note —
   never into code.

### Working interface: Jujutsu (jj) — Decision, 2026-10-18

The agent team's working interface for this repo is jj, colocated with
git. Git and GitHub remain the substrate: a bookmark is an ordinary git
branch, a push is ordinary git history, PRs and merges run through gh
exactly as before, and a plain-git clone (the User's Windows clone) is
unaffected. One driver per working copy: a copy driven by jj is not
written by git commands, and a copy driven by git is not written by jj
commands.

The mapping from this section's git-shaped steps:

| Step | Under jj |
|---|---|
| Task claim | A bookmark named exactly as the branch would be (`agent/<role>/<ticket>`), announced the same way |
| Parallel work | `jj workspace add` to create, `jj workspace forget` to remove — forget also removes the colocated git worktree — instead of `git worktree add` / remove |
| Committing | Edit, then `jj describe`: the working copy is the change, and there is no staging |
| Sharing / syncing | `jj git fetch`, then `jj rebase` onto the fetched state, before `jj git push` |
| Branch deletion after merge | `jj bookmark delete`, then `jj git push --deleted` |
| Merges | gh, unchanged |

**Pilot rules** — findings from the jj pilot (PR #320):

- **Scratch.** jj snapshots everything that is not gitignored, without
  being asked. `jj st` before `jj describe` and before `jj git push`
  is a required step. Scratch directories are gitignored and never
  pushed; this amendment adds `.work/` to `.gitignore`.
- **Citations.** In-flight work is cited by change ID: a change's
  commit SHA mutates every time the change is edited. SHAs are cited
  only for pushed or merged state.
- **Gates bind to origin refs.** A gate reviews the pushed bookmark /
  branch and the PR — never the current state of a workspace
  directory.
- **Translation.** The git-shaped instructions elsewhere in this
  document ("`git add` specific files only", "`git pull --rebase`
  before committing") state intent. Under jj they read as: only the
  intended files are in the change when it is described and pushed
  (check `jj st` / `jj diff`; `jj split` when a change mixes
  concerns), and a shared bookmark is fetched and rebased before it
  is pushed.
- **Basing.** `jj git fetch` does not advance the local `main`
  bookmark. After a fetch, base new workspaces on `main@origin` — or
  confirm local `main` matches `main@origin` — before basing: a
  workspace based on a stale bookmark builds and tests a stale tree.

Where jj and this document disagree, this document governs until
amended. Amendments are named decisions in their own PRs, as this one
is.

## Output Contract

Completion reports carry: verdict (done / done-with-risk / blocked),
commit SHA + files changed, test evidence, residual risks, handoff note
location. Keep reports terse; link commits instead of pasting logs.

## Operating Rules

- Max 3 review→fix rounds per item, then escalate to the User with the
  disagreement summarized. No agent-to-agent reply loops.
- Never revert, rewrite, or "clean up" another agent's committed work
  without the User's explicit approval — conflicting edits get reported,
  not resolved unilaterally.
- Security Advisor verdicts: PASS / PASS_WITH_RISK / BLOCKED, with
  evidence per item. CI-green plus the Builder's own say-so is never
  enough to merge. The implementer never attests its own work.
- UX Tester verdicts: CONFIRMED FIXED / STILL BROKEN / CANNOT REPRODUCE,
  each with evidence of what was checked.
- Reviewers (QA scout, code-practices, security digest, PM digest):
  report only, never modify code; deduplicate against all previously
  seen findings, including rejected ones; surface only what changes
  runtime behavior or blocks development.

## Findings intake & escalation

Findings arrive from many roles; the User reads one record, not five
versions of it.

- **One canonical finding, one owner.** The same defect found by the QA
  scout, the Codebase Reviewer, and the security digest is one finding
  with one owning role. Severities **merge** to the highest supported by
  evidence — they never stack into multiple items.
- **Dismissed stays dismissed — across roles.** A finding the User or
  the Advisor dismissed is dead for every role's ledger, not just the
  ledger of the role that filed it. It resurfaces only with new
  evidence, cited.
- **Filed-finding verification.** Before triage or any build spawns, a
  finding must carry verifiable coordinates: a named file plus the value
  observed, or a table plus the query that produced the claim.
  DB-derived findings additionally require a marker-checked connection
  (the verification preamble in the workspace Supabase playbook). Triage
  re-checks the named artefact firsthand before routing — a finding that
  doesn't reproduce at its coordinates is returned, not built.
- **Conflicting verdicts: evidence decides the fact.** Hierarchy: a live
  production read outranks a session output, which outranks
  recollection. The coordinator arbitrates *presentation* — what reaches
  the User, and whether it is marked verified or disputed — never the
  fact itself.
- **Relay fidelity.** Figures are quoted from a named artefact (a file,
  a query output, a preview JSON), never restated from memory; numbers
  mutate across paraphrase. A correction replaces the original in the
  same thread — it is not filed three chats later as a new claim.
- **Incident-class findings spawn a postmortem.** A finding whose shape
  is an incident — production data loss or corruption, a wrong-source
  verification that reached a decision, a security breach or
  near-breach — is not closed by its fix. The owning role flags it
  incident-class at intake and the coordinator commissions a postmortem
  (per the workspace postmortem playbook) once the fix ships; the User
  sees the postmortem, not just the fix report. (Added 2026-10-16: the
  postmortem playbook's textbook triggers had fired twice with nobody
  invoking it — this line is the trigger.) Incident summaries live
  in-repo under [docs/incidents/](docs/incidents/); full postmortems
  stay in the workspace (Legibility Standard §11, Q4).

## Required reading by role

A role's brief points here; the role reads its list in full before its
first work order, and re-reads a playbook when told it changed. The
playbooks themselves live in the workspace skill library; this list is
the canonical assignment of which playbooks each role reads.

- **Builders:** agent-team, ship-pipeline, verify-before-done,
  test-driven-development, constraint-driven — plus their repo's
  playbooks (Cozy Libram: supabase; processor: the quality-loop
  playbooks).
- **Security Advisor:** security-reviewer, code-review,
  constraint-driven, doubt-driven, blast-radius, supabase.
- **UX Tester:** webapp-testing, pair-verification.
- **UI Designer:** frontend-design, prototype, performance-optimization,
  design-production.
- **Product Strategist:** research, grill-me, product-strategy,
  domain-modeling.
- **Business Project Manager:** business-upkeep, research,
  session-handoff.
- **Trope Review Agent:** trope-review, supabase.
- **Codebase Reviewer:** security-reviewer, improve-architecture,
  blast-radius, codebase-sweep.
- **Data & Sync Engineer:** agent-team, supabase, constraint-driven,
  security-reviewer, pair-verification.

## Red-team rounds — standing approval, 2026-10-11

For consequential decisions, one structured dissent round runs *before*
build. Consequential = architecture or data-model changes, release
decisions, subjective design directions, anything the User flags with
"red-team this". Never for the auto-ship bug-fix lane or trivial calls —
speed matters there.

1. The manager writes the proposal down (what + why + alternatives
   considered) — a red-team needs a target.
2. The manager spawns ONE red-team subagent with a self-contained brief:
   the proposal, the relevant context, and one instruction: "kill this
   plan. Find the strongest objections, failure modes, and cheaper
   alternatives. Steelman the case against — do not be agreeable."
3. Exactly one round, time-boxed. The red-team reports objections with
   *evidence* (files, docs, precedents, measured trade-offs) — vibes
   don't count. It critiques; it never implements.
4. The manager rules: proceed / amend / drop, with the rationale in the
   handoff note. The User overrules everything.
5. One round per decision by default. A second round only if the first
   materially changed the proposal.

**Design critique** (same mechanism, applied to the UI Designer):

- Subjective design calls ship with ≥2 divergent variants, never one —
  selection pressure beats single-shot taste.
- Before handoff, a critique pass scores each variant against the
  frontend-design quality bar (hierarchy, spacing, states, a11y,
  mobile-first) plus the User's taste notes, and names what to cut.
  Praise without cuts is a failed critique.
- Check the inspiration library (kept in the workspace) before exploring
  a new direction.

## Anti-rationalizations

| The excuse | The rebuttal |
|---|---|
| "Nobody else is working right now, I can skip the claim." | Claim-before-touch is cheap exactly when it's unnecessary — and it's the only thing that makes parallel work safe when it suddenly isn't. |
| "This tiny extra fix is basically part of the task." | Unapproved scope is unapproved, however tiny. File it, or ask. Small silent extras are how diffs become unreadable. |
| "The other agent's approach was wrong, so I redid it." | No agent undoes another's work without the User's approval. Disagree in the handoff; the User disposes. |
| "A handoff note is overhead, the code speaks for itself." | Code shows what changed, never what was decided, rejected, or left open. The next agent pays for your saved five minutes. |
| "One more review round will make it perfect." | Loop caps exist because round four finds opinions, not defects. Hit the cap, escalate to the User with what's unresolved. |
| "It's just a bug fix, the auto-ship lane covers it." | The lane covers the narrow definition: restores intended behaviour, no new UI, no migrations, no new deps, small diff. Can't classify it confidently? It's not in the lane — ask. |
| "The other reviewer already filed this, but ours is worded differently, so it counts separately." | One canonical finding, one owner, severities merged. A second wording is a duplicate, and duplicates reaching the User are noise the intake rules exist to stop. |
| "I remember the figure from the other chat — close enough." | Relay fidelity: figures come from a named artefact or they don't travel. Memory-paraphrased numbers are how a withdrawn claim outlives its correction. |
| "The subagent reported done, so the work order is done." | A completion report is a claim. Verify the deliverable exists — branch, PR, file, live version string — before the work order closes. |

## Workspace seating & pointers

The protocol above is stated in full; the machinery that seats it lives
in the team's workspace and is only summarized here:

- Each role is a standing agent in the workspace, coordinated through
  the coordinator (Tech Lead) seat; scheduled reviewers run on a
  calendar (weekly QA scout, monthly digests and sweeps). Per-role chat
  identities, workspace paths, and cron definitions are operational
  detail kept in the workspace, not in this repo.
- The playbook library ("skills") lives in the workspace. Playbooks
  carry their own procedures; the agent-team playbook is this
  document's working copy and reduces to a pointer here.
- Connector docs for external services are discovered through the
  platform's connector search; they are not kept in this repo.
- The commercialization record (Business Project Manager's standing
  inputs and plan) lives in the workspace.

*Canonical copy landed 2026-10-17 under the Repo Legibility Standard
programme (spec §11, Q3 ruling). Amendments to the protocol are named
decisions: they change this document in their own reviewed PR, with the
reason stated.*
