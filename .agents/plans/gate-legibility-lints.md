# Plan: Gate Legibility Lints
Created: 2026-08-05
Author: architect
Status: complete
Completed-At: 2026-08-10T16:30:00Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-08-10T13:09:55.174Z
Recorded-By: sean@torchcodelab.com
Branch: rad/gate-legibility-lints
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/98, https://github.com/seanrreid/RAD_framework/issues/99, https://github.com/seanrreid/RAD_framework/issues/101
Issue-Title: Gate-legibility defects in RAD's deterministic lint/check scripts (#98, #99, #101)

## Context

Three defects found while delivering #91 (PR #100). Each is a deterministic check whose
output misleads the reader — the same family as #91 itself, which is why they are bundled
rather than shipped separately. Two of them edit `scripts/lint-plan.sh`, so splitting them
would guarantee a conflict.

- **#98** — `plan_cited_anchors` (`scripts/lib/plan-paths.sh:106`) extracts `path:NNN`
  tokens and qualifies any token containing `/` **or** ending in a known extension. Prose
  citing `` `spine.js:51-53` `` therefore yields the bare path `spine.js`, which is
  existence-checked at repo root against `origin/main`, fails, and warns
  "stale premise: spine.js not found". The file exists at `harness/spine.js`. A plan's own
  newly-created files produce the same false warning by construction.
- **#99** — `scripts/check-scope.sh:43-45` builds the declared-scope set with
  `awk -F'|' '{print $2}'` — the **File** column only. A `git mv` destination declared in
  the prose Change column is invisible, so every rename reports its own target as
  out-of-scope drift. Undocumented: nothing tells an author a rename needs two rows.
- **#101** — `scripts/test-check-scope.sh` is committed `100644`; every other script is
  `100755`. Invoked directly it exits 126. CI masks it (`ci.yml:44` uses `bash "$t"`), and
  `scripts/lint-shell-safety.sh:113` globs the filesystem rather than git, so committed
  modes are never inspected.

The shared cost is calibration. A check that cries wolf, or fails for a reason the author
cannot infer, trains people to wave it through — which is exactly when a real violation
slips past.

## Scope

| In scope | Out of scope |
|---|---|
| Bare-basename anchor resolution in the freshness check | Changing what counts as a stale premise, or its advisory severity |
| Suppressing the stale-premise duplicate for plan-created files | The `origin/<base>` comparison basis |
| Rename-aware violation message in `check-scope.sh` | Parsing the prose Change column for paths (guessing at NL inside a fail-closed gate) |
| Plan-time advisory when a rename target is undeclared | Making `check-scope.sh` permissive — it stays fail-closed |
| Documenting the two-row rename convention | Auditing file modes outside `scripts/` |
| Committed-mode check in `lint-shell-safety.sh` + fixing the one bad mode | How CI invokes the shell tests (`bash "$t"` is fine) |

## Acceptance Criteria

1. A plan citing `` `spine.js:51-53` `` in prose, with `harness/spine.js` declared in Files
   in Scope, produces **no** stale-premise warning.
2. A bare basename matching two or more tracked files produces no warning (ambiguous →
   silent), and a genuinely removed file still warns — the true-positive path is unchanged.
3. A path already reported by "File in scope does not exist" does not additionally produce a
   stale-premise warning. One finding per fact.
4. `scripts/check-scope.sh` still fails on an undeclared rename target, but its message
   identifies it as a likely rename target and names the deleted counterpart.
5. `scripts/lint-plan.sh` emits a plan-time advisory when a Files-in-Scope Change cell
   describes a rename whose destination path is not itself a declared row.
6. The two-row rename convention is documented in the plan template and in both `/rad-plan`
   and `/rad-adopt` authoring instructions.
7. `scripts/test-check-scope.sh` runs directly and exits 0.
8. `scripts/lint-shell-safety.sh` fails when a tracked executable script is committed
   `100644`, reading modes from the git index rather than the filesystem, and does not flag
   data files or `.sh.sample` fixtures.
