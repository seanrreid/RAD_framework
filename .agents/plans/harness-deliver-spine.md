# Plan: Harness Migration Step 1 — StateStore Core & Deliver Spine
Created: 2026-05-31
Author: developer
Status: complete
Approved-By: sean@torchcodelab.com
Approved-At: 2026-05-31T20:14:43Z
Completed-At: 2026-05-31T20:46:01Z
Branch: rad/harness-deliver-spine

## Context
RAD's orchestration is prose the model re-interprets each run; `docs/harness-state-store.md`
specifies migrating it into a code harness behind two ports (StateStore + ArtifactStore),
with deterministic control flow and declarative policy. This plan delivers **migration
step 1**: the deterministic, fully unit-testable core — the event model, the git StateStore
adapter (reproducing today's branch-tip behavior), the declarative stop-condition matrix and
gate rules, failure fingerprinting, and the `rad-deliver` spine's control flow with its MODEL
and Bash boundaries *injected* so it can be tested without a live model or real git. Wiring the
spine to the actual Workflow tool and cutting the prose commands over to it are deliberately a
later plan.

## Scope
| In scope | Out of scope |
|---|---|
| New `harness/` Node module: ports, git StateStore + ArtifactStore adapters | Rewiring `/rad-deliver` or `/rad-approve` prose commands to call the harness |
| Declarative `matrix.yaml` + `gates.yaml` and their loaders/evaluators | The event-log (non-git) StateStore adapter — the eventual "destination" |
| Event model: fold-to-phase, record-time transition validation, fingerprint | Any modification to existing `scripts/*.sh` guardrails (they are wrapped, not changed) |
| `deliverSpine()` deterministic control flow with injected `runWave`/`sh` | Live agent orchestration under the Workflow tool (the MODEL boundary is stubbed here) |
| Proxy-aware `approved` event construction (`actor` + `recordedBy`) | Changing the documented transition rules or branch model in the design doc |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. State is a pure fold: `reduce(history)` returns the correct phase, markers, and approvals for a given event list, computed with zero git access (unit-tested on in-memory event arrays).
2. Illegal transitions are rejected at record time: `validateTransition` throws on each defined illegal move (event after terminal, `wave-complete` when not in-progress, revision with no evaluator output, duplicate approval) and passes every legal move.
3. The stop-condition matrix is declarative and exhaustive: every applicable `(phase, outcome)` pair has an entry in `matrix.yaml`, a test fails if any applicable pair is missing (no default fallthrough), and `resolveOutcome(phase, outcome)` returns the declared `{action, to?}`.
4. Gate rules are declarative and evaluated from history: `gate('approved')` passes only when an `approved` event attributed to the architect role exists; a proxy approval (`actor` = architect, `recordedBy` = other) satisfies it while preserving both names in the trail.
5. Failure fingerprinting works: identical failure inputs produce identical fingerprints, and the spine aborts after two consecutive identical fingerprints (doom-loop breaker), verified with an injected `runWave`.
6. The git StateStore adapter reproduces today's behavior: `append` writes a git-tracked per-feature `events.jsonl`; `phase()`/`gate()` derive from that log; and the existing guardrail scripts are invoked unchanged (wrapped via `sh`, never edited).
7. The deliver spine's control flow is unit-testable end-to-end with injected boundaries: approval-gate block, wave `advance`, `retry`, doom-loop `abort`, and post-check → `pr-opened` sequencing all verified without a real model or real git.

## Agent Scope
Research performed by the Explore sub-agent only. No code-writing agents were called (this is
the framework's own repo; the Agent Scope Map in CLAUDE.md is an unpopulated template, so scope
is repo-wide framework development). No out-of-scope agents required.

## Files in Scope
<!-- New files; line numbers are size estimates the linter sums for the context budget. -->
| File | Lines | Change |
|------|-------|--------|
| harness/package.json | 1-25 | New Node module manifest: `node --test` script (zero-dep tests), `js-yaml` for policy parsing |
| harness/events.js | 1-95 | `Event`/`StateStore`/`ArtifactStore` JSDoc typedefs + `reduce(history)` fold → `{phase, markers, approvals}` |
| harness/transitions.js | 1-90 | `validateTransition(event, state)` + the legal-transition rule table; throws `TransitionError` on illegal moves |
| harness/matrix.yaml | 1-50 | Declarative `(phase, outcome) → {action, to?}` policy — the readable source of truth |
| harness/matrix.js | 1-70 | `loadMatrix()` + `resolveOutcome(phase, outcome)`; carries no policy of its own |
| harness/gates.yaml | 1-35 | Declarative gate rules: name → required event type, `requiredRole`, pass condition |
| harness/gates.js | 1-75 | `loadGates()` + `evaluateGate(name, history)` → `GateResult` |
| harness/fingerprint.js | 1-35 | `fingerprint(result)` = SHA-256 of failed categories + error summary |
| harness/adapters/git-state-store.js | 1-150 | Git adapter: `append` (validate→write per-feature `events.jsonl`), `history`, `phase` (fold), `plan` (parse doc), `gate` (gates.js + wrap `check-plan-approved.sh`/`check-role.sh`), `list`, proxy-aware `recordApproval` |
| harness/adapters/git-artifact-store.js | 1-85 | Git ArtifactStore: read/write plan docs on the work branch |
| harness/spine.js | 1-120 | `deliverSpine({state, docs, matrix, gates, runWave, sh})` — deterministic control flow with MODEL + Bash boundaries injected |
| harness/README.md | 1-15 | Module pointer to the design doc (entailed by Task 1.1; scope amended at delivery, architect-approved) |
| harness/.gitignore | 1-5 | Ignores `node_modules/` so the `js-yaml` install is not committed (scope amended at delivery, architect-approved) |
| harness/package-lock.json | 1-30 | Lockfile for the declared `js-yaml` dependency (scope amended at delivery, architect-approved) |

## Execution Notes

### Do Not Touch
<!-- These guardrail scripts are wrapped by the adapter, never modified (research do_not_touch). -->
- scripts/checkout-plan.sh — spine/adapter calls it; unchanged
- scripts/check-scope.sh — spine calls it; unchanged
- scripts/check-tests.sh — spine calls it; unchanged
- scripts/open-pr.sh — spine calls it; unchanged
- scripts/check-plan-approved.sh — logic wrapped by `git-state-store.gate()`; do not refactor
- scripts/check-role.sh — wrapped for approver attribution; do not refactor
- scripts/detect-platform.sh — platform dispatch used by open-pr.sh; do not refactor

### Key Files
<!-- Load before starting; these carry the context to execute correctly. -->
- docs/harness-state-store.md — the authoritative spec (ports L41-73, decisions 1-6, the spine example, the matrix/gates sections). Lives on the `rad/harness-audit` branch until merged.
- .claude/commands/team/rad-deliver.md — the 11-step prose being migrated; the spine must preserve its DET steps (gate, checkout, scope/test checks, open PR) and its MODEL wave boundary.
- .agents/findings.jsonl — the existing JSONL append-only precedent the event log mirrors (same format, different event types).
- scripts/check-plan-approved.sh — the current approval/status state machine the git adapter's `gate()` must reproduce.

### Reminders
- Substrate decision: step 1 introduces a JS toolchain under `harness/` using Node's **built-in** test runner (`node --test`, zero dev-deps) and one runtime dep (`js-yaml`) for policy parsing. If zero-runtime-deps is required, policy can move to JSON or a markdown-table parser — flag at approval.
- JS has no interfaces: express the StateStore/ArtifactStore contracts as JSDoc `@typedef`s so the adapters document their shape.
- The spine's `runWave` (MODEL) and `sh` (Bash) parameters are injected — tests pass fakes; step 2 wires them to a Workflow `agent()` call and a real shell-out. Do not call a real model or real `gh` from spine.js.
- Event log is git-**tracked**, one `events.jsonl` **per feature** (not git-ignored like Case, not one global file) — this is Decision 6.
- All policy is declarative (Decision 5): `matrix.js`/`gates.js` load and apply YAML; they must contain no hard-coded action/gate logic.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence: the manifest must exist before the modules it tests,
and the typedefs in `events.js` are imported by `transitions.js`.

#### Task 1.1: Scaffold the harness Node module
File: harness/package.json:1-25
What: Create the `harness/` module manifest with a `test` script using `node --test`, declare `js-yaml` as the single runtime dependency, set `"type": "module"`, and add a short README pointer to the design doc.
Validate: AC#1 — `npm test` (or `node --test`) runs in `harness/` and discovers the test directory, enabling the fold tests that prove AC#1.

#### Task 1.2: Event model and fold-to-state
File: harness/events.js:1-95
What: Define `@typedef` shapes for `Event` (`feature, type, actor, ts, recordedBy?, data?`), `StateStore`, and `ArtifactStore`; implement `reduce(history)` as a pure fold returning `{phase, markers, approvals}`. No git, no I/O.
Validate: AC#1 — unit test feeds event arrays and asserts the derived phase/markers/approvals; reduce never touches the filesystem.

#### Task 1.3: Record-time transition validation
File: harness/transitions.js:1-90
What: Implement `validateTransition(event, currentState)` plus the legal-transition rule table; throw a `TransitionError` on the defined illegal moves (event after terminal `done`/`delivered`, `wave-complete` when phase ≠ `in-progress`, `revision-requested` with no evaluator output, duplicate `approved`).
Validate: AC#2 — unit test asserts each illegal move throws and each legal move passes.

### Wave 2 — parallel
Depends on: Wave 1 complete. These three modules are independent of each other and depend only on Wave 1 types.

#### Task 2.1: Declarative stop-condition matrix + resolver
File: harness/matrix.yaml:1-50, harness/matrix.js:1-70
What: Author `matrix.yaml` mapping every applicable `(phase, outcome)` to `{action, to?}`; implement `loadMatrix()` and `resolveOutcome(phase, outcome)` that read it. The JS holds no policy.
Validate: AC#3 — exhaustiveness test fails on any missing applicable pair (no default fallthrough); `resolveOutcome` returns the declared action.

#### Task 2.2: Declarative gate rules + evaluator  ← parallel with 2.1, 2.3
File: harness/gates.yaml:1-35, harness/gates.js:1-75
What: Author `gates.yaml` (gate name → required event type, `requiredRole`, pass condition); implement `loadGates()` and `evaluateGate(name, history)` → `GateResult {passed, reason, requiredRole, satisfiedBy}`, including proxy-approval handling.
Validate: AC#4 — test: `gate('approved')` passes only with an architect-attributed `approved` event; a proxy approval (`actor`=architect, `recordedBy`=other) passes and exposes both names.

#### Task 2.3: Failure fingerprint  ← parallel with 2.1, 2.2
File: harness/fingerprint.js:1-35
What: Implement `fingerprint(result)` = SHA-256 over the failed-check categories + error summary, normalized so equivalent failures hash equally.
Validate: AC#5 — test: identical failure inputs produce identical fingerprints; differing failures differ.

### Wave 3 — sequential
Depends on: Wave 1 (events/transitions) and Wave 2 (gates). The two adapters are written in sequence to keep the shared `sh()` shell-wrapper convention consistent.

#### Task 3.1: Git StateStore adapter
File: harness/adapters/git-state-store.js:1-150
What: Implement the StateStore against git: `append` (calls `validateTransition`, then writes a git-tracked per-feature `events.jsonl`), `history` (reads + parses the log, skipping unparseable trailing lines), `phase` (via `reduce`), `plan` (parse the plan doc), `gate` (delegate to `evaluateGate`, wrapping `check-plan-approved.sh`/`check-role.sh` via `sh`), `list`, and proxy-aware `recordApproval({feature, actor, recordedBy})`.
Validate: AC#6 — test against a temp git checkout: `append` writes the JSONL and rejects illegal transitions; `phase()`/`gate()` derive from the log; wrapped scripts are invoked unmodified.

#### Task 3.2: Git ArtifactStore adapter
File: harness/adapters/git-artifact-store.js:1-85
What: Implement `read(feature, name)` / `write(feature, name, content)` for plan/research/log documents on the work branch — git holds the documents (Decision 3, the document half of the seam).
Validate: AC#6 — test: writing then reading a document round-trips on a temp branch; status is never written into the doc (it is a projection, Decision 2).

### Wave 4 — sequential
Depends on: Waves 1–3 complete.

#### Task 4.1: Deliver spine control flow
File: harness/spine.js:1-120
What: Implement `deliverSpine({state, docs, matrix, gates, runWave, sh})`: enforce the `approved` gate (block + return on fail); append `deliver-started`; per-wave loop — call injected `runWave`, append `wave-attempt`, compute `fingerprint`, abort on a repeated fingerprint, else `resolveOutcome('implement', outcome)` and act (`advance`→`wave-complete`/return, `retry`|`revision`→loop, `abort`|`surface`→fail); then post-checks via injected `sh` (`check-scope.sh`, `check-tests.sh`, `open-pr.sh`) and append `pr-opened`. No real model or `gh` calls.
Validate: AC#7 — tests with injected `runWave`/`sh` cover: gate block, advance-to-PR happy path, retry-then-advance, and doom-loop abort (AC#5); post-checks run in order and `pr-opened` is appended only after they pass.

## Tests to Write
- [ ] reduce/fold correctness on in-memory event arrays — harness/test/events.test.js
- [ ] validateTransition throws on illegal moves, passes legal ones — harness/test/transitions.test.js
- [ ] matrix exhaustiveness (no missing applicable pair) + resolveOutcome — harness/test/matrix.test.js
- [ ] gate evaluation incl. proxy approval attribution — harness/test/gates.test.js
- [ ] fingerprint equality/inequality — harness/test/fingerprint.test.js
- [ ] git StateStore append/validate/phase/gate over a temp checkout — harness/test/git-state-store.test.js
- [ ] ArtifactStore document round-trip — harness/test/git-artifact-store.test.js
- [ ] deliverSpine control flow with injected runWave/sh (gate block, advance, retry, doom-loop abort, post-check ordering) — harness/test/spine.test.js

## Non-Goals
- Not rewiring the existing `/rad-deliver` or `/rad-approve` prose commands to call the harness — the command cutover is a separate, later plan.
- Not building the event-log (non-git) StateStore adapter or any non-git backend — the git adapter is step 1; the event-log adapter is the eventual destination, planned later.
- Not modifying any `scripts/*.sh` guardrail — they are wrapped and called, never changed.
- Not implementing live agent orchestration under the Workflow tool — the spine's MODEL boundary (`runWave`) is injected/stubbed in step 1.

## Out-of-Scope Dependencies
The design doc (`docs/harness-state-store.md`) already ratified the decisions this plan implements
(Decisions 1–6, including the proxy-approval attribution model and the log-derived state machine).
No architect-only agents are required to build the substrate. Two items remain genuinely the
architect's call and are surfaced for the approval step rather than worked around:
- The `harness/` JS toolchain and the `js-yaml` runtime dependency (substrate from the audit's Workflow-tool decision) — confirm or request the zero-dep alternative.
- The eventual cutover of the prose commands to the harness, and the event-log adapter — explicitly deferred to follow-up plans.

## Risks
- Introduces a JS/Node toolchain into a repo that is currently shell + markdown. Mitigated by isolating it under `harness/`, using Node's built-in test runner (no test-framework dependency), and changing no existing script or command.
- The git StateStore adapter must reproduce `check-plan-approved.sh`'s exact status resolution (work-branch tip → merged → local). Mitigated by wrapping the script rather than reimplementing its logic, and by the AC#6 temp-checkout test.
- Context budget: the Files-in-Scope estimate (~825 lines) is over the linter's 800-line warning threshold but well under the 1500 error threshold; the work is spread across four waves so no single context loads everything.
- The design doc lives on `rad/harness-audit` and is not yet on the default branch; the work branch is cut from default, so executors must reference the spec from the audit branch until it merges.
