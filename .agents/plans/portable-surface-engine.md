# Plan: Portability Matrix and Wrapper Generator (#171 part 1)
Created: 2026-10-06
Author: architect
Status: pending-review
Branch: rad/portable-surface-engine
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/171
Issue-Title: Assistant-portable skill surface: one source, generated Claude + Codex wrappers (no symlinks)

## Context

Everything RAD exposes to an assistant works only in Claude Code today:
- 12 `.claude/commands/**` files;
- 2 `.claude/skills/`;
- 30 `.claude/agents/`, of which only `quality-reviewer` and `accessibility-reviewer` are reusable (the other 28 are internal orchestrators and mappers);
- `CLAUDE.md`.

The deliver gate is a Claude-only `PreToolUse` hook on the `Skill` tool (`scripts/deliver-gate-hook.mjs`). There is no generator anywhere in the repo yet. The closest pattern is `/rad-design` (writes agent files in prose) plus `lint-agent-files.sh` (a read-only check).

What research found about Codex CLI (2026-10-06; sources go in the portability doc):
- **Skills** use the same open Agent Skills standard as Claude Code. They are discovered from `.agents/skills/<name>/SKILL.md`, not `.codex/skills`. Frontmatter is `name` and `description`. They are invoked as `$name` or implicitly. `agents/openai.yaml` can set `policy.allow_implicit_invocation: false`.
- **Custom prompts are deprecated** in favour of skills.
- **Sub-agents** are `.codex/agents/<name>.toml` files with `name`, `description`, `developer_instructions`, and optional `model` and `sandbox_mode`. There is no tool allow-list.
- **Hooks** have the same shape as Claude's, but there is no matcher for skill calls.
- **AGENTS.md:** Codex reads it. Claude Code reads it only through `@AGENTS.md` when a CLAUDE.md exists.

**Gaps in RAD found on the way:**
- The reviewer agents are not shipped by core (`.claude/agents/` is user data), yet `rad review` loads them.
- The gate hook and `.claude/settings.json` are not shipped.
- `lint-agent-files.sh:15-17` says reviewers have no `roles:`, but they do.

