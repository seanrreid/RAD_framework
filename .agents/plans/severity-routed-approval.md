# Plan: Severity-Routed Approval (v1)
Created: 2026-06-22
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-22T18:15:04.910Z
Branch: rad/severity-routed-approval

## Context
RAD's approval gate today requires a human architect to run `/rad-approve` for every
plan. This makes the single architect a bottleneck even for changes that need no
judgment (a CSS tweak, a docs edit). This adds a deterministic, fail-closed **severity
router**: when a plan's entire declared scope is provably low-risk (matches a new
`RAD_LOW_RISK_PATTERNS` allowlist, no high-risk path, scope unchanged), `/rad-approve`
auto-records the approval as a policy-driven `approved` event — no human required —
while every other plan still escalates to the architect. Correctness stays with the
deterministic checks on every path; the gate's event-fold is untouched.

## Scope
| In scope | Out of scope |
|---|---|
| A deterministic low-risk classifier over a plan's declared scope (`RAD_LOW_RISK_PATTERNS`) | Any change to `evaluateGate` / the deliver gate-check — it stays a read-only fold |
| A policy-approval write path in `/rad-approve` (event variant, full provenance) | LLM classification, role-based clearing, structural detectors, quorum (all #37 non-goals) |
| Audit surfacing of auto-clears (`/rad-insights` + `kickoff`) | Hardening `RAD_LOW_RISK_PATTERNS` against untrusted env override (v1 trusts operator env, like `RAD_HIGH_RISK_PATTERNS`) |

## Acceptance Criteria
1. `RAD_LOW_RISK_PATTERNS` unset/empty → behavior is byte-for-byte today's (no auto-clear); set → the allowlist is active. Backward-compatible.
2. A plan whose every touched path matches `RAD_LOW_RISK_PATTERNS`, none matches `RAD_HIGH_RISK_PATTERNS`, and whose scope is unchanged auto-clears: `/rad-approve` records an `approved` event with frozen `role: architect`, `actor: severity-gate`, `recordedBy: policy`, and matched-pattern provenance — without a human architect. Fail-closed: any non-matching path → no auto-clear, architect required.
3. The auto-clear write happens only in the approve verb; the deliver-side gate-check (`evaluateGate` / `check-plan-approved.sh`) is unchanged and read-only, and a policy approval satisfies it identically to a human one.
4. High-risk denylist wins ties; the default allowlist is inert-by-type only (stylesheets, image/font assets, docs) — tests, config, lockfiles, and CI are NOT auto-cleared.
5. `/rad-insights` shows an auto-cleared section (count grouped by matched pattern) and `kickoff` shows "N auto-cleared since last session," both by counting `approved` events with `recordedBy: policy`.

## Agent Scope
Research delegated to the feature's own context-tool mappers (gate-authority-mapper,
classifier-surface-mapper, audit-surface-mapper) under their three orchestrators. All
within the architect role (audit-surface is developer-open; architect may invoke). No
out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/classify-low-risk.sh | 1-90 | NEW — the deterministic predicate (all-low AND none-high AND scope-unchanged; fail-closed; empty=OFF); emits verdict + matched patterns |
| scripts/lint-plan.sh | 181-222 | Factor the path-union + regex-match into a shared helper so the classifier reuses it (no parallel matcher) |
| scripts/lib/plan-paths.sh | 1-40 | NEW — the shared path-union + regex-match helper factored out of lint-plan.sh; one source of truth reused by the classifier |
| CLAUDE.md | 178-205 | Add a "Severity Routing — Low-Risk Allowlist" config block mirroring High-Risk Paths |
| .env.example | 37-46 | Document `RAD_LOW_RISK_PATTERNS` |
| harness/adapters/git-state-store.js | 356-392 | Add the policy-approval write path to recordApproval (authority from classifier+config, NOT per-actor check-role; provenance + frozen role) |
| harness/cli.js | 584-703 | Wire the classifier into approveCommand: low-risk verdict → policy write; else today's human flow. Deliver gate-check untouched |
| .claude/commands/shared/rad-insights.md | 165-178 | Add an "Auto-Cleared Changes" section counting recordedBy:policy events |
| .claude/skills/kickoff/SKILL.md | 46-60 | Add the "N auto-cleared since last session" line |
| .agents/research/severity-routed-approval.md | 1-78 | Design-phase artifact — carried on the cradle-to-grave branch; reviewed at design approval, not modified by implementation waves |
| .agents/architecture/severity-routed-approval.md | 1-141 | Design-phase artifact — the approved agent architecture; carried on-branch |
| .claude/agents/severity-approval-parent-orchestrator.md | 1-57 | Design-phase artifact — generated agent |
| .claude/agents/gate-authority-orchestrator.md | 1-44 | Design-phase artifact — generated agent |
| .claude/agents/gate-authority-mapper.md | 1-29 | Design-phase artifact — generated agent |
| .claude/agents/severity-classifier-orchestrator.md | 1-53 | Design-phase artifact — generated agent |
| .claude/agents/classifier-surface-mapper.md | 1-50 | Design-phase artifact — generated agent |
| .claude/agents/audit-surface-orchestrator.md | 1-62 | Design-phase artifact — generated agent |
| .claude/agents/audit-surface-mapper.md | 1-45 | Design-phase artifact — generated agent |

