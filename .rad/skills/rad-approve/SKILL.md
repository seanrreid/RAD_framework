---
name: rad-approve
description: >
  Review and approve a pending plan. Architect-only by default; the
  --on-behalf-of proxy flag lets a non-architect record an approval the architect
  already gave out-of-band. Records the approval on the plan's rad/ work-branch
  tip (never on the default branch), which unblocks rad-deliver. There is no plan
  PR — the plan reaches the default branch later via the deliver PR.
targets:
  claude: command:architect/rad-approve
  codex: skill
  codex_implicit: false
---

# rad-approve

Review a pending plan and approve it for execution. Under the Lane B model the
plan doc lives on its `rad/[feature]` work branch; approval is recorded on that
branch tip. Nothing is committed to the default branch here.

## Input

The input — {{args}} — should be a plan name or path, optionally followed by
the proxy-approval flags:
- `feature-name` → resolves to `.agents/plans/feature-name.md` on `rad/feature-name`
- `.agents/plans/feature-name.md` → used directly
- `feature-name --on-behalf-of "Sean R Reid" --evidence "Slack #rad 2026-05-28: 'plan looks good, approve it'"`

### Proxy approval (`--on-behalf-of`)

By default this command is architect-only — it gates on the git user's role.
When the architect approves a plan **out-of-band** (Slack, a PR comment, a verbal
yes in standup) but doesn't run `rad-approve` (`/architect:rad-approve` in Claude Code) themselves, a team member may
record that approval with:

- `--on-behalf-of "<architect name>"` — who actually approved. Must resolve to a
  configured architect in `.rad/config.yml` (validated, not just typed).
- `--evidence "<text or link>"` — **required** with `--on-behalf-of`. A quote,
  Slack permalink, or PR-comment URL showing the architect's approval. This is
  the audit-trail substitute for the architect running the command themselves.

The recording user's own git identity is captured separately as `Recorded-By`,
so the record always shows both who approved and who entered it.

If empty, list plans awaiting approval (reading branch tips, since plans live on
their work branches):

```bash
scripts/rad-status.sh 2>/dev/null | grep pending-review \
  || echo "No pending plans found."
```

---

## Process

### Step 1: Verify authority to approve

First, parse the input ({{args}}) for the proxy flags. Set `PLAN_ARG` to the plan
name or path — everything before the first `--` flag. Set `ON_BEHALF_OF` and
`EVIDENCE` to the values of `--on-behalf-of` and `--evidence` if present (empty
otherwise). Every later bash block uses `"$PLAN_ARG"`, `"$ON_BEHALF_OF"` and
`"$EVIDENCE"`.

**Default (no `--on-behalf-of`)** — gate on the running user's role:

```bash
scripts/check-role.sh architect
```

If the script exits non-zero, stop. Do not proceed.

**Proxy (`--on-behalf-of "<name>"` present)** — validate the named approver, not
the running user:

```bash
# 1. The approver name is mandatory. An empty value would let check-role.sh fall
#    back to the running user's identity, corrupting the audit trail — refuse it.
[[ -z "${ON_BEHALF_OF//[[:space:]]/}" ]] && { echo "✗ --on-behalf-of requires the name of the architect who approved."; exit 1; }

# 2. Evidence is mandatory for proxy approval (reject whitespace-only values).
[[ -z "${EVIDENCE//[[:space:]]/}" ]] && { echo "✗ --on-behalf-of requires --evidence (cite where the architect approved)."; exit 1; }

# 3. The named approver must be a configured architect. The second argument is
#    the repo root (`.`), which check-role.sh needs to reach the third
#    (identity) position.
scripts/check-role.sh architect . "$ON_BEHALF_OF"
```

If the named approver is not a configured architect, stop:

```
✗ "<name>" is not a configured architect in .rad/config.yml — cannot record their approval.
```

Note: the running user does **not** need the architect role in proxy mode — that's
the point of the flag. Their identity is recorded as `Recorded-By`.

