# Plan: Lean CLAUDE.md (#87 part 2b)
Created: 2026-10-01
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-01T17:34:17.516Z
Recorded-By: sean@torchcodelab.com
Branch: rad/lean-claude-md
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/87
Issue-Title: Move RAD configuration out of CLAUDE.md into a data file the harness reads

## Context

#87's goal is to stop CLAUDE.md, which is injected into every session, from doubling as configuration data.

After #87a (#169) every reader takes config from `.rad/config.yml`. Even so, CLAUDE.md's `## RAD Configuration` section is still **379 of its 493 lines**:
- the old config fences, now dead data;
- the role assignments and the 29-row Agent Scope Map;
- a reference for every `RAD_*` environment variable.

The model doesn't need any of that to plan or code; the scripts implement it.

Because `install.sh` copies this repo's CLAUDE.md as the template for new installs, every new install also inherits this repo's architect email and scope map.

Five commands and one skill still tell the model to read roles or the scope map from CLAUDE.md:
- `/rad-design` Step 7 prints a scope-map table to paste into CLAUDE.md;
- `/rad-status` renders the map from CLAUDE.md;
- `/rad-plan` and `/rad-adopt` check role scope against it;
- `/rad-approve` describes proxy validation in CLAUDE.md terms;
- `/kickoff` reads role assignments from it.

Eight docs also point at CLAUDE.md for config.

This plan is the second half of #87b. It is delivered after `rad-config-init-and-install`, because `docs/configuration.md` documents `rad config init`.

**Decision (architect, 2026-10-01):** add an **advisory** CLAUDE.md line-budget lint at about 150 lines. It warns but never blocks, so the file can't silently grow back.

## Scope

| In scope | Out of scope |
|---|---|
| CLAUDE.md `## RAD Configuration` cut to a short pointer | Any other CLAUDE.md section |
| New `docs/configuration.md`: the config file schema, `rad config`, and the env-variable reference moved verbatim | Rewording the moved env-variable text |
| Advisory `scripts/lint-claude-md.sh`, its test, and CI wiring | A blocking lint |
| The five commands and one skill read config through `rad config get` | `.claude/agents/*` (feature-specific historical agents) |
| Doc pointers in README, architect-guide, how-it-works, onboarding, plan-pr-guide, platform-support, apply-to-existing, rad-cli | INSTALL.md and UPGRADE.md (done in `rad-config-init-and-install`); comparison docs (`wsd-vs-rad`, `cosmos-vs-rad`, `framing-decisions`) |

## Acceptance Criteria

1. **CLAUDE.md's `## RAD Configuration` is cut to about 20 lines.** They state:
   - authoritative config lives in `.rad/config.yml`, read with `node harness/cli.js config get <key>`;
   - the full reference is `docs/configuration.md`;
   - plans that edit `.rad/`, `harness/` or `scripts/` are always flagged for architect review.

   The removal has these limits:
   - Everything else in the section is removed: every `###` subsection, the old config fences, Role Assignments, the Agent Scope Map table, and the #87 marker comment.
   - `## What Claude Must Never Do`, `## Workflow` and every section above `## RAD Configuration` are byte-for-byte unchanged.
   - The resulting CLAUDE.md is at most 150 lines.
2. **New `docs/configuration.md`:**
   - **Content:** the `.rad/config.yml` schema (every key, its type and validation rules); `rad config get/validate/init/migrate` with their exit codes; Approval Rules; Branch Conventions; PR labels; Self-Protected Paths.
   - **Moved text:** every `RAD_*` environment-variable subsection (Agent Adapter, Cost & Frugality, Per-Wave Verification, Worktree Isolation, Portable Sync, Plan Lint high-risk paths, Wave-Lifecycle Hooks), moved with its wording unchanged.
   - **Completeness check:** every `RAD_[A-Z_]+` name that appeared in the old CLAUDE.md section appears in `docs/configuration.md`.
