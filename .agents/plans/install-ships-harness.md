# Plan: Install Ships the Harness
Created: 2026-06-21
Author: architect
Status: pending-review
Branch: rad/install-ships-harness

## Context
The installer copies commands, skills, `scripts/*.sh`, and `ai/` but never ships
`harness/`. Because `/rad-approve` writes the `approved` event via `node
harness/cli.js approve` and `/rad-deliver` reads it via `check-plan-approved.sh →
rad gate`, an installed project has no working gate authority: approval can't be
recorded and deliver fails closed. Separately, `cli.js` eagerly imports the 223M
Agent SDK, so even the pure-determinism gate/approve paths won't run unless the
SDK is installed — contradicting the BYO principle. This plan ships the harness
source (~384K), vendors js-yaml (108K) so the gate path needs zero npm, and makes
the SDK a lazy, opt-in dependency.

## Scope
| In scope | Out of scope |
|---|---|
| `install.sh` ships `harness/` + `scripts/hooks/` into target projects | Refactoring the spine, matrix vocabulary, or gate fold logic |
| Vendor `js-yaml.mjs` into harness; repoint `gates.js` / `matrix.js` | Changing `sdk.js` internals (only its load timing) |
| Lazy-load SDK adapter in `cli.js`; SDK → `optionalDependencies` | Scaffolding `.agents/state/` & `.agents/epics/` dirs at install (runtime-created) |
| Update installer next-steps `git add` + info text | A global/symlinked `rad` CLI (per-project ship is the chosen model) |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. After installing into a fresh project, `harness/` source is present and `node harness/cli.js gate <feature> approved --stdin` exits 0 for an approved event with **no `node_modules`** and **no Agent SDK** installed.
2. The installer copies `scripts/hooks/` (its `README.md` and the `on-error/` + `post-wave/` subdirs) into the target project.
3. `harness/cli.js` loads and `rad gate` / `rad approve` run with the Agent SDK absent; `sdk.js` is imported only on the `RAD_AGENT=sdk` branch via dynamic `import()`.
4. `@anthropic-ai/claude-agent-sdk` is declared under `optionalDependencies` (not `dependencies`) in `harness/package.json`, so a default install does not pull the 223M SDK.
5. `gates.js` and `matrix.js` import the vendored `harness/vendor/js-yaml.mjs` (no runtime dependency on the `js-yaml` package), and the existing harness test suite (`gates`, `matrix`, `deliver`, `cli`) passes.
6. `install.sh` `print_next_steps` `git add` line and info text include `harness/` (and `ai/`), so the documented install commit captures the shipped CLI.

## Agent Scope
Research delegated to one Explore sub-agent (read-only). No architect-only agents
from the Agent Scope Map are required — this is installer + harness plumbing, not
hook/spine surface work.

## Files in Scope
<!-- Lines: range or single number. Linter sums these for context budget. -->
| File | Lines | Change |
|------|-------|--------|
| install.sh | 324 | Add `copy_harness` step (ship `harness/` + recursive `scripts/hooks/`); update `print_next_steps` git-add + info text |
| harness/cli.js | 336-394 | Make the `sdk.js` import dynamic on the `RAD_AGENT=sdk` branch; remove the static import (line 29) |
| harness/gates.js | 20-50 | Repoint `js-yaml` import → `./vendor/js-yaml.mjs` |
| harness/matrix.js | 15-42 | Repoint `js-yaml` import → `./vendor/js-yaml.mjs` |
| harness/package.json | 22 | SDK → `optionalDependencies`; `js-yaml` → `devDependencies` |
| harness/vendor/js-yaml.mjs | 1 | NEW — vendored 108K ESM bundle, copied from `dist/`, not authored/read |

## Execution Notes

### Do Not Touch
- harness/adapters/agent/sdk.js — internals unchanged; only its *load timing* changes (controlled from `cli.js`).
- harness/adapters/git-state-store.js — its comments already document lazy gates import; do not edit.
- harness/test/cli.test.js, harness/test/agent-adapters.test.js — no changes needed (injected `ctx.runWave` keeps tests hermetic).

### Key Files
- harness/cli.js — line 29 static import + the `deliverCommand` `RAD_AGENT` branch (~336-394) where `createRunWave` is constructed only when `agentKind === 'sdk'`.
- install.sh — the `copy_*` function sequence (`create_dirs → … → copy_agents_meta → print_next_steps`); new step slots after `copy_agents_meta`.
- harness/node_modules/js-yaml/dist/js-yaml.mjs — vendor source (self-contained, zero transitive deps).

### Reminders
- The vendored file is a verbatim copy of `dist/js-yaml.mjs` — do not hand-edit it. Record its js-yaml version (4.1.1) in a sibling note or import comment for future regeneration.
- `cli.js` line 32 imports `loadMatrix` statically — leave it; `matrix.yaml` is needed on all paths, and after repointing it loads via the vendored bundle (no npm).
- Vendoring (Wave 1) must land before repointing imports (Wave 2), or the import target won't exist.
- `install.sh` runs `set -euo pipefail`; new copy step must succeed or fail loudly. Respect the `--upgrade` flag (harness is framework code — overwrite like `ai/`).

## Wave Plan

### Wave 1 — parallel
Tasks touch three different files (`vendor/`, `cli.js`, `package.json`) and can run in parallel.

