# Plan: Keep .agents History Out of Default Context, and Record RAD's Own Rationale (#249)
Created: 2026-10-12
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-12T14:58:28.428Z
Recorded-By: sean@torchcodelab.com
Branch: rad/agents-md-history-rule-and-rad-decisions
Issue: 249
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/249
Issue-Title: AGENTS.md: keep .agents history out of default context; fill empty rationale sections

## Context
#249 (from the 2026-10-09 factory-checks audit, check K2/K1) asks for two things: a rule keeping completed plans, research and logs out of default agent context, and filled-in rationale sections in `AGENTS.md`.

Research found that `AGENTS.md` is the template `install.sh` scaffolds into every consumer project (`INSTALL.md:62`, `INSTALL.md:441`); its Architecture Decisions, Testing Standards and Known Constraints sections are the blanks consumers fill. Filling them with RAD's own rationale would ship RAD's decisions to other people's projects. The architect therefore chose (2026-10-12) to split the work:
- the **history rule** goes into the `AGENTS.md` template, because it is true for any RAD project (`.agents/plans`, `research` and `logs` exist everywhere);
- **RAD's own rationale** goes into a new repo-internal doc, `docs/rad-decisions.md`, that points at the existing sources of truth instead of restating them. The template sections stay blank for consumers.

`AGENTS.md` is 139 of its 150-line advisory budget, so the added rule must stay small.

## Scope
| In scope | Out of scope |
|---|---|
| One rule in `AGENTS.md` "What the Agent Must Never Do" about `.agents` history | Filling the template's rationale sections in `AGENTS.md` |
| New `docs/rad-decisions.md`: decisions, testing standards, known constraints, each with a pointer | Moving or archiving `.agents/plans`, `research` or `logs` |
| A link to it from `docs/architect-guide.md` | A mechanism that enforces the rule (it is prose; see Risks) |
| | Restating `docs/invariants.yaml` or `framing-decisions.md` content |

## Acceptance Criteria
1. **History rule.** `AGENTS.md` has one bullet under "What the Agent Must Never Do" saying not to read `.agents/plans/`, `.agents/research/` or `.agents/logs/` unless the task names them, because completed specs describe past intent and can be mistaken for current requirements. The empty trailing `-` placeholder bullet is left as it is.
2. **Budget holds.** `AGENTS.md` stays at or under 150 lines and `bash scripts/lint-claude-md.sh` passes.
3. **Decisions doc exists.** `docs/rad-decisions.md` has three sections, Architecture decisions, Testing standards and Known constraints. Every bullet is one or two lines and ends with a pointer to the file or issue that is the source of truth.
4. **Every claim is verified.** Each statement in the doc was checked against the file or issue it points to while writing; none is carried over from memory. A claim that cannot be confirmed is omitted.
5. **Template untouched.** The Architecture Decisions, Testing Standards and Known Constraints sections of `AGENTS.md` are byte-identical to before.
6. **Reachable.** `docs/architect-guide.md` links to `docs/rad-decisions.md`; no existing link in either file breaks.

## Agent Scope
No sub-agents were called. Research was inline (5 tool calls): AGENTS.md size and sections, install scaffolding, invariants and framing docs, testing commands in `verify-all.sh`, tests that read `AGENTS.md`.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| AGENTS.md | 79-85 | Add one bullet to "What the Agent Must Never Do" |
| docs/rad-decisions.md | 1-80 | New. Decisions, testing standards and known constraints, each with a pointer |
| docs/architect-guide.md | 142-160 | Add a short "Rationale and decisions" link at the end |

## Execution Notes

### Do Not Touch
- The blank Architecture Decisions, Testing Standards and Known Constraints sections of AGENTS.md
- CLAUDE.md (also scaffolded to consumers)
- scripts/, harness/, .rad/

### Key Files
- docs/invariants.md and docs/invariants.yaml — the registry; point at it, do not restate it
- docs/framing-decisions.md and docs/harness-audit.md — existing decision records
- scripts/verify-all.sh — the authoritative list of test commands (lines ~60-61)
- scripts/lint-claude-md.sh — the line-budget lint

