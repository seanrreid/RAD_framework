# Daily Workflow

How the team uses RAD day-to-day. The full loop for any feature:

```
Anyone:     /rad-research [prd or issue]  ← once per project setup
Architect:  /rad-design [slug]            ← once per project setup

Developer:  /rad-plan [feature]    ← cuts rad/[feature] branch, commits plan (no PR)
Architect:  /rad-approve [feature] ← Gate 1: records approval on the branch tip (no PR)

Developer:  /rad-deliver [plan]    ← wave execution on rad/[feature], opens the deliver PR
Developer:  /rad-review            ← self-review before requesting architect review
Architect:  [reviews deliver PR]   ← Gate 2: implementation approval
Architect:  [merges deliver PR]    ← plan doc + code reach the default branch; feature ships
```

There is one work branch per feature, `rad/[feature]`, cut from the default
branch and carried cradle-to-grave: it holds the plan doc, the recorded
approval, and the code, and it is the head of the single deliver PR. The
retired `plan/[feature]` and `deliver/[feature]` branches are no longer used.
There is no plan PR — the only PR is the deliver PR, which is what keeps
contributors off the protected default branch.

---

## Starting a new project

### Step 1: Install RAD

```bash
git clone https://github.com/seanrreid/RAD_framework /tmp/rad
bash /tmp/rad/install.sh --dir /path/to/your-project
```

This copies all commands, scripts, and directory structure into your project.
See [INSTALL.md](../INSTALL.md) for the full guide including post-install
platform setup and label creation.

Commit the installed files before proceeding:

```bash
git add .claude/ .agents/ scripts/ CLAUDE.md
git commit -m "chore: install RAD framework"
```

### Step 2: Research

```
/rad-research [path-to-prd or issue-url]
```

Point it at your PRD, a GitHub/GitLab issue, or paste a spec inline.
It asks a few RAD-specific clarifying questions — team roles, platform,
domain sensitivity — and writes `.agents/research/[slug].md`.

### Step 3: Design

```
/rad-design [slug]
```

Reads the research artifact and drafts the agent hierarchy to
`.agents/architecture/[slug].md` (`Status: draft`), then presents it inline and
asks to **approve / edit / cancel** — all in one invocation:
- **approve** — flips the status to `approved` and generates the agent files into
  `.claude/agents/` in the same run. No manual edit, no re-run.
- **edit** — adjust role assignments or scope boundaries; the draft is revised and
  shown again.
- **cancel** — leave it as a draft and stop; re-run `/rad-design [slug]` later to
  resume.

(Editing `Status: approved` by hand still works — a pre-existing approved artifact
generates directly on the next invocation.)

Commit everything — the generated agents are the architecture:

```bash
git add .claude/agents/ .agents/research/ .agents/architecture/ CLAUDE.md
git commit -m "chore: initialize RAD agent architecture"
git push
```

---

## Planning a feature (developer or designer)

```
/rad-plan Add skeleton loading to the habit list
```

This will:
1. Spawn an Explore sub-agent to research the codebase within your role's scope,
   returning a bounded `RESEARCH_SUMMARY` (no raw file reads in your main context)
