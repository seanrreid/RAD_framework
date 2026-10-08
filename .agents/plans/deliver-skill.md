# Plan: One Shared rad-deliver Skill That Runs rad deliver (#186 part 3d-i)
Created: 2026-10-08
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-08T14:25:08.342Z
Recorded-By: sean@torchcodelab.com
Branch: rad/deliver-skill
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
`/team:rad-deliver` is a hand-written, 373-line prose command (`.claude/commands/team/rad-deliver.md`) that orchestrates wave sub-agents. Option C on #186 says both Claude and Codex deliver only by running `rad deliver`. Parts 3a-3c gave `rad deliver` everything the prose did:
- agent selection;
- the prepare phase;
- the scoped test gate and the end-of-run test wave;
- the finish commits;
- a deterministic PR body.

This part replaces the prose with one tool-neutral skill source, generated for both tools, as 2c/2d did for plan, adopt and approve.

Decisions the user made on 2026-10-08:
- **Q1:** this repo sets `agent: claude` (`command`, `claude -p`), so its own deliveries go through `rad deliver` from now on.
- **Q2:** when `rad deliver` exits 3 (needs-decision), the skill shows the decision and the exact resume command, stops and asks the user, and resumes only with the user's answer as `--context`.

Earlier decisions: `codex_implicit: false`; the Codex hook-layer bypass is recorded in `docs/invariants.yaml`; the portability row is flipped; the `codex exec` preset is smoke-tested.

3d is split. **3d-i (this plan)** covers the skill, config, invariant, portability row and smoke tests. **3d-ii** sweeps the docs and code comments that still describe the prose steps.

## Scope
| In scope | Out of scope |
|---|---|
| `.rad/skills/rad-deliver/SKILL.md` and its generated Claude command and Codex skill | The docs sweep (daily-workflow, wave-execution, how-it-works, README, AGENTS.md, onboarding, configuration, INSTALL, UPGRADE, hooks README), which is 3d-ii |
| `agent:` in this repo's `.rad/config.yml` | Stale "Step N" comments in harness code (3d-ii) |
| skill-bodies and install-harness tests | Changing `rad deliver` itself |
| invariants.yaml: the Codex bypass, plus rewording the stale skill-path bypasses | The research, epic, design and review skills (3e/3f) |
| rad-tool-portability.md: the deliver row and gate parity | |
| Live smoke runs of `claude -p` and `codex exec` through the existing live evals, recorded in rad-cli.md | |

## Acceptance Criteria
1. **The skill source.** `.rad/skills/rad-deliver/SKILL.md` has frontmatter `name: rad-deliver`, a one-paragraph `description`, and `targets: { claude: command:team/rad-deliver, codex: skill, codex_implicit: false }`. The body is tool-neutral and passes every `FORBIDDEN_PATTERNS` rule in skill-bodies.test.js: no `$ARGUMENTS`, no `Explore`, no `git add/commit/push/checkout`, no `checkout-plan.sh` and no `rad-label.sh`. Its input is `{{args}}`: a feature slug or `.agents/plans/<slug>.md` as the first token, which the deliver-gate hook parses.

   The body tells the agent to:
   - **(a) Resolve the feature slug** from the input. If there's no input, list approved plans with `node harness/cli.js plan-status` and ask which one.
   - **(b) Run** `node harness/cli.js deliver <feature>`. Say it can take a long time and should run in the background where the tool supports that, without polling in a tight loop.
   - **(c) Act on the exit code:**

     | Exit | What the agent does |
     |---|---|
     | 0 | Report the summary line and the PR link from the output |
     | 1 | Report the failure line (`class`/`decision`/`detail`) and stop; **no automatic retry** |
     | 2 | Explain the usage or config problem and its fix (for example, no `agent:` configured: set it in `.rad/config.yml` or run `rad config init --agent claude\|codex`) |
     | 3 | Show the decision text, then the exact command `node harness/cli.js deliver <feature> --resume --context "<your answer>"`. **Stop and ask the user.** Only after they answer, run it with their answer as the context |

   - **(d) Never** approve a plan, edit the plan or event log by hand, or skip a gate to make the run pass.
   - **(e)** Note that after exit 0 the user reviews the PR (and can run `/team:rad-review`).
2. **Generated outputs.** `node harness/cli.js generate` writes:
   - `.claude/commands/team/rad-deliver.md` (replacing the prose file, with the generated marker and `$ARGUMENTS`);
   - `.agents/skills/rad-deliver/SKILL.md`;
   - `.agents/skills/rad-deliver/agents/openai.yaml` with `allow_implicit_invocation: false`.
   `node harness/cli.js generate --check` exits 0.
