# Plan: Put Each Wave's Tasks in Its Prompt (#213)
Created: 2026-10-08
Author: architect
Status: complete
Completed-At: 2026-10-08T16:21:40Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-08T16:14:50.246Z
Recorded-By: sean@torchcodelab.com
Branch: rad/wave-task-prompts
Issue: 213
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/213
Issue-Title: rad deliver sends waves with an empty Tasks block

## Context
`rad deliver` never puts a wave's tasks into the agent's prompt. The plan state gives the spine waves as `{ n, heading }` only, so `buildWavePrompt` (harness/adapters/agent/contract.js ~158-280, which reads `wave.type` and `wave.tasks[].title/files/what/validate`) renders an empty `## Tasks` block. Waves only succeed when the agent reads the plan file on its own. In the live `resume-worktree-stop` run, wave 3's agent correctly refused (`blocked_spec`), which aborted the run. Both earlier waves' agents flagged the empty block in their concerns.

The user decided on 2026-10-08:
- **Approach:** the `waveVerify` pattern. The CLI parses each wave's `#### Task N.M:` blocks and its type, passes them to the spine as a map, and the spine attaches them to the wave it hands `runWave`.
- **Q1:** a plan wave with no parseable tasks makes `rad deliver` **refuse before any wave runs** (exit 2), naming the wave and the expected format. The synthetic test wave is exempt, because it brings its own tasks.

## Scope
| In scope | Out of scope |
|---|---|
| `taskBlocksByWave(text)` in plan-tasks.js | Changing `buildWavePrompt` or the adapters |
| `parsePlanCtx().waveTasks` and the refusal on task-less waves | The state store's `parsePlan` |
| The spine's `waveTasks` option, attached on the `runWave` call | The wave timeout (#211), `stop-status` (#212) |
| Docs | |

## Acceptance Criteria
1. **The parser.** `taskBlocksByWave(text)` in harness/plan-tasks.js returns `Map<waveNumber, { type, tasks }>`.
   - **`type`:** `parallel` or `sequential`, from the `### Wave N — <type>` heading. It's `sequential` when the heading doesn't say.
   - **`tasks`:** one `{ title, files, what, validate }` per `#### Task N.M: <title>` under that wave.
     - `files` comes from the task's first `File:` line via `parseFileLine`, or `[]` if there isn't one.
     - `what` is the text after `What:` plus any following lines up to the next `Validate:` / `File:` / `#### ` / `### ` / `## ` line. It's trimmed, with internal line breaks kept.
     - `validate` is the `Validate:` line's text, plus continuation lines in the same way.
   - Tasks before any wave heading are ignored, and non-string input throws `TypeError`.
   - `taskFilesByWave` and `taskFilesFromPlanText` are unchanged.
2. **The refusal.** `parsePlanCtx` gains `waveTasks: Record<number, { type, tasks }>`. In `rad deliver`, after the plan doc loads (`loadPlanCtx`), if any plan wave in `waveNumbers` has no tasks in `waveTasks`:
   - it prints `rad deliver: wave N has no tasks in the plan — each wave needs '#### Task N.M: <title>' blocks with File:/What:/Validate: lines` (listing every such wave) and exits **2** before any wave runs;
   - in worktree mode, the just-created worktree is preserved like any other setup failure;
   - a missing plan doc keeps today's exit 1.
3. **The spine.** `deliverSpine` accepts an optional `waveTasks` (default `{}`).
   - When `runWave` is called for a plan wave that has an entry, the wave object passed is `{ ...wave, type, tasks }` from that entry.
   - A wave object that already has `tasks` (the synthetic test wave) is passed unchanged.
   - Without an entry, or without the option, the call is exactly as today.
