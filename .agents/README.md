# Process Artifacts

This directory holds RAD's **process artifacts** — everything the workflow
produces *about* the work, kept separate from the product code that is the work
itself. One predictable namespace, so `/rad-status`, `/rad-insights`, and
resume-after-interrupt can find state by globbing one directory instead of
hunting through the repo.

Each subdirectory is a stage in the feature lifecycle. The subdir READMEs are
authoritative on naming, status values, and lifecycle; this file is the map.

## Layout

| Directory | Produced by | Consumed by | What it holds |
|-----------|-------------|-------------|---------------|
| `research/` | `/rad-research` | `/rad-design` | What is being built and the constraints that shape the agent architecture. One artifact per project. |
| `architecture/` | `/rad-design` (Draft) | `/rad-design` (Generate) | The agent hierarchy, roles, scope boundaries, and output contracts — the source of truth for the generated `.claude/agents/` files. |
| `plans/` | `/rad-plan`, `/rad-adopt` | `/rad-deliver` | The wave-structured plan doc for one feature. Lives on its `rad/[feature]` work branch until the deliver PR merges. |
| `state/<feature>/events.jsonl` | `/rad-approve`, `/rad-deliver` | the gate query | The **machine-authoritative** append-only event log. The `approved` event here is the sole gate authority `/rad-deliver` reads. |
| `logs/` | `/rad-deliver` | architect review, resume | The **human-readable** per-execution narrative + resume state for interrupted runs. |
| `findings/`, `findings.jsonl` | `/rad-review` | `/rad-insights` | Review results per feature, aggregated population-wide by `/rad-insights`. |

## Two distinctions worth keeping straight

- **`state/` vs `logs/`** look redundant but are not. `state/<feature>/events.jsonl`
  is the machine-authoritative gate (a fold target). `logs/` is prose for human
  review. One is read by the harness; the other is read by people.

- **`plans/` travels with branches.** A plan doc lives on its `rad/[feature]`
  branch tip, not on the default branch, until the deliver PR merges plan and
  code together. The plans you see on the default branch are accumulated history
  of past features, not the active working set.
