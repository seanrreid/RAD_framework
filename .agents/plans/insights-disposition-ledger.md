# Plan: Insights Disposition Ledger
Created: 2026-11-06
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-06T16:17:03.568Z
Recorded-By: sean@torchcodelab.com
Branch: rad/insights-disposition-ledger
Source-Author: none (no source issue)
Source-Comments: none

## Context
`scripts/draft-insights-plan.sh` counts every `type=="finding"` per category across the whole `.agents/findings.jsonl` with no date window, and nothing records what happened to a category after a plan was drafted. A category that once crossed `RAD_FINDINGS_THRESHOLD` therefore crosses it on every later run, even after its convention shipped or the architect declined it. This plan adds an append-only disposition ledger and makes the drafter count only findings dated after a category's latest ledger entry. Dispositions are recorded on the architect's approval path, through both a `rad-approve` skill step and a `rad approve` flag.

## Scope
| In scope | Out of scope |
|---|---|
| New append-only `.agents/insights-ledger.jsonl` (one row per category disposition: adopted, declined, deferred) | Rewriting or tagging rows in `findings.jsonl` |
| Drafter counts only findings dated after the category's latest ledger entry; skips unexpired `declined` | Mining session traces or deliver logs as a new findings source |
| A validated append-only writer script for one ledger row | Staleness tracking of conventions or findings |
| Recording on the approval path: a `rad-approve` skill step and a `--disposition` flag on `rad approve` | Inferring a disposition from `rad plan-status ... rejected` or any plan status |
| A sibling append-only check for the ledger, wired into `verify-all.sh`, CI and the invariants registry | Changing `check-events-append-only.sh` or `RAD_FINDINGS_THRESHOLD` semantics |
| `/rad-insights` skill source and docs updates | Any change to the gate fold (`gates.js`, `events.js`, `transitions.js`) |

## Acceptance Criteria
1. With a missing or empty `.agents/insights-ledger.jsonl`, `draft-insights-plan.sh` produces exactly the output it produces today (no behavior change without a ledger).
2. A category whose latest ledger row has date D counts only findings with `date` strictly after D; a finding dated exactly D does not count; a category with no ledger row counts all findings.
3. A category whose latest ledger row is `declined` and unexpired is skipped, and the drafted plan or the `nothing to draft` output states the category was skipped and why. An expired `declined` row stops suppressing the category.
4. A malformed ledger row (invalid JSON, missing `category`, `disposition` or `date`, unknown `disposition`) makes the drafter exit 2 naming the line, never silently ignoring it.
5. A ledger row can be appended only through `record-insights-disposition.sh`, which validates the row and refuses to alter or remove an existing line or to append to an already malformed ledger.
6. `rad approve <feature> --disposition <category>:<disposition>[:<reason>]` (repeatable) validates every disposition before recording the approval, then appends the rows; an invalid disposition exits non-zero with no approval recorded and no row written; a ledger-append failure after approval is reported with a non-zero exit, never swallowed.
7. The `rad-approve` skill source has a step that, for an `insights-proposals` plan, asks the architect per category and calls the recording script (or passes `--disposition`).
8. `check-ledger-append-only.sh` fails a diff that removes or modifies an existing ledger line or adds a malformed row, passes a pure append of valid rows and passes when the ledger is untouched; it runs in `verify-all.sh` and CI, and is registered in `docs/invariants.yaml`.
9. `.rad/skills/rad-insights/SKILL.md` and `docs/daily-workflow.md` describe the ledger, the baseline rule, the declined skip and how to record a disposition, and the generated copies are regenerated from the sources.

