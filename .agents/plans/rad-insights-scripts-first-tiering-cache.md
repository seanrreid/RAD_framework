# Plan: rad-insights scripts-first, part B (4f wave tiering, 4f2 cache hit)
Created: 2026-11-16
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-16T21:46:41.909Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-insights-scripts-first-tiering-cache
Source-Author: none (no source issue)
Source-Comments: none

## Context
PRs #316 and #319 moved Steps 4b, 4c, 4d, 4e and 4g of `.rad/skills/rad-insights/SKILL.md`
into `harness/insights-*.js` modules (skill 1509 -> 1291 lines) and added the shared
`harness/insights-state.js`. Steps 4f and 4f2 are still inline `node --input-type=module -e`
snippets (skill lines 395-534). Each repeats the same feature-listing and log-concatenation
code, and Step 4f defines `TIERING_MIN_FEATURES = 3`, which Step 4f3 redefines. This is part
B of four sequential plans (all edit the same skill file, so line ranges shift after each
merge): A (merged) = state helpers, 4b, 4d; B = 4f, 4f2; C = 4f3, 4f4 (spend by model and by
provider); D = 4h, 4i. Part B is sized small on purpose: the three golden files for 4f, 4f2
and 4f3 alone are about 540 lines, which would blow the plan context budget.

## Scope
| In scope | Out of scope |
|---|---|
| Steps 4f and 4f2 become `harness/insights-wave-tiering.js` and `harness/insights-cache-hit.js` | Steps 4f3, 4f4 (plan C), 4h, 4i (plan D) and 4j |
| `TIERING_MIN_FEATURES` is exported by the 4f module so plan C can import it for 4f3 | The Step 5 report template and its field names |
| One small shared helper in `insights-state.js` that concatenates every feature's history | Any change to `harness/events.js` or `harness/gates.js` |
| Regenerated `.agents/skills` and `.claude/commands` outputs | New fixture files (edge cases are built inline in temp dirs) |

