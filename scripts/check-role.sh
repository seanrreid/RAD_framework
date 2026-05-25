#!/usr/bin/env bash
# check-role.sh
# Verifies the current git user has a required RAD role as declared in CLAUDE.md.
#
# Usage: scripts/check-role.sh <required-role> [claude-md-path]
#
# Roles: architect | developer | designer
#
# Exit codes:
#   0 = user has the required role
#   1 = user does not have the required role
#   2 = usage error or role config not found

set -euo pipefail

REQUIRED_ROLE="${1:-}"
CLAUDE_MD="${2:-CLAUDE.md}"

[[ -z "$REQUIRED_ROLE" ]] && { echo "ERROR: required role argument missing"; exit 2; }
[[ ! -f "$CLAUDE_MD" ]]   && { echo "ERROR: CLAUDE.md not found at: $CLAUDE_MD"; exit 2; }

VALID_ROLES="architect developer designer"
echo "$VALID_ROLES" | grep -qw "$REQUIRED_ROLE" \
  || { echo "ERROR: unknown role '$REQUIRED_ROLE'. Must be one of: $VALID_ROLES"; exit 2; }

# ── Get current git user ──────────────────────────────────────────────────────

GIT_NAME=$(git config user.name 2>/dev/null || echo "")
GIT_EMAIL=$(git config user.email 2>/dev/null || echo "")

# Derive username from email (part before @)
EMAIL_USER=$(echo "$GIT_EMAIL" | sed 's/@.*//')

if [[ -z "$GIT_NAME" && -z "$GIT_EMAIL" ]]; then
  echo "⚠ Cannot determine git user identity (git config user.name/email not set)"
  echo "  Set git user identity or configure roles in CLAUDE.md to use role-gated commands."
  exit 2
fi

# ── Extract role assignments from CLAUDE.md ───────────────────────────────────
# Looks for the Role Assignments block:
#   architect:  username
#   developers: [user1, user2]
#   designers:  []

extract_role_users() {
  local role="$1"
  local pattern

  case "$role" in
    architect)  pattern="^architect:" ;;
    developer)  pattern="^developers:" ;;
    designer)   pattern="^designers:" ;;
  esac

  grep "$pattern" "$CLAUDE_MD" | head -1 \
    | sed "s/${pattern}[[:space:]]*//" \
    | tr -d '[]' \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | grep -v "^$\|^\[your GitHub"
}

ROLE_USERS=$(extract_role_users "$REQUIRED_ROLE")

if [[ -z "$ROLE_USERS" ]]; then
  echo "⚠ No users configured for role '$REQUIRED_ROLE' in CLAUDE.md"
  echo "  Update the Role Assignments section before using role-gated commands."
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
echo "Your git identity:"
[[ -n "$GIT_NAME" ]]  && echo "  Name:  $GIT_NAME"
[[ -n "$GIT_EMAIL" ]] && echo "  Email: $GIT_EMAIL"
echo ""
echo "Configured $REQUIRED_ROLE(s) in CLAUDE.md:"
while IFS= read -r u; do
  [[ -n "$u" ]] && echo "  · $u"
done <<< "$ROLE_USERS"
exit 1
