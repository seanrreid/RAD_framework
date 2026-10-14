# Plan: Document the Eight rad Commands That Have No Section
Created: 2026-10-14
Author: architect
Status: complete
Completed-At: 2026-10-14T20:41:26.661Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-14T20:39:11.484Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-cli-undocumented-commands
Tier: light
Source-Author: none (no source issue)
Source-Comments: none

## Context
Sixth plan from the 2026-10-14 docs audit. `docs/rad-cli.md` is the CLI reference, but eight commands in the dispatch table of `harness/cli.js` have no `### rad …` section: `status`, `config`, `capabilities`, `generate`, `owner-claim`, `owner-release`, `architecture-approve` and `plan-fingerprint`. Some are mentioned in passing (`rad generate` in several guides, `rad capabilities` and `rad config` in `docs/configuration.md`, `rad status` as a "follow-up" until #283 removed that line), but a reader of the CLI reference cannot find their usage, effects or exit codes.

The usage strings (verbatim from the dispatch table):

- `rad status [--phase <phase>]`: "Show current state of all rad/ features."
- `rad config get <key> | validate | settings | migrate [--from <path>] [--force] | init [--architect <id>] [--platform <p>] [--default-branch <b>] [--agent <claude|codex> | --agent-cmd <cmd> [--agent-adapter <command|acp>] | --agent-adapter sdk] [--force]`
- `rad capabilities <feature> [--plan <path>]`: "Show each wave's effective capability classes for a plan (read-only)."
- `rad generate [--check] [--root <dir>]`: "Generate Claude and Codex files from .rad/ sources; --check reports drift and orphans (writes nothing)."
- `rad owner-claim <feature>` / `rad owner-release <feature>`: claim or release the single-writer lock on a feature.
- `rad architecture-approve <slug> [--on-behalf-of <name>] [--evidence <text>]`: "Record a frozen architecture-approved audit event for a slug."
- `rad plan-fingerprint <planFile>`: "Print the SHA-256 fingerprint of a plan doc body (read-only)."

Facts already established in this audit that the new sections must not contradict: the `owner-claimed` and `owner-released` events are data-only and gate nothing (`docs/configuration.md`, RAD_SYNC paragraph, corrected in #283); `rad capabilities` is read-only and appends no event (`.rad/skills/rad-approve/SKILL.md`); `rad config` is already documented in depth in `docs/configuration.md`.

Separate from this plan, and not changed here: the one-line help summary of `rad deliver` in `harness/cli.js` still says "via Claude Agent SDK", which is stale now that three adapters exist. That is a code change and is left for a later standard plan.

## Acceptance Criteria
1. **One section per command.** `docs/rad-cli.md` gains a `### rad <command>` section for each of the eight commands (`owner-claim` and `owner-release` may share one section headed with both names), placed with the other subcommands before the "Install commands" section, in the existing style: a fenced usage line copied from the dispatch table, a short description, the effects (files, events, git, network) and the exit codes.
2. **Everything is read from the code.** Each section's effects and exit codes come from the command's implementation in `harness/` (`approveCommand`-style handlers in `harness/cli.js` and the modules they call), not from memory or from the summaries above; any flag in the usage line that the code does not honour, or behaviour the code has that the usage line omits, is reported in the task note and the doc follows the code.
3. **Right level of detail.** `rad config` gets a short section (what each of `get`, `validate`, `settings`, `migrate`, `init` does, one line each, with the exit codes) that links to `docs/configuration.md` for the schema and presets; `rad capabilities` gets a short section that links to `docs/configuration.md#rad-capabilities`. Neither duplicates the longer text.
4. **Honest about read-only vs writing.** Each section states plainly whether the command is read-only, which of `status`, `capabilities` and `plan-fingerprint` are, and which write (`generate` writes `.claude/` and `.codex/` files unless `--check`; `owner-claim`/`owner-release` and `architecture-approve` append events and say to which log, including the reserved `_architecture` project log for `architecture-approve`, if the code confirms it).
5. **Index and links.** The "Subcommands" area lists the new commands where the doc already lists others, if it has such a list, and the `/architect:rad-design` and `/architect:rad-approve` mentions of these commands elsewhere in the repo are not edited; relative links in `rad-cli.md` still resolve.
6. **Commands in prose are namespaced.** Any slash command the new text mentions uses the namespaced form (`/architect:rad-design`, `/architect:rad-approve`, `/shared:rad-status`).
7. **Nothing else changes.** `git diff --stat` shows only `docs/rad-cli.md` and this plan; no code, script or other doc is touched; existing sections are unchanged apart from an index line if one exists.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| docs/rad-cli.md | 44-46 | Subcommands intro and any command index |
| docs/rad-cli.md | 398-424 | New sections for `status`, `capabilities`, `plan-fingerprint` (placed near `gate` and `stop-status`) |
| docs/rad-cli.md | 1437-1446 | New sections for `config`, `generate`, `owner-claim`/`owner-release`, `architecture-approve` (placed before "Install commands") |

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.
Verify: none (documentation only; Task 1.3 runs the link and diff checks and a usage cross-check)

#### Task 1.1: status, capabilities and plan-fingerprint
File: docs/rad-cli.md:398-424
What: Write the three sections per AC#1-AC#4. Read the dispatch entries and handlers in `harness/cli.js`, the capability resolution module (`harness/capabilities.js`), the status renderer it calls, and the fingerprint helper (`harness/fingerprint.js`) first. Run only read-only commands to confirm behaviour (`node harness/cli.js status`, `capabilities <an existing delivered feature>`, `plan-fingerprint <a plan file>`), none of which write.
Validate: AC#1, AC#2, AC#3, AC#4 — each documented exit code and output shape was observed or read in the code.

#### Task 1.2: config, generate, owner-claim/owner-release and architecture-approve
File: docs/rad-cli.md:1437-1446
What: Write the four sections per AC#1-AC#4. Read `configGet`, `configValidate`, `configSettings`, `configMigrate` and `configInit` in `harness/cli.js`, `harness/generate.js`, the owner-claim and owner-release handlers and `architectureApproveCommand` (and `recordApproval` for the architecture log) first. Run only read-only commands to confirm behaviour (`config get platform`, `config validate`, `generate --check`); do not run `owner-claim`, `owner-release`, `architecture-approve`, `generate` without `--check`, `config init` or `config migrate`.
Validate: AC#1, AC#2, AC#3, AC#4 — the write/read-only statements match the code; no command that writes was run.

#### Task 1.3: Index, cross-check and checks
File: docs/rad-cli.md:44-46
What: If the Subcommands area has a command list, add the new commands to it. Cross-check that every command in the `SUBCOMMANDS` table of `harness/cli.js` now has a `### rad` heading in `rad-cli.md` (print the two lists side by side in the task note). Check every relative markdown link in `rad-cli.md`, grep for bare `/rad-` commands in the new text, and run `git diff --stat main...HEAD`.
Validate: AC#5, AC#6, AC#7 — no table entry lacks a section; no missing link; the diff stat lists only `docs/rad-cli.md` and this plan.

## Tests to Write
- None. Documentation only; the code reading, the read-only runs and the cross-check in Task 1.3 are the verification.

## Non-Goals
- Changing any code, including the stale `rad deliver` help summary
- Rewriting existing sections of `rad-cli.md` (the `pr-body`, `review` and `exercise` sections remain unverified by this audit)
- Duplicating `docs/configuration.md` content
- Running any command that writes events, files or git state

## Risks
- A command's behaviour may be subtler than its one-line summary (for example the event log `architecture-approve` writes to); AC#2 requires the doc to follow the code and report differences.
- Sections may grow long; AC#3 keeps `config` and `capabilities` short by linking.
