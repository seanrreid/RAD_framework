# Wave Execution

How `rad deliver` (the command behind `/rad-deliver`) runs tasks in waves, what
parallel and sequential mean in practice, and how to write good wave plans.

---

## What waves are

A wave is a group of tasks with the same dependency profile. Tasks in the same
wave have no dependency on each other. Tasks in later waves depend on earlier
waves being complete.

This is borrowed from GSD's execution model and adapted for RAD's information
boundary constraints.

```
Wave 1 (parallel)     Wave 2 (sequential)    Wave 3 (parallel)
──────────────────    ────────────────────   ──────────────────
Task 1.1              Task 2.1               Task 3.1
Task 1.2         →    (depends on 1.x)  →    Task 3.2
Task 1.3                                     Task 3.3
```

---

## Parallel vs sequential — what it actually means

Each wave runs as one call to the agent configured as `agent:` in
`.rad/config.yml` (e.g. `claude -p` or `codex exec`), in an isolated git worktree
by default. The agent gets a wave prompt, works through the wave's tasks, and
returns a `WAVE_RESULT` block. `rad deliver` reads that result, runs the
between-wave checks, and decides what happens next. File contents from completed
waves never pass to the next wave's agent.

**Tasks within a wave run one after another.** Parallel tasks don't run
simultaneously — the wave agent executes them back-to-back, but treats them as
logically independent. The wave type is part of the wave prompt; in either kind
of wave, the agent stops at a task it can't complete and reports it.

Mark tasks as parallel when they're genuinely independent. Mark tasks as
sequential when each one depends on the one before it.

---

## Writing good wave plans

### Rules for wave assignment

**Same wave (parallel) when:**
- The tasks read/write different files
- Task B doesn't use the output of Task A
- Either task could run first without affecting the other

**Different waves (sequential) when:**
- Task B imports or calls something created by Task A
- Task B's behavior depends on Task A's output
- Task A creates a schema/type that Task B uses

**Common mistakes:**

```
# Wrong — Task 1.2 reads the model created by Task 1.1
Wave 1 (parallel)
  Task 1.1: Add PlannedAbsence SQLAlchemy model
  Task 1.2: Add PlannedAbsence to API response schema  ← depends on 1.1!

# Correct
Wave 1 (sequential)
  Task 1.1: Add PlannedAbsence SQLAlchemy model

Wave 2 (sequential)
  Task 2.1: Add PlannedAbsence to API response schema
```

```
# Wrong — sequential when truly independent
Wave 1 (sequential)
  Task 1.1: Update CalendarDay component styles
  Task 1.2: Update HabitList component styles  ← completely independent!

# Correct
Wave 1 (parallel)
  Task 1.1: Update CalendarDay component styles
  Task 1.2: Update HabitList component styles
```

### Size rules

- Max 3 tasks per wave — if you need more, add another wave
- Max 5 waves per plan — if you need more, split into two plans
- Each task should fit in ~50% of a fresh context window (the wave agent's context)
- A task that touches more than one file is usually too big — split it
- **Context budget:** the total lines across all files in scope is checked by
  `lint-plan.sh`. Warn at >800 lines; error (blocks approval) at >1500 lines.
  If the linter flags your plan's budget, split into two plans before submitting.

---

## During execution

Waves run back-to-back without pausing for confirmation. After each wave,
`rad deliver` runs the between-wave checks, including a test gate for the test
files promised by the waves completed so far. Test files no wave promises get one
end-of-run test wave, then a final check (stop `tests-missing`).

### Task failures

What happens after a failed wave is harness behavior, not a choice the calling
agent makes. Retries, the outcome rules, the token budget, hooks and the
doom-loop breaker live in `harness/spine.js` and `harness/matrix.yaml`. A run
that can't continue stops with an exit code:

| Exit | Meaning |
|---|---|
| 0 | Delivered |
| 1 | Failed — fix the plan or code, then re-run |
| 2 | Usage or config problem (e.g. no `agent:`) |
| 3 | Needs a decision |

This is still the value of sequential waves — the failure is caught before more
tasks run on top of a broken foundation.

---

## Resuming a stopped run

On exit 3, `/rad-deliver` shows you the decision and stops. Once you answer, the
run resumes with your answer as context:

```bash
node harness/cli.js deliver add-planned-absences --resume --context "<your answer>"
```

After a failed run (exit 1), fix the cause and re-run `/rad-deliver` — no
`--resume` needed. See [Resuming a stopped run](rad-cli.md#resuming-a-stopped-run)
for the details.

---

## The record of a run

The event log at `.agents/state/[feature]/events.jsonl` is the record of a run:
approval, each wave's outcome, retries, stops and the opened PR. `rad digest
<feature>` summarizes it for review. Wave agents may also append to an execution
log under `.agents/logs/`, but it's optional and nothing gates on it.

See [`rad deliver`](rad-cli.md#rad-deliver) for the full lifecycle.
