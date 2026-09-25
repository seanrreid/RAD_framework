#!/usr/bin/env bash
# test-rad-status.sh
# Fixture tests for rad-status.sh research visibility (#92) and the `review`
# plan-status icon. Builds a bare origin + clone, runs the real script, asserts
# on its output. Runs under bash 3.2+ (set -u safe).
#
# Usage: scripts/test-rad-status.sh   (exit 0 = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Under $HOME, not mktemp's default /var/folders: macOS resolves /var to
# /private/var, which breaks path comparisons in the scripts under test.
TMP="$(mktemp -d "${HOME}/.rad-test-status.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

REVIEW_ICON="👀"

fail() { echo "✗ $1"; exit 1; }

# Deterministic git regardless of the operator's global config.
g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

# Copies the script under test plus its helpers into a fixture repo.
install_scripts() {
  mkdir -p "$1/scripts" "$1/.claude/agents"
  cp "$HERE/rad-status.sh" "$HERE/get-default-branch.sh" "$HERE/detect-platform.sh" "$1/scripts/"
  printf '**Name:** t\ndefault_branch: main\n' > "$1/CLAUDE.md"
}

write_doc() {
  # $1 = path, $2 = Status value
  mkdir -p "$(dirname "$1")"
  printf '# Doc\n\nAuthor: t\nStatus: %s\n' "$2" > "$1"
}

# Prints one research entry's block (from its "· slug" line to the blank line).
research_block() {
  printf '%s\n' "$1" \
    | awk '/── Research \(pre-plan\)/{p=1;next} /^── /{p=0} p' \
    | awk -v s="  · $2" '$0==s{p=1} p&&/^$/{exit} p'
}

build_fixture() {
  local origin="$TMP/origin.git" work="$TMP/work"
  git init -q --bare "$origin"
  git init -q "$work"
  install_scripts "$work"
  (
    cd "$work"
    g symbolic-ref HEAD refs/heads/main
    write_doc .agents/research/base-only.md   pending-plan
    write_doc .agents/research/both.md        pending-design
    write_doc .agents/research/parked-idea.md parked
    write_doc .agents/research/odd-state.md   in-limbo
    write_doc .agents/research/README.md      pending-design
    # Consumed: a plan on base for has-plan; review-plan's plan lives only on
    # its rad/ tip; done-idea says consumed with no plan anywhere.
    write_doc .agents/research/has-plan.md    pending-design
    write_doc .agents/plans/has-plan.md       complete
    write_doc .agents/research/review-plan.md pending-plan
    write_doc .agents/research/done-idea.md   consumed
    g add -A && g commit -qm base
    g remote add origin "$origin"
    g push -q origin main

    # The #92 repro: a rad/ branch holding research but no plan file. It also
    # changes both.md, so the tip must win over the base copy.
    g checkout -qb rad/research-only
    write_doc .agents/research/tip-only.md pending-design
    write_doc .agents/research/both.md     pending-plan
    g add -A && g commit -qm research
    g push -q origin rad/research-only

    g checkout -q main
    g checkout -qb rad/review-plan
    write_doc .agents/plans/review-plan.md review
    g add -A && g commit -qm plan
    g push -q origin rad/review-plan

    g checkout -q main
    g fetch -q origin
  )
}

run_status() {
  (cd "$1" && bash scripts/rad-status.sh 2>/dev/null) || fail "rad-status.sh exited non-zero in $1"
}

build_fixture
OUT=$(run_status "$TMP/work")

printf '%s\n' "$OUT" | grep -q "── Research (pre-plan)" || fail "R0: Research (pre-plan) section missing"
echo "✓ R0: Research (pre-plan) section rendered"

b=$(research_block "$OUT" tip-only)
[[ -n "$b" ]]                                              || fail "R1: tip-only research on a plan-less rad/ branch not listed"
printf '%s\n' "$b" | grep -q "Source: rad/research-only"   || fail "R1: tip-only source is not its branch: $b"
printf '%s\n' "$b" | grep -q "Next:   /rad-design tip-only" || fail "R1: pending-design hint missing: $b"
echo "✓ R1: branch-tip-only research (no plan file) listed with /rad-design hint"

