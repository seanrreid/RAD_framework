# Plan: Claude Command Preset Permission Mode
Created: 2026-10-16
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-16T18:17:01.666Z
Recorded-By: sean@torchcodelab.com
Branch: rad/claude-preset-permission-mode
Issue: 287
Adopted-From: https://github.com/TorchCodeLab/RAD_framework/issues/287
Issue-Title: rad deliver: the claude command preset sets no permission mode, so a delivery can write only what the launching session allows
Source-Author: seanrreid (OWNER)
Source-Comments: 0 total, 0 non-collaborator

## Context
`scripts/claude-usage.mjs` runs `claude -p --output-format json` with no `--permission-mode`, so a command-adapter delivery can write only what the launching session's mode allows (default-mode: every write refused; auto-mode: skill and agent-instruction files held for an approval nobody can give). The SDK adapter already sets `permissionMode: 'acceptEdits'`. This plan covers issue items 1 and 4 only: the preset's permission mode with its test, the docs, and an advisory for plans that edit `.claude/` directly. Items 2 (permission-refusal stop) and 3 (rerun dead end) are separate plans.

## Scope
| In scope | Out of scope |
|---|---|
| `--permission-mode acceptEdits` default in the wrapper, with an override | `permission_denials` pass-through and its own stop (issue item 2) |
| Test in `scripts/test-claude-usage.sh` | `finish-failed` rerun dead end (issue item 3) |
| Docs: configuration.md preset, rad-wave-contract.md wrapper | Deriving `--allowedTools` from plan capabilities |
| lint-plan advisory for plans editing `.claude/` | Auto-mode classifier policy, cmux permission hook |

## Acceptance Criteria
1. With no forwarded `--permission-mode`, the wrapper invokes `claude -p --output-format json --permission-mode acceptEdits <forwarded args>`; the prompt still reaches stdin.
2. When the forwarded arguments already contain `--permission-mode` (as `--permission-mode X` or `--permission-mode=X`), the wrapper adds no default of its own, so the caller's value is the only one passed.
3. `docs/configuration.md` (agent presets) and `docs/rad-wave-contract.md` (the `claude` wrapper) state that the preset runs under `acceptEdits`, that code, `AGENTS.md`, `CLAUDE.md` and `.rad/skills/**` become writable, that `.claude/` stays protected (generated output), and that shell commands are not covered, with `--allowedTools` forwarded in the `command:` string as the way to allow them.
4. `scripts/lint-plan.sh` emits a warning (exit code unchanged) when a plan's Files in Scope names a path under `.claude/`, pointing at the source under `.rad/`; no warning otherwise.

## Agent Scope
Research ran inline (no sub-agent). Reads only: `scripts/claude-usage.mjs`, `scripts/test-claude-usage.sh`, `harness/capabilities.js`, `harness/adapters/agent/sdk.js`, `docs/configuration.md`, `docs/rad-wave-contract.md`, `scripts/lint-plan.sh`. No out-of-scope agents.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/claude-usage.mjs | 11-18, 81-87 | Add permission-mode constants; prepend the default unless the forwarded args already carry one |
| scripts/test-claude-usage.sh | 82-91 | Update the forwarded-args expectation; add default, override and `=` form scenarios |
| scripts/lint-plan.sh | 335-360 | Add the `.claude/` direct-edit advisory beside the high-risk advisory |
| scripts/test-lint-plan.sh | 1-400 | Add warn and no-warn fixtures for the `.claude/` advisory |
| docs/configuration.md | 295-310 | State the preset's permission mode, what becomes writable, what stays protected, how to allow shell |
| docs/rad-wave-contract.md | 127-150 | Add a permission-mode bullet to the `claude` wrapper description |

## Execution Notes

### Do Not Touch
- `harness/` (the SDK adapter and `capabilities.js` are read-only references)
- `.claude/` (generated output)

### Key Files
- `harness/adapters/agent/sdk.js` — the reference `permissionMode: 'acceptEdits'` the preset must match
- `scripts/claude-usage.mjs` — self-contained, installed into consumer projects: it must import nothing from `harness/` or `scripts/vendor/`

### Reminders
- Rerun `rad generate` is not needed: no `.rad/` source changes.
- Any new script file must be 100755; no new scripts are added here.

## Wave Plan

### Wave 1 — parallel
Tasks 1.1 and 1.2 touch disjoint files and can run in parallel.

