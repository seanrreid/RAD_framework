---
name: rad-insights
description: >
  Analyze finding patterns across RAD review cycles. Reads .agents/findings.jsonl
  to surface recurring finding categories, hotspot files, and team trajectory.
  Run any time to get a population-level view of review history.
targets:
  claude: command:shared/rad-insights
  codex: skill
  codex_implicit: false
---

# /rad-insights

Analyze finding patterns across all recorded RAD review cycles.

## Input

`{{args}}` (optional):

- `--since YYYY-MM-DD` to limit analysis to cycles on or after that date.
- `--draft-plans` to bundle every threshold-crossing Step 3b category into ONE
  Gate-1-blocked plan via `scripts/draft-insights-plan.sh` (see Step 3b). Without
  this flag the skill drafts nothing and Step 3b output is unchanged.

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
`AGENTS.md`, `CLAUDE.md` or `scripts/lint-plan.sh` itself.

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
EITHER a ready-to-paste `## Coding Conventions` bullet for the conventions file
(`AGENTS.md`, or `CLAUDE.md` if the project has none) OR a described lint rule
(prose only — do not write lint code), targeted at the category. Examples of the mapping:

- `testing` → convention bullet about test-coverage expectations for changed behavior
- `code-clarity` → convention bullet about naming/function-size/comment expectations
- `security` → convention bullet about input handling and secret hygiene, or a
  described lint rule flagging risky patterns
- `error-handling` → convention bullet about error propagation vs swallowing
- `correctness` → convention bullet about edge-case/validation expectations

Suggestion block format (repeat per category):

```markdown
#### Recurring: [category] — [N] findings (threshold: [t])
Suggested `## Coding Conventions` bullet for [AGENTS.md | CLAUDE.md]:
- [one concrete, checkable convention line targeting the category]
[OR: Suggested lint rule (described, not implemented): [one-sentence rule description]]
> Suggestion — apply via PR; never auto-applied.
```

If no category reaches the threshold, state "No category meets the recurrence
threshold ([t])" and emit no blocks.

**Only when `--draft-plans` was passed** (skip this block entirely otherwise —
the output above stays exactly as it is): hand the same threshold-crossing
categories to the drafter, which bundles them into ONE plan on a new
`rad/insights-proposals-<YYYY-MM-DD>` branch cut from the default branch. It
reads the same findings log (`RAD_FINDINGS_FILE` override) and the same
`RAD_FINDINGS_THRESHOLD`, commits only the plan, and never pushes. The drafted
plan carries `[NEEDS CLARIFICATION: …]` markers, so `rad approve` refuses it
until a human finishes it — Gate 1 is never bypassed.

```bash
scripts/draft-insights-plan.sh
```

**Disposition ledger.** `.agents/insights-ledger.jsonl` (append-only; override
with `RAD_INSIGHTS_LEDGER`) records what the architect decided per category as
rows `{category, disposition, date, reason?, ref?, expires?}` with `disposition`
one of `adopted` | `declined` | `deferred`. The drafter applies two rules:

- **Baseline by date.** A category whose latest ledger row has date D counts only
  findings with `date` strictly after D (a finding dated exactly D does not
  count). A category with no ledger row counts every finding. A missing or empty
  ledger changes nothing.
- **Declined skip.** A category whose latest row is `declined` and unexpired
  (`expires` absent or not before today) is skipped; the drafted plan or the
  `nothing to draft` output states which category was skipped and why. An expired
  `declined` row stops suppressing it.

A malformed ledger row (invalid JSON, missing `category`/`disposition`/`date`,
unknown `disposition`) makes the drafter exit 2 naming the line. Rows are appended
only via `scripts/record-insights-disposition.sh <category>
<adopted|declined|deferred> [--reason T] [--ref T] [--expires YYYY-MM-DD]`, or at
approval time with `rad approve <feature> --disposition
<category>:<disposition>[:<reason>]` (repeatable). `scripts/check-ledger-append-only.sh`
fails any diff that edits or removes an existing row.


- **Exit 0** — report its stdout verbatim: either the branch + plan path, or
  `nothing to draft` (no category crossed the threshold). On a drafted plan, print
  the next steps for the human:
  1. Push <branch> to origin yourself when you're ready — insights never pushes.
  2. Review the plan and resolve every `[NEEDS CLARIFICATION: …]` marker
  3. `/rad-approve <feature>` once the plan is finished
- **Non-zero exit** — report the stderr reason verbatim (exit 1: dirty tracked
  worktree or the branch already exists locally/on origin; exit 2: findings log
  missing) and stop drafting. Never retry, never pass a force flag, never delete
  or rename a branch to make room.

### Step 3c: Reviewer calibration

How often each reviewer's findings turn out real. The verdict per finding and the
per-reviewer rates come from `reviewerCalibration` in `harness/findings.js` — never
re-implement the classification or the rate math in jq. A finding is labeled by its
optional `verdict` field (`confirmed` | `false-alarm`, written by `/rad-review` Step
7); older findings without it fall back to the module's documented keyword rules
(`category: "false-alarm"` or "verified false"/"false alarm" in `issue` →
false-alarm; "verified real" or an uppercase `FIXED` in `issue` → confirmed;
anything else → unlabeled). Same invocation convention as Step 4c: run from the
repo root; `RAD_FINDINGS_FILE` (default `.agents/findings.jsonl`) exists only for
fixture testing. This step only reads; it writes nothing.

```bash
node --input-type=module -e '
import { readFileSync, existsSync } from "node:fs";
const { reviewerCalibration } = await import("./harness/findings.js");