b=$(research_block "$OUT" base-only)
printf '%s\n' "$b" | grep -q "Source: main (merged)"       || fail "R2: base-only not sourced from base (inherited blob on rad/ tips must fall through): $b"
printf '%s\n' "$b" | grep -q "Next:   /rad-plan base-only" || fail "R2: pending-plan hint missing: $b"
echo "✓ R2: base-only research sourced from base with /rad-plan hint"

n=$(printf '%s\n' "$OUT" | grep -c "^  · both$" || true)
[[ "$n" == "1" ]] || fail "R3: both.md listed $n times, want exactly 1"
b=$(research_block "$OUT" both)
printf '%s\n' "$b" | grep -q "Source: rad/research-only" || fail "R3: branch tip did not win over base: $b"
printf '%s\n' "$b" | grep -q "Status: pending-plan"      || fail "R3: tip status not shown: $b"
echo "✓ R3: same slug on tip and base listed once, branch tip wins"

printf '%s\n' "$OUT" | grep -q "^  · README$" && fail "R4: research README.md should be excluded"
echo "✓ R4: research README.md excluded"

b=$(research_block "$OUT" parked-idea)
printf '%s\n' "$b" | grep -q "Status: parked" || fail "R5: parked research not listed: $b"
printf '%s\n' "$b" | grep -q "Next:"          && fail "R5: parked research must have no hint: $b"
b=$(research_block "$OUT" odd-state)
printf '%s\n' "$b" | grep -q "Status: in-limbo" || fail "R5: unknown status not listed as-is: $b"
printf '%s\n' "$b" | grep -q "Next:"            && fail "R5: unknown status must have no hint: $b"
echo "✓ R5: parked and unrecognised statuses listed without a hint"

printf '%s\n' "$OUT" | grep -q "^  $REVIEW_ICON review-plan$" || fail "R6: Status: review plan lacks the $REVIEW_ICON icon"
echo "✓ R6: Status: review plan gets the $REVIEW_ICON icon"

# Section text captured once; matched with case, not `printf | grep -q`
# (SIGPIPE under pipefail).
SECTION=$(printf '%s\n' "$OUT" | awk '/── Research \(pre-plan\)/{p=1;next} /^── /{p=0} p')
case "$SECTION" in *"· has-plan"*)    fail "R8: research with a merged plan must be hidden" ;; esac
case "$SECTION" in *"· review-plan"*) fail "R8: research with a branch-tip plan must be hidden" ;; esac
echo "✓ R8: research whose slug has a plan (any source) is hidden"
case "$SECTION" in *"· done-idea"*)   fail "R9: Status: consumed research must be hidden" ;; esac
case "$SECTION" in *"consumed)"*)     fail "R9: hidden-count line must not render while research is shown" ;; esac
echo "✓ R9: Status: consumed research (no plan) is hidden"

# All hidden: every artifact is consumed, so the hidden-count line renders.
HIDDEN="$TMP/hidden"
git init -q "$HIDDEN"
install_scripts "$HIDDEN"
write_doc "$HIDDEN/.agents/research/planned.md" pending-design
write_doc "$HIDDEN/.agents/plans/planned.md"    in-progress
write_doc "$HIDDEN/.agents/research/retired.md" consumed
OUT=$(run_status "$HIDDEN")
SECTION=$(printf '%s\n' "$OUT" | awk '/── Research \(pre-plan\)/{p=1;next} /^── /{p=0} p')
case "$SECTION" in *"(no pre-plan research; 2 consumed)"*) ;; *) fail "R10: hidden-count line missing: $SECTION" ;; esac
case "$SECTION" in *"· "*) fail "R10: no research entry should be listed: $SECTION" ;; esac
echo "✓ R10: all research hidden yields the hidden-count line"

# Empty state: a repo with no research anywhere.
EMPTY="$TMP/empty"
git init -q "$EMPTY"
install_scripts "$EMPTY"
OUT=$(run_status "$EMPTY")
printf '%s\n' "$OUT" | awk '/── Research \(pre-plan\)/{p=1;next} /^── /{p=0} p' \
  | grep -q "(no research artifacts)" || fail "R7: empty-state line missing"
echo "✓ R7: no research yields the explicit empty-state line"

echo "PASS: rad-status research visibility"
