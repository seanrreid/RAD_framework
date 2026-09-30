# Plan: Verification Hardening (prefix-agnostic CI, platform setting, stop detail, hook message, PR linking)
Created: 2026-09-30
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-30T14:05:24.053Z
Recorded-By: sean@torchcodelab.com
Branch: rad/verification-hardening
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/154, https://github.com/seanrreid/RAD_framework/issues/156, https://github.com/seanrreid/RAD_framework/issues/161, https://github.com/seanrreid/RAD_framework/issues/162, https://github.com/seanrreid/RAD_framework/issues/163
Issue-Title: CI deliver-integrity skipped under custom prefix (#154) + detect-platform ignores platform: (#156) + stop detail dropped (#161) + misleading hook message (#162) + PRs not auto-closing issues (#163)

## Context

This is Batch C: five small, already-diagnosed defects found during the verification batch (#155, #157, #159, #160). Each weakens a guarantee the new registry and evals now watch.

**What research found:**
- **#154.** `deliver-integrity` is gated on `if: startsWith(github.head_ref, 'rad/')` (`.github/workflows/ci.yml:132`), and derives the feature by stripping a hard-coded `rad/` in two places: `:144` (the detect step) and `:170` (the `check-scope.sh` plan path). `check-approval-integrity.sh` already ignores the prefix (`${WORK_BRANCH##*/}`, `:56-58`). The registry records this as the unguarded bypass `custom-branch-prefix` (`docs/invariants.yaml:29-32`, `:78-81`).
- **#156.** `scripts/detect-platform.sh` (77 lines) detects only from the `origin` URL (`:11-38`). An unknown host falls back to `glab`, then `gh`, if either is installed (`:29-36`). It never reads CLAUDE.md `platform:`, even though its own warnings tell users to set it (`:49`, `:57`). Its callers are `open-pr.sh:43`, `fetch-epic.sh:55` (which has a `RAD_PLATFORM` override first), `rad-status.sh:20` and `install.sh:244`. `get-default-branch.sh:16-29` has the CLAUDE.md parsing pattern to reuse. There is no `test-detect-platform.sh`.
- **#161.** `classifyStop` (`harness/stops.js:111-120`) returns `reason: result.stopped` for the fixed-class rows. `stopRun` copies only `STOP_CONTEXT_KEYS = ['wave', 'action', 'outcome']` (`harness/spine.js:52-72`). So the spine's free-text `reason` (from `approvalChangeReason` `:638-640`, and `APPROVED_DURING_RUN_REASON` `:85-86`, `:1051-1056`) reaches neither the event nor the CLI line (`harness/cli.js` `reportStop` `:894-908`).
- **#162.** On an edited, approved plan, the deliver-gate hook blocks correctly, but its message says "no approved event". `scripts/check-plan-approved.sh` does detect the fingerprint mismatch (`:100-129`, exit 1, "plan modified after approval"), but the message the operator sees doesn't carry that reason.
- **#163.** #159 and #160 had empty `closingIssuesReferences` from creation, and their issues were closed by hand, while #157 linked #109 and auto-closed it one second after merge. The bodies are byte-identical in format (`Closes #N.`, no BOM, never edited). `open-pr.sh` passes `--body "$BODY"` to `gh pr create` (`:61-68`). The cause isn't visible from our side (possibly a GitHub-side linking race), so the robust fix is to **verify and retry, then warn**.

**Architect decision (2026-09-30):** #154 detects a deliver PR **by content**: the head branch carries a plan whose `Branch:` header equals the head ref. It's prefix-agnostic, with no repo variable. Batch B (`rad/review-digest-and-consistency`) is delivered after this plan, and it adds a step to the same CI job.

## Scope

| In scope | Out of scope |
|---|---|
| `scripts/detect-deliver-pr.sh` + CI `deliver-integrity` uses it (no `rad/` literal) | The `matrix-replay` job's `rad/*` fetch (the replay script already honors `RAD_BRANCH_PREFIX`) |
| `detect-platform.sh` honors CLAUDE.md `platform:` first | Adding new platforms |
| `deliver-stopped.data.detail` + CLI `detail="…"` | Changing stop classes, reasons, decisions or exit codes |
| Hook and `check-plan-approved.sh` name the fingerprint mismatch | Changing what the hook blocks |
| `open-pr.sh` verifies issue linking, re-saves the body once, then warns | Auto-closing issues from RAD, or any extra host-API write beyond the one re-save |
| Registry: flip `custom-branch-prefix` to guarded | New invariants |

## Acceptance Criteria

1. `scripts/detect-deliver-pr.sh <head-ref> [plans-dir]` checks whether a PR is a deliver PR.
   - **Deliver PR:** it prints the feature slug and exits **0** iff some `<plans-dir>/<slug>.md` (default `.agents/plans`) has a `Branch:` header exactly equal to `<head-ref>`.
   - **Not a deliver PR:** it exits **3** with no output.
   - **Usage or input errors:** a missing, malformed or option-shaped ref (guarded with `[[ =~ ]]`), or an unreadable plans dir, exits **2**.
   - **Ambiguity:** more than one plan claiming the same branch exits **1**, naming them. That's fail-closed, never a guess.
   - **Fixture test** (`bash` + `/bin/bash`): `rad/` and `feature/` prefixes both detected; an ordinary branch → 3; two plans with the same branch → 1; a bad ref → 2.
2. The CI `deliver-integrity` job:
   - drops the job-level `rad/` condition
   - runs the detect script first; exit 3 sets `skip=true` (a clean no-op), and exit 1 or 2 fails the job
   - takes the feature from the script's output everywhere (no `${GITHUB_HEAD_REF#rad/}`)
   - keeps its approval-integrity and scope steps, which run only when not skipped

   No `rad/` literal remains in the job. It stays a thin wrapper.
3. `docs/invariants.yaml`: both `custom-branch-prefix` bypasses become `guarded: "yes"`, with a note pointing at `scripts/detect-deliver-pr.sh`. The `unapproved-deliver-cannot-run` and `scope-enforced` entries gain an anchor on the script. `scripts/lint-invariants.sh` passes.
4. `scripts/detect-platform.sh` reads `platform:` from CLAUDE.md's "Git Platform" block **first**, using `get-default-branch.sh`'s parsing pattern, with CLAUDE.md found at the git top level.
   - **Valid value** (github, gitlab, bitbucket, forgejo, manual): it wins over URL detection. `manual` never calls or suggests a host CLI.
   - **Invalid value:** a `warning:` on stderr, and the result is `manual` (fail-closed: no host API).
   - **Absent or no CLAUDE.md:** today's URL detection, unchanged.
   - **Output contract:** the last line is the platform, and `--quiet` still works.
5. `scripts/test-detect-platform.sh` (new, both shells) covers:
   - `manual` with a github.com remote → manual
   - `github` with an unknown-host remote → github
   - an invalid value → manual + warning
   - absent → URL detection (github.com → github; no remote → manual)
   - `--quiet`

   Existing `test-open-pr.sh`, `test-fetch-epic.sh`, `test-rad-status.sh` and `test-script-hardening.sh` still pass.
6. `stopRun` copies the spine's free-text `result.reason` (when it's a non-empty string) into `deliver-stopped.data.detail`. `class`, `reason` and `decision` are unchanged, and stops without a free-text reason append byte-identical events. `rad deliver`'s stop line appends ` detail="<detail>"` when present. The `deliver-stopped` typedef in `harness/events.js` documents `detail`.
7. Tests for AC#6:
   - **Spine:** `approval-changed` from a port reason → `data.detail` equals that reason; a stop with no free-text reason → no `detail` key.
   - **CLI:** the stop line includes `detail=`.
   - **Eval:** `harness/evals/approval.eval.js` `self-approval-mid-run` additionally asserts `detail` contains `recorded during this run`.
8. On an approved plan whose body changed, the operator-facing refusal names the cause. `check-plan-approved.sh` prints `plan changed since approval (fingerprint mismatch) — re-approve with /rad-approve <feature>`, and the deliver-gate hook's block message carries the script's reason and not "no approved event". An **unapproved** plan's message is unchanged, and exit codes are unchanged. `scripts/test-check-plan-approved.sh` and `harness/test/deliver-gate-hook.test.js` cover both messages.
9. After a successful `gh pr create`, `open-pr.sh` checks the PR body for closing keywords (`Closes|Fixes|Resolves #N`, case-insensitive).
   - **Verify:** when the body has them, it queries `gh pr view <url> --json closingIssuesReferences`.
   - **Retry once:** if the result is empty, it re-saves the same body once (`gh pr edit <url> --body-file <tmp>`) and re-checks.
   - **Warn:** if it's still empty, it prints `warning: GitHub linked no closing issue for #N — close it after merge` to stderr.
   - **Always:** the exit status is unchanged (a successful open still exits 0), and nothing runs in `manual` mode or when `gh` is absent.
   - **Tests:** `scripts/test-open-pr.sh` covers linked-first-time, linked-after-re-save, still-unlinked (warning) and no-keyword (no queries) with a stub `gh`.
10. `CLAUDE.md`'s "Git Platform" block says the `platform:` setting is honored by `detect-platform.sh` and that `manual` never calls a host CLI.
11. Every existing suite stays green: `npm test --prefix harness`, `node --test harness/evals/*.eval.js`, every shell test under both shells, `lint-shell-safety`, `lint-invariants` and the replay check.

## Agent Scope

An `Explore` agent (general, read-only) mapped:
- `ci.yml` `deliver-integrity` and every hard-coded `rad/`
- the `RAD_BRANCH_PREFIX` sites
- `detect-platform.sh` logic, callers and parsing pattern
- `stops.js` / `spine.js` / `cli.js` stop reporting
- `check-plan-approved.sh`'s fingerprint block
- `open-pr.sh` body passing
- a byte-level comparison of the #157, #159 and #160 bodies and the #158 timeline
- the registry bypass lines

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/detect-deliver-pr.sh | 1-70 | New: AC#1 |
| scripts/test-detect-deliver-pr.sh | 1-100 | New: AC#1 fixture test |
| .github/workflows/ci.yml | 125-172 | `deliver-integrity` detection via the script (AC#2) |
| docs/invariants.yaml | 1-90 | Flip `custom-branch-prefix` to guarded; new anchors (AC#3) |
| scripts/detect-platform.sh | 1-77 | CLAUDE.md `platform:` first (AC#4) |
| scripts/test-detect-platform.sh | 1-120 | New: AC#5 |
| harness/spine.js | 48-75 | `stopRun` copies `detail` (AC#6) |
| harness/events.js | 16-40 | `deliver-stopped` typedef: `detail` |
| harness/cli.js | 890-910 | `reportStop` prints `detail` |
| harness/test/spine.test.js | 2230-2270 | Tests for AC#7 (append) |
| harness/test/cli.test.js | 1300-1340 | Tests for AC#7 (append) |
| harness/evals/approval.eval.js | 180-240 | Self-approval detail assert |
| scripts/check-plan-approved.sh | 95-140 | Fingerprint-mismatch message (AC#8) |
| scripts/test-check-plan-approved.sh | 160-220 | Tests for AC#8 |
| scripts/deliver-gate-hook.mjs | 20-120 | Carry the script's reason in the block message |
| harness/test/deliver-gate-hook.test.js | 1-120 | Tests for AC#8 |
| scripts/open-pr.sh | 40-110 | Link verification + one re-save + warning (AC#9) |
| scripts/test-open-pr.sh | 1-160 | Tests for AC#9 |
| CLAUDE.md | 219-235 | Git Platform note (AC#10) |

## Execution Notes

### Do Not Touch
- harness/stops.js (classification is unchanged), harness/gates.js, transitions.js
- The `matrix-replay` job and `scripts/check-matrix-replay.sh`
- harness/evals/lib/* (the fixture's `bitbucket.org` origin workaround stays; it still works)

### Key Files
- .github/workflows/ci.yml:125-172; scripts/check-approval-integrity.sh:56-58 (prefix-agnostic slug)
- scripts/get-default-branch.sh:16-29 (CLAUDE.md parsing pattern); scripts/detect-platform.sh
- harness/spine.js `stopRun` (52-72), `approvalChangeReason` (112), `APPROVED_DURING_RUN_REASON` (85); harness/cli.js `reportStop` (894-908)
- scripts/check-plan-approved.sh:100-135; scripts/deliver-gate-hook.mjs `block` (25-28) and its script call (~107)
- scripts/open-pr.sh:40-90; scripts/test-open-pr.sh (stub-`gh` pattern)

### Reminders
- **Byte-identical:** stops without a free-text reason append exactly today's `deliver-stopped` data. No `detail: undefined`; omit the key.
- **Shell-safety lint** on every changed script: guard every positional and `RAD_*` input, and pass variables as arguments. Run `scripts/lint-shell-safety.sh`.
- **Portability:** bash 3.2 (`/bin/bash`) and BSD tools.
- **The registry is fail-closed:** anchors must be distinctive literals verified with `grep -F`.
- **Batch B follows** and adds a step to `deliver-integrity`. Keep this job's shape simple (detect → integrity → scope) so that step appends cleanly.
- **Long final checks** exceed the 2-minute foreground timeout. Run them with `run_in_background`.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (disjoint files).

#### Task 1.1: Deliver-PR detection script
File: scripts/detect-deliver-pr.sh:1-70, scripts/test-detect-deliver-pr.sh:1-100
What: Implement AC#1, following the guardrail-script conventions (header, usage, exit-code block).
Validate: AC#1 — `bash scripts/test-detect-deliver-pr.sh && /bin/bash scripts/test-detect-deliver-pr.sh` (ALL PASS); `scripts/lint-shell-safety.sh` shows no `✗`. A real run `scripts/detect-deliver-pr.sh rad/verification-hardening` prints `verification-hardening`.

#### Task 1.2: detect-platform honors platform:
File: scripts/detect-platform.sh:1-77, scripts/test-detect-platform.sh:1-120
What: Implement AC#4 and AC#5.
Validate: AC#4, AC#5 — both shells ALL PASS for the new test; `test-open-pr.sh`, `test-fetch-epic.sh`, `test-rad-status.sh` and `test-script-hardening.sh` still pass; the shell-safety lint is clean.

#### Task 1.3: Stop detail carried through
File: harness/spine.js:48-75, harness/events.js:16-40, harness/cli.js:890-910, harness/test/spine.test.js:2230-2270, harness/test/cli.test.js:1300-1340
What: Implement AC#6 and the harness-test part of AC#7.
Validate: AC#6, AC#7 — `npm test --prefix harness`; existing spine sequence fixtures are unchanged.

### Wave 2 — parallel
Tasks in this wave can run in parallel (disjoint files). 2.3 depends on 1.1 and 1.3.

#### Task 2.1: Hook names the fingerprint mismatch
File: scripts/check-plan-approved.sh:95-140, scripts/test-check-plan-approved.sh:160-220, scripts/deliver-gate-hook.mjs:20-120, harness/test/deliver-gate-hook.test.js:1-120
What: Implement AC#8. Find where "no approved event" actually originates on the edited-plan path (the hook's own `block()` text, or the gate verb reason), and make the operator-facing message carry the fingerprint-mismatch reason.
Validate: AC#8 — `bash scripts/test-check-plan-approved.sh && /bin/bash scripts/test-check-plan-approved.sh`; `npm test --prefix harness`; `node --test harness/evals/approval.eval.js` (the hook cases still pass, and the mutated twins still fail).

#### Task 2.2: open-pr link verification
File: scripts/open-pr.sh:40-110, scripts/test-open-pr.sh:1-160
What: Implement AC#9.
Validate: AC#9 — both shells ALL PASS; shell-safety clean.

#### Task 2.3: CI wiring, registry, eval assert, CLAUDE.md
File: .github/workflows/ci.yml:125-172, docs/invariants.yaml:1-90, harness/evals/approval.eval.js:180-240, CLAUDE.md:219-235
What: Implement AC#2, AC#3, the eval part of AC#7, and AC#10.
Validate: AC#2, AC#3, AC#7, AC#10, AC#11:
- `ci.yml` parses (js-yaml), and `grep -n "rad/" .github/workflows/ci.yml` shows no `rad/` in `deliver-integrity`
- `scripts/lint-invariants.sh` exits 0
- `node --test harness/evals/*.eval.js` passes
- every AC#11 suite is green

## Tests to Write
- [ ] Deliver-PR detection — scripts/test-detect-deliver-pr.sh
- [ ] Platform setting precedence — scripts/test-detect-platform.sh
- [ ] Stop detail (spine + CLI) — harness/test/spine.test.js
- [ ] Stop detail CLI line — harness/test/cli.test.js
- [ ] Hook and check messages — scripts/test-check-plan-approved.sh
- [ ] Hook block message — harness/test/deliver-gate-hook.test.js
- [ ] PR link verification — scripts/test-open-pr.sh

## Non-Goals
- Changing stop classification, exit codes, or what the hook blocks.
- Closing issues from RAD. The fix verifies GitHub's own linking and warns; it never closes an issue itself.
- Removing the eval fixture's `bitbucket.org` workaround (it keeps working; tidy it later).
- The `matrix-replay` job's `rad/*` fetch.

## Out-of-Scope Dependencies
None. All paths are architect-owned, and the author is the architect.

## Risks
- **The CI job shape changes.** A deliver PR on any prefix now runs `deliver-integrity`, which is intended. A non-deliver PR always runs the (cheap) detect step and skips cleanly.
- **Platform precedence.** Repos that set `platform:` to a value that disagrees with their remote now follow the setting. That's the documented intent, and an invalid value falls back to `manual`, never to a host API.
- **Extra `gh` calls in `open-pr.sh`:** one query per PR open with a closing keyword, plus at most one re-save. They only run when `gh` is present and the platform is GitHub.
- **Self-protected paths:** `harness/`, `scripts/` and `.github/` trigger advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — #154 detection by content.** Architect decision, 2026-09-30. Ambiguity (two plans claiming one branch) fails the job, rather than guessing.
- **ASSUMPTION — #156 invalid value → `manual`.** Fail-closed toward "no host API" rather than falling through to URL detection.
- **ASSUMPTION — #161 field name.** `detail`, because `data.reason` is already the classified reason (the `stopped` value).
- **ASSUMPTION — #163 remedy.** The cause is unexplained (the bodies are identical, and GitHub-side linking silently failed), so the fix is verify, retry once, then warn, and it never closes issues itself.
