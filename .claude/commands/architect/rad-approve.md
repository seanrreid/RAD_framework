---
description: >
  Review and approve a pending plan. Architect-only by default; the
  --on-behalf-of proxy flag lets a non-architect record an approval the architect
  already gave out-of-band. Records the approval on the plan's rad/ work-branch
  tip (never on the default branch), which unblocks /rad-deliver. There is no plan
  PR — the plan reaches the default branch later via the deliver PR.
---

# /rad-approve

Review a pending plan and approve it for execution. Under the Lane B model the
plan doc lives on its `rad/[feature]` work branch; approval is recorded on that
branch tip. Nothing is committed to the default branch here.

## Input

`$ARGUMENTS` should be a plan name or path, optionally followed by the
proxy-approval flags:
- `feature-name` → resolves to `.agents/plans/feature-name.md` on `rad/feature-name`
- `.agents/plans/feature-name.md` → used directly
- `feature-name --on-behalf-of "Sean R Reid" --evidence "Slack #rad 2026-05-28: 'plan looks good, approve it'"`

### Proxy approval (`--on-behalf-of`)

By default this command is architect-only — it gates on the git user's role.
When the architect approves a plan **out-of-band** (Slack, a PR comment, a verbal
yes in standup) but doesn't run `/rad-approve` themselves, a team member may
record that approval with:

- `--on-behalf-of "<architect name>"` — who actually approved. Must resolve to a
  configured architect in CLAUDE.md (validated, not just typed).
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

First, parse `$ARGUMENTS` for the proxy flags. Everything before the first `--`
flag is the plan name/path; capture the values of `--on-behalf-of` and
`--evidence` if present.

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

# 3. The named approver must be a configured architect.
scripts/check-role.sh architect CLAUDE.md "$ON_BEHALF_OF"
```

If the named approver is not a configured architect, stop:

```
✗ "<name>" is not a configured architect in CLAUDE.md — cannot record their approval.
```

Note: the running user does **not** need the architect role in proxy mode — that's
the point of the flag. Their identity is recorded as `Recorded-By`.

### Step 2: Check out the work branch at its tip and read the plan

Resolve the feature slug from `$ARGUMENTS`, then check out the work branch at its
remote tip. Reading the tip matters — approving a stale local copy would record
approval against the wrong plan. `checkout-plan.sh` fails loudly if the branch is
missing or has diverged; do not approve until it succeeds.

```bash
FEATURE=$(basename "$ARGUMENTS" .md)
PLAN_FILE=".agents/plans/$FEATURE.md"
WORK_BRANCH="rad/$FEATURE"

scripts/checkout-plan.sh "$WORK_BRANCH"   # fetches + ff-pulls to the remote tip
```

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
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

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
  yes      → approve and unblock /rad-deliver
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

  yes → record approval and unblock /rad-deliver
  no  → cancel, no changes made
```

- **yes** → proceed to Step 4
- **no** → update Status to `rejected`, commit + push to the work branch, output rejection notice, stop
  (proxy mode: a `no` simply cancels — make no changes)
- **feedback** → prompt for feedback text, append as `## Architect Feedback` section,
  update Status to `needs-revision`, commit + push to the work branch, output revision notice, stop
  (default mode only)

### Step 4: Record the approval (delegated to the CLI)

**Do not write the plan-doc Status fields or append the event yourself.** The
`rad` CLI owns the recording — it appends the `approved` event to the feature's
`events.jsonl` (via `recordApproval`), which is the approval **authority** that
gates `/rad-deliver`. It also writes the plan-doc Status header
(`Status: approved`, `Approved-By`, `Approved-At`, plus `Recorded-By` and
`Approval-Evidence` in proxy mode), but that header is now a **display mirror**
only — no gate reads it; the appended `approved` event is canonical. The CLI
performs the same authority checks (`scripts/check-role.sh`) described in Step 1,
so a refusal here mirrors that gate.

Run it from the repo root on the work-branch tip you checked out in Step 2:

**Default mode** — architect ran the command directly:

```bash
node harness/cli.js approve "$FEATURE"
```

**Proxy mode (`--on-behalf-of`)** — pass the approver and the required evidence:

```bash
node harness/cli.js approve "$FEATURE" \
  --on-behalf-of "$ON_BEHALF_OF" \
  --evidence "$EVIDENCE"
```

The CLI prints a single structured success line
(`rad approve: ok feature=… status=approved approved-by=… approved-at=… proxy=…`)
and exits 0 on success, or exits non-zero with a clear message (and writes
nothing) on a refusal — e.g. a non-architect with no valid proxy pair, or
`--on-behalf-of` without `--evidence`. If it exits non-zero, stop and surface its
message; do not hand-edit the plan file to work around it.

### Step 5: Commit the approval to the work branch

The CLI has already written the plan file (Step 4); your only job here is to
commit and push that change. The approval must reach the work-branch tip —
`/rad-deliver` gates on it via `check-plan-approved.sh`, which reads
`origin/rad/[feature]` first. **Never check out or commit to the default branch.**

```bash
git add ".agents/plans/$FEATURE.md" ".agents/state/$FEATURE/events.jsonl"
git commit -m "approve: $FEATURE

Plan:  .agents/plans/$FEATURE.md
(Status + approved event written by: node harness/cli.js approve)"

git push origin "rad/$FEATURE"
```

If the project tracks plans against issues and `gh` is available, mirror the
status label (best-effort; no-ops without `gh`):

```bash
scripts/rad-label.sh [issue-number] approved   # omit if there is no issue
```

### Step 6: Output confirmation

**Default mode:**

```
✓ Plan approved: [feature name]

Plan:        .agents/plans/[feature].md
Approved-By: [architect username]
Approved-At: [timestamp]
Branch:      rad/[feature-name]

/rad-deliver is now unblocked:
  /rad-deliver .agents/plans/[feature].md
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

/rad-deliver is now unblocked:
  /rad-deliver .agents/plans/[feature].md
```

---

## Rules

- Default mode is architect-only — only architects listed in CLAUDE.md Role Assignments may approve directly
- Never approve a plan with unreviewed out-of-scope dependencies
- Never approve a plan with Status: in-progress, complete, or approved
- Commit only the plan file to the work branch — no other files
- Never commit to the default branch — the plan lands there when the deliver PR merges
- If the architect provides feedback, set Status to needs-revision, not approved
- Do not delete the work branch — it carries the plan, approval, and (later) the code
- The approval commit on the work-branch tip is the audit trail — set Approved-By and Approved-At

### Proxy approval (`--on-behalf-of`)

- `--on-behalf-of` records an approval the architect already gave **elsewhere** — it is not a way to self-approve or bypass the architect. The architect must actually have approved.
- `--on-behalf-of` requires `--evidence`. No evidence → refuse.
- The name passed to `--on-behalf-of` must resolve to a configured architect in CLAUDE.md. A non-architect name → refuse.
- Always record both `Approved-By` (the architect) and `Recorded-By` (whoever ran the command). Never collapse them — the split is the integrity of the gate.
- Use proxy mode honestly: only when you can cite a real, specific approval (a quote, Slack permalink, or PR comment). Fabricating or paraphrasing an approval that didn't happen defeats the purpose of the gate.
