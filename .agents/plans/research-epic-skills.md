# Plan: Shared rad-research and rad-epic-decompose Skills, and rad label (#186 part 3e)
Created: 2026-10-08
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-08T17:33:51.500Z
Recorded-By: sean@torchcodelab.com
Branch: rad/research-epic-skills
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
`/team:rad-research` (291 lines) and `/architect:rad-epic-decompose` (210 lines) are hand-written Claude commands. Both are artifact-only: they write a file and never commit. Part 3e moves each to one tool-neutral `.rad/skills` source generated for Claude and Codex, as 2c did for plan and adopt.

The Claude-only parts:
- **rad-research:** `$ARGUMENTS`, and a sub-agent pinned to a Haiku model ID for fetching URLs.
- **rad-epic-decompose:** `$ARGUMENTS`, and Step 6's optional `scripts/rad-label.sh [N] draft`. Tool-neutral bodies may not call `rad-label.sh` (`FORBIDDEN_PATTERNS` in skill-bodies.test.js), because raw state-changing commands go through the `rad` CLI.

On 2026-10-08 the user decided (3e Q1) to **keep** the optional label step and route it through a new `rad label <issue> <status>` CLI command, rather than drop it.

## Scope
| In scope | Out of scope |
|---|---|
| `rad label <issue> <status>`: a CLI wrapper over `scripts/rad-label.sh` | Changing `scripts/rad-label.sh` |
| `.rad/skills/rad-research/SKILL.md` and its generated outputs | rad-design (3f), insights and wrap (4) |
| `.rad/skills/rad-epic-decompose/SKILL.md` and its generated outputs | Changing what either skill writes into its artifact |
| skill-bodies and install-harness tests, portability rows, docs | |

## Acceptance Criteria
1. **The `rad label` command.** `rad label <issue> <status>` is a new harness/label.js command module, modeled on harness/checkout.js.
   - **Arguments:** `<issue>` must be a positive integer (it accepts `#N`). `<status>` must be one of rad-label.sh's statuses: draft, ready, pending-review, needs-revision, rejected, approved, in-progress, review, done.
   - **What it runs:** `scripts/rad-label.sh <N> <status>` through the injected `sh`, with cwd set to the repo root. It prints the script's output and exits with its status, 0 or 1.
   - **Bad input:** a bad number, an unknown status, or a wrong argument count prints `rad label: <reason>` plus the usage line and exits 2.
   - **Registration:** it's in `SUBCOMMANDS` with `LABEL_USAGE = 'rad label <issue> <status>'`, so `rad --help` lists it.
   - Tests in the new harness/test/cli-label.test.js cover: a valid call with exact script args; `#N` accepted; a bad number, an unknown status and a missing argument each exiting 2 with no script call; and the script's non-zero exit passed through.
