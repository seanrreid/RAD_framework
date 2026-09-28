# Plan: Tighten the Default High-Risk Pattern
Created: 2026-09-28
Author: architect
Status: pending-review
Branch: rad/tighten-high-risk-default
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/143
Issue-Title: Default RAD_HIGH_RISK_PATTERNS is too broad now that it blocks approval ('auth' matches 'authority')

## Context

Since #141 an un-waived high-risk finding **blocks** `rad approve`, and since #147 it also triggers a non-waivable `light-tier` blocker on light plans. The built-in default `auth|payment|billing|migration|secret|credential|token` (`scripts/lib/plan-paths.sh:267`, its only copy) is matched as an unanchored substring. So it flags `approval-authority-recording.test.js` (PR #141 had to waive it), three older plans (`auth` inside `authority`), `docs/authors.md` and `src/tokenizer.js`. Blocking on noise trains architects to rubber-stamp waivers.

**Architect decision (2026-09-28): the refined word-boundary pattern.** Whole path segments, with plurals and auth stems kept:

```
(^|[/_.-])(o?auth(n|z|entication|enticate|orization|orize)?|payments?|billing|migrations?|secrets?|credentials?|tokens?)([/_.-]|[A-Z0-9]|$)
```

The option the issue originally suggested would have dropped the plurals and stems. It would have stopped matching `migrations/`, `secrets.yaml`, `authentication.ts`, `authorize.js` and `oauth/`, which are exactly the paths that should be flagged. The refined pattern was checked with BSD `/usr/bin/grep -E`, the engine `path_matches` uses:

- **12 should-match paths match:** `src/auth/login.js`, `lib/authentication.ts`, `api/oauth-callback.js`, `db/migrations/001.sql`, `config/secrets.yaml`, `services/authService.js`, `src/tokens.js`, `billing/invoice.rb`, `src/authorize.js`, `auth.js`, `src/payment_gateway.py`, `scripts/secret-rotate.sh`.
- **6 should-not paths don't:** `harness/test/approval-authority-recording.test.js`, `docs/authors.md`, `src/tokenizer.js`, `src/authorship.md`, `docs/tokenomics.md`, `harness/adapters/git-state-store.js`.
- Every path the existing tests expect to be flagged still matches: `src/auth/*.js`, `scripts/token-budget.sh`, `scripts/token-x.sh`, `db/migrations/…`, `gone/token.js`.

`RAD_HIGH_RISK_PATTERNS` still overrides the default unchanged, and an empty value still falls back to it.

## Scope

| In scope | Out of scope |
|---|---|
| The `RAD_HIGH_RISK_DEFAULT_PATTERN` constant in `scripts/lib/plan-paths.sh` | `path_matches`, `plan_high_risk_pattern`, the override and empty-falls-back semantics |
| A regression table of match/no-match paths in `scripts/test-plan-paths.sh` | Case-insensitive matching (matching stays case-sensitive, as today) |
| The default shown in CLAUDE.md "Plan Lint — High-Risk Paths" and `.env.example` | Re-approving or editing already-approved historical plans |

## Acceptance Criteria

1. `RAD_HIGH_RISK_DEFAULT_PATTERN` equals the decided pattern exactly, and it stays the only copy of the default in `scripts/`.
2. With `RAD_HIGH_RISK_PATTERNS` unset, `plan_high_risk_findings` flags all 12 should-match paths listed in Context and none of the 6 should-not paths, under both `bash` and `/bin/bash` 3.2.
3. `RAD_HIGH_RISK_PATTERNS` overrides the default exactly as before, and an empty value still falls back to the (new) default. All existing `scripts/test-*.sh` cases pass unmodified.
4. CLAUDE.md and `.env.example` show the new default. `.env.example` no longer calls the check "advisory": it blocks `rad approve` when un-waived.
5. Re-linting every `.agents/plans/*.md` with `main`'s lint and this branch's lint changes only high-risk advisory, blocker and `light-tier` high-risk lines. The implementer lists every plan whose findings changed, each with the path that dropped out or newly matched. No plan may newly **gain** a finding for a path that doesn't contain one of the stems.

## Agent Scope

- Direct reads, confirmed by grep: the default constant (`plan-paths.sh:260-270`), the test expectations mentioning auth/secret/payment/token/migration paths across the three shell test files, CLAUDE.md `:289-311`, and `.env.example:55-60`.
- Earlier in this session `lint-surface-mapper` (architect) mapped `path_matches` / `plan_high_risk_pattern` and the bash 3.2 constraints.
- Out-of-scope dependencies: none. The author is the architect; `scripts/` is self-protected.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 264-268 | New default pattern + comment on segment matching |
| scripts/test-plan-paths.sh | 600-621 | Append the 18-path regression table |
| CLAUDE.md | 296-311 | New default shown; note whole-segment matching |
| .env.example | 55-60 | New default; "blocks rad approve when un-waived" |

