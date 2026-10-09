# Plan: Give rad Worktrees the Main Checkout's harness/node_modules (#232)
Created: 2026-10-09
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-09T16:52:32.574Z
Recorded-By: sean@torchcodelab.com
Branch: rad/worktree-node-modules
Issue: 232
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/232
Issue-Title: Fresh rad worktrees have no harness/node_modules, so SDK-importing tests fail to load

## Context
`rad deliver` runs every wave in an isolated git worktree created by `scripts/worktree-lifecycle.sh create`. `harness/node_modules` is gitignored, so a fresh worktree has none, and any harness test that imports an npm dependency (`@anthropic-ai/claude-agent-sdk`, through harness/adapters/agent/sdk.js) fails to load there with `ERR_MODULE_NOT_FOUND`. Two test files are affected: `harness/test/agent-adapters.test.js` and `harness/test/cost.test.js`. They pass in the main checkout.

This blocked the final full-verification wave of `playbook-skills` (#50 part 2): every other check passed, and the run stopped before opening a PR. So the #229 approach, a verification wave inside the run, can't work in worktree mode (the default) until this is fixed.

Two details shape the fix:
- **A symlink is not matched by `node_modules/`.** `harness/.gitignore` currently reads `node_modules/` (trailing slash), which matches directories only. A symlinked `node_modules` would show as an untracked file, make `git status` noisy, risk being committed by a stray `git add -A`, and block the non-forced `git worktree remove`, which is the #218 class of failure.
- **`harness/evals/repo.eval.js` mutates the script by patching one line.** The eval `remove-unmarked-worktree` replaces `  marker_valid "$dir" "$feature" \` (the safety interlock in `cmd_remove`) with `  true \`. The lines must stay byte-identical, or that eval's mutated twin fails the way the capabilities eval did in #227.

## Scope
| In scope | Out of scope |
|---|---|
| `worktree-lifecycle.sh create` symlinks the main checkout's `harness/node_modules` into the new worktree | Installing dependencies (`npm ci`) in worktrees |
| `worktree-lifecycle.sh remove` clears the symlink it created; `preserve` keeps it | Linking any other directory |
| `harness/.gitignore`: ignore `node_modules` without the trailing slash | Changing the adapter (harness/adapters/worktree.js) or `rad deliver` |
| A new co-located test script with real git | |
| Docs in rad-cli.md | |

## Acceptance Criteria
1. **`create` links the dependencies.** After `git worktree add` and writing the marker, `cmd_create`:
   - finds the **main** worktree (the first entry of `git worktree list --porcelain`), so it works whether the script is run from the main checkout or from a worktree;
   - when `<main>/harness/node_modules` exists as a directory, and `<dir>/harness/node_modules` does not exist, creates the symlink `<dir>/harness/node_modules` → `<main>/harness/node_modules` (an absolute target, via `ln -s`);
   - when the source is missing, creates nothing, prints one line to stderr (`note: <main>/harness/node_modules not found; npm-dependent tests will not load in the worktree`), and still exits 0;
   - never replaces anything that already exists at the destination, and never copies;
   - keeps the resolved worktree dir as the last stdout line, so the adapter still parses it. Paths with spaces work.
2. **`remove` cleans up the link.** In `cmd_remove`, after the marker check has passed and after the marker is deleted, if `<dir>/harness/node_modules` is a **symlink**, `rm -f` it (never `rm -r`, and never a real directory), then `git worktree remove "$dir"` runs without `--force`. The interlock lines (`  marker_valid "$dir" "$feature" \` and its continuation) are byte-identical to today.
3. **`preserve` is unchanged.** A preserved worktree keeps its link, so tests still run when someone inspects it.
4. **The ignore rule.** `harness/.gitignore` ignores `node_modules` (no trailing slash), so both a real directory and a symlink are ignored. `git check-ignore harness/node_modules` succeeds for each, and `git add -A` in a worktree never stages the link.
5. **The test script.** The new `scripts/test-worktree-lifecycle.sh` (plain bash 3.2-compatible, real git in a temp repo, with a temp `harness/.gitignore` containing `node_modules`) covers:
   - `create` with the source present: the symlink exists and points at the main checkout's directory; `git status --porcelain` in the worktree shows nothing for it; `git add -A` stages nothing for it;
   - `create` with no source: no link, exit 0, the stderr note;
   - `create` where the worktree already has a real `harness/node_modules`: left alone;
   - a path containing a space;
   - `remove` after a linked `create`: exit 0, the worktree is gone, the main checkout's `node_modules` and its contents are intact (the target is not deleted), and no `--force` was used;
   - `remove` refuses an unmarked directory (the existing interlock behavior);
   - `preserve` keeps the link and rewrites the marker status;
   - `create` run from inside a worktree still links from the main checkout.
6. **Existing checks.** `node --test harness/test/worktree.test.js` and `node --test harness/evals/repo.eval.js` pass unchanged, including `remove-unmarked-worktree` and its mutated twin, and the shell-safety and bash 3.2 lints cover the script. No existing assertion changes.
7. **Docs.** docs/rad-cli.md's worktree lifecycle section notes that `create` links `harness/node_modules` from the main checkout (and why: gitignored dependencies, SDK-importing tests), that `remove` deletes only that symlink, that `preserve` keeps it, and what the stderr note means when the source is absent.

## Agent Scope
Research came from reading `scripts/worktree-lifecycle.sh` (create, remove, marker handling), the adapter tests (which use a fake `sh`) and the repo eval (which exercises the real script), `harness/.gitignore`, the failing verification wave's report, and the docs section on the lifecycle. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/worktree-lifecycle.sh | 15-60 | Constants and the main-worktree helper |
| scripts/worktree-lifecycle.sh | 79-125 | `cmd_create` link; `cmd_remove` cleanup |
| harness/.gitignore | 1-3 | `node_modules` without the trailing slash |
| scripts/test-worktree-lifecycle.sh | 1-1 | New (AC#5) |
| harness/evals/repo.eval.js | 55-80 | Read only: the mutation anchor to preserve |
| harness/adapters/worktree.js | 1-60 | Read only: how the adapter parses the output |
| docs/rad-cli.md | 1088-1125 | Worktree lifecycle |

## Execution Notes

### Do Not Touch
- The interlock lines in `cmd_remove`: `  marker_valid "$dir" "$feature" \` and the line after it (a mutation anchor in harness/evals/repo.eval.js)
- harness/adapters/worktree.js, harness/cli.js, `cmd_preserve`'s marker rewrite
- Any other `.gitignore`

### Key Files
- scripts/worktree-lifecycle.sh: `resolve_dir` (~56-69), `marker_valid` (~72-77), `cmd_create` (~79-102), `cmd_remove` (~104-121), `cmd_preserve` (~123-140)
- harness/evals/repo.eval.js: the `remove-unmarked-worktree` case and its `mutate` patch (~62-77)
- scripts/test-check-tests-present.sh and scripts/test-open-pr.sh: the style of the repo's bash test scripts (temp dirs, `fail`, bash 3.2)

### Reminders
- **This plan's own worktree is created by the *old* script,** so it has no `node_modules`, and `agent-adapters.test.js` and `cost.test.js` cannot load inside this run. Waves therefore validate with targeted checks only. The full suites, evals and lints are run afterwards from the main checkout, where they load.
- **Bash 3.2 compatibility:** no associative arrays and no `mapfile`; quote every path.
- **Never `rm -r` or follow the link.** Cleanup removes a symlink and nothing else.
- **Keep the interlock lines byte-identical.**
- **Fail closed where it matters:** `remove` keeps refusing without a valid marker. A missing source for the link is a note, never an error.

## Program Design
```
cmd_create: git worktree add → write marker → link_deps(dir)
  link_deps: main = first path of `git worktree list --porcelain`
             src = main/harness/node_modules ; dst = dir/harness/node_modules
             src is a dir && dst absent → ln -s src dst ; src absent → stderr note
cmd_remove: interlock (unchanged) → rm -f marker → [ -L dst ] && rm -f dst → git worktree remove (no --force)
cmd_preserve: unchanged
harness/.gitignore: node_modules   (was node_modules/)
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: Link and clean up node_modules, with its test
File: scripts/worktree-lifecycle.sh:15-60, scripts/worktree-lifecycle.sh:79-125, harness/.gitignore:1-3, scripts/test-worktree-lifecycle.sh:1-1
What: Write AC#1 to AC#5 and AC#6. Edit the script and the `.gitignore`, keeping the interlock lines unchanged, and write the new bash test script.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#6 — `bash scripts/test-worktree-lifecycle.sh` passes; `node --test harness/evals/repo.eval.js harness/test/worktree.test.js` passes; `bash -n scripts/worktree-lifecycle.sh scripts/test-worktree-lifecycle.sh` is clean; edge cases covered: no source, an existing destination, a path with a space, removal from inside a worktree, and the target left intact

### Wave 2 — sequential

#### Task 2.1: Docs
File: docs/rad-cli.md:1088-1125
What: Write AC#7.
Validate: AC#7 — `grep -n 'node_modules' docs/rad-cli.md` matches in the worktree lifecycle section; docs only

## Tests to Write
- [ ] worktree lifecycle with real git: link on create, clean remove, preserve, missing source, existing destination, path with a space — scripts/test-worktree-lifecycle.sh

## Non-Goals
- Running `npm ci` in worktrees, or linking any directory other than `harness/node_modules`.
- Changing the adapter or `rad deliver`.
- Making verification waves mandatory (#229).

## Out-of-Scope Dependencies
None

## Risks
- **A shared `node_modules` means worktree runs use the main checkout's installed packages.** That's the same set that CI and a local run use today, and the worktree's own `package.json` isn't consulted; the symlink is only as current as the main checkout's install. It's read-only in practice, since tests don't write to it.
- **`ln -s` fails on filesystems without symlink support.** The step is best effort: a failure prints the note and `create` still succeeds.
- **The `.gitignore` change affects `harness/` only,** where `node_modules` is already ignored; it now also ignores a file or symlink of that name.
- **Self-protected paths** (`scripts/`, `harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — only `harness/node_modules` is linked,** since it's the only dependency tree in this repo (the root has none). A list constant makes adding more a one-line change.
- **Assumption — a missing source is a note, not an error,** because installed projects may not have installed the harness's optional SDK dependency.
- **Assumption — `preserve` keeps the link,** so a kept worktree stays runnable for inspection.
