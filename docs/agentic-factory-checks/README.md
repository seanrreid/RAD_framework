# Agentic Software Factories: Checks for What Works and What Doesn't

Compiled 2026-10-09 from 15 sources (see [Source Key](sources.md#source-key)). Intended as input to another project.

## How to use this document

Each check has:

- **Kind**: one or more tags describing how a factory can use the check: `control`, `judgment`, or `experiment` (defined below).
- **Applies when**: the task, risk, workload, or environment conditions under which the check is relevant.
- **Assessment**: suggested evidence, evaluator, and response; experiments also identify comparison measures and stopping conditions. Project owners must supply concrete thresholds, budgets, and evaluation windows before use.
- **Works when**: the proposed success condition from the source synthesis; not proof that the practice causes success.
- **Fails when**: the observed or hypothesized failure pattern. Use these as audit questions.
- **Evidence**: the type of support behind the check, not its enforcement authority or a ranked confidence score.
  - `M` = a measurement or reported number from a named source
  - `E` = practitioner experience / anecdote
  - `O` = opinion, vendor position, or design argument
- **Src**: source keys.

Treat `E` and `O` checks as hypotheses to test, not facts. Many sources sell products related to their claims; those are flagged in the Source Key.

### Kinds and adoption

| Kind | Meaning | Factory behavior once configured |
|---|---|---|
| `control` | An explicit rule with an observable compliance condition | Enforce or audit the adopted rule at its stated boundary. |
| `judgment` | A contextual decision involving interpretation or tradeoffs | Gather evidence and route the decision to a named reviewer who records reasons. |
| `experiment` | A practice whose benefit needs validation for the project's workload | Run a bounded trial against a baseline with predefined success criteria and stopping conditions. |

Tags can overlap. For a mixed check, assess each part separately: satisfying a required review control does not imply the reviewer accepted the design, and successful trial results do not authorize adoption. A control can require human judgment; it need not be fully automated. An experiment tag identifies a proposed local trial, not necessarily a controlled experiment performed by the cited source. These classifications and the Applies when / Assessment fields are editorial guidance derived from the synthesis, not additional source findings. Evidence labels and their limitations remain separate.

Adoption is project-specific and belongs in the factory's configuration, keyed by check ID. Do not infer it from Kind or Evidence. Use `proposed`, `being trialed`, `adopted`, or `retired`, recording the owner, policy version, scope, and reason for each change. Only adopted controls carry enforcement authority; trial controls may be exercised or audited within an explicitly authorized trial scope. Trials must preserve already-adopted controls. An adopted experiment records a decision to use a practice, not proof of universal benefit.

Assessment outcomes are separately `pass`, `fail`, `unknown`, or `not applicable`. Missing evidence is `unknown`; record why a check is not applicable. An experiment passes only against its declared local success criteria, and a judgment requires the reviewer's recorded decision. Mixed checks retain separate outcomes for each part; do not collapse an unresolved judgment or trial into a pass because a related control passed. Before execution, project policy specifies whether an unknown result blocks work or requires escalation.

A project configuration record can use this shape (illustrative; no adoption decision is made here):

```yaml
check_id: V8
adoption: proposed
policy_version: 1
owner: null                    # Assign a named accountable reviewer before adoption.
scope: null                    # Define applicable changes and explicit exclusions.
assessment_plan:
  evidence: []                 # Required artifacts, tied to the assessed revision.
  evaluator: null              # Named reviewer or configured automated evaluator.
  enforcement_point: null      # For example, a PR gate or release boundary.
  failure_response: null       # For example, request changes or escalate.
  unknown_response: null       # Specify how missing evidence is handled.
trial_plan: null               # Experiments: baseline, corpus, metrics, success criteria,
                               # budget, evaluation window, stop conditions, rollback.
assessment_results: {}         # Store outcomes per Kind, evidence links, and reasons.
adoption_reason: null
```

### Use as input to a factory tool

The topic files in `checks/` group checks by concern; they are not an implementation sequence. Check IDs are stable references. The [Failure-mode lookup](indexes.md#failure-mode-lookup-symptom-to-response) is a selective index, not an exhaustive mapping. [Source Key](sources.md#source-key), [Source links](sources.md#source-links), and [Verification log](sources.md#verification-log-originals-opened-2026-10-09) provide provenance; [Coverage status](sources.md#coverage-status-and-remaining-gaps) and [Cross-source conflicts](sources.md#cross-source-conflicts-worth-noting) record limits.

These checks are candidate practices, not unconditional requirements. “Works when” describes the proposed success condition, not proof that the practice causes success. “Fails when” describes a reported failure or hypothesized risk; its absence does not prove the system is effective. `M` means a source reports a measurement, not that the practice has been independently validated.

The Applies when and Assessment fields are starting points. Before turning a check into a tool policy, configure its applicability (task risk, workload, environment), observable evidence, evaluator, enforcement point, and response to failure. Keep human decisions explicit for checks that require judgment. Distinguish pass, fail, unknown, and not applicable; do not treat missing evidence as a pass. Preserve the source and its limitations with each derived policy, and record a reason when choosing between conflicting practices. Reported settings and throughput figures are examples to evaluate, not thresholds to copy.

## Document map

Start with this guide for field definitions, adoption rules, and the configuration example. Load the relevant topic files for the task; use [indexes](indexes.md) to find checks by kind or failure symptom. Consult [sources](sources.md) when assessing provenance, numerical claims, or conflicts. Check IDs remain stable across files; each check and source key has an explicit link anchor.

| Topic | Checks |
|---|---|
| [Verification and review](checks/verification.md) | [V1](checks/verification.md#v1)–[V25](checks/verification.md#v25) |
| [Intent, specification, and task shape](checks/intent-and-tasks.md) | [S1](checks/intent-and-tasks.md#s1)–[S6](checks/intent-and-tasks.md#s6) |
| [Knowledge and context](checks/knowledge-and-context.md) | [K1](checks/knowledge-and-context.md#k1)–[K13](checks/knowledge-and-context.md#k13) |
| [Environment, sandbox, and security](checks/environment-and-security.md) | [E1](checks/environment-and-security.md#e1)–[E12](checks/environment-and-security.md#e12) |
| [Orchestration and loops](checks/orchestration.md) | [O1](checks/orchestration.md#o1)–[O18](checks/orchestration.md#o18) |
| [Cost and budget](checks/cost-and-budget.md) | [C1](checks/cost-and-budget.md#c1)–[C8](checks/cost-and-budget.md#c8) |
| [Measurement and improvement of the factory itself](checks/factory-improvement.md) | [M1](checks/factory-improvement.md#m1)–[M6](checks/factory-improvement.md#m6) |
| [Architecture, quality, and the codebase over time](checks/architecture-and-quality.md) | [A1](checks/architecture-and-quality.md#a1)–[A12](checks/architecture-and-quality.md#a12) |
| [People and organisation](checks/people-and-organisation.md) | [P1](checks/people-and-organisation.md#p1)–[P7](checks/people-and-organisation.md#p7) |
| [Closing the loop in production](checks/production-feedback.md) | [L1](checks/production-feedback.md#l1)–[L3](checks/production-feedback.md#l3) |

| Reference | Contents |
|---|---|
| [Indexes](indexes.md) | Kind lookup and failure-mode lookup |
| [Sources](sources.md) | Source key, URLs, verification log, coverage gaps, and cross-source conflicts |