#### Task 1.1: Preset permission mode and its test
File: scripts/claude-usage.mjs:11-18, 81-87, scripts/test-claude-usage.sh:82-91
What: Add named constants `PERMISSION_MODE_FLAG = '--permission-mode'` and `DEFAULT_PERMISSION_MODE = 'acceptEdits'`. Build the CLI args as `[...BASE_ARGS, ...defaultPermissionArgs(argv), ...argv]` where `defaultPermissionArgs` returns `[]` when any forwarded arg equals `--permission-mode` or starts with `--permission-mode=`. Update the existing "arguments" scenario's expected argv and add scenarios: default applied with no args, caller `--permission-mode plan` suppresses the default, caller `--permission-mode=plan` suppresses the default, and an empty argv still gets the default.
Validate: AC#1, AC#2 — `bash scripts/test-claude-usage.sh` passes with each scenario asserting the exact argv the fake `claude` recorded.

#### Task 1.2: `.claude/` direct-edit advisory
File: scripts/lint-plan.sh:335-360, scripts/test-lint-plan.sh
What: After the high-risk advisory, add a loop over declared Files in Scope that appends a WARNING for any path starting `.claude/`, e.g. `Plan edits generated output directly: <path> — edit the source under .rad/ and run rad generate (the headless claude preset cannot write .claude/ even under acceptEdits)`. Warning only; exit code unchanged. Add a fixture with a `.claude/commands/x.md` row (expects the warning, same exit code as the baseline) and one with only `scripts/` rows (expects none).
Validate: AC#4 — `bash scripts/test-lint-plan.sh` passes with both fixtures.

### Wave 2 — sequential
Docs describe the behavior wave 1 ships.

#### Task 2.1: Document the permission mode
File: docs/configuration.md:295-310, docs/rad-wave-contract.md:127-150
What: In configuration.md, under the `claude-usage.mjs` preset snippet, add a paragraph: the wrapper passes `--permission-mode acceptEdits` unless the `command:` already forwards one; under it code, `AGENTS.md`, `CLAUDE.md` and `.rad/skills/**` are writable and `.claude/` is not (generated output, produced by `rad generate`); shell commands (tests, `rad generate`) are not covered, so forward `--allowedTools "Bash(...)"` in the `command:` string. In rad-wave-contract.md add a matching bullet to the wrapper list, and note the `.claude/` lint advisory.
Validate: AC#3 — grep both files for `acceptEdits` and `.claude/`; `bash scripts/verify-all.sh` doc checks pass.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] default `--permission-mode acceptEdits` appears in forwarded argv — scripts/test-claude-usage.sh
- [ ] caller-supplied `--permission-mode X` and `--permission-mode=X` suppress the default — scripts/test-claude-usage.sh
- [ ] `.claude/` Files in Scope row warns, `scripts/` only does not, exit code unchanged — scripts/test-lint-plan.sh

## Non-Goals
- Reporting `permission_denials` as a distinct, never-retried stop (issue item 2).
- Fixing the `finish-failed` rerun dead end (issue item 3).
- Deriving `--allowedTools` from plan capability classes; the command adapter cannot narrow tools (`commandRefusal`), and the wrapper does not see the plan.
- Changing the auto-mode classifier, `autoMode.*` settings, or cmux hooks.

## Out-of-Scope Dependencies
None

## Risks
- Plan touches `scripts/` and `docs/`: self-protected path, so architect review applies; deliver with `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- `acceptEdits` widens what a headless delivery may write for consumers who relied on the launching session's stricter mode; this matches the SDK adapter and is the issue's intent.
- Consumers who already forward `--permission-mode` in `command:` are unaffected by AC#2.

## Issue Gaps
- ASSUMPTION: `--allowedTools` is not added by the preset. The issue says "probably"; the command adapter cannot narrow tools and the effect on shell commands is untested, so the docs tell operators to forward it themselves. Architect to confirm.
- ASSUMPTION: a caller-supplied `--permission-mode` wins over the default (issue silent). Chosen over relying on last-flag-wins in the CLI, which was not tested.
- ASSUMPTION: the `.claude/` advisory is a `lint-plan.sh` warning rather than an approval blocker; the issue says "lint or approval advisory".
- The Evidence table was measured on Claude Code 2.1.301; the docs state the behavior without pinning a version.