### Step 2: Check out the work branch at its tip and read the plan

Resolve the feature slug from `PLAN_ARG`, then check out the work branch at its
remote tip. Reading the tip matters — approving a stale local copy would record
approval against the wrong plan. `rad checkout` fails loudly if the branch is
missing, has diverged, or has no plan file; do not approve until it succeeds.

```bash
FEATURE=$(basename "$PLAN_ARG" .md)
PLAN_FILE=".agents/plans/$FEATURE.md"

node harness/cli.js checkout "$FEATURE"   # fetches + ff-pulls to the remote tip
```

- **Exit 0** → on the work branch at its remote tip (it prints
  `rad checkout: ok feature=… branch=… head=… plan=…`); continue.
- **Exit 1** → stop and report the message (a missing branch, divergence, or no
  plan file).
- **Exit 2** → a bad feature name or argument; fix the name and rerun.

Read the plan file fully. If its current Status is `in-progress`, `complete`, or
`approved`, stop:

```
✗ Cannot approve: plan status is already [status].
```

Run the plan linter before showing the review summary:

```bash
scripts/lint-plan.sh "$PLAN_FILE"
```

If the linter reports errors, display them and stop:

```
✗ Plan has lint errors — ask the author to fix them before requesting approval.
[linter output]
```

Warnings are shown to the architect as context but do not block approval.

Run the approval-blocker check alongside the linter:

```bash
scripts/check-approval-blockers.sh "$PLAN_FILE"
```

Exit 0 means no blockers remain; stdout lists one `<id>\t<justification>` line per
applied waiver. When the effective high-risk pattern (`RAD_HIGH_RISK_PATTERNS`,
empty → default) differs from the built-in default, stdout begins with one extra
`high-risk-pattern\t<pattern>` line — this is the narrowed pattern the approval will
be recorded under, **not** a waiver. Exit 1 means blockers remain — each is named on stderr: an
unresolved clarification marker, or an un-waived `high-risk:<path>` finding. Exit 2
is a usage or unreadable-plan error — stop and surface it. Do not stop on exit 1;
carry the blockers and waivers into the Step 3 summary.

Next to the blocker check, resolve each wave's capability classes — capture stdout
and the exit code:

```bash
node harness/cli.js capabilities "$FEATURE"
```

This is the same read-only resolution `rad deliver` runs (plan and wave
`Capabilities:` lines against `capabilities.deny` in `.rad/config.yml`), and it
appends no event. Exit 0 prints one line per wave:
`wave N: <classes> (<default|plan|wave>)`, plus `; denied: <classes>` when the deny
list narrowed that wave. A non-zero exit (2 for a malformed `Capabilities:` line or
a denied explicit request; 1 for a missing plan or an invalid `.rad/config.yml`)
prints the reason on stderr. Do not stop on any exit code — this check is
**advisory** and never blocks approval; carry the lines (or the error) into the
Step 3 summary.

### Step 3: Display review summary

Output the plan for architect review:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Plan Review: [Feature Name]
Branch:      rad/[feature-name]
Author:      [Author from plan file]
Created:     [Created date from plan file]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Context section]

[Scope table]

[Acceptance Criteria]

[Agent Scope section]

[Files in Scope table]

Waves: [N] | Tasks: [total] | ACs: [count] | Out-of-scope deps: [yes/no]

[Risks section]

[Non-Goals section]

Blockers & Waivers
  Blockers: [none | one line per blocker from check-approval-blockers.sh stderr]
  Waivers:  [none | one line per applied waiver: high-risk:<path> — <justification>]
  [only if stdout had a high-risk-pattern line:]
  Recorded under a non-default high-risk pattern: <pattern>

Capabilities
  [default (fs_read, fs_write, shell) for every wave
   | one line per wave from `rad capabilities`: wave N: <classes> (<source>)[; denied: <classes>]
   | Capabilities: <message> — deliver will refuse this plan]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Blockers & Waivers** — render this block from the Step 2 blocker check before the
