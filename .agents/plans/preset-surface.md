# Plan: Preset Install Surface, Example Preset and Docs (#71 part 2c)
Created: 2026-10-06
Author: architect
Status: pending-review
Branch: rad/preset-surface
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/71
Issue-Title: Layered packaging model for portable RAD distribution: core → presets → project overrides (spec-kit bundles analog)

## Context

What already exists for #71:
- **Part 1 (#180):** the install manifest.
- **Part 2a (#181):** config-backed `settings:` and a layer-aware manifest.
- **Part 2b (#182):** the preset engine.
  - `harness/preset.js` (`readPreset`, `PRESET_ROOTS`).
  - A layer-generic install in `harness/install-manifest.js`.
  - Append-only `seedSettings` and `writeConfigAtomic` in `harness/config.js`.
  - `rad install-preset --source <dir> [--target <dir>]` (`harness/cli.js:3336-3398`).
  - `rad install-status` prints `preset: <name> <version> (<source>)`.

This plan finishes #71. It makes presets reachable from the installer, re-applies the recorded preset on `--upgrade`, ships `presets/example/`, and documents everything.

How the installer works today:
- `install.sh` takes `--dir`, `--upgrade`, `--yes` and `--architect` (lines 61-71).
- It installs core through `install_core` (190-220), then creates or migrates `.rad/config.yml` in `setup_rad_config` (329-343).
- `main` (417-454) exits 1 at the end if `CONFIG_FAILED` or `CORE_KEPT` is set.
- **Stale doc:** UPGRADE.md:155-156 still shows the old `install-status` format (`modified: <path>`). Since #181 the output is `modified: [<layer>] <path>`.

Decisions (2026-10-06, on #71):
- The installed preset is recorded and re-applied automatically by `install.sh --upgrade`.
- The example preset ships settings, a hook and an `ai/extensions` file, each marked CUSTOMIZE.
- The recorded `source` is an absolute path, so re-apply has to handle a source that doesn't exist on another machine.

## Scope

| In scope | Out of scope |
|---|---|
| `rad install-preset --reapply [--target <dir>]` (reads the recorded source) | Switching or removing a preset |
| `install.sh --preset <dir>`; `install.sh --upgrade` re-applies the recorded preset | Fetching a preset from a git URL (a preset is a local directory) |
| `presets/example/` (preset.yml, an observe-only hook, an ai/extensions file, a README) | CLAUDE.md convention blocks |
| `scripts/test-install-harness.sh` end-to-end preset cases | More settings keys |
| INSTALL.md, UPGRADE.md (incl. the 155-156 fix), docs/rad-cli.md install section, docs/configuration.md | Any change to the 2b engine's semantics |
| A `preset-add-only` invariant in docs/invariants.yaml | |

## Acceptance Criteria

1. **`rad install-preset --reapply [--target <dir>]`**
   - Reads `preset.source` from the target's `.rad/installed.json`, then behaves exactly as `--source <recorded source>`, with the same refusals, exit codes and output.
   - **No preset recorded:** prints `rad install-preset: no preset recorded; nothing to do` and exits 0. Nothing is written.
   - **Recorded source doesn't exist or isn't a directory:** exits 2 with nothing written. The message names the recorded path and the fix: `pass --preset <dir> to install.sh, or rad install-preset --source <dir>`.
   - **No manifest, or a malformed one:** exits 2, exactly as `--source` does today.
   - **Bad argv:** `--reapply` together with `--source` is a usage error (exit 2), and so is neither of them. `INSTALL_PRESET_USAGE` names both forms.
2. **`install.sh --preset <dir>`**
   - Accepted with or without `--upgrade`. The value must be a non-flag token naming an existing directory, which is resolved to an absolute path. Otherwise the script exits with the usage error before anything is installed.
   - A new `install_preset` step runs after `setup_rad_config` and decides what to do:
     - `--preset` given: run `install-preset --source <dir> --target <target>`;
     - else, `--upgrade`: run `install-preset --reapply --target <target>`;
     - else: skip silently.
   - **What each outcome does:**

     | Outcome | Effect |
     |---|---|
     | Exit 0 | Success line |
     | Exit 1 | Sets `PRESET_INCOMPLETE`; `main` exits 1 at the end, telling the user to review `install-status` and `.rad/upgrade-pending/` |
     | Exit 2 | Sets `PRESET_FAILED`, prints the output, carries on with the remaining steps, and `main` exits 1 at the end with the reason |
     | `CONFIG_FAILED` already set | Skipped with a warning, because the preset needs a config; `main` still exits 1 through `CONFIG_FAILED` |

     A preset failure never undoes the core install.
   - The header comment (1-22) and `USAGE` (42) document `--preset`.
3. **`presets/example/`**
   - **`preset.yml`:**
     - `name: example`, `version: "1"`;
     - `settings.high_risk_patterns` set to the built-in default pattern plus one extra alternative for infrastructure paths (`infra`, `terraform`), with a `# CUSTOMIZE` comment saying a project pattern replaces the default, so it should extend it rather than narrow it.
   - **`files/scripts/hooks/on-outcome/50-example-preset.sh`:**
     - committed mode 100755;
     - observe-only, bash 3.2 compatible;
     - prints one line to stderr naming the feature, wave and outcome;
     - `# CUSTOMIZE` marker.
   - **`files/ai/extensions/example-preset.md`:**
     - follows the existing extension shape (`## Applies When`, `## Rules`, `## Verification`);
     - `<!-- CUSTOMIZE -->` marker.
   - **`README.md`** explains the preset format and how to make a copy. `readPreset` ignores files at the preset root other than `preset.yml`; confirm this.
   - A harness test asserts `readPreset('presets/example')` is ok and that its pattern is a strict superset: every path matching the default still matches.
   - Not shipped: `presets/` is not a core tree, so it is never installed into a target.
4. **End-to-end tests in `scripts/test-install-harness.sh`:**
   - **Fresh install with `--preset <repo>/presets/example`:**
     - the hook lands executable;
     - the extension lands;
     - `config get settings.high_risk_patterns` returns the preset value;
     - `install-status` shows `preset: example 1 (...)`;
     - exit 0.
   - **`--upgrade` without `--preset`:** re-applies, restoring a deleted preset file. Exit 0.
   - **`--upgrade` with a recorded source that's gone:** points at a copied preset that is then removed. Core is still upgraded, the output names the missing path, and the exit is 1.
   - **`--preset /nonexistent`:** usage error, and nothing is installed.
   - **Preset over an existing `settings:` block:** the output shows `unseeded: high_risk_patterns`, and the exit is 1.
5. **Docs:**
   - **INSTALL.md:** the `--preset` flag (Quick and Non-Interactive Install), a "Presets" subsection under What Gets Installed, and the preset step under Upgrading.
   - **UPGRADE.md:**
     - 155-156 shows `modified: [<layer>] <path>` / `missing: [<layer>] <path>` and the `preset:` line;
     - "What an upgrade changes" mentions preset re-apply;
     - "Where customizations belong" points to presets for org- and client-wide defaults.
   - **docs/rad-cli.md:** a new "Install commands" section (`install-core`, `install-status`, `install-preset`, each with flags and exit codes).
   - **docs/configuration.md:** the Settings section notes that a preset seeds absent keys only.
   - Docs never describe behaviour that isn't shipped.
6. **Invariant.** `docs/invariants.yaml` gains `preset-add-only`:
   - **claim:** a preset never overwrites a path another layer owns, and every `install-preset` refusal happens before any write;
   - **`not_evalable`:** install-time CLI with no agent-reachable surface; covered by `harness/test/cli.test.js` and `scripts/test-install-harness.sh`;
   - **`enforced_by` anchors** in `harness/install-manifest.js` (the conflict throw in the layer apply), `harness/cli.js` (`preparePresetInstall`) and `harness/preset.js` (`PRESET_ROOTS`);
   - **bypass:** a symlinked target directory (such as `docs/`) is written through, the same as core.
   - `scripts/lint-invariants.sh` passes.
7. **Suites stay green:**
   - `npm test --prefix harness`;
   - `node --test harness/evals/*.eval.js`;
   - every `scripts/test-*.sh` under both `bash` and `/bin/bash`;
   - `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

No mapper agents were used in this session's research. The 2b Explore pass (same day) mapped `install.sh`, the install docs and the test harness. The anchors were re-checked directly against main at `010d441`: `install.sh` header, flags, `install_core`, `setup_rad_config` and `main`; `installPresetCommand`; the doc headings; the test-harness helpers. There are no out-of-scope dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 60-72 | `INSTALL_PRESET_USAGE` names `--reapply` |
| harness/cli.js | 3300-3400 | `--reapply` argument resolution and missing-source refusal |
| harness/test/cli.test.js | 2570-2680 | `--reapply` cases (append) |
| harness/test/preset.test.js | 1-260 | Example preset is valid; its pattern extends the default (append) |
| install.sh | 1-80 | Header, `USAGE`, `--preset` parsing and validation, state flags |
| install.sh | 180-225 | `install_preset` step beside `install_core` |
| install.sh | 415-456 | `main` step order and final exits |
| presets/example/preset.yml | 1-25 | New |
| presets/example/README.md | 1-60 | New |
| presets/example/files/scripts/hooks/on-outcome/50-example-preset.sh | 1-25 | New (mode 100755) |
| presets/example/files/ai/extensions/example-preset.md | 1-30 | New |
| scripts/test-install-harness.sh | 20-70 | Helpers if needed |
| scripts/test-install-harness.sh | 295-400 | Preset end-to-end cases (insert before the summary) |
| INSTALL.md | 19-112 | `--preset` flag; Presets subsection |
| INSTALL.md | 287-311 | Upgrading: preset re-apply |
| UPGRADE.md | 11-33 | What an upgrade changes |
| UPGRADE.md | 114-182 | Status format fix; customizations belong in presets |
| docs/rad-cli.md | 545-640 | New Install commands section before Smoke testing |
| docs/configuration.md | 70-95 | Settings: preset seeding note |
| docs/invariants.yaml | 225-260 | `preset-add-only` (append) |

## Execution Notes

### Do Not Touch
- `harness/install-manifest.js`, `harness/preset.js`, `harness/config.js` (2b engine semantics).
- `install_core`, `setup_rad_config` and the config steps in `install.sh`, except for wiring the new step.
- `CORE_TREES`. `presets/` must not become a core tree.
- `harness/gates.js`, `harness/events.js`, `harness/spine.js`.

### Key Files
- `harness/cli.js`: `resolveInstallPresetArgs`, `preparePresetInstall`, `installPresetCommand`, `parseInstallFlags` (which takes value flags; `--reapply` is a boolean, so check whether `parseInstallFlags` supports one or needs a small, tested extension).
- `install.sh`: the `install_core` exit-code pattern and the final-exit block in `main` are the model for `install_preset`.
- `scripts/test-install-harness.sh`: `run_install`, `new_repo`, `isolated`, the `assert_*` helpers.
- `scripts/hooks/README.md`: the hook invocation contract (args and `RAD_HOOK_*` env) the example hook must follow.
- `ai/extensions/testing.md`: the extension shape.

### Reminders
- **Fail-closed but non-destructive.** A preset failure never removes or reverts the core install. It always makes the installer exit non-zero.
- **The example hook is observe-only.** Never ship an active veto hook in an example.
- **The example pattern must extend the default, never narrow it.**
- **bash 3.2 compatible**, both `install.sh` and the hook.
- No en dashes.
- **Executable bit:** commit the hook with `git update-index --chmod=+x` if needed. The install copies the mode.

## Wave Plan

### Wave 1 — parallel
These tasks touch disjoint files.

#### Task 1.1: install-preset --reapply
File: harness/cli.js:60-72, harness/cli.js:3300-3400, harness/test/cli.test.js:2570-2680
What: Implement AC#1.
Validate: AC#1. Edge cases:
- no preset recorded (exit 0, tree unchanged);
- recorded source missing (exit 2, tree unchanged, message names the path);
- recorded source is a file, not a directory;
- `--reapply` with `--source`;
- neither flag;
- no manifest;
- a malformed manifest;
- a successful re-apply restores a deleted preset file.

Command: `npm test --prefix harness`.

#### Task 1.2: Example preset
File: presets/example/preset.yml:1-25, presets/example/README.md:1-60, presets/example/files/scripts/hooks/on-outcome/50-example-preset.sh:1-25, presets/example/files/ai/extensions/example-preset.md:1-30, harness/test/preset.test.js:1-260
What: Implement AC#3.
Validate: AC#3. Edge cases:
- `readPreset` ok;
- every path the default pattern flags is still flagged, using the test sample paths: `src/auth/x.js`, `db/migrations/1.sql`, `payments.js`;
- `infra/main.tf` is flagged only by the example pattern;
- the hook is executable in git (`git ls-files -s` shows 100755);
- the hook runs under `/bin/bash` with the four args and exits 0.

Command: `npm test --prefix harness`.

### Wave 2 — sequential
This wave depends on `--reapply` and the example preset.

#### Task 2.1: install.sh --preset and upgrade re-apply
File: install.sh:1-80, install.sh:180-225, install.sh:415-456, scripts/test-install-harness.sh:20-70, scripts/test-install-harness.sh:295-400
What: Implement AC#2 and AC#4.
Validate: AC#2, AC#4. Edge cases (the AC#4 cases plus these):
- `--preset` with no value;
- `--preset` with a flag-like value;
- `--preset` combined with `--upgrade` when the recorded name differs (exit 1 at the end, preset not switched, core upgraded).

Commands:
- every `scripts/test-*.sh` under both `bash` and `/bin/bash`;
- `scripts/lint-shell-safety.sh`;
- `npm test --prefix harness`.

### Wave 3 — sequential
This wave documents the shipped behaviour.

#### Task 3.1: Docs and invariant
File: INSTALL.md:19-112, INSTALL.md:287-311, UPGRADE.md:11-33, UPGRADE.md:114-182, docs/rad-cli.md:545-640, docs/configuration.md:70-95, docs/invariants.yaml:225-260
What: Implement AC#5 and AC#6.
Validate: AC#5, AC#6, AC#7.
Commands:
- `scripts/lint-invariants.sh`;
- `bash scripts/test-lint-invariants.sh`;
- the full suite list from AC#7.

There is no testable surface beyond the invariant lint.

## Program Design

### Signatures
- `harness/cli.js`: `resolveInstallPresetArgs(argv, repoRoot) → { presetDir, targetRoot } | { reapply: true, targetRoot } | { error }`. The `--reapply` branch resolves `presetDir` from the manifest before `preparePresetInstall` runs.
- `install.sh`: `install_preset()` sets `PRESET_INCOMPLETE` / `PRESET_FAILED`. The new `PRESET_DIR` global is empty when no `--preset` is given.

### Call stack
```
install.sh main → install_core → … → setup_rad_config → install_preset
    → node harness/cli.js install-preset (--source <PRESET_DIR> | --reapply) --target <T>
        → resolve source (manifest preset.source when --reapply) → preparePresetInstall → apply
main → final exits: CONFIG_FAILED, CORE_KEPT, PRESET_FAILED, PRESET_INCOMPLETE
```

### File tree
```
presets/example/
  preset.yml
  README.md
  files/scripts/hooks/on-outcome/50-example-preset.sh
  files/ai/extensions/example-preset.md
```

## Tests to Write
- [ ] install-preset --reapply cases — harness/test/cli.test.js
- [ ] example preset validity and pattern superset — harness/test/preset.test.js
- [ ] install.sh preset end-to-end cases — scripts/test-install-harness.sh

## Non-Goals
- Switching, removing or stacking presets.
- Fetching presets from a URL or registry. A preset is a local directory.
- Shipping `presets/` into installed targets.
- Inserting keys into an existing `settings:` block.

## Out-of-Scope Dependencies
None.

## Risks
- **A machine-specific source path.** `--upgrade` on a machine where the recorded preset path doesn't exist exits 1 after upgrading core. This is intended, and the message gives the fix. A team that shares a preset should keep it at a stable path, for example a sibling clone.
- **The example hook runs in RAD's own CI?** No. `presets/` is outside `scripts/`, so hook discovery and `lint-shell-safety` (`git ls-files` under `scripts/`) never see it. The bash 3.2 parse job may scan it, which is fine.
- **Installer exit semantics.** A preset problem now turns an otherwise successful install into exit 1. This matches the existing `CORE_KEPT` and `CONFIG_FAILED` behaviour.

## Issue Gaps
- **Assumption:** re-apply uses a new `--reapply` flag on `install-preset`, so `install.sh` never parses the JSON manifest itself (one reader).
- **Assumption:** when a preset fails (exit 2) during `install.sh`, the core install stays and the installer exits 1 at the end. A preset failure never blocks or reverts core.
- **Assumption:** `--preset` on `--upgrade` with a different preset name is refused by the engine (exit 2, so the installer exits 1). Switching stays out of scope.
- **Assumption:** the example's `high_risk_patterns` extends the built-in default (adding `infra` and `terraform`) instead of narrowing it, so the example never weakens the high-risk check.
- **Assumption:** the new invariant is `not_evalable` (install-time, no agent-reachable surface) and is covered by the harness and installer tests.
