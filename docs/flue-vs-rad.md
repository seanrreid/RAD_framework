# Flue vs RAD

A point-by-point comparison of Flue — the Astro team's open agent framework —
against RAD: where the two converge, where they genuinely differ, and which
Flue ideas are worth adopting, deferring, or declining. Like the Cosmos and
CUGA reviews in [`references.md`](references.md), the headline is convergent
design validation. Unlike those reviews, this one also produced a **defect
finding** in RAD's own spine (issue #119).

Sources: [flueframework.com](https://flueframework.com/) (docs at 2.0.5),
[`withastro/flue`](https://github.com/withastro/flue) (Apache-2.0, 8.2k stars,
created 2026-02-07), the [Flue 2 announcement](https://flueframework.com/blog/flue-2/),
Firecrawl's [Flue vs Eve](https://www.firecrawl.dev/blog/flue-vs-eve-agent-frameworks),
and the Cloudflare [Astro issue-triage post](https://blog.cloudflare.com/astro-issue-triage/)
(already assessed 2026-08-05 — Flue is the engine that post says grew out of
that bot).
Captured: 2026-09-11

---

## What Flue Is

Flue is a TypeScript **agent runtime**, not a delivery process. An agent is a
plain exported function; hooks in its body attach capabilities and its return
value is the system prompt:

```ts
'use agent';
export function Assistant() {
  useModel('anthropic/claude-haiku-4-5');
  useSandbox(local());
  const [approved] = usePersistentState('approved', false);
  if (approved) useTool(publishRelease);
  return 'You are a helpful assistant.';
}
```

The function **re-renders before every model call**, so instructions and the
mounted tool set can depend on persistent state. Around that core:

- **Durability.** Every accepted input is recorded to an append-only canonical
  stream *before* model work starts, and "reaches exactly one durable terminal
  outcome — `completed`, `failed`, or `aborted` — no matter how many crashes
  happen in between." Recovery is two-phase: *converge* (close out the dead
  attempt's partial output "unconditionally and idempotently"), then *classify*.
- **Sandboxes.** Opt-in per agent: `local()` (host, no isolation, env
  allowlist), remote providers (E2B, Daytona, Modal, Cloudflare), or an
  in-process virtual shell. No sandbox means no filesystem and no shell.
- **Subagents.** Fresh context, inherit only the environment, return only their
  final message; depth capped at four.
- **Tools.** `defineTool` with a Valibot input schema; a throw becomes a tool
  error the model sees. `harness: true` tools get `harness.prompt()` with a
  structured-result schema enforced via a framework-injected finish tool.
- **Skills** in the open Agent Skills format (`SKILL.md`), progressively loaded.
- **Channels** (Slack, GitHub, Linear, …) as verified inbound-only ingress;
  outbound is the app's job via the provider's SDK. **No built-in approval
  primitive** — approval happens in the provider's own UI.
- **Observability.** Typed runtime events with correlation ids and per-turn
  usage (`input`, `output`, `cacheRead`, `cacheWrite`, `cost`); OpenTelemetry
  adapter.
- **`flue run`** executes one agent module transport-free and prints the reply
  to stdout, everything else to stderr. GitHub Actions and GitLab CI are
  first-class deploy targets.
- **Blueprints.** `flue add <integration>` returns a versioned Markdown guide
  that a *coding agent* follows to wire the integration into your project.

Its stated philosophy: "Flue deletes its own surface wherever the ecosystem
already has a better one — Vite owns the build, Hono owns routing, Pi owns
providers." Its own `AGENTS.md` says: "No tests exist in the repo."

---

## The Comparison

| Dimension | Flue | RAD |
|-----------|------|-----|
| What it is | Agent **runtime**: the thing that runs a model loop durably | Delivery **process**: gates, waves, and an event log around a BYO agent |
| Unit of durability | The conversation (append-only stream per instance) | The feature (append-only `events.jsonl` on the work-branch tip) |
| Recorded when | Input recorded *before* model work; terminal outcome guaranteed | `wave-attempt` appended *after* `runWave` returns — a crash mid-wave records nothing (**#119**) |
| Outcome vocabulary | 3 terminal states (`completed`/`failed`/`aborted`); hung work force-settles after 60 s | 7 matrix outcomes; `fail-timeout → surface` is neither terminal nor resumable (#95) |
| Capability model | Default-deny by construction: nothing until a hook mounts it; env allowlist `PATH HOME LANG …` | Path-denominated scope checked post-hoc (`check-scope.sh`); identical env allowlist in `command.js`; capability classes proposed (#85) |
| Human gate | None built in — approval lives in Slack/GitHub UI | Fail-closed Gate 1 (`approved` event + PreToolUse hook) and Gate 2 (PR) |
| Result contract | Schema-validated finish tool (`harness.prompt({ result })`) | Plain-text `WAVE_RESULT` block, regex-parsed, unknown status → `blocked_code` (fail-closed) |
| Structured retries | `idempotencyKey` converges redeliveries on the original submission; durable `step.do()` replays recorded values | Bounded attempts + doom-loop fingerprint; retry carries `priorFailure` (#90); no idempotency key (#112) |
| Learning / memory | `usePersistentState`, compaction with baseline snapshot | Findings → lints/conventions; fresh context per wave, no compaction |
| Reusable procedures | Blueprints: versioned Markdown guides with generated-file markers and an upgrade guide | Pinned playbooks proposed (#50), not built |
| Cost visibility | Per-turn `cacheRead`/`cacheWrite`/`cost` on every `turn` event | Per-wave `{ input, output, total }`, adapter-optional; most CLIs emit none |
| Tests | "No tests exist in the repo" (their words) | 21 harness test files + 15 script fixtures; adversarial composed-path evals still open (#109) |
| Provider seam | Pi's provider protocol, `useModel('vendor/model')` | `RAD_AGENT_CMD` string or the SDK adapter; protocol question open (#86) |

### These are different layers, and both know it

Flue's own terminology doc says: "There are no workflows or runs: conversations
are the only durable unit, and a bounded code job is a tool with `harness:
true`." Flue 2.0 **deleted its workflow system** with no compatibility layer.
RAD is a workflow with human gates; Flue deliberately is not one. A Flue agent is
a plausible thing to run *inside* a RAD wave (see the cookbook note below), and
RAD is a plausible process to wrap *around* a Flue agent, but neither replaces
the other. This is the same conclusion the Kiro and ByteByteGo reviews reached
about runtime-layer sources — with one difference: Flue's durability design
exposed a gap in RAD's own log, which none of the earlier runtime sources did.

### Durability: exactly-once recording vs record-after-the-fact

Flue's governing principle is "at-least-once execution over exactly-once
recording": the submission is durable before the model runs, so a crash can
never lose the fact that work was attempted. Recovery first *converges* — the
dead attempt is closed as `aborted`, unconditionally and idempotently — and only
then *classifies* what to do next.

RAD's spine does the opposite order. `runWave` is awaited at `spine.js:358`;
the `wave-attempt` event is appended at `spine.js:481`, after the result is in
hand. The resume comment at `spine.js:268` says a crashed wave is "attempt
logged, never advanced" — which holds only for a crash in the milliseconds
between the two appends, not for the ten-minute agent run. The consequences
compound:

- resume re-runs the wave with `priorFailure: null`, so #90's back-pressure
  never engages, while the branch may already carry the dead attempt's commits;
- `MAX_ATTEMPTS` and the doom-loop breaker count appended attempts, so a
  crash-looping deliver never consumes one;
- `RAD_TOKEN_BUDGET`'s "lifetime ceiling for the feature" (`spine.js:289`) is
  blind to any spend the dead attempt made;
- #95's stop taxonomy has no record of the stop.

This is the #97 defect class — an invariant asserted in a comment with no
enforcement site — and it is the reason this review produced an issue rather
than only corroboration. The fix is small and follows Flue's shape: append a
`wave-started` event *before* `runWave`, and on resume converge any orphan into
a synthetic attempt that counts toward the budgets, then classify it through
the existing matrix. Details and the two candidate outcome mappings are in
**#119**.

### Capability: withheld by the harness, not the prompt

Flue's tools guide makes the case RAD made for the deliver-gate hook (#35),
generalized: gating a tool on state means "unmounted tools cannot be invoked,"
which is "a stronger guarantee than an instruction not to use it." An agent with
no `useSandbox()` has no filesystem. Their dogfooded `.flue/agents/pr-redirect.ts`
shows the pattern at full strength — the LLM phase runs in a sandbox whose env
allowlist carries only a read-only token, and the write token is read only by a
deterministic phase from schema-validated inputs, so "even total prompt injection
of the LLM phase cannot make [the bot] write anything."

RAD's scope is path-denominated and checked after the fact. The Astro triage
review already noted that credentials *prevent* where `check-scope.sh` *catches*;
Flue is that observation as framework code. It strengthens #85's case for
per-wave capability declaration with absent-means-none semantics.

The env allowlist is the small pleasure of this review: Flue's `local()` sandbox
forwards `PATH`, `HOME`, and locale by default and nothing else. RAD's
`command.js` `ENV_ALLOW_LIST` is the same list plus `USER`. Two teams, same
answer.

### The result contract: schema vs grammar

Flue's `harness.prompt({ result: schema })` makes the model call a
framework-injected finish tool whose arguments must validate. RAD's
`WAVE_RESULT` is a plain-text grammar, which is a deliberate BYO decision —
any CLI that can print text can drive a wave. The two are not in tension: the
grammar is the transport, and what matters is that its parser is fail-closed.
It is — `contract.js:287` coerces an unknown task status to `blocked_code`,
and `agent-contract.test.js:208` asserts it. But `rad-wave-contract.md` said the
opposite ("coerced to `complete`") until this review; that line is corrected in
the same change. A doc that misstates a fail-closed rule as fail-open is its own
small #97 case.

### Blueprints are pinned playbooks, shipped

#50 proposed reusable, human-approved plan templates. Flue's `blueprints/`
directory is that idea with three mechanics RAD should copy: a monotonic
`version` in the frontmatter, a `// flue-blueprint: kind/slug@N` marker as the
first line of the *one* primary generated file, and a cumulative `## Upgrade
Guide` as the mandatory final section so applying and updating are the same
guide. The kinds are frozen (`sandbox | channel | database | tooling`) and new
kinds need a discussion first — the same frozen-vocabulary stance RAD takes on
outcomes. This also lands on #71 (packaging layers) and #69 (marker lint).

### Settlement and attendedness

Flue guarantees a terminal outcome for every accepted submission and, since
2.0.1, force-settles a hung one after a 60-second grace. RAD's `surface` action
is a dead end with no re-entry (#95). Flue's nightly `pr-redirect` sweep adds a
cheap attendedness affordance: a maintainer's 👀 reaction on a PR is a veto
that excludes it from the sweep. That is #108's "unattended runs must
terminate-and-report" with a human override that costs one click — worth
remembering when #108 is designed.

### Where Flue is weaker, and why it matters for RAD

- **No tests.** Their `AGENTS.md` states it plainly. A durability engine that
  makes exactly-once-recording claims with no test in the repo is the inverse of
  RAD's posture (21 harness test files, 15 script fixtures). This is also why
  RAD should not be *built on* Flue: 2.0 deleted workflows outright and rejects
  beta-era stores with no migration path. The churn is real.
- **No human gate.** Approval is "use the provider's UI," which is a
  labels-and-comments state machine — the thing the Astro triage review
  declined because it GitHub-locks the FSM and breaks portable sync.
- **Sequential subagent dispatch and no eval runner** (per the independent
  review at andrew.ooo). Not RAD's concern, but it confirms the runtime is
  young.

---

## Verdict: steal, defer, decline

**Steal**

1. **Record the attempt before running it; converge orphans on resume** →
   filed as #119. The one durable finding.
2. **Blueprint mechanics for pinned playbooks** (version, primary-file marker,
   cumulative upgrade guide) → comment on #50.
3. **Optional `cacheRead`/`cacheWrite`/`cost` fields in `normalizeUsage`** so
   `/rad-insights` can see whether the retry prefix held → comment on #112.
4. **Flue as a `RAD_AGENT_CMD` cookbook entry** — `npx flue run agent.ts -m
   {prompt}` needs no wrapper because Flue's stdout/stderr contract is exactly
   the one #114 wished other CLIs had → comment on #110.

**Corroborates (no new work)**

- #85 capability classes: default-deny-by-hook and the two-token split.
- #87 config split: their approver allowlist changes only through a PR.
- #95 / #108: terminal settlement, force-settle grace, 👀-reaction veto.
- #112: their docs state the same prompt-cache constraint.
- The settled BYO-agent principle: "delete your own surface wherever the
  ecosystem already has a better one" is RAD's stance with Vite/Hono/Pi
  substituted for git/gh/the operator's CLI.

**Decline**

- **Building RAD on Flue** (or any runtime): the seam is `RAD_AGENT_CMD`, and
  Flue's 2.0 churn is the argument for keeping it there.
- **Compaction.** Flue compacts within a conversation; RAD holds the
  chunking-is-durable position (#46/#47) and gets fresh context per wave.
- **Provider-UI approval.** Labels and comments as the gate — declined before,
  declined again.
- **The SDK-style `dispatch`/`wait` client and channels.** Below the seam.

---

## Filed

- **#119** — Record the wave attempt before running it: a crash mid-wave
  leaves no event, so resume re-runs blind and the dead attempt escapes the
  attempt and token budgets.
- Comments on #50, #85, #87, #95, #110, #112.
- `docs/rad-wave-contract.md`: corrected the task-status coercion line.
