# 2. Intent, specification, and task shape

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="s1"></a>

**S1. Intent is explicit, checkable, and traceable**

- Kind: control, judgment
- Applies when: Work is translated from stakeholder intent into agent tasks.
- Assessment: Require purpose, requirement, scenario, and evidence links in both directions; the product owner confirms that scenarios express intent and returns ambiguous or untraceable requirements.
- Works when: vague prose becomes a structured requirement (EARS), an executable scenario (BDD), and evidence tied to a business purpose; traceability runs both directions.
- Fails when: intent degrades at each handoff (stakeholder, analyst, architect, developer, model).
- Evidence: O. Etnetera slides 4, 15-20. The "LLMs are better programmers" claim is flagged by the author as provocation, not demonstrated.
- Src: [ETN](../sources.md#etn)

<a id="s2"></a>

**S2. PRD states why, scope, exclusions, and success criteria**

- Kind: control, judgment
- Applies when: A task needs a PRD or equivalent intake specification.
- Assessment: The intake gate checks why, scope, exclusions, success criteria, and contact; the product owner resolves ambiguity before implementation proceeds.
- Works when: out-of-scope is written down (stops agents inventing or widening work); success criteria link to observable business results.
- Fails when: "fix export" with no criteria, scope, or contact.
- Evidence: O/E. Requirements are called the weakest link in practice.
- Src: [ETN](../sources.md#etn)

<a id="s3"></a>

**S3. Tasks are business-verifiable slices**

- Kind: judgment
- Applies when: Large or cross-repository work is being decomposed into tasks.
- Assessment: The delivery owner reviews slices for end-to-end business outcomes, dependencies, acceptance, and manageable size; revise technical-only slices and choose duration targets for the project.
- Works when: a slice's outcome shows whether the whole system works; roughly one week or less; contains acceptance, constraint, verification, context, and a named contact.
- Fails when: the task is technical with no business outcome ("create three endpoints"), or cross-repo work is sliced without alignment.
- Evidence: O (Etnetera heuristics).
- Src: [ETN](../sources.md#etn), [HORTHY](../sources.md#horthy)

<a id="s4"></a>

**S4. Plans are vertical slices with tests between phases**

- Kind: control, judgment
- Applies when: A multi-phase change needs an implementation plan.
- Assessment: Require per-phase tests and dependency ordering in the plan; the technical owner judges whether slices exercise useful end-to-end behavior and resolves cross-repository coordination gaps.
- Works when: planning makes implementation order, cross-repo coordination, and per-phase checks explicit.
- Fails when: models default to horizontal plans.
- Evidence: O/E. Horthy estimates 30 minutes of alignment can save hours of review (his estimate, not measured).
- Src: [HORTHY](../sources.md#horthy)

<a id="s5"></a>

**S5. Decisions are made before implementation, cheaply**

- Kind: judgment, experiment
- Applies when: Substantial changes can benefit from decisions before coding.
- Assessment: The technical owner chooses review depth by risk; trial upfront product, architecture, and program design against comparable tasks, measuring rework and total lead time. Stop or simplify the process when overhead outweighs benefit.
- Works when: product review, architecture contract, then program design (types, signatures, call stacks) precede coding; small changes bypass this.
- Fails when: design disagreements surface first in code review.
- Evidence: O/E.
- Src: [HORTHY](../sources.md#horthy)

<a id="s6"></a>

**S6. Requirement strength is stated**

- Kind: control, judgment
- Applies when: Specifications use requirement keywords to communicate obligations.
- Assessment: Audit the declared keyword convention and consistent usage; the requirement owner assesses severity separately and resolves ambiguous escalation rules rather than inferring risk from keyword strength alone.
- Works when: MUST/SHOULD/MAY are used with an RFC 8174 uppercase convention declared; escalation combines keyword strength with severity and context.
- Fails when: keyword strength is treated as business risk.
- Evidence: O.
- Src: [ETN](../sources.md#etn)
