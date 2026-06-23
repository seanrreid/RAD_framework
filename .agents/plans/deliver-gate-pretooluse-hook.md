# Plan: Deliver-Gate PreToolUse Hook
Created: 2026-06-23
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-23T18:28:25.071Z
Recorded-By: sean@torchcodelab.com
Branch: rad/deliver-gate-pretooluse-hook
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/35
Issue-Title: Deterministically enforce the deliver gate with a PreToolUse harness hook

## Context
RAD's most safety-critical rule — "never `/rad-deliver` without an `approved` event" — is
currently **prose the model is asked to obey** (CLAUDE.md). The deterministic gate
(`scripts/check-plan-approved.sh` → `rad gate <feature> approved`, fail-closed) exists, but
nothing enforces it at the harness boundary: only the deliver spine checks it, and only
once the spine is reached. A misfired `/rad-deliver` (wrong branch, a skipped step, an
autonomous loop) can attempt delivery before that check runs. This plan adds a Claude Code
**PreToolUse hook** (registered in `.claude/settings.json`) that intercepts the
`/rad-deliver` Skill invocation, resolves the feature slug, runs the **existing** gate
query, and **blocks** the call fail-closed when no `approved` event exists — making an
unapproved deliver physically impossible rather than merely discouraged. Purely additive;
no new authority.

## Scope
| In scope | Out of scope |
|---|---|
| A PreToolUse hook script + its `.claude/settings.json` registration | Modifying the in-spine gate check (`deliverCommand` keeps its own `state.gate`) |
| Reusing `scripts/check-plan-approved.sh` as the gate authority | Any change to the pure fold (`harness/gates.js`) or the event schema |
| Blocking the `team:rad-deliver` Skill invocation when unapproved | The wave-lifecycle hooks (`scripts/hooks/`, `harness/hook-runner.js`) — a different layer |
| Fail-closed when the slug can't be resolved | Bash-direct `node harness/cli.js deliver` (spine still gates it) — see Issue Gaps |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. When the `team:rad-deliver` Skill is invoked for a feature with **no** `approved` event,
   the PreToolUse hook **blocks** the call fail-closed (deny + a clear reason) before any
   deliver work runs.
2. When invoked for an **approved** feature, the hook **allows** the call through unchanged
   (no false block, exit 0).
3. The hook **passes through** (never blocks) for non-`rad-deliver` tool calls and for an
   argument-less `/rad-deliver` (the listing case — no plan/feature provided).
4. **Fail-closed on ambiguity OR the hook's own error:** if the feature slug cannot be
   resolved, OR the hook itself errors (malformed input, missing `node`/dependency, the
   gate query failing to run), the hook **blocks** (deny) — never silently allows. NB: the
   Claude Code hook harness is **fail-OPEN** (a crash / invalid JSON / an exit code other
   than 0 or 2 lets the tool proceed), so the script must explicitly emit deny on **every**
   error path; a bare non-zero exit is NOT a block.
5. The hook reuses the existing deterministic gate (`scripts/check-plan-approved.sh`) and
   introduces **no new authority** — `harness/gates.js` and the event schema are untouched.

## Agent Scope
Research delegated to a single Explore sub-agent (architect role). This is gate-enforcement
work on the determinism boundary — architect-only. No feature-specific agents required; no
out-of-scope dependencies.

