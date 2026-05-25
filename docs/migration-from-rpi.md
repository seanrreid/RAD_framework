# Migration from RPI

If your project already uses the rpi-design architecture and practitioner
template, migrating to RAD is a targeted 3-day process. Most of the hard
work is already done.

---

## What you already have

| Asset | Status | Notes |
|-------|--------|-------|
| `.claude/agents/*.md` | ✅ Done | Boundaries match real codebase |
| `.agents/plans/` history | ✅ Done | Reusable as reference patterns |
| `CLAUDE.md` | ✅ Done | Verified against actual code |
| Phase discipline | ✅ Done | Team understands plan-before-execute |
| Context tool scopes | ✅ Done | Information boundaries enforced |
| Role annotations | ❌ Missing | RAD-specific addition |
| Wave structure in plans | ❌ Missing | New plan format |
| PR gate workflow | ❌ Missing | Core RAD addition |
| Branch naming convention | ❌ Missing | Needed for approval scripts |
| Platform CLI + labels | ❌ Missing | Needed for PR automation |

---

## Day 1 — Mechanical setup

### 1. Add role annotations to agent files

Open each `.claude/agents/*.md` and add a `roles:` field to the frontmatter.

Default assignments:
- UI, frontend, content, styling agents → `[developer, designer]`
- API, backend, data agents → `[developer]`
- Auth, payments, infra, database agents → `[architect]`
- Parent orchestrator → `[architect]`

```yaml
# Before
---
name: ui-orchestrator
description: Coordinates UI tasks...
model: claude-sonnet-4-6
tools: Task
---

# After
---
name: ui-orchestrator
description: Coordinates UI tasks...
model: claude-sonnet-4-6
tools: Task
roles: [developer, designer]
---
```

Adjust defaults to match your actual team. Commit when done:

```bash
git add .claude/agents/
git commit -m "chore(agents): add RAD role annotations"
```

### 2. Update CLAUDE.md

Add the RAD Configuration section (copy from the RAD framework `CLAUDE.md`
template). Fill in:

```
platform: github          # or gitlab, bitbucket, forgejo, manual
default_branch: main
architect: [your-username]
developers: [usernames]
designers: [usernames]
```

Paste the Agent Scope Map — generate it from your existing agents:

```bash
# Quick scope map from existing agent files
for f in .claude/agents/*.md; do
  name=$(grep "^name:" "$f" | cut -d' ' -f2)
  roles=$(grep "^roles:" "$f" | cut -d'[' -f2 | tr -d ']')
  echo "| $name | ... | ... | $roles |"
done
```

Commit:
```bash
git add CLAUDE.md
git commit -m "docs: add RAD configuration to CLAUDE.md"
```

### 3. Install RAD scripts

```bash
cp -r /path/to/rad-framework/scripts/ ./scripts/
chmod +x scripts/*.sh
git add scripts/
git commit -m "chore: add RAD platform scripts"
```

### 4. Install RAD commands

Replace the practitioner template commands with RAD commands:

```bash
# Team commands (committed to repo)
cp /path/to/rad-framework/.claude/commands/team/* .claude/commands/
cp /path/to/rad-framework/.claude/commands/shared/* .claude/commands/

# Architect commands (your machine only — not committed)
cp /path/to/rad-framework/.claude/commands/architect/* ~/.claude/commands/

git add .claude/commands/
git commit -m "chore: install RAD commands"
```

### 5. Set up platform labels and branch protection

**GitHub:**
```bash
gh label create "rad:plan" --color "0075ca" --description "RAD plan PR"
gh label create "rad:pending-review" --color "e4e669" --description "Awaiting architect review"
gh label create "rad:deliver" --color "0e8a16" --description "RAD delivery PR"
gh label create "rad:changes-requested" --color "d93f0b" --description "Changes requested"

# Restrict main to architect merges only (optional but recommended)
gh api repos/:owner/:repo/branches/main/protection \
  --method PUT \
  --field required_pull_request_reviews='{"required_approving_review_count":1}'
```

**GitLab:**
```bash
glab label create "rad:plan" --color "#0075ca"
glab label create "rad:pending-review" --color "#e4e669"
glab label create "rad:deliver" --color "#0e8a16"
glab label create "rad:changes-requested" --color "#d93f0b"
```

### 6. Verify

```bash
scripts/detect-platform.sh
# Should output: Detected platform: github (or your platform)
# and confirm CLI is available
```

In Claude Code:
```
/rad-status
```

Should show: platform, agent count, role map. No active plans yet — that's expected.

---

## Day 2 — Solo end-to-end run

Run the full loop yourself on a real but low-stakes feature before the team
touches anything. This surfaces any mismatches between the scripts and your
actual platform setup.

```
/rad-plan [small feature you actually want built]
```

Watch the output. Verify:
- Plan file created in `.agents/plans/`
- Branch `plan/[feature]` created and pushed
- Draft PR opened on your platform with correct labels
- PR URL recorded in the plan file

Then review the plan PR as architect. Merge it.

```
/rad-deliver .agents/plans/[feature].md
```

Watch the output. Verify:
- Approval check passes (detects merged plan branch)
- `deliver/[feature]` branch created
- Execution log created in `.agents/logs/`
- Each task committed separately
- Code PR opened at the end

Run `/rad-review`. Check the output looks right.

Fix anything that broke before involving the team.

---

## Day 3 — Team walkthrough

One synchronous session, 30–45 minutes. Focus on the delta from what they
already know — don't re-explain rpi concepts they've internalized.

**The delta:**

| Old (practitioner template) | New (RAD) |
|-----------------------------|-----------|
| `/plan [feature]` | `/rad-plan [feature]` — now opens a PR |
| You review plan file locally | Architect reviews plan PR on GitHub/GitLab |
| `/execute [plan]` | `/rad-deliver [plan]` — checks approval, runs in waves |
| `/review` | `/rad-review` — same, now explicitly pre-PR |

Show them:
1. What a plan PR looks like (open the one from your Day 2 run)
2. What you look for when reviewing (scope, precision, wave structure)
3. How fast you'll turn it around (set expectations explicitly)
4. What happens if they run `/rad-deliver` on an unapproved plan (it stops)

That's the whole session. The mental model is familiar. The new pieces are
the PR gate and the wave format.

---

## Handling existing plan files

Prior `.agents/plans/` files use the flat sequential step format. They still
work as reference material — `/rad-plan` can use them as patterns. You don't
need to reformat them.

If you want to retroactively add wave structure to your most-used plans for
better reference value, it's straightforward — group steps that have no
dependencies on each other into a `parallel` wave, leave sequential steps in
their own waves. An hour of work on your top five plans pays off over time.

---

## Handling in-flight work

Don't retrofit RAD onto features already in progress. Let them complete under
the old workflow. RAD starts on the next feature after migration day.

If a plan file exists for in-flight work, leave it in `.agents/plans/` — it
won't conflict. The `status:` field will be missing the `pending-review` value
RAD expects, so `/rad-deliver` will treat it as unapproved and stop. If you
want to continue that work under RAD, add `status: approved` to the plan file
manually (you're the architect — this is your approval to give).
