# Plan: Sensitive Content Flag (plan-time)
Created: 2026-11-09
Author: developer
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-09T14:52:07.792Z
Recorded-By: sean@torchcodelab.com
Branch: rad/sensitive-content-flag
Source-Author: none (no source issue)
Source-Comments: none

## Context
RAD flags risky plans only by path (`RAD_HIGH_RISK_PATTERNS` against Files in Scope), so a plan that changes sensitive behavior in an innocuously named file is never flagged. Add a content-based scan of the plan text, sharing one named pattern list, whose hits are waivable approval blockers reusing the existing `## Waivers` mechanism and frozen into the `approved` event. This is Plan A of two: the diff-time digest and review finding is a follow-up plan (see Non-Goals) that adds a `diff` mode to the same script.

## Scope
| In scope | Out of scope |
|---|---|
| New `scripts/check-sensitive-content.sh` with a `plan` mode and a `pattern` mode, one built-in named pattern table | The `diff` mode, the review digest item and the rad-review finding (Plan B) |
| `RAD_SENSITIVE_CONTENT_PATTERNS` override, validated, recorded in the approved event when non-default | Any change to approved-event fingerprint rules, `harness/plan-fingerprint.js`, `harness/gates.js` or `gates.yaml` |
| `sensitive-content:<id>` blockers and waivers in `check-approval-blockers.sh` and `lint-plan.sh` | A new CI job or required status; `check-approval-integrity.sh` changes |
| `rad approve` freezing the non-default pattern; rad-approve skill source, docs and invariants | A `.rad/config.yml` setting for the pattern (env only) |

## Acceptance Criteria
1. `scripts/check-sensitive-content.sh plan <plan-file>` prints one `sensitive-content:<id>` line per matched built-in pattern id (ids: `dynamic-eval`, `permission-change`, `destructive-sql`, `credential-handling`, `network-egress`, `privilege-escalation`), exits 0 when there are no hits, and exits 2 on a missing or unreadable plan or on an invalid pattern.
2. The `plan` scan reads only the Context, Scope, wave task `What:` text and Files-in-Scope Change cells; it ignores fenced code blocks and the `## Non-Goals`, `### Do Not Touch` and `## Waivers` sections, so a term used only there never flags.
3. `RAD_SENSITIVE_CONTENT_PATTERNS` (empty or unset means the built-in table) replaces the table with one extended regex reported under the single id `custom`; a value that is empty after trimming is treated as unset, and a value with a leading `-`, a newline, or a regex that does not compile exits 2 with nothing on stdout.
4. `scripts/check-approval-blockers.sh` treats each current `sensitive-content:<id>` as a blocker, a `## Waivers` bullet `- sensitive-content:<id>: <justification>` with a non-empty justification waives it (applied waivers print as `<id>\t<justification>`), a waiver for an id that is not currently a finding is not applied, and clarification markers remain unwaivable.
5. When the effective pattern is non-default, `check-approval-blockers.sh` prints a `sensitive-content-patterns\t<pattern>` tag line on stdout (exit 0), which can never parse as a waiver id.
6. `scripts/lint-plan.sh` reports sensitive-content findings as approval blockers and does not report a waiver for a currently-flagged `sensitive-content:<id>` as stale.
7. `rad approve` freezes applied sensitive-content waivers into `approved.data.waivers` and records the non-default pattern as `approved.data.sensitiveContentPattern` only when present; the event is accepted by the existing validators and the plan fingerprint rules are unchanged.
8. The rad-approve skill source documents the `sensitive-content:<id>` waiver form and tag line; `docs/configuration.md` documents `RAD_SENSITIVE_CONTENT_PATTERNS` and the pattern ids; `docs/invariants.yaml` records the new override as a guarded bypass; generated copies show no drift.

