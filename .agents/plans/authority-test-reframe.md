# Plan: Reframe the Authority Test
Created: 2026-10-23
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-23T15:38:44.637Z
Recorded-By: sean@torchcodelab.com
Branch: rad/authority-test-reframe
Source-Author: none (no source issue)
Source-Comments: none

## Context
The #46 audit (`docs/agent-hierarchy-audit.md`) tagged 16 agents `purpose: authority`, using the test "would this boundary still be wanted with a perfect model?" That shows the governance is wanted, not that it needs a separate agent loop. Anthropic's "When to fold subagents into your main agent loop" (2026-10-22) keeps a subagent only for (1) context-bloat degradation, (2) parallel fresh discardable contexts, or (3) tool-selection / conflicting-instruction problems. Authority belongs in deterministic enforcement. This plan records which of the 16 agents' prose constraints are actually enforced, reframes the audit, and makes `/rad-design` require a keep condition per subagent. Steps 4 + 6 of the subagent topology update; no agent is removed.

## Scope
| In scope | Out of scope |
|---|---|
| New `authority-agent-boundaries` invariant + prose-only `bypasses` in `docs/invariants.yaml` | Removing, merging or editing any agent in `.rad/agents-internal/` |
| Addendum + per-agent keep-condition table in `docs/agent-hierarchy-audit.md` | Making any prose-only constraint deterministic (separate issues) |
| Keep-condition requirement in the `/rad-design` skill source + regenerated copies | Changes to `harness/invariants.js`, `lint-invariants.sh` or `lint-agent-files.sh` |