## Files in Scope
<!-- Lines must be a range or a single number. Linter sums these for context budget. -->
| File | Lines | Change |
|------|-------|--------|
| scripts/deliver-gate-hook.mjs | 1-90 | NEW Node (ESM) PreToolUse hook: read the hook JSON from stdin; if the tool is the `team:rad-deliver` Skill, extract the plan path/feature slug, resolve `rad/<slug>`, shell to `scripts/check-plan-approved.sh`; **block fail-closed** (deny + exit non-zero) when unapproved or slug-unresolvable; pass (exit 0) otherwise and for non-deliver tools / empty args |
| .claude/settings.json | 1-8 | Register a `hooks.PreToolUse` entry matching the Skill tool, command `node scripts/deliver-gate-hook.mjs` |
| harness/test/deliver-gate-hook.test.js | 1-1 | NEW tests driving the hook with synthetic PreToolUse payloads (covers AC#1–4) |
| scripts/hooks/README.md | 1-121 | Add a short "Not to be confused with — the session-boundary deliver gate" note distinguishing this PreToolUse hook from the in-spine wave-lifecycle hooks |
| CLAUDE.md | 78-82 | Annotate the "Never execute /rad-deliver…" rule to note it is now **deterministically enforced** by the PreToolUse hook (the rule stays; it gains an enforcement mechanism) |

## Execution Notes

### Do Not Touch
- harness/gates.js — the pure fold; the hook calls the existing gate query, never the fold (AC#5).
- harness/hook-runner.js, scripts/hooks/<point>/ — the wave-lifecycle hook mechanism; this is a *different* layer (session boundary vs in-spine). Only the README in scripts/hooks/ gets a contrast note.
- harness/spine.js, harness/matrix.js, harness/matrix.yaml — the deliver spine + frozen vocabulary; the hook blocks at the invocation boundary and must NOT route through the matrix.
- scripts/check-plan-approved.sh — reuse as-is; do not modify the gate query.
- harness/cli.js `deliverCommand` — keep its in-band `state.gate` check; the hook is an additional outer layer, not a replacement.

### Key Files
- scripts/check-plan-approved.sh — the deterministic gate the hook shells to: takes `rad/<feature>`, exits 0 (approved) / non-zero (fail-closed).
- .claude/commands/team/rad-deliver.md — confirms `/rad-deliver` takes the plan path (`.agents/plans/<slug>.md`); the slug source for the hook.
- scripts/hooks/README.md — the existing hook doc whose "session-boundary vs in-spine" distinction must stay crisp.

### Reminders
- The hook parses JSON from stdin (VERIFIED PreToolUse contract: `tool_name`, `tool_input.skill_name`, `tool_input.skill_args`). Use Node (`.mjs`) for native JSON; shell to `check-plan-approved.sh` for the gate — do not reimplement the fold.
- **The harness is FAIL-OPEN.** A crash, invalid output, or any exit code ≠ 0,2 lets the deliver proceed. So `set -e`/bare non-zero = fail-OPEN — a trap. The script must convert *every* error path to `exit 2`. Default-deny on any uncertainty; only an explicit approved/pass-through reaches `exit 0`.
- Block with `exit 2` + stderr (not the JSON form; never both).
- Fail-closed is the whole point: unapproved gate, unresolved slug, OR internal error ⇒ `exit 2`. Only an explicit approved, a non-Skill/non-rad-deliver tool, or empty-args passes.
- Validate the extracted slug against the existing safe pattern (`^[a-z0-9][a-z0-9-]*$`) before interpolating into a branch name or shell call.
- Interactive PreToolUse fires for BOTH user-typed `/rad-deliver` (after expansion) and a model/autonomous-loop-initiated Skill call — which is why PreToolUse/Skill is chosen over UserPromptExpansion (the latter would miss model-initiated calls, the exact threat #35 names). It still does not fire in non-interactive CI runWave — that path relies on the spine's in-band gate. Document, don't try to cover it here.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (distinct files; the registration only references the script path).

#### Task 1.1: PreToolUse hook script
File: scripts/deliver-gate-hook.mjs:1-90
What: New ESM Node script. Read the full PreToolUse JSON from stdin (VERIFIED contract: top-level `tool_name`; for a Skill call, `tool_input.skill_name` + `tool_input.skill_args`). If `tool_name === "Skill"` and `tool_input.skill_name` is the rad-deliver skill (match `rad-deliver`, namespace-tolerant), extract the plan path / feature slug from `tool_input.skill_args` (handle both a `.agents/plans/<slug>.md` path and a bare feature name); resolve `rad/<slug>`; validate the slug against `^[a-z0-9][a-z0-9-]*$`; shell to `scripts/check-plan-approved.sh rad/<slug>`. **Block** when the gate is unapproved, the slug cannot be resolved, OR the script hits any internal error. **Pass** (exit 0, no output) for non-Skill tools, non-rad-deliver skills, an argument-less invocation (listing), and an approved gate.
  BLOCK MECHANISM (VERIFIED): exit `2` with a clear stderr reason — pick the exit-2 form, not the JSON form, and never both. **Fail-OPEN harness caveat (load-bearing):** the harness treats a crash / invalid output / any exit code ≠ 0,2 as *non-blocking*. Therefore do NOT rely on `set -e` or a bare non-zero exit — wrap the whole body so EVERY error path (bad JSON, missing dep, gate-query spawn failure, unresolved slug) converts to `exit 2`. The default/fallthrough on any uncertainty is `exit 2`, and only an explicit approved/pass-through reaches `exit 0`.
Validate: AC#1, AC#2, AC#3, AC#4 — confirmed by the Wave 2 tests driving synthetic payloads (including an induced internal-error case that must still block).

#### Task 1.2: Register the hook in settings.json
File: .claude/settings.json:1-8
What: Add a `hooks.PreToolUse` array entry matching the Skill tool, with `{ "type": "command", "command": "node scripts/deliver-gate-hook.mjs" }`. Preserve the existing `autoMode` block. Keep the matcher broad enough to receive Skill calls; the script itself decides whether the call is `team:rad-deliver` (so a non-deliver Skill passes through per AC#3).
Validate: AC#1 — with the registration present, an unapproved `team:rad-deliver` invocation is intercepted and blocked by the script.

### Wave 2 — sequential
Depends on: Wave 1 complete (hook script + registration exist)

#### Task 2.1: Hook tests
File: harness/test/deliver-gate-hook.test.js:1-1
What: NEW `node:test` suite that spawns `scripts/deliver-gate-hook.mjs` with synthetic PreToolUse JSON on stdin (use the `withTempRepo` pattern + an event log for approved/unapproved states). Cases: unapproved deliver → exit 2 (AC#1); approved deliver → exit 0 (AC#2); non-Skill tool, non-rad-deliver skill, and empty-args deliver → exit 0 (AC#3); unresolvable/invalid slug → exit 2 (AC#4); **induced internal error** (malformed JSON on stdin) → exit 2, proving fail-closed despite the fail-open harness (AC#4). Assert on exit code 2 specifically (not just "non-zero"), since the harness only treats 2 as a block. Mirror the existing harness/test style.
Validate: AC#1, AC#2, AC#3, AC#4 — each case asserted (incl. the internal-error block); all pass under `node --test`.

#### Task 2.2: Documentation + rule annotation
File: scripts/hooks/README.md:1-121
What: Add a brief "Not to be confused with — the session-boundary deliver gate" subsection clarifying that the PreToolUse deliver-gate hook (settings.json) is a *different layer* from the in-spine wave-lifecycle hooks documented here (session-boundary intercept vs in-wave lifecycle; fail-closed block vs the 6-point veto/observe model). Also annotate the CLAUDE.md "Never execute /rad-deliver…" rule (line ~80) to note it is now deterministically enforced by this hook.
Validate: AC#5 — docs state the hook reuses the existing gate (no new authority) and is distinct from the wave-lifecycle hooks.

## Tests to Write
- [ ] Unapproved `team:rad-deliver` invocation is blocked fail-closed — harness/test/deliver-gate-hook.test.js
- [ ] Approved feature passes through (exit 0) — harness/test/deliver-gate-hook.test.js
- [ ] Non-deliver Skill tool and argument-less deliver pass through — harness/test/deliver-gate-hook.test.js
- [ ] Unresolvable/invalid slug blocks fail-closed — harness/test/deliver-gate-hook.test.js

## Non-Goals
- No change to the in-spine gate (`deliverCommand`'s `state.gate`) — the hook is an additional outer layer, not a replacement.
- No new authority, event type, or modification to the pure fold (`harness/gates.js`).
- No coverage of Bash-direct `node harness/cli.js deliver` or autonomous/CI runWave — the spine's in-band gate remains the authority there (documented, not enforced by this hook).
- No change to the wave-lifecycle hook mechanism (`harness/hook-runner.js`, `scripts/hooks/<point>/`).

## Out-of-Scope Dependencies
None — all touched surfaces are within the architect-only gate-enforcement scope.

## Risks
- **False block (over-gating):** a too-broad matcher or a slug-extraction bug could block legitimate approved delivers. Mitigation: AC#2 + tests assert approved passes; the script only blocks for `team:rad-deliver` with an unapproved/unresolvable slug.
- **Wrong PreToolUse contract:** if the assumed stdin JSON shape (tool name + Skill args field) is wrong for the installed Claude Code version, the hook silently no-ops or mis-fires. Mitigation: see Issue Gaps — verify the contract at deliver; tests pin the script's own input/output behavior regardless.
- **Double-gate confusion:** the hook and the spine both check approval. Intended (defense in depth) — the hook blocks the *invocation*, the spine guards *execution*. Documented so it isn't mistaken for a bug.

## Issue Gaps
<!-- Mandatory: assumptions the architect should verify. -->
- **Claude Code PreToolUse JSON contract — VERIFIED 2026-06-23** (via claude-code-guide, against code.claude.com/docs/en/hooks.md). Stdin: top-level `tool_name`, `tool_input`; for a Skill call `tool_input.skill_name` + `tool_input.skill_args`. Block = `exit 2` + stderr, OR exit-0 JSON `hookSpecificOutput.permissionDecision: "deny"` — never both (exit 2 wins / JSON ignored when exiting 2). **Harness is fail-OPEN**: crash / invalid JSON / exit ≠ 0,2 ⇒ tool proceeds. No longer an assumption; baked into Task 1.1 and AC#4.
- **Interception point — DECIDED: PreToolUse / matcher `Skill`.** `UserPromptExpansion` (matcher = command name) fires earlier but ONLY for user-typed `/rad-deliver`; it would miss a model/autonomous-loop-initiated Skill call — the exact threat #35 names. PreToolUse/Skill catches both. The script filters for the rad-deliver skill name (namespace-tolerant) so other skills pass through.
- **Slug source.** Slug comes from `tool_input.skill_args` — a `.agents/plans/<slug>.md` path or a bare feature name; neither present = the AC#3 listing case → pass.
- **Bash-direct invocation is intentionally uncovered** in v1 (the Skill boundary only). Flagged as a known limitation; the spine's in-band gate still catches it.
