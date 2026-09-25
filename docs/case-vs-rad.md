# CASE vs RAD

A comparison of [WorkOS CASE](https://github.com/workos/case) against RAD. The
harness-engineering articles reviewed in
[`harness-engineering-vs-rad.md`](harness-engineering-vs-rad.md) describe harness
*thinking*. CASE is a harness *system*, and by far RAD's closest sibling. Like the
Cosmos, CUGA and WSD reviews in [`references.md`](references.md), the headline
finding is **convergent design validation**: CASE independently arrived at nearly
all of RAD's core primitives.

The load-bearing difference is **who the harness serves**: CASE serves a developer
pointing an autonomous agent at an issue, and RAD serves a team that must prove who
approved what.

Source: [`workos/case`](https://github.com/workos/case), its README and design
docs as published at review time.
Captured: 2026-06-22 · Refreshed: 2026-09-25

> **Refresh note (2026-09-25).** This was originally a section of the
> harness-engineering comparison. The original assessment is preserved; where RAD
> has since moved, the claim is marked *Update 2026-09-25* inline. Two of CASE's
> three leads over RAD (the ratchet and evidence discipline) have narrowed
> materially since June, and one of RAD's claimed leads (bash 3.2 portability) is
> currently broken ([#102](https://github.com/seanrreid/RAD_framework/issues/102)).
> CASE itself was not re-reviewed; claims about it reflect June 2026.

---

## What CASE Is

Its thesis: *"Case exists to make agent-authored PRs reliable, reviewable, and
self-improving."* A deterministic TypeScript/Bun executor drives a fixed phase
pipeline (`scout → implementer → verifier → reviewer → closer → retrospective`)
with context isolation per phase, file-based evidence gates, append-only event
logs, and a retrospective that writes learnings back. Put side by side, it would be
hard to tell whose design doc was whose.

---

## How much they've independently converged

Both arrived at the same primitives separately, which is strong evidence that RAD's
core bets are right:

- **Deterministic executor over phase transitions** (CASE's Bun executor ≈ RAD's
  `spine.js`).
- **Append-only event logs** (`.case/events/` ≈ `harness/events.js`). CASE's
  transition-validated `append()` was adopted directly into RAD's state store; see
  [`harness-state-store.md`](harness-state-store.md), Decision 4.
- **Context isolation per phase** (CASE's per-role contexts ≈ RAD's fresh
  sub-agent per wave).
- **Identical-failure-fingerprint early abort.** *Both* abort on a repeated
  failure fingerprint rather than burning the retry budget, with a two-cycle
  revision budget. The most striking convergence.
- **Provider-agnostic agent** (CASE's `--model` priority chain with per-role
  overrides ≈ RAD's `runWave` adapters + per-wave `Model:` tiering).
- **State files separating human intent from machine state** (CASE's `.task.json`
  ≈ RAD's plan doc + events).
- **Deliberately bounded to the PR loop.** Both explicitly name generic-platform
  features as non-goals.

---

## Where CASE is ahead of RAD

**1. The ratchet: CASE built the learning loop RAD was missing.** Its retrospective
is a *first-class phase*: it appends tactical learnings to `.case/learnings.md` and
proposes harness changes under `.case/amendments/`, with the explicit philosophy
*"when agents struggle, fix the harness,"* not the output repo. RAD's
`findings.jsonl` + `/rad-insights` *observed trends*; CASE *closes the loop* back
into its own guardrails.

*Update 2026-09-25:* the gap has narrowed to a difference in stance. `/rad-insights`
now proposes CLAUDE.md conventions and lint rules from findings recurrence
(`insights-feedback-loop`), and routes recurring wave-failure outcomes to the prompt
surface that likely caused them
(in review as [#123](https://github.com/seanrreid/RAD_framework/pull/123)). That is structurally
CASE's `amendments/`: proposals aimed at the harness, not the product. The
remaining difference is intentional. CASE's retrospective *writes* learnings
autonomously; RAD's proposals are suggestion-only and a human applies them.
[#64](https://github.com/seanrreid/RAD_framework/issues/64) would turn a proposal
into a Gate-1-blocked plan, closing the loop while keeping the gate.

**2. Evidence discipline as a machine gate.** CASE's gates require concrete
artifacts captured from *real run output*: `ca mark-tested` from actual test
output, plus a dedicated `verifier` role with intentionally "fresher" context that
tests user-facing scenarios before the closer opens a PR. RAD's test gate only
confirms named tests *exist on disk*. CASE proves they *ran and passed*; RAD proves
they're *present*.

*Update 2026-09-25:* largely closed at the wave level. A plan's `### Wave N` block
may now declare a `Verify:` command that the harness executes after the wave
(`scripts/check-verify.sh`, delivered in
[#105](https://github.com/seanrreid/RAD_framework/pull/105)). Its real exit code
demotes a failing wave to `fail-tests`, a timeout surfaces as `fail-timeout`, and a
bounded output excerpt feeds the retry prompt. The presence check
(`scripts/check-tests-present.sh`) remains as a separate gate. Still ahead in CASE:
the dedicated fresh-context *verifier role* exercising user-facing scenarios, which
RAD tracks as [#52](https://github.com/seanrreid/RAD_framework/issues/52)
(interactive evaluation in `/rad-review`). RAD's `Verify:` is also opt-in per wave,
where CASE's evidence gate is mandatory.

**3. Product completeness / DX.** One command (`ca 1234` for GitHub or
`ca DX-1234` for Linear) auto-detects the tracker, fetches the issue, runs baseline
verification, and dispatches the pipeline, all from a compiled single binary. RAD
needs more assembly: slash commands, shell scripts, and CLAUDE.md config.

*Update 2026-09-25:* still true. `/rad-adopt` covers issue intake, and the `rad` CLI
(`docs/rad-cli.md`) now fronts approve/gate/deliver, but there is no one-shot
issue-to-PR entry point. Packaging is tracked in
[#71](https://github.com/seanrreid/RAD_framework/issues/71).

---

## Where RAD is ahead of CASE

**1. Formal determinism rigor.** RAD's claims go further: gates are **pure folds**,
authority is **frozen into the event at write-time**, record-time validation makes
**invalid histories unrepresentable**, and the stop matrix has **no default
fallthrough**. CASE is deterministic and resumable, but doesn't claim the same
gate-algebra hardening.

**2. Human judgment gated up front.** The deepest divergence. CASE's pipeline is
**autonomous**: scout and implementer run before a human necessarily weighs in, and
the human mostly meets the work at the *PR boundary* (steering via `ca --agent` is
optional). RAD inserts **Gate 1 (plan approval) before any code is written**, so a
human architect signs off on *intent and approach* first. For high-risk or
regulated work, approving the *plan* beats reviewing the *diff*. CASE's reviewer is
an agent; RAD's approver is a person.

**3. Multi-role team model.** RAD has role gating (architect / developer /
designer), proxy approval with an honest `actor` vs `recordedBy` audit trail, and a
rule that developers can't approve their own plans. CASE reads as a *solo developer
driving an agent*. RAD's governance answers *"who approved this?"*; CASE's answers
*"what evidence exists?"*

**4. Zero-dependency portability.** RAD's guardrails are bash 3.2+ shell scripts
with no runtime install, plus a `manual` platform mode needing no `gh`/`glab`. CASE
requires **Bun ≥ 1.0** and is bound to **GitHub/Linear** (though its compiled
binary is a cleaner single-artifact distribution).

*Update 2026-09-25:* the bash 3.2 claim is **currently false**.
`scripts/lib/plan-paths.sh` stopped parsing under macOS's stock `/bin/bash` 3.2
when the freshness lint landed
([#102](https://github.com/seanrreid/RAD_framework/issues/102), `triage:now`).
The harness spine also requires Node. The claim should be restored, by fixing #102
and adding a 3.2 parse check to CI, rather than dropped.

---

## Synthesis

CASE and RAD are the same *kind* of thing: a deterministic, context-isolated,
evidence-gated, provider-neutral harness bounded to the PR loop, built from nearly
identical primitives. The split is about **who the harness serves**:

- **CASE** is an *autonomous pipeline with a built-in self-improvement loop*,
  optimized for a developer pointing an agent at an issue. It is ahead on the
  ratchet, evidence discipline, and DX.
- **RAD** is a *governance-and-roles harness with human judgment gated up front*,
  optimized for a team that must prove who approved what. It is ahead on formal gate
  determinism, up-front human oversight, and role/team modeling.

The original takeaway was that **CASE shipped the deterministic ratchet** the
harness-engineering review recommended RAD borrow. *As of 2026-09-25 RAD has
borrowed it in its own shape*: deterministic detection and targeted proposals, with
a human applying them. The two systems now differ less in *what* they learn from
failure than in *who is allowed to act on it*, which is the same split as
everywhere else in this comparison.
