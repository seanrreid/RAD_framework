# Plan: Worktree Isolation by Default + Intake Disposition
Created: 2026-09-30
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-30T16:52:19.701Z
Recorded-By: sean@torchcodelab.com
Branch: rad/worktree-default-and-disposition
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/61, https://github.com/seanrreid/RAD_framework/issues/94
Issue-Title: Make worktree isolation the default for /rad-deliver (#61) + Intake early-exit taxonomy (#94)

## Context

This is the "quick batch": two self-contained workflow changes.

- **#61:** `RAD_WORKTREE` shipped opt-in, so an autonomous `rad deliver` writes into the operator's live checkout by default. #113, which blocked this (the plan was read before the worktree existed), closed on 2026-09-25. `rad deliver` only became fully functional end to end in #157, so very few runs depend on the unisolated default.
- **#94:** `/rad-research` has no step that can conclude a request shouldn't become a plan. Every intake is assumed to be actionable work, so the cheapest refutation happens only after the most expensive steps: planning and occupying Gate 1.

**What research found:**
- **#61, CLI.**
  - `RAD_WORKTREE` is read at `harness/cli.js:785` (`readResumeHistory`) and `:1108-1110` (setup switch: `isNonEmpty` → `setupWorktreeRun`, else `setupMainRun`).
  - `prepareWorktreeRoot` (`:707-726`) runs the branch-tip gate (`:709`), then `worktree.create` (`:721`). If the work branch is checked out in the main tree, `git worktree add` fails, and the catch (`:722-725`) exits 1 with `worktree create failed`. There's no pre-check.
  - `readDefaultBranch` (`:952-958`) and `conventionWorkBranch` exist to reuse.
  - `scripts/worktree-lifecycle.sh`: create (`:79-102`) writes the `.rad-worktree.json` marker; remove, preserve and list follow; exit codes are 0/1/2.
- **#61, test impact.** About 40 test call sites assume unisolated deliver, through five choke points:
  - `cli.test.js` `runDeliverCaptured` (`:553-570`)
  - `worktree.test.js` `runDeliver` (`:203-206`)
  - direct `deliverCommand` calls in `deliver.test.js` (`:125`, `:170`, `:213`) and `agent-adapters.test.js` (`:761`, `:790`, `:857`)
  - `harness/evals/lib/fixture.js` `deliver` (`:131-136`), the single path for all 16 eval deliver calls
- **#61, scope.** The `/rad-deliver` **skill** runs its wave sub-agents in the checkout it's invoked from and never uses `RAD_WORKTREE`. This change affects the `rad deliver` CLI only.
- **#94.**
  - `rad-research.md` steps: slug (`:148`), write artifact (`:157`), summary (`:223`), template header (`:180-184`, `Status:` at `:183`).
  - Neither `rad-plan.md` nor `rad-adopt.md` reads research artifacts today; only `rad-design` does.
  - `.agents/research/` holds 8 artifacts, none with a `Disposition:` header.
  - Header-block parsing to copy: `scripts/lib/plan-paths.sh` `plan_tier` (`:547-560`). Script conventions to copy: `check-approval-blockers.sh:1-40`.

**Architect decisions (2026-09-30):**
- **#61, flip now with a clear note.** Isolation is on unless `RAD_WORKTREE=0`. A failed worktree creation fails the run and never falls back to the main checkout.
- **#61, branch already checked out.** When the main tree has the work branch checked out: if it's **clean**, switch it to the default branch (and say so), then continue; if it's **dirty**, refuse with the exact commands. It never stashes or discards.
- **#61, scope.** CLI only. The skill path is unchanged and documented as such.
- **#94.** As specified: fail-open toward `actionable`, non-actionable needs a citation, and the operator override is always available and recorded.

## Scope

| In scope | Out of scope |
|---|---|
| `rad deliver` isolates by default; `RAD_WORKTREE=0` opts out | Worktree isolation for the `/rad-deliver` **skill** path |
| Clean-switch / dirty-refuse when the work branch is checked out in the main tree | Stashing or discarding operator changes |
| Preserve-on-failure prints the tree path + a one-command cleanup | Changing the lifecycle, marker or teardown guard |
| Test choke points pinned to `RAD_WORKTREE=0`; new worktree default tests + an isolation eval | Concurrent deliver runs |
| `Disposition:` header + refutation step in `/rad-research` | Surfacing disposition in `rad-status.sh` |
| `scripts/check-disposition.sh` (fail-open, citation-required, override) | Any change to Gate 1 or approval authority |
| `/rad-plan` + `/rad-adopt` consume the check when a research artifact exists, and record overrides | Refuting requests that have no research artifact |

## Acceptance Criteria

1. `rad deliver` runs in a worktree unless `RAD_WORKTREE` is exactly `0`: unset, empty or any other value means on. A single helper, `worktreeEnabled(env)`, backs both read sites (`setupWorktreeRun` / `setupMainRun` and `readResumeHistory`). `RAD_WORKTREE_DIR` keeps its meaning.
2. Before creating the worktree, when the main checkout has the work branch checked out:
   - **Clean** (no tracked changes): run `git checkout <default-branch>` in the main tree, print `rad deliver: switched the main checkout from <branch> to <default> so the worktree can use <branch>`, and continue.
   - **Dirty:** exit **2** before any event, printing the exact commands (`commit or stash your changes`, then `git checkout <default>`). Nothing is stashed, discarded or switched.
   - **Checked out in another worktree:** exit 2, pointing to `git worktree list`.
   - **Worktree creation fails for any other reason:** exit 1 as today. It **never** falls back to the main checkout.
3. When a run's worktree is preserved (failure or stop), `rad deliver` prints the preserved path and a one-line cleanup command that the lifecycle script actually accepts for a preserved tree. The implementer confirms `remove` works on a preserved marker, or uses the command that does.
4. The existing tests keep their meaning. The five choke points (`runDeliverCaptured`, `worktree.test.js` `runDeliver`, the direct `deliverCommand` calls in `deliver.test.js` and `agent-adapters.test.js`, and the eval fixture's `deliver`) default to `RAD_WORKTREE=0` unless a test explicitly sets it. New `worktree.test.js` tests cover:
   - unset → isolated
   - `'0'` → unisolated
   - `''` → isolated
   - main tree on the work branch and clean → switch + isolated run
   - dirty → exit 2, no events, branch unchanged
   - branch in another worktree → exit 2
4b. Every existing harness test and eval passes unchanged in intent.
5. The eval `deliver-isolated-by-default` in `harness/evals/delivery.eval.js` does the following:
   - **Setup:** a real-git fixture with `RAD_WORKTREE` explicitly empty (the default), where the main checkout starts on the work branch (clean).
   - **Assertions:** the run succeeds, the adversary's commit lands on the work branch, and the main checkout's working tree is **untouched** (no `src/feature.txt` there). The main checkout ends on the default branch.
   - **Mutation:** the fixture's `cli.js` treats unset as off.
6. `docs/invariants.yaml` adds `deliver-runs-isolated`, anchored to `worktreeEnabled` and the clean-switch/dirty-refuse logic, with `evals: [harness/evals/delivery.eval.js]` and a bypass `{ id: worktree-opt-out, surface: "RAD_WORKTREE=0", guarded: "no", note: "operator opt-out for environments where worktrees are impractical" }`. `scripts/lint-invariants.sh` passes.
7. `scripts/check-disposition.sh <research-artifact> [--override "<reason>"]` reads `Disposition:` and `Disposition-Evidence:` from the artifact's header block (before the first `## `). Outcomes:

   | Artifact state | Exit | Output |
   |---|---|---|
   | missing or empty header | 0 | `actionable` |
   | unknown value | 0 | `actionable` + `warning:` naming the value |
   | `actionable` | 0 | `actionable` |
   | `not-actionable` / `insufficient-context` / `superseded` with no evidence | 0 | `actionable` + `warning: uncited <disposition> — treated as actionable` |
   | cited non-actionable | **1** | the disposition, the evidence, and the override instruction |
   | cited non-actionable, with `--override` | 0 | `overridden: <disposition> (<evidence>) — <reason>` |
   | unreadable or missing file, empty override reason, bad arguments | 2 | usage or reason |

   A malformed-header read error is reported, never silent. It passes the shell-safety lint and runs on bash 3.2.
8. `scripts/test-check-disposition.sh` (both shells) covers every AC#7 row, including CRLF headers and a `Disposition:` line below the header block (ignored).
9. `/rad-research` gains a refutation step between the slug and writing the artifact. Its only job is to try to establish a non-`actionable` disposition, **citing a concrete artifact** (file:line, a test name, or an existing plan path):
   - `insufficient-context` lists exactly what's missing.
   - `superseded` names the covering plan or feature.
   - Absence of evidence means `actionable`.

   The template gains `Disposition:` and `Disposition-Evidence:` headers. On a non-actionable disposition, Step 6 omits the next-command hints and shows the override command instead.
10. When `.agents/research/<slug>.md` exists for the request, `/rad-plan` and `/rad-adopt` run `scripts/check-disposition.sh` on it before researching.
    - **Exit 1:** stop and show the disposition, the evidence and the override syntax (`--override-disposition "<reason>"`).
    - **With the override:** pass it through, and record `Disposition-Override: <disposition> — <reason>` in the generated plan's header block.
    - **No artifact:** no check.
    - **Unattended runs:** the refusal is a stop; nothing waits for input.
11. The docs are updated:
    - **CLAUDE.md "Worktree Isolation":** default-on, the `RAD_WORKTREE=0` opt-out, the clean-switch/dirty-refuse behavior, no fallback, and the skill path unchanged. The breaking default is stated plainly.
    - **`docs/rad-cli.md` worktree section:** the same.
    - **`docs/daily-workflow.md`:** research (disposition + refutation), planning and adopting (the check + override), and executing (the isolation default).
12. Every suite stays green: harness tests, evals, every shell test under both shells, `lint-shell-safety`, `lint-invariants`.

## Agent Scope

An `Explore` agent (general, read-only) mapped:
- the CLI worktree read sites and setup flow
- the lifecycle script
- every test choke point that assumes unisolated deliver
- the docs describing opt-in
- the research, plan and adopt skill step layouts
- the existing research artifacts
- the header-parsing and script conventions

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | 690-760 | `worktreeEnabled`; clean-switch / dirty-refuse pre-check in `prepareWorktreeRoot`; preserved-tree pointer |
| harness/cli.js | 780-790 | `readResumeHistory` uses `worktreeEnabled` |
| harness/cli.js | 1098-1112 | Setup switch uses `worktreeEnabled`; comment rewritten |
| harness/cli.js | 1155-1180 | Preserve paths print the cleanup pointer |
| harness/test/worktree.test.js | 200-210 | `runDeliver` sets `'0'` for mode-off |
| harness/test/worktree.test.js | 360-430 | New default / switch / refuse tests (append) |
| harness/test/cli.test.js | 553-570 | `runDeliverCaptured` defaults `RAD_WORKTREE: '0'` |
| harness/test/deliver.test.js | 120-220 | Direct calls pin `RAD_WORKTREE: '0'` |
| harness/test/agent-adapters.test.js | 755-865 | Direct calls pin `RAD_WORKTREE: '0'` |
| harness/evals/lib/fixture.js | 125-140 | `deliver` defaults `RAD_WORKTREE: '0'` unless the caller sets it |
| harness/evals/delivery.eval.js | 140-200 | `deliver-isolated-by-default` case (append) |
| docs/invariants.yaml | 100-200 | `deliver-runs-isolated` entry |
| scripts/check-disposition.sh | 1-110 | New: AC#7 |
| scripts/test-check-disposition.sh | 1-150 | New: AC#8 |
| .claude/commands/team/rad-research.md | 148-240 | Refutation step; template headers; Step 6 |
| .claude/commands/team/rad-plan.md | 18-50 | Disposition check + override |
| .claude/commands/team/rad-adopt.md | 14-45 | Disposition check + override |
| CLAUDE.md | 249-272 | Worktree Isolation: default-on |
| docs/rad-cli.md | 386-452 | Worktree section: default-on |
| docs/daily-workflow.md | 47-55 | Research: disposition |
| docs/daily-workflow.md | 86-155 | Planning and adopting: the check + override |
| docs/daily-workflow.md | 192-215 | Executing: the isolation default |

## Program Design

### 1. Worktree default (`harness/cli.js`)

```js
export function worktreeEnabled(env = process.env) { return env.RAD_WORKTREE !== '0'; }
// prepareWorktreeRoot, before makeWorktreeLifecycle(...).create:
//   head = git -C repoRoot rev-parse --abbrev-ref HEAD
//   if head === workBranch:
//     dirty = git -C repoRoot status --porcelain --untracked-files=no  (non-empty)
//     dirty  → stderr: exact commands; return exit 2 (before any event)
//     clean  → git -C repoRoot checkout <readDefaultBranch()>; stderr notice
//   if workBranch is checked out in another worktree (git worktree list --porcelain) → exit 2 with pointer
```

### 2. Disposition (`scripts/check-disposition.sh`)

```
header block = lines before the first '## ' (CR stripped)
d = Disposition:  (trimmed, lowercased)      e = Disposition-Evidence: (trimmed)
d ∉ {actionable, not-actionable, insufficient-context, superseded} → warn if non-empty; actionable, exit 0
d == actionable                                     → exit 0
e empty                                             → warn uncited; actionable, exit 0
--override "<reason>" (non-empty)                   → "overridden: d (e) — reason", exit 0
otherwise                                           → print d, e, override syntax; exit 1
```

## Execution Notes

### Do Not Touch
- scripts/worktree-lifecycle.sh (use it as is; if AC#3 needs a lifecycle change, stop and report)
- The `/rad-deliver` skill (`.claude/commands/team/rad-deliver.md`); harness/spine.js, gates.js
- .agents/research/* (existing artifacts must stay valid unchanged)

### Key Files
- harness/cli.js — `prepareWorktreeRoot` (707-726), `setupWorktreeRun` (740-759), setup switch (1100-1110), preserve / complete (1155-1180), `readDefaultBranch` (952-958); harness/adapters/worktree.js (19)
- harness/test/worktree.test.js — `makeFakeSh` (21), `makeDeliverSh` (172), `runDeliver` (203); harness/evals/lib/fixture.js — `hermeticEnv` (78), `deliver` (131)
- .claude/commands/team/rad-research.md (148-240); rad-plan.md (18-50); rad-adopt.md (14-45)
- scripts/lib/plan-paths.sh `plan_tier` (547-560); scripts/check-approval-blockers.sh (1-40)

### Reminders
- **Breaking default, on purpose.** Say so in CLAUDE.md, the docs and the PR. Existing tests pin `RAD_WORKTREE=0` at their choke points, so they keep testing what they tested.
- **Never touch operator work.** The clean-switch only runs on a tree with no tracked changes. A dirty tree is refused, never stashed.
- **Fail-open for disposition.** Missing, unknown or uncited always means `actionable`. The override is always available and always recorded.
- **Shell-safety lint and portability** (bash 3.2, BSD tools) for the new script.
- **Long final checks** exceed the 2-minute foreground timeout. Run them with `run_in_background`.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (disjoint files).

#### Task 1.1: Worktree default + checked-out resolution
File: harness/cli.js:690-760, 780-790, 1098-1112, 1155-1180, harness/test/worktree.test.js:200-210, 360-430, harness/test/cli.test.js:553-570, harness/test/deliver.test.js:120-220, harness/test/agent-adapters.test.js:755-865, harness/evals/lib/fixture.js:125-140
What: Implement AC#1-4 per Program Design §1, and pin the five test choke points to `RAD_WORKTREE=0`.
Validate: AC#1, AC#2, AC#3, AC#4 — `npm test --prefix harness` passes; `node --test harness/evals/*.eval.js` passes (unchanged counts plus skips).

#### Task 1.2: Disposition check script
File: scripts/check-disposition.sh:1-110, scripts/test-check-disposition.sh:1-150
What: Implement AC#7 and AC#8 per Program Design §2, following the `check-approval-blockers.sh` conventions.
Validate: AC#7, AC#8 — `bash scripts/test-check-disposition.sh && /bin/bash scripts/test-check-disposition.sh` (ALL PASS); `scripts/lint-shell-safety.sh` shows no `✗`; each of the 8 existing `.agents/research/*.md` artifacts exits 0 (`actionable`).

### Wave 2 — parallel
Tasks in this wave can run in parallel (disjoint files). They depend on Wave 1.

#### Task 2.1: Isolation eval + registry
File: harness/evals/delivery.eval.js:140-200, docs/invariants.yaml:100-200
What: Implement AC#5 and AC#6.
Validate: AC#5, AC#6 — `node --test harness/evals/delivery.eval.js` (including `[mutated]`); `scripts/lint-invariants.sh` exits 0.

#### Task 2.2: Research, plan and adopt skills
File: .claude/commands/team/rad-research.md:148-240, .claude/commands/team/rad-plan.md:18-50, .claude/commands/team/rad-adopt.md:14-45
What: Implement AC#9 and AC#10.
Validate: AC#9, AC#10 — no testable surface (skill prose). `grep -n "check-disposition.sh\|Disposition-Override\|override-disposition" .claude/commands/team/rad-plan.md .claude/commands/team/rad-adopt.md` and `grep -n "Disposition:\|Disposition-Evidence:" .claude/commands/team/rad-research.md` are all non-empty.

#### Task 2.3: Docs
File: CLAUDE.md:249-272, docs/rad-cli.md:386-452, docs/daily-workflow.md:47-55, 86-155, 192-215
What: Implement AC#11.
Validate: AC#11, AC#12 — the docs describe default-on and the disposition flow. Then the full suite (harness, evals, every shell test under both shells, the shell-safety lint and `lint-invariants`).

## Tests to Write
- [ ] Worktree default, clean-switch, dirty-refuse — harness/test/worktree.test.js
- [ ] Disposition check — scripts/test-check-disposition.sh
- [ ] deliver-isolated-by-default eval — harness/evals/delivery.eval.js

## Non-Goals
- Worktree isolation for the `/rad-deliver` skill path, which needs its own plan (every wave sub-agent working in another directory).
- Concurrent deliver runs.
- Refuting requests that have no research artifact, or surfacing disposition in `rad-status.sh`.
- Any change to Gate 1, approval authority, or the worktree lifecycle and teardown guard.

## Out-of-Scope Dependencies
None. All paths are architect-owned, and the author is the architect.

## Risks
- **Breaking default.** Anyone running `rad deliver` unisolated gets a worktree. The CLI path only recently started working end to end, the opt-out is one env var, and the change is announced in CLAUDE.md and the PR.
- **The main checkout switches branch.** It does so only when clean and only when it's on the work branch, and it says so. Operators with uncommitted work are refused, never touched.
- **Disposition false refusals.** The citation is required, a refusal is never a lock (the override is always available), and it's fail-open everywhere else.
- **Test churn.** About 40 call sites are handled at 5 choke points; no per-test edits are expected.
- **Self-protected paths:** `harness/`, `scripts/` and `.claude/` trigger advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — flip now.** Default-on, `RAD_WORKTREE=0` opts out, no fallback on create failure. Architect decision, 2026-09-30.
- **ASSUMPTION — clean-switch / dirty-refuse.** Architect decision, 2026-09-30.
- **ASSUMPTION — CLI only.** The skill path is unchanged. Architect decision, 2026-09-30.
- **ASSUMPTION — `RAD_WORKTREE` value semantics.** Only the exact string `0` opts out. Any other value, including empty, means on, so a typo can't silently disable isolation.
- **ASSUMPTION — a single evidence field.** `Disposition-Evidence:` carries the citation for `not-actionable`, the missing-items list for `insufficient-context`, and the covering plan for `superseded`.
- **ASSUMPTION — override recording.** It's recorded in the generated plan's header (`Disposition-Override:`), where Gate 1 review sees it. The research artifact isn't edited.
