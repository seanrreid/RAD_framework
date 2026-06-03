# Plan: rad CLI foundation + approve cutover
Created: 2026-06-01
Author: architect
Status: complete
Completed-At: 2026-06-03T00:00:00Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-06-02T18:05:34Z
Branch: rad/harness-cli-approve
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/13
Issue-Title: Harness migration step 2: wire the spine to the Workflow tool + cut commands over

## Context
Harness step 1 (PR #12) shipped the deterministic core in `harness/` with the
StateStore port fully built — `recordApproval`, `gate('approved')`, `plan`,
`append`, `history`, and the `defaultSh` Bash boundary all exist and are
unit-tested. Issue #13's original "wire to the Workflow tool" framing was
**superseded on 2026-06-01 by architecture B** (see the issue comment): the spine
runs as a top-level `rad <verb>` Node CLI, not inside the Workflow sandbox. The
gap blocking B today is that **no CLI entry point exists** — there is no `bin`, no
argv dispatch. This plan builds that entry point and cuts the **no-model half**
(`/rad-approve`) over to it, proving the `rad <verb>` pattern end-to-end before the
heavier `runWave`/Agent-SDK/`rad deliver` work. That wave loop is deliberately a
separate follow-up (it needs `@anthropic-ai/claude-agent-sdk` + `ANTHROPIC_API_KEY`,
a new auth surface).

## Scope
| In scope | Out of scope |
|---|---|
| New `harness/cli.js` entry point + `bin` in `harness/package.json` | The `rad deliver` verb and wiring `runWave` to the Claude Agent SDK (follow-up) |
| `rad approve <feature>` subcommand wiring `recordApproval` + `gate('approved')` | Removing `Status:` from the plan doc / single-source-of-truth cutover (Decision 2 destination — follow-up) |
| Hand-rolled argv dispatch with `--help` (no new dependency) | The event-log (non-git) StateStore adapter (its own follow-up per Decision 6) |
| Make `/rad-approve` prose a thin wrapper that shells out to `rad approve` | Changing `defaultSh`, the StateStore adapter internals, or any `scripts/*.sh` |
| `node --test` coverage for dispatch + approve-records-event | `/rad-plan`, `/rad-design`, `/rad-status`, `/rad-research` cutovers |

## Acceptance Criteria
<!-- Numbered, testable outcomes. Every Wave task's Validate: field must cite one. -->
1. `node harness/cli.js --help` (and bare `node harness/cli.js`) exits 0 and lists
   available subcommands; an unknown subcommand exits non-zero with a usage message.
2. `rad approve <feature>` (via `node harness/cli.js approve <feature>`) appends a
   single `approved` event to that feature's `events.jsonl` via `recordApproval`,
   carrying `actor` and (when proxied) `recordedBy` + `evidence`; after it runs,
   `state.gate(feature, 'approved')` resolves `passed: true`.
3. `rad approve` refuses with a non-zero exit and a clear message when the running
   user is not a configured architect AND no valid `--on-behalf-of` + `--evidence`
   proxy pair is supplied (authority parity with the current prose command).
4. The `/rad-approve` command prose invokes the CLI rather than re-implementing the
   recording logic inline (no duplicated approval-write logic across the two).

## Agent Scope
No role-restricted agents were called. Research read `harness/adapters/git-state-store.js`,
`harness/spine.js`, `harness/package.json`, and `.claude/commands/architect/rad-approve.md`
directly.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/cli.js | new file | Entry point: argv dispatch, `--help`, `approve` subcommand, structured exit codes |
| harness/package.json | bin + maybe scripts | Add `"bin": { "rad": "./cli.js" }`; keep deps minimal (no new runtime dep) |
| .claude/commands/architect/rad-approve.md | Step 4–5 region | Replace the inline status-write/commit steps with a thin shell-out to `rad approve`; keep the review-summary + confirmation prose |
| harness/test/cli.test.js | new file | `node --test` cases for AC#1–3 (dispatch, approve-records-event, authority refusal) |

## Execution Notes

### Do Not Touch
- `harness/adapters/git-state-store.js`, `harness/adapters/git-artifact-store.js` —
  the ports are complete; the CLI composes them, it does not modify them.
- `harness/spine.js`, `harness/matrix.*`, `harness/gates.*`, `harness/events.js`,
  `harness/transitions.js`, `harness/fingerprint.js` — untouched by this increment.
- `scripts/*.sh` — called via the existing adapter, never modified.

### Key Files
- `harness/adapters/git-state-store.js` — exposes `createGitStateStore(...)` with
  `recordApproval({feature, actor, recordedBy, ts, evidence})`, async `gate(feature, name)`,
  `plan`, `append`, `history`, `list`, and exported `defaultSh`. The CLI is a thin
  composition layer over this.
- `.claude/commands/architect/rad-approve.md` — the prose to thin out; preserve its
  role-authority rules, proxy `--on-behalf-of`/`--evidence` semantics, and the
  human confirmation step. Only the *recording* mechanism moves into the CLI.
- `harness/test/` — existing `node --test` files are the convention to mirror
  (temp-repo fixtures, zero test deps).

### Reminders
- **Bootstrap parity, not a cutover of the gate authority.** `gate('approved')`
  currently wraps `scripts/check-plan-approved.sh`, which reads the plan doc's
  `Status:` line. To stay non-breaking, `rad approve` must BOTH append the
  `approved` event AND keep writing `Status: approved` (+ `Approved-By`/`Approved-At`,
  proxy fields) to the plan doc so `/rad-deliver`'s existing gate still passes.
  Dropping the doc `Status:` (Decision 2) is explicitly a follow-up, NOT this plan.
- No new runtime dependency — hand-roll argv parsing to match the harness's
  minimal-deps ethos (only `js-yaml` today). `bin` must have a `#!/usr/bin/env node`
  shebang and be executable.
- The CLI must not call a model or open a PR — `approve` is pure git/state work.
- Resolve `actor` (the approving architect) and `recordedBy` (the running git user)
  exactly as the prose command does, so the proxy audit trail is preserved.

## Wave Plan

### Wave 1 — sequential
Tasks must run in sequence: the subcommand and tests depend on the dispatch scaffold.

#### Task 1.1: CLI scaffold + dispatch
File: harness/cli.js (new), harness/package.json
What: Create `harness/cli.js` with a `#!/usr/bin/env node` shebang: parse `argv`,
dispatch on the first positional (`approve` for now), print a `--help`/usage
listing for `--help`, no args, or unknown subcommand (non-zero exit for unknown).
Add `"bin": { "rad": "./cli.js" }` to `harness/package.json`. Keep all control
flow deterministic and side-effect-free except the dispatched subcommand.
Validate: AC#1 — `node harness/cli.js --help` and bare invocation exit 0 with a
subcommand list; unknown subcommand exits non-zero with usage.

#### Task 1.2: `approve` subcommand
File: harness/cli.js
What: Implement `approve <feature> [--on-behalf-of <name>] [--evidence <text>]`.
Resolve `actor`/`recordedBy` and enforce architect authority (parity with the
prose rules: direct architect, or valid proxy pair). On success, call
`recordApproval(...)` to append the `approved` event, AND write the plan-doc
`Status: approved` header fields (bootstrap parity per Reminders), then report a
structured success line. Refuse with a non-zero exit + clear message on failed
authority or a proxy `--on-behalf-of` missing `--evidence`.
Validate: AC#2 — after running, the feature's `events.jsonl` has one `approved`
event and `gate(feature,'approved')` is `passed: true`; AC#3 — non-architect
without a valid proxy pair exits non-zero.

#### Task 1.3: Thin the `/rad-approve` prose
File: .claude/commands/architect/rad-approve.md
What: Replace the inline Step-4 status-write / Step-5 commit-recording prose with a
shell-out to `rad approve` (the CLI now owns recording). Preserve the review
summary, the human confirmation prompt, and the proxy semantics described in prose.
Validate: AC#4 — the command file delegates recording to the CLI; no duplicated
approval-write logic remains in the prose.

## Tests to Write
- [ ] CLI dispatch + help + unknown-subcommand exit codes — harness/test/cli.test.js
- [ ] `approve` records one `approved` event and satisfies the gate (temp-repo fixture) — harness/test/cli.test.js
- [ ] `approve` refuses a non-architect lacking a valid proxy pair — harness/test/cli.test.js

## Non-Goals
- No `rad deliver` verb and no Claude Agent SDK / `runWave` wiring — that is the
  follow-up increment and brings the `ANTHROPIC_API_KEY` auth surface.
- No removal of `Status:` from the plan doc — the doc stays the gate authority for
  now; the single-source-of-truth cutover is deferred (Decision 2 destination).
- No event-log (non-git) StateStore adapter — git adapter remains the bootstrap.
- No changes to other slash commands (`/rad-plan`, `/rad-status`, etc.).

## Out-of-Scope Dependencies
None — no architect-only agents required, and all composed code already exists.

## Risks
- **Dual-write divergence.** `rad approve` writes both the `approved` event and the
  plan-doc `Status:`. If the two ever disagree, `gate('approved')` (which checks
  both the event log and `check-plan-approved.sh`) could behave confusingly. Mitigated
  by doing both writes in one command path and committing them together; the
  follow-up removes the doc write entirely.
- **Authority-parity drift.** The CLI must reproduce the prose command's role/proxy
  rules exactly; a mismatch could let an unauthorized approval through. AC#3 guards
  the refusal path; the proxy success path is covered by AC#2.
- **`bin` install ergonomics.** `rad` on `PATH` requires `npm link`/install in
  `harness/`; until then it is invoked as `node harness/cli.js`. Tests and the prose
  wrapper use the `node harness/cli.js` form to avoid depending on a global link.

## Issue Gaps
- **Substrate reframed (B, not Workflow tool).** The issue body says "wire the spine
  to the Workflow tool"; that was superseded by architecture B on 2026-06-01 (issue
  comment + memory). This plan implements B. Architect: confirm the B framing is the
  one to plan against (it reflects your stated direction toward a `rad foo` CLI).
- **Scope split (assumption).** The issue bundles approve + deliver + state
  rendering. This plan takes only the no-model foundation (CLI + approve); `rad
  deliver` / `runWave` / `/rad-status` projection are assumed to be a follow-up
  issue. Architect: confirm the split, or say if deliver must land in the same cycle.
- **Bootstrap dual-write (assumption).** `rad approve` keeps writing the plan-doc
  `Status:` alongside the new event so `/rad-deliver`'s existing gate keeps working.
  This assumes we are NOT yet ready to make the event log the sole approval authority.
  Architect: confirm dual-write is the intended bridge vs. cutting the gate authority
  over to events now.
- **`bin` name `rad` (assumption).** Assumes the CLI verb namespace is `rad`
  (`rad approve`, later `rad deliver`). Architect: confirm the binary name.
