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
#   - plan_waivers_section       — fence-free raw ## Waivers body (fenced
#                                  headings/bullets never count)
# …and for vertical-slices-and-mockups:
#   - plan_wave_task_files — `<wave>\t<path>` per task File: path under ### Wave N
#   - path_layer           — one-word layer classification in fixed precedence
#   - plan_mockup_refs     — unfenced .agents/mockups/*.html|.htm refs, first-seen
# …and for light-planning-tier:
#   - plan_tier             — header-block Tier: value (absent ⇒ standard)
#   - plan_playbook         — header-block Playbook: value (absent ⇒ empty output)
#   - plan_light_violations — light-tier: <reason> per exceeded light bound
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

FENCED_WAIVER_PLAN="$TMP/fenced-waivers.md"
cat > "$FENCED_WAIVER_PLAN" <<'PLAN'
# Plan: fenced waivers
```markdown
## Waivers
- high-risk:fenced/heading.js: inside a fenced example section
```
## Waivers
- high-risk:real/one.js: real before fence
```
- high-risk:fenced/bullet.js: fenced inside the real section
## Foo
```
- high-risk:real/two.js: real after fenced heading
## Next
- high-risk:after/next.js: past the section
PLAN
out=$(plan_waivers "$FENCED_WAIVER_PLAN")
expected="high-risk:real/one.js${TAB}real before fence
high-risk:real/two.js${TAB}real after fenced heading"
[[ "$out" == "$expected" ]] || fail "plan_waivers: fence handling wrong: [$out]"
echo "✓ plan_waivers: fenced ## Waivers ignored, fenced bullets ignored, fenced ## Foo does not end the section"

out=$(plan_waivers_section "$FENCED_WAIVER_PLAN")
expected="- high-risk:real/one.js: real before fence
- high-risk:real/two.js: real after fenced heading"
[[ "$out" == "$expected" ]] || fail "plan_waivers_section: fenced content leaked: [$out]"
echo "✓ plan_waivers_section: raw body carries no fence lines or fenced content"

FENCE_ONLY_PLAN="$TMP/fence-only-waivers.md"
printf '# Plan\n```\n## Waivers\n- high-risk:x.js: example\n```\n' > "$FENCE_ONLY_PLAN"
out=$(plan_waivers "$FENCE_ONLY_PLAN")
[[ -z "$out" ]] || fail "plan_waivers: a fenced-only ## Waivers must yield nothing, got: [$out]"
echo "✓ plan_waivers: ## Waivers only inside a fence ⇒ empty, exit 0"

for fn in plan_clarification_markers plan_high_risk_findings plan_waivers plan_waivers_section; do
  if "$fn" "$TMP/does-not-exist.md" 2>"$TMP/err.txt"; then
    fail "$fn: missing plan file must return non-zero"
  fi
  grep -q "missing or unreadable" "$TMP/err.txt" || fail "$fn: missing plan must explain on stderr"
done
echo "✓ blocker helpers: missing plan file ⇒ non-zero + stderr message"


# ── plan_wave_task_files: per-wave File: paths ──────────────────────────────
WAVE_PLAN="$TMP/waves.md"
cat > "$WAVE_PLAN" <<'PLAN'
# Plan: waves
File: before/any-wave.js
## Wave Plan
### Wave 1
#### Task 1.1: two files
File: db/migrations/001.sql:1-20, src/models/user.js:5, 80-96
#### Task 1.2: placeholder
File: [path]
### Wave 2: services
#### Task 2.1
File: `src/services/billing.js`
### Wave
File: unnumbered/wave.js
### Wave 12
File: src/components/Button.tsx
## Acceptance Criteria
File: after/wave-plan.js
PLAN
out=$(plan_wave_task_files "$WAVE_PLAN")
expected="1${TAB}db/migrations/001.sql
1${TAB}src/models/user.js
2${TAB}src/services/billing.js
12${TAB}src/components/Button.tsx"
[[ "$out" == "$expected" ]] || fail "plan_wave_task_files: unexpected output: [$out]"
echo "✓ plan_wave_task_files: multi-file lines split per wave; pre-wave, unnumbered-wave and post-section File: lines ignored"

