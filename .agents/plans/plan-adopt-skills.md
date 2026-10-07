# Plan: Generate /rad-plan and /rad-adopt from .rad/skills (#186 part 2c)
Created: 2026-10-07
Author: architect
Status: complete
Completed-At: 2026-10-07T15:37:32Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-07T15:27:57.019Z
Recorded-By: sean@torchcodelab.com
Branch: rad/plan-adopt-skills
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for state-changing RAD workflow

## Context
`/rad-plan` and `/rad-adopt` are hand-written Claude commands in `.claude/commands/team/`, so Codex has no version of them. Since 2a, their only state change is `node harness/cli.js plan-open`, which means a Codex version no longer needs any git prose. This plan moves both into `.rad/skills/<name>/SKILL.md`, using the same generator path as `quality-review`. That path produces the Claude command (with the generated marker) and `.agents/skills/<name>/SKILL.md` for Codex from one body. The plan makes the body tool-neutral and updates the portability table. `/rad-approve` moves separately in 2d. The user decided this split on 2026-10-07.

## Scope
| In scope | Out of scope |
|---|---|
| `.rad/skills/rad-plan/SKILL.md` and `.rad/skills/rad-adopt/SKILL.md` sources | `/rad-approve` (2d) |
| Generated `.claude/commands/team/rad-{plan,adopt}.md` and `.agents/skills/rad-{plan,adopt}/SKILL.md` | deliver, design, research, epic-decompose (part 3) |
| Tool-neutral wording for the research sub-agent step, `{{args}}`, and the command names | Generator code changes |
| A test that the shared bodies stay tool-neutral; the install test ships the new skills | Changing how plan, adopt or plan-open behave |
| Portability table rows; an UPGRADE note | A Codex-only `codex.md` override |

## Acceptance Criteria
1. `.rad/skills/rad-plan/SKILL.md` and `.rad/skills/rad-adopt/SKILL.md` exist, with `targets: { claude: command:team/rad-plan | command:team/rad-adopt, codex: skill }`, `codex_implicit` left at its default (true), and no `claude.md` or `codex.md` overrides.
2. `node harness/cli.js generate` writes `.claude/commands/team/rad-plan.md`, `.claude/commands/team/rad-adopt.md`, `.agents/skills/rad-plan/SKILL.md` and `.agents/skills/rad-adopt/SKILL.md`, each with the generated marker, and `node harness/cli.js generate --check` exits 0.
3. Apart from the frontmatter description and the marker line, the generated Claude commands keep every step, rule, exit-code instruction and plan template of today's commands. The only body changes are the tool-neutral wording edits listed in AC#4.
4. The shared bodies contain no Claude-only wording. There is no `$ARGUMENTS` (`{{args}}` is used), no "Explore sub-agent" (the research step reads: delegate it to a sub-agent if your tool can run one, otherwise run it inline, and keep only the bounded `RESEARCH_SUMMARY`), and no "Files Claude should load" (it says "the executor"). Commands are referred to by name, for example "`rad-approve`", with the Claude Code slash form given once where it helps. The bodies run no `git add|commit|push|checkout` and no `rad-label.sh`; state changes go only through `node harness/cli.js plan-open`.
5. A new test, `harness/test/skill-bodies.test.js`, enforces AC#2's markers and AC#4's tool-neutrality on the generated Codex bodies, and the existing harness suite passes.
6. `scripts/test-install-harness.sh` checks that a fresh install ships `.agents/skills/rad-plan/SKILL.md` and `.agents/skills/rad-adopt/SKILL.md`. It passes under both `bash` and `/bin/bash`.
7. The `docs/rad-tool-portability.md` rows for `rad-plan` and `rad-adopt` say `Body: as-is` and `Status: generated (#186 part 2c)`. `UPGRADE.md` notes that both commands are now generated, so local edits belong in the `.rad/skills` source.

