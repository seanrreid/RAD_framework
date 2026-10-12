#!/usr/bin/env bash
# test-check-scope.sh
# Regression tests for check-scope.sh's ALWAYS_ALLOW_PREFIXES handling (in
# particular the .agents/findings.jsonl exemption, a process artifact) and its
# rename-aware violation message (issue #99), and its test-integrity guard
# (deleted / renamed-away / skip-marked tests need a test-removal waiver).
# Self-contained (no external harness): builds a temp git-repo fixture, runs the
# real check-scope.sh, and asserts behavior. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-scope.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Physical path (pwd -P): cli.js runs main() only when argv[1] equals its
# realpath, and macOS mktemp dirs live under the /var -> /private/var symlink.
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

# ── Constants ─────────────────────────────────────────────────────────────────
# Message fragments check-scope.sh emits. Asserted verbatim so a wording change
# in the script surfaces as a failure here instead of passing silently.
RENAME_HINT_FRAGMENT="likely undeclared rename target of declared file:"
CONVENTION_BLOCK_FRAGMENT="A rename declares BOTH paths as separate Files-in-Scope rows"
UNRESOLVED_RANGE_FRAGMENT="no diff range resolves between"
PASS_FRAGMENT="✓ Scope check passed"

# A branch name that is never created, so every diff-range candidate fails to
# resolve. check-scope.sh must exit 2 with a reason, not git's raw 128.
GHOST_BRANCH="rad/never-created"

# ── Build a temp git-repo fixture ──────────────────────────────────────────────
# A repo with COPIES of the real scripts and harness/ (minus node_modules/test —
# the config reader get-default-branch.sh uses), a .rad/config.yml declaring
# default_branch: main, and a plan declaring one in-scope file. main holds the baseline; each
# assertion uses its own work branch cut from main.
REPO="$TMP/repo"
mkdir -p "$REPO/scripts" "$REPO/harness" "$REPO/.rad" "$REPO/.agents/plans" "$REPO/.agents/logs" "$REPO/src"
cp "$HERE/check-scope.sh" "$HERE/get-default-branch.sh" "$REPO/scripts/"
cp -R "$HERE/lib" "$REPO/scripts/lib"
for p in "$HERE/../harness/"*; do
  case "$(basename "$p")" in node_modules|test) ;; *) cp -R "$p" "$REPO/harness/" ;; esac
done
printf '**Name:** t\n' > "$REPO/CLAUDE.md"
printf 'version: 1\nplatform: manual\ndefault_branch: main\nroles:\n  architect:\n    - arch@example.com\n' \
  > "$REPO/.rad/config.yml"

cat > "$REPO/.agents/plans/feature.md" <<'EOF'
# Plan: t
Status: approved
Branch: rad/feature

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| src/in-scope.js | 1-2 | x |
EOF

printf 'export const x = 1;\n' > "$REPO/src/in-scope.js"

# Baseline files for the test-integrity cases. Contents are distinct and long
# enough that git's rename detection pairs a moved file with its source.
mkdir -p "$REPO/test" "$REPO/pkg"
printf 'export const removable = 1;\n' > "$REPO/src/removable.js"
printf "it('keep', () => {});\nit('keep two', () => {});\n" > "$REPO/test/keep.test.js"
printf "it('gone', () => {});\nit('gone two', () => {});\n" > "$REPO/test/gone.test.js"
printf "it('moved', () => {});\nit('moved two', () => {});\n" > "$REPO/test/moved.test.js"
printf "it.skip('old', () => {});\nit('live', () => {});\n" > "$REPO/test/skipped.test.js"
printf "it('spaced', () => {});\nit('spaced two', () => {});\n" > "$REPO/test/with space.test.js"
printf '#!/usr/bin/env bash\necho x-test\n' > "$REPO/scripts/test-x.sh"
printf 'package pkg\nfunc TestA(t *testing.T) {}\n' > "$REPO/pkg/foo_test.go"
printf 'def test_a():\n    assert True\n' > "$REPO/pkg/test_a.py"

