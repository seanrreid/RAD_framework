# Plan: Install Manifest and Non-Destructive Upgrade (#71 part 1)
Created: 2026-10-05
Author: architect
Status: pending-review
Branch: rad/install-manifest
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/71
Issue-Title: Layered packaging model for portable RAD distribution: core → presets → project overrides (spec-kit bundles analog)

## Context

#71 asks for layered packaging (core → presets → project overrides) with resolution that is "deterministic and inspectable". Before presets can mean anything, RAD needs to know **which files it installed and whether they've changed since**. Today it doesn't:
- `install.sh` copies RAD wholesale with `cp -r`.
- `--upgrade` overwrites `.claude/commands/`, `.claude/skills/`, `ai/`, `scripts/*.sh`, `scripts/hooks/` and `harness/`, so local edits are destroyed silently.
- `UPGRADE.md` ("A note on local edits") only warns about this.
- `ai/slop-register.md`, which INSTALL.md tells operators to customize, is overwritten on every upgrade.
- BEAKON, #71's case study, has no way to take core updates except reviewing them by hand.

**Bug found while mapping this:** `copy_scripts` copies `scripts/*.sh` only, so **`scripts/lib/plan-paths.sh` is never shipped**. In a fresh install, `lint-plan.sh`, `check-scope.sh` and `check-approval-blockers.sh` fail with "No such file", which makes `rad approve` refuse. Verified on 2026-10-05 against a fresh install into a temp repo. This plan builds the core file list in one place, so it ships `scripts/lib/` and tests for it.

**Decisions (architect, 2026-10-05):**
- **Order:** the first increment is the install manifest; presets build on it in a later plan.
- **Preset settings:** setting defaults will live as `.rad/config.yml` keys, with env vars overriding them. That's recorded on #71 for the preset plan and not built here.

## Scope

| In scope | Out of scope |
|---|---|
| The core file set, defined once (incl. `scripts/lib/`) | Presets, `--preset`, `<!-- CUSTOMIZE -->` markers (part 2) |
| `.rad/installed.json` manifest (layer + sha256 per file) | Moving env-var defaults into `.rad/config.yml` (part 2) |
| A non-destructive `--upgrade`: keep local edits, stage new versions, back up files that have no baseline | Deleting core files that are stale in the target |
| `rad install-core` (used by `install.sh`) and read-only `rad install-status` | A remote or git-URL install source |
| `install.sh` requires node | Plan-artifact location as a knob |

## Acceptance Criteria

1. **Core file set:** `harness/install-manifest.js` exports `listCoreFiles(sourceRoot)`, which returns the sorted relative paths of every framework file `install.sh` ships:
   - `.claude/commands/**`, `.claude/skills/**`, `ai/**`;
   - `scripts/*.sh`, `scripts/lib/**`, `scripts/hooks/**`;
   - `harness/**` minus `harness/node_modules/**`.

   User data is never in the set: `CLAUDE.md`, `.claude/agents/`, `.claude/settings*.json`, `.agents/`, `.rad/`. This is the one place the set is defined.
2. **Manifest:** `.rad/installed.json` holds `{ "version": 1, "rad_version": "<source git sha or 'unknown'>", "installed_at": "<ISO>", "files": { "<path>": { "layer": "core", "sha256": "<hex>" } } }`.
   - Keys are sorted, and output is deterministic apart from `installed_at`.
   - `readManifest(targetRoot)` returns `{ ok: true, manifest }`, `{ ok: false, missing: true }`, or `{ ok: false, error }` for malformed JSON or a wrong shape. A malformed manifest fails closed and is never treated as absent.
