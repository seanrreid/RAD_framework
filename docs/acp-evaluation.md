# ACP for the Provider Seam

An evaluation of the Agent Client Protocol (ACP) as RAD's provider seam, for
issue #86 ("give the provider seam a protocol, not two bespoke adapters"). It
records what ACP is, how it compares with the two adapters RAD already had,
what RAD gives up by speaking it, the verdict, how RAD handles spec risk, and a
non-normative sketch of a `_rad/` extension namespace. Part 1 (#184) shipped
the adapter (`RAD_AGENT=acp`); part 2 adds `rad acp-check` and this document.

Sources: the ACP site at [agentclientprotocol.com](https://agentclientprotocol.com/)
(the [protocol overview](https://agentclientprotocol.com/protocol/overview),
[transports](https://agentclientprotocol.com/protocol/transports),
[extensibility](https://agentclientprotocol.com/protocol/extensibility),
[governance](https://agentclientprotocol.com/community/governance),
[agents](https://agentclientprotocol.com/overview/agents) and the
[v2 draft announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)),
the spec repo [`agentclientprotocol/agent-client-protocol`](https://github.com/agentclientprotocol/agent-client-protocol)
(the v1 schema, `schema/v1/schema.json`), the Claude adapter
[`agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp),
the Codex adapter [`agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp),
and Kiro's [one agent, everywhere](https://kiro.dev/blog/one-agent/) post
(2026-08-03).
Captured: 2026-10-06

---

## What ACP Is

ACP standardises the conversation between a **client** (an editor, or here,
RAD) and a **coding agent** it launches. The client spawns the agent as a
subprocess and the two speak JSON-RPC 2.0 over the agent's stdio, one message
per line ([transports](https://agentclientprotocol.com/protocol/transports)).
An HTTP or WebSocket transport exists only as a draft RFD.

A session is four steps:

1. `initialize`: the client sends its `protocolVersion` (an integer; the wire
   version is **1**) and its client capabilities; the agent answers with its
   own version and capabilities.
2. `session/new`: the client names a `cwd` and any MCP servers; the agent
   returns a `sessionId`.
3. `session/prompt`: the client sends a prompt. While the turn runs the agent
   streams `session/update` notifications (message chunks, tool calls, plans,
   usage) and may call back into the client, most importantly
   `session/request_permission` before a tool runs. The turn ends with a
   `stopReason`.
4. `session/cancel`: a notification that asks the agent to stop the turn; the
   agent then ends it with `stopReason: cancelled`.

**Versions.** The schema is at v1.24.x and the Rust crate at v1.10.x (late
September 2026); both still put `protocolVersion: 1` on the wire. A v2 draft
was announced on 2026-07-20 ([announcement](https://agentclientprotocol.com/announcements/acp-v2-draft)).
It removes session modes and the v1 client `fs/*` and `terminal/*` methods,
requires an id on every message, and redesigns permissions. Implementations are
told to run v1 and v2 side by side. It is not stable and has no date.

**Governance.** Zed and JetBrains steward the protocol in an interim
arrangement while it works toward an independent foundation; it is not in one
yet. Ben Brandt (Zed) and Sergey Ignatov (JetBrains) are the lead maintainers,
changes go through an RFD process, and the spec is Apache-2.0
([governance](https://agentclientprotocol.com/community/governance)). The repo
moved from `zed-industries` to the `agentclientprotocol` organisation.

**Extensibility.** Custom methods start with `_`. Custom data goes in `_meta`,
which is allowed on requests, responses, notifications and nested types. An
implementation MUST NOT add custom fields at the root of a spec type. Extensions
are advertised in the capability `_meta` at `initialize`
([extensibility](https://agentclientprotocol.com/protocol/extensibility)).

**Adopters.** Agents that speak ACP natively include Gemini CLI, GitHub
Copilot, Cursor, Goose, Cline, OpenCode, OpenHands, Kiro CLI and Junie
([agents](https://agentclientprotocol.com/overview/agents)). Claude Code is
reached through `@agentclientprotocol/claude-agent-acp` (Apache-2.0, built on
the Claude Agent SDK) and Codex through `@agentclientprotocol/codex-acp`. The
main clients are Zed and the JetBrains IDEs.

**Kiro's extension.** Kiro extended ACP with a `_kiro/` namespace (more than 20
agent methods, 15 client methods and 20 notification types) and runs the agent
as a standalone server process, so a session can move between clients
([one agent, everywhere](https://kiro.dev/blog/one-agent/)). That is the
spec's extensibility model used at scale, and the precedent for the `_rad/`
sketch below.

**Name clash.** IBM and BeeAI's "Agent Communication Protocol" is a different
thing: a REST protocol for agent-to-agent messaging. It merged into Google's
A2A under the Linux Foundation (announced 2025-08-29). Nothing in this document
refers to it.

---

## The Comparison

What each adapter gives `runWave` today, need by need.

| Need | `command` | `sdk` | `acp` |
|------|-----------|-------|-------|
| Prompt | `buildWavePrompt` text on stdin, or argv via a `{prompt}` token | `query()` prompt | one `session/prompt` text block; `{prompt}` in the command is rejected |
| Result | `WAVE_RESULT` block in stdout, parsed by `contract.js` | `WAVE_RESULT` block in the result text, same parser | `WAVE_RESULT` block in the `agent_message_chunk` text, same parser; one reprompt in the same session if missing |
| Usage | only if the CLI prints a `RAD_USAGE` line | SDK token counts | none from a conformant v1 agent: stable `usage_update` carries only `used`, `size` and `cost`; draft `Usage` token fields are mapped if an agent sends them |
| Abort | wall-clock timeout kills the process | `AbortController` | `session/cancel`, then SIGTERM and SIGKILL; the attempt is `fail-timeout` |
| Capabilities | cannot narrow tools: a constrained wave is refused before launch | per-wave `allowedTools`; `mcp` refused | cannot narrow tools either: a constrained wave is refused before launch |
| Permission | none; the CLI's own settings decide | the SDK's allow-list | each `session/request_permission` answered from the wave's capability set (`allow_once` or `reject_once`, never `allow_always`); decisions recorded on the `wave-attempt` event |
| Streaming | process output | SDK message loop | `session/update` notifications; RAD keeps message chunks and usage, ignores the rest |
| Model selection | a `{model}` token in the command | `--model` / the wave's `Model:` line | none: ignored with one warning |
| Failure naming | exit code and timeout | classified errors with retry | protocol states named: `refusal` is `fail-scope`; crash, non-JSON, unknown id or unknown `stopReason` is `fail-protocol` |

### What `runWave` gives up on acp

Two things, both because stable ACP v1 has no field for them.

- **Model selection.** v1 has no stable model selector. A model requested with
  an explicit `--model` or a wave `Model:` line produces one warning per run
  and the agent uses its own configured model. Per-wave model tiering does not
  work on acp; set the model in the agent's config.
- **Token-count usage.** Stable `usage_update` reports context-window
  occupancy (`used` of `size`) and an optional `cost`, not tokens spent. RAD
  does not infer token counts from occupancy, so a conformant agent's waves
  carry no `usage`, and `RAD_TOKEN_BUDGET` sees them as zero. The draft `Usage`
  type's token fields are mapped when an agent sends them.

What it gains: a typed `stopReason` instead of an exit code, a cancel that the
agent can honour before it is killed, permission requests RAD can answer and
record, and one client for every agent on the list above.

### Permissions are defence in depth, not enforcement

An ACP agent asks permission when it chooses to. Nothing in the protocol stops
an agent from running a tool without asking, so RAD's answers cannot be the
enforcement point for a wave's capability classes. That is why `rad deliver`
refuses a constrained wave on acp before launch, exactly as it does on
`command`, and why the decisions are recorded rather than trusted.

### Transport and session mobility

RAD speaks stdio only. Kiro's standalone server process lets a session outlive
the client and move between them; RAD declines it. A wave is meant to be a
fresh context that ends with one `WAVE_RESULT`, the attempt is the unit of
retry, and the event log, not the agent's session, is RAD's durable record. A
session that outlives its attempt would carry context into the next attempt,
which is the thing waves exist to prevent, and it would add a long-running
process RAD would have to supervise. If HTTP or WebSocket transport becomes
stable, it is a transport change inside the adapter, not a change to the seam.

---

## Verdict: go, as a third adapter

**Go.** ACP is worth speaking: it is the only cross-vendor agent protocol with
broad native support, its turn model maps cleanly onto a wave, and the adapter
is a zero-dependency client in one file that reuses `contract.js`, so
the same turn text yields the same outcome on `command` and `acp`.

**As a third adapter, not a replacement.** `command` and `sdk` stay. `command`
still covers every CLI that prints text and supports per-wave models; `sdk`
still enforces capability classes, which ACP cannot. The issue's "adapters
become transports" stays a direction, with an explicit trigger: retire the
`command` recipe for a given agent only once that agent passes `rad acp-check`.
Until then both paths are supported.

**New providers should speak ACP.** For a provider RAD does not support yet,
the preferred route is an ACP v1 agent that passes `rad acp-check`, rather than
a new bespoke adapter. See "Writing a new adapter" in
[`rad-wave-contract.md`](rad-wave-contract.md#writing-a-new-adapter).

### Spec risk

- **Pin v1 with a hand-written client.** RAD does not depend on the official
  SDK packages, so a breaking release cannot reach the deliver path through a
  dependency update.
- **Fail closed on any other version.** An agent that answers `initialize`
  with a `protocolVersion` other than 1 fails the attempt with `fail-protocol`
  before any prompt is sent (the `acp-protocol-pinned` invariant). A v2-only
  agent is refused, not half-spoken.
- **Migration trigger.** Start a v2 client when v2 is marked stable upstream.
  The draft already says to run v1 and v2 side by side, so the v1 client stays
  until the agents RAD documents have moved.
- **The date.** This page was captured on 2026-10-06. Re-check the v2 status
  and the adopter list before relying on it.

---

## Sketch: a `_rad/` extension namespace

> **Draft. Non-normative.** Nothing below is implemented, and no RAD code sends
> or accepts a `_rad/` method or `_meta` key. It records where each candidate
> extension would sit under the spec's extensibility rules, so a future design
> starts from the rules rather than from a bespoke shape.

The rules it follows: custom methods are `_`-prefixed; custom data lives in
`_meta`; no custom field is ever added at the root of a spec type; support is
advertised in the capability `_meta` at `initialize`, so an agent that does not
know `_rad/` is unaffected.

| Candidate | Purpose | Where it would sit |
|-----------|---------|--------------------|
| Advertisement | Client and agent agree that `_rad/` is in use | `_meta: { "rad": { "version": 1 } }` on `clientCapabilities` and `agentCapabilities` in `initialize` |
| Wave boundaries | Tell the agent which wave and attempt a prompt belongs to | `_meta: { "rad": { "wave": 2, "attempt": 1, "feature": "..." } }` on the `session/prompt` request |
| Structured WAVE_RESULT | Return the result as data instead of a text block to regex-parse | a `_rad/wave_result` notification from the agent before the turn ends, or `_meta.rad.waveResult` on the `session/prompt` response; the text block stays the fallback |
| Capability declarations (#85) | Tell the agent the wave's effective classes so it can avoid asking for refused tools | `_meta: { "rad": { "capabilities": ["fs_read"] } }` on `session/new` or `session/prompt`; advisory only, since enforcement stays with RAD's refusal |
| Gate state | Let an editor client show where a feature is in RAD's gates | a `_rad/gate_state` notification (client to agent, or to a client UI) carrying the folded gate result; read-only |

A structured `WAVE_RESULT` would not change the outcome rules: it would go
through `parseWaveResult` and `resultToOutcome` like the text block, and an
unknown status would still fail closed.

---

## Filed

- **`rad acp-check`**: the conformance check a third-party agent can run.
  See [`rad-cli.md`](rad-cli.md#rad-acp-check).
- **Adapter docs**: "The `acp` adapter" in
  [`rad-wave-contract.md`](rad-wave-contract.md#the-acp-adapter), the adapter
  selection table and ACP recipes in
  [`rad-cli.md`](rad-cli.md#adapter-selection), and the `RAD_AGENT` row in
  [`configuration.md`](configuration.md#agent-adapter).
- **Event log**: `wave-attempt` events carry the acp permission decisions
  (`permissions`) when there were any.
- **Invariants**: `adapter-env-allow-listed` and
  `capabilities-enforced-or-refused` cover acp; `acp-protocol-pinned` is new
  (see [`invariants.yaml`](invariants.yaml)).
- No follow-up issues were filed during delivery.