const findingsFile = process.env.RAD_FINDINGS_FILE || ".agents/findings.jsonl";
if (!existsSync(findingsFile)) {
  console.log(JSON.stringify({ findingsLog: false }, null, 2));
  process.exit(0);
}
// A malformed line is reported with its line number, then skipped — never silently.
const records = [];
readFileSync(findingsFile, "utf8").split("\n").forEach((line, i) => {
  if (!line.trim()) return;
  try { records.push(JSON.parse(line)); }
  catch (err) { console.error(`skipping malformed JSON at ${findingsFile}:${i + 1}: ${err.message}`); }
});
console.log(JSON.stringify({ findingsLog: true, ...reviewerCalibration(records) }, null, 2));
'
```

Reading the output:

- **`findingsLog: false`** — no findings log; omit the Reviewer Calibration section.
- **`reviewers`** — per reviewer: `confirmed`, `falseAlarm`, `unlabeled` counts and
  `labeled` (= confirmed + falseAlarm). `precision` (confirmed / labeled) and
  `falseAlarmRate` (falseAlarm / labeled) are `null` until `labeled >= minLabeled`
  — below that a rate is noise, so render "insufficient labels", never a 0.
- **`minLabeled`** — the floor applied (`CALIBRATION_MIN_LABELED`, default 5).
- Any `skipping malformed JSON at <file>:<line>` stderr line MUST be surfaced in
  the report under the section — the skip is never silent.

### Step 3d: Ledger staleness (read-only)

Run `scripts/report-ledger-staleness.sh` from the repo root. It is read-only: it
writes nothing, and you never pass it `--draft-plans` or any other flag. It
flags each category whose LATEST ledger row has gone stale: `adopted` rows as
`recurred` (findings dated strictly after the row's date number at least
`RAD_FINDINGS_THRESHOLD`) or `aged` (older than `RAD_STALE_DAYS`, default 90);
`declined`/`deferred` rows as `expired` (`expires` is today or earlier),
`expiring` (`expires` within the 14-day warning window) or `aged` (no `expires`
and older than `RAD_STALE_DAYS`).

- **Exit 0** — report its stdout verbatim (it already starts with the
  `### Ledger Staleness` heading; a missing or empty ledger prints an
  empty-section message).
- **Non-zero exit** — report its stderr verbatim in the Ledger Staleness section
  (exit 2: invalid `RAD_STALE_DAYS` or `RAD_FINDINGS_FILE`, a malformed findings
  line, or a malformed ledger row naming `file:line`; an unparseable
  `RAD_FINDINGS_THRESHOLD` falls back to 5, as in Step 3b). Never retry.

### Step 4: Compute cycle outcomes and trajectory

```bash
# Outcomes distribution
jq -r 'select(.type=="cycle") | .outcome' .agents/findings.jsonl \
  | sort | uniq -c

# HIGH count per cycle over time (for trajectory)
jq -r 'select(.type=="cycle") | [.date, .feature, (.high|tostring)] | join("\t")' \
  .agents/findings.jsonl | sort
```

**Invocation convention for Steps 4b–4j.** Each module below is run from the repo
root and its JSON output is read as-is; never re-implement a fold's counting in
jq or inline. `RAD_STATE_DIR` (default `.agents/state`) exists only so a module
can be tested against a fixture dir. These steps only read; they write nothing.

### Step 4b: Aggregate token cost from wave-attempt usage

Token cost lives in the per-feature audit log, not the findings log. Each
`wave-attempt` event in `.agents/state/<feature>/events.jsonl` carries token
usage under `data.usage` as `{ input, output, total }`. Usage is **optional**:
older deliveries emit `wave-attempt` events with no `data.usage`; a missing or
null `usage` counts as `0` (unknown) and never breaks the aggregation.

```bash
node harness/insights-usage-cost.js
```

Output: `{ noData, perFeature }`; each feature carries `total`, `inferredTotal`,
`attempts`, `usageRecorded`, `usageUnknown`, `perWave`.
- **Cost per feature** — `total`, the summed explicit `usage.total`;
  `usageUnknown: true` reports `0 (unknown)`. Report `total`, never
  `inferredTotal` (it also infers input + output).
