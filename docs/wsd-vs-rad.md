# WSD vs RAD

A point-by-point comparison of Walking Skeleton Development (WSD) against RAD —
where the two converge, where they genuinely differ, and which WSD ideas are worth
adopting, deferring, or declining. Like the Cosmos and CUGA reviews in
[`references.md`](references.md), the headline finding is again **convergent design
validation**: a third independent framework landed on RAD's substrate bets.

The load-bearing difference this time is not ownership (Cosmos) or autonomy (CUGA).
It is **which half of the problem the framework claims**. WSD prescribes *how to
slice the work*; RAD prescribes *how to prove what happened*.

Source: a self-description of the WSD framework — its stated composition (Walking
Skeleton Development / standards / the vault / Codex + Claude plugins) and its
declared methodological ancestry.
Captured: 2026-09-02

> **Read this with one caveat.** The Cosmos review assessed a published artifact.
> This one assesses a *description* — a methodology statement, not source. Every
> claim below about what RAD does is grounded in a file or a script; claims about
> WSD are grounded only in its own account of itself. In particular, **whether WSD
> enforces any of its disciplines is not visible from the description**, so the
> enforcement asymmetry noted in the verdict is a genuine unknown, not a finding
> against it.

---

## What WSD Is

WSD describes itself as "evidence-driven, capability-sliced, human-governed agentic
development," composed of four parts:

1. **Walking Skeleton Development** — the construction method: establish the
   smallest composed end-to-end path, then thicken it.
2. **standards** — the universal discipline floor.
3. **the vault** — the knowledge and coordination system.
4. **Codex/Claude plugins** — runtime-specific execution bindings.

It names its ancestry directly and unusually thoroughly: Cockburn's walking
skeleton, Hunt and Thomas's tracer bullets, the Toyota Production System (jidoka,
andon, poka-yoke), Lean Software Development, Continuous Delivery, DDD, Shape Up,
Reinertsen's product-development flow, Popper and Lakatos on asymmetric
falsification, and a selective reading of the TDD tradition. A second tier of
influences — vertical slicing, outside-in development, BDD/ATDD principles,
contract-first design, hexagonal architecture, evolutionary architecture, Kanban,
eval-driven development, docs-as-code and ADRs, linked-note PKM, information
radiators, structured-concurrency ownership, security by design, and
human-in-the-loop governance — is described as embodied rather than credited.

---

## The Comparison

| Dimension | WSD | RAD |
|-----------|-----|-----|
| Construction method | Walking skeleton: smallest composed end-to-end path, then thicken | Waves: tasks grouped by dependency profile, sized to a context budget |
| Work slicing | Actor-visible capability; never frontend/backend/test phases | Dependency order; a layer sequence is the *documented-correct* example |
| Discipline floor | `standards` — universal | `ai/guardrails.md` baseline + conditional `ai/extensions/*` + `ai/slop-register.md`, with an explicit precedence ladder |
| Knowledge system | The vault: MOCs, backlinks, graph traversal, provenance, lifecycle | Append-only `events.jsonl` folded by pure functions; flat `.agents/` artifacts; `findings.jsonl` |
| Runtime binding | Per-runtime plugins (Codex, Claude) | One frozen provider-neutral contract, two adapters (`RAD_AGENT=command\|sdk`) |
| Architecture | Evolutionary — learned by walking real capabilities | Front-loaded — `/rad-design` fixes boundaries before the first plan, then `check-scope.sh` enforces them |
| Testing stance | Selective, warranted tests rather than universal test-first | Universal — every behavior change ships a test in the same commit |
| Evidence discipline | Asymmetric falsification; eval-driven with fixtures, baselines, variance | Defect-hunting reviewers; ground-truth labels collected, graders uncalibrated |
| Flow control | Kanban: explicit states, WIP limits, readiness gates, blocked work | Explicit states + gates; no WIP limit, no blocked state beyond the `fail-*` terminals |
| Enforcement | Stated as discipline; not visible from the description | Fail-closed in code: pure-fold gate authority, PreToolUse hook, no-default-fallthrough resolver |

---

## Construction: the load-bearing divergence

This is the one dimension where the two frameworks are not describing the same
thing in different words.

WSD's central move is to carve work into **actor-visible capabilities** and forbid
frontend/backend/test phasing. RAD's wave rule is **dependency profile**, and
[`wave-execution.md`](wave-execution.md) presents a layer sequence as the
canonical *correct* decomposition:

```
# Correct
Wave 1 (sequential)
  Task 1.1: Add PlannedAbsence SQLAlchemy model
Wave 2 (sequential)
  Task 2.1: Add PlannedAbsence to API response schema
```

Model, then schema, then routes. That is precisely the shape WSD forbids.

