# quality-review

Run a read-only review of security, error handling, null safety, input validation, naming, and project conventions.

## Input

Read {{args}} (optional):
- Empty: review every file changed since branching from the default branch.
- File paths: review only those files.

Resolve the default branch and the changed files with:

```bash
BASE=$(scripts/get-default-branch.sh)
git diff "$BASE"...HEAD --name-only
```

If `scripts/get-default-branch.sh` exits non-zero, report its stderr and stop.

## Process

1. Build the file list: the files the user named, or the changed files above.
2. Spawn the `quality-reviewer` sub-agent, defined at `.codex/agents/quality-reviewer.toml`
   (it runs with `sandbox_mode = "read-only"`). Give it the file list and the
   default branch as context.
3. Wait for it to finish and report its findings report as written.

## Rules

- Never edit, create, or delete files. Never commit or push.
- If the sub-agent cannot be spawned, say so and stop; do not review the files
  yourself in its place.
