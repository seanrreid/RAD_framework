# 6. Cost and budget

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="c1"></a>

**C1. Budgets are enforced by a gateway, not requested in a prompt**

- Kind: control
- Applies when: Agent work spends from an enforceable run, project, or organization budget.
- Assessment: Exercise spending beyond configured caps at the gateway; require blocked requests and recorded authorization for continuation, including concurrent requests and usage-accounting delays.
- Works when: a virtual key has a hard cap per run/project/org; hitting the cap stops the run, and continuing is a controlled decision.
- Fails when: "stay within budget" is in the prompt.
- Evidence: O (Etnetera, illustrative $5/run). Real-world: Uber's AI costs rose 6x since 2024 by March and it spent its annual AI budget in four months.
- Src: [ETN](../sources.md#etn), [FAIK](../sources.md#faik)

<a id="c2"></a>

**C2. Cost is measured per outcome**

- Kind: control, judgment
- Applies when: Factory output and spend are being reported or used to choose investments.
- Assessment: Require consistently defined outcome cost, quality, and volume metrics; the owner checks attribution and denominators and rejects conclusions based on throughput or AI-code share alone.
- Works when: unit prices exist (per merged PR, per review, per alert, per cleanup) alongside quality (revert rate, F1, MTTR) and volume.
- Fails when: throughput is tracked without quality (gameable); "% of code written by AI" is the headline. Uber's agent-attributed PR share was cited as 11% in May and 70%+ in August depending on what was counted.
- Evidence: M.
- Src: [UBR-T](../sources.md#ubr-t), [FAIK](../sources.md#faik)

<a id="c3"></a>

**C3. Spend is visible to the person spending it**

- Kind: control, experiment
- Applies when: Users or agent operators can influence session spend.
- Assessment: Audit visible attributable spend and configured notifications; trial counters and nudges against a baseline, measuring outcome cost and quality. Stop if notifications impede useful work; do not attribute all savings to visibility.
- Works when: a live cost counter, tier nudges at 50/80/100%, and per-session analysis flag anti-patterns (Opus on simple sessions, bloated context, expired caches).
- Fails when: caps alone are used. Uber describes visibility and spend-tier nudges as an alternative to strict caps. Across its broader optimization program, cost per session fell 52% from its June peak and cost per 1,000 requests fell about 34%, with model held fixed; the article does not isolate the effect of visibility.
- Evidence: M.
- Src: [UBR-T](../sources.md#ubr-t), [FAIK](../sources.md#faik)

<a id="c4"></a>

**C4. Model choice is benchmark-driven per workload**

- Kind: judgment, experiment
- Applies when: Several models can serve the same recurring workload.
- Assessment: Benchmark candidates on held-out real tasks for quality, reliability, latency, and full cost; the workload owner chooses a tradeoff and trials it in production. Stop or roll back when agreed quality floors fail.
- Works when: a benchmark is built from the agent's real work and the Pareto-optimal model is chosen and revisited; subagents default to a cheaper model.
- Fails when: one frontier model runs everything.
- Evidence: M (Uber uReview: switching models improved F1 while dramatically cutting cost per PR).
- Src: [UBR-T](../sources.md#ubr-t)

<a id="c5"></a>

**C5. Prompt cache TTL matches human idle gaps**

- Kind: experiment
- Applies when: Interactive idle gaps repeatedly expire a provider's prompt cache.
- Assessment: Compare supported TTL and compaction settings using actual gaps and current provider prices; measure total billed cost, cache reuse, and completion quality. Adopt on net benefit and stop on quality loss or higher cost.
- Works when: cache TTL is selected for the provider and actual gaps between turns. Uber's August 2026 Anthropic example: interactive sessions use a 1-hour TTL (5-minute writes cost 1.25x, 1-hour writes 2x, reads 0.1x); subagents keep 5 minutes. Separately, Uber triggers compaction at 400K even on 1M context. These are deployment-specific settings and dated provider prices, not universal defaults.
- Fails when: 5-minute TTL plus idle gaps forces full-price rebuilds.
- Evidence: M (Uber).
- Src: [UBR-T](../sources.md#ubr-t)

<a id="c6"></a>

**C6. Code-mode and CLI-resolved tools cut tokens**

- Kind: experiment
- Applies when: Chatty tool protocols generate repeated polls or large intermediate responses.
- Assessment: Compare scripted batching with model-turn orchestration on matched workflows; measure billed tokens, latency, errors, and result completeness. Stop if batching hides failures or required information.
- Works when: chatty protocols run as a script, with only the summary returned to the model. Uber: 55-71% saving on small SQL results, over 90% in bulk.
- Fails when: every poll is a model turn.
- Evidence: M (Uber, same-session measurement).
- Src: [UBR-T](../sources.md#ubr-t)

<a id="c7"></a>

**C7. Better code structure lowers token cost**

- Kind: judgment, experiment
- Applies when: Poor navigation or tangled modules appear to increase agent work.
- Assessment: The code owner selects a justified refactoring; compare representative tasks before and after for correctness, search effort, tokens, and maintenance cost. Stop on regressions and include refactoring cost rather than expecting the reported 83% saving.
- Works when: code is navigable (vertical domain modules, clear contracts, colocated code).
- Fails when: tangled structure makes agents read and touch more. One experiment reported 83% lower token cost from better file structure.
- Evidence: E (single experiment, cited by Swizec). Original checked (Martin Fowler's site): one refactoring of a data-access layer, one task, 159,564 to 27,360 tokens (a saving of 132,204, or 83%); tokens were approximated as characters divided by four, because Claude does not report reliable live token counts. One codebase and one task, so treat 83% as an illustration, not a benchmark.
- Src: [SWZ](../sources.md#swz)

<a id="c8"></a>

**C8. Degrade gracefully under budget pressure**

- Kind: control, judgment, experiment
- Applies when: Verification consumes a limited budget and a fallback check is proposed.
- Assessment: The verification owner defines what the fallback can certify; trial it on known failures with agreed detection floors. Enforce logged transitions and stop or escalate when budget cannot support adequate verification; never silently weaken a required gate.
- Works when: above a pressure threshold (e.g. 0.9) the harness uses a deterministic check instead of an LLM judge, and the trace records why.
- Fails when: the run crashes or silently skips verification.
- Evidence: O (tutorial).
- Src: [DFS](../sources.md#dfs)