git -C "$REPO" init -q
git -C "$REPO" config user.email "t@t.t"
git -C "$REPO" config user.name "t"
git -C "$REPO" checkout -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "baseline"

PLAN=".agents/plans/feature.md"

run_scope() {
  # Run check-scope.sh inside the fixture repo against a work branch. Captures
  # exit code without tripping set -e (this script asserts on the code).
  local branch="$1"
  local code
  set +e
  ( cd "$REPO" && bash scripts/check-scope.sh "$PLAN" "$branch" main ) >/dev/null 2>&1
  code=$?
  set -e
  echo "$code"
}

OUT_FILE="$TMP/scope-output.txt"

run_scope_capture() {
  # Same invocation as run_scope, but keeps the combined output in $OUT_FILE so a
  # case can assert the message as well as the code. Echoes the exit code.
  # Args: <plan-file> <work-branch>
  local plan="$1" branch="$2"
  local code
  set +e
  ( cd "$REPO" && bash scripts/check-scope.sh "$plan" "$branch" main ) > "$OUT_FILE" 2>&1
  code=$?
  set -e
  echo "$code"
}

assert_out_has() {
  # Args: <expected substring> <case label>
  grep -qF -- "$1" "$OUT_FILE" || fail "$2: output missing expected text: $1"
}

assert_out_lacks() {
  # Args: <forbidden substring> <case label>
  grep -qF -- "$1" "$OUT_FILE" && fail "$2: output contains unexpected text: $1"
  return 0
}

# ── AC#1: only .agents/findings.jsonl changed (not declared) → exit 0 ──────────
git -C "$REPO" checkout -q -b rad/findings main
printf '{"id":1}\n' > "$REPO/.agents/findings.jsonl"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "add findings"
code=$(run_scope "rad/findings")
[[ "$code" -eq 0 ]] || fail "AC#1: findings.jsonl-only change should exit 0 (got $code)"
echo "✓ AC#1: .agents/findings.jsonl-only change is exempt (exit 0)"

# ── AC#2: undeclared non-artifact file changed → exit 1 ────────────────────────
git -C "$REPO" checkout -q main
git -C "$REPO" checkout -q -b rad/foo main
printf 'console.log(1);\n' > "$REPO/src/foo.js"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "add undeclared foo.js"
code=$(run_scope "rad/foo")
[[ "$code" -eq 1 ]] || fail "AC#2: undeclared src/foo.js should exit 1 (got $code)"
echo "✓ AC#2: undeclared non-artifact file is flagged out-of-scope (exit 1)"

# ── AC#3: undeclared .agents/logs/ and .agents/plans/ changes → exit 0 ─────────
git -C "$REPO" checkout -q main
git -C "$REPO" checkout -q -b rad/artifacts main
printf '| 1 | log |\n' > "$REPO/.agents/logs/run-2026-06-01.md"
printf '\nextra line\n' >> "$REPO/.agents/plans/feature.md"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "touch logs and plans"
code=$(run_scope "rad/artifacts")
[[ "$code" -eq 0 ]] || fail "AC#3: .agents/logs + .agents/plans changes should exit 0 (got $code)"
echo "✓ AC#3: .agents/logs/ and .agents/plans/ remain exempt (exit 0)"

# ── AC#3b: undeclared .agents/research/ change → exit 0 ───────────────────────
# /rad-research commits its artifact to the work branch BEFORE the plan exists,
# so it can never appear in a plan's Files in Scope. Without this exemption a
# deliver that never touched the artifact fails Gate 2 on its own branch's first
# commit — observed on rad/wave-back-pressure (#89).
git -C "$REPO" checkout -q main
git -C "$REPO" checkout -q -b rad/research-artifact main
mkdir -p "$REPO/.agents/research"
printf '# Research: t\n' > "$REPO/.agents/research/feature.md"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "research artifact"
code=$(run_scope "rad/research-artifact")
[[ "$code" -eq 0 ]] || fail "AC#3b: .agents/research/ change should exit 0 (got $code)"
echo "✓ AC#3b: .agents/research/ is exempt (exit 0)"

