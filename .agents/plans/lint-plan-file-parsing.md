# Plan: Lint-Plan File Parsing
Created: 2026-09-25
Author: architect
Status: complete
Completed-At: 2026-09-25T18:53:13Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-25T18:43:13.351Z
Recorded-By: sean@torchcodelab.com
Branch: rad/lint-plan-file-parsing
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/134
Issue-Title: lint-plan.sh: multi-file task File: lines are never split (paths silently dropped from the classifier), and a bare Lines number counts as N lines

## Context

Task `File:` lines often list several files (`File: a.js:10-20, b.test.js`), but
nothing splits them on commas. `strip_task_file_lines` (`scripts/lib/plan-paths.sh`)
removes everything from the **last** colon, so `a.sh:1-5, b.sh` becomes `a.sh` and
`b.sh` is silently dropped. That path set, `plan_task_files` → `plan_scope_paths`,
feeds `classify-low-risk.sh` and the high-risk, self-protected and freshness checks
in `lint-plan.sh`.

Research confirmed the classifier gap. Take a plan whose table lists only
`docs/guide.md`, whose task line is `File: docs/guide.md:1-5, scripts/classify-low-risk.sh`,
and an allowlist of `^docs/`. Today it classifies **low**: the self-protected script
never enters scope. Lists with no colon produce one merged bogus path instead (the
false warnings seen on every plan this week). `lint-plan.sh`'s per-task existence
loop duplicates the parse instead of using the helper.

Separately, a bare number in the Files-in-Scope Lines column counts as that many
lines. The architect decided (2026-09-25) that it means a single line, matching the
`path:150` convention.

**Critical constraint found in research:** 46 existing `File:` lines already use
commas to list several *line ranges for one file* (`events.js:16-33, 80-96`). The
splitter must treat range-only parts as continuations of the previous path, not as
paths.

## Scope

| In scope | Out of scope |
|---|---|
| One shared comma-splitting helper in `lib/plan-paths.sh`, used by `plan_task_files` | Changing `strip_task_file_lines`'s single-token behaviour (used by `plan_cited_anchors`, `path_exists_on_ref`) |
| `lint-plan.sh`'s per-task existence check uses the helper and warns per missing path | `check-scope.sh` and `check-tests-present.sh`, which don't read task `File:` lines |
| A bare Lines number counts as 1; script and template comments updated | Rewriting historical plans' `File:` lines or comments |
| Regression tests in `test-plan-paths.sh`, `test-lint-plan.sh`, `test-classify-low-risk.sh` | The `contract.js` `File:` emitter and any harness JS parsing |

## Acceptance Criteria

1. A new helper in `scripts/lib/plan-paths.sh` takes one task `File:` value and prints each path on its own line. It splits on commas, trims whitespace, strips backticks, strips each part's own `:lines` suffix (range or single line), and drops empty parts, the `[path]` placeholder, and parts that are **only** a line range (`^[0-9]+(-[0-9]+)?$`, continuations like `80-96`). A value with no commas yields exactly what `strip_task_file_lines` yields today. It is bash-3.2 safe.
2. `plan_task_files` uses the helper, so `plan_scope_paths`, the high-risk and self-protected advisories, the freshness check and `classify-low-risk.sh` all see every path on a multi-file line. `strip_task_file_lines` is unchanged for single tokens.
3. `lint-plan.sh`'s per-task existence check uses the helper (no duplicate parse) and emits one warning per missing path, naming the task and exactly that path. A multi-file line whose paths all exist produces no warning, and a range-continuation line (`a.js:16-33, 80-96`) produces no warning.
4. In the Files-in-Scope Lines column, a bare number counts as **1** line. Ranges are unchanged and non-numeric values are still skipped. The script comment, the `/rad-plan` template comment, and a new equivalent sentence in the `/rad-adopt` template all say so.
5. `scripts/test-classify-low-risk.sh` has a regression case: a table listing only `docs/guide.md` plus a task line `File: docs/guide.md:1-5, scripts/classify-low-risk.sh`, under `RAD_LOW_RISK_PATTERNS='^docs/'`. It classifies **not-low**, citing the self-protected path. (This case would classify low on `main` today.)
6. `scripts/test-plan-paths.sh` and `scripts/test-lint-plan.sh` cover the helper and lint cases above (two- and three-file lines, mixed suffixes, backticks, placeholder, trailing comma, range continuation, the second path missing) and the bare-number budget. Every `scripts/test-*.sh`, `test-bash32-parse.sh` and `lint-shell-safety.sh` (no new findings) pass, and `lint-plan.sh` over every plan in `.agents/plans/` produces no new errors.

## Agent Scope