NOWAVE_PLAN="$TMP/nowaves.md"
printf '# Plan\nFile: src/a.js\n#### Task 1.1\nFile: src/b.js\n' > "$NOWAVE_PLAN"
out=$(plan_wave_task_files "$NOWAVE_PLAN")
[[ -z "$out" ]] || fail "plan_wave_task_files: no waves should print nothing, got: [$out]"
echo "✓ plan_wave_task_files: no waves ⇒ empty, exit 0"

# ── path_layer: one word per path, fixed precedence ─────────────────────────
check_layer() {
  local got
  got=$(path_layer "$1")
  [[ "$got" == "$2" ]] || fail "path_layer '$1': expected $2, got [$got]"
}
check_layer db/migrations/001.sql schema
check_layer prisma/app.prisma schema
check_layer src/api/users.js api
check_layer api/openapi.yaml api
check_layer src/components/Button.tsx ui
check_layer src/styles/main.css ui
check_layer src/services/billing.js service
check_layer src/services/billing.test.js test
check_layer tests/unit/billing.js test
check_layer src/components/api/Button.tsx api
check_layer db/migrations/001.test.sql test
check_layer harness/cli.js unknown
check_layer scripts/x.sh unknown
check_layer docs/a.md unknown
check_layer "" unknown
echo "✓ path_layer: each layer classified, precedence test > schema > api > ui > service, RAD paths unknown"

# ── plan_mockup_refs: unfenced refs, backticks count, first-seen dedup ──────
MOCKUP_PLAN="$TMP/mockups.md"
cat > "$MOCKUP_PLAN" <<'PLAN'
# Plan: mockups
See `.agents/mockups/zeta.html` and .agents/mockups/alpha.htm for layout.
```
.agents/mockups/fenced.html is an example only
```
Again `.agents/mockups/zeta.html`, plus .agents/mockups/notes.md (not html).
PLAN
out=$(plan_mockup_refs "$MOCKUP_PLAN")
expected=".agents/mockups/zeta.html
.agents/mockups/alpha.htm"
[[ "$out" == "$expected" ]] || fail "plan_mockup_refs: unexpected output: [$out]"
echo "✓ plan_mockup_refs: backticked ref counted, .htm accepted, fenced ref ignored, duplicates collapsed in first-seen order"

out=$(plan_mockup_refs "$NOWAVE_PLAN")
[[ -z "$out" ]] || fail "plan_mockup_refs: no refs should print nothing, got: [$out]"
echo "✓ plan_mockup_refs: no refs ⇒ empty, exit 0"

for fn in plan_wave_task_files plan_mockup_refs; do
  if "$fn" "$TMP/does-not-exist.md" 2>"$TMP/err.txt"; then
    fail "$fn: missing plan file must return non-zero"
  fi
  grep -q "missing or unreadable" "$TMP/err.txt" || fail "$fn: missing plan must explain on stderr"
done
echo "✓ wave/mockup helpers: missing plan file ⇒ non-zero + stderr message"

# ── plan_tier: header-block Tier: line only ─────────────────────────────────
check_tier() {
  local file="$TMP/tier-$1.md" got
  printf '%b' "$2" > "$file"
  got=$(plan_tier "$file")
  [[ "$got" == "$3" ]] || fail "plan_tier ($1): expected [$3], got [$got]"
}
check_tier absent   '# Plan\nStatus: draft\n\n## Goal\nx\n'             standard
check_tier light    '# Plan\nTier: light\n\n## Goal\nx\n'               light
check_tier padded   '# Plan\nTier:  Light  \n\n## Goal\nx\n'            light
check_tier standard '# Plan\nTier: standard\n## Goal\n'                 standard
check_tier bogus    '# Plan\nTier: bogus\n## Goal\n'                    bogus
check_tier body     '# Plan\nStatus: draft\n\n## Goal\n```\nTier: light\n```\n' standard
echo "✓ plan_tier: absent ⇒ standard, light / ' Light ' ⇒ light, standard, bogus verbatim, body Tier: ignored"

