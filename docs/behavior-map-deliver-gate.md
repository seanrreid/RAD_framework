# Behavior Map: the deliver path and its approval gate

> A behavior-level map of `/rad-deliver` — what the system *does*, traced to the
> code that does it. Written in the three-level form from the
> [Harness Handbook](https://ruhan-wang.github.io/Harness-Handbook/): L1 traces
> one invocation end to end, L2 decomposes it into behavior units, L3 zooms into
> a single rule. Every claim carries a `file:line` anchor — **prose explains,
> anchors are the evidence**.
>
> Scope: the deliver path only. Research, design, plan, and review are out of
> scope here.
>
> Maintenance: line anchors drift. When a cited range moves, fix the anchor in
> the same commit — an anchor that no longer lands is worse than no anchor.
> Anything stated without an anchor is a design intent, not a verified fact.

---

## Why this document exists

`docs/harness-audit.md` parked an open question (#2): prose commands were
auditable by a non-engineer architect, and a JS harness is less so. This map is
the answer to that. It does not replace `docs/harness-state-store.md` (design
rationale) or `docs/rad-cli.md` (interface reference); it sits between them and
answers a third kind of question — *"where does this behavior actually live?"*

The motivating case: **"never deliver without an approved event"** is one
sentence in `CLAUDE.md`, and **six** enforcement sites in the tree. No single
function owns it. That is the condition this format exists to fix.

---

## L1 — System overview

> *How does one `/rad-deliver` invocation run, end to end?*

```
 user: /rad-deliver <slug>
   │
   ├─(1) PreToolUse hook ──────── scripts/deliver-gate-hook.mjs
   │      matcher "Skill"          .claude/settings.json:8-19
   │      BLOCK = exit 2           deny-by-default on any error path
   │
   ├─(2) prose Step 2 ─────────── .claude/commands/team/rad-deliver.md:53-62
   │      (same script, again)
   │
   │        both call ↓
   │      scripts/check-plan-approved.sh
   │        ├─ optional RAD_SYNC fetch of the branch tip     :78-80
   │        ├─ resolve events.jsonl: origin/rad/<f> →
   │        │  origin/<base> → local worktree; else FAIL     :47-69, :82-85
   │        ├─ fingerprint tripwire (plan edited post-approval) :101-130
   │        └─ pipe JSONL → `rad gate <f> approved --stdin`  :135
   │                                   │
   │                                   └─ harness/gates.js evaluateGate :77-122
   │                                      rule from harness/gates.yaml  :19-23
   │
   ├─(3) deliver verb ─────────── harness/cli.js:401-608
   │      builds the ports: runWave (RAD_AGENT adapter), sh, now,
   │      state store, matrix, waveVerify, tokenBudget, worktree
   │      then calls deliverSpine                            cli.js:544
   │
   └─(4) deliverSpine ─────────── harness/spine.js:231-661
          ├─ gate re-check, in-process                       :249-252
          │    blocked → { stopped:'gate' } — runWave never called
          ├─ append `deliver-started`                        :254
          ├─ hook pre-flight (validate hooks dir once)       :261
          ├─ read plan + waves, resume from `wave-complete`  :263-271
          ├─ seed token spend from prior runs                :293
          │
          ├─ FOR EACH WAVE                                   :296-647
          │    ├─ token-budget breaker                       :301-310
          │    ├─ resume-verify (once, if waves were skipped):312-318
          │    └─ FOR EACH ATTEMPT (≤ 3)                     :328
          │         ├─ hook pre-wave (veto-capable)          :335-354
          │         ├─ runWave  ← THE MODEL BOUNDARY         :358
          │         ├─ hook post-wave (veto replaces outcome):366-371, :398-418
          │         ├─ gate: check-tests-present.sh          :420-433
          │         │    fail → demote to `fail-tests`
          │         ├─ gate: check-verify.sh (if `Verify:`)  :446-469
          │         │    exit 124 → `fail-timeout`, else `fail-tests`
          │         ├─ append `wave-attempt` (+ usage, tasks, verify) :481-505
          │         ├─ matrix: resolveOutcome('implement', …):513
          │         └─ advance → `wave-complete`             :524-542
          │            retry/revision → doom-loop fingerprint:544-598
          │            abort/surface → `wave-failed`, return :601-625
          │
          ├─ post-checks: check-scope.sh, open-pr.sh         :67, :651-656
          ├─ append `pr-opened`                              :658
          └─ return { ok: true }                             :660
   │
   └─(5) at the PR ───────────── .github/workflows/ci.yml
          all PRs:      check-events-append-only.sh          :64
          rad/ PRs:     check-approval-integrity.sh          :88-121
                        check-scope.sh                       :122-128
```

**Where state lives.** One append-only log per feature at
`.agents/state/<feature>/events.jsonl` (`harness/adapters/git-state-store.js:104-106`),
written with `appendFileSync` (`:266`) only after `validateTransition` accepts the
move (`:259`). It is a git-tracked file, so the branch tip is the transport and
the merge is the publication. Every phase, gate, and metric in RAD is a **fold
over that log** — nothing is stored as derived state.

**Where output is executed.** The spine never runs shell itself. Guardrails go
through the injected `sh` port; the model goes through the injected `runWave`
port; time goes through the injected `now`. That is what makes the whole control
flow unit-testable with no real git, model, or clock (`spine.js:9-22`).

---

## L2 — Behavior units

| # | Unit | Responsibility | Key state read/written | Anchor |
|---|------|---------------|------------------------|--------|
| U1 | **Pre-tool deny** | Block an unapproved `/rad-deliver` before the skill runs | reads events log (via U2) | `scripts/deliver-gate-hook.mjs:1-125` |
| U2 | **Approval resolution** | Find the authoritative event log across refs; tripwire on a post-approval plan edit | reads `events.jsonl`, plan doc | `scripts/check-plan-approved.sh:47-135` |
| U3 | **Gate fold** | Decide whether the log satisfies a named gate — *pure*, no I/O | reads history in memory | `harness/gates.js:77-122`, `harness/gates.yaml:19-23` |
| U4 | **Approval write** | Verify role at write time and freeze it into the event | appends `approved` | `git-state-store.js:375-408` |
| U5 | **Transition validation** | Reject illegal moves before anything is persisted | reads history, gates `append` | `harness/transitions.js:63-132` |
| U6 | **Spine control flow** | The deterministic wave loop: gate → waves → post-checks → PR | appends `deliver-started`, `wave-*`, `pr-opened` | `harness/spine.js:231-661` |
| U7 | **Outcome resolution** | Map `(phase, outcome)` → action. No default fallthrough — unknown pairs throw | none (pure table lookup) | `harness/matrix.js:89-104`, `harness/matrix.yaml:28-35` |
| U8 | **Wave gates** | Test *presence* (always) and declared *execution* (opt-in) | none; supplies an input token to U7 | `spine.js:420-433`, `:446-469` |
| U9 | **Hook lifecycle** | Six operator extension points; two veto-capable, four observe-only | appends `hook-observed`/`hook-failed`/`hook-veto` | `spine.js:94-115`, `harness/hook-runner.js` |
| U10 | **CI re-verification** | Re-prove approval at the PR head; enforce append-only logs | reads git history + log | `scripts/check-approval-integrity.sh`, `check-events-append-only.sh` |

### Unit dependency shape

```
U1 ──uses──► U2 ──uses──► U3 ◄──uses── U6
                              ▲
U4 ──writes the event U3 reads┘
U5 guards every write into the log (U4 and U6 both go through it)
U6 ──drives──► U7, U8, U9      U10 re-runs U2/U3's logic at the PR head
```

Two invariants hold this shape together, and both are load-bearing:

1. **U3 is pure.** `gate()` shells out to nothing; all authority is established
   at write time by U4 and merely *read* at gate time
   (`git-state-store.js:282-304`). The transitional note at `:290-296` explicitly
   forbids re-introducing the branch-tip/doc check into the fold.
2. **U7 is the only place a "what happens next" decision lives.** The spine never
   does inline retry arithmetic; a failing gate in U8 supplies a different *input
   token* to U7 rather than adding a branch (`spine.js:442-445`).

---

## L3 — "Never deliver without an approved event"

> The rule stated in `CLAUDE.md` → *"Never execute /rad-deliver without an
> `approved` event in `.agents/state/<feature>/events.jsonl`."*

### Trigger

Any `Skill` tool call whose skill name's trailing `:`-segment is `rad-deliver`
(`deliver-gate-hook.mjs:70-77` — so both `team:rad-deliver` and a bare
`rad-deliver` match), plus the spine's own entry point for any caller that
reaches it directly (`spine.js:249`).

### Permission rule

```yaml
approved:
  eventType: approved
  requiredRole: architect
  condition: role-equals
```
`harness/gates.yaml:19-23`

The predicate: *does any event of type `approved` carry a frozen `role` field
equal to `architect`?* (`gates.js:94-99`).

Three consequences worth stating plainly:

- **Authority rides on `role`, not `actor`.** The role is verified once at write
  time by `check-role.sh` and frozen into the event
  (`git-state-store.js:379-389`, `:396`). Gate evaluation never re-derives it
  (`gates.js:52-66`).
- **Proxy approval passes by construction.** An event with `actor: architect` and
  `recordedBy: someone-else` satisfies the gate; both fields are preserved and
  surfaced through `satisfiedBy` (`gates.js:101-113`).
- **Policy auto-clear is shape-identical.** `recordPolicyApproval` writes
  `actor: 'severity-gate'`, `role: 'architect'`, `recordedBy: 'policy'`, and the
  fold accepts it exactly like a human approval
  (`git-state-store.js:432-445`). It deliberately branches *around*
  `check-role.sh` — a runtime role check on a machine identity is meaningless
  (`:410-427`). **The trust boundary moves to config time:**
  `RAD_LOW_RISK_PATTERNS` plus the non-configurable self-protected path set in
  `scripts/lib/plan-paths.sh`. This is the one path where no human sees the
  change.

### State change

An `approved` event is appended to the feature's log. Two transition rules guard
it:

- **duplicate-approved** (`transitions.js:94-116`) — a second `approved` is
  blocked *unless* its plan fingerprint differs from the most recent one (a
  legitimate re-attestation of an edited plan). If **either** fingerprint is
  absent, it blocks — fail-closed, because absence cannot prove the bodies
  differ.
- **approved-missing-role** (`transitions.js:118-131`) — an `approved` event with
  no frozen `role` means write-time authority was bypassed (a raw `append()`),
  and is rejected as an illegal transition.

### Execution paths — the six sites

| # | Site | When | On failure |
|---|------|------|-----------|
| 1 | `deliver-gate-hook.mjs` | PreToolUse, before the skill body runs | `exit 2` — tool call denied |
| 2 | `rad-deliver.md:53-62` | Prose Step 2, inside the skill | Print and stop |
| 3 | `check-plan-approved.sh:101-130` | Fingerprint tripwire, before the role gate | `exit 1` — "plan modified after approval" |
| 4 | `gates.js:77-122` | The fold itself, via `rad gate --stdin` | Non-zero exit → sites 1–3 fail |
| 5 | `spine.js:249-252` | In-process, first statement of the spine | `{ stopped:'gate' }` — structured, no events, `runWave` never called |
| 6 | `check-approval-integrity.sh` | CI, at the deliver PR head | Job fails, merge blocked |

Sites 1–3 are defense in depth over the same predicate; site 5 is the one that
holds if the spine is driven programmatically; site 6 is the one that holds if
the log was tampered with after the fact. Site 6 checks three things sites 1–5
cannot: **ancestry** (the approving commit is an ancestor of HEAD),
**authenticity** (its git author matches the configured architect), and the gate
again at the merge point (`check-approval-integrity.sh:1-36`).

### Edge cases

| Case | Behavior | Anchor |
|------|----------|--------|
| Plan doc says `Status: approved`, no event | **Denied.** The header is a display-only mirror | `check-plan-approved.sh:5-11` |
| Plan body edited after approval | **Denied** — fingerprint mismatch, before the role check | `:101-130` |
| Approval carries no fingerprint (legacy) | **Passes.** A deliberate, narrow fail-open — an edit cannot be proven | `:97-100` |
| Approval recorded on another machine | Best-effort `git fetch` of the tip; a failed fetch never blocks the read | `:78-80` |
| No log at any ref | **Denied**, fail closed | `:82-85` |
| Half-written trailing line in the log | Skipped, never fatal | `git-state-store.js:121-135` |
| Malformed hook payload / unreadable stdin | **Denied** (`exit 2`) | `deliver-gate-hook.mjs:36-54` |
| Slug fails `^[a-z0-9][a-z0-9-]*$` | **Denied** — same grammar as `isSafeFeature`, which guards path traversal | `deliver-gate-hook.mjs:99-104`, `git-state-store.js:71-86` |
| Gate script missing entirely | **Denied** — spawn failure is caught and blocks | `deliver-gate-hook.mjs:113-118` |
| Non-`Skill` tool, other skill, or arg-less deliver | **Allowed** — nothing to gate | `:56-59`, `:70-77`, `:84-87` |
| Any unexpected internal error | **Denied** | `:122-124` |

The hook's fail-closed posture is not incidental. The harness treats a crash,
invalid output, or *any* exit code other than 0 or 2 as **non-blocking**, so the
script converts every uncertainty path to an explicit `exit 2` rather than
relying on a bare non-zero exit (`deliver-gate-hook.mjs:13-17`). Read that
comment before editing the script.

### Code evidence

```
.claude/settings.json:8-19                  hook registration (matcher: Skill)
scripts/deliver-gate-hook.mjs:1-125         PreToolUse deny
.claude/commands/team/rad-deliver.md:53-62  prose Step 2
scripts/check-plan-approved.sh:47-135       ref resolution, fingerprint, gate call
scripts/check-approval-integrity.sh:1-36    CI ancestry + authenticity + gate
harness/gates.yaml:19-23                    the rule
harness/gates.js:77-122                     the fold
harness/plan-fingerprint.js:27-59           what the fingerprint covers (body only)
harness/transitions.js:94-131               duplicate + missing-role rules
harness/adapters/git-state-store.js:375-408 write-time role freeze
harness/adapters/git-state-store.js:432-445 policy auto-clear
harness/spine.js:249-252                    in-process gate
.github/workflows/ci.yml:88-128             deliver-PR job
```

---

## What the map exposes

Three things fall out of writing it down that are hard to see from any single
file:

1. **The fingerprint is the real freshness guarantee, and it has a hole.** The
   role gate proves *someone with authority approved something*; only the
   fingerprint proves they approved *this text*. Legacy events without one pass
   (`check-plan-approved.sh:97-100`). That exception is correct today and should
   be removed once no unfingerprinted approval can still be in flight.
2. **The policy auto-clear path is the only one with no human in the loop**, and
   its trust boundary is a config-time regex, not a runtime check. It is
   documented as such in `CLAUDE.md`; this map is where that shows up as a
   *behavior*, next to the five paths that do check.
3. **Presence and execution are different gates and neither replaces the other**
   (`spine.js:374-386`, issue #91). A wave can create every promised test file,
   have all of them fail, and still advance — unless the plan declared a
   `Verify:` command. Anyone reasoning about "does RAD verify its own work"
   needs both halves of that sentence.
