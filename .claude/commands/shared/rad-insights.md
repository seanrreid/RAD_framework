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

### Step 3b: Findings Recurrence — convention/lint suggestions

A category that keeps recurring across review cycles is a signal the project is
missing a convention (or a lint rule) that would prevent it. This step turns the
Step 3 category counts into **suggestions only** — every output is framed
"suggestion — apply via PR; never auto-applied". This skill NEVER edits
`CLAUDE.md` or `scripts/lint-plan.sh` itself.

**Threshold.** Resolved from `RAD_FINDINGS_THRESHOLD` with `Number.parseInt`
semantics: unset, `0`, NaN (non-numeric), or negative all fall back to the
default `5`.

```bash
t=$(node -e 'const n = Number.parseInt(process.env.RAD_FINDINGS_THRESHOLD ?? "", 10);
process.stdout.write(String(Number.isNaN(n) || n <= 0 ? 5 : n))')

# Every category with count >= threshold (all priorities), descending
jq -r 'select(.type=="finding") | .category' .agents/findings.jsonl \
  | sort | uniq -c | sort -rn | awk -v t="$t" '$1 >= t { print $1 "\t" $2 }'
```

For **each** category the filter emits, produce one suggestion block containing
EITHER a ready-to-paste `## Coding Conventions` bullet for `CLAUDE.md` OR a
described lint rule (prose only — do not write lint code), targeted at the
category. Examples of the mapping:

- `testing` → convention bullet about test-coverage expectations for changed behavior
- `code-clarity` → convention bullet about naming/function-size/comment expectations
- `security` → convention bullet about input handling and secret hygiene, or a
  described lint rule flagging risky patterns
- `error-handling` → convention bullet about error propagation vs swallowing
- `correctness` → convention bullet about edge-case/validation expectations

Suggestion block format (repeat per category):

```markdown
#### Recurring: [category] — [N] findings (threshold: [t])
Suggested `## Coding Conventions` bullet for CLAUDE.md:
- [one concrete, checkable convention line targeting the category]
[OR: Suggested lint rule (described, not implemented): [one-sentence rule description]]
> Suggestion — apply via PR; never auto-applied.
```

If no category reaches the threshold, state "No category meets the recurrence
threshold ([t])" and emit no blocks.

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

### Step 4c: Fold wave reliability from the event logs

Reliability metrics come from the same per-feature audit logs as Step 4b, but the
counting logic is NOT re-implemented here — it lives in the pure read helpers
exported by `harness/events.js` (`outcomeCounts`, `failReasonCounts`,
`retryCounts`, `hookVetoCounts`, `totalUsage`). That module is the single source
of truth for these folds; import it, never rewrite the counts in jq.

`harness/events.js` is ESM, so use `node --input-type=module -e` (top-level
`await import` works there and relative specifiers resolve against the cwd —
run this from the repo root). `RAD_STATE_DIR` (default `.agents/state`) exists
only so the same script is testable against a fixture dir:

```bash
node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const { outcomeCounts, failReasonCounts, retryCounts, hookVetoCounts, totalUsage } =
  await import("./harness/events.js");

const stateDir = process.env.RAD_STATE_DIR || ".agents/state";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const features = existsSync(stateDir)
  ? readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((f) => existsSync(join(stateDir, f, "events.jsonl")))
      .sort()
  : [];

const agg = {
  outcomes: outcomeCounts([]),
  failReasons: failReasonCounts([]),
  retries: { total: 0, retriedWaves: 0 },
  hookVetoes: hookVetoCounts([]),
  usage: totalUsage([]),
};
const perFeature = {};

