# Plan: Agent Hierarchy Audit: Tag Each Agent's Purpose (#46 part 1)
Created: 2026-10-06
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-06T20:56:49.479Z
Recorded-By: sean@torchcodelab.com
Branch: rad/agent-purpose-audit
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/46
Issue-Title: Audit the agent orchestrator/mapper hierarchy: separate boundary-enforcement (keep) from context-chunking (deletable when context grows)

## Context

RAD's repo carries 29 agents in `.claude/agents/`:
- **2 shipped reviewers:** `quality-reviewer` and `accessibility-reviewer`, generated from `.rad/agents/` since #188.
- **27 internal agents:** a `*-parent-orchestrator` → `*-orchestrator` → `*-mapper` hierarchy that `/rad-design` produced for this repo's own features (11 mappers, 16 orchestrators).

#46 (June) proposed tagging each agent as a boundary (keep) or as context-chunking (deletable when context windows grow). Three later comments reframe the outcome:
- **Context rot (2026-08-04):** distracting, irrelevant context degrades models at any window size, so sub-agent isolation is durable.
- **Evidence anchoring (2026-08-05):** mappers that return `file:line` anchors rather than prose are worth keeping regardless of window size. Check each mapper for drift into returning prose.
- **Cost (2026-08-20):** keeping context small is an economic constraint, not a capacity one. Three buckets: authority, cost and capacity.