# ── AC#4a: git mv of a declared file to an undeclared path → exit 1, names both ─
# The destination is real drift (still exit 1); the message must additionally
# point at the declared source it came from, plus the two-row convention block.
git -C "$REPO" checkout -q main
git -C "$REPO" checkout -q -b rad/rename main
git -C "$REPO" mv src/in-scope.js src/renamed.js
git -C "$REPO" commit -q -m "rename declared file to an undeclared path"
code=$(run_scope_capture "$PLAN" "rad/rename")
[[ "$code" -eq 1 ]] || fail "AC#4a: undeclared rename target should exit 1 (got $code)"
assert_out_has "src/renamed.js — $RENAME_HINT_FRAGMENT src/in-scope.js" "AC#4a"
assert_out_has "$CONVENTION_BLOCK_FRAGMENT" "AC#4a"
echo "✓ AC#4a: undeclared rename target names both destination and source (exit 1)"

# ── AC#4b: both rename rows declared → exit 0 ──────────────────────────────────
# The plan lives under .agents/plans/ (always allowed), so writing it on the
# branch cannot itself affect the verdict.
git -C "$REPO" checkout -q main
git -C "$REPO" checkout -q -b rad/rename-declared main
git -C "$REPO" mv src/in-scope.js src/renamed.js
cat > "$REPO/.agents/plans/feature-renamed.md" <<'EOF'
# Plan: t
Status: approved
Branch: rad/rename-declared

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| src/in-scope.js | 1-2 | renamed away |
| src/renamed.js | 1-2 | rename destination |
EOF
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "rename with both paths declared"
code=$(run_scope_capture ".agents/plans/feature-renamed.md" "rad/rename-declared")
[[ "$code" -eq 0 ]] || fail "AC#4b: rename with both rows declared should exit 0 (got $code)"
assert_out_has "$PASS_FRAGMENT" "AC#4b"
echo "✓ AC#4b: rename with source and destination both declared passes (exit 0)"

# ── AC#4c: undeclared new file that is NOT a rename → today's plain message ────
git -C "$REPO" checkout -q main
git -C "$REPO" checkout -q -b rad/unrelated main
printf 'export const y = 2;\n' > "$REPO/src/unrelated.js"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "add unrelated undeclared file"
code=$(run_scope_capture "$PLAN" "rad/unrelated")
[[ "$code" -eq 1 ]] || fail "AC#4c: unrelated undeclared file should exit 1 (got $code)"
assert_out_has "  ✗ src/unrelated.js" "AC#4c"
assert_out_lacks "$RENAME_HINT_FRAGMENT" "AC#4c"
assert_out_lacks "$CONVENTION_BLOCK_FRAGMENT" "AC#4c"
echo "✓ AC#4c: non-rename drift keeps the plain message, no rename hint (exit 1)"

# ── AC#4d: unresolvable diff range → exit 2 with a reason (never git's raw 128) ─
code=$(run_scope_capture "$PLAN" "$GHOST_BRANCH")
[[ "$code" -eq 2 ]] || fail "AC#4d: unresolvable diff range should exit 2, not $code"
assert_out_has "$UNRESOLVED_RANGE_FRAGMENT" "AC#4d"
assert_out_has "$GHOST_BRANCH" "AC#4d"
echo "✓ AC#4d: unresolvable diff range exits 2 and logs the reason"

# ── Default-branch config error (followups-87 AC#1) ───────────────────────────
# The fixture's own .rad/config.yml (read by its copied get-default-branch.sh) is
# made unparseable in the working tree only; check-scope diffs committed refs.
# (Absent-key → main is covered by test-check-plan-approved.sh cases (l) and (o).)
git -C "$REPO" checkout -q main
printf 'version: [unterminated\n' > "$REPO/.rad/config.yml"