for (const feature of features) {
  const history = readFileSync(join(stateDir, feature, "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const outcomes = outcomeCounts(history);
  const failReasons = failReasonCounts(history);
  const retries = retryCounts(history);
  const vetoes = hookVetoCounts(history);
  const usage = totalUsage(history);
  // Per-wave token spend from wave-attempt data.usage (missing usage -> 0),
  // mirroring the totalUsage total-vs-input+output preference per event.
  const spendPerWave = {};
  for (const e of history) {
    if (!e || e.type !== "wave-attempt" || !e.data) continue;
    const w = typeof e.data.wave === "number" && Number.isFinite(e.data.wave) ? String(e.data.wave) : "?";
    const u = e.data.usage && typeof e.data.usage === "object" ? e.data.usage : null;
    const t = u ? (Number.isFinite(u.total) ? u.total : num(u.input) + num(u.output)) : 0;
    spendPerWave[w] = (spendPerWave[w] || 0) + t;
  }
  perFeature[feature] = { outcomes, failReasons, retries, hookVetoes: vetoes, usage, spendPerWave };

  for (const k of Object.keys(agg.outcomes)) agg.outcomes[k] += outcomes[k];
  agg.failReasons.total += failReasons.total;
  for (const [r, n] of Object.entries(failReasons.reasons))
    agg.failReasons.reasons[r] = (agg.failReasons.reasons[r] || 0) + n;
  agg.retries.total += retries.total;
  agg.retries.retriedWaves += retries.retriedWaves;
  agg.hookVetoes.vetoes += vetoes.vetoes;
  agg.hookVetoes.vetoedAttempts += vetoes.vetoedAttempts;
  agg.usage.input += usage.input; agg.usage.output += usage.output; agg.usage.total += usage.total;
}

const noWaveData = agg.outcomes.total === 0 && agg.retries.total === 0 &&
  agg.failReasons.total === 0 && agg.hookVetoes.vetoes === 0 && agg.hookVetoes.vetoedAttempts === 0;
console.log(JSON.stringify({ noWaveData, aggregate: agg, perFeature }, null, 2));
'
```

Reading the output:

- **`aggregate.outcomes`** — `wave-complete` events keyed by the frozen 7-outcome
  vocabulary (`success | fail-tests | fail-scope | fail-protocol | fail-timeout |
  no-changes | abort-user`), plus `unknown` (missing/out-of-vocabulary outcome —
  the current spine records `wave-complete` without one) and `total`. Success
  rate = `success / total` when `total > 0`.
- **`aggregate.failReasons`** — `wave-failed` events grouped by free-form
  `data.reason` (`token-budget`, `doom-loop`, …); a missing reason buckets as
  `unknown`.
- **`aggregate.retries`** — `wave-attempt` totals; `retriedWaves` counts waves
  seen with more than one attempt (per-wave detail is in `perFeature`).
- **`aggregate.hookVetoes`** — `hook-veto` events (`vetoes`) and hook-provenance
  attempts (`vetoedAttempts`) — kept separate, never summed (a post-wave veto
  emits both; adding them would double-count).
- **`perFeature[*].spendPerWave`** — per-wave token spend within each feature;
  waves without recorded usage contribute `0`.
- **`noWaveData: true`** — no wave events exist anywhere. This is the EXPECTED
  state today: committed event logs contain only `approved` events, so a fresh
  clone renders the zeros path (see the Reliability template below), not an error.

### Step 5: Synthesize and output report

Using the data from Steps 3–4c, write the following report. Populate each section
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

### Findings Recurrence
[From Step 3b. Threshold: [t] (RAD_FINDINGS_THRESHOLD, default 5).]
[One suggestion block per category with count >= threshold, using the Step 3b
 block format — each carries the "Suggestion — apply via PR; never auto-applied"
 framing verbatim.]
[If none reach the threshold: "No category meets the recurrence threshold ([t])."]

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

### Reliability
[From Step 4c. Omit this section entirely if no per-feature events.jsonl exists.]
[If the fold reports noWaveData: true, render EXACTLY this zeros path and nothing else
 in the section — this is the normal state on a fresh clone, since committed event
 logs contain only approved events:]
No wave data yet — the committed event logs contain only approval events.
Reliability metrics will populate after the first /rad-deliver run records
wave-attempt / wave-complete / wave-failed events.

[Otherwise, populate from the aggregate (and perFeature where noted):]
Wave success rate: [success]/[total] wave-complete events ([Y]%)
Outcome distribution (frozen 7-outcome vocabulary):
- success: [N]  fail-tests: [N]  fail-scope: [N]  fail-protocol: [N]
- fail-timeout: [N]  no-changes: [N]  abort-user: [N]  unknown: [N]
Retry frequency: [total] wave attempts; [retriedWaves] wave(s) needed more than
one attempt [call out the worst per-wave attempt counts from perFeature]
Failure reasons ([total] wave-failed event(s)):
- [reason] — [N]
...
Hook vetoes: [vetoes] veto event(s); [vetoedAttempts] hook-provenance attempt(s)
[reported separately — never summed]
Token spend per wave [for features with recorded usage; 0 = usage not recorded]:
- [feature] / Wave [n] — [N] tokens
...

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
- Reliability counts (Step 4c) MUST come from the `harness/events.js` read helpers
  (`outcomeCounts`, `failReasonCounts`, `retryCounts`, `hookVetoCounts`, `totalUsage`) —
  never re-implement those folds in jq or shell
- All-zero reliability counts are the "no wave data yet" path, not an error — render
  the zeros text from the template and move on
- Findings Recurrence (Step 3b) outputs are suggestions only — never edit CLAUDE.md
  or scripts/lint-plan.sh from this skill; every block must carry the
  "Suggestion — apply via PR; never auto-applied" framing
- RAD_FINDINGS_THRESHOLD parses via Number.parseInt; unset/0/NaN/negative → default 5
- If the file is missing or empty, say so and exit cleanly
- If fewer than 3 cycles exist, skip pattern analysis and output raw findings
- Do not invent patterns — only report what the data shows
- Hotspot file paths should be exact as recorded in the log
