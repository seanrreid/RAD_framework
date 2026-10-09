---
{"kind": "env-knob", "slug": "timeout-style", "version": 1, "summary": "Add a RAD_* env knob that takes a positive integer (a timeout or a cap), parsed before any side effect"}
---

# Env knob: positive-integer style

## When to use

Use this for a new `RAD_*` environment variable whose value is a **positive
integer** that tunes `rad deliver` (a deadline in whole seconds, or a count
such as a cap). Unset or empty keeps the default; anything else that is not a
positive integer is an operator error, never a silent fallback. The shipped
examples are `RAD_WAVE_TIMEOUT_SECONDS` (#211, seconds, reaches the adapters)
and `RAD_MAX_FAILED_ATTEMPTS` (a count, opt-in, read by the spine).

## Steps

1. Add a named constant for the variable name beside the other `*_ENV`
   constants in `harness/cli.js` (for example `WAVE_TIMEOUT_ENV`).
2. Parse it with the digits-only matcher `POSITIVE_INTEGER_PATTERN`
   (`/^[1-9][0-9]*$/`): `undefined` or `''` keeps the default, a match is the
   value, anything else returns `{ ok: false, raw }`. Reuse `timeoutFromEnv`
   for a seconds value; a count gets its own small parser in the style of
   `maxFailedAttemptsFromEnv`.
3. Parse it **before any side effect** (no worktree, no event, no spawn). A
   malformed value writes `rad deliver: <NAME> must be a positive integer (got
   '<raw>')` to stderr and returns `USAGE_EXIT_CODE` (2).
4. Pass the parsed value to the consumer (an adapter option, or the spine).
5. Document it in `docs/configuration.md` and `docs/rad-cli.md`.

## Files typically touched

| File | Change |
|------|--------|
| harness/cli.js | the `*_ENV` constant and the digits-only parser (`timeoutFromEnv`, `maxFailedAttemptsFromEnv`), read before any side effect; the exit-2 report |
| harness/adapters/agent/command.js | the consumer, when the knob reaches an adapter (`timeoutMs`; `acp.js` takes it too); a spine knob has no adapter edit |
| docs/configuration.md | the line in the env list (`RAD_WAVE_TIMEOUT_SECONDS: <positive integer>`) plus a paragraph: default, malformed behavior, what ignores it |
| docs/rad-cli.md | the env table row, and the knob in the exit-2 row of the exit-code table |
| harness/test/cli.test.js | the malformed, valid and unset/empty cases, and the knob in every test env-clearing list (`ACP_ENV_BASE`) |

## Tests and edge cases

Name each case in the task's Validate field before implementing.

- **Malformed loop.** For each of `abc`, `0`, `-3`, `1.5`, ` 5`, `10s`:
  `rad deliver` exits 2, stderr includes the exact message, nothing is
  spawned, and the event log holds only `approved` (see `deliver — malformed
  RAD_WAVE_TIMEOUT_SECONDS` in `harness/test/cli.test.js`).
- **Valid value reaches the consumer.** A value of `1` visibly changes the
  behavior (a hanging wave times out at 1s in `deliver acp — RAD_WAVE_TIMEOUT_SECONDS
  reaches the adapter`).
- **Unset and empty keep the default.** Both `undefined` and `''` leave the run
  unchanged (`deliver acp — unset or empty RAD_WAVE_TIMEOUT_SECONDS keeps the
  default`).

Edge cases that need an explicit test or an explicit decision:

- Whitespace and zero are malformed (` 5`, `0`); empty is **not**.
- Parse before side effects, so a bad value leaves no worktree and no event.
- Skip validation when the feature is off (the preflight timeout is not
  validated under `RAD_AGENT_PREFLIGHT=off`).
- The SDK path ignores adapter timeouts: say so in both docs.
- Add the knob to every test env-clearing list, or a developer's shell leaks
  into the run.

## Deviations to record

A plan that departs from this shape records the departure in its Decisions or
Notes. The common ones:

- **A knob that counts instead of seconds** (`RAD_MAX_FAILED_ATTEMPTS`): no
  `* 1000`, so a dedicated parser rather than `timeoutFromEnv`.
- **A knob with an off value** (`RAD_AGENT_PREFLIGHT=off`): the exact off
  string is matched first and the integer check is skipped.
- **A knob with spine semantics** (a cap that stops the run): it changes the
  stop contract, so it needs a section in `docs/rad-wave-contract.md` (see its
  `RAD_MAX_FAILED_ATTEMPTS` section) and a stop key.

## Upgrade Guide

### Version 1 — 2026-10-09
First write-up, drafted from `RAD_WAVE_TIMEOUT_SECONDS` (#211) and
`RAD_MAX_FAILED_ATTEMPTS`.
