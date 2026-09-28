#!/usr/bin/env bash
# test-plan-paths.sh
# Unit tests for the plan-paths.sh helpers added for premise-freshness-lint:
#   - plan_cited_anchors   — inline `path:NNN` anchor extraction (suffix stripped,
#                            de-duped, prose/URL noise rejected)
#   - plan_created_paths   — the CREATE-exempt Files-in-Scope path set
#   - path_exists_on_ref   — existence-only git-ref query (0 present / 1 absent /
#                            2 unresolvable ref, fail-closed), suffix stripped
# …and for gate-legibility-lints (#98):
#   - resolve_anchor_path  — bare-basename → repo-relative resolution against the
#                            tracked-file set (unique match resolves; ambiguous
#                            and unknown are silent; a git read failure returns 2)
# …and for lint-plan-file-parsing (#134):
#   - split_task_file_value — comma-separated task File: values split into paths
#                            (range-only continuations dropped, prose kept)
#   - plan_task_files / plan_scope_paths — see every path on a multi-file File: line
# …and for approval-blockers:
#   - plan_clarification_markers — live (unfenced) [NEEDS CLARIFICATION:] markers
#   - plan_high_risk_findings    — high-risk:<path> ids (default / custom / empty)
#   - plan_waivers               — `- <id>: <justification>` bullets in ## Waivers
#
# Self-contained: builds a temp git-repo fixture (git init + a local bare origin
# so `origin/main` resolves), copies
# lib/plan-paths.sh into it, commits a baseline, then sources the lib and asserts
# each helper directly. Runs under bash 3.2+ (set -euo pipefail safe).
#
# Usage: scripts/test-plan-paths.sh   (exit 0 + "ALL PASS" = all assertions pass)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "✗ $1"; exit 1; }

REPO="$TMP/repo"
ORIGIN="$TMP/origin.git"
mkdir -p "$REPO/scripts/lib" "$REPO/.agents/plans" "$REPO/src" "$REPO/pkg"
cp "$HERE/lib/plan-paths.sh" "$REPO/scripts/lib/"

# Anchor-resolution fixtures (resolve_anchor_path). Named here so the assertions
# below read against one source of truth rather than repeating literals.
UNIQUE_BASENAME="committed.js"      # exactly one tracked match → resolves
UNIQUE_RESOLVED="src/committed.js"
AMBIGUOUS_BASENAME="dup.js"         # two tracked matches → deliberately silent
UNKNOWN_BASENAME="ghost-xyz.js"     # zero tracked matches → deliberately silent
SLASH_TOKEN="foo/bar.js"            # already path-shaped → echoed unchanged
RESOLVE_ERR_LOG="$TMP/resolve-err.txt"

# A file that exists on the baseline commit — the present case for existence checks.
printf 'export const x=1\n' > "$REPO/src/committed.js"

# Two tracked files sharing a basename — the ambiguity case. A `git ls-files`
# pathspec glob crosses `/`, so both are matched by the bare basename.
printf 'export const d=1\n' > "$REPO/src/$AMBIGUOUS_BASENAME"
printf 'export const d=2\n' > "$REPO/pkg/$AMBIGUOUS_BASENAME"

# Plan A — anchor prose. Cites foo/bar.js:120 twice (dedup), plus noise that must
# NOT be emitted: an AC reference, a bare word:12 token, and a host:port URL.
cat > "$REPO/.agents/plans/anchors.md" <<'EOF'
# Plan: anchors
Status: pending-review

## Design
See foo/bar.js:120 for the extractor, and foo/bar.js:120 again to test dedup.
This mentions AC#3 and a bare word:12 token that must be ignored.
Docs live at https://example.com:80 and must not be emitted as an anchor.
EOF

# Plan B — Files-in-Scope table with one `new file` row, one `New — ...` change
# row, and one ordinary modify row. Exactly two paths are create targets.
cat > "$REPO/.agents/plans/created.md" <<'EOF'
# Plan: created
Status: pending-review

## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| `a/new-a.js` | new file | Add it |
| `b/new-b.js` | 1-20 | New — created helper |
| `c/normal.js` | 10-40 | Modify |
EOF

# Plan D — bare-basename anchors, the #98 case. Only the unique basename can be
# resolved to a repo-relative path; the ambiguous and unknown ones must vanish.
cat > "$REPO/.agents/plans/bare-anchors.md" <<EOF
# Plan: bare-anchors
Status: pending-review

