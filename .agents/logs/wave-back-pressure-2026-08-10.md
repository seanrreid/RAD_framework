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
| 13 | Wave 5 | Spine and CLI test coverage | ✓ complete | ce3b8ab | 12:22 |
| 14 | Wave 5 | `scripts/test-check-verify.sh` | ✓ complete | 12c200b | 12:31 |
| 15 | Wave 5 | Document the `Verify:` line | ✓ complete | ca6feb8 | 12:44 |

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

## Wave 4 — architect notes (closes #90)

### Concern raised (Task 4.3) and ruled on: the new `capture-failed` event type

Task 4.3 introduced a new event type, `capture-failed`, appended only on the fail-open
degrade path when `priorFailure` capture throws.

Ruling: **name ratified; behavior correct; documentation gap routed to Wave 5.**

- **Name accepted.** It follows the established `hook-failed` precedent for an observe-only
  failure that must never change flow, and `data.what: 'prior-failure'` disambiguates what
  was being captured.
- **Its absence from `PHASE_BY_TYPE` is correct, not an oversight.** `events.js` treats
  deliberate omission as the mechanism for audit-only events — the same treatment given
  `architecture-approved`, `owner-claimed`, and `owner-released`. An unmapped type
  establishes no phase, so the fold is unaffected.
- **But that file documents its deliberate absences in a comment, and `capture-failed`
  appears nowhere in `events.js`** — not in the `Event` typedef union (line ~21), not in the
  absence comment (line ~133). Correct behavior a reader cannot infer is exactly the defect
  family the sibling #98/#99/#101 delivery just closed. `harness/events.js:16-50` is in this
  plan's declared Files in Scope, so **Wave 5 must document it in both places.**

### Orchestrator verification

- `npm test --prefix harness` → **218/218 pass**, unchanged.
- `gates.js`, `matrix.yaml`, `check-tests-present.sh` — zero diff vs `origin/main`.
- **Doom-loop and `MAX_ATTEMPTS` untouched**: the only `spine.js` diff lines matching
  `MAX_ATTEMPTS|doom-loop|fingerprint` are added *comments* recording that the capture sits
  after the fingerprint decision and never feeds it. No logic moved.
- **Event-type vocabulary** is now the frozen 7 outcomes plus 9 event types; the 7-outcome
  matrix vocabulary gained nothing, as required.

### Truncation cap — the value the plan left to the delivering wave

`PRIOR_FAILURE_FIELD_MAX_CHARS = 4000`, deliberately tighter than the producer's own bound
(`check-verify.sh` caps at 40 lines / 8000 bytes) so the prompt stays bounded even for text
that never passed through that script. Applied unconditionally to both the excerpt and the
reported error, keeping the tail and stating when it bit. **Flagged for Gate 2 review** — the
plan explicitly reserved this number for the architect.

### What #90 actually required

The wave demonstrated attempt 1's prompt ≠ attempt 2's prompt, with attempt 2 carrying the
prior outcome, the blocking task's title/status/error, and the bounded verify excerpt. That
is the #90 defect ("bounded retries re-send an identical prompt") closed. AC#4 byte-parity
was demonstrated by `cmp` against `origin/main`'s `buildWavePrompt` (2517/2517 and 2426/2426
bytes identical), and AC#8 fail-open by forcing the capture to throw — attempt 2 still ran
with a prompt byte-identical to attempt 1's, and the reason was recorded rather than
swallowed.

## Wave 5 — test + documentation notes

Guardrails loaded: `ai/guardrails.md` (baseline), `ai/extensions/testing.md` (mandatory —
every file this wave is a test), `ai/extensions/security.md` (the env allow-list regression
test is an input-handling / data-exposure boundary). `frontend.md` / `database.md` /
`backend.md` do not apply — no UI, schema, or server-route paths in scope.

### Every test passed on its FIRST run against Waves 1–4

Nothing written this wave initially failed. No implementation was touched — the only
non-test source edit is a comment-and-typedef change in `harness/events.js` (Task 5.3's
`capture-failed` documentation), which the plan lists in Files in Scope and which adds no
key to `PHASE_BY_TYPE` and therefore no behavior.