### Reminders
- Content candidates for the doc, each to be confirmed against its source before it is written: the deterministic harness owns control flow and the model is called at judgment points (`harness-audit.md`); approval is the `approved` event in `events.jsonl` and the plan `Status:` header is display-only (`invariants.yaml`); there is no auto-approval (#137); two human gates, plan approval then the deliver PR; the wave contract is provider-neutral (#86); test commands from `verify-all.sh`, the last-wave `Verify:` rule for self-protected plans, new scripts must be `100755` for the shell-safety lint; self-protected paths are `.rad/`, `harness/`, `scripts/`; the command adapter cannot narrow tools (`capabilities.js`); deliver PRs intermittently fail to auto-close issues, so check after merge.
- Pointers to issues use the form `#N`; pointers to files use repo-relative paths.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.
Verify: bash scripts/lint-claude-md.sh && bash scripts/test-lint-claude-md.sh

#### Task 1.1: Add the history rule
File: AGENTS.md:79-85
What: Add one bullet under "What the Agent Must Never Do", before the trailing empty `-`, stating the rule from AC#1 in one line.
Validate: AC#1, AC#2, AC#5 — the diff touches only that section; `scripts/lint-claude-md.sh` reports AGENTS.md within budget; the three template sections are unchanged (`git diff` shows no hunk in them).

#### Task 1.2: Write docs/rad-decisions.md
File: docs/rad-decisions.md
What: Create the doc with a short intro saying it records RAD's own rationale, that the `AGENTS.md` sections of the same names are the consumer's to fill, and that each bullet points at its source of truth. Write the three sections from the candidates in Execution Notes, confirming each against the cited file or issue first (`gh issue view` for issue claims). Omit any claim that cannot be confirmed.
Validate: AC#3, AC#4 — each bullet has a pointer; every pointed-at path exists and every `#N` resolves (checked with `test -e` and `gh issue view`).

#### Task 1.3: Link it from the architect guide
File: docs/architect-guide.md:142-160
What: Add a final `## Rationale and decisions` section with one line linking to `docs/rad-decisions.md`.
Validate: AC#6 — the link target exists; the other relative links in the file still resolve.

## Tests to Write
- None. This plan changes docs and one prose rule; there is no testable behavior. The Wave 1 Verify runs the existing CLAUDE.md/AGENTS.md budget lint and its fixture test, which cover the only mechanical constraint (the 150-line budget).

## Non-Goals
- Filling the consumer-facing template sections of AGENTS.md
- Enforcing the history rule with a hook or lint
- Archiving or moving delivered plans, research or logs
- Rewriting content that already lives in `invariants.md`, `framing-decisions.md` or `harness-audit.md`

## Out-of-Scope Dependencies
None.

## Risks
- The history rule is prose, which the factory-checks catalogue rates weaker than an enforced control. It is a first step; no stale-plan incident has been observed, so there is no evidence yet that a mechanism is needed.
- `docs/rad-decisions.md` can drift from its sources. Mitigated by keeping bullets to one line plus a pointer instead of restating content, and by AC#4.
- The rule lives in a template that consumers inherit. That is intended (the rule is generic), but a consumer who uses `.agents/plans` differently may want to edit it.

## Issue Gaps
- ASSUMPTION: #249 asked to fill the AGENTS.md sections; this plan instead keeps them blank and puts RAD's rationale in `docs/rad-decisions.md`, because AGENTS.md is the consumer template. Decided by the architect on 2026-10-12. Issue #249 should be updated to match when this plan is delivered.
- ASSUMPTION: the rule goes under "What the Agent Must Never Do" rather than "Known Constraints", because the latter is a blank consumer section.
- ASSUMPTION: the doc lives in `docs/` and is linked from `docs/architect-guide.md`, the file architects already read; no other index of docs was found.
- ASSUMPTION: the wave's Verify is the budget lint plus its fixture test, since the plan touches no self-protected path and has no behavior to test. If the architect wants the full suite anyway, swap in `exec bash scripts/verify-all.sh`.
