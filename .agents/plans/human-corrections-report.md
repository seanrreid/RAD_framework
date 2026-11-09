# Plan: Human Corrections Report
Created: 2026-11-09
Author: developer
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-09T16:14:01.680Z
Recorded-By: sean@torchcodelab.com
Branch: rad/human-corrections-report
Source-Author: none (no source issue)
Source-Comments: none

## Context
`/rad-insights` already reports harness behavior and, in Step 4h, per-feature counts of re-approvals and resumes, but nothing says where a human actually corrected a delivery: no dates, no evidence, no fix commits made after the deliver PR opened, no confirmed review findings. Add a read-only Step 4j that folds those signals into dated correction rows with four fixed categories, so recurring planning and review gaps become visible to the insights loop.

## Scope
| In scope | Out of scope |
|---|---|
| New pure fold module `harness/human-corrections.js` and git reader `harness/branch-commits.js` with node tests | Any change to `harness/cycle-metrics.js` (Step 4h numbers stay as they are) or `harness/delivery-history.js` |
| Four categories: `reapproval`, `resume-answer`, `post-deliver-fix`, `review-fix` | Writing to `findings.jsonl`, `events.jsonl` or any file; a new gate or CI status; changes to `draft-insights-plan.sh` |
| `--since` filtering, per-category counts, top features, capped per-feature list | Free-text clustering or any model call |
| rad-insights skill source Step 4j and report section, regenerated copies, `docs/daily-workflow.md` | New env vars (only named constants in the module), `docs/configuration.md` |

## Acceptance Criteria
1. Each second or later `approved` event of a feature yields one `reapproval` row (a feature with one approved event yields none; three yield two), carrying the event date and the evidence `approved event #N`.
2. Each `run-resumed` event whose `data.context` is non-empty after trimming yields one `resume-answer` row with the stop class as evidence; a resume without a context answer yields none.
3. A `review-fix` row is produced only for a `finding` record whose `findingVerdict` (from `harness/findings.js`, never reimplemented) is `confirmed`; unlabeled and false-alarm findings, and `cycle` records, are not counted; the evidence is the finding category and the date is the finding date.
4. A `post-deliver-fix` row is produced for each commit on the feature's `rad/<feature>` branch (local ref, else `origin` ref) strictly later than the `pr-opened` event, compared at second precision, excluding commits whose subject starts with `deliver(`, `approve:` or `review:`; a missing branch ref or a missing `pr-opened` event reports the feature as `unavailable` with a reason and is never an error.
5. A malformed line in an events log makes the fold throw an error naming the log and 1-based line number; the skill block exits non-zero, reports that stderr, and omits the section without stopping the rest of the report.
6. The report output is deterministic: rows sort by date, then feature, category, evidence; it shows per-category counts, the top features by correction count (ties by name, at most `TOP_FEATURES`), and at most `MAX_ROWS_PER_FEATURE` rows per feature; `--since YYYY-MM-DD` keeps rows dated on or after that day (a row exactly on the boundary is kept); no corrections prints a single empty-state line.
7. The modules are read-only: they write no file, and `harness/cycle-metrics.js`, `harness/events.js`, `harness/gates.js` and `scripts/draft-insights-plan.sh` are unchanged.
8. `.rad/skills/rad-insights/SKILL.md` gains Step 4j after Step 4i (no existing step renumbered), a `### Human Corrections` report section before Recommended Focus Areas, and a Rules bullet saying the section is information only; generated copies show no drift; `docs/daily-workflow.md` describes it.