3. **The deliver-gate hook still blocks.** The Claude command is still `team:rad-deliver` with the slug or plan path as the first argument, so `scripts/deliver-gate-hook.mjs` keeps blocking an unapproved Skill call. `harness/test/deliver-gate-hook.test.js` and `harness/evals/approval.eval.js` pass unchanged.
4. **This repo's agent.** `.rad/config.yml` gains a top-level `agent:` block (`adapter: command`, `command: claude -p`), hand-edited in place after `default_branch` (not regenerated with `config init`). `node harness/cli.js config validate` passes, and `node harness/cli.js config get agent` prints it.
5. **Tests.**
   - `harness/test/skill-bodies.test.js`: `rad-deliver` is in `TOOL_NEUTRAL_SKILLS`; `REQUIRED_COMMANDS['rad-deliver']` is `['node harness/cli.js deliver']`; there's an openai.yaml check that mirrors rad-approve's; and the body has the exit-3 contract (it contains `--resume --context` and an explicit stop-and-ask instruction).
   - `scripts/test-install-harness.sh`: `SLICE_SKILLS` includes rad-deliver, with an openai.yaml assertion like rad-approve's.
   - All harness tests, evals and `scripts/test-*.sh` pass.
6. **Invariants.** In `docs/invariants.yaml`:
   - **`unapproved-deliver-cannot-run`** gains a bypass `codex-no-skill-hook`. Its surface is the Codex `$rad-deliver` skill, with `guarded: "yes"` and a note: "Codex has no skill-level PreToolUse hook; the skill only runs `rad deliver`, whose harness gate refuses an unapproved plan; `codex_implicit: false` keeps it user-invoked". It also gains an `enforced_by` anchor on `.rad/skills/rad-deliver/SKILL.md` with symbol `node harness/cli.js deliver`.
   - **The stale bypasses** `skill-deliver-path` (under `deliver-runs-isolated`) and `skill-path` (under `capabilities-enforced-or-refused`) are reworded, because the skill now runs `rad deliver`. They are removed only if the guarded/unguarded facts no longer hold, and the PR says which.
   - `scripts/lint-invariants.sh` passes.
7. **Portability.** In `docs/rad-tool-portability.md`:
   - the rad-deliver matrix row reads `generated (#186 part 3d)`, body `generated`, deps `rad CLI, $ARGUMENTS`, with `codex_implicit: false`;
   - the roadmap row and the "Gate parity" section say the gate is the harness gate for both tools, with the Claude hook as an extra layer, and point to the invariants.yaml bypass.
8. **Smoke tests.** The live delivery evals run once with each preset, with no other changes:
   ```
   RAD_EVAL_LIVE_CMD="claude -p" node --test harness/evals/*.eval.js
   RAD_EVAL_LIVE_CMD="codex exec" node --test harness/evals/*.eval.js
   ```
   Each result (date, exit, live cases passed or failed, and a one-line failure reason if any) is recorded in docs/rad-cli.md's verified-agents table as a deliver row per preset. A failing live case is recorded **as a finding, not hidden**. The plan can still complete with a recorded failure, which gets its own follow-up issue.

## Agent Scope
Research came from a read-only sub-agent survey of the generator and the 2c/2d migrations, the prose command and the deliver-gate hook, invariants.yaml and its linter, the portability matrix, the agent presets and preflight, the config `agent:` shape, and the docs that reference the prose steps. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| .rad/skills/rad-deliver/SKILL.md | 1-1 | New: the shared skill source |
| .rad/skills/rad-approve/SKILL.md | 1-40 | Read only: the frontmatter and style model |
| .claude/commands/team/rad-deliver.md | 1-373 | Replaced by the generated command |
| .agents/skills/rad-deliver/SKILL.md | 1-1 | New (generated) |
| .agents/skills/rad-deliver/agents/openai.yaml | 1-1 | New (generated) |
| harness/generate.js | 40-60 | Read only: targets and tokens |
| .rad/config.yml | 1-15 | `agent:` block |
| harness/config.js | 20-45 | Read only: presets and the `agent` shape |
| scripts/deliver-gate-hook.mjs | 80-120 | Read only: skill-name and slug parsing |
| harness/test/skill-bodies.test.js | 1-90 | rad-deliver entries and the exit-3 contract check |
| scripts/test-install-harness.sh | 530-550 | `SLICE_SKILLS` and the openai.yaml assert |
| docs/invariants.yaml | 1-40 | `codex-no-skill-hook` bypass and anchor |
| docs/invariants.yaml | 140-155 | Reword `skill-deliver-path` |
| docs/invariants.yaml | 230-245 | Reword `skill-path` |
| docs/rad-tool-portability.md | 20-30 | Roadmap row |
| docs/rad-tool-portability.md | 45-60 | Matrix row |
| docs/rad-tool-portability.md | 180-205 | Gate parity |
| docs/rad-cli.md | 545-565 | Verified-agents table: deliver smoke results |

