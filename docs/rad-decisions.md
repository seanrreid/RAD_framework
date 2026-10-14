# RAD Decisions

This records RAD's own rationale: the decisions, testing standards and
constraints behind this framework. The sections of the same names in
`AGENTS.md` are the consumer's to fill in for their project; they are not
filled from here. Each bullet ends with a pointer to the file or issue that is
the source of truth. If a bullet and its source disagree, the source wins.

## Architecture decisions

- Deterministic harness code owns control flow and calls the model only at judgment points, pausing at human points. See `docs/harness-and-framework.md`.
- Approval is the `approved` event in `.agents/state/<feature>/events.jsonl`, folded by `harness/gates.js`; the plan's `Status: approved` header is a display-only mirror. See `docs/invariants.yaml`.
- There is no auto-approval: severity-routed approval (Green Lane v1) was removed, and a human approves every plan. See #137.
- There are two human gates: `/rad-approve` on the plan, then review of the deliver PR. See `docs/daily-workflow.md`.
- The wave contract is provider-neutral plain text, honored by the `command`, `sdk` and `acp` adapters. See `docs/rad-wave-contract.md` and #86.
- Deliver PRs reference the issue as `Issue: #N`, never `Closes #N`; closing the issue is the architect's call at merge. See `docs/rad-cli.md`.
- `plan-open` stamps the source issue's author and comment mix on the plan header (`Source-Author:`, `Source-Comments:`) so the approving architect sees when a plan was built from untrusted text; it is display-only, outside the fingerprint and the gate, and never blocks. See `docs/rad-cli.md`.
- Deleting, renaming away, or skipping an existing test needs a `test-removal:<path>` waiver in the approved plan; `check-scope.sh` blocks it otherwise. See the `test-weakening-blocked` entry in `docs/invariants.yaml`.

## Testing standards

- `scripts/verify-all.sh` runs the repo's CI checks locally in one pass; its built-in check table is the authoritative list of test commands. See `scripts/verify-all.sh`.
- A plan that touches a self-protected path should declare `Verify: exec bash scripts/verify-all.sh` on its last wave; `scripts/lint-plan.sh` warns when it does not. Every non-light plan must declare a last-wave `Verify:` command or `Verify: none (<reason>)`; `rad approve` blocks (`missing-verify`, not waivable) otherwise, and `Tier: light` is exempt. See `docs/configuration.md` and #236.
- New `*.sh` and `*.mjs` files under `scripts/` must be committed mode `100755`, or the shell-safety lint fails. See `scripts/lint-shell-safety.sh`.
- The ~40-line function rule is enforced as a ratchet: the baseline (`scripts/lint-function-length-baseline.txt`) lists current offenders and can only shrink. See `scripts/lint-function-length.mjs` and #252.
- `scripts/claude-usage.mjs` wraps the `claude` CLI so the command adapter sees a first-line `RAD_USAGE` with an explicit `total` (cache tokens included); `rad deliver` warns once when `RAD_TOKEN_BUDGET` is armed and a wave reports no usage. See `docs/rad-wave-contract.md`.

## Known constraints

- `.rad/`, `harness/` and `scripts/` (with `.claude/` and `.agents/state/`) are self-protected paths; plans touching them are always flagged for architect review, and the set is not configurable. See `docs/configuration.md`.
- The `command` and `acp` adapters cannot narrow an agent's tools, so they refuse a constrained wave whose effective tool set is narrower than the full vocabulary. See `harness/capabilities.js`.
