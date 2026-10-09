# Plan: Hygiene Batch A: ACP Flake, Ahead-Only Checkout, Agent Audit Follow-ups (#201, #230, #192)
Created: 2026-10-09
Author: architect
Status: pending-review
Branch: rad/hygiene-batch-a
Issue: 201
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/201
Issue-Title: checkout-plan.sh reports an ahead-only local branch as diverged

## Context
Three small, independent follow-ups, batched into one plan. The user chose the batch and the #201 behavior on 2026-10-09.

- **#201:** `scripts/checkout-plan.sh` treats a local work branch that is only *ahead* of `origin/<branch>` as diverged and refuses with "Another machine holds a diverged tip". The predicate at L56-57 declares divergence whenever the local tip is not an ancestor of the remote tip, which also catches ahead-only. True divergence needs both directions to fail. Behind-only already fast-forwards, and `rad deliver`'s prepare phase already treats ahead-only as fine. The only callers are `rad checkout` (used by `rad-approve` Step 2 and `kickoff`'s resume hint). **Decision (Q1, option B):** ahead-only passes, and `rad checkout` says so. `rad checkout` currently discards the script's stderr on success, so its success line gains ` ahead=N` when N is greater than 0, and is otherwise byte-identical.
- **#230:** `harness/test/acp-adapter.test.js` › `checkAcpAgent: complete passes all six checks…` fails intermittently under load. The 200 ms comes from the test itself (`FAST = { timeoutMs: 5_000, killGraceMs: 200 }`, L17), not from production, whose default is `KILL_GRACE_MS` in `harness/adapters/agent/command.js`. The shutdown check allows `killGraceMs` after stdin closes; a slow exit under load falls through to SIGTERM and the check fails.
- **#192:** the #46 audit found two mappers that pre-write their answers instead of stating an anchor contract, one orchestrator that delegates to two agents that don't exist, and four agents that point at moved documentation. The agent sources are now `.rad/agents-internal/*.md` (since #224), so the issue's `.claude/agents/…:line` references are out of date. Fix the sources, then regenerate.

