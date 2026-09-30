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

# rad-status.sh finds harness/cli.js beside its own scripts dir. Copied, not
# symlinked: cli.js only runs as main when argv[1] is its real path. node_modules
# (large, resolved via realpath) and the test suite are linked/skipped.
install_harness() {
  local src="$HERE/../harness" entry
  mkdir -p "$1/harness"
  for entry in "$src"/*; do
    case "$(basename "$entry")" in
      node_modules|test) ;;
      *) cp -R "$entry" "$1/harness/" ;;
    esac
  done
  [[ -d "$src/node_modules" ]] && ln -s "$src/node_modules" "$1/harness/node_modules"
  return 0
}

# Copies the script under test plus its helpers, harness/ (the config reader),
# and a .rad/config.yml declaring default_branch: main into a fixture repo.
install_scripts() {
  mkdir -p "$1/scripts" "$1/.claude/agents" "$1/.rad"
  cp "$HERE/rad-status.sh" "$HERE/get-default-branch.sh" "$HERE/detect-platform.sh" "$1/scripts/"
  printf '**Name:** t\n' > "$1/CLAUDE.md"
  printf 'version: 1\nplatform: manual\ndefault_branch: main\nroles:\n  architect:\n    - arch@example.com\n' \
    > "$1/.rad/config.yml"
  install_harness "$1"
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

# Prints the Active Plans section body (header excluded).
plans_section() {
  printf '%s\n' "$1" | awk '/── Active Plans/{p=1;next} /^── /{p=0} p'
}

# Prints one plan row's block: its "  <icon> slug" header line up to the next
# row header. Not "up to the blank line": a zero-count Waves/Tasks field can
# render across lines and break the block early.
plan_block() {
  printf '%s\n' "$1" | awk -v s="$2" '/^  [^ ]/{if(p)exit; if($NF==s)p=1} p'
}

# Counts plan-row header lines for a slug ("  <icon> slug") in a plans section.
plan_row_count() {
  printf '%s\n' "$1" | awk -v s="$2" '/^  [^ ]/ && $NF==s {n++} END{print n+0}'
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

    # In-flight plan on its rad/ tip AND an unpushed local copy: the tip wins.
    g checkout -q main
    g checkout -qb rad/in-flight
    write_doc .agents/plans/in-flight.md in-progress
    g add -A && g commit -qm plan
    g push -q origin rad/in-flight

    g checkout -q main
    write_doc .agents/plans/in-flight.md pending-review
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

# Plan de-dup (#132): has-plan is committed on main (so on origin/main AND in the
# local tree). Sections are captured once and counted, not `printf | grep -q`.
PLANS_OUT=$(plans_section "$OUT")
n=$(plan_row_count "$PLANS_OUT" has-plan)
[[ "$n" == "1" ]] || fail "R11: has-plan listed $n times in Active Plans, want exactly 1: $PLANS_OUT"
b=$(plan_block "$PLANS_OUT" has-plan)
case "$b" in *"Branch: main (merged)"*) ;; *) fail "R11: has-plan not credited to base: $b" ;; esac
case "$b" in *"local (unpushed)"*) fail "R11: has-plan credited to the local tree: $b" ;; esac
echo "✓ R11: plan on base + local tree listed once, as main (merged)"

n=$(plan_row_count "$PLANS_OUT" in-flight)
[[ "$n" == "1" ]] || fail "R12: in-flight listed $n times in Active Plans, want exactly 1: $PLANS_OUT"
b=$(plan_block "$PLANS_OUT" in-flight)
case "$b" in *"Branch: rad/in-flight"*) ;; *) fail "R12: in-flight not credited to its branch tip: $b" ;; esac
case "$b" in *"Status: in-progress"*) ;; *) fail "R12: tip status not shown: $b" ;; esac
echo "✓ R12: plan on rad/ tip + local tree listed once, branch tip wins"

n=$(plan_row_count "$PLANS_OUT" research-only)
[[ "$n" == "0" ]] || fail "R13: plan-less rad/ tip rendered a phantom plan row: $PLANS_OUT"
n=$(plan_row_count "$PLANS_OUT" 0)
[[ "$n" == "0" ]] || fail "R13: a zero Waves/Tasks count split a row into phantom '0' rows: $PLANS_OUT"
echo "✓ R13: no phantom plan rows (plan-less rad/ tip, zero-count plans)"

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

# ── Dormant runs (needs a decision) ──────────────────────────────────────────

DORMANT_HEADER="── Dormant Runs (needs a decision)"
STOP_DATA='{"class":"needs-decision","reason":"token-budget","decision":"token budget 100 reached (spent 120); raise RAD_TOKEN_BUDGET or stop","wave":2}'
FAILED_DATA='{"class":"failed","reason":"attempts-exhausted","decision":"fix the failing wave","wave":1}'

# Prints one event line in the real event shape (feature, type, actor, ts, data).
event_line() {
  # $1 = feature, $2 = type, $3 = data JSON
  printf '{"feature":"%s","type":"%s","actor":"t","ts":"2026-09-29T00:00:00.000Z","data":%s}\n' "$1" "$2" "$3"
}

# Pushes rad/<feature> with a plan and (optionally) an events.jsonl whose
# content is read from stdin. Run inside the dormant fixture's work tree.
push_feature() {
  # $1 = feature, $2 = "log" to commit stdin as its events.jsonl
  g checkout -q main
  g checkout -qb "rad/$1"
  write_doc ".agents/plans/$1.md" in-progress
  if [[ "${2:-}" == "log" ]]; then
    mkdir -p ".agents/state/$1"
    cat > ".agents/state/$1/events.jsonl"
  fi
  g add -A && g commit -qm "$1"
  g push -q origin "rad/$1"
}


# Prints the Dormant Runs section body (header excluded).
dormant_section() {
  printf '%s\n' "$1" | awk -v h="$DORMANT_HEADER" 'index($0,h)==1{p=1;next} /^── /{p=0} p'
}

# No log anywhere in the main fixture: the header must not render at all.
OUT=$(run_status "$TMP/work")
case "$OUT" in *"$DORMANT_HEADER"*) fail "D1: Dormant Runs header rendered with no dormant run: $OUT" ;; esac
echo "✓ D1: no dormant run → no Dormant Runs section header"

DORM="$TMP/dormant"
DORM_ORIGIN="$TMP/dormant-origin.git"
git init -q --bare "$DORM_ORIGIN"
git init -q "$DORM"
install_scripts "$DORM"
(
  cd "$DORM"
  g symbolic-ref HEAD refs/heads/main
  g add -A && g commit -qm base
  g remote add origin "$DORM_ORIGIN"
  g push -q origin main
  { event_line parked deliver-started '{}'; event_line parked deliver-stopped "$STOP_DATA"; } \
    | push_feature parked log
  { event_line failed-run deliver-started '{}'; event_line failed-run deliver-stopped "$FAILED_DATA"; } \
    | push_feature failed-run log
  { event_line resumed deliver-stopped "$STOP_DATA"; event_line resumed deliver-started '{}'; } \
    | push_feature resumed log
  { event_line corrupt deliver-stopped "$STOP_DATA"; echo 'not json at all'; } \
    | push_feature corrupt log
  push_feature no-log
  g checkout -q main
  g fetch -q origin
)
(cd "$DORM" && bash scripts/rad-status.sh >"$TMP/dormant.out" 2>"$TMP/dormant.err") \
  || fail "D5: rad-status.sh exited non-zero on a corrupt event log: $(cat "$TMP/dormant.err")"
OUT=$(cat "$TMP/dormant.out")
ERR=$(cat "$TMP/dormant.err")
SECTION=$(dormant_section "$OUT")

case "$OUT" in *"$DORMANT_HEADER"*) ;; *) fail "D2: Dormant Runs section missing: $OUT" ;; esac
case "$SECTION" in *"⏸ parked"*) ;; *) fail "D2: needs-decision run not listed: $SECTION" ;; esac
case "$SECTION" in *"Stopped:  token-budget (wave 2)"*) ;; *) fail "D2: reason/wave missing: $SECTION" ;; esac
case "$SECTION" in *"Decision: token budget 100 reached (spent 120); raise RAD_TOKEN_BUDGET or stop"*) ;;
  *) fail "D2: decision missing: $SECTION" ;; esac
case "$SECTION" in *'rad deliver parked --resume --context "<what you decided>"'*) ;;
  *) fail "D2: resume hint missing: $SECTION" ;; esac
header_line=$(printf '%s\n' "$OUT" | grep -n "^$DORMANT_HEADER" | cut -d: -f1)
plans_line=$(printf '%s\n' "$OUT" | grep -n "^── Active Plans" | cut -d: -f1)
[[ "$header_line" -lt "$plans_line" ]] || fail "D2: Dormant Runs must render before Active Plans"
echo "✓ D2: needs-decision stop listed before Active Plans with reason, decision, and resume hint"

case "$SECTION" in *"failed-run"*) fail "D3: failed-class stop must not be dormant: $SECTION" ;; esac
echo "✓ D3: failed-class stop is not listed as dormant"

case "$SECTION" in *"resumed"*) fail "D4: stop followed by deliver-started must not be dormant: $SECTION" ;; esac
echo "✓ D4: needs-decision stop picked up by a later deliver-started is not dormant"

case "$ERR" in *"warning: stop-status corrupt: "*"malformed event log"*) ;;
  *) fail "D5: corrupt log did not warn naming the feature: $ERR" ;; esac
case "$SECTION" in *"corrupt"*) fail "D5: corrupt log must not render as dormant: $SECTION" ;; esac
case "$ERR" in *"no-log"*) fail "D6: a tip without an event log must be skipped silently: $ERR" ;; esac
echo "✓ D5: corrupt event log warns naming the feature and the run exits 0"
echo "✓ D6: plan tip with no event log is skipped silently"

echo "PASS: rad-status research visibility + dormant runs"