RAD's slicing is further constrained by **context economics** rather than by
capability: max 3 tasks per wave, max 5 waves per plan, each task sized to roughly
half a fresh context window, and a `lint-plan.sh` line budget that warns at 800
and blocks approval at 1500. Those are limits on *what fits*, not on *what a user
can observe working*.

Nothing in RAD requires an end-to-end path at all. A grep for walking skeleton,
tracer bullet, vertical slice, or thin slice returns nothing outside test-related
uses of "end-to-end." The per-wave `Verify:` gate is opt-in, and the default gate
(`check-tests-present.sh`) is a file-*presence* check. A plan can pass lint, clear
Gate 1, and deliver without a single composed path ever having been run.

**RAD already knows this question is open.** Issue
[#47](https://github.com/seanrreid/RAD_framework/issues/47) — "clarify
wave-decomposition rationale: outcome-checkpointing vs context-fitting" — is
exactly this ambiguity, filed off the *Hidden Technical Debt* review. WSD has an
answer to it. RAD has an issue.

The tension is real and should not be resolved by adopting WSD wholesale: waves
exist *partly* to fit context windows, and capability slices do not respect
context budgets. The prize is a rule that satisfies both — see the verdict.

---

## Architecture: front-loaded vs evolutionary

WSD holds that architecture is learned by walking real capabilities rather than
designed upfront. RAD does the opposite on purpose: `/rad-design` consumes a
research artifact and produces the agent hierarchy and the CLAUDE.md Agent Scope
Map **before any plan exists**, and `scripts/check-scope.sh` then enforces those
boundaries on every delivered change.

That is a deliberate bet — in RAD, the boundaries *are* the product — but it is
anti-evolutionary in WSD's sense, and RAD's own reading log already flags it as
the framework's single honest exposure to the Bitter Lesson (issue
[#46](https://github.com/seanrreid/RAD_framework/issues/46): audit the agent
hierarchy for boundary vs context-chunking). WSD's position is a second,
independent vote that the front-loaded half deserves the scrutiny #46 asks for.

One clarification worth making, because the shared vocabulary invites a category
error: RAD's "boundaries" are **authority and file scope** — who may touch what.
The Agent Scope Map is a permissions matrix, not a DDD context map. When WSD cites
bounded contexts it means domain modeling. Same word, different referent; the two
should not be scored against each other.

---

## Standards: the closest thing to a direct hit

WSD's "universal discipline floor" maps almost exactly onto RAD's `ai/` tree, down
to the conflict-resolution semantics:

- `ai/guardrails.md` — the always-applied baseline.
- `ai/extensions/{backend,database,frontend,security,testing}.md` — loaded
  conditionally when the filename, `Applies When` section, changed paths, or the
  request match. Explicitly *not* all loaded by default.
- `ai/slop-register.md` — repo-specific forbidden patterns, required conventions,
  and layering rules.
- An explicit precedence ladder: user request → slop register → domain extension →
  baseline, with the rule that an extension "may make rules stricter or more
  specific" but may never "silently weaken baseline safety rules."

That last clause is the same monotonicity property RAD enforces mechanically
elsewhere: `RAD_SELF_PROTECTED_PATTERN` in `scripts/lib/plan-paths.sh` refuses to
classify a plan touching RAD's own machinery as low-risk **before** consulting the
operator allowlist, so no `RAD_LOW_RISK_PATTERNS` value — including `.*` — can
clear a change to the thing doing the clearing.

**Nothing to adopt here.** The convergence is close enough that it mostly confirms
both frameworks found the same shape for the same reason.

---

## The vault vs the event log: same job, opposite form

Both frameworks maintain a durable knowledge and coordination layer. They optimize
for opposite consumers.

- **The vault optimizes for human traversal**: MOCs, backlinks, graph traversal,
  provenance, lifecycle maintenance. Association is the primitive.
- **RAD's log optimizes for machine authority**: `events.jsonl` is append-only,
  folded by pure functions (`phaseOf`, `evaluateGate`, `resumeFrom`,
  `totalUsage`), with authority frozen into the event at write-time. Determinism
  is the primitive.

RAD has no backlinks, no MOC, no supersession, and no graph. Its artifacts
(`.agents/research/`, `architecture/`, `epics/`, `plans/`, `logs/`,
`findings.jsonl`) are flat markdown and JSONL.

This is the same gap the Cosmos review named as the "soft-knowledge store" — the
deferred half of portable memory. **WSD's vault is a strictly better answer to it
than Cosmos's was**, because it keeps the substrate bet intact: a vault is files
in git the operator owns, not a vendor-hosted Knowledge Base. That makes it
adoptable where Cosmos's mechanism was not.

The constraint on adopting it is the one that has held since Gate 1 was designed:
a derived, human-navigable view is welcome; it may **never** become gate authority.
The `approved` event on the branch tip stays the sole authority, checked by a pure
fold. A vault layer over `.agents/` is a *read* surface.

---

## Runtime bindings: RAD's contract is stricter than a plugin

WSD ships "runtime-specific execution bindings" — a Codex plugin and a Claude
plugin. RAD inverts this: one **frozen, provider-neutral contract**
([`rad-wave-contract.md`](rad-wave-contract.md)) with two adapters behind a single
injected seam.

`spine.js:249` is the only place the model is ever called, `runWave` arrives by
injection, and the spine never imports a model SDK. The adapters
(`RAD_AGENT=command` spawning any operator CLI; `RAD_AGENT=sdk` driving the Claude
Agent SDK) are interchangeable *because* the contract, not the binding, is the
stable artifact.

Per-runtime plugins re-implement the integration once per runtime and let the
runtimes diverge. A contract with adapters makes divergence structurally
impossible — the 7-outcome vocabulary is frozen at the seam and `safeVetoOutcome`
coerces anything outside it to `abort-user`. **On this dimension RAD is ahead, and
it is a design difference rather than a maturity one.**

---

## Ancestry RAD embodies without naming

Several sources WSD credits explicitly are load-bearing in RAD and go entirely
uncited. This is a documentation gap in RAD, not a design gap.

| Source | Where it already lives in RAD |
|---|---|
| **Toyota — jidoka, andon, poka-yoke** | "Fail-closed is the default at every gate" (CLAUDE.md conventions); `fail-scope` → abort is stop-the-line; the doom-loop breaker (`spine.js:375-406`) halts on a repeated identical failure rather than burning the retry budget; self-protected paths are poka-yoke |
| **Continuous Delivery — executable gates** | The harness thesis. Issue [#91](https://github.com/seanrreid/RAD_framework/issues/91) is this principle discovered independently: `check-tests-present.sh` checks file *presence* (a wave can create every promised test, have all of them fail, and still advance) while `check-verify.sh` runs a declared command and reads its **real** exit code |
| **Contract-first / Design by Contract** | The frozen 7-outcome vocabulary; `resolveOutcome` (`matrix.js:54-69`) with *no default fallthrough* — an unrecognized outcome is an error, not a guess; typed `WAVE_RESULT` / `RESEARCH_SUMMARY` blocks at every hand-off |
| **Clean / Hexagonal architecture** | `spine.js:133-146` takes every dependency by injection — model, shell, clock, StateStore. Textbook ports and adapters |
| **Shape Up — the forcing function** | Gates 0/1/2. RAD's are *enforced*: the `approved` event is sole authority via a pure fold, plus a deterministic PreToolUse hook that blocks an unapproved `/rad-deliver` |
| **BDD/ATDD without ceremony** | `lint-plan.sh` requires numbered, testable Acceptance Criteria and warns when a task's `Validate:` line does not cite an `AC#`. Same refusal of Gherkin |
| **Docs-as-code / ADRs** | [`framing-decisions.md`](framing-decisions.md) is an ADR set in all but name — idea → decision → where it lives → why, written so "future work doesn't relitigate a settled fork." Missing only numbering and supersession |
| **Information radiators** | `/rad-status`, `/rad-insights`, `/kickoff`, and the `rad:*` label mirror |
| **Security by design** | `check-verify.sh` runs declared commands under `env -i` with an allow-listed subset (`PATH HOME LANG LC_ALL TMPDIR TERM`), so no exported credential reaches the command; bounded output; hard timeout |
| **Structured-concurrency ownership** | `owner-claimed` / `owner-released` events and the fail-closed divergence tripwire; every wave sub-agent is owned through to a collected `WAVE_RESULT` |

The most striking of these is Toyota. Jidoka is arguably RAD's most pervasive
single pattern and appears nowhere in its documentation by name.

---

## Evidence discipline: the gap RAD already documented

WSD claims two things RAD does not do.

**Asymmetric falsification (Popper, Lakatos).** Positive corroboration and
counterexample-seeking are different jobs. RAD's `quality-reviewer` and
`accessibility-reviewer` hunt defects; there is no corroboration pass, and no
structural separation between the two activities.

**Eval-driven development.** Representative fixtures, baselines, variance,
semantic acceptance. RAD explicitly scopes this out — evaluating the BYO wave
agent's task quality is the operator's job.

The scoping-out is defensible for the *wave agent*, which is opaque by design. It
is weaker cover for RAD's **own** graders. The LangChain review already recorded
this precisely: the LLM-as-judge reviewers are "never calibrated, unknown
false-alarm rate," while `.agents/findings.jsonl` already holds the ground-truth
labels (`false-alarm` vs confirmed) that would calibrate them. Issues
[#48](https://github.com/seanrreid/RAD_framework/issues/48) (findings →
reviewer-calibration precision readout) and
[#49](https://github.com/seanrreid/RAD_framework/issues/49) (positive/negative
reviewer fixtures in CI) are open against exactly this.

WSD does not reveal a gap here so much as supply **vocabulary for one RAD had
already found**: the corroborate/falsify split is a concrete method to attach to
#48 and #49, which currently describe the instrumentation without the discipline.

---

## Flow control: states without limits

RAD has explicit states (phases in the event log, the `rad:*` label mirror),
readiness gates, and completion gates. It has **no WIP limit** and no modeled
blocked state beyond the `fail-*` terminals — `fail-timeout` surfaces to a human,
but "blocked" is not a phase the log can hold.

One `rad/[feature]` branch cradle-to-grave is an implicit WIP-1 *within* a feature.
Nothing caps concurrent features, and nothing makes contention visible; the
`owner-claimed` events come closest but exist for divergence safety, not flow.

This is a small, real gap. It is also the least urgent thing on the list at RAD's
current scale, and Kanban limits imposed on a single-operator framework are
ceremony. Noted, not filed.

---

## Testing stance: RAD is the stricter one

Worth recording because the direction is surprising. WSD advocates "selective,
warranted tests rather than universal test-first." RAD's CLAUDE.md convention is
categorical — "every behavior change ships a test in the same commit" — backed by
a required `## Tests to Write` plan section and the `check-tests-present.sh` gate.

RAD is *more* prescriptive than WSD here, deliberately, and nothing in the WSD
description argues RAD should relax it.

---

## Verdict

- **Convergences (validation, adopt nothing):** the discipline floor with a
  precedence ladder, human-governed staged gates, contract-first seams,
  hexagonal/injected boundaries, information radiators, security-by-design at the
  execution boundary, ADR-shaped decision records. Same family as the Cosmos and
  CUGA findings — a third independent team converging on RAD's substrate bets.

- **Genuinely new relative to RAD:**
  - *Walking-skeleton construction* — the real divergence. RAD slices by
    dependency and context budget; WSD slices by actor-visible capability and
    requires a composed end-to-end path first. RAD has no equivalent constraint at
    any gate.
  - *Asymmetric falsification* — a method to attach to the already-filed
    reviewer-calibration work (#48, #49).
  - *Evolutionary architecture* — a second vote for the scrutiny #46 already asks
    for, though RAD's front-loading is a deliberate bet, not an oversight.
  - *Kanban WIP limits* — a real absence; low priority at current scale.

- **Steal-with-modification:**
  1. **A walking-skeleton lint rule** — require Wave 1 to declare a composed
     end-to-end path *and* carry a `Verify:` line. This lands entirely in existing
     machinery (`lint-plan.sh` + the opt-in `Verify:` gate), and it resolves #47 by
     answering "outcome-checkpointing vs context-fitting" with **both**: the
     skeleton wave is the outcome checkpoint, later waves stay context-sized.
  2. **The corroborate/falsify reviewer split** — two passes with different jobs,
     scored against the `findings.jsonl` labels already being collected. Method for
     #48/#49.
  3. **A vault-shaped read layer over `.agents/`** — backlinks, provenance,
     supersession as a *derived view*, never gate authority. Better answer to the
     soft-knowledge gap than Cosmos's hosted KB, because it stays in plain git.
  4. **ADR numbering and supersession for `framing-decisions.md`** — cheap; the
     doc already has the shape.

- **Declined:** capability slicing adopted wholesale. Waves exist partly to fit
  context windows, and capability slices do not respect context budgets. Adopt the
  *skeleton-first* constraint (recommendation 1); keep dependency-and-budget
  slicing for the thickening waves.

- **Settled RAD decisions challenged:** none. The construction/proof split is the
  load-bearing difference and it is complementary rather than competing — WSD's
  slicing discipline drops into RAD's existing plan-lint and `Verify:` machinery
  with little friction, and RAD's enforcement story is orthogonal to it.

- **Issues filed:** none yet. The four steal-with-modification items are
  candidates; #46, #47, #48 and #49 already cover the ground the first two would
  extend.

---

## See also

- [references.md](references.md) — the running log of external sources reviewed against RAD
- [cosmos-vs-rad.md](cosmos-vs-rad.md) — the prior full comparison, same format
- [framing-decisions.md](framing-decisions.md) — RAD's settled stances
- [harness-and-framework.md](harness-and-framework.md) — the harness/framework identity
- [wave-execution.md](wave-execution.md) — the decomposition model this comparison challenges
