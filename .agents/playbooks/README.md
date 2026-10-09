# Playbooks

Pinned, versioned write-ups of recurring change shapes. A plan cites one in its
header (`Playbook: <kind>/<slug>@<version>`, or `--playbook` on `/rad-plan` and
`/rad-adopt`), so the shape it was written against is part of what the
architect approves. A playbook is guidance, never authority: it does not
approve a plan or change severity routing.

Files are named `<kind>--<slug>.md`. The format, the Upgrade Guide rule and the
header grammar are in [`docs/playbooks.md`](../../docs/playbooks.md). Check them
with `node harness/cli.js playbook lint`.

## Seeds

| Playbook | Use it for |
|----------|-----------|
| `env-knob--timeout-style` | a `RAD_*` env knob holding a positive integer (a timeout or a cap) |
| `event-type--audit-only` | a new audit-only event: no phase, no gate authority |

## Writing or changing one

Draft from the real diffs of a shipped change, not from memory. Every file and
test a playbook names must exist today. Bumping `version` needs a matching
`### Version N — YYYY-MM-DD` entry in `## Upgrade Guide` saying what a plan
pinned to the older version should do. This README is ignored by the lint.
