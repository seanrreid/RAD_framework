# 8. Architecture, quality, and the codebase over time

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="a1"></a>

**A1. Maintainability is not measured by task benchmarks**

- Kind: control, judgment
- Applies when: Agent-produced changes affect long-term architecture or maintainability.
- Assessment: Require a named code owner and substantive maintainability review; the owner records design risks and remediation rather than certifying design quality from task-benchmark success.
- Works when: someone reads and owns the code; humans steer architecture.
- Fails when: lights-off development, then an unreproducible issue requires investigating code nobody has read in months (HumanLayer, tried July 2025). Models are trained on tests-pass rewards with no signal for long-term design quality; benchmarks cannot yet settle this.
- Evidence: E (Horthy, explicitly experience-based, not provable with available benchmarks). Reported industry signals: Faros AI findings of more review comments, more unreviewed merges, rising incidents and bugs per developer (not proof of causation).
- Src: [HORTHY](../sources.md#horthy)

<a id="a2"></a>

**A2. Agents amplify existing code quality**

- Kind: judgment
- Applies when: Agents are extending a codebase with existing patterns.
- Assessment: The code owner selects appropriate patterns and reviews generated structure for coupling and unnecessary complexity; reject harmful imitation and record where an existing pattern should change.
- Works when: structure has separation of concerns and clear contracts; agents follow existing patterns.
- Fails when: a ball of mud invites more mud. Agents default to horizontal slices (Claude), over-clever code (Codex); "ask them to follow an existing pattern."
- Evidence: E (Swizec).
- Src: [SWZ](../sources.md#swz)

<a id="a3"></a>

**A3. Codebase rot is prevented actively**

- Kind: control, judgment
- Applies when: Agent changes can introduce dead code, duplication, type complexity, or data-model drift.
- Assessment: Require applicable static checks and recurring code-owner review; triage findings and remove confirmed rot while documenting exceptions rather than deleting code solely on a tool's suggestion.
- Works when: something checks for dead code, duplicate ways of doing one thing, unintuitive types, data model drift.
- Fails when: agents leave dead code and the codebase spirals; agents also generate unnecessarily defensive code.
- Evidence: O.
- Src: [DETAIL](../sources.md#detail)

<a id="a4"></a>

**A4. Product debt is managed**

- Kind: judgment
- Applies when: Feature volume creates inconsistent UX or growing maintenance effort.
- Assessment: The product and design owners review complete user journeys, usage, and support burden; record consolidation, redesign, or retirement decisions and track the resulting workload.
- Works when: end-to-end UX review, design systems, component libraries, and pruning of unused features exist.
- Fails when: every engineer ships a locally-optimal feature, the product looks clunky, and maintenance multiplies (52 features a year with a 0.5% daily bug chance each is nearly a day a week of fixing, per Swizec's arithmetic).
- Evidence: E.
- Src: [SWZ](../sources.md#swz)

<a id="a5"></a>

**A5. Buy primitives where ownership is now cheap**

- Kind: judgment, experiment
- Applies when: Custom UI requirements diverge from a high-level library's supported behavior.
- Assessment: Compare a bounded primitive-based spike with the existing abstraction; assess design fidelity, accessibility, maintenance, and total cost. Stop on missing expertise or coverage, and retain mature libraries where they better meet requirements.
- Works when: custom, design-critical UI is built on unopinionated primitives (scales, shapes) with a thin owned layer. One spike matched a design exactly; a Recharts twin hit a wall on the last 20% and froze an animation.
- Fails when: high-level libraries are used for requirements far off their happy path; or when the team lacks an agentic workflow (old math still applies); or for commodity UI, deep-accessibility components (combobox, date picker, modal), or hard stable problems (dates, validation, positioning).
- Evidence: E (one spike; author notes his spike worked because he could judge the output).
- Src: [WIERUCH](../sources.md#wieruch)

<a id="a6"></a>

**A6. Don't rebuild what you can buy**

- Kind: judgment
- Applies when: Selecting which factory components to buy or build.
- Assessment: The platform owner compares available components with project requirements, integration cost, ownership burden, and unique needs; document the decision and reassess when constraints change.
- Works when: the agent, gateway, sandbox, tracing, and reviewer are bought; what you build is your own warm repo snapshot, tool catalog, context, blueprints, and gate policy.
- Fails when: recreating Copilot/Cursor/Replit internally (LinkedIn's Prince Valluri).
- Evidence: O/E.
- Src: [FAIK](../sources.md#faik)

<a id="a7"></a>

**A7. Deterministic rules beat agents where a rule can be written**

- Kind: judgment, experiment
- Applies when: A migration or repetitive transformation can be expressed deterministically.
- Assessment: Assess whether a rule fully describes the transformation; trial it on representative cases against agent execution, measuring correctness and total effort. Stop on uncovered cases and route those for judgment rather than assuming every task is scriptable.
- Works when: a deterministic tool does the migration and AI only debugs failures. Uber: Shepherd generated over 5,000 diffs and moved 75,000+ test classes in four months; the earlier attempt to migrate multiple test files with generative AI was unsuccessful.
- Fails when: an agent is used for work a script could do exactly.
- Evidence: M (Uber).
- Src: [FAIK](../sources.md#faik)

<a id="a8"></a>

**A8. Session state has one authority**

- Kind: control
- Applies when: Sessions support rewind, fork, resume, retries, or extension state.
- Assessment: Exercise replay and branch changes across every stateful component; require state derived from the authoritative journal and reject transitions that retain stale or missing state.
- Works when: all state (todo, retry, subagents, streaming, tools, settings) derives from one journaled source so rewind, fork, and resume are truthful.
- Fails when: state lives in closures and side channels. In the Pi examples audit, only 2 of 17 stateful extensions were correct under rewind/resume.
- Evidence: M/E (Stencil, own audit; Stencil is the author of a competing harness).
- Src: [STENCIL](../sources.md#stencil)

<a id="a9"></a>

**A9. Model quirks live in one rulebook**

- Kind: control, judgment
- Applies when: Provider or model capabilities influence several runtime decisions.
- Assessment: Audit a versioned capability registry and declared precedence; the maintainer reviews new quirks, preserving unknown states and rejecting contradictory duplicated rules.
- Works when: capability knowledge is declared in one place with explicit precedence; unknown means unknown, not false.
- Fails when: the same quirk is encoded as branches across several files (previously 880 + 977 + 1,776-line files).
- Evidence: E.
- Src: [STENCIL](../sources.md#stencil)

<a id="a10"></a>

**A10. Tool-call dialect tolerance**

- Kind: control, judgment, experiment
- Applies when: Models emit syntactic variations of otherwise valid tool arguments.
- Assessment: Keep semantic validation mandatory; trial narrowly defined repairs on valid and adversarial cases, measuring retry reduction and incorrect coercion. Reject ambiguous inputs with structured errors and stop repairs that change intent.
- Works when: strict on the semantic contract, charitable about the model's dialect (repair `paths: "a,b"` into a list when unambiguous; otherwise a structured, retryable error).
- Fails when: raw JSON-schema validation alone; schemas used by other harnesses emerge from models trained on them.
- Evidence: E.
- Src: [STENCIL](../sources.md#stencil)

<a id="a11"></a>

**A11. Language and stack are chosen for the defaults they impose on agents**

- Kind: judgment, experiment
- Applies when: Choosing or standardizing a stack for substantial agent-produced code.
- Assessment: Compare bounded representative tasks across plausible stacks or conventions; assess correctness, style drift, maintenance, and team expertise. Stop if switching costs exceed benefit; do not change an existing stack solely on the author's comparison.
- Works when: languages and ecosystems with strong conventions steer generated code (Swift's stdlib, layout, compiler errors; Go and Rust proposed). Compiler/type safety helps.
- Fails when: a language with many equally normal styles (TypeScript: Zod vs Typebox, classes vs objects, ESM vs CJS, and so on) makes the model pick a style repeatedly; output drifts and juniors "roll an isRecord." Even in Rust, agents need steering (allocating copies instead of borrows, errors as strings instead of thiserror).
- Evidence: E/O (author's experience; the Swift vs Qt/JS widget comparison is informal and he concedes prompting matters).
- Src: [STENCIL](../sources.md#stencil)

<a id="a12"></a>

**A12. External text is sanitised before it reaches the UI**

- Kind: control
- Applies when: External tool, fetched, or model text is rendered in a terminal or other UI.
- Assessment: Exercise hostile escape sequences and width-sensitive strings at the rendering boundary; require sanitization and layout integrity and block unsafe content without relying on each extension to sanitize correctly.
- Works when: strings from fetched content, tools, or models are sanitised at a single layer and presentation policy (icons, semantic colours, borders, truncation by visible width) belongs to the renderer, not each tool or extension.
- Fails when: extensions render pre-built strings: a fetched page can inject ANSI escapes and replace the UI; truncation by codepoint breaks layout; every tool looks like a gray rectangle (99%) or out of context (1%).
- Evidence: E (a real community renderer is dissected). Performance finding: the string-array render contract cost 267s of render time in one session vs 90ms after a one-pass streamed primitive.
- Src: [STENCIL](../sources.md#stencil)
