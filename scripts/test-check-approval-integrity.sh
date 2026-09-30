#!/usr/bin/env bash
# test-check-approval-integrity.sh
# Regression tests for check-approval-integrity.sh: ancestry, fingerprint,
# gate, authenticity, override, ownership + high-risk-pattern advisories, and
# merged-history cases.
# Self-contained (no external harness): builds a temp git-repo fixture plus a
# temp RAD checkout (copies of this repo's scripts/ + harness/, and a fixture
# .rad/config.yml naming the architect) and runs that checkout's script with the
# fixture as cwd — the script reads roles.architect from its OWN checkout's
# config, never this repo's. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-check-approval-integrity.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Physical path (pwd -P): cli.js runs main() only when argv[1] equals its
# realpath, and macOS mktemp dirs live under the /var -> /private/var symlink.
TMP="$(mktemp -d)"
TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

ARCH_EMAIL="arch@example.com"
EVIL_EMAIL="mallory@evil.com"

# ── Build a temp RAD checkout (scripts + harness + .rad/config.yml) ─────────────
# check-approval-integrity.sh reads roles.architect via its own checkout's
# harness/cli.js, so the fixture architect must live in THAT checkout's config.
RAD="$TMP/rad"
mkdir -p "$RAD/harness" "$RAD/.rad"
cp -R "$HERE" "$RAD/scripts"
for p in "$HERE/../harness/"*; do
  case "$(basename "$p")" in node_modules|test) ;; *) cp -R "$p" "$RAD/harness/" ;; esac
done
cat > "$RAD/.rad/config.yml" <<EOF
version: 1
platform: manual
default_branch: main
roles:
  architect:
    - ${ARCH_EMAIL}
  developers: []
  designers: []
EOF

# ── Build a temp git-repo fixture ──────────────────────────────────────────────
# main holds identical plan docs for every case feature. Each case cuts its own
# rad/<feature> branch and commits its own event log with a controlled author.
REPO="$TMP/repo"
mkdir -p "$REPO/.agents/plans"

PLAN_BODY='# Plan: t
Status: approved
Branch: rad/feature

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| src/in-scope.js | 1-2 | x |
'
for f in f1 f2 f3 f4 f6 f7 f8 f9 f10 f11; do
  printf '%s' "$PLAN_BODY" > "$REPO/.agents/plans/$f.md"
done

git -C "$REPO" init -q
git -C "$REPO" config user.email "t@t.t"
git -C "$REPO" config user.name "t"
git -C "$REPO" checkout -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "baseline"

# The real fingerprint of the (identical) plan body, via the single source of
# truth — never re-hashed here.
FP=$(node "$HERE/../harness/cli.js" plan-fingerprint "$REPO/.agents/plans/f1.md")

approved_event() {
  # approved_event <feature> <fingerprint-or-empty>
  local feature="$1" fp="$2"
  if [[ -n "$fp" ]]; then
    printf '{"feature":"%s","type":"approved","actor":"%s","role":"architect","ts":"2026-07-01T00:00:00.000Z","recordedBy":"%s","data":{"fingerprint":"%s"}}\n' \
      "$feature" "$ARCH_EMAIL" "$ARCH_EMAIL" "$fp"
  else
    printf '{"feature":"%s","type":"approved","actor":"%s","role":"architect","ts":"2026-07-01T00:00:00.000Z","recordedBy":"%s"}\n' \
      "$feature" "$ARCH_EMAIL" "$ARCH_EMAIL"
  fi
}

commit_as() {
  # commit_as <author-email> <message>
  local email="$1" msg="$2"
  git -C "$REPO" add -A
  git -C "$REPO" -c user.email="$email" -c user.name="fixture" commit -q -m "$msg"
}

run_check() {
  # run_check <work-branch> — runs the REAL script inside the fixture repo.
  # Captures exit code without tripping set -e; output goes to $TMP/out.
  local branch="$1" code
  set +e
  ( cd "$REPO" && bash "$RAD/scripts/check-approval-integrity.sh" "$branch" main ) \
    > "$TMP/out" 2>&1
  code=$?
  set -e
  echo "$code"
}

# ── Case 1: approved event, ancestor of HEAD, matching fingerprint → 0 ─────────
git -C "$REPO" checkout -q -b rad/f1 main
mkdir -p "$REPO/.agents/state/f1"
approved_event f1 "$FP" > "$REPO/.agents/state/f1/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f1"
code=$(run_check rad/f1)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 1: approved+ancestor should exit 0 (got $code)"; }
CASE1_CODE="$code"
if grep -q "non-default high-risk pattern" "$TMP/out"; then
  cat "$TMP/out"; fail "case 1: no data.highRiskPattern must print no high-risk advisory"