4. **Wiring.** `rad deliver` passes `waveTasks: planCtx.waveTasks` to `deliverSpine`. A real wave prompt then contains every task's title, `File:`, `What:` and `Validate:`.
5. **Tests.**
   - harness/test/plan-tasks.test.js (append) covers `taskBlocksByWave`:
     - two waves with the type taken from the heading, and the default type;
     - several tasks per wave;
     - multi-line `What:` and `Validate:`;
     - a task with no `File:`;
     - a task outside any wave;
     - a non-string input throwing.
   - The new harness/test/spine-wave-tasks.test.js covers:
     - the entry attached on the `runWave` call;
     - a wave with its own tasks passed unchanged;
     - no option → unchanged.
   - harness/test/cli.test.js (append) covers:
     - `parsePlanCtx().waveTasks`;
     - a plan with a task-less wave → exit 2 with the message, and no `runWave` call;
     - a real deliver whose injected `runWave` receives tasks.
     - **And** builds a real prompt (`buildWavePrompt(wave, planCtx)` on the received wave) that contains a task title and its `Validate:` text.
   - No existing assertion changes. If one must, because a test's seeded plan has a task-less wave, update that seed and list it.
6. **Docs.**
   - docs/rad-wave-contract.md "The wave prompt" (~245-259): the tasks come from the plan's `#### Task` blocks, and a task-less wave is refused.
   - docs/rad-cli.md `### rad deliver`: one line on the exit-2 refusal.

## Amendments
- **Amendment 1 (2026-10-08, after Wave 3):** the up-front refusal made seed plans with task-less waves fail about 75 existing tests. Task 3.1 added one `#### Task 1.1: Task A` line to the seed plan in `harness/test/deliver.test.js` (`writePlanDoc`, ~63) and `harness/test/worktree.test.js` (`writeApprovedPlan`, ~225). No assertion changes. Both files are added to Files in Scope.