9. All existing suites pass unchanged in count and outcome; a clean tree produces no new
   warnings from any of the three checks.

## Agent Scope

Research was performed **directly** (grep/read, 6 calls) rather than via `lint-surface-mapper`
or `ci-surface-mapper`, continuing the deviation recorded in the `check-tests-naming-honesty`
plan. No agents were called. No out-of-scope agent dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 89-130 | Bare-basename resolution helper used by the anchor set |
| scripts/lint-plan.sh | 209-235 | Consume resolved anchors; suppress stale-premise duplicate for plan-created paths |
| scripts/lint-plan.sh | 155-180 | New advisory: undeclared rename destination in a Change cell |
| scripts/check-scope.sh | 81-120 | Rename-aware violation message via `git diff --find-renames` |
| scripts/lint-shell-safety.sh | 105-150 | Committed-mode check over tracked scripts |
| scripts/lint-shell-safety-baseline.txt | 1-5 | Documentation comment only if the mode check needs a baseline entry |
| scripts/test-check-scope.sh | 1-1 | Fix committed mode to 100755; add rename cases |
| scripts/test-plan-paths.sh | new cases | Bare-basename resolution cases |
| scripts/test-lint-plan.sh | new cases | Stale-premise suppression + rename-advisory cases |
| scripts/test-lint-shell-safety.sh | new cases | Committed-mode cases |
| .claude/commands/team/rad-plan.md | Files in Scope template | Document the two-row rename convention |
| .claude/commands/team/rad-adopt.md | Files in Scope template | Document the two-row rename convention |

## Program Design

**Type / signature changes**

- `scripts/lib/plan-paths.sh` — one new helper:
  `resolve_anchor_path <token> → path | (nothing)`. A token containing `/` is echoed
  unchanged. A bare basename is looked up with `git ls-files`; exactly one match prints the
  repo-relative path, zero or ≥2 matches print nothing. Called from inside
  `plan_cited_anchors`' filter loop, specifically the `*.*)` branch — the branch that today
  emits bare basenames. `RAD_ANCHOR_EXT` and the `*/*)` branch are untouched.
- `scripts/lint-plan.sh` — no new functions. One new accumulator array
  `MISSING_IN_SCOPE=()`, appended alongside each existing
  `WARNINGS+=("File in scope does not exist: …")`, then subtracted from the freshness input
  set. Task 3.2's rename advisory is an inline `if` block over the Files-in-Scope rows.
- `scripts/check-scope.sh` — no new functions. One new variable `RENAME_PAIRS` holding
  `dest<TAB>src` lines, consulted while printing the `OUT_OF_SCOPE` list. The verdict
  computation is not touched.
- `scripts/lint-shell-safety.sh` — one new block, `MODE_VIOLATIONS`, reusing the existing
  `VIOLATIONS` flag and `exit 1` path.

**Call-stack / control-flow sketch**

