# Plan: Record a Non-Default High-Risk Pattern in the Approved Event
Created: 2026-09-28
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-28T19:38:12.423Z
Recorded-By: sean@torchcodelab.com
Branch: rad/record-high-risk-pattern
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/144
Issue-Title: Record the effective high-risk pattern in the approved event when it differs from the default

## Context

Since #141, `rad approve` freezes applied waivers into `approved.data.waivers`, but it doesn't record which high-risk pattern was in force. The check can't be disabled, since an empty `RAD_HIGH_RISK_PATTERNS` falls back to the default (#141 amendment 5). It can be **narrowed**, though, even to a pattern that matches nothing. In that case an architect sees no high-risk blockers and nothing in the event records why. Waived findings can be audited; findings that were never raised because of a narrowed pattern can't.

The effective pattern is resolved in exactly one place, `plan_high_risk_pattern` (`scripts/lib/plan-paths.sh:365-367`). `rad approve` already spawns `scripts/check-approval-blockers.sh` through `defaultSh`, which inherits the architect's environment, so the shell layer sees the pattern the approval actually ran under.

**Architect decisions (2026-09-28):**
1. **Channel: a tagged line from the blocker script.** On exit 0, `check-approval-blockers.sh` additionally prints `high-risk-pattern<TAB><pattern>` **only when the effective pattern differs from the built-in default**, as the first stdout line. It can't collide with waiver ids, which always start with `high-risk:`. `rad approve` parses the tag and freezes it as `approved.data.highRiskPattern`. There is one spawn and one resolver, and JS never holds a copy of the default.
2. **CI advisory:** `check-approval-integrity.sh` prints `advisory: approval recorded under a non-default high-risk pattern: <pattern>` when the gating approved event carries `data.highRiskPattern`. It never changes the exit code, following the existing ownership advisory (`:221`).

With the default pattern everything stays exactly as today: no tag line, no event key, no advisory.

## Scope

