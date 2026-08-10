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
#
# Self-contained: builds a temp git-repo fixture (git init + a local bare origin
# so `origin/main` resolves, mirroring test-classify-low-risk.sh), copies
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

echo "ALL PASS"
