# RAD Tool Portability

RAD's assistant surface (commands, skills, reviewer agents, project
conventions) was written for Claude Code. This doc maps that surface to
Codex CLI, defines the single-source format that `rad generate` turns into
both assistants' files, and records which part of #171 (or the parity
follow-up #186) brings each piece across.

Status as of 2026-10-06: parts 1 and 2 are delivered. Part 1 brought this
doc, the generator, the `generated-drift` CI job and self-protected Codex
paths; part 2 migrated the read-only slice into `.rad/` sources. Rows marked
`generated` have a `.rad/` source and marked outputs; every other row is still
`claude-only` in practice, and the status column says where it is headed.

---

## The plan in three parts

| Part | Delivers | Tracking |
|------|----------|----------|
| 1 | This doc; `harness/generate.js`; `rad generate [--check]`; CI `generated-drift`; `^\.codex/` and `^\.agents/skills/` self-protected | #171 |
| 2 | Read-only slice migrated into `.rad/`: both reviewers, `quality-review`, `accessibility-review`, `rad-status`, a Codex-only `rad-review` (deterministic scripts plus reviewer sub-agents). Generated outputs and reviewers shipped through core, invariant added. Delivered | #171 |
| 3 | `AGENTS.md` as the conventions source, `CLAUDE.md` importing it with `@AGENTS.md`; readers use `AGENTS.md` with a `CLAUDE.md` fallback; install scaffold and `lint-claude-md` cover both files (`config migrate` unchanged). Delivered | #171 |
| Parity | State-changing workflow for Codex (plan, adopt, approve, deliver, design, research, epic-decompose, insights, kickoff/wrap); the deliver-gate hook shipping gap. Plan, adopt, approve and deliver generated (deliver in part 3d: one shared skill that runs `rad deliver`); research and epic-decompose in part 3e; design in part 3f; kickoff and wrap in part 4-i (wrap publishes notes through `rad wrap`); insights in part 4-ii — part 4 done | #186 |

---

## Portability matrix

Columns:

- **Claude path**: today's hand-written file.
- **Codex path**: where the generated Codex output will land.
- **Source**: the `.rad/` file that will own both outputs.
- **Body**: `as-is` means one body serves both assistants (only `{{args}}`
  differs); `wrapper` means a per-assistant override body (`claude.md` /
  `codex.md`) is needed; `n/a` means there is no shared body because the
  source generates only one assistant's output.
- **Deps**: external dependencies that do not port verbatim. `sub-agent` =
  dispatches a Claude sub-agent (Task/Agent tool); `$ARGUMENTS` = free-text
  args (written `{{args}}` in the source, the only substituted token); `$1/$2`
  = awk field references in the wrap and insights bodies, not positional
  arguments, so they port verbatim; `gh` = platform CLI; `MCP` = MCP tools.
- **State**: `yes` when the tool cuts branches, commits, records approval or
  runs waves; `artifact` when it writes files under `.agents/` but never
  commits.

### Commands

