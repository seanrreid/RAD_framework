#!/usr/bin/env bash
# install.sh
# Installs or upgrades the RAD framework into a target project.
#
# Usage:
#   ./install.sh                        # interactive — prompts for target directory
#   ./install.sh --dir /path/to/project # non-interactive target
#   ./install.sh --upgrade              # update commands + skills + scripts, skip user data
#   ./install.sh --yes                  # accept all defaults without prompting
#
# On upgrade, CLAUDE.md, .claude/agents/, and .agents/ content are never overwritten.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAD_DIR="$SCRIPT_DIR"

TARGET_DIR=""
UPGRADE=false
YES=false

# ── Output helpers ────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "  ${GREEN}→${NC} $*"; }
warn()    { echo -e "  ${YELLOW}!${NC} $*"; }
error()   { echo -e "  ${RED}✗${NC} $*" >&2; exit 1; }
success() { echo -e "  ${GREEN}✓${NC} $*"; }
header()  { echo ""; echo "$*"; echo "$(echo "$*" | sed 's/./-/g')"; }

# ── Argument parsing ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)     TARGET_DIR="$2"; shift 2 ;;
    --upgrade) UPGRADE=true;    shift   ;;
    --yes|-y)  YES=true;        shift   ;;
    *) error "Unknown option: $1. Usage: ./install.sh [--dir <path>] [--upgrade] [--yes]" ;;
  esac
done

# ── Prerequisites ─────────────────────────────────────────────────────────────

check_prereqs() {
  header "Checking prerequisites"

  command -v git >/dev/null 2>&1 \
    && success "git $(git --version | awk '{print $3}')" \
    || error "git is required but not installed"

  if command -v claude >/dev/null 2>&1; then
    success "claude CLI found"
  else
    warn "claude CLI not found — install from https://claude.ai/code before using RAD"
  fi

  if command -v gh >/dev/null 2>&1; then
    success "gh (GitHub CLI) found"
  elif command -v glab >/dev/null 2>&1; then
    success "glab (GitLab CLI) found"
  else
    warn "No git platform CLI found — install gh or glab to enable PR automation"
    warn "RAD will fall back to manual mode (scripts print instructions instead)"
  fi
}

# ── Target directory ──────────────────────────────────────────────────────────

get_target() {
  if [[ -n "$TARGET_DIR" ]]; then
    return
  fi

  if [[ "$YES" == "true" ]]; then
    TARGET_DIR="$(pwd)"
    return
  fi

  echo ""
  echo "  Target directory for installation:"
  echo "  (press Enter to use current directory)"
  read -rp "  > [$(pwd)]: " input
  TARGET_DIR="${input:-$(pwd)}"
}

validate_target() {
  [[ -d "$TARGET_DIR" ]] \
    || error "Directory does not exist: $TARGET_DIR"

  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

  [[ -d "$TARGET_DIR/.git" ]] \
    || error "$TARGET_DIR is not a git repository. Run 'git init' first."

  [[ "$TARGET_DIR" != "$RAD_DIR" ]] \
    || error "Target cannot be the RAD framework directory itself."
}

# ── Installation steps ────────────────────────────────────────────────────────

create_dirs() {
  header "Creating directory structure"

  local dirs=(
    ".claude/commands"
    ".claude/skills"
    ".claude/agents"
    ".agents/research"
    ".agents/architecture"
    ".agents/plans"
    ".agents/logs"
    ".agents/findings"
    "scripts"
  )

  for dir in "${dirs[@]}"; do
    mkdir -p "$TARGET_DIR/$dir"
  done

  success "Directory structure ready"
}

copy_commands() {
  header "Installing commands"

  cp -r "$RAD_DIR/.claude/commands/." "$TARGET_DIR/.claude/commands/"
  success "Commands → .claude/commands/"
  info "architect/ — rad-design, rad-approve"
  info "team/      — rad-research, rad-plan, rad-adopt, rad-deliver, rad-review"
  info "shared/    — rad-status, rad-insights"
}

copy_skills() {
  header "Installing skills"

  cp -r "$RAD_DIR/.claude/skills/." "$TARGET_DIR/.claude/skills/"
  success "Skills → .claude/skills/"
  info "kickoff — /kickoff session-start ritual"
  info "wrap    — /wrap session-end ritual"
}

copy_scripts() {
  header "Installing scripts"

  cp "$RAD_DIR/scripts/"*.sh "$TARGET_DIR/scripts/"
  chmod +x "$TARGET_DIR/scripts/"*.sh
  success "Scripts → scripts/"
  info "includes get-default-branch.sh, checkout-plan.sh, rad-label.sh"
}

copy_agents_meta() {
  header "Setting up .agents/ structure"

  # Copy READMEs only — never overwrite user data
  local subdirs=(research architecture plans logs findings)
  for dir in "${subdirs[@]}"; do
    local src="$RAD_DIR/.agents/$dir/README.md"
    local dst="$TARGET_DIR/.agents/$dir/README.md"
    if [[ -f "$src" && ! -f "$dst" ]]; then
      cp "$src" "$dst"
    fi
  done

  # Create empty findings log if missing
  if [[ ! -f "$TARGET_DIR/.agents/findings.jsonl" ]]; then
    touch "$TARGET_DIR/.agents/findings.jsonl"
  fi

  success ".agents/ structure ready"
}