if plan_tier "$TMP/does-not-exist.md" 2>"$TMP/err.txt"; then
  fail "plan_tier: missing plan file must return non-zero"
fi
grep -q "missing or unreadable" "$TMP/err.txt" || fail "plan_tier: missing plan must explain on stderr"
echo "✓ plan_tier: missing plan file ⇒ non-zero + stderr message"

# ── plan_playbook: header-block Playbook: line only ─────────────────────────
# check_playbook <name> <plan text> <expected stdout> <expected rc>
check_playbook() {
  local file="$TMP/playbook-$1.md" got rc=0
  printf '%b' "$2" > "$file"
  got=$(plan_playbook "$file" 2>/dev/null) || rc=$?
  [[ "$got" == "$3" ]] || fail "plan_playbook ($1): expected [$3], got [$got]"
  [[ "$rc" -eq "$4" ]] || fail "plan_playbook ($1): expected exit $4, got $rc"
}
check_playbook absent   '# Plan\nStatus: draft\n\n## Goal\nx\n'                                  ''                          0
check_playbook present  '# Plan\nPlaybook: env-knob/timeout-style@1\n\n## Goal\nx\n'             'env-knob/timeout-style@1'  0
check_playbook padded   '# Plan\nPlaybook:   env-knob/a@2  \n## Goal\n'                            'env-knob/a@2'              0
check_playbook repeated '# Plan\nPlaybook: env-knob/a@1\nPlaybook: env-knob/b@1\n## Goal\n'       ''                          1
check_playbook empty    '# Plan\nPlaybook:\n## Goal\n'                                              ''                          1
check_playbook blank    '# Plan\nPlaybook:   \n## Goal\n'                                           ''                          1
check_playbook body     '# Plan\nStatus: draft\n\n## Goal\n```\nPlaybook: env-knob/a@1\n```\n'   ''                          0
check_playbook bodydup  '# Plan\nPlaybook: env-knob/a@1\n\n## Goal\nPlaybook: env-knob/b@1\n'     'env-knob/a@1'              0
echo "✓ plan_playbook: absent ⇒ empty, present/padded trimmed, repeated and empty ⇒ exit 1, body Playbook: ignored"

if plan_playbook "$TMP/does-not-exist.md" 2>"$TMP/err.txt"; then
  fail "plan_playbook: missing plan file must return non-zero"
fi
grep -q "missing or unreadable" "$TMP/err.txt" || fail "plan_playbook: missing plan must explain on stderr"
echo "✓ plan_playbook: missing plan file ⇒ non-zero + stderr message"

# ── plan_light_violations: bounds + risky paths on light plans only ─────────
# write_tier_plan <file> <tier-header-line> <waves> <tasks-per-wave> <scope-path>
write_tier_plan() {
  local file="$1" w t
  { printf '# Plan: tier fixture\n%s\n\n## Files in Scope\n' "$2"
    printf '| File | Lines | Change |\n|------|-------|--------|\n| `%s` | 1-10 | Modify |\n\n' "$5"
    printf '## Wave Plan\n'
    for ((w = 1; w <= $3; w++)); do
      printf '### Wave %s\n' "$w"
      for ((t = 1; t <= $4; t++)); do printf '#### Task %s.%s: t\nFile: %s\n' "$w" "$t" "$5"; done
    done
  } > "$file"
}
check_violations() {
  local got
  got=$(unset RAD_HIGH_RISK_PATTERNS; plan_light_violations "$1")
  [[ "$got" == "$2" ]] || fail "plan_light_violations ($1): expected [$2], got [$got]"
}
write_tier_plan "$TMP/lv-standard.md" "Status: draft" 5 2 docs/readme.md
check_violations "$TMP/lv-standard.md" ""
write_tier_plan "$TMP/lv-ok.md" "Tier: light" 1 3 docs/readme.md
check_violations "$TMP/lv-ok.md" ""
write_tier_plan "$TMP/lv-waves.md" "Tier: light" 2 1 docs/readme.md
check_violations "$TMP/lv-waves.md" "light-tier: 2 waves (max 1)"
write_tier_plan "$TMP/lv-tasks.md" "Tier: light" 1 4 docs/readme.md
check_violations "$TMP/lv-tasks.md" "light-tier: 4 tasks (max 3)"
write_tier_plan "$TMP/lv-risk.md" "Tier: light" 1 1 src/auth/login.js
check_violations "$TMP/lv-risk.md" "light-tier: high-risk path src/auth/login.js"
write_tier_plan "$TMP/lv-self.md" "Tier: light" 1 1 harness/cli.js
check_violations "$TMP/lv-self.md" "light-tier: self-protected path harness/cli.js"
write_tier_plan "$TMP/lv-both.md" "Tier: light" 1 1 scripts/token-x.sh
check_violations "$TMP/lv-both.md" "light-tier: high-risk path scripts/token-x.sh
light-tier: self-protected path scripts/token-x.sh"
echo "✓ plan_light_violations: standard 5 waves ⇒ none, light within bounds ⇒ none, waves / tasks / high-risk / self-protected / both each named"

