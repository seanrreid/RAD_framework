# Findings Log

`.agents/findings.jsonl` is a append-only JSONL file populated by `/rad-review`.
Each line is a JSON record of one of two types.

## Record Types

### Finding record

One per finding from quality-reviewer or accessibility-reviewer:

```json
{
  "type": "finding",
  "cycle_id": "auth-refresh-2026-05-25",
  "feature": "auth-refresh",
  "date": "2026-05-25",
  "reviewer": "quality-reviewer",
  "priority": "HIGH",
  "category": "security",
  "file": "src/auth/token.ts",
  "line": 42,
  "issue": "Hardcoded API key in token refresh function",
  "wcag": null
}
```

Accessibility findings include a `wcag` criterion string (e.g. `"2.1.1"`); quality findings set `wcag` to `null`.

### Cycle record

One per `/rad-review` run, written after all finding records for that run:

```json
{
  "type": "cycle",
  "cycle_id": "auth-refresh-2026-05-25",
  "feature": "auth-refresh",
  "date": "2026-05-25",
  "outcome": "NEEDS_FIXES_FIRST",
  "high": 3,
  "medium": 5,
  "low": 2
}
```

## Querying

```bash
# All HIGH findings
jq 'select(.type=="finding" and .priority=="HIGH")' .agents/findings.jsonl

# Category frequency
jq -r 'select(.type=="finding") | .category' .agents/findings.jsonl | sort | uniq -c | sort -rn

# Cycle history
jq 'select(.type=="cycle")' .agents/findings.jsonl
```

Run `/rad-insights` for a full pattern analysis report.

## Rules

- Never delete or modify existing records
- Never write to this file manually — it is maintained by `/rad-review`