## Design
Prose cites $UNIQUE_BASENAME:12 without a directory, plus $AMBIGUOUS_BASENAME:5
(two tracked matches) and $UNKNOWN_BASENAME:7 (untracked).
EOF

# Plan C — no anchors, no scope table (the empty-input edge case).
cat > "$REPO/.agents/plans/empty.md" <<'EOF'
# Plan: empty
Status: pending-review

Nothing to cite here and no scope table.
EOF

git -C "$REPO" init -q
git -C "$REPO" config user.email "t@t.t"
git -C "$REPO" config user.name "t"
git -C "$REPO" checkout -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "baseline (sources + plans)"

# Local bare origin so `origin/main` resolves, as it would for a real work branch.
git init -q --bare "$ORIGIN"
git -C "$REPO" remote add origin "$ORIGIN"
git -C "$REPO" push -q origin main

# A directory that is NOT inside any git repo, for the read-failure case. Both the
# dir and the ceiling are physical paths: git refuses to resolve symlinks in
# GIT_CEILING_DIRECTORIES, and mktemp -d hands back a symlinked path on macOS.
# The ceiling stops git's upward search, so a stray ancestor repo cannot rescue it.
NONREPO="$TMP/nonrepo"
mkdir -p "$NONREPO"
NONREPO_REAL="$(cd "$NONREPO" && pwd -P)"
NONREPO_CEILING="$(dirname "$NONREPO_REAL")"

# path_exists_on_ref shells out to git in the cwd, so run from inside the repo.
cd "$REPO"
# shellcheck disable=SC1091
. "$REPO/scripts/lib/plan-paths.sh"

# ── plan_cited_anchors: extract + strip suffix + dedup, reject prose/URL ────────
out=$(plan_cited_anchors "$REPO/.agents/plans/anchors.md")
[[ "$out" == "foo/bar.js" ]] \
  || fail "plan_cited_anchors: expected single 'foo/bar.js' (suffix stripped, deduped, noise rejected), got: [$out]"
echo "✓ plan_cited_anchors: extracts foo/bar.js:120 → foo/bar.js, dedups, ignores AC#/word:12/URL"

# ── plan_cited_anchors edge: empty plan → empty output, exit 0 (not an error) ───
if out=$(plan_cited_anchors "$REPO/.agents/plans/empty.md"); then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "plan_cited_anchors: empty plan should exit 0 (got $rc)"
[[ -z "$out" ]]   || fail "plan_cited_anchors: empty plan should print nothing (got: [$out])"
echo "✓ plan_cited_anchors: empty plan ⇒ empty output, exit 0"

# ── plan_created_paths: exactly the two CREATE-exempt paths, sorted + deduped ───
out=$(plan_created_paths "$REPO/.agents/plans/created.md")
expected=$'a/new-a.js\nb/new-b.js'
[[ "$out" == "$expected" ]] \
  || fail "plan_created_paths: expected two created paths (new file + New change), got: [$out]"
echo "✓ plan_created_paths: 'new file' row + 'New —' change row detected, modify row excluded"

# ── plan_created_paths edge: no scope table → empty output, exit 0 ──────────────
if out=$(plan_created_paths "$REPO/.agents/plans/empty.md"); then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "plan_created_paths: no scope table should exit 0 (got $rc)"
[[ -z "$out" ]]   || fail "plan_created_paths: no scope table should print nothing (got: [$out])"
echo "✓ plan_created_paths: no scope table ⇒ empty output, exit 0"

# ── path_exists_on_ref: present ⇒ 0 ────────────────────────────────────────────
if path_exists_on_ref "src/committed.js" main; then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "path_exists_on_ref: committed path on main should be 0 (got $rc)"
echo "✓ path_exists_on_ref: present path on main ⇒ 0"

# ── path_exists_on_ref: present on the resolvable origin/main ref too ───────────
if path_exists_on_ref "src/committed.js" origin/main; then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "path_exists_on_ref: committed path on origin/main should be 0 (got $rc)"
echo "✓ path_exists_on_ref: present path on origin/main ⇒ 0"

# ── path_exists_on_ref: absent path on a resolvable ref ⇒ 1 ─────────────────────
if path_exists_on_ref "src/nope.js" main; then rc=0; else rc=$?; fi
[[ "$rc" -eq 1 ]] || fail "path_exists_on_ref: absent path should be 1 (got $rc)"
echo "✓ path_exists_on_ref: absent path on main ⇒ 1"

