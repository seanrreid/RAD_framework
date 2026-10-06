# RAD Tool Portability

RAD's assistant surface (commands, skills, reviewer agents, project
conventions) was written for Claude Code. This doc maps that surface to
Codex CLI, defines the single-source format that `rad generate` turns into
both assistants' files, and records which part of #171 (or the parity
follow-up #186) brings each piece across.

Status as of 2026-10-06: part 1 is delivered (this doc, the generator, the
`generated-drift` CI job, self-protected Codex paths). No real command, skill
or agent has a `.rad/` source yet, so every row below is still `claude-only`
in practice; the status column says where it is headed.

---

## The plan in three parts

| Part | Delivers | Tracking |
|------|----------|----------|
| 1 | This doc; `harness/generate.js`; `rad generate [--check]`; CI `generated-drift`; `^\.codex/` and `^\.agents/skills/` self-protected | #171 |
| 2 | Read-only slice migrated into `.rad/`: both reviewers, `quality-review`, `accessibility-review`, `rad-status`, a Codex `rad-review` wrapper over `rad review`. Generated outputs and reviewers shipped through core, invariants added | #171 |
| 3 | `AGENTS.md` as the conventions source, `CLAUDE.md` importing it with `@AGENTS.md` (install scaffold, `config migrate`, `lint-claude-md`) | #171 |
| Parity | State-changing workflow for Codex (plan, adopt, approve, deliver, design, research, epic-decompose, insights, kickoff/wrap); the deliver-gate hook shipping gap | #186 |

---

## Portability matrix

Columns:

- **Claude path**: today's hand-written file.
- **Codex path**: where the generated Codex output will land.
- **Source**: the `.rad/` file that will own both outputs.
- **Body**: `as-is` means one body serves both assistants (only `{{args}}`
  differs); `wrapper` means a per-assistant override body (`claude.md` /
  `codex.md`) is needed.
- **Deps**: external dependencies that do not port verbatim. `sub-agent` =
  dispatches a Claude sub-agent (Task/Agent tool); `$ARGUMENTS` = free-text
  args; `$1/$2` = positional args; `gh` = platform CLI; `MCP` = MCP tools.
- **State**: `yes` when the tool cuts branches, commits, records approval or
  runs waves; `artifact` when it writes files under `.agents/` but never
  commits.

### Commands

| Tool | Claude path | Codex path | Source | Body | Deps | State | Status |
|------|-------------|------------|--------|------|------|-------|--------|
| rad-approve | `.claude/commands/architect/rad-approve.md` | `.agents/skills/rad-approve/SKILL.md` | `.rad/skills/rad-approve/SKILL.md` | wrapper | `$ARGUMENTS` | yes | planned: parity issue #186 |
| rad-design | `.claude/commands/architect/rad-design.md` | `.agents/skills/rad-design/SKILL.md` | `.rad/skills/rad-design/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | yes | planned: parity issue #186 |
| rad-epic-decompose | `.claude/commands/architect/rad-epic-decompose.md` | `.agents/skills/rad-epic-decompose/SKILL.md` | `.rad/skills/rad-epic-decompose/SKILL.md` | as-is | `$ARGUMENTS`, `gh` | artifact | planned: parity issue #186 |
| rad-insights | `.claude/commands/shared/rad-insights.md` | `.agents/skills/rad-insights/SKILL.md` | `.rad/skills/rad-insights/SKILL.md` | wrapper | `$ARGUMENTS`, `$1/$2` | yes (`--draft-plans` only) | planned: parity issue #186 |
| rad-status | `.claude/commands/shared/rad-status.md` | `.agents/skills/rad-status/SKILL.md` | `.rad/skills/rad-status/SKILL.md` | as-is | none | no | planned: part 2 |
| rad-plan | `.claude/commands/team/rad-plan.md` | `.agents/skills/rad-plan/SKILL.md` | `.rad/skills/rad-plan/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | yes | planned: parity issue #186 |
| rad-adopt | `.claude/commands/team/rad-adopt.md` | `.agents/skills/rad-adopt/SKILL.md` | `.rad/skills/rad-adopt/SKILL.md` | wrapper | `$ARGUMENTS`, `gh` | yes | planned: parity issue #186 |
| rad-deliver | `.claude/commands/team/rad-deliver.md` | `.agents/skills/rad-deliver/SKILL.md` (+ `agents/openai.yaml`) | `.rad/skills/rad-deliver/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | yes | planned: parity issue #186 |
| rad-research | `.claude/commands/team/rad-research.md` | `.agents/skills/rad-research/SKILL.md` | `.rad/skills/rad-research/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | artifact | planned: parity issue #186 |
| rad-review | `.claude/commands/team/rad-review.md` | `.agents/skills/rad-review/SKILL.md` | `.rad/skills/rad-review/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | artifact (`.agents/findings.jsonl`) | planned: part 2 |
| quality-review | `.claude/commands/team/quality-review.md` | `.agents/skills/quality-review/SKILL.md` | `.rad/skills/quality-review/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | no | planned: part 2 |
| accessibility-review | `.claude/commands/team/accessibility-review.md` | `.agents/skills/accessibility-review/SKILL.md` | `.rad/skills/accessibility-review/SKILL.md` | wrapper | sub-agent, `$ARGUMENTS` | no | planned: part 2 |

### Skills

