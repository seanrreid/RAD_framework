# Plan: rad deliver Finish Wiring and Delivered Rerun (#186 part 3b-ii-b)
Created: 2026-10-07
Author: architect
Status: pending-review
Branch: rad/deliver-finish-wiring
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
3b-ii-a (PR #204) shipped three pieces, none of which `rad deliver` uses yet:
- the optional `finish = { beforePr, afterPr }` port in `deliverSpine`;
- the real port `makeFinishPort({ sh, root, feature, planPath, workBranch })` in `harness/deliver-finish.js`;
- an `open-pr.sh` that accepts an existing PR.

This plan connects the port in `rad deliver`, so a run ends the way the prose did:
- the plan is marked `complete` with `Completed-At:`;
- it is committed with the event log, pushed and labeled `review`;
- the PR is opened;
- `pr-opened` is committed and pushed.

It also adds the `delivered` rerun short-circuit. Today a rerun of a delivered feature crashes on the `deliver-started` append (exit 1, "unexpected error").

Decisions the user made on 2026-10-07:
- **Q2:** a rerun of a `delivered` feature skips the spine and runs only the finish tail.
- **Q4:** if `afterPr` fails in worktree mode, the worktree is torn down as if the run succeeded. The safety-net `commitRunEvents` commits `pr-opened` to the local branch, the worktree is removed, and the run exits 1. A plain rerun then sees `delivered` and pushes. This is the one documented exception to "every non-zero exit preserves the worktree".

## Scope
| In scope | Out of scope |
|---|---|
| Build the real `finish` port in both modes; `ctx.finish` overrides it | The deterministic PR body (3b-iii) |
| The `delivered` short-circuit before the resume check | The test wave (3c) and the deliver skill rewrite (3d) |
| The Q4 teardown after a failed `afterPr` | Changing the spine, the port or `open-pr.sh` (shipped in 3b-ii-a) |
| A no-op `finish` default in all four deliver test helpers | Reading preserved worktrees from the short-circuit |
| Evals and docs (finish phase, existing PR, rerun, the Q4 exception) | |

## Acceptance Criteria
1. **Wiring.**
   - `deliverCommand` builds the finish port with a `buildFinishPort` helper next to `buildPreparePort`. It uses `ctx.finish` if provided; otherwise `makeFinishPort` with the run root (the worktree path or the repo root), the work branch from `resolveWorkBranch`, and the plan path relative to the root.
   - The port is passed to `deliverSpine` as `finish`. A build error is handled like a prepare-port build error.
   - In a real run, the branch gains `deliver(<f>): mark plan complete` before the PR and `deliver(<f>): record pr-opened` after it.
2. **The `delivered` short-circuit.** Before `resolveResume`, `deliverCommand` reads history with `readResumeHistory` and folds it with `phaseOf` (events.js). If the phase is `delivered`, it skips setup, the gate, prepare and waves:
   - **Main mode** (`RAD_WORKTREE=0`): runs `makeFinishPort(...).afterPr()` rooted at the repo root, then labels.
   - **Worktree mode:**
     - runs `git push origin <workBranch>`, which is never forced;
     - then runs `rad-label.sh <issue> review`, with the issue read through `planIssueNumber` from the plan at the branch tip, and the label skipped when there's none;
     - there is nothing to commit, because Q4 teardown already committed to the branch.
   - **On success** both modes print `rad deliver: already delivered feature=<f>` and exit 0. This also applies with `--resume`.
   - **On failure** (a refusal, a push failure or a label failure) it prints `rad deliver: <reason>` and exits 1.
   - The short-circuit is one helper of ~40 lines or less, plus small per-mode helpers.
3. **Q4 teardown.** When the spine returns `afterPr: true`:
   - **Worktree mode:** `finishWorktree` runs as if completed. `commitRunEvents` commits, and the worktree is removed. If that commit fails, the worktree is preserved as today.
   - **Both modes:** the run then exits 1 through `reportStop`, which prints the `finish-failed` decision.
   - `completionEvidence` is unchanged for every other result.
4. **Test helpers.** In cli.test.js, worktree.test.js, deliver.test.js and agent-adapters.test.js, every deliver helper and direct `deliverCommand` call defaults to a no-op `finish`. The no-op is `{ beforePr: async () => ({ ok: true, data: {} }), afterPr: async () => ({ ok: true, data: {} }) }`, wired the same way as `noopPrepare`. All existing tests pass with no assertion changes. If an event-sequence assertion has to change, the PR lists it.
5. **New CLI tests** (cli.test.js):
   - (a) the port is wired: an injected `finish` is called in order, and `beforePr` returning `ok:false` exits 1 with `finish-failed` and no `open-pr.sh` call;
   - (b) `afterPr` returning `ok:false` exits 1, and `pr-opened` is the last event;
   - (c) main mode with a delivered log exits 0, prints `already delivered`, runs no wave, appends no event, and the injected `sh` sees the push/label calls;
   - (d) the same with `--resume`;
   - (e) a short-circuit whose push fails exits 1 with the reason.
   - worktree.test.js gets (f): `afterPr` failing tears the worktree down (complete, not preserve) and exits 1, and (g): a delivered branch-tip log short-circuits with push and label.
6. **Evals.** `node --test harness/evals/*.eval.js` passes. `deliver-isolated-by-default` still asserts that the run's events are committed on the work branch, now accepting `mark plan complete` / `record pr-opened` / `record deliver run events`. It still checks teardown and that the main checkout stays on `main`. The fixture changes only if the finish phase needs it.
7. **Docs.**
   - `docs/rad-wave-contract.md`: the `finish-failed` row, and a "Finish phase" paragraph covering the order, why nothing is recorded after `pr-opened`, the commit subjects, and that an existing PR counts as success.
   - `docs/rad-cli.md` `### rad deliver` covers:
     - the finish phase, and that an existing open PR counts as success;
     - `finish-failed` exits 1 and a plain rerun recovers;
     - a rerun of a delivered feature only pushes, labels and exits 0.
   - The worktree lifecycle section documents the Q4 exception.

## Agent Scope
Research came from the 3b-ii sub-agent survey (deliverCommand, the four deliver test helpers, evals, docs) and targeted greps after #204 merged. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 1160-1205 | `finishWorktree`/`commitRunEvents`: Q4 teardown |
| harness/cli.js | 1240-1260 | `readResumeHistory` reused by the short-circuit |
| harness/cli.js | 1335-1390 | `completionEvidence`, `reportStop` |
| harness/cli.js | 1455-1530 | `resolveWorkBranch`, `buildPreparePort` → new `buildFinishPort` |
| harness/cli.js | 1570-1760 | `deliverCommand`: short-circuit, pass `finish`, `afterPr` handling |
| harness/deliver-finish.js | 130-160 | Read only: `makeFinishPort` |
| harness/events.js | 215-230 | Read only: `phaseOf` |
| harness/plan-commit.js | 65-80 | Read only: `planIssueNumber` |
| harness/test/cli.test.js | 555-690 | `runDeliverCaptured` no-op `finish`; new AC#5 cases |
| harness/test/cli.test.js | 2040-2052 | `runDeliverStderrOnly`: no-op `finish` |
| harness/test/cli.test.js | 2880-2895 | `runAcpDeliver`: no-op `finish` |
| harness/test/worktree.test.js | 175-265 | `runDeliver` no-op `finish`; cases (f), (g) |
| harness/test/deliver.test.js | 65-75 | `noopFinish` next to `noopPrepare` |
| harness/test/deliver.test.js | 140-145 | Pass `finish` |
| harness/test/deliver.test.js | 186-192 | Pass `finish` |
| harness/test/deliver.test.js | 230-236 | Pass `finish` |
| harness/test/agent-adapters.test.js | 850-870 | `runDeliver`: no-op `finish` |
| harness/evals/delivery.eval.js | 150-180 | `deliver-isolated-by-default`: accept the finish subjects |
| harness/evals/lib/fixture.js | 116-176 | Only if the finish phase needs it |
| docs/rad-wave-contract.md | 350-460 | Stop row, Finish phase |
| docs/rad-cli.md | 485-520 | Deliver section: finish phase, existing PR |
| docs/rad-cli.md | 660-705 | Exit codes, finish-failed, rerunning a delivered feature |
| docs/rad-cli.md | 780-835 | Worktree lifecycle: the Q4 exception |

## Execution Notes

### Do Not Touch
- harness/spine.js, harness/stops.js, harness/deliver-finish.js, scripts/open-pr.sh: shipped in 3b-ii-a
- harness/transitions.js, harness/gates.js, harness/gates.yaml: `delivered` stays terminal
- .claude/commands/team/rad-deliver.md: replaced in 3d

### Key Files
- harness/cli.js `deliverCommand` (1570-1756): resume check ~1638, setup ~1653, `buildPreparePort` call ~1668, `deliverSpine` ~1681-1710, `finishWorktree` ~1727, `bestEffortSyncPush` ~1737, evidence/exit ~1744-1755
- harness/cli.js `readResumeHistory` (1245), `readBranchTipHistory` (786), `buildPreparePort` (1486), `finishWorktree` (1181), `completionEvidence` (1341)
- harness/deliver-finish.js `makeFinishPort` (146): `afterPr` fails closed when events.jsonl is missing
- harness/test/cli.test.js `runDeliverCaptured` (565-588) and the prepare-port tests (605-680): the pattern for the new cases

### Reminders
- **The short-circuit goes BEFORE `resolveResume`.** A delivered feature has no stopped run, so a resume check placed first would refuse `--resume`.
- **Nothing may be appended after `pr-opened`,** and the short-circuit never calls the spine.
- **Every git call is an args array through the injected `sh`.** No force-push.
- **Fail closed:** every short-circuit failure exits 1 with its reason; nothing is skipped silently.
- **Keep `deliverCommand` readable.** Put the new logic in helpers under ~40 lines rather than growing the function.

## Program Design

**Signatures**
```js
// harness/cli.js
function buildFinishPort({ ctx, sh, root, feature, planPath, workBranch })   // → { finish } | { code }
async function finishDelivered({ feature, repoRoot, sh, ctx, history })      // → exit code, or null when not delivered
```

**Call stack: `rad deliver <f>`**
```
parse → config → cap → hooks
history = readResumeHistory(); phaseOf(history) === 'delivered' → finishDelivered → exit 0 | 1
resolveResume → setup → prepare port, finish port → deliverSpine({ …, finish })
result.afterPr → (worktree) finishWorktree as completed → reportStop → exit 1
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: CLI wiring, short-circuit and Q4 teardown
File: harness/cli.js:1160-1205, 1240-1260, 1335-1390, 1455-1530, 1570-1760, harness/test/cli.test.js:555-690, 2040-2052, 2880-2895, harness/test/worktree.test.js:175-265, harness/test/deliver.test.js:65-75, 140-145, 186-192, 230-236, harness/test/agent-adapters.test.js:850-870
What: Implement AC#1 to AC#3 in `cli.js` with the helpers in Program Design. Add the AC#4 no-op `finish` default to every deliver helper and direct call in the four test files. Add the AC#5 cases.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5 — `node --test harness/test/*.test.js` passes in full (report the counts)

#### Task 1.2: Evals
File: harness/evals/delivery.eval.js:150-180, harness/evals/lib/fixture.js:116-176
What: Run `node --test harness/evals/*.eval.js`. Update `deliver-isolated-by-default` per AC#6. The fixture is `platform: manual` with no `Issue:`, so `open-pr.sh` takes the manual path and the label is skipped. Change the fixture only if the finish phase needs it.
Validate: AC#6 — `node --test harness/evals/*.eval.js` passes (report the counts)

### Wave 2 — parallel

#### Task 2.1: Docs
File: docs/rad-wave-contract.md:350-460, docs/rad-cli.md:485-520, 660-705, 780-835
What: Write the AC#7 doc changes.
Validate: AC#7 — `grep -n 'finish-failed' docs/rad-wave-contract.md docs/rad-cli.md` matches in both files, and `grep -n 'already delivered' docs/rad-cli.md` matches

## Tests to Write
- [ ] CLI: port wiring, beforePr/afterPr failures, delivered short-circuit (main, --resume, push failure) — harness/test/cli.test.js
- [ ] Worktree: afterPr failure tears down and exits 1; delivered branch-tip short-circuit — harness/test/worktree.test.js

## Non-Goals
- The deterministic PR body (3b-iii) and the test wave (3c).
- Rewriting `/rad-deliver` prose (3d).
- Making the short-circuit read preserved worktrees (the Q4 hybrid the user declined).
- Changing `transitions.js`.

## Out-of-Scope Dependencies
None

## Risks
- **The plan can say `complete` while the run is stopped.** `beforePr` commits `Status: complete` before `open-pr.sh`. If `open-pr.sh` then fails, the next run's prepare phase rewrites `in-progress`, and the waves rerun (today's behavior).
- **Main mode now commits and pushes the plan and event log at the end of a run.** This is intended. `check-scope` exempts `.agents/` process artifacts.
- **Q4 breaks the preserve-on-failure rule for one case.** It is documented, and the commit-failure path still preserves the worktree.
- **The no-op `finish` in test helpers hides the real port in old tests.** Mitigation: the real port's real-git tests (3b-ii-a), plus the new wiring cases.
- **Self-protected paths** (`harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — the short-circuit runs before `resolveResume`.** A delivered feature has no stopped run, so `--resume` must not be refused first.
- **Assumption — a main-mode short-circuit that isn't on the work branch exits 1** with the port's refusal reason, rather than 2. It is a state problem, not a usage error.
- **Assumption — the worktree-mode short-circuit reads the issue number from the plan at the branch tip** (`git show rad/<f>:<plan>`), because there's no checkout of the work branch.
- **Assumption — the message is `already delivered feature=<f>`, with no PR URL.** The URL needs a platform call, which is better placed in 3b-iii.
