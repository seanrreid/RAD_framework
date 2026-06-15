---
description: >
  ARCHITECT ONLY. Decompose an epic issue into per-child shaping stories. Fetches
  the epic and its children from GitHub, reads project context, and writes a
  discovery artifact to .agents/epics/epic-[N]-[slug].md (Status: draft). This is a
  Gate-0 shaping step — it does NOT generate plans, call /rad-research or /rad-plan,
  commit, open a PR, or flip any approval status. The architect reviews, edits,
  commits, and signs off manually.
---

# /rad-epic-decompose

Consume a GitHub epic issue and produce a per-child decomposition artifact the
architect uses to shape the epic into deliverable work. This sits **upstream** of
the RAD workflow at Gate 0: it shapes; it does not plan, research, or deliver.

The output is a discovery/shaping document — a structured read on each child story
plus an epic-level rollup with an architect sign-off checklist. It is written but
never auto-committed, never turned into plan files, and never flips any status.

## Input

`$ARGUMENTS` is the epic issue number or URL. Examples: `42`, `#42`,
`https://github.com/org/repo/issues/42`.

If `$ARGUMENTS` is empty, stop:

```
✗ /rad-epic-decompose requires an epic issue number or URL.
  Usage: /rad-epic-decompose <issue-number-or-url>
```

---

## Process

### Step 1: Verify authority to decompose

This command is architect-only. Gate on the running user's role **before** any
fetch or context read:

```bash
scripts/check-role.sh architect
```

If the script exits non-zero, stop. Do not fetch the epic, do not read context,
do not write anything.

### Step 2: Fetch the epic and its children

Only after the role gate passes, call the Wave 1 fetch script with the raw
`$ARGUMENTS` value. The script normalizes a bare number, `#NN`, or a GitHub issue
URL itself, so pass the argument through unchanged:

```bash
scripts/fetch-epic.sh "$ARGUMENTS"
```

The script emits a single JSON object on stdout:

```json
{ "epic": { "number": …, "title": …, "body": …, "url": …, "milestone": …, "labels": […], "state": … },
  "children": [ { "number": …, "title": …, "body": …, "url": …, "milestone": …, "labels": […], "state": … }, … ] }
```

It is GitHub-only for v1 and exits non-zero with a clear message on any other
platform or if `gh`/`jq` are missing (set `RAD_PLATFORM` only when testing). If
the script exits non-zero, surface its message and stop — do not fabricate epic or
child data.

Capture the epic number `N` and derive a kebab-case `slug` from the epic title
(lowercase, spaces and punctuation collapsed to single hyphens, no leading or
trailing hyphen).

### Step 3: Read project context

Read these for grounding so each child story reflects the project's actual
conventions and architecture — do **not** scan speculatively beyond this set:

- `CLAUDE.md` — project conventions, stack, constraints, role assignments.
- `.agents/architecture/` — the approved agent architecture and scope map, for
  mapping child stories onto affected domains. (Read these as **context only**;
  never hand-edit them, and never read `.claude/agents/` as an input.)
- 3–5 of the most recent `.agents/plans/*.md` — to mirror the house plan shape
  when recommending a plan structure per child. Read them for shape only; never
  read, write, or mutate any plan's `Status:` field.

### Step 4: Compose the decomposition artifact

For **each child issue**, generate a story section with exactly these fields:

- **What** — the change the child issue asks for, in one or two sentences.
- **Why** — the value/motivation, tied to the epic's goal.
- **Acceptance criteria** — concrete, checkable conditions for "done".
- **Affected domains** — the agent/domain boundaries (from
  `.agents/architecture/`) the work touches.
- **Recommended plan structure** — a sketch of how a future plan would wave the
  work (mirroring recent `.agents/plans/` shape). This is a *recommendation* only;
  do not generate an actual plan file.
- **Open questions** — unknowns the architect must resolve before planning.

Then generate one **epic-level section** with:

- **Execution order** — suggested sequencing/dependencies across the children.
- **Cross-cutting concerns** — shared risks, contracts, or migrations spanning
  multiple children.
- **Open questions** — epic-wide unknowns.
- **Architect sign-off checklist** — unchecked boxes the architect ticks by hand
  when shaping is complete (e.g. children scoped, ordering confirmed, open
  questions resolved, ready to /rad-plan the first child).

### Step 5: Write the artifact

Write to `.agents/epics/epic-[N]-[slug].md` (create `.agents/epics/` if absent).
Use this shape:

```markdown
# Epic Decomposition: [Epic Title]
Created: [YYYY-MM-DD]
Status: draft
Epic: [epic url] (#[N])

## Epic Summary
[1–3 sentence restatement of the epic's goal, from the epic body.]

## Child Stories

### #[child-number] — [child title]
- What: …
- Why: …
- Acceptance criteria:
  - …
- Affected domains: …
- Recommended plan structure: …
- Open questions: …

[…one section per child…]

## Epic-Level

### Execution Order
[suggested sequencing / dependency notes]

### Cross-Cutting Concerns
[shared risks, contracts, migrations]

### Open Questions
[epic-wide unknowns]

### Architect Sign-off Checklist
- [ ] Children scoped and understood
- [ ] Execution order confirmed
- [ ] Cross-cutting concerns addressed
- [ ] Open questions resolved
- [ ] Ready to /rad-plan the first child
```

Write the file directly. **Do not** auto-commit, push, open a PR, or set any
approval status — the architect commits and signs off by hand.

### Step 6: Optionally mirror issue labels

Only when `RAD_UPDATE_ISSUES=true`, best-effort mirror a status label onto the
epic and child issues (no-ops without `gh`; never fails the command):

```bash
if [[ "${RAD_UPDATE_ISSUES:-}" == "true" ]]; then
  scripts/rad-label.sh [N] draft
  # …and each child number, if desired…
fi
```

Default is OFF — without `RAD_UPDATE_ISSUES=true`, do not touch any GitHub issue.

### Step 7: Print summary

```
Epic decomposition written: .agents/epics/epic-[N]-[slug].md  (Status: draft)

Children decomposed: [count]

This is a shaping artifact — no plans were generated and nothing was committed.

Next steps:
1. Review and edit the artifact; tick the sign-off checklist as you go.
2. Commit it yourself when satisfied.
3. When ready, plan the first child with /rad-plan.
```

---

## Rules

- Architect-only — gate on `scripts/check-role.sh architect` **before** any fetch
  or context read.
- Writes exactly one artifact to `.agents/epics/epic-[N]-[slug].md` with `Status:`
  and `Created: YYYY-MM-DD` headers; slug is kebab-case.
- Never generate plan files, and never call `/rad-research` or `/rad-plan` — this
  command only shapes; it does not plan, research, or deliver.
- Never auto-commit, push, open a PR, or flip any approval/plan status — the
  architect commits and signs off manually.
- Never read `.claude/agents/` as an input; read context only from `CLAUDE.md`,
  `.agents/architecture/`, and recent `.agents/plans/`.
- Never write or mutate any plan's `Status:` field, and never hand-edit
  `.claude/agents/` or `.agents/architecture/`.
- Never mutate GitHub issues unless `RAD_UPDATE_ISSUES=true`; default off, and the
  label mirror is best-effort (never fails the command).
- If `fetch-epic.sh` exits non-zero, surface its message and stop — never fabricate
  epic or child data.
