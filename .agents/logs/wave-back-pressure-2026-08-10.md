# Execution Log: Per-Wave Back-Pressure Contract
Plan: .agents/plans/wave-back-pressure.md
Started: 2026-08-10T17:00:00Z
Branch: rad/wave-back-pressure
Executor role: architect

## Restart note

A deliver was started on 2026-08-06 (`.agents/logs/wave-back-pressure-2026-08-06.md`)
but stopped after committing the log stub — **zero waves executed, empty step table**.
This is a clean restart from Wave 1, not a mid-flight resume.

Pre-flight, 2026-08-10:
- Branch rebased onto `origin/main` (was 21 behind; PR #103 had since merged). No conflicts.
- Local branch had **diverged** from origin — a duplicate research commit (`d75af80` vs
  origin's `a3aa583`, same message, byte-identical artifact) left from an earlier history
  rewrite. Verified identical, then reset to origin.
- Approval integrity re-verified **after** the rebase (the approval commit's hash changed
  `1029720` → `aead793`): fingerprint matches, gate satisfied, authenticity confirmed. The
  check re-derives the approval commit from the branch rather than pinning a stored hash.
- Plan freshness against current main: **0 stale-premise warnings**. The only
  "does not exist" entries are `scripts/check-verify.sh` and `scripts/test-check-verify.sh`,
  which this plan creates.
- Baseline harness suite: **216/216 pass**.

## Steps

| Step | Wave | Task | Status | Commit | Time |
|------|------|------|--------|--------|------|
| 1 | Wave 1 | Document `usage` and `tasks[]` in the wave contract | ✓ complete | 060e2cd | 11:32 |
| 2 | Wave 1 | Thread parsed `tasks` onto the wave result | ✓ complete | 50cc7cd | 11:38 |
| 3 | Wave 1 | Both adapters return `tasks` + normalized `usage` | ✓ complete | c35e2aa | 11:44 |
| 4 | Wave 2 | Event typedef gains both optional keys | ✓ complete | a7431da | 11:13 |
| 5 | Wave 2 | Spine records `tasks` on the wave-attempt event | ✓ complete | 1050ab0 | 11:19 |
| 6 | Wave 2 | Fold-parity test on historical logs | ✓ complete | fa0d59a | 11:26 |
| 7 | Wave 3 | Parse the per-wave `Verify:` line | ✓ complete | 5c9ec4e | 11:12 |
| 8 | Wave 3 | New `scripts/check-verify.sh` | ✓ complete | d7a66ea | 11:26 |
| 9 | Wave 3 | Spine invokes verification and records the result | ✓ complete | 7e2d1b0 | 11:33 |
| 10 | Wave 4 | Widen `runWave` to accept attempt context | ✓ complete | 528932d | 11:44 |
| 11 | Wave 4 | Render the `## Prior Attempt Failure` prompt section | ✓ complete | 1175398 | 11:52 |
| 12 | Wave 4 | Capture the failing attempt into `priorFailure` | ✓ complete | a5ab2eb | 12:01 |

## Wave 1 — architect notes

**Concern raised (Task 1.2) and ruled on: scope of "never fail-protocol".**
Task 1.2 says a malformed or absent `tasks` block "yields omission of the key, never a
thrown error or `fail-protocol`". The wave read that as governing the *pass-through*, not
the *outcome mapping*, and left `resultToOutcome` alone — so a `WAVE_RESULT` block with no
parseable tasks still maps to `fail-protocol`.

Ruling: **accepted, and the alternative reading would have been a defect.** Verified
`resultToOutcome` is byte-identical to `origin/main`; the "unparseable / no tasks →
fail-protocol" mapping is pre-existing and documented on main at `contract.js:237`. An
agent that emits an unparseable result block has committed a real protocol violation.
Softening that would weaken the very check this feature exists to strengthen, and would
break AC#1's byte-for-byte-parity requirement for plans that declare no `Verify:`. The wave
added only a clarifying doc comment.

**Finding: the plan over-estimated the Task 1.2/1.3 delta.** Both adapters already returned
`tasks` and normalized `usage` on `main`. The genuine deltas were the contract
documentation, the omit-when-empty semantics, and collapsing two divergent local `toResult`
copies into one shared `toWaveResult` builder. Worth noting at Gate 2: the diff is smaller
than the plan implies, not because work was skipped but because the plan was written
against a slightly stale read of the adapters.

**Orchestrator verification:**
- `npm test --prefix harness` → **216/216 pass**, unchanged from baseline.
- Zero diff vs `origin/main` on every Do-Not-Touch path: `matrix.yaml`, `gates.js`,
  `spine.js`, `events.js`, `cli.js`, `check-tests-present.sh`, and all `harness/test/*`.
- Only 4 files changed: `docs/rad-wave-contract.md` and the three adapter files.
- Wave 1 is inert by design — nothing consumes `result.tasks` until Wave 2 wires it into
  the `wave-attempt` event.

## Wave 2 — architect notes

**Concern raised (Task 2.2) and ruled on: `usage`'s undefined-valued key.**
`spine.js` assigns `usage: result.usage`, so a legacy-shaped attempt carries a `usage` key
whose value is `undefined`. It serializes identically to an absent key, so no current fold
is affected — but a future reader using `'usage' in data` instead of a truthiness check
would get a false positive. Wave 2's `tasks` avoids this by construction (spread, so the
key is genuinely absent).

Ruling: **noted, not fixed.** Pre-existing and outside this plan's scope; changing it risks
the byte-parity guarantee AC#5 turns on. Carried forward as a constraint instead: any
reader over these keys in Waves 3-5 must test *values*, not key presence. Flagged for
Gate 2 review.

**Orchestrator verification:**
- `npm test --prefix harness` → **218/218 pass** (216 baseline + 2 from Task 2.3).
- AC#5 byte-identity was *demonstrated*, not asserted: the wave extracted
  `origin/main:harness/spine.js` to a sibling module, drove both it and HEAD's spine
  through identical tasks-free scripted results, serialized every appended event, and
  `cmp`'d the streams — identical.
- Task 2.3 names all six folds explicitly (`reduce`, `resumeFrom`, `totalUsage`,
  `outcomeCounts`, `failReasonCounts`, `retryCounts`) and asserts hand-computed values
  rather than values captured from a run. The wave mutation-checked it (perturbing
  `totalUsage.total` 23→24 fails both tests), so the parity gate is not vacuous.
- Zero diff vs `origin/main` on `gates.js`, `matrix.yaml`, `cli.js`,
  `check-tests-present.sh`.

## Wave 3 — architect notes (highest-risk wave)

### Deviation from the plan's Program Design — ruled correct

The Program Design specifies `scripts/check-verify.sh <feature> <command>` (two args).
What shipped takes **one**: `check-verify.sh <command>`.

Ruling: **the implementation is right and the plan's signature line was the error.** Every
existing `sh` call site passes exactly one argument (`sh('scripts/check-tests-present.sh',
feature)`), and both AC#2 and Task 3.2 require the `sh` port shape stay *unchanged*. Passing
two arguments would have meant widening the port — violating the same plan. `<feature>` was
unused by the script in any case. The Program Design was internally inconsistent with its own
constraint; the wave resolved it in favor of the constraint.

### Concerns raised and ruled on

**1. Exit 124 is reserved for timeout.** A command that genuinely exits 124 is reported as a
timeout. **Accepted** — it matches the GNU `timeout(1)` convention and errs conservative: the
false positive *surfaces* (terminal) rather than retrying, so it cannot burn attempts or hide.
Documented in the script header.

**2. `RAD_VERIFY_TIMEOUT_SECONDS` override is undocumented in CLAUDE.md.** The task said
"named constant"; the wave made the constant the default and added an env override, because
AC#7 is otherwise untestable without a 10-minute test. Malformed values are a hard exit-2
usage error, never a silent fallback. **Accepted, with the gap routed to Wave 5** — Task 5.3
already edits CLAUDE.md to document the `Verify:` line, so the override is documented there.

### Orchestrator verification (re-run independently, not taken on report)

The plan names Task 3.2 its highest risk ("must apply the allow-listed-env treatment or it
becomes a credential-leak path"), so every claim below was re-tested directly:

| Check | Result |
|---|---|
| **Credential boundary** — `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `MY_SECRET` exported in parent | **No canary reached the command.** Visible: `HOME LANG PATH TERM TMPDIR` (+ shell-set `PWD SHLVL _`) |
| **Timeout** — `sleep 600` at a 3s limit | exit **124**, elapsed **3s**, **no orphan process** |
| **Exit passthrough** — `exit 7` | exit **7** |
| **Passing command** | exit 0, **0 bytes** of output (discarded) |
| **Truncation** — 500-line failure | **42 lines** out |
| **Frozen surfaces** | `gates.js`, `matrix.yaml`, `check-tests-present.sh` — zero diff vs main |
| **Outcome vocabulary** | exactly the frozen 7 tokens; no eighth anywhere |
| **Committed mode** | `check-verify.sh` is `100755` — #101's lesson applied on the next feature |
| **Suite** | 218/218 pass |

`timeout(1)` is absent on darwin, so the wave used a polling watchdog with a **marker file**
to distinguish a timeout from a command that chose to exit 143 — a SIGTERMed process and a
self-terminating one are indistinguishable by wait status alone. Verified working under both
bash 5.3 and `/bin/bash` 3.2.

**Open Question 4 (RAD_WORKTREE cwd) was asserted, not assumed**, as the plan required: the
script path resolves against `repoRoot` while cwd resolves to the worktree, confirmed with a
marker file in a stand-in worktree. `env -i` does not reset cwd, so declared commands execute
against the isolated tree.
