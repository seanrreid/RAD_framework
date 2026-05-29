# Plan: Script hardening — portability + parsing fixes (issues #3 #4 #6 #7)
Created: 2026-05-29
Author: developer
Status: complete
Branch: rad/script-hardening
Approved-By: Sean R Reid
Approved-At: 2026-05-29T00:00:00Z
Completed-At: 2026-05-29T00:00:00Z

## Context
Batches four small, independent script fixes surfaced by the recent reviews and
the issue-#2 delivery: a log-listing recency/space bug ([#3](https://github.com/seanrreid/RAD_framework/issues/3)),
non-portable GNU `\|` grep alternation in several scripts ([#4](https://github.com/seanrreid/RAD_framework/issues/4)),
the `rad:deliver` label never being created so the first deliver PR fails on a
fresh repo ([#6](https://github.com/seanrreid/RAD_framework/issues/6)), and
`check-tests.sh`/`check-scope.sh` not resolving backtick-wrapped test paths
([#7](https://github.com/seanrreid/RAD_framework/issues/7)). All are `scripts/` or
`install.sh` changes with no cross-dependencies.

## Scope
| In scope | Out of scope |
|---|---|
| `rad-status.sh` log listing (recency + spaces) | `open-pr.sh` (issue #2 — already fixed) |
| Replacing GNU `\|` grep alternation in check-role/check-scope/lint-plan | `rad-label.sh` (status-label mirror — unrelated) |
| Creating `rad:deliver` at install time | `detect-platform.sh`, CLAUDE.md, `.agents/` |
| Stripping backticks from test paths in check-tests/check-scope | Any new command or skill |

## Acceptance Criteria
1. `rad-status.sh` lists the most-recent execution logs in correct modification-time order without depending on `xargs` batch size, and tolerates spaces in log filenames — using only POSIX/BSD-portable tools (no GNU `find -printf`).
2. No RAD script relies on GNU-only `\|` grep alternation; the placeholder/blank-line filter (check-role) and the markdown-table-row filters (check-scope, lint-plan) produce identical results under BSD grep, with literal table pipes preserved.
3. A fresh `install.sh` run results in the `rad:deliver` label existing (created if missing, idempotent, graceful no-op without `gh`), so the first `/rad-deliver` PR does not fail with "label not found".
4. `check-tests.sh` and `check-scope.sh` resolve a test path written in Markdown backticks — e.g. a line ending `` — `scripts/foo.sh` `` resolves to `scripts/foo.sh` — for both the in-scope and missing-file cases.
5. A committed test (`scripts/test-script-hardening.sh`) exercises #3, #4, and #7 and passes under both bash 5.x and bash 3.2; `bash -n` passes on every changed script.

## Agent Scope
Explore sub-agent (research only). No role-restricted agents (no populated Agent
Scope Map). No out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/rad-status.sh | 126-139 | Replace `find\|xargs ls -t` with portable `ls -t` glob + guard |
| scripts/check-role.sh | 70 | Split the `\|` filter into two `grep -v` calls |
| scripts/check-scope.sh | 44, 50-56 | Split table-row `\|` grep; strip backticks from captured test path |
| scripts/lint-plan.sh | 146, 172, 201 | Split table-row `\|` greps into two `grep -v` calls |
| scripts/check-tests.sh | 28-30 | Strip backticks from captured test path |
| install.sh | 230-245 | Add idempotent `rad:deliver` label creation at install time |
| scripts/test-script-hardening.sh | new | Stub-based assertions for #3/#4/#7 (bash 3.2 + 5.x) |

## Execution Notes

### Do Not Touch
- `scripts/open-pr.sh` — issue #2, already fixed and merged
- `scripts/rad-label.sh` — separate status-label mirror; changing it affects all status labels
- `scripts/detect-platform.sh` — unrelated platform detection

### Key Files
- `scripts/check-scope.sh` — touched by BOTH #4 (table grep) and #7 (backtick); do its edits in one task to avoid a same-file collision
- `scripts/test-open-pr.sh` — the precedent for stub-based committed tests; mirror its structure
- `install.sh` — `next_steps()` currently only PRINTS the `gh label create rad:deliver` instruction; #6 turns that into an actual idempotent call

### Reminders
- **Do NOT blanket-convert `\|` to `grep -E`.** check-scope/lint-plan patterns contain literal table pipes (`^| *File`); under `-E` those become alternation and match everything. Use two piped `grep -v` calls (pure BRE, no alternation) instead.
- **Do NOT use GNU `find -printf`** for #3 — BSD `find` (macOS) lacks it. Use `ls -t` on the glob with a `|| true` guard for the no-match case.
- Label creation must no-op gracefully when `gh` is unavailable (mirror `rad-label.sh`'s guard).

## Wave Plan

### Wave 1 — sequential
Tasks share no parallel-safe file boundary (1.1 and 1.2 both edit check-scope.sh), so run in sequence.

#### Task 1.1: Replace GNU `\|` grep alternation (issue #4)
File: scripts/check-role.sh:70, scripts/check-scope.sh:44, scripts/lint-plan.sh:146, scripts/lint-plan.sh:172, scripts/lint-plan.sh:201
What: Replace each `grep -v "A\|B"` with two piped pure-BRE filters `grep -v "A" | grep -v "B"`. For the table-row patterns, that is `grep -v "^| *File" | grep -v "^|[-| ]*$"` — preserving the literal `|` characters. For check-role: `grep -v "^$" | grep -v "^\[your GitHub"`. Do NOT introduce `-E`.
Validate: AC#2 — no `\|` remains in any script grep; the table filters and placeholder filter return identical results to before under BSD-style BRE (verified by the test harness feeding known input).

#### Task 1.2: Strip backticks from captured test paths (issue #7)
File: scripts/check-tests.sh:29-30, scripts/check-scope.sh:50-56
What: After capturing the path from a "Tests to Write" line, strip surrounding backticks before the `-f` test, e.g. `testfile="${testfile//\`/}"` then trim whitespace. Apply the identical fix in both scripts (shared regex). (Done after 1.1 since it also edits check-scope.sh.)
Validate: AC#4 — a fixture plan line ``- [ ] t — `scripts/test-script-hardening.sh` `` resolves to the bare path; check-tests reports it present and check-scope allows it.

#### Task 1.3: Portable, space-safe execution-log listing (issue #3)
File: scripts/rad-status.sh:126-139
What: In `collect_logs()`, replace `find ... | xargs ls -t 2>/dev/null | head -5` with a single-invocation `ls -t "$logs_dir"/*.md 2>/dev/null | grep -v 'README\.md' | head -5 || true` piped into the existing `while read -r log_file`. This sorts the whole set by mtime in one call (no xargs batching) and `read -r` tolerates spaces. Guard the no-match case so `set -euo pipefail` is not tripped.
Validate: AC#1 — with several stub log files of differing mtimes (incl. one with a space), the listing is newest-first and unmangled; runs clean under bash 3.2.

### Wave 2 — sequential
Depends on: Wave 1 complete.

#### Task 2.1: Create `rad:deliver` at install time (issue #6)
File: install.sh:230-245
What: Add an idempotent label-creation step (new helper, e.g. `ensure_deliver_label()`) that runs `gh label create rad:deliver --color 0e8a16 --description "RAD delivery PR" 2>/dev/null || true` when `gh` is available and authenticated, and no-ops otherwise (mirror `rad-label.sh`'s gh guard). Keep the printed instruction as a fallback note for non-gh setups. Wire it into the install flow.
Validate: AC#3 — in a temp repo with a stubbed `gh` capturing args, a run creates `rad:deliver`; with `gh` absent the installer still succeeds (no error).

## Tests to Write
<!-- One committed stub-based harness, following the scripts/test-open-pr.sh precedent.
     Paths intentionally un-backticked so the (pre-fix) check-tests.sh can resolve them;
     once #7 lands, backticked paths resolve too and this is belt-and-suspenders. -->
- [ ] #3 rad-status lists logs newest-first, space-safe, under bash 3.2 — scripts/test-script-hardening.sh
- [ ] #4 check-role/check-scope/lint-plan grep filters work under BRE with literal table pipes preserved — scripts/test-script-hardening.sh
- [ ] #7 check-tests.sh and check-scope.sh resolve a backtick-wrapped test path — scripts/test-script-hardening.sh

## Non-Goals
- Do not change `open-pr.sh` (issue #2 is done) or `rad-label.sh`
- Do not add a general test-harness framework — keep the lightweight stub-script precedent
- Do not refactor the grep/awk parsing beyond the minimal portability/backtick fixes
- Do not alter label names, the `rad:` taxonomy, or status semantics

## Out-of-Scope Dependencies
None.

## Risks
- The table-row grep patterns are subtle: an incorrect `-E` conversion would silently drop all rows (Files-in-Scope/budget parsing). The split-`grep -v` approach avoids this; the test must assert the filters still match the right lines.
- `ls -t` glob with no matches can trip `pipefail`; the `|| true` guard and the existing `[[ ! -d "$logs_dir" ]] && return` must both be present.
- `install.sh` label creation must never fail the install when `gh` is missing/unauthenticated.
