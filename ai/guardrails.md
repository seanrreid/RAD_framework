# Source: https://github.com/seanrreid/agent_guides — copy verbatim, update from source on sync.

# Coding Agent Guardrails

Use these rules when making code changes in any repository. The goal is to produce small, verifiable, maintainable changes that fit the existing system.

## Extension Loading

- Always apply this baseline.
- Before substantial edits, check for `ai/slop-register.md` and available files under `ai/extensions/`.
- Load an extension when its filename, `Applies When` section, changed paths, or the user request matches the task.
- Load the smallest relevant set. Do not load every extension by default.
- State which extensions were loaded. If none apply, say baseline only.
- If rules conflict, follow this precedence: user request, slop register, domain extension, baseline.
- Extensions may make rules stricter or more specific. Do not use an extension to silently weaken baseline safety rules.

## Before Coding

- Restate the task as concrete intent: scope, acceptance criteria, and what is out of scope.
- If the request is ambiguous in a way that could change the design, ask before editing.
- Prefer small, bounded tasks. Break broad work into phases with checkpoints.
- Identify the relevant files, tests, public APIs, schemas, and call sites before changing code.
- Do not start from a generic solution. Let the existing codebase patterns drive the implementation.

## Context Handling

- Load context selectively, but preserve complete logical units: files, functions, classes, interfaces, migrations, schemas, and tests.
- Do not rely on token-level summaries for code contracts, API signatures, error behavior, data shapes, or security rules.
- Keep current-task facts separate from durable project conventions.
- When context is large, prefer nearby tests, call sites, dependency boundaries, and existing implementations over unrelated broad scans.
- Treat conflicting context as a blocker to resolve, not as permission to guess.

## Implementation Rules

- Make the smallest change that satisfies the accepted intent.
- Reuse existing libraries, helpers, naming, logging, error handling, module boundaries, and test style.
- Do not introduce new abstractions, dependencies, background jobs, caches, retries, or framework patterns unless required by the task.
- Do not add defensive code that hides failures. Avoid broad catch blocks, swallowed errors, redundant logging, and silent fallbacks.
- Do not hallucinate APIs. Verify unfamiliar methods, config options, package behavior, and framework conventions against local code or official docs.
- Keep responsibilities in the right layer. Do not put auth, persistence, validation, formatting, or transport logic in unrelated modules.
- Preserve public contracts unless the task explicitly changes them and tests/docs are updated accordingly.
- Avoid speculative generality. Code for the known requirement, not imagined future variants.

## Verification

- Run the repository's relevant checks before finishing: formatter, lint, type check, tests, build, generated-code validation, migrations, or security scans as applicable.
- If a check fails, either fix the issue or clearly report why it could not be run or resolved.
- Add or update tests for changed behavior, bug fixes, public APIs, edge cases, and regression-prone paths.
- For UI work, verify the rendered experience at relevant viewports and interaction states.
- For data, auth, payments, security, migrations, or destructive operations, use stricter verification and avoid assumptions.

## Review Checklist

Before handing off, inspect the diff for these AI-specific failure modes:

- Plausible but incorrect logic.
- Over-engineered abstractions for a small task.
- Code that ignores local conventions.
- Hallucinated or deprecated APIs.
- Broad error handling that makes failures harder to debug.
- Cargo-cult retries, caching, circuit breakers, or validation.
- Duplicated behavior with a slightly different implementation.
- Changed public contracts without matching tests and callers.
- Responsibilities moved into the wrong module or layer.
- Large blast radius for a narrow request.

## Maintainability Sensors

Use deterministic tools where they exist, and treat them as feedback:

- Type checker and compiler errors.
- Formatter and linter output.
- Unit, integration, regression, and end-to-end tests.
- Dependency direction and circular dependency rules.
- Secret scanning and static security analysis.
- Dead code, unused exports, duplication, coverage, and mutation testing.
- Bundle size, performance budgets, migration checks, and generated-code drift.

If a repository does not configure these tools, do not invent commands. Report which checks were unavailable.

Use semantic review for issues deterministic tools cannot fully judge:

- Whether a high-coupling module is legitimate or harmful.
- Whether duplication reflects shared behavior that should be centralized.
- Whether a new abstraction matches likely change vectors.
- Whether the code is easier or harder to safely modify next time.

## Handoff

- Summarize what changed, where, and why.
- List verification performed and any checks not run.
- Call out residual risk, migrations, follow-up work, or assumptions.
- Do not claim completion if acceptance criteria are unmet.
