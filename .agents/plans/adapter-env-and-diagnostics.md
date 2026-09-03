# Plan: Command-Adapter Env Allow-List + Failure Diagnostics
Created: 2026-08-26
Author: architect
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-08-26T17:37:36.661Z
Recorded-By: sean@torchcodelab.com
Branch: rad/adapter-env-and-diagnostics

## Context

On 2026-08-20 the `insights-read-side-folds` deliver failed with a wave-1 error
recorded as, in full:

```
command exited with code 1:
```

Nothing after the colon. Two identical attempts, then the doom-loop breaker
aborted correctly. The failure was attributed to "no on-disk credentials on this
host" and the branch was parked.

Reproduced on 2026-08-26, and the attribution was incomplete:

| Run | Env | Result |
|---|---|---|
| A | the adapter's exact `ENV_ALLOW_LIST` | exit 1, `Not logged in · Please run /login` |
| B | full inherited env (control) | exit 0, normal reply |

Bisecting the stripped variables one at a time isolates it: `USER` alone restores
auth (`LOGNAME` and `SHELL` do not). The Claude Code CLI needs `USER` to resolve
its macOS Keychain credential; `ENV_ALLOW_LIST` at
`harness/adapters/agent/command.js:39` omits it. The credential was on the host
the whole time — the adapter stripped the one variable needed to reach it.

Two distinct defects, both in scope here:

1. **The allow-list is missing `USER`.** Any driven CLI resolving credentials by
   username fails to authenticate under the command adapter.
2. **The failure reason was captured and then discarded.** `command.js:216-218`
   builds its summary from `run.stderr` only. The CLI printed its diagnosis to
   **stdout**; stderr was empty. The explanation was in memory, in `run.stdout`,
   and never reached the event log — which is why a one-variable fix read as a
   credential problem for six days.

The second defect is the more consequential one: it converts any
stdout-reporting failure into an unactionable event. This plan fixes both.

## Scope
| In scope | Out of scope |
|---|---|
| `ENV_ALLOW_LIST` in `harness/adapters/agent/command.js` | `buildSdkEnv` in `adapters/agent/sdk.js` — different path; injects the key explicitly |
| `VERIFY_ENV_ALLOW_LIST` in `scripts/check-verify.sh` (the deliberately mirrored list) | Re-running or resuming the `insights-read-side-folds` deliver |
| The non-zero-exit error summary in `command.js` | The timeout (`fail-timeout`) and truncation (`fail-protocol`) paths |
| Tests for both, in the existing suites | Unifying the two allow-lists into shared code |

## Acceptance Criteria

1. When `USER` is set in the parent environment, the command adapter forwards it
   to the child; when unset in the parent, no `USER` key is added to the child env
   (absence, never an empty string).
2. `scripts/check-verify.sh` forwards `USER` on the same terms, so
   `VERIFY_ENV_ALLOW_LIST` and `ENV_ALLOW_LIST` remain identical and the
   "mirrors ENV_ALLOW_LIST" comment stays true.
3. When a command exits non-zero with **empty** stderr, the recorded error message
   carries a bounded excerpt of the child's stdout — so a CLI that reports
   `Not logged in · Please run /login` on stdout lands that text in the event log.
4. When stderr is **non-empty**, the message is byte-identical to today's: stderr
   wins and no stdout is appended. Existing behavior is unchanged.
5. The stdout fallback passes through `sanitizeErrorMessage` and the same 500-byte
   cap as the stderr path, so a credential printed on stdout is redacted exactly
   as one on stderr would be.
6. No credential-bearing variable is added to either allow-list. The
   "Secrets are NOT in this set" invariant on `command.js:38` still holds — `USER`
   is a username, not a secret — and the comment is updated to say so explicitly.

## Agent Scope

Architect-only: every touched path is inside RAD's self-protected set
(`^harness/`, `^scripts/`), so no severity auto-clear can apply and human
approval is mandatory. The Agent Scope Map declares no role-orchestrator over the
agent adapters, so wave tasks run under the default wave agent. No out-of-scope
dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/adapters/agent/command.js | 38-39, 216-221 | Add `USER` to `ENV_ALLOW_LIST`; fall back to a bounded stdout excerpt when stderr is empty on a non-zero exit |
| scripts/check-verify.sh | 63-65 | Add `USER` to `VERIFY_ENV_ALLOW_LIST`, keeping it identical to the adapter's list |
| harness/test/agent-adapters.test.js | 118-160, append | Extend the allow-list and non-zero-exit tests; add the stdout-fallback cases |
| scripts/test-check-verify.sh | append | Add a case asserting `USER` is forwarded and a non-allow-listed var is still stripped |

## Execution Notes

### Do Not Touch
- `harness/adapters/agent/sdk.js` — the SDK path builds its own env and injects
  `ANTHROPIC_API_KEY` explicitly; it is unaffected by this defect
- `harness/spine.js` — the spine reads outcomes, not error text; no change needed
- `.agents/state/insights-read-side-folds/events.jsonl` — a historical record;
  never rewrite a past event log
- The frozen 7-outcome vocabulary and `matrix.yaml` — this plan changes error
  *text*, never classification

### Key Files
- `harness/adapters/agent/command.js` — `ENV_ALLOW_LIST` (l.38-39),
  `buildChildEnv` (l.45-52), the non-zero-exit branch (l.216-221)
- `scripts/check-verify.sh` — `VERIFY_ENV_ALLOW_LIST` (l.63-65) and the comment
  at l.63-64 that declares it a mirror of the adapter's list
