#!/usr/bin/env bash
# detect-platform.sh
# Detects git platform from remote URL and outputs platform name.
# Usage: scripts/detect-platform.sh [--quiet]
# Output: github | gitlab | bitbucket | forgejo | manual

set -euo pipefail

QUIET=${1:-""}

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

PLATFORM=$(detect)

if [[ "$QUIET" != "--quiet" ]]; then
  echo "Detected platform: $PLATFORM"

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