3. **Upgrade plan:** `planInstall({ sourceRoot, targetRoot, manifest })` assigns each core file one action:
   - `write`: absent in the target, or the target matches the manifest hash (unmodified), or the target already equals the new source;
   - `keep`: the manifest has a baseline and the target differs from both it and the new source. This is a local edit: it is not overwritten, the new core version is staged at `.rad/upgrade-pending/<path>`, and the manifest keeps the **old** baseline hash so the edit is still detected next time;
   - `deleted`: the manifest has an entry but the file is gone from the target. It is not restored; it is reported, and the manifest entry is kept;
   - `backup-write`: no manifest entry (first upgrade of a pre-manifest install) and the target differs from the new source. The target is copied to `.rad/upgrade-backup/<timestamp>/<path>`, then overwritten.

   Manifest paths that are no longer in the core set are reported as `stale` and left in place.
4. **`rad install-core --source <dir> [--target <dir>]`** runs the plan:
   - copies files and sets the executable bit on `scripts/*.sh`, `scripts/lib/*.sh` and hook scripts, as today;
   - writes the manifest;
   - prints one summary line, plus one line per `keep`, `deleted`, `backup-write` or `stale` path, naming where the staged or backup copy went.

   Exit codes:
   - **0:** every file was written;
   - **1:** any `keep` or `deleted` (a partial upgrade the operator must review);
   - **2:** bad arguments, or a malformed existing manifest (nothing is written).
5. **`rad install-status [--target <dir>]`** is read-only. It compares the target against `.rad/installed.json` and prints `modified: <path>` and `missing: <path>` lines.
   - **0** when clean;
   - **1** on drift, or with `no .rad/installed.json — run install.sh --upgrade` when there is no manifest;
   - **2** on bad arguments or a malformed manifest.
6. **`install.sh`:**
   - `check_prereqs` requires `node`, with a named error.
   - `copy_commands`, `copy_skills`, `copy_ai_guardrails`, `copy_scripts` and the file-copy part of `copy_harness` are replaced by one `install_core` step. It runs `node "$RAD_DIR/harness/cli.js" install-core --source "$RAD_DIR" --target "$TARGET_DIR"` and keeps today's informational lines.
   - The `install-core` exit code is passed on. On exit 1, the installer finishes every other step, then exits 1 at the end (the same deferred pattern as a config failure) and says to review the kept files with `node harness/cli.js install-status`. On exit 2, it stops with the reason.
   - `remove_stale_skills` is unchanged.
   - The upgrade banner and summary say that locally edited framework files are kept.
7. **Tests:**
   - **`harness/test/install-manifest.test.js` (new):** `listCoreFiles` includes `scripts/lib/plan-paths.sh` and excludes `node_modules` and user data. `planInstall` covers: a fresh install; an unmodified upgrade; a local edit kept, staged and keeping its baseline; an edit identical to the new source (`write`); a no-baseline file that differs (`backup-write`); a no-baseline file that is identical (`write`, no backup); a file deleted locally; a stale path; a malformed manifest (error). Also the manifest's shape and ordering.
   - **`harness/test/cli.test.js`:** `install-core` exit codes (0, 1 with a kept edit, 2 on bad arguments or a malformed manifest); `install-status` (clean 0, modified 1, missing 1, no manifest 1, bad arguments 2).
   - **`scripts/test-install-harness.sh`:**
     - a fresh install writes `.rad/installed.json` and ships `scripts/lib/plan-paths.sh`;
     - `scripts/lint-plan.sh` runs in the installed repo without "No such file";
     - an upgrade after editing `ai/slop-register.md` keeps the edit, stages the new version, exits 1, and `install-status` reports `modified: ai/slop-register.md`;
     - an upgrade with the manifest deleted backs up an edited file and overwrites it;
     - a clean upgrade exits 0;
     - all of these under both `bash` and `/bin/bash`.
8. **Docs:**
   - **`UPGRADE.md`:** "A note on local edits" is replaced by how upgrades now work: the manifest, kept edits, `.rad/upgrade-pending/`, `.rad/upgrade-backup/`, `rad install-status`, and the first upgrade of a pre-manifest install.
   - **`INSTALL.md`:** the "What Gets Installed" tree shows `.rad/installed.json`. Prerequisites list `node`. Customizing `ai/slop-register.md` notes that edits now survive upgrades.