| In scope | Out of scope |
|---|---|
| `plan_high_risk_pattern_is_default` helper; blocker script's tag line | Blocking, warning or refusing on a narrowed pattern (provenance only) |
| `rad approve` parses the tag; `recordApproval` freezes `data.highRiskPattern` | `gates.js`, `transitions.js` and fingerprint rules |
| `check-approval-integrity.sh` advisory line | Recording other env knobs (`RAD_TOKEN_BUDGET` and so on) |
| `/rad-approve` prose (don't list the tag as a waiver) and a CLAUDE.md note | Back-filling historical approved events |

## Acceptance Criteria

1. `plan_high_risk_pattern_is_default` returns 0 when `plan_high_risk_pattern` equals `RAD_HIGH_RISK_DEFAULT_PATTERN` (env unset, empty, or set to the default string exactly), and 1 otherwise.
2. `check-approval-blockers.sh`, on exit 0:
   - Under the default pattern, its stdout is byte-identical to today's.
   - Under a non-default pattern, its stdout's first line is exactly `high-risk-pattern\t<effective pattern>`, followed by any applied waiver lines as today.
   - On exit 1 or 2, stdout stays empty, as today.
3. `rad approve` recognises a stdout line whose first TAB-separated field is exactly `high-risk-pattern` as provenance, not a waiver, and passes its value to `recordApproval`.
   - A duplicate tag, an empty value, or any other non-waiver line without a TAB is a fail-closed refusal: `approval blocker check failed`, nothing written.
   - Without the tag, the event contains no `highRiskPattern` key.
4. `recordApproval` accepts an optional `highRiskPattern` (a non-empty string) and freezes it as `data.highRiskPattern` only when present. Omitting it gives an event deep-equal to today's. A non-string or empty value throws before anything is appended.
5. `check-approval-integrity.sh` prints the advisory line when the gating approved event has `data.highRiskPattern`, and nothing new otherwise. Its exit code is unchanged in both cases.
6. `/rad-approve`'s Blockers & Waivers guidance renders the tag as "Recorded under a non-default high-risk pattern: …", not as a waiver. CLAUDE.md "Plan Lint — High-Risk Paths" notes that a non-default pattern is recorded in the approved event.
7. `npm test --prefix harness` passes, and every `scripts/test-*.sh` passes under `bash` and `/bin/bash` 3.2.

## Agent Scope

- Direct reads, confirmed by grep:
  - `plan_high_risk_pattern` / `RAD_HIGH_RISK_DEFAULT_PATTERN` (`plan-paths.sh:260-370`)
  - `check-approval-blockers.sh` `main` (`:101-118`)
  - `cli.js` `parseWaiverLines` / `checkApprovalBlockers` (`:865-905`) and the `recordApproval` call (`:1037-1060`)
  - `git-state-store.js` `recordApproval` (`:418-450`)
  - `check-approval-integrity.sh` parse (`:80-120`) and the ownership advisory (`:221`)
  - `rad-approve.md` Blockers & Waivers (`:130-185`)
  - CLAUDE.md High-Risk Paths (`:289-315`)
- Earlier in this session `approval-event-mapper` (architect) mapped `recordApproval`'s spread-when-present pattern and confirmed the gate fold ignores `data`, and `approval-command-mapper` (architect) mapped the approve refusal flow.
- Out-of-scope dependencies: none. The author is the architect; `harness/` and `scripts/` are self-protected.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 360-370 | `plan_high_risk_pattern_is_default` |
| scripts/check-approval-blockers.sh | 1-118 | Tag line on exit 0 under a non-default pattern; header comment |
| scripts/test-check-approval-blockers.sh | 195-225 | Tag present/absent cases |
| scripts/test-plan-paths.sh | 680-720 | `plan_high_risk_pattern_is_default` cases |
| harness/cli.js | 860-910 | Parse the tag; fail-closed on malformed or duplicate |
| harness/cli.js | 1035-1065 | Pass `highRiskPattern` to `recordApproval` |
| harness/adapters/git-state-store.js | 400-455 | `recordApproval` optional `highRiskPattern` |
| harness/test/git-state-store.test.js | 300-324 | Freeze / omit / invalid tests |
| harness/test/approval-authority-recording.test.js | 570-600 | Tag parsed into event; no tag → no key; malformed → refuse |
| scripts/check-approval-integrity.sh | 80-225 | Advisory line |
| scripts/test-check-approval-integrity.sh | 160-192 | Advisory present/absent, exit unchanged |
| .claude/commands/architect/rad-approve.md | 125-185 | Render the tag as provenance, not a waiver |
| CLAUDE.md | 289-315 | Note: non-default pattern recorded in the approved event |

## Program Design

### 1. Signatures introduced or altered

```bash
# scripts/lib/plan-paths.sh — new
plan_high_risk_pattern_is_default   # exit 0 iff effective pattern == RAD_HIGH_RISK_DEFAULT_PATTERN

# scripts/check-approval-blockers.sh — exit-0 stdout gains an optional FIRST line
high-risk-pattern<TAB><effective pattern>    # only when non-default
high-risk:<path><TAB><justification>         # applied waivers, unchanged
```

```js
// harness/adapters/git-state-store.js — additive optional input
recordApproval({ …, waivers, highRiskPattern /* non-empty string, frozen only when present */ })

// approved event data — additive optional key
{ fingerprint?, evidence?, waivers?, highRiskPattern?: '(^|/)billing(/|$)' }
```

### 2. Control-flow sketch

```
rad approve
 └─ sh(check-approval-blockers.sh)            env inherited from the architect
      exit 0 → stdout lines
         "high-risk-pattern\t<p>"  → highRiskPattern = p   ← NEW (≤1, non-empty)
         "high-risk:<path>\t<j>"   → waivers[]              [unchanged]
         anything else             → fail-closed refusal    [unchanged rule]
 └─ recordApproval({ …, waivers, highRiskPattern })          ← NEW key, spread-when-present

CI: check-approval-integrity.sh
 └─ gating approved event has data.highRiskPattern → "advisory: …"   ← NEW, exit unchanged
```

### 3. File-tree diff

```
scripts/lib/plan-paths.sh, check-approval-blockers.sh, check-approval-integrity.sh   M
scripts/test-{plan-paths,check-approval-blockers,check-approval-integrity}.sh       M
harness/cli.js, harness/adapters/git-state-store.js                                  M
harness/test/{git-state-store,approval-authority-recording}.test.js                  M
.claude/commands/architect/rad-approve.md, CLAUDE.md                                 M
```

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/transitions.js, harness/plan-fingerprint.js, harness/events.js
- `plan_high_risk_pattern`, `plan_high_risk_findings` and the other plan-paths.sh helpers (add the new helper next to them; don't change them)
- scripts/lint-plan.sh

### Key Files
- scripts/lib/plan-paths.sh — `plan_high_risk_pattern`, `RAD_HIGH_RISK_DEFAULT_PATTERN`
- scripts/check-approval-blockers.sh — `main`, `applied_waivers`, the exit-code constants
- harness/cli.js — `parseWaiverLines`, `checkApprovalBlockers`, and the `recordApproval` call site
- harness/adapters/git-state-store.js — `recordApproval`, `assertValidWaivers` (mirror its validation style)
- scripts/check-approval-integrity.sh — the embedded-node parse of the gating event, and the ownership `advisory:` line

### Reminders
- **Byte-identical under the default pattern:** blocker stdout, the approved event and integrity output all stay the same. Assert each explicitly.
- The tag name is exactly `high-risk-pattern` (dash). Waiver ids start with `high-risk:` (colon), so the parser must compare the whole first field, never a prefix.
- **Fail closed at approve:** a malformed, duplicate or empty tag refuses and writes nothing.
- A pattern contains `|`, `(`, `^` and `$`. Quote it everywhere, keep it verbatim in JSON, and avoid `echo -e`.
- Bash 3.2: run the shell tests under `/bin/bash`.

## Wave Plan

### Wave 1 — sequential
Verify: bash scripts/test-plan-paths.sh && /bin/bash scripts/test-plan-paths.sh && bash scripts/test-check-approval-blockers.sh && /bin/bash scripts/test-check-approval-blockers.sh
Tasks in this wave must run in sequence (the script uses the helper).

#### Task 1.1: Default-pattern predicate and the blocker script's tag line
File: scripts/lib/plan-paths.sh:360-370, scripts/check-approval-blockers.sh:1-118, scripts/test-plan-paths.sh:680-720, scripts/test-check-approval-blockers.sh:195-225
What:
- Add `plan_high_risk_pattern_is_default` to plan-paths.sh.
- In `check-approval-blockers.sh` `main`, on the exit-0 path, print `printf 'high-risk-pattern\t%s\n' "$(plan_high_risk_pattern)"` **before** the waiver lines, only when the predicate returns 1. Update the header comment's stdout contract.
- Tests for the predicate: unset, empty, the default string exactly, and a custom pattern.
- Tests for the blocker script:
  - default: stdout byte-identical to today (clean plan: empty; waived plan: waiver lines only)
  - custom pattern that matches nothing: exit 0, stdout exactly the tag line
  - custom pattern with an applied waiver: tag line then the waiver
  - custom pattern on a blocked plan: exit 1 and empty stdout
Validate: AC#1, AC#2 — both shell test files under `bash` and `/bin/bash`.

### Wave 2 — sequential
Verify: npm test --prefix harness
Tasks in this wave must run in sequence (the CLI passes what the store accepts).

#### Task 2.1: recordApproval freezes highRiskPattern
File: harness/adapters/git-state-store.js:400-455, harness/test/git-state-store.test.js:300-324
What: Add an optional `highRiskPattern` input with JSDoc. Validate it before anything is appended: it must be `undefined` or a non-empty string, and anything else throws a clear error. Freeze it as `data.highRiskPattern` only when present, using the spread-when-present pattern. Tests:
- frozen verbatim (a pattern containing `|()^$`)
- omitted gives an event deep-equal to baseline
- `''`, `null`, a number and an object each throw and write nothing
Validate: AC#4 — `npm test --prefix harness`.

#### Task 2.2: rad approve parses the tag
File: harness/cli.js:860-910, 1035-1065, harness/test/approval-authority-recording.test.js:570-600
What: Extend `parseWaiverLines`, or add a sibling parser, so a line whose first TAB-separated field is exactly `high-risk-pattern` sets `highRiskPattern`.
- A second tag, an empty value, or a line without a TAB is a parse failure. `checkApprovalBlockers` turns that into the existing "check failed" refusal.
- Pass `highRiskPattern` to `recordApproval` next to `waivers`.

Tests, using the injected-`sh` pattern:
- a tag plus a waiver gives `data.highRiskPattern` and `data.waivers`
- a tag alone gives `data.highRiskPattern` only
- no tag gives an event with no `highRiskPattern` key
- a duplicate tag, an empty value, and a `high-risk-pattern` line without a TAB each refuse with nothing written
- a `high-risk-patternX\t…` line is treated as a waiver id, not the tag (exact-field match)
Validate: AC#3 — `npm test --prefix harness`.

### Wave 3 — parallel
Verify: for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; /bin/bash "$t" >/dev/null || exit 1; done && npm test --prefix harness
Tasks in this wave can run in parallel (disjoint files).

#### Task 3.1: Integrity-check advisory
File: scripts/check-approval-integrity.sh:80-225, scripts/test-check-approval-integrity.sh:160-192
What: In the embedded parse of the gating (latest) approved event, extract `data.highRiskPattern` when it's a non-empty string. After the existing checks, next to the ownership advisory, print `advisory: approval recorded under a non-default high-risk pattern: <pattern>`. Never change the exit code. Tests:
- an event with the key gives the advisory line and the same PASS exit as without it
- an event without the key prints no advisory line
- existing cases unchanged
Validate: AC#5 — `bash` and `/bin/bash` `scripts/test-check-approval-integrity.sh`.

#### Task 3.2: /rad-approve prose and CLAUDE.md note
File: .claude/commands/architect/rad-approve.md:125-185, CLAUDE.md:289-315
What:
- In `/rad-approve` Step 2/3: the blocker check's stdout may start with a `high-risk-pattern<TAB><pattern>` line. Render it in the Blockers & Waivers block as `Recorded under a non-default high-risk pattern: <pattern>` so the architect sees the narrowing, and never list it as a waiver.
- In CLAUDE.md High-Risk Paths: one sentence saying an approval under a non-default pattern records it in `approved.data.highRiskPattern`, and CI shows an advisory.
This task has no unit-testable surface (prose).
Validate: AC#6 — read-through.

## Tests to Write
- [ ] plan_high_risk_pattern_is_default: unset / empty / exact default / custom — scripts/test-plan-paths.sh
- [ ] blocker script: tag only under a non-default pattern; default stdout byte-identical; blocked stdout empty — scripts/test-check-approval-blockers.sh
- [ ] recordApproval highRiskPattern: frozen / omitted deep-equal / invalid throws — harness/test/git-state-store.test.js
- [ ] approve parses the tag; no tag → no key; malformed or duplicate → refuse; exact-field match — harness/test/approval-authority-recording.test.js
- [ ] integrity advisory present / absent, exit unchanged — scripts/test-check-approval-integrity.sh

## Non-Goals
- Blocking, warning at approve time, or refusing because of a narrowed pattern. This is provenance plus a CI advisory only.
- Recording other environment knobs in the event.
- Back-filling or re-validating historical approved events.
- Changing the gate fold, transitions or fingerprint rules.

## Out-of-Scope Dependencies
None

## Risks
- **Contract change on the blocker script's stdout.** The only programmatic consumer is `cli.js`, updated in Wave 2. The `/rad-approve` prose prints stdout and is updated in Wave 3. Under the default pattern the output is byte-identical, so pre-existing behavior is unchanged.
- **Tag and waiver-id confusion.** This is prevented by exact first-field matching, and a `high-risk-patternX` test guards it.
- **A pattern with shell metacharacters.** It is quoted end to end and tested with `|()^$` in the harness and shell tests.
- **Approval-event mapping.** The gate fold (`gates.js`) reads only the frozen `role`, so a new `data` key can't change gate outcomes. That was confirmed by `approval-event-mapper` earlier in this session.

## Issue Gaps
- **[DECIDED — architect]** Channel: a tagged first line from the blocker script. CI: advisory only.
- **[ASSUMPTION]** "Differs from the default" means string inequality with `RAD_HIGH_RISK_DEFAULT_PATTERN` after the empty-means-default fallback. Setting the variable to the default string exactly counts as default and records nothing.
- **[ASSUMPTION]** The event key is `highRiskPattern` (camelCase, like `recordedBy`) and holds the effective pattern verbatim.
- **[ASSUMPTION]** The tag line comes first on stdout, but the parser doesn't depend on its position; only uniqueness is enforced.