## Agent Scope
Research was run inline by the planner (no sub-agent). No architect-only agent is called. The plan touches `scripts/`, `harness/` and `.rad/`, all self-protected paths, so it requires architect review.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/lib/insights-ledger.sh | 1-80 | New: read, validate, baseline and expiry helpers for the ledger |
| scripts/test-insights-ledger.sh | 1-120 | New: fixture tests for the helpers |
| scripts/draft-insights-plan.sh | 86-96 | `crossing_rows` counts only findings after the baseline |
| scripts/draft-insights-plan.sh | 273-306 | `main` loads the ledger, skips declined categories, reports skips |
| scripts/test-draft-insights-plan.sh | 200-248 | New cases for baseline, declined skip, expiry, malformed ledger |
| scripts/record-insights-disposition.sh | 1-90 | New: validated append-only writer for one ledger row |
| scripts/test-record-insights-disposition.sh | 1-100 | New: fixture tests for the writer |
| .rad/skills/rad-approve/SKILL.md | 390-456 | Step 4: disposition prompt for insights-proposals plans (source file) |
| .agents/skills/rad-approve/SKILL.md | 392-460 | Generated copy, regenerated from the source by `rad generate` |
| .claude/commands/architect/rad-approve.md | 392-460 | Generated copy, regenerated from the source by `rad generate` |
| .agents/skills/rad-approve/agents/openai.yaml | 1-30 | Generated; regenerated alongside the skill (expected unchanged) |
| harness/cli.js | 86-86 | `APPROVE_USAGE` gains `--disposition` |
| harness/cli.js | 2785-2905 | `approveCommand` parses, validates and applies `--disposition` |
| harness/test/cli-approve-disposition.test.js | 1-120 | New: tests for the flag |
| scripts/check-ledger-append-only.sh | 1-90 | New: sibling append-only check for the ledger |
| scripts/test-check-ledger-append-only.sh | 1-110 | New: fixture tests for the check |
| scripts/verify-all.sh | 72-72 | Add a `ledger-append-only` check entry |
| .github/workflows/ci.yml | 72-82 | Add a thin job invoking the sibling check |
| docs/invariants.yaml | 112-120 | Register the ledger append-only invariant |
| .rad/skills/rad-insights/SKILL.md | 79-140 | Document the ledger, baseline and declined skip (source file) |
| .agents/skills/rad-insights/SKILL.md | 81-145 | Generated copy, regenerated from the source by `rad generate` |
| .claude/commands/shared/rad-insights.md | 81-145 | Generated copy, regenerated from the source by `rad generate` |
| .agents/skills/rad-insights/agents/openai.yaml | 1-30 | Generated; regenerated alongside the skill (expected unchanged) |
| docs/daily-workflow.md | 468-492 | Document the ledger beside `--draft-plans` |

## Program Design
Signatures (shell, `scripts/lib/insights-ledger.sh`):
- `ledger_validate <file>` — exit 0 when every row is valid or the file is absent or empty; exit 2 and print `file:line: reason` otherwise.
- `ledger_baseline <file> <category>` — print the date of the category's latest row, or nothing.
- `ledger_declined_active <file> <category> <today>` — exit 0 when the latest row is `declined` and unexpired.

Row shape: `{"type":"disposition","category":"testing","disposition":"adopted|declined|deferred","date":"YYYY-MM-DD","expires":"YYYY-MM-DD"?,"reason":"...","ref":"<convention or lint it became>"?,"actor":"..."}`.

Drafter flow: `main` → `ledger_validate` → `crossing_rows` (jq filters findings by `date > baseline`) → drop `ledger_declined_active` categories into a skipped list → render.

Approve flow: `approveCommand` → parse and validate every `--disposition` (fail before any write) → record approval as today → run `record-insights-disposition.sh` per row; a failed append returns non-zero and is reported, the already-recorded approval is not undone.

File-tree diff: add `scripts/lib/insights-ledger.sh`, `scripts/record-insights-disposition.sh`, `scripts/check-ledger-append-only.sh`, their `test-*.sh` fixtures, and `harness/test/cli-approve-disposition.test.js`.

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/events.js, harness/transitions.js, harness/gates.yaml — the gate fold and event writer are read-only for this plan
- scripts/check-events-append-only.sh — unchanged; the ledger gets a sibling check
- .agents/findings.jsonl — never rewritten
- Never hand-edit the generated copies under `.agents/skills/` and `.claude/commands/`: edit the `.rad/skills/` source and run `rad generate`. The regenerated rad-approve and rad-insights copies are declared in Files in Scope; no other generated file may change.