Decisions (2026-10-06, recorded on #171):
- **Source:** `.rad/skills/` and `.rad/agents/`, already self-protected by `^\.rad/`.
- **Conventions:** `AGENTS.md` becomes the conventions source, and `CLAUDE.md` imports it with `@AGENTS.md`.
- **First delivery:** the doc plus the read-only slice. State-changing parity is a follow-up issue.
- **Codex deliver gate:** the Codex deliver skill only calls `rad deliver`, which checks approval itself. It never orchestrates waves in prose.

This is a large issue, split into three plans:
- **Part 1 (this plan):**
  - `docs/rad-tool-portability.md`: the matrix and the design.
  - The generator and its drift check (`rad generate [--check]`), tested on fixture sources.
  - The self-protected pattern extended to the generated Codex paths.
- **Part 2:** migrate the read-only slice into `.rad/` (both reviewers, quality-review, accessibility-review, rad-status, and a Codex `rad-review` wrapper over `rad review`). Generate the outputs, ship them and the reviewers through core, and add invariants.
- **Part 3:** `AGENTS.md` as the conventions source, with `CLAUDE.md` importing it (install scaffold, `config migrate`, `lint-claude-md`).

State-changing parity (plan, approve, deliver for Codex) is filed as a follow-up issue during this plan.

## Scope

| In scope | Out of scope |
|---|---|
| `docs/rad-tool-portability.md` (matrix + design) | Migrating any real command, skill or agent into `.rad/` (part 2) |
| `harness/generate.js`: source → Claude/Codex outputs, pure + tested | AGENTS.md / CLAUDE.md changes (part 3) |
| `rad generate [--check]` CLI + CI `generated-drift` job | Shipping outputs or reviewers through core (part 2) |
| Self-protected pattern covers `.codex/` and `.agents/skills/` | Codex hooks / `.codex/config.toml` / rules |
| Filing the state-changing parity follow-up issue | Any change to the Claude deliver gate |

## Acceptance Criteria

1. **`docs/rad-tool-portability.md`** (about 200 to 300 lines).
   - **The matrix:** one row per command, skill and reusable agent in RAD's surface. Columns:
     - tool;
     - Claude path;
     - Codex path;
     - shared source path;
     - generated as-is or per-assistant wrapper;
     - external dependencies (sub-agent dispatch, `$ARGUMENTS`/positional args, MCP);
     - state-changing yes/no;
     - status (`claude-only` / `planned: part 2` / `planned: parity issue #N`).
   - **The design sections:**
     - the source format (AC#2);
     - how each output is mapped;
     - why there are no symlinks (#168, the self-protected pattern, `check-scope` paths, Windows);
     - gate parity: Codex wrappers for state-changing steps only call `rad` commands, never prose orchestration;
     - the AGENTS.md / `@AGENTS.md` decision (part 3);
     - the shipping gaps found (reviewers, gate hook), and which part fixes each.
   - **Sources:** Codex and Claude Code documentation is cited with URLs and a captured date.
2. **Source format and generator** (`harness/generate.js`, pure functions plus a thin fs layer).
   - **Skill sources:** `.rad/skills/<name>/SKILL.md` has frontmatter `name` (kebab-case, equal to the directory name), `description`, and a `targets:` mapping:
     - `claude:` either `command:<subdir>/<file>` (emits `.claude/commands/<subdir>/<file>.md`) or `skill` (emits `.claude/skills/<name>/SKILL.md`);
     - `codex:` either `skill` (emits `.agents/skills/<name>/SKILL.md`) or `none`;
     - optional `codex_implicit: false` (emits `.agents/skills/<name>/agents/openai.yaml` with `policy.allow_implicit_invocation: false`).
   - **Skill bodies:** written once.
     - The token `{{args}}` becomes `$ARGUMENTS` for Claude, and for Codex becomes the literal phrase `the text the user wrote after the skill name`.
     - Per-assistant override bodies are optional: `claude.md` and `codex.md` next to `SKILL.md` replace the body for that target only.
     - Any other `{{…}}` token is an error.
   - **Agent sources:** `.rad/agents/<name>.md` has Claude agent frontmatter (`name`, `description`, `model`, `tools`, optional `roles`) plus an optional `codex:` mapping (`sandbox_mode`: `read-only` | `workspace-write`). They emit:
     - `.claude/agents/<name>.md`: the frontmatter minus `codex:`, plus the body.
     - `.codex/agents/<name>.toml`: `name`, `description`, and `developer_instructions` (the body, as a TOML multi-line literal string). `sandbox_mode` is written when given. `model` is never emitted, because Claude model ids aren't valid for Codex and the parent session's model is inherited.
   - **Generated marker:** every generated file carries a marker naming its source and saying `generated by rad generate; edit the source, not this file`. The marker is an HTML comment right after the frontmatter for `.md`, and a leading `#` comment for `.toml` and `.yaml`.
   - **Output and errors:** output is deterministic (sorted, stable formatting, trailing newline). Source errors are returned with the offending path and never throw:
     - a missing `name` or `description`;
     - a name that doesn't match its file or directory;
     - an unknown target;
     - an unknown `{{token}}`;
     - a body containing `]]]` that can't be put in a TOML literal;
     - two sources that emit the same path.
3. **`rad generate [--check] [--root <dir>]`** (`harness/cli.js`).
   - **Default mode:** writes every output for the sources under `<root>/.rad/` (root defaults to the repo root), creating parent directories, and prints `wrote <path>` / `unchanged <path>`.
   - **`--check`:** writes nothing. It prints `drift <path>` for every output that differs from the generated content or is missing, plus `orphan <path>` for a file that carries the generated marker but no longer has a source.
   - **Exit codes:**
     - 0: clean or written;
     - 1: drift or orphans in `--check`;
     - 2: a source error, bad argv, or no `.rad/` directory.
   - **Never touches unmarked files:** a file at an output path without the marker is a conflict (exit 2, named), never overwritten. That protects today's hand-written `.claude/` files until part 2 migrates them.
   - **Registration:** added to the command registry and usage.
4. **CI:**
   - **Job:** a `generated-drift` job in `.github/workflows/ci.yml` (thin wrapper, setup-node 20) runs `node harness/cli.js generate --check`. With no sources yet, the run exits 0.
   - **Self-protected paths:** `RAD_SELF_PROTECTED_PATTERN` (`scripts/lib/plan-paths.sh`) gains `^\.codex/` and `^\.agents/skills/`, so plans touching generated Codex outputs get architect review like `.claude/`. `scripts/test-plan-paths.sh` covers both new prefixes, and also checks that `.agents/plans/x.md` is not protected.
5. **Follow-up issue:** state-changing parity (plan, approve, deliver, adopt, research, design, wrap for Codex) is filed with `gh issue create` and linked from the doc's status column. Its body records the gate decision: Codex deliver only calls `rad deliver`, with `codex_implicit: false`.
6. **Suites stay green:**
   - `npm test --prefix harness`;
   - `node --test harness/evals/*.eval.js`;
   - every `scripts/test-*.sh` under both shells;
   - `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`, `scripts/lint-agent-files.sh`;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

Two research agents ran:
- **Explore (read-only):** mapped RAD's assistant-facing surface (commands, skills, agents, the gate hook, settings, `lint-agent-files`, the self-protected pattern, the invariants, existing generator patterns, CLAUDE.md and install).
- **General-purpose (web, read-only):** summarized Codex CLI's AGENTS.md, skills, prompts, sub-agents, hooks and config, and Claude Code's AGENTS.md support, with citations.

The anchors were spot-checked directly (`plan-paths.sh:104`, `check-scope.sh:77-82`, the `ci.yml` lint jobs). There are no out-of-scope dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| docs/rad-tool-portability.md | 1-300 | New: matrix + design |
| harness/generate.js | 1-340 | New: source parsing, output rendering, plan/apply/check |
| harness/test/generate.test.js | 1-360 | New: rendering, errors, determinism, check/orphan/conflict |
| harness/cli.js | 55-80 | `GENERATE_USAGE` |
| harness/cli.js | 115-155 | Registry entry `generate` |
| harness/cli.js | 3590-3680 | `generateCommand` (insert before `isMainModule`) |
| harness/test/cli.test.js | 2885-2980 | `rad generate` end-to-end (append) |
| .github/workflows/ci.yml | 84-100 | `generated-drift` job |
| scripts/lib/plan-paths.sh | 98-106 | Self-protected pattern adds `.codex/`, `.agents/skills/` |
| scripts/test-plan-paths.sh | 825-860 | New prefix cases (append) |

## Execution Notes

### Do Not Touch
- Any real file under `.claude/`, `CLAUDE.md`, `install.sh`, `harness/install-manifest.js` (part 2 / part 3).
- `scripts/deliver-gate-hook.mjs`, `.claude/settings.json`.
- `scripts/check-scope.sh` `ALWAYS_ALLOW_PREFIXES`. `.agents/skills/` must stay scope-checked.
- `scripts/lint-agent-files.sh`. Its roles-comment fix lands in part 2 with the reviewer migration.

### Key Files
- `harness/install-manifest.js`: deterministic walk and hashing helpers (reuse rather than re-implement).
- `harness/config.js`: lazy js-yaml import for frontmatter parsing.
- `harness/preset.js`: the reader-validation style (errors with paths, never throws).
- `scripts/lint-agent-files.sh`: frontmatter expectations that generated `.claude/agents` files must still satisfy.
- `scripts/lib/plan-paths.sh:98-115`: the self-protected constant and its "literal, never env-tunable" rule.

### Reminders
- **Generated output must be byte-stable.** Running `generate` twice changes nothing, and `--check` after `generate` is clean.
- **Never overwrite an unmarked file.** That is the conflict rule protecting hand-written files.
- **No symlinks:** never create or follow one in sources or outputs (lstat).
- **TOML is written by hand, not with a library.** Use a literal multi-line string for `developer_instructions`, escape-free by construction, with `]]]` rejected. Quote strings with JSON-compatible escapes for `name` and `description`.
- Node built-ins and the vendored js-yaml only. No en dashes.

## Wave Plan

### Wave 1 — parallel
These tasks touch disjoint files.

#### Task 1.1: Generator engine
File: harness/generate.js:1-340, harness/test/generate.test.js:1-360
What: Implement AC#2.
Validate: AC#2. Edge cases:
- **Skill sources:**
  - a skill emitting both a Claude command and a Codex skill;
  - a skill with `codex: none`;
  - a Claude `skill` target;
  - `{{args}}` substitution for each target;
  - `claude.md` / `codex.md` overrides;
  - `codex_implicit: false` emits `openai.yaml`.
- **Agent sources:**
  - an agent with and without `codex.sandbox_mode`;
  - TOML output parses back (write a minimal TOML reader in the test, or check the exact expected text);
  - `model` is never in the TOML.
- **Errors:**
  - a missing or mismatched name;
  - an unknown target;
  - an unknown token;
  - `]]]` in a body;
  - a duplicate output path;
  - a symlinked source.
- **Determinism:** two runs give identical output.

Command: `npm test --prefix harness`.

#### Task 1.2: Self-protected Codex paths
File: scripts/lib/plan-paths.sh:98-106, scripts/test-plan-paths.sh:825-860
What: Implement the `plan-paths.sh` part of AC#4.
Validate: AC#4. Edge cases:
- `.codex/agents/x.toml` is protected;
- `.agents/skills/x/SKILL.md` is protected;
- `.agents/plans/x.md`, `.agents/skillset/x` and `docs/.codex/x` are not;
- the existing self-protected cases are unchanged.

Commands: every `scripts/test-*.sh` under both shells; `scripts/lint-shell-safety.sh`.

### Wave 2 — sequential
This wave depends on the Wave 1 engine.

#### Task 2.1: rad generate and CI drift job
File: harness/cli.js:55-80, harness/cli.js:115-155, harness/cli.js:3590-3680, harness/test/cli.test.js:2885-2980, .github/workflows/ci.yml:84-100
What: Implement AC#3 and the CI part of AC#4.
Validate: AC#3, AC#4. Edge cases:
- `generate` writes outputs, and a second run reports every output as `unchanged`;
- `--check` after `generate` exits 0;
- a hand-edited output gives `drift` (exit 1);
- a deleted output gives `drift`;
- a marked output whose source was removed gives `orphan` (exit 1);
- an unmarked file at an output path is a conflict (exit 2, not overwritten);
- no `.rad/` gives exit 2;
- a source error gives exit 2 with the path;
- argv: an unknown flag, `--root` with no value;
- the real repo (no `.rad/skills` or `.rad/agents` yet) passes `--check` with exit 0.

Commands:
- `npm test --prefix harness`;
- `node --test harness/evals/*.eval.js`;
- `node harness/cli.js generate --check`.

### Wave 3 — sequential
This wave documents the engine and the surface, and files the follow-up.

#### Task 3.1: Portability doc and parity issue
File: docs/rad-tool-portability.md:1-300
What: Implement AC#1 and AC#5. File the follow-up issue first, so the doc can link its number.
Validate: AC#1, AC#5, AC#6. Every matrix row matches a real file (check with `ls`). There is no testable surface beyond the full suite list in AC#6.

## Program Design

### Signatures
- `harness/generate.js`:
  - `readSources(root) → { ok, sources } | { ok: false, errors }`;
  - `renderOutputs(sources) → { ok, outputs: [{ path, content, source }] } | { ok: false, errors }`;
  - `planGenerate(root, outputs) → { writes, unchanged, drift, orphans, conflicts }`;
  - `applyGenerate(root, plan)`;
  - `GENERATED_MARKER` (the marker text).
- `harness/cli.js`: `generateCommand(argv, ctx) → exit code`.

### Call stack
```
rad generate [--check] → readSources(.rad/) → renderOutputs → planGenerate(root)
   → conflicts? exit 2 : --check ? report drift/orphans (exit 0|1) : applyGenerate → report
CI generated-drift → node harness/cli.js generate --check
```

### File tree
```
harness/generate.js            (new)
harness/test/generate.test.js  (new)
docs/rad-tool-portability.md   (new)
```

## Tests to Write
- [ ] source parsing, rendering, errors, determinism — harness/test/generate.test.js
- [ ] rad generate write/check/drift/orphan/conflict/argv — harness/test/cli.test.js
- [ ] self-protected .codex/ and .agents/skills/ — scripts/test-plan-paths.sh

## Non-Goals
- Migrating any real RAD command, skill or agent (part 2).
- AGENTS.md / CLAUDE.md conventions (part 3).
- Codex hooks, `.codex/config.toml`, execpolicy rules.
- State-changing Codex parity (follow-up issue).
- Supporting assistants other than Claude Code and Codex.

## Out-of-Scope Dependencies
None.

## Risks
- **Codex conventions move fast.** Custom prompts were deprecated within months. The doc records a captured date, and the generator keeps Codex output rules in one place.
- **Self-protected widening.** Plans touching `.agents/skills/` or `.codex/` now get the architect-review advisory. That is intended and matches `.claude/`.
- **The CI drift job is a no-op until part 2 adds sources.** It is wired now so the first migrated source is gated from day one.

## Issue Gaps
- **Assumption:** Codex skills are generated to `.agents/skills/` (where Codex discovers them), not the `.codex/skills/` the issue names. Codex doesn't scan `.codex/skills`.
- **Assumption:** generated Codex agents never carry `model`, so they inherit the parent session's model. Claude model ids are meaningless to Codex.
- **Assumption:** `{{args}}` is the only body token. Positional `$1`/`$2` (used by `rad-insights` and `wrap`) need per-assistant override bodies.
- **Assumption:** an unmarked file at an output path is a hard conflict, never overwritten. Part 2 migrates by deleting the hand-written file in the same commit that adds its source.
- **Assumption:** the issue is delivered in three plans plus a parity follow-up issue. The issue itself listed "doc + read-only slice, then full parity later".
