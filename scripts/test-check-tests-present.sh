#!/usr/bin/env bash
# test-check-tests-present.sh
# Two responsibilities:
#   (a) Behavior tests for scripts/check-tests-present.sh — present, missing,
#       unresolvable, empty-section, and backtick-wrapped path cases, each
#       asserting an explicit exit code.
#   (b) A stale-reference guard: the pre-rename BARE FILENAME must not reappear
#       in any live surface — bare, so a reference by filename alone is caught,
#       not just the full scripts/ path. Historical records (plans/, .agents/)
#       keep their references on purpose and are excluded.
# Self-contained (no external harness): builds temp fixture plans, runs the real
# script, and asserts behavior. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-tests-present.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$HERE/check-tests-present.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

run_check() {
  # Run the real script against a fixture plan and echo its exit code without
  # tripping set -e (this test asserts on the code).
  local plan="$1"
  local code
  set +e
  bash "$SCRIPT" "$plan" >/dev/null 2>&1
  code=$?
  set -e
  echo "$code"
}

# ── Part A: behavior of the renamed script ────────────────────────────────────

[[ -x "$SCRIPT" ]] || fail "A0: $SCRIPT is not executable"
echo "✓ A0: check-tests-present.sh is executable"

# A1: a listed test file that exists on disk → exit 0.
printf '## Tests to Write\n- [ ] t — %s\n' "$HERE/get-default-branch.sh" > "$TMP/present.md"
code=$(run_check "$TMP/present.md")
[[ "$code" -eq 0 ]] || fail "A1: present test file should exit 0 (got $code)"
echo "✓ A1: listed file present → exit 0"

# A2: a listed test file that does not exist → exit 1.
printf '## Tests to Write\n- [ ] t — scripts/does-not-exist-xyz.sh\n' > "$TMP/missing.md"
code=$(run_check "$TMP/missing.md")
[[ "$code" -eq 1 ]] || fail "A2: missing test file should exit 1 (got $code)"
echo "✓ A2: listed file missing → exit 1"

# A3: a line with no ' — path' is reported as unresolvable but is NOT fatal —
# only a genuinely missing file fails the check. Asserts the reported baseline.
printf '## Tests to Write\n- [ ] t with no file path\n' > "$TMP/unresolvable.md"
code=$(run_check "$TMP/unresolvable.md")
[[ "$code" -eq 0 ]] || fail "A3: unresolvable-only line should exit 0 (got $code)"
bash "$SCRIPT" "$TMP/unresolvable.md" 2>/dev/null | grep -q "No file path found" \
  || fail "A3: unresolvable line not reported in output"
echo "✓ A3: unresolvable line reported, non-fatal → exit 0"

# A4: an empty '## Tests to Write' section → exit 1.
printf '## Tests to Write\n\n## Non-Goals\n- a\n' > "$TMP/empty.md"
code=$(run_check "$TMP/empty.md")
[[ "$code" -eq 1 ]] || fail "A4: empty Tests-to-Write section should exit 1 (got $code)"
echo "✓ A4: empty Tests-to-Write section → exit 1"

# A5: a backtick-wrapped path resolves (regression cover for issue #7) — present
# resolves to exit 0, missing to exit 1.
printf '## Tests to Write\n- [ ] t — `%s`\n' "$HERE/get-default-branch.sh" > "$TMP/tick-present.md"
printf '## Tests to Write\n- [ ] t — `scripts/does-not-exist-xyz.sh`\n'      > "$TMP/tick-missing.md"
code=$(run_check "$TMP/tick-present.md")
[[ "$code" -eq 0 ]] || fail "A5: backtick-wrapped present path should exit 0 (got $code)"
code=$(run_check "$TMP/tick-missing.md")
[[ "$code" -eq 1 ]] || fail "A5: backtick-wrapped missing path should exit 1 (got $code)"
echo "✓ A5: backtick-wrapped paths resolve (present → 0, missing → 1)"

# ── Part B: stale-reference guard ─────────────────────────────────────────────
# SELF-MATCH HAZARD, and the approach chosen:
# A guard that searches every live surface for the pre-rename name would match
# its own source and fail forever. The fix used here is to ASSEMBLE THE NEEDLE AT
# RUNTIME from two fragments, so the literal never appears anywhere in this file.
# The alternative — adding --exclude=test-check-tests-present.sh — was rejected:
# excluding this file by name would make the guard blind to a real stale
# reference reintroduced inside the guard itself. Runtime assembly keeps the
# guard's coverage total, this file included.
#
# The needle is the BARE filename, not the scripts/ path, so a reference that
# names the script without its directory is caught too. A fixed-string (-F)
# search for the bare pre-rename name cannot match the new name: the new name
# has "-present" between the stem and the ".sh".
STALE_REF="check-tests"".sh"

# Excluded on purpose: plans/ and .agents/ are historical records that
# intentionally retain the pre-rename name; .git/ and node_modules/ are not source.
guard_stale_reference() {
  local hits code
  set +e
  hits=$(cd "$ROOT" && grep -rn --binary-files=without-match \
    --exclude-dir=plans --exclude-dir=.agents --exclude-dir=.git \
    --exclude-dir=node_modules \
    -F "$STALE_REF" .)
  code=$?
  set -e

  case "$code" in
    1) echo "✓ B1: no live surface references the pre-rename name ($STALE_REF)" ;;
    0)
      echo "✗ B1: pre-rename name '$STALE_REF' found in live surface(s):"
      printf '%s\n' "$hits" | sed 's/^/    /'
      echo "  Rename these references to check-tests-present.sh."
      exit 1
      ;;
    *) fail "B1: grep failed (exit $code) — guard could not run, treating as failure" ;;
  esac
}

guard_stale_reference

echo "ALL PASS"