No agents were called. Research was one Explore sub-agent (10 of 10 searches)
covering `plan-paths.sh`, every caller of the helpers, `lint-plan.sh`,
`classify-low-risk.sh`, `check-scope.sh`, `check-tests-present.sh`, the three test
files, and the template comment locations.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 10-65 | New comma-splitting helper; `plan_task_files` uses it |
| scripts/test-plan-paths.sh | 120-252 | Helper and `plan_task_files` cases |
| scripts/lint-plan.sh | 160-335 | Existence loop uses the helper; bare number counts as 1; comment |
| scripts/test-lint-plan.sh | 120-513 | Multi-file existence cases; bare-number budget cases |
| scripts/test-classify-low-risk.sh | 40-332 | Second-entry self-protected regression case |
| .claude/commands/team/rad-plan.md | 120-130 | Lines comment: a single number is one line |
| .claude/commands/team/rad-adopt.md | 112-124 | Add the same Lines sentence |

## Execution Notes

### Do Not Touch
- `strip_task_file_lines`'s single-token semantics: `plan_cited_anchors` and `path_exists_on_ref` depend on it (existing tests in `test-plan-paths.sh`).
- `RAD_SELF_PROTECTED_PATTERN` in `plan-paths.sh`: a reviewed literal.
- `scripts/check-scope.sh`, `scripts/check-tests-present.sh`: they don't parse task `File:` lines.
- `.agents/plans/*.md`: historical plans are left as they are.
- `scripts/lint-shell-safety-baseline.txt`: it has no entry for these files, so new code must pass the lint without one.
- `harness/**`.

### Key Files
- `scripts/lib/plan-paths.sh`: `strip_task_file_lines`, `plan_files_in_scope` (backtick stripping to mirror), `plan_task_files`, `plan_scope_paths`.
- `scripts/lint-plan.sh`: the per-task existence loop (it keeps `CURRENT_TASK` for warning text), high-risk and self-protected advisories via `plan_scope_paths`, freshness via `plan_task_files`, and the budget block and its comment.
- `scripts/test-lint-plan.sh`: `run_lint`, `write_plan out scope_rows task_file [...]` (takes one `File:` value), `t_*` functions registered in the call list at the bottom, and the exact-output parity case.
- `scripts/test-classify-low-risk.sh`: the fixture (plans committed on the baseline before `git init` / origin), `write_plan` (no task `File:` argument, so extend or append a Wave/Task block), `branch_edit`, and the `t_self_protected_not_low` pattern.
- `scripts/test-plan-paths.sh`: the flat `out=$(fn …)` and `[[ … ]] || fail` assertion style with heredoc fixture plans.

