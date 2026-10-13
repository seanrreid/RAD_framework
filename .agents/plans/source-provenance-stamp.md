# Plan: Stamp Source Provenance at Plan-Open and Show It at Approval (#243)
Created: 2026-10-13
Author: architect
Status: complete
Completed-At: 2026-10-13T13:43:15.151Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-13T13:27:00.211Z
Recorded-By: sean@torchcodelab.com
Branch: rad/source-provenance-stamp
Issue: 243
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/243
Issue-Title: Show source-issue provenance (author_association) at /rad-approve

## Context
`/rad-adopt` pulls an issue's body **and comments** into a plan. Plan Task text goes verbatim into the wave prompt and `Verify:` runs as arbitrary shell. The architect approving the plan sees no sign of who wrote the source text, or whether they were a collaborator (factory-checks E8/E11). The approval gate is the control, but it is only informed if provenance is visible. This reopens only the legibility half of #111 (closed with the Green Lane removal, for auto-approval reasons). Nothing here approves, blocks or changes any gate.

**Verified while planning.** `gh issue view` has no issue-level `authorAssociation` field; the REST API does (`gh api repos/{repo}/issues/{n}` returns `author_association` and `user.type`), and issue comments carry `author_association` too. A third-party comment can steer a plan as much as the issue body can.

**Design (defaults chosen by the planner, all open to veto at approval):**
1. **A harness-written stamp, not a model-written header.** The adopt skill's header lines are written by the model, which a poisoned issue could steer. `rad plan-open` (deterministic harness code that already calls the host CLI to label the issue) fetches the facts and writes the header lines itself, overwriting anything the model wrote.
2. **Stamp at plan-open**, so the record is made once at plan time and works offline later.
3. **Include comment authors**, as a count of comments from non-collaborators.
4. **Display only, not frozen.** The stamp is not folded into the plan fingerprint and is not written into the `approved` event. A header edited after approval changes only what a later reader sees, not what was approved.
5. **Shown through a read-only command**, `rad provenance <feature>`, which the `/rad-approve` skill runs and renders, following the existing `rad capabilities` pattern.

Header lines written (below `Issue-Title:`, above the first `## ` heading):

```
Source-Author: seanrreid (OWNER)
Source-Comments: 3 total, 1 from non-collaborators
```

or `Source-Author: none (no source issue)`, `Source-Author: unknown (<reason>)`, and for a bot author `Source-Author: dependabot[bot] (NONE, bot)`.

## Scope
| In scope | Out of scope |
|---|---|
| `scripts/fetch-provenance.sh`: GitHub fetch of issue and comment authorship, with its test | GitLab, Bitbucket and Forgejo (stamped `unknown (platform ... unsupported)`) |
| `harness/provenance.js`: classify, format, stamp, read, and the `rad provenance` command | Plans written from a research artifact rather than an issue (`/rad-research` path) |
| `plan-open` stamps the plan before committing it | Folding provenance into the fingerprint or the `approved` event |
| The `rad-approve` skill shows provenance; the `rad-adopt` skill says not to hand-write it | Any blocking, gating or auto-approval based on provenance |
| Docs and tests | Pull-request sources and cross-repository issue URLs |

