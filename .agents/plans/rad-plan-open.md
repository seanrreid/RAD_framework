# Plan: `rad plan-open`: Deterministic Plan Branch, Commit and Push (#186 part 2a)
Created: 2026-10-07
Author: architect
Status: complete
Completed-At: 2026-10-07T14:34:13Z
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-07T14:21:43.944Z
Recorded-By: sean@torchcodelab.com
Branch: rad/rad-plan-open
Issue: 186
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/186
Issue-Title: Codex parity for RAD's state-changing workflow (plan, approve, deliver)

## Context

`/rad-plan` and `/rad-adopt` end by having the model run git by hand: fetch the default branch, cut `rad/<slug>`, stage the plan, write a commit message from a template, push, and label the issue "if there is one". Nothing handles errors, the commit fields are filled in by hand, and Codex can't run these steps at all under the rule recorded on #171: state-changing steps may only call `rad` commands.

Part 2 decisions (2026-10-07, recorded on #186):
1. **An optional `Issue: <N>` plan header.** If it's missing, the number is parsed from `Adopted-From:` (`/issues/N` or `/-/issues/N`). `Issue:` wins when both exist. With neither, labelling is skipped. A malformed `Issue:` is a lint error.
2. **A failed push fails closed and can be resumed.** Exit 0 = committed and pushed. Exit 1 = committed locally but the push failed, safe to rerun. A rerun only pushes. There is no rollback, and the label is applied only after a successful push.
3. **Commit messages are derived from the plan.** A repeatable `--trailer "Key: Value"` adds lines after the derived ones.
4. **The plan's `Branch:` header is authoritative.**
   - `plan-open` requires it to equal `conventionWorkBranch(<slug>)`.
   - The hard-coded `rad/${feature}` fallbacks in `rad approve` and `resolveWorkBranch` switch to the convention, which honors `RAD_BRANCH_PREFIX`.
5. **`rad plan-status`** (reject and needs-revision) is added in a later part.

**This is part 2a of #186 part 2.** The three commands didn't fit one plan's read budget:
- **2a (this plan):** shared helpers, the `Issue:` lint rule, the branch-prefix fix, `rad plan-open`, and switching `/rad-plan` and `/rad-adopt` to use it.
- **2b:** `rad approve --commit`, `rad plan-status`, and switching `/rad-approve` to use them.
- **2c:** migrate the three commands to `.rad/skills`.

## Scope

| In scope | Out of scope |
|---|---|
| `harness/plan-commit.js`: pure helpers (issue number, commit message, trailer validation, work branch) | `rad approve --commit` and `rad plan-status` (2b) |
| `rad plan-open <plan-file> [--trailer …]` | Migrating commands to `.rad/skills` (2c) |
| `Issue:` header lint rule | `rad wrap` (part 4) |
| Branch-prefix fallback fix in `rad approve` and `resolveWorkBranch` | Changing the forecast step or any lint rule other than `Issue:` |
| `/rad-plan` and `/rad-adopt`: `Issue:` in the templates; the git steps replaced by `rad plan-open` | `/rad-approve` prose (2b) |
| `docs/rad-cli.md`: `### rad plan-open` | `scripts/draft-insights-plan.sh` (keeps its own shell cut-and-commit) |

## Acceptance Criteria

1. **Pure helpers in `harness/plan-commit.js`, no I/O:**
   - **`planIssueNumber(text)`:**
     - returns the integer from `Issue:`;
     - else the number parsed from an `Adopted-From:` URL matching `/issues/(\d+)` or `/-/issues/(\d+)`;
     - else `null`.

     It reads only the header block (before the first `## `). A malformed `Issue:` value returns `null` here; lint is what reports it.
   - **`countWavesTasks(text)`:** `{ waves, tasks }`, counting `### Wave` and `#### Task` headings.
   - **`planCommitMessage(text, trailers)`:**
     - subject `adopt: <title>` when `Adopted-From:` is present, else `plan: <title>`, where `<title>` comes from `# Plan: <title>`;
     - then the body lines in order: `Adopted-From:` (adopt only), `Issue: <N>` (when known), `Author:` (the plan's own `Author:` header), `Waves: <N>`, `Tasks: <N>`, `Out-of-scope deps: yes|no` (`no` when the section is empty or "None");
     - then the validated trailers.
   - **`validateTrailer(s)`:** accepts only a single-line `Key: Value`, with a key matching `^[A-Za-z][A-Za-z0-9-]*$` and a non-empty value. Anything else is an error string.
   - **`planWorkBranch(headerBranch, feature)`:** the header value when it isn't empty, else `conventionWorkBranch(feature)` (honoring `RAD_BRANCH_PREFIX`, default `rad/`).
2. **`Issue:` lint rule.** `scripts/lint-plan.sh` accepts a missing `Issue:` line. When the line is present, a value that isn't a positive integer (`^[1-9][0-9]*$`) is an error naming the value.
3. **Branch-prefix fix.** `resolveWorkBranch` and `approveCommand` resolve the work branch through `planWorkBranch`. With `RAD_BRANCH_PREFIX=team/` and no `Branch:` header, both resolve `team/<feature>`, and no hard-coded `` `rad/${feature}` `` remains in `harness/cli.js`.
4. **`rad plan-open <plan-file> [--trailer "Key: Value"]…`.**
   - **Refusals: exit 2, nothing changed, reason on stderr:**
     - bad argv or an invalid trailer;
     - the path isn't `.agents/plans/<slug>.md` under the repo root, or the slug fails `^[a-z0-9][a-z0-9-]*$`;
     - the `Branch:` header is missing or not equal to `conventionWorkBranch(<slug>)`;
     - `lint-plan.sh` fails (its output is passed through);
     - uncommitted changes to tracked files (`git status --porcelain --untracked-files=no` is not empty);
     - the branch exists on origin but not locally;
     - the branch exists locally with commits that aren't the plan commit;
     - the default-branch lookup or `git fetch` fails.
   - **Fresh run:** fetch `origin/<default>`, `git checkout -b <branch> origin/<default>`, stage only the plan file, commit with `planCommitMessage`, then `git push -u origin <branch>`.
   - **Resume:**
     - If the branch exists locally with no commits beyond `origin/<default>`, it continues at the commit step.
     - If its tip commit is the plan commit (the plan file at the tip matches the working copy byte for byte), it continues at the push step.
   - **Failures after the branch exists exit 1.** The message says what happened (`committed locally; push failed: <reason>; rerun rad plan-open to push`) and that rerunning is safe.
   - **Label after a successful push:** with an issue, `scripts/rad-label.sh <N> pending-review`; without one, it prints `label skipped: no issue`.
   - **Success** prints `rad plan-open: ok feature=<slug> branch=<branch> commit=<sha> issue=<N|none>` and exits 0.
   - It's listed in `rad`'s subcommand help.
5. **The commands call `rad plan-open`.**
   - **`/rad-plan` and `/rad-adopt` templates:** add an `Issue:` header line, `[issue number — omit when the plan has no issue]`. Under `--light` it goes in the light template too.
   - **`/rad-plan` Step 5 and `/rad-adopt` Step 7:** the hand-written git and label block is replaced by one `node harness/cli.js plan-open .agents/plans/<slug>.md` call, with these instructions:
     - pass one `--trailer` per attribution line your tool requires;
     - exit 0 → continue;
     - exit 1 → report and rerun once the push can succeed;
     - exit 2 → fix the reported problem and rerun.
   - **No `git checkout`, `git commit`, `git push` or `rad-label.sh` remains in either file's steps.** The lint and forecast steps stay as they are.
6. **Docs.** `docs/rad-cli.md` has a `### rad plan-open` section covering usage, the refusals, resume, exit codes 0/1/2, the derived message, `--trailer`, and labelling.
7. **Every suite stays green:**
   - `npm test --prefix harness`;
   - every `scripts/test-*.sh` under both shells;
   - `lint-invariants`;
   - `lint-agent-files`;
   - `generate --check`;
   - `lint-plan` on this plan.

## Agent Scope

Research was done directly by the architect, plus one read-only Explore sweep of the part 2 surface. No scope-map agent covers the plan-commit path.

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/plan-commit.js | 1-150 | New: pure helpers (AC#1) |
| harness/test/plan-commit.test.js | 1-150 | New: helper tests |
| harness/plan-open.js | 1-160 | New: `planOpenCommand` |
| harness/adapters/git-state-store.js | 97 | Amendment 1: `export` `isSafeFeature` so `plan-open` can reuse it |
| harness/test/cli-plan-open.test.js | 1-180 | New: `plan-open` against temp repos with a bare origin |
| harness/cli.js | 56-200 | Usage constant and `plan-open` subcommand entry |
| harness/cli.js | 731-741 | `conventionWorkBranch` exported or reused by `planWorkBranch` |
| harness/cli.js | 1395-1401 | `resolveWorkBranch` uses `planWorkBranch` |
| harness/cli.js | 1868-1878 | `approveCommand` work-branch fallback uses `planWorkBranch` |
| scripts/lint-plan.sh | 50-100 | `Issue:` header rule |
| scripts/test-lint-plan.sh | 1-40 | Header: list the new cases |
| scripts/test-lint-plan.sh | 1190-1228 | New `Issue:` cases |
| .claude/commands/team/rad-plan.md | 165-185 | Standard template: `Issue:` line |
| .claude/commands/team/rad-plan.md | 310-330 | Light template: `Issue:` line |
| .claude/commands/team/rad-plan.md | 360-435 | Step 5: replace git/label block with `rad plan-open` |
| .claude/commands/team/rad-adopt.md | 120-135 | Template: `Issue:` line |
| .claude/commands/team/rad-adopt.md | 225-285 | Step 7: replace git/label block with `rad plan-open` |
| docs/rad-cli.md | 40-70 | `### rad plan-open` after `### rad approve` |

## Execution Notes

### Do Not Touch
- `.claude/commands/architect/rad-approve.md`: 2b.
- `scripts/draft-insights-plan.sh`: keeps its own shell path.
- `scripts/rad-label.sh`, `scripts/get-default-branch.sh`, `scripts/checkout-plan.sh`: call them, don't change them.
- `harness/gates.js` and the events writer: `plan-open` writes no events.
- `harness/adapters/git-state-store.js` other than adding `export` to `isSafeFeature` (Amendment 1).

### Key Files
- `harness/cli.js`:
  - `mainGit`: runs git and throws on a non-zero exit (fail-closed).
  - `commitRunEvents`: the commit-only-if-something-is-staged pattern.
  - `readDefaultBranch`: call it with `verb: 'rad plan-open'`.
  - `conventionWorkBranch` / `DEFAULT_BRANCH_PREFIX`.
  - `parsePlanCtx`; the exit-code constants (`USAGE_EXIT_CODE` = 2, `FAILED_EXIT_CODE` = 1); the `SUBCOMMANDS` table.
- `harness/adapters/git-state-store.js`: `defaultSh` (never throws, returns `{status, stdout, stderr}`), `isSafeFeature`.
- `harness/test/portable-process-memory.test.js`: the temp-repo pattern to copy (`withTempRepo`, `initRepo`, bare-origin setup).
- `scripts/draft-insights-plan.sh` (lines 238-271): the shell precedent for the precondition checks (clean tree, branch missing locally and on origin).
- `scripts/lib/plan-paths.sh` (`plan_tier`): how a header field is read from the header block only.

### Reminders
- **Every git call takes an args array through `sh`,** and `ctx.sh ?? defaultSh` is injectable for tests. Never build a shell string.
- **`plan-open` always pushes.** It doesn't read `RAD_SYNC`.
- **Stage only the plan file.** Never `git add -A`.
- **Write the slug regex once.** Reuse `isSafeFeature`; don't add another copy. Amendment 1: it isn't exported today, so Task 2.1 adds `export` to its declaration in `git-state-store.js` and imports it. The other private copies (`git-artifact-store.js`, `digest.js`, `DIGEST_FEATURE_PATTERN` in `cli.js`) are left for a follow-up.
- **`rad-label.sh` exits 0 even when `gh` is missing.** Don't treat its output as a failure. Only a non-zero exit (usage) is a bug.

## Program Design

**Signatures:**
- `harness/plan-commit.js`:
  - `planIssueNumber(text: string): number | null`
  - `countWavesTasks(text: string): { waves: number, tasks: number }`
  - `planCommitMessage(text: string, trailers: string[]): string`
  - `validateTrailer(s: string): string | null`, where `null` means valid and a string is the error
  - `planWorkBranch(headerBranch: string | undefined, feature: string): string`
- `harness/plan-open.js`: `export async function planOpenCommand(argv: string[], ctx: { repoRoot, sh?, env? }): Promise<0 | 1 | 2>`

**Call stack:**
```
rad plan-open <plan> --trailer …
  parse argv + validateTrailer → resolve slug/path (isSafeFeature) → read plan → Branch == conventionWorkBranch(slug)?
  → branch state: local? remote? (show-ref, ls-remote)
      remote-only → refuse 2
      local with plan commit at tip → PUSH
      local with no commits beyond origin/<default> → COMMIT
      local with other commits → refuse 2
      absent → lint-plan.sh → clean tracked tree → readDefaultBranch → fetch → checkout -b → COMMIT
  COMMIT: add <plan> → commit -m planCommitMessage → PUSH
  PUSH: push -u origin <branch> → fail ⇒ exit 1 (resumable)
  → planIssueNumber → rad-label.sh <N> pending-review | "label skipped: no issue" → ok line, exit 0
```

**File tree diff:**
```
+ harness/plan-commit.js
+ harness/plan-open.js
+ harness/test/plan-commit.test.js
+ harness/test/cli-plan-open.test.js
  (all other changes are in-place edits)
```

## Wave Plan

### Wave 1 — parallel
These tasks touch independent files.

#### Task 1.1: Pure plan-commit helpers
File: harness/plan-commit.js:1-150, harness/test/plan-commit.test.js:1-150
What:
- Implement the AC#1 helpers. `planWorkBranch` honors `RAD_BRANCH_PREFIX`: import the convention from `cli.js` if that wouldn't create a circular import; otherwise move `DEFAULT_BRANCH_PREFIX` and `conventionWorkBranch` into `plan-commit.js` and have `cli.js` import them.
- **Tests:**
  - **`planIssueNumber`:** `Issue:` wins over `Adopted-From`; GitHub and GitLab URLs parse; free-text `Adopted-From` → `null`; neither → `null`; `Issue:` in the body below the header is ignored; `Issue: abc` → `null`.
  - **`countWavesTasks`:** counts correctly, and a plan with no waves → zeros.
  - **`planCommitMessage`:** the plan and adopt subjects; body line order; `Issue:` present or absent; `Out-of-scope deps` gives `no` for "None" and `yes` otherwise; trailers appended after the derived lines.
  - **`validateTrailer`:** accepts `Co-Authored-By: X <y@z>`; rejects a missing colon, an empty value, an embedded newline, and a key with spaces.
  - **`planWorkBranch`:** header wins; with no header, `RAD_BRANCH_PREFIX` is honored, defaulting to `rad/`.
Validate: AC#1 — `npm test --prefix harness` passes. Named edge cases: a missing header, free-text `Adopted-From`, malformed `Issue:`, zero waves, multi-line trailer injection, a custom prefix.

#### Task 1.2: `Issue:` lint rule
File: scripts/lint-plan.sh:50-100, scripts/test-lint-plan.sh:1-40, 1190-1228
What:
- Read `Issue` with the existing `header_field`. When it's present and doesn't match `^[1-9][0-9]*$`, add the error `Invalid Issue value: '<v>' (expected a positive issue number)`.
- **Test cases:** absent → no error; `Issue: 186` → no error; `Issue: 0`, `Issue: #186` and `Issue: abc` → error naming the value. List the new cases in the header comment.
Validate: AC#2 — `bash scripts/test-lint-plan.sh` and `/bin/bash scripts/test-lint-plan.sh` pass. Named edge cases: absent, zero, `#`-prefixed, non-numeric.

#### Task 1.3: Branch-prefix fallback fix
File: harness/cli.js:731-741, 1395-1401, 1868-1878
What:
- Replace both hard-coded `` `rad/${feature}` `` fallbacks with `planWorkBranch(header, feature)`, and update the doc comments.
- Add a test in `harness/test/plan-commit.test.js` (the helper) and one `approveCommand` or `resolveWorkBranch` case showing `RAD_BRANCH_PREFIX=team/` resolves `team/<feature>` when the `Branch:` header is missing. Put it wherever the existing tests for those functions live; if there are none, put it in `plan-commit.test.js` via the helper.
Validate: AC#3 — `npm test --prefix harness` passes, and `grep -n 'rad/\${feature}' harness/cli.js` finds nothing. Named edge case: a custom prefix with no `Branch:` header.

### Wave 2 — sequential
The command depends on the Wave 1 helpers.

#### Task 2.1: `rad plan-open` command
File: harness/plan-open.js:1-160, harness/test/cli-plan-open.test.js:1-180, harness/cli.js:56-200, harness/adapters/git-state-store.js:97
What:
- Amendment 1: add `export` to `isSafeFeature` in `harness/adapters/git-state-store.js` and import it for the slug check. No other change to that file.
- Implement `planOpenCommand` per AC#4 and the call stack above. Keep each function under about 40 lines: argv, preconditions, branch-state classification, commit, push, label.
- Register `plan-open` in `SUBCOMMANDS` with a usage constant, and route git through `mainGit`/`sh`.
- **Tests** (temp repo with a bare origin, plus `.rad/config.yml` and copies of the scripts it calls, or a `sh` stub where the real script can't run):
  - fresh run → branch on origin, a single commit with the exact derived message (plan subject, and the adopt subject when `Adopted-From` is present), exit 0;
  - `--trailer` appended;
  - an invalid trailer → exit 2, nothing changed;
  - `Branch:` header missing or mismatched → exit 2;
  - lint failure → exit 2, no branch;
  - dirty tracked tree → exit 2;
  - branch only on origin → exit 2;
  - push failure (origin made unreachable) → exit 1, local commit exists; rerun after restoring origin → exit 0 with exactly one plan commit;
  - existing local branch with an unrelated commit → exit 2;
  - label: with `Issue:`, the `rad-label.sh` stub is called with `<N> pending-review` only after the push; without an issue → "label skipped: no issue".
Validate: AC#4 — `npm test --prefix harness` passes. Named edge cases: invalid trailer, missing/mismatched branch, lint fail, dirty tree, remote-only branch, push failure plus resume, unrelated local commits, no issue.

### Wave 3 — sequential
Prose and docs switch over once the command exists, then a full-suite check.

#### Task 3.1: `/rad-plan` and `/rad-adopt` call `rad plan-open`
File: .claude/commands/team/rad-plan.md:165-185, 310-330, 360-435, .claude/commands/team/rad-adopt.md:120-135, 225-285
What:
- Add the `Issue:` line to the standard, light and adopt templates.
- Replace `/rad-plan` Step 5 and `/rad-adopt` Step 7 with the `rad plan-open` call and the exit-code handling in AC#5. Keep each step's heading and the summary step.
- Fix `/rad-adopt` Step 6b's `[feature-name]` to `[feature-slug]` (in range).
- Don't touch the lint, forecast or research steps.
Validate: AC#5 — `grep -nE 'git (checkout|commit|push)|rad-label\.sh' .claude/commands/team/rad-plan.md .claude/commands/team/rad-adopt.md` finds nothing in Step 5 or Step 7, and the templates contain `Issue:`. No testable surface beyond the grep (prompt text; `plan-open` is tested in 2.1).

#### Task 3.2: Docs
File: docs/rad-cli.md:40-70
What: Add a `### rad plan-open` section after `### rad approve`, per AC#6.
Validate: AC#6 — `grep` confirms the section. No testable surface (docs).

#### Task 3.3: Full-suite check
File: harness/plan-open.js:1-160
What: Read-only verification. Run:
- `npm test --prefix harness`;
- every `scripts/test-*.sh` under `bash` and `/bin/bash`;
- `scripts/lint-invariants.sh`;
- `scripts/lint-agent-files.sh`;
- `node harness/cli.js generate --check`;
- `scripts/lint-plan.sh` on this plan.

Fix only regressions this plan caused, within the declared files.
Validate: AC#7 — every command exits 0. No new testable surface (verification only).

## Tests to Write
- [ ] Issue number, wave/task counts, commit message, trailer validation, work branch with prefix — harness/test/plan-commit.test.js
- [ ] `plan-open` fresh, refusals, push failure and resume, labelling — harness/test/cli-plan-open.test.js
- [ ] `Issue:` header lint cases — scripts/test-lint-plan.sh

## Non-Goals
- No `approve --commit` or `plan-status` (2b), and no `.rad/skills` migration (2c).
- No change to `scripts/draft-insights-plan.sh`'s own branch-and-commit path.
- No `RAD_SYNC` interaction. `plan-open` always pushes.
- No rollback on failure, only resume.

## Out-of-Scope Dependencies
None.

## Risks
- **The prose switch changes how every plan from now on gets committed.** If `plan-open` has a bug, `/rad-plan` and `/rad-adopt` stop at Step 5 rather than half-committing. That's the intended fail-closed behavior, but it's a workflow-wide dependency. The temp-repo tests cover the full path.
- **Circular import.** `plan-commit.js` must not import `cli.js` if `cli.js` imports `plan-commit.js`. Task 1.1 moves the prefix convention if needed.
- **The template's `Author:` header becomes the commit's `Author:` line.** A plan with a wrong or missing `Author:` header gets a wrong or `unknown` value. That's acceptable, since it's display-only, the same as today's hand-written value.

## Issue Gaps
- **[ASSUMPTION] The commit's `Author:` line comes from the plan's own `Author:` header,** not a fresh role lookup. The template already records it, and this keeps the message a pure function of the plan. If the header is missing, the value is `unknown`.
- **[ASSUMPTION] "Out-of-scope deps: no" when the section body is empty or exactly "None"** (case-insensitive, ignoring surrounding whitespace and punctuation). Anything else is `yes`.
- **[ASSUMPTION] Resume compares the plan file at the branch tip with the working copy byte for byte.** If they differ, the rerun refuses rather than amending, so an edit after a failed push needs a deliberate fix.
- **[ASSUMPTION] Splitting 2a into 2a/2b** (this plan has `plan-open`; `approve --commit` and `plan-status` come next) is packaging only, forced by the read budget. Every 2026-10-07 decision is unchanged.
- **[ASSUMPTION] Commands get `--trailer` guidance in prose** ("pass one `--trailer` per attribution line your tool requires"). The command bodies don't hard-code any tool's attribution.