# ── path_exists_on_ref: unresolvable ref ⇒ 2 (fail-closed, distinct from absent) ─
if path_exists_on_ref "src/committed.js" totally-bogus-ref; then rc=0; else rc=$?; fi
[[ "$rc" -eq 2 ]] || fail "path_exists_on_ref: bogus/unresolvable ref should be 2 (got $rc)"
echo "✓ path_exists_on_ref: unresolvable ref ⇒ 2 (distinct from absence)"

# ── path_exists_on_ref: :NNN anchor suffix stripped before the existence query ──
if path_exists_on_ref "src/committed.js:42" main; then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "path_exists_on_ref: :NNN suffix should be stripped before query (got $rc)"
echo "✓ path_exists_on_ref: 'src/committed.js:42' → strips :42, resolves present ⇒ 0"

# ── resolve_anchor_path: unique tracked basename ⇒ repo-relative path ───────────
if out=$(resolve_anchor_path "$UNIQUE_BASENAME"); then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "resolve_anchor_path: unique basename should exit 0 (got $rc)"
[[ "$out" == "$UNIQUE_RESOLVED" ]] \
  || fail "resolve_anchor_path: '$UNIQUE_BASENAME' should resolve to '$UNIQUE_RESOLVED', got: [$out]"
echo "✓ resolve_anchor_path: unique tracked basename ⇒ $UNIQUE_RESOLVED, exit 0"

# ── resolve_anchor_path: ambiguous basename ⇒ nothing, silently (exit 0) ────────
# Two tracked matches: a guess is worse than no signal, so no path is emitted and
# no diagnostic is raised — this is a deliberate non-answer, not a failure.
# Guard the fixture premise first: with 0 matches this case would pass vacuously.
n=$(git ls-files -- "*/$AMBIGUOUS_BASENAME" "$AMBIGUOUS_BASENAME" | wc -l | tr -d '[:space:]')
[[ "$n" -eq 2 ]] || fail "fixture: '$AMBIGUOUS_BASENAME' must have exactly 2 tracked matches (got $n)"
if out=$(resolve_anchor_path "$AMBIGUOUS_BASENAME"); then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "resolve_anchor_path: ambiguous basename should exit 0 (got $rc)"
[[ -z "$out" ]] \
  || fail "resolve_anchor_path: ambiguous '$AMBIGUOUS_BASENAME' should emit nothing, got: [$out]"
echo "✓ resolve_anchor_path: ambiguous basename (2 tracked matches) ⇒ empty output, exit 0"

# ── resolve_anchor_path: unknown basename ⇒ nothing (exit 0) ────────────────────
n=$(git ls-files -- "*/$UNKNOWN_BASENAME" "$UNKNOWN_BASENAME" | wc -l | tr -d '[:space:]')
[[ "$n" -eq 0 ]] || fail "fixture: '$UNKNOWN_BASENAME' must be untracked (got $n matches)"
if out=$(resolve_anchor_path "$UNKNOWN_BASENAME"); then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "resolve_anchor_path: unknown basename should exit 0 (got $rc)"
[[ -z "$out" ]] \
  || fail "resolve_anchor_path: untracked '$UNKNOWN_BASENAME' should emit nothing, got: [$out]"
echo "✓ resolve_anchor_path: zero tracked matches ⇒ empty output, exit 0"

# ── resolve_anchor_path: slash-bearing token ⇒ returned unchanged, no lookup ────
if out=$(resolve_anchor_path "$SLASH_TOKEN"); then rc=0; else rc=$?; fi
[[ "$rc" -eq 0 ]] || fail "resolve_anchor_path: slash-bearing token should exit 0 (got $rc)"
[[ "$out" == "$SLASH_TOKEN" ]] \
  || fail "resolve_anchor_path: '$SLASH_TOKEN' should pass through unchanged, got: [$out]"
echo "✓ resolve_anchor_path: slash-bearing token ⇒ unchanged (tracked-set lookup skipped)"

# ── resolve_anchor_path: git read failure ⇒ 2, fail-closed (NOT silent-empty) ───
# Run from outside any git repo so `git ls-files` genuinely fails. A read failure
# must be distinguishable from "unresolvable": collapsing it to empty+0 would
# silently drop a real anchor.
if out=$( cd "$NONREPO_REAL" \
          && export GIT_CEILING_DIRECTORIES="$NONREPO_CEILING" \
          && resolve_anchor_path "$UNIQUE_BASENAME" 2>"$RESOLVE_ERR_LOG" ); then rc=0; else rc=$?; fi
