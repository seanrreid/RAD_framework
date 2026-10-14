# Plan: Remaining Guides: Namespaced Commands, Approval Wording, Stale Facts
Created: 2026-10-14
Author: architect
Status: pending-review
Branch: rad/guides-namespaced-commands-and-approval
Tier: light
Source-Author: none (no source issue)
Source-Comments: none

## Context
Second plan from the 2026-10-14 docs audit; the first (#279) fixed the five first-run docs. This one covers five more guides with the same problems plus a few stale facts. Each fact below was found by the audit and, where marked, re-checked against the code.

- **Bare commands:** `how-it-works` 38, `architect-guide` 33, `epic-decomposition` 17, `plan-approval-guide` 16. (`evals.md` has none.) The namespacing note already lives in `docs/daily-workflow.md`.
- **Approval wording:** `how-it-works.md` lines 41 and 97 say `/rad-approve` writes `Status: approved`, and its guardrail table (line 165) says `check-plan-approved.sh` checks that "a plan is `approved`"; `plan-approval-guide.md` lines 42, 139 and 215 and `architect-guide.md` line 191 say the same, and line 215 says `/rad-deliver` gates on `Status: approved`. The gate is the `approved` event in `.agents/state/<feature>/events.jsonl`; `Status:` is a display mirror (`scripts/check-plan-approved.sh`, `docs/rad-decisions.md`).
- **Stale facts:** `how-it-works.md:213` says execution-based verification "is tracked as issue #89" (closed; per-wave `Verify:` lines now run via `scripts/check-verify.sh`). `how-it-works.md:92` says independent tasks "run in parallel", but `docs/wave-execution.md` says a wave is one agent call. `architect-guide.md:314-319` describes "wave sub-agents", a `WAVE_RESULT` summary, a "Claude Code session" and resuming "from the execution log"; the current mechanism is one agent call per wave, the event log, and `rad deliver --resume`. `evals.md:33-40` lists six scripted adversary behaviours as a "fixed set"; `harness/evals/lib/fixture.js` defines ten (it adds `delete-test`, `rename-test`, `skip-test` and the no-op `marker`).
- **Missing checklist items:** `plan-approval-guide.md` does not tell the architect to judge `## Waivers` entries (`high-risk:` and `test-removal:`), the last-wave `Verify:` requirement, the source-provenance line, or declared capabilities, all of which `/architect:rad-approve` shows at approval time.
- **Checked and fine:** `architect-guide.md:75` ("editing `Status: approved` by hand still works") is about the architecture draft that `/architect:rad-design` writes, and `.rad/skills/rad-design/SKILL.md:29` confirms it. Leave it.

## Acceptance Criteria
1. **No bare commands.** In the five files, no `/rad-<name>` remains unless it is part of a longer path or already namespaced. Mapping as in #279: `plan`, `research`, `adopt`, `deliver`, `review` become `/team:rad-<name>`; `approve`, `design`, `epic-decompose` become `/architect:rad-<name>`; `status`, `insights` become `/shared:rad-<name>`; `/kickoff`, `/wrap`, paths and already-namespaced text are unchanged. Check: `grep -nE '(^|[^:/A-Za-z0-9_.-])/rad-' <five files>` prints nothing. Each of `how-it-works`, `architect-guide`, `epic-decomposition` and `plan-approval-guide` links once to the namespacing note in `docs/daily-workflow.md`.
2. **Approval wording.** Every place listed in Context that attributes approval to `Status: approved` now says that `/architect:rad-approve` records an `approved` event in `.agents/state/<feature>/events.jsonl` on the branch tip, that `rad deliver` and `check-plan-approved.sh` read that event, and that the `Status:` header is a display mirror. The `plan-approval-guide` status table keeps its four statuses but its sentence under the table says the command records the event and mirrors the status. `architect-guide:75` is unchanged.
3. **Stale facts fixed.** `how-it-works.md:213` points at `scripts/check-verify.sh` and the per-wave `Verify:` line instead of issue #89, and `how-it-works.md:92` says independent tasks are grouped in a wave and run in one agent call, matching `docs/wave-execution.md`. `architect-guide.md` "Context getting noisy" describes one agent call per wave, the event log and resuming with `node harness/cli.js deliver <feature> --resume` (confirm the exact flag in `docs/rad-cli.md`), and no longer mentions `WAVE_RESULT` sub-agents, "execution log" resumes or Claude Code specifically. `evals.md` lists all ten behaviours that `fixture.js` defines, and its "fixed set" sentence matches.
4. **Review checklist.** `plan-approval-guide.md` gains short checklist items for: judging each `## Waivers` entry (`high-risk:<path>` and `test-removal:<path>`) because approving accepts them; the last-wave `Verify:` (or `Verify: none (<reason>)`) required for standard plans, with light plans exempt; the source-provenance line (untrusted source means read every Task and `Verify:` command); and the declared capabilities.
5. **Nothing else changes.** `git diff --stat` shows only the five files plus this plan; relative links in them still resolve; no other wording is edited.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| docs/how-it-works.md | 1-265 | Sweep (38), approval wording (41, 97, 165), #89 sentence (213), parallel wording (92) |
| docs/architect-guide.md | 1-343 | Sweep (33), approval wording (191), "Context getting noisy" (314-319) |
| docs/plan-approval-guide.md | 1-221 | Sweep (16), approval wording (42, 139, 215), new checklist items |
| docs/epic-decomposition.md | 1-119 | Sweep (17) |
| docs/evals.md | 30-50 | Adversary behaviour list (33-40) |

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel.
Verify: none (documentation only; the grep, link and diff checks in Task 1.3 are the verification)

#### Task 1.1: how-it-works.md and evals.md
File: docs/how-it-works.md:1-265, docs/evals.md:30-50
What: Apply AC#1 (sweep and one note link) and AC#2 to `how-it-works.md`; apply the two stale-fact fixes of AC#3 (lines 92 and 213) there; update the behaviour list in `evals.md` from `harness/evals/lib/fixture.js` (AC#3). Change nothing else.
Validate: AC#1, AC#2, AC#3 — the AC#1 grep is empty for `how-it-works.md`; `evals.md` names all ten behaviours.

#### Task 1.2: architect-guide.md and plan-approval-guide.md
File: docs/architect-guide.md:1-343, docs/plan-approval-guide.md:1-221
What: Sweep both files and link once to the note (AC#1); fix the approval wording (AC#2); rewrite the "Context getting noisy" section of `architect-guide.md` (AC#3), looking up the resume flag in `docs/rad-cli.md`; add the checklist items of AC#4 to `plan-approval-guide.md`. Leave `architect-guide.md:75` alone.
Validate: AC#1, AC#2, AC#3, AC#4 — the AC#1 grep is empty for both files; the four checklist items exist.

#### Task 1.3: epic-decomposition.md and checks
File: docs/epic-decomposition.md:1-119
What: Sweep `epic-decomposition.md` and link once to the note (AC#1). Then run the AC#1 grep across all five files, check that every relative markdown link in them resolves, and run `git diff --stat main...HEAD`.
Validate: AC#1, AC#5 — the grep prints nothing; no missing link target; the diff stat lists only the five files and this plan.

## Tests to Write
- None. Documentation only; the grep, link check and diff stat in Task 1.3 are the verification.

## Non-Goals
- `UPGRADE.md` (its own plan), and the reference docs (`rad-cli`, `configuration`, `rad-wave-contract`, `harness-*`)
- Changing any script, `install.sh` or generated file
- Editing prose beyond the items listed in Context

## Risks
- The mechanical sweep can hit a `/rad-` inside a path or code sample; AC#1 excludes path-embedded and already-namespaced text and the diff review catches the rest.
- The `--resume` flag name must come from `docs/rad-cli.md`; if it is not documented there, the executor should state that and describe resuming in words rather than guess.
