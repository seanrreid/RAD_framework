# Plan: Install Docs for a Bring-Your-Own Agent
Created: 2026-10-14
Author: architect
Status: complete
Completed-At: 2026-10-14T13:35:19.157Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-14T13:34:03.953Z
Recorded-By: sean@torchcodelab.com
Branch: rad/byo-agent-install-docs
Tier: light
Source-Author: none (no source issue)
Source-Comments: none

## Context
`INSTALL.md` and `README.md` still read as Claude-only: `claude` is listed as a required prerequisite, the agent choice is not explained, and the installed-file trees, first-run commands, branch-protection step and uninstall list no longer match what `install.sh` really lays down. `rad deliver` runs whatever `agent:` names (`command`, `acp` or `sdk` adapter); `claude` and `codex` are only presets. This plan brings the two files in line with the product, with no change to `install.sh`, `scripts/` or any test.

Measured on 2026-10-14 by running `install.sh --yes` into a scratch repo: the install creates `.claude/{agents,commands,skills,settings.json}`, `.codex/agents/`, `.agents/{research,plans,architecture,logs,findings,skills}` plus `findings.jsonl`, `.rad/{agents,skills,config.yml,installed.json}`, `ai/`, `harness/`, `scripts/` (including its `test-*.sh` files, `lib/`, `hooks/`, `claude-usage.mjs`), `AGENTS.md` and `CLAUDE.md`. `.agents/state/`, `epics/` and `playbooks/` are runtime-created, not installed. `.claude/agents/` and `.codex/agents/` each hold the two built-in reviewers.

## Acceptance Criteria
1. **Agent is not Claude-only.** The INSTALL.md prerequisites table no longer lists `claude` as required: it asks for "an agent CLI of your choice" (or an API key for `sdk`), names `claude` and `codex` as presets, and README has a matching prerequisites line.
2. **Choose your agent.** INSTALL.md has a "Choose your agent" section that covers: the three adapters (`command`, `acp`, `sdk`); `install.sh --agent claude|codex`; `rad config init --agent-cmd "<cmd>"` with `--agent-adapter`; the allow-listed env (`PATH HOME LANG LC_ALL TMPDIR TERM USER`) so the agent must authenticate from on-disk credentials or the keychain; `RAD_AGENT` / `RAD_AGENT_CMD` taking precedence over `agent:` all-or-nothing; the `node scripts/claude-usage.mjs` wrapper as the way to get token and cost reporting from `claude -p`; and a link to `docs/configuration.md#agent-adapter`. README gets a short pointer to it.
3. **Trees match reality.** The "What Gets Installed" tree in INSTALL.md and the "File Structure After Installation" tree in README contain every top-level path of the measured install above, mark `state/`, `epics/` and `playbooks/` as created at runtime, and summarize the scripts rather than listing every file. The false sentence that `.claude/agents/` "is not populated at install time" is gone.
4. **Namespaced first-run commands.** The first-run command in INSTALL.md (and its Post-Install step) is `/team:rad-research`, with one short note explaining that commands are namespaced by role directory and that docs elsewhere use the bare name as shorthand.
5. **Branch protection is accurate.** The INSTALL.md branch-protection step uses a `gh api … --method PUT --input -` call whose JSON body includes `required_status_checks`, `enforce_admins`, `required_pull_request_reviews` and `restrictions`, says it is recommended and not applied by the installer, and README's sentence about enforcement says branch protection is recommended rather than present by default.
6. **Uninstall is complete.** The INSTALL.md uninstall steps cover `.claude/`, `.codex/`, `.agents/`, `.rad/`, `ai/`, `harness/`, `scripts/`, `AGENTS.md` and `CLAUDE.md`, and keep the "keep your plan history" variant.
7. **Nothing else changes.** `git diff --stat` against the default branch shows only `INSTALL.md`, `README.md` and this plan file; no `install.sh`, `scripts/` or `harness/` change; markdown links in the two files still resolve to files that exist.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| INSTALL.md | 8-16 | Prerequisites: agent CLI of your choice, not `claude` |
| INSTALL.md | 58-120 | "What Gets Installed" tree and the agents sentence |
| INSTALL.md | 247-352 | New "Choose your agent" section, namespaced first-run command, corrected branch-protection step |
| INSTALL.md | 386-407 | Complete the uninstall list |
| README.md | 119-146 | Branch-protection wording, installation pointer, prerequisites line |
| README.md | 147-205 | File-structure tree |

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel.
Verify: none (documentation only; Task 1.3 checks the trees against a scratch install and the links)

#### Task 1.1: Update INSTALL.md
File: INSTALL.md:8-16, INSTALL.md:58-120, INSTALL.md:247-352, INSTALL.md:386-407
What: Apply AC#1 (prerequisites), AC#2 (a "Choose your agent" section placed before "Post-Install Setup" step 1, linking to `docs/configuration.md#agent-adapter`), AC#3 (installed-files tree and the `.claude/agents/` sentence), AC#4 (namespaced `/team:rad-research` in Post-Install step 5 plus one note), AC#5 (branch-protection step) and AC#6 (uninstall list). Do not run the branch-protection API call; show it as a command for the reader.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#6 — every claim in the section matches `docs/configuration.md` § Agent Adapter and the measured install; `gh api` JSON body parses with `node -e "JSON.parse(...)"`.

#### Task 1.2: Update README.md
File: README.md:119-146, README.md:147-205
What: Apply AC#1 (a prerequisites line), AC#2 (a short "Choose your agent" pointer to INSTALL.md and `docs/configuration.md#agent-adapter`), AC#3 (file-structure tree) and AC#5 (the "enforcement is via branch protection and PR workflow" sentence at line 130 becomes "recommended; see INSTALL.md").
Validate: AC#1, AC#2, AC#3, AC#5 — the README tree and INSTALL.md tree name the same top-level paths.

#### Task 1.3: Verify against a real install
File: INSTALL.md:58-120
What: No edit. Run `bash install.sh --yes --dir <scratch git repo>`, list the result, and compare top-level paths with both trees; check that every relative markdown link in `INSTALL.md` and `README.md` resolves; run `scripts/lint-plan.sh` on this plan. Record the result in the task note.
Validate: AC#3, AC#7 — the two trees agree with the scratch install; `git diff --stat` lists only the three allowed files.

## Tests to Write
- None. Documentation only: the checks are the scratch install, the link check and the JSON parse above.

## Non-Goals
- Changing `install.sh`, including the "Next steps" text it prints (a separate standard plan)
- The docs purge, the `docs/research/` move, the `plan-pr-guide.md` rename and the README docs table (PR 2)
- Auditing `docs/rad-cli.md` and the other large reference docs
- Enabling branch protection on this repository

## Risks
- The trees will drift again when the installer changes; INSTALL.md summarizes scripts instead of listing them to reduce that.
- The branch-protection JSON is written from the GitHub API's documented shape and is not executed here; a reader should try it on a throwaway repository first. The text says so.
