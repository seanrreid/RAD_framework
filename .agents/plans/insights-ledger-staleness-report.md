# Plan: Insights Ledger Staleness Report
Created: 2026-11-09
Author: developer
Status: in-progress
Approved-By: sean@torchcodelab.com
Approved-At: 2026-11-09T13:26:39.455Z
Recorded-By: sean@torchcodelab.com
Branch: rad/insights-ledger-staleness-report
Source-Author: none (no source issue)
Source-Comments: none

## Context
`.agents/insights-ledger.jsonl` (PR #307) records each category's disposition
(adopted, declined, deferred), but nothing surfaces rows that have gone stale: an
adopted convention whose category keeps recurring, or a declined/deferred row that
has expired or aged out. Add a read-only staleness section to the `/rad-insights`
report, produced by a new script that reuses `scripts/lib/insights-ledger.sh`.

## Scope
| In scope | Out of scope |
|---|---|
| New `scripts/report-ledger-staleness.sh` and its test | Any behavior change to `scripts/draft-insights-plan.sh` |
| `RAD_STALE_DAYS` (default 90) and a fixed expiry-warning window | Writing to the ledger or `findings.jsonl` |
| `/rad-insights` skill source section plus regenerated copies | A new gate, CI check or `verify-all.sh` wiring (globs already pick up the test) |
| `docs/configuration.md` and `docs/daily-workflow.md` updates | Changes to `scripts/lib/insights-ledger.sh` |

## Acceptance Criteria
1. With a missing or empty `.agents/insights-ledger.jsonl`, `scripts/report-ledger-staleness.sh` prints an empty-section message and exits 0; a malformed ledger row exits 2 and names `file:line`; neither case writes any file.
2. Only each category's LATEST ledger row is evaluated: a newer row supersedes an older stale row, and a category in the ledger with no findings is evaluated on age and expiry only.
3. An `adopted` row is flagged `recurred` when findings of its category dated strictly after the row's date number at least `RAD_FINDINGS_THRESHOLD` (count == threshold flags; a finding dated exactly on the adoption date does not count), and flagged `aged` when the row is more than `RAD_STALE_DAYS` days old (age exactly `RAD_STALE_DAYS` is not flagged).
4. A `declined` or `deferred` row is flagged `expired` when `expires` is today or earlier (expiry exactly today is expired), `expiring` when `expires` is within the 14-day warning window, and `aged` when it has no `expires` and is more than `RAD_STALE_DAYS` days old.
5. `RAD_STALE_DAYS` defaults to 90; a value that is not a positive integer (zero, negative, non-numeric, empty-after-set) exits 2 with no output on stdout; the `--today YYYY-MM-DD` test flag and `RAD_FINDINGS_FILE` are validated before use.
6. The script is read-only: it never modifies the ledger, the findings file or any other file, and `scripts/draft-insights-plan.sh` is unchanged.
7. `.rad/skills/rad-insights/SKILL.md` runs the script as a read-only step and renders a `### Ledger Staleness` report section; `rad generate --check` shows no drift.
8. `docs/configuration.md` documents `RAD_STALE_DAYS` and `docs/daily-workflow.md` describes the staleness section.

## Agent Scope
Research used `findings-surface-mapper`-style read-only exploration over `scripts/`, `.rad/skills/rad-insights/` and `docs/`. No out-of-scope agent dependency.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/report-ledger-staleness.sh | 1-170 | New read-only report script (mode 100755) |
| scripts/test-report-ledger-staleness.sh | 1-260 | New hermetic fixture test (mode 100755) |
| .rad/skills/rad-insights/SKILL.md | 135-175 | New Step 3d: ledger staleness (read-only) after Step 3b |
| .rad/skills/rad-insights/SKILL.md | 1060-1080 | New `### Ledger Staleness` section in the report template |
| .agents/skills/rad-insights/SKILL.md | 135-175 | Regenerated copy of the Step 3d change |
| .agents/skills/rad-insights/SKILL.md | 1060-1080 | Regenerated copy of the report template change |
| .claude/commands/shared/rad-insights.md | 135-175 | Regenerated copy of the Step 3d change |
| .claude/commands/shared/rad-insights.md | 1060-1080 | Regenerated copy of the report template change |
| .agents/skills/rad-insights/agents/openai.yaml | 1-30 | Regenerated; changes only if the frontmatter description changes |
| docs/configuration.md | 692-705 | Add `RAD_STALE_DAYS` row to the env var table |
| docs/daily-workflow.md | 490-500 | Describe the staleness section next to the ledger paragraph |

## Program Design
1. Signatures (all local to the new script; `scripts/lib/insights-ledger.sh` is only sourced):
   - `parse_stale_days` → echoes a positive integer or `die 2`.
   - `parse_threshold` → copied pattern from the drafter (falls back to 5).
   - `latest_rows <ledger>` → one JSON row per category, last row wins.
   - `days_between <from> <to>` → whole days via jq `strptime|mktime`, no GNU/BSD `date` flags.
   - `recurrence_count <findings> <category> <after-date>` → count with strict `>`.
   - `classify_row <row>` → prints zero or more flags: `recurred`, `aged`, `expired`, `expiring`.
   - `main` → validate inputs, `ledger_validate`, loop latest rows, print the section.
2. Control flow: `main` → `parse_*` → `ledger_validate` (exit 2 on malformed) → `latest_rows` → per row `classify_row` → print `category | disposition | date | flags | detail`; no rows or no flagged rows prints a one-line "nothing stale" message.
3. File tree: `+ scripts/report-ledger-staleness.sh`, `+ scripts/test-report-ledger-staleness.sh`; edits to the skill source, its generated copies and two docs.

## Execution Notes

### Do Not Touch
- `scripts/draft-insights-plan.sh`, `scripts/record-insights-disposition.sh`, `scripts/check-ledger-append-only.sh`, `scripts/lib/insights-ledger.sh` — no behavior change; copy patterns, do not edit.
- `.agents/insights-ledger.jsonl`, `.agents/findings.jsonl` — data files; tests use mktemp fixtures only.
- `scripts/lint-shell-safety-baseline.txt`, `scripts/lint-function-length-baseline.txt` — do not add baseline entries; keep functions short and guarded.
- `harness/` — generated copies are produced by `node harness/cli.js generate`; do not edit harness code.

### Key Files
- scripts/lib/insights-ledger.sh — `ledger_validate`, `LEDGER_BAD_ROW_EXIT`, date strings compare lexically.
- scripts/draft-insights-plan.sh — reference for `parse_threshold`, findings-file guard and malformed-ledger exit 2.
- scripts/test-draft-insights-plan.sh — fixture and `expect` conventions to follow.

### Reminders
- New scripts must be mode 100755 (shell-safety-lint). bash 3.2 safe: no associative arrays, no `mapfile`, use `${arr[@]+"${arr[@]}"}`.
- Guard `RAD_STALE_DAYS`, `RAD_FINDINGS_THRESHOLD`, `RAD_FINDINGS_FILE` and `--today` with `[[ =~ ]]` or `case` before any use in jq/git/node.
- Expiry warning window is a named constant `EXPIRY_WARN_DAYS=14` at the top of the script, documented in the skill and docs.
- A missing findings file means zero recurrence (the report is read-only and must not fail on it); a findings file that exists with a malformed line follows the drafter's behavior.
- Run `node harness/cli.js generate` after the skill source edit, then `generate --check`.
- Wave 2 runs `scripts/verify-all.sh` (about 8 minutes); deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` and `RAD_VERIFY_TIMEOUT_SECONDS=1800`.

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence.

#### Task 1.1: Staleness report script
File: scripts/report-ledger-staleness.sh:1-170
What: Create the read-only script (mode 100755) per Program Design. Validate inputs, call `ledger_validate`, evaluate each category's latest row, and print the section. Flags and boundaries per AC1-AC6; `EXPIRY_WARN_DAYS=14`.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#6 — run against fixture ledgers; exit codes and output match the criteria.

#### Task 1.2: Fixture test for the script
File: scripts/test-report-ledger-staleness.sh:1-260
What: Create a hermetic test (mode 100755) using `--today` for determinism. Cases, each its own labelled `expect`: missing ledger; empty ledger; malformed row (exit 2, names `file:line`); category in ledger with no findings; finding dated exactly on the adoption date (not counted); finding one day after (counted); count == threshold flags and threshold - 1 does not; age exactly `RAD_STALE_DAYS` not flagged, +1 day flagged; expiry exactly today expired; expiry inside and just outside the 14-day window; declined and deferred with no expiry aged; a newer row supersedes an older stale row; `RAD_STALE_DAYS` zero, negative and non-numeric exit 2; a hostile `--today` and `RAD_FINDINGS_FILE` value rejected; ledger and findings files byte-identical after every run.
Validate: AC#1, AC#2, AC#3, AC#4, AC#5, AC#6 — `bash scripts/test-report-ledger-staleness.sh` exits 0 with ALL PASS.

### Wave 2 — sequential
Depends on: Wave 1 complete

#### Task 2.1: Skill source section
File: .rad/skills/rad-insights/SKILL.md:135-175, 1060-1080
What: Add Step 3d (run `scripts/report-ledger-staleness.sh` read-only, never with `--draft-plans`; report stdout verbatim on exit 0, stderr verbatim otherwise) after Step 3b, and a `### Ledger Staleness` section in the Step 5 report template. Run `node harness/cli.js generate` to refresh the generated copies.
Validate: AC#7 — `node harness/cli.js generate --check` reports no drift and the new step and section appear in the source.

#### Task 2.2: Docs
File: docs/configuration.md:692-705, docs/daily-workflow.md:490-500
What: Add the `RAD_STALE_DAYS` row (Variable | Default | Effect | Where read; "a value that is not a positive integer is an error") and a short paragraph describing the staleness section, its flags and the 14-day warning window.
Validate: AC#8 — both docs contain the new text; `RAD_STALE_DAYS` appears in the table with default 90.

Verify: exec bash scripts/verify-all.sh

## Tests to Write
- [ ] Staleness report fixture cases listed in Task 1.2 — scripts/test-report-ledger-staleness.sh

## Non-Goals
- Changing what `draft-insights-plan.sh` proposes or when; this is a report only.
- Auto-recording dispositions, auto-expiring rows or opening review plans for stale rows.
- A new CI gate or required status; staleness is advisory.

## Out-of-Scope Dependencies
None

## Risks
- Date arithmetic must stay portable across macOS bash 3.2 and Linux; doing it in jq avoids GNU/BSD `date` differences, and the tests pin `--today`.
- Wave 2 runs `verify-all.sh` (about 8 minutes) and needs the extended wave timeout noted above.
- Self-protected paths (`scripts/`, `.rad/`) mean this plan is flagged for architect review.
