# Plan: Sensitive Content Flag (diff-time)
Created: 2026-11-09
Author: developer
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-09T17:23:00.338Z
Recorded-By: sean@torchcodelab.com
Branch: rad/sensitive-content-diff
Source-Author: none (no source issue)
Source-Comments: none

## Context
Plan A (PR #309) added a content scan of the plan text. A delivered diff can still add sensitive behavior the plan never mentioned. Add a `diff` mode to `scripts/check-sensitive-content.sh` that scans only the lines a deliver branch added, using the same pattern table and override, and surface the result as reviewer information in the review digest and in the rad-review report. It never gates anything.

## Scope
| In scope | Out of scope |
|---|---|
| `check-sensitive-content.sh diff <base> <head>` over added lines, with exclusions, a location cap and strict exit codes | Any gate, required CI status, or change to `check-approval-blockers.sh` or the approved-event schema |
| Digest item kinds `sensitive-content` and `sensitive-content-waived`, and an unavailable state | Changing plan-mode behavior or the built-in pattern table, except tightening if the measured rate is high |
| rad-review: the hand-written Claude command, the Codex source and its generated copy | New env vars; an `openai.yaml` for rad-review (none exists) |
| `docs/configuration.md` section update; a measured flagged rate on recent deliver diffs | Scanning deleted or context lines, test files, markdown or `.agents/` |

## Acceptance Criteria
1. `check-sensitive-content.sh diff <base> <head>` scans only lines added by the three-dot diff `base...head`; deleted and context lines are never flagged; an added comment line is scanned; files that are tests (the shared `RAD_TEST_PATH_RE`), markdown (`.md`), or under `.agents/` are not scanned; binary files, rename-only changes and an empty diff yield no hits.
2. Output is one line per matched id: `sensitive-content:<id>`, a tab, the hit count, a tab, then up to `MAX_LOCATIONS` comma-separated `path:line` locations in diff order; exit 0 whether or not there are hits; ids come out in the built-in table order; the same table and the same `RAD_SENSITIVE_CONTENT_PATTERNS` override as plan mode apply, with an override reported under `custom`.
3. A usage error, an unsafe ref (leading dash, a newline, or characters outside a named safe set), a base or head that does not resolve to a commit, or an invalid override exits 2 with EMPTY stdout and a message on stderr; an error is never reported as no hits, and the script writes no file.
4. The digest (`harness/digest.js`) gains a `sensitiveDiff` input and the item kinds `sensitive-content` (a diff hit whose id has no waiver, rendered HIGH) and `sensitive-content-waived` (covered by a `sensitive-content:<id>` waiver, taken from the frozen approved event first and from the plan `## Waivers` section otherwise); a failed or impossible scan appears as unavailable with its reason, is never shown as zero hits, and never makes the digest fail.
5. `.claude/commands/team/rad-review.md` (edited by hand), `.rad/skills/rad-review/SKILL.md` and its generated copy run the diff scan and report uncovered hits as an advisory finding (under Conventions in the Claude command, in the combined summary in the Codex skill); the finding does not change READY or NEEDS FIXES and does not add to Blocking issues; an exit 2 is reported, not fatal.
6. `docs/configuration.md` documents the diff mode, its exclusions (tests, markdown, `.agents/`, comment lines still scanned), the output format and cap, the exit codes and the digest and review use.
7. The diff scan is run against the last 10 merged deliver commits on `main` (each `<sha>^` to `<sha>`); the flagged count out of 10 and the patterns that fired are recorded in the task result; if more than 2 of the 10 are flagged the built-in patterns are tightened until at most 2 are, and the plan-mode corpus guard in `scripts/test-check-sensitive-content.sh` still passes.
8. Existing behavior is unchanged: plan mode and `pattern` mode output are identical, `scripts/lib/plan-paths.sh` is the only library the script sources (the three fixtures that copy it still pass), and `check-approval-blockers.sh`, `harness/events.js` and the approved-event schema are untouched.

## Agent Scope
Research used a read-only Explore sub-agent over `scripts/`, `harness/`, `.rad/skills/rad-review/`, `.claude/commands/team/` and `docs/`. It found that the Claude command is hand-written (not generated) and has the digest step and Conventions section, while the Codex source has neither, and that there is no `openai.yaml` for rad-review. Self-protected paths are touched, so architect review is required; no out-of-scope agent dependency.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/check-sensitive-content.sh | 1-169 | Add `diff` mode, shared id-regex helper, ref validation, added-line extraction, tally and cap; header and usage |
| scripts/test-check-sensitive-content.sh | 120-151 | New hermetic temp-repo cases for diff mode |
| harness/digest.js | 18-36 | Rank list, scripts and input keys |
| harness/digest.js | 103-151 | Gather the diff scan input |
| harness/digest.js | 165-228 | Item builder, collection and evidence |
| harness/test/digest.test.js | 22-70 | Fixtures and ranking test for the new kinds |
| harness/test/digest.test.js | 147-208 | Gather tests with the new scan call |
| harness/test/cli.test.js | 1731-1800 | Digest command stubs, only if they assume the call set |
| .claude/commands/team/rad-review.md | 71-93 | Hand-written: diff scan in the lint advisories step |
| .claude/commands/team/rad-review.md | 301-310 | Hand-written: advisory line in the Conventions template |
| .rad/skills/rad-review/SKILL.md | 39-57 | Source: diff scan command and bullet in Step 2 |
| .rad/skills/rad-review/SKILL.md | 101-110 | Source: combined-summary bullet |
| .agents/skills/rad-review/SKILL.md | 33-51 | Regenerated copy of Step 2 |
| .agents/skills/rad-review/SKILL.md | 95-104 | Regenerated copy of the summary bullet |
| harness/test/rad-review-exercise.test.js | 1-54 | Assert the diff-scan step in all three bodies |
| docs/configuration.md | 573-612 | Extend the Sensitive Content section |

## Program Design
1. Signatures (shell, bash 3.2 safe, each function under 40 lines):
   - `id_regex <id> <override>` prints the regex for a built-in id or the override for `custom`; plan mode and diff mode both use it.
   - `validate_ref <name> <value>` dies with exit 2 on a leading dash, newline, or an unsafe character, then checks it resolves to a commit.
   - `diff_added_lines <base> <head>` prints `path<TAB>line<TAB>text` for added lines in scanned files only.
   - `tally_hits <override>` reads those rows and prints the per-id lines with count and capped locations.
   - `run_diff <base> <head>` ties them together; every die happens before any stdout.
   - `MAX_LOCATIONS` is a named constant at the top.
2. Digest (`harness/digest.js`): `gatherDigestInputs` adds `sensitiveDiff` (parsed rows `{id, count, locations}` or `{unavailable: reason}`); `sensitiveItems(diff, waivers)` mirrors the high-risk item builder with the key `sensitive-content:<id>`; both new kinds slot into the rank list after the high-risk kinds and before self-protected.
3. File tree: no new files; edits as listed.

## Execution Notes

### Do Not Touch
- `scripts/check-approval-blockers.sh`, `scripts/lint-plan.sh`, `harness/events.js`, `harness/gates.js`, `harness/gates.yaml` — no gate, no schema change.
- `scripts/lib/plan-paths.sh` — reuse `RAD_TEST_PATH_RE` and `path_matches`; do not edit.
- `.agents/skills/rad-review/SKILL.md` — generated; change only through `node harness/cli.js generate`.
- `scripts/lint-shell-safety-baseline.txt`, `scripts/lint-function-length-baseline.txt` — no baseline growth.

### Key Files
- scripts/check-sensitive-content.sh — the pattern table, `effective_pattern` and plan mode to extend.
- harness/digest.js — `readWaivers`, `highRiskItems` and the unavailable-input handling to mirror.
- .claude/commands/team/rad-review.md — the only rad-review body with the digest step and Conventions.

### Reminders
- The script must source only `scripts/lib/plan-paths.sh`: three test fixtures copy exactly that into temp repos, and a new library would break them.
- Refs reach git as arguments, never through a shell; check them against a safe set first and use `rev-parse --verify` on each.
- The Claude command is hand-written: edit it directly. The Codex source is edited, then `node harness/cli.js generate` refreshes `.agents/skills/rad-review/SKILL.md`.
- For the measurement task, list deliver merges with `git log --first-parent --format=%H -n 10 main` and run `diff <sha>^ <sha>` for each; record the count and fired ids in the task result.
- The headless agent may be unable to write under `.claude/` with its edit tool (the plan lint warns about this). Make the hand edit of `.claude/commands/team/rad-review.md` through the shell, and if it is still refused, stop that file and say so in the task result instead of working around it; the architect applies that one edit by hand after delivery.
- This plan's own text avoids code-shaped sensitive patterns on purpose; later plans describing them should fence the examples.
- Wave 3 runs `scripts/verify-all.sh` (about 8 minutes): deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: Diff mode
File: scripts/check-sensitive-content.sh:1-169
What: Add the `diff` mode per Program Design: extract the shared `id_regex`, add `validate_ref`, `diff_added_lines`, `tally_hits` and `run_diff`, wire `main` and the usage text, update the header comment (modes, output format, exclusions, comment lines are scanned, exit codes). Plan and `pattern` modes must behave exactly as before.
Validate: AC#1, AC#2, AC#3, AC#8 — exercised by Task 1.2.

#### Task 1.2: Diff mode tests
File: scripts/test-check-sensitive-content.sh:120-151
What: Add hermetic temp-repo cases, one labelled case each: empty diff; only deleted sensitive lines (not flagged); added sensitive line (flagged) and the same in a comment (flagged); added line in a test file, a markdown file and under `.agents/` (not scanned); binary file; rename with no added lines; unreachable base and unreachable head (exit 2, empty stdout); hostile refs (leading dash, newline, metacharacters); invalid and valid override (`custom`); count and the `MAX_LOCATIONS` cap with order stable across two runs; ids in table order; plan mode output unchanged.
Validate: AC#1, AC#2, AC#3, AC#8 — `bash scripts/test-check-sensitive-content.sh` exits 0 with ALL PASS.

#### Task 1.3: Measure against recent deliveries
File: scripts/check-sensitive-content.sh:1-169
What: Run the diff scan for each of the last 10 deliver commits on `main` (each commit's parent to the commit) and record in the task result how many were flagged and which ids fired. If more than 2 of 10 are flagged, tighten the built-in patterns until at most 2 are, keeping the plan-mode corpus guard and all existing tests passing; otherwise change nothing.
Validate: AC#7 — the recorded rate is at most 2 of 10 and `bash scripts/test-check-sensitive-content.sh` still passes.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Digest items
File: harness/digest.js:18-36, 103-151, 165-228
What: Add the two item kinds to the rank list, the `sensitiveDiff` input key and gather step (an unresolvable base or branch, or a non-zero scan, becomes `{unavailable: reason}`), the item builder resolving waivers from the frozen approved event first and the plan second, and an evidence line for the scan. Never throw from the new code.
Validate: AC#4 — exercised by Task 2.2.

#### Task 2.2: Digest tests
File: harness/test/digest.test.js:22-70, 147-208, harness/test/cli.test.js:1731-1800
What: Extend the clean and flagged input fixtures and the ranking test for the new kinds; add cases for a waived hit, an uncovered hit rendered HIGH, an unavailable scan with its reason, a frozen waiver preferred over the plan, and the gather stub for the new call; adjust the digest command stubs in `cli.test.js` only if they assume the call set.
Validate: AC#4 — `node --test harness/test/digest.test.js harness/test/cli.test.js` passes.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: rad-review bodies
File: .claude/commands/team/rad-review.md:71-93, 301-310, .rad/skills/rad-review/SKILL.md:39-57, 101-110
What: In the Claude command (by hand) run the diff scan next to the lint advisories and add the advisory line to the Conventions template; in the Codex source add the command and bullet to Step 2 and a combined-summary bullet. In both, uncovered hits are advisory, never change READY or NEEDS FIXES, never count as Blocking issues, and an exit 2 is reported and not fatal. Run `node harness/cli.js generate` to refresh `.agents/skills/rad-review/SKILL.md`.
Validate: AC#5 — `node harness/cli.js generate --check` shows no drift and the step appears once in each body.

#### Task 3.2: rad-review body test
File: harness/test/rad-review-exercise.test.js:1-54
What: Add assertions that all three bodies run the diff scan and state it is advisory.
Validate: AC#5 — `node --test harness/test/rad-review-exercise.test.js` passes.

#### Task 3.3: Configuration doc
File: docs/configuration.md:573-612
What: Extend the Sensitive Content section with the diff mode, output format and cap, the exclusions and comment-line behavior, the exit codes, and the digest and review use.
Validate: AC#6 — the section contains the new text.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] Diff mode cases listed in Task 1.2 — scripts/test-check-sensitive-content.sh
- [ ] Digest cases listed in Task 2.2 — harness/test/digest.test.js
- [ ] rad-review body assertions — harness/test/rad-review-exercise.test.js

## Non-Goals
- Making a diff hit a gate: no required status, no approval or merge refusal, no change to READY or NEEDS FIXES.
- Scanning tests, markdown, `.agents/` or deleted lines, or inferring intent (an added comment is scanned and may be a false positive).
- Persisting diff hits as findings or feeding them to the recurrence drafter.

## Out-of-Scope Dependencies
None

## Risks
- Added-line scanning can flag legitimate code (a script that must change a permission); the digest shows it as HIGH only until a waiver is recorded. The measurement task keeps the default rate low.
- Writing under `.claude/` may be refused for a headless agent; if so Task 3.1 reports it and the architect applies that one edit (see Reminders), which would show as a stop on wave 3.
- Hand-editing the Claude command bypasses generation, so its text and the Codex source can drift; the body test asserts both.
- Self-protected paths (`scripts/`, `harness/`, `.rad/`, `.claude/`, `.agents/skills/`) mean this plan is flagged for architect review.
- Wave 3 runs `verify-all.sh` (about 8 minutes) and needs the extended wave timeout.
