#!/usr/bin/env bash
# test-script-hardening.sh
# Regression tests for the script-hardening fixes (issues #3, #4, #7).
# Self-contained (no external harness): builds temp fixtures, runs the real
# scripts, and asserts behavior. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-script-hardening.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Physical path (pwd -P): cli.js runs main() only when argv[1] equals its
# realpath, and macOS mktemp dirs live under the /var -> /private/var symlink.
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

# copy_harness <dest-root> — the config reader (harness/ minus node_modules/test).
copy_harness() {
  local p
  mkdir -p "$1/harness"
  for p in "$HERE/../harness/"*; do
    case "$(basename "$p")" in node_modules|test) ;; *) cp -R "$p" "$1/harness/" ;; esac
  done
}

# write_config <dest-root> <architect-identity> — a minimal .rad/config.yml.
write_config() {
  mkdir -p "$1/.rad"
  printf 'version: 1\nplatform: manual\ndefault_branch: main\nroles:\n  architect:\n    - "%s"\n' "$2" \
    > "$1/.rad/config.yml"
}

# ── #3: rad-status.sh lists logs newest-first, space-safe, runs clean ──────────
# Pre-fix: find|xargs mis-sorted/space-broke and a grep -c||echo quirk made
# rad-status exit 1 whenever any log existed.
t3() {
  local d="$TMP/p3"
  # .agents/plans is created so the fixture is a realistic repo; this test asserts
  # only the logs (Recent Executions) path — the plans path is covered elsewhere.
  mkdir -p "$d/scripts" "$d/.agents/logs" "$d/.agents/plans" "$d/.claude/agents"
  cp "$HERE/rad-status.sh" "$HERE/get-default-branch.sh" "$HERE/detect-platform.sh" "$d/scripts/"
  printf '**Name:** t\n' > "$d/CLAUDE.md"
  copy_harness "$d"
  write_config "$d" "arch@example.com"
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
  # The unfilled "[your GitHub...]" placeholder must never count as a configured
  # architect: as an identity it is denied, and a config that still lists it is
  # invalid, so check-role fails closed (exit 2) even for a real architect.
  local root="$TMP/cm" ph="[your GitHub/GitLab username]" code
  copy_harness "$root"
  write_config "$root" "alice"
  bash "$HERE/check-role.sh" architect "$root" "alice"  >/dev/null 2>&1 || fail "#4: configured architect not matched"
  bash "$HERE/check-role.sh" architect "$root" "mallory" >/dev/null 2>&1 && fail "#4: non-architect wrongly matched" || true
  bash "$HERE/check-role.sh" architect "$root" "$ph" >/dev/null 2>&1 \
    && fail "#4: placeholder identity wrongly matched as an architect" || true
  local ph_root="$TMP/cm-ph"
  copy_harness "$ph_root"
  write_config "$ph_root" "$ph"
  code=0
  bash "$HERE/check-role.sh" architect "$ph_root" "$ph" >/dev/null 2>&1 || code=$?
  [[ "$code" -eq 2 ]] || fail "#4: placeholder architect config should fail closed (exit 2), got $code"
  echo "✓ #4: table-pipe grep filters intact; check-role resolves + filters placeholder"
}

# ── #7: check-tests-present.sh resolves a backtick-wrapped test path ──────────
t7() {
  local present="$TMP/p7-present.md" missing="$TMP/p7-missing.md"
  printf '## Tests to Write\n- [ ] t — `%s`\n' "$HERE/get-default-branch.sh" > "$present"
  printf '## Tests to Write\n- [ ] t — `scripts/does-not-exist-xyz.sh`\n'      > "$missing"
  bash "$HERE/check-tests-present.sh" "$present" >/dev/null 2>&1 || fail "#7: backtick-wrapped existing path not resolved (reported missing)"
  bash "$HERE/check-tests-present.sh" "$missing" >/dev/null 2>&1 && fail "#7: missing backtick path wrongly reported present" || true
  echo "✓ #7: check-tests-present resolves backtick-wrapped paths (present + missing)"
}

t3
t4
t7
echo "ALL PASS"