- **Cost per wave** — `perWave`, `{ wave, total }` in ascending wave order (an
  attempt without a wave number buckets as `"?"`, listed first).
- **`noData: true`** — no `.agents/state/*/events.jsonl`: omit the cost section.

### Step 4c: Fold wave reliability from the event logs

Reliability metrics come from the same per-feature audit logs as Step 4b. The
counting lives in the pure read helpers exported by `harness/events.js`
(`outcomeCounts`, `failReasonCounts`, `retryCounts`, `hookVetoCounts`,
`totalUsage`); `harness/insights-reliability.js` aggregates them across features.

```bash
node harness/insights-reliability.js
```

The output is `{ noWaveData, aggregate, perFeature }`.

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
- **`perFeature[*].spendPerWave`** — per-wave token spend within each feature.
- **`noWaveData: true`** — no wave events exist anywhere: no placeable
  (feature, wave) pair (`outcomes.total === 0`) AND no wave-attempt, wave-failed
  or hook-veto event at all. An attempt that lacks a feature or wave number cannot
  form a pair, but it still counts in `retries.total`, so it keeps `noWaveData`
  false. This is the EXPECTED state today: committed event logs contain only
  `approved` events, so a fresh clone renders the zeros path (see the Reliability
  template below), not an error.

### Step 4d: Fold per-task blocked reasons from the event logs

Blocked-reason metrics read the OPTIONAL per-task records (`data.tasks`, see
`docs/rad-wave-contract.md`) that newer `wave-attempt` events carry. The counting
lives in `harness/events.js` (`blockedReasonCounts`);
`harness/insights-blocked-reasons.js` aggregates it across features.

```bash
node harness/insights-blocked-reasons.js
```

The output is `{ noEnrichedData, aggregate, perFeature }`.

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
The plan-doc parsing lives in `harness/plan-tasks.js` (`taskFilesFromPlanText`,
merged across plan docs with `mergeTaskFiles`) — shared with the plan-time
`rad forecast` verb. This step passes the mapping to `fileFailureCounts` and
`fileDeficitSignals` in `harness/events.js` — the folds never touch the
filesystem. `harness/insights-blocked-files.js` joins them and prints the result.
`RAD_PLANS_DIR` (default `.agents/plans`) is likewise fixture-only.

```bash
node harness/insights-blocked-files.js
```

The output is `{ mappedTitles, reportedFiles, files, belowFloor, minFeatures, deficits }`.

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
- **`deficits`** — the `fileDeficitSignals` output, splitting per-file trouble by
  deficit PROXY (not a diagnosis): `deficits.files[path]` holds any of
  `opaqueAbstraction` (tasks self-classified `blocked_code`),
  `missingDocumentation` (a task non-passing on an earlier attempt of the same
  feature+wave that later reached `complete`/`done_with_concerns`), and
  `insufficientTesting` (every task in an attempt whose outcome was
  `fail-tests`), each as `{ features, waves ("<feature>#<wave>"), attempts }`.
  Each deficit is floored independently at `deficits.minFeatures` distinct
  features; files with no qualifying deficit count toward `deficits.belowFloor`.
- **`deficits.unattributable`** — contributing task records whose title has no
  plan-doc `File:` mapping, so no file could be named. Never drop silently.
- **`deficits.unenriched`** — attempts with no per-task data (pre-enrichment), so
  they contribute nothing. Never drop silently.

### Step 4f: Fold per-wave-position reliability (model-tiering advisory)

Per-Wave `Model:` tiering (see `docs/configuration.md` "Cost & Frugality") is only worth
suggesting where history shows a wave position is reliably first-try or reliably
retried. The counting lives in `harness/events.js` (`waveReliability`);
`harness/insights-wave-tiering.js` aggregates it across features. The fold
carries sample sizes and applies NO floor; the floor (`TIERING_MIN_FEATURES`,
exported by the module) is a presentation decision owned by this skill.

```bash
node harness/insights-wave-tiering.js
```

The output is `{ noWaveData, advisory, minFeatures, features, positions }`.

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
The counting lives in `harness/events.js` (`cacheUsage`);
`harness/insights-cache-hit.js` aggregates it across features.

```bash
node harness/insights-cache-hit.js
```

The output is one JSON object `{ noCacheData, withoutCache, overallRatioPct,
totals, attempts, droppedToZero }`, preceded by the plain-text line
`no cache data reported` only when `noCacheData` is true.

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

### Step 4f3: Fold spend by model