[[ "$rc" -eq 2 ]] || fail "resolve_anchor_path: git read failure should be 2, fail-closed (got $rc)"
[[ -z "$out" ]]   || fail "resolve_anchor_path: read failure should print no path, got: [$out]"
grep -q "resolve_anchor_path: git ls-files failed for '$UNIQUE_BASENAME'" "$RESOLVE_ERR_LOG" \
  || fail "resolve_anchor_path: read failure did not log a reason with context: [$(cat "$RESOLVE_ERR_LOG")]"
echo "✓ resolve_anchor_path: git read failure ⇒ exit 2 + stderr reason (never a silent empty)"

# ── plan_cited_anchors: bare-basename anchors resolved end-to-end ───────────────
out=$(plan_cited_anchors "$REPO/.agents/plans/bare-anchors.md")
[[ "$out" == "$UNIQUE_RESOLVED" ]] \
  || fail "plan_cited_anchors: expected only '$UNIQUE_RESOLVED' from the bare-anchor plan, got: [$out]"
echo "✓ plan_cited_anchors: bare '$UNIQUE_BASENAME:12' ⇒ $UNIQUE_RESOLVED; ambiguous/unknown dropped"

# ── plan_cited_anchors: propagates a resolve read failure as 2 (fail-closed) ────
# The filter loop runs in a command substitution, so the failure travels out as an
# in-band sentinel. A git error must never surface as "this plan cites nothing".
if out=$( cd "$NONREPO_REAL" \
          && export GIT_CEILING_DIRECTORIES="$NONREPO_CEILING" \
          && plan_cited_anchors "$REPO/.agents/plans/bare-anchors.md" 2>"$RESOLVE_ERR_LOG" ); then rc=0; else rc=$?; fi
[[ "$rc" -eq 2 ]] || fail "plan_cited_anchors: a resolve read failure should surface as 2 (got $rc)"
[[ -z "$out" ]]   || fail "plan_cited_anchors: read failure should print no anchors, got: [$out]"
grep -q "plan_cited_anchors: anchor resolution failed" "$RESOLVE_ERR_LOG" \
  || fail "plan_cited_anchors: read failure did not log a reason: [$(cat "$RESOLVE_ERR_LOG")]"
echo "✓ plan_cited_anchors: resolve read failure ⇒ exit 2, never a silent 'no anchors'"

# ── plan_cited_anchors: scheme://host URL token dropped (bash 3.2 case parse) ──
# `git+ssh://host.example/dir:2222` greps to the token `//host.example/dir:2222`,
# which is slash-bearing and would pass the directory-sep filter — only the
# `(*//*)` URL guard drops it. Guards the 3.2-safe rewrite of that guard.
URL_PLAN="$TMP/url-anchor.md"
cat > "$URL_PLAN" <<'EOF'
# Plan: url-anchor
Clone from git+ssh://host.example/dir:2222 then edit foo/bar.js:7.
EOF
out=$(plan_cited_anchors "$URL_PLAN")
[[ "$out" == "foo/bar.js" ]] \
  || fail "plan_cited_anchors: host:// URL token should be dropped, expected only 'foo/bar.js', got: [$out]"
echo "✓ plan_cited_anchors: git+ssh://host.example/dir:2222 URL token dropped; real anchor kept"

# ── split_task_file_value: comma list → one path per part (#134) ──────────────
out=$(split_task_file_value "a.js:10-20, b.test.js")
[[ "$out" == $'a.js\nb.test.js' ]] \
  || fail "split_task_file_value: 'a.js:10-20, b.test.js' should yield 2 paths, got: [$out]"
echo "✓ split_task_file_value: 'a.js:10-20, b.test.js' ⇒ a.js + b.test.js"

out=$(split_task_file_value "a.js, b.js:10, c.md:1-2")
[[ "$out" == $'a.js\nb.js\nc.md' ]] \
  || fail "split_task_file_value: mixed-suffix 3-file list should yield 3 paths, got: [$out]"
echo "✓ split_task_file_value: bare / :N / :N-M suffixes ⇒ 3 stripped paths"

out=$(split_task_file_value '`a.js`:5')
[[ "$out" == "a.js" ]] \
  || fail "split_task_file_value: backticked '\`a.js\`:5' should yield 'a.js', got: [$out]"
echo "✓ split_task_file_value: backticks stripped before the :lines suffix"