| Tool | Claude path | Codex path | Source | Body | Deps | State | Status |
|------|-------------|------------|--------|------|------|-------|--------|
| kickoff | `.claude/skills/kickoff/SKILL.md` | `.agents/skills/kickoff/SKILL.md` | `.rad/skills/kickoff/SKILL.md` | as-is | `gh` (optional) | no | planned: parity issue #186 |
| wrap | `.claude/skills/wrap/SKILL.md` | `.agents/skills/wrap/SKILL.md` | `.rad/skills/wrap/SKILL.md` | wrapper | `$1/$2` | yes | planned: parity issue #186 |

### Agents

| Tool | Claude path | Codex path | Source | Body | Deps | State | Status |
|------|-------------|------------|--------|------|------|-------|--------|
| quality-reviewer | `.claude/agents/quality-reviewer.md` | `.codex/agents/quality-reviewer.toml` | `.rad/agents/quality-reviewer.md` | as-is | none (tools: Read, Bash) | no | planned: part 2 |
| accessibility-reviewer | `.claude/agents/accessibility-reviewer.md` | `.codex/agents/accessibility-reviewer.toml` | `.rad/agents/accessibility-reviewer.md` | as-is | none (tools: Read, Bash) | no | planned: part 2 |
| 27 orchestrator and mapper agents | `.claude/agents/*-orchestrator.md`, `*-mapper.md` | none | none | n/a | n/a | n/a | not shipped, not ported (RAD-repo-internal, produced by `/rad-design` for this repo's own features) |

### Why the borderline rows landed where they did

- **rad-review in part 2**: the Claude version dispatches reviewers itself;
  the Codex version is a thin wrapper over `rad review <reviewer>`, which
  already runs a reviewer agent through the review lane. It only appends to
  `.agents/findings.jsonl`, so it belongs with the read-only slice.
- **rad-insights in #186**: reading is its main job, but `--draft-plans` cuts
  a `rad/insights-proposals-<date>` branch and commits a plan, and its
  positional args need a Codex override body. One migration, not two.
- **kickoff in #186**: read-only, but it is the session pair of `wrap`
  (state-changing). They ship together so a Codex user never gets half the
  ritual.
- **rad-research and rad-epic-decompose in #186**: they never commit, but
  their artifacts feed `/rad-design` and `/rad-plan`, and `rad-research`
  dispatches sub-agents. They port with the workflow they feed.

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

### Agents: `.rad/agents/<name>.md`

Claude agent frontmatter (`name`, `description`, `model`, `tools`, optional
`roles`) plus an optional `codex:` mapping with `sandbox_mode`
(`read-only` | `workspace-write`). The body may not contain `'''`, a
control character other than tab and LF, or any `{{...}}` token.

---

## Output mapping

| Source | Target | Output |
|--------|--------|--------|
| skill, `claude: command:<subdir>/<file>` | Claude | `.claude/commands/<subdir>/<file>.md` |
| skill, `claude: skill` | Claude | `.claude/skills/<name>/SKILL.md` |
| skill, `codex: skill` | Codex | `.agents/skills/<name>/SKILL.md` (frontmatter `name`, `description`) |
| skill, `codex_implicit: false` | Codex | `.agents/skills/<name>/agents/openai.yaml` with `policy.allow_implicit_invocation: false` |
| agent | Claude | `.claude/agents/<name>.md`: frontmatter minus `codex:`, plus the body |
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

Claude's deliver gate has two layers: the harness approval check
(`node harness/cli.js deliver` refuses without an `approved` event in
`.agents/state/<feature>/events.jsonl`) and the `PreToolUse` hook
`scripts/deliver-gate-hook.mjs`, which blocks an unapproved `/rad-deliver`
Skill call.

Codex hooks have the same shape as Claude's, but there is no matcher for
skill calls, and Codex documents hooks as "a guardrail, not a complete
enforcement boundary". So:

- Codex wrappers for state-changing steps only call `rad` commands. They
  never orchestrate waves or record approvals in prose.
- The Codex deliver skill runs `node harness/cli.js deliver`, which checks
  approval itself, and sets `codex_implicit: false` so Codex never invokes
  it implicitly.
- The missing hook layer is recorded as a guarded bypass in
  `docs/invariants.yaml` when #186 lands.

---

## AGENTS.md and `@AGENTS.md` (part 3)

Codex reads `AGENTS.md`. Claude Code reads `AGENTS.md` natively only when
there is no `CLAUDE.md`; otherwise `CLAUDE.md` must import it with
`@AGENTS.md`, which Anthropic recommends over a symlink. Part 3 makes
`AGENTS.md` the conventions source and has `CLAUDE.md` import it, with Claude-
specific material staying in `CLAUDE.md`.

---

## Shipping gaps found

| Gap | Effect | Fixed by |
|-----|--------|----------|
| `quality-reviewer` and `accessibility-reviewer` are not shipped by core (`.claude/agents/` is user data in `harness/install-manifest.js`), yet `rad review` loads `.claude/agents/<reviewer>.md` | `rad review` fails in an installed project that never ran `/rad-design` | Part 2 (ships the reviewers and their generated outputs) |
| `scripts/deliver-gate-hook.mjs` and its `.claude/settings.json` registration are not shipped | Installed projects get the harness check but not the hook layer | #186 (the hook is about deliver; ships with the deliver parity work) |
| `scripts/lint-agent-files.sh:15-17` says reviewers have no `roles:`, but they do | Misleading comment only | Part 2 (with the reviewer migration) |

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
