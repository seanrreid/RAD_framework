# Plan: RAD Config Init + Install/Upgrade (#87 part 2a)
Created: 2026-10-01
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-01T17:34:13.761Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-config-init-and-install
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/87
Issue-Title: Move RAD configuration out of CLAUDE.md into a data file the harness reads

## Context

#87a (#169) made `.rad/config.yml` the only source for platform, default branch, roles and the agent scope map. It was a **hard cutover**: a repo without the file gets named errors from `get-default-branch.sh`, `check-role.sh`, `rad approve` and the rest. The only way to create the file today is `rad config migrate`, which needs an old-style CLAUDE.md config block.

So a fresh install can't produce a working RAD repo, and an upgraded pre-#87 install breaks until someone runs `migrate` by hand. `install.sh` knows nothing about `.rad/`.

This plan closes that gap. It is the first half of #87b; the second half (`lean-claude-md`) removes the CLAUDE.md config block, adds `docs/configuration.md` and rewires the skills.

**Decisions (architect, 2026-10-01):**
- **Fresh install:** `rad config init`. The architect defaults to the installer's `git config user.email`, printed for review; `--architect` overrides it.
- **Upgrade:** `install.sh --upgrade` runs `rad config migrate` from the target's CLAUDE.md automatically (never with `--force`), shows its warnings and tells the operator to remove the old block. CLAUDE.md itself is never edited.

## Scope

| In scope | Out of scope |
|---|---|
| `rad config init` with `--architect`, `--platform`, `--default-branch` and `--force` | Removing CLAUDE.md's config block (`lean-claude-md`) |
| `install.sh`: a `--architect` flag, creating the config on a fresh install, auto-migrating on upgrade, and treating `.rad/` as preserved user data | `docs/configuration.md` and the skill rewiring (`lean-claude-md`) |
| The missing-config message names both `init` and `migrate` | Interactive prompting for the architect |
| `INSTALL.md` and `UPGRADE.md` updated for `.rad/config.yml` | Other docs (`lean-claude-md`) |

## Acceptance Criteria

1. **`rad config init` writes a validated `.rad/config.yml`:** `version: 1`, the given or default `platform` (`manual`), `default_branch` (`main`), `roles.architect: [<id>]`, empty developers and designers, and an empty `agent_scope_map`.
   - The architect is `--architect <id>` if given, otherwise `git config user.email` read in the repo root.
   - With neither, it exits 1 with a reason that names `--architect`.
   - The document goes through `validateConfig` before anything is written. An invalid value (for example `--platform bogus`, or a placeholder architect starting with `[`) exits 1, names the error and writes nothing.
   - An existing config is never overwritten without `--force` (exit 1).
   - Malformed arguments exit 2: an unknown flag, or a flag with no value.
   - On success it prints `rad config init: wrote .rad/config.yml (architect=<id>, platform=<p>, default_branch=<b>)` and exits 0.
2. **The missing-config message names both commands:** `CONFIG_MISSING_MESSAGE` reads `rad: no .rad/config.yml — run 'rad config init' (new install) or 'rad config migrate' (from a pre-#87 CLAUDE.md)`.
3. **Fresh install** (`install.sh` without `--upgrade`), once the harness has been copied, runs the target's `harness/cli.js config init`:
   - It passes the platform `detect-platform.sh` found (`manual` if detection gave nothing usable) and the default branch from `git symbolic-ref --short refs/remotes/origin/HEAD` with the `origin/` prefix stripped (`main` if that's absent). It passes `--architect` only when `install.sh --architect <id>` was given.
   - An existing `.rad/config.yml` is left alone (`success "… already exists — kept"`).
   - On success it prints the architect line and a reminder to review it.
4. **Upgrade** (`install.sh --upgrade`):
   - If the target has no `.rad/config.yml` and does have a CLAUDE.md, it runs `config migrate` (no `--force`), passes its warnings through, and prints `Remove the RAD Configuration block from CLAUDE.md`.
   - If `.rad/config.yml` already exists, the file is untouched.
   - `.rad/` joins `CLAUDE.md`, `.claude/agents/` and `.agents/` as preserved user data in the header comment, the upgrade banner and the summary.
5. **Config failures are reported, not swallowed.** If init or migrate fails (no email and no `--architect`, a placeholder architect in an old CLAUDE.md, a missing CLAUDE.md on upgrade):
   - `install.sh` still lays down every file;
   - it prints the CLI's reason and the exact command to run;
   - it exits **1** at the end (after `print_next_steps`), never 0.
6. **`--architect <id>`** is accepted by `install.sh` and listed in its usage line. A missing value is a usage error.
7. **Docs:**
   - `INSTALL.md`: the "What Gets Installed" tree shows `.rad/config.yml`. Post-Install step 1 covers reviewing the config and `--architect`. The commit step adds `.rad/`. Uninstall and Troubleshooting mention `.rad/`.
   - `UPGRADE.md`: gains an `## Upgrading to .rad/config.yml (#87)` section covering the hard cutover, auto-migrate, removing the old block and the manual `rad config migrate` path. Its table and its `default_branch:` / `get-default-branch.sh` lines point at `.rad/config.yml`.
8. **Tests:**
   - `harness/test/config.test.js` covers every AC#1 branch: flags; the git-email default; no identity; an invalid platform; a placeholder architect; refusing to overwrite; `--force`; usage errors.
   - `scripts/test-install-harness.sh` covers:
     - fresh install with `--architect`: a valid config containing that id, and `config validate` exits 0;
     - fresh install with git email only;
     - fresh install with no identity: files still laid down, no config, installer exits 1 and names the command;
     - upgrade of a target that has a CLAUDE.md block but no config: the migrated config is valid;
     - upgrade of a target that already has a config: byte-for-byte unchanged.
   - Every suite stays green under both `bash` and `/bin/bash`, and `lint-shell-safety` shows no ✗.

## Agent Scope

No mapper agents were used. The surface was read directly:
- `harness/config.js` exports (`validateConfig`, `serializeConfig`, `CONFIG_PATH`);
- the `rad config` section of `harness/cli.js` (2613-2752);
- `install.sh` (`main` order at 328-359: `copy_harness` comes before `scaffold_claude_md`);
- `scripts/test-install-harness.sh`.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/config.js | 280-330 | `buildInitConfig({ platform, defaultBranch, architect })` (append) |
| harness/cli.js | 2610-2760 | `config init` action, its argument parsing, usage text, missing-config message |
| harness/test/config.test.js | 240-360 | `config init` tests (append) |
| install.sh | 1-50 | Header comment, `--architect` flag, usage |
| install.sh | 200-359 | `scaffold_rad_config` (init or migrate), preserved-data lines, deferred exit 1 |
| scripts/test-install-harness.sh | 1-160 | Fresh, upgrade and no-identity cases (append) |
| INSTALL.md | 40-60 | Installed tree |
| INSTALL.md | 170-303 | Post-install, commit, uninstall, troubleshooting |
| UPGRADE.md | 1-177 | New `.rad/config.yml` section and pointer fixes |

## Execution Notes

### Do Not Touch
- CLAUDE.md (block removal is `lean-claude-md`)
- `.claude/` commands, skills and agents
- `harness/config.js`'s existing validation and serialization logic (call it, don't change it)
- `scripts/get-default-branch.sh`, `scripts/check-role.sh`, `scripts/detect-platform.sh`