set +e
( cd "$REPO" && bash scripts/check-scope.sh "$PLAN" "rad/findings" ) > "$OUT_FILE" 2>&1
code=$?
set -e
[[ "$code" -eq 2 ]] || { cat "$OUT_FILE"; fail "CFG-a: broken config with no base should exit 2 (got $code)"; }
assert_out_has "cannot read default_branch from .rad/config.yml" "CFG-a"
assert_out_has "cannot resolve the default branch" "CFG-a"
assert_out_lacks "main..." "CFG-a"
assert_out_lacks "$PASS_FRAGMENT" "CFG-a"
echo "✓ CFG-a: broken config + no base fails closed (exit 2, reason printed, no main diff)"

code=$(run_scope_capture "$PLAN" "rad/findings")
[[ "$code" -eq 0 ]] || { cat "$OUT_FILE"; fail "CFG-b: explicit base must skip the lookup (got $code)"; }
assert_out_lacks "cannot resolve the default branch" "CFG-b"
echo "✓ CFG-b: explicit base with a broken config skips the lookup (exit 0)"
git -C "$REPO" checkout -q -- .rad/config.yml

# ── Test-integrity guard (test-weakening-guard AC#1-AC#8) ─────────────────────
TI_HEADER_FRAGMENT="✗ Test integrity violation"
SCOPE_HEADER_FRAGMENT="✗ Scope violation"
WAIVER_SYNTAX_FRAGMENT="- test-removal:<path>: <reason>"

TI_PLAN="$TMP/ti-plan.md"

write_ti_plan() {
  # Write $TI_PLAN (outside the repo, so it never shows in a diff). Args:
  # <newline-separated scope paths> [waiver bullet ...]. Paths are written
  # verbatim into the table; a path with a space cannot be declared in scope
  # (the scope parser strips whitespace), so such a case also draws a scope hit.
  local scope="$1" path bullet
  shift
  {
    printf '# Plan: ti\nStatus: approved\nBranch: rad/ti\n\n## Files in Scope\n'
    printf '| File | Lines | Change |\n|------|-------|--------|\n'
    while IFS= read -r path; do
      [[ -n "$path" ]] && printf '| %s | 1 | x |\n' "$path"
    done <<< "$scope"
    if [[ "$#" -gt 0 ]]; then
      printf '\n## Waivers\n'
      for bullet in "$@"; do printf '%s\n' "$bullet"; done
    fi
  } > "$TI_PLAN"
}

ti_branch() {
  # Cut rad/ti-<name> from main; the caller edits the working tree, then ti_commit.
  git -C "$REPO" checkout -q -b "rad/ti-$1" main
}

ti_commit() {
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m "ti change"
  git -C "$REPO" checkout -q main
}

ti_expect() {
  # Run the check on rad/ti-<name> with $TI_PLAN and assert the exit code.
  # Args: <label> <name> <expected-code>. Output stays in $OUT_FILE.
  local label="$1" name="$2" want="$3" code
  code=$(run_scope_capture "$TI_PLAN" "rad/ti-$name")
  [[ "$code" -eq "$want" ]] || { cat "$OUT_FILE"; fail "$label: exit $code (expected $want)"; }
}

GONE="test/gone.test.js"

# (a) AC#1: deleted test, no waiver → blocked; names the path and the syntax.
ti_branch del; git -C "$REPO" rm -q "$GONE"; ti_commit
write_ti_plan "$GONE"
ti_expect "TI-a" del 1
assert_out_has "$TI_HEADER_FRAGMENT" "TI-a"
assert_out_has "$GONE — deleted" "TI-a"
assert_out_has "$WAIVER_SYNTAX_FRAGMENT" "TI-a"
echo "✓ TI-a: deleted test without a waiver exits 1, names the path and the waiver syntax"

# (b) AC#4: a matching non-empty waiver allows the deletion.
write_ti_plan "$GONE" "- test-removal:$GONE: replaced by the e2e suite"
ti_expect "TI-b" del 0
assert_out_has "$PASS_FRAGMENT" "TI-b"
assert_out_lacks "$TI_HEADER_FRAGMENT" "TI-b"
echo "✓ TI-b: matching waiver allows the deletion (exit 0)"