## Agent Scope
Research used a read-only Explore sub-agent over `scripts/`, `harness/`, `.rad/skills/` and `docs/`. The feature touches self-protected paths (`scripts/`, `harness/`, `.rad/`), so it needs architect review; no out-of-scope agent dependency.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/check-sensitive-content.sh | 1-200 | New script (mode 100755): pattern table, `plan` and `pattern` modes |
| scripts/test-check-sensitive-content.sh | 1-240 | New hermetic test (mode 100755) |
| scripts/check-approval-blockers.sh | 70-83 | Applied waivers include current sensitive-content ids |
| scripts/check-approval-blockers.sh | 99-130 | Report sensitive-content blockers |
| scripts/check-approval-blockers.sh | 137-166 | Second provenance tag line; main wiring |
| scripts/test-check-approval-blockers.sh | 330-347 | New cases: blocker, waived, stale waiver, tag line |
| scripts/lint-plan.sh | 935-965 | Sensitive-content blockers and stale-waiver exemption |
| scripts/test-lint-plan.sh | 1540-1557 | New cases for sensitive-content lint behavior |
| scripts/test-draft-insights-plan.sh | 38-46 | Fixture copies `check-sensitive-content.sh` into its temp repo (lint-plan.sh now calls it) |
| scripts/test-lint-plan-preflight.sh | 32-40 | Fixture copies `check-sensitive-content.sh` into its temp repo (lint-plan.sh now calls it) |
| harness/cli.js | 2551-2580 | `parseBlockerStdout` second tag branch |
| harness/cli.js | 2720-2730 | Pass `sensitiveContentPattern` into `recordApproval` |
| harness/adapters/git-state-store.js | 146-152 | Validate the optional field |
| harness/adapters/git-state-store.js | 417-431 | Freeze `sensitiveContentPattern` into the event when present |
| harness/adapters/git-state-store.js | 460-480 | Thread the field through `recordApprovalFor` |
| harness/test/cli-approve-sensitive.test.js | 1-140 | New node test: waiver freezing, pattern recording, absent field |
| .rad/skills/rad-approve/SKILL.md | 140-155 | Source: blocker script description |
| .rad/skills/rad-approve/SKILL.md | 217-255 | Source: summary Waivers line, applied waivers and pattern note |
| .agents/skills/rad-approve/SKILL.md | 140-255 | Regenerated copy |
| .claude/commands/architect/rad-approve.md | 140-255 | Regenerated copy |
| .agents/skills/rad-approve/agents/openai.yaml | 1-30 | Regenerated; changes only if the frontmatter description changes |
| docs/configuration.md | 87 | Env var table row |
| docs/configuration.md | 547-590 | New short section after Plan Lint high-risk paths |
| docs/invariants.yaml | 60-80 | `approval-blockers-refuse`: claim, enforced_by, new guarded bypass |

## Program Design
1. Signatures (new script, bash 3.2 safe):
   - `effective_pattern` → echoes the validated override or empty; `die 2` on invalid.
   - `plan_scan_text <plan-file>` → prints only the scannable plan text (fence- and section-aware awk reusing `RAD_FENCE_LINE_RE` from `scripts/lib/plan-paths.sh`).
   - `matched_ids <text>` → ids whose pattern matches; with an override, the single id `custom`.
   - `main` → `plan <file>` prints `sensitive-content:<id>` lines; `pattern` prints the effective override (empty for default).
2. Control flow: `check-approval-blockers.sh` calls `check-sensitive-content.sh plan` and `pattern`; merges the ids into its finding set and waiver matching; prints the tag line `sensitive-content-patterns\t<pattern>` when `pattern` is non-empty. `harness/cli.js parseBlockerStdout` maps that tag to `sensitiveContentPattern` and `recordApproval` writes it to `data.sensitiveContentPattern` only when present, exactly as `highRiskPattern` is handled.
3. File tree: `+ scripts/check-sensitive-content.sh`, `+ scripts/test-check-sensitive-content.sh`, `+ harness/test/cli-approve-sensitive.test.js`; edits elsewhere as listed.

## Execution Notes

### Do Not Touch
- `harness/plan-fingerprint.js`, `harness/fingerprint.js`, `harness/gates.js`, `harness/gates.yaml`, `harness/transitions.js` — approval validity and fold rules stay as they are.
- `scripts/check-events-append-only.sh`, `scripts/check-ledger-append-only.sh`, CI workflow files — no new gate or required status.
- `scripts/lint-shell-safety-baseline.txt`, `scripts/lint-function-length-baseline.txt` — do not add baseline entries; guard inputs and keep functions short.
- `.agents/skills/`, `.claude/commands/` copies — produced by `node harness/cli.js generate`; never hand-edit.

### Key Files
- scripts/check-approval-blockers.sh — blocker, waiver and tag-line contract this plan extends.
- scripts/lib/plan-paths.sh — `RAD_FENCE_LINE_RE`, `plan_waivers`, `plan_high_risk_findings` to mirror (not edited).
- harness/adapters/git-state-store.js — where `highRiskPattern` is validated and frozen; mirror it.

### Reminders
- Guard `RAD_SENSITIVE_CONTENT_PATTERNS` with `case`/`[[ =~ ]]` before it reaches `grep`; pass the pattern with `-e` and `--` so a leading dash cannot become an option. New scripts must be mode 100755; bash 3.2 safe.
- This plan's own text uses sensitive words as examples; once the scan ships, later plans describing them should keep examples fenced or in Non-Goals.
- Verify whether the approved-event validator rejects unknown `data` keys before relying on the new field (AC7 test).
- Wave 4 runs `scripts/verify-all.sh` (about 8 minutes): deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: Sensitive content script
File: scripts/check-sensitive-content.sh:1-200
What: Create the script (mode 100755) per Program Design: named pattern table, validated override, fence- and section-aware plan text extraction, `plan` and `pattern` modes, bash 3.2 safe, functions under 40 lines.
Validate: AC#1, AC#2, AC#3 — fixture plans produce the expected ids and exit codes.

