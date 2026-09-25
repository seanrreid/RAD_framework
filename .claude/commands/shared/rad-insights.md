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

- **`aggregate.outcomes`** — one count per WAVE: each (feature, wave) pair's
  TERMINAL `wave-attempt` outcome (its last attempt in history order), keyed by
  the frozen 7-outcome vocabulary (`success | fail-tests | fail-scope |
  fail-protocol | fail-timeout | no-changes | abort-user`), plus `unknown`
  (missing/out-of-vocabulary terminal outcome) and `total`. `total` is the number
  of (feature, wave) pairs — waves, not attempts and not `wave-complete` events
  (`wave-complete` carries no outcome and is ignored). A retried wave counts once,
  by how it ended. Wave success rate = `success / total` when `total > 0`.
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
- **`noWaveData: true`** — no wave events exist anywhere: no placeable
  (feature, wave) pair (`outcomes.total === 0`) AND no wave-attempt, wave-failed
  or hook-veto event at all. An attempt that lacks a feature or wave number cannot
  form a pair, but it still counts in `retries.total`, so it keeps `noWaveData`
  false. This is the EXPECTED state today: committed event logs contain only
  `approved` events, so a fresh clone renders the zeros path (see the Reliability
  template below), not an error.

### Step 4d: Fold per-task blocked reasons from the event logs

Blocked-reason metrics read the OPTIONAL per-task records (`data.tasks`, see
`docs/rad-wave-contract.md`) that newer `wave-attempt` events carry. As in Step
4c, the counting lives in `harness/events.js` (`blockedReasonCounts`) — import
it, never re-implement it in jq. Same invocation convention: run from the repo
root; `RAD_STATE_DIR` (default `.agents/state`) exists only for fixture testing.
This step only reads; it writes nothing.

```bash
node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const { blockedReasonCounts } = await import("./harness/events.js");

const stateDir = process.env.RAD_STATE_DIR || ".agents/state";
const features = existsSync(stateDir)
  ? readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((f) => existsSync(join(stateDir, f, "events.jsonl")))
      .sort()
  : [];

const aggregate = blockedReasonCounts([]);
const perFeature = {};
for (const feature of features) {
  const history = readFileSync(join(stateDir, feature, "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const counts = blockedReasonCounts(history);
  perFeature[feature] = counts;
  for (const k of Object.keys(aggregate)) aggregate[k] += counts[k];
}

const noEnrichedData = aggregate.enrichedAttempts === 0;
console.log(JSON.stringify({ noEnrichedData, aggregate, perFeature }, null, 2));
'
```

Reading the output:

- **`aggregate.blocked_code` / `blocked_spec` / `blocked_intent`** — tasks the
  wave agent self-classified as blocked, by reason. `complete` and
  `done_with_concerns` tasks are not counted.
- **`aggregate.enrichedAttempts`** — `wave-attempt` events that carried per-task
  data. The bucket counts cover ONLY these attempts; legacy attempts (no
  `tasks`) are invisible to this fold.
- **`noEnrichedData: true`** — no attempt anywhere carried per-task data. The
  zeros are then NOT a measurement; render the degradation line in the
  Blocked Reasons template below, never the zero counts.

### Step 4e: Attribute blocked tasks to files (code-legibility signal)

Per-file attribution joins the per-task blocked statuses from Step 4d with the
files each task DECLARED in its plan. The plan docs are the only source of the
task-title → paths association: every task in `.agents/plans/*.md` is a
`#### Task N.M: <title>` header followed by a `File:` line (paths separated by
`,` or `;`, sometimes with `:lines` / `:+N` suffixes or a parenthetical note).
This step builds that mapping and passes it to `fileFailureCounts` in
`harness/events.js` — the fold itself never touches the filesystem, and the
counting must never be re-implemented in jq. Same invocation convention as
Steps 4c/4d: run from the repo root; `RAD_STATE_DIR` (default `.agents/state`)
and `RAD_PLANS_DIR` (default `.agents/plans`) exist only for fixture testing.
This step only reads; it writes nothing.