if plan_light_violations "$TMP/does-not-exist.md" 2>"$TMP/err.txt"; then
  fail "plan_light_violations: missing plan file must return non-zero"
fi
grep -q "missing or unreadable" "$TMP/err.txt" || fail "plan_light_violations: missing plan must explain on stderr"
echo "✓ plan_light_violations: missing plan file ⇒ non-zero + stderr message"

# ── default high-risk pattern: whole-segment matching (#143) ─────────────────
# One plan lists every table path in Files in Scope; the emitted ids are compared
# to the expected should-match set, so a missing flag AND a spurious flag both fail.
HR_SHOULD_MATCH="src/auth/login.js
lib/authentication.ts
api/oauth-callback.js
db/migrations/001.sql
config/secrets.yaml
services/authService.js
src/tokens.js
billing/invoice.rb
src/authorize.js
auth.js
src/payment_gateway.py
scripts/secret-rotate.sh"
HR_SHOULD_NOT_MATCH="harness/test/approval-authority-recording.test.js
docs/authors.md
src/tokenizer.js
src/authorship.md
docs/tokenomics.md
harness/adapters/git-state-store.js"
HR_TABLE_PLAN="$TMP/hr-table.md"
{ printf '# Plan: high-risk table\n## Files in Scope\n| File | Lines | Change |\n|------|-------|--------|\n'
  printf '%s\n%s\n' "$HR_SHOULD_MATCH" "$HR_SHOULD_NOT_MATCH" | while IFS= read -r p; do
    printf '| `%s` | 1 | Modify |\n' "$p"
  done
} > "$HR_TABLE_PLAN"
hr_expected=$(printf '%s\n' "$HR_SHOULD_MATCH" | sed "s/^/$RAD_HIGH_RISK_FINDING_PREFIX/" | sort -u)
out=$(unset RAD_HIGH_RISK_PATTERNS; plan_high_risk_findings "$HR_TABLE_PLAN")
[[ "$out" == "$hr_expected" ]] \
  || fail "plan_high_risk_findings (default, unset): expected [$hr_expected], got [$out]"
out=$(RAD_HIGH_RISK_PATTERNS='' plan_high_risk_findings "$HR_TABLE_PLAN")
[[ "$out" == "$hr_expected" ]] \
  || fail "plan_high_risk_findings (default, empty env): expected [$hr_expected], got [$out]"
while IFS= read -r p; do
  (unset RAD_HIGH_RISK_PATTERNS; path_matches "$p" "$(plan_high_risk_pattern)") \
    || fail "default high-risk pattern must match $p"
done <<< "$HR_SHOULD_MATCH"
while IFS= read -r p; do
  if (unset RAD_HIGH_RISK_PATTERNS; path_matches "$p" "$(plan_high_risk_pattern)"); then
    fail "default high-risk pattern must NOT match $p"
  fi
done <<< "$HR_SHOULD_NOT_MATCH"
echo "✓ default high-risk pattern: 12 whole-segment paths flagged, 6 substring look-alikes (authority/authors/tokenizer/…) not — unset and empty env"

