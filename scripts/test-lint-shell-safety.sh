#!/usr/bin/env bash
# test-lint-shell-safety.sh
# Regression tests for lint-shell-safety.sh: taint detection (positional +
# RAD_* env), sink matching (git / jq / node -e / eval), regex + case guard
# recognition, baseline ratchet semantics (warn / stale), the committed-mode
# pass (index-not-filesystem in BOTH directions, recursion, *.mjs), the
# scripts-dir path-shape guard, and usage errors.
# Self-contained: builds synthetic script fixtures in a temp dir and runs the
# REAL script against them. Runs under bash 3.2+.
#
# Fixture dirs are real git repos: the committed-mode pass reads modes from the
# git index and fails closed on a dir no repo tracks, so a plain scratch dir
# would make every case exit 2.
#
# Usage: scripts/test-lint-shell-safety.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Stop git's repo discovery from escaping the scratch tree, so the "not in a
# repo" case cannot be rescued by some ancestor repo on the test machine.
export GIT_CEILING_DIRECTORIES="$TMP"

fail() { echo "✗ $1"; exit 1; }

# init_fixture_repo <dir> — make a fixture dir a repo whose scripts are staged
# 100755, so the committed-mode pass sees a clean index and only the cases that
# mean to exercise it trip it.
init_fixture_repo() {
  local dir="$1"
  chmod +x "$dir"/*.sh || fail "fixture setup: chmod failed in $dir"
  git -C "$dir" init -q >/dev/null 2>&1 || fail "fixture setup: git init failed in $dir"
  git -C "$dir" add -A || fail "fixture setup: git add failed in $dir"
}

run_lint() {
  # run_lint <scripts-dir> <baseline-file> — runs the REAL lint; echoes code.
  local dir="$1" baseline="$2" code
  set +e
  bash "$HERE/lint-shell-safety.sh" "$dir" "$baseline" > "$TMP/out" 2>&1
  code=$?
  set -e
  echo "$code"
}

EMPTY_BASELINE="$TMP/empty-baseline.txt"
: > "$EMPTY_BASELINE"

# ── Case 1: regex-guarded positional into git passes ───────────────────────────
mkdir -p "$TMP/guarded"
cat > "$TMP/guarded/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
BRANCH="${1:-}"
if [[ ! "$BRANCH" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "invalid branch" >&2
  exit 2
fi
git fetch origin "$BRANCH"
EOF
init_fixture_repo "$TMP/guarded"
code=$(run_lint "$TMP/guarded" "$EMPTY_BASELINE")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 1: regex-guarded script should exit 0 (got $code)"; }
grep -q "^PASS:" "$TMP/out" || fail "case 1: expected terminal PASS line"
echo "✓ case 1: regex-guarded positional into git passes (exit 0)"

# ── Case 2: unguarded positional into git fails ────────────────────────────────
mkdir -p "$TMP/unguarded"
cat > "$TMP/unguarded/deploy.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
BRANCH="${1:-}"
[[ -z "$BRANCH" ]] && exit 2
git fetch origin "$BRANCH"
EOF
init_fixture_repo "$TMP/unguarded"
code=$(run_lint "$TMP/unguarded" "$EMPTY_BASELINE")
[[ "$code" -eq 1 ]] || fail "case 2: unguarded script should exit 1 (got $code)"
grep -q '✗ deploy.sh: unguarded \$BRANCH' "$TMP/out" || fail "case 2: expected unguarded-BRANCH reason"
echo "✓ case 2: unguarded positional into git fails (exit 1)"

# ── Case 3: same unguarded script, baselined → warns but exits 0 ───────────────
cat > "$TMP/baseline.txt" <<'EOF'
# frozen offenders
deploy.sh   # unguarded: $BRANCH into git fetch
EOF
code=$(run_lint "$TMP/unguarded" "$TMP/baseline.txt")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 3: baselined offender should exit 0 (got $code)"; }
grep -q '⚠ baseline: deploy.sh: unguarded \$BRANCH' "$TMP/out" || fail "case 3: expected baseline warning"
grep -q "^PASS:" "$TMP/out" || fail "case 3: expected terminal PASS line"
echo "✓ case 3: baselined offender warns without failing (exit 0)"

# ── Case 4: baseline listing a clean file → stale warning, exit 0 ──────────────
cat > "$TMP/stale-baseline.txt" <<'EOF'
deploy.sh   # this file is guarded now — entry should be reported stale
EOF
code=$(run_lint "$TMP/guarded" "$TMP/stale-baseline.txt")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 4: stale baseline should exit 0 (got $code)"; }
grep -q '⚠ stale baseline: deploy.sh' "$TMP/out" || fail "case 4: expected stale-baseline warning"
echo "✓ case 4: stale baseline entry warns and still exits 0"

# ── Case 5: nonexistent scripts dir → usage error (exit 2) ─────────────────────
code=$(run_lint "$TMP/no-such-dir" "$EMPTY_BASELINE")
[[ "$code" -eq 2 ]] || fail "case 5: nonexistent dir should exit 2 (got $code)"
grep -q "scripts dir not found" "$TMP/out" || fail "case 5: expected dir-not-found error"
echo "✓ case 5: nonexistent scripts dir exits 2"

# ── Case 6: unguarded RAD_* env-derived variable into node -e fails ────────────
mkdir -p "$TMP/envsink"
cat > "$TMP/envsink/report.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
PATTERN="${RAD_HIGH_RISK_PATTERNS:-}"
node -e "console.log('$PATTERN')"
EOF
init_fixture_repo "$TMP/envsink"
code=$(run_lint "$TMP/envsink" "$EMPTY_BASELINE")
[[ "$code" -eq 1 ]] || fail "case 6: env-derived var into node -e should exit 1 (got $code)"
grep -q '✗ report.sh: unguarded \$PATTERN' "$TMP/out" || fail "case 6: expected unguarded-PATTERN reason"
echo "✓ case 6: unguarded RAD_* env variable into node -e fails (exit 1)"

# ── Case 7: case-guarded variable into git passes ──────────────────────────────
mkdir -p "$TMP/caseguard"
cat > "$TMP/caseguard/mode.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-}"
case "$MODE" in
  push|fetch) : ;;
  *) echo "bad mode" >&2; exit 2 ;;
esac
git config "sync.$MODE" true
EOF
init_fixture_repo "$TMP/caseguard"
code=$(run_lint "$TMP/caseguard" "$EMPTY_BASELINE")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 7: case-guarded script should exit 0 (got $code)"; }
echo "✓ case 7: case-guarded variable into git passes (exit 0)"

# ── Case 8: test-*.sh fixtures are excluded from the scan ──────────────────────
mkdir -p "$TMP/excluded"
cat > "$TMP/excluded/test-something.sh" <<'EOF'
#!/usr/bin/env bash
BRANCH="$1"
git fetch origin "$BRANCH"
EOF
init_fixture_repo "$TMP/excluded"
code=$(run_lint "$TMP/excluded" "$EMPTY_BASELINE")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 8: test-*.sh should be excluded (got $code)"; }
echo "✓ case 8: test-*.sh fixtures are excluded (exit 0)"

# ── Case 9: a script committed 100644 fails the mode pass by name ──────────────
# The offender is a test-*.sh, the exact shape the taint scan skips — this is
# what proves the mode pass is a genuinely separate, recursive pass.
mkdir -p "$TMP/badmode"
cat > "$TMP/badmode/test-thing.sh" <<'EOF'
#!/usr/bin/env bash
echo "no taint here"
EOF
init_fixture_repo "$TMP/badmode"
git -C "$TMP/badmode" update-index --chmod=-x test-thing.sh \
  || fail "case 9 setup: could not stage 100644"
code=$(run_lint "$TMP/badmode" "$EMPTY_BASELINE")
[[ "$code" -eq 1 ]] || { cat "$TMP/out"; fail "case 9: 100644-committed script should exit 1 (got $code)"; }
grep -q '✗ test-thing.sh: committed mode 100644, expected 100755' "$TMP/out" \
  || { cat "$TMP/out"; fail "case 9: expected the offender named with its actual mode"; }
grep -q 'read from the git index' "$TMP/out" \
  || fail "case 9: message must explain the mode comes from the index, not a chmod"
echo "✓ case 9: script committed 100644 fails by name (exit 1)"

# ── Case 10: sample/data files and nested dirs do not trip the mode pass ───────
mkdir -p "$TMP/modeexempt/hooks/post-wave"
cat > "$TMP/modeexempt/ok.sh" <<'EOF'
#!/usr/bin/env bash
echo ok
EOF
cat > "$TMP/modeexempt/hooks/post-wave/10-example-veto.sh.sample" <<'EOF'
#!/usr/bin/env bash
echo abort-user
EOF
printf 'deploy.sh\n' > "$TMP/modeexempt/lint-shell-safety-baseline.txt"
printf '# hooks\n' > "$TMP/modeexempt/hooks/README.md"
init_fixture_repo "$TMP/modeexempt"   # only ok.sh matches the top-level *.sh glob
code=$(run_lint "$TMP/modeexempt" "$EMPTY_BASELINE")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 10: sample/data files should not trip the mode pass (got $code)"; }
if grep -q 'sh.sample' "$TMP/out"; then fail "case 10: *.sh.sample must be exempt"; fi
if grep -q 'baseline.txt:' "$TMP/out"; then fail "case 10: baseline .txt must be exempt"; fi
if grep -q 'README.md' "$TMP/out"; then fail "case 10: README.md must be exempt"; fi
echo "✓ case 10: .sh.sample, baseline .txt and README.md are exempt (exit 0)"

# ── Case 11: a scripts dir outside any git repo fails closed (exit 2) ──────────
mkdir -p "$TMP/nogit"
cat > "$TMP/nogit/plain.sh" <<'EOF'
#!/usr/bin/env bash
echo hi
EOF
code=$(run_lint "$TMP/nogit" "$EMPTY_BASELINE")
[[ "$code" -eq 2 ]] || { cat "$TMP/out"; fail "case 11: non-git scripts dir should exit 2 (got $code)"; }
grep -q 'committed-mode check needs a git repository' "$TMP/out" \
  || fail "case 11: expected the fail-closed git-repo error"
echo "✓ case 11: scripts dir outside a git repo fails closed (exit 2)"

# ── Case 12: non-executable ON DISK but committed 100755 still passes ──────────
# The mirror image of case 9. Together they pin the check to the git index in
# BOTH directions: case 9 proves a +x working tree does not rescue a 100644
# index, and this proves a -x working tree does not condemn a 100755 index.
mkdir -p "$TMP/diskonly"
cat > "$TMP/diskonly/ok.sh" <<'EOF'
#!/usr/bin/env bash
echo ok
EOF
init_fixture_repo "$TMP/diskonly"   # stages 100755
chmod -x "$TMP/diskonly/ok.sh" || fail "case 12 setup: chmod -x failed"
code=$(run_lint "$TMP/diskonly" "$EMPTY_BASELINE")
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 12: filesystem mode must not be consulted (got $code)"; }
if grep -q 'ok.sh' "$TMP/out"; then cat "$TMP/out"; fail "case 12: a 100755-indexed script must not be flagged"; fi
grep -q "^PASS:" "$TMP/out" || fail "case 12: expected terminal PASS line"
echo "✓ case 12: chmod -x on disk with a 100755 index still passes (exit 0)"

# ── Case 13: a bad mode in a SUBDIRECTORY is caught ────────────────────────────
# The taint scan's glob stops at the top level; the mode pass uses git ls-files,
# which recurses. Only a nested offender can tell the two apart.
mkdir -p "$TMP/subdir/lib"
cat > "$TMP/subdir/ok.sh" <<'EOF'
#!/usr/bin/env bash
echo ok
EOF
cat > "$TMP/subdir/lib/helper.sh" <<'EOF'
#!/usr/bin/env bash
echo helper
EOF
chmod +x "$TMP/subdir/lib/helper.sh" || fail "case 13 setup: chmod +x failed"
init_fixture_repo "$TMP/subdir"
git -C "$TMP/subdir" update-index --chmod=-x lib/helper.sh \
  || fail "case 13 setup: could not stage 100644"
code=$(run_lint "$TMP/subdir" "$EMPTY_BASELINE")
[[ "$code" -eq 1 ]] || { cat "$TMP/out"; fail "case 13: nested 100644 script should exit 1 (got $code)"; }
grep -q '✗ lib/helper.sh: committed mode 100644, expected 100755' "$TMP/out" \
  || { cat "$TMP/out"; fail "case 13: expected the nested offender named by its repo-relative path"; }
echo "✓ case 13: bad mode in a subdirectory is caught (exit 1)"

# ── Case 14: *.mjs is covered by the mode pass, not just *.sh ──────────────────
mkdir -p "$TMP/mjsmode"
cat > "$TMP/mjsmode/ok.sh" <<'EOF'
#!/usr/bin/env bash
echo ok
EOF
cat > "$TMP/mjsmode/tool.mjs" <<'EOF'
#!/usr/bin/env node
console.log('tool');
EOF
chmod +x "$TMP/mjsmode/tool.mjs" || fail "case 14 setup: chmod +x failed"
init_fixture_repo "$TMP/mjsmode"
git -C "$TMP/mjsmode" update-index --chmod=-x tool.mjs \
  || fail "case 14 setup: could not stage 100644"
code=$(run_lint "$TMP/mjsmode" "$EMPTY_BASELINE")
[[ "$code" -eq 1 ]] || { cat "$TMP/out"; fail "case 14: 100644-committed .mjs should exit 1 (got $code)"; }
grep -q '✗ tool.mjs: committed mode 100644, expected 100755' "$TMP/out" \
  || { cat "$TMP/out"; fail "case 14: expected the .mjs offender named with its actual mode"; }
echo "✓ case 14: .mjs committed 100644 fails by name (exit 1)"

# ── Case 15: a scripts dir path with shell metacharacters is refused (exit 2) ──
# $SCRIPTS_DIR reaches a `git -C` command line, so the lint bounds its own input
# the way it demands of every other script. The dir must EXIST, otherwise the
# earlier dir-not-found check would answer first and prove nothing.
mkdir -p "$TMP/bad dir"
code=$(run_lint "$TMP/bad dir" "$EMPTY_BASELINE")
[[ "$code" -eq 2 ]] || { cat "$TMP/out"; fail "case 15: metacharacter dir path should exit 2 (got $code)"; }
grep -q 'scripts dir path has unsupported characters' "$TMP/out" \
  || { cat "$TMP/out"; fail "case 15: expected the path-shape guard error"; }
if grep -q 'scripts dir not found' "$TMP/out"; then
  fail "case 15: dir must exist so the shape guard, not the existence check, fires"
fi
echo "✓ case 15: scripts dir path with unsupported characters exits 2"

echo "ALL PASS"
