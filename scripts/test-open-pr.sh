#!/usr/bin/env bash
# test-open-pr.sh
# Regression test for open-pr.sh label/draft argument handling (issue #2)
# and GitHub closing-issue link verification (issue #163).
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
# Guard against a misconfigured stub silently producing a false green: the CLI
# must actually have been invoked (its argv-capture file must exist).
require_called() { [[ -f "$1" ]] || fail "$2 was not invoked (no argv captured at $1)"; }

# 1. GitHub, single label, --no-draft → one "--label rad:deliver", no "--draft", no empty arg.
make_stubs "git@github.com:o/r.git"
run_openpr --title t --body b --head rad/x --no-draft --label rad:deliver
require_called "$TMP/gh.argv" "gh"
grep -qxF -- "--label" "$TMP/gh.argv" || fail "GitHub: --label missing"
[ "$(arg_after "$TMP/gh.argv" "--label")" = "rad:deliver" ] || fail "GitHub: label value wrong: [$(arg_after "$TMP/gh.argv" "--label")]"
grep -qxF -- "--draft" "$TMP/gh.argv" && fail "GitHub: --draft present despite --no-draft" || true
awk 'NF==0{found=1} END{exit !found}' "$TMP/gh.argv" && fail "GitHub: empty argument present" || true
echo "✓ GitHub: single label, --no-draft (the rad-deliver call)"

# 2. GitHub, two labels, default draft → two separate "--label" args + "--draft".
make_stubs "git@github.com:o/r.git"
run_openpr --title t --body b --head rad/x --label a --label b
require_called "$TMP/gh.argv" "gh"
[ "$(grep -cxF -- "--label" "$TMP/gh.argv")" -eq 2 ] || fail "GitHub: expected two --label args"
grep -qxF -- "--draft" "$TMP/gh.argv" || fail "GitHub: --draft missing on default"
echo "✓ GitHub: two labels, draft"

# 3. GitLab, single label → "--label rad:deliver" with NO leading comma.
make_stubs "git@gitlab.com:o/r.git"
run_openpr --title t --body b --head rad/x --no-draft --label rad:deliver
require_called "$TMP/glab.argv" "glab"
[ "$(arg_after "$TMP/glab.argv" "--label")" = "rad:deliver" ] \
  || fail "GitLab: label has leading comma or wrong value: [$(arg_after "$TMP/glab.argv" "--label")]"
echo "✓ GitLab: single label, no leading comma"

# 4. GitLab, no labels → no "--label" flag at all (not an empty one).
make_stubs "git@gitlab.com:o/r.git"
run_openpr --title t --body b --head rad/x --no-draft
require_called "$TMP/glab.argv" "glab"
grep -qxF -- "--label" "$TMP/glab.argv" && fail "GitLab: --label present with no labels" || true
echo "✓ GitLab: no labels, --label omitted"

# 5. GitHub, no labels → no "--label" flag (exercises the count-guard / empty-array path).
make_stubs "git@github.com:o/r.git"
run_openpr --title t --body b --head rad/x --no-draft
require_called "$TMP/gh.argv" "gh"
grep -qxF -- "--label" "$TMP/gh.argv" && fail "GitHub: --label present with no labels" || true
echo "✓ GitHub: no labels, --label omitted"

# --- Closing-issue link verification (#163) --------------------------------
# A stateful gh stub: `pr create` echoes the URL; `pr view` prints the linked
# issue numbers from $TMP/linked.before (or $TMP/linked.after once `pr edit`
# has run); every view/edit is appended to $TMP/gh.calls. $1 = before, $2 = after
# (space-separated issue numbers).
make_link_stubs() {
  make_stubs "git@github.com:o/r.git"
  rm -f "$TMP/gh.calls" "$TMP/edited" "$TMP/edit.body"
  printf '%s\n' $1 > "$TMP/linked.before"
  printf '%s\n' $2 > "$TMP/linked.after"
  cat > "$TMP/gh" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "pr create") echo "https://github.com/o/r/pull/7" ;;
  "pr view")
    echo "view \$3" >> "$TMP/gh.calls"
    if [ -f "$TMP/edited" ]; then grep . "$TMP/linked.after"; else grep . "$TMP/linked.before"; fi
    exit 0 ;;
  "pr edit")
    echo "edit \$3 \$4" >> "$TMP/gh.calls"
    cat "\$5" > "$TMP/edit.body"
    : > "$TMP/edited" ;;
