# Research: Agent Reliability Stack — RAD Gap Review

Created: 2026-07-01
Author: architect
Status: parked
Source: Postman blog, "How we really build production-grade AI agents: beyond models,
toward data and API quality"
(https://blog.postman.com/how-we-really-build-production-grade-ai-agents-beyond-models-toward-data-and-api-quality/)
+ session discussion (2026-07-01). Parked for later revisit — no design work started.

## Article Thesis

Agent reliability comes from three coupled systems — **data quality, API quality,
execution quality** — not from the model. The article proposes a five-layer
"Agent Reliability Stack":

1. **Data layer** — structured, labeled, versioned, observable data
2. **Interface layer** — deterministic, typed, discoverable APIs
3. **Reasoning layer** — models planning under uncertainty
4. **Execution layer** — workflows validating and constraining actions
5. **Governance layer** — policies, auditability, human oversight

Claim: most teams overinvest in the reasoning layer and underinvest everywhere else.
Human-in-the-loop is positioned as a **stable architecture**, not a temporary
compromise. Suggested test for interface quality: "If engineers cannot reliably use
your API from specification alone, neither can agents."

## Where RAD Already Embodies This

The article validates RAD's core bet. Alignment is strongest at the top of the stack:

- **Governance layer** — the `approved` event as sole gate authority, the fail-closed
  PreToolUse deliver-gate hook, fail-closed severity routing, `--on-behalf-of`
  provenance. This is the article's "policies, auditability, human oversight" done
  concretely.
- **Human-in-the-loop as stable architecture** — "humans define intent, agents execute
  structured actions, systems validate, humans approve" is literally the RAD workflow
  (design → plan → approve → deliver → PR review).
- **Execution guardrails** — the frozen 7-outcome matrix, veto-capable fail-closed vs
  observe-only fail-open hooks, scope checking, `RAD_TOKEN_BUDGET`. The article's
  "embed agents into execution paths, not chat interfaces" is what the deliver spine is.
- **Audit trails** — append-only, provenance-frozen `events.jsonl` is the audit-trail
  recommendation, done properly.

The thinner layers are **data** and **interface**, plus one execution-layer capability.

## Actionable Gaps (ranked)

### 1. System-level reliability metrics (execution layer) — RECOMMENDED FIRST
The article: measure success rates, rollback frequency, and error propagation — not
per-prompt quality. RAD already **records** everything needed (wave outcomes, retries,
`wave-failed` reasons, token usage, hook vetoes, re-approvals) but `/rad-insights`
only aggregates `findings.jsonl`. Extend rad-insights to fold over `events.jsonl`
across features: wave success rate by outcome, retry frequency, token spend per wave,
`fail-scope` vs `fail-tests` distribution. Cheap (read-side only, no new events);
turns the event log from an audit trail into the feedback loop the article calls for.

### 2. Machine-readable plan schema (interface layer)
The plan doc is the API between architect and deliver spine, currently markdown
conventions parsed by scripts (`lint-plan.sh`, wave-block parsing, `File:` / `Model:`
lines); the wave contract lives in `docs/rad-wave-contract.md` prose. The article's
spec-alone test applies directly. Action: a formal plan-doc schema — even a stricter
lint validating structure, required headers, and wave-block shape — so a malformed
plan fails at lint time rather than mid-deliver. Pattern precedent already exists in
`gates.yaml` / `matrix.yaml`.

### 3. Deterministic replay (execution layer)
The article calls out deterministic replay specifically. RAD's gate fold is pure and
replayable, but a deliver **run** is not — a wave sequence cannot be re-driven from
the event log to reproduce a failure. Most expensive item; possibly not worth it yet,
but the event-sourced foundation means RAD is closer than most. Named, not urged.

### 4. Close the findings loop (data layer)
The article: "failures improve both data and APIs." `findings.jsonl` captures
failures; nothing feeds recurring findings back into the system's data. Action: small
addition to `/rad-insights` or `/wrap` — when a finding category recurs N times,
suggest the corresponding CLAUDE.md convention line or lint rule.

## Caution

The article is Postman marketing for API tooling; its "agent-ready API" checklist
targets agents *calling business APIs* — a different problem than RAD's (agents
executing code changes). Do not import the API-governance framing wholesale; items
1 and 2 are where its logic genuinely transfers.

## Recommendation

Item 1 (insights over `events.jsonl`) is the clear winner — high value, low cost,
pure read-side, and it is the piece of the article's stack RAD has data for but no
view of. Item 2 is a good second. Items 3–4 are noted for later.
