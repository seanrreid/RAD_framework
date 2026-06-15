# Epic Decomposition (Gate 0)

`/rad-epic-decompose` is the **Gate-0 shaping step**, upstream of
`/rad-research` in the RAD workflow. It takes a GitHub epic — a parent issue
with linked children — and produces a discovery artifact the architect uses to
shape the epic into deliverable work, one child story at a time.

It sits *before* the rest of the loop:

```
Architect:  /rad-epic-decompose → Gate 0: shapes a GitHub epic into per-child stories
Anyone:     /rad-research        → consumes a PRD/issue, writes .agents/research/
Architect:  /rad-design          → drafts + generates .claude/agents/ boundaries
Team:       /rad-plan            → cuts rad/[feature] branch, commits plan
Architect:  /rad-approve         → Gate 1: records approval on the branch tip
Team:       /rad-deliver         → wave execution, opens the deliver PR (Gate 2)
Architect:  PR review            → merge to the default branch
```

This is a *shaping* step. It does **not** generate plans, call `/rad-research`
or `/rad-plan`, commit, open a PR, or flip any approval status. The architect
reviews, edits, signs off, and commits the artifact manually.

---

## When to run it

Run `/rad-epic-decompose` when you have a GitHub **epic** — a large parent
issue whose work spans several child issues — and you need to understand and
sequence the children before any one of them is planned.

You do **not** need it for a single, self-contained issue. For that, go
straight to `/rad-research` (or `/rad-adopt` for a pre-existing issue). Epic
decomposition earns its keep only when there are multiple children to scope and
order relative to one another.

It is architect-only. The command gates on `scripts/check-role.sh architect`
before it fetches anything or reads any context.

---

## Why it exists

Planning children of an epic one at a time, with no shared read on the whole,
leads to drift: overlapping scope, missed dependencies, and ordering surprises
discovered mid-delivery. Gate 0 front-loads that thinking into one artifact:

- Each child is scoped (what, why, acceptance criteria, affected domains).
- Each child gets a *recommended* plan structure — a sketch only, not a real
  plan file.
- The epic-level rollup captures execution order, cross-cutting concerns, and
  epic-wide open questions.
- An architect sign-off checklist records when shaping is actually complete.

The output is `.agents/epics/epic-[N]-[slug].md` (where `N` is the epic issue
number and `slug` is the kebab-case epic title), written with `Status: draft`.
`.agents/epics/` is the artifact home for this step.

---

## How to run it

```
/rad-epic-decompose 42
/rad-epic-decompose #42
/rad-epic-decompose https://github.com/org/repo/issues/42
```

The argument is the epic issue number or URL. With no argument, the command
stops and prints usage.

What it does:

1. **Verifies authority** — gates on the architect role before any fetch or read.
2. **Fetches the epic and its children** from GitHub via `scripts/fetch-epic.sh`.
3. **Reads project context** for grounding — `CLAUDE.md`, `.agents/architecture/`,
   and 3–5 recent `.agents/plans/*.md` (for plan shape only).
4. **Composes the artifact** — a story section per child plus an epic-level rollup.
5. **Writes** `.agents/epics/epic-[N]-[slug].md` with `Status: draft`.
6. **Optionally mirrors issue labels** — only when `RAD_UPDATE_ISSUES=true`
   (default OFF; best-effort, never fails the command).
7. **Prints a summary** of what was written and the next steps.

---

## The sign-off loop

The artifact is discovery, not a decision. After it is written:

1. **Review and edit** the artifact. Tighten each child's scope, fix the
   recommended plan sketches, and resolve open questions as you go.
2. **Tick the architect sign-off checklist** at the epic level as each item is
   genuinely settled (children scoped, execution order confirmed, cross-cutting
   concerns addressed, open questions resolved, ready to plan the first child).
3. **Commit it yourself** when satisfied — the command never auto-commits, never
   pushes, never opens a PR, and never sets any approval status. The architect
   owns the commit and the sign-off.
4. **Plan the first child** with `/rad-plan` once shaping is complete.

Because the command does no committing and flips no status, re-running it on
the same epic simply rewrites the draft artifact — your committed edits live in
git history, not in the command's behavior.

---

## v1 limitation: GitHub only

Epic decomposition is **GitHub-only for v1**. `scripts/fetch-epic.sh` uses the
`gh` CLI (and `jq`) to fetch the epic and its children, and exits non-zero with
a clear message on any other platform or if `gh`/`jq` are missing. There is no
GitLab, Bitbucket, or Forgejo path yet — the epic/child relationship model is
GitHub-specific in this release. (The `RAD_PLATFORM` environment variable exists
only for testing the platform gate; do not rely on it to enable another
platform.)

If the fetch script fails, the command surfaces its message and stops — it never
fabricates epic or child data.
