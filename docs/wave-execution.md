# Wave Execution

How /rad-deliver runs tasks in waves, what parallel and sequential mean in
practice, and how to write good wave plans.

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

Each wave runs in a fresh sub-agent context. The main orchestrator (`/rad-deliver`)
invokes one sub-agent per wave, receives a `WAVE_RESULT` summary back, updates
the execution log, and decides whether to proceed. File contents from completed
waves never accumulate in the main context.

**Claude Code is single-threaded within a wave.** Parallel tasks don't run
simultaneously — the wave sub-agent executes them back-to-back, but treats
them as logically independent.

The practical difference:
- **Parallel wave**: the sub-agent executes all tasks back-to-back without
  waiting for human confirmation between them. Each task still gets its own commit.
- **Sequential wave**: the sub-agent executes each task and stops if any fails
  before moving to the next. The orchestrator reports the outcome after the wave.

Mark tasks as parallel when they're genuinely independent and you trust them
to run without a checkpoint between them. Mark tasks as sequential when each
one should be verified before the next begins.

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
- Each task should fit in ~50% of a fresh context window (the wave sub-agent's context)
- A task that touches more than one file is usually too big — split it
- **Context budget:** the total lines across all files in scope is checked by
  `lint-plan.sh`. Warn at >800 lines; error (blocks approval) at >1500 lines.
  If the linter flags your plan's budget, split into two plans before submitting.

---

## During execution

### Between parallel tasks
No confirmation needed. `/rad-deliver` runs them back-to-back. Each gets its
own commit. Review them all at wave completion.

### Between sequential waves
`/rad-deliver` outputs the wave completion summary and pauses:
```
✓ Wave 1 complete — 3 tasks, 3 commits

  Task 1.1: Add PlannedAbsence model ✓
  Task 1.2: Update streak calculation ✓
  Task 1.3: Add API routes ✓

Starting Wave 2 (sequential)...
```

You don't need to confirm — it continues automatically. But if you see something
wrong in the Wave 1 output, stop the session before Wave 2 begins.

### Task failures

If a task fails validation, `/rad-deliver` stops:
```
✗ Task 2.1: Add PlannedAbsence to schema
  Issue: Import fails — PlannedAbsence not exported from models.py
  Validation: uv run python -c "from app.schemas import PlannedAbsenceResponse"
  Error: ImportError: cannot import name 'PlannedAbsence' from 'app.models'

Options:
  1. Fix and retry this task
  2. Update the plan for this task and retry
  3. Stop — open a blocking issue on the plan PR
```

The plan task for Task 1.1 should have exported the model. Go back and fix
Task 1.1's output, then retry Task 2.1. This is the value of sequential waves —
the failure is caught before more tasks run on top of a broken foundation.

---

## Resuming interrupted execution

If a session ends mid-execution (crash, timeout, manual stop), resume by
running `/rad-deliver` with the same plan file in a new session:

```
/rad-deliver .agents/plans/add-planned-absences.md
```

`/rad-deliver` reads the execution log to find the last successfully committed
step and resumes from there. It does not re-run completed tasks.

The execution log is the resume state. This is why every completed task must
be committed and logged before moving to the next — the log is the checkpoint.

---

## Execution log format

The log at `.agents/logs/[feature]-[date].md` records every step:

```markdown
# Execution Log: Add Planned Absences
Plan: .agents/plans/add-planned-absences.md
Started: 2025-03-04T14:23:00
Branch: deliver/add-planned-absences

## Steps

| Step | Wave | Task | Status | Commit | Time |
|------|------|------|--------|--------|------|
| 1 | 1 (parallel) | Add PlannedAbsence model | ✓ | a3f2b1c | 14:24 |
| 2 | 1 (parallel) | Add streak calculation logic | ✓ | b4e9d2a | 14:26 |
| 3 | 2 (sequential) | Add API schema | ✓ | c5f1e3b | 14:29 |
| 4 | 2 (sequential) | Add route handlers | ✗ failed | — | 14:31 |
| 4 | 2 (sequential) | Add route handlers (retry 1) | ✓ | d6a2f4c | 14:34 |
```

The architect can read this log in the deliver PR to understand exactly what
happened during execution — useful context for code review.
