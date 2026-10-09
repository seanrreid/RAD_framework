---
{"kind": "event-type", "slug": "audit-only", "version": 1, "summary": "Add an audit-only event type: no phase, no gate authority, emitted at one spine site"}
---

# Event type: audit-only

## When to use

Use this for a new event type that **records what happened** and does nothing
else: it establishes **no phase** and carries **no gate authority**. A history
with the event folds identically to one without it. The shipped examples are
`run-resumed`, `push-check-unavailable` and `run-prepared` (#186 part 3b-i).

If the event must move a feature's phase, this playbook does not apply; see
Deviations.

## Steps

1. Add the type to the event typedef doc comment in `harness/events.js`,
   describing when it is appended, its `data` shape, and that it is audit-only.
2. Keep it **out of** `PHASE_BY_TYPE`, and add a line to the rationale comment
   beside that table saying why (it must never move a feature's phase).
3. Emit it at a single site in `harness/spine.js`, behind an **optional port**
   that defaults to the old behavior. Without the port the event sequence is
   byte-identical to before (`prepare = null` is the model).
4. Write the tests (below) and the docs.

## Files typically touched

| File | Change |
|------|--------|
| harness/events.js | the typedef doc comment, and the absence from `PHASE_BY_TYPE` with a rationale comment |
| harness/spine.js | the single emit site; the optional port defaulting to the old behavior (`runPrepare`) |
| harness/test/events.test.js | a fold test in the `run-resumed` style asserting `phaseOf` is unchanged |
| harness/test/spine-prepare.test.js | a spine order test and an absent-port baseline test; the helpers inject no-op or stub ports |
| docs/rad-wave-contract.md | where in the run the event is appended, and its data shape |
| docs/harness-state-store.md | the per-event paragraph beside `run-resumed is audit-only` |
| docs/rad-cli.md | the command-level behavior that produces it, when a command does |

## Tests and edge cases

- **Fold test.** Style of `run-resumed is audit-only: it establishes no phase
  and leaves the folded phase unchanged`: `phaseOf` of the event alone is
  `null`, and `phaseOf` and `reduce` of a history with it equal those without.
- **Spine order test.** The event lands at the documented position (for
  `run-prepared`: `deliver-started`, `run-prepared`, `wave-started`) with the
  port's `data`, `actor: 'harness'` and the right feature.
- **Absent-port baseline.** Without the port the event sequence is identical to
  a baseline run, and the type is absent (`absent prepare port → event
  sequence identical to a baseline run`). A `null` port behaves the same.
- **Helpers.** Every test helper that builds a spine either omits the port or
  injects a no-op, so existing sequences do not change.
- **Frozen histories.** Fold tests deep-freeze their input: the fold never
  mutates.

## Deviations to record

- A **phase-changing** event departs from this playbook. It needs a
  `PHASE_BY_TYPE` key, a `PHASE_ORDER` check, the terminal-phase rule in
  `harness/transitions.js` and any `gates.yaml` entry; the fold test above is
  replaced by transition and gate tests. Record the departure in the plan.
- An event with **authority** (a gate reads it) is likewise not audit-only.
- A new field on an existing event is not a new type; extend its paragraph
  (`run-prepared` gains `stashed: true` that way).

## Upgrade Guide

### Version 1 — 2026-10-09
First write-up, drafted from `run-prepared` (#186 part 3b-i) and the
`run-resumed` fold test.
