# Plan: Fix open-pr.sh label handling (issue #2)
Created: 2026-05-29
Author: developer
Status: in-progress
Branch: rad/fix-open-pr-labels
Approved-By: Sean R Reid
Approved-At: 2026-05-29T00:00:00Z

## Context
Fixes [issue #2](https://github.com/seanrreid/RAD_framework/issues/2).
`scripts/open-pr.sh` accumulates `--label` values into a space-prefixed string
(`LABELS="$LABELS $2"`). The GitLab path then `tr ' ' ','`-joins it, producing a
leading comma (`--label ",rad:deliver"`) that can create a blank label or fail;
the GitHub path relies on unquoted word-splitting of the same string. Both are
fragile. This replaces the string with an indexed array (bash-3.2 safe) so labels
pass cleanly on both platforms.

## Scope
| In scope | Out of scope |
|---|---|
| `--label` accumulation in `open-pr.sh` arg parsing | Forgejo / manual modes (they don't use labels) |
| GitHub `--label` arg construction (`open_github`) | `scripts/rad-label.sh` (separate status-label mirror) |
| GitLab `--label` join construction (`open_gitlab`) | Changing any label names or values |
| Making the `gh`/`glab` create invocations expansion-safe (incl. `$DRAFT`) | Issues #3 (rad-status) and #4 (check-role) |

## Acceptance Criteria
1. Given a single `--label rad:deliver`, the GitLab path passes exactly `--label rad:deliver` — no leading comma and no empty label component.
2. The GitHub path passes each label as its own `--label <value>` argument (no reliance on word-splitting), correct for both single and multiple `--label` flags.
3. The `gh pr create` / `glab mr create` invocations use no unquoted string expansion for flags — `--draft`/`--no-draft` and labels are passed via arrays, so an empty draft flag adds no stray argument.
4. Label values are trimmed so no leading/trailing whitespace produces an empty `--label` argument; `bash -n` passes and the script runs under bash 3.2 (no associative arrays).

## Agent Scope
Explore sub-agent (research only). No role-restricted agents — the framework
repo has no populated Agent Scope Map. No out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/open-pr.sh | 13-72 | Replace `LABELS` string with an indexed array; build GitHub `--label` args and the draft flag as arrays; join GitLab labels with no leading comma; trim values |

## Execution Notes

### Do Not Touch
- `scripts/rad-label.sh` — unrelated status-label mirror
- `scripts/detect-platform.sh` — platform dispatch, no label logic
- `.claude/commands/team/rad-deliver.md` — the caller; its `--label "rad:deliver"` call must keep working unchanged

### Key Files
- `scripts/open-pr.sh` — the only file changed; arg parse (≈l.13-30), `open_github` (≈l.40-52), `open_gitlab` (≈l.55-72)

### Reminders
- Indexed arrays are bash-3.2 safe; associative arrays are NOT — do not use `declare -A`
- Preserve the existing `--draft` default / `--no-draft` override semantics
- The sole caller passes one label (`rad:deliver`) and `--no-draft`; verify that exact invocation still works

## Wave Plan

### Wave 1 — sequential
Tasks must run in sequence — they all edit `open-pr.sh` and share the new array.

#### Task 1.1: Accumulate labels into an indexed array
File: scripts/open-pr.sh:18-28
What: Replace `LABELS=""` / `LABELS="$LABELS $2"` with an indexed array, e.g.
`LABELS=()` and `--label) LABELS+=("$2"); shift 2 ;;`. Trim each value of
surrounding whitespace as it is added so a blank value never enters the array.
Validate: AC#4 — `bash -n scripts/open-pr.sh` passes; the array holds exactly the
labels passed, with no empty leading element.

#### Task 1.2: Build GitHub label + draft args as arrays
File: scripts/open-pr.sh:40-52
What: In `open_github`, build `local label_args=(); for l in "${LABELS[@]}"; do label_args+=(--label "$l"); done`
and a `draft_args` array (`[[ -n "$DRAFT" ]] && draft_args=("$DRAFT")`). Invoke
`gh pr create ... "${draft_args[@]}" "${label_args[@]}"` with no unquoted expansion.
Validate: AC#2, AC#3 — each label is its own quoted `--label` arg; empty draft adds no argument (verify with a dry trace of the built argv for single + multi-label, draft + no-draft).

#### Task 1.3: Join GitLab labels with no leading comma
File: scripts/open-pr.sh:55-72
What: In `open_gitlab`, replace `label_list=$(echo "$LABELS" | tr ' ' ',')` with a
comma-join over `"${LABELS[@]}"` that produces no leading/trailing comma (e.g.
`IFS=,; label_list="${LABELS[*]}"`), and only pass `--label "$label_list"` when
the array is non-empty. Keep the draft flag handling array-safe.
Validate: AC#1 — for `--label rad:deliver` the built arg is `--label rad:deliver`; for two labels it is `--label a,b` (no leading comma).

## Tests to Write
- [ ] GitLab join yields `rad:deliver` (not `,rad:deliver`) for one label, and `a,b` for two — `scripts/open-pr.sh` (bash verification snippet; framework has no test harness)
- [ ] GitHub argv contains a separate `--label` per value and no stray empty arg with `--no-draft` — `scripts/open-pr.sh` (bash verification snippet)
- [ ] `bash -n scripts/open-pr.sh` and a `/bin/bash` (3.2) parse both pass — `scripts/open-pr.sh`

## Non-Goals
- Do not change any label names, values, or the `rad:` taxonomy
- Do not modify Forgejo or manual modes (they do not use labels)
- Do not address issues #3 (rad-status find|xargs) or #4 (check-role grep `\|`)
- Do not alter `detect-platform.sh` dispatch or the push logic

## Out-of-Scope Dependencies
None.

## Risks
- The `gh pr create` invocation currently relies on unquoted `$DRAFT`; moving to
  arrays changes expansion. Must verify the `--no-draft` path adds no empty
  argument and the default `--draft` path still includes it.
- The sole caller (`rad-deliver`) passes a single label and `--no-draft`; a
  regression there would break delivery PR creation. Verify that exact call.
