# Plan: Capability Classes, Enforced per Wave (#85 part 1)
Created: 2026-10-05
Author: architect
Status: approved
Approved-By: sean@torchcodelab.com
Approved-At: 2026-10-05T15:56:45.241Z
Recorded-By: sean@torchcodelab.com
Branch: rad/capability-classes
Adopted-From: https://github.com/seanrreid/RAD_framework/issues/85
Issue-Title: Capability classes alongside path scope: declare fs/shell/net/mcp per wave, deny-wins across config layers

## Context

RAD's authorization model only knows about **paths**:
- `check-scope.sh` checks which files a delivery touched, after the fact.
- Nothing checks which **capabilities** a wave had.

The SDK adapter gives every wave of every plan the same tool list, hardcoded at `harness/adapters/agent/sdk.js:116`: `Read, Write, Edit, Bash, Glob, Grep`. The command adapter (the default) has nothing comparable. So a docs-only plan runs with unrestricted shell, and nothing a plan declares changes what the agent can do.

This plan adds capability classes as a second check next to path scope. Plans declare them per wave; deliver resolves and enforces them, failing closed where it can't. Part 2 (`capability-surface`) shows them to the approver and documents them.

`classify-low-risk.sh` and the auto-approval framing in #85's body are gone (#137). Per the 2026-09-28 comment on #85, step 4 is dropped.

**Decisions (architect, 2026-10-05):**
- **Default:** a wave with no declaration gets today's set: `fs_read`, `fs_write`, `shell`. A plan that declares nothing produces a byte-for-byte identical event sequence. Declaring is how you narrow.
- **Command path:** the command adapter refuses to launch when a wave's set is narrower than it can enforce. Fail closed: narrowed plans need `RAD_AGENT=sdk` in v1.
- **Layers:**
  - the project deny list in `.rad/config.yml` (`capabilities.deny`);
  - a plan-level `Capabilities:` line, the default for the plan's waves;
  - a wave-level `Capabilities:` line, which overrides the plan line.
  - Deny wins at every layer.
- **Approval surface:** advisory, in part 2.

## Scope

| In scope | Out of scope |
|---|---|
| Vocabulary, parsing, per-wave resolution with deny-wins (`harness/capabilities.js`) | The `lint-plan.sh` advisory, the `/rad-approve` display, docs (`capability-surface`) |
| `.rad/config.yml` `capabilities.deny` schema | A global or env deny layer |
| SDK enforcement through `allowedTools`; command-adapter refusal | Command-adapter flag mapping |
| `wave-started` records the effective set only when the wave is constrained | The `/rad-deliver` skill path (recorded as an unguarded bypass) |
| Invariant entry + adversarial eval | A sandbox: classes are tool-level, not OS-level |

## Acceptance Criteria

1. **Vocabulary:** `harness/capabilities.js` exports the following, and is pure (no I/O):
   - `CAPABILITY_CLASSES = ['fs_read', 'fs_write', 'shell', 'net', 'mcp']`;
   - `DEFAULT_CAPABILITIES = ['fs_read', 'fs_write', 'shell']`;
   - `parseCapabilityLine(value)`. It accepts a list separated by commas or whitespace, lowercased, with duplicates removed and in vocabulary order. It returns `{ ok: true, classes }` or `{ ok: false, error }`. An unknown class, an empty value, or a list with no classes left after parsing is an error that names the bad token.
2. **Plan syntax:**
   - A `Capabilities:` line in the plan header (before the first `## ` heading) is the plan default.
   - A `Capabilities:` line inside a `### Wave N` block is that wave's request. It **replaces** the plan default; it doesn't merge with it.
   - `parsePlanCtx` exposes them as `planCapabilities` (classes or `undefined`) and `waveCapabilities` (`{ n: classes }`), following the parsing rules `Model:` and `Verify:` use.
   - A malformed line makes `rad deliver` exit **2**, naming the line (plan header or wave N) and the error, before any event is appended.
3. **Project deny:** `.rad/config.yml` accepts an optional `capabilities: { deny: [<class>...] }`.
   - `validateConfig` rejects an unknown class, a non-list `deny`, and any unknown key under `capabilities`.
   - `serializeConfig` writes `capabilities` back out when it's present, so `loadConfig` round-trips it.
   - An absent key means no deny.
