# Plan: Plan-Lint Advisory Checks
Created: 2026-06-12
Author: architect
Status: complete
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-15T14:54:05.948Z
Completed-At: 2026-06-15T15:20:00Z
Branch: rad/plan-lint-advisory-checks

## Context
`scripts/lint-plan.sh` is the existing advisory plan-quality layer; it already
enforces minimum non-goals (≥2), tasks-per-wave (≤3), wave-count (≤5), and
Files-in-Scope path existence — so most of the rad-additions bundle's
deterministic checks are already present. Two genuine gaps remain: per-task
`File:` paths inside Wave tasks are never existence-checked (only the
Files-in-Scope table is), and there is no high-risk file-pattern flag to tell the
architect "look closely here." Separately, `/rad-review` does not currently run
`lint-plan.sh` at all, so its advisories never reach the architect during review.
This plan harvests only those two deterministic checks — as non-blocking
advisories — and wires `/rad-review` to surface lint output. No auto-approval, no
LLM-judged rules, no parallel `policy-check/` subsystem.

## Scope
| In scope | Out of scope |
|---|---|
| Add per-task `File:` path-existence WARNING to `lint-plan.sh` | Re-implementing checks `lint-plan.sh` already does (non-goals, task/wave counts) |
| Add a high-risk file-pattern advisory WARNING, patterns declared/configurable | Any auto-approval, escalation, or blocking behavior |
| Declare + document the high-risk pattern default and its env override | The bundle's LLM-judged rules and token/cost cap |
| Wire `/rad-review` to run `lint-plan.sh` and surface its advisory output | A `scripts/policy-check/` subsystem, GitHub Action, bot, or `/rad-policy-check` |

## Acceptance Criteria
1. `lint-plan.sh` emits a WARNING for any `#### Task` `File:` path that does not
   exist on disk (after stripping a trailing `:lines` suffix), and emits none
   when every task `File:` path exists.
2. `lint-plan.sh` emits an advisory WARNING flagging any Files-in-Scope or task
   `File:` path matching a high-risk pattern, naming the path and telling the
   architect to review it closely.
3. `/rad-review` runs `lint-plan.sh` against the plan under review and surfaces
   its advisory output to the architect (it does not today).
4. High-risk patterns are declared and configurable — a documented default set,
   overridable via a `RAD_HIGH_RISK_PATTERNS` env var (following the
   `RAD_BRANCH_PREFIX` convention) — not business logic hardcoded in the script,
   and the knob is documented in CLAUDE.md.
5. The two new checks never change `lint-plan.sh`'s exit code on their own: an
   otherwise-valid plan still exits 0 even when it emits missing-task-file or
   high-risk advisories — they are warnings, never errors.

## Agent Scope
Architect scope over `scripts/`, `.claude/commands/`, and `CLAUDE.md` (this repo
self-hosts RAD; the Agent Scope Map is unpopulated). No out-of-scope agents.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/lint-plan.sh | 130-245 | Add two advisory WARNING checks: per-task `File:` existence, and high-risk pattern flag (default list + `RAD_HIGH_RISK_PATTERNS` override). Both warn-only — never touch the ERROR path/exit code. |
| .claude/commands/team/rad-review.md | 20 | Add a review step that runs `lint-plan.sh` on the plan and reports its advisory warnings to the architect; keep it separate from the existing `check-scope.sh` step. |
| CLAUDE.md | 18 | Document the high-risk pattern default and the `RAD_HIGH_RISK_PATTERNS` override in the RAD Configuration section. |
| scripts/test-lint-plan.sh | 1-120 | New dedicated test (per `test-check-scope.sh` convention) covering both new advisories and exit-code invariance. |

## Execution Notes

### Do Not Touch
- `scripts/check-scope.sh`, `scripts/check-tests.sh` — unrelated deliver-time
  gates; the new advisories live only in `lint-plan.sh`.
- The existing checks in `lint-plan.sh` (non-goals min, task/wave ceilings,
  Files-in-Scope existence, budget) — do not duplicate or alter them.
- `rad-review.md` Step 2 (`check-scope.sh`) — add a *new* step that runs
  `lint-plan.sh`; do not fold lint advisories into the scope-check step.

### Key Files
- `scripts/lint-plan.sh` — mirror its existing helpers (`has_section`,
  `section_content`, `header_field`) and its table/task parsing style
  (`grep -E '^\|'` + `awk -F '|'` for tables; `while read` matching
  `^#### Task` for task blocks). New checks append to the `WARNINGS` array.
- `scripts/test-script-hardening.sh` — the bash test-harness style to follow
  (temp fixtures, `fail()` helper, trap cleanup, grep assertions, no framework).
