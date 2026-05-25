---
description: >
  Analyze finding patterns across RAD review cycles. Reads .agents/findings.jsonl
  to surface recurring finding categories, hotspot files, and team trajectory.
  Run any time to get a population-level view of review history.
---

# /rad-insights

Analyze finding patterns across all recorded RAD review cycles.

## Input

`$ARGUMENTS` (optional): `--since YYYY-MM-DD` to limit analysis to cycles on or after
that date.

---

## Process

### Step 1: Check for findings log

```bash
if [ ! -f .agents/findings.jsonl ]; then
  echo "No findings log found. Run /rad-review on at least one deliver branch first."
  exit 0
fi
```

Count records to determine report depth:

```bash
# Total cycles
jq -r 'select(.type=="cycle")' .agents/findings.jsonl | jq -s 'length'

# Total findings
jq -r 'select(.type=="finding")' .agents/findings.jsonl | jq -s 'length'
```

If fewer than 3 cycles exist, note the limited data and output a raw findings list
instead of a pattern report.

### Step 2: Apply date filter (if --since provided)

```bash
# Filter findings to on/after the provided date
jq -r --arg since "[DATE]" 'select(.date >= $since)' .agents/findings.jsonl
```

### Step 3: Compute finding frequencies

```bash
# Category frequency (all priorities)
jq -r 'select(.type=="finding") | .category' .agents/findings.jsonl \
  | sort | uniq -c | sort -rn

# HIGH findings by category
jq -r 'select(.type=="finding" and .priority=="HIGH") | .category' .agents/findings.jsonl \
  | sort | uniq -c | sort -rn

# Finding frequency per file (top 10)
jq -r 'select(.type=="finding") | .file' .agents/findings.jsonl \
  | sort | uniq -c | sort -rn | head -10

# Findings by reviewer
jq -r 'select(.type=="finding") | .reviewer' .agents/findings.jsonl \
  | sort | uniq -c | sort -rn
```

### Step 4: Compute cycle outcomes and trajectory

```bash
# Outcomes distribution
jq -r 'select(.type=="cycle") | .outcome' .agents/findings.jsonl \
  | sort | uniq -c

# HIGH count per cycle over time (for trajectory)
jq -r 'select(.type=="cycle") | [.date, .feature, (.high|tostring)] | join("\t")' \
  .agents/findings.jsonl | sort
```

### Step 5: Synthesize and output report

Using the data from Steps 3–4, write the following report. Populate each section
with real numbers and real pattern names — do not leave placeholders.

```markdown
## RAD Insights — Pattern Analysis
Cycles analyzed: [N]  |  Date range: [earliest date] → [latest date]
[If --since filter applied: "Filtered to: [since date] → present"]

### Recurring Finding Patterns
[Rank by cycles affected, descending. For each pattern:]
[N]. [category name] — [X]/[total] cycles ([Y]%) — typically [priority]
   Reviewer: [quality-reviewer | accessibility-reviewer | both]
   [If WCAG category: WCAG criterion: [N.N.N]]

[If fewer than 3 patterns: "Not enough cycles for reliable pattern detection.
  Findings so far: [list raw findings]"]

### Hotspot Files
[Top files by total finding count. Omit if fewer than 2 cycles.]
- [file path] — [N] findings ([category breakdown])

### Cycle Outcomes
READY FOR ARCHITECT REVIEW: [N] cycles
NEEDS FIXES FIRST: [N] cycles

### Team Trajectory
[HIGH findings per cycle in chronological order. Group by month if ≥ 6 cycles.]
[date]  [feature]  HIGH: [N]  MEDIUM: [N]  LOW: [N]
...
[If trend is detectable: "Trend: [↓ improving | ↑ increasing | → stable]"]

### Recommended Focus Areas
[Top 2–3 patterns that are both frequent and high-severity. Each as one sentence:
 "Address [category] — appears in [N] cycles ([%]) and always blocks architect review."]
```

---

## Rules

- Never modify `.agents/findings.jsonl` — read only
- If the file is missing or empty, say so and exit cleanly
- If fewer than 3 cycles exist, skip pattern analysis and output raw findings
- Do not invent patterns — only report what the data shows
- Hotspot file paths should be exact as recorded in the log
