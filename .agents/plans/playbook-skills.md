# Plan: Pinned Playbooks, Part 2: --playbook Flag, Seed Playbooks, CI and Docs (#50)
Created: 2026-10-09
Author: architect
Status: complete
Completed-At: 2026-10-09T17:20:05.193Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-09T16:29:43.756Z
Recorded-By: sean@torchcodelab.com
Branch: rad/playbook-skills
Issue: 50
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/50
Issue-Title: Pinned playbooks: reusable, human-approved plan templates for recurring change shapes (adopt CUGA's playbook, reject its self-evolution)

## Context
Part 1 (PR #227) shipped the playbook mechanism: `rad playbook lint|check-ref`, the `playbook_kinds` config key, the `Playbook:` plan-header lint, and the fingerprint fold. The format spec is `docs/playbooks.md`. Nothing yet lets a planner *use* a playbook, and no playbook exists. Part 2 closes that: the `--playbook` flag in `/rad-plan` and `/rad-adopt`, two seed playbooks drafted from real merged PRs, a CI job, and the docs.

The user decided on 2026-10-09:
- **Seeds:** `env-knob` and `event-type` only; `hook-point` and `severity-pattern` stay reserved and unseeded.
- **Body convention (Q1):** playbook bodies follow a **documented section convention, not a lint rule**, in this order before `## Upgrade Guide`: `## When to use`, `## Files typically touched`, `## Wave skeleton`, `## Tests and edge cases`, `## Deviations to record`. A backlog issue, **#231**, records when to revisit (about four playbooks, or something parsing sections mechanically).
- **Deviations (Q2):** a plan that pins a playbook carries a `## Playbook Deviations` section in its body (each departure and why, or `None`). The body is fingerprinted, so deviations are covered by the approval. It is not linted (also recorded on #231).
- **Marker:** the primary-file marker stays deferred (part 1).

From the research:
- A new env knob always follows the same recipe (`RAD_WAVE_TIMEOUT_SECONDS` in #219, `RAD_MAX_FAILED_ATTEMPTS`, `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS`).
- `run-prepared` (#203) is the model audit-only event.
- `docs/harness-state-store.md` has a paragraph for each audit-only event except `run-prepared`. That gap would make the event-type playbook's own recipe disagree with the repo, so this plan adds the missing paragraph.
- An env knob touches `harness/`, which is self-protected, so a plan built on the `env-knob` playbook can never be `--light`.

## Scope
| In scope | Out of scope |
|---|---|
| `--playbook` flag, a load step, the `Playbook:` header line and the `## Playbook Deviations` section in `.rad/skills/rad-plan` and `.rad/skills/rad-adopt`, then regenerate | A lint for playbook body structure or the deviations section (#231) |
| Seed playbooks `env-knob--timeout-style` and `event-type--audit-only`, and `.agents/playbooks/README.md` | Seeds for `hook-point` and `severity-pattern` |
| A CI job `playbook-lint` | The primary-file marker |
| Tests: the seeds validate and follow the convention; skill bodies; a plan pinning a seed lints | New `rad` commands or harness code changes |
| Docs, plus the missing `run-prepared` paragraph in harness-state-store.md | Shipping playbooks in installs (`.agents/` stays user data) |
| A final full-suite verification wave | |

## Acceptance Criteria
1. **The flag in both skills.** `.rad/skills/rad-plan/SKILL.md` and `.rad/skills/rad-adopt/SKILL.md` document `--playbook <kind>/<slug>[@<version>]`, placed next to `--override-disposition` in `## Input`. Each skill gets a load step before research (rad-plan: a new Step 1b between Steps 1 and 2; rad-adopt: a new Step 3b before research), which says:
   - **Resolve the ref.** With no `@<version>`, use the `version` in the playbook file's frontmatter.
   - **Check it.** Run `node harness/cli.js playbook check-ref <kind>/<slug>@<version>`. A non-zero exit stops the command and shows stderr; no plan is written. A `stale current=N` result is read as a warning: also read the Upgrade Guide entries after the pin.
   - **Read the playbook** at `.agents/playbooks/<kind>--<slug>.md`, and treat its `## Files typically touched` and `## Wave skeleton` as the starting point for research scope, Files in Scope and the wave structure. Adapt them to the actual change, never copy blindly.
   - **Record the pin.** Put a `Playbook: <kind>/<slug>@<version>` line in the plan header, after `Issue:`, in the standard template and (rad-plan) the light template. rad-adopt's template gets the same line.
   - **Record deviations.** The plan body gets a `## Playbook Deviations` section after `## Risks`: each departure from the playbook and why, or `None`.
   - **State the guardrails.** Pinning never approves a plan or lowers any gate (the plan goes through `/rad-approve`), and a run never edits a playbook.
   - **Explain `--light`.** In rad-plan, `--light` plus `--playbook` is allowed only when the plan stays within the light bounds (one wave, three tasks, no self-protected path). A playbook whose steps need more, or that touches `harness/`, `scripts/` or `.rad/`, means `--light` is refused.
   - The bodies stay tool-neutral and pass skill-bodies' `FORBIDDEN_PATTERNS`.
2. **Regenerated.** `node harness/cli.js generate` rewrites `.claude/commands/team/rad-plan.md`, `.claude/commands/team/rad-adopt.md`, `.agents/skills/rad-plan/SKILL.md` and `.agents/skills/rad-adopt/SKILL.md` from the sources. `generate --check` exits 0.
3. **The seed playbooks.**
   - `.agents/playbooks/env-knob--timeout-style.md` and `.agents/playbooks/event-type--audit-only.md`, each with frontmatter `{"kind": …, "slug": …, "version": 1, "summary": …}` and the five conventional sections in order, then `## Upgrade Guide` with `### Version 1 — 2026-10-09`.
   - Their content is drawn from the real exemplars:
     - `env-knob` from #219 (commits 78b8893 and 4f5f730) and `.agents/plans/deliver-hardening.md` (AC#2, AC#4, AC#5), plus `RAD_MAX_FAILED_ATTEMPTS` and `RAD_AGENT_PREFLIGHT_TIMEOUT_SECONDS`.
     - `event-type` from #203 (commit b4f33ff), `harness/events.js` and the `run-resumed` fold test.
   - `.agents/playbooks/README.md` says the seeds are repo-internal (not shipped), points to `docs/playbooks.md` for the format and the convention, and points to #231.
   - `node harness/cli.js playbook lint` prints `playbooks ok (2)` and exits 0.
4. **The missing paragraph.** `docs/harness-state-store.md` gains a `run-prepared` audit-only paragraph beside the existing per-event ones (data shape `{ base, merged, fastForwarded, committed, pushed, stashed? }`, no authority, absent from `PHASE_BY_TYPE`).
5. **CI.** `.github/workflows/ci.yml` gains a job `playbook-lint` after `generated-drift`, in the same thin-wrapper shape: a comment, `runs-on: ubuntu-latest`, checkout, setup-node 20, and `run: node harness/cli.js playbook lint`. `docs/rad-cli.md`'s `## CI checks` lists it.
6. **Tests.**
   - The new harness/test/seed-playbooks.test.js:
     - every file in the repo's `.agents/playbooks/` (except `README.md`) passes `validatePlaybook` with the kinds from `.rad/config.yml` (the default when absent);
     - each seed has the five conventional sections in order, before a final `## Upgrade Guide`. This asserts that the seeds follow the documented convention; it is not a rule for future playbooks.
   - harness/test/skill-bodies.test.js: `REQUIRED_COMMANDS` for rad-plan and rad-adopt gain `node harness/cli.js playbook check-ref`, and the bodies contain `--playbook` and `Playbook Deviations`.
   - scripts/test-lint-plan.sh: a plan pinning `env-knob/timeout-style@1` with a `## Playbook Deviations` section lints with no playbook error against the repo's real playbooks, and the same plan pinning `@2` fails (a version ahead of the playbook).
7. **Docs.**
   - docs/playbooks.md: replace the "not part of this mechanism yet" sentence, then document the `--playbook` flag (a bare ref pins the current version), the section convention and its status (convention only, revisit #231), the `## Playbook Deviations` section, the `--light` rule, the seeds, and the CI job.
   - docs/daily-workflow.md (the planning-tier paragraph), docs/how-it-works.md (the plan artifacts), AGENTS.md (one workflow line, within the advisory budget), docs/flue-vs-rad.md (the stale "not built" lines), docs/references.md, `.agents/README.md`, docs/rad-cli.md (a pointer to the flag in `### rad playbook`).
8. **Full verification.** The last wave runs the full suites and evals clean: `node --test harness/test/*.test.js`, `node --test harness/evals/*.eval.js`, every `scripts/test-*.sh`, `generate --check`, `lint-invariants.sh`, `lint-agent-files.sh`, `lint-claude-md.sh` and `rad playbook lint`. It changes no code unless a failure traces to this plan's changes, and such a fix stays within the scope above. A failure from anywhere else is reported as `blocked_intent`.

## Agent Scope
Research came from the #50 part 1 survey and a second read-only survey of the env-knob and event-type exemplars (file sets, recipes, tests), the exact slots in both plan skills, skill-bodies, CI, the docs anchors and the install manifest. There are no out-of-scope dependencies.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| .rad/skills/rad-plan/SKILL.md | 23-42 | `--playbook` paragraph |
| .rad/skills/rad-plan/SKILL.md | 69-86 | Step 1b |
| .rad/skills/rad-plan/SKILL.md | 183-195 | Header line and deviations section (standard) |
| .rad/skills/rad-plan/SKILL.md | 328-340 | Header line (light) |
| .rad/skills/rad-adopt/SKILL.md | 18-32 | `--playbook` paragraph |
| .rad/skills/rad-adopt/SKILL.md | 99-125 | Step 3b |
| .rad/skills/rad-adopt/SKILL.md | 127-140 | Header line and deviations section |
| .claude/commands/team/rad-plan.md | 1-1 | Regenerated |
| .claude/commands/team/rad-adopt.md | 1-1 | Regenerated |
| .agents/skills/rad-plan/SKILL.md | 1-1 | Regenerated |
| .agents/skills/rad-adopt/SKILL.md | 1-1 | Regenerated |
| .agents/playbooks/README.md | 1-1 | New |
| .agents/playbooks/env-knob--timeout-style.md | 1-1 | New seed |
| .agents/playbooks/event-type--audit-only.md | 1-1 | New seed |
| harness/test/seed-playbooks.test.js | 1-1 | New (AC#6) |
| harness/cli.js | 262-300 | Read only: the env-knob exemplar |
| harness/cli.js | 790-805 | Read only: the exemplar parser |
| harness/events.js | 20-35 | Read only: the event-type exemplar |
| harness/events.js | 170-205 | Read only: `PHASE_BY_TYPE` |
| harness/spine.js | 85-100 | Read only: the `run-prepared` emit site |
| harness/test/events.test.js | 1325-1340 | Read only: the audit-only fold test |
| harness/test/skill-bodies.test.js | 30-50 | `REQUIRED_COMMANDS` and body assertions |
| scripts/test-lint-plan.sh | 1235-1270 | New `t_seed_playbook_pin`, call list |
| .github/workflows/ci.yml | 115-140 | `playbook-lint` job |
| docs/harness-state-store.md | 276-296 | `run-prepared` paragraph |
| docs/playbooks.md | 1-130 | Flag, convention, deviations, seeds, CI |
| docs/daily-workflow.md | 118-130 | Planning-tier paragraph |
| docs/how-it-works.md | 142-152 | Plan artifacts |
| AGENTS.md | 117-125 | Workflow line |
| docs/flue-vs-rad.md | 85-90 | Status line |
| docs/flue-vs-rad.md | 192-198 | Blueprints section |
| docs/flue-vs-rad.md | 236-240 | Adoption list |
| docs/flue-vs-rad.md | 275-279 | Header mention |
| docs/references.md | 36-42 | Playbook mention |
| docs/references.md | 147-156 | Playbook mention |
| .agents/README.md | 18-26 | `playbooks/` row |
| docs/rad-cli.md | 320-352 | Flag pointer in `### rad playbook` |
| docs/rad-cli.md | 1385-1400 | `## CI checks` row |

## Execution Notes

### Do Not Touch
- harness/playbook.js, harness/playbook-command.js, harness/plan-fingerprint.js, scripts/lint-plan.sh, scripts/lib/plan-paths.sh (part 1; no code changes in this plan)
- Other skills' sources (regenerate only; `generate` must report the others unchanged)
- `.rad/config.yml` (no `playbook_kinds` is set; the default applies)

### Key Files
- .rad/skills/rad-plan/SKILL.md: `--light` and `--override-disposition` handling, Step 0 (46-67), Step 2 (85+), the templates (185-195, 331-337)
- .rad/skills/rad-adopt/SKILL.md: Input (18-31), Steps 2b/3/4 (77-122), the header template (129-137)
- docs/playbooks.md (part 1): the format, the Upgrade Guide rule, the header and fingerprint sections
- The exemplars to draft the seeds from: `git show 4f5f730`, `git show b4f33ff`, `.agents/plans/deliver-hardening.md`, harness/cli.js's `timeoutFromEnv`, `maxFailedAttemptsFromEnv`, harness/events.js's audit-only comment block, harness/test/events.test.js's `run-resumed` test
- .github/workflows/ci.yml: the `generated-drift` job as the model

### Reminders
- **The final wave needs a long wave timeout.** Run this plan with `RAD_WAVE_TIMEOUT_SECONDS=1800 node harness/cli.js deliver playbook-skills` (the knob from #211). The earlier waves are small and don't need it.
- **Waves 1 to 4 validate with targeted commands only;** Wave 5 runs everything (#229).
- **Edit sources, then run `node harness/cli.js generate`.** Never hand-edit the generated skill files.
- **Seeds are drafted from the real diffs.** Read the exemplar commits; don't invent steps. Every file and test case a seed names must exist in the repo today.
- **Keep seed text accurate for today's code,** since a playbook is pinned by version and read by planners.
- **Helpers stay under ~40 lines in any test code, with named constants.**

## Program Design
```
/rad-plan --playbook env-knob/timeout-style     (skill, prose)
  Step 1b: resolve version (frontmatter if no @) → node harness/cli.js playbook check-ref <ref>
        → read .agents/playbooks/<kind>--<slug>.md (+ Upgrade Guide after the pin when stale)
  research scoped by "Files typically touched"; plan follows "Wave skeleton", adapted
  header: Playbook: env-knob/timeout-style@1      (fingerprinted, part 1)
  body:   ## Playbook Deviations                  (fingerprinted; each departure + why, or None)
  Step 4: lint-plan.sh → playbook check-ref (part 1) → plan-open
```
```
.agents/playbooks/README.md                      + new
.agents/playbooks/env-knob--timeout-style.md     + new seed
.agents/playbooks/event-type--audit-only.md      + new seed
.rad/skills/rad-{plan,adopt}/SKILL.md            ~ flag, step, header line, deviations section
(generated skill files)                          ~ regenerated
.github/workflows/ci.yml                         ~ playbook-lint job
harness/test/seed-playbooks.test.js              + new
docs/**                                          ~
```

## Wave Plan

### Wave 1 — sequential

#### Task 1.1: The --playbook flag in rad-plan and rad-adopt
File: .rad/skills/rad-plan/SKILL.md:23-42, 69-86, 183-195, 328-340, .rad/skills/rad-adopt/SKILL.md:18-32, 99-125, 127-140, .claude/commands/team/rad-plan.md:1-1, .claude/commands/team/rad-adopt.md:1-1, .agents/skills/rad-plan/SKILL.md:1-1, .agents/skills/rad-adopt/SKILL.md:1-1
What: Write AC#1 and AC#2. Edit only the two sources, then run `node harness/cli.js generate`.
Validate: AC#1, AC#2 — `node harness/cli.js generate --check` exits 0; `grep -c 'Playbook Deviations' .agents/skills/rad-plan/SKILL.md .agents/skills/rad-adopt/SKILL.md` prints a non-zero count for each; `grep -c 'git add\|git commit\|git push\|Explore\|\$ARGUMENTS' .agents/skills/rad-plan/SKILL.md .agents/skills/rad-adopt/SKILL.md` prints 0 for each

### Wave 2 — sequential

#### Task 2.1: The env-knob seed playbook and the README
File: .agents/playbooks/env-knob--timeout-style.md:1-1, .agents/playbooks/README.md:1-1, harness/test/seed-playbooks.test.js:1-1, harness/cli.js:262-300, harness/cli.js:790-805
What: Draft `env-knob--timeout-style` from the real exemplars (`git show 4f5f730`, `.agents/plans/deliver-hardening.md` AC#2/AC#4/AC#5, the `timeoutFromEnv` and `maxFailedAttemptsFromEnv` code). The `## Files typically touched` table covers: harness/cli.js (the `*_ENV` constant and the digits-only parser, read before any side effect), the consumer, docs/configuration.md (the env-list line plus a paragraph), docs/rad-cli.md (the env table row and the exit-2 row), and the tests with the env-clearing lists. The `## Tests and edge cases` section names the malformed loop (`abc`, `0`, `-3`, `1.5`, ` 5`, `10s`: exit 2, the exact message, no spawn, only `approved` in the log), the valid value reaching the consumer, and unset and empty keeping the default. It also names the edge cases: whitespace and zero are malformed, empty is not, parse before side effects, skip validation when the feature is off, and the SDK path ignores adapter timeouts. `## Deviations to record` covers a knob that counts instead of seconds, one with an off value, and one with spine semantics (which needs a section in docs/rad-wave-contract.md). Write the README and the new seed-playbooks.test.js (AC#6, first half).
Validate: AC#3, AC#6 — `node harness/cli.js playbook lint` exits 0 (`playbooks ok (1)`); `node --test harness/test/seed-playbooks.test.js` passes; every file and test case the seed names exists in the repo

#### Task 2.2: The event-type seed playbook and the run-prepared paragraph
File: .agents/playbooks/event-type--audit-only.md:1-1, docs/harness-state-store.md:276-296, harness/events.js:20-35, harness/events.js:170-205, harness/spine.js:85-100, harness/test/events.test.js:1325-1340
What: Draft `event-type--audit-only` from `git show b4f33ff` (`run-prepared`) and the `run-resumed` fold test. The `## When to use` section says it covers an **audit-only** event: no phase and no gate authority. The `## Files typically touched` table covers: harness/events.js (the typedef doc comment, and the absence from `PHASE_BY_TYPE` with a rationale comment), the single emit site with an optional port that defaults to the old behavior (so event sequences stay byte-identical without it), the tests (a fold test in the `run-resumed` style asserting `phaseOf` is unchanged, a spine order test and an absent-port baseline test, and no-op injections in the helpers), and the docs (rad-wave-contract.md, harness-state-store.md's per-event paragraph and rad-cli.md). `## Deviations to record` states that a **phase-changing** event departs from this playbook, because it needs a `PHASE_BY_TYPE` key, a `PHASE_ORDER` check, the terminal-phase rule in transitions.js and any gates.yaml entry. Also add the missing `run-prepared` audit-only paragraph to docs/harness-state-store.md (AC#4).
Validate: AC#3, AC#4, AC#6 — `node harness/cli.js playbook lint` exits 0 (`playbooks ok (2)`); `node --test harness/test/seed-playbooks.test.js` passes; `grep -n 'run-prepared' docs/harness-state-store.md` matches

### Wave 3 — sequential

#### Task 3.1: CI job and registry tests
File: .github/workflows/ci.yml:115-140, harness/test/skill-bodies.test.js:30-50, scripts/test-lint-plan.sh:1235-1270
What: Write the AC#5 `playbook-lint` job and the AC#6 skill-bodies and `t_seed_playbook_pin` tests. The lint test writes a temp plan that pins `env-knob/timeout-style@1` with a `## Playbook Deviations` section, expects no playbook error, and runs the same plan with `@2`, which must fail.
Validate: AC#5, AC#6 — `node --test harness/test/skill-bodies.test.js` passes; `bash scripts/test-lint-plan.sh` passes; `grep -n 'playbook-lint' .github/workflows/ci.yml` matches

### Wave 4 — sequential

#### Task 4.1: Docs
File: docs/playbooks.md:1-130, docs/daily-workflow.md:118-130, docs/how-it-works.md:142-152, AGENTS.md:117-125, docs/flue-vs-rad.md:85-90, 192-198, 236-240, 275-279, docs/references.md:36-42, 147-156, .agents/README.md:18-26, docs/rad-cli.md:320-352, 1385-1400
What: Write AC#7 and the AC#5 `## CI checks` row. Each stale "proposed" or "not built" statement becomes "shipped"; the marker stays deferred.
Validate: AC#7 — `bash scripts/lint-claude-md.sh` passes; `grep -n -- '--playbook' docs/playbooks.md docs/daily-workflow.md` matches in both; `grep -n 'not part of this mechanism yet' docs/playbooks.md` returns nothing

### Wave 5 — sequential

#### Task 5.1: Full verification
File: docs/playbooks.md:1-130
What: Write AC#8. Run every command listed in AC#8. If a failure traces to this plan's changes, fix it within the scope above; the one allowed edit target here is a file already named in Files in Scope. Report any other failure as `blocked_intent`. Needs `RAD_WAVE_TIMEOUT_SECONDS=1800`.
Validate: AC#8 — `node --test harness/test/*.test.js` and `node --test harness/evals/*.eval.js` both exit 0; every `scripts/test-*.sh` passes; `node harness/cli.js generate --check`, `bash scripts/lint-invariants.sh`, `bash scripts/lint-agent-files.sh`, `bash scripts/lint-claude-md.sh` and `node harness/cli.js playbook lint` all exit 0

## Tests to Write
- [ ] seed playbooks validate and follow the convention — harness/test/seed-playbooks.test.js
- [ ] rad-plan and rad-adopt bodies call check-ref and carry the flag and the deviations section — harness/test/skill-bodies.test.js
- [ ] a plan pinning a seed lints; a version ahead fails — scripts/test-lint-plan.sh

## Non-Goals
- A lint for playbook body structure or the `## Playbook Deviations` section (#231).
- Seeds for `hook-point` and `severity-pattern`.
- The primary-file marker, or any change to the part 1 harness code.
- Shipping playbooks in installs.

## Out-of-Scope Dependencies
None

## Risks
- **The seeds go stale** if the exemplars' code changes. They're pinned by version, and the Upgrade Guide is how a change gets recorded; that's the playbook design. The seed test checks structure, not freshness.
- **A planner may ignore the playbook.** The skill text makes the load step explicit and the deviations section visible in review, but nothing enforces either (#231).
- **The final verification wave needs `RAD_WAVE_TIMEOUT_SECONDS=1800`.** Without it the default 600 s may expire and the run stops with `fail-timeout`, which is a safe failure.
- **Two plan skills change at once.** Mitigation: the edits are prose in the same slots, generated outputs are regenerated and checked, and the skill-bodies tests pin them.
- **Self-protected paths** (`.rad/skills`, `.agents/skills`, `.claude/commands`, `scripts/`, `harness/`): this plan needs architect review by design.

## Issue Gaps
- **Assumption — a bare ref (`--playbook env-knob/timeout-style`) pins the playbook's current frontmatter version,** read by the planner from the file; there is no new CLI for it.
- **Assumption — the deviations section sits after `## Risks`,** so existing templates keep their order and the lint's required sections are unaffected.
- **Assumption — the seed slugs are `timeout-style` (kind `env-knob`) and `audit-only` (kind `event-type`),** matching their narrow scope: a seconds-style knob, and an audit-only event.
- **Assumption — the exact `docs/` line ranges in Files in Scope are approximate;** the tasks anchor on the headings and statements they name.
