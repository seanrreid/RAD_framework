# Plan: Capability Classes, Approval Surface and Docs (#85 part 2)
Created: 2026-10-05
Author: architect
Status: complete
Completed-At: 2026-10-05T17:50:35Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-05T17:32:20.333Z
Recorded-By: sean@torchcodelab.com
Branch: rad/capability-surface
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/85
Issue-Title: Capability classes alongside path scope: declare fs/shell/net/mcp per wave, deny-wins across config layers

## Context

Part 1 (`capability-classes`) adds per-wave capability declarations:
- the plan-level and wave-level `Capabilities:` lines;
- the `.rad/config.yml` `capabilities.deny` list;
- resolution where deny wins (`harness/capabilities.js`);
- SDK `allowedTools` enforcement, and a command-adapter refusal.

What's still missing is the human side: the architect can't see what a plan asks for when approving it, and nothing documents the feature.

**Decision (architect, 2026-10-05):** the approval surface is advisory.
- `lint-plan.sh` warns when a plan requests `net` or `mcp` (beyond the default).
- `/rad-approve` shows each wave's effective set.
- Neither one blocks; the plan fingerprint already locks the declaration in.

This plan is delivered **after** `capability-classes` merges, because it calls `resolveWaveCapabilities`.

## Scope

| In scope | Out of scope |
|---|---|
| Read-only `rad capabilities <feature> [--plan <path>]` | Changing resolution or enforcement (part 1) |
| `lint-plan.sh` advisory for `net`/`mcp` requests | An approval blocker or waiver for capabilities |
| `/rad-approve` shows the per-wave effective set | Recording capabilities in the `approved` event |
| `docs/configuration.md` and `docs/rad-wave-contract.md` | CLAUDE.md (stays a pointer) |

## Acceptance Criteria

1. **`rad capabilities <feature> [--plan <path>]`** is read-only.
   - It reads `.agents/plans/<feature>.md`, or `--plan`, plus the `.rad/config.yml` deny list, and calls `resolveWaveCapabilities`.
   - It prints one line per wave: `wave N: <effective classes> (<source>)`, where the source is `default`, `plan`, or `wave`, followed by `; denied: <classes>` when the project deny list removed any.
   - Exit codes:
     - **0** on success;
     - **2** on a malformed `Capabilities:` line or a refused explicit request, with the same message `rad deliver` gives;
     - **1** on a missing plan or an invalid config;
     - **2** on bad arguments.
   - It is listed in the CLI command registry with a summary.
2. **Lint advisory:** `scripts/lint-plan.sh` adds one **warning** (never an error) per `Capabilities:` line requesting `net` or `mcp`: `capability request (beyond the default — architect review): <scope> requests <class>`, where the scope is `plan` or `wave N`.
   - Lines requesting only default classes add nothing.
   - The check only matches tokens; validating the vocabulary stays with `rad capabilities` and `rad deliver`.
3. **`/rad-approve`:**
   - Step 2 runs `node harness/cli.js capabilities "$FEATURE"`.
   - The Step 3 summary gains a `Capabilities` block showing each wave's line from that output, or `default (fs_read, fs_write, shell) for every wave` when the plan declares nothing and the project denies nothing.
   - A non-zero exit is shown as a blocker-style line, `Capabilities: <message> — deliver will refuse this plan`, before the confirmation prompt. It is advisory and doesn't block approval.
   - The rules section says that approving accepts the declared capabilities.
4. **Docs:**
   - **`docs/configuration.md`** gains:
     - `capabilities.deny` in the schema table;
     - a `### Capabilities` section covering the five classes; the default; plan and wave lines and their precedence; deny-wins; the explicit-request refusal; SDK tool mapping; the command-adapter refusal; `mcp` reserved and refused in v1; and that `shell` subsumes `net` and `fs_write` (tool-level, not a sandbox);
     - `rad capabilities` in the command reference.
   - **`docs/rad-wave-contract.md`** gains a short "Capabilities" subsection under the adapter interface (how an adapter receives the effective set, and the refusal-not-over-grant rule) and a line in "Writing a new adapter".
5. **Tests:**
   - `harness/test/cli.test.js` covers `rad capabilities`:
     - an undeclared plan (every wave `default`);
     - a plan line plus a wave override;
     - a deny-narrowed implicit default;
     - a refused explicit request (exit 2);
     - a malformed line (exit 2);
     - a missing plan (exit 1);
     - bad arguments (exit 2).
   - `scripts/test-lint-plan.sh` covers a `net` request at plan level, an `mcp` request on a wave, and a default-only line producing no warning. It passes under both `bash` and `/bin/bash`.
   - Every suite stays green.