```bash
node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const { fileFailureCounts } = await import("./harness/events.js");

const stateDir = process.env.RAD_STATE_DIR || ".agents/state";
const plansDir = process.env.RAD_PLANS_DIR || ".agents/plans";
const TASK_HEADER = /^#### Task [0-9]+\.[0-9]+:\s*(.+?)\s*$/;
const LINE_SUFFIX = /:[+0-9,-]+$/;

// "a.js:10-20; b.md (throughout)" -> ["a.js", "b.md"]; drops prose fragments.
const parseFileLine = (line) => line.replace(/^File:\s*/, "")
  .split(/[,;]|\s\+\s/)
  .map((part) => part.trim().replace(/`/g, "").split(/\s+/)[0] || "")
  .map((p) => p.replace(LINE_SUFFIX, ""))
  .filter((p) => /[./]/.test(p));

const taskFiles = {};
const planFiles = existsSync(plansDir)
  ? readdirSync(plansDir).filter((f) => f.endsWith(".md")).sort() : [];
for (const plan of planFiles) {
  let title = null;
  for (const line of readFileSync(join(plansDir, plan), "utf8").split("\n")) {
    const header = line.match(TASK_HEADER);
    if (header) { title = header[1]; continue; }
    if (line.startsWith("#")) { title = null; continue; }
    if (title && line.startsWith("File:")) {
      taskFiles[title] = [...new Set([...(taskFiles[title] || []), ...parseFileLine(line)])];
      title = null;
    }
  }
}

const features = existsSync(stateDir)
  ? readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((f) => existsSync(join(stateDir, f, "events.jsonl")))
      .sort()
  : [];
// One history across all features; the feature name is stamped from the dir
// only where an event omits it, so cross-feature counting always has a key.
const history = features.flatMap((feature) =>
  readFileSync(join(stateDir, feature, "events.jsonl"), "utf8")
    .split("\n").filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((e) => ({ ...e, feature: e.feature || feature })));

const result = fileFailureCounts(history, taskFiles);
const mappedTitles = Object.keys(taskFiles).length;
const reportedFiles = Object.keys(result.files).length;
console.log(JSON.stringify({ mappedTitles, reportedFiles, ...result }, null, 2));
'
```

Reading the output:

- **`files`** — each path whose declared tasks were self-classified `blocked_*`
  in at least `minFeatures` DISTINCT features: `failures` is the number of
  blocked task records attributed to it (a task declaring two files counts once
  for each), `features` the distinct features they came from.
- **`belowFloor`** — files with blocked tasks in fewer than `minFeatures`
  features. They are withheld on purpose: one feature's trouble says more about
  that plan than about the region of code.
- **`minFeatures`** — the floor applied (`FILE_FAILURE_MIN_FEATURES`, default 2).
- **`mappedTitles`** — task titles the plan docs mapped to paths. `0` means no
  plan doc under the plans dir carried a `#### Task` header + `File:` line.