> **Note on budget:** the rows below the implementation files are **design-phase artifacts**
> (the approved architecture + generated agents) committed earlier on this cradle-to-grave
> branch. They are not loaded or modified by the implementation waves; they appear here only
> so the scope check accounts for everything the single deliver PR carries. This inflates the
> advisory line budget but reflects reality. (Friction noted as a follow-up: check-scope diffs
> the whole branch vs main, so it sees design-phase commits on a cradle-to-grave branch.)

## Execution Notes

### Do Not Touch
- `harness/gates.js` `evaluateGate` and `harness/gates.yaml` — the event-fold MUST stay unchanged; a policy approval passes for free because the fold reads only the frozen `role`. Any edit here is a design violation.
- The deliver-side gate-check (`harness/cli.js` deliver gate at ~362, `scripts/check-plan-approved.sh`) — stays read-only.
- The human-approval path's existing `check-role` verification — the policy path branches AROUND it; it must not be weakened for human approvals.

### Key Files
- `harness/adapters/git-state-store.js` (recordApproval, ~356) — where role is frozen at write-time; the policy variant lives here.
- `harness/cli.js` (approveCommand, 584-703) — the single call site where auto-clear is decided.
- `scripts/lint-plan.sh` (181-222) + `scripts/check-scope.sh` (26-66) — the matchers to reuse.

### Reminders
- **Authority is the architect's allowlist + the deterministic verdict, frozen into provenance — never a runtime role check on a non-human actor.** The policy write must be reachable ONLY when the fail-closed classifier passes (single call site in Task 3.1).
- Auto-clear must NOT skip the deterministic checks (`check-tests`, `check-scope`) that run on every delivered path — it only removes the human approval, not correctness verification.
- The policy event's `data` must carry the matched patterns + the scope set, so the audit layer (Wave 4) and any later review can see exactly why it was cleared.

## Wave Plan

### Wave 1 — parallel
Independent foundation: the predicate and its config surface.

#### Task 1.1: Deterministic low-risk classifier
File: scripts/classify-low-risk.sh:1-90
What: New script that, given a plan path, computes the auto-clear verdict over the plan's declared scope. Reuse lint-plan.sh's Files-in-Scope ∪ per-task `File:` path-union and regex-match (factor a shared helper) and check-scope.sh's scope logic. Verdict = low iff `RAD_LOW_RISK_PATTERNS` is non-empty AND every touched path matches it AND no path matches `RAD_HIGH_RISK_PATTERNS` AND declared scope is unchanged vs the working diff. Fail-closed (empty/unset = OFF → not-low; any ambiguity → not-low). Print the verdict and the matched patterns.
Validate: AC#1, AC#2, AC#4 — empty=OFF; all-low+none-high+scope-unchanged ⇒ low; high wins ties; tests/config excluded by default.

#### Task 1.2: Document the RAD_LOW_RISK_PATTERNS config surface
File: CLAUDE.md:178-205
What: Add a "Severity Routing — Low-Risk Allowlist" block mirroring the High-Risk Paths block — semantics (all-match AND none-high AND scope-unchanged; high wins ties; empty/unset = OFF), the default tight allowlist (stylesheets `css|scss`, image/font assets, `\.md|^docs/`), and an explicit note that tests, config, lockfiles, and CI are excluded. Add `RAD_LOW_RISK_PATTERNS` to `.env.example`.
Validate: AC#1, AC#4 — documents OFF-by-default and the tests/config exclusion.