## Agent Scope

No mapper agents were used. The surface was read directly:
- the CLI command registry (`cli.js` 55-130);
- the `lint-plan.sh` advisory block (278-320);
- `/rad-approve` Steps 2-3 (100-180);
- the `docs/configuration.md` schema (19-93);
- the `docs/rad-wave-contract.md` adapter sections (56-135, 340-376).

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 55-130 | Register `capabilities` |
| harness/cli.js | 2880-2960 | `capabilitiesCommand` (append at end of file; exact lines shift after part 1) |
| harness/test/cli.test.js | 1840-1910 | `rad capabilities` cases (append) |
| scripts/lint-plan.sh | 278-330 | `net`/`mcp` request advisory |
| scripts/test-lint-plan.sh | 1140-1200 | Advisory cases (append) |
| .claude/commands/architect/rad-approve.md | 100-200 | Step 2 call, Step 3 block, rule line |
| docs/configuration.md | 19-93 | Schema row + `rad capabilities` |
| docs/configuration.md | 185-240 | `### Capabilities` section |
| docs/rad-wave-contract.md | 56-135 | Adapter capabilities subsection |
| docs/rad-wave-contract.md | 340-376 | New-adapter line |
| harness/plan-fingerprint.js | 1-60 | Amendment 1: the fingerprint covers the plan-header `Capabilities:` line |
| harness/test/fingerprint.test.js | 1-90 | Amendment 1: header-line cases + unchanged hash for plans without it (append) |
| harness/evals/approval.eval.js | 290-360 | Amendment 1: `widen-capabilities-after-approval` case (append) |
| docs/invariants.yaml | 37-56 | Amendment 1: anchor on the header-line fold |
| .claude/commands/architect/rad-approve.md | 425-435 | Amendment 1: the Rules line says both lines are locked |
| docs/configuration.md | 285-310 | Amendment 1: Capabilities section says approval locks both lines |

## Execution Notes

### Do Not Touch
- harness/capabilities.js, harness/spine.js, harness/adapters/ (part 1)
- harness/ other than, under Amendment 1, `harness/plan-fingerprint.js`, its test and the approval eval
- harness/config.js
- CLAUDE.md, .rad/config.yml

### Key Files
- `harness/capabilities.js`: `resolveWaveCapabilities`, `CAPABILITY_CLASSES`, `DEFAULT_CAPABILITIES`
- `harness/cli.js`: the command registry and `configCommand` (an example read-only verb)
- `scripts/lint-plan.sh`: the high-risk and self-protected advisory blocks

### Reminders
- **Read-only:** `rad capabilities` writes nothing and appends no events.
- **Advisory only:** the lint adds warnings, never errors, and `/rad-approve` never blocks on capabilities.
- **bash 3.2 portability and shell-safety lint** apply to `lint-plan.sh`.
- **No en dashes in plan, shell or JS files.**

## Wave Plan

### Wave 1 — parallel
Disjoint files.

#### Task 1.1: `rad capabilities` read verb
File: harness/cli.js:55-130, harness/cli.js:2880-2960, harness/test/cli.test.js:1840-1910
What: Implement AC#1 and the `cli.test.js` part of AC#5.
Validate: AC#1, AC#5 with `npm test --prefix harness`. Edge cases:
- an undeclared plan;
- a deny-narrowed default;
- a refused explicit request;
- a malformed line;
- a missing plan;
- an extra argument;
- `--plan` with no value.

#### Task 1.2: lint-plan `net`/`mcp` advisory
File: scripts/lint-plan.sh:278-330, scripts/test-lint-plan.sh:1140-1200
What: Implement AC#2 and the lint part of AC#5.
Validate: AC#2, AC#5:
- `bash scripts/test-lint-plan.sh && /bin/bash scripts/test-lint-plan.sh`;
- `scripts/lint-shell-safety.sh` shows no ✗.

Edge cases: a plan-level `net`; an `mcp` on a wave; a default-only line; `net` in prose outside a `Capabilities:` line, which must not warn.

### Wave 2 — parallel
Approval surface and docs, after the verb exists.

#### Task 2.1: `/rad-approve` capabilities block
File: .claude/commands/architect/rad-approve.md:100-200
What: Implement AC#3.
Validate: AC#3. This is command prose with no testable surface beyond review: `grep -n "cli.js capabilities" .claude/commands/architect/rad-approve.md` shows the Step 2 call, and the Step 3 template shows the block.