# ── plan_files_in_scope: empty table, missing plan, normal output (#145) ─────
# A header + separator with no data rows must print nothing and SUCCEED — under
# set -euo pipefail the old grep -v exit 1 silently aborted lint-plan.sh.
FIS_EMPTY_PLAN="$TMP/fis-empty.md"
printf '# Plan: fis\n## Files in Scope\n| File | Lines | Change |\n|------|-------|--------|\n\n## Wave Plan\n' > "$FIS_EMPTY_PLAN"
fis_rc=0
out=$(plan_files_in_scope "$FIS_EMPTY_PLAN") || fis_rc=$?
[[ "$fis_rc" -eq 0 ]] || fail "plan_files_in_scope (empty table): expected exit 0, got $fis_rc"
[[ -z "$out" ]] || fail "plan_files_in_scope (empty table): expected no output, got [$out]"
FIS_NOSECTION_PLAN="$TMP/fis-nosection.md"
printf '# Plan: fis\n## Wave Plan\n' > "$FIS_NOSECTION_PLAN"
fis_rc=0
out=$(plan_files_in_scope "$FIS_NOSECTION_PLAN") || fis_rc=$?
[[ "$fis_rc" -eq 0 && -z "$out" ]] || fail "plan_files_in_scope (no section): expected exit 0 + no output, got $fis_rc [$out]"
echo "✓ plan_files_in_scope: header-only table / no section ⇒ exit 0, no output"

if plan_files_in_scope "$TMP/does-not-exist.md" >/dev/null 2>"$TMP/err.txt"; then
  fail "plan_files_in_scope: missing plan file must return non-zero"
fi
grep -q "missing or unreadable" "$TMP/err.txt" || fail "plan_files_in_scope: missing plan must explain on stderr"
if plan_files_in_scope "" >/dev/null 2>"$TMP/err.txt"; then
  fail "plan_files_in_scope: empty plan argument must return non-zero"
fi
echo "✓ plan_files_in_scope: missing plan / empty argument ⇒ non-zero + stderr message"

FIS_ROWS_PLAN="$TMP/fis-rows.md"
cat > "$FIS_ROWS_PLAN" <<'FIS'
# Plan: fis
## Files in Scope
| File | Lines | Change |
|------|-------|--------|
| `src/a.js` | 1-2 | Modify |
| [path] | 1 | placeholder |
|  src/b.js  | 3 | Modify |