## Execution Notes

### Do Not Touch
- harness/cli.js, harness/spine.js: `rad deliver` is unchanged
- scripts/deliver-gate-hook.mjs, .claude/settings.json: the hook already matches `rad-deliver`
- Other generated wrappers: edit sources only and regenerate
- The 3d-ii docs listed under Scope

### Key Files
- .rad/skills/rad-approve/SKILL.md: the closest model (`targets`, `{{args}}`, tool-neutral body)
- harness/test/skill-bodies.test.js: `TOOL_NEUTRAL_SKILLS` (15), `FORBIDDEN_PATTERNS` (19-23), `REQUIRED_COMMANDS` (31-39), the openai.yaml check (76-80)
- harness/cli.js: deliver usage (78), exit codes (249-254), `reportStop` output shape (1447-1462); read only
- docs/invariants.yaml: `unapproved-deliver-cannot-run` (6-36); the schema in harness/invariants.js:34-65

### Reminders
- **Edit sources, then run `node harness/cli.js generate`.** Never hand-edit the generated files. `generate --check` must pass.
- **The exit-3 contract is the user's decision:** stop and ask, never resume on the agent's own judgment.
- **Fail closed in prose too.** The body never tells the agent to work around a failing gate.
- **The smoke runs cost real agent time.** Run each once and record the result faithfully, including a failure.

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The skill source, generation and tests
File: .rad/skills/rad-deliver/SKILL.md:1-1, .claude/commands/team/rad-deliver.md:1-373, .agents/skills/rad-deliver/SKILL.md:1-1, .agents/skills/rad-deliver/agents/openai.yaml:1-1, harness/test/skill-bodies.test.js:1-90, scripts/test-install-harness.sh:530-550
What: Write the AC#1 source, run `node harness/cli.js generate` (AC#2), and add the AC#5 test entries.
Validate: AC#1, AC#2, AC#3, AC#5 — `node harness/cli.js generate --check` exits 0; `node --test harness/test/skill-bodies.test.js harness/test/deliver-gate-hook.test.js` passes; `bash scripts/test-install-harness.sh` passes

#### Task 1.2: This repo's agent, invariants and portability
File: .rad/config.yml:1-15, docs/invariants.yaml:1-40, 140-155, 230-245, docs/rad-tool-portability.md:20-30, 45-60, 180-205
What: Write AC#4, AC#6 and AC#7.
Validate: AC#4, AC#6, AC#7 — `node harness/cli.js config validate` passes and `config get agent` prints the block; `bash scripts/lint-invariants.sh` passes; `node --test harness/test/*.test.js`, `node --test harness/evals/*.eval.js` and every `scripts/test-*.sh` pass (report the counts)

### Wave 2 — sequential

#### Task 2.1: Live smoke runs
File: docs/rad-cli.md:545-565
What: Run both AC#8 commands (each once, in the background if it's long) and record the results in the verified-agents table.
Validate: AC#8 — both runs completed, and their results (pass or a recorded failure) appear in docs/rad-cli.md

## Tests to Write
- [ ] rad-deliver tool-neutral body, required command, exit-3 contract, openai.yaml — harness/test/skill-bodies.test.js
- [ ] install slice includes rad-deliver — scripts/test-install-harness.sh

## Non-Goals
- The 3d-ii docs and comment sweep.
- Changing `rad deliver`'s behavior or output (for example, printing a ready-made resume command).
- A standalone `rad agent-check` command.
- Migrating other skills (3e/3f).

## Out-of-Scope Dependencies
None

## Risks
- **The prose deliver path disappears.** After merge, `/team:rad-deliver` needs a configured agent. This repo gets `claude`; installed projects without `agent:` get exit 2 with the fix spelled out. That is the intended option C trade-off.
- **Delivery of this plan itself:** this plan is delivered with the **current** prose skill, since the new skill only exists on this branch. 3d-ii will be the first plan delivered by `rad deliver`.
- **The live smoke runs can fail for reasons outside RAD** (auth, network, model behavior). They are recorded as findings, not treated as a plan failure.
- **Docs read as stale until 3d-ii merges.** 3d-ii follows directly.
- **Self-protected paths** (`.rad/`, `scripts/`, `harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — the skill reads approved plans with `rad plan-status`** when no input is given. The prose used `scripts/rad-status.sh`, but scripts are tool-specific to call and `rad plan-status` exists (2b).
- **Assumption — the skill builds the resume command itself,** because `reportStop` doesn't print one. Changing `rad deliver` output is a non-goal.
- **Assumption — the smoke test reuses the live evals (`RAD_EVAL_LIVE_CMD`)** rather than a new harness, so the run is reproducible and already wired.
- **Assumption — `agent:` is hand-edited into `.rad/config.yml`.** `rad config init --force` would rewrite the whole file.