#### Task 1.2: Script test
File: scripts/test-check-sensitive-content.sh:1-240
What: Create a hermetic test (mode 100755) with one labelled case each for: empty plan text; plan with no sensitive terms; each built-in id hit; term only inside a fenced block; term only in Non-Goals, Do Not Touch and Waivers sections; term in a task `What:` and in a Files-in-Scope Change cell (flagged); missing plan file; override unset, empty and whitespace-only (default table); override with leading dash, newline and a regex that does not compile (exit 2, empty stdout); a valid override reported as `custom`; `pattern` mode output for default and override.
Validate: AC#1, AC#2, AC#3 — `bash scripts/test-check-sensitive-content.sh` exits 0 with ALL PASS.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Approval blockers integration
File: scripts/check-approval-blockers.sh:70-83, 99-130, 137-166
What: Call the new script, add current `sensitive-content:<id>` ids to the finding set, apply waivers by exact id match with non-empty justification, report unwaived ones as blockers, and print the `sensitive-content-patterns` tag line for a non-default pattern. Add the matching cases to scripts/test-check-approval-blockers.sh:330-347 (unwaived blocker, waived, waiver for a non-finding id not applied, empty justification not applied, tag line present and absent, marker still unwaivable).
Validate: AC#4, AC#5 — `bash scripts/test-check-approval-blockers.sh` exits 0 with ALL PASS.

#### Task 2.2: Plan lint integration
File: scripts/lint-plan.sh:935-965
What: Report sensitive-content findings as approval blockers and exempt a waiver for a currently-flagged `sensitive-content:<id>` from the stale-waiver warning. Add cases to scripts/test-lint-plan.sh:1540-1557.
Validate: AC#6 — `bash scripts/test-lint-plan.sh` exits 0 with ALL PASS.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Record the pattern in the approved event
File: harness/cli.js:2551-2580, 2720-2730, harness/adapters/git-state-store.js:146-152, 417-431, 460-480
What: In `parseBlockerStdout` map the `sensitive-content-patterns` tag line (duplicate line is an error, as for the high-risk tag) to `sensitiveContentPattern`; thread it through `recordApproval` into `data.sensitiveContentPattern`, validated as a non-empty string and written only when present.
Validate: AC#7 — covered by Task 3.2.

#### Task 3.2: Harness test
File: harness/test/cli-approve-sensitive.test.js:1-140
What: Create a node test with synthetic stdout: a sensitive-content waiver is frozen into `waivers`; the non-default pattern is recorded as `sensitiveContentPattern`; the field is absent for the default; an empty or duplicate tag line is rejected; the resulting event passes the existing event validators; the plan fingerprint is unchanged by the new field.
Validate: AC#7 — `node --test harness/test/cli-approve-sensitive.test.js` and the existing approve tests pass.

### Wave 4 — sequential
Depends on: Wave 3 complete

#### Task 4.1: Skill source
File: .rad/skills/rad-approve/SKILL.md:140-155, 217-255
What: Document the `sensitive-content:<id>` waiver form, the Blockers & Waivers rendering, the `sensitive-content-patterns` tag line and the instruction to judge each justification. Run `node harness/cli.js generate` to refresh the generated copies.
Validate: AC#8 — `node harness/cli.js generate --check` shows no drift.

#### Task 4.2: Docs and invariant
File: docs/configuration.md:87, 547-590, docs/invariants.yaml:60-80
What: Add the `RAD_SENSITIVE_CONTENT_PATTERNS` env row and a short section (pattern ids, section and fence rules, waiver form, override behavior, recorded in the event). In `docs/invariants.yaml` extend `approval-blockers-refuse` (claim, enforced_by the new script) and add a guarded bypass `sensitive-content-patterns-override`.
Validate: AC#8 — `scripts/lint-invariants.sh` and `bash scripts/test-lint-invariants.sh` pass; both docs contain the new text.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] Script cases listed in Task 1.2 — scripts/test-check-sensitive-content.sh
- [ ] Blocker, waiver and tag-line cases — scripts/test-check-approval-blockers.sh
- [ ] Lint cases — scripts/test-lint-plan.sh
- [ ] Approve recording cases — harness/test/cli-approve-sensitive.test.js

## Non-Goals
- The `diff` mode, the review-digest item and the rad-review finding: a follow-up Plan B (`sensitive-content-diff`) adds them to this script.
- A `.rad/config.yml` setting for the pattern list, a new CI job or required status, or any change to the fingerprint and gate-fold rules.
- Per-line or per-file reporting: findings are per pattern id for the whole plan.

## Out-of-Scope Dependencies
None

## Risks
- A broad default pattern could flag many plans and train waiver fatigue; keep the default list narrow (dangerous-call and destructive-statement shapes, not common nouns) and cover false positives with tests.
- `check-approval-blockers.sh` and `lint-plan.sh` duplicate the finding flow; both must call the same script so they cannot disagree.
- Self-protected paths (`scripts/`, `harness/`, `.rad/`) mean this plan is flagged for architect review.
- Wave 4 runs `verify-all.sh` (about 8 minutes) and needs the extended wave timeout.
