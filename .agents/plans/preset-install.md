# Plan: Preset Install Engine (#71 part 2b)
Created: 2026-10-06
Author: architect
Status: pending-review
Branch: rad/preset-install
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/71
Issue-Title: Layered packaging model for portable RAD distribution: core → presets → project overrides (spec-kit bundles analog)

## Context

What is already in place:
- **Part 1 (#180)** shipped the install manifest.
- **Part 2a (#181)** made two settings config-backed (`settings.high_risk_patterns`, `settings.hooks_dir`) and made the manifest layer-aware. Core upgrades carry non-core entries unchanged and refuse to take over a path another layer owns. `PRESET_LAYER` is exported but nothing writes it yet.

This plan adds the engine that installs a preset: a reader for the preset format and a `rad install-preset` command. Research put the work at about 1,800 lines of context, over the 1,500 budget, so the rest of part 2b moves to a follow-up plan **2c**: the `install.sh --preset` flag, automatic re-apply on `--upgrade`, the shipped `presets/example/`, and the docs.

Decisions (2026-10-06, recorded on #71):
- **Format:** a preset is a directory holding `preset.yml` (name, version, optional `settings:`) and an optional `files/` tree that mirrors the target layout.
- **Allowed roots:** preset files may only land under `scripts/hooks/`, `ai/extensions/`, `.claude/agents/` or `docs/`. A path core owns is refused.
- **Manifest and edits:** preset files are recorded in `.rad/installed.json` as `layer: preset`, with the same keep-local-edits rules as core.
- **Settings seeding:** settings are written into `.rad/config.yml` only when the key is absent.
- **Recording:** the installed preset's name, version and source are recorded in `installed.json`, so 2c can re-apply it on upgrade.

Research findings that shape this plan:
- **`buildManifest`** (`harness/install-manifest.js:224-233`) rebuilds the manifest from scratch, so `install-core` would drop a top-level `preset` key.
- **`planInstall`** (190-203) is hardwired to the core file list.
- **`decideAction`**, **`recordedHash`** and **`copyWithMode`** are generic.
- **`manifestShapeError`** (115-128) ignores unknown top-level keys.
- **`serializeConfig`** (`harness/config.js:336-358`) is hand-rolled, so rewriting a user's config through it would **drop their comments and formatting**. Settings seeding must therefore edit the text and never re-serialize.
- **Writes are not atomic.** `configInit` and `configMigrate` write `.rad/config.yml` with a plain `writeFileSync`. The only atomic write in the codebase is `writeManifest`.

## Scope

| In scope | Out of scope |
|---|---|
| `harness/preset.js`: read and validate a preset directory | `install.sh --preset`, upgrade re-apply (plan 2c) |
| A generalized layer install in `install-manifest.js`; `install-core` keeps `preset` metadata | `presets/example/` (plan 2c) |
| Settings seeding into `.rad/config.yml` by appending text, written atomically | INSTALL.md, UPGRADE.md (including the stale install-status format at 155-156), docs/rad-cli.md, docs/configuration.md (plan 2c) |
| `rad install-preset --source <dir> --target <dir>`; `install-status` prints the installed preset | Removing or switching an installed preset |
| Tests for all of the above | CLAUDE.md convention blocks (rejected as not add-only) |

## Acceptance Criteria

1. **Preset reader.** `readPreset(dir)` in the new `harness/preset.js` returns `{ ok: true, preset: { name, version, settings, files } }` or `{ ok: false, errors }`, and never throws.
   - **Validation errors**, each naming the offending path or key:
     - `preset.yml` is missing or unparseable (read with the vendored js-yaml, as `loadConfig` does);
     - a top-level key other than `name`, `version` or `settings`;
     - `name` is not kebab-case (`^[a-z0-9][a-z0-9-]*$`);
     - `version` is not a non-empty string;
     - `settings` is invalid under the exported `settingsErrors` from `harness/config.js` (unknown key, empty value, malformed value);
     - an entry under `files/` that is not a regular file, including a symlink or anything else;
     - a file path that fails `isSafeRelPath` (exported for this);
     - a file outside `PRESET_ROOTS = ['scripts/hooks/', 'ai/extensions/', '.claude/agents/', 'docs/']`;
     - a preset with neither settings nor files.
   - `files` is a sorted list of posix paths relative to `files/`. Symlinks are rejected, never followed (the #168 lesson).
2. **Layer install.** In `harness/install-manifest.js`:
   - A **layer-generic** plan/apply pair installs an explicit file list under a given layer. It reuses `decideAction`, `recordedHash`, `copyWithMode`, the backup and staging dirs, and the atomic `writeManifest`.
   - The existing `planInstall` and `applyInstall` become thin core wrappers with unchanged behaviour. The existing core tests are left unedited and still pass.
   - **For a preset install:**
     - **Baselines** are this layer's own entries.
     - **`conflicts`** are preset paths recorded under any other layer.
     - **`stale`** is this layer's entries that the preset no longer ships. They are dropped from the manifest and the files are left on disk, the same as core.
     - **Other layers' entries** are carried over unchanged.
   - **`buildManifest`** keeps a top-level `preset` object, so `install-core` no longer drops it. A preset install sets `preset: { name, version, source }`, where `source` is the absolute path to the preset directory.
   - **`manifestShapeError`** validates an optional `preset` block: an object with string `name`, `version` and `source`.
3. **Settings seeding.** A `seedSettings(configText, settings)` function in `harness/config.js` returns `{ text, seeded, kept, unseeded }`.
   - **No `settings:` block:** it appends a `settings:` block holding every preset key at the end of the text. Each value is quoted with the existing `scalar` helper, and a trailing newline is guaranteed.
   - **Existing `settings:` block:** keys already present are `kept`. Preset keys missing from the block are `unseeded`, because inserting into an existing block textually is not safe. The text is unchanged.
   - **Checks before writing:** the new text must load to a document that passes `validateConfig`, otherwise the result is an error. The original text must still appear byte-for-byte at the start of the new text, so comments and formatting survive.
   - **Writing:** the caller writes atomically (temp file plus rename) and only when `seeded` is non-empty.
4. **`rad install-preset --source <dir> --target <dir>`** (`--target` defaults to the repo root).
   - **Exit 2, with nothing written** (no file, no backup, no manifest, no config):
     - bad argv;
     - an invalid preset (AC#1);
     - no `.rad/installed.json` in the target (core must be installed first), or a malformed one;
     - a missing or invalid `.rad/config.yml`;
     - any conflict (each path is printed with its owning layer);
     - a different preset `name` already recorded (switching presets is out of scope; the message names the installed preset).
   - **Otherwise**, it applies the file actions and seeds the settings, and reports with the `rad install-preset:` prefix:
     - the same per-file action lines as install-core;
     - per-setting lines `seeded: <key>`, `kept: <key>` and `unseeded: <key> (settings: block exists; add it by hand)`.
   - **Exit codes:** 0 when everything was written or seeded, 1 when any file is `keep`/`deleted` or any setting is `unseeded`.
   - **Re-running** the same preset is idempotent: exit 0, no changes, all `write`/`kept`.
5. **`rad install-status`** prints `preset: <name> <version> (<source>)` before any drift lines when the manifest records a preset. Exit codes are unchanged; this line is informational only.
6. **Suites stay green:**
   - `npm test --prefix harness`;
   - `node --test harness/evals/*.eval.js`;
   - every `scripts/test-*.sh` under both `bash` and `/bin/bash`;
   - `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

One Explore agent (read-only) mapped:
- `install-manifest.js` (current line numbers);
- the install-core and install-status handlers in `cli.js`;
- the `config.js` load, validate and serialize seam, and the non-atomic config writes;
- the vendored YAML reader;
- `install.sh` (for 2c);
- the docs (for 2c);
- the install tests;
- what core ships under each allowed root.

The current anchors were then spot-checked directly. No architect-only mapper agents were used, and there are no out-of-scope dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/preset.js | 1-180 | New: `PRESET_ROOTS`, `readPreset` |
| harness/install-manifest.js | 20-60 | Constants; export `CORE_LAYER` if needed by callers |
| harness/install-manifest.js | 105-130 | Export `isSafeRelPath`; validate optional `preset` block |
| harness/install-manifest.js | 150-291 | Layer-generic plan/apply; core wrappers; `buildManifest` keeps `preset` |
| harness/config.js | 120-150 | Export `settingsErrors` |
| harness/config.js | 355-393 | `seedSettings` (append-only text edit, validated) |
| harness/cli.js | 60-70 | `INSTALL_PRESET_USAGE` |
| harness/cli.js | 120-140 | Registry entry `install-preset` |
| harness/cli.js | 3165-3352 | `installPresetCommand`; atomic config write; install-status preset line |
| harness/test/preset.test.js | 1-220 | New: reader validation cases |
| harness/test/install-manifest.test.js | 390-520 | Layer install, preset metadata carry, core wrapper parity (append) |
| harness/test/config.test.js | 545-640 | `seedSettings` cases (append) |
| harness/test/cli.test.js | 2390-2540 | `install-preset` end-to-end and status line (append) |

## Execution Notes

### Do Not Touch
- `listCoreFiles`, `CORE_TREES`, `CORE_FLAT`. What core owns does not change.
- `decideAction` semantics, `MANIFEST_VERSION`, the backup and pending dir layout.
- `serializeConfig`, `configInit`, `configMigrate`.
- `install.sh`, INSTALL.md, UPGRADE.md, `docs/` (plan 2c).
- `harness/gates.js`, `harness/events.js`, `harness/spine.js`, `scripts/`.

### Key Files
- `harness/install-manifest.js`: everything; the core path is the model for the layer path.
- `harness/config.js`: `loadConfig` (lazy js-yaml import), `settingsErrors`, the `scalar` quoting helper, `validateConfig`.
- `harness/cli.js`: `parseInstallFlags`, `installReportLines`, `installSummaryLine`, `reportInstallConflicts`, `installCoreCommand`, `installStatusCommand`.

### Reminders
- **Never write partially.** Every exit-2 path is decided before the first write. A failed config validation after the files are applied is not acceptable, so validate the seeded text before calling apply.
- **Never follow a symlink** in a preset tree, and never accept `..` segments.
- **Shared report helpers:** generalize the `rad install-core:` prefix in the report helpers by passing it in. Do not duplicate them.
- No en dashes.
- `harness/` triggers the self-protected advisory by design.

## Wave Plan

### Wave 1 — sequential
Task 1.2 imports `isSafeRelPath`, which Task 1.1 exports.

#### Task 1.1: Layer-generic manifest install
File: harness/install-manifest.js:20-60, harness/install-manifest.js:105-130, harness/install-manifest.js:150-291, harness/test/install-manifest.test.js:390-520
What: Implement AC#2. Export `isSafeRelPath`.
Validate: AC#2. Edge cases:
- a preset path recorded as core (conflict);
- a preset path the target already has with no baseline (`backup-write`);
- a locally edited preset file (`keep`, staged);
- a file the preset dropped (stale, file left on disk);
- `install-core` after a preset install keeps both the preset entries and the `preset` metadata;
- a malformed `preset` block (missing `source`, non-object);
- the existing core tests are unedited and still pass.

Command: `npm test --prefix harness`.

#### Task 1.2: Preset reader and settings seeding
File: harness/preset.js:1-180, harness/config.js:120-150, harness/config.js:355-393, harness/test/preset.test.js:1-220, harness/test/config.test.js:545-640
What: Implement AC#1 and AC#3. `readPreset` imports `isSafeRelPath` from `install-manifest.js`, which Task 1.1 exports.
Validate: AC#1, AC#3. Edge cases:
- **Reader:**
  - a missing `preset.yml`;
  - YAML that is not a mapping;
  - an unknown key;
  - a bad name (uppercase, leading `-`, empty);
  - an empty version;
  - an invalid settings value;
  - a symlink in `files/`;
  - a file under a non-allowed root (`harness/x.js`, `.rad/config.yml`, a top-level `README.md`);
  - an empty preset;
  - settings only (valid);
  - files only (valid).
- **Seeding:**
  - config with no `settings:` block;
  - config ending without a newline;
  - `settings:` already present with the same key (kept);
  - `settings:` present but missing the key (unseeded, text unchanged);
  - comments preserved byte-for-byte;
  - a seeded pattern containing YAML metacharacters round-trips;
  - nothing to seed (text unchanged).

Command: `npm test --prefix harness`.

### Wave 2 — sequential
This wave depends on the Wave 1 APIs.

#### Task 2.1: rad install-preset and the status line
File: harness/cli.js:60-70, harness/cli.js:120-140, harness/cli.js:3165-3352, harness/test/cli.test.js:2390-2540
What: Implement AC#4 and AC#5.
Validate: AC#4, AC#5, AC#6. Edge cases:
- **Exit 2, target tree byte-identical (hash it before and after):** no manifest; no config; invalid config; a conflict with a core path; a different installed preset name; bad argv (missing `--source`, unknown flag).
- a fresh install writes files and seeds settings (exit 0);
- an immediate re-run is idempotent (exit 0, nothing changed);
- an edited preset file is kept (exit 1, staged);
- `settings:` exists so a key stays unseeded (exit 1, config text unchanged);
- install-status shows the `preset:` line;
- `install-core` run afterwards keeps the preset metadata and entries.

Commands:
- `npm test --prefix harness`;
- `node --test harness/evals/*.eval.js`;
- every `scripts/test-*.sh` under both shells;
- `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`.

## Tests to Write
- [ ] preset reader validation — harness/test/preset.test.js
- [ ] seedSettings append, kept, unseeded, comment preservation — harness/test/config.test.js
- [ ] layer install, conflicts, stale, preset metadata carry, core parity — harness/test/install-manifest.test.js
- [ ] install-preset end-to-end, fail-closed exits, idempotence, status line — harness/test/cli.test.js

## Non-Goals
- Removing an installed preset, or switching from one preset to another.
- Stacking several presets.
- Inserting a key into an existing `settings:` block. It is reported as `unseeded` instead.
- Any change to `install.sh`, the shipped example preset or the docs (plan 2c).

## Out-of-Scope Dependencies
None.

## Risks
- **The manifest gains a top-level key.** Older code ignores unknown top-level keys (`manifestShapeError` checks only `version` and `files`), so an older `install-core` reading a newer manifest still works, but it would drop the `preset` block on rewrite. This only matters when downgrading.
- **`source` is an absolute path** and is machine-specific. Plan 2c's upgrade re-apply must handle a source that doesn't exist on another machine; until then the path is recorded and reported only.
- **Backup-write onto a user file.** `.claude/agents/` and `docs/` aren't core trees, so a preset file can land on a user's hand-made file that has no baseline. That goes through `backup-write` (the original is backed up), the same as core.

## Issue Gaps
- **Assumption:** the rest of part 2b (`install.sh --preset`, upgrade re-apply, `presets/example/`, docs) moves to plan 2c to fit the 1,500-line budget.
- **Assumption:** `install-preset` requires an existing install manifest and `.rad/config.yml` (core first), and exits 2 otherwise.
- **Assumption:** if `.rad/config.yml` already has a `settings:` block, missing preset keys are reported as `unseeded` (exit 1), never inserted. This keeps every config write append-only.
- **Assumption:** installing a preset with a different `name` from the recorded one exits 2. Switching presets is out of scope.
- **Assumption:** files the preset no longer ships are dropped from the manifest and left on disk, the same as core stale entries.
- **Assumption:** the preset's `version` is a free-form string, recorded and displayed but never compared.
