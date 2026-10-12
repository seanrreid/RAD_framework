# 7. Measurement and improvement of the factory itself

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="m1"></a>

**M1. Baseline the queue before building**

- Kind: control, judgment
- Applies when: A factory investment is being scoped around delivery bottlenecks.
- Assessment: Require a timestamped queue baseline with bot filtering and explicit sampling; the engineering lead validates metric definitions and selects the bottleneck before expanding infrastructure.
- Works when: the first measure is from your own git history (median and p90 time to first human review, share merged without human review, share of large PRs). Bot reviewers are excluded to see the human queue.
- Fails when: the factory is built without knowing where work waits.
- Evidence: E (demo on one day of PostHog: median 6.1h, p90 160.8h, 40% merged without human review, 28.5% over 400 lines; about 6 minutes, $0.25).
- Src: [FAIK](../sources.md#faik)

<a id="m2"></a>

**M2. Track human touches per PR**

- Kind: judgment, experiment
- Applies when: Human involvement is being measured as a factory improvement target.
- Assessment: Define useful and avoidable touches, then trial reductions against a baseline; measure accepted outcomes, defects, and review coverage alongside touches. Stop if fewer touches reflect bypassed oversight or displaced work.
- Works when: the count of human touches falls over time as the factory improves.
- Fails when: usage counts or token leaderboards are the metric (Meta's came down; Amazon staff ran trivial tasks to climb theirs).
- Evidence: E (Warp; vendor).
- Src: [LLOYD](../sources.md#lloyd), [FAIK](../sources.md#faik)

<a id="m3"></a>

**M3. Factory changes are measured, not vibes**

- Kind: control, experiment
- Applies when: A factory change is claimed to improve delivery or quality.
- Assessment: Require a versioned baseline and comparison on representative workloads; trial the change with cost and quality criteria, stopping on regressions. Record model and task changes so improvements are not attributed to an uncontrolled comparison.
- Works when: DORA metrics and LLM-judge scorers identify what to change in skills, context, and model mix; each improvement is tested and benchmarked. baro changed one participant per post-mortem and re-ran the same goal: fastest story 24.7 min to 2.6 min across four rounds with the model fixed.
- Fails when: tuning is by intuition.
- Evidence: M/E.
- Src: [LLOYD](../sources.md#lloyd), [BARO](../sources.md#baro)

<a id="m4"></a>

**M4. Harness changes need an owner**

- Kind: control, judgment
- Applies when: Factory maintenance and improvement require ongoing engineering effort.
- Assessment: Audit named ownership, capacity, and review expectations; engineering leadership assesses whether incentives support useful improvements and repairs gaps in responsibility.
- Works when: engineers are explicitly expected to improve the factory; this appears in feedback and performance reviews.
- Fails when: factory work is no one's job.
- Evidence: E (Warp; vendor).
- Src: [LLOYD](../sources.md#lloyd)

<a id="m5"></a>

**M5. Prove it works in most cases, not once**

- Kind: control, judgment
- Applies when: A capability is being promoted from demonstration to routine use.
- Assessment: Require representative repeated evaluations and a documented reliability target; the evaluation owner reviews uncertainty and coverage, withholding broad reliability claims until evidence meets the chosen target.
- Works when: an eval suite and retrieval benchmarks establish reliability.
- Fails when: one successful demo is treated as proof. The advanced-harness tutorial states this limitation itself.
- Evidence: O.
- Src: [DFS](../sources.md#dfs), [JX0](../sources.md#jx0)

<a id="m6"></a>

**M6. Each round asks what cost time that a rule or check could prevent**

- Kind: judgment
- Applies when: A loop's repeated friction suggests changing its operating procedure.
- Assessment: The process owner reviews recurrent evidence, distinguishes transient surprises, and records whether to add, revise, or remove a rule; validate the decision on subsequent rounds before propagating it.
- Works when: the first occurrence is evidence; repeated friction becomes a durable constraint; sometimes the right change is subtraction (remove a misleading rung).
- Fails when: the loop rewrites its operating procedure after every surprise.
- Evidence: O.
- Src: [JX0](../sources.md#jx0)