Since #119 every wave records a `wave-started` event, which carries `data.model`
when the plan declared a `Model:` line. Joining those with `wave-attempt` usage
gives per-MODEL spend and reliability. The counting lives in `harness/events.js`
(`modelTierSpend`, `modelTierAdvisories`); `harness/insights-model-spend.js`
aggregates them across features. The advisory floor is the same
`TIERING_MIN_FEATURES` as Step 4f, applied per model group.

```bash
node harness/insights-model-spend.js
```

The output is one JSON object `{ groups, features, advisories, minFeatures }`.

Reading the output:

- **`groups`** — keyed by model: a declared `Model:` string, `default` (the wave
  recorded `wave-started` but declared no model — the deliver default, whatever
  it was at the time), or `unrecorded` (a pre-#119 wave with no `wave-started`;
  its model is unknowable). Per group: `waves` ((feature, wave) pairs — every
  rate is out of this n), `features` (distinct features), `firstAttemptSuccess`
  / `firstAttemptSuccessPct`, `retried` / `retriedPct` (more than one attempt),
  `tokens` (summed over known-usage waves only), `unknownUsage` (waves with any
  usage-less attempt), and `meanTokens` = `tokens / (waves - unknownUsage)`,
  `null` when no wave in the group reported usage — render `unknown`, never 0.
- **`features`** — distinct features contributing waves across all groups.
- **`advisories[]`** — `{ kind, model, features, waves, meanTokens, unknownUsage }`,
  only for groups with at least `minFeatures` features and never for
  `unrecorded`. `downgrade` — the `default` group succeeded first-attempt in
  every wave. `upgrade` — a group retried in at least 50% of its waves
  (`UPGRADE_RETRY_RATE`); the retried count R is `groups[model].retried`.
