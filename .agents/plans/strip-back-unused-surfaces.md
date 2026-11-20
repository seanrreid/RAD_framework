# Plan: Strip back unused surfaces (Plan A)
Created: 2026-11-20
Author: architect
Status: pending-review
Branch: rad/strip-back-unused-surfaces
Source-Author: none (no source issue)
Source-Comments: none

## Context
RAD's own usage data shows four surfaces with no demonstrated value for any agent: epic decomposition (0 epic artifacts ever produced), the 27-file orchestrator/mapper agent tree (plus the `/rad-design` command and `agent_scope_map` that only exist to produce and describe it; nothing enforces the map at runtime — `check-scope.sh` checks the plan's Files in Scope), and playbooks (2 of 166 plans mention one). This plan deletes them while keeping RAD agent-agnostic: `rad generate` keeps emitting both `.claude` and `.codex` targets, and the plan-fingerprint `Playbook:` header fold is kept so every recorded approval keeps its fingerprint. Hooks, the exercise step and `architecture-approve` are deferred to Plan B.

## Scope
| In scope | Out of scope |
|---|---|
| Delete epic decomposition (skill, generated copies, `fetch-epic.sh`, test, doc) | Lifecycle hooks, presets (Plan B) |
| Delete the 27 `.rad/agents-internal` sources and their generated `.claude`/`.codex` copies | The exercise step (`rad exercise`) |
| Delete `/rad-design` and the `agent_scope_map` feature (accept-and-ignore the config key) | `architecture-approve` command and the `_architecture` event log (Plan B) |
| Strip the authority-agent checks from `lint-agent-files.sh` and the `authority-agent-boundaries` invariant | The deliver-gate Claude hook, `claude-usage.mjs` |
| Remove repo-internal agent support from `generate.js` | The `Playbook:` fold in `plan-fingerprint.js` (kept) |
| Delete playbooks (`rad playbook`, `playbook_kinds` accept-and-ignore, lint, CI job, docs) | Historical `.agents/plans`, `.agents/state`, `.agents/architecture` records |
| Doc, skill-source and UPGRADE sweep | Any new feature |

## Acceptance Criteria
1. Epic decomposition is gone: no `rad-epic-decompose` skill source or generated copy, no `fetch-epic.sh` or its test, no `docs/epic-decomposition.md`, and no tracked non-historical file references it.
2. The orchestrator/mapper tree, `/rad-design` and the `agent_scope_map` feature are gone, and `.rad/agents` (accessibility-reviewer, quality-reviewer, ui-integrity-reviewer) still generates into both `.claude/agents` and `.codex/agents`; `node harness/cli.js generate --check` reports zero drift.
3. Playbooks are gone: no `rad playbook` command, no `playbook.js`/`playbook-command.js`, no `playbook-lint` in CI or `verify-all.sh`, no `plan_playbook`, no `.agents/playbooks`. `harness/plan-fingerprint.js` and `harness/test/fingerprint.test.js` are unchanged, and the approval-integrity check passes over every existing `.agents/state/*/events.jsonl` (no recorded fingerprint changes).
4. `rad config validate` accepts a config that contains the legacy `agent_scope_map` and `playbook_kinds` keys (present, empty, and absent) and ignores them; config validation no longer checks their contents.
5. `scripts/lint-agent-files.sh` passes on the three shipped reviewers with no scope-map, purpose, tools or roles machinery; `docs/invariants.yaml` has no `authority-agent-boundaries` invariant and `scripts/lint-invariants.sh` reports no dangling symbol.
6. `scripts/verify-all.sh` is green and its gate list, `scripts/test-verify-all.sh` and `.github/workflows/ci.yml` agree (no `playbook-lint` anywhere).
7. `scripts/test-install-harness.sh` passes and `install.sh` no longer advertises `rad-design` or `rad-epic-decompose`.
8. `rad deliver` still refuses an unapproved plan when the Claude deliver-gate hook is absent (the gate is enforced by the harness, not only by the hook).
9. `UPGRADE.md` documents the removed commands and that `agent_scope_map`/`playbook_kinds` are now accepted and ignored.

## Agent Scope
Research ran through one Explore sub-agent (read-only, 7 of 10 searches). No other agents were called. No out-of-scope agent dependencies.

