#!/usr/bin/env bash
# test-check-scope.sh
# Regression tests for check-scope.sh's ALWAYS_ALLOW_PREFIXES handling, in
# particular the .agents/findings.jsonl exemption (process artifact).
# Self-contained (no external harness): builds a temp git-repo fixture, runs the
# real check-scope.sh, and asserts behavior. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-scope.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

# ── Build a temp git-repo fixture ──────────────────────────────────────────────
# A repo with COPIES of the real scripts, a CLAUDE.md declaring default_branch:
# main, and a plan declaring one in-scope file. main holds the baseline; each
# assertion uses its own work branch cut from main.
REPO="$TMP/repo"
mkdir -p "$REPO/scripts" "$REPO/.agents/plans" "$REPO/.agents/logs" "$REPO/src"
cp "$HERE/check-scope.sh" "$HERE/get-default-branch.sh" "$REPO/scripts/"
printf '**Name:** t\ndefault_branch: main\n' > "$REPO/CLAUDE.md"

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

echo "ALL PASS"