# (c) AC#4: empty reason, different path, or a path-prefix does not waive.
write_ti_plan "$GONE" "- test-removal:$GONE:"
ti_expect "TI-c1" del 1
write_ti_plan "$GONE" "- test-removal:test/other.test.js: wrong path"
ti_expect "TI-c2" del 1
write_ti_plan "$GONE" "- test-removal:test/gone.test: prefix of the real path"
ti_expect "TI-c3" del 1
write_ti_plan "$GONE" "- test-removal:test/: directory prefix"
ti_expect "TI-c4" del 1
assert_out_has "$GONE — deleted" "TI-c4"
echo "✓ TI-c: empty reason, wrong path and path-prefix waivers do not waive"

# (d) AC#2: rename counts as removal of the old path, whatever the new path.
ti_branch mv
git -C "$REPO" mv test/moved.test.js src/renamed.js; ti_commit
write_ti_plan $'test/moved.test.js\nsrc/renamed.js'
ti_expect "TI-d1" mv 1
assert_out_has "test/moved.test.js — renamed to src/renamed.js" "TI-d1"
write_ti_plan $'test/moved.test.js\nsrc/renamed.js' "- test-removal:test/moved.test.js: moved into src"
ti_expect "TI-d2" mv 0
echo "✓ TI-d: renamed-away test blocked; waiving the OLD path allows it"

# (e) AC#3: skip marker added to an existing test → blocked, names path + line.
ti_branch skip
printf "describe.skip('later', () => {});\n" >> "$REPO/test/keep.test.js"; ti_commit
write_ti_plan "test/keep.test.js"
ti_expect "TI-e1" skip 1
assert_out_has "test/keep.test.js — added skip marker: describe.skip('later', () => {});" "TI-e1"
write_ti_plan "test/keep.test.js" "- test-removal:test/keep.test.js: flaky, tracked in #1"
ti_expect "TI-e2" skip 0
echo "✓ TI-e: added skip marker blocked (path and line named); waiver allows it"

# (f) AC#3: the same marker in a brand-new test file is fine.
ti_branch newfile
printf "it.skip('fresh', () => {});\n" > "$REPO/test/fresh.test.js"; ti_commit
write_ti_plan "test/fresh.test.js"
ti_expect "TI-f" newfile 0
echo "✓ TI-f: skip marker in a new test file passes"

# (g) AC#3: a marker on a REMOVED line does not count.
ti_branch unskip
printf "it('old', () => {});\nit('live', () => {});\n" > "$REPO/test/skipped.test.js"; ti_commit
write_ti_plan "test/skipped.test.js"
ti_expect "TI-g" unskip 0
echo "✓ TI-g: removing a skip marker passes"

# (h) AC#6: edit with no marker passes, including a lookalike (process.exit()).
ti_branch edit
printf "it('three', () => { process.exit(0); });\n" >> "$REPO/test/keep.test.js"; ti_commit
write_ti_plan "test/keep.test.js"
ti_expect "TI-h" edit 0
assert_out_lacks "$TI_HEADER_FRAGMENT" "TI-h"
echo "✓ TI-h: edit adding no marker passes (exit( is not xit()"

# (i) AC#6: deleting a non-test file is untouched by the guard.
ti_branch nontest; git -C "$REPO" rm -q src/removable.js; ti_commit
write_ti_plan "src/removable.js"
ti_expect "TI-i" nontest 0
echo "✓ TI-i: deleted non-test file passes"

# (j) AC#5: scripts/test-*.sh is a test path.
ti_branch shdel; git -C "$REPO" rm -q scripts/test-x.sh; ti_commit
write_ti_plan "scripts/test-x.sh"
ti_expect "TI-j" shdel 1
assert_out_has "scripts/test-x.sh — deleted" "TI-j"
echo "✓ TI-j: deleted scripts/test-x.sh blocked"

