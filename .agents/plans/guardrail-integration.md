# Plan: Guardrail Integration
Created: 2026-06-03
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-03T00:00:00Z
Branch: rad/guardrail-integration

## Context
RAD orchestrates wave-based delivery via sub-agents but provides no coding discipline rules — agents can write speculative abstractions, swallow errors, or ignore local conventions without any automated check. A parallel repo (`agent_guides`) contains a battle-tested, platform-neutral guardrail pack (`ai/guardrails.md`, `ai/slop-register.md`, five domain extensions) that prevents these failure modes. This plan integrates that pack into RAD at three points: prevention (baked into wave prompts), detection (pre-PR gate in rad-review), and prediction (plan-analysis step in rad-approve).

## Scope
| In scope | Out of scope |
|---|---|
| Bundle `ai/` guardrail pack as a first-class RAD deliverable | Modifying harness/ runtime (StateStore, gate evaluation) |
| Wire domain extension loading into rad-deliver wave prompts | Adding new CLI commands or skills |
| Extend rad-review with guardrail checklist gate | Pre-populating slop-register.md with project-specific rules |
| Add slop-risk plan-analysis step to rad-approve | Changing scripts/ core gating scripts |
| Update install.sh and INSTALL.md to scaffold ai/ into projects | Changing the plan template or wave structure format |

## Acceptance Criteria
1. RAD ships an `ai/` directory containing `guardrails.md`, `slop-register.md` (empty template), and `extensions/` with five domain files; `install.sh` copies this directory into target projects on install and upgrade.
2. `rad-deliver` wave sub-agent prompts include a guardrail extension loading step that selects and names the domain extensions relevant to each wave's changed paths before the agent writes any code.
3. `rad-review` includes a guardrail review section that loads relevant domain extensions and runs the baseline review checklist; hard rule violations block the PR step with an explicit FAIL report.
4. `rad-approve` includes a plan-analysis step that scans the wave structure for slop-risk signals and produces a PASS/FLAG report the architect sees before deciding to approve.
5. `INSTALL.md` documents the `ai/` guardrail pack as a first-class deliverable with setup and customization guidance.

## Agent Scope
- Explore sub-agent (research only, read-only)
- All wave execution within architect scope

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| `ai/guardrails.md` (new) | 1-92 | Copy from agent_guides source |
| `ai/slop-register.md` (new) | 1-52 | Copy template from agent_guides source |
| `ai/extensions/backend.md` (new) | 1-20 | Copy from agent_guides source |
| `ai/extensions/database.md` (new) | 1-20 | Copy from agent_guides source |
| `ai/extensions/frontend.md` (new) | 1-20 | Copy from agent_guides source |
| `ai/extensions/security.md` (new) | 1-20 | Copy from agent_guides source |
| `ai/extensions/testing.md` (new) | 1-20 | Copy from agent_guides source |
| `.claude/commands/team/rad-deliver.md` | 138-196 | Add guardrail extension loading step to wave sub-agent prompt template |
| `.claude/commands/team/rad-review.md` | 1-183 | Add guardrail review section with domain extension loading and hard-gate logic |
| `.claude/commands/architect/rad-approve.md` | 50-157 | Add plan-analysis step with PASS/FLAG slop-risk report |
| `install.sh` | 200-270 | Add `ai/` copy to project scaffold section |
| `INSTALL.md` | 1-200 | Document ai/ guardrail pack, customization steps, extension loading protocol |

## Execution Notes

### Do Not Touch
- `CLAUDE.md` — template for user projects; not this framework's own config
- `scripts/` — core deterministic gating scripts; any change here affects all deliveries
- `harness/` — Node.js StateStore and gate runtime; guardrails are markdown data, not runtime code
- `.agents/plans/`, `.agents/logs/` — user work artifacts

### Key Files
- `/Users/seanreid/Repos/TorchCodeLab/agent_guides/ai/guardrails.md` — source of truth for the guardrail pack; copy verbatim, do not rewrite
- `/Users/seanreid/Repos/TorchCodeLab/agent_guides/ai/slop-register.md` — source template; copy verbatim
- `/Users/seanreid/Repos/TorchCodeLab/agent_guides/ai/extensions/` — all five domain extension files; copy verbatim
- `.claude/commands/team/rad-deliver.md` — wave sub-agent prompt template lives at lines 138-196; inject guardrail loading before the implementation step
- `.claude/commands/team/rad-review.md` — pre-PR gate; extend the review steps, add hard-gate on violation count
- `.claude/commands/architect/rad-approve.md` — architect approval flow; slop-risk analysis runs before the architect sees the confirmation prompt

### Reminders
- The `ai/` files are copied verbatim from agent_guides — do not rephrase or summarize; the exact wording is the contract agents load
- Extension loading follows the smallest-relevant-set principle: load only files whose `Applies When` section matches changed paths or the task domain
- `install.sh` has an upgrade mode that skips overwriting user data; treat `ai/` as framework code (always overwrite on upgrade) not user data (never overwrite)
- The slop-risk scan in rad-approve is read-only analysis — it produces a report, it does not modify the plan or block approval automatically

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (later tasks reference the ai/ files created in 1.1).

