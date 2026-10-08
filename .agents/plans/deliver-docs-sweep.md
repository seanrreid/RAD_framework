# Plan: Docs Sweep for rad deliver as the Only Deliver Path (#186 part 3d-ii)
Created: 2026-10-08
Author: architect
Status: complete
Completed-At: 2026-10-08T16:29:17.965Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-08T14:52:26.263Z
Recorded-By: sean@torchcodelab.com
Branch: rad/deliver-docs-sweep
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
3d-i (PR #209) replaced the prose `/team:rad-deliver` command with one shared skill that just runs `rad deliver`. Many docs and some code comments still describe the old prose flow:
- a sub-agent per wave started by the calling agent;
- retries twice, then escalates;
- pauses between waves;
- resumes from the execution log;
- "Step 2" / "Step 6" of `rad-deliver.md`;
- rebases on the default branch.

This plan makes them describe what actually happens now. It's also the first plan delivered end to end through `rad deliver` (agent `claude -p`).

## Facts to write
Every edit in this plan states these facts and nothing that contradicts them. `docs/rad-cli.md` `### rad deliver` is the detailed reference; other docs summarize and link to it rather than repeat it.

1. **Both skills run the command.** `/team:rad-deliver` (Claude) and `$rad-deliver` (Codex) are generated from `.rad/skills/rad-deliver/SKILL.md` and run `node harness/cli.js deliver <feature>`.
2. **`rad deliver` gates first.** It refuses unless an `approved` event is in the plan's event log at the `rad/<feature>` branch tip. The Claude deliver-gate hook is an extra layer on top of that.
3. **The prepare phase** fetches, fast-forwards, **merges** the default branch (never rebases or force-pushes), marks the plan in progress, and needs a reachable `origin`.
4. **Each wave runs as one call to the configured agent** (`agent:` in `.rad/config.yml`, e.g. `claude -p` or `codex exec`), in an isolated git worktree by default. Retries, the outcome rules, the token budget, hooks and the doom-loop breaker live in the harness (`harness/spine.js`, `harness/matrix.yaml`). They aren't prose in the calling agent.
5. **The per-wave test gate** checks only the test files promised by the waves completed so far. Unpromised Tests-to-Write files get one end-of-run test wave, then a final check (stop `tests-missing`).
6. **The finish phase** marks the plan `complete` with `Completed-At:`, commits and pushes, labels `review`, opens the PR (an existing open PR counts as success) with a generated title and body, and records `pr-opened`.
7. **Exit codes:**

   | Exit | Meaning |
   |---|---|
   | 0 | Delivered |
   | 1 | Failed |
   | 2 | Usage or config problem (e.g. no `agent:`) |
   | 3 | Needs a decision |

   The skill reports exit 3 and **stops for the user**, then resumes only with `--resume --context "<answer>"`. A delivered feature rerun only pushes and labels (`already delivered`).
8. **The event log (`.agents/state/<feature>/events.jsonl`) is the record of a run.** Wave agents may still append to an execution log under `.agents/logs/`, but it's optional, and nothing gates on it.

## Scope
| In scope | Out of scope |
|---|---|
| User-facing docs that describe delivery | `docs/rad-cli.md` (already current; it's the reference) |
| Stale prose-step references in harness code comments and one eval comment | Any behavior change in code |
| The portability matrix Body legend (`generated`) | Historical plans under `plans/` and `.agents/plans/` |
| | Other skills (3e/3f) |

## Acceptance Criteria
1. **Workflow docs.** `docs/daily-workflow.md` and `docs/wave-execution.md` describe delivery per the Facts.
   - No "sub-agent per wave", "retries twice", "pauses between waves", "resume from the execution log" or rebase claims remain in them.
   - Retries and stops are described as harness behavior, with a link to rad-cli.md.
2. **Overview docs.** `docs/how-it-works.md`, `README.md` and `AGENTS.md` match the Facts, including README's comparison/feature rows (~101-108) and the AGENTS.md workflow block (~117-124).
   - `bash scripts/lint-claude-md.sh` still passes, because AGENTS.md has a line budget.
3. **Setup docs.** `docs/onboarding.md`, `docs/configuration.md`, `INSTALL.md`, `UPGRADE.md` and `scripts/hooks/README.md` match the Facts. Each one that covers install or config says deliver needs `agent:` (`rad config init --agent claude|codex` or `install.sh --agent`). `UPGRADE.md` gets a short note: the prose deliver command is gone, so set `agent:` before running `/team:rad-deliver`.
4. **Design docs.**
   - `docs/harness-and-framework.md` and `docs/behavior-map-deliver-gate.md` stop citing `rad-deliver.md` steps and line numbers, and point to the generated skill and `harness/cli.js` / `scripts/check-plan-approved.sh` instead.
   - `docs/rad-tool-portability.md`'s matrix legend defines Body `generated` (one tool-neutral source generated for both tools), or the rad-deliver row uses the legend's existing term. Choose whichever is truthful and say which in the commit message.
5. **Code comments.** These comments no longer cite prose steps:
   - `harness/adapters/agent/contract.js` (~149, ~309);
   - `harness/spine.js` (~4-5);
   - `harness/adapters/git-state-store.js` (~345);
   - `scripts/check-plan-approved.sh` (~14);
   - `harness/evals/approval.eval.js` (~349).

   They describe the current owner, for example "`rad deliver`'s gate" or "the WAVE_RESULT contract defined here". **Comments only**: no code token changes.
6. **Checks.**
   - `grep -rn "rad-deliver.md" harness scripts docs README.md AGENTS.md INSTALL.md UPGRADE.md` finds nothing except historical changelog-style mentions, and each one left is listed in the commit message.
   - `node --test harness/test/*.test.js`, `node --test harness/evals/*.eval.js` and every `scripts/test-*.sh` pass.
   - `node harness/cli.js generate --check` and `bash scripts/lint-invariants.sh` pass.

## Agent Scope
Research came from a targeted grep sweep for prose-deliver references (sub-agent, retries, execution log, rad-deliver.md steps) across docs and code comments, plus the 3d-i research survey. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| docs/daily-workflow.md | 1-20 | Delivery summary |
| docs/daily-workflow.md | 95-115 | Delivery summary |
| docs/daily-workflow.md | 190-325 | Delivery section, resume, review |
| docs/wave-execution.md | 1-185 | Waves under `rad deliver` |
| docs/how-it-works.md | 20-60 | Deliver flow |
| docs/how-it-works.md | 75-115 | Deliver flow |
| docs/how-it-works.md | 130-175 | Logs and records |
| docs/how-it-works.md | 210-253 | Retries and stops |
| README.md | 25-110 | Workflow, feature and comparison rows |
| README.md | 115-125 | Deliver mention |
| README.md | 160-225 | Deliver mentions |
| AGENTS.md | 80-90 | Deliver gate wording |
| AGENTS.md | 115-128 | Workflow block |
| docs/onboarding.md | 120-180 | Deliver steps |
| docs/configuration.md | 280-290 | Deliver mention |
| docs/configuration.md | 425-475 | Deliver mentions |
| docs/configuration.md | 548-556 | Deliver mention |
| docs/configuration.md | 600-610 | Deliver mention |
| INSTALL.md | 70-95 | Logs and deliver |
| INSTALL.md | 155-165 | Deliver mention |
| INSTALL.md | 215-225 | Deliver mention |
| UPGRADE.md | 215-225 | Deliver mention |
| UPGRADE.md | 265-275 | Deliver mention, upgrade note |
| scripts/hooks/README.md | 120-135 | Deliver mention |
| docs/harness-and-framework.md | 170-180 | Prose references |
| docs/harness-and-framework.md | 230-240 | Prose references |
| docs/behavior-map-deliver-gate.md | 1-50 | Prose step citations |
| docs/behavior-map-deliver-gate.md | 115-170 | Prose step citations |
| docs/behavior-map-deliver-gate.md | 205-260 | Prose step citations |
| docs/rad-tool-portability.md | 30-65 | Body legend and rad-deliver row |
| harness/adapters/agent/contract.js | 145-152 | Comment |
| harness/adapters/agent/contract.js | 305-312 | Comment |
| harness/spine.js | 1-12 | Header comment |
| harness/adapters/git-state-store.js | 340-350 | Comment |
| scripts/check-plan-approved.sh | 10-18 | Comment |
| harness/evals/approval.eval.js | 345-352 | Comment |

## Execution Notes

### Do Not Touch
- docs/rad-cli.md: it's the reference, already current; link to it
- .rad/skills/**, .claude/commands/**, .agents/skills/**: generated or out of scope
- `plans/`, `.agents/plans/`, `.agents/logs/`: historical records
- Any code token in the files with comment edits: comments only

### Key Files
- docs/rad-cli.md `### rad deliver` (~560-700): the reference to summarize and link
- .rad/skills/rad-deliver/SKILL.md: what the skill tells an agent to do
- This plan's "Facts to write" section: the only claims to make

### Reminders
- **Summarize and link; don't duplicate rad-cli.md.** Keep each doc's own voice and length. Replace stale sentences rather than adding new sections, except the UPGRADE.md note.
- **Don't invent behavior.** If a doc describes something the Facts don't cover, check the code before writing; if unsure, remove the claim rather than guess.
- **AGENTS.md has a 150-line advisory budget** (`scripts/lint-claude-md.sh`).

## Wave Plan

### Wave 1 — parallel

#### Task 1.1: Workflow docs
File: docs/daily-workflow.md:1-20, 95-115, 190-325, docs/wave-execution.md:1-185
What: Write AC#1.
Validate: AC#1 — `grep -n -i -E "retries twice|sub-agent per wave|pauses? between waves|rebase" docs/daily-workflow.md docs/wave-execution.md` returns nothing that describes deliver; no testable surface beyond this grep (docs only)

#### Task 1.2: Overview docs
File: docs/how-it-works.md:20-60, 75-115, 130-175, 210-253, README.md:25-110, 115-125, 160-225, AGENTS.md:80-90, 115-128
What: Write AC#2.
Validate: AC#2 — `bash scripts/lint-claude-md.sh` passes; `grep -n -i -E "retries twice|wave sub-agent" docs/how-it-works.md README.md AGENTS.md` returns nothing that describes deliver (docs only)

#### Task 1.3: Setup docs
File: docs/onboarding.md:120-180, docs/configuration.md:280-290, 425-475, 548-556, 600-610, INSTALL.md:70-95, 155-165, 215-225, UPGRADE.md:215-225, 265-275, scripts/hooks/README.md:120-135
What: Write AC#3.
Validate: AC#3 — `grep -n "agent:" docs/onboarding.md INSTALL.md UPGRADE.md` matches the deliver requirement in each; no testable surface beyond this (docs only)

### Wave 2 — parallel

#### Task 2.1: Design docs and portability legend
File: docs/harness-and-framework.md:170-180, 230-240, docs/behavior-map-deliver-gate.md:1-50, 115-170, 205-260, docs/rad-tool-portability.md:30-65
What: Write AC#4.
Validate: AC#4 — `grep -n "rad-deliver.md" docs/harness-and-framework.md docs/behavior-map-deliver-gate.md` returns nothing; the legend defines every Body value the matrix uses (docs only)

#### Task 2.2: Code comments
File: harness/adapters/agent/contract.js:145-152, 305-312, harness/spine.js:1-12, harness/adapters/git-state-store.js:340-350, scripts/check-plan-approved.sh:10-18, harness/evals/approval.eval.js:345-352
What: Write AC#5, comments only.
Validate: AC#5, AC#6 — `git diff` for these files touches comment lines only; the AC#6 grep, `node --test harness/test/*.test.js`, `node --test harness/evals/*.eval.js`, every `scripts/test-*.sh`, `node harness/cli.js generate --check` and `bash scripts/lint-invariants.sh` all pass

## Tests to Write
- [ ] None: docs and comment edits only, no testable surface beyond the greps and suites in each Validate

## Non-Goals
- Changing `rad deliver`, the skill, or any code behavior.
- Rewriting docs/rad-cli.md.
- Editing historical plans or logs.

## Out-of-Scope Dependencies
None

## Risks
- **This is the first live end-to-end `rad deliver`.** A stop or failure here may be a pipeline issue, not a docs issue, and gets reported as a finding.
- **Docs drift back** if an edit invents behavior. Mitigation: the Facts list is the only source, and rad-cli.md is linked rather than copied.
- **Self-protected paths** (`harness/`, `scripts/`): comment-only edits, but this plan still needs architect review by design.

## Issue Gaps
- **Assumption — rad-cli.md is current and stays untouched.** 3a-3d each updated it.
- **Assumption — the execution log is described as optional.** `cli.js` still passes an `executionLog` path into the wave prompt, and `rad-review` reads one only if it's present.
- **Assumption — the Tests to Write line has no em-dash path,** so it parses as unresolvable and triggers no test wave.
