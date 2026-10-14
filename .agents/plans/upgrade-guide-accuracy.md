# Plan: UPGRADE.md Accuracy: Core Set, Commit Steps, Agent Adapters, Command Names
Created: 2026-10-14
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-14T16:47:45.708Z
Recorded-By: sean@torchcodelab.com
Branch: rad/upgrade-guide-accuracy
Tier: light
Source-Author: none (no source issue)
Source-Comments: none

## Context
Third plan from the 2026-10-14 docs audit. `UPGRADE.md` tells people what an upgrade refreshes and what to commit afterwards. Measured on 2026-10-14 by running `install.sh --yes` into a scratch repo and reading `.rad/installed.json` and `harness/install-manifest.js`, the manifest holds, all in the `core` layer: `.claude/commands` (12), `.claude/skills` (2), `ai/` (7), `scripts/` (70, including `*.mjs`), `harness/` (179), **plus** `.rad/skills` (16) and `.rad/agents` (2) (the `rad generate` source trees) and the marker-bearing generated files in `.agents/skills` (20), `.claude/agents` (2) and `.codex/agents` (2). The guide is behind that:

- The "what an upgrade touches" table (lines 15-30) says `.claude/agents/` and `.agents/` are "never touched" and has no rows for `.rad/skills`, `.rad/agents`, `.agents/skills` or `.codex/agents`.
- The manifest section (lines ~148-152) lists the core set without `scripts/*.mjs`, `.rad/skills/**`, `.rad/agents/**` or the marker-bearing generated files, and says `.claude/agents/` is never in it.
- The commit commands at lines 85 and 115 (`git add .claude/commands/ .claude/skills/ ai/ scripts/ harness/ .rad/installed.json`) leave the refreshed `.rad/skills`, `.rad/agents`, `.agents/skills`, `.codex/agents`, `.claude/agents` and the merged `.claude/settings.json` uncommitted, so the committed manifest hashes would disagree with the committed files.
- The agent section (~lines 466-490) shows only the two `command` presets.
- 12 bare `/rad-*` commands (lines 89, 218-270, 408-421 area) do not resolve; only the namespaced forms do.

Nothing here changes behaviour; it makes the guide match `harness/install-manifest.js` and `install.sh`.

## Acceptance Criteria
1. **Table is accurate.** The touches table gains rows for `.rad/skills/` and `.rad/agents/` (refreshed, source trees for `rad generate`), `.agents/skills/` and `.codex/agents/` (refreshed, only the generated files the installer shipped), and the `.claude/agents/` row says the installer-shipped generated reviewers are refreshed with the same keep-local-edits rule while agent files you created with `/architect:rad-design` are never touched. The `.agents/` row says its content (research, architecture, plans, logs, findings) is never touched, apart from the generated skill files under `.agents/skills/`.
2. **Core set is accurate.** The manifest section lists the core set as `.claude/commands/**`, `.claude/skills/**`, `ai/**`, `scripts/*.sh`, `scripts/*.mjs`, `scripts/lib/**`, `scripts/hooks/**`, `harness/**` (except `harness/node_modules/**`), `.rad/skills/**`, `.rad/agents/**`, and the generated-marker files under `.claude/agents/`, `.agents/skills/` and `.codex/agents/`; and it says `CLAUDE.md`, `AGENTS.md`, your own agent files, `.claude/settings*.json`, `.agents/` content and `.rad/config.yml` are never in it.
3. **Commit commands complete.** Both `git add` lines at 85 and 115 become `git add .claude/ .codex/ .agents/skills/ .rad/ ai/ scripts/ harness/`, and the sentence after the manual-copy block (~line 125, "Do not copy … `.claude/agents/` …") is consistent with AC#1 (project-owned agent files are not copied).
4. **Agent section covers all adapters.** The agent-setting section adds one short paragraph saying `agent.adapter` may also be `acp` or `sdk`, that any other CLI is set with `rad config init --agent-cmd "<cmd>"` (optionally `--agent-adapter acp`) or by editing `.rad/config.yml`, and that `node scripts/claude-usage.mjs` as the command adds token and cost reporting to a Claude agent, linking to `INSTALL.md#choose-your-agent` and `docs/configuration.md#agent-adapter`. The two existing presets stay.
5. **Namespaced commands.** No bare `/rad-<name>` remains in `UPGRADE.md` unless part of a longer path or already namespaced, using the mapping: `plan`, `research`, `adopt`, `deliver`, `review` become `/team:rad-<name>`; `approve`, `design`, `epic-decompose` become `/architect:rad-<name>`; `status`, `insights` become `/shared:rad-<name>`. Check: `grep -nE '(^|[^:/A-Za-z0-9_.-])/rad-' UPGRADE.md` prints nothing. The `/rad-status` instruction at line 89 no longer says "in Claude Code" as the only option.
6. **Verified against a real upgrade.** Task 1.3 records, from a scratch repo, that (a) a fresh install's manifest contains the path families named in AC#2, (b) an unedited marker-bearing reviewer in `.claude/agents/` is refreshed or left identical on `--upgrade`, (c) a locally edited one is kept and staged under `.rad/upgrade-pending/`, and (d) a hand-written agent file without the generated marker is untouched. If any of these contradicts AC#1, the plan's wording follows the measured behaviour and the task notes the difference.
7. **Nothing else changes.** `git diff --stat` shows only `UPGRADE.md` and this plan; relative links still resolve; the dated "upgrading to …" history sections are not otherwise reworded.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| UPGRADE.md | 15-30 | Touches table: new rows and corrected `.claude/agents/` and `.agents/` rows |
| UPGRADE.md | 78-128 | Commit commands (85, 115), `/rad-status` line (89), manual-copy sentence (125) |
| UPGRADE.md | 140-155 | Core-set description |
| UPGRADE.md | 215-275 | Command-name sweep (Lane B section) |
| UPGRADE.md | 400-511 | Command-name sweep; agent section paragraph |

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.
Verify: none (documentation only; Task 1.3 runs a scratch install and upgrade plus the grep, link and diff checks)