- `harness/test/agent-adapters.test.js` — the sentinel-leak test (l.137-160) is
  the model for the new env case; the non-zero-exit test (l.118-135) is the model
  for the fallback cases

### Reminders
- The two allow-lists are mirrored by convention, not by shared code. They must
  move in the same commit or the comment becomes a lie.
- `check-verify.sh` is bash 3.2 — indexed arrays only, no `declare -A`.
- The existing sentinel test proves *omission*. The new test must prove
  *inclusion* without weakening the omission guarantee — keep both assertions.
- Every touched path is self-protected, so `scripts/lint-plan.sh` will emit
  advisory warnings on this plan. That is expected, not a failure.

## Wave Plan

### Wave 1 — env allow-list parity
Verify: npm test --prefix harness && bash scripts/test-check-verify.sh

#### Task 1.1: Forward `USER` from the command adapter
File: harness/adapters/agent/command.js:38-39
What: Add `'USER'` to `ENV_ALLOW_LIST`. Update the adjacent comment to state that
the set carries process identity needed for credential lookup (`USER` resolves the
OS keychain entry) and that secrets remain excluded. `buildChildEnv` already skips
undefined keys, so an unset `USER` adds no key — do not add a default.
Validate: AC#1, AC#6 — extend the sentinel test in
`harness/test/agent-adapters.test.js:137-160` so the fake agent emits a valid
`WAVE_RESULT` only when the sentinel is absent AND `USER` is present; add a
sibling case that deletes `USER` from the parent env and asserts the child sees
no `USER` key (absence, not empty string).

#### Task 1.2: Forward `USER` from check-verify.sh
File: scripts/check-verify.sh:63-65
What: Add `USER` to `VERIFY_ENV_ALLOW_LIST` so the two lists stay identical, and
keep the "mirrors ENV_ALLOW_LIST" comment accurate. Change nothing else about the
`env -i` construction, the timeout, or the output cap.
Validate: AC#2 — add a case to `scripts/test-check-verify.sh` running a declared
command that prints `$USER` and a non-allow-listed sentinel; assert `USER` is
present and the sentinel is empty.

### Wave 2 — failure diagnostics
Verify: npm test --prefix harness

#### Task 2.1: Fall back to stdout when stderr is empty
File: harness/adapters/agent/command.js:216-221
What: In the `run.code !== 0` branch, when the sanitized stderr summary is empty,
build the summary from `run.stdout` instead, applying the same 500-byte slice and
the same `sanitizeErrorMessage` pass. Stderr keeps priority: a non-empty stderr
produces exactly today's string with no stdout appended. Mark the excerpt's origin
in the message (e.g. a `(stdout)` tag) so a reader knows which stream it came from.
Validate: AC#3, AC#4, AC#5 — three cases in
`harness/test/agent-adapters.test.js` modeled on the non-zero-exit test at l.118:
(a) exit non-zero writing only to stdout → the error contains that text;
(b) exit non-zero writing to stderr → the error is unchanged and contains no
stdout text; (c) exit non-zero writing >500 bytes of stdout → the excerpt is
capped and sanitized.

## Tests to Write
- [ ] `USER` present in the parent env is forwarded to the child — harness/test/agent-adapters.test.js
- [ ] `USER` absent from the parent adds no `USER` key to the child env — harness/test/agent-adapters.test.js
- [ ] the sentinel-secret omission guarantee still holds alongside the new inclusion — harness/test/agent-adapters.test.js
- [ ] check-verify.sh forwards `USER` and still strips a non-allow-listed var — scripts/test-check-verify.sh
- [ ] non-zero exit with empty stderr → error carries the stdout excerpt — harness/test/agent-adapters.test.js
- [ ] non-zero exit with non-empty stderr → error byte-identical to today, no stdout appended — harness/test/agent-adapters.test.js
- [ ] oversized stdout excerpt is capped at 500 bytes and sanitized — harness/test/agent-adapters.test.js

## Non-Goals
- Do not add `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or any other
  credential-bearing variable to either allow-list
- Do not widen the allow-list beyond `USER` — each addition is a separate,
  separately-justified decision
- Do not modify `harness/adapters/agent/sdk.js` or its env construction
- Do not unify the two allow-lists into shared code; that is a larger refactor
  with its own risk surface
- Do not re-run, resume, or re-approve the `insights-read-side-folds` deliver as
  part of this plan

## Out-of-Scope Dependencies
None.

## Risks
- **Widening a security allow-list sets precedent.** `USER` is a username, not a
  secret, so the "no exported credential reaches the child" property is preserved
  — but the justification must live in the comment, or the next addition will cite
  this one as license. Mitigation: AC#6 requires the comment to state the rule.
- **The stdout fallback could surface a secret a CLI prints on stdout.** Mitigated
  by routing it through the same `sanitizeErrorMessage` and 500-byte cap as the
  stderr path (AC#5) — the fallback is strictly no less redacted than the path it
  substitutes for.
- **The two allow-lists can drift.** They are mirrored by convention only. This
  plan keeps them in lockstep; a future change that touches one and not the other
  reintroduces the class of bug. Flagged, not fixed, by design.
- **Fixing the env unblocks authentication, not the wave.** A re-run of
  `insights-read-side-folds` may still fail for genuine reasons. This plan claims
  only that the failure will be *legible* — the recorded error will name a real
  cause instead of terminating at a colon.