### Key Files
- scripts/draft-insights-plan.sh — the drafter being changed
- scripts/test-draft-insights-plan.sh — hermetic GREPO fixture to extend
- scripts/check-events-append-only.sh — the append-only pattern to mirror
- harness/test/cli-approve-commit.test.js — the existing approve test pattern

### Reminders
- New scripts must be mode 100755 (shell-safety lint) and ship a co-located `test-*.sh` fixture.
- Dates are `YYYY-MM-DD` strings; compare them lexically with a strict `>`.
- bash 3.2 compatible (macOS): no `declare -A`.
- `harness/cli.js` edits keep functions under ~40 lines: put `--disposition` parsing in a small helper.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: Ledger helper library
File: scripts/lib/insights-ledger.sh:1-80
What: Implement `ledger_validate`, `ledger_baseline` and `ledger_declined_active` per Program Design. A missing or empty file is valid. Use jq; fail closed on a row that does not parse.
Validate: AC#1, AC#2, AC#4 — `bash scripts/test-insights-ledger.sh`; edge cases: missing file, empty file, malformed row, unknown disposition, baseline date equal to a finding date.

#### Task 1.2: Helper tests
File: scripts/test-insights-ledger.sh:1-120
What: Fixture tests covering each edge case named in Task 1.1, plus an expired `declined` row, a category present in the ledger with no findings, and a latest-row-wins case with several rows for one category.
Validate: AC#2, AC#3, AC#4 — `bash scripts/test-insights-ledger.sh` exits 0 with `ALL PASS`.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Drafter honors the ledger
File: scripts/draft-insights-plan.sh:86-96, 273-306
What: `crossing_rows` counts only findings dated after the category baseline. `main` validates the ledger (exit 2 on a bad row), skips unexpired `declined` categories, and records the skips so the plan Context, or the `nothing to draft` line, names each skipped category and its reason. No ledger means unchanged output.
Validate: AC#1, AC#2, AC#3, AC#4 — `bash scripts/test-draft-insights-plan.sh`; edge cases: count == threshold still drafts, all categories declined prints `nothing to draft` with the reason.

#### Task 2.2: Drafter tests
File: scripts/test-draft-insights-plan.sh:200-248
What: Add cases for baseline reset, strict `>` on the baseline date, declined skip, declined expiry, malformed ledger exit 2, absent ledger unchanged output.
Validate: AC#1, AC#2, AC#3, AC#4 — `bash scripts/test-draft-insights-plan.sh` exits 0 with `ALL PASS`.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Recording script and its tests
File: scripts/record-insights-disposition.sh:1-90, scripts/test-record-insights-disposition.sh:1-100
What: `record-insights-disposition.sh <category> <adopted|declined|deferred> --reason <text> [--ref <text>] [--expires <date>]` validates input, appends exactly one row with the architect (from `git config user.email`) as `actor`, and refuses to alter an existing line or to append to a malformed ledger.
Validate: AC#5 — `bash scripts/test-record-insights-disposition.sh`; edge cases: empty category, unknown disposition, `expires` earlier than `date`, ledger absent (created), existing malformed ledger (refuse), reason containing quotes or newlines.

#### Task 3.2: `rad approve --disposition`
File: harness/cli.js:86, 2785-2905, harness/test/cli-approve-disposition.test.js:1-120
What: Add a repeatable `--disposition <category>:<disposition>[:<reason>]` flag. Validate every value before recording the approval, then call the recording script per row after approval. A failed append exits non-zero with the reason on stderr.
Validate: AC#6 — `node --test harness/test/cli-approve-disposition.test.js`; edge cases: no flag (behavior unchanged), invalid disposition (nothing written), reason containing `:`, two flags for one category (latest wins), append failure after approval.