## Agent Scope
Research used a read-only Explore sub-agent over `harness/`, `.rad/skills/rad-insights/`, `docs/` and the event schema. No out-of-scope agent dependency; the feature touches self-protected paths (`harness/`, `.rad/`), so it needs architect review.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| harness/human-corrections.js | 1-180 | New pure ESM fold: event-log parser with file:line errors, four row builders, report builder |
| harness/branch-commits.js | 1-90 | New git reader: resolve the branch ref, list commits after a timestamp, excluding harness subjects |
| harness/test/human-corrections.test.js | 1-220 | New node test for the folds and report builder |
| harness/test/branch-commits.test.js | 1-130 | New node test using a temporary git repository |
| .rad/skills/rad-insights/SKILL.md | 1060-1065 | Source: new Step 4j after Step 4i |
| .rad/skills/rad-insights/SKILL.md | 1366-1385 | Source: `### Human Corrections` report section |
| .rad/skills/rad-insights/SKILL.md | 1423-1426 | Source: Rules bullet |
| .agents/skills/rad-insights/SKILL.md | 1060-1065 | Regenerated copy of Step 4j |
| .agents/skills/rad-insights/SKILL.md | 1366-1385 | Regenerated copy of the report section |
| .agents/skills/rad-insights/SKILL.md | 1423-1426 | Regenerated copy of the Rules bullet |
| .claude/commands/shared/rad-insights.md | 1060-1065 | Regenerated copy of Step 4j |
| .claude/commands/shared/rad-insights.md | 1366-1385 | Regenerated copy of the report section |
| .claude/commands/shared/rad-insights.md | 1423-1426 | Regenerated copy of the Rules bullet |
| .agents/skills/rad-insights/agents/openai.yaml | 1-30 | Regenerated; changes only if the frontmatter description changes |
| docs/daily-workflow.md | 405-420 | Add the Human Corrections bullet to the rad-insights list |

## Program Design
1. Signatures (pure ESM, no I/O except in `branch-commits.js`):
   - `parseEventLog(text, label)` returns parsed events; throws `Error("<label>:<line>: ...")` on a malformed line.
   - `reapprovalRows(feature, events)`, `resumeAnswerRows(feature, events)`, `reviewFixRows(feature, findings)`, `postDeliverFixRows(feature, prOpenedTs, commits)` each return rows `{feature, category, date, evidence}`.
   - `buildCorrections({ rows, unavailable, since })` returns `{ counts, topFeatures, byFeature, unavailable, total }` with the caps `TOP_FEATURES` and `MAX_ROWS_PER_FEATURE`.
   - `branch-commits.js`: `resolveBranchRef(feature, run)` returns the local or origin ref or null; `commitsAfter(feature, sinceSeconds, run)` returns `{sha, subject, ts}` records excluding harness subjects; `run` is an injectable git runner (argument arrays, no shell).
2. Control flow: the Step 4j block lists features from `RAD_STATE_DIR`, parses each events log, reads `findings.jsonl`, asks `branch-commits.js` for fix commits when a `pr-opened` event exists, then calls `buildCorrections` and prints the section.
3. File tree: `+ harness/human-corrections.js`, `+ harness/branch-commits.js`, `+ harness/test/human-corrections.test.js`, `+ harness/test/branch-commits.test.js`; edits to the skill source, its copies and one doc.

## Execution Notes

### Do Not Touch
- `harness/cycle-metrics.js`, `harness/delivery-history.js`, `harness/delivery-metrics.js` — shipped folds for Steps 4h and 4i; reuse by import only if needed.
- `harness/events.js`, `harness/spine.js`, `harness/adapters/git-state-store.js`, `harness/gates.js`, `harness/gates.yaml` — event writers and gate fold; the schema is read-only here.
- `scripts/draft-insights-plan.sh`, `scripts/check-*.sh` — no behavior change, no gate.
- `.agents/skills/` and `.claude/commands/` copies — produced by `node harness/cli.js generate`; never hand-edit.

### Key Files
- harness/cycle-metrics.js — style and `humanTouches` event types to mirror (header, pure helpers).
- harness/findings.js — `findingVerdict` and `VERDICTS`.
- harness/delivery-history.js and harness/test/delivery-history.test.js — precedent for a git-reading helper and a temporary-repository test.