Decisions (2026-10-06, recorded on #46):
- **Taxonomy:** three buckets.
  - `authority`: role gating, architect-only delegation, scope fences. Permanent.
  - `context-discipline`: keeps context small for semantic focus, token cost, and anchors over prose. Durable.
  - `capacity`: exists only because a read wouldn't fit in the window. Depreciating, and flagged as provisional.
- **Deliverable:** the audit doc, a `purpose:` frontmatter field, and lint enforcement. The mapper anchor drift check is part of the audit.
- **Going forward:** `/rad-design` emits `purpose:` with a one-line justification, and a `capacity` tag is flagged as provisional.

**This is part 1 of 2:**
- **Part 1 (this plan):** the audit and the tags on all 27 internal agents.
- **Part 2:**
  - generator support for `purpose:` (so `.rad/agents` sources can carry it);
  - tagging the two reviewers;
  - `lint-agent-files.sh` requiring `purpose:` on scope-map agents;
  - `/rad-design` emitting it.

Part 2 waits until every agent is tagged, so the lint never fails on the current tree.

## Scope

| In scope | Out of scope |
|---|---|
| `docs/agent-hierarchy-audit.md`: taxonomy, per-agent table, mapper drift findings | Deleting, merging or rewriting any agent |
| `purpose:` frontmatter on the 27 internal agents | The two reviewers (generated; need generator support, part 2) |
| Recording mapper anchor-vs-prose drift as findings | Fixing drifted mappers (findings only; follow-up if any) |
| | Lint enforcement and `/rad-design` changes (part 2) |

## Acceptance Criteria

1. **`docs/agent-hierarchy-audit.md`** (about 150 to 250 lines). It contains:
   - **The taxonomy**, with each bucket's test question:
     - `authority`: would this boundary still be wanted with a perfect, free, infinite-context model?
     - `context-discipline`: is it here because reading everything is too expensive or too distracting?
     - `capacity`: is it here only because the read wouldn't fit?
   - **The history of the reframing**, citing the three #46 comments and their sources.
   - **A per-agent table** covering all 27 internal agents. Columns: agent, layer (parent-orchestrator / orchestrator / mapper), `purpose`, a one-line justification citing the agent file's own text (its "Reads:", delegation rules, or "returns anchors" contract), and the drift finding for mappers.
   - **A note** that the 2 reviewers are tagged in part 2.
   - **A summary:** counts per bucket, and any `capacity` agents, explicitly listed as provisional.
2. **Every internal agent has a `purpose:` line.** Each of the 27 internal `.claude/agents/*.md` files gets `purpose: authority | context-discipline | capacity` in its frontmatter, placed after `roles:`. Nothing else in the file changes. The value matches the doc's table.
3. **Mapper drift check.** Each of the 11 `*-mapper` agents is checked for whether its instructions still require file:line anchors, never raw contents or prose summaries. Each finding is `ok` or `drift: <what>` in the doc's table. Drifted mappers are recorded, not fixed. If any are found, a follow-up issue is filed with `gh issue create` and linked from the doc.
4. **Suites stay green:**
   - `scripts/lint-agent-files.sh` (extra frontmatter keys are already allowed);
   - `node harness/cli.js generate --check` (internal agents are unmarked, so they are untouched by the generator);
   - `npm test --prefix harness`;
   - every `scripts/test-*.sh` under both shells;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

No mapper agents were used. I read the #46 issue and comments, listed and sized every `.claude/agents/*.md`, and checked `lint-agent-files.sh`'s frontmatter rules (extra keys are allowed) and `generate.js` `AGENT_KEYS` (which rejects unknown keys, hence part 2). There are no out-of-scope dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| docs/agent-hierarchy-audit.md | 1-250 | New: taxonomy, per-agent table, drift findings |
| .claude/agents/approval-authority-parent-orchestrator.md | 1-55 | Add `purpose:` |
| .claude/agents/approval-command-integration-orchestrator.md | 1-52 | Add `purpose:` |
| .claude/agents/approval-command-mapper.md | 1-35 | Add `purpose:` |
| .claude/agents/approval-event-mapper.md | 1-33 | Add `purpose:` |
| .claude/agents/approval-event-model-orchestrator.md | 1-48 | Add `purpose:` |
| .claude/agents/ci-surface-mapper.md | 1-30 | Add `purpose:` |
| .claude/agents/ci-wiring-orchestrator.md | 1-42 | Add `purpose:` |
| .claude/agents/convention-lints-orchestrator.md | 1-36 | Add `purpose:` |
| .claude/agents/event-fold-mapper.md | 1-39 | Add `purpose:` |
| .claude/agents/event-fold-orchestrator.md | 1-52 | Add `purpose:` |
| .claude/agents/event-metrics-mapper.md | 1-30 | Add `purpose:` |
| .claude/agents/event-metrics-orchestrator.md | 1-35 | Add `purpose:` |
| .claude/agents/findings-loop-orchestrator.md | 1-44 | Add `purpose:` |
| .claude/agents/findings-surface-mapper.md | 1-48 | Add `purpose:` |
| .claude/agents/harness-ci-parent-orchestrator.md | 1-39 | Add `purpose:` |
| .claude/agents/hook-runtime-orchestrator.md | 1-41 | Add `purpose:` |
| .claude/agents/hook-surface-mapper.md | 1-40 | Add `purpose:` |
| .claude/agents/hooks-parent-orchestrator.md | 1-35 | Add `purpose:` |
| .claude/agents/insights-feedback-parent-orchestrator.md | 1-43 | Add `purpose:` |
| .claude/agents/integrity-checks-orchestrator.md | 1-36 | Add `purpose:` |
| .claude/agents/integrity-surface-mapper.md | 1-31 | Add `purpose:` |
| .claude/agents/lint-surface-mapper.md | 1-30 | Add `purpose:` |
| .claude/agents/portable-memory-parent-orchestrator.md | 1-56 | Add `purpose:` |
| .claude/agents/spine-integration-orchestrator.md | 1-43 | Add `purpose:` |
| .claude/agents/spine-mapper.md | 1-29 | Add `purpose:` |
| .claude/agents/sync-surface-mapper.md | 1-41 | Add `purpose:` |
| .claude/agents/sync-transport-orchestrator.md | 1-49 | Add `purpose:` |

## Execution Notes

### Do Not Touch
- `.claude/agents/quality-reviewer.md` and `accessibility-reviewer.md` (generated; part 2).
- `.rad/agents/**`, `harness/generate.js`, `scripts/lint-agent-files.sh`, `.claude/commands/architect/rad-design.md` (part 2).
- Any agent body. Add only the frontmatter line.

### Key Files
- Issue #46 and its three comments (`gh issue view 46 --comments`): the taxonomy rationale and sources.
- `.rad/config.yml` `agent_scope_map`: each agent's `type`, `reads` and `roles` context.
- `docs/rad-tool-portability.md`: how the 27 internal agents were already characterised.

### Reminders
- **Every tag is justified from the agent's own text,** not guessed from its name.
- **When in doubt between `context-discipline` and `capacity`,** apply the test: "would we keep this with an infinite but costly window?" Yes means `context-discipline`.
- No en dashes.

## Wave Plan

### Wave 1 — sequential
Tasks run in order; Task 1.2 depends on Task 1.1's classification.

#### Task 1.1: Audit the mappers
File: .claude/agents/approval-command-mapper.md:1-35, .claude/agents/approval-event-mapper.md:1-33, .claude/agents/ci-surface-mapper.md:1-30, .claude/agents/event-fold-mapper.md:1-39, .claude/agents/event-metrics-mapper.md:1-30, .claude/agents/findings-surface-mapper.md:1-48, .claude/agents/hook-surface-mapper.md:1-40, .claude/agents/integrity-surface-mapper.md:1-31, .claude/agents/lint-surface-mapper.md:1-30, .claude/agents/spine-mapper.md:1-29, .claude/agents/sync-surface-mapper.md:1-41
What: Implement AC#3 and the mapper half of AC#2. Classify each mapper, add its `purpose:` line, and record the drift finding (kept in the WAVE_RESULT for Task 2.1).
Validate: AC#2, AC#3. Run `scripts/lint-agent-files.sh`. There is no testable surface beyond the lint.

#### Task 1.2: Audit the orchestrators
File: .claude/agents/approval-authority-parent-orchestrator.md:1-55, .claude/agents/approval-command-integration-orchestrator.md:1-52, .claude/agents/approval-event-model-orchestrator.md:1-48, .claude/agents/ci-wiring-orchestrator.md:1-42, .claude/agents/convention-lints-orchestrator.md:1-36, .claude/agents/event-fold-orchestrator.md:1-52, .claude/agents/event-metrics-orchestrator.md:1-35, .claude/agents/findings-loop-orchestrator.md:1-44, .claude/agents/harness-ci-parent-orchestrator.md:1-39, .claude/agents/hook-runtime-orchestrator.md:1-41, .claude/agents/hooks-parent-orchestrator.md:1-35, .claude/agents/insights-feedback-parent-orchestrator.md:1-43, .claude/agents/integrity-checks-orchestrator.md:1-36, .claude/agents/portable-memory-parent-orchestrator.md:1-56, .claude/agents/spine-integration-orchestrator.md:1-43, .claude/agents/sync-transport-orchestrator.md:1-49
What: Implement the orchestrator half of AC#2. Classify each orchestrator and parent-orchestrator and add its `purpose:` line.
Validate: AC#2. Run `scripts/lint-agent-files.sh`. There is no testable surface beyond the lint.

### Wave 2 — sequential
This wave depends on Wave 1's classifications.

#### Task 2.1: Audit doc
File: docs/agent-hierarchy-audit.md:1-250
What: Implement AC#1, and file the AC#3 follow-up issue if any mapper drifted.
Validate: AC#1, AC#3, AC#4. The table's 27 rows must match the 27 `purpose:` lines (check with grep). Then run the full suite list in AC#4. There is no testable surface beyond that.

## Tests to Write
- [ ] None in part 1: frontmatter data and a doc (no testable surface); enforcement tests land with the part 2 lint

## Non-Goals
- Deleting, merging or rewriting any agent.
- Enforcing `purpose:` in lint (part 2).
- Changing `/rad-design` (part 2).
- Fixing drifted mappers (follow-up issue).

## Out-of-Scope Dependencies
None.

## Risks
- **Classification is judgement.** Every tag cites the agent's own text, and the doc records the test question, so a reviewer can challenge a single row.
- **The `agent_scope_map` `type` column (context-tool, orchestrator) overlaps with `purpose`.** They answer different questions: `type` is the role in delegation, `purpose` is why the boundary exists. The doc says so.

## Issue Gaps
- **Assumption:** the three #46 comments supersede the issue body's "deletable when context grows" outcome. `capacity` is the only depreciating bucket.
- **Assumption:** the two reviewers are tagged in part 2, because their frontmatter is generated and the generator rejects unknown keys.
- **Assumption:** `purpose:` sits after `roles:` in the frontmatter, matching the generator's stable key order for part 2.
