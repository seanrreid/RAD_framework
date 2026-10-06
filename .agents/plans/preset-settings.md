# Plan: Config-Backed Settings and a Layer-Aware Manifest (#71 part 2a)
Created: 2026-10-06
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-06T14:30:38.319Z
Recorded-By: sean@torchcodelab.com
Branch: rad/preset-settings
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/71
Issue-Title: Layered packaging model for portable RAD distribution: core → presets → project overrides (spec-kit bundles analog)

## Context

Part 1 (#180) shipped the install manifest. `.rad/installed.json` records `{ layer, sha256 }` per file, but only ever writes `layer: core` (`harness/install-manifest.js:34-35`).

Part 2 adds presets. A preset is a directory in a git repo that seeds setting defaults into `.rad/config.yml` and adds files that are recorded with `layer: preset`. It is split into two plans:
- **This plan (2a)** builds the groundwork that presets need.
- **Plan 2b** adds `rad install-preset`, `install.sh --preset <dir>`, an example preset, and the install and upgrade docs.

Research turned up two blockers that this plan removes:
- **Settings are env-only.** The two settings a preset most needs, the high-risk pattern (`RAD_HIGH_RISK_PATTERNS`, `scripts/lib/plan-paths.sh:365-367`) and the hooks dir (`RAD_HOOKS_DIR`, `harness/cli.js:192-202, 1266-1276`), cannot be read from `.rad/config.yml` today. The config schema also rejects unknown keys (`harness/config.js:139-149`), and `serializeConfig` (308-329) drops any key it doesn't know, so init and migrate would silently lose a new key.
- **Stale detection drops non-core entries.** `planInstall` (`harness/install-manifest.js:160-178`) marks every recorded path outside the core set as stale, and `buildManifest` (199-206) rewrites only core actions. A core upgrade after a preset install would therefore erase every preset entry from the manifest.

Decisions (2026-10-06, recorded on #71):
- Only `high_risk_patterns` and `hooks_dir` become config-backed in this increment.
- Precedence is env var (non-empty) → `.rad/config.yml` `settings:` → built-in default.
- Preset files may only add paths that core does not own. A collision is refused.
- When a preset seeds settings, it fills absent keys only (plan 2b). Project edits always win.

**Amendment 1 (2026-10-06, during delivery, after Wave 2):** two existing shell tests encoded behaviour this plan deliberately changes, so they had to be updated:
- `scripts/test-install-harness.sh` matched the old `modified: <path>` line. install-status now prints the layer, in the form `modified: [<layer>] <path>`, keeping the existing colon.
- `scripts/test-lint-plan.sh` case `FCE(a)` expected `lint-plan.sh` to exit 0 on an invalid `.rad/config.yml`. Under AC#2 an invalid config makes the high-risk pattern unresolvable, so lint fails closed with exit 1. The freshness advisory is still reported.
Both files are added to Files in Scope, and AC#5's status-line format is corrected to the colon form.

## Scope

| In scope | Out of scope |
|---|---|
| An optional `settings:` block in `.rad/config.yml` with `high_risk_patterns` and `hooks_dir`, validated fail-closed and round-tripped by `serializeConfig` | The other `RAD_*` env vars (branch prefix, token budget, failed-attempt cap, verify timeout) |
| Env → config → default resolution for both settings (shell and JS) | The preset directory format, `rad install-preset`, `install.sh --preset` (plan 2b) |
| `rad config settings`: each setting's effective value and its source layer | `RAD_LOW_RISK_PATTERNS` (not implemented anywhere today) |
| Layer-aware `planInstall`/`buildManifest`/`install-status`; install-core refuses to take over a path another layer owns | Making the plan template overridable (it is inline in `rad-plan.md`) |
| Docs: `docs/configuration.md`, `.env.example`, `docs/invariants.yaml` | INSTALL.md / UPGRADE.md preset sections (plan 2b) |

## Acceptance Criteria

1. **Schema.** `.rad/config.yml` accepts an optional top-level `settings:` mapping with the keys `high_risk_patterns` and `hooks_dir`.
   - `rad config validate` rejects each of these with a message naming the key:
     - an unknown key under `settings:`;
     - a value that is not a non-empty string;
     - a `hooks_dir` matching the existing malformed rule (leading `-` or a line break, `MALFORMED_HOOKS_DIR`);
     - a `high_risk_patterns` value with a line break.
   - A config without `settings:` validates and serializes byte-identically to today.
   - `serializeConfig` writes `settings:` back when present, in fixed key order, and the result loads to the same document.
2. **High-risk pattern resolution.** `plan_high_risk_pattern` (`scripts/lib/plan-paths.sh`) prints, in order of precedence:
   1. `RAD_HIGH_RISK_PATTERNS` when set and non-empty;
   2. `settings.high_risk_patterns` from `.rad/config.yml`, read through `node <lib>/../../harness/cli.js config get settings.high_risk_patterns` (the single config reader);
   3. otherwise `RAD_HIGH_RISK_DEFAULT_PATTERN`.

   How each config-read outcome is handled:
   - **Fallback to the default:** exit 3 (key absent), or no `.rad/config.yml` at all. Falling back here cannot weaken the check, because the default is the documented baseline.
   - **Error:** an invalid config, any other non-zero exit, or exit 0 with no output. The function prints the reason on stderr and returns non-zero. `lint-plan.sh` and `check-approval-blockers.sh` then fail closed with that reason instead of linting with a guessed pattern.
   - **Unchanged:** `plan_high_risk_pattern_is_default` keeps comparing the effective pattern. A config-supplied non-default pattern is therefore frozen into `approved.data.highRiskPattern` and shown in the CI advisory exactly as an env override is today.
3. **Hooks dir resolution.** `resolveHooksDir(env, root, settings)` (`harness/cli.js`) returns, in order of precedence:
   1. `RAD_HOOKS_DIR` when non-empty;
   2. `settings.hooks_dir` resolved against `root`;
   3. otherwise `<root>/scripts/hooks`.

   - A malformed value from either source is a usage error that exits 2 before any event. The message names the source: `RAD_HOOKS_DIR` or `settings.hooks_dir in .rad/config.yml`.
   - Both deliver call sites (preflight check ~1421, run wiring ~1464) pass the loaded settings.
   - An invalid `.rad/config.yml` makes `rad deliver` exit 2 before any event. A missing config file means "no settings".
4. **Settings inspection.** `rad config settings` prints one line per setting: `<key>\t<source>\t<value>`.
   - `<source>` is one of `env`, `config` or `default`.
   - For `default`, the value column is `(built-in)`. The JS side never copies the shell default pattern.
   - Exits 0 when every setting resolves, and 2 on an invalid config (nothing printed to stdout). A missing config means every non-env setting reports `default`.
   - It is added to `CONFIG_USAGE` and `CONFIG_ACTIONS`.
5. **Layer-aware manifest.** Changes in `harness/install-manifest.js`:
   - `planInstall` reports as `stale` only entries whose `layer` is `core` and whose path core no longer ships.
   - `buildManifest` carries over every non-core entry (`layer` ≠ `core`) unchanged.
   - Neither function may lose a preset entry.
   - If a path recorded under a non-core layer appears in the core set, `planInstall` returns it as `conflicts`. `rad install-core` then exits 2 naming each path and writes nothing: no file, no backup, no manifest.
   - `rad install-status` labels each drifted path with its layer (`modified: [preset] <path>`, amendment 1).
   - `CORE_LAYER` stays the only layer this module writes. A named `PRESET_LAYER = 'preset'` constant is exported for plan 2b.
6. **Docs:**
   - `docs/configuration.md` documents the `settings:` block, the env → config → default precedence, and `rad config settings`. Its High-Risk Paths and Hooks sections each gain the config key.
   - `.env.example` notes that both vars can be set in `.rad/config.yml`.
   - In `docs/invariants.yaml`, the `high-risk-patterns-override` and `empty-hooks-dir` bypass surfaces name the config key as well. A `settings`-resolution anchor (`plan_high_risk_pattern` in `scripts/lib/plan-paths.sh`) is added to `approval-blockers-refuse`. `scripts/lint-invariants.sh` passes.
7. **Suites stay green:**
   - `npm test --prefix harness`;
   - `node --test harness/evals/*.eval.js`;
   - every `scripts/test-*.sh` under both `bash` and `/bin/bash`;
   - `scripts/lint-shell-safety.sh`, `scripts/lint-invariants.sh`, `scripts/lint-plan.sh` on this plan.

## Agent Scope

One Explore agent (read-only) mapped the install manifest, the install-core/status handlers, `install.sh`, the config schema and serializer, every `RAD_*` setting's read site, the docs and the test files. Anchors were then spot-checked directly. No architect-only mapper agents were used, and there are no out-of-scope dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/config.js | 20-30 | `SETTINGS_KEYS` constant, `settings` in `TOP_LEVEL_KEYS` |
| harness/config.js | 100-150 | `settingsErrors`, wired into `validateConfig` |
| harness/config.js | 300-330 | `serializeConfig` writes `settings:` when present |
| harness/cli.js | 60-70 | `CONFIG_USAGE` gains `settings` |
| harness/cli.js | 190-202 | Hooks-dir constants and source labels |
| harness/cli.js | 1266-1280 | `resolveHooksDir(env, root, settings)` |
| harness/cli.js | 1405-1470 | Load settings once; both deliver call sites |
| harness/cli.js | 2803-2850 | `configSettings` (`rad config settings`) |
| harness/cli.js | 2985-3016 | `CONFIG_ACTIONS` |
| harness/cli.js | 3160-3225 | install-core conflict exit 2; install-status layer label |
| harness/install-manifest.js | 30-50 | `PRESET_LAYER` constant |
| harness/install-manifest.js | 155-256 | Layer-aware `planInstall`, `buildManifest`, `installDrift` |
| scripts/lib/plan-paths.sh | 270-280 | Comment: the default is also the config fallback |
| scripts/lib/plan-paths.sh | 355-380 | `plan_high_risk_pattern` reads `settings.high_risk_patterns` |
| scripts/lint-plan.sh | 278-292 | Fail closed when `plan_high_risk_pattern` fails |
| scripts/check-approval-blockers.sh | 115-130 | Fail closed when `plan_high_risk_pattern` fails |
| harness/test/config.test.js | 430-520 | Settings schema and round-trip tests (append) |
| harness/test/cli.test.js | 1210-1240 | resolveHooksDir precedence tests |
| harness/test/cli.test.js | 2180-2280 | `rad config settings`, install-core conflict, status layer tests (append) |
| harness/test/install-manifest.test.js | 260-360 | Layer-aware stale, carry-over, conflict tests (append) |
| scripts/test-plan-paths.sh | 380-400 | Existing env cases stay; config-precedence cases |
| scripts/test-plan-paths.sh | 720-800 | Config-backed pattern fixture cases (append) |
| scripts/test-install-harness.sh | 270-280 | Amendment 1: expect the layer-labelled install-status line |
| scripts/test-lint-plan.sh | 1085-1120 | Amendment 1: FCE(a) expects exit 1 (invalid config fails the high-risk scan closed) |
| docs/configuration.md | 15-95 | `settings:` schema, `rad config settings` |
| docs/configuration.md | 415-500 | High-Risk Paths and Hooks: config key and precedence |
| .env.example | 55-75 | Note the config-key alternative |
| docs/invariants.yaml | 55-70 | `high-risk-patterns-override` surface and anchor |
| docs/invariants.yaml | 159-175 | `empty-hooks-dir` surface |

## Execution Notes

### Do Not Touch
- `RAD_HIGH_RISK_DEFAULT_PATTERN` itself. Its value and its single-copy rule (plan-paths.sh:271-279) do not change.
- The self-protected-path check (plan-paths.sh ~570-600). It stays independent of every setting.
- `decideAction`, `applyInstall` backup and staging behaviour, the manifest file format version.
- `install.sh` (plan 2b), `INSTALL.md`, `UPGRADE.md`.
- `harness/gates.js`, `harness/events.js`, `harness/spine.js`.

### Key Files
- `harness/config.js`: `capabilitiesErrors` and the capabilities line in `serializeConfig` are the pattern to copy for an optional block.
- `scripts/get-default-branch.sh`: the fail-closed `config get` idiom (exit 3 means absent; exit 0 with empty output is an error) to reuse in plan-paths.sh.
- `harness/install-manifest.js`: `planInstall`, `buildManifest`, `installDrift`.
- `harness/cli.js`: `resolveHooksDir`, `configGet`, `installCoreCommand`, `installStatusCommand`.

### Reminders
- **Never swallow a config-read failure.** Only "key absent" and "no config file" fall back to the default.
- **Shell config tests need a fixture repo.** `plan-paths.sh` finds the CLI relative to its own location, and the CLI reads `.rad/config.yml` from its own repo root. Build a temp tree with copies of `harness/` and `scripts/lib/` plus a fixture `.rad/config.yml`, and source the copied `plan-paths.sh`. Never write to this repo's `.rad/config.yml`.
- **Keep bash 3.2 compatibility.** No en dashes.
- `harness/`, `scripts/` and `.rad/`-adjacent paths trigger the self-protected advisory by design.

## Program Design

### Signatures
- `harness/config.js`: `SETTINGS_KEYS` (frozen array) and `settingsErrors(settings) → string[]`. `validateConfig` and `serializeConfig` keep their existing signatures.
- `harness/install-manifest.js`:
  - `PRESET_LAYER = 'preset'` (exported);
  - `planInstall(...) → { actions, stale, conflicts }`;
  - `installDrift(...) → { modified: {path, layer}[], missing: {path, layer}[] }`.
- `harness/cli.js`: `resolveHooksDir(env, root, settings = {}) → { ok, dir } | { ok: false, raw, source }` and `configSettings(args, repoRoot) → exit code`.
- `scripts/lib/plan-paths.sh`: `plan_high_risk_pattern` prints the pattern and returns 0, or returns 1 with the reason on stderr.

### Call stack
```
rad deliver → loadConfig (once) → resolveHooksDir(env, root, doc.settings) ×2
lint-plan.sh / check-approval-blockers.sh → plan_high_risk_pattern
    → env? → node harness/cli.js config get settings.high_risk_patterns (exit 0 | 3 | other)
rad install-core → planInstall → conflicts? exit 2 : applyInstall → buildManifest (carry non-core)
rad config settings → loadConfig → per key: env | config | default
```

### File tree
No new files. Every change edits an existing file.

## Wave Plan

### Wave 1 — parallel
These tasks touch disjoint files.

#### Task 1.1: settings schema and serializer
File: harness/config.js:20-30, harness/config.js:100-150, harness/config.js:300-330, harness/test/config.test.js:430-520
What: Implement AC#1. Add `SETTINGS_KEYS = ['high_risk_patterns', 'hooks_dir']` and `settingsErrors` (fail-closed, modelled on `capabilitiesErrors`), wire it into `validateConfig`, and have `serializeConfig` write `settings:` only when present.
Validate: AC#1. Edge cases:
- `settings` is not a mapping;
- `settings` is an empty mapping;
- an unknown key;
- a non-string or empty value;
- a `hooks_dir` that starts with `-` or contains a newline;
- a pattern containing a newline;
- the round-trip is identical when `settings` is absent;
- the round-trip is lossless when `settings` is present.

Command: `npm test --prefix harness`.

#### Task 1.2: Layer-aware manifest
File: harness/install-manifest.js:30-50, harness/install-manifest.js:155-256, harness/test/install-manifest.test.js:260-360
What: Implement the `harness/install-manifest.js` part of AC#5:
- `stale` covers core-layer entries only;
- non-core entries are carried over unchanged;
- `conflicts` lists non-core paths that core now ships;
- `installDrift` returns each path's layer;
- export `PRESET_LAYER`.
Validate: AC#5. Edge cases:
- the manifest has only preset entries;
- a preset entry whose file was deleted (it is still carried over, and install-status reports it missing);
- a core entry that core dropped (still stale);
- a conflict path;
- an entry with an unknown layer string (treated as non-core and carried over);
- the manifest is `null`, i.e. a first install.

Command: `npm test --prefix harness`.

### Wave 2 — sequential
These tasks depend on the Wave 1 schema and manifest API.

#### Task 2.1: Hooks dir, rad config settings, install-core conflict
File: harness/cli.js:60-70, harness/cli.js:190-202, harness/cli.js:1266-1280, harness/cli.js:1405-1470, harness/cli.js:2803-2850, harness/cli.js:2985-3016, harness/cli.js:3160-3225, harness/test/cli.test.js:1210-1240, harness/test/cli.test.js:2180-2280
What: Implement AC#3, AC#4 and the CLI part of AC#5:
- `resolveHooksDir` gains a `settings` argument, with error messages that name the source;
- `rad deliver` loads the config once, before setup;
- add the `configSettings` action;
- `installCoreCommand` exits 2 on `conflicts` and writes nothing;
- `installStatusCommand` prints the layer label.
Validate: AC#3, AC#4, AC#5. Edge cases:
- env set and config set (env wins);
- env empty and config set (config wins);
- neither set (default);
- a malformed config value;
- no config file;
- an invalid config file;
- `config settings` called with extra args (usage error, exit 2);
- an install-core conflict leaves the target byte-identical.

Command: `npm test --prefix harness`, `node --test harness/evals/*.eval.js`.

#### Task 2.2: Config-backed high-risk pattern
File: scripts/lib/plan-paths.sh:270-280, scripts/lib/plan-paths.sh:355-380, scripts/lint-plan.sh:278-292, scripts/check-approval-blockers.sh:115-130, scripts/test-plan-paths.sh:380-400, scripts/test-plan-paths.sh:720-800
What: Implement AC#2. `plan_high_risk_pattern` falls back to `config get settings.high_risk_patterns` using the `get-default-branch.sh` exit-code idiom. Its two callers fail closed on a non-zero return, and the fixture-repo tests cover each outcome.
Validate: AC#2. Edge cases:
- env set (config is not consulted);
- env empty with the config key set;
- the config key absent (exit 3);
- no config file;
- an invalid config (the helper fails, and lint-plan exits non-zero naming the reason);
- the CLI exits 0 with no output;
- a config-supplied pattern equal to the default (`_is_default` is true).

Command: every `scripts/test-*.sh` under both `bash` and `/bin/bash`; `scripts/lint-shell-safety.sh`.

### Wave 3 — sequential
This wave documents the behaviour shipped in Waves 1 and 2.

#### Task 3.1: Docs and invariants
File: docs/configuration.md:15-95, docs/configuration.md:415-500, .env.example:55-75, docs/invariants.yaml:55-70, docs/invariants.yaml:159-175
What: Implement AC#6.
Validate: AC#6, AC#7. `scripts/lint-invariants.sh`, `scripts/test-lint-invariants.sh`, and the full suite list from AC#7. No new testable surface beyond the invariant lint.

## Tests to Write
- [ ] settings schema, validation and round-trip — harness/test/config.test.js
- [ ] layer-aware stale, carry-over, conflicts, drift layer — harness/test/install-manifest.test.js
- [ ] resolveHooksDir precedence; `rad config settings`; install-core conflict exit 2; install-status layer label — harness/test/cli.test.js
- [ ] config-backed high-risk pattern precedence and fail-closed cases — scripts/test-plan-paths.sh

## Non-Goals
- Config-backing any setting other than `high_risk_patterns` and `hooks_dir`.
- Installing, applying or seeding a preset. No command in this plan writes a `layer: preset` entry.
- A general "settings registry" abstraction over every `RAD_*` var. Two settings don't justify one.
- Changing what the default high-risk pattern matches.

## Out-of-Scope Dependencies
None.

## Risks
- **A gate script gains a node dependency.** `lint-plan.sh` and `check-approval-blockers.sh` now call the CLI when the env var is unset. Both already run where the harness is installed (`check-approval-blockers.sh` is called from `rad approve`), and `install.sh` already requires node.
- **Fail-closed lint in repos with an invalid config.** A broken `.rad/config.yml` now stops `lint-plan.sh` as well. This is intended (#175 precedent), and the error names the config problem.
- **Approval freeze.** A narrowed pattern set in the config is frozen into the approved event just like an env override. A config change after approval does not retroactively change a recorded approval. The existing CI advisory surfaces it.
- **Plan size.** `harness/cli.js` has several ranges. Lint budget is checked below.

## Issue Gaps
- **Assumption:** a missing `.rad/config.yml` means "no settings" (default) for both settings, rather than an error. Rationale: the built-in high-risk default is the strictest documented baseline, and a missing hooks dir already means the convention dir. This differs from `get-default-branch.sh`, which fails on a missing config.
- **Assumption:** a non-core manifest path that core starts shipping is a hard conflict (exit 2), never a silent takeover. This is the mirror image of the add-only preset rule.
- **Assumption:** unknown `layer` strings are treated as non-core and carried over, never dropped.
- **Assumption:** the `settings:` key names are snake_case without the `RAD_` prefix (`high_risk_patterns`, `hooks_dir`), matching the existing config style.
