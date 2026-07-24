#!/usr/bin/env bash
# test-plan-paths.sh
# Unit tests for the plan-paths.sh helpers added for premise-freshness-lint:
#   - plan_cited_anchors   — inline `path:NNN` anchor extraction (suffix stripped,
#                            de-duped, prose/URL noise rejected)
#   - plan_created_paths   — the CREATE-exempt Files-in-Scope path set
#   - path_exists_on_ref   — existence-only git-ref query (0 present / 1 absent /
#                            2 unresolvable ref, fail-closed), suffix stripped
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
mkdir -p "$REPO/scripts/lib" "$REPO/.agents/plans" "$REPO/src"
cp "$HERE/lib/plan-paths.sh" "$REPO/scripts/lib/"

# A file that exists on the baseline commit — the present case for existence checks.
printf 'export const x=1\n' > "$REPO/src/committed.js"

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

echo "ALL PASS"
