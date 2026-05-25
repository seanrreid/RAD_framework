# Applying RAD to an Existing Project

For projects with no prior rpi-design architecture. Expect 2–3 weeks of
gradual rollout rather than 3 days. The extra time is spent on archaeology,
accurate CLAUDE.md authoring, and agent validation against the real codebase.

If your project was built with rpi-design, see `migration-from-rpi.md` instead.

---

## Why this takes longer

On a greenfield or non-rpi project, you're working backward: generating
an architecture from a codebase that already exists, rather than building
a codebase from an architecture you designed. The risks are:

- **Wrong boundaries** — rpi-design's interview generates scopes from what
  you describe. If your description doesn't match the real directory structure,
  the agent scopes will be wrong and the team will hit them immediately.
- **Stale CLAUDE.md** — writing CLAUDE.md from memory produces a document
  full of what you think is true, not what is true. Claude will make wrong
  assumptions and the team will spend sessions correcting them.
- **Workflow resistance** — a team with existing habits will resist more
  ceremony unless they understand why it's there. Gradual rollout with
  visible wins is more effective than a big-bang migration.

The three-week sequence addresses all three.

---

## Week 1 — Archaeology and architecture (architect only)

The team keeps working normally. You do not introduce RAD yet.

### Step 1: Audit the real codebase

Before the rpi-design interview, understand what you actually have.

```bash
# Real directory structure
find . -type d | grep -v node_modules | grep -v .git | grep -v __pycache__ | sort

# What's actually changing (hot spots)
git log --oneline --since="3 months ago" --stat | grep "|" | \
  awk '{print $1}' | sort | uniq -c | sort -rn | head -20

# Who touches what (coordination zones)
git shortlog -sn --since="3 months ago"

# File-level ownership
git log --format="%ae" --since="3 months ago" -- src/ | sort | uniq -c | sort -rn
```

Pay attention to:
- Files changed by multiple people frequently → high coordination, tighter boundaries
- Files nobody has touched → low risk, broader scope is fine
- Directories that span multiple domains → boundary decisions to make explicit

### Step 2: Run /rad-design

```
/rad-design
```

Answer the research questions based on what the audit revealed, not what you
remember or wish were true. The most important answers:

- **Domains**: what are the real domain boundaries in the code, not the
  conceptual ones in your head
- **Structure**: the actual directories, not the intended ones
- **Common tasks**: what the team actually does most often, not what they should do
- **Unusual constraints**: legacy decisions, external dependencies, compliance rules

When the draft architecture is generated, validate each proposed scope against
the real directory structure:

```bash
# For each proposed scope, verify it exists
ls src/ui/        # does this exist?
ls src/components/ # or is it here?
find . -name "*.tsx" | head -5  # what's the real pattern?
```

Request changes to the draft until the scopes match reality.

### Step 3: Validate agents solo for one week

Install the generated agents. Use them yourself on real tasks for a week
before the team sees them.

Run `/rad-plan` on something real. Go through the full loop. Look for:

**Scope mismatches**: agent says it reads `src/components` but the relevant
files are in `src/features/*/components`. Fix the agent scope.

**Useless tool output**: a context tool that reads a minified file, a
generated schema, or a file with 2000 lines where 15 lines tells you nothing.
Add a `Scope` note to the agent's Rules section specifying which file patterns
to skip.

**Missing domains**: a feature that obviously spans two domains but neither
orchestrator can handle it alone. Either add a new orchestrator or adjust
the boundary.

**Architect-only misclassification**: an agent marked `architect` that a
developer actually needs for routine work. Demote it to `developer`.

Fix issues in the `.claude/agents/*.md` files directly. This week of solo
validation is the highest-leverage time investment in the whole migration.

### Step 4: Write an accurate CLAUDE.md

Write CLAUDE.md last — after the audit, not before. Verify every fact:

```bash
# Stack and versions — verify, don't guess
node --version && npm --version
python --version
cat package.json | python3 -m json.tool | grep '"version"' | head -10
cat requirements.txt

# Run commands — copy from package.json/Makefile, don't paraphrase
cat package.json | python3 -m json.tool | grep -A 20 '"scripts"'
cat Makefile | grep -E "^[a-z]" | head -20

# Project structure — generate from reality
find . -maxdepth 3 -type d | grep -v node_modules | grep -v .git | sort

# Test commands — run them to verify they work
npm test -- --passWithNoTests 2>&1 | tail -5
```

The rule: if you can't verify it from the codebase right now, don't put it
in CLAUDE.md. A blank section is harmless. A wrong section causes correction
loops in every session.