## Acceptance Criteria
1. `docs/invariants.yaml` has a new invariant `authority-agent-boundaries` whose claim is only what is deterministically enforced (every `roles:`-declaring agent declares a valid `purpose:`), with at least one `enforced_by` anchor that resolves (e.g. `scripts/lint-agent-files.sh` `check_purpose`) and a `not_evalable` reason naming its covering test. `scripts/lint-invariants.sh` exits 0.
2. Every kind of prose constraint found in the 16 authority agents is classified. A kind enforced by an existing invariant (e.g. "never modify X" outside the plan's Files in Scope → `scope-enforced`) is listed as Enforced with that invariant id. Every prose-only kind has a `bypasses` entry (`id` prefixed `agent-prose-`, `surface`, `guarded: "no"` unless a real guard exists, `note`) under the invariant it would protect, or under `authority-agent-boundaries` when no host fits. At minimum these kinds are covered: direct reads/writes (`tools: Task` is structural but unlinted for orchestrators), raw-content return, protected-seam edits, design-seam rules, transport rules, behavioural rules, and role-based agent selection (prose in rad-plan Step 1). `scripts/lint-invariants.sh --inventory` lists every `agent-prose-` bypass.
3. `docs/agent-hierarchy-audit.md` gains an addendum that: states the reframed test ("does this governance need a separate agent loop?"); lists the three keep conditions and cites the article; has a 16-row table (agent | constraint kinds | Enforced / Prose-only | keep condition met: 1, 2, 3 or none); and names the agents meeting none as fold candidates for step 5, without removing them. The intro headline (lines 11-14) points to the addendum. The stale Part 2 sentence that lint-agent-files "waits until every agent is tagged" is corrected.
4. The `/rad-design` skill source requires each proposed subagent to name a keep condition in the architecture artifact: the purpose test table gains the keep-condition question; the Step 3 template gains `- Keep condition: [1 context bloat | 2 parallel fresh context | 3 tool/instruction conflict | none]: [evidence]`; the Step 4 approval table gains a keep-condition column. Condition 1 may be cited at design time as *expected* bloat with a stated reason, marked `(provisional — confirm with the topology eval or /rad-insights)`. Authority alone is not a keep condition: it points the designer to a deterministic check (a lint, gate or scope rule) instead. The keep condition stays in the artifact only, never in the agent file (extends the existing line-249 rule).
5. The generated copies (`.claude/commands/architect/rad-design.md`, `.agents/skills/rad-design/SKILL.md`) are refreshed by `rad generate`; `node harness/cli.js generate --check` reports no drift; `harness/test/skill-bodies.test.js` and `scripts/lint-agent-files.sh` pass with no agent file changed.

## Agent Scope
Research ran through one research sub-agent; no RAD agents were called (this repo's scope map has no docs/skill-design mapper). The user holds the architect role, which the self-protected paths (`.rad/`, `.claude/`) require.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| docs/invariants.yaml | 1-307 | add the `authority-agent-boundaries` invariant and `agent-prose-*` bypass entries under host invariants |
| docs/agent-hierarchy-audit.md | 1-221 | intro pointer (11-14), Part 2 correction (209-221), new addendum at the end |
| .rad/skills/rad-design/SKILL.md | 80-180 | purpose test table, Step 3 artifact template, Step 4 approval table |
| .rad/skills/rad-design/SKILL.md | 240-252 | extend the "artifact only, never the agent file" rule to the keep condition |
| .claude/commands/architect/rad-design.md | 75-250 | regenerated by `rad generate` (never hand-edited) |
| .agents/skills/rad-design/SKILL.md | 75-250 | regenerated by `rad generate` (never hand-edited) |

## Execution Notes

### Do Not Touch
- .rad/agents-internal/* — read-only input to the audit; no agent changes in this plan
- .claude/agents/*, .codex/agents/* — generated agent copies
- harness/invariants.js, scripts/lint-invariants.sh, scripts/lint-agent-files.sh — the schema already allows anchorless bypasses
- AGENTS.md, CLAUDE.md

### Key Files
- .rad/agents-internal/ — the 16 `purpose: authority` agents (orchestrators and parent-orchestrators); read their Rules sections
- harness/invariants.js — bypass schema: `id`, `surface`, `guarded` ("yes" | "no"), optional `note`; each invariant needs `enforced_by` and exactly one of `evals` / `not_evalable`
- docs/invariants.md — how the registry is meant to be written
- .rad/skills/rad-plan/SKILL.md — Step 1 is where role-based agent selection is prose-only

### Reminders
- An `enforced_by` symbol must be a literal substring of its file; confirm each with grep before writing it.
- Classify by constraint *kind*, not by every line; the per-agent table carries the detail.
- Edit only the SKILL.md source, then run `node harness/cli.js generate`. The headless claude preset cannot write `.claude/`; if generate is refused there, the run stops and the architect runs it by hand.
- Run `rad deliver` with `RAD_VERIFY_TIMEOUT_SECONDS=1800` and `RAD_WAVE_TIMEOUT_SECONDS=1800`. Inside a wave run only targeted checks (`bash scripts/verify-all.sh --only lint-invariants,generate-drift`); the last-wave Verify runs the full suite.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel.

#### Task 1.1: Record authority-agent constraints in the invariant registry
File: docs/invariants.yaml:1-307
What: Read the Rules of the 16 authority agents and group their constraints by kind. Add the `authority-agent-boundaries` invariant (claim limited to what lint-agent-files enforces; resolving `enforced_by` anchors; `not_evalable` naming `scripts/test-lint-agent-files.sh`). For each prose-only kind add an `agent-prose-<kind>` bypass under its host invariant, or under the new one when no host fits; kinds already enforced get no bypass.
Validate: AC#1, AC#2 — `bash scripts/lint-invariants.sh` exits 0; `bash scripts/lint-invariants.sh --inventory | grep agent-prose-` lists every required kind.

#### Task 1.2: Require a keep condition in /rad-design
File: .rad/skills/rad-design/SKILL.md:80-180, 240-252
What: Add the keep-condition question to the purpose test table, the `Keep condition:` line to the Step 3 artifact template, a keep-condition column to the Step 4 approval table, the design-time provisional rule for condition 1, the "authority → deterministic check" rule, and the artifact-only rule. Then run `node harness/cli.js generate`.
Validate: AC#4, AC#5 — the source contains the three conditions, the provisional marker and the deterministic-check rule; `node harness/cli.js generate --check` exits 0; `node --test harness/test/skill-bodies.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Write the audit addendum
File: docs/agent-hierarchy-audit.md:1-221
What: Append the addendum (reframed test, three keep conditions with the article link, 16-row table built from Task 1.1's classification, fold candidates); add an intro pointer; correct the stale Part 2 sentence.
Validate: AC#3 — the table has exactly 16 rows matching the agents with `purpose: authority` (`grep -l "purpose: authority" .rad/agents-internal/*.md | wc -l`); every `agent-prose-` bypass id cited in the table exists in `docs/invariants.yaml`.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] No new test file: this plan changes data (registry entries), docs and a skill prompt. Coverage comes from the existing `scripts/test-lint-invariants.sh` / `harness/test/invariants.test.js` (registry validity and anchor resolution), `harness/test/skill-bodies.test.js`, and the `generate-drift` check — all run by the last-wave Verify.

## Non-Goals
- No agent is removed, merged or edited; folding is step 5, gated on the topology eval.
- No prose-only constraint is made deterministic here; each becomes its own follow-up issue.
- No change to the `purpose:` taxonomy or to agent frontmatter.
- No lint parses the architecture artifact's keep-condition line.

## Out-of-Scope Dependencies
Touches self-protected paths (`.rad/`, `.claude/`, `.agents/skills/`); architect review required.

## Risks
- A bypass entry that misstates whether a guard exists would make the inventory misleading. Mitigation: `guarded: "yes"` only with a named guard in `note`.
- Classifying by kind can hide a one-off constraint. Mitigation: the per-agent table lists each agent's kinds, so anything unclassified is visible.
- The addendum softens the audit's "every boundary is durable" headline; the intro pointer keeps both readings visible rather than rewriting history.