```
lint-plan.sh (top-level, sequential)
  Files-in-Scope existence check (~140-153)
    WARNINGS+=("File in scope does not exist: $path")
    MISSING_IN_SCOPE+=("$path")                      # NEW (Task 2.2)
  ... task-File:, high-risk, Program Design, self-protected advisories (unchanged) ...
  NEW rename advisory (Task 3.2): for each Files-in-Scope row
    if Change cell matches (git mv|rename|→) and names a path-shaped token
       not present in the File column ⇒ WARNINGS+=(...)
  Premise-freshness block (~232-244):
    { plan_cited_anchors            # ← Task 2.1 changes what this emits
      plan_task_files
      plan_files_in_scope
    } | sort -u
      | grep -Fxv -f <(plan_created_paths …)         # existing create-exempt
      | grep -Fxv -f <(MISSING_IN_SCOPE)             # NEW suppression (AC#3)
      → path_exists_on_ref path origin/main
          rc 1 ⇒ "stale premise"   rc 2 ⇒ "not verified" + break

plan_cited_anchors (plan-paths.sh)
  grep -oE '…:[0-9]+'  → status classified: >1 ⇒ return (fail closed)   [KEEP]
  per token: drop URL host:port; strip :NNN
    */*)  echo path                                  [unchanged]
    *.*)  matches RAD_ANCHOR_EXT ⇒ resolve_anchor_path path   # NEW indirection

check-scope.sh
  SCOPE_LIST built from column 2 only                [unchanged — see Non-Goals]
  CHANGED_FILES=$(git diff --name-only <REF_EXPR>)   # 3-way fallback chain
  classify → IN_SCOPE / OUT_OF_SCOPE                 [unchanged]
  output block (~110-139):
    RENAME_PAIRS=$(git diff --find-renames --diff-filter=R --name-status <REF_EXPR>)
    for f in OUT_OF_SCOPE:
      if f is a rename dest whose src ∈ SCOPE_LIST ⇒ annotate "likely rename target of <src>"
      else print as today
    exit 1                                           [verdict unchanged]

lint-shell-safety.sh
  existing scan loop:  for f in "$SCRIPTS_DIR"/*.sh   # non-recursive; SKIPS test-*.sh
  NEW mode loop (separate):  git ls-files -s "$SCRIPTS_DIR"
    include *.sh and *.mjs; exclude *.sh.sample and non-script data files
    mode != 100755 ⇒ report "$path (committed $mode, read from the index)"; VIOLATIONS=1
  stale-baseline pass, exit                          [unchanged]
```

**Design constraints this sketch surfaces**

1. **The mode check cannot reuse the existing scan loop.** That loop skips `test-*.sh`
   (`lint-shell-safety.sh:116`) and globs non-recursively, yet the sole offender is
   `scripts/test-check-scope.sh`. Folding the mode check into it would make the check
   structurally incapable of catching #101. It must be a separate `git ls-files -s` pass.
2. **`git ls-files -s scripts/` recurses; the existing glob does not.** The new pass sees
   `scripts/hooks/**`, so the `*.sh.sample` exclusion is load-bearing, not decorative.
3. **`check-scope.sh` resolves its diff ref through a three-way fallback chain** (`origin/BASE...`,
   `BASE...`, `BASE..`). The rename lookup must reuse the ref expression that actually
   succeeded rather than recomputing it, or the two queries can disagree.
4. **`resolve_anchor_path` sits downstream of an already-classified grep.** Its own
   `git ls-files` failure needs the same treatment — a read error must fail closed, never
   silently resolve to "no anchors" (already named in Risks).

**Verified against the tree at rebase time**

- Exactly one committed-mode offender under `scripts/`: `test-check-scope.sh` (`100644`).
  The other four non-`100755` entries are legitimately data or fixtures (`hooks/README.md`,
  two `*.sh.sample`, `lint-shell-safety-baseline.txt`). Confirms "no baseline entry expected".
- `plan_created_paths` already exists and is already wired into the freshness filter, so
  Task 2.2 adds the second, broader suppression rather than building create-exemption.
- This plan's own lint run reproduces #98: it warns `stale premise:` for `spine.js`, `ci.yml`,
  and `lint-shell-safety.sh` while `harness/spine.js`, `.github/workflows/ci.yml`, and
  `scripts/lint-shell-safety.sh` all exist. Those three warnings are the acceptance fixture —
  running `scripts/lint-plan.sh` on this very file after Wave 2 must emit none of them, while
  the eleven self-protected warnings must all survive unchanged.

**File-tree diff**

