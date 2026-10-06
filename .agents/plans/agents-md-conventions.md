# Plan: AGENTS.md as the Conventions Source (#171 part 3)
Created: 2026-10-06
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-06T19:32:58.830Z
Recorded-By: sean@torchcodelab.com
Branch: rad/agents-md-conventions
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/171
Issue-Title: Assistant-portable skill surface: one source, generated Claude + Codex wrappers (no symlinks)

## Context

Parts 1 and 2 (#187, #188) shipped the generator and the read-only slice. Part 3 moves project conventions into `AGENTS.md`, which Codex reads natively, and turns `CLAUDE.md` into a small file that imports it with `@AGENTS.md`. Anthropic recommends that import over a symlink.

**What has to change:**
- **CLAUDE.md is the conventions file today.** It has 134 lines. Sections: Project, Stack, Structure, Commands, Architecture Decisions, Coding Conventions, Testing Standards, What Claude Must Never Do, Known Constraints, RAD Configuration, Workflow.
- **`@AGENTS.md` doesn't help a direct read.** It is expanded only when Claude Code loads `CLAUDE.md` at session start. A direct Read of `CLAUDE.md` returns the import line, not the conventions.
- **These readers must therefore switch to AGENTS.md:**

| Reader | Where it reads `CLAUDE.md` |
|---|---|
| `.rad/agents/quality-reviewer.md` | 6, 32, 86, 89, 186, 189 |
| `.rad/agents/accessibility-reviewer.md` | 7, 40, 125, 209 |
| `.rad/skills/quality-review/SKILL.md` | 6, 30 |
| `.rad/skills/accessibility-review/SKILL.md` | 31 |
| `.claude/commands/team/rad-review.md` | 32, 333 |
| `.claude/skills/kickoff/SKILL.md` | 4, 19, 118 |
| `.claude/commands/architect/rad-epic-decompose.md` | 80, 202 |
| `.claude/commands/shared/rad-insights.md` | 80, 96, 111, 1136; 485 points at a "Cost & Frugality" section that actually lives in `docs/configuration.md:230` |
| `scripts/draft-insights-plan.sh` | `conventions_range` (91-97) greps `## Coding Conventions` |

- **The scope map** in `.rad/config.yml` describes reviewer reads as "CLAUDE.md conventions" (lines 90, 122, 126).
- **The installer:** `install.sh` `scaffold_claude_md` (305-322) copies RAD's `CLAUDE.md` as the template.
- **The lint:** `scripts/lint-claude-md.sh` checks one file (`CLAUDE.md`) against a 150-line advisory budget. It runs in CI as `claude-md-budget`.
- **Untouched:** `config migrate` reads a **pre-#87** `CLAUDE.md` config block, which is a legacy migration path. It stays as it is.

Decisions (2026-10-06, recorded on #171):
- **Fallback, no automatic move.** Every reader uses `AGENTS.md` when it exists, else `CLAUDE.md`. Fresh installs get `AGENTS.md` plus a `CLAUDE.md` that imports it. Upgrades never touch a user's `CLAUDE.md`; they print a one-line hint, and `UPGRADE.md` documents the manual move. RAD's own repo moves now.
- **Lint both files.** The advisory budget applies to `AGENTS.md` and `CLAUDE.md`, plus a warning above Codex's 32 KiB `AGENTS.md` cap.

## Scope

| In scope | Out of scope |
|---|---|
| `AGENTS.md` (new) holds RAD's conventions; `CLAUDE.md` becomes `@AGENTS.md` + Claude-only notes | Automatically splitting a user's `CLAUDE.md` |
| Every shipped conventions reader uses AGENTS.md → CLAUDE.md fallback (prose + `draft-insights-plan.sh`) | `config migrate` (pre-#87 legacy, still reads CLAUDE.md) |
| Fresh-install scaffold of both files; upgrade hint | Docs beyond INSTALL, UPGRADE, maintaining-claude-md, portability (README, architect-guide, daily-workflow, apply-to-existing) |
| Conventions lint covers both files + 32 KiB AGENTS.md warning | Changing the 150-line budget |
| Regenerate the slice outputs from updated sources | State-changing Codex parity (#186) |

## Acceptance Criteria

1. **RAD's own conventions move.**
   - **New `AGENTS.md`** holds what `CLAUDE.md` holds today: Project, Stack, Project Structure, Commands, Architecture Decisions, Coding Conventions, Testing Standards, Known Constraints, RAD Configuration, Workflow.
   - **"What the Agent Must Never Do":** the section is renamed from "What Claude Must Never Do" and stated without assistant-specific wording. The deliver rule says approval is checked by `rad deliver` and the gate.
   - **New `CLAUDE.md`** holds:
     - a short header;
     - the line `@AGENTS.md`;
     - a "Claude Code specifics" section: the namespaced command names (`/team:rad-plan`, `/architect:rad-approve`, `/shared:rad-status`, and so on); the PreToolUse deliver-gate hook (`scripts/deliver-gate-hook.mjs`) that blocks an unapproved `/rad-deliver`; and the CLAUDE.md-only maintenance notes.
   - **No rule is lost.** Every rule in today's `CLAUDE.md` appears in exactly one of the two files. The executor lists the mapping in the WAVE_RESULT.
   - **`harness/test/config.test.js`:** its live-repo guard ("this repo's CLAUDE.md carries no config") still passes, and gains the same assertion for `AGENTS.md`.
2. **The fallback rule.** A reader takes project conventions from `AGENTS.md` when it exists in the project root, otherwise from `CLAUDE.md`.
   - **Prose readers** (every one listed in Context) use one consistent phrase: "Read `AGENTS.md` for project conventions (or `CLAUDE.md` if the project has no `AGENTS.md`)". Each reference is adjusted to fit its sentence, with the meaning unchanged otherwise.
   - **`rad-insights`:**
     - its suggested-bullet target names the same file the fallback chooses;
     - line 485 points to `docs/configuration.md` "Cost & Frugality".
   - **`.rad/config.yml` scope-map `reads:` strings** say "AGENTS.md conventions" (data-only text).
   - **Regeneration:** `rad generate` regenerates the reviewer and command outputs from the updated sources, and `generate --check` is clean.
   - **`scripts/draft-insights-plan.sh`** `conventions_range` reads `AGENTS.md` when present, else `CLAUDE.md`, else the existing fallback lines. The file it reads is named in the generated plan text. `scripts/test-draft-insights-plan.sh` covers AGENTS.md only, CLAUDE.md only, both (AGENTS.md wins), and neither.
3. **Install scaffold** (`install.sh`). `scaffold_claude_md` becomes `scaffold_conventions`:

   | Target has | Fresh install | Upgrade |
   |---|---|---|
   | neither file | copy both templates | copy both templates |
   | `AGENTS.md` only | copy only the `CLAUDE.md` stub | copy only the `CLAUDE.md` stub |
   | `CLAUDE.md` only | skip both, print a hint | skip both, print a one-line hint pointing to UPGRADE.md's manual move |
   | both | skip | skip |

   - **Never edit:** an existing user file is never edited or overwritten.
   - **Unchanged:** `CLAUDE_MD_PREEXISTED` (which gates `config migrate`) keeps its meaning.
   - **`scripts/test-install-harness.sh`** covers each row. The existing upgrade/migrate cases still pass.
4. **Conventions lint.** `scripts/lint-claude-md.sh` (same file name and CI job, still advisory) behaves like this:
   - **With no argument:** checks `AGENTS.md` and `CLAUDE.md` in the current directory against the 150-line budget, one `✓`/`⚠` line per file present. For `AGENTS.md` only, it also warns when the file exceeds 32 KiB (32,768 bytes), Codex's default `project_doc_max_bytes`.
   - **Missing files:** exits 2 only when neither file exists. A missing `AGENTS.md` alongside a `CLAUDE.md` is fine, because that is the fallback case.
   - **With a path:** checks that one file, as today (the 32 KiB rule applies if it is named `AGENTS.md`).
   - **Tests:** `scripts/test-lint-claude-md.sh` keeps every existing case. It adds both files present; only `CLAUDE.md`; only `AGENTS.md`; neither (exit 2); and `AGENTS.md` over 32 KiB.
   - **CI:** the `ci.yml` comment names both files.
5. **Docs:**
   - **`docs/maintaining-claude-md.md`:** describes the split (`AGENTS.md` = conventions, `CLAUDE.md` = `@AGENTS.md` + Claude specifics), the fallback, and the two budgets.
   - **`INSTALL.md`:** the tree listing, post-install step 1 and troubleshooting name both files.
   - **`UPGRADE.md`:** a new "Moving conventions to AGENTS.md (#171)" section with the manual move: create `AGENTS.md` from your `CLAUDE.md` conventions, replace them in `CLAUDE.md` with `@AGENTS.md`, and keep Claude-only notes in `CLAUDE.md`. It also states that nothing breaks if you don't move, because of the fallback.
   - **`docs/rad-tool-portability.md`:** part 3 is marked delivered.
6. **Suites stay green:**
   - `npm test --prefix harness`;
   - `node --test harness/evals/*.eval.js`;
   - every `scripts/test-*.sh` under both shells;
   - `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`, `scripts/lint-agent-files.sh`, `scripts/lint-claude-md.sh`;
   - `node harness/cli.js generate --check`;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

No mapper agents were used. Anchors were found by grep and read directly on main at `2d8ab26`:
- every `CLAUDE.md` reference in shipped prose, scripts and harness;
- `install.sh` `scaffold_claude_md`;
- `lint-claude-md.sh` and its test;
- `draft-insights-plan.sh` `conventions_range`;
- the config.test.js live guard;
- the INSTALL and UPGRADE headings;
- the portability doc's part 3 rows.

There are no out-of-scope dependencies.

## Files in Scope

Generated outputs and unchanged bodies list only the region the executor must load (see the #188 precedent).

| File | Lines | Change |
|------|-------|--------|
| AGENTS.md | 1-140 | New: RAD's conventions |
| CLAUDE.md | 1-134 | Becomes `@AGENTS.md` + Claude Code specifics |
| harness/test/config.test.js | 185-200 | Live guard also covers AGENTS.md |
| scripts/lint-claude-md.sh | 1-60 | Two-file check + 32 KiB AGENTS.md warning |
| scripts/test-lint-claude-md.sh | 1-130 | New cases (existing kept) |
| .github/workflows/ci.yml | 92-100 | Comment names both files |
| scripts/draft-insights-plan.sh | 1-12, 88-100 | AGENTS.md → CLAUDE.md fallback |
| scripts/test-draft-insights-plan.sh | 200-260 | Fallback cases (append) |
| .rad/agents/quality-reviewer.md | 1-10, 28-36, 84-92, 183-190 | Fallback wording |
| .rad/agents/accessibility-reviewer.md | 1-12, 38-44, 122-128, 205-211 | Fallback wording |
| .rad/skills/quality-review/SKILL.md | 1-35 | Fallback wording |
| .rad/skills/accessibility-review/SKILL.md | 25-35 | Fallback wording |
| .claude/agents/quality-reviewer.md | 1-15 | Regenerated |
| .claude/agents/accessibility-reviewer.md | 1-15 | Regenerated |
| .claude/commands/team/quality-review.md | 1-10 | Regenerated |
| .claude/commands/team/accessibility-review.md | 1-10 | Regenerated |
| .codex/agents/quality-reviewer.toml | 1-10 | Regenerated |
| .codex/agents/accessibility-reviewer.toml | 1-10 | Regenerated |
| .agents/skills/quality-review/SKILL.md | 1-10 | Regenerated |
| .agents/skills/accessibility-review/SKILL.md | 1-10 | Regenerated |
| .claude/commands/team/rad-review.md | 28-36, 330-335 | Fallback wording |
| .claude/skills/kickoff/SKILL.md | 1-22, 115-120 | Fallback wording |
| .claude/commands/architect/rad-epic-decompose.md | 76-84, 198-205 | Fallback wording |
| .claude/commands/shared/rad-insights.md | 76-114, 482-488, 1133-1138 | Fallback wording; Cost & Frugality pointer |
| .rad/config.yml | 88-92, 118-128 | Scope-map `reads:` text |
| install.sh | 1-60, 300-325, 495-510 | `scaffold_conventions` + upgrade hint |
| scripts/test-install-harness.sh | 160-230, 440-540 | Scaffold matrix cases |
| docs/maintaining-claude-md.md | 1-107 | Split, fallback, budgets |
| INSTALL.md | 55-70, 245-275, 410-417 | Both files |
| UPGRADE.md | 280-335 | "Moving conventions to AGENTS.md" section |
| docs/rad-tool-portability.md | 15-25, 205-215 | Part 3 delivered |

## Execution Notes

### Do Not Touch
- `harness/config.js` `migrateFromClaudeMd` and `rad config migrate` (legacy pre-#87 path).
- `harness/generate.js`, `harness/generated-marker.js`, `harness/install-manifest.js`.
- `scripts/deliver-gate-hook.mjs`, `.claude/settings.json`.
- README, architect-guide, daily-workflow, apply-to-existing (follow-up).
- The 27 internal `.claude/agents/*` files.

### Key Files
- `CLAUDE.md`: the full current text, which is moved, not rewritten.
- `install.sh`: `scaffold_claude_md` (305-322) and where `main` calls it (~502); `CLAUDE_MD_PREEXISTED`.
- `scripts/test-install-harness.sh`: `run_install`, `new_repo`, `isolated`, the `assert_*` helpers, and the existing 4c-4g CLAUDE.md cases.
- `scripts/lint-claude-md.sh` and `scripts/test-lint-claude-md.sh`.
- `scripts/draft-insights-plan.sh` `conventions_range` and `FALLBACK_CONVENTIONS_LINES`.

### Reminders
- **Move text, don't rewrite it.** Rules keep their wording. Only "Claude" becomes "the agent" where a rule isn't Claude-specific.
- **Edit sources, then generate.** Change `.rad/` sources and run `node harness/cli.js generate`; never hand-edit generated files.
- **Never overwrite a user's file.** The scaffold copies only into absent paths.
- **Line-budget lints:** `lint-claude-md` must pass on the new files (`AGENTS.md` ≤ 150 lines).
- bash 3.2 compatible. No en dashes.

## Wave Plan

### Wave 1 — parallel
These tasks touch disjoint files.

#### Task 1.1: Split RAD's own conventions
File: AGENTS.md:1-140, CLAUDE.md:1-134, harness/test/config.test.js:185-200
What: Implement AC#1.
Validate: AC#1. Edge cases:
- every rule maps to exactly one file (mapping listed);
- `CLAUDE.md` has the `@AGENTS.md` line on its own line;
- both files carry no config block (test);
- `lint-claude-md.sh AGENTS.md` and `lint-claude-md.sh CLAUDE.md` both report within budget.

Command: `npm test --prefix harness`.

#### Task 1.2: Conventions lint
File: scripts/lint-claude-md.sh:1-60, scripts/test-lint-claude-md.sh:1-130, .github/workflows/ci.yml:92-100
What: Implement AC#4.
Validate: AC#4. Edge cases:
- both files present;
- `CLAUDE.md` only;
- `AGENTS.md` only;
- neither (exit 2);
- `AGENTS.md` at exactly 32,768 bytes (no warning) and at 32,769 bytes (warns);
- a path argument;
- every existing case passes unchanged.

Commands: every `scripts/test-*.sh` under both shells; `scripts/lint-shell-safety.sh`.

#### Task 1.3: draft-insights-plan fallback
File: scripts/draft-insights-plan.sh:1-12, 88-100, scripts/test-draft-insights-plan.sh:200-260
What: Implement the `draft-insights-plan.sh` part of AC#2.
Validate: AC#2. Edge cases:
- `AGENTS.md` only;
- `CLAUDE.md` only;
- both (`AGENTS.md` wins);
- neither (existing fallback lines);
- `AGENTS.md` without a `## Coding Conventions` section (falls back to the fallback lines, not to `CLAUDE.md`). Document this choice in a comment.

Commands: `bash scripts/test-draft-insights-plan.sh`, `/bin/bash scripts/test-draft-insights-plan.sh`, `scripts/lint-shell-safety.sh`.

### Wave 2 — parallel
These tasks touch disjoint files.

#### Task 2.1: Readers use the fallback
File: .rad/agents/quality-reviewer.md:1-10, 28-36, 84-92, 183-190, .rad/agents/accessibility-reviewer.md:1-12, 38-44, 122-128, 205-211, .rad/skills/quality-review/SKILL.md:1-35, .rad/skills/accessibility-review/SKILL.md:25-35, .claude/agents/quality-reviewer.md:1-15, .claude/agents/accessibility-reviewer.md:1-15, .claude/commands/team/quality-review.md:1-10, .claude/commands/team/accessibility-review.md:1-10, .codex/agents/quality-reviewer.toml:1-10, .codex/agents/accessibility-reviewer.toml:1-10, .agents/skills/quality-review/SKILL.md:1-10, .agents/skills/accessibility-review/SKILL.md:1-10, .claude/commands/team/rad-review.md:28-36, 330-335, .claude/skills/kickoff/SKILL.md:1-22, 115-120, .claude/commands/architect/rad-epic-decompose.md:76-84, 198-205, .claude/commands/shared/rad-insights.md:76-114, 482-488, 1133-1138, .rad/config.yml:88-92, 118-128
What: Implement the prose part of AC#2. Edit sources, run `rad generate`, then edit the hand-written readers and the config `reads:` text.
Validate: AC#2. Edge cases:
- a grep for `CLAUDE.md` in shipped prose leaves only the fallback phrase or a legitimate Claude-specific mention (list the remaining hits in the WAVE_RESULT);
- `generate --check` is clean;
- `lint-agent-files.sh` passes;
- `rad config validate` passes.

Commands:
- `npm test --prefix harness`;
- every `scripts/test-*.sh` under both shells;
- `node harness/cli.js generate --check`;
- `scripts/lint-agent-files.sh`;
- `node harness/cli.js config validate`.

#### Task 2.2: Install scaffold
File: install.sh:1-60, 300-325, 495-510, scripts/test-install-harness.sh:160-230, 440-540
What: Implement AC#3.
Validate: AC#3. Edge cases:
- each row of the scaffold table, for both fresh install and upgrade;
- an existing file stays byte-identical;
- the upgrade hint appears only for the `CLAUDE.md`-only case;
- the existing 4c-4g cases pass;
- the fresh-install slice assertions (section 7) still pass.

Commands: every `scripts/test-*.sh` under both shells; `scripts/lint-shell-safety.sh`; `bash scripts/test-bash32-parse.sh`.

### Wave 3 — sequential
This wave documents the shipped behaviour.

#### Task 3.1: Docs
File: docs/maintaining-claude-md.md:1-107, INSTALL.md:55-70, 245-275, 410-417, UPGRADE.md:280-335, docs/rad-tool-portability.md:15-25, 205-215
What: Implement AC#5.
Validate: AC#5, AC#6. Run the full suite list in AC#6. There is no testable surface beyond it.

## Program Design

### Signatures
- `install.sh`: `scaffold_conventions()` replaces `scaffold_claude_md()`. `CLAUDE_MD_PREEXISTED` is still set before it runs.
- `scripts/draft-insights-plan.sh`: `conventions_file()` prints `AGENTS.md`, `CLAUDE.md`, or nothing. `conventions_range` reads that file.
- `scripts/lint-claude-md.sh`: `check_file <path>` (lines, plus bytes for `AGENTS.md`). The no-argument mode loops over the files that are present.

### Call stack
```
install.sh main → … → scaffold_conventions → (copy AGENTS.md / CLAUDE.md templates into absent paths) → hint
reader prose → AGENTS.md if present else CLAUDE.md
draft-insights-plan.sh → conventions_file → conventions_range → plan text names the file
CI claude-md-budget → scripts/lint-claude-md.sh (AGENTS.md + CLAUDE.md)
```

### File tree
```
AGENTS.md   (new)
CLAUDE.md   (now: @AGENTS.md + Claude Code specifics)
```

## Tests to Write
- [ ] AGENTS.md carries no config (live guard) — harness/test/config.test.js
- [ ] two-file conventions lint + 32 KiB warning — scripts/test-lint-claude-md.sh
- [ ] conventions file fallback — scripts/test-draft-insights-plan.sh
- [ ] scaffold matrix (fresh + upgrade) — scripts/test-install-harness.sh

## Non-Goals
- Automatically moving a user's `CLAUDE.md` into `AGENTS.md`.
- Changing `config migrate` or the pre-#87 migration.
- Updating README, architect-guide, daily-workflow and apply-to-existing (listed as a follow-up in the PR).
- Shipping the deliver-gate hook (#186).

## Out-of-Scope Dependencies
None.

## Risks
- **Prose drift.** A reader still citing only `CLAUDE.md` would miss the conventions in a moved project. The Wave 2 grep lists every remaining hit.
- **Claude Code `@` import behaviour.** The import is expanded only at session start, which is exactly why direct readers move to `AGENTS.md`.
- **The scaffold order relative to `config migrate`.** `CLAUDE_MD_PREEXISTED` must still be computed from the user's original `CLAUDE.md` before the scaffold copies the stub. The existing 4d/4g cases guard this.

## Issue Gaps
- **Assumption:** `AGENTS.md` without a `## Coding Conventions` section does not fall back to `CLAUDE.md` in `draft-insights-plan.sh`. Once `AGENTS.md` exists it is the conventions file.
- **Assumption:** "What Claude Must Never Do" becomes "What the Agent Must Never Do" in `AGENTS.md`, and the Claude-only hook detail moves to `CLAUDE.md`'s specifics section.
- **Assumption:** `scripts/lint-claude-md.sh` keeps its name and CI job name so existing references hold. Its scope grows to both files.
- **Assumption:** the four broader docs (README, architect-guide, daily-workflow, apply-to-existing) are follow-ups, because they describe CLAUDE.md generically and still read correctly under the fallback.
