# Plan: Missing Last-Wave Verify Is an Approval Blocker (#236)
Created: 2026-10-12
Author: architect
Status: complete
Completed-At: 2026-10-12T18:32:17.796Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-12T18:08:31.488Z
Recorded-By: sean@torchcodelab.com
Branch: rad/last-wave-verify-blocker
Issue: 236
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/236
Issue-Title: Missing last-wave Verify is an approval blocker for non-light plans (Verify: none (reason) escape)

## Context
A wave's `Verify:` is the only check the harness itself runs, deterministically, after the agent returns. A plan with no last-wave `Verify:` runs nothing, so the agent's own report is the only certification (factory-checks V3/V5). `scripts/lint-plan.sh` only warns, and only when the plan touches a self-protected path (#236's original decision, since reversed by the architect on 2026-10-12).

The new rule: a standard (non-light) plan whose last wave declares no `Verify:` is an **approval blocker**, reported by `scripts/check-approval-blockers.sh`. The escape is `Verify: none (reason)`, which records why a plan has nothing to run (a docs-only plan, for example). Light plans stay exempt. The blocker is non-waivable in the `## Waivers` sense: `Verify: none (reason)` is the waiver. A fingerprint change is not needed because wave blocks are already inside the hashed plan body.

**Hazard found while researching.** `parseWaveVerify` (`harness/cli.js`) returns whatever follows `Verify:` as a shell command, so `Verify: none (reason)` would be run and fail with "command not found". It must be parsed as "no command". Both consumers of the map (the spine and the wave prompt) read an absent entry as "no check", so fixing the parser fixes both.

**Blast radius, measured.** A throwaway probe applied a minimal blocker to a scratch copy of `main` and ran every suite. It broke: `scripts/test-check-approval-blockers.sh` (its plan fixtures), one test in `harness/test/deliver-gate-hook.test.js`, and 37 of 61 scripted evals (all through the shared plan builder `defaultPlan` in `harness/evals/lib/fixture.js`). The probe could not see a second problem: `delivery.eval.js` injects its own `Verify: sleep N` line into the default plan, and `parseWaveVerify` keeps the last `Verify:` line in a wave, so a default `Verify: none` placed after it would silently defeat that test. The plan names all of these.

## Scope
| In scope | Out of scope |
|---|---|
| New blocker in `check-approval-blockers.sh` and a tri-state in `plan_last_wave_verify` | Validating that a `Verify:` command can fail (V18) |
| `Verify: none (reason)` parsed as "no command" by `parseWaveVerify` | Changing how a `Verify:` command is run (`check-verify.sh`) |
| The lint advisory extended to every plan, worded for the blocker | The ratchet lint and the test-weakening guard (#251, #241) |
| Fixtures and evals updated to declare a last-wave Verify | Plans already delivered (no retroactive check) |
| Plan templates, approve skill, regenerated outputs and docs | The `light` tier rules (unchanged) |

## Acceptance Criteria
1. **State helper.** `plan_last_wave_verify` prints `<last wave> yes|no|none|bare`: `yes` for a real command, `none` for `Verify: none (<non-blank reason>)`, `bare` for `Verify: none` with no reason or an empty `()`, `no` for no `Verify:` line. A plan with no waves prints nothing. The last `Verify:` line in the wave block decides, as `parseWaveVerify` does.
2. **Blocker.** `check-approval-blockers.sh` exits 1 and names `missing-verify` on stderr when the plan is standard-tier and the last wave's state is `no` or `bare`. The message tells the author both fixes (a real command, or `Verify: none (reason)`). It is never matched by a `## Waivers` bullet.
3. **Exemptions.** A `Tier: light` plan, a plan with no waves, and a plan whose last wave is `yes` or `none` are not blocked by this rule. Existing blockers behave exactly as before.
4. **`none` is not a command.** `parseWaveVerify` omits a wave whose `Verify:` value is `none` (case-insensitive, with or without a reason); every other value is returned verbatim. The wave prompt and the spine therefore treat `none` as "no check" with no further change.
5. **Lint advisory.** `lint-plan.sh` warns for any plan whose last wave is `no` or `bare`, saying approval will be blocked and how to clear it; it does not warn for `yes` or `none`. The lint exit code is unchanged.
6. **Fixtures.** `defaultPlan` declares `Verify: none (fixture: nothing to run)` in its wave; `twoWavePlan` does the same in wave 2; `verifyHangPlan` replaces that line instead of adding a second one, so `Verify: sleep N` still wins. The `write_plan` and `write_tier_plan` helpers in `test-check-approval-blockers.sh` declare a last-wave Verify so the pre-existing cases keep their intended outcome.
7. **New tests.** Tests cover every state in AC#1; the blocker for `no` and `bare`; light exemption; no-waves; `none` with a reason clearing it; a waiver bullet not clearing it; `parseWaveVerify` for `none`, `None (x)`, `none` alone, and a command that merely starts with the letters (for example `nonexistent-tool`).
8. **Templates and docs.** The `rad-plan` and `rad-adopt` templates tell authors that every non-light plan needs a last-wave `Verify:` or `Verify: none (reason)`; the `rad-approve` skill lists the new blocker; the generated copies match the sources (`generate --check` exits 0); the docs that describe the old advisory say blocker.
9. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (about 16 tool calls, over the usual cap because the throwaway probe was needed to measure the fixture blast radius; the probe ran in a scratch worktree and was removed): the lint advisory, the blocker script, `plan_last_wave_verify`, `parseWaveVerify` and its consumers, every test and eval that builds plans, the template and doc mentions.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/lib/plan-paths.sh | 548-575 | `plan_last_wave_verify`: add the `none` and `bare` states; update its header comment |
| scripts/check-approval-blockers.sh | 1-30 | Header comment: document the new blocker |
| scripts/check-approval-blockers.sh | 106-160 | Compute the state, report `missing-verify`, count it |
| scripts/lint-plan.sh | 383-398 | Replace the self-protected-only advisory with the all-plans advisory |
| scripts/test-plan-paths.sh | 870-885 | Cases for the four states |
| scripts/test-check-approval-blockers.sh | 45-62 | `write_plan`: declare a last-wave Verify |
| scripts/test-check-approval-blockers.sh | 170-190 | `write_tier_plan`: declare a last-wave Verify |
| scripts/test-check-approval-blockers.sh | 240-271 | New blocker cases |
| scripts/test-lint-plan.sh | 1410-1470 | Rewrite the #236 advisory cases for the new wording and scope |
| harness/cli.js | 612-640 | `parseWaveVerify`: skip `none` |
| harness/test/cli.test.js | 86-110 | Add `none` parsing cases next to the existing Verify test |
| harness/evals/lib/fixture.js | 36-48 | `defaultPlan`: add the none-Verify line |
| harness/evals/approval.eval.js | 258-270 | `twoWavePlan`: none-Verify in wave 2 |
| harness/evals/delivery.eval.js | 36-48 | `verifyHangPlan`: replace the none line instead of adding a second |
| .rad/skills/rad-plan/SKILL.md | 345-360 | Template rule text |
| .rad/skills/rad-adopt/SKILL.md | 256-271 | Template rule text |
| .rad/skills/rad-approve/SKILL.md | 148-156 | List the new blocker |
| .rad/skills/rad-approve/SKILL.md | 214-226 | Blockers and waivers wording |
| .agents/skills/rad-plan/SKILL.md | 345-360 | Regenerated (do not hand-edit) |
| .claude/commands/team/rad-plan.md | 345-360 | Regenerated (do not hand-edit) |
| .agents/skills/rad-adopt/SKILL.md | 256-271 | Regenerated (do not hand-edit) |
| .claude/commands/team/rad-adopt.md | 256-271 | Regenerated (do not hand-edit) |
| .agents/skills/rad-approve/SKILL.md | 148-226 | Regenerated (do not hand-edit) |
| .claude/commands/architect/rad-approve.md | 148-226 | Regenerated (do not hand-edit) |
| docs/rad-cli.md | 790-800 | Verify guidance: blocker and the `none (reason)` escape |
| docs/daily-workflow.md | 205-216 | Same |
| docs/rad-wave-contract.md | 346-358 | Same |
| docs/rad-decisions.md | 21-21 | The Verify bullet: blocker, not warning |

## Execution Notes

### Do Not Touch
- harness/spine.js and harness/adapters/agent/contract.js (they already read an absent `waveVerify` entry as "no check")
- scripts/check-verify.sh and harness/plan-fingerprint.js
- harness/gates.js, harness/gates.yaml, harness/matrix.yaml
- The existing high-risk, clarification-marker and light-tier blocker logic

### Key Files
- scripts/lib/plan-paths.sh — one source of truth for plan parsing; `plan_tier` (~642) and `plan_light_violations` (~692) are the patterns to follow
- scripts/check-approval-blockers.sh — `report_blockers` and `main`; light-tier violations are the non-waivable precedent
- harness/cli.js — `parseWaveVerify` (~612); the bash helper must mirror it exactly (same block scoping, last line wins)
- harness/evals/lib/fixture.js — the shared plan builder behind 37 evals
- harness/test/skill-bodies.test.js — asserts the template text still contains `Verify: exec bash scripts/verify-all.sh`; keep that string

### Reminders
- harness/, scripts/ and .rad/ are self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- Generated files come from `node harness/cli.js generate`; never edit them by hand; finish with `generate --check`.
- Name `bare` carefully: `Verify: none` without a reason must not silently pass, and must not be run as a shell command either.
- Placing a `Verify:` line: the LAST one in a wave block wins in both the bash helper and `parseWaveVerify`. Fixtures that inject their own `Verify:` must replace, not add.
- `rad approve` does not run `lint-plan.sh`; the blocker is the new gate at approval, and the lint is the early warning.
- Keep functions under ~40 lines; shell tests follow the existing `test-*.sh` style.

## Program Design

Signatures:

```bash
# scripts/lib/plan-paths.sh
plan_last_wave_verify <plan>      # -> "<N> yes|no|none|bare"  (nothing when no waves)

# scripts/check-approval-blockers.sh
missing_verify_blocker <plan>     # -> one stderr line + count 1, or nothing
```

```js
// harness/cli.js
parseWaveVerify(text)             // none / "none (x)" (any case) => wave absent from the map
```

Call stack:

```
rad approve -> check-approval-blockers.sh
              -> plan_tier (light => skip) -> plan_last_wave_verify (no|bare => blocker)
lint-plan.sh  -> plan_last_wave_verify (no|bare => advisory)
rad deliver   -> parseWaveVerify (none => no entry) -> spine / wave prompt: "no check"
```

File tree diff:

```
scripts/lib/plan-paths.sh, check-approval-blockers.sh, lint-plan.sh   changed
scripts/test-plan-paths.sh, test-check-approval-blockers.sh, test-lint-plan.sh   changed
harness/cli.js, harness/test/cli.test.js                              changed
harness/evals/lib/fixture.js, approval.eval.js, delivery.eval.js      changed
.rad/skills/{rad-plan,rad-adopt,rad-approve}/SKILL.md + 6 generated copies   changed
docs/{rad-cli,daily-workflow,rad-wave-contract,rad-decisions}.md      changed
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.2 uses the state from 1.1).
Verify: bash scripts/test-plan-paths.sh && bash scripts/test-check-approval-blockers.sh && bash scripts/test-lint-plan.sh

#### Task 1.1: Four-state helper
File: scripts/lib/plan-paths.sh:548-575
What: Extend `plan_last_wave_verify` to print `yes`, `no`, `none` or `bare` as in AC#1, keeping its block scoping and its "last Verify line wins" behavior. Update the header comment.
Validate: AC#1 — cases in `test-plan-paths.sh:870-885` for each state, a mid-sentence `Verify:` (still not counted), an earlier-wave Verify, no waves, and a `Verify: none ()`.

#### Task 1.2: The blocker and the advisory
File: scripts/check-approval-blockers.sh:1-30, 106-160, scripts/lint-plan.sh:383-398
What: In `check-approval-blockers.sh`, skip the rule for `Tier: light` and for plans with no waves; otherwise report `missing-verify` for `no` and `bare` as a non-waivable blocker counted with the others. In `lint-plan.sh`, replace the self-protected-only advisory with one for every plan in those states.
Validate: AC#2, AC#3, AC#5 — exit codes and stderr text per the cases in Task 1.3.

#### Task 1.3: Script tests and fixture helpers
File: scripts/test-check-approval-blockers.sh:45-62, 170-190, 240-271, scripts/test-lint-plan.sh:1410-1470
What: Make `write_plan` and `write_tier_plan` declare a last-wave Verify so existing cases keep their meaning. Add cases: standard plan with no Verify blocked; `bare` blocked; `none (reason)` clears; real command clears; light plan exempt; no-waves not blocked; a waiver bullet named `missing-verify` does not clear it; existing blockers unchanged. Rewrite the #236 advisory cases for the new wording and the all-plans scope, including the light-plan case.
Validate: AC#2, AC#3, AC#5, AC#7 — each listed case has its own named assertion.

### Wave 2 — sequential
Tasks in this wave must run in sequence (2.2 depends on 2.1).
Verify: node --test harness/test/cli.test.js harness/test/deliver-gate-hook.test.js && node --test harness/evals/*.eval.js

#### Task 2.1: Parse `none` as no command
File: harness/cli.js:612-640, harness/test/cli.test.js:86-110
What: In `parseWaveVerify`, skip a value matching `none` (case-insensitive) followed by end of value, whitespace or `(`. Add tests: `none (x)`, `None (x)`, bare `none`, `nonexistent-tool` (still a command), and a wave with an earlier command then a later `none` (last wins).
Validate: AC#4, AC#7.

#### Task 2.2: Fixtures and evals
File: harness/evals/lib/fixture.js:36-48, harness/evals/approval.eval.js:258-270, harness/evals/delivery.eval.js:36-48
What: `defaultPlan` gains `Verify: none (fixture: nothing to run)` as the last line of its wave block (before `## Tests to Write`); `twoWavePlan` adds the same line to wave 2; `verifyHangPlan` replaces that line with `Verify: sleep N`. No eval's intent changes.
Validate: AC#6 — the whole scripted-eval suite and `deliver-gate-hook.test.js` pass; `verify-hang` still times out as before.

### Wave 3 — sequential
Tasks in this wave must run in sequence (3.2 regenerates from 3.1).
Verify: exec bash scripts/verify-all.sh

#### Task 3.1: Templates, approve skill and docs
File: .rad/skills/rad-plan/SKILL.md:345-360, .rad/skills/rad-adopt/SKILL.md:256-271, .rad/skills/rad-approve/SKILL.md:148-156, 214-226, docs/rad-cli.md:790-800, docs/daily-workflow.md:205-216, docs/rad-wave-contract.md:346-358, docs/rad-decisions.md:21-21
What: Reword the rule in both templates (every non-light plan needs a last-wave `Verify:` or `Verify: none (reason)`; keep the `Verify: exec bash scripts/verify-all.sh` string for plans touching RAD machinery). Add the blocker to the approve skill's blocker description. Update the four docs from advisory to blocker, describing the escape and the light exemption.
Validate: AC#8 — wording present; `harness/test/skill-bodies.test.js` still passes.

#### Task 3.2: Regenerate
File: .agents/skills/rad-plan/SKILL.md:345-360, .claude/commands/team/rad-plan.md:345-360, .agents/skills/rad-adopt/SKILL.md:256-271, .claude/commands/team/rad-adopt.md:256-271, .agents/skills/rad-approve/SKILL.md:148-226, .claude/commands/architect/rad-approve.md:148-226
What: Run `node harness/cli.js generate` and keep only these six regenerated outputs. Do not hand-edit them.
Validate: AC#8 — `node harness/cli.js generate --check` exits 0.

#### Task 3.3: Full-suite check
File: docs/rad-decisions.md:21-21
What: No further edit. The wave's Verify runs the full suite.
Validate: AC#9 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Four states of the helper — scripts/test-plan-paths.sh
- [ ] Blocker cases (standard, bare, none, command, light, no waves, waiver ignored) — scripts/test-check-approval-blockers.sh
- [ ] Lint advisory for all plans and tiers — scripts/test-lint-plan.sh
- [ ] `parseWaveVerify` none cases — harness/test/cli.test.js

## Non-Goals
- Checking that a `Verify:` command can actually fail (V18)
- Applying the blocker retroactively to plans that already delivered
- Showing the `none` reason in the wave prompt (the prompt says no `Verify:` is declared)
- Changing the light tier or the waiver mechanism for the other blockers

## Out-of-Scope Dependencies
None.

## Risks
- Re-approving an old plan that has no last-wave Verify will now be blocked until the plan gains a `Verify:` or a `none (reason)` line. That plan edit changes its fingerprint, which a re-approval records anyway.
- The bash helper and `parseWaveVerify` must stay in lockstep; a mismatch would make the blocker and the runtime disagree. AC#1 and AC#4 test both with the same inputs.
- A plan author can write `Verify: none (x)` to get past the blocker. That is the intended escape: the reason is on record and in the approved plan for the architect to judge.
- Fixture changes touch the adversarial evals' shared builder; any eval that depends on a plan with no Verify would change meaning. The probe found none beyond those named; the full-suite Verify is the net.

## Issue Gaps
- ASSUMPTION: "bare" `Verify: none` (no reason) is a blocker with a clear message, because the point of the escape is the recorded reason. The issue does not say how to treat it.
- ASSUMPTION: the match for the escape is `none` at the start of the value, case-insensitive; `none (reason)` needs a non-blank reason inside parentheses.
- ASSUMPTION: no-wave plans are not blocked (nothing to verify), and other lint errors already cover malformed plans.
- ASSUMPTION: #236's earlier "revisit after about 10 plans" trigger is superseded by the architect's 2026-10-12 decision recorded on the issue.
- ASSUMPTION: doc and skill line ranges are estimates from grep results; the executor should stay within the declared files and confirm the exact lines.
