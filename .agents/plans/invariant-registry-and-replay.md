# Plan: Invariant Registry + Anchor Lint, and Matrix/Gates Replay Check
Created: 2026-09-29
Author: architect
Status: complete
Completed-At: 2026-09-29T18:33:33Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-09-29T18:22:14.858Z
Recorded-By: sean@torchcodelab.com
Branch: rad/invariant-registry-and-replay
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/97, https://github.com/seanrreid/RAD_framework/issues/67
Issue-Title: Invariant registry + anchor lint (#97) + Event-log replay regression check for matrix.yaml/gates.yaml changes (#67)

## Context

This is Plan 1 of the verification batch. It covers the two deterministic coupling checks; Plan 2 (#109 + #49, model-driven evals) follows and builds on this plan's registry.

- **#97:** RAD's determinism claims are spread across many enforcement sites, and nothing checks that those sites still say what the docs say. #91 was the realized case of this.
- **#67:** a change to `matrix.yaml` or `gates.yaml` is reviewed by eye, with no answer to "which past runs would have been routed differently?"

**What research found:**
- **Injectable tables.** `resolveOutcome(phase, outcome, matrix)` (`harness/matrix.js:54-69`) and `evaluateGate(name, history, gates, opts)` (`harness/gates.js:77`) both accept the table as an argument and throw on unknown keys. `loadMatrix(path)` (:36) and `loadGates(path)` (:43) read any file. So a replay can evaluate the same history under a baseline table and a proposed table without touching the fold.
- **Recorded decisions.**
  - `matrix.yaml` has one phase, `implement`, covering all 7 outcomes. `wave-attempt` records `data.outcome` but not the resolved action (`spine.js:794-799`), so the replay recomputes the action under both tables. `deliver-stopped` / `wave-failed` record the action that was actually taken.
  - `gates.yaml` has one gate, `approved`, with a `role-equals` condition over `approved` events.
- **Branch-tip logs.** They are read with `git show <branch>:.agents/state/<f>/events.jsonl` (`cli.js:539-547` `readBranchTipHistory`; `rad-status.sh:136-150`). The prefix is `RAD_BRANCH_PREFIX`, default `rad/`.
- **CI.** `.github/workflows/ci.yml` (180 lines) holds zero check logic. `plan-lint` (:151-180) is the one path-filtered job: it `git diff`s against the base and re-emits lines as `::warning::`. Scripts never emit annotations themselves.
- **#91 is closed.** Commit `efb8e3f` removed the divergent `spine.js` comments ("a regression blocks AT the introducing wave", "// regression. DEMOTE it to fail-tests"). The #91 lint fixture therefore reconstructs that divergence in a fixture copy; it doesn't point at live code.
- **An unguarded bypass surfaced by research:** CI `deliver-integrity` is gated on `startsWith(github.head_ref, 'rad/')` (`ci.yml:106-146`). A custom `RAD_BRANCH_PREFIX` therefore **skips the approval-integrity and scope CI checks entirely**. Per #97, bypasses are *enumerated, not removed*. It is recorded as `guarded: no`, and a follow-up issue is filed.
- **Stale anchors.** `docs/harness-and-framework.md` "Anchor index" (:286) already holds stale line-number anchors (e.g. "Doom-loop breaker spine.js 375-406"). That's evidence for symbol-based anchors.

## Scope

| In scope | Out of scope |
|---|---|
| `docs/invariants.yaml` registry (data) + `docs/invariants.md` (narrative; the bypass inventory is *generated*, not duplicated) | Changing any enforcement site, or removing any bypass |
| `harness/invariants.js` pure schema/anchor checks; `scripts/lint-invariants.sh` (fail-closed) + fixture test incl. the #91 case | Semantic/behavioral verification (that is #109, Plan 2) |
| `harness/replay.js` pure replay + diff; `scripts/check-matrix-replay.sh` + fixture test | Modifying `matrix.js`, `gates.js`, or `events.js` fold/write paths |
| CI: `invariant-lint` job (all PRs, blocking); `matrix-replay` job (path-filtered, advisory annotations) | Fixing the `RAD_BRANCH_PREFIX` CI bypass (follow-up issue) |
| Link the registry from `docs/harness-and-framework.md` | Rewriting the stale Anchor index table |

## Acceptance Criteria

1. `docs/invariants.yaml` is machine-readable (`version: 1`) and registers every load-bearing invariant in Program Design §2. Each invariant has:
   - `id` and `claim`
   - `authority`
   - `enforced_by`: a non-empty list of `{file, symbol, note?}`
   - `display_only` (optional)
   - `bypasses`: a **required** key, a list of `{id, surface, guarded: yes|no, note}`. `[]` means "analyzed, none"; a missing key means "not analyzed".
2. `validateRegistry(doc)` in `harness/invariants.js` returns named errors for the following, and never throws on malformed input:
   - wrong or missing `version`
   - duplicate `id`
   - missing `claim` or `authority`
   - empty or missing `enforced_by`
   - an anchor missing `file` or `symbol`
   - a missing `bypasses` key ("not analyzed")
   - a bypass missing `id`, `surface` or `guarded`
   - `guarded` not `yes` or `no`
3. `checkAnchors(doc, readFile)` returns one error per anchor whose `file` can't be read, or whose content doesn't contain `symbol` as a literal substring. Each error names the invariant id, the file and the symbol. A symbol that moved but is still in the file passes.
4. `scripts/lint-invariants.sh [registry]` behaves as follows:
   - **Pass:** exit 0 with `✓ invariants: <n> entries, <m> anchors resolved`.
   - **Violations:** exit 1, printing each validation or anchor error with a `✗` prefix.
   - **Usage or input errors:** exit 2 for bad arguments, a missing or unreadable registry, or unparseable YAML.
   - **Empty registry:** `invariants: []` exits 0 with `✓ invariants: 0 entries`.
   - **`--inventory`:** prints the bypass inventory, one row per bypass (`<invariant> | <bypass> | <surface> | guarded|UNGUARDED | <note>`), in registry order, then exits.
5. `scripts/test-lint-invariants.sh` passes under `bash` and `/bin/bash` 3.2. It covers:
   - a renamed file makes the lint fail and name the entry
   - a moved-but-present symbol passes
   - a missing symbol in an existing file fails
   - an empty registry exits 0
   - a missing `bypasses` key fails as "not analyzed"
   - unparseable YAML exits 2
   - **the #91 divergence:** a fixture registry entry claiming per-wave regression detection, anchored to `// regression. DEMOTE it to fail-tests`, against a fixture copy of the post-fix `spine.js`, fails naming the entry
   - **the real registry** passes, and its `--inventory` includes a bypass for each gate-widening surface in Program Design §3
6. `harness/replay.js` exports `replayDecisions(history, { matrix, gates })` and `diffDecisions(base, proposed)`.
   - **Matrix decisions:** one per `wave-attempt` that carries a string `data.outcome`: `{kind:'matrix', feature, index, wave, attempt, outcome, action}`, with `action = resolveOutcome('implement', outcome, matrix).action`. When the lookup throws, `action` is the string `throws: <message>`.
   - **Gate decisions:** one per gate name in the table at each `deliver-started` event, evaluated on the history before it, `{kind:'gate', feature, index, gate, passed}`, and `passed: 'throws: <message>'` when evaluation throws. Gate names present in only one of the two tables are evaluated in both, so a gate that's missing from one table throws.
   - **Edge cases:** an empty history gives `[]`, and history with only non-phase events gives `[]`.
   - **`diffDecisions`** returns only the entries whose `action` or `passed` differ, keyed by `(feature, kind, index, gate?)`. Identical tables give `[]`.
7. `scripts/check-matrix-replay.sh [--base <ref>]` works as follows:
   - **Baseline:** `harness/matrix.yaml` / `harness/gates.yaml` at `<ref>`. The default is the merge-base of `HEAD` with `origin/<default_branch>`.
   - **Proposed:** the working-tree tables.
   - **History:**
     - every `origin/${RAD_BRANCH_PREFIX:-rad/}*` branch tip's `.agents/state/<f>/events.jsonl`
     - plus the working tree's `.agents/state/*/events.jsonl`, for features without a branch-tip log
   - **Output:** `divergence: <feature> <kind> #<index> <detail>: <baseline> → <proposed>` lines, then a summary line.

   | Case | Exit | Output |
   |---|---|---|
   | divergences found | 0 | the divergence lines and a summary (advisory) |
   | no history to replay | 0 | `no history to replay` |
   | identical decisions | 0 | `no divergences across <k> feature(s)` |
   | unparseable YAML (either table) | 1 | names the file |
   | unreadable or malformed log | 1 | names the feature |
   | unresolvable base ref | 1 | names the ref |
   | bad arguments | 2 | usage |

   Variables go to node as argv or env, never interpolated into `node -e` (shell-safety lint).
8. `scripts/test-check-matrix-replay.sh` passes under `bash` and `/bin/bash`, using a hermetic fixture repo with a local bare origin. It covers:
   - a known divergence renders
   - identical tables give no divergences
   - a proposed table missing an outcome renders `throws:`, not a crash
   - unparseable proposed YAML exits 1
   - no state logs exit 0 with `no history to replay`
   - a branch-tip log is replayed, and preferred over a working-tree copy of the same feature
   - a bad `--base` exits 1
9. CI gains two jobs, both thin wrappers:
   - **`invariant-lint`:** all PRs; `run: scripts/lint-invariants.sh`; **blocking**.
   - **`matrix-replay`:** runs only when `git diff --name-only base...HEAD` touches `harness/matrix.yaml` or `harness/gates.yaml`, and prints a clean skip line otherwise. It runs the script with `--base` set to the PR base SHA, re-emits `divergence:` lines as `::warning::`, and fails only when the script exits non-zero (a mechanical failure).
10. `docs/invariants.md` explains the registry, the anchor discipline ("prose explains; facts anchor"), how to add an entry, and how to print the inventory, without duplicating the inventory. `docs/harness-and-framework.md` links the registry from "Anchor index" and "See also" as the audit entry point.
11. The registry performs no enforcement. `harness/gates.js` stays the only gate fold, and `matrix.js`, `gates.js` and `events.js` are unmodified.

## Agent Scope

- An `Explore` agent (general, read-only) mapped:
  - the `matrix.js` / `gates.js` APIs and table shapes
  - where matrix decisions appear in events
  - the branch-tip readers
  - the `ci.yml` job structure and annotation pattern
  - the lint script conventions
  - #91's status and the removed text
  - stable symbols for every enforcement site
  - every `RAD_*` variable that can widen a gate
  - the `harness-and-framework.md` headings
- The architect-role mappers (`ci-surface-mapper`, `integrity-surface-mapper`, `lint-surface-mapper`) cover subsets of this. A single Explore pass was cheaper for a cross-cutting inventory.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/invariants.js | 1-100 | New: `validateRegistry`, `checkAnchors`, `bypassInventory` (pure) |
| harness/test/invariants.test.js | 1-120 | New: AC#2, AC#3 cases |
| harness/replay.js | 1-100 | New: `replayDecisions`, `diffDecisions` (pure; imports matrix.js/gates.js read-only) |
| harness/test/replay.test.js | 1-130 | New: AC#6 cases |
| scripts/lint-invariants.sh | 1-90 | New: the anchor lint (AC#4) |
| scripts/test-lint-invariants.sh | 1-160 | New: fixture test incl. #91 (AC#5) |
| docs/invariants.yaml | 1-200 | New: the registry (AC#1, Program Design §2-3) |
| docs/invariants.md | 1-60 | New: narrative + how-to (AC#10) |
| scripts/check-matrix-replay.sh | 1-130 | New: the replay check (AC#7) |
| scripts/test-check-matrix-replay.sh | 1-160 | New: fixture test (AC#8) |
| .github/workflows/ci.yml | 88-100 | New `invariant-lint` job beside the other lints |
| .github/workflows/ci.yml | 146-180 | New path-filtered `matrix-replay` job after `plan-lint` |
| docs/harness-and-framework.md | 286-320 | Link the registry from Anchor index + See also |

## Program Design

### 1. Registry schema (`docs/invariants.yaml`)

```yaml
version: 1
invariants:
  - id: unapproved-deliver-cannot-run
    claim: "/rad-deliver refuses to execute without an `approved` event on the work-branch tip"
    authority: ".agents/state/<feature>/events.jsonl (approved event)"
    enforced_by:
      - { file: harness/gates.js, symbol: "export function evaluateGate", note: "the only gate fold" }
      - { file: scripts/deliver-gate-hook.mjs, symbol: "check-plan-approved.sh", note: "fail-closed PreToolUse block" }
      - { file: .claude/settings.json, symbol: "node scripts/deliver-gate-hook.mjs", note: "unregistered ⇒ unenforced" }
      # …
    display_only:
      - { note: "plan doc Status: approved header" }
      - { note: "rad:approved label" }
    bypasses:
      - { id: proxy-approval, surface: "rad approve --on-behalf-of", guarded: yes, note: "requires --evidence; named approver must be the architect; provenance recorded" }
```

Symbols are literal substrings: a function name, constant, event-type string or distinctive comment. They are never line numbers.

### 2. Invariants to register (anchors from research; implementer verifies each resolves)

| id | enforced_by (file · symbol) |
|---|---|
| `unapproved-deliver-cannot-run` | gates.js `evaluateGate` · events.js `event.type === 'approved'` · cli.js `branchTipApprovedGate`, `setupMainRun` · spine.js `state.gate(feature, 'approved')` · check-plan-approved.sh `approved --stdin` · check-approval-integrity.sh `merge-base --is-ancestor` · deliver-gate-hook.mjs `function block` · .claude/settings.json `deliver-gate-hook.mjs` · check-role.sh `VALID_ROLES=` |
| `approval-invalidated-by-plan-change` | spine.js `approvalChangeReason`, `'approval-changed'` · cli.js `makeApprovalIntact` |
| `approval-blockers-refuse` | check-approval-blockers.sh `EXIT_BLOCKED` · cli.js `checkApprovalBlockers` |
| `scope-enforced` | check-scope.sh `scope_declares` · spine.js `SCOPE_FAIL_OUTCOME` · matrix.yaml `fail-scope:` |
| `events-append-only` | check-events-append-only.sh `CHANGED=$(git diff --name-only` · git-state-store.js `appendFileSync` |
| `self-protected-paths-flagged` | plan-paths.sh `readonly RAD_SELF_PROTECTED_PATTERN`, `path_is_self_protected` · lint-plan.sh `path_is_self_protected` |
| `worktree-teardown-guarded` | worktree-lifecycle.sh `MARKER_NAME=".rad-worktree.json"`, `refusing to remove` |
| `resume-needs-decision-only` | cli.js `resolveResume`, `cannot resume a failed stop` · stops.js `STOP_CLASSES` |
| `hook-veto-fail-closed` | hook-runner.js `VETO_ABORT_OUTCOME`, `createHookRunner` · spine.js `safeVetoOutcome` |
| `verify-timeout-surfaces` | check-verify.sh `VERIFY_TIMEOUT_STATUS=124` · spine.js `'fail-timeout' : 'fail-tests'` |
| `adapter-env-allow-listed` | adapters/agent/command.js `ENV_ALLOW_LIST` |
| `matrix-no-fallthrough` | matrix.js `resolveOutcome` (throw on unknown) · gates.js unknown-gate throw |

### 3. Bypass inventory (every gate-widening surface must appear)

| Surface | On invariant | guarded |
|---|---|---|
| `rad approve --on-behalf-of` | unapproved-deliver-cannot-run | yes (evidence + architect role + provenance) |
| `RAD_HIGH_RISK_PATTERNS` override | approval-blockers-refuse | yes (empty ⇒ default; non-default frozen into `approved.data.highRiskPattern`; CI advisory) |
| `## Waivers` section | approval-blockers-refuse | yes (frozen into `approved.data.waivers`; markers unwaivable) |
| `RAD_HOOKS_DIR` (empty dir) | hook-veto-fail-closed | no (operator input; removes all veto hooks) |
| `RAD_AGENT_PREFLIGHT=off` | adapter-env-allow-listed | no (skips the startup auth probe only) |
| `RAD_VERIFY_TIMEOUT_SECONDS` (large) | verify-timeout-surfaces | yes (malformed ⇒ exit 2; only delays) |
| `RAD_BRANCH_PREFIX` ≠ `rad/` | unapproved-deliver-cannot-run + scope-enforced | **no: CI `deliver-integrity` is skipped** (follow-up issue) |
| self-protected paths are advisory | self-protected-paths-flagged | no (by design: architect review, not a blocker) |

### 4. Replay (`harness/replay.js`)

```js
export function replayDecisions(history, { matrix, gates })  // → Decision[] (never throws; lookups that throw become 'throws: …')
export function diffDecisions(base, proposed)                 // → [{ key, feature, kind, index, gate?, detail, base, proposed }]
```

`check-matrix-replay.sh` performs these steps:
1. Resolves the base ref and `git show`s both tables into a temp dir.
2. Collects logs into a temp dir: branch tips first, then working-tree logs for features not already present.
3. Runs `node --input-type=module -e '<fixed script>' -- <tmpdir>`. The script loads both table pairs with `loadMatrix` / `loadGates`, replays every log, diffs, and prints.

The node script is a fixed literal; all variables arrive via argv.

### 5. CI (thin wrappers)

```yaml
invariant-lint:        # all PRs, blocking
  run: scripts/lint-invariants.sh
matrix-replay:         # path-filtered, advisory
  - if git diff --name-only "$BASE"...HEAD -- harness/matrix.yaml harness/gates.yaml is empty → echo "matrix-replay: no table change — skipped"
  - else scripts/check-matrix-replay.sh --base "$BASE" | re-emit ^divergence: as ::warning::; job fails only on non-zero exit
```

## Execution Notes

### Do Not Touch
- harness/matrix.js, harness/gates.js, harness/events.js, harness/spine.js, harness/cli.js, harness/stops.js, harness/transitions.js, harness/matrix.yaml, harness/gates.yaml. The registry and replay only *read* these.
- Every enforcement site the registry names (read-only anchors)
- The existing `deliver-integrity` job's `rad/` condition (record the bypass; don't fix it here)

### Key Files
- harness/matrix.js — `loadMatrix` (36-43), `resolveOutcome` (54-69)
- harness/gates.js — `loadGates` (43), `evaluateGate` (77)
- harness/vendor/js-yaml.mjs — the YAML parser to reuse (as matrix.js does)
- scripts/lint-shell-safety.sh, scripts/lint-agent-files.sh (+ their tests) — lint script and fixture conventions
- .github/workflows/ci.yml — `plan-lint` (151-180) is the path-filter + `::warning::` re-emit pattern
- harness/cli.js:539-547 `readBranchTipHistory`; scripts/rad-status.sh:136-150 — branch-tip log reads

### Reminders
- **Fail-closed lint (architect decision).** The registry is written against today's code, so every anchor must resolve at merge. Verify with `scripts/lint-invariants.sh` before committing the registry.
- **Portability:** bash 3.2 (`/bin/bash`) and BSD tools. No associative arrays, no `mapfile`.
- **Shell-safety lint:** pass variables to `node`/`git` as argv. Guard every positional or `RAD_*` input with a `[[ =~ ]]` or `case` before use (the #153 lesson). Run `scripts/lint-shell-safety.sh` before committing any new script.
- **Never swallow errors.** Justify every `|| true` inline.
- **Long final checks** exceed the 2-minute foreground timeout. Run them with `run_in_background`.

## Wave Plan

### Wave 1 — parallel
Tasks in this wave can run in parallel (disjoint new files).

#### Task 1.1: Invariant schema + anchor checks module
File: harness/invariants.js:1-100, harness/test/invariants.test.js:1-120
What: Implement three pure functions (they never throw on malformed input):
- `validateRegistry(doc)` returns `string[]` errors, per AC#2.
- `checkAnchors(doc, readFile)` returns `string[]` errors, per AC#3. `readFile(path)` returns the file's content or `null`.
- `bypassInventory(doc)` returns rows `{invariant, id, surface, guarded, note}` in registry order.
Tests:
- each AC#2 error case
- absent `bypasses` is distinguished from `[]`
- a symbol that moved but is still present passes
- a missing file or missing symbol fails, naming the id, file and symbol
- `version` other than 1 fails
- `null` or non-object input returns errors without throwing
Validate: AC#2, AC#3 — `npm test --prefix harness`.

#### Task 1.2: Replay module
File: harness/replay.js:1-100, harness/test/replay.test.js:1-130
What: Implement `replayDecisions` and `diffDecisions` per AC#6 and Program Design §4. Import `resolveOutcome` from `matrix.js` and `evaluateGate` from `gates.js` read-only; table objects are passed in.
Tests:
- empty history gives `[]`
- only `owner-*` / `architecture-approved` events give `[]`
- identical tables give an empty diff
- changing `fail-tests` from `retry` to `abort` makes the divergence appear
- an outcome missing from the proposed table gives `throws:` in the diff, not a throw
- a gate removed from the proposed table gives a `throws:` divergence
- the gate is evaluated on the history before each `deliver-started`
- diff keys are stable
Validate: AC#6 — `npm test --prefix harness`.

### Wave 2 — parallel
Tasks in this wave can run in parallel. 2.1 and 2.2 share the registry format (fixed in Program Design §1); 2.3 is independent.

#### Task 2.1: Anchor lint script + fixture test
File: scripts/lint-invariants.sh:1-90, scripts/test-lint-invariants.sh:1-160
What: Implement AC#4. The script parses YAML through node, importing `harness/vendor/js-yaml.mjs` and `harness/invariants.js` with a fixed node script and argv inputs. Header and exit-code conventions follow `lint-agent-files.sh`. The default registry is `docs/invariants.yaml`, resolved from the script's own directory.
The fixture test covers the AC#5 cases, including the #91 reconstruction. Real-registry assertions are skipped with a visible `SKIP` line until `docs/invariants.yaml` exists. Once it does (after 2.2 lands), they run: the real registry passes, and `--inventory` lists every §3 surface.
Validate: AC#4, AC#5 — `bash scripts/test-lint-invariants.sh && /bin/bash scripts/test-lint-invariants.sh`; `scripts/lint-shell-safety.sh` shows no `✗`.

#### Task 2.2: Registry + narrative
File: docs/invariants.yaml:1-200, docs/invariants.md:1-60
What: Author every invariant in Program Design §2 with anchors verified against the current code; adjust a symbol when research's literal doesn't match, but never an enforcement site. Author every bypass in §3; the `RAD_BRANCH_PREFIX` row carries `guarded: no` and names the CI job it skips. Write `docs/invariants.md` per AC#10.
Validate: AC#1, AC#10 — `node -e` parse + `validateRegistry` + `checkAnchors` (via `harness/invariants.js`) return zero errors. If 2.1 has landed, `scripts/lint-invariants.sh` exits 0 as well.

#### Task 2.3: Replay check script + fixture test
File: scripts/check-matrix-replay.sh:1-130, scripts/test-check-matrix-replay.sh:1-160
What: Implement AC#7 and AC#8 per Program Design §4, in a hermetic fixture repo with a local bare origin (copy the scripts and harness modules it needs, as other fixture tests do).
Validate: AC#7, AC#8 — `bash scripts/test-check-matrix-replay.sh && /bin/bash scripts/test-check-matrix-replay.sh`; `scripts/lint-shell-safety.sh` shows no `✗`; a real run `scripts/check-matrix-replay.sh` from the repo root exits 0.

### Wave 3 — sequential
Wire CI and docs after every surface exists.

#### Task 3.1: CI jobs + docs link
File: .github/workflows/ci.yml:88-100, 146-180, docs/harness-and-framework.md:286-320
What:
- Add the `invariant-lint` and `matrix-replay` jobs per AC#9 and Program Design §5. `matrix-replay` uses `fetch-depth: 0`, so it can resolve the base and fetch the `origin/rad/*` tips.
- Keep zero check logic in the YAML, beyond the path-filter and re-emit loop that `plan-lint` already uses.
- Link the registry from "Anchor index" and "See also".
- Run `scripts/lint-invariants.sh` and the full `scripts/test-lint-invariants.sh` again now that the registry exists; the real-registry assertions must run, not skip.
Validate: AC#9, AC#10, AC#11 — `scripts/lint-invariants.sh` exits 0 on the real registry; `bash scripts/test-lint-invariants.sh` passes with no SKIP; `git diff --stat` shows no change to matrix.js/gates.js/events.js; CI YAML parses (`node -e` + js-yaml load of ci.yml).

## Tests to Write
- [ ] Registry schema + anchor checks — harness/test/invariants.test.js
- [ ] Replay + diff — harness/test/replay.test.js
- [ ] Anchor lint fixtures incl. #91 + real registry — scripts/test-lint-invariants.sh
- [ ] Replay check fixtures — scripts/test-check-matrix-replay.sh

## Non-Goals
- Verifying behavior. The lint checks that anchors resolve; making claims fail a test is #109 (Plan 2).
- Removing or fixing any bypass, including the `RAD_BRANCH_PREFIX` CI skip. It is recorded, and a follow-up issue is filed.
- Rewriting the stale line-number Anchor index table in `harness-and-framework.md`.
- Blocking a PR on a routing divergence. Replay is advisory, because changing behavior may be the point of the PR.
- Moving RAD config out of CLAUDE.md (#87).

## Out-of-Scope Dependencies
None. All paths are architect-owned, and the author is the architect.

## Risks
- **Lint friction.** A fail-closed lint means a PR that renames an anchored symbol must update `docs/invariants.yaml` in the same PR. That is intended (it's the #91 lesson), but the failure message must say exactly which entry and symbol broke.
- **Brittle symbols.** A symbol that's too generic (e.g. `approved`) always resolves and proves nothing. Prefer distinctive literals: function names, constants, exact log strings.
- **Replay cost in CI.** It replays every branch-tip log. That's cheap at today's scale (~46 features), and it only runs when the tables change.
- **Self-protected paths.** `harness/`, `scripts/` and `.claude/` trigger advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — split.** #97 + #67 are Plan 1; #109 + #49 are Plan 2. Architect decision, 2026-09-29.
- **ASSUMPTION — fail-closed.** The anchor lint blocks in CI from day one; #97 proposed advisory v1. Architect decision, 2026-09-29.
- **ASSUMPTION — #91 fixture.** #91 is closed and its divergent text was removed in `efb8e3f`, so the fixture reconstructs the divergence in a fixture copy of `spine.js`, not against live code.
- **ASSUMPTION — out-of-date bypasses in #97.** #97's example bypass `RAD_LOW_RISK_PATTERNS` no longer exists (the Green Lane was removed in #137), so it's omitted. The inventory reflects today's surfaces (Program Design §3).
- **ASSUMPTION — replay granularity.** Matrix decisions are recomputed per `wave-attempt` outcome, because the resolved action isn't stored there. Gate decisions are evaluated at each `deliver-started`, on the history before it: the moment the gate protects.
- **ASSUMPTION — follow-up.** The `RAD_BRANCH_PREFIX` CI skip is filed as a new issue during delivery rather than fixed here.