- `scripts/test-check-scope.sh` — the dedicated per-script test naming/shape the
  new `test-lint-plan.sh` follows.

### Reminders
- The two new checks must append to `WARNINGS`, never `ERRORS` — AC#5 is the
  whole point of "advisory."
- Task `File:` lines carry a `path:lines` form (e.g. `harness/cli.js:290-410`);
  strip the `:lines` suffix before the existence test, and treat a directory as
  existing (parity with the Files-in-Scope existence check).
- `RAD_HIGH_RISK_PATTERNS="${RAD_HIGH_RISK_PATTERNS:-<default>}"` — default to a
  generic set (auth, payment, billing, migration, secret, credential, token);
  the default is generic infra-risk wording, not project business logic.

## Wave Plan

### Wave 1 — sequential
Both tasks edit `lint-plan.sh`; run in sequence to avoid conflict.

#### Task 1.1: Per-task File: existence advisory
File: scripts/lint-plan.sh:130-245
What: Parse every `#### Task` block's `File:` line, strip any trailing `:lines`
suffix, and for each path that is neither a file nor a directory on disk, append
a WARNING naming the task and the missing path. Reuse the existing Files-in-Scope
existence style. Do not add to ERRORS.
Validate: AC#1 — missing task File: path warns; all-present warns nothing. AC#5 — exit code unchanged.

#### Task 1.2: High-risk pattern advisory
File: scripts/lint-plan.sh:130-245
What: Read `RAD_HIGH_RISK_PATTERNS` (env override; documented generic default).
Over the union of Files-in-Scope paths and task `File:` paths, append a WARNING
for any path matching a pattern, naming the path and advising close architect
review. Warn-only.
Validate: AC#2 — high-risk path warns; AC#4 — env override changes the matched set; AC#5 — exit code unchanged.

### Wave 2 — parallel
Depends on: Wave 1 complete

#### Task 2.1: Surface lint advisories in /rad-review
File: .claude/commands/team/rad-review.md:20
What: Add a review step that runs `scripts/lint-plan.sh` against the plan under
review and reports its advisory warnings to the architect, distinct from the
existing `check-scope.sh` step. Advisory only — does not gate the review.
Validate: AC#3 — /rad-review runs lint-plan.sh and shows its output.

#### Task 2.2: Document the high-risk pattern knob
File: CLAUDE.md:18
What: In the RAD Configuration section, document the high-risk pattern default
and the `RAD_HIGH_RISK_PATTERNS` override, alongside `RAD_BRANCH_PREFIX` /
`RAD_TOKEN_BUDGET`.
Validate: AC#4 — patterns are declared/configurable and documented.

### Wave 3 — sequential
Depends on: Wave 1 complete

#### Task 3.1: Dedicated lint-plan advisory tests
File: scripts/test-lint-plan.sh:1-120
What: New test in the repo's bash-harness style: fixture plans asserting (a) a
missing task `File:` path emits a warning and an all-present plan does not; (b) a
high-risk path emits the advisory and `RAD_HIGH_RISK_PATTERNS` override changes
what matches; (c) a plan that is otherwise valid still exits 0 with only these
advisories present.
Validate: AC#1, AC#2 — both advisories asserted; AC#5 — exit-0 invariance asserted.

## Tests to Write
- [ ] Missing task `File:` path → warning; all-present → no such warning — scripts/test-lint-plan.sh
- [ ] High-risk path → advisory warning; `RAD_HIGH_RISK_PATTERNS` override changes matches — scripts/test-lint-plan.sh
- [ ] Otherwise-valid plan with only new advisories still exits 0 — scripts/test-lint-plan.sh

## Non-Goals
- No auto-approval, escalation, or blocking — every new check is a non-fatal
  WARNING; the architect still decides via `/rad-approve`.
- No `scripts/policy-check/` subsystem, GitHub Action, bot account, or
  `/rad-policy-check` command.
- No LLM-judged rules and no token/cost cap from the bundle.
- No re-implementation of checks `lint-plan.sh` already performs (non-goals
  minimum, task-per-wave, wave-count, Files-in-Scope existence).

## Out-of-Scope Dependencies
None.

## Risks
- **False-positive high-risk flags.** A generic default pattern set may flag
  benign paths. Mitigation: advisory-only (never blocks) and overridable via
  `RAD_HIGH_RISK_PATTERNS`.
- **Task File: parsing drift.** If task-block parsing diverges from the existing
  style, paths could be missed. Mitigation: reuse the existing `#### Task` /
  `File:` parsing; tests assert both present and missing cases.
- **Double-reporting in /rad-review.** Running `lint-plan.sh` in review could
  echo warnings the author already saw. Mitigation: it is advisory context for
  the architect at the gate; acceptable and intended.
