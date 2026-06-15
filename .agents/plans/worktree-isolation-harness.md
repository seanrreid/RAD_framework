# Plan: Worktree Isolation for the Deliver Spine
Created: 2026-06-12
Author: architect
Status: complete
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-12T13:42:41.192Z
Completed-At: 2026-06-12T13:58:00Z
Branch: rad/worktree-isolation-harness

## Context
`deliverSpine` (`harness/spine.js`) is pure control flow over injected ports
(`runWave`, `sh`, `now`, `state`); `deliverCommand` (`harness/cli.js`) constructs
those ports and binds `sh` to the repo root, so every deliver runs in the main
checkout. There is no isolation boundary for unattended runs — an autonomous
deliver mutates the same working tree the operator is sitting in. This plan adds
an **opt-in git-worktree isolation path**: when enabled, a deliver runs inside a
dedicated, marker-tracked worktree that is removed on success and preserved on
failure for investigation. Disabled (the default), behavior is identical to today.

## Scope
| In scope | Out of scope |
|---|---|
| A `scripts/worktree-lifecycle.sh` primitive (create / remove / preserve / list) keyed on a `.rad-worktree.json` marker | Any `/rad-cleanup` slash command or other Claude-specific command surface |
| An injectable `harness/adapters/worktree.js` lifecycle port wrapping the script via `sh` | CI-green completion polling (separate later plan) |
| Wiring in `deliverCommand` (`harness/cli.js`): create pre-spine, rebind `sh` cwd to the worktree, complete/preserve post-spine off the terminal result | Wall-clock / turn-count kill switch (dropped) |
| `RAD_WORKTREE` env knob + docs | Parallel-delivery orchestration, cross-worktree dependency sharing, container/VM isolation |

## Acceptance Criteria
1. With worktree isolation disabled (`RAD_WORKTREE` unset/empty), `rad deliver`
   runs in the main checkout with behavior identical to today — no worktree is
   created and no marker is written.
2. With worktree isolation enabled, a deliver executes inside a dedicated git
   worktree marked by a `.rad-worktree.json` file at its root, and every wave /
   test / scope / PR script runs with cwd inside that worktree.
3. On a successful deliver (spine returns `ok: true`), the managed worktree is
   removed.
4. On a failed or stopped deliver (spine returns a `stopped:` terminal), the
   managed worktree is preserved with its marker intact.
5. The lifecycle refuses to remove any directory that lacks a valid
   `.rad-worktree.json` marker — the main checkout and non-RAD worktrees can
   never be deleted by this path.
6. The worktree lifecycle and both deliver paths (enabled/disabled, success/fail)
   are exercised by unit tests using injected fakes — no real git.

## Agent Scope
Architect scope over `harness/`, `scripts/`, and `docs/` (this repo self-hosts
RAD; the Agent Scope Map in CLAUDE.md is unpopulated). No out-of-scope agents
required.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/worktree-lifecycle.sh | 1-95 | New. Subcommands `create`/`remove`/`preserve`/`list`; writes & validates the `.rad-worktree.json` marker; refuses to remove an unmarked dir. |
| harness/adapters/worktree.js | 1-75 | New. `makeWorktreeLifecycle({ sh, now })` factory returning `{ create, complete, preserve }`, wrapping the script via the `sh` boundary. Injectable like the other ports. |
| harness/cli.js | 290-410 | Detect `RAD_WORKTREE` in `deliverCommand`; when set, create the worktree pre-spine, rebind the `sh` cwd to the worktree path, and after the spine returns, `complete` on success / `preserve` on any terminal stop. Unset → unchanged. |
| harness/test/worktree.test.js | 1-160 | New. Adapter unit tests + `deliverCommand` worktree-path coverage, all with fake `sh`/`state`. |
| docs/rad-cli.md | 40 | Document the `RAD_WORKTREE` knob, the lifecycle, marker semantics, and preserve-on-failure investigation. |
| CLAUDE.md | 20 | Add the `RAD_WORKTREE` knob to the RAD Configuration section alongside `RAD_AGENT` / `RAD_TOKEN_BUDGET`. |

## Execution Notes

### Do Not Touch
- `harness/spine.js` — the spine stays pure; isolation is orchestrated around it
  in `deliverCommand`, not inside it. The terminal result it already returns
  (`ok` vs `stopped:`) is the complete/preserve signal.
- `scripts/check-tests.sh`, `scripts/check-scope.sh` — gates run *inside* the
  worktree env unchanged; the checkout model is transparent to them.
- `harness/adapters/agent/` — `runWave` signature is unchanged; worktrees are
  invisible to agent adapters.
- `docs/rad-wave-contract.md` — the wave contract is independent of checkout
  isolation.

### Key Files
- `harness/cli.js` (~290-410) — `deliverCommand` constructs ports and binds `sh`
  with `cwd=repoRoot` (~line 405); this is the single integration point.
- `harness/spine.js` (1-70) — the port-injection contract to mirror, and the
  terminal-result shape (`ok` / `stopped:`) the cleanup decision keys off.
- `harness/adapters/git-state-store.js` (50-100) — `defaultSh` cwd-passing helper
  and `isSafeFeature()` (`/^[a-z0-9][a-z0-9-]*$/`); the worktree dir name must
  respect that constraint.
- `harness/test/spine.test.js` (1-100) — the `makeFakeState` + fake-`sh`
  injection pattern the new tests follow.

### Reminders
- The `.rad-worktree.json` marker stays **local and uncommitted** — it records
  execution-environment state, never delivery outcomes (those live in the event
  log). Ensure the marker path is gitignored or written outside tracked paths.
