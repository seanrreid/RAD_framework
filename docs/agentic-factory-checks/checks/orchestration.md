# 5. Orchestration and loops

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="o1"></a>

**O1. Fresh context for specialised agents**

- Kind: experiment
- Applies when: Long tasks accumulate context and can be decomposed into focused subtasks.
- Assessment: Compare fresh-context handoffs with continuous sessions on matched tasks; measure completion quality, handoff loss, latency, and cost. Stop on coordination failures; choose local handoff criteria rather than adopting 20-30 steps universally.
- Works when: an orchestrator spawns focused agents (architect, builder, reviewer); work is handed to new subagents after about 20-30 steps (speaker heuristic).
- Fails when: one agent carries the whole project in an ever-growing context.
- Evidence: O (heuristic).
- Src: [ETN](../sources.md#etn)

<a id="o2"></a>

**O2. Development agent and product agent are separate**

- Kind: control
- Applies when: A development loop evaluates a product agent's behavior as a user would experience it.
- Assessment: The evaluation runner checks fresh context and user-equivalent tools and permissions; invalidate runs contaminated by development-only knowledge or capabilities.
- Works when: the product agent gets a fresh conversation and only tools a user would have; the driver uses the same surface as a user.
- Fails when: shared context lets the product agent succeed with knowledge no user supplies.
- Evidence: O.
- Src: [JX0](../sources.md#jx0)

<a id="o3"></a>

**O3. One causal gap per round**

- Kind: judgment, experiment
- Applies when: A loop has several plausible causes of poor performance.
- Assessment: Classify the dominant gap and trial one intervention against a reproducible baseline; measure target outcomes and regressions, stopping on ambiguous results or budget exhaustion. Record confounders when one-gap isolation is impossible.
- Works when: each round classifies the largest gap (world, domain, contract, runtime, steering, surface, harness) and closes it through every required layer, with a deterministic check added.
- Fails when: every failure becomes a prompt problem or a frontend problem; five levers change at once so nothing is attributable.
- Evidence: O.
- Src: [JX0](../sources.md#jx0)

<a id="o4"></a>

**O4. Reproducible starting world; unhealthy world is not scored**

- Kind: control
- Applies when: Evaluation depends on a resettable fixture or environment.
- Assessment: Preflight checks fixture and runtime versions before scoring; invalid infrastructure records an invalid run with no score, triggers repair, and requires a fresh evaluation.
- Works when: fixture reset plus preflight prove the starting state; infrastructure trouble records no score.
- Fails when: missing data is mistaken for weak reasoning; stale code for a broken contract.
- Evidence: O.
- Src: [JX0](../sources.md#jx0)

<a id="o5"></a>

**O5. Loops have stop rules and hand over findings**

- Kind: control, judgment
- Applies when: An autonomous loop retries work and selects verification scope.
- Assessment: The orchestrator enforces configured error, time, cost, and retry limits and hands off evidence at stop; the verification owner sets proportionate iteration and integration checks without dropping required coverage.
- Works when: the loop stops on repeated same error, contradiction in the task, or exceeded limit, and passes findings to a human; test runs are right-sized (affected behaviour per iteration, broader on integration, expensive suites nightly).
- Fails when: unbounded retry or irrelevant test output floods context.
- Evidence: O.
- Src: [ETN](../sources.md#etn), [JX0](../sources.md#jx0)

<a id="o6"></a>

**O6. Humans own direction at batch boundaries**

- Kind: control, judgment
- Applies when: A loop runs batches that can change product direction.
- Assessment: Enforce project-defined batch checkpoints; the product owner reviews results and records continue, redirect, or stop. Hold the next batch pending that decision where the policy requires it.
- Works when: small batches (about three rounds) end with a human choosing continue, redirect, or stop; the loop cannot decide its own result is good enough.
- Fails when: the score is used to decide product direction.
- Evidence: O.
- Src: [JX0](../sources.md#jx0)

<a id="o7"></a>

**O7. Every gate announces its rule**

- Kind: control
- Applies when: A gate can reject agent work based on a policy or execution limit.
- Assessment: Conformance checks require a visible versioned rule and enforcement location before work starts; reject silently introduced gates and report the applicable rule with each rejection.
- Works when: each boundary that judges work declares where it enforces and states the rule in terms the judged agent can read; a conformance test refuses silent gates.
- Fails when: agents lose an hour of work to rules nobody told them. Example: an agent spent its whole budget diagnosing that macOS blocks setuid binaries in a sandbox, then failed review for running out of turns.
- Evidence: E (baro run ledger).
- Src: [BARO](../sources.md#baro)

<a id="o8"></a>

**O8. Plans are living, versioned graphs**

- Kind: control, experiment
- Applies when: Repository discoveries frequently invalidate an initial task plan.
- Assessment: Require schema-validated, versioned plan mutations; trial adaptive planning and recovery lanes against static planning, measuring recovery success, scope drift, and overhead. Stop when mutations bypass scope or budget authority.
- Works when: running stories can propose new work through a closed schema; the board validates and persists mutations; failed work gets recovery lanes with fresh worktrees.
- Fails when: a static plan meets a real repository.
- Evidence: E.
- Src: [BARO](../sources.md#baro)

<a id="o9"></a>

**O9. Re-plan on missing information, not blind retry**

- Kind: control, judgment
- Applies when: A failed task is a candidate for retry or replanning.
- Assessment: Require classified failure context, tool-resolved node identity, and configured replan limits; the planner assesses missing information and returns contradictions or exhausted attempts for human resolution.
- Works when: failures are classified; missing-info errors send failure context back to the planner, bounded by max re-plans and budget.
- Fails when: blind retries.
- Evidence: O (tutorial). Also: never trust the LLM about node names; resolve the aggregate node by tool, not by assumed id.
- Src: [DFS](../sources.md#dfs)

<a id="o10"></a>

**O10. Stale attempts cannot affect live ones**

- Kind: control
- Applies when: Tasks can be retried while old workers or events remain active.
- Assessment: Inject delayed events from previous attempts; the event gate must reject mismatched run, lease, or generation IDs and record stale-event rejection without modifying current state.
- Works when: events carry run, lease, and generation; a retried story ignores events from the dead attempt.
- Fails when: dead attempts "haunt" the new one.
- Evidence: E.
- Src: [BARO](../sources.md#baro)

<a id="o11"></a>

**O11. Tool roster stays small**

- Kind: experiment
- Applies when: Tool definitions consume substantial context or slow tool selection.
- Assessment: Compare smaller permanent rosters and alternative access paths on representative tasks; measure tokens, latency, tool selection accuracy, and completion. Adopt only if access coverage is preserved; stop on inaccessible required tools.
- Works when: permanent tools are few; long-tail tools sit behind stable surfaces, tool search, or CLI resolution; each agent loads only what it needs.
- Fails when: 100+ tools add 50-70K tokens to every prompt (Uber). In the omp benchmark, trimming 23 tool definitions to 5 took median wall time from 86s to 37s (~25K to ~15K prefix tokens).
- Evidence: M.
- Src: [UBR-T](../sources.md#ubr-t), [STENCIL](../sources.md#stencil), [FAIK](../sources.md#faik)

<a id="o12"></a>

**O12. One job primitive for anything long-running**

- Kind: judgment, experiment
- Applies when: Several long-running tool types need consistent lifecycle handling.
- Assessment: Review requirements for input, output, exit status, signals, limits, and truncation; trial a shared job interface against current behavior. Measure lifecycle correctness and overhead; stop on lost outputs or cancellation regressions.
- Works when: shell, subagent, daemon, and over-budget call share one job interface (stdin, stdout, exit status, signal) with central limits and output truncation.
- Fails when: each tool grows its own backgrounding and truncation (inconsistent notices, nested truncation layers break code-mode).
- Evidence: O.
- Src: [STENCIL](../sources.md#stencil)

<a id="o13"></a>

**O13. Dynamic tool discovery has a cache cost; prefer stable discovery surfaces**

- Kind: experiment
- Applies when: Dynamic discovery changes prompt prefixes or cache behavior.
- Assessment: Compare stable discovery surfaces and on-demand tool loading on the same provider and workload; measure cache hits, billed tokens, selection quality, and latency. Stop on lost capability; resolve the Uber/Stencil tradeoff using local results.
- Works when: the permanent roster never changes after discovery; the long tail (MCP, SaaS) sits behind a stable surface, e.g. a `dyn` built-in in Bash (list, search, `--help` synthesized from JSON schema, `@file`/stdin for large inputs). Open-ended operation sets get a code surface (browser, computer) with one stable schema.
- Fails when: changing the tool roster mid-session invalidates the provider cache; MCP servers sit in the permanent tool layer. Tool grammar also costs tokens beyond its description because it constrains generation.
- Evidence: O/M. Roster trimming benchmark in [O11](orchestration.md#o11). Note the tension with Uber's tool search (see Conflicts).
- Src: [STENCIL](../sources.md#stencil), [UBR-T](../sources.md#ubr-t)

<a id="o14"></a>

**O14. Tools carry intent and a version**

- Kind: control
- Applies when: Tool traces must explain actions and attribute results to contract versions.
- Assessment: Audit required intent and version fields at invocation and trace ingestion; reject incomplete contracts and record the version used for each result. Stated intent is not proof of actual behavior.
- Works when: every tool call has an `intent` argument (streamed, so UIs and the journal show what the model thinks it is doing) and tools are versioned, so traces can attribute success rate to a specific contract.
- Fails when: each tool invents its own reason/purpose field; frequently changed tools cannot be evaluated over time.
- Evidence: O.
- Src: [STENCIL](../sources.md#stencil)

<a id="o15"></a>

**O15. Builtins are deep: one operation, many projections**

- Kind: judgment, experiment
- Applies when: A harness has fragmented resource-reading tools or repeated workarounds.
- Assessment: Review semantic boundaries and prototype a unified materialization surface; measure task success, usability, latency, and maintenance against existing tools. Stop on ambiguous representations or hidden capability expansion.
- Works when: a few tools each cover a lot of ground as one operation. Example: Read "materializes a resource" into the most useful representation (directories, notebooks, PDFs/Office files to markdown, SQLite inspection, archives, URLs, ranges, structural summaries), with a `:raw` escape hatch; one internal URL scheme covers artifacts, subagent transcripts, skills, memory, SSH, MCP resources.
- Fails when: complexity is scattered across shell workarounds, prompts, extensions, and failed tool calls where nobody owns it and everyone implements 30% of it differently.
- Evidence: O (design argument).
- Src: [STENCIL](../sources.md#stencil)

<a id="o16"></a>

**O16. Shell commands are interpreted, so approval can be capability-level**

- Kind: judgment, experiment
- Applies when: A harness is considering capability-level approval through shell interpretation.
- Assessment: Security review defines side-effect boundaries, including effects before file writes; trial parsing and enforcement against adversarial commands, measuring bypasses and compatibility. Stop on unauthorized effects; adopt only with accepted coverage and fallback policy.
- Works when: the harness parses and interprets Bash itself, runs common commands in-process, and asks for approval at the moment execution reaches a write (everything before is read-only). Preserves the model's muscle memory (grep routed to ripgrep), gives platform neutrality, and keeps shell state across calls.
- Fails when: models emit long dense one-liners no human reads before approving. Stencil cites Anthropic research that an auto mode (another Claude reading the command) beats humans by a wide margin.
- Evidence: O (design argument; the cited Anthropic result was not verified here).
- Src: [STENCIL](../sources.md#stencil)

<a id="o17"></a>

**O17. Agents have a bug-report path for the harness**

- Kind: control, judgment
- Applies when: Agent runs reveal confusing or defective harness behavior.
- Assessment: Require a feedback path with trace evidence; the harness owner triages reproducibility and attribution, tracking confirmed defects separately from model misconceptions before changing tools.
- Works when: agents can file feedback on tools (what was confusing, what misbehaved), and the reports are filtered. Signal on which tool fails and how is "tremendous" after filtering.
- Fails when: unfiltered, since models misattribute (Codex blames Read or LSP for external-edit problems and TypeScript rename limits).
- Evidence: E.
- Src: [STENCIL](../sources.md#stencil)

<a id="o18"></a>

**O18. Strong agent builds the loop; small agent grinds**

- Kind: experiment
- Applies when: Tasks have repeatable acceptance checks and a smaller model could execute iterations.
- Assessment: Compare strong-model-only execution with strong-model setup plus smaller-model iteration on matched tasks; measure accepted outcomes, total setup and run cost, and regressions. Stop on quality loss or exhausted budget before adopting a model split.
- Works when: a strong model writes the check, a one-page brief the small agent can follow without questions, and the test pages (a done/not-done definition, varied examples with a holdout, repeatability proof, ignorable differences, budget and stopping conditions); a cheap model then iterates (change one thing, run the check, read output, repeat) within the budget. Builder.io's rough estimate: a small OpenAI model near Opus-level results at a tenth to a twentieth of the price. Under two hours of grinding across four rounds; "every jump between rounds came from changing the check, not the model."
- Fails when: the check is vague and the small model is blamed. Hard thinking happens before the loop starts.
- Evidence: E (one author's estimate and one task; vendor of the framework used).
- Src: [BUILDER](../sources.md#builder)
