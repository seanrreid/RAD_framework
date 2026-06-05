# Plan: rad status CLI subcommand
Created: 2026-06-05
Author: architect
Status: complete
Completed-At: 2026-06-05T20:10:00Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-05T19:50:38.457Z
Branch: rad/rad-status-cli

## Context
`harness/cli.js` now has `rad approve` and `rad deliver`, but `/rad-status` still
runs entirely through the prose command and `scripts/rad-status.sh`. The harness
already exposes `state.list()` on the git state store, which returns all features
with their current phase — the exact data `rad status` needs without any branch
fan-out. This plan adds the `status` subcommand, completing the three-verb CLI
surface originally scoped in Issue #13.

## Scope
| In scope | Out of scope |
|---|---|
| `status` subcommand in `harness/cli.js` | Full `/rad-status` prose replacement (PRs, logs, agent inventory stay in the prose command) |
| Optional `--phase <filter>` flag to narrow results | Changing `scripts/rad-status.sh` |
| `node --test` coverage for status output and filter | Decision 2 (dual-write removal) |
| Note in `/rad-status` prose pointing to `rad status` | `/rad-plan`, `/rad-design` CLI cutovers |

## Acceptance Criteria
1. `node harness/cli.js status` reads `.agents/state/` via `state.list()` and prints
   a formatted table with columns: Feature, Status, Branch — one row per known
   feature; exits 0 (including when the table is empty).
2. `node harness/cli.js status --phase <value>` filters the table to only features
   whose phase matches `<value>` (e.g. `--phase approved`); exits 0.
3. `node harness/cli.js status --help` and `node harness/cli.js --help` both exit 0
   and include `status` in the output.
4. `/rad-status` prose command includes a note that `rad status` is available for
   a quick harness-internal feature table; the full prose output (PRs, execution
   logs, agent inventory) is unchanged.
5. `node --test` coverage: status prints one row per feature (AC#1), `--phase`
   filter returns only matching features (AC#2), bare status with no state returns
   an empty-table message and exits 0 (AC#1 edge case).

## Agent Scope
Explore sub-agent (research only, read-only). All wave execution within architect
scope.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 30-43 + ~80 new | Add status entry to SUBCOMMANDS; parseStatusArgs; statusCommand |
| harness/test/status.test.js | new file ~120 | node --test cases for AC#1, AC#2, AC#5 edge case |
| .claude/commands/shared/rad-status.md | 1-27 | Add one-line note pointing to `rad status` CLI |

## Execution Notes

### Do Not Touch
- `harness/adapters/git-state-store.js` — `state.list()` is already implemented; compose it, don't modify it
- `harness/spine.js`, `harness/matrix.js`, `harness/gates.js` — untouched
- `scripts/rad-status.sh` — not replaced; prose command still delegates to it for PRs/logs/agent inventory
- `harness/cli.js` approveCommand, deliverCommand — no changes to existing subcommands

### Key Files
- `harness/cli.js` — read fully before writing; understand SUBCOMMANDS table, parseApproveArgs/parseDeliverArgs patterns, and the `createGitStateStore` import already at the top
- `harness/adapters/git-state-store.js` lines 294-334 — `list(filter = {})` returns `[{feature, phase, hasLog, hasPlan}]`; this is the only data source statusCommand needs
- `harness/test/cli.test.js` — withTempRepo, writePlanDoc helpers to copy for status.test.js

### Reminders
- `statusCommand` is read-only: no git writes, no events appended, no plan-doc mutations
- Do not call `process.exit()` — return integer exit code (same contract as all other subcommands)
- The `branch` column value is always `rad/<feature>` (derived, not read from git)
- `state.list()` reads `.agents/state/` and `.agents/plans/` locally; no `git fetch` needed
- Format the table with fixed-width columns for human readability; include a header row

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: status subcommand in harness/cli.js
File: harness/cli.js (30-43 + new lines)
What: Three additions:
(1) Add `status` entry to SUBCOMMANDS table: `{ summary: 'Show current state of all rad/ features.', usage: 'rad status [--phase <phase>]', run: (argv, ctx) => statusCommand(argv, ctx) }`.
(2) Implement `parseStatusArgs(argv)` — optional `--phase <value>` flag; throw on unknown flags or missing value.
(3) Implement `statusCommand(argv, ctx)`: parse args; create state store; call `state.list(phase ? { phase } : {})`; format and print a table with header `Feature | Status | Branch`; if empty print `rad status: no features found`; return 0.
Column widths: Feature left-padded to max feature name length, Status fixed 16, Branch fixed.
Validate: AC#1, AC#2, AC#3 — `node harness/cli.js status` exits 0; `node harness/cli.js --help` includes 'status'; manual: create a test state entry and verify it appears in output.

#### Task 1.2: Tests — harness/test/status.test.js
File: harness/test/status.test.js (new file)
What: Using withTempRepo and writePlanDoc patterns from cli.test.js:
(a) Status table: init a temp repo, write two plan docs with different statuses, call `statusCommand([], { repoRoot, sh: defaultSh })`; verify exit 0 and stdout includes both feature names (AC#1).
(b) Phase filter: same fixture; call `statusCommand(['--phase', 'approved'], ...)`; verify only the approved feature appears (AC#2).
(c) Empty state: temp repo with no plan docs; call `statusCommand([],...)`; verify exit 0 and stdout includes 'no features found' (AC#1 edge case / AC#5).
Run: `node --test harness/test/status.test.js`
Validate: AC#5 — all three cases pass.

#### Task 1.3: Update /rad-status prose
File: .claude/commands/shared/rad-status.md (throughout)
What: Add a single note near the top (after the description line, before the Steps):
```
> **CLI shortcut:** `node harness/cli.js status [--phase <phase>]` prints a quick
> harness-internal feature table (Feature / Status / Branch) without running the
> full script output below.
```
No other changes — the prose command's Steps, script delegation, and output format are unchanged.
Validate: AC#4 — the note is present; `rad-status.md` still delegates to `scripts/rad-status.sh` for the full output.

## Tests to Write
- [ ] status table shows all features — harness/test/status.test.js
- [ ] --phase filter narrows to matching features only — harness/test/status.test.js
- [ ] empty state exits 0 with no-features message — harness/test/status.test.js

## Non-Goals
- No replacement of `scripts/rad-status.sh` — the prose command keeps its full output (PRs, logs, agent inventory)
- No `--json` or machine-readable output flag — plain table only
- No live branch scanning or `git fetch` inside statusCommand — `state.list()` reads local state
- No Decision 2 (dual-write removal) in this plan

## Out-of-Scope Dependencies
None — `state.list()` is already implemented; this is pure composition.

## Risks
- `state.list()` reads `.agents/state/` which requires prior `rad approve` or `rad deliver` to have run; projects that have only used the prose commands may have no state entries even though plans exist. Mitigation: statusCommand should fall back gracefully (empty table with message) — covered by the empty-state test case.
