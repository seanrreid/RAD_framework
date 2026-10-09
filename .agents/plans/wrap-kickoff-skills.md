# Plan: rad wrap, and Shared wrap and kickoff Skills (#186 part 4-i)
Created: 2026-10-09
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-09T14:03:30.895Z
Recorded-By: sean@torchcodelab.com
Branch: rad/wrap-kickoff-skills
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
Part 4 moves the last hand-written skills to shared `.rad/skills` sources. `wrap` (`.claude/skills/wrap/SKILL.md`, 153 lines) and `kickoff` (`.claude/skills/kickoff/SKILL.md`, 123 lines) are still hand-written:
- **wrap's Step 2** edits a plan's `Status:` and then runs `git add`/`commit`/`push` and `rad-label.sh`. It tells you to set the invalid `Status: review` (lint-plan.sh `VALID_STATUSES` has no `review`; it's only a label).
- **wrap's Step 4** commits and pushes a `## Session Notes` block.
- **kickoff** changes nothing, but suggests `git fetch && git checkout rad/<feature>`.

#186 decided that `rad wrap` performs wrap's process-artifact commit: "the model still writes the content; the command only performs the state change".

The user decided on 2026-10-09 (part 4 Q1) that **wrap no longer changes plan status**:
- `rad deliver` owns it (`in-progress` in prepare; `complete` with `Completed-At:` and the `review` label in finish).
- `rad wrap <feature>` commits and pushes only the session notes the model wrote, plus the execution log if one exists. It applies no label.
- `review` stays a label only.

`rad-insights` (1,155 lines) is part **4-ii**, kept separate for the plan read budget.

## Scope
| In scope | Out of scope |
|---|---|
| `rad wrap <feature>`: publish the plan's notes (and the execution log) on its work branch, no label | `rad-insights` (4-ii) |
| `publishPlanChange` accepts a missing `labelStatus` (skips labelling) | Claude-side `rad-review` (hand-written by design) |
| `.rad/skills/wrap` and `.rad/skills/kickoff` sources, generated for both tools | Adding `review` to the plan statuses |
| wrap's status step removed; kickoff uses `rad checkout` | |
| Registries, install slice, portability rows and the `$1`/`$2` legend correction, docs | |

## Acceptance Criteria
1. **`publishPlanChange` without a label.** In harness/branch-publish.js, `labelStatus` becomes optional.
   - When it's absent or `null`, `labelIssue` prints `label skipped: no label requested` and returns.
   - An empty or blank string is still a `TypeError`.
   - Every existing caller passes a status, so their behavior is unchanged.
2. **`rad wrap <feature>`** is the new command module harness/wrap.js, modeled on harness/plan-status.js.
   - **Refusals** (exit 2, before any write), each with a message:
     - an unsafe or reserved feature name (`isSafeFeature`, `_architecture`);
     - no plan doc at `.agents/plans/<f>.md`;
     - a plan with no `Branch:`;
     - HEAD isn't the plan's work branch, or something is staged (`requirePublishReady`).
   - **Publish:** it calls `publishPlanChange` with the plan path plus `executionLogPaths(root, feature)` (the exact `<f>-YYYY-MM-DD.md` names), the message `wrap(<f>): session notes` plus a `Plan:` line, the issue from `planIssueNumber`, and **no** `labelStatus`.
   - **Nothing changed:** no commit and no push; it prints `nothing to publish` and exits 0.
   - **Output:** it prints `rad wrap: ok feature=<f> committed=<bool> pushed=<bool>`. A publish failure exits 1 with the message.
   - It never writes the plan's content or its `Status:`.
   - It's registered in `SUBCOMMANDS` with `WRAP_USAGE = 'rad wrap <feature>'`.
3. **The wrap skill.** `.rad/skills/wrap/SKILL.md` has `targets: { claude: skill, codex: skill, codex_implicit: false }`. The body:
   - keeps Steps 1, 3, 4, 4b, 5 and 6 and the summary template;
   - **removes Step 2** (plan status), replacing it with one line saying that `rad deliver` sets plan status, and that wrap records notes only;
   - has Steps 3 and 4 append to `## Notes` / `## Session Notes` as today, then publish with `node harness/cli.js wrap <feature>` instead of `git add`/`commit`/`push`;
   - drops `rad-label.sh`;
   - keeps the Step 4b awk (`$1`/`$2` are awk fields, which is fine);
   - removes the Rules line "Push plan-status changes to the `rad/` branch tip" or rewrites it for notes;
   - passes `FORBIDDEN_PATTERNS`.
4. **The kickoff skill.** `.rad/skills/kickoff/SKILL.md` has `targets: { claude: skill, codex: skill }`. The body is the current one, except that the checkout advice at ~47 becomes `node harness/cli.js checkout <feature>`. It passes `FORBIDDEN_PATTERNS`.
5. **Generated outputs.** `node harness/cli.js generate` replaces `.claude/skills/wrap/SKILL.md` and `.claude/skills/kickoff/SKILL.md` with marked, generated files. Because they're unmarked today, `git rm` them first, as in 3e and 3f. It writes `.agents/skills/wrap/SKILL.md`, `.agents/skills/wrap/agents/openai.yaml` (`allow_implicit_invocation: false`) and `.agents/skills/kickoff/SKILL.md`. `generate --check` exits 0.
6. **Registries and tests.**
   - harness/test/skill-bodies.test.js:
     - `wrap` and `kickoff` go in `TOOL_NEUTRAL_SKILLS`; `wrap` also goes in `EXPLICIT_ONLY_SKILLS`;
     - `REQUIRED_COMMANDS` gets `wrap: ['node harness/cli.js wrap']` and `kickoff: ['node harness/cli.js checkout']`;
     - the Claude-path helper resolves `.claude/skills/<name>/SKILL.md` for `claude: skill` sources;
     - the `$ARGUMENTS` assertion applies only to skills whose source uses `{{args}}`.
   - scripts/test-install-harness.sh: `SLICE_SKILLS` gains both, plus an openai.yaml assert for wrap.
   - The new harness/test/cli-wrap.test.js runs real git with a bare origin (copying cli-plan-status.test.js). It covers:
     - notes committed and pushed with no label call;
     - the execution log included, and a prefix-sharing feature's log excluded;
     - nothing to publish → exit 0 with no commit;
     - a wrong branch, staged changes, a missing plan and a bad name each exit 2;
     - a push failure exits 1;
     - `Status:` is never changed.
   - A harness test (in cli-wrap.test.js) checks that `publishPlanChange` with no `labelStatus` skips labelling, and that a blank string throws.
7. **Docs.**
   - docs/rad-tool-portability.md: the wrap and kickoff rows read `generated (#186 part 4-i)`. The roadmap row (~24) is updated. The Deps legend (~45-46) is corrected: `$1/$2` in wrap and insights are awk fields, not positional arguments, and only `{{args}}` is a token. The ~88-93 notes are updated.
   - docs/rad-cli.md: a new `### rad wrap` section covering usage, refusals, exit codes, no label, and that it never changes status.
   - docs/daily-workflow.md (~354): `/wrap` records session notes and publishes them with `rad wrap`, and plan status comes from `rad deliver`.

## Agent Scope
Research came from a read-only sub-agent survey of the hand-written skills (wrap, kickoff, rad-insights, rad-review), wrap's state changes and the plan-status and label sets, `publishPlanChange`/`requireRequest`/`labelIssue`, the plan-status.js command model, the generate targets, the skill-bodies and install-harness registries, and the portability rows. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/branch-publish.js | 95-142 | `labelStatus` optional |
| harness/wrap.js | 1-1 | New: `wrapCommand`, `WRAP_USAGE` |
| harness/plan-status.js | 1-182 | Read only: the command model |
| harness/deliver-finish.js | 30-60 | Read only: `executionLogPaths` |
| harness/cli.js | 66-110 | Import and usage |
| harness/cli.js | 205-240 | `SUBCOMMANDS`: `wrap` |
| harness/test/cli-wrap.test.js | 1-1 | New (AC#6) |
| harness/test/cli-plan-status.test.js | 1-80 | Read only: bare-origin test model |
| .rad/skills/wrap/SKILL.md | 1-1 | New source |
| .claude/skills/wrap/SKILL.md | 1-153 | Replaced by the generated output |
| .agents/skills/wrap/SKILL.md | 1-1 | New (generated) |
| .agents/skills/wrap/agents/openai.yaml | 1-1 | New (generated) |
| .rad/skills/kickoff/SKILL.md | 1-1 | New source |
| .claude/skills/kickoff/SKILL.md | 1-123 | Replaced by the generated output |
| .agents/skills/kickoff/SKILL.md | 1-1 | New (generated) |
| harness/test/skill-bodies.test.js | 1-130 | Registries, path helper, args assertion |
| scripts/test-install-harness.sh | 530-560 | `SLICE_SKILLS` and openai.yaml assert |
| docs/rad-tool-portability.md | 20-30 | Roadmap row |
| docs/rad-tool-portability.md | 40-100 | Legend, rows and notes |
| docs/rad-cli.md | 1-1 | New `### rad wrap` section (append near rad label) |
| docs/daily-workflow.md | 345-360 | `/wrap` |

## Execution Notes

### Do Not Touch
- .claude/commands/shared/rad-insights.md (4-ii)
- .claude/commands/team/rad-review.md (hand-written by design)
- scripts/lint-plan.sh `VALID_STATUSES`, scripts/rad-label.sh
- harness/deliver-finish.js and deliver-prepare.js behavior

### Key Files
- harness/plan-status.js: the VERB/USAGE consts, Stop class, arg parsing, `loadRequest` refusals, publish, and exit mapping (22-182)
- harness/branch-publish.js: `labelIssue` (100-110), `requireRequest` (113-118), `publishPlanChange` (128-142)
- harness/deliver-finish.js: `executionLogPaths`
- .claude/skills/wrap/SKILL.md: Step 2 (27-41), Step 4 commit (86-88), Rules (144-153)
- harness/test/skill-bodies.test.js: `CLAUDE_COMMAND_ROLE`, `claudeCommandPath` (57-65), the `$ARGUMENTS` assertion (~120-122)

### Reminders
- **Waves run under the 10-minute agent limit.** Validate with targeted commands only; the reviewer runs the full suites.
- **Edit sources, `git rm` the unmarked outputs, then run `node harness/cli.js generate`.**
- **`rad wrap` never writes plan content or status, never labels, and names paths explicitly.**
- **Keep wrap's and kickoff's other steps unchanged.**
- **Helpers stay under ~40 lines, with named constants.**

## Program Design
```js
// harness/wrap.js
export const WRAP_USAGE = 'rad wrap <feature>';
export async function wrapCommand(argv, ctx)   // → 0 | 1 (publish failure) | 2 (refusal)
// harness/branch-publish.js
publishPlanChange(sh, root, { verb, branch, paths, message, issue, labelStatus? })  // labelStatus optional
```
```
rad wrap f → parse → plan exists → Branch: → requirePublishReady → paths = [plan, ...executionLogPaths]
  → publishPlanChange({ …, no labelStatus }) → print ok line
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: rad wrap and the optional label
File: harness/branch-publish.js:95-142, harness/wrap.js:1-1, harness/cli.js:66-110, 205-240, harness/test/cli-wrap.test.js:1-1, docs/rad-cli.md:1-1
What: Write AC#1 and AC#2, cli-wrap.test.js (AC#6, including the `publishPlanChange` no-label cases), and the `### rad wrap` docs section.
Validate: AC#1, AC#2, AC#6 — `node --test harness/test/cli-wrap.test.js harness/test/cli-plan-status.test.js harness/test/cli-label.test.js` passes; `node harness/cli.js --help` lists `wrap`

### Wave 2 — sequential

#### Task 2.1: The wrap and kickoff skills
File: .rad/skills/wrap/SKILL.md:1-1, .claude/skills/wrap/SKILL.md:1-153, .agents/skills/wrap/SKILL.md:1-1, .agents/skills/wrap/agents/openai.yaml:1-1, .rad/skills/kickoff/SKILL.md:1-1, .claude/skills/kickoff/SKILL.md:1-123, .agents/skills/kickoff/SKILL.md:1-1
What: Write AC#3, AC#4 and AC#5. Move each body into its shared source with only the listed changes, `git rm` the old unmarked files, and run `node harness/cli.js generate`.
Validate: AC#3, AC#4, AC#5 — `node harness/cli.js generate --check` exits 0; `grep -c 'git add\|git commit\|git push\|rad-label.sh\|Status: review' .agents/skills/wrap/SKILL.md` prints 0

### Wave 3 — sequential

#### Task 3.1: Registries and docs
File: harness/test/skill-bodies.test.js:1-130, scripts/test-install-harness.sh:530-560, docs/rad-tool-portability.md:20-30, 40-100, docs/daily-workflow.md:345-360
What: Write the AC#6 registry entries and the AC#7 portability and daily-workflow docs.
Validate: AC#6, AC#7 — `node --test harness/test/skill-bodies.test.js` passes; `bash scripts/test-install-harness.sh` passes

## Tests to Write
- [ ] rad wrap notes publish, exec log, nothing-to-publish, refusals, push failure; publishPlanChange without a label — harness/test/cli-wrap.test.js
- [ ] wrap and kickoff in the tool-neutral registry; .claude/skills path helper; wrap openai.yaml — harness/test/skill-bodies.test.js
- [ ] install slice includes wrap and kickoff — scripts/test-install-harness.sh

## Non-Goals
- rad-insights (4-ii).
- Changing plan statuses, the label set, or `rad deliver`.
- Automatically running `rad wrap` from anywhere.

## Out-of-Scope Dependencies
None

## Risks
- **Removing wrap's status step changes a habit.** Plan status already comes from `rad deliver` and `rad plan-status`, so nothing is lost, and the board reads the same tips.
- **`publishPlanChange` gains an optional field.** Existing callers all pass `labelStatus`, and the blank-string `TypeError` keeps programmer errors loud.
- **Self-protected paths** (`harness/`, `scripts/`, `.rad/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — `rad wrap` needs no role check.** Session notes aren't an approval or a review.
- **Assumption — wrap is explicit-only on Codex** (it commits and pushes). kickoff allows implicit invocation (it's read-only).
- **Assumption — `rad wrap` publishes the execution log when present,** using the shared exact-name helper.