- Worktree dir name derives from the (already-validated) feature slug; do not
  build paths from unvalidated input.
- `RAD_WORKTREE` follows the existing env-knob convention: unset/empty = off,
  fully backward-compatible. Optional `RAD_WORKTREE_DIR` sets the base directory
  (default: a sibling `../<repo>-rad-worktrees/<feature>`), never nested inside
  the tracked working tree.
- Cleanup must run for *every* spine terminal, including `stopped:` paths — wire
  it off the returned object, not a try/catch around the spine.

## Wave Plan

### Wave 1 — sequential
Tasks must run in sequence (the port wraps the script).

#### Task 1.1: Worktree lifecycle script
File: scripts/worktree-lifecycle.sh:1-95
What: New executable with subcommands. `create <feature> <branch> [dir]` →
`git worktree add` the dir on the branch and write `.rad-worktree.json`
(`{ feature, branch, createdAt, status: "active" }`). `remove <feature> [dir]` →
require a valid marker, then `git worktree remove`; exit non-zero and touch
nothing if the marker is missing/invalid. `preserve <feature> [dir]` → leave the
worktree, update marker `status: "preserved"`. `list` → print marker-bearing
worktrees. Feature name validated to `/^[a-z0-9][a-z0-9-]*$/`.
Validate: AC#2 — marker is written on create; AC#5 — `remove` refuses an unmarked dir.

#### Task 1.2: Injectable lifecycle port
File: harness/adapters/worktree.js:1-75
What: `makeWorktreeLifecycle({ sh, now })` returning `{ create(feature, branch),
complete(feature), preserve(feature) }`. Each wraps `scripts/worktree-lifecycle.sh`
via the injected `sh` boundary (so it is deterministic and unit-testable);
`create` returns the worktree path, `complete` calls `remove`, `preserve` calls
`preserve`. No direct git or fs calls in this module.
Validate: AC#3 — `complete` invokes `remove`; AC#4 — `preserve` invokes `preserve`.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Wire isolation into deliverCommand
File: harness/cli.js:290-410
What: In `deliverCommand`, read `RAD_WORKTREE` (and optional `RAD_WORKTREE_DIR`).
When unset/empty, leave the current main-checkout path untouched. When set:
construct the lifecycle port, `create` the worktree before calling `deliverSpine`,
rebind the `sh` port so its cwd is the worktree path, run the spine, and on its
return call `complete` when `result.ok === true` else `preserve` (for any
`stopped:` terminal). Surface the preserved path in the command output.
Validate: AC#1 — unset is a no-op; AC#2 — scripts run with worktree cwd; AC#3/AC#4 — success removes, stop preserves.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Lifecycle + deliver-path tests
File: harness/test/worktree.test.js:1-160
What: Using fake `sh`/`state` (per `spine.test.js`): adapter tests that `create`
writes the marker and returns the path, `complete` issues `remove`, `preserve`
issues `preserve`, and `remove` refuses when the fake reports no marker; plus
`deliverCommand` tests that mode-on + `ok` calls `complete`, mode-on + `stopped`
calls `preserve`, and mode-off calls neither and binds `sh` to repo root.
Validate: AC#5 — unmarked remove refused; AC#6 — all paths covered with fakes; AC#1 — mode-off parity.

#### Task 3.2: Document the knob
File: docs/rad-cli.md:40, CLAUDE.md:20
What: Document `RAD_WORKTREE` (and `RAD_WORKTREE_DIR`) in `docs/rad-cli.md`
alongside `RAD_AGENT`/`RAD_TOKEN_BUDGET` — the lifecycle, the `.rad-worktree.json`
marker, preserve-on-failure for investigation, and that it is opt-in/off by
default. Add the knob to the CLAUDE.md RAD Configuration section.
Validate: AC#1 — docs state the default-off, backward-compatible behavior.

## Tests to Write
- [ ] `create` writes a valid `.rad-worktree.json` and returns the worktree path — harness/test/worktree.test.js
- [ ] `complete` issues `remove`; `preserve` issues `preserve` — harness/test/worktree.test.js
- [ ] `remove` refuses (non-zero, no fs change) when the marker is absent — harness/test/worktree.test.js
- [ ] `deliverCommand` mode-on + spine `ok` → `complete` called; mode-on + `stopped` → `preserve` called — harness/test/worktree.test.js
- [ ] `deliverCommand` mode-off → no lifecycle calls, `sh` bound to repo root (parity) — harness/test/worktree.test.js

## Non-Goals
- No CI-green completion polling — that is a separate later plan.
- No wall-clock or turn-count kill switch — dropped; attempts + token budget
  already bound runaway work.
- No `/rad-cleanup` (or any) slash command — lifecycle lives in the harness, not
  a Claude command surface.
- No parallel-delivery orchestration, cross-worktree dependency sharing, or
  container/VM isolation — single-worktree filesystem isolation only.

## Out-of-Scope Dependencies
None.

## Risks
- **Stale worktrees on hard crash.** A process killed between `create` and the
  post-spine cleanup leaves a preserved-but-unrecorded worktree. Mitigation: the
  marker makes it discoverable via `list`; acceptable for an opt-in path.
- **cwd rebinding leakage.** If `sh` is rebound incorrectly, scripts could run
  against the main checkout. Mitigation: AC#2 + the mode-off parity test assert
  the cwd target explicitly.
- **Worktree path nesting.** Creating a worktree inside the tracked tree breaks
  git. Mitigation: default base dir is a sibling outside the working tree;
  documented and validated.