- **`advisories: []`** — no advisory fired. Never render an empty list; render
  exactly one of two lines from the Spend by model template below. If no
  non-`unrecorded` group has at least `minFeatures` features, render the
  insufficient-history line (F = the largest such group's `features`, 0 if none).
  Otherwise the floor was met and nothing crossed a threshold: render the
  "No spend advisories: N group(s) met the floor" line, N = the count of
  non-`unrecorded` groups at or above `minFeatures`.

### Step 4f4: Fold spend by provider

Every `wave-attempt` that `rad deliver` appends carries `data.agent` — the selected
adapter kind and, when one applied, the model. Grouping attempts by
`adapter/model` gives per-PROVIDER spend and reliability. The counting lives in
`harness/events.js` (`providerSpend`); `harness/insights-provider-spend.js`
aggregates it across features.

```bash
node harness/insights-provider-spend.js
```

The output is one JSON object `{ groups, features }`.

Reading the output:

- **`groups`** — keyed by `adapter/model`: `command/<model>`, `sdk/<model>`,
  `<adapter>/none` (a tagged attempt that applied no model — e.g. `acp`, or a
  `command` cmd with no `{model}` token), or `unknown` (an attempt recorded before
  provider tagging; its adapter is unknowable). Per group: `attempts` (every rate
  is out of this n), `passed` / `passPct` (outcome `success`), `retries` (attempts
  numbered > 1), `tokens` (summed over attempts that reported usage), `unknownUsage`
  (usage-less attempts, excluded from tokens — never counted as 0), `features`.
- **`features`** — distinct features contributing attempts across all groups.
- **Non-zero exit** — the fold or a log read failed. Omit the Spend by provider
  subsection and continue the report; never stop on it.

### Step 4g: Route recurring signals to prompt surfaces

Some failure signals point at the INSTRUCTIONS the wave agent was given, not at
the code it touched: a recurring `fail-protocol` says the WAVE_RESULT format
instructions are unclear, a recurring `fail-scope` says the plan's scope guidance
is, and recurring `blocked_spec` / `blocked_intent` say the tasks themselves were
under-specified or mis-aimed. This step routes each such signal to the one prompt
surface that shaped it (rationale: `docs/harness-and-framework.md`, "Prompt
surfaces as a feedback-loop target").

The routing is ONE table — `PROMPT_SURFACE_MAP` at the top of `harness/insights-prompt-surfaces.js`. It is data:
to route a new signal, add a row; never add a special case elsewhere. Counts come
from `attemptOutcomeCounts`, `failReasonCounts` (Step 4c) and `blockedReasonCounts`
(Step 4d) in `harness/events.js`; the module compares them with the threshold and
looks up the table. `outcome:*` rows read `attemptOutcomeCounts`, NOT
`outcomeCounts`: the spine records the outcome only on `wave-attempt` events, so
wave-complete outcomes never show a failure on a real log.

```bash
node harness/insights-prompt-surfaces.js
```

The output is `{ threshold, noWaveData, noEnrichedData, proposals, unmapped }`.

Reading the output:

- **Signal names** — `outcome:<outcome>`, `wave-failed:<reason>`, `blocked:<status>`
  (sources above). `count` is the aggregate across features; `features` names each
  affected feature with its own count.
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

### Step 4h: Cycle time, human touches and tokens per delivered feature

Per-feature cycle time, human touches and tokens per delivered feature come from
the folds in `harness/cycle-metrics.js` (`stageDurations`, `humanTouches`,
`tokensPerDeliveredFeature`), called by `harness/insights-cycle-time.js`. What
counts as a touch is a policy decision documented in that module's header.

```bash
node harness/insights-cycle-time.js
```

The output is one JSON object `{ noEventLogs, perFeature, tokens }`; each
`perFeature` entry is `{ durations, touches }`. A malformed events log, or a line
that is not a JSON object, exits non-zero naming the log; report its stderr and
omit the section.

Reading the output:

- **`perFeature[*].durations`** — `approvedToStartMs` (first `approved` → first
  `deliver-started`), `runMs` (first `deliver-started` → last `pr-opened`) and
  `totalMs` (first `approved` → last `pr-opened`), in milliseconds. `null` means an
  endpoint is missing or the timestamps are invalid or run backwards — render it as
  "n/a", never as 0.
- **`perFeature[*].touches`** — `approvals`, `reApprovals`, `needsDecisionStops`,
  `resumes` and `total` (approvals counted once, not re-approvals on top).
- **`tokens`** — `perFeature` lists only delivered features (those with a
  `pr-opened` event); a delivered feature with no recorded usage is `null` and is
  excluded from `mean`.
- **`noEventLogs: true`** — no `events.jsonl` exists anywhere; omit the section.

These values are reporting only. They set no target or threshold, and nothing
reads them to block, warn or gate a command.

### Step 4i: Post-merge rework and Gate-2 verification load

Post-merge rework rate and Gate-2 verification load per delivered feature come from
git history on the default branch (`readDeliveryHistory` in
`harness/delivery-history.js`) and the folds in `harness/delivery-metrics.js`
(`verificationLoad`, `reworkRate`, `trend`, `resolveWindowDays`), called by
`harness/insights-rework-load.js`. What counts as rework is a policy decision
documented in that module's header. The reader uses the **local** default branch,
so update it first (`git fetch` and fast-forward it) for current numbers.

```bash
DEFAULT_BRANCH=$(node harness/cli.js config get default_branch) || { echo "rework/load: cannot resolve default_branch" >&2; exit 1; }
DEFAULT_BRANCH="$DEFAULT_BRANCH" node harness/insights-rework-load.js
```

A non-zero exit (git or `plan_scope_paths` failed, or a malformed events log) is
reported with its stderr and the section is omitted. It never stops the rest of the report.

Reading the output:

- **`load[*]`** — one row per deliver merge, oldest first: `pr`, `files`,
  `linesChanged` (binary files count 0) and `openedToMergeMs` (last `pr-opened` event
  → the merge commit's committer date). `null` means an endpoint is missing or the
  span runs backwards — render it as "n/a", never as 0. `pr` is also `null` on a
  merged row whose commit subject carries no `(#N)`. Rows with `merged: false`
  opened a PR that has no merge on the default branch yet.
- **`rework[*]`** — `rate` (`reworkedFiles / files`; `null` when the merge changed no
  product files), `reworkCommits`, `weightedRework` (each rework touch weighted
  `1 − age/window`, so an early fix counts more) and `windowComplete` (`false` while
  the merge is younger than the window — its rate can still rise).
- **`trends`** — `reworkRate` uses only complete windows; `prSize` uses
  `linesChanged`; `reviewLatency` uses `openedToMergeMs`. Each is `{arrow, n}`:
  older-half mean vs newer-half mean, no floor and no tolerance. Always show `n`.
- **`windowDays`** — from `RAD_REWORK_WINDOW_DAYS`, default 14.
- **`unresolved`** — deliver merges whose feature slug could not be read from the
  commit; they are counted, never guessed.
- **`noMerges: true`** — no deliver merge on the default branch; omit the section.

These values are reporting only. They set no target or threshold, and nothing
reads them to block, warn or gate a command.

### Step 4j: Human corrections

Where a human had to step in after the agent's work: re-approvals, resume answers,
confirmed review findings and fix commits after the deliver PR opened. The rows,
counts and text come from `harness/human-corrections.js` (`parseEventLog`,
`postDeliverFixRows`, `buildCorrections`, `formatCorrections`);
`harness/insights-human-corrections.js` reads the logs and the findings file and
calls those folds. Unlike Steps 4c–4i, this
step applies `--since` itself, on row dates (a row exactly on the boundary is
kept). Set `SINCE` to the `--since` value, or leave it empty. `RAD_FINDINGS_FILE`
exists only for fixture testing.

```bash
SINCE="" node harness/insights-human-corrections.js
```

The output is the formatted text, printed as-is (not JSON). A malformed line in
`findings.jsonl` is skipped with a `skipping malformed JSON at <file>:<line>`
message on stderr and does not fail the step.

A non-zero exit (a malformed events log names the log and line; a bad `--since`;
a failed `git log`) is reported with its stderr and the section is omitted. It
never stops the rest of the report.

Reading the output:

- **Categories** — `reapproval` (second or later `approved` event), `resume-answer`
  (a `run-resumed` event with a non-empty answer), `review-fix` (a finding whose
  `findingVerdict` is `confirmed`) and `post-deliver-fix` (a commit on the feature's
  `rad/<feature>` branch after the `pr-opened` event, excluding `deliver(`,
  `approve:` and `review:` subjects).
- **`Unavailable:` lines** — the feature has no `pr-opened` event or no branch ref,
  so post-deliver fixes could not be counted. Render them as given; never as zero.
- A single empty-state line means no corrections were found.

These values are reporting only. They set no target or threshold, and nothing
reads them to block, warn or gate a command.

### Step 5: Synthesize and output report

Using the data from Steps 3–4i, write the following report. Populate each section
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
[Only with --draft-plans: the drafter's reported stdout (branch + plan path, or
 "nothing to draft") and, on a drafted plan, the three next steps from Step 3b; on
 a non-zero exit, the stderr reason.]

### Ledger Staleness
[From Step 3d: the script's stdout verbatim (it carries its own heading), or on a
 non-zero exit the stderr reason under this heading.]

### Reviewer Calibration
[From Step 3c. Omit this section entirely if findingsLog is false.]
[One line per reviewer in `reviewers`:]
- [reviewer] — [confirmed] confirmed, [falseAlarm] false alarm, [unlabeled] unlabeled;
  [if labeled >= minLabeled:] precision [precision as %], false-alarm rate [falseAlarmRate as %]
  [else:] insufficient labels ([labeled] of [minLabeled] needed)
[If Step 3c reported any malformed lines: "Skipped malformed line(s): [file:line, ...]"]
[Framing — render verbatim under the list:]
A rising false-alarm rate is a signal to revise that reviewer's prompt. Labels come
from the optional `verdict` field on each finding, with a documented keyword fallback
for older findings (`harness/findings.js`). Suggestion only — this skill never edits
a reviewer prompt.

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
[If the fold reports noWaveData: true, render EXACTLY this and nothing else in the
 section (the normal state on a fresh clone):]
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
[If the fold reports noEnrichedData: true, render EXACTLY this and nothing else in
 the section (zeros would be unmeasured, not a clean record):]
No enriched (per-task) wave events exist yet — blocked-reason metrics will
populate once /rad-deliver records wave-attempt events carrying per-task data.

[Otherwise, populate from the aggregate (and perFeature where noted):]
Blocked tasks across [enrichedAttempts] enriched wave attempt(s):
- blocked_code: [N]  blocked_spec: [N]  blocked_intent: [N]
[Name the features contributing blocked tasks from perFeature. If all three are
 0: "No blocked tasks in [enrichedAttempts] enriched attempt(s)."]
[Suggestion only — never edit files. A blocked_spec/blocked_intent majority
 suggests sharper Validate fields or intent; blocked_code points at implementation difficulty.]

### Code Legibility Signals
[From Step 4e. Omit this section entirely if no per-feature events.jsonl exists.]
[Pick EXACTLY ONE degradation line when it applies. After the noEnrichedData or
 mappedTitles-0 line render only the unattributable/unenriched line below (when
 non-zero); after the reportedFiles-0 line still render the deficit breakdown and
 that line, skipping the blocked-task list:]
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

[Deficit breakdown — from `deficits.files`, one line per (file × deficit) present,
 files in path order, deficits in the order below:]
Deficit proxies per file (floor: [deficits.minFeatures] features per deficit):
- [path] — [deficit label]: [attempts] record(s) across [N] features ([features joined]); waves [waves joined] → consider [remedy shape]
...
[Deficit labels and remedy shapes — describe the remedy; never write it:]
- `opaqueAbstraction` → "opaque abstraction" → consider a described boundary/decomposition
  note (what the module owns, where it should split)
- `missingDocumentation` → "missing documentation" → consider a described comment
  explaining the governing constraint the tasks kept tripping on
- `insufficientTesting` → "insufficient testing" → consider a described characterization
  test naming the uncovered behavior
[If deficits.files is empty: "No file meets the per-deficit floor
 ([deficits.minFeatures] features)."]
[State under the breakdown: "These deficit labels are proxies inferred from wave
 outcomes and task statuses, not a diagnosis of the code."]
[Whenever deficits.unattributable or deficits.unenriched is non-zero, render —
 never omit silently:]
[unattributable] failing task record(s) could not be attributed to a file (no plan-doc File: mapping); [unenriched] attempt(s) predate per-task data.
[Suggestion only — name the files; never edit them or propose an automatic change.]

### Model Tiering Advisory
[From Step 4f. Omit this section entirely if no per-feature events.jsonl exists.]
[Pick EXACTLY ONE degradation line when it applies; render nothing else in the
 section except the spend note:]
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
[Suggestion only — never edit plans. High first-attempt success with a low retry
 rate MAY suit a cheaper `Model:` line; a high retry rate may warrant a stronger
 one. Always quote the n; small n is weak evidence.]

[Render this note verbatim in every state, including the degradation states:]
The per-position rates above are outcome-only — they carry no spend. Spend-derived
tiering advice lives in the Spend by model subsection below (Step 4f3), grouped by
the recorded wave model. Recorded `input_tokens` is the uncached remainder, so
token totals vary with cache-hit rate and scheduling — see the Cache-Hit Readout
below (`cacheRead` / `cacheWrite` / `cost`, #121).

#### Spend by model
[From Step 4f3. Render in every state of the section above — this subsection has
 its own floor. If `groups` is empty, render the table header with no rows, then
 the insufficient-history line.]
| Model | Features | Waves | First-attempt % | Retried % | Mean tokens / known-usage wave | Unknown-usage waves |
|-------|----------|-------|-----------------|-----------|--------------------------------|---------------------|
| `[model]` | [features] | [waves] | [firstAttemptSuccessPct]% (n=[waves]) | [retriedPct]% (n=[waves]) | [meanTokens] (n=[waves − unknownUsage])   [meanTokens null: "unknown"] | [unknownUsage] |
...
[One line per advisories entry, in output order:]
[kind downgrade:]
- `default` waves succeeded first-attempt in all [waves] waves across [features]
  features — candidates for a cheaper `Model:` line
[kind upgrade:]
- `[model]` waves retried in [groups[model].retried] of [waves] (≥ 50%) across
  [features] features — consider a stronger model or splitting the wave
[If advisories is empty, render EXACTLY ONE of these two lines instead. F is the
 largest `features` among groups other than `unrecorded` (0 if none); N is the
 count of non-`unrecorded` groups whose `features` ≥ minFeatures.]
[If N is 0 (no non-`unrecorded` group reaches the floor):]
Insufficient history for spend advisories ([F] of [minFeatures] features with
recorded models)
[Else (N ≥ 1 — the floor was met but nothing crossed a threshold):]
No spend advisories: [N] group(s) met the [minFeatures] floor and none crossed a
downgrade or upgrade threshold.

[Render this caveat verbatim in every state:]
`default` means the deliver default model, whatever it was when the wave ran — not
one fixed model. `unrecorded` waves (pre-#119 logs, no `wave-started`) are shown
for completeness but never advised on. Unknown-usage waves are excluded from mean
tokens, never counted as 0.
[Suggestion only — never edit plans, never block. Always quote the n.]

#### Spend by provider
[From Step 4f4. Omit this subsection if Step 4f4 exited non-zero — the rest of
 the report still renders. If `groups` is empty, render the table header with no
 rows. One row per group; split the key on its first `/` into adapter and model
 (`unknown` renders as adapter `unknown`, model `—`).]
| Adapter | Model | Attempts | Pass rate | Retries | Tokens | Unknown-usage attempts |
|---------|-------|----------|-----------|---------|--------|------------------------|
| `[adapter]` | `[model]` | [attempts] | [passPct]% (n=[attempts]) | [retries] | [tokens] | [unknownUsage] |
...

[Render this note verbatim whenever the subsection renders:]
`unknown` = attempts recorded before this change (no `agent` tag on the
`wave-attempt`); its provider is unknowable. `<adapter>/none` means the adapter
applied no model. Unknown-usage attempts add nothing to tokens, never counted as 0.
[Read-only — never edit plans or config, never block.]

### Cache-Hit Readout
[From Step 4f2. Omit this section entirely if no per-feature events.jsonl exists.]
[If noCacheData: true, render EXACTLY this line and nothing else in the section:]
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
[Suggestion only — never edit plans or prompts. A drop to 0% may point at a
 changed prompt prefix or a cache TTL lapse.]

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

### Cycle Time and Human Touches
[From Step 4h. Omit this section entirely if noEventLogs is true.]
[One line per feature in `perFeature`; render a null duration as "n/a":]
- [feature] — approved→start [duration] | run [duration] | total [duration];
  touches [total] ([approvals] approval(s), [reApprovals] re-approval(s),
  [needsDecisionStops] needs-decision stop(s), [resumes] resume(s))
Tokens per delivered feature:
- [feature] — [N] tokens   [or "n/a (no usage recorded)" when null]
Mean: [tokens.mean, or "n/a" when null]
[Framing — render verbatim under the list:]
Reporting only — no target or threshold applies to these values.

### Rework and Gate-2 Load
[From Step 4i. Omit this section entirely if noMerges is true or Step 4i exited
 non-zero (then say why in one line).]
Rework window: [windowDays] days (RAD_REWORK_WINDOW_DAYS, default 14)
[Most recent 10 deliver merges, newest first; null renders "n/a". Join `load` and
 `rework` on `feature`: rework columns (product files only) from `rework`, Files /
 lines (every file) from `load`.]
| Feature | PR | Rework rate | Reworked / files | Weighted | Window complete | Files / lines | Opened→merged |
|---------|----|-------------|------------------|----------|-----------------|---------------|---------------|
| [feature] | [#load.pr, or "n/a" when null] | [rework.rate as %] | [rework.reworkedFiles]/[rework.files] | [rework.weightedRework, 2 dp] | [rework.windowComplete: yes/no] | [load.files] / [load.linesChanged] | [load.openedToMergeMs as duration] |
Trends (older half vs newer half):
- Rework rate: [arrow] (n=[n], complete windows only)
- PR size (lines): [arrow] (n=[n])
- Review latency: [arrow] (n=[n])
[If any load row has merged: false:] Open, not yet merged: [features]
[If unresolved > 0:] [unresolved] deliver merge(s) could not be tied to a feature.
[Framing — render verbatim under the trends:]
Reporting only — no target or threshold applies to these values.

### Human Corrections
[From Step 4j. Omit this section entirely if the step printed only the empty-state
 line or exited non-zero (then say why in one line).]
[Render the step's output: total, per-category counts, top features with their rows,
 and any Unavailable lines.]
[Framing — render verbatim under the output:]
Reporting only — no target or threshold applies to these values.

### Recommended Focus Areas
[Top 2–3 patterns that are both frequent and high-severity. Each as one sentence:
 "Address [category] — appears in [N] cycles ([%]) and always blocks architect review."]
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
- Spend by provider (Step 4f4) MUST come from `providerSpend` in `harness/events.js`;
  the skill only derives the pass-rate percentage. A fold error omits the subsection,
  never the report
- Prompt-surface routing (Step 4g) reads counts ONLY from `attemptOutcomeCounts`,
  `failReasonCounts` and `blockedReasonCounts`; routing lives ONLY in the
  `PROMPT_SURFACE_MAP` table and the threshold ONLY in `PROMPT_SIGNAL_THRESHOLD`.
  Proposals are suggestions — never edit a target file. Any `fail-protocol`
  proposal must preserve the wave-prompt template's #112 prefix-ordering constraint
- All-zero reliability counts are the "no wave data yet" path, not an error — render
  the zeros text from the template and move on
- Findings Recurrence (Step 3b) outputs are suggestions only — never edit AGENTS.md,
  CLAUDE.md or scripts/lint-plan.sh from this skill; every block must carry the
  "Suggestion — apply via PR; never auto-applied" framing
- RAD_FINDINGS_THRESHOLD parses via Number.parseInt; unset/0/NaN/negative → default 5
- Rework and Gate-2 load (Step 4i) MUST come from `readDeliveryHistory` and the folds in
  `harness/delivery-metrics.js`; they are information only — never read to block, warn
  or gate, never turned into a target, and never a Recommended Focus Area on their own
- Human corrections (Step 4j) MUST come from `harness/human-corrections.js`; they are
  information only — never read to block, warn or gate, never turned into a target,
  and never a Recommended Focus Area on their own
- RAD_REWORK_WINDOW_DAYS parses via Number.parseInt; unset/0/NaN/negative → default 14
- The plan drafter (`--draft-plans`, `scripts/draft-insights-plan.sh`) runs ONLY when
  that flag is passed; it writes only the one plan doc and its new
  `rad/insights-proposals-<date>` branch — never pushes, never approves, never
  retries or forces on a non-zero exit. Approval stays a human `/rad-approve` after
  the plan's `[NEEDS CLARIFICATION: …]` markers are resolved
- Reviewer calibration (Step 3c) MUST come from `reviewerCalibration` in
  `harness/findings.js`; rates below `minLabeled` render as "insufficient labels",
  never 0; malformed findings lines are reported by line number, never silently
  skipped. Calibration is suggestion-only — never edit a reviewer prompt
- Deficit breakdown (Step 4e) MUST come from `fileDeficitSignals`; plan-doc parsing
  MUST come from `harness/plan-tasks.js`. Deficits are proxies and remedies are
  described, never written; non-zero `unattributable`/`unenriched` are always rendered
- If the file is missing or empty, say so and exit cleanly
- If fewer than 3 cycles exist, skip pattern analysis and output raw findings
- Do not invent patterns — only report what the data shows
- Hotspot file paths should be exact as recorded in the log
