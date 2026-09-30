# Evals

RAD's evals check that its guards hold up when an agent misbehaves. There are two
lanes:

- The **scripted lane** proves the **deterministic invariants**: gates, scope
  checks, and the event log. A scripted adversary stands in for the agent, so every
  run is reproducible and costs nothing. It runs on every PR.
- The **live lane** covers **judges and live agents**: the reviewers and any
  behaviour that depends on a real model's judgment. It needs a real agent CLI and
  credentials, and runs only when a maintainer configures it.

## Scripted lane

```bash
node --test harness/evals/*.eval.js
```

In CI this runs as the `evals-scripted` job in `.github/workflows/ci.yml`, once per
PR. The cases live in `approval.eval.js`, `delivery.eval.js`, `repo.eval.js` and
`smoke.eval.js`. `harness/evals/lib/runner.js` registers them.

**Mutation rule.** Every case that exercises a guard declares a `mutate` function,
which disables that guard in the fixture copy. The runner registers a
`[mutated]` twin of the case, and that twin **must fail**. If the twin still
passes, the assertion never depended on the guard it claims to test.

**Fixtures.** `harness/evals/lib/fixture.js` builds a hermetic, real-git repo for
each case. It has its own `scripts/`, a local bare `origin`, a git identity, and an
optionally approved plan. The fixture drives the real `node harness/cli.js` entry
points. The agent behind the command adapter is a scripted adversary with a fixed
set of behaviours:

- `noop`
- `in-scope-commit`
- `undeclared-file`
- `push-default`
- `dump-env`
- `rewrite-events`

**Adding a scripted case.**

1. Add an entry to the relevant `*.eval.js` through `defineCases`. Give it a fixture,
   an adversary behaviour, an assertion, and a `mutate` that disables the guard.
2. Add the eval file to the invariant's `evals` list in `docs/invariants.yaml`.
3. Run `node --test harness/evals/*.eval.js` and check two things: the case passes,
   and its `[mutated]` twin fails.

## Registry link rule

Every invariant in `docs/invariants.yaml` must record one of two things:

- `evals`: the eval files whose cases target the invariant.
- `not_evalable`: an honest reason why no eval can target it.

`scripts/lint-invariants.sh` enforces this fail-closed, so an invariant with
neither field fails the lint.

## Live lane

To run the live lane, set `RAD_EVAL_LIVE_CMD` to a real agent CLI, for example
`claude -p`. That CLI replaces the scripted adversary, and each case's
`adversarialPrompt` reaches the agent through the plan's task text.

```bash
RAD_EVAL_LIVE_CMD="claude -p" node --test harness/evals/live.eval.js
```

Some cases are marked `liveOnly: true` because their pass condition is a model's
judgment, such as refusing a prompt injection or leaving files alone on a read-only
question. The scripted lane reports these cases as **skipped, with a reason**. It
never counts them as passes.

Live cases have **no mutation twins**. A twin needs a deterministic failure, and a
model's refusal is not deterministic, so the twin would be flaky.

## Reviewer fixtures

`harness/evals/reviewers.eval.js` runs the real `quality-reviewer` and
`accessibility-reviewer` against golden changes. Each fixture lives at
`harness/evals/reviewers/fixtures/<reviewer>/<id>/`:

- `change/`: files on the review branch, as a repo-relative tree.
- `base/` (optional): files that already exist on `main`.
- `expect.json`: one of these two shapes:
  - `{ "kind": "positive", "category": "<cat>" | ["<cat>", ...], "minPriority": "HIGH"|"MEDIUM"|"LOW" }`
  - `{ "kind": "negative" }`

The runner builds a temp review repo for each trial, with the change on branch
`review`. It sends the reviewer prompt on stdin to `RAD_REVIEW_EVAL_CMD`, which runs
with that repo as its cwd. Two more variables tune the run:

- `RAD_REVIEW_EVAL_TRIALS`: the number of trials per fixture. The default is 3.
- `RAD_REVIEW_EVAL_TIMEOUT_SECONDS`: the time limit for each trial. The default is 300.

If `RAD_REVIEW_EVAL_CMD` is unset, every fixture is skipped with the reason
`skipped: no credentials`.

**Scoring.** Each fixture is judged by majority over its trials.

- A **positive** fixture passes when the reviewer reports the expected category at
  `minPriority` or higher.
- A **negative** fixture passes when the reviewer reports **no HIGH or MEDIUM**
  findings. LOW notes are allowed. This bar keeps a reviewer from passing by
  flagging everything.

**Adding a fixture.**

- Plant exactly **one** defect in a positive fixture and keep the rest of its change
  clean.
- Pair each positive with clean fixtures that cover the same kind of code.
- Use frontend extensions only for accessibility fixtures, because the reviewer
  filters on them.

List the new fixture in
[`harness/evals/reviewers/fixtures/README.md`](../harness/evals/reviewers/fixtures/README.md),
which has the full design rules and the current fixture table.

## CI configuration

The live lanes run from `.github/workflows/evals-live.yml`. It has two jobs:

- `reviewer-fixtures`: runs only when the repo variable `RAD_REVIEW_EVAL_CMD` is set.
- `live-evals`: runs only when the repo variable `RAD_EVAL_LIVE_CMD` is set.

Configure these repo variables and the secret under Settings → Secrets and variables
→ Actions:

| Name | Kind | Purpose |
|---|---|---|
| `RAD_REVIEW_EVAL_CMD` | variable | Reviewer CLI (prompt on stdin). Unset means the job is skipped. |
| `RAD_EVAL_LIVE_CMD` | variable | Agent CLI for the live harness cases. Unset means the job is skipped. |
| `RAD_EVAL_SETUP` | variable | Optional shell step run before the evals, e.g. to install the CLI. |
| `ANTHROPIC_API_KEY` | secret | Model credentials. If it is missing, the job fails with `::error::`. |

**Triggers.** The workflow runs in two cases:

- On `workflow_dispatch`, run by hand.
- On a PR that touches `.claude/agents/quality-reviewer.md`,
  `.claude/agents/accessibility-reviewer.md` or `harness/evals/reviewers/**`.

GitHub withholds secrets from fork PRs, so the key check fails those runs. An unset
variable makes its job show as SKIPPED. **The workflow never reports a pass without
credentials.**

**Cost.** One `reviewer-fixtures` run is 12 fixtures × 3 trials, which comes to
about **36 model calls**. Each call is a full agent session over a small change.

## Trust boundary

`RAD_REVIEW_EVAL_CMD` and `RAD_EVAL_LIVE_CMD` inherit the **full** CI environment on
purpose, because they have to authenticate from `ANTHROPIC_API_KEY`. This differs
from `RAD_AGENT_CMD` in `rad deliver`, which runs under an allow-listed environment
that forwards only `PATH HOME LANG LC_ALL TMPDIR TERM USER`. Point these variables
only at CLIs you trust with the job's secrets.

`RAD_EVAL_SETUP` runs as **arbitrary shell** from a maintainer-set repo variable,
with the same trust as editing the workflow itself. Only maintainers can set repo
variables, and that permission is the boundary.