fi
echo "✓ case 1: approved + ancestor + matching fingerprint passes (exit 0)"

# ── Case 2: no approved event in the log → 1 ───────────────────────────────────
git -C "$REPO" checkout -q -b rad/f2 main
mkdir -p "$REPO/.agents/state/f2"
printf '{"feature":"f2","type":"planned","actor":"%s","ts":"2026-07-01T00:00:00.000Z"}\n' "$ARCH_EMAIL" \
  > "$REPO/.agents/state/f2/events.jsonl"
commit_as "$ARCH_EMAIL" "plan f2"
code=$(run_check rad/f2)
[[ "$code" -eq 1 ]] || fail "case 2: no approved event should exit 1 (got $code)"
echo "✓ case 2: missing approved event fails closed (exit 1)"

# ── Case 3: tampered fingerprint → 1 ───────────────────────────────────────────
git -C "$REPO" checkout -q -b rad/f3 main
mkdir -p "$REPO/.agents/state/f3"
approved_event f3 "0000000000000000000000000000000000000000000000000000000000000000" \
  > "$REPO/.agents/state/f3/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f3 (tampered fp)"
code=$(run_check rad/f3)
[[ "$code" -eq 1 ]] || fail "case 3: fingerprint mismatch should exit 1 (got $code)"
grep -q "fingerprint mismatch" "$TMP/out" || fail "case 3: expected fingerprint-mismatch message"
echo "✓ case 3: tampered fingerprint fails (exit 1)"

# ── Case 4: approval commit authored by a non-architect → 1 ────────────────────
git -C "$REPO" checkout -q -b rad/f4 main
mkdir -p "$REPO/.agents/state/f4"
approved_event f4 "$FP" > "$REPO/.agents/state/f4/events.jsonl"
commit_as "$EVIL_EMAIL" "approve f4 (wrong author)"
code=$(run_check rad/f4)
[[ "$code" -eq 1 ]] || fail "case 4: non-architect author should exit 1 (got $code)"
grep -q "not the configured architect" "$TMP/out" || fail "case 4: expected authenticity message"
echo "✓ case 4: non-architect approval author fails (exit 1)"

# ── Case 5: RAD_ARCHITECT_OVERRIDE accepts the case-4 author → 0 ───────────────
set +e
( cd "$REPO" && RAD_ARCHITECT_OVERRIDE="$EVIL_EMAIL" \
    bash "$RAD/scripts/check-approval-integrity.sh" rad/f4 main ) > "$TMP/out" 2>&1
code=$?
set -e
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 5: RAD_ARCHITECT_OVERRIDE should exit 0 (got $code)"; }
echo "✓ case 5: RAD_ARCHITECT_OVERRIDE wins (exit 0)"

# ── Case 6: stale owner-claimed → advisory line AND exit 0 ─────────────────────
git -C "$REPO" checkout -q -b rad/f6 main
mkdir -p "$REPO/.agents/state/f6"
{
  approved_event f6 "$FP"
  printf '{"feature":"f6","type":"owner-claimed","actor":"%s","ts":"2026-07-02T00:00:00.000Z"}\n' "$ARCH_EMAIL"
} > "$REPO/.agents/state/f6/events.jsonl"
commit_as "$ARCH_EMAIL" "approve + claim f6"
code=$(run_check rad/f6)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 6: stale claim must NOT affect exit code (got $code)"; }
grep -q "^advisory:" "$TMP/out" || fail "case 6: expected an advisory: line"
echo "✓ case 6: stale owner-claimed prints advisory and still exits 0"

# ── Case 7: approval commit reachable only via a merge → ancestry passes ───────
git -C "$REPO" checkout -q -b side/f7 main
mkdir -p "$REPO/.agents/state/f7"
approved_event f7 "$FP" > "$REPO/.agents/state/f7/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f7 on side branch"
git -C "$REPO" checkout -q -b rad/f7 main
git -C "$REPO" merge -q --no-ff -m "merge side/f7" side/f7
code=$(run_check rad/f7)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 7: merged-history approval should exit 0 (got $code)"; }
echo "✓ case 7: approval reachable via merge passes ancestry (exit 0)"