---

## Week 2 — Pilot with one person

Choose your most technically capable developer. Do not announce RAD to the
full team yet.

### Step 1: Synchronous walkthrough

30 minutes, one-on-one. Show them:
- What RAD is and why you're introducing it
- Their agent boundaries (what they can and can't access)
- The full loop: `/rad-plan` → plan PR → you review → merge → `/rad-deliver` → code PR
- What you look for in a plan PR (be specific — show the review checklist)
- How fast you'll turn around plan PRs (commit to a number: "within 4 hours during work hours")

### Step 2: First plan PR together

Pick a real feature they were going to work on anyway. Walk through
`/rad-plan` together. Let them drive, you observe. When the plan PR opens,
review it synchronously — talk through what you're checking and why.
Merge it together.

Then let them run `/rad-deliver` solo. Check in when the code PR opens.

### Step 3: Solo feature

Let them run the next feature entirely solo. Review the plan PR asynchronously.
Give feedback on the plan (not just approval/reject — explain what could
be more precise).

### Step 4: Assess and adjust

After two features with the pilot developer:
- Are the agent scopes correct? Did they hit any boundaries that shouldn't exist?
- Is the plan PR turnaround working? Are they blocked waiting?
- Is the wave structure producing good execution? Any task failures?
- What confused them?

Fix issues before rolling out to the full team.

---

## Week 3 — Full team rollout

### Step 1: Team session (45–60 minutes)

Present RAD to the full team. Frame it as solving a problem they've probably
experienced — context rot, Claude going off-track in long sessions, code that
diverges from what was planned.

Show the pilot developer's plan PRs as examples. Let them speak to the
experience — peer testimonial is more credible than architect advocacy.

Cover:
- What changes about their workflow (plan PRs are new, commands rename slightly)
- What doesn't change (the mental model, the phase discipline, the plan format)
- Their specific boundaries (show the Agent Scope Map from CLAUDE.md)
- The onboarding doc location (`docs/onboarding.md`)

### Step 2: Onboard one at a time

Don't onboard everyone at once. Stagger by one person per day if possible.
Each person should:
1. Read `docs/onboarding.md`
2. Run `/rad-status` to verify their setup
3. Do their first `/rad-plan` with you available to answer questions

### Step 3: Tighten based on early feedback

The first week of full-team operation will surface remaining issues:
- Scope boundaries that need adjustment
- CLAUDE.md facts that are wrong or missing
- Wave structure confusion (most teams default to everything sequential at first)
- Plan PR turnaround bottlenecks

Treat this week as calibration, not failure. Fix issues in the agent files
and CLAUDE.md as they surface. Commit each fix immediately.

---

## Common issues on existing projects

### "The agents reference paths that don't exist"

Your rpi-design interview described an idealized structure. Run the audit
commands from Week 1 and update the agent scope to match reality.

### "Claude keeps doing things it shouldn't"

CLAUDE.md is wrong or incomplete. Find the specific wrong fact, verify the
correct one against the codebase, fix it, commit.

### "The plan PRs are slowing us down"

Your turnaround is too slow. Plan PRs should be 5–10 minutes to review —
they're one markdown file. If reviews take longer, the plans are too large
(ask for splits) or too vague (request changes rather than approving).

If you genuinely can't review plan PRs within 4 hours during work hours,
the gate model is wrong for your situation. Consider async approval (Slack
message instead of PR) or delegating Gate 1 to a senior developer.

### "Nobody is using the wave structure correctly"

Everything ends up in one sequential wave. Share `docs/wave-execution.md`
and add a plan PR review checklist item: "Could any tasks in the same wave
run in parallel?" For the first month, give explicit wave feedback on every
plan PR even if you otherwise approve it.

### "A developer needs access to something outside their scope"

Don't expand scope broadly. Follow the options in `docs/architect-guide.md`:
handle it yourself, create a targeted context tool that returns only what
they need, or expand scope narrowly with documented justification.

---

## What success looks like at 30 days

- Plan PRs are opened within a few hours of a feature being started
- Plan PR reviews take under 10 minutes and are turned around same day
- `/rad-deliver` runs cleanly on approved plans without scope violations
- CLAUDE.md is being updated when new facts are discovered
- The team is catching their own scope issues in `/rad-review` before
  you see them in code review
- Context rot complaints have dropped (sessions stay focused)

If you're not seeing this at 30 days, the bottleneck is usually one of:
plan PRs taking too long to review, agent scopes that don't match reality,
or a CLAUDE.md that hasn't been maintained. Check those three before
assuming the framework isn't working.