2. **The rad-research skill.** `.rad/skills/rad-research/SKILL.md` has frontmatter `name: rad-research`, the existing description, and `targets: { claude: command:team/rad-research, codex: skill }`, so implicit invocation stays allowed (it's read-only plus one artifact). Its body:
   - keeps every step, the artifact format and the rules of the current command;
   - takes `{{args}}` for input;
   - replaces the pinned-model sub-agent with "if your tool can run a sub-agent, delegate the URL fetch with this prompt; otherwise fetch it inline and keep only the bounded `SPEC_SUMMARY`", the same phrasing as rad-plan's Step 2;
   - passes `FORBIDDEN_PATTERNS`.
3. **The rad-epic-decompose skill.** `.rad/skills/rad-epic-decompose/SKILL.md` has frontmatter `name: rad-epic-decompose`, the existing description, and `targets: { claude: command:architect/rad-epic-decompose, codex: skill, codex_implicit: false }` (it's architect-only). Its body:
   - keeps every step, the artifact format and the rules;
   - takes `{{args}}` for input;
   - keeps `scripts/check-role.sh architect` and `scripts/fetch-epic.sh`, which are read-only;
   - turns Step 6 into: only when `RAD_UPDATE_ISSUES=true`, run `node harness/cli.js label <N> draft` for the epic (and each child if wanted). It's best-effort: report a non-zero exit and continue, and never fail the command. The default stays off.
4. **Generated outputs.** `node harness/cli.js generate` replaces `.claude/commands/team/rad-research.md` and `.claude/commands/architect/rad-epic-decompose.md` with marked, generated files. It writes `.agents/skills/rad-research/SKILL.md`, `.agents/skills/rad-epic-decompose/SKILL.md` and `.agents/skills/rad-epic-decompose/agents/openai.yaml` (`allow_implicit_invocation: false`). `generate --check` exits 0.
5. **Tests and registry.**
   - harness/test/skill-bodies.test.js: both names go in `TOOL_NEUTRAL_SKILLS`.
   - `REQUIRED_COMMANDS`: rad-epic-decompose gets `['scripts/fetch-epic.sh', 'node harness/cli.js label']`; rad-research gets the artifact path `.agents/research/` (or the closest required marker that fits the guard test).
   - rad-epic-decompose is added to the openai.yaml check list.
   - scripts/test-install-harness.sh: `SLICE_SKILLS` gains both, plus an openai.yaml assert for rad-epic-decompose.
6. **Docs.**
   - docs/rad-tool-portability.md: the rad-research and rad-epic-decompose rows read `generated (#186 part 3e)`, with Deps updated (`rad CLI` for epic) and the closing note at ~94-95 refreshed.
   - docs/epic-decomposition.md (~80): Step 6 uses `rad label`.
   - docs/rad-cli.md: a new `### rad label` section covering usage, statuses, exit codes and that it wraps rad-label.sh.

## Agent Scope
Research came from targeted reads of both commands' headings and tool-specific lines, the skill-bodies forbidden and required lists, rad-label.sh's status list, `RAD_UPDATE_ISSUES` usage (epic only), the 2c rad-plan sub-agent phrasing, and the checkout.js command model. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/label.js | 1-1 | New: `labelCommand`, `LABEL_USAGE` |
| harness/checkout.js | 1-116 | Read only: the command-module model |
| harness/cli.js | 66-110 | Import and `LABEL_USAGE` |
| harness/cli.js | 205-225 | `SUBCOMMANDS`: `label` entry |
| scripts/rad-label.sh | 1-60 | Read only: statuses and exit behavior |
| harness/test/cli-label.test.js | 1-1 | New (AC#1) |
| harness/test/cli-checkout.test.js | 1-60 | Read only: test model |
| .rad/skills/rad-plan/SKILL.md | 80-150 | Read only: the sub-agent phrasing |
| .rad/skills/rad-research/SKILL.md | 1-1 | New source |
| .claude/commands/team/rad-research.md | 1-291 | Replaced by the generated output |
| .agents/skills/rad-research/SKILL.md | 1-1 | New (generated) |
| .rad/skills/rad-epic-decompose/SKILL.md | 1-1 | New source |
| .claude/commands/architect/rad-epic-decompose.md | 1-210 | Replaced by the generated output |
| .agents/skills/rad-epic-decompose/SKILL.md | 1-1 | New (generated) |
| .agents/skills/rad-epic-decompose/agents/openai.yaml | 1-1 | New (generated) |
| harness/test/skill-bodies.test.js | 1-100 | Registry entries |
| scripts/test-install-harness.sh | 530-560 | `SLICE_SKILLS` and openai.yaml assert |
| docs/rad-tool-portability.md | 45-100 | Rows and note |
| docs/epic-decomposition.md | 75-90 | Step 6 via `rad label` |
| docs/rad-cli.md | 1-1 | New `### rad label` section (append near the plan-status/checkout sections) |

## Execution Notes

### Do Not Touch
- scripts/rad-label.sh, scripts/check-role.sh, scripts/fetch-epic.sh
- Other skills' sources and generated wrappers (regenerate only; `generate` must report the others unchanged)
- harness/spine.js and the deliver path

### Key Files
- harness/checkout.js and harness/test/cli-checkout.test.js: the command-module and test model
- harness/cli.js: the usage constants (76-106), `SUBCOMMANDS` (108+), the `plan-status`/`checkout` entries (211-220)
- .rad/skills/rad-plan/SKILL.md Step 2 (~85-95): the tool-neutral sub-agent phrasing to reuse
- harness/test/skill-bodies.test.js: `TOOL_NEUTRAL_SKILLS`, `FORBIDDEN_PATTERNS`, `REQUIRED_COMMANDS`, the openai.yaml check

### Reminders
- **Waves run under a 10-minute agent limit.** Validate with only the targeted commands named in each task.
- **Edit sources, then run `node harness/cli.js generate`.** Never hand-edit generated files.
- **Keep the skills' behavior.** Change only what's tool-specific; the steps, artifact formats and rules stay.
- **Helpers stay under ~40 lines, with named constants** (the status list, the usage line).

## Program Design
```js
// harness/label.js
export const LABEL_USAGE = 'rad label <issue> <status>';
export const LABEL_STATUSES = ['draft', 'ready', 'pending-review', 'needs-revision', 'rejected', 'approved', 'in-progress', 'review', 'done'];
export async function labelCommand(argv, ctx)   // → exit code (0 | 1 from the script | 2 usage)
```
```
rad label 42 draft → parse (#N ok) → validate status → sh(scripts/rad-label.sh, ['42','draft'], {cwd: repoRoot}) → print → exit status
skill (Step 6, RAD_UPDATE_ISSUES=true) → node harness/cli.js label <N> draft → non-zero: report and continue
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The rad label command
File: harness/label.js:1-1, harness/cli.js:66-110, 205-225, harness/test/cli-label.test.js:1-1, docs/rad-cli.md:1-1
What: Write AC#1, its tests, and the `### rad label` section in docs/rad-cli.md.
Validate: AC#1 — `node --test harness/test/cli-label.test.js` passes; `node harness/cli.js --help` lists `label`

### Wave 2 — sequential

#### Task 2.1: The rad-research skill
File: .rad/skills/rad-research/SKILL.md:1-1, .claude/commands/team/rad-research.md:1-291, .agents/skills/rad-research/SKILL.md:1-1
What: Write AC#2: move the current command's body into the shared source with only the tool-specific edits. Run `node harness/cli.js generate`.
Validate: AC#2, AC#4 — `node harness/cli.js generate --check` exits 0; `grep -c '\$ARGUMENTS' .agents/skills/rad-research/SKILL.md` prints 0

### Wave 3 — sequential

#### Task 3.1: The rad-epic-decompose skill
File: .rad/skills/rad-epic-decompose/SKILL.md:1-1, .claude/commands/architect/rad-epic-decompose.md:1-210, .agents/skills/rad-epic-decompose/SKILL.md:1-1, .agents/skills/rad-epic-decompose/agents/openai.yaml:1-1, docs/epic-decomposition.md:75-90
What: Write AC#3, run `node harness/cli.js generate`, and update docs/epic-decomposition.md Step 6.
Validate: AC#3, AC#4 — `node harness/cli.js generate --check` exits 0; `grep -n 'rad-label.sh' .agents/skills/rad-epic-decompose/SKILL.md` returns nothing

### Wave 4 — sequential

#### Task 4.1: Registry tests and portability
File: harness/test/skill-bodies.test.js:1-100, scripts/test-install-harness.sh:530-560, docs/rad-tool-portability.md:45-100
What: Write AC#5 and the AC#6 portability rows.
Validate: AC#5, AC#6 — `node --test harness/test/skill-bodies.test.js` passes; `bash scripts/test-install-harness.sh` passes

## Tests to Write
- [ ] rad label valid, #N, bad number, unknown status, missing arg, passthrough — harness/test/cli-label.test.js
- [ ] research and epic in the tool-neutral registry; epic openai.yaml — harness/test/skill-bodies.test.js
- [ ] install slice includes both skills — scripts/test-install-harness.sh

## Non-Goals
- Changing rad-label.sh or the label statuses.
- Turning the epic label step on by default.
- rad-design (3f), and insights and wrap (4).

## Out-of-Scope Dependencies
None

## Risks
- **The 291- and 210-line bodies must move with no semantic change.** Mitigation: tasks change only tool-specific lines, and the generated Claude command can be diffed against the old one in review.
- **`rad label` is new CLI surface** that changes GitHub state. It only wraps the existing script, which is already used by plan-open, approve and deliver.
- **Self-protected paths** (`harness/`, `scripts/`, `.rad/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — rad-research allows implicit invocation on Codex** (it's read-only plus one artifact). rad-epic-decompose is architect-only, so `codex_implicit: false`.
- **Assumption — `rad label` runs no role check,** matching rad-label.sh, which plan-open, approve and deliver already call without one. The skill's own `check-role.sh architect` gate still applies.
- **Assumption — rad-research's required marker** in `REQUIRED_COMMANDS` is the artifact path, since it calls no `rad` command.
