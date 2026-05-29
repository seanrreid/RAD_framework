# Plans Directory

Plan artifacts live here. Created by `/rad-plan`, executed by `/rad-deliver`.

Each plan lives on its feature's `rad/[feature]` work branch — `/rad-plan` cuts
that branch from the default branch and commits the plan doc to it. The plan
doc's `Branch:` header records the branch name. There is no plan PR: the plan
reaches the default branch later, together with the code, through the single
deliver PR. Read a plan at its branch tip (e.g. via `scripts/checkout-plan.sh`).

## Naming

```
[kebab-case-feature-name].md         ← feature plans
```

## Status values

| Status | Meaning |
|--------|---------|
| `pending-review` | Plan committed to its `rad/[feature]` branch, awaiting `/rad-approve` |
| `approved` | `/rad-approve` recorded approval at the branch tip — ready to execute |
| `in-progress` | /rad-deliver running |
| `complete` | All tasks done, deliver PR open |
| `blocked` | Execution stopped, needs architect |