scaffold_claude_md() {
  header "CLAUDE.md"

  if [[ -f "$TARGET_DIR/CLAUDE.md" ]]; then
    if [[ "$UPGRADE" == "true" ]]; then
      warn "CLAUDE.md already exists — skipping (preserved on upgrade)"
    else
      warn "CLAUDE.md already exists — skipping"
      warn "Review the RAD Configuration section is present. See CLAUDE.md in the RAD repo for the template."
    fi
    return
  fi

  cp "$RAD_DIR/CLAUDE.md" "$TARGET_DIR/CLAUDE.md"
  success "CLAUDE.md created from template"
  info "Fill in all sections before running /rad-research"
}

detect_and_report_platform() {
  header "Platform detection"

  local platform
  platform=$(cd "$TARGET_DIR" && bash scripts/detect-platform.sh --quiet 2>/dev/null || echo "unknown")

  case "$platform" in
    github)  success "Detected: GitHub" ;;
    gitlab)  success "Detected: GitLab" ;;
    bitbucket) success "Detected: Bitbucket (manual PR mode)" ;;
    forgejo) success "Detected: Forgejo/Gitea" ;;
    manual)  warn "Could not detect platform — set it manually in CLAUDE.md" ;;
    unknown) warn "Platform detection failed — set it manually in CLAUDE.md" ;;
  esac
}

# ── Deliver-PR label ──────────────────────────────────────────────────────────

ensure_deliver_label() {
  header "Deliver-PR label"

  # Best-effort: create the rad:deliver label up front so the first /rad-deliver
  # PR doesn't fail with "label not found". No-op when gh is unavailable or
  # unauthenticated (the printed next-steps cover the manual case).
  if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
    warn "gh unavailable — create the 'rad:deliver' label manually (see next steps)"
    return
  fi

  # Idempotent: `gh label create` exits non-zero if the label already exists, which
  # is fine — either outcome leaves the label present, and neither fails the install.
  if (cd "$TARGET_DIR" && gh label create rad:deliver --color 0e8a16 \
        --description "RAD delivery PR" >/dev/null 2>&1); then
    success "Created label 'rad:deliver'"
  else
    success "Label 'rad:deliver' already present (or could not be created — see next steps)"
  fi
}

# ── Next steps ────────────────────────────────────────────────────────────────

print_next_steps() {
  echo ""
  echo "┌──────────────────────────────────────────────────────────────────┐"
  if [[ "$UPGRADE" == "true" ]]; then
    echo "│  RAD upgraded in $TARGET_DIR"
  else
    echo "│  RAD installed in $TARGET_DIR"
  fi
  echo "└──────────────────────────────────────────────────────────────────┘"
  echo ""

  if [[ "$UPGRADE" == "true" ]]; then
    echo "  Commands and scripts are up to date."
    echo "  CLAUDE.md, .claude/agents/, and .agents/ content were not changed."
    echo ""
    echo "  Run /rad-status in Claude Code to verify everything looks right."
    echo ""
    return
  fi

  echo "  Next steps:"
  echo ""
  echo "  1. Fill in CLAUDE.md"
  echo "     Open $TARGET_DIR/CLAUDE.md and complete every section."
  echo "     Pay particular attention to the RAD Configuration section."
  echo ""
  echo "  2. Create the deliver-PR label (GitHub example)"
  echo "     gh label create 'rad:deliver' --color '0e8a16' --description 'RAD delivery PR'"
  echo "     (rad:<status> labels are auto-created on first use by scripts/rad-label.sh)"
  echo ""
  echo "  3. Commit the RAD files"
  echo "     git add .claude/ .agents/ scripts/ CLAUDE.md"
  echo "     git commit -m 'chore: install RAD framework'"
  echo ""
  echo "  4. Start the architecture process"
  echo "     Open Claude Code in $TARGET_DIR and run:"
  echo "     /rad-research path/to/your-prd.md"
  echo ""
  echo "  See docs/daily-workflow.md for the full guide."
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "RAD Framework — $(if [[ "$UPGRADE" == "true" ]]; then echo "Upgrade"; else echo "Install"; fi)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  check_prereqs
  get_target
  validate_target

  echo ""
  if [[ "$UPGRADE" == "true" ]]; then
    info "Upgrading RAD in: $TARGET_DIR"
    info "User data (CLAUDE.md, .claude/agents/, .agents/) will not be changed"
  else
    info "Installing RAD into: $TARGET_DIR"
  fi

  create_dirs
  copy_commands
  copy_skills
  copy_scripts
  copy_agents_meta
  scaffold_claude_md
  detect_and_report_platform
  ensure_deliver_label
  print_next_steps
}

main
