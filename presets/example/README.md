# Example Preset

A preset is a team's add-on layer for RAD: extra hooks, guardrail extensions,
agent files, docs, and default settings, installed on top of the core framework
and tracked in `.rad/installed.json` alongside it. This directory is a working
example; copy it to start your own.

## Layout

```
presets/example/
  preset.yml          # name, version, optional settings (required)
  README.md           # this file; ignored by the installer
  files/              # mirrors the target project's layout
    scripts/hooks/on-outcome/50-example-preset.sh
    ai/extensions/example-preset.md
```

The installer reads only `preset.yml` and `files/`. Any other file at the preset
root (like this README) is ignored.

## preset.yml

| Key        | Required | Meaning                                                          |
|------------|----------|------------------------------------------------------------------|
| `name`     | yes      | kebab-case identifier, recorded in the manifest                   |
| `version`  | yes      | non-empty string (quote it: `"1"`), recorded in the manifest      |
| `settings` | no       | values seeded into `.rad/config.yml` under `settings:`            |

Any other top-level key is refused. `settings` accepts the same keys as
`.rad/config.yml` (`high_risk_patterns`, `hooks_dir`). Settings are seeded only
when absent: if the target's config already has a `settings:` block, the preset
leaves it alone and reports each key as `unseeded` for you to add by hand.

A project `high_risk_patterns` REPLACES the built-in default; it is not merged.
This example therefore copies the default verbatim and appends an alternative
for `infra` and `terraform` path segments. Always extend the default, never
narrow it.

## files/

Every file under `files/` lands at the same relative path in the target. Files
may only go under these roots:

- `scripts/hooks/`
- `ai/extensions/`
- `.claude/agents/`
- `docs/`

Presets are add-only: a path the core layer already owns is refused, and nothing
is written. Symlinks and special files are refused. Keep a hook executable in
git (`git update-index --chmod=+x <file>`) or the hook runner skips it.

## Install

From a RAD checkout, into a project that already has RAD installed:

```bash
./install.sh --dir <project> --preset presets/example
# or, inside the project:
node harness/cli.js install-preset --source <path-to>/presets/example
```

The manifest records the preset's name, version, and absolute source path.
`./install.sh --upgrade` re-applies the recorded preset after upgrading core
(the same as `node harness/cli.js install-preset --reapply`). Local edits to
preset files are kept, with the new version staged under
`.rad/upgrade-pending/`, exactly as for core files. Check drift with
`node harness/cli.js install-status`.

## Copy and customize

1. Copy `presets/example` to a directory your team controls.
2. Set a new `name` in `preset.yml` and bump `version` on each change.
3. Edit or replace everything marked `CUSTOMIZE`.
4. Add your own files under `files/`, inside the allowed roots.
5. Install with `--preset <your-dir>` (or `install-preset --source <your-dir>`).

Only one preset can be installed per project; switching to a different preset
name is refused.
