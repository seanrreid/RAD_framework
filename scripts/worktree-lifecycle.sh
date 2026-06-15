#!/usr/bin/env bash
# worktree-lifecycle.sh
# Manages git worktrees used to isolate a RAD deliver run from the main checkout.
#
# A managed worktree carries a `.rad-worktree.json` marker at its root. The marker
# is the safety interlock: `remove`/`preserve` refuse to act on any directory that
# does not carry a valid marker for the named feature. This prevents deleting the
# main checkout or an unrelated (non-RAD) worktree.
#
# The marker stays local and uncommitted — it records execution-environment state,
# never delivery outcomes. It lives at the worktree root, which is a sibling of the
# tracked working tree, so it is naturally outside version control.
#
# Usage:
#   scripts/worktree-lifecycle.sh create   <feature> <branch> [dir]
#   scripts/worktree-lifecycle.sh remove   <feature> [dir]
#   scripts/worktree-lifecycle.sh preserve <feature> [dir]
#   scripts/worktree-lifecycle.sh list
#
# Dir resolution (create/remove/preserve): explicit [dir] arg, else
#   $RAD_WORKTREE_DIR/<feature>, else ../<repo-basename>-rad-worktrees/<feature>.
#
# Exit codes:
#   0 = success
#   1 = operation refused or failed (e.g. missing/invalid marker on remove)
#   2 = usage error (bad subcommand, invalid feature name, missing args)

set -euo pipefail

MARKER_NAME=".rad-worktree.json"

usage() {
  cat >&2 <<'EOF'
Usage:
  worktree-lifecycle.sh create   <feature> <branch> [dir]
  worktree-lifecycle.sh remove   <feature> [dir]
  worktree-lifecycle.sh preserve <feature> [dir]
  worktree-lifecycle.sh list
EOF
}

die() {
  echo "ERROR: $1" >&2
  exit "${2:-1}"
}

# Feature names are interpolated into filesystem paths; validate before any use.
assert_safe_feature() {
  local feature="$1"
  if [[ ! "$feature" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    die "invalid feature slug '$feature' (expected /^[a-z0-9][a-z0-9-]*\$/)" 2
  fi
}

# Resolve the target worktree dir for a (validated) feature.
resolve_dir() {
  local feature="$1" explicit="${2:-}"
  if [[ -n "$explicit" ]]; then
    printf '%s\n' "$explicit"
  elif [[ -n "${RAD_WORKTREE_DIR:-}" ]]; then
    printf '%s/%s\n' "$RAD_WORKTREE_DIR" "$feature"
  else
    local repo_root repo_base parent
    repo_root="$(git rev-parse --show-toplevel)"
    repo_base="$(basename "$repo_root")"
    parent="$(dirname "$repo_root")"
    printf '%s/%s-rad-worktrees/%s\n' "$parent" "$repo_base" "$feature"
  fi
}

# True when <dir>/.rad-worktree.json exists and its feature field matches.
marker_valid() {
  local dir="$1" feature="$2"
  local marker="$dir/$MARKER_NAME"
  [[ -f "$marker" ]] || return 1
  grep -q "\"feature\"[[:space:]]*:[[:space:]]*\"$feature\"" "$marker"
}

cmd_create() {
  local feature="${1:-}" branch="${2:-}" dir_arg="${3:-}"
  [[ -z "$feature" || -z "$branch" ]] && { usage; exit 2; }
  assert_safe_feature "$feature"

  local dir
  dir="$(resolve_dir "$feature" "$dir_arg")"

  git worktree add "$dir" "$branch" >&2

  local created_at
  created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "$dir/$MARKER_NAME" <<EOF
{
  "feature": "$feature",
  "branch": "$branch",
  "createdAt": "$created_at",
  "status": "active"
}
EOF

  # Last line of stdout is the resolved dir, so callers can capture it.
  printf '%s\n' "$dir"
}

cmd_remove() {
  local feature="${1:-}" dir_arg="${2:-}"
  [[ -z "$feature" ]] && { usage; exit 2; }
  assert_safe_feature "$feature"

  local dir
  dir="$(resolve_dir "$feature" "$dir_arg")"

  # SAFETY INTERLOCK: refuse to touch a dir without a valid marker.
  marker_valid "$dir" "$feature" \
    || die "refusing to remove '$dir' — no valid $MARKER_NAME for feature '$feature'"

  # The marker is an untracked file in the worktree; clear it (after the safety
  # check above has passed) so a plain `git worktree remove` sees a clean tree and
  # we never need --force.
  rm -f "$dir/$MARKER_NAME"
  git worktree remove "$dir"
}

cmd_preserve() {
  local feature="${1:-}" dir_arg="${2:-}"
  [[ -z "$feature" ]] && { usage; exit 2; }
  assert_safe_feature "$feature"

  local dir
  dir="$(resolve_dir "$feature" "$dir_arg")"

  marker_valid "$dir" "$feature" \
    || die "refusing to preserve '$dir' — no valid $MARKER_NAME for feature '$feature'"

  # Rewrite status to "preserved"; leave the worktree in place.
  local marker="$dir/$MARKER_NAME"
  local tmp
  tmp="$(mktemp)"
  sed 's/"status"[[:space:]]*:[[:space:]]*"[^"]*"/"status": "preserved"/' "$marker" > "$tmp"
  mv "$tmp" "$marker"
}

cmd_list() {
  # Iterate registered worktrees; print those carrying a valid marker.
  local dir
  while IFS= read -r line; do
    [[ "$line" == worktree\ * ]] || continue
    dir="${line#worktree }"
    if [[ -f "$dir/$MARKER_NAME" ]] \
      && grep -q '"feature"[[:space:]]*:' "$dir/$MARKER_NAME"; then
      printf '%s\n' "$dir"
    fi
  done < <(git worktree list --porcelain)
}

main() {
  local subcommand="${1:-}"
  [[ -z "$subcommand" ]] && { usage; exit 2; }
  shift

  case "$subcommand" in
    create)   cmd_create "$@" ;;
    remove)   cmd_remove "$@" ;;
    preserve) cmd_preserve "$@" ;;
    list)     cmd_list "$@" ;;
    *)        usage; exit 2 ;;
  esac
}

main "$@"