#### Task 2.2: Docs
File: docs/configuration.md:19-93, docs/configuration.md:185-240, docs/rad-wave-contract.md:56-135, docs/rad-wave-contract.md:340-376
What: Implement AC#4.
Validate: AC#4 and AC#5:
- `grep -n "capabilities" docs/configuration.md docs/rad-wave-contract.md` shows each listed section;
- the full suite is green (harness tests, evals, every `scripts/test-*.sh` under both shells, `lint-shell-safety`, `lint-invariants`, `lint-claude-md`).

### Wave 3 — sequential
Amendment 1: the approval fingerprint must lock the plan-header `Capabilities:` line.

#### Task 3.1: Fingerprint covers the plan-header Capabilities line
File: harness/plan-fingerprint.js:1-60, harness/test/fingerprint.test.js:1-90, harness/evals/approval.eval.js:290-360, docs/invariants.yaml:37-56, .claude/commands/architect/rad-approve.md:425-435, docs/configuration.md:285-310
What: `plan-fingerprint.js` hashes only from the first `## ` heading onward. The plan-header `Capabilities:` line (part 1, #176) sits above that heading, so widening it after approval (for example adding `shell, net`) leaves the fingerprint unchanged and needs no re-approval. That was verified on 2026-10-05: same hash before and after the edit.
- **Fingerprint:** when the header block (lines before the first `## `) contains a `Capabilities:` line, fold that line, trimmed, into the hashed text under a fixed marker. A plan **without** a header `Capabilities:` line must hash **exactly as before**, so every existing approval stays valid. More than one header line folds them all, in order. Other header churn (`Status:`, `Approved-At:`) still never changes the hash.
- **Tests (`fingerprint.test.js`):**
  - no header line → hash equals the pre-change hash (a literal from today's code for a fixed fixture);
  - adding, widening or removing the header line changes the hash;
  - editing `Status:` doesn't change it;
  - whitespace-only differences on the line normalize the same way body lines do.
- **Eval (`approval.eval.js`) `widen-capabilities-after-approval`:**
  - approve a fixture plan whose header has `Capabilities: fs_read, fs_write`;
  - edit the header to add `shell, net`;
  - the deliver-gate hook blocks (exit 2, fingerprint mismatch) and `rad deliver` stops with `approval-changed` before any agent runs, mirroring `deliver-after-plan-edit`.
  - The `[mutated]` twin restores body-only hashing in the fixture's `plan-fingerprint.js` and lets the plan through.
- **Registry:** `docs/invariants.yaml` `approval-invalidated-by-plan-change` gains an anchor on the header-line fold.
- **Wording:** the `/rad-approve` Rules line and the `docs/configuration.md` Capabilities section now say both `Capabilities:` lines are locked by the fingerprint.

Validate: AC#3, AC#4, AC#5 (amendment 1):
- `npm test --prefix harness`;
- `node --test harness/evals/approval.eval.js`, including `[mutated]`;
- `scripts/lint-invariants.sh` exits 0;
- the full suite is green (evals, every `scripts/test-*.sh` under both shells, `lint-shell-safety`, `lint-claude-md`);
- `scripts/check-plan-approved.sh` still passes for an already-approved plan with no header line (no fingerprint churn).

## Tests to Write
- [ ] rad capabilities cases — harness/test/cli.test.js
- [ ] net/mcp advisory cases — scripts/test-lint-plan.sh
- [ ] Header Capabilities fingerprint cases — harness/test/fingerprint.test.js (Amendment 1)
- [ ] widen-capabilities-after-approval eval — harness/evals/approval.eval.js (Amendment 1)

## Non-Goals
- Blocking approval on `net` or `mcp` requests, or waiving them.
- Freezing capabilities into the `approved` event. The plan fingerprint already covers the plan text.
- Showing capabilities in `rad-status`.

## Out-of-Scope Dependencies
- `capability-classes` (#85 part 1) must be merged first.

## Risks
- **The advisory duplicates two class names in bash** (`net`, `mcp`). The full vocabulary stays in `harness/capabilities.js`, and the lint only flags those two tokens.
- **Self-protected paths:** `harness/`, `scripts/` and `.claude/` trigger advisory lint warnings by design.

## Issue Gaps
- **AMENDMENT 1 (2026-10-05, after Wave 2).** Wave 2 found that the plan-header `Capabilities:` line from part 1 (#176) is outside the fingerprinted body. A plan's default capabilities could be widened after approval without re-approval. This is a gate gap in merged code, closed here before the approval surface ships. A plan without the header line hashes exactly as before, so no existing approval is invalidated. The new Task 3.1 and six ranges are added.
- **ASSUMPTION — a read verb, not prose.** The approver sees the exact resolution deliver will use (`resolveWaveCapabilities`), not the model's reading of the plan.