# ── split_task_file_value edges: placeholder, trailing comma, empty ─────────────
out=$(split_task_file_value "[path]")
[[ -z "$out" ]] || fail "split_task_file_value: '[path]' placeholder should emit nothing, got: [$out]"
out=$(split_task_file_value "a.js, ")
[[ "$out" == "a.js" ]] || fail "split_task_file_value: trailing comma should add nothing, got: [$out]"
out=$(split_task_file_value "")
[[ -z "$out" ]] || fail "split_task_file_value: empty value should emit nothing, got: [$out]"
echo "✓ split_task_file_value: [path], trailing comma, empty value ⇒ nothing extra"

# ── split_task_file_value: range-only parts continue the previous path ──────────
out=$(split_task_file_value "harness/events.js:16-33, 80-96")
[[ "$out" == "harness/events.js" ]] \
  || fail "split_task_file_value: range continuation '80-96' must not become a path, got: [$out]"
out=$(split_task_file_value "git-state-store.js:78-80, 98-100, 362-432")
[[ "$out" == "git-state-store.js" ]] \
  || fail "split_task_file_value: multi-range continuation must yield one path, got: [$out]"
echo "✓ split_task_file_value: 'events.js:16-33, 80-96' ⇒ events.js only (ranges dropped)"

# ── split_task_file_value: comma-free value == strip_task_file_lines ────────────
for v in "src/committed.js:42" "harness/cli.js:290-410" "docs/plain.md"; do
  [[ "$(split_task_file_value "$v")" == "$(strip_task_file_lines "$v")" ]] \
    || fail "split_task_file_value: comma-free '$v' must equal strip_task_file_lines output"
done
echo "✓ split_task_file_value: comma-free value ⇒ identical to strip_task_file_lines"

# ── split_task_file_value: prose kept as one part (fail closed toward not-low) ──
out=$(split_task_file_value "tests in x.js")
[[ "$out" == "tests in x.js" ]] \
  || fail "split_task_file_value: prose value must be kept as one part, got: [$out]"
echo "✓ split_task_file_value: prose 'tests in x.js' kept as one part"

# ── plan_task_files / plan_scope_paths: second File: entry reaches the union ───
MULTI_PLAN="$TMP/multi-file.md"
cat > "$MULTI_PLAN" <<'EOF'
# Plan: multi-file
## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| `a/first.js` | 1-10 | Modify |

#### Task 1.1: Two files on one line
File: a/first.js:1-10, b/second-only.test.js
EOF
out=$(plan_task_files "$MULTI_PLAN")
[[ "$out" == $'a/first.js\nb/second-only.test.js' ]] \
  || fail "plan_task_files: expected both File: entries, got: [$out]"
out=$(plan_scope_paths "$MULTI_PLAN")
printf '%s\n' "$out" | grep -Fxq "b/second-only.test.js" \
  || fail "plan_scope_paths: path appearing only as a second task-File entry is missing: [$out]"
echo "✓ plan_scope_paths: includes b/second-only.test.js (second task-File entry only)"

# ── Approval blockers (approval-blockers): markers / findings / waivers ─────────
TAB=$'\t'
MARKER_PLAN="$TMP/markers.md"
cat > "$MARKER_PLAN" <<'PLAN'
# Plan: markers
Outside [NEEDS CLARIFICATION: which store?] here.
```
Fenced [NEEDS CLARIFICATION: not me] line.
```
After [NEEDS CLARIFICATION: after fence] line.
Two [NEEDS CLARIFICATION: first] and [NEEDS CLARIFICATION: second] markers.
Empty [NEEDS CLARIFICATION:] question.
Span `[NEEDS CLARIFICATION: in span]` only.
Mixed `[NEEDS CLARIFICATION: spanned]` and [NEEDS CLARIFICATION: plain] here.
Unpaired ` then [NEEDS CLARIFICATION: after unpaired] counts.
Double ``[NEEDS CLARIFICATION: in double span]`` and ```` ``` ```` then [NEEDS CLARIFICATION: after quad] counts.
PLAN
out=$(plan_clarification_markers "$MARKER_PLAN")
expected="2${TAB}which store?
6${TAB}after fence
7${TAB}first
7${TAB}second
8${TAB}
10${TAB}plain
11${TAB}after unpaired
12${TAB}after quad"
[[ "$out" == "$expected" ]] \
  || fail "plan_clarification_markers: unexpected output: [$out]"