## Acceptance Criteria
1. **Fetch script.** `scripts/fetch-provenance.sh <issue-number>` prints one TSV line `issue<TAB><login><TAB><type><TAB><association>` and one `comment<TAB><login><TAB><type><TAB><association>` line per issue comment (all pages), exits 0 on success, 1 with a reason on stderr when the fetch fails, and 3 with `unsupported<TAB><platform>` when the configured platform is not GitHub. It is committed mode 100755.
2. **Classification.** `OWNER`, `MEMBER` and `COLLABORATOR` are trusted; every other value (`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `NONE`, `MANNEQUIN`, an unknown string, or a missing value) is untrusted; `user.type === 'Bot'` is untrusted and labelled `bot`.
3. **Stamp at plan-open.** For a plan with a source issue (`Issue:` or an `Adopted-From:` issue URL), a fresh `plan-open` writes the two header lines before committing the plan, replacing any `Source-Author:` or `Source-Comments:` line already present. The commit message, the `ok` line, the label step and the exit code are unchanged. A rerun that resumes at the push step does not re-stamp.
4. **Never blocks.** If the fetch fails, the platform is unsupported, or the output cannot be parsed, `plan-open` still succeeds and stamps `Source-Author: unknown (<reason>)`. With no source issue it stamps `none (no source issue)`.
5. **`rad provenance <feature>`.** It reads the plan header and prints one `provenance:` line saying trusted, UNTRUSTED (with the association and, for a bot, `bot`), unknown, none, or not recorded (a plan with no stamp), plus a second line when the comment count shows non-collaborator comments. It always exits 0 for an advisory outcome, 2 for a bad feature name or a missing plan, and it writes nothing.
6. **Fingerprint unchanged.** Stamping a plan does not change `planFingerprint`; a test asserts the hash is identical before and after.
7. **Approval shows it.** The `rad-approve` skill runs `rad provenance` in Step 2, renders a "Provenance" block in the Step 3 summary, and tells the architect that approving accepts text from an untrusted source and to review Task text and `Verify:` lines; the block is advisory and never refuses approval.
8. **Adopt skill.** The `rad-adopt` skill says the harness stamps `Source-Author` and `Source-Comments` at `plan-open` and the planner must not write them.
9. **Generated outputs in step.** The four generated skill copies match their sources: `node harness/cli.js generate --check` exits 0.
10. **Docs.** `docs/rad-cli.md` documents the stamp and `rad provenance`; `docs/rad-decisions.md` has one bullet.
11. **Full suite passes.** `scripts/verify-all.sh` passes on the delivered branch.

## Agent Scope
No sub-agents were called. Research was inline (14 tool calls, over the usual cap because the plan has to name every file and test it touches): the issue, the REST and CLI provenance fields (checked live), `plan-open.js` and `plan-commit.js`, the subcommand registration, how the plan-open and approve tests stub the shell, the install manifest, the approve and adopt skill structure.

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| scripts/fetch-provenance.sh | 1-90 | New (mode 100755). GitHub fetch via `gh repo view` and `gh api`; TSV output; exit codes per AC#1 |
| scripts/test-fetch-provenance.sh | 1-140 | New (mode 100755). Runs the script with a fake `gh` on `PATH` |
| harness/provenance.js | 1-170 | New. `classifyAssociation`, `parseProvenanceTsv`, `provenanceHeaderLines`, `stampProvenance`, `readProvenance`, `provenanceCommand`, `PROVENANCE_USAGE` |
| harness/test/provenance.test.js | 1-220 | New. Unit tests for the module and the command |
| harness/plan-open.js | 15-30 | Import the stamp helpers; add the script name constant |
| harness/plan-open.js | 205-250 | A `stampPlan` step before `commitPlan` for the fresh and commit steps |
| harness/test/cli-plan-open.test.js | 74-104 | Stub the new script in `makeSh` |
| harness/test/cli-plan-open.test.js | 240-269 | New stamping cases |
| harness/cli.js | 8-30 | Command list in the header comment |
| harness/cli.js | 68-74 | Import `provenanceCommand` and `PROVENANCE_USAGE` |
| harness/cli.js | 170-182 | Register the `provenance` subcommand |
| .rad/skills/rad-approve/SKILL.md | 150-172 | Step 2: run `rad provenance` |
| .rad/skills/rad-approve/SKILL.md | 198-262 | Step 3: summary block and rendering rules |
| .rad/skills/rad-adopt/SKILL.md | 64-82 | Step 2: do not hand-write the provenance headers |
| .rad/skills/rad-adopt/SKILL.md | 160-170 | Header template note |
| .agents/skills/rad-approve/SKILL.md | 150-262 | Regenerated (do not hand-edit) |
| .claude/commands/architect/rad-approve.md | 150-262 | Regenerated (do not hand-edit) |
| .agents/skills/rad-adopt/SKILL.md | 64-170 | Regenerated (do not hand-edit) |
| .claude/commands/team/rad-adopt.md | 64-170 | Regenerated (do not hand-edit) |
| docs/rad-cli.md | 110-175 | The stamp under `rad plan-open`; a new `rad provenance` section before `rad plan-status` |
| docs/rad-decisions.md | 15-35 | One bullet |

## Execution Notes

### Do Not Touch
- harness/plan-fingerprint.js, harness/gates.js, harness/gates.yaml, harness/events.js (provenance is display-only and never reaches the gate or the event log)
- harness/spine.js and everything under harness/adapters/
- scripts/rad-label.sh and scripts/fetch-epic.sh (patterns to follow, not to change)

### Key Files
- harness/plan-open.js — `openPlan` (~233), `labelIssue` (~215), `makeSh`-style `sh` port use; `planIssueNumber` in `harness/plan-commit.js` (~63) derives the issue number
- scripts/fetch-epic.sh — `gh repo view --json nameWithOwner` and `gh api` usage to mirror
- scripts/detect-platform.sh — platform detection to reuse for the unsupported-platform exit
- harness/cli.js — the `capabilities` registration (~173) and `capabilitiesCommand` (~4082) are the read-only-advisory pattern
- harness/test/cli-plan-open.test.js — `makeSh` stubs the three scripts and lets everything else run for real

### Reminders
- harness/, scripts/ and .rad/ are self-protected: architect approval and the last-wave full-suite Verify. Deliver with `RAD_WAVE_TIMEOUT_SECONDS=1800` AND `RAD_VERIFY_TIMEOUT_SECONDS=1800`.
- `makeSh` in `cli-plan-open.test.js` passes unknown files to the real runner; without a stub for `fetch-provenance.sh`, the existing plan-open tests would call the real script (and fail to fetch), stamping `unknown` into their plans. Update `makeSh` first, then run the file.
- New `.sh` files under `scripts/` must be 100755 and parse under bash 3.2 (no associative arrays, no `mapfile`).
- Generated files come from `node harness/cli.js generate`; never edit them by hand; finish with `generate --check`.
- `cli.js` is on the function-length baseline: add only the import, the usage constant and the registration entry there; all logic lives in `provenance.js`. Keep every new function at 40 lines or fewer, and run `node scripts/lint-function-length.mjs` before finishing.
- The `plan-open` stdout is parsed by skills and asserted by tests: do not change the existing `ok` line; any new status line goes before it, as `label skipped: no issue` does.
- Stamp only the header block (lines before the first `## ` heading), exactly as `plan-fingerprint.js` defines it.

## Program Design

Signatures:

```js
// harness/provenance.js
export const TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
export function classifyAssociation(association, userType)   // -> { trusted: boolean, bot: boolean, label: string }
export function parseProvenanceTsv(stdout)                    // -> { issue: {login,type,association}|null, comments: [...] } (throws on malformed)
export function provenanceHeaderLines(parsed)                 // -> ['Source-Author: ...', 'Source-Comments: ...']
export function stampProvenance(planText, headerLines)        // -> planText with the two header lines set/replaced in the header block
export function readProvenance(planText)                      // -> { author: string|null, comments: string|null }
export function provenanceCommand(argv, ctx)                  // -> Promise<number> exit code
export const PROVENANCE_USAGE = 'rad provenance <feature>';

// harness/plan-open.js
function stampPlan(sh, root, req)  // fetches via scripts/fetch-provenance.sh, rewrites req.planRel on disk; never throws for a fetch problem
```

Call stack:

```
rad plan-open -> openPlan -> (fresh|commit) stampPlan -> sh(scripts/fetch-provenance.sh <issue>)
                                                       -> parseProvenanceTsv -> provenanceHeaderLines -> stampProvenance -> write plan
              -> commitPlan -> pushBranch -> labelIssue
/rad-approve Step 2 -> rad provenance <feature> -> readProvenance -> classifyAssociation -> "provenance:" lines
/rad-approve Step 3 -> renders the Provenance block (advisory)
```

File tree diff:

```
scripts/fetch-provenance.sh, scripts/test-fetch-provenance.sh   NEW
harness/provenance.js, harness/test/provenance.test.js          NEW
harness/plan-open.js, harness/test/cli-plan-open.test.js        stamp step; stub + cases
harness/cli.js                                                  import + registration only
.rad/skills/{rad-approve,rad-adopt}/SKILL.md + 4 generated      provenance in summary; do-not-hand-write
docs/rad-cli.md, docs/rad-decisions.md                          docs
```

## Wave Plan

### Wave 1 — sequential
Tasks in this wave must run in sequence (1.2 tests the module written in 1.1).
Verify: node --test harness/test/provenance.test.js

#### Task 1.1: The provenance module
File: harness/provenance.js:1-170
What: Implement the exports in Program Design: classification per AC#2 (a bot is untrusted regardless of association), strict TSV parsing (a malformed line throws, so the caller can stamp `unknown`), header-line formatting, header-block stamping that replaces existing `Source-Author:` / `Source-Comments:` lines and otherwise inserts them after `Issue-Title:` (or after the last of `Adopted-From:` / `Issue:` when there is no title) and before the first `## ` heading, a header reader, and the `rad provenance` command with the output lines of AC#5. Named constants for header names and association sets. `rad provenance` writes nothing.
Validate: AC#2, AC#5, AC#6 — covered by the cases in Task 1.2.

#### Task 1.2: Module tests
File: harness/test/provenance.test.js:1-220
What: Cases: every association value and the missing value; a bot; unknown strings; TSV with zero, one and many comments; a malformed TSV line; a stamp into a plan with no existing stamp, with a stale stamp, with only one of the two lines, with no `Issue-Title:`, and into a header with no blank line before `## `; the stamped text leaves every body line untouched; `planFingerprint` is identical before and after stamping (AC#6); `rad provenance` for trusted, untrusted, bot, unknown, none, not recorded, with and without non-collaborator comments, a bad feature name (exit 2), a missing plan (exit 2), and a check that it writes no file.
Validate: AC#2, AC#5, AC#6 — each case is a named assertion.

### Wave 2 — sequential
Tasks in this wave must run in sequence (2.2 needs the script from 2.1; 2.3 needs the stamp step).
Verify: bash scripts/test-fetch-provenance.sh && node --test harness/test/cli-plan-open.test.js harness/test/provenance.test.js harness/test/cli.test.js && bash scripts/lint-shell-safety.sh && bash scripts/test-bash32-parse.sh

#### Task 2.1: The fetch script and its test
File: scripts/fetch-provenance.sh:1-90, scripts/test-fetch-provenance.sh:1-140
What: Write the script per AC#1: resolve the platform with `scripts/detect-platform.sh` (non-GitHub → exit 3), then `gh repo view --json nameWithOwner`, `gh api repos/<repo>/issues/<n>` for the issue and `gh api --paginate repos/<repo>/issues/<n>/comments` for the comments, normalizing to TSV. Validate the argument is a positive integer before using it in any command. The test puts a fake `gh` first on `PATH` and covers: success with zero, one and many comments, multiple pages, a bot author, a missing `author_association`, `gh` failing at each of the three calls (exit 1 with a reason), a non-GitHub platform (exit 3), and a non-numeric, empty and zero issue argument.
Validate: AC#1, AC#4 — each case asserts exit code and exact output.

#### Task 2.2: Stamp at plan-open
File: harness/plan-open.js:15-30, harness/plan-open.js:205-250, harness/test/cli-plan-open.test.js:74-104, harness/test/cli-plan-open.test.js:240-269
What: First extend `makeSh` to stub `scripts/fetch-provenance.sh` with a configurable response. Then add `stampPlan` and call it in `openPlan` before `commitPlan` for the `fresh` and `commit` steps only. It calls the script through the `sh` port, stamps the lines, and writes the plan file; any failure (non-zero exit, parse error, unsupported platform) stamps `unknown (<reason>)`; no source issue stamps `none (no source issue)`. A one-line `provenance: <summary>` goes to stdout before the `ok` line. New tests: stamped header appears in the committed plan; a model-written `Source-Author:` is overwritten; fetch failure and unsupported platform still exit 0 with an `unknown` stamp; no issue; a resumed push step does not stamp; the commit message and `ok` line are unchanged; the stamp does not alter the plan fingerprint.
Validate: AC#3, AC#4, AC#6 — the new tests plus the whole existing plan-open file pass.

#### Task 2.3: Register the command
File: harness/cli.js:8-30, harness/cli.js:68-74, harness/cli.js:170-182
What: Import `provenanceCommand` and `PROVENANCE_USAGE`, add the header-comment line, and register the `provenance` subcommand next to `capabilities` with a one-line summary. No logic in `cli.js`.
Validate: AC#5 — `node harness/cli.js provenance` with no argument prints the usage and exits 2; `node harness/cli.js --help` lists the command; the function-length lint still exits 0.

### Wave 3 — sequential
Tasks in this wave must run in sequence (3.2 regenerates from 3.1).
Verify: exec bash scripts/verify-all.sh

#### Task 3.1: Skills and docs
File: .rad/skills/rad-approve/SKILL.md:150-172, .rad/skills/rad-approve/SKILL.md:198-262, .rad/skills/rad-adopt/SKILL.md:64-82, .rad/skills/rad-adopt/SKILL.md:160-170, docs/rad-cli.md:110-175, docs/rad-decisions.md:15-35
What: In the approve skill's Step 2 add `node harness/cli.js provenance "$FEATURE"` (advisory: never stop on any outcome) and in Step 3 add a "Provenance" block to the summary template with rendering rules: trusted source collapses to one line; an untrusted source or non-collaborator comments are shown prominently with the instruction to review Task text and `Verify:` commands before approving; a missing stamp reads "not recorded". In the adopt skill say the harness stamps the two headers at `plan-open` and the planner must not write them. Document the stamp under `rad plan-open` and add a `rad provenance` section in `docs/rad-cli.md`; add one bullet to `docs/rad-decisions.md`.
Validate: AC#7, AC#8, AC#10 — the wording is present; `harness/test/skill-bodies.test.js` still passes.

#### Task 3.2: Regenerate
File: .agents/skills/rad-approve/SKILL.md:150-262, .claude/commands/architect/rad-approve.md:150-262, .agents/skills/rad-adopt/SKILL.md:64-170, .claude/commands/team/rad-adopt.md:64-170
What: Run `node harness/cli.js generate` and keep only these four regenerated outputs. Do not hand-edit them.
Validate: AC#9 — `node harness/cli.js generate --check` exits 0.

#### Task 3.3: Full-suite check
File: docs/rad-decisions.md:15-35
What: No further edit. The wave's Verify runs the full suite, which includes the function-length lint.
Validate: AC#11 — `scripts/verify-all.sh` passes.

## Tests to Write
- [ ] Fetch script cases with a fake `gh` — scripts/test-fetch-provenance.sh
- [ ] Classification, TSV parsing, stamping, reading, fingerprint equality and the `rad provenance` command — harness/test/provenance.test.js
- [ ] Stamping inside plan-open, including failure, overwrite and resume — harness/test/cli-plan-open.test.js

## Non-Goals
- Blocking, warning-as-error, or auto-approving anything based on provenance
- Freezing provenance into the fingerprint or the `approved` event
- Non-GitHub hosts, pull-request sources and cross-repository issue URLs
- Covering plans written from a research artifact

## Out-of-Scope Dependencies
None.

## Risks
- A header can be edited after approval, so the stamp is a display aid and not evidence. The plan says so in the docs.
- `plan-open` now makes network calls. A fetch failure never blocks it (AC#4), but it adds a failure path and a little latency to every adopted plan.
- Existing `plan-open` tests pass unknown files to the real runner; the `makeSh` update must land with the stamping step or they fail. The wave order and Reminders guard this.
- `gh api --paginate` on a very long comment thread makes several calls; the script has no cap and relies on the host's rate limits.
- An issue edited after plan-open, or comments added later, are not reflected; the stamp records the state at plan time.

## Issue Gaps
- ASSUMPTION: the three open design choices (stamp at `plan-open`, include comment authors, do not freeze into the event) use the planner's recommended defaults; the architect did not answer them explicitly before planning.
- ASSUMPTION: `CONTRIBUTOR` (an author with a previously merged PR) counts as untrusted: the test is "is a collaborator", not "has contributed before".
- ASSUMPTION: the fetch is a GitHub script following the existing host-CLI-in-scripts convention, not `gh` calls from JavaScript; other platforms stamp `unknown`.
- ASSUMPTION: the issue is looked up in the current repository by number (as `labelIssue` does); an `Adopted-From` URL naming another repository is stamped by number against this one, which may be wrong. Treated as out of scope.
- ASSUMPTION: the stamp goes below `Issue-Title:` (or the last of `Adopted-From:` / `Issue:`), and any header placement before the first `## ` heading is acceptable to `lint-plan.sh`. The executor should confirm lint stays clean.
- ASSUMPTION: line ranges for the skill sources, docs and `cli.js` registration are estimates from grep results; the executor should stay within the declared files and confirm exact lines.