confirmation prompt:

- **Unresolved blockers** — state plainly that approval **will be refused** in
  Step 4 until each one is cleared. A clarification marker must be answered in the
  plan (markers are resolve-only — they cannot be waived). A high-risk finding must
  be resolved (remove the path) or waived with a justified bullet in the plan's
  `## Waivers` section.
- **`light-tier:` blockers** — a `Tier: light` plan beyond a light limit (more
  than 1 wave, more than 3 tasks, or a high-risk or self-protected path). These
  **cannot be waived**. The fix is to shrink the plan back within the limits, or
  promote it to standard: remove `Tier: light` and add the standard sections.
  Then re-run `rad-approve`.
- **Applied waivers** — list each with its justification. Judge every justification
  yourself: approving the plan accepts the waiver. Waivers are frozen into the
  `approved` event, so editing `## Waivers` after approval changes the plan
  fingerprint and requires re-approval.
- **Non-default high-risk pattern** — if stdout began with a
  `high-risk-pattern\t<pattern>` line, render it as `Recorded under a non-default
  high-risk pattern: <pattern>` so you see the narrowing. Never list it as a waiver.
  Judge whether the narrowed pattern is acceptable: `rad approve` freezes it into
  the `approved` event as `highRiskPattern`, and CI surfaces it as an advisory.

**Capabilities** — render this block from the Step 2 `rad capabilities` call,
right after Blockers & Waivers:

- **Every wave's source is `default` and nothing is denied** — collapse to the single
  line `default (fs_read, fs_write, shell) for every wave`.
- **Otherwise** — show each wave line exactly as printed. A `plan` or `wave` source
  means the plan declares its own set; a `; denied:` suffix means the project deny
  list narrowed that wave's implicit default.
- **Non-zero exit** — render the stderr reason as a blocker-style line:
  `Capabilities: <message> — deliver will refuse this plan`. This is **advisory
  only**: it does NOT block approval, but `rad deliver` will refuse the plan
  (exit 2, before any event) until the line or the deny list is fixed.
- Requests for `net` or `mcp` (beyond the default) also appear as
  `capability request` warnings in the Step 2 lint output — judge them here.
  Approving the plan accepts its declared capabilities.

After rendering the review summary, scan the plan's wave structure for slop-risk
signals before presenting the confirmation prompt. This is a **read-only analysis**
— it never modifies the plan or blocks approval automatically.

**Slop-risk signals to detect** (scan every wave and task):

