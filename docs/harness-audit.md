# RAD Harness Audit

> Status: draft for discussion
> Branch: `rad/harness-audit`
> Question being answered: *What would a harness for RAD involve, and should we
> build a new one or migrate the existing commands?*

---

## Method

Every step of every command was bucketed into one of three kinds of work:

- **DET — deterministic.** Git, file I/O, parsing, gating, looping, state
  transitions, templated output. No model needed. Already mostly implemented as
  `scripts/*.sh`.
- **MODEL — judgment.** Work that genuinely needs an LLM: research synthesis,
  architecture design, plan authoring, implementation, review.
- **HUMAN — a gate or required input.** A point where a person must decide
  (approve/reject) or supply information the system cannot derive. **Irreducible
  — a harness pauses here, it does not automate it away.**

The thesis a harness rests on: *control flow should be DET code that calls the
model at MODEL points and pauses at HUMAN points.* Today, control flow is prose
the model re-interprets each run.

---

## Per-command bucketing

| Command | DET | MODEL | HUMAN | One-line read |
|---|---|---|---|---|
| `rad-status` | ~100% | — | — | A one-line wrapper around `rad-status.sh`. Pure DET. |
| `rad-insights` | ~85% | 1 step | — | All jq aggregation + one narrative-synthesis call. |
| `rad-approve` | ~90% | render only | **1 gate** | DET scaffolding around the single approval decision. |
| `rad-status`/`quality-review`/`accessibility-review` | wrapper | 1 agent | — | Thin standalone entry points to one agent each. |
| `rad-plan` | scaffolding | 2 calls | — | Explore research + plan authoring, wrapped in git/lint DET. |
| `rad-adopt` | scaffolding | 3 calls | 1 confirm | `rad-plan` + an issue-fetch front-end + an interpret-confirm. |
| `rad-deliver` | orchestration | N+1 calls | — | DET wave-loop (retry, gate, log) around N implementation calls. |
| `rad-review` | checks + persist | 3 agents | — | Parallel reviewers + DET scope/test checks + findings append. |
| `rad-research` | templating | extract | **interview** | Mostly a structured human interview; DET only writes the file. |
| `rad-design` (draft) | read/write | **design** | **gate** | One big design call + architect approves the draft. |
| `rad-design` (gen) | scope-map | templated gen | paste step | Parallel file generation from the approved spec. |

### Step-level notes that matter for the design

- **`rad-deliver` is the headline.** Steps 1–3, 8–11 are pure DET (branch
  validate, approval gate, rebase, scope/test checks, PR open). The wave loop
  (Step 6) is DET control flow — *"retry at most twice, escalate on the third,"*
  *"proceed only if `status: complete`,"* *"parse the `WAVE_RESULT` block"* — with
  MODEL implementation calls nested inside. That control flow is exactly what
  `pipeline()`/`parallel()` + plain JS give you reliably and for free. The 336
  lines of prose collapse to a short DET driver with `agent()` calls inside.
- **`rad-approve` is 90% script around one HUMAN gate.** The proxy-flag
  validation, role check, lint, status check, status-write, commit, label — all
  DET. The model's only real job is rendering the plan summary. The gate is
  irreducible and stays.
- **`rad-plan` and `rad-adopt` are ~90% the same command.** Adopt = plan with a
  different input source (issue fetch + interpret-confirm) and one extra plan
  section (`## Issue Gaps`). Two files maintaining one workflow.
- **`rad-review` already wants to be `parallel()`.** Quality, accessibility, and
  plan-fidelity are independent reviewers fanned out over the same diff. Step 7
  (append findings to `findings.jsonl`) is DET JSON work currently done by the
  model parsing text — a fragile spot that should be code.
- **`rad-research` is the least harness-able.** It is a structured interview:
  confirm the spec read, ask five setup questions, derive roles/platform. The
  model + human dialog *is* the work; DET only templates the artifact at the end.
  A harness still pauses for every answer.
