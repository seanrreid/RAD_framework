#!/usr/bin/env bash
# check-role.sh
# Verifies an identity has a required RAD role as declared in .rad/config.yml
# (roles.architect | roles.developers | roles.designers, read via
# `rad config get` from <repo-root>/harness/cli.js).
# By default the identity is the current git user; pass a name/email as the
# third argument to validate someone else (used by /rad-approve --on-behalf-of).
#
# Usage: scripts/check-role.sh <required-role> [repo-root] [identity-override]
#   repo-root defaults to this script's checkout.
#
# Roles: architect | developer | designer
#
# Exit codes:
#   0 = identity has the required role
#   1 = identity does not have the required role
#   2 = usage error, missing/invalid .rad/config.yml, or no users for the role

set -euo pipefail

readonly CONFIG_KEY_ABSENT_EXIT=3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_ROLE="${1:-}"
ROOT="${2:-$SCRIPT_DIR/..}"
IDENTITY_OVERRIDE="${3:-}"
RAD_CLI="$ROOT/harness/cli.js"

[[ -z "$REQUIRED_ROLE" ]] && { echo "ERROR: required role argument missing"; exit 2; }
[[ ! -f "$RAD_CLI" ]]     && { echo "ERROR: RAD harness not found at: $RAD_CLI (repo-root: $ROOT)"; exit 2; }

VALID_ROLES="architect developer designer"
echo "$VALID_ROLES" | grep -qw "$REQUIRED_ROLE" \
  || { echo "ERROR: unknown role '$REQUIRED_ROLE'. Must be one of: $VALID_ROLES"; exit 2; }

# ── Resolve the identity to check ─────────────────────────────────────────────

if [[ -n "$IDENTITY_OVERRIDE" ]]; then
  # Validate a named identity (e.g. an architect who approved out-of-band).
  GIT_NAME="$IDENTITY_OVERRIDE"
  GIT_EMAIL="$IDENTITY_OVERRIDE"
else
  GIT_NAME=$(git config user.name 2>/dev/null || echo "")
  GIT_EMAIL=$(git config user.email 2>/dev/null || echo "")

  if [[ -z "$GIT_NAME" && -z "$GIT_EMAIL" ]]; then
    echo "⚠ Cannot determine git user identity (git config user.name/email not set)"
    echo "  Set git user identity to use role-gated commands."
    exit 2
  fi
fi

# Derive username from email (part before @)
EMAIL_USER=$(echo "$GIT_EMAIL" | sed 's/@.*//')

# ── Read role assignments from .rad/config.yml ────────────────────────────────
# `rad config get roles.<key>` prints one user per line; an empty list prints
# nothing. Absent key (exit 3) = no users; missing/invalid config fails closed.

case "$REQUIRED_ROLE" in
  architect) ROLE_KEY="roles.architect" ;;
  developer) ROLE_KEY="roles.developers" ;;
  designer)  ROLE_KEY="roles.designers" ;;
esac

ERR_FILE=$(mktemp "${TMPDIR:-/tmp}/check-role.XXXXXX")
trap 'rm -f "$ERR_FILE"' EXIT

rc=0
ROLE_USERS=$(node "$RAD_CLI" config get "$ROLE_KEY" 2>"$ERR_FILE") || rc=$?

if [[ "$rc" -ne 0 && "$rc" -ne "$CONFIG_KEY_ABSENT_EXIT" ]]; then
  echo "ERROR: cannot read '$ROLE_KEY' from .rad/config.yml (rad config get exit $rc):"
  sed 's/^/  /' "$ERR_FILE"
  exit 2
fi

if [[ -z "$ROLE_USERS" ]]; then
  echo "⚠ No users configured for role '$REQUIRED_ROLE' in .rad/config.yml ($ROLE_KEY)"
  echo "  Update roles in .rad/config.yml before using role-gated commands."
  exit 2
fi

# ── Match current user against role list ──────────────────────────────────────

while IFS= read -r configured_user; do
  [[ -z "$configured_user" ]] && continue
  if [[ "$configured_user" == "$GIT_NAME" \
     || "$configured_user" == "$GIT_EMAIL" \
     || "$configured_user" == "$EMAIL_USER" ]]; then
    exit 0
  fi
done <<< "$ROLE_USERS"

# ── Not found ─────────────────────────────────────────────────────────────────

echo "✗ Permission denied: this command requires the '$REQUIRED_ROLE' role."
echo ""
if [[ -n "$IDENTITY_OVERRIDE" ]]; then
  echo "Identity checked: $IDENTITY_OVERRIDE"
else
  echo "Your git identity:"
  [[ -n "$GIT_NAME" ]]  && echo "  Name:  $GIT_NAME"
  [[ -n "$GIT_EMAIL" ]] && echo "  Email: $GIT_EMAIL"
fi
echo ""
echo "Configured $REQUIRED_ROLE(s) in .rad/config.yml ($ROLE_KEY):"
while IFS= read -r u; do
  [[ -n "$u" ]] && echo "  · $u"
done <<< "$ROLE_USERS"
exit 1