#### Task 1.1: Vendor the js-yaml bundle
File: harness/vendor/js-yaml.mjs
What: Create `harness/vendor/` and copy `node_modules/js-yaml/dist/js-yaml.mjs` into it verbatim. Add a short `vendor/README.md` note recording source (js-yaml 4.1.1, `dist/js-yaml.mjs`) and regeneration command.
Validate: AC#5 — the vendored bundle exists and is the self-contained ESM build.

#### Task 1.2: Lazy-load the SDK adapter in cli.js
File: harness/cli.js:29,336-394
What: Remove the static `import { createRunWave } from './adapters/agent/sdk.js'` (line 29). Inside `deliverCommand`, on the `agentKind === 'sdk'` branch only, do `const { createRunWave } = await import('./adapters/agent/sdk.js')` before constructing the adapter. Command-adapter and gate/approve paths never reach the import.
Validate: AC#3 — `cli.js` loads and `rad gate`/`rad approve` run with the SDK absent.

#### Task 1.3: Reclassify dependencies in package.json
File: harness/package.json:18-21
What: Move `@anthropic-ai/claude-agent-sdk` from `dependencies` to a new `optionalDependencies` block. Move `js-yaml` from `dependencies` to `devDependencies` (still used to regenerate the vendored bundle / for provenance; no longer a runtime import).
Validate: AC#4 — SDK is under `optionalDependencies`; default install pulls no SDK.

### Wave 2 — parallel
Depends on: Wave 1 complete (vendored file must exist). The two repoints touch different files.

#### Task 2.1: Repoint gates.js to the vendored bundle
File: harness/gates.js:20
What: Change `import yaml from 'js-yaml'` to import from `./vendor/js-yaml.mjs`. No logic change to `loadGates`.
Validate: AC#5 — `gates.js` uses the vendored bundle; gate tests pass.

#### Task 2.2: Repoint matrix.js to the vendored bundle
File: harness/matrix.js:15
What: Change `import yaml from 'js-yaml'` to import from `./vendor/js-yaml.mjs`. No logic change to `loadMatrix`.
Validate: AC#5 — `matrix.js` uses the vendored bundle; matrix tests pass.

### Wave 3 — sequential
Depends on: Waves 1-2 complete (harness now zero-npm-runnable). Both tasks edit `install.sh`.

#### Task 3.1: Ship harness + hooks in install.sh
File: install.sh:158-186
What: Add a `copy_harness` function (after `copy_agents_meta`) that `cp -r "$RAD_DIR/harness" "$TARGET_DIR/"` excluding `node_modules` (framework code — overwrite on install and upgrade, like `ai/`), and that `cp -r "$RAD_DIR/scripts/hooks" "$TARGET_DIR/scripts/"` to ship the hooks convention dir + subdirs. Wire it into `main()`.
Validate: AC#1 — installed project has `harness/` and `rad gate` runs zero-npm; AC#2 — `scripts/hooks/` present.

#### Task 3.2: Update next-steps git-add and info text
File: install.sh:250-290
What: Add `harness/` (and `ai/`) to the `git add` line in `print_next_steps` (line ~281) and add an info/success line for the harness in the install output. Update stale `copy_commands`/`copy_skills` info text if it omits new commands/skills.
Validate: AC#6 — documented install commit includes `harness/` and `ai/`.

### Wave 4 — parallel
Depends on: Waves 1-3 complete. Verification only.

#### Task 4.1: Run the harness test suite
File: harness/test (run, no edit)
What: `cd harness && node --test` — confirm `gates`, `matrix`, `deliver`, `cli` suites pass after the vendored-yaml repoint and the lazy SDK import.
Validate: AC#5 — existing suite green; AC#3 — cli loads without SDK.

#### Task 4.2: Fresh-install smoke test
File: (temp dir, no repo edit)
What: Install into a temp git repo via `install.sh --dir`, then with **no `node_modules`** run `node harness/cli.js gate <feature> approved --stdin` against a synthetic approved event and confirm exit 0; confirm `scripts/hooks/` copied.
Validate: AC#1 — zero-npm gate works post-install; AC#2 — hooks shipped.

## Tests to Write
- [ ] Fresh-install smoke check (zero-npm `rad gate` exit 0) — `scripts/test-install-harness.sh` (new) or manual per Task 4.2
- [ ] Confirm `gates.js`/`matrix.js` load via vendored bundle — covered by existing `harness/test/gates.test.js`, `harness/test/matrix.test.js`
- [ ] Confirm `cli.js` loads with SDK absent — covered by existing `harness/test/cli.test.js` run without `node_modules/@anthropic-ai`

## Non-Goals
- Not scaffolding `.agents/state/` or `.agents/epics/` at install time (created at runtime by the harness / `/rad-epic-decompose`).
- Not changing the gate fold, matrix vocabulary, spine control flow, or `sdk.js` adapter internals.
- Not converting `rad` into a globally-installed or symlinked CLI — per-project source ship is the chosen model.
- Not pinning or auto-updating the vendored js-yaml beyond recording its version.

## Out-of-Scope Dependencies
None — installer + harness plumbing only; no architect-only agents required.

## Risks
- If the harness writes `.agents/state/<feature>/` without `mkdir -p`, a fresh install's first `/rad-approve` could fail; Task 4.2 should surface this. If so, handle it as a follow-up (out of scope here).
- Dynamic `import()` of `sdk.js` changes error surfacing on the SDK path — a missing SDK now errors at deliver-time with `RAD_AGENT=sdk` rather than at CLI load. Acceptable (and the intended BYO behavior), but the error message must stay clear.
- `cp -r harness/` must exclude `node_modules`; a naive copy would drag in 250M. Use an explicit exclude or copy a curated file list.