## Agent Scope

No mapper agents were used. The surface was read directly:
- `install.sh` copy functions (152-246), `check_prereqs` (73-96) and the deferred-exit tail (376-458);
- `scripts/test-install-harness.sh` (its isolated-identity installer runs);
- the CLI command registry;
- the `UPGRADE.md` and `INSTALL.md` section maps;
- a fresh install into a temp repo, which reproduced the missing `scripts/lib/`.

## Program Design

**New module: `harness/install-manifest.js`**
```js
export const MANIFEST_PATH        // '.rad/installed.json'
export const PENDING_DIR          // '.rad/upgrade-pending'
export const BACKUP_DIR           // '.rad/upgrade-backup'
export function listCoreFiles(sourceRoot)              // -> string[] (sorted)
export function hashFile(path)                          // -> hex sha256
export function readManifest(targetRoot)                // -> { ok, manifest } | { ok:false, missing } | { ok:false, error }
export function planInstall({ sourceRoot, targetRoot, manifest })
  // -> { actions: [{ path, action: 'write'|'keep'|'deleted'|'backup-write', sourceHash, baseline }], stale: string[] }
export function applyInstall({ sourceRoot, targetRoot, plan, now, radVersion }) // copies, stages, backs up, writes manifest
```

**Call stack:**
```
install.sh main
  check_prereqs (node required)
  install_core -> node $RAD_DIR/harness/cli.js install-core --source $RAD_DIR --target $TARGET_DIR
                    readManifest -> planInstall -> applyInstall -> report, exit 0/1/2
  remove_stale_skills, scaffold_claude_md, setup_rad_config, ...
  print_next_steps; exit 1 if CONFIG_FAILED or CORE_KEPT
```

**File tree diff:**
```
harness/install-manifest.js            (new)
harness/test/install-manifest.test.js  (new)
harness/cli.js                         (install-core, install-status)
harness/test/cli.test.js               (cases appended)
install.sh                             (install_core replaces cp -r copies)
scripts/test-install-harness.sh        (cases appended)
UPGRADE.md, INSTALL.md                 (docs)
```

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/install-manifest.js | 1-180 | New: core set, manifest, plan, apply |
| harness/test/install-manifest.test.js | 1-220 | New: unit cases |
| harness/cli.js | 55-140 | Register `install-core`, `install-status` |
| harness/cli.js | 3130-3230 | The two command functions (append at end of file) |
| harness/test/cli.test.js | 2080-2160 | Verb cases (append at end of file) |
| install.sh | 1-100 | Header comment, `check_prereqs` requires node |
| install.sh | 150-250 | `install_core` replaces the copy functions |
| install.sh | 370-458 | Upgrade summary, deferred exit |
| scripts/test-install-harness.sh | 100-330 | Manifest, `scripts/lib`, kept-edit, backup, clean-upgrade cases |
| UPGRADE.md | 1-100 | How upgrades work now (replaces "A note on local edits") |
| INSTALL.md | 1-130 | Prerequisites, installed tree, slop-register note |

## Execution Notes