## Agent Scope
Research came from the 3c survey (the wave prompt fields, `parsePlan`'s wave shape, plan-tasks.js) and targeted greps for `loadPlanCtx`, setup, the spine's `runWave` call and `parseWaveVerify`. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/plan-tasks.js | 1-90 | `taskBlocksByWave` |
| harness/test/plan-tasks.test.js | 1-108 | Append parser cases |
| harness/adapters/agent/contract.js | 158-215 | Read only: the fields the prompt renders |
| harness/spine.js | 600-700 | Options doc and signature: `waveTasks` |
| harness/spine.js | 795-805 | Attach tasks on the `runWave` call |
| harness/test/spine-wave-tasks.test.js | 1-1 | New (AC#5) |
| harness/test/spine-test-scope.test.js | 1-60 | Read only: fakes to copy |
| harness/cli.js | 570-600 | Read: the `parseWaveVerify` pattern |
| harness/cli.js | 700-760 | `parsePlanCtx`: `waveTasks` |
| harness/cli.js | 844-860 | `loadPlanCtx`: the task-less-wave refusal |
| harness/cli.js | 1060-1080 | `setupMainRun`: refusal exit code |
| harness/cli.js | 1340-1360 | `setupWorktreeRun`: refusal exit code and preserve |
| harness/cli.js | 1975-2000 | `deliverSpine` call: pass `waveTasks` |
| harness/test/cli.test.js | 1-1 | Append cases (AC#5) |
| harness/test/deliver.test.js | 55-70 | Amendment 1: seed plan gains a `#### Task` block |
| harness/test/worktree.test.js | 218-232 | Amendment 1: seed plan gains a `#### Task` block |
| docs/rad-wave-contract.md | 240-262 | The wave prompt |
| docs/rad-cli.md | 560-620 | Deliver: the refusal |

## Execution Notes

### Do Not Touch
- harness/adapters/agent/*: `buildWavePrompt` already renders the fields
- harness/adapters/git-state-store.js (`parsePlan`)
- harness/transitions.js, harness/gates.*
- The `deliver-docs-sweep` worktree and branch (held for the acceptance test)

### Key Files
- harness/plan-tasks.js: `TASK_HEADER`, `WAVE_HEADER`, `parseFileLine`, `taskFilesByWave` (65+), the parsing model
- harness/adapters/agent/contract.js `buildWavePrompt` (~158-215): `wave.n`, `wave.type`, `wave.tasks[].title|name`, `files|file`, `what`, `validate`
- harness/cli.js: `parseWaveVerify` (576), `parsePlanCtx` (706), `loadPlanCtx` (848), `setupMainRun` (1064), `setupWorktreeRun` (1342), the `deliverSpine` call (~1985)
- harness/spine.js: the `runWave(wave, attemptCtx)` call inside `runOneWave` (~799)

### Reminders
- **Waves run under a fixed 10-minute agent limit (#211).** Validate with only the targeted test files named in each task; the reviewer runs the full suites after.
- **No option means byte-identical behavior** in the spine.
- **Fail closed:** a task-less plan wave refuses up front, never runs empty.
- **Helpers stay under ~40 lines, with named constants** (the default type, the field labels).

## Program Design
```js
// harness/plan-tasks.js
export function taskBlocksByWave(text)   // → Map<number, { type: 'parallel'|'sequential', tasks: [{ title, files, what, validate }] }>
// harness/cli.js
parsePlanCtx(text).waveTasks             // Record<number, { type, tasks }>
loadPlanCtx(root, feature)               // → planCtx | null (missing doc, exit 1) | { code: 2 } (task-less wave)
// harness/spine.js
deliverSpine({ …, waveTasks = {} })      // runWave(wave.tasks ? wave : { ...wave, ...waveTasks[wave.n] }, ctx)
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The task-block parser
File: harness/plan-tasks.js:1-90, harness/test/plan-tasks.test.js:1-108
What: Write AC#1 and its plan-tasks.test.js cases.
Validate: AC#1, AC#5 — `node --test harness/test/plan-tasks.test.js` passes

### Wave 2 — sequential

#### Task 2.1: The spine option
File: harness/spine.js:600-700, 795-805, harness/test/spine-wave-tasks.test.js:1-1
What: Write AC#3 and spine-wave-tasks.test.js.
Validate: AC#3, AC#5 — `node --test harness/test/spine-wave-tasks.test.js harness/test/spine.test.js harness/test/spine-test-wave.test.js` passes

### Wave 3 — sequential

#### Task 3.1: CLI wiring and the refusal
File: harness/cli.js:700-760, 844-860, 1060-1080, 1340-1360, 1975-2000, harness/test/cli.test.js:1-1
What: Write AC#2 and AC#4 and their cli.test.js cases. If an existing test's seeded plan has a task-less wave, update the seed so each wave has a `#### Task` block, and list it.
Validate: AC#2, AC#4, AC#5 — `node --test harness/test/cli.test.js harness/test/worktree.test.js harness/test/deliver.test.js harness/test/agent-adapters.test.js` passes

### Wave 4 — sequential

#### Task 4.1: Docs
File: docs/rad-wave-contract.md:240-262, docs/rad-cli.md:560-620
What: Write AC#6.
Validate: AC#6 — `grep -n "#### Task" docs/rad-wave-contract.md` matches in the wave prompt section; docs only, no further testable surface

## Tests to Write
- [ ] taskBlocksByWave cases — harness/test/plan-tasks.test.js
- [ ] Wave tasks attached on the runWave call — harness/test/spine-wave-tasks.test.js
- [ ] waveTasks parsing, the task-less refusal, and a real prompt carrying tasks — harness/test/cli.test.js

## Non-Goals
- Changing `buildWavePrompt`, the adapters or `parsePlan`.
- Validating task content beyond presence (lint-plan covers AC citations).
- The wave timeout (#211) and `stop-status` (#212).

## Out-of-Scope Dependencies
None

## Risks
- **Test and eval seed plans may have task-less waves** and start refusing (exit 2). Mitigation: Task 3.1 updates any such seed and lists it. The eval fixture's default plan already has a `#### Task` in its wave.
- **Multi-line `What:` parsing** could swallow a following field if a plan uses an unusual layout. Mitigation: it stops at every known field and heading prefix, and there are tests.
- **Self-protected paths** (`harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — the refusal exits 2** (a plan-shape problem, usage class), while a missing plan doc keeps exit 1.
- **Assumption — a missing type in a wave heading defaults to `sequential`,** the same default `buildWavePrompt` uses.
- **Assumption — `files` comes from the first `File:` line only,** matching `taskFilesFromPlanText`.
- **Assumption — the refusal check sits in `loadPlanCtx`.** In worktree mode it therefore happens after the worktree is created, and that worktree is preserved like other setup failures.
