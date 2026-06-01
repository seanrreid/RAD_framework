# Plan: Exempt RAD process artifacts from scope check
Created: 2026-06-01
Author: architect
Status: pending-review
Branch: rad/scope-check-process-artifacts-exempt
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/14
Issue-Title: check-scope.sh should exempt RAD bookkeeping files (findings.jsonl, .agents/logs/)

## Context
`scripts/check-scope.sh` compares the files changed on a work branch against the
plan's declared scope. It already exempts RAD process artifacts via an
`ALWAYS_ALLOW_PREFIXES` allowlist containing `.agents/logs/` and `.agents/plans/`.
The issue reported that `.agents/findings.jsonl` — appended by `/rad-review` on the
work branch — is **not** exempted, so a subsequent scope check flags it as an
out-of-scope change. The `harness-deliver-spine` cycle worked around this by
declaring `findings.jsonl` in its Files in Scope (see that plan's Risks). This plan
closes the gap so the workaround is no longer needed.

## Scope
| In scope | Out of scope |
|---|---|
| Add `.agents/findings.jsonl` to the `check-scope.sh` allowlist | A blanket `.agents/` exemption (real deliverables under `.agents/` must stay scope-checked) |
| Add a regression test for the allowlist behavior | Changing the scope-table / tests-to-write parsing logic |
| Confirm `.agents/logs/` + `.agents/plans/` exemption is consistent | Removing the `findings.jsonl` workaround already merged in the harness-deliver-spine plan doc |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. A change to `.agents/findings.jsonl` on a work branch does NOT appear as an
   out-of-scope violation, even when it is absent from the plan's Files in Scope.
2. A change to a non-artifact file absent from the plan's Files in Scope is
   STILL reported as out-of-scope (the allowlist remains narrow, not blanket).
3. Changes under `.agents/logs/` and `.agents/plans/` continue to be exempt
   (no regression to existing allowlist entries).

## Agent Scope
No role-restricted agents were called. Research used direct read of
`scripts/check-scope.sh` and the existing test harnesses
(`scripts/test-script-hardening.sh`, `scripts/test-open-pr.sh`).

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/check-scope.sh | ~84-87 (`ALWAYS_ALLOW_PREFIXES`) | Add `.agents/findings.jsonl` exact-path entry to the allowlist |
| scripts/test-check-scope.sh | new file | Self-contained regression test covering AC#1–3 |

## Execution Notes

### Do Not Touch
- `scripts/get-default-branch.sh`, `scripts/detect-platform.sh` — depended on by
  check-scope.sh at runtime; tests may copy them into fixtures but must not modify them.

### Key Files
- `scripts/check-scope.sh` — the `ALWAYS_ALLOW_PREFIXES` array (currently
  `.agents/logs/`, `.agents/plans/`) and the per-file prefix-match loop are the
  only mechanism to change.
- `scripts/test-script-hardening.sh` — reference for the self-contained,
  temp-fixture, bash-3.2-safe test convention to mirror in the new test file.

### Reminders
- `findings.jsonl` is a single file, not a directory. The existing allowlist uses
  prefix matching (`"$file" == "$prefix"*`). An entry of `.agents/findings.jsonl`
  matches the exact path via the same `*` glob (empty suffix), so no logic change
  is required — only a new array element. Keep it explicit (exact path), not
  `.agents/findings` or `.agents/`.
- Tests must run under macOS stock bash 3.2 (`set -u` safe), like the siblings.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (the test validates the code change).

#### Task 1.1: Add findings.jsonl to the allowlist
File: scripts/check-scope.sh:84-87
What: Add `".agents/findings.jsonl"` as an entry in the `ALWAYS_ALLOW_PREFIXES`
array, alongside `.agents/logs/` and `.agents/plans/`. Update the adjacent
comment ("Always allow execution logs and the plan file itself") to also mention
the review findings log.
Validate: AC#1 — a fixture branch changing only `.agents/findings.jsonl` (not in
scope) exits 0 with no out-of-scope report.

#### Task 1.2: Add regression test
File: scripts/test-check-scope.sh (new)
What: Create a self-contained test mirroring `test-script-hardening.sh`
conventions (temp git repo fixture, copies the real `check-scope.sh` +
`get-default-branch.sh`, `set -euo pipefail`, bash 3.2-safe). Assert: (a)
`findings.jsonl`-only change passes; (b) an undeclared non-artifact file
change fails with exit 1; (c) `.agents/logs/` and `.agents/plans/` changes still pass.
Validate: AC#1, AC#2, AC#3 — test exits 0 with all three assertions passing.

## Tests to Write
- [ ] findings.jsonl exemption + narrow-allowlist regression — scripts/test-check-scope.sh

## Non-Goals
- No blanket `.agents/` exemption — only the explicit `findings.jsonl` path is added.
- No change to how the scope table or tests-to-write list is parsed.
- Not removing the `findings.jsonl` workaround already committed in the
  `harness-deliver-spine` plan doc (historical record; harmless).

## Out-of-Scope Dependencies
None — no architect-only agents required (and the author is the architect).

## Risks
- Low. The change is additive (one allowlist entry). The only failure mode would
  be making the entry too broad (e.g. `.agents/` or a trailing-slash directory
  match) and thereby exempting real deliverables; the test's AC#2 assertion guards
  against that.
- The original issue stated `.agents/logs/` was not exempted; the current script
  shows it already is. The plan scopes to the actual gap (`findings.jsonl`) and
  adds AC#3 to lock in the existing-entry behavior.

## Issue Gaps
- **Logs already exempt (assumption: issue was stale).** The issue's "Proposed
  fix" lists `.agents/logs/` as needing exemption, but it is already present in
  `ALWAYS_ALLOW_PREFIXES`. This plan treats that bullet as already-satisfied and
  only adds `findings.jsonl`. Architect: confirm no additional logs path variant
  (e.g. a differently-cased or nested log dir) is intended.
- **Exact path vs. prefix (assumption).** `findings.jsonl` is added as an exact
  path, relying on the existing `"$file" == "$prefix"*` match with an empty
  suffix. If the intent was to exempt any `findings*.jsonl` sibling, that is NOT
  covered — the plan deliberately keeps it to the single canonical file.
- **No pre-existing test (assumption: add one).** `check-scope.sh` had no
  dedicated test. This plan adds `test-check-scope.sh` rather than folding cases
  into `test-script-hardening.sh`, matching the one-file-per-concern test layout.
