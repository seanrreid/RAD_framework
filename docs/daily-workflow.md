# Daily Workflow

How the team uses RAD day-to-day. The full loop for any feature:

```
Anyone:     /rad-research [prd or issue]  ← once per project setup
Architect:  /rad-design [slug]            ← once per project setup

Developer:  /rad-plan [feature]    ← opens plan PR
Architect:  [reviews plan PR]      ← Gate 1: approach approval
Architect:  [merges plan PR]       ← unlocks execution

Developer:  /rad-deliver [plan]    ← wave execution, opens code PR
Developer:  /rad-review            ← self-review before requesting architect review
Architect:  [reviews code PR]      ← Gate 2: implementation approval
Architect:  [merges code PR]       ← feature ships
```

---

## Starting a new project

Project setup is a two-step process. Either step can be done by anyone on
the team, but `/rad-design` is typically run by whoever holds the architect role.

### Step 1: Research

```
/rad-research [path-to-prd or issue-url]
```

Point it at your PRD, a GitHub/GitLab issue, or paste a spec inline.
It asks a few RAD-specific clarifying questions — team roles, platform,
domain sensitivity — and writes `.agents/research/[slug].md`.

### Step 2: Design

```
/rad-design [slug]
```

Reads the research artifact and drafts the agent hierarchy to
`.agents/architecture/[slug].md` with `Status: draft`. Review the draft,
edit role assignments or scope boundaries as needed, then change the status
to `approved` and re-run `/rad-design [slug]` to generate the agent files.

Then install the agents into the project:

```bash
cp -r .claude/agents/ /path/to/project/.claude/agents/
```

Commit the agent files and the research/architecture artifacts. They are the
architecture — they belong in version control.

---

## Planning a feature (developer or designer)

```
/rad-plan Add skeleton loading to the habit list
```

This will:
1. Spawn an Explore sub-agent to research the codebase within your role's scope,
   returning a bounded `RESEARCH_SUMMARY` (no raw file reads in your main context)
2. Generate a wave-structured plan from the summary
3. Commit the plan to `plan/[feature-name]`
4. Lint the plan — checks structure, wave limits, and context budget
5. Open a draft PR with the plan as a reviewable checklist

Then wait. Do not run `/rad-deliver` until the architect runs `/rad-approve`.

---

## Adopting a pre-existing issue (developer, designer, or architect)

For work that existed before RAD was introduced:

```
/rad-adopt #42
/rad-adopt https://github.com/org/repo/issues/42
/rad-adopt "Fix login timeout not resetting on user activity"
```

This fetches the issue context (or uses your description), researches the
codebase, and generates a wave-structured plan — same format as `/rad-plan`.
An `## Issue Gaps` section captures assumptions made where the issue was vague.

The plan goes through `/rad-approve` before execution, same as any other plan.

**What makes a good plan PR:**
- File references are real (architect will check)
- Steps are specific enough to execute without interpretation
- Wave structure is correct — independent tasks in the same wave
- Non-goals are listed — they prevent scope creep during execution
- Out-of-scope dependencies are flagged, not worked around

---

## Reviewing a plan PR (architect)

This is Gate 1. You're approving the *approach*, not the code.

Check:
- [ ] File references exist and are in the right domain
- [ ] Steps are specific enough — vague steps produce vague code
- [ ] Wave structure makes sense — nothing parallelized that has a dependency
- [ ] All changes are within the contributor's agent scope
- [ ] Non-goals are realistic — they prevent the right things
- [ ] Out-of-scope dependencies are acknowledged

If something is wrong: request changes on the PR. The contributor updates
the plan file, pushes, and you re-review. Merge when satisfied.

**Merging the plan PR = approval to execute.** This is the gate.

---

## Executing the plan (developer or designer)

```
/rad-deliver .agents/plans/add-skeleton-loading.md
```

This checks the plan is approved, creates a `deliver/[feature]` branch, and
executes the plan wave by wave. Each wave runs in a fresh sub-agent context —
the orchestrator only carries `WAVE_RESULT` summaries forward, not file contents.
Each task gets its own commit. Each completed step is logged in `.agents/logs/`.

**During execution:**
- Between waves, the orchestrator outputs a completion summary — review it
  before the next wave starts
- If a wave fails, stop and fix before continuing — don't push through
- Context rot is rare because wave sub-agents keep main context lean, but can
  still happen during repeated correction loops. If it does: start a new Claude
  Code session and re-run `/rad-deliver` with the same plan file — it resumes
  from the execution log.

---

## Self-review before requesting architect review (developer)

```
/rad-review
```

Run this after `/rad-deliver` completes. It checks:
- All changed files were in the plan's scope
- Implementation matches the plan
- Conventions from `CLAUDE.md` are followed
- All tests from the plan were written

Fix any HIGH priority issues before requesting architect review.
MEDIUM and LOW issues can be noted but don't block the PR.

---

## Reviewing the code PR (architect)

This is Gate 2. You're reviewing the *implementation*.

Standard code review, plus RAD-specific checks:
- [ ] Self-review was run (check for `/rad-review` output in PR comments)
- [ ] All changes are within the plan's declared scope
- [ ] Execution log looks clean — no surprise retries or failures
- [ ] Tests are present and test behavior, not implementation

Merge when satisfied. The feature ships.

---

## When things go wrong

**Plan PR gets change requests:**
The contributor updates `.agents/plans/[feature].md` directly, pushes to
the plan branch, and the PR updates automatically.

**A task fails during /rad-deliver:**
Do not retry more than twice. On the third failure, stop. Leave a comment on
the plan PR describing the failure. The architect decides whether to update
the plan or take over the blocked task.

**Out-of-scope dependency discovered mid-execution:**
Stop execution. Comment on the deliver PR describing the dependency. The
architect either expands the plan or handles the dependency separately.

**Context gets noisy during execution:**
Wave sub-agents keep the orchestrator's context lean during normal execution.
If noise does accumulate (usually from repeated correction loops on a failing
task), start a new Claude Code session and run
`/rad-deliver .agents/plans/[feature].md` again — it resumes from the execution log.

---

## /rad-status — the team dashboard

```
/rad-status
```

Run this at the start of any session to see:
- Which plans are pending architect review
- Which plans are approved and ready to execute
- Which deliver PRs are open
- Recent execution history

Useful for the architect to see team progress without asking.

---

## /rad-insights — review pattern analysis

```
/rad-insights
```

Reads the accumulated findings from every `/rad-review` run and surfaces
patterns across cycles:
- Which finding categories keep recurring (security, error-handling, accessibility)
- Which files attract the most findings
- Whether HIGH findings per cycle are trending up or down over time
- What to address systematically vs. what was a one-off

Optionally filter to a recent window:

```
/rad-insights --since 2026-04-01
```

Run this periodically — monthly is a reasonable cadence, or after a stretch of
fast-paced delivery. Useful for both the architect (spotting architectural debt)
and developers (seeing where to invest in skill improvement).

Findings accumulate automatically as long as `/rad-review` is run on each
deliver branch. No separate setup required.