3. **New `scripts/lint-claude-md.sh [path]`** (default `CLAUDE.md`):
   - It prints `⚠ CLAUDE.md is N lines (budget 150)` and exits **0** when over budget, and prints `✓ CLAUDE.md: N lines (budget 150)` otherwise.
   - A missing or unreadable file exits 2.
   - The budget is the named constant `CLAUDE_MD_LINE_BUDGET=150`.
   - The test `scripts/test-lint-claude-md.sh` covers under budget, over budget (still exits 0), exactly at budget, a missing file, and an empty file.
   - CI runs it as an advisory step: it shows output and never fails the job.
4. **`/rad-design` Step 7 and Step 8:**
   - They print an `agent_scope_map:` YAML block, one `{ agent, type, reads, roles }` row per agent, for the architect to paste into `.rad/config.yml`, then tell them to run `node harness/cli.js config validate` and `scripts/lint-agent-files.sh`.
   - The rule "never write to CLAUDE.md directly" becomes "never write `.rad/config.yml` directly; print the block".
   - Nothing in `rad-design.md` tells the model to read or paste config into CLAUDE.md.
5. **The other commands and `/kickoff`:**
   - `/rad-status` renders the scope map from `node harness/cli.js config get agent_scope_map`.
   - `/rad-plan` and `/rad-adopt` check role scope against the same command and `config get roles.<key>`.
   - `/rad-approve` describes proxy validation as "a configured architect in `.rad/config.yml`". Its `check-role.sh` call drops the legacy `CLAUDE.md` argument (`scripts/check-role.sh architect "$ON_BEHALF_OF"` keeps its existing positional meaning, or uses `.`, as `check-role.sh` accepts).
   - `/kickoff` reads roles from `rad config get`.
   - `grep -rnE "CLAUDE\.md.*(Role Assignments|Agent Scope Map|scope map|configured architect)" .claude/commands .claude/skills` finds nothing.
6. **Docs:** the eight in-scope docs point at `.rad/config.yml` and `docs/configuration.md` instead of CLAUDE.md for platform, default branch, roles and the scope map. `grep -nE "(default_branch:|platform:|Role Assignments|Agent Scope Map).*CLAUDE|CLAUDE.*(default_branch|Role Assignments|Agent Scope Map)"` over those eight files finds nothing.
7. **Everything stays green:**
   - harness tests and evals;
   - every `scripts/test-*.sh` under both `bash` and `/bin/bash`;
   - `lint-shell-safety` and `lint-invariants`;
   - `lint-agent-files.sh` (the scope-map sync reads `.rad/config.yml`, not the CLAUDE.md table);
   - `rad config validate`.

## Agent Scope

No mapper agents were used. The surface was mapped directly with greps:
- CLAUDE.md headings: `## RAD Configuration` at 93, `## Workflow` at 472;
- skill and command references;
- doc references, with line numbers recorded in Files in Scope.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| CLAUDE.md | 90-493 | Cut `## RAD Configuration` to a pointer |
| docs/configuration.md | 1-350 | New: schema, `rad config`, rules; env text moved from CLAUDE.md |
| scripts/lint-claude-md.sh | 1-50 | New advisory line-budget lint |
| scripts/test-lint-claude-md.sh | 1-70 | New fixture test |
| .github/workflows/ci.yml | 75-110 | Advisory lint step |
| .claude/commands/architect/rad-design.md | 1-10 | Header line about the scope map |
| .claude/commands/architect/rad-design.md | 240-296 | Steps 7-8 and rules |
| .claude/commands/architect/rad-approve.md | 25-90 | Proxy validation wording + `check-role.sh` call |
| .claude/commands/architect/rad-approve.md | 378-398 | Rules wording |
| .claude/commands/team/rad-plan.md | 82-90 | Role scope source |
| .claude/commands/team/rad-plan.md | 428-436 | Rules |
| .claude/commands/team/rad-adopt.md | 280-288 | Rules |
| .claude/commands/shared/rad-status.md | 1-30 | Scope map source |
| .claude/skills/kickoff/SKILL.md | 15-25 | Roles source |
| README.md | 72-80 | Default-branch pointer |
| docs/architect-guide.md | 60-100 | Scope-map paste + roles + branch protection |
| docs/how-it-works.md | 72-80 | Scope map location |
| docs/how-it-works.md | 166-176 | Role gating source |
| docs/onboarding.md | 64-72 | Scope map location |
| docs/onboarding.md | 160-166 | Scope map location |
| docs/plan-pr-guide.md | 56-68 | Scope map location |
| docs/platform-support.md | 165-205 | Manual mode + configuring platform |
| docs/apply-to-existing.md | 220-230 | Scope map location |
| docs/rad-cli.md | 644-652 | Authenticity identity source |
| docs/rad-cli.md | 704-714 | Scope-map sync source |
| harness/test/config.test.js | 186-197 | Amendment 1: the live-CLAUDE.md migrate test becomes a "CLAUDE.md carries no config" guard |