### Key Files
- `harness/cli.js`: `configMigrate` and `CONFIG_ACTIONS` (follow the same shape for `init`)
- `harness/config.js`: `validateConfig`, `serializeConfig`
- `install.sh`: `main`, `scaffold_claude_md`, `detect_and_report_platform`, `print_next_steps`

### Reminders
- **Never swallow errors.** Every init or migrate failure prints its reason and makes the final exit 1.
- **bash 3.2 portability and shell-safety lint** apply to `install.sh` and the test.
- **Tests must not depend on the developer's real git email.** Set `user.email` in the fixture repo, or unset it with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` for the no-identity case.
- `rad config init` reads git config with the repo root as cwd. Run git through `execFileSync`, never through a shell string.

## Wave Plan

### Wave 1 — parallel
Disjoint files.

#### Task 1.1: `rad config init`
File: harness/config.js:280-330, harness/cli.js:2610-2760, harness/test/config.test.js:240-360
What: Implement AC#1, AC#2, and the `config.test.js` part of AC#8.
Validate: AC#1, AC#2, AC#8 — `npm test --prefix harness`. Edge cases: no identity; empty `--architect ""`; a placeholder `[name]`; `--platform bogus`; an existing file with and without `--force`; an unknown flag; a flag with no value.

#### Task 1.2: Docs — INSTALL.md + UPGRADE.md
File: INSTALL.md:40-60, INSTALL.md:170-303, UPGRADE.md:1-177
What: Implement AC#7.
Validate: AC#7. Docs only, with no testable surface beyond review: `grep -n "\.rad/config.yml" INSTALL.md UPGRADE.md` shows each listed location, and `grep -n "default_branch:.*CLAUDE" UPGRADE.md INSTALL.md` finds nothing.

### Wave 2 — sequential
`install.sh` calls the new `init` action, so it runs after Wave 1.

#### Task 2.1: `install.sh` creates or migrates the config
File: install.sh:1-50, install.sh:200-359, scripts/test-install-harness.sh:1-160
What: Implement AC#3, AC#4, AC#5, AC#6, and the install part of AC#8.
Validate: AC#3, AC#4, AC#5, AC#6, AC#8:
- `bash scripts/test-install-harness.sh && /bin/bash scripts/test-install-harness.sh`;
- `scripts/lint-shell-safety.sh` shows no ✗;
- the full suite is green (harness tests, evals, every `scripts/test-*.sh` under both shells, `lint-invariants`).

Edge cases: no git identity; a target with no origin remote; an upgrade whose CLAUDE.md has a placeholder architect; an upgrade where `.rad/config.yml` already exists.

## Tests to Write
- [ ] `rad config init` cases — harness/test/config.test.js
- [ ] Fresh, upgrade and no-identity install cases — scripts/test-install-harness.sh

## Non-Goals
- Interactive prompting for the architect. `--architect` and git email are enough, and the printed line invites review.
- Detecting the default branch beyond `origin/HEAD`. `main` is the fallback, and the operator can edit the file.
- Editing the target's CLAUDE.md on upgrade.

## Out-of-Scope Dependencies
None.

## Risks
- **The git email becomes architect silently.** It's printed and a review is requested. Approvals are still gated on that identity, and the person who installs is normally the architect.
- **A partial install exits 1.** CI or scripts calling `install.sh --yes` will see a failure when no identity is available. That's intended: a RAD repo without a config fails closed everywhere else anyway.
- **Self-protected paths:** `harness/` and `scripts/` trigger advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — `init` defaults.** `platform` defaults to `manual`, which is safe because it never calls a host CLI. `install.sh` always passes what it detected.
- **ASSUMPTION — sequencing.** This plan is delivered before `lean-claude-md`, which documents `rad config init` in `docs/configuration.md`.
