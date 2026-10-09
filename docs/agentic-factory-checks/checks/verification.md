# 1. Verification and review

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="v1"></a>

**V1. Verification capacity grows with code output**

- Kind: control, judgment
- Applies when: Code generation increases the volume or complexity of changes awaiting verification.
- Assessment: Audit review backlog, latency, reviewer workload, and escaped defects together; the engineering lead adjusts capacity or admission limits when the queue exceeds project targets.
- Works when: review/validation throughput is measured and scaled alongside generation (automated gates, risk-based routing).
- Fails when: output rises 10-30x while careful human review stays flat; approvals become mechanical; seniors become merge bottlenecks.
- Evidence: M/E. Etnetera reports 10x typical, 30x peak output (speaker-reported, no benchmark). Uber: time to first review rose from 3h (2024) to 9h (2026). Spotify: 76% more PRs to review. Faros: 441.5% rise in median time in review (22,000 devs), distinct from its 156.6% rise in median time to first review.
- Src: [ETN](../sources.md#etn), [UBR-T](../sources.md#ubr-t), [FAIK](../sources.md#faik), [SWZ](../sources.md#swz)

<a id="v2"></a>

**V2. "Done" is evidence per requirement, not the agent's declaration**

- Kind: control
- Applies when: A task has stated requirements and is being marked complete.
- Assessment: At completion, require requirement-to-evidence links tied to the final revision; reject missing or stale evidence and return the unmet requirements to the worker.
- Works when: every requirement maps to a scenario/test and a code link; completion = evidence exists for each.
- Fails when: the agent reports "done" with requirements missing.
- Evidence: O. Etnetera slides 18, 35. baro: critic judges captured command output bound to the exact bytes changed; editing after evidence voids it.
- Src: [ETN](../sources.md#etn), [BARO](../sources.md#baro)

<a id="v3"></a>

**V3. Nobody grades their own homework**

- Kind: control
- Applies when: Worker output is being certified for merge or run completion.
- Assessment: The acceptance gate checks that an independent verifier evaluated the final merged tree; reject worker-only certification and require fresh proof after relevant changes.
- Works when: the worker reports, but a separate institution certifies (critic, merge gate, run-level verifier on the merged tree).
- Fails when: the same agent writes the code, writes the tests, and declares success.
- Evidence: E. baro measured ~45% of story wall-clock spent after the last file write, proving the code. Moving whole-tree proof to a single run-level gate cut per-story cost.
- Src: [BARO](../sources.md#baro), [HORTHY](../sources.md#horthy)

<a id="v4"></a>

**V4. Tests are held out or protected from the agent**

- Kind: control
- Applies when: Protected tests or held-out evaluation tests judge agent-produced changes.
- Assessment: The evaluation runner checks protected test integrity against the approved baseline; restore unauthorized edits, retain legitimate new tests separately, and reject attempts to weaken protected expectations.
- Works when: the agent cannot weaken, delete, or comment out tests to get green; test-file edits are reverted before the evaluation run.
- Fails when: expectations are loosened to make a test pass.
- Evidence: O/E. Etnetera rule: "never weaken expectations to make a test pass, repair the implementation." Horthy describes SWE-bench-style held-out test patches and test-file reverts.
- Src: [ETN](../sources.md#etn), [HORTHY](../sources.md#horthy)

<a id="v5"></a>

**V5. The measure is outside the loop's authority**

- Kind: control
- Applies when: An optimization loop can modify the product it is scored on.
- Assessment: At each round, compare grader, fixture, corpus, and threshold versions to the frozen baseline; reject unauthorized changes and route proposed measurement changes to the evaluation owner outside the scored round.
- Works when: corpus, fixture, score rules, and existing checks are frozen; the loop may add regression checks but not weaken thresholds; no product lever and its measure change in the same round.
- Fails when: the loop optimizes a bad measure or edits its own grader.
- Evidence: O (design argument with worked process).
- Src: [JX0](../sources.md#jx0)

<a id="v6"></a>

**V6. Floor vs. direction are separate signals**

- Kind: control, judgment
- Applies when: A development loop uses evaluations to choose product improvements.
- Assessment: Require separate correctness-floor and real-request evaluation records; block floor regressions while the product owner interprets capability results and selects the next work.
- Works when: a deterministic floor (tests, validators, effect checks) must stay green, and a separate real-request evaluation chooses what to build next.
- Fails when: passing tests is treated as proof the capability is right; one perfect run is read as reliability.
- Evidence: O.
- Src: [JX0](../sources.md#jx0)

<a id="v7"></a>

**V7. Verify beyond code correctness**

- Kind: control, judgment
- Applies when: A change can affect quality dimensions beyond tested behavior.
- Assessment: Before merge, require evidence for each applicable quality dimension; designated specialists assess non-automatable concerns and record acceptance, remediation, or a justified exception.
- Works when: behaviour, maintainability, security, operations, and regulatory dimensions each have a check (some automated, some expert).
- Fails when: only behaviour (tests) is verified.
- Evidence: O. Etnetera slide 29.
- Src: [ETN](../sources.md#etn)

<a id="v8"></a>

**V8. Passing tests are not accepted as proof of good architecture**

- Kind: control, judgment
- Applies when: Changes cross module boundaries, alter contracts, or add architectural complexity.
- Assessment: Require an architecture review at the merge boundary; a named system owner judges placement, coupling, and maintainability, records reasons, and requests changes where needed.
- Works when: a person who knows the system judges whether the change belongs where it was put; SonarQube/review agents handle routine maintainability only.
- Fails when: e2e tests pass while five modules become coupled.
- Evidence: O (Etnetera, speaker opinion) and E (Horthy; reward on tests does not penalise poor design; unnecessary exception handlers, expedient type casts).
- Src: [ETN](../sources.md#etn), [HORTHY](../sources.md#horthy)

<a id="v9"></a>

**V9. Agentic review output is itself reviewed**

- Kind: control, judgment
- Applies when: An agent or bot generates review findings.
- Assessment: Require triage dispositions for findings before relying on the review; the reviewer validates relevance, severity, and context rather than accepting the bot's recommendation as approval.
- Works when: review bots' comments are triaged; humans keep judgement on context and risk.
- Fails when: bot comments are taken at face value. Swizec rejects about half of BugBot's comments as irrelevant or premature; building a custom reviewer was worse.
- Evidence: E.
- Src: [SWZ](../sources.md#swz)

<a id="v10"></a>

**V10. Review ping-pong is avoided**

- Kind: control, experiment
- Applies when: Review comments are repeatedly relayed between requester and coding agent.
- Assessment: Trial reviewer-directed fixes against the existing workflow; compare review touches, elapsed time, and regressions, stopping on unsafe edits. Regardless of routing, require fresh checks for every revised diff.
- Works when: the reviewer has an agent make the fix, tests rerun, and the revised diff returns for review; any diff change during review re-passes tests and checks.
- Fails when: reviewer comment, requester relays to agent, agent revises, repeated.
- Evidence: O. Etnetera proposes this; labelled "proposed".
- Src: [ETN](../sources.md#etn)

<a id="v11"></a>

**V11. Review rounds between agents are capped**

- Kind: control
- Applies when: Agents alternate implementation and review in a retry loop.
- Assessment: The orchestrator counts review rounds against a configured limit; stop at the limit and hand off the unresolved findings and evidence rather than restarting the counter.
- Works when: build-review rounds have a limit.
- Fails when: agents keep criticising the same work forever.
- Evidence: O (Etnetera slide 23).
- Src: [ETN](../sources.md#etn)

<a id="v12"></a>

**V12. Evidence package accompanies each PR**

- Kind: control
- Applies when: A PR is submitted for review with behavioral acceptance criteria.
- Assessment: The PR gate requires a revision-bound evidence package covering applicable checks; return incomplete submissions and require revalidation when the diff invalidates evidence.
- Works when: the human reviewer gets a table of checks passed (screenshots, simulator output, demo videos) before reading the diff.
- Fails when: reviewers must reconstruct what was verified.
- Evidence: E. Uber describes this table; Swizec still requires a happy-path smoke test himself.
- Src: [FAIK](../sources.md#faik), [SWZ](../sources.md#swz)

<a id="v13"></a>

**V13. Security review starts from a deterministic inventory**

- Kind: control, judgment
- Applies when: Security review covers enumerable endpoints or other entry points.
- Assessment: Compare inventory coverage with review rows; a security reviewer validates authorization findings and resolves unassessed entries before sign-off. Inventory coverage alone does not prove security.
- Works when: endpoints are enumerated from framework structure; every one gets a row; the model assesses each against explicit requirements (e.g. ownership authorisation).
- Fails when: the prompt is "find the security issues" and completeness of the search cannot be known.
- Evidence: O. Etnetera slides 13-14. "Authenticated is not owner" (speaker has seen editing a URL expose another user's data).
- Src: [ETN](../sources.md#etn)

<a id="v14"></a>

**V14. "How to verify" is defined up front, as an off-screen, non-destructive interface**

- Kind: control, experiment
- Applies when: Agents change an interactive TUI or GUI whose behavior is difficult to observe.
- Assessment: Require a defined verification path; trial the proposed debug interface against representative interactions, measuring detection coverage and side effects. Stop on destructive behavior or misleading results before adoption.
- Works when: for any interactive TUI/GUI, the agent is asked to implement a debug/verification protocol (custom tool, package, or API) that is non-destructive, off-screen, and multi-instance, so verification is part of the development loop.
- Fails when: "how to verify" is unspecified; the agent side-channels a look-alike, usually a test file that checks nothing, and redefines (and downgrades) success.
- Evidence: E/O (Stencil: "biggest ROI investment that also costs you nothing").
- Src: [STENCIL](../sources.md#stencil)

<a id="v15"></a>

**V15. Formally specify what cannot be reliably tested**

- Kind: judgment, experiment
- Applies when: Critical state transitions or concurrency invariants are difficult to validate with ordinary tests.
- Assessment: The system owner selects invariants and reviews model assumptions; trial model checking against known violations with a bounded budget. Adopt only if it adds useful coverage; a passing specification alone does not prove implementation conformance.
- Works when: a hard behaviour (e.g. terminal transcript commit/finalise/resize invariants) is modelled in a spec language (TLA+) and the agent iterates until the invariants hold; later changes check against the model and get a counterexample on failure.
- Fails when: the only recourse is a fuzzer built after the fact. Stencil needed one in the previous iteration.
- Evidence: E (one project).
- Src: [STENCIL](../sources.md#stencil)
- Related: the Etnetera deck lists compiler-enforced formal verification as an aspiration with no tool or timetable.

<a id="v16"></a>

**V16. Behaviour audits trace the whole chain, including bypasses**

- Kind: control, judgment
- Applies when: Auditing a behavior or permission rule that spans several implementation sites.
- Assessment: Require a code-linked trace through enforcement and bypass paths; the audit owner checks path coverage and resolves unexplained routes before certifying the behavior.
- Works when: a rule such as "ask before deleting files" is verified by tracing prompt, tool wrapper, permission config, state record, sandbox execution, and fallback paths, with a code citation for every decision. Edge cases checked separately: headless mode, auto-approval policies, fallback routes.
- Fails when: the conclusion rests on documentation, or on keyword search for "delete/permission/confirm", which returns scattered fragments; one behaviour is decided by several sites and no single `confirmBeforeDelete()` exists.
- Evidence: O. Scale reference: the Codex harness spans 2,267 files, 34,000+ functions, nearly 160,000 code connections.
- Src: [HANDBOOK](../sources.md#handbook)

<a id="v17"></a>

**V17. "Done" is a check the agent can run itself, with feedback on where it is wrong**

- Kind: control
- Applies when: A bounded task can be evaluated by a repeatable automated check.
- Assessment: Require a runnable acceptance check and actionable failure output before unattended iterations; the completion gate verifies its final result while keeping independent acceptance under [V3](verification.md#v3).
- Works when: the goal becomes a number or pass/fail the agent can run unattended ("back pressure": tests, builds, type checks, anything that rejects a bad attempt). Builder.io's import fidelity check gave a pixel-diff score plus an image with mismatches marked in red: the number says whether a change helped, the overlay says where to look next. Other examples: P90 response times, error rates, verifiable user behaviour, automatable browser workflows, plain unit tests.
- Fails when: a human is the verifier, typing "still wrong, the heading moved again" into chat; progress moves at human-looking speed and the agent knows only what someone remembered to say.
- Evidence: E. One slide import went from 88% pixel mismatch to 2% over one weekend with a small model; import/export complaints (dozens a day) stopped after the loop.
- Src: [BUILDER](../sources.md#builder)

<a id="v18"></a>

**V18. Test the check before trusting it**

- Kind: control
- Applies when: A new or changed automated grader will drive agent decisions.
- Assessment: The evaluation owner requires repeatability tests and known-good and known-bad cases; reject a grader that misclassifies them or fails agreed noise tolerances before it scores work.
- Works when: rendering the same thing twice scores zero; known-bad results score badly; acceptable results score well; differences that should not count (font rendering, 1px shifts) are listed so the agent does not spend hours on noise. A strong agent builds the check and the test pages (original rendered twice, known-bad pages, acceptable pages).
- Fails when: the check is wrong and the agent believes it ("an agent working against a number will believe the number"). Reported defects: missing fonts made one export look 17% off when the real difference was 0.19%; four bugs found in the check itself; scoring mismatches as a share of the whole screenshot made a blank page on a dark background score only 3-5% (after fixing, 57%+); a too-strict version scored a 1px page shift at 31%.
- Evidence: E.
- Src: [BUILDER](../sources.md#builder)

<a id="v19"></a>

**V19. Use real, varied examples, and hold some back; replace held-back examples once they are used**

- Kind: control, judgment
- Applies when: A corpus-based evaluation is used to tune a capability.
- Assessment: Check corpus version, diversity, full-corpus results, and holdout exposure records; the evaluation owner assesses representativeness and replaces exposed holdouts before claiming unseen-case performance.
- Works when: the check spans a wide corpus (Figma files, API, PowerPoint, PDF, Google Slides), every change is judged against the whole set (two fixes "made the frame better and the corpus worse" and were reverted), and unseen examples reveal whether the agent solved the problem or learned the examples. Once held-out examples inform decisions they are no longer held out; set aside new ones.
- Fails when: a few tidy samples let the agent pass. Round data, rebuilt-page loop: checked 5 widths passed in 5 min while 0 of 3 held-back widths passed (fastest pass, worst result); checked 28 widths passed in 59 min / 55 runs, 3 of 5 held-back passed.
- Evidence: E (one task).
- Src: [BUILDER](../sources.md#builder)

<a id="v20"></a>

**V20. What matters goes into the check, not only the brief**

- Kind: control, judgment
- Applies when: Requirements are being translated into an automated acceptance score.
- Assessment: Audit requirement-to-check coverage; the owner either adds a suitable observable check or assigns explicit human assessment, blocking completion claims for requirements evaluated by neither.
- Works when: every requirement the agent must meet is something the check can see. The agent does what the number rewards.
- Fails when: the brief says "must hold at every width in between" but the check measures three widths; the agent fixes what the check sees (round 2: passed the checked widths in 9 min, failed the same held-back widths).
- Evidence: E.
- Src: [BUILDER](../sources.md#builder)

<a id="v21"></a>

**V21. The check is off-limits, and a disagreement is escalated**

- Kind: control
- Applies when: An iterative worker uses a check, examples, or tolerances it could otherwise edit.
- Assessment: Audit that measurement changes were authorized outside the worker loop; enforce protected versions for adopted policies and route disagreements to the grader owner. A prompt alone is not integrity evidence.
- Works when: the prompt says not to edit the check, the examples, or the tolerances, and to stop and explain if one seems wrong. Reported: across four rounds the agent never touched the check.
- Fails when: an agent working to lower a number finds it easier to change the measurement than the code.
- Evidence: E (prompt-level control on one model; compare [V5](verification.md#v5), which uses authority tiers).
- Src: [BUILDER](../sources.md#builder), [JX0](../sources.md#jx0)

<a id="v22"></a>

**V22. Read the output before the score**

- Kind: judgment
- Applies when: An evaluation stalls, passes unexpectedly fast, or reports success on generated output.
- Assessment: A reviewer inspects representative output before the score, checks for artifacts and shortcuts, and records whether to fix the implementation, repair the grader, or collect more evidence.
- Works when: a human looks at what the agent produced (e.g. a visual recap) before the score. A stall can mean the check is wrong (round 1: stuck at 16.7% while the page looked nearly identical; the half-pixel tolerance was the problem). A fast pass can mean a shortcut (the page showed the menu button only between 1024 and 1100px, just covering the one unseen width it could infer, and nudged letter spacing by 0.03px to force a wrap).
- Fails when: a stall is blamed on the model and a bigger one is swapped in.
- Evidence: E.
- Src: [BUILDER](../sources.md#builder)

<a id="v23"></a>

**V23. If code style matters, the check must measure it**

- Kind: control, judgment
- Applies when: Style or maintainability is an explicit acceptance requirement.
- Assessment: Require separate style evidence and review for concerns the check cannot capture; the reviewer records findings and the gate rejects unmet adopted criteria even when output scores pass.
- Works when: style/maintainability requirements are encoded in a separate check.
- Fails when: only outputs are measured. The page looked right almost everywhere but its stylesheet had 21 media queries, many covering 25-50px, where a person would write a few fluid rules.
- Evidence: E (author's own caveat).
- Src: [BUILDER](../sources.md#builder)

<a id="v24"></a>

**V24. Final scores become regression ceilings**

- Kind: control
- Applies when: A loop has produced an accepted baseline for a repeatable scored task.
- Assessment: Persist the approved corpus, grader version, and project-selected regression ceilings; CI rejects later regressions and baseline changes require evaluation-owner approval.
- Works when: the check is kept and the final scores are turned into ceilings in a test, so a later change that makes results worse fails it.
- Fails when: the check is thrown away after the loop finishes.
- Evidence: O.
- Src: [BUILDER](../sources.md#builder)

<a id="v25"></a>

**V25. Verification is layered, not a single gate**

- Kind: control, judgment
- Applies when: A change is being admitted to production through verification gates.
- Assessment: Audit the applicable verification layers and their distinct failure coverage; the risk owner assesses common blind spots, requiring missing evidence before release rather than relying on layer count alone.
- Works when: the AI checks its own work through several independent layers (tests, a reviewer agent, production observability), so one weak gate does not decide. Tunguz maps this to Meadows's "resilience". Lauren Tan, asked how she ships about 2,000 PRs a month, names verification (loops that let the AI validate its own work), not a model.
- Fails when: one gate stands between agent output and production.
- Evidence: O/E. Throughput figures are second-hand: Artemis Security reports 30,000 PRs in eight months and 16 merged PRs per engineer per day during the reported week, up from 2 in January and 6 three months earlier (company posts; Tunguz interprets the latter periods as May and August 2026; Artemis is a portfolio company of the author, a venture investor); Tan's 2,000 PRs/month is from her own write-up. These are volume figures with no quality measure (see [C2](cost-and-budget.md#c2)).
- Src: [TUNGUZ](../sources.md#tunguz)
