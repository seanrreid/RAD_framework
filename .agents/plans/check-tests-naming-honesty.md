# Plan: check-tests Naming Honesty
Created: 2026-08-05
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-08-05T14:08:37.900Z
Recorded-By: sean@torchcodelab.com
Branch: rad/check-tests-naming-honesty
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/91
Issue-Title: check-tests.sh does not run tests — it checks that promised test files exist

## Context

`scripts/check-tests.sh` parses a plan's `## Tests to Write` section and checks that
each listed file **exists on disk** (`check-tests.sh:39-43`). It never executes a test,
build, typecheck, or linter. The script's own header (`check-tests.sh:2-4`) is already
honest about this — the dishonesty lives in the **filename** and in `harness/spine.js`'s
narration, which asserts a much stronger guarantee:

- `spine.js:51-53` — "The test gate now runs per-wave (a regression blocks AT the
  introducing wave, not at the end)"
- `spine.js:174-178` — "run ONE cumulative test gate to confirm the prior work is still green"
- `spine.js:265-269` — "A wave the model thinks succeeded only advances if the cumulative
  tests are green at THIS point — otherwise it introduced a regression"

No test runs, so no regression can be detected. A wave can create every promised test
file, have all of them fail, and advance. `README.md:195` repeats the claim
("checks for test coverage in deliver output"), as do `docs/how-it-works.md:157,200`.

The mechanism is correctly wired and worth keeping — file presence catches a real,
distinct failure mode (an agent silently dropping a promised test) that a green suite
would never reveal. **This plan changes only the honesty of the surface.** Adding real
execution is #89 and is deliberately excluded.

This is also the seed case for #97 (invariant registry + anchor lint): prose and
implementation drifted independently because nothing coupled them.

## Scope