### Reminders
- Event shapes: `approved` and `run-resumed` carry `ts` (ISO) and `data`; the resume text is `data.context`; the `pr-opened` timestamp is the event `ts`. Verify the `pr-opened` shape by reading a real events log before coding.
- Validate the feature name against a safe pattern before it reaches any git argument; pass arguments as an array, never through a shell.
- Steps 4c to 4i do not apply `--since`; this fold must, at the skill block, on row dates.
- Keep functions under 40 lines. This plan's own text avoids shapes the sensitive-content scan flags.
- Wave 3 runs `scripts/verify-all.sh` (about 8 minutes): deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800 RAD_VERIFY_TIMEOUT_SECONDS=1800`.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: Correction folds
File: harness/human-corrections.js:1-180
What: Create the pure module per Program Design: `parseEventLog`, the three event and finding row builders, `postDeliverFixRows`, and `buildCorrections` with the named constants `TOP_FEATURES` and `MAX_ROWS_PER_FEATURE`. Reuse `findingVerdict`; no file writes.
Validate: AC#1, AC#2, AC#3, AC#5, AC#6, AC#7 — exercised by Task 1.2.

#### Task 1.2: Fold tests
File: harness/test/human-corrections.test.js:1-220
What: Create node tests, one labelled case each: no events at all; one, two and three approved events; resume with and without a context answer (blank and whitespace-only); malformed event line names the log and line; finding with no verdict, false-alarm, confirmed, and a cycle record; deterministic ordering; ties in top features; per-feature cap; `--since` on the boundary day, the day before and the day after; empty findings; empty state output; and the module performs no writes (frozen inputs are not mutated).
Validate: AC#1, AC#2, AC#3, AC#5, AC#6, AC#7 — `node --test harness/test/human-corrections.test.js` passes.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Branch commit reader
File: harness/branch-commits.js:1-90
What: Create the reader: validate the feature name, resolve the local ref then the origin ref, list commits strictly later than a second-precision timestamp, drop commits whose subject starts with `deliver(`, `approve:` or `review:`, and return `unavailable` with a reason for a missing ref. Git is called through an injectable runner with argument arrays.
Validate: AC#4, AC#7 — exercised by Task 2.2.

#### Task 2.2: Reader tests
File: harness/test/branch-commits.test.js:1-130
What: Create node tests on a temporary git repository: commit exactly at the pr-opened second (excluded) and one second later (included); harness-subject commits excluded; local ref preferred, origin-only ref used, neither ref gives unavailable; missing pr-opened gives unavailable with its reason; hostile feature names rejected; no files written outside the temp directory.
Validate: AC#4, AC#7 — `node --test harness/test/branch-commits.test.js` passes.

### Wave 3 — sequential
Depends on: Wave 2 complete

#### Task 3.1: Skill source step and report section
File: .rad/skills/rad-insights/SKILL.md:1060-1065, 1366-1385, 1423-1426
What: Add Step 4j after Step 4i as an inline node block that imports the two modules, reads `RAD_STATE_DIR` and the findings file, applies `--since`, and prints the section; a non-zero exit is reported with its stderr and the section omitted. Add the `### Human Corrections` template section before Recommended Focus Areas (omit when nothing to report) and a Rules bullet marking it information only. Do not renumber steps. Run `node harness/cli.js generate` to refresh the copies.
Validate: AC#8 — `node harness/cli.js generate --check` shows no drift and the new step and section are present once each.

#### Task 3.2: Workflow doc
File: docs/daily-workflow.md:405-420
What: Add a bullet describing the Human Corrections section: the four categories, `--since`, the unavailable case and that it never writes or gates.
Validate: AC#8 — the doc contains the new bullet.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] Fold and report-builder cases listed in Task 1.2 — harness/test/human-corrections.test.js
- [ ] Branch reader cases listed in Task 2.2 — harness/test/branch-commits.test.js

## Non-Goals
- Changing Step 4h or Step 4i output, or counting commits made on the default branch after merge (Step 4i already covers rework).
- Persisting corrections as findings so the recurrence drafter can act on them; that would be a separate, recorded step.
- Any model-based clustering of commit messages or context answers.

## Out-of-Scope Dependencies
None

## Risks
- Post-deliver fix detection needs the branch ref; after a branch is deleted the feature is reported unavailable, so counts understate corrections for old features. This is stated in the report, not hidden.
- Second-precision comparison can drop a commit made in the same second as `pr-opened`; accepted and documented in the tests.
- Self-protected paths (`harness/`, `.rad/`) mean this plan is flagged for architect review.
- Wave 3 runs `verify-all.sh` (about 8 minutes) and needs the extended wave timeout.