## Wave Plan
| not/scope.js | 1 | outside the section |
FIS
out=$(plan_files_in_scope "$FIS_ROWS_PLAN")
[[ "$out" == "src/a.js
src/b.js" ]] || fail "plan_files_in_scope (rows): expected [src/a.js src/b.js], got [$out]"
echo "✓ plan_files_in_scope: data rows ⇒ paths only (header, separator, placeholder, other sections skipped)"

# ── plan_high_risk_pattern_is_default ────────────────────────────────────────
(unset RAD_HIGH_RISK_PATTERNS; plan_high_risk_pattern_is_default) \
  || fail "plan_high_risk_pattern_is_default: unset env must be the default (exit 0)"
(RAD_HIGH_RISK_PATTERNS='' plan_high_risk_pattern_is_default) \
  || fail "plan_high_risk_pattern_is_default: empty env must be the default (exit 0)"
(RAD_HIGH_RISK_PATTERNS="$RAD_HIGH_RISK_DEFAULT_PATTERN" plan_high_risk_pattern_is_default) \
  || fail "plan_high_risk_pattern_is_default: the exact default string must be the default (exit 0)"
is_default_rc=0
(RAD_HIGH_RISK_PATTERNS='widget|readme' plan_high_risk_pattern_is_default) || is_default_rc=$?
[[ "$is_default_rc" -eq 1 ]] \
  || fail "plan_high_risk_pattern_is_default: custom pattern must exit 1, got $is_default_rc"
is_default_rc=0
(RAD_HIGH_RISK_PATTERNS="$RAD_HIGH_RISK_DEFAULT_PATTERN " plan_high_risk_pattern_is_default) || is_default_rc=$?
[[ "$is_default_rc" -eq 1 ]] \
  || fail "plan_high_risk_pattern_is_default: default + trailing space is NOT the default, got $is_default_rc"
echo "✓ plan_high_risk_pattern_is_default: unset / empty / exact default ⇒ 0; custom / near-miss ⇒ 1"

# ── plan_high_risk_pattern: config-backed (preset-settings AC#2) ─────────────
# The lib reads .rad/config.yml through the harness CLI two levels above it, so
# each case runs a COPY of the lib inside a fixture tree (harness/ without
# node_modules — config get needs only the vendored js-yaml — plus scripts/) with
# its own .rad/config.yml. This repo's .rad/config.yml is never written. The
# copied lib is sourced in a child bash: this shell already holds its readonly
# constants.
CFG="$TMP/cfg"
mkdir -p "$CFG/.rad"
tar -C "$HERE/.." --exclude=node_modules -cf - harness scripts/lib scripts/lint-plan.sh \
  scripts/check-approval-blockers.sh scripts/get-default-branch.sh | tar -C "$CFG" -xf -
CFG_CONFIG="$CFG/.rad/config.yml"
CUSTOM_PATTERN='widget|readme'

# cfg_call <lib> <fn> [args...] — run one helper from a fixture's copied lib.
cfg_call() { bash -c '. "$1"; shift; "$@"' _ "$@"; }

# write_cfg [settings-yaml-line] — a valid fixture config, optionally with settings.
write_cfg() {
  printf 'version: 1\nplatform: manual\ndefault_branch: main\nroles:\n  architect: [a@x]\n' > "$CFG_CONFIG"
  if [[ -n "${1:-}" ]]; then printf 'settings:\n  %s\n' "$1" >> "$CFG_CONFIG"; fi
}

write_invalid_cfg() {
  write_cfg
  printf 'settings:\n  nope: x\n' >> "$CFG_CONFIG"
}

# Env set: config is NOT consulted — an invalid config still resolves.
write_invalid_cfg
out=$(RAD_HIGH_RISK_PATTERNS='env-only' cfg_call "$CFG/scripts/lib/plan-paths.sh" plan_high_risk_pattern) \
  || fail "plan_high_risk_pattern: env set must not read the (invalid) config"
[[ "$out" == "env-only" ]] || fail "plan_high_risk_pattern: env set must win, got [$out]"
echo "✓ plan_high_risk_pattern: env set ⇒ env value, config never consulted"

# Env empty + config key set ⇒ the config value.
write_cfg "high_risk_patterns: '$CUSTOM_PATTERN'"
out=$(RAD_HIGH_RISK_PATTERNS='' cfg_call "$CFG/scripts/lib/plan-paths.sh" plan_high_risk_pattern)
[[ "$out" == "$CUSTOM_PATTERN" ]] || fail "plan_high_risk_pattern: config value expected, got [$out]"
out=$(unset RAD_HIGH_RISK_PATTERNS; cfg_call "$CFG/scripts/lib/plan-paths.sh" plan_high_risk_findings "$RISK_PLAN")
[[ "$out" == $'high-risk:docs/readme.md\nhigh-risk:lib/widget.js' ]] \
  || fail "plan_high_risk_findings: config pattern must drive findings, got [$out]"
is_default_rc=0
(unset RAD_HIGH_RISK_PATTERNS; cfg_call "$CFG/scripts/lib/plan-paths.sh" plan_high_risk_pattern_is_default) \
  || is_default_rc=$?
[[ "$is_default_rc" -eq 1 ]] || fail "plan_high_risk_pattern_is_default: config custom must exit 1, got $is_default_rc"
echo "✓ plan_high_risk_pattern: empty env + config key ⇒ config value (findings + _is_default follow it)"

# Config pattern equal to the default ⇒ _is_default true.
write_cfg "high_risk_patterns: '$RAD_HIGH_RISK_DEFAULT_PATTERN'"
(unset RAD_HIGH_RISK_PATTERNS; cfg_call "$CFG/scripts/lib/plan-paths.sh" plan_high_risk_pattern_is_default) \
  || fail "plan_high_risk_pattern_is_default: a config value equal to the default must exit 0"
echo "✓ plan_high_risk_pattern_is_default: config value == default ⇒ 0"

# Key absent from a valid config ⇒ default.
write_cfg
out=$(unset RAD_HIGH_RISK_PATTERNS; cfg_call "$CFG/scripts/lib/plan-paths.sh" plan_high_risk_pattern)
[[ "$out" == "$RAD_HIGH_RISK_DEFAULT_PATTERN" ]] || fail "plan_high_risk_pattern: absent key must print the default, got [$out]"
echo "✓ plan_high_risk_pattern: key absent (config get exit 3) ⇒ default"

# Invalid config ⇒ the helper fails closed with the reason; both callers fail closed.
write_invalid_cfg
err_out="$TMP/hr-err.txt"
rc=0
(unset RAD_HIGH_RISK_PATTERNS; cfg_call "$CFG/scripts/lib/plan-paths.sh" plan_high_risk_pattern) >/dev/null 2>"$err_out" || rc=$?
[[ "$rc" -ne 0 ]] || fail "plan_high_risk_pattern: invalid config must return non-zero"
grep -q 'unknown key settings.nope' "$err_out" || fail "plan_high_risk_pattern: invalid-config reason missing from stderr"
grep -q 'cannot read settings.high_risk_patterns' "$err_out" || fail "plan_high_risk_pattern: helper reason missing"
for fn in plan_high_risk_pattern_is_default plan_high_risk_findings; do
  rc=0
  (unset RAD_HIGH_RISK_PATTERNS; cfg_call "$CFG/scripts/lib/plan-paths.sh" "$fn" "$RISK_PLAN") >/dev/null 2>&1 || rc=$?
  [[ "$rc" -ne 0 ]] || fail "$fn: invalid config must propagate failure, got exit 0"
done
LIGHT_PLAN="$TMP/light.md"
printf '# Plan: l\nTier: light\n\n#### Task 1.1: t\nFile: src/auth/x.js\n' > "$LIGHT_PLAN"
rc=0
(unset RAD_HIGH_RISK_PATTERNS; cfg_call "$CFG/scripts/lib/plan-paths.sh" plan_light_violations "$LIGHT_PLAN") >/dev/null 2>&1 || rc=$?
[[ "$rc" -ne 0 ]] || fail "plan_light_violations: invalid config on a light plan must fail, got exit 0"
rc=0
lint_out=$(unset RAD_HIGH_RISK_PATTERNS; bash "$CFG/scripts/lint-plan.sh" "$RISK_PLAN" 2>&1) || rc=$?
[[ "$rc" -eq 1 ]] || fail "lint-plan.sh: invalid config must exit 1, got $rc"
printf '%s' "$lint_out" | grep -q 'unknown key settings.nope' || fail "lint-plan.sh: reason not named: [$lint_out]"
printf '%s' "$lint_out" | grep -q 'cannot resolve the high-risk pattern' || fail "lint-plan.sh: failing-closed line missing"
rc=0
cab_err=$(unset RAD_HIGH_RISK_PATTERNS; bash "$CFG/scripts/check-approval-blockers.sh" "$RISK_PLAN" 2>&1 >/dev/null) || rc=$?
[[ "$rc" -eq 2 ]] || fail "check-approval-blockers.sh: invalid config must exit 2, got $rc"
printf '%s' "$cab_err" | grep -q 'unknown key settings.nope' || fail "check-approval-blockers.sh: reason not named: [$cab_err]"
echo "✓ plan_high_risk_pattern: invalid config ⇒ non-zero + reason; helpers, lint-plan (1), check-approval-blockers (2) fail closed"

# No config file ⇒ default, without calling the CLI; a CLI that exits 0 with no
# output ⇒ fail closed. A stub cli.js proves both.
STUB="$TMP/stub"
mkdir -p "$STUB/scripts/lib" "$STUB/harness"
cp "$HERE/lib/plan-paths.sh" "$STUB/scripts/lib/"
printf 'process.exit(0);\n' > "$STUB/harness/cli.js"
out=$(unset RAD_HIGH_RISK_PATTERNS; cfg_call "$STUB/scripts/lib/plan-paths.sh" plan_high_risk_pattern) \
  || fail "plan_high_risk_pattern: no config file must not fail"
[[ "$out" == "$RAD_HIGH_RISK_DEFAULT_PATTERN" ]] || fail "plan_high_risk_pattern: no config file must print the default, got [$out]"
echo "✓ plan_high_risk_pattern: no .rad/config.yml ⇒ default (CLI not called)"
mkdir -p "$STUB/.rad"
printf 'version: 1\n' > "$STUB/.rad/config.yml"
rc=0
(unset RAD_HIGH_RISK_PATTERNS; cfg_call "$STUB/scripts/lib/plan-paths.sh" plan_high_risk_pattern) >/dev/null 2>"$err_out" || rc=$?
[[ "$rc" -ne 0 ]] || fail "plan_high_risk_pattern: CLI exit 0 with no output must fail closed"
grep -q 'exited 0 with no output' "$err_out" || fail "plan_high_risk_pattern: empty-output reason missing"
echo "✓ plan_high_risk_pattern: CLI exit 0 with no output ⇒ non-zero (fail closed)"

# Self-protected set (#171 part 1): the generated Codex outputs join .claude/.
for p in .codex/agents/x.toml .agents/skills/x/SKILL.md .agents/skills/x/agents/openai.yaml \
         harness/cli.js scripts/x.sh .claude/agents/a.md .agents/state/f/events.jsonl .rad/config.yml \
         gates.yaml docs/matrix.yml; do
  path_is_self_protected "$p" || fail "path_is_self_protected: $p must be protected"
done
for p in .agents/plans/x.md .agents/skillset/x docs/.codex/x .agents/logs/x.md src/.claude/x codex/x; do
  if path_is_self_protected "$p"; then fail "path_is_self_protected: $p must NOT be protected"; fi
done
echo "✓ path_is_self_protected: .codex/ and .agents/skills/ protected; .agents/plans, .agents/skillset, docs/.codex not; existing set unchanged"

# ── plan_last_wave_verify: last wave number + Verify presence ───────────────
LV_PLAN="$TMP/lastverify.md"
lv() { plan_last_wave_verify "$LV_PLAN"; }
printf '# Plan\n## Acceptance Criteria\nVerify: not in a wave\n' > "$LV_PLAN"
[[ -z "$(lv)" ]] || fail "plan_last_wave_verify: no waves must print nothing"
printf '### Wave 1\nVerify: npm test\n### Wave 2\n#### Task 2.1\nFile: x\n## Risks\nVerify: after\n' > "$LV_PLAN"
[[ "$(lv)" == "2 no" ]] || fail "plan_last_wave_verify: Verify only on an earlier wave must be '2 no', got [$(lv)]"
printf '### Wave 1\n### Wave 2\n#### Task 2.1\n  Verify: exec bash scripts/verify-all.sh  \n' > "$LV_PLAN"
[[ "$(lv)" == "2 yes" ]] || fail "plan_last_wave_verify: indented Verify under a #### heading must count, got [$(lv)]"
printf '### Wave 1\nSee Verify: later in prose\nVerify:\n' > "$LV_PLAN"
[[ "$(lv)" == "1 no" ]] || fail "plan_last_wave_verify: mid-sentence and empty Verify must not count, got [$(lv)]"
printf '### Wave 3\nVerify: a\n### Wave 10\nx\n' > "$LV_PLAN"
[[ "$(lv)" == "10 no" ]] || fail "plan_last_wave_verify: numeric (not lexical) last wave, got [$(lv)]"
rc=0; plan_last_wave_verify "$TMP/does-not-exist.md" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 2 ]] || fail "plan_last_wave_verify: unreadable plan must exit 2, got $rc"
echo "✓ plan_last_wave_verify: last wave + Verify yes/no; mid-sentence, empty, post-section and no-wave cases"

echo "ALL PASS"
