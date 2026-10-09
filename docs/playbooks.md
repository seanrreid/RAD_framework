# Playbooks

A playbook is a pinned, versioned write-up of a recurring change shape (for
example "add an env knob" or "add a hook point"). A plan pins one by ref in its
header, so the shape the plan was written against is part of what the architect
approves. The mechanism is mechanical only: `rad playbook` validates files and
refs, `plan_playbook` and `lint-plan.sh` check the plan header, and the plan
fingerprint covers the pin. The `--playbook` flag in `/rad-plan` and
`/rad-adopt` is not part of this mechanism yet.

## Location and naming

Playbooks live in `.agents/playbooks/`, one file each, named
`<kind>--<slug>.md`. `kind` and `slug` are kebab-case (a lowercase letter, then
lowercase letters, digits and hyphens). A `README.md` in the directory is
ignored by `rad playbook lint`.

## Format

```
---
{"kind": "env-knob", "slug": "add-knob", "version": 2, "summary": "Add an RAD_* env knob"}
---

Body: the steps, files to touch and tests to write.

## Upgrade Guide

### Version 1 — 2026-10-01
First write-up.

### Version 2 — 2026-10-09
What changed, and what a plan pinned to version 1 should do.
```

The file starts with `---`, a single JSON object, and a closing `---`.
Anything else is an error.

**Frontmatter.** Allowed keys are `kind`, `slug`, `version`, `summary` and
`primary_file`; any other key is an error. `version` is a positive integer.
`kind` and `slug`, when present, must match the file name.

**`primary_file`.** Reserved and unimplemented. It is accepted and ignored. The
in-source marker that would use it, and its lint, are deferred.

**Upgrade Guide rule.** The file must have a `## Upgrade Guide` section, and it
must be the last `## ` section (headings inside code fences do not count). It
holds `### Version N — YYYY-MM-DD` entries that run consecutively from 1, each
with a real calendar date. The last entry must equal the frontmatter `version`,
so bumping the version without writing its guide entry fails the lint.

## Kinds

The allowed kinds are the top-level `playbook_kinds:` list in
`.rad/config.yml`. When the key is absent (or there is no config file), the
default applies: `env-knob`, `hook-point`, `event-type`, `severity-pattern`.
To add a kind, list every kind you want, defaults included:

```yaml
playbook_kinds: [env-knob, hook-point, event-type, severity-pattern, migration]
```

The list must be non-empty, kebab-case and free of duplicates; anything else
fails `rad config validate`. See [configuration.md](configuration.md).

## The plan header

A plan pins a playbook with one header line, above its first `## ` heading:

```
Playbook: env-knob/add-knob@2
```

The grammar is `<kind>/<slug>@<version>`; the version has no leading zeros.
Only the header block is scanned, so a `Playbook:` line in a fenced example or
the body never counts. A second `Playbook:` line, or an empty value, is an
error.

`scripts/lint-plan.sh` runs `rad playbook check-ref` on the value:

- unknown kind, missing file, invalid playbook file, or a version ahead of the
  file: ERROR;
- a version behind the file's current version: WARNING
  (`Playbook <ref> is behind current version N`). Read the Upgrade Guide
  entries after your pin;
- `node` or the harness not available, or the check failing for any other
  reason: ERROR (fail closed).

A plan with no `Playbook:` line lints exactly as before.

## What the fingerprint covers

The approval fingerprint folds in the trimmed header `Playbook:` line, after
any `Capabilities:` line. Changing the pin after approval therefore
invalidates the approval, like any other plan change. A plan with no
`Playbook:` line has the same fingerprint as before this mechanism existed, so
existing approvals are untouched. The playbook file's own contents are not
hashed; the pin (including its version) is.

## Guardrail

A playbook never bypasses approval or severity routing. Pinning one does not
approve a plan, skip `/rad-approve`, lower a risk tier, or change how review
findings are routed. A playbook is guidance the plan cites, not authority.

## Commands

See [`rad playbook`](rad-cli.md#rad-playbook).