## Execution Notes

### Do Not Touch
- `harness/` and `scripts/` other than the two new lint files and (Amendment 1) the one test in `harness/test/config.test.js:186-197`
- `.rad/config.yml`
- `.claude/agents/`
- INSTALL.md, UPGRADE.md
- CLAUDE.md sections other than `## RAD Configuration`

### Key Files
- CLAUDE.md: the `## RAD Configuration` section (93-471)
- `harness/cli.js`: `rad config` usage text, for the `docs/configuration.md` command reference
- `harness/config.js`: `validateConfig` rules, for the schema section
- `scripts/lint-agent-files.sh`: an existing advisory/fail-closed lint, for style

### Reminders
- **Move the env-variable text verbatim.** This is a relocation, not a rewrite. Check the completeness rule in AC#2 with a grep diff of the `RAD_` names.
- **CLAUDE.md is also the install template.** After this change, new installs get no project-specific identity or scope map.
- **bash 3.2 portability and shell-safety lint** apply to the new script.
- **No en dashes in plan or shell files.** macOS awk fails on them in `lint-plan.sh`.

## Wave Plan

### Wave 1 — parallel
Disjoint files.

#### Task 1.1: CLAUDE.md pointer + docs/configuration.md
File: CLAUDE.md:90-493, docs/configuration.md:1-350
What: Implement AC#1 and AC#2.
Validate: AC#1, AC#2:
- `wc -l CLAUDE.md` is at most 150;
- the sections outside `## RAD Configuration` are unchanged: `git diff` touches only that section;
- the `RAD_` names in the old section (`git show HEAD:CLAUDE.md`) are a subset of those in `docs/configuration.md`.

Edge case: a `RAD_` name that appeared only in a code fence still has to be carried over.

#### Task 1.2: Advisory CLAUDE.md line-budget lint
File: scripts/lint-claude-md.sh:1-50, scripts/test-lint-claude-md.sh:1-70, .github/workflows/ci.yml:75-110
What: Implement AC#3.
Validate: AC#3:
- `bash scripts/test-lint-claude-md.sh && /bin/bash scripts/test-lint-claude-md.sh`;
- `scripts/lint-shell-safety.sh` shows no ✗;
- the CI step is advisory: no `exit` on a warning, and only a missing file fails it.

Edge cases: an empty file, a missing file, exactly 150 lines, 151 lines.

### Wave 2 — parallel
After the CLAUDE.md block is gone, so nothing points at removed content.

#### Task 2.1: Commands + kickoff read `rad config`
File: .claude/commands/architect/rad-design.md:1-10, .claude/commands/architect/rad-design.md:240-296, .claude/commands/architect/rad-approve.md:25-90, .claude/commands/architect/rad-approve.md:378-398, .claude/commands/team/rad-plan.md:82-90, .claude/commands/team/rad-plan.md:428-436, .claude/commands/team/rad-adopt.md:280-288, .claude/commands/shared/rad-status.md:1-30, .claude/skills/kickoff/SKILL.md:15-25
What: Implement AC#4 and AC#5.
Validate: AC#4, AC#5:
- the AC#5 grep finds nothing;
- `node harness/cli.js config get agent_scope_map` and `config get roles.architect` work as the commands describe;
- `scripts/check-role.sh architect` runs with the call form `rad-approve.md` now documents.

