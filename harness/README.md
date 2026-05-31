# @rad/harness

The RAD orchestration harness — the deterministic core that replaces prose-as-control-flow.

This is **migration step 1**: the deterministic core (the `StateStore`/`ArtifactStore`
ports, the event model, the pure state fold, and record-time transition validation).
No git, no I/O — control *flow* as code, control *policy* in declarative files.

See [`docs/harness-state-store.md`](../docs/harness-state-store.md) for the authoritative
design spec (the two ports, state-as-projection, record-time transition validation, and the
git-tracked per-feature `events.jsonl` model).

ES modules. Tests run on Node's built-in runner: `npm test` (`node --test`).