- Only enriched attempts (Step 4d's `enrichedAttempts`) can be attributed; a
  legacy attempt without per-task data names no task, so it names no file.

### Step 4f: Fold per-wave-position reliability (model-tiering advisory)

Per-Wave `Model:` tiering (see CLAUDE.md "Cost & Frugality") is only worth
suggesting where history shows a wave position is reliably first-try or reliably
retried. The counting lives in `harness/events.js` (`waveReliability`) — import
it, never re-implement it. Same invocation convention as Steps 4c–4e: run from
the repo root; `RAD_STATE_DIR` (default `.agents/state`) exists only for fixture
testing. The fold carries sample sizes and applies NO floor; the floor below is
a presentation decision owned by this skill. This step only reads; it writes
nothing.

```bash
node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const { waveReliability } = await import("./harness/events.js");

// Minimum DISTINCT features with wave history before any tiering advisory
// renders. Below it, a rate describes one or two plans, not a wave position.
const TIERING_MIN_FEATURES = 3;

const stateDir = process.env.RAD_STATE_DIR || ".agents/state";
const features = existsSync(stateDir)
  ? readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((f) => existsSync(join(stateDir, f, "events.jsonl")))
      .sort()
  : [];

// Pairs are keyed by (feature, wave), so one concatenated history is safe.
const history = features.flatMap((feature) =>
  readFileSync(join(stateDir, feature, "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const result = waveReliability(history);

const pct = (n, d) => (d === 0 ? 0 : Math.round((100 * n) / d));
const positions = Object.entries(result.perPosition).map(([wave, s]) => ({
  wave: Number(wave),
  n: s.samples,
  attempts: s.attempts,
  firstAttemptSuccessPct: pct(s.firstAttemptSuccess, s.samples),
  retryPct: pct(s.retried, s.samples),
}));
const noWaveData = result.features === 0;
const advisory = result.features >= TIERING_MIN_FEATURES;
console.log(JSON.stringify({ noWaveData, advisory, minFeatures: TIERING_MIN_FEATURES,
  features: result.features, positions }, null, 2));
'
```

Reading the output:

- **`positions[].n`** — (feature, wave) pairs observed at that wave position;
  every rate below is out of this n. A wave resumed across deliver runs is one
  pair.
- **`firstAttemptSuccessPct`** — share of pairs whose first attempt recorded
  outcome `success`.
- **`retryPct`** — share of pairs that needed more than one attempt.
  `attempts` is the raw attempt total at that position.
- **`features`** — distinct features contributing wave attempts ("based on N
  features").
- **`advisory: false`** — fewer than `minFeatures` (`TIERING_MIN_FEATURES`)
  features have wave history. Render the insufficient-history line from the
  Model Tiering template below, never the rates.
- **`noWaveData: true`** — no placeable `wave-attempt` event anywhere; same
  degradation convention as Step 4c.
- There is deliberately no spend figure in this output: the fold never reads
  `usage` (see the Model Tiering section for why).

### Step 4f2: Fold per-attempt cache-hit ratios (cache-hit readout)

Wave attempts MAY carry the optional `usage.cacheRead` field (cache tokens read,
see `docs/rad-wave-contract.md`, `usage`). A retry whose cache-hit ratio collapses
to 0 after a positive first attempt re-paid for the whole prompt — worth seeing.
The counting lives in `harness/events.js` (`cacheUsage`) — import it, never
re-implement it. Same invocation convention as Steps 4c–4f: run from the repo
root; `RAD_STATE_DIR` (default `.agents/state`) exists only for fixture testing.
This step only reads; it writes nothing.

```bash
node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const { cacheUsage } = await import("./harness/events.js");

const NO_CACHE_LINE = "no cache data reported";
const stateDir = process.env.RAD_STATE_DIR || ".agents/state";
const features = existsSync(stateDir)
  ? readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((f) => existsSync(join(stateDir, f, "events.jsonl")))
      .sort()
  : [];

// Attempts are ordered and keyed by (feature, wave), so one concatenated history is safe.
const history = features.flatMap((feature) =>
  readFileSync(join(stateDir, feature, "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const result = cacheUsage(history);

const pct = (r) => (r === null ? null : Math.round(100 * r));
// Flag a retry whose ratio is 0 after an EARLIER positive attempt in the same (feature, wave).
const peak = new Map();
const droppedToZero = [];
for (const a of result.attempts) {
  const key = JSON.stringify([a.feature, a.wave]);
  if (a.ratio === 0 && (peak.get(key) || 0) > 0) droppedToZero.push({ ...a, earlierPeakPct: pct(peak.get(key)) });
  if (a.ratio !== null && a.ratio > (peak.get(key) || 0)) peak.set(key, a.ratio);
}
const denominator = result.totals.input + result.totals.cacheRead;
const noCacheData = result.attempts.length === 0;
if (noCacheData) console.log(NO_CACHE_LINE);
console.log(JSON.stringify({ noCacheData, withoutCache: result.withoutCache,
  overallRatioPct: denominator === 0 ? null : pct(result.totals.cacheRead / denominator),
  totals: result.totals,
  attempts: result.attempts.map((a) => ({ ...a, ratioPct: pct(a.ratio) })),
  droppedToZero }, null, 2));
'
```

Reading the output:

- **`no cache data reported`** (first line, with `noCacheData: true`) — no attempt
  anywhere carried a valid `usage.cacheRead`. This is the expected state for logs
  written before the command/SDK adapters reported cache fields (#121). Render the
  degradation line in the Cache-Hit Readout template, never a 0% ratio.
- **`attempts[]`** — one entry per attempt that reported `cacheRead`: `feature`,
  `wave`, `attempt` (1-based ordinal within that (feature, wave), counting every
  attempt, so it matches the real retry number), `cacheRead`, `input`, and
  `ratioPct` = `cacheRead / (input + cacheRead)` as a percentage — `null` when
  both are 0 (nothing to measure, not a 0% hit rate).
- **`droppedToZero[]`** — retries whose ratio is exactly 0 after an earlier
  attempt in the same (feature, wave) had a positive ratio (`earlierPeakPct`).
- **`withoutCache`** — placeable attempts that reported no `cacheRead` (legacy
  or unreported); they are excluded from every ratio.
- **`overallRatioPct`** — summed `cacheRead` over summed `input + cacheRead`
  across the listed attempts only.

### Step 4g: Route recurring signals to prompt surfaces

Some failure signals point at the INSTRUCTIONS the wave agent was given, not at
the code it touched: a recurring `fail-protocol` says the WAVE_RESULT format
instructions are unclear, a recurring `fail-scope` says the plan's scope guidance
is, and recurring `blocked_spec` / `blocked_intent` say the tasks themselves were
under-specified or mis-aimed. This step routes each such signal to the one prompt
surface that shaped it (rationale: `docs/harness-and-framework.md`, "Prompt
surfaces as a feedback-loop target").

The routing is ONE table — `PROMPT_SURFACE_MAP` in the snippet below. It is data:
to route a new signal, add a row; never add a special case elsewhere. Counts come
from folds in `harness/events.js` — `attemptOutcomeCounts`, `failReasonCounts`
(Step 4c) and `blockedReasonCounts` (Step 4d); this step only compares them with
the threshold and looks up the table. `outcome:*` rows read `attemptOutcomeCounts`,
NOT `outcomeCounts`: the spine records the outcome only on `wave-attempt` events
(`wave-complete` carries `{ wave }` alone), so wave-complete outcomes never show
a failure on a real log. Same invocation
convention as Steps 4c–4f: run from the repo root; `RAD_STATE_DIR` (default
`.agents/state`) exists only for fixture testing. This step only reads; it writes
nothing.

```bash
node --input-type=module -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const { attemptOutcomeCounts, failReasonCounts, blockedReasonCounts } =
  await import("./harness/events.js");

// Minimum aggregate count before a signal renders a proposal. Below it, a
// signal describes one bad wave, not an instruction that keeps misleading.
const PROMPT_SIGNAL_THRESHOLD = 3;

// THE mapping table: signal -> the prompt surface that shaped it.
const PROMPT_SURFACE_MAP = {
  "outcome:fail-protocol": {
    target: "harness/adapters/agent/contract.js",
    section: "buildWavePrompt \"## Return format\" block (prose mirror: .claude/commands/team/rad-deliver.md \"## Return format\")",
    note: "Preserve the #112 prefix-ordering constraint: order the template so a retry extends a prefix instead of rewriting one.",
  },
  "outcome:fail-scope": {
    target: ".claude/commands/team/rad-plan.md",
    section: "Step 3 plan template, \"## Files in Scope\" guidance comment",
    note: null,
  },
  "blocked:blocked_spec": {
    target: ".claude/commands/team/rad-plan.md",
    section: "Step 3 task template (What:/Validate:) and \"Wave rules\"",
    note: null,
  },
  "blocked:blocked_intent": {
    target: ".claude/commands/team/rad-plan.md",
    section: "Step 3 task template (What:/Validate:) and \"Wave rules\"",
    note: null,
  },
};

// Outcome keys that are not failure signals.
const NON_SIGNAL_OUTCOMES = new Set(["success", "unknown", "total"]);
const BLOCKED_KEYS = ["blocked_code", "blocked_spec", "blocked_intent"];

const stateDir = process.env.RAD_STATE_DIR || ".agents/state";
const features = existsSync(stateDir)
  ? readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((f) => existsSync(join(stateDir, f, "events.jsonl")))
      .sort()
  : [];

// signal -> { count, features: { feature: n } }
const signals = {};
const add = (signal, feature, n) => {
  if (n <= 0) return;
  const s = signals[signal] || (signals[signal] = { count: 0, features: {} });
  s.count += n;
  s.features[feature] = (s.features[feature] || 0) + n;
};

let waveEvents = 0;
let enrichedAttempts = 0;
for (const feature of features) {
  const history = readFileSync(join(stateDir, feature, "events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const attempts = attemptOutcomeCounts(history);
  const failReasons = failReasonCounts(history);
  const blocked = blockedReasonCounts(history);
  waveEvents += attempts.counts.total + failReasons.total;
  enrichedAttempts += blocked.enrichedAttempts;
  // Attribute each outcome to the features the fold saw record it (the event
  // `feature` field); fall back to the state-dir name if none was recorded.
  for (const [k, n] of Object.entries(attempts.counts)) {
    if (NON_SIGNAL_OUTCOMES.has(k)) continue;
    const named = attempts.features[k] || [];
    add(`outcome:${k}`, named.length === 1 ? named[0] : feature, n);
  }
  for (const [r, n] of Object.entries(failReasons.reasons)) add(`wave-failed:${r}`, feature, n);
  for (const k of BLOCKED_KEYS) add(`blocked:${k}`, feature, blocked[k]);
}

const crossing = Object.entries(signals)
  .filter(([, s]) => s.count >= PROMPT_SIGNAL_THRESHOLD)
  .sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b));
const proposals = crossing.filter(([sig]) => PROMPT_SURFACE_MAP[sig])
  .map(([signal, s]) => ({ signal, ...s, ...PROMPT_SURFACE_MAP[signal] }));
const unmapped = crossing.filter(([sig]) => !PROMPT_SURFACE_MAP[sig])
  .map(([signal, s]) => ({ signal, ...s }));

console.log(JSON.stringify({
  threshold: PROMPT_SIGNAL_THRESHOLD,
  noWaveData: waveEvents === 0,
  noEnrichedData: enrichedAttempts === 0,
  proposals, unmapped,
}, null, 2));
'
```

Reading the output:

- **Signal names** — `outcome:<outcome>` (from `attemptOutcomeCounts`, i.e.
  `wave-attempt` outcomes, one per attempt), `wave-failed:<reason>` (from `failReasonCounts`),
  `blocked:<status>` (from `blockedReasonCounts`). `count` is the aggregate
  across features; `features` names each affected feature with its own count.
- **`proposals`** — signals at or above `threshold`
  (`PROMPT_SIGNAL_THRESHOLD`) that have a row in `PROMPT_SURFACE_MAP`; each
  carries the `target` file, the `section` within it, and any `note`.
- **`unmapped`** — signals at or above the threshold with NO row in the table
  (e.g. `outcome:fail-tests`, `blocked:blocked_code`, `wave-failed:doom-loop`).
  They render an explicit "unmapped signal" line — never dropped, never guessed
  onto a surface.
- Signals below the threshold appear in neither list and render nothing.
- **`noWaveData: true`** — no `wave-attempt` / `wave-failed` event anywhere;
  **`noEnrichedData: true`** — no per-task data, so `blocked:*` signals cannot
  be measured. Both are degradation states, not a clean record.
- `outcome:*` signals count `wave-attempt` outcomes (the `attemptOutcomeCounts`
  contract) — every attempt, so a wave retried twice on `fail-protocol` counts 2.
  `wave-complete` events are never counted: the spine writes no outcome on them.

### Step 5: Synthesize and output report

Using the data from Steps 3–4g, write the following report. Populate each section
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
Wave success rate: [success]/[total] waves ended in success ([Y]%) — each
(feature, wave)'s terminal attempt; a retried wave counts once, by how it ended
Terminal-outcome distribution per wave (frozen 7-outcome vocabulary):
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

### Blocked Reasons
[From Step 4d. Omit this section entirely if no per-feature events.jsonl exists.]
[If the fold reports noEnrichedData: true, render EXACTLY this line and nothing
 else in the section — zeros here would be unmeasured, not a clean record:]
No enriched (per-task) wave events exist yet — blocked-reason metrics will
populate once /rad-deliver records wave-attempt events carrying per-task data.

[Otherwise, populate from the aggregate (and perFeature where noted):]
Blocked tasks across [enrichedAttempts] enriched wave attempt(s):
- blocked_code: [N]  blocked_spec: [N]  blocked_intent: [N]
[Name the features contributing blocked tasks from perFeature. If all three are
 0: "No blocked tasks in [enrichedAttempts] enriched attempt(s)."]
[Suggestion only — never edit files. A blocked_spec or blocked_intent majority
 suggests plans need sharper Validate fields or intent; a blocked_code majority
 points at implementation difficulty rather than plan quality.]

### Code Legibility Signals
[From Step 4e. Omit this section entirely if no per-feature events.jsonl exists.]
[Pick EXACTLY ONE degradation line when it applies, and render nothing else in
 the section — silence would read as a clean record:]
[If Step 4d reported noEnrichedData: true:]
No enriched (per-task) wave events exist yet — code-legibility signals need
per-task data to attribute blocked tasks to files.
[Else if mappedTitles is 0:]
No plan-doc task mappings found (no "#### Task" header + "File:" line under the
plans directory) — blocked tasks cannot be attributed to files.
[Else if reportedFiles is 0:]
Insufficient history for code-legibility signals — no file has accumulated
blocked tasks across at least [minFeatures] distinct features yet
([belowFloor] file(s) below the floor).

[Otherwise, list every entry in `files`, most failures first:]
Files accumulating blocked tasks across features (floor: [minFeatures] features):
- [path] — [failures] blocked task(s) across [N] features ([features joined])
...
[If belowFloor > 0: "[belowFloor] further file(s) had blocked tasks in fewer than
 [minFeatures] features and are not listed."]
[Framing (#93) — render this sentence verbatim under the list:]
These counts are a code-legibility signal about the named region of the codebase —
repeated trouble there across unrelated features suggests the code is hard to
understand or change safely — not a verdict on agent or developer performance.
[Suggestion only — name the files; never edit them and never propose an automatic
 change. A reader may choose to add a comment, a README, or a refactor task.]

### Model Tiering Advisory
[From Step 4f. Omit this section entirely if no per-feature events.jsonl exists.]
[Pick EXACTLY ONE degradation line when it applies, and render nothing else in
 the section except the spend note — silence would read as "no tiering needed":]
[If noWaveData: true:]
No wave data yet — per-wave-position reliability will populate after the first
/rad-deliver run records wave-attempt events.
[Else if advisory: false:]
Insufficient history for a model-tiering advisory — [features] feature(s) have
wave history; at least [minFeatures] are needed before per-position rates mean
anything beyond individual plans.

[Otherwise, one line per position, ascending wave number:]
Based on [features] features (floor: [minFeatures]):
- Wave [wave] — first-attempt success [firstAttemptSuccessPct]% (n=[n]),
  retry rate [retryPct]% (n=[n]), [attempts] attempt(s)
...
[Suggestion only — never edit plans. A position with high first-attempt success
 and a low retry rate MAY be a candidate for a cheaper `Model:` line; a position
 with a high retry rate may warrant a stronger one. Always quote the n; a
 position with small n is weak evidence even above the feature floor.]

[Render this note verbatim in every state, including the degradation states:]
Spend-based tiering advice is deliberately absent. Recorded `input_tokens` is the
uncached remainder, so relative spend varies with cache-hit rate and scheduling
rather than with what a wave costs. Usage now carries the optional cache fields
(`cacheRead` / `cacheWrite` / `cost`, #121) — see the Cache-Hit Readout below —
but spend-derived tiering advice is still deferred (tracked in #65).

### Cache-Hit Readout
[From Step 4f2. Omit this section entirely if no per-feature events.jsonl exists.]
[If noCacheData: true, render EXACTLY this line and nothing else in the section —
 silence would read as a perfect cache, a 0% ratio as a measured miss:]
no cache data reported — no wave attempt carried `usage.cacheRead`
([withoutCache] attempt(s) without cache fields).

[Otherwise:]
Overall cache-hit ratio: [overallRatioPct]% across [attempts.length] attempt(s)
reporting cache data ([withoutCache] attempt(s) without cache fields excluded)
Per attempt (cacheRead / (input + cacheRead)):
- [feature] / Wave [wave] / attempt [attempt] — [ratioPct]% ([cacheRead] cached,
  [input] uncached)   [ratioPct null: "n/a (no input or cache tokens)"]
...
[For each droppedToZero entry, render:]
⚠ [feature] / Wave [wave] / attempt [attempt] — cache-hit ratio dropped to 0%
after [earlierPeakPct]% on an earlier attempt; the retry re-sent its whole prompt
uncached.
[Suggestion only — never edit plans or prompts. A retry that drops to 0% may
 point at a changed prompt prefix between attempts or a cache TTL lapse; a
 reader may choose to investigate the retry prompt's prefix ordering.]

### Prompt-Surface Proposals
[From Step 4g. Omit this section entirely if no per-feature events.jsonl exists.]
[If noWaveData: true AND noEnrichedData: true, render EXACTLY this line and nothing
 else in the section:]
No wave data yet — prompt-surface proposals will populate after /rad-deliver runs
record wave-attempt / wave-failed events and per-task wave-attempt data.

[Otherwise, one block per `proposals` entry, highest count first:]
#### Proposal: [signal] — [count] occurrence(s) (threshold: [threshold])
Target: `[target]` — [section]
Affected features: [feature (n), ... from `features`]
[If note is non-null, render it verbatim:] Constraint: [note]
> Suggestion — review the named instructions for clarity; never auto-applied.

[One line per `unmapped` entry:]
Unmapped signal: [signal] — [count] occurrence(s) across [feature (n), ...]; no
prompt surface is mapped for it in PROMPT_SURFACE_MAP (Step 4g).

[If proposals and unmapped are both empty:]
No signal crossed the prompt-surface threshold ([threshold]) — no proposal.
[If noEnrichedData: true (and wave data exists), add:]
blocked_spec / blocked_intent could not be evaluated — no wave-attempt event
carries per-task data yet.
[Suggestion only — name the target file and section; never edit it.]

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
- Per-file attribution (Step 4e) MUST come from `fileFailureCounts` in `harness/events.js`;
  the skill only builds the plan-doc title → paths mapping. The section frames counts as a
  code-legibility signal about a region of code (#93), never an agent-performance verdict
- Per-wave-position reliability (Step 4f) MUST come from `waveReliability` in
  `harness/events.js`; the `TIERING_MIN_FEATURES` floor lives in the skill, never the
  fold. The Model Tiering section never shows a spend figure and never edits a plan
- Cache-hit ratios (Step 4f2) MUST come from `cacheUsage` in `harness/events.js`; the
  skill only derives the retry-dropped-to-0 flag and percentages from its output. With no
  attempt reporting `cacheRead`, render the explicit "no cache data reported" line —
  never a 0% ratio and never silence
- Prompt-surface routing (Step 4g) reads counts ONLY from `attemptOutcomeCounts`,
  `failReasonCounts` and `blockedReasonCounts`; routing lives ONLY in the
  `PROMPT_SURFACE_MAP` table and the threshold ONLY in `PROMPT_SIGNAL_THRESHOLD`.
  Proposals are suggestions — never edit a target file. Any `fail-protocol`
  proposal must preserve the wave-prompt template's #112 prefix-ordering constraint
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
