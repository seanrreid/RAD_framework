# Plan: Pinned Playbooks, Part 1: Format, Kinds, Lint and Fingerprint (#50)
Created: 2026-10-09
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-09T15:36:37.412Z
Recorded-By: sean@torchcodelab.com
Branch: rad/playbook-mechanism
Issue: 50
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/50
Issue-Title: Pinned playbooks: reusable, human-approved plan templates for recurring change shapes (adopt CUGA's playbook, reject its self-evolution)

## Context
Issue #50 proposes **playbooks**: human-authored, version-pinned plan templates for recurring change shapes, stored under `.agents/playbooks/<kind>--<slug>.md` and changed only through a normal PR. The plan that uses one records `Playbook: <kind>/<slug>@<version>` in its header, so the approved event covers which version was used. Selection is explicit (`/rad-plan --playbook <name>`). A playbook is a starting point; it never bypasses `/rad-approve`, and a run never edits one.

Research on 2026-10-09 corrected one assumption in the issue: **plan-fingerprint.js hashes only the plan body** (from the first `## ` heading), so a new `Playbook:` header line is *not* covered by the approval unless the fingerprint is extended the way `Capabilities:` lines already are.

The user decided on 2026-10-09:
- **Fingerprint (Q1):** fold the `Playbook:` header line into the fingerprint under its own marker. Plans without the line hash byte-identically, so existing approvals stay valid.
- **First increment (Q2):** seed `env-knob` and `event-type` playbooks; reserve `hook-point` and `severity-pattern` without seeding.
- **Kinds (Q3):** the allowed kinds come from an optional `playbook_kinds:` list in `.rad/config.yml`, defaulting to `env-knob`, `hook-point`, `event-type`, `severity-pattern`. Editing `.rad/` is always architect-reviewed, so the vocabulary stays frozen by construction.
- **Marker (Q4):** the primary-file marker (`// rad-playbook: …`) is deferred; `primary_file` is a reserved, unimplemented, optional frontmatter key.

#50 is split. **Part 1 (this plan)** builds the mechanism: the file format and its lint, the kinds config, the plan-header lint and the fingerprint fold. **Part 2** adds the `--playbook` flag to `/rad-plan` and `/rad-adopt`, the two seed playbooks, a CI step and the workflow docs.

## Scope
| In scope | Out of scope |
|---|---|
| `playbook_kinds` in `.rad/config.yml` (validation, serialization, default) | The `--playbook` flag in the skills (part 2) |
| `harness/playbook.js`: pure parsing and validation of playbook files and refs | Seed playbooks and `.agents/playbooks/` content (part 2) |
| `rad playbook lint` and `rad playbook check-ref` | The primary-file marker and its lint |
| The `Playbook:` header lint in `scripts/lint-plan.sh` | A CI step for `rad playbook lint` (part 2) |
| The `Playbook:` fingerprint fold | Shipping playbooks in installs (`.agents/` stays user data) |
| Format and command docs | |

## Acceptance Criteria
1. **The kinds config.** `.rad/config.yml` accepts an optional top-level `playbook_kinds:`.
   - **Valid:** a non-empty list of unique kebab-case strings (`^[a-z][a-z0-9-]*$`).
   - **Errors (fail closed):** an empty list, a non-array, a duplicate, an empty string, a non-kebab string.
   - **Default:** harness/config.js exports `DEFAULT_PLAYBOOK_KINDS = ['env-knob', 'hook-point', 'event-type', 'severity-pattern']` and `resolvePlaybookKinds(config)`, which returns the configured list or the default when the key is absent.
   - **Round trip:** `serializeConfig` writes the key only when it was set, so configs without it serialize byte-identically to today.
2. **The playbook module.** harness/playbook.js is pure, with no I/O except through injected arguments:
   - `parsePlaybookRef(text)` → `{ kind, slug, version }` or `null`. The grammar is `<kind>/<slug>@<version>`: kebab-case kind and slug, version a positive integer without leading zeros.
   - `playbookFileName({ kind, slug })` → `<kind>--<slug>.md`.
   - `parsePlaybook(text)` → `{ meta, body }`. The file starts with `---`, then a JSON object, then `---`. Anything else is an error.
   - `validatePlaybook({ fileName, text, kinds })` → `string[]` of errors, empty when valid. The rules:
     - the file name matches `<kind>--<slug>.md`, and the kind is in `kinds`;
     - frontmatter keys come from `kind`, `slug`, `version`, `summary`, `primary_file`. Anything else is an error, and `primary_file` is accepted but not interpreted;
     - `kind` and `slug`, when present, match the file name, and `version` is a positive integer;
     - the file has a `## Upgrade Guide` section that is the **last** `## ` section;
     - it contains `### Version N — YYYY-MM-DD` entries (an em dash and a valid date) in strictly ascending order, numbered consecutively from 1, and the last N equals the frontmatter `version`.
   - `checkPlaybookRef({ ref, kinds, readPlaybook })` → `{ ok: true, current, stale }` or `{ ok: false, reason }`, where `readPlaybook(fileName)` returns the text or `null`.
     - It fails when the ref doesn't parse, the kind isn't allowed, the file is missing or invalid, or the ref's version is greater than the playbook's current version.
     - A ref version lower than current is `ok` with `stale: true`, so a plan cut from an older version doesn't break.
   - Non-string input throws `TypeError`.
3. **The `rad playbook` command.** Registered in `SUBCOMMANDS` with `PLAYBOOK_USAGE`, from a new harness/playbook-command.js:
   - `rad playbook lint [--root <dir>] [<file>...]` validates the given files, or every `*.md` in `<root>/.agents/playbooks/` except `README.md` when none are given. It prints one `<file>: <error>` line per problem and exits 1 if any, else prints `playbooks ok (N)` and exits 0. A missing playbooks directory is `playbooks ok (0)`.
   - `rad playbook check-ref [--root <dir>] <ref>` prints `ok current=<N>` or `stale current=<N>` and exits 0. A failure prints `rad playbook: <reason>` to stderr and exits 1.
   - A usage error (no subcommand, a missing `<ref>`, an unknown flag) or an unreadable config exits 2.
   - Kinds come from `resolvePlaybookKinds` over the root's `.rad/config.yml` (the default when the key is absent, or when there is no config file).
4. **The plan-header lint.** `scripts/lib/plan-paths.sh` gains `plan_playbook`, mirroring `plan_tier`: it scans only the header block (up to the first `## `), so a fenced example in the body can't count.
   - It prints the trimmed value of the first `Playbook:` line, or nothing when there isn't one.
   - A second `Playbook:` header line is an error, as is an empty value.
   - `scripts/lint-plan.sh`, when the header has a `Playbook:` line, runs `node harness/cli.js playbook check-ref --root <repo root> <value>` (`RAD_CLI` located like lint-agent-files.sh does). Exit 1 adds an ERROR with the reason. A `stale` result adds a WARNING (`Playbook <ref> is behind current version N`). Exit 2, or no `node`, adds an ERROR (it fails closed).
   - A plan without a `Playbook:` line lints exactly as before.
5. **The fingerprint fold.** harness/plan-fingerprint.js folds the header block's `Playbook:` line (trimmed) into the hashed text under `HEADER_PLAYBOOK_MARKER` (`'\n<!-- rad:header-playbook -->\n'`), after any `Capabilities:` fold.
   - A plan with no `Playbook:` line hashes byte-identically to today, with or without `Capabilities:`.
   - Changing the line changes the hash, and a `Playbook:` line in the body, outside the header, never counts.
   - The module header comment documents the exception.
6. **Tests.**
   - harness/test/config.test.js: valid lists; each error case; the default and `resolvePlaybookKinds`; round-trip serialization with and without the key.
   - harness/test/playbook.test.js covers:
     - `parsePlaybookRef` accepting and rejecting (empty, `kind/slug`, a zero or negative version, a leading zero, non-kebab, whitespace);
     - `parsePlaybook` with missing or malformed frontmatter;
     - `validatePlaybook`: every rule above, a skipped or non-ascending version, and `primary_file` accepted but ignored;
     - `checkPlaybookRef`: ok, stale, a greater version, a missing file and a disallowed kind;
     - `TypeError` on bad input.
   - harness/test/cli-playbook.test.js runs `rad playbook` against a temp root: `lint` with no directory, valid and invalid playbooks and explicit files; `check-ref` ok, stale and failures; each usage error; and the `playbook_kinds` override.
   - harness/test/fingerprint.test.js: the identical-hash guarantee for plans without the line; sensitivity to the line; the body line ignored; the combination with `Capabilities:`.
   - scripts/test-plan-paths.sh: `plan_playbook` with absent, present, repeated, empty and fenced-body cases.
   - scripts/test-lint-plan.sh: a plan with a valid ref, a stale ref (warning), an unknown kind, a missing file, a greater version, a duplicate line and no `Playbook:` line (unchanged output).
   - Every existing harness test, eval and `scripts/test-*.sh` passes. List any changed assertion.
7. **Docs.**
   - A new docs/playbooks.md describes the format: location and naming, frontmatter, the reserved `primary_file`, the Upgrade Guide rule, the kinds and how to add one, the plan header, what the fingerprint covers, and the guardrail that a playbook never bypasses approval or severity routing.
   - docs/rad-cli.md: a `### rad playbook` section.
   - docs/configuration.md: the `playbook_kinds` key.
   - `.agents/README.md`: a `playbooks/` row.

## Agent Scope
Research came from a read-only sub-agent survey of the rad-plan skill and its `--light` flag, lint-plan.sh and plan-paths.sh header handling, plan-fingerprint.js, the install manifest and scope exemptions, the existing recurring-shape PRs, and the config validation. Targeted greps for the config key lists, the fingerprint constants and the lint structure followed. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/config.js | 20-50 | `playbook_kinds` key, `DEFAULT_PLAYBOOK_KINDS` |
| harness/config.js | 160-215 | Validation of the key |
| harness/config.js | 375-430 | `serializeConfig`, `resolvePlaybookKinds` |
| harness/test/config.test.js | 1-1 | Append cases (AC#6) |
| harness/playbook.js | 1-1 | New: pure parsing and validation |
| harness/test/playbook.test.js | 1-1 | New (AC#6) |
| harness/playbook-command.js | 1-1 | New: `playbookCommand`, `PLAYBOOK_USAGE` |
| harness/cli.js | 66-110 | Import and usage |
| harness/cli.js | 205-240 | `SUBCOMMANDS`: `playbook` |
| harness/test/cli-playbook.test.js | 1-1 | New (AC#6) |
| harness/label.js | 1-81 | Read only: the command-module model |
| harness/plan-fingerprint.js | 1-94 | The `Playbook:` fold |
| harness/test/fingerprint.test.js | 1-1 | Append cases (AC#6) |
| scripts/lib/plan-paths.sh | 605-635 | `plan_playbook` |
| scripts/lint-plan.sh | 50-110 | The `Playbook:` check |
| scripts/lint-agent-files.sh | 18-30 | Read only: the `RAD_CLI` pattern |
| scripts/test-plan-paths.sh | 1-1 | Append `plan_playbook` cases |
| scripts/test-lint-plan.sh | 1-60 | Helpers and header comment |
| scripts/test-lint-plan.sh | 1235-1260 | New `t_playbook_header`, call list |
| docs/playbooks.md | 1-1 | New format doc |
| docs/rad-cli.md | 1-1 | New `### rad playbook` section (append near rad label) |
| docs/configuration.md | 1-60 | The `playbook_kinds` key |
| .agents/README.md | 8-20 | `playbooks/` row |

## Execution Notes

### Do Not Touch
- `.rad/config.yml` (no `playbook_kinds` is set here; the default applies)
- `.rad/skills/**` and the generated skill files (part 2 adds the flag)
- harness/spine.js, harness/gates.*, harness/transitions.js
- Existing plan files and approved events: no existing fingerprint may change

### Key Files
- harness/plan-fingerprint.js: `HEADER_CAPABILITIES_PATTERN`, `HEADER_CAPABILITIES_MARKER`, `headerCapabilityLines` and the fold at lines 20-60: the exact precedent for the `Playbook:` fold
- scripts/lib/plan-paths.sh `plan_tier` (614-627): the header-only scan model for `plan_playbook`
- scripts/lint-plan.sh: the Tier block (88-102) as the model for a header check, the `ERRORS`/`WARNINGS` arrays, and the end-of-script output
- harness/label.js and harness/checkout.js: small command-module models
- harness/config.js: `TOP_LEVEL_KEYS` (24), `AGENT_KEYS` (43), `agentErrors` (168+), `serializeConfig` (~375-430)
- scripts/test-lint-plan.sh: `run_lint`, `fail`, `assert_out_has`, the `write_tier_plan` fixture style

### Reminders
- **Waves run under the 10-minute agent limit.** Validate with only the targeted test files and scripts named in each task; the reviewer runs the full suites.
- **Existing approvals are sacred.** A plan with no `Playbook:` line must keep its fingerprint byte for byte. The test for it must compare against a hash computed from the pre-change algorithm (a fixed expected string), not a recomputation.
- **Fail closed:** a bad ref, an unreadable config or a missing `node` is an error, never skipped.
- **Header-only scans** for `Playbook:`; never match a fenced example or body text.
- **Edge cases to test** are named in each task's Validate field.
- **Helpers stay under ~40 lines, with named constants** (the kinds, the grammar, the markers).

## Program Design
```js
// harness/config.js
export const DEFAULT_PLAYBOOK_KINDS = ['env-knob', 'hook-point', 'event-type', 'severity-pattern'];
export function resolvePlaybookKinds(config)          // → string[] (configured or default)
// harness/playbook.js
export function parsePlaybookRef(text)                // → { kind, slug, version } | null
export function playbookFileName({ kind, slug })      // → '<kind>--<slug>.md'
export function parsePlaybook(text)                   // → { meta, body } | throws PlaybookError
export function validatePlaybook({ fileName, text, kinds })     // → string[]
export function checkPlaybookRef({ ref, kinds, readPlaybook })  // → { ok, current?, stale?, reason? }
// harness/playbook-command.js
export const PLAYBOOK_USAGE = 'rad playbook lint [--root <dir>] [<file>...] | rad playbook check-ref [--root <dir>] <ref>';
export async function playbookCommand(argv, ctx)       // → 0 | 1 | 2
```
```
plan header `Playbook: env-knob/timeout-style@1`
  → lint-plan.sh: plan_playbook (header-only) → node harness/cli.js playbook check-ref --root <repo> <ref>
      → resolvePlaybookKinds(.rad/config.yml) → checkPlaybookRef → read .agents/playbooks/env-knob--timeout-style.md → validatePlaybook
      → "ok current=1" | "stale current=2" (WARNING) | exit 1 (ERROR) | exit 2 (ERROR, fail closed)
  → plan-fingerprint: header Playbook: line folded under HEADER_PLAYBOOK_MARKER
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The playbook_kinds config key
File: harness/config.js:20-50, 160-215, 375-430, harness/test/config.test.js:1-1
What: Write AC#1 and its config.test.js cases (append).
Validate: AC#1, AC#6 — `node --test harness/test/config.test.js` passes; edge cases covered: an empty list, a non-array, a duplicate, an empty string and a non-kebab string are each an error, and an absent key serializes unchanged

#### Task 1.2: The fingerprint fold
File: harness/plan-fingerprint.js:1-94, harness/test/fingerprint.test.js:1-1
What: Write AC#5 and its fingerprint.test.js cases, including the fixed-expected-hash guarantee for plans without the line.
Validate: AC#5, AC#6 — `node --test harness/test/fingerprint.test.js` passes; edge cases covered: no header line (identical hash), a changed line (different hash), a body-only line (ignored) and `Capabilities:` plus `Playbook:`

### Wave 2 — sequential

#### Task 2.1: The pure playbook module
File: harness/playbook.js:1-1, harness/test/playbook.test.js:1-1
What: Write AC#2 and its playbook.test.js cases.
Validate: AC#2, AC#6 — `node --test harness/test/playbook.test.js` passes; edge cases covered: an empty ref, version 0, a negative or leading-zero version, missing frontmatter, a skipped Upgrade Guide version and non-string input

### Wave 3 — sequential

#### Task 3.1: The rad playbook command
File: harness/playbook-command.js:1-1, harness/cli.js:66-110, 205-240, harness/test/cli-playbook.test.js:1-1
What: Write AC#3 and its cli-playbook.test.js cases.
Validate: AC#3, AC#6 — `node --test harness/test/cli-playbook.test.js` passes; `node harness/cli.js --help` lists `playbook`; edge cases covered: no playbooks directory, a missing `<ref>`, an unknown flag, and no config file

### Wave 4 — sequential

#### Task 4.1: The plan-header lint
File: scripts/lib/plan-paths.sh:605-635, scripts/lint-plan.sh:50-110, scripts/test-plan-paths.sh:1-1, scripts/test-lint-plan.sh:1-60, 1235-1260
What: Write AC#4 and its script test cases.
Validate: AC#4, AC#6 — `bash scripts/test-plan-paths.sh` and `bash scripts/test-lint-plan.sh` pass; edge cases covered: an absent line, a repeated line, an empty value, a fenced body example and `node` unavailable (an error)

### Wave 5 — sequential

#### Task 5.1: Docs
File: docs/playbooks.md:1-1, docs/rad-cli.md:1-1, docs/configuration.md:1-60, .agents/README.md:8-20
What: Write AC#7.
Validate: AC#7 — `grep -n 'playbook_kinds' docs/configuration.md docs/playbooks.md` matches in both; `grep -n 'rad playbook' docs/rad-cli.md` matches

## Tests to Write
- [ ] playbook_kinds validation, default and round trip — harness/test/config.test.js
- [ ] the pure playbook module — harness/test/playbook.test.js
- [ ] rad playbook lint and check-ref — harness/test/cli-playbook.test.js
- [ ] the Playbook: fingerprint fold and the unchanged-hash guarantee — harness/test/fingerprint.test.js
- [ ] plan_playbook header scanning — scripts/test-plan-paths.sh
- [ ] the Playbook: header lint — scripts/test-lint-plan.sh

## Non-Goals
- The `--playbook` flag in `/rad-plan` and `/rad-adopt`, and any seed playbook (part 2).
- The primary-file marker and its lint.
- A CI step for `rad playbook lint` (part 2, once playbooks exist).
- Shipping playbooks in installs, or any self-growing or runtime-edited playbook.

## Out-of-Scope Dependencies
None

## Risks
- **The fingerprint change touches approval integrity.** Mitigation: it mirrors the `Capabilities:` fold, the unchanged-hash guarantee is tested against a fixed expected string, and plans without a `Playbook:` line never reach the new branch.
- **`lint-plan.sh` now shells out to `node` for plans that carry a `Playbook:` line.** It fails closed (an error) if `node` or the check is unavailable. Plans without the line don't call `node`, so nothing changes for them.
- **A stale ref warns rather than fails,** so a playbook bump doesn't break plans already in flight. A ref newer than the playbook still fails.
- **Self-protected paths** (`harness/`, `scripts/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — frontmatter is a JSON object between `---` lines,** as the issue and Flue's blueprints describe. JSON is also valid YAML, so existing frontmatter tooling still reads it.
- **Assumption — the fold goes after `Capabilities:`.** The marker order is fixed, so a plan with both is hashed consistently.
- **Assumption — `lint-plan.sh` reads the playbook from the repo root it ships in** (the checkout the lint runs from), which in plan-open is the working tree cut from the default branch.
- **Assumption — `rad playbook lint` skips `README.md`** in the playbooks directory, so the layout doc can live beside the playbooks.
