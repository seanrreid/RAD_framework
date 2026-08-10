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
