# Plan: Wave Model Attribution + Spend-Tiering Advisories
Created: 2026-09-28
Author: architect
Status: pending-review
Branch: rad/wave-model-attribution
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/139, https://github.com/seanrreid/RAD_framework/issues/65
Issue-Title: wave-started never records model (#139) + Per-wave model-tier advisories from historical outcome/usage data (#65, spend half)

## Context

#119 (PR #136) added `wave-started {wave, attempt[, model]}`, but `model` is never
recorded. `appendWaveStarted` (`harness/spine.js:209-217`) reads `wave.model`, and
the wave descriptors from `parsePlan` carry only `{ n, heading }`. The per-wave
`Model:` line is parsed once by `parseWaveModels` (`harness/cli.js:287-308`) into
`planCtx.waveModels`. That map reaches the agent adapters (`command.js:388`,
`sdk.js:223`) but never reaches `deliverSpine`. `waveVerify` already travels this
path (`cli.js:735` → `spine.js:328` → `spine.js:546`), and `waveModels` will follow it.

#65 is half delivered. The outcome-derived half shipped in #123 (`waveReliability`,
"Model Tiering Advisory" in `/rad-insights`). The spend-derived half (per-model
downgrade/upgrade advisories from true token totals, with waves that have no usage
reported as unknown) was deferred until #121 delivered cache fields. It did
(`normalizeUsage` passthrough + `cacheUsage`). With #139 fixed, the log can finally
attribute a wave to its declared model, so this plan builds that half.
`waveReliability` must not read usage (a guard test at `events.test.js:613-646`
throws on usage access), so the spend join is a **new** fold.

## Scope