### Wave 2 — sequential
Depends on: Wave 1 complete (the verdict shape + config exist).

#### Task 2.1: Policy-approval write path in recordApproval
File: harness/adapters/git-state-store.js:356-392
What: Add a policy/auto-clear mode to recordApproval (param or sibling) that appends an `approved` event with frozen `role: architect`, `actor: 'severity-gate'`, `recordedBy: 'policy'`, and `data: { patterns, scope }`. Authority derives from the caller having a passing deterministic verdict + configured allowlist — so this path does NOT run `check-role` on the policy actor. Event shape is otherwise identical to a human approval.
Validate: AC#2, AC#3 — the written event carries policy provenance and frozen architect role; no per-actor role check on the policy path.

### Wave 3 — sequential
Depends on: Wave 2 complete (the policy write exists).

#### Task 3.1: Wire auto-clear into the approve verb
File: harness/cli.js:584-703
What: In approveCommand, before the human-approval path, invoke scripts/classify-low-risk.sh on the plan. On a low-risk verdict, take the policy write path (Task 2.1) and record the auto-clear; otherwise fall through to today's human flow unchanged. This is the SINGLE call site that may reach the policy write. Leave the deliver-side gate-check read-only and `evaluateGate` untouched.
Validate: AC#2, AC#3 — low-risk plans auto-clear via the approve verb only; gate-check unchanged; a policy approval satisfies the gate like a human one.

### Wave 4 — parallel
Depends on: Wave 3 complete (policy-provenance events now exist to count).

#### Task 4.1: rad-insights auto-cleared section
File: .claude/commands/shared/rad-insights.md:165-178
What: After "Recommended Focus Areas," add an "Auto-Cleared Changes" section that counts `approved` events with `recordedBy: 'policy'` across `.agents/state/*/events.jsonl`, grouped by matched pattern (from `event.data`), with a simple trend. Reuse the existing read path (events.js `reduce()` already surfaces `recordedBy`).
Validate: AC#5 — insights reports auto-clear count by pattern.

#### Task 4.2: kickoff auto-clear surfacing
File: .claude/skills/kickoff/SKILL.md:46-60
What: After the active-plans report, add a line "Auto-cleared: N changes since last session" by counting `approved` events with `recordedBy: 'policy'`.
Validate: AC#5 — kickoff surfaces the auto-clear count at session start.

## Tests to Write
- [ ] Predicate unit tests (empty=OFF; all-low ⇒ low; any high-risk path ⇒ not-low, high wins ties; scope-changed ⇒ not-low; tests/config NOT auto-cleared by default; AC#1, AC#2, AC#4) — scripts/test-classify-low-risk.sh
- [ ] Policy-approval provenance test (recordApproval policy path writes correct provenance + frozen role and does NOT call check-role; `evaluateGate` passes on the resulting event; AC#2, AC#3) — harness/test/policy-approval.test.js

## Non-Goals
- No LLM severity classifier; no role-based clearing; no structural detectors (v2); no quorum/tiered authority (parked) — carried from #37.
- No hardening of `RAD_LOW_RISK_PATTERNS` against untrusted operator env override — v1 trusts the env, same model as `RAD_HIGH_RISK_PATTERNS`; architect-controlled CLAUDE.md is the intended source. Hardening is a follow-up.
- No change to how auto-cleared plans are delivered or reviewed — they still go through `/rad-deliver` and the deterministic checks.

## Out-of-Scope Dependencies
None.

## Risks
- **Authority forgery (load-bearing).** The policy path writes an architect-role approval with no human. It must be reachable ONLY when the fail-closed classifier passes — the classifier + architect-configured allowlist ARE the authority, frozen into provenance. A bug that reaches the policy write without a passing verdict would forge approvals. Mitigated: single call site (Task 3.1), fail-closed classifier, full provenance in the event for audit.
- **check-role coupling.** recordApproval verifies actor role at write-time; the policy path branches around it. The branch must not weaken the human path's check — verify both paths in the Wave 2 test.
- **Env-override trust.** `RAD_LOW_RISK_PATTERNS` via operator env could widen auto-approval; v1 accepts this (parity with `RAD_HIGH_RISK_PATTERNS`). Flagged as a hardening follow-up, not fixed here.
- **Matcher reuse vs duplication.** If the classifier copies rather than reuses lint-plan.sh's matcher, the two could drift. Task 1.1 factors a shared helper to keep one source of truth.
