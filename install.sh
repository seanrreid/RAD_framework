#!/usr/bin/env bash
# install.sh
# Installs or upgrades the RAD framework into a target project.
#
# Usage:
#   ./install.sh                        # interactive — prompts for target directory
#   ./install.sh --dir /path/to/project # non-interactive target
#   ./install.sh --upgrade              # update commands + skills + scripts, skip user data
#   ./install.sh --yes                  # accept all defaults without prompting
#   ./install.sh --architect <id>       # architect for .rad/config.yml (default: git user.email)
#
# Fresh install writes .rad/config.yml via `harness/cli.js config init`; upgrade
# migrates it from a pre-#87 CLAUDE.md via `config migrate` when it is absent.
# An existing .rad/config.yml is never touched. If the config cannot be created,
# every other file is still installed and the installer exits 1.
#
# On upgrade, CLAUDE.md, .rad/, .claude/agents/, and .agents/ content are never overwritten.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAD_DIR="$SCRIPT_DIR"

TARGET_DIR=""
UPGRADE=false
YES=false
ARCHITECT=""
PLATFORM="manual"
CONFIG_FAILED=false
# Whether the target had its own CLAUDE.md before scaffold_claude_md ran: an
# upgrade must migrate only from the user's file, never from the RAD template.
CLAUDE_MD_PREEXISTED=false

readonly USAGE="Usage: ./install.sh [--dir <path>] [--upgrade] [--yes] [--architect <id>]"
readonly RAD_CONFIG=".rad/config.yml"
readonly FALLBACK_DEFAULT_BRANCH="main"

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
    --architect)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || error "--architect requires a value. $USAGE"
      ARCHITECT="$2"; shift 2 ;;
    *) error "Unknown option: $1. $USAGE" ;;
  esac
done

# The architect id is handed to node as one argv element (never interpolated
# into code), but reject anything that could be read as a flag or is multi-line.
if [[ -n "$ARCHITECT" ]] && ! [[ "$ARCHITECT" =~ ^[^-[:space:]][^[:space:]]*$ ]]; then
  error "--architect must be a single non-flag token, got: '$ARCHITECT'. $USAGE"
fi

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
  info "architect/ — rad-design, rad-approve, rad-epic-decompose"
  info "team/      — rad-research, rad-plan, rad-adopt, rad-deliver, rad-review"
  info "shared/    — rad-status, rad-insights"
}

copy_skills() {
  header "Installing skills"

  cp -r "$RAD_DIR/.claude/skills/." "$TARGET_DIR/.claude/skills/"
  success "Skills → .claude/skills/"
  info "kickoff   — /kickoff session-start ritual"
  info "wrap      — /wrap session-end ritual"
}

# The rpi-design skill was retired (absorbed into /rad-research + /rad-design).
# `cp -r` never deletes, so an upgrade must remove the stale copy explicitly.
# Exact relative path only — never a glob.
STALE_SKILL_RPI_DESIGN=".claude/skills/rpi-design"

remove_stale_skills() {
  # An empty TARGET_DIR would turn "$TARGET_DIR/.claude/..." into an absolute
  # path under /, so refuse rather than guess.
  [[ -n "$TARGET_DIR" ]] || error "remove_stale_skills: TARGET_DIR is empty — refusing to remove anything"

  if [[ -e "$TARGET_DIR/$STALE_SKILL_RPI_DESIGN" ]]; then
    rm -rf "$TARGET_DIR/$STALE_SKILL_RPI_DESIGN"
    info "removed stale skill: rpi-design"
  fi
}

copy_ai_guardrails() {
  header "Installing guardrail pack"

  # ai/ is framework code — always overwrite on install and upgrade.
  mkdir -p "$TARGET_DIR/ai/extensions"
  cp -r "$RAD_DIR/ai/." "$TARGET_DIR/ai/"
  success "Guardrail pack → ai/"
  info "ai/guardrails.md     — baseline coding-agent rules"
  info "ai/slop-register.md  — project-specific overrides (customize for your stack)"
  info "ai/extensions/       — domain extensions: backend, database, frontend, security, testing"
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

copy_harness() {
  header "Installing harness"

  # harness/ and scripts/hooks/ are framework code — always overwrite on install
  # and upgrade. EXCLUDE harness/node_modules: it is recreated by `npm install`
  # in the target and can be hundreds of MB.
  mkdir -p "$TARGET_DIR/harness"
  cp -r "$RAD_DIR/harness/." "$TARGET_DIR/harness/"
  rm -rf "$TARGET_DIR/harness/node_modules"
  success "Harness → harness/ (node_modules excluded)"

  mkdir -p "$TARGET_DIR/scripts/hooks"
  cp -r "$RAD_DIR/scripts/hooks/." "$TARGET_DIR/scripts/hooks/"
  success "Wave-lifecycle hooks → scripts/hooks/"
  info "harness/cli.js      — zero-npm rad CLI (vendored js-yaml, lazy SDK)"
  info "scripts/hooks/       — pre/post-wave + on-outcome lifecycle hook dirs"
}

scaffold_claude_md() {
  header "CLAUDE.md"

  if [[ -f "$TARGET_DIR/CLAUDE.md" ]]; then
    if [[ "$UPGRADE" == "true" ]]; then
      warn "CLAUDE.md already exists — skipping (preserved on upgrade)"
    else
      warn "CLAUDE.md already exists — skipping"
      warn "RAD settings live in .rad/config.yml, not CLAUDE.md. See CLAUDE.md in the RAD repo for the template."
    fi
    return
  fi

  cp "$RAD_DIR/CLAUDE.md" "$TARGET_DIR/CLAUDE.md"
  success "CLAUDE.md created from template"
  info "Fill in all sections before running /rad-research"
}

# Sets PLATFORM (one of the valid platforms; `manual` when detection is unusable).
detect_and_report_platform() {
  header "Platform detection"

  local platform
  platform=$(cd "$TARGET_DIR" && bash scripts/detect-platform.sh --quiet 2>/dev/null | tail -n 1) \
    || platform="unknown"

  case "$platform" in
    github)    PLATFORM="github";    success "Detected: GitHub" ;;
    gitlab)    PLATFORM="gitlab";    success "Detected: GitLab" ;;
    bitbucket) PLATFORM="bitbucket"; success "Detected: Bitbucket (manual PR mode)" ;;
    forgejo)   PLATFORM="forgejo";   success "Detected: Forgejo/Gitea" ;;
    manual)    PLATFORM="manual";    warn "Could not detect platform — set it manually in $RAD_CONFIG" ;;
    *)         PLATFORM="manual";    warn "Platform detection failed — set it manually in $RAD_CONFIG" ;;
  esac
}

