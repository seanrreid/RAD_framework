# Plan: Full-Suite Verification in a Delivery, and Re-Approval After Delivery (#229, #228)
Created: 2026-10-09
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-09T18:09:38.157Z
Recorded-By: sean@torchcodelab.com
Branch: rad/delivery-verification
Issue: 229
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/229
Issue-Title: Full test suites are not part of a rad deliver run; shared-module regressions reach the PR

## Context
Two process gaps that cost a revert and a detour on #227 (the playbook mechanism):
- **#229:** a `rad deliver` run validates each wave with targeted checks only. The full suites ran after the PR opened, found a CI-blocking eval regression, and by then the fix had to stay inside the approved scope.
- **#228:** once a run records `pr-opened`, the feature is in the terminal `delivered` phase, and `transitions.js` rule (a) rejects every later event, including `approved`. A plan amendment after delivery therefore cannot be re-approved.

Decisions the user made on 2026-10-09:
- **#229 mechanism (Q1):** a plan-level `Verify:` command on the **last wave**, run by the harness through `scripts/check-verify.sh` (a real exit code, not an agent's report). A new `scripts/verify-all.sh` is the single definition of "what CI runs, locally". The `rad-plan` and `rad-adopt` templates tell the planner to add it to any plan that touches a self-protected path. No harness code changes for #229.
- **#229 lint (Q2):** `scripts/lint-plan.sh` gives an **advisory warning**, not an approval blocker, when a plan touches a self-protected path and its last wave declares no `Verify:`. Revisit issue **#236** records when to reconsider (about ten such plans, or the first regression a `Verify:` would have caught).
- **#228 (Q3):** allow an `approved` event while the phase is `delivered`. The facts: the phase stays `delivered` (`approved` ranks below it); the duplicate-fingerprint and architect-role rules still apply; CI's `deliver-integrity` reads the latest approval and compares its fingerprint with the plan at the PR head; `events-append-only` accepts the appended line; the delivered short-circuit is unaffected.

Hazards found in `scripts/check-verify.sh`, which this plan designs around:
- It runs the command under `env -i` with only `PATH HOME LANG LC_ALL TMPDIR TERM USER`, so the command must set its own git identity.
- The default timeout is 600 s (`RAD_VERIFY_TIMEOUT_SECONDS`), while the suites take about 6 to 10 minutes.
- On a timeout it kills only the child process, not the process group. The documented form is therefore `Verify: exec bash scripts/verify-all.sh`, so the killed process is verify-all.sh itself, and verify-all.sh cleans up its own children on a signal.