#### Task 1.1: Create the ai/ guardrail pack in RAD
File: `ai/guardrails.md`, `ai/slop-register.md`, `ai/extensions/*.md` (7 new files)
What: Copy `ai/guardrails.md`, `ai/slop-register.md`, and all five extension files from `/Users/seanreid/Repos/TorchCodeLab/agent_guides/` into the RAD repo at the same relative paths. Files are copied verbatim.
Validate: AC#1 — confirm all 7 files exist at `ai/guardrails.md`, `ai/slop-register.md`, `ai/extensions/backend.md`, `ai/extensions/database.md`, `ai/extensions/frontend.md`, `ai/extensions/security.md`, `ai/extensions/testing.md`

#### Task 1.2: Wire guardrail extension loading into rad-deliver wave prompts
File: `.claude/commands/team/rad-deliver.md:138-196`
What: In the wave sub-agent prompt template, add a "Guardrail Extensions" section before the implementation step. The section instructs the agent to: (1) list the file paths it expects to touch in this wave, (2) match each path against the `Applies When` clause of each extension in `ai/extensions/`, (3) load only matching extensions, (4) name them explicitly before writing any code. Reference `ai/guardrails.md` as the baseline always loaded.
Validate: AC#2 — the updated prompt template contains an explicit guardrail loading step that names relevant extensions before code generation begins

#### Task 1.3: Update install.sh and INSTALL.md
File: `install.sh:200-270`, `INSTALL.md:1-200`
What: In `install.sh`, add a step to copy the `ai/` directory (guardrails.md, slop-register.md, extensions/) into the target project. Treat `ai/` as framework code — overwrite on upgrade, unlike user-owned files. In `INSTALL.md`, add a section documenting the guardrail pack: what it installs, how to customize `slop-register.md`, the extension loading protocol, and how to verify the agent loaded the right extensions.
Validate: AC#1, AC#5 — install.sh copies ai/ and INSTALL.md describes the pack

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Extend rad-review with guardrail detection gate
File: `.claude/commands/team/rad-review.md:1-183`
What: Add a "Guardrail Review" section to the rad-review process. The section instructs the reviewer to: (1) identify which domain extensions apply to the changed paths in the current diff, (2) load each matching extension, (3) run the baseline review checklist from `ai/guardrails.md` against the actual changes, (4) classify each finding as HARD (blocks PR) or SOFT (advisory). Hard violations — e.g., hallucinated APIs, broad catch blocks, responsibilities in the wrong layer, changed public contracts without updated tests — block the PR step and require a FAIL report before continuing. Soft findings are appended to the review summary.
Validate: AC#3 — rad-review explicitly loads domain extensions, runs the checklist, and blocks the PR step on hard violations

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Add slop-risk plan-analysis step to rad-approve
File: `.claude/commands/architect/rad-approve.md:50-157`
What: Before presenting the approval confirmation to the architect, add a plan-analysis step. The step reads the plan's wave structure and scans for slop-risk signals: tasks with no defined failure semantics (retries, queues, caches introduced without justification), tasks whose scope is too broad to validate against a single AC, speculative abstractions ("add a system for X" without a concrete requirement), and waves that mix responsibilities across unrelated modules. Output a structured PASS/FLAG report. PASS means no signals detected — architect sees "Guardrails: PASS" and can approve immediately. FLAG means one or more signals — architect sees the specific flags with the relevant task cited and decides whether to send back or approve with a note.
Validate: AC#4 — rad-approve produces a PASS/FLAG report before presenting the approval prompt to the architect

## Tests to Write
- [ ] Manually verify guardrail extension loading works for a sample wave touching backend routes — `.claude/commands/team/rad-deliver.md`
- [ ] Manually verify rad-review blocks on a known hard violation (broad catch block) — `.claude/commands/team/rad-review.md`
- [ ] Manually verify rad-approve produces a FLAG report for a plan task with undefined failure semantics — `.claude/commands/architect/rad-approve.md`

## Non-Goals
- Enforcing guardrails via harness-level gate evaluation (StateStore transitions) — this is a future architecture decision
- Auto-fixing slop detected during review — the guardrails scan reports, it never modifies code
- Pre-populating `ai/slop-register.md` with project-specific rules — teams fill this in for their stack

## Out-of-Scope Dependencies
None — all files are within architect scope and no external services are required.

## Risks
- The ai/ files are copied from an external repo; if agent_guides updates its guardrail content, RAD's copy will drift. Mitigation: document the source repo in `ai/guardrails.md` header so the drift is visible.
- Adding a plan-analysis step to rad-approve increases the architect's time-to-approve for the common case where slop risk is low. Mitigation: PASS is surfaced as a single line; only FLAG items expand into detail.
- Domain extension matching by changed path is heuristic (filename pattern vs. `Applies When` prose). Mitigation: the agent is instructed to load conservatively — when in doubt, include the extension; over-loading is safer than under-loading.
