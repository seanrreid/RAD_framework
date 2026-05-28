# Onboarding — New Team Members

Welcome to a project using the RAD framework. This guide gets you from zero
to submitting your first plan PR.

---

## What RAD is (the short version)

RAD is a workflow layer on top of Claude Code that enforces two things:

1. **You plan before you build.** Every feature starts as a plan file that the
   architect reviews before any code is written.

2. **You work within boundaries.** The architect has defined which parts of the
   codebase each role can access. These boundaries are enforced by the agent
   definitions in `.claude/agents/` — not just by convention.

The result: you can work autonomously on your domain without needing to
understand the whole codebase, and the architect can review your approach
before you spend time implementing it.

---

## Setup

### 1. Install Claude Code

If you don't have it:
```bash
npm install -g @anthropic-ai/claude-code
```

Authenticate with your Anthropic account.

### 2. Install the git platform CLI

**GitHub:**
```bash
# macOS
brew install gh && gh auth login

# Linux — see https://cli.github.com/
```

**GitLab:**
```bash
brew install glab && glab auth login
```

### 3. Clone the project and verify RAD is set up

```bash
git clone [repo-url]
cd [repo]

# Check RAD status
claude-code
> /rad-status
```

You should see the platform, agent inventory, and your role in the output.
If you see "No agents defined", the architect needs to run `/rad-research`
then `/rad-design` to set up the agent architecture first.

### 4. Understand your boundaries

Read `CLAUDE.md`, specifically the Agent Scope Map section. It shows:
- Which agents are available to your role
- Which directories each agent can read
- Which domains are architect-only

You can only plan and execute work within your role's boundaries. If a feature
requires something outside your scope, flag it in the plan as an out-of-scope
dependency — don't try to work around it.

---

## Your first feature

### Step 1: Check current status

```
/rad-status
```

See what's in progress, what's waiting for architect review, and whether any
plans are approved and ready to execute.

### Step 2: Plan your feature

```
/rad-plan [describe what you want to build]
```

This will:
- Research the relevant parts of the codebase (within your boundaries)
- Generate a wave-structured plan
- Open a draft PR for architect review

You'll see a PR URL at the end. Share it with the architect.

### Step 3: Wait for plan approval

The architect reviews your plan PR. They may:
- **Merge it** — you're approved to execute
- **Request changes** — update the plan file and push
- **Close it** — the approach needs rethinking; they'll explain why

Don't start executing until the plan PR is merged.

### Step 4: Execute the plan

```
/rad-deliver .agents/plans/[your-feature].md
```

This runs your plan wave by wave. Watch for failures — if a task fails twice,
stop and leave a comment on the plan PR rather than pushing through.

### Step 5: Self-review

```
/rad-review
```

Run this before asking the architect to look at your code PR. Fix any HIGH
priority issues it finds. Leave MEDIUM/LOW issues as notes in the PR.

### Step 6: Request architect review

The deliver PR is already open (created by `/rad-deliver`). Comment on it to
let the architect know it's ready for review.

---

## What to do when you're blocked

**Your plan PR has been waiting a while:**
Ping the architect directly — plan PRs should be fast to review.

**A task failed during execution and you can't fix it:**
Leave a comment on the plan PR: what failed, what you tried, what the error was.
Do not force through a failing task.

**The feature requires something outside your scope:**
Update the plan to flag it as an out-of-scope dependency. Comment on the plan
PR asking the architect how to proceed. Do not read files outside your scope.

**You're not sure if something is in your scope:**
Run `/rad-status` and check the Agent Scope Map. When in doubt, ask — it's
faster than fixing a scope violation in review.

---

## Common mistakes

**Running /rad-deliver before the plan PR is merged.**
`/rad-deliver` will stop you with an error. Wait for the merge.

**Reading files directly during planning.**
`/rad-plan` delegates research to an Explore sub-agent — you don't read files
yourself during the planning phase. The sub-agent returns a bounded summary
that stays within your role's scope boundaries. If something needed isn't
covered, it's likely out of scope — flag it as a dependency, don't work around it.

**Skipping /rad-review before requesting architect review.**
The architect will find the same issues and send you back to fix them. Save
the round-trip.

**Making the plan too large.**
If your plan has more than 5 waves or touches more than ~12 files, split it
into two plans. Smaller plans are faster to review, easier to execute, and
easier to debug when something goes wrong. The linter enforces a context
budget on the Files in Scope table — if it errors on budget, you must split
before the plan can be approved.