| Tool | Claude path | Codex path | Source | Body | Deps | State | Status |
|------|-------------|------------|--------|------|------|-------|--------|
| rad-approve | `.claude/commands/architect/rad-approve.md` | `.agents/skills/rad-approve/SKILL.md` (+ `agents/openai.yaml`, `codex_implicit: false`) | `.rad/skills/rad-approve/SKILL.md` | as-is | `$ARGUMENTS` | yes | generated (#186 part 2d) |
| rad-design | `.claude/commands/architect/rad-design.md` | `.agents/skills/rad-design/SKILL.md` (+ `agents/openai.yaml`, `codex_implicit: false`) | `.rad/skills/rad-design/SKILL.md` | as-is | rad CLI, `$ARGUMENTS` | yes | generated (#186 part 3f) |
| rad-epic-decompose | `.claude/commands/architect/rad-epic-decompose.md` | `.agents/skills/rad-epic-decompose/SKILL.md` (+ `agents/openai.yaml`, `codex_implicit: false`) | `.rad/skills/rad-epic-decompose/SKILL.md` | as-is | rad CLI, `$ARGUMENTS`, `gh` | artifact | generated (#186 part 3e) |
| rad-insights | `.claude/commands/shared/rad-insights.md` | `.agents/skills/rad-insights/SKILL.md` (+ `agents/openai.yaml`, `codex_implicit: false`) | `.rad/skills/rad-insights/SKILL.md` | as-is | `{{args}}` | yes (`--draft-plans` only) | generated (#186 part 4-ii) |
| rad-status | `.claude/commands/shared/rad-status.md` | `.agents/skills/rad-status/SKILL.md` | `.rad/skills/rad-status/SKILL.md` | as-is | none | no | generated (#171 part 2) |
| rad-plan | `.claude/commands/team/rad-plan.md` | `.agents/skills/rad-plan/SKILL.md` | `.rad/skills/rad-plan/SKILL.md` | as-is | sub-agent (optional), `$ARGUMENTS` | yes | generated (#186 part 2c) |
| rad-adopt | `.claude/commands/team/rad-adopt.md` | `.agents/skills/rad-adopt/SKILL.md` | `.rad/skills/rad-adopt/SKILL.md` | as-is | `$ARGUMENTS`, `gh` | yes | generated (#186 part 2c) |
| rad-deliver | `.claude/commands/team/rad-deliver.md` | `.agents/skills/rad-deliver/SKILL.md` (+ `agents/openai.yaml`, `codex_implicit: false`) | `.rad/skills/rad-deliver/SKILL.md` | as-is | rad CLI, `$ARGUMENTS` | yes | generated (#186 part 3d) |
| rad-research | `.claude/commands/team/rad-research.md` | `.agents/skills/rad-research/SKILL.md` | `.rad/skills/rad-research/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | artifact | generated (#186 part 3e) |
| rad-review | `.claude/commands/team/rad-review.md` (hand-written, not generated) | `.agents/skills/rad-review/SKILL.md` | `.rad/skills/rad-review/SKILL.md` (Codex-only, `claude: none`) | n/a (Codex only) | sub-agent, `$ARGUMENTS` | Claude: artifact (`.agents/findings.jsonl`); Codex: no | Codex generated (#171 part 2); Claude hand-written |
| quality-review | `.claude/commands/team/quality-review.md` | `.agents/skills/quality-review/SKILL.md` | `.rad/skills/quality-review/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | no | generated (#171 part 2) |
| accessibility-review | `.claude/commands/team/accessibility-review.md` | `.agents/skills/accessibility-review/SKILL.md` | `.rad/skills/accessibility-review/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | no | generated (#171 part 2) |

### Skills

| Tool | Claude path | Codex path | Source | Body | Deps | State | Status |
|------|-------------|------------|--------|------|------|-------|--------|
| kickoff | `.claude/skills/kickoff/SKILL.md` | `.agents/skills/kickoff/SKILL.md` | `.rad/skills/kickoff/SKILL.md` | as-is | rad CLI, `gh` (optional) | no | generated (#186 part 4-i) |
| wrap | `.claude/skills/wrap/SKILL.md` | `.agents/skills/wrap/SKILL.md` (+ `agents/openai.yaml`, `codex_implicit: false`) | `.rad/skills/wrap/SKILL.md` | as-is | rad CLI | yes | generated (#186 part 4-i) |

### Agents

| Tool | Claude path | Codex path | Source | Body | Deps | State | Status |
|------|-------------|------------|--------|------|------|-------|--------|
| quality-reviewer | `.claude/agents/quality-reviewer.md` | `.codex/agents/quality-reviewer.toml` | `.rad/agents/quality-reviewer.md` | as-is | none (tools: Read, Bash) | no | generated (#171 part 2) |
| accessibility-reviewer | `.claude/agents/accessibility-reviewer.md` | `.codex/agents/accessibility-reviewer.toml` | `.rad/agents/accessibility-reviewer.md` | as-is | none (tools: Read, Bash) | no | generated (#171 part 2) |
| 27 orchestrator and mapper agents | `.claude/agents/*-orchestrator.md`, `*-mapper.md` | `.codex/agents/*-orchestrator.toml`, `*-mapper.toml` | `.rad/agents-internal/<name>.md` | as-is | none (tools: Task, or Read, Grep, Glob) | no | generated (#186 part 3f-ii), internal: .rad/agents-internal, not shipped |

### Why the borderline rows landed where they did

- **rad-review in part 2**: the Claude command stays hand-written and
  unmarked. The Codex skill comes from a Codex-only source (`claude: none`):
  it runs `scripts/check-scope.sh`, `scripts/lint-plan.sh`,
  `scripts/check-approval-blockers.sh` and `scripts/check-tests-present.sh`,
  then spawns the `quality-reviewer` sub-agent (and `accessibility-reviewer`
  when UI files changed). It does not call `rad review`, never writes
  `.agents/findings.jsonl`, and never commits or pushes, so it belongs with
  the read-only slice. Findings recording can follow with #186.
- **rad-insights in #186 part 4-ii**: reading is its main job, but
  `--draft-plans` cuts a `rad/insights-proposals-<date>` branch and commits a
  plan, so it ports with the state-changing workflow (explicit-only on Codex).
  One shared body serves both tools. Its `$1/$2` are awk fields, not
  positional args.
- **kickoff and wrap in part 4-i**: kickoff is read-only, but it is the
  session pair of `wrap` (state-changing), so they shipped together and a
  Codex user never gets half the ritual. One shared body serves both: wrap
  appends its progress note, then publishes it with `rad wrap`, which commits
  and pushes the plan and execution log by explicit path, never labels, and
  never changes plan status (that comes from `rad deliver`). Kickoff's
  checkout advice is `rad checkout`.
- **rad-research and rad-epic-decompose in #186**: they never commit, but
  their artifacts feed `/rad-design` and `/rad-plan`, and `rad-research`
  dispatches sub-agents. They ported with the workflow they feed (part 3e):
  sub-agent dispatch uses the tool-neutral phrasing from rad-plan, and
  rad-epic-decompose labels issues through `rad label` instead of calling
  `rad-label.sh` directly.

---

## Source format

All sources live under `.rad/`, which is already self-protected
(`^\.rad/` in `scripts/lib/plan-paths.sh`), so any plan editing a source
gets architect review.

### Skills: `.rad/skills/<name>/SKILL.md`

```yaml
---
name: rad-deliver                # kebab-case, equals the directory name
description: Execute an approved plan ...
targets:
  claude: command:team/rad-deliver   # or: skill
  codex: skill                       # or: none
  codex_implicit: false              # optional
---
Body, written once. {{args}} marks where the user's text goes.
```

- `{{args}}` becomes `$ARGUMENTS` for Claude and the phrase `the text the
  user wrote after the skill name` for Codex. Any other `{{...}}` token is a
  source error.
- `claude.md` and `codex.md` next to `SKILL.md` are optional override bodies
  for one target. Any other file in the directory is an error.
- Unknown frontmatter keys and unknown target values are errors.

### Agents: `.rad/agents/<name>.md` and `.rad/agents-internal/<name>.md`

`.rad/agents/` holds shipped agents; `.rad/agents-internal/` holds this repo's
own agents (produced by `/rad-design` for RAD's features). Both use the same
format and are read by `rad generate`; a name may appear in only one. Generated
files from internal sources are marked with their `.rad/agents-internal/`
source, so `harness/install-manifest.js` never ships them.

Claude agent frontmatter (`name`, `description`, `model`, `tools`, optional
`roles`, optional `purpose`) plus an optional `codex:` mapping with
`codex.sandbox_mode` (`read-only` | `workspace-write`). `purpose` is
type-checked by `rad generate`; `scripts/lint-agent-files.sh` owns its values. The body may not contain `'''`, a
control character other than tab and LF, or any `{{...}}` token.

---

## Output mapping

| Source | Target | Output |
|--------|--------|--------|
| skill, `claude: command:<subdir>/<file>` | Claude | `.claude/commands/<subdir>/<file>.md` |
| skill, `claude: skill` | Claude | `.claude/skills/<name>/SKILL.md` |
| skill, `codex: skill` | Codex | `.agents/skills/<name>/SKILL.md` (frontmatter `name`, `description`) |
| skill, `codex_implicit: false` | Codex | `.agents/skills/<name>/agents/openai.yaml` with `policy.allow_implicit_invocation: false` |
| agent (`.rad/agents` or `.rad/agents-internal`) | Claude | `.claude/agents/<name>.md`: frontmatter minus `codex:`, plus the body |
| agent | Codex | `.codex/agents/<name>.toml`: `name`, `description`, `developer_instructions` as a `'''...'''` literal, `sandbox_mode` when given. `model` is never written: Claude model ids mean nothing to Codex, and the parent session's model is inherited |

Every output carries a marker naming its source: an HTML comment right
after the frontmatter for `.md`
(`<!-- generated by rad generate; edit the source, not this file (source: ...) -->`),
and a first-line `# generated by rad generate; ...` comment for `.toml` and
`.yaml`.

`rad generate` writes outputs and prints `wrote` / `unchanged` / `orphan`
lines (orphans are reported, never deleted). `rad generate --check` writes
nothing and exits 1 on any `drift` or `orphan`; CI runs it as the
`generated-drift` job. A file at an output path without the marker, or a
symlink there, is a conflict: exit 2, nothing written. That rule protects
today's hand-written `.claude/` files; part 2 deletes each hand-written file
in the same commit that adds its source. Implementation:
`harness/generate.js` (pure) and `generateCommand` in `harness/cli.js`.

---

## Why no symlinks

The obvious shortcut (symlink `.agents/skills/x` to `.claude/skills/x`) is
ruled out:

- **#168**: invoking `harness/cli.js` through a symlinked path made the
  main-module guard fail open on the approval gate. Symlinks in the gate's
  path are a proven failure mode in this repo.
- **Self-protected pattern**: `RAD_SELF_PROTECTED_PATTERN` matches on path
  strings. A symlink lets a plan edit `.claude/` content through a path the
  pattern never sees.
- **`check-scope.sh`**: scope checks compare diff paths. A change through a
  link shows up under one path while the effect lands under another.
- **Windows**: symlinks need developer mode or admin rights and are often
  checked out as plain text files, so the Codex copy would silently be a
  one-line path string.

Generated files are ordinary files in the diff, reviewable and checked for
drift. The generator itself never creates or follows a symlink (lstat).

---

## Gate parity

The deliver gate is the harness approval check for both tools:
`node harness/cli.js deliver` refuses without an `approved` event in
`.agents/state/<feature>/events.jsonl`. The shared `rad-deliver` skill
(`.rad/skills/rad-deliver/SKILL.md`, generated as the Claude
`/team:rad-deliver` command and the Codex `$rad-deliver` skill) only runs that
command, so the same gate applies whichever tool invokes it. Claude adds an
extra layer: the `PreToolUse` hook `scripts/deliver-gate-hook.mjs`, which
blocks an unapproved `team:rad-deliver` Skill call before the skill runs.

Codex hooks have the same shape as Claude's, but there is no matcher for
skill calls, and Codex documents hooks as "a guardrail, not a complete
enforcement boundary". So:

- Codex wrappers for state-changing steps only call `rad` commands. They
  never orchestrate waves or record approvals in prose.
- The Codex deliver skill runs `node harness/cli.js deliver`, which checks
  approval itself, and sets `codex_implicit: false` so Codex never invokes
  it implicitly.
- The missing hook layer is recorded as the guarded bypass
  `codex-no-skill-hook` under `unapproved-deliver-cannot-run` in
  `docs/invariants.yaml` (#186 part 3d).

---

## AGENTS.md and `@AGENTS.md` (part 3)

Codex reads `AGENTS.md`. Claude Code reads `AGENTS.md` natively only when
there is no `CLAUDE.md`; otherwise `CLAUDE.md` must import it with
`@AGENTS.md`, which Anthropic recommends over a symlink. Part 3 (delivered)
makes `AGENTS.md` the conventions source and has `CLAUDE.md` import it, with
Claude-specific material staying in `CLAUDE.md`.

The import is expanded only when Claude Code loads `CLAUDE.md` at session
start, so RAD's direct readers (reviewers, skills, commands,
`scripts/draft-insights-plan.sh`) read `AGENTS.md`, or `CLAUDE.md` when the
project has no `AGENTS.md`. Installs and upgrades never move an existing
`CLAUDE.md`; `UPGRADE.md` "Moving conventions to AGENTS.md (#171)" documents
the manual move. `scripts/lint-claude-md.sh` checks both files against the
150-line budget and warns when `AGENTS.md` exceeds Codex's 32 KiB
`project_doc_max_bytes`. See `docs/maintaining-claude-md.md`.

---

## Shipping gaps found

| Gap | Effect | Fixed by |
|-----|--------|----------|
| `quality-reviewer` and `accessibility-reviewer` are not shipped by core (`.claude/agents/` is user data in `harness/install-manifest.js`), yet `rad review` loads `.claude/agents/<reviewer>.md` | `rad review` fails in an installed project that never ran `/rad-design` | Fixed in part 2: core ships the `.rad/agents` and `.rad/skills` sources and every marked file under `.claude/agents`, `.agents/skills` and `.codex/agents` |
| `scripts/deliver-gate-hook.mjs` and its `.claude/settings.json` registration are not shipped | Installed projects get the harness check but not the hook layer | Fixed in #186 part 1: core ships `scripts/*.mjs`, and install merges the registration via `rad install-hooks` |
| `scripts/lint-agent-files.sh:15-17` says reviewers have no `roles:`, but they do | Misleading comment only | Fixed in part 2 (comment corrected with the reviewer migration) |

---

## Sources

Captured 2026-10-06. `developers.openai.com/codex` now redirects to
`learn.chatgpt.com/docs`; the URLs below are the post-redirect ones.

- Codex skills: discovered from `.agents/skills/`, Agent Skills standard,
  `$name` or implicit invocation, `agents/openai.yaml`
  `policy.allow_implicit_invocation`:
  https://learn.chatgpt.com/docs/build-skills
- Agent Skills standard (shared by Claude Code and Codex):
  https://agentskills.io
- Codex custom prompts (deprecated in favour of skills):
  https://learn.chatgpt.com/docs/custom-prompts.md
- Codex sub-agents (`.codex/agents/*.toml`: `name`, `description`,
  `developer_instructions`, `sandbox_mode`; no tool allow-list):
  https://learn.chatgpt.com/docs/agent-configuration/subagents.md
- Codex hooks (no skill matcher; "guardrail, not a complete enforcement
  boundary"): https://learn.chatgpt.com/docs/hooks.md
- Codex `AGENTS.md` discovery:
  https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Claude Code and `AGENTS.md` (`@AGENTS.md` import; recommended over a
  symlink): https://code.claude.com/docs/en/memory#agents-md