esac
EOF
  chmod +x "$TMP/gh"
}

# Run open-pr.sh capturing stderr to $TMP/err and the exit code to RC.
run_link() {
  RC=0
  PATH="$TMP:$PATH" "$HERE/open-pr.sh" --title t --head rad/x --no-draft --body "$1" \
    >/dev/null 2>"$TMP/err" || RC=$?
}
# Count logged gh calls of kind $1; no log file yet means zero calls.
calls_of() {
  [ -f "$TMP/gh.calls" ] || { echo 0; return 0; }
  awk -v k="$1" '$1==k{n++} END{print n+0}' "$TMP/gh.calls"
}

# 6. Linked on first check → one view, no edit, no warning.
make_link_stubs "12" ""
run_link "Closes #12."
[ "$RC" -eq 0 ] || fail "link: exit $RC on linked-first"
[ "$(calls_of view)" -eq 1 ] || fail "link: expected 1 view call, got $(calls_of view)"
[ "$(calls_of edit)" -eq 0 ] || fail "link: edit called although linked on first check"
grep -q warning "$TMP/err" && fail "link: unexpected warning: $(cat "$TMP/err")" || true
echo "✓ GitHub link: linked on first check, no re-save"

# 7. Linked only after the re-save → exactly one edit (same body), no warning.
make_link_stubs "" "12"
run_link "closes #12"
[ "$RC" -eq 0 ] || fail "link: exit $RC on linked-after-resave"
[ "$(calls_of edit)" -eq 1 ] || fail "link: expected 1 edit call, got $(calls_of edit)"
grep -qxF "edit https://github.com/o/r/pull/7 --body-file" "$TMP/gh.calls" || fail "link: edit argv wrong: $(cat "$TMP/gh.calls")"
[ "$(cat "$TMP/edit.body")" = "closes #12" ] || fail "link: re-saved body differs: [$(cat "$TMP/edit.body")]"
[ "$(calls_of view)" -eq 2 ] || fail "link: expected 2 view calls, got $(calls_of view)"
grep -q warning "$TMP/err" && fail "link: unexpected warning: $(cat "$TMP/err")" || true
echo "✓ GitHub link: linked after one re-save, no warning"

# 8. Still unlinked after the re-save → one edit, warning naming #12, exit 0.
make_link_stubs "" ""
run_link "Fixes #12"
[ "$RC" -eq 0 ] || fail "link: exit $RC when still unlinked (PR was opened)"
[ "$(calls_of edit)" -eq 1 ] || fail "link: expected exactly 1 edit call, got $(calls_of edit)"
grep -qF "warning: GitHub linked no closing issue for #12 — close it after merge" "$TMP/err" \
  || fail "link: missing warning for #12: $(cat "$TMP/err")"
echo "✓ GitHub link: still unlinked → one re-save + warning, exit 0"

# 9. Body without closing keywords → no view/edit calls at all.
make_link_stubs "" ""
run_link "Refs #12, see #13 (no closing keyword)"
[ "$RC" -eq 0 ] || fail "link: exit $RC on keyword-free body"
[ -f "$TMP/gh.calls" ] && fail "link: gh view/edit called for keyword-free body: $(cat "$TMP/gh.calls")" || true
echo "✓ GitHub link: no closing keywords → no verification calls"

# 10. Multiple issues, partially linked → warning only for the missing one.
make_link_stubs "12" "12"
run_link "Closes #12. RESOLVES #34."
[ "$RC" -eq 0 ] || fail "link: exit $RC on partial link"
[ "$(calls_of edit)" -eq 1 ] || fail "link: expected 1 edit call on partial link, got $(calls_of edit)"
grep -qF "closing issue for #34 " "$TMP/err" || fail "link: missing warning for #34: $(cat "$TMP/err")"
grep -qF "#12" "$TMP/err" && fail "link: warned for linked #12: $(cat "$TMP/err")" || true
echo "✓ GitHub link: partial link → warning only for #34"

