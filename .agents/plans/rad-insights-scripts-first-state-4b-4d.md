# Plan: rad-insights scripts-first, part A (shared state helpers, 4b, 4d)
Created: 2026-11-16
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-16T19:28:59.131Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-insights-scripts-first-state-4b-4d
Source-Author: none (no source issue)
Source-Comments: none

## Context
PR #316 moved Steps 4c, 4e and 4g of `.rad/skills/rad-insights/SKILL.md` into
`harness/insights-*.js` modules (skill 1509 -> 1331 lines). Seven inline folds remain
(4b, 4d, 4f, 4f2, 4f3, 4f4, 4h, 4i; 4j is already module-backed). The #316 review flagged
that 4e and 4g import `listFeatures`/`readHistory` from the 4c module. This is part A of
three sequential plans (they edit the same skill file, so line ranges shift after each
merge): A = shared state helpers plus 4b and 4d; B = 4f, 4f2, 4f3; C = 4f4, 4h, 4i. Part
A is split small on purpose: the research sized a combined A at ~17 files.

## Scope
| In scope | Out of scope |
|---|---|
| New shared module `harness/insights-state.js`; the three #316 modules import from it | Steps 4f, 4f2 (plan B), 4f3 (plan B), 4f4, 4h, 4i (plan C), 4j |
| Step 4b (token cost) and Step 4d (blocked reasons) become harness modules | The Step 5 report template and its field names |
| readHistory fails closed on non-object lines; document `emptyAggregate` | Any change to `harness/events.js` or `harness/gates.js` |
| Regenerated `.agents/skills` and `.claude/commands` outputs | New fixture files (edge cases are built inline in temp dirs) |

## Acceptance Criteria
1. `harness/insights-state.js` exports `listFeatures`, `readHistory`, `DEFAULT_STATE_DIR` and `EVENT_LOG`; `insights-reliability.js`, `insights-blocked-files.js` and `insights-prompt-surfaces.js` import them from it, no fold module imports state helpers from another fold module, and the three existing test files pass unchanged.
2. `readHistory` fails closed: any event-log line that is valid JSON but not an object (`null`, a number, an array) throws an error naming the file and line, malformed JSON still exits non-zero, and valid logs behave exactly as before; `emptyAggregate` in `insights-reliability.js` carries a comment stating why `perWave` is omitted from the aggregate.
3. Step 4d becomes `harness/insights-blocked-reasons.js` and its output is byte-identical to golden captured from the old inline snippet on every fixture under `harness/test/fixtures/insights/` plus an empty state dir; Step 4b becomes `harness/insights-usage-cost.js` and, for every fixture and an empty state dir, its per-feature totals and per-wave sums are numerically equal to the results of the old jq snippet (golden captured before the snippet is deleted) and expose every value the Step 5 Token Cost section uses. Both modules are read-side only, honor `RAD_STATE_DIR` (default `.agents/state`), and import `totalUsage` / `blockedReasonCounts` from `harness/events.js` instead of copying them.
4. Each new module and the state module has a test for each named edge case: missing state dir, empty `events.jsonl`, missing field on an event, zero counts, non-array field, and a valid-JSON `null` line; each is asserted explicitly and none needs a new fixture file.
5. In `.rad/skills/rad-insights/SKILL.md` the 4b and 4d snippets are replaced by run-and-read instructions; the interpretation prose, the Step 5 template (byte-identical) and the strings pinned by `harness/test/skill-bodies.test.js` are unchanged; the skill source is 1291 lines or fewer (a reduction of at least 40).
6. `node harness/cli.js generate --check`, `npm test --prefix harness` and `scripts/verify-all.sh` pass (including the function-length lint, no function over 40 lines).
7. Live-log parity: each new module is compared against the old inline snippet from `main` on the live `.agents/state/*/events.jsonl` logs (4d byte-identical, 4b numerically equal) and the result of each comparison is reported in the verification task's summary.

## Agent Scope
Research used one read-only Explore sub-agent. No architect-only agent was called. The
plan runs under an architect author because it edits self-protected paths.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/insights-state.js | 1-45 | New: shared `listFeatures`, `readHistory` (fail closed on non-object lines), `DEFAULT_STATE_DIR`, `EVENT_LOG` |
| harness/test/insights-state.test.js | 1-60 | New: helper tests incl. valid-JSON null line, built inline in temp dirs |
| harness/insights-reliability.js | 9-60 | Import state helpers from insights-state.js; comment on `emptyAggregate` |
| harness/insights-blocked-files.js | 9-14 | Switch the import to insights-state.js |
| harness/insights-prompt-surfaces.js | 9-20 | Switch the import to insights-state.js |
| harness/insights-usage-cost.js | 1-60 | New: Step 4b fold + format + main |
| harness/test/insights-usage-cost.test.js | 1-70 | New: numeric parity vs golden, edge cases |
| harness/insights-blocked-reasons.js | 1-60 | New: Step 4d fold + format + main |
| harness/test/insights-blocked-reasons.test.js | 1-70 | New: byte parity vs golden, edge cases |
| harness/test/fixtures/insights-parity/golden.txt | 925-1100 | Append `4b:` and `4d:` sections only; never edit existing sections |
| .rad/skills/rad-insights/SKILL.md | 248-288 | Step 4b: replace inline jq with run-and-read instruction |
| .rad/skills/rad-insights/SKILL.md | 333-383 | Step 4d: replace inline snippet with run-and-read instruction |
| .agents/skills/rad-insights/SKILL.md | 248-288 | Regenerated by `rad generate` (Step 4b region) |
| .agents/skills/rad-insights/SKILL.md | 333-383 | Regenerated (Step 4d region) |
| .claude/commands/shared/rad-insights.md | 248-288 | Regenerated by `rad generate` (Step 4b region) |
| .claude/commands/shared/rad-insights.md | 333-383 | Regenerated (Step 4d region) |