### Reminders
- **Range continuation:** after a `path:range` part, a following part that is only a range belongs to that path. Drop it rather than emitting it as a path.
- No tracked repo path contains a comma, so splitting on commas is safe.
- A prose `File:` value (e.g. "tests in x.js") must still reach the classifier as a part. Never silently drop it, because dropping must fail closed toward not-low. Only empty, placeholder and range-only parts are dropped.
- bash 3.2: no `mapfile`, associative arrays or globstar. Use a `while IFS= read -r` loop over `tr ',' '\n'` output. Case patterns inside `$( )` need a leading `(` or a multi-line form (see #102).
- The budget change only lowers totals, so CI's lint-all-plans step can't gain errors.
- `scripts/` and `.claude/` are self-protected.

## Wave Plan

### Wave 1 — sequential
Verify: bash scripts/test-plan-paths.sh && bash scripts/test-lint-plan.sh && bash scripts/test-bash32-parse.sh && bash scripts/lint-shell-safety.sh

Task 1.2 depends on the helper from Task 1.1.

#### Task 1.1: Shared comma-splitting helper
File: scripts/lib/plan-paths.sh:10-65, scripts/test-plan-paths.sh:120-252
What: Add a helper to `plan-paths.sh` (e.g. `split_task_file_value <value>`) that prints one path per line. It splits on commas, trims, strips backticks, strips each part's `:lines` suffix via `strip_task_file_lines`, and drops empty parts, `[path]`, and range-only parts (`^[0-9]+(-[0-9]+)?$`). Switch `plan_task_files` to call it for each `File:` line. Leave `strip_task_file_lines` unchanged. Tests in `test-plan-paths.sh`, using a heredoc fixture plan and flat assertions:
- `a.js:10-20, b.test.js` gives two paths;
- a three-file line with mixed suffixes (`a.js`, `b.js:10`, `c.md:1-2`) gives three paths;
- `` `a.js`:5 `` gives `a.js`;
- `[path]` and a trailing comma give nothing extra;
- `events.js:16-33, 80-96` gives just `events.js`;
- a comma-free value matches `strip_task_file_lines`;
- `plan_scope_paths` includes a path that appears only as the second entry.

Run under `bash` and `/bin/bash`.
Validate: AC#1, AC#2 — `bash scripts/test-plan-paths.sh` and `/bin/bash scripts/test-plan-paths.sh` pass; the existing `strip_task_file_lines` assertions pass unchanged.

#### Task 1.2: lint-plan existence check and bare-number budget
File: scripts/lint-plan.sh:160-335, scripts/test-lint-plan.sh:120-513
What: Rewrite the per-task existence loop to call the helper for each `File:` line and warn once per missing part. Keep `CURRENT_TASK` in the message and remove the duplicate sed/strip parse. In the budget block, a bare number adds 1. Update the comment ("Plain number "150" → 1 line (a single line reference)"). New `t_*` cases, registered in the call list:
- multi-file line, all present: no File: warning;
- second path missing: exactly one warning naming that path;
- `a.js:16-33, 80-96` (range continuation): no warning;
- a Lines row of `900`: no budget warning;
- a range row still counted: budget warning at over 800.

The existing parity case must still pass.
Validate: AC#3, AC#4 (script half) — `bash scripts/test-lint-plan.sh` and `/bin/bash scripts/test-lint-plan.sh` pass; `for p in .agents/plans/*.md; do bash scripts/lint-plan.sh "$p"; done` shows no new errors versus `main`.

### Wave 2 — parallel
Depends on: Wave 1 complete
Verify: bash scripts/test-classify-low-risk.sh && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done

#### Task 2.1: Classifier regression case
File: scripts/test-classify-low-risk.sh:40-332
What: Let `write_plan` emit a task block (an optional third argument with a `File:` value, or an appended `### Wave 1` / `#### Task 1.1` / `File:` block). Commit a plan whose table lists only `docs/guide.md` and whose task line is `File: docs/guide.md:1-5, scripts/classify-low-risk.sh`, on the baseline before `git init` / origin, so rule 4 sees no drift. On a branch that edits only `docs/guide.md` (the `branch_edit` pattern), run the classifier with `RAD_LOW_RISK_PATTERNS='^docs/'`. Assert exit code 1 (not-low) and the self-protected reason naming `scripts/classify-low-risk.sh`. Add a comment that on `main` before this fix the case classified low.
Validate: AC#5 — `bash scripts/test-classify-low-risk.sh` and `/bin/bash scripts/test-classify-low-risk.sh` pass.

#### Task 2.2: Template comments
File: .claude/commands/team/rad-plan.md:120-130, .claude/commands/team/rad-adopt.md:112-124
What: In `rad-plan.md`'s Files-in-Scope comment, change "a range (e.g. 45-120) or a single number" so it says a single number means one line (for example "45-120, or a single line such as 88"). Add an equivalent sentence to `rad-adopt.md`'s Files-in-Scope comment, which currently covers only the rename rule. Also note in both that a task `File:` line may list several comma-separated files, each with an optional `:lines` suffix.
Validate: AC#4 (template half) — both comments state the rules; every `scripts/test-*.sh` passes.

## Tests to Write
- [ ] split helper covers multi-file, mixed suffixes, backticks, placeholder, trailing comma and range continuation — scripts/test-plan-paths.sh
- [ ] lint existence check warns once per missing path and never for range continuations — scripts/test-lint-plan.sh
- [ ] bare Lines number counts as one line while ranges still count — scripts/test-lint-plan.sh
- [ ] self-protected path as the second File entry classifies not-low — scripts/test-classify-low-risk.sh

## Non-Goals
- Changing how `check-scope.sh` builds its declared set (it reads only the Files-in-Scope table).
- Rewriting historical plans.
- Validating the `contract.js` `File:` emitter format.
- Making prose `File:` values path-aware.

## Out-of-Scope Dependencies
None. Every file is architect-writable.

## Risks
- **The classifier becomes stricter.** Plans that listed a high-risk or self-protected path only as a non-first task `File:` entry were silently classified low before and will now be not-low. That is the correct, fail-closed direction and the point of the fix.
- **New lint warnings on historical plans.** Paths that were dropped before are now existence- and freshness-checked, so warnings may appear, but never errors. The budget change only lowers totals.
- **Range-continuation mis-detection.** A real path that is purely digits (none exist in the repo) would be dropped. This is documented in the helper comment.

## Issue Gaps

- **Range continuation handling.** #134 didn't anticipate the 46 existing `a.js:16-33, 80-96` lines. This plan drops range-only parts as continuations. *Verify: agree?*
- **Prose `File:` values are kept as parts, not filtered.** They'll keep producing an advisory does-not-exist warning, and keep making the classifier say not-low (fail-closed). *Verify: acceptable, versus filtering by path shape?*
- **Backticks are stripped in task `File:` values** to match `plan_files_in_scope`. #134 didn't mention it. *Verify: agree?*
- **`/rad-adopt` gains a Lines sentence it never had.** The issue said "update", but research found the sentence exists only in `/rad-plan`. *Verify: agree?*