### Coverage added

| Suite | Cases | What it pins |
|---|---|---|
| `harness/test/spine.test.js` | 9 (`w5-a`…`w5-g`) | Absent-`Verify:` parity (two runs deep-equal, `verify` key ABSENT, `check-verify.sh` never invoked), delegation through the `sh` port with one argument, presence-gate short-circuit, failure demotion inside the frozen vocabulary, `fail-timeout` on 124 with no retry, `priorFailure` threading, and the fail-open capture |
| `harness/test/cli.test.js` | 3 | `parseWaveVerify` via `parsePlanCtx`: capture under `### Wave N`, an EMPTY map when nothing is declared, and the edge cases (blank value, `####` subheading stays inside, non-Wave heading closes the block) |
| `harness/test/agent-contract.test.js` | 8 | `tasks` pass-through, malformed degradation to OMISSION across eight shapes, outcome-drift parity vs `resultToOutcome`, and the prompt section (absence byte-identical, truncation asserted to bite on excerpt AND task error) |
| `scripts/test-check-verify.sh` | 14 assertions, new file | Explicit exit codes for pass/fail/truncation/usage/stderr/timeout, plus env containment |

### The absent-declaration guarantee, pinned two ways

The single most important property was tested at both ends of the seam: at the parser
(`parsePlanCtx` returns `{}` for a plan with no `Verify:`) and at the spine (a run with
`waveVerify` omitted and a run with `waveVerify: {}` append **deep-equal** event arrays, and
every `wave-attempt` carries exactly `['wave','outcome','usage']`). The `verify` and `tasks`
keys are asserted ABSENT with `in`, not merely `undefined` — the distinction that makes the
byte-for-byte claim real.

### Env containment carries a negative control

`A7` asserts a non-allow-listed variable never reaches the executed command. On its own that
assertion would also pass if the command never ran at all, so `A7b` inverts it (asserting the
canary IS visible, and requiring that to fail) and `A7c` confirms allow-listed `PATH` does
arrive. The suite also refuses to run vacuously: it checks the canary is exported in its own
environment first.

### Timing

`scripts/test-check-verify.sh` runs in **1.4s** — the timeout case uses
`RAD_VERIFY_TIMEOUT_SECONDS=1`, never the 600s default. The whole point of the env override
is that the timeout PATH is testable without a ten-minute wait.

### Verification

| Check | Result |
|---|---|
| `npm test --prefix harness` | **239/239 pass** (was 218/218 — +21 harness cases, 0 fail) |
| `bash scripts/test-check-verify.sh` | **ALL PASS**, 14 assertions, **1.4s** |
| Every `scripts/test-*.sh` (15 suites) | **ALL PASS** |
| `harness/gates.js`, `harness/matrix.yaml` | **zero diff vs `origin/main`** |
| `scripts/check-tests-present.sh` | zero diff vs `origin/main` — the presence gate stays distinct (#91) |
| `git ls-files -s scripts/test-check-verify.sh` | **100755** — #101's lesson held |

### Two discrepancies for Gate 2

1. **`buildWavePrompt` signature.** The wave brief described
   `buildWavePrompt(wave, planCtx, priorFailure?)`; Wave 4 actually shipped
   `buildWavePrompt(wave, planCtx)` reading `planCtx.priorFailure`, which is what the
   `cli.js` binding (`adapter(wave, { ...planCtx, ...attemptCtx })`) feeds it. The tests are
   written against the shipped signature — it is the coherent one, since the spread binding
   has no third argument to pass. Recorded, not "fixed".
2. **AC#6's literal wording.** AC#6 says a malformed/absent `tasks` "degrades to omission —
   never `fail-protocol`", but `resultToOutcome({})` is still `fail-protocol` (pre-existing
   and ratified in Wave 1). The tests encode the ratified reading: the *pass-through* degrades
   to omission and never changes the outcome, asserted as
   `toWaveResult(p).outcome === resultToOutcome(p)` across seven shapes. If the architect
   intended the literal reading, that is a behavior change to `resultToOutcome` — out of scope
   here and deliberately not made.