## Scope
| In scope | Out of scope |
|---|---|
| `scripts/verify-all.sh` and its test script | A built-in `verify:` config step in `rad deliver` (option B, declined) |
| The last-wave `Verify:` advisory in `lint-plan.sh` (plus a helper in `plan-paths.sh`) | Making the missing `Verify:` an approval blocker (#236) |
| `rad-plan` and `rad-adopt` template guidance, regenerated | Changing `check-verify.sh` |
| `approved` allowed after `delivered` in `transitions.js`; `rad approve` keeps `Status: complete` for a delivered feature | CI jobs that need PR context (`deliver-integrity`, `matrix-replay`) as part of verify-all |
| Docs | |

## Acceptance Criteria
1. **`scripts/verify-all.sh`.** Usage: `verify-all.sh [--base <ref>] [--list] [--only <name>[,<name>...]]`.
   - **The checks,** in this order: `harness-tests` (`node --test harness/test/*.test.js`), `evals` (`node --test harness/evals/*.eval.js`), `script-tests` (every `scripts/test-*.sh`, each run with `bash`, with the failures named), `generate-drift` (`node harness/cli.js generate --check`), `playbook-lint` (`node harness/cli.js playbook lint`), `config-validate` (`node harness/cli.js config validate`), `lint-invariants`, `lint-agent-files`, `lint-claude-md`, `lint-shell-safety`, then the two checks that need a base ref: `plan-lint` (`scripts/lint-plan.sh` on every plan file changed since the base) and `events-append-only` (`scripts/check-events-append-only.sh <base>`).
   - **The base ref** defaults to `origin/main` when it resolves, and `--base` overrides it. With no resolvable base, the two base-dependent checks print `skip  <name> (no base ref)`. A skip is never a failure.
   - **`deliver-integrity` and `matrix-replay` are excluded** (they need PR context), and the script header says so.
   - **Output:** one line per check, `ok   <name> (<seconds>s)` or `FAIL <name> (exit <N>, <seconds>s)`. The **last** lines are a summary `verify-all: <p> passed, <f> failed, <s> skipped`, preceded by the last 12 lines of output of each failed check, so the harness's 40-line failure excerpt shows what failed. The exit code is 0 only when nothing failed.
   - **Identity:** when unset, it exports `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` (`rad-verify`, `rad-verify@localhost`), so tests that commit work under `env -i`.
   - **Signals:** on `TERM` or `INT` it kills the running check and that check's child processes (best effort, `pkill -TERM -P`), prints `verify-all: interrupted`, and exits 143.
   - **Test hook:** `RAD_VERIFY_ALL_CHECKS_FILE`, a file of `name<TAB>command` lines, replaces the built-in table. It exists for the test script and is documented as test-only.
   - **Compatibility:** bash 3.2 (no associative arrays, no `mapfile`), every path quoted, committed mode **100755**, and it passes `scripts/lint-shell-safety.sh`.
2. **The verify-all test script.** The new `scripts/test-verify-all.sh` (mode 100755, bash 3.2-compatible, using the test hook) covers: all checks pass (exit 0, the summary last); one failing check (non-zero, the `FAIL` line, the check's own output excerpted, the summary last); a skip (`--only` or no base ref) not being a failure; `--list` printing the built-in check names; the git identity defaults being exported; and a SIGTERM during a long check killing it and its children, exiting 143 and leaving no stray child process.
3. **The lint advisory.** `scripts/lib/plan-paths.sh` gains `plan_last_wave_verify <plan>`, which prints `<last wave number> yes|no` (nothing when the plan has no waves). It mirrors `parseWaveVerify`: a `### Wave N` heading opens a block, any other `##` or `###` heading ends it, `####` headings stay inside, and a trimmed line matching `^Verify:\s*(.+)$` counts. `scripts/lint-plan.sh` adds a WARNING when the plan has a self-protected path in scope (the existing `path_is_self_protected` loop) **and** the last wave has no `Verify:`: `last wave (N) declares no Verify: and the plan touches self-protected paths (<first path>) — consider 'Verify: exec bash scripts/verify-all.sh' (see #236)`. Plans with no self-protected path, no waves, or a `Verify:` on the last wave get no warning, and the warning never changes the exit code.
4. **Template guidance.** `.rad/skills/rad-plan/SKILL.md` and `.rad/skills/rad-adopt/SKILL.md` each gain a short note beside the wave template: on the last wave of any plan that touches `harness/`, `scripts/`, `.rad/`, `.claude/` or `.agents/skills/`, add the line `Verify: exec bash scripts/verify-all.sh`, and run `rad deliver` with `RAD_VERIFY_TIMEOUT_SECONDS=1800` (the default is 600 s). The four generated outputs are regenerated and `generate --check` passes. The bodies stay tool-neutral.
5. **Re-approval after delivery (#228).** In `harness/transitions.js` rule (a), an `approved` event is allowed when the phase is `delivered`. Anything after `done`, and every other event type after `delivered`, is still rejected. Rules (d) (duplicate or absent fingerprint) and (e) (role) apply unchanged, and the phase after the event is still `delivered`.
6. **`rad approve` on a delivered feature.** `recordApprovalAndStatus` and `writePlanStatus` in `harness/cli.js`: when the feature's phase is `delivered`, the plan header's `Status:` line is left as it is (for example `complete`). Only the approval provenance lines (`Approved-By`, `Approved-At`, `Recorded-By`, and the evidence and proxy lines) are updated. The commit and push work as before, and the `ok` line's `status=` reports the header's resulting Status. A same-fingerprint repeat still resumes instead of appending a duplicate.
7. **Tests for #228.**
   - harness/test/transitions.test.js: `approved` with a new fingerprint after `pr-opened` is allowed; the same fingerprint after `pr-opened` throws `duplicate-approved`; an `approved` with no fingerprint after `pr-opened` still throws; `approved` after `done` throws `after-terminal`; `wave-attempt` after `pr-opened` still throws; the phase after an allowed `approved` is `delivered`.
   - harness/test/cli-approve-commit.test.js: a delivered feature with an amended plan is re-approved; the event is appended with the new fingerprint, `Status: complete` and `Completed-At` are untouched, the provenance lines are updated, and the commit and push happen; a same-fingerprint repeat appends nothing.
   - No existing assertion changes. If one must, list it.
8. **Docs.**
   - docs/configuration.md "Per-Wave Verification": the recommended last-wave `Verify: exec bash scripts/verify-all.sh`, why `exec`, `RAD_VERIFY_TIMEOUT_SECONDS=1800`, the `env -i` note, the advisory lint and **#236**.
   - docs/rad-cli.md: `### rad approve` explains re-approval after delivery, and the CI checks section mentions `scripts/verify-all.sh` as the local equivalent.
   - docs/rad-wave-contract.md (~435) and docs/harness-state-store.md (~124): the terminal-phase rule now carves out `approved` after `delivered`.
   - docs/daily-workflow.md: one sentence on last-wave verification and post-delivery re-approval.
9. **Full verification.** Wave 5's `Verify: exec bash scripts/verify-all.sh` passes in the run. The run is started with `RAD_VERIFY_TIMEOUT_SECONDS=1800`.

## Agent Scope
Research came from a read-only sub-agent survey of the per-wave `Verify:` gate, `check-verify.sh`, the CI job list and commands, the plan templates and lint helpers, the transition and fold rules for `approved` and the terminal phases, `deliver-integrity` and `events-append-only`, and the docs. Targeted greps for the approve code, the test files and the doc line numbers followed. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/verify-all.sh | 1-1 | New (AC#1) |
| scripts/test-verify-all.sh | 1-1 | New (AC#2) |
| scripts/check-verify.sh | 40-80 | Read only: the env and timeout semantics |
| .github/workflows/ci.yml | 20-140 | Read only: the CI commands to mirror |
| scripts/lib/plan-paths.sh | 525-550 | New `plan_last_wave_verify` |
| scripts/lint-plan.sh | 350-372 | The advisory warning |
| scripts/test-plan-paths.sh | 1-1 | Append helper cases |
| scripts/test-lint-plan.sh | 1235-1280 | New `t_last_wave_verify`, call list |
| .rad/skills/rad-plan/SKILL.md | 285-310 | Verify guidance |
| .rad/skills/rad-adopt/SKILL.md | 215-230 | Verify guidance |
| .claude/commands/team/rad-plan.md | 1-1 | Regenerated |
| .claude/commands/team/rad-adopt.md | 1-1 | Regenerated |
| .agents/skills/rad-plan/SKILL.md | 1-1 | Regenerated |
| .agents/skills/rad-adopt/SKILL.md | 1-1 | Regenerated |
| harness/test/skill-bodies.test.js | 30-60 | Bodies mention `scripts/verify-all.sh` |
| harness/transitions.js | 55-80 | Rule (a) exception |
| harness/test/transitions.test.js | 1-60 | New cases (AC#7) |
| harness/cli.js | 2130-2175 | `writePlanStatus`: keep Status when delivered |
| harness/cli.js | 2350-2420 | `recordApprovalAndStatus`, `recordOrResume` |
| harness/test/cli-approve-commit.test.js | 1-1 | Append cases (AC#7) |
| docs/configuration.md | 310-345 | Per-Wave Verification |
| docs/rad-cli.md | 44-110 | `### rad approve` |
| docs/rad-cli.md | 1385-1410 | CI checks |
| docs/rad-wave-contract.md | 430-440 | Terminal rule |
| docs/harness-state-store.md | 120-128 | Terminal rule |
| docs/daily-workflow.md | 118-132 | One sentence |

## Execution Notes

### Do Not Touch
- scripts/check-verify.sh, harness/spine.js, harness/gates.*, harness/events.js
- The `deliver-integrity` and `matrix-replay` CI jobs
- The delivered short-circuit (`deliveredShortCircuit`) and `deliverCompleted`

### Key Files
- scripts/check-verify.sh: the env allow-list (line 62), the timeout (49), the failure excerpt (40 lines or 8000 bytes), exit 124 on timeout
- .github/workflows/ci.yml: each job's command, which verify-all.sh mirrors
- harness/cli.js `parseWaveVerify` (~575-606): the exact `Verify:` syntax that `plan_last_wave_verify` must mirror
- scripts/lint-plan.sh 357-367 and scripts/lib/plan-paths.sh (`path_is_self_protected`, `plan_scope_paths`, `plan_wave_task_files`)
- harness/transitions.js `validateTransition` rules (a) to (e); harness/test/transitions.test.js "illegal (a)"
- harness/cli.js `recordApprovalAndStatus` (~2354), `writePlanStatus` (~2137, the `Status` upsert at ~2166), `recordOrResume` (~2405)

### Reminders
- **New scripts must be committed executable** (`git update-index --chmod=+x`), and `bash scripts/lint-shell-safety.sh` must pass. CI's `shell-safety-lint` rejected a 100644 script on PR #233.
- **Run this plan with `RAD_VERIFY_TIMEOUT_SECONDS=1800 RAD_WAVE_TIMEOUT_SECONDS=1800`.** Waves 1 to 4 validate with targeted checks. Wave 5's `Verify:` runs the whole suite.
- **The mutation anchors:** `harness/evals/approval.eval.js` and `delivery.eval.js` patch source lines in the harness. Run `node --test harness/evals/*.eval.js` after the `transitions.js` and `cli.js` edits and keep any anchor line byte-identical.
- **Bash 3.2 compatibility in every new script,** with every path quoted.
- **Edge cases are named in each task's Validate field,** and each gets a test.
- **Helpers stay under ~40 lines, with named constants.**

## Program Design
```
verify-all.sh [--base ref] [--list] [--only a,b]
  table: harness-tests | evals | script-tests | generate-drift | playbook-lint | config-validate
         lint-invariants | lint-agent-files | lint-claude-md | lint-shell-safety | plan-lint* | events-append-only*
  (* need a base ref: default origin/main, else "skip")
  per check: run, record exit + seconds → "ok   name (Ns)" | "FAIL name (exit N, Ns)"
  end: failed checks' last 12 lines, then "verify-all: P passed, F failed, S skipped"; exit 0 iff F == 0
  TERM/INT: kill running check + children → "verify-all: interrupted" → exit 143
plan:  last wave:  Verify: exec bash scripts/verify-all.sh      (check-verify.sh runs it, env -i, RAD_VERIFY_TIMEOUT_SECONDS)
lint-plan.sh: self-protected path in scope && last wave has no Verify → WARNING (see #236)
transitions.js (a): TERMINAL && !(type == 'approved' && phase == 'delivered') → throw
rad approve (phase == delivered): record event; header Status untouched; provenance lines updated
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: verify-all.sh and its test
File: scripts/verify-all.sh:1-1, scripts/test-verify-all.sh:1-1, scripts/check-verify.sh:40-80, .github/workflows/ci.yml:20-140
What: Write AC#1 and AC#2. Commit both scripts with mode 100755 and run `bash scripts/lint-shell-safety.sh`.
Validate: AC#1, AC#2 — `bash scripts/test-verify-all.sh` passes under both `bash` and `/bin/bash`; `bash -n` is clean on both scripts; `bash scripts/lint-shell-safety.sh` exits 0; `git ls-files -s scripts/verify-all.sh scripts/test-verify-all.sh` shows mode 100755 for both; edge cases covered: a failing check, a skip, no base ref, an empty checks file and a signal during a long check

### Wave 2 — sequential

#### Task 2.1: The last-wave Verify advisory
File: scripts/lib/plan-paths.sh:525-550, scripts/lint-plan.sh:350-372, scripts/test-plan-paths.sh:1-1, scripts/test-lint-plan.sh:1235-1280
What: Write AC#3 and its two test files.
Validate: AC#3 — `bash scripts/test-plan-paths.sh` and `bash scripts/test-lint-plan.sh` pass; edge cases covered: a Verify only on an earlier wave (warns), a Verify on the last wave (no warning), a plan with no self-protected path (no warning), no waves (no warning), a light plan, and a `Verify:` line appearing mid-sentence (not counted)

### Wave 3 — sequential

#### Task 3.1: Template guidance
File: .rad/skills/rad-plan/SKILL.md:285-310, .rad/skills/rad-adopt/SKILL.md:215-230, .claude/commands/team/rad-plan.md:1-1, .claude/commands/team/rad-adopt.md:1-1, .agents/skills/rad-plan/SKILL.md:1-1, .agents/skills/rad-adopt/SKILL.md:1-1, harness/test/skill-bodies.test.js:30-60
What: Write AC#4. Edit only the two sources, run `node harness/cli.js generate`, and add the skill-bodies assertion.
Validate: AC#4 — `node harness/cli.js generate --check` exits 0; `node --test harness/test/skill-bodies.test.js` passes; `grep -c 'scripts/verify-all.sh' .agents/skills/rad-plan/SKILL.md .agents/skills/rad-adopt/SKILL.md` is non-zero for each; `grep -c 'git add\|git commit\|git push\|Explore' .agents/skills/rad-plan/SKILL.md .agents/skills/rad-adopt/SKILL.md` prints 0 for each

### Wave 4 — sequential

#### Task 4.1: Re-approval after delivery
File: harness/transitions.js:55-80, harness/test/transitions.test.js:1-60, harness/cli.js:2130-2175, harness/cli.js:2350-2420, harness/test/cli-approve-commit.test.js:1-1
What: Write AC#5, AC#6 and AC#7.
Validate: AC#5, AC#6, AC#7 — `node --test harness/test/transitions.test.js harness/test/cli-approve-commit.test.js harness/test/approval-authority-recording.test.js` passes; `node --test harness/evals/approval.eval.js harness/evals/delivery.eval.js` passes; edge cases covered: a changed fingerprint, an identical fingerprint, an absent fingerprint, after `done`, another event type after `delivered`, and a same-fingerprint repeat

#### Task 4.2: Docs
File: docs/configuration.md:310-345, docs/rad-cli.md:44-110, docs/rad-cli.md:1385-1410, docs/rad-wave-contract.md:430-440, docs/harness-state-store.md:120-128, docs/daily-workflow.md:118-132
What: Write AC#8.
Validate: AC#8 — `grep -n 'verify-all' docs/configuration.md docs/rad-cli.md` matches in both; `grep -n '#236' docs/configuration.md` matches; `bash scripts/lint-claude-md.sh` passes; docs only

### Wave 5 — sequential
Final verification, run by the harness: the full set of CI-equivalent checks.

Verify: exec bash scripts/verify-all.sh

#### Task 5.1: Full verification
File: scripts/verify-all.sh:1-1
What: Write AC#9. The harness runs the `Verify:` command above after this task returns, so make no edits unless the harness feeds back a failure that traces to this plan's changes, and such a fix stays within the scope above. Report any other failure as `blocked_intent`.
Validate: AC#9 — the harness's Verify gate passes (`verify-all: … 0 failed`); `git ls-files -s scripts/verify-all.sh` shows mode 100755

## Tests to Write
- [ ] verify-all pass, fail, skip, list, identity and signal handling — scripts/test-verify-all.sh
- [ ] plan_last_wave_verify cases — scripts/test-plan-paths.sh
- [ ] the last-wave Verify advisory — scripts/test-lint-plan.sh
- [ ] the plan skills mention verify-all.sh — harness/test/skill-bodies.test.js
- [ ] approved allowed after delivered, still refused otherwise — harness/test/transitions.test.js
- [ ] re-approval of a delivered feature keeps Status — harness/test/cli-approve-commit.test.js

## Non-Goals
- A built-in `verify:` step or config key in `rad deliver`, or any change to `check-verify.sh` (including a process-group kill).
- Making the missing `Verify:` an approval blocker (#236 revisits it).
- Running `deliver-integrity` or `matrix-replay` locally.
- Re-approval after `done`, or any other event after a terminal phase.

## Out-of-Scope Dependencies
None

## Risks
- **Allowing `approved` after `delivered` touches an approval-integrity rule.** Mitigation: it is one narrow exception, the duplicate-fingerprint and role rules still apply, the phase can't change, CI's integrity check reads the latest approval against the plan at the head, and the tests pin each refused case.
- **A long `Verify:` can time out and orphan child processes** (check-verify.sh kills only its child). Mitigation: the documented `exec` form makes the killed process verify-all.sh itself, which cleans up its children on a signal, and the docs set the timeout to 1800 s.
- **verify-all.sh can drift from CI's job list.** Mitigation: the header lists the CI jobs it mirrors and the two it excludes, and docs/rad-cli.md's CI section points to it.
- **Wave 5's `Verify:` runs the whole suite, so the final wave takes about 6 to 10 minutes.** That is the purpose of the change.
- **Self-protected paths** (`scripts/`, `harness/`, `.rad/`, `.claude/`, `.agents/skills/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — verify-all.sh runs checks sequentially and continues past failures,** so one run reports every failing check, and its closing summary fits the harness's failure excerpt.
- **Assumption — a post-delivery re-approval leaves the plan header's `Status: complete` and `Completed-At:` alone,** since Status is a display mirror and the event log is the authority.
- **Assumption — `script-tests` is one check that names the failing scripts,** instead of one check per script.
- **Assumption — `bash32-parse` is covered by `script-tests`,** because it is a `scripts/test-*.sh` file.
- **Assumption — the advisory sits in `lint-plan.sh`'s warnings array,** so it never changes the lint's exit code or the approval flow.
