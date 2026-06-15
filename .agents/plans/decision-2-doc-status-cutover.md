# Plan: Decision 2 — Doc-Status Authority Cutover
Created: 2026-06-15
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-15T17:18:27.021Z
Branch: rad/decision-2-doc-status-cutover

## Context
The harness gate (`state.gate('approved')`) is already a pure fold over the event
log — Decision 1 shipped with the approve CLI (`gates.js`/`git-state-store.js`,
verified 2026-06-15). But the **prose** approval gate still reads the plan-doc
`Status:` header: `scripts/check-plan-approved.sh` greps `Status: approved` from a
branch tip, and `/rad-deliver` Step 2 gates on it. That makes the doc a second
source of approval truth alongside the event log. This plan moves the gate's
authority entirely onto the event log via a read-only `gate` query verb, rewrites
`check-plan-approved.sh` to use it, and **demotes** the plan-doc `Status:` write to
display-only (kept for human readability and `rad status`; never read by a gate).

## Scope
| In scope | Out of scope |
|---|---|
| Add a read-only `gate` query CLI verb backed by the existing pure-fold `state.gate()` | The harness gate / `gates.js` / `recordApproval` (Decision 1 — already done, do not touch) |
| Rewrite `check-plan-approved.sh` to gate on the event log, not the doc `Status:` | Removing the `writePlanStatus` doc-write (architect chose: keep it, display-only) |
| Mark the plan-doc `Status:` write display-only; update prose + docs to name events.jsonl as sole authority | Teaching `rad-status.sh` to fold the event log (not needed while the doc-write stays) |
| Tests for the new verb and the rewritten gate script | `/rad-deliver` Step 5/9 manual `Status:` markdown edits (remain as prose orchestration) |

## Acceptance Criteria
1. A read-only `gate` CLI verb exists: `node harness/cli.js gate <feature> approved`
   evaluates the approved gate purely over the event log, prints a structured
   result line, exits 0 when satisfied and non-zero otherwise, and writes nothing.