- **`rad-design` mode-detection is a DET state machine** (draft → architect flips
  `Status` → generate). The "print the scope map for the architect to paste"
  step is a manual hand-off a harness *could* automate, but it is deliberately
  manual today.

---

## Aggregate findings

**1. Determinism dominates.** Across ~2,000 lines of command prose, easily
60–70% is DET control flow and git/file plumbing — currently expressed as
natural-language instructions the model must faithfully re-execute every run.
This is the part that drifts (re-reading a file it was told not to, miscounting
retries, skipping a log write) and the part that costs tokens to re-derive.

**2. The judgment is small and well-bounded.** There are only ~8 distinct kinds
of MODEL call in the entire framework:

1. Spec extraction/synthesis (`rad-research`)
2. Architecture design (`rad-design` draft)
3. Codebase research — the Explore agent (`rad-plan`/`rad-adopt`)
4. Plan authoring (`rad-plan`/`rad-adopt`)
5. Wave implementation — N calls (`rad-deliver`)
6. Test writing (`rad-deliver`)
7. Reviewers: quality, accessibility, plan-fidelity (`rad-review`)
8. Report synthesis (`rad-insights`)

Each already has a tuned prompt with an output contract (bounded summaries, line
budgets, `RESEARCH_SUMMARY`/`WAVE_RESULT` blocks). These are reusable as `agent()`
bodies almost verbatim.

**3. Two irreducible HUMAN gates** (plan approval, PR merge) plus one
architecture-draft approval and the research interview. These define where the
harness *pauses*. Removing them would defeat RAD's purpose; the harness removes
the bottleneck of *driving mechanical steps*, not the bottleneck of *judgment*.

**4. The state machine and typed hand-offs already exist.** Plan `Status:`
(`pending-review → approved → in-progress → complete`) on branch tips is exactly
the durable, resumable state a harness needs to pause-at-gate and resume. The
artifacts (`research.md`, `architecture.md`, `plan.md`, execution log,
`findings.jsonl`) are the typed interfaces between phases.

---

## The strategic question: new harness vs migrate?

The audit reframes this. **RAD's commands already *are* a harness — authored in
the wrong language.** The orchestration is written as English the model
interprets, instead of code that calls the model. So "migrate" does not mean
"keep the prose"; it means *extract the control flow into code while reusing the
parts that are already right.*

What is already built and reusable as-is:

| Asset | State | Reuse in a harness |
|---|---|---|
| 13 guardrail scripts | tested, bash 3.2, with own test scripts | **Called** by the harness, unchanged |
| State machine (Status + branch tips) | designed-in | The resume/gate mechanism |
| Phase artifacts + sections | specified | Typed state passed between stages |
| Sub-agent prompts + output contracts | tuned | `agent()` bodies, near-verbatim |
| Role + gate model | enforced by `check-role.sh` | Gate/pause points |

What actually gets rewritten: only the ~60–70% that is control-flow-as-prose.

**Assessment.** Building a brand-new harness and cherry-picking would re-derive
the expensive, boring, correctness-critical layer (the scripts, the state
machine, the contracts) that is *already done and tested*. The consolidation you
want from a clean rebuild (killing the `plan`/`adopt` duplication, demoting the
review wrappers) you get from the migration anyway — because moving sequencing
into code is precisely what lets you dedupe. You do not need to abandon RAD to
dedupe RAD.

**Recommendation: migrate, but the first deliverable is a new artifact — the
harness spine.** It will feel like building new (a fresh JS/SDK driver) while
reusing ~100% of the hard parts. The honest one-liner: *we are replacing the
language the orchestration is written in, not the orchestration's design.*

The case for a genuine greenfield rebuild only holds if a future decision
invalidates a core asset — e.g. abandoning the artifacts-on-branch-tips model, or
moving off shell guardrails entirely. If those stay, migration strictly
dominates. **This is the open decision for discussion** (see below).

---

## Consolidation map (the "fewer skills" payoff)