# ── Case 8: legacy approved event with no fingerprint → warn but pass ──────────
git -C "$REPO" checkout -q -b rad/f8 main
mkdir -p "$REPO/.agents/state/f8"
approved_event f8 "" > "$REPO/.agents/state/f8/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f8 (legacy, no fingerprint)"
code=$(run_check rad/f8)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 8: legacy no-fingerprint approval should exit 0 (got $code)"; }
grep -q "^warn:" "$TMP/out" || fail "case 8: expected a legacy warn line"
echo "✓ case 8: legacy approved event without fingerprint warns but passes (exit 0)"

# ── Case 9: machine-policy approval, architect-committed → 1 ──────────────────
# A severity-gate / recordedBy:policy approval must never gate, even when the
# commit that introduced it is authored by the configured architect.
git -C "$REPO" checkout -q -b rad/f9 main
mkdir -p "$REPO/.agents/state/f9"
printf '{"feature":"f9","type":"approved","actor":"severity-gate","role":"architect","ts":"2026-07-01T00:00:00.000Z","recordedBy":"policy","data":{"fingerprint":"%s"}}\n' "$FP" \
  > "$REPO/.agents/state/f9/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f9 (machine policy)"
code=$(run_check rad/f9)
[[ "$code" -eq 1 ]] || { cat "$TMP/out"; fail "case 9: machine-policy approval should exit 1 (got $code)"; }
grep -q "FAIL: approval was recorded by a machine policy, not a human architect. Failing closed." "$TMP/out" \
  || { cat "$TMP/out"; fail "case 9: expected machine-policy FAIL message"; }
echo "✓ case 9: machine-policy approval fails closed even when architect-committed (exit 1)"

# ── Case 10: gating event carries data.highRiskPattern → advisory, same exit ──
# The pattern holds regex/shell metacharacters; it must print verbatim.
HR_PATTERN='(^|[/_.-])(auth|tokens?)([/_.-]|$)'
git -C "$REPO" checkout -q -b rad/f10 main
mkdir -p "$REPO/.agents/state/f10"
printf '{"feature":"f10","type":"approved","actor":"%s","role":"architect","ts":"2026-07-01T00:00:00.000Z","recordedBy":"%s","data":{"fingerprint":"%s","highRiskPattern":"%s"}}\n' \
  "$ARCH_EMAIL" "$ARCH_EMAIL" "$FP" "$HR_PATTERN" > "$REPO/.agents/state/f10/events.jsonl"
commit_as "$ARCH_EMAIL" "approve f10 (non-default high-risk pattern)"
code=$(run_check rad/f10)
[[ "$code" -eq "$CASE1_CODE" ]] || { cat "$TMP/out"; fail "case 10: advisory must not change the exit code (got $code, want $CASE1_CODE)"; }
grep -qxF "advisory: approval recorded under a non-default high-risk pattern: ${HR_PATTERN}" "$TMP/out" \
  || { cat "$TMP/out"; fail "case 10: expected the verbatim high-risk-pattern advisory line"; }
grep -q "^PASS:" "$TMP/out" || { cat "$TMP/out"; fail "case 10: expected PASS"; }
echo "✓ case 10: data.highRiskPattern prints the verbatim advisory and still exits 0"

# ── Case 11: only the GATING (latest) approved event decides ──────────────────
# An earlier approval under a custom pattern, re-approved without one → silent.
git -C "$REPO" checkout -q -b rad/f11 main
mkdir -p "$REPO/.agents/state/f11"
{
  printf '{"feature":"f11","type":"approved","actor":"%s","role":"architect","ts":"2026-07-01T00:00:00.000Z","recordedBy":"%s","data":{"fingerprint":"old","highRiskPattern":"%s"}}\n' \
    "$ARCH_EMAIL" "$ARCH_EMAIL" "$HR_PATTERN"
  printf '{"feature":"f11","type":"approved","actor":"%s","role":"architect","ts":"2026-07-02T00:00:00.000Z","recordedBy":"%s","data":{"fingerprint":"%s"}}\n' \
    "$ARCH_EMAIL" "$ARCH_EMAIL" "$FP"
} > "$REPO/.agents/state/f11/events.jsonl"
commit_as "$ARCH_EMAIL" "approve + re-approve f11"
code=$(run_check rad/f11)
[[ "$code" -eq 0 ]] || { cat "$TMP/out"; fail "case 11: re-approval should exit 0 (got $code)"; }
if grep -q "non-default high-risk pattern" "$TMP/out"; then
  cat "$TMP/out"; fail "case 11: a superseded approval's pattern must not print an advisory"
fi
echo "✓ case 11: only the gating approved event's highRiskPattern is reported"

echo "ALL PASS"
