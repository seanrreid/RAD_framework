# Plan: Lint-Plan Preflight Checks
Created: 2026-10-22
Author: developer
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-22T15:17:56.972Z
Recorded-By: sean@torchcodelab.com
Branch: rad/lint-plan-preflight-checks
Issue: 298
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
`scripts/lint-plan.sh` catches plan-shape problems before approval, but two defects found while delivering `ui-integrity-critic` slipped through: a `Tests to Write` entry naming a directory (the `check-tests-present.sh` gate tests `-f`, so it can never pass; #298), and a "add to the doc lists" task that declared fewer docs than actually name the sibling items (`check-scope.sh` then failed the wave; #299). This plan adds one advisory warning for each so the author sees them before approval. Option (a) of #298 (running gate scripts from the worktree) is a separate plan.

Closes #299; addresses #298 option (b) only.

## Scope
| In scope | Out of scope |
|---|---|
| Advisory warning: `Tests to Write` entry that is a directory | Running gate scripts from the worktree (#298 option a) |
| Advisory warning: "doc lists" task whose declared files omit docs naming the sibling items | Making `check-tests-present.sh` accept directories (#298 option c) |
| Co-located test file for both checks | Turning either warning into an error or approval blocker |
| One-line docs mention of the new advisories | Changes to `/rad-plan` research prompts |

## Acceptance Criteria
1. `lint-plan.sh` prints `⚠ Tests to Write entry '<path>' is a directory — check-tests-present.sh requires a regular file` (exit 0) when a `Tests to Write` bullet resolves to an existing directory; a bullet naming a file, or a path that does not exist yet, produces no such warning.
2. `lint-plan.sh` prints `⚠ Task <N.M> says "<phrase>" but declares <k> doc file(s); also naming the same items: <up to 5 paths>` (exit 0) when a task `What:` contains "doc list(s)" or "to the list(s)", and a markdown file outside the task's declared files and outside `## Files in Scope` contains a kebab-case token shared by every markdown file the task declares.
3. Check 2 stays silent when the task declares no markdown file, when no shared token exists, or when every file naming the shared tokens is already in `## Files in Scope`.
4. Both checks are advisory: exit code stays 0 with only these findings, they ignore fenced code blocks, and an awk/grep failure fails closed (adds an ERROR via a `*_scan_failed` helper, per the existing pattern).
5. `scripts/test-lint-plan-preflight.sh` (mode 100755) covers, for each check: the warning case, the silent case, and the named edge cases (empty `Tests to Write`, entry with trailing whitespace, entry inside a code fence, task with no `File:` line, zero shared tokens) and passes under `scripts/verify-all.sh`.
6. `docs/configuration.md` lists both advisories alongside the existing lint-plan warnings.

## Agent Scope
Research ran through one Explore sub-agent (read-only). No role-restricted agents called. `scripts/` is a self-protected path: the plan is flagged for architect review.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/lint-plan.sh | 650-665 | Add two short scan functions and their calls after the vague-wording block, before Context budget |
| scripts/test-lint-plan-preflight.sh | 1-160 | New test file: fixtures and assertions for both checks |
| docs/configuration.md | 583-595 | Document the two new advisories next to the existing lint-plan warnings |

## Program Design
Signatures (both in `scripts/lint-plan.sh`, each under ~40 lines per AGENTS.md):
- `scan_directory_tests <plan>` — prints one finding per line; reads `## Tests to Write` bullets with the same trim/resolve rules as `check-tests-present.sh` (lines 62-110), emits a finding when `-d "$entry"`.
- `scan_doc_list_siblings <plan>` — prints one finding per line; per task whose `What:` matches the trigger phrases, collects declared `.md` files, computes kebab-case tokens (two or more hyphen-joined segments) present in all of them, then `grep -rlF` over `*.md` (excluding `.agents/`, `.git/`, `node_modules/`) minus the declared set and `## Files in Scope`.

Control flow: each function is fed through `append_warning_lines` (existing); an awk failure triggers the matching `*_scan_failed` ERROR. Named constants at the top of the file: `DOC_LIST_PHRASE_RE`, `DOC_LIST_MAX_SIBLINGS=5`.

File-tree diff: `+ scripts/test-lint-plan-preflight.sh` (100755); `M scripts/lint-plan.sh`; `M docs/configuration.md`.

## Execution Notes

### Do Not Touch
- `scripts/check-tests-present.sh` — the gate behavior is unchanged here (#298 option c is out of scope)
- `scripts/lib/plan-paths.sh` and `scripts/test-plan-paths.sh` — logic stays in `lint-plan.sh`; touching the lib would force a test-plan-paths extension
- `scripts/lint-shell-safety-baseline.txt`, `scripts/lint-function-length-baseline.txt` — new code must pass, not extend baselines
- `.claude/`, `.codex/` — generated output

### Key Files
- scripts/lint-plan.sh — lines 210-216 (`append_warning_lines`) and 616-659 (vague-wording scan, the model for check 2)
- scripts/check-tests-present.sh — lines 62-110, entry parsing that check 1 must agree with
- scripts/test-lint-plan.sh — lines 44-58 and 1275-1292, helper and test conventions to mirror

### Reminders
- Bash 3.2 compatible: no associative arrays; guard empty arrays under `set -u`; `LC_ALL=C` for awk
- New script must be committed mode 100755 (shell-safety lint)
- Do not edit `scripts/test-lint-plan.sh`; the new file is picked up by the `verify-all.sh` glob

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: Directory-entry advisory
File: scripts/lint-plan.sh:650-665
What: Add `scan_directory_tests` and call it through `append_warning_lines`. Mirror `check-tests-present.sh` entry parsing (strip bullet, checkbox, trailing description after ` — `, whitespace). Skip fenced blocks. Warn only when the resolved path exists and is a directory.
Validate: AC#1, AC#4 — run lint-plan on a fixture whose Tests to Write names `scripts/` and confirm the warning and exit 0

#### Task 1.2: Tests for the directory advisory
File: scripts/test-lint-plan-preflight.sh:1-80
What: Create the test file (mode 100755, `set -euo pipefail`, mktemp -d + trap, `fail()`, one `✓` line per case, final `ALL PASS`). Cases: directory entry warns; file entry silent; nonexistent path silent; empty Tests to Write silent; trailing whitespace; entry inside a code fence silent.
Validate: AC#1, AC#5 — `bash scripts/test-lint-plan-preflight.sh` passes

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Doc-list sibling advisory
File: scripts/lint-plan.sh:665-720
What: Add `scan_doc_list_siblings` and `DOC_LIST_PHRASE_RE`/`DOC_LIST_MAX_SIBLINGS` constants, wired like Task 1.1. Silent when the task declares no `.md`, no shared token exists, or all matching files are already declared. Cap the listed paths at 5.
Validate: AC#2, AC#3, AC#4 — fixture reproducing #299 (task declares two docs, a third names the same sibling) warns; variants stay silent

#### Task 2.2: Tests for the doc-list advisory
File: scripts/test-lint-plan-preflight.sh:80-160
What: Extend the test file with a temp git repo containing docs that share a kebab-case token. Cases: warn; silent with no markdown declared; silent with zero shared tokens; silent when siblings already in Files in Scope; cap at 5 paths; task with no `File:` line; phrase inside a code fence ignored.
Validate: AC#2, AC#3, AC#5 — test file passes

#### Task 2.3: Document the advisories
File: docs/configuration.md:583-595
What: Add two bullets describing the directory-entry and doc-list-sibling advisories, matching the style of the neighboring lint-plan warnings.
Validate: AC#6 — grep the new bullets in the file

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] directory, file, missing-path, empty-section, whitespace and code-fence cases for check 1 — scripts/test-lint-plan-preflight.sh
- [ ] warn, no-markdown, no-shared-token, already-declared, cap and code-fence cases for check 2 — scripts/test-lint-plan-preflight.sh

## Non-Goals
- Running gate scripts from the worktree (#298 option a); that stays its own plan
- Making `check-tests-present.sh` accept directories (#298 option c)
- Making either warning a blocker or error
- Auto-adding the omitted docs to Files in Scope

## Out-of-Scope Dependencies
None

## Risks
- Check 2's shared-token heuristic can be noisy or miss siblings; it is advisory only and capped at 5 paths.
- Adding ~100 lines to an 860-line script risks tripping the function-length lint; keep each function under ~40 lines.
- Edits `scripts/` (self-protected): requires architect review at approval.