## Wave 5 — test coverage and documentation

| Step | Wave | Task | Status | Commit |
|------|------|------|--------|--------|
| 13 | Wave 5 | Spine and CLI test coverage | ✓ complete | ce3b8ab |
| 14 | Wave 5 | `scripts/test-check-verify.sh` | ✓ complete | 12c200b |
| 15 | Wave 5 | Document the `Verify:` line | ✓ complete (concerns) | ca6feb8 |

Harness suite **218 → 239** (+21). `test-check-verify.sh` runs in ~2s (the timeout case
uses `RAD_VERIFY_TIMEOUT_SECONDS=1`, never the 600s default) and is committed `100755`.
No test failed on first run against Waves 1-4 — no implementation was changed to make a
test pass.

Wave 5 also closed the two documentation gaps the orchestrator routed to it:
`RAD_VERIFY_TIMEOUT_SECONDS` is now documented in CLAUDE.md's RAD Configuration block, and
`capture-failed` is documented in `events.js` — in the `Event` typedef union and in the
deliberate-absence comment beside `PHASE_BY_TYPE`, with **no new map key**, so the fold is
untouched.

### Second discrepancy raised and ruled on: `buildWavePrompt` signature

The plan's Program Design specifies `buildWavePrompt(wave, planCtx, priorFailure?)`.
Wave 4 shipped `buildWavePrompt(wave, planCtx)`, reading `planCtx.priorFailure`.

Ruling: **shipped is correct.** The provider-neutral contract defines the adapter as
`adapter(wave, planCtx)` — two arguments — and `cli.js` binds
`runWave = (wave, attemptCtx) => adapter(wave, { ...planCtx, ...attemptCtx })`. A third
positional argument would have widened the contract that `docs/rad-wave-contract.md`
defines. This is the **second** Program Design signature that proved inaccurate (the first
being `check-verify.sh <feature> <command>`); in both cases the wave resolved in favor of
the real constraint, which was right.

The AC#6 "never fail-protocol" conflict Wave 5 re-raised was already ruled on in Wave 1;
the tests encode the ratified reading.

## Gate 2 — final state

| Check | Result |
|---|---|
| Harness suite | **239/239 pass** (216 baseline) |
| Shell suites | all 15 PASS |
| Scope gate | **PASS** — 14 files, all within declared scope |
| Tests-present gate | PASS — 10 test files |
| Approval integrity | PASS after **two** rebases (fingerprint, gate, authenticity) |
| Frozen surfaces | `gates.js`, `matrix.yaml`, `check-tests-present.sh` — zero diff |
| Outcome vocabulary | exactly the frozen 7 |

**Blocked and unblocked at Gate 2.** The scope gate initially failed on
`.agents/research/wave-back-pressure.md` — the branch's own first commit (2026-08-04),
untouched by any wave. Cause: `.agents/research/` was missing from `check-scope.sh`'s
`ALWAYS_ALLOW_PREFIXES` while logs/plans/state were all exempt. It could not be fixed from
inside this delivery: amending the plan's Files in Scope would invalidate the approval
fingerprint, and RAD has no re-approval path (#39). Fixed separately in **PR #104** and
merged; this branch was then rebased and the gate passes.

**Transient test note:** one loop run reported `test-check-tests-present.sh` failing. Not
reproducible — it passed standalone and in two subsequent full loop runs. The failing run
executed concurrently with `npm test --prefix harness`; that suite spawns processes while
this test's B1 case greps tracked files. Recorded rather than dismissed.

**For architect review at Gate 2:**
- Truncation cap `PRIOR_FAILURE_FIELD_MAX_CHARS = 4000` — the plan reserved this number
  for the architect.
- Exit code **124** is reserved for timeout; a command genuinely exiting 124 surfaces
  rather than retries (GNU `timeout(1)` convention, conservative).
- New event type `capture-failed` — name ratified, audit-only, establishes no phase.
- Two Program Design signatures were inaccurate; both resolved in favor of the constraint.
