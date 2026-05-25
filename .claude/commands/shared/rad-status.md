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

Run the deterministic status script:

```bash
scripts/rad-status.sh
```

The script outputs platform detection, all plan statuses, open PRs (if a
platform CLI is available), recent execution logs, and agent inventory.

After the script output, render the Agent Scope Map from `CLAUDE.md` so the
team can see role boundaries at a glance.
