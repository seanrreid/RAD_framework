# Guardrail Integration Verification Guide

Branch: rad/guardrail-integration
Feature: guardrail-integration
Date: 2026-06-03

This document provides three structured verification scenarios confirming that the guardrail
integration feature behaves correctly. Because the deliverables are prose skill documents rather
than executable code, each scenario describes what to inspect and what output to expect.

---

## Scenario 1: Guardrail Extension Loading in rad-deliver

### Setup

Trigger a wave whose file list includes backend route files, for example:

```
src/routes/auth.ts
src/middleware/validate.ts
```

These paths must be present in the wave's declared file scope so that the prompt-construction
logic in `.claude/commands/team/rad-deliver.md` can evaluate the "Applies When" clauses of
each extension file.

### What to Inspect

1. Open `.claude/commands/team/rad-deliver.md` and locate the section that builds the
   sub-agent prompt for each wave. Look for logic that:
   - Always loads `ai/guardrails.md` as the baseline guardrail block.
   - Iterates over files in `ai/extensions/` and evaluates each extension's `Applies When:`
     field against the wave's file list.

2. In `ai/extensions/backend.md`, confirm the `Applies When:` clause matches patterns such as
   `src/routes/**` or `src/middleware/**`.

3. In `ai/extensions/security.md`, confirm the `Applies When:` clause matches patterns such as
   `src/routes/auth*` or any authentication/authorization path.

### Expected Output

The sub-agent prompt for the wave should contain a section that looks like:

```
## Guardrail Extensions

Baseline: ai/guardrails.md
Extensions loaded for this wave:
  - ai/extensions/backend.md  (matched: src/routes/auth.ts)
  - ai/extensions/security.md (matched: src/routes/auth.ts)
```

The exact label and indentation may vary, but all three documents (baseline plus both
matched extensions) must appear in the prompt before the task list begins.

### Pass Criterion

The wave sub-agent prompt contains a "Guardrail Extensions" (or equivalent) section that
lists `ai/guardrails.md` unconditionally, plus `ai/extensions/backend.md` and
`ai/extensions/security.md` because their "Applies When" clauses matched the wave's backend
and auth route files. No extension whose clause does not match the file list should appear.

---

## Scenario 2: rad-review Blocks on a Hard Violation

### Setup

Produce a diff that includes a broad catch block with no rethrow and no specific error
handling in a service-layer file, for example:

```typescript
// src/services/payment.ts
try {
  await processCharge(payload);
} catch (e) {
  logger.error(e);
}
```

Run `/rad-review` (or `team:rad-review`) against the branch containing this diff.

### What to Inspect

1. Open `ai/guardrails.md` and locate the checklist item covering error handling. It should
   include a rule equivalent to:
   > Broad catch blocks in service-layer code must either rethrow the error or handle each
   > error type specifically. Swallowing errors with only a log statement is a HARD violation.

2. Confirm that the item is classified as severity `HARD` (not `SOFT` or `ADVISORY`).

### Expected Output

The rad-review report must contain a FAIL header and a violation entry citing the file and
line number, for example:

```
## Review Result: FAIL

### Hard Violations

- [HARD] src/services/payment.ts:14 — Broad catch block swallows error without rethrow
  or specific handling. Rule: error-handling/no-swallow (ai/guardrails.md §3.2)
```

The report must conclude with a statement that the PR step must not proceed, for example:

```
HARD violations must be resolved before opening or merging the deliver PR.
```

### Pass Criterion

rad-review outputs a FAIL report that:
1. Cites `src/services/payment.ts` with the correct line number.
2. References the error-handling rule from `ai/guardrails.md`.
3. Explicitly states that the PR step (deliver PR creation or merge) is blocked until the
   violation is resolved. No deliver PR may be opened while the FAIL report stands.

---

## Scenario 3: rad-approve Produces a FLAG for Undefined Failure Semantics

### Setup

Create or use an existing plan file where one task reads:

```yaml
Wave: 2
Task: 2.3
What: Add retry logic for the payment processor
```

The task description (or its Acceptance Criteria) must not specify what happens when all
retries are exhausted — for example, it does not state whether to throw a terminal error,
return a sentinel value, emit a failure event, or dead-letter the request.

Run `/rad-approve` (or `architect:rad-approve`) on this plan.

### What to Inspect

The flag is triggered when rad-approve evaluates a task and finds that:
- The task introduces or modifies retry/fallback/resilience behavior, AND
- The plan text does not define terminal failure semantics (what happens after the last retry).

This signal type is labeled "Undefined failure semantics" in the flag output.

### Expected Output

The rad-approve output must include a FLAG block for the relevant wave and task, formatted
as follows:

```
FLAG  Wave 2, Task 2.3
Signal: Undefined failure semantics
Detail: Task introduces retry logic for the payment processor but does not specify
        the outcome when all retries are exhausted (e.g., throw, dead-letter, return error).
        Consider adding an explicit failure path to the task description or AC.
Blocking: NO — architect may approve despite this flag.
```

The architect may still record `Status: approved` on the plan's branch tip. The flag is
advisory: it surfaces a gap without preventing approval.

### Pass Criterion

rad-approve outputs a FLAG block that:
1. Identifies Wave 2, Task 2.3 (or whichever wave/task contains the undefined retry
   semantics).
2. Uses the signal type "Undefined failure semantics".
3. Includes a brief detail explaining what is missing from the plan text.
4. Explicitly states that the flag is non-blocking and the architect can still approve.
5. After the architect proceeds, `Status: approved` is written to the plan doc on the
   `rad/` branch tip, confirming approval was not prevented by the flag.
