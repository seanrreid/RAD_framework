# External References & Reading Log

> An annotated log of external sources (articles, harnesses, talks) reviewed against
> RAD, and what each one taught us. Where [framing-decisions.md](framing-decisions.md)
> records RAD's *settled stances*, this doc is the *running input* — the prior art and
> ecosystem ideas we read, our takeaway, and any issues a source generated.
>
> Add a new entry when you review an external source against RAD. Newest first.

---

## How to read this doc

Each entry follows the same shape:

- **Source** — title and link.
- **Reviewed** — the date we assessed it.
- **Takeaway** — what it means for RAD: a gap, a validation, or a transferable idea.
- **Issues** — anything filed as a result.

---

## Agent harness analyses

### Flue — The Open Agent Framework (Astro team)
- **Source:** [flueframework.com](https://flueframework.com/) · [`withastro/flue`](https://github.com/withastro/flue) · [Flue 2 announcement](https://flueframework.com/blog/flue-2/)
- **Reviewed:** 2026-09-11
- **Takeaway:** A TypeScript agent *runtime* (hooks-based agent functions, durable
  append-only conversation streams, opt-in sandboxes, `flue run` for CI) — the
  engine behind the Astro triage bot assessed 2026-08-05. Below RAD's BYO seam,
  so no architectural steal; Flue 2.0 even deleted its workflow system. But its
  durability contract ("exactly-once recording, at-least-once execution":
  record the submission *before* model work, converge orphaned attempts on
  recovery, then classify) exposed a real gap: RAD appends `wave-attempt`
  *after* `runWave` returns, so a crash mid-wave records nothing — resume
  re-runs blind, the attempt budget and `RAD_TOKEN_BUDGET` are bypassable by
  crash-looping. Also found `rad-wave-contract.md` misstating the (actually
  fail-closed) task-status coercion; corrected. Flue's `blueprints/` are #50's
  pinned playbooks shipped (versioned, primary-file marker, cumulative upgrade
  guide). Default-deny-by-hook capabilities and their two-token LLM/deterministic
  split corroborate #85; an approver allowlist changed only via PR corroborates
  #87. Note: their own `AGENTS.md` says "No tests exist in the repo." Full
  breakdown: [flue-vs-rad.md](flue-vs-rad.md).
- **Issues:** [#119](https://github.com/seanrreid/RAD_framework/issues/119)
  (record `wave-started` before `runWave`; converge orphans on resume);
  comments on #50, #85, #87, #95, #110, #112.

### WSD — Walking Skeleton Development
- **Source:** WSD framework self-description (composition + declared methodological
  ancestry), provided directly rather than read from a published artifact — unlike
  every other entry here, this review assessed a *methodology statement*, not code
  or a public post. Claims about WSD's enforcement are therefore unknown, not absent.
- **Reviewed:** 2026-09-02
- **Takeaway:** A third independent convergence on RAD's substrate bets (after
  Cosmos and CUGA) — staged human governance, a universal discipline floor with a
  precedence ladder, contract-first seams, hexagonal boundaries, information
  radiators. Load-bearing difference: **which half of the problem each framework
  claims.** WSD prescribes *how to slice work* (smallest composed end-to-end path,
  actor-visible capabilities, never layer phases); RAD prescribes *how to prove
  what happened* (pure folds, frozen vocabulary, fail-closed gates). Complementary,
  not competing. The genuine divergence is decomposition: RAD's waves slice by
  dependency profile and context budget, and `wave-execution.md`'s canonical
  *correct* example (model → schema → routes) is exactly the layer phasing WSD
  forbids — which is issue #47 ("outcome-checkpointing vs context-fitting") stated
  from the outside. Also new: asymmetric falsification (Popper/Lakatos) as a method
  to attach to the already-instrumented-but-uncalibrated reviewer work (#48, #49);
  evolutionary architecture as a second vote for #46. Notable in the other
  direction: WSD credits Toyota (jidoka/andon/poka-yoke) and Continuous Delivery
  explicitly, both of which are load-bearing in RAD and entirely uncited — jidoka
  is arguably RAD's most pervasive single pattern. Steal-with-modification:
  a skeleton-first plan-lint rule (Wave 1 declares a composed end-to-end path and
  carries a `Verify:` line), the corroborate/falsify reviewer split, and a
  vault-shaped *read* layer over `.agents/` — a better answer to the soft-knowledge
  gap than Cosmos's hosted KB, because a vault stays in plain git the operator owns.
  Declined: capability slicing wholesale (it fights the context budget waves exist
  to satisfy). Full breakdown: [wsd-vs-rad.md](wsd-vs-rad.md).
- **Issues:** none filed. Candidates overlap existing
  [#46](https://github.com/seanrreid/RAD_framework/issues/46),
  [#47](https://github.com/seanrreid/RAD_framework/issues/47),
  [#48](https://github.com/seanrreid/RAD_framework/issues/48), and
  [#49](https://github.com/seanrreid/RAD_framework/issues/49).

### Cosmos — Augment Code's Agentic SDLC Platform
- **Source:** Augment Code — [augmentcode.com/blog/cosmos-now-in-public-preview](https://www.augmentcode.com/blog/cosmos-now-in-public-preview)
- **Reviewed:** 2026-07-13
- **Takeaway:** A hosted "operating system for agentic software development" that
  independently converges on RAD's shape: persistent process memory, staged human
  checkpoints (its three checkpoints map ~1:1 onto RAD Gates 0–2), specialized
  per-stage agents, model agnosticism, and environment isolation. Load-bearing
  difference: Cosmos *sells* the substrate (vendor-hosted Knowledge Base, Event Bus,
  Agent Runtime); RAD's bet is plain git the operator owns. RAD's gates are also
  *enforced* (fail-closed event authority + hook) where Cosmos's read as workflow
  convention. Genuinely new relative to RAD: the soft-knowledge Learning Flywheel
  (already RAD's deferred portable-memory half), dynamic model routing via Prism
  (declined — RAD keeps model choice declared in the approved plan, auditable at
  Gate 1), and a recall-not-precision deep-review framing (open Gate-2 candidate).
  Steal-with-modification: default-on worktree isolation for `/rad-deliver`, not
  VMs. Full breakdown: [cosmos-vs-rad.md](cosmos-vs-rad.md).
- **Issues:** [#59](https://github.com/seanrreid/RAD_framework/issues/59)
  (deliver-PR review digest — recall-oriented Gate-2 surface),
  [#60](https://github.com/seanrreid/RAD_framework/issues/60) (plan-time
  reliability readout from events.jsonl),
  [#61](https://github.com/seanrreid/RAD_framework/issues/61) (worktree
  isolation default-on for /rad-deliver).

### Hidden Technical Debt in Agent Harnesses
- **Source:** Lee Hanchung — [leehanchung.github.io/blogs/2026/05/08/hidden-technical-debt-agent-harness](https://leehanchung.github.io/blogs/2026/05/08/hidden-technical-debt-agent-harness/)
- **Reviewed:** 2026-06-24
- **Takeaway:** Thesis — most harness scaffolding is a temporary workaround for current
  model limits and gets absorbed by better models (the Bitter Lesson). RAD's
  determinism core is structurally insulated (it ships determinism, not intelligence).
  The one honest exposure is the orchestrator → mapper → context-tool agent hierarchy,
  which fuses *authority/scope boundaries* (keep) with *context-window workarounds*
  (depreciate as context grows). Design for a clean seam so the chunking layer can be
  excised later without disturbing the authority layer.
- **Issues:** [#46](https://github.com/seanrreid/RAD_framework/issues/46) (audit the
  agent hierarchy: boundary vs context-chunking),
  [#47](https://github.com/seanrreid/RAD_framework/issues/47) (clarify wave-decomposition
  rationale: outcome-checkpointing vs context-fitting).

### Agent Evaluation Readiness Checklist
- **Source:** LangChain — [langchain.com/blog/agent-evaluation-readiness-checklist](https://www.langchain.com/blog/agent-evaluation-readiness-checklist)
- **Reviewed:** 2026-06-24
- **Takeaway:** RAD's *deterministic* surfaces already satisfy the checklist's
  "code-based grader" prescription (the 7-outcome `matrix.yaml`, the `check-*.sh`
  guardrails, the `harness/test/*` regression suite, the `agent-contract.test.js`
  outcome-vocabulary contract). The gap is the **LLM-as-judge graders**
  (`quality-reviewer`, `accessibility-reviewer`): never calibrated, unknown
  false-alarm rate. `.agents/findings.jsonl` already holds the ground-truth labels
  (`false-alarm` vs confirmed) — the trace-to-dataset flywheel exists but the loop
  back to grader quality is open. (Evaluating the BYO wave-execution agent's task
  quality is the operator's job, out of RAD's scope.)
- **Issues:** [#48](https://github.com/seanrreid/RAD_framework/issues/48) (findings →
  reviewer-calibration precision readout),
  [#49](https://github.com/seanrreid/RAD_framework/issues/49) (positive/negative
  reviewer fixtures in CI).

### CUGA — Configurable Generalist Agent
- **Source:** IBM Research — [huggingface.co/blog/ibm-research/cuga-apps](https://huggingface.co/blog/ibm-research/cuga-apps)
- **Reviewed:** 2026-06-24
- **Takeaway:** CUGA is an *intelligence* harness (LLM planner, reflection, CodeAct,
  semantic policy matching, on-the-job skill evolution) — opposite-facing to RAD's
  *determinism* harness. Value is **convergent-design validation**: CUGA independently
  chose git-versioned local state over a DB (`.cuga` folder), single-env-var provider
  abstraction, six declarative policies at fixed lifecycle stages, and a
  structured-result-or-fail tool contract — i.e. RAD's core substrate bets. One
  genuinely new, RAD-shaped primitive: the **Playbook** (pinned known-good procedure
  for recurring tasks). Adopt the deterministic/approval-gated half; reject CUGA's
  self-evolving (ALTK-Evolve) half. Explicitly *not* adopted: LLM planner/reflection
  loop, vector/semantic policy matching, A2A RPC transport.
- **Issues:** [#50](https://github.com/seanrreid/RAD_framework/issues/50) (pinned
  playbooks: reusable, human-approved plan templates).
