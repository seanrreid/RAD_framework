#!/usr/bin/env bash
# test-open-pr.sh
# Regression test for open-pr.sh label/draft argument handling (issue #2).
# The framework has no external test harness, so this is a self-contained,
# runnable assertion script: it stubs gh/glab/git on PATH, drives open-pr.sh,
# and asserts the exact argv each platform CLI receives.
#
# Usage: scripts/test-open-pr.sh   (exit 0 = all assertions pass)
# Runs under bash 3.2+ (set -u safe).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Build stubs that capture argv. $1 = remote URL (drives detect-platform.sh).
make_stubs() {
  cat > "$TMP/git" <<EOF
#!/bin/sh
# Minimal git stub: report a remote URL for detection, no-op everything else.
case "\$1 \$2" in
  "remote get-url") echo "$1" ;;
  *) : ;;
esac
EOF
  for cli in gh glab; do
    cat > "$TMP/$cli" <<EOF
#!/bin/sh
: > "$TMP/$cli.argv"
for a in "\$@"; do printf '%s\n' "\$a" >> "$TMP/$cli.argv"; done
echo "https://example.test/pr/1"
EOF
  done
  chmod +x "$TMP/git" "$TMP/gh" "$TMP/glab"
}

run_openpr() { PATH="$TMP:$PATH" "$HERE/open-pr.sh" "$@" >/dev/null 2>&1; }

fail() { echo "✗ $1"; exit 1; }
# Print the token on the line immediately after the first occurrence of $2 in $1.
arg_after() { awk -v f="$2" 'prev==f{print; exit} {prev=$0}' "$1"; }

# 1. GitHub, single label, --no-draft → one "--label rad:deliver", no "--draft", no empty arg.
make_stubs "git@github.com:o/r.git"
run_openpr --title t --body b --head rad/x --no-draft --label rad:deliver
grep -qxF -- "--label" "$TMP/gh.argv" || fail "GitHub: --label missing"
[ "$(arg_after "$TMP/gh.argv" "--label")" = "rad:deliver" ] || fail "GitHub: label value wrong: [$(arg_after "$TMP/gh.argv" "--label")]"
grep -qxF -- "--draft" "$TMP/gh.argv" && fail "GitHub: --draft present despite --no-draft" || true
grep -qxF -- "" "$TMP/gh.argv" && fail "GitHub: empty argument present" || true
echo "✓ GitHub: single label, --no-draft (the rad-deliver call)"

# 2. GitHub, two labels, default draft → two separate "--label" args + "--draft".
make_stubs "git@github.com:o/r.git"
run_openpr --title t --body b --head rad/x --label a --label b
[ "$(grep -cxF -- "--label" "$TMP/gh.argv")" -eq 2 ] || fail "GitHub: expected two --label args"
grep -qxF -- "--draft" "$TMP/gh.argv" || fail "GitHub: --draft missing on default"
echo "✓ GitHub: two labels, draft"

# 3. GitLab, single label → "--label rad:deliver" with NO leading comma.
make_stubs "git@gitlab.com:o/r.git"
run_openpr --title t --body b --head rad/x --no-draft --label rad:deliver
[ "$(arg_after "$TMP/glab.argv" "--label")" = "rad:deliver" ] \
  || fail "GitLab: label has leading comma or wrong value: [$(arg_after "$TMP/glab.argv" "--label")]"
echo "✓ GitLab: single label, no leading comma"

# 4. GitLab, no labels → no "--label" flag at all (not an empty one).
make_stubs "git@gitlab.com:o/r.git"
run_openpr --title t --body b --head rad/x --no-draft
grep -qxF -- "--label" "$TMP/glab.argv" && fail "GitLab: --label present with no labels" || true
echo "✓ GitLab: no labels, --label omitted"

echo "ALL PASS"
