# Research: Portable / Semi-Centralized Process Memory
Created: 2026-06-23
Author: architect
Status: pending-design
Source: session discussion (2026-06-23); shaping brief promoted via /rad-research.
Follow-up to the portability gap left open in the "central brain / SQLite declined"
decision. Prior art reviewed: Anthropic "Agentic Coding and Persistent Returns to
Expertise", Perplexity "Brain" (self-improving memory), Elastic "Agent memory on
Elasticsearch".

## Project Summary
A portability/transport spine so a RAD process can move between users and computers
without state stranding on one machine. Hard process state (events, plans, gates, branch
tips) is the system of record and already lives in git; this work makes it *reliably
portable* by folding sync into the rad verbs, adding handoff ownership, and refusing to
fold a diverged event log. The center is the **git remote** — no new store, no second
source of truth. Soft recall memory (findings/insights, personal notes) is split off to a
separate, user-following store and is explicitly **out of scope for v1**.

The guiding split is RAD's existing **determinism boundary**: hard state stays
append-only and git-canonical (never decays, never centralizes its authority); soft
memory is advisory and lossy-OK. All three reviewed articles describe the *soft* layer
only — their decay/consolidation/vector-recall machinery is poison to a frozen gate — so
the prior art confirms the split rather than changing the hard-state design.

## Key Requirements
- **Sync-first verbs.** Every state-mutating verb (`rad approve`, `rad deliver`,
  ownership changes) pushes branch + events as part of the operation; gate reads fetch the
  tip first. The user never types `git push`/`git pull` — git stays invisible on the happy
  path.
- **Transport rides plain git, never the host API.** Sync = `git push`/`git fetch` only,
  which is host-agnostic by construction (GitHub, GitLab, Bitbucket, bare SSH all behave
  identically). Host CLIs (`gh`/`glab`) remain in the existing mirror/display layer and
  never enter the gate path.
- **No bespoke auth — inherit the user's existing git credentials.** The sync layer
  assumes the user's git remote already authenticates (SSH key, credential helper, token).
  RAD never prompts for or stores credentials; the only remaining auth concern is clear
  error messaging when git auth is absent.
- **Handoff ownership.** Ownership of a feature is an event in the log
  (`owner-claimed` / `owner-released`); the `rad/` branch is the lock. Single-writer keeps
  append semantics clean and the gate fold unambiguous. Claiming/releasing is *not* an
  approval gate.
- **Fail-closed divergence tripwire.** On fetch, if a feature's tip has diverged, the verb
  **refuses to fold the gate** and surfaces the human-coordination fact ("X also has this
  feature open since HH:MM") rather than silently picking a winner. A tripwire, not a
  merge — no CRDTs, no auto-resolution.
- **Offline degrades to today's behavior, fail-safe.** A sync-first verb always commits
  locally first (durable now, as today); the push is best-effort. Offline never blocks
  work and never loses state — it defers transport, and the tripwire catches staleness on
  the next online read.

## Domains

All four in-scope domains are **architect-only by principle**: anything that touches the
**event-fold or approval authority** is architect-only. This is a boundary on *who may
author this code at development time* (enforced by `/rad-review` scope checks) — it is
**not** a runtime gate. Running sync, claiming ownership, and resolving divergence add no
architect approval to anyone's daily flow; the only runtime approval is the pre-existing
plan gate (`/rad-approve`), which this work does not move. Adopting teams can reassign
these defaults; the principle (touches-the-boundary ⇒ architect-only) is what generalizes.

| Domain | Description | Sensitivity |
|--------|-------------|-------------|
| Sync transport / verb integration | Push-on-write + fetch-tip-on-read folded into `rad approve`/`deliver`; plain-git only, no host API | architect-only |
| Ownership & handoff | `owner-claimed`/`owner-released` event types, branch-as-lock semantics, stale-lock release | architect-only |
| Divergence detection | Fail-closed tripwire that refuses to fold a diverged tip and surfaces the conflict | architect-only |
| Remote auth surface | Riding the user's existing git credentials; error messaging when auth is absent. (Candidate a *larger* team would delegate to a trusted infra developer under review; moot on a solo team.) | architect-only |
| Soft-memory store | User-following recall store (findings/insights/personal notes); procedural counters lifted from Elastic. **Out of v1 scope — separate brief.** | open |

## Team

> Convention shown is correct for *this* team; adopting teams adjust to their own roster.

architect: sean@torchcodelab.com
developers: unassigned
designers: none

## Platform

> Using GitHub here, but the design is deliberately **platform-agnostic**: hard-state sync
> rides plain git and works over any git host (GitLab, Bitbucket, Forgejo, bare SSH).
> The platform field below selects only the existing host-API mirror/display layer.

platform: github
default_branch: main

## Constraints
- Preserve the gate's pure event-fold nature; sync adds **transport only**, never a new
  authority or a second source of truth.
- Append-only, no decay, no probabilistic recall for hard state.
- Transport rides plain git, never the host API (the platform-agnostic guarantee).
- No bespoke auth — inherit the user's existing git credentials; never prompt for or store
  them.
- Offline is fail-safe: local-durable always, sync best-effort, tripwire on reconnect.
- Fail-closed on any divergence or ambiguity — surface to a human, never auto-resolve.
- No raw git surfaced to the user on the happy path.
- Opt-in / backward-compatible where feasible (house pattern: `RAD_*` env, unset = OFF).
- Domain sensitivity governs development authorship, not runtime operation — sync,
  ownership claim/release, and divergence handling add **no** architect approval to the
  runtime loop.

## Open Questions
- **Offline error messaging** — exact UX when git auth is missing or the remote is
  unreachable (the residual of the auth/offline questions, now that transport rides
  existing git credentials).
- **Ownership event schema** — field shape for `owner-claimed`/`owner-released`, how it
  folds, and how stale locks are released (timeout vs. explicit vs. force-claim).
- **Divergence-detection mechanics** — fetch-and-compare tips vs. a richer reconciliation;
  precisely what the verb shows the user, and whether a read-only verb may proceed on a
  diverged tip (display) while a write verb refuses.
- **Which verbs become sync-first in v1** — confirm the exact set (`approve`, `deliver`,
  ownership changes) vs. extending to `plan`/`status`.
- **Soft-store substrate & sync** — where the user-following store lives and how it syncs;
  out of v1 scope, tracked as its own brief.

## Non-Goals
- No central database for gate/authority state (the declined SQLite-brain).
- No CRDT / true concurrent multi-writer on one feature in v1.
- No decay / vector-recall machinery anywhere near hard state.
- Soft-layer procedural memory (success/failure counters, overnight consolidation) — real
  and valuable, lifted from Elastic/Perplexity, but a **separate** brief; this one is the
  portability/transport spine.

## v1 Cut
Hard-state **sync-first verbs** + **handoff ownership events** + **fail-closed divergence
tripwire**, riding plain git on the user's existing credentials, offline-fail-safe. Soft
memory and procedural counters are explicitly later efforts.