4. **Resolution:** `resolveWaveCapabilities({ waves, planCapabilities, waveCapabilities, deny })` returns, for each wave:
   - `requested` = the wave line, otherwise the plan line, otherwise `DEFAULT_CAPABILITIES` (marked implicit);
   - `effective` = `requested` minus `deny`;
   - `constrained` = true when there was an explicit request or when any class was denied.

   It also returns a refusal when an **explicitly** requested class is denied: explicit requests are never silently dropped. The refusal names the wave, the class and `.rad/config.yml`. An implicit default that loses a class to `deny` is narrowed without a refusal; the narrowing is recorded on `wave-started` (AC#7).
5. **SDK enforcement:**
   - **Unconstrained waves:** `allowedTools` is exactly today's list.
   - **Constrained waves:** `allowedTools` is built from `effective`:
     - `fs_read` → `Read`, `Glob`, `Grep`
     - `fs_write` → `Write`, `Edit`
     - `shell` → `Bash`
     - `net` → `WebFetch`, `WebSearch`
   - **`mcp`:** the SDK adapter configures no MCP servers, so a wave whose effective set contains `mcp` makes deliver refuse (exit 2, named reason). It is never silently granted nothing.
6. **Command refusal:**
   - With `RAD_AGENT=command`, if any constrained wave's effective set lacks any class in `CAPABILITY_CLASSES`, deliver exits **2** before any event. The message names the wave and its effective set and says to use `RAD_AGENT=sdk` or remove the declaration.
   - A plan with no constrained waves runs exactly as today.
   - An injected `ctx.runWave` (tests) skips this adapter check.
   - In worktree mode, a refusal preserves the tree, as a preflight failure does.
7. **Event record:**
   - The spine takes `waveCapabilities` (wave number → effective classes, **constrained waves only**).
   - `wave-started` spreads `capabilities: [...]` only for those waves.
   - A plan with no declarations and no deny list produces a byte-for-byte identical event sequence (fixture-tested).
8. **Invariant + eval:**
   - `docs/invariants.yaml` gains `capabilities-enforced-or-refused`, with anchors on `resolveWaveCapabilities`, the SDK `allowedTools` builder and the command-refusal check.
   - It has an eval in `harness/evals/delivery.eval.js`, `command-refuses-narrowed-capabilities`: a wave declaring `Capabilities: fs_read, fs_write` under the command adapter exits 2, no `wave-started` is appended, and the adversary never runs.
   - Its `[mutated]` twin removes the refusal check and lets the adversary run.
   - Two unguarded bypasses are recorded: the `/rad-deliver` skill path, and "`shell` subsumes `net` and `fs_write`" (the classes are tool-level, not a sandbox).
   - `scripts/lint-invariants.sh` passes.
9. **Tests:**
   - `harness/test/capabilities.test.js` covers parsing (unknown, empty, duplicates, whitespace, mixed case) and resolution (implicit, plan-level, a wave overriding the plan, an implicit default narrowed by deny, an explicit request denied, everything denied).
   - `config.test.js` covers the deny schema and round-tripping.
   - `agent-adapters.test.js` covers `allowedTools` for unconstrained, fs-only and net waves, and the `mcp` refusal.
   - `cli.test.js` covers a malformed line (exit 2), the command refusal (exit 2, no events), and the denied-explicit refusal.
   - `spine.test.js` covers `wave-started` with and without `capabilities`, and the byte-identical sequence.
   - Every suite stays green: harness tests, evals, every `scripts/test-*.sh` under both shells, `lint-shell-safety`, `lint-invariants`, `rad config validate`.

## Agent Scope

No mapper agents were used. The surface was read directly:
- `parseWaveModels` / `parseWaveVerify` / `parsePlanCtx` (`cli.js` 395-530);
- `loadPlanCtx` (`cli.js` 618-635) and the deliver wiring (`cli.js` 1205-1310);
- the SDK `query` options (`sdk.js` 95-125) and the per-wave model read (`sdk.js` 215-230);
- `appendWaveStarted` (`spine.js` 410-430) and the spine arguments (`spine.js` 505-565);
- `TOP_LEVEL_KEYS` / `validateConfig` (`config.js` 20-130);
- the delivery eval fixture, which uses the command adapter.

## Program Design

**New module: `harness/capabilities.js`** (pure, no I/O)
```js
export const CAPABILITY_CLASSES   // ['fs_read','fs_write','shell','net','mcp']
export const DEFAULT_CAPABILITIES // ['fs_read','fs_write','shell']
export function parseCapabilityLine(value)            // -> { ok, classes } | { ok:false, error }
export function resolveWaveCapabilities({ waves, planCapabilities, waveCapabilities, deny })
  // -> { ok:true, byWave: { [n]: { requested, effective, implicit, constrained } } }
  //  | { ok:false, error }               (explicit request denied)
export function sdkAllowedTools(effective)            // -> { ok, tools } | { ok:false, error } (mcp)
export function commandRefusal(byWave)                // -> null | string
```

**Call stack (`rad deliver`):**
```
deliverCommand
  loadPlanCtx(root)  -> parsePlanCtx: planCapabilities, waveCapabilities (+ parse errors)
  loadConfig(root)   -> capabilities.deny ?? []
  resolveWaveCapabilities(...)      refuse exit 2 on error
  if agent=command: commandRefusal  refuse exit 2
  if agent=sdk: sdkAllowedTools per constrained wave  refuse exit 2 on mcp
  planCtx.waveEffective = { n: effective }   constrained waves only
  runSpine({ ..., waveCapabilities: planCtx.waveEffective })
    appendWaveStarted -> data.capabilities only when present
  sdk runWave -> allowedTools = sdkAllowedTools(planCtx.waveEffective[n]) ?? DEFAULT_TOOLS
```

**File tree diff:**
```
harness/
  capabilities.js                 (new)
  test/capabilities.test.js       (new)
  cli.js, spine.js, config.js     (edited)
  adapters/agent/sdk.js           (edited)
  evals/delivery.eval.js          (case appended)
docs/invariants.yaml              (entry added)
```

## Files in Scope

| File | Lines | Change |
|------|-------|--------|
| harness/capabilities.js | 1-130 | New: vocabulary, `parseCapabilityLine`, `resolveWaveCapabilities`, `sdkAllowedTools`, `commandRefusal` |
| harness/test/capabilities.test.js | 1-170 | New: parse + resolve + tool mapping |
| harness/cli.js | 395-530 | Parse plan and wave `Capabilities:` into planCtx |
| harness/cli.js | 618-640 | `loadPlanCtx` surfaces parse errors |
| harness/cli.js | 1205-1310 | Load deny, resolve, refuse (exit 2), pass `waveCapabilities` to the adapter and the spine |
| harness/adapters/agent/sdk.js | 95-125 | `allowedTools` from the effective set |
| harness/adapters/agent/sdk.js | 210-235 | Read the wave's effective set from planCtx |
| harness/test/agent-adapters.test.js | 1100-1180 | SDK `allowedTools` cases (append) |
| harness/spine.js | 410-430 | `wave-started` spreads `capabilities` |
| harness/spine.js | 505-565 | Accept `waveCapabilities` |
| harness/spine.js | 725-730 | Pass it to `appendWaveStarted` |
| harness/test/spine.test.js | 2300-2380 | Event cases + byte-identical sequence (append) |
| harness/test/cli.test.js | 1760-1840 | Deliver refusal cases (append) |
| harness/config.js | 20-130 | `capabilities.deny` schema |
| harness/config.js | 260-310 | `serializeConfig` writes `capabilities` |
| harness/test/config.test.js | 360-420 | Deny schema + round-trip (append) |
| harness/evals/delivery.eval.js | 150-230 | `command-refuses-narrowed-capabilities` case (append) |
| docs/invariants.yaml | 180-240 | `capabilities-enforced-or-refused` entry |

## Execution Notes

### Do Not Touch
- harness/gates.js, harness/matrix.js, the gate fold
- harness/adapters/agent/command.js (the refusal happens in cli.js before the adapter runs)
- scripts/ (the lint advisory is part 2)
- .claude/, CLAUDE.md, docs other than `invariants.yaml`

### Key Files
- `harness/cli.js`: `parseWaveModels` (pattern to mirror), `parsePlanCtx`, `loadPlanCtx`, the deliver setup around `resolveAgent` and the `runSpine` arguments
- `harness/spine.js`: `appendWaveStarted`, the spine argument list (`waveModels`)
- `harness/adapters/agent/sdk.js`: `runQueryOnce` options, `runWave` per-wave model read
- `harness/config.js`: `TOP_LEVEL_KEYS`, `validateConfig`, `serializeConfig`
- `harness/evals/delivery.eval.js`: `patchFile`, `defaultPlan`, existing case shape

### Reminders
- **The absent-declaration guarantee is the backward-compatibility contract.** No `Capabilities:` line and no deny list means the same `allowedTools`, no new event key and the same exit codes.
- **Every refusal happens before any event is appended** and exits 2, with a reason naming the wave and class.
- **Fail closed:** never silently grant more than the effective set, and never silently drop an explicit request.
- **Code shape:** named constants, functions under about 40 lines, comments that state constraints.
- **No en dashes in plan, shell or JS files.**

## Wave Plan

### Wave 1 — parallel
Pure module + config schema (disjoint files).

#### Task 1.1: Capability vocabulary and resolution
File: harness/capabilities.js:1-130, harness/test/capabilities.test.js:1-170
What: Implement AC#1 and AC#4, plus the pure helpers used later:
- `sdkAllowedTools(effective)`: the mapping in AC#5, returning `{ ok, tools }`, or a refusal for `mcp`;
- `commandRefusal(resolved)`: the rule in AC#6, returning `null` or a message.

Covers the `capabilities.test.js` part of AC#9.
Validate: AC#1, AC#4, AC#9 with `npm test --prefix harness`. Edge cases:
- an empty `Capabilities:` value;
- an unknown class;
- duplicates and mixed case;
- a plan line plus a wave override;
- deny removing every class (`effective` empty, constrained);
- an explicit request denied (refusal);
- an implicit default narrowed (no refusal).

#### Task 1.2: Project deny list in .rad/config.yml
File: harness/config.js:20-130, harness/config.js:260-310, harness/test/config.test.js:360-420
What: Implement AC#3 and the `config.test.js` part of AC#9. Use `CAPABILITY_CLASSES` from `harness/capabilities.js`. If Task 1.1 hasn't landed when this task runs, define the same literal locally and note it in the WAVE_RESULT concern.
Validate: AC#3, AC#9 with `npm test --prefix harness` and `node harness/cli.js config validate`. Edge cases:
- `deny: []`;
- an unknown class;
- `deny` given as a string;
- an unknown key under `capabilities`;
- a round trip through `serializeConfig` and `loadConfig`.

### Wave 2 — sequential
Wiring: parse, resolve, enforce, record. One task, because cli.js, sdk.js and spine.js move together.

#### Task 2.1: Wire capabilities through deliver, the SDK adapter and the spine
File: harness/cli.js:395-530, harness/cli.js:618-640, harness/cli.js:1205-1310, harness/adapters/agent/sdk.js:95-125, harness/adapters/agent/sdk.js:210-235, harness/test/agent-adapters.test.js:1100-1180, harness/spine.js:410-430, harness/spine.js:505-565, harness/spine.js:725-730, harness/test/spine.test.js:2300-2380, harness/test/cli.test.js:1760-1840
What: Implement AC#2, AC#5, AC#6 and AC#7, and the matching parts of AC#9.
Validate: AC#2, AC#5, AC#6, AC#7, AC#9 with `npm test --prefix harness` and `node --test harness/evals/*.eval.js`. Edge cases:
- a malformed wave line;
- a malformed plan line;
- the command adapter with an all-default explicit declaration (refused, because it lacks `net` and `mcp`);
- the command adapter with no declarations (runs as today);
- SDK with `mcp` (refused);
- an injected `runWave` (no adapter check);
- a byte-identical event sequence for an undeclared plan.

### Wave 3 — sequential
Prove it adversarially and register it.

#### Task 3.1: Invariant entry and adversarial eval
File: harness/evals/delivery.eval.js:150-230, docs/invariants.yaml:180-240
What: Implement AC#8.
Validate: AC#8 and AC#9:
- `node --test harness/evals/delivery.eval.js`, including `[mutated]`;
- `scripts/lint-invariants.sh` exits 0;
- the full suite is green (harness tests, evals, every `scripts/test-*.sh` under both shells, `lint-shell-safety`, `rad config validate`).

## Tests to Write
- [ ] Parse and resolve cases — harness/test/capabilities.test.js
- [ ] Deny schema and round-trip — harness/test/config.test.js
- [ ] SDK allowedTools cases — harness/test/agent-adapters.test.js
- [ ] wave-started capabilities + byte-identical sequence — harness/test/spine.test.js
- [ ] Deliver refusal cases — harness/test/cli.test.js
- [ ] command-refuses-narrowed-capabilities eval — harness/evals/delivery.eval.js

## Non-Goals
- An OS-level sandbox. `shell` still lets an agent reach the network and write files; the docs and the invariant entry say so.
- Restricting the `/rad-deliver` skill path's sub-agents.
- Command-adapter flag mapping (`RAD_AGENT_CAPABILITY_FLAGS`). It is a possible follow-up if command-path enforcement is wanted.
- A global, user-level or env deny layer.

## Out-of-Scope Dependencies
None.

## Risks
- **Narrowed plans are SDK-only in v1.** Requiring `RAD_AGENT=sdk` limits who can use declarations. This is intended: failing closed beats an unenforced declaration that looks enforced.
- **`mcp` is refused on both adapters in v1.** No adapter configures MCP servers today, so the class is reserved and refused. Part 2 documents this.
- **Self-protected paths:** `harness/` triggers advisory lint warnings by design.

## Issue Gaps
- **ASSUMPTION — explicit requests are never silently dropped.** A denied explicit request refuses the run, while an implicit default is narrowed and recorded. A plan author who asked for `shell` learns it's denied before the wave runs, not from a confusing failure.
- **ASSUMPTION — a wave line replaces the plan line.** The two are not merged, which makes a wave's set readable on one line.
- **ASSUMPTION — refusal exit code 2.** This follows the existing usage/config contract in `docs/rad-wave-contract.md`.