#### Task 1.1: Touches table and core-set description
File: UPGRADE.md:15-30, UPGRADE.md:140-155
What: Apply AC#1 and AC#2. Use `harness/install-manifest.js` (`CORE_TREES`, `CORE_FLAT`, `SOURCE_TREES`, `MARKED_ROOTS`) as the source of truth for the path families. Change no other row or sentence.
Validate: AC#1, AC#2 — every path family in the manifest appears in the table and the core-set sentence; none is listed as "never touched" while the manifest ships it.

#### Task 1.2: Commit commands, agent section and command names
File: UPGRADE.md:78-128, UPGRADE.md:215-275, UPGRADE.md:400-511
What: Apply AC#3 (the two `git add` lines and the sentence at ~125), AC#4 (one paragraph in the agent section) and AC#5 (sweep the 12 bare commands and soften the `/rad-status` line at 89). Do not reword the historical upgrade narratives beyond the command names.
Validate: AC#3, AC#4, AC#5 — the AC#5 grep prints nothing; both `git add` lines match AC#3.

#### Task 1.3: Verify against a real upgrade, then check
File: UPGRADE.md:15-30
What: In a scratch git repo under the scratchpad (never in this repository): run `bash install.sh --yes --dir <scratch>`, read `.rad/installed.json`, then run `--upgrade` after (b) leaving a reviewer unedited, (c) editing one reviewer, and (d) adding a hand-written `.claude/agents/my-agent.md` with no generated marker. Record what happened for AC#6 in the task note and correct the Task 1.1 wording if the measured behaviour differs. Then run the AC#5 grep, check every relative markdown link in `UPGRADE.md` resolves, and run `git diff --stat main...HEAD`.
Validate: AC#5, AC#6, AC#7 — the grep prints nothing; the scratch results are recorded; the diff stat lists only `UPGRADE.md` and this plan.

## Tests to Write
- None. Documentation only; the scratch install and upgrade in Task 1.3 are the verification.

## Non-Goals
- Changing `install.sh`, `harness/install-manifest.js` or any script
- Rewriting the dated per-version "upgrading to …" narratives beyond command names
- The reference docs and `harness-*` docs (separate plans)

## Risks
- `.claude/agents/` behaviour is subtle (installer-shipped generated files are core; your own are not). AC#6 makes the executor measure it so the wording follows the code.
- A mechanical sweep can hit a bare `/rad-` inside a path; AC#5 excludes those and the diff review catches the rest.
