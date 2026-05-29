#!/usr/bin/env bash
# test-script-hardening.sh
# Regression tests for the script-hardening fixes (issues #3, #4, #7).
# Self-contained (no external harness): builds temp fixtures, runs the real
# scripts, and asserts behavior. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-script-hardening.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

# ── #3: rad-status.sh lists logs newest-first, space-safe, runs clean ──────────
# Pre-fix: find|xargs mis-sorted/space-broke and a grep -c||echo quirk made
# rad-status exit 1 whenever any log existed.
t3() {
  local d="$TMP/p3"
  # .agents/plans is created so the fixture is a realistic repo; this test asserts
  # only the logs (Recent Executions) path — the plans path is covered elsewhere.
  mkdir -p "$d/scripts" "$d/.agents/logs" "$d/.agents/plans" "$d/.claude/agents"
  cp "$HERE/rad-status.sh" "$HERE/get-default-branch.sh" "$HERE/detect-platform.sh" "$d/scripts/"
  printf '**Name:** t\ndefault_branch: main\n' > "$d/CLAUDE.md"
  printf '| 1 | 1 | t | ✓ complete | a | d |\n'                > "$d/.agents/logs/older-2026-05-26.md"
  printf '| 1 | 1 | t | ✓ complete | a | d |\n✗ failed x\n'    > "$d/.agents/logs/newer feature-2026-05-28.md"
  : > "$d/.agents/logs/README.md"
  touch -t 202605260101 "$d/.agents/logs/older-2026-05-26.md"
  touch -t 202605280101 "$d/.agents/logs/newer feature-2026-05-28.md"

  local out
  out=$(cd "$d" && bash scripts/rad-status.sh 2>/dev/null) \
    || fail "#3: rad-status.sh exited non-zero with logs present"

  local exec_block
  exec_block=$(printf '%s\n' "$out" | awk '/Recent Executions/{p=1;next} /── Agents/{p=0} p')
  printf '%s\n' "$exec_block" | grep -q "newer feature" || fail "#3: spaced-name log not listed"
  printf '%s\n' "$exec_block" | grep -q "README"        && fail "#3: README.md should be excluded" || true
  # newest-first: "newer feature" must appear before "older"
  local n o
  n=$(printf '%s\n' "$exec_block" | grep -n "newer feature" | head -1 | cut -d: -f1)
  o=$(printf '%s\n' "$exec_block" | grep -n "older"         | head -1 | cut -d: -f1)
  [[ -n "$n" && -n "$o" && "$n" -lt "$o" ]] || fail "#3: logs not newest-first (newer=$n older=$o)"
  echo "✓ #3: rad-status lists logs newest-first, space-safe, exit 0"
}

# ── #4: grep filters work under BRE with literal table pipes preserved ─────────
t4() {
  # lint-plan must surface a real Files-in-Scope data row but NOT the header/
  # separator rows — proves the table-pipe `grep -v` filter still works.
  local plan="$TMP/p4.md"
  cat > "$plan" <<'EOF'
# Plan: t
Created: 2026-05-29
Author: developer
Status: pending-review
Branch: rad/t

## Context
x

## Scope
| In | Out |

## Acceptance Criteria
1. x

## Agent Scope
x

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| src/ghost.js | 1-2 | x |

## Execution Notes
### Do Not Touch
- None

## Wave Plan
### Wave 1 — sequential
#### Task 1.1: t
Validate: AC#1 — x

## Tests to Write
- [ ] t — scripts/test-script-hardening.sh

## Non-Goals
- a
- b

## Risks
none
EOF
  local out
  out=$(bash "$HERE/lint-plan.sh" "$plan" 2>&1 || true)
  printf '%s\n' "$out" | grep -q "src/ghost.js" || fail "#4: lint-plan didn't parse the table data row"
  printf '%s\n' "$out" | grep -qi "does not exist: File"  && fail "#4: header row leaked as a file path" || true
  printf '%s\n' "$out" | grep -q  "does not exist: ---"   && fail "#4: separator row leaked as a file path" || true

  # check-role: a configured architect resolves (exit 0); a non-configured name denied (exit 1).
  # The fixture includes the unfilled "[your GitHub...]" placeholder line so the
  # `grep -v "^\[your GitHub"` filter (split in fix #4) is regression-tested: the
  # placeholder must NOT be treated as a configured architect.
  local md="$TMP/cm.md"
  printf 'architect:  alice\narchitect:  [your GitHub/GitLab username]\ndevelopers: []\n' > "$md"
  bash "$HERE/check-role.sh" architect "$md" "alice"  >/dev/null 2>&1 || fail "#4: configured architect not matched"
  bash "$HERE/check-role.sh" architect "$md" "mallory" >/dev/null 2>&1 && fail "#4: non-architect wrongly matched" || true
  bash "$HERE/check-role.sh" architect "$md" "[your GitHub/GitLab username]" >/dev/null 2>&1 \
    && fail "#4: placeholder line wrongly matched as an architect" || true
  echo "✓ #4: table-pipe grep filters intact; check-role resolves + filters placeholder"
}

# ── #7: check-tests.sh resolves a backtick-wrapped test path ──────────────────
t7() {
  local present="$TMP/p7-present.md" missing="$TMP/p7-missing.md"
  printf '## Tests to Write\n- [ ] t — `%s`\n' "$HERE/get-default-branch.sh" > "$present"
  printf '## Tests to Write\n- [ ] t — `scripts/does-not-exist-xyz.sh`\n'      > "$missing"
  bash "$HERE/check-tests.sh" "$present" >/dev/null 2>&1 || fail "#7: backtick-wrapped existing path not resolved (reported missing)"
  bash "$HERE/check-tests.sh" "$missing" >/dev/null 2>&1 && fail "#7: missing backtick path wrongly reported present" || true
  echo "✓ #7: check-tests resolves backtick-wrapped paths (present + missing)"
}

t3
t4
t7
echo "ALL PASS"