## Acceptance Criteria
1. `harness/insights-state.js` exports `readAllHistory(stateDir)`, which returns every feature's events concatenated in sorted-feature order using the fail-closed `readHistory`; it has tests for a missing state dir, an empty `events.jsonl`, feature ordering, and a valid-JSON `null` line, and the existing `insights-*` test files pass unchanged.
2. Step 4f becomes `harness/insights-wave-tiering.js`: its stdout is byte-identical to golden captured from the old inline snippet on each of the five fixtures under `harness/test/fixtures/insights/`, on all five combined, and on an empty state dir; the module exports `TIERING_MIN_FEATURES` (value 3), imports `waveReliability` from `harness/events.js`, and keeps the same percentage rounding and key order.
3. Step 4f2 becomes `harness/insights-cache-hit.js`: stdout is byte-identical to golden for the same seven states, including the leading plain-text line `no cache data reported` printed before the JSON when no attempt carries cache data, the `ratioPct` key appended last on each attempt, and `droppedToZero`; it imports `cacheUsage` from `harness/events.js`.
4. Each new module has a test for each named edge case: missing state dir, empty `events.jsonl`, missing field on an event, zero counts, non-array field, and a valid-JSON `null` line; each is asserted explicitly, none needs a new fixture file, and both modules honor `RAD_STATE_DIR` (default `.agents/state`) and are read-side only.
5. In `.rad/skills/rad-insights/SKILL.md` the 4f and 4f2 snippets are replaced by run-and-read instructions; the interpretation prose, the names `waveReliability`, `cacheUsage`, `TIERING_MIN_FEATURES` and the line `no cache data reported`, the Step 5 template (byte-identical) and the strings pinned by `harness/test/skill-bodies.test.js` are unchanged; the skill source is 1261 lines or fewer (a reduction of at least 30).
6. `node harness/cli.js generate --check`, `npm test --prefix harness` and `scripts/verify-all.sh` pass, including the function-length lint (no function over 40 lines).
7. Live-log parity: each new module is compared against the old inline snippet (from the skill as it stands on `main` before this plan's edits) on the live `.agents/state/*/events.jsonl` logs, stdout byte-identical, and the result of each of the two comparisons is reported in the verification task's summary.

## Agent Scope
Research used one read-only Explore sub-agent. No architect-only agent was called. The
plan runs under an architect author because it edits self-protected paths.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/insights-state.js | 38-60 | Add `readAllHistory` |
| harness/test/insights-state.test.js | 60-95 | Add `readAllHistory` tests, built inline in temp dirs |
| harness/insights-wave-tiering.js | 1-60 | New: Step 4f fold + format + main; exports `TIERING_MIN_FEATURES` |
| harness/test/insights-wave-tiering.test.js | 1-70 | New: byte parity vs golden, edge cases, floor threshold |
| harness/insights-cache-hit.js | 1-70 | New: Step 4f2 fold + format + main |
| harness/test/insights-cache-hit.test.js | 1-80 | New: byte parity vs golden, edge cases, dropped-to-zero walk |
| harness/test/fixtures/insights-parity/golden.txt | 1181-1540 | Append `4f:` and `4f2:` sections only; never edit existing sections |
| .rad/skills/rad-insights/SKILL.md | 395-464 | Step 4f: replace inline snippet with run-and-read instruction |
| .rad/skills/rad-insights/SKILL.md | 465-534 | Step 4f2: replace inline snippet with run-and-read instruction |
| .agents/skills/rad-insights/SKILL.md | 395-534 | Regenerated by `rad generate` (Steps 4f-4f2) |
| .claude/commands/shared/rad-insights.md | 395-534 | Regenerated by `rad generate` (Steps 4f-4f2) |

## Program Design
Key signatures (all functions under 40 lines):
- `insights-state.js`: `readAllHistory(stateDir) -> object[]` (flat map of `readHistory` over `listFeatures`, sorted-feature order).
- `insights-wave-tiering.js`: `export const TIERING_MIN_FEATURES = 3`; `buildWaveTiering(history) -> { noWaveData, advisory, minFeatures, features, positions }` / `formatWaveTiering(result) -> string`.
- `insights-cache-hit.js`: `buildCacheHit(history) -> { noCacheData, withoutCache, overallRatioPct, totals, attempts, droppedToZero }` / `formatCacheHit(result) -> string` (prefixes the line `no cache data reported` when `noCacheData`).

Control flow: skill step runs `node harness/insights-<x>.js` -> module reads `RAD_STATE_DIR` through `insights-state.js` (`readAllHistory`) -> calls the `events.js` fold -> `format*` returns the stdout text -> `console.log` -> skill reads stdout and applies the unchanged interpretation prose. A non-zero exit means report stderr verbatim, never retry.

File-tree diff: add 2 modules and 2 tests under `harness/` and `harness/test/`; modify `insights-state.js` and its test, `golden.txt` (append only), the skill source and its 2 generated outputs.

## Execution Notes

### Do Not Touch
- harness/events.js, harness/gates.js — read-side only; import, never modify
- Existing test files (events.test.js and every existing `harness/test/insights-*.test.js` other than `insights-state.test.js`, which only gains tests) — must pass unchanged
- harness/test/fixtures/insights/* and existing sections of golden.txt — reuse, never edit
- Steps 4f3, 4f4, 4g, 4h, 4i, 4j and the Step 5 template in the skill; the other modules under harness/insights-*.js
- .agents/plans/, .agents/research/, .agents/logs/ — never read during planning

### Key Files
- .rad/skills/rad-insights/SKILL.md — edit only this; read Steps 4c and 4d (already converted) as the template for the run-and-read wording
- harness/insights-usage-cost.js and harness/insights-blocked-reasons.js — module shape to mirror (`build*`/`format*`, `invokedDirectly` main)
- harness/test/insights-blocked-reasons.test.js — fixture helper pattern (`stateDirWith`, `goldenSection`, `FIXTURE_NAMES`); `golden.txt` section names look like `=== 4d:enriched ===`
- harness/events.js — `waveReliability` and `cacheUsage` live here and are already unit-tested in `harness/test/events.test.js`; do not re-test fold semantics, test only the module-layer derivations

### Reminders
- Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`; the default 600 s wave limit has bitten before.
- A failed deliver stop (`class=failed`) cannot be resumed: fix the plan or code, re-approve from the preserved worktree if the plan changed, remove the worktree, and re-run `rad deliver` without `--resume`.
- Capture each golden from the OLD snippet in the current SKILL.md BEFORE editing the skill: extract the bash fence under the step heading and run it from the repo root with `RAD_STATE_DIR` set to a temp dir holding the fixture, the five fixtures combined (`all`) and an empty dir (`empty`). That is seven sections per step; expect about 175 golden lines for each of 4f and 4f2.
- Byte-identity traps: 4f2 prints a plain-text first line before the JSON when there is no cache data; percentages use `Math.round`, never `toFixed`; keep object-literal key order exactly (`ratioPct` is appended last on each attempt, `earlierPeakPct` last on each dropped entry); concatenate histories in sorted-feature order, because 4f2 attempt order depends on it.
- The old inline reader accepted non-object JSON lines; `readHistory` rejects them (fail closed). That is a deliberate, documented difference that only affects malformed logs, not any fixture.
- Every file a task may create is declared above. Do not create fixture files; build edge cases inline in temp dirs. If a new file is truly needed, stop and report; do not widen scope silently.
- Skill line numbers shift as each step is converted; re-read the step headings before every skill edit.
- Run `node harness/cli.js generate` after every skill edit.

## Wave Plan

### Wave 1 — sequential
Shared helper. Tasks in this wave must run in sequence.

#### Task 1.1: Add `readAllHistory` to the state module and test it
File: harness/insights-state.js:38-60, harness/test/insights-state.test.js:60-95
What: Add `readAllHistory(stateDir)` returning every feature's events concatenated in sorted-feature order via `listFeatures` and the fail-closed `readHistory`. Add tests built inline in temp dirs: missing state dir returns `[]`, an empty `events.jsonl` contributes nothing, two features keep sorted order, and a valid-JSON `null` line throws the named error.
Validate: AC#1 — helper exported and tested; AC#4 — the shared edge cases are asserted.

### Wave 2 — sequential
Depends on: Wave 1 complete. Step 4f: wave tiering.

#### Task 2.1: Capture the 4f golden and write the module
File: harness/insights-wave-tiering.js:1-60, harness/test/fixtures/insights-parity/golden.txt:1181-1540
What: Run the current Step 4f snippet against each fixture, the combined `all` set and an empty state dir; append the outputs to `golden.txt` as `4f:` sections. Implement `TIERING_MIN_FEATURES`, `buildWaveTiering`/`formatWaveTiering` and main, importing `waveReliability` from `events.js` and `readAllHistory` and `DEFAULT_STATE_DIR` from `insights-state.js`.
Validate: AC#2 — output equals golden and the constant is exported; AC#6 — functions at or under 40 lines.

#### Task 2.2: Test the 4f module
File: harness/test/insights-wave-tiering.test.js:1-70
What: Byte-parity test against each `4f:` golden section, plus the named edge cases (missing state dir, empty log, missing field, zero counts, non-array field, valid-JSON `null` line) and an explicit test that `advisory` flips at exactly `TIERING_MIN_FEATURES` features.
Validate: AC#2, AC#4.

#### Task 2.3: Replace the 4f snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:395-464
What: Replace the inline snippet with a run-and-read instruction mirroring Step 4c; keep the interpretation prose, the names `waveReliability` and `TIERING_MIN_FEATURES`, and the statement that the floor is owned by the skill; run `node harness/cli.js generate`.
Validate: AC#5 — pinned names and Step 5 template unchanged, `node --test harness/test/skill-bodies.test.js` passes.

### Wave 3 — sequential
Depends on: Wave 2 complete. Step 4f2: cache hit.

#### Task 3.1: Capture the 4f2 golden and write the module
File: harness/insights-cache-hit.js:1-70, harness/test/fixtures/insights-parity/golden.txt:1181-1540
What: Run the current Step 4f2 snippet against the same seven states; append the outputs as `4f2:` sections, keeping the leading `no cache data reported` line where it is printed. Implement `buildCacheHit`/`formatCacheHit` and main, importing `cacheUsage` from `events.js`; `formatCacheHit` returns the optional first line plus the JSON so `console.log` reproduces the old stdout exactly.
Validate: AC#3 — output equals golden including the plain-text line and key order; AC#6 — functions at or under 40 lines.

#### Task 3.2: Test the 4f2 module
File: harness/test/insights-cache-hit.test.js:1-80
What: Byte-parity test against each `4f2:` golden section, plus the named edge cases, a dropped-to-zero case built inline (positive first attempt, then zero), `overallRatioPct` null when the denominator is 0, and the `no cache data reported` first line only when no attempt carries `usage.cacheRead`.
Validate: AC#3, AC#4.

#### Task 3.3: Replace the 4f2 snippet in the skill and regenerate
File: .rad/skills/rad-insights/SKILL.md:465-534
What: Replace the inline snippet with a run-and-read instruction; keep the prose, the names `cacheUsage` and `no cache data reported`, and the never-0% rule; run `node harness/cli.js generate`.
Validate: AC#5 — pinned names unchanged, the skill source is 1261 lines or fewer, and the Step 5 template is byte-identical.

### Wave 4 — sequential
Depends on: Wave 3 complete. Verification.

#### Task 4.1: Live-log parity check
File: harness/insights-wave-tiering.js:1-60, harness/insights-cache-hit.js:1-70
What: Read-only. Extract the old 4f and 4f2 snippets from the skill on `main` (`git show main:.rad/skills/rad-insights/SKILL.md`), run them and the two new modules against the live `.agents/state/*/events.jsonl`, and diff stdout byte for byte. State each of the two results (identical or differs, with line counts) in the task summary. Do not commit live logs.
Validate: AC#7 — both comparisons are reported with their results.

#### Task 4.2: Full verification
File: .rad/skills/rad-insights/SKILL.md:395-534
What: Run `node harness/cli.js generate --check`, `npm test --prefix harness`, `scripts/test-install-harness.sh` and `scripts/verify-all.sh`; confirm the skill line count.
Validate: AC#5, AC#6.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] `readAllHistory` incl. valid-JSON null line — harness/test/insights-state.test.js
- [ ] 4f byte-parity, edge cases and floor threshold — harness/test/insights-wave-tiering.test.js
- [ ] 4f2 byte-parity, edge cases and dropped-to-zero — harness/test/insights-cache-hit.test.js

## Non-Goals
- Steps 4f3, 4f4 (plan C), 4h, 4i (plan D) and Step 4j
- Any change to the report content, the Step 5 template or its field names
- Any edit to `harness/events.js`, `harness/gates.js`, existing test files (other than adding tests to `insights-state.test.js`) or existing fixtures
- New fixture files; edge cases are built inline in temp dirs
- Making the new modules agree on legacy-event semantics with the other folds; each keeps the behavior of the snippet it replaces

## Out-of-Scope Dependencies
None for agents. `harness/`, `.rad/` and `.agents/skills/` are self-protected paths, so this plan is flagged for architect review by design.

## Risks
- Byte-identity: 4f2's plain-text first line and the object key order are easy to break; the goldens are captured from the old snippets before they are deleted and the live-log check guards against drift.
- `readHistory` fails closed on non-object lines where the old inline reader did not; this only changes the outcome for a malformed log, and the existing malformed-JSON behavior is unchanged.
- Plan C must import `TIERING_MIN_FEATURES` from `insights-wave-tiering.js` for Step 4f3; the export name and value 3 are therefore part of this plan's contract.
- The skill shrinks by roughly 30-55 lines in this plan; the full reduction needs plans C and D.
- Plans C and D depend on this merging first; their line ranges must be re-read after the merge.