# (k) AC#5/AC#3: *_test.go and test_*.py are test paths; Go/pytest markers count.
ti_branch langs
printf '\tt.Skip("later")\n' >> "$REPO/pkg/foo_test.go"
printf '@pytest.mark.skip\n' >> "$REPO/pkg/test_a.py"; ti_commit
write_ti_plan $'pkg/foo_test.go\npkg/test_a.py'
ti_expect "TI-k" langs 1
assert_out_has 'pkg/foo_test.go — added skip marker: 	t.Skip("later")' "TI-k"
assert_out_has "pkg/test_a.py — added skip marker: @pytest.mark.skip" "TI-k"
echo "✓ TI-k: *_test.go and test_*.py are test paths; t.Skip( and @pytest.mark.skip count"

# (l) A path containing a space is handled (NUL-delimited read, literal pathspec).
ti_branch space; git -C "$REPO" rm -q "test/with space.test.js"; ti_commit
write_ti_plan "src/in-scope.js"
ti_expect "TI-l1" space 1
assert_out_has "test/with space.test.js — deleted" "TI-l1"
write_ti_plan "src/in-scope.js" "- test-removal:test/with space.test.js: retired"
ti_expect "TI-l2" space 1   # still out of scope (a spaced path cannot be declared)
assert_out_lacks "$TI_HEADER_FRAGMENT" "TI-l2"
echo "✓ TI-l: path with a space is reported, and a waiver for it clears the test check"

# (m) AC#6: no changed files → the existing warning, exit 0.
ti_branch empty; git -C "$REPO" checkout -q main
write_ti_plan "src/in-scope.js"
ti_expect "TI-m" empty 0
assert_out_has "No changed files detected" "TI-m"
echo "✓ TI-m: no changed files exits 0 as before"

# (n) AC#7: a scope violation and a test violation are both reported.
ti_branch both; git -C "$REPO" rm -q "$GONE"; printf 'x\n' > "$REPO/src/undeclared.js"; ti_commit
write_ti_plan "$GONE"
ti_expect "TI-n1" both 1
assert_out_has "$SCOPE_HEADER_FRAGMENT" "TI-n1"
assert_out_has "src/undeclared.js" "TI-n1"
assert_out_has "$TI_HEADER_FRAGMENT" "TI-n1"
assert_out_has "$GONE — deleted" "TI-n1"
write_ti_plan "$GONE" "- test-removal:$GONE: retired"
ti_expect "TI-n2" both 1   # waiver clears only the test half
assert_out_has "$SCOPE_HEADER_FRAGMENT" "TI-n2"
assert_out_lacks "$TI_HEADER_FRAGMENT" "TI-n2"
echo "✓ TI-n: scope and test-integrity violations are reported together (exit 1)"

# (o) AC#6: no test changes → output identical to the pre-guard message.
ti_branch plain; printf 'export const x = 2;\n' > "$REPO/src/in-scope.js"; ti_commit
write_ti_plan "src/in-scope.js"
ti_expect "TI-o" plain 0
printf '%s\n%s\n' "✓ Scope check passed: ti-plan" \
  "  1 file(s) changed — all within declared scope" > "$TMP/ti-expected.txt"
diff "$TMP/ti-expected.txt" "$OUT_FILE" >/dev/null || { cat "$OUT_FILE"; fail "TI-o: output changed for a branch with no test changes"; }
echo "✓ TI-o: branch with no test changes prints exactly the old output"

# (p) AC#7: a failure of the check itself exits 2, never clean. A work branch
# whose diff resolves for the scope check but not for the guard cannot be built
# cheaply, so break the guard's own dependency instead: remove its library.
mv "$REPO/scripts/lib/test-integrity.sh" "$TMP/ti-lib.bak"
set +e
( cd "$REPO" && bash scripts/check-scope.sh "$TI_PLAN" "rad/ti-plain" main ) > "$OUT_FILE" 2>&1
code=$?
set -e
mv "$TMP/ti-lib.bak" "$REPO/scripts/lib/test-integrity.sh"
[[ "$code" -eq 2 ]] || { cat "$OUT_FILE"; fail "TI-p: missing guard library exited $code (expected 2)"; }
assert_out_lacks "$PASS_FRAGMENT" "TI-p"
echo "✓ TI-p: a missing guard library exits 2, never clean"

echo "ALL PASS"