#### Task 2.2: Doc pointers
File: README.md:72-80, docs/architect-guide.md:60-100, docs/how-it-works.md:72-80, docs/how-it-works.md:166-176, docs/onboarding.md:64-72, docs/onboarding.md:160-166, docs/plan-pr-guide.md:56-68, docs/platform-support.md:165-205, docs/apply-to-existing.md:220-230, docs/rad-cli.md:644-652, docs/rad-cli.md:704-714
What: Implement AC#6.
Validate: AC#6, AC#7:
- the AC#6 grep finds nothing;
- the full suite is green: harness tests, evals, every `scripts/test-*.sh` under both shells, `lint-shell-safety`, `lint-invariants`, `lint-agent-files.sh`, `rad config validate`.

This is a docs-only task, so beyond the greps its surface is checked by review.

#### Task 2.3: Live-CLAUDE.md migrate test becomes a no-config guard
File: harness/test/config.test.js:186-197
What: Amendment 1. The test "migrate: this repo's CLAUDE.md deep-equals the committed .rad/config.yml" parses config blocks out of the live CLAUDE.md, which AC#1 removes, so it fails after Wave 1. Replace it with "this repo's CLAUDE.md carries no config; .rad/config.yml is the source":
- the committed `.rad/config.yml` loads `ok` and `roles.architect[0]` is `sean@torchcodelab.com` (kept from the old test);
- `migrateFromClaudeMd` on the live CLAUDE.md reports every required key missing (`platform`, `default_branch`, `roles.architect`) and returns no blocks.

The fixture-based migrate tests (around line 168) still cover the parser.
Validate: AC#1, AC#7 (amendment 1): `npm test --prefix harness` is fully green. Edge case: the guard must fail if a `### Git Platform` or `### Role Assignments` block is put back into CLAUDE.md. Check this once by hand on a scratch copy.

## Tests to Write
- [ ] CLAUDE.md line-budget lint cases — scripts/test-lint-claude-md.sh
- [ ] CLAUDE.md carries no config guard — harness/test/config.test.js (Amendment 1)

## Non-Goals
- Rewording the moved environment-variable reference. It is moved verbatim, and any cleanup is a separate change.
- Generating `AGENTS.md` for Codex. That's #171.
- Changing any reader or validator. #87a did that.

## Out-of-Scope Dependencies
None.

## Risks
- **Lost model context.** Planning loses the env-variable reference it used to see in every session. Mitigation: the CLAUDE.md pointer names `docs/configuration.md`. The knobs are operator settings, not something a planner needs, which is #87's premise.
- **The template changes for new installs.** New installs no longer see a config example in CLAUDE.md; `rad config init` writes the real file. That is covered in `rad-config-init-and-install`.
- **Self-protected paths:** `scripts/` and `.claude/` trigger advisory lint warnings by design.

## Issue Gaps
- **AMENDMENT 1 (2026-10-01, after Wave 1).** `harness/test/config.test.js:187` ran `migrateFromClaudeMd` on the live CLAUDE.md and deep-equalled the result with `.rad/config.yml`. That is a #87a transition check that AC#1 makes impossible, and the full suite drops to 713/714. `harness/` was Do Not Touch, so the new Task 2.3 replaces it with the inverse guard: CLAUDE.md carries no config. The range `harness/test/config.test.js:186-197` is added.
- **ASSUMPTION — doc-only knobs.** Branch Conventions and PR Labels have no reader, so they move to `docs/configuration.md` as prose, not into the config schema.
- **ASSUMPTION — `.claude/agents/`.** Their mentions of CLAUDE.md are descriptions of historical feature agents. They're left alone; #171 revisits the agent surface.
