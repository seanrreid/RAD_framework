---
description: >
  Show current RAD framework status: platform detection, active plans,
  open PRs, agent inventory, and role configuration. Use PROACTIVELY when
  starting a session or checking team progress.
---

# /rad-status

Show a snapshot of the RAD framework state for this project.

---

## Process

### 1. Platform detection

```bash
PLATFORM=$(scripts/detect-platform.sh --quiet)
echo "Platform: $PLATFORM"
```

### 2. Agent inventory

```bash
ls .claude/agents/*.md 2>/dev/null | wc -l
```

For each agent file, extract: name, type (from description), roles.

### 3. Active plans

Scan `.agents/plans/` for plan files. For each, extract:
- Feature name
- Status field
- PR URL
- Author role
- Wave count

### 4. Open PRs (if platform CLI available)

**GitHub:**
```bash
gh pr list --label "rad:plan" --state open --json title,url,author,createdAt
gh pr list --label "rad:deliver" --state open --json title,url,author,createdAt
```

**GitLab:**
```bash
glab mr list --label "rad:plan" --state opened
glab mr list --label "rad:deliver" --state opened
```

### 5. Recent execution logs

```bash
ls -t .agents/logs/*.md 2>/dev/null | head -5
```

For each, extract: feature, date, task counts, status.

### 6. Output the status report

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RAD Status — [project name]
[timestamp]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Platform:  [github | gitlab | ...] [✓ CLI available | ⚠ manual mode]
Agents:    [N] defined in .claude/agents/
Branch:    [current branch]

── Active Plans ───────────────────────

[feature-name]
  Status: pending-review
  PR:     [url]
  Author: [role]
  Waves:  [N], Tasks: [N]

[feature-name]
  Status: approved — ready to execute
  Run:    /rad-deliver .agents/plans/[feature].md

── Open PRs ────────────────────────── [if CLI available]

Plan PRs (awaiting architect review):
  • [title] — [url] — opened [date]

Deliver PRs (awaiting architect merge):
  • [title] — [url] — opened [date]

── Recent Executions ───────────────────

  • [feature] — [date] — [N] tasks complete
  • [feature] — [date] — [N] tasks, 1 failed

── Agent Scope ─────────────────────────

[render the Agent Scope Map from CLAUDE.md]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If no plans exist yet:
```
No plans found. Run /rad-plan [feature] to create the first plan.
```

If agents directory is empty:
```
⚠ No agents defined. Run /rad-design (architect only) to generate the
  agent architecture before the team can begin planning.
```
