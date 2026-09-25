#!/usr/bin/env bash
# test-rad-label.sh
# Behavior tests for scripts/rad-label.sh with a stubbed `gh` on PATH:
#   (a) one stale status present → only that status is removed, new one added
#   (b) no status labels present → no --remove-label at all
#   (c) swap edit fails → add-only fallback, WARN naming target + gh error, exit 0,
#       and NO plain success line
#   (e) label read fails → add-only edit, WARN quoting the read error, exit 0
#   (d) gh unauthenticated / absent → existing no-op (exit 0, no edit attempted)
# The stub logs every `gh issue edit` argv to its own file so assertions read the
# exact arguments. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-rad-label.sh   (exit 0 + "ALL PASS" = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/rad-label.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

STUB_DIR="$TMP/bin"
STUB_ERR_TEXT="HTTP 422: stub refused label removal"
STUB_VIEW_ERR="HTTP 404: stub could not read issue"
TARGET_NUM="42"

# Stub switches (env): GH_STUB_AUTH_FAIL=1 fails `gh auth status`;
# GH_STUB_LABELS = newline-separated labels `issue view` reports;
# GH_STUB_EDIT_FAIL=1 fails any `issue edit` carrying --remove-label;
# GH_STUB_VIEW_FAIL=1 fails `issue view` (the current-label read).
make_stub() {
  mkdir -p "$STUB_DIR"
  cat > "$STUB_DIR/gh" <<EOF
#!/bin/sh
LOG="$TMP/log"
echo "\$1 \$2" >> "\$LOG/calls"
case "\$1 \$2" in
  "auth status") [ "\${GH_STUB_AUTH_FAIL:-}" = 1 ] && exit 1; exit 0 ;;
  "label create") exit 1 ;;   # "already exists" — the expected failure
  "issue view")
    if [ "\${GH_STUB_VIEW_FAIL:-}" = 1 ]; then echo "$STUB_VIEW_ERR" >&2; exit 1; fi
    printf '%s\n' "\${GH_STUB_LABELS:-}"; exit 0 ;;
  "issue edit")
    # grep -c prints 0 AND exits 1 before the first edit; the count is still valid.
    n=\$(ls "\$LOG" | grep -c '^edit\.' || true)
    f="\$LOG/edit.\$((n + 1))"
    for a in "\$@"; do printf '%s\n' "\$a" >> "\$f"; done
    if [ "\${GH_STUB_EDIT_FAIL:-}" = 1 ] && grep -qx -- '--remove-label' "\$f"; then
      echo "$STUB_ERR_TEXT" >&2; exit 1
    fi
    exit 0 ;;
esac
echo "gh stub: unexpected call: \$*" >&2; exit 99
EOF
  chmod +x "$STUB_DIR/gh"
}

# Run rad-label.sh with the stub first on PATH; stdout/stderr/exit captured.
run_label() {
  rm -rf "$TMP/log"; mkdir -p "$TMP/log"
  set +e
  PATH="$STUB_DIR:$PATH" bash "$SCRIPT" "$TARGET_NUM" "$1" >"$TMP/out" 2>"$TMP/err"
  CODE=$?
  set -e
}

# Guard against a false green from a stub that never engaged.
require_edit_called() {
  [[ -f "$TMP/log/edit.1" ]] || fail "$1: gh issue edit was not invoked (stub not engaged?)"
}

make_stub
[[ "$(PATH="$STUB_DIR:$PATH" command -v gh)" == "$STUB_DIR/gh" ]] \
  || fail "setup: stub gh is not first on PATH"

# (a) one stale present status → remove exactly it, add the new one.
GH_STUB_LABELS=$'bug\nrad:approved' run_label in-progress
[[ "$CODE" -eq 0 ]] || fail "a: expected exit 0 (got $CODE): $(cat "$TMP/err")"
require_edit_called "a"
E1="$TMP/log/edit.1"
grep -qxF -- "rad:approved" "$E1"     || fail "a: stale rad:approved not removed: [$(cat "$E1")]"
grep -qxF -- "rad:in-progress" "$E1"  || fail "a: rad:in-progress not added: [$(cat "$E1")]"
[[ "$(grep -cxF -- '--remove-label' "$E1")" -eq 1 ]] \
  || fail "a: expected exactly one --remove-label: [$(cat "$E1")]"
[[ "$(awk 'p=="--remove-label"{print} {p=$0}' "$E1")" == "rad:approved" ]] \
  || fail "a: --remove-label value should be rad:approved: [$(cat "$E1")]"
[[ "$(awk 'p=="--add-label"{print} {p=$0}' "$E1")" == "rad:in-progress" ]] \
  || fail "a: --add-label value should be rad:in-progress: [$(cat "$E1")]"