## Execution Notes

### Do Not Touch
- `path_matches`, `plan_high_risk_pattern`, `plan_high_risk_findings` logic, and every other helper in scripts/lib/plan-paths.sh
- scripts/lint-plan.sh, scripts/check-approval-blockers.sh, harness/**
- Historical plans under .agents/plans/

### Key Files
- scripts/lib/plan-paths.sh — the constant and `plan_high_risk_pattern`
- scripts/test-plan-paths.sh — test style

### Reminders
- Keep the pattern byte-exact to the decided string, since the tests pin it. The `readonly` single-quoted assignment needs no escaping for this pattern.
- Bash 3.2 and BSD `grep -E`: run the table under `/bin/bash`, and match through `path_matches` or `plan_high_risk_findings` rather than bash `=~`, so the test uses the production engine.
- Any literal copy of the pattern in docs goes in a fenced block, so the `|` characters don't break markdown tables.

## Wave Plan

### Wave 1 — parallel
Verify: bash scripts/test-plan-paths.sh && /bin/bash scripts/test-plan-paths.sh && for t in scripts/test-*.sh; do bash "$t" >/dev/null || exit 1; /bin/bash "$t" >/dev/null || exit 1; done && npm test --prefix harness
Tasks in this wave can run in parallel (disjoint files).

#### Task 1.1: New default pattern + regression table
File: scripts/lib/plan-paths.sh:264-268, scripts/test-plan-paths.sh:600-621
What:
- Replace `RAD_HIGH_RISK_DEFAULT_PATTERN` with the decided pattern.
- Update its comment to say that it matches whole path segments (a stem, an optional plural or auth suffix, then a separator, a capital letter, a digit or the end), and why (#143: substring matching flagged `authority`, `authors` and `tokenizer`).
- Append a table-driven test over the 18 Context paths through `plan_high_risk_findings`, with `RAD_HIGH_RISK_PATTERNS` unset and again set to empty, asserting each match or no-match.

Then run the AC#5 re-lint (temp copies of origin/main's `lint-plan.sh`, `lib/plan-paths.sh` and `get-default-branch.sh`; no stash). Report every plan whose high-risk, blocker or `light-tier` lines changed, with the reason.
Validate: AC#1, AC#2, AC#3, AC#5 — both shells, every `scripts/test-*.sh`, `npm test --prefix harness`, and the re-lint report.

#### Task 1.2: Docs show the new default
File: CLAUDE.md:296-311, .env.example:55-60
What:
- Replace the default in both files with the new pattern, in a fenced block in CLAUDE.md and as a comment line in `.env.example`.
- Add one sentence saying the default matches whole path segments, so `authority` or `tokenizer` isn't flagged but `auth/`, `authentication` and `migrations/` are.
- In `.env.example`, replace "(advisory)" with "(an un-waived match blocks `rad approve`)".
This task has no unit-testable surface (docs).
Validate: AC#4 — read-through; `grep -c "auth|payment|billing|migration|secret|credential|token" CLAUDE.md .env.example scripts/lib/plan-paths.sh` returns 0 for each file.

## Tests to Write
- [ ] 19-path match/no-match regression table under the default, with unset and empty env — scripts/test-plan-paths.sh

## Non-Goals
- Case-insensitive matching.
- Changing the override semantics, or making the pattern list configurable as separate stems.
- Re-approving or rewriting historical plans whose findings change.

## Out-of-Scope Dependencies
None

## Risks
- **Recall loss on unanticipated spellings.** For example `userAuth.js` (camelCase with the stem in the middle) or `Auth/` (capitalized) don't match. Neither matched before either, because matching was already case-sensitive, so this is no regression. But the new pattern doesn't fix them. Operators can override with `RAD_HIGH_RISK_PATTERNS`.
- **`token` still covers LLM-token paths** (e.g. a `token-budget` script). That's accepted: in projects RAD is installed in, `token` usually means an auth token, and RAD's own token paths are self-protected anyway.
- **Historical plans' findings change.** They are already approved and aren't re-gated, so only their re-lint output shifts (AC#5 reports it).

## Issue Gaps
- **[DECIDED — architect]** Option 1 from the issue in refined form: whole segments, plurals and auth stems, checked against BSD `grep -E`.
- **[ASSUMPTION]** A capital letter or digit counts as a trailing boundary, so camelCase `authService.js` and `secrets2.yaml` match. A leading boundary still needs `^` or `[/_.-]`, so camelCase stems in the middle of a name, like `userAuth`, don't.
- **[ASSUMPTION]** `billing` has no plural or suffix variants (`billings` is rare). `billing-api/` still matches through the `-` boundary.
