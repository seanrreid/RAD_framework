# 3. Knowledge and context

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="k1"></a>

**K1. Document what the code cannot say**

- Kind: judgment
- Applies when: Agents need rationale, invariants, or constraints not recoverable from code.
- Assessment: A system owner reviews context documents for useful rationale, current intent, and unsupported explanations; remove redundant prose and resolve missing or contradictory decisions.
- Works when: docs capture why a technology/version was chosen, deliberately excluded behaviour, invariants, why boundaries exist, risks and assumptions.
- Fails when: bulk-generated Markdown restates the code; it drifts and the agent cannot tell which is intended.
- Evidence: O.
- Src: [ETN](../sources.md#etn)

<a id="k2"></a>

**K2. Current knowledge is separate from change history**

- Kind: control
- Applies when: Historical specifications and current guidance are both available to agents.
- Assessment: At task start and closure, audit default context selection and the refreshed current-truth record; exclude historical specs from default loading and resolve outdated active guidance.
- Works when: completed specs are kept for traceability but not loaded by default; a distilled "current truth" is refreshed whenever a change closes.
- Fails when: old specs are replayed and obsolete intent becomes a requirement.
- Evidence: O.
- Src: [ETN](../sources.md#etn)

<a id="k3"></a>

**K3. Code contradicting documented intent goes to a person**

- Kind: control, judgment
- Applies when: Implementation contradicts documented intent.
- Assessment: Require escalation to the named domain owner; record the owner's decision and update code or guidance accordingly before the agent proceeds on an invented rationale.
- Works when: the agent escalates instead of inventing the missing rationale.
- Fails when: the agent fills gaps with plausible rationale.
- Evidence: O.
- Src: [ETN](../sources.md#etn)

<a id="k4"></a>

**K4. Knowledge is shared, not personal**

- Kind: control
- Applies when: Multiple engineers or agents depend on shared project knowledge.
- Assessment: Audit versioned shared context and correction propagation across participating agents; repair divergent defaults and prevent private memory from silently becoming authoritative policy.
- Works when: project knowledge is explicit and shared; every agent run starts from controlled, reproducible context.
- Fails when: results differ between developers because of private agent memory (a "senior's undocumented knowledge that leaves with them"). Detail adds: corrections must propagate across the whole toolchain (code review bot, SRE bot) so the same mistake is not repeated.
- Evidence: E (speaker experience).
- Src: [ETN](../sources.md#etn), [DETAIL](../sources.md#detail)

<a id="k5"></a>

**K5. Context is grounded in a queryable graph or index**

- Kind: experiment
- Applies when: Agents repeatedly spend time locating code, data, or ownership context.
- Assessment: Compare grounded and ungrounded runs on representative tasks with the same model; measure answer accuracy, search time, tool calls, and cost. Adopt if quality is preserved and savings justify maintenance; stop on stale or misleading retrieval.
- Works when: agents can look up services, datasets, owners, usage history. Uber: grounded agent answered in 38s; ungrounded agent spent 20 minutes, hit 3 errors, and wrongly concluded the data was unqueryable.
- Fails when: "an ungrounded agent fails slowly rather than cheaply."
- Evidence: M (Uber, single anecdote with timings). Meta: 59 context files led to 40% fewer tool calls in early tests (original checked: "preliminary tests on six tasks", so a small sample).
- Src: [UBR-T](../sources.md#ubr-t), [FAIK](../sources.md#faik)

<a id="k6"></a>

**K6. Lessons from completed work are curated, not auto-promoted**

- Kind: control, judgment
- Applies when: A completed run proposes durable guidance or reusable skills.
- Assessment: The knowledge owner reviews multi-case evidence, approves a versioned update, and checks propagation; prevent automatic promotion based solely on one successful run.
- Works when: durable knowledge is updated (invariants, decisions, security model); proposed skills are tested on multiple cases, approved, and versioned.
- Fails when: one successful run is promoted into a universal rule.
- Evidence: O.
- Src: [ETN](../sources.md#etn), [JX0](../sources.md#jx0)

<a id="k7"></a>

**K7. Rules are written for the spirit, not just the letter**

- Kind: control, judgment
- Applies when: Repeated review findings can be expressed as deterministic rules.
- Assessment: The code owner reviews the intended rule and representative valid and invalid cases; enforce accepted linters in CI and revise rules that reward literal compliance while missing intent.
- Works when: rules (.md files) are paired with deterministic linters that catch the repeated review comment.
- Fails when: agents follow a rule literally (told parser tests are high value, they unit-test every Zod schema).
- Evidence: E. Swizec runs a few dozen custom linters.
- Src: [SWZ](../sources.md#swz)

<a id="k8"></a>

**K8. Too many simultaneous rules degrade instruction-following**

- Kind: experiment
- Applies when: Instruction adherence appears to degrade as active rules accumulate.
- Assessment: Compare small and large rule sets on the same representative tasks; measure adherence and task quality with required controls preserved. Stop if removing rules increases risk; choose a local limit rather than adopting eight as a threshold.
- Works when: rule count is kept small.
- Fails when: around 8 rules at once reportedly weaken adherence (speaker mention; no study identified).
- Evidence: O (weak).
- Src: [ETN](../sources.md#etn)

<a id="k9"></a>

**K9. Persisted state is the control plane for loops**

- Kind: control
- Applies when: Work must continue across disposable sessions or repeated loop rounds.
- Assessment: At handoff, require persisted goal, facts, plan, current state, corpus version, and evidence; verify a fresh session can resume and return incomplete state records for repair.
- Works when: goal, facts, plan, procedure, current state, corpus, and per-round evidence live in the repo so sessions are disposable.
- Fails when: reasoning lives only in the conversation.
- Evidence: O.
- Src: [JX0](../sources.md#jx0)

<a id="k10"></a>

**K10. Generated explanations stay anchored to extracted facts**

- Kind: control, experiment
- Applies when: Generated behavior documentation is being derived from a codebase.
- Assessment: Require extracted references to resolve to the indexed revision; trial graph-derived documentation against manually checked behaviors, measuring factual accuracy and maintenance cost. Stop on unsupported explanations before relying on the map.
- Works when: documentation about a codebase is built facts-first: static analysis produces a program graph; a proposer/reviewer loop maps code to behaviour units until the mapping converges; the prose is generated but every source link, function reference, and snippet comes from extracted facts.
- Fails when: a model summarises files one by one with no evidence links (compare [K1](knowledge-and-context.md#k1): bulk-generated Markdown that drifts).
- Evidence: M (authors' own study, see [K11](knowledge-and-context.md#k11)). Not independently replicated.
- Src: [HANDBOOK](../sources.md#handbook)

<a id="k11"></a>

**K11. A behaviour map improves change localisation and cuts search cost**

- Kind: experiment
- Applies when: Behavior maps are proposed to improve change localization.
- Assessment: Compare map-assisted and baseline planning on held-out requests using the same agent; measure file and symbol accuracy, plan quality, tokens, and eventual implementation outcomes. Adopt on predefined gains; stop if maps misroute work or maintenance erases savings.
- Works when: a coding agent consults a layered map (system overview, behaviour units, unit detail with evidence) before localising a change. In the authors' comparison (same agent and planner LLM, Terminus-2 and Codex harnesses, three LLM judges), the Handbook-assisted planner was preferred more often, used fewer planner tokens per case, had higher file/symbol recall, precision, and F1, and had fewer "wrong subsystem" plans. The gain held across request types (including search-hostile ones: mirrored implementations, fallback paths) and difficulty tiers.
- Fails when: unknown beyond the conditions tested. Caveats: the authors built the tool and designed the study; judges are LLMs; it measures localisation and plan quality before editing, not whether the final code passes; exact effect sizes were in charts not captured here.
- Evidence: M (weak: self-reported, LLM-judged).
- Src: [HANDBOOK](../sources.md#handbook)

<a id="k12"></a>

**K12. Edits are planned on the map, then confirmed before writing**

- Kind: control, judgment
- Applies when: A coordinated edit uses a behavior map and the project requires confirmation before writing.
- Assessment: Require a revision-bound plan and proposed diff before the configured approval boundary; the reviewer checks all implementation and test sites. Hold writes until approval and refresh approval when material scope changes.
- Works when: a one-line change request is expanded into the full set of sites (example: "let this command carry its own env vars" became 14 coordinated updates across 10 files, including mirrored tests), shown as a reviewable plan and diff, and nothing writes to the repository or the documentation until a person confirms; code and docs update together.
- Fails when: a forwarding step or mirrored test is missed in a hand-found change.
- Evidence: O (demo).
- Src: [HANDBOOK](../sources.md#handbook)

<a id="k13"></a>

**K13. A failure class becomes a skill the agent applies next time, and verified components are reused in layers**

- Kind: control, judgment, experiment
- Applies when: A failure pattern suggests a reusable skill or component.
- Assessment: Apply [K6](knowledge-and-context.md#k6) approval and versioning controls; the owner judges generality, then trials the component on fresh cases, measuring recurrence, regressions, and cost. Stop or retire it if it spreads incorrect guidance.
- Works when: when a class of failure appears, it becomes a new skill (the loop "learns"); skills, tools, and sandboxes are layered into composable components that are reused once verified to work. Tunguz frames these as Meadows's "self-organization" and "hierarchy".
- Fails when: lessons stay in conversations, or components are reused unverified. Caution from [K6](knowledge-and-context.md#k6): do not promote one run into a universal rule; test across multiple cases and version it before it propagates.
- Evidence: O (design principle; no measurements in the post).
- Src: [TUNGUZ](../sources.md#tunguz), [ETN](../sources.md#etn), [SWZ](../sources.md#swz)
