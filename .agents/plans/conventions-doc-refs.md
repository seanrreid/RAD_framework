# Plan: Fix Stale CLAUDE.md and Config References in Docs (#190)
Created: 2026-10-06
Author: architect
Status: complete
Completed-At: 2026-10-06T20:43:42Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-06T20:37:10.514Z
Recorded-By: sean@torchcodelab.com
Branch: rad/conventions-doc-refs

## Context

After #87, RAD's config lives in `.rad/config.yml`. After #171 (PR #189), `AGENTS.md` is the conventions source and `CLAUDE.md` imports it with `@AGENTS.md`; readers fall back to `CLAUDE.md` when a project has no `AGENTS.md`. Four docs and two scope-map strings still describe the older layout. Two of these are factually wrong:
- README :187 says `get-default-branch.sh` resolves `default_branch` from CLAUDE.md (it uses `rad config get`).
- architect-guide :156 says to update the scope map in CLAUDE.md (it is `agent_scope_map` in `.rad/config.yml`).

`--light` was refused: `.rad/config.yml` is a self-protected path.

## Scope

| In scope | Out of scope |
|---|---|
| README, architect-guide, daily-workflow, apply-to-existing references listed in #190 | Any behaviour change |
| `.rad/config.yml` scope-map `reads:` text for `sync-surface-mapper` and `lint-surface-mapper` | Plan and log history under `.agents/` (historical records) |
| | Docs already updated in #189 (maintaining-claude-md, INSTALL, UPGRADE, portability) |

## Acceptance Criteria

1. **The two factual errors are fixed.**
   - README's `get-default-branch.sh` line says it resolves `default_branch` from `.rad/config.yml` (via `rad config get`).
   - architect-guide's scope-map step says to update `agent_scope_map` in `.rad/config.yml`.
2. **Every reference listed in #190 is updated** in README (:139, :149, :187, :225), `docs/architect-guide.md` (:35, :156, :316-330), `docs/daily-workflow.md` (:43, :86, :253, :339, :421) and `docs/apply-to-existing.md` (:5, :19, :46, :137-160, :241-303).
   - **Conventions:** where a reference means the conventions file, it says `AGENTS.md`, using the #171 fallback wording where the project may not have one ("`AGENTS.md` (or `CLAUDE.md` if the project has no `AGENTS.md`)").
   - **Claude-specific content:** a reference that means Claude-specific content keeps `CLAUDE.md`.
   - **`git add` lines:** include `AGENTS.md`.
   - **Config:** no doc claims config lives in CLAUDE.md.
   - **Check:** a grep for `CLAUDE\.md` across the four docs leaves only fallback wording or Claude-specific mentions. The WAVE_RESULT lists each remaining hit with a one-line reason.
3. **`.rad/config.yml`** `reads:` for `sync-surface-mapper` (:42) and `lint-surface-mapper` (:118) say `.rad/config.yml` instead of `CLAUDE.md RAD config` / `CLAUDE.md scope map`. `node harness/cli.js config validate` passes.
4. **Suites stay green:**
   - `scripts/lint-agent-files.sh`;
   - `scripts/lint-invariants.sh`;
   - `npm test --prefix harness`;
   - every `scripts/test-*.sh` under both shells;
   - `scripts/lint-plan.sh` on this plan.

## Agent Scope

No research agents were needed. #190 lists every reference with line numbers, and I verified them by grep on main at `f224b74`. There are no out-of-scope dependencies.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| README.md | 135-230 | Installer scaffold, tree listing, `get-default-branch.sh` line, docs table row |
| docs/architect-guide.md | 30-40, 150-160, 314-331 | Install step, scope-map step, "Keeping AGENTS.md current" |
| docs/daily-workflow.md | 40-90, 250-256, 336-342, 418-424 | `git add` lines, conventions, `/kickoff`, insights bullet |
| docs/apply-to-existing.md | 1-50, 135-162, 238-304 | Conventions file authoring |
| .rad/config.yml | 40-44, 116-119 | Scope-map `reads:` text |

## Execution Notes

### Do Not Touch
- Code, scripts, harness.
- `.agents/plans/**` and `.agents/logs/**` (history).
- Docs updated in #189.

### Key Files
- `AGENTS.md` and `CLAUDE.md`: the current split, so the docs describe it accurately.
- `docs/maintaining-claude-md.md`: the wording the docs should match.

### Reminders
- Change wording only. Keep each doc's structure.
- No en dashes.

## Wave Plan

### Wave 1 — parallel
These tasks touch disjoint files.

#### Task 1.1: Docs
File: README.md:135-230, docs/architect-guide.md:30-40, 150-160, 314-331, docs/daily-workflow.md:40-90, 250-256, 336-342, 418-424, docs/apply-to-existing.md:1-50, 135-162, 238-304
What: Implement AC#1 and AC#2.
Validate: AC#1, AC#2, AC#4. List the remaining `CLAUDE.md` hits from the grep. There is no testable surface beyond the doc checks.

#### Task 1.2: Scope-map text
File: .rad/config.yml:40-44, 116-119
What: Implement AC#3.
Validate: AC#3, AC#4. Run `node harness/cli.js config validate` and `scripts/lint-agent-files.sh`. There is no testable surface beyond config validation.

## Tests to Write
- [ ] None: docs and data text only. Covered by `config validate`, `lint-agent-files` and the existing suites (no testable surface).

## Non-Goals
- Changing any behaviour, script or lint.
- Rewriting historical plans or logs.
- Restructuring the docs beyond the stale references.

## Out-of-Scope Dependencies
None.

## Risks
- **The wrong file named in a "Claude-specific" spot.** Each remaining `CLAUDE.md` hit is listed with a reason, so review is quick.
