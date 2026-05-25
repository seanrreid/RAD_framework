# Plans Directory

Plan artifacts live here. Created by `/rad-plan`, executed by `/rad-deliver`.

## Naming

```
[kebab-case-feature-name].md         ← feature plans
```

## Status values

| Status | Meaning |
|--------|---------|
| `pending-review` | Plan PR open, awaiting architect merge |
| `approved` | Plan branch merged — ready to execute |
| `in-progress` | /rad-deliver running |
| `complete` | All tasks done, code PR open |
| `blocked` | Execution stopped, needs architect |
