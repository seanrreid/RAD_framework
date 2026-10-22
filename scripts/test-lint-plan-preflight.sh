#!/usr/bin/env bash
# test-lint-plan-preflight.sh
# Regression tests for lint-plan.sh's preflight advisories:
#   - directory-entry advisory: a `Tests to Write` bullet that resolves to an
#     existing directory warns (check-tests-present.sh needs a regular file);
#     file, nonexistent, empty-section, trailing-whitespace and fenced entries
#     stay silent or resolve as named below. Warnings only, exit code unchanged.
# Self-contained: builds a hermetic fixture repo, runs the real lint-plan.sh and
# asserts on output/exit code. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-lint-plan-preflight.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

REPO="$TMP/repo"
OUT=""
CODE=0

# Fixture repo: lint-plan.sh + its lib/config reader, a directory (src/dir) and
# a regular file (src/app.js) for entries to resolve against.
setup_fixture() {
  local p
  mkdir -p "$REPO/scripts/lib" "$REPO/harness" "$REPO/.rad" "$REPO/src/dir" "$REPO/.agents/plans"
  cp "$HERE/lint-plan.sh" "$HERE/get-default-branch.sh" "$REPO/scripts/"
  cp "$HERE/lib/plan-paths.sh" "$REPO/scripts/lib/"
  for p in "$HERE/../harness/"*; do
    case "$(basename "$p")" in node_modules|test) ;; *) cp -R "$p" "$REPO/harness/" ;; esac
  done
  printf '**Name:** t\n' > "$REPO/CLAUDE.md"
  printf 'version: 1\nplatform: manual\ndefault_branch: main\nroles:\n  architect:\n    - arch@example.com\n' \
    > "$REPO/.rad/config.yml"
  printf 'x\n' > "$REPO/src/app.js"
}

# write_plan <name> <tests-to-write body, may be empty>
write_plan() {
  local out="$REPO/.agents/plans/$1" tests="$2"
  {
    printf '# Plan: preflight\nCreated: 2026-10-22\nAuthor: developer\n'
    printf 'Status: pending-review\nBranch: rad/preflight\n\n## Context\nx\n\n'
    printf '## Scope\n| In | Out |\n\n## Acceptance Criteria\n1. Two things happen.\n\n'
    printf '## Agent Scope\ndeveloper\n\n## Files in Scope\n'
    printf '| File | Lines | Change |\n|------|-------|--------|\n| src/app.js | 1-2 | x |\n\n'
    printf '## Execution Notes\n### Do Not Touch\n- None\n\n## Wave Plan\n### Wave 1 — sequential\n'
    printf 'Verify: none (fixture: nothing to run)\n'
    printf '#### Task 1.1: t\nFile: src/app.js:1-2\nValidate: AC#1 — x\n\n'
    printf '## Tests to Write\n'
    if [[ -n "$tests" ]]; then printf '%s\n' "$tests"; fi
    printf '\n## Non-Goals\n- a\n- b\n\n## Risks\nnone\n'
  } > "$out"
}

# lint <name> — lint the plan from inside the fixture repo into OUT/CODE.
lint() {
  set +e
  OUT=$( cd "$REPO" && bash scripts/lint-plan.sh ".agents/plans/$1" 2>&1 )
  CODE=$?
  set -e
}

DIR_WARN="is a directory — check-tests-present.sh requires a regular file"

assert_has()   { printf '%s\n' "$OUT" | grep -qF -e "$2" || fail "$1: missing '$2': $OUT"; }
assert_lacks() { if printf '%s\n' "$OUT" | grep -qF -e "$2"; then fail "$1: unexpected '$2': $OUT"; fi; }
assert_code()  { [[ "$CODE" -eq "$2" ]] || fail "$1: exited $CODE (expected $2): $OUT"; }

t_directory_entry_warns() {
  write_plan dir.md '- [ ] covers it — src/dir/'
  lint dir.md
  assert_has "DIR(a)" "⚠ Tests to Write entry 'src/dir/' $DIR_WARN"
  assert_code "DIR(a)" 0
  echo "✓ DIR(a): entry resolving to an existing directory ⇒ warning, exit 0"
}

t_file_and_missing_entries_silent() {
  write_plan file.md $'- [ ] covers it — src/app.js\n- [ ] later — src/not-yet-written.sh'
  lint file.md
  assert_lacks "DIR(b)" "$DIR_WARN"
  assert_code "DIR(b)" 0
  echo "✓ DIR(b): regular-file entry and not-yet-existing path ⇒ no directory warning"
}

t_empty_section_silent() {
  write_plan empty.md ''
  lint empty.md
  assert_lacks "DIR(c)" "$DIR_WARN"
  assert_lacks "DIR(c)" "preflight scan failed"
  assert_has "DIR(c)" "## Tests to Write is empty"
  assert_code "DIR(c)" 1
  echo "✓ DIR(c): empty Tests to Write ⇒ only the existing empty-section error, no scan failure"
}

t_trailing_whitespace_and_decoration() {
  write_plan ws.md $'- [x] covers it — `src/dir/`   \n- [ ] annotated — src/dir (Amendment 1)'
  lint ws.md
  assert_has "DIR(d)" "⚠ Tests to Write entry 'src/dir/' $DIR_WARN"
  assert_has "DIR(d)" "⚠ Tests to Write entry 'src/dir' $DIR_WARN"
  assert_code "DIR(d)" 0
  echo "✓ DIR(d): trailing whitespace, backticks, checkbox and annotation stripped ⇒ warning"
}

t_fenced_entry_silent() {
  write_plan fence.md $'```\n- [ ] example — src/dir/\n```'
  lint fence.md
  assert_lacks "DIR(e)" "$DIR_WARN"
  assert_code "DIR(e)" 0
  echo "✓ DIR(e): entry inside a code fence ⇒ no warning"
}

setup_fixture
t_directory_entry_warns
t_file_and_missing_entries_silent
t_empty_section_silent
t_trailing_whitespace_and_decoration
t_fenced_entry_silent
echo "ALL PASS"
