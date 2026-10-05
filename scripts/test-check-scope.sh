#!/usr/bin/env bash
# test-check-scope.sh
# Regression tests for check-scope.sh's ALWAYS_ALLOW_PREFIXES handling (in
# particular the .agents/findings.jsonl exemption, a process artifact) and its
# rename-aware violation message (issue #99).
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

echo "ALL PASS"
