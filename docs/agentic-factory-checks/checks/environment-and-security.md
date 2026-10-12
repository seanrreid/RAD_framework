# 4. Environment, sandbox, and security

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="e1"></a>

**E1. Agents do not depend on laptops**

- Kind: judgment, experiment
- Applies when: Unattended triggers or concurrent tasks exceed laptop availability or capacity.
- Assessment: Assess availability, access exposure, and concurrency needs; trial managed execution against the existing setup, measuring reliability, startup cost, and isolation. Adopt where the benefit justifies infrastructure; stop on expanded unauthorized access.
- Works when: runs happen in managed cloud environments that can start without a human (alerts, tickets, CI).
- Fails when: laptops sleep, hold SSH keys/VPN/authenticated tools (large blast radius, DoorDash), or cap concurrency at a few sessions (Ramp).
- Evidence: E.
- Src: [FAIK](../sources.md#faik)

<a id="e2"></a>

**E2. One environment per task, then removed**

- Kind: control
- Applies when: Concurrent or unattended agent runs need isolated execution environments.
- Assessment: The run manager audits dedicated workspace identity, scoped credentials, result persistence, revocation, and cleanup; reject shared authority and quarantine environments that fail teardown.
- Works when: create environment, supply task and tools, run, persist results, revoke and clean up; dedicated branch and sandbox per run; run-scoped credentials.
- Fails when: environments are shared or long-lived.
- Evidence: O. Etnetera: one Kubernetes Job per agent run; durable state and approvals held in Temporal.
- Src: [ETN](../sources.md#etn), [FAIK](../sources.md#faik)

<a id="e3"></a>

**E3. Environments start warm and fast**

- Kind: experiment
- Applies when: Environment startup delay limits adoption or task throughput.
- Assessment: Compare warm snapshots with current provisioning using representative runs; measure startup percentiles, snapshot freshness, cost, and failures. Adopt project-specific targets and stop on stale dependencies or unsafe snapshots.
- Works when: repositories are pre-cloned, indexes built, images rebuilt regularly. Stripe 10s; DoorDash target under 5s; Ramp rebuilds every 30 min.
- Fails when: nobody waits for a slow sandbox.
- Evidence: E.
- Src: [FAIK](../sources.md#faik)

<a id="e4"></a>

**E4. Agents can see what they change (agent-legible environments)**

- Kind: control, judgment
- Applies when: A change depends on integrations, UI behavior, races, or representative data.
- Assessment: Require a reproducible observation path for affected behavior; the verification owner assesses environment fidelity and records unobservable cases for escalation instead of treating them as passing.
- Works when: third-party integrations, browser/frontend, races, and representative data are exercisable end-to-end.
- Fails when: bugs cluster where agents can't observe: untestable integrations, frontend without browser setup, unreproducible races, queries blind to data shape.
- Evidence: O (Detail argues the environment, not the model, is now the limiting factor).
- Src: [DETAIL](../sources.md#detail)

<a id="e5"></a>

**E5. Guardrails are enforced outside the model**

- Kind: control
- Applies when: Agents access sensitive data, credentials, or bounded business actions.
- Assessment: At gateway and tool boundaries, exercise policy violations and verify masking, scope, expiry, approval, and hard limits; deny actions when external enforcement is absent or bypassable.
- Works when: PII is masked before model requests; credentials are short-lived and narrowly scoped; sensitive actions need approval; hard limits sit inside the tool (e.g. refund cap).
- Fails when: the prompt says "don't call X." The agent cannot grant itself an exception.
- Evidence: O/E.
- Src: [ETN](../sources.md#etn), [FAIK](../sources.md#faik)

<a id="e6"></a>

**E6. A sandbox is only as strong as the authority reachable from it**

- Kind: control, judgment
- Applies when: A sandbox can reach repositories, credential files, services, or fallback routes.
- Assessment: The security owner inventories indirect authority and tests representative bypass paths; revoke unintended capabilities and withhold isolation approval until reachable authority matches policy.
- Works when: enforcement covers capabilities the agent can obtain indirectly.
- Fails when: the agent finds credential material in application sources and uses it. Etnetera anecdote: an agent not given a GitLab token recovered a stored one and opened a merge request (speaker-reported; not evidence that every sandbox fails).
- Evidence: E (anecdote).
- Src: [ETN](../sources.md#etn)

<a id="e7"></a>

**E7. Trusted host / thin executor split**

- Kind: judgment, experiment
- Applies when: A custom harness needs a host-to-sandbox trust boundary.
- Assessment: Review a threat model for key, policy, state, and stream ownership; trial a thin executor, measuring leakage resistance, bounded outputs, and operational cost. Stop on boundary bypasses; adopt only after the security owner accepts residual risk.
- Works when: policy, keys, session state live on the host; the sandbox holds only a bounded execution stub; every stream crossing back is size-bounded.
- Fails when: a driver inside the VM leaks prompts/source, or tools split awkwardly across the boundary.
- Evidence: O (design argument).
- Src: [STENCIL](../sources.md#stencil)

<a id="e8"></a>

**E8. Rule of Two for sessions**

- Kind: control, judgment
- Applies when: An agent session can combine untrusted input, sensitive access, and outward effects.
- Assessment: Inventory session capabilities before execution; when all three are present, require approved supervision or reliable validation. The security owner validates the mitigation, and the gate denies unsupervised execution.
- Works when: a session has at most two of: reads untrusted input, reaches sensitive systems/data, can change things or communicate outward. If all three are needed in the same session, autonomous operation requires supervision through human approval or another reliable means of validation.
- Fails when: an agent reads a public issue or ticket while holding sensitive access and write power (GitHub MCP research demonstration: a malicious public issue hijacked an agent and leaked private repository data in an experimental setup).
- Evidence: O (security framework) / E (research demonstration).
- Src: [FAIK](../sources.md#faik)

<a id="e9"></a>

**E9. Each agent has its own scoped identity**

- Kind: control
- Applies when: Agents act through authenticated tools or create changes for release.
- Assessment: Audit scoped identity, expiry, requesting-human attribution, and independent approval at each hop; deny actions with missing identity or a route around the production gate.
- Works when: scoped, short-lived tokens at every hop preserve the chain back to a human; agents cannot approve their own work; no path past production without a gate.
- Fails when: a PR names "Monitoring Agent" as author and the requesting engineer is lost from the record.
- Evidence: E.
- Src: [FAIK](../sources.md#faik)

<a id="e10"></a>

**E10. The gateway is treated as the most sensitive box**

- Kind: control, judgment
- Applies when: A gateway holds provider credentials or processes sensitive requests.
- Assessment: Require an owner, approved artifact versions, patch records, and credential exposure checks; the security owner triages advisories and quarantines affected artifacts pending investigation and remediation.
- Works when: the model gateway (holds every provider key) is pinned, patched, and owned.
- Fails when: unpinned dependencies. In March 2026, poisoned LiteLLM releases sat on PyPI about 40 minutes and exfiltrated cloud, SSH, Kubernetes, and CI secrets; teams on the pinned official Docker image were safe.
- Evidence: E (reported incident; Faik citing Datadog analysis).
- Src: [FAIK](../sources.md#faik)

<a id="e11"></a>

**E11. Tool output is treated as data, not instructions**

- Kind: control, judgment
- Applies when: Agents consume external tool results and can perform irreversible actions.
- Assessment: Verify untrusted-result handling and the configured approval boundary using injection cases; a security reviewer assesses residual risk, and the gate rejects irreversible actions without required human approval.
- Works when: tool results are sandboxed/untrusted by default; irreversible actions need human approval.
- Fails when: tool outputs are trusted as instructions (explicitly called out as a caveat in the advanced-harness tutorial).
- Evidence: O.
- Src: [DFS](../sources.md#dfs)

<a id="e12"></a>

**E12. Cancellation has a kill boundary**

- Kind: control
- Applies when: Tools can run beyond a timeout or ignore cooperative cancellation.
- Assessment: Exercise timeout and cancellation against non-cooperative workloads; require bounded termination at the execution boundary and treat continued resource consumption as a failed cancellation control.
- Works when: long or runaway work runs in something that can be terminated (process, worker, VM request).
- Fails when: tools share the engine's isolate and cooperative cancel (AbortSignal/context) is ignored, so work keeps burning resources after timeout.
- Evidence: O.
- Src: [STENCIL](../sources.md#stencil)
