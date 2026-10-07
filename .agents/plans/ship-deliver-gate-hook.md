# Plan: Ship the Deliver-Gate Hook to Installed Projects (#186 part 1)
Created: 2026-10-07
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-07T13:30:01.299Z
Recorded-By: sean@torchcodelab.com
Branch: rad/ship-deliver-gate-hook
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for RAD's state-changing workflow (plan, approve, deliver)

## Context

RAD's own repo blocks an unapproved `/rad-deliver` with a `PreToolUse` hook: `scripts/deliver-gate-hook.mjs`, registered in `.claude/settings.json`. Installed projects get neither part:
- **The script:** core install ships only `scripts/*.sh` (`CORE_FLAT`, `harness/install-manifest.js:59`), so the `.mjs` hook never ships.
- **The registration:** `.claude/settings*.json` is user data that install never touches, and no code anywhere merges JSON settings.

So `CLAUDE.md:22-27`, which installs copy as the template, claims a hook is "registered in `.claude/settings.json`" when it isn't. That's false for every installed project. `docs/rad-tool-portability.md:231` lists this as an open shipping gap assigned to #186.

Decisions (2026-10-07, recorded on #186):
- **#186 is split into four plans.** This is part 1.
- **Core install ships the hook script.**
- **Install and upgrade merge the hook registration into the project's `.claude/settings.json` automatically.** The merge:
  - is idempotent, adding the entry only if it's missing;
  - never removes, reorders or overwrites existing settings;
  - fails closed: if the file doesn't parse, it's left untouched and the problem is reported.
- **The Codex deliver bypass entry in `docs/invariants.yaml` belongs to part 3.**

## Scope

| In scope | Out of scope |
|---|---|
| Core install ships `scripts/*.mjs` (the hook) | Moving the hook out of `scripts/` |
| A pure merge module for `.claude/settings.json` plus a `rad install-hooks` command | Touching `.claude/settings.local.json` or any other settings key |
| `install.sh` runs the merge on fresh install and upgrade, and reports failure without undoing anything | Uninstalling or removing a registration |
| Docs: `rad-cli.md`, `UPGRADE.md`, the portability gap row, the `CLAUDE.md` claim, an invariant anchor | The Codex bypass entry in `docs/invariants.yaml` (part 3) |
| | Any change to the hook's own behavior (`deliver-gate-hook.mjs`) |

## Acceptance Criteria

1. **Core install ships the hook.** `listCoreFiles` includes top-level `scripts/*.mjs`, so `scripts/deliver-gate-hook.mjs` is in the real repo's core set. Nested and non-`.mjs` files under `scripts/` are still excluded.
2. **Merge module.** `harness/claude-settings.js` exports a pure `mergeDeliverGateHook(text)`, where `text` is a string, or `null` when the file is absent. It returns `{ status, text }` or `{ error }`:
   - **Absent** (`null`): `created`, with JSON containing only the hook registration.
   - **Registration already present:** `present`, with the original text unchanged. "Present" means any `hooks.PreToolUse[*].hooks[*].command` contains `deliver-gate-hook.mjs`, whatever the matcher.
   - **Valid object without the registration:** `added`. A new `{ matcher: "Skill", hooks: [{ type: "command", command: "node scripts/deliver-gate-hook.mjs" }] }` entry is appended to `hooks.PreToolUse`, creating `hooks` and `PreToolUse` if they're missing. Every other key, entry and array order is kept, and the output is 2-space JSON with a trailing newline.
   - **Errors, each with a message naming the problem:**
     - empty text;
     - text that isn't valid JSON;
     - a top level that isn't an object;
     - `hooks` present but not an object;
     - `hooks.PreToolUse` present but not an array.
3. **`rad install-hooks [--target <dir>]`.**
   - It reads `<target>/.claude/settings.json`, applies the merge, and writes atomically only on `created` or `added`.
   - It prints one line: `rad install-hooks: <status> .claude/settings.json`. Exit 0 on `created`, `added` or `present`.
   - **It exits 2 and writes nothing when:**
     - the merge returns an error;
     - `.claude/settings.json` is a symlink or not a regular file;
     - `<target>/scripts/deliver-gate-hook.mjs` is absent, since registering a missing hook would error on every Skill call.

     The reason goes to stderr.
   - It's listed in the CLI's subcommand table and help.
4. **`install.sh` runs `install-hooks` on fresh install and on `--upgrade`, after the core install.**
   - On a non-zero exit, it records the failure. Every later step still runs, and `exit_on_incomplete` reports the failure and exits 1.
   - It never undoes the core install.
   - `.claude/settings.local.json` is never touched.
5. **Install test.** `scripts/test-install-harness.sh` covers:
   - a fresh install creates `.claude/settings.json` with the hook;
   - an upgrade over an existing `settings.json` with other keys keeps them and appends the hook;
   - a second upgrade leaves the file byte-identical;
   - a malformed `settings.json` is left byte-identical, the installer exits 1, and the output names the file.

   It passes under both `bash` and `/bin/bash`.
6. **Docs and invariants.**
   - **`docs/rad-cli.md`:** a `### rad install-hooks` section.
   - **`UPGRADE.md`:**
     - the "What an upgrade changes" table gets a `.claude/settings.json` row, "Merged: the deliver-gate hook registration is added if missing; nothing else changes";
     - the `scripts/` row mentions `*.mjs`.
   - **`docs/rad-tool-portability.md:231`:** the gap row says it's fixed in part 1.
   - **`CLAUDE.md:22-27`:** says install registers the hook in `.claude/settings.json`.
   - **`docs/invariants.yaml`:** `unapproved-deliver-cannot-run` gains an `enforced_by` anchor on `harness/claude-settings.js`, symbol `export function mergeDeliverGateHook`.
   - `scripts/lint-invariants.sh` passes.
7. **Every suite stays green:**
   - `npm test --prefix harness`;
   - every `scripts/test-*.sh` under both shells;
   - `lint-invariants`;
   - `lint-agent-files`;
   - `generate --check`.

## Agent Scope

Research was done directly by the architect, plus one read-only Explore sweep of the #186 surface. No scope-map agent covers the install path.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/install-manifest.js | 10-16 | Header: `scripts/*.mjs` is core |
| harness/install-manifest.js | 55-60 | `CORE_FLAT` gains `{ dir: 'scripts', suffix: '.mjs' }` |
| harness/test/install-manifest.test.js | 20-45 | Fixture: a top-level `.mjs` (shipped) and a nested `.mjs` (not shipped) |
| harness/test/install-manifest.test.js | 80-120 | Expected core set; real repo ships `scripts/deliver-gate-hook.mjs` |
| harness/claude-settings.js | 1-140 | New: pure `mergeDeliverGateHook` + hook constants |
| harness/test/claude-settings.test.js | 1-160 | New: every merge case in AC#2 |
| harness/cli.js | 60-75 | `INSTALL_HOOKS_USAGE` |
| harness/cli.js | 130-150 | `install-hooks` subcommand entry |
| harness/cli.js | 3376-3440 | `installHooksCommand` (after `installCoreCommand`) |
| harness/test/cli-install-hooks.test.js | 1-140 | New: `rad install-hooks` exit codes, write and no-write cases |
| install.sh | 1-40 | Header documents the hooks step |
| install.sh | 200-240 | New `install_claude_hooks` after `install_core` |
| install.sh | 520-557 | `main` calls it; `exit_on_incomplete` reports `HOOKS_FAILED` |
| scripts/test-install-harness.sh | 1-30 | Header lists the hooks behavior |
| scripts/test-install-harness.sh | 520-555 | New cases from AC#5 |
| docs/rad-cli.md | 659-734 | `### rad install-hooks` section |
| UPGRADE.md | 11-32 | Table rows: `scripts/` mentions `*.mjs`; new `.claude/settings.json` row |
| docs/rad-tool-portability.md | 225-232 | Gap row now says fixed |
| CLAUDE.md | 22-27 | The hook claim says install registers it |
| docs/invariants.yaml | 6-22 | New `enforced_by` anchor |

## Execution Notes

### Do Not Touch
- `scripts/deliver-gate-hook.mjs`: the hook's behavior is unchanged.
- `.claude/settings.json` in this repo: it already has the registration.
- `docs/invariants.yaml` bypass lists: the Codex bypass is part 3.
- `.claude/settings.local.json` anywhere.

### Key Files
- `harness/install-manifest.js`: core-set definition, symlink and fail-closed conventions.
- `harness/cli.js`: `installCoreCommand`, `parseInstallFlags` and `resolveInstallCoreArgs`, the patterns to copy for `install-hooks`.
- `install.sh`: `install_core`, `main`, `exit_on_incomplete` (the incomplete-step flag pattern, such as `CORE_KEPT`).
- `scripts/test-install-harness.sh`: `run_install` and `new_repo` helpers, the isolated git identity.
- `.claude/settings.json`: the exact registration shape to emit.

### Reminders
- **Keep the hook command string identical to this repo's** (`node scripts/deliver-gate-hook.mjs`). The invariant anchor and the "present" check both depend on it.
- **Write the hook constants once,** in `harness/claude-settings.js`: the matcher, the command, and the `deliver-gate-hook.mjs` marker for the "present" check.
- **Write the file atomically:** write a temp file in the same directory, then rename it. Never write when the status is `present`.
- **`rad install-hooks` uses the same flag parser as `install-core`.** `--target` defaults to the repo root.
- **If a test asserts that every subcommand is documented or listed,** update it in the same task.

## Program Design

**Signatures:**
- `harness/claude-settings.js`:
  - `export const DELIVER_GATE_HOOK_COMMAND = 'node scripts/deliver-gate-hook.mjs'`
  - `export const DELIVER_GATE_HOOK_MATCHER = 'Skill'`
  - `export function mergeDeliverGateHook(text: string | null): { status: 'created' | 'added' | 'present', text: string } | { error: string }`
- `harness/cli.js`: `export async function installHooksCommand(argv: string[], ctx: { repoRoot: string }): Promise<number>`. Exit 0 or 2.
- `install.sh`: `install_claude_hooks()` sets `HOOKS_FAILED=true` and `HOOKS_FAILURE_REASON` on failure.

**Call stack:**
```
install.sh main → install_core → install_claude_hooks → node harness/cli.js install-hooks --target "$TARGET_DIR"
  installHooksCommand → parse flags → check scripts/deliver-gate-hook.mjs exists → lstat .claude/settings.json (absent | regular | refuse)
                      → mergeDeliverGateHook(text|null) → error ⇒ exit 2, nothing written
                                                        → present ⇒ print, exit 0, nothing written
                                                        → created/added ⇒ mkdir .claude, write tmp, rename, print, exit 0
  … later steps run … → exit_on_incomplete reports HOOKS_FAILED ⇒ exit 1
```

**File tree diff:**
```
+ harness/claude-settings.js
+ harness/test/claude-settings.test.js
+ harness/test/cli-install-hooks.test.js
  (all other changes are in-place edits)
```

## Wave Plan

### Wave 1 — parallel
The two tasks touch independent files.

#### Task 1.1: Merge module
File: harness/claude-settings.js:1-140, harness/test/claude-settings.test.js:1-160
What:
- Implement `mergeDeliverGateHook` exactly as AC#2 describes, with the constants above.
- Use pure functions only, no I/O. Keep each function under about 40 lines (split the shape validation from the merge).
- Tests cover every AC#2 case:
  - absent → `created`;
  - `{}` → `added`;
  - other top-level keys and other `PreToolUse` entries are kept in order;
  - registration present with a different matcher → `present`, text unchanged;
  - empty text → error;
  - malformed JSON → error;
  - array top level → error;
  - `hooks: []` → error;
  - `PreToolUse: {}` → error;
  - the output ends in a newline;
  - applying the merge to its own `added` output gives `present`.
Validate: AC#2 — `npm test --prefix harness` passes. Named edge cases: absent, empty, malformed, wrong types at each level, already present, idempotence.

#### Task 1.2: Core ships `scripts/*.mjs`
File: harness/install-manifest.js:10-16, 55-60, harness/test/install-manifest.test.js:20-45, 80-120
What:
- Add `{ dir: 'scripts', suffix: '.mjs' }` to `CORE_FLAT` and update the header comment.
- Fixture: add `scripts/hook.mjs` (expected in the core set) and `scripts/sub/deep.mjs` (expected out).
- Real-repo test: assert `scripts/deliver-gate-hook.mjs` is included, and that `.claude/settings*.json` is still excluded.
Validate: AC#1 — `npm test --prefix harness` passes. Named edge cases: a nested `.mjs` is excluded, and settings files are still never core.

### Wave 2 — sequential
The command must exist before `install.sh` can call it.

#### Task 2.1: `rad install-hooks` command
File: harness/cli.js:60-75, 130-150, 3376-3440, harness/test/cli-install-hooks.test.js:1-140
What:
- Add the usage constant, the `SUBCOMMANDS` entry and `installHooksCommand` per AC#3. Reuse `parseInstallFlags` with `['--target']`.
- **Preconditions,** in order:
  1. the target has `scripts/deliver-gate-hook.mjs`;
  2. `.claude/settings.json` is absent or a regular file (lstat, so a symlink is refused).

  Then merge. On `created` or `added`, create `.claude/` if needed and write atomically. Print the status line.
- **Tests:**
  - absent settings → created, exit 0;
  - existing settings → added, exit 0, other keys kept;
  - rerun → present, exit 0, file unchanged (compare bytes and mtime);
  - malformed → exit 2, file unchanged;
  - symlinked settings → exit 2;
  - missing hook script → exit 2, nothing created;
  - an unknown flag → exit 2.
Validate: AC#3 — `npm test --prefix harness` passes. Named edge cases: absent file, present, malformed, symlink, missing hook script, bad argv.

#### Task 2.2: `install.sh` runs `install-hooks`
File: install.sh:1-40, 200-240, 520-557, scripts/test-install-harness.sh:1-30, 520-555
What:
- **`install.sh`:** add `install_claude_hooks`, which runs `node "$RAD_DIR/harness/cli.js" install-hooks --target "$TARGET_DIR"`, captures the output and indents it like `install_core`.
  - Exit 0 → print a success line.
  - Non-zero → set `HOOKS_FAILED=true` and `HOOKS_FAILURE_REASON`, then warn.
  - Call it from `main` right after `install_core`, for both fresh install and upgrade.
  - `exit_on_incomplete` reports: "Installed, but the deliver-gate hook was not registered: <reason>; fix .claude/settings.json, then run: node harness/cli.js install-hooks".
  - Initialize `HOOKS_FAILED` next to the other flags, and document the step in the header comment.
- **Test cases from AC#5:** fresh, upgrade with existing keys, an idempotent rerun, malformed. Use the existing helpers.
Validate: AC#4, AC#5 — `bash scripts/test-install-harness.sh` and `/bin/bash scripts/test-install-harness.sh` both pass. Named edge cases: fresh with no `.claude/`, existing keys kept, rerun byte-identical, malformed left untouched with exit 1.

### Wave 3 — sequential
Docs and the invariant anchor land after the code, then a full-suite check.

#### Task 3.1: Docs, `CLAUDE.md` claim, invariant anchor
File: docs/rad-cli.md:659-734, UPGRADE.md:11-32, docs/rad-tool-portability.md:225-232, CLAUDE.md:22-27, docs/invariants.yaml:6-22
What: Make the edits listed in AC#6.
- **`CLAUDE.md`:** keep it within the advisory line budget (`scripts/lint-claude-md.sh`), and keep the wording true for both this repo and installed projects: "(`scripts/deliver-gate-hook.mjs`, registered in `.claude/settings.json` by install)".
- **`docs/invariants.yaml`:** the anchor note reads "install merges the hook registration into an installed project's settings".
Validate: AC#6 — `scripts/lint-invariants.sh` and `scripts/lint-claude-md.sh` pass, and `grep` confirms each doc edit. No testable surface beyond those lints (docs and data).

#### Task 3.2: Full-suite check
File: harness/cli.js:3376-3440
What: Read-only verification. Run:
- `npm test --prefix harness`;
- every `scripts/test-*.sh` under `bash` and `/bin/bash`;
- `scripts/lint-invariants.sh`;
- `scripts/lint-agent-files.sh`;
- `node harness/cli.js generate --check`;
- `scripts/lint-plan.sh` on this plan.

Fix only regressions this plan caused, within the declared files.
Validate: AC#7 — every command exits 0. No new testable surface (verification only).

## Tests to Write
- [ ] Merge cases (absent, empty, malformed, wrong types, present, keeps other keys, idempotent) — harness/test/claude-settings.test.js
- [ ] `install-hooks` command exit codes and writes — harness/test/cli-install-hooks.test.js
- [ ] Core set includes top-level `scripts/*.mjs`, excludes nested — harness/test/install-manifest.test.js
- [ ] Installer: fresh, upgrade keeps existing keys, idempotent rerun, malformed left untouched with exit 1 — scripts/test-install-harness.sh

## Non-Goals
- No change to the hook's own behavior or its tests.
- No removal or uninstall path for the registration.
- No handling of `.claude/settings.local.json` or other settings scopes (user or enterprise).
- No Codex equivalent and no invariant bypass entry (part 3).

## Out-of-Scope Dependencies
None.

## Risks
- **Formatting churn.** When the merge adds the entry, the whole file is re-serialized as 2-space JSON, so a project's own formatting (key spacing, indentation) changes once. Content and order are kept. A file with the registration already present is never rewritten.
- **Projects with custom hook setups.** A project that registered the hook under a different command path (for example `$CLAUDE_PROJECT_DIR/scripts/...`) is detected as present by the `deliver-gate-hook.mjs` substring and left alone, which is intended.
- **Locally deleted hook script.** If the core install kept a deletion of `scripts/deliver-gate-hook.mjs`, `install-hooks` refuses rather than registering a missing script. The installer then reports the step as incomplete, so a deliberate opt-out shows up as exit 1 on every upgrade. That's acceptable, since opting out of a gate should be visible.

## Issue Gaps
- **[ASSUMPTION] Merge logic lives in the harness (Node), not `install.sh`.** Bash has no safe JSON parser, and the command is usable by any tool (decision from 2026-10-07).
- **[ASSUMPTION] "Present" is detected by the `deliver-gate-hook.mjs` substring in any `PreToolUse` command, whatever the matcher.** This avoids adding a duplicate when a project customized the registration.
- **[ASSUMPTION] An empty `settings.json` fails closed** rather than being treated as absent. Its contents are unknown, so it's left alone.
- **[ASSUMPTION] The hook command stays the relative `node scripts/deliver-gate-hook.mjs`, matching this repo.** Claude Code runs hooks from the project directory, and the hook resolves the repo root from its own location.
- **[ASSUMPTION] `rad install-hooks` is a separate command, not part of `install-core`.** `install-core` owns the core file manifest, and `settings.json` stays user data that is merged, never tracked in `.rad/installed.json`.