#### Task 3.3: `rad-approve` skill step
File: .rad/skills/rad-approve/SKILL.md:390-456, .agents/skills/rad-approve/SKILL.md:392-460, .claude/commands/architect/rad-approve.md:392-460, .agents/skills/rad-approve/agents/openai.yaml:1-30
What: For an `insights-proposals-*` plan, extend Step 4 (record the approval) so that the architect confirms a disposition per category and the skill calls `rad approve ... --disposition` (or the recording script). Run `node harness/cli.js generate` so the generated copies match.
Validate: AC#7 — `node harness/cli.js generate` then `git status` shows only the expected generated files changed; the skill text names the flag and the recording script.

### Wave 4 — sequential
Depends on: Wave 3 complete

#### Task 4.1: Sibling append-only check
File: scripts/check-ledger-append-only.sh:1-90, scripts/test-check-ledger-append-only.sh:1-110
What: `check-ledger-append-only.sh <base-ref> [head-ref]` mirrors `check-events-append-only.sh` for `.agents/insights-ledger.jsonl`: fail on any removed or modified line, validate each added line against the ledger row schema, fail closed on unresolvable refs, pass with a notice when the ledger is untouched.
Validate: AC#8 — `bash scripts/test-check-ledger-append-only.sh`; edge cases: no ledger change (pass), pure append (pass), edited line (fail), deleted line (fail), malformed added row (fail), unresolvable ref (fail closed).

#### Task 4.2: Wire the check
File: scripts/verify-all.sh:72, .github/workflows/ci.yml:72-82, docs/invariants.yaml:112-120
What: Add a `ledger-append-only` entry to `verify-all.sh`, a thin CI job that only invokes the script (no check logic in the YAML), and an invariants-registry entry pointing at the script.
Validate: AC#8 — `bash scripts/lint-invariants.sh` and `bash scripts/verify-all.sh` pass; the registry entry cites the script and a symbol present in it.

### Wave 5 — sequential
Depends on: Wave 4 complete

#### Task 5.1: Skill source and regeneration
File: .rad/skills/rad-insights/SKILL.md:79-140, .agents/skills/rad-insights/SKILL.md:81-145, .claude/commands/shared/rad-insights.md:81-145, .agents/skills/rad-insights/agents/openai.yaml:1-30
What: Describe the ledger, the baseline-by-date rule, declined skip and expiry in Step 3b and the `--draft-plans` block, then run `node harness/cli.js generate`.
Validate: AC#9 — `node harness/cli.js generate` then `git status` shows only the expected generated files changed.

#### Task 5.2: Workflow docs
File: docs/daily-workflow.md:468-492
What: Add a subsection under `--draft-plans` covering the ledger path, row shape, the baseline rule, `--disposition` and the recording script.
Validate: AC#9 — `bash scripts/lint-claude-md.sh` passes and the section names the ledger path, the flag and the script.
Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] ledger helper edge cases — scripts/test-insights-ledger.sh
- [ ] drafter baseline, declined skip, expiry, malformed ledger — scripts/test-draft-insights-plan.sh
- [ ] recording script validation and append-only refusal — scripts/test-record-insights-disposition.sh
- [ ] `rad approve --disposition` behavior — harness/test/cli-approve-disposition.test.js
- [ ] ledger append-only check cases — scripts/test-check-ledger-append-only.sh

## Non-Goals
- Mining session traces or deliver logs for new findings (a separate, larger design)
- Detecting stale conventions or findings
- Auto-recording a disposition without the architect's action, or inferring one from plan status
- Changing how findings are written or reviewed
- Modifying the existing events append-only check

## Out-of-Scope Dependencies
None

## Risks
- Changing `crossing_rows` could alter drafts for existing users if the ledger path is read wrongly; AC#1 pins unchanged output when the ledger is absent.
- `harness/cli.js` is a self-protected, large file; the flag is the only change there, and the approval itself is recorded exactly as today. If the post-approval append fails, the approval stands and the ledger row is missing, so the architect gets a loud non-zero exit and re-runs the recording script.
- The plan carries 11 tasks across 5 waves, the lint maximum; any further growth should split into a second plan.
