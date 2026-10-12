# 9. People and organisation

[Guide](../README.md) · [Indexes](../indexes.md) · [Sources](../sources.md)

<a id="p1"></a>

**P1. Humans stay for judgement; route by risk**

- Kind: control, judgment
- Applies when: Task risk determines autonomy and escalation.
- Assessment: The risk owner defines routing criteria; audit that tasks receive the required independent review and escalate ambiguity. Reject actions lacking required approval and review both unnecessary escalation and missed risk.
- Works when: low risk completes independently; medium risk gets QA/senior assessment; high risk gets architect/security approval; escalation triggers on unclear intent, conflicting requirements, or uncovered risk. Sensitive changes keep independent approval.
- Fails when: everything is escalated (does not scale) or nothing is (quality drifts).
- Evidence: O.
- Src: [ETN](../sources.md#etn)

<a id="p2"></a>

**P2. Fewer manual confirmations, not zero**

- Kind: control, judgment
- Applies when: A team is reducing manual confirmations, especially under regulated change processes.
- Assessment: The compliance or release owner identifies required approvals and records permitted exceptions; the gate verifies those approvals survive automation and blocks unauthorized removal.
- Works when: checkpoints and records persist; regulated approvals stay required; the trend is toward humans handling exceptions.
- Fails when: removal of human review is assumed possible. Etnetera labels "people see only important changes within a year" as aspiration, not forecast; auditor acceptance of self-review is untried in banking.
- Evidence: O.
- Src: [ETN](../sources.md#etn)

<a id="p3"></a>

**P3. Adoption: take toil first, work in public, make it opt-in**

- Kind: judgment, experiment
- Applies when: Introducing agents to a team or expanding their use.
- Assessment: Choose a toil pilot and trial visible, opt-in workflows; measure adoption, satisfaction, accepted outcomes, and quality against the baseline. Stop or adjust if usage rises without value or team burden increases.
- Works when: first agent targets toil (migrations, flag cleanup, review); work happens in team channels; use is not mandated; relief is visible to teammates. Uber: "much higher satisfaction" after moving upgrades, migrations, bug fixes to AI; top-down mandates are less efficient than engineers sharing wins. Ramp did not force Inspect; it wrote about 60% of PRs two months after v2 and about 75% by May.
- Fails when: private channels (DoorDash: "did not create team habits"); mandates yield usage metrics, not value (Duolingo reversed its mandate).
- Evidence: E.
- Src: [FAIK](../sources.md#faik)

<a id="p4"></a>

**P4. Dark factories are not the realistic target now**

- Kind: judgment
- Applies when: Leadership is setting autonomy goals and engineering roles.
- Assessment: Engineering leadership reviews oversight needs, ownership, and team feedback; record a realistic operating model and revisit it as reliability evidence changes instead of assuming a no-human target.
- Works when: the factory is framed around engineers building both the product and the factory.
- Fails when: leaders pursue no-human-oversight, causing demotivation and attrition.
- Evidence: O (Lloyd; vendor).
- Src: [LLOYD](../sources.md#lloyd)

<a id="p5"></a>

**P5. Accountability stays with a named human**

- Kind: control
- Applies when: A feature or automated change is being shipped and needs operational ownership.
- Assessment: Require a named accountable human and an operational contact in the release record; reject ownership gaps and route incidents to the recorded owner.
- Works when: whoever ships a feature owns running it; the person signs it "with their phone number."
- Fails when: "translate English into code" roles with no ownership.
- Evidence: E.
- Src: [SWZ](../sources.md#swz)

<a id="p6"></a>

**P6. Work-in-progress is capped**

- Kind: control, judgment
- Applies when: Cheap task starts create more concurrent work than the team can finish.
- Assessment: The delivery owner sets work-in-progress and ad-hoc budget limits; audit active work at admission, defer excess items to triage, and review completion and urgency to adjust limits.
- Works when: a daily budget for ad-hoc fixes exists; everything else goes to triage; "Not yet" is said often.
- Fails when: cheap starts create six open draft PRs by 3pm and nothing important ships.
- Evidence: E.
- Src: [SWZ](../sources.md#swz)

<a id="p7"></a>

**P7. Skill development path is addressed**

- Kind: judgment, experiment
- Applies when: Agent adoption changes how less experienced engineers develop skills.
- Assessment: The engineering manager defines learning goals and trials paired reviews or incident learning; assess demonstrated understanding and operational performance over a stated period. Stop or revise if learning stalls or workload becomes unsustainable.
- Works when: paired reviews and learning through incidents are used (open question in the Etnetera Q&A).
- Fails when: unknown; flagged as unanswered.
- Evidence: O.
- Src: [ETN](../sources.md#etn)