## Files in Scope
<!-- Deletion rows use "delete" in Lines (not counted toward the context budget). A declared directory covers its contents under check-scope prefix matching. -->
| File | Lines | Change |
|------|-------|--------|
| .rad/skills/rad-epic-decompose | delete | Epic skill source |
| .claude/commands/architect/rad-epic-decompose.md | delete | Generated copy |
| .agents/skills/rad-epic-decompose | delete | Generated Codex copy incl. agents/openai.yaml |
| scripts/fetch-epic.sh | delete | Epic fetch helper |
| scripts/test-fetch-epic.sh | delete | Its test (test-removal waiver) |
| docs/epic-decomposition.md | delete | Epic doc |
| .rad/agents-internal | delete | All 27 orchestrator/mapper sources |
| .claude/agents | delete | Delete the 27 generated internal agents; the 3 shipped reviewers stay unchanged |
| .codex/agents | delete | Same for the Codex TOML copies |
| .rad/skills/rad-design | delete | /rad-design skill source |
| .claude/commands/architect/rad-design.md | delete | Generated copy |
| .agents/skills/rad-design | delete | Generated Codex copy incl. agents/openai.yaml |
| docs/agent-hierarchy-audit.md | delete | Audit of the removed tree |
| .rad/config.yml | 16-115 | Remove the 27 `agent_scope_map` rows and the header-comment mention |
| docs/invariants.yaml | 327-368 | Remove `authority-agent-boundaries` invariant; reword the agent-scope-map claim near line 155 |
| harness/config.js | 24-229 | Keep both keys in TOP_LEVEL_KEYS; drop scope-row and playbook-kind validation, the DEFAULT_PLAYBOOK_KINDS/resolvePlaybookKinds/playbookKindsErrors/scopeRowErrors exports, and the Agent Scope Map table parsing used by migrate |
| harness/generate.js | 9-45 | Remove repo-internal agent support (`INTERNAL_AGENTS_DIR`) |
| harness/cli.js | 258-262 | Remove the playbook import and `playbook` command entry; fix any generate/marker reference to agents-internal |
| harness/test/config.test.js | mentions | Rewrite for accept-and-ignore: present, empty, absent for both keys; drop row/kind validation cases and `resolvePlaybookKinds` tests |
| harness/test/generate.test.js | 302-351 | Drop the agents-internal cases |
| harness/test/install-manifest.test.js | 636-637 | Adjust the synthetic internal-agent fixture if needed |
| harness/test/skill-bodies.test.js | 139-175 | Remove rad-epic-decompose and rad-design from the lists; delete the PLAYBOOK_SKILLS tests |
| harness/test/deliver.test.js | append | Add a case: `rad deliver` refuses an unapproved plan with the deliver-gate hook absent |
| scripts/lint-agent-files.sh | 4-270 | Remove scope-map bijection, purpose, tools and roles checks; keep basic frontmatter validation |
| scripts/test-lint-agent-files.sh | mentions | Drop the removed-check cases and fixtures |
| scripts/rad-status.sh | mentions | Remove `/rad-design` hints from the pending-design state |
| scripts/test-rad-status.sh | 144-145 | Update case R1 |
| install.sh | 288 | Drop rad-design and rad-epic-decompose from the info line and comments |
| scripts/test-install-harness.sh | 549-550 | Remove the two skills from SLICE_SKILLS and the openai.yaml asserts |
| harness/playbook.js | delete | Playbook library |
| harness/playbook-command.js | delete | `rad playbook` command |
| harness/test/playbook.test.js | delete | Test (test-removal waiver) |
| harness/test/cli-playbook.test.js | delete | Test (test-removal waiver) |
| harness/test/seed-playbooks.test.js | delete | Test (test-removal waiver) |
| .agents/playbooks | delete | Playbook content incl. README and 2 seeds |
| docs/playbooks.md | delete | Playbook doc |
| docs/candidate-playbook-critic-rubric.md | delete | Candidate playbook doc |
| scripts/lint-plan.sh | 109-141 | Delete the Playbook ref block |
| scripts/test-lint-plan.sh | 1167-1340 | Delete the playbook tests and their registration lines |
| scripts/lib/plan-paths.sh | 691-715 | Delete `plan_playbook` |
| scripts/test-plan-paths.sh | mentions | Delete the `plan_playbook` cases |
| scripts/verify-all.sh | 64 | Remove the `playbook-lint` gate row and comment mention |
| scripts/test-verify-all.sh | 109 | Drop `playbook-lint` from the gate-name list and any count assertion |
| .github/workflows/ci.yml | 94-162 | Remove the `playbook-lint` job and the scope-map sync comment |
| .rad/skills/rad-plan/SKILL.md | mentions | Remove `--playbook`, Step 1b, `Playbook:` header lines, Playbook Deviations section, and agent_scope_map reads |
| .rad/skills/rad-adopt/SKILL.md | mentions | Same removals |
| .claude/commands/team/rad-plan.md | delete-regenerate | Regenerated from source |
| .claude/commands/team/rad-adopt.md | delete-regenerate | Regenerated from source |
| .agents/skills/rad-plan/SKILL.md | regenerate | Regenerated from source |
| .agents/skills/rad-adopt/SKILL.md | regenerate | Regenerated from source |
| .rad/skills/rad-research/SKILL.md | mentions | Drop /rad-design and epic references |
| .rad/skills/rad-status/SKILL.md | mentions | Drop /rad-design references |
| .rad/skills/kickoff/SKILL.md | mentions | Drop references to removed surfaces |
| .claude/commands/team/rad-research.md | regenerate | Regenerated from source |
| .claude/commands/shared/rad-status.md | regenerate | Regenerated from source |
| .claude/skills/kickoff/SKILL.md | regenerate | Regenerated from source |
| .agents/skills/rad-research/SKILL.md | regenerate | Regenerated from source |
| .agents/skills/rad-status/SKILL.md | regenerate | Regenerated from source |
| .agents/skills/kickoff/SKILL.md | regenerate | Regenerated from source |
| .agents/README.md | mentions | Remove playbooks and design references |
| AGENTS.md | mentions | Update the Workflow block and playbook paragraph |
| CLAUDE.md | mentions | Remove the architect rad-epic-decompose / rad-design command mentions |
| README.md | mentions | Update the workflow diagram and sections |
| INSTALL.md | mentions | Remove removed commands |
| UPGRADE.md | append | Add the removal notes (AC#9) |
| docs/architect-guide.md | mentions | Doc prose |
| docs/configuration.md | mentions | Document accept-and-ignore for the two keys; remove playbook/scope-map/epic prose |
| docs/daily-workflow.md | mentions | Doc prose |
| docs/onboarding.md | mentions | Doc prose |
| docs/how-it-works.md | mentions | Doc prose |
| docs/rad-cli.md | mentions | Remove `rad playbook`; adjust exercise/config notes |
| docs/harness-and-framework.md | mentions | Doc prose |
| docs/harness-state-store.md | mentions | Doc prose |
| docs/plan-approval-guide.md | mentions | Doc prose |
| docs/apply-to-existing.md | mentions | Doc prose |
| docs/maintaining-claude-md.md | mentions | Doc prose |
| docs/rad-tool-portability.md | mentions | Doc prose |
| docs/references.md | mentions | Doc prose |
| docs/agentic-factory-checks/sources.md | mentions | Doc prose |

## Program Design
Deletion order keeps the tree green after every wave: each wave removes a surface's content together with the code, tests and docs that reference it, then regenerates.

File-tree diff:
```
- .rad/skills/{rad-epic-decompose,rad-design}/            (+ generated copies)
- .rad/agents-internal/ (27)                              (+ 54 generated copies; 3 reviewers stay)
- scripts/{fetch-epic.sh,test-fetch-epic.sh}
- harness/{playbook.js,playbook-command.js}  + 3 playbook tests
- .agents/playbooks/  docs/{epic-decomposition,agent-hierarchy-audit,playbooks,candidate-playbook-critic-rubric}.md
~ harness/{config,generate,cli}.js  scripts/{lint-agent-files,lint-plan,verify-all,rad-status}.sh  scripts/lib/plan-paths.sh
~ .rad/config.yml  docs/invariants.yaml  .github/workflows/ci.yml  install.sh  prose docs and skill sources
= harness/plan-fingerprint.js (Playbook fold kept)  .rad/agents/ (3 reviewers)
```

Config contract after this plan: `agent_scope_map` and `playbook_kinds` stay in `TOP_LEVEL_KEYS` (so existing configs validate) but their values are never inspected.

## Execution Notes

### Do Not Touch
- harness/plan-fingerprint.js and harness/test/fingerprint.test.js — the `Playbook:` header fold keeps recorded approvals valid
- .rad/agents/ (the 3 shipped reviewers) and their .claude/agents and .codex/agents outputs
- harness/hook-runner.js, harness/spine.js, harness/events.js, scripts/hooks, presets/ — hooks are Plan B
- harness/exercise.js and `rad exercise` — Plan B / separate decision
- `architecture-approve` in harness/cli.js and `_architecture` log handling — deferred to Plan B
- scripts/deliver-gate-hook.mjs, scripts/claude-usage.mjs
- .agents/plans, .agents/state, .agents/logs, .agents/research, .agents/architecture — historical records, left as-is

### Key Files
- harness/generate.js — how sources map to `.claude`/`.codex` outputs; marker `source:` lines drive drift
- harness/config.js — TOP_LEVEL_KEYS and the validation to relax
- scripts/verify-all.sh, scripts/test-verify-all.sh — enumerated gate list must change together
- scripts/check-approval-integrity.sh and the `deliver-integrity` job in .github/workflows/ci.yml — fingerprint guard
- scripts/check-scope.sh — declared directories match by prefix; deleted tests need Waivers

### Reminders
- Edit `.rad/` sources, never generated outputs. Delete a `.rad` source and its generated copies together, then run `node harness/cli.js generate` and `generate --check`.
- Any new or modified script must stay mode 100755 (shell-safety lint).
- Run the final verify with `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- Research stopped at 7 of 10 searches: grep the whole tree (excluding `.agents/plans|state|logs|research|architecture`) for `rad-design`, `rad-epic-decompose`, `playbook`, `agent_scope_map`, `agents-internal` after each wave and resolve leftovers in that wave's files; any hit in a file not declared in Files in Scope needs a `[NEEDS CLARIFICATION]` stop, not a silent edit.
- Generated outputs (`.claude/`, `.codex/`, `.agents/skills/`) are removed by running `node harness/cli.js generate` (verify it prunes copies whose source is gone; if it only reports drift, remove them with `git rm` through Bash). Never delete or edit them with the edit tools: the headless claude preset cannot write `.claude/`.
- Close issue #349 (topology eval) as superseded in the deliver PR description.

## Wave Plan

### Wave 1 — sequential
Epic decomposition, the lowest-coupling surface, first.

#### Task 1.1: Delete the epic surface
File: .rad/skills/rad-epic-decompose, .claude/commands/architect/rad-epic-decompose.md, .agents/skills/rad-epic-decompose, scripts/fetch-epic.sh, scripts/test-fetch-epic.sh, docs/epic-decomposition.md
What: Delete the skill source, its generated Claude and Codex copies, the fetch script, its test and the doc. Run `node harness/cli.js generate` then `generate --check`.
Validate: AC#1 — none of the listed paths exists; `generate --check` exits 0.

#### Task 1.2: Remove epic references from install and tests
File: install.sh:243-290, scripts/test-install-harness.sh:536-550, harness/test/skill-bodies.test.js:16-175
What: Drop `rad-epic-decompose` from the install info line and the SLICE_SKILLS list, its openai.yaml assertion and the skill-bodies lists.
Validate: AC#7 — `bash scripts/test-install-harness.sh` and `node --test harness/test/skill-bodies.test.js` pass; `grep -r rad-epic-decompose install.sh scripts harness` finds nothing.

### Wave 2 — sequential
Depends on: Wave 1 complete. Orchestrator tree, `/rad-design`, scope map, internal-agent support.

#### Task 2.1: Delete sources and generated copies
File: .rad/agents-internal, .claude/agents, .codex/agents, .rad/skills/rad-design, .claude/commands/architect/rad-design.md, .agents/skills/rad-design, docs/agent-hierarchy-audit.md
What: Delete the 27 internal sources, their 54 generated copies (keep the 3 shipped reviewers in both dirs), the `/rad-design` source and copies, and the audit doc. Run `generate`, then `generate --check`.
Validate: AC#2 — `.claude/agents` and `.codex/agents` each contain exactly the 3 reviewers; `generate --check` exits 0 and both targets exist.

#### Task 2.2: Config, generate and invariants
File: harness/config.js:4-229, harness/generate.js:9-45, .rad/config.yml:1-115, docs/invariants.yaml:327-368, harness/test/config.test.js:13-214, harness/test/generate.test.js:302-351, harness/test/install-manifest.test.js:636-637
What: Make `agent_scope_map` an accepted-and-ignored key (keep it in TOP_LEVEL_KEYS, remove row validation, the Agent Scope Map parser and the scopeRowErrors export); remove `INTERNAL_AGENTS_DIR` support from generate.js; drop the 27 rows from `.rad/config.yml`; remove the `authority-agent-boundaries` invariant and reword the line-155 claim; rewrite config tests for present/empty/absent and drop the agents-internal generate tests.
Validate: AC#4, AC#5 — `node --test harness/test/config.test.js harness/test/generate.test.js harness/test/install-manifest.test.js` pass; `rad config validate` passes on `agent_scope_map: [ ... ]`, `[]` and absent; `bash scripts/lint-invariants.sh` clean.

#### Task 2.3: Lint, status and install surface
File: scripts/lint-agent-files.sh:4-270, scripts/test-lint-agent-files.sh:42-202, scripts/rad-status.sh:461-525, scripts/test-rad-status.sh:144-145, install.sh:243-290, scripts/test-install-harness.sh:536-550, harness/test/skill-bodies.test.js:16-175, .github/workflows/ci.yml:94-162
What: Strip the scope-map, purpose, tools and roles checks from lint-agent-files.sh, keeping basic frontmatter validation for the 3 reviewers; drop the matching test cases; remove `/rad-design` hints from rad-status and update R1; remove `rad-design` from install.sh and the install test; remove it from the skill-bodies lists; fix the CI scope-map comment.
Validate: AC#5, AC#7 — `bash scripts/lint-agent-files.sh` passes on the 3 reviewers; `bash scripts/test-lint-agent-files.sh`, `bash scripts/test-rad-status.sh`, `bash scripts/test-install-harness.sh` pass.

### Wave 3 — sequential
Depends on: Wave 2 complete. Playbooks.

#### Task 3.1: Delete playbook content and tests
File: harness/playbook.js, harness/playbook-command.js, harness/test/playbook.test.js, harness/test/cli-playbook.test.js, harness/test/seed-playbooks.test.js, .agents/playbooks, docs/playbooks.md, docs/candidate-playbook-critic-rubric.md
What: Delete the library, command, three tests, the playbook directory and both docs.
Validate: AC#3 — none of the listed paths exists.

#### Task 3.2: Remove playbook code paths
File: harness/cli.js:80-262, harness/config.js:24-229, harness/test/config.test.js:13-214, harness/test/skill-bodies.test.js:16-175, scripts/lint-plan.sh:109-141, scripts/test-lint-plan.sh:1167-1340, scripts/lib/plan-paths.sh:691-715, scripts/test-plan-paths.sh:1-905
What: Remove the `rad playbook` import and command entry; make `playbook_kinds` accepted-and-ignored (remove DEFAULT_PLAYBOOK_KINDS, resolvePlaybookKinds, playbookKindsErrors); delete the lint-plan Playbook block, `plan_playbook` and their tests; delete the PLAYBOOK_SKILLS tests. Do not edit plan-fingerprint.js.
Validate: AC#3, AC#4 — `node harness/cli.js playbook` reports an unknown command; `rad config validate` passes with `playbook_kinds` present, empty and absent; `bash scripts/test-lint-plan.sh` and `bash scripts/test-plan-paths.sh` pass; `git diff --stat main -- harness/plan-fingerprint.js harness/test/fingerprint.test.js` is empty.

#### Task 3.3: CI, verify-all and skill sources
File: scripts/verify-all.sh:22-64, scripts/test-verify-all.sh:109, .github/workflows/ci.yml:94-162, .rad/skills/rad-plan/SKILL.md, .rad/skills/rad-adopt/SKILL.md, .claude/commands/team/rad-plan.md, .claude/commands/team/rad-adopt.md, .agents/skills/rad-plan, .agents/skills/rad-adopt
What: Remove the `playbook-lint` row, CI job and test enumeration entry (adjust any gate-count assertion); remove `--playbook`, Step 1b, the `Playbook:` header lines and the Playbook Deviations section from the rad-plan and rad-adopt sources, then regenerate.
Validate: AC#3, AC#6 — `bash scripts/test-verify-all.sh` passes; `grep -r playbook-lint scripts .github` finds nothing; `generate --check` exits 0.

### Wave 4 — parallel
Depends on: Wave 3 complete. Prose and notes; independent files.

#### Task 4.1: Root docs and skill-source prose
File: AGENTS.md, CLAUDE.md, README.md, INSTALL.md, .agents/README.md, .rad/skills/rad-research/SKILL.md, .rad/skills/rad-status/SKILL.md, .rad/skills/kickoff/SKILL.md
What: Remove references to `rad-epic-decompose`, `rad-design`, playbooks and the agent scope map; update the AGENTS.md Workflow block; regenerate the skill copies.
Validate: AC#1, AC#2 — `grep -rIl -E 'rad-design|rad-epic-decompose|agents-internal' AGENTS.md CLAUDE.md README.md INSTALL.md .agents/README.md .rad .claude .agents/skills` finds nothing; `generate --check` exits 0.

#### Task 4.2: docs/ sweep
File: docs/architect-guide.md, docs/configuration.md, docs/daily-workflow.md, docs/onboarding.md, docs/how-it-works.md, docs/rad-cli.md, docs/harness-and-framework.md, docs/harness-state-store.md, docs/plan-approval-guide.md, docs/apply-to-existing.md, docs/maintaining-claude-md.md, docs/rad-tool-portability.md, docs/references.md, docs/agentic-factory-checks/sources.md
What: Remove prose for the removed surfaces; in docs/configuration.md document the two keys as accepted and ignored; in docs/rad-cli.md remove `rad playbook`.
Validate: AC#9 — `grep -rIl -E 'rad-design|rad-epic-decompose|rad playbook|agents-internal' docs` finds only the historical decision log if any, and docs/configuration.md documents accept-and-ignore.

#### Task 4.3: UPGRADE notes
File: UPGRADE.md
What: Add an entry: removed commands (`/rad-design`, `/rad-epic-decompose`, `rad playbook`), removed `.rad/agents-internal` support, and that `agent_scope_map` and `playbook_kinds` are still accepted but ignored; tell downstream users how to delete their old generated agent files.
Validate: AC#9 — UPGRADE.md names each removed command and both ignored keys.

### Wave 5 — sequential
Depends on: Wave 4 complete. Guardrails and full verification.

#### Task 5.1: Gate and fingerprint guardrails
File: harness/test/deliver.test.js:1-60
What: Add a test that `rad deliver` refuses an unapproved plan when the deliver-gate hook is absent (no hook settings present). Then run the approval-integrity check exactly as the `deliver-integrity` CI job does, over every `.agents/state/*/events.jsonl`.
Validate: AC#8, AC#3 — the new test passes; the integrity check exits 0 on all logs (no fingerprint mismatch).

#### Task 5.2: Full verification
File: scripts/verify-all.sh:22-64
What: Run the full gate set with the extended timeout and fix any leftover reference found by the post-wave greps.
Validate: AC#6 — `RAD_VERIFY_TIMEOUT_SECONDS=1800 bash scripts/verify-all.sh` exits 0.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] `rad deliver` refuses an unapproved plan without the deliver-gate hook — harness/test/deliver.test.js
- [ ] Config accepts `agent_scope_map` and `playbook_kinds` present, empty and absent and ignores them — harness/test/config.test.js

## Non-Goals
- Removing lifecycle hooks, presets, the exercise step, or `architecture-approve` / `_architecture` log handling (Plan B).
- Changing `plan-fingerprint.js` or any recorded approval, event log or fingerprint.
- Editing historical plans, state, logs, research or `.agents/architecture` records.
- Adding any new feature or replacing the removed surfaces.

## Out-of-Scope Dependencies
None

## Risks
- Config strictness: downstream configs that still carry `agent_scope_map` or `playbook_kinds` must keep validating; mitigated by accept-and-ignore and a three-state test.
- Fingerprint drift: any edit to `plan-fingerprint.js` would invalidate approvals; it is declared Do Not Touch and checked against all logs.
- Generated-drift: deleting a `.rad` source without its generated copies fails `generate --check`; every delete task pairs with a regenerate.
- Enumerated-list tests (`test-verify-all.sh`, install slice lists, skill-bodies) fail if only one side of a pair changes; each is edited in the same task as its subject.
- Research stopped at 7 of 10 searches, so some prose references may be unlisted; the post-wave greps and the Verify gate catch leftovers.
- Edits `.rad/`, `harness/` and `scripts/`, so the plan is flagged for architect review.

## Waivers
- test-removal:scripts/test-fetch-epic.sh: its subject, `scripts/fetch-epic.sh`, is deleted by this plan (epic decomposition removed)
- test-removal:harness/test/playbook.test.js: its subject, `harness/playbook.js`, is deleted by this plan (playbooks removed)
- test-removal:harness/test/cli-playbook.test.js: its subject, the `rad playbook` command, is deleted by this plan
- test-removal:harness/test/seed-playbooks.test.js: its subject, the seed playbooks in `.agents/playbooks`, is deleted by this plan
