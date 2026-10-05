#!/usr/bin/env bash
# detect-platform.sh
# Detects the git platform and outputs its name.
# Precedence: `platform` in .rad/config.yml (read via `rad config get` from this
# script's checkout) first; if there is no git top level, the config file or key
# is absent, or the config reader (harness/cli.js) is unavailable, detection from
# the origin remote URL (with a stderr notice). Only a genuinely invalid config
# (rad config get exit 1) → manual.
# Usage: scripts/detect-platform.sh [--quiet]
# Output: github | gitlab | bitbucket | forgejo | manual  (always the last stdout line)

set -euo pipefail

QUIET=${1:-""}
VALID_PLATFORMS="github|gitlab|bitbucket|forgejo|manual"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
RAD_CLI="$ROOT/harness/cli.js"
readonly CONFIG_FILE="$ROOT/.rad/config.yml"
readonly CONFIG_KEY_ABSENT_EXIT=3
readonly COMMAND_NOT_FOUND_EXIT=127

# Sets CONFIG_PLATFORM / CONFIG_STATE from .rad/config.yml via `rad config get`.
#   CONFIG_STATE=set     — platform read (CONFIG_PLATFORM holds it)
#   CONFIG_STATE=absent  — no git top level, no config file (install-time), no
#                          platform key, or no config reader (harness/cli.js
#                          missing, e.g. a scripts-only copy) → URL detection
#   CONFIG_STATE=invalid — config present but invalid (config get exit 1) → manual
# Runs in the main shell (not a subshell) so both variables survive.
read_config_platform() {
  CONFIG_PLATFORM=""
  local top=""
  # Outside a git repo there is no repo to anchor a config to — not an error:
  # URL detection (which also yields manual) decides, as before #87.
  top=$(git rev-parse --show-toplevel 2>/dev/null) || top=""
  if [[ -z "$top" ]]; then
    echo "notice: no git top level — detecting platform from the origin URL" >&2
    CONFIG_STATE="absent"
    return 0
  fi
  if [[ ! -f "$RAD_CLI" ]]; then
    echo "notice: no config reader at $RAD_CLI — detecting platform from the origin URL" >&2
    CONFIG_STATE="absent"
    return 0
  fi
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "notice: no .rad/config.yml — detecting platform from the origin URL (run 'rad config init' for a new install or 'rad config migrate' from a pre-#87 CLAUDE.md)" >&2
    CONFIG_STATE="absent"
    return 0
  fi
  local rc=0 err_file
  err_file=$(mktemp "${TMPDIR:-/tmp}/detect-platform.XXXXXX")
  CONFIG_PLATFORM=$(node "$RAD_CLI" config get platform 2>"$err_file") || rc=$?
  if [[ "$rc" -eq 0 && -n "$CONFIG_PLATFORM" ]]; then
    CONFIG_STATE="set"
  elif [[ "$rc" -eq "$COMMAND_NOT_FOUND_EXIT" ]]; then
    echo "notice: config reader unavailable (node not found) — detecting platform from the origin URL" >&2
    CONFIG_PLATFORM=""
    CONFIG_STATE="absent"
  elif [[ "$rc" -eq 0 || "$rc" -eq "$CONFIG_KEY_ABSENT_EXIT" ]]; then
    echo "notice: no platform in .rad/config.yml — detecting platform from the origin URL" >&2
    CONFIG_STATE="absent"
  else
    cat "$err_file" >&2
    echo "warning: cannot read platform from .rad/config.yml (rad config get exit $rc) — using manual" >&2
    CONFIG_PLATFORM=""
    CONFIG_STATE="invalid"
  fi
  rm -f "$err_file"
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

read_config_platform

case "$CONFIG_STATE" in
  set)
    SOURCE="from .rad/config.yml"
    case "$CONFIG_PLATFORM" in
      github|gitlab|bitbucket|forgejo|manual) PLATFORM="$CONFIG_PLATFORM" ;;
      *)
        echo "warning: invalid platform '$CONFIG_PLATFORM' in .rad/config.yml — using manual (valid: $VALID_PLATFORMS)" >&2
        PLATFORM="manual"
        ;;
    esac
    ;;
  invalid)
    SOURCE="invalid .rad/config.yml"
    PLATFORM="manual"
    ;;
  *)
    SOURCE="from origin URL"
    PLATFORM=$(detect)
    ;;
esac

if [[ "$QUIET" != "--quiet" ]]; then
  echo "Detected platform: $PLATFORM ($SOURCE)"

  case "$PLATFORM" in
    github)
      if ! command -v gh &>/dev/null; then
        echo "WARNING: gh CLI not found. Install from https://cli.github.com/"
        echo "         or set platform: manual in .rad/config.yml to use manual mode."
      else
        echo "gh CLI found: $(gh --version | head -1)"
      fi
      ;;
    gitlab)
      if ! command -v glab &>/dev/null; then
        echo "WARNING: glab CLI not found. Install from https://gitlab.com/gitlab-org/cli"
        echo "         or set platform: manual in .rad/config.yml to use manual mode."
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
