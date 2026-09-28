# Plan: Approval Blockers — Clarification Markers + Justify-or-Waive
Created: 2026-09-28
Author: architect
Status: pending-review
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-28T14:08:51.010Z
Recorded-By: sean@torchcodelab.com
Branch: rad/approval-blockers
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/69, https://github.com/seanrreid/RAD_framework/issues/68
Issue-Title: Plan ambiguity markers (#69) + Justify-or-waive advisory lint findings, waiver frozen into the approved event (#68)

## Context

Today every `lint-plan.sh` warning is advisory. A high-risk path prints `⚠` and
leaves no record that the architect saw it. Nothing stops a plan being approved
while it still holds unanswered questions. The planner's silent assumptions only
surface if they land in `## Issue Gaps`, and that section exists only for adopted
plans. #69 asks for inline `[NEEDS CLARIFICATION: …]` markers that block approval.
#68 asks that high-risk findings be resolved or explicitly waived, with the waiver
frozen into the `approved` event. Both issues say to share one mechanism.

**Architect decisions (2026-09-28):**
1. **Blocking set:** the blocking findings are un-waived **high-risk path** findings (`RAD_HIGH_RISK_PATTERNS`) and unresolved **clarification markers**. The **self-protected** advisory stays advisory. It fires on nearly every RAD-internal plan, and requiring a waiver for it would produce boilerplate nobody reads.
2. **Markers are resolve-only.** An unanswered question can't be waived. You answer it in the plan and delete the marker, and that edit is the record. `## Waivers` covers lint findings only.
3. **Fenced code blocks are skipped.** A marker inside a ```` ``` ```` block doesn't count, so plans and docs can show the convention as an example. The skip is still deterministic.

Research confirmed the write path is small:
- `recordApproval` already spreads optional provenance into `data`.
- The gate fold (`gates.js:94-99`) reads only the frozen `role`.
- The plan fingerprint covers the whole body from the first `##`, so a `## Waivers` edit changes it. The existing fingerprint-differ re-approval rule (`transitions.js:101-116`) already handles it.
- `check-plan-approved.sh` already fails closed on a post-approval body edit.

**Amendment (2026-09-28, during delivery, architect decisions after Wave 1):**
4. **Inline code spans are skipped too.** A marker inside a single-backtick span on a line doesn't count, in addition to ```` ``` ```` fences. Plans that describe the syntax inline would otherwise block themselves; this plan exited 1 with 8 descriptive markers.
5. **Empty `RAD_HIGH_RISK_PATTERNS` means the default, not "disabled".** The high-risk check can be narrowed but never switched off. That is what `lint-plan.sh:188` (`${…:-default}`) already does, so lint's behavior stays the same. CLAUDE.md's "Empty disables the check" was wrong, and it is corrected. Lint and the blocker check share one resolver, `plan_high_risk_pattern`.

**Amendment 6 (2026-09-28, after Wave 3):** two more existing approve tests fake the shell and send unknown scripts to the real runner: `harness/test/cli.test.js` (the AC#2 approve test) and `harness/test/portable-process-memory.test.js` (the RAD_SYNC-unset approve test). Their fakes needed the same pass-through route for `check-approval-blockers.sh` (exit 0, empty stdout) and nothing else. They are declared in scope here so the scope check passes on the plan's word, not on a bypass. The `rad-plan.md` range is also widened to cover the Rules bullet that Task 4.2 asks for.

**One structural constraint:** markers can't be lint **errors**. `/rad-plan` refuses to commit a plan that has lint errors, and a plan with open questions must stay committable so the team can discuss it. So blockers are a third lint category, shown by `lint-plan.sh` and enforced only by `rad approve`.

## Scope

| In scope | Out of scope |
|---|---|
| Shared blocker helpers in `scripts/lib/plan-paths.sh` (markers, high-risk finding IDs, waivers) | Making self-protected, freshness, Program Design or missing-file warnings blocking |
| New `scripts/check-approval-blockers.sh` (the single enforcement script) | Waiving clarification markers |
| `lint-plan.sh` shows an "Approval blockers" section and stale/invalid waiver warnings | Changing `lint-plan.sh`'s exit-code semantics (blockers never make it exit non-zero) |
| `rad approve` refuses on unresolved blockers and freezes applied waivers into `approved.data.waivers` | `architecture-approve` (`/rad-design`): architecture docs aren't plans |
| `/rad-approve`, `/rad-review`, `/rad-plan`, `/rad-adopt` prose, and CLAUDE.md Approval Rules | CI re-checking waivers (`check-approval-integrity.sh`), `gates.js`, `transitions.js`, fingerprint rules |

## Acceptance Criteria

1. `plan_clarification_markers <plan>` prints one `<line>\t<question>` per `[NEEDS CLARIFICATION: <question>]` occurrence outside fenced code blocks. A marker inside a ```` ``` ```` fence or inside a single-backtick inline code span is not reported, and one on a line after the closing fence (or outside the span on the same line) is. An empty question `[NEEDS CLARIFICATION: ]` still counts as a marker. A plan with no markers prints nothing and returns 0.
2. `plan_high_risk_findings <plan>` prints one stable ID `high-risk:<path>` per scope path matching `RAD_HIGH_RISK_PATTERNS` (the built-in default when unset **or empty**, so the check can't be disabled), resolved by the shared `plan_high_risk_pattern`, using the same matcher and the same `plan_scope_paths` union that the existing high-risk advisory uses. `plan_waivers <plan>` prints one `<id>\t<justification>` per `- <id>: <justification>` bullet in `## Waivers`, splitting on the first `": "`. A bullet with an empty justification is dropped (never an applied waiver). No `## Waivers` section prints nothing.
3. `scripts/check-approval-blockers.sh <plan>`:
   - **Exit 0** when no blockers remain. Stdout has exactly one `<id>\t<justification>` line per waiver that matches a current high-risk finding.
   - **Exit 1** when any marker or un-waived high-risk finding remains. Each is named on stderr (the line number for markers, the ID for findings), and stdout is empty.
   - **Exit 2** for a missing, unreadable or empty plan file, or a usage error, with a clear message. It never exits 0 on error.
   - A waiver whose ID matches no current finding (stale), or that names a `clarify` item, is never applied and never blocks.
4. `lint-plan.sh` prints a new `Approval blockers (resolve or waive before /rad-approve):` section listing every unresolved marker (`line N`) and un-waived high-risk finding (its ID). The existing high-risk warning line includes the finding ID, and lint resolves the pattern through the shared `plan_high_risk_pattern` (no duplicate default string). Stale waivers, empty-justification waivers and waivers naming a marker get `⚠` warnings. Blockers never change `lint-plan.sh`'s exit code. For a plan with no markers, no high-risk paths and no `## Waivers` section, the output is identical to today's apart from the ID now shown in any high-risk warning line.
5. `recordApproval` accepts an optional `waivers: Array<{id, justification}>` and freezes it as `data.waivers` only when it is a non-empty array. With `waivers` omitted or `[]`, the appended event deep-equals today's.
6. `rad approve` runs `check-approval-blockers.sh` after the role/proxy checks and before `recordApproval`, in default and proxy modes alike.
   - **Exit 1:** approve exits 1, relays the blockers on stderr, and writes nothing: no event, no plan-doc Status change.
   - **Any other non-zero exit or a spawn error:** approve refuses fail-closed and writes nothing.
   - **Exit 0:** approve records the parsed waivers.
   - A plan with no blockers and no waivers produces an `approved` event identical to today's.
7. `/rad-approve` shows outstanding blockers and applied waivers (with justifications) in its review summary before the confirmation prompt, and says the CLI refusal is final. `/rad-review` shows them as advisory. `/rad-plan` and `/rad-adopt` require open questions to be written as inline `[NEEDS CLARIFICATION: …]` markers and never silently assumed. `/rad-adopt` keeps `## Issue Gaps` for assumptions the planner **did** make. CLAUDE.md Approval Rules lists the two new requirements, and CLAUDE.md "Plan Lint — High-Risk Paths" says an empty value falls back to the default (the check can be narrowed, never disabled).
8. `npm test --prefix harness` and every `scripts/test-*.sh` pass, including under `/bin/bash` 3.2 for the shell tests.

## Agent Scope

- `approval-event-mapper` (architect): `recordApproval` freeze pattern (`git-state-store.js:374-407`), event typedef (no data-key schema), gate fold reads only `role`, fingerprint coverage (`plan-fingerprint.js:26-60`), re-approval rule (`transitions.js:101-116`), integrity check reads data keys without an allow-list.
- `approval-command-mapper` (architect): `approveCommand` refusal flow (`cli.js:880-1026`), with the insertion slot between the role checks (`:947-976`) and `recordApproval` (`:987-998`). Also the `sh(script, args, {cwd})` invocation pattern, `rad-approve.md` lint/review/confirm/CLI steps, the refusal test pattern (`approval-authority-recording.test.js:431-469`), and `check-plan-approved.sh` (fingerprint only, no lint).
- `lint-surface-mapper` (architect): `ERRORS`/`WARNINGS` arrays and output sections (`lint-plan.sh:21-22, 372-394`), high-risk advisory (`:196`), `section_content` helper (`:38-40`), `plan_scope_paths` / `path_matches` (`plan-paths.sh:72-92`), no fenced-block handling anywhere, and the bash 3.2 test conventions (`test-lint-plan.sh:10, 26-38`).
- Out-of-scope dependencies: none. The author is the architect, and `harness/`, `scripts/` and `.claude/` are self-protected.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 240-257 | Append `plan_clarification_markers`, `plan_high_risk_findings`, `plan_waivers` |
| scripts/test-plan-paths.sh | 300-323 | Append cases for the three helpers |
| scripts/check-approval-blockers.sh | 1-110 | New enforcement script (exit 0/1/2 contract) |
| scripts/test-check-approval-blockers.sh | 1-200 | New fixture test |
| scripts/lint-plan.sh | 185-200 | High-risk warning line carries the finding ID |
| scripts/lint-plan.sh | 360-394 | "Approval blockers" section + waiver warnings |
| scripts/test-lint-plan.sh | 560-581 | Append blocker/waiver/fence cases |
| harness/adapters/git-state-store.js | 370-410 | `recordApproval` optional `waivers` |
| harness/test/git-state-store.test.js | 220-236 | Append waivers freeze tests |
| harness/cli.js | 940-1030 | Blocker check before `recordApproval`; pass waivers |
| harness/test/approval-authority-recording.test.js | 1-60 | Route the new script in the shared `sh` fake (pass-through only) |
| harness/test/approval-authority-recording.test.js | 430-469 | Append refusal / waiver / fail-closed tests |
| harness/test/cli.test.js | 1-120 | Shell-fake pass-through route for the blocker script only (amendment 6) |
| harness/test/portable-process-memory.test.js | 1-200 | Shell-fake pass-through route for the blocker script only (amendment 6) |
| .claude/commands/architect/rad-approve.md | 110-235 | Show blockers + waivers; CLI refusal is final |
| .claude/commands/team/rad-review.md | 53-63 | Step 2b: blockers advisory |
| .claude/commands/team/rad-plan.md | 93-205 | Marker convention + `## Waivers` in the template |
| .claude/commands/team/rad-plan.md | 266-285 | Rules bullet for the marker convention |
| .claude/commands/team/rad-adopt.md | 160-176 | Marker convention next to Issue Gaps |
| CLAUDE.md | 289-307 | High-Risk Paths: empty falls back to the default |
| CLAUDE.md | 383-395 | Approval Rules: two new requirements |

## Program Design

### 1. Signatures introduced or altered

```bash
# scripts/lib/plan-paths.sh — new, sourced by lint-plan.sh and check-approval-blockers.sh
plan_clarification_markers <plan>  # stdout: "<line>\t<question>" per marker outside ``` fences
plan_high_risk_findings <plan>     # stdout: "high-risk:<path>" per matching plan_scope_paths entry
plan_waivers <plan>                # stdout: "<id>\t<justification>" per "- <id>: <justification>" in ## Waivers

# scripts/check-approval-blockers.sh — new
scripts/check-approval-blockers.sh <plan>
#   exit 0 = no blockers; stdout = applied waivers, one "<id>\t<justification>" per line
#   exit 1 = blockers remain; stderr names each; stdout empty
#   exit 2 = usage / missing / unreadable / empty plan
```

```js
// harness/adapters/git-state-store.js — additive optional input
recordApproval({ feature, actor, requiredRole, recordedBy, ts, evidence, fingerprint,
                 waivers /* Array<{id, justification}>, frozen only when non-empty */ })

// approved event data — additive optional key
{ evidence?, fingerprint?, waivers?: [{ id: 'high-risk:scripts/auth.sh', justification: '...' }] }
```

```markdown
## Waivers
- high-risk:scripts/token-budget.sh: "token" matches the budget knob, not credentials — no secret handling
```

### 2. Control-flow sketch

```
rad approve <feature> [--on-behalf-of … --evidence …]   (harness/cli.js)
 ├─ parse args, plan exists, git user                          [unchanged]
 ├─ role / proxy checks (check-role.sh)                        [unchanged]
 ├─ sh(check-approval-blockers.sh, [plan])                     ← NEW
 │    ├─ exit 1        → stderr relayed, return 1, no write
 │    ├─ exit ≠ 0/1    → fail-closed refusal, return 1, no write
 │    └─ exit 0        → waivers = parse stdout lines
 ├─ recordApproval({ …, fingerprint, waivers })                ← waivers added
 └─ writePlanStatus (display mirror)                           [unchanged]

lint-plan.sh (advisory display)          check-approval-blockers.sh (enforcement)
        └───────── both source scripts/lib/plan-paths.sh helpers ─────────┘
```

### 3. File-tree diff

```
scripts/
  lib/plan-paths.sh                      M  +3 helpers
  check-approval-blockers.sh             A  enforcement script
  test-check-approval-blockers.sh        A  fixture test
  lint-plan.sh                           M  blockers section, finding IDs, waiver warnings
  test-plan-paths.sh, test-lint-plan.sh  M  new cases
harness/
  adapters/git-state-store.js            M  recordApproval waivers
  cli.js                                 M  blocker check before the write
  test/git-state-store.test.js           M
  test/approval-authority-recording.test.js M
.claude/commands/{architect/rad-approve,team/rad-review,team/rad-plan,team/rad-adopt}.md  M
CLAUDE.md                                M  Approval Rules
```

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/transitions.js, harness/plan-fingerprint.js, harness/events.js
- scripts/check-plan-approved.sh, scripts/check-approval-integrity.sh
- The `RAD_SELF_PROTECTED_PATTERN` literal and `path_is_self_protected` in scripts/lib/plan-paths.sh
- .claude/commands/architect/rad-design.md (`architecture-approve` is out of scope)

### Key Files
- scripts/lib/plan-paths.sh — `plan_scope_paths`, `path_matches`, and how the high-risk default is resolved; the helpers must reuse them, not re-implement them
- scripts/lint-plan.sh — `section_content`, the `ERRORS`/`WARNINGS` arrays, the output sections
- harness/cli.js — `approveCommand` refusal flow and the `sh` port
- harness/adapters/git-state-store.js — `recordApproval` spread-when-present pattern
- harness/test/approval-authority-recording.test.js — the shared `sh` fake (:29) and the refusal test (:431-469)

### Reminders
- Bash 3.2: no associative arrays, no `mapfile`. Run the shell tests under `/bin/bash` too.
- One source of truth. `lint-plan.sh` and `check-approval-blockers.sh` both call the `plan-paths.sh` helpers; neither parses markers or waivers itself.
- The high-risk default and empty-disables semantics must match the existing advisory exactly. Read them from wherever `lint-plan.sh` resolves `RAD_HIGH_RISK_PATTERNS` today.
- Fail closed at the approve boundary. Only exit 0 from the blocker script allows a write.
- Backward compatibility: no blockers and no waivers must give an `approved` event deep-equal to today's.
- Existing approve tests must keep passing. The only permitted edit to existing test code is routing the new script through the shared `sh` fake as a pass-through (exit 0, empty stdout).

## Wave Plan

### Wave 1 — sequential
Verify: bash scripts/test-plan-paths.sh && /bin/bash scripts/test-plan-paths.sh && bash scripts/test-check-approval-blockers.sh && /bin/bash scripts/test-check-approval-blockers.sh
Tasks in this wave must run in sequence (the script sources the helpers).

#### Task 1.1: Blocker helpers in plan-paths.sh
File: scripts/lib/plan-paths.sh:240-257, scripts/test-plan-paths.sh:300-323
What: Append the three helpers to `plan-paths.sh`, with header comments that state constraints:
- `plan_clarification_markers`: awk that tracks ```` ``` ```` fence state (a line starting with three backticks toggles it) and emits `NR\t<question>` for each `[NEEDS CLARIFICATION:` … `]` outside a fence. Multiple markers on one line are each reported.
- `plan_high_risk_findings`: pipe `plan_scope_paths` through the existing high-risk matcher and default, emitting `high-risk:<path>`, de-duplicated.
- `plan_waivers`: read the `## Waivers` body up to the next `## `, match `- <id>: <justification>` bullets, split on the first `": "`, trim, drop empty justifications.

Each helper returns non-zero with a message on stderr for a missing or unreadable plan. Append `test-plan-paths.sh` cases:
- a marker outside a fence, inside a fence, and after a closing fence
- two markers on one line, and an empty question
- no markers
- a high-risk default path, a custom pattern, and an empty pattern (disabled)
- waivers: a valid one, an empty justification, a justification containing `: `, no section, and a section followed by another `##`
Validate: AC#1, AC#2 — `bash scripts/test-plan-paths.sh` and `/bin/bash scripts/test-plan-paths.sh` pass.

#### Task 1.2: check-approval-blockers.sh
File: scripts/check-approval-blockers.sh:1-110, scripts/test-check-approval-blockers.sh:1-200
What: New script that sources `lib/plan-paths.sh`. Validate args and the plan (missing, unreadable or empty → exit 2 with a message). Compute markers, high-risk findings and waivers. Applied waivers are those whose ID equals a current finding. Blockers are all markers plus the findings with no applied waiver. If there are blockers, name each on stderr and exit 1 with empty stdout. Otherwise print the applied waivers as `<id>\t<justification>` and exit 0. Stale waivers and waivers naming a `clarify` item are ignored here; `lint-plan.sh` warns about them. Keep functions under ~40 lines, and name the exit codes as constants. The new co-located test covers:
- a clean plan (exit 0, empty stdout)
- one marker (exit 1, line named)
- a fenced marker only (exit 0)
- a high-risk path with no waiver (exit 1, ID named)
- a matching waiver (exit 0, exact stdout)
- a stale waiver alone (exit 0, not printed)
- an empty-justification waiver (exit 1)
- a marker plus a waived finding (exit 1)
- `RAD_HIGH_RISK_PATTERNS=''` (exit 0)
- a missing file, an empty file and no args (exit 2)
Validate: AC#3 — `bash scripts/test-check-approval-blockers.sh` and `/bin/bash scripts/test-check-approval-blockers.sh` pass.

#### Task 1.3: Apply the amendment to the helpers
File: scripts/lib/plan-paths.sh:240-257, scripts/test-plan-paths.sh:300-323, scripts/test-check-approval-blockers.sh:1-200
What: Apply amendment decisions 4 and 5.
- `plan_clarification_markers` also ignores markers inside single-backtick inline code spans on a line, while still reporting a marker outside a span on the same line.
- `plan_high_risk_pattern` treats an empty `RAD_HIGH_RISK_PATTERNS` as unset (`${…:-default}`).
- Update the test cases:
  - Add: an inline-span marker is not reported; a line with one span marker and one plain marker reports one.
  - Change the empty-pattern cases in both test files so that empty gives the default. In `test-check-approval-blockers.sh`, `RAD_HIGH_RISK_PATTERNS=''` with a high-risk path now exits 1.
  - Add a narrowed custom pattern that doesn't match: exit 0.
- Confirm `check-approval-blockers.sh .agents/plans/approval-blockers.md` no longer reports the inline descriptive markers.
Validate: AC#1, AC#2, AC#3 — both test files pass under `bash` and `/bin/bash`.

### Wave 2 — sequential
Verify: bash scripts/test-lint-plan.sh && /bin/bash scripts/test-lint-plan.sh && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done
Tasks in this wave must run in sequence.

#### Task 2.1: lint-plan.sh blockers section and waiver warnings
File: scripts/lint-plan.sh:185-200, 360-394, scripts/test-lint-plan.sh:560-581
What:
- Append the finding ID to the existing high-risk warning line (`… (id: high-risk:<path>)`).
- Replace lint's own default at `:188` with the shared `plan_high_risk_pattern`. Behavior is unchanged: empty still gives the default.
- Add a `BLOCKERS=()` array filled from the Wave 1 helpers: unresolved markers as `clarification marker at line N: <question>`, and un-waived findings as `<id>`.
- Print an `Approval blockers (resolve or waive before /rad-approve):` section with a `⛔` prefix after the warnings section, and only when the array is non-empty.
- Add `⚠` warnings for stale waivers, empty-justification waivers and waivers naming `clarify`.
- The exit code stays driven by `ERRORS` only.
- Existing `test-lint-plan.sh` assertions that grep the high-risk line keep passing, because the ID is appended and the existing text stays a substring.

New cases:
- a marker gives the blocker section and exit 0
- a fenced marker gives no blocker section
- a waived high-risk path gives no blocker section, with the warning still shown
- the three waiver warnings
- a plan with no markers, high-risk paths or waivers prints no blocker section
Validate: AC#4, AC#8 — `bash scripts/test-lint-plan.sh`, `/bin/bash scripts/test-lint-plan.sh`, and every `scripts/test-*.sh` pass.

### Wave 3 — sequential
Verify: npm test --prefix harness
Tasks in this wave must run in sequence (the CLI passes what the store accepts).

#### Task 3.1: recordApproval freezes waivers
File: harness/adapters/git-state-store.js:370-410, harness/test/git-state-store.test.js:220-236
What: Add an optional `waivers` input to `recordApproval`, with JSDoc. Freeze it as `data.waivers` only when it is a non-empty array of `{id, justification}` string pairs. A non-array or malformed entry throws a clear error; don't drop it silently. Keep the existing spread-when-present pattern. Append tests:
- waivers frozen verbatim
- omitted and `[]` both give an event deep-equal to one recorded without the key
- a malformed entry throws and appends nothing
Validate: AC#5 — `npm test --prefix harness`.

#### Task 3.2: rad approve refuses on blockers and passes waivers
File: harness/cli.js:940-1030, harness/test/approval-authority-recording.test.js:1-60, 430-469
What: In `approveCommand`, after the role/proxy checks and before `recordApproval`, call `sh('<repoRoot>/scripts/check-approval-blockers.sh', [planPath], { cwd: repoRoot })`.
- Status 1 → write `rad approve: refused — unresolved approval blockers` plus the script's stderr, and return 1.
- Any other non-zero status or a thrown spawn error → `rad approve: refused — approval blocker check failed (<detail>)`, return 1.
- Status 0 → parse stdout lines into `[{id, justification}]` and pass them to `recordApproval`.

Route the new script in the shared test `sh` fake as a pass-through (exit 0, empty stdout), with no other changes to existing tests. Append tests:
- blockers give exit 1, stderr relayed, no `events.jsonl`, plan Status unchanged
- script status 2 and a thrown spawn error both give exit 1 and no write
- waivers stdout gives `approved.data.waivers` equal to the parsed pairs
- empty stdout gives an event with no `waivers` key
- proxy mode also refuses on blockers
Validate: AC#6 — `npm test --prefix harness`; the existing approve tests pass unchanged apart from the fake routing.

### Wave 4 — parallel
Verify: npm test --prefix harness && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done
Tasks in this wave can run in parallel (disjoint prose files).

#### Task 4.1: /rad-approve and /rad-review surfaces
File: .claude/commands/architect/rad-approve.md:110-235, .claude/commands/team/rad-review.md:53-63
What: In `/rad-approve` Step 2/3, run `scripts/check-approval-blockers.sh "$PLAN_FILE"` alongside the lint. Render a "Blockers & Waivers" block in the review summary before the confirmation prompt. It lists unresolved blockers, telling the architect that approval will be refused until they are resolved or waived, and lists applied waivers with their justifications for the architect to judge. State that the CLI refusal in Step 4 is final and must not be worked around. In `/rad-review` Step 2b, show the same blockers as advisory. This task has no unit-testable surface (it is prompt prose); the behavior it describes is enforced and tested in Wave 3.
Validate: AC#7 — manual read-through. The blocker script command in the prose runs as written against this plan. Harness and script suites stay green.

#### Task 4.2: Marker convention in /rad-plan, /rad-adopt and CLAUDE.md
File: .claude/commands/team/rad-plan.md:93-205, .claude/commands/team/rad-adopt.md:160-176, CLAUDE.md:383-395
What:
- In the `/rad-plan` template and generation rules: any open question or unmade decision **must** be written inline as `[NEEDS CLARIFICATION: <question>]` and never silently resolved by assumption. Add an optional `## Waivers` section to the template, with the `- high-risk:<path>: <justification>` format, and note that markers can't be waived.
- In `/rad-adopt`: the same marker rule, and distinguish it from `## Issue Gaps`, which records assumptions the planner did make.
- In CLAUDE.md "Plan Lint — High-Risk Paths" (:306): replace "Empty disables the check." with "Empty falls back to the default — the check can be narrowed, never disabled."
- In CLAUDE.md Approval Rules: add two checklist items, "No unresolved `[NEEDS CLARIFICATION]` markers (enforced by `rad approve`)" and "Every high-risk path finding resolved or waived in `## Waivers`, and waivers are frozen into the `approved` event".

Show examples inside fenced blocks so they don't trip the lint. This task has no unit-testable surface (prompt prose and config docs).
Validate: AC#7 — `scripts/lint-plan.sh` on this plan still shows no errors, and the harness and script suites stay green.

## Tests to Write
- [ ] marker helper: outside/inside/after fence, inline span, span + plain on one line, two per line, empty question, none — scripts/test-plan-paths.sh
- [ ] high-risk finding IDs: default, custom, empty pattern falls back to default — scripts/test-plan-paths.sh
- [ ] waiver parser: valid, empty justification, `: ` in justification, no section, bounded section — scripts/test-plan-paths.sh
- [ ] blocker script exit 0/1/2 contract across all fixture cases — scripts/test-check-approval-blockers.sh
- [ ] lint blockers section, fenced marker, waived finding, waiver warnings, unchanged clean output — scripts/test-lint-plan.sh
- [ ] recordApproval waivers frozen / omitted / empty / malformed — harness/test/git-state-store.test.js
- [ ] approve refuses on blockers, fails closed on script error, freezes waivers, proxy refuses — harness/test/approval-authority-recording.test.js

## Waivers
- high-risk:harness/test/approval-authority-recording.test.js: "auth" matches approval-*authority*, not authentication; the file is the approve-verb test suite and handles no credentials

## Non-Goals
- Making the self-protected, freshness, Program Design or missing-file advisories blocking.
- Waiving clarification markers.
- Re-checking waivers in CI (`check-approval-integrity.sh`) or in the deliver gate.
- Applying blockers to `architecture-approve` / `/rad-design`.
- Re-linting plans approved before this change.

## Out-of-Scope Dependencies
None

## Risks
- **Environment-dependent gate.** High-risk findings come from `RAD_HIGH_RISK_PATTERNS` in the approving architect's env. The check can't be disabled, since empty falls back to the default, but it can be narrowed to a pattern that matches nothing. That is inside the operator trust boundary, and nothing records the narrowing (see Issue Gaps).
- **The default pattern is broad.** `token` matches paths such as a token-budget script. Expect occasional justified waivers. That is the mechanism working as designed, not noise.
- **Existing approve tests use a shared `sh` fake.** The new script call must be routed as a pass-through, or every existing approve test breaks. The plan permits only that edit.
- **Plans that document the convention** (this one included) must keep literal markers inside fenced blocks. The fence skip handles that, and Task 4.2 follows it.

## Issue Gaps
- **[ASSUMPTION — #68]** Finding IDs are `high-risk:<path>`: stable across edits, readable, with no hashing. There is one ID per path, even when several task `File:` lines cite that path.
- **[ASSUMPTION — #68]** A waiver whose ID matches no current finding is stale. `lint-plan.sh` warns, and it never blocks and is never frozen. Only waivers that match a current finding go into the event.
- **[ASSUMPTION — #69]** A marker is the literal `[NEEDS CLARIFICATION:` … `]` on a single line. Multi-line markers aren't supported, and an unclosed `[NEEDS CLARIFICATION:` with no `]` isn't matched. The convention text tells planners to keep a marker on one line.
- **[DECIDED — #69, amendment 4]** Triple-backtick fences and single-backtick inline spans are skipped. `~~~` fences aren't.
- **[DECIDED — amendment 5]** An empty `RAD_HIGH_RISK_PATTERNS` falls back to the default, so the blocker can't be disabled. A narrowed pattern isn't recorded in the event; recording the effective pattern is left for a follow-up.
- **[ASSUMPTION]** `/rad-review` and `/rad-approve` prose changes are validated by reading them through. Their behavior is enforced and tested at the CLI (Wave 3).
