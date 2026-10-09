# Plan: Shared rad-insights Skill (#186 part 4-ii)
Created: 2026-10-09
Author: architect
Status: pending-review
Branch: rad/insights-skill
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
`/shared:rad-insights` (`.claude/commands/shared/rad-insights.md`, 1,155 lines) is the last hand-written RAD skill. The Claude side of `rad-review` stays hand-written by design (rad-tool-portability.md ~80-87). The skill reads `.agents/findings.jsonl` and the event logs and writes nothing, except that with `--draft-plans` it runs `scripts/draft-insights-plan.sh`, which cuts a local branch and commits a draft plan without pushing.

Its tool-specific parts:
- `$ARGUMENTS` (L14);
- one "next steps" line telling the human to run `git push -u origin <branch>` (L136), which matches skill-bodies' `FORBIDDEN_PATTERNS`.

Its awk `$1`/`$2` (L92, L228) are field references, not arguments; #186's matrix correction, recorded in 4-i, confirms this. So the body moves as-is, with `{{args}}` and one reworded line.

## Scope
| In scope | Out of scope |
|---|---|
| `.rad/skills/rad-insights/SKILL.md` generated for Claude (`command:shared/rad-insights`) and Codex | Changing what insights computes or reports |
| `$ARGUMENTS` → `{{args}}`; the push next-step reworded as a human instruction | Changing `scripts/draft-insights-plan.sh` (it still never pushes) |
| Registries, install slice, the portability row | The Claude-side `rad-review` |

## Acceptance Criteria
1. **The skill source.** `.rad/skills/rad-insights/SKILL.md` has frontmatter `name: rad-insights`, the existing description, and `targets: { claude: command:shared/rad-insights, codex: skill, codex_implicit: false }` (`--draft-plans` commits). The body is the current command's body with exactly two changes:
   - `$ARGUMENTS` becomes `{{args}}`;
   - next step 1 (~L136) becomes `Push <branch> to origin yourself when you're ready — insights never pushes.`, so it contains no `git push`.

   Everything else is byte-identical: the steps, the awk commands, the `node --input-type=module` snippets, the report format and the rules. The body passes `FORBIDDEN_PATTERNS`.
2. **Generated outputs.** `node harness/cli.js generate` replaces `.claude/commands/shared/rad-insights.md` with a marked, generated file (`git rm` the unmarked one first). It writes `.agents/skills/rad-insights/SKILL.md` and `.agents/skills/rad-insights/agents/openai.yaml` (`allow_implicit_invocation: false`). `generate --check` exits 0. The generated Claude command differs from the old file only in the marker, the `$ARGUMENTS` line and the reworded step (`git diff --stat` shows a few lines).
3. **Registries.**
   - In harness/test/skill-bodies.test.js, `rad-insights` goes in `TOOL_NEUTRAL_SKILLS` and `EXPLICIT_ONLY_SKILLS`.
   - `CLAUDE_COMMAND_ROLE['rad-insights'] = 'shared'` (or the path helper resolves the `shared` namespace).
   - `REQUIRED_COMMANDS['rad-insights'] = ['.agents/findings.jsonl', 'scripts/draft-insights-plan.sh']`.
   - scripts/test-install-harness.sh: `SLICE_SKILLS` gains rad-insights, plus an openai.yaml assert.
4. **Docs.** docs/rad-tool-portability.md:
   - the rad-insights row reads `generated (#186 part 4-ii)`, Body `as-is`, Deps `{{args}}`;
   - the roadmap row (~24) marks part 4 done;
   - the insights notes (~88-90) drop the stale "Codex override body" line.

## Agent Scope
Research came from the part 4 sub-agent survey (rad-insights' size, steps, state changes and tool-specific lines; the generate targets; the registries) and targeted reads of rad-insights.md L1-24 and L120-142. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| .rad/skills/rad-insights/SKILL.md | 1-1 | New source |
| .claude/commands/shared/rad-insights.md | 1-1155 | Replaced by the generated output |
| .agents/skills/rad-insights/SKILL.md | 1-1 | New (generated) |
| .agents/skills/rad-insights/agents/openai.yaml | 1-1 | New (generated) |
| harness/test/skill-bodies.test.js | 1-70 | Registry entries |
| scripts/test-install-harness.sh | 530-560 | `SLICE_SKILLS` and openai.yaml assert |
| docs/rad-tool-portability.md | 20-30 | Roadmap row |
| docs/rad-tool-portability.md | 50-95 | Row and notes |

## Execution Notes

### Do Not Touch
- scripts/draft-insights-plan.sh
- harness/findings.js, harness/events.js, harness/plan-tasks.js
- Other skills' sources (regenerate only; others must report unchanged)

### Key Files
- .claude/commands/shared/rad-insights.md: L14 (`$ARGUMENTS`) and L136 (the push next step) are the only lines that change
- .rad/skills/rad-research/SKILL.md: a tool-neutral source model (frontmatter, `{{args}}`)

### Reminders
- **Waves run under the 10-minute agent limit.** Build the source by copying the file and applying the two edits; don't retype 1,155 lines.
- **Edit the source, `git rm` the unmarked command, then run `node harness/cli.js generate`.**
- **No other content changes.** The generated command's diff against the old file must stay a few lines.

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The rad-insights skill
File: .rad/skills/rad-insights/SKILL.md:1-1, .claude/commands/shared/rad-insights.md:1-1155, .agents/skills/rad-insights/SKILL.md:1-1, .agents/skills/rad-insights/agents/openai.yaml:1-1
What: Write AC#1 and AC#2. Copy the command body into the source with frontmatter, apply the two edits, `git rm` the old command, and run `node harness/cli.js generate`.
Validate: AC#1, AC#2 — `node harness/cli.js generate --check` exits 0; `grep -c 'git push\|\$ARGUMENTS' .agents/skills/rad-insights/SKILL.md` prints 0; `git diff --stat HEAD -- .claude/commands/shared/rad-insights.md` shows fewer than 10 changed lines

### Wave 2 — sequential

#### Task 2.1: Registries and portability
File: harness/test/skill-bodies.test.js:1-70, scripts/test-install-harness.sh:530-560, docs/rad-tool-portability.md:20-30, 50-95
What: Write AC#3 and AC#4.
Validate: AC#3, AC#4 — `node --test harness/test/skill-bodies.test.js` passes; `bash scripts/test-install-harness.sh` passes

## Tests to Write
- [ ] rad-insights in the tool-neutral, explicit-only and shared-namespace registries, with its required markers — harness/test/skill-bodies.test.js
- [ ] install slice includes rad-insights and its openai.yaml — scripts/test-install-harness.sh

## Non-Goals
- Changing insights' analysis, report or `--draft-plans` behavior.
- Making `--draft-plans` push.
- Migrating the Claude-side rad-review.

## Out-of-Scope Dependencies
None

## Risks
- **A 1,155-line body moves.** Mitigation: copy rather than retype, apply exactly two edits, and keep the diff check in Validate.
- **Self-protected paths** (`.rad/`, `scripts/`, `harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — `codex_implicit: false`,** because `--draft-plans` cuts a branch and commits.
- **Assumption — the push stays a human step,** reworded so no raw `git push` appears in the tool-neutral body. The draft script's no-push behavior is unchanged.
- **Assumption — `REQUIRED_COMMANDS` uses the findings path and the draft script** as markers, since insights calls no `rad` command.