## Program Design
Key signatures (all functions under 40 lines):
- `insights-state.js`: `listFeatures(stateDir) -> string[]`, `readHistory(stateDir, feature) -> object[]` (throws `Error` naming file and line for a non-object line), `DEFAULT_STATE_DIR`, `EVENT_LOG`.
- `insights-blocked-reasons.js` (4d): `buildBlockedReasons(histories) -> { noEnrichedData, aggregate, perFeature }` / `formatBlockedReasons(result) -> string`.
- `insights-usage-cost.js` (4b): `buildTokenCost(histories) -> result` / `formatTokenCost(result) -> string`; output keys chosen so the Step 5 Token Cost section needs no change, per-feature total from `totalUsage(history).total` and per-wave sums computed once in this module.

Control flow: skill step runs `node harness/insights-<x>.js` -> module reads `RAD_STATE_DIR` through `insights-state.js` -> calls the `events.js` fold -> `format*` prints JSON -> skill reads stdout and applies the unchanged interpretation prose. A non-zero exit means report stderr verbatim, never retry.

File-tree diff: add 3 modules and 3 tests under `harness/` and `harness/test/`; modify 3 modules, `golden.txt` (append only), the skill source and its 2 generated outputs.

## Execution Notes

### Do Not Touch
- harness/events.js, harness/gates.js — read-side only; import, never modify
- harness/test/insights-reliability.test.js, insights-blocked-files.test.js, insights-prompt-surfaces.test.js — existing tests must pass unchanged after the extraction
- harness/test/fixtures/insights/* and existing sections of golden.txt — reuse, never edit
- .agents/plans/, .agents/research/, .agents/logs/ — never read during planning

### Key Files
- .rad/skills/rad-insights/SKILL.md — edit only this; read Step 4c (already converted) as the template for the run-and-read wording
- harness/insights-reliability.js — current home of the helpers; mirror its main/`invokedDirectly` pattern
- harness/test/insights-reliability.test.js — fixture helper pattern (`stateDirWith`, `goldenSection`, `FIXTURE_NAMES`)
- harness/events.js — `totalUsage` and `blockedReasonCounts` live here (read-only)

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`; wave 1 touches five files and a default 600 s wave limit has bitten before.
- A failed deliver stop (`class=failed`) cannot be resumed: fix the plan or code, re-approve from the preserved worktree if the plan changed, remove the worktree, and re-run `rad deliver` without `--resume`.
- Capture each golden from the OLD snippet in the current SKILL.md BEFORE editing the skill; for 4b the old output is bash/jq tab-separated text, so compare numbers, not bytes.
- Every file a task may create is declared above. Do not create fixture files; build edge cases inline in temp dirs. If a new file is truly needed, stop and report; do not widen scope silently.
- Keep the 4b output keys stable for the Step 5 Token Cost section; the Step 5 template must stay byte-identical.
- Run `node harness/cli.js generate` after every skill edit.

## Wave Plan

### Wave 1 — sequential
Shared state helpers. Tasks in this wave must run in sequence.

#### Task 1.1: Create the shared state module and its tests
File: harness/insights-state.js:1-45, harness/test/insights-state.test.js:1-60
What: Move `listFeatures`, `readHistory`, `DEFAULT_STATE_DIR` and `EVENT_LOG` out of `insights-reliability.js` into `insights-state.js` (exported). Make `readHistory` throw an `Error` naming the file and line for a valid-JSON non-object line. Test missing state dir, empty log, missing field, non-array field, and a valid-JSON `null` line, all built in temp dirs.
Validate: AC#1 — exports present; AC#2 — null-line test asserts the named error; AC#4 — edge cases asserted.

#### Task 1.2: Switch the three existing modules to the shared module
File: harness/insights-reliability.js:9-60, harness/insights-blocked-files.js:9-14, harness/insights-prompt-surfaces.js:9-20
What: Import the helpers from `insights-state.js` in all three modules; delete the local definitions from `insights-reliability.js`; add the `emptyAggregate` comment explaining why `perWave` is omitted. Do not edit their test files.
Validate: AC#1 — no fold module imports state helpers from another fold module and the three existing test files pass unchanged; AC#2 — comment present.

### Wave 2 — sequential
Depends on: Wave 1 complete. Step 4d: blocked reasons.

#### Task 2.1: Capture the 4d golden and write the module
File: harness/insights-blocked-reasons.js:1-60, harness/test/fixtures/insights-parity/golden.txt:925-1100
What: Run the current Step 4d snippet against every fixture and an empty state dir; append the outputs to `golden.txt` as `4d:` sections. Implement `buildBlockedReasons`/`formatBlockedReasons` plus main, importing `blockedReasonCounts` from `events.js` and the helpers from `insights-state.js`.
Validate: AC#3 — output equals golden; AC#6 — functions at or under 40 lines.

#### Task 2.2: Test the 4d module
File: harness/test/insights-blocked-reasons.test.js:1-70
What: Byte-parity test against each golden section, plus named edge cases including `noEnrichedData` when no attempt is enriched and a valid-JSON `null` line.
Validate: AC#3, AC#4.

#### Task 2.3: Replace the 4d snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:333-383
What: Replace the inline snippet with a run-and-read instruction mirroring Step 4c; keep the interpretation prose (including the `noEnrichedData` and `enrichedAttempts` wording that Steps 4e and 4g reference); run `node harness/cli.js generate`.
Validate: AC#5 — pinned strings present, template unchanged, `node --test harness/test/skill-bodies.test.js` passes.

### Wave 3 — sequential
Depends on: Wave 2 complete. Step 4b: token cost.

#### Task 3.1: Capture the 4b golden and write the module
File: harness/insights-usage-cost.js:1-60, harness/test/fixtures/insights-parity/golden.txt:925-1100
What: Run the current Step 4b jq snippet against every fixture and an empty state dir; append its raw output as `4b:` sections. Implement `buildTokenCost`/`formatTokenCost` plus main with per-feature totals (`totalUsage`) and per-wave sums, treating missing usage as 0 and no logs as an explicit no-data result.
Validate: AC#3 — per-feature and per-wave numbers equal the old jq results; AC#6 — functions at or under 40 lines.

#### Task 3.2: Test the 4b module
File: harness/test/insights-usage-cost.test.js:1-70
What: Parse each `4b:` golden section and assert numeric equality with the module output, plus the named edge cases (missing `usage`, zero totals, non-array `tasks`, empty log, missing dir, JSON-null line).
Validate: AC#3, AC#4.

#### Task 3.3: Replace the 4b snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:248-288
What: Replace the inline jq with a run-and-read instruction; keep the prose about unknown usage and omitting the section when there are no logs; run `node harness/cli.js generate`.
Validate: AC#5 — the skill source is 1291 lines or fewer and the Step 5 template is byte-identical.

### Wave 4 — sequential
Depends on: Wave 3 complete. Verification.

#### Task 4.1: Live-log parity check
File: harness/insights-blocked-reasons.js:1-60, harness/insights-usage-cost.js:1-60
What: Read-only. Extract the old 4b and 4d snippets from `main`'s `.rad/skills/rad-insights/SKILL.md`, run them and the new modules against the live `.agents/state/*/events.jsonl`, and diff (4d bytes, 4b numbers). State each result (identical / differs, with line counts) in the task summary. Do not commit live logs.
Validate: AC#7 — both comparisons are reported with their results.

#### Task 4.2: Full verification
File: .rad/skills/rad-insights/SKILL.md:248-383
What: Run `node harness/cli.js generate --check`, `npm test --prefix harness`, `scripts/test-install-harness.sh` and `scripts/verify-all.sh`; confirm the skill line count.
Validate: AC#5, AC#6.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] shared state helpers incl. valid-JSON null line — harness/test/insights-state.test.js
- [ ] 4d byte-parity and edge cases — harness/test/insights-blocked-reasons.test.js
- [ ] 4b numeric parity and edge cases — harness/test/insights-usage-cost.test.js

## Non-Goals
- Steps 4f, 4f2, 4f3 (plan B) and 4f4, 4h, 4i (plan C), and Step 4j
- Any change to the report content, the Step 5 template or its field names
- Any edit to `harness/events.js`, `harness/gates.js`, the existing test files or existing fixtures
- New fixture files; edge cases are built inline in temp dirs

## Out-of-Scope Dependencies
None for agents. `harness/`, `.rad/` and `.agents/skills/` are self-protected paths, so this plan is flagged for architect review by design.

## Risks
- 4b parity is numeric, not byte-level, because the old output is bash/jq text; the golden captured before deletion and the live-log check guard against drift.
- Making `readHistory` fail closed changes the error for a non-object line from an incidental TypeError to a named error; valid logs are unaffected and the existing malformed-JSON tests still hold.
- The skill only shrinks by about 40-50 lines in this plan; the full reduction needs plans B and C.
- Plans B and C depend on this merging first; their line ranges and the shared module must be re-read after the merge.