### Do Not Touch
- `scaffold_claude_md`, `setup_rad_config`, `config_init`, `config_migrate` (install.sh's config path from #172)
- `remove_stale_skills`
- harness/config.js, harness/capabilities.js, harness/spine.js, harness/adapters/
- CLAUDE.md, .rad/config.yml

### Key Files
- `install.sh`: `main`, the copy functions, `check_prereqs`, the `CONFIG_FAILED` deferred-exit pattern
- `scripts/test-install-harness.sh`: its isolated-identity installer helper (`GIT_CONFIG_GLOBAL=/dev/null`, empty HOME)
- `harness/cli.js`: the command registry and an existing read-only verb (`configCommand` or `capabilitiesCommand`) for shape

### Reminders
- **User data is never in the core set.** The test asserts it.
- **A malformed manifest fails closed:** exit 2, nothing written. It is never treated as absent.
- **Never destroy a local edit.** Keep it, or back it up before overwriting.
- **Code and shell rules:** named constants, functions under about 40 lines, comments that state constraints; bash 3.2 portability and the shell-safety lint for `install.sh`; no en dashes.

## Wave Plan

### Wave 1 — sequential
The module and its verbs; install.sh depends on them.

#### Task 1.1: Install manifest module and verbs
File: harness/install-manifest.js:1-180, harness/test/install-manifest.test.js:1-220, harness/cli.js:55-140, harness/cli.js:3130-3230, harness/test/cli.test.js:2080-2160
What: Implement AC#1, AC#2, AC#3, AC#4, AC#5, and the harness parts of AC#7.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#7 with `npm test --prefix harness`. Edge cases:
- an empty target;
- a missing manifest;
- a malformed manifest;
- an edit identical to the new source;
- a no-baseline file that is identical;
- a file deleted locally;
- a stale path;
- the executable bit on scripts.

### Wave 2 — sequential
`install.sh` integration.

#### Task 2.1: install.sh uses install-core
File: install.sh:1-100, install.sh:150-250, install.sh:370-458, scripts/test-install-harness.sh:100-330
What: Implement AC#6 and the `test-install-harness.sh` part of AC#7.
Validate: AC#6, AC#7:
- `bash scripts/test-install-harness.sh && /bin/bash scripts/test-install-harness.sh`;
- `scripts/lint-shell-safety.sh` shows no ✗;
- the full suite is green (harness tests, evals, every `scripts/test-*.sh` under both shells, `lint-invariants`).

Edge cases:
- node missing (named error);
- `install-core` exit 1 (deferred exit 1);
- `install-core` exit 2 (stop);
- a fresh install;
- the first upgrade of a pre-manifest install.

### Wave 3 — sequential
Docs.

#### Task 3.1: UPGRADE.md + INSTALL.md
File: UPGRADE.md:1-100, INSTALL.md:1-130
What: Implement AC#8.
Validate: AC#8. Docs only, with no testable surface beyond review: `grep -n "installed.json\|install-status" UPGRADE.md INSTALL.md` shows each listed location.

## Tests to Write
- [ ] Core set, plan and manifest cases — harness/test/install-manifest.test.js
- [ ] install-core / install-status verb cases — harness/test/cli.test.js
- [ ] Manifest, scripts/lib, kept-edit, backup, clean-upgrade cases — scripts/test-install-harness.sh

## Non-Goals
- Presets, `--preset`, `<!-- CUSTOMIZE -->` markers, and moving env-var defaults into `.rad/config.yml` (#71 part 2).
- Deleting stale core files from the target (they're reported only).
- Merge assistance for kept edits. The new version is staged; the operator merges.
- Installing from a git URL.

## Out-of-Scope Dependencies
None.

## Risks
- **Upgrades can now exit 1 where they used to exit 0.** A kept edit makes `install.sh --upgrade` exit 1. That's intended: the repo is running mixed framework versions until the operator reviews the kept files.
- **The first upgrade after this ships has no baseline.** Every differing file is backed up and overwritten, which matches today's behavior plus a backup, so nothing is lost.
- **Node becomes a hard install prerequisite.** It is already required to use RAD (`rad config init`, every gate).
- **Self-protected paths:** `harness/` and `scripts/` trigger advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — the first increment is the manifest.** Architect decision, 2026-10-05. Presets follow and build on the per-file layer and hash record.
- **ASSUMPTION — a kept edit exits 1.** This follows #172's deferred-exit pattern: a partial result is never reported as success.
- **ASSUMPTION — the `scripts/lib/` fix belongs here.** The bug is in the copy step this plan replaces; filing it separately would mean patching code this plan deletes.
