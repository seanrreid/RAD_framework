# 10. Closing the loop in production

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="l1"></a>

**L1. "Done" means value delivered, not merged**

- Kind: control, judgment
- Applies when: A deployed change has a defined business or user outcome.
- Assessment: Require change-linked telemetry, observation window, stop conditions, and rollback before release; the outcome owner reviews results and records close, follow-up, or removal after observation.
- Works when: behaviour to observe, stop conditions, and rollback are defined before deploy; telemetry is tied to the specific change; outcomes route to close / reproduce as new task / remove.
- Fails when: merge is the finish line.
- Evidence: O.
- Src: [ETN](../sources.md#etn)

<a id="l2"></a>

**L2. Unused features are pruned using usage evidence**

- Kind: judgment
- Applies when: Features show low usage or disproportionate maintenance cost.
- Assessment: The product owner reviews usage coverage, customer obligations, and support burden before a retirement decision; record reasons and validate downstream impact rather than pruning solely on a low count.
- Works when: cheap features do not grow the codebase faster than the team can maintain it.
- Fails when: features nobody uses accumulate.
- Evidence: O (speaker illustration).
- Src: [ETN](../sources.md#etn), [SWZ](../sources.md#swz)

<a id="l3"></a>

**L3. Production feeds the loop, with care**

- Kind: control, judgment
- Applies when: Production alerts, incidents, or feedback can create agent tasks.
- Assessment: Require reproducible context, scoped authority, verification evidence, and risk-based review for generated fixes; the incident or product owner assesses outcomes before closing the originating issue.
- Works when: monitoring/incident and user feedback route into agent work with review.
- Fails when: it is assumed the patch is correct because the alert became a task.
- Evidence: O.
- Src: [HORTHY](../sources.md#horthy), [DETAIL](../sources.md#detail)
