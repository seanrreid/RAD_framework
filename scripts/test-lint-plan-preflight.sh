#!/usr/bin/env bash
# test-lint-plan-preflight.sh
# Regression tests for lint-plan.sh's preflight advisories:
#   - directory-entry advisory: a `Tests to Write` bullet that resolves to an
#     existing directory warns (check-tests-present.sh needs a regular file);
#     file, nonexistent, empty-section, trailing-whitespace and fenced entries
#     stay silent or resolve as named below. Warnings only, exit code unchanged.
#   - doc-list sibling advisory: a task What: saying "doc list" / "to the list"
#     that declares .md files warns when an undeclared, out-of-scope .md file
#     names an item (kebab-case token) every declared doc shares; silent without
#     a declared .md, without a shared token, or when siblings are in scope.
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

# write_plan <name> <tests-to-write body, may be empty> [task block] [extra
# Files in Scope rows]. The task block defaults to a File:-declaring task that
# says nothing about doc lists.
write_plan() {
  local out="$REPO/.agents/plans/$1" tests="$2"
  local task="${3:-$'#### Task 1.1: t\nFile: src/app.js:1-2\nValidate: AC#1 — x'}" scope_rows="${4:-}"
  {
    printf '# Plan: preflight\nCreated: 2026-10-22\nAuthor: developer\n'
    printf 'Status: pending-review\nBranch: rad/preflight\n\n## Context\nx\n\n'
    printf '## Scope\n| In | Out |\n\n## Acceptance Criteria\n1. Two things happen.\n\n'
    printf '## Agent Scope\ndeveloper\n\n## Files in Scope\n'
    printf '| File | Lines | Change |\n|------|-------|--------|\n| src/app.js | 1-2 | x |\n'
    if [[ -n "$scope_rows" ]]; then printf '%s\n' "$scope_rows"; fi
    printf '\n'
    printf '## Execution Notes\n### Do Not Touch\n- None\n\n## Wave Plan\n### Wave 1 — sequential\n'
    printf 'Verify: none (fixture: nothing to run)\n'
    printf '%s\n\n' "$task"
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

DOC_WARN_TAIL="also naming the same items:"

# write_docs <file> <content> — create a tracked markdown fixture.
write_docs() {
  mkdir -p "$REPO/$(dirname "$1")"
  printf '%s\n' "$2" > "$REPO/$1"
  git -C "$REPO" add -- "$1"
}

# doc_task <What text> [File: value] — task block; File: omitted when empty.
doc_task() {
  printf '#### Task 1.1: t\n'
  if [[ -n "${2:-}" ]]; then printf 'File: %s\n' "$2"; fi
  printf 'What: %s\nValidate: AC#1 — x' "$1"
}

setup_docs() {
  git -C "$REPO" init -q
  write_docs docs/a.md 'Lists widget-alpha and other-thing.'
  write_docs docs/b.md 'Also widget-alpha here.'
  write_docs docs/c.md 'The sibling that names widget-alpha too.'
  write_docs docs/d.md 'Nothing relevant: unrelated-token only.'
  write_docs docs/e.md 'only-in-e'
  write_docs docs/f.md 'only-in-f'
  write_docs docs/g.md 'has only-in-e and only-in-f both'
  write_docs cap/x1.md 'cap-token'
  write_docs cap/x2.md 'cap-token'
  local i
  for i in 1 2 3 4 5 6 7; do write_docs "cap/s$i.md" "cap-token sibling $i"; done
}

t_doc_list_warns() {
  write_plan dl.md '- [ ] t — src/app.js' "$(doc_task 'Add the entry to the list' 'docs/a.md, docs/b.md')"
  lint dl.md
  assert_has "DOCLIST(a)" '⚠ Task 1.1 says "to the list" but declares 2 doc file(s); also naming the same items: docs/c.md'
  assert_lacks "DOCLIST(a)" "docs/d.md"
  assert_code "DOCLIST(a)" 0
  write_plan dl2.md '- [ ] t — src/app.js' "$(doc_task 'Update every Doc List entry' 'docs/a.md, docs/b.md')"
  lint dl2.md
  assert_has "DOCLIST(a)" 'Task 1.1 says "doc list" but declares 2 doc file(s)'
  echo "✓ DOCLIST(a): phrase + two declared docs + undeclared sibling ⇒ warning, exit 0"
}

t_doc_list_silent_without_markdown() {
  write_plan nomd.md '- [ ] t — src/app.js' "$(doc_task 'Add to the doc list' 'src/app.js:1-2')"
  lint nomd.md
  assert_lacks "DOCLIST(b)" "$DOC_WARN_TAIL"
  assert_code "DOCLIST(b)" 0
  echo "✓ DOCLIST(b): task declares no markdown file ⇒ silent"
}

t_doc_list_silent_without_shared_token() {
  write_plan notok.md '- [ ] t — src/app.js' "$(doc_task 'Add to the doc list' 'docs/e.md, docs/f.md')"
  lint notok.md
  assert_lacks "DOCLIST(c)" "$DOC_WARN_TAIL"
  assert_code "DOCLIST(c)" 0
  echo "✓ DOCLIST(c): declared docs share no token (docs/g.md names both) ⇒ silent"
}

t_doc_list_silent_when_siblings_in_scope() {
  write_plan inscope.md '- [ ] t — src/app.js' "$(doc_task 'Add to the doc list' 'docs/a.md, docs/b.md')" \
    '| docs/c.md | 1 | x |'
  lint inscope.md
  assert_lacks "DOCLIST(d)" "$DOC_WARN_TAIL"
  assert_code "DOCLIST(d)" 0
  echo "✓ DOCLIST(d): every matching sibling already in Files in Scope ⇒ silent"
}

t_doc_list_caps_siblings() {
  write_plan cap.md '- [ ] t — src/app.js' "$(doc_task 'Add to the doc list' 'cap/x1.md, cap/x2.md')"
  lint cap.md
  assert_has "DOCLIST(e)" "$DOC_WARN_TAIL cap/s1.md, cap/s2.md, cap/s3.md, cap/s4.md, cap/s5.md"
  assert_lacks "DOCLIST(e)" "cap/s6.md"
  assert_code "DOCLIST(e)" 0
  echo "✓ DOCLIST(e): seven siblings ⇒ only the first five are listed"
}

t_doc_list_no_file_line_silent() {
  write_plan nofile.md '- [ ] t — src/app.js' "$(doc_task 'Add to the doc list' '')"
  lint nofile.md
  assert_lacks "DOCLIST(f)" "$DOC_WARN_TAIL"
  assert_lacks "DOCLIST(f)" "preflight scan failed"
  echo "✓ DOCLIST(f): task with no File: line ⇒ silent, no scan failure"
}

t_doc_list_fenced_phrase_ignored() {
  local block=$'#### Task 1.1: t\nFile: docs/a.md, docs/b.md\n```\nWhat: add to the doc list\n```\nWhat: tidy wording\nValidate: AC#1 — x'
  write_plan fenceddoc.md '- [ ] t — src/app.js' "$block"
  lint fenceddoc.md
  assert_lacks "DOCLIST(g)" "$DOC_WARN_TAIL"
  assert_code "DOCLIST(g)" 0
  echo "✓ DOCLIST(g): phrase inside a code fence ⇒ ignored"
}

t_doc_list_scan_failure_is_error() {
  write_plan scanfail.md '- [ ] t — src/app.js' "$(doc_task 'Add to the doc list' 'docs/a.md, docs/b.md')"
  set +e
  OUT=$( cd "$REPO" && GIT_DIR="$TMP/no-such-git-dir" bash scripts/lint-plan.sh ".agents/plans/scanfail.md" 2>&1 )
  CODE=$?
  set -e
  assert_has "DOCLIST(h)" "preflight scan failed: doc_list_check_task exited"
  assert_code "DOCLIST(h)" 1
  echo "✓ DOCLIST(h): git ls-files failure ⇒ fail-closed ERROR, not a silent pass"
}

setup_fixture
setup_docs
t_directory_entry_warns
t_file_and_missing_entries_silent
t_empty_section_silent
t_trailing_whitespace_and_decoration
t_fenced_entry_silent
t_doc_list_warns
t_doc_list_silent_without_markdown
t_doc_list_silent_without_shared_token
t_doc_list_silent_when_siblings_in_scope
t_doc_list_caps_siblings
t_doc_list_no_file_line_silent
t_doc_list_fenced_phrase_ignored
t_doc_list_scan_failure_is_error
echo "ALL PASS"