| In scope | Out of scope |
|---|---|
| Rename `check-tests.sh` → `check-tests-present.sh` (clean, no shim) | Adding actual test execution (#89) |
| Both `spine.js` call sites + all test references | Historical records in `plans/` and `.agents/plans/`, `.agents/research/`, `.agents/architecture/` |
| Misleading narration in `spine.js` and `hook-runner.js` comments | The recorded event value `categories: ['check-tests']` (see Issue Gaps) |
| Live docs, command specs, agent files, README | `.claude/settings.local.json` (user-local permission entries) |
| A new dedicated test for the renamed script + a stale-reference guard | Any change to gate semantics, exit codes, or matrix routing |

## Acceptance Criteria

1. `scripts/check-tests-present.sh` exists, is executable, and behaves identically to
   the pre-rename script for present, missing, unresolvable, empty-section, and
   backtick-wrapped path cases.
2. `scripts/check-tests.sh` no longer exists, and no live (non-historical) file in the
   repo references that path.
3. Every comment in `harness/spine.js` and `harness/hook-runner.js` describing the gate
   states that it checks test-file **presence**, and none claims test execution,
   regression detection, or "green".
4. `README.md`, `docs/how-it-works.md`, `docs/harness-state-store.md`,
   `docs/harness-audit.md`, and both command specs describe a presence check and name
   the renamed script.
5. The full harness suite (`node --test`) and all `scripts/test-*.sh` pass unchanged in
   count and outcome — this is a naming change with zero behavioral delta.
6. A regression guard fails if any live surface reintroduces a reference to the old path.

## Agent Scope

Research for this plan was performed **directly** (grep/read) in the same session that
filed the #97 assessment, before `/rad-adopt` was invoked — not via `spine-mapper` or
`ci-surface-mapper`. Recorded here as a deviation from the "context tools only" rule so
the architect can weigh it. No agents were called. No out-of-scope agent dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/check-tests.sh | 1-98 | `git mv` to `scripts/check-tests-present.sh`; update header comment lines 2-6 |
| harness/spine.js | 51-53 | Rewrite POST_CHECKS comment: presence gate, not regression detection |
| harness/spine.js | 174-178 | Rewrite resume-verify comment: cumulative presence check, not "still green" |
| harness/spine.js | 212 | Call site → `scripts/check-tests-present.sh` |
| harness/spine.js | 254, 265-269, 275 | Rewrite per-wave gate comments; presence language |
| harness/spine.js | 293 | Call site → `scripts/check-tests-present.sh` |
| harness/hook-runner.js | 6, 159 | Update the exemplar reference to the new script name |
| harness/test/spine.test.js | 89-95, 117, 319-580, 754-755 | Update path strings + test-name/comment language |
| harness/test/resume.test.js | 156, 228-231 | Update path strings + comment language |
| scripts/test-script-hardening.sh | 116-123 | Invoke the renamed script |
| scripts/test-check-tests-present.sh | new | Dedicated behavior test + stale-reference guard |
| README.md | 195 | "checks for test coverage" → presence of promised test files |
| docs/how-it-works.md | 157, 200 | Presence language; renamed script |
| docs/harness-state-store.md | 337 | Renamed script in the `sh()` example |
| docs/harness-audit.md | 224 | Renamed script |
| .claude/commands/team/rad-review.md | 106 | Renamed script |
| .claude/commands/team/rad-deliver.md | 304, 310 | Renamed script + presence language |
| .claude/agents/spine-integration-orchestrator.md | 17, 41 | Renamed script |
| .claude/agents/hook-surface-mapper.md | 17, 19, 23, 31 | Renamed script |
| .claude/agents/hook-runtime-orchestrator.md | 23, 29 | Renamed script |

## Execution Notes

### Do Not Touch
- `plans/rad-v2-*.md` — frozen archive; they record what was decided at the time
- `.agents/plans/*.md`, `.agents/research/*.md`, `.agents/architecture/*.md` — historical
  records; rewriting them falsifies the archive (architect decision, 2026-08-05)
- `.claude/settings.local.json` — user-local permission entries, not project state
- `harness/gates.js`, `harness/matrix.yaml`, `.agents/state/**` — no gate or routing change
- `spine.js:303-304` `categories`/`summary` values — recorded event data (see Issue Gaps)

### Key Files
- `harness/spine.js` — the only caller; carries all the misleading narration
- `scripts/check-tests.sh` — read the header first; it is already accurate
- `scripts/test-script-hardening.sh` — the existing #7 case is the behavior baseline to preserve
- `.agents/plans/resume-and-verify.md` — the plan that introduced the per-wave gate; useful
  context for *why* the comments say what they say (read only, do not edit)

### Reminders
- **The spine cannot rename its own dependency mid-run** (see Risks). Wave 1 must be
  delivered such that a running deliver never calls a path that no longer exists.
- Use `git mv` so the rename is recorded as a rename, not delete+add — the history
  matters for #97's anchor registry.
- `## Tests to Write` lines must end with a single bare path so the presence check can
  parse them.
- Zero behavioral delta is the whole point: if the suite's pass count changes, something
  is wrong.

## Wave Plan

### Wave 1 — sequential
Tasks must run in sequence: the rename and its callers have to land together or the
suite breaks between tasks.

#### Task 1.1: Rename the script and correct its header
File: scripts/check-tests.sh:1-12
What: `git mv scripts/check-tests.sh scripts/check-tests-present.sh`. Update the header
comment to the new name and state plainly that it verifies presence on disk and executes
nothing. Do not alter parsing, exit codes, or output text.
Validate: AC#1 — the renamed script produces byte-identical stdout and exit codes to the
pre-rename script for present, missing, unresolvable, empty-section, and backtick cases.

#### Task 1.2: Update spine call sites and narration together
File: harness/spine.js:51-305
What: Point both `sh(...)` invocations (lines 212, 293) at `scripts/check-tests-present.sh`.
In the same pass rewrite the misleading comments at 51-53, 174-178, 254, 265-269, and 275
so each describes a **presence** gate: drop "regression", "still green", and "the
cumulative tests are green"; state the real guarantee — a wave does not advance if a
promised test file is absent — and note that execution-based verification does not exist
yet (#89). Leave `categories`/`summary` values at 303-304 unchanged (recorded event data).
Validate: AC#2, AC#3 — no comment in spine.js claims execution, regression detection, or
greenness, and no reference to the old path remains in harness/.

#### Task 1.3: Update spine test path references
File: harness/test/spine.test.js:89-755
What: Update every literal `scripts/check-tests.sh` string and every
`.endsWith('check-tests.sh')` matcher to the new filename, plus the surrounding comment
language. Behavior assertions stay identical.
Validate: AC#5 — `node --test harness/test/spine.test.js` passes with the same test count
and outcomes as before the rename.

### Wave 2 — sequential
Remaining test surfaces, then the new dedicated test that locks the rename in.

#### Task 2.1: Update resume test path references
File: harness/test/resume.test.js:156-231
What: Update the path literal and the two comment lines describing the cumulative gate.
Validate: AC#5 — `node --test harness/test/resume.test.js` passes with the same test count
and outcomes as before.

#### Task 2.2: Update the shell hardening test
File: scripts/test-script-hardening.sh:116-123
What: Point case #7 at the renamed script. The backtick-resolution assertions are the
behavior baseline and must not change.
Validate: AC#5 — `scripts/test-script-hardening.sh` passes with the same case count.

#### Task 2.3: Dedicated test and stale-reference guard
File: scripts/test-check-tests-present.sh
What: New file. Cover present, missing, unresolvable, empty-section, and backtick-wrapped
path cases against the renamed script, each asserting an explicit exit code; assert the
script is executable. Add a guard that greps live surfaces — excluding `plans/`,
`.agents/`, `.git/`, `node_modules/` — and fails if `scripts/check-tests.sh` reappears.
Validate: AC#1, AC#6 — the guard fails on a reintroduced stale reference in a live file
and passes on the clean tree.

### Wave 3 — parallel
Disjoint files; safe to run concurrently.

#### Task 3.1: Correct the hook-runner exemplar references
File: harness/hook-runner.js:6-159
What: Update the two references naming `check-tests.sh` as the invocation-shape exemplar
to the new filename. The invocation-shape claim is accurate and stays.
Validate: AC#3 — both references name the renamed script; no execution claim is introduced.

#### Task 3.2: README
File: README.md:195
What: Replace "checks for test coverage in deliver output" with presence language naming
the renamed script — it checks that promised test files exist, not that tests pass.
Validate: AC#4 — the line names the renamed script and describes a presence check.

#### Task 3.3: How-it-works doc
File: docs/how-it-works.md:157-200
What: Update both references. Line 200's "confirms they exist before the deliver PR opens"
is accurate but sits under a heading implying verification — make the presence limit
explicit and name #89 as the gap.
Validate: AC#4 — both lines name the renamed script and describe a presence check.

### Wave 4 — parallel
Disjoint files; safe to run concurrently.

#### Task 4.1: Harness state-store doc
File: docs/harness-state-store.md:337
What: Update the `sh()` invocation example to the renamed script.
Validate: AC#4 — the example names the renamed script.

#### Task 4.2: Harness audit doc
File: docs/harness-audit.md:224
What: Update the post-check list to the renamed script. The DET/MODEL split claim is
unaffected.
Validate: AC#4 — the line names the renamed script.

#### Task 4.3: Command specs
File: .claude/commands/team/rad-deliver.md:304-310
What: Update the invocation to the renamed script and make clear the check reports
*absence* of promised test files, not test failure; keep the instruction to write missing
tests. Apply the same rename to `.claude/commands/team/rad-review.md:106`.
Validate: AC#4 — both specs invoke the renamed script and neither implies tests were run.

### Wave 5 — parallel
Single task; isolated to agent definitions.

#### Task 5.1: Agent definitions
File: .claude/agents/spine-integration-orchestrator.md:17-41
What: Update every `check-tests.sh` reference to the new filename here and in
`.claude/agents/hook-surface-mapper.md` (lines 17, 19, 23, 31) and
`.claude/agents/hook-runtime-orchestrator.md` (lines 23, 29). The "hard-coded per-wave
veto" characterization is accurate and stays.
Validate: AC#2, AC#4 — no agent file references the old path; the veto-pattern guidance is
unchanged in meaning.

## Tests to Write
- [ ] Renamed script behavior across present/missing/unresolvable/empty/backtick cases — scripts/test-check-tests-present.sh
- [ ] Stale-reference guard fails when scripts/check-tests.sh reappears in a live surface — scripts/test-check-tests-present.sh
- [ ] Existing backtick-path case still passes against the renamed script — scripts/test-script-hardening.sh
- [ ] Spine per-wave gate and resume-verify still call the gate script at the same points — harness/test/spine.test.js
- [ ] Resume path still skips the cumulative gate when all waves are complete — harness/test/resume.test.js

## Non-Goals
- Adding real test execution, build, typecheck, or lint to the gate — that is #89 and
  must remain a separate gate answering a different question.
- Changing gate semantics, exit codes, output text, matrix routing, or the doom-loop
  fingerprint. This plan has zero behavioral delta.
- Rewriting historical plans, research artifacts, or architecture records to match the
  new name.
- Building #97's invariant registry. This plan only produces the seed anchor and a
  single-purpose stale-reference guard.

## Out-of-Scope Dependencies
None. All files are within the architect's scope, and no architect-only agent is required.

## Risks

- **The spine cannot rename its own dependency mid-deliver.** `harness/spine.js` is loaded
  into memory when a deliver starts. If Wave 1 renames the script while a deliver is
  running, the in-memory spine still calls `scripts/check-tests.sh`, the per-wave gate
  fails, and the wave is demoted to `fail-tests` — the plan cannot deliver itself through
  the unmodified spine. **Recommended resolution: deliver Wave 1 by hand** (it is a `git mv`
  plus four mechanical edits), then run Waves 2–3 normally. The alternative — a transient
  shim removed in the final wave — reintroduces the misleading name the architect
  explicitly declined, and its own removal hits the same problem.
- Test files reference the script path as string literals in several matchers
  (`.endsWith('check-tests.sh')`); a partial update leaves tests passing for the wrong
  reason. Task 1.3 must be verified by pass-count parity, not by a green suite alone.
- `docs/discovery-interactive-evaluation.md:21` already describes the check accurately;
  an over-eager sweep could make it *less* accurate. Named explicitly in Task 3.1.

## Issue Gaps

Assumptions this plan made where #91 was silent — each should be verified at approval:

- **No shim.** #91 suggested keeping `check-tests.sh` "as a shim if anything external
  calls it". Architect decision (2026-08-05): clean rename, no shim, since `spine.js` is
  the only in-repo caller and RAD has no external consumers. **If any downstream project
  or operator hooks dir invokes the old path, this is a breaking change.**
- **Historical records untouched.** #91 said "update `docs/` references" without
  distinguishing live docs from the archive. Architect decision: `plans/`, `.agents/plans/`,
  `.agents/research/`, and `.agents/architecture/` are frozen records and stay as-is.
  A grep for the old name will therefore still return ~30 historical hits by design.
- **Recorded event data left alone.** `spine.js:303-304` sets `categories: ['check-tests']`
  and a summary string containing the old name. These are *recorded into the event log*
  and may be matched by folds, so renaming them is a data change, not a naming change —
  excluded here under the "additive at parity" rule. Recommend handling under #63/#97
  where event-data evolution is already being designed. **The recorded category will
  therefore keep the old name after this plan lands.**
- **Name choice.** #91 offered `check-tests-present.sh` or `check-promised-tests.sh`.
  This plan picks `check-tests-present.sh` — closer to the existing name, so the
  `check-*` script family stays alphabetically adjacent.
- **New test file location.** #91 did not specify test coverage. This plan adds
  `scripts/test-check-tests-present.sh`, matching the existing `scripts/test-<name>.sh`
  convention, rather than extending `test-script-hardening.sh`.
- **Delivery method.** #91 assumed normal delivery. This plan concludes Wave 1 cannot be
  delivered by the running spine (see Risks) and recommends executing it by hand. The
  architect should confirm that at approval.
