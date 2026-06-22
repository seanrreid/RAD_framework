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
  echo "No findings log found. Run /rad-review on at least one rad/ work branch first."
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

### Step 4b: Aggregate token cost from wave-attempt usage

Token cost lives in the per-feature audit log, not the findings log. Each feature
has its own `.agents/state/<feature>/events.jsonl`, and each `wave-attempt` event
carries token usage under `data.usage` as `{ input, output, total }`.

Usage is **optional**: older deliveries (and any wave that ran before this layer
existed) emit `wave-attempt` events with no `data.usage`. Treat a missing or null
`usage` as `0` (unknown) — never let it break the aggregation.

```bash
# Discover every per-feature audit log
for log in .agents/state/*/events.jsonl; do
  [ -f "$log" ] || continue
  feature=$(basename "$(dirname "$log")")

  # Cost per feature: sum of wave-attempt total tokens, missing usage -> 0
  total=$(jq -s '[.[]
    | select(.type=="wave-attempt")
    | (.data.usage.total // 0)] | add // 0' "$log")
  echo "$feature	$total"
done

# Cost per wave (per wave number) for a single feature, missing usage -> 0
jq -r 'select(.type=="wave-attempt")
  | [(.data.wave // .wave // "?" | tostring), (.data.usage.total // 0 | tostring)]
  | join("\t")' .agents/state/[FEATURE]/events.jsonl \
  | awk -F'\t' '{sum[$1]+=$2} END {for (w in sum) print w"\t"sum[w]}' \
  | sort -n
```

Carry two aggregates into the report:

- **Cost per feature** — the summed `total` tokens across all `wave-attempt`
  events in that feature's log. A feature whose every event lacks usage reports
  `0 (unknown)`.
- **Cost per wave** — `total` tokens grouped by wave number within a feature, so
  expensive waves stand out. Waves without recorded usage contribute `0`.

If no `.agents/state/*/events.jsonl` files exist, omit the cost section entirely.

### Step 5: Synthesize and output report

Using the data from Steps 3–4b, write the following report. Populate each section
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

### Token Cost
[From Step 4b. Omit this section entirely if no per-feature events.jsonl exists.]
Cost per feature (total tokens, summed from wave-attempt usage):
- [feature] — [N] tokens   [or "0 (unknown — no usage recorded)"]
...
Cost per wave [for the most recent / most expensive feature]:
- Wave [n] — [N] tokens
...
[Note any feature whose usage is entirely unknown: "[feature]: usage not recorded
 (pre-dates the cost layer)."]

### Recommended Focus Areas
[Top 2–3 patterns that are both frequent and high-severity. Each as one sentence:
 "Address [category] — appears in [N] cycles ([%]) and always blocks architect review."]
```

---

### Step 6: Report auto-cleared changes

The severity-routed approval gate records each policy auto-clear as an `approved`
event with `recordedBy === 'policy'` in the per-feature audit log
`.agents/state/<feature>/events.jsonl`. This reuses the existing event read path —
`harness/events.js` `reduce(history)` surfaces `recordedBy` in its approvals array,
so counting auto-clears = counting `approved` events whose `recordedBy` is
`'policy'`. The matched allowlist pattern that cleared the change lives in
`event.data.patterns`.

Count those events across every feature log and group them by matched pattern:

```bash
# All policy auto-clears across every feature, grouped by matched pattern
jq -r 'select(.type=="approved" and .recordedBy=="policy")
  | (.data.patterns // ["(unspecified)"])[]' .agents/state/*/events.jsonl 2>/dev/null \
  | sort | uniq -c | sort -rn

# Total auto-clear count
jq -r 'select(.type=="approved" and .recordedBy=="policy")' \
  .agents/state/*/events.jsonl 2>/dev/null | jq -s 'length'
```

If no `.agents/state/*/events.jsonl` files exist, or no policy auto-clears are
recorded, omit this section entirely.

Add the following to the report, after **Recommended Focus Areas**:

```markdown
### Auto-Cleared Changes
[Total count of policy auto-clears across all features. Then a per-pattern breakdown,
 ranked by count descending:]
Auto-cleared by the severity gate: [N] change(s)
- `[pattern]` — [N] clear(s)
...
[Simple trend, if ≥ 2 cycles of history are available: compare the auto-clear count
 in the most recent cycles to earlier ones and state it in one line:
 "Trend: [↑ more auto-clears | ↓ fewer auto-clears | → stable]"]
```

---

## Rules

- Never modify `.agents/findings.jsonl` or any `.agents/state/*/events.jsonl` — read only
- Token usage in `wave-attempt` events is optional; treat missing `data.usage` as 0 (unknown)
- If the file is missing or empty, say so and exit cleanly
- If fewer than 3 cycles exist, skip pattern analysis and output raw findings
- Do not invent patterns — only report what the data shows
- Hotspot file paths should be exact as recorded in the log