| In scope | Out of scope |
|---|---|
| Pass `planCtx.waveModels` into `deliverSpine`; record the declared model on `wave-started` | Recording the adapter's default model (RAD doesn't reliably know it) |
| New pure fold `modelTierSpend(history)` in the `events.js` insights block | Modifying `waveReliability`, `cacheUsage`, `totalUsage`, the writer or `gates.js` |
| New pure function `modelTierAdvisories(stats, opts)` with named threshold constants | Price tables or cost-in-dollars advice; naming a specific cheaper model |
| New `/rad-insights` step + "Spend by model" subsection under Model Tiering Advisory | Plan-time delivery of the advisory (#60) |
| A committed fixture log exercising declared, default and unrecorded waves | Backfilling model attribution for pre-#139 logs from plan docs |

## Acceptance Criteria

1. A plan whose `### Wave 1` declares `Model: claude-haiku-4-5` produces `wave-started` events for wave 1 whose `data.model === 'claude-haiku-4-5'`, on every attempt.
2. A wave with no `Model:` line produces `wave-started` with no `model` key: not `undefined` and not `''`. A run where `waveModels` is omitted entirely or `{}` appends an event sequence deep-equal to today's.
3. There is one `Model:` parser. `parseWaveModels` in `cli.js` stays the only one, `parsePlan` is unchanged, and `deliver` passes `waveModels: planCtx.waveModels` to `deliverSpine`.
4. `modelTierSpend(history)` groups each `(feature, wave)` by the model it ran on: the declared `wave-started.data.model`, `'default'` when the wave has `wave-started` events but no model, or `'unrecorded'` when the wave has no `wave-started` (pre-#119 logs). For each group it returns `{ waves, features, firstAttemptSuccess, retried, tokens, unknownUsage }`. `tokens` sums `input + output + cacheRead + cacheWrite` over waves where **every** attempt reported usage. `unknownUsage` counts waves where any attempt lacked usage, and those waves add nothing to `tokens`, never zero. It returns `{ groups: {} , features: 0 }` for `[]`, null or non-array input, and never throws.
5. `modelTierAdvisories(stats, { minFeatures })` is deterministic:
   - It renders nothing for a group below `minFeatures` distinct features, and never for `'unrecorded'`.
   - It emits a **downgrade** advisory for the `'default'` group when every wave succeeded on the first attempt.
   - It emits an **upgrade** advisory for any group whose retried-wave rate is at least `UPGRADE_RETRY_RATE`.
   - Every advisory carries `model`, `features`, `waves`, mean tokens per known-usage wave (or `null`) and `unknownUsage`.
   - With no qualifying group, it returns `[]`.
6. `/rad-insights` has a new fold step that runs both functions over all `.agents/state/*/events.jsonl` with the existing `TIERING_MIN_FEATURES` floor. It also has a "Spend by model" subsection under "Model Tiering Advisory" that renders every group's sample sizes, prints unknown-usage counts as unknown (never `0`), and prints an explicit "insufficient history" line when no advisory qualifies.
7. `npm test --prefix harness` and every `scripts/test-*.sh` pass. The `waveReliability` usage guard test still passes unchanged.

## Agent Scope

- `spine-mapper` (architect): `appendWaveStarted`, the `deliverSpine` signature, the `waveVerify` injection pattern, and the byte-identical invariants. It could not read `cli.js`, so the `cli.js` anchors (`parseWaveModels`, `parsePlanCtx`, the `deliverSpine` call site) and the test anchors were confirmed by direct grep.
- `event-metrics-mapper` (developer-open): the `waveReliability`, `cacheUsage` and `totalUsage` folds, the insights-block boundary (`events.js:289`), the `wave-started` shape and read sites, the fixture helpers, and the `rad-insights.md` step/render anchors.
- Out-of-scope dependencies: none. The author is the architect, and `harness/` and `.agents/state/` are self-protected paths that need this plan's approval.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/spine.js | 205-217 | `appendWaveStarted` takes the declared model from `waveModels[wave.n]` |
| harness/spine.js | 290-331 | JSDoc + `waveModels = {}` parameter beside `waveVerify` |
| harness/spine.js | 440-470 | Pass `waveModels` to the `appendWaveStarted` call site(s) |
| harness/cli.js | 721-736 | Pass `waveModels: planCtx.waveModels` to `deliverSpine` |
| harness/test/spine.test.js | 1520-1534 | Append tests: declared model recorded; absent key; omitted/`{}` map deep-equal |
| harness/events.js | 697-700 | Insert `modelTierSpend`, `modelTierAdvisories` and named constants after `cacheUsage`, before the durability block |
| harness/test/events.test.js | 1040-1056 | Append fold + advisory tests |
| harness/test/fixtures/insights/tiered/events.jsonl | 1-40 | New fixture: declared, default and unrecorded waves; with and without usage; retries |
| .claude/commands/shared/rad-insights.md | 540-549 | New Step 4f3: fold spend by model |
| .claude/commands/shared/rad-insights.md | 809-836 | "Spend by model" subsection under Model Tiering Advisory |

## Execution Notes

### Do Not Touch
- `harness/gates.js`, `harness/transitions.js`, `harness/matrix.yaml`, `harness/gates.yaml`
- `harness/adapters/git-state-store.js` (`parsePlan` must not gain a second `Model:` parser)
- The existing `waveReliability`, `cacheUsage`, `totalUsage` folds and their tests
- `harness/test/fixtures/insights/{legacy,enriched,mixed}/` (existing regression fixtures)

### Key Files
- harness/spine.js — `appendWaveStarted`, and the `waveVerify` pattern to mirror
- harness/cli.js — `parseWaveModels`, `parsePlanCtx`, the `deliverSpine` call
- harness/events.js — the insights-block boundary comment at :289, and the `cacheUsage` shape for usage-field handling (`isTokenCount`)
- harness/test/events.test.js — `loadInsightsFixture` helper (:366-392), and the usage guard test (:613-646)
- .claude/commands/shared/rad-insights.md — Step 4f (`TIERING_MIN_FEATURES`) and 4f2 invocation style

### Reminders
- `waveModels` keys are numbers. Look up by `wave.n` (a number), matching `waveVerify[wave.n]`.
- Treat an empty-string or non-string map value as undeclared, so no key is emitted.
- Only additive keys. A run without `Model:` lines must stay deep-equal to today's event sequence.
- Every `/rad-insights` number must show its sample size, and unknown is never rendered as 0.

## Program Design

### 1. Signatures introduced or altered

```js
// harness/spine.js — additive parameter, mirrors waveVerify
deliverSpine({ ..., waveVerify = {}, waveModels = {}, ... })
appendWaveStarted({ state, feature, now, wave, attempt, waveModels })

// wave-started event data — unchanged shape; `model` now actually populated
{ wave, attempt, model? }   // model present iff waveModels[wave.n] is a non-empty string

// harness/events.js — new insights-block exports (pure, no I/O)
export const UPGRADE_RETRY_RATE = 0.5;
modelTierSpend(history): {
  groups: Record<string /* model | 'default' | 'unrecorded' */, {
    waves, features, firstAttemptSuccess, retried, tokens, unknownUsage }>,
  features: number }
modelTierAdvisories(stats, { minFeatures }): Array<{
  kind: 'downgrade' | 'upgrade', model, features, waves,
  meanTokens: number | null, unknownUsage }>
```

### 2. Control-flow sketch

```
rad deliver (harness/cli.js)
 ├─ planCtx = parsePlanCtx(text)          // waveModels via parseWaveModels [unchanged, sole parser]
 ├─ runWave adapters read planCtx.waveModels                               [unchanged]
 └─ deliverSpine({ ..., waveVerify, waveModels: planCtx.waveModels })      ← NEW arg
     └─ per wave, per attempt
         ├─ pre-wave hooks                                                 [unchanged]
         ├─ appendWaveStarted({ ..., waveModels })  → data.model?          ← FIXED
         └─ runWave → wave-attempt { usage? }                              [unchanged]

/rad-insights Step 4f3
 └─ modelTierSpend(allEvents) → modelTierAdvisories(stats, { minFeatures: TIERING_MIN_FEATURES })
```

### 3. File-tree diff

```
harness/
  spine.js                                   M  waveModels param + appendWaveStarted
  cli.js                                     M  one arg at the deliverSpine call
  events.js                                  M  +modelTierSpend, +modelTierAdvisories
  test/spine.test.js                         M  +3 tests
  test/events.test.js                        M  +fold/advisory tests
  test/fixtures/insights/tiered/events.jsonl A  new fixture
.claude/commands/shared/rad-insights.md      M  +Step 4f3, +Spend by model subsection
```

## Wave Plan

### Wave 1 — sequential
Verify: npm test --prefix harness
Tasks in this wave must run in sequence (the spine parameter precedes the call-site wiring).

#### Task 1.1: Spine records the declared wave model
File: harness/spine.js:205-217, 290-331, 440-470, harness/test/spine.test.js:1520-1534
What: Add a `waveModels = {}` parameter to `deliverSpine` (with JSDoc mirroring `waveVerify`). `appendWaveStarted` resolves the model as `waveModels[wave.n]` when it is a non-empty string, and otherwise emits no key. Keep accepting `wave.model` only if an existing test depends on it; otherwise drop the dead read so there is one source. Append spine tests: (a) `waveModels: {1:'claude-haiku-4-5'}` → every wave-1 `wave-started` carries that model, including a retry attempt; (b) a wave absent from a non-empty map gets no `model` key (`!('model' in data)`); (c) `waveModels` omitted vs `{}` vs `{1:''}` produce deep-equal event sequences with no `model` key.
Validate: AC#1, AC#2 — `npm test --prefix harness`; edge cases: omitted map, empty map, empty-string value, wave absent from map, retry attempt.

#### Task 1.2: Deliver passes the parsed map to the spine
File: harness/cli.js:721-736
What: Add `waveModels: planCtx.waveModels` to the `deliverSpine({...})` call beside `waveVerify`. No new parsing. Confirm with a grep that `Model:` is parsed only in `parseWaveModels`.
Validate: AC#3 — `npm test --prefix harness`; `grep -rn "Model:" harness/*.js harness/adapters` shows parsing only in `cli.js` `parseWaveModels`.

### Wave 2 — sequential
Verify: npm test --prefix harness
Tasks in this wave must run in sequence (the fixture feeds the fold tests).

#### Task 2.1: Tiered fixture log
File: harness/test/fixtures/insights/tiered/events.jsonl:1-40
What: Add a fixture covering at least three features. It needs:
- waves with declared `model` on `wave-started`
- waves with `wave-started` but no `model` (default)
- legacy waves with `wave-attempt` and no `wave-started` (unrecorded)
- a retried wave (attempt 1 `fail-tests`, attempt 2 `success`)
- one wave where one attempt lacks `usage`
- attempts carrying `cacheRead` / `cacheWrite`
Validate: AC#4 — consumed by Task 2.2's tests via `loadInsightsFixture`; the file parses as JSONL.

#### Task 2.2: modelTierSpend + modelTierAdvisories folds
File: harness/events.js:697-700, harness/test/events.test.js:1040-1056
What: In the insights block after `cacheUsage`, add named constants `UPGRADE_RETRY_RATE = 0.5`, `MODEL_DEFAULT = 'default'` and `MODEL_UNRECORDED = 'unrecorded'`. Then add the two exported pure functions:
- `modelTierSpend(history)` per AC#4. Join on `(feature, wave)`. The model comes from any `wave-started` of that wave. A wave is first-attempt-success when its first `wave-attempt` has outcome `success`, and retried when it has more than one attempt. Reuse `isTokenCount` for usage fields, and treat a missing `cacheRead`/`cacheWrite` on an attempt that has usage as 0 (the field is optional), not as unknown.
- `modelTierAdvisories(stats, { minFeatures })` per AC#5. Return an array of `{ kind: 'downgrade'|'upgrade', model, features, waves, meanTokens, unknownUsage }`, sorted by kind then model for determinism.

Keep both under ~40 lines each by extracting helpers. Tests:
- empty, null and non-array input
- the fixture: exact group counts, tokens that exclude the unknown wave, `unknownUsage === 1`
- `'unrecorded'` never advised
- below-floor gives `[]`
- downgrade only for `'default'` at 100% first-attempt success
- upgrade at exactly `UPGRADE_RETRY_RATE`
- `meanTokens: null` when every wave in a group is unknown
- the existing fixtures (legacy/enriched/mixed) don't throw
Validate: AC#4, AC#5, AC#7 — `npm test --prefix harness`, including the unchanged `waveReliability` usage guard test.

### Wave 3 — sequential
Verify: npm test --prefix harness
Tasks in this wave must run in sequence.

#### Task 3.1: /rad-insights spend-by-model step and render
File: .claude/commands/shared/rad-insights.md:540-549, 809-836
What: Add "Step 4f3: Fold spend by model". It uses the same `node --input-type=module -e` invocation style as 4f/4f2 and imports `modelTierSpend` and `modelTierAdvisories` from `harness/events.js`. It reads all `.agents/state/*/events.jsonl`, reuses `TIERING_MIN_FEATURES`, and emits JSON. Add a "Spend by model" subsection to the Model Tiering Advisory template:
- a per-group table (model, features, waves, first-attempt %, retried %, mean tokens, unknown-usage waves), with unknown rendered as `unknown`
- the advisory lines
- the explicit "insufficient history (N of TIERING_MIN_FEATURES features)" line when none qualify
- a caveat that `default` means "the deliver default, whatever it was"
This task has no unit-testable surface beyond Wave 2's fold tests (it is prompt prose). Validate by running the embedded snippet by hand against the repo.
Validate: AC#6 — run the Step 4f3 snippet from the repo root; it prints valid JSON with `groups` and `advisories` keys and does not throw on the real logs, where every current wave is `unrecorded` or absent. `npm test --prefix harness` passes.

## Tests to Write
- [ ] declared wave model lands on every `wave-started` attempt of that wave — harness/test/spine.test.js
- [ ] wave absent from a non-empty map gets no `model` key — harness/test/spine.test.js
- [ ] omitted / `{}` / empty-string map give deep-equal, model-free sequences — harness/test/spine.test.js
- [ ] `modelTierSpend` empty/null/non-array → empty result — harness/test/events.test.js
- [ ] `modelTierSpend` fixture: group counts, unknown excluded from tokens, cache fields summed — harness/test/events.test.js
- [ ] `modelTierAdvisories` floor, unrecorded exclusion, downgrade, upgrade at threshold, null meanTokens — harness/test/events.test.js
- [ ] existing insights fixtures do not throw through the new folds — harness/test/events.test.js

## Non-Goals
- Recording the adapter's default model, or any model the plan didn't declare.
- Naming which cheaper model to switch to, or reasoning about per-model prices.
- Backfilling attribution for pre-#139 logs by re-parsing historical plan docs.
- Plan-time surfacing of these advisories (#60 owns that).
- Changing the shape or behavior of `waveReliability`, `cacheUsage` or `totalUsage`.

## Out-of-Scope Dependencies
None

## Risks
- **Byte-identical claims.** Adding `waveModels` must not change any run without `Model:` lines. AC#2's deep-equal test guards this, and the existing sequence-asserting spine tests must pass unmodified.
- **Sparse real data.** No real log yet has `wave-started` with a model or `wave-attempt` usage (only fixtures do). The advisories will print "insufficient history" until tiered deliveries accumulate. That is expected, not a defect.
- **Retry-rate definition drift.** `waveReliability` already reports a per-position retry rate. The new per-model rate must use the same "more than one attempt" definition, so the two sections don't disagree on the same data.

## Issue Gaps
- **[ASSUMPTION — #139]** The spine takes `waveModels` as an injected map (preferred option in the issue), rather than `parsePlan` attaching `wave.model`. The existing `wave.model` read is dropped unless a test depends on it.
- **[ASSUMPTION — #65]** Attribution comes only from `wave-started.data.model`. Pre-#139 logs group as `unrecorded` and are never advised on. The issue suggested plan-doc parsing at the same commit as a v1 fallback. This plan declines that fallback, because #139 now records attribution going forward.
- **[ASSUMPTION — #65]** "True token totals" means `input + output + cacheRead + cacheWrite`. A missing optional cache field on an attempt that has usage counts as 0. A missing `usage` object makes the whole wave unknown.
- **[ASSUMPTION — #65]** Threshold values: the floor reuses `TIERING_MIN_FEATURES = 3`. Upgrade triggers at `UPGRADE_RETRY_RATE = 0.5` retried-wave rate. Downgrade requires 100% first-attempt success and applies only to `default` (a declared cheap model already made that choice).
- **[ASSUMPTION — #65]** Advisories report mean tokens per wave, not dollars. `cost` from #121 is ignored in v1 because adapters report it inconsistently.
- **[ASSUMPTION]** `/rad-insights` prose (Task 3.1) has no unit test. Its logic lives in the tested Wave 2 functions, and the prose is validated by running its snippet.