echo "✓ plan_clarification_markers: outside / after-fence / two-per-line / empty reported; fenced skipped"
echo "✓ plan_clarification_markers: inline-span marker skipped; plain marker beside a span reported"
echo "✓ plan_clarification_markers: marker after an unpaired backtick reported; N-backtick runs close only on N"

NO_MARKER_PLAN="$TMP/no-markers.md"
printf '# Plan\nNothing to clarify.\n```\n[NEEDS CLARIFICATION: fenced only]\n```\n' > "$NO_MARKER_PLAN"
out=$(plan_clarification_markers "$NO_MARKER_PLAN")
[[ -z "$out" ]] || fail "plan_clarification_markers: no live markers should print nothing, got: [$out]"
echo "✓ plan_clarification_markers: no markers (or fenced only) ⇒ empty, exit 0"

RISK_PLAN="$TMP/risk.md"
cat > "$RISK_PLAN" <<'PLAN'
# Plan: risk
## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| `src/auth/login.js` | 1-10 | Modify |
| `docs/readme.md` | 1 | Modify |

#### Task 1.1: t
File: src/auth/login.js:1-10, lib/widget.js
PLAN
out=$(unset RAD_HIGH_RISK_PATTERNS; plan_high_risk_findings "$RISK_PLAN")
[[ "$out" == "high-risk:src/auth/login.js" ]] \
  || fail "plan_high_risk_findings: default pattern should flag auth path once, got: [$out]"
echo "✓ plan_high_risk_findings: unset env ⇒ built-in default, de-duplicated"

out=$(RAD_HIGH_RISK_PATTERNS='widget|readme' plan_high_risk_findings "$RISK_PLAN")
[[ "$out" == $'high-risk:docs/readme.md\nhigh-risk:lib/widget.js' ]] \
  || fail "plan_high_risk_findings: custom pattern mismatch, got: [$out]"
echo "✓ plan_high_risk_findings: custom RAD_HIGH_RISK_PATTERNS honored"

out=$(RAD_HIGH_RISK_PATTERNS='' plan_high_risk_findings "$RISK_PLAN")
[[ "$out" == "high-risk:src/auth/login.js" ]] \
  || fail "plan_high_risk_findings: empty pattern must fall back to the default, got: [$out]"
[[ "$(RAD_HIGH_RISK_PATTERNS='' plan_high_risk_pattern)" == "$RAD_HIGH_RISK_DEFAULT_PATTERN" ]] \
  || fail "plan_high_risk_pattern: empty RAD_HIGH_RISK_PATTERNS must print the default"
echo "✓ plan_high_risk_findings: empty RAD_HIGH_RISK_PATTERNS ⇒ built-in default (never disabled)"

out=$(RAD_HIGH_RISK_PATTERNS='no-such-path-zzz' plan_high_risk_findings "$RISK_PLAN")
[[ -z "$out" ]] || fail "plan_high_risk_findings: narrowed non-matching pattern should flag nothing, got: [$out]"
echo "✓ plan_high_risk_findings: narrowed pattern matching nothing ⇒ empty"

WAIVER_PLAN="$TMP/waivers.md"
cat > "$WAIVER_PLAN" <<'PLAN'
# Plan: waivers
- high-risk:outside/section.js: not in the section
## Waivers
- high-risk:src/auth/login.js: reviewed by security
- high-risk:empty.js:
- high-risk:colon.js: reason: with a colon
not a bullet: ignored
## Next
- high-risk:after/next.js: past the section
PLAN
out=$(plan_waivers "$WAIVER_PLAN")
expected="high-risk:src/auth/login.js${TAB}reviewed by security
high-risk:colon.js${TAB}reason: with a colon"
[[ "$out" == "$expected" ]] || fail "plan_waivers: unexpected output: [$out]"
echo "✓ plan_waivers: valid kept, empty justification dropped, first ': ' split, section ends at next ##"

out=$(plan_waivers "$RISK_PLAN")
[[ -z "$out" ]] || fail "plan_waivers: no ## Waivers section should print nothing, got: [$out]"
echo "✓ plan_waivers: no section ⇒ empty, exit 0"

for fn in plan_clarification_markers plan_high_risk_findings plan_waivers; do
  if "$fn" "$TMP/does-not-exist.md" 2>"$TMP/err.txt"; then
    fail "$fn: missing plan file must return non-zero"
  fi
  grep -q "missing or unreadable" "$TMP/err.txt" || fail "$fn: missing plan must explain on stderr"
done
echo "✓ blocker helpers: missing plan file ⇒ non-zero + stderr message"

echo "ALL PASS"