## Agent Scope
Research was done directly in this session: harness/generate.js (the skill render path), the quality-review source and its generated pair, rad-plan.md, rad-adopt.md, the portability table, the install test's generated-slice block and the install manifest. No context-tool agents were called. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| .rad/skills/rad-plan/SKILL.md | 1-1 | New source: the current rad-plan body, made tool-neutral |
| .rad/skills/rad-adopt/SKILL.md | 1-1 | New source: the current rad-adopt body, made tool-neutral |
| .claude/commands/team/rad-plan.md | 1-450 | Read as the starting body; then overwritten by generate |
| .claude/commands/team/rad-adopt.md | 1-306 | Read as the starting body; then overwritten by generate |
| .agents/skills/rad-plan/SKILL.md | 1-1 | New: generated |
| .agents/skills/rad-adopt/SKILL.md | 1-1 | New: generated |
| .rad/skills/quality-review/SKILL.md | 1-12 | Read only: the frontmatter pattern |
| harness/test/skill-bodies.test.js | 1-1 | New: tool-neutrality and marker checks on the generated bodies |
| scripts/test-install-harness.sh | 436-455 | Add rad-plan and rad-adopt to `SLICE_SKILLS` |
| docs/rad-tool-portability.md | 30-60 | Update the rad-plan and rad-adopt rows |
| UPGRADE.md | 10-40 | A row or note: the plan and adopt commands are generated from `.rad/skills` |

## Execution Notes

### Do Not Touch
- harness/generate.js, harness/install-manifest.js — the existing generator and install paths already handle this
- .claude/commands/architect/rad-approve.md — moves in 2d
- harness/plan-open.js and the rest of `harness/` source — behavior doesn't change

### Key Files
- .rad/skills/quality-review/SKILL.md and .claude/commands/team/quality-review.md — the source-to-output pattern
- harness/generate.js `renderSkill`/`substituteTokens` (about lines 280-315) — `{{args}}` is the only token; it becomes `$ARGUMENTS` for Claude and "the text the user wrote after the skill name" for Codex
- docs/rad-tool-portability.md:30-60 — the table's Body and Status vocabulary

### Reminders
- Write the source by copying the current command body under new frontmatter (`name`, `description`, `targets`), then make only the AC#4 edits. Keep every other line, so the review diff of the generated Claude command shows only those edits.
- `{{args}}` renders to `$ARGUMENTS` for Claude, so a line like "`$ARGUMENTS` should describe…" becomes "`{{args}}` should describe…". Check the Codex phrasing reads naturally, and reword the sentence around the token if it doesn't.
- Run `node harness/cli.js generate` after editing a source, and commit the source and its generated outputs together.
- The description goes from YAML `>` folding to a single string. Keep its wording, minus Claude-only terms.

## Wave Plan

### Wave 1 — parallel
Each skill touches only its own files. Each task runs `generate`, and commits only its own source and outputs.

