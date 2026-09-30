#!/usr/bin/env bash
# detect-platform.sh
# Detects the git platform and outputs its name.
# Precedence: CLAUDE.md `platform:` (at the git top level) first; if absent,
# detection from the origin remote URL.
# Usage: scripts/detect-platform.sh [--quiet]
# Output: github | gitlab | bitbucket | forgejo | manual  (always the last stdout line)

set -euo pipefail

QUIET=${1:-""}
VALID_PLATFORMS="github|gitlab|bitbucket|forgejo|manual"

# Print the raw `platform:` value from the repo's CLAUDE.md (empty when there
# is no repo, no CLAUDE.md, or no platform line). Parsing mirrors
# get-default-branch.sh: first match, strip key, trailing comment, whitespace.
read_config_platform() {
  local top claude_md line rc=0
  # Outside a git repo there is no top level to anchor CLAUDE.md — not an
  # error: URL detection (which also yields manual) decides.
  top=$(git rev-parse --show-toplevel 2>/dev/null) || return 0
  [[ -n "$top" ]] || return 0
  claude_md="$top/CLAUDE.md"
  [[ -f "$claude_md" ]] || return 0
  line=$(grep -E -m1 '^[[:space:]]*platform:' "$claude_md") || rc=$?
  # grep exit 1 = no platform line (absent → URL detection); >1 = read error.
  if (( rc > 1 )); then
    echo "error: cannot read $claude_md (grep exit $rc)" >&2
    exit 1
  fi
  [[ -n "$line" ]] || return 0
  printf '%s\n' "$line" \
    | sed -E 's/^[[:space:]]*platform:[[:space:]]*//; s/[[:space:]]*#.*$//; s/[[:space:]]*$//'
}

detect() {
  local remote
  remote=$(git remote get-url origin 2>/dev/null || echo "")

  if [[ -z "$remote" ]]; then
    echo "manual"
    return
  fi

  if [[ "$remote" == *"github.com"* ]]; then
    echo "github"
  elif [[ "$remote" == *"gitlab.com"* ]] || [[ "$remote" == *"/gitlab/"* ]]; then
    echo "gitlab"
  elif [[ "$remote" == *"bitbucket.org"* ]]; then
    echo "bitbucket"
  elif [[ "$remote" == *"codeberg.org"* ]] || [[ "$remote" == *"forgejo"* ]]; then
    echo "forgejo"
  else
    # Self-hosted — check for platform hints
    if command -v glab &>/dev/null; then
      echo "gitlab"
    elif command -v gh &>/dev/null; then
      echo "github"
    else
      echo "manual"
    fi
  fi
}

CONFIG_PLATFORM=$(read_config_platform)

if [[ -n "$CONFIG_PLATFORM" ]]; then
  SOURCE="from CLAUDE.md"
  case "$CONFIG_PLATFORM" in
    github|gitlab|bitbucket|forgejo|manual) PLATFORM="$CONFIG_PLATFORM" ;;
    *)
      echo "warning: invalid platform '$CONFIG_PLATFORM' in CLAUDE.md — using manual (valid: $VALID_PLATFORMS)" >&2
      PLATFORM="manual"
      ;;
  esac
else
  SOURCE="from origin URL"
  PLATFORM=$(detect)
fi

if [[ "$QUIET" != "--quiet" ]]; then
  echo "Detected platform: $PLATFORM ($SOURCE)"

  case "$PLATFORM" in
    github)
      if ! command -v gh &>/dev/null; then
        echo "WARNING: gh CLI not found. Install from https://cli.github.com/"
        echo "         or set platform: manual in CLAUDE.md to use manual mode."
      else
        echo "gh CLI found: $(gh --version | head -1)"
      fi
      ;;
    gitlab)
      if ! command -v glab &>/dev/null; then
        echo "WARNING: glab CLI not found. Install from https://gitlab.com/gitlab-org/cli"
        echo "         or set platform: manual in CLAUDE.md to use manual mode."
      else
        echo "glab CLI found: $(glab --version | head -1)"
      fi
      ;;
    bitbucket)
      echo "NOTE: Bitbucket uses manual PR creation. /rad-plan will print instructions."
      ;;
    forgejo)
      if ! command -v tea &>/dev/null; then
        echo "NOTE: tea CLI not found. Using manual mode for Forgejo/Gitea."
        echo "      Install from https://gitea.com/gitea/tea if available for your instance."
      fi
      ;;
    manual)
      echo "NOTE: Manual mode — /rad-plan will print PR creation instructions."
      ;;
  esac
fi

echo "$PLATFORM"