1. **Undefined failure semantics** — a task introduces retries, queues, caches, or
   background jobs without specifying what happens on failure (e.g. "add retry
   logic" with no failure behavior defined).

2. **Speculative generality** — a task asks for a "system for X", "framework for Y",
   or "mechanism to handle future Z" without a concrete present requirement. Matches
   the `ai/guardrails.md` rule: "Avoid speculative generality. Code for the known
   requirement, not imagined future variants."

3. **Scope too broad to validate** — a task whose `What:` description covers more
   than one distinct behavior, making it impossible to validate against a single AC.

4. **Cross-layer responsibility leakage** — a task that places auth, persistence,
   validation, formatting, or transport logic in a module description that doesn't
   own that responsibility.

5. **Missing or vague Validate field** — a task whose `Validate:` field doesn't
   cite a specific `AC#` or describes verification in terms that can't be confirmed
   without reading the code.

For each signal found, record: which task (Wave N, Task N.M), the signal type, and
a one-line description of what triggered it.

**Output the guardrails report** immediately after the closing `━━━` line and
before the confirmation prompt:

If no signals found:
```
Guardrails: PASS — no slop-risk signals detected across [N] tasks
```

If signals found:
```
Guardrails: FLAG — [count] signal(s) detected

┌─ Wave [N], Task [N.M]: [task title]
│  Signal: [signal type]
│  Detail: [one-line description]
└─

Architect may approve despite flags — these are advisory, not blocking.
```

Confirm before approving.

**Default mode** — ask the architect to confirm:

```
Approve this plan?
  yes      → approve and unblock rad-deliver
  no       → reject (team must revise and resubmit)
  feedback → request revision with notes
```

**Proxy mode (`--on-behalf-of`)** — restate the recorded approval and confirm the
evidence is accurate before writing it:

```
Record {architect}'s approval of this plan?
  Approver: {architect}  (out-of-band — see evidence)
  Evidence: {evidence text/link}
  Recorder: {your git user}

  yes → record approval and unblock rad-deliver
  no  → cancel, no changes made
```

- **yes** → proceed to Step 4
- **no** → run `node harness/cli.js plan-status "$FEATURE" rejected [--trailer "Key: Value" ...]`
  (see [Recording a review outcome](#recording-a-review-outcome) below), then output
  the rejection notice and stop
  (proxy mode: a `no` simply cancels — make no changes)
- **feedback** → prompt for feedback text and append it to the plan file as a
  `## Architect Feedback` section, then run
  `node harness/cli.js plan-status "$FEATURE" needs-revision [--trailer "Key: Value" ...]`,
  then output the revision notice and stop (default mode only)

#### Recording a review outcome

`rad plan-status` is architect-only. It sets the plan's `Status:` header, commits
**only the plan file** to the work branch (subject `review: <feature> <status>`;
body `Plan:`, `Issue:`, `Reviewed-By:`, then any `--trailer` lines), pushes the
work branch, and labels the issue with the status. Do not run those steps by hand.
Pass one `--trailer "Key: Value"` per attribution line your tool requires on
commits (single-line each); pass none if it requires none.

- **Exit 0** → the review is committed and pushed; output the notice and stop.
- **Exit 1** → a publish step (commit, push, or label) failed. Report the message
  and rerun the same command once the push can succeed — a rerun is safe and
  resumes where it stopped.
- **Exit 2** → refused, nothing changed (not an architect, the plan is already
  approved, in progress or complete, the approved gate passes, wrong branch,
  staged changes, or a bad argument). Fix the reported problem and rerun. Never
  hand-edit the Status header to get around a refusal.

### Step 4: Record the approval (delegated to the CLI)

**Do not write the plan-doc Status fields or append the event yourself.** The
`rad` CLI owns the recording — it appends the `approved` event to the feature's
`events.jsonl` (via `recordApproval`), which is the approval **authority** that
gates `rad-deliver` (`/team:rad-deliver` in Claude Code). It also writes the plan-doc Status header
(`Status: approved`, `Approved-By`, `Approved-At`, plus `Recorded-By` and
`Approval-Evidence` in proxy mode), but that header is now a **display mirror**
only — no gate reads it; the appended `approved` event is canonical. The CLI
performs the same authority checks (`scripts/check-role.sh`) described in Step 1,
so a refusal here mirrors that gate.

Run it from the repo root on the work-branch tip you checked out in Step 2:

**Default mode** — architect ran the command directly:

```bash
node harness/cli.js approve "$FEATURE" [--trailer "Key: Value" ...]
```

**Proxy mode (`--on-behalf-of`)** — pass the approver and the required evidence:

```bash
node harness/cli.js approve "$FEATURE" \
  --on-behalf-of "$ON_BEHALF_OF" \
  --evidence "$EVIDENCE" \
  [--trailer "Key: Value" ...]
```

Pass one `--trailer "Key: Value"` per attribution line your tool requires on
commits (single-line each); pass none if it requires none.

After recording, the CLI also publishes the approval itself: it commits **only**
the plan file and `.agents/state/$FEATURE/events.jsonl` to the work branch
(subject `approve: <feature>`, or `approve: <feature> (re-approval)`; body
`Plan:`, `Issue:`, `Approved-By:`, plus `Recorded-By:` and `Approval-Evidence:`
in proxy mode, then the `--trailer` lines), pushes the work branch, and labels the
issue `approved`. Do not run those steps by hand. The approval must reach the
work-branch tip — `rad-deliver` gates on it via `check-plan-approved.sh`, which
reads `origin/rad/[feature]` first. It refuses unless HEAD is the work branch with
nothing staged. **Never check out or commit to the default branch.**

On success the CLI prints a single structured line
(`rad approve: ok feature=… status=approved approved-by=… approved-at=… proxy=… committed=… pushed=…`,
plus `resumed=true` when a rerun found the approval already recorded for this
exact plan body).

- **Exit 0** → the approval is committed and pushed; continue to Step 5.
- **Exit 1** → either a refusal (authority — e.g. a non-architect with no valid
  proxy pair, or `--on-behalf-of` without `--evidence` — or an approval blocker;
  nothing written), or the commit, push, or label failed after recording. Report
  the message. For a refusal, fix it as described below; for a publish failure,
  rerun the same command once the push can succeed — a rerun is safe and resumes
  (it finds the recorded approval and does not record a second one).
- **Exit 2** → refused before writing, nothing changed (HEAD is not the work
  branch, staged changes are present, or an invalid `--trailer`). Fix the
  reported problem and rerun.

Never hand-edit the plan file to work around a non-zero exit.

The CLI also runs the approval-blocker check after its role checks and **refuses**
(exit 1, writes nothing) while any blocker remains or if the check itself fails.
On success it freezes the applied waivers into the event's `waivers` field. This
refusal is **final**: never hand-edit the plan's Status header or the event log to
get around it. Fix the plan instead — answer the marker, add a justified waiver,
or remove the path — commit it to the work branch, and re-run `rad-approve`.

### Step 5: Output confirmation

**Default mode:**

```
✓ Plan approved: [feature name]

Plan:        .agents/plans/[feature].md
Approved-By: [architect username]
Approved-At: [timestamp]
Branch:      rad/[feature-name]

rad-deliver is now unblocked:
  rad-deliver .agents/plans/[feature].md
```

**Proxy mode:**

```
✓ Plan approved (recorded on behalf of [architect]): [feature name]

Plan:        .agents/plans/[feature].md
Approved-By: [architect] (out-of-band)
Recorded-By: [your git user]
Approved-At: [timestamp]
Evidence:    [evidence]
Branch:      rad/[feature-name]

rad-deliver is now unblocked:
  rad-deliver .agents/plans/[feature].md
```

---

## Rules

- Default mode is architect-only — only architects listed under `roles.architect` in `.rad/config.yml` may approve directly
- Never approve a plan with unreviewed out-of-scope dependencies
- Never approve a plan with Status: in-progress, complete, or approved
- The CLI makes the commit, never you: `rad approve` commits only the plan file and its event log; `rad plan-status` commits the plan file alone — no other files
- Never commit to the default branch — the plan lands there when the deliver PR merges
- If the architect provides feedback, record needs-revision with `rad plan-status`, not an approval
- Do not delete the work branch — it carries the plan, approval, and (later) the code
- The approval commit on the work-branch tip is the audit trail — set Approved-By and Approved-At
- Approving a plan accepts its declared capabilities (`Capabilities:` lines). Both lines, the plan-header default and any wave-level line, are locked by the plan fingerprint, so changing either after approval requires re-approval. The capabilities check itself is advisory and never blocks approval

### Proxy approval (`--on-behalf-of`)

- `--on-behalf-of` records an approval the architect already gave **elsewhere** — it is not a way to self-approve or bypass the architect. The architect must actually have approved.
- `--on-behalf-of` requires `--evidence`. No evidence → refuse.
- The name passed to `--on-behalf-of` must resolve to a configured architect in `.rad/config.yml`. A non-architect name → refuse.
- Always record both `Approved-By` (the architect) and `Recorded-By` (whoever ran the command). Never collapse them — the split is the integrity of the gate.
- Use proxy mode honestly: only when you can cite a real, specific approval (a quote, Slack permalink, or PR comment). Fabricating or paraphrasing an approval that didn't happen defeats the purpose of the gate.