2. Generate a wave-structured plan from the summary, including `## Scope` and
   `## Acceptance Criteria` sections (each wave task's `Validate:` cites an `AC#N`)
3. Cut the `rad/[feature]` work branch from the default branch and record it in
   the plan doc's `Branch:` header field
4. Commit the plan to the `rad/[feature]` branch
5. Lint the plan — checks structure, wave limits, and context budget

No PR is opened. Then wait. Do not run `/rad-deliver` until the architect runs
`/rad-approve`, which records approval on the branch tip.

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

**What makes a good plan:**
- File references are real (architect will check)
- Steps are specific enough to execute without interpretation
- Wave structure is correct — independent tasks in the same wave
- Acceptance Criteria are concrete, and every wave task's `Validate:` cites an `AC#N`
- Non-goals are listed — they prevent scope creep during execution
- Out-of-scope dependencies are flagged, not worked around

---

## Approving a plan (architect)

This is Gate 1. You're approving the *approach*, not the code. There is no
plan PR — the plan lives on its `rad/[feature]` branch.

```
/rad-approve [feature]
```

Check:
- [ ] File references exist and are in the right domain
- [ ] Steps are specific enough — vague steps produce vague code
- [ ] Wave structure makes sense — nothing parallelized that has a dependency
- [ ] Acceptance Criteria are covered by the waves' `Validate:` citations
- [ ] All changes are within the contributor's agent scope
- [ ] Non-goals are realistic — they prevent the right things
- [ ] Out-of-scope dependencies are acknowledged

If something is wrong: ask the contributor to update the plan file on the
`rad/[feature]` branch and push, then re-review. When satisfied, `/rad-approve`
writes `Status: approved` to the plan doc and commits/pushes it to the
`rad/[feature]` branch tip — never to the default branch. That recorded
approval is the gate that unblocks `/rad-deliver`.

If the architect approved out-of-band (in chat, a meeting, etc.), a
non-architect can record it for them:

```
/rad-approve [feature] --on-behalf-of "Sean Reid" --evidence "approved in #standup 2026-05-29"
```

This records `Approved-By` and `Recorded-By` separately so the proxy is auditable.

---

## Executing the plan (developer or designer)

```
/rad-deliver .agents/plans/add-skeleton-loading.md
```

This checks the plan's approved status at the `rad/[feature]` branch tip, then
executes the plan wave by wave on that same branch (no new branch is cut). Each
wave runs in a fresh sub-agent context — the orchestrator only carries
`WAVE_RESULT` summaries forward, not file contents. Each task gets its own
commit. Each completed step is logged in `.agents/logs/`. When all waves
complete, it opens the single deliver PR (`rad:deliver` label) from
`rad/[feature]` to the default branch — carrying both the plan doc and the code.

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
- Every Acceptance Criterion has coverage
- Conventions from `CLAUDE.md` are followed
- All tests from the plan were written

Fix any HIGH priority issues before requesting architect review.
MEDIUM and LOW issues can be noted but don't block the PR.

---

## Reviewing the deliver PR (architect)

This is Gate 2. You're reviewing the *implementation*. This is the only PR in
the workflow — it brings both the plan doc and the code from `rad/[feature]`
onto the default branch in one reviewed merge.

Standard code review, plus RAD-specific checks:
- [ ] Self-review was run (check for `/rad-review` output in PR comments)
- [ ] All changes are within the plan's declared scope
- [ ] Execution log looks clean — no surprise retries or failures
- [ ] Tests are present and test behavior, not implementation

Merge when satisfied. The feature ships.

---

## When things go wrong

**A plan needs changes before approval:**
The contributor updates `.agents/plans/[feature].md` directly and pushes to
the `rad/[feature]` branch. The architect re-reviews and runs `/rad-approve`
when satisfied.

**A task fails during /rad-deliver:**
Do not retry more than twice. On the third failure, stop. Tell the architect
(the deliver PR may not exist yet). The architect decides whether to update
the plan on the `rad/[feature]` branch or take over the blocked task.

**Out-of-scope dependency discovered mid-execution:**
Stop execution. Describe the dependency to the architect (comment on the
deliver PR if it is already open). The architect either expands the plan or
handles the dependency separately.

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
- Which plans are pending architect approval
- Which plans are approved and ready to execute
- Which deliver PRs are open
- Recent execution history

Useful for the architect to see team progress without asking.

For a richer start-of-session ritual, run `/kickoff`: it reads `CLAUDE.md`,
guards against working on the default branch, and reports plans by status from
the `rad/` branch tips. At the end of a session, run `/wrap` to update any plan
statuses that changed, append a dated progress note, and flag uncommitted work.

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
`rad/[feature]` branch before the deliver PR. No separate setup required.