This plan ends with a full-verification wave (#229). The `playbook-skills` run showed it works inside a run now that worktrees get `node_modules` (#232). Run it with `RAD_WAVE_TIMEOUT_SECONDS=1800`.

## Scope
| In scope | Out of scope |
|---|---|
| The ACP flake: the test passes a larger grace for the complete check only | The production `KILL_GRACE_MS` default |
| The ahead-only checkout predicate, a stderr note, and ` ahead=N` in `rad checkout`'s success line, with tests and docs | `scripts/git-sync.sh fetch-tip`, which has the same false positive but no callers |
| Seven agent sources fixed and regenerated; the audit doc updated | Any other agent, or the agent lint |
| A final full-verification wave | |

## Acceptance Criteria
1. **The ACP flake (#230).** In `harness/test/acp-adapter.test.js`, the `complete passes all six checks…` test calls `checkAcpAgent` with `{ ...FAST, killGraceMs: 2_000 }`. `FAST` and every other test keep `killGraceMs: 200`, and `harness/adapters/agent/` is untouched. The file passes in 10 consecutive runs.
2. **The checkout predicate (#201).** In `scripts/checkout-plan.sh`, divergence is declared only when neither tip is an ancestor of the other. In practice:
   - ahead-only (remote is an ancestor of local) passes, leaving the branch as is, and prints `note: local '<branch>' is N commit(s) ahead of origin (unpushed)` to stderr, with N from `git rev-list --count origin/<branch>..<branch>`;
   - behind-only fast-forwards as today;
   - true divergence is refused with the existing lock-holder message and exit 1;
   - the second backstop message at L88-91 and the script's header comment (exit codes and states) are updated to match.
3. **`rad checkout` reports ahead (#201).** In `harness/checkout.js`, after a successful script run, `checkoutPlan` computes `git rev-list --count origin/<branch>..<branch>` through the injected `sh`.
   - If N is greater than 0, the success line ends with ` ahead=N`, otherwise it is byte-identical to today.
   - A failure to compute is ignored: it never fails the checkout, and it omits the field.
   - Exit codes are unchanged.
4. **The agent fixes (#192),** in `.rad/agents-internal/`. Never write literal line numbers into an agent file.
   - **`approval-event-mapper`:** replace the worked Output Format (the pre-written answers with line numbers) with an anchor contract in the style of the passing mappers: list the items to locate and require a freshly read `file:line` for each. Keep the list of items (the event types, `PHASE_BY_TYPE`, the gate evaluation, `recordApproval`'s provenance freezing, the transition rules, the event-log path and `isSafeFeature` construction).
   - **`hook-surface-mapper`:** replace the prose "Summary" Output Format with an anchor contract that requires `file:line` on every item, drop the pre-written dedup text, and change the description to "Returns file:line anchors and … notes" while keeping its "MUST BE USED" prefix.
   - **`spine-integration-orchestrator`:** remove the delegation to `event-log-guardian` and `plan-parser-guardian` (neither exists), pointing at the real owners instead (`spine-mapper`, `hook-runtime-orchestrator`, or dropping the line where nothing owns it).
   - **`event-fold-mapper`:** `recordApproval` lives in `harness/adapters/git-state-store.js`; the writer and the provenance freezing are described accordingly, and its scope list names that file.
   - **`lint-surface-mapper`, `sync-surface-mapper`, `findings-surface-mapper`:** replace the CLAUDE.md pointers with the real locations (the scope map in `.rad/config.yml` `agent_scope_map`; conventions in `AGENTS.md`; the RAD environment variables in `docs/configuration.md`). Verify each target before pointing at it. In `findings-surface-mapper`, also check its Output Format for literal anchors and replace them with an anchor contract if present.
   - **`.rad/config.yml`:** in the `lint-surface-mapper` row's `reads:`, `.claude/agents samples` becomes `.rad/agents-internal samples`. No other row changes unless a `reads:` string still names CLAUDE.md.
   - `docs/agent-hierarchy-audit.md`: the drift and stale-reference findings (L180-207) are marked resolved, with the "nine of eleven" sentence updated.
   - Frontmatter (name, model, tools, roles, purpose) is unchanged, except the one description edit above.
5. **Regenerated and linted.** `node harness/cli.js generate` rewrites the matching `.claude/agents/*.md` and `.codex/agents/*.toml` for the seven agents. `generate --check`, `scripts/lint-agent-files.sh` and `config validate` all pass.
6. **Tests.**
   - harness/test/cli-checkout.test.js: an ahead-only branch checks out with exit 0, the success line has ` ahead=1` with the local sha as `head`, and the remote is unchanged; ahead by two reports `ahead=2`; behind-only has no `ahead=`; true divergence is still refused (the existing case passes unchanged); a failing rev-list omits the field without failing.
   - harness/test/portable-process-memory.test.js: an ahead-only AC beside the existing divergence ACs.
   - No existing assertion changes.
7. **Docs.** `docs/rad-cli.md` `### rad checkout`: the three branch states (behind fast-forwards; ahead passes with a note and ` ahead=N`; diverged is refused), and the success line format. `docs/how-it-works.md`: the `checkout-plan.sh` row notes that an ahead-only branch passes.
8. **Full verification.** The last wave runs everything CI runs, clean: `node --test harness/test/*.test.js`, `node --test harness/evals/*.eval.js`, every `scripts/test-*.sh`, `generate --check`, `playbook lint`, `config validate`, and `lint-invariants.sh`, `lint-agent-files.sh`, `lint-claude-md.sh` and `lint-shell-safety.sh`. It makes no edits unless a failure traces to this plan's changes, and such a fix stays within the scope above.

## Agent Scope
Research came from a read-only sub-agent survey of checkout-plan.sh and all its callers, the checkout tests, the ACP adapter's grace handling, the seven agent sources and the passing mappers' contract style, the agent lint, the audit doc and the CI drift job. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/test/acp-adapter.test.js | 12-20 | Read: `FAST` |
| harness/test/acp-adapter.test.js | 300-312 | The complete check passes `killGraceMs: 2_000` |
| scripts/checkout-plan.sh | 1-92 | Predicate, note, header comment, backstop message |
| harness/checkout.js | 55-116 | `ahead=N` on the success line |
| harness/test/cli-checkout.test.js | 100-150 | Read: helpers; append cases |
| harness/test/portable-process-memory.test.js | 276-372 | Append an ahead-only AC |
| docs/rad-cli.md | 212-250 | `### rad checkout` |
| docs/how-it-works.md | 156-164 | The `checkout-plan.sh` row |
| .rad/agents-internal/approval-event-mapper.md | 1-35 | Output Format anchor contract |
| .rad/agents-internal/hook-surface-mapper.md | 1-42 | Output Format and description |
| .rad/agents-internal/spine-integration-orchestrator.md | 1-44 | Remove nonexistent delegation |
| .rad/agents-internal/event-fold-mapper.md | 1-41 | `recordApproval` location |
| .rad/agents-internal/lint-surface-mapper.md | 1-32 | CLAUDE.md pointers |
| .rad/agents-internal/sync-surface-mapper.md | 1-43 | CLAUDE.md pointers |
| .rad/agents-internal/findings-surface-mapper.md | 1-50 | CLAUDE.md pointers and Output Format |
| .claude/agents/approval-event-mapper.md | 1-1 | Regenerated |
| .claude/agents/hook-surface-mapper.md | 1-1 | Regenerated |
| .claude/agents/spine-integration-orchestrator.md | 1-1 | Regenerated |
| .claude/agents/event-fold-mapper.md | 1-1 | Regenerated |
| .claude/agents/lint-surface-mapper.md | 1-1 | Regenerated |
| .claude/agents/sync-surface-mapper.md | 1-1 | Regenerated |
| .claude/agents/findings-surface-mapper.md | 1-1 | Regenerated |
| .codex/agents/approval-event-mapper.toml | 1-1 | Regenerated |
| .codex/agents/hook-surface-mapper.toml | 1-1 | Regenerated |
| .codex/agents/spine-integration-orchestrator.toml | 1-1 | Regenerated |
| .codex/agents/event-fold-mapper.toml | 1-1 | Regenerated |
| .codex/agents/lint-surface-mapper.toml | 1-1 | Regenerated |
| .codex/agents/sync-surface-mapper.toml | 1-1 | Regenerated |
| .codex/agents/findings-surface-mapper.toml | 1-1 | Regenerated |
| .rad/config.yml | 117-125 | `lint-surface-mapper` row `reads:` |
| docs/agent-hierarchy-audit.md | 178-210 | Findings marked resolved |
| .rad/agents-internal/spine-mapper.md | 1-31 | Read only: the passing contract style |

## Execution Notes

### Do Not Touch
- The production grace default (`KILL_GRACE_MS` in harness/adapters/agent/command.js) and harness/adapters/agent/acp.js
- `scripts/git-sync.sh`
- Frontmatter of any agent (except the one description edit), scripts/lint-agent-files.sh
- The other 20 agent sources and the two reviewer sources

### Key Files
- scripts/checkout-plan.sh: divergence at L52-82, the backstop at L88-91, header comment L9-19
- harness/checkout.js: `runCheckoutScript` (L66-72), `readHead`, `checkoutPlan`, the success line (~L109)
- harness/test/cli-checkout.test.js: `withRepo`, `publishBranch`, `commitFile`, `runCheckout`, `assertOk`; the behind-only case (~L123-133) and the diverged case (~L135-148)
- .rad/agents-internal/spine-mapper.md and event-fold-mapper.md: the anchor-contract Output Format style to copy
- scripts/lint-agent-files.sh: context-tool rules (haiku model, "MUST BE USED"/"Use PROACTIVELY" description, no `Task`), the purpose tag, the scope-map match

### Reminders
- **Edit the sources in `.rad/agents-internal/`, then run `node harness/cli.js generate`.** Never hand-edit `.claude/agents` or `.codex/agents`.
- **A mapper description must start with "MUST BE USED" (context tools) and keep its tools (Read, Grep, Glob) and haiku model.** The agent lint checks this.
- **No literal line numbers in agent files.** An agent file that quotes line numbers is the defect being fixed.
- **True divergence must never pass.** The new predicate requires both ancestor checks to fail. Test it.
- **The final wave needs `RAD_WAVE_TIMEOUT_SECONDS=1800`** and runs every CI lint, including `scripts/lint-shell-safety.sh`. Any new script must be committed executable; this plan adds none.
- **Edits to agents 3.1/3.2 are prose.** Keep each Output Format short (the passing mappers state it in a few lines).
- Helpers stay under ~40 lines in any code, with named constants.

## Program Design
```
checkout-plan.sh <branch>
  fetch → checkout → LOCAL, REMOTE tips
  LOCAL == REMOTE                      → pass
  REMOTE is ancestor of LOCAL (ahead)  → pass; stderr "note: ... N commit(s) ahead (unpushed)"     (was: refused)
  LOCAL is ancestor of REMOTE (behind) → pull --ff-only → pass
  neither is an ancestor of the other  → refuse, name the lock holder, exit 1                       (unchanged)
rad checkout → script ok → ahead = git rev-list --count origin/<b>..<b>  (ignore failure)
            → "rad checkout: ok feature= branch= head= plan=" + (ahead>0 ? " ahead=N" : "")
```
```
harness/test/acp-adapter.test.js        ~ one test's killGraceMs
scripts/checkout-plan.sh, harness/checkout.js, 2 test files, 2 docs   ~
.rad/agents-internal/* (7), generated .claude/agents + .codex/agents (14), .rad/config.yml row, audit doc   ~
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The ACP flake
File: harness/test/acp-adapter.test.js:12-20, 300-312
What: Write AC#1. Change only the complete-check test's grace.
Validate: AC#1 — run `node --test harness/test/acp-adapter.test.js` 10 times in a loop; all runs pass, none fail

### Wave 2 — sequential

#### Task 2.1: The ahead-only checkout
File: scripts/checkout-plan.sh:1-92, harness/checkout.js:55-116, harness/test/cli-checkout.test.js:100-150, harness/test/portable-process-memory.test.js:276-372
What: Write AC#2, AC#3 and AC#6.
Validate: AC#2, AC#3, AC#6 — `node --test harness/test/cli-checkout.test.js harness/test/portable-process-memory.test.js` passes; `bash -n scripts/checkout-plan.sh` is clean; edge cases covered: ahead by one and by two, behind-only, true divergence still refused, and a failing rev-list omits `ahead=` without failing the checkout

#### Task 2.2: The checkout docs
File: docs/rad-cli.md:212-250, docs/how-it-works.md:156-164
What: Write AC#7.
Validate: AC#7 — `grep -n 'ahead=' docs/rad-cli.md` matches; docs only

### Wave 3 — sequential

#### Task 3.1: The two drifted mappers, the orchestrator and the fold mapper
File: .rad/agents-internal/approval-event-mapper.md:1-35, .rad/agents-internal/hook-surface-mapper.md:1-42, .rad/agents-internal/spine-integration-orchestrator.md:1-44, .rad/agents-internal/event-fold-mapper.md:1-41, .claude/agents/approval-event-mapper.md:1-1, .claude/agents/hook-surface-mapper.md:1-1, .claude/agents/spine-integration-orchestrator.md:1-1, .claude/agents/event-fold-mapper.md:1-1, .codex/agents/approval-event-mapper.toml:1-1, .codex/agents/hook-surface-mapper.toml:1-1, .codex/agents/spine-integration-orchestrator.toml:1-1, .codex/agents/event-fold-mapper.toml:1-1, .rad/agents-internal/spine-mapper.md:1-31
What: Write the first four AC#4 bullets for these four agents, then run `node harness/cli.js generate` (AC#5).
Validate: AC#4, AC#5 — `node harness/cli.js generate --check` exits 0; `bash scripts/lint-agent-files.sh` passes; `grep -n -E '[a-z_-]+\.(js|yaml|sh):[0-9]+' .rad/agents-internal/approval-event-mapper.md .rad/agents-internal/hook-surface-mapper.md` returns nothing (no literal line numbers)

#### Task 3.2: The CLAUDE.md pointers and the audit doc
File: .rad/agents-internal/lint-surface-mapper.md:1-32, .rad/agents-internal/sync-surface-mapper.md:1-43, .rad/agents-internal/findings-surface-mapper.md:1-50, .claude/agents/lint-surface-mapper.md:1-1, .claude/agents/sync-surface-mapper.md:1-1, .claude/agents/findings-surface-mapper.md:1-1, .codex/agents/lint-surface-mapper.toml:1-1, .codex/agents/sync-surface-mapper.toml:1-1, .codex/agents/findings-surface-mapper.toml:1-1, .rad/config.yml:117-125, docs/agent-hierarchy-audit.md:178-210
What: Write the last three AC#4 bullets, the `.rad/config.yml` row edit and the audit doc update, then run `node harness/cli.js generate`.
Validate: AC#4, AC#5 — `node harness/cli.js generate --check` exits 0; `bash scripts/lint-agent-files.sh` passes; `node harness/cli.js config validate` passes; `grep -n 'CLAUDE.md' .rad/agents-internal/lint-surface-mapper.md .rad/agents-internal/sync-surface-mapper.md .rad/agents-internal/findings-surface-mapper.md` returns nothing

### Wave 4 — sequential

#### Task 4.1: Full verification
File: docs/agent-hierarchy-audit.md:178-210
What: Write AC#8. Run every command listed in it from the worktree. Make no edits unless a failure traces to this plan's changes, and such a fix stays within the scope above; report anything else as `blocked_intent`. Needs `RAD_WAVE_TIMEOUT_SECONDS=1800`.
Validate: AC#8 — `node --test harness/test/*.test.js` and `node --test harness/evals/*.eval.js` exit 0; every `scripts/test-*.sh` passes; `node harness/cli.js generate --check`, `playbook lint`, `config validate`, `bash scripts/lint-invariants.sh`, `bash scripts/lint-agent-files.sh`, `bash scripts/lint-claude-md.sh` and `bash scripts/lint-shell-safety.sh` all exit 0

## Tests to Write
- [ ] ahead-only checkout, ahead=N, behind-only and divergence unchanged, a failing rev-list — harness/test/cli-checkout.test.js
- [ ] ahead-only AC beside the divergence ACs — harness/test/portable-process-memory.test.js

## Non-Goals
- Fixing `scripts/git-sync.sh fetch-tip`'s identical false positive (no callers; note it in the PR).
- Changing the production ACP kill grace, or any other agent.
- A lint for the anchor contract text itself (agent prose stays unguarded).

## Out-of-Scope Dependencies
None

## Risks
- **Loosening the divergence tripwire is a safety-relevant change.** Mitigation: the predicate requires both ancestor checks to fail, the existing diverged case must pass unchanged, and a test pins that true divergence is still refused.
- **Agent prompt edits can change how the mappers behave.** They're repo-internal and used for planning research, and the new contract is the style the nine passing mappers already use. The agent lint and `generate --check` guard the structure.
- **The wave 3 agents verify claimed locations by reading the code,** since the issue's line numbers are stale. A wrong pointer would be a regression, so each target is verified before it is written.
- **Self-protected paths** (`scripts/`, `harness/`, `.rad/`, `.claude/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — `rad checkout` computes `ahead=N` itself** (a second `git rev-list` through the injected `sh`), instead of parsing the script's stderr, so the success line doesn't depend on the script's message text.
- **Assumption — the primary issue is #201;** #230 and #192 are closed by hand after the merge.
- **Assumption — only the `lint-surface-mapper` row in `.rad/config.yml` needs an edit,** since the other `reads:` strings already name AGENTS.md or `.rad/config.yml`. The task verifies this.