# 11. gh pr view fails → warning carrying its reason, no edit, exit 0.
make_link_stubs "" ""
cat > "$TMP/gh" <<EOF
#!/bin/sh
case "\$1 \$2" in
  "pr create") echo "https://github.com/o/r/pull/7" ;;
  "pr view") echo "view" >> "$TMP/gh.calls"; echo "HTTP 502 bad gateway" >&2; exit 1 ;;
  "pr edit") echo "edit" >> "$TMP/gh.calls" ;;
esac
EOF
run_link "Closes #12"
[ "$RC" -eq 0 ] || fail "link: exit $RC when gh pr view failed (PR was opened)"
[ "$(calls_of edit)" -eq 0 ] || fail "link: edit called after a failed view"
grep -qF "HTTP 502 bad gateway" "$TMP/err" || fail "link: view failure reason not surfaced: $(cat "$TMP/err")"
echo "✓ GitHub link: gh pr view failure → warning with reason, exit 0"

# 12 (followups-87 AC#2). Default-branch config error → exit 1 with the reason,
# no gh/glab call. A copied scripts/ tree with a stub harness/cli.js that fails
# `config get default_branch` (exit 1 + reason) and reports every other key absent
# (exit 3), so detect-platform.sh still falls back to the origin URL (GitHub).
CFG_ROOT="$TMP/cfg-root"
CFG_REASON="stub: .rad/config.yml is invalid"
mkdir -p "$CFG_ROOT/scripts" "$CFG_ROOT/harness"
cp "$HERE/open-pr.sh" "$HERE/get-default-branch.sh" "$HERE/detect-platform.sh" "$CFG_ROOT/scripts/"
cat > "$CFG_ROOT/harness/cli.js" <<EOF
if (process.argv[4] === 'default_branch') { process.stderr.write('$CFG_REASON\n'); process.exit(1); }
process.exit(3);
EOF
run_cfg_openpr() {
  rm -f "$TMP/gh.argv" "$TMP/glab.argv"
  set +e
  PATH="$TMP:$PATH" bash "$CFG_ROOT/scripts/open-pr.sh" "$@" >"$TMP/out" 2>"$TMP/err"
  RC=$?
  set -e
}
make_stubs "git@github.com:o/r.git"
run_cfg_openpr --title t --body b --head rad/x --no-draft
[ "$RC" -eq 1 ] || fail "config error: expected exit 1, got $RC: $(cat "$TMP/err")"
grep -qF "$CFG_REASON" "$TMP/err" || fail "config error: lookup reason not surfaced: $(cat "$TMP/err")"
grep -qF "cannot resolve the default branch" "$TMP/err" || fail "config error: missing open-pr reason: $(cat "$TMP/err")"
[ -f "$TMP/gh.argv" ] && fail "config error: gh was called: $(cat "$TMP/gh.argv")" || true
[ -f "$TMP/glab.argv" ] && fail "config error: glab was called" || true
echo "✓ config error: exit 1 with the reason, no PR opened"

# 13. Explicit --base with a broken config → lookup skipped, PR opened on that base.
make_stubs "git@github.com:o/r.git"
run_cfg_openpr --title t --body b --head rad/x --no-draft --base develop
[ "$RC" -eq 0 ] || fail "explicit --base: expected exit 0, got $RC: $(cat "$TMP/err")"
require_called "$TMP/gh.argv" "gh"
[ "$(arg_after "$TMP/gh.argv" "--base")" = "develop" ] || fail "explicit --base: base wrong: [$(arg_after "$TMP/gh.argv" "--base")]"
grep -qF "cannot resolve the default branch" "$TMP/err" && fail "explicit --base: lookup error reported" || true
echo "✓ explicit --base with a broken config: lookup skipped, PR opened on develop"

echo "ALL PASS"