2. `check-plan-approved.sh` determines approval from the **event log** (the approved
   event's frozen `role`), not the plan-doc `Status:` header: a plan whose doc says
   `Status: approved` but has no approved event FAILS the gate, and a plan with an
   approved event but a stale/absent doc `Status:` PASSES.
3. The gate resolves the event log from the **branch tip** (the same branch-resolution
   sources `check-plan-approved.sh` uses today), so it works before the work branch
   is checked out — preserving `/rad-deliver` Step 2's existing call site and arguments.
4. `approveCommand` still writes the plan-doc `Status:` header (display-only); no code
   on the gate path reads it, and the in-repo annotation states the doc is a display
   mirror, not authority.
5. CLAUDE.md (Approval Rules + the "never deliver without approval" rule), and
   `docs/rad-cli.md`, plus the `/rad-deliver` Step 2 and `/rad-approve` Step 4 prose,
   state that `events.jsonl` is the sole approval authority and the plan-doc `Status:`
   is a display mirror.
6. Tests cover the new `gate` verb (passes with an approved event, fails without,
   writes nothing) and the rewritten `check-plan-approved.sh` (the doc-Status
   divergence cases from AC#2).

## Agent Scope
Architect scope over `harness/`, `scripts/`, `.claude/commands/`, `docs/`, and
`CLAUDE.md` (this repo self-hosts RAD; the Agent Scope Map is unpopulated). Research
delegated to one Explore sub-agent. No out-of-scope agents.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 500-760 | Add the read-only `gate` query verb (event-log fold via `state.gate`, exit 0/1, supports reading the log from a git-ref/stdin so it runs pre-checkout). Annotate `writePlanStatus` (502-541) as display-only. No change to `recordApproval`/event recording. |
| scripts/check-plan-approved.sh | 1-87 | Rewrite: resolve the feature + branch-tip event log, gate via the new verb, drop all plan-doc `Status:` reads. Keep the existing CLI interface (`<work-branch>`) and exit-code contract. |
| .claude/commands/team/rad-deliver.md | 53-59 | Step 2: update the explanatory prose to say the gate evaluates the approved event over the event log; keep the `check-plan-approved.sh "$WORK_BRANCH"` call line unchanged. |
| .claude/commands/architect/rad-approve.md | 237-284 | Step 4 prose: clarify the CLI writes the doc `Status:` as a display mirror and that authority is the appended approved event. |
| CLAUDE.md | 80, 191-199 | Update the "never deliver without approval" rule and Approval Rules to name the approved event in `events.jsonl` as authority; doc `Status:` is a display mirror. |
| docs/rad-cli.md | 1-60 | Document the `gate` query verb and that `events.jsonl` is the sole approval authority. |
| harness/test/cli.test.js | 1-40 | Add a test for the `gate` verb (pass with an approved event, fail without, writes nothing). |
| scripts/test-check-plan-approved.sh | 1-110 | New test (bash-harness style): event-log gate passes/fails per AC#2 divergence cases, with stubbed/fixture event logs and no live network. |

## Execution Notes

### Do Not Touch
- `harness/gates.js`, `harness/gates.yaml`, `harness/adapters/git-state-store.js`
  `gate()` / `recordApproval()`, `harness/transitions.js`, `harness/events.js` —
  Decision 1 (write-time role freeze + pure-fold gate) is complete and is the
  foundation this plan reuses. The new verb CALLS `state.gate()`; it does not
  reimplement or modify it.
- `harness/spine.js`, `harness/matrix.js` — port boundaries; they already call
  `state.gate()` and need no change.
- `scripts/check-role.sh` — unchanged; write-time authority already lives there.
- `scripts/rad-status.sh` — its `Status:` read (line ~55) is display-only and stays
  correct because the doc-write is retained.
- `/rad-deliver` Step 5/9 manual `Status:` edits — prose orchestration, not authority.

### Key Files
- `harness/adapters/git-state-store.js` — read the `gate()` (~282) and `history()`
  helpers the new verb builds on, and the TRANSITIONAL NOTE (271-277) that names
  this plan as the Decision 2 endpoint.
- `harness/cli.js` — mirror the existing command-dispatch + structured-output-line
  style (e.g. the `approve`/`status` verbs) for the new `gate` verb.
- `scripts/check-plan-approved.sh` — current branch-tip ref-resolution logic
  (`git show <ref>:<path>` over origin/<branch>, origin/<base>, local) to preserve
  for resolving the event log instead of the plan doc.
- `scripts/test-script-hardening.sh` / `scripts/test-check-scope.sh` — bash test
  harness style (temp fixtures, `fail()`, trap cleanup, grep assertions, no framework).
- `harness/test/gates.test.js` / `harness/test/cli.test.js` — `node:test` conventions.

### Reminders
- AC#3 is the subtle one: `/rad-deliver` Step 2 runs the gate BEFORE checkout, so the
  event log must be read from the branch tip, not the working tree. Recommended shape:
  `check-plan-approved.sh` resolves the ref (as today), `git show <ref>:.agents/state/<feature>/events.jsonl`,
  and pipes the JSONL to the `gate` verb via `--stdin` (keep the fold in JS — do not
  reimplement event parsing in bash). The verb's default (read the local on-disk log)
  serves direct `node harness/cli.js gate <feature> approved` calls.
- The doc-write stays — do NOT remove `writePlanStatus`; only the gate's READER changes.
- Keep `check-plan-approved.sh`'s argument signature and exit codes identical so the
  prose call site and any other callers are unaffected.
- A missing event log (no `.agents/state/<feature>/events.jsonl`) must fail the gate
  closed (non-zero), never pass by absence.

## Wave Plan

### Wave 1 — sequential
The query verb is the foundation everything else consumes.

#### Task 1.1: Read-only `gate` query verb
File: harness/cli.js:500-760
What: Add a `gate <feature> <name>` CLI verb that loads the feature's event log and
evaluates `state.gate(feature, name)` (the existing pure fold), printing a structured
result line and exiting 0 when `passed` is true, non-zero otherwise. Support reading
the event log from stdin (`--stdin`, JSONL) so it can be fed a branch-tip log before
checkout; default to the local on-disk log. Add a comment annotating `writePlanStatus`
(502-541) as display-only (authority is the appended approved event). Do not modify
`recordApproval` or the event recording.
Validate: AC#1 — verb evaluates over the log, exits 0/1, writes nothing; AC#4 — doc-write annotated display-only, recording untouched.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Rewrite check-plan-approved.sh onto the event log
File: scripts/check-plan-approved.sh:1-87
What: Replace the plan-doc `Status:` grep with an event-log gate. Resolve the feature
from the work branch and the branch-tip event log via the existing ref-resolution
(`git show <ref>:.agents/state/<feature>/events.jsonl` over origin/<branch>,
origin/<base>, local), pipe the JSONL to `node harness/cli.js gate <feature> approved
--stdin`, and map its exit code through. Fail closed on a missing log. Keep the script's
argument signature and exit-code contract identical.
Validate: AC#2 — gates on the event, not the doc (divergence cases); AC#3 — resolves the log from the branch tip, works pre-checkout, call site unchanged.

### Wave 3 — parallel
Depends on: Wave 2 complete

#### Task 3.1: Update prose command files
File: .claude/commands/team/rad-deliver.md:53-59
What: Update the Step 2 explanatory prose to state the gate evaluates the approved
event over the event log (keep the `check-plan-approved.sh "$WORK_BRANCH"` call line).
Also update `.claude/commands/architect/rad-approve.md` Step 4 prose to say the CLI
writes the doc `Status:` as a display mirror while authority is the appended approved
event.
Validate: AC#5 — prose names events.jsonl as authority and the doc Status as a display mirror.

#### Task 3.2: Update CLAUDE.md + docs
File: CLAUDE.md:191-199
What: Update CLAUDE.md's "What Claude Must Never Do" approval rule (line ~80) and the
Approval Rules section to name the approved event in `events.jsonl` as the gate
authority (doc `Status:` is a display mirror). Document the new `gate` query verb and
the sole-authority model in `docs/rad-cli.md`.
Validate: AC#5 — CLAUDE.md + docs/rad-cli.md state events.jsonl is sole authority, doc Status display-only.

### Wave 4 — parallel
Depends on: Wave 1 (verb) and Wave 2 (script) complete

#### Task 4.1: Gate-verb tests
File: harness/test/cli.test.js:1-40
What: Add `node:test` cases for the `gate` verb: passes (exit 0) with an approved event
in the log, fails (non-zero) with no approved event, and writes nothing to the plan doc
or log. Follow the existing cli.test.js fixture/store conventions.
Validate: AC#1 — verb pass/fail/no-write asserted.

#### Task 4.2: check-plan-approved event-log tests
File: scripts/test-check-plan-approved.sh:1-110
What: New bash-harness test asserting the AC#2 divergence cases: (a) doc says
`Status: approved` but no approved event → gate FAILS; (b) approved event present but
doc Status stale/absent → gate PASSES; (c) missing event log → fails closed. Use temp
fixtures and a stubbed `gate` verb or a real fixture log; no live network.
Validate: AC#2, AC#3 — event-log authority and branch-tip resolution asserted.

## Tests to Write
- [ ] `gate` verb passes with an approved event, fails without, writes nothing — harness/test/cli.test.js
- [ ] check-plan-approved gates on the event (doc-approved-but-no-event → fail; event-but-stale-doc → pass) — scripts/test-check-plan-approved.sh
- [ ] check-plan-approved fails closed on a missing event log — scripts/test-check-plan-approved.sh

## Non-Goals
- No change to the harness gate, `gates.js`, `recordApproval`, or the event schema —
  Decision 1 is done; this plan only moves the prose gate's READER onto the log.
- No removal of the plan-doc `Status:` write — the architect chose to keep it as a
  display mirror; `rad-status.sh` and the human-readable plan doc are unaffected.
- No new event-log fold in `rad-status.sh` display (only needed if the doc-write were
  removed, which it is not).
- No migration of `/rad-deliver` Step 5/9 manual `Status:` edits to a CLI verb.

## Out-of-Scope Dependencies
None. Decision 1 (the pure-fold gate + write-time role freeze) is already merged and
is the foundation this plan consumes.

## Risks
- **Pre-checkout log resolution (AC#3).** The gate runs before the branch is checked
  out, so the event log must come from the branch tip. Mitigation: reuse
  check-plan-approved.sh's existing ref-resolution and feed the log to the verb via
  stdin; test the pre-checkout path explicitly.
- **Fail-open on a missing log.** If the rewritten script treated an absent log as
  "no objection," an unapproved plan could deliver. Mitigation: fail closed (non-zero)
  on a missing/empty log; AC#6 / Task 4.2 assert it.
- **Display/authority drift.** Keeping the doc-write means doc Status and the event log
  can still diverge cosmetically (e.g. a hand-edited doc). Accepted by design: the gate
  no longer reads the doc, so divergence is cosmetic, not a gate bug — and the prose/docs
  now say so explicitly (AC#5).
