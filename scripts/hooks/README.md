# Wave-Lifecycle Hooks

Operator-supplied scripts the deliver spine fires at fixed points in the wave
loop. OPTIONAL and backward-compatible: an absent `scripts/hooks/` directory is
a clean no-op — deliver behaves exactly as it did before hooks existed. The
runner contract lives in `harness/hook-runner.js`; this README is its companion.

## Convention layout

Drop an **executable** script into `scripts/hooks/<point>/`. Discovery lists the
files directly under that directory and runs them in **lexical filename order**:

```
scripts/hooks/
  pre-wave/
    10-guard.sh        # runs first
    20-policy.sh       # runs second
  post-wave/
    10-coverage.sh
  on-error/
    10-notify.sh
```

A file is only discovered when it is a regular file **with an executable bit**
(owner/group/other, `0o111`). Non-executable files and the committed `.sample`
hooks here are inert: the runner skips them. Subdirectories are ignored.

Override the root directory with `RAD_HOOKS_DIR` (default: `scripts/hooks`).

## The six lifecycle points

| Point           | Class         | Fires                                              |
|-----------------|---------------|----------------------------------------------------|
| `pre-wave`      | veto-capable  | before the agent runs for an attempt               |
| `post-wave`     | veto-capable  | after the wave result, before the per-wave gate    |
| `on-outcome`    | observe-only  | after the matrix resolves the outcome              |
| `on-retry`      | observe-only  | in the retry/revision branch                       |
| `on-error`      | observe-only  | at a wave-failed terminal (doom-loop/abort/budget) |
| `wave-complete` | observe-only  | as a wave is recorded complete                     |

**Veto-capable** (`pre-wave`, `post-wave`): a hook MAY abort or redirect the
wave. **Observe-only** (the other four): a hook may only watch — it can never
change flow.

## Invocation contract

Each hook is executed with four positional arguments and four `RAD_HOOK_*`
environment variables carrying the same values:

| Position | Env                | Value                                        |
|----------|--------------------|----------------------------------------------|
| `$1`     | `RAD_HOOK_FEATURE` | the feature name                             |
| `$2`     | `RAD_HOOK_WAVE`    | the wave number                              |
| `$3`     | `RAD_HOOK_POINT`   | the lifecycle point (e.g. `post-wave`)       |
| `$4`     | `RAD_HOOK_OUTCOME` | the wave's current outcome (empty pre-wave)  |

### Exit code and stdout

- **Observe-only points** — exit code is advisory. A non-zero exit (or a crash)
  records a `hook-failed` signal but NEVER vetoes and NEVER changes flow. This
  is **fail-open**: a broken observer cannot derail a deliver. stdout is ignored.

- **Veto-capable points** — **fail-closed**. The runner reads the first non-empty
  whitespace-delimited token of the first non-empty stdout line:
  - **exit 0 + token `success`** → explicit pass, no veto.
  - **exit 0 + any other in-vocabulary token** → a deliberate veto with THAT
    outcome (e.g. `fail-scope`).
  - **non-zero exit, a crash, empty stdout, or an out-of-vocabulary token** →
    treated as a veto resolving to the fixed `abort-user` outcome.

Veto outcomes reuse the frozen 7-outcome vocabulary (`matrix.yaml`); a hook
cannot invent a new outcome:

```
success | fail-tests | fail-scope | fail-protocol | fail-timeout | no-changes | abort-user
```

### First-veto-wins

At a veto-capable point the hooks run in lexical order until the first veto;
the remaining hooks at that point are skipped. A `pre-wave` veto aborts the
wave without running the agent; a `post-wave` veto REPLACES the wave's outcome
and routes it through the matrix.

## Sample hooks

Two committed examples sit alongside this README with a `.sample` suffix (and no
executable bit), so the runner will not pick them up. Copy one, drop the
`.sample`, and `chmod +x` it to activate.

`post-wave/10-example-veto.sh.sample` — veto-capable, fail-closed:

```sh
#!/bin/sh
# $1=feature $2=wave $3=point $4=current-outcome
# Print exactly one frozen-vocabulary token on stdout, exit 0.
# 'success' = pass; any other token = veto with that outcome.
if [ -f .block-delivery ]; then
  echo fail-scope   # veto: route through the matrix as fail-scope
else
  echo success      # explicit pass
fi
```

`on-error/10-example-observe.sh.sample` — observe-only, fail-open:

```sh
#!/bin/sh
# $1=feature $2=wave $3=point $4=current-outcome
# Observe only: stdout is ignored; a non-zero exit is recorded but never vetoes.
echo "wave $2 failed at $3 (outcome=$4) for $1" >> /tmp/rad-hook.log
exit 0
```

## Backward-compatibility guarantee

With no hooks directory (or an empty one) the runner returns a neutral result
and the spine appends a byte-for-byte identical event sequence to today's. Hooks
add capability without changing existing behavior. See
`harness/hook-runner.js` for the authoritative invocation contract.