grep -qxF -- "rad:draft" "$E1" && fail "a: absent rad:draft passed to edit: [$(cat "$E1")]"
[[ ! -f "$TMP/log/edit.2" ]] || fail "a: unexpected fallback edit on a successful swap"
grep -qxF "#${TARGET_NUM} → rad:in-progress" "$TMP/out" || fail "a: success line missing"
echo "✓ a: stale present status removed, absent statuses untouched, new status added"

# (b) no status labels present → no --remove-label passed.
GH_STUB_LABELS=$'bug\nenhancement' run_label review
[[ "$CODE" -eq 0 ]] || fail "b: expected exit 0 (got $CODE)"
require_edit_called "b"
grep -qxF -- "--remove-label" "$TMP/log/edit.1" \
  && fail "b: --remove-label passed with no status labels present: [$(cat "$TMP/log/edit.1")]"
grep -qxF "#${TARGET_NUM} → rad:review" "$TMP/out" || fail "b: success line missing"
echo "✓ b: no status labels present → no --remove-label"

# (c) swap fails → add-only fallback succeeds → WARN, exit 0, no success line.
GH_STUB_EDIT_FAIL=1 GH_STUB_LABELS='rad:approved' run_label in-progress
[[ "$CODE" -eq 0 ]] || fail "c: expected exit 0 on fallback (got $CODE)"
require_edit_called "c"
[[ -f "$TMP/log/edit.2" ]] || fail "c: add-only fallback edit was not attempted"
grep -qxF -- "--remove-label" "$TMP/log/edit.2" && fail "c: fallback must be add-only"
grep -qF "WARN: added rad:in-progress to #${TARGET_NUM}" "$TMP/err" \
  || fail "c: WARN naming the target missing: [$(cat "$TMP/err")]"
grep -qF "$STUB_ERR_TEXT" "$TMP/err" || fail "c: WARN lacks the gh error text: [$(cat "$TMP/err")]"
grep -qF "#${TARGET_NUM} → " "$TMP/out" && fail "c: plain success line printed despite failed removal"
echo "✓ c: failed swap → add-only fallback, WARN with target + gh error, exit 0"

# (e) label read fails → no removals, add succeeds, WARN quotes the read error.
GH_STUB_VIEW_FAIL=1 run_label done
[[ "$CODE" -eq 0 ]] || fail "e: expected exit 0 (got $CODE)"
require_edit_called "e"
grep -qxF -- "--remove-label" "$TMP/log/edit.1" && fail "e: removals passed despite failed label read"
grep -qF "WARN: added rad:done to #${TARGET_NUM}" "$TMP/err" \
  || fail "e: WARN naming the target missing: [$(cat "$TMP/err")]"
grep -qF "$STUB_VIEW_ERR" "$TMP/err" || fail "e: WARN lacks the read error: [$(cat "$TMP/err")]"
grep -qF "#${TARGET_NUM} → " "$TMP/out" && fail "e: plain success line printed despite unread labels"
echo "✓ e: failed label read → add-only, WARN with read error, exit 0"

# (d1) gh unauthenticated → no-op, no edit attempted.
GH_STUB_AUTH_FAIL=1 run_label approved
[[ "$CODE" -eq 0 ]] || fail "d: unauthenticated gh should exit 0 (got $CODE)"
grep -qx "auth status" "$TMP/log/calls" || fail "d: stub not engaged (auth status never called)"
[[ ! -f "$TMP/log/edit.1" ]] || fail "d: edit attempted despite failed auth"
grep -qF "gh unavailable" "$TMP/out" || fail "d: no-op message missing"
echo "✓ d: unauthenticated gh → no-op, exit 0"

# (d2) no gh on PATH at all → same no-op. PATH is an EMPTY dir, not system dirs:
# CI runners ship a real gh in /usr/bin. rad-label.sh reaches its gh check using
# builtins only, so an empty PATH is sufficient; the guard proves gh is absent.
NOGH_PATH="$TMP/nogh-bin"
mkdir -p "$NOGH_PATH"
if PATH="$NOGH_PATH" command -v gh >/dev/null 2>&1; then
  fail "d: gh resolvable on empty PATH $NOGH_PATH — cannot exercise the absent-gh case"
fi
set +e
out=$(PATH="$NOGH_PATH" /bin/bash "$SCRIPT" "$TARGET_NUM" approved 2>&1)
code=$?
set -e
[[ "$code" -eq 0 ]] || fail "d: absent gh should exit 0 (got $code): [$out]"
[[ "$out" == *"gh unavailable"* ]] || fail "d: absent-gh no-op message missing: [$out]"
echo "✓ d: gh absent from PATH → no-op, exit 0"

echo "ALL PASS"