The 11 commands collapse to ~4 surface entry points once sequencing lives in code:

```
TODAY (11, human-sequenced)            AFTER (harness-driven)
  rad-research  ─┐                       /rad <feature>      ← the spine: detects phase from
  rad-plan       │                                              branch/plan state, runs forward to
  rad-adopt      ├─ phases of one ──►                            the next HUMAN gate, resumable.
  rad-deliver    │  lifecycle                                    Absorbs research/plan/adopt/
  rad-review    ─┘                                               deliver/review as internal stages.
                                                                 (adopt = plan with issue input)
  rad-approve     ── Gate 1 (human) ──►  /rad-approve        ← stays. The approval decision.
  rad-design      ── setup + gate ────►  /rad-design         ← stays. Once-per-project, own gate.
  rad-status     ─┐                      /rad-status         ← absorbs insights (--insights flag)
  rad-insights   ─┘ observability ───►
  quality-review ─┐ agents, not      ►   (invoked inside /rad review; keep thin
  accessibility- ─┘ top-level cmds        wrappers only for standalone use)
```

à-la-carte preserved: the spine is the default door, but each phase stays
individually invokable for mid-flow / existing-repo / one-off cases.

---

## Recommended migration order (lowest risk first)

1. **`rad-deliver` → harness spine prototype.** Highest value, cleanest
   DET/MODEL split, and the wave loop is where prose-as-control-flow is most
   fragile. Prove the pattern here: `pipeline()` over waves, `agent()` per task,
   DET retry/gate/log, existing scripts for branch/scope/PR.
2. **`rad-review` → `parallel()` reviewers + DET findings append.** Removes the
   fragile model-parses-JSON step; immediate reliability win.
3. **Merge `rad-plan` + `rad-adopt`** behind one stage with input detection.
4. **Wrap the spine** (`/rad <feature>`) that sequences research → plan →
   *(pause: approve)* → deliver → review off the Status state machine.
5. **Leave `rad-research`, `rad-design`, `rad-approve` as gated/interactive
   entry points** — they are mostly HUMAN/dialog and benefit least from
   code-orchestration.

---

## Decisions so far

- **Substrate: the in-editor `Workflow` tool** (JS, model-as-subagent, native to
  Claude Code). Chosen for zero setup and tight editor integration — best for
  prototyping the spine fast. The deterministic guardrail scripts are called via
  `Bash` from inside the workflow; the 8 model calls become `agent()` with their
  existing output contracts as `schema`. Revisit only if a headless/CI run with
  no human present becomes a hard requirement (then: Agent SDK).

## Open questions — PARKED (resume here)

1. **Greenfield trigger (the hinge — UNANSWERED).** Is any core asset on the
   table to *change*, not just reorganize? — (a) artifacts-on-branch-tips,
   (b) shell guardrails, (c) the Status state machine. **If all three stay,
   migration strictly dominates and a rebuild pays twice. If any is being
   rethought, scope a greenfield instead.** This decision gates everything below
   it; answer it before writing harness code.
2. **Readability cost.** Prose commands are auditable by a non-engineer
   architect. A JS harness is less so. How much do we weight that, and can the
   logging (`.agents/logs/`) + readable gate/policy files offset it?
3. **à-la-carte vs spine.** Do we keep every phase individually invokable
   (more surface, more flexible) or commit to the spine as the primary
   interface (less surface, less escape-hatch)?

## Next action when resuming

Prototype **`rad-deliver` as a `Workflow` spine** (migration step 1): `pipeline()`
over waves, `agent()` per task with the `WAVE_RESULT` schema, deterministic
retry/gate/log, and the existing `scripts/*.sh` (checkout, check-scope,
check-tests, open-pr) called via `Bash`. This proves the DET/MODEL split on the
highest-value, most-fragile command before committing to the full migration.
**Blocked on open question #1 only if it touches branch tips or the state machine.**
</content>
</invoke>