#### Task 1.1: rad-plan source
File: .rad/skills/rad-plan/SKILL.md:1-1, .claude/commands/team/rad-plan.md:1-450, .agents/skills/rad-plan/SKILL.md:1-1
What: Create the source with frontmatter `name: rad-plan`, `description` (today's text, with "an Explore sub-agent" changed to "a research sub-agent (or inline research)"), and `targets: { claude: command:team/rad-plan, codex: skill }`. The body is today's command body with the AC#4 edits:
- `$ARGUMENTS` becomes `{{args}}`.
- Step 2's heading becomes "Delegate research to a sub-agent". Its first paragraph says: if your tool can run a sub-agent, give it the prompt below; otherwise run the same research inline with the same caps. Either way, keep only the `RESEARCH_SUMMARY` block in your working context. Apply the same wording to the light-tier research step and to the Rules lines that mention the Explore sub-agent.
- "Files Claude should load" becomes "Files the executor should load".
- `/rad-approve`, `/rad-deliver` and similar references are written as command names, with the Claude Code slash form given once where useful.
Run `node harness/cli.js generate`. Commit only the source, the regenerated `.claude/commands/team/rad-plan.md` and the new `.agents/skills/rad-plan/SKILL.md`.
Validate: AC#1, AC#2, AC#3, AC#4 — `node harness/cli.js generate --check` exits 0; `git diff main -- .claude/commands/team/rad-plan.md` shows only the frontmatter/marker and the AC#4 edits; `grep -nE '\$ARGUMENTS|Explore|Files Claude|git (add|commit|push|checkout)|rad-label' .agents/skills/rad-plan/SKILL.md` returns nothing

#### Task 1.2: rad-adopt source
File: .rad/skills/rad-adopt/SKILL.md:1-1, .claude/commands/team/rad-adopt.md:1-306, .agents/skills/rad-adopt/SKILL.md:1-1
What: The same as Task 1.1, for `rad-adopt` (`targets: { claude: command:team/rad-adopt, codex: skill }`).
- `$ARGUMENTS` becomes `{{args}}`.
- Step 4's "Use context tools" becomes: delegate the research to a sub-agent if your tool can run one, otherwise do it inline, keeping only a bounded summary, with the same 10-call cap.
- The Rules line "only through context tool orchestrators" becomes the same tool-neutral wording.
- "Files Claude should load" becomes "Files the executor should load".
- Command references are written by name.
Run `generate`. Commit only the source and its two outputs.
Validate: AC#1, AC#2, AC#3, AC#4 — `generate --check` exits 0; the diff against main shows only the frontmatter/marker and the AC#4 edits; the same grep over `.agents/skills/rad-adopt/SKILL.md` returns nothing

### Wave 2 — parallel
Tests and docs, once the sources exist.

#### Task 2.1: Tool-neutrality test and install check
File: harness/test/skill-bodies.test.js:1-1, scripts/test-install-harness.sh:436-455
What: `skill-bodies.test.js` reads `.agents/skills/rad-plan/SKILL.md` and `.agents/skills/rad-adopt/SKILL.md`, plus the two generated Claude commands, from the repo. Write a table-driven test over a `TOOL_NEUTRAL_SKILLS` constant (`['rad-plan', 'rad-adopt']`, so 2d and part 3 can extend it). For each skill:
- The Codex body has the generated marker and contains `node harness/cli.js plan-open`.
- It contains no `$ARGUMENTS`, `Explore`, `Files Claude`, `git add`, `git commit`, `git push`, `git checkout` or `rad-label.sh`.
- The Claude command has the marker and contains `$ARGUMENTS`.
- There is a negative case: a fixture string containing `git commit` fails the same predicate, which proves the check isn't vacuous.
In `test-install-harness.sh`, add `rad-plan rad-adopt` to `SLICE_SKILLS`.
Validate: AC#5, AC#6 — `node --test harness/test/skill-bodies.test.js` passes; `bash scripts/test-install-harness.sh` and `/bin/bash scripts/test-install-harness.sh` pass

#### Task 2.2: Portability table and upgrade note
File: docs/rad-tool-portability.md:30-60, UPGRADE.md:10-40
What: In the commands table, the `rad-plan` and `rad-adopt` rows become `Body: as-is`, with Deps `sub-agent (optional), $ARGUMENTS` and `$ARGUMENTS, gh` respectively, and `Status: generated (#186 part 2c)`. In UPGRADE.md, add a row or note in the existing style saying `.claude/commands/team/rad-plan.md` and `rad-adopt.md` are now generated (with a marker) from `.rad/skills/rad-{plan,adopt}/SKILL.md`, so local edits move to the source and you rerun `rad generate`, and that Codex gets `.agents/skills/rad-{plan,adopt}`.
Validate: AC#7 — `grep -n 'generated (#186 part 2c)' docs/rad-tool-portability.md` matches two rows; `grep -n 'rad-plan' UPGRADE.md` matches

## Tests to Write
- [ ] Tool-neutrality and marker checks over the generated plan and adopt bodies — harness/test/skill-bodies.test.js
- [ ] The install ships the generated rad-plan and rad-adopt skills — scripts/test-install-harness.sh

## Non-Goals
- Moving `/rad-approve` (2d) or any part 3 or 4 command.
- Changing what plan or adopt do, or their plan templates beyond the one "Files the executor" comment wording.
- Generator changes, or new body tokens.
- Setting `codex_implicit: false` for plan or adopt.

## Out-of-Scope Dependencies
None

## Risks
- **Drift in the Claude command body.** The generated command replaces a hand-written one, so any accidental edit beyond AC#4 changes Claude behavior. Mitigation: AC#3 and each task's validation diff the generated Claude command against main.
- **Install upgrades overwrite local edits.** `.claude/commands/` is already a core tree, so an upgrade already overwrites it. The UPGRADE note points edits at the source.
- **Self-protected paths** (`.rad/`, `.claude/`, `scripts/`, `harness/test/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — one shared body (design Q1):** no `codex.md` override. The user decided only the split on 2026-10-07, so the architect should confirm this at review.
- **Assumption — `codex_implicit` stays true for plan and adopt (design Q2):** they create only pending-review work on their own branch, and nothing runs until approval. 2d sets `false` for approve. Architect to confirm.
- **Assumption — command references:** they're written as bare names (`rad-approve`), not `/architect:rad-approve`, because the shared body serves both tools. A single slash form appears where it helps a Claude user.
- **Assumption — the read budget:** the two command bodies count once, as the starting text. The generated Claude outputs aren't read again.
