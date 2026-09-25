# Plan: Remove Severity Auto-Approval
Created: 2026-09-25
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-25T20:48:39.484Z
Recorded-By: sean@torchcodelab.com
Branch: rad/remove-severity-auto-approval
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/137
Issue-Title: Remove severity-routed auto-approval (Green Lane v1): no code path may approve a plan without a human

## Context

On 2026-09-25 the architect decided to remove the Green Lane entirely. The planned
arc (#75, #76, #111) is closed. This plan removes the **shipped** version 1: the
severity-routed auto-approval from #37. On every direct `rad approve`, `harness/cli.js`
runs `scripts/classify-low-risk.sh`. If the plan classifies low-risk (only possible
when `RAD_LOW_RISK_PATTERNS` is set), it records an `approved` event through
`recordPolicyApproval` (`harness/adapters/git-state-store.js`) with
`actor: 'severity-gate'` and `recordedBy: 'policy'`, with no human involved. The
feature is off by default, and **no event log contains a policy approval**
(re-checked while planning), so nothing depends on it at runtime.

The feature also shipped 7 agent files, a CLAUDE.md config section, `.env.example`
config, an audit section in `/rad-insights` and `/kickoff`, and doc references.
Separately, `scripts/check-approval-integrity.sh` never inspects `actor` or
`recordedBy`, so a policy approval committed by the architect would pass CI today.

RAD's stance, which Dex Horthy's *"Why Software Factories Fail"* informed, is
human judgment at plan approval. Planning quality (`triage:planning-arc`) replaces
auto-approval as the focus.

## Scope

| In scope | Out of scope |
|---|---|
| Remove the `severity-gate` branch, `classifyLowRisk`, and `recordPolicyApproval` | The human and proxy approval path (`recordApproval`, `--on-behalf-of`) |
| Delete `classify-low-risk.sh`, its test, and the 7 feature agents with their scope-map rows | `plan-paths.sh` functions, `RAD_SELF_PROTECTED_PATTERN`, `RAD_HIGH_RISK_PATTERNS` |
| `check-approval-integrity.sh` rejects policy or machine approvals (fail-closed) | Adding a rejection inside the gate fold (`gates.js`) or `transitions.js` |
| Remove the CLAUDE.md Severity Routing section, `.env.example` config, and the `/rad-insights` and `/kickoff` audit | Historical artifacts under `.agents/{plans,logs,state,research,architecture}` and `findings.jsonl` |
| Reword the self-protected advisory, comments and docs that reference the feature | The planning-arc features themselves (#80, #81, #82, #69, #68) |

## Acceptance Criteria

1. `harness/cli.js` no longer has `classifyLowRisk` or the auto-clear block in `approveCommand`. `git-state-store.js` no longer has `recordPolicyApproval` (function, typedef, export). The human and proxy approve paths behave exactly as before, including the `--evidence without --on-behalf-of` refusal.
2. A regression test proves that no approval happens without a human. With `RAD_LOW_RISK_PATTERNS='.*'` set, a direct `rad approve` by a non-architect fails with the existing role refusal and writes no `approved` event, and the state store exposes no `recordPolicyApproval`.
3. `scripts/classify-low-risk.sh` and `scripts/test-classify-low-risk.sh` are deleted, the shell-safety baseline entry is removed, and `plan-paths.sh`, `test-plan-paths.sh` and `test-lint-plan.sh` comments no longer reference the classifier. `lint-plan.sh`'s self-protected advisory says the path "always requires architect review" instead of "never auto-clearable", and the matching `test-lint-plan.sh` assertions are updated in the same change.
4. `scripts/check-approval-integrity.sh` fails closed (exit 1, a `FAIL: … Failing closed.` line) when the gating `approved` event has `actor: 'severity-gate'` or `recordedBy: 'policy'`, even when committed by the architect. A new case in `scripts/test-check-approval-integrity.sh` covers it, and all existing cases pass.
5. The 7 agent files are deleted together with their 7 Agent Scope Map rows in CLAUDE.md, in the same commit, and `scripts/lint-agent-files.sh` passes. The CLAUDE.md "### Severity Routing — Low-Risk Allowlist" section is removed. "### Self-Protected Paths" is reworded so it describes only the lint advisory (no classifier, no auto-clear). `.env.example`'s severity block is removed and its self-protected note reworded. `approval-event-mapper.md` drops its `recordPolicyApproval` mentions.
6. `/rad-insights` "Step 6: Report auto-cleared changes" and `/kickoff`'s auto-clear counter (the paragraph, jq block and template line) are removed, and nothing else in either file refers to them.
7. `docs/behavior-map-deliver-gate.md`, `docs/cosmos-vs-rad.md` and `docs/wsd-vs-rad.md` no longer present severity routing as a live capability. Outside the historical `.agents/**` artifacts, a repo-wide `grep -rE "severity-gate|RAD_LOW_RISK_PATTERNS|classify-low-risk|recordPolicyApproval"` finds only the integrity check's rejection and its test. `npm test --prefix harness`, every `scripts/test-*.sh`, `lint-agent-files.sh` and `lint-shell-safety.sh` pass.

## Agent Scope

No agents were called. Research was one Explore sub-agent (9 of 10 searches)
covering every file that references the feature, the approve flow, the store, the
integrity check, the 7 agents and the scope-map sync lint, the tests, and the docs.
Note: the Agent Scope Map carries a "Generated by /rad-design" comment. Removing the
7 rows by hand keeps `lint-agent-files.sh` green, and this is recorded here as a
deliberate architect edit.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 835-1015 | Remove `classifyLowRisk`, the auto-clear block, and the policy-only Recorded-By mirror; reword comments |
| harness/adapters/git-state-store.js | 200-205 | Remove the `recordPolicyApproval` typedef |
| harness/adapters/git-state-store.js | 405-450 | Remove `recordPolicyApproval` |
| harness/adapters/git-state-store.js | 608-614 | Remove the export |
| harness/test/policy-approval.test.js | delete | Wholly about the feature (2 human-path cases move) |
| harness/test/approval-authority-recording.test.js | 10-15 | Reword comment; receive the 2 human-path cases and the regression test |
| harness/test/portable-process-memory.test.js | 15-20 | Reword comment |
| harness/test/portable-process-memory.test.js | 240-265 | Replace the `recordPolicyApproval` baseline with a human approval |
| scripts/classify-low-risk.sh | delete | Remove classifier |
| scripts/test-classify-low-risk.sh | delete | Remove classifier tests |
| scripts/lint-shell-safety-baseline.txt | 1-15 | Drop the `classify-low-risk.sh` entry |
| scripts/lib/plan-paths.sh | 1-10 | Header comment: sourced by `lint-plan.sh` only |
| scripts/lint-plan.sh | 215-225 | Advisory wording: "always requires architect review" |
| scripts/test-lint-plan.sh | 200-242 | Update wording asserts; reword comment |
| scripts/test-plan-paths.sh | 15-22 | Reword comment |
| scripts/check-approval-integrity.sh | 85-130 | Fail-closed rejection of policy or machine approvals |
| scripts/test-check-approval-integrity.sh | 60-200 | New case: a policy approval committed by the architect exits 1 |
| .claude/agents/severity-approval-parent-orchestrator.md | delete | Feature agent |
| .claude/agents/gate-authority-orchestrator.md | delete | Feature agent |
| .claude/agents/gate-authority-mapper.md | delete | Feature agent |
| .claude/agents/severity-classifier-orchestrator.md | delete | Feature agent |
| .claude/agents/classifier-surface-mapper.md | delete | Feature agent |
| .claude/agents/audit-surface-orchestrator.md | delete | Feature agent |
| .claude/agents/audit-surface-mapper.md | delete | Feature agent |
| .claude/agents/approval-event-mapper.md | 10-30 | Drop `recordPolicyApproval` mentions |
| CLAUDE.md | 305-365 | Remove Severity Routing; reword Self-Protected Paths |
| CLAUDE.md | 448-460 | Remove the 7 scope-map rows |
| .env.example | 58-78 | Remove the severity block; reword the self-protected note |
| .claude/commands/shared/rad-insights.md | 885-935 | Remove Step 6 (auto-cleared changes) |
| .claude/skills/kickoff/SKILL.md | 68-110 | Remove the auto-clear counter and template line |
| docs/behavior-map-deliver-gate.md | 185-290 | Drop the policy auto-clear bullet, anchor and observation |
| docs/cosmos-vs-rad.md | 40-106 | Remove severity-routing claims |
| docs/wsd-vs-rad.md | 150-158 | Rewrite the monotonicity example around the lint advisory |

## Program Design

**Signatures removed** (nothing is added to the public surface):

```js
// harness/cli.js
function classifyLowRisk(...)                 // removed
// harness/adapters/git-state-store.js
async recordPolicyApproval(feature, opts)     // removed (typedef + export too)
```

**`rad approve` control flow, before and after:**

```
before                                         after
──────                                         ─────
parse args / plan exists / store               parse args / plan exists / store
evidence-without-proxy? → refuse               evidence-without-proxy? → refuse
if !proxy:                                     (block removed)
  classify-low-risk.sh → low?
    recordPolicyApproval(severity-gate) → OK
human/proxy path:                              human/proxy path (unchanged):
  check-role.sh → recordApproval → status        check-role.sh → recordApproval → status
```

**Integrity check addition:**

```
check-approval-integrity.sh
  parse latest approved event → { line, policy }
  no approved event → FAIL (unchanged)
  policy == 1       → FAIL "recorded by a machine policy, not a human architect"   ← new
  ancestry / fingerprint / architect-authored (unchanged)
```

**File-tree diff:**

```
- scripts/classify-low-risk.sh
- scripts/test-classify-low-risk.sh
- harness/test/policy-approval.test.js
- .claude/agents/{severity-approval-parent-orchestrator, gate-authority-orchestrator,
                  gate-authority-mapper, severity-classifier-orchestrator,
                  classifier-surface-mapper, audit-surface-orchestrator,
                  audit-surface-mapper}.md
~ everything else in Files in Scope (section removals and rewords)
```

## Execution Notes

### Do Not Touch
- `recordApproval` in `git-state-store.js` and the proxy path in `cli.js`: the human authority path.
- `harness/gates.js`, `harness/events.js`, `harness/gates.yaml`, `harness/transitions.js`: no fold or transition change.
- `scripts/lib/plan-paths.sh` functions and `RAD_SELF_PROTECTED_PATTERN`; `lint-plan.sh`'s advisory logic and `RAD_HIGH_RISK_PATTERNS` (only the one message string changes).
- `harness/test/deliver-gate-hook.test.js`: its `severity-routed-approval` mention is a historical feature name, so it stays.
- `.agents/{plans,logs,state,research,architecture}/**`, `.agents/findings.jsonl`: historical record.

### Key Files
- `harness/cli.js`: `approveCommand` order (args, plan, store, the evidence check, the auto-clear block, the human/proxy path), `classifyLowRisk`, and `writePlanStatus`'s non-proxy Recorded-By mirror (only the policy path reaches it).
- `harness/adapters/git-state-store.js`: `recordApproval` (keep) versus `recordPolicyApproval` (remove).
- `harness/test/policy-approval.test.js`: the two human-path cases (check-role is invoked; rejected on a non-zero exit) to move if they're not already covered.
- `scripts/check-approval-integrity.sh`: the node parse of the latest `approved` event, then the post-parse checks and the `FAIL: … Failing closed.` convention. `scripts/test-check-approval-integrity.sh`: the `approved_event` / `commit_as` / `run_check` helpers.
- `scripts/lint-agent-files.sh`: the two-way scope-map sync, which is why agent deletions and row deletions are atomic.

### Reminders
- **Atomicity:** delete the 7 agent files and their 7 scope-map rows in one commit, or `lint-agent-files.sh` (CI) fails.
- After removing code from `cli.js`, confirm there are no dead imports or helpers (`existsSync`, `sh` are still used elsewhere).
- The `lint-plan.sh` wording change and the `test-lint-plan.sh` asserts must land in the same commit.
- Deleting a `scripts/test-*.sh` needs no CI change (CI uses a glob).
- `harness/`, `scripts/` and `.claude/` are self-protected. Lint advisories are expected, and architect review is required.

## Wave Plan

### Wave 1 — parallel
Verify: npm test --prefix harness && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done

Three disjoint code areas.

#### Task 1.1: Remove the auto-approval code path
File: harness/cli.js:835-1015, harness/adapters/git-state-store.js:200-205, 405-450, 608-614, harness/test/policy-approval.test.js, harness/test/approval-authority-recording.test.js:10-15, harness/test/portable-process-memory.test.js:15-20, 240-265
What: Remove `classifyLowRisk`, the auto-clear block in `approveCommand`, and the policy-only Recorded-By mirror in `writePlanStatus` (or its comment, if it's still shared). Keep the evidence check and reword its comment. Remove `recordPolicyApproval` (function, typedef, export). Delete `policy-approval.test.js`, first moving its two human-path cases into `approval-authority-recording.test.js` unless equivalent coverage already exists there (report which). In `portable-process-memory.test.js`, replace the `recordPolicyApproval` baseline with a human `recordApproval` (stub check-role) or a hand-appended architect `approved` event, and reword the comment. Add the AC#2 regression test to `approval-authority-recording.test.js`.
Validate: AC#1, AC#2 — `npm test --prefix harness` passes; `grep -n "classifyLowRisk\|recordPolicyApproval\|severity-gate" harness/` finds nothing.

#### Task 1.2: Remove the classifier; reword script references
File: scripts/classify-low-risk.sh, scripts/test-classify-low-risk.sh, scripts/lint-shell-safety-baseline.txt:1-15, scripts/lib/plan-paths.sh:1-10, scripts/lint-plan.sh:215-225, scripts/test-lint-plan.sh:200-242, scripts/test-plan-paths.sh:15-22
What: `git rm` the classifier and its test. Drop the baseline entry. Reword `plan-paths.sh`'s header ("sourced by scripts/lint-plan.sh") and the two test comments that mention the classifier. Change `lint-plan.sh`'s self-protected warning from "never auto-clearable" to "always requires architect review", and update the three `test-lint-plan.sh` asserts in the same commit.
Validate: AC#3 — every `scripts/test-*.sh` and `lint-shell-safety.sh` pass (no stale-baseline warning); `test-lint-plan.sh` passes under `/bin/bash`.

#### Task 1.3: Integrity check rejects machine approvals
File: scripts/check-approval-integrity.sh:85-130, scripts/test-check-approval-integrity.sh:60-200
What: In the node parse of the latest `approved` event, capture `policy = actor === 'severity-gate' || recordedBy === 'policy'` and print it. After the "no approved event" check, fail closed with `FAIL: approval was recorded by a machine policy, not a human architect. Failing closed.` and exit 1. Add a case using the existing helpers: an `approved` event with `actor:'severity-gate', recordedBy:'policy'`, committed by the architect, exits 1 with that message. All existing cases stay green.
Validate: AC#4 — `bash scripts/test-check-approval-integrity.sh` and `/bin/bash scripts/test-check-approval-integrity.sh` pass.

### Wave 2 — parallel
Depends on: Wave 1 complete
Verify: bash scripts/lint-agent-files.sh && npm test --prefix harness && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done

#### Task 2.1: Agents, CLAUDE.md and config (atomic)
File: .claude/agents/severity-approval-parent-orchestrator.md, .claude/agents/gate-authority-orchestrator.md, .claude/agents/gate-authority-mapper.md, .claude/agents/severity-classifier-orchestrator.md, .claude/agents/classifier-surface-mapper.md, .claude/agents/audit-surface-orchestrator.md, .claude/agents/audit-surface-mapper.md, .claude/agents/approval-event-mapper.md:10-30, CLAUDE.md:305-365, 448-460, .env.example:58-78
What: In one commit:
- `git rm` the 7 agent files and delete their 7 CLAUDE.md scope-map rows;
- remove the "### Severity Routing — Low-Risk Allowlist" section;
- reword "### Self-Protected Paths" so it keeps the literal set and the lint-plan advisory and says these paths always require architect review, dropping the classifier and "no auto-clear path may clear itself" sentences;
- remove `.env.example`'s severity block and reword its self-protected note ("always flagged by the plan lint");
- drop `recordPolicyApproval` from `approval-event-mapper.md`.

Validate: AC#5 — `bash scripts/lint-agent-files.sh` passes; `grep` of CLAUDE.md and `.env.example` finds no `RAD_LOW_RISK_PATTERNS` or `classify-low-risk`.

#### Task 2.2: Remove the audit surfaces
File: .claude/commands/shared/rad-insights.md:885-935, .claude/skills/kickoff/SKILL.md:68-110
What: Remove `/rad-insights` "Step 6: Report auto-cleared changes" (from the section separator through its Trend block). Remove `/kickoff`'s auto-clear count paragraph, jq block, and the "Auto-cleared: {N}" template line. Check that no other line in either file refers to them.
Validate: AC#6 — neither file mentions auto-clear or `recordedBy == "policy"`; all tests pass.

### Wave 3 — sequential
Depends on: Wave 2 complete
Verify: npm test --prefix harness && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; done && bash scripts/lint-agent-files.sh

#### Task 3.1: Docs and the final sweep
File: docs/behavior-map-deliver-gate.md:185-290, docs/cosmos-vs-rad.md:40-106, docs/wsd-vs-rad.md:150-158
What: In `behavior-map-deliver-gate.md`, drop the "policy auto-clear is shape-identical" bullet and the `recordPolicyApproval` anchor, and rewrite the observation to say severity routing was removed (#137). In `cosmos-vs-rad.md`, remove severity routing from the comparison claims. In `wsd-vs-rad.md`, rewrite the monotonicity example around the lint advisory. Then run the AC#7 repo-wide grep (excluding `.agents/**` historical artifacts) and confirm the only hits are the integrity rejection and its test.
Validate: AC#7 — the grep is clean apart from the integrity check; every suite and lint passes.

## Tests to Write
- [ ] direct rad approve with RAD_LOW_RISK_PATTERNS set to match everything still requires a human and writes no approval — harness/test/approval-authority-recording.test.js
- [ ] the two human-path approve cases survive the deletion of the policy approval test file — harness/test/approval-authority-recording.test.js
- [ ] a policy approval committed by the architect fails the integrity check closed — scripts/test-check-approval-integrity.sh
- [ ] lint-plan self-protected advisory reads always requires architect review — scripts/test-lint-plan.sh

## Non-Goals
- Changing the human or proxy approval path.
- Rejecting machine approvals inside the gate fold or `transitions.js`.
- Rewriting historical plans, logs, state or research.
- Building any planning-arc feature.

## Out-of-Scope Dependencies
None. Every file is architect-writable.

## Risks
- **Breaking the human approve path while cutting the block out of `approveCommand`.** The existing approval tests and the moved human-path cases guard it, and the evidence check is kept explicitly.
- **Scope-map drift.** Deleting agents without their rows (or the reverse) fails `lint-agent-files.sh` in CI, so Task 2.1 is atomic.
- **The integrity check becomes stricter.** No existing log contains a policy approval (verified), so no merged or in-flight feature is affected.
- **A hand-appended `severity-gate` event could still pass the local `rad gate`.** The writer is removed and CI rejects it, so this is acceptable. Gate-fold enforcement is a separate design decision (Non-Goal).
- **The user-visible lint wording changes** ("never auto-clearable" becomes "always requires architect review"). The tests are updated in the same commit.

## Issue Gaps

- **The integrity-check rejection is adopted** (#137 recommended it). It's done in CI only, not in the gate fold, because the fold is RAD's determinism core and the writer no longer exists. *Verify: agree, or also enforce in `gates.js`?*
- **Two human-path tests move** from `policy-approval.test.js` into `approval-authority-recording.test.js` rather than being deleted, unless equivalent coverage exists. *Verify: agree?*
- **`lint-plan.sh`'s advisory wording changes**, which #137 didn't specify. "Never auto-clearable" no longer means anything once auto-clear is gone. *Verify: is the new wording OK?*
- **The scope-map rows are removed by hand**, despite the table's "Generated by /rad-design" comment. This is recorded as a deliberate architect edit. *Verify: agree?*
- **Everything goes in one plan (about 29 files)** rather than splitting code from docs. Most files are deletions or one-line rewords, and the agent/scope-map change must be atomic anyway. *Verify: agree?*
