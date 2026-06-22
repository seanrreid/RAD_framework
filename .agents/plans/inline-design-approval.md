# Plan: Inline Approval for /rad-design
Created: 2026-06-22
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-22T15:34:15.402Z
Branch: rad/inline-design-approval

## Context
`/rad-design` today dead-ends after Draft mode: it writes the architecture artifact,
then tells the architect to manually edit `Status: draft → approved` and **re-run the
command** to generate the agent files. That re-run ceremony is machine-work bolted onto
a judgment call — a bottleneck that contradicts the framework's own goal of keeping the
human gate cheap. The fix collapses the two steps into a single invocation with an inline
approve/edit/cancel gate. The command-file change already exists in the working tree
(adopted by this plan); two stale doc references to the old flow still need fixing.

## Scope
| In scope | Out of scope |
|---|---|
| Adopt the inline approve/edit/cancel rewrite of `.claude/commands/architect/rad-design.md` | The `/rad-design` Generate logic itself (agent-file emission, scope-map block) — unchanged |
| Fix stale "edit Status + re-run" references in `docs/daily-workflow.md` and `docs/architect-guide.md` | Severity-routing `/rad-design`; making architecture-approval a recorded event (both separate follow-ups) |

## Acceptance Criteria
1. `/rad-design` completes design → approval → generation in a **single invocation**: the architect approves via an inline approve/edit/cancel prompt with no manual `Status` edit and no command re-run.
2. Backward-compatible standalone Generate: a pre-existing `Status: approved` architecture artifact still generates directly when `/rad-design [slug]` is re-invoked.
3. No doc under `docs/` instructs the architect to "edit Status to approved and re-run `/rad-design`"; `docs/daily-workflow.md` and `docs/architect-guide.md` describe the inline gate instead.

## Agent Scope
Research delegated to one Explore sub-agent (read-only). No implementation agents called —
this is an architect-owned command/doc change. No out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| .claude/commands/architect/rad-design.md | 1-280 | ADOPT (already implemented): unified "Design & Approve" → inline Step-4 gate → "Generate"; frontmatter + Rules updated; steps renumbered 1–8 |
| docs/daily-workflow.md | 60-70 | Replace the "change status to approved and re-run /rad-design" description with the inline approve/edit/cancel gate |
| docs/architect-guide.md | 60-120 | Update the two stale passages (manual edit + re-run, ~63-69 and ~112-116) to reflect inline approval in a single run |

## Execution Notes

### Do Not Touch
- `.agents/architecture/severity-routed-approval.md`, `.agents/research/severity-routed-approval.md` — untracked artifacts belonging to feature #37; never `git add -A`, stage only the paths in Files in Scope
- The `/rad-design` Generate steps (file-emission sub-agent prompt, scope-map block) — behavior is unchanged; only the entry/approval path changed

### Key Files
- `.claude/commands/architect/rad-design.md` — the adopted change; the source of truth for how the new flow reads
- `.claude/commands/architect/rad-approve.md` — house style reference for architect command frontmatter/sections

### Reminders
- Doc edits must match the command's actual new vocabulary: "Design & Approve", "Generate", "inline approve/edit/cancel", "no separate re-run"
- Keep the backward-compat note (manual `Status: approved` still works via standalone Generate) so the docs don't overstate the change

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel — three independent files, no shared edits.

#### Task 1.1: Adopt + verify the rad-design.md inline flow
File: .claude/commands/architect/rad-design.md:1-280
What: Confirm the working-tree change is internally consistent — frontmatter states single-invocation inline approval; "## Design & Approve" Steps 1–4 with the Step-4 approve/edit/cancel gate flowing into "## Generate" Steps 5–8; Rules contain no "edit Status and re-run" dead-end; no stale "Draft Mode"/"Generate Mode" headings. Fix any inconsistency found.
Validate: AC#1, AC#2 — the command describes one continuous run with an inline gate, and standalone Generate over an approved artifact still works.

#### Task 1.2: Fix stale flow in daily-workflow.md
File: docs/daily-workflow.md:60-70
What: Replace the passage instructing the architect to "edit role assignments/scope … change the status to approved and re-run /rad-design" with a description of the inline approve/edit/cancel gate in a single invocation.
Validate: AC#3 — daily-workflow.md no longer references editing Status + re-running; describes the inline gate.

#### Task 1.3: Fix stale flow in architect-guide.md
File: docs/architect-guide.md:60-120
What: Update the two stale passages (~63-69 "change Status: draft to approved and re-run"; ~112-116 re-run reference) to describe inline approval during the single `/rad-design` run, keeping the backward-compat note that a manual `Status: approved` edit still generates via standalone Generate.
Validate: AC#3 — architect-guide.md no longer instructs manual edit + re-run; describes the inline gate.

## Tests to Write
- [ ] Manual: run `/rad-design` on a fresh slug end-to-end; confirm a single invocation drafts → inline-approves → generates with no re-run (AC#1).
- [ ] Manual: re-invoke `/rad-design [slug]` against an artifact already at `Status: approved`; confirm it generates directly (AC#2).

## Non-Goals
- Severity-routing `/rad-design` itself (auto-generate when the agent map has no sensitive scope) — tracked as a separate follow-up.
- Promoting architecture-design approval from a `Status:` field edit to a recorded `events.jsonl` entry (like `/rad-approve`) — separate follow-up.
- Adding an automated linter/test for `.claude/commands/` markdown structure — no such harness exists today; out of scope here.

## Out-of-Scope Dependencies
None.

## Risks
- Muscle-memory: users habituated to "edit Status + re-run" may be briefly surprised. Mitigated — the manual `Status: approved` path still works (backward-compatible standalone Generate), so no existing habit breaks; it is merely no longer required.
- Doc/command drift: if the doc edits use different wording than the command, the docs could mislead. Mitigated by the Reminders above pinning the shared vocabulary.