```
 scripts/lib/plan-paths.sh              (M)  + resolve_anchor_path; plan_cited_anchors calls it
 scripts/lint-plan.sh                   (M)  + MISSING_IN_SCOPE accumulator, + rename advisory
 scripts/check-scope.sh                 (M)  + RENAME_PAIRS lookup in the output block
 scripts/lint-shell-safety.sh           (M)  + committed-mode pass over git ls-files -s
 scripts/test-check-scope.sh            (M)  mode 100644 → 100755 (index), + rename cases
 scripts/test-plan-paths.sh             (M)  + bare-basename resolution cases
 scripts/test-lint-plan.sh              (M)  + suppression + rename-advisory cases
 scripts/test-lint-shell-safety.sh      (M)  + committed-mode cases
 .claude/commands/team/rad-plan.md      (M)  + two-row rename convention
 .claude/commands/team/rad-adopt.md     (M)  + two-row rename convention
```

No files added, moved, or deleted. `scripts/lint-shell-safety-baseline.txt` is expected to
stay byte-identical; it remains in Files in Scope only as the documented escape hatch.

## Execution Notes

### Do Not Touch
- `harness/**` — no harness change in this plan
- `.agents/plans/*.md`, `.agents/research/**`, `.agents/architecture/**`, `plans/` — historical records
- `.github/workflows/ci.yml` — how CI invokes the shell tests is explicitly out of scope
- `scripts/hooks/**` — `.sh.sample` fixtures are correctly `100644` and must stay that way
- `.claude/settings.local.json` — user-local
- Anything on branch `rad/check-tests-naming-honesty` (PR #100) — no file overlap; keep it that way

### Key Files
- `scripts/lib/plan-paths.sh` — the shared matcher; one source of truth for path logic, per CLAUDE.md
- `scripts/lint-plan.sh` — hosts both the freshness check and the new rename advisory
- `scripts/check-scope.sh` — read the declared-scope build at lines 26-60 before touching the violation output
- `scripts/lint-shell-safety.sh` — the baseline mechanism (lines 54-77) is the pattern to follow for any exemption
- `scripts/test-lint-shell-safety.sh` — shows the fixture style for lint tests

### Reminders
- **Apply this plan's own lesson**: every path above is declared in the File column. Do not
  put a path only in a Change cell.
- The mode check must read `git ls-files -s`, not the filesystem. A local `chmod` that was
  never staged is precisely the state the bug lived in.
- `scripts/lib/plan-paths.sh` is **sourced**, not executed, yet is committed `100755`. The
  mode rule must accept that rather than special-case it.
- Fixing a mode requires `git update-index --chmod=+x` — a plain `chmod` will not change what
  is committed.
- All three checks stay advisory-or-fail-closed exactly as they are today. This plan changes
  legibility, never severity.

## Wave Plan

### Wave 1 — sequential
The mode fix lands first so `scripts/test-check-scope.sh` is directly runnable for the waves
that extend it.

#### Task 1.1: Fix the committed mode
File: scripts/test-check-scope.sh:1
What: `git update-index --chmod=+x scripts/test-check-scope.sh` so the committed mode becomes
`100755`. No content change.
Validate: AC#7 — `git ls-files -s scripts/test-check-scope.sh` reports `100755`, and
`scripts/test-check-scope.sh` invoked directly exits 0 rather than 126.

#### Task 1.2: Committed-mode check in the shell-safety lint
File: scripts/lint-shell-safety.sh:105-150
What: Add a check that every tracked executable script under `scripts/` is committed `100755`.
Enumerate via `git ls-files -s scripts/` so modes come from the index, not the filesystem.
Apply to `*.sh` and `*.mjs`; exclude `*.sh.sample` fixtures and non-script data files such as
`lint-shell-safety-baseline.txt`. Note in a comment that `scripts/lib/plan-paths.sh` is sourced
rather than executed but is intentionally `100755`, so the rule is uniform. Fail closed with a
message naming each offending file and its actual mode. Outside a git repo, exit in the
existing error path rather than silently passing.
Validate: AC#8 — a fixture script committed `100644` fails the lint by name; `.sh.sample` and
`lint-shell-safety-baseline.txt` do not trip it; the clean tree exits 0 with no new output.

### Wave 2 — sequential
Anchor resolution (#98). Both tasks touch the freshness path; order matters.

#### Task 2.1: Bare-basename resolution
File: scripts/lib/plan-paths.sh:89-130
What: Add resolution for anchors that contain no `/`. Look the basename up against tracked
files: exactly one match → emit the resolved repo-relative path; zero or more than one match →
emit nothing (silent, since a guess is worse than no signal). Anchors already containing `/`
are returned unchanged. Keep the existing grep exit-code classification — a genuine read error
must still fail closed rather than resolve to empty.
Validate: AC#1, AC#2 — `spine.js:51` resolves to `harness/spine.js`; a basename matching two
tracked files emits nothing; a removed file's path still flows through to the warning.

#### Task 2.2: Suppress the duplicate for plan-created files
File: scripts/lint-plan.sh:209-235
What: Consume the resolved anchors from Task 2.1. Then suppress the stale-premise warning for
any path already reported by the existing "File in scope does not exist" check — a plan's own
new files are absent from the base branch by construction, and one fact should produce one
finding.
Validate: AC#3 — a plan declaring a new file gets the "does not exist" warning only, never both;
existing plans with no new files produce byte-identical output.

### Wave 3 — sequential
Rename legibility (#99). Task 3.2 touches `lint-plan.sh` again, after Wave 2 settles it.

#### Task 3.1: Rename-aware violation message
File: scripts/check-scope.sh:81-120
What: When an out-of-scope path is a newly added file, use `git diff --find-renames` to detect
whether it pairs with the deletion of a path that IS declared in scope. If so, label it in the
output as a likely undeclared rename target and name the deleted counterpart. The check still
**fails** — this changes the message, not the verdict.
Validate: AC#4 — a `git mv` of a declared file to an undeclared path fails with a message
naming both paths; a genuinely new unrelated file reports exactly as today.

#### Task 3.2: Plan-time rename advisory
File: scripts/lint-plan.sh:155-180
What: When a Files-in-Scope Change cell describes a rename (`git mv`, `rename`, or `→`
alongside a path-shaped token), warn advisorily if that destination path is not itself a
declared File-column row. This moves the catch from confusing deliver-time failure to
plan-time nudge. Advisory only — never an error.
Validate: AC#5 — a plan with a `git mv` Change cell and no destination row warns and names the
missing path; adding the row silences it; a plan with no renames produces no new output.

#### Task 3.3: Document the two-row convention
File: .claude/commands/team/rad-plan.md
What: In the Files-in-Scope guidance, state that a rename declares **both** source and
destination as separate rows, and why (the scope checker reads the File column only). Apply the
same addition to `.claude/commands/team/rad-adopt.md`.
Validate: AC#6 — both command specs state the convention in their Files-in-Scope guidance.

### Wave 4 — parallel
Test coverage; disjoint files.

#### Task 4.1: check-scope rename cases
File: scripts/test-check-scope.sh:1-200
What: Add cases for the rename-aware message: declared-source-to-undeclared-destination fails
and names both; both-rows-declared passes; an unrelated new file reports as today. Match the
file's existing fixture and assertion style.
Validate: AC#4, AC#9 — new cases pass; pre-existing cases unchanged in count and outcome.

#### Task 4.2: shell-safety mode cases
File: scripts/test-lint-shell-safety.sh:1-200
What: Add cases for the committed-mode check: a fixture committed `100644` fails and is named;
`.sh.sample` and the baseline data file are ignored; a clean tree exits 0. Modes must be set in
the index, not just on disk.
Validate: AC#8, AC#9 — new cases pass; pre-existing cases unchanged in count and outcome.

#### Task 4.3: plan-paths and lint-plan cases
File: scripts/test-plan-paths.sh:1-200
What: Add bare-basename resolution cases (unique → resolved, ambiguous → silent, slash-bearing
→ unchanged, read error → fails closed). Add the stale-premise suppression and rename-advisory
cases to `scripts/test-lint-plan.sh`.
Validate: AC#1, AC#2, AC#3, AC#5 — each case asserts an explicit exit code and expected output
substring.

## Tests to Write
- [ ] Bare-basename anchor resolution: unique, ambiguous, slash-bearing, read-error — scripts/test-plan-paths.sh
- [ ] Stale-premise suppression for plan-created files and rename advisory — scripts/test-lint-plan.sh
- [ ] Rename-aware scope violation message and both-rows-declared pass — scripts/test-check-scope.sh
- [ ] Committed-mode check: bad mode fails, samples and data files ignored — scripts/test-lint-shell-safety.sh

## Non-Goals
- Parsing the prose Change column for destination paths to feed the scope set — guessing at
  natural language inside a fail-closed gate is worse than the current honest failure.
- Making any of the three checks more permissive. Severity and verdicts are unchanged
  throughout; only messages, false positives, and documentation move.
- Changing how CI invokes the shell tests, or auditing file modes outside `scripts/`.
- Fixing #97's invariant registry, which shares the anchor-resolution problem but is a
  separate, larger piece of work.

## Out-of-Scope Dependencies
None. All files are within the architect's scope and no architect-only agent is required.

## Risks

- **`lint-plan.sh` is edited in two separate waves** (2.2 and 3.2). They touch different
  sections, but a careless edit in Wave 3 could disturb Wave 2's suppression logic. Wave 3
  must re-run the Wave 2 test cases, not just its own.
- **Basename resolution changes what the freshness check inspects.** If the lookup is wired
  before the existing grep exit-code classification, a read error could silently resolve to
  "no anchors" and turn a fail-closed path into a silent pass. Task 2.1 names this explicitly.
- **The mode check runs over tracked files, so it cannot see an unstaged `chmod`.** That is
  deliberate and correct, but it means a contributor who fixes a mode locally without staging
  will still see the lint fail. The message must say the mode is read from the index.
- `scripts/test-check-scope.sh` is both the subject of Task 1.1 and extended by Task 4.1.
  Wave ordering handles this, but the mode change must be committed as a mode change — a
  content edit that drops the mode would silently reintroduce #101.

## Issue Gaps

Assumptions made where the three issues were silent — verify at approval:

- **Bundling.** The three issues are separate; this plan ships them together because two edit
  `lint-plan.sh` and all three share the calibration theme. If they should ship independently,
  this plan needs splitting and the `lint-plan.sh` conflict managed by hand.
- **Ambiguous basenames stay silent.** #98 recommended "skip silently rather than warn". This
  plan follows that, meaning a genuinely stale ambiguous basename produces no signal at all.
  The alternative — warn with all candidates — was not chosen.
- **Mode rule is uniform, not role-based.** `scripts/lib/plan-paths.sh` is sourced, not
  executed, and would not strictly need `+x`; it is already `100755`. This plan enforces one
  uniform rule for all `*.sh`/`*.mjs` under `scripts/` rather than distinguishing sourced
  libraries from executables, on the grounds that the distinction is not mechanically
  detectable and the current tree already satisfies the simpler rule.
- **No baseline entry expected.** `lint-shell-safety.sh` has a baseline mechanism for
  grandfathering violations. This plan assumes the mode check needs no baseline because
  Task 1.1 fixes the only offender first. If another offender appears, the baseline is the
  documented escape hatch.
- **Rename detection threshold.** `git diff --find-renames` uses git's default similarity
  threshold. A rename combined with heavy edits may not be detected, in which case the message
  degrades to today's plain violation — acceptable, since the verdict is identical either way.
- **Documentation location.** #99 said "the plan template". The template is embedded in the
  command specs, so this plan updates `rad-plan.md` and `rad-adopt.md` rather than adding a
  standalone template file.