# origin/HEAD's branch with the `origin/` prefix stripped; FALLBACK_DEFAULT_BRANCH when absent.
target_default_branch() {
  local ref
  ref=$(cd "$TARGET_DIR" && git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) || ref=""
  ref="${ref#origin/}"
  echo "${ref:-$FALLBACK_DEFAULT_BRANCH}"
}

# Reports a config failure: the CLI's reason, the exact command to run, and the
# CONFIG_FAILED flag that makes main exit 1 after every file is laid down.
report_config_failure() {
  local reason="$1" command="$2"
  CONFIG_FAILED=true
  warn "Could not create $RAD_CONFIG:"
  printf '%s\n' "$reason" | sed 's/^/      /' >&2
  warn "Run this in $TARGET_DIR to finish setup:"
  warn "  $command"
}

config_init() {
  local args=(config init --platform "$PLATFORM" --default-branch "$(target_default_branch)")
  [[ -n "$ARCHITECT" ]] && args+=(--architect "$ARCHITECT")

  local out
  if out=$(cd "$TARGET_DIR" && node harness/cli.js "${args[@]}" 2>&1); then
    success "$out"
    info "Architect: $(printf '%s' "$out" | sed -n 's/.*architect=\([^,]*\),.*/\1/p')"
    info "Review $RAD_CONFIG (roles, platform, default_branch) before your first plan"
  else
    report_config_failure "$out" "node harness/cli.js config init --architect <you@example.com>"
  fi
}

config_migrate() {
  if [[ "$CLAUDE_MD_PREEXISTED" != "true" ]]; then
    report_config_failure "no $RAD_CONFIG and no CLAUDE.md to migrate from" \
      "node harness/cli.js config init --architect <you@example.com>"
    return
  fi

  local out
  if out=$(cd "$TARGET_DIR" && node harness/cli.js config migrate 2>&1); then
    printf '%s\n' "$out" | sed 's/^/    /'
    success "Migrated $RAD_CONFIG from CLAUDE.md (CLAUDE.md was not modified)"
    warn "Remove the RAD Configuration block from CLAUDE.md"
  else
    report_config_failure "$out" "node harness/cli.js config migrate"
  fi
}

setup_rad_config() {
  header "RAD config ($RAD_CONFIG)"

  if [[ -f "$TARGET_DIR/$RAD_CONFIG" ]]; then
    success "$RAD_CONFIG already exists — kept"
    return
  fi

  if [[ "$UPGRADE" == "true" ]]; then
    config_migrate
  else
    config_init
  fi
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
    # Non-zero almost always means "label already exists" (idempotent re-run); it
    # could also be a permissions issue. Either way the install proceeds; the
    # next-steps section repeats the manual `gh label create` command.
    info "Label 'rad:deliver' already exists (or needs manual creation — see step 2 below)"
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
    echo "  CLAUDE.md, .rad/, .claude/agents/, and .agents/ content were not changed."
    echo ""
    echo "  Run /rad-status in Claude Code to verify everything looks right."
    echo ""
    return
  fi

  echo "  Next steps:"
  echo ""
  echo "  1. Review $RAD_CONFIG and fill in CLAUDE.md"
  echo "     Check roles, platform, and default_branch in $TARGET_DIR/$RAD_CONFIG."
  echo "     Open $TARGET_DIR/CLAUDE.md and complete the project and conventions sections."
  echo ""
  echo "  2. Create the deliver-PR label (GitHub example)"
  echo "     gh label create 'rad:deliver' --color '0e8a16' --description 'RAD delivery PR'"
  echo "     (rad:<status> labels are auto-created on first use by scripts/rad-label.sh)"
  echo ""
  echo "  3. Commit the RAD files"
  echo "     git add .claude/ .agents/ .rad/ scripts/ harness/ ai/ CLAUDE.md"
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
    info "User data (CLAUDE.md, .rad/, .claude/agents/, .agents/) will not be changed"
  else
    info "Installing RAD into: $TARGET_DIR"
  fi

  create_dirs
  copy_commands
  copy_skills
  if [[ "$UPGRADE" == "true" ]]; then remove_stale_skills; fi
  copy_ai_guardrails
  copy_scripts
  copy_agents_meta
  copy_harness
  if [[ -f "$TARGET_DIR/CLAUDE.md" ]]; then CLAUDE_MD_PREEXISTED=true; fi
  scaffold_claude_md
  detect_and_report_platform
  setup_rad_config
  ensure_deliver_label
  print_next_steps

  if [[ "$CONFIG_FAILED" == "true" ]]; then
    echo -e "  ${RED}✗${NC} Installed, but $RAD_CONFIG was not created — run the command above, then re-check with: node harness/cli.js config validate" >&2
    exit 1
  fi
}

main
